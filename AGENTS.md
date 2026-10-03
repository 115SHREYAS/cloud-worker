# AGENTS.md — Cloud Worker Engineering Guide

This document defines architecture, workflows, and rules for AI coding agents operating on the `cloud-worker` codebase.

---

## 1. Project Overview & Philosophy

**Cloud Worker** is an autonomous cloud coding agent platform. It provisions isolated Firecracker microVM sandboxes (via E2B) to execute coding tasks on user repositories.

### Key Architectural Differentiators
1. **In-VM Subscription Harness**: Instead of expensive per-token raw LLM API calls, Cloud Worker executes official CLI harnesses (`@openai/codex` and `@anthropic-ai/claude-code`) inside the microVM. It injects user subscription tokens (ChatGPT Plus/Pro/Team, Claude Pro/Team/Max) so tasks run under monthly quotas with sub-millisecond local NVMe filesystem and bash access.
2. **Multi-Turn Warm Sandboxes**: MicroVMs remain warm in memory for up to 10 minutes after a turn completes. Users can send follow-up instructions or queue prompts during active execution.
3. **Session Continuation & Prompt Caching**: Follow-up turns resume the existing CLI session (`claude -c -p` and `codex exec resume --last`), preserving context and triggering Anthropic/OpenAI prompt prefix caching for faster responses and lower token cost.
4. **Zero-Config Resilient Fallbacks**: Every infrastructure service falls back automatically:
   - PostgreSQL → In-memory task repository.
   - Redis Pub/Sub & BullMQ → In-memory event bus and DirectTaskQueue.
   - GitHub App → Demo mode or personal access token fallback.

---

## 2. Monorepo Layout

This repository uses **pnpm workspaces** and **Turborepo**:

```
cloud-worker/
├── apps/
│   ├── server/             # Bun-powered control plane backend (Port 3001)
│   │   ├── index.ts        # Server entry point & graceful shutdown
│   │   └── src/
│   │       ├── auth/       # Provider auth relay & host token detection
│   │       ├── config/     # Environment parsing & validation (Zod)
│   │       ├── db/         # Drizzle ORM schema & repository (Postgres + Memory)
│   │       ├── events/     # Real-time event bus (Redis + Memory fallback)
│   │       ├── github/     # GitHub App token manager, webhooks, PR generator
│   │       ├── queue/      # Multi-turn task worker, queue, sandbox scavenger
│   │       ├── security/   # Rate limiters, HMAC verifier, session cookies
│   │       └── server.ts   # Bun HTTP routes & SSE streaming (/api/tasks/:id/stream)
│   └── web/                # Next.js 16 (App Router + Turbopack) dashboard (Port 3000)
│       └── src/
│           ├── app/        # Pages: /, /login, /onboarding
│           ├── components/ # TaskWorkspace, TerminalView, DiffViewer, AgentTimeline
│           ├── hooks/      # useTaskStream (SSE parser & live buffer)
│           └── lib/        # API client bindings
├── packages/
│   ├── sandbox/            # E2B v2 Sandbox lifecycle manager & AgentSession
│   │   └── src/
│   │       ├── agent-session.ts  # In-VM CLI harness runner (Codex / Claude)
│   │       ├── init-workspace.ts # MicroVM initialization, firewall, git setup
│   │       └── sandbox.ts        # E2B Sandbox wrapper (exec, files, timeout)
│   └── shared/             # Domain contracts, Zod schemas, stream events
│       └── src/
│           ├── events.ts   # StreamEvent discriminated union schemas
│           ├── github.ts   # GitHub installation & pull request schemas
│           ├── task.ts     # Task, TaskStatus, TaskRecord domain schemas
│           └── tools.ts    # Agent tool definitions
└── design-files/           # System diagrams, specifications, roadmap
```

---

## 3. Development Workflow & Commands

### Prerequisites
- **Node.js** v20+ and **pnpm** v11+
- **Bun** v1.2+ (backend runtime and test runner)
- **Docker** (optional, for local Postgres and Redis)

### Core Commands

