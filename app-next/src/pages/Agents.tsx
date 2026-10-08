// AI 工具 page (skills contract §6.5, S0-3 / S0-10 / S0-11). Cards come first: one status
// word, one takeover switch, one path line and a ⋯ menu. Each tool has a detail view with
// 技能 (everything really in its folder, with 纳入管理), MCP and 诊断 tabs.
// App owns the state; never import from App.tsx here.
import { Suspense, lazy, useEffect, useMemo, useState } from "react";
import { Icon } from "../icons";
import { getLang, t } from "../i18n";
import {
  adoptExternalSkills,
  createOperationId,
  listAgentSkills,
  previewAdoptExternalSkills,
  type ImportProgress
} from "../skillApi";
import { normalizeSkillHubError, skillHubErrorText } from "../skillErrors";
import { agentAfterSyncHint, agentExperimentalReason, agentSharedNote, agentUnsupportedReason, problemText } from "../agentText";
import type {
  AdoptCandidate,
  AdoptReport,
  AgentSkillEntry,
  AgentSkillInventory,
  DeliveryProblem,
  ErrorAction,
  LegacySnapshot,
  SkillAgent,
  SkillDeliveryState,
  SkillHubError
} from "../types";
import { DeferredSurface, Dialog, MoreMenu, ToggleSwitch } from "../components/ui";
import { AgentGlyph } from "../components/shell";
import "./agents.css";

const CodexPluginDoctorPanel = lazy(() =>
  import("../CodexPluginDoctorPanel").then(module => ({ default: module.CodexPluginDoctorPanel }))
);

type DetailTab = "skills" | "mcp" | "diagnostics";

/** Shows the home folder as "~". Windows paths may use / or \, any drive and letter case, and the
 *  extended-length prefix \\?\ that some tools report. */
export function displayPath(path: string) {
  return path
    .replace(/^\\\\\?\\(?=[A-Za-z]:)/, "")
    .replace(/^[A-Za-z]:[\\/]Users[\\/][^\\/]+/i, "~")
    .replace(/^\/(?:home|Users)\/[^/]+/, "~");
}

