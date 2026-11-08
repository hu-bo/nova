import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Check,
  ChevronRight,
  FileText,
  Layers3,
  ListChecks,
  Plus,
  RotateCcw,
  Save,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import {
  acceptSpec,
  recordSpecEvidence,
  reconcileSpecTaskAttempt,
  reviewSpecStage,
  saveSpecDraft,
  startSpecTaskAttempt,
} from '@/api/generated/specs';
import type { GetSpec200, GetSpec200TaskPlanItem } from '@/api/generated/projectsAPI.schemas';
import { ApiError } from '@/api/api-error';
import { CommandIntent } from '@/api/command-intent';
import { queryKeys } from '@/api/query-keys';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useIdentity } from '@/features/auth';
import { MarkdownEditor } from './markdown-editor';
import { useSpecQuery } from './spec.queries';
import { SpecAcceptance } from './spec-acceptance';
import { parseAcceptanceCriteria, taskDependencyError } from './spec-workbench-model';

const stageList = [
  { id: 'requirements', label: '需求', icon: FileText },
  { id: 'design', label: '设计', icon: Layers3 },
  { id: 'tasks', label: '任务', icon: ListChecks },
  { id: 'acceptance', label: '验收', icon: ShieldCheck },
] as const;
type Tab = (typeof stageList)[number]['id'];
type Stage = Exclude<Tab, 'acceptance'>;
type DraftValue = string | GetSpec200TaskPlanItem[];
type StepState = 'active' | 'complete' | 'pending';
const stepStates = {
  active: {
    label: '当前阶段',
    className: 'border-accent/30 bg-accent/5 text-accent',
    iconClass: 'bg-accent text-accent-foreground',
  },
  complete: {
    label: '已确认',
    className: 'border-emerald-200 bg-emerald-50/50 text-emerald-800',
    iconClass: 'bg-emerald-100 text-emerald-700',
  },
  pending: {
    label: '待审阅',
    className: 'border-transparent text-muted-foreground hover:bg-muted/30',
    iconClass: 'bg-surface text-muted-foreground ring-1 ring-border',
  },
} satisfies Record<StepState, { label: string; className: string; iconClass: string }>;
const taskStates = {
  not_started: { label: '未开始', className: 'text-muted-foreground' },
  queued: { label: '排队中', className: 'text-accent' },
  running: { label: '运行中', className: 'text-accent' },
  waiting: { label: '等待审批', className: 'text-amber-700' },
  passed: { label: '已通过', className: 'text-emerald-700' },
  needs_verification: { label: '待验证', className: 'text-amber-700' },
  failed: { label: '失败', className: 'text-danger' },
  cancelled: { label: '已取消', className: 'text-muted-foreground' },
  timed_out: { label: '已超时', className: 'text-danger' },
  needs_reconciliation: { label: '待核实原操作', className: 'text-amber-700' },
} satisfies Record<GetSpec200['tasks'][number]['status'], { label: string; className: string }>;
function draftForStage(spec: GetSpec200, stage: Stage): DraftValue {
  if (stage === 'requirements') return spec.requirementsMd;
  if (stage === 'design') return spec.designMd ?? '';
  return spec.taskPlan;
}
const stable = (value: unknown) => JSON.stringify(value);
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : '操作失败，请重试。';
const newTask = (index: number): GetSpec200TaskPlanItem => ({
  key: `T-${String(index).padStart(2, '0')}`,
  title: '',
  objective: '',
  dependsOn: [],
  checks: [{ key: 'C-01', criterionIds: [], label: '', method: { kind: 'manual' } }],
});

