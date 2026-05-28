# Migration guide — `anki-mcp-saas` → `@repo/orpc-ws-*`

Step-by-step recipe for replacing the source app's hand-rolled
WebSocket transport with the library. Two halves: `apps/web` (client)
and `apps/api` (server). Each half can land in its own PR; the wire
protocol is unchanged so the halves can roll independently.

The patterns generalize — if you're migrating a different consumer,
read this as a shape-and-order guide. The exact file paths will
differ.

## Pre-flight

- Library packages already declared as dependencies in
  `apps/web/package.json` and `apps/api/package.json`.
- Source app's WebSocket directory layout (`apps/web/src/lib/websocket/`
  + `apps/api/src/api-gateway/websocket/`) is what gets replaced.
- The shared ORPC contract (`@repo/orpc-contract`) does **not** change.
  Same `appContract` consumed both sides of the wire.

---

## Client side (`apps/web`)

### Step 1 — Replace `apps/web/src/lib/websocket/index.ts` with a shim

The 8 names the source app exports — `orpcClient`, `safeReconnect`,
`closeWebSocket`, `connectionStateManager`, `getConnectionState`,
`CONNECTION_STATE`, `ConnectionState`, `checkWebSocketTokenValidity` —
are kept as backwards-compatible re-exports so consumer call sites
don't move. Everything backs onto a single `createOrpcWsClient` call.

```ts
// apps/web/src/lib/websocket/index.ts
import { createOrpcWsClient } from "@repo/orpc-ws-client";
import type { appContract } from "@repo/orpc-contract";
import type {
  ConnectionState as LibConnectionState,
} from "@repo/orpc-ws-client";
import { authStorage } from "../auth";
import { handleAuthFailure } from "../auth-failure";
import { buildWebSocketUrl } from "./url"; // wraps the existing builder; see step 2

const client = createOrpcWsClient<typeof appContract>({
  url: () => buildWebSocketUrl(),
  tokenProvider: {
    getToken: () => authStorage.getAccessToken(),
    refresh: () => authStorage.refreshAccessToken(),
  },
  onTerminalAuthFailure: () => handleAuthFailure(),
  onEvent: (e) => {
    if (e.type === "auth_failure" && !e.refreshable) handleAuthFailure();
  },
});

// Kick off the initial connection (parity with the source app's
// module-load auto-init).
if (authStorage.getAccessToken()) {
  client.connect();
}

// ----- Backwards-compat re-exports for existing consumer code -----

export const orpcClient = client.rpc;

export async function safeReconnect(): Promise<void> {
  client.connect();
}

export function closeWebSocket(): void {
  client.dispose();
}

// State surface — map the library's tagged record to the source app's
// string union so existing UI doesn't change.
export const CONNECTION_STATE = {
  CONNECTING: "connecting",
  CONNECTED: "connected",
  DISCONNECTED: "disconnected",
  SESSION_REPLACED: "session_replaced",
} as const;

export type ConnectionState =
  (typeof CONNECTION_STATE)[keyof typeof CONNECTION_STATE];

function toLegacyState(s: LibConnectionState): ConnectionState {
  if (s.status === "kicked") return CONNECTION_STATE.SESSION_REPLACED;
  if (s.status === "connecting") return CONNECTION_STATE.CONNECTING;
  if (s.status === "connected") return CONNECTION_STATE.CONNECTED;
  return CONNECTION_STATE.DISCONNECTED;
}

export const connectionStateManager = {
  getState: () => toLegacyState(client.state.getState()),
  subscribe: (cb: () => void) => client.state.subscribe(cb),
};

export const getConnectionState = (): ConnectionState =>
  connectionStateManager.getState();
```

#### `checkWebSocketTokenValidity` does NOT migrate

The existing function reaches into the consumer's `tokenStorage` to
peek at JWT expiry — that's consumer-domain concern, not transport.
Re-implement locally if you still need it, using `TokenProvider.getToken()`
and your own expiry decoder. The library's heartbeat watchdog already
catches the failure mode this function was guarding against (stale
token → server closes → reconnect with refreshed token), so most call
sites can simply delete it.

### Step 2 — Replace the URL builder import

The old `buildWebSocketUrl(token)` takes a token and returns the full
URL with `?token=...` appended. The library's `tokenProvider` already
appends the token, so collapse the call:

```ts
// apps/web/src/lib/websocket/url.ts
const WS_BASE_URL = import.meta.env.VITE_WS_URL ?? "wss://api.example.com/ws";

/** Base URL only — token is appended by the library's URL builder. */
export function buildWebSocketUrl(): string {
  return WS_BASE_URL;
}
```

### Step 3 — Replace `apps/web/src/hooks/useConnectionState.ts`

Was 30 lines, becomes one import:

```ts
// apps/web/src/hooks/useConnectionState.ts
export { useConnectionState } from "@repo/orpc-ws-client/react";
```

