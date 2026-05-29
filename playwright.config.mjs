import { defineConfig, devices } from "@playwright/test";
import { existsSync } from "node:fs";

const hasSystemChrome = existsSync("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
const chromiumBrowser = {
  browserName: "chromium",
  ...(hasSystemChrome ? { channel: "chrome" } : {}),
};

export default defineConfig({
  testDir: "./tests",
  testMatch: /.*\.spec\.mjs/,
  fullyParallel: true,
  reporter: "list",
  use: {
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium-desktop",
      use: {
        ...devices["Desktop Chrome"],
        ...chromiumBrowser,
        viewport: { width: 1280, height: 1100 },
      },
    },
    {
      name: "chromium-mobile",
      use: {
        ...chromiumBrowser,
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
      },
    },
  ],
});
