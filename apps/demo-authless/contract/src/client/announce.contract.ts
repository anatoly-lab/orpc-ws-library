// Feature fragment: ANNOUNCE (server→client).
//
// CONTRACT COMPOSITION — a SECOND feature owning its own slice. It knows
// nothing about the toast feature; it just exports its procedures. Adding this
// feature was a new fragment file plus a single spread line in the thin root
// (`../index.ts`) — no edits to the toast slice. That is the whole point of
// composing the client contract from feature-owned fragments.
//
//   - `announce`: the server pushes an announcement the browser renders in its
//     own list. The browser replies `{ ok: true }`, so the s2c call resolves
//     on the server exactly like `showToast` does.

import { oc } from "@orpc/contract";
import { z } from "zod";

export const announceClientContract = {
  announce: oc
    .input(z.object({ message: z.string() }))
    .output(z.object({ ok: z.boolean() })),
};