If you kept the legacy string-union shape (Step 1 above), you'll want
a thin wrapper that maps the library's tagged record to your existing
union; otherwise update call sites to read `state.status` instead of
`state` directly.

### Step 4 — Delete the now-unused transport files

After Steps 1-3, the entire `apps/web/src/lib/websocket/` tree —
**except** `index.ts` and the URL config — is library-internal and
gone:

```
apps/web/src/lib/websocket/
├── client/                 # delete
├── config/                 # keep url.ts only
├── heartbeat/              # delete
├── lifecycle/              # delete
├── reconnect/              # delete
├── sleep/                  # delete
├── state/                  # delete
├── public-api.ts           # delete (replaced by index.ts shim)
├── types.ts                # delete or keep CONNECTION_STATE only
└── index.ts                # rewritten shim from Step 1
```

That's 17+ files removed, ~1,200 LOC gone.

### Step 5 — Wire uploads (optional)

If the app gains file uploads in the future, augment the client config
once and call `client.upload(file, opts)` from procedure call sites:

```ts
const client = createOrpcWsClient<typeof appContract>({
  url: () => buildWebSocketUrl(),
  tokenProvider: { /* ... */ },
  uploads: {
    strategy: "orpc-http",
    httpUrl: import.meta.env.VITE_HTTP_URL + "/upload",
  },
});

// Anywhere in the app:
await client.upload(file, {
  procedure: ["mediaUploads", "create"],
  onProgress: (p) => setProgress(p.loaded / p.total),
});
```

Out of scope for the v1 migration if there are no upload procedures
yet.

---

## Server side (`apps/api`)

### Step 1 — Replace `WebSocketModule` with `OrpcWsModule.forRootAsync`

**Before** (`apps/api/src/api-gateway/websocket/websocket.module.ts`):

```ts
@Module({
  imports: [AuthModule, TunnelStatusModule, UsersClientModule],
  providers: [WebSocketGateway, QuotaRouter],
  exports: [WebSocketGateway],
})
export class WebSocketModule {}
```

**After**:

```ts
// apps/api/src/api-gateway/websocket/websocket.module.ts
import { Module } from "@nestjs/common";
import { OrpcWsModule } from "@repo/orpc-ws-server-nestjs";

import { AuthModule } from "../auth/auth.module";
import { TunnelStatusModule } from "@/tunnel-status";
import { UsersClientModule } from "@/users-client";
import { AuthService } from "../auth/auth.service";
import { AuthRouter } from "../auth/routers";

import { buildAppRouter } from "./router";
import { QuotaRouter } from "./quota.router";

@Module({
  imports: [
    AuthModule,
    TunnelStatusModule,
    UsersClientModule,
    OrpcWsModule.forRootAsync({
      imports: [AuthModule],  // re-import so useFactory can inject
      inject: [AuthService, AuthRouter, QuotaRouter],
      useFactory: (
        auth: AuthService,
        authRouter: AuthRouter,
        quotaRouter: QuotaRouter,
      ) => ({
        router: buildAppRouter({ authRouter, quotaRouter }),
        verifyClient: (ctx) => auth.verifyWsToken(ctx),
        hooks: {
          onConnected: (user) => auth.recordWsConnection(user),
          onDisconnected: (user, code) => auth.recordWsDisconnect(user, code),
        },
        // Reuse the existing env-driven knobs.
        heartbeat: {
          intervalMs: Number(process.env.WS_HEARTBEAT_INTERVAL_MS ?? 25_000),
          timeoutMs: Number(process.env.WS_HEARTBEAT_TIMEOUT_MS ?? 20_000),
        },
      }),
    }),
  ],
  providers: [QuotaRouter],
})
export class WebSocketModule {}
```

### Step 2 — Extract `verifyClient` onto `AuthService`

The current gateway does Keycloak JWKS verification inline. Move that
to `AuthService.verifyWsToken(ctx)` so it's injectable into
`useFactory`:

```ts
// apps/api/src/api-gateway/auth/auth.service.ts (additions)
import type { VerifyClient } from "@repo/orpc-ws-server-nestjs";
import type { WebSocketUser } from "../websocket/types";

async verifyWsToken(
  ctx: Parameters<VerifyClient<WebSocketUser>>[0],
): Promise<ReturnType<VerifyClient<WebSocketUser>>> {
  const url = new URL(ctx.req.url ?? "", "http://x");
  const token = url.searchParams.get("token");
  if (!token) return { ok: false, code: 4001, reason: "Missing token" };

  try {
    const { payload } = await jwtVerify(token, this.jwks, {
      issuer: this.keycloakIssuer,
      audience: this.keycloakAudience,
    });
    // azp claim verification — stays in the consumer, NOT library.
    if (!this.allowedAzpClaims.has(payload.azp as string)) {
      return { ok: false, code: 4001, reason: "azp not allowed" };
    }
    const user: WebSocketUser = {
      sub: payload.sub!,
      email: payload.email as string | undefined,
      // ...whatever shape your handlers consume.
    };
    return { ok: true, user, connectionKey: user.sub };
  } catch (err) {
    this.logger.warn("WS token verification failed", { error: String(err) });
    return { ok: false, code: 4001, reason: "Invalid token" };
  }
}
```

