// Advanced page (release gate, operation runners). Split out of App.tsx;
// App() still owns the shared state and handlers. Never import from App.tsx here (use appShared.ts).
import { invoke } from "@tauri-apps/api/core";
import { Icon } from "../icons";
import { t } from "../i18n";
import type { LegacySnapshot } from "../types";
import { hasTauriRuntime, showUiToast, formatScanTime, copyTextToClipboard } from "../appShared";
import { ToggleSwitch } from "../components/ui";

/* =============================================================
   Advanced view (merges release gate + snapshots)
   ============================================================= */

export function Advanced({
  disabled,
  onRealWriteAuthorization,
  onRunRunner,
  snapshot
}: {
  disabled: boolean;
  onRealWriteAuthorization: (enabled: boolean) => Promise<void>;
  onRunRunner: (runnerId: string) => Promise<void>;
  snapshot: LegacySnapshot | null;
}) {
  const supportRunner = snapshot?.operationRunners.find(runner => runner.id === "diagnostics-export");
  const operatorConsent = snapshot?.operatorConsent ?? {
    realWritesEnabled: false,
    enabledAt: "",
    updatedAt: "",
    summary: ""
  };

  return (
    <div className="view advanced-view">
      <section className="page-header glow-card">
        <div>
          <span className="eyebrow"><Icon name="shield" /> {t("nav.advanced")}</span>
          <h2>{t("adv.title")}</h2>
          <p>{t("adv.subtitle")}</p>
        </div>
      </section>

      <section className="panel glow-card consent-panel">
        <header className="panel-head">
          <div>
            <span className="eyebrow">{t("adv.consentEyebrow")}</span>
            <h3>{t("adv.consentTitle")}</h3>
            <p>{operatorConsent.summary}</p>
            <small>
              {operatorConsent.realWritesEnabled
                ? t("adv.consentOnSince", { time: formatScanTime(operatorConsent.enabledAt || operatorConsent.updatedAt) })
                : t("adv.consentOffHint")}
            </small>
          </div>
          <ToggleSwitch
            disabled={disabled}
            enabled={operatorConsent.realWritesEnabled}
            label={operatorConsent.realWritesEnabled ? t("adv.authorized") : t("adv.unauthorized")}
            onClick={() => void onRealWriteAuthorization(!operatorConsent.realWritesEnabled)}
          />
        </header>
      </section>

      <section className="panel glow-card support-panel">
        <header className="panel-head">
          <div>
            <span className="eyebrow">{t("adv.supportEyebrow")}</span>
            <h3>{t("adv.supportTitle")}</h3>
            <p>{t("adv.supportBody")}</p>
          </div>
          <span className={`qa-status ${supportRunner?.status === "ok" ? "done" : "planned"}`}>
            {supportRunner?.lastRunAt ? t("adv.supportReady") : t("adv.supportNotGenerated")}
          </span>
        </header>
        <div className="support-report-card">
          <div>
            <strong>{t("adv.supportReportTitle")}</strong>
            <p>{supportRunner?.summary || t("adv.supportReportHint")}</p>
            <small>{t("adv.supportPrivacy")}</small>
          </div>
          <div className="runner-actions">
            <button
              className="ghost-action small"
              disabled={disabled || !supportRunner?.exportDir}
              onClick={() => supportRunner?.exportDir && void openReleaseGateExportPath(supportRunner.exportDir)}
              type="button"
            >
              {t("adv.openDir")}
            </button>
            <button
              className="ghost-action small"
              disabled={disabled || !supportRunner?.latestJsonPath}
              onClick={() =>
                supportRunner?.latestJsonPath &&
                void copyTextToClipboard(supportRunner.latestJsonPath, t("toast.pathCopied"))
              }
              type="button"
            >
              {t("adv.copyPath")}
            </button>
            <button
              className="primary-action small"
              disabled={disabled}
              onClick={() => void onRunRunner("diagnostics-export")}
              type="button"
            >
              <Icon name="refresh" /> {t("adv.supportGenerate")}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

async function openReleaseGateExportPath(path: string) {
  if (!path.trim()) {
    showUiToast(t("toast.noOpenPath"), "warn");
    return;
  }
  if (!hasTauriRuntime()) {
    await copyTextToClipboard(path, t("toast.previewPathCopied"));
    return;
  }
  try {
    await invoke("open_release_gate_export_path", { path });
    showUiToast(t("toast.pathOpened"), "ok");
  } catch (error) {
    showUiToast(t("toast.openFailed", { message: error instanceof Error ? error.message : String(error) }), "error");
  }
}
