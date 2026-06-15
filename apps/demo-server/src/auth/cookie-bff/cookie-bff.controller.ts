// cookie-bff HTTP auth controller. The server is the OAuth client: it runs
// the full Authorization-Code + PKCE flow, holds ALL tokens server-side,
// and hands the browser nothing but an httpOnly session cookie.
//
// Flow:
//   GET  /auth/login    -> 302 to the IdP authorize endpoint (redirect_uri
//                          = THIS server's /auth/callback).
//   GET  /auth/callback -> exchange code -> create session -> Set-Cookie sid
//                          -> 302 back to the SPA origin.
//   GET  /auth/me       -> cookie-authed identity ({ sub, email, name }).
//   POST /auth/logout   -> destroy session + clear cookie, return the IdP's
//                          end-session URL for the SPA to optionally visit.
//
// We use express Request/Response (via @Req/@Res) for cookie reads, header
// writes, and redirects — Nest's higher-level abstractions don't cover
// Set-Cookie + 302 ergonomically here.

import { Controller, Get, Inject, Post, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";

import { APP_ENV_CONFIG, type AppEnvConfig } from "../../config.js";
import { clearCookie, parseCookie, serializeCookie } from "../../shared/cookies.js";
import {
  clearStateCookieHeader,
  stateCookieHeader,
  stateCookieMatches,
} from "../../shared/oauth-state-cookie.js";
import { decodeIdTokenClaims } from "../../shared/oidc-code-exchange.js";
import { getOidcEndpoints } from "../../shared/keycloak-urls.js";
// `OidcCodeExchange` + `SessionStore` are used ONLY in constructor-param
// type position, but they must be VALUE imports: with `emitDecoratorMetadata`
// Nest reads `design:paramtypes` at runtime to resolve DI, and a `type`
// import would be elided (verbatimModuleSyntax) → metadata becomes `Object`
// → DI fails. So `consistent-type-imports` is disabled for these two lines.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { OidcCodeExchange } from "../../shared/oidc-code-exchange.js";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { SessionStore } from "../../shared/session-store.js";

@Controller("auth")
export class CookieBffController {
  // Collaborators are constructor-injected by the module's providers so the
  // controller stays a thin HTTP shell over the shared building blocks.
  // `AppEnvConfig` is an interface (no runtime token) so it's injected via
  // the `APP_ENV_CONFIG` string token; the two classes inject by type.
  constructor(
    @Inject(APP_ENV_CONFIG) private readonly config: AppEnvConfig,
    private readonly exchange: OidcCodeExchange,
    private readonly store: SessionStore,
  ) {}

  /** This server's callback URL, derived from the inbound request host. */
  private callbackUri(req: Request): string {
    // `req.protocol` + Host gives the externally-visible base; for the
    // local demo this is http://localhost:18083. Must match the redirect
    // URI registered in the IdP.
    //
    // DEMO-ONLY: deriving the base URL from the request `Host` header is
    // safe here ONLY because the IdP enforces a registered redirect-URI
    // allowlist — a spoofed Host produces a `redirect_uri` Keycloak rejects,
    // breaking the exchange rather than enabling an open redirect. A
    // production server should derive its public base URL from config
    // (a trusted, fixed value), not from the inbound request.
    return `${req.protocol}://${req.get("host")}/auth/callback`;
  }

  @Get("login")
  async login(@Req() req: Request, @Res() res: Response): Promise<void> {
    const { url, state } = await this.exchange.createAuthorizationUrl(
      this.callbackUri(req),
    );
    // Bind this login to THIS browser: stash `state` in a short-lived
    // httpOnly cookie the callback must echo back (login-CSRF fix). `append`
    // (not `setHeader`) so we never clobber any other Set-Cookie.
    res.append("Set-Cookie", stateCookieHeader(state));
    res.redirect(302, url);
  }

  @Get("callback")
  async callback(@Req() req: Request, @Res() res: Response): Promise<void> {
    const code = typeof req.query.code === "string" ? req.query.code : null;
    const state = typeof req.query.state === "string" ? req.query.state : null;
    if (!code || !state) {
      res.status(400).send("Missing code/state");
      return;
    }

    // Browser-binding check: the callback must carry the `oauth_state` cookie
    // set at /auth/login, matching the query `state`. A forged/cross-browser
    // callback has no matching cookie -> reject before token exchange. Clear
    // the cookie regardless of outcome (single-use). Defense in depth on top
    // of the server-side `state -> verifier` check inside exchangeCode.
    res.append("Set-Cookie", clearStateCookieHeader());
    if (!stateCookieMatches(req.headers.cookie, state)) {
      res.status(400).send("Invalid OAuth state (browser binding failed)");
      return;
    }

    const tokens = await this.exchange.exchangeCode(
      code,
      state,
      this.callbackUri(req),
    );
    const claims = decodeIdTokenClaims(tokens.idToken);

    const sid = this.store.create({
      sub: claims.sub,
      ...(claims.email ? { email: claims.email } : {}),
      ...(claims.name ? { name: claims.name } : {}),
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      idToken: tokens.idToken,
      expiresAt: Date.now() + tokens.expiresIn * 1000,
    });

    // `append` (not `setHeader`) so the sid cookie joins the state-cookie
    // clear emitted above rather than overwriting it.
    res.append(
      "Set-Cookie",
      serializeCookie(this.config.sessionCookieName, sid, { httpOnly: true }),
    );
    // Back to the SPA — it'll now have the httpOnly cookie and can open the
    // WS (verify reads the cookie) without ever seeing a token.
    res.redirect(302, this.config.spaOrigins.cookieBff.redirectOrigin);
  }

  @Get("me")
  me(@Req() req: Request, @Res() res: Response): void {
    const session = this.currentSession(req);
    if (!session) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }
    res.json({
      sub: session.sub,
      email: session.email,
      name: session.name,
    });
  }

  @Post("logout")
  async logout(@Req() req: Request, @Res() res: Response): Promise<void> {
    const sid = parseCookie(req.headers.cookie, this.config.sessionCookieName);
    const session = sid ? this.store.get(sid) : null;
    if (sid) this.store.destroy(sid);

    // Clear the cookie regardless (idempotent logout).
    res.setHeader(
      "Set-Cookie",
      clearCookie(this.config.sessionCookieName, { httpOnly: true }),
    );

    // Best-effort RP-initiated logout URL for the SPA to optionally visit
    // (clears the IdP's SSO session too). Omitted if the IdP doesn't
    // advertise an end_session_endpoint or discovery is unreachable.
    let endSessionUrl: string | null = null;
    try {
      const endpoints = await getOidcEndpoints(this.config.oidc.issuerUrl);
      if (endpoints.endSessionEndpoint) {
        const url = new URL(endpoints.endSessionEndpoint);
        if (session?.idToken) {
          url.searchParams.set("id_token_hint", session.idToken);
        }
        url.searchParams.set(
          "post_logout_redirect_uri",
          this.config.spaOrigins.cookieBff.redirectOrigin,
        );
        endSessionUrl = url.toString();
      }
    } catch {
      endSessionUrl = null;
    }

    res.json({ ok: true, endSessionUrl });
  }

  /** Resolve the session for the current request's cookie, or null. */
  private currentSession(req: Request): ReturnType<SessionStore["get"]> {
    const sid = parseCookie(req.headers.cookie, this.config.sessionCookieName);
    if (!sid) return null;
    return this.store.get(sid);
  }
}
