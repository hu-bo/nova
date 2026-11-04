import { ApiError } from '@/api/api-error';
import { deleteRemoteConnection, testRemoteConnection } from '@/api/generated/remotes';
import { ErrorNotice } from '@/components/error-notice';
import { Button } from '@/components/ui/button';
import { ConfirmationDialog } from '@/components/ui/confirmation-dialog';
import { SettingsDialog } from '@/components/ui/settings-dialog';
import { RemoteExplorer } from '@nova/chat-ui/remote-explorer';
import { useMutation } from '@tanstack/react-query';
import {
  CheckCircle2,
  FolderOpen,
  LoaderCircle,
  Pencil,
  Plus,
  Server,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import { useState } from 'react';
import { RemoteEditor } from './remote-editor';
import {
  loadRemoteDirectory,
  useRemoteConnectionsQuery,
  type RemoteConnection,
} from './remote.queries';

/** 连接状态徽章呈现；未列出的状态一律回落为「待验证」。 */
const STATUS_BADGE_BY_STATE: Record<string, { className: string; label: string }> = {
  verified: { className: 'bg-success/10 text-success', label: '已验证' },
  offline: { className: 'bg-danger/10 text-danger', label: '连接失败' },
};

const UNVERIFIED_BADGE = { className: 'bg-slate-100 text-slate-500', label: '待验证' };

export function RemoteConnectionsPage() {
  const connections = useRemoteConnectionsQuery();
  const [editor, setEditor] = useState<RemoteConnection | 'new' | null>(null);
  const [deleting, setDeleting] = useState<RemoteConnection | null>(null);
  const [browsing, setBrowsing] = useState<RemoteConnection | null>(null);
  const [trust, setTrust] = useState<{
    connection: RemoteConnection;
    fingerprint: string;
    changed: boolean;
  } | null>(null);
  const [notice, setNotice] = useState('');
  const test = useMutation({
    mutationFn: (input: { connection: RemoteConnection; fingerprint?: string }) =>
      testRemoteConnection(input.connection.id, {
        ...(input.fingerprint ? { fingerprint: input.fingerprint } : {}),
      }),
    onSuccess: async (receipt, input) => {
      if (receipt.status === 'trust_required')
        setTrust({
          connection: input.connection,
          fingerprint: receipt.fingerprint,
          changed: false,
        });
      else {
        setTrust(null);
        setNotice(input.connection.name + ' 连接测试成功，工作目录可访问。');
      }
      await connections.refetch();
    },
    onError: (error, input) => {
      if (
        error instanceof ApiError &&
        error.details?.reason === 'SSH_HOST_KEY_CHANGED' &&
        typeof error.details.fingerprint === 'string'
      )
        setTrust({
          connection: input.connection,
          fingerprint: error.details.fingerprint,
          changed: true,
        });
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => deleteRemoteConnection(id),
    onSuccess: async () => {
      setDeleting(null);
      await connections.refetch();
    },
  });
  return (
    <section className="space-y-5">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">SSH 远程连接</h2>
          <p className="mt-1 text-sm text-slate-500">
            连接你的开发服务器，浏览工作目录并绑定到项目。
          </p>
        </div>
        <Button onPress={() => setEditor('new')}>
          <Plus size={16} />
          添加连接
        </Button>
      </header>
      {notice && (
        <p role="status" className="flex items-center gap-2 rounded-xl bg-success/10 p-3 text-sm">
          <CheckCircle2 size={16} />
          {notice}
        </p>
      )}
      {connections.error && (
        <ErrorNotice error={connections.error} onRetry={() => void connections.refetch()} />
      )}
      {test.error && !trust && <ErrorNotice error={test.error} />}
      {connections.isPending && (
        <p role="status" className="p-6 text-sm text-slate-500">
          正在加载远程连接…
        </p>
      )}
      {!connections.isPending && !connections.error && !connections.data?.items.length && (
        <div className="rounded-2xl border border-dashed border-slate-200 p-10 text-center">
          <Server className="mx-auto size-8 text-slate-400" />
          <h3 className="mt-4 font-semibold">把远程开发环境带进工作台</h3>
          <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-slate-500">
            保存 SSH 主机、用户名和工作目录，测试成功后就能在新建项目中选择它。
          </p>
          <Button className="mt-5" variant="outline" onPress={() => setEditor('new')}>
            配置第一个 SSH 连接
          </Button>
        </div>
      )}
      <div className="space-y-3">
        {connections.data?.items.map((connection) => (
          <article key={connection.id} className="rounded-2xl border border-slate-200 bg-white p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="flex min-w-0 items-start gap-3">
                <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-slate-100 text-slate-500">
                  <Server size={19} />
                </span>
                <div className="min-w-0">
                  <h3 className="font-semibold">{connection.name}</h3>
                  <p className="mt-1 break-all font-mono text-xs text-slate-500">
                    {connection.username + '@' + connection.hostname + ':' + connection.port}
                  </p>
                </div>
              </div>
              <span
                className={
                  'rounded-full px-2.5 py-1 text-xs ' +
                  (STATUS_BADGE_BY_STATE[connection.status] ?? UNVERIFIED_BADGE).className
                }
              >
                {(STATUS_BADGE_BY_STATE[connection.status] ?? UNVERIFIED_BADGE).label}
              </span>
            </div>
            <p className="mt-4 flex items-center gap-2 break-all text-sm text-slate-600">
              <FolderOpen size={15} className="shrink-0" />
              {connection.rootPath}
            </p>
            {connection.hostFingerprint && (
              <p
                className="mt-2 truncate font-mono text-[11px] text-slate-400"
                title={connection.hostFingerprint}
              >
                {connection.hostFingerprint}
              </p>
            )}
            <div className="mt-4 flex flex-wrap gap-2 border-t border-slate-100 pt-4">
              <Button
                variant="outline"
                disabled={test.isPending}
                onPress={() => {
                  test.reset();
                  setNotice('');
                  test.mutate({ connection });
                }}
              >
                {test.isPending && test.variables?.connection.id === connection.id ? (
                  <LoaderCircle size={15} className="animate-spin" />
                ) : (
                  <ShieldCheck size={15} />
                )}
                测试连接
              </Button>
              <Button
                variant="ghost"
                disabled={!connection.hostFingerprint}
                onPress={() => setBrowsing(connection)}
              >
                <FolderOpen size={15} />
                浏览目录
              </Button>
              <Button variant="ghost" onPress={() => setEditor(connection)}>
                <Pencil size={15} />
                编辑
              </Button>
              <Button
                variant="ghost"
                isIconOnly
                aria-label={'删除连接 ' + connection.name}
                onPress={() => setDeleting(connection)}
              >
                <Trash2 size={15} />
              </Button>
            </div>
          </article>
        ))}
      </div>
      {editor && (
        <RemoteEditor
          connection={editor === 'new' ? null : editor}
          onClose={() => setEditor(null)}
          onSaved={() => void connections.refetch()}
        />
      )}
      <SettingsDialog
        open={Boolean(trust)}
        title={trust?.changed ? 'SSH 主机指纹已变化' : '确认 SSH 主机指纹'}
        description="请与服务器管理员提供的指纹核对后继续。"
        onClose={() => {
          if (!test.isPending) setTrust(null);
        }}
        size="sm"
        icon={<ShieldCheck />}
        isPending={test.isPending}
        footer={
          <>
            <Button variant="ghost" disabled={test.isPending} onPress={() => setTrust(null)}>
              取消
            </Button>
            <Button
              disabled={test.isPending}
              onPress={() => {
                if (trust)
                  test.mutate({ connection: trust.connection, fingerprint: trust.fingerprint });
              }}
            >
              {test.isPending ? '连接中…' : '信任并连接'}
            </Button>
          </>
        }
      >
        <p className="text-sm">{trust?.connection.username + '@' + trust?.connection.hostname}</p>
        <p className="mt-4 break-all rounded-xl bg-slate-50 p-4 font-mono text-xs">
          {trust?.fingerprint}
        </p>
        {test.error && (
          <div className="mt-3">
            <ErrorNotice error={test.error} />
          </div>
        )}
      </SettingsDialog>
      <ConfirmationDialog
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        title="删除 SSH 连接"
        subject={deleting?.name}
        description="连接配置和保存的凭据会移除，引用它的项目需要重新绑定环境。远程文件会保留。"
        confirmLabel="删除连接"
        pendingLabel="正在删除…"
        isPending={remove.isPending}
        error={remove.error}
        onConfirm={() => {
          if (deleting) remove.mutate(deleting.id);
        }}
      />
      {browsing && (
        <RemoteExplorer
          open
          title={'远程目录 · ' + browsing.name}
          mode="directory"
          initialPath="/"
          loadDirectory={(path, signal) => loadRemoteDirectory(browsing.id, path, signal)}
          onClose={() => setBrowsing(null)}
          onConfirm={() => setBrowsing(null)}
        />
      )}
    </section>
  );
}
