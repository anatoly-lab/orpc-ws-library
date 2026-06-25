// DI tokens for the cookie-BFF adapter.
//
// `COOKIE_BFF_OPTIONS` — the resolved `CookieBffModuleOptions` (from
// `forRoot`'s literal value or `forRootAsync`'s factory).
// `COOKIE_BFF_CORE` — the framework-free `CookieBffCore` built from those
// options (the `/auth/*` handlers). The controller + service inject it.
//
// String tokens (not the class itself) because the options/core are
// interface/factory values, not Nest providers with a class identity.

/** Injection token for the resolved {@link CookieBffModuleOptions}. */
export const COOKIE_BFF_OPTIONS = "ORPC_WS_COOKIE_BFF_OPTIONS";

/** Injection token for the built `CookieBffCore` (the /auth/* handlers). */
export const COOKIE_BFF_CORE = "ORPC_WS_COOKIE_BFF_CORE";
