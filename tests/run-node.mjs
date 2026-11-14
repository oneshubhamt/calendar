import { globSync } from "node:fs";
import { spawnSync } from "node:child_process";

// One cross-platform entry point: discover exactly the domain-owned Node cases.
const paths = [...globSync("tests/node/**/*.test.mjs")].sort();
if (!paths.length) throw new Error("No Node QA tests discovered");
const result = spawnSync(process.execPath, ["--test", ...paths], { stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
