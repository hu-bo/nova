import { Button } from '@/components/ui/button';
import { useIdentity } from '@/features/auth';
import { Link } from '@tanstack/react-router';
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  CircleDot,
  Code2,
  KeyRound,
  Laptop,
  LockKeyhole,
  Menu,
  Monitor,
  Server,
  ShieldCheck,
  Sparkles,
  Terminal,
  Workflow,
  X,
  Zap,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { ConnectPanel } from './connect-panel';
import './landing.css';
import { NovaMark } from './nova-mark';
import { WorkspacePreview } from './workspace-preview';

export function LandingPage() {
  const { identity } = useIdentity();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenuOpen(false);
        menuTriggerRef.current?.focus();
      }
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [menuOpen]);
  return (
    <div className="landing-page">
      <a href="#main-content" className="landing-skip-link">
        跳到主要内容
      </a>
      <header className="landing-header landing-container">
        <Link to="/" className="landing-brand" aria-label="Nova 首页">
          <NovaMark />
          <span>
            nova<span className="landing-brand-dot">.</span>
          </span>
        </Link>
        <nav className="landing-desktop-nav" aria-label="主导航">
          <a href="#install">连接设备</a>
          <a href="#preview">工作台演示</a>
          <a href="#features">产品优势</a>
          <a href="#workflow">工作方式</a>
        </nav>
        <div className="landing-header-actions">
          <Link to="/conversations" className="landing-login">
            {identity ? '进入工作台' : '登录'}
            <ArrowUpRight size={14} />
          </Link>
          <Button
            ref={menuTriggerRef}
            variant="ghost"
            isIconOnly
            className="landing-menu-button"
            aria-label={menuOpen ? '关闭菜单' : '打开菜单'}
            aria-expanded={menuOpen}
            aria-controls="landing-mobile-nav"
            onPress={() => setMenuOpen(!menuOpen)}
          >
            {menuOpen ? <X size={20} /> : <Menu size={20} />}
          </Button>
        </div>
        {menuOpen && (
          <nav id="landing-mobile-nav" className="landing-mobile-nav" aria-label="移动端主导航">
            <a href="#install" onClick={() => setMenuOpen(false)}>
              连接设备
              <ArrowUpRight size={15} />
            </a>
            <a href="#preview" onClick={() => setMenuOpen(false)}>
              工作台演示
              <ArrowUpRight size={15} />
            </a>
            <a href="#features" onClick={() => setMenuOpen(false)}>
              产品优势
              <ArrowUpRight size={15} />
            </a>
            <a href="#workflow" onClick={() => setMenuOpen(false)}>
              工作方式
              <ArrowUpRight size={15} />
            </a>
          </nav>
        )}
      </header>
      <main id="main-content">
        <section className="landing-hero landing-container" aria-labelledby="hero-title">
          <div className="landing-hero-glow" aria-hidden="true" />
          <div className="landing-hero-grid">
            <div className="landing-hero-copy">
              <a href="#preview" className="landing-announcement">
                <span className="landing-announcement-dot" />
                <span>你的下一代 AI 开发工作台</span>
                <span className="landing-announcement-arrow">
                  <ArrowRight size={13} />
                </span>
              </a>
              <div className="landing-hero-overline">YOUR IDEAS. YOUR MACHINES. ONE WORKSPACE.</div>
              <h1 id="hero-title">
                想法在这里发生。
                <br />
                <span>创造，在每一台设备。</span>
              </h1>
              <p className="landing-hero-description">
                一个工作台，连接你的所有开发环境。
                <br />让 AI 在真实的设备中读写代码、执行命令，把想法一步步变成作品。
              </p>
              <div className="landing-hero-actions">
                <Link to="/conversations" className="landing-primary-link">
                  开始创造 <ArrowRight size={17} />
                </Link>
                <a href="#preview" className="landing-secondary-link">
                  <span className="landing-play-icon">▶</span> 看看 Nova 如何工作
                </a>
              </div>
              <div className="landing-hero-footnotes">
                <span>
                  <Check size={12} /> 你的设备与代码
                </span>
                <i />
                <span>
                  <Check size={12} /> Windows · Linux · macOS
                </span>
                <i />
                <span>
                  <Check size={12} /> 一个浏览器即可
                </span>
              </div>
            </div>
            <ConnectPanel />
          </div>
        </section>
        <section
          className="landing-preview-section landing-container"
          id="preview"
          aria-labelledby="preview-title"
        >
          <div className="landing-section-heading">
            <div>
              <span className="landing-eyebrow">SEE NOVA AT WORK</span>
              <h2 id="preview-title">这就是你与 Nova 的工作方式</h2>
            </div>
          </div>
          <WorkspacePreview />
        </section>
        <section
          className="landing-features landing-container"
          id="features"
          aria-labelledby="features-title"
        >
          <div className="landing-section-heading">
            <div>
              <span className="landing-eyebrow">BUILT AROUND YOUR FLOW</span>
              <h2 id="features-title">不打断灵感，只连接可能。</h2>
            </div>
          </div>
          <div className="landing-feature-grid">
            <article className="landing-feature-card landing-feature-fleet">
              <div className="landing-feature-icon">
                <Workflow size={21} />
              </div>
              <h3>一个工作台，无限可能</h3>
              <p>多台 Runner 同时在线，为不同项目选择合适的设备。切换环境，工作思路始终连贯。</p>
              <div
                className="landing-network"
                aria-label="Nova 连接 Windows、Linux 和 macOS 的示意图"
              >
                <svg viewBox="0 0 320 135" preserveAspectRatio="none" aria-hidden="true">
                  <path d="M160 25V55Q160 66 145 66H58Q45 66 45 80V97M160 25V97M160 25V55Q160 66 175 66H262Q275 66 275 80V97" />
                </svg>
                <span className="landing-network-center">
                  <NovaMark small /> Nova
                </span>
                <span className="landing-network-device">
                  <Monitor size={19} />
                  <small>Windows</small>
                  <i />
                </span>
                <span className="landing-network-device">
                  <Server size={19} />
                  <small>Linux</small>
                  <i />
                </span>
                <span className="landing-network-device">
                  <Laptop size={19} />
                  <small>macOS</small>
                  <i />
                </span>
              </div>
              <span className="landing-feature-tag">
                <span />
                跨平台，自由连接
              </span>
            </article>
            <article className="landing-feature-card">
              <div className="landing-feature-icon">
                <Code2 size={21} />
              </div>
              <h3>不止对话，更能动手</h3>
              <p>在真实 workspace 中读文件、改代码、运行命令。每一步都有反馈，每个结果都可追溯。</p>
              <div className="landing-mini-terminal">
                <div>
                  <Terminal size={12} />
                  <span>nova-agent</span>
                  <i />
                </div>
                <p>
                  <Check size={13} /> 读取项目上下文 <span>done</span>
                </p>
                <p>
                  <Check size={13} /> 更新页面与组件 <span>done</span>
                </p>
                <p>
                  <CircleDot size={13} /> 运行构建检查 <span>running</span>
                </p>
              </div>
              <span className="landing-feature-tag">
                <Zap size={12} />
                从思考到执行，一气呵成
              </span>
            </article>
            <article className="landing-feature-card">
              <div className="landing-feature-icon">
                <ShieldCheck size={21} />
              </div>
              <h3>你的环境，你来掌控</h3>
              <p>Runner 主动连接服务端，无需开放设备入站端口。在指定的工作目录中，安心推进项目。</p>
              <div className="landing-security-visual">
                <div className="landing-security-ring">
                  <div>
                    <LockKeyhole size={30} strokeWidth={1.4} />
                  </div>
                </div>
                <span className="landing-security-pill">
                  <Check size={11} />
                  Workspace boundary
                </span>
              </div>
              <span className="landing-feature-tag">
                <LockKeyhole size={12} />
                清晰边界，专注创造
              </span>
            </article>
          </div>
        </section>
        <section
          className="landing-workflow landing-container"
          id="workflow"
          aria-labelledby="workflow-title"
        >
          <div className="landing-section-heading">
            <div>
              <span className="landing-eyebrow">FROM PROMPT TO PROGRESS</span>
              <h2 id="workflow-title">
                把复杂交给 Nova。
                <br className="landing-mobile-break" />
                把专注留给你。
              </h2>
            </div>
            <Link to="/settings/runners" className="landing-text-link">
              直接去创建凭据 <ArrowUpRight size={15} />
            </Link>
          </div>
          <div className="landing-workflow-grid">
            {[
              {
                icon: Terminal,
                title: '复制连接命令',
                text: '在首屏选择本地开发或正式部署，复制与你环境一致的 Runner 启动命令。',
              },
              {
                icon: KeyRound,
                title: '创建你的凭据',
                text: '登录后自动带入可用 Runner Token；暂无凭据时，前往设备管理创建。',
              },
              {
                icon: Sparkles,
                title: '让设备上线',
                text: '在设备终端运行命令，设备出现在工作台，选它开始干活。',
              },
            ].map(({ icon: Icon, title, text }, index) => (
              <article key={title}>
                <div className="landing-step-top">
                  <span>0{index + 1}</span>
                  <Icon size={22} strokeWidth={1.5} />
                  {index < 2 && <ArrowRight size={17} className="landing-step-arrow" />}
                </div>
                <h3>{title}</h3>
                <p>{text}</p>
              </article>
            ))}
          </div>
        </section>
        <section className="landing-final-cta landing-container">
          <div className="landing-cta-orbit" aria-hidden="true" />
          <span className="landing-eyebrow">MAKE ROOM FOR YOUR NEXT IDEA</span>
          <h2>
            下一个好想法，
            <br />
            值得现在开始。
          </h2>
          <p>让工具准备就绪，让创造自然发生。</p>
          <Link to="/conversations" className="landing-primary-link">
            进入 Nova 工作台 <ArrowRight size={17} />
          </Link>
          <span className="landing-cta-note">你的想法。你的设备。你的 Nova。</span>
        </section>
      </main>
      <footer className="landing-footer landing-container">
        <div>
          <Link to="/" className="landing-brand" aria-label="Nova 首页">
            <NovaMark small />
            <span>nova.</span>
          </Link>
          <p>让想法，连接真实世界。</p>
        </div>
        <nav aria-label="页脚导航">
          <a href="#install">连接设备</a>
          <a href="#features">产品优势</a>
          <Link to="/conversations">
            工作台 <ArrowUpRight size={12} />
          </Link>
        </nav>
        <span>© {new Date().getFullYear()} Nova. Built for your flow.</span>
      </footer>
    </div>
  );
}
