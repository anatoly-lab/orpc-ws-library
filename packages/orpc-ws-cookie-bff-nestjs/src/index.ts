// Public surface of `@orpc-ws/cookie-bff-nestjs`.
//
// Three consumer-facing concepts:
//   1. `CookieBffModule` — the single dynamic module (`forRoot` /
//      `forRootAsync`). Internally configures `OrpcWsModule` + the cookie
//      verifier (Decision #23). Primary documented entry.
//   2. `CookieBffService` — injectable: `revokeUser(sub)`, `closeUser(...)`,
//      `getCore()`.
//   3. `CookieBffModuleOptions` — the config shape (the core's surface + the
//      `router`/WS passthroughs).
//
// Per §C.1 the adapter RE-EXPORTS the core's session-store + verifier +
// revoke surface so a consumer stays on a single import.

export { CookieBffModule } from "./cookie-bff.module.js";
export type { CookieBffModuleAsyncOptions } from "./cookie-bff.module.js";
export { CookieBffService } from "./cookie-bff.service.js";
export { CookieBffAuthController } from "./auth.controller.js";
export { COOKIE_BFF_OPTIONS, COOKIE_BFF_CORE } from "./cookie-bff.tokens.js";
export type { CookieBffModuleOptions } from "./cookie-bff.options.js";

// Bidi (server→client RPC) contract constraint — re-exported so a bidi
// consumer can annotate `CookieBffModuleOptions<TUser, TContract,
// TClientContract>` / their `forRootAsync` factory return type without a
// separate `@orpc-ws/server` import (same convenience the server-nestjs
// adapter's index provides).
export type { AnyContractRouter } from "@orpc-ws/server";

// ── Re-exports from the core (§C.1 "adapter re-exports") ──
export {
  createCookieBffCore,
  createCookieVerifyClient,
  revokeUser,
} from "@orpc-ws/cookie-bff";
export type {
  SessionStore,
  SessionData,
  CookieBffCore,
  CookieBffOptions,
  CookieVerifyOptions,
  AuthInstruction,
  AuthRequest,
  CookieSpec,
  CloseUser,
  IdTokenClaims,
  TokenSet,
} from "@orpc-ws/cookie-bff";
