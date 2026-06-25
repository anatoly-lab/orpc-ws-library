// `/auth/*` controller — a PURE translator from the core's transport-agnostic
// `AuthInstruction` to express `@Res`. No auth logic lives here (it's all in
// `@orpc-ws/cookie-bff`); this file only:
//   1. builds the core's `AuthRequest` from the express `req`
//      (cookieHeader + query + headers), and
//   2. applies the returned `AuthInstruction` to the express `res`
//      (status, every Set-Cookie via `res.append`, redirect-or-body).
//
// `@Controller("auth")` is a FIXED prefix. `endpoints.basePath` (and
// `endpoints.ws`) are CURRENTLY IGNORED by this adapter — a no-op. Nest reads
// the controller prefix from decorator metadata at class-eval time, before any
// DI/config runs, so it can't be config-driven. A consumer wanting a different
// base uses Nest's `setGlobalPrefix` or mounts this controller under a
// versioned/prefixed module; the WS path comes from `connection.path`.
//
// Express `@Req`/`@Res` (value imports of the types are erased; only used in
// annotations) — the adapter assumes an Express HTTP adapter, same as
// `@orpc-ws/server-nestjs`'s upload route.

import { Controller, Get, Inject, Post, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";

import type { AuthInstruction, AuthRequest, CookieBffCore } from "@orpc-ws/cookie-bff";

import { COOKIE_BFF_CORE } from "./cookie-bff.tokens.js";

@Controller("auth")
export class CookieBffAuthController {
  constructor(
    @Inject(COOKIE_BFF_CORE)
    private readonly core: CookieBffCore,
  ) {}

  @Get("login")
  async login(@Req() req: Request, @Res() res: Response): Promise<void> {
    this.apply(res, await this.core.login(this.toAuthRequest(req)));
  }

  @Get("callback")
  async callback(@Req() req: Request, @Res() res: Response): Promise<void> {
    this.apply(res, await this.core.callback(this.toAuthRequest(req)));
  }

  @Get("me")
  async me(@Req() req: Request, @Res() res: Response): Promise<void> {
    this.apply(res, await this.core.me(this.toAuthRequest(req)));
  }

  @Post("logout")
  async logout(@Req() req: Request, @Res() res: Response): Promise<void> {
    this.apply(res, await this.core.logout(this.toAuthRequest(req)));
  }

  /** Build the core's minimal request slice from the express request. */
  private toAuthRequest(req: Request): AuthRequest {
    return {
      cookieHeader: req.headers.cookie,
      // express types `query` loosely; the core reads only string values and
      // treats anything else as absent, so a shallow cast is safe here.
      query: req.query as Record<string, string | undefined>,
      headers: req.headers as Record<string, string | undefined>,
    };
  }

  /** Apply a core `AuthInstruction` to the express response. */
  private apply(res: Response, instruction: AuthInstruction): void {
    res.status(instruction.status);

    // Emit every cookie (set + clear) via `append` so multiple Set-Cookie
    // headers coexist (the sid + CSRF + the oauth_state clear can all be
    // present on one response).
    for (const c of instruction.setCookies ?? []) {
      res.append("Set-Cookie", c.value);
    }
    for (const c of instruction.setClearCookies ?? []) {
      res.append("Set-Cookie", c.value);
    }

    if (instruction.redirect !== undefined) {
      res.redirect(instruction.status, instruction.redirect);
      return;
    }
    if (instruction.body !== undefined) {
      res.json(instruction.body);
      return;
    }
    res.end();
  }
}
