// Regression tests for the slide↔refresh read-modify-write race.
//
// THE DEFECT: `slideSessionWindow` used to `store.set` a full record built
// from the CALLER's snapshot (read by the verifier / `/me` several awaits
// earlier). A lazy refresh (`RefreshManager.doRefresh`) landing in between
// was then clobbered — the stale snapshot rolled back the freshly-rotated
// `enc` + `accessTokenExpiresAt`, and under refresh-token rotation the
// rolled-back refresh token is dead → next refresh fails terminal →
// premature self-logout.
//
// THE FIX (two-tier): prefer the store's expiry-only `touch` (race-free by
// construction, express-session precedent); when absent, fall back to a
// fresh `get` immediately before a merged `set` (narrows — does not
// eliminate — the window).

import { noopLogger } from "@orpc-ws/shared";
import { describe, expect, it, vi } from "vitest";

import { slideSessionWindow } from "../session-slide.js";
import type { SessionData, SessionStore } from "../session-store.js";
import { FakeSessionStore, fakeClock } from "./fakes.js";

type User = { id: string };

const TTL_S = 60 * 60 * 24 * 30;

function session(overrides: Partial<SessionData<User>> = {}): SessionData<User> {
  return {
    sub: "user-1",
    user: { id: "db-1" },
    csrfToken: "csrf-x",
    enc: { accessToken: "enc-old-at", refreshToken: "enc-old-rt", idToken: null },
    accessTokenExpiresAt: 1_000,
    sessionExpiresAt: 2_000,
    createdAt: 0,
    ...overrides,
  };
}

/**
 * A store WITHOUT `touch` — exercises the get→merged-set fallback. Records
 * call order so tests can assert the fresh re-get happens inside the slide.
 */
class GetSetOnlySessionStore<TUser> implements SessionStore<TUser> {
  readonly map = new Map<string, SessionData<TUser>>();
  readonly callOrder: string[] = [];

  async set(
    sid: string,
    data: SessionData<TUser>,
    _opts: { ttlSeconds: number },
  ): Promise<void> {
    this.callOrder.push("set");
    this.map.set(sid, data);
  }
  async get(sid: string): Promise<SessionData<TUser> | null> {
    this.callOrder.push("get");
    return this.map.get(sid) ?? null;
  }
  async delete(sid: string): Promise<void> {
    this.map.delete(sid);
  }
  async deleteByUser(sub: string): Promise<void> {
    for (const [sid, data] of this.map) {
      if (data.sub === sub) this.map.delete(sid);
    }
  }
}

function slide<TUser>(
  store: SessionStore<TUser>,
  stale: SessionData<TUser>,
  clock = fakeClock(),
) {
  return slideSessionWindow({
    store,
    sid: "sid-1",
    session: stale,
    sessionTtlSeconds: TTL_S,
    clock,
    logger: noopLogger,
  });
}

describe("slideSessionWindow — slide↔refresh interleave", () => {
  it("touch-capable store: a slide from a STALE snapshot cannot clobber a refresh's enc/accessTokenExpiresAt (would fail pre-fix)", async () => {
    const store = new FakeSessionStore<User>();
    const clock = fakeClock();
    const stale = session();
    // A lazy refresh landed AFTER the caller read `stale`: rotated tokens.
    const refreshed = session({
      enc: { accessToken: "enc-new-at", refreshToken: "enc-new-rt", idToken: null },
      accessTokenExpiresAt: 999_999,
    });
    store.map.set("sid-1", refreshed);

    await slide(store, stale, clock);

    const persisted = store.map.get("sid-1")!;
    // Pre-fix: set(stale) rolled these back to enc-old-* (dead rotated grant).
    expect(persisted.enc).toEqual(refreshed.enc);
    expect(persisted.accessTokenExpiresAt).toBe(999_999);
    // The slide still did its one job.
    expect(persisted.sessionExpiresAt).toBe(clock.now() + TTL_S * 1000);
    expect(store.setCalls).toHaveLength(0); // never a full-record write
  });

  it("get/set-only store: the fallback re-gets FRESH inside the slide, so a refresh landed before the slide is preserved (would fail pre-fix)", async () => {
    const store = new GetSetOnlySessionStore<User>();
    const clock = fakeClock();
    const stale = session();
    const refreshed = session({
      enc: { accessToken: "enc-new-at", refreshToken: "enc-new-rt", idToken: null },
      accessTokenExpiresAt: 999_999,
    });
    store.map.set("sid-1", refreshed);

    const result = await slide(store, stale, clock);

    // The fresh read happened INSIDE the slide, immediately before the set
    // (the caller's own get is not on this store's record — callOrder starts
    // at the slide).
    expect(store.callOrder).toEqual(["get", "set"]);
    const persisted = store.map.get("sid-1")!;
    expect(persisted.enc).toEqual(refreshed.enc);
    expect(persisted.accessTokenExpiresAt).toBe(999_999);
    expect(persisted.sessionExpiresAt).toBe(clock.now() + TTL_S * 1000);
    // The returned copy reflects what was persisted (fresh + slid).
    expect(result).toEqual(persisted);
  });

  it("get/set-only store: does NOT resurrect a session deleted since the caller's read", async () => {
    const store = new GetSetOnlySessionStore<User>();
    const stale = session();
    // Revoked / logged out between the caller's read and the slide.

    const result = await slide(store, stale);

    expect(store.map.size).toBe(0); // pre-fix: set(stale) recreated it
    expect(store.callOrder).toEqual(["get"]); // bailed before any write
    expect(result).toEqual(stale); // caller keeps its (un-slid) snapshot
  });
});

