// Module options for `OrpcWsModule`.
//
// We re-export the core's `OrpcWsServerOptions` 1:1 (no NestJS-specific
// fields). The adapter is a thin lifecycle wrapper — its job is to
// translate Nest's bootstrap / shutdown hooks into the core's
// `attach(httpServer)` + `dispose()`. Anything that affects WS behavior
// (router, verifyClient, heartbeat tunables, hooks, logger) belongs on
// the core's options, not on a parallel Nest-only type.
//
// The generic parameters mirror the core: `<TUser, TContract,
// TClientContract>`. All have defaults so consumers can write
// `OrpcWsModuleOptions` without any type args when they want erased-types
// ergonomics during composition (`forRootAsync`'s `useFactory` return type
// rarely needs the narrow `TUser`).
//
// `TClientContract` is the server→client RPC ("bidi") contract — the third
// generic the core's factories carry. It defaults to `never` (bidi OFF), so
// EXISTING non-bidi module configs are byte-identical: with the default,
// the threaded `clientContract?` field is typed `never` (un-passable) and
// `conn`/`getConnection` carry no `client`. A consumer opts in by passing a
// `clientContract` VALUE (let the generic be inferred from it — see the core
// `clientContract` doc for the type/runtime-divergence footgun).

import type {
  AnyContractRouter,
  AuthenticatedOrpcWsServerOptions,
  AuthlessOrpcWsServerOptions,
} from "@orpc-ws/server";

/**
 * Options accepted by `OrpcWsModule.forRoot` / `forRootAsync`.
 *
 * A discriminated union on an OPTIONAL `mode`:
 *   - `mode` ABSENT or `"authenticated"` → the full authenticated surface
 *     (`verifyClient` required, uploads / token-expiry / per-user close
 *     available). `mode` absent is the back-compat default, so existing
 *     consumers that pass `verifyClient` and no `mode` keep working
 *     UNCHANGED.
 *   - `mode: "authless"` → the authless surface (NO `verifyClient`, NO
 *     `uploads`, NO `enforceTokenExpiry`). Every upgrade is accepted; the
 *     consumer's procedures run with an empty ORPC context.
 *
 * `OrpcWsService` reads `mode` and dispatches to `createOrpcWsServer` vs
 * `createAuthlessOrpcWsServer`. The authenticated public options thread
 * through to the core 1:1 (including `uploads.beforeUpload`).
 *
 * Both arms inherit `interceptors` / `rootInterceptors` from the core option
 * types they intersect — the central-`onError`-logger passthrough — so they
 * flow to the dispatched factory with no Nest-side remap.
 *
 * All three generic params default so consumers can write
 * `OrpcWsModuleOptions` with no type args during composition. The optional
 * `clientContract` (server→client RPC) threads to whichever factory `mode`
 * dispatches to — omit it and the config is identical to today's non-bidi
 * behavior.
 */
export type OrpcWsModuleOptions<
  TUser = unknown,
  TContract extends object = object,
  TClientContract extends AnyContractRouter = never,
> =
  | ({ mode?: "authenticated" } & AuthenticatedOrpcWsServerOptions<
      TUser,
      TContract,
      TClientContract
    >)
  | ({ mode: "authless" } & AuthlessOrpcWsServerOptions<
      TContract,
      TClientContract
    >);
