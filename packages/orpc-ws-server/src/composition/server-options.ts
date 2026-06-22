// Public option + hook shapes for the two construction modes.
//
// TWO plain interfaces, one per mode (CLAUDE.md "readable" — preferred
// over a clever conditional signature):
//   - AuthenticatedOrpcWsServerOptions — today's full surface.
//   - AuthlessOrpcWsServerOptions — a deliberately SMALLER surface with
//     NO verifyClient, NO uploads, NO enforceTokenExpiry.
//
// The factories in `factories.ts` consume these and normalize them into
// the class's internal options (`OrpcWsServerOptions`, declared in
// index.ts) — so the public authless type can hide fields the class
// technically accepts but authless must never expose.

import type { Clock, Logger } from "@orpc-ws/shared";
import type { WebSocket } from "ws";

import type { ConnectionConfig } from "../config/connection-config.js";
import type { HeartbeatConfig } from "../config/heartbeat-config.js";
import type { VerifyClient } from "../lifecycle/verify-client-orchestrator.js";
import type { UploadHttpConfig } from "../upload/http-config.js";

// ----- Hook bundles -----

/**
 * Lifecycle hooks for the AUTHENTICATED server. All optional; all receive
 * the typed `TUser` payload.
 *
 * (This is the historical `OrpcWsServerHooks<TUser>` shape; index.ts
 * re-exports it under both names for back-compat.)
 */
export interface AuthenticatedHooks<TUser> {
  onConnected?: (user: TUser, ws: WebSocket) => void;
  onDisconnected?: (user: TUser, code: number, ws: WebSocket) => void;
  /**
   * `user` is the kicked user; `replacedBy` is the new live WS that
   * caused the kick. Authenticated-only — authless never replaces a
   * session, so `AuthlessHooks` omits this.
   */
  onKicked?: (user: TUser, replacedBy: WebSocket) => void;
  /**
   * Fires after the watchdog terminates a zombie. `user` is the user
   * whose connection was terminated.
   */
  onZombieTerminated?: (user: TUser) => void;
}

/**
 * Lifecycle hooks for the AUTHLESS server. Same EVENTS as the
 * authenticated hooks but with NO user param (authless carries no
 * authenticated principal — see `state/no-auth.ts`), and NO `onKicked`
 * (authless has no session-replacement: `singleConnectionPerUser` is
 * forced off, every connection is independent).
 */
export interface AuthlessHooks {
  onConnected?: (ws: WebSocket) => void;
  onDisconnected?: (code: number, ws: WebSocket) => void;
  /** Fires after the watchdog terminates a zombie connection. */
  onZombieTerminated?: () => void;
}

// ----- Option shapes -----

/**
 * Options for `createOrpcWsServer` — the AUTHENTICATED factory. This is
 * the library's everyday surface: `verifyClient` is REQUIRED, and the
 * full feature set (uploads, token-expiry enforcement, per-user
 * close/kick) is available.
 */
export interface AuthenticatedOrpcWsServerOptions<
  TUser,
  TContract extends object,
> {
  /**
   * The consumer's ORPC router (plain object — top-level keys are
   * procedure names or sub-routers). The library spreads its own
   * `__orpc_ws_lib__` namespace into this; a top-level collision throws
   * at construction.
   */
  router: TContract;
  /**
   * Pre-101 auth. Runs inside `ws`'s `verifyClient` callback. Returns a
   * discriminated union: `{ok: true, user, connectionKey?}` to accept,
   * `{ok: false, code, reason}` to reject pre-upgrade.
   */
  verifyClient: VerifyClient<TUser>;
  /** Partial connection config overlay. */
  connection?: Partial<ConnectionConfig>;
  /** Partial heartbeat config overlay. */
  heartbeat?: Partial<HeartbeatConfig>;
  hooks?: AuthenticatedHooks<TUser>;
  logger?: Logger;
  /** Test seam — fake clock. */
  clock?: Clock;
  /** Opt-in HTTP transport for file uploads. */
  uploads?: Partial<UploadHttpConfig<TUser>>;
}

/**
 * Options for `createAuthlessOrpcWsServer` — the AUTHLESS factory. A
 * deliberately SMALLER surface:
 *   - NO `verifyClient` — every upgrade is accepted.
 *   - NO `uploads` — the HTTP upload transport authenticates via the same
 *     `TokenProvider`/Bearer as the WS, which authless has none of.
 *   - NO `enforceTokenExpiry` (it lives on `connection` for the authed
 *     path; authless has no token to expire) — see note below.
 *
 * `connection` is still accepted for path / close-code / shutdown
 * tuning, but `singleConnectionPerUser` and `enforceTokenExpiry` are
 * forced off by the factory regardless of what the consumer passes (a
 * stray `true` is ignored + logged once), so they're typed out here.
 */
export interface AuthlessOrpcWsServerOptions<TContract extends object> {
  /** The consumer's ORPC router. Same contract as the authed options. */
  router: TContract;
  /**
   * Partial connection config overlay — MINUS the auth-only knobs
   * (`singleConnectionPerUser`, `enforceTokenExpiry`), which are
   * meaningless without a user/token and forced off internally.
   */
  connection?: Partial<
    Omit<ConnectionConfig, "singleConnectionPerUser" | "enforceTokenExpiry">
  >;
  /** Partial heartbeat config overlay. */
  heartbeat?: Partial<HeartbeatConfig>;
  hooks?: AuthlessHooks;
  logger?: Logger;
  /** Test seam — fake clock. */
  clock?: Clock;
}
