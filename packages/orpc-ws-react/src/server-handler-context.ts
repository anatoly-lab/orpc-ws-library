// React context carrying ONLY the server→client handler `register` function.
//
// WHY a context SEPARATE from `OrpcWsContext` (ISP — CLAUDE.md "Interface
// segregation"). A feature component that merely registers a server→client
// handler (`useServerHandler`) has no business depending on the whole
// `OrpcWsClient` — it never sends RPCs, never reads connection state. So the
// registration capability rides its own minimal context: a single `register`
// callback. `<OrpcWs>` provides BOTH contexts; a consumer subscribes to exactly
// the one its need maps to.
//
// The value is the generic-ERASED `register`: the typed surface (which procedure
// names exist, their input/output) lives in `createServerHandlerHook`, the same
// way the typed c2s surface lives at the `useOrpcWs<TContract>()` read site, not
// in `OrpcWsContext`. `null` is the "no `<OrpcWs>` ancestor (or no
// `clientContract`)" sentinel — the hook throws then.

import { createContext } from "react";

import type { DelegatingHandler } from "@orpc-ws/client";

/**
 * Register a server→client handler under `name`, returning a dispose that
 * unregisters it. LAST registration for a name wins (overwrite); the returned
 * dispose deletes ONLY by identity, so an unmounting OLDER registration can
 * never clobber a NEWER one that replaced it (see `<OrpcWs>`'s registry).
 *
 * `DelegatingHandler` (`(input: unknown) => unknown`) is the core's erased leaf
 * type — the typed handler is wrapped down to it by `useServerHandler`.
 */
export type RegisterServerHandler = (
  name: string,
  handler: DelegatingHandler,
) => () => void;

/**
 * Context for the server→client `register` callback. `null` until an `<OrpcWs>`
 * with a `clientContract` provides it. Kept deliberately tiny (one function) so
 * a handler-registering component depends on nothing else.
 */
export const ServerHandlerContext = createContext<RegisterServerHandler | null>(
  null,
);
