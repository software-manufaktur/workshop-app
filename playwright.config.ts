import { defineConfig, devices } from "@playwright/test";

// Ende-zu-Ende-Tests der Web-Version (gleicher Code wie die iOS-App, ohne native Teile).
// Vorher bauen: npm run build. Start: npm run e2e
export default defineConfig({
  testDir: "e2e",
  timeout: 30_000,
  fullyParallel: true,
  reporter: [["list"]],
  use: {
    ...devices["iPhone 13"],
    browserName: "chromium",
    baseURL: "http://localhost:4173",
    locale: "de-DE",
    timezoneId: "Europe/Berlin",
    launchOptions: process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {},
  },
  webServer: {
    command: "npx vite preview --port 4173 --strictPort",
    url: "http://localhost:4173",
    reuseExistingServer: true,
  },
});
