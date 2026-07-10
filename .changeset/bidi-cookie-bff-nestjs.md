---
"@orpc-ws/cookie-bff-nestjs": minor
---

Thread server→client RPC (bidirectional) through the cookie-BFF NestJS adapter.

`CookieBffModule` now accepts an optional `clientContract` — the client's
contract router — and forwards it unchanged into the internal `OrpcWsModule`.
Its presence flips bidi on for cookie-authed connections, giving every
connection a typed `conn.client` caller (in `hooks.onConnected` and via
`OrpcWsService.getConnection(key)?.client`), exactly as the token/authless
`@orpc-ws/server-nestjs` path already does. Additive: omit `clientContract`
and the WS options are byte-identical to before (no `conn.client`).

`CookieBffModuleOptions` / `CookieBffModuleAsyncOptions` gain two extra
defaulted generics `<TUser, TContract, TClientContract>` (existing one-way
configs compile unchanged); `hooks` is now `AuthenticatedHooks<TUser,
TClientContract>`. On `forRootAsync`, annotate the `useFactory` return type or
`TClientContract` collapses to `never` and `conn.client` loses its typing
(runtime still wires bidi). The adapter re-exports `AnyContractRouter` for the
annotation.
