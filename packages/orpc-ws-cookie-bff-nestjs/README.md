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

## Server→client RPC (bidirectional)

Opt in to the **reverse** direction — the server calls procedures the
**client** hosts, over the same cookie-authed socket. It's additive: omit
`clientContract` and the module is byte-identical to a one-way cookie-BFF
server (no `conn.client`).

Pass a `clientContract` (the client's contract router — what the client agrees
to answer) and surface the third `TClientContract` generic on
`CookieBffModuleOptions<TUser, TContract, TClientContract>`. The adapter
forwards the value unchanged to the internal `OrpcWsModule`; its presence
flips bidi on and gives every cookie-authed connection a typed `conn.client`
caller:

```ts
import {
  CookieBffModule,
  type CookieBffModuleOptions,
} from "@orpc-ws/cookie-bff-nestjs";
import { clientContract, type ClientContract } from "./client-contract";
import { appRouter } from "./router";

CookieBffModule.forRootAsync({
  inject: [SessionStore],
  // ⚠️ ANNOTATE THE RETURN TYPE — see the caveat below. Without it the bidi
  // generic collapses to `never` and `conn.client` silently disappears.
  useFactory: (
    sessionStore: SessionStore,
  ): CookieBffModuleOptions<EnrichedUser, typeof appRouter, ClientContract> => ({
    router: appRouter,
    /* …the cookie/OIDC/session options from the Quickstart… */
    clientContract,            // ← presence turns bidi on; drives `conn.client`'s type
    hooks: {
      onConnected: (conn) => {
        // conn.client is the typed server→client caller.
        void conn.client.showToast({ text: "Welcome!" });
      },
    },
  }),
});
```

Call it out-of-band later via the internal `OrpcWsModule`'s injectable
`OrpcWsService` (its module is `@Global`, so the service resolves anywhere in
the app; the `TClientContract` is supplied at the call site, since the
injected provider is type-erased). The cookie verifier files each connection
under `connectionKey = session.sub`, so the lookup key is the user's `sub`:

```ts
import { OrpcWsService } from "@orpc-ws/server-nestjs";

@Injectable()
export class BuildNotifier {
  constructor(private readonly ws: OrpcWsService) {}
  notify(sub: string): void {
    void this.ws
      .getConnection<ClientContract>(sub)
      ?.client.showToast({ text: "Build done" });
  }
}
```

Browser-side, the counterpart is the React adapter's
[`<OrpcWs clientContract>`](../orpc-ws-react/README.md) — pass the same
contract's router value and the client hosts the answering procedures (bidi
turns on iff the prop is present; no explicit generic).

### Caveat — `forRootAsync` needs an annotated `useFactory` return type

This bites **`forRootAsync` only** (same footgun as `OrpcWsModule`). `forRoot`
takes the options literal directly, so `TClientContract` infers from the
`clientContract` value you pass. `forRootAsync` takes a `useFactory` instead,
and TypeScript's higher-order inference will **not** pull the third generic
out of a bare (unannotated) factory return — it collapses `TClientContract` to
`never`, so `conn.client` silently loses its typing (the property disappears)
even though the runtime still wires bidi up. Annotate the factory's return
type to make the generic flow:

```ts
useFactory: (): CookieBffModuleOptions<TUser, TContract, MyClientContract> => ({
  /* … */
});
```

(Runtime is unaffected either way; this is purely about preserving `.client`
typing.) For the full bidi contract — including the trust-inversion threat
model of letting the server invoke a client-hosted router — see
[`@orpc-ws/server-nestjs` → Server→client RPC (bidirectional)](../orpc-ws-server-nestjs/README.md#serverclient-rpc-bidirectional)
and [`@orpc-ws/server` → Server→client RPC (bidirectional)](../orpc-ws-server/README.md#serverclient-rpc-bidirectional).

## What the module wires

`CookieBffModule` is the only module you install. Internally it:

1. Builds the `/auth/*` core (`createCookieBffCore`) from the resolved options.
2. Configures `OrpcWsModule` from the **same** options, constructing the cookie
   `VerifyClient` (`createCookieVerifyClient`) and forwarding `router` plus the
   WS `connection` / `heartbeat` / `interceptors` / `rootInterceptors` /
   `logger` passthroughs — and the optional `clientContract` (bidi, above) and
   `hooks?: AuthenticatedHooks<TUser, TClientContract>` (WS
   connection-lifecycle hooks `onConnected` / `onDisconnected` / `onKicked`
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

### Verifier tuning

Two optional options shape the WS-upgrade verify. Both are additive — omit
them and the wiring is byte-identical to the defaults.

| Option | Default | What it does |
| --- | --- | --- |
| `verifyTimeoutMs` | `30000` (core default) | Upper bound in ms on the cookie verify settling, forwarded to `OrpcWsModule`. `0` disables the bound. |
| `verifierSessionStore` | `sessionStore` | The `SessionStore` the **verifier** uses, independent of the one the `/auth/*` core uses. |

`verifyTimeoutMs` bounds the **whole** verify — the session-store `get` **and**
the session-window slide (`touch`, or the fallback `get` + merged `set`) — so a
store doing remote hops sits inside the budget twice. On timeout the upgrade
fails closed exactly like a thrown verify: pre-101 HTTP 500, which a browser
can only observe as a *pre-open failure*, so the client retries on its backoff
— never a terminal auth failure. The core default is deliberately generous (it
exists to reclaim sockets from a **hung** verify, not to police a slow-but-live
one); if your store does remote hops, consider setting this **below** the
client's `connectionTimeout` (default `5000`) so a slow verify fails closed
server-side before the client abandons the handshake.

`verifierSessionStore` exists because the handshake and `/auth/me` have
different cost profiles: it lets the WS upgrade read a cheap single-hop store
while the core keeps a richer one (e.g. one whose `get` also refreshes roles via
an extra RPC), instead of paying that cost on every reconnect. **Caveat — this
is not a read-only seam.** On success the verifier *slides* the session window
(unless `slideSessionOnActivity: false`), so it must be a **full**
`SessionStore` writing to the **same backing records** as `sessionStore`. Point
it at a different backing store and the rolling window is re-stamped in the
wrong place — the real session still expires on its original schedule.

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
