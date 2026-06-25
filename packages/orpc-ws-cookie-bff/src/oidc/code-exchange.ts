// Server-side Authorization-Code + PKCE flow (the server IS the OAuth client).
//
// Grown from the demo's `oidc-code-exchange.ts`, hardened for the library:
//   - the state->verifier store is the INJECTED `PkceStore` seam (was a
//     module-level Map — see pkce-store.ts for the multi-instance rationale);
//   - `fetch` and the `Clock` are injected seams (testable, no raw globals);
//   - `redirectUri` is taken from config per call (trusted), never derived
//     from a request Host header (the demo's documented DEMO-ONLY shortcut).
//
// PKCE (RFC 7636): the verifier never leaves the server, only the S256
// challenge rides the public redirect, so an intercepted code is useless
// without the verifier. node:crypto covers it (random verifier+state, SHA-256
// challenge); no dep. `randomBytes`/`createHash` are crypto primitives, not
// the deterministic `Rng` test seam, so they're used directly.

import { createHash, randomBytes } from "node:crypto";

import { type Clock, systemClock } from "@orpc-ws/shared";

import type { OidcDiscovery } from "./discovery.js";
import type { PkceStore } from "./pkce-store.js";

/** Tokens from the IdP token endpoint, plus the access-token lifetime. */
export interface OidcTokenSet {
  accessToken: string;
  refreshToken: string | null;
  idToken: string | null;
  /** Access-token lifetime in seconds (from `expires_in`). */
  expiresIn: number;
}

/** Raw token-endpoint JSON (snake_case). */
interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
}

/** IdP / client identity the code-exchange needs. */
export interface CodeExchangeConfig {
  /** Public issuer (matches token `iss`). */
  issuerUrl: string;
  /** Internal discovery/JWKS base; defaults to `issuerUrl`. */
  discoveryUrl?: string;
  clientId: string;
  /** Present ⇒ confidential client (secret sent on token calls). */
  clientSecret?: string;
  /** Trusted absolute callback URI (NOT Host-derived). */
  redirectUri: string;
  /** OAuth scope; defaults to "openid profile email" (NOT offline_access). */
  scope?: string;
  /**
   * Extra authorize-URL query params (`prompt`, `login_hint`, `max_age`, …).
   * Applied FIRST; the 7 security-critical params are set AFTER and win, so
   * these can NEVER clobber `response_type`/`client_id`/`redirect_uri`/`scope`/
   * `state`/`code_challenge`/`code_challenge_method` (§F3).
   */
  authorizeParams?: Record<string, string>;
}

/** Collaborators (all injectable) for {@link OidcCodeExchange}. */
export interface CodeExchangeDeps {
  discovery: OidcDiscovery;
  pkceStore: PkceStore;
  /** TTL for a pending login's verifier, seconds. Defaults to 600 (10 min). */
  pendingTtlSeconds?: number;
  clock?: Clock;
}

/**
 * Fallback access-token lifetime (seconds) when the token endpoint omits or
 * returns a non-positive `expires_in`. Defaulting to 0 would make a session
 * born already-expired. 5 minutes is a conservative floor.
 */
const DEFAULT_EXPIRES_IN_S = 300;
const DEFAULT_PENDING_TTL_S = 600;
const DEFAULT_SCOPE = "openid profile email";

/**
 * The server-side code-exchange client. Construct once with config + injected
 * collaborators; reuse across requests.
 */
export class OidcCodeExchange {
  private readonly discoveryUrl: string;
  private readonly scope: string;
  private readonly pendingTtlSeconds: number;
  private readonly clock: Clock;

  constructor(
    private readonly config: CodeExchangeConfig,
    private readonly deps: CodeExchangeDeps,
  ) {
    this.discoveryUrl = config.discoveryUrl ?? config.issuerUrl;
    this.scope = config.scope ?? DEFAULT_SCOPE;
    this.pendingTtlSeconds = deps.pendingTtlSeconds ?? DEFAULT_PENDING_TTL_S;
    this.clock = deps.clock ?? systemClock;
  }

  /**
   * Build the authorize-redirect URL for a fresh login: random `state` + PKCE
   * `code_verifier`, S256 `code_challenge`, verifier stashed in the
   * `PkceStore` keyed by `state` for the matching `exchangeCode`.
   */
  async createAuthorizationUrl(): Promise<{ url: string; state: string }> {
    const { authorizationEndpoint } = await this.deps.discovery.getEndpoints(
      this.discoveryUrl,
    );

    const state = randomBytes(32).toString("base64url");
    const codeVerifier = randomBytes(32).toString("base64url");
    const codeChallenge = createHash("sha256")
      .update(codeVerifier)
      .digest()
      .toString("base64url");

    await this.deps.pkceStore.set(state, codeVerifier, {
      ttlSeconds: this.pendingTtlSeconds,
    });

    const url = new URL(authorizationEndpoint);
    // Consumer-supplied params FIRST (e.g. prompt / login_hint / max_age) …
    for (const [k, v] of Object.entries(this.config.authorizeParams ?? {})) {
      url.searchParams.set(k, v);
    }
    // … then the 7 security-critical params, which ALWAYS overwrite — a
    // consumer cannot clobber the PKCE / state / redirect / scope params (§F3).
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.config.clientId);
    url.searchParams.set("redirect_uri", this.config.redirectUri);
    url.searchParams.set("scope", this.scope);
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");

    return { url: url.toString(), state };
  }

  /**
   * Exchange an authorization `code` for tokens. Consumes the pending `state`
   * verifier (single-use — a replayed callback finds none and throws).
   */
  async exchangeCode(code: string, state: string): Promise<OidcTokenSet> {
    const codeVerifier = await this.deps.pkceStore.take(state);
    if (!codeVerifier) {
      throw new Error(
        "[cookie-bff] unknown or expired state (no pending PKCE verifier)",
      );
    }

    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: this.config.redirectUri,
      client_id: this.config.clientId,
      code_verifier: codeVerifier,
    });
    if (this.config.clientSecret) {
      body.set("client_secret", this.config.clientSecret);
    }
    return this.postToken(body);
  }

  /**
   * Refresh tokens using a stored `refresh_token`. The IdP may rotate the
   * refresh token (returns a new one) — the caller must persist whatever
   * comes back. Throws on a non-OK response (see refresh.ts for terminal vs
   * transient classification).
   */
  async refreshTokens(refreshToken: string): Promise<OidcTokenSet> {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: this.config.clientId,
    });
    if (this.config.clientSecret) {
      body.set("client_secret", this.config.clientSecret);
    }
    return this.postToken(body);
  }

  /** Access-token expiry as epoch ms, computed off the injected clock. */
  expiresAtFrom(tokens: OidcTokenSet): number {
    return this.clock.now() + tokens.expiresIn * 1000;
  }

  private async postToken(body: URLSearchParams): Promise<OidcTokenSet> {
    const { tokenEndpoint } = await this.deps.discovery.getEndpoints(
      this.discoveryUrl,
    );
    const res = await this.deps.discovery.getFetcher()(tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new TokenEndpointError(res.status, res.statusText, text);
    }
    const json = (await res.json()) as TokenResponse;
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
 * Error from a non-OK token-endpoint response. Carries the HTTP `status` so
 * refresh.ts can classify terminal (4xx — the grant is dead) vs transient
 * (5xx / network) failures.
 */
export class TokenEndpointError extends Error {
  constructor(
    readonly status: number,
    statusText: string,
    body: string,
  ) {
    super(`[cookie-bff] token endpoint failed: ${status} ${statusText} ${body}`);
    this.name = "TokenEndpointError";
  }
}
