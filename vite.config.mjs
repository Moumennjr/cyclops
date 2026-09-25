import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

// `npm run dev` serves the viewer on 5173 and proxies the trace to the data
// server on 4600; the CLI itself never starts this (it serves the built dist/).
const DATA_PORT = process.env.CYCLOPS_DATA_PORT || process.env.CYCLOPS_PORT || "4600";
const TARGET = `http://127.0.0.1:${DATA_PORT}`;
const OPEN = process.env.CYCLOPS_OPEN === "1";

export default defineConfig({
  root: "src/public",
  plugins: [react()],
  server: {
    port: 5173,
    open: OPEN ? "/" : false,
    proxy: {
      "/tree.json": { target: TARGET, changeOrigin: true },
      "/version": { target: TARGET, changeOrigin: true },
    },
  },
  build: {
    outDir: "../../dist",
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(import.meta.dirname, "src/public/index.html"),
    },
  },
});
