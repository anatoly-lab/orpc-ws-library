// backend-token HTTP auth controller. Hybrid of PKCE and cookie-bff: the
// SERVER runs the OIDC flow and holds the refresh + id tokens server-side
// (like cookie-bff), but hands the SPA a SHORT-LIVED ACCESS TOKEN that the
// SPA forwards over the WS `?token=` (like PKCE). This keeps the long-lived
// refresh token off the browser (XSS can't steal it) while still using the
// library's standard token-over-`?token=` WS verify unchanged.
//
// Flow:
//   GET  /auth/login    -> 302 to IdP authorize (redirect_uri = THIS /auth/callback).
//   GET  /auth/callback -> exchange code -> create session (stores refresh +
//                          id tokens SERVER-SIDE) -> Set-Cookie sid -> 302 to SPA.
//   POST /auth/token    -> (cookie-authed) return { accessToken, expiresIn }
//                          from the session for the SPA to open the WS with.
//   POST /auth/refresh  -> (cookie-authed) use the stored refresh_token to
//                          mint a new access token; update session; return it.
//   POST /auth/logout   -> destroy session + clear cookie, return endSessionUrl.

import { Controller, Get, Inject, Post, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";

import { APP_ENV_CONFIG, type AppEnvConfig } from "../config.js";
import { clearCookie, parseCookie, serializeCookie } from "../shared/cookies.js";
import {
  clearStateCookieHeader,
  stateCookieHeader,
  stateCookieMatches,
} from "../shared/oauth-state-cookie.js";
import { decodeIdTokenClaims } from "../shared/oidc-code-exchange.js";
import { getOidcEndpoints } from "../shared/keycloak-urls.js";
// `OidcCodeExchange` + `SessionStore` are used ONLY in constructor-param
// type position, but they must be VALUE imports: with `emitDecoratorMetadata`
// Nest reads `design:paramtypes` at runtime to resolve DI, and a `type`
// import would be elided (verbatimModuleSyntax) → metadata becomes `Object`
// → DI fails. So `consistent-type-imports` is disabled for these two lines.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { OidcCodeExchange } from "../shared/oidc-code-exchange.js";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { SessionStore } from "../shared/session-store.js";

@Controller("auth")
export class BackendTokenController {
  constructor(
    @Inject(APP_ENV_CONFIG) private readonly config: AppEnvConfig,
    private readonly exchange: OidcCodeExchange,
    private readonly store: SessionStore,
  ) {}

  private callbackUri(req: Request): string {
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

    // Store the LONG-LIVED tokens server-side; the SPA only ever gets the
    // short-lived access token (via /auth/token), never the refresh token.
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
    res.redirect(302, this.config.spaOrigins.redirectOrigin);
  }

  @Post("token")
  token(@Req() req: Request, @Res() res: Response): void {
    const entry = this.currentSession(req);
    if (!entry) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }
    const expiresIn = Math.max(
      0,
      Math.floor((entry.session.expiresAt - Date.now()) / 1000),
    );
    res.json({ accessToken: entry.session.accessToken, expiresIn });
  }

  @Post("refresh")
  async refresh(@Req() req: Request, @Res() res: Response): Promise<void> {
    const entry = this.currentSession(req);
    if (!entry) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }
    if (!entry.session.refreshToken) {
      res.status(401).json({ error: "No refresh token" });
      return;
    }

    const tokens = await this.exchange.refreshTokens(entry.session.refreshToken);
    // Update the session with the rotated tokens (the IdP may issue a new
    // refresh token; keep the old one only if it didn't).
    this.store.update(entry.sid, {
      ...entry.session,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken ?? entry.session.refreshToken,
      idToken: tokens.idToken ?? entry.session.idToken,
      expiresAt: Date.now() + tokens.expiresIn * 1000,
    });

    res.json({ accessToken: tokens.accessToken, expiresIn: tokens.expiresIn });
  }

  @Post("logout")
  async logout(@Req() req: Request, @Res() res: Response): Promise<void> {
    const sid = parseCookie(req.headers.cookie, this.config.sessionCookieName);
    const session = sid ? this.store.get(sid) : null;
    if (sid) this.store.destroy(sid);

    res.setHeader(
      "Set-Cookie",
      clearCookie(this.config.sessionCookieName, { httpOnly: true }),
    );

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
          this.config.spaOrigins.redirectOrigin,
        );
        endSessionUrl = url.toString();
      }
    } catch {
      endSessionUrl = null;
    }

    res.json({ ok: true, endSessionUrl });
  }

  /** Resolve { sid, session } for the request's cookie, or null. */
  private currentSession(
    req: Request,
  ): { sid: string; session: NonNullable<ReturnType<SessionStore["get"]>> } | null {
    const sid = parseCookie(req.headers.cookie, this.config.sessionCookieName);
    if (!sid) return null;
    const session = this.store.get(sid);
    if (!session) return null;
    return { sid, session };
  }
}
