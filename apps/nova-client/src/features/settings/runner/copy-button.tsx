import { Button } from '@/components/ui/button';
import { copyText } from '@/lib/clipboard';
import { Check, Clipboard } from 'lucide-react';
import { useState } from 'react';

export function CopyButton({
  value,
  label,
  compact = false,
}: {
  value: string | null;
  label: string;
  compact?: boolean;
}) {
  const [copiedValue, setCopiedValue] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [copying, setCopying] = useState(false);
  const copied = Boolean(value && copiedValue === value);
  return (
    <Button
      size={compact ? 'sm' : 'default'}
      variant="outline"
      icon={copied ? <Check /> : <Clipboard />}
      disabled={!value || copying}
      {...(failed ? { title: '自动复制失败，请重试或手动复制' } : {})}
      onPress={async () => {
        if (!value || copying) return;
        setFailed(false);
        setCopying(true);
        try {
          await copyText(value);
          setCopiedValue(value);
        } catch {
          setFailed(true);
        } finally {
          setCopying(false);
        }
      }}
    >
      {failed ? '复制失败，重试' : copied ? '已复制' : copying ? '正在复制…' : label}
    </Button>
  );
}
