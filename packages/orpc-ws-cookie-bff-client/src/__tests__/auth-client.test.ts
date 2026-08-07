import { describe, expect, it, vi } from "vitest";

import {
  createCookieBffAuthClient,
  type CookieBffAuthClientOptions,
} from "../auth-client.js";

type TestUser = { id: string; sub: string };

// The three explicit, required endpoint paths used across the tests.
const PATHS = {
  loginPath: "/auth/login",
  logoutPath: "/auth/logout",
  mePath: "/auth/me",
} satisfies Pick<
  CookieBffAuthClientOptions,
  "loginPath" | "logoutPath" | "mePath"
>;

/** A seen request the fake fetch recorded. */
interface SeenRequest {
  url: string;
  method: string;
  credentials: RequestCredentials | undefined;
  headers: Headers;
}

/**
 * A fake `fetch` that returns scripted responses by URL substring and records
 * every request. `responses` maps a URL substring → the Response to give.
 */
function fakeFetch(responses: {
  me?: { status: number; body?: unknown };
  logout?: { status: number; body?: unknown };
}): typeof fetch & { seen: SeenRequest[] } {
  const seen: SeenRequest[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    seen.push({
      url,
      method: init?.method ?? "GET",
      credentials: init?.credentials,
      headers,
    });
    const pick = url.includes("/me")
      ? responses.me
      : url.includes("/logout")
        ? responses.logout
        : undefined;
    const r = pick ?? { status: 404, body: {} };
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), {
      status: r.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch & { seen: SeenRequest[] };
  impl.seen = seen;
  return impl;
}

/** Build a client with the standard explicit paths + a given fetch. */
function makeClient(fetch: typeof fetch) {
  return createCookieBffAuthClient<TestUser>({
    serverOrigin: "https://api.example.com",
    ...PATHS,
    fetch,
  });
}

describe("createCookieBffAuthClient — me()", () => {
  it("returns the user and holds the CSRF token on success", async () => {
    const fetch = fakeFetch({
      me: { status: 200, body: { user: { id: "db-1", sub: "kc-1" }, csrfToken: "tok-1" } },
    });
    const auth = makeClient(fetch);

    const user = await auth.me();
    expect(user).toEqual({ id: "db-1", sub: "kc-1" });
    expect(auth.getCsrfToken()).toBe("tok-1");

    // me() is a GET to the configured mePath with credentials.
    const meReq = fetch.seen.find((r) => r.url.includes("/me"))!;
    expect(meReq.url).toBe("https://api.example.com/auth/me");
    expect(meReq.method).toBe("GET");
    expect(meReq.credentials).toBe("include");
  });

  it("returns null and CLEARS the held token on 401", async () => {
    // A sequenced fetch on ONE client: first /me succeeds (token held), then
    // /me 401s (token must be cleared).
    const seq = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ user: { id: "1", sub: "s" }, csrfToken: "tok" }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 401 }));
    const auth = makeClient(seq as unknown as typeof fetch);

    expect(await auth.me()).not.toBeNull();
    expect(auth.getCsrfToken()).toBe("tok");
    expect(await auth.me()).toBeNull();
    expect(auth.getCsrfToken()).toBeNull();
  });

  it("returns null on a non-401 failure or a malformed envelope", async () => {
    const bad = fakeFetch({ me: { status: 200, body: { user: null, csrfToken: 1 } } });
    expect(await makeClient(bad).me()).toBeNull();

    const err = fakeFetch({ me: { status: 500 } });
    expect(await makeClient(err).me()).toBeNull();
  });
});

