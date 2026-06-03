// Sub-path barrel for the React Router binding.
//
// Compiles to `dist/react-router/index.js`, surfaced via the package's
// `"./react-router"` export. Importing this entry pulls in react-router-dom
// (the package's OPTIONAL peer); the main entry never does.

export { OidcCallback } from "./oidc-callback.js";
export type { OidcCallbackProps } from "./oidc-callback.js";
