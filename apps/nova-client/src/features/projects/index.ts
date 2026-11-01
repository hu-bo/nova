import { lazy } from 'react';
export const NewProjectDialog = lazy(() =>
  import('./new-project-dialog').then((module) => ({ default: module.NewProjectDialog })),
);
export const ProjectsPage = lazy(() =>
  import('./projects.page').then((module) => ({ default: module.ProjectsPage })),
);
export const ProjectPage = lazy(() =>
  import('./project.page').then((module) => ({ default: module.ProjectPage })),
);
export {
  useProjectsQuery,
  useProjectQuery,
  useProjectBinding,
  useProjectSidebarInfo,
} from './project.queries';
export const ProjectEnvironmentPicker = lazy(() =>
  import('./project-environment-picker').then((module) => ({
    default: module.ProjectEnvironmentPicker,
  })),
);
export {
  useProjectEnvironmentRequest,
  validWorkspacePath,
  type ProjectEnvironment,
} from './project-environment';
