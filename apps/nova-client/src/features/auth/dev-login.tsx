import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useIdentity } from './identity.context';
export default function DevLoginCard() {
  const { devLogin } = useIdentity();
  // 必须是合法 RFC 4122 v4 形态: 服务端响应 DTO 用 zod uuid() 校验(仅接受版本位 1-8 / variant 位 8-b),
  // 全 0 段的伪 UUID 会让序列化失败并把接口打成 500。
  const [token, setToken] = useState('dev:00000000-0000-4000-8000-000000000001:dev-identity');
  const [error, setError] = useState('');
  function submit(event: FormEvent) {
    event.preventDefault();
    try {
      devLogin?.(token);
    } catch {
      setError('开发令牌格式不正确。');
    }
  }
  return (
    <form onSubmit={submit} className="mt-6 border-t pt-5">
      <p className="mb-3 text-xs text-muted-foreground">本地开发登录 · 令牌仅保存在内存</p>
      <label htmlFor="dev-token" className="sr-only">
        开发令牌
      </label>
      <Input id="dev-token" value={token} onChange={(event) => setToken(event.target.value)} />
      {error && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {error}
        </p>
      )}
      <Button type="submit" variant="outline" className="mt-3 w-full">
        进入本地工作台
      </Button>
    </form>
  );
}
