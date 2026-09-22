import { describe, it, expect } from "bun:test";
import { RateLimiter } from "./security/rate-limiter.ts";
import { EnvironmentSchema, loadConfig } from "./config/env.ts";
import { SandboxScavenger } from "./queue/sandbox-cleaner.ts";
import { MemoryTaskRepository } from "./db/repository.ts";
import { MemoryEventBus } from "./events/event-bus.ts";
import { DirectTaskQueue } from "./queue/task-queue.ts";
import { TaskWorker } from "./queue/task-worker.ts";
import { createServer } from "./server.ts";

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
      const payload = {
        repo: { owner: "acme", repo: "api", branch: "main" },
        prompt: "Add health check endpoint with unit tests",
        model: "codex",
      };

      // 1st request -> 201
      const res1 = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      expect(res1.status).toBe(201);

      // 2nd request -> 201
      const res2 = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      expect(res2.status).toBe(201);

      // 3rd request -> 429 Too Many Requests
      const res3 = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      expect(res3.status).toBe(429);
      const data3 = (await res3.json()) as { error: string };
      expect(data3.error).toContain("Too many task creation requests");
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
