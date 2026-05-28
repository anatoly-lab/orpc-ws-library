import { mergeConfig, defineConfig } from "vitest/config";

import baseConfig from "../../vitest.config.base.ts";

// Pure types + tiny default impls; no DOM needed.
export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      name: "@repo/orpc-ws-shared",
    },
  }),
);
