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
 */
export interface CookieBffModuleOptions<TUser = unknown>
  extends CookieBffOptions<TUser> {
  /**
   * The consumer's ORPC router — forwarded to `OrpcWsModule` (the cookie-BFF
   * adapter never has its own router; it owns only auth + the verifier
   * bridge). The library spreads its stealth heartbeat sub-router into it.
   */
  router: object;

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
   * Logger seam. Forwarded to BOTH the core (`createCookieBffCore`, for the
   * slide-write warning etc.) AND the internal `OrpcWsModule`. Defaults to the
   * core's noop on each side.
   */
  logger?: Logger;
}
