// The two public factory functions.
//
// CLAUDE.md decision: TWO named factories (not an optional `verifyClient`
// on one), so the everyday name carries the authed path and authless is
// explicit:
//   - createOrpcWsServer        — AUTHENTICATED (verifyClient required).
//   - createAuthlessOrpcWsServer — AUTHLESS (no verifyClient/uploads/
//     enforceTokenExpiry/closeUser).
//
// Both normalize their PUBLIC option shape into the class's internal
// `OrpcWsServerOptions` and hand it to `new OrpcWsServer(...)`. The class
// is the single internal representation; these wrappers exist to give
// each mode a clean, mode-appropriate type surface (ISP) without leaking
// the other mode's knobs.
//
// Kept OUT of index.ts to respect the ~300-LOC ceiling (index.ts is the
// composition root and already over; CLAUDE.md "No god files").

import type { AnyContractRouter } from "@orpc/contract";
import type { WebSocket } from "ws";

import { OrpcWsServer, type OrpcWsServerOptions } from "../index.js";
import type { NoAuth } from "../state/no-auth.js";
import type {
  AuthlessConnection,
  ServerConnection,
} from "../state/connection.js";
import type {
  AuthenticatedOrpcWsServerOptions,
  AuthlessOrpcWsServerOptions,
} from "./server-options.js";

/**
 * The authless server's public surface: the class MINUS `closeUser`, with
 * `getConnection` re-typed to the user-less {@link AuthlessConnection}.
 * Authless has no per-user identity to target, so `closeUser` is removed; and
 * its `conn` carries no `user` (NoAuth is uninhabited), so the inherited
 * `getConnection` (which would surface a `NoAuth` user) is overridden with the
 * user-less handle. `attach`, `dispose`, `getHttpHandler` (always `null` here),
 * and `getUploadConfig` remain.
 */
export type AuthlessOrpcWsServer<
  TContract extends object,
  TClientContract extends AnyContractRouter = never,
> = Omit<
  OrpcWsServer<NoAuth, TContract, TClientContract>,
  "closeUser" | "getConnection"
> & {
  getConnection(key: string): AuthlessConnection<TClientContract> | undefined;
};

/**
 * Create an AUTHENTICATED ORPC-over-WS server. This is the everyday
 * factory — `verifyClient` is required, uploads / token-expiry / per-user
 * close are all available.
 *
 * Thin wrapper over `new OrpcWsServer(opts)`: the authed public options
 * are structurally a subset of the class's internal options, so no
 * field-by-field remap is needed.
 */
export function createOrpcWsServer<
  TUser,
  TContract extends object,
  TClientContract extends AnyContractRouter = never,
>(
  opts: AuthenticatedOrpcWsServerOptions<TUser, TContract, TClientContract>,
): OrpcWsServer<TUser, TContract, TClientContract> {
  // The authenticated public options are assignable to the internal
  // options 1:1 (hooks shapes match; `verifyClient` is present). The cast
  // names the seam between the public and internal option identities.
  // `TClientContract` is inferred from `opts.clientContract` (default `never`
  // → bidi off) and threaded straight through.
  return new OrpcWsServer<TUser, TContract, TClientContract>(
    opts as OrpcWsServerOptions<TUser, TContract, TClientContract>,
  );
}

/**
 * Create an AUTHLESS ORPC-over-WS server. Every upgrade is accepted; the
 * consumer's procedures run with an EMPTY context (`{}`). No
 * `verifyClient`, no uploads, no token-expiry enforcement, no per-user
 * close — the return type omits `closeUser` to make that absence
 * compile-time real.
 *
 * The authless hooks drop the (non-existent) user param; here we adapt
 * them to the internal user-typed hook shape. The user value the adapter
 * receives is the uninhabited `NoAuth` placeholder and is simply not
 * forwarded — the authless hook never sees it.
 */
export function createAuthlessOrpcWsServer<
  TContract extends object,
  TClientContract extends AnyContractRouter = never,
>(
  opts: AuthlessOrpcWsServerOptions<TContract, TClientContract>,
): AuthlessOrpcWsServer<TContract, TClientContract> {
  const h = opts.hooks;

  // Adapt the user-less authless hooks to the internal `(conn, …)` shape. Each
  // adapter strips the (uninhabited NoAuth) user from the conn, forwarding the
  // user-less `AuthlessConnection`.
  const internalHooks: OrpcWsServerOptions<
    NoAuth,
    TContract,
    TClientContract
  >["hooks"] = {};
  if (h?.onConnected) {
    const cb = h.onConnected;
    internalHooks.onConnected = (conn) => cb(toAuthlessConnection(conn));
  }
  if (h?.onDisconnected) {
    const cb = h.onDisconnected;
    internalHooks.onDisconnected = (conn, code) =>
      cb(toAuthlessConnection(conn), code);
  }
  if (h?.onZombieTerminated) {
    const cb = h.onZombieTerminated;
    internalHooks.onZombieTerminated = () => cb();
  }
  // Adapt the user-less authless `onKicked(replacedBy)` to the internal
  // registry hook shape `(user, replacedBy)` — dropping the (uninhabited
  // NoAuth) kicked user. Fires in the DEFAULT single-connection mode when a
  // new connection replaces the previous one.
  if (h?.onKicked) {
    const cb = h.onKicked;
    internalHooks.onKicked = (_user, replacedBy) => cb(replacedBy);
  }

  const internalOpts: OrpcWsServerOptions<NoAuth, TContract, TClientContract> = {
    router: opts.router,
    // No verifyClient → the class constructs in authless mode.
    hooks: internalHooks,
    // Thread the public single-vs-concurrent switch to the internal sub-mode
    // flag. Default (false/omitted) ⇒ single global connection (kick on
    // reconnect); `true` ⇒ concurrent connections coexist.
    authlessConcurrent: opts.allowConcurrentConnections === true,
  };
  if (opts.clientContract) internalOpts.clientContract = opts.clientContract;
  if (opts.connection) internalOpts.connection = opts.connection;
  if (opts.heartbeat) internalOpts.heartbeat = opts.heartbeat;
  if (opts.logger) internalOpts.logger = opts.logger;
  if (opts.clock) internalOpts.clock = opts.clock;
  if (opts.interceptors) internalOpts.interceptors = opts.interceptors;
  if (opts.rootInterceptors) internalOpts.rootInterceptors = opts.rootInterceptors;

  // The class returns the full surface; the narrowed return type hides
  // `closeUser` and re-types `getConnection` to the user-less handle.
  return new OrpcWsServer<NoAuth, TContract, TClientContract>(
    internalOpts,
  ) as AuthlessOrpcWsServer<TContract, TClientContract>;
}

/**
 * Strip the (uninhabited `NoAuth`) `user` off an authed conn to produce the
 * user-less {@link AuthlessConnection}. The conditional public conn types make
 * direct field access awkward, so we read through a flat record view; the
 * result cast names the conditional-type seam.
 */
function toAuthlessConnection<TClientContract extends AnyContractRouter>(
  conn: ServerConnection<NoAuth, TClientContract>,
): AuthlessConnection<TClientContract> {
  const c = conn as { key: string; ws: WebSocket; client?: unknown };
  return { key: c.key, ws: c.ws, client: c.client } as AuthlessConnection<
    TClientContract
  >;
}
