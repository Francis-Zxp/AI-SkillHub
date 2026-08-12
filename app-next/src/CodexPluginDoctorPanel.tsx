import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { Icon } from "./icons";
import { t } from "./i18n";

type DoctorEvidence = {
  id: string;
  kind: string;
  label: string;
  status: "ok" | "warn" | "error" | "unknown" | string;
  detail: string;
  redactedPath: string;
};

type DoctorFinding = {
  severity: "info" | "warn" | "error" | string;
  code: string;
  title: string;
  detail: string;
  remediation?: string;
};

type DoctorInventory = {
  cachePresent: boolean;
  directories: number;
  files: number;
  links: number;
  manifests: number;
  hashedFiles: number;
  truncated: boolean;
};

type CodexPluginDoctorReport = {
  mode: string;
  platform: string;
  versionState: string;
  repairAvailable: boolean;
  writeCapable: boolean;
  readOnly: boolean;
  mutationCount: number;
  status: "ready" | "warn" | "error" | "unknown" | string;
  summary: string;
  detectedVersion: string;
  evidence: DoctorEvidence[];
  findings: DoctorFinding[];
  inventory: DoctorInventory;
  guarantees: string[];
};

const DIAGNOSTIC_FIELD_LIMIT = 600;
const DIAGNOSTIC_PATH_LIMIT = 500;

