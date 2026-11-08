import { lazy } from 'react';
export const SpecPage = lazy(() =>
  import('./spec.page').then((module) => ({ default: module.SpecPage })),
);
export { useStartSpecMutation } from './spec.queries';
