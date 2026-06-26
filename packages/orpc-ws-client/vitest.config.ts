import { mergeConfig, defineConfig } from "vitest/config";

import baseConfig from "../../vitest.config.base.ts";

// happy-dom: the client core is browser-targeted (WebSocket, matchMedia in
// the sleep detector, etc.) and several core tests touch window/document
// globals, so the runner needs a DOM (see CLAUDE.md "Test runner: vitest").
// happy-dom is lighter and faster than jsdom for these assertions.
//
// No `setupFiles` and no `.tsx` globs: the React adapter lives in the
// sibling `@orpc-ws/react`, so this core has no JSX tests or
// jest-dom matchers.
export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      name: "@orpc-ws/client",
      environment: "happy-dom",
    },
  }),
);
