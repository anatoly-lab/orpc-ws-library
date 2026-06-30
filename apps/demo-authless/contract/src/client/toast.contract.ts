// Feature fragment: TOAST (server→client).
//
// CONTRACT COMPOSITION — one feature owns its slice of the client contract.
// In a real app this file would live in the "toast" feature folder, next to
// the React component that implements it (`ServerToasts.tsx`) and any feature
// state. The slice is a plain object of `oc` procedures; the thin composition
// root (`../index.ts`) merges it with the other features' slices.
//
//   - `showToast`: the server pushes a short message the browser renders as a
//     toast. The browser replies `{ shown: true }`, so the round-trip is
//     observable back on the server (the s2c call resolves with this output).

import { oc } from "@orpc/contract";
import { z } from "zod";

export const toastClientContract = {
  showToast: oc
    .input(z.object({ text: z.string() }))
    .output(z.object({ shown: z.boolean() })),
};
