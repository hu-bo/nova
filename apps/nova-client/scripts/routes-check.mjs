import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = fileURLToPath(new URL('../', import.meta.url));
const path = fileURLToPath(new URL('../src/routeTree.gen.ts', import.meta.url));
const before = await readFile(path, 'utf8');
const result = spawnSync(
  process.execPath,
  [
    fileURLToPath(
      new URL('./bin/tsr.cjs', import.meta.resolve('@tanstack/router-cli/package.json')),
    ),
    'generate',
  ],
  { cwd: root, stdio: 'inherit' },
);
if (result.status !== 0) process.exit(result.status ?? 1);
if (before !== (await readFile(path, 'utf8')))
  throw new Error('Generated route drift detected (file regenerated)');
console.log('[routes] generated route tree is current');
