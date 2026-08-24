import { zodResolver } from "@hookform/resolvers/zod";
import { LoaderCircle } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { ApiClientError, type CreateApiKey, type CreatedApiKey } from "../api/client.js";
import { Button } from "../components/ui/button.js";
import { Dialog } from "../components/ui/dialog.js";
import { FieldLabel, Input } from "../components/ui/form.js";

const schema = z.object({
  name: z.string().trim().min(1, "请输入用途名称").max(80),
  ownerId: z.string().trim().min(1, "请输入租户标识").max(120),
});

export function CreateKeyForm({
  open,
  onClose,
  onCreate,
}: {
  open: boolean;
  onClose: () => void;
  onCreate: (input: CreateApiKey) => Promise<CreatedApiKey>;
}) {
  const [pending, setPending] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors },
  } = useForm<CreateApiKey>({ resolver: zodResolver(schema), defaultValues: { name: "", ownerId: "" } });
  const close = () => {
    if (pending) return;
    reset();
    setFormError(null);
    onClose();
  };
  const submit = handleSubmit(async (values) => {
    setPending(true);
    setFormError(null);
    try {
      await onCreate({ name: values.name.trim(), ownerId: values.ownerId.trim() });
      reset();
      onClose();
    } catch (error) {
      if (error instanceof ApiClientError)
        for (const [field, message] of Object.entries(error.fieldErrors))
          setError(field as keyof CreateApiKey, { message });
      setFormError(error instanceof Error ? error.message : "创建失败");
    } finally {
      setPending(false);
    }
  });
  return (
    <Dialog open={open} title="创建 API Key" description="用于业务侧识别与配额管理。明文只会显示一次。" onClose={close}>
      <form onSubmit={submit} className="space-y-5">
        {formError && (
          <div className="rounded-xl bg-rose-50 p-3 text-sm text-rose-700 ring-1 ring-rose-200" role="alert">
            {formError}
          </div>
        )}
        <FieldLabel label="用途名称" error={errors.name?.message}>
          <Input {...register("name")} data-initial-focus placeholder="例如 production-agent" autoFocus />
        </FieldLabel>
        <FieldLabel label="租户标识" hint="不关联 Nova Project" error={errors.ownerId?.message}>
          <Input {...register("ownerId")} placeholder="team-platform" />
        </FieldLabel>
        <div className="flex justify-end gap-3 pt-2">
          <Button type="button" onClick={close} disabled={pending}>
            取消
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={pending}
            icon={pending ? <LoaderCircle className="size-4 animate-spin" /> : undefined}
          >
            {pending ? "正在创建" : "创建 Key"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
