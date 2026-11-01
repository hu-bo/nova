import { readdir } from "node:fs/promises";
import { spawn } from "node:child_process";

async function discover(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) => {
      const file = `${directory}/${entry.name}`;
      return entry.isDirectory() ? discover(file) : file.endsWith(".test.ts") ? [file] : [];
    }),
  );
  return files.flat().sort();
}
const tests = await discover("tests");
if (!tests.length) throw new Error("No framework tests discovered");
const child = spawn(process.execPath, ["--import", "tsx", "--test", "--test-concurrency=1", ...tests], {
  stdio: "inherit",
  shell: false,
  windowsHide: true,
});
child.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.on("close", (code) => {
  process.exitCode = code ?? 1;
});
