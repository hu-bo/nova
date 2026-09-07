import {
  ArrowRight,
  Check,
  ChevronLeft,
  ChevronRight,
  Clipboard,
  Code2,
  Download,
  FolderKanban,
  Github,
  LayoutDashboard,
  Laptop,
  Maximize2,
  MonitorCog,
  MessageCircle,
  Pause,
  Play,
  Server,
  Settings,
  Sparkles,
  TerminalSquare,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { RunnerToken } from "@nova/protocol";
import { useAuth } from "../auth/provider.js";
import { Button } from "../components/ui/button.js";
import { useOpenNewConversation } from "./project/new-conversation.js";
import {
  linuxRunnerCommand,
  npxRunnerCommand,
  runnerReleasesPageUrl,
  windowsRunnerInstallerUrl,
} from "./settings/runner/commands.js";
import { useRunnerConnection, useRunnerTokens } from "./settings/runner/use-runners.js";

export function LandingRoute() {
  const auth = useAuth();
  const navigate = useNavigate();
  const openNewConversation = useOpenNewConversation();
  const runnerTokens = useRunnerTokens(auth.isAuthenticated);
  const runnerConnection = useRunnerConnection(auth.isAuthenticated);
  const [copiedCommand, setCopiedCommand] = useState<"binary" | "npx" | null>(null);
  const [copyFailed, setCopyFailed] = useState(false);
  const token = (runnerTokens.data?.[0] as RunnerToken | undefined)?.token;
  const commandPlaceholder = auth.isAuthenticated ? "正在生成连接命令…" : "登录后生成带 Token 的连接命令";
  const linuxInstallCommand =
    token && runnerConnection.data?.endpoint
      ? linuxRunnerCommand(runnerConnection.data.endpoint, token)
      : commandPlaceholder;
  const npxCommand =
    token && runnerConnection.data?.endpoint
      ? npxRunnerCommand(runnerConnection.data.endpoint, token)
      : commandPlaceholder;

  function openWorkspace(to: string) {
    if (!auth.isAuthenticated) {
      void auth.login();
      return;
    }
    navigate(to);
  }

  function startCoding() {
    if (!auth.isAuthenticated) {
      void auth.login();
      return;
    }
    openNewConversation();
  }

  async function copyCommand(command: string, kind: "binary" | "npx") {
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
          <a
            className="hidden rounded-lg px-3 py-2 text-sm text-slate-300 transition hover:bg-white/5 hover:text-white sm:block"
            href="#principles"
          >
            优势
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
              远程 Runner · Windows / Linux / macOS
            </span>
            <h1 className="mt-7 max-w-3xl text-balance text-4xl font-semibold leading-[1.08] tracking-[-0.04em] text-white sm:text-6xl lg:text-[3.7rem]">
              一个工作台，<span className="text-indigo-300">连接多台远程 Runner</span>
            </h1>
            <p className="mt-6 max-w-2xl text-base leading-8 text-slate-300 sm:text-lg">
              让 Windows、Linux 和 macOS 设备同时在线，在同一个 Web UI 中为不同会话选择不同 Runner 和 workspace。Agent
              在真实环境里读写代码、执行命令并持续汇报进度。
            </p>
            <p className="mt-3 max-w-2xl text-sm leading-7 text-slate-400 sm:text-base">
              原生 Runner 单文件运行，无需 Node.js、npm 等运行时依赖；也可以用 npx 快速体验。Runner
              主动连接服务端，不必为远程设备开放入站端口。
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
              {/* <a
                href={import.meta.env.VITE_SOURCE_URL || "#install"}
                className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl bg-white/5 px-6 text-sm font-semibold text-white ring-1 ring-white/15 transition hover:scale-[1.02] hover:bg-white/10"
              >
                <Github className="size-4" aria-hidden="true" />
                View Source
              </a> */}
            </div>

            <div
              id="install"
              className="mt-10 max-w-2xl overflow-hidden rounded-2xl bg-black/30 ring-1 ring-white/10 backdrop-blur"
            >
              <div className="p-4 sm:p-5">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-white">原生二进制</span>
                      <span className="rounded-full bg-emerald-400/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-300 ring-1 ring-emerald-400/20">
                        推荐
                      </span>
                    </div>
                    <p className="mt-1 text-xs leading-5 text-slate-400">
                      后台常驻、开机自启，运行时无需 Node.js / npm。
                    </p>
                  </div>
                  <a
                    href={windowsRunnerInstallerUrl}
                    className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg bg-indigo-500 px-3 py-2 text-xs font-semibold text-white transition hover:bg-indigo-400"
                  >
                    <Download className="size-3.5" aria-hidden="true" />
                    下载 Windows 安装器
                  </a>
                </div>
                <p className="mt-4 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                  Linux 一行安装
                </p>
                <div className="mt-2 flex items-center gap-3 rounded-xl bg-slate-900 px-4 py-3">
                  <span className="select-none text-indigo-400">$</span>
                  <div className="min-w-0 flex-1 text-sm text-slate-200">
                    <code
                      className="block min-w-0 truncate select-all text-ellipsis whitespace-nowrap text-slate-400"
                      title={linuxInstallCommand}
                    >
                      {linuxInstallCommand}
                    </code>
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      token && runnerConnection.data?.endpoint && void copyCommand(linuxInstallCommand, "binary")
                    }
                    disabled={!token || !runnerConnection.data?.endpoint}
                    className="grid size-9 shrink-0 place-items-center rounded-lg text-slate-400 transition hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
                    aria-label={copiedCommand === "binary" ? "已复制 Linux 安装命令" : "复制 Linux 安装命令"}
                  >
                    {copiedCommand === "binary" ? (
                      <Check className="size-4 text-emerald-400" aria-hidden="true" />
                    ) : (
                      <Clipboard className="size-4" aria-hidden="true" />
                    )}
                  </button>
                </div>
                <a
                  href={runnerReleasesPageUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-indigo-300 transition hover:text-indigo-200"
                >
                  查看 macOS 与全部平台二进制
                  <ChevronRight className="size-3.5" aria-hidden="true" />
                </a>
              </div>

              <div className="border-t border-white/10 p-4 sm:p-5">
                <div>
                  <span className="text-sm font-semibold text-white">npx 快速运行</span>
                  <p className="mt-1 text-xs leading-5 text-slate-400">
                    适合临时体验和开发调试，需要本机已安装 Node.js。
                  </p>
                </div>
                <div className="mt-3 flex items-center gap-3 rounded-xl bg-slate-900 px-4 py-3">
                  <span className="select-none text-indigo-400">$</span>
                  <div className="min-w-0 flex-1 text-sm text-slate-200">
                    <code
                      className="block min-w-0 truncate select-all text-ellipsis whitespace-nowrap text-slate-400"
                      title={npxCommand}
                    >
                      {npxCommand}
                    </code>
                  </div>
                  <button
                    type="button"
                    onClick={() => token && runnerConnection.data?.endpoint && void copyCommand(npxCommand, "npx")}
                    disabled={!token || !runnerConnection.data?.endpoint}
                    className="grid size-9 shrink-0 place-items-center rounded-lg text-slate-400 transition hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
                    aria-label={copiedCommand === "npx" ? "已复制 npx 命令" : "复制 npx 命令"}
                  >
                    {copiedCommand === "npx" ? (
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

        <section className="relative border-t border-white/10 bg-slate-950 px-5 py-24 sm:px-8 lg:py-28">
          <div
            className="absolute left-1/2 top-0 h-64 w-[80%] -translate-x-1/2 bg-indigo-500/10 blur-3xl"
            aria-hidden="true"
          />
          <div className="relative mx-auto max-w-7xl">
            <div className="mx-auto max-w-3xl text-center">
              <p className="text-sm font-semibold text-indigo-300">真实工作现场</p>
              <h2 className="mt-3 text-balance text-3xl font-semibold tracking-tight text-white sm:text-4xl">
                从执行过程到变更授权，全程清晰可控
              </h2>
              <p className="mt-4 text-base leading-7 text-slate-400">
                在真实 workspace 中查看工具调用、代码变更和任务计划；涉及写入时，由你决定允许、拒绝或终止流程。
              </p>
            </div>

            <a
              href="/images/nova-real-workspace.png"
              target="_blank"
              rel="noreferrer"
              className="group mt-12 block overflow-hidden rounded-2xl bg-[#0a0f1d] ring-1 ring-white/15 shadow-2xl shadow-indigo-950/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
              aria-label="在新窗口查看 Nova 真实工作界面原图"
            >
              <div className="flex h-11 items-center border-b border-white/10 px-4">
                <div className="flex gap-1.5" aria-hidden="true">
                  <span className="size-2.5 rounded-full bg-rose-400" />
                  <span className="size-2.5 rounded-full bg-amber-300" />
                  <span className="size-2.5 rounded-full bg-emerald-400" />
                </div>
                <span className="mx-auto text-[11px] text-slate-500">Nova · 真实 coding 会话</span>
                <span className="flex items-center gap-1.5 text-[10px] font-medium text-slate-500 transition group-hover:text-indigo-300">
                  <Maximize2 className="size-3.5" aria-hidden="true" />
                  查看原图
                </span>
              </div>
              <div className="overflow-hidden bg-white">
                <img
                  src="/images/nova-real-workspace.png"
                  alt="Nova 真实工作界面，展示代码读取、写入授权以及右侧实时任务计划"
                  width="1457"
                  height="944"
                  loading="lazy"
                  decoding="async"
                  className="block h-auto w-full transition duration-500 group-hover:scale-[1.005] motion-reduce:transition-none"
                />
              </div>
              <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 border-t border-white/10 px-4 py-3 text-[11px] font-medium text-slate-400 sm:justify-start sm:px-5">
                <span className="flex items-center gap-1.5">
                  <Check className="size-3.5 text-emerald-400" aria-hidden="true" /> 操作前授权
                </span>
                <span className="flex items-center gap-1.5">
                  <Check className="size-3.5 text-emerald-400" aria-hidden="true" /> 工具过程可见
                </span>
                <span className="flex items-center gap-1.5">
                  <Check className="size-3.5 text-emerald-400" aria-hidden="true" /> 实时任务计划
                </span>
              </div>
            </a>
            <p className="mt-3 text-center text-xs text-slate-600 sm:hidden">点击截图可查看完整尺寸</p>
          </div>
        </section>

        <section id="workflow" className="bg-slate-50 py-24 text-slate-900">
          <div className="mx-auto max-w-7xl px-5 sm:px-8">
            <div className="max-w-2xl">
              <p className="text-sm font-semibold text-indigo-600">一处登录，多端执行</p>
              <h2 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
                把不同平台的真实设备接入同一个工作台
              </h2>
              <p className="mt-4 text-base leading-7 text-slate-500">
                多台 Windows、Linux、macOS Runner 可以同时在线，不同会话分别连接需要的设备与 workspace。
              </p>
            </div>
            <div className="mt-12 grid gap-6 md:grid-cols-3">
              <Feature
                icon={<Server className="size-5" aria-hidden="true" />}
                step="01"
                title="安装远程 Runner"
                description="使用无 Node.js 运行时依赖的原生二进制长期运行，也可以用 npx 快速接入。"
                action="前往 Runner 管理"
                onClick={() => openWorkspace("/settings/runners")}
              />
              <Feature
                icon={<MonitorCog className="size-5" aria-hidden="true" />}
                step="02"
                title="选择设备与 workspace"
                description="为不同 Project 和会话选择在线 Runner，并把操作限制在明确的工作目录内。"
                action="创建 Project"
                onClick={() => openWorkspace("/app?createProject=1")}
              />
              <Feature
                icon={<Code2 className="size-5" aria-hidden="true" />}
                step="03"
                title="跨设备开始对话"
                description="在一个 Web UI 中查看消息、工具输出和 TODO，让多台设备各自在真实环境中工作。"
                action="开始普通 Chat"
                onClick={startCoding}
              />
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-white/10 bg-slate-950">
        <div className="mx-auto flex max-w-7xl flex-col gap-8 px-5 py-10 sm:px-8 md:flex-row md:items-start md:justify-between">
          <div className="max-w-sm">
            <Link to="/" className="flex items-center gap-3" aria-label="Nova 首页">
              <span className="grid size-8 place-items-center rounded-lg bg-indigo-500 text-white">
                <Sparkles className="size-4" aria-hidden="true" />
              </span>
              <span className="font-semibold tracking-tight text-white">Nova</span>
            </Link>
            <p className="mt-4 text-sm leading-6 text-slate-400">
              一个 Web UI 连接多台远程 Runner，让 AI 在你授权的真实设备与 workspace 中完成工作。
            </p>
          </div>
          <div className="grid grid-cols-2 gap-x-12 gap-y-3 text-sm sm:flex sm:gap-7">
            <a className="text-slate-400 transition hover:text-white" href="#workflow">
              工作方式
            </a>
            <a className="text-slate-400 transition hover:text-white" href="#install">
              安装 Runner
            </a>
            <Link className="text-slate-400 transition hover:text-white" to="/app">
              进入工作台
            </Link>
            {import.meta.env.VITE_SOURCE_URL && (
              <a
                className="inline-flex items-center gap-1.5 text-slate-400 transition hover:text-white"
                href={import.meta.env.VITE_SOURCE_URL}
                target="_blank"
                rel="noreferrer"
              >
                <Github className="size-4" aria-hidden="true" />
                源码
              </a>
            )}
          </div>
        </div>
        <div className="mx-auto max-w-7xl border-t border-white/10 px-5 py-5 text-xs text-slate-500 sm:px-8">
          © {new Date().getFullYear()} Nova. Built for your workspace.
        </div>
      </footer>
    </div>
  );
}

const terminalDemoSlides = ["对话执行", "多端 Runner"] as const;

function TerminalDemo() {
  const [activeSlide, setActiveSlide] = useState(0);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (paused || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const timer = window.setTimeout(
      () => setActiveSlide((current) => (current + 1) % terminalDemoSlides.length),
      5_500,
    );
    return () => window.clearTimeout(timer);
  }, [activeSlide, paused]);

  function showSlide(index: number) {
    setActiveSlide((index + terminalDemoSlides.length) % terminalDemoSlides.length);
  }

  return (
    <div className="relative mx-auto w-full max-w-2xl lg:mx-0" aria-label="Nova 功能演示" aria-roledescription="轮播">
      <div key={activeSlide} className="animate-in fade-in duration-300 motion-reduce:animate-none">
        {activeSlide === 0 ? <WorkspaceConversationDemo /> : <RunnerFleetDemo />}
      </div>
      <div className="relative mt-4 flex items-center justify-center gap-2" aria-label="切换演示画面">
        <DemoControl label="上一张演示" onClick={() => showSlide(activeSlide - 1)}>
          <ChevronLeft className="size-4" aria-hidden="true" />
        </DemoControl>
        {terminalDemoSlides.map((slide, index) => (
          <button
            key={slide}
            type="button"
            onClick={() => showSlide(index)}
            className={`h-2 rounded-full transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950 ${
              activeSlide === index ? "w-7 bg-indigo-400" : "w-2 bg-slate-700 hover:bg-slate-500"
            }`}
            aria-label={`显示${slide}演示`}
            aria-current={activeSlide === index ? "true" : undefined}
          />
        ))}
        <DemoControl label={paused ? "继续自动轮播" : "暂停自动轮播"} onClick={() => setPaused((value) => !value)}>
          {paused ? (
            <Play className="size-3.5" aria-hidden="true" />
          ) : (
            <Pause className="size-3.5" aria-hidden="true" />
          )}
        </DemoControl>
        <DemoControl label="下一张演示" onClick={() => showSlide(activeSlide + 1)}>
          <ChevronRight className="size-4" aria-hidden="true" />
        </DemoControl>
      </div>
    </div>
  );
}

function WorkspaceConversationDemo() {
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
                  <span className="size-1.5 rounded-full bg-emerald-400" /> Windows PC · 另有 2 台 Runner 在线
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

function RunnerFleetDemo() {
  const runners = [
    {
      name: "studio-windows",
      platform: "Windows 11 · x64",
      workspace: "E:\\Project\\nova",
      state: "在线",
      stateClass: "bg-emerald-400/10 text-emerald-300 ring-emerald-400/15",
      icon: <Laptop className="size-4" aria-hidden="true" />,
    },
    {
      name: "build-linux",
      platform: "Ubuntu 24.04 · x64",
      workspace: "/srv/nova",
      state: "忙碌 · 2",
      stateClass: "bg-amber-400/10 text-amber-300 ring-amber-400/15",
      icon: <Server className="size-4" aria-hidden="true" />,
    },
    {
      name: "macbook-pro",
      platform: "macOS · arm64",
      workspace: "/Users/nova/workspace",
      state: "在线",
      stateClass: "bg-emerald-400/10 text-emerald-300 ring-emerald-400/15",
      icon: <MonitorCog className="size-4" aria-hidden="true" />,
    },
  ] as const;

  return (
    <div className="relative mx-auto w-full max-w-2xl lg:mx-0" aria-label="多平台 Runner 管理演示">
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
            nova / runners
          </span>
        </div>
        <div className="min-h-[400px] p-4 sm:p-5">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-slate-100">已注册 Runner</p>
              <p className="mt-1 text-[10px] text-slate-500">设备启动后自动注册，状态通过服务端实时刷新</p>
            </div>
            <span className="shrink-0 rounded-full bg-emerald-400/10 px-2.5 py-1 text-[9px] font-semibold text-emerald-300 ring-1 ring-emerald-400/15">
              3 台设备在线
            </span>
          </div>

          <div className="mt-5 overflow-hidden rounded-xl bg-white/[0.025] ring-1 ring-white/10">
            <div className="hidden grid-cols-[1.1fr_0.75fr_1fr_auto] gap-3 border-b border-white/10 px-4 py-2.5 text-[9px] font-semibold uppercase tracking-wider text-slate-600 sm:grid">
              <span>Runner</span>
              <span>状态</span>
              <span>Workspace</span>
              <span>操作</span>
            </div>
            {runners.map((runner, index) => (
              <div
                key={runner.name}
                className={`grid gap-3 px-4 py-3.5 sm:grid-cols-[1.1fr_0.75fr_1fr_auto] sm:items-center ${
                  index ? "border-t border-white/[0.07]" : ""
                }`}
              >
                <div className="flex min-w-0 items-center gap-3">
                  <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-indigo-400/10 text-indigo-300 ring-1 ring-indigo-400/10">
                    {runner.icon}
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-[11px] font-semibold text-slate-200">{runner.name}</p>
                    <p className="mt-0.5 truncate text-[9px] text-slate-600">{runner.platform}</p>
                  </div>
                </div>
                <div>
                  <span
                    className={`inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-[9px] font-semibold ring-1 ${runner.stateClass}`}
                  >
                    <span className="size-1.5 rounded-full bg-current" />
                    {runner.state}
                  </span>
                </div>
                <p className="truncate font-mono text-[9px] text-slate-500" title={runner.workspace}>
                  {runner.workspace}
                </p>
                <span
                  className={`w-fit rounded-lg px-2.5 py-1.5 text-[9px] font-semibold ring-1 ${
                    index === 0 ? "bg-indigo-400/15 text-indigo-200 ring-indigo-400/20" : "text-slate-500 ring-white/10"
                  }`}
                >
                  {index === 0 ? "当前" : "选择"}
                </span>
              </div>
            ))}
          </div>
          <div className="mt-4 flex items-center gap-2 rounded-lg bg-indigo-400/5 px-3 py-2.5 text-[10px] text-indigo-200 ring-1 ring-indigo-400/10">
            <Server className="size-3.5 shrink-0" aria-hidden="true" />
            <span className="truncate">一个账号管理多平台 Runner，为不同会话选择执行设备</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function DemoControl({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="grid size-8 place-items-center rounded-lg text-slate-500 transition hover:bg-white/5 hover:text-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
      aria-label={label}
    >
      {children}
    </button>
  );
}

function Feature({
  icon,
  step,
  title,
  description,
  action,
  onClick,
  disabled = false,
}: {
  icon: React.ReactNode;
  step: string;
  title: string;
  description: string;
  action: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="group rounded-xl bg-white p-6 text-left ring-1 ring-slate-200 transition duration-200 hover:-translate-y-1 hover:shadow-soft focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:pointer-events-none disabled:opacity-60"
    >
      <div className="flex items-center justify-between">
        <span className="grid size-10 place-items-center rounded-xl bg-indigo-50 text-indigo-600">{icon}</span>
        <span className="text-xs font-semibold text-slate-300">{step}</span>
      </div>
      <h3 className="mt-6 font-semibold text-slate-900">{title}</h3>
      <p className="mt-2 text-sm leading-6 text-slate-500">{description}</p>
      <span className="mt-5 flex items-center gap-1 text-xs font-semibold text-indigo-600">
        {action} <ArrowRight className="size-3.5 transition group-hover:translate-x-1" aria-hidden="true" />
      </span>
    </button>
  );
}

function Benefit({ icon, title, description }: { icon: React.ReactNode; title: string; description: string }) {
  return (
    <article className="rounded-2xl bg-white/[0.04] p-6 ring-1 ring-white/10">
      <span className="grid size-10 place-items-center rounded-xl bg-indigo-400/10 text-indigo-200">{icon}</span>
      <h3 className="mt-5 font-semibold text-white">{title}</h3>
      <p className="mt-2 text-sm leading-6 text-slate-400">{description}</p>
    </article>
  );
}
