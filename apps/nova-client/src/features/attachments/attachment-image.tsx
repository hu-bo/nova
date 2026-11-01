import { useEffect, useState } from 'react';
import { getAttachmentImageUrl } from '@/api/generated/attachments';
import { errorMessage } from '@/api/api-error';
import { Button } from '@/components/ui/button';
export function AttachmentImage({
  reference,
  name,
}: {
  reference: { conversationId: string; messageId: string; blockId: string };
  name: string;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const { conversationId, messageId, blockId } = reference;
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    setUrl(null);
    setError('');
    void getAttachmentImageUrl(
      { conversationId, messageId, blockId },
      { signal: controller.signal },
    )
      .then((result) => {
        if (controller.signal.aborted) return;
        const parsed = new URL(result.url);
        if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('Invalid preview URL');
        setUrl(result.url);
        timer = setTimeout(
          () => setRevision((value) => value + 1),
          Math.max(1000, Date.parse(result.expiresAt) - Date.now() - 10000),
        );
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(errorMessage(cause));
      });
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [conversationId, messageId, blockId, revision]);
  if (error)
    return (
      <div className="rounded-lg border p-3 text-sm">
        <p>{error}</p>
        <Button variant="ghost" onPress={() => setRevision((value) => value + 1)}>
          重新加载图片
        </Button>
      </div>
    );
  return url ? (
    <a href={url} target="_blank" rel="noreferrer">
      <img
        src={url}
        alt={name}
        loading="lazy"
        className="max-h-72 max-w-full rounded-xl object-contain"
        onError={() => {
          setUrl(null);
          setError('图片暂时无法预览。');
        }}
      />
    </a>
  ) : (
    <p className="text-sm text-muted-foreground">正在加载图片…</p>
  );
}
