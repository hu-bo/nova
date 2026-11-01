import ts from 'typescript';
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../src', import.meta.url));
async function walk(path) {
  const entries = await readdir(path, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map((entry) =>
        entry.isDirectory() ? walk(resolve(path, entry.name)) : resolve(path, entry.name),
      ),
    )
  ).flat();
}
const files = (await walk(root)).filter((file) => /\.tsx?$/.test(file));
const violations = [];
const forbidden =
  /(^@nnova\/harness(\/|$))|(^@nova\/(coding-harness|tools)(\/|$))|(^@nova\/(nova-server|runner-sdk|runner-protocol)(\/|$))|(^@nova\/casdoor\/server(\/|$))|(^node:)|(^nova-server(\/|$))|\/nova-server\//;
const clean = (path) =>
  path
    .replaceAll('\\', '/')
    .replace(/\.(tsx?|jsx?)$/, '')
    .replace(/\/index$/, '');
for (const file of files) {
  const name = clean(relative(root, file));
  const source = ts.createSourceFile(
    file,
    await readFile(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const imports = [];
  function visit(node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      imports.push(node.moduleSpecifier.text);
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        node.expression.getText(source) === 'require') &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    )
      imports.push(node.arguments[0].text);
    ts.forEachChild(node, visit);
  }
  visit(source);
  for (const specifier of imports) {
    if (forbidden.test(specifier)) violations.push(`${name}: browser-forbidden ${specifier}`);
    const target = specifier.startsWith('@/')
      ? clean(specifier.slice(2))
      : specifier.startsWith('.')
        ? clean(relative(root, resolve(dirname(file), specifier)))
        : null;
    if (!target) continue;
    const [fromLayer, fromFeature] = name.split('/');
    const [toLayer, toFeature, ...internals] = target.split('/');
    if (fromLayer === 'features' && ['app', 'routes'].includes(toLayer))
      violations.push(`${name}: reverse dependency ${specifier}`);
    if (
      ['api', 'lib', 'components'].includes(fromLayer) &&
      ['app', 'routes', 'features'].includes(toLayer)
    )
      violations.push(`${name}: reverse dependency ${specifier}`);
    if (
      toLayer === 'features' &&
      (fromLayer !== 'features' || fromFeature !== toFeature) &&
      internals.length &&
      // The app lifetime runtime has an explicit entry independent of route presentation.
      !(toFeature === 'runs' && internals.join('/') === 'runtime')
    )
      violations.push(`${name}: use feature public entry ${specifier}`);
    if (name.startsWith('components/ui/') && ['api', 'features', 'app', 'routes'].includes(toLayer))
      violations.push(`${name}: UI contains business dependency ${specifier}`);
  }
}
const features = (await readdir(resolve(root, 'features'), { withFileTypes: true })).filter(
  (entry) => entry.isDirectory(),
);
for (const feature of features) {
  try {
    await stat(resolve(root, 'features', feature.name, 'index.ts'));
  } catch {
    violations.push(`features/${feature.name}: missing index.ts`);
  }
}
if (violations.length) {
  console.error(violations.join('\n'));
  process.exitCode = 1;
} else
  console.log(`[boundaries] ${features.length} features, ${files.length} source files: passed`);
