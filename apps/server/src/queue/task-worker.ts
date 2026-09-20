import type { TaskRepository, TaskRecord } from "../db/repository.ts";
import type { EventBus } from "../events/event-bus.ts";
import type { StreamEvent, TaskStatus } from "@cloud-worker/shared";
import { SandboxManager, AgentSession, initWorkspace, type AgentProvider } from "@cloud-worker/sandbox";

export class TaskWorker {
  private readonly activeControllers = new Map<string, AbortController>();

  constructor(
    private readonly repo: TaskRepository,
    private readonly eventBus: EventBus,
  ) {}

  public async processTask(taskId: string): Promise<void> {
    const task = await this.repo.getTask(taskId);
    if (!task) {
      console.error(`[task-worker] Task ${taskId} not found`);
      return;
    }

    if (task.status === "cancelled" || task.status === "completed") {
      return;
    }

    const controller = new AbortController();
    this.activeControllers.set(taskId, controller);

    let sandbox: SandboxManager | undefined;

    try {
      // 1. Mark task as provisioning
      await this.updateStatus(taskId, "provisioning", "Allocating Firecracker microVM");

      // 2. Determine agent provider and credentials
      const provider = this.resolveProvider(task.model);
      const { authJson, apiKey } = await this.resolveCredentials(provider);

      // 3. Provision isolated microVM
      const e2bApiKey = process.env.E2B_API_KEY;
      sandbox = await SandboxManager.create({
        apiKey: e2bApiKey,
        timeoutMs: 900_000, // 15-minute sandbox lifetime guard
      });

      await this.repo.updateTask(taskId, { sandboxId: sandbox.sandboxId });

      if (controller.signal.aborted) {
        await this.updateStatus(taskId, "cancelled", "Task was cancelled before execution");
        return;
      }

      // 4. Initialize workspace environment inside microVM
      await this.updateStatus(taskId, "cloning", "Preparing workspace and git environment");
      await initWorkspace(sandbox);

      // Clone target repository or initialize clean git workspace
      await this.setupRepository(sandbox, task);

      // 5. Switch to working branch
      await sandbox.exec(`git checkout -B "${task.workingBranch}"`, { cwd: "/workspace" });

      if (controller.signal.aborted) {
        await this.updateStatus(taskId, "cancelled", "Task was cancelled before execution");
        return;
      }

      // 6. Start agent execution loop
      await this.updateStatus(taskId, "running", `Running ${provider} agent harness`);

      const session = AgentSession.create(sandbox, {
        provider,
        authJson,
        apiKey,
        workingBranch: task.workingBranch,
        baseBranch: task.repo.branch,
        signal: controller.signal,
        onStdout: async (data) => {
          await this.emitAndLog({
            type: "stdout",
            taskId,
            data,
            timestamp: Date.now(),
          });
        },
        onStderr: async (data) => {
          await this.emitAndLog({
            type: "stderr",
            taskId,
            data,
            timestamp: Date.now(),
          });
        },
      });

      const result = await session.run(task.prompt);

      // 7. Persist refreshed subscription tokens if updated by CLI
      if (result.refreshedAuthJson) {
        await this.repo.saveAuthSession(provider, result.refreshedAuthJson);
        console.log(`[task-worker] Updated refreshed auth session for ${provider}`);
      }

      // 8. Capture and publish git diff
      if (result.diff) {
        await this.repo.updateTask(taskId, { diff: result.diff });
        await this.emitAndLog({
          type: "diff",
          taskId,
          diff: result.diff,
          timestamp: Date.now(),
        });
      }

      // 9. Evaluate outcome
      if (controller.signal.aborted) {
        await this.updateStatus(taskId, "cancelled", "Task cancelled by user");
        return;
      }

      if (result.exitCode === 0) {
        const completedAt = new Date().toISOString();
        await this.repo.updateTask(taskId, {
          status: "completed",
          completedAt,
        });

        await this.emitAndLog({
          type: "status",
          taskId,
          status: "completed",
          message: "Agent finished execution successfully",
          timestamp: Date.now(),
        });

        await this.emitAndLog({
          type: "done",
          taskId,
          summary: "Agent completed task",
          timestamp: Date.now(),
        });
      } else {
        const errorMsg = result.stderr.trim() || `Agent process exited with code ${result.exitCode}`;
        await this.repo.updateTask(taskId, {
          status: "failed",
          error: errorMsg,
          completedAt: new Date().toISOString(),
        });

        await this.emitAndLog({
          type: "status",
          taskId,
          status: "failed",
          message: errorMsg,
          timestamp: Date.now(),
        });

        await this.emitAndLog({
          type: "error",
          taskId,
          message: errorMsg,
          timestamp: Date.now(),
        });
      }
    } catch (err) {
      if (controller.signal.aborted) {
        console.log(`[task-worker] Task ${taskId} was aborted; retaining cancelled status.`);
        return;
      }

      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[task-worker] Execution error for task ${taskId}:`, err);

      await this.repo.updateTask(taskId, {
        status: "failed",
        error: errorMsg,
        completedAt: new Date().toISOString(),
      });

      await this.emitAndLog({
        type: "status",
        taskId,
        status: "failed",
        message: errorMsg,
        timestamp: Date.now(),
      });

      await this.emitAndLog({
        type: "error",
        taskId,
        message: errorMsg,
        timestamp: Date.now(),
      });
    } finally {
      this.activeControllers.delete(taskId);

      // Clean up sandbox VM
      if (sandbox) {
        try {
          await sandbox.destroy();
        } catch (destroyErr) {
          console.warn(`[task-worker] Failed to destroy sandbox ${sandbox.sandboxId}:`, destroyErr);
        }
      }
    }
  }

  public cancel(taskId: string): boolean {
    const controller = this.activeControllers.get(taskId);
    if (controller) {
      controller.abort();
      this.activeControllers.delete(taskId);
      return true;
    }
    return false;
  }

  private resolveProvider(model: string): AgentProvider {
    const lower = model.toLowerCase();
    if (lower.includes("claude") || lower.includes("anthropic")) {
      return "claude";
    }
    // Default to OpenAI Codex
    return "codex";
  }

  private async resolveCredentials(
    provider: AgentProvider,
  ): Promise<{ authJson?: string; apiKey?: string }> {
    // 1. Check stored auth session in database
    const storedAuth = await this.repo.getAuthSession(provider);
    if (storedAuth) {
      return { authJson: storedAuth };
    }

    // 2. Check environment variables
    if (provider === "codex") {
      if (process.env.CODEX_AUTH_JSON) {
        return { authJson: process.env.CODEX_AUTH_JSON };
      }
      if (process.env.OPENAI_API_KEY) {
        return { apiKey: process.env.OPENAI_API_KEY };
      }
    } else {
      if (process.env.CLAUDE_AUTH_JSON) {
        return { authJson: process.env.CLAUDE_AUTH_JSON };
      }
      if (process.env.ANTHROPIC_API_KEY) {
        return { apiKey: process.env.ANTHROPIC_API_KEY };
      }
    }

    return {};
  }

  private async setupRepository(sandbox: SandboxManager, task: TaskRecord): Promise<void> {
    const { owner, repo, branch, baseCommit } = task.repo;
    const githubToken = process.env.GITHUB_TOKEN;
    const cloneUrl = githubToken
      ? `https://x-access-token:${githubToken}@github.com/${owner}/${repo}.git`
      : `https://github.com/${owner}/${repo}.git`;

    // Attempt to clone the remote repository into /workspace
    const cloneResult = await sandbox.exec(
      `git clone --depth 50 --branch "${branch}" "${cloneUrl}" /tmp/repo_clone && cp -rn /tmp/repo_clone/. /workspace/ && rm -rf /tmp/repo_clone`,
      { timeoutMs: 120_000 },
    );

    if (cloneResult.exitCode === 0) {
      if (baseCommit) {
        await sandbox.exec(`git checkout "${baseCommit}"`, { cwd: "/workspace" });
      }
      return;
    }

    // Fallback for test environments or offline repos: ensure /workspace is a valid git repository
    const checkGit = await sandbox.exec("git rev-parse --is-inside-work-tree", { cwd: "/workspace" });
    if (checkGit.exitCode !== 0) {
      await sandbox.exec("git init -b main", { cwd: "/workspace" });
      await sandbox.exec("git config user.name 'Cloud Worker Agent'", { cwd: "/workspace" });
      await sandbox.exec("git config user.email 'agent@cloudworker.local'", { cwd: "/workspace" });
      await sandbox.exec("git commit --allow-empty -m 'Initial workspace commit'", { cwd: "/workspace" });
    }
  }

  private async updateStatus(taskId: string, status: TaskStatus, message?: string): Promise<void> {
    await this.repo.updateTask(taskId, { status });
    const event: StreamEvent = {
      type: "status",
      taskId,
      status,
      message,
      timestamp: Date.now(),
    };
    await this.emitAndLog(event);
  }

  private async emitAndLog(event: StreamEvent): Promise<void> {
    await this.eventBus.publish(event);
    if ("taskId" in event && typeof event.taskId === "string") {
      await this.repo.saveLog(event.taskId, event).catch((err) => {
        console.error("[task-worker] Failed to save log event:", err);
      });
    }
  }
}
