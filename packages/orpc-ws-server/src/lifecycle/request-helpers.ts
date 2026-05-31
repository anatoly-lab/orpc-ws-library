// Tiny request-introspection helpers shared by `connection-handler.ts`
// and `verify-client-orchestrator.ts`. Factored out so both files use
// the same implementation — drift between them would mean the verify-
// time "rejected" log and the connect-time "client connected" log
// surface inconsistent `clientIp` / `token` values for the same request.
//
// Stateless, no dependencies — leaf module. Both call sites import
// these instead of mirroring the implementation inline.

import type { IncomingMessage } from "http";

/**
 * Source IP for a WS upgrade request. Prefers `x-forwarded-for` (first
 * hop) for proxy / LB deployments; falls back to the socket's remote
 * address. Defensive split on the header — some proxies pass a
 * comma-separated list with leading whitespace.
 */
export function extractClientIp(req: IncomingMessage): string | undefined {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length > 0) {
    const first = fwd.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress;
}

/**
 * Pulls `?token=...` from the upgrade request URL. Defensive against
 * partial URLs (we synthesize the base from the Host header; in test
 * harnesses with no host, falls back to `localhost`). Returns `null`
 * when missing or unparseable.
 */
export function extractToken(req: IncomingMessage): string | null {
  if (!req.url) return null;
  const host = req.headers.host ?? "localhost";
  try {
    const url = new URL(req.url, `http://${host}`);
    return url.searchParams.get("token");
  } catch {
    return null;
  }
}
