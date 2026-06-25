// Defensive fire-and-forget for the auth-flow metrics hooks (F1b).
//
// A consumer's `authEvents.*` hook must NEVER break the auth flow — same
// contract as session-slide. Each invocation is wrapped here: a throw is
// swallowed and logged via the injected `Logger`, the flow continues. These
// are synchronous fire-and-forget metrics hooks (we don't await them).

import type { Logger } from "@orpc-ws/shared";

/**
 * Invoke an auth-event hook defensively. `name` is for the warning message;
 * `run` performs the call (`() => events.onX?.(...)`). A throw is logged, not
 * propagated.
 */
export function fireAuthEvent(
  logger: Logger,
  name: string,
  run: () => void,
): void {
  try {
    run();
  } catch (err) {
    logger.warn(`[cookie-bff] authEvents.${name} threw (ignored)`, {
      reason: err instanceof Error ? err.message : "hook threw",
    });
  }
}
