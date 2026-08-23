import { chmod, copyFile, mkdir } from "node:fs/promises";
import { arch, platform } from "node:process";
import { join, resolve } from "node:path";

const source = process.env.NOVA_RUNNER_BINARY;
if (!source) throw new Error("NOVA_RUNNER_BINARY must point to a built nova-runner executable");

const target = process.env.NOVA_RUNNER_TARGET ?? `${platform}-${arch}`;
const extension = target.startsWith("win32-") ? ".exe" : "";
const destination = resolve("vendor", target, `nova-runner${extension}`);
await mkdir(join("vendor", target), { recursive: true });
await copyFile(resolve(source), destination);
if (!target.startsWith("win32-")) await chmod(destination, 0o755);
console.log(`staged ${target}: ${destination}`);
