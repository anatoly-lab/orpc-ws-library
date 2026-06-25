---
"@orpc-ws/cookie-bff": minor
"@orpc-ws/cookie-bff-nestjs": minor
"@orpc-ws/cookie-bff-client": minor
---

Add cookie-BFF packages: framework-free server core + NestJS adapter (server-side session, httpOnly sid, OIDC PKCE, lazy refresh, revocation, synchronizer-token CSRF / Origin / __Host- hardening) and a framework-free browser client core for the `/auth/*` control plane (typed `/auth/me`, in-memory synchronizer-CSRF token, CSRF-aware `mutate()`, login-URL builder, navigation-free `logout()`).
