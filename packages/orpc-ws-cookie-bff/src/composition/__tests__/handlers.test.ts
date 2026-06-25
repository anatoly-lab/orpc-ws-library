import { describe, expect, it } from "vitest";

import { createCookieBffCore } from "../cookie-bff-core.js";
import type { CookieBffOptions } from "../options.js";
import { mintCsrfToken } from "../../cookies/csrf.js";
import { OAUTH_STATE_COOKIE } from "../../cookies/oauth-state.js";
import type { SessionData } from "../../session-store.js";
import {
  FakeSessionStore,
  fakeClock,
  fakeFetcher,
  fakeJwt,
} from "../../__tests__/fakes.js";

type User = { id: string; sub: string };
const KEY = Buffer.alloc(32, 3);
const SPA = "https://web.example";

function build(
  fetcherOpts: Parameters<typeof fakeFetcher>[0] = {},
  override: Partial<CookieBffOptions<User>> = {},
) {
  const clock = fakeClock();
  const store = new FakeSessionStore<User>();
  const fetcher = fakeFetcher(fetcherOpts);
  const core = createCookieBffCore<User>({
    keycloak: {
      issuerUrl: "https://idp.example",
      clientId: "demo",
      redirectUri: "https://api.example/auth/callback",
    },
    originAllowlist: [SPA],
    encryptionKey: KEY,
    sessionStore: store,
    spaRedirectUri: SPA,
    resolveUser: async (claims) => ({ id: `db-${claims.sub}`, sub: claims.sub }),
    fetcher,
    clock,
    ...override,
  });
  return { core, store, clock, fetcher };
}

/** A stored session for the given sub, with a known CSRF token + window. */
function storedSession(
  sub: string,
  sessionExpiresAt: number,
  csrfToken = "csrf-stored",
): SessionData<User> {
  return {
    sub,
    user: { id: `db-${sub}`, sub },
    csrfToken,
    enc: { accessToken: "x", refreshToken: null, idToken: null },
    accessTokenExpiresAt: 0,
    sessionExpiresAt,
    createdAt: 0,
  };
}

/** Extract the value of a named cookie from an array of Set-Cookie strings. */
function cookieValue(setCookies: string[], name: string): string | undefined {
  for (const c of setCookies) {
    const m = c.match(new RegExp(`^${name}=([^;]*)`));
    if (m) return decodeURIComponent(m[1]!);
  }
  return undefined;
}

describe("login handler", () => {
  it("302s to the IdP and sets an oauth_state cookie", async () => {
    const { core } = build();
    const r = await core.login({});
    expect(r.status).toBe(302);
    expect(r.redirect).toContain("https://idp.example/authorize");
    const state = cookieValue(
      r.setCookies!.map((c) => c.value),
      OAUTH_STATE_COOKIE,
    );
    expect(state).toBeTruthy();
    expect(new URL(r.redirect!).searchParams.get("state")).toBe(state);
  });
});

describe("callback handler — happy path", () => {
  it("sets __Host-sid + clears oauth_state + 302s to the SPA, storing a session with a CSRF token", async () => {
    const { core, store } = build({
      token: {
        ok: true,
        status: 200,
        json: {
          access_token: "acc",
          refresh_token: "ref",
          id_token: fakeJwt({ sub: "kc-123", email: "u@example.com" }),
          expires_in: 300,
        },
      },
    });
    const login = await core.login({});
    const state = cookieValue(
      login.setCookies!.map((c) => c.value),
      OAUTH_STATE_COOKIE,
    )!;

    const r = await core.callback({
      query: { code: "the-code", state },
      cookieHeader: `${OAUTH_STATE_COOKIE}=${state}`,
    });

    expect(r.status).toBe(302);
    expect(r.redirect).toBe(SPA);
    const setCookies = r.setCookies!.map((c) => c.value);
    const joined = setCookies.join("\n");
    expect(joined).toContain("__Host-sid=");
    expect(joined).toContain("HttpOnly");
    expect(joined).toContain("Secure");
    // NO CSRF cookie is emitted anymore (synchronizer-token lives in session).
    expect(joined).not.toContain("csrf");
    // oauth_state cleared.
    expect(r.setClearCookies![0]!.value).toContain(`${OAUTH_STATE_COOKIE}=`);

    // One session persisted: enriched user, encrypted tokens, AND a CSRF token
    // minted + stored in the session.
    expect(store.map.size).toBe(1);
    const [, session] = [...store.map.entries()][0]!;
    expect(session.sub).toBe("kc-123");
    expect(session.user).toEqual({ id: "db-kc-123", sub: "kc-123" });
    expect(session.enc.accessToken).not.toBe("acc"); // ciphertext
    expect(typeof session.csrfToken).toBe("string");
    expect(session.csrfToken.length).toBeGreaterThan(0);
  });
});

