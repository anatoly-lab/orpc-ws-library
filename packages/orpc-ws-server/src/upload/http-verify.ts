// Bearer token extraction for the HTTP upload transport.
//
// HTTP-side analog of `extractToken()` in `lifecycle/verify-client-orchestrator.ts`.
// The WS verifier reads `?token=` from the URL; the HTTP verifier reads
// `Authorization: Bearer <token>`. Same auth principal, two transports —
// CLAUDE.md "Token transport" pins this split.
//
// The extraction is deliberately strict: only `Bearer <token>` (case-
// insensitive scheme, exactly one space separator). Lenient parsing here
// would let malformed headers through to the consumer's verifyClient,
// which already has enough to do.

import type { IncomingMessage } from "http";

/**
 * Pull the bearer token out of `Authorization: Bearer <token>`.
 *
 * Returns `null` when:
 *   - The Authorization header is absent.
 *   - The scheme is not `Bearer` (case-insensitive).
 *   - The header has no token after the scheme.
 *
 * The empty string is treated as "missing" too — a literal
 * `Authorization: Bearer ` (trailing space, no token) returns `null`.
 * Consumer's verifyClient sees `token: null` either way; the distinction
 * between "no header" and "empty token" is not load-bearing for auth.
 */
export function extractBearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== "string" || header.length === 0) {
    return null;
  }
  // `^Bearer\s+(.+)$` — case-insensitive scheme, at least one space,
  // captures the rest. Trim trailing whitespace defensively (some
  // proxies leave a `\r` at the end of header values).
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return null;
  const token = match[1]?.trim();
  return token && token.length > 0 ? token : null;
}
