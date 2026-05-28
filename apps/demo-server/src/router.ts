// Server-side implementation of `@demo/contract`.
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

import { implement } from "@orpc/server";

import { appContract } from "@demo/contract";
import type { OidcUser } from "@repo/oidc-verifier-jose";

// The demo uses the library's default `OidcUser` shape verbatim —
// no custom `mapUser` is wired in `app.module.ts`. If the demo ever
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

export const appRouter = {
  ping,
  echo,
};