export function SpecWorkbench({ projectId, specId }: { projectId: string; specId: string }) {
  const current = useSpecQuery(projectId, specId);
  const spec = current.data;
  const [tab, setTab] = useState<Tab>('requirements');
  const stage: Stage = tab === 'acceptance' ? 'tasks' : tab;
  const [preview, setPreview] = useState(true);
  const [draft, setDraft] = useState<DraftValue>('');
  const [baseRevision, setBaseRevision] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const attemptIntents = useRef(new Map<string, CommandIntent>());
  const client = useQueryClient();
  const { identity } = useIdentity();
  const serverDraft = useMemo(() => (spec ? draftForStage(spec, stage) : ''), [spec, stage]);
  useEffect(() => {
    if (!spec || dirty) return;
    setDraft(serverDraft);
    setBaseRevision(spec.revision);
    setConflict(false);
  }, [spec, serverDraft, dirty]);
  const updateDraft = (value: DraftValue) => {
    setDraft(value);
    setDirty(stable(value) !== stable(serverDraft));
    setError('');
  };
  async function mutate(action: () => Promise<unknown>) {
    if (pending) return;
    setPending(true);
    setError('');
    try {
      await action();
      await Promise.all([
        client.invalidateQueries({
          queryKey: queryKeys.specs.detailRoot(identity!.identityId, specId),
        }),
        client.invalidateQueries({
          queryKey: queryKeys.specs.list(identity!.identityId, projectId),
        }),
      ]);
    } catch (cause) {
      setError(errorText(cause));
      if (cause instanceof ApiError && cause.details?.reason === 'SPEC_REVISION_STALE') {
        setConflict(true);
        void current.refetch();
      }
    } finally {
      setPending(false);
    }
  }
  const save = () =>
    mutate(async () => {
      const result = await saveSpecDraft(projectId, specId, {
        expectedRevision: baseRevision,
        stage,
        content: draft,
      });
      client.setQueryData(queryKeys.specs.detail(identity!.identityId, specId), result);
      setDraft(draftForStage(result, stage));
      setBaseRevision(result.revision);
      setDirty(false);
      setConflict(false);
    });
  const runTask = (taskKey: string) =>
    mutate(async () => {
      if (!spec) return;
      const intent = attemptIntents.current.get(taskKey) ?? new CommandIntent();
      attemptIntents.current.set(taskKey, intent);
      const body = { expectedRevision: spec.revision };
      await startSpecTaskAttempt(projectId, specId, taskKey, body, {
        headers: { 'Idempotency-Key': intent.prepare({ specId, taskKey, ...body }) },
      });
      intent.accepted();
    });
  const recordManual = async (
    taskKey: string,
    checkKey: string,
    attemptId: string,
    passed: boolean,
  ) => {
    if (!spec) return;
    const note = window.prompt(passed ? '记录通过说明（可留空）' : '记录未通过原因');
    if (note === null || (!passed && !note.trim())) return;
    await mutate(() =>
      recordSpecEvidence(projectId, specId, {
        expectedRevision: spec.revision,
        evidenceId: crypto.randomUUID(),
        taskKey,
        checkKey,
        source: { kind: 'manual', attemptId, passed, note },
      }),
    );
  };
  const reconcile = async (attemptId: string) => {
    if (!spec) return;
    const note = window.prompt('核对原操作回执和工作区后，记录核实说明。');
    if (!note?.trim()) return;
    await mutate(() =>
      reconcileSpecTaskAttempt(projectId, specId, attemptId, {
        expectedRevision: spec.revision,
        note,
      }),
    );
  };
  if (current.error)
    return (
      <p role="alert" className="text-sm text-danger">
        {errorText(current.error)}
      </p>
    );
  if (!spec)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        正在加载规格…
      </p>
    );
  const executionBusy = spec.tasks.some((task) =>
    ['queued', 'running', 'waiting', 'needs_reconciliation'].includes(task.status),
  );
  const readonly = Boolean(spec.acceptance) || executionBusy;
  const reviewed = spec.reviews[stage]?.revision === spec.revision;
  let content = <SpecAcceptance spec={spec} />;
  if (tab !== 'acceptance') {
    if (stage === 'tasks')
      content = (
        <TaskPlanEditor
          value={Array.isArray(draft) ? draft : spec.taskPlan}
          onChange={updateDraft}
          readonly={readonly}
        />
      );
    else if (!preview)
      content = (
        <MarkdownEditor
          resetKey={specId + ':' + stage + ':' + spec.revision}
          label={stage + ' Markdown 编辑器'}
          value={typeof draft === 'string' ? draft : ''}
          readonly={readonly}
          onChange={updateDraft}
        />
      );
    else
      content = (
        <article className="min-h-64 rounded-xl border bg-surface p-5 text-sm leading-7 [&_h1]:my-4 [&_h1]:text-2xl [&_h2]:my-4 [&_h2]:text-xl [&_h3]:my-3 [&_h3]:font-semibold [&_pre]:overflow-auto [&_pre]:rounded-lg [&_pre]:bg-slate-950 [&_pre]:p-4 [&_pre]:text-slate-100 [&_table]:w-full [&_td]:border [&_td]:p-2 [&_th]:border [&_th]:p-2 [&_ul]:list-disc [&_ul]:pl-6">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              h3: ({ children }) => (
                <h3
                  className={
                    /^AC-\d+/.test(String(children))
                      ? 'rounded-lg border-l-4 border-accent bg-accent/5 px-3 py-2 text-accent'
                      : undefined
                  }
                >
                  {children}
                </h3>
              ),
            }}
          >
            {typeof draft === 'string' && draft.trim()
              ? draft
              : '在右侧会话中与 Agent 讨论并生成这一阶段的内容，也可以直接编辑 Markdown。'}
          </ReactMarkdown>
        </article>
      );
  }
  return (
    <div className="min-w-0 space-y-5">
      <ol
        role="tablist"
        aria-label="需求到验收流程"
        className="flex items-center rounded-xl border bg-surface p-2"
      >
        {stageList.map((item, index) => {
          const confirmed =
            item.id === 'acceptance'
              ? Boolean(spec.acceptance)
              : spec.reviews[item.id]?.revision === spec.revision;
          let state: StepState = 'pending';
          if (tab === item.id) state = 'active';
          else if (confirmed) state = 'complete';
          const display = stepStates[state];
          const Icon = confirmed ? Check : item.icon;
          return (
            <li key={item.id} role="presentation" className="flex min-w-0 flex-1 items-center">
              <button
                type="button"
                role="tab"
                aria-label={item.label}
                aria-selected={tab === item.id}
                onClick={() => {
                  if (dirty) {
                    setError('请先保存当前编辑，再切换阶段。');
                    return;
                  }
                  setTab(item.id);
                  setPreview(true);
                  setError('');
                }}
                className={
                  'flex min-w-0 flex-1 flex-col items-center gap-1.5 rounded-lg border px-1 py-3 text-xs transition-colors sm:flex-row sm:justify-center sm:gap-2 ' +
                  display.className
                }
              >
                <span
                  className={
                    'grid size-7 shrink-0 place-items-center rounded-full ' + display.iconClass
                  }
                >
                  <Icon size={15} />
                </span>
                <span className="text-left">
                  <span className="block font-semibold">
                    {index + 1}. {item.label}
                  </span>
                  <span className="mt-0.5 hidden text-[10px] sm:block">
                    {confirmed ? '已确认' : display.label}
                  </span>
                </span>
              </button>
              {index < stageList.length - 1 && (
                <ChevronRight
                  aria-hidden="true"
                  size={18}
                  className={
                    'mx-0.5 shrink-0 ' + (confirmed ? 'text-accent' : 'text-muted-foreground/40')
                  }
                />
              )}
            </li>
          );
        })}
      </ol>
      {tab !== 'acceptance' && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            {stage !== 'tasks' && (
              <Button variant="ghost" size="sm" onPress={() => setPreview(!preview)}>
                {preview ? '编辑 Markdown' : '预览'}
              </Button>
            )}
          </div>
          {!readonly && (
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={pending || !dirty}
                onPress={() => void save()}
              >
                <Save size={14} />
                保存
              </Button>
              <Button
                size="sm"
                disabled={pending || dirty || reviewed}
                onPress={() =>
                  void mutate(() =>
                    reviewSpecStage(projectId, specId, stage, { expectedRevision: spec.revision }),
                  )
                }
              >
                <Check size={14} />
                {reviewed ? '已确认' : '确认' + stageList.find((item) => item.id === stage)?.label}
              </Button>
            </div>
          )}
        </div>
      )}
      {content}
      {stage === 'requirements' && tab !== 'acceptance' && (
        <div className="flex flex-wrap gap-2" aria-label="已解析验收条件">
          {parseAcceptanceCriteria(typeof draft === 'string' ? draft : '').map((criterion) => (
            <span
              key={criterion.id + criterion.from}
              className="rounded-md bg-accent/10 px-2 py-1 font-mono text-xs text-accent"
            >
              {criterion.id}
            </span>
          ))}
        </div>
      )}
      {tab === 'tasks' && (
        <TaskExecutionList
          spec={spec}
          canRun={!readonly && reviewed}
          canRecordEvidence={!spec.acceptance}
          busy={pending}
          onRun={(key) => void runTask(key)}
          onManual={(...args) => void recordManual(...args)}
          onReconcile={(id) => void reconcile(id)}
        />
      )}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      {conflict && (
        <div
          role="status"
          className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-950"
        >
          <p>服务端内容已更新，你的本地编辑仍保留。合并后再保存，或载入服务端内容。</p>
          <Button
            className="mt-2"
            size="sm"
            variant="outline"
            onPress={() => {
              setDraft(serverDraft);
              setBaseRevision(spec.revision);
              setDirty(false);
              setConflict(false);
            }}
          >
            <RotateCcw size={13} />
            载入服务端内容
          </Button>
        </div>
      )}
      {tab === 'acceptance' && !readonly && (
        <div className="flex justify-end">
          <Button
            disabled={
              pending || !spec.tasks.length || spec.tasks.some((task) => task.status !== 'passed')
            }
            onPress={() =>
              void mutate(() => acceptSpec(projectId, specId, { expectedRevision: spec.revision }))
            }
          >
            <ShieldCheck size={15} />
            验收并冻结
          </Button>
        </div>
      )}
    </div>
  );
}

