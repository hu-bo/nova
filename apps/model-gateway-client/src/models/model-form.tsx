import { zodResolver } from "@hookform/resolvers/zod";
import { LoaderCircle } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { ApiClientError, type CreateModel, type Model, type Provider } from "../api/client.js";
import { Button } from "../components/ui/button.js";
import { Dialog } from "../components/ui/dialog.js";
import { FieldLabel, Input, Select } from "../components/ui/form.js";

const price = z.string().regex(/^\d+(\.\d{1,8})?$/, "请输入非负金额，最多 8 位小数");
const modelSchema = z
  .object({
    publicName: z.string().trim().min(1, "请输入公开模型名").max(100),
    providerId: z.string().min(1, "请选择 Provider"),
    upstreamName: z.string().trim().min(1, "请输入上游模型名").max(150),
    contextWindow: z.number().int().positive("必须大于 0"),
    maxOutput: z.number().int().positive("必须大于 0"),
    thinkingLevels: z.array(z.enum(["off", "low", "medium", "high", "max"])),
    parallelToolCalls: z.boolean(),
    reasoningFormat: z.enum(["none", "openai", "anthropic", "deepseek", "minimax"]),
    inputModalities: z.array(z.enum(["text", "image"])),
    enabled: z.boolean(),
    priceIn: price,
    priceOut: price,
    priceCacheRead: price,
  })
  .check(({ value: values, issues }) => {
    if (values.maxOutput > values.contextWindow)
      issues.push({ input: values.maxOutput, code: "custom", path: ["maxOutput"], message: "不能超过上下文窗口" });
    if (!values.inputModalities.includes("text"))
      issues.push({
        input: values.inputModalities,
        code: "custom",
        path: ["inputModalities"],
        message: "必须支持文本输入",
      });
    if (new Set(values.thinkingLevels).size !== values.thinkingLevels.length)
      issues.push({
        input: values.thinkingLevels,
        code: "custom",
        path: ["thinkingLevels"],
        message: "Thinking 等级不能重复",
      });
    if (values.reasoningFormat === "none" && values.thinkingLevels.length > 0)
      issues.push({
        input: values.thinkingLevels,
        code: "custom",
        path: ["thinkingLevels"],
        message: "无 reasoning 格式时等级必须为空",
      });
    if (values.reasoningFormat !== "none" && values.thinkingLevels.length === 0)
      issues.push({
        input: values.thinkingLevels,
        code: "custom",
        path: ["thinkingLevels"],
        message: "请选择至少一个 Thinking 等级",
      });
  });

type ModelFormValues = z.infer<typeof modelSchema>;
const defaults: ModelFormValues = {
  publicName: "",
  providerId: "",
  upstreamName: "",
  contextWindow: 200000,
  maxOutput: 8192,
  thinkingLevels: [],
  parallelToolCalls: true,
  reasoningFormat: "none",
  inputModalities: ["text"],
  enabled: true,
  priceIn: "0",
  priceOut: "0",
  priceCacheRead: "0",
};

