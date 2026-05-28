import { mergeConfig, defineConfig } from "vitest/config";

import baseConfig from "../../vitest.config.base.ts";

// happy-dom: the client core ships browser-targeted (WebSocket, etc.) and
// the React sub-path needs a DOM. happy-dom is lighter and faster than
// jsdom for the assertions we'll make (see CLAUDE.md "Test runner: vitest").
//
// `.tsx` extension added to the include glob so the React-adapter test
// files (under `src/react/__tests__/`) are discovered. The base config
// only globs `.ts` because most packages have no JSX.
//
// `setupFiles` pulls in jest-dom's vitest matchers (toBeInTheDocument, etc.).
export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      name: "@repo/orpc-ws-client",
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
