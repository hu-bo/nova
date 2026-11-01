import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generate } from 'orval';

const root = fileURLToPath(new URL('../src/api/generated', import.meta.url));
async function snapshot(directory: string, prefix = ''): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return files;
    throw error;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    const name = `${prefix}${entry.name}`;
    if (entry.isDirectory()) {
      for (const [key, content] of await snapshot(path, `${name}/`)) files.set(key, content);
    } else files.set(name, await readFile(path, 'utf8'));
  }
  return files;
}

const before = await snapshot(root);
await generate(fileURLToPath(new URL('../orval.config.ts', import.meta.url)));
const after = await snapshot(root);
const changed = [...new Set([...before.keys(), ...after.keys()])].filter(
  (file) => before.get(file) !== after.get(file),
);
if (changed.length) {
  console.error(`Generated API drift detected (files regenerated):\n${changed.join('\n')}`);
  process.exitCode = 1;
} else console.log('Generated API matches nova-server/openapi.json.');