export function ModelForm({
  open,
  model,
  providers,
  pending,
  onClose,
  onSubmit,
}: {
  open: boolean;
  model: Model | null;
  providers: Provider[];
  pending: boolean;
  onClose: () => void;
  onSubmit: (input: CreateModel) => Promise<unknown>;
}) {
  const [formError, setFormError] = useState<string | null>(null);
  const values = model
    ? {
        publicName: model.publicName,
        providerId: model.providerId,
        upstreamName: model.upstreamName,
        contextWindow: model.contextWindow,
        maxOutput: model.maxOutput,
        thinkingLevels: model.thinkingLevels,
        parallelToolCalls: model.parallelToolCalls,
        reasoningFormat: model.reasoningFormat,
        inputModalities: model.inputModalities,
        enabled: model.enabled,
        priceIn: model.priceIn,
        priceOut: model.priceOut,
        priceCacheRead: model.priceCacheRead,
      }
    : { ...defaults, providerId: providers.find((item) => item.enabled)?.id ?? providers[0]?.id ?? "" };
  const {
    register,
    handleSubmit,
    reset,
    setError,
    setValue,
    watch,
    formState: { errors },
  } = useForm<ModelFormValues>({ resolver: zodResolver(modelSchema), values });
  const reasoningFormat = watch("reasoningFormat");
  const close = () => {
    if (pending) return;
    setFormError(null);
    reset();
    onClose();
  };
  const submit = handleSubmit(async (input) => {
    setFormError(null);
    try {
      await onSubmit(input);
      reset();
      onClose();
    } catch (error) {
      if (error instanceof ApiClientError)
        for (const [field, message] of Object.entries(error.fieldErrors))
          setError(field as keyof ModelFormValues, { message });
      setFormError(error instanceof Error ? error.message : "保存失败");
    }
  });

  return (
    <Dialog
      open={open}
      title={model ? "编辑模型" : "注册模型"}
      description="模型能力必须按实际上游逐项配置，不能只根据 Provider 推断。"
      size="lg"
      onClose={close}
    >
      <form onSubmit={submit} className="space-y-6">
        {formError && (
          <div className="rounded-xl bg-rose-50 p-3 text-sm text-rose-700 ring-1 ring-rose-200" role="alert">
            {formError}
          </div>
        )}
        <section>
          <h3 className="text-sm font-semibold text-slate-900">映射与容量</h3>
          <div className="mt-4 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            <FieldLabel label="公开模型名" error={errors.publicName?.message}>
              <Input {...register("publicName")} placeholder="nova-fast" autoFocus />
            </FieldLabel>
            <FieldLabel label="Provider" error={errors.providerId?.message}>
              <Select {...register("providerId")}>
                <option value="">请选择</option>
                {providers.map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.name}
                    {provider.enabled ? "" : "（已停用）"}
                  </option>
                ))}
              </Select>
            </FieldLabel>
            <FieldLabel label="上游模型名" error={errors.upstreamName?.message}>
              <Input {...register("upstreamName")} placeholder="deepseek-chat" />
            </FieldLabel>
            <FieldLabel label="上下文窗口" hint="tokens" error={errors.contextWindow?.message}>
              <Input {...register("contextWindow", { valueAsNumber: true })} type="number" min={1} step={1} />
            </FieldLabel>
            <FieldLabel label="最大输出" hint="tokens" error={errors.maxOutput?.message}>
              <Input {...register("maxOutput", { valueAsNumber: true })} type="number" min={1} step={1} />
            </FieldLabel>
            <FieldLabel label="Reasoning 格式" error={errors.reasoningFormat?.message}>
              <Select
                {...register("reasoningFormat", {
                  onChange: (event) => {
                    if (event.target.value === "none") setValue("thinkingLevels", []);
                  },
                })}
              >
                <option value="none">None</option>
                <option value="openai">OpenAI</option>
                <option value="anthropic">Anthropic</option>
                <option value="deepseek">DeepSeek</option>
                <option value="minimax">MiniMax</option>
              </Select>
            </FieldLabel>
          </div>
        </section>
        <section className="grid gap-5 rounded-xl bg-slate-50 p-5 ring-1 ring-slate-200 lg:grid-cols-3">
          <ChoiceGroup title="Thinking 等级" error={errors.thinkingLevels?.message}>
            {(["off", "low", "medium", "high", "max"] as const).map((level) => (
              <Check key={level} label={level}>
                <input
                  {...register("thinkingLevels")}
                  type="checkbox"
                  value={level}
                  disabled={reasoningFormat === "none"}
                />
              </Check>
            ))}
          </ChoiceGroup>
          <ChoiceGroup title="输入模态" error={errors.inputModalities?.message}>
            {(["text", "image"] as const).map((modality) => (
              <Check key={modality} label={modality}>
                <input {...register("inputModalities")} type="checkbox" value={modality} />
              </Check>
            ))}
          </ChoiceGroup>
          <div className="space-y-3">
            <p className="text-sm font-semibold text-slate-900">执行能力</p>
            <Check label="并行工具调用">
              <input {...register("parallelToolCalls")} type="checkbox" />
            </Check>
            {!model && (
              <Check label="创建后立即启用">
                <input {...register("enabled")} type="checkbox" />
              </Check>
            )}
          </div>
        </section>
        <section>
          <h3 className="text-sm font-semibold text-slate-900">每百万 Token 价格</h3>
          <p className="mt-1 text-xs leading-5 text-slate-500">
            统一结算币种。没有独立缓存折扣时，缓存读取价应与输入价一致。
          </p>
          <div className="mt-4 grid gap-5 sm:grid-cols-3">
            <FieldLabel label="输入" error={errors.priceIn?.message}>
              <Input {...register("priceIn")} inputMode="decimal" />
            </FieldLabel>
            <FieldLabel label="输出" error={errors.priceOut?.message}>
              <Input {...register("priceOut")} inputMode="decimal" />
            </FieldLabel>
            <FieldLabel label="缓存读取" error={errors.priceCacheRead?.message}>
              <Input {...register("priceCacheRead")} inputMode="decimal" />
            </FieldLabel>
          </div>
        </section>
        <div className="flex justify-end gap-3 border-t border-slate-100 pt-5">
          <Button type="button" onClick={close} disabled={pending}>
            取消
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={pending || providers.length === 0}
            icon={pending ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> : undefined}
          >
            {pending ? "正在保存" : "保存模型"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function ChoiceGroup({
  title,
  error,
  children,
}: {
  title: string;
  error?: string | undefined;
  children: React.ReactNode;
}) {
  return (
    <div>
      <p className="text-sm font-semibold text-slate-900">{title}</p>
      <div className="mt-3 flex flex-wrap gap-3">{children}</div>
      {error && (
        <p className="mt-2 text-xs font-medium text-rose-600" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function Check({ label, children }: { label: string; children: React.ReactElement<{ className?: string }> }) {
  return (
    <label className="flex items-center gap-2 text-sm text-slate-600">
      {children}
      <span>{label}</span>
    </label>
  );
}
