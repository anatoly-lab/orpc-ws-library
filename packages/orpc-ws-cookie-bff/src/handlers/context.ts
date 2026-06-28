// Resolved, defaults-applied collaborators the /auth/* handlers share.
//
// The composition root (createCookieBffCore) builds ONE of these from the
// public `CookieBffOptions`, then each handler is a pure function over it.
// Keeping it here (next to the handlers) avoids a circular import with the
// composition root.

import type { Clock, Logger } from "@orpc-ws/shared";

import type { OidcCodeExchange } from "../oidc/code-exchange.js";
import type { OidcDiscovery } from "../oidc/discovery.js";
import type { IdTokenClaims } from "../oidc/claims.js";
import type { OidcTokenSet } from "../oidc/code-exchange.js";
import type { TokenCipher } from "../crypto/token-cipher.js";
import type { SessionStore } from "../session-store.js";
import type { AuthEvents } from "../composition/options.js";

/** Cookie attributes resolved from config, shared by every Set-Cookie. */
export interface ResolvedCookieConfig {
  sessionCookieName: string;
  sameSite: "lax" | "strict";
  secure: boolean;
  hostPrefix: boolean;
  cookieMaxAge: number;
}

/** Everything the handlers need, fully resolved (no optionals). */
export interface HandlerContext<TUser> {
  store: SessionStore<TUser>;
  cipher: TokenCipher;
  exchange: OidcCodeExchange;
  discovery: OidcDiscovery;
  resolveUser: (
    claims: IdTokenClaims,
    tokens: OidcTokenSet,
    rawClaims: Record<string, unknown>,
  ) => Promise<TUser>;
  /** Fire-and-forget auth-flow metrics hooks (best-effort; never break a flow). */
  authEvents: AuthEvents<TUser>;
  cookies: ResolvedCookieConfig;
  /**
   * oauth_state cookie attributes. `sameSite` is DECOUPLED from the session
   * cookie (defaults to "lax", see `DEFAULT_STATE_SAME_SITE`) because the state
   * cookie rides a top-level GET callback redirect that a cross-site login hop
   * would make cross-site-initiated; `secure` is shared with the session cookie.
   */
  stateCookie: { sameSite: "lax" | "strict"; secure: boolean };
  sessionTtlSeconds: number;
  /** Re-stamp `sessionExpiresAt` on `/me` (and verifier) — rolling window. */
  slideSessionOnActivity: boolean;
  spaRedirectUri: string;
  postLogoutRedirectUri: string;
  /** Discovery base (issuerUrl or its override) for end-session lookup. */
  discoveryUrl: string;
  clock: Clock;
  logger: Logger;
}
