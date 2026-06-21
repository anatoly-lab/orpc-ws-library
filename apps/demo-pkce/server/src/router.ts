// Server-side implementation of `@demo/pkce-contract`.
//
// The library hands every procedure a context shaped like:
//   { user: DemoUser, token: string | null }
// (see `OrpcWsServer.connection-handler.ts` — the connection handler
// calls `rpcHandler.upgrade(ws, { context: { user, token } })`).
//
// We use ORPC's `implement(contract)` builder so the procedure handlers
// inherit the contract's input/output types AND we get the context
// narrowed via `$context<...>()`. Renaming a procedure on the contract
// would surface as a compile error here, not as a runtime "procedure
// not found" — the whole point of the typed-end-to-end pitch.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { implement } from "@orpc/server";

import { appContract, type TickEvent } from "@demo/pkce-contract";
import type { OidcUser } from "@orpc-ws/oidc-verifier-jose";

// The demo uses the library's default `OidcUser` shape verbatim —
// no custom `mapUser` is wired in the auth app-modules
// (`auth/<mode>/<mode>.app-module.ts`). If the demo ever
// needs Keycloak-specific claims (roles, realm_access), swap this for
// a local `DemoUser` interface and pass a `mapUser` to the verifier.
interface DemoContext {
  user: OidcUser;
  token: string | null;
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

// Image upload, arriving over the library's opt-in HTTP transport rather
// than the WS. The HTTP upload path injects only `context: { user }` — NOT
// `token` — so this handler must not read `context.token`; it doesn't need
// to. ORPC has already decoded the multipart `file` field into a `File`.
//
// We write to `<cwd>/uploads`, sanitizing the supplied name into the stored
// filename so a malicious `name` can't traverse out of the directory or
// inject path separators.
const uploadImage = os.uploadImage.handler(async ({ input }) => {
  const dir = join(process.cwd(), "uploads");
  await mkdir(dir, { recursive: true });
  const safe = `${Date.now()}-${(input.name ?? "image").replace(/[^\w.-]/g, "_")}`;
  const buf = Buffer.from(await input.file.arrayBuffer());
  await writeFile(join(dir, safe), buf);
  return { ok: true as const, storedAs: safe, size: buf.byteLength };
});

export const appRouter = {
  ping,
  echo,
  getUser,
  tick,
  uploadImage,
};
