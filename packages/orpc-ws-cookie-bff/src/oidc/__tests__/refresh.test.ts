import { describe, expect, it } from "vitest";

import { OidcCodeExchange } from "../code-exchange.js";
import { OidcDiscovery } from "../discovery.js";
import { InMemoryPkceStore } from "../pkce-store.js";
import { RefreshManager } from "../refresh.js";
import { createTokenCipher } from "../../crypto/token-cipher.js";
import type { SessionData } from "../../session-store.js";
import {
  FakeSessionStore,
  fakeClock,
  fakeFetcher,
} from "../../__tests__/fakes.js";

const KEY = Buffer.alloc(32, 7);
const SESSION_TTL_S = 60 * 60 * 24 * 30;

function seedSession(
  store: FakeSessionStore<{ id: string }>,
  cipher: ReturnType<typeof createTokenCipher>,
  sid: string,
): void {
  const session: SessionData<{ id: string }> = {
    sub: "user-1",
    user: { id: "db-1" },
    enc: cipher.encryptTokenSet({
      accessToken: "old-access",
      refreshToken: "old-refresh",
      idToken: null,
    }),
    accessTokenExpiresAt: 0,
    sessionExpiresAt: 0,
    createdAt: 0,
  };
  store.map.set(sid, session);
}

function build(opts: {
  tokenQueue?: Parameters<typeof fakeFetcher>[0]["tokenQueue"];
  token?: Parameters<typeof fakeFetcher>[0]["token"];
}) {
  const clock = fakeClock();
  const cipher = createTokenCipher({ key: KEY });
  const fetcher = fakeFetcher(opts);
  const discovery = new OidcDiscovery(fetcher);
  const exchange = new OidcCodeExchange(
    {
      issuerUrl: "https://idp.example",
      clientId: "c",
      redirectUri: "https://api.example/cb",
    },
    { discovery, pkceStore: new InMemoryPkceStore(clock), clock },
  );
  const store = new FakeSessionStore<{ id: string }>();
  const mgr = new RefreshManager({
    store,
    cipher,
    exchange,
    sessionTtlSeconds: SESSION_TTL_S,
    clock,
  });
  return { mgr, store, cipher, fetcher, clock };
}

