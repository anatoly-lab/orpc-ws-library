# Fable model review — `@repo/orpc-ws-*`

Independent codebase review performed by agents running on the **Fable**
model. Scope: the library packages under `packages/*` (cores + adapters +
OIDC helpers). Demo apps and e2e are in scope only where they reveal a
library defect.

> **Authoritative status record:**
> [resolution-status.md](./resolution-status.md) — every finding from this
> review and the follow-up adversarial review, with its final disposition.
> Per-finding banners in the individual reports may lag behind it.

**Status: sweep complete.** All **10/10 bugs** (BUG-1..10) and all **5/5
adversarial findings** (F1–F5) are ✅ RESOLVED, along with **API-4**
(server token-expiry, opt-in), **SEC-3/SEC-4**, and **NFI-1/4/5**.
**S1** (finite `reconnect.maxRetries` semantics) is ✅ RESOLVED —
option (c): a finite value is unsupported, so the library warns and
forces `maxRetries` back to `Infinity` (documented in the client
README). Remaining open: **NFI-3** (HTTP-upload 401 → storm guard)
awaits a maintainer decision; **S2** is won't-fix (cosmetic); SEC-5/6/7 are Info/accepted (SEC-2 is
documented, not code-changed); and the SOLID/architecture refactors
(client `index.ts` is now ~700+ LOC) are deferred to a deliberate
refactor effort. See [resolution-status.md](./resolution-status.md) for
the full table and notes.

## Reports

| Report | Area | Headline counts |
|---|---|---|
| [security-review.md](./security-review.md) | Security: auth, token lifecycle, uploads, verifier, DoS | API-4 reproduced (Medium); 4 Low, 3 Info |
| [bugs-review.md](./bugs-review.md) | Correctness bugs: reconnect, heartbeat, sleep, lifecycle, state | 4 High, 4 Medium, 2 Low |
| [solid-review.md](./solid-review.md) | SOLID / architecture vs the project's own non-negotiables | 6 god files (worst 641 LOC); ~15 banned-construct lines |

## Cross-cutting headline

The serious findings cluster at the **client-core composition root**
(`packages/orpc-ws-client/src/index.ts`, 641 LOC) and the
**reconnect/heartbeat lifecycle interactions** — three independent "permanent
zombie / never-terminal" bugs (BUG-1/3/4) plus the architectural smell that
the composition root is the very god-file the project says it's escaping. The
per-module logic is well-tested; the gaps are in how the modules are wired
together at the top.

## Seed finding under validation

**API-4 — no token-expiry enforcement on the dashboard WebSocket** (carried
over from the source app `anki-mcp-saas`). The library is the extraction of
that exact gateway, so the security report validates whether
`@repo/orpc-ws-server` reproduces it: token validated once at connect
(`lifecycle/verify-client-orchestrator.ts`), never re-checked; no scheduled
close at `exp`; no `session.invalidated` force-disconnect. See
[security-review.md](./security-review.md).
