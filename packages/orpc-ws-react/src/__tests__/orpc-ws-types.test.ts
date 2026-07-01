// TYPE-LEVEL test for the feature-local server→client surface: the contract-bound
// `createServerHandlerHook` hook AND `<OrpcWs>`'s `clientContract` inference.
//
// The runtime test file (`orpc-ws.test.tsx`) is excluded from the package
// `tsconfig.json`, so these typed guarantees are otherwise NEVER checked by
// `pnpm typecheck` — a regression that loosened the hook's input/output/name
// pinning (or `<OrpcWs>`'s inference) would pass silently. This file is
// re-included ONLY by `tsconfig.test-types.json`, chained into the `typecheck`
// script, so the `@ts-expect-error` directives are genuinely enforced (a stale
// one fails tsc — that is the point). Mirrors the NestJS adapter's
// `bidi-types.test.ts`.
//
// The hook MUST NOT actually run here (calling a React hook outside a component
// throws), so every hook-call assertion lives inside a function that is type-
// checked but NEVER invoked. JSX `<OrpcWs clientContract={cc}>` desugars to the
// `OrpcWs({ clientContract: cc, … })` call form below — TS infers the generic
// identically either way, so the no-JSX `.ts` file still proves inference.

import { oc, type } from "@orpc/contract";
import { describe, it } from "vitest";

import { OrpcWs, type OrpcWsProps } from "../orpc-ws.js";
import { createServerHandlerHook } from "../use-server-handler.js";

// A REAL small server→client contract built with `oc` — two procedures so a
// NON-CONTRACT-name case is meaningful.
const clientContract = oc.router({
  greet: oc.input(type<{ name: string }>()).output(type<string>()),
  ping: oc.input(type<{ at: number }>()).output(type<boolean>()),
});
type ClientContract = typeof clientContract;

// Type-only assertions, never executed (see header) — the directives below are
// enforced by tsc via `tsconfig.test-types.json`.
function _hookTypeChecks(): void {
  const useServerHandler = createServerHandlerHook<ClientContract>();

  // ----- Correct handlers type-check (input + output pinned per name). -----
  useServerHandler("greet", (input) => input.name); // input {name:string} → string
  useServerHandler("ping", (input) => input.at > 0); // input {at:number}  → boolean
  useServerHandler("greet", async (input) => input.name); // async output allowed

  // ----- WRONG output type. -----
  // @ts-expect-error — `greet` must return string, not number.
  useServerHandler("greet", () => 123);

  // ----- WRONG input usage (param typed against the wrong input shape). -----
  // @ts-expect-error — handler input must accept { name: string }, not { name: number }.
  useServerHandler("greet", (input: { name: number }) => String(input.name));

  // ----- NON-CONTRACT procedure name. -----
  // @ts-expect-error — "nope" is not a procedure of the client contract.
  useServerHandler("nope", () => "x");
}

function _inferenceChecks(): void {
  // `<OrpcWs clientContract={clientContract}>` desugars to this call; TS infers
  // `TClientContract` from the prop VALUE — NO explicit generic needed. (`url`
  // is the one required construction option.)
  const bidi = OrpcWs({ url: "ws://test", clientContract, children: null });
  void bidi;

  // One-way: omitting `clientContract` is fine (TClientContract defaults never).
  const oneWay = OrpcWs({ url: "ws://test", children: null });
  void oneWay;

  // The prop is exactly the contract VALUE type (and stays optional).
  const cc: OrpcWsProps<ClientContract>["clientContract"] = clientContract;
  void cc;

  // @ts-expect-error — required props (`url`, `children`) are absent.
  const missingRequired: OrpcWsProps = {};
  void missingRequired;
}

describe("server→client typed surface — type-level guarantees", () => {
  it("pins useServerHandler name/input/output and infers <OrpcWs> clientContract", () => {
    // The value is in the typed function bodies above; reference them so
    // no-unused-vars stays quiet without executing the hook.
    void _hookTypeChecks;
    void _inferenceChecks;
  });
});