function TaskPlanEditor({
  value,
  onChange,
  readonly,
}: {
  value: GetSpec200TaskPlanItem[];
  onChange: (value: DraftValue) => void;
  readonly: boolean;
}) {
  const replaceTask = (index: number, update: Partial<GetSpec200TaskPlanItem>) =>
    onChange(value.map((task, position) => (position === index ? { ...task, ...update } : task)));
  const addTask = () => onChange([...value, newTask(value.length + 1)]);
  const dependencyError = taskDependencyError(value);
  return (
    <div className="mt-3 space-y-3">
      {dependencyError && (
        <p role="alert" className="rounded-lg border border-danger/30 p-3 text-xs text-danger">
          {dependencyError}
        </p>
      )}
      {!value.length && (
        <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
          还没有任务。至少添加一个任务并覆盖每条验收条件。
        </p>
      )}
      {value.map((task, taskIndex) => (
        <fieldset
          key={taskIndex}
          disabled={readonly}
          className="min-w-0 space-y-3 rounded-xl border p-3 disabled:opacity-70"
        >
          <legend className="px-1 text-xs font-semibold">{task.key}</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-xs text-muted-foreground">
              任务 ID
              <Input
                className="mt-1"
                value={task.key}
                onChange={(event) => replaceTask(taskIndex, { key: event.target.value })}
              />
            </label>
            <label className="text-xs text-muted-foreground">
              标题
              <Input
                className="mt-1"
                value={task.title}
                onChange={(event) => replaceTask(taskIndex, { title: event.target.value })}
              />
            </label>
          </div>
          <label className="block text-xs text-muted-foreground">
            目标
            <textarea
              className="mt-1 min-h-20 w-full rounded-lg border bg-surface px-3 py-2 text-sm text-foreground"
              value={task.objective}
              onChange={(event) => replaceTask(taskIndex, { objective: event.target.value })}
            />
          </label>
          <label className="block text-xs text-muted-foreground">
            依赖任务 ID（逗号分隔）
            <Input
              className="mt-1"
              value={task.dependsOn.join(', ')}
              onChange={(event) =>
                replaceTask(taskIndex, {
                  dependsOn: event.target.value
                    .split(',')
                    .map((item) => item.trim())
                    .filter(Boolean),
                })
              }
              placeholder="例如：T-01"
            />
          </label>
          <div className="space-y-2 border-t pt-3">
            <p className="text-xs font-medium">验收检查</p>
            {task.checks.map((check, checkIndex) => (
              <div
                key={checkIndex}
                className="grid gap-2 rounded-lg bg-muted/20 p-3 sm:grid-cols-2"
              >
                <label className="text-xs text-muted-foreground">
                  检查 ID
                  <Input
                    className="mt-1"
                    value={check.key}
                    onChange={(event) =>
                      replaceTask(taskIndex, {
                        checks: task.checks.map((item, index) =>
                          index === checkIndex ? { ...item, key: event.target.value } : item,
                        ),
                      })
                    }
                  />
                </label>
                <label className="text-xs text-muted-foreground">
                  说明
                  <Input
                    className="mt-1"
                    value={check.label}
                    onChange={(event) =>
                      replaceTask(taskIndex, {
                        checks: task.checks.map((item, index) =>
                          index === checkIndex ? { ...item, label: event.target.value } : item,
                        ),
                      })
                    }
                  />
                </label>
                <label className="text-xs text-muted-foreground">
                  覆盖验收条件（AC-01, AC-02）
                  <Input
                    className="mt-1"
                    value={check.criterionIds.join(', ')}
                    onChange={(event) =>
                      replaceTask(taskIndex, {
                        checks: task.checks.map((item, index) =>
                          index === checkIndex
                            ? {
                                ...item,
                                criterionIds: event.target.value
                                  .split(',')
                                  .map((id) => id.trim())
                                  .filter(Boolean),
                              }
                            : item,
                        ),
                      })
                    }
                  />
                </label>
                <label className="text-xs text-muted-foreground">
                  验证方式
                  <select
                    className="mt-1 w-full rounded-lg border bg-surface px-3 py-2 text-sm"
                    value={check.method.kind}
                    onChange={(event) =>
                      replaceTask(taskIndex, {
                        checks: task.checks.map((item, index) =>
                          index === checkIndex
                            ? {
                                ...item,
                                method:
                                  event.target.value === 'command'
                                    ? { kind: 'command', command: '', args: [] }
                                    : { kind: 'manual' },
                              }
                            : item,
                        ),
                      })
                    }
                  >
                    <option value="manual">人工检查</option>
                    <option value="command">命令</option>
                  </select>
                </label>
                {check.method.kind === 'command' && (
                  <>
                    <label className="text-xs text-muted-foreground">
                      命令
                      <Input
                        className="mt-1 font-mono"
                        value={check.method.command}
                        onChange={(event) =>
                          replaceTask(taskIndex, {
                            checks: task.checks.map((item, index) =>
                              index === checkIndex
                                ? {
                                    ...item,
                                    method: { ...check.method, command: event.target.value },
                                  }
                                : item,
                            ),
                          })
                        }
                      />
                    </label>
                    <label className="text-xs text-muted-foreground">
                      参数（每行一个）
                      <textarea
                        className="mt-1 min-h-16 w-full rounded-lg border bg-surface px-3 py-2 font-mono text-xs"
                        value={check.method.args.join('\n')}
                        onChange={(event) =>
                          replaceTask(taskIndex, {
                            checks: task.checks.map((item, index) =>
                              index === checkIndex
                                ? {
                                    ...item,
                                    method: {
                                      ...check.method,
                                      args: event.target.value.split('\n'),
                                    },
                                  }
                                : item,
                            ),
                          })
                        }
                      />
                    </label>
                    <label className="text-xs text-muted-foreground">
                      工作目录（可选）
                      <Input
                        className="mt-1 font-mono"
                        value={check.method.cwd ?? ''}
                        onChange={(event) =>
                          replaceTask(taskIndex, {
                            checks: task.checks.map((item) =>
                              item === check
                                ? {
                                    ...item,
                                    method: {
                                      kind: 'command',
                                      command:
                                        check.method.kind === 'command' ? check.method.command : '',
                                      args:
                                        check.method.kind === 'command' ? check.method.args : [],
                                      ...(event.target.value ? { cwd: event.target.value } : {}),
                                    },
                                  }
                                : item,
                            ),
                          })
                        }
                      />
                    </label>
                  </>
                )}
                {task.checks.length > 1 && (
                  <Button
                    className="justify-self-start"
                    variant="ghost"
                    size="sm"
                    onPress={() =>
                      replaceTask(taskIndex, {
                        checks: task.checks.filter((_, index) => index !== checkIndex),
                      })
                    }
                  >
                    移除检查
                  </Button>
                )}
              </div>
            ))}
            <Button
              variant="outline"
              size="sm"
              onPress={() =>
                replaceTask(taskIndex, {
                  checks: [
                    ...task.checks,
                    {
                      key: `C-${String(task.checks.length + 1).padStart(2, '0')}`,
                      criterionIds: [],
                      label: '',
                      method: { kind: 'manual' },
                    },
                  ],
                })
              }
            >
              <Plus size={13} />
              添加检查
            </Button>
          </div>
          {value.length > 1 && (
            <Button
              variant="ghost"
              size="sm"
              onPress={() => onChange(value.filter((_, index) => index !== taskIndex))}
            >
              移除任务
            </Button>
          )}
        </fieldset>
      ))}
      {!readonly && (
        <Button variant="outline" onPress={addTask}>
          <Plus size={14} />
          添加任务
        </Button>
      )}
    </div>
  );
}

