// client.test.ts — `createOidcVerifyClient` end-to-end behavior.
//
// Tokens are MINTED with `jose`'s `SignJWT` against a real generated
// keypair, then served via a mocked discovery + JWKS pair. This means
// `jwtVerify`, `createRemoteJWKSet`, and the issuer assertion all run
// genuinely — the only fake parts are the two HTTP roundtrips.
//
// We do NOT use fake timers here. The verifier has no timing logic of
// its own; the only timing in play is JWT `exp`, which works correctly
// against the real wall clock when tokens are minted with
// `setExpirationTime("1h")`. Mixing fake timers with real-token
// timestamps causes spurious expiry failures.

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import {
  generateKeyPair,
  exportJWK,
  SignJWT,
  type CryptoKey,
  type JWK,
  type JWTPayload,
} from "jose";

import type { IncomingMessage } from "http";

import { createOidcVerifyClient } from "../client.js";
import { __resetMetadataCache } from "../discovery.js";

// ----- Test fixtures -----

const ISSUER = "https://auth.example.com/realms/demo";
const JWKS_URI = `${ISSUER}/protocol/openid-connect/certs`;
const CLIENT_ID = "orpc-ws-demo-spa";

interface SigningKeys {
  privateKey: CryptoKey;
  publicJwk: JWK;
}

async function makeSigningKeys(): Promise<SigningKeys> {
  // RS256 keypair. `extractable: true` so we can pull the public JWK
  // out and serve it from the mocked JWKS endpoint.
  const { publicKey, privateKey } = await generateKeyPair("RS256", {
    extractable: true,
  });
  const publicJwk = await exportJWK(publicKey);
  publicJwk.alg = "RS256";
  publicJwk.use = "sig";
  publicJwk.kid = "test-kid-1";
  return { privateKey, publicJwk };
}

/**
 * Mint a signed JWT for the test. `payload` is the JWT claims set; the
 * test passes `azp`/`aud`/`email`/etc. inline. `setIssuer` /
 * `setExpirationTime` / `setIssuedAt` are added by the helper so each
 * test only specifies what it cares about.
 */
async function mint(
  signingKey: CryptoKey,
  publicJwk: JWK,
  payload: JWTPayload & { sub?: string },
  opts: { exp?: string; issuer?: string } = {},
): Promise<string> {
  let builder = new SignJWT(payload)
    .setProtectedHeader({ alg: "RS256", kid: publicJwk.kid })
    .setIssuer(opts.issuer ?? ISSUER)
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? "1h");
  if (typeof payload.sub === "string") {
    builder = builder.setSubject(payload.sub);
  }
  return builder.sign(signingKey);
}

function discoveryDoc(issuer = ISSUER): Record<string, unknown> {
  return {
    issuer,
    jwks_uri: JWKS_URI,
  };
}

/**
 * Build a fetch spy that:
 *   - returns the discovery doc for any `.../.well-known/openid-configuration` URL,
 *   - returns the JWKS bundle for any URL matching `jwksUri`,
 *   - throws on anything else (catches accidental extra fetches).
 *
 * `onFetch` callback lets a test count or fail specific calls.
 */
