import { describe, it, expect } from "bun:test";
import {
  TaskStatusSchema,
  TaskSchema,
  StreamEventSchema,
  getTaskChannel,
  AGENT_TOOLS,
} from "./index";

describe("Domain contracts (@cloud-worker/shared)", () => {
  it("validates a complete task payload", () => {
    const validTask = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      status: "running",
      repo: {
        owner: "test-user",
        repo: "test-repo",
        branch: "main",
        installationId: 12345,
      },
      prompt: "Fix the memory leak in worker.ts",
      model: "claude-3-7-sonnet-20250219",
      workingBranch: "agent/patch-550e8400",
      sandboxId: "e2b-sandbox-abc123",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const parsed = TaskSchema.parse(validTask);
    expect(parsed.id).toBe(validTask.id);
    expect(parsed.status).toBe("running");
  });

  it("rejects invalid task status", () => {
    expect(() => {
      TaskStatusSchema.parse("invalid_status");
    }).toThrow();
  });

  it("correctly narrows discriminated union stream events", () => {
    const stdoutEvent = {
      type: "stdout",
      taskId: "task-1",
      data: "npm test output...",
      timestamp: Date.now(),
    };

    const parsed = StreamEventSchema.parse(stdoutEvent);
    expect(parsed.type).toBe("stdout");
    if (parsed.type === "stdout") {
      expect(parsed.data).toBe("npm test output...");
    }
  });

  it("validates tool result event with exit code", () => {
    const toolResultEvent = {
      type: "tool_result",
      taskId: "task-1",
      callId: "call_abc",
      tool: "bash",
      output: "Tests passed: 5/5",
      exitCode: 0,
      isError: false,
      timestamp: Date.now(),
    };

    const parsed = StreamEventSchema.parse(toolResultEvent);
    expect(parsed.type).toBe("tool_result");
  });

  it("formats task pub/sub channel names consistently", () => {
    expect(getTaskChannel("task-999")).toBe("task:task-999:events");
  });

  it("exports all 5 canonical agent tools for Anthropic SDK", () => {
    expect(AGENT_TOOLS.length).toBe(5);
    const toolNames = AGENT_TOOLS.map((t) => t.name);
    expect(toolNames).toEqual(["bash", "read_file", "write_file", "list_dir", "git_diff"]);
  });

  it("validates GitHub domain contracts", async () => {
    const { GitHubInstallationSchema, GitHubRepositorySchema, CreatePullRequestInputSchema, PullRequestResultSchema } = await import("./github");

    const installation = GitHubInstallationSchema.parse({
      id: 98765,
      accountLogin: "acme-corp",
      accountType: "Organization",
      repositorySelection: "selected",
      appSlug: "cloud-worker-bot",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    expect(installation.id).toBe(98765);
    expect(installation.accountType).toBe("Organization");

    const repository = GitHubRepositorySchema.parse({
      id: 112233,
      owner: "acme-corp",
      name: "payment-api",
      fullName: "acme-corp/payment-api",
      private: true,
      defaultBranch: "main",
      htmlUrl: "https://github.com/acme-corp/payment-api",
      installationId: 98765,
    });
    expect(repository.name).toBe("payment-api");
    expect(repository.private).toBe(true);

    const prInput = CreatePullRequestInputSchema.parse({
      installationId: 98765,
      owner: "acme-corp",
      repo: "payment-api",
      branch: "agent/patch-abc",
      baseBranch: "main",
      title: "fix: resolve memory leak in worker",
      body: "## Summary\n\nFixed event listener leak in Redis subscriber.",
    });
    expect(prInput.branch).toBe("agent/patch-abc");

    const prResult = PullRequestResultSchema.parse({
      pullRequestNumber: 42,
      pullRequestUrl: "https://github.com/acme-corp/payment-api/pull/42",
      state: "open",
    });
    expect(prResult.pullRequestNumber).toBe(42);
  });
});