export function Agents({
  agentDetailId,
  delivery,
  onAdopted,
  onDetect,
  onOpenAgent,
  onOpenFolder,
  onOpenLibraryRow,
  onOpenMcp,
  onProblemAction,
  onRemoveLeftovers,
  onSyncNow,
  onTakeover,
  refreshing,
  runtimeAvailable,
  snapshot
}: {
  agentDetailId: string | null;
  delivery: SkillDeliveryState | null;
  onAdopted: (report: AdoptReport) => void;
  onDetect: () => void;
  onOpenAgent: (agentId: string | null) => void;
  onOpenFolder: (agentId: string) => void;
  onOpenLibraryRow: (key: string) => void;
  onOpenMcp: () => void;
  /** Runs the action that comes with a tool's problem (重试, 打开文件夹, 查看冲突 …). */
  onProblemAction: (action: ErrorAction, problem: DeliveryProblem) => void;
  /** Removes entries SkillHub left in a tool that is no longer installed (orphans). */
  onRemoveLeftovers: (agentId: string) => void;
  onSyncNow: () => void;
  onTakeover: (agent: SkillAgent, enabled: boolean) => void;
  refreshing: boolean;
  runtimeAvailable: boolean;
  snapshot: LegacySnapshot | null;
}) {
  const agents = delivery?.agents ?? [];
  const detail = agentDetailId ? agents.find(agent => agent.id === agentDetailId) ?? null : null;
  if (detail) {
    return (
      <AgentDetail
        agent={detail}
        delivery={delivery!}
        onAdopted={onAdopted}
        onBack={() => onOpenAgent(null)}
        onOpenFolder={onOpenFolder}
        onOpenLibraryRow={onOpenLibraryRow}
        onOpenMcp={onOpenMcp}
        onTakeover={onTakeover}
        runtimeAvailable={runtimeAvailable}
        snapshot={snapshot}
      />
    );
  }
  const primary = agents.filter(agent => agent.statusWord === "taken-over" || agent.statusWord === "available");
  const others = agents.filter(agent => agent.statusWord === "unsupported" || agent.statusWord === "not-installed");
  const busy = Boolean(delivery?.job && ["queued", "waiting", "running"].includes(delivery.job.phase));
  return (
    <div className="view agents-view agents-v33" data-testid="agents-page">
      <header className="page-head-row">
        <h2>{t("nav.agents")}</h2>
        <div className="page-head-actions">
          <button className="ghost-action" data-testid="agents-detect" disabled={refreshing} onClick={onDetect} type="button">
            <Icon className={refreshing ? "icon-spin" : ""} name="search" /> {refreshing ? t("v33.detecting") : t("v33.detectTools")}
          </button>
          <button className="primary-action" data-testid="agents-sync-now" disabled={!delivery || delivery.paused} onClick={onSyncNow} title={delivery?.paused ? t("sync.paused") : undefined} type="button">
            <Icon className={busy ? "icon-spin" : ""} name="sync" /> {busy ? t("sync.busy") : t("v33.syncNow")}
          </button>
        </div>
      </header>

      {!delivery ? (
        <DeferredSurface label={t("v33.readingTools")} />
      ) : (
        <>
          <div className="agent-cards">
            {primary.map(agent => (
              <AgentCardView
                agent={agent}
                agents={agents}
                delivery={delivery}
                key={agent.id}
                unitName={unitId => snapshot?.sources.find(source => source.id === unitId)?.name
                  ?? delivery.units.find(unit => unit.unitId === unitId)?.entryName ?? ""}
                onOpen={() => onOpenAgent(agent.id)}
                onOpenFolder={() => onOpenFolder(agent.id)}
                onProblemAction={onProblemAction}
                onTakeover={enabled => onTakeover(agent, enabled)}
              />
            ))}
            {primary.length === 0 && <p className="muted">{t("v33.noToolsFound")}</p>}
          </div>
          {others.length > 0 && (
            <details className="agent-others" data-testid="agent-others">
              <summary>{t("v33.otherTools", { n: others.length })}</summary>
              <ul>
                {others.map(agent => (
                  <li data-testid={`agent-card-${agent.id}`} key={agent.id}>
                    <AgentGlyph agentId={agent.id} name={agent.name} />
                    <strong>{agent.name}</strong>
                    <span className="chip">{t(`v33.word.${agent.statusWord}`)}</span>
                    <small>{agent.statusWord === "unsupported" ? agentUnsupportedReason(agent.unsupportedReason) : t("v33.notInstalledReason")}</small>
                    {(() => {
                      const leftovers = delivery.targets.filter(target => target.agentId === agent.id && target.status === "orphan").length;
                      return leftovers > 0 ? (
                        <button className="ghost-action small" data-testid={`remove-leftovers-${agent.id}`} onClick={() => onRemoveLeftovers(agent.id)} type="button">
                          {t("v33.removeLeftovers", { n: leftovers })}
                        </button>
                      ) : null;
                    })()}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </div>
  );
}

function AgentCardView({
  agent,
  agents,
  delivery,
  onOpen,
  onOpenFolder,
  onProblemAction,
  onTakeover,
  unitName
}: {
  agent: SkillAgent;
  agents: SkillAgent[];
  delivery: SkillDeliveryState;
  onOpen: () => void;
  onOpenFolder: () => void;
  onProblemAction: (action: ErrorAction, problem: DeliveryProblem) => void;
  onTakeover: (enabled: boolean) => void;
  unitName: (unitId: string) => string;
}) {
  const problem = delivery.problems.find(item => item.agentId === agent.id);
  const sharedNote = agentSharedNote(agent, agents);
  const experimentalReason = agentExperimentalReason(agent);
  const afterSyncHint = agentAfterSyncHint(agent);
  const switchable = agent.canDeliver && agent.installed;
  return (
    <article className={`agent-card glow-card status-${agent.statusWord}`} data-testid={`agent-card-${agent.id}`}>
      <AgentGlyph agentId={agent.id} name={agent.name} size="lg" />
      <div className="agent-card-main">
        <header>
          <button className="agent-name" onClick={onOpen} type="button">{agent.name}</button>
          <span className={`chip word-${agent.statusWord}`}>{t(`v33.word.${agent.statusWord}`)}</span>
          {agent.experimental && <span className="chip chip-experimental" title={experimentalReason}>{t("v33.experimental")}</span>}
          {sharedNote && (
            <span className="chip chip-linked" title={sharedNote}>
              <Icon name="link" /> {sharedNote}
            </span>
          )}
        </header>
        <p className="agent-counts">
          {t("v33.agentCounts", { skills: agent.counts.skillsSynced, packs: agent.counts.packsSynced })}
          {agent.counts.personal !== null && agent.counts.personal > 0 && <> · {t("v33.agentPersonal", { n: agent.counts.personal })}</>}
        </p>
        {agent.skillsPath && <code className="agent-path" title={agent.skillsPath}>{displayPath(agent.skillsPath)}</code>}
        {experimentalReason && <small className="muted">{experimentalReason}</small>}
        {afterSyncHint && <small className="agent-hint"><Icon name="info" /> {afterSyncHint}</small>}
        {agent.health === "problem" && problem && (
          <small className="agent-problem">
            <Icon name="alert" />
            <span>
              {problemText(problem, agents, unitName, false)}
              {problem.action && (
                <button className="link-action" data-testid={`agent-problem-action-${agent.id}`} onClick={() => onProblemAction(problem.action!, problem)} type="button">
                  {t(`err.action.${problem.action.kind}`)}
                </button>
              )}
            </span>
          </small>
        )}
      </div>
      <div className="agent-card-side">
        <ToggleSwitch
          disabled={!switchable}
          enabled={agent.takeover}
          label={agent.takeover ? t("v33.takenOverLabel", { tool: agent.name }) : t("v33.takeoverLabel", { tool: agent.name })}
          onClick={() => onTakeover(!agent.takeover)}
          showLabel={false}
          testId={`agent-takeover-${agent.id}`}
        />
        <MoreMenu
          items={[
            { key: "open", label: t("v33.openDetails"), onSelect: onOpen, icon: "info" },
            { key: "folder", label: t("v33.openFolder"), onSelect: onOpenFolder, disabled: !agent.skillsPath, icon: "folder" },
            { key: "diag", label: t("v33.diagnostics"), onSelect: onOpen, icon: "shield" }
          ]}
          label={t("v33.toolMenu", { tool: agent.name })}
        />
      </div>
    </article>
  );
}

/* =============================================================
   Agent detail: 技能 · MCP · 诊断
   ============================================================= */

function AgentDetail({
  agent,
  delivery,
  onAdopted,
  onBack,
  onOpenFolder,
  onOpenLibraryRow,
  onOpenMcp,
  onTakeover,
  runtimeAvailable,
  snapshot
}: {
  agent: SkillAgent;
  delivery: SkillDeliveryState;
  onAdopted: (report: AdoptReport) => void;
  onBack: () => void;
  onOpenFolder: (agentId: string) => void;
  onOpenLibraryRow: (key: string) => void;
  onOpenMcp: () => void;
  onTakeover: (agent: SkillAgent, enabled: boolean) => void;
  runtimeAvailable: boolean;
  snapshot: LegacySnapshot | null;
}) {
  const [tab, setTab] = useState<DetailTab>("skills");
  const sharedNote = agentSharedNote(agent, delivery.agents);
  return (
    <div className="view agents-view agent-detail" data-testid={`agent-detail-${agent.id}`}>
      <button className="link-action back-link" onClick={onBack} type="button"><Icon name="chevron" className="rotate-180" /> {t("nav.agents")}</button>
      <header className="agent-detail-head">
        <AgentGlyph agentId={agent.id} name={agent.name} size="lg" />
        <div>
          <h2>{agent.name}</h2>
          <span className={`chip word-${agent.statusWord}`}>{t(`v33.word.${agent.statusWord}`)}</span>
          {sharedNote && <span className="chip chip-linked"><Icon name="link" /> {sharedNote}</span>}
          {agent.skillsPath && <code className="agent-path">{displayPath(agent.skillsPath)}</code>}
        </div>
        <ToggleSwitch
          disabled={!(agent.canDeliver && agent.installed)}
          enabled={agent.takeover}
          label={agent.takeover ? t("v33.takenOverLabel", { tool: agent.name }) : t("v33.takeoverLabel", { tool: agent.name })}
          onClick={() => onTakeover(agent, !agent.takeover)}
          testId={`agent-takeover-${agent.id}`}
        />
      </header>
      <div className="drawer-tabs" role="tablist">
        {(["skills", "mcp", "diagnostics"] as DetailTab[]).map(key => (
          <button aria-selected={tab === key} className={tab === key ? "active" : ""} data-testid={`agent-tab-${key}`} key={key} onClick={() => setTab(key)} role="tab" type="button">
            {key === "skills" ? t("v33.tabSkillsPlain") : key === "mcp" ? "MCP" : t("v33.diagnostics")}
          </button>
        ))}
      </div>
      {tab === "skills" && (
        <AgentSkillsTab agent={agent} delivery={delivery} onAdopted={onAdopted} onOpenFolder={() => onOpenFolder(agent.id)} onOpenLibraryRow={onOpenLibraryRow} />
      )}
      {tab === "mcp" && (
        <section className="panel glow-card agent-mcp-tab">
          <p>{t("v33.agentMcpBody", { tool: agent.name })}</p>
          <button className="primary-action small" onClick={onOpenMcp} type="button"><Icon name="plug" /> {t("v33.openMcp")}</button>
        </section>
      )}
      {tab === "diagnostics" && (
        <DiagnosticsTab agent={agent} runtimeAvailable={runtimeAvailable} snapshot={snapshot} />
      )}
    </div>
  );
}

function AgentSkillsTab({
  agent,
  delivery,
  onAdopted,
  onOpenFolder,
  onOpenLibraryRow
}: {
  agent: SkillAgent;
  delivery: SkillDeliveryState;
  onAdopted: (report: AdoptReport) => void;
  onOpenFolder: () => void;
  onOpenLibraryRow: (key: string) => void;
}) {
  const [inventory, setInventory] = useState<AgentSkillInventory | null>(null);
  const [error, setError] = useState<SkillHubError | null>(null);
  const [adopt, setAdopt] = useState<{ candidates: AdoptCandidate[]; only: string[] | null } | null>(null);
  const [loadingAdopt, setLoadingAdopt] = useState(false);
  const [reload, setReload] = useState(0);
  const jobPhase = delivery.job?.phase ?? "";

  useEffect(() => {
    let cancelled = false;
    setError(null);
    void listAgentSkills(agent.id)
      .then(result => {
        if (!cancelled) setInventory(result);
      })
      .catch(reason => {
        if (!cancelled) setError(normalizeSkillHubError(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [agent.id, reload, jobPhase === "done"]);

  const groups = useMemo(() => {
    const entries = inventory?.entries ?? [];
    return {
      managed: entries.filter(entry => entry.state === "managed"),
      personal: entries.filter(entry => entry.state === "personal"),
      problems: entries.filter(entry => entry.state === "stale" || entry.state === "conflict" || entry.state === "invalid")
    };
  }, [inventory]);

  async function openAdopt(only: AgentSkillEntry | null) {
    setLoadingAdopt(true);
    try {
      const preview = await previewAdoptExternalSkills();
      const relevant = preview.candidates.filter(candidate =>
        candidate.agentIds.includes(agent.id) || candidate.locations.some(location => location.agentId === agent.id)
      );
      setAdopt({ candidates: relevant, only: only ? [only.adoptCandidateId] : null });
    } catch (reason) {
      setError(normalizeSkillHubError(reason));
    } finally {
      setLoadingAdopt(false);
    }
  }

  if (error) {
    return (
      <section className="status-banner error" role="alert">
        <Icon name="alert" />
        <div><strong>{skillHubErrorText(error, t)}</strong></div>
        <button className="ghost-action small" onClick={() => setReload(value => value + 1)} type="button">{t("err.action.retry")}</button>
      </section>
    );
  }
  if (!inventory) return <DeferredSurface label={t("v33.readingFolder")} />;

  return (
    <div className="agent-skill-groups" data-testid="agent-skills-tab">
      <section className="agent-skill-group">
        <header><strong>{t("v33.groupManaged", { n: groups.managed.length })}</strong></header>
        {groups.managed.length === 0 ? <p className="muted">{t("v33.groupManagedEmpty")}</p> : (
          <ul>
            {groups.managed.slice(0, 200).map(entry => (
              <li key={entry.path}>
                <button className="link-action" onClick={() => entry.unitId && onOpenLibraryRow(entry.unitId)} type="button">{entry.name}</button>
                <small>{entry.description}</small>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="agent-skill-group">
        <header>
          <strong>{t("v33.groupPersonal", { n: groups.personal.length })}</strong>
          {groups.personal.length > 0 && (
            <button className="primary-action small" data-testid="adopt-all" disabled={loadingAdopt} onClick={() => void openAdopt(null)} type="button">
              {t("v33.adoptAll", { n: groups.personal.length })}
            </button>
          )}
        </header>
        {groups.personal.length === 0 ? <p className="muted">{t("v33.groupPersonalEmpty")}</p> : (
          <ul>
            {groups.personal.slice(0, 200).map(entry => (
              <li key={entry.path}>
                <span><strong>{entry.name}</strong><small>{entry.description}</small></span>
                <button className="ghost-action small" disabled={loadingAdopt || !entry.adoptCandidateId} onClick={() => void openAdopt(entry)} type="button">{t("v33.adoptOne")}</button>
              </li>
            ))}
          </ul>
        )}
      </section>
      {groups.problems.length > 0 && (
        <section className="agent-skill-group problems">
          <header>
            <strong>{t("v33.groupProblems", { n: groups.problems.length })}</strong>
            <button className="ghost-action small" onClick={onOpenFolder} type="button">{t("v33.openFolder")}</button>
          </header>
          <ul>
            {groups.problems.map(entry => (
              <li key={entry.path}>
                <span><strong>{entry.name}</strong><small>{t(`v33.entry.${entry.state}`)}</small></span>
                <code>{displayPath(entry.path)}</code>
              </li>
            ))}
          </ul>
        </section>
      )}
      {adopt && (
        <AdoptSheet
          agents={delivery.agents}
          candidates={adopt.candidates}
          only={adopt.only}
          onClose={() => setAdopt(null)}
          onDone={report => {
            onAdopted(report);
            setReload(value => value + 1);
          }}
        />
      )}
    </div>
  );
}

function AdoptSheet({
  agents,
  candidates,
  only,
  onClose,
  onDone
}: {
  agents: SkillAgent[];
  candidates: AdoptCandidate[];
  only: string[] | null;
  onClose: () => void;
  onDone: (report: AdoptReport) => void;
}) {
  const visible = only ? candidates.filter(candidate => only.includes(candidate.id)) : candidates;
  const duplicates = visible.filter(candidate => candidate.state === "duplicate");
  const listed = visible.filter(candidate => candidate.state !== "duplicate");
  const [checked, setChecked] = useState<ReadonlySet<string>>(() => new Set(listed.filter(candidate => candidate.selectedByDefault || (only && candidate.state === "new")).map(candidate => candidate.id)));
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [report, setReport] = useState<AdoptReport | null>(null);
  const [error, setError] = useState<SkillHubError | null>(null);
  const running = progress !== null && !report;
  // Plain tool names ("Codex"), never internal ids such as "codex-legacy"; one name per tool.
  const toolNames = (ids: string[]) => Array.from(new Set(ids.map(id => {
    const base = id.endsWith("-legacy") ? id.slice(0, -"-legacy".length) : id;
    return agents.find(agent => agent.id === id || agent.id === base)?.name ?? base;
  }))).join(getLang() === "zh" ? "、" : ", ");

  async function run() {
    const ids = [...checked];
    if (ids.length === 0) return;
    setError(null);
    setProgress({ operationId: "", stage: "adopt", state: "started", message: "", current: 0, total: ids.length });
    try {
      const result = await adoptExternalSkills(ids, createOperationId("adopt"), event => setProgress(event));
      setReport(result);
      onDone(result);
    } catch (reason) {
      setProgress(null);
      setError(normalizeSkillHubError(reason));
    }
  }

  return (
    <Dialog
      className="adopt-sheet"
      footer={report ? (
        <button className="primary-action" data-autofocus="" onClick={onClose} type="button">{t("common.close")}</button>
      ) : (
        <>
          <button className="secondary-action" disabled={running} onClick={onClose} type="button">{t("common.cancel")}</button>
          <button className="primary-action" data-testid="adopt-confirm" disabled={running || checked.size === 0} onClick={() => void run()} type="button">
            {running ? t("v33.adoptRunning", { current: progress?.current ?? 0, total: progress?.total ?? checked.size }) : t("v33.adoptConfirm", { n: checked.size })}
          </button>
        </>
      )}
      onClose={() => { if (!running) onClose(); }}
      testId="adopt-sheet"
      title={t("v33.adoptTitle", { n: checked.size })}
    >
      {report ? (
        <div className="adopt-report" data-testid="adopt-report" data-adopted={report.adopted}>
          <p className="dialog-text strong">{t("v33.adoptResult", { a: report.adopted, b: report.libraryOnly, c: report.failed })}</p>
          <ul>
            {report.results.map(item => (
              <li className={`outcome-${item.outcome}`} key={item.candidateId}>
                <strong>{item.name}</strong>
                <span>{t(`v33.adoptOutcome.${item.outcome}`)}</span>
                {item.error && <small>{skillHubErrorText(item.error, t)}</small>}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <>
          {error && <p className="import-notice error"><Icon name="alert" /> {skillHubErrorText(error, t)}</p>}
          <ul className="adopt-list">
            {listed.map(candidate => {
              const selectable = candidate.state === "new";
              return (
                <li className={`state-${candidate.state}`} key={candidate.id}>
                  <label>
                    <input
                      checked={checked.has(candidate.id)}
                      disabled={!selectable || running}
                      onChange={() => setChecked(current => {
                        const next = new Set(current);
                        if (next.has(candidate.id)) next.delete(candidate.id);
                        else next.add(candidate.id);
                        return next;
                      })}
                      type="checkbox"
                    />
                    <span>
                      <strong>{candidate.name}</strong>
                      <small>{t("v33.adoptFrom", { tools: toolNames(candidate.agentIds) || "—" })}</small>
                    </span>
                    {candidate.state !== "new" && <em className="chip">{t(`v33.adoptState.${candidate.state}`)}</em>}
                  </label>
                </li>
              );
            })}
          </ul>
          {duplicates.length > 0 && <p className="muted">{t("v33.adoptDuplicates", { n: duplicates.length })}</p>}
          <p className="muted">{t("v33.adoptNote")}</p>
        </>
      )}
    </Dialog>
  );
}

function DiagnosticsTab({ agent, runtimeAvailable, snapshot }: { agent: SkillAgent; runtimeAvailable: boolean; snapshot: LegacySnapshot | null }) {
  const doctor = snapshot?.agentDoctors.find(item => item.adapterId === agent.id);
  return (
    <div className="agent-diagnostics" data-testid="agent-diagnostics">
      {doctor ? (
        <section className={`panel glow-card adapter-doctor verdict-${doctor.verdict}`}>
          <header>
            <strong>{doctorVerdictLabel(doctor.verdict)}</strong>
          </header>
          <p>{doctor.summary}</p>
          <dl>
            <div><dt>{t("doctor.desktop")}</dt><dd className={`doctor-state state-${doctor.desktopStatus}`}>{doctorStatusLabel(doctor.desktopStatus)}</dd></div>
            <div><dt>{t("doctor.cli")}</dt><dd className={`doctor-state state-${doctor.cliStatus}`}>{doctorStatusLabel(doctor.cliStatus)}</dd></div>
            <div><dt>{t("doctor.skills")}</dt><dd className={`doctor-state state-${doctor.skillsStatus}`}>{doctorStatusLabel(doctor.skillsStatus)}</dd></div>
          </dl>
          {(doctor.evidence.length > 0 || doctor.nextSteps.length > 0) && (
            <details open>
              <summary>{t("doctor.evidence")}</summary>
              <ul>
                {doctor.evidence.slice(0, 8).map((item, index) => (
                  <li className={`doctor-evidence status-${item.status}`} key={`${item.probeKind}-${item.label}-${index}`}>
                    <strong>{item.label}</strong>
                    <span>{item.detail}{item.path ? ` · ${displayPath(item.path)}` : ""}</span>
                  </li>
                ))}
                {doctor.nextSteps.map((step, index) => <li className="doctor-next-step" key={`next-${index}`}>{step}</li>)}
              </ul>
            </details>
          )}
        </section>
      ) : (
        <p className="muted">{agent.installed ? t("v33.noDiagnostics") : t("v33.notInstalledReason")}</p>
      )}
      {agent.id === "codex" && (
        <Suspense fallback={<DeferredSurface label={t("pluginDoctor.scanning")} />}>
          <CodexPluginDoctorPanel runtimeAvailable={runtimeAvailable} />
        </Suspense>
      )}
    </div>
  );
}

function doctorVerdictLabel(verdict: string) {
  if (verdict === "ready") return t("doctor.ready");
  if (verdict === "code-detected") return t("doctor.codeDetected");
  if (verdict === "desktop-only") return t("doctor.desktopOnly");
  if (verdict === "path-refresh-needed") return t("doctor.pathRefresh");
  if (verdict === "directory-residue") return t("doctor.directoryResidue");
  return t("doctor.notDetected");
}

function doctorStatusLabel(status: string) {
  const key = `doctor.status.${status}`;
  const translated = t(key);
  return translated === key ? status : translated;
}