| Task | Command | Scope |
| :--- | :--- | :--- |
| Install dependencies | `pnpm install` | Root |
| Start all dev services | `pnpm dev` | Root (Turborepo) |
| Start backend control plane | `pnpm dev:server` or `bun --watch index.ts` | `apps/server` |
| Start frontend web dashboard | `pnpm dev:web` or `next dev` | `apps/web` |
| Typecheck entire monorepo | `pnpm typecheck` or `bun x tsc --noEmit` | Root / Packages |
| Build frontend for production | `pnpm --filter web build` | `apps/web` |
| Start local Postgres & Redis | `pnpm docker:up` | Root |
| Stop local containers | `pnpm docker:down` | Root |
| Push database schema changes | `pnpm db:push` | `apps/server` |

### Running Tests

```bash
# Domain contracts & schema unit tests
bun test packages/shared/src/contracts.test.ts

# Control plane server integration test (Health, REST, SSE, Multi-turn queue)
bun apps/server/src/test-server.ts

# Auth relay & onboarding verification
bun apps/server/src/test-auth-onboarding.ts

# GitHub App token & webhook verification
bun apps/server/src/test-github.ts

# Security, timeout, & rate limiting tests
bun apps/server/src/test-security.ts
```

---

## 4. Architectural Rules for Agents

### 1. In-VM Execution Invariant
Never execute code-editing tasks via server-side direct LLM API calls. All code generation, bash testing, and file operations MUST run inside the E2B microVM through `AgentSession`.

### 2. Multi-Turn Lifecycle & E2B Limits
- **Hard 1-Hour Cap**: E2B microVMs have an absolute 1-hour lifetime limit. The worker enforces a **55-minute ceiling** (`maxSessionDurationMs = 3,300,000 ms`). Check remaining time before every turn and warm idle wait.
- **10-Minute Warm Window**: After a turn completes with exit code 0, transition task to `"waiting_input"` and set `warmExpiresAt = now + 10m`.
- **Prompt Queueing**: If a user submits a follow-up prompt while a turn is running, store it in `pendingPrompts` and dispatch it immediately when the turn finishes. If submitted while `"waiting_input"`, wake the waiting worker immediately.

### 3. Session Continuation & Prompt Caching
When `turn > 1`, always pass `isContinue: true` to `AgentSession.run`:
- **Claude Code**: Runs `claude -c -p "<prompt>"` to continue the conversation in `/workspace`. Automatically hits Anthropic prompt caching on prior context.
- **OpenAI Codex**: Runs `codex exec resume --last -- "<prompt>"`.
- **Fallback**: If resuming fails (e.g. session metadata corrupted), catch the error and fall back gracefully to a fresh invocation.

### 4. Git Operations & Commits
- **Working Branch**: Preserve `task.workingBranch` across all turns. Never run `git checkout -B` if already on the working branch (check `git rev-parse --abbrev-ref HEAD`).
- **Safe Staged Commits**: Never write commit messages to fixed disk paths in `/tmp`. Pipe base64 directly to git:
  ```bash
  echo "<base64_message>" | base64 -d | git commit -F -
  ```
  Fallback to `git commit -m "<sanitized_title>"` if the pipe exits non-zero.
- **Pull Requests**: Create the PR on Turn 1. On subsequent turns, `git push origin <workingBranch>` automatically updates the existing open PR. Do not open duplicate PRs.

### 5. Domain Contracts First
Always update types and Zod schemas in `packages/shared` first before touching `apps/server` or `apps/web`. Run `bun test` in `packages/shared` to confirm discriminated union parsing and backwards compatibility.

---

## 5. Coding & Writing Standards

- **Tone & Style**: Plain language, active voice, direct phrasing. Avoid puffery, decorative filler, buzzwords, and superficial `-ing` clauses.
- **Commit Messages**: Single-line conventional commit format:
  ```
  feat(queue): support multi-turn session continuation in warm sandbox
  fix(worker): pipe base64 commit message to avoid tmp permission collisions
  ```
- **Links**: In chat responses and artifacts, link file and symbol references using Markdown links with the `file:///` scheme (e.g., [`task-worker.ts`](file:///E:/personal%20projects/cloud-worker/apps/server/src/queue/task-worker.ts)).
- **UI Design**: Maintain dark-mode palette (`#08090d` background, `#0b0c10` panels, `#12131b` elevated cards, zinc borders). Keep the follow-up composer centered in a max-width command dock with integrated status and queue chips.
