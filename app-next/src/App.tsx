import { useMemo, useState } from "react";
import { agents, skills, sources } from "./data/sample";
import type { NavKey } from "./types";

const navItems: Array<{ key: NavKey; label: string; hint: string }> = [
  { key: "dashboard", label: "总览", hint: "健康、同步、风险" },
  { key: "library", label: "技能库", hint: "中央 Skill Library" },
  { key: "sources", label: "来源", hint: "GitHub、本地、Prompt" },
  { key: "agents", label: "AI 工具", hint: "Claude、Codex、Antigravity" },
  { key: "settings", label: "设置", hint: "路径、主题、迁移" }
];

export function App() {
  const [active, setActive] = useState<NavKey>("dashboard");

  const summary = useMemo(() => {
    return {
      skills: skills.length,
      sources: sources.length,
      agents: agents.filter(agent => agent.detected).length,
      warnings: skills.filter(skill => skill.health !== "ok").length
    };
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
          <div className="status-pill">只读迁移模式</div>
        </header>

        {active === "dashboard" && <Dashboard summary={summary} />}
        {active === "library" && <Library />}
        {active === "sources" && <Sources />}
        {active === "agents" && <Agents />}
        {active === "settings" && <Settings />}
      </section>
    </main>
  );
}

function Dashboard({ summary }: { summary: { skills: number; sources: number; agents: number; warnings: number } }) {
  return (
    <div className="view">
      <section className="hero-panel">
        <div>
          <p className="eyebrow">下一阶段目标</p>
          <h2>从文件夹链接工具升级为 AI Agent 能力中枢</h2>
          <p>
            v2 会先以只读方式扫描 v1 的 Skills、来源、AI 工具和诊断结果，确认模型稳定后再加入写入、同步、快照和回滚。
          </p>
        </div>
      </section>

      <section className="metrics">
        <Metric label="示例 Skills" value={summary.skills} />
        <Metric label="示例来源" value={summary.sources} />
        <Metric label="示例 AI 工具" value={summary.agents} />
        <Metric label="需关注" value={summary.warnings} />
      </section>

      <section className="panel">
        <h3>v2 第一阶段验收</h3>
        <ul className="check-list">
          <li>建立 Tauri + React + TypeScript + Rust + SQLite 工程边界。</li>
          <li>只读读取 v1 数据，不修改用户 skills 或 AI 工具链接。</li>
          <li>复刻 v1 已验证行为：诊断、来源、技能、Agent、设置。</li>
          <li>后续加入 SQLite schema、真实扫描和视觉回归测试。</li>
        </ul>
      </section>
    </div>
  );
}

function Library() {
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
    </div>
  );
}

function Sources() {
  return (
    <div className="table-panel">
      {sources.map(source => (
        <div className="source-row" key={source.name}>
          <strong>{source.name}</strong>
          <span>{source.type}</span>
          <span>{source.skillCount} Skills</span>
          <small>{source.url}</small>
        </div>
      ))}
    </div>
  );
}

function Agents() {
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
    </div>
  );
}

function Settings() {
  return (
    <section className="panel">
      <h3>迁移策略</h3>
      <p>
        v2 当前只做只读扫描。真正接管 Claude、Codex、Antigravity 前，必须先完成 SQLite schema、备份、快照和回滚。
      </p>
      <div className="setting-row">
        <span>中央目录</span>
        <code>../skills</code>
      </div>
      <div className="setting-row">
        <span>来源目录</span>
        <code>../app/github_sources</code>
      </div>
      <div className="setting-row">
        <span>诊断报告</span>
        <code>../app/reports/latest-diagnostics.json</code>
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
