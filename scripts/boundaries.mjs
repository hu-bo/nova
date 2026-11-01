import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map((entry) =>
        entry.isDirectory()
          ? walk(path.join(directory, entry.name))
          : [path.join(directory, entry.name)],
      ),
    )
  ).flat();
}
const files = (await walk("src")).filter((file) => file.endsWith(".ts"));
const graph = new Map();
const errors = [];
const layer = (file) => file.replaceAll("\\", "/").split("/");
for (const file of files) {
  const ast = ts.createSourceFile(
    file,
    await readFile(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const references = [];
  function visit(node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      references.push(node.moduleSpecifier.text);
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    )
      references.push(node.arguments[0].text);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  const targets = [];
  for (const reference of references) {
    const from = layer(file);
    if (!reference.startsWith(".")) {
      if (
        (from[1] === "contracts" || from[1] === "kernel") &&
        !reference.startsWith("node:") &&
        reference !== "zod"
      )
        errors.push(`${file}: external dependency ${reference}`);
      if (
        /^(ai|@ai-sdk\/|@modelcontextprotocol\/)/.test(reference) &&
        !["model-ai-sdk", "mcp"].includes(from[2])
      )
        errors.push(`${file}: adapter dependency leaked: ${reference}`);
      continue;
    }
    const target = path.normalize(
      path.join(path.dirname(file), reference.replace(/\.js$/, ".ts")),
    );
    targets.push(target);
    const to = layer(target);
    if (from[1] === "contracts" && to[1] !== "contracts")
      errors.push(`${file}: contract depends on ${target}`);
    if (
      from[1] === "kernel" &&
      !["contracts", "kernel", "shared"].includes(to[1])
    )
      errors.push(`${file}: kernel depends on ${target}`);
    if (from[1] === "plugins" && to[1] === "kernel")
      errors.push(`${file}: plugin imports kernel implementation`);
    if (from[1] === "plugins" && to[1] === "plugins" && from[2] !== to[2])
      errors.push(`${file}: imports another plugin implementation: ${target}`);
    if (from[1] === "shared" && !["shared", "contracts"].includes(to[1]))
      errors.push(`${file}: shared layer depends on ${target}`);
  }
  graph.set(file, targets);
}
const visited = new Set();
const active = [];
function visit(file) {
  const index = active.indexOf(file);
  if (index >= 0) {
    errors.push(`Cycle: ${[...active.slice(index), file].join(" -> ")}`);
    return;
  }
  if (visited.has(file)) return;
  active.push(file);
  for (const target of graph.get(file) ?? []) visit(target);
  active.pop();
  visited.add(file);
}
for (const file of files) visit(file);
if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else
  console.log(`Dependency boundaries passed (${files.length} source files).`);
