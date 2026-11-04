import { useEffect, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  CheckCheck,
  ChevronRight,
  CircleDot,
  Code2,
  Command,
  Copy,
  FileCode2,
  Folder,
  GitBranch,
  Globe2,
  KeyRound,
  Laptop,
  Layers3,
  LockKeyhole,
  Menu,
  MessageSquare,
  Monitor,
  Plus,
  Server,
  ShieldCheck,
  Sparkles,
  Terminal,
  Workflow,
  X,
  Zap,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { copyText } from '@/lib/clipboard';
import { useIdentity } from '@/features/auth';
import {
  runnerStartCommand,
  runnerTokenCanStart,
  useRunnerConnection,
  useRunnerTokensQuery,
} from '@/features/runners';
import './landing.css';

function NovaMark({ small = false }: { small?: boolean }) {
  return (
    <span className={`landing-mark ${small ? 'landing-mark-small' : ''}`} aria-hidden="true">
      <svg viewBox="0 0 32 32" fill="none">
        <path
          d="M7 23V9h4l10 14h4V9M7 9l18 14"
          stroke="currentColor"
          strokeWidth="2.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}

const runnerEnvironments = [
  {
    id: 'local',
    label: '本地开发',
    runtime: 'cargo',
  },
  {
    id: 'production',
    label: '正式部署',
    runtime: 'npx',
  },
] as const;

function ConnectPanel() {
  const { identity, login } = useIdentity();
  const tokens = useRunnerTokensQuery();
  const connection = useRunnerConnection();
  const [envIndex, setEnvIndex] = useState(import.meta.env.DEV ? 0 : 1);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle');
  const [loginError, setLoginError] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const env = runnerEnvironments[envIndex]!;
  const token = tokens.data?.items.find((item) => runnerTokenCanStart(item) && item.token)?.token;
  const result = runnerStartCommand({
    endpoint: connection.data?.endpoint ?? '',
    token: token ?? '',
    workspace: '',
    shell: navigator.platform.startsWith('Win') ? 'powershell' : 'bash',
    runtime: env.runtime,
  });
  const command = identity && !tokens.isError && !connection.isError ? result.command : null;
  const placeholder = !identity
    ? '登录后自动展示带 Token 的连接命令'
    : tokens.isError || connection.isError
      ? '连接信息加载失败，请重试。'
      : tokens.isPending || connection.isPending
        ? '正在加载连接命令…'
        : !token
          ? '暂无可用 Token，请在设备管理中创建或轮换凭据。'
          : result.error;
  useEffect(() => () => clearTimeout(timerRef.current), []);
  async function copy() {
    if (!command) return;
    clearTimeout(timerRef.current);
    try {
      await copyText(command);
      setCopyState('copied');
    } catch {
      setCopyState('error');
    }
    timerRef.current = setTimeout(() => setCopyState('idle'), 2500);
  }
  return (
    <aside className="landing-connect" id="install" aria-labelledby="connect-title">
      <div className="landing-connect-head">
        <Terminal size={16} />
        <h2 id="connect-title">连接你的设备</h2>
        <span className="landing-connect-scheme">
          {connection.data?.endpoint.startsWith('wss:') ? 'wss · 加密回连' : 'ws · 设备回连'}
        </span>
      </div>
      <div className="landing-connect-tabs" role="group" aria-label="部署环境">
        {runnerEnvironments.map((item, index) => (
          <button
            key={item.id}
            type="button"
            aria-pressed={index === envIndex}
            onClick={() => {
              setEnvIndex(index);
              setCopyState('idle');
              clearTimeout(timerRef.current);
            }}
          >
            {item.id === 'local' ? <Code2 size={14} /> : <Globe2 size={14} />}
            {item.label}
          </button>
        ))}
      </div>
      <div className="landing-connect-code">
        <div>
          <span>Windows · Linux · macOS 同一条命令</span>
          <Button
            variant="ghost"
            isIconOnly
            disabled={!command}
            aria-label={copyState === 'copied' ? '启动命令已复制' : '复制启动命令'}
            onPress={() => void copy()}
            className="landing-copy-button"
          >
            {copyState === 'copied' ? <Check size={15} /> : <Copy size={15} />}
          </Button>
        </div>
        <pre>
          <code>
            {command ? (
              <>
                <i>$ </i>
                {command}
              </>
            ) : (
              placeholder
            )}
          </code>
        </pre>
      </div>
      <p className="landing-connect-note">
        在项目目录中运行，默认使用当前目录作为 workspace。
        {env.id === 'production' ? '需要已安装 Node.js。' : ''}
      </p>
      <div className="landing-connect-status" role="status">
        {loginError
          ? '暂时无法登录，请稍后重试。'
          : copyState === 'copied'
            ? '启动命令已复制。'
            : copyState === 'error'
              ? '复制失败，请手动复制上方命令。'
              : ''}
      </div>
      {identity ? (
        tokens.isError || connection.isError ? (
          <Button
            variant="ghost"
            className="landing-connect-action"
            onPress={() => {
              void tokens.refetch();
              void connection.refetch();
            }}
          >
            重新加载连接信息
          </Button>
        ) : (
          <Link to="/settings/runners" className="landing-connect-action">
            {token ? '管理设备和 Token' : '去设备管理创建 Token'} <ArrowRight size={14} />
          </Link>
        )
      ) : (
        <Button
          variant="ghost"
          className="landing-connect-action"
          onPress={() => {
            setLoginError(false);
            void login().catch(() => setLoginError(true));
          }}
        >
          登录并获取连接命令 <ArrowRight size={14} />
        </Button>
      )}
    </aside>
  );
}

const devices = [
  { name: 'Studio PC', platform: 'Windows 11', arch: 'x64', path: 'E:\\Projects\\nova', icon: Monitor, label: '当前设备' },
  { name: 'Build Server', platform: 'Ubuntu 24.04', arch: 'x64', path: '/srv/workspace/nova', icon: Server, label: '构建环境' },
  { name: 'MacBook Pro', platform: 'macOS', arch: 'arm64', path: '~/Developer/nova', icon: Laptop, label: '开发环境' },
];

function WorkspacePreview() {
  const [view, setView] = useState('workspace');
  const [selectedDevice, setSelectedDevice] = useState(0);
  const tabs = [
    { id: 'workspace', label: 'Agent 工作台', icon: MessageSquare },
    { id: 'devices', label: '多设备协作', icon: Monitor },
  ];
  const currentDevice = devices[selectedDevice]!;

  function moveTab(event: React.KeyboardEvent<HTMLButtonElement>, index: number) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
      : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    setView(tabs[next]!.id);
    document.getElementById(`preview-tab-${tabs[next]!.id}`)?.focus();
  }

  return (
    <div className="landing-preview-wrap">
      <div className="landing-preview-toolbar">
        <div role="tablist" aria-label="产品演示" className="landing-preview-tabs">
          {tabs.map(({ id, label, icon: Icon }, index) => (
            <button key={id} id={`preview-tab-${id}`} type="button" role="tab"
              aria-selected={view === id} aria-controls={`preview-panel-${id}`}
              tabIndex={view === id ? 0 : -1} onClick={() => setView(id)}
              onKeyDown={(event) => moveTab(event, index)}>
              <Icon size={15} aria-hidden="true" />{label}
            </button>
          ))}
        </div>

      </div>
      <div className="landing-preview-window">
        <div className="landing-window-bar">
          <div className="landing-window-dots" aria-hidden="true"><i /><i /><i /></div>
          <span><LockKeyhole size={11} aria-hidden="true" /> nova / your workspace</span>
          <span className="landing-window-shortcut" aria-hidden="true"><Command size={11} /> K</span>
        </div>
        <div role="tabpanel" id={`preview-panel-${view}`} aria-labelledby={`preview-tab-${view}`} tabIndex={0}>
          {view === 'workspace' ? (
            <div className="landing-workspace">
              <aside className="landing-demo-sidebar" aria-label="演示工作台导航">
                <div className="landing-demo-brand"><NovaMark small /><strong>Nova</strong><span>workspace</span></div>
                <div className="landing-demo-new"><Plus size={14} /> 新建会话 <span>⌘ N</span></div>
                <p className="landing-demo-section">工作空间</p>
                <div className="landing-demo-nav"><Folder size={14} /> Nova project <ChevronRight size={12} /></div>
                <div className="landing-demo-nav muted"><Folder size={14} /> Personal website</div>
                <p className="landing-demo-section">最近会话</p>
                <div className="landing-demo-nav active"><MessageSquare size={13} /> 构建一个更好的首页</div>
                <div className="landing-demo-nav muted"><MessageSquare size={13} /> 优化 API 响应速度</div>
                <div className="landing-demo-nav muted"><MessageSquare size={13} /> 整理项目文档</div>
                <div className="landing-demo-sidebar-bottom"><span className="landing-avatar">N</span><span>你的工作空间<small>让想法持续发生</small></span><ChevronRight size={13} /></div>
              </aside>
              <div className="landing-demo-chat">
                <div className="landing-chat-header"><span><Folder size={14} /> Nova project <ChevronRight size={12} /><strong>构建一个更好的首页</strong></span><span className="landing-connected"><i /> Studio PC</span></div>
                <div className="landing-chat-body">
                  <div className="landing-user-message">为 Nova 设计一个漂亮的首页，支持移动端。<span>你</span></div>
                  <div className="landing-agent-message"><NovaMark small /><div><strong>Nova <span>Agent</span></strong><p>让我们把想法变成现实。我会先了解项目，再完成设计和实现。</p></div></div>
                  <div className="landing-plan"><span className="landing-plan-heading"><Workflow size={13} />执行计划 <small>2 / 3</small></span><p><CheckCheck size={14} /> 分析项目结构与设计规范</p><p><CheckCheck size={14} /> 实现响应式首页与交互</p><p className="running"><CircleDot size={14} /> 检查类型与构建结果 <span>进行中</span></p></div>
                  <div className="landing-tool-output"><div><Terminal size={13} /><span>terminal</span><small>~/workspace/nova</small></div><code><span>$</span> pnpm build<br /><span className="landing-terminal-success">✓</span> TypeScript check passed<br /><span className="landing-terminal-success">✓</span> 142 modules transformed.</code></div>
                  <div className="landing-demo-composer"><span>继续描述你的想法…</span><div><span><Plus size={14} /><span>Studio PC</span><ChevronRight size={11} /></span><span className="landing-send"><ArrowRight size={14} /></span></div></div>
                </div>
              </div>
              <aside className="landing-changes" aria-label="演示变更预览"><p><Layers3 size={14} /> 工作进展</p><span className="landing-demo-section">本次变更</span><div><FileCode2 size={13} /> landing.tsx <span>+128</span></div><div><FileCode2 size={13} /> landing.css <span>+86</span></div><div><FileCode2 size={13} /> index.tsx <span>+3</span></div><div className="landing-code-preview"><span>01 <i>export function</i> Home() {'{'}</span><span>02 &nbsp; <i>return</i> (</span><span className="added">03 &nbsp; &nbsp; &lt;main&gt;</span><span className="added">04 &nbsp; &nbsp; &nbsp; &lt;Hero /&gt;</span><span className="added">05 &nbsp; &nbsp; &nbsp; &lt;Features /&gt;</span><span className="added">06 &nbsp; &nbsp; &lt;/main&gt;</span><span>07 &nbsp; );</span><span>08 {'}'}</span></div><div className="landing-workspace-note"><ShieldCheck size={15} /><span>操作始终在你指定的<br />workspace 内进行</span></div></aside>
            </div>
          ) : (
            <div className="landing-fleet">
              <div className="landing-fleet-heading"><div><span className="landing-eyebrow">YOUR CONNECTED WORKSPACE</span><h3>你的设备，随时就位。</h3><p>选择一台设备，查看对应的执行环境。</p></div><span className="landing-connected"><i /> 3 台示例设备</span></div>
              <div className="landing-fleet-grid">{devices.map((device, index) => <button type="button" key={device.name} aria-pressed={selectedDevice === index} onClick={() => setSelectedDevice(index)} className={`landing-device ${selectedDevice === index ? 'selected' : ''}`}><div><device.icon size={25} /><span className="landing-connected"><i /> 在线</span></div><h4>{device.name}</h4><p>{device.platform} <span>· {device.arch}</span></p><code>{device.path}</code><span className="landing-device-select">{selectedDevice === index ? <><Check size={14} /> 已选择</> : <>选择设备 <ArrowRight size={14} /></>}</span></button>)}</div>
              <div className="landing-fleet-current" aria-live="polite"><Terminal size={17} /><span>当前演示环境 <strong>{currentDevice.name}</strong><code>{currentDevice.path}</code></span><ShieldCheck size={17} /><small>工作目录隔离</small></div>
            </div>
          )}
        </div>
        <div className="landing-window-footer"><span><GitBranch size={12} /> main <span className="landing-footer-divider">/</span> nova-workspace</span><span><ShieldCheck size={12} /> 你的环境，你来掌控</span></div>
      </div>
      <div className="landing-preview-caption"><span /><p>从一句想法，到真实的代码与结果。</p><span /></div>
    </div>
  );
}

export function LandingPage() {
  const { identity } = useIdentity();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setMenuOpen(false); menuTriggerRef.current?.focus(); }
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [menuOpen]);
  return (
    <div className="landing-page">
      <a href="#main-content" className="landing-skip-link">跳到主要内容</a>
      <header className="landing-header landing-container"><Link to="/" className="landing-brand" aria-label="Nova 首页"><NovaMark /><span>nova<span className="landing-brand-dot">.</span></span></Link><nav className="landing-desktop-nav" aria-label="主导航"><a href="#install">连接设备</a><a href="#preview">工作台演示</a><a href="#features">产品优势</a><a href="#workflow">工作方式</a></nav><div className="landing-header-actions"><Link to="/conversations" className="landing-login">{identity ? '进入工作台' : '登录'}<ArrowUpRight size={14} /></Link><Button ref={menuTriggerRef} variant="ghost" isIconOnly className="landing-menu-button" aria-label={menuOpen ? '关闭菜单' : '打开菜单'} aria-expanded={menuOpen} aria-controls="landing-mobile-nav" onPress={() => setMenuOpen(!menuOpen)}>{menuOpen ? <X size={20} /> : <Menu size={20} />}</Button></div>{menuOpen && <nav id="landing-mobile-nav" className="landing-mobile-nav" aria-label="移动端主导航"><a href="#install" onClick={() => setMenuOpen(false)}>连接设备<ArrowUpRight size={15} /></a><a href="#preview" onClick={() => setMenuOpen(false)}>工作台演示<ArrowUpRight size={15} /></a><a href="#features" onClick={() => setMenuOpen(false)}>产品优势<ArrowUpRight size={15} /></a><a href="#workflow" onClick={() => setMenuOpen(false)}>工作方式<ArrowUpRight size={15} /></a></nav>}</header>
      <main id="main-content">
        <section className="landing-hero landing-container" aria-labelledby="hero-title">
          <div className="landing-hero-glow" aria-hidden="true" />
          <div className="landing-hero-grid">
            <div className="landing-hero-copy">
              <a href="#preview" className="landing-announcement"><span className="landing-announcement-dot" /><span>你的下一代 AI 开发工作台</span><span className="landing-announcement-arrow"><ArrowRight size={13} /></span></a>
              <div className="landing-hero-overline">YOUR IDEAS. YOUR MACHINES. ONE WORKSPACE.</div>
              <h1 id="hero-title">想法在这里发生。<br /><span>创造，在每一台设备。</span></h1>
              <p className="landing-hero-description">一个工作台，连接你的所有开发环境。<br />让 AI 在真实的设备中读写代码、执行命令，把想法一步步变成作品。</p>
              <div className="landing-hero-actions"><Link to="/conversations" className="landing-primary-link">开始创造 <ArrowRight size={17} /></Link><a href="#preview" className="landing-secondary-link"><span className="landing-play-icon">▶</span> 看看 Nova 如何工作</a></div>
              <div className="landing-hero-footnotes"><span><Check size={12} /> 你的设备与代码</span><i /><span><Check size={12} /> Windows · Linux · macOS</span><i /><span><Check size={12} /> 一个浏览器即可</span></div>
            </div>
            <ConnectPanel />
          </div>
        </section>
        <section className="landing-preview-section landing-container" id="preview" aria-labelledby="preview-title">
          <div className="landing-section-heading"><div><span className="landing-eyebrow">SEE NOVA AT WORK</span><h2 id="preview-title">这就是你与 Nova 的工作方式</h2></div></div>
          <WorkspacePreview />
        </section>
        <section className="landing-features landing-container" id="features" aria-labelledby="features-title"><div className="landing-section-heading"><div><span className="landing-eyebrow">BUILT AROUND YOUR FLOW</span><h2 id="features-title">不打断灵感，只连接可能。</h2></div></div><div className="landing-feature-grid"><article className="landing-feature-card landing-feature-fleet"><div className="landing-feature-icon"><Workflow size={21} /></div><h3>一个工作台，无限可能</h3><p>多台 Runner 同时在线，为不同项目选择合适的设备。切换环境，工作思路始终连贯。</p><div className="landing-network" aria-label="Nova 连接 Windows、Linux 和 macOS 的示意图"><svg viewBox="0 0 320 135" preserveAspectRatio="none" aria-hidden="true"><path d="M160 25V55Q160 66 145 66H58Q45 66 45 80V97M160 25V97M160 25V55Q160 66 175 66H262Q275 66 275 80V97" /></svg><span className="landing-network-center"><NovaMark small /> Nova</span><span className="landing-network-device"><Monitor size={19} /><small>Windows</small><i /></span><span className="landing-network-device"><Server size={19} /><small>Linux</small><i /></span><span className="landing-network-device"><Laptop size={19} /><small>macOS</small><i /></span></div><span className="landing-feature-tag"><span />跨平台，自由连接</span></article><article className="landing-feature-card"><div className="landing-feature-icon"><Code2 size={21} /></div><h3>不止对话，更能动手</h3><p>在真实 workspace 中读文件、改代码、运行命令。每一步都有反馈，每个结果都可追溯。</p><div className="landing-mini-terminal"><div><Terminal size={12} /><span>nova-agent</span><i /></div><p><Check size={13} /> 读取项目上下文 <span>done</span></p><p><Check size={13} /> 更新页面与组件 <span>done</span></p><p><CircleDot size={13} /> 运行构建检查 <span>running</span></p></div><span className="landing-feature-tag"><Zap size={12} />从思考到执行，一气呵成</span></article><article className="landing-feature-card"><div className="landing-feature-icon"><ShieldCheck size={21} /></div><h3>你的环境，你来掌控</h3><p>Runner 主动连接服务端，无需开放设备入站端口。在指定的工作目录中，安心推进项目。</p><div className="landing-security-visual"><div className="landing-security-ring"><div><LockKeyhole size={30} strokeWidth={1.4} /></div></div><span className="landing-security-pill"><Check size={11} />Workspace boundary</span></div><span className="landing-feature-tag"><LockKeyhole size={12} />清晰边界，专注创造</span></article></div></section>
        <section className="landing-workflow landing-container" id="workflow" aria-labelledby="workflow-title"><div className="landing-section-heading"><div><span className="landing-eyebrow">FROM PROMPT TO PROGRESS</span><h2 id="workflow-title">把复杂交给 Nova。<br className="landing-mobile-break" />把专注留给你。</h2></div><Link to="/settings/runners" className="landing-text-link">直接去创建凭据 <ArrowUpRight size={15} /></Link></div><div className="landing-workflow-grid">{[{ icon: Terminal, title: '复制连接命令', text: '在首屏选择本地开发或正式部署，复制与你环境一致的 Runner 启动命令。' }, { icon: KeyRound, title: '创建你的凭据', text: '登录后自动带入可用 Runner Token；暂无凭据时，前往设备管理创建。' }, { icon: Sparkles, title: '让设备上线', text: '在设备终端运行命令，设备出现在工作台，选它开始干活。' }].map(({ icon: Icon, title, text }, index) => <article key={title}><div className="landing-step-top"><span>0{index + 1}</span><Icon size={22} strokeWidth={1.5} />{index < 2 && <ArrowRight size={17} className="landing-step-arrow" />}</div><h3>{title}</h3><p>{text}</p></article>)}</div></section>
        <section className="landing-final-cta landing-container"><div className="landing-cta-orbit" aria-hidden="true" /><span className="landing-eyebrow">MAKE ROOM FOR YOUR NEXT IDEA</span><h2>下一个好想法，<br />值得现在开始。</h2><p>让工具准备就绪，让创造自然发生。</p><Link to="/conversations" className="landing-primary-link">进入 Nova 工作台 <ArrowRight size={17} /></Link><span className="landing-cta-note">你的想法。你的设备。你的 Nova。</span></section>
      </main>
      <footer className="landing-footer landing-container"><div><Link to="/" className="landing-brand" aria-label="Nova 首页"><NovaMark small /><span>nova.</span></Link><p>让想法，连接真实世界。</p></div><nav aria-label="页脚导航"><a href="#install">连接设备</a><a href="#features">产品优势</a><Link to="/conversations">工作台 <ArrowUpRight size={12} /></Link></nav><span>© {new Date().getFullYear()} Nova. Built for your flow.</span></footer>
    </div>
  );
}
