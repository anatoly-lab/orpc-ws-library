// Runtime fail-closed shape guard for consumer-supplied `VerifyClient`
// results — shared by BOTH transports so they cannot drift:
//
//   - HTTP uploads: `upload/http-handler.ts` `runVerify` (where this
//     helper originally lived).
//   - WS upgrades: `lifecycle/verify-client-orchestrator.ts`
//     `buildWsVerifyClient`.
//
// `VerifyClient` is *typed* to return a well-formed discriminated union,
// but a plain-JS consumer can violate that at runtime — return
// `undefined`, a bare boolean, `{ ok: "yes" }`, `{ ok: true }` with no
// `user` — and TS cannot catch it. Both transports must coerce anything
// malformed into a clean 500 reject rather than trusting the shape:
//
//   - HTTP: a non-conforming *return* (unlike a throw) slips past the
//     try/catch, and the later `!result.ok` read then throws inside the
//     void-ed async IIFE → unhandled rejection, no response written,
//     request hangs.
//   - WS: a truthy-but-malformed `ok` (`"yes"`, or `true` with no
//     `user`) would be ACCEPTED — auth fail-open. Downstream,
//     `ConnectionHandler.deriveConnectionKey` falls back to
//     `JSON.stringify(auth.user)`, and `JSON.stringify(undefined)` is
//     the literal `undefined` (not a string): the connection registry
//     gets keyed by `undefined`, every such connection collides/kicks
//     the others, and procedures run with `context.user === undefined`
//     despite the typed contract.
//
// `code`/`reason` are required on the reject branch because both reject
// paths read them without defaults (HTTP writes them straight into the
// response; the WS orchestrator hands them to `ws`'s abort callback —
// and `ws`'s `abortHandshake` computes `Buffer.byteLength(message)`,
// which throws on a missing message when the code has no
// `http.STATUS_CODES` entry). The accept branch must carry a DEFINED
// `user`: a mere `"user" in r` presence check would accept
// `{ ok: true, user: undefined }` — the explicit-undefined corner of the
// fail-open described above (the registry key falls back to
// `JSON.stringify(undefined)`, the literal `undefined`) — so the guard
// also requires `r.user !== undefined`. (An explicitly-undefined `user`
// and a missing one are indistinguishable to every downstream consumer;
// both are malformed.) Both transports get this via the shared helper —
// that was the point of extracting it.

import type { VerifyClientResult } from "./verify-client-orchestrator.js";

export function isWellFormedAuthResult(
  v: unknown,
): v is VerifyClientResult<unknown> {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  if (r.ok === true) return "user" in r && r.user !== undefined;
  if (r.ok === false) {
    return typeof r.code === "number" && typeof r.reason === "string";
  }
  return false;
}
