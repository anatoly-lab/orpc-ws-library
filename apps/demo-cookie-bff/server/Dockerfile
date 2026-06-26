# Multi-stage build for @demo/cookie-bff-server (NestJS, cookie-BFF mode).
#
# Built from the REPO ROOT (the build context is the monorepo) so
# `turbo prune` can see every workspace. Build with:
#   docker build -f apps/demo-cookie-bff/server/Dockerfile -t orpc-ws-e2e/server .
#
# Uses pnpm workspaces and `turbo prune --docker`, which emits:
#   out/json  → package.json files + pnpm-workspace.yaml (cache-friendly install)
#   out/full  → the pruned source tree
#   out/pnpm-lock.yaml → the pruned lockfile (pnpm)
#
# This is the cookie-BFF server: it runs the OIDC flow server-side, holds all
# tokens in a session store, and authenticates the WS handshake from an httpOnly
# `sid` cookie (no `?token=`). Unlike the old PKCE server it takes NO VITE-style
# build args — all its config is read from env at RUNTIME (see containers.ts for
# the full env set: OIDC issuer/discovery/client, SPA origin, callback URI,
# session encryption key).

# ── base ──────────────────────────────────────────────────────────────
FROM node:22.22-alpine AS base
# corepack provisions the pnpm version pinned in package.json "packageManager".
# Alpine's bundled corepack predates the npm signing-key rotation and fails
# "Cannot find matching keyid" on recent pnpm releases — update it first.
RUN npm i -g corepack@latest && corepack enable
RUN npm i -g turbo@2
WORKDIR /app

# ── pruner ────────────────────────────────────────────────────────────
# Prune the monorepo down to @demo/cookie-bff-server and its workspace deps.
FROM base AS pruner
COPY . .
RUN turbo prune @demo/cookie-bff-server --docker

# ── builder ───────────────────────────────────────────────────────────
# Install (incl. devDeps for the build) then build @demo/cookie-bff-server and
# its workspace dependencies (tshy dual-builds the library cores).
FROM base AS builder

# package.jsons + lockfile first, for a cache-friendly install layer. turbo prune
# carries the pruned pnpm-workspace.yaml (incl. linkWorkspacePackages, which links
# the local cores by version) into out/json.
COPY --from=pruner /app/out/json/ .
RUN pnpm install --frozen-lockfile

# Now the pruned source and build.
COPY --from=pruner /app/out/full/ .
RUN turbo run build --filter=@demo/cookie-bff-server

# ── runner ────────────────────────────────────────────────────────────
# Minimal runtime: the whole built workspace + installed node_modules.
# The server entry is dist/main.js (plain `tsc` → ./dist, see its tsconfig
# outDir).
FROM node:22.22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
# Containers must bind all interfaces so the published port is reachable.
ENV HOST=0.0.0.0

# Bring over the fully built + installed workspace. node_modules holds
# the hoisted runtime deps; the workspace symlinks resolve to the built
# packages under packages/ and apps/.
COPY --from=builder /app/ .

WORKDIR /app/apps/demo-cookie-bff/server
EXPOSE 18083
CMD ["node", "dist/main.js"]
