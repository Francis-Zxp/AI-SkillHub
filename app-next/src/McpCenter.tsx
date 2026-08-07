import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useState } from "react";
import { Icon } from "./icons";
import { t } from "./i18n";

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

export function McpCenter({ runtimeAvailable }: McpCenterProps) {
  const [inventory, setInventory] = useState<McpInventory | null>(null);
  const [selectedBindingId, setSelectedBindingId] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

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
        setSelectedBindingId(current => current || next.bindings[0].id);
      }
    } catch (reason) {
      setError(friendlyMessage(reason));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void scan();
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
  const selectedSecrets = selectedBinding
    ? inventory?.secretRequirements.filter(item => item.bindingId === selectedBinding.id) ?? []
    : [];
  const selectedFindings = selectedBinding
    ? inventory?.findings.filter(item => item.configLocationId === selectedBinding.configLocationId) ?? []
    : [];
  const summary = useMemo(() => {
    const hosts = inventory?.hosts.filter(item => item.detected).length ?? 0;
    const servers = inventory?.servers.length ?? 0;
    const bindings = inventory?.bindings.length ?? 0;
    const attention = inventory?.findings.filter(item => item.severity !== "info").length ?? 0;
    return { hosts, servers, bindings, attention };
  }, [inventory]);

  return (
    <div className="view mcp-view">
      <section className="page-header glow-card mcp-page-header">
        <div>
          <span className="eyebrow"><Icon name="connections" /> {t("mcp.eyebrow")}</span>
          <h2>{t("mcp.title")}</h2>
          <p>{t("mcp.subtitle")}</p>
        </div>
        <div className="page-header-side">
          <span className="readonly-badge"><Icon name="shield" /> {t("mcp.readOnly")}</span>
          <button className="secondary-action" disabled={loading} onClick={() => void scan()} type="button">
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
              <p>{t("mcp.emptyBody")}</p>
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
              <div className="mcp-config-path"><span>{t("mcp.configSource")}</span><code>{selectedLocation?.pathDisplay ?? "—"}</code></div>
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

function friendlyMessage(reason: unknown) {
  const raw = reason instanceof Error ? reason.message : String(reason ?? "");
  return raw.length > 280 ? `${raw.slice(0, 277)}…` : raw || t("mcp.scanFailedBody");
}

function previewInventory(): McpInventory {
  return {
    generatedAtUnixMs: Date.now(),
    capabilityState: "unprobed",
    hosts: [
      { id: "host-codex", adapterKey: "codex", displayName: "Codex", detected: false, configCount: 0 },
      { id: "host-claude", adapterKey: "claude-code", displayName: "Claude Code", detected: false, configCount: 0 }
    ],
    configLocations: [],
    servers: [],
    bindings: [],
    secretRequirements: [],
    findings: []
  };
}
