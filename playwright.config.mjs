import { defineConfig, devices } from "@playwright/test";

const baseURL = "http://127.0.0.1:4173";

// Release runs every browser contract once in Chromium. The explicit @cross subset
// is the selective multi-engine witness in Firefox and WebKit; visual baselines stay Chromium-only.
// Other lanes select the same stable scenario tags without depending on filenames or declaration order.
const lane = process.env.CALENDAR_QA_LANE ?? "release";
if (!["release", "smoke", "cross", "visual"].includes(lane)) {
  throw new Error(`Unknown Calendar browser QA lane: ${lane}`);
}
const chromiumGrep = lane === "smoke" ? /@smoke|@cross/
  : lane === "cross" ? /@cross/
    : lane === "visual" ? /@visual/ : undefined;
const otherGrep = /@cross/;


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
