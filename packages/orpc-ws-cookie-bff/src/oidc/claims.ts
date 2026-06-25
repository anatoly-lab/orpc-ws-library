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
}

/**
 * Decode the whitelisted claims from an id_token's payload. Returns
 * `{ sub: "" }` for a null/malformed token (the caller treats an empty `sub`
 * as a failed login). Signature is NOT verified here — see the file header for
 * why that is safe. Only the fields in {@link IdTokenClaims} are copied; raw
 * IdP JSON is never spread in wholesale.
 */
export function decodeIdTokenClaims(idToken: string | null): IdTokenClaims {
  if (!idToken) return { sub: "" };
  const payloadB64 = idToken.split(".")[1];
  if (!payloadB64) return { sub: "" };
  try {
    const json = Buffer.from(payloadB64, "base64url").toString("utf8");
    const raw = JSON.parse(json) as Record<string, unknown>;
    const claims: IdTokenClaims = {
      sub: typeof raw.sub === "string" ? raw.sub : "",
    };
    if (typeof raw.email === "string") claims.email = raw.email;
    if (typeof raw.email_verified === "boolean") {
      claims.emailVerified = raw.email_verified;
    }
    if (typeof raw.name === "string") claims.name = raw.name;
    if (typeof raw.given_name === "string") claims.givenName = raw.given_name;
    if (typeof raw.family_name === "string") {
      claims.familyName = raw.family_name;
    }
    if (typeof raw.preferred_username === "string") {
      claims.preferredUsername = raw.preferred_username;
    }
    return claims;
  } catch {
    return { sub: "" };
  }
}
