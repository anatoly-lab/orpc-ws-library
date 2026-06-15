// Server-side session store for the backend demos (backend-token +
// cookie-bff). Maps an opaque session id (the cookie value) to the
// server-held tokens + identity.
//
// ┌───────────────────────────────────────────────────────────────────┐
// │ DEMO ONLY: this is an in-memory Map. Sessions are LOST on restart   │
// │ and NOT shared across processes. A real BFF persists sessions in a  │
// │ shared store (Redis / encrypted cookie / DB) so they survive a      │
// │ restart and work behind multiple replicas. The library does NOT     │
// │ ship a session store — that's a consumer/app concern; this is the   │
// │ demo's stand-in.                                                    │
// └───────────────────────────────────────────────────────────────────┘

import { randomBytes } from "node:crypto";

/** One server-side session. */
export interface Session {
  sub: string;
  email?: string;
  name?: string;
  /** Current (possibly-refreshed) access token. */
  accessToken: string;
  /** Refresh token for minting new access tokens. May be null if the IdP withheld one. */
  refreshToken: string | null;
  /** The id_token (kept for RP-initiated logout `id_token_hint`). */
  idToken: string | null;
  /** Access-token expiry, epoch ms (matches the verifier's `expiresAt` unit). */
  expiresAt: number;
}

export class SessionStore {
  private readonly sessions = new Map<string, Session>();

  /**
   * Create a session and return its sid. The sid is 32 random bytes hex —
   * 256 bits of entropy, unguessable, safe to put in a cookie as the only
   * thing the browser holds.
   */
  create(data: Session): string {
    const sid = randomBytes(32).toString("hex");
    this.sessions.set(sid, data);
    return sid;
  }

  /** Look up a session by sid. Returns `null` when absent. */
  get(sid: string): Session | null {
    return this.sessions.get(sid) ?? null;
  }

  /**
   * Replace an existing session's data in place (e.g. after a token
   * refresh updates accessToken/expiresAt). No-op if the sid is unknown.
   */
  update(sid: string, data: Session): void {
    if (this.sessions.has(sid)) this.sessions.set(sid, data);
  }

  /** Destroy a session (logout). Idempotent. */
  destroy(sid: string): void {
    this.sessions.delete(sid);
  }
}
