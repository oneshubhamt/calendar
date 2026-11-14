import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const config = JSON.parse(readFileSync(join(root, "tsconfig.package.json"), "utf8"));
const snapshotPath = join(root, "node_modules/.cache/calendar-qa-package-baseline.json");
const excluded = ["src/demo/**", "src/fixtures/**"];

function verifyConfiguration() {
  assert.equal(config.extends, "./tsconfig.json", "publication must extend the same strict compiler options");
  assert.deepEqual([...config.exclude].sort(), [...excluded].sort(), "publication exclusion policy changed; audit must be updated");
  assert.ok(existsSync(join(root, "dist/index.js")), "build before package audit");
}

function outputs({ excludeFixtureTrees = false } = {}) {
  const out = new Map();
  function visit(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name);
      const path = relative(root, absolute).split(sep).join("/");
      if (excludeFixtureTrees && (path === "dist/demo" || path === "dist/fixtures")) continue;
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) out.set(path, createHash("sha256").update(readFileSync(absolute)).digest("hex"));
    }
  }
  visit(join(root, "dist"));
  return Object.fromEntries([...out].sort(([a], [b]) => a.localeCompare(b)));
}

function prepare() {
  verifyConfiguration();
  for (const name of ["demo", "fixtures"]) {
    const path = join(root, "dist", name);
    assert.ok(existsSync(path), `full development build missing expected ${name} output`);
    rmSync(path, { recursive: true, force: true });
  }
  assert.ok(existsSync(join(root, "dist/index.js")), "preparation must not delete package entry");
  console.log("Publication-only artifacts prepared from the common full build");
}

function snapshot() {
  verifyConfiguration();
  mkdirSync(dirname(snapshotPath), { recursive: true });
  writeFileSync(snapshotPath, JSON.stringify(outputs({ excludeFixtureTrees: true })));
  console.log("Recorded production output hashes before native publication compilation");
}

function compare() {
  verifyConfiguration();
  const expected = JSON.parse(readFileSync(snapshotPath, "utf8"));
  assert.deepEqual(outputs(), expected,
    "package compiler output differs from the common full build after excluding demo and fixtures");
  rmSync(snapshotPath, { force: true });
  console.log(`Byte-for-byte package compilation parity: ${Object.keys(expected).length} files`);
}

function verify() {
  verifyConfiguration();
  const child = spawnSync("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], {
    cwd: root, encoding: "utf8", maxBuffer: 10 * 1024 * 1024,
  });
  if (child.error) throw child.error;
  assert.equal(child.status, 0, `npm pack manifest failed: ${child.stderr || child.stdout}`);
  // npm 12 may return one package object rather than an array for dry-run JSON.
  const parsed = JSON.parse(child.stdout);
  const manifest = Array.isArray(parsed) ? parsed[0] : parsed;
  assert.ok(Array.isArray(manifest?.files), "npm pack returned no manifest");
  const files = new Set(manifest.files.map(file => file.path));
  assert.ok(files.has("package.json") && files.has("README.md"), "publication metadata missing");
  assert.ok(files.has("docs/ARCHITECTURE.md"), "published architecture contract missing");
  for (const file of files) {
    assert.ok(
      file === "package.json" || file === "README.md" || file === "docs/ARCHITECTURE.md" || file.startsWith("dist/"),
      `unexpected published file: ${file}`,
    );
    assert.ok(!file.startsWith("dist/demo/") && !file.startsWith("dist/fixtures/"),
      `test/demo leakage in published package: ${file}`);
  }
  for (const [subpath, targets] of Object.entries(pkg.exports)) {
    for (const target of ["types", "import"]) {
      const file = targets[target]?.replace(/^\.\//, "");
      assert.ok(file && files.has(file), `missing ${subpath} ${target} in published archive: ${file}`);
    }
  }
  console.log(`Verified npm publication manifest: ${files.size} files, ${Object.keys(pkg.exports).length} exported subpaths`);
}

switch (process.argv[2]) {
  case "prepare": prepare(); break;
  case "snapshot": snapshot(); break;
  case "compare": compare(); break;
  case "verify": verify(); break;
  default: throw new Error("Usage: package-audit.mjs prepare|snapshot|compare|verify");
}
