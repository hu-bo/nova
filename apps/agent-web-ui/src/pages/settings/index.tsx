import { zodResolver } from "@hookform/resolvers/zod";
import { Cpu, KeyRound, Pencil, Plus, Server, ShieldCheck, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { useAuth } from "../../auth/provider.js";
import { Button } from "../../components/ui/button.js";
import { Card } from "../../components/ui/card.js";
import { Dialog } from "../../components/ui/dialog.js";
import { FieldLabel, Input, Select } from "../../components/ui/form.js";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../components/ui/table.js";
import { useModelSettings, type ModelProfile } from "./model/provider.js";
import { modelProfileSchema, type ModelProfileForm } from "./model/schemas.js";
import { RunnerManager } from "./runner/runner-manager-dialog.js";

const newProfile: ModelProfileForm = {
  providerName: "",
  provider: "openai",
  endpoint: "https://api.openai.com/v1",
  model: "",
  credential: "",
  contextWindow: 200_000,
  maxOutput: 16_384,
  reasoningFormat: "openai",
  thinkingLevels: ["off", "low", "medium", "high"],
  parallelToolCalls: true,
  supportsImages: true,
};

export function SettingsRoute() {
  const auth = useAuth();
  const settings = useModelSettings();
  const [profileOpen, setProfileOpen] = useState(false);
  const [editing, setEditing] = useState<ModelProfile | null>(null);
  const [deleting, setDeleting] = useState<ModelProfile | null>(null);
  const [tab, setTab] = useState<"models" | "runners">("models");
  const form = useForm<ModelProfileForm>({ resolver: zodResolver(modelProfileSchema), defaultValues: newProfile });

  useEffect(() => {
    if (!profileOpen) return;
    form.reset(
      editing
        ? {
            providerName: editing.providerName,
            provider: editing.provider,
            endpoint: editing.endpoint,
            model: editing.model,
            credential: editing.credential,
            contextWindow: editing.contextWindow,
            maxOutput: editing.maxOutput,
            reasoningFormat: editing.reasoningFormat,
            thinkingLevels: editing.thinkingLevels,
            parallelToolCalls: editing.parallelToolCalls,
            supportsImages: editing.supportsImages,
          }
        : newProfile,
    );
  }, [profileOpen, editing, form]);

  function openCreate() {
    setEditing(null);
    setProfileOpen(true);
  }
  function openEdit(profile: ModelProfile) {
    setEditing(profile);
    setProfileOpen(true);
  }
  function saveProfile(values: ModelProfileForm) {
    const id = settings.saveProfile(values, editing?.id);
    if (!settings.defaultProfileId) settings.setDefaultProfileId(id);
    setProfileOpen(false);
  }
  return (
    <div className="mx-auto max-w-5xl p-5 sm:p-6 lg:p-8">
      <div>
        <p className="text-sm font-semibold text-indigo-600">默认配置</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-slate-950 sm:text-3xl">
          让每个新会话从正确的边界开始
        </h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-500">
          模型完整配置保存在当前浏览器的 localStorage；选择模型后会随下一条消息完整下发给服务端 Agent。
        </p>
      </div>

      <div className="mt-8 flex gap-2 border-b border-slate-200" role="tablist" aria-label="设置">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "models"}
          onClick={() => setTab("models")}
          className={`border-b-2 px-4 py-3 text-sm font-semibold ${tab === "models" ? "border-indigo-600 text-indigo-700" : "border-transparent text-slate-500"}`}
        >
          模型配置
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "runners"}
          onClick={() => setTab("runners")}
          className={`border-b-2 px-4 py-3 text-sm font-semibold ${tab === "runners" ? "border-indigo-600 text-indigo-700" : "border-transparent text-slate-500"}`}
        >
          Runner 管理
        </button>
      </div>

      {tab === "models" && (
        <>
          <section className="mt-8" aria-labelledby="models-title">
            <div className="mb-4 flex items-center justify-between gap-4">
              <div>
                <h2 id="models-title" className="text-lg font-semibold text-slate-900">
                  模型配置
                </h2>
                <p className="mt-1 text-sm text-slate-500">创建会话和发送消息时下发完整配置</p>
              </div>
              <Button variant="primary" icon={<Plus className="size-4" aria-hidden="true" />} onClick={openCreate}>
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
                              {profile.source === "server" ? "服务端模型目录" : profile.endpoint}
                            </span>
                          </TableCell>
                          <TableCell>
                            <span
                              className={
                                profile.source === "server" || profile.credential
                                  ? "text-emerald-600"
                                  : "text-amber-600"
                              }
                            >
                              {profile.source === "server"
                                ? "服务端托管"
                                : profile.credential
                                  ? "已加载"
                                  : "需 API Key"}
                            </span>
                          </TableCell>
                          <TableCell>
                            <div className="flex justify-end gap-1">
                              {profile.source === "local" && (
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
                                    onClick={() => setDeleting(profile)}
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
                <Button className="mt-4" variant="primary" onClick={openCreate}>
                  添加第一个配置
                </Button>
              </Card>
            )}
          </section>
        </>
      )}
      {tab === "runners" && (
        <section className="mt-8">
          <RunnerManager
            selectedRunnerId={settings.defaultRunnerId}
            onSelect={(runnerId) => settings.setDefaultRunnerId(runnerId)}
          />
        </section>
      )}

      <Dialog
        open={profileOpen}
        onClose={() => setProfileOpen(false)}
        title={editing ? "编辑模型配置" : "添加模型配置"}
        description="配置将直接用于 model adapter 连接官方或中转商 endpoint。"
        size="lg"
      >
        <form onSubmit={form.handleSubmit(saveProfile)} className="space-y-5">
          <div className="grid gap-5 sm:grid-cols-2">
            <FieldLabel label="配置名称" error={form.formState.errors.providerName?.message}>
              <Input autoFocus placeholder="团队 OpenAI" {...form.register("providerName")} />
            </FieldLabel>
            <FieldLabel label="Wire protocol" error={form.formState.errors.provider?.message}>
              <Select {...form.register("provider")}>
                <option value="openai">OpenAI</option>
                <option value="anthropic">Anthropic</option>
              </Select>
            </FieldLabel>
            <div className="sm:col-span-2">
              <FieldLabel label="Endpoint" hint="必须使用 HTTPS" error={form.formState.errors.endpoint?.message}>
                <Input type="url" placeholder="https://api.openai.com/v1" {...form.register("endpoint")} />
              </FieldLabel>
            </div>
            <FieldLabel label="模型名称" error={form.formState.errors.model?.message}>
              <Input placeholder="gpt-5" {...form.register("model")} />
            </FieldLabel>
            <FieldLabel label="Reasoning format" error={form.formState.errors.reasoningFormat?.message}>
              <Select {...form.register("reasoningFormat")}>
                <option value="none">None</option>
                <option value="openai">OpenAI</option>
                <option value="anthropic">Anthropic</option>
                <option value="deepseek">DeepSeek</option>
                <option value="minimax">MiniMax</option>
              </Select>
            </FieldLabel>
            <FieldLabel label="上下文窗口" error={form.formState.errors.contextWindow?.message}>
              <Input type="number" min="1" {...form.register("contextWindow", { valueAsNumber: true })} />
            </FieldLabel>
            <FieldLabel label="最大输出" error={form.formState.errors.maxOutput?.message}>
              <Input type="number" min="1" {...form.register("maxOutput", { valueAsNumber: true })} />
            </FieldLabel>
            <div className="sm:col-span-2">
              <FieldLabel
                label="API Key"
                hint="随完整配置存入 localStorage"
                error={form.formState.errors.credential?.message}
              >
                <Input type="password" autoComplete="off" placeholder="sk-…" {...form.register("credential")} />
              </FieldLabel>
            </div>
          </div>
          <fieldset>
            <legend className="text-sm font-medium text-slate-700">支持的推理强度</legend>
            <div className="mt-3 flex flex-wrap gap-2">
              {(["off", "low", "medium", "high", "max"] as const).map((level) => (
                <label
                  key={level}
                  className="flex cursor-pointer items-center gap-2 rounded-lg bg-slate-50 px-3 py-2 text-xs font-medium text-slate-600 ring-1 ring-slate-200"
                >
                  <input
                    type="checkbox"
                    value={level}
                    className="accent-indigo-600"
                    {...form.register("thinkingLevels")}
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
              <input type="checkbox" className="size-4 accent-indigo-600" {...form.register("parallelToolCalls")} />
              支持并行工具调用
            </label>
            <label className="flex items-center gap-3 rounded-xl bg-slate-50 p-4 text-sm text-slate-700 ring-1 ring-slate-200">
              <input type="checkbox" className="size-4 accent-indigo-600" {...form.register("supportsImages")} />
              支持图片输入
            </label>
          </div>
          <div className="flex justify-end gap-3 border-t border-slate-100 pt-5">
            <Button type="button" onClick={() => setProfileOpen(false)}>
              取消
            </Button>
            <Button type="submit" variant="primary">
              保存配置
            </Button>
          </div>
        </form>
      </Dialog>

      <Dialog
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        title="删除模型配置"
        description="已创建的历史消息不会改变；新消息将无法再选择它。"
        size="sm"
      >
        <p className="text-sm leading-6 text-slate-600">
          确定删除“{deleting?.providerName}”吗？浏览器 localStorage 中的完整配置也会立即清除。
        </p>
        <div className="mt-6 flex justify-end gap-3">
          <Button onClick={() => setDeleting(null)}>取消</Button>
          <Button
            variant="danger"
            onClick={() => {
              if (deleting) settings.deleteProfile(deleting.id);
              setDeleting(null);
            }}
          >
            删除
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
