import path from "node:path";
import type { Project, ProjectInstructions } from "@nova/protocol";
import { invalidInput, runnerUnavailable } from "../../errors.js";
import type { AgentStore, ProjectRow } from "../../store.js";
import type { RunnerRegistry } from "../runner/registry.js";

const MAX_INSTRUCTION_FILE_SIZE = 64 * 1024;

export function createProjectService(store: AgentStore, runners: RunnerRegistry) {
  const view = (project: ProjectRow): Project => ({
    id: project.id,
    name: project.name,
    workspace: project.workspace,
    runnerId: project.runnerId,
    instructions: project.instructions,
    runnerState: runners.state(project.userId, project.runnerId, project.workspace),
    createdAt: project.createdAt.getTime(),
  });

  return {
    async create(userId: string, name: string) {
      return view(await store.createProject({ userId, name }));
    },
    async list(userId: string) {
      return Promise.all((await store.listProjects(userId)).map(view));
    },
    async rename(userId: string, id: string, name: string) {
      return view(await store.updateProject({ userId, id, name }));
    },
    async setInstructions(userId: string, id: string, instructions: ProjectInstructions) {
      const normalized = normalizeInstructions(instructions);
      await store.getProject({ userId, id });
      return view(await store.updateProjectInstructions({ userId, id, instructions: normalized }));
    },
    async bind(userId: string, id: string, runnerId: string, workspace: string) {
      await runners.verifyWorkspace(userId, runnerId, workspace);
      return view(await store.bindProject({ userId, id, runnerId, workspace }));
    },
    async remove(userId: string, id: string) {
      await store.deleteProject({ userId, id });
    },
  };
}

export async function loadProjectInstructions(
  project: ProjectRow,
  userId: string,
  runners: RunnerRegistry,
): Promise<string | undefined> {
  if (project.instructions.source === "none") return undefined;
  if (project.instructions.source === "custom") return project.instructions.content;
  if (project.instructions.source === "auto") {
    return (
      (await readInstructionFile(project, userId, runners, { source: "agents", directory: "." }, true)) ??
      (await readInstructionFile(project, userId, runners, { source: "claude", directory: "." }, true))
    );
  }
  return readInstructionFile(project, userId, runners, project.instructions);
}

function normalizeInstructions(instructions: ProjectInstructions): ProjectInstructions {
  if (instructions.source === "auto" || instructions.source === "none") return instructions;
  if (instructions.source === "custom") return { source: "custom", content: instructions.content.trim() };

  const directory = instructions.directory
    .trim()
    .replaceAll("\\", "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+$/, "");
  const normalized = directory === "" || directory === "." ? "." : directory;
  if (
    normalized.startsWith("/") ||
    /^[a-zA-Z]:/.test(normalized) ||
    normalized.split("/").some((part) => part === ".." || part === "" || part.includes(":"))
  ) {
    throw invalidInput("Instruction directory must stay within the project workspace");
  }
  return { source: instructions.source, directory: normalized };
}

async function readInstructionFile(
  project: ProjectRow,
  userId: string,
  runners: RunnerRegistry,
  instructions: Extract<ProjectInstructions, { source: "agents" | "claude" }>,
  optional = false,
): Promise<string | undefined> {
  if (!project.runnerId || !project.workspace) throw runnerUnavailable("Bind a runner workspace before using a file");
  const flavor =
    /^[a-zA-Z]:[\\/]/.test(project.workspace) || project.workspace.includes("\\") ? path.win32 : path.posix;
  const filename = instructions.source === "agents" ? "AGENTS.md" : "CLAUDE.md";
  const selected = flavor.join(
    project.workspace,
    ...(instructions.directory === "." ? [] : instructions.directory.split("/")),
    filename,
  );
  const file = await runners.readFileIfExists(
    userId,
    project.runnerId,
    selected,
    MAX_INSTRUCTION_FILE_SIZE,
    project.workspace,
  );
  if (!file) {
    if (optional) return undefined;
    throw invalidInput(`${filename} was not found in the configured directory`);
  }
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(file.data);
  } catch {
    throw invalidInput(`${filename} must be valid UTF-8 text`);
  }
  if (!content.trim() || content.includes("\0")) throw invalidInput(`${filename} must be a non-empty text file`);
  return content;
}