describe("callback handler — rejections", () => {
  it("rejects when the oauth_state cookie does not match the query state", async () => {
    const { core, store } = build({
      token: { ok: true, status: 200, json: { access_token: "a" } },
    });
    const login = await core.login({});
    const state = cookieValue(
      login.setCookies!.map((c) => c.value),
      OAUTH_STATE_COOKIE,
    )!;

    const r = await core.callback({
      query: { code: "c", state },
      cookieHeader: `${OAUTH_STATE_COOKIE}=different`,
    });
    expect(r.status).toBe(400);
    expect(r.setClearCookies).toBeTruthy();
    expect(store.map.size).toBe(0);
  });

  it("400s on missing code/state", async () => {
    const { core } = build();
    const r = await core.callback({ query: {}, cookieHeader: "" });
    expect(r.status).toBe(400);
  });
});

describe("me handler", () => {
  it("returns the enriched user AND the session's csrfToken in the body", async () => {
    const { core, store, clock } = build();
    store.map.set(
      "sid-1",
      storedSession("kc-1", clock.now() + 10_000, "the-csrf"),
    );
    const r = await core.me({ cookieHeader: "__Host-sid=sid-1" });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      user: { id: "db-kc-1", sub: "kc-1" },
      csrfToken: "the-csrf",
    });
  });

  it("emits NO CSRF Set-Cookie (synchronizer-token is body-only)", async () => {
    const { core, store, clock } = build();
    store.map.set("sid-1", storedSession("kc-1", clock.now() + 10_000));
    const r = await core.me({ cookieHeader: "__Host-sid=sid-1" });
    // No cookies at all on /me now (slide is a store write, not a Set-Cookie).
    expect(r.setCookies ?? []).toEqual([]);
  });

  it("slides the session window on /me (best-effort, rolling)", async () => {
    const { core, store, clock } = build();
    store.map.set("sid-1", storedSession("kc-1", clock.now() + 10_000));
    await core.me({ cookieHeader: "__Host-sid=sid-1" });
    const ttlMs = 60 * 60 * 24 * 30 * 1000;
    expect(store.map.get("sid-1")!.sessionExpiresAt).toBe(clock.now() + ttlMs);
    // The slide preserves the CSRF token.
    expect(store.map.get("sid-1")!.csrfToken).toBe("csrf-stored");
  });

  it("401s without a session", async () => {
    const { core } = build();
    expect((await core.me({})).status).toBe(401);
  });
});

