import type { ReactElement } from "react";
import { BrowserRouter, Route, Routes } from "react-router-dom";

import { Home } from "./pages/Home.js";
import { Callback } from "./pages/Callback.js";

export function App(): ReactElement {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/auth/callback" element={<Callback />} />
      </Routes>
    </BrowserRouter>
  );
}
