# `@repo/orpc-ws-server-nestjs`

NestJS adapter for `@repo/orpc-ws-server`. Thin wrapper that bridges
the framework-free core into Nest's lifecycle:

- `OnApplicationBootstrap` → `server.attach(httpServer)`
- `BeforeApplicationShutdown` → `server.dispose()` (clients get the
  configured shutdown close code **before** the HTTP server tears down)

## Install

```bash
npm install @repo/orpc-ws-server-nestjs @repo/orpc-ws-server
```

Peer deps (provided by the host app): `@nestjs/common` >= 10,
`@nestjs/core` >= 10, `reflect-metadata` >= 0.2.

## Quickstart

Every realistic consumer needs DI for `verifyClient` (it depends on
`AuthService` / `ConfigService` / a JWKS cache), so the documented
entry point is `forRootAsync`:

```ts
import { Module } from "@nestjs/common";
import { OrpcWsModule } from "@repo/orpc-ws-server-nestjs";
import { AuthService } from "./auth/auth.service";
import { appRouter } from "./router";

@Module({
  imports: [
    OrpcWsModule.forRootAsync({
      inject: [AuthService],
      useFactory: (auth: AuthService) => ({
        router: appRouter,
        verifyClient: async (ctx) => auth.verifyWsToken(ctx),
        hooks: { onConnected: (user) => auth.recordConnection(user) },
      }),
    }),
  ],
})
export class AppModule {}
```

Inject `OrpcWsService` anywhere you need imperative ops (it's a global
provider):

```ts
@Injectable()
export class AdminService {
  constructor(private readonly ws: OrpcWsService) {}
  kick(userKey: string): void { this.ws.closeUser(userKey, 4001, "Revoked"); }
}
```

A sync `forRoot({...})` is also exported for completeness when options
don't need Nest providers (rare in practice).

## `verifyClient`

```ts
type VerifyClientResult<TUser> =
  | { ok: true; user: TUser; connectionKey?: string }
  | { ok: false; code: number; reason: string };
```

Returns `{ok, code, reason}` not exceptions — `verifyClient` runs
inside `ws`'s upgrade callback, **before** Nest's request pipeline
exists, so there is no exception filter to translate a thrown
`UnauthorizedException` into an HTTP status. `code` is a WebSocket
close code (`4001` is the adapter default for "auth failed").

## OIDC verifier

For OIDC against any spec-compliant IdP (Keycloak, Auth0, Okta,
Cognito, Google), drop in
[`@repo/oidc-verifier-jose`](../oidc-verifier-jose/README.md):

```ts
import { createOidcVerifyClient } from "@repo/oidc-verifier-jose";

useFactory: () => ({
  router: appRouter,
  verifyClient: createOidcVerifyClient({
    issuerUrl: process.env.OIDC_ISSUER_URL!,
    boundClaim: "azp",                              // see verifier README
    expectedClientId: process.env.OIDC_CLIENT_ID!,
  }),
});
```

The verifier handles JWKS fetching, bound-claim checks, and survives
custom `mapUser` without breaking single-connection-per-user
enforcement.

## Lifecycle

```ts
const app = await NestFactory.create(AppModule);
app.enableShutdownHooks();           // REQUIRED
await app.listen(3000);
```

Without `enableShutdownHooks()`, Nest never calls
`BeforeApplicationShutdown` — `dispose()` never runs and clients see
TCP RST instead of a clean `4009` close. The adapter's hook fires
before Nest's HTTP server stops, so close frames make it to clients
first.

## Uploads — opt-in HTTP transport

```ts
OrpcWsModule.forRootAsync({
  inject: [AuthService],
  useFactory: (auth) => ({
    router: appRouter,
    verifyClient: async (ctx) => auth.verifyWsToken(ctx),
    uploads: {
      enabled: true,
      httpPath: "/upload",
      bodyLimitBytes: 50 * 1024 * 1024,   // 50 MB; default 10 MB
    },
  }),
});
```

Builds a second `RPCHandler` (HTTP, from `@orpc/server/node`) against
the **same composed router** as the WS handler. The route runs the
same `verifyClient` (Bearer header instead of URL token). Boot-time
collision check against existing Nest controller routes. Defaults to
off — when disabled, no extra route or body-parsing middleware.

Client side: `client.upload(file, { procedure: ["files","upload"] })`
— see [`@repo/orpc-ws-client`](../orpc-ws-client/README.md#uploads--opt-in-http-transport).

## HTTP adapter

**Express only on v1.** `HttpAdapterHost.httpAdapter.getHttpServer()`
returns a Node `http.Server` under `@nestjs/platform-express`, which
`new WebSocketServer({ server })` attaches to cleanly. Fastify
intercepts HTTP upgrade events differently — needs `noServer: true` +
manual `httpServer.on('upgrade', …)` wiring. If you're on Fastify
today, use `@repo/orpc-ws-server` directly.

## Logging

Adapter uses Nest's `Logger`. The core uses the shape from
`@repo/orpc-ws-shared` (`debug` / `info` / `warn` / `error` + structured
metadata). Pass a Nest-Logger-backed implementation through
`OrpcWsModuleOptions.logger` to unify sinks.

## Gotchas

1. **You must call `app.enableShutdownHooks()` in `main.ts`** or
   `dispose()` never runs.
2. **Express only on v1.** Fastify needs manual upgrade wiring — use
   `@repo/orpc-ws-server` directly.
3. **`verifyClient` runs BEFORE the Nest request pipeline.** No
   `@Req()` decorator, no guards, no interceptors. Inject your
   `AuthService` through `useFactory` and call it directly.

## See also

- Top-level [README](../../README.md)
- [`@repo/orpc-ws-server`](../orpc-ws-server) — framework-free core
- [`@repo/orpc-ws-client`](../orpc-ws-client) — paired client
- [Migration guide](../../docs/migration-anki-mcp-saas.md)
- [Sequence diagrams](../../docs/diagrams/)
- [src/index.ts](./src/index.ts) — full export surface
