// Composition root: `createOidcVerifyClient` — the factory that
// produces a `VerifyClient` compatible with `@orpc-ws/server`.
//
// Pipeline (per verify):
//   1. Reject when `ctx.token` is null (consumer's verify decides what
//      that means; library ships "reject with code 401" as the
//      sensible default).
//
// Reject `code` is an HTTP status (401 Unauthorized), NOT a WS close code.
// `VerifyClientResult.code` is documented (verify-client-orchestrator.ts) as
// the pre-101 status: on the WS path `ws` writes it as the handshake-abort
// status, and on the HTTP upload path Node writes it as `res.statusCode` —
// which REJECTS out-of-range values (a WS close code like 4001 throws
// ERR_HTTP_INVALID_STATUS_CODE and crashes the reject path). Earlier this
// returned 4001 (a WS close code); that was a contract violation the WS
// path tolerated by accident but the HTTP path could not. The 4001 *close*
// code lives on, correctly, in the server's post-open `authFailedCloseCode`.
//   2. Lazily fetch + cache the discovery document via `fetchMetadata`
//      (module-level cache in `discovery.ts`, shared across concurrent
//      callers).
//   3. Lazily build a `createRemoteJWKSet` for the discovered jwks_uri
//      (cached per-factory on first use — jose's remote-JWKS object
//      handles its own internal key rotation).
//   4. Run `jwtVerify(token, jwks, { issuer })` — this validates the
//      signature, exp, nbf, and issuer claim in one step.
//   5. Reject when `sub` is missing.
//   6. Apply the configured `boundClaim` check (`azp` / `aud` / off).
//   7. Run the optional `verifyClaims` callback; reject if it returns
//      false or throws.
//   8. Project the payload to `TUser` via `mapUser` (defaults to the
//      standard OIDC field set).
//
// The factory is sync. The first verify pays one Discovery roundtrip
// + one JWKS roundtrip; both are cached after.

import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from "jose";

import type { VerifyClient } from "@orpc-ws/server";

import { fetchMetadata, rewriteJwksUri } from "./discovery.js";
import type { OidcUser, OidcVerifierConfig } from "./types.js";

/**
 * Default `alg` allowlist for `jwtVerify` — the common asymmetric set.
 * Symmetric (`HS*`) algorithms are deliberately absent: a token verified
 * against a public JWKS must never be HMAC-signed (the RS→HS
 * key-confusion downgrade). Overridable via `cfg.algorithms`.
 */
const DEFAULT_ALGORITHMS = [
  "RS256",
  "RS384",
  "RS512",
  "ES256",
  "ES384",
  "ES512",
  "PS256",
  "PS384",
  "PS512",
  "EdDSA",
];

/**
 * Default mapper. Pulls the standard OIDC subject fields off the
 * payload. `preferred_username` is preserved AS-IS (not collapsed
 * into `name`) so consumers can distinguish "display name" from
 * "login handle".
 *
 * The old `apps/demo-server/src/auth.ts` collapsed
 * `name ?? preferred_username` into `name`; that's a per-app decision,
 * not a library default. Consumers wanting the collapsed shape pass a
 * custom `mapUser`.
 */
function defaultMapUser(payload: JWTPayload): OidcUser {
  const out: OidcUser = {
    sub: typeof payload.sub === "string" ? payload.sub : "",
  };
  if (typeof payload["email"] === "string") {
    out.email = payload["email"] as string;
  }
  if (typeof payload["name"] === "string") {
    out.name = payload["name"] as string;
  }
  if (typeof payload["preferred_username"] === "string") {
    out.preferred_username = payload["preferred_username"] as string;
  }
  return out;
}

/**
 * Build a `verifyClient` callback for an OIDC IdP.
 *
 * The factory is sync — discovery + JWKS fetches are deferred to the
 * first verify so `useFactory` callers don't have to deal with async
 * boot. Closure-local cache means subsequent verifies skip both
 * roundtrips.
 *
 * `boundClaim` defaults to `"azp"` (Keycloak shape). For Auth0 / Okta /
 * Cognito, set `"aud"`; for sender-constrained tokens, set `false`.
 *
 * `mapUser` defaults to extracting `{ sub, email, name, preferred_username }`.
 * Custom mappers may return any shape (typed as `TUser`); the library
 * surfaces it back through `VerifyClientResult.user`.
 */
