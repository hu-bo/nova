import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import type { CodingHarnessOptions, PlanGateOptions } from "./contracts.js";
import { chatProfile, codingProfile } from "./profiles.js";

export function positiveInteger(value: number, name: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${name} must be a positive integer no greater than ${maximum}.`);
  }
  return value;
}

/** Uses Runner path syntax, independent of the Server's operating system. */
export function relativePath(value: string): string | undefined {
  const path = value.replaceAll("\\", "/");
  if (!path || path.includes("\0") || posix.isAbsolute(path) || /^[a-zA-Z]:/.test(path)) return undefined;
  const normalized = posix.normalize(path);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../") || normalized.endsWith("/"))
    return undefined;
  return normalized;
}

export function resolveConfiguration(options: CodingHarnessOptions) {
  const hasRunner = options.session !== undefined;
  if (
    hasRunner !== (options.workspaceId !== undefined) ||
    (!hasRunner && (options.cwd !== undefined || options.createContext !== undefined))
  ) {
    throw new TypeError("Remote execution requires both session and workspaceId.");
  }
  if (
    hasRunner &&
    (!options.workspaceId?.trim() ||
      !options.session.workspaces.some((workspace) => workspace.workspaceId === options.workspaceId))
  ) {
    throw new TypeError("workspaceId must identify a workspace registered by the supplied Runner.");
  }
  const profile = options.profile ?? (hasRunner ? codingProfile : chatProfile);
  if (typeof profile.systemPrompt !== "string" || !profile.systemPrompt.trim()) {
    throw new TypeError("The profile must provide a non-empty systemPrompt.");
  }
  let plan: Required<PlanGateOptions> | undefined;
  if (options.planAlreadyAccepted !== undefined && !profile.plan) {
    throw new TypeError("planAlreadyAccepted requires a profile with a plan gate.");
  }
  if (profile.plan) {
    if (!hasRunner) throw new TypeError("A plan-file gate requires a Runner execution environment.");
    const path = relativePath(profile.plan.path ?? "plan.md");
    if (!path) throw new TypeError("The plan path must be a workspace-relative file path.");
    const alreadyWritten = profile.plan.alreadyWritten ?? options.planAlreadyAccepted ?? false;
    if (typeof alreadyWritten !== "boolean") throw new TypeError("Plan restoration state must be a boolean.");
    if (
      profile.plan.alreadyWritten !== undefined &&
      options.planAlreadyAccepted !== undefined &&
      profile.plan.alreadyWritten !== options.planAlreadyAccepted
    ) {
      throw new TypeError("Conflicting plan restoration options.");
    }
    plan = { path, alreadyWritten };
  }
  return {
    sessionId: options.sessionId ?? randomUUID(),
    systemPrompt: [
      profile.systemPrompt,
      plan
        ? `Configured plan file: ${plan.path}\nInitial plan state: ${plan.alreadyWritten ? "prior successful write confirmed by the host; reuse the existing plan" : "no confirmed write yet"}.`
        : "",
      options.instructions ?? "",
    ]
      .filter(Boolean)
      .join("\n\n"),
    plan,
    maxRunMs: positiveInteger(options.maxRunMs ?? 15 * 60_000, "maxRunMs", 2_147_483_647),
    maxSteps: positiveInteger(options.maxSteps ?? 64, "maxSteps"),
    maxToolCalls: positiveInteger(options.maxToolCalls ?? 64, "maxToolCalls"),
    maxParallelReads: positiveInteger(options.maxParallelReads ?? 4, "maxParallelReads"),
    maxParallelWrites: positiveInteger(options.maxParallelWrites ?? 1, "maxParallelWrites"),
    maxToolOutputBytes: positiveInteger(options.maxToolOutputBytes ?? 100_000, "maxToolOutputBytes"),
  };
}
