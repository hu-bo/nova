import {
  invalidateCredentialTransportKey,
  isCredentialEnvelopeInvalid,
  sealRemoteCredential,
} from '@/api/credential-transport';
import { createRemoteConnection, updateRemoteConnection } from '@/api/generated/remotes';
import { ErrorNotice } from '@/components/error-notice';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SettingsDialog } from '@/components/ui/settings-dialog';
import { Textarea } from '@/components/ui/textarea';
import { FieldLabel, Select } from '@/lib/form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { FileText, KeyRound, Server } from 'lucide-react';
import { useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { type RemoteConnection } from './remote.queries';

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

/** 依次封装凭据与口令，保持原有封装顺序；passphrase 为空串表示清除已保存的私钥口令。 */
async function sealCredentialPair(credential: string, passphrase: string) {
  const sealedCredential = await sealRemoteCredential(credential);
  const sealedPassphrase = passphrase ? await sealRemoteCredential(passphrase) : '';
  return { credential: sealedCredential, passphrase: sealedPassphrase };
}

export function RemoteEditor({
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
        const sealed = credential ? await sealCredentialPair(credential, passphrase) : null;
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
