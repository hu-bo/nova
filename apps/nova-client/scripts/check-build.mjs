import { readFile, readdir } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const manifest = JSON.parse(await readFile(resolve(dist, '.vite/manifest.json'), 'utf8'));
const entry = Object.keys(manifest).find((key) => manifest[key].isEntry);
if (!entry) throw new Error('No production entry found');
const initial = new Set();
function collect(key) {
  if (initial.has(key)) return;
  initial.add(key);
  for (const imported of manifest[key].imports ?? []) collect(imported);
}
collect(entry);
const bytes = (
  await Promise.all(
    [...initial].map(
      async (key) => gzipSync(await readFile(resolve(dist, manifest[key].file))).byteLength,
    ),
  )
).reduce((sum, size) => sum + size, 0);
console.log(`[build] initial static JS: ${(bytes / 1024).toFixed(1)} KiB gzip`);
for (const key of Object.keys(manifest)) if (key.includes('conversation.page')) collect(key);
const homeBytes = (
  await Promise.all(
    [...initial].map(
      async (key) => gzipSync(await readFile(resolve(dist, manifest[key].file))).byteLength,
    ),
  )
).reduce((sum, size) => sum + size, 0);
console.log(
  `[build] authenticated conversation home: ${(homeBytes / 1024).toFixed(1)} KiB gzip`,
);
for (const file of await readdir(resolve(dist, 'assets'))) {
  if (!file.endsWith('.js')) continue;
  const content = await readFile(resolve(dist, 'assets', file), 'utf8');
  if (
    /dev:00000000|请输入有效的开发令牌|开发令牌|运行诊断/.test(content) ||
    /dev-login/i.test(file)
  )
    throw new Error(`Development-only UI leaked into ${file}`);
}
console.log('[build] development login and diagnostics excluded');
