// Constant-time string comparison.
//
// Used by every secret-vs-echo check in the package (oauth_state binding,
// double-submit CSRF, and any opaque-token compare) so equality doesn't leak
// the secret byte-by-byte via timing. Lives in its own module rather than
// inside the cipher: it's a comparison primitive, not encryption, and several
// non-crypto callers (cookies/*) read more clearly importing it from here.

import { timingSafeEqual } from "node:crypto";

/**
 * Constant-time equality for two strings. A length mismatch short-circuits to
 * `false` (already a non-match, and avoids `timingSafeEqual`'s throw on
 * unequal-length buffers).
 */
export function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
