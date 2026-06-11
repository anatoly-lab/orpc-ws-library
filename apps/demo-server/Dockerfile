# Multi-stage build for @demo/server (NestJS).
#
# Built from the REPO ROOT (the build context is the monorepo) so
# `turbo prune` can see every workspace. Build with:
#   docker build -f apps/demo-server/Dockerfile -t orpc-ws-e2e/server .
#
# Uses npm workspaces (this repo's package manager — there is no pnpm)
# and `turbo prune --docker`, which emits:
#   out/json  → just the package.json files (for a cache-friendly install)
#   out/full  → the pruned source tree
#   out/package-lock.json → the pruned lockfile (npm)

# ── base ──────────────────────────────────────────────────────────────
FROM node:22-alpine AS base
RUN npm i -g turbo@2
WORKDIR /app

# ── pruner ────────────────────────────────────────────────────────────
# Prune the monorepo down to @demo/server and its workspace deps.
FROM base AS pruner
COPY . .
RUN turbo prune @demo/server --docker

# ── builder ───────────────────────────────────────────────────────────
# Install (incl. devDeps for the build) then build @demo/server and its
# workspace dependencies (tshy dual-builds the library cores).
FROM base AS builder

# package.jsons + lockfile first, for a cache-friendly install layer.
COPY --from=pruner /app/out/json/ .
RUN npm ci

# Now the pruned source and build.
COPY --from=pruner /app/out/full/ .
RUN npx turbo run build --filter=@demo/server

# ── runner ────────────────────────────────────────────────────────────
# Minimal runtime: the whole built workspace + installed node_modules.
# The demo-server entry is dist/main.js (plain `tsc` → ./dist, see its
# tsconfig outDir).
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
# Containers must bind all interfaces so the published port is reachable.
ENV HOST=0.0.0.0

# Bring over the fully built + installed workspace. node_modules holds
# the hoisted runtime deps; the workspace symlinks resolve to the built
# packages under packages/ and apps/.
COPY --from=builder /app/ .

WORKDIR /app/apps/demo-server
EXPOSE 18081
CMD ["node", "dist/main.js"]
