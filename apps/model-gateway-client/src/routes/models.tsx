import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Boxes, BrainCircuit, Pencil, Plus, Power, Trash2 } from "lucide-react";
import { useState } from "react";
import { createModel, deleteModel, listModels, listProviders, updateModel, type CreateModel, type Model } from "../api/client.js";
import { queryKeys } from "../api/query-keys.js";
import { ConfirmDialog } from "../components/confirm-dialog.js";
import { PageHeader, StatusBadge, TableFrame, tableCellClass, tableHeadClass } from "../components/page.js";
import { Button } from "../components/ui/button.js";
import { Card } from "../components/ui/card.js";
import { EmptyState, ErrorState, LoadingState } from "../components/ui/feedback.js";
import { ModelForm } from "../models/model-form.js";

type Confirmation = { kind: "disable" | "delete"; model: Model } | null;

export function ModelsRoute() {
  const queryClient = useQueryClient();
  const modelsQuery = useQuery({ queryKey: queryKeys.models, queryFn: ({ signal }) => listModels({ signal }) });
  const providersQuery = useQuery({ queryKey: queryKeys.providers, queryFn: ({ signal }) => listProviders({ signal }) });
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Model | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation>(null);
  const saveMutation = useMutation({ mutationFn: (input: CreateModel) => editing ? updateModel(editing.id, input) : createModel(input), onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: queryKeys.models }); } });
  const stateMutation = useMutation({ mutationFn: ({ model, enabled }: { model: Model; enabled: boolean }) => updateModel(model.id, toModelInput(model, enabled)), onSuccess: async () => { setConfirmation(null); await queryClient.invalidateQueries({ queryKey: queryKeys.models }); } });
  const deleteMutation = useMutation({ mutationFn: (model: Model) => deleteModel(model.id), onSuccess: async () => { setConfirmation(null); await queryClient.invalidateQueries({ queryKey: queryKeys.models }); } });
  const models = modelsQuery.data ?? [];
  const providers = providersQuery.data ?? [];
  const error = modelsQuery.error ?? providersQuery.error;

  return (
    <div className="space-y-8">
      <PageHeader eyebrow="Catalog" title="模型目录" description="统一公开模型名，精确描述上游映射、上下文、Reasoning 能力和结算价格。" action={<Button variant="primary" disabled={providers.length === 0} icon={<Plus className="size-4" aria-hidden="true" />} onClick={() => { setEditing(null); setFormOpen(true); }}>注册模型</Button>} />
      {providers.length === 0 && !providersQuery.isLoading && !providersQuery.error && <div className="rounded-xl bg-amber-50 p-4 text-sm text-amber-800 ring-1 ring-amber-200">请先在 Provider 页面添加连接，再注册模型。</div>}
      {modelsQuery.isLoading || providersQuery.isLoading ? <LoadingState label="正在加载模型目录" /> : error ? <ErrorState error={error} onRetry={() => { void modelsQuery.refetch(); void providersQuery.refetch(); }} /> : models.length === 0 ? <Card><EmptyState icon={<Boxes className="size-5" />} title="还没有注册模型" description="注册后，Agent 才能按公开模型名选择经过验证的能力配置。" action={providers.length ? <Button variant="primary" onClick={() => setFormOpen(true)}>注册第一个模型</Button> : undefined} /></Card> : <TableFrame><table className="w-full min-w-[1100px]"><thead className={tableHeadClass}><tr><th className="px-5 py-3">公开名称</th><th className="px-5 py-3">上游映射</th><th className="px-5 py-3">容量</th><th className="px-5 py-3">Reasoning</th><th className="px-5 py-3">价格（入 / 出 / 缓存）</th><th className="px-5 py-3">状态</th><th className="px-5 py-3 text-right">操作</th></tr></thead><tbody className="divide-y divide-slate-100">{models.map(model => <tr key={model.id} className="transition hover:bg-slate-50/70"><td className={tableCellClass}><p className="font-semibold text-slate-900">{model.publicName}</p><p className="mt-1 text-xs text-slate-400">{model.inputModalities.join(" + ")} · {model.parallelToolCalls ? "并行工具" : "串行工具"}</p></td><td className={tableCellClass}><p className="font-medium text-slate-700">{model.providerName}</p><p className="mt-1 font-mono text-xs text-slate-400">{model.upstreamName}</p></td><td className={tableCellClass}><p>{formatTokens(model.contextWindow)}</p><p className="mt-1 text-xs text-slate-400">输出 {formatTokens(model.maxOutput)}</p></td><td className={tableCellClass}><span className="inline-flex items-center gap-1.5"><BrainCircuit className="size-4 text-indigo-500" />{model.reasoningFormat}</span><p className="mt-1 text-xs text-slate-400">{model.thinkingLevels.length ? model.thinkingLevels.join(" / ") : "不支持 thinking"}</p></td><td className={`${tableCellClass} font-mono text-xs`}>{model.priceIn} / {model.priceOut} / {model.priceCacheRead}</td><td className={tableCellClass}><StatusBadge enabled={model.enabled} /></td><td className={`${tableCellClass} text-right`}><div className="flex justify-end gap-1"><Button variant="ghost" className="min-h-9 px-3" icon={<Pencil className="size-4" />} onClick={() => { setEditing(model); setFormOpen(true); }}>编辑</Button><Button variant="ghost" className="min-h-9 px-3" icon={<Power className="size-4" />} onClick={() => model.enabled ? setConfirmation({ kind: "disable", model }) : stateMutation.mutate({ model, enabled: true })}>{model.enabled ? "停用" : "启用"}</Button><Button variant="ghost" className="min-h-9 px-3 text-rose-600 hover:bg-rose-50 hover:text-rose-700" aria-label={`删除 ${model.publicName}`} onClick={() => setConfirmation({ kind: "delete", model })}><Trash2 className="size-4" /></Button></div></td></tr>)}</tbody></table></TableFrame>}
      <ModelForm open={formOpen} model={editing} providers={providers} pending={saveMutation.isPending} onClose={() => { setFormOpen(false); setEditing(null); }} onSubmit={input => saveMutation.mutateAsync(input)} />
      <ConfirmDialog open={confirmation !== null} title={confirmation?.kind === "delete" ? `删除 ${confirmation.model.publicName}` : `停用 ${confirmation?.model.publicName ?? "模型"}`} description={confirmation?.kind === "delete" ? "该公开模型名将不会被复用，历史用量仍保留原关联。" : "后续新配置将不能选择该模型，已有运行不会被中断。"} confirmLabel={confirmation?.kind === "delete" ? "确认删除" : "确认停用"} danger={confirmation?.kind === "delete"} pending={stateMutation.isPending || deleteMutation.isPending} onClose={() => setConfirmation(null)} onConfirm={() => { if (!confirmation) return; if (confirmation.kind === "delete") deleteMutation.mutate(confirmation.model); else stateMutation.mutate({ model: confirmation.model, enabled: false }); }} />
    </div>
  );
}

function formatTokens(value: number) { return value >= 1000 ? `${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 }).format(value / 1000)}K` : String(value); }
function toModelInput(model: Model, enabled: boolean): CreateModel { return { publicName: model.publicName, providerId: model.providerId, upstreamName: model.upstreamName, contextWindow: model.contextWindow, maxOutput: model.maxOutput, thinkingLevels: model.thinkingLevels, parallelToolCalls: model.parallelToolCalls, reasoningFormat: model.reasoningFormat, inputModalities: model.inputModalities, enabled, priceIn: model.priceIn, priceOut: model.priceOut, priceCacheRead: model.priceCacheRead }; }
