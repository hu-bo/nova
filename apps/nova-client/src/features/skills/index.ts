import { lazy } from 'react';

export const SkillsPage = lazy(() =>
  import('./skills.page').then((module) => ({ default: module.SkillsPage })),
);
export {
  useAgentCatalogQuery,
  useRefreshRunnerSkillsMutation,
  useSkillCatalogQuery,
  useSkillVersionDetailQuery,
  type SkillCatalogEntry,
  type SkillEnvironmentFilters,
} from './skills.queries';
