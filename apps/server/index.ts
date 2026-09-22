import { createTaskRepository } from "./src/db/index.ts";
import { createEventBus } from "./src/events/index.ts";
import { TaskWorker, createTaskQueue, SandboxScavenger } from "./src/queue/index.ts";
import { createServer } from "./src/server.ts";
import { GitHubTokenManager } from "./src/github/index.ts";
import { loadConfig } from "./src/config/env.ts";

async function bootstrap() {
  console.log("Starting Cloud Worker Control Plane...");

  // 1. Load and validate environment configuration
  const config = loadConfig();

  // 2. Initialize database layer (PostgreSQL or Memory fallback)
  const repo = await createTaskRepository(config.DATABASE_URL);

  // 3. Initialize real-time event bus (Redis Pub/Sub or Memory fallback)
  const eventBus = await createEventBus(config.REDIS_URL);

  // 4. Initialize GitHub App token manager
  const tokenManager = new GitHubTokenManager();
  if (tokenManager.isConfigured()) {
    console.log(`[github] GitHub App configured (App ID: ${tokenManager.getAppId()})`);
  } else {
    console.log("[github] GitHub App not configured. Running in token fallback / demo mode.");
  }

  // 5. Initialize task worker with hard timeout guard and BullMQ/Direct queue
  const worker = new TaskWorker(
    repo,
    eventBus,
    tokenManager,
    config.MAX_TASK_DURATION_MS,
    config.E2B_API_KEY,
  );
  const queue = await createTaskQueue(worker, config.REDIS_URL);

  // 6. Initialize and start orphan sandbox scavenger
  const scavenger = new SandboxScavenger({
    repo,
    eventBus,
    maxTaskDurationMs: config.MAX_TASK_DURATION_MS,
    apiKey: config.E2B_API_KEY,
  });
  scavenger.start();

  // 7. Start HTTP and SSE server
  const server = createServer({
    port: config.PORT,
    repo,
    eventBus,
    queue,
    tokenManager,
  });

  console.log(`Cloud Worker API listening at http://localhost:${server.port}`);

  // 8. Graceful shutdown handler
  const shutdown = async () => {
    console.log("\nShutting down Cloud Worker server...");
    scavenger.stop();
    server.stop();
    await queue.close();
    await eventBus.close();
    await repo.close();
    console.log("Server shutdown complete.");
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

bootstrap().catch((err) => {
  console.error("Fatal error during server startup:", err);
  process.exit(1);
});