describe("RefreshManager", () => {
  it("single-flights concurrent callers into ONE token-endpoint call", async () => {
    const { mgr, store, cipher, fetcher } = build({
      token: {
        ok: true,
        status: 200,
        json: { access_token: "new-access", refresh_token: "new-refresh" },
      },
    });
    seedSession(store, cipher, "sid-1");

    const [a, b, c] = await Promise.all([
      mgr.refresh("sid-1"),
      mgr.refresh("sid-1"),
      mgr.refresh("sid-1"),
    ]);

    const tokenCalls = fetcher.calls.filter((x) => x.url.includes("/token"));
    expect(tokenCalls).toHaveLength(1); // ← single-flight
    expect(a).toEqual({ ok: true, accessToken: "new-access" });
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });

  it("persists rotated tokens and slides the session window", async () => {
    const { mgr, store, cipher, clock } = build({
      token: {
        ok: true,
        status: 200,
        json: {
          access_token: "new-access",
          refresh_token: "rotated-refresh",
          expires_in: 300,
        },
      },
    });
    seedSession(store, cipher, "sid-1");

    await mgr.refresh("sid-1");

    const updated = store.map.get("sid-1")!;
    expect(cipher.decrypt(updated.enc.accessToken)).toBe("new-access");
    expect(cipher.decrypt(updated.enc.refreshToken!)).toBe("rotated-refresh");
    expect(updated.sessionExpiresAt).toBe(clock.now() + SESSION_TTL_S * 1000);
    expect(store.setCalls.at(-1)?.ttlSeconds).toBe(SESSION_TTL_S);
  });

  it("keeps the prior refresh token when the IdP doesn't rotate one", async () => {
    const { mgr, store, cipher } = build({
      token: { ok: true, status: 200, json: { access_token: "new-access" } },
    });
    seedSession(store, cipher, "sid-1");
    await mgr.refresh("sid-1");
    expect(cipher.decrypt(store.map.get("sid-1")!.enc.refreshToken!)).toBe(
      "old-refresh",
    );
  });

  it("classifies a 4xx as TERMINAL", async () => {
    const { mgr, store, cipher } = build({
      token: { ok: false, status: 400, statusText: "Bad Request", text: "" },
    });
    seedSession(store, cipher, "sid-1");
    const res = await mgr.refresh("sid-1");
    expect(res).toEqual({
      ok: false,
      terminal: true,
      reason: expect.stringContaining("token endpoint failed"),
    });
  });

  it("classifies a 5xx as TRANSIENT (non-terminal)", async () => {
    const { mgr, store, cipher } = build({
      token: { ok: false, status: 503, statusText: "Unavailable", text: "" },
    });
    seedSession(store, cipher, "sid-1");
    const res = await mgr.refresh("sid-1");
    expect(res).toMatchObject({ ok: false, terminal: false });
  });

  it("is terminal when the session is gone or has no refresh token", async () => {
    const { mgr, store, cipher } = build({
      token: { ok: true, status: 200, json: { access_token: "x" } },
    });
    expect(await mgr.refresh("missing")).toMatchObject({
      ok: false,
      terminal: true,
    });

    const noRefresh: SessionData<{ id: string }> = {
      sub: "u",
      user: { id: "1" },
      enc: cipher.encryptTokenSet({
        accessToken: "a",
        refreshToken: null,
        idToken: null,
      }),
      accessTokenExpiresAt: 0,
      sessionExpiresAt: 0,
      createdAt: 0,
    };
    store.map.set("sid-x", noRefresh);
    expect(await mgr.refresh("sid-x")).toMatchObject({
      ok: false,
      terminal: true,
    });
  });

  it("clears the in-flight promise on a transient failure (a later refresh re-fires /token)", async () => {
    // First /token call 503s (transient); the second succeeds. A second
    // refresh(sid) AFTER the first settled must issue a SECOND /token call —
    // proving the in-flight promise was cleared (no sid-poisoning).
    const { mgr, store, cipher, fetcher } = build({
      tokenQueue: [
        { ok: false, status: 503, statusText: "Unavailable", text: "" },
        { ok: true, status: 200, json: { access_token: "recovered" } },
      ],
    });
    seedSession(store, cipher, "sid-1");

    const first = await mgr.refresh("sid-1");
    expect(first).toMatchObject({ ok: false, terminal: false });

    const second = await mgr.refresh("sid-1");
    expect(second).toEqual({ ok: true, accessToken: "recovered" });

    const tokenCalls = fetcher.calls.filter((c) => c.url.includes("/token"));
    expect(tokenCalls).toHaveLength(2); // ← in-flight was cleared, not cached
  });

  it("is terminal when the stored refresh token can't be decrypted (key rotated past grace)", async () => {
    const { mgr, store } = build({
      token: { ok: true, status: 200, json: { access_token: "x" } },
    });
    // Seed a session whose refresh token was encrypted under a DIFFERENT key
    // the manager's cipher doesn't know — decrypt fails → terminal.
    const foreignCipher = createTokenCipher({ key: Buffer.alloc(32, 9) });
    store.map.set("sid-1", {
      sub: "u",
      user: { id: "1" },
      enc: foreignCipher.encryptTokenSet({
        accessToken: "a",
        refreshToken: "r",
        idToken: null,
      }),
      accessTokenExpiresAt: 0,
      sessionExpiresAt: 0,
      createdAt: 0,
    });
    const res = await mgr.refresh("sid-1");
    expect(res).toMatchObject({
      ok: false,
      terminal: true,
      reason: expect.stringContaining("undecryptable"),
    });
  });
});
