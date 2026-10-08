// 设置 → 开发者模式 (skills contract §6.7). Release checks, the source-name unification
// panel, the router preview (dry run only) and the parent-isolation note live here and are
// hidden unless the developer switch is on. Internal words are allowed only in this module.
import { invoke } from "@tauri-apps/api/core";
import { Suspense, lazy, useState } from "react";
import { Icon } from "../icons";
import { t } from "../i18n";
import type { LegacySnapshot, RouterHubReport, SkillConflictCard } from "../types";
import { hasTauriRuntime, messageFromError, showUiToast } from "../appShared";
import { DeferredSurface } from "../components/ui";
import { Advanced } from "./Advanced";

const SourceIdentityPanel = lazy(() => import("../SourceIdentityPanel").then(module => ({ default: module.SourceIdentityPanel })));

export function DevTools({
  disabled,
  onError,
  onRunRunner,
  onSnapshotChange,
  snapshot
}: {
  disabled: boolean;
  onError: (message: string) => void;
  onRunRunner: (runnerId: string) => Promise<void>;
  onSnapshotChange: (snapshot: LegacySnapshot) => void;
  snapshot: LegacySnapshot | null;
}) {
  const conflicts = snapshot?.skillConflicts ?? [];
  return (
    <div className="dev-tools" data-testid="dev-tools">
      <Advanced disabled={disabled} onRunRunner={onRunRunner} snapshot={snapshot} />
      <Suspense fallback={<DeferredSurface label="" />}>
        <SourceIdentityPanel
          disabled={disabled}
          onApplied={onSnapshotChange}
          onError={onError}
          runtimeAvailable={hasTauriRuntime()}
        />
      </Suspense>
      <RouterHubPanel disabled={disabled} />
      {conflicts.length > 0 && <ParentIsolationPanel conflicts={conflicts} />}
    </div>
  );
}

/** Router preview: dry run only. Delivery itself is always rebuilt by the queued engine. */
function RouterHubPanel({ disabled }: { disabled: boolean }) {
  const [report, setReport] = useState<RouterHubReport | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const runtimeAvailable = hasTauriRuntime();

  async function run() {
    if (!runtimeAvailable) {
      setError(t("router.browserBlocked"));
      return;
    }
    setPending(true);
    setError("");
    try {
      const next = await invoke<RouterHubReport>("regenerate_router_hubs", { commit: false });
      setReport(next);
      showUiToast(t("router.toastDryRun", { collections: next.totalCollections, duplicates: next.duplicateChildren.length }), "ok");
    } catch (caught) {
      const message = messageFromError(caught);
      setError(message);
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="router-hub-panel panel glow-card">
      <header className="panel-head">
        <div>
          <span className="eyebrow">{t("router.eyebrow")}</span>
          <h3>{t("router.title")}</h3>
          <p>{t("router.subtitle")}</p>
        </div>
        <div className="panel-head-actions">
          <button className="ghost-action" disabled={disabled || pending} onClick={() => void run()} type="button">
            {pending ? t("router.previewing") : t("router.preview")}
          </button>
        </div>
      </header>
      {!report && !error && <p className="router-hub-hint">{t("router.hint")}</p>}
      {error && <div className="router-hub-error">{error}</div>}
      {report && (
        <div className="router-hub-stats">
          <span className="router-hub-stat"><strong>{report.totalCollections}</strong><em>{t("router.collections")}</em></span>
          <span className="router-hub-stat"><strong>{report.unchangedCount ?? report.plans.filter(plan => plan.status === "unchanged").length}</strong><em>{t("router.upToDate")}</em></span>
          <span className="router-hub-stat"><strong>{report.skippedCount}</strong><em>{t("router.skipped")}</em></span>
          <span className="router-hub-stat warn"><strong>{report.duplicateChildren.length}</strong><em>{t("router.duplicates")}</em></span>
          <span className="router-hub-stat warn"><strong>{report.healthWarnings.length}</strong><em>{t("router.formatWarnings")}</em></span>
        </div>
      )}
    </section>
  );
}

function ParentIsolationPanel({ conflicts }: { conflicts: SkillConflictCard[] }) {
  const sourceCount = new Set(conflicts.flatMap(conflict => conflict.choices.map(choice => choice.sourceName))).size;
  return (
    <section className="parent-isolation-panel glow-card">
      <span className="parent-isolation-icon" aria-hidden="true"><Icon name="shield" /></span>
      <div>
        <h3>{t("conf.parentIsolationTitle")}</h3>
        <p>{t("conf.parentIsolationBody", { conflicts: conflicts.length, sources: sourceCount })}</p>
      </div>
      <span className="parent-isolation-status"><Icon name="shield" /> {t("conf.parentIsolationActive")}</span>
    </section>
  );
}
