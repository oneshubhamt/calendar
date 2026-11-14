import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

async function sourceFiles(directory) {
  const files = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(absolute));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(absolute);
  }
  return files;
}

const normalized = value => path.resolve(value).split(path.sep).join("/");

function traceResolutionGraph(trace, sourceRoot, knownPaths) {
  const graph = new Map([...knownPaths.values()].map(id => [id, { imports: new Set(), externals: new Set() }]));
  let request = null;
  for (const line of trace.split(/\r?\n/u)) {
    const begin = /Resolving module ['"]([^'"]+)['"] from ['"]([^'"]+)['"]/u.exec(line);
    if (begin) {
      request = { specifier: begin[1], from: normalized(begin[2]) };
      continue;
    }
    if (request === null) continue;
    const resolved = /Module name ['"][^'"]+['"] was successfully resolved to ['"]([^'"]+)['"]/u.exec(line);
    if (resolved) {
      const fromId = knownPaths.get(request.from);
      const targetId = knownPaths.get(normalized(resolved[1]));
      if (fromId !== undefined) {
        if (targetId !== undefined) graph.get(fromId).imports.add(targetId);
        else if (!request.specifier.startsWith(".")) graph.get(fromId).externals.add(request.specifier);
      }
      request = null;
      continue;
    }
    if (/Module name ['"][^'"]+['"] was not resolved/u.test(line)) {
      const fromId = knownPaths.get(request.from);
      if (fromId !== undefined && !request.specifier.startsWith(".")) graph.get(fromId).externals.add(request.specifier);
      request = null;
    }
  }
  return graph;
}

export async function loadSourceModuleGraph(sourceRootUrl) {
  const sourceRoot = fileURLToPath(sourceRootUrl);
  const repoRoot = path.resolve(sourceRoot, "..");
  const files = await sourceFiles(sourceRoot);
  const knownPaths = new Map(files.map(file => [normalized(file), path.relative(sourceRoot, file).split(path.sep).join("/")]));
  const tsc = path.join(repoRoot, "node_modules", "typescript", "lib", "tsc.js");
  const run = spawnSync(process.execPath, [tsc, "--project", path.join(repoRoot, "tsconfig.json"), "--noEmit", "--traceResolution"], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (run.error) throw run.error;
  const trace = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
  if (run.status !== 0) throw new Error(`TypeScript module-resolution trace failed with exit ${run.status}:\n${trace.slice(-4000)}`);
  const graph = traceResolutionGraph(trace, sourceRoot, knownPaths);
  if ([...graph.values()].every(entry => entry.imports.size === 0 && entry.externals.size === 0)) {
    throw new Error("TypeScript module-resolution trace produced no dependency edges");
  }
  return graph;
}
