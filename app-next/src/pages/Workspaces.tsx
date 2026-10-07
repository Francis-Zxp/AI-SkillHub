// Workspaces page. Split out of App.tsx;
// App() still owns the shared state and handlers. Never import from App.tsx here (use appShared.ts).
import { useEffect, useState } from "react";
import { Icon } from "../icons";
import { t } from "../i18n";
import type { LegacySnapshot, WorkspaceCard } from "../types";
import { formatScanTime } from "../appShared";
import { ToggleSwitch, ScanFlag } from "../components/ui";

/* =============================================================
   Workspaces / Presets / Agents views
   ============================================================= */

export function Workspaces({
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
  const [selectedId, setSelectedId] = useState("");

  useEffect(() => {
    if (workspaces.length === 0) {
      if (selectedId) setSelectedId("");
      return;
    }
    if (!workspaces.some(workspace => workspace.id === selectedId)) {
      setSelectedId(workspaces[0].id);
    }
  }, [workspaces, selectedId]);

  const selected = workspaces.find(workspace => workspace.id === selectedId) ?? workspaces[0];
  const selectedScan = selected ? projectScans.find(scan => scan.workspaceId === selected.id) : undefined;

  return (
    <div className="view workspaces-view">
      <section className="page-header glow-card">
        <div>
          <span className="eyebrow"><Icon name="workspaces" /> {t("nav.workspaces")}</span>
          <h2>{t("ws.title")}</h2>
          <p>{t("ws.subtitle")}</p>
        </div>
      </section>

      <div className="workspace-grid">
        {workspaces.map(workspace => (
          <article
            className={`workspace-card glow-card${workspace.id === selected?.id ? " selected" : ""}`}
            key={workspace.id}
          >
            <header>
              <strong>{workspace.name}</strong>
              <span className={`scope-pill ${workspace.scope}`}>{scopeLabel(workspace.scope)}</span>
            </header>
            <p>{workspace.path}</p>
            <div className="workspace-stats">
              <span>
                <b>{workspace.agentCount}</b>
                <small>{t("ws.aiTools")}</small>
              </span>
              <span>
                <b>{workspace.skillCount}</b>
                <small>{t("ws.skillsLabel")}</small>
              </span>
            </div>
            <footer>
              <button className="ghost-action" onClick={() => setSelectedId(workspace.id)} type="button">
                {t("ws.viewDetail")}
              </button>
              <ToggleSwitch
                disabled={disabled}
                enabled={workspace.enabled}
                label={workspace.enabled ? t("common.enabled") : t("common.disabled")}
                onClick={() => onToggle("set_workspace_enabled", workspace.id, !workspace.enabled)}
              />
            </footer>
          </article>
        ))}
        {workspaces.length === 0 && <p className="empty-state">{t("ws.empty")}</p>}
      </div>

      {selected && (
        <WorkspaceDetailPanel projectScan={selectedScan} workspace={selected} />
      )}

      <section className="panel glow-card">
        <header className="panel-head">
          <div>
            <span className="eyebrow">{t("ws.scannerEyebrow")}</span>
            <h3>{t("ws.scannerTitle")}</h3>
          </div>
        </header>
        <div className="project-scan-list">
          {projectScans.map(scan => (
            <article className="project-card" key={scan.id}>
              <header>
                <div>
                  <strong>{scan.path}</strong>
                  <span>{t("ws.files", { n: scan.fileCount })} · {t("ws.lastScan", { time: formatScanTime(scan.scannedAt) })}</span>
                </div>
                <span className="scope-pill project">{t("ws.readonly")}</span>
              </header>
              <div className="scan-flags">
                <ScanFlag enabled={scan.hasGit} label="Git" />
                <ScanFlag enabled={scan.hasPackageJson} label="package.json" />
                <ScanFlag enabled={scan.hasCargoToml} label="Cargo.toml" />
                <ScanFlag enabled={scan.hasTauriConfig} label="Tauri" />
                <ScanFlag enabled={scan.hasAgentsMd} label="AGENTS.md" />
                <ScanFlag enabled={scan.hasClaudeMd} label="CLAUDE.md" />
                <ScanFlag enabled={scan.hasReadmeMd} label="README.md" />
              </div>
            </article>
          ))}
          {projectScans.length === 0 && <p>{t("ws.noProjects")}</p>}
        </div>
      </section>
    </div>
  );
}

function WorkspaceDetailPanel({
  projectScan,
  workspace
}: {
  projectScan?: { path: string };
  workspace: WorkspaceCard;
}) {
  const isProject = workspace.scope === "project";
  return (
    <section className="panel glow-card workspace-detail-panel">
      <header className="panel-head">
        <div>
          <span className="eyebrow">{t("ws.detailEyebrow")}</span>
          <h3>{workspace.name}</h3>
          <span>{workspace.path}</span>
        </div>
        <span className={`scope-pill ${workspace.scope}`}>{scopeLabel(workspace.scope)}</span>
      </header>
      <div className="workspace-detail-metrics">
        <article>
          <span>{t("ws.scope")}</span>
          <strong>{scopeLabel(workspace.scope)}</strong>
        </article>
        <article>
          <span>{t("ws.aiTools")}</span>
          <strong>{workspace.agentCount}</strong>
        </article>
        <article>
          <span>{t("ws.skillsLabel")}</span>
          <strong>{workspace.skillCount}</strong>
        </article>
        <article>
          <span>{t("ws.state")}</span>
          <strong>{workspace.enabled ? t("common.enabled") : t("common.disabled")}</strong>
        </article>
      </div>
      <p className="workspace-detail-note">
        {isProject
          ? projectScan
            ? `${projectScan.path}`
            : t("ws.scanWaitingBody")
          : t("ws.readonlyDetailBody")}
      </p>
    </section>
  );
}

function scopeLabel(scope: string) {
  if (scope === "global") return t("scope.global");
  if (scope === "agent") return t("scope.agent");
  if (scope === "project") return t("scope.project");
  return scope;
}
