import { Eye, FileText, Download } from 'lucide-react';
import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { errorMessage } from '@/api/api-error';
import { ErrorNotice } from '@/components/error-notice';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { runPresentation } from '@/features/runs';
import type { RunView } from '@nova/agent-ui-contracts';
import {
  ARTIFACT_PREVIEW_ACTIONS,
  ARTIFACT_STATE_BADGES,
  formatArtifactSize,
  type ArtifactEntry,
} from './artifacts.display';
import { useArtifactDownloadMutation, useArtifactPreviewQuery } from './artifacts.queries';

export type ArtifactsPanelProps = {
  /** 已合并分页的产物列表（来自 useConversationArtifactsQuery）。 */
  artifacts: readonly ArtifactEntry[];
  isPending: boolean;
  error: unknown;
  onRetry: () => void;
  /** 对象存储能力位（client-config capabilities.uploads）；false 时展示「存储未配置」。 */
  storageConfigured: boolean | undefined;
  /** 当前运行视图（id+state）：产物属于该 Run 时展示来源 Run 结果徽标。 */
  run: Pick<RunView, 'id' | 'state'> | null | undefined;
};

/** 用短期签名 URL 触发一次浏览器下载；URL 不缓存、不持久化（§5.2）。 */
function openSignedDownload(url: string, name: string) {
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.rel = 'noreferrer noopener';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}

function ArtifactDownloadButton({ artifact }: { artifact: ArtifactEntry }) {
  const download = useArtifactDownloadMutation();
  return (
    <Button
      variant="outline"
      size="xs"
      disabled={download.isPending}
      onPress={() =>
        download.mutate(artifact.id, {
          onSuccess: (file) => openSignedDownload(file.url, file.name || artifact.name),
        })
      }
    >
      <Download size={12} />
      {download.isPending ? '正在获取下载链接…' : '下载'}
    </Button>
  );
}

/** 内嵌预览：markdown/text 用现有 Markdown 渲染，image 用签名 URL；download 形态不可预览。 */
function ArtifactPreviewBody({ artifactId }: { artifactId: string }) {
  const preview = useArtifactPreviewQuery(artifactId);
  if (preview.isPending)
    return (
      <p role="status" className="mt-2 text-xs text-slate-400">
        正在加载预览…
      </p>
    );
  if (preview.error)
    return (
      <p role="alert" className="mt-2 break-words text-xs text-rose-600">
        {errorMessage(preview.error)}
      </p>
    );
  const data = preview.data;
  if (!data) return null;
  if (data.kind === 'image')
    return (
      <div className="mt-2 overflow-hidden rounded-lg ring-1 ring-slate-200">
        <img src={data.url} alt={data.name} className="max-h-64 w-full object-contain" />
      </div>
    );
  if (data.kind === 'download')
    return <p className="mt-2 text-xs text-slate-500">该文件类型不支持内嵌预览，请下载后查看。</p>;
  return (
    <div className="nova-scrollbar mt-2 max-h-72 overflow-auto rounded-lg bg-slate-50 p-3 text-xs leading-5 text-slate-700 ring-1 ring-slate-200">
      {data.truncated && (
        <p className="mb-2 text-[10px] text-slate-400">预览内容已截断，完整文件请下载查看。</p>
      )}
      {data.kind === 'markdown' ? (
        <div className="[&_a]:underline [&_code]:rounded [&_code]:bg-slate-100 [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[11px] [&_h1]:text-sm [&_h1]:font-semibold [&_h2]:text-[13px] [&_h2]:font-semibold [&_h3]:font-semibold [&_li]:my-0.5 [&_ol]:list-decimal [&_ol]:pl-4 [&_p]:my-1 [&_pre]:overflow-x-auto [&_pre]:font-mono [&_pre]:text-[11px] [&_ul]:list-disc [&_ul]:pl-4">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{data.text}</ReactMarkdown>
        </div>
      ) : (
        <pre className="whitespace-pre-wrap break-all font-mono text-[11px] leading-5">
          {data.text}
        </pre>
      )}
    </div>
  );
}

