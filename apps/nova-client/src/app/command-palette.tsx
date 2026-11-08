import { Description, Header, Label, ListBox } from '@heroui/react';
import { useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Folder, MessageCircle, Plus, Search, Settings, Terminal } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import type { SidebarConversation, SidebarProject } from './sidebar/sidebar.types';

export function CommandPalette({
  projects,
  conversations,
  onClose,
  onNewChat,
  onNewProject,
}: {
  projects: SidebarProject[];
  conversations: SidebarConversation[];
  onClose: () => void;
  onNewChat: () => void;
  onNewProject: () => void;
}) {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const resultsRef = useRef<HTMLDivElement>(null);
  const term = query.trim().toLocaleLowerCase();
  const projectNames = new Map(projects.map((item) => [item.id, item.name]));
  const actions = [
    {
      id: 'new-chat',
      title: '新建会话',
      description: '开始一个新的任务',
      icon: Plus,
      run: onNewChat,
    },
    {
      id: 'new-project',
      title: '新建项目',
      description: '连接目录和工作环境',
      icon: Folder,
      run: onNewProject,
    },
    {
      id: 'projects',
      title: '全部项目',
      description: '查找项目，继续工作',
      icon: Folder,
      run: () => void navigate({ to: '/projects' }),
    },
    {
      id: 'models',
      title: '模型设置',
      description: '模型、服务商和默认配置',
      icon: Settings,
      run: () => void navigate({ to: '/settings/models' }),
    },
    {
      id: 'ssh',
      title: 'SSH 远程',
      description: '管理远程工作环境',
      icon: Terminal,
      run: () => void navigate({ to: '/settings/remotes' }),
    },
  ].filter((item) => (item.title + item.description).toLocaleLowerCase().includes(term));
  const chats = conversations
    .filter((item) =>
      ((item.title || '未命名会话') + (projectNames.get(item.projectId ?? '') ?? ''))
        .toLocaleLowerCase()
        .includes(term),
    )
    .slice(0, term ? 30 : 8);
  const matchingProjects = projects
    .filter((item) => (item.name + (item.workspace ?? '')).toLocaleLowerCase().includes(term))
    .slice(0, term ? 30 : 8);
  const firstChat = chats[0];
  const firstProject = matchingProjects[0];
  let firstId: string | undefined;
  if (firstChat) firstId = 'chat:' + firstChat.id;
  else if (firstProject) firstId = 'project:' + firstProject.id;
  else firstId = actions[0]?.id;
  function select(id: string) {
    onClose();
    if (id.startsWith('chat:'))
      void navigate({ to: '/conversations/$id', params: { id: id.slice(5) } });
    else if (id.startsWith('project:'))
      void navigate({ to: '/projects/$id', params: { id: id.slice(8) } });
    else actions.find((item) => item.id === id)?.run();
  }
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent size="lg" placement="top">
        <DialogHeader>
          <DialogTitle>快速查找</DialogTitle>
        </DialogHeader>
        <div className="px-6 pt-4">
          <label className="relative block">
            <Search
              size={16}
              className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              autoFocus
              aria-label="查找最近会话、项目或操作"
              placeholder="查找最近会话、项目或操作…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="w-full pl-9"
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return;
                if (event.key === 'ArrowDown') {
                  event.preventDefault();
                  resultsRef.current?.querySelector<HTMLElement>('[role="option"]')?.focus();
                }
                if (event.key === 'Enter' && firstId) {
                  event.preventDefault();
                  select(firstId);
                }
              }}
            />
          </label>
        </div>
        <div ref={resultsRef} className="max-h-[min(52dvh,420px)] overflow-y-auto px-4 py-3">
          {chats.length + matchingProjects.length + actions.length === 0 ? (
            <p role="status" className="px-2 py-10 text-center text-sm text-muted-foreground">
              没有匹配结果，试试会话标题或项目名称。
            </p>
          ) : (
            <ListBox
              aria-label="查找结果"
              selectionMode="none"
              onAction={(key) => select(String(key))}
            >
              {chats.length > 0 && (
                <ListBox.Section>
                  <Header>最近会话</Header>
                  {chats.map((item) => (
                    <ListBox.Item
                      key={item.id}
                      id={'chat:' + item.id}
                      textValue={item.title || '未命名会话'}
                    >
                      <MessageCircle size={16} className="shrink-0 text-muted-foreground" />
                      <div className="min-w-0 flex-1">
                        <Label className="block truncate">{item.title || '未命名会话'}</Label>
                        <Description>
                          {projectNames.get(item.projectId ?? '') ?? '普通会话'}
                          {item.activeRunId ? ' · 执行中' : ''}
                        </Description>
                      </div>
                    </ListBox.Item>
                  ))}
                </ListBox.Section>
              )}
              {matchingProjects.length > 0 && (
                <ListBox.Section>
                  <Header>项目</Header>
                  {matchingProjects.map((item) => (
                    <ListBox.Item key={item.id} id={'project:' + item.id} textValue={item.name}>
                      <Folder size={16} className="shrink-0 text-muted-foreground" />
                      <div className="min-w-0 flex-1">
                        <Label className="block truncate">{item.name}</Label>
                        <Description className="block truncate">
                          {item.workspace ?? '配置项目工作环境'}
                        </Description>
                      </div>
                    </ListBox.Item>
                  ))}
                </ListBox.Section>
              )}
              {actions.length > 0 && (
                <ListBox.Section>
                  <Header>操作</Header>
                  {actions.map((item) => (
                    <ListBox.Item key={item.id} id={item.id} textValue={item.title}>
                      <item.icon size={16} className="shrink-0 text-muted-foreground" />
                      <div>
                        <Label>{item.title}</Label>
                        <Description>{item.description}</Description>
                      </div>
                    </ListBox.Item>
                  ))}
                </ListBox.Section>
              )}
            </ListBox>
          )}
        </div>
        <div className="flex flex-wrap justify-between gap-2 border-t px-6 py-3 text-xs text-muted-foreground">
          <span>搜索已加载的最近 100 条会话与项目</span>
          <span>↑ ↓ 选择 · Enter 打开 · Esc 关闭</span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
