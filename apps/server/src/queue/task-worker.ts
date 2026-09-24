import type { TaskRepository, TaskRecord } from "../db/repository.ts";
import type { EventBus } from "../events/event-bus.ts";
import type { StreamEvent, TaskStatus, TokenUsage } from "@cloud-worker/shared";
import { SandboxManager, AgentSession, initWorkspace, type AgentProvider } from "@cloud-worker/sandbox";
import type { GitHubTokenManager } from "../github/token-manager.ts";
import { createPullRequest, formatPullRequestBody } from "../github/pull-request.ts";
import fs from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";

function estimateTokenUsage(stdout: string, stderr: string, prompt: string): TokenUsage {
  const combined = `${stdout}\n${stderr}`;
  const inputMatches = [...combined.matchAll(/(?:input|prompt)\s*tokens?[:\s]+(\d[\d,]*)/gi)];
  const outputMatches = [...combined.matchAll(/(?:output|completion)\s*tokens?[:\s]+(\d[\d,]*)/gi)];

  if (inputMatches.length > 0 && outputMatches.length > 0) {
    const lastInput = inputMatches[inputMatches.length - 1];
    const lastOutput = outputMatches[outputMatches.length - 1];
    if (lastInput && lastOutput && lastInput[1] && lastOutput[1]) {
      const input = parseInt(lastInput[1].replace(/,/g, ""), 10);
      const output = parseInt(lastOutput[1].replace(/,/g, ""), 10);
      const total = input + output;
      const cost = (input * 3 + output * 15) / 1_000_000;
      return {
        inputTokens: input,
        outputTokens: output,
        totalTokens: total,
        estimatedCostUsd: Math.round(cost * 10000) / 10000,
      };
    }
  }

  // Fallback heuristic: 1 token ≈ 4 characters
  const promptTokens = Math.ceil(prompt.length / 4);
  const completionTokens = Math.ceil(stdout.length / 4);
  const totalTokens = promptTokens + completionTokens;
  const estimatedCostUsd = Math.round(((promptTokens * 3 + completionTokens * 15) / 1_000_000) * 10000) / 10000;

  return {
    inputTokens: promptTokens,
    outputTokens: completionTokens,
    totalTokens,
    estimatedCostUsd,
  };
}

export class TaskWorker {
  private readonly activeControllers = new Map<string, AbortController>();
  private readonly activeSandboxes = new Map<string, SandboxManager>();
  private readonly maxTaskDurationMs: number;
  private readonly e2bApiKey?: string;

  constructor(
    private readonly repo: TaskRepository,
    private readonly eventBus: EventBus,
    private readonly tokenManager?: GitHubTokenManager,
    maxTaskDurationMs = 900_000,
    e2bApiKey?: string,
  ) {
    this.maxTaskDurationMs = maxTaskDurationMs;
    this.e2bApiKey = e2bApiKey;
  }



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

    let isTimedOut = false;
    const timeoutHandle = setTimeout(() => {
      isTimedOut = true;
      controller.abort("Task execution timed out");
      const activeSb = this.activeSandboxes.get(taskId);
      if (activeSb) {
        activeSb
          .destroy()
          .catch((err) =>
            console.warn(`[task-worker] Failed to destroy sandbox on timeout for task ${taskId}:`, err),
          );
      }
    }, this.maxTaskDurationMs);

    let sandbox: SandboxManager | undefined;

