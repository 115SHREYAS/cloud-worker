import { describe, it, expect } from "bun:test";
import { sign } from "@octokit/webhooks-methods";
import { MemoryTaskRepository } from "./db/repository.ts";
import { DirectTaskQueue } from "./queue/task-queue.ts";
import { MemoryEventBus } from "./events/event-bus.ts";
import { TaskWorker } from "./queue/task-worker.ts";
import { GitHubTokenManager } from "./github/token-manager.ts";
import { createPullRequest, formatPullRequestBody } from "./github/pull-request.ts";
import { handleGitHubWebhook } from "./github/webhooks.ts";
import { createServer } from "./server.ts";

describe("GitHub App Integration (Phase 5)", () => {
  it("formats pull request markdown body with prompt, metadata, and diff", () => {
    const body = formatPullRequestBody({
      taskId: "task-test-123",
      prompt: "Fix the race condition in the cache layer\nHandle concurrent writes",
      model: "claude-3-7-sonnet-20250219",
      workingBranch: "agent/patch-task-test-123",
      diffSummary: "+ const lock = new Mutex();\n- const lock = null;",
    });

    expect(body).toContain("## Summary");
    expect(body).toContain("> Fix the race condition in the cache layer");
    expect(body).toContain("> Handle concurrent writes");
    expect(body).toContain("`task-test-123`");
    expect(body).toContain("`agent/patch-task-test-123`");
    expect(body).toContain("```diff");
    expect(body).toContain("+ const lock = new Mutex();");
  });

  it("creates mock pull request when mockInDev or testing mode is active", async () => {
    const result = await createPullRequest({
      owner: "cloud-worker-org",
      repo: "test-repository",
      branch: "agent/patch-abc",
      baseBranch: "main",
      title: "feat: add caching layer",
      body: "Test PR body",
      mockInDev: true,
    });

    expect(result.pullRequestNumber).toBeGreaterThan(0);
    expect(result.pullRequestUrl).toContain("https://github.com/cloud-worker-org/test-repository/pull/");
    expect(result.state).toBe("open");
  });

  it("manages token manager lifecycle and caching", async () => {
    const originalAppId = process.env.GITHUB_APP_ID;
    delete process.env.GITHUB_APP_ID;
    const manager = new GitHubTokenManager();
    expect(manager.isConfigured()).toBe(false);
    if (originalAppId) {
      process.env.GITHUB_APP_ID = originalAppId;
    }

    // In environment where GITHUB_TOKEN might be set or not
    if (process.env.GITHUB_TOKEN) {
      const token = await manager.getInstallationToken(12345);
      expect(token).toBe(process.env.GITHUB_TOKEN);
    } else {
      expect(manager.getInstallationToken(12345)).rejects.toThrow("GitHub App is not configured");
    }
  });

  it("handles webhook signature verification and installation events", async () => {
    const repo = new MemoryTaskRepository();
    const eventBus = new MemoryEventBus();
    const worker = new TaskWorker(repo, eventBus);
    const queue = new DirectTaskQueue(worker);

    const secret = "test-webhook-secret-123";

    // 1. Rejects tampered or unsigned payload
    const pingPayload = JSON.stringify({ zen: "Responsive is better than fast." });
    expect(
      handleGitHubWebhook({
        event: "ping",
        signature: "sha256=invalid-signature",
        rawBody: pingPayload,
        secret,
        repository: repo,
      }),
    ).rejects.toThrow("Invalid x-hub-signature-256 signature");

    // 2. Accepts validly signed ping
    const validPingSig = await sign(secret, pingPayload);
    const pingResult = await handleGitHubWebhook({
      event: "ping",
      signature: validPingSig,
      rawBody: pingPayload,
      secret,
      repository: repo,
    });
    expect(pingResult.handled).toBe(true);
    expect(pingResult.action).toBe("ping");

    // 3. Handles installation.created
    const installPayload = JSON.stringify({
      action: "created",
      installation: {
        id: 778899,
        account: {
          login: "octocat-org",
          type: "Organization",
        },
        repository_selection: "selected",
        app_slug: "cloud-worker-agent",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    });
    const installSig = await sign(secret, installPayload);
    const installResult = await handleGitHubWebhook({
      event: "installation",
      signature: installSig,
      rawBody: installPayload,
      secret,
      repository: repo,
    });
    expect(installResult.handled).toBe(true);
    expect(installResult.action).toBe("installation.created");

    // Verify saved in repository
    const savedInstall = await repo.getInstallation(778899);
    expect(savedInstall).not.toBeNull();
    expect(savedInstall?.accountLogin).toBe("octocat-org");
    expect(savedInstall?.accountType).toBe("Organization");

    // 4. Handles authorized issue_comment trigger
    const commentPayload = JSON.stringify({
      action: "created",
      issue: {
        number: 42,
        title: "Bug in parser",
      },
      comment: {
        body: "@cloud-worker fix the JSON parsing error in parser.ts",
        author_association: "OWNER",
      },
      repository: {
        name: "cloud-app",
        owner: { login: "octocat-org" },
        default_branch: "main",
      },
      installation: { id: 778899 },
    });
    const commentSig = await sign(secret, commentPayload);
    const commentResult = await handleGitHubWebhook({
      event: "issue_comment",
      signature: commentSig,
      rawBody: commentPayload,
      secret,
      repository: repo,
      taskQueue: queue,
    });

    expect(commentResult.handled).toBe(true);
    expect(commentResult.action).toBe("issue_comment.dispatched");
    expect(commentResult.taskId).toBeDefined();

    if (commentResult.taskId) {
      const createdTask = await repo.getTask(commentResult.taskId);
      expect(createdTask).not.toBeNull();
      expect(createdTask?.repo.owner).toBe("octocat-org");
      expect(createdTask?.repo.repo).toBe("cloud-app");
      expect(createdTask?.prompt).toContain("fix the JSON parsing error in parser.ts");
    }

    // 5. Rejects unauthorized commenter
    const unauthorizedPayload = JSON.stringify({
      action: "created",
      issue: { number: 42 },
      comment: {
        body: "@cloud-worker fix this test",
        author_association: "NONE",
      },
      repository: { name: "cloud-app", owner: { login: "octocat-org" } },
      installation: { id: 778899 },
    });
    const unauthorizedSig = await sign(secret, unauthorizedPayload);
    const unauthorizedResult = await handleGitHubWebhook({
      event: "issue_comment",
      signature: unauthorizedSig,
      rawBody: unauthorizedPayload,
      secret,
      repository: repo,
      taskQueue: queue,
    });
    expect(unauthorizedResult.action).toBe("issue_comment.unauthorized");

    // 6. Ignores bot comments
    const botPayload = JSON.stringify({
      action: "created",
      sender: { type: "Bot" },
      issue: { number: 42 },
      comment: {
        body: "@cloud-worker fix this test",
        user: { type: "Bot" },
      },
    });
    const botSig = await sign(secret, botPayload);
    const botResult = await handleGitHubWebhook({
      event: "issue_comment",
      signature: botSig,
      rawBody: botPayload,
      secret,
      repository: repo,
      taskQueue: queue,
    });
    expect(botResult.action).toBe("issue_comment.bot_ignored");


    // 5. Handles installation.deleted
    const deletePayload = JSON.stringify({
      action: "deleted",
      installation: { id: 778899 },
    });
    const deleteSig = await sign(secret, deletePayload);
    await handleGitHubWebhook({
      event: "installation",
      signature: deleteSig,
      rawBody: deletePayload,
      secret,
      repository: repo,
    });

    const deleted = await repo.getInstallation(778899);
    expect(deleted).toBeNull();
  });

  it("serves GitHub API endpoints via Bun server", async () => {
    const repo = new MemoryTaskRepository();
    const eventBus = new MemoryEventBus();
    const worker = new TaskWorker(repo, eventBus);
    const queue = new DirectTaskQueue(worker);

    // Pre-populate an installation
    await repo.saveInstallation({
      id: 554433,
      accountLogin: "acme-test",
      accountType: "User",
      repositorySelection: "all",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const server = createServer({
      port: 0, // OS assigns available ephemeral port
      repo,
      eventBus,
      queue,
    });

    const baseUrl = `http://localhost:${server.port}`;

    try {
      // Test /api/github/status
      const statusRes = await fetch(`${baseUrl}/api/github/status`);
      expect(statusRes.status).toBe(200);
      const statusData = (await statusRes.json()) as { configured: boolean };
      expect(typeof statusData.configured).toBe("boolean");

      // Test /api/github/installations
      const instRes = await fetch(`${baseUrl}/api/github/installations`);
      expect(instRes.status).toBe(200);
      const instData = (await instRes.json()) as { installations: Array<{ id: number; accountLogin: string }> };
      expect(instData.installations.length).toBe(1);
      expect(instData.installations[0]?.id).toBe(554433);
      expect(instData.installations[0]?.accountLogin).toBe("acme-test");

      // Test /api/github/repositories
      const reposRes = await fetch(`${baseUrl}/api/github/repositories`);
      expect(reposRes.status).toBe(200);
      const reposData = (await reposRes.json()) as { repositories: unknown[] };
      expect(Array.isArray(reposData.repositories)).toBe(true);
    } finally {
      server.stop();
    }
  });
});
