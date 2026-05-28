// PKCE crypto primitives — pure functions, no storage, no fetch.
//
// RFC 7636 (PKCE) requires:
//   - verifier: 43..128 chars, url-safe ASCII (`[A-Za-z0-9-._~]`)
//   - challenge: base64url(SHA-256(verifier))
//
// We generate 64 random bytes for the verifier (~86 chars base64url-encoded,
// comfortably inside the spec range and well above the 256-bit entropy
// recommended in §7.1). The `state` value is a separate 32-byte random
// string used for CSRF protection on the redirect round-trip.
//
// All functions are deterministic given their inputs (the random ones
// being functions of `crypto.getRandomValues`) so they can be unit-tested
// without mocking — `pkceChallenge()` against the RFC 7636 Appendix B
// fixture is a sufficient regression for the SHA-256 + base64url path.

/**
 * base64url encoder per RFC 4648 §5: standard base64 with `+`→`-`,
 * `/`→`_`, and trailing `=` stripped. Operates on raw bytes (the only
 * shape our callers have — both SHA-256 digests and random buffers).
 */
function base64UrlEncode(bytes: Uint8Array): string {
  // Build a binary string the size of `bytes`. The `btoa` API is the
  // standard browser path; happy-dom + Node 22 both provide it.
  let str = "";
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Cryptographically-random base64url string of `byteLen` raw bytes.
 * Output length is `ceil(byteLen * 4 / 3)` chars (minus padding).
 *
 * Caller picks the byte length; we don't pick a default because the
 * two callers want different lengths (verifier=64, state=32).
 */
function randomBase64Url(byteLen: number): string {
  const buf = new Uint8Array(byteLen);
  crypto.getRandomValues(buf);
  return base64UrlEncode(buf);
}

/**
 * Generate a PKCE code verifier — 64 random bytes, base64url-encoded
 * (~86 chars). RFC 7636 allows 43..128; 86 is comfortably mid-range and
 * gives 512 bits of entropy.
 */
export function generateVerifier(): string {
  return randomBase64Url(64);
}

/**
 * Generate an OAuth `state` parameter — 32 random bytes, base64url-encoded
 * (~43 chars). Used purely for CSRF protection on the redirect round-trip:
 * `redirectToLogin` stores this in sessionStorage, `handleCallback`
 * compares it against the value the IdP echoes back.
 */
export function generateState(): string {
  return randomBase64Url(32);
}

/**
 * Compute the PKCE code challenge for a given verifier: base64url-encode
 * the SHA-256 digest of the verifier's UTF-8 bytes.
 *
 * Uses Web Crypto's `crypto.subtle.digest`, which is the standard browser
 * API. happy-dom (v20+) provides this; Node 22's `globalThis.crypto`
 * does too, so the package is also usable in non-browser test harnesses
 * if needed.
 */
export async function pkceChallenge(verifier: string): Promise<string> {
  const enc = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", enc);
  return base64UrlEncode(new Uint8Array(digest));
}
