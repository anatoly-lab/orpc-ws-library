import type { ReactElement } from "react";
import { BrowserRouter, Route, Routes } from "react-router-dom";

import { AppLayout } from "./AppLayout.js";
import { Home } from "./pages/Home.js";

export function App(): ReactElement {
  return (
    <BrowserRouter>
      <Routes>
        {/* AppLayout owns the /auth/me + connect guard; every child route
            inherits it. Add future authed pages here and they are guarded for
            free.

            There is NO `/auth/callback` route here (unlike the PKCE demo): in
            cookie-bff mode the SERVER handles the OIDC callback, sets the `sid`
            cookie, and 302s the browser straight back to "/". The SPA never
            sees an authorization code or a token. */}
        <Route element={<AppLayout />}>
          <Route path="/" element={<Home />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
