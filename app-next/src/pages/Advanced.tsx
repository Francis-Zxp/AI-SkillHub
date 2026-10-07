// Release support tools, shown only in 设置 → 开发者模式 (v3.3). The former consent
// pill and its switch are gone (S0-8): pause and per-tool takeover replace them.
import { invoke } from "@tauri-apps/api/core";
import { Icon } from "../icons";
import { t } from "../i18n";
import type { LegacySnapshot } from "../types";
import { hasTauriRuntime, showUiToast, copyTextToClipboard } from "../appShared";

/* =============================================================
   Advanced view (merges release gate + snapshots)
   ============================================================= */

export function Advanced({
  disabled,
  onRunRunner,
  snapshot
}: {
  disabled: boolean;
  onRunRunner: (runnerId: string) => Promise<void>;
  snapshot: LegacySnapshot | null;
}) {
  const supportRunner = snapshot?.operationRunners.find(runner => runner.id === "diagnostics-export");
  return (
    <div className="advanced-view">
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
