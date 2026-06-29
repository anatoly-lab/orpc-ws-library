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

import type { AnyContractRouter } from "@orpc/contract";
import type { Clock, Logger } from "@orpc-ws/shared";
import type { WebSocket } from "ws";

import type {
  OrpcWsInterceptors,
  OrpcWsRootInterceptors,
} from "../index.js";
import type { ConnectionConfig } from "../config/connection-config.js";
import type { HeartbeatConfig } from "../config/heartbeat-config.js";
import type { VerifyClient } from "../lifecycle/verify-client-orchestrator.js";
import type { UploadHttpConfig } from "../upload/http-config.js";
import type {
  AuthlessConnection,
  ServerConnection,
} from "../state/connection.js";

// ----- Hook bundles -----

/**
 * Lifecycle hooks for the AUTHENTICATED server. All optional; all receive
 * the typed `TUser` payload.
 *
 * (This is the historical `OrpcWsServerHooks<TUser>` shape; index.ts
 * re-exports it under both names for back-compat.)
 */
export interface AuthenticatedHooks<
  TUser,
  TClientContract extends AnyContractRouter = never,
> {
  /**
   * Fires once per accepted connection. Receives the single `conn` handle
   * (`{ key, user, ws }`, plus a typed `client` when the server has a
   * `clientContract`) — NOT positional `(user, ws)` args.
   */
  onConnected?: (conn: ServerConnection<TUser, TClientContract>) => void;
  /**
   * Fires once on connection close, with the close `code`.
   *
   * By the time this fires the connection is ALREADY torn down: `conn.client`
   * is still a live reference but any call on it REJECTS (the s2c peer is
   * closed). Do NOT invoke `conn.client` from `onDisconnected`.
   */
  onDisconnected?: (
    conn: ServerConnection<TUser, TClientContract>,
    code: number,
  ) => void;
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
export interface AuthlessHooks<TClientContract extends AnyContractRouter = never> {
  /**
   * Fires once per accepted connection. Receives the user-less `conn` handle
   * (`{ key, ws }`, plus a typed `client` when a `clientContract` is supplied).
   */
  onConnected?: (conn: AuthlessConnection<TClientContract>) => void;
  /**
   * Fires once on connection close, with the close `code`.
   *
   * By the time this fires the connection is ALREADY torn down: `conn.client`
   * is still a live reference but any call on it REJECTS (the s2c peer is
   * closed). Do NOT invoke `conn.client` from `onDisconnected`.
   */
  onDisconnected?: (
    conn: AuthlessConnection<TClientContract>,
    code: number,
  ) => void;
  /** Fires after the watchdog terminates a zombie connection. */
  onZombieTerminated?: () => void;
}

// ----- Option shapes -----

/**
 * Options for `createOrpcWsServer` — the AUTHENTICATED factory. This is
 * the library's everyday surface: `verifyClient` is REQUIRED, and the
 * full feature set (uploads, token-expiry enforcement, per-user
 * close/kick) is available.
 *
 * @typeParam TClientContract  The CLIENT's contract router (bidi). Let it be
 *   INFERRED from the `clientContract` VALUE — never specify it explicitly (see
 *   the `clientContract` field doc for the type/runtime-divergence footgun).
 */
export interface AuthenticatedOrpcWsServerOptions<
  TUser,
  TContract extends object,
  TClientContract extends AnyContractRouter = never,
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
  /**
   * Opt into server→client RPC ("bidi"). The CLIENT's contract router — the
   * set of procedures the client will answer. Its PRESENCE turns bidi on for
   * this server: every connection gets a multiplexed socket and a typed
   * `conn.client` caller (`ContractRouterClient<TClientContract>`). Omit it
   * (the default) and the server is byte-identical to a non-bidi server — no
   * multiplexer, no `client`. The value drives type inference; it is not
   * otherwise read at runtime (the caller proxy is fully dynamic).
   *
   * ALWAYS pass this VALUE and let `TClientContract` be INFERRED from it —
   * never specify the third generic explicitly. The runtime bidi switch is
   * `clientContract !== undefined`, but `conn.client`'s TYPE presence is driven
   * by the `TClientContract` generic; the two are independent and TS cannot
   * bind them. So `createOrpcWsServer<U, R, SomeContract>({ router, verifyClient })`
   * (generic given, value OMITTED) compiles and types `conn.client` as PRESENT
   * while it is `undefined` at runtime — a footgun. Passing the value keeps the
   * type and the runtime in lockstep.
   */
  clientContract?: TClientContract;
  /** Partial connection config overlay. */
  connection?: Partial<ConnectionConfig>;
  /** Partial heartbeat config overlay. */
  heartbeat?: Partial<HeartbeatConfig>;
  hooks?: AuthenticatedHooks<TUser, TClientContract>;
  logger?: Logger;
  /** Test seam — fake clock. */
  clock?: Clock;
  /** Opt-in HTTP transport for file uploads. */
  uploads?: Partial<UploadHttpConfig<TUser>>;
  /**
   * ORPC handler-level interceptors, forwarded to BOTH internally-built
   * RPCHandlers (WS + the optional HTTP upload handler). The common use is a
   * single central error logger that covers EVERY procedure — including
   * sub-routers spread in unwrapped:
   *   interceptors: [ onError((e) => logger.error({ err: e }, "orpc error")) ]
   * (import `onError` from "@orpc/server"). See `OrpcWsServerOptions` in the
   * core for the full coverage caveats (no mid-stream errors, no pre-ORPC
   * upload rejects, heartbeat runs with empty context).
   */
  interceptors?: OrpcWsInterceptors;
  /**
   * ORPC ROOT interceptors (the outer layer), forwarded to both handlers. By
   * the time these run a thrown procedure error has ALREADY been encoded into
   * a response, so a rootInterceptor `onError` will NOT fire on a procedure
   * throw — use `interceptors` to log thrown errors, `rootInterceptors` for
   * whole-response shaping / top-level tracing.
   */
  rootInterceptors?: OrpcWsRootInterceptors;
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
 *
 * @typeParam TClientContract  The CLIENT's contract router (bidi). Let it be
 *   INFERRED from the `clientContract` VALUE — never specify it explicitly (see
 *   the `clientContract` field doc for the type/runtime-divergence footgun).
 */
export interface AuthlessOrpcWsServerOptions<
  TContract extends object,
  TClientContract extends AnyContractRouter = never,
> {
  /** The consumer's ORPC router. Same contract as the authed options. */
  router: TContract;
  /**
   * Opt into server→client RPC ("bidi"). Same semantics as the authenticated
   * option — its presence turns bidi on and gives every (user-less) connection
   * a typed `conn.client`. Authless supports bidi: the conn simply carries no
   * `user`.
   *
   * ALWAYS pass this VALUE and let `TClientContract` be INFERRED from it —
   * never specify the second generic explicitly. The runtime bidi switch is
   * `clientContract !== undefined`, but `conn.client`'s TYPE presence is driven
   * by `TClientContract`; the two are independent and TS cannot bind them.
   * Specifying the generic without the value types `conn.client` as PRESENT
   * while it is `undefined` at runtime — a footgun. Passing the value keeps the
   * type and the runtime in lockstep.
   */
  clientContract?: TClientContract;
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
  hooks?: AuthlessHooks<TClientContract>;
  logger?: Logger;
  /** Test seam — fake clock. */
  clock?: Clock;
  /**
   * ORPC handler-level interceptors, forwarded to the WS RPCHandler. The
   * common use is a single central error logger covering EVERY procedure —
   * including sub-routers spread in unwrapped:
   *   interceptors: [ onError((e) => logger.error({ err: e }, "orpc error")) ]
   * (import `onError` from "@orpc/server"). Authless has no HTTP upload
   * transport, so these wrap only the WS handler. The interceptor sees the
   * empty `{}` authless context (no `user`/`token`).
   */
  interceptors?: OrpcWsInterceptors;
  /**
   * ORPC ROOT interceptors (the outer layer), forwarded to the WS handler.
   * Procedure throws are already encoded into a response by the time these
   * run — use `interceptors` to log thrown errors, `rootInterceptors` for
   * whole-response shaping / top-level tracing.
   */
  rootInterceptors?: OrpcWsRootInterceptors;
}
