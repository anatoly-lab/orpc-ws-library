// id_token claim decoding (display/identity only, NOT a security boundary).
//
// The id_token arrives over a direct server-to-server TLS POST to the IdP's
// token endpoint (in code-exchange), so its provenance is already trusted at
// this point — we decode it to pass claims into the consumer's `resolveUser`
// hook. (The WS access token, by contrast, is the security boundary; but in
// cookie-BFF the WS connection authenticates against the SESSION, not a JWT.)
// We hand-decode the base64url payload rather than dragging in `jose` for a
// claims-extraction concern.

/**
 * Standard OIDC id_token claims surfaced to `resolveUser`.
 *
 * A WHITELIST, not a passthrough: only the standard fields below are copied
 * out of the (untrusted) id_token payload. We deliberately do NOT spread the
 * raw JSON in — an IdP (or a tampered token, though provenance is trusted
 * here) could otherwise inject arbitrary keys that `resolveUser` or a logger
 * downstream mistakes for vetted claims. A consumer needing an extra claim
 * adds it explicitly to this whitelist.
 */
export interface IdTokenClaims {
  /** Subject — Keycloak `sub`. The session/connection key. */
  sub: string;
  email?: string;
  /** Whether the IdP marked the email verified. */
  emailVerified?: boolean;
  name?: string;
  givenName?: string;
  familyName?: string;
  preferredUsername?: string;
  /** Profile picture URL (standard OIDC `picture` claim). */
  picture?: string;
}

/** The decoded id_token: the typed whitelist + the FULL raw payload (F2). */
export interface DecodedIdToken {
  /** The whitelisted, typed claims. */
  claims: IdTokenClaims;
  /**
   * The FULL decoded payload — every claim the IdP sent. Surfaced to
   * `resolveUser` so a TRUSTED consumer can read ANY claim (incl. non-standard
   * ones) without a library release. The library itself only ever reads the
   * typed `claims`; it never auto-spreads `raw` into anything stored — that
   * would reintroduce the "untrusted JSON into the stored user" hazard the
   * whitelist exists to prevent. `{}` for a null/malformed token.
   */
  raw: Record<string, unknown>;
}

/** Map a parsed raw payload to the typed whitelist (no signature check). */
function whitelist(raw: Record<string, unknown>): IdTokenClaims {
  const claims: IdTokenClaims = {
    sub: typeof raw.sub === "string" ? raw.sub : "",
  };
  if (typeof raw.email === "string") claims.email = raw.email;
  if (typeof raw.email_verified === "boolean") {
    claims.emailVerified = raw.email_verified;
  }
  if (typeof raw.name === "string") claims.name = raw.name;
  if (typeof raw.given_name === "string") claims.givenName = raw.given_name;
  if (typeof raw.family_name === "string") claims.familyName = raw.family_name;
  if (typeof raw.preferred_username === "string") {
    claims.preferredUsername = raw.preferred_username;
  }
  if (typeof raw.picture === "string") claims.picture = raw.picture;
  return claims;
}

/**
 * Decode the WHITELISTED claims from an id_token's payload. Returns
 * `{ sub: "" }` for a null/malformed token (the caller treats an empty `sub`
 * as a failed login). Signature is NOT verified here — see the file header.
 * Only the fields in {@link IdTokenClaims} are copied; raw IdP JSON is never
 * spread in wholesale. (Prefer {@link decodeIdToken} when you also need the
 * raw payload — e.g. inside the callback handler for `resolveUser`.)
 */
export function decodeIdTokenClaims(idToken: string | null): IdTokenClaims {
  return decodeIdToken(idToken).claims;
}

/**
 * Decode an id_token into BOTH the typed whitelist AND the full raw payload
 * (F2). `{ claims: { sub: "" }, raw: {} }` for a null/malformed token. The raw
 * payload lets `resolveUser` read any claim; the security guarantee (the
 * library stores only what `resolveUser` returns) is unchanged.
 */
export function decodeIdToken(idToken: string | null): DecodedIdToken {
  if (!idToken) return { claims: { sub: "" }, raw: {} };
  const payloadB64 = idToken.split(".")[1];
  if (!payloadB64) return { claims: { sub: "" }, raw: {} };
  try {
    const json = Buffer.from(payloadB64, "base64url").toString("utf8");
    const raw = JSON.parse(json) as Record<string, unknown>;
    // Guard: a non-object payload (e.g. `"foo"` or `42`) parses but isn't a
    // claims object — treat as malformed.
    if (typeof raw !== "object" || raw === null) {
      return { claims: { sub: "" }, raw: {} };
    }
    return { claims: whitelist(raw), raw };
  } catch {
    return { claims: { sub: "" }, raw: {} };
  }
}
