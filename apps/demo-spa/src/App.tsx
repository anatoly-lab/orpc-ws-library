import type { ReactElement } from "react";
import { BrowserRouter, Route, Routes } from "react-router-dom";

import { AppLayout } from "./AppLayout.js";
import { Home } from "./pages/Home.js";
import { Callback } from "./pages/Callback.js";

export function App(): ReactElement {
  return (
    <BrowserRouter>
      <Routes>
        {/* AppLayout owns the auth/connect guard; every child route inherits
            it. Add future authed pages here and they are guarded for free. */}
        <Route element={<AppLayout />}>
          <Route path="/" element={<Home />} />
        </Route>
        {/* Callback stays OUTSIDE the layout: it establishes the session and
            must run pre-connection, ungated by the guard. */}
        <Route path="/auth/callback" element={<Callback />} />
      </Routes>
    </BrowserRouter>
  );
}
