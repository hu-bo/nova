import type { Runner } from '@/features/runners';

/**
 * nova-dsh 风格的 Runner 下拉：以 props 形式接收 `runners` / `isLoading`，
 * 由调用方（如 `new-project-drawer.tsx`）按业务规则过滤后再传入。
 *
 * settings 的 runner tab 使用 `runner-manager-dialog.tsx`（配合
 * `useRunnerCatalog()`），不经过这个组件。
 */
export function RunnerSelect({
  value,
  onChange,
  runners,
  isLoading,
}: {
  value: string;
  onChange: (value: string) => void;
  runners: Runner[];
  isLoading: boolean;
}) {
  return (
    <select
      value={value}
      disabled={isLoading}
      onChange={(event) => onChange(event.currentTarget.value)}
      className="mt-2 w-full rounded-xl bg-white px-3 py-2.5 text-sm text-slate-900 ring-1 ring-inset ring-slate-200 transition placeholder:text-slate-400 focus:ring-2 focus:ring-indigo-500 disabled:bg-slate-100 disabled:text-slate-500"
    >
      <option value="">{isLoading ? '正在加载 Runner…' : '选择 Runner'}</option>
      {runners.map((runner) => (
        <option key={runner.id} value={runner.id}>
          {runner.runnerId} · {labelFor(runner)}
        </option>
      ))}
    </select>
  );
}

function labelFor(runner: Runner) {
  if (runner.revokedAt) return '已撤销';
  return runner.lastSeenAt && Date.now() - Date.parse(runner.lastSeenAt) < 60000 ? '在线' : '离线';
}