function mockOidcFetch(
  publicJwk: JWK,
  options: {
    jwksUri?: string;
    onDiscovery?: (url: string) => void;
    onJwks?: (url: string) => void;
    discoveryStatus?: number;
    discoveryBody?: unknown;
  } = {},
): MockInstance {
  const jwksUri = options.jwksUri ?? JWKS_URI;
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input: string | URL | Request) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;
      if (url.endsWith("/.well-known/openid-configuration")) {
        options.onDiscovery?.(url);
        const status = options.discoveryStatus ?? 200;
        const body = options.discoveryBody ?? discoveryDoc();
        return new Response(
          typeof body === "string" ? body : JSON.stringify(body),
          { status },
        );
      }
      if (url === jwksUri) {
        options.onJwks?.(url);
        return new Response(JSON.stringify({ keys: [publicJwk] }), {
          status: 200,
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
}

/** Bare minimum `IncomingMessage`-shaped object for `VerifyClientContext`. */
const fakeReq = {} as IncomingMessage;

function ctx(token: string | null): {
  req: IncomingMessage;
  token: string | null;
  clientIp: string | undefined;
  origin: string;
  secure: boolean;
} {
  // `origin` / `secure` are required on `VerifyClientContext` (SEC-3) but
  // the OIDC verifier ignores them — token validity is origin-agnostic.
  return { req: fakeReq, token, clientIp: undefined, origin: "", secure: false };
}

// ----- Setup -----

let keys: SigningKeys;

beforeEach(async () => {
  __resetMetadataCache();
  keys = await makeSigningKeys();
});
afterEach(() => {
  vi.restoreAllMocks();
});

// ----- Tests -----

describe("createOidcVerifyClient — happy path", () => {
  it("verifies a valid token and returns the projected user", async () => {
    mockOidcFetch(keys.publicJwk);
    const token = await mint(keys.privateKey, keys.publicJwk, {
      sub: "user-1",
      azp: CLIENT_ID,
      email: "u@example.com",
      name: "Alice",
      preferred_username: "alice",
    });

    const verify = createOidcVerifyClient({
      issuerUrl: ISSUER,
      boundClaim: "azp",
      expectedClientId: CLIENT_ID,
    });
    const result = await verify(ctx(token));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.user.sub).toBe("user-1");
    expect(result.user.email).toBe("u@example.com");
    expect(result.user.name).toBe("Alice");
    expect(result.user.preferred_username).toBe("alice");
    // `connectionKey` MUST be derived from the verified payload `sub`,
    // independent of any future custom `mapUser` shape — the registry
    // depends on it for one-connection-per-user / 4005 kicked-on-replace.
    expect(result.connectionKey).toBe("user-1");
  });

  it("api-4: surfaces the verified `exp` as `expiresAt` in epoch MILLISECONDS", async () => {
    // API-4 (security review): the verified `exp` used to be discarded at
    // the seam, so the server core could never enforce token lifetime on
    // a live connection. The success result now carries `expiresAt`
    // converted from JWT epoch-seconds to the `Clock.now()` ms unit.
    mockOidcFetch(keys.publicJwk);
    const token = await mint(keys.privateKey, keys.publicJwk, {
      sub: "user-1",
      azp: CLIENT_ID,
    });

    const verify = createOidcVerifyClient({
      issuerUrl: ISSUER,
      boundClaim: "azp",
      expectedClientId: CLIENT_ID,
    });
    const result = await verify(ctx(token));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(typeof result.expiresAt).toBe("number");
    // Minted with `setExpirationTime("1h")` against the real wall clock:
    // the ms value must land within (now, now + 1h] — i.e. it was
    // multiplied by 1000, not left in seconds (a seconds value would be
    // ~56 years in the past on the ms scale).
    const now = Date.now();
    expect(result.expiresAt!).toBeGreaterThan(now);
    expect(result.expiresAt!).toBeLessThanOrEqual(now + 60 * 60 * 1000 + 5_000);
  });

  it("preserves `preferred_username` as its own field (not collapsed into name)", async () => {
    // Old apps/demo-server/src/auth.ts collapsed `name ?? preferred_username`
    // into a single `name` slot. The library default does NOT collapse —
    // this test pins the new behavior.
    mockOidcFetch(keys.publicJwk);
    const token = await mint(keys.privateKey, keys.publicJwk, {
      sub: "user-1",
      azp: CLIENT_ID,
      preferred_username: "alice",
      // no `name` claim
    });
    const verify = createOidcVerifyClient({
      issuerUrl: ISSUER,
      boundClaim: "azp",
      expectedClientId: CLIENT_ID,
    });
    const result = await verify(ctx(token));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.user.name).toBeUndefined();
    expect(result.user.preferred_username).toBe("alice");
  });
});