describe("slideSessionWindow — behavioral parity across both paths", () => {
  it("slides the expiry and returns the re-stamped session via touch", async () => {
    const store = new FakeSessionStore<User>();
    const clock = fakeClock();
    store.map.set("sid-1", session());

    const result = await slide(store, session(), clock);

    const expected = clock.now() + TTL_S * 1000;
    expect(result.sessionExpiresAt).toBe(expected);
    expect(store.map.get("sid-1")!.sessionExpiresAt).toBe(expected);
    expect(store.touchCalls).toEqual([
      { sid: "sid-1", sessionExpiresAt: expected, ttlSeconds: TTL_S },
    ]);
  });

  it("slides the expiry and returns the re-stamped session via the get/set fallback", async () => {
    const store = new GetSetOnlySessionStore<User>();
    const clock = fakeClock();
    store.map.set("sid-1", session());

    const result = await slide(store, session(), clock);

    const expected = clock.now() + TTL_S * 1000;
    expect(result.sessionExpiresAt).toBe(expected);
    expect(store.map.get("sid-1")!.sessionExpiresAt).toBe(expected);
  });

  it("is best-effort on the touch path: a touch failure logs and returns the original", async () => {
    const store = new FakeSessionStore<User>();
    const original = session();
    store.map.set("sid-1", original);
    store.touch = async () => {
      throw new Error("touch down");
    };
    const warn = vi.fn();
    const logger = { ...noopLogger, warn };

    const result = await slideSessionWindow({
      store,
      sid: "sid-1",
      session: original,
      sessionTtlSeconds: TTL_S,
      clock: fakeClock(),
      logger,
    });

    expect(result).toEqual(original); // un-slid, never thrown
    expect(warn).toHaveBeenCalledOnce();
  });

  it("is best-effort on the fallback path: a set failure logs and returns the original", async () => {
    const store = new GetSetOnlySessionStore<User>();
    const original = session();
    store.map.set("sid-1", original);
    store.set = async () => {
      throw new Error("store.set down");
    };
    const warn = vi.fn();
    const logger = { ...noopLogger, warn };

    const result = await slideSessionWindow({
      store,
      sid: "sid-1",
      session: original,
      sessionTtlSeconds: TTL_S,
      clock: fakeClock(),
      logger,
    });

    expect(result).toEqual(original); // un-slid, never thrown
    expect(store.map.get("sid-1")).toEqual(original); // nothing persisted
    expect(warn).toHaveBeenCalledOnce();
  });

  it("is best-effort on the fallback path: a get failure logs and returns the original", async () => {
    const store = new GetSetOnlySessionStore<User>();
    const original = session();
    store.map.set("sid-1", original);
    store.get = async () => {
      throw new Error("store.get down");
    };
    const warn = vi.fn();
    const logger = { ...noopLogger, warn };

    const result = await slideSessionWindow({
      store,
      sid: "sid-1",
      session: original,
      sessionTtlSeconds: TTL_S,
      clock: fakeClock(),
      logger,
    });

    expect(result).toEqual(original); // un-slid, never thrown
    expect(store.callOrder).not.toContain("set"); // bailed before any write
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe("FakeSessionStore.touch (the in-memory store's native impl)", () => {
  it("updates ONLY sessionExpiresAt, leaving every other field intact", async () => {
    const store = new FakeSessionStore<User>();
    const before = session();
    store.map.set("sid-1", before);

    await store.touch("sid-1", 123_456, { ttlSeconds: TTL_S });

    const after = store.map.get("sid-1")!;
    expect(after.sessionExpiresAt).toBe(123_456);
    const { sessionExpiresAt: _a, ...restAfter } = after;
    const { sessionExpiresAt: _b, ...restBefore } = before;
    expect(restAfter).toEqual(restBefore);
  });

  it("is a no-op on an absent sid (never resurrects)", async () => {
    const store = new FakeSessionStore<User>();
    await store.touch("gone", 123_456, { ttlSeconds: TTL_S });
    expect(store.map.size).toBe(0);
  });
});