describe("logout handler (synchronizer-token CSRF)", () => {
  it("rejects (403) when no session backs the sid", async () => {
    const { core } = build();
    const r = await core.logout({
      cookieHeader: "__Host-sid=missing",
      headers: { "x-csrf-token": "anything" },
    });
    expect(r.status).toBe(403);
  });

  it("rejects (403) when the echoed header is missing", async () => {
    const { core, store, clock } = build();
    store.map.set("sid-1", storedSession("kc-1", clock.now() + 10_000));
    const r = await core.logout({
      cookieHeader: "__Host-sid=sid-1",
      headers: {},
    });
    expect(r.status).toBe(403);
    expect(store.map.has("sid-1")).toBe(true); // not mutated
  });

  it("rejects (403) when the echo mismatches the session-stored token", async () => {
    const { core, store, clock } = build();
    store.map.set(
      "sid-1",
      storedSession("kc-1", clock.now() + 10_000, "right-token"),
    );
    const r = await core.logout({
      cookieHeader: "__Host-sid=sid-1",
      headers: { "x-csrf-token": "wrong-token" },
    });
    expect(r.status).toBe(403);
    expect(store.map.has("sid-1")).toBe(true);
  });

  it("rejects a token from a DIFFERENT session", async () => {
    const { core, store, clock } = build();
    store.map.set(
      "sid-1",
      storedSession("kc-1", clock.now() + 10_000, "token-1"),
    );
    store.map.set(
      "sid-2",
      storedSession("kc-2", clock.now() + 10_000, "token-2"),
    );
    // Echo sid-2's token while presenting sid-1's cookie → mismatch.
    const r = await core.logout({
      cookieHeader: "__Host-sid=sid-1",
      headers: { "x-csrf-token": "token-2" },
    });
    expect(r.status).toBe(403);
    expect(store.map.has("sid-1")).toBe(true);
  });

  it("succeeds (200) on a matching header-vs-session token: deletes the session, clears the cookie, returns end-session URL", async () => {
    const { core, store, clock } = build();
    store.map.set(
      "sid-1",
      storedSession("kc-1", clock.now() + 10_000, "match-me"),
    );
    const r = await core.logout({
      cookieHeader: "__Host-sid=sid-1",
      headers: { "x-csrf-token": "match-me" },
    });
    expect(r.status).toBe(200);
    expect(store.map.has("sid-1")).toBe(false);
    expect(r.setClearCookies![0]!.value).toContain("__Host-sid=");
    expect((r.body as { endSessionUrl: string }).endSessionUrl).toContain(
      "https://idp.example/logout",
    );
  });

  it("full /me→echo→logout round-trip: the token /me returns validates logout", async () => {
    const { core, store, clock } = build();
    store.map.set(
      "sid-1",
      storedSession("kc-1", clock.now() + 10_000, mintCsrfToken()),
    );

    // 1. /me returns the session's CSRF token in the body.
    const me = await core.me({ cookieHeader: "__Host-sid=sid-1" });
    const token = (me.body as { csrfToken: string }).csrfToken;

    // 2. SPA holds it in memory, echoes it in the header on logout.
    const out = await core.logout({
      cookieHeader: "__Host-sid=sid-1",
      headers: { "x-csrf-token": token },
    });
    expect(out.status).toBe(200);
    expect(store.map.has("sid-1")).toBe(false);
  });

  it("accepts a case-insensitive CSRF echo header (X-CSRF-Token)", async () => {
    const { core, store, clock } = build();
    store.map.set(
      "sid-1",
      storedSession("kc-1", clock.now() + 10_000, "match-me"),
    );
    const r = await core.logout({
      cookieHeader: "__Host-sid=sid-1",
      headers: { "X-CSRF-Token": "match-me" }, // adapter didn't lower-case
    });
    expect(r.status).toBe(200);
  });
});

/** Drive a real login → successful callback for a given id_token payload. */
async function loginAndCallback(
  core: ReturnType<typeof build>["core"],
): Promise<void> {
  const login = await core.login({});
  const state = cookieValue(
    login.setCookies!.map((c) => c.value),
    OAUTH_STATE_COOKIE,
  )!;
  await core.callback({
    query: { code: "the-code", state },
    cookieHeader: `${OAUTH_STATE_COOKIE}=${state}`,
  });
}

const successToken = {
  ok: true as const,
  status: 200,
  json: {
    access_token: "acc",
    id_token: fakeJwt({ sub: "kc-1", email: "u@example.com", picture: "https://idp/a.png" }),
    expires_in: 300,
  },
};

describe("resolveUser raw claims (F2)", () => {
  it("receives the FULL raw id_token payload as the third arg", async () => {
    let seenRaw: Record<string, unknown> | null = null;
    const { core, store } = build(
      {
        token: {
          ok: true,
          status: 200,
          json: {
            access_token: "acc",
            id_token: fakeJwt({
              sub: "kc-1",
              picture: "https://idp/a.png",
              custom_role: "admin", // NOT whitelisted
            }),
            expires_in: 300,
          },
        },
      },
      {
        resolveUser: async (claims, _tokens, raw) => {
          seenRaw = raw;
          // Read a non-whitelisted claim straight off raw.
          return { id: `db-${claims.sub}`, sub: claims.sub };
        },
      },
    );

    await loginAndCallback(core);
    expect(seenRaw).not.toBeNull();
    expect(seenRaw!.custom_role).toBe("admin");
    expect(seenRaw!.picture).toBe("https://idp/a.png");
    expect(store.map.size).toBe(1);
  });
});

