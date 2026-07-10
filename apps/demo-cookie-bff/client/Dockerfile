# Multi-stage build for @demo/cookie-bff-client (Vite + React → static, nginx).
#
# Built from the REPO ROOT so `turbo prune` sees every workspace:
#   docker build -f apps/demo-cookie-bff/client/Dockerfile \
#     --build-arg VITE_WS_URL=... \
#     --build-arg VITE_SERVER_ORIGIN=... \
#     -t orpc-ws-e2e/spa .
#
# The VITE_* values are INLINED at `vite build` time (Vite env rules), so
# they are baked into the static bundle here — not read at container
# runtime. Re-target a different server origin by rebuilding with new args.
#
# DIFFERENCE from the old PKCE client: cookie-BFF holds NO token in the
# browser, so there is NO VITE_OIDC_* and NO VITE_UPLOAD_URL. The SPA only
# needs to know where the WS lives (VITE_WS_URL) and where the server's
# /auth/* endpoints are (VITE_SERVER_ORIGIN). The httpOnly `sid` cookie does
# the rest.

# ── base ──────────────────────────────────────────────────────────────
FROM node:22.22-alpine AS base
# corepack provisions the pnpm version pinned in package.json "packageManager".
# Alpine's bundled corepack predates the npm signing-key rotation and fails
# "Cannot find matching keyid" on recent pnpm releases — update it first.
RUN npm i -g corepack@latest && corepack enable
# Pin to the exact repo devDep version: `turbo prune` here rewrites turbo.json
# with the resolved config (futureFlags expanded), and the builder's local turbo
# (delegated to by the global shim) fails-closed on keys it doesn't know — an
# unpinned `turbo@2` skews the two the day a new 2.x ships.
RUN npm i -g turbo@2.10.4
WORKDIR /app

# ── pruner ────────────────────────────────────────────────────────────
FROM base AS pruner
COPY . .
RUN turbo prune @demo/cookie-bff-client --docker

# ── builder ───────────────────────────────────────────────────────────
FROM base AS builder

COPY --from=pruner /app/out/json/ .
RUN pnpm install --frozen-lockfile

COPY --from=pruner /app/out/full/ .

# Build-time SPA config. Declared as ARGs and surfaced as ENV before the
# build so `vite build` inlines them into the bundle.
ARG VITE_WS_URL
ARG VITE_SERVER_ORIGIN
ENV VITE_WS_URL=$VITE_WS_URL
ENV VITE_SERVER_ORIGIN=$VITE_SERVER_ORIGIN

RUN turbo run build --filter=@demo/cookie-bff-client

# ── runner ────────────────────────────────────────────────────────────
FROM nginx:alpine AS runner
RUN rm /etc/nginx/conf.d/default.conf
COPY apps/demo-cookie-bff/client/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/apps/demo-cookie-bff/client/dist /usr/share/nginx/html
EXPOSE 80
