import { LoaderCircle, MessageCircle, Trash2 } from 'lucide-react';
import { NavItem } from './nav-item';
import type { SidebarConversation } from './sidebar.types';

export function ConversationNavItem({
  conversation,
  to,
  onClick,
  onDelete,
}: {
  conversation: SidebarConversation;
  to: string;
  onClick?: (() => void) | undefined;
  onDelete: (conversation: SidebarConversation) => void;
}) {
  const isRunning = Boolean(conversation.activeRunId);
  return (
    <div className="group relative">
      <NavItem
        to={to}
        icon={
          isRunning ? (
            <span className="relative flex size-4 items-center justify-center">
              <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
              <span className="sr-only">正在处理中</span>
            </span>
          ) : (
            <MessageCircle className="size-4" aria-hidden="true" />
          )
        }
        label={conversation.title || '未命名会话'}
        onClick={onClick}
        className="pr-11"
      />
      <button
        type="button"
        className="absolute top-1/2 right-2 grid size-7 -translate-y-1/2 place-items-center rounded-lg text-slate-500 opacity-100 lg:opacity-0 hover:bg-rose-50 hover:text-rose-600 group-hover:opacity-100 group-focus-within:opacity-100"
        disabled={isRunning}
        title={isRunning ? '任务执行中，请先停止运行' : '删除会话'}
        aria-label={`删除 ${conversation.title || '未命名会话'}`}
        onClick={() => onDelete(conversation)}
      >
        <Trash2 className="size-3.5" />
      </button>
    </div>
  );
}
