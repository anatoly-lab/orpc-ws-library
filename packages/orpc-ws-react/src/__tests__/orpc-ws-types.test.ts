// TYPE-LEVEL test for `<OrpcWs>`'s bidi handler-map surface.
//
// The runtime test file (`orpc-ws.test.tsx`) is excluded from the package
// `tsconfig.json`, so the `ClientRouterHandlers` types are otherwise NEVER
// checked by `pnpm typecheck` — a regression that loosened them (or re-added
// the dropped decorative first generic, which silently untyped the handler map)
// would pass silently. This file is re-included ONLY by `tsconfig.test-types.json`,
// chained into the `typecheck` script, so the `@ts-expect-error` directives are
// genuinely enforced (a stale one fails tsc — that is the point). Mirrors the
// NestJS adapter's `bidi-types.test.ts`.
//
// The runtime body is trivial; the value is in the typed assignments below.

import { oc, type } from "@orpc/contract";
import { describe, it } from "vitest";

import type { ClientRouterHandlers, OrpcWsProps } from "../orpc-ws.js";

// A REAL small client (server→client) contract built with `oc` — two
// procedures so a MISSING-key case is meaningful. Only its TYPE is used (the
// `_` prefix marks the value as intentionally unused — repo convention).
const _clientContract = {
  greet: oc.input(type<{ name: string }>()).output(type<string>()),
  ping: oc.input(type<{ at: number }>()).output(type<boolean>()),
};
type ClientContract = typeof _clientContract;

describe("<OrpcWs> bidi handler map — type-level guarantees", () => {
  it("ClientRouterHandlers<ClientContract> pins inputs, outputs, keys, and value shape", () => {
    // ----- Correct handler map type-checks. -----
    const ok: ClientRouterHandlers<ClientContract> = {
      greet: (input) => input.name, // input: { name: string }, output: string
      ping: (input) => input.at > 0, // input: { at: number },  output: boolean
    };
    void ok;

    // The map is exactly the type `<OrpcWs<ClientContract>>` would demand of its
    // `clientRouter` prop — the SOLE generic now types it (no first generic to
    // swallow `ClientContract` into and leave the map untyped, the old footgun).
    const asProp: OrpcWsProps<ClientContract>["clientRouter"] = ok;
    void asProp;

    // ----- WRONG output type. -----
    const badOutput: ClientRouterHandlers<ClientContract> = {
      // @ts-expect-error — `greet` must return string, not number.
      greet: () => 123,
      ping: () => true,
    };
    void badOutput;

    // ----- WRONG input usage (param typed against the wrong input shape). -----
    const badInput: ClientRouterHandlers<ClientContract> = {
      // @ts-expect-error — handler input must accept { name: string }, not { name: number }.
      greet: (input: { name: number }) => String(input.name),
      ping: () => true,
    };
    void badInput;

    // ----- MISSING procedure key. -----
    // @ts-expect-error — `ping` is required but absent.
    const missingKey: ClientRouterHandlers<ClientContract> = {
      greet: (input) => input.name,
    };
    void missingKey;

    // ----- NON-FUNCTION value for a key. -----
    const nonFunction: ClientRouterHandlers<ClientContract> = {
      // @ts-expect-error — a handler must be a function, not a string.
      greet: "not a function",
      ping: () => true,
    };
    void nonFunction;
  });

  it("the `never` default (no generic) is intentionally permissive — the one remaining footgun, by design", () => {
    // With no `TClientContract`, `ClientRouterHandlers` defaults to `never`,
    // whose inputs map has no keys → an empty handler-map type. This is the
    // bidi-OFF case: a one-way `<OrpcWs>` (no `clientRouter`) needs no typing.
    // A bidi consumer MUST therefore supply the generic (`<OrpcWs<MyClientContract>>`)
    // to get a typed map — the single-generic shape makes that requirement
    // obvious (there is no decorative first slot to misfill).
    const permissive: ClientRouterHandlers = {};
    void permissive;
  });
});
