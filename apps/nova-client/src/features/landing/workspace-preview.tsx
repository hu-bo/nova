import {
  ArrowRight,
  Check,
  CheckCheck,
  ChevronRight,
  CircleDot,
  Command,
  FileCode2,
  Folder,
  GitBranch,
  Laptop,
  Layers3,
  LockKeyhole,
  MessageSquare,
  Monitor,
  Plus,
  Server,
  ShieldCheck,
  Terminal,
  Workflow,
} from 'lucide-react';
import { useState } from 'react';
import './landing.css';
import { NovaMark } from './nova-mark';

const devices = [
  {
    name: 'Studio PC',
    platform: 'Windows 11',
    arch: 'x64',
    path: 'E:\\Projects\\nova',
    icon: Monitor,
    label: '当前设备',
  },
  {
    name: 'Build Server',
    platform: 'Ubuntu 24.04',
    arch: 'x64',
    path: '/srv/workspace/nova',
    icon: Server,
    label: '构建环境',
  },
  {
    name: 'MacBook Pro',
    platform: 'macOS',
    arch: 'arm64',
    path: '~/Developer/nova',
    icon: Laptop,
    label: '开发环境',
  },
];

export function WorkspacePreview() {
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
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? tabs.length - 1
          : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    setView(tabs[next]!.id);
    document.getElementById(`preview-tab-${tabs[next]!.id}`)?.focus();
  }

  return (
    <div className="landing-preview-wrap">
      <div className="landing-preview-toolbar">
        <div role="tablist" aria-label="产品演示" className="landing-preview-tabs">
          {tabs.map(({ id, label, icon: Icon }, index) => (
            <button
              key={id}
              id={`preview-tab-${id}`}
              type="button"
              role="tab"
              aria-selected={view === id}
              aria-controls={`preview-panel-${id}`}
              tabIndex={view === id ? 0 : -1}
              onClick={() => setView(id)}
              onKeyDown={(event) => moveTab(event, index)}
            >
              <Icon size={15} aria-hidden="true" />
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="landing-preview-window">
        <div className="landing-window-bar">
          <div className="landing-window-dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </div>
          <span>
            <LockKeyhole size={11} aria-hidden="true" /> nova / your workspace
          </span>
          <span className="landing-window-shortcut" aria-hidden="true">
            <Command size={11} /> K
          </span>
        </div>
        <div
          role="tabpanel"
          id={`preview-panel-${view}`}
          aria-labelledby={`preview-tab-${view}`}
          tabIndex={0}
        >
          {view === 'workspace' ? (
            <div className="landing-workspace">
              <aside className="landing-demo-sidebar" aria-label="演示工作台导航">
                <div className="landing-demo-brand">
                  <NovaMark small />
                  <strong>Nova</strong>
                  <span>workspace</span>
                </div>
                <div className="landing-demo-new">
                  <Plus size={14} /> 新建会话 <span>⌘ N</span>
                </div>
                <p className="landing-demo-section">工作空间</p>
                <div className="landing-demo-nav">
                  <Folder size={14} /> Nova project <ChevronRight size={12} />
                </div>
                <div className="landing-demo-nav muted">
                  <Folder size={14} /> Personal website
                </div>
                <p className="landing-demo-section">最近会话</p>
                <div className="landing-demo-nav active">
                  <MessageSquare size={13} /> 构建一个更好的首页
                </div>
                <div className="landing-demo-nav muted">
                  <MessageSquare size={13} /> 优化 API 响应速度
                </div>
                <div className="landing-demo-nav muted">
                  <MessageSquare size={13} /> 整理项目文档
                </div>
                <div className="landing-demo-sidebar-bottom">
                  <span className="landing-avatar">N</span>
                  <span>
                    你的工作空间<small>让想法持续发生</small>
                  </span>
                  <ChevronRight size={13} />
                </div>
              </aside>
              <div className="landing-demo-chat">
                <div className="landing-chat-header">
                  <span>
                    <Folder size={14} /> Nova project <ChevronRight size={12} />
                    <strong>构建一个更好的首页</strong>
                  </span>
                  <span className="landing-connected">
                    <i /> Studio PC
                  </span>
                </div>
                <div className="landing-chat-body">
                  <div className="landing-user-message">
                    为 Nova 设计一个漂亮的首页，支持移动端。<span>你</span>
                  </div>
                  <div className="landing-agent-message">
                    <NovaMark small />
                    <div>
                      <strong>
                        Nova <span>Agent</span>
                      </strong>
                      <p>让我们把想法变成现实。我会先了解项目，再完成设计和实现。</p>
                    </div>
                  </div>
                  <div className="landing-plan">
                    <span className="landing-plan-heading">
                      <Workflow size={13} />
                      执行计划 <small>2 / 3</small>
                    </span>
                    <p>
                      <CheckCheck size={14} /> 分析项目结构与设计规范
                    </p>
                    <p>
                      <CheckCheck size={14} /> 实现响应式首页与交互
                    </p>
                    <p className="running">
                      <CircleDot size={14} /> 检查类型与构建结果 <span>进行中</span>
                    </p>
                  </div>
                  <div className="landing-tool-output">
                    <div>
                      <Terminal size={13} />
                      <span>terminal</span>
                      <small>~/workspace/nova</small>
                    </div>
                    <code>
                      <span>$</span> pnpm build
                      <br />
                      <span className="landing-terminal-success">✓</span> TypeScript check passed
                      <br />
                      <span className="landing-terminal-success">✓</span> 142 modules transformed.
                    </code>
                  </div>
                  <div className="landing-demo-composer">
                    <span>继续描述你的想法…</span>
                    <div>
                      <span>
                        <Plus size={14} />
                        <span>Studio PC</span>
                        <ChevronRight size={11} />
                      </span>
                      <span className="landing-send">
                        <ArrowRight size={14} />
                      </span>
                    </div>
                  </div>
                </div>
              </div>
              <aside className="landing-changes" aria-label="演示变更预览">
                <p>
                  <Layers3 size={14} /> 工作进展
                </p>
                <span className="landing-demo-section">本次变更</span>
                <div>
                  <FileCode2 size={13} /> landing.tsx <span>+128</span>
                </div>
                <div>
                  <FileCode2 size={13} /> landing.css <span>+86</span>
                </div>
                <div>
                  <FileCode2 size={13} /> index.tsx <span>+3</span>
                </div>
                <div className="landing-code-preview">
                  <span>
                    01 <i>export function</i> Home() {'{'}
                  </span>
                  <span>
                    02 &nbsp; <i>return</i> (
                  </span>
                  <span className="added">03 &nbsp; &nbsp; &lt;main&gt;</span>
                  <span className="added">04 &nbsp; &nbsp; &nbsp; &lt;Hero /&gt;</span>
                  <span className="added">05 &nbsp; &nbsp; &nbsp; &lt;Features /&gt;</span>
                  <span className="added">06 &nbsp; &nbsp; &lt;/main&gt;</span>
                  <span>07 &nbsp; );</span>
                  <span>08 {'}'}</span>
                </div>
                <div className="landing-workspace-note">
                  <ShieldCheck size={15} />
                  <span>
                    操作始终在你指定的
                    <br />
                    workspace 内进行
                  </span>
                </div>
              </aside>
            </div>
          ) : (
            <div className="landing-fleet">
              <div className="landing-fleet-heading">
                <div>
                  <span className="landing-eyebrow">YOUR CONNECTED WORKSPACE</span>
                  <h3>你的设备，随时就位。</h3>
                  <p>选择一台设备，查看对应的执行环境。</p>
                </div>
                <span className="landing-connected">
                  <i /> 3 台示例设备
                </span>
              </div>
              <div className="landing-fleet-grid">
                {devices.map((device, index) => (
                  <button
                    type="button"
                    key={device.name}
                    aria-pressed={selectedDevice === index}
                    onClick={() => setSelectedDevice(index)}
                    className={`landing-device ${selectedDevice === index ? 'selected' : ''}`}
                  >
                    <div>
                      <device.icon size={25} />
                      <span className="landing-connected">
                        <i /> 在线
                      </span>
                    </div>
                    <h4>{device.name}</h4>
                    <p>
                      {device.platform} <span>· {device.arch}</span>
                    </p>
                    <code>{device.path}</code>
                    <span className="landing-device-select">
                      {selectedDevice === index ? (
                        <>
                          <Check size={14} /> 已选择
                        </>
                      ) : (
                        <>
                          选择设备 <ArrowRight size={14} />
                        </>
                      )}
                    </span>
                  </button>
                ))}
              </div>
              <div className="landing-fleet-current" aria-live="polite">
                <Terminal size={17} />
                <span>
                  当前演示环境 <strong>{currentDevice.name}</strong>
                  <code>{currentDevice.path}</code>
                </span>
                <ShieldCheck size={17} />
                <small>工作目录隔离</small>
              </div>
            </div>
          )}
        </div>
        <div className="landing-window-footer">
          <span>
            <GitBranch size={12} /> main <span className="landing-footer-divider">/</span>{' '}
            nova-workspace
          </span>
          <span>
            <ShieldCheck size={12} /> 你的环境，你来掌控
          </span>
        </div>
      </div>
      <div className="landing-preview-caption">
        <span />
        <p>从一句想法，到真实的代码与结果。</p>
        <span />
      </div>
    </div>
  );
}
