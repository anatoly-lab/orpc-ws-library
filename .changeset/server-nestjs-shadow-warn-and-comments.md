---
"@orpc-ws/server-nestjs": patch
---

Upload-route safety and comment truthfulness in the NestJS adapter:

- New boot-time detection: a consumer controller route nested under the upload `httpPath` (e.g. `@Controller("upload")` + `@Post("media/upload")`) now logs a warning naming the offending route — on Nest 11 controllers register before the upload middleware, so such routes silently shadowed RPC upload procedures. Warn, not throw: apps booting with this misconfiguration today keep booting. The exact-path collision still throws as before.
- The `onModuleInit` registration rationale was rewritten to the true Nest 11 mechanism (controllers register *before* the middleware; it works because the 404 catch-all registers *after*), and the false claim that `closeUser` no-ops on an authless server was corrected (it kicks by registry key in any mode; the authless `Omit` is compile-time only).
