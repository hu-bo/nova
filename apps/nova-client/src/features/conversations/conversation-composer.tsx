import { Button } from '@/components/ui/button';
import { ErrorNotice } from '@/components/error-notice';
import { statusLabel, IMAGE_ACCEPT } from '@/features/attachments';
import type { ConversationComposerController } from './use-conversation-composer';

/**
 * 上传队列条 + 隐藏文件输入。nova-dsh 的图片上传需要先取票、上传、校验 sha256，
 * 就绪前在 composer 上方展示进度与重试/移除入口（参考实现无此流程，直接以附件 chip 呈现）。
 *
 * 控制器 hook 在 `use-conversation-composer.ts`（react-refresh 规则要求
 * 组件文件不混出 hook）。
 */
export function ComposerUploads({ controller }: { controller: ConversationComposerController }) {
  const { uploads, fileInputRef, blocked, sending } = controller;
  return (
    <div className="shrink-0 space-y-2">
      <input
        ref={fileInputRef}
        type="file"
        aria-label="选择本地图片"
        hidden
        multiple
        accept={IMAGE_ACCEPT}
        onChange={(event) => {
          if (event.target.files) uploads.add(event.target.files);
          event.target.value = '';
        }}
      />
      {uploads.entries.length > 0 && (
        <ul aria-label="上传队列" className="space-y-2">
          {uploads.entries.map((entry) => (
            <li
              key={entry.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-surface px-3 py-2 text-xs"
            >
              <span className="min-w-0 break-all">
                {entry.file.name} · {statusLabel(entry.status)}
              </span>
              <div className="flex gap-1">
                {entry.status === 'failed' && (
                  <Button
                    variant="ghost"
                    disabled={sending}
                    onPress={() => uploads.retry(entry.id)}
                  >
                    重试上传
                  </Button>
                )}
                <Button
                  variant="ghost"
                  disabled={sending}
                  aria-label={`移除附件 ${entry.file.name}`}
                  onPress={() => uploads.remove(entry.id)}
                >
                  移除
                </Button>
              </div>
              {entry.error != null && (
                <div className="w-full">
                  <ErrorNotice error={entry.error} />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {blocked && (
        <p role="status" className="text-xs text-muted-foreground">
          请等待附件就绪，或重试、移除失败的附件后发送。
        </p>
      )}
    </div>
  );
}
