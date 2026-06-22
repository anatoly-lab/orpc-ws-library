// Module options for `OrpcWsModule`.
//
// We re-export the core's `OrpcWsServerOptions` 1:1 (no NestJS-specific
// fields). The adapter is a thin lifecycle wrapper — its job is to
// translate Nest's bootstrap / shutdown hooks into the core's
// `attach(httpServer)` + `dispose()`. Anything that affects WS behavior
// (router, verifyClient, heartbeat tunables, hooks, logger) belongs on
// the core's options, not on a parallel Nest-only type.
//
// The generic parameters mirror the core: `<TUser, TContract>`. Both
// have defaults so consumers can write `OrpcWsModuleOptions` without
// any type args when they want erased-types ergonomics during
// composition (`forRootAsync`'s `useFactory` return type rarely needs
// the narrow `TUser`).

import type {
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
 * Both generic params default so consumers can write
 * `OrpcWsModuleOptions` with no type args during composition.
 */
export type OrpcWsModuleOptions<
  TUser = unknown,
  TContract extends object = object,
> =
  | ({ mode?: "authenticated" } & AuthenticatedOrpcWsServerOptions<
      TUser,
      TContract
    >)
  | ({ mode: "authless" } & AuthlessOrpcWsServerOptions<TContract>);