describe("createCookieBffAuthClient — mutate()", () => {
  it("attaches X-CSRF-Token (from the held token) + credentials:include, defaults to POST", async () => {
    const fetch = fakeFetch({
      me: { status: 200, body: { user: { id: "1", sub: "s" }, csrfToken: "the-token" } },
    });
    const auth = makeClient(fetch);
    await auth.me(); // holds "the-token"

    await auth.mutate("/auth/thing");
    const req = fetch.seen.find((r) => r.url.includes("/thing"))!;
    expect(req.method).toBe("POST");
    expect(req.credentials).toBe("include");
    expect(req.headers.get("X-CSRF-Token")).toBe("the-token");
    expect(req.url).toBe("https://api.example.com/auth/thing");
  });

  it("does NOT attach X-CSRF-Token before any token is held", async () => {
    const fetch = fakeFetch({});
    const auth = makeClient(fetch);
    await auth.mutate("/auth/thing"); // no me() yet → no token
    const req = fetch.seen.find((r) => r.url.includes("/thing"))!;
    expect(req.headers.has("X-CSRF-Token")).toBe(false);
    expect(req.credentials).toBe("include");
  });

  it("treats `path` as origin-relative (NOT prefixed by any auth path)", async () => {
    const fetch = fakeFetch({});
    const auth = makeClient(fetch);
    await auth.mutate("/api/things"); // lives OUTSIDE the auth paths
    const req = fetch.seen.find((r) => r.url.includes("/things"))!;
    expect(req.url).toBe("https://api.example.com/api/things");
  });

  it("preserves a caller-supplied method/headers while still adding credentials + CSRF", async () => {
    const fetch = fakeFetch({
      me: { status: 200, body: { user: { id: "1", sub: "s" }, csrfToken: "t" } },
    });
    const auth = makeClient(fetch);
    await auth.me();
    await auth.mutate("/auth/x", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
    });
    const req = fetch.seen.find((r) => r.url.includes("/x"))!;
    expect(req.method).toBe("DELETE");
    expect(req.headers.get("content-type")).toBe("application/json");
    expect(req.headers.get("X-CSRF-Token")).toBe("t");
  });
});

describe("createCookieBffAuthClient — logout()", () => {
  it("POSTs the configured logoutPath via mutate (CSRF header attached) and returns endSessionUrl, no navigation", async () => {
    const fetch = fakeFetch({
      me: { status: 200, body: { user: { id: "1", sub: "s" }, csrfToken: "t" } },
      logout: { status: 200, body: { ok: true, endSessionUrl: "https://idp/logout" } },
    });
    const auth = makeClient(fetch);
    await auth.me();

    const result = await auth.logout();
    expect(result).toEqual({ endSessionUrl: "https://idp/logout" });

    const req = fetch.seen.find((r) => r.url.includes("/logout"))!;
    expect(req.url).toBe("https://api.example.com/auth/logout");
    expect(req.method).toBe("POST");
    expect(req.credentials).toBe("include");
    expect(req.headers.get("X-CSRF-Token")).toBe("t");
  });

  it("returns endSessionUrl:null on a 403 (e.g. me() never ran) or malformed body", async () => {
    const fetch = fakeFetch({ logout: { status: 403, body: { error: "csrf" } } });
    expect(await makeClient(fetch).logout()).toEqual({ endSessionUrl: null });
  });
});

describe("createCookieBffAuthClient — loginUrl()", () => {
  it("builds `${serverOrigin}${loginPath}`", () => {
    const auth = createCookieBffAuthClient({
      serverOrigin: "https://api.example.com",
      ...PATHS,
      fetch: fakeFetch({}),
    });
    expect(auth.loginUrl()).toBe("https://api.example.com/auth/login");
  });

  it("honors a non-/auth login path and trims a trailing slash on origin", () => {
    const auth = createCookieBffAuthClient({
      serverOrigin: "https://api.example.com/",
      loginPath: "/api/v2/sign-in",
      logoutPath: "/api/v2/sign-out",
      mePath: "/api/v2/whoami",
      fetch: fakeFetch({}),
    });
    expect(auth.loginUrl()).toBe("https://api.example.com/api/v2/sign-in");
  });

  it("normalizes a path written without a leading slash", () => {
    const auth = createCookieBffAuthClient({
      serverOrigin: "https://api.example.com",
      loginPath: "auth/login",
      logoutPath: "auth/logout",
      mePath: "auth/me",
      fetch: fakeFetch({}),
    });
    expect(auth.loginUrl()).toBe("https://api.example.com/auth/login");
  });
});

// The module must never reference `window` (navigation stays in the app). We
// can't easily assert "never imported" at runtime, but we CAN assert the public
// surface performs no navigation: logout/me/mutate return values / Promises and
// touching window.location is not part of any path. (The Biome browser-only
// zone in biome.jsonc + code review enforce the no-window rule structurally.)
describe("no navigation side-effects", () => {
  it("logout resolves a value and does not assign window.location", async () => {
    const before = globalThis.location?.href;
    const fetch = fakeFetch({
      logout: { status: 200, body: { endSessionUrl: "https://idp/logout" } },
    });
    const auth = createCookieBffAuthClient({
      serverOrigin: "https://api.example.com",
      ...PATHS,
      fetch,
    });
    await auth.logout();
    expect(globalThis.location?.href).toBe(before); // unchanged
  });
});
