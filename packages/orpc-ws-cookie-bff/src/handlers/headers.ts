// Case-insensitive header lookup.
//
// HTTP header names are case-insensitive (RFC 9110 §5.1), and an adapter may
// hand the core a headers map keyed however its framework normalized it
// (Node lower-cases, but a hand-built map or another framework may not). The
// handlers therefore never index a header map directly — they scan for a
// case-insensitive name match so the CSRF echo (`x-csrf-token`) is found
// regardless of the adapter's casing.

/**
 * Find a header value by case-insensitive name. Returns `undefined` when the
 * map is absent or no key matches.
 */
export function getHeader(
  headers: Record<string, string | undefined> | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  const target = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === target) return headers[key];
  }
  return undefined;
}
