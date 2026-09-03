import { expect, it } from "vitest";
import { createMemoryStore } from "../../store.js";
import type { RunnerRegistry } from "../runner/registry.js";
import { createProjectService, loadProjectInstructions } from "./project.service.js";

it("binds a workspace AGENTS.md by a normalized project-relative directory", async () => {
  const store = createMemoryStore();
  const reads: string[] = [];
  const runners = {
    state: () => "ready",
    async readFileIfExists(_userId: string, _runnerId: string, selected: string) {
      reads.push(selected);
      return { name: "AGENTS.md", size: 12, data: new TextEncoder().encode("Follow rules") };
    },
  } as unknown as RunnerRegistry;
  const project = await store.createProject({ userId: "alice", name: "Nova" });
  await store.bindProject({ userId: "alice", id: project.id, runnerId: "runner-1", workspace: "E:\\work\\nova" });
  const service = createProjectService(store, runners);

  const updated = await service.setInstructions("alice", project.id, {
    source: "agents",
    directory: ".\\packages\\server\\",
  });

  expect(updated.instructions).toEqual({ source: "agents", directory: "packages/server" });
  expect(reads).toEqual([]);
  expect(
    await loadProjectInstructions(await store.getProject({ userId: "alice", id: project.id }), "alice", runners),
  ).toBe("Follow rules");
  expect(reads).toEqual(["E:\\work\\nova\\packages\\server\\AGENTS.md"]);
});

it("rejects an instruction directory that can escape the project workspace", async () => {
  const store = createMemoryStore();
  const project = await store.createProject({ userId: "alice", name: "Nova" });
  await store.bindProject({ userId: "alice", id: project.id, runnerId: "runner-1", workspace: "/work/nova" });
  const service = createProjectService(store, { state: () => "ready" } as unknown as RunnerRegistry);

  await expect(
    service.setInstructions("alice", project.id, { source: "claude", directory: "../other" }),
  ).rejects.toMatchObject({ code: "INVALID_INPUT" });
});

it("stores custom project instructions without requiring a runner", async () => {
  const store = createMemoryStore();
  const project = await store.createProject({ userId: "alice", name: "Nova" });
  const service = createProjectService(store, { state: () => "disconnected" } as unknown as RunnerRegistry);

  const updated = await service.setInstructions("alice", project.id, {
    source: "custom",
    content: "  Keep changes small.  ",
  });

  expect(updated.instructions).toEqual({ source: "custom", content: "Keep changes small." });
});

it("auto-detects CLAUDE.md when the workspace root has no AGENTS.md", async () => {
  const store = createMemoryStore();
  const reads: string[] = [];
  const runners = {
    async readFileIfExists(_userId: string, _runnerId: string, selected: string) {
      reads.push(selected);
      return selected.endsWith("CLAUDE.md")
        ? { name: "CLAUDE.md", size: 12, data: new TextEncoder().encode("Claude rules") }
        : null;
    },
  } as unknown as RunnerRegistry;
  const project = await store.createProject({ userId: "alice", name: "Nova" });
  await store.bindProject({ userId: "alice", id: project.id, runnerId: "runner-1", workspace: "/work/nova" });

  await expect(
    loadProjectInstructions(await store.getProject({ userId: "alice", id: project.id }), "alice", runners),
  ).resolves.toBe("Claude rules");
  expect(reads).toEqual(["/work/nova/AGENTS.md", "/work/nova/CLAUDE.md"]);
});

it("ignores a missing explicitly configured instruction file", async () => {
  const store = createMemoryStore();
  const runners = {
    async readFileIfExists() {
      return null;
    },
  } as unknown as RunnerRegistry;
  const project = await store.createProject({ userId: "alice", name: "Nova" });
  await store.bindProject({ userId: "alice", id: project.id, runnerId: "runner-1", workspace: "/work/nova" });
  await store.updateProjectInstructions({
    userId: "alice",
    id: project.id,
    instructions: { source: "agents", directory: "." },
  });

  await expect(
    loadProjectInstructions(await store.getProject({ userId: "alice", id: project.id }), "alice", runners),
  ).resolves.toBeUndefined();
});
