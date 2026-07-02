// `@Injectable` facade over the cookie-BFF core + the WS server.
//
// Composes the injected `OrpcWsService` (from the internally-wired
// `OrpcWsModule`) so the consumer's app gets ONE service for the cookie-BFF
// concerns it drives imperatively:
//   - `revokeUser(sub)` — the best-effort kick (§G): delete every session for
//     `sub` (store.deleteByUser) AND drop the live socket on THIS instance
//     (OrpcWsService.closeUser). LOCAL-only; cross-instance fan-out is the
//     consumer's job (their event bus calls this on each instance).
//   - `closeUser(...)` — pass-through to the WS server.
//   - `getCore()` — escape hatch to the raw `/auth/*` handlers.

import { Inject, Injectable } from "@nestjs/common";

import {
  type CookieBffCore,
  type SessionStore,
  revokeUser,
} from "@orpc-ws/cookie-bff";
import { OrpcWsService } from "@orpc-ws/server-nestjs";

import { COOKIE_BFF_CORE, COOKIE_BFF_OPTIONS } from "./cookie-bff.tokens.js";
import type { CookieBffModuleOptions } from "./cookie-bff.options.js";

@Injectable()
export class CookieBffService {
  constructor(
    // Explicit @Inject (string tokens / a value-imported class) so the refs
    // survive `verbatimModuleSyntax` — mirrors OrpcWsService's DI convention.
    @Inject(COOKIE_BFF_OPTIONS)
    private readonly options: CookieBffModuleOptions,
    @Inject(COOKIE_BFF_CORE)
    private readonly core: CookieBffCore,
    @Inject(OrpcWsService)
    private readonly orpcWs: OrpcWsService,
  ) {}

  /**
   * Best-effort revocation kick (§D.5/§G). Deletes every session for `sub`
   * (future connects + lazy refreshes fail) and closes its live socket on
   * THIS instance. Call from the consumer's revocation-event handler on every
   * instance — cross-instance fan-out is the consumer's event bus, not this.
   */
  async revokeUser(sub: string): Promise<void> {
    const store = this.options.sessionStore as SessionStore<unknown>;
    await revokeUser(
      store,
      (connectionKey, code, reason) =>
        this.orpcWs.closeUser(connectionKey, code, reason),
      sub,
      // A throwing closeUser is logged (never masks the delete rejection);
      // omitted logger falls back to revokeUser's noop default.
      this.options.logger,
    );
  }

  /** Pass-through: close a specific user's WS connection. */
  closeUser(
    ...args: Parameters<OrpcWsService["closeUser"]>
  ): ReturnType<OrpcWsService["closeUser"]> {
    return this.orpcWs.closeUser(...args);
  }

  /**
   * Escape hatch: the raw `/auth/*` handlers (advanced consumers wiring their
   * own routes, tests). The controller is the everyday path.
   */
  getCore(): CookieBffCore {
    return this.core;
  }
}
