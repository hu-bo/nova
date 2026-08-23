import { access } from "node:fs/promises";
import { resolve } from "node:path";

const targets = ["linux-x64", "darwin-x64", "darwin-arm64", "win32-x64"];
for (const target of targets) {
  const extension = target.startsWith("win32-") ? ".exe" : "";
  await access(resolve("vendor", target, `nova-runner${extension}`));
}