The discriminated-union return is intentional — see the [server
adapter README](../packages/orpc-ws-server-nestjs/README.md#verifyclient--discriminated-union-not-exceptions)
for why this is not a thrown `UnauthorizedException`.

### Step 3 — Extract router definition

The 952-line gateway carries the consumer-domain router definition
(auth procedures, quota procedures, all the middlewares). Pull that
into a `router.ts` next to the module:

```ts
// apps/api/src/api-gateway/websocket/router.ts
import { os } from "@orpc/server";
import { AuthRouter } from "../auth/routers";
import { QuotaRouter } from "./quota.router";

export function buildAppRouter(deps: {
  authRouter: AuthRouter;
  quotaRouter: QuotaRouter;
}) {
  return {
    auth: deps.authRouter.build(),
    quota: deps.quotaRouter.build(),
    // ...all the existing procedure definitions, unchanged.
  };
}
```

Auth middleware (`os.use(authMiddleware)`) keeps living here — the
library doesn't own it.

### Step 4 — Delete the old gateway

After Steps 1-3 the gateway file (`websocket.gateway.ts`) is empty of
transport — what remains is the router code now in `router.ts`. Delete
it.

What goes away from the gateway:
- `verifyClient` orchestration (URL parsing, JWKS verify, 101 timing)
  → adapter handles.
- `userConnections` Map + single-session enforcement → adapter
  `ConnectionRegistry` handles.
- `heartbeatPublisher` + interval timer + subscribe fan-out →
  adapter handles.
- WS-protocol ping/pong + zombie aliveness Map → adapter handles.
- `OnModuleDestroy` cleanup ordering → adapter `dispose()` handles.

What stays in your codebase:
- Router definition (procedures, middleware, contract usage)
- `AuthService.verifyWsToken` (the seam you injected)
- `azp` claim policy (consumer policy, not transport)
- `metricsMiddleware`, `EventBusService` integration (consumer-domain
  middleware)

Net change for the gateway: **952 LOC → ~350-400 LOC**, all of which is
consumer-domain router/middleware. The transport layer is gone from
your repo.

### Step 5 — Wire uploads (optional)

If/when an upload procedure lands in the contract:

```ts
OrpcWsModule.forRootAsync({
  inject: [AuthService, AuthRouter, QuotaRouter],
  useFactory: (auth, authRouter, quotaRouter) => ({
    router: buildAppRouter({ authRouter, quotaRouter }),
    verifyClient: (ctx) => auth.verifyWsToken(ctx),
    uploads: {
      enabled: true,
      httpPath: "/upload",
      bodyLimitBytes: 50 * 1024 * 1024,
    },
  }),
}),
```

The same `verifyClient` is reused for HTTP uploads — token comes from
`Authorization: Bearer` instead of the URL. No code duplication.

---

## Rollout order

1. Land the client side first; it's the side users see. The library's
   wire protocol is identical to the source app's (same ORPC, same
   heartbeat namespace, same close codes), so a client on the library
   talking to the unchanged server works.
2. Land the server side second; the existing client (on the library)
   continues to work.
3. Run the source app's existing e2e suite (`apps/web/tests/`) after
   each PR. The library's own tests are unit + integration; the
   source-app e2e catches end-to-end regressions in your specific auth
   flow + Keycloak setup.

## Known sharp edges

- The library's `ConnectionState` is a tagged record; the source app's
  was a string union. The Step-1 shim flattens it back to strings for
  backwards-compat, but if you move call sites to consume the tagged
  record directly, the upgrade is one-time and worth doing for the
  better narrowing.
- The library's `onTerminalAuthFailure` is invoked on a separate
  channel from state transitions. The source app's `handleAuthFailure`
  did both ("emit the event AND set state to disconnected"); the
  library's split means you bind it to just the side effect (redirect
  to login). State already transitions on its own.
- The library's storm guard window is internal and shared across all
  trigger types (heartbeat timeout, close 1008, etc.). The source app
  had two independent timestamps — `lastWsAuthRefreshAttemptedAt` and a
  separate close-code counter — which could drift. Post-migration, you
  get one window; no extra config required.

## See also

- [Top-level README](../README.md)
- [`@repo/orpc-ws-client` README](../packages/orpc-ws-client/README.md)
- [`@repo/orpc-ws-server-nestjs` README](../packages/orpc-ws-server-nestjs/README.md)
- [Sequence diagrams](./diagrams/) — the flows the library now owns
- [Implementation plan](./implementation-plan.md) §"Migration into
  source app"
