# syntax=docker/dockerfile:1
# Production image for the Bun control plane (apps/server).
# Build from the repository root so pnpm workspace dependencies resolve.
# Node 22: pnpm 11 requires it (fails on Node 20 with ERR_UNKNOWN_BUILTIN_MODULE)
FROM node:22-slim

WORKDIR /app

# bun is the server runtime (node stays for corepack/pnpm and the agent CLIs)
RUN npm install -g bun

# Agent harness CLIs: the browser/device login flows spawn these on the server
RUN npm install -g @openai/codex @anthropic-ai/claude-code

COPY . .

# corepack reads the packageManager field (pnpm@11) from package.json
RUN corepack enable && pnpm install --frozen-lockfile

ENV NODE_ENV=production

WORKDIR /app/apps/server

# Render injects PORT; env.ts reads it (default 3001)
CMD ["bun", "index.ts"]
