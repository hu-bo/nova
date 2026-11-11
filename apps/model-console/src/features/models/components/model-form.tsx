import { zodResolver } from "@hookform/resolvers/zod";
import { ListBox, Select } from "@heroui/react";
import { LoaderCircle } from "lucide-react";
import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { modelSchema, type ModelFormValues } from "../model-form.schema";
import {
  formFeedbackFrom,
  type CreateModel,
  type Model,
  type Provider,
  type ProviderAdapter,
  type ThinkingLevel,
} from "@/api/client";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { FieldLabel, Input, fieldInputClass } from "@/components/ui/form";
import { toModelInput } from "@/features/models/model-input";

const defaults: ModelFormValues = {
  publicName: "",
  providerId: "",
  upstreamName: "",
  contextWindow: 200000,
  maxOutput: 8192,
  thinkingLevels: [],
  parallelToolCalls: true,
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
  adapters,
  pending,
  onClose,
  onSubmit,
}: {
  open: boolean;
  model: Model | null;
  providers: Provider[];
  adapters: ProviderAdapter[];
  pending: boolean;
  onClose: () => void;
  onSubmit: (input: CreateModel) => Promise<unknown>;
}) {
  const [formError, setFormError] = useState<string | null>(null);
  const values = model
    ? toModelInput(model)
    : { ...defaults, providerId: providers.find((item) => item.enabled)?.id ?? providers[0]?.id ?? "" };
  const {
    register,
    handleSubmit: handleRHFSubmit,
    control,
    reset,
    setError,
    setValue,
    getValues,
    watch,
    formState: { errors },
  } = useForm<ModelFormValues>({ resolver: zodResolver(modelSchema), values });
  const selectedProvider = providers.find((provider) => provider.id === watch("providerId"));
  const adapter = adapters.find((item) => item.id === selectedProvider?.adapterId);
  const editingLegacyModel = !selectedProvider?.adapterId && model?.providerId === selectedProvider?.id;
  let thinkingLevels: ThinkingLevel[] = adapter?.thinkingLevels ?? [];
  if (editingLegacyModel && model) thinkingLevels = model.thinkingLevels;
  const close = () => {
    if (pending) return;
    setFormError(null);
    reset();
    onClose();
  };
  const submit = handleRHFSubmit(async (input) => {
    setFormError(null);
    try {
      // Legacy providers retain their stored format until explicitly migrated to a catalog adapter.
      const legacyFormat = editingLegacyModel && input.thinkingLevels.length ? model?.reasoningFormat : "none";
      await onSubmit({
        ...input,
        ...(!selectedProvider?.adapterId && legacyFormat ? { reasoningFormat: legacyFormat } : {}),
      });
      reset();
      onClose();
    } catch (error) {
      const feedback = formFeedbackFrom(error);
      for (const [field, message] of Object.entries(feedback.fieldErrors))
        setError(field as keyof ModelFormValues, { message });
      setFormError(feedback.message);
    }
  });

  return (
    <Dialog
      open={open}
      title={model ? "编辑模型" : "注册模型"}
      description="供应商自动处理连接方式；容量、输入模态和 Thinking 等级按实际模型配置。"
      size="lg"
      onClose={close}
    >
      <form onSubmit={submit} className="space-y-6">
        {formError && (
          <div className="rounded-xl bg-danger/10 p-3 text-sm text-danger ring-1 ring-danger/30" role="alert">
            {formError}
          </div>
        )}
        <section>
          <h3 className="text-sm font-semibold text-foreground">映射与容量</h3>
          <div className="mt-4 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            <FieldLabel label="公开模型名" error={errors.publicName?.message}>
              <Input {...register("publicName")} placeholder="nova-fast" autoFocus className={fieldInputClass} />
            </FieldLabel>
            <FieldLabel label="Provider" error={errors.providerId?.message}>
              <Controller
                control={control}
                name="providerId"
                render={({ field }) => (
                  <Select
                    aria-label="Provider"
                    selectedKey={field.value || null}
                    onSelectionChange={(key) => {
                      if (typeof key !== "string") return;
                      field.onChange(key);
                      const provider = providers.find((item) => item.id === key);
                      const next = adapters.find((item) => item.id === provider?.adapterId);
                      let allowedLevels: ThinkingLevel[] = next?.thinkingLevels ?? [];
                      if (!provider?.adapterId && model?.providerId === key) allowedLevels = model.thinkingLevels;
                      setValue(
                        "thinkingLevels",
                        getValues("thinkingLevels").filter((level) => allowedLevels.includes(level)),
                      );
                    }}
                  >
                    <Select.Trigger className={fieldInputClass}>
                      <Select.Value>
                        {field.value ? (providers.find((p) => p.id === field.value)?.name ?? "") : "请选择"}
                      </Select.Value>
                      <Select.Indicator />
                    </Select.Trigger>
                    <Select.Popover>
                      <ListBox>
                        {providers.map((provider) => (
                          <ListBox.Item key={provider.id} id={provider.id} textValue={provider.name}>
                            {provider.name}
                            {provider.enabled ? "" : "（已停用）"}
                            <ListBox.ItemIndicator />
                          </ListBox.Item>
                        ))}
                      </ListBox>
                    </Select.Popover>
                  </Select>
                )}
              />
            </FieldLabel>
            <FieldLabel label="上游模型名" error={errors.upstreamName?.message}>
              <Input {...register("upstreamName")} placeholder="deepseek-chat" className={fieldInputClass} />
            </FieldLabel>
            <FieldLabel label="上下文窗口" hint="tokens" error={errors.contextWindow?.message}>
              <Input
                {...register("contextWindow", { valueAsNumber: true })}
                type="number"
                min={1}
                step={1}
                className={fieldInputClass}
              />
            </FieldLabel>
            <FieldLabel label="最大输出" hint="tokens" error={errors.maxOutput?.message}>
              <Input
                {...register("maxOutput", { valueAsNumber: true })}
                type="number"
                min={1}
                step={1}
                className={fieldInputClass}
              />
            </FieldLabel>
          </div>
        </section>
        <section className="grid gap-5 rounded-xl bg-surface-secondary p-5 ring-1 ring-border lg:grid-cols-3">
          <ChoiceGroup title="Thinking 等级" error={errors.thinkingLevels?.message}>
            {thinkingLevels.length === 0 && (
              <p className="text-xs text-muted-foreground">
                此连接未启用 Thinking；如需使用，请选择支持该能力的标准供应商。
              </p>
            )}
            {thinkingLevels.map((level) => (
              <Check key={level} label={level}>
                <input {...register("thinkingLevels")} type="checkbox" value={level} />
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
            <p className="text-sm font-semibold text-foreground">执行能力</p>
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
          <h3 className="text-sm font-semibold text-foreground">每百万 Token 价格</h3>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            统一结算币种。没有独立缓存折扣时，缓存读取价应与输入价一致。
          </p>
          <div className="mt-4 grid gap-5 sm:grid-cols-3">
            <FieldLabel label="输入" error={errors.priceIn?.message}>
              <Input {...register("priceIn")} inputMode="decimal" className={fieldInputClass} />
            </FieldLabel>
            <FieldLabel label="输出" error={errors.priceOut?.message}>
              <Input {...register("priceOut")} inputMode="decimal" className={fieldInputClass} />
            </FieldLabel>
            <FieldLabel label="缓存读取" error={errors.priceCacheRead?.message}>
              <Input {...register("priceCacheRead")} inputMode="decimal" className={fieldInputClass} />
            </FieldLabel>
          </div>
        </section>
        <div className="flex justify-end gap-3 border-t border-border pt-5">
          <Button type="button" onPress={close} isDisabled={pending}>
            取消
          </Button>
          <Button
            type="submit"
            variant="primary"
            isDisabled={pending || providers.length === 0 || adapters.length === 0}
          >
            {pending && <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />}
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
      <p className="text-sm font-semibold text-foreground">{title}</p>
      <div className="mt-3 flex flex-wrap gap-3">{children}</div>
      {error && (
        <p className="mt-2 text-xs font-medium text-danger" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function Check({ label, children }: { label: string; children: React.ReactElement<{ className?: string }> }) {
  return (
    <label className="flex items-center gap-2 text-sm text-muted-foreground">
      {children}
      <span>{label}</span>
    </label>
  );
}
