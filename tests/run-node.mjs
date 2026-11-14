import { globSync } from "node:fs";
import { spawnSync } from "node:child_process";

const lane = process.argv[2] ?? "full";
if (!["fast", "full"].includes(lane)) throw new Error(`Unknown Node QA lane: ${lane}`);

// One cross-platform entry point: discover exactly the domain-owned Node cases.
const paths = [...globSync("tests/node/**/*.test.mjs")].sort();
if (!paths.length) throw new Error("No Node QA tests discovered");
const result = spawnSync(process.execPath, ["--test", ...paths], {
  stdio: "inherit",
  env: { ...process.env, CALENDAR_QA_NODE_LANE: lane },
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
