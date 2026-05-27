import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useState } from "react";
import type {
  DesktopQaCheckCard,
  LegacySnapshot,
  LegacySummary,
  NavKey,
  ProjectScanCard,
  ReleaseReportCard,
  WorkspaceCard
} from "./types";

const navItems: Array<{ key: NavKey; label: string; hint: string; icon: string }> = [
  { key: "dashboard", label: "Dashboard", hint: "Overview", icon: "▦" },
  { key: "library", label: "Skill Library", hint: "Central skills", icon: "✦" },
  { key: "sources", label: "Sources", hint: "GitHub and local", icon: "▤" },
  { key: "workspaces", label: "Workspaces", hint: "Global and projects", icon: "⌘" },
  { key: "presets", label: "Presets", hint: "Skill bundles", icon: "≡" },
  { key: "agents", label: "Agents", hint: "Claude, Codex, Antigravity", icon: "◎" },
  { key: "snapshots", label: "Snapshots", hint: "Backups and rollback", icon: "◈" },
  { key: "release", label: "Release Gate", hint: "QA and publishing", icon: "△" }
];

type ThemeName = "dark" | "light";

export function App() {
  const [active, setActive] = useState<NavKey>(() => initialNavKey());
  const [theme, setTheme] = useState<ThemeName>(() => initialTheme());
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

  async function updateDesktopQaStatus(id: string, status: "pending" | "passed" | "failed") {
    setLoading(true);
    try {
      if (!hasTauriRuntime()) {
        setSnapshot(previous => updatePreviewDesktopQaStatus(previous ?? createPreviewSnapshot(), id, status));
        setLoadError("");
        return;
      }

      const result = await invoke<LegacySnapshot>("set_desktop_qa_check_status", { id, status });
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

  useEffect(() => {
    document.body.dataset.theme = theme;
    window.localStorage.setItem("ai-skillhub-theme", theme);
  }, [theme]);

  return (
    <main className={`${runtimeAvailable ? "shell" : "shell browser-preview-shell"} theme-${theme}`}>
      <aside className="sidebar">
        <div className="brand">
          <img alt="AI SkillHub" className="brand-logo" src="/ai-skillhub-logo.png" />
          <div>
            <strong>SkillHub V2</strong>
            <span>Management Platform</span>
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
              <span className="nav-icon" aria-hidden="true">{item.icon}</span>
              <strong>{item.label}</strong>
            </button>
          ))}
        </nav>

        <div className="sidebar-footer">
          <button
            className={active === "settings" ? "nav-item active" : "nav-item"}
            onClick={() => setActive("settings")}
            type="button"
          >
            <span className="nav-icon" aria-hidden="true">⚙</span>
            <strong>Settings</strong>
          </button>
          <button className="nav-item" onClick={() => setActive("release")} type="button">
            <span className="nav-icon" aria-hidden="true">?</span>
            <strong>Help</strong>
          </button>
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div className="command-search">
            <span aria-hidden="true">⌕</span>
            <input aria-label="Search commands, skills, or sources" placeholder="Search commands, skills, or sources..." />
            <kbd>⌘</kbd>
            <kbd>K</kbd>
          </div>
          <div className="topbar-actions">
            <button className="icon-button" aria-label="Notifications" type="button">♧</button>
            <button
              className="icon-button theme-toggle-button"
              aria-label={theme === "dark" ? "切换到亮色主题" : "切换到暗色主题"}
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
              type="button"
            >
              {theme === "dark" ? "☀" : "☾"}
            </button>
            <span className="topbar-divider" />
            <img alt="AI SkillHub" className="topbar-avatar" src="/ai-skillhub-logo.png" />
            <button
              className="ghost-button sr-refresh"
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

        {active === "dashboard" && (
          <Dashboard
            loading={loading}
            onOpenRelease={() => setActive("release")}
            onOpenSources={() => setActive("sources")}
            onSync={() => void loadSnapshot("refresh")}
            snapshot={snapshot}
            summary={summary}
          />
        )}
        {active === "library" && (
          <Library
            loading={loading}
            onOpenSources={() => setActive("sources")}
            onSync={() => void loadSnapshot("refresh")}
            snapshot={snapshot}
          />
        )}
        {active === "workspaces" && <Workspaces disabled={loading} onToggle={updateEnabled} snapshot={snapshot} />}
        {active === "presets" && <Presets disabled={loading} onToggle={updateEnabled} snapshot={snapshot} />}
        {active === "sources" && <Sources snapshot={snapshot} />}
        {active === "agents" && <Agents disabled={loading} onToggle={updateEnabled} snapshot={snapshot} />}
        {active === "snapshots" && <Snapshots snapshot={snapshot} />}
        {active === "release" && <ReleaseGate snapshot={snapshot} />}
        {active === "settings" && <Settings disabled={loading} onQaStatus={updateDesktopQaStatus} snapshot={snapshot} />}
      </section>
    </main>
  );
}

