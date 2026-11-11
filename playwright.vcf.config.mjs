import { defineConfig, devices } from "@playwright/test";
import base from "./playwright.config.mjs";

export default defineConfig({
  ...base,
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        channel: "chrome",
        viewport: { width: 1440, height: 1000 },
      },
    },
  ],
});
