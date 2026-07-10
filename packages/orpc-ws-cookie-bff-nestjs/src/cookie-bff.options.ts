// Module options for `CookieBffModule`.
//
// = the framework-free core's `CookieBffOptions<TUser>` (the cookie/OIDC/
// session-store/encryption surface) PLUS the bits the adapter forwards to the
// internal `OrpcWsModule`: the consumer's `router`, plus the WS
// `connection`/`heartbeat`/`interceptors`/`rootInterceptors`/`logger`
// passthroughs. We REUSE the core type rather than redefining it — the adapter
// adds the WS-wiring fields and consumes the rest unchanged.
//
// `TUser` is the consumer's ENRICHED user (returned by `resolveUser`, attached
// by the cookie verifier, echoed by `/auth/me`). It defaults so a
// `forRootAsync` `useFactory` can return `CookieBffModuleOptions` without a
// type arg during composition.

import type { CookieBffOptions, EndpointOptions } from "@orpc-ws/cookie-bff";
import type {
  AnyContractRouter,
  AuthenticatedHooks,
  ConnectionConfig,
  HeartbeatConfig,
  OrpcWsInterceptors,
  OrpcWsRootInterceptors,
} from "@orpc-ws/server";
import type { Logger } from "@orpc-ws/shared";

/**
 * Options accepted by `CookieBffModule.forRoot` / `forRootAsync`.
 *
 * The core `CookieBffOptions<TUser>` carries `keycloak`, `cookies`,
 * `originAllowlist`, `encryptionKey`, `sessionStore`, `sessionTtlSeconds`,
 * `slideSessionOnActivity`, `resolveUser`, `spaRedirectUri`, `pkceStore?`,
 * etc. — all forwarded to `createCookieBffCore` unchanged. The fields below
 * are the adapter's additions, forwarded to the internal `OrpcWsModule`.
 *
 * The generic parameters mirror `OrpcWsModuleOptions<TUser, TContract,
 * TClientContract>` from `@orpc-ws/server-nestjs`. All default so existing
 * one-way consumers compile unchanged; `TClientContract` defaults to `never`
 * (bidi OFF).
 */
export interface CookieBffModuleOptions<
  TUser = unknown,
  TContract extends object = object,
  TClientContract extends AnyContractRouter = never,
> extends CookieBffOptions<TUser> {
  /**
   * The consumer's ORPC router — forwarded to `OrpcWsModule` (the cookie-BFF
   * adapter never has its own router; it owns only auth + the verifier
   * bridge). The library spreads its stealth heartbeat sub-router into it.
   */
  router: TContract;

  /**
   * Endpoint paths (`basePath`, `ws`). CURRENTLY IGNORED BY THIS ADAPTER —
   * a no-op. The `/auth/*` controller prefix is the FIXED `@Controller("auth")`
   * (Nest reads it from decorator metadata before any DI/config runs), and the
   * WS path comes from `connection.path` on the WS options, NOT `endpoints.ws`.
   * The field is kept to match the design-doc / core option shape; a consumer
   * wanting a different auth base uses Nest's `setGlobalPrefix(...)` or mounts
   * the controller under a prefixed module, and sets the WS path via
   * `connection: { path: "..." }`.
   */
  endpoints?: EndpointOptions;

  /** Partial WS connection config overlay — forwarded to `OrpcWsModule`. */
  connection?: Partial<ConnectionConfig>;
  /** Partial heartbeat config overlay — forwarded to `OrpcWsModule`. */
  heartbeat?: Partial<HeartbeatConfig>;
  /** ORPC handler-level interceptors — forwarded to `OrpcWsModule`. */
  interceptors?: OrpcWsInterceptors;
  /** ORPC root interceptors — forwarded to `OrpcWsModule`. */
  rootInterceptors?: OrpcWsRootInterceptors;
  /**
   * WS connection-lifecycle hooks (`onConnected` / `onDisconnected` /
   * `onKicked` / `onZombieTerminated`) — forwarded to `OrpcWsModule`. These are
   * the WS-server hooks (NOT the `/auth/*`-flow `authEvents` on the core
   * options); use them for connection-level observability in cookie-BFF. The
   * hooks' `conn` carries a typed `client` server→client caller exactly when
   * `clientContract` is supplied.
   */
  hooks?: AuthenticatedHooks<TUser, TClientContract>;

  /**
   * Server→client RPC ("bidi") contract — the CLIENT's contract router (the
   * procedures the browser agrees to answer). Forwarded UNCHANGED to the
   * internal `OrpcWsModule`; its PRESENCE flips bidi on and gives every
   * cookie-authed connection a typed `conn.client` caller (in `hooks` and via
   * `OrpcWsService.getConnection(key)?.client`). Omit it and the module is
   * byte-identical to a one-way cookie-BFF server (no `conn.client`).
   *
   * FOOTGUN (same as the core): the runtime switch is `clientContract`'s
   * truthy presence (the adapter's forward and the core factory both gate on
   * truthiness), while `conn.client`'s TYPE presence rides the
   * `TClientContract` generic — the two are independent and TS can't bind
   * them. Pass the VALUE
   * and let the generic infer from it; never write the generic without also
   * passing the value. On `forRootAsync`, ANNOTATE the `useFactory` return type
   * (`CookieBffModuleOptions<TUser, TContract, ClientContract>`) or higher-order
   * inference collapses `TClientContract` to `never` and `conn.client` silently
   * disappears (runtime still wires bidi up).
   */
  clientContract?: TClientContract;

  /**
   * Logger seam. Forwarded to BOTH the core (`createCookieBffCore`, for the
   * slide-write warning etc.) AND the internal `OrpcWsModule`. Defaults to the
   * core's noop on each side.
   */
  logger?: Logger;
}