describe("createOidcVerifyClient — boundClaim variants", () => {
  it('rejects mismatched client_id when boundClaim is "azp"', async () => {
    mockOidcFetch(keys.publicJwk);
    const token = await mint(keys.privateKey, keys.publicJwk, {
      sub: "user-1",
      azp: "different-spa",
    });
    const verify = createOidcVerifyClient({
      issuerUrl: ISSUER,
      boundClaim: "azp",
      expectedClientId: CLIENT_ID,
    });
    const result = await verify(ctx(token));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Reject `code` is an HTTP status (401), not a WS close code — so the
    // HTTP upload reject path (Node `res.statusCode`) doesn't throw on it.
    expect(result.code).toBe(401);
    expect(result.reason).toContain("Unexpected azp");
    expect(result.reason).toContain("different-spa");
  });

  it('accepts matching aud (string form) when boundClaim is "aud"', async () => {
    mockOidcFetch(keys.publicJwk);
    const token = await mint(keys.privateKey, keys.publicJwk, {
      sub: "user-1",
      aud: CLIENT_ID,
    });
    const verify = createOidcVerifyClient({
      issuerUrl: ISSUER,
      boundClaim: "aud",
      expectedClientId: CLIENT_ID,
    });
    const result = await verify(ctx(token));
    expect(result.ok).toBe(true);
  });

  it('accepts matching aud (array form) when boundClaim is "aud"', async () => {
    mockOidcFetch(keys.publicJwk);
    const token = await mint(keys.privateKey, keys.publicJwk, {
      sub: "user-1",
      aud: ["account", CLIENT_ID, "other-api"],
    });
    const verify = createOidcVerifyClient({
      issuerUrl: ISSUER,
      boundClaim: "aud",
      expectedClientId: CLIENT_ID,
    });
    const result = await verify(ctx(token));
    expect(result.ok).toBe(true);
  });

  it('rejects when aud array does not include expectedClientId', async () => {
    mockOidcFetch(keys.publicJwk);
    const token = await mint(keys.privateKey, keys.publicJwk, {
      sub: "user-1",
      aud: ["account", "different-spa"],
    });
    const verify = createOidcVerifyClient({
      issuerUrl: ISSUER,
      boundClaim: "aud",
      expectedClientId: CLIENT_ID,
    });
    const result = await verify(ctx(token));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("Unexpected aud");
  });

  it("skips the client-binding check when boundClaim is false", async () => {
    mockOidcFetch(keys.publicJwk);
    // No `azp` and a non-matching `aud` — both checks would have
    // rejected. boundClaim:false says we trust the upstream binding.
    const token = await mint(keys.privateKey, keys.publicJwk, {
      sub: "user-1",
      aud: ["nothing-matches"],
    });
    const verify = createOidcVerifyClient({
      issuerUrl: ISSUER,
      boundClaim: false,
    });
    const result = await verify(ctx(token));
    expect(result.ok).toBe(true);
  });

  it("throws at factory time when boundClaim requires expectedClientId but it's missing", async () => {
    expect(() =>
      createOidcVerifyClient({
        issuerUrl: ISSUER,
        boundClaim: "azp",
      }),
    ).toThrow(/expectedClientId is required/);
    expect(() =>
      createOidcVerifyClient({
        issuerUrl: ISSUER,
        boundClaim: "aud",
      }),
    ).toThrow(/expectedClientId is required/);
  });
});

