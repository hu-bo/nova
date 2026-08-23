import { useCasdoorCallback } from "@nova/casdoor/client/react";
import { AlertCircle, CheckCircle2, LoaderCircle } from "lucide-react";
import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "../components/ui/button.js";

export function CallbackRoute() {
  const result = useCasdoorCallback();
  const navigate = useNavigate();
  useEffect(() => {
    if (!result.success) return;
    const target = sessionStorage.getItem("nova_return_to") || "/";
    sessionStorage.removeItem("nova_return_to");
    navigate(target, { replace: true });
  }, [result.success, navigate]);

  return (
    <main className="grid min-h-screen place-items-center bg-slate-50 p-6">
      <section className="w-full max-w-md rounded-2xl bg-white p-8 text-center ring-1 ring-slate-200 shadow-soft">
        {result.isLoading && <><LoaderCircle className="mx-auto size-9 animate-spin text-indigo-600" aria-hidden="true" /><h1 className="mt-4 text-xl font-semibold">正在完成登录</h1><p className="mt-2 text-sm text-slate-500">正在安全交换凭据，请稍候。</p></>}
        {result.success && <><CheckCircle2 className="mx-auto size-9 text-emerald-600" aria-hidden="true" /><h1 className="mt-4 text-xl font-semibold">登录成功</h1><p className="mt-2 text-sm text-slate-500">即将进入工作台。</p></>}
        {result.error && <><AlertCircle className="mx-auto size-9 text-rose-600" aria-hidden="true" /><h1 className="mt-4 text-xl font-semibold">无法完成登录</h1><p className="mt-2 text-sm leading-6 text-rose-700">{result.error.message}</p><Button className="mt-6" variant="primary" onClick={() => navigate("/", { replace: true })}>返回首页</Button></>}
      </section>
    </main>
  );
}