describe("authEvents (F1b)", () => {
  it("fires onLoginStart on /auth/login", async () => {
    const calls: string[] = [];
    const { core } = build({}, { authEvents: { onLoginStart: () => calls.push("login") } });
    await core.login({});
    expect(calls).toEqual(["login"]);
  });

  it("fires onCallbackSuccess(user) on the happy path", async () => {
    const seen: User[] = [];
    const { core } = build(
      { token: successToken },
      { authEvents: { onCallbackSuccess: (u) => seen.push(u) } },
    );
    await loginAndCallback(core);
    expect(seen).toEqual([{ id: "db-kc-1", sub: "kc-1" }]);
  });

  it("fires onCallbackFailure(reason) on a state mismatch", async () => {
    const reasons: string[] = [];
    const { core } = build(
      { token: successToken },
      { authEvents: { onCallbackFailure: (r) => reasons.push(r) } },
    );
    const login = await core.login({});
    const state = cookieValue(
      login.setCookies!.map((c) => c.value),
      OAUTH_STATE_COOKIE,
    )!;
    await core.callback({
      query: { code: "c", state },
      cookieHeader: `${OAUTH_STATE_COOKIE}=wrong`, // mismatch
    });
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain("browser binding");
  });

  it("fires onCallbackFailure on a token-exchange error", async () => {
    const reasons: string[] = [];
    const { core } = build(
      { token: { ok: false, status: 400, statusText: "Bad Request", text: "nope" } },
      { authEvents: { onCallbackFailure: (r) => reasons.push(r) } },
    );
    const login = await core.login({});
    const state = cookieValue(
      login.setCookies!.map((c) => c.value),
      OAUTH_STATE_COOKIE,
    )!;
    const r = await core.callback({
      query: { code: "c", state },
      cookieHeader: `${OAUTH_STATE_COOKIE}=${state}`,
    });
    expect(r.status).toBe(400);
    expect(reasons).toHaveLength(1);
  });

  it("fires onLogout(sub) after deleting the session", async () => {
    const subs: Array<string | null> = [];
    const { core, store, clock } = build(
      {},
      { authEvents: { onLogout: (s) => subs.push(s) } },
    );
    store.map.set("sid-1", storedSession("kc-1", clock.now() + 10_000, "tok"));
    await core.logout({
      cookieHeader: "__Host-sid=sid-1",
      headers: { "x-csrf-token": "tok" },
    });
    expect(subs).toEqual(["kc-1"]);
  });

  it("a THROWING hook never breaks the flow", async () => {
    const boom = () => {
      throw new Error("hook blew up");
    };
    // login still 302s despite a throwing onLoginStart.
    const { core: loginCore } = build({}, { authEvents: { onLoginStart: boom } });
    expect((await loginCore.login({})).status).toBe(302);

    // callback still succeeds (302) despite a throwing onCallbackSuccess.
    const { core: cbCore, store } = build(
      { token: successToken },
      { authEvents: { onCallbackSuccess: boom } },
    );
    await loginAndCallback(cbCore);
    expect(store.map.size).toBe(1); // session was still stored

    // logout still 200s despite a throwing onLogout.
    const { core: outCore, store: outStore, clock } = build(
      {},
      { authEvents: { onLogout: boom } },
    );
    outStore.map.set("sid-1", storedSession("kc-1", clock.now() + 10_000, "tok"));
    const r = await outCore.logout({
      cookieHeader: "__Host-sid=sid-1",
      headers: { "x-csrf-token": "tok" },
    });
    expect(r.status).toBe(200);
    expect(outStore.map.has("sid-1")).toBe(false);
  });
});
