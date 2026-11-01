import { createContext, useContext } from 'react';
import { z } from 'zod';

const schema = z.object({
  version: z.literal(1),
  sidebarCollapsed: z.boolean(),
  contextPanelOpen: z.boolean().default(false),
});
export type Preferences = z.infer<typeof schema>;
export const defaults: Preferences = {
  version: 1,
  sidebarCollapsed: false,
  contextPanelOpen: false,
};
const key = 'nova:preferences:v1';
export function readPreferences() {
  try {
    const result = schema.safeParse(JSON.parse(localStorage.getItem(key) ?? 'null'));
    return result.success ? result.data : defaults;
  } catch {
    return defaults;
  }
}
export function persistPreferences(preferences: Preferences) {
  try {
    localStorage.setItem(key, JSON.stringify(preferences));
  } catch {
    /* Preferences still apply when storage is unavailable. */
  }
}

/**
 * 偏好设置的数据模型、上下文与 hook。与 `preferences.tsx` 的 Provider 分开存放：
 * 该模块只导出非组件值，满足 React Fast Refresh 的「边界模块只导出组件」约定。
 */
export const PreferencesContext = createContext<{
  preferences: Preferences;
  update: (input: Partial<Omit<Preferences, 'version'>>) => void;
} | null>(null);

export function usePreferences() {
  const value = useContext(PreferencesContext);
  if (!value) throw new Error('PreferencesProvider missing');
  return value;
}
