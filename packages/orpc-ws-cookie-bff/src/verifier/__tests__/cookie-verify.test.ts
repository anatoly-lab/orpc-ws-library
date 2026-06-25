import type { IncomingMessage } from "node:http";

import { describe, expect, it } from "vitest";

import { createCookieVerifyClient } from "../cookie-verify.js";
import type { SessionData } from "../../session-store.js";
import { FakeSessionStore, fakeClock } from "../../__tests__/fakes.js";

type User = { id: string };

const COOKIE = "__Host-sid";
const ORIGIN = "https://web.example";
const SESSION_TTL_S = 60 * 60 * 24 * 30;

type VerifyOpts = Partial<
  Parameters<typeof createCookieVerifyClient>[1]
>;

function ctx(opts: { origin?: string; cookie?: string }) {
  return {
    req: {
      headers: opts.cookie ? { cookie: opts.cookie } : {},
    } as IncomingMessage,
    token: null,
    clientIp: "1.2.3.4",
    origin: opts.origin ?? ORIGIN,
    secure: true,
  };
}

function liveSession(sessionExpiresAt: number): SessionData<User> {
  return {
    sub: "user-1",
    user: { id: "db-1" },
    csrfToken: "csrf-x",
    enc: { accessToken: "x", refreshToken: null, idToken: null },
    accessTokenExpiresAt: 0,
    sessionExpiresAt,
    createdAt: 0,
  };
}

function build(verifyOpts: VerifyOpts = {}) {
  const clock = fakeClock();
  const store = new FakeSessionStore<User>();
  const verify = createCookieVerifyClient(store, {
    cookieName: COOKIE,
    originAllowlist: [ORIGIN],
    sessionTtlSeconds: SESSION_TTL_S,
    clock,
    ...verifyOpts,
  });
  return { verify, store, clock };
}

describe("createCookieVerifyClient", () => {
  it("rejects an Origin not on the allowlist", async () => {
    const { verify } = build();
    const res = await verify(ctx({ origin: "https://evil.example" }));
    expect(res).toEqual({ ok: false, code: 4001, reason: "Origin not allowed" });
  });

  it("rejects an empty Origin (fail-closed)", async () => {
    const { verify } = build();
    const res = await verify(ctx({ origin: "" }));
    expect(res).toMatchObject({ ok: false, code: 4001 });
  });

  it("rejects when there is no session cookie", async () => {
    const { verify } = build();
    const res = await verify(ctx({}));
    expect(res).toEqual({ ok: false, code: 4001, reason: "No session cookie" });
  });

  it("FAILS CLOSED when the store throws", async () => {
    const { verify, store } = build();
    store.throwOnGet = true;
    const res = await verify(ctx({ cookie: `${COOKIE}=sid-1` }));
    expect(res).toEqual({
      ok: false,
      code: 4001,
      reason: "Session store unavailable",
    });
  });

  it("rejects an unknown session", async () => {
    const { verify } = build();
    const res = await verify(ctx({ cookie: `${COOKIE}=nope` }));
    expect(res).toMatchObject({ ok: false, reason: "Unknown session" });
  });

  it("rejects an expired session (window in the past)", async () => {
    const { verify, store, clock } = build();
    store.map.set("sid-1", liveSession(clock.now() - 1));
    const res = await verify(ctx({ cookie: `${COOKIE}=sid-1` }));
    expect(res).toMatchObject({ ok: false, reason: "Session expired" });
  });

  it("succeeds with the SLID session window as expiresAt and sub as connectionKey", async () => {
    // Sliding is on by default, so expiresAt = now + ttl (not the seeded exp).
    const { verify, store, clock } = build();
    store.map.set("sid-1", liveSession(clock.now() + 10_000));
    const res = await verify(ctx({ cookie: `${COOKIE}=sid-1` }));
    expect(res).toEqual({
      ok: true,
      user: { id: "db-1" },
      connectionKey: "user-1",
      expiresAt: clock.now() + SESSION_TTL_S * 1000,
    });
  });

  it("honors a custom authFailedCloseCode", async () => {
    const store = new FakeSessionStore<User>();
    const verify = createCookieVerifyClient(store, {
      cookieName: COOKIE,
      originAllowlist: [ORIGIN],
      authFailedCloseCode: 4010,
    });
    const res = await verify(ctx({ origin: "https://evil.example" }));
    expect(res).toMatchObject({ ok: false, code: 4010 });
  });

  describe("session-window sliding", () => {
    it("re-stamps sessionExpiresAt and persists via store.set on success", async () => {
      const { verify, store, clock } = build();
      store.map.set("sid-1", liveSession(clock.now() + 10_000));
      await verify(ctx({ cookie: `${COOKIE}=sid-1` }));

      const expected = clock.now() + SESSION_TTL_S * 1000;
      expect(store.map.get("sid-1")!.sessionExpiresAt).toBe(expected);
      expect(store.setCalls.at(-1)).toEqual({
        sid: "sid-1",
        ttlSeconds: SESSION_TTL_S,
      });
    });

    it("still returns ok:true when the slide write (store.set) throws", async () => {
      const { verify, store, clock } = build();
      store.map.set("sid-1", liveSession(clock.now() + 10_000));
      store.set = async () => {
        throw new Error("store.set down");
      };
      const res = await verify(ctx({ cookie: `${COOKIE}=sid-1` }));
      // A slide-write failure must NEVER fail the upgrade; returns the
      // un-slid window as expiresAt.
      expect(res).toMatchObject({
        ok: true,
        connectionKey: "user-1",
        expiresAt: clock.now() + 10_000,
      });
    });

    it("skips the slide write when slideSessionOnActivity is false", async () => {
      const { verify, store, clock } = build({ slideSessionOnActivity: false });
      const exp = clock.now() + 10_000;
      store.map.set("sid-1", liveSession(exp));
      const res = await verify(ctx({ cookie: `${COOKIE}=sid-1` }));
      expect(store.setCalls).toHaveLength(0);
      expect(res).toMatchObject({ ok: true, expiresAt: exp });
    });
  });
});
