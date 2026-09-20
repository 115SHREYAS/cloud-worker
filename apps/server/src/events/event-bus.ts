import { EventEmitter } from "node:events";
import Redis from "ioredis";
import { getTaskChannel, StreamEventSchema, type StreamEvent } from "@cloud-worker/shared";

export type EventHandler = (event: StreamEvent) => void;
export type Unsubscribe = () => void;

export interface EventBus {
  publish(event: StreamEvent): Promise<void>;
  subscribe(taskId: string, handler: EventHandler): Unsubscribe;
  close(): Promise<void>;
}

export class MemoryEventBus implements EventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(500);
  }

  async publish(event: StreamEvent): Promise<void> {
    if ("taskId" in event && typeof event.taskId === "string") {
      this.emitter.emit(`task:${event.taskId}`, event);
    }
  }

  subscribe(taskId: string, handler: EventHandler): Unsubscribe {
    const channel = `task:${taskId}`;
    this.emitter.on(channel, handler);
    return () => {
      this.emitter.off(channel, handler);
    };
  }

  async close(): Promise<void> {
    this.emitter.removeAllListeners();
  }
}

export class RedisEventBus implements EventBus {
  private readonly pub: Redis;
  private readonly sub: Redis;
  private readonly handlers = new Map<string, Set<EventHandler>>();
  private isSubscribed = false;

  constructor(redisUrl: string) {
    this.pub = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 3 });
    this.sub = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 3 });

    this.pub.on("error", (err) => {
      console.error("[event-bus] Redis pub client error:", err.message);
    });
    this.sub.on("error", (err) => {
      console.error("[event-bus] Redis sub client error:", err.message);
    });
  }

  async init(): Promise<void> {
    await Promise.all([this.pub.connect(), this.sub.connect()]);

    this.sub.on("message", (channel: string, message: string) => {
      // Channel pattern is task:<taskId>:events
      const match = channel.match(/^task:(.+):events$/);
      if (!match) return;

      const taskId = match[1];
      if (!taskId) return;

      const listeners = this.handlers.get(taskId);
      if (!listeners || listeners.size === 0) return;

      try {
        const raw = JSON.parse(message);
        const parsed = StreamEventSchema.safeParse(raw);
        if (parsed.success) {
          for (const listener of listeners) {
            listener(parsed.data);
          }
        }
      } catch (err) {
        console.error(`[event-bus] Failed to parse message on ${channel}:`, err);
      }
    });

    this.isSubscribed = true;
  }

  async publish(event: StreamEvent): Promise<void> {
    if (!("taskId" in event) || typeof event.taskId !== "string") {
      return;
    }
    const channel = getTaskChannel(event.taskId);
    await this.pub.publish(channel, JSON.stringify(event));
  }

  subscribe(taskId: string, handler: EventHandler): Unsubscribe {
    let set = this.handlers.get(taskId);
    if (!set) {
      set = new Set();
      this.handlers.set(taskId, set);
      const channel = getTaskChannel(taskId);
      this.sub.subscribe(channel).catch((err) => {
        console.error(`[event-bus] Failed to subscribe to Redis channel ${channel}:`, err);
      });
    }
    set.add(handler);

    return () => {
      const currentSet = this.handlers.get(taskId);
      if (currentSet) {
        currentSet.delete(handler);
        if (currentSet.size === 0) {
          this.handlers.delete(taskId);
          const channel = getTaskChannel(taskId);
          this.sub.unsubscribe(channel).catch(() => {});
        }
      }
    };
  }

  async close(): Promise<void> {
    this.handlers.clear();
    await Promise.all([this.pub.quit(), this.sub.quit()]);
  }
}

export async function createEventBus(redisUrl?: string): Promise<EventBus> {
  const url = redisUrl ?? process.env.REDIS_URL;
  if (!url) {
    console.log("[event-bus] REDIS_URL not set. Using MemoryEventBus.");
    return new MemoryEventBus();
  }

  try {
    const bus = new RedisEventBus(url);
    await bus.init();
    console.log("[event-bus] Connected to Redis EventBus.");
    return bus;
  } catch (err) {
    console.warn("[event-bus] Redis connection failed. Falling back to MemoryEventBus:", err);
    return new MemoryEventBus();
  }
}