function Dashboard({
  loading,
  onOpenRelease,
  onOpenSources,
  onSync,
  snapshot,
  summary
}: {
  loading: boolean;
  onOpenRelease: () => void;
  onOpenSources: () => void;
  onSync: () => void;
  snapshot: LegacySnapshot | null;
  summary: LegacySummary;
}) {
  const backupBlocked = countByStatus(snapshot?.backupDryRun ?? [], "blocked");
  const restoreBlocked = countByStatus(snapshot?.restoreDryRun ?? [], "blocked");
  const lockedRollback = (snapshot?.rollbackPlan ?? []).filter(step => step.status === "locked").length;
  const desktopQaStatus = desktopQaGateStatus(snapshot?.desktopQaChecks ?? []);
  const releaseReportsOk = (snapshot?.releaseReports ?? []).filter(report => report.ok).length;
  const releaseReportsTotal = Math.max((snapshot?.releaseReports ?? []).length, 1);
  const readinessScore = Math.max(
    20,
    Math.min(
      92,
      Math.round(
        (summary.diagnosticsStatus === "ok" ? 28 : 10) +
          (backupBlocked === 0 ? 22 : 8) +
          (restoreBlocked === 0 ? 18 : 6) +
          (desktopQaStatus === "done" ? 16 : desktopQaStatus === "blocked" ? 3 : 8) +
          (releaseReportsOk / releaseReportsTotal) * 8
      )
    )
  );
  const healthIssues = summary.warnings + backupBlocked + restoreBlocked + lockedRollback;
  const readinessRows = [
    {
      label: "Core Safety Gate",
      value: readinessScore,
      caption: `${summary.diagnosticsStatus} diagnostics · ${summary.warnings} warnings`
    },
    {
      label: "Backup / Restore Dry Run",
      value: backupBlocked + restoreBlocked === 0 ? 72 : 38,
      caption: `${backupBlocked + restoreBlocked} blocking checks`
    },
    {
      label: "Release Package Readiness",
      value: desktopQaStatus === "done" ? 66 : 24,
      caption: desktopQaGateLabel(snapshot?.desktopQaChecks ?? [])
    }
  ];
  const alerts = [
    {
      icon: "!",
      title: healthIssues > 0 ? "Safety Gate Requires Review" : "Safety Gate Clear",
      body:
        healthIssues > 0
          ? `${healthIssues} items still need review before deployment.`
          : "No blocking release issue is currently visible.",
      action: "Inspect Gate"
    },
    {
      icon: "↻",
      title: loading ? "Index Refresh Running" : "SQLite Index Ready",
      body: snapshot?.index.databaseFile
        ? "Current dashboard is loaded from the v2 SQLite index."
        : "Refresh once to seed the v2 SQLite index.",
      action: loading ? "Watching" : "Open Index"
    },
    {
      icon: "i",
      title: "Desktop Alpha Notice",
      body: "This is the v2 Alpha shell. Real sync remains locked behind dry-run gates.",
      action: "View Notes"
    }
  ];

  return (
    <div className="view command-center">
      <section className="command-hero">
        <div>
          <h2>Command Center</h2>
          <p>System overview and AI skill deployment status.</p>
        </div>
        <div className="hero-actions">
          <button className="secondary-action" disabled={loading} onClick={onSync} type="button">
            ↺ {loading ? "Syncing" : "Sync All"}
          </button>
          <button className="primary-action" onClick={onOpenSources} type="button">
            + New Deployment
          </button>
        </div>
      </section>

      <section className="metrics command-metrics">
        <Metric accent="violet" icon="⚙" label="Active Skills" trend={`+${summary.sources} sources indexed`} value={summary.skills} />
        <Metric accent="indigo" icon="❖" label="Sources Indexed" trend={`${summary.prompts} prompt collections`} value={summary.sources} />
        <Metric accent="amber" icon="◒" label="AI Agents" trend={`${summary.agentsDetected} detected locally`} value={summary.agentsDetected} />
        <Metric accent="rose" icon="△" label="Health Issues" trend={healthIssues > 0 ? "Requires attention" : "All clear"} value={healthIssues} />
      </section>

      <section className="command-grid">
        <article className="linear-panel readiness-command-panel">
          <header className="linear-panel-head">
            <h3>Release Readiness</h3>
            <button className="pipeline-link" onClick={onOpenRelease} type="button">
              View Pipeline →
            </button>
          </header>
          <div className="readiness-stack">
            {readinessRows.map(row => (
              <div className="readiness-row" key={row.label}>
                <div>
                  <strong>{row.label}</strong>
                  <span>{row.caption}</span>
                </div>
                <b>{row.value}%</b>
                <div className="linear-progress">
                  <i style={{ width: `${row.value}%` }} />
                </div>
              </div>
            ))}
          </div>
          <div className="bar-visual" aria-label="Indexed activity chart">
            {[32, 46, 24, 62, 84, 52, 78, 92].map((height, index) => (
              <span
                className={index === 4 || index === 6 ? "is-active" : ""}
                key={`${height}-${index}`}
                style={{ height: `${height}%` }}
              />
            ))}
          </div>
        </article>

        <aside className="linear-panel alerts-panel">
          <header className="linear-panel-head">
            <h3><span aria-hidden="true">△</span> Active Alerts</h3>
            <em>{healthIssues} SYS</em>
          </header>
          <div className="alert-list">
            {alerts.map(alert => (
              <article className="alert-item" key={alert.title}>
                <span className="alert-icon">{alert.icon}</span>
                <div>
                  <strong>{alert.title}</strong>
                  <p>{alert.body}</p>
                  <small>{alert.action}</small>
                </div>
              </article>
            ))}
          </div>
          <button className="logs-button" type="button">View All Logs</button>
        </aside>
      </section>
    </div>
  );
}

