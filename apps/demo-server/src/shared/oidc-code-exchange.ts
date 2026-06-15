// Server-side OIDC Authorization-Code + PKCE flow for the backend demos
// (backend-token + cookie-bff). The SERVER is the OAuth client here: it
// builds the authorize URL, holds the PKCE `code_verifier`, exchanges the
// code for tokens, and refreshes them — all WITHOUT a client secret
// (public PKCE client). See the clearly-marked slot below for where a
// confidential client's `client_secret` WOULD go.
//
// PKCE (RFC 7636) is what makes a public client's code exchange safe: the
// verifier never leaves the server, the challenge (S256 hash) rides the
// public redirect, so an intercepted authorization code is useless without
// the verifier. node:crypto gives us everything (random verifier + state,
// SHA-256 challenge); no dep needed.

import { createHash, randomBytes } from "node:crypto";

import type { BackendOidcConfig } from "../config.js";
import { getOidcEndpoints } from "./keycloak-urls.js";

/** Tokens returned by the IdP's token endpoint. */
export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  idToken: string | null;
  /** Access-token lifetime in seconds (from `expires_in`). */
  expiresIn: number;
}

/** Identity claims decoded from the id_token for display only. */
export interface IdentityClaims {
  sub: string;
  email?: string;
  name?: string;
}

/** Raw token-endpoint JSON response (snake_case). */
interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
}

/** A pending login: the state value maps to its PKCE verifier. */
interface PendingAuth {
  codeVerifier: string;
  createdAt: number;
}

// State→verifier store with a short TTL. A login that never completes its
// callback (user closed the tab) leaves a dangling entry; the TTL sweep
// keeps the map from growing unbounded. In-memory + single-process is fine
// for a demo (see session-store.ts for the same caveat).
const PENDING_TTL_MS = 10 * 60 * 1000; // 10 minutes to complete the login.
const pending = new Map<string, PendingAuth>();

function sweepExpired(now: number): void {
  for (const [state, entry] of pending) {
    if (now - entry.createdAt > PENDING_TTL_MS) pending.delete(state);
  }
}

// Fallback access-token lifetime (seconds) when the token endpoint omits or
// returns a non-positive `expires_in`. Defaulting to 0 would make a session
// born already-expired, so cookie-bff/backend-token WS verify rejects every
// connection — a silent auth failure. 5 minutes is a sane conservative floor.
const DEFAULT_EXPIRES_IN_S = 300;

/**
 * The OIDC code-exchange client for one backend mode. Construct once with
 * the issuer + client config; reuse across requests.
 */
export class OidcCodeExchange {
  constructor(
    private readonly issuerUrl: string,
    private readonly client: BackendOidcConfig,
  ) {}

  /**
   * Build the authorize-redirect URL for a fresh login. Generates a random
   * `state` + PKCE `code_verifier`, derives the S256 `code_challenge`, and
   * stashes state→verifier for the matching `exchangeCode` call.
   *
   * `redirectUri` MUST be the THIS-server callback the IdP redirects back
   * to (and must be registered in the IdP), e.g.
   * `http://localhost:18082/auth/callback`.
   */
  async createAuthorizationUrl(
    redirectUri: string,
  ): Promise<{ url: string; state: string }> {
    const { authorizationEndpoint } = await getOidcEndpoints(this.issuerUrl);

    // base64url (no padding) is the PKCE + token grammar.
    const state = randomBytes(32).toString("base64url");
    const codeVerifier = randomBytes(32).toString("base64url");
    const codeChallenge = createHash("sha256")
      .update(codeVerifier)
      .digest()
      .toString("base64url");

    sweepExpired(Date.now());
    pending.set(state, { codeVerifier, createdAt: Date.now() });

    const url = new URL(authorizationEndpoint);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.client.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("scope", "openid profile email");
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");

    return { url: url.toString(), state };
  }

