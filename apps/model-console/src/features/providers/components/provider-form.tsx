import { zodResolver } from "@hookform/resolvers/zod";
import { ListBox, Select } from "@heroui/react";
import { LoaderCircle } from "lucide-react";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Controller, useForm } from "react-hook-form";
import { providerSchema, type ProviderFormValues } from "../provider-form.schema";
import { formFeedbackFrom, type CreateProvider, type Provider, type UpdateProvider } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { FieldLabel, Input } from "@/components/ui/form";
import { providerAdapterQueryOptions } from "../provider-queries";
import { ErrorState } from "@/components/ui/feedback";

const fieldClass = "h-9 rounded-xl border border-field-border bg-field-background px-3";

export function ProviderForm({
  open,
  provider,
  pending,
  onClose,
  onSubmit,
}: {
  open: boolean;
  provider: Provider | null;
  pending: boolean;
  onClose: () => void;
  onSubmit: (input: CreateProvider | UpdateProvider) => Promise<unknown>;
}) {
  const editing = provider !== null;
  const adaptersQuery = useQuery(providerAdapterQueryOptions());
  const adapters = adaptersQuery.data ?? [];
  const defaultAdapter = adapters[0];
  const dialogDescription = editing ? "留空凭据字段即可保留当前密钥。" : "配置官方或中转商的连接地址与凭据。";
  const [formError, setFormError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    control,
    reset,
    setValue,
    getValues,
    setError,
    formState: { errors },
  } = useForm<ProviderFormValues>({
    resolver: zodResolver(providerSchema),
    resetOptions: { keepDirtyValues: true },
    values: provider
      ? {
          adapterId: provider.adapterId ?? "",
          name: provider.name,
          baseUrl: provider.baseUrl,
          credential: "",
          enabled: provider.enabled,
          isPublic: provider.isPublic,
        }
      : {
          adapterId: defaultAdapter?.id ?? "",
          name: "",
          baseUrl: defaultAdapter?.defaultBaseURL ?? "",
          credential: "",
          enabled: true,
          isPublic: false,
        },
  });

  const close = () => {
    if (pending) return;
    setFormError(null);
    reset();
    onClose();
  };
  const submit = handleSubmit(async (values) => {
    const adapter = adapters.find((item) => item.id === values.adapterId);
    if (!adapter && !editing) {
      setError("adapterId", { message: "请选择供应商" });
      return;
    }
    if (!editing && !values.credential.trim()) {
      setError("credential", { message: "请输入访问凭据" });
      return;
    }
    setFormError(null);
    const credential = values.credential.trim();
    const shared = {
      ...(adapter ? { adapterId: adapter.id } : {}),
      name: values.name.trim(),
      baseUrl: values.baseUrl,
      isPublic: values.isPublic,
    };
    let input: CreateProvider | UpdateProvider;
    if (editing) {
      input = credential ? { ...shared, credential } : { ...shared };
    } else {
      input = { ...shared, credential, enabled: values.enabled };
    }
    try {
      await onSubmit(input);
      reset();
      onClose();
    } catch (error) {
      const feedback = formFeedbackFrom(error);
      for (const [field, message] of Object.entries(feedback.fieldErrors))
        setError(field as keyof ProviderFormValues, { message });
      setFormError(feedback.message);
    }
  });

  return (
    <Dialog
      open={open}
      title={editing ? "编辑 Provider" : "添加 Provider"}
      description={dialogDescription}
      onClose={close}
      size="lg"
    >
      <form onSubmit={submit} className="min-w-0 space-y-4">
        {formError && (
          <div className="rounded-xl bg-danger/10 p-3 text-sm text-danger ring-1 ring-danger/30" role="alert">
            {formError}
          </div>
        )}
        {adaptersQuery.error && <ErrorState error={adaptersQuery.error} onRetry={() => void adaptersQuery.refetch()} />}
        <FieldLabel
          label="供应商"
          hint="自动处理连接协议和推理参数，可自定义 Base URL"
          error={errors.adapterId?.message}
        >
          <Controller
            control={control}
            name="adapterId"
            render={({ field }) => (
              <Select
                aria-label="供应商"
                selectedKey={field.value || null}
                placeholder={editing ? "旧配置（按模型适配）" : "请选择供应商"}
                isDisabled={adaptersQuery.isPending}
                onSelectionChange={(key) => {
                  const next = adapters.find((item) => item.id === key);
                  if (!next) return;
                  const previous = adapters.find((item) => item.id === field.value);
                  const baseURL = getValues("baseUrl");
                  if (!baseURL || baseURL === previous?.defaultBaseURL)
                    setValue("baseUrl", next.defaultBaseURL, { shouldValidate: true });
                  field.onChange(next.id);
                }}
              >
                <Select.Trigger className="h-9 w-full min-w-0 rounded-xl border border-field-border bg-field-background px-3 data-[open]:border-accent">
                  <Select.Value />
                  <Select.Indicator />
                </Select.Trigger>
                <Select.Popover>
                  <ListBox>
                    {adapters.map((adapter) => (
                      <ListBox.Item key={adapter.id} id={adapter.id} textValue={adapter.label}>
                        {adapter.label}
                        <ListBox.ItemIndicator />
                      </ListBox.Item>
                    ))}
                  </ListBox>
                </Select.Popover>
              </Select>
            )}
          />
        </FieldLabel>
        <div className="grid min-w-0 gap-3 md:grid-cols-2">
          <FieldLabel label="名称" error={errors.name?.message}>
            <Input
              {...register("name")}
              data-initial-focus
              placeholder="例如 Nova Production"
              autoFocus
              className={fieldClass}
            />
          </FieldLabel>
          <FieldLabel label="Base URL" hint="必须为 HTTPS" error={errors.baseUrl?.message}>
            <Input
              {...register("baseUrl")}
              type="url"
              placeholder="https://api.example.com/v1"
              spellCheck={false}
              className={fieldClass}
            />
          </FieldLabel>
        </div>
        <FieldLabel
          label={editing ? "替换凭据" : "访问凭据"}
          hint={editing ? `当前 ${provider.credentialMasked}` : "保存后仅展示掩码"}
          error={errors.credential?.message}
        >
          <Input
            {...register("credential")}
            type="password"
            autoComplete="new-password"
            placeholder={editing ? "留空保持不变" : "输入 API key"}
            spellCheck={false}
            className={fieldClass}
          />
        </FieldLabel>
        {!editing && (
          <label className="flex items-start gap-3 rounded-xl bg-surface-secondary p-3 ring-1 ring-border">
            <input
              {...register("enabled")}
              type="checkbox"
              className="mt-0.5 size-4 shrink-0 accent-[color:var(--accent)]"
            />
            <span>
              <span className="block text-sm font-semibold text-foreground">创建后立即启用</span>
              <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">
                仅在地址与凭据已经确认可用时启用。
              </span>
            </span>
          </label>
        )}
        <label className="flex items-start gap-3 rounded-xl bg-surface-secondary p-3 ring-1 ring-border">
          <input
            {...register("isPublic")}
            type="checkbox"
            className="mt-0.5 size-4 shrink-0 accent-[color:var(--accent)]"
          />
          <span>
            <span className="block text-sm font-semibold text-foreground">公开给所有用户</span>
            <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">
              关闭时只有创建该 Provider 的账号能在模型列表中使用它。
            </span>
          </span>
        </label>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" onPress={close} isDisabled={pending}>
            取消
          </Button>
          <Button
            type="submit"
            variant="primary"
            isDisabled={pending || adaptersQuery.isPending || adaptersQuery.isError}
          >
            {pending && <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />}
            {pending ? "正在保存" : "保存 Provider"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