describe("createOidcVerifyClient — rejection cases", () => {
  it("rejects when ctx.token is null", async () => {
    // No fetch needed — token absence short-circuits before discovery.
    const verify = createOidcVerifyClient({
      issuerUrl: ISSUER,
      boundClaim: "azp",
      expectedClientId: CLIENT_ID,
    });
    const result = await verify(ctx(null));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe(401);
    expect(result.reason).toBe("Missing token");
  });

  it("rejects when token is missing sub", async () => {
    mockOidcFetch(keys.publicJwk);
    const token = await mint(keys.privateKey, keys.publicJwk, {
      azp: CLIENT_ID,
      // no sub
    });
    const verify = createOidcVerifyClient({
      issuerUrl: ISSUER,
      boundClaim: "azp",
      expectedClientId: CLIENT_ID,
    });
    const result = await verify(ctx(token));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("Token missing sub");
  });

  it("rejects when token issuer doesn't match the configured issuerUrl", async () => {
    mockOidcFetch(keys.publicJwk);
    const token = await mint(
      keys.privateKey,
      keys.publicJwk,
      { sub: "user-1", azp: CLIENT_ID },
      { issuer: "https://attacker.example.com" },
    );
    const verify = createOidcVerifyClient({
      issuerUrl: ISSUER,
      boundClaim: "azp",
      expectedClientId: CLIENT_ID,
    });
    const result = await verify(ctx(token));
    expect(result.ok).toBe(false);
  });

  it("rejects when signature is invalid (wrong key)", async () => {
    mockOidcFetch(keys.publicJwk);
    // Mint with a DIFFERENT key but advertise the same kid — jose
    // will fetch the (correct) JWKS, find the kid, try to verify the
    // signature, and fail.
    const otherKeys = await makeSigningKeys();
    otherKeys.publicJwk.kid = keys.publicJwk.kid;
    const token = await mint(otherKeys.privateKey, otherKeys.publicJwk, {
      sub: "user-1",
      azp: CLIENT_ID,
    });
    const verify = createOidcVerifyClient({
      issuerUrl: ISSUER,
      boundClaim: "azp",
      expectedClientId: CLIENT_ID,
    });
    const result = await verify(ctx(token));
    expect(result.ok).toBe(false);
  });
});

describe("createOidcVerifyClient — verifyClaims callback", () => {
  it("rejects when verifyClaims returns false", async () => {
    mockOidcFetch(keys.publicJwk);
    const token = await mint(keys.privateKey, keys.publicJwk, {
      sub: "user-1",
      azp: CLIENT_ID,
    });
    const verify = createOidcVerifyClient({
      issuerUrl: ISSUER,
      boundClaim: "azp",
      expectedClientId: CLIENT_ID,
      verifyClaims: () => false,
    });
    const result = await verify(ctx(token));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("Custom claim validation failed");
  });

  it("rejects with the thrown message when verifyClaims throws", async () => {
    mockOidcFetch(keys.publicJwk);
    const token = await mint(keys.privateKey, keys.publicJwk, {
      sub: "user-1",
      azp: CLIENT_ID,
    });
    const verify = createOidcVerifyClient({
      issuerUrl: ISSUER,
      boundClaim: "azp",
      expectedClientId: CLIENT_ID,
      verifyClaims: () => {
        throw new Error("scope missing");
      },
    });
    const result = await verify(ctx(token));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("scope missing");
  });

  it("passes the verified payload to verifyClaims", async () => {
    mockOidcFetch(keys.publicJwk);
    const token = await mint(keys.privateKey, keys.publicJwk, {
      sub: "user-1",
      azp: CLIENT_ID,
      scope: "read write",
    });
    let seen: JWTPayload | null = null;
    const verify = createOidcVerifyClient({
      issuerUrl: ISSUER,
      boundClaim: "azp",
      expectedClientId: CLIENT_ID,
      verifyClaims: (payload) => {
        seen = payload;
        return true;
      },
    });
    const result = await verify(ctx(token));
    expect(result.ok).toBe(true);
    expect(seen).not.toBeNull();
    // Narrow once we've asserted non-null.
    expect((seen as unknown as JWTPayload | null)?.["scope"]).toBe(
      "read write",
    );
  });
});

