// Public surface of @orpc-ws/cookie-bff.
//
// The framework-free cookie-BFF core: the server-side session store + PKCE
// seams, at-rest token encryption, the WS cookie verifier, server-side OIDC
// code-exchange + lazy single-flight refresh, the transport-agnostic /auth/*
// handlers, and best-effort revocation. In this topology no token ever reaches
// the browser — see docs/cookie-bff-server-design.md. NestJS wiring lives in
// the sibling @orpc-ws/cookie-bff-nestjs adapter (Phase 2).

// ── Composition root: the /auth/* handlers + config ──
export { createCookieBffCore } from "./composition/cookie-bff-core.js";
export type { CookieBffCore } from "./composition/cookie-bff-core.js";
export type {
  CookieBffOptions,
  KeycloakOptions,
  EndpointOptions,
  CookieOptions,
  RefreshPolicy,
} from "./composition/options.js";

// ── Handler I/O (transport-agnostic instructions) ──
export type {
  AuthInstruction,
  AuthRequest,
  CookieSpec,
} from "./handlers/instruction.js";

// ── WS cookie verifier ──
export { createCookieVerifyClient } from "./verifier/cookie-verify.js";
export type { CookieVerifyOptions } from "./verifier/cookie-verify.js";

// ── Revocation (local best-effort kick) ──
export { revokeUser } from "./revoke.js";
export type { CloseUser } from "./revoke.js";

// ── Session store seam (Decision #20) ──
export type { SessionStore, SessionData } from "./session-store.js";

// ── OIDC code-exchange / discovery / refresh / PKCE seam ──
export { OidcCodeExchange, TokenEndpointError } from "./oidc/code-exchange.js";
export type {
  OidcTokenSet,
  CodeExchangeConfig,
  CodeExchangeDeps,
} from "./oidc/code-exchange.js";
export { OidcDiscovery } from "./oidc/discovery.js";
export type { OidcEndpoints, Fetcher } from "./oidc/discovery.js";
export { RefreshManager } from "./oidc/refresh.js";
export type { RefreshResult, RefreshDeps } from "./oidc/refresh.js";
export { InMemoryPkceStore } from "./oidc/pkce-store.js";
export type { PkceStore } from "./oidc/pkce-store.js";
export { decodeIdTokenClaims } from "./oidc/claims.js";
export type { IdTokenClaims } from "./oidc/claims.js";

// ── sid minting ──
export { mintSid } from "./crypto/sid.js";

// ── At-rest token encryption (AES-256-GCM, key-id prefix) ──
export { createTokenCipher } from "./crypto/token-cipher.js";
export type {
  TokenCipher,
  TokenCipherOptions,
  CipherKeyInput,
  TokenSet,
  EncryptedTokenSet,
} from "./crypto/token-cipher.js";

// ── Constant-time compare (used by the oauth_state / CSRF matchers) ──
export { constantTimeEquals } from "./crypto/compare.js";

// ── Hardened cookie serialize / parse / clear ──
export {
  serializeCookie,
  parseCookie,
  clearCookie,
} from "./cookies/serialize.js";
export type { SerializeCookieOptions } from "./cookies/serialize.js";

// ── oauth_state login-CSRF cookie ──
export {
  OAUTH_STATE_COOKIE,
  DEFAULT_OAUTH_STATE_MAX_AGE_S,
  serializeOAuthStateCookie,
  clearOAuthStateCookie,
  oauthStateMatches,
} from "./cookies/oauth-state.js";
export type { OAuthStateCookieOptions } from "./cookies/oauth-state.js";

// ── CSRF (synchronizer-token: minted at /callback, stored in the session,
//    returned in the /auth/me body, validated header-vs-session at logout) ──
export {
  CSRF_HEADER,
  mintCsrfToken,
  csrfTokenValid,
} from "./cookies/csrf.js";
