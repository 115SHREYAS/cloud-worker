import {
  CreateTaskInputSchema,
  type StreamEvent,
} from "@cloud-worker/shared";
import type { AgentProvider } from "@cloud-worker/sandbox";
import type { TaskRepository } from "./db/repository.ts";
import type { EventBus } from "./events/event-bus.ts";
import type { TaskQueue } from "./queue/task-queue.ts";
import type { GitHubTokenManager } from "./github/token-manager.ts";
import { handleGitHubWebhook } from "./github/webhooks.ts";
import { verify } from "@octokit/webhooks-methods";
import { RateLimiter } from "./security/rate-limiter.ts";

export interface ServerOptions {
  port?: number;
  repo: TaskRepository;
  eventBus: EventBus;
  queue: TaskQueue;
  tokenManager?: GitHubTokenManager;
  taskLimiter?: RateLimiter;
  webhookLimiter?: RateLimiter;
}



const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export function createServer(options: ServerOptions) {
  const { port = 3001, repo, eventBus, queue, tokenManager } = options;
  const taskLimiter = options.taskLimiter ?? new RateLimiter({ windowMs: 60_000, maxRequests: 20 });
  const webhookLimiter = options.webhookLimiter ?? new RateLimiter({ windowMs: 60_000, maxRequests: 60 });



  const server = Bun.serve({
    port,
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      const path = url.pathname;
      const method = req.method.toUpperCase();

      // Handle CORS preflight
      if (method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: CORS_HEADERS,
        });
      }

      try {
        // Health check
        if (path === "/health" && method === "GET") {
          return Response.json(
            {
              status: "ok",
              service: "cloud-worker-server",
              runtime: "bun",
              timestamp: Date.now(),
            },
            { headers: CORS_HEADERS },
          );
        }

        // List tasks
        if (path === "/api/tasks" && method === "GET") {
          const limitParam = url.searchParams.get("limit");
          const parsedLimit = limitParam ? parseInt(limitParam, 10) : 50;
          const limit = Number.isNaN(parsedLimit) ? 50 : Math.min(Math.max(1, parsedLimit), 100);
          const tasks = await repo.listTasks(limit);
          return Response.json({ tasks }, { headers: CORS_HEADERS });
        }

        // Create task
        if (path === "/api/tasks" && method === "POST") {
          const clientIp = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
          const limitCheck = taskLimiter.check(clientIp);
          if (!limitCheck.allowed) {
            return Response.json(
              { error: "Too many task creation requests. Please try again later." },
              {
                status: 429,
                headers: {
                  ...CORS_HEADERS,
                  "Retry-After": String(Math.ceil(Math.max(0, limitCheck.resetAtMs - Date.now()) / 1000)),
                },
              },
            );
          }

          let body: unknown;
          try {
            body = await req.json();
          } catch {
            return Response.json({ error: "Invalid JSON body" }, { status: 400, headers: CORS_HEADERS });
          }

          const parsed = CreateTaskInputSchema.safeParse(body);

          if (!parsed.success) {
            return Response.json(
              { error: "Validation failed", details: parsed.error.format() },
              { status: 400, headers: CORS_HEADERS },
            );
          }

          const input = parsed.data;
          const taskId = `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
          const workingBranch = `agent/patch-${taskId}`;

          const task = await repo.createTask(taskId, input, workingBranch);
          await queue.enqueue(taskId);

          return Response.json({ task }, { status: 201, headers: CORS_HEADERS });
        }

        // Task stream (SSE)
        const streamMatch = path.match(/^\/api\/tasks\/([^/]+)\/stream$/);
        if (streamMatch && method === "GET") {
          const taskId = streamMatch[1];
          if (!taskId) {
            return Response.json({ error: "Task ID required" }, { status: 400, headers: CORS_HEADERS });
          }

          const task = await repo.getTask(taskId);
          if (!task) {
            return Response.json({ error: "Task not found" }, { status: 404, headers: CORS_HEADERS });
          }

          const encoder = new TextEncoder();
          let pingTimer: ReturnType<typeof setInterval> | undefined;
          let unsubscribe: (() => void) | undefined;
          let isCancelled = false;

          const readable = new ReadableStream({
            async start(controller) {
              const sendEvent = (event: StreamEvent) => {
                if (isCancelled) return;
                try {
                  const line = `data: ${JSON.stringify(event)}\n\n`;
                  controller.enqueue(encoder.encode(line));
                } catch {
                  // Client may have disconnected
                }
              };

              // Buffer live events during historical log retrieval
              const liveBuffer: StreamEvent[] = [];
              let isReplaying = true;

              // 1. Subscribe to live events immediately to prevent event loss
              unsubscribe = eventBus.subscribe(taskId, (event) => {
                if (isReplaying) {
                  liveBuffer.push(event);
                } else {
                  sendEvent(event);
                }
              });

              // 2. Fetch and replay historical logs
              const logs = await repo.getLogs(taskId);

              if (isCancelled) {
                if (unsubscribe) unsubscribe();
                return;
              }

              for (const log of logs) {
                sendEvent(log);
              }

              // 3. Replay buffered live events that arrived during the DB fetch
              isReplaying = false;
              for (const liveEvent of liveBuffer) {
                sendEvent(liveEvent);
              }

              if (isCancelled) {
                if (unsubscribe) unsubscribe();
                return;
              }

              // 4. Keepalive ping every 15 seconds
              pingTimer = setInterval(() => {
                if (isCancelled) {
                  if (pingTimer) clearInterval(pingTimer);
                  return;
                }
                try {
                  const pingLine = `data: ${JSON.stringify({ type: "ping", timestamp: Date.now() })}\n\n`;
                  controller.enqueue(encoder.encode(pingLine));
                } catch {
                  if (pingTimer) clearInterval(pingTimer);
                }
              }, 15_000);
            },
            cancel() {
              isCancelled = true;
              if (pingTimer) clearInterval(pingTimer);
              if (unsubscribe) unsubscribe();
            },
          });

          return new Response(readable, {
            headers: {
              ...CORS_HEADERS,
              "Content-Type": "text/event-stream; charset=utf-8",
              "Cache-Control": "no-cache, no-transform",
              "Connection": "keep-alive",
              "X-Accel-Buffering": "no",
            },
          });
        }

        // Get single task
        const taskMatch = path.match(/^\/api\/tasks\/([^/]+)$/);
        if (taskMatch && method === "GET") {
          const taskId = taskMatch[1];
          if (!taskId) {
            return Response.json({ error: "Task ID required" }, { status: 400, headers: CORS_HEADERS });
          }

          const task = await repo.getTask(taskId);
          if (!task) {
            return Response.json({ error: "Task not found" }, { status: 404, headers: CORS_HEADERS });
          }
          return Response.json({ task }, { headers: CORS_HEADERS });
        }

        // Get task logs
        const logsMatch = path.match(/^\/api\/tasks\/([^/]+)\/logs$/);
        if (logsMatch && method === "GET") {
          const taskId = logsMatch[1];
          if (!taskId) {
            return Response.json({ error: "Task ID required" }, { status: 400, headers: CORS_HEADERS });
          }

          const task = await repo.getTask(taskId);
          if (!task) {
            return Response.json({ error: "Task not found" }, { status: 404, headers: CORS_HEADERS });
          }

          const logs = await repo.getLogs(taskId);
          return Response.json({ taskId, logs }, { headers: CORS_HEADERS });
        }

        // Cancel task
        const cancelMatch = path.match(/^\/api\/tasks\/([^/]+)\/cancel$/);
        if (cancelMatch && method === "POST") {
          const taskId = cancelMatch[1];
          if (!taskId) {
            return Response.json({ error: "Task ID required" }, { status: 400, headers: CORS_HEADERS });
          }

          const task = await repo.getTask(taskId);
          if (!task) {
            return Response.json({ error: "Task not found" }, { status: 404, headers: CORS_HEADERS });
          }

          const cancelled = await queue.cancel(taskId);
          await repo.updateTask(taskId, {
            status: "cancelled",
            completedAt: new Date().toISOString(),
          });

          await eventBus.publish({
            type: "status",
            taskId,
            status: "cancelled",
            message: "Task cancelled by user",
            timestamp: Date.now(),
          });

          return Response.json({ success: true, taskId, cancelled }, { headers: CORS_HEADERS });
        }

        // Save auth session for provider
        if (path === "/api/auth/session" && method === "POST") {
          let body: { provider?: string; authJson?: string; userId?: string };
          try {
            body = (await req.json()) as { provider?: string; authJson?: string; userId?: string };
          } catch {
            return Response.json({ error: "Invalid JSON body" }, { status: 400, headers: CORS_HEADERS });
          }

          if (body.provider !== "codex" && body.provider !== "claude") {
            return Response.json(
              { error: "Provider must be either 'codex' or 'claude'" },
              { status: 400, headers: CORS_HEADERS },
            );
          }

          if (!body.authJson || typeof body.authJson !== "string" || !body.authJson.trim()) {
            return Response.json(
              { error: "authJson must be a non-empty string" },
              { status: 400, headers: CORS_HEADERS },
            );
          }

          await repo.saveAuthSession(body.provider as AgentProvider, body.authJson, body.userId ?? "default");
          return Response.json({ success: true, provider: body.provider }, { headers: CORS_HEADERS });
        }

        // Check if auth session is configured
        const authCheckMatch = path.match(/^\/api\/auth\/session\/([^/]+)$/);
        if (authCheckMatch && method === "GET") {
          const provider = authCheckMatch[1];
          if (provider !== "codex" && provider !== "claude") {
            return Response.json(
              { error: "Provider must be either 'codex' or 'claude'" },
              { status: 400, headers: CORS_HEADERS },
            );
          }

          const hasDbSession = await repo.hasAuthSession(provider as AgentProvider);
          const hasEnvSession =
            provider === "codex"
              ? Boolean(process.env.CODEX_AUTH_JSON || process.env.OPENAI_API_KEY)
              : Boolean(process.env.CLAUDE_AUTH_JSON || process.env.ANTHROPIC_API_KEY);

          return Response.json(
            { provider, configured: hasDbSession || hasEnvSession },
            { headers: CORS_HEADERS },
          );
        }

        // GitHub webhook receiver
        if (path === "/api/webhooks/github" && method === "POST") {
          const rawBody = await req.text();
          const event = req.headers.get("x-github-event") || "unknown";
          const signature = req.headers.get("x-hub-signature-256") || undefined;
          const secret = process.env.GITHUB_WEBHOOK_SECRET;

          // If secret is set, verify HMAC before consuming rate limit bucket
          if (secret) {
            if (!signature) {
              return Response.json(
                { error: "Missing x-hub-signature-256 header" },
                { status: 401, headers: CORS_HEADERS },
              );
            }
            const isValid = await verify(secret, rawBody, signature);
            if (!isValid) {
              return Response.json(
                { error: "Invalid x-hub-signature-256 signature" },
                { status: 401, headers: CORS_HEADERS },
              );
            }
          }

          const clientIp = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "github";
          const limitCheck = webhookLimiter.check(clientIp);
          if (!limitCheck.allowed) {
            return Response.json(
              { error: "Too many webhook requests. Please try again later." },
              {
                status: 429,
                headers: {
                  ...CORS_HEADERS,
                  "Retry-After": String(Math.ceil(Math.max(0, limitCheck.resetAtMs - Date.now()) / 1000)),
                },
              },
            );
          }

          try {
            const result = await handleGitHubWebhook({
              event,
              signature,
              rawBody,
              secret,
              repository: repo,
              taskQueue: queue,
              tokenManager,
            });
            return Response.json(result, { headers: CORS_HEADERS });
          } catch (err: unknown) {
            const errMsg = err instanceof Error ? err.message : String(err);
            if (errMsg.includes("Invalid x-hub-signature-256") || errMsg.includes("Missing x-hub-signature-256")) {
              return Response.json({ error: errMsg }, { status: 401, headers: CORS_HEADERS });
            }
            return Response.json({ error: errMsg }, { status: 400, headers: CORS_HEADERS });
          }
        }

        // GitHub App status
        if (path === "/api/github/status" && method === "GET") {
          return Response.json(
            {
              configured: tokenManager?.isConfigured() ?? false,
              appId: tokenManager?.getAppId(),
            },
            { headers: CORS_HEADERS },
          );
        }

        // List GitHub App installations
        if (path === "/api/github/installations" && method === "GET") {
          const installations = await repo.listInstallations();
          return Response.json({ installations }, { headers: CORS_HEADERS });
        }

        // List accessible GitHub repositories across installations
        if (path === "/api/github/repositories" && method === "GET") {
          const requestedInstallationId = url.searchParams.get("installationId");
          const installations = await repo.listInstallations();

          const targetInstallations = requestedInstallationId
            ? installations.filter((i) => i.id === parseInt(requestedInstallationId, 10))
            : installations;

          const repositories: Array<{
            id: number;
            owner: string;
            name: string;
            fullName: string;
            private: boolean;
            defaultBranch: string;
            htmlUrl: string;
            installationId: number;
          }> = [];

          if (tokenManager && tokenManager.isConfigured()) {
            for (const inst of targetInstallations) {
              try {
                const octokit = await tokenManager.getInstallationOctokit(inst.id);
                const repos = await octokit.paginate(octokit.rest.apps.listReposAccessibleToInstallation, {
                  per_page: 100,
                });
                for (const r of repos) {
                  repositories.push({
                    id: r.id,
                    owner: r.owner.login,
                    name: r.name,
                    fullName: r.full_name,
                    private: r.private,
                    defaultBranch: r.default_branch,
                    htmlUrl: r.html_url,
                    installationId: inst.id,
                  });
                }
              } catch (err) {
                console.warn(`[server] Failed to fetch repositories for installation ${inst.id}:`, err);
              }
            }
          }


          return Response.json({ repositories }, { headers: CORS_HEADERS });
        }

        return new Response("Not Found", { status: 404, headers: CORS_HEADERS });

      } catch (err) {
        console.error("[server] Request handling error:", err);
        return Response.json(
          { error: "Internal server error", details: String(err) },
          { status: 500, headers: CORS_HEADERS },
        );
      }
    },
  });

  return server;
}
