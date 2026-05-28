// Vitest setup for the client package's test suite.
//
// Pulls in `@testing-library/jest-dom`'s vitest entry so the React-adapter
// tests can use matchers like `toBeInTheDocument`. Lives under `src/__tests__/`
// (not the package root) so it's covered by the same lint + tsconfig that
// owns the rest of the test code.
//
// `@testing-library/react` does NOT auto-cleanup with vitest (it does
// with jest's `--testEnvironment=jsdom` because jest globals are
// auto-detected). We wire `cleanup()` to `afterEach` here so individual
// tests don't have to remember. This is the official RTL recommendation
// for vitest setups.

import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

import "@testing-library/jest-dom/vitest";

afterEach(() => {
  cleanup();
});
