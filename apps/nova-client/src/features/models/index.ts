export { useClientConfig } from './queries';
import { lazy } from 'react';
export const ModelPicker = lazy(() =>
  import('./model-picker').then((module) => ({ default: module.ModelPicker })),
);
