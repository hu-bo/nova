export function LoadingState({ label = '正在加载' }: { label?: string }) {
  return (
    <div
      className="grid min-h-40 animate-pulse gap-3 py-2 motion-reduce:animate-none"
      role="status"
      aria-label={label}
    >
      <span className="sr-only">{label}</span>
      <div className="h-3 w-28 rounded-full bg-slate-200" />
      <div className="h-14 rounded-xl bg-white ring-1 ring-slate-200" />
      <div className="h-14 rounded-xl bg-white ring-1 ring-slate-200" />
      <div className="h-14 w-4/5 rounded-xl bg-white ring-1 ring-slate-200" />
    </div>
  );
}
