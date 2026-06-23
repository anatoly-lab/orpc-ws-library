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

import type { WebSocket } from "ws";

import { OrpcWsServer, type OrpcWsServerOptions } from "../index.js";
import type { NoAuth } from "../state/no-auth.js";
import type {
  AuthenticatedOrpcWsServerOptions,
  AuthlessOrpcWsServerOptions,
} from "./server-options.js";

/**
 * The authless server's public surface: the class MINUS `closeUser`.
 * Authless has no per-user identity to target, so `closeUser` is removed
 * from the returned type. `start`-equivalents (`attach`), `dispose`,
 * `getHttpHandler` (always returns `null` here), and `getUploadConfig`
 * remain.
 */
export type AuthlessOrpcWsServer<TContract extends object> = Omit<
  OrpcWsServer<NoAuth, TContract>,
  "closeUser"
>;

/**
 * Create an AUTHENTICATED ORPC-over-WS server. This is the everyday
 * factory — `verifyClient` is required, uploads / token-expiry / per-user
 * close are all available.
 *
 * Thin wrapper over `new OrpcWsServer(opts)`: the authed public options
 * are structurally a subset of the class's internal options, so no
 * field-by-field remap is needed.
 */
export function createOrpcWsServer<TUser, TContract extends object>(
  opts: AuthenticatedOrpcWsServerOptions<TUser, TContract>,
): OrpcWsServer<TUser, TContract> {
  // The authenticated public options are assignable to the internal
  // options 1:1 (hooks shapes match; `verifyClient` is present). The cast
  // names the seam between the public and internal option identities.
  return new OrpcWsServer<TUser, TContract>(
    opts as OrpcWsServerOptions<TUser, TContract>,
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
export function createAuthlessOrpcWsServer<TContract extends object>(
  opts: AuthlessOrpcWsServerOptions<TContract>,
): AuthlessOrpcWsServer<TContract> {
  const h = opts.hooks;

  // Adapt the user-less authless hooks to the internal `(user, …)` shape.
  // Each adapter ignores the `NoAuth` user (it can't be read anyway) and
  // forwards only the user-independent args.
  const internalHooks: OrpcWsServerOptions<NoAuth, TContract>["hooks"] = {};
  if (h?.onConnected) {
    const cb = h.onConnected;
    internalHooks.onConnected = (_user: NoAuth, ws: WebSocket) => cb(ws);
  }
  if (h?.onDisconnected) {
    const cb = h.onDisconnected;
    internalHooks.onDisconnected = (_user: NoAuth, code: number, ws: WebSocket) =>
      cb(code, ws);
  }
  if (h?.onZombieTerminated) {
    const cb = h.onZombieTerminated;
    internalHooks.onZombieTerminated = () => cb();
  }

  const internalOpts: OrpcWsServerOptions<NoAuth, TContract> = {
    router: opts.router,
    // No verifyClient → the class constructs in authless mode.
    hooks: internalHooks,
  };
  if (opts.connection) internalOpts.connection = opts.connection;
  if (opts.heartbeat) internalOpts.heartbeat = opts.heartbeat;
  if (opts.logger) internalOpts.logger = opts.logger;
  if (opts.clock) internalOpts.clock = opts.clock;
  if (opts.interceptors) internalOpts.interceptors = opts.interceptors;
  if (opts.rootInterceptors) internalOpts.rootInterceptors = opts.rootInterceptors;

  // The class returns the full surface; the narrowed return type hides
  // `closeUser` from authless consumers (it would no-op anyway — no user
  // keys exist to look up).
  return new OrpcWsServer<NoAuth, TContract>(internalOpts);
}
