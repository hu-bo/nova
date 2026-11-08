import { Check, ShieldCheck } from 'lucide-react';
import type { GetSpec200 } from '@/api/generated/projectsAPI.schemas';
import { parseAcceptanceCriteria, passingEvidence } from './spec-workbench-model';

const sourceLabels = {
  automatic: '自动验证',
  manual: '人工复核',
  carried: '复核凭据',
} satisfies Record<GetSpec200['evidence'][number]['source'], string>;

export function SpecAcceptance({ spec }: { spec: GetSpec200 }) {
  const criteria = parseAcceptanceCriteria(spec.requirementsMd);
  const matrix = criteria.map((criterion) => {
    const checks = spec.taskPlan.flatMap((task) =>
      task.checks
        .filter((check) => check.criterionIds.includes(criterion.id))
        .map((check) => ({
          taskKey: task.key,
          check,
          evidence: passingEvidence(spec, task.key, check.key),
        })),
    );
    return {
      ...criterion,
      checks,
      passed: checks.length > 0 && checks.every((check) => Boolean(check.evidence)),
    };
  });
  const passed = matrix.filter((row) => row.passed).length;
  const percent = matrix.length ? Math.round((passed / matrix.length) * 100) : 0;
  return (
    <div className="mt-5 space-y-5">
      <section className="rounded-xl border bg-surface p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="flex items-center gap-2 text-sm font-semibold">
              <ShieldCheck size={17} className="text-accent" />
              AC 验收矩阵
            </h3>
            <p className="mt-2 text-xs text-muted-foreground">
              {passed} / {matrix.length} 项满足 · 以当前尝试和显式复核的证据为准
            </p>
          </div>
          <strong className="text-2xl text-accent">{percent}%</strong>
        </div>
        <progress
          aria-label="验收条件满足率"
          max={100}
          value={percent}
          className="mt-4 h-2 w-full accent-accent"
        />
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="text-muted-foreground">
              <tr className="border-b">
                <th className="pb-3">验收准则</th>
                <th className="pb-3">检查与证据</th>
                <th className="pb-3 text-right">状态</th>
              </tr>
            </thead>
            <tbody>
              {matrix.map((row) => (
                <tr key={row.id} className="border-b last:border-0">
                  <td className="py-4 pr-3 align-top">
                    <span className="font-mono font-semibold text-accent">{row.id}</span>
                    <p className="mt-1 text-muted-foreground">{row.title}</p>
                  </td>
                  <td className="py-4 pr-3">
                    {row.checks.length
                      ? row.checks.map((item) => (
                          <p key={item.taskKey + '/' + item.check.key} className="mb-1">
                            {item.taskKey} / {item.check.key} ·{' '}
                            {item.evidence ? sourceLabels[item.evidence.source] : '待验证'}
                          </p>
                        ))
                      : '尚未关联检查'}
                  </td>
                  <td className="py-4 text-right align-top">
                    <span className={row.passed ? 'text-emerald-700' : 'text-amber-700'}>
                      {row.passed ? '已满足' : '待验证'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!matrix.length && (
          <p className="mt-4 text-sm text-muted-foreground">
            在需求的「## 验收条件」下声明「### AC-01」后，这里会显示覆盖矩阵。
          </p>
        )}
      </section>
      <section className="rounded-xl border bg-surface p-5">
        <h3 className="text-sm font-semibold">
          证据台账 <span className="ml-1 text-muted-foreground">{spec.evidence.length}</span>
        </h3>
        {!spec.evidence.length && (
          <p className="mt-3 text-sm text-muted-foreground">
            任务运行的实际工具结果和人工复核结论会显示在这里。
          </p>
        )}
        <ul className="mt-3 divide-y">
          {spec.evidence.map((entry) => (
            <li key={entry.id} className="py-3 text-xs">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <strong>
                  {entry.taskKey} / {entry.checkKey} · {sourceLabels[entry.source]}
                </strong>
                <span className={entry.passed ? 'text-emerald-700' : 'text-danger'}>
                  {entry.passed ? '通过' : '未通过'}
                </span>
              </div>
              {entry.note && <p className="mt-2 whitespace-pre-wrap leading-5">{entry.note}</p>}
              <p className="mt-2 break-all text-muted-foreground">
                {new Date(entry.createdAt).toLocaleString('zh-CN')} · 记录人{' '}
                {entry.createdBy.slice(0, 8)}
                {entry.toolOperationId ? ' · 工具 ' + entry.toolOperationId.slice(0, 8) : ''}
                {entry.attemptId ? ' · 尝试 ' + entry.attemptId.slice(0, 8) : ''}
              </p>
            </li>
          ))}
        </ul>
      </section>
      {spec.acceptance && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-5 text-sm text-emerald-900">
          <h3 className="flex items-center gap-2 font-semibold">
            <Check size={17} />
            已验收冻结
          </h3>
          <p className="mt-2 text-xs leading-5">
            {new Date(spec.acceptance.acceptedAt).toLocaleString('zh-CN')} · 采用{' '}
            {spec.acceptance.evidenceIds.length} 条证据，已冻结执行与证据写入。
          </p>
        </div>
      )}
    </div>
  );
}
