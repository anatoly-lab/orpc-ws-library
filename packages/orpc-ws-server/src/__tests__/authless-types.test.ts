// TYPE-LEVEL test for the authless public surface.
//
// These assertions are about the TYPES, not runtime behavior — the body
// `it(...)` is trivially true; the value is in the `@ts-expect-error`
// directives and the structural `expectType` helper below. They pin:
//   1. Authless options REJECT `verifyClient`.
//   2. Authless options REJECT `uploads`.
//   3. Authless options REJECT `enforceTokenExpiry` on `connection`.
//   4. The authless server has NO `closeUser`.
//   5. The authless server DOES keep `attach` / `dispose`.
//
// ENFORCED IN CI: the package's main `tsc` typecheck excludes test files, so
// these assertions are checked by a SECOND pass — `tsconfig.test-types.json`,
// chained into the package `typecheck` script — that re-includes only the
// `*-types.test.ts` type tests. So a regression that loosened the authless
// types fails `pnpm typecheck`. The file is named `*-types.test.ts` to match
// that config's include glob; it also runs (trivially) under the test runner.

import { describe, it } from "vitest";
import type {
  AuthlessOrpcWsServerOptions,
  AuthlessOrpcWsServer,
} from "../index.js";
import { createAuthlessOrpcWsServer } from "../index.js";

const router = {} as const;

describe("AUTHLESS — type-level guarantees", () => {
  it("authless options reject auth-only fields; server has no closeUser", () => {
    // 1. verifyClient is NOT a valid authless option.
    const _rejectsVerifyClient: AuthlessOrpcWsServerOptions<typeof router> = {
      router,
      // @ts-expect-error — authless options must not accept verifyClient.
      verifyClient: async () => ({ ok: true, user: {} }),
    };
    void _rejectsVerifyClient;

    // 2. uploads is NOT a valid authless option.
    const _rejectsUploads: AuthlessOrpcWsServerOptions<typeof router> = {
      router,
      // @ts-expect-error — authless options must not accept uploads.
      uploads: { enabled: true },
    };
    void _rejectsUploads;

    // 3. enforceTokenExpiry is NOT a valid authless connection knob.
    const _rejectsExpiry: AuthlessOrpcWsServerOptions<typeof router> = {
      router,
      connection: {
        // @ts-expect-error — enforceTokenExpiry is meaningless authless.
        enforceTokenExpiry: true,
      },
    };
    void _rejectsExpiry;

    // 4 + 5. The authless server type omits `closeUser` but keeps
    // attach/dispose.
    const server: AuthlessOrpcWsServer<typeof router> =
      createAuthlessOrpcWsServer({ router });
    // `void` discard keeps these as type-existence assertions (they'd fail tsc
    // if the member were missing) while satisfying no-unused-expressions —
    // same idiom as the `void _rejects*` discards above.
    void server.attach;
    void server.dispose;
    // @ts-expect-error — authless server has no per-user closeUser.
    void server.closeUser;
  });
});