export function CodexPluginDoctorPanel({ runtimeAvailable }: { runtimeAvailable: boolean }) {
  const [report, setReport] = useState<CodexPluginDoctorReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [showAllEvidence, setShowAllEvidence] = useState(false);
  const [copied, setCopied] = useState(false);

  async function scan() {
    if (!runtimeAvailable) {
      setReport({
        mode: "read-only",
        platform: "preview",
        versionState: "unknown",
        repairAvailable: false,
        writeCapable: false,
        readOnly: true,
        mutationCount: 0,
        status: "unknown",
        summary: t("pluginDoctor.previewSummary"),
        detectedVersion: "",
        evidence: [],
        findings: [],
        inventory: { cachePresent: false, directories: 0, files: 0, links: 0, manifests: 0, hashedFiles: 0, truncated: false },
        guarantees: []
      });
      return;
    }
    setLoading(true);
    setError("");
    try {
      setReport(await invoke<CodexPluginDoctorReport>("scan_codex_plugin_doctor"));
      setShowAllEvidence(false);
    } catch (reason) {
      const raw = reason instanceof Error ? reason.message : String(reason ?? "");
      setError(raw.length > 260 ? `${raw.slice(0, 257)}…` : raw || t("pluginDoctor.scanFailedBody"));
    } finally {
      setLoading(false);
    }
  }

  async function copyReport() {
    if (!report) return;
    const inventory = report.inventory;
    const lines = [
      `AI SkillHub · ${t("pluginDoctor.eyebrow")}`,
      `${t("pluginDoctor.result")}: ${statusLabel(report.status)}`,
      `${t("pluginDoctor.copyVersion")}: ${safeDiagnosticText(report.detectedVersion || t("pluginDoctor.versionUnknown"))}`,
      `${t("pluginDoctor.copyVersionState")}: ${safeDiagnosticText(report.versionState)}`,
      `${t("pluginDoctor.copyMode")}: ${safeDiagnosticText(report.mode)} · platform=${safeDiagnosticText(report.platform, 40)} · readOnly=${report.readOnly} · writeCapable=${report.writeCapable} · repairAvailable=${report.repairAvailable}`,
      `${t("pluginDoctor.copyMutationCount")}: ${report.mutationCount}`,
      `${t("pluginDoctor.copyInventory")}: ${t("pluginDoctor.copyInventorySummary", {
        cache: String(inventory.cachePresent),
        directories: inventory.directories,
        files: inventory.files,
        links: inventory.links,
        manifests: inventory.manifests,
        hashed: inventory.hashedFiles,
        truncated: String(inventory.truncated)
      })}`,
      safeDiagnosticText(report.summary),
      "",
      `${t("pluginDoctor.copyGuarantees")}:`,
      ...(report.guarantees.length > 0
        ? report.guarantees.map(item => `- ${safeDiagnosticText(item)}`)
        : [`- ${t("pluginDoctor.copyNone")}`]),
      "",
      `${t("pluginDoctor.copyFindings")}:`,
      ...(report.findings.length > 0 ? report.findings.flatMap(item => [
        `- [${safeDiagnosticText(item.severity, 40)}] ${safeDiagnosticText(item.title)}: ${safeDiagnosticText(item.detail)}`,
        item.remediation ? `  ${t("pluginDoctor.copyRemediation")}: ${safeDiagnosticText(item.remediation)}` : ""
      ]) : [`- ${t("pluginDoctor.copyNone")}`]),
      "",
      `${t("pluginDoctor.copyEvidence")}:`,
      ...(report.evidence.length > 0 ? report.evidence.flatMap(item => [
        `- [${safeDiagnosticText(item.status, 40)}] ${safeDiagnosticText(item.label)}: ${safeDiagnosticText(item.detail)}`,
        item.redactedPath ? `  ${t("pluginDoctor.copyPath")}: ${safeDiagnosticPath(item.redactedPath)}` : ""
      ]) : [`- ${t("pluginDoctor.copyNone")}`]),
    ].filter(Boolean);
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setError(t("pluginDoctor.copyFailed"));
    }
  }

  useEffect(() => {
    void scan();
  }, [runtimeAvailable]);

  return (
    <section aria-busy={loading} className="plugin-doctor-panel glow-card">
      <header>
        <div>
          <span className="eyebrow"><Icon name="shield" /> {t("pluginDoctor.eyebrow")}</span>
          <h3>{t("pluginDoctor.title")}</h3>
          <p>{t("pluginDoctor.subtitle")}</p>
        </div>
        <div className="plugin-doctor-actions">
          <span className="readonly-badge"><Icon name="shield" /> {t("pluginDoctor.readOnly")}</span>
          <button className="ghost-action" disabled={!report || loading} onClick={() => void copyReport()} type="button">
            <Icon name="copy" /> {copied ? t("pluginDoctor.copied") : t("pluginDoctor.copy")}
          </button>
          <button className="secondary-action" disabled={loading} onClick={() => void scan()} type="button">
            <Icon className={loading ? "icon-spin" : ""} name="refresh" />
            {loading ? t("pluginDoctor.scanning") : t("pluginDoctor.scan")}
          </button>
        </div>
      </header>

      {error && <div className="plugin-doctor-error"><Icon name="alert" /><span>{error}</span></div>}
      {report && (
        <div className="plugin-doctor-body">
          <div className={`plugin-doctor-verdict verdict-${report.status}`}>
            <span className="doctor-orbit" aria-hidden="true"><i /><i /><i /></span>
            <div><span>{t("pluginDoctor.result")}</span><strong>{statusLabel(report.status)}</strong><p>{report.summary}</p></div>
            <em>{report.detectedVersion || t("pluginDoctor.versionUnknown")}</em>
          </div>
          <div className="plugin-doctor-evidence">
            {(showAllEvidence ? report.evidence : report.evidence.slice(0, 8)).map(item => (
              <article className={`evidence-${item.status}`} key={item.id}>
                <span className="evidence-state" />
                <div><strong>{item.label}</strong><p>{item.detail}</p>{item.redactedPath && <code>{item.redactedPath}</code>}</div>
              </article>
            ))}
            {report.evidence.length === 0 && <p className="empty-inline">{t("pluginDoctor.noEvidence")}</p>}
          </div>
          {report.evidence.length > 8 && (
            <button className="plugin-doctor-more ghost-action" onClick={() => setShowAllEvidence(value => !value)} type="button">
              {showAllEvidence
                ? t("pluginDoctor.showLess")
                : t("pluginDoctor.showMore", { n: report.evidence.length - 8 })}
            </button>
          )}
          {report.findings.length > 0 && (
            <details className="plugin-doctor-findings">
              <summary>{t("pluginDoctor.findings", { n: report.findings.length })}</summary>
              <ul>{report.findings.map(item => <li className={`finding-${item.severity}`} key={item.code}><strong>{item.title}</strong><span>{item.detail}</span></li>)}</ul>
            </details>
          )}
          <p className="plugin-doctor-boundary"><Icon name="info" /> {t("pluginDoctor.boundary")}</p>
        </div>
      )}
    </section>
  );
}

function statusLabel(status: string) {
  if (status === "ready") return t("pluginDoctor.ready");
  if (status === "warn") return t("pluginDoctor.warn");
  if (status === "error") return t("pluginDoctor.error");
  return t("pluginDoctor.unknown");
}

function safeDiagnosticText(value: string, limit = DIAGNOSTIC_FIELD_LIMIT) {
  return String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/((?:api[-_ ]?key|authorization|password|secret|token)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1<redacted>")
    .trim()
    .slice(0, limit);
}

function safeDiagnosticPath(value: string) {
  const path = safeDiagnosticText(value, DIAGNOSTIC_PATH_LIMIT);
  if (/^(?:[a-z]:[\\/]|\\\\|\/|file:)/i.test(path)) {
    return t("pluginDoctor.copyPathRedacted");
  }
  return path;
}
