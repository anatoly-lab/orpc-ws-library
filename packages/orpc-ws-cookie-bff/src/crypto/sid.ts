// Session-id minting.
//
// The `sid` is the ONLY thing the browser holds (in an httpOnly cookie it
// can't read). It must be:
//   - OPAQUE — it carries no information; it is purely a lookup key into the
//     server-side store. Everything valuable (tokens, identity) stays in the
//     drawer. A leaked sid only grants access until the session is revoked or
//     expires; it reveals nothing about the user.
//   - UNGUESSABLE — 256 bits of CSPRNG entropy. An attacker cannot enumerate
//     or predict a live sid, so the cookie alone is a sufficient bearer of
//     the session (paired with the httpOnly + Secure + SameSite + Origin
//     hardening that keeps it from leaking).
//
// `randomBytes` is a security primitive (a CSPRNG), NOT the deterministic
// `Rng` test seam CLAUDE.md governs — so using it directly is allowed and
// correct here (the same call the demo's session store made).

import { randomBytes } from "node:crypto";

/** Number of random bytes behind a sid. 32 bytes = 256 bits of entropy. */
const SID_BYTES = 32;

/**
 * Mint a fresh, opaque, 256-bit session id as a 64-char lowercase hex string.
 * The library calls this; the `SessionStore` only ever persists by the
 * returned key (Decision #20).
 */
export function mintSid(): string {
  return randomBytes(SID_BYTES).toString("hex");
}
