import { getReadiness } from './generated/health';
// 健康探测在后台轮询，失败由调用方自行判断，不弹通知（silent）。
export async function serverReady(signal?: AbortSignal) {
  try {
    const response = await getReadiness({
      ...(signal ? { signal } : {}),
      timeoutMs: 5000,
      silent: true,
    });
    return response.status === 'ok';
  } catch {
    return false;
  }
}
