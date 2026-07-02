---
"@orpc-ws/server": patch
---

The WS verify path is now fail-closed on malformed `verifyClient` results, mirroring the HTTP upload transport's existing hardening (shared `isWellFormedAuthResult`, extracted so the two transports cannot drift). Previously a contract-violating verifier resolving `{ok: "yes"}` or `{ok: true}` without a `user` was accepted — connections got registered under a literal-`undefined` key (colliding/kicking each other) and procedures ran with `context.user === undefined`. A failure result missing `code`/`reason` also no longer reaches `ws` internals (which threw a `TypeError` on the missing reason); all malformed shapes now reject the upgrade with a clean 500.
