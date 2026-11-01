import { describe, expect, it } from 'vitest';
import { toast } from '@heroui/react';
import { notifyOnce } from '../src/lib/notify';
import { notifyApiFailure } from '../src/api/api-notify';

describe('notification deduplication', () => {
  it('keeps one notification per key and refreshes its copy', () => {
    const before = toast.getQueue().visibleToasts.length;
    const first = notifyOnce('api-failure:network', '无法连接服务，请检查网络。');
    const second = notifyOnce('api-failure:network', '无法连接服务，请检查网络。');
    const visible = toast.getQueue().visibleToasts;
    expect(second).toBe(first);
    expect(visible.length).toBe(before + 1);
    expect(visible[visible.length - 1]?.content?.title).toBe('无法连接服务，请检查网络。');
  });

  it('keeps different keys apart', () => {
    const before = toast.getQueue().visibleToasts.length;
    notifyOnce('api-failure:timeout', '请求超时，请重试同一次操作。');
    notifyOnce('api-failure:server', '服务暂时不可用，请稍后重试。');
    expect(toast.getQueue().visibleToasts.length).toBe(before + 2);
  });

  it('merges identical API failures while keeping different business errors visible', () => {
    const before = toast.getQueue().visibleToasts.length;
    notifyApiFailure('request', '请检查填写的内容。');
    notifyApiFailure('request', '请检查填写的内容。');
    notifyApiFailure('request', '权限不足，无法访问此资源。');
    const visible = toast.getQueue().visibleToasts;
    expect(visible.length).toBe(before + 2);
    const titles = visible.map((item) => item.content?.title);
    expect(titles.filter((title) => title === '请检查填写的内容。')).toHaveLength(1);
    expect(titles).toContain('权限不足，无法访问此资源。');
  });
});