  /**
   * Exchange an authorization `code` for tokens. Consumes the pending
   * `state` entry (single-use — a replayed callback finds no verifier and
   * is rejected). `redirectUri` must match the one used at authorize time.
   */
  async exchangeCode(
    code: string,
    state: string,
    redirectUri: string,
  ): Promise<TokenSet> {
    const entry = pending.get(state);
    if (!entry) {
      throw new Error(
        "[oidc-code-exchange] unknown or expired state (no pending verifier)",
      );
    }
    pending.delete(state);

    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: this.client.clientId,
      code_verifier: entry.codeVerifier,
    });
    // CONFIDENTIAL-CLIENT SLOT: the demo runs a PUBLIC PKCE client, so no
    // secret is sent — `code_verifier` above is the proof-of-possession. If
    // you register a confidential client and set `OIDC_BACKEND_CLIENT_SECRET`
    // (-> config.backendOidc.clientSecret), forward it here:
    if (this.client.clientSecret) {
      body.set("client_secret", this.client.clientSecret);
    }

    return this.postToken(body);
  }

  /**
   * Refresh tokens using a stored `refresh_token`. Used by backend-token's
   * `/auth/refresh` to mint a new short-lived access token without a fresh
   * login. The IdP may rotate the refresh token (returns a new one).
   */
  async refreshTokens(refreshToken: string): Promise<TokenSet> {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: this.client.clientId,
    });
    // Same confidential-client slot as exchangeCode.
    if (this.client.clientSecret) {
      body.set("client_secret", this.client.clientSecret);
    }
    return this.postToken(body);
  }

  private async postToken(body: URLSearchParams): Promise<TokenSet> {
    const { tokenEndpoint } = await getOidcEndpoints(this.issuerUrl);
    const res = await fetch(tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `[oidc-code-exchange] token endpoint failed: ${res.status} ${res.statusText} ${text}`,
      );
    }
    const json = (await res.json()) as TokenResponse;
    // Guard `expires_in`: a missing/non-positive value would otherwise yield a
    // session born already-expired (WS verify then rejects every connection).
    // This covers BOTH the code-exchange and refresh paths (both call here).
    const expiresIn =
      typeof json.expires_in === "number" &&
      Number.isFinite(json.expires_in) &&
      json.expires_in > 0
        ? json.expires_in
        : DEFAULT_EXPIRES_IN_S;
    return {
      accessToken: json.access_token,
      refreshToken: json.refresh_token ?? null,
      idToken: json.id_token ?? null,
      expiresIn,
    };
  }
}

/**
 * Decode identity claims (sub/email/name) from an id_token for DISPLAY
 * ONLY — the signature is NOT verified here.
 *
 * Why unverified is acceptable: the id_token arrived over a direct,
 * server-to-server TLS POST to the IdP's token endpoint (in `exchangeCode`),
 * not from an untrusted client — so its provenance is already trusted at
 * this point. We decode it purely to show the user's name/email in the
 * demo UI. (The WS access token, by contrast, IS cryptographically verified
 * by `@orpc-ws/oidc-verifier-jose` on the connection path — that's the
 * security boundary.) We hand-decode the base64url JWT payload rather than
 * adding a `jose` dependency to the demo-server for a display-only concern.
 */
export function decodeIdTokenClaims(idToken: string | null): IdentityClaims {
  if (!idToken) return { sub: "" };
  const parts = idToken.split(".");
  const payloadB64 = parts[1];
  if (!payloadB64) return { sub: "" };
  try {
    const payloadJson = Buffer.from(payloadB64, "base64url").toString("utf8");
    const claims = JSON.parse(payloadJson) as Record<string, unknown>;
    const out: IdentityClaims = {
      sub: typeof claims.sub === "string" ? claims.sub : "",
    };
    if (typeof claims.email === "string") out.email = claims.email;
    if (typeof claims.name === "string") {
      out.name = claims.name;
    } else if (typeof claims.preferred_username === "string") {
      out.name = claims.preferred_username;
    }
    return out;
  } catch {
    return { sub: "" };
  }
}
