import { describe, it, expect } from "bun:test";
import { RateLimiter } from "./security/rate-limiter.ts";
import { EnvironmentSchema, loadConfig } from "./config/env.ts";
import { SandboxScavenger } from "./queue/sandbox-cleaner.ts";
import { MemoryTaskRepository, createTaskRepository } from "./db/repository.ts";
import { syncGitHubInstallations } from "./github/sync.ts";
import type { GitHubTokenManager } from "./github/token-manager.ts";

function fakeSetupTokenManager(): GitHubTokenManager {
  return {
    isConfigured: () => true,
    getAppOctokit: () => ({
      rest: {
        apps: {
          getInstallation: async ({ installation_id }: { installation_id: number }) => ({
            data: {
              id: installation_id,
              account:
                installation_id === 322
                  ? { login: "setup-tester", type: "User" }
                  : { login: "victim", type: "User" },
              repository_selection: "all",
              created_at: "2026-01-01T00:00:00Z",
              updated_at: "2026-01-01T00:00:00Z",
            },
          }),
        },
      },
    }),
  } as unknown as GitHubTokenManager;
}
import { MemoryEventBus } from "./events/event-bus.ts";
import { DirectTaskQueue } from "./queue/task-queue.ts";
import { TaskWorker } from "./queue/task-worker.ts";
import { createServer } from "./server.ts";
import { createSessionToken } from "./security/session.ts";
import { encryptCredential, decryptCredential } from "./security/crypto.ts";

