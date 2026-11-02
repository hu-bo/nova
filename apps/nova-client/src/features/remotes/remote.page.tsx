import { useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { RemoteExplorer } from '@nova/chat-ui/remote-explorer';
import {
  CheckCircle2,
  FileText,
  FolderOpen,
  KeyRound,
  LoaderCircle,
  Pencil,
  Plus,
  Server,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import {
  createRemoteConnection,
  deleteRemoteConnection,
  testRemoteConnection,
  updateRemoteConnection,
} from '@/api/generated/remotes';
import { ApiError } from '@/api/api-error';
import {
  invalidateCredentialTransportKey,
  isCredentialEnvelopeInvalid,
  sealRemoteCredential,
} from '@/api/credential-transport';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { SettingsDialog } from '@/components/ui/settings-dialog';
import { ConfirmationDialog } from '@/components/ui/confirmation-dialog';
import { ErrorNotice } from '@/components/error-notice';
import { FieldLabel, Select } from '@/lib/form';
import {
  loadRemoteDirectory,
  useRemoteConnectionsQuery,
  type RemoteConnection,
} from './remote.queries';

const remoteFormSchema = z.object({
  name: z.string().trim().min(1, '请输入连接名称'),
  hostname: z.string().trim().min(1, '请输入主机地址'),
  port: z.number().int().min(1).max(65535),
  username: z.string().trim().min(1, '请输入 SSH 用户名'),
  rootPath: z.string().trim().startsWith('/', '请输入绝对路径，例如 /home/dev/projects'),
  authMethod: z.enum(['private_key', 'password']),
  credential: z.string(),
  passphrase: z.string(),
});
type RemoteForm = z.infer<typeof remoteFormSchema>;

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

function RemoteEditor({
  connection,
  onClose,
  onSaved,
}: {
  connection: RemoteConnection | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const form = useForm<RemoteForm>({
    resolver: zodResolver(remoteFormSchema),
    defaultValues: connection
      ? {
          name: connection.name,
          hostname: connection.hostname,
          port: connection.port ?? 22,
          username: connection.username,
          rootPath: connection.rootPath,
          authMethod: connection.authMethod,
          credential: '',
          passphrase: '',
        }
      : {
          name: '',
          hostname: '',
          port: 22,
          username: '',
          rootPath: '/',
          authMethod: 'private_key',
          credential: '',
          passphrase: '',
        },
  });
  const save = useMutation({
    mutationFn: async (values: RemoteForm) => {
      const { credential, passphrase, ...fields } = values;
      // 凭据先封装成传输信封再提交, 请求体里不出现明文密码或私钥。
      const submit = async () => {
        const sealed = credential
          ? {
              credential: await sealRemoteCredential(credential),
              // 空串表示清除已保存的私钥口令。
              passphrase: passphrase ? await sealRemoteCredential(passphrase) : '',
            }
          : null;
        if (connection)
          return updateRemoteConnection(connection.id, {
            ...fields,
            ...(sealed ?? {}),
          });
        return createRemoteConnection({
          ...fields,
          credential: sealed?.credential ?? '',
          ...(sealed?.passphrase ? { passphrase: sealed.passphrase } : {}),
        });
      };
      try {
        return await submit();
      } catch (error) {
        // 服务端主密钥轮换后旧信封无法解密, 换新传输密钥重试一次。
        if (!isCredentialEnvelopeInvalid(error)) throw error;
        invalidateCredentialTransportKey();
        return await submit();
      }
    },
    onSuccess: () => {
      form.reset();
      onSaved();
      onClose();
    },
  });
  const authMethod = form.watch('authMethod');
  const keyFileInput = useRef<HTMLInputElement>(null);
  const [keyFileName, setKeyFileName] = useState<string | null>(null);
  return (
    <SettingsDialog
      open
      title={connection ? '编辑 SSH 连接' : '添加 SSH 连接'}
      description="凭据只提交到服务端加密保存，浏览器不会保存密码或私钥。"
      icon={<Server />}
      isPending={save.isPending}
      onSubmit={form.handleSubmit((values) => {
        if (!connection && !values.credential.trim()) {
          form.setError('credential', {
            message: authMethod === 'password' ? '请输入密码' : '请输入或选择私钥',
          });
          return;
        }
        save.mutate(values);
      })}
      footer={
        <>
          <Button variant="ghost" disabled={save.isPending} onPress={onClose}>
            取消
          </Button>
          <Button type="submit" disabled={save.isPending}>
            {save.isPending ? '保存中…' : '保存连接'}
          </Button>
        </>
      }
      onClose={() => {
        if (!save.isPending) onClose();
      }}
    >
      <div className="space-y-4">
        <FieldLabel label="连接名称" error={form.formState.errors.name?.message}>
          <Input autoFocus placeholder="例如 开发服务器" {...form.register('name')} />
        </FieldLabel>
        <div className="grid gap-4 sm:grid-cols-[1fr_100px]">
          <FieldLabel label="主机" error={form.formState.errors.hostname?.message}>
            <Input placeholder="192.168.1.20 或 dev.example.com" {...form.register('hostname')} />
          </FieldLabel>
          <FieldLabel label="端口" error={form.formState.errors.port?.message}>
            <Input
              type="number"
              min="1"
              max="65535"
              {...form.register('port', { valueAsNumber: true })}
            />
          </FieldLabel>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <FieldLabel label="SSH 用户名" error={form.formState.errors.username?.message}>
            <Input placeholder="dev" {...form.register('username')} />
          </FieldLabel>
          <FieldLabel label="认证方式">
            <Select {...form.register('authMethod')}>
              <option value="private_key">SSH 私钥</option>
              <option value="password">密码</option>
            </Select>
          </FieldLabel>
        </div>
        <FieldLabel label="远程工作目录" error={form.formState.errors.rootPath?.message}>
          <Input placeholder="/home/dev/projects" {...form.register('rootPath')} />
        </FieldLabel>
        <FieldLabel
          label={authMethod === 'private_key' ? '私钥' : '密码'}
          hint={connection ? '留空保留已保存的凭据' : undefined}
          error={form.formState.errors.credential?.message}
        >
          {authMethod === 'private_key' ? (
            <Textarea
              rows={4}
              className="resize-none"
              placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
              {...form.register('credential')}
            />
          ) : (
            <Input type="password" autoComplete="new-password" {...form.register('credential')} />
          )}
        </FieldLabel>
        {authMethod === 'private_key' && (
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <input
                ref={keyFileInput}
                type="file"
                className="hidden"
                onChange={async (event) => {
                  const file = event.target.files?.[0];
                  event.target.value = '';
                  if (!file) return;
                  if (file.size > 65536) {
                    form.setError('credential', { message: '私钥文件不能超过 64 KiB' });
                    setKeyFileName(null);
                    return;
                  }
                  form.setValue('credential', await file.text(), { shouldValidate: true });
                  setKeyFileName(file.name);
                }}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onPress={() => keyFileInput.current?.click()}
              >
                <KeyRound size={14} />
                从本机选择私钥
              </Button>
              {keyFileName ? (
                <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                  <FileText size={13} className="shrink-0" aria-hidden="true" />
                  <span className="truncate">{keyFileName}</span>
                </span>
              ) : (
                <span className="text-xs text-muted-foreground">也可以直接粘贴私钥内容</span>
              )}
            </div>
            <FieldLabel label="私钥口令" hint="可选">
              <Input type="password" autoComplete="new-password" {...form.register('passphrase')} />
            </FieldLabel>
          </div>
        )}
        {save.error && <ErrorNotice error={save.error} />}
      </div>
    </SettingsDialog>
  );
}