describe("createOidcVerifyClient — caching + dedup", () => {
  it("performs a single discovery fetch for N concurrent first verifies", async () => {
    let discoveryCount = 0;
    let jwksCount = 0;
    mockOidcFetch(keys.publicJwk, {
      onDiscovery: () => {
        discoveryCount++;
      },
      onJwks: () => {
        jwksCount++;
      },
    });
    const token = await mint(keys.privateKey, keys.publicJwk, {
      sub: "user-1",
      azp: CLIENT_ID,
    });

    const verify = createOidcVerifyClient({
      issuerUrl: ISSUER,
      boundClaim: "azp",
      expectedClientId: CLIENT_ID,
    });

    const results = await Promise.all(
      Array.from({ length: 5 }, () => verify(ctx(token))),
    );
    for (const r of results) expect(r.ok).toBe(true);
    expect(discoveryCount).toBe(1);
    // JWKS fetch may happen 1 or N times depending on jose internals
    // (createRemoteJWKSet caches per-instance); we built one instance,
    // so 1 is the expected steady-state. The dedup contract this test
    // pins is on discovery.
    expect(jwksCount).toBeLessThanOrEqual(1);
  });

  it("evicts discovery cache on failure so a retry can succeed", async () => {
    // 1st call: discovery fails -> verify rejects.
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("oops", { status: 500 }),
    );
    const verify = createOidcVerifyClient({
      issuerUrl: ISSUER,
      boundClaim: "azp",
      expectedClientId: CLIENT_ID,
    });
    const r1 = await verify(ctx("any-token-since-discovery-fails"));
    expect(r1.ok).toBe(false);

    // 2nd call: discovery and JWKS now serve correctly.
    mockOidcFetch(keys.publicJwk);
    const token = await mint(keys.privateKey, keys.publicJwk, {
      sub: "user-1",
      azp: CLIENT_ID,
    });
    const r2 = await verify(ctx(token));
    expect(r2.ok).toBe(true);
  });
});

describe("createOidcVerifyClient — custom mapUser", () => {
  it("uses the provided mapUser to project the payload", async () => {
    mockOidcFetch(keys.publicJwk);
    const token = await mint(keys.privateKey, keys.publicJwk, {
      sub: "user-1",
      azp: CLIENT_ID,
      email: "u@example.com",
    });

    interface AppUser {
      id: string;
      mail: string | undefined;
    }
    const verify = createOidcVerifyClient<AppUser>(
      {
        issuerUrl: ISSUER,
        boundClaim: "azp",
        expectedClientId: CLIENT_ID,
      },
      (payload) => ({
        id: payload.sub as string,
        mail:
          typeof payload["email"] === "string"
            ? (payload["email"] as string)
            : undefined,
      }),
    );
    const result = await verify(ctx(token));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.user).toEqual({ id: "user-1", mail: "u@example.com" });
    // `connectionKey` MUST still equal payload.sub even with custom mapper.
    expect(result.connectionKey).toBe("user-1");
  });
});

