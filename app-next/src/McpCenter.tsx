import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Icon } from "./icons";
import { mt as t } from "./mcpManagementI18n";
import { containsObviousCredentialValue, evaluateMcpBindingManagement, mcpServerNameCompatible } from "./mcpManagement";
import type { McpManagementBlockReason } from "./mcpManagement";
import "./McpCenter.css";

export type McpHostCard = {
  id: string;
  adapterKey: string;
  displayName: string;
  detected: boolean;
  configCount: number;
};

export type McpSecretRequirement = {
  id: string;
  bindingId: string;
  keyName: string;
  useKind: string;
  presenceState: "present" | "missing" | "inline-value-present" | "unknown" | string;
};

export type McpBindingCard = {
  id: string;
  serverId: string;
  hostId: string;
  configLocationId: string;
  workspaceId?: string | null;
  nativeName: string;
  nativeScope: string;
  configPath: string;
  enabled: boolean;
  effectiveState: string;
  approvalState: string;
  authKind: string;
  required: boolean;
};

export type McpServerCard = {
  id: string;
  displayName: string;
  transport: string;
  targetKind: string;
  targetDisplayRedacted: string;
  provenanceKind: string;
  provenanceRef: string;
  versionHint?: string | null;
  capabilityState: "unprobed" | string;
};

export type McpFindingCard = {
  id: string;
  severity: "info" | "warn" | "error" | string;
  code: string;
  title: string;
  message: string;
  hostId: string;
  configLocationId?: string | null;
  pathDisplay?: string | null;
};

export type McpConfigLocation = {
  id: string;
  hostId: string;
  workspaceId?: string | null;
  nativeScope: string;
  pathDisplay: string;
  parseStatus: string;
  precedenceRank: number;
};

export type McpInventory = {
  generatedAtUnixMs: number;
  capabilityState: "unprobed" | string;
  hosts: McpHostCard[];
  configLocations: McpConfigLocation[];
  servers: McpServerCard[];
  bindings: McpBindingCard[];
  secretRequirements: McpSecretRequirement[];
  findings: McpFindingCard[];
};

type McpCenterProps = {
  runtimeAvailable: boolean;
};

type McpDiagnosticGroup = {
  key: string;
  hostId: string;
  nativeScope: string;
  parseStatus: string;
  pathDisplay: string;
  findings: McpFindingCard[];
};

type McpTransport = "stdio" | "http" | "sse";
type McpMutationPhase = "" | "planning" | "applying" | "rolling-back";

type McpHeaderEnvRef = {
  headerName: string;
  envVarName: string;
};

type McpBindingDraft = {
  transport: McpTransport;
  command?: string;
  args: string[];
  url?: string;
  envVars: string[];
  headerEnv: McpHeaderEnvRef[];
  enabled: boolean;
  required: boolean;
};

type McpBindingChange = {
  hostId: "host-codex" | "host-claude-code";
  scope: "user" | "project" | "local";
  workspaceId?: string;
  action: "upsert" | "delete" | "set-enabled";
  serverName: string;
  draft?: McpBindingDraft;
  enabled?: boolean;
};

type McpPlanTarget = {
  id: string;
  hostId: string;
  scope: string;
  workspaceId?: string | null;
  pathDisplay: string;
  existed: boolean;
};

type McpFieldDiff = {
  targetId: string;
  hostId: string;
  scope: string;
  workspaceId?: string | null;
  serverName: string;
  field: string;
  change: string;
  before: string;
  after: string;
};

type McpMutationPlan = {
  planId: string;
  targets: McpPlanTarget[];
  diffs: McpFieldDiff[];
  requiresConfirmation: boolean;
};

type McpApplyResult = {
  planId: string;
  snapshotId: string;
  changedTargets: number;
  verified: boolean;
};

type McpRollbackResult = {
  snapshotId: string;
  restoredTargets: number;
  verified: boolean;
};

type McpRollbackSnapshot = {
  snapshotId: string;
  createdAtUnixMs: number;
  expiresAtUnixMs: number;
  targetCount: number;
};

type McpMutationTargetOption = {
  hostId: "host-codex" | "host-claude-code";
  scope: "user" | "project" | "local";
  workspaceId?: string | null;
  workspaceLabel?: string | null;
  pathDisplay: string;
};

type McpFormDraft = {
  hostIds: Array<"host-codex" | "host-claude-code">;
  scope: "user" | "project" | "local";
  workspaceId?: string;
  serverName: string;
  transport: McpTransport;
  command: string;
  url: string;
  argsText: string;
  envVarsText: string;
  headerEnvText: string;
  enabled: boolean;
  required: boolean;
};

type McpBindingManagement =
  | {
      writable: true;
      hostId: "host-codex" | "host-claude-code";
      scope: "user" | "project" | "local";
      workspaceId?: string;
      reason: "";
    }
  | { writable: false; reason: string };

const SUPPORTED_MCP_HOSTS = [
  { id: "host-codex" as const, label: "Codex" },
  { id: "host-claude-code" as const, label: "Claude Code" }
];

function emptyMcpFormDraft(): McpFormDraft {
  return {
    hostIds: ["host-codex", "host-claude-code"],
    scope: "user",
    serverName: "",
    transport: "stdio",
    command: "",
    url: "",
    argsText: "",
    envVarsText: "",
    headerEnvText: "",
    enabled: true,
    required: false
  };
}

function defaultMcpFormDraft(targets: McpMutationTargetOption[]): McpFormDraft {
  const draft = emptyMcpFormDraft();
  const userHosts = SUPPORTED_MCP_HOSTS
    .map(host => host.id)
    .filter(hostId => targets.some(target => target.hostId === hostId && target.scope === "user"));
  draft.hostIds = userHosts.length > 0
    ? userHosts
    : targets[0]
      ? [targets[0].hostId]
      : [];
  return normalizeMcpTarget(draft, targets);
}

