# Sequence — file upload (`orpc-http` strategy)

Client calls `client.upload(file, opts)`; the library routes through
the HTTP transport (opt-in) to a parallel `RPCHandler` bound to the
same composed router as the WS handler. Auth uses the same
`TokenProvider`, this time as a `Bearer` header.

```mermaid
sequenceDiagram
    autonumber
    participant App as Consumer app
    participant Client as OrpcWsClient
    participant Strat as OrpcHttpUploadStrategy
    participant Token as TokenProvider
    participant HTTP as fetch (browser)
    participant Express as Express route (httpPath)
    participant Verify as VerifyClientOrchestrator
    participant ConsumerAuth as Consumer verifyClient
    participant HttpRPC as RPCHandler (HTTP transport)
    participant Proc as Upload procedure (consumer-defined)

    App->>Client: client.upload(file, { procedure: ["files","upload"], onProgress, signal })
    Client->>Strat: upload(file, opts)

    Strat->>Token: getToken()
    Token-->>Strat: "eyJ..."

    Strat->>HTTP: POST httpUrl<br/>Authorization: Bearer eyJ...<br/>Content-Type: multipart/form-data<br/>Body: ORPC multipart envelope + file

    HTTP->>Express: POST /upload
    Express->>Verify: verifyClient(httpCtx)
    Verify->>ConsumerAuth: verifyClient(httpCtx)
    ConsumerAuth-->>Verify: { ok: true, user, connectionKey }
    Verify-->>Express: accept; attach user to context

    Express->>HttpRPC: handle(req, res, { context: user })
    HttpRPC->>Proc: invoke procedure with parsed input + file
    Proc-->>HttpRPC: result
    HttpRPC-->>Express: 200 OK + ORPC response

    Express-->>HTTP: 200 + JSON
    HTTP-->>Strat: response
    Strat-->>Client: UploadResult
    Client-->>App: resolves with the procedure's return value

    Note over HTTP,Strat: onProgress is wired to fetch's<br/>upload progress stream (browser).<br/>signal is forwarded to fetch.
```

Notes:

- **Same router, two transports.** The NestJS adapter builds a second
  `RPCHandler` from the same composed router used by the WS handler.
  One contract definition; the upload procedure is just another
  procedure with a `z.file()` field. (CLAUDE.md "Uploads".)
- **Symmetric auth.** The HTTP route runs the same `verifyClient` as
  the WS upgrade. Token comes from the `Authorization: Bearer` header
  instead of the URL query param, but the verifier is the same
  function.
- **`procedure` is typed.** `Path<TContract>` is a tuple over the
  contract's nested keys. Renaming the procedure in the contract
  surfaces as a compile error at the `client.upload(...)` call site —
  not as a runtime "procedure not found." (Phase 6 §"`procedure` is
  typed, NOT `string`".)
- **Storm guard applies.** A 401 from the HTTP transport counts toward
  the same shared storm-guard window as WS auth failures. The library
  doesn't burn the budget twice across transports.
- **`"presigned-url"` strategy is reserved.** Throws "not implemented"
  at runtime in v1. Adding it later is purely additive — the
  `client.upload(file, opts)` signature is unchanged.
