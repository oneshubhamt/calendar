import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";

const staticString = node => ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);

async function sourceFiles(directory) {
  const files = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(absolute));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(absolute);
  }
  return files;
}

function collectModuleSpecifiers(fileName, source) {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const specifiers = [];
  const visit = node => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && staticString(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)
      && node.moduleReference.expression && staticString(node.moduleReference.expression)) {
      specifiers.push(node.moduleReference.expression.text);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments.length === 1 && staticString(node.arguments[0])) {
      specifiers.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return specifiers;
}

function resolveInternalSpecifier(fromId, specifier, knownIds) {
  if (!specifier.startsWith(".")) return null;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromId), specifier));
  const candidates = base.endsWith(".js")
    ? [`${base.slice(0, -3)}.ts`]
    : base.endsWith(".ts")
      ? [base]
      : [`${base}.ts`, `${base}/index.ts`];
  return candidates.find(candidate => knownIds.has(candidate)) ?? candidates[0];
}

export async function loadSourceModuleGraph(sourceRootUrl) {
  const sourceRoot = fileURLToPath(sourceRootUrl);
  const paths = await sourceFiles(sourceRoot);
  const ids = new Set(paths.map(file => path.relative(sourceRoot, file).split(path.sep).join("/")));
  const graph = new Map();
  for (const file of paths) {
    const id = path.relative(sourceRoot, file).split(path.sep).join("/");
    const source = await fs.readFile(file, "utf8");
    const imports = new Set();
    const externals = new Set();
    for (const specifier of collectModuleSpecifiers(file, source)) {
      const resolved = resolveInternalSpecifier(id, specifier, ids);
      if (resolved === null) externals.add(specifier);
      else {
        if (!ids.has(resolved)) throw new Error(`${id} has unresolved internal dependency ${specifier} -> ${resolved}`);
        imports.add(resolved);
      }
    }
    graph.set(id, { imports, externals });
  }
  return graph;
}
