import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const backend = process.env.VITE_BACKEND ?? "http://127.0.0.1:8000";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: backend, ws: true, changeOrigin: true },
    },
  },
  build: { chunkSizeWarningLimit: 6000, sourcemap: false },
});
