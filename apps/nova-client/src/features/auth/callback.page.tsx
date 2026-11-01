import { useEffect, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Button } from '@/components/ui/button';
import { useIdentity } from './identity.context';
export function CallbackPage() {
  const { handleCallback, login, identity } = useIdentity();
  const navigate = useNavigate();
  const started = useRef(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    // Account providers remount after identity changes; a completed callback has no code left.
    if (
      identity &&
      !new URLSearchParams(window.location.search).has('code') &&
      !new URLSearchParams(window.location.search).has('error')
    ) {
      void navigate({ to: '/conversations', replace: true });
      return;
    }
    void handleCallback()
      .then((ok) => {
        if (ok) void navigate({ to: '/conversations', replace: true });
        else setFailed(true);
      })
      .catch(() => setFailed(true));
  }, [handleCallback, navigate, identity]);
  return (
    <div className="grid min-h-[60vh] place-items-center">
      <div className="text-center">
        <h1 className="text-xl font-semibold">{failed ? '登录未能完成' : '正在完成登录…'}</h1>
        {failed && (
          <Button className="mt-4" onPress={() => void login().catch(() => setFailed(true))}>
            重新登录
          </Button>
        )}
      </div>
    </div>
  );
}
