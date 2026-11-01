import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const file = path.join(directory, entry.name);
      return entry.isDirectory() ? walk(file) : [file];
    }),
  );
  return nested.flat().filter((file) => /\.(ts|tsx)$/.test(file));
}

const forbidden = /\b(fetch|EventSource|localStorage|sessionStorage)\b/;
const files = await walk("src");
const errors = [];

for (const file of files) {
  const source = await readFile(file, "utf8");
  if (forbidden.test(source)) errors.push(`${file}: transport or persistence API is not allowed`);
  if (/from\s+["']@nova\/(?!agent-ui-contracts["'])/.test(source))
    errors.push(`${file}: runtime package dependency leaked into chat-ui`);
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Chat UI dependency boundary passed (${files.length} source files).`);
}
