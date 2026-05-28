// Module-level smoke: the package exports the documented public surface.
// Anything missing here means a downstream import breaks at type-time
// before tests run.

import { describe, expect, it } from "vitest";

import * as nestjsAdapter from "../index.js";

describe("@repo/orpc-ws-server-nestjs smoke", () => {
  it("the package exposes the documented public surface", () => {
    expect(nestjsAdapter.OrpcWsModule).toBeDefined();
    expect(nestjsAdapter.OrpcWsService).toBeDefined();
    expect(nestjsAdapter.ORPC_WS_OPTIONS).toBeDefined();
  });
});
