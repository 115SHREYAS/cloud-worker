import { describe, it, expect } from "bun:test";
import { MemoryTaskRepository } from "./db/repository.ts";
import { MemoryEventBus } from "./events/event-bus.ts";
import { TaskWorker } from "./queue/task-worker.ts";

describe("Task worker queue redelivery guard", () => {
  it("fails an orphaned in-flight task instead of re-executing it", async () => {
    const repo = new MemoryTaskRepository();
    const eventBus = new MemoryEventBus();
    const worker = new TaskWorker(repo, eventBus);

    const task = await repo.createTask(
      "task-redeliver-1",
      {
        repo: { owner: "test", repo: "test", branch: "main" },
        prompt: "Do some agent work",
        model: "codex",
      },
      "agent/patch-redeliver-1",
    );

    // Simulate a task that was mid-flight (parked in the warm input window)
    // when the previous server instance died and BullMQ re-delivered the job.
    await repo.updateTask(task.id, { status: "waiting_input" });

    await worker.processTask(task.id);

    const updated = await repo.getTask(task.id);
    expect(updated?.status).toBe("failed");
    expect(updated?.error).toContain("interrupted by a server restart");
    expect(updated?.completedAt).toBeTruthy();

    // The stream saw the failure, not a fresh execution
    const logs = await repo.getLogs(task.id);
    expect(logs.some((e) => e.type === "status" && e.status === "failed")).toBe(true);
    expect(logs.some((e) => e.type === "error")).toBe(true);
    expect(logs.some((e) => e.type === "turn_start")).toBe(false);
  });

  it("does not start a second execution while a task is already active", async () => {
    const repo = new MemoryTaskRepository();
    const eventBus = new MemoryEventBus();
    const worker = new TaskWorker(repo, eventBus);

    const task = await repo.createTask(
      "task-redeliver-2",
      {
        repo: { owner: "test", repo: "test", branch: "main" },
        prompt: "Do some agent work",
        model: "codex",
      },
      "agent/patch-redeliver-2",
    );

    // Register a fake active controller as if a turn is running right now
    (worker as unknown as { activeControllers: Map<string, AbortController> }).activeControllers.set(
      task.id,
      new AbortController(),
    );

    await worker.processTask(task.id);

    // The task record was left untouched by the duplicate delivery
    const updated = await repo.getTask(task.id);
    expect(updated?.status).toBe("pending");
  });

  it("still processes fresh pending tasks past the guard", async () => {
    const repo = new MemoryTaskRepository();
    const eventBus = new MemoryEventBus();
    const worker = new TaskWorker(repo, eventBus);

    const task = await repo.createTask(
      "task-redeliver-3",
      {
        repo: { owner: "test", repo: "test", branch: "main" },
        prompt: "Do some agent work",
        model: "codex",
      },
      "agent/patch-redeliver-3",
    );

    await worker.processTask(task.id);

    // With no credentials configured it fails fast at the credential step —
    // proving execution proceeded past the redelivery guard.
    const updated = await repo.getTask(task.id);
    expect(updated?.status).toBe("failed");
    expect(updated?.error).toContain("No valid authentication credentials");
    expect(updated?.error).not.toContain("interrupted by a server restart");
  });
});
