import { lazy } from 'react';

export { PreferencesProvider } from './preferences';
export { usePreferences } from './preferences.context';
export { ModelSettingsProvider } from './model/model-provider';
export { useModelSettings } from './model/provider';
export const ModelsTab = lazy(() =>
  import('./model/models-tab').then((module) => ({ default: module.ModelsTab })),
);
export const RunnersTab = lazy(() =>
  import('./runner/runners-tab').then((module) => ({ default: module.RunnersTab })),
);
export const SettingsLayout = lazy(() =>
  import('./settings-layout').then((module) => ({ default: module.SettingsLayout })),
);
export const SettingsPage = SettingsLayout;
export type { ModelProfile } from './model/model-context';
export type { ModelThinkingLevel } from './model/schemas';
