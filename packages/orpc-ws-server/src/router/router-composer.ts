// Composes the consumer's router with the library's system fragment.
//
// Two responsibilities:
//
//   1. Eager collision check on the library-reserved namespace
//      (`__orpc_ws_lib__`). If the consumer's router happens to already
//      have a top-level key with that name, we throw IMMEDIATELY at
//      `OrpcWsServer` construction time — NOT at first request.
//      Surfacing the bug at startup matches CLAUDE.md "Tests from day 0
//      — non-negotiable" and CLAUDE.md "Configurable, not hardcoded"
//      (consumer can rename their route or upgrade the library).
//
//   2. The actual spread. `{...consumer, ...system}` order matters: the
//      system fragment wins if the consumer somehow snuck a colliding
//      key in. (We do the collision check FIRST, so this is defense in
//      depth.)
//
// Why eager (constructor-time) over lazy (first-request-time): startup
// errors are 1000× cheaper to debug than first-bad-request errors. A
// consumer reorganizing their contract has 30s of confusion vs a
// production outage. Implementation-plan.md §3 "Cross-cutting concerns"
// makes this explicit.

import { HEARTBEAT_NAMESPACE } from "@orpc-ws/shared";

/**
 * Spread the system router into the consumer's. Throws on collision.
 *
 * Generic in the consumer's router shape so the returned type carries
 * both fragments — the composition root uses it as the RPCHandler's
 * router type without losing the consumer's typing. The `Record<string,
 * unknown>` intersection on the return reflects the system fragment's
 * runtime shape; consumers never reach into it.
 */
export function composeRouter<TConsumerRouter extends object>(
  consumerRouter: TConsumerRouter,
  systemRouter: Record<string, unknown>,
): TConsumerRouter & Record<string, unknown> {
  if (HEARTBEAT_NAMESPACE in consumerRouter) {
    throw new Error(
      `[orpc-ws-server] Consumer router uses reserved library namespace ` +
        `'${HEARTBEAT_NAMESPACE}'. Rename your route or upgrade the library.`,
    );
  }
  return {
    ...consumerRouter,
    ...systemRouter,
  } as TConsumerRouter & Record<string, unknown>;
}
