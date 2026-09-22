import { createTaskRepository } from "./src/db/index.ts";
import { createEventBus } from "./src/events/index.ts";
import { TaskWorker, createTaskQueue } from "./src/queue/index.ts";
import { createServer } from "./src/server.ts";
import { GitHubTokenManager } from "./src/github/index.ts";

const PORT = Number(process.env.PORT) || 3001;

async function bootstrap() {
  console.log("Starting Cloud Worker Control Plane...");

  // 1. Initialize database layer (PostgreSQL or Memory fallback)
  const repo = await createTaskRepository(process.env.DATABASE_URL);

  // 2. Initialize real-time event bus (Redis Pub/Sub or Memory fallback)
  const eventBus = await createEventBus(process.env.REDIS_URL);

  // 3. Initialize GitHub App token manager
  const tokenManager = new GitHubTokenManager();
  if (tokenManager.isConfigured()) {
    console.log(`[github] GitHub App configured (App ID: ${tokenManager.getAppId()})`);
  } else {
    console.log("[github] GitHub App not configured. Running in token fallback / demo mode.");
  }

  // 4. Initialize task worker and queue (BullMQ or Direct queue fallback)
  const worker = new TaskWorker(repo, eventBus, tokenManager);
  const queue = await createTaskQueue(worker, process.env.REDIS_URL);

  // 5. Start HTTP and SSE server
  const server = createServer({
    port: PORT,
    repo,
    eventBus,
    queue,
    tokenManager,
  });


  console.log(`Cloud Worker API listening at http://localhost:${server.port}`);

  // 5. Graceful shutdown handler
  const shutdown = async () => {
    console.log("\nShutting down Cloud Worker server...");
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