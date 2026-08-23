#!/usr/bin/env node

import { accessSync, constants } from "node:fs";
import { platform, arch } from "node:process";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const target = `${platform}-${arch}`;
const extension = platform === "win32" ? ".exe" : "";
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const binary = process.env.NOVA_RUNNER_BIN ?? join(packageRoot, "vendor", target, `nova-runner${extension}`);

try {
  accessSync(binary, constants.X_OK);
} catch {
  console.error(`@nova/runner: no nova-runner binary is available for ${target}.`);
  console.error(`Expected: ${binary}`);
  console.error("Install a package version containing this platform or set NOVA_RUNNER_BIN to a compatible binary.");
  process.exit(1);
}

const child = spawn(binary, process.argv.slice(2), { stdio: "inherit", windowsHide: false });
child.on("error", (error) => {
  console.error(`@nova/runner: failed to start ${binary}: ${error.message}`);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  if (signal !== null) {
    process.kill(process.pid, signal);
  } else {
    process.exit(code ?? 1);
  }
});
