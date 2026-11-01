import { config } from "dotenv";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { serverRoot } from "./paths.js";

if (process.platform === "win32") {
  // Node emits UTF-8; Windows consoles may otherwise decode it using a legacy code page.
  // Services without an attached console can safely ignore an unsuccessful chcp.
  spawnSync("chcp.com", ["65001"], { stdio: "ignore", windowsHide: true });
}

config({ path: resolve(serverRoot, ".env") });