function ArtifactCard({
  artifact,
  run,
}: {
  artifact: ArtifactEntry;
  run: ArtifactsPanelProps['run'];
}) {
  const [previewOpen, setPreviewOpen] = useState(false);
  const badge = ARTIFACT_STATE_BADGES[artifact.state];
  const preview = ARTIFACT_PREVIEW_ACTIONS[artifact.preview];
  // 来源 Run 结果：优先用列表附带的 runState（历史 Run 也可显示）；
  // 兼容旧数据缺失时按当前运行视图匹配。
  const sourceRunState = artifact.runState ?? (run && artifact.runId === run.id ? run.state : null);
  const ready = artifact.state === 'ready';
  return (
    <article
      className="rounded-xl border border-slate-200 bg-white p-3 text-xs"
      aria-label={`产物 ${artifact.name}`}
    >
      <div className="flex min-w-0 items-center gap-2">
        <FileText className="size-4 shrink-0 text-slate-400" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate font-medium text-slate-800" title={artifact.name}>
          {artifact.name}
        </span>
        <Badge variant={badge.variant}>{badge.label}</Badge>
      </div>
      <p className="mt-1.5 flex flex-wrap items-center gap-x-2 text-slate-500">
        <span>{formatArtifactSize(artifact.size)}</span>
        <span aria-hidden="true">·</span>
        <span>{artifact.mimeType}</span>
      </p>
      {sourceRunState && (
        <p className="mt-1.5 flex items-center gap-1.5 text-slate-500">
          <span
            className={'size-1.5 rounded-full ' + runPresentation[sourceRunState].indicator}
            aria-hidden="true"
          />
          来源运行：{runPresentation[sourceRunState].label}
        </p>
      )}
      {artifact.state === 'failed' && (
        <p className="mt-1.5 break-words text-rose-600" role="alert">
          {artifact.error?.message ?? '发布失败，未返回具体原因。'}
        </p>
      )}
      {badge.hint && <p className="mt-1.5 text-slate-400">{badge.hint}</p>}
      {ready && (
        <div className="mt-2 flex flex-wrap gap-2">
          {preview.previewable && (
            <Button
              variant="outline"
              size="xs"
              aria-expanded={previewOpen}
              onPress={() => setPreviewOpen((open) => !open)}
            >
              <Eye size={12} />
              {previewOpen ? '收起预览' : preview.label}
            </Button>
          )}
          <ArtifactDownloadButton artifact={artifact} />
        </div>
      )}
      {ready && previewOpen && preview.previewable && (
        <ArtifactPreviewBody artifactId={artifact.id} />
      )}
    </article>
  );
}

/**
 * 会话侧栏「产物」面板（P1-G1）：数据来自列表查询（工作区挂载），此处按
 * 加载 / 失败 / 存储未配置 / 空态 / 卡片 的优先级单链路渲染。
 */
export function ArtifactsPanel({
  artifacts,
  isPending,
  error,
  onRetry,
  storageConfigured,
  run,
}: ArtifactsPanelProps) {
  return (
    <section className="rounded-xl border border-slate-200 bg-slate-50/40 p-4" aria-label="产物">
      <h2 className="text-xs font-semibold text-slate-500">产物</h2>
      <div className="mt-1 space-y-3">
        {isPending && artifacts.length === 0 && (
          <p role="status" className="text-xs text-slate-500">
            正在加载产物…
          </p>
        )}
        {!isPending && error != null && <ErrorNotice error={error} onRetry={onRetry} />}
        {!isPending && error == null && artifacts.length === 0 && storageConfigured === false && (
          <p className="text-xs leading-5 text-slate-500">
            存储未配置：文件产出暂不可用，产物需要服务端配置对象存储后才能发布。
          </p>
        )}
        {!isPending && error == null && artifacts.length === 0 && storageConfigured !== false && (
          <p className="text-xs text-slate-500">没有产物</p>
        )}
        {artifacts.map((artifact) => (
          <ArtifactCard key={artifact.id} artifact={artifact} run={run} />
        ))}
      </div>
    </section>
  );
}
