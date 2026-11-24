import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { FolderKanban, LoaderCircle, MessagesSquare, Plus, RefreshCw, Search, X } from 'lucide-react';
import type { SkillSource } from '@nova/agent-ui-contracts';
import { SKILL_APPLICABILITY_LABELS, SKILL_SOURCE_LABELS } from '@nova/chat-ui';
import { errorMessage } from '@/api/api-error';
import type { ListSkills200ItemsItem } from '@/api/generated/projectsAPI.schemas';
import { ErrorNotice } from '@/components/error-notice';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useProjectBinding, useProjectsQuery } from '@/features/projects';
import { runnerStatus, useRunnersQuery } from '@/features/runners';
import { allowedModesLabel, CATALOG_STATUS_GUIDANCE, requirementFlag } from './skills.display';
import {
  useRefreshRunnerSkillsMutation,
  useSkillCatalogQuery,
  useSkillVersionDetailQuery,
} from './skills.queries';

/** 与 routes/skills/index.tsx 的 validateSearch 对齐的读取形状；筛选全部进 URL（§3.1）。 */
export type SkillsSearch = {
  runnerId?: string | undefined;
  projectId?: string | undefined;
  skillId?: string | undefined;
  version?: string | undefined;
  q?: string | undefined;
  source?: SkillSource | undefined;
};

type SkillCatalogEntryItem = ListSkills200ItemsItem;

/** 列表项的关联环境行：项目名/Runner 名走既有目录查询，缺失时退回 ID。 */
function environmentLabels(
  item: SkillCatalogEntryItem,
  projectNames: Map<string, string>,
  runnerNames: Map<string, string>,
): string[] {
  const labels: string[] = [];
  if (item.projectId) labels.push('项目 · ' + (projectNames.get(item.projectId) ?? item.projectId));
  if (item.runnerId) labels.push('Runner · ' + (runnerNames.get(item.runnerId) ?? item.runnerId));
  if (item.source === 'runner-project' && item.cwd) labels.push(item.cwd);
  return labels;
}

function SkillListItem({
  item,
  projectNames,
  runnerNames,
  onOpen,
  onUse,
}: {
  item: SkillCatalogEntryItem;
  projectNames: Map<string, string>;
  runnerNames: Map<string, string>;
  onOpen: () => void;
  onUse: () => void;
}) {
  const reasons = item.applicability.reasons.map((reason) => reason.message);
  return (
    <article className="rounded-2xl border border-slate-200 p-4">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onOpen}
          className="min-w-0 truncate text-left text-sm font-semibold text-slate-800 hover:text-accent"
        >
          {item.name}
        </button>
        <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-500">
          {SKILL_SOURCE_LABELS[item.source]}
        </span>
        <code className="shrink-0 text-[11px] text-slate-500">v{item.version}</code>
        {item.disabled && (
          <span className="shrink-0 rounded bg-rose-50 px-1.5 py-0.5 text-[11px] text-rose-600">已停用</span>
        )}
        {item.shadowedBy && (
          <span className="shrink-0 rounded bg-amber-50 px-1.5 py-0.5 text-[11px] text-amber-700">
            被 {SKILL_SOURCE_LABELS[item.shadowedBy.source]}同名技能遮蔽
          </span>
        )}
        <span
          className={
            'ml-auto shrink-0 text-[11px] ' +
            (item.applicability.status === 'available' ? 'text-emerald-600' : 'text-slate-500')
          }
        >
          {SKILL_APPLICABILITY_LABELS[item.applicability.status]}
        </span>
      </div>
      <p className="mt-2 line-clamp-2 text-xs leading-5 text-slate-500">{item.description}</p>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500">
        <span>适用模式：{allowedModesLabel(item.requirements.allowedModes)}</span>
        <span>工作区：{requirementFlag(item.requirements.requiresWorkspace)}</span>
        {environmentLabels(item, projectNames, runnerNames).map((label) => (
          <span key={label}>{label}</span>
        ))}
      </div>
      {reasons.length > 0 && (
        <ul className="mt-2 space-y-1 text-[11px] text-amber-700" aria-label="不适用原因">
          {reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      )}
      <div className="mt-3 flex items-center gap-2">
        <Button variant="ghost" size="sm" onPress={onOpen}>
          查看详情
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={item.applicability.status === 'unavailable' || item.disabled}
          onPress={onUse}
        >
          <MessagesSquare size={13} />
          在会话中使用
        </Button>
      </div>
    </article>
  );
}

