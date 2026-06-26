// Composition root (§D.4/D.6) — the ONLY place the wires meet.
//
// `createCookieBffCore` resolves the public `CookieBffOptions` (applying every
// default), builds the collaborators (cipher, discovery, code-exchange, the
// shared handler context), and returns the four transport-agnostic `/auth/*`
// handlers as a `CookieBffCore`. An adapter (Nest/Fastify/Express) translates
// each handler's `AuthInstruction` to its HTTP framework.
//
// The verifier (`createCookieVerifyClient`) and `revokeUser` are exported
// separately from the package root — they need only the store + config, not
// this whole core — so an adapter can wire them independently.

import { type Clock, type Logger, noopLogger, systemClock } from "@orpc-ws/shared";

import { createTokenCipher } from "../crypto/token-cipher.js";
import { OidcDiscovery } from "../oidc/discovery.js";
import { OidcCodeExchange } from "../oidc/code-exchange.js";
import { InMemoryPkceStore } from "../oidc/pkce-store.js";
import { handleLogin } from "../handlers/login.js";
import { handleCallback } from "../handlers/callback.js";
import { handleMe } from "../handlers/me.js";
import { handleLogout } from "../handlers/logout.js";
import type { HandlerContext } from "../handlers/context.js";
import type { AuthInstruction, AuthRequest } from "../handlers/instruction.js";
import type { CookieBffOptions } from "./options.js";

const DEFAULT_SESSION_TTL_S = 60 * 60 * 24 * 30; // 30 days (Decision #11/#12)
const DEFAULT_SESSION_COOKIE = "__Host-sid";

/** The four transport-agnostic `/auth/*` handlers (§D.4). */
export interface CookieBffCore {
  login(req: AuthRequest): Promise<AuthInstruction>;
  callback(req: AuthRequest): Promise<AuthInstruction>;
  me(req: AuthRequest): Promise<AuthInstruction>;
  logout(req: AuthRequest): Promise<AuthInstruction>;
}

/**
 * Build the cookie-BFF core from the consumer's options. Applies all §D.7
 * defaults (cookie name `__Host-sid`, SameSite=Strict, Secure, hostPrefix,
 * 30-day session window, `fetch`/`systemClock`/`noopLogger`).
 */
export function createCookieBffCore<TUser>(
  opts: CookieBffOptions<TUser>,
): CookieBffCore {
  const clock: Clock = opts.clock ?? systemClock;
  const logger: Logger = opts.logger ?? noopLogger;
  const fetcher = opts.fetcher ?? globalFetch;

  const sessionTtlSeconds = opts.sessionTtlSeconds ?? DEFAULT_SESSION_TTL_S;

  const cipher = createTokenCipher({
    key: opts.encryptionKey,
    ...(opts.encryptionKeyId ? { keyId: opts.encryptionKeyId } : {}),
    ...(opts.previousEncryptionKeys
      ? { previousKeys: opts.previousEncryptionKeys }
      : {}),
  });

  const pkceStore = opts.pkceStore ?? new InMemoryPkceStore(clock);
  const discoveryUrl = opts.keycloak.discoveryUrl ?? opts.keycloak.issuerUrl;

  // Split-horizon: when a distinct internal `discoveryUrl` is configured, the
  // discovery client rewrites the public-host `token_endpoint` (a server
  // back-channel call) to the internal host so the code-exchange/refresh POSTs
  // are reachable from inside the server. Browser-facing endpoints stay public.
  // No-op for single-URL deployments. Mirrors the jwks_uri rewrite in
  // `@orpc-ws/oidc-verifier-jose`.
  const discovery = new OidcDiscovery(fetcher, {
    issuerUrl: opts.keycloak.issuerUrl,
    discoveryUrl,
  });

  const exchange = new OidcCodeExchange(
    {
      issuerUrl: opts.keycloak.issuerUrl,
      ...(opts.keycloak.discoveryUrl
        ? { discoveryUrl: opts.keycloak.discoveryUrl }
        : {}),
      clientId: opts.keycloak.clientId,
      ...(opts.keycloak.clientSecret
        ? { clientSecret: opts.keycloak.clientSecret }
        : {}),
      redirectUri: opts.keycloak.redirectUri,
      ...(opts.keycloak.scope ? { scope: opts.keycloak.scope } : {}),
      ...(opts.keycloak.authorizeParams
        ? { authorizeParams: opts.keycloak.authorizeParams }
        : {}),
    },
    { discovery, pkceStore, clock },
  );

  const sameSite = opts.cookies?.sameSite ?? "strict";
  const secure = opts.cookies?.secure ?? true;

  const context: HandlerContext<TUser> = {
    store: opts.sessionStore,
    cipher,
    exchange,
    discovery,
    resolveUser: opts.resolveUser,
    // Always an object so handlers call `ctx.authEvents.onX?.()` without a
    // null-check; the hooks themselves stay optional.
    authEvents: opts.authEvents ?? {},
    cookies: {
      sessionCookieName: opts.cookies?.sessionCookieName ?? DEFAULT_SESSION_COOKIE,
      sameSite,
      secure,
      hostPrefix: opts.cookies?.hostPrefix ?? true,
      cookieMaxAge: opts.cookies?.cookieMaxAge ?? sessionTtlSeconds,
    },
    stateCookie: { sameSite, secure },
    sessionTtlSeconds,
    slideSessionOnActivity: opts.slideSessionOnActivity ?? true,
    spaRedirectUri: opts.spaRedirectUri,
    postLogoutRedirectUri:
      opts.keycloak.postLogoutRedirectUri ?? opts.spaRedirectUri,
    discoveryUrl,
    clock,
    logger,
  };

  return {
    login: () => handleLogin(context),
    callback: (req) => handleCallback(context, req),
    me: (req) => handleMe(context, req),
    logout: (req) => handleLogout(context, req),
  };
}

/**
 * The global `fetch` adapted to the `Fetcher` seam. `fetch` has been a Node
 * built-in since Node 18 (this package's engine is Node ≥20.19), so it's
 * always present; we narrow it to the seam shape the package uses.
 */
const globalFetch = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => fetch(input, init);
