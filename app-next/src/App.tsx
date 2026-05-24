import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useState } from "react";
import type { LegacySnapshot, LegacySummary, NavKey } from "./types";

const navItems: Array<{ key: NavKey; label: string; hint: string }> = [
  { key: "dashboard", label: "总览", hint: "健康、同步、风险" },
  { key: "library", label: "技能库", hint: "中央 Skill Library" },
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

  async function loadSnapshot() {
    setLoading(true);
    try {
      const result = await invoke<LegacySnapshot>("scan_legacy_snapshot");
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
            <button className="ghost-button" disabled={loading} onClick={() => void loadSnapshot()} type="button">
              {loading ? "正在刷新" : "刷新索引"}
            </button>
            <div className="status-pill">只读 v1 · 写入 v2 SQLite</div>
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
        {active === "sources" && <Sources snapshot={snapshot} />}
        {active === "agents" && <Agents snapshot={snapshot} />}
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
          <p className="eyebrow">真实 v1 只读扫描</p>
          <h2>v2 正在读取现有 AI SkillHub 数据</h2>
          <p>
            当前阶段只读取 v1 的 Skills、来源、AI 工具和诊断结果，不修改用户 skills、GitHub 来源、配置或 AI 工具链接。
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
          <li>读取模式：{snapshot?.mode ?? "read-only"}，写入范围仅限 v2 SQLite</li>
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

function Agents({ snapshot }: { snapshot: LegacySnapshot | null }) {
  const agents = snapshot?.agents ?? [];

  return (
    <div className="card-grid">
      {agents.map(agent => (
        <article className="agent-card" key={agent.name}>
          <strong>{agent.name}</strong>
          <p>{agent.path}</p>
          <footer>
            <span>{agent.detected ? "已检测" : "未检测"}</span>
            <span>{agent.managed ? "已接管" : "未接管"}</span>
            <span>{agent.skillCount} Skills</span>
          </footer>
        </article>
      ))}
      {agents.length === 0 && <EmptyState text="正在等待 AI 工具检测结果。" />}
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
