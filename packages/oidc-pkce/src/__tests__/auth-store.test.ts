// Snapshot-stability regression tests for the reactive auth seam.
//
// The blocker (B1): `getAuthState()` must return a REFERENTIALLY STABLE
// object while the underlying id_token is unchanged. `useSyncExternalStore`
// bails out of re-rendering only when `getSnapshot()` returns the same
// reference as last time; a fresh object per emit causes spurious
// re-renders (and React's "getSnapshot should be cached" loop). The root
// cause was `getUser()` decoding a brand-new `OidcUser` on every call, so
// the store's `next.user !== cached.user` dedupe was always true.
//
// These tests pin the end-to-end contract: same token in → same reference
// out, even across a no-op emit; a token change yields a new reference with
// the new value.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createOidcAuth } from "../client.js";
import type { OidcConfig, Storage, Tokens } from "../types.js";

// Minimal in-memory Storage. Reads always reflect the latest write — the
// store's `compute` thunk reads through this same handle, so a write here
// is visible to the next `getAuthState()`.
function memoryStorage(initial?: Tokens | null): Storage {
  let value: Tokens | null = initial ?? null;
  return {
    read: (): Tokens | null => value,
    write: (tokens: Tokens): void => {
      value = tokens;
    },
    clear: (): void => {
      value = null;
    },
  };
}

// id_token (header.payload.signature) carrying the given claims. `alg:none`
// is fine — the package decodes WITHOUT verifying (display-only).
function makeIdToken(claims: Record<string, unknown>): string {
  const header = btoa(JSON.stringify({ alg: "none", typ: "JWT" }));
  const payload = btoa(JSON.stringify(claims));
  return `${header}.${payload}.sig`;
}

function makeTokens(overrides?: Partial<Tokens>): Tokens {
  return {
    accessToken: "access-tok",
    refreshToken: "refresh-tok",
    idToken: makeIdToken({ sub: "user-123", email: "a@b.com" }),
    expiresAt: Date.now() + 60_000,
    ...overrides,
  };
}

const config: OidcConfig = {
  issuerUrl: "https://idp.example.com/realms/test",
  clientId: "test-client",
  redirectUri: "https://app.example.com/callback",
};

// Fire the browser `storage` event the cross-tab seam listens for. The
// library filters on `e.key === "oidc.tokens"` (or null for full clears).
function fireStorageEvent(): void {
  window.dispatchEvent(new StorageEvent("storage", { key: "oidc.tokens" }));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getAuthState snapshot stability (B1)", () => {
  it("returns a stable reference across calls with no mutation", () => {
    const storage = memoryStorage(makeTokens());
    const auth = createOidcAuth(config, { storage });

    const s1 = auth.getAuthState();
    const s2 = auth.getAuthState();

    expect(s1).toBe(s2); // same reference — no spurious churn
    expect(s1.status).toBe("authenticated");
  });

  it("keeps the same reference across a no-op emit (same token)", () => {
    const storage = memoryStorage(makeTokens());
    const auth = createOidcAuth(config, { storage });

    // Subscribing materializes the store + registers the storage listener.
    const unsubscribe = auth.subscribe(() => {});
    const before = auth.getAuthState();

    // An emit with the token UNCHANGED must not produce a new snapshot:
    // this is exactly the path B1 broke (fresh user object every recompute).
    fireStorageEvent();
    const after = auth.getAuthState();

    expect(after).toBe(before); // still the same reference
    unsubscribe();
  });

  it("yields a NEW reference with new value when the id_token changes", () => {
    const storage = memoryStorage(makeTokens());
    const auth = createOidcAuth(config, { storage });

    const unsubscribe = auth.subscribe(() => {});
    const before = auth.getAuthState();
    expect(before.status).toBe("authenticated");
    if (before.status !== "authenticated") throw new Error("unreachable");
    expect(before.user.sub).toBe("user-123");

    // Rotate the id_token (a refresh that changes the subject's claims).
    storage.write(
      makeTokens({
        idToken: makeIdToken({ sub: "user-456", email: "c@d.com" }),
      }),
    );
    fireStorageEvent();
    const after = auth.getAuthState();

    expect(after).not.toBe(before); // logical change → new reference
    expect(after.status).toBe("authenticated");
    if (after.status !== "authenticated") throw new Error("unreachable");
    expect(after.user.sub).toBe("user-456");
    unsubscribe();
  });

  it("transitions to anonymous (new reference) when tokens are cleared", () => {
    const storage = memoryStorage(makeTokens());
    const auth = createOidcAuth(config, { storage });

    const unsubscribe = auth.subscribe(() => {});
    const authed = auth.getAuthState();
    expect(authed.status).toBe("authenticated");

    auth.clearTokens(); // same-tab notify
    const anon = auth.getAuthState();

    expect(anon).not.toBe(authed);
    expect(anon.status).toBe("anonymous");
    unsubscribe();
  });
});

describe("getUser memoization (B1 root cause)", () => {
  it("returns the SAME reference while the id_token is unchanged", () => {
    const storage = memoryStorage(makeTokens());
    const auth = createOidcAuth(config, { storage });

    const u1 = auth.getUser();
    const u2 = auth.getUser();

    expect(u1).not.toBeNull();
    expect(u1).toBe(u2); // memoized by id_token string
  });

  it("returns null and resets the cache when storage is cleared", () => {
    const storage = memoryStorage(makeTokens());
    const auth = createOidcAuth(config, { storage });

    expect(auth.getUser()).not.toBeNull();
    storage.clear();
    expect(auth.getUser()).toBeNull();

    // A later login must re-decode (cache was reset on the null read).
    storage.write(makeTokens());
    const reAuthed = auth.getUser();
    expect(reAuthed).not.toBeNull();
    expect(reAuthed?.sub).toBe("user-123");
  });

  it("re-decodes (new reference + new value) when the id_token changes", () => {
    const storage = memoryStorage(makeTokens());
    const auth = createOidcAuth(config, { storage });

    const first = auth.getUser();
    expect(first?.sub).toBe("user-123");

    storage.write(
      makeTokens({ idToken: makeIdToken({ sub: "user-999" }) }),
    );
    const second = auth.getUser();

    expect(second).not.toBe(first); // new token → new object
    expect(second?.sub).toBe("user-999");
  });

  it("caches a stable null for a malformed id_token (no re-decode churn)", () => {
    const storage = memoryStorage(makeTokens({ idToken: "not-a-jwt" }));
    const auth = createOidcAuth(config, { storage });

    // Both calls hit the same bad token; both return null without churning.
    expect(auth.getUser()).toBeNull();
    expect(auth.getUser()).toBeNull();
  });
});
