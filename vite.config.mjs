import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

// the CLI spawns vite with CYCLOPS_DATA_PORT + CYCLOPS_OPEN; keep the old
// name working too so a hand-started `vite` still finds the data server.
const DATA_PORT = process.env.CYCLOPS_DATA_PORT || process.env.CYCLOPS_PORT || "4600";
const TARGET = `http://127.0.0.1:${DATA_PORT}`;
const OPEN = process.env.CYCLOPS_OPEN === "1";

export default defineConfig({
  root: "src/public",
  plugins: [react()],
  server: {
    port: 5173,
    // the CLI opens the browser; go straight to the React Flow entry, not the
    // Mermaid index.html that sits at the vite root
    open: OPEN ? "/vite.html" : false,
    proxy: {
      "/tree.json": { target: TARGET, changeOrigin: true },
      "/version": { target: TARGET, changeOrigin: true },
    },
  },
  build: {
    outDir: "../../dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, "src/public/index.html"),
        viewer: resolve(import.meta.dirname, "src/public/vite.html"),
      },
    },
  },
});
