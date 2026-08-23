import { Check, Clipboard, KeyRound } from "lucide-react";
import { useState } from "react";
import type { CreatedApiKey } from "../api/client.js";
import { Button } from "../components/ui/button.js";
import { Dialog } from "../components/ui/dialog.js";

export function SecretDialog({ created, onAcknowledge }: { created: CreatedApiKey | null; onAcknowledge: () => void }) {
  const [copied, setCopied] = useState(false);
  const close = () => { setCopied(false); onAcknowledge(); };
  const copy = async () => {
    if (!created) return;
    await navigator.clipboard.writeText(created.secret);
    setCopied(true);
  };
  return <Dialog open={created !== null} title="保存你的 API Key" description="关闭后无法再次查看；如果遗失，只能吊销并重新创建。" closeLabel="关闭并清除密钥" onClose={close}>{created && <div><div className="rounded-xl bg-amber-50 p-4 text-sm leading-6 text-amber-900 ring-1 ring-amber-200"><strong>只显示这一次。</strong> 请先复制到你的 Secret Manager，不要粘贴到日志、聊天或代码仓库。</div><div className="mt-5 rounded-xl bg-slate-950 p-4 text-slate-100"><div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-400"><KeyRound className="size-4" />{created.apiKey.name}</div><code className="mt-3 block break-all font-mono text-sm leading-6">{created.secret}</code></div><div className="mt-5 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end"><Button type="button" variant="secondary" onClick={() => void copy()} icon={copied ? <Check className="size-4 text-emerald-600" /> : <Clipboard className="size-4" />}>{copied ? "已复制" : "复制密钥"}</Button><Button type="button" variant="primary" onClick={close}>我已安全保存</Button></div></div>}</Dialog>;
}
