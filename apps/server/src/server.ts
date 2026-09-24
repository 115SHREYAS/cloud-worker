import {
  CreateTaskInputSchema,
  SaveCredentialsInputSchema,
  UpdateOnboardingInputSchema,
  AVAILABLE_MODELS,
  type StreamEvent,
  type GitHubInstallation,
} from "@cloud-worker/shared";
import type { AgentProvider } from "@cloud-worker/sandbox";
import type { TaskRepository } from "./db/repository.ts";
import type { EventBus } from "./events/event-bus.ts";
import type { TaskQueue } from "./queue/task-queue.ts";
import type { GitHubTokenManager } from "./github/token-manager.ts";
import { handleGitHubWebhook, syncGitHubInstallations, extractAccountInfo } from "./github/index.ts";
import { verify } from "@octokit/webhooks-methods";
import { RateLimiter } from "./security/rate-limiter.ts";
import {
  createSessionToken,
  verifySessionToken,
  parseCookies,
  createSessionCookie,
  createLogoutCookie,
  type SessionPayload,
} from "./security/session.ts";
import { providerAuthRelay } from "./auth/provider-auth-relay.ts";

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
  "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Cookie",
  "Access-Control-Allow-Credentials": "true",
};

function getCurrentUserSession(req: Request): SessionPayload | null {
  const authHeader = req.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7).trim();
    return verifySessionToken(token);
  }
  const cookieHeader = req.headers.get("cookie");
  const cookies = parseCookies(cookieHeader);
  if (cookies.cw_session) {
    return verifySessionToken(cookies.cw_session);
  }
  return null;
}

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
        const session = getCurrentUserSession(req);

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

        // List tasks (user-scoped if authenticated)
        if (path === "/api/tasks" && method === "GET") {
          const limitParam = url.searchParams.get("limit");
          const parsedLimit = limitParam ? parseInt(limitParam, 10) : 50;
          const limit = Number.isNaN(parsedLimit) ? 50 : Math.min(Math.max(1, parsedLimit), 100);
          const tasks = await repo.listTasks(limit, session?.sub);
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

          const task = await repo.createTask(taskId, input, workingBranch, session?.sub);
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

          if (task.userId && session && session.sub !== task.userId) {
            return Response.json({ error: "Unauthorized access to task stream" }, { status: 403, headers: CORS_HEADERS });
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
                  // Client disconnected
                }
              };

              const liveBuffer: StreamEvent[] = [];
              let isReplaying = true;

              // Subscribe to live events immediately to prevent event loss
              unsubscribe = eventBus.subscribe(taskId, (event) => {
                if (isReplaying) {
                  liveBuffer.push(event);
                } else {
                  sendEvent(event);
                }
              });

              // Replay historical logs
              const logs = await repo.getLogs(taskId);

              if (isCancelled) {
                if (unsubscribe) unsubscribe();
                return;
              }

              for (const log of logs) {
                sendEvent(log);
              }

              // Replay buffered live events that arrived during the DB fetch
              isReplaying = false;
              for (const liveEvent of liveBuffer) {
                sendEvent(liveEvent);
              }

              if (isCancelled) {
                if (unsubscribe) unsubscribe();
                return;
              }

              // Keepalive ping every 15 seconds
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

          if (task.userId && session && session.sub !== task.userId) {
            return Response.json({ error: "Unauthorized access to task" }, { status: 403, headers: CORS_HEADERS });
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

        // GitHub OAuth initiation
        if (path === "/api/auth/github" && method === "GET") {
          const clientId = process.env.GITHUB_CLIENT_ID;
          if (!clientId) {
            return Response.json(
              {
                configured: false,
                message: "GITHUB_CLIENT_ID not configured. Set GITHUB_CLIENT_ID in .env or use guest login.",
                authUrl: "/login?demo=true",
              },
              { headers: CORS_HEADERS },
            );
          }

          const state = Math.random().toString(36).slice(2) + Date.now().toString(36);
          const forwardedHost = req.headers.get("x-forwarded-host");
          const forwardedProto = req.headers.get("x-forwarded-proto") || "http";
          const clientOrigin = forwardedHost
            ? `${forwardedProto}://${forwardedHost}`
            : (url.port === "3001" ? "http://localhost:3000" : url.origin);
          const redirectUri = `${clientOrigin}/api/auth/callback/github`;
          const githubAuthUrl = `https://github.com/login/oauth/authorize?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=read:user,user:email&state=${state}`;

          return new Response(null, {
            status: 302,
            headers: {
              ...CORS_HEADERS,
              Location: githubAuthUrl,
            },
          });
        }

        // GitHub OAuth callback
        if (path === "/api/auth/callback/github" && method === "GET") {
          const code = url.searchParams.get("code");
          const clientId = process.env.GITHUB_CLIENT_ID;
          const clientSecret = process.env.GITHUB_CLIENT_SECRET;
          const forwardedHost = req.headers.get("x-forwarded-host");
          const forwardedProto = req.headers.get("x-forwarded-proto") || "http";
          const clientOrigin = forwardedHost
            ? `${forwardedProto}://${forwardedHost}`
            : (url.port === "3001" ? "http://localhost:3000" : url.origin);

          if (!code || !clientId || !clientSecret) {
            return Response.redirect(`${clientOrigin}/login?error=missing_oauth_code`, 302);
          }

          try {
            const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
              method: "POST",
              headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                client_id: clientId,
                client_secret: clientSecret,
                code,
              }),
            });
            const tokenData = (await tokenRes.json()) as { access_token?: string; error?: string };
            if (!tokenData.access_token) {
              return Response.redirect(`${clientOrigin}/login?error=${tokenData.error || "oauth_failed"}`, 302);
            }

            const userRes = await fetch("https://api.github.com/user", {
              headers: {
                Authorization: `Bearer ${tokenData.access_token}`,
                "User-Agent": "Cloud-Worker",
              },
            });
            const ghUser = (await userRes.json()) as { id: number; login: string; avatar_url: string; email?: string };

            let primaryEmail = ghUser.email;
            if (!primaryEmail) {
              try {
                const emailsRes = await fetch("https://api.github.com/user/emails", {
                  headers: {
                    Authorization: `Bearer ${tokenData.access_token}`,
                    "User-Agent": "Cloud-Worker",
                  },
                });
                const emails = (await emailsRes.json()) as Array<{ email: string; primary: boolean; verified: boolean }>;
                primaryEmail = emails.find((e) => e.primary && e.verified)?.email || emails[0]?.email;
              } catch {
                // Ignore email fetch failure
              }
            }

            const email = primaryEmail || `${ghUser.login}@users.noreply.github.com`;
            const userId = `usr_${ghUser.id}`;

            const existingUser = await repo.getUserByGitHubId(ghUser.id);
            const user = await repo.upsertUser({
              id: existingUser ? existingUser.id : userId,
              githubId: ghUser.id,
              username: ghUser.login,
              email,
              avatarUrl: ghUser.avatar_url,
              defaultModel: existingUser?.defaultModel || "codex",
              defaultAuthMode: existingUser?.defaultAuthMode || "subscription",
              onboardingCompleted: existingUser?.onboardingCompleted ?? false,
            });

            // Link existing installations belonging to this GitHub username
            let allInstalls = await repo.listInstallations();
            if (allInstalls.length === 0 && tokenManager && tokenManager.isConfigured()) {
              allInstalls = await syncGitHubInstallations(repo, tokenManager, user.id);
            }
            for (const inst of allInstalls) {
              if (
                inst.accountLogin.toLowerCase() === ghUser.login.toLowerCase() ||
                allInstalls.length === 1
              ) {
                await repo.linkUserInstallation(user.id, inst.id);
              }
            }

            // Auto-import local host credentials for this user if available
            try {
              const detected = await providerAuthRelay.detectLocalCredentials();
              for (const d of detected) {
                if (d.available) {
                  await providerAuthRelay.importLocalCredentials(repo, d.provider, user.id);
                }
              }
            } catch {
              // Ignore
            }

            const sessionToken = createSessionToken({
              sub: user.id,
              username: user.username,
              email: user.email,
              avatarUrl: user.avatarUrl,
            });

            const targetPath = user.onboardingCompleted ? "/" : "/onboarding";
            return new Response(null, {
              status: 302,
              headers: {
                ...CORS_HEADERS,
                Location: `${clientOrigin}${targetPath}`,
                "Set-Cookie": createSessionCookie(sessionToken),
              },
            });
          } catch (oauthErr) {
            console.error("[server] OAuth callback error:", oauthErr);
            return Response.redirect(`${clientOrigin}/login?error=oauth_internal_error`, 302);
          }
        }

        // Local development/guest login
        if (path === "/api/auth/dev-login" && method === "POST") {
          let body: { username?: string; email?: string } = {};
          try {
            body = (await req.json()) as { username?: string; email?: string };
          } catch {
            // Default payload
          }

          const username = body.username?.trim() || "developer";
          const email = body.email?.trim() || `${username}@cloudworker.local`;
          const githubId = Math.abs(username.split("").reduce((acc, c) => (acc << 5) - acc + c.charCodeAt(0), 0)) || 10001;
          const avatarUrl = `https://avatars.githubusercontent.com/u/${githubId}?v=4`;

          const existingUser = await repo.getUserByGitHubId(githubId);
          const user = await repo.upsertUser({
            id: existingUser ? existingUser.id : `usr_${githubId}`,
            githubId,
            username,
            email,
            avatarUrl,
            defaultModel: existingUser?.defaultModel || "codex",
            defaultAuthMode: existingUser?.defaultAuthMode || "subscription",
            onboardingCompleted: existingUser?.onboardingCompleted ?? false,
          });

          let allInstalls = await repo.listInstallations();
          if (allInstalls.length === 0 && tokenManager && tokenManager.isConfigured()) {
            allInstalls = await syncGitHubInstallations(repo, tokenManager, user.id);
          }
          for (const inst of allInstalls) {
            await repo.linkUserInstallation(user.id, inst.id);
          }

          // Auto-import local host credentials for this dev user if available
          try {
            const detected = await providerAuthRelay.detectLocalCredentials();
            for (const d of detected) {
              if (d.available) {
                await providerAuthRelay.importLocalCredentials(repo, d.provider, user.id);
              }
            }
          } catch {
            // Ignore
          }

          const sessionToken = createSessionToken({
            sub: user.id,
            username: user.username,
            email: user.email,
            avatarUrl: user.avatarUrl,
          });

          return Response.json(
            { ok: true, user, token: sessionToken },
            {
              headers: {
                ...CORS_HEADERS,
                "Set-Cookie": createSessionCookie(sessionToken),
              },
            },
          );
        }

        // Current user session check
        if (path === "/api/auth/me" && method === "GET") {
          if (!session) {
            return Response.json({ user: null }, { headers: CORS_HEADERS });
          }
          let user = await repo.getUser(session.sub);
          if (!user) {
            // Restore user in-memory record if server was restarted with active JWT cookie
            const githubId =
              Math.abs(
                session.username.split("").reduce((acc, c) => (acc << 5) - acc + c.charCodeAt(0), 0),
              ) || 10001;
            user = await repo.upsertUser({
              id: session.sub,
              githubId,
              username: session.username,
              email: session.email,
              avatarUrl: session.avatarUrl,
              defaultModel: "codex",
              defaultAuthMode: "subscription",
              onboardingCompleted: false,
            });
          }
          return Response.json({ user }, { headers: CORS_HEADERS });
        }

        // Logout
        if (path === "/api/auth/logout" && method === "POST") {
          return Response.json(
            { ok: true },
            {
              headers: {
                ...CORS_HEADERS,
                "Set-Cookie": createLogoutCookie(),
              },
            },
          );
        }

        // User settings & connected providers
        if (path === "/api/user/settings" && method === "GET") {
          if (!session) {
            return Response.json({ error: "Unauthorized" }, { status: 401, headers: CORS_HEADERS });
          }
          const user = await repo.getUser(session.sub);
          if (!user) {
            return Response.json({ error: "User not found" }, { status: 404, headers: CORS_HEADERS });
          }
          const configuredProviders = await repo.listAuthSessions(user.id);
          const userInstalls = await repo.listUserInstallations(user.id);

          return Response.json(
            {
              user,
              configuredProviders,
              linkedInstallationsCount: userInstalls.length,
            },
            { headers: CORS_HEADERS },
          );
        }

        // Save user agent credentials (subscription JSON or API key)
        if (path === "/api/user/credentials" && method === "POST") {
          if (!session) {
            return Response.json({ error: "Unauthorized" }, { status: 401, headers: CORS_HEADERS });
          }

          let body: unknown;
          try {
            body = await req.json();
          } catch {
            return Response.json({ error: "Invalid JSON body" }, { status: 400, headers: CORS_HEADERS });
          }

          const parsed = SaveCredentialsInputSchema.safeParse(body);
          if (!parsed.success) {
            return Response.json(
              { error: "Validation failed", details: parsed.error.format() },
              { status: 400, headers: CORS_HEADERS },
            );
          }

          const { provider, authMode, credential } = parsed.data;
          await repo.saveAuthSession(provider, credential, session.sub, authMode);
          await repo.updateUser(session.sub, {
            defaultModel: provider,
            defaultAuthMode: authMode,
          });

          return Response.json({ ok: true, provider, authMode }, { headers: CORS_HEADERS });
        }

        // Detect local host credentials for Claude Code or Codex
        if (path === "/api/auth/provider/detect" && method === "GET") {
          try {
            const detected = await providerAuthRelay.detectLocalCredentials();
            return Response.json({ detected }, { headers: CORS_HEADERS });
          } catch (err) {
            console.error("[server] Failed to detect local credentials:", err);
            return Response.json({ detected: [] }, { headers: CORS_HEADERS });
          }
        }

        // Import detected local credentials directly into user account
        if (path === "/api/auth/provider/import-local" && method === "POST") {
          let body: { provider?: string } = {};
          try {
            body = (await req.json()) as { provider?: string };
          } catch {
            return Response.json({ error: "Invalid JSON body" }, { status: 400, headers: CORS_HEADERS });
          }

          if (body.provider !== "codex" && body.provider !== "claude") {
            return Response.json({ error: "Provider must be 'codex' or 'claude'" }, { status: 400, headers: CORS_HEADERS });
          }

          const targetUserId = session?.sub ?? "default";
          try {
            const result = await providerAuthRelay.importLocalCredentials(repo, body.provider as AgentProvider, targetUserId);
            return Response.json(result, { headers: CORS_HEADERS });
          } catch (err) {
            return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400, headers: CORS_HEADERS });
          }
        }

        // Start interactive device/browser OAuth login flow
        if (path === "/api/auth/provider/start-login" && method === "POST") {
          let body: { provider?: string } = {};
          try {
            body = (await req.json()) as { provider?: string };
          } catch {
            return Response.json({ error: "Invalid JSON body" }, { status: 400, headers: CORS_HEADERS });
          }

          if (body.provider !== "codex" && body.provider !== "claude") {
            return Response.json({ error: "Provider must be 'codex' or 'claude'" }, { status: 400, headers: CORS_HEADERS });
          }

          const targetUserId = session?.sub ?? "default";
          try {
            const flow = await providerAuthRelay.startLoginFlow(repo, body.provider as AgentProvider, targetUserId);
            return Response.json({ flow }, { headers: CORS_HEADERS });
          } catch (err) {
            return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500, headers: CORS_HEADERS });
          }
        }

        // Poll or check status of an interactive login flow
        const flowStatusMatch = path.match(/^\/api\/auth\/provider\/flow\/([^/]+)$/);
        if (flowStatusMatch && method === "GET") {
          const flowId = flowStatusMatch[1];
          if (!flowId) {
            return Response.json({ error: "flowId required" }, { status: 400, headers: CORS_HEADERS });
          }
          const flow = providerAuthRelay.getFlowStatus(flowId);
          if (!flow) {
            return Response.json({ error: "Flow not found" }, { status: 404, headers: CORS_HEADERS });
          }
          return Response.json({ flow }, { headers: CORS_HEADERS });
        }

        // Cancel an interactive login flow
        if (path === "/api/auth/provider/cancel-flow" && method === "POST") {
          let body: { flowId?: string } = {};
          try {
            body = (await req.json()) as { flowId?: string };
          } catch {}

          if (!body.flowId) {
            return Response.json({ error: "flowId required" }, { status: 400, headers: CORS_HEADERS });
          }

          const ok = providerAuthRelay.cancelFlow(body.flowId);
          return Response.json({ ok }, { headers: CORS_HEADERS });
        }

        // Update onboarding state
        if (path === "/api/user/onboarding" && method === "PATCH") {
          if (!session) {
            return Response.json({ error: "Unauthorized" }, { status: 401, headers: CORS_HEADERS });
          }

          let body: unknown;
          try {
            body = await req.json();
          } catch {
            return Response.json({ error: "Invalid JSON body" }, { status: 400, headers: CORS_HEADERS });
          }

          const parsed = UpdateOnboardingInputSchema.safeParse(body);
          if (!parsed.success) {
            return Response.json(
              { error: "Validation failed", details: parsed.error.format() },
              { status: 400, headers: CORS_HEADERS },
            );
          }

          const updatedUser = await repo.updateUser(session.sub, parsed.data);
          return Response.json({ ok: true, user: updatedUser }, { headers: CORS_HEADERS });
        }

        // Legacy / direct auth session route
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

          const targetUserId = session?.sub ?? body.userId ?? "default";
          await repo.saveAuthSession(body.provider as AgentProvider, body.authJson, targetUserId);
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

          const targetUserId = session?.sub ?? "default";
          const hasDbSession =
            (await repo.hasAuthSession(provider as AgentProvider, targetUserId)) ||
            (targetUserId !== "default" && (await repo.hasAuthSession(provider as AgentProvider, "default")));
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
          let appSlug = process.env.GITHUB_APP_SLUG;
          if (!appSlug && tokenManager && tokenManager.isConfigured()) {
            try {
              const octokit = tokenManager.getAppOctokit();
              const appData = await octokit.rest.apps.getAuthenticated();
              appSlug = appData?.data?.slug ?? undefined;
            } catch (err) {
              console.warn("[server] Failed to fetch app slug:", err);
            }
          }
          const resolvedSlug = appSlug || "cloud-worker-app";
          return Response.json(
            {
              configured: tokenManager?.isConfigured() ?? false,
              appId: tokenManager?.getAppId(),
              appSlug: resolvedSlug,
              installUrl: `https://github.com/apps/${resolvedSlug}/installations/new`,
            },
            { headers: CORS_HEADERS },
          );
        }

        // GitHub App setup redirect endpoint
        if (path === "/api/github/setup" && method === "GET") {
          const installationId = url.searchParams.get("installation_id");
          const setupAction = url.searchParams.get("setup_action");
          if (installationId) {
            const parsedId = parseInt(installationId, 10);
            if (!isNaN(parsedId)) {
              if (tokenManager && tokenManager.isConfigured()) {
                try {
                  const octokit = tokenManager.getAppOctokit();
                  const { data: inst } = await octokit.rest.apps.getInstallation({ installation_id: parsedId });
                  const accountInfo = extractAccountInfo(inst.account);
                  await repo.saveInstallation({
                    id: inst.id,
                    accountLogin: accountInfo.login,
                    accountType: accountInfo.type,
                    repositorySelection: (inst.repository_selection as "all" | "selected") || "all",
                    appSlug: process.env.GITHUB_APP_SLUG || "cloud-worker-app",
                    createdAt: inst.created_at,
                    updatedAt: inst.updated_at,
                  });
                } catch (err) {
                  console.warn(`[server] Failed to fetch installation ${parsedId} during setup redirect:`, err);
                }
              }
              if (session) {
                await repo.linkUserInstallation(session.sub, parsedId);
              }
            }
          }
          const redirectParams = new URLSearchParams();
          redirectParams.set("step", "2");
          if (installationId) redirectParams.set("installation_id", installationId);
          if (setupAction) redirectParams.set("setup_action", setupAction);
          const appUrl = process.env.APP_URL || "http://localhost:3000";
          return Response.redirect(`${appUrl}/onboarding?${redirectParams.toString()}`, 302);
        }

        // Link GitHub App installation to current user
        if (path === "/api/github/installations/link" && method === "POST") {
          if (!session) {
            return Response.json({ error: "Unauthorized" }, { status: 401, headers: CORS_HEADERS });
          }
          let body: { installationId?: number } = {};
          try {
            body = (await req.json()) as { installationId?: number };
          } catch {
            return Response.json({ error: "Invalid JSON" }, { status: 400, headers: CORS_HEADERS });
          }
          if (!body.installationId) {
            return Response.json({ error: "installationId required" }, { status: 400, headers: CORS_HEADERS });
          }

          if (tokenManager && tokenManager.isConfigured()) {
            try {
              const octokit = tokenManager.getAppOctokit();
              const { data: inst } = await octokit.rest.apps.getInstallation({ installation_id: body.installationId });
              const accountInfo = extractAccountInfo(inst.account);
              await repo.saveInstallation({
                id: inst.id,
                accountLogin: accountInfo.login,
                accountType: accountInfo.type,
                repositorySelection: (inst.repository_selection as "all" | "selected") || "all",
                appSlug: process.env.GITHUB_APP_SLUG || "cloud-worker-app",
                createdAt: inst.created_at,
                updatedAt: inst.updated_at,
              });
            } catch (err) {
              console.warn(`[server] Failed to fetch installation ${body.installationId} during link:`, err);
            }
          }

          await repo.linkUserInstallation(session.sub, body.installationId);
          return Response.json({ ok: true }, { headers: CORS_HEADERS });
        }

        // List GitHub App installations (user-scoped if logged in)
        if (path === "/api/github/installations" && method === "GET") {
          let installations = await repo.listInstallations();
          if (installations.length === 0 && tokenManager && tokenManager.isConfigured()) {
            installations = await syncGitHubInstallations(repo, tokenManager, session?.sub);
          }

          if (session) {
            let userInstalls = await repo.listUserInstallations(session.sub);
            if (userInstalls.length === 0 && installations.length > 0) {
              for (const inst of installations) {
                await repo.linkUserInstallation(session.sub, inst.id);
              }
              userInstalls = await repo.listUserInstallations(session.sub);
            }
            if (userInstalls.length > 0) {
              return Response.json({ installations: userInstalls }, { headers: CORS_HEADERS });
            }
          }
          return Response.json({ installations }, { headers: CORS_HEADERS });
        }

        // List accessible GitHub repositories across installations
        if (path === "/api/github/repositories" && method === "GET") {
          const requestedInstallationId = url.searchParams.get("installationId");
          let installations = session
            ? (await repo.listUserInstallations(session.sub)).length > 0
              ? await repo.listUserInstallations(session.sub)
              : await repo.listInstallations()
            : await repo.listInstallations();

          if (installations.length === 0 && tokenManager && tokenManager.isConfigured()) {
            await syncGitHubInstallations(repo, tokenManager, session?.sub);
            installations = session
              ? (await repo.listUserInstallations(session.sub)).length > 0
                ? await repo.listUserInstallations(session.sub)
                : await repo.listInstallations()
              : await repo.listInstallations();
          }

          let targetInstallations = requestedInstallationId
            ? installations.filter((i) => i.id === parseInt(requestedInstallationId, 10))
            : installations;

          // Direct GitHub API fallback if database is not yet populated
          if (targetInstallations.length === 0 && tokenManager && tokenManager.isConfigured()) {
            try {
              const octokit = tokenManager.getAppOctokit();
              const { data: ghInstalls } = await octokit.rest.apps.listInstallations();
              targetInstallations = ghInstalls.map((i) => {
                const accountInfo = extractAccountInfo(i.account);
                return {
                  id: i.id,
                  accountLogin: accountInfo.login,
                  accountType: accountInfo.type,
                  repositorySelection: (i.repository_selection as "all" | "selected") || "all",
                  appSlug: process.env.GITHUB_APP_SLUG || "cloud-worker-app",
                  createdAt: i.created_at,
                  updatedAt: i.updated_at,
                };
              });
              for (const inst of targetInstallations) {
                await repo.saveInstallation(inst);
                if (session) {
                  await repo.linkUserInstallation(session.sub, inst.id);
                }
              }
            } catch (err) {
              console.warn("[server] Fallback listInstallations failed:", err);
            }
          }

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

        // List real branches from GitHub for a repository
        if (path === "/api/github/branches" && method === "GET") {
          const owner = url.searchParams.get("owner");
          const repoName = url.searchParams.get("repo");
          const requestedInstallationId = url.searchParams.get("installationId");

          if (!owner || !repoName) {
            return Response.json(
              { error: "owner and repo parameters are required" },
              { status: 400, headers: CORS_HEADERS },
            );
          }

          let installationId = requestedInstallationId ? parseInt(requestedInstallationId, 10) : undefined;

          if (!installationId && session) {
            const userInstalls = await repo.listUserInstallations(session.sub);
            const matchingInst = userInstalls.find(
              (i) => i.accountLogin.toLowerCase() === owner.toLowerCase(),
            );
            if (matchingInst) {
              installationId = matchingInst.id;
            }
          }

          if (!installationId) {
            const allInstalls = await repo.listInstallations();
            const matchingInst = allInstalls.find(
              (i) => i.accountLogin.toLowerCase() === owner.toLowerCase(),
            );
            if (matchingInst) {
              installationId = matchingInst.id;
            }
          }

          if (tokenManager && tokenManager.isConfigured() && installationId) {
            try {
              const octokit = await tokenManager.getInstallationOctokit(installationId);
              const { data: ghBranches } = await octokit.rest.repos.listBranches({
                owner,
                repo: repoName,
                per_page: 100,
              });

              return Response.json(
                {
                  branches: ghBranches.map((b) => ({
                    name: b.name,
                    protected: b.protected,
                  })),
                },
                { headers: CORS_HEADERS },
              );
            } catch (branchErr) {
              console.warn(`[server] Failed to list branches for ${owner}/${repoName}:`, branchErr);
            }
          }

          return Response.json(
            {
              branches: [{ name: "main", protected: false }],
            },
            { headers: CORS_HEADERS },
          );
        }

        // List models filtered by agent harness
        if (path === "/api/models" && method === "GET") {
          const harness = url.searchParams.get("harness");
          const models = harness
            ? AVAILABLE_MODELS.filter((m) => m.provider === harness)
            : AVAILABLE_MODELS;
          return Response.json({ models }, { headers: CORS_HEADERS });
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
