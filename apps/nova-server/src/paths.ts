import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
function findServerRoot(): string {
  let directory = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(resolve(directory, "package.json"))) {
    const parent = dirname(directory);
    if (parent === directory) throw new Error("Server package root not found");
    directory = parent;
  }
  return directory;
}
export const serverRoot = findServerRoot();
export const workspaceRoot = resolve(serverRoot, "../..");
