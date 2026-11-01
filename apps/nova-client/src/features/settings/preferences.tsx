import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  PreferencesContext,
  persistPreferences,
  readPreferences,
  type Preferences,
} from './preferences.context';

/**
 * 只导出组件的 Provider 模块：React Fast Refresh 要求边界模块只导出组件，
 * 上下文与 hook 放在 `preferences.context.ts`。
 */
export function PreferencesProvider({ children }: { children: ReactNode }) {
  const [preferences, setPreferences] = useState(readPreferences);
  useEffect(() => {
    // 应用仅提供浅色主题：清掉历史版本可能残留的 dark class / data 属性。
    document.documentElement.classList.remove('dark');
    document.documentElement.dataset.theme = 'light';
    delete document.documentElement.dataset.reducedMotion;
    persistPreferences(preferences);
  }, [preferences]);
  const value = useMemo(
    () => ({
      preferences,
      update: (input: Partial<Omit<Preferences, 'version'>>) =>
        setPreferences((previous) => ({ ...previous, ...input })),
    }),
    [preferences],
  );
  return <PreferencesContext.Provider value={value}>{children}</PreferencesContext.Provider>;
}
