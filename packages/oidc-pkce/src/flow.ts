// Flow orchestration: redirect, callback, logout.
//
// Composes pkce + discovery + tokens. Owns the sessionStorage interaction
// for PKCE state (hard-coded — see `Storage` jsdoc in types.ts and the
// CLAUDE.md design decisions for the rationale).
//
// All three functions now take an already-resolved `OidcMetadata` rather
// than fetching it themselves. The composition root (client.ts) owns
// the discovery-cache memoization; the flow stays a pure orchestrator.

import { generateState, generateVerifier, pkceChallenge } from "./pkce.js";
import { exchangeCodeForTokens, parseIdToken } from "./tokens.js";
import type {
  CallbackResult,
  OidcConfig,
  OidcMetadata,
  Storage,
} from "./types.js";

const PKCE_VERIFIER_KEY = "pkce_verifier";
const PKCE_STATE_KEY = "pkce_state";
const DEFAULT_SCOPES = ["openid", "email", "profile"] as const;

/**
 * Step 1 of the PKCE dance: build a verifier/state pair, stash them in
 * sessionStorage, and redirect the browser to the IdP's authorize endpoint.
 *
 * This function navigates the page (assigns `window.location.href`) and
 * therefore never returns control to the caller in production. In tests,
 * happy-dom's `window.location` assignment is a no-op — tests assert on
 * what got written into sessionStorage and inspect `window.location.href`.
 *
 * No-op for "did the user already have a session?" — the consumer decides
 * when to call this. The flow assumes the caller has already established
 * that the user needs to log in.
 */
export async function redirectToLogin(
  config: OidcConfig,
  metadata: OidcMetadata,
): Promise<void> {
  const verifier = generateVerifier();
  const challenge = await pkceChallenge(verifier);
  const state = generateState();

  // sessionStorage scope: one tab, cleared on tab close. The exact
  // lifetime we want for PKCE state — see types.ts `Storage` jsdoc.
  sessionStorage.setItem(PKCE_VERIFIER_KEY, verifier);
  sessionStorage.setItem(PKCE_STATE_KEY, state);

  const scopes = config.scopes ?? DEFAULT_SCOPES;
  const params = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: scopes.join(" "),
    state,
  });
  window.location.href = `${metadata.authorization_endpoint}?${params.toString()}`;
}

/**
 * Step 2 of the PKCE dance: handle the redirect back from the IdP.
 *
 * Order of checks matters and is deliberately STRICT. We check
 * sessionStorage first so that a stray `/auth/callback?error=foo`
 * navigation (back-button, bookmark, refresh after success) cannot be
 * mistaken for an IdP-reported failure when in fact there's no live
 * PKCE flow. CSRF surface area first; cosmetic error message second.
 *
 * Returns a discriminated union; never throws.
 */
export async function handleCallback(
  searchParams: URLSearchParams,
  config: OidcConfig,
  metadata: OidcMetadata,
  storage: Storage,
): Promise<CallbackResult> {
  // 1+2. Read stored PKCE pair. Missing => no live flow.
  const expectedState = sessionStorage.getItem(PKCE_STATE_KEY);
  const verifier = sessionStorage.getItem(PKCE_VERIFIER_KEY);
  if (!expectedState || !verifier) {
    return { ok: false, error: { type: "state_mismatch" } };
  }

  // 3+4. IdP-reported error overrides everything else from here on.
  const errParam = searchParams.get("error");
  if (errParam) {
    // Clear PKCE state — the flow is finished even though it failed.
    clearPkceState();
    const description = searchParams.get("error_description");
    return {
      ok: false,
      error: {
        type: "idp_error",
        error: errParam,
        ...(description ? { description } : {}),
      },
    };
  }

  // 5. Code missing => malformed callback.
  const code = searchParams.get("code");
  const returnedState = searchParams.get("state");
  if (!code) {
    return { ok: false, error: { type: "missing_code" } };
  }

  // 6. State mismatch => CSRF or stale flow.
  if (returnedState !== expectedState) {
    return { ok: false, error: { type: "state_mismatch" } };
  }

  // 7. Code-exchange. Catch network failure as `exchange_failed/0`.
  let result: Awaited<ReturnType<typeof exchangeCodeForTokens>>;
  try {
    result = await exchangeCodeForTokens({
      metadata,
      clientId: config.clientId,
      redirectUri: config.redirectUri,
      code,
      codeVerifier: verifier,
    });
  } catch (e) {
    return {
      ok: false,
      error: {
        type: "exchange_failed",
        status: 0,
        body: e instanceof Error ? e.message : String(e),
      },
    };
  }

  if (!result.ok) {
    return {
      ok: false,
      error: {
        type: "exchange_failed",
        status: result.status,
        body: result.body,
      },
    };
  }

  // 8. Persist tokens, clear one-shot PKCE state.
  storage.write(result.tokens);
  clearPkceState();

  // 9. Parse id_token for display info. A null user here is recoverable
  // (the token is still valid for API calls) — synthesize a minimal user
  // so the consumer's UI doesn't have to handle "logged in but no user".
  const user = parseIdToken(result.tokens.idToken) ?? { sub: "unknown" };
  return { ok: true, user, tokens: result.tokens };
}

/** Remove the one-shot PKCE state. Idempotent. */
function clearPkceState(): void {
  sessionStorage.removeItem(PKCE_STATE_KEY);
  sessionStorage.removeItem(PKCE_VERIFIER_KEY);
}

/**
 * Log out. Clears local tokens, then redirects the browser to the IdP's
 * end-session endpoint (if exposed) so the IdP SSO cookie gets cleared
 * too. The IdP redirects back to `redirectTo` (defaults to the SPA
 * origin with a trailing slash — most realms whitelist the SPA root as
 * `https://app.example.com/`, not bare-origin without the slash; RFC
 * 6749 mandates exact-string match, so the trailing slash is load-bearing).
 *
 * If the metadata has no `end_session_endpoint` (some IdPs don't expose
 * one), we just clear local tokens and stay on-page. The consumer is
 * expected to handle the navigation themselves in that case.
 *
 * When the end-session endpoint IS configured, this function navigates
 * the page and does not return control in production.
 */
export function logout(
  config: OidcConfig,
  metadata: OidcMetadata,
  storage: Storage,
  opts?: { redirectTo?: string },
): void {
  const idToken = storage.read()?.idToken;
  storage.clear();

  if (!metadata.end_session_endpoint) {
    // No IdP-side end-session endpoint. Local tokens are cleared; the
    // consumer can route to wherever they want.
    return;
  }

  const params = new URLSearchParams({
    client_id: config.clientId,
    post_logout_redirect_uri: opts?.redirectTo ?? `${window.location.origin}/`,
  });
  // `id_token_hint` lets the IdP skip the "are you sure?" confirmation
  // page when ending a session — required behavior for SPAs in many IdPs
  // (Keycloak ≥18, for example).
  if (idToken) params.set("id_token_hint", idToken);
  window.location.href = `${metadata.end_session_endpoint}?${params.toString()}`;
}
