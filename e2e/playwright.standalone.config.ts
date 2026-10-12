import { defineConfig } from "@playwright/test";
import { existsSync } from "node:fs";

const PORT = Number(process.env.E2E_PORT ?? 4173);
const chrome = ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome", process.env.CHROME_PATH ?? ""].find((p) => p && existsSync(p));

// The offline app: no backend at all. Engines run in WebAssembly inside the browser.
export default defineConfig({
  testDir: "./standalone",
  timeout: 120_000,
  expect: { timeout: 60_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 1360, height: 820 },
    acceptDownloads: true,
    launchOptions: chrome ? { executablePath: chrome, args: ["--no-sandbox"] } : {},
    screenshot: "only-on-failure",
  },
  outputDir: "./test-results-standalone",
  webServer: {
    command: `npx vite preview --mode standalone --outDir dist-standalone --port ${PORT} --host 127.0.0.1 --strictPort`,
    cwd: "../frontend",
    url: `http://127.0.0.1:${PORT}/`,
    timeout: 60_000,
    reuseExistingServer: false,
  },
});
