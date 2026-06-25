// Public surface of @orpc-ws/cookie-bff-client.
//
// Framework-free BROWSER core for the cookie-BFF /auth/* control plane. See the
// README for the boundary: this owns the protocol glue (typed /auth/me, the
// in-memory synchronizer-CSRF token, the CSRF-aware mutate() wrapper, the
// login-URL builder, and a logout that RETURNS where to go) — and deliberately
// does NOT touch window.location / routing (navigation stays in the app) and
// has NO WebSocket coupling (the consumer creates its own createOrpcWsClient
// with no tokenProvider; this is the HTTP control plane only).
//
// Header `X-CSRF-Token` is the synchronizer token (§J / Decision #9): the
// server mints it at /auth/callback, stores it in the session, returns it in
// the /auth/me body; the SPA holds it ONLY in JS memory and echoes it here.
//
// ZERO runtime deps, and zero TYPE deps too — the /auth/me envelope is tiny and
// re-derived locally (see MeEnvelope) rather than imported from
// @orpc-ws/cookie-bff, so this package stays fully self-contained. The enriched
// user shape is the consumer's `TUser`; the library only validates the envelope
// and casts `body.user as TUser`.

export { createCookieBffAuthClient } from "./auth-client.js";
export type {
  CookieBffAuthClient,
  CookieBffAuthClientOptions,
  LogoutResult,
} from "./auth-client.js";
