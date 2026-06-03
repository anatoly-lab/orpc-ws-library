// Shared inline styles for the demo's top-level screens.
//
// Extracted so Home and SignIn share one source of truth — the signed-out
// and signed-in screens used to define these inline in the same Home file;
// splitting SignIn out would otherwise duplicate them and let the two drift.

import type { CSSProperties } from "react";

export const containerStyle: CSSProperties = {
  maxWidth: 600,
  margin: "2rem auto",
  padding: "1rem",
  fontFamily: "system-ui, sans-serif",
};

export const buttonStyle: CSSProperties = {
  padding: "0.5rem 1rem",
  fontSize: "1rem",
  cursor: "pointer",
};
