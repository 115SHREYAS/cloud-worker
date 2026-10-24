# syntax=docker/dockerfile:1
# Production image for the Bun control plane (apps/server).
# Build from the repository root so pnpm workspace dependencies resolve.
FROM node:20-slim

# bun is the server runtime; git is needed for repo tooling
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates git \
  && curl -fsSL https://bun.sh/install | bash \
  && mv /root/.bun/bin/bun /usr/local/bin/bun \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY . .

# corepack reads the packageManager field (pnpm@11) from package.json
RUN corepack enable && pnpm install --frozen-lockfile

ENV NODE_ENV=production

WORKDIR /app/apps/server

# Render injects PORT; env.ts reads it (default 3001)
CMD ["bun", "index.ts"]
