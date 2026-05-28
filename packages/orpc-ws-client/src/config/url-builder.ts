// WebSocket URL builder factory.
//
// Phase 1.7 lift from `apps/web/src/lib/websocket/config/url-builder.ts`.
//
// Differences from the source (consumer-aware corrections):
//   1. The source had a hard-coded import of `getWsUrl()` — a consumer-app
//      function. Lifted to a factory: `createUrlBuilder(baseUrl)` returns
//      the builder closure. The library accepts either a static URL string
//      OR a thunk `() => string` for dynamic resolution (consumer-side
//      env / config / multi-region selection). Design-doc §4 pins the
//      `url: string | (() => string)` shape on `OrpcWsClientOptions`.
//   2. The source unconditionally constructed `new URL(...)` and only
//      appended the `token` param when truthy. Result: a `null` token
//      yielded the base URL unchanged — fine. But an *empty-string* token
//      went through `url.searchParams.set("token", "")`, leaving a stray
//      `?token=` on the URL — wrong for cookie-auth-via-empty-fallback.
//      The library version treats both `null` AND `""` as "no token" and
//      returns the base URL untouched. CLAUDE.md §"Auth flow contract"
//      pins this: omitting tokenProvider → URL must carry no `?token=`.
//   3. No URL parsing for the no-token path. `new URL(baseUrl).toString()`
//      can subtly normalize the input (trailing slash, query reordering);
//      cookie-auth consumers may have constructed their URL with care and
//      we should not rewrite it. Only when we actually need to append a
//      param do we parse + serialize.

/**
 * Build a URL builder closure from the consumer-supplied base URL.
 *
 * @param baseUrl  Either a literal WS URL (`wss://api.example.com/ws`) OR
 *   a thunk that returns one. The thunk form supports dynamic resolution
 *   (multi-region selection, env switching at runtime, etc.) without
 *   requiring the consumer to re-create the whole client.
 *
 * @returns A closure that, given the current token, returns the full WS
 *   URL with `?token=<encoded>` appended — UNLESS the token is null or
 *   empty, in which case the base URL is returned unchanged (cookie-auth-
 *   ready path).
 */
export function createUrlBuilder(
  baseUrl: string | (() => string),
): (token: string | null) => string {
  // Capture the resolver once. If `baseUrl` is a function, we call it on
  // EVERY URL build — preserves the "dynamic URL per reconnect" contract
  // (same shape as the dynamic-token Bug-1 fix in TokenRefreshHandler:
  // partysocket re-invokes the URL provider on every retry, so the thunk
  // here re-runs naturally as well).
  const resolveBase = typeof baseUrl === "function" ? baseUrl : () => baseUrl;

  return (token: string | null): string => {
    const base = resolveBase();
    // Empty-string token is treated as "no token". `new URL(base)`
    // already normalizes — if we appended `?token=` we'd materialize a
    // stray empty query param. CLAUDE.md cookie-auth contract.
    if (token === null || token === "") {
      return base;
    }
    const url = new URL(base);
    url.searchParams.set("token", token);
    return url.toString();
  };
}
