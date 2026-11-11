import base from "./playwright.config.mjs";

export default {
  ...base,
  reporter: "line",
  projects: [
    {
      name: "chrome-resource-qa",
      use: {
        browserName: "chromium",
        channel: "chrome",
        viewport: { width: 1440, height: 1000 },
      },
    },
  ],
};
