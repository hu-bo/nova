import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Link, useParams, useSearch } from '@tanstack/react-router';
import { ArrowLeft, GripVertical, Layers3, MessageSquare } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ErrorNotice } from '@/components/error-notice';
import { ConversationView } from '@/features/conversations';
import { useProjectQuery } from '@/features/projects';
import { LocalStore } from '@/lib/local-store';
import { useSpecQuery } from './spec.queries';
import { SpecWorkbench } from './specs-panel';

const paneWidthStore = new LocalStore<number>('nova_spec_workbench_width', 56);
const clampWidth = (value: number) => Math.min(68, Math.max(32, value));

export function SpecPage() {
  const { id } = useParams({ strict: false });
  const { projectId = '' } = useSearch({ strict: false });
  const project = useProjectQuery(projectId || null);
  const current = useSpecQuery(projectId, id ?? null);
  const [mobilePane, setMobilePane] = useState<'workbench' | 'chat'>('workbench');
  const [workbenchWidth, setWorkbenchWidth] = useState(() => {
    const stored = paneWidthStore.get();
    return typeof stored === 'number' && Number.isFinite(stored) ? clampWidth(stored) : 56;
  });
  const [resizing, setResizing] = useState(false);
  const panes = useRef<HTMLDivElement>(null);
  useEffect(() => {
    paneWidthStore.set(workbenchWidth);
  }, [workbenchWidth]);
  const paneStyle: CSSProperties & { '--spec-width': string } = {
    '--spec-width': workbenchWidth + '%',
  };
  if (!id) return null;
  return (
    <div className="flex h-dvh min-h-0 flex-col bg-background">
      <header className="flex min-h-16 shrink-0 items-center gap-3 border-b bg-surface px-5 pl-16 lg:pl-6">
        <Link
          to="/conversations"
          search={projectId ? { projectId } : {}}
          aria-label="返回项目 Chat"
          className="text-muted-foreground hover:text-accent"
        >
          <ArrowLeft size={18} />
        </Link>
        <Layers3 size={20} className="shrink-0 text-accent" />
        <div className="min-w-0">
          <h1 className="truncate text-sm font-semibold">{current.data?.title ?? 'Spec 工作台'}</h1>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {project.data?.name ?? '项目'} · SDD 模式
          </p>
        </div>
      </header>
      <div className="flex shrink-0 gap-2 border-b p-2 lg:hidden">
        <Button
          variant={mobilePane === 'workbench' ? 'secondary' : 'ghost'}
          onPress={() => setMobilePane('workbench')}
        >
          <Layers3 size={14} />
          规格工作台
        </Button>
        <Button
          variant={mobilePane === 'chat' ? 'secondary' : 'ghost'}
          onPress={() => setMobilePane('chat')}
        >
          <MessageSquare size={14} />
          专用会话
        </Button>
      </div>
      {current.error ? (
        <ErrorNotice error={current.error} onRetry={() => void current.refetch()} />
      ) : (
        <div
          ref={panes}
          style={paneStyle}
          className={
            'grid min-h-0 flex-1 lg:grid-cols-[minmax(0,var(--spec-width))_12px_minmax(0,1fr)] ' +
            (resizing ? 'select-none' : '')
          }
        >
          <section
            id="spec-workbench-pane"
            aria-label="规格工作台"
            className={
              'min-h-0 min-w-0 overflow-y-auto p-4 sm:p-6 ' +
              (mobilePane === 'workbench' ? '' : 'hidden lg:block')
            }
          >
            <SpecWorkbench key={id} projectId={projectId} specId={id} />
          </section>
          <div
            role="separator"
            tabIndex={0}
            aria-label="调整规格与会话宽度"
            aria-orientation="vertical"
            aria-controls="spec-workbench-pane spec-chat-pane"
            aria-valuemin={32}
            aria-valuemax={68}
            aria-valuenow={Math.round(workbenchWidth)}
            aria-valuetext={
              '规格 ' +
              Math.round(workbenchWidth) +
              '%，会话 ' +
              Math.round(100 - workbenchWidth) +
              '%'
            }
            className="group hidden touch-none cursor-col-resize items-center justify-center border-x bg-muted/20 text-muted-foreground transition-colors hover:bg-accent/10 hover:text-accent focus-visible:bg-accent/10 focus-visible:outline-2 focus-visible:outline-accent lg:flex"
            onPointerDown={(event) => {
              event.preventDefault();
              event.currentTarget.setPointerCapture(event.pointerId);
              setResizing(true);
            }}
            onPointerMove={(event) => {
              if (!event.currentTarget.hasPointerCapture(event.pointerId) || !panes.current) return;
              const rect = panes.current.getBoundingClientRect();
              setWorkbenchWidth(clampWidth(((event.clientX - rect.left) / rect.width) * 100));
            }}
            onPointerUp={(event) => {
              if (event.currentTarget.hasPointerCapture(event.pointerId))
                event.currentTarget.releasePointerCapture(event.pointerId);
              setResizing(false);
            }}
            onPointerCancel={() => setResizing(false)}
            onLostPointerCapture={() => setResizing(false)}
            onDoubleClick={() => setWorkbenchWidth(56)}
            onKeyDown={(event) => {
              const increment = event.shiftKey ? 10 : 2;
              if (event.key === 'ArrowLeft') {
                event.preventDefault();
                setWorkbenchWidth((width) => clampWidth(width - increment));
              }
              if (event.key === 'ArrowRight') {
                event.preventDefault();
                setWorkbenchWidth((width) => clampWidth(width + increment));
              }
              if (event.key === 'Home') {
                event.preventDefault();
                setWorkbenchWidth(32);
              }
              if (event.key === 'End') {
                event.preventDefault();
                setWorkbenchWidth(68);
              }
            }}
          >
            <GripVertical size={12} aria-hidden="true" />
          </div>
          <aside
            id="spec-chat-pane"
            aria-label="规格专用会话"
            className={
              'min-h-0 min-w-0 bg-surface ' + (mobilePane === 'chat' ? '' : 'hidden lg:block')
            }
          >
            {current.data && <ConversationView id={current.data.conversationId} embedded />}
          </aside>
        </div>
      )}
    </div>
  );
}
