// The session-store seam (Decision #20) + the on-disk session shape.
//
// In the cookie-BFF model the server is "the drawer": it holds the user's
// Keycloak tokens server-side and hands the browser only an opaque `sid`
// (the "locker number"). `SessionStore` is the seam the consumer plugs a
// backend into (NATS KV, Redis, SQL, …); the library is agnostic to which.
//
// CONTRACT: the LIBRARY mints the `sid` (256-bit random — see crypto/sid.ts)
// and is the sole writer of `SessionData`. The store only persists by key.
// It never invents ids, never mutates the value, and never inspects `enc`
// (which is ciphertext — see crypto/token-cipher.ts).

/**
 * The server-side session record — one per live login.
 *
 * The enriched app `user` and the encrypted Keycloak `enc` token-set both
 * live here (Decision #22). The verifier reads `user` back at WS-upgrade
 * time and `/auth/me` reads it for the SPA; nothing downstream of `/callback`
 * ever has to re-derive identity from a raw token.
 *
 * The tokens in `enc` are ALWAYS ciphertext — they are encrypted at rest with
 * the consumer's key before they reach the store and decrypted only in
 * library memory when actually needed (a lazy refresh, RP-initiated logout).
 * A leaked store dump must not yield usable Keycloak credentials.
 */
export interface SessionData<TUser> {
  /**
   * Keycloak subject (`sub` claim). Doubles as the WS `connectionKey`
   * (last-wins single-connection-per-user) and the `deleteByUser` key.
   */
  sub: string;

  /**
   * The ENRICHED application user (DB id, role, email, name, avatar, …) as
   * returned by the consumer's `resolveUser` hook at `/callback`. This is
   * exactly what the verifier attaches to the WS connection and what
   * `/auth/me` echoes — no identity is lost between login and the socket.
   */
  user: TUser;

  /**
   * The session's CSRF token (synchronizer-token pattern, §J / Decision #9).
   * Minted server-side at `/callback`, stored HERE in the session, returned in
   * the `/auth/me` response BODY (the SPA holds it in JS memory), and echoed
   * back in the `X-CSRF-Token` header on mutating requests (logout) where the
   * server validates header-vs-this-stored-value in constant time.
   *
   * NOT a secret like the refresh token — it's only meaningful PAIRED with the
   * session, so it lives plaintext alongside `sub` (not under `enc`). A leaked
   * store dump exposing it grants nothing without the matching `sid` cookie.
   */
  csrfToken: string;

  /**
   * Keycloak tokens, ENCRYPTED at rest (ciphertext strings — the
   * self-describing `v1:<keyId>:…` envelope from crypto/token-cipher.ts).
   * NEVER store plaintext here.
   */
  enc: {
    /** Encrypted access token. */
    accessToken: string;
    /** Encrypted refresh token, or `null` if the IdP withheld one. */
    refreshToken: string | null;
    /**
     * Encrypted id token, or `null`. Kept for RP-initiated logout's
     * `id_token_hint`; not used for WS auth.
     */
    idToken: string | null;
  };

  /**
   * Access-token expiry, epoch **milliseconds**. Informs LAZY refresh only
   * (refresh when a downstream call needs a live token) — it is NOT the WS
   * connection lifetime. The pipe follows the session window, not this.
   */
  accessTokenExpiresAt: number;

  /**
   * The session's sliding window, epoch **milliseconds**. This is the value
   * the cookie verifier returns as `expiresAt` (the WS connection lifetime),
   * slid forward on each authed touch up to the 30-day cap.
   */
  sessionExpiresAt: number;

  /** When the session was first created, epoch **milliseconds**. */
  createdAt: number;
}

/**
 * The consumer-pluggable persistence seam (Decision #20). The library mints
 * the `sid`; the store only persists by that key.
 *
 * Implementations are typically ~40 lines over a backend that already exists
 * in the consumer's stack (NATS KV, Redis, a SQL table).
 */
export interface SessionStore<TUser> {
  /**
   * Persist a session under a library-minted `sid`.
   *
   * `ttlSeconds` is the **30-day session window** (`sessionTtlSeconds`),
   * passed on EVERY write so backends with native TTL (NATS KV, Redis) can
   * re-stamp it (slide the window) on each authed touch. SQL backends store
   * an `expires_at` column and sweep on a schedule.
   */
  set(
    sid: string,
    data: SessionData<TUser>,
    opts: { ttlSeconds: number },
  ): Promise<void>;

  /** Look up a session by `sid`. Resolves `null` when absent or expired. */
  get(sid: string): Promise<SessionData<TUser> | null>;

  /** Drop a single session (logout). Idempotent — unknown `sid` is a no-op. */
  delete(sid: string): Promise<void>;

  /**
   * Revocation primitive — drop EVERY session for a subject (Decision #17).
   *
   * Used by `revokeUser(sub)` when a `session.invalidated` event arrives.
   * After this resolves, future connects AND future lazy refreshes for that
   * subject fail (the drawer is empty).
   *
   * KV COMPANION-INDEX NOTE (§E.1): opaque `sid -> data` stores (NATS KV,
   * Redis without a secondary index) cannot scan by `sub`, so an
   * implementation MUST also maintain a companion `sub -> [sid]` index — a
   * second key per subject holding that subject's live sid list — updated on
   * `set`/`delete` and walked here. SQL backends just `DELETE WHERE sub = ?`.
   * Index drift (an orphaned sid lingering until its TTL) is bounded by the
   * 30-day window and accepted (Decision #17 — best-effort kick).
   */
  deleteByUser(sub: string): Promise<void>;
}
