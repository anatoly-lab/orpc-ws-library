// Public per-connection handle (`conn`) types.
//
// Phase 5a (server→client bidi integration). A `conn` is the single object the
// lifecycle hooks (`onConnected` / `onDisconnected`) receive and the one
// `server.getConnection(key)` returns — replacing the old positional
// `(user, ws)` / `(user, code, ws)` hook arguments. It bundles the registry
// key, the live `ws` socket, the verified user (authed mode only), and — when
// the server was built with a `clientContract` — the typed server→client caller
// `client`.
//
// WHY the `client` field is CONDITIONAL on `TClientContract`:
//   The server→client (`s2c`) RPC channel only exists when a server opts into
//   bidi by passing a `clientContract`. The third class generic
//   (`TClientContract`) defaults to `never` to mean "no client contract / bidi
//   off". We model that absence at the TYPE level: when `TClientContract` is
//   `never`, the conn has NO `client` property at all (reaching for
//   `conn.client` is a compile error), so a non-bidi consumer can never
//   accidentally depend on a caller that does not exist. When a real contract
//   is supplied, `client` is a required `ContractRouterClient<TClientContract>`.
//
// The single-element tuple wrap (`[T] extends [never]`) defeats distributive
// conditional types so a union `TClientContract` is tested as a whole — and so
// the `never` default is matched exactly rather than distributed away.

import type { AnyContractRouter, ContractRouterClient } from "@orpc/contract";
import type { WebSocket } from "ws";

/** Fields common to every connection handle, regardless of auth mode. */
interface ConnectionBase {
  /** The registry key this connection is filed under. */
  readonly key: string;
  /** The live server-side `ws` socket. */
  readonly ws: WebSocket;
}

/**
 * The AUTHENTICATED connection handle. Carries the verified `user`. `client` is
 * present ONLY when the server was constructed with a `clientContract`
 * (`TClientContract` is not the `never` default).
 *
 * @typeParam TUser            The consumer's verified-principal type.
 * @typeParam TClientContract  The CLIENT's contract router type, or `never`
 *   (the default) when bidi is off — in which case there is no `client` field.
 */
export type ServerConnection<
  TUser,
  TClientContract extends AnyContractRouter = never,
> = [TClientContract] extends [never]
  ? ConnectionBase & { readonly user: TUser }
  : ConnectionBase & {
      readonly user: TUser;
      readonly client: ContractRouterClient<TClientContract>;
    };

/**
 * The AUTHLESS connection handle. Same shape as {@link ServerConnection} but
 * with NO `user` — authless carries no authenticated principal (see
 * `state/no-auth.ts`). `client` is conditional on `TClientContract` exactly as
 * in the authed case.
 */
export type AuthlessConnection<
  TClientContract extends AnyContractRouter = never,
> = [TClientContract] extends [never]
  ? ConnectionBase
  : ConnectionBase & {
      readonly client: ContractRouterClient<TClientContract>;
    };