function TaskExecutionList({
  spec,
  canRun,
  canRecordEvidence,
  busy,
  onReconcile,
  onRun,
  onManual,
}: {
  spec: GetSpec200;

  canRun: boolean;
  canRecordEvidence: boolean;
  busy: boolean;
  onReconcile: (attemptId: string) => void;
  onRun: (taskKey: string) => void;
  onManual: (taskKey: string, checkKey: string, attemptId: string, passed: boolean) => void;
}) {
  return (
    <div className="mt-5 space-y-3 border-t pt-4">
      {spec.taskPlan.map((task) => {
        const status = spec.tasks.find((item) => item.key === task.key);
        const active = ['queued', 'running', 'waiting', 'needs_reconciliation'].includes(
          status?.status ?? '',
        );
        const unmet = task.dependsOn.filter(
          (key) => spec.tasks.find((item) => item.key === key)?.status !== 'passed',
        );
        const display = taskStates[status?.status ?? 'not_started'];
        return (
          <article key={task.key} className="rounded-xl border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h5 className="text-sm font-medium">
                  {task.key} · {task.title || '未命名任务'}
                </h5>
                <p className={'mt-1 text-xs ' + display.className}>
                  {display.label}
                  {status?.runId ? ` · Run ${status.runId.slice(0, 8)} · 回执见右侧会话` : ''}
                </p>
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={
                  !canRun ||
                  busy ||
                  active ||
                  unmet.length > 0 ||
                  status?.status === 'passed' ||
                  !task.title ||
                  !task.objective
                }
                onPress={() => onRun(task.key)}
              >
                <Sparkles size={13} />
                {status?.status === 'not_started' ? '运行任务' : '重试任务'}
              </Button>
            </div>
            {status?.status === 'needs_reconciliation' && status.attemptId && canRecordEvidence && (
              <Button
                className="mt-3"
                size="sm"
                variant="outline"
                disabled={busy}
                onPress={() => onReconcile(status.attemptId!)}
              >
                核实原操作
              </Button>
            )}
            {!!task.dependsOn.length && (
              <p
                className={
                  'mt-2 text-xs ' + (unmet.length ? 'text-amber-700' : 'text-muted-foreground')
                }
              >
                依赖 {task.dependsOn.join(' → ')}
                {unmet.length ? ' · 等待 ' + unmet.join('、') + ' 通过' : ' · 均已满足'}
              </p>
            )}
            <ul className="mt-3 space-y-2">
              {task.checks.map((check) => {
                const passed = spec.evidence.some(
                  (item) =>
                    item.taskKey === task.key &&
                    item.checkKey === check.key &&
                    item.passed &&
                    (status?.attemptId
                      ? item.attemptId === status.attemptId
                      : item.source === 'carried'),
                );

                return (
                  <li
                    key={`${task.key}/${check.key}`}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-muted/20 px-3 py-2 text-xs"
                  >
                    <span className="min-w-0">
                      <span className="font-medium">{check.key}</span> · {check.label}
                      <span className="ml-2 text-muted-foreground">
                        {check.method.kind === 'manual'
                          ? '人工'
                          : [check.method.command, ...check.method.args].join(' ')}
                      </span>
                    </span>
                    <span className={passed ? 'text-emerald-700' : 'text-amber-700'}>
                      {passed ? '已通过' : '待验证'}
                    </span>
                    {!passed && canRecordEvidence && status?.attemptId && !active && (
                      <span className="flex gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onPress={() => onManual(task.key, check.key, status.attemptId!, true)}
                        >
                          人工通过
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onPress={() => onManual(task.key, check.key, status.attemptId!, false)}
                        >
                          未通过
                        </Button>
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </article>
        );
      })}
    </div>
  );
}
