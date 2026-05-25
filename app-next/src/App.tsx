import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useState } from "react";
import type { LegacySnapshot, LegacySummary, NavKey, ProjectScanCard } from "./types";

const navItems: Array<{ key: NavKey; label: string; hint: string }> = [
  { key: "dashboard", label: "总览", hint: "健康、同步、风险" },
  { key: "library", label: "技能库", hint: "中央 Skill Library" },
  { key: "workspaces", label: "工作区", hint: "全局、Agent、项目" },
  { key: "presets", label: "预设", hint: "分类组合与场景" },
  { key: "sources", label: "来源", hint: "GitHub、本地、Prompt" },
  { key: "agents", label: "AI 工具", hint: "Claude、Codex、Antigravity" },
  { key: "settings", label: "设置", hint: "路径、主题、迁移" }
];

export function App() {
  const [active, setActive] = useState<NavKey>("dashboard");
  const [snapshot, setSnapshot] = useState<LegacySnapshot | null>(null);
  const [loadError, setLoadError] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(true);
  const runtimeAvailable = hasTauriRuntime();

  const summary = useMemo(() => {
    return (
      snapshot?.summary ?? {
        skills: 0,
        sources: 0,
        prompts: 0,
        agentsDetected: 0,
        warnings: 0,
        diagnosticsStatus: "loading"
      }
    );
  }, [snapshot]);

  async function loadSnapshot(mode: "indexed" | "refresh" = "indexed") {
    setLoading(true);
    try {
      if (!hasTauriRuntime()) {
        setSnapshot(createPreviewSnapshot());
        setLoadError("");
        return;
      }

      const command = mode === "refresh" ? "scan_legacy_snapshot" : "load_indexed_snapshot";
      const result = await invoke<LegacySnapshot>(command);
      setSnapshot(result);
      setLoadError("");
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }

  async function updateEnabled(command: string, id: string, enabled: boolean) {
    setLoading(true);
    try {
      if (!hasTauriRuntime()) {
        setSnapshot(previous => updatePreviewEnabled(previous ?? createPreviewSnapshot(), command, id, enabled));
        setLoadError("");
        return;
      }

      const result = await invoke<LegacySnapshot>(command, { id, enabled });
      setSnapshot(result);
      setLoadError("");
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadSnapshot();
  }, []);

  return (
    <main className={runtimeAvailable ? "shell" : "shell browser-preview-shell"}>
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">AI</div>
          <div>
            <strong>AI SkillHub</strong>
            <span>v2 app-next</span>
          </div>
        </div>

        <nav className="nav">
          {navItems.map(item => (
            <button
              className={active === item.key ? "nav-item active" : "nav-item"}
              key={item.key}
              onClick={() => setActive(item.key)}
              type="button"
            >
              <strong>{item.label}</strong>
              <span>{item.hint}</span>
            </button>
          ))}
        </nav>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">V2 原型线</p>
            <h1>{navItems.find(item => item.key === active)?.label}</h1>
          </div>
          <div className="topbar-actions">
            <button
              className="ghost-button"
              disabled={loading}
              onClick={() => void loadSnapshot("refresh")}
              type="button"
            >
              {runtimeAvailable ? (loading ? "正在刷新" : "刷新 v1 并入库") : loading ? "正在载入" : "重载预览"}
            </button>
            <div className={runtimeAvailable ? "status-pill" : "status-pill preview"}>
              {runtimeAvailable ? "SQLite 优先 · 手动刷新才扫描 v1" : "浏览器预览 · 桌面窗口读取真实数据"}
            </div>
          </div>
        </header>

        {!runtimeAvailable && (
          <section className="panel preview-panel">
            <strong>当前是浏览器预览模式</strong>
            <span>这里不会读取真实 SQLite，也不会接管本机 AI 工具；用 Tauri 桌面窗口打开时会显示真实数据。</span>
          </section>
        )}

        {loadError && (
          <section className="panel warning-panel">
            <h3>读取 v1 数据失败</h3>
            <p>{loadError}</p>
          </section>
        )}

        {active === "dashboard" && <Dashboard loading={loading} snapshot={snapshot} summary={summary} />}
        {active === "library" && <Library snapshot={snapshot} />}
        {active === "workspaces" && <Workspaces disabled={loading} onToggle={updateEnabled} snapshot={snapshot} />}
        {active === "presets" && <Presets disabled={loading} onToggle={updateEnabled} snapshot={snapshot} />}
        {active === "sources" && <Sources snapshot={snapshot} />}
        {active === "agents" && <Agents disabled={loading} onToggle={updateEnabled} snapshot={snapshot} />}
        {active === "settings" && <Settings snapshot={snapshot} />}
      </section>
    </main>
  );
}

function Dashboard({
  loading,
  snapshot,
  summary
}: {
  loading: boolean;
  snapshot: LegacySnapshot | null;
  summary: LegacySummary;
}) {
  return (
    <div className="view">
      <section className="hero-panel">
        <div>
          <p className="eyebrow">SQLite 优先读取</p>
          <h2>v2 已经开始从索引库加载 AI SkillHub 数据</h2>
          <p>
            默认打开时优先读取 v2 SQLite 索引；只有点击刷新时才重新扫描 v1 的 Skills、来源、AI 工具和诊断结果。
          </p>
        </div>
      </section>

      <section className="metrics">
        <Metric label="已启用 Skills" value={summary.skills} />
        <Metric label="仓库来源" value={summary.sources} />
        <Metric label="Prompt 资料" value={summary.prompts} />
        <Metric label="已检测 AI 工具" value={summary.agentsDetected} />
        <Metric label="需关注" value={summary.warnings} />
      </section>

      <section className="panel">
        <h3>扫描状态</h3>
        <ul className="check-list">
          <li>根目录：{snapshot?.root ?? "正在读取..."}</li>
          <li>诊断状态：{summary.diagnosticsStatus}</li>
          <li>诊断版本：{snapshot?.diagnostics.appVersion || "尚未读取"}</li>
          <li>读取模式：{snapshot?.mode ?? "sqlite-index"}，v1 数据仍保持只读</li>
        </ul>
      </section>

      <section className="panel index-panel">
        <div>
          <p className="eyebrow">v2 SQLite 索引</p>
          <h3>{snapshot?.index.persisted ? "已写入 v2 索引库" : loading ? "正在建立索引" : "尚未写入索引"}</h3>
          <p>
            v2 会把扫描结果写到自己的 SQLite 文件里，后续工作区、标签、历史记录和回滚都会基于这个索引继续做。
          </p>
        </div>
        <ul className="index-list">
          <li>Skills：{snapshot?.index.skillsIndexed ?? 0}</li>
          <li>来源：{snapshot?.index.sourcesIndexed ?? 0}</li>
          <li>AI 工具：{snapshot?.index.agentsIndexed ?? 0}</li>
          <li>快照：{snapshot?.index.snapshotId || "等待生成"}</li>
          <li>数据库：{snapshot?.index.databaseFile || "等待生成"}</li>
        </ul>
      </section>
    </div>
  );
}

function Library({ snapshot }: { snapshot: LegacySnapshot | null }) {
  const skills = snapshot?.skills ?? [];

  return (
    <div className="card-grid">
      {skills.map(skill => (
        <article className="skill-card" key={skill.name}>
          <div className="card-head">
            <strong>{skill.name}</strong>
            <span className={`health ${skill.health}`}>{skill.health}</span>
          </div>
          <p>{skill.description}</p>
          <footer>
            <span>{skill.category}</span>
            <span>{skill.source}</span>
          </footer>
        </article>
      ))}
      {skills.length === 0 && <EmptyState text="正在等待 v1 Skill 扫描结果。" />}
    </div>
  );
}

function Workspaces({
  disabled,
  onToggle,
  snapshot
}: {
  disabled: boolean;
  onToggle: (command: string, id: string, enabled: boolean) => Promise<void>;
  snapshot: LegacySnapshot | null;
}) {
  const workspaces = snapshot?.workspaces ?? [];
  const projectScans = snapshot?.projectScans ?? [];

  return (
    <div className="view">
      <div className="card-grid">
        {workspaces.map(workspace => (
          <article className="workspace-card" key={workspace.id}>
            <div className="card-head">
              <strong>{workspace.name}</strong>
              <span className={`scope ${workspace.scope}`}>{scopeLabel(workspace.scope)}</span>
            </div>
            <p>{workspace.path}</p>
            <footer>
              <span>{workspace.agentCount} 个 AI 工具</span>
              <span>{workspace.skillCount} 个 Skills</span>
              <ToggleSwitch
                disabled={disabled}
                enabled={workspace.enabled}
                label={workspace.enabled ? "已启用" : "已停用"}
                onClick={() => onToggle("set_workspace_enabled", workspace.id, !workspace.enabled)}
              />
            </footer>
          </article>
        ))}
        {workspaces.length === 0 && <EmptyState text="正在等待工作区索引结果。" />}
      </div>

      <section className="panel">
        <p className="eyebrow">Project Workspace Scanner</p>
        <h3>只读项目扫描</h3>
        <div className="project-scan-list">
          {projectScans.map(scan => (
            <article className="project-detail-card" key={scan.id}>
              <div className="project-detail-head">
                <div>
                  <strong>{scan.path}</strong>
                  <span>{scan.fileCount} 个文件 · 最近扫描 {formatScanTime(scan.scannedAt)}</span>
                </div>
                <span className="scope project">只读</span>
              </div>
              <div className="scan-flags">
                <ScanFlag enabled={scan.hasGit} label="Git" />
                <ScanFlag enabled={scan.hasPackageJson} label="package.json" />
                <ScanFlag enabled={scan.hasCargoToml} label="Cargo.toml" />
                <ScanFlag enabled={scan.hasTauriConfig} label="Tauri" />
                <ScanFlag enabled={scan.hasAgentsMd} label="AGENTS.md" />
                <ScanFlag enabled={scan.hasClaudeMd} label="CLAUDE.md" />
                <ScanFlag enabled={scan.hasReadmeMd} label="README.md" />
              </div>
              <div className="instruction-preview">
                <p className="eyebrow">只读说明预览</p>
                <pre>{projectInstructionPreview(scan)}</pre>
              </div>
            </article>
          ))}
          {projectScans.length === 0 && <p>暂未发现项目级工作区。</p>}
        </div>
      </section>
    </div>
  );
}

function Presets({
  disabled,
  onToggle,
  snapshot
}: {
  disabled: boolean;
  onToggle: (command: string, id: string, enabled: boolean) => Promise<void>;
  snapshot: LegacySnapshot | null;
}) {
  const presets = snapshot?.presets ?? [];

  return (
    <div className="preset-grid">
      {presets.map(preset => (
        <article className={`preset-card ${preset.color}`} key={preset.id}>
          <div className="card-head">
            <strong>{preset.name}</strong>
            <span>{preset.skillCount}</span>
          </div>
          <p>{preset.description}</p>
          <footer>
            <ToggleSwitch
              disabled={disabled}
              enabled={preset.enabled}
              label={preset.enabled ? "已启用" : "已停用"}
              onClick={() => onToggle("set_preset_enabled", preset.id, !preset.enabled)}
            />
          </footer>
        </article>
      ))}
      {presets.length === 0 && <EmptyState text="正在等待 Preset 索引结果。" />}
    </div>
  );
}

function Sources({ snapshot }: { snapshot: LegacySnapshot | null }) {
  const sources = snapshot?.sources ?? [];

  return (
    <div className="table-panel">
      {sources.map(source => (
        <div className="source-row" key={source.name}>
          <strong>{source.name}</strong>
          <span>{source.sourceType}</span>
          <span>{source.skillCount} Skills</span>
          <small>{source.url || source.localPath}</small>
        </div>
      ))}
      {sources.length === 0 && <EmptyState text="正在等待来源扫描结果。" />}
    </div>
  );
}

function Agents({
  disabled,
  onToggle,
  snapshot
}: {
  disabled: boolean;
  onToggle: (command: string, id: string, enabled: boolean) => Promise<void>;
  snapshot: LegacySnapshot | null;
}) {
  const agents = snapshot?.agents ?? [];
  const adapters = snapshot?.agentAdapters ?? [];
  const safetyChecks = snapshot?.adapterSafetyChecks ?? [];
  const capabilities = snapshot?.adapterCapabilities ?? [];

  return (
    <div className="view">
      <section className="panel">
        <p className="eyebrow">Agent Adapter Registry</p>
        <h3>统一 AI 工具适配器</h3>
        <p>
          v2 会先维护“支持哪些工具”的清单，再读取本机检测结果。这样未安装的工具会显示为未检测，而不是报错。
        </p>
      </section>

      <div className="adapter-grid">
        {adapters.map(adapter => (
          <article className="adapter-card" key={adapter.id}>
            <div className="card-head">
              <strong>{adapter.name}</strong>
              <span className={`adapter-status ${adapter.status}`}>{adapterStatusLabel(adapter.status)}</span>
            </div>
            <p>{adapter.skillsPathHint || "此工具暂未提供默认 Skills 目录。"}</p>
            <footer>
              <span>{adapter.vendor}</span>
              <span>{adapter.detected ? "已检测" : "未检测"}</span>
              <span>{adapter.managed ? "已接管" : "未接管"}</span>
              <ToggleSwitch
                disabled={disabled || !adapter.detected}
                enabled={adapter.enabled}
                label={adapter.enabled ? "已启用" : "已停用"}
                onClick={() => onToggle("set_agent_adapter_enabled", adapter.id, !adapter.enabled)}
              />
            </footer>
            <ul className="safety-list">
              {capabilities
                .filter(capability => capability.adapterId === adapter.id)
                .slice(0, 4)
                .map(capability => (
                  <li className={capability.enabled ? "capability-item is-on" : "capability-item"} key={capability.id}>
                    {capabilityLabel(capability.capabilityKey)}
                  </li>
                ))}
              {safetyChecks
                .filter(check => check.adapterId === adapter.id)
                .slice(0, 3)
                .map(check => (
                  <li className={`safety-item ${check.status}`} key={check.id}>
                    {check.summary}
                  </li>
                ))}
            </ul>
          </article>
        ))}
      </div>

      <section className="panel">
        <h3>本机检测结果</h3>
        <div className="agent-list">
          {agents.map(agent => (
            <div className="agent-row" key={agent.name}>
              <strong>{agent.name}</strong>
              <span>{agent.detected ? "已检测" : "未检测"}</span>
              <span>{agent.managed ? "已接管" : "未接管"}</span>
              <span>{agent.enabled ? "v2 启用" : "v2 停用"}</span>
              <small>{agent.path}</small>
            </div>
          ))}
          {agents.length === 0 && <p>正在等待 AI 工具检测结果。</p>}
        </div>
      </section>
    </div>
  );
}

function Settings({ snapshot }: { snapshot: LegacySnapshot | null }) {
  return (
    <section className="panel">
      <h3>迁移策略</h3>
      <p>
        v2 当前只做只读扫描。真正接管 Claude、Codex、Antigravity 前，必须先完成 SQLite schema、备份、快照和回滚。
      </p>
      <div className="setting-row">
        <span>中央目录</span>
        <code>{snapshot?.skillsDir ?? "../skills"}</code>
      </div>
      <div className="setting-row">
        <span>来源目录</span>
        <code>{snapshot?.sourcesDir ?? "../app/github_sources"}</code>
      </div>
      <div className="setting-row">
        <span>诊断报告</span>
        <code>{snapshot?.diagnosticsFile ?? "../app/reports/latest-diagnostics.json"}</code>
      </div>
    </section>
  );
}

function hasTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function createPreviewSnapshot(): LegacySnapshot {
  return {
    root: "浏览器预览模式",
    skillsDir: "../skills",
    sourcesDir: "../app/github_sources",
    diagnosticsFile: "../app/reports/latest-diagnostics.json",
    mode: "browser-preview",
    summary: {
      skills: 48,
      sources: 9,
      prompts: 2,
      agentsDetected: 3,
      warnings: 1,
      diagnosticsStatus: "preview"
    },
    skills: [
      {
        name: "paper-workflow",
        folderName: "paper-workflow",
        category: "论文科研",
        description: "判断当前论文下一步该进入构思、写作、图表、引用核查还是投稿审计。",
        source: "Nature-Paper-Skills",
        health: "ok",
        enabled: true,
        relativePath: "skills/core/paper-workflow"
      },
      {
        name: "figure-planner",
        folderName: "figure-planner",
        category: "科研图表",
        description: "把实验结果拆成清晰的图组、面板顺序和图注结构。",
        source: "Nature-Paper-Skills",
        health: "ok",
        enabled: true,
        relativePath: "skills/core/figure-planner"
      },
      {
        name: "impeccable",
        folderName: "impeccable",
        category: "界面设计",
        description: "用于检查界面审美、布局层级、交互细节和视觉一致性。",
        source: "impeccable",
        health: "info",
        enabled: true,
        relativePath: ".claude/skills/impeccable"
      },
      {
        name: "VibeSec-Skill",
        folderName: "VibeSec-Skill",
        category: "安全",
        description: "扫描脚本、路径、命令和发布边界中的安全风险。",
        source: "VibeSec-Skill",
        health: "warn",
        enabled: true,
        relativePath: "SKILL.md"
      },
      {
        name: "gstack",
        folderName: "gstack",
        category: "产品规划",
        description: "把长期目标拆成可验证、可回退、可持续推进的产品路线。",
        source: "gstack",
        health: "ok",
        enabled: true,
        relativePath: "SKILL.md"
      },
      {
        name: "karpathy-guidelines",
        folderName: "karpathy-guidelines",
        category: "工程质量",
        description: "保持小步验证、清晰状态和稳定推进的工程开发守则。",
        source: "andrej-karpathy-skills",
        health: "ok",
        enabled: true,
        relativePath: "skills/karpathy-guidelines"
      }
    ],
    sources: [
      {
        name: "Nature-Paper-Skills",
        sourceType: "skill",
        health: "ok",
        url: "https://github.com/Boom5426/Nature-Paper-Skills.git",
        skillCount: 18,
        mode: "scan",
        categoryId: "paper",
        note: "论文科研工作流。",
        localPath: "../app/github_sources/Nature-Paper-Skills"
      },
      {
        name: "impeccable",
        sourceType: "skill",
        health: "info",
        url: "https://github.com/pbakaus/impeccable.git",
        skillCount: 1,
        mode: "explicit",
        categoryId: "design",
        note: "UI 审美检查来源。",
        localPath: "../app/github_sources/impeccable"
      },
      {
        name: "awesome-ai-research-writing",
        sourceType: "prompt",
        health: "info",
        url: "https://github.com/Leey21/awesome-ai-research-writing.git",
        skillCount: 0,
        mode: "do-not-install",
        categoryId: "prompt",
        note: "这是润色 Prompt 资料，不作为 Skill 安装。",
        localPath: "../app/github_sources/awesome-ai-research-writing"
      }
    ],
    agents: [
      {
        id: "claude",
        name: "Claude / Claude Code",
        path: "~\\.claude\\skills",
        detected: true,
        managed: true,
        enabled: true,
        skillCount: 48
      },
      {
        id: "codex",
        name: "OpenAI Codex",
        path: "~\\.codex\\skills",
        detected: true,
        managed: false,
        enabled: false,
        skillCount: 0
      },
      {
        id: "antigravity",
        name: "Antigravity",
        path: "~\\.gemini\\antigravity\\skills",
        detected: false,
        managed: false,
        enabled: false,
        skillCount: 0
      }
    ],
    agentAdapters: [
      {
        id: "claude",
        name: "Claude / Claude Code",
        vendor: "Anthropic",
        skillsPathHint: "~\\.claude\\skills",
        detectionKind: "directory",
        installScope: "global",
        capabilityLevel: "full",
        docsUrl: "",
        status: "ready",
        detected: true,
        managed: true,
        enabled: true
      },
      {
        id: "codex",
        name: "OpenAI Codex",
        vendor: "OpenAI",
        skillsPathHint: "~\\.codex\\skills",
        detectionKind: "directory",
        installScope: "global",
        capabilityLevel: "full",
        docsUrl: "",
        status: "detected-unmanaged",
        detected: true,
        managed: false,
        enabled: false
      },
      {
        id: "antigravity",
        name: "Antigravity",
        vendor: "Google",
        skillsPathHint: "~\\.gemini\\antigravity\\skills",
        detectionKind: "directory",
        installScope: "global",
        capabilityLevel: "planned",
        docsUrl: "",
        status: "not-detected",
        detected: false,
        managed: false,
        enabled: false
      }
    ],
    adapterSafetyChecks: [
      {
        id: "claude-path",
        adapterId: "claude",
        checkKey: "path-writable",
        status: "ok",
        summary: "Claude Skills 目录可写，已由 AI SkillHub 管理。"
      },
      {
        id: "codex-link",
        adapterId: "codex",
        checkKey: "managed-link",
        status: "warn",
        summary: "已检测到 Codex，但尚未接管链接。"
      },
      {
        id: "antigravity-missing",
        adapterId: "antigravity",
        checkKey: "installed",
        status: "info",
        summary: "未检测到 Antigravity，本机可暂不处理。"
      }
    ],
    adapterCapabilities: [
      {
        id: "claude-global",
        adapterId: "claude",
        capabilityKey: "global-scope",
        enabled: true,
        summary: "支持全局 Skills。"
      },
      {
        id: "claude-project",
        adapterId: "claude",
        capabilityKey: "project-scope",
        enabled: true,
        summary: "支持项目级工作区。"
      },
      {
        id: "codex-global",
        adapterId: "codex",
        capabilityKey: "global-scope",
        enabled: true,
        summary: "支持 Codex 全局 Skills。"
      },
      {
        id: "antigravity-copy",
        adapterId: "antigravity",
        capabilityKey: "copy-fallback",
        enabled: false,
        summary: "后续提供复制兜底。"
      }
    ],
    workspaces: [
      {
        id: "global",
        name: "全局技能库",
        scope: "global",
        path: "../skills",
        enabled: true,
        agentCount: 3,
        skillCount: 48
      },
      {
        id: "claude-agent",
        name: "Claude 工作区",
        scope: "agent",
        path: "~\\.claude\\skills",
        enabled: true,
        agentCount: 1,
        skillCount: 48
      },
      {
        id: "app-next",
        name: "AI SkillHub v2 项目",
        scope: "project",
        path: "../app-next",
        enabled: true,
        agentCount: 2,
        skillCount: 12
      }
    ],
    projectScans: [
      {
        id: "app-next-scan",
        workspaceId: "app-next",
        path: "../app-next",
        hasGit: true,
        hasPackageJson: true,
        hasCargoToml: true,
        hasTauriConfig: true,
        hasAgentsMd: false,
        hasClaudeMd: false,
        hasReadmeMd: true,
        fileCount: 126,
        scannedAt: new Date().toISOString()
      }
    ],
    presets: [
      {
        id: "paper",
        name: "论文科研",
        description: "写作、图表、引用、投稿审计的组合预设。",
        color: "mint",
        enabled: true,
        skillCount: 18
      },
      {
        id: "design",
        name: "界面设计",
        description: "UI 检查、视觉优化和产品体验打磨。",
        color: "peach",
        enabled: true,
        skillCount: 7
      },
      {
        id: "security",
        name: "安全检查",
        description: "命令、路径、发布边界和风险模式扫描。",
        color: "violet",
        enabled: true,
        skillCount: 4
      }
    ],
    diagnostics: {
      available: false,
      appVersion: "v2 preview",
      generatedAt: new Date().toISOString(),
      overallStatus: "preview",
      ok: 6,
      warn: 1,
      error: 0,
      info: 2
    },
    index: {
      persisted: false,
      databaseFile: "浏览器预览不读取 SQLite",
      indexedAt: new Date().toISOString(),
      sourcesIndexed: 3,
      skillsIndexed: 6,
      agentsIndexed: 3,
      snapshotId: "browser-preview"
    }
  };
}

function updatePreviewEnabled(
  snapshot: LegacySnapshot,
  command: string,
  id: string,
  enabled: boolean
): LegacySnapshot {
  if (command === "set_workspace_enabled") {
    return {
      ...snapshot,
      workspaces: snapshot.workspaces.map(item => (item.id === id ? { ...item, enabled } : item))
    };
  }

  if (command === "set_preset_enabled") {
    return {
      ...snapshot,
      presets: snapshot.presets.map(item => (item.id === id ? { ...item, enabled } : item))
    };
  }

  if (command === "set_agent_adapter_enabled") {
    return {
      ...snapshot,
      agentAdapters: snapshot.agentAdapters.map(item => (item.id === id ? { ...item, enabled } : item))
    };
  }

  return snapshot;
}

function scopeLabel(scope: string) {
  if (scope === "global") return "全局";
  if (scope === "agent") return "Agent";
  if (scope === "project") return "项目";
  return scope;
}

function ScanFlag({ enabled, label }: { enabled: boolean; label: string }) {
  return <span className={enabled ? "scan-flag is-on" : "scan-flag"}>{enabled ? "有" : "缺"} {label}</span>;
}

function formatScanTime(value: string) {
  if (!value) {
    return "待生成";
  }
  if (/^\d{16,}$/.test(value)) {
    return "刚刚";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "已记录";
  }
  return date.toLocaleString();
}

function projectInstructionPreview(scan: ProjectScanCard) {
  const stack = [
    scan.hasPackageJson ? "前端 package.json" : "",
    scan.hasCargoToml ? "Rust/Cargo" : "",
    scan.hasTauriConfig ? "Tauri 桌面壳" : ""
  ].filter(Boolean);
  const instructionFiles = [
    scan.hasAgentsMd ? "AGENTS.md 已存在" : "AGENTS.md 待补",
    scan.hasClaudeMd ? "CLAUDE.md 已存在" : "CLAUDE.md 待补"
  ];

  return [
    "# 项目工作区说明草稿",
    `项目路径：${scan.path}`,
    `识别技术栈：${stack.length > 0 ? stack.join(" / ") : "暂未识别"}`,
    `AI 说明文件：${instructionFiles.join("，")}`,
    "",
    "建议策略：先保持只读扫描；等快照、备份和回滚完成后，再允许生成或更新项目级说明文件。"
  ].join("\n");
}

function adapterStatusLabel(status: string) {
  if (status === "ready") return "可用";
  if (status === "detected-unmanaged") return "待接管";
  return "未检测";
}

function capabilityLabel(key: string) {
  if (key === "global-scope") return "全局";
  if (key === "project-scope") return "项目";
  if (key === "copy-fallback") return "复制兜底";
  if (key === "instructions-generation") return "生成说明";
  return key;
}

function ToggleSwitch({
  disabled,
  enabled,
  label,
  onClick
}: {
  disabled: boolean;
  enabled: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      aria-pressed={enabled}
      className={enabled ? "switch is-on" : "switch"}
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      <span aria-hidden="true" />
      <strong>{label}</strong>
    </button>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <article className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <section className="panel empty-state">
      <p>{text}</p>
    </section>
  );
}
