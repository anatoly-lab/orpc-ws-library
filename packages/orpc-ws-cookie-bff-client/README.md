# `@orpc-ws/cookie-bff-client`

Framework-free **browser** core for the cookie-BFF `/auth/*` control plane. It
owns the security-sensitive protocol glue a cookie-BFF SPA needs — so consumers
don't reimplement it:

- the typed `GET {serverOrigin}{mePath}` fetch (returns the enriched user, or `null`);
- the **in-memory synchronizer-CSRF token** (held in a closure, never
  `localStorage`, never a cookie — per-origin memory isolation is the whole
  security point);
- a single CSRF-aware `mutate()` fetch wrapper that auto-attaches the
  `X-CSRF-Token` header + `credentials: "include"` — the **one** place the
  header is set;
- a pure `loginUrl()` string builder;
- a `logout()` that POSTs and **returns** the server's `endSessionUrl` —
  it does **not** navigate.

**Boundary:** this package never touches `window.location`/routing — navigation
decisions stay in the app. And it has **no WebSocket coupling**: the consumer
still creates its own `createOrpcWsClient(...)` separately (with **no
`tokenProvider`** — the httpOnly `sid` cookie rides the WS upgrade
automatically). This client is the HTTP `/auth/*` control plane only.

Zero runtime dependencies (uses global `fetch`). Browser-only.

```ts
import { createCookieBffAuthClient } from "@orpc-ws/cookie-bff-client";

const auth = createCookieBffAuthClient<MyUser>({
  serverOrigin: "https://api.example.com",
  loginPath: "/auth/login",
  logoutPath: "/auth/logout",
  mePath: "/auth/me",
});
const user = await auth.me();                 // holds the CSRF token in memory
window.location.href = auth.loginUrl();        // app owns navigation
const { endSessionUrl } = await auth.logout(); // app decides where to go
```

The three endpoint paths (`loginPath` / `logoutPath` / `mePath`) are explicit and
required: this decouples the client from the server's path convention — there is no
hidden `/auth` assumption baked in.
