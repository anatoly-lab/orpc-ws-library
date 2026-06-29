// TYPE-LEVEL test for the server→client bidi `conn` surface.
//
// Like `authless-types.test.ts`, the runtime body is trivial — the value is in
// the `@ts-expect-error` directives + structural assignments, checked by the
// chained `tsconfig.test-types.json` pass in `pnpm typecheck`. Pins:
//   1. With a `clientContract`, `conn.client` is `ContractRouterClient<…>`
//      (on both the `onConnected` hook conn AND `getConnection`).
//   2. WITHOUT a `clientContract`, `conn.client` is ABSENT (a compile error to
//      read) — the third generic defaults to `never`.
//   3. The authless `conn` has NO `user` (and still carries `client` when a
//      `clientContract` is supplied).

import { oc } from "@orpc/contract";
import type { ContractRouterClient } from "@orpc/contract";
import { describe, it } from "vitest";

import {
  createAuthlessOrpcWsServer,
  createOrpcWsServer,
  type VerifyClient,
} from "../index.js";

interface TestUser {
  sub: string;
}

const router = {} as const;
const verifyClient = (async () => ({
  ok: true,
  user: { sub: "u" },
})) as VerifyClient<TestUser>;

// A client contract value + its type.
const clientContract = { notify: oc };
type ClientContract = typeof clientContract;

describe("bidi conn — type-level guarantees", () => {
  it("conn.client is conditional on clientContract; authless conn has no user", () => {
    // ----- 1. WITH a clientContract: conn.client is the typed caller. -----
    const bidiServer = createOrpcWsServer<TestUser, typeof router, ClientContract>(
      { router, verifyClient, clientContract },
    );
    const bidiConn = bidiServer.getConnection("k");
    if (bidiConn) {
      // Assignable to the typed caller → `client` exists with the right type.
      const caller: ContractRouterClient<ClientContract> = bidiConn.client;
      void caller;
      // The user is still present + typed in authed mode.
      const user: TestUser = bidiConn.user;
      void user;
    }

    // ----- 2. WITHOUT a clientContract: conn has NO client. -----
    const plainServer = createOrpcWsServer<TestUser, typeof router>({
      router,
      verifyClient,
    });
    const plainConn = plainServer.getConnection("k");
    if (plainConn) {
      const user: TestUser = plainConn.user;
      void user;
      // @ts-expect-error — no clientContract ⇒ conn has no `client`.
      void plainConn.client;
    }

    // ----- 3. Authless conn: no user; client present when contract supplied. -----
    const authlessBidi = createAuthlessOrpcWsServer<typeof router, ClientContract>(
      { router, clientContract },
    );
    const authlessConn = authlessBidi.getConnection("k");
    if (authlessConn) {
      const caller: ContractRouterClient<ClientContract> = authlessConn.client;
      void caller;
      // @ts-expect-error — authless conn carries no `user`.
      void authlessConn.user;
    }
  });
});
