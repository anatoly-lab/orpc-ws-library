// Lazy, single-flight access-token refresh (§F).
//
// In cookie-BFF the WS pipe follows the SESSION window, not the access token,
// so the access token is refreshed ONLY on demand — when a downstream call
// actually needs the user's live Keycloak token (rare for this app, which
// calls its services with a service secret). There is NO background loop.
//
// SINGLE-FLIGHT: concurrent callers for the same `sid` share ONE in-flight
// refresh (a per-sid promise map), so a burst of demand can't fire N parallel
// token-endpoint calls — which, under refresh-token rotation, would
// self-invalidate the grant (one rotation wins, the rest 400). The shared
// promise is cleared in a `finally` so the next demand after it settles
// starts fresh.
//
// TERMINAL vs TRANSIENT: when Keycloak's session truly ends, the refresh
// grant is dead and the IdP answers 4xx — that is TERMINAL (the caller must
// end our session: delete it + close the socket). A 5xx / network error is
// TRANSIENT (retry later; keep the session). The return type is a
// discriminated union carrying that distinction; this module never deletes
// the session itself (the caller owns that policy).

import { type Clock, type Logger, noopLogger, systemClock } from "@orpc-ws/shared";

import {
  type OidcCodeExchange,
  TokenEndpointError,
} from "./code-exchange.js";
import type { TokenCipher } from "../crypto/token-cipher.js";
import type { SessionData, SessionStore } from "../session-store.js";

/**
 * Outcome of a refresh attempt.
 *  - `ok: true`  → fresh access token; the store was updated (window slid).
 *  - `ok: false, terminal: true`  → the grant is dead (Keycloak session
 *    ended). The caller MUST end the session.
 *  - `ok: false, terminal: false` → transient (5xx / network / no refresh
 *    token). The caller keeps the session and may retry later.
 */
export type RefreshResult =
  | { ok: true; accessToken: string }
  | { ok: false; terminal: boolean; reason: string };

/** Collaborators for {@link RefreshManager}. */
export interface RefreshDeps<TUser> {
  store: SessionStore<TUser>;
  cipher: TokenCipher;
  exchange: OidcCodeExchange;
  /** Session window TTL, seconds — re-stamped on each refresh (slid). */
  sessionTtlSeconds: number;
  clock?: Clock;
  logger?: Logger;
}

/**
 * Owns lazy single-flight refresh over the session store. Construct once;
 * call `refresh(sid)` whenever a live access token is needed.
 */
export class RefreshManager<TUser> {
  private readonly inFlight = new Map<string, Promise<RefreshResult>>();
  private readonly clock: Clock;
  private readonly logger: Logger;

  constructor(private readonly deps: RefreshDeps<TUser>) {
    this.clock = deps.clock ?? systemClock;
    this.logger = deps.logger ?? noopLogger;
  }

  /**
   * Refresh the access token for `sid` if needed, sharing one in-flight call
   * across concurrent callers for the same sid. Resolves the {@link RefreshResult}.
   */
  refresh(sid: string): Promise<RefreshResult> {
    const existing = this.inFlight.get(sid);
    if (existing) return existing;

    const promise = this.doRefresh(sid).finally(() => {
      // Clear AFTER settle so the next demand starts a fresh refresh, but all
      // callers that joined while it was running share this one result.
      this.inFlight.delete(sid);
    });
    this.inFlight.set(sid, promise);
    return promise;
  }

  private async doRefresh(sid: string): Promise<RefreshResult> {
    const session = await this.deps.store.get(sid);
    if (!session) {
      // No drawer — already revoked/expired. Terminal from the caller's POV.
      return { ok: false, terminal: true, reason: "Unknown session" };
    }
    if (session.enc.refreshToken === null) {
      // The IdP withheld a refresh token — nothing to refresh with. Not a
      // dead grant per se, but unrecoverable without re-login → terminal.
      return { ok: false, terminal: true, reason: "No refresh token stored" };
    }

    let refreshToken: string;
    try {
      refreshToken = this.deps.cipher.decrypt(session.enc.refreshToken);
    } catch {
      // A ciphertext we can't decrypt (key rotated past the grace window,
      // corrupt store) is unrecoverable → terminal.
      return {
        ok: false,
        terminal: true,
        reason: "Stored refresh token undecryptable",
      };
    }

    try {
      const tokens = await this.deps.exchange.refreshTokens(refreshToken);
      // Persist the (possibly rotated) tokens and slide the session window.
      const now = this.clock.now();
      const updated: SessionData<TUser> = {
        ...session,
        enc: this.deps.cipher.encryptTokenSet({
          accessToken: tokens.accessToken,
          // Keep the prior refresh token if the IdP didn't rotate one.
          refreshToken: tokens.refreshToken ?? refreshToken,
          idToken: tokens.idToken ?? null,
        }),
        accessTokenExpiresAt: now + tokens.expiresIn * 1000,
        sessionExpiresAt: now + this.deps.sessionTtlSeconds * 1000,
      };
      await this.deps.store.set(sid, updated, {
        ttlSeconds: this.deps.sessionTtlSeconds,
      });
      return { ok: true, accessToken: tokens.accessToken };
    } catch (err) {
      // 4xx ⇒ the grant is dead (Keycloak session ended) ⇒ terminal.
      // 5xx / network ⇒ transient ⇒ keep the session.
      const terminal =
        err instanceof TokenEndpointError &&
        err.status >= 400 &&
        err.status < 500;
      const reason = err instanceof Error ? err.message : "refresh failed";
      this.logger.warn("[cookie-bff] token refresh failed", {
        terminal,
        reason,
      });
      return { ok: false, terminal, reason };
    }
  }
}