function commonMcpTargets(
  targets: McpMutationTargetOption[],
  hostIds: Array<"host-codex" | "host-claude-code">
) {
  if (hostIds.length === 0) return [];
  const unique = new Map<string, McpMutationTargetOption>();
  for (const target of targets) {
    const key = `${target.scope}|${target.workspaceId ?? ""}`;
    if (!hostIds.every(hostId => targets.some(candidate =>
      candidate.hostId === hostId
      && candidate.scope === target.scope
      && (candidate.workspaceId ?? "") === (target.workspaceId ?? "")
    ))) continue;
    if (!unique.has(key)) unique.set(key, target);
  }
  return Array.from(unique.values());
}

function normalizeMcpTarget(
  draft: McpFormDraft,
  targets: McpMutationTargetOption[]
): McpFormDraft {
  const choices = commonMcpTargets(targets, draft.hostIds);
  const current = choices.find(target =>
    target.scope === draft.scope
    && (target.workspaceId ?? "") === (draft.workspaceId ?? "")
  );
  const selected = current ?? choices[0];
  return selected
    ? { ...draft, scope: selected.scope, workspaceId: selected.workspaceId ?? undefined }
    : draft;
}

export function McpCenter({ runtimeAvailable }: McpCenterProps) {
  const [inventory, setInventory] = useState<McpInventory | null>(null);
  const [selectedBindingId, setSelectedBindingId] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [copiedPathKey, setCopiedPathKey] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [formMode, setFormMode] = useState<"add" | "reconfigure">("add");
  const [formDraft, setFormDraft] = useState<McpFormDraft>(emptyMcpFormDraft);
  const [formError, setFormError] = useState("");
  const [mutationPhase, setMutationPhase] = useState<McpMutationPhase>("");
  const [mutationError, setMutationError] = useState("");
  const [pendingPlan, setPendingPlan] = useState<McpMutationPlan | null>(null);
  const [rollbackSnapshots, setRollbackSnapshots] = useState<McpRollbackSnapshot[]>([]);
  const [mutationTargets, setMutationTargets] = useState<McpMutationTargetOption[]>([]);
  const [mutationNotice, setMutationNotice] = useState("");
  const mutationInFlightRef = useRef(false);

  const mutationBusy = mutationPhase !== "";

  async function scan() {
    if (!runtimeAvailable) {
      setInventory(previewInventory());
      return;
    }
    setLoading(true);
    setError("");
    try {
      const next = await invoke<McpInventory>("scan_mcp_connections");
      setInventory(next);
      if (next.bindings.length > 0) {
        setSelectedBindingId(current =>
          next.bindings.some(item => item.id === current) ? current : next.bindings[0].id
        );
      } else {
        setSelectedBindingId("");
      }
    } catch (reason) {
      setError(friendlyMessage(reason));
    } finally {
      setLoading(false);
    }
  }

  async function loadManagementState() {
    if (!runtimeAvailable) {
      setRollbackSnapshots([]);
      setMutationTargets([]);
      return;
    }
    try {
      const snapshots = await invoke<McpRollbackSnapshot[]>("list_mcp_rollback_snapshots");
      setRollbackSnapshots(snapshots);
      const targets = await invoke<McpMutationTargetOption[]>("list_mcp_mutation_targets");
      setMutationTargets(targets);
    } catch (reason) {
      setMutationError(friendlyMessage(reason));
    }
  }

  function startAdd() {
    setFormMode("add");
    setFormDraft(defaultMcpFormDraft(mutationTargets));
    setFormError("");
    setMutationError("");
    setPendingPlan(null);
    setShowForm(true);
  }

  function closeForm() {
    if (mutationBusy) return;
    setShowForm(false);
    setFormError("");
  }

  function startReconfigure(binding: McpBindingCard, location: McpConfigLocation | null) {
    const management = bindingManagement(binding, location, runtimeAvailable);
    if (!management.writable) {
      setMutationError(management.reason);
      return;
    }
    setFormMode("reconfigure");
    setFormDraft({
      ...emptyMcpFormDraft(),
      hostIds: [management.hostId],
      scope: management.scope,
      workspaceId: management.workspaceId,
      serverName: binding.nativeName
    });
    setFormError("");
    setMutationError("");
    setPendingPlan(null);
    setShowForm(true);
  }

  async function planChanges(changes: McpBindingChange[]) {
    if (!runtimeAvailable) {
      setMutationError(t("mcp.desktopOnly"));
      return;
    }
    if (mutationInFlightRef.current) return;
    mutationInFlightRef.current = true;
    setMutationPhase("planning");
    setMutationError("");
    setMutationNotice("");
    try {
      const plan = await invoke<McpMutationPlan>("plan_mcp_changes", { request: { changes } });
      setPendingPlan(plan);
    } catch (reason) {
      setPendingPlan(null);
      setMutationError(friendlyMessage(reason));
    } finally {
      mutationInFlightRef.current = false;
      setMutationPhase("");
    }
  }

  async function submitMcpDraft(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = parseMcpFormDraft(formDraft);
    if (parsed.error) {
      setFormError(parsed.error);
      return;
    }
    setFormError("");
    await planChanges(parsed.changes);
  }

  async function planSelectedBinding(action: "delete" | "set-enabled", enabled?: boolean) {
    if (!selectedBinding) return;
    const management = bindingManagement(selectedBinding, selectedLocation, runtimeAvailable);
    if (!management.writable) {
      setMutationError(management.reason);
      return;
    }
    if (action === "set-enabled" && management.hostId === "host-claude-code") {
      setMutationError(t("mcp.claudeToggleInHost"));
      return;
    }
    const change: McpBindingChange = {
      hostId: management.hostId,
      scope: management.scope,
      action,
      serverName: selectedBinding.nativeName
    };
    if (management.workspaceId) change.workspaceId = management.workspaceId;
    if (action === "set-enabled") change.enabled = Boolean(enabled);
    await planChanges([change]);
  }

  async function applyPendingPlan() {
    if (!runtimeAvailable || !pendingPlan || mutationInFlightRef.current) return;
    mutationInFlightRef.current = true;
    setMutationPhase("applying");
    setMutationError("");
    try {
      await invoke<McpApplyResult>("apply_mcp_plan", { planId: pendingPlan.planId });
      setPendingPlan(null);
      setShowForm(false);
      setMutationNotice(t("mcp.applySuccessBody"));
      await loadManagementState();
      await scan();
    } catch (reason) {
      setPendingPlan(null);
      setMutationError(friendlyMessage(reason));
    } finally {
      mutationInFlightRef.current = false;
      setMutationPhase("");
    }
  }

  async function rollbackSnapshot(snapshotId: string) {
    if (!runtimeAvailable || !snapshotId || mutationInFlightRef.current) return;
    mutationInFlightRef.current = true;
    setMutationPhase("rolling-back");
    setMutationError("");
    try {
      const result = await invoke<McpRollbackResult>("rollback_mcp_snapshot", {
        snapshotId
      });
      setMutationNotice(t("mcp.rollbackSuccessBody", { n: result.restoredTargets }));
      await loadManagementState();
      await scan();
    } catch (reason) {
      setMutationError(friendlyMessage(reason));
    } finally {
      mutationInFlightRef.current = false;
      setMutationPhase("");
    }
  }

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await loadManagementState();
      if (!cancelled) await scan();
    })();
    return () => {
      cancelled = true;
    };
  }, [runtimeAvailable]);

  const selectedBinding = inventory?.bindings.find(item => item.id === selectedBindingId) ?? null;
  const selectedServer = selectedBinding
    ? inventory?.servers.find(item => item.id === selectedBinding.serverId) ?? null
    : null;
  const selectedHost = selectedBinding
    ? inventory?.hosts.find(item => item.id === selectedBinding.hostId) ?? null
    : null;
  const selectedLocation = selectedBinding
    ? inventory?.configLocations.find(item => item.id === selectedBinding.configLocationId) ?? null
    : null;
  const selectedManagement = selectedBinding
    ? bindingManagement(selectedBinding, selectedLocation, runtimeAvailable)
    : null;
  const selectedSecrets = selectedBinding
    ? inventory?.secretRequirements.filter(item => item.bindingId === selectedBinding.id) ?? []
    : [];
  const selectedFindings = selectedBinding
    ? inventory?.findings.filter(item => findingMatchesBinding(item, selectedBinding)) ?? []
    : [];

  const globalDiagnosticGroups = useMemo(() => {
    if (!inventory) return [];

    const locationsById = new Map(inventory.configLocations.map(location => [location.id, location]));
    const groups = new Map<string, McpDiagnosticGroup>();
    const ensureGroup = (
      key: string,
      hostId: string,
      nativeScope: string,
      parseStatus: string,
      pathDisplay: string
    ) => {
      const current = groups.get(key);
      if (current) {
        if (!current.pathDisplay && pathDisplay) current.pathDisplay = pathDisplay;
        if (current.parseStatus === "ok" && parseStatus !== "ok") current.parseStatus = parseStatus;
        return current;
      }
      const next: McpDiagnosticGroup = {
        key,
        hostId,
        nativeScope,
        parseStatus,
        pathDisplay,
        findings: []
      };
      groups.set(key, next);
      return next;
    };

    for (const finding of inventory.findings) {
      const locationId = finding.configLocationId?.trim() ?? "";
      if (locationId && inventory.bindings.some(binding => binding.configLocationId === locationId)) continue;
      if (!locationId && inventory.bindings.some(binding => binding.hostId === finding.hostId)) continue;
      const location = locationId ? locationsById.get(locationId) : undefined;
      const group = ensureGroup(
        locationId ? `location:${locationId}` : `host:${finding.hostId}`,
        location?.hostId ?? finding.hostId,
        location?.nativeScope ?? "",
        location?.parseStatus ?? "unknown",
        location?.pathDisplay ?? finding.pathDisplay ?? ""
      );
      group.findings.push(finding);
    }

    for (const location of inventory.configLocations) {
      if (location.parseStatus === "ok") continue;
      if (inventory.bindings.some(binding => binding.configLocationId === location.id)) continue;
      ensureGroup(
        `location:${location.id}`,
        location.hostId,
        location.nativeScope,
        location.parseStatus,
        location.pathDisplay
      );
    }

    return Array.from(groups.values());
  }, [inventory]);

  async function copyConfigPath(value: string | null | undefined, key: string) {
    if (!value || value === "—") return;
    try {
      await navigator.clipboard.writeText(value);
      setCopiedPathKey(key);
      window.setTimeout(() => {
        setCopiedPathKey(current => current === key ? "" : current);
      }, 1800);
    } catch {
      setError(t("mcp.copyFailed"));
    }
  }
  const summary = useMemo(() => {
    const hosts = inventory?.hosts.filter(item => item.detected).length ?? 0;
    const servers = inventory?.servers.length ?? 0;
    const bindings = inventory?.bindings.length ?? 0;
    const attention = inventory?.findings.filter(item => item.severity !== "info").length ?? 0;
    return { hosts, servers, bindings, attention };
  }, [inventory]);

  return (
    <div aria-busy={loading || mutationBusy} className="view mcp-view">
      <section className="page-header glow-card mcp-page-header">
        <div>
          <span className="eyebrow"><Icon name="connections" /> {t("mcp.eyebrow")}</span>
          <h2>{t("mcp.title")}</h2>
          <p>{t("mcp.subtitle")}</p>
        </div>
        <div className="page-header-side">
          <button className="primary-action" disabled={loading || mutationBusy} onClick={startAdd} type="button">
            <Icon name="add" /> {t("mcp.add")}
          </button>
          <button className="secondary-action" disabled={loading || mutationBusy} onClick={() => void scan()} type="button">
            <Icon className={loading ? "icon-spin" : ""} name="refresh" />
            {loading ? t("mcp.scanning") : t("mcp.scan")}
          </button>
        </div>
      </section>

      <section className="mcp-metrics" aria-label={t("mcp.summary") }>
        <Metric label={t("mcp.hosts")} value={summary.hosts} />
        <Metric label={t("mcp.servers")} value={summary.servers} />
        <Metric label={t("mcp.bindings")} value={summary.bindings} />
        <Metric label={t("mcp.attention")} tone={summary.attention > 0 ? "warn" : "ok"} value={summary.attention} />
      </section>

      {error && (
        <section className="status-banner error" role="alert">
          <Icon name="alert" />
          <div><strong>{t("mcp.scanFailed")}</strong><span>{error}</span></div>
        </section>
      )}

      {mutationError && (
        <section className="status-banner error" role="alert">
          <Icon name="alert" />
          <div><strong>{t("mcp.changeFailed")}</strong><span>{mutationError}</span></div>
        </section>
      )}

      {mutationNotice && (
        <section className="status-banner ok" role="status">
          <Icon name="shield" />
          <div><strong>{t("mcp.staticVerified")}</strong><span>{mutationNotice}</span></div>
        </section>
      )}

      {!runtimeAvailable && (
        <section className="mcp-preview-note" role="status">
          <Icon name="info" /> {t("mcp.desktopOnly")}
        </section>
      )}

      <section className="mcp-host-strip glow-card">
        <div>
          <span className="eyebrow">{t("mcp.hostsEyebrow")}</span>
          <h3>{t("mcp.hostsTitle")}</h3>
        </div>
        <div className="mcp-host-pills">
          {(inventory?.hosts ?? []).map(host => (
            <span className={host.detected ? "mcp-host-pill detected" : "mcp-host-pill"} key={host.adapterKey}>
              <i />
              <strong>{host.displayName}</strong>
              <em>{host.configCount}</em>
            </span>
          ))}
          {!loading && (inventory?.hosts.length ?? 0) === 0 && <span className="empty-inline">{t("mcp.noHosts")}</span>}
        </div>
      </section>

      {showForm && (
        <McpManagementForm
          draft={formDraft}
          error={formError}
          mode={formMode}
          busy={mutationBusy}
          runtimeAvailable={runtimeAvailable}
          targetOptions={mutationTargets}
          onCancel={closeForm}
          onChange={setFormDraft}
          onSubmit={submitMcpDraft}
        />
      )}

      {pendingPlan && (
        <McpPlanConfirmation
          busy={mutationBusy}
          plan={pendingPlan}
          onApply={() => void applyPendingPlan()}
          onCancel={() => setPendingPlan(null)}
        />
      )}

      {rollbackSnapshots.length > 0 && (
        <section aria-label={t("mcp.snapshotTitle")} className="mcp-snapshot-panel glow-card">
          <header>
            <span className="mcp-snapshot-icon"><Icon name="snapshots" /></span>
            <div>
              <strong>{t("mcp.snapshotTitle")}</strong>
              <small>{t("mcp.snapshotRetention")}</small>
            </div>
          </header>
          <ul>
            {rollbackSnapshots.map(snapshot => (
              <li key={snapshot.snapshotId}>
                <div>
                  <code>{snapshot.snapshotId}</code>
                  <small>{t("mcp.snapshotMeta", {
                    n: snapshot.targetCount,
                    expiry: formatSnapshotExpiry(snapshot.expiresAtUnixMs)
                  })}</small>
                </div>
                <button
                  className="secondary-action"
                  disabled={!runtimeAvailable || mutationBusy}
                  onClick={() => void rollbackSnapshot(snapshot.snapshotId)}
                  type="button"
                >
                  <Icon name="snapshots" />
                  {mutationPhase === "rolling-back" ? t("mcp.rollingBack") : t("mcp.rollback")}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {globalDiagnosticGroups.length > 0 && (
        <section aria-labelledby="mcp-config-diagnostics-title" className="mcp-global-diagnostics">
          <header>
            <div>
              <span className="eyebrow"><Icon name="alert" /> {t("mcp.diagnosticsEyebrow")}</span>
              <h3 id="mcp-config-diagnostics-title">{t("mcp.diagnosticsTitle", { n: globalDiagnosticGroups.length })}</h3>
              <p>{t("mcp.diagnosticsBody")}</p>
            </div>
            <span className="readonly-badge"><Icon name="shield" /> {t("mcp.readOnly")}</span>
          </header>
          <div className="mcp-diagnostic-grid">
            {globalDiagnosticGroups.map(group => {
              const host = inventory?.hosts.find(item => item.id === group.hostId);
              const tone = diagnosticSeverity(group);
              return (
                <article className={`mcp-diagnostic-card glow-card ${tone}`} key={group.key}>
                  <header>
                    <span className="mcp-diagnostic-icon"><Icon name="alert" /></span>
                    <div>
                      <strong>{host?.displayName ?? t("mcp.unknownHost")}</strong>
                      <small>{group.nativeScope ? scopeLabel(group.nativeScope) : t("mcp.hostFindingScope")}</small>
                    </div>
                    <em className={`mcp-diagnostic-badge ${tone}`}>{diagnosticSeverityLabel(tone)}</em>
                  </header>
                  {group.pathDisplay && (
                    <div className="mcp-config-path mcp-diagnostic-path">
                      <span>{t("mcp.configSource")}</span>
                      <code>{group.pathDisplay}</code>
                      <button
                        className="ghost-action small"
                        onClick={() => void copyConfigPath(group.pathDisplay, group.key)}
                        type="button"
                      >
                        <Icon name="copy" /> {copiedPathKey === group.key ? t("mcp.copied") : t("mcp.copyPath")}
                      </button>
                    </div>
                  )}
                  <ul className="mcp-diagnostic-findings">
                    {group.findings.map(item => (
                      <li className={`finding-${findingSeverityClass(item.severity)}`} key={item.id}>
                        <strong>{item.title}</strong>
                        <span>{item.message}</span>
                      </li>
                    ))}
                    {group.findings.length === 0 && (
                      <li className="finding-error">
                        <strong>{t("mcp.parseFailed")}</strong>
                        <span>{t("mcp.parseFailedFallback", { status: group.parseStatus })}</span>
                      </li>
                    )}
                  </ul>
                </article>
              );
            })}
          </div>
          <p className="mcp-diagnostics-note"><Icon name="info" /> {t("mcp.diagnosticsReadOnly")}</p>
        </section>
      )}

      <section className="mcp-browser">
        <div className="mcp-server-list">
          {(inventory?.servers ?? []).map(server => {
            const bindings = inventory?.bindings.filter(item => item.serverId === server.id) ?? [];
            return (
              <article className="mcp-server-card glow-card" key={server.id}>
                <header>
                  <span className={`mcp-transport transport-${server.transport}`}><Icon name="connections" /></span>
                  <div><strong>{server.displayName}</strong><small>{server.transport || t("mcp.unknownTransport")}</small></div>
                  <span className="capability-unprobed">{t("mcp.unprobed")}</span>
                </header>
                <p className="mcp-target">{server.targetDisplayRedacted || t("mcp.redactedTarget")}</p>
                <div className="mcp-binding-stack">
                  {bindings.map(binding => (
                    <button
                      className={selectedBindingId === binding.id ? "mcp-binding-row selected" : "mcp-binding-row"}
                      key={binding.id}
                      onClick={() => setSelectedBindingId(binding.id)}
                      type="button"
                    >
                      <span><strong>{inventory?.hosts.find(host => host.id === binding.hostId)?.displayName ?? binding.nativeName}</strong><small>{scopeLabel(binding.nativeScope)}</small></span>
                      <em className={binding.enabled ? "state-on" : "state-off"}>
                        {binding.enabled ? t("common.enabled") : t("common.disabled")}
                      </em>
                      <Icon name="chevron" />
                    </button>
                  ))}
                </div>
              </article>
            );
          })}
          {!loading && (inventory?.servers.length ?? 0) === 0 && (
            <div className="mcp-empty glow-card">
              <Icon name="connections" />
              <strong>{t("mcp.emptyTitle")}</strong>
              <p>{t(globalDiagnosticGroups.length > 0 ? "mcp.emptyWithDiagnosticsBody" : "mcp.emptyBody")}</p>
            </div>
          )}
        </div>

        <aside className={selectedBinding ? "mcp-inspector glow-card has-selection" : "mcp-inspector glow-card"}>
          {selectedBinding && selectedServer ? (
            <>
              <header><span className="eyebrow">{t("mcp.bindingDetail")}</span><h3>{selectedBinding.nativeName}</h3></header>
              <dl className="mcp-detail-grid">
                <Detail label={t("mcp.host")} value={selectedHost?.displayName ?? "—"} />
                <Detail label={t("mcp.scope")} value={scopeLabel(selectedBinding.nativeScope)} />
                <Detail label={t("mcp.transport")} value={selectedServer.transport || "—"} />
                <Detail label={t("mcp.capability")} value={t("mcp.unprobed")} />
              </dl>
              <div className="mcp-binding-actions" aria-label={t("mcp.bindingActions")}>
                {selectedBinding.hostId === "host-claude-code" ? (
                  <span className="mcp-claude-toggle-note"><Icon name="info" /> {t("mcp.claudeToggleInHost")}</span>
                ) : (
                  <button
                    className="secondary-action small"
                    disabled={!selectedManagement?.writable || mutationBusy}
                    onClick={() => void planSelectedBinding("set-enabled", !selectedBinding.enabled)}
                    type="button"
                  >
                    {selectedBinding.enabled ? t("mcp.disable") : t("mcp.enable")}
                  </button>
                )}
                <button
                  className="secondary-action small"
                  disabled={!selectedManagement?.writable || mutationBusy}
                  onClick={() => startReconfigure(selectedBinding, selectedLocation)}
                  type="button"
                >
                  <Icon name="edit" /> {t("mcp.reconfigure")}
                </button>
                <button
                  className="ghost-action danger small"
                  disabled={!selectedManagement?.writable || mutationBusy}
                  onClick={() => void planSelectedBinding("delete")}
                  type="button"
                >
                  <Icon name="trash" /> {t("mcp.delete")}
                </button>
              </div>
              {selectedManagement && !selectedManagement.writable && (
                <p className="mcp-management-readonly-note"><Icon name="info" /> {selectedManagement.reason}</p>
              )}
              <div className="mcp-config-path">
                <span>{t("mcp.configSource")}</span>
                <code>{selectedLocation?.pathDisplay ?? "—"}</code>
                <button className="ghost-action small" disabled={!selectedLocation?.pathDisplay} onClick={() => void copyConfigPath(selectedLocation?.pathDisplay, "selected-binding")} type="button">
                  <Icon name="copy" /> {copiedPathKey === "selected-binding" ? t("mcp.copied") : t("mcp.copyPath")}
                </button>
              </div>
              <section className="mcp-secret-section">
                <span className="eyebrow">{t("mcp.credentials")}</span>
                {selectedSecrets.length === 0 ? (
                  <p>{t("mcp.noCredentialReference")}</p>
                ) : (
                  <ul>{selectedSecrets.map(secret => (
                    <li className={`secret-${secretStateClass(secret.presenceState)}`} key={`${secret.useKind}-${secret.keyName}`}>
                      <code>{secret.keyName}</code><span>{secretStateLabel(secret.presenceState)}</span>
                    </li>
                  ))}</ul>
                )}
              </section>
              {selectedFindings.length > 0 && (
                <section className="mcp-findings"><span className="eyebrow">{t("mcp.findings")}</span><ul>
                  {selectedFindings.map(item => <li className={`finding-${findingSeverityClass(item.severity)}`} key={item.id}><strong>{item.title}</strong><span>{item.message}</span></li>)}
                </ul></section>
              )}
              <p className="mcp-readonly-note"><Icon name="info" /> {t("mcp.unprobedReason")}</p>
            </>
          ) : (
            <div className="mcp-inspector-empty"><Icon name="info" /><strong>{t("mcp.inspectTitle")}</strong><p>{t("mcp.inspectBody")}</p></div>
          )}
        </aside>
      </section>
    </div>
  );
}

function McpManagementForm({
  busy,
  draft,
  error,
  mode,
  runtimeAvailable,
  targetOptions,
  onCancel,
  onChange,
  onSubmit
}: {
  busy: boolean;
  draft: McpFormDraft;
  error: string;
  mode: "add" | "reconfigure";
  runtimeAvailable: boolean;
  targetOptions: McpMutationTargetOption[];
  onCancel: () => void;
  onChange: (draft: McpFormDraft) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const compatibleTargets = commonMcpTargets(targetOptions, draft.hostIds);
  const scopeOptions = Array.from(new Set(compatibleTargets.map(target => target.scope)));
  const workspaceOptions = compatibleTargets.filter(target => target.scope === draft.scope);
  const selectedTargets = targetOptions.filter(target =>
    draft.hostIds.includes(target.hostId)
    && target.scope === draft.scope
    && (target.workspaceId ?? "") === (draft.workspaceId ?? "")
  );
  const workspaceMissing = draft.scope !== "user" && !draft.workspaceId;
  const targetUnavailable = draft.hostIds.length === 0 || selectedTargets.length !== draft.hostIds.length;
  const stdio = draft.transport === "stdio";
  const codexSelected = draft.hostIds.includes("host-codex");
  const claudeSelected = draft.hostIds.includes("host-claude-code");

  function toggleHost(hostId: "host-codex" | "host-claude-code") {
    if (mode === "reconfigure") return;
    const removing = draft.hostIds.includes(hostId);
    const hostIds = removing
      ? draft.hostIds.filter(item => item !== hostId)
      : [...draft.hostIds, hostId];
    const next = normalizeMcpTarget({
      ...draft,
      hostIds,
      enabled: hostIds.includes("host-claude-code") ? true : draft.enabled,
      required: hostId === "host-codex" && removing ? false : draft.required
    }, targetOptions);
    if (hostIds.length === 0 || commonMcpTargets(targetOptions, hostIds).length > 0) onChange(next);
  }

  return (
    <section aria-labelledby="mcp-management-form-title" className="mcp-management-panel glow-card">
      <header>
        <div>
          <span className="eyebrow"><Icon name={mode === "add" ? "add" : "edit"} /> {t("mcp.manageEyebrow")}</span>
          <h3 id="mcp-management-form-title">{t(mode === "add" ? "mcp.addTitle" : "mcp.reconfigureTitle")}</h3>
          <p>{t(mode === "add" ? "mcp.addBody" : "mcp.reconfigureBody")}</p>
        </div>
        <button className="ghost-action small" disabled={busy} onClick={onCancel} type="button">
          {t("common.cancel")}
        </button>
      </header>

      <form className="mcp-management-form" onSubmit={onSubmit}>
        <fieldset className="mcp-host-picker">
          <legend>{t("mcp.chooseHosts")}</legend>
          <div>
            {SUPPORTED_MCP_HOSTS.map(host => (
              <label className={draft.hostIds.includes(host.id) ? "selected" : ""} key={host.id}>
                <input
                  checked={draft.hostIds.includes(host.id)}
                  disabled={busy || mode === "reconfigure" || !targetOptions.some(target => target.hostId === host.id)}
                  onChange={() => toggleHost(host.id)}
                  type="checkbox"
                />
                <span><strong>{host.label}</strong><small>{scopeLabel(draft.scope)}</small></span>
              </label>
            ))}
          </div>
        </fieldset>

        <div className="mcp-form-grid">
          <label>
            <span>{t("mcp.serverName")}</span>
            <input
              autoComplete="off"
              disabled={busy || mode === "reconfigure"}
              maxLength={64}
              onChange={event => onChange({ ...draft, serverName: event.target.value })}
              placeholder="example-mcp"
              required
              spellCheck={false}
              value={draft.serverName}
            />
          </label>
          <label>
            <span>{t("mcp.scope")}</span>
            <select
              disabled={busy || mode === "reconfigure"}
              onChange={event => {
                const scope = event.target.value as McpFormDraft["scope"];
                const selected = compatibleTargets.find(target => target.scope === scope);
                onChange({ ...draft, scope, workspaceId: selected?.workspaceId ?? undefined });
              }}
              value={draft.scope}
            >
              {scopeOptions.map(scope => <option key={scope} value={scope}>{scopeLabel(scope)}</option>)}
            </select>
          </label>
          {draft.scope !== "user" && (
            <label>
              <span>{t("mcp.workspace")}</span>
              <select
                disabled={busy || mode === "reconfigure"}
                onChange={event => onChange({ ...draft, workspaceId: event.target.value })}
                value={draft.workspaceId ?? ""}
              >
                {workspaceOptions.map(target => (
                  <option key={target.workspaceId} value={target.workspaceId ?? ""}>
                    {target.workspaceLabel || target.workspaceId}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            <span>{t("mcp.transport")}</span>
            <select
              disabled={busy}
              onChange={event => onChange({ ...draft, transport: event.target.value as McpTransport })}
              value={draft.transport}
            >
              <option value="stdio">stdio</option>
              <option value="http">http</option>
              <option value="sse">sse</option>
            </select>
          </label>
          <label>
            <span>{t(stdio ? "mcp.command" : "mcp.url")}</span>
            <input
              autoComplete="off"
              disabled={busy}
              onChange={event => onChange(stdio
                ? { ...draft, command: event.target.value }
                : { ...draft, url: event.target.value })}
              placeholder={stdio ? "npx" : "https://example.com/mcp"}
              required
              spellCheck={false}
              value={stdio ? draft.command : draft.url}
            />
          </label>
        </div>

        <div className="mcp-form-grid mcp-form-grid-wide">
          <label>
            <span>{t("mcp.args")}</span>
            <textarea
              disabled={busy || !stdio}
              onChange={event => onChange({ ...draft, argsText: event.target.value })}
              placeholder={t("mcp.argsPlaceholder")}
              rows={4}
              spellCheck={false}
              value={draft.argsText}
            />
            <small>{t(stdio ? "mcp.argsHelp" : "mcp.remoteProcessFieldsDisabled")}</small>
          </label>
          <label>
            <span>{t("mcp.envVars")}</span>
            <textarea
              disabled={busy || !stdio}
              onChange={event => onChange({ ...draft, envVarsText: event.target.value })}
              placeholder="API_TOKEN, DATABASE_URL"
              rows={4}
              spellCheck={false}
              value={draft.envVarsText}
            />
            <small>{t("mcp.envVarsHelp")}</small>
          </label>
          <label>
            <span>{t("mcp.headerEnv")}</span>
            <textarea
              disabled={busy}
              onChange={event => onChange({ ...draft, headerEnvText: event.target.value })}
              placeholder={"Authorization=API_TOKEN\nX-Workspace=WORKSPACE_ID"}
              rows={4}
              spellCheck={false}
              value={draft.headerEnvText}
            />
            <small>{t("mcp.headerEnvHelp")}</small>
          </label>
        </div>

        <div className="mcp-form-options">
          <label>
            <input
              checked={claudeSelected || draft.enabled}
              disabled={busy || claudeSelected}
              onChange={event => onChange({ ...draft, enabled: event.target.checked })}
              type="checkbox"
            />
            <span><strong>{t("mcp.enabledAfterApply")}</strong><small>{t(claudeSelected ? "mcp.claudeEnabledRequired" : "mcp.enabledAfterApplyHelp")}</small></span>
          </label>
          <label>
            <input
              checked={draft.required && codexSelected}
              disabled={busy || !codexSelected}
              onChange={event => onChange({ ...draft, required: event.target.checked })}
              type="checkbox"
            />
            <span><strong>{t("mcp.requiredForCodex")}</strong><small>{t("mcp.requiredForCodexHelp")}</small></span>
          </label>
        </div>

        <p className="mcp-no-secrets-note"><Icon name="shield" /> {t("mcp.noSecretValues")}</p>
        {selectedTargets.length > 0 && (
          <p className="mcp-target-preview">
            <Icon name="folder" />
            {selectedTargets.map(target => `${hostDisplayName(target.hostId)} · ${target.pathDisplay}`).join(" · ")}
          </p>
        )}
        {workspaceMissing && <p className="mcp-form-error" role="alert">{t("mcp.workspaceUnavailable")}</p>}
        {targetUnavailable && <p className="mcp-form-error" role="alert">{t("mcp.targetUnavailable")}</p>}
        {error && <p className="mcp-form-error" role="alert">{error}</p>}
        <footer>
          <span>{t("mcp.planFirst")}</span>
          <button
            className="primary-action"
            disabled={!runtimeAvailable || busy || workspaceMissing || targetUnavailable}
            type="submit"
          >
            <Icon name="shield" />
            {busy ? t("mcp.planning") : t("mcp.reviewChanges")}
          </button>
        </footer>
      </form>
    </section>
  );
}

function McpPlanConfirmation({
  busy,
  plan,
  onApply,
  onCancel
}: {
  busy: boolean;
  plan: McpMutationPlan;
  onApply: () => void;
  onCancel: () => void;
}) {
  return (
    <section
      aria-labelledby="mcp-plan-confirmation-title"
      className="mcp-plan-confirmation glow-card"
      data-requires-confirmation={plan.requiresConfirmation ? "true" : "false"}
    >
      <header>
        <div>
          <span className="eyebrow"><Icon name="shield" /> {t("mcp.confirmEyebrow")}</span>
          <h3 id="mcp-plan-confirmation-title">{t("mcp.confirmTitle")}</h3>
          <p>{t("mcp.confirmBody")}</p>
        </div>
        <code>{plan.planId}</code>
      </header>

      <div className="mcp-plan-targets">
        <h4>{t("mcp.targets", { n: plan.targets.length })}</h4>
        <ul>
          {plan.targets.map(target => (
            <li key={target.id}>
              <span><strong>{hostDisplayName(target.hostId)}</strong><small>{scopeLabel(target.scope)}</small></span>
              <code>{safePlanDisplay(target.pathDisplay)}</code>
              <em>{target.existed ? t("mcp.existingConfig") : t("mcp.newConfig")}</em>
            </li>
          ))}
        </ul>
      </div>

      <div className="mcp-plan-diffs">
        <h4>{t("mcp.diffs", { n: plan.diffs.length })}</h4>
        <div>
          {plan.diffs.map((diff, index) => (
            <article key={`${diff.targetId}-${diff.serverName}-${diff.field}-${index}`}>
              <header>
                <strong>{diff.serverName}</strong>
                <span>{safePlanDisplay(diff.field)}</span>
                <em>{safePlanDisplay(diff.change)}</em>
              </header>
              <dl>
                <div><dt>{t("mcp.before")}</dt><dd><code>{safePlanDisplay(diff.before)}</code></dd></div>
                <div><dt>{t("mcp.after")}</dt><dd><code>{safePlanDisplay(diff.after)}</code></dd></div>
              </dl>
            </article>
          ))}
          {plan.diffs.length === 0 && <p className="empty-inline">{t("mcp.noDiffs")}</p>}
        </div>
      </div>

      <p className="mcp-confirm-note"><Icon name="info" /> {t("mcp.confirmBoundary")}</p>
      <footer>
        <button className="ghost-action" disabled={busy} onClick={onCancel} type="button">{t("common.cancel")}</button>
        <button className="primary-action" disabled={busy} onClick={onApply} type="button">
          <Icon name="shield" /> {busy ? t("mcp.applying") : t("mcp.confirmApply")}
        </button>
      </footer>
    </section>
  );
}

function Metric({ label, tone = "", value }: { label: string; tone?: string; value: number }) {
  return <article className={`mcp-metric glow-card ${tone}`}><span>{label}</span><strong>{value.toLocaleString()}</strong></article>;
}

function Detail({ label, value }: { label: string; value: string }) {
  return <div><dt>{label}</dt><dd>{value || "—"}</dd></div>;
}

function scopeLabel(scope: string) {
  if (scope === "user") return t("mcp.scopeUser");
  if (scope === "project") return t("mcp.scopeProject");
  if (scope === "local") return t("mcp.scopeLocal");
  if (scope === "profile") return t("mcp.scopeProfile");
  return scope || t("mcp.scopeUnknown");
}

function formatSnapshotExpiry(value: number) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : "—";
}

function secretStateLabel(state: string) {
  if (state === "present") return t("mcp.secretPresent");
  if (state === "missing") return t("mcp.secretMissing");
  if (state === "inline-value-present") return t("mcp.secretInline");
  return t("mcp.secretUnknown");
}

function secretStateClass(state: string) {
  if (state === "inline-value-present") return "inline-secret";
  if (state === "present" || state === "missing") return state;
  return "unknown";
}

function findingSeverityClass(severity: string) {
  if (severity === "warning") return "warn";
  if (severity === "error" || severity === "warn") return severity;
  return "info";
}

function findingMatchesBinding(finding: McpFindingCard, binding: McpBindingCard) {
  return finding.configLocationId
    ? finding.configLocationId === binding.configLocationId
    : finding.hostId === binding.hostId;
}

function diagnosticSeverity(group: McpDiagnosticGroup): "error" | "warn" | "info" {
  if (group.parseStatus === "error" || group.findings.some(item => item.severity === "error")) return "error";
  if (group.findings.some(item => item.severity === "warn" || item.severity === "warning")) return "warn";
  return "info";
}

function diagnosticSeverityLabel(tone: "error" | "warn" | "info") {
  if (tone === "error") return t("mcp.severityError");
  if (tone === "warn") return t("mcp.severityWarning");
  return t("mcp.severityInfo");
}

function friendlyMessage(reason: unknown) {
  const raw = reason instanceof Error ? reason.message : String(reason ?? "");
  return raw.length > 280 ? `${raw.slice(0, 277)}…` : raw || t("mcp.scanFailedBody");
}

function parseMcpFormDraft(draft: McpFormDraft): { changes: McpBindingChange[]; error: string } {
  const serverName = draft.serverName.trim();
  const hostIds = Array.from(new Set(draft.hostIds));
  if (!mcpServerNameCompatible(serverName, hostIds)) {
    return {
      changes: [],
      error: t(hostIds.includes("host-claude-code") ? "mcp.invalidClaudeServerName" : "mcp.invalidServerName")
    };
  }
  if (hostIds.length === 0) return { changes: [], error: t("mcp.chooseHostError") };
  if (draft.scope !== "user" && !draft.workspaceId) {
    return { changes: [], error: t("mcp.workspaceUnavailable") };
  }
  if (draft.transport === "sse" && hostIds.includes("host-codex")) {
    return { changes: [], error: t("mcp.sseClaudeOnly") };
  }
  if (
    containsObviousCredentialValue([draft.command, draft.url, draft.argsText].join("\n"))
    || /[=:]/.test(draft.envVarsText)
  ) {
    return { changes: [], error: t("mcp.credentialValueBlocked") };
  }

  const args = draft.transport === "stdio" ? splitNonEmptyLines(draft.argsText) : [];
  const envVars = draft.transport === "stdio"
    ? draft.envVarsText.split(",").map(value => value.trim()).filter(Boolean)
    : [];
  if (envVars.some(value => !/^[_A-Za-z][_A-Za-z0-9]{0,127}$/.test(value))) {
    return { changes: [], error: t("mcp.invalidEnvVar") };
  }
  const headerEnv: McpHeaderEnvRef[] = [];
  for (const line of splitNonEmptyLines(draft.headerEnvText)) {
    const separator = line.indexOf("=");
    const headerName = separator >= 0 ? line.slice(0, separator).trim() : "";
    const envVarName = separator >= 0 ? line.slice(separator + 1).trim() : "";
    if (containsObviousCredentialValue(envVarName)) {
      return { changes: [], error: t("mcp.credentialValueBlocked") };
    }
    if (!/^[A-Za-z0-9-]{1,128}$/.test(headerName) || !/^[_A-Za-z][_A-Za-z0-9]{0,127}$/.test(envVarName)) {
      return { changes: [], error: t("mcp.invalidHeaderEnv") };
    }
    headerEnv.push({ headerName, envVarName });
  }

  const command = draft.command.trim();
  const url = draft.url.trim();
  if (draft.transport === "stdio" && !command) {
    return { changes: [], error: t("mcp.commandRequired") };
  }
  if (draft.transport !== "stdio" && !isSafeMcpUrl(url)) {
    return { changes: [], error: t("mcp.urlRequired") };
  }

  const changes = hostIds.map(hostId => {
    const bindingDraft: McpBindingDraft = {
      transport: draft.transport,
      args,
      envVars,
      headerEnv,
      enabled: hostId === "host-claude-code" ? true : draft.enabled,
      required: hostId === "host-codex" ? draft.required : false
    };
    if (draft.transport === "stdio") bindingDraft.command = command;
    else bindingDraft.url = url;
    const change: McpBindingChange = {
      hostId,
      scope: draft.scope,
      action: "upsert",
      serverName,
      draft: bindingDraft
    };
    if (draft.scope !== "user" && draft.workspaceId) change.workspaceId = draft.workspaceId;
    return change;
  });
  return { changes, error: "" };
}

function splitNonEmptyLines(value: string) {
  return value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}

function isSafeMcpUrl(value: string) {
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "http:" || parsed.protocol === "https:")
      && !parsed.username
      && !parsed.password
      && !parsed.search
      && !parsed.hash;
  } catch {
    return false;
  }
}

function bindingManagement(
  binding: McpBindingCard,
  location: McpConfigLocation | null,
  runtimeAvailable: boolean
): McpBindingManagement {
  const decision = evaluateMcpBindingManagement(binding, location, runtimeAvailable);
  if (!decision.writable) return { writable: false, reason: managementReasonLabel(decision.reason) };
  return {
    ...decision,
    reason: ""
  };
}

function managementReasonLabel(reason: McpManagementBlockReason) {
  if (reason === "desktop-only") return t("mcp.managementDesktopOnly");
  if (reason === "invalid-name") return t("mcp.managementInvalidName");
  if (reason === "location-unknown") return t("mcp.managementLocationUnknown");
  if (reason === "parse-failed") return t("mcp.managementParseFailed");
  if (reason === "workspace-missing") return t("mcp.managementWorkspaceMissing");
  return t("mcp.managementUnsupported");
}

function hostDisplayName(hostId: string) {
  if (hostId === "host-codex") return "Codex";
  if (hostId === "host-claude-code") return "Claude Code";
  return t("mcp.unknownHost");
}

function safePlanDisplay(value: string | null | undefined) {
  const normalized = String(value ?? "—")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1•••@")
    .trim();
  if (!normalized) return "—";
  return normalized.length > 320 ? `${normalized.slice(0, 317)}…` : normalized;
}

function previewInventory(): McpInventory {
  return {
    generatedAtUnixMs: Date.now(),
    capabilityState: "unprobed",
    hosts: [
      { id: "host-codex", adapterKey: "codex", displayName: "Codex", detected: false, configCount: 0 },
      { id: "host-claude-code", adapterKey: "claude-code", displayName: "Claude Code", detected: false, configCount: 0 }
    ],
    configLocations: [],
    servers: [],
    bindings: [],
    secretRequirements: [],
    findings: []
  };
}
