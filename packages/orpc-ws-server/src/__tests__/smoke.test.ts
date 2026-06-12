import { describe, expect, it } from "vitest";

import * as server from "../index.js";

describe("@orpc-ws/server smoke", () => {
  it("the package's main entry resolves to a module", () => {
    expect(server).toBeTypeOf("object");
  });
});