    try {
      // 1. Mark task as provisioning
      await this.updateStatus(taskId, "provisioning", "Allocating Firecracker microVM");

      // 2. Determine agent provider and credentials
      const provider = this.resolveProvider(task.model);
      const { authJson, apiKey } = await this.resolveCredentials(provider, task.userId);
      if (!authJson && !apiKey) {
        const errorMsg =
          `No valid authentication credentials found for ${provider === "codex" ? "OpenAI Codex" : "Claude Code"}. ` +
          `Please connect your ChatGPT or Claude subscription in settings or configure an API key.`;
        await this.repo.updateTask(taskId, {
          status: "failed",
          error: errorMsg,
          completedAt: new Date().toISOString(),
        });
        await this.updateStatus(taskId, "failed", errorMsg);
        await this.emitAndLog({
          type: "error",
          taskId,
          message: errorMsg,
          timestamp: Date.now(),
        });
        return;
      }

      // 3. Provision isolated microVM
      const e2bApiKey = this.e2bApiKey || process.env.E2B_API_KEY;
      sandbox = await SandboxManager.create({
        apiKey: e2bApiKey,
        timeoutMs: this.maxTaskDurationMs,
      });

      this.activeSandboxes.set(taskId, sandbox);
      await this.repo.updateTask(taskId, { sandboxId: sandbox.sandboxId });

      if (controller.signal.aborted) {
        if (isTimedOut) {
          const timeoutMsg = `Task timed out after ${Math.round(this.maxTaskDurationMs / 1000)}s`;
          await this.repo.updateTask(taskId, {
            status: "failed",
            error: timeoutMsg,
            completedAt: new Date().toISOString(),
          });
          await this.updateStatus(taskId, "failed", timeoutMsg);
        } else {
          await this.updateStatus(taskId, "cancelled", "Task was cancelled before execution");
        }
        return;
      }

      // 4. Initialize workspace environment inside microVM
      await this.updateStatus(taskId, "cloning", "Preparing workspace and git environment");
      const initResult = await initWorkspace(sandbox);
      if (!initResult.firewallConfigured) {
        console.warn(`[task-worker] Warning: Egress firewall could not be applied in sandbox for task ${taskId}`);
      }

      // Clone target repository or initialize clean git workspace
      await this.setupRepository(sandbox, task);

      // 5. Switch to working branch
      await sandbox.exec(`git checkout -B "${task.workingBranch}"`, { cwd: "/workspace" });

      if (controller.signal.aborted) {
        if (isTimedOut) {
          const timeoutMsg = `Task timed out after ${Math.round(this.maxTaskDurationMs / 1000)}s`;
          await this.repo.updateTask(taskId, {
            status: "failed",
            error: timeoutMsg,
            completedAt: new Date().toISOString(),
          });
          await this.updateStatus(taskId, "failed", timeoutMsg);
        } else {
          await this.updateStatus(taskId, "cancelled", "Task was cancelled before execution");
        }
        return;
      }

      // 6. Start agent execution loop
      await this.updateStatus(taskId, "running", `Running ${provider} agent harness`);

      const session = AgentSession.create(sandbox, {
        provider,
        model: task.model,
        reasoningEffort: task.reasoningEffort,
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
        if (isTimedOut) {
          await this.updateStatus(taskId, "failed", `Task timed out after ${Math.round(this.maxTaskDurationMs / 1000)}s`);
        } else {
          await this.updateStatus(taskId, "cancelled", "Task cancelled by user");
        }
        return;
      }

      if (result.exitCode === 0) {
        // Commit any uncommitted edits safely via commit message file to prevent shell injection
        const commitMsg = `feat(agent): ${task.prompt.slice(0, 60).replace(/\r?\n/g, " ")}`;
        await sandbox.writeFile("/tmp/.commit_msg.txt", commitMsg);
        await sandbox.exec(
          "git add -A && git diff-index --quiet HEAD || git commit -F /tmp/.commit_msg.txt",
          { cwd: "/workspace" },
        );

        const finalDiff = (await sandbox.gitDiff()) || result.diff || undefined;
        if (finalDiff) {
          await this.repo.updateTask(taskId, { diff: finalDiff });
        }

        let pullRequestUrl: string | undefined;

        // Push working branch and open pull request if authenticated and changes exist
        const hasAuth = Boolean(task.repo.installationId || process.env.GITHUB_TOKEN);
        const hasDiff = Boolean(finalDiff && finalDiff.trim().length > 0);

        if (hasAuth && hasDiff) {
          try {
            // Re-acquire fresh token to ensure it has not expired during the agent run
            let pushToken = process.env.GITHUB_TOKEN;
            if (task.repo.installationId && this.tokenManager && this.tokenManager.isConfigured()) {
              try {
                pushToken = await this.tokenManager.getInstallationToken(task.repo.installationId);
              } catch (tokenErr) {
                console.warn(`[task-worker] Failed to refresh installation token for push:`, tokenErr);
              }
            }

            if (pushToken) {
              const freshPushUrl = `https://x-access-token:${pushToken}@github.com/${task.repo.owner}/${task.repo.repo}.git`;
              await sandbox.exec(`git remote set-url origin "${freshPushUrl}"`, { cwd: "/workspace" });
            }

            await this.emitAndLog({
              type: "status",
              taskId,
              status: "running",
              message: `Pushing working branch ${task.workingBranch} to GitHub`,
              timestamp: Date.now(),
            });

            const pushResult = await sandbox.exec(
              `git push -u origin "${task.workingBranch}"`,
              { cwd: "/workspace", timeoutMs: 60_000 },
            );

            if (pushResult.exitCode === 0 || pushResult.stderr.includes("Everything up-to-date")) {
              const pr = await createPullRequest({
                installationId: task.repo.installationId,
                owner: task.repo.owner,
                repo: task.repo.repo,
                branch: task.workingBranch,
                baseBranch: task.repo.branch || "main",
                title: `feat(agent): ${task.prompt.slice(0, 60).replace(/\n/g, " ")}`,
                body: formatPullRequestBody({
                  taskId: task.id,
                  prompt: task.prompt,
                  model: task.model,
                  workingBranch: task.workingBranch,
                  diffSummary: finalDiff,
                }),
                tokenManager: this.tokenManager,
              });
              pullRequestUrl = pr.pullRequestUrl;
            } else {
              console.warn(`[task-worker] Branch push exited with code ${pushResult.exitCode}: ${pushResult.stderr}`);
            }
          } catch (prErr) {
            console.warn(`[task-worker] Push or PR creation failed for ${taskId}:`, prErr);
          }
        }

        const tokenUsage = estimateTokenUsage(result.stdout, result.stderr, task.prompt);

        if (controller.signal.aborted) {
          if (isTimedOut) {
            const timeoutMsg = `Task timed out after ${Math.round(this.maxTaskDurationMs / 1000)}s`;
            await this.repo.updateTask(taskId, {
              status: "failed",
              error: timeoutMsg,
              completedAt: new Date().toISOString(),
              tokenUsage,
            });
            await this.updateStatus(taskId, "failed", timeoutMsg);
            await this.emitAndLog({
              type: "error",
              taskId,
              message: timeoutMsg,
              timestamp: Date.now(),
            });
          } else {
            console.log(`[task-worker] Task ${taskId} was cancelled before completion recording.`);
          }
          return;
        }

        const completedAt = new Date().toISOString();
        await this.repo.updateTask(taskId, {
          status: "completed",
          completedAt,
          pullRequestUrl,
          tokenUsage,
        });

        await this.emitAndLog({
          type: "status",
          taskId,
          status: "completed",
          message: pullRequestUrl
            ? `Agent finished execution and opened PR: ${pullRequestUrl}`
            : "Agent finished execution successfully",
          timestamp: Date.now(),
        });

        await this.emitAndLog({
          type: "done",
          taskId,
          summary: "Agent completed task",
          pullRequestUrl,
          tokenUsage,
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
        if (isTimedOut) {
          const timeoutMsg = `Task timed out after ${Math.round(this.maxTaskDurationMs / 1000)}s`;
          await this.repo.updateTask(taskId, {
            status: "failed",
            error: timeoutMsg,
            completedAt: new Date().toISOString(),
          });
          await this.updateStatus(taskId, "failed", timeoutMsg);
          await this.emitAndLog({
            type: "error",
            taskId,
            message: timeoutMsg,
            timestamp: Date.now(),
          });
        } else {
          console.log(`[task-worker] Task ${taskId} was aborted; retaining cancelled status.`);
        }
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
      clearTimeout(timeoutHandle);
      this.activeControllers.delete(taskId);
      this.activeSandboxes.delete(taskId);

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
      const sandbox = this.activeSandboxes.get(taskId);
      if (sandbox) {
        sandbox.destroy().catch((err) => console.warn(`[task-worker] Error destroying sandbox on cancel:`, err));
        this.activeSandboxes.delete(taskId);
      }
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
    userId?: string,
  ): Promise<{ authJson?: string; apiKey?: string }> {
    // 1. Check stored auth session for the specific user in database
    if (userId) {
      const userRecord = await this.repo.getAuthSessionRecord(provider, userId);
      if (userRecord) {
        if (userRecord.authMode === "api_key") {
          return { apiKey: userRecord.authJson };
        }
        return { authJson: userRecord.authJson };
      }
    }

    // 2. Check default stored auth session in database
    const storedRecord = await this.repo.getAuthSessionRecord(provider, "default");
    if (storedRecord) {
      if (storedRecord.authMode === "api_key") {
        return { apiKey: storedRecord.authJson };
      }
      return { authJson: storedRecord.authJson };
    }

    // 3. Fallback to server environment variables
    if (provider === "codex") {
      if (process.env.CODEX_AUTH_JSON) {
        return { authJson: process.env.CODEX_AUTH_JSON };
      }
      if (process.env.OPENAI_API_KEY) {
        return { apiKey: process.env.OPENAI_API_KEY };
      }
    } else {
      if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
        return { authJson: process.env.CLAUDE_CODE_OAUTH_TOKEN };
      }
      if (process.env.CLAUDE_AUTH_JSON) {
        return { authJson: process.env.CLAUDE_AUTH_JSON };
      }
      if (process.env.ANTHROPIC_API_KEY) {
        return { apiKey: process.env.ANTHROPIC_API_KEY };
      }
    }

    // 4. Fallback to host detected credentials if in local development
    try {
      const homeDir = process.env.USERPROFILE || process.env.HOME || "";
      const hostFilePath =
        provider === "codex"
          ? join(homeDir, ".codex", "auth.json")
          : join(homeDir, ".claude.json");

      if (existsSync(hostFilePath)) {
        const hostAuth = await fs.readFile(hostFilePath, "utf8");
        if (hostAuth.trim().length > 0) {
          await this.repo.saveAuthSession(provider, hostAuth, userId || "default", "subscription");
          return { authJson: hostAuth };
        }
      }
    } catch (err) {
      console.warn(`[task-worker] Failed to load local host credentials for ${provider}:`, err);
    }

    return {};
  }

  private async setupRepository(sandbox: SandboxManager, task: TaskRecord): Promise<void> {
    const { owner, repo, branch, baseCommit, installationId } = task.repo;

    let githubToken = process.env.GITHUB_TOKEN;
    if (installationId && this.tokenManager && this.tokenManager.isConfigured()) {
      try {
        githubToken = await this.tokenManager.getInstallationToken(installationId);
      } catch (tokenErr) {
        console.warn(`[task-worker] Failed to get installation token for ${installationId}:`, tokenErr);
      }
    }

    const cloneUrl = githubToken
      ? `https://x-access-token:${githubToken}@github.com/${owner}/${repo}.git`
      : `https://github.com/${owner}/${repo}.git`;

    const appId = this.tokenManager?.getAppId();
    const botEmail = appId ? `${appId}+cloud-worker[bot]@users.noreply.github.com` : "agent@cloud-worker.bot";

    // Attempt to clone the remote repository into /workspace
    const cloneResult = await sandbox.exec(
      `git clone --depth 50 --branch "${branch}" "${cloneUrl}" /tmp/repo_clone && cp -rn /tmp/repo_clone/. /workspace/ && rm -rf /tmp/repo_clone`,
      { timeoutMs: 120_000 },
    );

    if (cloneResult.exitCode === 0) {
      await sandbox.exec(`git config user.name "cloud-worker[bot]"`, { cwd: "/workspace" });
      await sandbox.exec(`git config user.email "${botEmail}"`, { cwd: "/workspace" });
      if (githubToken) {
        await sandbox.exec(`git remote set-url origin "${cloneUrl}"`, { cwd: "/workspace" });
      }
      if (baseCommit) {
        await sandbox.exec(`git checkout "${baseCommit}"`, { cwd: "/workspace" });
      }
      return;
    }

    // Fallback for test environments or offline repos: ensure /workspace is a valid git repository
    const checkGit = await sandbox.exec("git rev-parse --is-inside-work-tree", { cwd: "/workspace" });
    if (checkGit.exitCode !== 0) {
      await sandbox.exec("git init -b main", { cwd: "/workspace" });
      await sandbox.exec(`git config user.name "cloud-worker[bot]"`, { cwd: "/workspace" });
      await sandbox.exec(`git config user.email "${botEmail}"`, { cwd: "/workspace" });
      await sandbox.exec("git commit --allow-empty -m 'Initial workspace commit'", { cwd: "/workspace" });
      if (githubToken) {
        await sandbox.exec(`git remote add origin "${cloneUrl}"`, { cwd: "/workspace" });
      }
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
