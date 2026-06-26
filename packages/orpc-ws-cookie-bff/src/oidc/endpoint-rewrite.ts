// Split-horizon OIDC endpoint rewrite for the SERVER back-channel.
//
// Why this exists: in a split-horizon deployment the public issuer URL the
// browser sees (e.g. `http://localhost:18080`) differs from the internal URL
// the server reaches the IdP on (e.g. `http://keycloak:8080`). Keycloak's
// discovery document advertises EVERY endpoint on the PUBLIC host (it doesn't
// know it's also reachable internally). The cookie-BFF server-side token
// exchange / refresh POST to the advertised `token_endpoint` verbatim — which
// then targets the public host, unreachable from inside the server container
// → `fetch failed` → `/auth/callback` returns `{"error":"fetch failed"}`.
//
// The fix mirrors `rewriteJwksUri` in the sibling `@orpc-ws/oidc-verifier-jose`
// (`packages/oidc-verifier-jose/src/discovery.ts`): swap the public issuer host
// prefix on a back-channel endpoint for the internal discovery host, preserving
// the advertised path/query. cookie-bff does NOT depend on that package, so the
// small helper is reimplemented here with identical semantics.
//
// CRITICAL — only SERVER back-channel endpoints get rewritten:
//   - `token_endpoint`        → REWRITTEN (server POSTs code-exchange + refresh).
//   - `authorization_endpoint`→ NOT rewritten (the BROWSER is redirected here).
//   - `end_session_endpoint`  → NOT rewritten (the SPA navigates here for
//                                RP-initiated logout — cookie-bff returns it as
//                                `endSessionUrl` and the browser goes there).
// Browser-facing endpoints MUST stay on the public host or the user's browser
// can't reach them.

/** Strip a single trailing slash (IdPs are inconsistent about it). */
function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

/**
 * Lower-case ONLY the origin (scheme + host + port) of a URL string, leaving
 * the path + query untouched. Returns `null` for a non-URL string.
 *
 * Why split origin from the rest: per RFC 3986 the scheme and host are
 * case-INsensitive, but the path and query ARE case-sensitive. The WHATWG
 * `URL.origin` is already normalized to lower-case, so we use it as the
 * comparison key for the host half while preserving the path/query of the
 * original string verbatim. (We keep the original string's path rather than
 * `URL.pathname` because the latter percent-encodes / normalizes — we only
 * want a host-case fix, not a full canonicalization that could alter the
 * advertised path or query.)
 */
function originCaseFold(url: string): { origin: string; rest: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  // `parsed.origin` is the lower-cased scheme+host+port. Recover the rest
  // (path/query/fragment) from the ORIGINAL string — the first `/`, `?`, or
  // `#` after `scheme://authority` — so it keeps its exact (case-sensitive)
  // text rather than `URL`'s normalized/percent-encoded form.
  const schemeSep = url.indexOf("://");
  if (schemeSep === -1) return null;
  const authStart = schemeSep + 3;
  let restStart = url.length;
  for (let i = authStart; i < url.length; i++) {
    const c = url[i];
    if (c === "/" || c === "?" || c === "#") {
      restStart = i;
      break;
    }
  }
  return { origin: parsed.origin, rest: url.slice(restStart) };
}

/**
 * Rewrite a single SERVER back-channel endpoint URL so its host prefix points
 * at the internal `discoveryUrl` origin instead of the public `issuerUrl`
 * origin, preserving the path/query of the advertised endpoint.
 *
 * No-op (returns `endpoint` unchanged) when:
 *   - `discoveryUrl` is absent or equals `issuerUrl` (normal single-URL
 *     deployment — back-compat fast path), OR
 *   - the endpoint is not under the public issuer prefix (e.g. a token endpoint
 *     hosted on a different origin entirely — left as advertised).
 *
 * Host matching is case-INsensitive (RFC 3986 §3.2.2 / §6.2.2.1: scheme + host
 * are case-insensitive), while the path remains case-SENSITIVE: the origins are
 * compared via the already-lower-cased WHATWG `URL.origin`, and the path-prefix
 * boundary is then checked exactly. Prefix matching is path-segment-safe: the
 * issuer path must be followed by `/` (or match exactly) so `http://h:80` never
 * claims `http://h:8080/...`. Same semantics as `rewriteJwksUri` in
 * `@orpc-ws/oidc-verifier-jose`.
 */
export function rewriteBackChannelEndpoint(
  endpoint: string,
  issuerUrl: string,
  discoveryUrl: string | undefined,
): string {
  if (!discoveryUrl) return endpoint;
  const publicBase = stripTrailingSlash(issuerUrl);
  const internalBase = stripTrailingSlash(discoveryUrl);
  if (publicBase === internalBase) return endpoint;

  const ep = originCaseFold(endpoint);
  const base = originCaseFold(publicBase);
  // If either side isn't a parseable URL, there's no origin to fold — fall
  // back to the exact-string semantics (a degenerate input stays unchanged).
  if (!ep || !base) {
    return endpoint === publicBase ? internalBase : endpoint;
  }

  // Opaque origins (file:/data:/custom schemes) all report `origin` as the
  // sentinel "null" per WHATWG URL, so two UNRELATED opaque URLs compare equal
  // — never treat that as the same origin (would wrongly rewrite).
  if (ep.origin === "null" || base.origin === "null") return endpoint;

  // Origin (scheme+host+port) compared case-insensitively; path/query stay
  // exact. `base.rest` is the issuer's path prefix to swap off the endpoint.
  if (ep.origin !== base.origin) return endpoint;
  if (ep.rest === base.rest) return internalBase;
  if (ep.rest.startsWith(`${base.rest}/`)) {
    return internalBase + ep.rest.slice(base.rest.length);
  }
  return endpoint;
}
