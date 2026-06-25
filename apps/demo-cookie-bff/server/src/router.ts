// Server-side implementation of `@demo/cookie-bff-contract`.
//
// In cookie-BFF the library's cookie verifier attaches the ENRICHED app user
// as the procedure context `{ user: DemoUser }` (no per-procedure `token` —
// the SPA never holds one; the server holds the tokens in the session store).
//
// We use ORPC's `implement(contract)` builder so the procedure handlers
// inherit the contract's input/output types AND we get the context
// narrowed via `$context<...>()`. Renaming a procedure on the contract
// would surface as a compile error here, not as a runtime "procedure
// not found" — the whole point of the typed-end-to-end pitch.

import { implement } from "@orpc/server";

import { appContract, type TickEvent } from "@demo/cookie-bff-contract";
import type { DemoUser } from "./auth/demo-user.js";

// In cookie-BFF the library's cookie verifier attaches the ENRICHED app user
// (`DemoUser` — the object `resolveUser` returned at /auth/callback, complete
// with the demo's `role`) as `context.user` on every procedure. There is no
// per-procedure `token` in this mode (the SPA never holds one; the server
// holds the tokens in the session store), so the context is just `{ user }`.
interface DemoContext {
  user: DemoUser;
}

const os = implement(appContract).$context<DemoContext>();

const ping = os.ping.handler(() => ({
  pong: true as const,
  at: Date.now(),
}));

const echo = os.echo.handler(({ input, context }) => ({
  echoed: input.message,
  // Prefer email — readable in the SPA — fall back to subject claim.
  user: context.user.email ?? context.user.sub,
}));

// Server-roundtrip "who am I". The library populates `context.user`
// from the verified id_token in `verifyClient`; this handler is the
// proof that propagation reaches the procedure intact.
const getUser = os.getUser.handler(({ context }) => ({
  sub: context.user.sub,
  email: context.user.email,
  name: context.user.name,
}));

// One tick every 15 seconds until the client aborts (disconnect,
// dispose, or unmount → ORPC threads the AbortSignal into the handler).
//
// Abort handling matches the library's heartbeat publisher
// (`packages/orpc-ws-server/src/heartbeat/publisher.ts`):
//   - sleep RESOLVES on abort (it does not reject) so the generator's
//     loop condition cleanly observes `signal.aborted` and returns.
//     Rejecting from the sleep would throw out of `gen()` and surface
//     to the WS adapter as a spurious stream error instead of a clean
//     close.
//   - the abort listener removes itself on resolve so we don't leak
//     listeners across iterations.
const TICK_INTERVAL_MS = 15_000;

const tick = os.tick.handler(
  async function* ({ signal }): AsyncGenerator<TickEvent> {
    // Demo guard: if ORPC's WS adapter ever stops supplying a signal,
    // refuse to start rather than leak a forever-running setTimeout.
    // In practice the adapter always supplies one; this is belt-and-
    // suspenders to keep the loop honest.
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

// No `uploadImage` handler: cookie-BFF has no HTTP upload transport (the
// upload path authenticates via a Bearer token this mode doesn't hold), so the
// procedure is omitted from the contract too — see contract/src/index.ts.

export const appRouter = {
  ping,
  echo,
  getUser,
  tick,
};
