import { SandboxManager } from "@cloud-worker/sandbox";
import type { TaskRepository } from "../db/repository";
import type { EventBus } from "../events/event-bus";

export interface SandboxScavengerOptions {
  repo: TaskRepository;
  eventBus: EventBus;
  pollIntervalMs?: number;
  maxTaskDurationMs?: number;
  apiKey?: string;
}

export class SandboxScavenger {
  private timer?: ReturnType<typeof setInterval>;
  private readonly repo: TaskRepository;
  private readonly eventBus: EventBus;
  private readonly pollIntervalMs: number;
  private readonly maxTaskDurationMs: number;
  private readonly apiKey?: string;
  private running = false;

  constructor(options: SandboxScavengerOptions) {
    this.repo = options.repo;
    this.eventBus = options.eventBus;
    this.pollIntervalMs = options.pollIntervalMs ?? 60_000;
    this.maxTaskDurationMs = options.maxTaskDurationMs ?? 900_000; // 15 minutes default
    this.apiKey = options.apiKey ?? process.env.E2B_API_KEY;
  }

  public start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.reconcile().catch((err) => {
        console.error("[sandbox-scavenger] Error during orphan sandbox reconciliation:", err);
      });
    }, this.pollIntervalMs);
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  public async reconcile(): Promise<{ timedOutTasks: number; terminatedSandboxes: number }> {
    if (this.running) return { timedOutTasks: 0, terminatedSandboxes: 0 };
    this.running = true;

    let timedOutTasks = 0;
    let terminatedSandboxes = 0;

    try {
      const activeTasks = await this.repo.listActiveTasks(100);
      const now = Date.now();

      for (const task of activeTasks) {
        const referenceTimeMs = new Date(task.updatedAt || task.createdAt).getTime();
        const durationMs = now - referenceTimeMs;

        // Pending tasks get double allowance before considered dead in queue
        const thresholdMs = task.status === "pending" ? this.maxTaskDurationMs * 2 : this.maxTaskDurationMs;

        // Check if task has exceeded maximum permitted lifetime
        if (durationMs > thresholdMs) {
          console.warn(
            `[sandbox-scavenger] Task ${task.id} (${task.status}) exceeded duration limit (${Math.round(durationMs / 1000)}s > ${Math.round(thresholdMs / 1000)}s). Terminating.`,
          );

          // 1. Terminate sandbox if sandboxId is recorded
          if (task.sandboxId) {
            try {
              const sandbox = await SandboxManager.connect(task.sandboxId, this.apiKey);
              await sandbox.destroy();
              terminatedSandboxes++;
            } catch (destroyErr) {
              console.warn(`[sandbox-scavenger] Failed to kill sandbox ${task.sandboxId}:`, destroyErr);
            }
          }

          // 2. Mark task failed due to timeout
          const timeoutMessage = `Task timed out after ${Math.round(durationMs / 1000)}s (exceeded maximum limit)`;
          await this.repo.updateTask(task.id, {
            status: "failed",
            error: timeoutMessage,
            completedAt: new Date().toISOString(),
          });

          await this.eventBus.publish({
            type: "status",
            taskId: task.id,
            status: "failed",
            message: timeoutMessage,
            timestamp: now,
          });

          await this.eventBus.publish({
            type: "error",
            taskId: task.id,
            message: timeoutMessage,
            timestamp: now,
          });

          timedOutTasks++;
        }
      }
    } finally {
      this.running = false;
    }

    return { timedOutTasks, terminatedSandboxes };
  }
}
