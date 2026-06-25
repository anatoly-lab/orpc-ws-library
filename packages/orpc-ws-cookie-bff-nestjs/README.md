# `@orpc-ws/cookie-bff-nestjs`

NestJS adapter for [`@orpc-ws/cookie-bff`](../orpc-ws-cookie-bff) — the thin
Nest wrapper that makes the cookie-BFF topology a one-module install. The
consumer configures `CookieBffModule.forRootAsync(...)` **once**; the adapter
internally configures [`@orpc-ws/server-nestjs`](../orpc-ws-server-nestjs)'s
`OrpcWsModule`, hands it the cookie verifier (the verifier→WS bridge is the
adapter's job — Decision #23), hosts the `/auth/*` controller (a pure
translator from the core's `AuthInstruction` to express `@Res`), and exposes
`CookieBffService` with `revokeUser(sub)`. The only `@nestjs/*`-importing
package in the cookie-BFF stack; all auth logic lives in the framework-free
core. See [`docs/cookie-bff-server-design.md`](../../docs/cookie-bff-server-design.md)
§C/§D.6.

## Install

```bash
npm install @orpc-ws/cookie-bff-nestjs
```

`@nestjs/common` (>= 10), `@nestjs/core` (>= 10), and `reflect-metadata`
(>= 0.2) are peer dependencies (provided by the host app). The `/auth/*`
controller uses express `@Req`/`@Res`, so an **Express HTTP adapter is
required** — same constraint as `@orpc-ws/server-nestjs`. The core
(`@orpc-ws/cookie-bff`), `@orpc-ws/server`, `@orpc-ws/server-nestjs`, and
`@orpc-ws/shared` are direct dependencies — you don't install them separately.

## Quickstart

`forRootAsync` is the documented entry point — every real consumer needs DI for
the `sessionStore` / config. The factory's resolved options drive **both** the
`/auth/*` core **and** the internal `OrpcWsModule` verifier bridge.

```ts
import { Module } from "@nestjs/common";
import {
  CookieBffModule,
  type CookieBffModuleOptions,
} from "@orpc-ws/cookie-bff-nestjs";
import { appRouter } from "./router";
import { SessionStore } from "./session-store"; // your SessionStore<EnrichedUser>

@Module({
  imports: [
    CookieBffModule.forRootAsync<EnrichedUser>({
      inject: [SessionStore],
      useFactory: (
        sessionStore: SessionStore,
      ): CookieBffModuleOptions<EnrichedUser> => ({
        router: appRouter,
        keycloak: {
          issuerUrl: process.env.OIDC_ISSUER_URL!,
          clientId: process.env.OIDC_CLIENT_ID!,
          // The API's OWN callback — the auth code never touches the browser.
          redirectUri: "https://api.example.com/auth/callback",
          scope: "openid profile email",
        },
        originAllowlist: ["https://app.example.com"], // exact WS upgrade Origins
        encryptionKey: process.env.SESSION_ENC_KEY!,  // 32-byte AES-256-GCM key
        sessionStore,
        spaRedirectUri: "https://app.example.com",     // /callback 302 target
        resolveUser: async (claims) => findOrCreateUser(claims),
        // Cookie hardening defaults to PROD-shaped: __Host- prefix, Secure,
        // SameSite=Strict. Omit `cookies` to take them. (The demo RELAXES
        // these — plain `sid`, no Secure, no host-prefix, SameSite=Lax —
        // ONLY because it runs over plain http://localhost, where a
        // __Host-/Secure cookie is dropped by the browser.)
        connection: { path: "/ws" }, // WS path, forwarded to OrpcWsModule
      }),
    }),
  ],
})
export class AppModule {}
```

Inject `CookieBffService` anywhere you need imperative ops:

```ts
@Injectable()
export class RevocationHandler {
  constructor(private readonly cookieBff: CookieBffService) {}

  // Best-effort kick: empties the drawer for `sub` (future connects + lazy
  // refreshes fail) AND drops its live socket on THIS instance. Cross-instance
  // fan-out is your job — call this on every instance from your event bus.
  async onSessionInvalidated(sub: string): Promise<void> {
    await this.cookieBff.revokeUser(sub);
  }

  // Pass-through to the WS server.
  kick(connectionKey: string): void {
    this.cookieBff.closeUser(connectionKey, 4001, "Revoked");
  }
}
```

A sync `forRoot({...})` is also exported for the rare case where options need
no Nest providers.

## What the module wires

`CookieBffModule` is the only module you install. Internally it:

1. Builds the `/auth/*` core (`createCookieBffCore`) from the resolved options.
2. Configures `OrpcWsModule` from the **same** options, constructing the cookie
   `VerifyClient` (`createCookieVerifyClient`) and forwarding `router` plus the
   WS `connection` / `heartbeat` / `interceptors` / `rootInterceptors` /
   `logger` passthroughs — and an optional `hooks?: AuthenticatedHooks<TUser>`
   (WS connection-lifecycle hooks `onConnected` / `onDisconnected` / `onKicked`
   / `onZombieTerminated`), forwarded verbatim to the internal `OrpcWsModule`.
   **This is the bridge** — the consumer never wires the WS verifier
   (Decision #23). If the adapter merely exported the verifier, every consumer
   would re-create a hand-bound `verify-client.ts` and re-import `OrpcWsModule` —
   exactly the scattering #23 forbids. The core's `authEvents` auth-flow metrics
   hooks flow through automatically (the resolved options pass straight to
   `createCookieBffCore`).
3. Registers the `/auth/*` controller and `CookieBffService`.

`enforceTokenExpiry` is deliberately **left OFF** — the WS connection lifetime
follows the **session** window (`sessionExpiresAt`), not the access-token `exp`.

For single-import convenience the adapter **re-exports** the core's
`createCookieBffCore` / `createCookieVerifyClient` / `revokeUser` plus the core
types (`SessionStore`, `SessionData`, `CookieBffOptions`, `AuthInstruction`,
`IdTokenClaims`, …) — see [src/index.ts](./src/index.ts).

## Gotchas

### Install exactly once

`CookieBffModule` owns the single `@Global` WS transport via its internal
`OrpcWsModule`. Import it **once**, at the app root. Importing it twice — or
importing `OrpcWsModule` **separately alongside** it — attaches two WS servers
to the same path: a last-wins / double-listen footgun. (No runtime guard is
added: a static flag would false-positive across tests and legitimate
teardown/re-create cycles that build the module more than once per process.)

### `endpoints` is a no-op

The `endpoints` field (`basePath` / `ws`) is **currently inert** on this
adapter. The `/auth/*` prefix is the fixed `@Controller("auth")` — Nest reads
it from decorator metadata at class-eval, before any DI/config runs, so it
can't be config-driven. For a different auth base use Nest's
`setGlobalPrefix(...)` (or mount the controller under a prefixed module); for
the WS path use `connection: { path: "..." }`, **not** `endpoints.ws`.

### Express only

The `/auth/*` controller uses express `@Req`/`@Res`, and the WS server attaches
to the Express `http.Server`. Fastify intercepts HTTP upgrade events
differently. Same constraint as
[`@orpc-ws/server-nestjs`](../orpc-ws-server-nestjs/README.md#http-adapter) —
on Fastify, wire the framework-free core directly.

## Module formats

Built with [tshy](https://github.com/isaacs/tshy) — **dual ESM/CJS**
(`dist/esm` + `dist/commonjs`, one `.` export), like the library cores. Unlike
the two React adapters (ESM-only — a module-level `createContext` makes a dual
build a dual-package-identity hazard), this adapter carries no such
module-level singleton, so both `import` and `require` resolve.

## See also

- Top-level [README](../../README.md)
- [`@orpc-ws/cookie-bff`](../orpc-ws-cookie-bff) — framework-free core
- [`@orpc-ws/server-nestjs`](../orpc-ws-server-nestjs) — the WS NestJS adapter this wraps
- [Cookie-BFF server design](../../docs/cookie-bff-server-design.md) — full design doc
- [src/index.ts](./src/index.ts) — full export surface
