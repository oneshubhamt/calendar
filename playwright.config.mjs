import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:4173";

// Routine smoke runs broad Chromium evidence plus the selective @cross subset in all engines.
// Release is exhaustive: every nonvisual browser contract runs in Chromium, Firefox and WebKit,
// while reviewed visual baselines remain Chromium-only.
const lane = process.env.CALENDAR_QA_LANE ?? "release";
if (!["release", "smoke", "cross", "visual"].includes(lane)) {
  throw new Error(`Unknown Calendar browser QA lane: ${lane}`);
}
const chromiumGrep = lane === "smoke" ? /@smoke|@cross/
  : lane === "cross" ? /@cross/
    : lane === "visual" ? /@visual/ : undefined;
const otherGrep = lane === "release" ? /@release/ : /@cross/;


export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: false,
  workers: process.env.CI ? 1 : undefined,
  retries: process.env.CI ? 1 : 0,
  timeout: 30_000,
  expect: {
    timeout: 5_000,
    toHaveScreenshot: {
      animations: "disabled",
      caret: "hide",
      maxDiffPixelRatio: 0.001,
    },
  },
  reporter: process.env.CI
    ? [["line"], ["html", { open: "never", outputFolder: "playwright-report" }]]
    : "line",
  use: {
    baseURL,
    locale: "en-US",
    timezoneId: "UTC",
    colorScheme: "light",
    reducedMotion: "reduce",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "node tests/browser/server.mjs",
    url: `${baseURL}/tests/browser/harness.html`,
    reuseExistingServer: !process.env.CI,
    timeout: 10_000,
  },
  snapshotPathTemplate: "{testDir}/__screenshots__/{arg}{ext}",
  projects: [
    {
      name: "chromium",
      grep: chromiumGrep,
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 1000 } },
    },
    ...lane === "visual" ? [] : [
      {
        name: "firefox",
        grep: otherGrep,
        testIgnore: "**/visual.spec.mjs",
        use: { ...devices["Desktop Firefox"], viewport: { width: 1440, height: 1000 } },
      },
      {
        name: "webkit",
        grep: otherGrep,
        testIgnore: "**/visual.spec.mjs",
        use: { ...devices["Desktop Safari"], viewport: { width: 1440, height: 1000 } },
      },
    ],
  ],
});
