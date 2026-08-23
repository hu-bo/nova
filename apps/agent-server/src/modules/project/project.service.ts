import type { Project } from "@nova/protocol";
import type { AgentStore, ProjectRow } from "../../store.js";
import type { RunnerRegistry } from "../runner/registry.js";

export function createProjectService(store: AgentStore, runners: RunnerRegistry) {
  const view = (project: ProjectRow): Project => ({
    id: project.id,
    name: project.name,
    workspace: project.workspace,
    runnerId: project.runnerId,
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
    async bind(userId: string, id: string, runnerId: string, workspace: string) {
      await runners.verifyWorkspace(userId, runnerId, workspace);
      return view(await store.bindProject({ userId, id, runnerId, workspace }));
    },
    async remove(userId: string, id: string) {
      await store.deleteProject({ userId, id });
    },
  };
}
