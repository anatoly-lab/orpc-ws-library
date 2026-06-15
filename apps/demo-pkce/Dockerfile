# Multi-stage build for @demo/pkce (Vite + React → static, served by nginx).
#
# Built from the REPO ROOT so `turbo prune` sees every workspace:
#   docker build -f apps/demo-pkce/Dockerfile \
#     --build-arg VITE_OIDC_ISSUER_URL=... \
#     --build-arg VITE_OIDC_CLIENT_ID=... \
#     --build-arg VITE_WS_URL=... \
#     --build-arg VITE_UPLOAD_URL=... \
#     -t orpc-ws-e2e/spa .
#
# The VITE_* values are INLINED at `vite build` time (Vite env rules), so
# they are baked into the static bundle here — not read at container
# runtime. Re-target a different IdP / server by rebuilding with new args.

# ── base ──────────────────────────────────────────────────────────────
FROM node:22-alpine AS base
# corepack provisions the pnpm version pinned in package.json "packageManager".
# Alpine's bundled corepack predates the npm signing-key rotation and fails
# "Cannot find matching keyid" on recent pnpm releases — update it first.
RUN npm i -g corepack@latest && corepack enable
RUN npm i -g turbo@2
WORKDIR /app

# ── pruner ────────────────────────────────────────────────────────────
FROM base AS pruner
COPY . .
RUN turbo prune @demo/pkce --docker

# ── builder ───────────────────────────────────────────────────────────
FROM base AS builder

COPY --from=pruner /app/out/json/ .
RUN pnpm install --frozen-lockfile

COPY --from=pruner /app/out/full/ .

# Build-time SPA config. Declared as ARGs and surfaced as ENV before the
# build so `vite build` inlines them into the bundle.
ARG VITE_OIDC_ISSUER_URL
ARG VITE_OIDC_CLIENT_ID
ARG VITE_WS_URL
ARG VITE_UPLOAD_URL
ENV VITE_OIDC_ISSUER_URL=$VITE_OIDC_ISSUER_URL
ENV VITE_OIDC_CLIENT_ID=$VITE_OIDC_CLIENT_ID
ENV VITE_WS_URL=$VITE_WS_URL
ENV VITE_UPLOAD_URL=$VITE_UPLOAD_URL

RUN turbo run build --filter=@demo/pkce

# ── runner ────────────────────────────────────────────────────────────
FROM nginx:alpine AS runner
RUN rm /etc/nginx/conf.d/default.conf
COPY apps/demo-pkce/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/apps/demo-pkce/dist /usr/share/nginx/html
EXPOSE 80
