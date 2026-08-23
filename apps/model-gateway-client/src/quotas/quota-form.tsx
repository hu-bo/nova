import { zodResolver } from "@hookform/resolvers/zod";
import { LoaderCircle } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { ApiClientError, type Quota, type UpdateQuota } from "../api/client.js";
import { Button } from "../components/ui/button.js";
import { Dialog } from "../components/ui/dialog.js";
import { FieldLabel, Input } from "../components/ui/form.js";

const optionalPositiveInteger = z.string().refine(value => value === "" || (/^\d+$/.test(value) && Number(value) > 0), "留空表示不限，或输入大于 0 的整数");
const optionalMoney = z.string().refine(value => value === "" || /^\d+(\.\d{1,8})?$/.test(value), "留空表示不限，或输入非负金额");
const schema = z.object({ rpm: optionalPositiveInteger, tpm: optionalPositiveInteger, monthlyCost: optionalMoney });
type Values = z.infer<typeof schema>;

export function QuotaForm({ quota, pending, onClose, onSubmit }: { quota: Quota | null; pending: boolean; onClose: () => void; onSubmit: (input: UpdateQuota) => Promise<unknown> }) {
  const [formError, setFormError] = useState<string | null>(null);
  const { register, handleSubmit, reset, setError, formState: { errors } } = useForm<Values>({ resolver: zodResolver(schema), values: { rpm: quota?.rpm?.toString() ?? "", tpm: quota?.tpm?.toString() ?? "", monthlyCost: quota?.monthlyCost ?? "" } });
  const close = () => { if (pending) return; setFormError(null); reset(); onClose(); };
  const submit = handleSubmit(async values => {
    setFormError(null);
    const input: UpdateQuota = { rpm: values.rpm ? Number(values.rpm) : null, tpm: values.tpm ? Number(values.tpm) : null, monthlyCost: values.monthlyCost || null };
    try { await onSubmit(input); reset(); onClose(); }
    catch (error) {
      if (error instanceof ApiClientError) for (const [field, message] of Object.entries(error.fieldErrors)) setError(field as keyof Values, { message });
      setFormError(error instanceof Error ? error.message : "保存失败");
    }
  });
  return <Dialog open={quota !== null} title={`编辑 ${quota?.keyName ?? "API Key"} 的配额`} description="留空表示不限制。429 速率限制可重试；月度金额耗尽返回不可重试的 402。" onClose={close}>{quota && <form onSubmit={submit} className="space-y-5">{formError && <div className="rounded-xl bg-rose-50 p-3 text-sm text-rose-700 ring-1 ring-rose-200" role="alert">{formError}</div>}<div className="rounded-xl bg-slate-50 p-4 ring-1 ring-slate-200"><p className="text-sm font-semibold text-slate-900">{quota.keyName}</p><p className="mt-1 font-mono text-xs text-slate-500">{quota.keyPrefix}••••••••</p></div><div className="grid gap-5 sm:grid-cols-2"><FieldLabel label="每分钟请求数" hint="RPM" error={errors.rpm?.message}><Input {...register("rpm")} inputMode="numeric" placeholder="不限" /></FieldLabel><FieldLabel label="每分钟 Token" hint="TPM" error={errors.tpm?.message}><Input {...register("tpm")} inputMode="numeric" placeholder="不限" /></FieldLabel></div><FieldLabel label="月度费用上限" hint="统一结算币种" error={errors.monthlyCost?.message}><Input {...register("monthlyCost")} inputMode="decimal" placeholder="不限" /></FieldLabel><div className="flex justify-end gap-3 pt-2"><Button type="button" onClick={close} disabled={pending}>取消</Button><Button type="submit" variant="primary" disabled={pending} icon={pending ? <LoaderCircle className="size-4 animate-spin" /> : undefined}>{pending ? "正在保存" : "保存配额"}</Button></div></form>}</Dialog>;
}
