// Deterministic fakes for the adapter tests — a Map-backed SessionStore and a
// stub HttpAdapterHost (the WS server never actually attaches in unit tests).

import type { SessionData, SessionStore } from "@orpc-ws/cookie-bff";

export type TestUser = { id: string; sub: string };

export class FakeSessionStore implements SessionStore<TestUser> {
  readonly map = new Map<string, SessionData<TestUser>>();
  readonly deletedByUser: string[] = [];

  async set(sid: string, data: SessionData<TestUser>): Promise<void> {
    this.map.set(sid, data);
  }
  async get(sid: string): Promise<SessionData<TestUser> | null> {
    return this.map.get(sid) ?? null;
  }
  async delete(sid: string): Promise<void> {
    this.map.delete(sid);
  }
  async deleteByUser(sub: string): Promise<void> {
    this.deletedByUser.push(sub);
    for (const [sid, d] of this.map) if (d.sub === sub) this.map.delete(sid);
  }
}

/** A live session record for the given sub, expiring far in the future. */
export function liveSession(sub: string): SessionData<TestUser> {
  return {
    sub,
    user: { id: `db-${sub}`, sub },
    csrfToken: `csrf-${sub}`,
    enc: { accessToken: "x", refreshToken: null, idToken: null },
    accessTokenExpiresAt: 0,
    sessionExpiresAt: Date.now() + 60 * 60 * 1000,
    createdAt: Date.now(),
  };
}

/** `HttpAdapterHost` stub — `httpAdapter` is null; bootstrap is never run. */
export const stubHttpAdapterHost = { httpAdapter: null };
