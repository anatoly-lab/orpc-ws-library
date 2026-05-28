import { describe, expect, it } from "vitest";

import * as client from "../index.js";
import * as reactAdapter from "../react/index.js";

describe("@repo/orpc-ws-client smoke", () => {
  it("the package's main entry resolves to a module", () => {
    expect(client).toBeTypeOf("object");
  });

  it("the React adapter sub-path resolves to a module", () => {
    expect(reactAdapter).toBeTypeOf("object");
  });

  it("runs in a DOM-capable environment (happy-dom)", () => {
    // Sanity: the client core compiles against `lib: DOM`; the test runner
    // is configured with happy-dom so future tests have window/document.
    expect(typeof globalThis.WebSocket).toBe("function");
  });
});
