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

import type { OrpcWsServerOptions } from "@orpc-ws/server";

/**
 * Options accepted by `OrpcWsModule.forRoot` / `forRootAsync`. Mirrors
 * `OrpcWsServerOptions` from the core verbatim — the NestJS adapter
 * adds no transport-level config of its own.
 *
 * Because this is a verbatim alias, every core field threads through 1:1
 * without any adapter code — including `uploads.beforeUpload` (the
 * pre-body-buffer upload gate). `OrpcWsService` constructs the core with
 * `new OrpcWsServer(this.options)`, so the consumer's `beforeUpload`
 * reaches the HTTP upload handler unchanged; there is intentionally no
 * Nest-only duplicate of it here.
 */
export type OrpcWsModuleOptions<
  TUser = unknown,
  TContract extends object = object,
> = OrpcWsServerOptions<TUser, TContract>;
