import { zodResolver } from "@hookform/resolvers/zod";
import { LoaderCircle } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { ApiClientError, type CreateProvider, type Provider, type UpdateProvider } from "../api/client.js";
import { Button } from "../components/ui/button.js";
import { Dialog } from "../components/ui/dialog.js";
import { FieldLabel, Input, Select } from "../components/ui/form.js";

const providerSchema = z
  .object({
    protocol: z.enum(["openai", "anthropic"]),
    name: z.string().trim().min(1, "请输入 Provider 名称").max(80, "最多 80 个字符"),
    baseUrl: z.url("请输入有效 URL").refine((value) => value.startsWith("https://"), "只允许 HTTPS 地址"),
    credential: z.string(),
    enabled: z.boolean(),
    isPublic: z.boolean(),
  });

type ProviderFormValues = z.infer<typeof providerSchema>;

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
  const [formError, setFormError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    reset,
    setError,
    setValue,
    watch,
    formState: { errors },
  } = useForm<ProviderFormValues>({
    resolver: zodResolver(providerSchema),
    values: provider
      ? {
          protocol: provider.protocol,
          name: provider.name,
          baseUrl: provider.baseUrl,
          credential: "",
          enabled: provider.enabled,
          isPublic: provider.isPublic,
        }
      : {
          protocol: "openai",
          name: "",
          baseUrl: "",
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
    if (!editing && !values.credential.trim()) {
      setError("credential", { message: "请输入访问凭据" });
      return;
    }
    setFormError(null);
    const input = editing
      ? {
          protocol: values.protocol,
          name: values.name.trim(),
          baseUrl: values.baseUrl,
          isPublic: values.isPublic,
          ...(values.credential.trim() ? { credential: values.credential.trim() } : {}),
        }
      : {
          protocol: values.protocol,
          name: values.name.trim(),
          baseUrl: values.baseUrl,
          credential: values.credential.trim(),
          enabled: values.enabled,
          isPublic: values.isPublic,
        };
    try {
      await onSubmit(input);
      reset();
      onClose();
    } catch (error) {
      if (error instanceof ApiClientError)
        for (const [field, message] of Object.entries(error.fieldErrors))
          setError(field as keyof ProviderFormValues, { message });
      setFormError(error instanceof Error ? error.message : "保存失败");
    }
  });

  return (
    <Dialog
      open={open}
      title={editing ? "编辑 Provider" : "添加 Provider"}
      description={editing ? "留空凭据字段即可保留当前密钥。" : "配置官方或中转商的连接地址与凭据。"}
      onClose={close}
    >
      <form onSubmit={submit} className="space-y-5">
        {formError && (
          <div className="rounded-xl bg-rose-50 p-3 text-sm text-rose-700 ring-1 ring-rose-200" role="alert">
            {formError}
          </div>
        )}
        <div className="grid gap-5 sm:grid-cols-2">
          <FieldLabel label="认证协议" error={errors.protocol?.message}>
            <Select {...register("protocol")}>
              <option value="openai">OpenAI 兼容</option>
              <option value="anthropic">Anthropic 原生</option>
            </Select>
          </FieldLabel>
        </div>
        <div className="grid gap-5 sm:grid-cols-2">
          <FieldLabel label="名称" error={errors.name?.message}>
            <Input {...register("name")} data-initial-focus placeholder="例如 MiniMax Production" autoFocus />
          </FieldLabel>
          <FieldLabel label="Base URL" hint="必须为 HTTPS" error={errors.baseUrl?.message}>
            <Input {...register("baseUrl")} type="url" placeholder="https://api.example.com/v1" spellCheck={false} />
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
          />
        </FieldLabel>
        {!editing && (
          <label className="flex items-start gap-3 rounded-xl bg-slate-50 p-4 ring-1 ring-slate-200">
            <input {...register("enabled")} type="checkbox" className="mt-0.5 size-4 accent-indigo-600" />
            <span>
              <span className="block text-sm font-semibold text-slate-800">创建后立即启用</span>
              <span className="mt-0.5 block text-xs leading-5 text-slate-500">仅在地址与凭据已经确认可用时启用。</span>
            </span>
          </label>
        )}
        <label className="flex items-start gap-3 rounded-xl bg-slate-50 p-4 ring-1 ring-slate-200">
          <input {...register("isPublic")} type="checkbox" className="mt-0.5 size-4 accent-indigo-600" />
          <span>
            <span className="block text-sm font-semibold text-slate-800">公开给所有用户</span>
            <span className="mt-0.5 block text-xs leading-5 text-slate-500">
              关闭时只有创建该 Provider 的账号能在模型列表中使用它。
            </span>
          </span>
        </label>
        <div className="flex justify-end gap-3 pt-2">
          <Button type="button" onClick={close} disabled={pending}>
            取消
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={pending}
            icon={pending ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> : undefined}
          >
            {pending ? "正在保存" : "保存 Provider"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
