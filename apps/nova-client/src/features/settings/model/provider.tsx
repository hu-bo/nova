import { useContext } from 'react';
import { ModelSettingsContext, type ModelSettingsValue } from './model-context';

/**
 * `useModelSettings` hook —— 与 `ModelSettingsProvider` 拆到不同文件，
 * 满足 ESLint `react-refresh/only-export-components` 规则。
 */
export function useModelSettings(): ModelSettingsValue {
  const value = useContext(ModelSettingsContext);
  if (!value) throw new Error('useModelSettings must be used within ModelSettingsProvider');
  return value;
}