function Library({
  loading,
  onOpenSources,
  onSync,
  snapshot
}: {
  loading: boolean;
  onOpenSources: () => void;
  onSync: () => void;
  snapshot: LegacySnapshot | null;
}) {
  const skills = snapshot?.skills ?? [];
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [healthFilter, setHealthFilter] = useState<string>("all");
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  const categories = Array.from(new Set(skills.map(skill => skill.category).filter(Boolean))).slice(0, 6);
  const filteredSkills = skills.filter(skill => {
    const categoryMatches = categoryFilter === "all" || skill.category === categoryFilter;
    const healthMatches = healthFilter === "all" || skill.health === healthFilter;
    return categoryMatches && healthMatches;
  });
  const healthCounts = {
    ok: skills.filter(skill => skill.health === "ok").length,
    warn: skills.filter(skill => skill.health === "warn").length,
    error: skills.filter(skill => skill.health === "error").length,
    info: skills.filter(skill => skill.health === "info").length
  };

  return (
    <div className="view skill-library-view">
      <section className="library-header">
        <div>
          <h2>Skill Library</h2>
          <p>Manage, configure, and monitor all active AI capabilities across your workspaces.</p>
        </div>
        <div className="library-actions">
          <button className="secondary-action library-action" disabled={loading} onClick={onSync} type="button">
            ↻ {loading ? "Syncing" : "Sync Sources"}
          </button>
          <button className="primary-action library-action" onClick={onOpenSources} type="button">
            + New Skill
          </button>
        </div>
      </section>

      <section className="library-controls glass-panel">
        <div className="library-filter-row" aria-label="Skill category filters">
          <button
            className={categoryFilter === "all" ? "filter-chip active" : "filter-chip"}
            onClick={() => setCategoryFilter("all")}
            type="button"
          >
            All Skills
          </button>
          {categories.map(category => (
            <button
              className={categoryFilter === category ? "filter-chip active" : "filter-chip"}
              key={category}
              onClick={() => setCategoryFilter(category)}
              type="button"
            >
              {category}
            </button>
          ))}
          <span className="filter-divider" />
          <button
            className={healthFilter === "ok" ? "filter-chip active" : "filter-chip"}
            onClick={() => setHealthFilter(healthFilter === "ok" ? "all" : "ok")}
            type="button"
          >
            <span className="status-dot healthy" />
            Healthy {healthCounts.ok}
          </button>
          <button
            className={healthFilter === "warn" ? "filter-chip active" : "filter-chip"}
            onClick={() => setHealthFilter(healthFilter === "warn" ? "all" : "warn")}
            type="button"
          >
            <span className="status-dot syncing" />
            Warnings {healthCounts.warn}
          </button>
          <button
            className={healthFilter === "error" ? "filter-chip active" : "filter-chip"}
            onClick={() => setHealthFilter(healthFilter === "error" ? "all" : "error")}
            type="button"
          >
            <span className="status-dot error" />
            Errors {healthCounts.error}
          </button>
        </div>
        <div className="view-toggle" aria-label="Skill view mode">
          <button
            className={viewMode === "grid" ? "active" : ""}
            onClick={() => setViewMode("grid")}
            type="button"
          >
            ▦
          </button>
          <button
            className={viewMode === "list" ? "active" : ""}
            onClick={() => setViewMode("list")}
            type="button"
          >
            ☰
          </button>
        </div>
      </section>

      <section className={viewMode === "grid" ? "skill-library-grid" : "skill-library-grid list-mode"}>
        {filteredSkills.map(skill => (
          <article className={`skill-library-card glow-card ${skill.health}`} key={skill.name}>
            <div className="skill-card-top">
              <div className={`skill-card-icon ${categoryTone(skill.category)}`}>{skillIcon(skill.category)}</div>
              <div className="skill-card-status">
                <span className={`status-badge ${skill.health}`}>
                  <span className={`status-dot ${statusDotClass(skill.health)}`} />
                  {skillStatusLabel(skill.health)}
                </span>
                <button aria-label={`Edit ${skill.name}`} className="icon-action" type="button">⋮</button>
              </div>
            </div>
            <h3>{skill.name}</h3>
            <p>{skill.description || "No description provided yet."}</p>
            <div className="skill-tags">
              <span>{skill.category || "Uncategorized"}</span>
              {skill.enabled ? <span>Enabled</span> : <span>Disabled</span>}
            </div>
            <footer>
              <div>
                <span aria-hidden="true">⌁</span>
                <small>Source: {skill.source || skill.relativePath || "local"}</small>
              </div>
              <button aria-label={`Configure ${skill.name}`} className="icon-action" type="button">✎</button>
            </footer>
          </article>
        ))}
        {filteredSkills.length === 0 && (
          <div className="empty-state library-empty">
            {skills.length === 0 ? "正在等待 v1 Skill 扫描结果。" : "当前筛选条件下没有 Skill。"}
          </div>
        )}
      </section>
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
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>("");

  useEffect(() => {
    if (workspaces.length === 0) {
      if (selectedWorkspaceId) setSelectedWorkspaceId("");
      return;
    }

    if (!workspaces.some(workspace => workspace.id === selectedWorkspaceId)) {
      setSelectedWorkspaceId(workspaces[0].id);
    }
  }, [selectedWorkspaceId, workspaces]);

  const selectedWorkspace = workspaces.find(workspace => workspace.id === selectedWorkspaceId) ?? workspaces[0];
  const selectedProjectScan = selectedWorkspace
    ? projectScans.find(scan => scan.workspaceId === selectedWorkspace.id)
    : undefined;

  return (
    <div className="view workspaces-view">
      <div className="card-grid">
        {workspaces.map(workspace => (
          <article
            className={workspace.id === selectedWorkspace?.id ? "workspace-card is-selected" : "workspace-card"}
            key={workspace.id}
          >
            <div className="card-head">
              <strong>{workspace.name}</strong>
              <span className={`scope ${workspace.scope}`}>{scopeLabel(workspace.scope)}</span>
            </div>
            <p>{workspace.path}</p>
            <footer>
              <button
                className="detail-button"
                onClick={() => setSelectedWorkspaceId(workspace.id)}
                type="button"
              >
                查看详情
              </button>
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

      {selectedWorkspace && (
        <WorkspaceDetailPanel projectScan={selectedProjectScan} workspace={selectedWorkspace} />
      )}

      <section className="panel workspace-scan-panel">
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

function WorkspaceDetailPanel({
  projectScan,
  workspace
}: {
  projectScan?: ProjectScanCard;
  workspace: WorkspaceCard;
}) {
  const isProject = workspace.scope === "project";

  return (
    <section className="panel workspace-detail-panel">
      <div className="workspace-detail-head">
        <div>
          <p className="eyebrow">Workspace Detail</p>
          <h3>{workspace.name}</h3>
          <span>{workspace.path}</span>
        </div>
        <span className={`scope ${workspace.scope}`}>{scopeLabel(workspace.scope)}</span>
      </div>

      <div className="workspace-detail-metrics">
        <article>
          <span>范围</span>
          <strong>{scopeLabel(workspace.scope)}</strong>
        </article>
        <article>
          <span>AI 工具</span>
          <strong>{workspace.agentCount}</strong>
        </article>
        <article>
          <span>Skills</span>
          <strong>{workspace.skillCount}</strong>
        </article>
        <article>
          <span>状态</span>
          <strong>{workspace.enabled ? "已启用" : "已停用"}</strong>
        </article>
      </div>

      {isProject && projectScan ? (
        <div className="workspace-detail-scan">
          <div className="scan-flags">
            <ScanFlag enabled={projectScan.hasGit} label="Git" />
            <ScanFlag enabled={projectScan.hasPackageJson} label="package.json" />
            <ScanFlag enabled={projectScan.hasCargoToml} label="Cargo.toml" />
            <ScanFlag enabled={projectScan.hasTauriConfig} label="Tauri" />
            <ScanFlag enabled={projectScan.hasAgentsMd} label="AGENTS.md" />
            <ScanFlag enabled={projectScan.hasClaudeMd} label="CLAUDE.md" />
            <ScanFlag enabled={projectScan.hasReadmeMd} label="README.md" />
          </div>
          <div className="instruction-preview">
            <p className="eyebrow">只读说明预览</p>
            <pre>{projectInstructionPreview(projectScan)}</pre>
          </div>
        </div>
      ) : (
        <div className="workspace-detail-note">
          <strong>{isProject ? "等待项目扫描结果" : "当前是只读工作区详情"}</strong>
          <span>
            {isProject
              ? "项目详情页会在扫描完成后显示技术栈、说明文件和只读说明草稿。"
              : "全局和 Agent 工作区先展示范围、路径和启用状态；真实同步仍需等待备份、回滚和发布闸门完成。"}
          </span>
        </div>
      )}
    </section>
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
    <div className="view presets-view">
      <section className="page-header compact">
        <div>
          <h2>Presets</h2>
          <p>Group related Skills into reusable bundles before enabling them for workspaces.</p>
        </div>
      </section>

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
    </div>
  );
}

function Sources({ snapshot }: { snapshot: LegacySnapshot | null }) {
  const sources = snapshot?.sources ?? [];
  const githubSources = sources.filter(source => source.url).length;
  const localSources = sources.filter(source => !source.url && source.localPath).length;

  return (
    <div className="view sources-view">
      <section className="page-header">
        <div>
          <h2>Sources</h2>
          <p>Track GitHub repositories, local folders, Prompt material, and current source health before syncing.</p>
        </div>
        <div className="page-header-stats">
          <span>{sources.length} total</span>
          <span>{githubSources} GitHub</span>
          <span>{localSources} local</span>
        </div>
      </section>

      <div className="table-panel source-table">
        {sources.map(source => (
          <div className={`source-row ${source.health}`} key={source.name}>
            <strong>{source.name}</strong>
            <span>{sourceTypeLabel(source.sourceType)}</span>
            <span>{source.skillCount} Skills</span>
            <span className={`status-badge ${source.health}`}>
              <span className={`status-dot ${statusDotClass(source.health)}`} />
              {skillStatusLabel(source.health)}
            </span>
            <small>{source.url || source.localPath}</small>
          </div>
        ))}
        {sources.length === 0 && <EmptyState text="正在等待来源扫描结果。" />}
      </div>
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
    <div className="view agents-view">
      <section className="page-header">
        <div>
          <h2>Agents</h2>
          <p>Separate supported AI tools from tools detected on this machine, then enable adapters safely.</p>
        </div>
        <div className="page-header-stats">
          <span>{adapters.length} supported</span>
          <span>{adapters.filter(adapter => adapter.detected).length} detected</span>
          <span>{adapters.filter(adapter => adapter.enabled).length} enabled</span>
        </div>
      </section>

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

function Snapshots({ snapshot }: { snapshot: LegacySnapshot | null }) {
  const snapshots = snapshot?.snapshots ?? [];
  const backupTargets = snapshot?.backupTargets ?? [];
  const backupDryRun = snapshot?.backupDryRun ?? [];
  const restoreDryRun = snapshot?.restoreDryRun ?? [];
  const rollbackPlan = snapshot?.rollbackPlan ?? [];
  const latest = snapshots.find(item => item.isLatest) ?? snapshots[0];

  return (
    <div className="view snapshots-view">
      <section className="hero-panel snapshot-hero">
        <div>
          <p className="eyebrow">Snapshot / Rollback Gate</p>
          <h2>先把退路修好，再开放真实同步</h2>
          <p>
            当前阶段只记录 v2 SQLite 索引快照和回滚计划。真实恢复按钮会保持锁定，直到备份、dry-run
            和路径安全检查全部完成。
          </p>
        </div>
      </section>

      <section className="snapshot-layout">
        <article className="panel">
          <p className="eyebrow">最新快照</p>
          <h3>{latest?.name ?? "等待生成快照"}</h3>
          <p>{latest?.summary ?? "点击刷新后，v2 会把当前只读索引写入 SQLite 快照记录。"}</p>
          <div className="snapshot-meta">
            <span>{latest ? formatScanTime(latest.createdAt) : "未生成"}</span>
            <span>{snapshot?.index.snapshotId ?? "无快照 ID"}</span>
          </div>
        </article>

        <article className="panel rollback-gate">
          <p className="eyebrow">写入闸门</p>
          <h3>真实恢复仍然锁定</h3>
          <p>
            现在能做的是看见风险和准备步骤；不能直接删除链接、覆盖目录或恢复文件。这个闸门以后会保护分享版用户。
          </p>
        </article>
      </section>

      <section className="panel">
        <p className="eyebrow">回滚计划</p>
        <h3>执行前必须逐步通过</h3>
        <div className="rollback-steps">
          {rollbackPlan.map(step => (
            <article className={`rollback-step ${step.status}`} key={step.id}>
              <div className="step-number">{step.stepOrder}</div>
              <div>
                <div className="rollback-step-head">
                  <strong>{step.title}</strong>
                  <span className={`risk ${step.riskLevel}`}>{riskLabel(step.riskLevel)}</span>
                  <span className={`step-status ${step.status}`}>{stepStatusLabel(step.status)}</span>
                </div>
                <p>{step.summary}</p>
              </div>
            </article>
          ))}
          {rollbackPlan.length === 0 && <p>等待下一次刷新生成回滚计划。</p>}
        </div>
      </section>

      <section className="panel">
        <p className="eyebrow">Backup Target Inventory</p>
        <h3>真实接管前必须先备份的目录</h3>
        <div className="backup-target-list">
          {backupTargets.map(target => (
            <article className={`backup-target-card ${target.preflightStatus}`} key={target.id}>
              <div className="backup-target-head">
                <strong>{target.agentName}</strong>
                <span className={`step-status ${target.preflightStatus}`}>
                  {backupStatusLabel(target.preflightStatus)}
                </span>
                <span className={`risk ${target.riskLevel}`}>{riskLabel(target.riskLevel)}</span>
              </div>
              <div className="backup-paths">
                <span>目标</span>
                <code>{target.targetPath}</code>
                <span>备份</span>
                <code>{target.backupPath}</code>
              </div>
              <div className="backup-flags">
                <span>{target.detected ? "已检测" : "未检测"}</span>
                <span>{target.managed ? "已接管" : "未接管"}</span>
                <span>{target.required ? "必须备份" : "暂不需要"}</span>
              </div>
              <p>{target.blocker}</p>
            </article>
          ))}
          {backupTargets.length === 0 && <p>等待下一次刷新生成备份目标清单。</p>}
        </div>
      </section>

      <section className="panel">
        <p className="eyebrow">Backup Dry-run Plan</p>
        <h3>只预演，不复制真实文件</h3>
        <div className="dry-run-list">
          {backupDryRun.map(item => (
            <article className={`dry-run-row ${item.status}`} key={item.id}>
              <div>
                <strong>{item.agentName}</strong>
                <span>{backupActionLabel(item.action)}</span>
              </div>
              <div className="dry-run-paths">
                <code>{item.targetPath}</code>
                <span>→</span>
                <code>{item.backupPath}</code>
              </div>
              <span className={`step-status ${item.status}`}>{dryRunStatusLabel(item.status)}</span>
              <span className={`risk ${item.riskLevel}`}>{riskLabel(item.riskLevel)}</span>
              <p>{item.summary}</p>
            </article>
          ))}
          {backupDryRun.length === 0 && <p>等待下一次刷新生成备份预演计划。</p>}
        </div>
      </section>

      <section className="panel">
        <p className="eyebrow">Restore Dry-run Report</p>
        <h3>只预演，不执行真实恢复</h3>
        <div className="dry-run-list">
          {restoreDryRun.map(item => (
            <article className={`dry-run-row ${item.status}`} key={item.id}>
              <div>
                <strong>{item.agentName}</strong>
                <span>{restoreActionLabel(item.action)}</span>
              </div>
              <div className="dry-run-paths">
                <code>{item.backupPath}</code>
                <span>→</span>
                <code>{item.targetPath}</code>
              </div>
              <span className={`step-status ${item.status}`}>{dryRunStatusLabel(item.status)}</span>
              <span className={`risk ${item.riskLevel}`}>{riskLabel(item.riskLevel)}</span>
              <p>{item.summary}</p>
            </article>
          ))}
          {restoreDryRun.length === 0 && <p>等待下一次刷新生成恢复预演报告。</p>}
        </div>
      </section>

      <section className="panel">
        <p className="eyebrow">历史快照</p>
        <h3>最近记录</h3>
        <div className="snapshot-list">
          {snapshots.map(item => (
            <article className={item.isLatest ? "snapshot-row latest" : "snapshot-row"} key={item.id}>
              <strong>{item.name}</strong>
              <span>{item.summary}</span>
              <small>{formatScanTime(item.createdAt)}</small>
            </article>
          ))}
          {snapshots.length === 0 && <p>暂无历史快照。</p>}
        </div>
      </section>
    </div>
  );
}

function ReleaseGate({ snapshot }: { snapshot: LegacySnapshot | null }) {
  const diagnostics = snapshot?.diagnostics;
  const releaseReports = snapshot?.releaseReports ?? [];
  const diagnosticsReport = releaseReports.find(report => report.id === "diagnostics");
  const releasePreflight = releaseReports.find(report => report.id === "release-preflight");
  const shareRecipient = releaseReports.find(report => report.id === "share-recipient");
  const zipPreview = releaseReports.find(report => report.id === "zip-preview");
  const desktopQaChecks = snapshot?.desktopQaChecks ?? [];
  const backupDryRun = snapshot?.backupDryRun ?? [];
  const restoreDryRun = snapshot?.restoreDryRun ?? [];
  const rollbackPlan = snapshot?.rollbackPlan ?? [];
  const blockedBackups = countByStatus(backupDryRun, "blocked");
  const plannedBackups = countByStatus(backupDryRun, "planned");
  const blockedRestores = countByStatus(restoreDryRun, "blocked");
  const plannedRestores = countByStatus(restoreDryRun, "planned");
  const lockedRollbackSteps = rollbackPlan.filter(step => step.status === "locked").length;
  const diagnosticsReady = Boolean(
    diagnosticsReport?.ok ?? (diagnostics?.available && diagnostics.error === 0)
  );

  const gateItems = [
    {
      status: diagnosticsReady ? "done" : "blocked",
      title: "诊断体检",
      label: diagnosticsReady ? "已通过" : "待处理",
      summary: diagnosticsReady
        ? diagnosticsReport?.summary ??
          `诊断可读取：${diagnostics?.ok ?? 0} ok / ${diagnostics?.warn ?? 0} warn / ${diagnostics?.error ?? 0} error。`
        : "没有可用诊断，或诊断仍包含错误。"
    },
    {
      status: backupDryRun.length > 0 && blockedBackups === 0 && plannedBackups === 0 ? "done" : "planned",
      title: "备份预演",
      label: backupDryRun.length > 0 ? "只读预演" : "待生成",
      summary:
        backupDryRun.length > 0
          ? `${backupDryRun.length} 项预演，${plannedBackups} 项仍在计划中，${blockedBackups} 项阻断。`
          : "等待刷新后生成备份 dry-run。"
    },
    {
      status: restoreDryRun.length > 0 && blockedRestores === 0 && plannedRestores === 0 ? "done" : "planned",
      title: "恢复预演",
      label: restoreDryRun.length > 0 ? "只读预演" : "待生成",
      summary:
        restoreDryRun.length > 0
          ? `${restoreDryRun.length} 项预演，${plannedRestores} 项仍在计划中，${blockedRestores} 项阻断。`
          : "等待刷新后生成恢复 dry-run。"
    },
    {
      status: lockedRollbackSteps === 0 && rollbackPlan.length > 0 ? "done" : "blocked",
      title: "回滚锁",
      label: lockedRollbackSteps === 0 ? "未锁定" : "仍锁定",
      summary:
        rollbackPlan.length > 0
          ? `${rollbackPlan.length} 个回滚步骤，${lockedRollbackSteps} 个真实执行步骤仍锁定。`
          : "等待刷新后生成回滚计划。"
    },
    {
      status: desktopQaGateStatus(desktopQaChecks),
      title: "桌面 QA",
      label: desktopQaGateLabel(desktopQaChecks),
      summary: desktopQaGateSummary(desktopQaChecks)
    },
    {
      status: releaseReportGateStatus(releasePreflight),
      title: "发布预检",
      label: releaseReportGateLabel(releasePreflight),
      summary: releasePreflight?.summary ?? "还没有找到 v1 发布预检报告。"
    },
    {
      status: releaseReportGateStatus(shareRecipient),
      title: "分享验证",
      label: releaseReportGateLabel(shareRecipient),
      summary: shareRecipient?.summary ?? "还没有找到 v1 分享验收报告。"
    },
    {
      status: releaseReportGateStatus(zipPreview),
      title: "zip 预览",
      label: releaseReportGateLabel(zipPreview),
      summary: zipPreview?.summary ?? "还没有找到 zip 导入预览报告。"
    }
  ];
  const doneCount = gateItems.filter(item => item.status === "done").length;
  const blockedCount = gateItems.filter(item => item.status === "blocked").length;
  const plannedCount = gateItems.filter(item => item.status === "planned").length;
  const readinessStatus = blockedCount > 0 ? "blocked" : plannedCount > 0 ? "planned" : "done";
  const readinessLabel =
    readinessStatus === "done" ? "候选可复查" : readinessStatus === "blocked" ? "禁止发布" : "暂不发布";
  const readinessTitle =
    readinessStatus === "done"
      ? "所有发布闸门已通过"
      : readinessStatus === "blocked"
        ? "现在不能发布"
        : "现在暂不发布";
  const readinessReason = releaseReadinessReason(gateItems);
  const readinessSummary =
    readinessStatus === "done"
      ? "可以进入候选打包复查；此页面仍不会直接执行打包。"
      : readinessReason;
  const readinessDetails = gateItems
    .filter(item => item.status !== "done")
    .slice(0, 4);

  return (
    <div className="view release-view">
      <section className="hero-panel release-hero">
        <div>
          <p className="eyebrow">Release Gate</p>
          <h2>所有安全闸门通过前，不生成可分享版本</h2>
          <p>
            这个页面把备份预演、恢复预演、诊断、桌面 QA 和分享验证集中到一个发布前入口。
            当前仍是只读状态面板，不会执行打包或写入。
          </p>
        </div>
      </section>

      <section className={`panel readiness-panel ${readinessStatus}`}>
        <div>
          <p className="eyebrow">Release Readiness</p>
          <h3>{readinessTitle}</h3>
          <p>
            {readinessSummary} 当前进度：{doneCount}/{gateItems.length} 个闸门通过，{plannedCount} 个待复查，{blockedCount} 个阻断。
          </p>
        </div>
        <span className={`qa-status ${readinessStatus}`}>{readinessLabel}</span>
        {readinessDetails.length > 0 && (
          <div className="readiness-reasons">
            {readinessDetails.map(item => (
              <span key={item.title}>{item.title}：{item.label}</span>
            ))}
          </div>
        )}
      </section>

      <section className="release-summary-grid">
        <article className="metric">
          <span>闸门总数</span>
          <strong>{gateItems.length}</strong>
        </article>
        <article className="metric">
          <span>已通过</span>
          <strong>{doneCount}</strong>
        </article>
        <article className="metric">
          <span>待处理</span>
          <strong>{gateItems.length - doneCount}</strong>
        </article>
        <article className="metric">
          <span>阻断项</span>
          <strong>{blockedCount}</strong>
        </article>
      </section>

      <section className="panel release-gate-panel">
        <p className="eyebrow">Preflight Status</p>
        <h3>发布仍保持锁定</h3>
        <p>
          只有当诊断、备份预演、恢复预演、回滚、桌面 QA、发布预检和分享验证都通过后，v2 才应该开放打包入口。
        </p>
        <div className="release-gate-grid">
          {gateItems.map(item => (
            <article className={`release-gate-card ${item.status}`} key={item.title}>
              <span className={`qa-status ${item.status}`}>{item.label}</span>
              <strong>{item.title}</strong>
              <small>{item.summary}</small>
            </article>
          ))}
        </div>
      </section>

      <section className="panel release-report-panel">
        <p className="eyebrow">V1 Report Inputs</p>
        <h3>已接入的 v1 报告摘要</h3>
        <p>
          v2 当前只读取这些报告的摘要，不执行 v1 脚本，也不修改任何本机 AI 工具目录。
        </p>
        <div className="release-report-grid">
          {releaseReports.map(report => (
            <article className={`release-report-card ${releaseReportGateStatus(report)}`} key={report.id}>
              <div>
                <span className={`qa-status ${releaseReportGateStatus(report)}`}>{releaseReportGateLabel(report)}</span>
                <strong>{report.title}</strong>
              </div>
              <small>{formatScanTime(report.generatedAt)}</small>
              <p>{report.summary}</p>
              <div className="release-report-stats">
                <span>{report.passed}/{report.total} 通过</span>
                <span>{report.warn} warn</span>
                <span>{report.error} error</span>
              </div>
            </article>
          ))}
          {releaseReports.length === 0 && <p>未找到 v1 报告。请先在 v1 生成诊断包、发布预检或分享验收。</p>}
        </div>
      </section>

      <section className="panel release-next-panel">
        <p className="eyebrow">Next Safe Step</p>
        <h3>下一步补桌面 QA 证据入口</h3>
        <p>
          v1 诊断、预检、分享和 zip 预览已经进入 v2 发布闸门；下一步应把桌面窗口截图/人工确认结果也记录成可追踪状态。
        </p>
      </section>
    </div>
  );
}

function Settings({
  disabled,
  onQaStatus,
  snapshot
}: {
  disabled: boolean;
  onQaStatus: (id: string, status: "pending" | "passed" | "failed") => void;
  snapshot: LegacySnapshot | null;
}) {
  const desktopQaChecks = snapshot?.desktopQaChecks ?? [];

  return (
    <div className="view settings-view">
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

      <section className="panel release-guide">
        <p className="eyebrow">Build / Release Guide</p>
        <h3>开发版 exe 和正式发布版不是一回事</h3>
        <p>
          当前 v2 仍在开发线。日常测试请用开发命令启动桌面窗口；最终给别人使用的安装包，要等安全闸门和分享验证通过后再打包。
        </p>
        <div className="release-guide-grid">
          <article>
            <strong>现在测试</strong>
            <span>开发桌面窗口</span>
            <code>pnpm dev:desktop</code>
            <small>会先清理残留调试进程，再启动 Tauri dev。</small>
          </article>
          <article>
            <strong>调试 exe</strong>
            <span>只给开发阶段使用</span>
            <code>src-tauri\target\debug\ai-skillhub-next.exe</code>
            <small>它不是可分享安装包，直接复制给别人不稳定。</small>
          </article>
          <article>
            <strong>正式发布</strong>
            <span>以后才开放</span>
            <code>pnpm tauri build</code>
            <small>通过备份、回滚、发布预检和分享验证后再生成。</small>
          </article>
        </div>
      </section>

      <section className="panel desktop-qa">
        <p className="eyebrow">Desktop QA Checklist</p>
        <h3>桌面窗口发布前检查</h3>
        <p>
          每次准备打包前都要用真实 Tauri 桌面窗口检查，不用浏览器预览代替。这里的状态只写入 v2 SQLite，不会修改 v1 或 AI 工具目录。
        </p>
        <div className="qa-checklist-grid">
          {desktopQaChecks.map(check => (
            <article className={`qa-check-card ${qaStatusClass(check.status)}`} key={check.id}>
              <span className={`qa-status ${qaStatusClass(check.status)}`}>{qaStatusLabel(check.status)}</span>
              <strong>{check.title}</strong>
              <small>{check.description}</small>
              <div className="qa-actions" aria-label={`${check.title} 状态`}>
                <button
                  className={check.status === "passed" ? "qa-action active" : "qa-action"}
                  disabled={disabled}
                  onClick={() => onQaStatus(check.id, "passed")}
                  type="button"
                >
                  通过
                </button>
                <button
                  className={check.status === "failed" ? "qa-action danger active" : "qa-action danger"}
                  disabled={disabled}
                  onClick={() => onQaStatus(check.id, "failed")}
                  type="button"
                >
                  失败
                </button>
                <button
                  className={check.status === "pending" ? "qa-action muted active" : "qa-action muted"}
                  disabled={disabled}
                  onClick={() => onQaStatus(check.id, "pending")}
                  type="button"
                >
                  待查
                </button>
              </div>
              <small className="qa-updated">更新：{formatScanTime(check.updatedAt)}</small>
            </article>
          ))}
          {desktopQaChecks.length === 0 && <EmptyState text="等待 v2 SQLite 生成桌面 QA 检查项。" />}
        </div>
      </section>
    </div>
  );
}

function hasTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function initialNavKey(): NavKey {
  if (typeof window === "undefined") return "dashboard";
  const view = new URLSearchParams(window.location.search).get("view");
  return isNavKey(view) ? view : "dashboard";
}

function initialTheme(): ThemeName {
  if (typeof window === "undefined") return "dark";
  const searchTheme = new URLSearchParams(window.location.search).get("theme");
  if (searchTheme === "light" || searchTheme === "dark") return searchTheme;
  const savedTheme = window.localStorage.getItem("ai-skillhub-theme");
  return savedTheme === "light" || savedTheme === "dark" ? savedTheme : "dark";
}

function isNavKey(value: string | null): value is NavKey {
  return navItems.some(item => item.key === value) || value === "settings";
}

function categoryTone(category: string): string {
  const value = category.toLowerCase();
  if (value.includes("design") || value.includes("ui") || category.includes("设计")) return "tone-tertiary";
  if (value.includes("research") || category.includes("科研") || category.includes("论文")) return "tone-primary";
  if (value.includes("security") || category.includes("安全")) return "tone-error";
  if (value.includes("development") || value.includes("dev") || category.includes("工程")) return "tone-secondary";
  return "tone-surface";
}

function skillIcon(category: string): string {
  const value = category.toLowerCase();
  if (value.includes("design") || value.includes("ui") || category.includes("设计")) return "✦";
  if (value.includes("research") || category.includes("科研") || category.includes("论文")) return "⌁";
  if (value.includes("figure") || category.includes("图")) return "◒";
  if (value.includes("security") || category.includes("安全")) return "△";
  if (value.includes("development") || value.includes("dev") || category.includes("工程")) return "⌘";
  return "✧";
}

function statusDotClass(health: string): string {
  if (health === "ok") return "healthy";
  if (health === "error") return "error";
  return "syncing";
}

function skillStatusLabel(health: string): string {
  if (health === "ok") return "Active";
  if (health === "warn") return "Review";
  if (health === "error") return "Failed";
  if (health === "info") return "Info";
  return health;
}

function sourceTypeLabel(sourceType: string): string {
  if (sourceType === "skill") return "Skill";
  if (sourceType === "prompt") return "Prompt";
  if (sourceType === "mixed") return "Mixed";
  return sourceType;
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
    snapshots: [
      {
        id: "preview-snapshot",
        name: "浏览器预览快照",
        summary: "48 skills, 9 sources, 3 agents",
        createdAt: new Date().toISOString(),
        isLatest: true
      }
    ],
    backupTargets: [
      {
        id: "preview-backup-claude",
        adapterId: "claude",
        agentName: "Claude / Claude Code",
        targetPath: "~\\.claude\\skills",
        backupPath: "../app-next/.skillhub-next/backups/claude/skills",
        detected: true,
        managed: true,
        required: true,
        preflightStatus: "required",
        riskLevel: "medium",
        blocker: "已接管目标目录；真实同步前必须先生成可恢复备份。"
      },
      {
        id: "preview-backup-codex",
        adapterId: "codex",
        agentName: "OpenAI Codex",
        targetPath: "~\\.codex\\skills",
        backupPath: "../app-next/.skillhub-next/backups/codex/skills",
        detected: true,
        managed: false,
        required: true,
        preflightStatus: "blocked",
        riskLevel: "medium",
        blocker: "检测到但尚未接管；真实同步前必须先完成备份和接管确认。"
      },
      {
        id: "preview-backup-antigravity",
        adapterId: "antigravity",
        agentName: "Antigravity",
        targetPath: "~\\.gemini\\antigravity\\skills",
        backupPath: "../app-next/.skillhub-next/backups/antigravity/skills",
        detected: false,
        managed: false,
        required: false,
        preflightStatus: "skipped",
        riskLevel: "low",
        blocker: "未检测到该工具；不会创建假目录，也不会执行接管写入。"
      }
    ],
    backupDryRun: [
      {
        id: "preview-backup-plan-claude",
        backupTargetId: "preview-backup-claude",
        adapterId: "claude",
        agentName: "Claude / Claude Code",
        action: "copy-to-backup",
        targetPath: "~\\.claude\\skills",
        backupPath: "../app-next/.skillhub-next/backups/claude/skills",
        status: "planned",
        riskLevel: "medium",
        summary: "真实同步前会先检查目标路径边界，再把目标目录复制到备份位置；当前仍只预演。"
      },
      {
        id: "preview-backup-plan-codex",
        backupTargetId: "preview-backup-codex",
        adapterId: "codex",
        agentName: "OpenAI Codex",
        action: "block-backup",
        targetPath: "~\\.codex\\skills",
        backupPath: "../app-next/.skillhub-next/backups/codex/skills",
        status: "blocked",
        riskLevel: "high",
        summary: "当前目标仍被阻断，备份预演只报告原因，不复制任何文件。"
      },
      {
        id: "preview-backup-plan-antigravity",
        backupTargetId: "preview-backup-antigravity",
        adapterId: "antigravity",
        agentName: "Antigravity",
        action: "skip",
        targetPath: "~\\.gemini\\antigravity\\skills",
        backupPath: "../app-next/.skillhub-next/backups/antigravity/skills",
        status: "skipped",
        riskLevel: "low",
        summary: "未检测到该工具，备份预演会跳过此目标，不创建备份目录。"
      }
    ],
    restoreDryRun: [
      {
        id: "preview-restore-claude",
        backupTargetId: "preview-backup-claude",
        adapterId: "claude",
        agentName: "Claude / Claude Code",
        action: "prepare-restore",
        targetPath: "~\\.claude\\skills",
        backupPath: "../app-next/.skillhub-next/backups/claude/skills",
        status: "planned",
        riskLevel: "medium",
        summary: "真实同步前会先生成备份；恢复预演会列出从备份位置还原到目标目录的计划。"
      },
      {
        id: "preview-restore-codex",
        backupTargetId: "preview-backup-codex",
        adapterId: "codex",
        agentName: "OpenAI Codex",
        action: "block-restore",
        targetPath: "~\\.codex\\skills",
        backupPath: "../app-next/.skillhub-next/backups/codex/skills",
        status: "blocked",
        riskLevel: "high",
        summary: "当前目标仍被阻断，恢复预演只能报告原因，不能进入真实恢复。"
      },
      {
        id: "preview-restore-antigravity",
        backupTargetId: "preview-backup-antigravity",
        adapterId: "antigravity",
        agentName: "Antigravity",
        action: "skip",
        targetPath: "~\\.gemini\\antigravity\\skills",
        backupPath: "../app-next/.skillhub-next/backups/antigravity/skills",
        status: "skipped",
        riskLevel: "low",
        summary: "未检测到该工具，恢复预演会跳过此目标，不创建目录、不写入文件。"
      }
    ],
    rollbackPlan: [
      {
        id: "preview-step-1",
        snapshotId: "preview-snapshot",
        stepOrder: 1,
        title: "冻结 v2 SQLite 基线",
        riskLevel: "low",
        status: "ready",
        summary: "预览模式已生成示例基线；真实数据请在 Tauri 桌面窗口查看。"
      },
      {
        id: "preview-step-2",
        snapshotId: "preview-snapshot",
        stepOrder: 2,
        title: "备份目标 AI 工具目录",
        riskLevel: "medium",
        status: "planned",
        summary: "真实同步前必须备份 Claude、Codex、Antigravity 等目标目录。"
      },
      {
        id: "preview-step-3",
        snapshotId: "preview-snapshot",
        stepOrder: 3,
        title: "真实回滚执行",
        riskLevel: "high",
        status: "locked",
        summary: "恢复按钮保持锁定，直到备份和 dry-run 通过。"
      }
    ],
    releaseReports: [
      {
        id: "diagnostics",
        title: "诊断包结果",
        reportType: "diagnostics",
        status: "ok",
        generatedAt: new Date().toISOString(),
        version: "v1.1.1",
        ok: true,
        total: 9,
        passed: 6,
        warn: 1,
        error: 0,
        summary: "诊断报告：6 ok / 1 warn / 0 error / 2 info。"
      },
      {
        id: "release-preflight",
        title: "发布预检",
        reportType: "release-preflight",
        status: "ok",
        generatedAt: new Date().toISOString(),
        version: "v1.1.1",
        ok: true,
        total: 12,
        passed: 12,
        warn: 0,
        error: 0,
        summary: "发布预检：12/12 项通过；当前包名 AI SkillHub.exe。"
      },
      {
        id: "share-recipient",
        title: "分享验收",
        reportType: "share-recipient-test",
        status: "ok",
        generatedAt: new Date().toISOString(),
        version: "v1.1.1",
        ok: true,
        total: 8,
        passed: 8,
        warn: 2,
        error: 1,
        summary: "分享验收：8/8 个场景按预期通过；含无 Codex、缺 Git/WebView2 等模拟场景。"
      },
      {
        id: "zip-preview",
        title: "zip 导入预览",
        reportType: "zip-preview-test",
        status: "ok",
        generatedAt: new Date().toISOString(),
        version: "",
        ok: true,
        total: 4,
        passed: 4,
        warn: 0,
        error: 0,
        summary: "zip 预览：2 个 Skill 可识别；路径穿越防护已通过。"
      }
    ],
    desktopQaChecks: [
      {
        id: "window-readable",
        title: "默认窗口完整可读",
        description: "侧边栏、主标题、指标卡和滚动条不能被裁切；默认窗口尺寸下必须能直接操作。",
        status: "passed",
        required: true,
        evidence: "",
        updatedAt: new Date().toISOString()
      },
      {
        id: "dpi-clarity",
        title: "高 DPI 清晰度",
        description: "真实 Tauri 桌面窗口里的中文、英文、数字和胶囊状态不能发虚，不能用浏览器预览代替。",
        status: "pending",
        required: true,
        evidence: "",
        updatedAt: new Date().toISOString()
      },
      {
        id: "release-gate-readable",
        title: "发布闸门可读",
        description: "诊断、发布预检、分享验收、zip 预览和桌面 QA 状态必须能被清楚读到。",
        status: "pending",
        required: true,
        evidence: "",
        updatedAt: new Date().toISOString()
      },
      {
        id: "snapshot-safety",
        title: "快照与恢复仍锁定",
        description: "备份、恢复和真实同步必须保持预演/锁定状态，不能出现误触发真实写入的入口。",
        status: "pending",
        required: true,
        evidence: "",
        updatedAt: new Date().toISOString()
      },
      {
        id: "release-build-guidance",
        title: "发布说明清楚",
        description: "用户必须能区分开发命令、调试 exe 和未来正式打包产物。",
        status: "pending",
        required: true,
        evidence: "",
        updatedAt: new Date().toISOString()
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

function updatePreviewDesktopQaStatus(
  snapshot: LegacySnapshot,
  id: string,
  status: "pending" | "passed" | "failed"
): LegacySnapshot {
  return {
    ...snapshot,
    desktopQaChecks: snapshot.desktopQaChecks.map(check =>
      check.id === id ? { ...check, status, updatedAt: new Date().toISOString() } : check
    )
  };
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

function riskLabel(riskLevel: string) {
  if (riskLevel === "low") return "低风险";
  if (riskLevel === "medium") return "中风险";
  if (riskLevel === "high") return "高风险";
  return riskLevel;
}

function stepStatusLabel(status: string) {
  if (status === "ready") return "已准备";
  if (status === "planned") return "待实现";
  if (status === "locked") return "已锁定";
  return status;
}

function backupStatusLabel(status: string) {
  if (status === "ready") return "已备份";
  if (status === "required") return "必须备份";
  if (status === "blocked") return "已阻断";
  if (status === "skipped") return "暂不处理";
  return status;
}

function dryRunStatusLabel(status: string) {
  if (status === "ready") return "可恢复";
  if (status === "planned") return "预演中";
  if (status === "blocked") return "已阻断";
  if (status === "skipped") return "跳过";
  return status;
}

function backupActionLabel(action: string) {
  if (action === "copy-to-backup") return "复制到备份位置";
  if (action === "verify-backup") return "校验已有备份";
  if (action === "block-backup") return "阻断真实备份";
  if (action === "skip") return "跳过未检测工具";
  return action;
}

function restoreActionLabel(action: string) {
  if (action === "prepare-restore") return "等待备份后才能恢复";
  if (action === "restore-from-backup") return "从备份恢复";
  if (action === "block-restore") return "阻断真实恢复";
  if (action === "skip") return "跳过未检测工具";
  return action;
}

function releaseReportGateStatus(report?: ReleaseReportCard) {
  if (!report) return "planned";
  if (report.ok && report.status === "ok") return "done";
  if (report.status === "warn") return "planned";
  return "blocked";
}

function releaseReportGateLabel(report?: ReleaseReportCard) {
  if (!report) return "待接入";
  if (report.ok && report.status === "ok") return "已通过";
  if (report.status === "warn") return "需复查";
  return "已阻断";
}

function releaseReadinessReason(items: Array<{ status: string; title: string; label: string }>) {
  const blocked = items.find(item => item.status === "blocked");
  if (blocked) {
    return `因为“${blocked.title}”仍处于${blocked.label}状态，不能生成可分享版本。`;
  }

  const planned = items.find(item => item.status === "planned");
  if (planned) {
    return `因为“${planned.title}”仍处于${planned.label}状态，需要复查后再考虑候选打包。`;
  }

  return "所有发布闸门已通过，可以进入候选打包复查；此页面仍不会直接执行打包。";
}

function desktopQaGateStatus(checks: DesktopQaCheckCard[]) {
  if (checks.length === 0) return "planned";
  if (checks.some(check => check.required && check.status === "failed")) return "blocked";
  if (checks.filter(check => check.required).every(check => check.status === "passed")) return "done";
  return "planned";
}

function desktopQaGateLabel(checks: DesktopQaCheckCard[]) {
  const status = desktopQaGateStatus(checks);
  if (status === "done") return "已通过";
  if (status === "blocked") return "已阻断";
  return "待复查";
}

function desktopQaGateSummary(checks: DesktopQaCheckCard[]) {
  if (checks.length === 0) return "还没有生成桌面 QA 检查项。";
  const required = checks.filter(check => check.required);
  const passed = required.filter(check => check.status === "passed").length;
  const failed = required.filter(check => check.status === "failed").length;
  const pending = required.length - passed - failed;
  return `桌面 QA：${passed}/${required.length} 项通过，${pending} 项待检查，${failed} 项失败。`;
}

function qaStatusClass(status: string) {
  if (status === "passed") return "done";
  if (status === "failed") return "blocked";
  return "planned";
}

function qaStatusLabel(status: string) {
  if (status === "passed") return "已通过";
  if (status === "failed") return "未通过";
  return "待检查";
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

function countByStatus(items: Array<{ status: string }>, status: string) {
  return items.filter(item => item.status === status).length;
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

function Metric({
  accent = "violet",
  icon,
  label,
  trend,
  value
}: {
  accent?: string;
  icon?: string;
  label: string;
  trend?: string;
  value: number;
}) {
  return (
    <article className={`metric metric-${accent}`}>
      <div>
        <span>{label}</span>
        {icon && <em aria-hidden="true">{icon}</em>}
      </div>
      <strong>{value.toLocaleString()}</strong>
      {trend && <small>{trend}</small>}
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
