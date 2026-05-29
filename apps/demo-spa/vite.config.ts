import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Vite's `server` (dev) and `preview` ports are also pinned via the
// CLI in `package.json` scripts (`--port 5173 --strictPort` /
// `--port 4173 --strictPort`). Belt-and-suspenders here for the case
// where someone runs `npx vite` directly.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  preview: {
    port: 4173,
    strictPort: true,
  },
});