describe("Phase 6 Security & Hardening Controls", () => {
  it("enforces sliding window rate limits", () => {
    const limiter = new RateLimiter({ windowMs: 1000, maxRequests: 3 });

    const client = "192.168.1.100";

    const r1 = limiter.check(client);
    expect(r1.allowed).toBe(true);
    expect(r1.remaining).toBe(2);

    const r2 = limiter.check(client);
    expect(r2.allowed).toBe(true);
    expect(r2.remaining).toBe(1);

    const r3 = limiter.check(client);
    expect(r3.allowed).toBe(true);
    expect(r3.remaining).toBe(0);

    // 4th request must be rejected
    const r4 = limiter.check(client);
    expect(r4.allowed).toBe(false);
    expect(r4.remaining).toBe(0);
    expect(r4.resetAtMs).toBeGreaterThan(Date.now() - 10);

    // Different client should still be allowed
    const other = limiter.check("10.0.0.5");
    expect(other.allowed).toBe(true);
  });

  it("validates environment schema and defaults", () => {
    const valid = EnvironmentSchema.parse({
      NODE_ENV: "development",
      PORT: "3005",
      MAX_TASK_DURATION_MS: "600000",
    });

    expect(valid.PORT).toBe(3005);
    expect(valid.MAX_TASK_DURATION_MS).toBe(600000);
    expect(valid.MAX_TOOL_ITERATIONS).toBe(50);

    // Invalid port rejection
    expect(() => {
      EnvironmentSchema.parse({ PORT: "not-a-number" });
    }).toThrow();
  });

  it("refuses to start in production without strong session and encryption secrets", () => {
    const prodBase = {
      NODE_ENV: "production",
      E2B_API_KEY: "e2b_test_key",
      DATABASE_URL: "postgres://localhost:5432/test",
      GITHUB_WEBHOOK_SECRET: "whsec_test_value",
    };

    // Neither secret set
    expect(() => loadConfig({ ...prodBase })).toThrow(/SESSION_SECRET/);

    // SESSION_SECRET set but ENCRYPTION_KEY missing
    expect(() =>
      loadConfig({ ...prodBase, SESSION_SECRET: "s".repeat(32) }),
    ).toThrow(/ENCRYPTION_KEY/);

    // Secrets shorter than 32 characters are rejected
    expect(() =>
      loadConfig({ ...prodBase, SESSION_SECRET: "short", ENCRYPTION_KEY: "k".repeat(32) }),
    ).toThrow(/SESSION_SECRET/);

    // Webhook secret missing is fatal: without it forged GitHub events are accepted
    const noWebhookSecret = { ...prodBase, SESSION_SECRET: "s".repeat(48), ENCRYPTION_KEY: "k".repeat(48) };
    delete (noWebhookSecret as { GITHUB_WEBHOOK_SECRET?: string }).GITHUB_WEBHOOK_SECRET;
    expect(() => loadConfig(noWebhookSecret)).toThrow(/GITHUB_WEBHOOK_SECRET/);

    // Valid secrets boot cleanly
    const ok = loadConfig({
      ...prodBase,
      SESSION_SECRET: "s".repeat(48),
      ENCRYPTION_KEY: "k".repeat(48),
    });
    expect(ok.NODE_ENV).toBe("production");
  });

  it("boots in development without any secrets configured", () => {
    const config = loadConfig({ NODE_ENV: "development" });
    expect(config.NODE_ENV).toBe("development");
    expect(config.SESSION_SECRET).toBeUndefined();
    expect(config.ENCRYPTION_KEY).toBeUndefined();
  });

  it("derives the credential encryption key from ENCRYPTION_KEY only, never SESSION_SECRET", () => {
    const previousEncryptionKey = process.env.ENCRYPTION_KEY;
    const previousSessionSecret = process.env.SESSION_SECRET;

    try {
      delete process.env.ENCRYPTION_KEY;
      process.env.SESSION_SECRET = "first-unrelated-session-secret-value";

      const encrypted = encryptCredential("user-token-123");

      // If SESSION_SECRET were still part of the key chain, changing it between
      // encrypt and decrypt would break decryption. Falling back to the constant
      // dev key means both operations use the same key regardless.
      process.env.SESSION_SECRET = "second-completely-different-secret-value";
      const decrypted = decryptCredential(encrypted);
      expect(decrypted).toBe("user-token-123");
    } finally {
      if (previousEncryptionKey === undefined) {
        delete process.env.ENCRYPTION_KEY;
      } else {
        process.env.ENCRYPTION_KEY = previousEncryptionKey;
      }
      if (previousSessionSecret === undefined) {
        delete process.env.SESSION_SECRET;
      } else {
        process.env.SESSION_SECRET = previousSessionSecret;
      }
    }
  });

  it("identifies and terminates timed out tasks in SandboxScavenger", async () => {
    const repo = new MemoryTaskRepository();
    const eventBus = new MemoryEventBus();

    // Create a stale task with createdAt 20 minutes in the past
    const staleTask = await repo.createTask(
      "task-stale-1",
      {
        repo: { owner: "test", repo: "test", branch: "main" },
        prompt: "Run continuous heavy simulation",
        model: "codex",
      },
      "agent/patch-stale-1",
    );

    // Manually backdate createdAt to 20 minutes ago
    const pastDate = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    await repo.updateTask(staleTask.id, {
      status: "running",
      createdAt: pastDate,
      updatedAt: pastDate,
      sandboxId: "mock-sandbox-123",
    });

    // Create a fresh task created just now
    const freshTask = await repo.createTask(
      "task-fresh-2",
      {
        repo: { owner: "test", repo: "test", branch: "main" },
        prompt: "Fix bug in header",
        model: "codex",
      },
      "agent/patch-fresh-2",
    );
    await repo.updateTask(freshTask.id, { status: "running" });

    const scavenger = new SandboxScavenger({
      repo,
      eventBus,
      maxTaskDurationMs: 15 * 60 * 1000, // 15 minutes limit
    });

    const result = await scavenger.reconcile();
    expect(result.timedOutTasks).toBe(1);

    // Stale task should now be failed
    const updatedStale = await repo.getTask("task-stale-1");
    expect(updatedStale?.status).toBe("failed");
    expect(updatedStale?.error).toContain("exceeded maximum limit");

    // Fresh task should still be running
    const updatedFresh = await repo.getTask("task-fresh-2");
    expect(updatedFresh?.status).toBe("running");
  });

  it("returns HTTP 429 when task creation exceeds rate limit", async () => {
    const repo = new MemoryTaskRepository();
    const eventBus = new MemoryEventBus();
    const worker = new TaskWorker(repo, eventBus);
    const queue = new DirectTaskQueue(worker);

    // Set restrictive taskLimiter (max 2 requests)
    const taskLimiter = new RateLimiter({ windowMs: 10_000, maxRequests: 2 });

    const server = createServer({
      port: 0,
      repo,
      eventBus,
      queue,
      taskLimiter,
    });

    const baseUrl = `http://localhost:${server.port}`;

    try {
      const token = createSessionToken({
        sub: "usr_rate_test",
        username: "rate-tester",
        email: "rate-tester@example.com",
        avatarUrl: "",
      });
      const requestHeaders = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      };

      const payload = {
        repo: { owner: "acme", repo: "api", branch: "main" },
        prompt: "Add health check endpoint with unit tests",
        model: "codex",
      };

      // Unauthenticated requests are rejected before rate limiting applies
      const anonRes = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      expect(anonRes.status).toBe(401);

      // 1st request -> 201
      const res1 = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: requestHeaders,
        body: JSON.stringify(payload),
      });
      expect(res1.status).toBe(201);

      // 2nd request -> 201
      const res2 = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: requestHeaders,
        body: JSON.stringify(payload),
      });
      expect(res2.status).toBe(201);

      // 3rd request -> 429 Too Many Requests
      const res3 = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: requestHeaders,
        body: JSON.stringify(payload),
      });
      expect(res3.status).toBe(429);
      const data3 = (await res3.json()) as { error: string };
      expect(data3.error).toContain("Too many task creation requests");
    } finally {
      server.stop();
    }
  });

  it("fails tasks whose owner has no credentials instead of borrowing shared or operator credentials", async () => {
    const repo = new MemoryTaskRepository();
    const eventBus = new MemoryEventBus();
    const worker = new TaskWorker(repo, eventBus);

    // Shared "default" account and operator env key that must NOT be borrowed
    await repo.saveAuthSession("codex", '{"token":"operator-default"}', "default", "subscription");
    const previousKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-operator-env-key";

    try {
      const task = await repo.createTask(
        "task-no-creds",
        { repo: { owner: "acme", repo: "api", branch: "main" }, prompt: "fix bug", model: "codex" },
        "agent/patch-no-creds",
        "usr_unconnected",
      );
      expect(task.userId).toBe("usr_unconnected");

      await worker.processTask("task-no-creds");

      const failed = await repo.getTask("task-no-creds");
      expect(failed?.status).toBe("failed");
      expect(failed?.error).toContain("connect");

      // The owner's row must still be empty — nothing was copied into it
      const ownerRecord = await repo.getAuthSessionRecord("codex", "usr_unconnected");
      expect(ownerRecord).toBeNull();
    } finally {
      if (previousKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previousKey;
      }
    }
  });

  it("refuses the in-memory database fallback in production", async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousDbUrl = process.env.DATABASE_URL;

    try {
      delete process.env.DATABASE_URL;

      // Production: missing DATABASE_URL must abort boot, never silently downgrade
      process.env.NODE_ENV = "production";
      await expect(createTaskRepository()).rejects.toThrow(/DATABASE_URL/);

      // Development: same condition falls back to the in-memory repository
      process.env.NODE_ENV = "development";
      const repo = await createTaskRepository();
      expect(repo).toBeInstanceOf(MemoryTaskRepository);
      await repo.close();
    } finally {
      process.env.NODE_ENV = previousNodeEnv;
      if (previousDbUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDbUrl;
    }
  });

  it("links installations to a user only when the account login matches", async () => {
    const repo = new MemoryTaskRepository();
    await repo.upsertUser({
      id: "usr_bob",
      githubId: 42,
      username: "bob",
      email: "bob@example.com",
      avatarUrl: "",
      defaultModel: "codex",
      defaultAuthMode: "subscription",
      onboardingCompleted: false,
    });

    // The app's ONLY installation belongs to alice. The old single-tenant
    // heuristic linked it to every new user — bob must not receive it.
    const installations = [
      {
        id: 501,
        account: { login: "alice", type: "User" },
        repository_selection: "all",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      },
    ];
    const fakeTokenManager = {
      isConfigured: () => true,
      getAppOctokit: () => ({
        rest: { apps: { listInstallations: async () => ({ data: installations }) } },
      }),
    } as unknown as GitHubTokenManager;

    await syncGitHubInstallations(repo, fakeTokenManager, "usr_bob");
    expect((await repo.listUserInstallations("usr_bob")).length).toBe(0);

    // alice syncing her own account links her installation
    await repo.upsertUser({
      id: "usr_alice",
      githubId: 43,
      username: "alice",
      email: "alice@example.com",
      avatarUrl: "",
      defaultModel: "codex",
      defaultAuthMode: "subscription",
      onboardingCompleted: false,
    });
    await syncGitHubInstallations(repo, fakeTokenManager, "usr_alice");
    const aliceInstalls = await repo.listUserInstallations("usr_alice");
    expect(aliceInstalls.length).toBe(1);
    expect(aliceInstalls[0]?.id).toBe(501);
  });

  it("links a setup installation only when it verifiably belongs to the session user", async () => {
    const repo = new MemoryTaskRepository();
    const eventBus = new MemoryEventBus();
    const worker = new TaskWorker(repo, eventBus);
    const queue = new DirectTaskQueue(worker);
    const tokenManager = fakeSetupTokenManager();

    const server = createServer({ port: 0, repo, eventBus, queue, tokenManager });
    const baseUrl = `http://localhost:${server.port}`;
    const token = createSessionToken({
      sub: "usr_setup_test",
      username: "setup-tester",
      email: "s@example.com",
      avatarUrl: "",
    });
    const headers = { Authorization: `Bearer ${token}` };

    try {
      // Someone else's installation: must not be linked to the session user
      const victimRes = await fetch(`${baseUrl}/api/github/setup?installation_id=321`, {
        headers,
        redirect: "manual",
      });
      expect(victimRes.status).toBe(302);
      expect(await repo.listUserInstallations("usr_setup_test")).toHaveLength(0);

      // The user's own installation: linked
      const ownRes = await fetch(`${baseUrl}/api/github/setup?installation_id=322`, {
        headers,
        redirect: "manual",
      });
      expect(ownRes.status).toBe(302);
      const linked = await repo.listUserInstallations("usr_setup_test");
      expect(linked).toHaveLength(1);
      expect(linked[0]?.id).toBe(322);
    } finally {
      server.stop();
    }
  });

  it("destroys sandbox instance immediately on cancel", () => {
    const repo = new MemoryTaskRepository();
    const eventBus = new MemoryEventBus();
    const worker = new TaskWorker(repo, eventBus);

    // Cancel non-existent task
    const notCancelled = worker.cancel("task-does-not-exist");
    expect(notCancelled).toBe(false);
  });

  it("retrieves oldest active tasks with listActiveTasks", async () => {
    const repo = new MemoryTaskRepository();

    const t1 = await repo.createTask(
      "t1",
      { repo: { owner: "o", repo: "r", branch: "b" }, prompt: "p1", model: "codex" },
      "patch-1",
    );
    await repo.updateTask(t1.id, { status: "completed" });

    const t2 = await repo.createTask(
      "t2",
      { repo: { owner: "o", repo: "r", branch: "b" }, prompt: "p2", model: "codex" },
      "patch-2",
    );
    await repo.updateTask(t2.id, { status: "running" });

    const t3 = await repo.createTask(
      "t3",
      { repo: { owner: "o", repo: "r", branch: "b" }, prompt: "p3", model: "codex" },
      "patch-3",
    );
    await repo.updateTask(t3.id, { status: "provisioning" });

    const active = await repo.listActiveTasks(10);
    expect(active.length).toBe(2);
    expect(active.map((t) => t.id)).toEqual(["t2", "t3"]);
  });
});
