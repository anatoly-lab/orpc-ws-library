---
"@orpc-ws/server": minor
"@orpc-ws/server-nestjs": minor
---

Expose ORPC `RPCHandler` interceptors as a passthrough on the server options:
new optional `interceptors` and `rootInterceptors` fields, forwarded to BOTH
internally-built RPCHandlers (the WS handler and the optional HTTP upload
handler).

The common use is a single central error logger that covers EVERY procedure
regardless of how the consumer composed their router — including sub-routers
that were spread in unwrapped (e.g. `...authRouter.getRouter()`), which
previously bypassed consumer root middleware and so were never server-logged:

```ts
import { onError } from "@orpc/server";

createOrpcWsServer({
  router,
  verifyClient,
  interceptors: [onError((e) => logger.error({ err: e }, "orpc error"))],
});
```

Available on both factories (`createOrpcWsServer` / `createAuthlessOrpcWsServer`)
and on both arms of the NestJS `OrpcWsModuleOptions`.

Coverage caveats (intentional): `interceptors` fires for unary procedure
failures and AsyncIterable subscription *setup* failures, but does NOT see
errors thrown mid-stream from an AsyncIterable (the handle has already
resolved), nor the HTTP upload transport's pre-ORPC rejects (verifyClient /
beforeUpload reject before the RPCHandler runs). `rootInterceptors` wrap the
whole handle including ORPC's error→response mapping, so a `rootInterceptor`
`onError` will NOT fire on a procedure throw — use `interceptors` for that.