export function createOidcVerifyClient<TUser = OidcUser>(
  cfg: OidcVerifierConfig,
  mapUser?: (payload: JWTPayload) => TUser,
): VerifyClient<TUser> {
  // Config-time sanity: misconfigured `boundClaim` means tokens get
  // accepted that shouldn't. Fail loud at boot, not at verify.
  const boundClaim = cfg.boundClaim ?? "azp";
  if (boundClaim !== false && !cfg.expectedClientId) {
    throw new Error(
      `[oidc-verifier-jose] expectedClientId is required when boundClaim is "${boundClaim}"`,
    );
  }

  // Default mapper is `defaultMapUser as (payload) => TUser`. This is
  // type-safe in the `TUser = OidcUser` default case (which is the
  // common path); when a consumer supplies `<TUser>` and omits
  // `mapUser`, the call site of `createOidcVerifyClient` itself will
  // surface the mismatch.
  const project: (payload: JWTPayload) => TUser =
    mapUser ?? (defaultMapUser as (payload: JWTPayload) => TUser);

  // Where to FETCH discovery + JWKS from. Defaults to the public
  // issuer (single-URL case — behavior identical to before
  // `discoveryUrl` existed). When set, the server talks to the IdP
  // over this internal host while all VALIDATION (discovery `issuer`,
  // token `iss`) stays pinned to the public `issuerUrl`.
  const discoveryBase = cfg.discoveryUrl ?? cfg.issuerUrl;

  // JWKS lazy + cached. `createRemoteJWKSet` returns a callable that
  // does its own rotation handling; we just need to build it once
  // per process (per factory call, really, but the discovery cache
  // dedups across factories).
  let jwks: JWTVerifyGetKey | null = null;

  return async (ctx) => {
    const token = ctx.token;
    if (!token) {
      return { ok: false, code: 401, reason: "Missing token" };
    }

    try {
      const metadata = await fetchMetadata(discoveryBase, cfg.issuerUrl);
      if (jwks === null) {
        // The advertised `jwks_uri` is on the public issuer host; in a
        // split-URL setup the server can't reach it — rewrite the
        // issuer prefix to the internal base (no-op when discoveryUrl
        // is unset or jwks_uri lives on a foreign host).
        jwks = createRemoteJWKSet(
          new URL(rewriteJwksUri(metadata.jwks_uri, cfg.issuerUrl, discoveryBase)),
        );
      }

      const { payload } = await jwtVerify(token, jwks, {
        // `metadata.issuer` is asserted equal to the PUBLIC
        // `cfg.issuerUrl` by `fetchMetadata` (trailing-slash
        // normalized), so this validates `iss` against the public
        // issuer — never the internal fetch host. Using the doc's
        // exact string (vs cfg's) keeps the comparison robust to a
        // consumer-side trailing slash.
        issuer: metadata.issuer,
        // Pin the accepted `alg` header values (asymmetric-only by
        // default) so an HS*-signed token is rejected before key
        // resolution — see DEFAULT_ALGORITHMS.
        algorithms: cfg.algorithms ?? DEFAULT_ALGORITHMS,
        // Clock-skew tolerance for exp/nbf — only forwarded when the
        // consumer set it, so the default stays jose's zero tolerance.
        ...(cfg.clockTolerance !== undefined
          ? { clockTolerance: cfg.clockTolerance }
          : {}),
      });

      if (typeof payload.sub !== "string" || payload.sub.length === 0) {
        return { ok: false, code: 401, reason: "Token missing sub" };
      }

      const boundCheck = checkBoundClaim(payload, boundClaim, cfg.expectedClientId);
      if (boundCheck !== null) {
        return { ok: false, code: 401, reason: boundCheck };
      }

      if (cfg.verifyClaims) {
        let extraOk: boolean;
        try {
          extraOk = await cfg.verifyClaims(payload);
        } catch (err) {
          return {
            ok: false,
            code: 401,
            reason: err instanceof Error ? err.message : String(err),
          };
        }
        if (!extraOk) {
          return {
            ok: false,
            code: 401,
            reason: "Custom claim validation failed",
          };
        }
      }

      return {
        ok: true,
        user: project(payload),
        // `connectionKey` is the registry's session key (one-connection-
        // per-user, 4005 kicked-on-replace). Use the raw `sub` from the
        // verified payload — independent of `mapUser` so a custom mapper
        // can't accidentally break session-replacement by dropping the
        // field.
        connectionKey: payload.sub,
        // Surface the verified expiry so the server core can enforce a
        // time-bound session (`enforceTokenExpiry`). JWT `exp` is epoch
        // SECONDS; `VerifyClientResult.expiresAt` is epoch MILLISECONDS
        // (the `Clock.now()` unit) — convert here, at the seam.
        ...(typeof payload.exp === "number"
          ? { expiresAt: payload.exp * 1000 }
          : {}),
      };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return { ok: false, code: 401, reason };
    }
  };
}

/**
 * Apply the configured client-binding check. Returns `null` on pass,
 * a rejection-reason string on fail.
 *
 * Branches:
 *   - `false`:  no check (consumer opted out).
 *   - `"azp"`:  Keycloak / Microsoft v1 — `payload.azp` must equal
 *               `expectedClientId`.
 *   - `"aud"`:  most OIDC providers — `expectedClientId` must appear
 *               in `payload.aud` (handle both string and string[]).
 *
 * `expectedClientId` is asserted at factory call when `boundClaim` is
 * `"azp"` or `"aud"`, so the `!` here is safe.
 */
function checkBoundClaim(
  payload: JWTPayload,
  boundClaim: "azp" | "aud" | false,
  expectedClientId: string | undefined,
): string | null {
  if (boundClaim === false) return null;

  // Asserted at factory time; this is a runtime safety net.
  if (!expectedClientId) {
    return "Verifier misconfigured: expectedClientId missing";
  }

  if (boundClaim === "azp") {
    const azp = payload["azp"];
    if (azp !== expectedClientId) {
      return `Unexpected azp claim: ${typeof azp === "string" ? azp : "<missing>"}`;
    }
    return null;
  }

  // boundClaim === "aud"
  const aud = payload.aud;
  if (typeof aud === "string") {
    if (aud === expectedClientId) return null;
    return `Unexpected aud claim: ${aud}`;
  }
  if (Array.isArray(aud)) {
    if (aud.includes(expectedClientId)) return null;
    return `Unexpected aud claim: [${aud.join(",")}]`;
  }
  return "Token missing aud claim";
}
