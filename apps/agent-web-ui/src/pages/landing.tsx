import {
  ArrowRight,
  Check,
  ChevronRight,
  Clipboard,
  Code2,
  FolderKanban,
  Github,
  LayoutDashboard,
  MonitorCog,
  MessageCircle,
  Server,
  Settings,
  Sparkles,
  TerminalSquare,
} from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import type { RunnerToken } from "@nova/protocol";
import { useAuth } from "../auth/provider.js";
import { Button } from "../components/ui/button.js";
import { installCommand, runnerCommand } from "./settings/runner/commands.js";
import { useRunnerConnection, useRunnerTokens } from "./settings/runner/use-runners.js";

export function LandingRoute() {
  const auth = useAuth();
  const runnerTokens = useRunnerTokens(auth.isAuthenticated);
  const runnerConnection = useRunnerConnection(auth.isAuthenticated);
  const [copiedCommand, setCopiedCommand] = useState<"install" | "run" | null>(null);
  const [copyFailed, setCopyFailed] = useState(false);
  const token = (runnerTokens.data?.[0] as RunnerToken | undefined)?.token;
  const runCommand =
    token && runnerConnection.data?.endpoint
      ? runnerCommand(runnerConnection.data.endpoint, token)
      : auth.isAuthenticated
        ? "正在生成启动命令…"
        : "登录后生成带 Token 的启动命令";

  async function copyCommand(command: string, kind: "install" | "run") {
    try {
      await navigator.clipboard.writeText(command);
      setCopiedCommand(kind);
      setCopyFailed(false);
      setTimeout(() => setCopiedCommand(null), 1_800);
    } catch {
      setCopyFailed(true);
    }
  }
  return (
    <div className="min-h-screen overflow-hidden bg-slate-950 text-white">
      <header className="relative z-20 mx-auto flex h-20 max-w-7xl items-center justify-between px-5 sm:px-8">
        <Link to="/" className="flex items-center gap-3" aria-label="Nova 首页">
          <span className="grid size-9 place-items-center rounded-xl bg-indigo-500 text-white">
            <Sparkles className="size-5" aria-hidden="true" />
          </span>
          <span className="font-semibold tracking-tight">Nova</span>
        </Link>
        <nav className="flex items-center gap-2" aria-label="首页导航">
          <a
            className="hidden rounded-lg px-3 py-2 text-sm text-slate-300 transition hover:bg-white/5 hover:text-white sm:block"
            href="#workflow"
          >
            工作方式
          </a>
          <a
            className="hidden rounded-lg px-3 py-2 text-sm text-slate-300 transition hover:bg-white/5 hover:text-white sm:block"
            href="#install"
          >
            安装
          </a>
          <Link
            className="rounded-xl bg-white/10 px-4 py-2 text-sm font-semibold text-white ring-1 ring-white/15 transition hover:bg-white/15"
            to="/app"
          >
            {auth.isAuthenticated ? "进入工作台" : "登录"}
          </Link>
        </nav>
      </header>

      <main>
        <section className="terminal-grid relative mx-auto grid max-w-7xl gap-14 px-5 pb-24 pt-16 sm:px-8 lg:grid-cols-[1.02fr_0.98fr] lg:items-center lg:pb-32 lg:pt-24">
          <div
            className="absolute -left-40 -top-40 size-[32rem] rounded-full bg-indigo-600/20 blur-3xl"
            aria-hidden="true"
          />
          <div className="relative">
            <span className="inline-flex items-center gap-2 rounded-full bg-indigo-400/10 px-3 py-1.5 text-xs font-semibold text-indigo-200 ring-1 ring-indigo-300/20">
              <span className="size-1.5 rounded-full bg-emerald-400" />
              开源 · 运行在你的设备上
            </span>
            <h1 className="mt-7 max-w-3xl text-balance text-4xl font-semibold leading-[1.08] tracking-[-0.04em] text-white sm:text-6xl lg:text-[3.7rem]">
              AI Coding Agent，<span className="text-indigo-300">直接在真实 workspace 中工作</span>
            </h1>
            <p className="mt-6 max-w-2xl text-base leading-8 text-slate-300 sm:text-lg">
              连接你的 Linux 服务器或 Windows PC，让 Agent
              看见真实代码、执行命令并持续汇报进度。设备归你，边界清晰，随时可以中断。
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <Button
                variant="primary"
                className="min-h-12 px-6"
                icon={<ArrowRight className="size-4" aria-hidden="true" />}
                onClick={() => (auth.isAuthenticated ? window.location.assign("/app") : void auth.login())}
              >
                快速开始
              </Button>
              <a
                href={import.meta.env.VITE_SOURCE_URL || "#install"}
                className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl bg-white/5 px-6 text-sm font-semibold text-white ring-1 ring-white/15 transition hover:scale-[1.02] hover:bg-white/10"
              >
                <Github className="size-4" aria-hidden="true" />
                View Source
              </a>
            </div>

            <div id="install" className="mt-10 max-w-xl rounded-2xl bg-black/30 p-2 ring-1 ring-white/10 backdrop-blur">
              <div className="flex items-center gap-3 rounded-xl bg-slate-900 px-4 py-3">
                <span className="select-none text-indigo-400">$</span>
                <div className="min-w-0 flex-1 space-y-2 text-sm text-slate-200">
                  <code
                    className="block min-w-0 truncate select-all text-ellipsis whitespace-nowrap"
                    title={installCommand}
                  >
                    {installCommand}
                  </code>
                  <code
                    className="block min-w-0 truncate select-all text-ellipsis whitespace-nowrap text-slate-400"
                    title={runCommand}
                  >
                    {runCommand}
                  </code>
                </div>
                <div className="flex shrink-0 flex-col gap-1">
                  <button
                    type="button"
                    onClick={() => void copyCommand(installCommand, "install")}
                    className="grid size-9 place-items-center rounded-lg text-slate-400 transition hover:bg-white/10 hover:text-white"
                    aria-label={copiedCommand === "install" ? "已复制安装命令" : "复制安装命令"}
                  >
                    {copiedCommand === "install" ? (
                      <Check className="size-4 text-emerald-400" aria-hidden="true" />
                    ) : (
                      <Clipboard className="size-4" aria-hidden="true" />
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => token && runnerConnection.data?.endpoint && void copyCommand(runCommand, "run")}
                    disabled={!token || !runnerConnection.data?.endpoint}
                    className="grid size-9 place-items-center rounded-lg text-slate-400 transition hover:bg-white/10 hover:text-white"
                    aria-label={copiedCommand === "run" ? "已复制启动命令" : "复制启动命令"}
                  >
                    {copiedCommand === "run" ? (
                      <Check className="size-4 text-emerald-400" aria-hidden="true" />
                    ) : (
                      <Clipboard className="size-4" aria-hidden="true" />
                    )}
                  </button>
                </div>
              </div>
              {copyFailed && (
                <p className="px-3 pb-1 pt-2 text-xs text-amber-300" role="alert">
                  自动复制失败，请选中命令后手动复制。
                </p>
              )}
            </div>
          </div>

          <TerminalDemo />
        </section>

        <section id="workflow" className="bg-slate-50 py-24 text-slate-900">
          <div className="mx-auto max-w-7xl px-5 sm:px-8">
            <div className="max-w-2xl">
              <p className="text-sm font-semibold text-indigo-600">从设备到结果</p>
              <h2 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">三步开始一次可控的 coding 会话</h2>
              <p className="mt-4 text-base leading-7 text-slate-500">
                Runner 只访问你明确选择的根目录，Project 固定绑定 workspace，Agent 不会悄悄切换执行环境。
              </p>
            </div>
            <div className="mt-12 grid gap-6 md:grid-cols-3">
              <Feature
                icon={<Server className="size-5" aria-hidden="true" />}
                step="01"
                title="连接 Runner"
                description="在 Linux 或 Windows 设备启动 Runner，保持资源归属明确。"
              />
              <Feature
                icon={<MonitorCog className="size-5" aria-hidden="true" />}
                step="02"
                title="选择 workspace"
                description="为 Project 绑定唯一工作目录，路径边界在服务端校验。"
              />
              <Feature
                icon={<Code2 className="size-5" aria-hidden="true" />}
                step="03"
                title="开始 coding"
                description="实时查看消息、工具输出和 TODO，长任务可以随时中断。"
              />
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}

function TerminalDemo() {
  return (
    <div className="relative mx-auto w-full max-w-2xl lg:mx-0" aria-label="Nova 运行效果演示">
      <div className="absolute -inset-10 rounded-full bg-indigo-500/15 blur-3xl" aria-hidden="true" />
      <div className="relative overflow-hidden rounded-2xl bg-[#0a0f1d] ring-1 ring-white/15 shadow-2xl shadow-indigo-950/50">
        <div className="flex h-11 items-center border-b border-white/10 px-4">
          <div className="flex gap-1.5" aria-hidden="true">
            <span className="size-2.5 rounded-full bg-rose-400" />
            <span className="size-2.5 rounded-full bg-amber-300" />
            <span className="size-2.5 rounded-full bg-emerald-400" />
          </div>
          <span className="mx-auto flex items-center gap-2 text-[11px] text-slate-500">
            <TerminalSquare className="size-3.5" aria-hidden="true" />
            nova / workspace
          </span>
        </div>
        <div className="grid min-h-[400px] sm:grid-cols-[168px_1fr]">
          <aside className="border-b border-white/10 p-3 sm:border-b-0 sm:border-r" aria-label="工作台侧栏示意">
            <div className="flex items-center gap-2 px-2 py-1.5">
              <span className="grid size-6 place-items-center rounded-lg bg-indigo-500 text-white">
                <Sparkles className="size-3.5" aria-hidden="true" />
              </span>
              <span className="text-xs font-semibold tracking-tight text-slate-200">Nova</span>
            </div>
            <div className="mt-4 space-y-1 text-[10px] font-medium">
              <p className="flex items-center gap-2 rounded-lg bg-indigo-400/15 px-2.5 py-2 text-indigo-200">
                <LayoutDashboard className="size-3.5" aria-hidden="true" />
                工作台
              </p>
              <p className="flex items-center gap-2 px-2.5 py-2 text-slate-500">
                <Settings className="size-3.5" aria-hidden="true" />
                设置
              </p>
            </div>
            <p className="mt-5 px-2.5 text-[9px] font-semibold uppercase tracking-[0.16em] text-slate-600">项目</p>
            <div className="mt-2 rounded-lg px-2.5 py-2 text-[10px] text-slate-300">
              <div className="flex min-w-0 items-center gap-2">
                <FolderKanban className="size-3.5 shrink-0 text-indigo-300" aria-hidden="true" />
                <span className="truncate">Nova workspace</span>
              </div>
              <p className="mt-1 truncate pl-5 text-[9px] text-slate-600">E:\Project\nova</p>
            </div>
            <p className="mt-4 px-2.5 text-[9px] font-semibold uppercase tracking-[0.16em] text-slate-600">最近</p>
            <p className="mt-2 flex min-w-0 items-center gap-2 truncate px-2.5 text-[10px] text-slate-500">
              <MessageCircle className="size-3.5 shrink-0" aria-hidden="true" />
              空状态与移动端布局
            </p>
          </aside>
          <div className="min-w-0">
            <div className="flex h-12 items-center justify-between border-b border-white/10 px-4 sm:px-5">
              <div className="min-w-0">
                <p className="truncate text-[11px] font-semibold text-slate-200">Nova workspace</p>
                <p className="mt-0.5 flex items-center gap-1.5 text-[9px] text-slate-600">
                  <span className="size-1.5 rounded-full bg-emerald-400" /> Runner 已就绪 · Windows PC
                </p>
              </div>
              <span className="shrink-0 rounded-full bg-emerald-400/10 px-2 py-1 text-[9px] font-semibold text-emerald-300">
                可执行
              </span>
            </div>
            <div className="p-4 font-mono text-[11px] leading-5 sm:p-5">
              <p className="text-slate-600">you</p>
              <p className="mt-1 truncate text-slate-200">把工作台的空状态和移动端布局补完整。</p>
              <p className="mt-5 text-indigo-300">nova</p>
              <p className="mt-1 text-slate-300">我会先检查页面和共享组件，再补齐状态。</p>
              <div className="mt-4 rounded-lg bg-white/[0.035] px-3 py-2.5 ring-1 ring-white/10">
                <p className="mb-2 flex items-center gap-2 text-[9px] font-semibold uppercase tracking-wider text-slate-600">
                  <span className="size-1.5 rounded-full bg-indigo-400" /> 执行计划
                </p>
                <p className="flex items-center gap-2 truncate text-slate-400">
                  <ChevronRight className="size-3 shrink-0 text-emerald-400" aria-hidden="true" />
                  inspect routes/home.tsx
                </p>
                <p className="flex items-center gap-2 truncate text-slate-400">
                  <ChevronRight className="size-3 shrink-0 text-emerald-400" aria-hidden="true" />
                  update empty and mobile states
                </p>
                <p className="flex items-center gap-2 truncate text-slate-400">
                  <ChevronRight className="size-3 shrink-0 animate-pulse text-indigo-400" aria-hidden="true" />
                  run typecheck
                </p>
              </div>
              <div className="mt-4 flex items-center gap-2 rounded-lg bg-emerald-400/5 px-3 py-2 text-[10px] text-emerald-300 ring-1 ring-emerald-400/10">
                <Check className="size-3.5 shrink-0" aria-hidden="true" />
                <span className="truncate">准备开始修改，workspace 边界已锁定</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Feature({
  icon,
  step,
  title,
  description,
}: {
  icon: React.ReactNode;
  step: string;
  title: string;
  description: string;
}) {
  return (
    <article className="rounded-xl bg-white p-6 ring-1 ring-slate-200 transition duration-200 hover:-translate-y-1 hover:shadow-soft">
      <div className="flex items-center justify-between">
        <span className="grid size-10 place-items-center rounded-xl bg-indigo-50 text-indigo-600">{icon}</span>
        <span className="text-xs font-semibold text-slate-300">{step}</span>
      </div>
      <h3 className="mt-6 font-semibold text-slate-900">{title}</h3>
      <p className="mt-2 text-sm leading-6 text-slate-500">{description}</p>
    </article>
  );
}
