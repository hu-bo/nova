import { lazy } from 'react';
import type { Chat as ChatComponent } from '@nova/chat-ui';
import type { Composer as ComposerComponent } from '@nova/chat-ui';
import type { RemoteExplorer as RemoteExplorerComponent } from '@nova/chat-ui';

/**
 * 独立入口按需加载，避免远程文件选择或轻量菜单拉入完整消息渲染器。
 * git-diff-view 在 chat-ui 内部仍通过动态 chunk 加载。
 *
 * cast 保留原组件的泛型签名（`<Chat<Attachment> …>`）。
 */
export const Chat = lazy(() =>
  import('@nova/chat-ui/chat').then((module) => ({ default: module.Chat })),
) as unknown as typeof ChatComponent;
export const Composer = lazy(() =>
  import('@nova/chat-ui/composer').then((module) => ({ default: module.Composer })),
) as unknown as typeof ComposerComponent;
export const RemoteExplorer = lazy(() =>
  import('@nova/chat-ui/remote-explorer').then((module) => ({ default: module.RemoteExplorer })),
) as unknown as typeof RemoteExplorerComponent;
