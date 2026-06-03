import type { ReactElement } from "react";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { OidcCallback } from "@repo/orpc-ws-oidc-react/react-router";

import { AppLayout } from "./AppLayout.js";
import { Home } from "./pages/Home.js";
import { authClient } from "./lib/ws-client.js";

export function App(): ReactElement {
  return (
    <BrowserRouter>
      <Routes>
        {/* AppLayout owns the auth/connect guard; every child route inherits
            it. Add future authed pages here and they are guarded for free. */}
        <Route element={<AppLayout />}>
          <Route path="/" element={<Home />} />
        </Route>
        {/* The library's drop-in callback component handles the token exchange
            and navigates home on success. It stays OUTSIDE the layout: it
            establishes the session and must run pre-connection, ungated by the
            guard. */}
        <Route
          path="/auth/callback"
          element={<OidcCallback client={authClient} navigateTo="/" />}
        />
      </Routes>
    </BrowserRouter>
  );
}
