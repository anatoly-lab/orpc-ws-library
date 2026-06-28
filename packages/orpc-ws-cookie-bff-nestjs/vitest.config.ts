import { mergeConfig, defineConfig } from "vitest/config";

import nestjsConfig from "../../vitest.config.nestjs.ts";

export default mergeConfig(
  nestjsConfig,
  defineConfig({
    test: {
      name: "@orpc-ws/cookie-bff-nestjs",
    },
  }),
);
