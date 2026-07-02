---
"@orpc-ws/server": patch
---

Harden the connection path against synchronous throws (fail closed instead of crashing):

- A `verifyClient` that throws synchronously (or returns a non-promise) no longer escapes the `ws` upgrade path — in authless mode a sync handler throw was a genuine `uncaughtException` (process crash, triggerable by a single bad frame/token); in authed mode the error was swallowed with a misleading log and double-fired the ws callback, writing a raw `HTTP/1.1 500` onto the already-upgraded socket. Both now fail closed (500 reject / 1011 close) with truthful logging.
- A synchronous throw in the connection handler after registry registration no longer leaks the registry entry: wiring failures roll back (unregister first — unskippable — then timer/ping-pong/bidi teardown) and the socket is closed 1011. The next connection under the same key, including the authless single-connection constant key, proceeds normally.
