import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useState } from "react";
import type { LegacySnapshot, LegacySummary, NavKey } from "./types";

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
    <main className="shell">
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
              {loading ? "正在刷新" : "刷新 v1 并入库"}
            </button>
            <div className="status-pill">SQLite 优先 · 手动刷新才扫描 v1</div>
          </div>
        </header>

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
            <article className="project-scan-row" key={scan.id}>
              <strong>{scan.path}</strong>
              <span>{scan.fileCount} 个文件</span>
              <span>{scan.hasGit ? "Git" : "无 Git"}</span>
              <span>{scan.hasPackageJson ? "React/Vite" : "无 package.json"}</span>
              <span>{scan.hasCargoToml ? "Rust" : "无 Cargo"}</span>
              <span>{scan.hasTauriConfig ? "Tauri" : "无 Tauri"}</span>
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

function scopeLabel(scope: string) {
  if (scope === "global") return "全局";
  if (scope === "agent") return "Agent";
  if (scope === "project") return "项目";
  return scope;
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
