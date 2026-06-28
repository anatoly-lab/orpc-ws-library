// BUG-21 — oauth_state cookie served with SameSite=Strict breaks any login
// whose redirect chain has a cross-site hop (off-registrable-domain Keycloak or
// a brokered external/social IdP). A Strict cookie is WITHHELD on the top-level
// GET redirect back to /auth/callback, so the cookie is absent and the
// browser-binding check (`oauthStateMatches`) rejects with HTTP 400. The fix:
// the state cookie defaults to SameSite=Lax (sent on top-level GETs, still
// blocks cross-site unsafe methods), DECOUPLED from the session cookie's
// SameSite so flipping `cookies.sameSite` for the `sid` cookie never drags the
// state cookie back to Strict.

import { describe, expect, it } from "vitest";

import { createCookieBffCore } from "../cookie-bff-core.js";
import type { CookieBffOptions } from "../options.js";
import {
  OAUTH_STATE_COOKIE,
  serializeOAuthStateCookie,
} from "../../cookies/oauth-state.js";
import { FakeSessionStore, fakeClock, fakeFetcher } from "../../__tests__/fakes.js";

type User = { id: string; sub: string };
const KEY = Buffer.alloc(32, 3);
const SPA = "https://web.example";

/** Build a core with the test fakes, mirroring handlers.test.ts. */
function build(override: Partial<CookieBffOptions<User>> = {}) {
  return createCookieBffCore<User>({
    keycloak: {
      issuerUrl: "https://idp.example",
      clientId: "demo",
      redirectUri: "https://api.example/auth/callback",
    },
    originAllowlist: [SPA],
    encryptionKey: KEY,
    sessionStore: new FakeSessionStore<User>(),
    spaRedirectUri: SPA,
    resolveUser: async (claims) => ({ id: `db-${claims.sub}`, sub: claims.sub }),
    fetcher: fakeFetcher({}),
    clock: fakeClock(),
    ...override,
  });
}

/** The oauth_state Set-Cookie string emitted by /auth/login. */
async function stateSetCookie(
  core: ReturnType<typeof build>,
): Promise<string> {
  const r = await core.login({});
  const value = r
    .setCookies!.map((c) => c.value)
    .find((c) => c.startsWith(`${OAUTH_STATE_COOKIE}=`));
  expect(value).toBeTruthy();
  return value!;
}

describe("bug-21: oauth_state SameSite default is Lax, decoupled from the session cookie", () => {
  it("defaults the oauth_state cookie to SameSite=Lax even when the session cookie is Strict", async () => {
    // serialize-level: the helper's own default is Lax (no options given).
    expect(serializeOAuthStateCookie("s")).toContain("SameSite=Lax");

    // composition-level (the real resolution path): with NO cookie options the
    // state cookie ships Lax...
    expect(await stateSetCookie(build())).toContain("SameSite=Lax");

    // ...and forcing the SESSION cookie to Strict must NOT pull the state cookie
    // back to Strict — proves the two SameSite knobs are decoupled (the bug).
    const strictSession = build({ cookies: { sameSite: "strict" } });
    expect(await stateSetCookie(strictSession)).toContain("SameSite=Lax");

    // (Lax is what makes the cross-site callback redirect carry the cookie; a
    // Strict cookie here is the defect that yielded "browser binding failed".)
    expect(await stateSetCookie(strictSession)).not.toContain("SameSite=Strict");
  });

  it("honors an explicit stateSameSite override (verified same-site topology)", async () => {
    const core = build({ cookies: { stateSameSite: "strict" } });
    expect(await stateSetCookie(core)).toContain("SameSite=Strict");
  });
});
