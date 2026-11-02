import { zodResolver } from '@hookform/resolvers/zod';
import { Cpu, Pencil, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ErrorNotice } from '@/components/error-notice';
import { SettingsDialog } from '@/components/ui/settings-dialog';
import { ConfirmationDialog } from '@/components/ui/confirmation-dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { FieldLabel, Input, Select } from '@/lib/form';
import {
  emptyModelProfile,
  modelProfileSchema,
  PROVIDERS,
  REASONING_FORMATS,
  THINKING_LEVELS,
  type ModelProfileForm,
} from './schemas';
import { useModelSettings } from './provider';
import { profileToFormValues, type ModelProfile } from './model-context';

/** Manage server-backed model profiles and legacy local configurations. */
export function ModelsTab() {
  const settings = useModelSettings();
  const [profileOpen, setProfileOpen] = useState(false);
  const [editing, setEditing] = useState<ModelProfile | null>(null);
  const [deleting, setDeleting] = useState<ModelProfile | null>(null);
  const [saveError, setSaveError] = useState<unknown>(null);
  const form = useForm<ModelProfileForm>({
    resolver: zodResolver(modelProfileSchema),
    defaultValues: emptyModelProfile(),
  });

  useEffect(() => {
    if (!profileOpen) return;
    form.reset(editing ? profileToFormValues(editing) : emptyModelProfile());
  }, [profileOpen, editing, form]);

  function openCreate() {
    setSaveError(null);
    setEditing(null);
    setProfileOpen(true);
  }
  function openEdit(profile: ModelProfile) {
    setSaveError(null);
    setEditing(profile);
    setProfileOpen(true);
  }
  async function saveProfile(values: ModelProfileForm) {
    if ((!editing || editing.source === 'local') && !values.credential.trim()) {
      form.setError('credential', { message: '请输入 API Key' });
      return;
    }
    setSaveError(null);
    try {
      const id = await settings.saveProfile(values, editing?.id);
      if (!settings.defaultProfileId) settings.setDefaultProfileId(id);
      setProfileOpen(false);
    } catch (error) {
      setSaveError(error);
    }
  }

  return (
    <>
      <section aria-labelledby="models-title">
        <div className="mb-4 flex items-center justify-between gap-4">
          <div>
            <h2 id="models-title" className="text-lg font-semibold text-slate-900">
              模型配置
            </h2>
            <p className="mt-1 text-sm text-slate-500">
              配置和凭据加密保存在服务端，聊天时可切换模型与推理强度
            </p>
          </div>
          <Button
            variant="default"
            icon={<Plus className="size-4" aria-hidden="true" />}
            onPress={openCreate}
          >
            添加配置
          </Button>
        </div>
        {settings.profiles.length ? (
          <Card className="overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>配置</TableHead>
                  <TableHead>模型</TableHead>
                  <TableHead>Endpoint</TableHead>
                  <TableHead>凭据</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {settings.profiles.map((profile) => {
                  const isDefault = profile.id === settings.defaultProfileId;
                  return (
                    <TableRow key={profile.id}>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Cpu className="size-4 text-indigo-600" />
                          <strong>{profile.providerName}</strong>
                          {isDefault && (
                            <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-[10px] font-semibold text-indigo-700">
                              默认
                            </span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>{profile.model}</TableCell>
                      <TableCell>
                        <span className="block max-w-64 truncate" title={profile.endpoint}>
                          {profile.source === 'server' && !profile.editable
                            ? '服务端模型目录'
                            : profile.endpoint}
                        </span>
                      </TableCell>
                      <TableCell>
                        <span
                          className={
                            profile.source === 'server' || profile.credential
                              ? 'text-emerald-600'
                              : 'text-amber-600'
                          }
                        >
                          {profile.source === 'server'
                            ? '已加密保存'
                            : profile.credential
                              ? '已加载'
                              : '需 API Key'}
                        </span>
                      </TableCell>
                      <TableCell>
                        <div className="flex justify-end gap-1">
                          {(profile.source === 'local' || profile.editable) && (
                            <>
                              <button
                                type="button"
                                className="rounded-lg p-2 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
                                aria-label={`编辑 ${profile.providerName}`}
                                onClick={() => openEdit(profile)}
                              >
                                <Pencil className="size-4" aria-hidden="true" />
                              </button>
                              <button
                                type="button"
                                className="rounded-lg p-2 text-slate-400 transition hover:bg-rose-50 hover:text-rose-600"
                                aria-label={`删除 ${profile.providerName}`}
                                onClick={() => {
                                  setSaveError(null);
                                  setDeleting(profile);
                                }}
                              >
                                <Trash2 className="size-4" aria-hidden="true" />
                              </button>
                            </>
                          )}
                          {!isDefault && (
                            <button
                              type="button"
                              className="text-xs font-semibold text-indigo-600 hover:text-indigo-800"
                              onClick={() => settings.setDefaultProfileId(profile.id)}
                            >
                              设为默认
                            </button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </Card>
        ) : (
          <Card className="p-8 text-center">
            <Cpu className="mx-auto size-7 text-slate-300" />
            <p className="mt-3 font-medium text-slate-800">没有可用的模型配置</p>
            <Button className="mt-4" variant="default" onPress={openCreate}>
              添加第一个配置
            </Button>
          </Card>
        )}
        {settings.catalogError != null && (
          <div className="mt-4">
            <ErrorNotice error={settings.catalogError} />
          </div>
        )}
      </section>

      <SettingsDialog
        open={profileOpen}
        onClose={() => {
          if (!settings.saving) setProfileOpen(false);
        }}
        title={editing ? '编辑模型配置' : '添加模型配置'}
        description="配置模型服务地址与凭据，保存后可在会话中选择。"
        size="lg"
        icon={<Cpu />}
        isPending={settings.saving}
        onSubmit={form.handleSubmit(saveProfile)}
        footer={
          <>
            <Button
              type="button"
              variant="ghost"
              disabled={settings.saving}
              onPress={() => setProfileOpen(false)}
            >
              取消
            </Button>
            <Button type="submit" variant="default" disabled={settings.saving}>
              {settings.saving ? '保存中…' : '保存配置'}
            </Button>
          </>
        }
      >
        <div className="space-y-5">
          <div className="grid gap-5 sm:grid-cols-2">
            <FieldLabel label="配置名称" error={form.formState.errors.providerName?.message}>
              <Input autoFocus placeholder="团队 OpenAI" {...form.register('providerName')} />
            </FieldLabel>
            <FieldLabel label="Wire protocol" error={form.formState.errors.provider?.message}>
              <Select {...form.register('provider')}>
                {PROVIDERS.map((value) => (
                  <option key={value} value={value}>
                    {value === 'openai' ? 'OpenAI' : 'Anthropic'}
                  </option>
                ))}
              </Select>
            </FieldLabel>
            <div className="sm:col-span-2">
              <FieldLabel
                label="Endpoint"
                hint="HTTPS 或本机 HTTP 地址"
                error={form.formState.errors.endpoint?.message}
              >
                <Input
                  type="url"
                  placeholder="https://api.openai.com/v1"
                  {...form.register('endpoint')}
                />
              </FieldLabel>
            </div>
            <FieldLabel label="模型名称" error={form.formState.errors.model?.message}>
              <Input placeholder="gpt-5" {...form.register('model')} />
            </FieldLabel>
            <FieldLabel
              label="Reasoning format"
              error={form.formState.errors.reasoningFormat?.message}
            >
              <Select {...form.register('reasoningFormat')}>
                {REASONING_FORMATS.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </Select>
            </FieldLabel>
            <FieldLabel label="上下文窗口" error={form.formState.errors.contextWindow?.message}>
              <Input
                type="number"
                min="1"
                {...form.register('contextWindow', { valueAsNumber: true })}
              />
            </FieldLabel>
            <FieldLabel label="最大输出" error={form.formState.errors.maxOutput?.message}>
              <Input
                type="number"
                min="1"
                {...form.register('maxOutput', { valueAsNumber: true })}
              />
            </FieldLabel>
            <div className="sm:col-span-2">
              <FieldLabel
                label="API Key"
                hint={
                  editing?.source === 'server' ? '留空保留已保存的凭据' : '仅提交到服务端加密保存'
                }
                error={form.formState.errors.credential?.message}
              >
                <Input
                  type="password"
                  autoComplete="off"
                  placeholder="sk-…"
                  {...form.register('credential')}
                />
              </FieldLabel>
            </div>
          </div>
          <fieldset>
            <legend className="text-sm font-medium text-slate-700">支持的推理强度</legend>
            <div className="mt-3 flex flex-wrap gap-2">
              {THINKING_LEVELS.map((level) => (
                <label
                  key={level}
                  className="flex cursor-pointer items-center gap-2 rounded-lg bg-slate-50 px-3 py-2 text-xs font-medium text-slate-600 ring-1 ring-slate-200"
                >
                  <input
                    type="checkbox"
                    value={level}
                    className="accent-indigo-600"
                    {...form.register('thinkingLevels')}
                  />
                  {level}
                </label>
              ))}
            </div>
            {form.formState.errors.thinkingLevels?.message && (
              <p role="alert" className="mt-2 text-xs text-rose-600">
                {form.formState.errors.thinkingLevels.message}
              </p>
            )}
          </fieldset>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex items-center gap-3 rounded-xl bg-slate-50 p-4 text-sm text-slate-700 ring-1 ring-slate-200">
              <input
                type="checkbox"
                className="size-4 accent-indigo-600"
                {...form.register('parallelToolCalls')}
              />
              支持并行工具调用
            </label>
            <label className="flex items-center gap-3 rounded-xl bg-slate-50 p-4 text-sm text-slate-700 ring-1 ring-slate-200">
              <input
                type="checkbox"
                className="size-4 accent-indigo-600"
                {...form.register('supportsImages')}
              />
              支持图片输入
            </label>
          </div>
          {saveError != null && <ErrorNotice error={saveError} />}
        </div>
      </SettingsDialog>

      <ConfirmationDialog
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        title="删除模型配置"
        subject={deleting?.providerName}
        description="配置和保存的凭据会清除，新消息将无法再选择它。已有消息历史会保留。"
        confirmLabel="删除配置"
        pendingLabel="正在删除…"
        isPending={settings.saving}
        error={saveError}
        onConfirm={() => {
          if (!deleting) return;
          void settings
            .deleteProfile(deleting.id)
            .then(() => setDeleting(null))
            .catch(setSaveError);
        }}
      />
    </>
  );
}
