import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const backend = process.env.VITE_BACKEND ?? "http://127.0.0.1:8000";
// SharedArrayBuffer (blocking stdin for the on-device engines) needs a cross-origin isolated page.
const isolation = { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" };

export default defineConfig(({ mode }) => {
  const standalone = mode === "standalone";
  return {
    // standalone = offline app (APK / static hosting): relative URLs, engines from public/engines
    base: process.env.VITE_BASE ?? (standalone ? "./" : "/"),
    publicDir: standalone ? "public" : false,
    plugins: [react()],
    // The JavaScript engine uses npm ports of Node core modules; the trailing slash selects the package, not the (externalised) builtin.
    resolve: {
      alias: standalone
        ? { buffer: "buffer/", events: "events/", util: "util/", assert: "assert/", url: "url/", querystring: "querystring/", string_decoder: "string_decoder/" }
        : {},
    },
    worker: { format: "es" as const },
    optimizeDeps: { exclude: ["pyodide"] },
    server: {
      port: 5173,
      headers: isolation,
      proxy: standalone ? undefined : { "/api": { target: backend, ws: true, changeOrigin: true } },
    },
    preview: { headers: isolation },
    build: { chunkSizeWarningLimit: 8000, sourcemap: false, target: "es2022" },
  };
});
