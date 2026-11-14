import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const lane = process.argv[2] ?? "release";
if (!["release", "smoke", "cross", "visual"].includes(lane)) {
  throw new Error(`Unknown Calendar browser QA lane: ${lane}`);
}
const cli = fileURLToPath(new URL("../../node_modules/@playwright/test/cli.js", import.meta.url));
const result = spawnSync(process.execPath, [cli, "test", "--config=playwright.config.mjs", ...process.argv.slice(3)], {
  stdio: "inherit",
  env: { ...process.env, CALENDAR_QA_LANE: lane },
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
