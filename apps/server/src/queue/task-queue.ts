import { Queue, Worker } from "bullmq";
import Redis from "ioredis";
import type { TaskWorker } from "./task-worker.ts";

export interface TaskQueue {
  enqueue(taskId: string): Promise<void>;
  cancel(taskId: string): Promise<boolean>;
  close(): Promise<void>;
}

export class DirectTaskQueue implements TaskQueue {
  private readonly runningTasks = new Set<string>();

  constructor(private readonly worker: TaskWorker) {}

  async enqueue(taskId: string): Promise<void> {
    this.runningTasks.add(taskId);
    // Execute task asynchronously without blocking caller
    queueMicrotask(async () => {
      try {
        await this.worker.processTask(taskId);
      } catch (err) {
        console.error(`[direct-queue] Unhandled task failure for ${taskId}:`, err);
      } finally {
        this.runningTasks.delete(taskId);
      }
    });
  }

  async cancel(taskId: string): Promise<boolean> {
    return this.worker.cancel(taskId);
  }

  async close(): Promise<void> {
    this.runningTasks.clear();
  }
}

export class BullMQTaskQueue implements TaskQueue {
  private readonly queue: Queue;
  private readonly workerInstance: Worker;
  private readonly redisConn: Redis;

  constructor(
    redisUrl: string,
    private readonly taskWorker: TaskWorker,
  ) {
    this.redisConn = new Redis(redisUrl, { maxRetriesPerRequest: null });
    this.redisConn.on("error", (err) => {
      console.error("[task-queue] BullMQ Redis connection error:", err.message);
    });
    this.queue = new Queue("cloud-worker-tasks", { connection: this.redisConn });

    this.workerInstance = new Worker(
      "cloud-worker-tasks",
      async (job) => {
        await this.taskWorker.processTask(job.data.taskId);
      },
      {
        connection: this.redisConn,
        concurrency: 5,
      },
    );
  }

  async enqueue(taskId: string): Promise<void> {
    await this.queue.add(
      "run-agent",
      { taskId },
      {
        jobId: taskId,
        removeOnComplete: true,
        removeOnFail: false,
      },
    );
  }

  async cancel(taskId: string): Promise<boolean> {
    const cancelledLive = this.taskWorker.cancel(taskId);
    try {
      const job = await this.queue.getJob(taskId);
      if (job) {
        await job.remove();
        return true;
      }
    } catch {
      // Ignore queue lookup errors
    }
    return cancelledLive;
  }

  async close(): Promise<void> {
    await Promise.all([this.workerInstance.close(), this.queue.close(), this.redisConn.quit()]);
  }
}

export async function createTaskQueue(
  taskWorker: TaskWorker,
  redisUrl?: string,
): Promise<TaskQueue> {
  const url = redisUrl ?? process.env.REDIS_URL;
  if (!url) {
    console.log("[task-queue] REDIS_URL not set. Using DirectTaskQueue.");
    return new DirectTaskQueue(taskWorker);
  }

  try {
    const queue = new BullMQTaskQueue(url, taskWorker);
    console.log("[task-queue] Initialized BullMQ with Redis.");
    return queue;
  } catch (err) {
    console.warn("[task-queue] BullMQ initialization failed. Falling back to DirectTaskQueue:", err);
    return new DirectTaskQueue(taskWorker);
  }
}
