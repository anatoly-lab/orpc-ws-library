import { mergeConfig, defineConfig } from "vitest/config";

import baseConfig from "../../vitest.config.base.ts";

// happy-dom: the React bindings need a DOM (useSyncExternalStore + RTL
// render). happy-dom is lighter and faster than jsdom for these assertions
// (see CLAUDE.md "Test runner: vitest").
//
// `.tsx` added to the include glob so the React-adapter test files are
// discovered. The base config only globs `.ts` because most packages have
// no JSX.
//
// `setupFiles` pulls in jest-dom's vitest matchers (toBeInTheDocument, etc.).
export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      name: "@repo/orpc-ws-oidc-react",
      environment: "happy-dom",
      include: [
        "src/**/*.test.ts",
        "src/**/*.test.tsx",
        "src/**/__tests__/**/*.test.ts",
        "src/**/__tests__/**/*.test.tsx",
      ],
      setupFiles: ["./src/__tests__/setup.ts"],
    },
  }),
);
