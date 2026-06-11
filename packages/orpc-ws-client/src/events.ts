// Client notification events — the `onEvent(evt)` channel.
//
// Extracted from the composition root so collaborators (e.g.
// `ClientLifecycle`) can depend on the `ClientEvent` type without importing
// the package barrel (`index.ts`), which would be a circular import. The
// public surface re-exports this from `index.ts`, so consumers' import paths
// are unchanged.

/**
 * Notifications worth reacting to imperatively (toast, redirect, log).
 *
 * NOT a state-transition channel — state transitions live on
 * `state.subscribe(cb)`. CLAUDE.md §"State vs events: separate concerns".
 */
export type ClientEvent =
  | {
      type: "auth_failure";
      /**
       * `true` when the library is going to attempt a refresh (the
       * EventHandlers close-decision routed to auth-recovery). `false`
       * when the library has given up (storm guard tripped or refresh
       * returned null) — pair with `onTerminalAuthFailure` for cleanup.
       */
      refreshable: boolean;
    }
  | { type: "heartbeat_timeout" }
  | { type: "woke_from_sleep"; sleepDurationMs: number };
