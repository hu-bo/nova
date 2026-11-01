import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { getConversationSnapshot, listConversationMessages } from '@/api/generated/conversations';
import type { ListConversationMessages200ItemsItem } from '@/api/generated/projectsAPI.schemas';

const record = z.record(z.string(), z.unknown());
function fence(content: string, language = '') {
  const tick = String.fromCharCode(96);
  const longest = (content.match(new RegExp(tick + '+', 'g')) ?? []).reduce(
    (length, value) => Math.max(length, value.length),
    2,
  );
  const marker = tick.repeat(longest + 1);
  return marker + language.replace(/[^a-zA-Z0-9_-]/g, '') + '\n' + content + '\n' + marker;
}
function renderBlock(raw: unknown): string {
  const parsed = record.safeParse(raw);
  if (!parsed.success) return fence(JSON.stringify(raw) ?? '', 'json');
  const block = parsed.data;
  const text = typeof block.text === 'string' ? block.text : '';
  switch (block.type) {
    case 'text':
      return text;
    case 'thinking':
      return '### 推理\n\n' + text;
    case 'code':
      return (
        (typeof block.path === 'string' ? block.path + '\n\n' : '') +
        fence(
          typeof block.code === 'string' ? block.code : '',
          typeof block.language === 'string' ? block.language : '',
        )
      );
    case 'diff':
      return (
        (typeof block.path === 'string' ? block.path + '\n\n' : '') +
        fence(typeof block.diff === 'string' ? block.diff : '', 'diff')
      );
    case 'custom':
      return typeof block.fallback === 'string' ? block.fallback : '';
    case 'file':
    case 'image':
      return fence(JSON.stringify(block.attachment, null, 2), 'json');
    case 'tool_result':
      return (
        '### 工具结果\n\n' +
        (Array.isArray(block.content)
          ? block.content.map(renderBlock).join('\n\n')
          : fence(JSON.stringify(block), 'json'))
      );
    case 'error':
      return (
        '### 错误\n\n' +
        (typeof block.error === 'object' && block.error && 'message' in block.error
          ? String(block.error.message)
          : '')
      );
    default:
      return fence(JSON.stringify(block, null, 2), 'json');
  }
}

async function downloadConversation(
  id: string,
  signal: AbortSignal,
  progress: (count: number) => void,
) {
  const snapshot = await getConversationSnapshot(id, { signal });
  const messages = new Map<string, ListConversationMessages200ItemsItem>();
  for (const message of snapshot.messages) messages.set(message.id, message);
  let before = snapshot.beforeSequence;
  const seen = new Set<string>();
  progress(messages.size);
  while (before) {
    signal.throwIfAborted();
    if (seen.has(before)) throw new Error('历史分页游标重复，导出已停止，请重试。');
    seen.add(before);
    const page = await listConversationMessages(id, { before }, { signal });
    for (const message of page.items)
      if (!messages.has(message.id)) messages.set(message.id, message);
    before = page.beforeSequence;
    progress(messages.size);
  }
  signal.throwIfAborted();
  const title = snapshot.conversation.title || '未命名会话';
  const lines = [
    '# ' + title.replace(/\r?\n/g, ' '),
    '导出时间：' + new Date().toLocaleString('zh-CN'),
    '包含导出开始时的已保存历史及当前草稿；执行中的输出可能继续更新。附件保留元数据，文件内容不包含在导出中。',
    ...Array.from(messages.values())
      .sort((a, b) =>
        BigInt(a.sequence) < BigInt(b.sequence)
          ? -1
          : BigInt(a.sequence) > BigInt(b.sequence)
            ? 1
            : 0,
      )
      .map(
        (message) =>
          '## ' +
          { user: '你', assistant: 'Nova', tool: '工具', system: '系统' }[message.role] +
          ' · ' +
          message.createdAt +
          '\n\n' +
          message.blocks.map(renderBlock).join('\n\n'),
      ),
  ];
  const url = URL.createObjectURL(
    new Blob([lines.join('\n\n---\n\n') + '\n'], { type: 'text/markdown;charset=utf-8' }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download =
    (Array.from(title, (character) => (character.charCodeAt(0) < 32 ? '_' : character))
      .join('')
      .replace(/[<>:"/\\|?*]/g, '_')
      .slice(0, 100)
      .replace(/[. ]+$/g, '') || 'conversation') + '.md';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function useConversationExport(id: string, owner: string) {
  const controller = useRef<AbortController | null>(null);
  const [count, setCount] = useState<number | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(
    () => () => {
      controller.current?.abort();
      controller.current = null;
    },
    [id, owner],
  );
  async function start() {
    if (controller.current) return;
    const pending = new AbortController();
    controller.current = pending;
    setCount(0);
    setError(null);
    const timeout = setTimeout(() => pending.abort(new Error('导出超时，请稍后重试。')), 60_000);
    try {
      await downloadConversation(id, pending.signal, setCount);
    } catch (cause) {
      if (controller.current === pending) setError(cause);
    } finally {
      clearTimeout(timeout);
      if (controller.current === pending) {
        controller.current = null;
        setCount(null);
      }
    }
  }
  return { count, error, start };
}
