// Server-side implementation of `@demo/authless-contract`.
//
// AUTHLESS: the library's authless mode hands every procedure an EMPTY ORPC
// context (`{}`) — no `user`, no `token` (see the core's
// `authless-context.test.ts`). NONE of these handlers read `context`, so we
// use a plain `implement(appContract)` builder with no `$context<...>()` —
// the handlers inherit the contract's input/output types and stay honest
// about the fact that there is no principal to read.
//
// Renaming a procedure on the contract surfaces as a compile error here, not
// as a runtime "procedure not found" — the whole point of the typed
// end-to-end pitch.

import { implement } from "@orpc/server";

import { appContract, type TickEvent } from "@demo/authless-contract";

const os = implement(appContract);

// Request/response RPC: round-trip the message, stamp a server timestamp.
const echo = os.echo.handler(({ input }) => ({
  message: input.message,
  at: Date.now(),
}));

// Mutable shared in-memory state. Module-level so every connection
// increments the SAME counter — the count persists across connections and
// even across the authless single-session takeover (opening a second tab
// KICKS the first with 4005, but the new tab keeps counting from where the
// shared counter left off). The simplest possible proof that an RPC can
// change server state and read it back. Not persisted: it resets when the
// process restarts, which is fine for a demo.
let counter = 0;
const increment = os.increment.handler(() => ({
  count: ++counter,
}));

// One tick roughly every second until the client aborts (disconnect,
// dispose, or unmount → ORPC threads the AbortSignal into the handler).
//
// Abort handling matches the library's heartbeat publisher
// (`packages/orpc-ws-server/src/heartbeat/publisher.ts`):
//   - sleep RESOLVES on abort (it does not reject) so the generator's loop
//     condition cleanly observes `signal.aborted` and returns. Rejecting
//     from the sleep would throw out of the generator and surface to the WS
//     adapter as a spurious stream error instead of a clean close.
//   - the abort listener removes itself on resolve so we don't leak
//     listeners across iterations.
const TICK_INTERVAL_MS = 1_000;

const ticks = os.ticks.handler(
  async function* ({ signal }): AsyncGenerator<TickEvent> {
    // Demo guard: if ORPC's WS adapter ever stops supplying a signal,
    // refuse to start rather than leak a forever-running setTimeout. In
    // practice the adapter always supplies one; belt-and-suspenders.
    if (!signal) return;

    let n = 0;
    while (!signal.aborted) {
      yield { tick: ++n, at: Date.now() };
      if (signal.aborted) return;

      await new Promise<void>((resolve) => {
        const onAbort = (): void => {
          clearTimeout(id);
          resolve();
        };
        const id = setTimeout(() => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        }, TICK_INTERVAL_MS);
        signal.addEventListener("abort", onAbort, { once: true });
      });
    }
  },
);

export const appRouter = {
  echo,
  increment,
  ticks,
};
