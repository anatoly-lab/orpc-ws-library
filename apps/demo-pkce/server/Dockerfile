# Multi-stage build for @demo/pkce-server (NestJS).
#
# Built from the REPO ROOT (the build context is the monorepo) so
# `turbo prune` can see every workspace. Build with:
#   docker build -f apps/demo-pkce/server/Dockerfile -t orpc-ws-e2e/server .
#
# Uses pnpm workspaces and `turbo prune --docker`, which emits:
#   out/json  → package.json files + pnpm-workspace.yaml (cache-friendly install)
#   out/full  → the pruned source tree
#   out/pnpm-lock.yaml → the pruned lockfile (pnpm)

# ── base ──────────────────────────────────────────────────────────────
FROM node:22.22-alpine AS base
# corepack provisions the pnpm version pinned in package.json "packageManager".
# Alpine's bundled corepack predates the npm signing-key rotation and fails
# "Cannot find matching keyid" on recent pnpm releases — update it first.
RUN npm i -g corepack@latest && corepack enable
RUN npm i -g turbo@2
WORKDIR /app

# ── pruner ────────────────────────────────────────────────────────────
# Prune the monorepo down to @demo/pkce-server and its workspace deps.
FROM base AS pruner
COPY . .
RUN turbo prune @demo/pkce-server --docker

# ── builder ───────────────────────────────────────────────────────────
# Install (incl. devDeps for the build) then build @demo/pkce-server and its
# workspace dependencies (tshy dual-builds the library cores).
FROM base AS builder

# package.jsons + lockfile first, for a cache-friendly install layer. turbo prune
# carries the pruned pnpm-workspace.yaml (incl. linkWorkspacePackages, which links
# the local cores by version) into out/json.
COPY --from=pruner /app/out/json/ .
RUN pnpm install --frozen-lockfile

# Now the pruned source and build.
COPY --from=pruner /app/out/full/ .
RUN turbo run build --filter=@demo/pkce-server

# ── runner ────────────────────────────────────────────────────────────
# Minimal runtime: the whole built workspace + installed node_modules.
# The server entry is dist/main.js (plain `tsc` → ./dist, see its tsconfig
# outDir). Only the PKCE mode is containerized for e2e — the backend-token /
# cookie-bff servers are dev-only.
FROM node:22.22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
# Containers must bind all interfaces so the published port is reachable.
ENV HOST=0.0.0.0

# Bring over the fully built + installed workspace. node_modules holds
# the hoisted runtime deps; the workspace symlinks resolve to the built
# packages under packages/ and apps/.
COPY --from=builder /app/ .

WORKDIR /app/apps/demo-pkce/server
EXPOSE 18081
CMD ["node", "dist/main.js"]
