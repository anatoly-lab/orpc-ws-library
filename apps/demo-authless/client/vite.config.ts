import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Vite's `server` (dev) and `preview` ports are also pinned via the CLI in
// `package.json` scripts (`--port 5176 --strictPort` / `--port 4176
// --strictPort`). Belt-and-suspenders here for the case where someone runs
// `pnpm exec vite` directly.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: 5176,
    strictPort: true,
  },
  preview: {
    port: 4176,
    strictPort: true,
  },
});