function SkillDetailPanel({
  entry,
  skillId,
  version,
  onClose,
  onUse,
}: {
  entry: SkillCatalogEntryItem | undefined;
  skillId: string;
  version: string | null;
  onClose: () => void;
  onUse: () => void;
}) {
  const detail = useSkillVersionDetailQuery(skillId, version);
  const body = detail.data;
  return (
    <aside
      aria-label="技能详情"
      className="nova-scrollbar sticky top-4 max-h-[calc(100dvh-6rem)] min-w-0 overflow-y-auto rounded-2xl border border-slate-200 bg-white p-4"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold text-slate-800">{entry?.name ?? skillId}</h2>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
            <span>{SKILL_SOURCE_LABELS[entry?.source ?? 'platform']}</span>
            {version && <code>v{version}</code>}
          </p>
        </div>
        <Button variant="ghost" isIconOnly size="sm" aria-label="关闭详情" onPress={onClose}>
          <X size={15} />
        </Button>
      </div>
      {!version && (
        <p role="status" className="mt-4 text-xs text-slate-500">
          未指定版本：请从列表选择技能查看正文。
        </p>
      )}
      {version && detail.error != null && (
        <ErrorNotice error={detail.error} onRetry={() => void detail.refetch()} />
      )}
      {version && detail.isPending && (
        <p role="status" className="mt-4 flex items-center gap-2 text-xs text-slate-500">
          <LoaderCircle size={13} className="animate-spin" aria-hidden="true" />
          正在加载正文…
        </p>
      )}
      {body && (
        <>
          <section className="mt-4">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400">SKILL.md 正文</h3>
            <pre className="nova-scrollbar mt-2 max-h-80 overflow-auto rounded-xl bg-slate-50 p-3 text-[11px] leading-5 whitespace-pre-wrap">
              {body.body}
            </pre>
          </section>
          <section className="mt-4">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400">执行要求</h3>
            <dl className="mt-2 space-y-1 text-xs text-slate-600">
              <div className="flex gap-2">
                <dt className="w-20 shrink-0 text-slate-400">适用模式</dt>
                <dd>{allowedModesLabel(body.requirements.allowedModes)}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-20 shrink-0 text-slate-400">需要工具</dt>
                <dd>{body.requirements.requiredTools.join('、') || '无'}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-20 shrink-0 text-slate-400">工作区</dt>
                <dd>{requirementFlag(body.requirements.requiresWorkspace)}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-20 shrink-0 text-slate-400">文件产出</dt>
                <dd>{requirementFlag(body.requirements.requiresPublishing)}</dd>
              </div>
              {body.sha256 && (
                <div className="flex gap-2">
                  <dt className="w-20 shrink-0 text-slate-400">内容摘要</dt>
                  <dd className="min-w-0 break-all">
                    <code>{body.sha256}</code>
                  </dd>
                </div>
              )}
            </dl>
          </section>
          <section className="mt-4">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400">资源清单</h3>
            {body.resources.length === 0 ? (
              <p className="mt-2 text-xs text-slate-500">本期未开放资源包，清单为空。</p>
            ) : (
              <ul className="mt-2 space-y-1 text-[11px] text-slate-600">
                {body.resources.map((resource) => (
                  <li key={resource.path}>
                    <code>{resource.path}</code> · {resource.size} B
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="mt-4">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400">目录诊断</h3>
            {body.diagnostics.length === 0 ? (
              <p className="mt-2 text-xs text-slate-500">无诊断记录。</p>
            ) : (
              <ul className="mt-2 space-y-1 text-[11px] text-amber-700">
                {body.diagnostics.map((diagnostic, index) => (
                  <li key={diagnostic.code + String(index)}>{diagnostic.message}</li>
                ))}
              </ul>
            )}
          </section>
          <Button
            className="mt-4 w-full"
            variant="secondary"
            disabled={body.applicability.status === 'unavailable' || body.disabled}
            onPress={onUse}
          >
            <MessagesSquare size={14} />
            在会话中使用
          </Button>
        </>
      )}
    </aside>
  );
}

export function SkillsPage() {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as SkillsSearch;
  const projectsQuery = useProjectsQuery();
  const runnersQuery = useRunnersQuery();
  const bindingQuery = useProjectBinding(search.projectId ?? null);
  const catalogQuery = useSkillCatalogQuery({
    ...(search.projectId ? { projectId: search.projectId } : {}),
    ...(search.runnerId ? { runnerId: search.runnerId } : {}),
    ...(search.source ? { source: search.source } : {}),
    ...(search.q ? { q: search.q } : {}),
  });
  const [keyword, setKeyword] = useState(search.q ?? '');
  const [refreshNotice, setRefreshNotice] = useState<string | null>(null);
  const refreshMutation = useRefreshRunnerSkillsMutation();

  useEffect(() => {
    setKeyword(search.q ?? '');
  }, [search.q]);

  const items = useMemo(
    () => catalogQuery.data?.pages.flatMap((page) => page.items) ?? [],
    [catalogQuery.data],
  );
  const catalog = catalogQuery.data?.pages.at(-1)?.catalog ?? null;
  const projectNames = new Map((projectsQuery.data?.items ?? []).map((item) => [item.id, item.name]));
  const runnerNames = new Map(
    (runnersQuery.data?.items ?? []).map((item) => [item.id, item.runnerId || item.id]),
  );
  // projectId 存在时由项目绑定决定 Runner；URL 设备筛选与当前绑定不一致时清理。
  const boundRunnerId = bindingQuery.data?.runnerId ?? null;
  const activeRunnerId = search.projectId ? boundRunnerId : (search.runnerId ?? null);
  useEffect(() => {
    if (!search.projectId || !search.runnerId) return;
    if (boundRunnerId && boundRunnerId !== search.runnerId) {
      void navigate({
        to: '/skills',
        search: (previous) => ({ ...previous, runnerId: undefined }),
        replace: true,
      });
    }
  }, [search.projectId, search.runnerId, boundRunnerId, navigate]);

  function setFilters(patch: Partial<SkillsSearch>) {
    void navigate({
      to: '/skills',
      search: (previous) => ({ ...previous, ...patch }),
      replace: true,
    });
  }
  function openConversation(skill: { id: string; version: string }) {
    // 「在会话中使用」：新会话草稿预选技能标签，发送后才执行（§3.1）。
    void navigate({
      to: '/conversations',
      search: {
        ...(search.projectId ? { projectId: search.projectId } : {}),
        skill,
      },
    });
  }
  function openDetail(item: SkillCatalogEntryItem) {
    setFilters({ skillId: item.id, version: item.version });
  }
  const selectedEntry = search.skillId
    ? items.find((item) => item.id === search.skillId)
    : undefined;
  const creater = items.find((item) => item.id === 'nova.skills-creater');
  const discoveryUnsupported = catalog?.status === 'unsupported';
  const refreshDisabled = !activeRunnerId || discoveryUnsupported || refreshMutation.isPending;
  // 目录就绪但该 Runner 层没有条目：空目录独立成句，不与离线/筛选无结果混同（H5）。
  const localLayerEmpty =
    items.length > 0 &&
    catalog?.status === 'ready' &&
    Boolean(activeRunnerId) &&
    items.every((item) => item.source !== 'runner-global' && item.source !== 'runner-project');

  function refreshLocalSkills() {
    if (!activeRunnerId) return;
    const projectScope =
      search.projectId && boundRunnerId && bindingQuery.data
        ? {
            scope: 'project' as const,
            workspaceId: bindingQuery.data.workspaceId,
            relativeDir: bindingQuery.data.canonicalCwd,
          }
        : { scope: 'global' as const };
    refreshMutation.mutate(
      { runnerId: activeRunnerId, body: projectScope },
      {
        onSuccess: (result) => {
          setRefreshNotice(
            `本地技能已刷新：目录版本 ${result.revision}，状态 ${CATALOG_STATUS_GUIDANCE[result.status].label}。`,
          );
        },
        onError: () => {
          // 刷新失败保留已显示结果：重新读取目录以呈现服务端标记的过期状态。
          void catalogQuery.refetch();
        },
      },
    );
  }

  /** 列表区域：读取失败 → 读取中 → 空目录/筛选无结果/未绑定提示 → 技能列表。 */
  function renderList() {
    if (catalogQuery.error != null)
      return <ErrorNotice error={catalogQuery.error} onRetry={() => void catalogQuery.refetch()} />;
    if (catalogQuery.isPending)
      return (
        <div role="status" className="grid gap-3">
          {[0, 1, 2].map((index) => (
            <div key={index} className="h-32 animate-pulse rounded-2xl bg-slate-100" />
          ))}
          <span className="sr-only">正在读取技能目录</span>
        </div>
      );
    if (items.length === 0) {
      if (search.q || search.source)
        return (
          <div className="rounded-2xl border border-dashed border-slate-200 px-6 py-16 text-center">
            <h2 className="text-sm font-medium text-slate-700">没有匹配的技能</h2>
            <p className="mt-2 text-xs text-slate-500">调整关键词或筛选条件；这与「没有技能」不同。</p>
            <Button
              className="mt-4"
              variant="secondary"
              onPress={() => setFilters({ q: undefined, source: undefined })}
            >
              清除筛选
            </Button>
          </div>
        );
      if (search.projectId && bindingQuery.isError)
        return (
          <div role="alert" className="rounded-2xl border border-slate-200 px-6 py-16 text-center text-sm text-slate-600">
            项目环境暂时无法读取，本地技能列表可能不完整。
            <Button
              variant="ghost"
              size="sm"
              className="ml-2"
              onPress={() => void bindingQuery.refetch()}
            >
              重试
            </Button>
          </div>
        );
      if (discoveryUnsupported)
        return (
          <div className="rounded-2xl border border-dashed border-slate-200 px-6 py-16 text-center">
            <h2 className="text-sm font-medium text-slate-700">{CATALOG_STATUS_GUIDANCE.unsupported.label}</h2>
            <p className="mx-auto mt-2 max-w-md text-xs leading-5 text-slate-500">
              {CATALOG_STATUS_GUIDANCE.unsupported.summary}
            </p>
          </div>
        );
      if (catalog && catalog.status !== 'ready')
        return (
          <div className="rounded-2xl border border-dashed border-slate-200 px-6 py-16 text-center">
            <h2 className="text-sm font-medium text-slate-700">{CATALOG_STATUS_GUIDANCE[catalog.status].label}</h2>
            <p className="mx-auto mt-2 max-w-md text-xs leading-5 text-slate-500">
              {CATALOG_STATUS_GUIDANCE[catalog.status].summary}
            </p>
          </div>
        );
      if (search.runnerId || search.projectId)
        return (
          <div className="rounded-2xl border border-dashed border-slate-200 px-6 py-16 text-center">
            <h2 className="text-sm font-medium text-slate-700">本地技能目录为空</h2>
            <p className="mx-auto mt-2 max-w-md text-xs leading-5 text-slate-500">
              所选 Runner 已完成扫描，但对应目录里还没有符合格式的技能文件；这与设备离线或没有权限不同。
            </p>
            <Button className="mt-4" variant="secondary" onPress={refreshLocalSkills}>
              <RefreshCw size={14} />
              刷新本地技能
            </Button>
          </div>
        );
      return (
        <div className="rounded-2xl border border-dashed border-slate-200 px-6 py-16 text-center">
          <h2 className="text-sm font-medium text-slate-700">当前范围还没有技能</h2>
          <p className="mx-auto mt-2 max-w-md text-xs leading-5 text-slate-500">
            平台技能发布后出现在这里；本机与项目技能由绑定 Runner 上的 .nova 目录发现。
          </p>
          {creater && (
            <Button
              className="mt-4"
              variant="secondary"
              onPress={() => openConversation({ id: creater.id, version: creater.version })}
            >
              <Plus size={14} />
              创建技能
            </Button>
          )}
        </div>
      );
    }
    return (
      <div className="grid gap-3">
        {items.map((item) => (
          <SkillListItem
            key={item.id + '@' + item.version}
            item={item}
            projectNames={projectNames}
            runnerNames={runnerNames}
            onOpen={() => openDetail(item)}
            onUse={() => openConversation({ id: item.id, version: item.version })}
          />
        ))}
        {catalogQuery.hasNextPage && (
          <Button
            variant="ghost"
            disabled={catalogQuery.isFetchingNextPage}
            onPress={() => void catalogQuery.fetchNextPage()}
          >
            {catalogQuery.isFetchingNextPage ? '正在加载…' : '加载更多技能'}
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6 px-5 py-8 sm:px-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 pl-10 lg:pl-0">
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">我的技能</h1>
          <p className="mt-2 text-sm text-slate-500">
            查看平台技能、内置技能与所选设备/项目的本地技能；页面只读取与预选，不会执行技能。
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            disabled={refreshDisabled}
            title={
              activeRunnerId
                ? '调用所选 Runner 的定向刷新'
                : '请先选择设备或已绑定 Runner 的项目'
            }
            onPress={refreshLocalSkills}
          >
            <RefreshCw size={15} className={refreshMutation.isPending ? 'animate-spin' : undefined} />
            刷新本地技能
          </Button>
          {creater && (
            <Button
              variant="secondary"
              onPress={() => openConversation({ id: creater.id, version: creater.version })}
              title="预选技能创建助手"
            >
              <Plus size={15} />
              创建技能
            </Button>
          )}
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-3">
        <label className="flex min-w-0 items-center gap-2 text-xs text-slate-500">
          项目
          <select
            aria-label="按项目筛选"
            className="min-w-0 rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs"
            value={search.projectId ?? ''}
            onChange={(event) =>
              setFilters({
                projectId: event.target.value || undefined,
                runnerId: undefined,
                skillId: undefined,
                version: undefined,
              })
            }
          >
            <option value="">全部项目</option>
            {(projectsQuery.data?.items ?? []).map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-w-0 items-center gap-2 text-xs text-slate-500">
          设备
          <select
            aria-label="按 Runner 筛选"
            disabled={Boolean(search.projectId)}
            className="min-w-0 rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs"
            value={search.runnerId ?? ''}
            onChange={(event) =>
              setFilters({ runnerId: event.target.value || undefined, skillId: undefined, version: undefined })
            }
          >
            <option value="">默认范围</option>
            {(runnersQuery.data?.items ?? []).map((runner) => (
              <option key={runner.id} value={runner.id}>
                {runner.runnerId || runner.id}（{runnerStatus(runner) === 'online' ? '在线' : '离线'}）
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-w-0 items-center gap-2 text-xs text-slate-500">
          来源
          <select
            aria-label="按来源筛选"
            className="min-w-0 rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs"
            value={search.source ?? ''}
            onChange={(event) =>
              setFilters({ source: (event.target.value || undefined) as SkillSource | undefined })
            }
          >
            <option value="">全部来源</option>
            {(Object.keys(SKILL_SOURCE_LABELS) as SkillSource[]).map((source) => (
              <option key={source} value={source}>
                {SKILL_SOURCE_LABELS[source]}
              </option>
            ))}
          </select>
        </label>
        <form
          className="relative min-w-0 flex-1 sm:max-w-72"
          onSubmit={(event) => {
            event.preventDefault();
            setFilters({ q: keyword.trim() || undefined });
          }}
        >
          <Search
            size={14}
            className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-slate-500"
          />
          <Input
            aria-label="搜索技能"
            placeholder="按名称或说明搜索"
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            className="w-full pl-8 text-xs"
          />
        </form>
      </div>

      {search.projectId && !boundRunnerId && !bindingQuery.isPending && !bindingQuery.isError && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-800 ring-1 ring-amber-200">
          <FolderKanban size={14} aria-hidden="true" />
          该项目尚未绑定 Runner 环境，本地技能不可见；内置与平台技能仍可使用。
          <Link to="/projects/$id" params={{ id: search.projectId }} className="font-medium text-accent">
            配置项目环境
          </Link>
        </div>
      )}
      {search.projectId && boundRunnerId && activeRunnerId !== search.runnerId && (
        <p role="status" className="text-xs text-slate-500">
          已按该项目当前绑定的 Runner 查看本地技能。
        </p>
      )}
      {catalog && catalog.status !== 'ready' && (
        <div role="status" className="rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-600">
          <p>{CATALOG_STATUS_GUIDANCE[catalog.status].summary}</p>
          {catalog.diagnostics.slice(0, 3).map((diagnostic, index) => (
            <p key={diagnostic.code + String(index)} className="mt-1 text-amber-700">
              {diagnostic.message}
            </p>
          ))}
        </div>
      )}
      {localLayerEmpty && (
        <p role="status" className="text-xs text-slate-500">
          本地技能目录为空：所选 Runner 已完成扫描，目录里还没有符合格式的技能文件。
        </p>
      )}
      {refreshNotice && (
        <p role="status" className="rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-600">
          {refreshNotice}
        </p>
      )}
      {refreshMutation.error != null && (
        <p role="alert" className="rounded-xl bg-rose-50 px-3 py-2 text-xs text-rose-700 ring-1 ring-rose-200">
          刷新失败，列表保留上次结果并标记过期：{errorMessage(refreshMutation.error)}
        </p>
      )}

      <div className={search.skillId ? 'grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]' : 'grid gap-4'}>
        {renderList()}
        {search.skillId && (
          <SkillDetailPanel
            entry={selectedEntry}
            skillId={search.skillId}
            version={search.version ?? null}
            onClose={() => setFilters({ skillId: undefined, version: undefined })}
            onUse={() => {
              if (search.skillId && search.version)
                openConversation({ id: search.skillId, version: search.version });
            }}
          />
        )}
      </div>
    </div>
  );
}
