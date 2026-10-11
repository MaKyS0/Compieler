import { defineConfig } from "@playwright/test";
import { existsSync, mkdtempSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = Number(process.env.E2E_PORT ?? 8765);
const data = mkdtempSync(join(tmpdir(), "cmp-e2e-"));
chmodSync(data, 0o711);
const python = process.env.E2E_PYTHON ?? "python3";
const chrome = ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome", process.env.CHROME_PATH ?? ""].find((p) => p && existsSync(p));

export default defineConfig({
  testDir: "./tests",
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    launchOptions: chrome ? { executablePath: chrome, args: ["--no-sandbox"] } : {},
    screenshot: "only-on-failure",
    trace: "off",
  },
  outputDir: "./test-results",
  webServer: {
    command: `${python} -m uvicorn app.main:app --host 127.0.0.1 --port ${PORT} --log-level warning`,
    cwd: "../backend",
    url: `http://127.0.0.1:${PORT}/api/health`,
    timeout: 60_000,
    reuseExistingServer: false,
    env: {
      COMPIELER_DATA_DIR: data,
      COMPIELER_STATIC_DIR: join(__dirname, "../frontend/dist"),
      COMPIELER_SANDBOX_BACKEND: process.env.COMPIELER_SANDBOX_BACKEND ?? "local",
      COMPIELER_RUN_WALL_SECONDS: "30",
      PYTHONPATH: "../backend",
    },
  },
  projects: [
    { name: "desktop", use: { viewport: { width: 1360, height: 820 } } },
    { name: "phone", testMatch: /mobile\.spec\.ts/, use: { viewport: { width: 390, height: 780 }, hasTouch: true, isMobile: true } },
  ],
});
