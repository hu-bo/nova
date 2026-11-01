/**
 * `NewProjectDrawer` 的懒加载入口 —— 把 `RemoteExplorer`、`react-hook-form`、
 * `@nova/chat-ui` 的运行时从初始 bundle 推到独立 chunk，避免侧栏首屏体积超预算。
 * 调用方可以像普通组件一样使用 `<NewProjectDrawerLazy open onClose={...} />`。
 */
import { lazy, Suspense } from 'react';

const NewProjectDrawerLazyComponent = lazy(() =>
  import('./new-project-drawer').then((module) => ({ default: module.NewProjectDrawer })),
);

export function NewProjectDrawerLazy(
  props: React.ComponentProps<typeof NewProjectDrawerLazyComponent>,
) {
  return (
    <Suspense fallback={null}>
      <NewProjectDrawerLazyComponent {...props} />
    </Suspense>
  );
}