describe("createOidcVerifyClient — discoveryUrl (split internal/public URLs)", () => {
  // Container-networking case: the browser (and the token `iss`) use
  // the PUBLIC issuer; the server container reaches the IdP only via
  // the INTERNAL hostname. Discovery + JWKS must be fetched internally
  // while `issuer`/`iss` validation stays pinned to the public URL.
  const PUBLIC_ISSUER = "http://public.example:18080/realms/demo";
  const INTERNAL_BASE = "http://internal.example:8080/realms/demo";
  const PUBLIC_JWKS = `${PUBLIC_ISSUER}/protocol/openid-connect/certs`;
  const INTERNAL_JWKS = `${INTERNAL_BASE}/protocol/openid-connect/certs`;

  it("fetches discovery + JWKS from the internal URL but validates iss against the public issuer", async () => {
    const discoveryUrls: string[] = [];
    const jwksUrls: string[] = [];
    // JWKS is ONLY served at the internal URL — a fetch of the public
    // jwks_uri would hit the mock's "unexpected fetch" throw and fail
    // verification, so success alone proves the rewrite. The recorded
    // URLs make the assertion explicit anyway.
    mockOidcFetch(keys.publicJwk, {
      jwksUri: INTERNAL_JWKS,
      // The IdP (KC_HOSTNAME pinned to the public URL) advertises the
      // PUBLIC issuer + PUBLIC jwks_uri even when fetched internally.
      discoveryBody: { issuer: PUBLIC_ISSUER, jwks_uri: PUBLIC_JWKS },
      onDiscovery: (url) => discoveryUrls.push(url),
      onJwks: (url) => jwksUrls.push(url),
    });
    const token = await mint(
      keys.privateKey,
      keys.publicJwk,
      { sub: "user-1", azp: CLIENT_ID },
      { issuer: PUBLIC_ISSUER },
    );

    const verify = createOidcVerifyClient({
      issuerUrl: PUBLIC_ISSUER,
      discoveryUrl: INTERNAL_BASE,
      boundClaim: "azp",
      expectedClientId: CLIENT_ID,
    });
    const result = await verify(ctx(token));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.user.sub).toBe("user-1");
    // Discovery was fetched from the INTERNAL host, not the public one.
    expect(discoveryUrls).toEqual([
      `${INTERNAL_BASE}/.well-known/openid-configuration`,
    ]);
    // JWKS was fetched from the issuer-prefix-REWRITTEN internal URL —
    // never from the public jwks_uri the discovery doc advertised.
    expect(jwksUrls).toEqual([INTERNAL_JWKS]);
  });

  it("rejects a token whose iss is the internal URL (validation stays on the public issuer)", async () => {
    mockOidcFetch(keys.publicJwk, {
      jwksUri: INTERNAL_JWKS,
      discoveryBody: { issuer: PUBLIC_ISSUER, jwks_uri: PUBLIC_JWKS },
    });
    // Minted with `iss` = INTERNAL url — must fail the issuer check
    // even though that's the URL we fetch from.
    const token = await mint(
      keys.privateKey,
      keys.publicJwk,
      { sub: "user-1", azp: CLIENT_ID },
      { issuer: INTERNAL_BASE },
    );
    const verify = createOidcVerifyClient({
      issuerUrl: PUBLIC_ISSUER,
      discoveryUrl: INTERNAL_BASE,
      boundClaim: "azp",
      expectedClientId: CLIENT_ID,
    });
    const result = await verify(ctx(token));
    expect(result.ok).toBe(false);
  });

  it("rejects when the discovery doc advertises an issuer != issuerUrl", async () => {
    // The metadata-issuer assertion still guards in split-URL mode: a
    // doc advertising anything other than the configured PUBLIC issuer
    // (here: the internal URL itself, the classic KC_HOSTNAME
    // misconfiguration) is rejected before any token is checked.
    mockOidcFetch(keys.publicJwk, {
      jwksUri: INTERNAL_JWKS,
      discoveryBody: { issuer: INTERNAL_BASE, jwks_uri: INTERNAL_JWKS },
    });
    const token = await mint(
      keys.privateKey,
      keys.publicJwk,
      { sub: "user-1", azp: CLIENT_ID },
      { issuer: PUBLIC_ISSUER },
    );
    const verify = createOidcVerifyClient({
      issuerUrl: PUBLIC_ISSUER,
      discoveryUrl: INTERNAL_BASE,
      boundClaim: "azp",
      expectedClientId: CLIENT_ID,
    });
    const result = await verify(ctx(token));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe(401);
    expect(result.reason).toContain("issuer mismatch");
  });

  it("uses a foreign-host jwks_uri as-is (no rewrite when it doesn't start with issuerUrl)", async () => {
    const FOREIGN_JWKS = "https://keys.cdn.example/tenant-demo/jwks.json";
    const jwksUrls: string[] = [];
    mockOidcFetch(keys.publicJwk, {
      jwksUri: FOREIGN_JWKS,
      discoveryBody: { issuer: PUBLIC_ISSUER, jwks_uri: FOREIGN_JWKS },
      onJwks: (url) => jwksUrls.push(url),
    });
    const token = await mint(
      keys.privateKey,
      keys.publicJwk,
      { sub: "user-1", azp: CLIENT_ID },
      { issuer: PUBLIC_ISSUER },
    );
    const verify = createOidcVerifyClient({
      issuerUrl: PUBLIC_ISSUER,
      discoveryUrl: INTERNAL_BASE,
      boundClaim: "azp",
      expectedClientId: CLIENT_ID,
    });
    const result = await verify(ctx(token));
    expect(result.ok).toBe(true);
    expect(jwksUrls).toEqual([FOREIGN_JWKS]);
  });
});
