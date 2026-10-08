// 设置 (skills contract §6.7): 常规 · 技能库位置 · 同步 · 更新 · 历史与备份 · 帮助与诊断 ·
// 开发者模式. Language, theme and the GitHub link moved here from the top bar.
// App owns the state; never import from App.tsx here.
import { invoke } from "@tauri-apps/api/core";
import { type CSSProperties, Suspense, lazy, useEffect, useState } from "react";
import { Icon } from "../icons";
import { LANG_OPTIONS, type Lang, t } from "../i18n";
import { UI_MATERIALS, type UiMaterial } from "../uiMaterial";
import { SKY_SCENE_EVENT, setSkySceneEnabled, skySceneEnabled } from "../skyScene";
import { rt } from "../sourceUpdateRun";
import type {
  GitInstallResultCard,
  GitRuntimeCard,
  LegacyCleanupCandidateCard,
  LegacyCleanupOperationCard,
  LegacySnapshot
} from "../types";
import {
  SourceUpdatePanel,
  type ThemeName,
  type UiScalePreset,
  type AppUpdateState,
  APP_VERSION,
  THEME_OPTIONS,
  loadPreviewModule,
  hasTauriRuntime,
  showUiToast,
  messageFromError,
  formatFileSize,
  copyTextToClipboard
} from "../appShared";
import { normalizeSkillHubError } from "../skillErrors";
import { DeferredSurface, SegmentedToggle, ToggleSwitch } from "../components/ui";
import "./settings.css";

const DevTools = lazy(() => import("./DevTools").then(module => ({ default: module.DevTools })));

const UI_SCALE_OPTIONS: UiScalePreset[] = ["compact", "standard", "comfortable", "large"];
type HomeVisual = "islands" | "universe" | "summary";

export function Settings({
  appUpdate,
  busyAction,
  currentIconScale,
  currentLang,
  currentMaterial,
  currentTextScale,
  currentTheme,
  devMode,
  disabled,
  focus,
  homeVisual,
  onChangeDevMode,
  onChangeHomeVisual,
  onChangeIconScale,
  onChangeLang,
  onChangeTelemetry,
  onChangeMaterial,
  onChangeTextScale,
  onChangeTheme,
  onCheckUpdate,
  onContinueSourceUpdate,
  onError,
  onExportReport,
  onInstallUpdate,
  onOpenOfficialReleases,
  onOpenProjectHome,
  onQaStatus: _onQaStatus,
  onRefreshIndex,
  onRunRunner,
  onSetPaused,
  onSnapshotChange,
  paused,
  snapshot,
  startupVerified,
  telemetryOn
}: {
  appUpdate: AppUpdateState;
  busyAction: string;
  currentIconScale: UiScalePreset;
  currentLang: Lang;
  currentMaterial: UiMaterial;
  currentTextScale: UiScalePreset;
  currentTheme: ThemeName;
  devMode: boolean;
  disabled: boolean;
  focus: string;
  homeVisual: HomeVisual;
  onChangeDevMode: (value: boolean) => void;
  onChangeHomeVisual: (value: HomeVisual) => void;
  onChangeIconScale: (scale: UiScalePreset) => void;
  onChangeLang: (lang: Lang) => void;
  onChangeTelemetry: (value: boolean) => void;
  onChangeMaterial: (material: UiMaterial) => void;
  onChangeTextScale: (scale: UiScalePreset) => void;
  onChangeTheme: (theme: ThemeName) => void;
  onCheckUpdate: () => void;
  onContinueSourceUpdate: () => void;
  onError: (message: string) => void;
  onExportReport: () => void;
  onInstallUpdate: () => void;
  onOpenOfficialReleases: () => void;
  onOpenProjectHome: () => void;
  onQaStatus: (id: string, status: "pending" | "passed" | "failed") => void;
  onRefreshIndex: () => void;
  onRunRunner: (runnerId: string) => Promise<void>;
  onSetPaused: (paused: boolean) => void;
  onSnapshotChange: (snapshot: LegacySnapshot) => void;
  paused: boolean;
  snapshot: LegacySnapshot | null;
  startupVerified: boolean;
  telemetryOn: boolean;
}) {
  const updateBusy =
    appUpdate.phase === "checking" ||
    appUpdate.phase === "retrying" ||
    appUpdate.phase === "downloading" ||
    appUpdate.phase === "installing";
  const updateAvailable = appUpdate.phase === "available";
  const [cleanupCandidates, setCleanupCandidates] = useState<LegacyCleanupCandidateCard[]>([]);
  const [cleanupBusyId, setCleanupBusyId] = useState("");
  const [gitRuntime, setGitRuntime] = useState<GitRuntimeCard | null>(null);
  const [gitInstallBusy, setGitInstallBusy] = useState(false);
  const [gitInstallResult, setGitInstallResult] = useState<GitInstallResultCard | null>(null);
  const updateStatus = t(`update.status.${appUpdate.phase}`, {
    progress: appUpdate.progress,
    version: appUpdate.version || APP_VERSION
  });
  const updateFailureDetail = appUpdate.failure
    ? t(`update.failure.${appUpdate.failure}`, { attempts: appUpdate.attempts })
    : "";
  const actionableSourceUpdateStatuses = new Set([
    "dirty-blocked", "not-git", "failed", "timeout",
    "safety-check-failed", "governance-blocked", "pinned-missing"
  ]);
  const sourceUpdateProblems = (snapshot?.lastSyncSummary?.repositories ?? []).filter(item =>
    actionableSourceUpdateStatuses.has(item.status.trim().toLowerCase())
  );

  // Deep links such as "已暂停同步 → 设置 → 同步" scroll to and highlight the section.
  useEffect(() => {
    const section = focus.split(":")[0];
    if (!section) return;
    const element = document.getElementById(`settings-${section}`);
    if (!element) return;
    element.scrollIntoView({ block: "start", behavior: "smooth" });
    element.classList.add("flash");
    const timer = window.setTimeout(() => element.classList.remove("flash"), 1600);
    return () => window.clearTimeout(timer);
  }, [focus]);

  function sourceUpdateProblemMessage(status: string, action = "") {
    const normalized = status.trim().toLowerCase();
    // A snapshot refresh is the update path for copies installed without Git,
    // so its failure needs its own wording instead of the git fast-forward hint.
    if (action.trim().toLowerCase() === "snapshot-refresh") return t("set.sourceUpdatesSnapshot");
    if (normalized === "not-git") return t("set.sourceUpdatesNotGit");
    if (normalized === "dirty-blocked") return t("set.sourceUpdatesDirty");
    if (normalized === "timeout") return t("set.sourceUpdatesTimeout");
    if (normalized === "failed") return t("set.sourceUpdatesFailed");
    if (normalized === "safety-check-failed") return t("set.sourceUpdatesSafety");
    if (normalized === "governance-blocked" || normalized === "pinned-missing") {
      return t("set.sourceUpdatesGovernance");
    }
    return t("set.sourceUpdatesSkipped");
  }

  useEffect(() => {
    let cancelled = false;
    if (!hasTauriRuntime()) return () => { cancelled = true; };
    void invoke<LegacyCleanupCandidateCard[]>("preview_legacy_cleanup_candidates")
      .then(candidates => {
        if (!cancelled) setCleanupCandidates(candidates);
      })
      .catch(() => {
        if (!cancelled) setCleanupCandidates([]);
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!hasTauriRuntime()) {
      void loadPreviewModule().then(({ createPreviewGitRuntime }) => {
        if (!cancelled) setGitRuntime(createPreviewGitRuntime());
      });
      return () => { cancelled = true; };
    }
    void invoke<GitRuntimeCard>("read_git_runtime")
      .then(card => {
        if (!cancelled) setGitRuntime(card);
      })
      .catch(() => {
        if (!cancelled) setGitRuntime(null);
      });
    return () => { cancelled = true; };
  }, []);

  async function installGitRuntime() {
    setGitInstallBusy(true);
    try {
      const result = await invoke<GitInstallResultCard>("install_git_runtime");
      setGitInstallResult(result);
      setGitRuntime(result.runtime);
      showUiToast(
        result.summary,
        result.status === "installed" || result.status === "already-installed"
          ? "ok"
          : result.status === "restart-required"
            ? "warn"
            : "error"
      );
    } catch (error) {
      showUiToast(messageFromError(error), "error");
    } finally {
      setGitInstallBusy(false);
    }
  }

  async function openExternalUrl(url: string) {
    try {
      if (hasTauriRuntime()) {
        await invoke("plugin:opener|open_url", { url, with: null });
      } else {
        window.open(url, "_blank", "noopener,noreferrer");
      }
    } catch {
      showUiToast(t("project.openFailed"), "error");
    }
  }

  async function cleanupLegacyCandidate(candidate: LegacyCleanupCandidateCard) {
    const confirmed = window.confirm(
      t("set.cleanupConfirm", {
        name: legacyCleanupName(candidate),
        path: candidate.path,
        size: formatFileSize(candidate.totalBytes)
      })
    );
    if (!confirmed) return;
    setCleanupBusyId(candidate.id);
    try {
      const operation = await invoke<LegacyCleanupOperationCard>("cleanup_legacy_candidate", {
        candidateId: candidate.id
      });
      setCleanupCandidates(current => current.filter(item => item.id !== candidate.id));
      showUiToast(t("set.cleanupDone", { path: operation.backupPath }), "ok");
    } catch (error) {
      showUiToast(t("set.cleanupFailed", { message: normalizeSkillHubError(error).message }), "error");
    } finally {
      setCleanupBusyId("");
    }
  }

  return (
    <div className="view settings-view settings-v33" data-testid="settings-page">
      <header className="page-head-row">
        <h2>{t("nav.settings")}</h2>
        <span className="version-badge">AI SkillHub v{APP_VERSION}</span>
      </header>

      {/* 1. 常规 */}
      <section className="panel glow-card settings-section" id="settings-general">
        <header className="panel-head"><h3>{t("v33.setGeneral")}</h3></header>
        <div className="settings-grid">
          <div className="settings-row">
            <strong>{t("set.language")}</strong>
            <SegmentedToggle
              label={t("set.language")}
              value={currentLang}
              options={LANG_OPTIONS.map(option => ({ value: option.value, label: option.label }))}
              onChange={value => onChangeLang(value as Lang)}
            />
          </div>
          <div className="settings-row">
            <strong>{t("v33.homeScene")}</strong>
            <SegmentedToggle<HomeVisual>
              label={t("v33.homeScene")}
              value={homeVisual}
              options={[
                { value: "islands", label: t("v33.sceneIslands") },
                { value: "universe", label: t("v33.sceneStars") },
                { value: "summary", label: t("v33.sceneSummary") }
              ]}
              onChange={onChangeHomeVisual}
            />
          </div>
          {homeVisual === "islands" && <SkySceneSettingRow />}
          <div className="settings-row settings-theme-row">
            <strong>{t("v33.appearance")}</strong>
            <div className="theme-grid" role="radiogroup" aria-label={t("v33.appearance")}>
              {THEME_OPTIONS.map(option => (
                <button
                  aria-checked={currentTheme === option.value}
                  className={currentTheme === option.value ? "active" : ""}
                  key={option.value}
                  onClick={() => onChangeTheme(option.value)}
                  role="radio"
                  type="button"
                >
                  <Icon name={option.icon} /> {t(option.labelKey)}
                </button>
              ))}
            </div>
          </div>
          <div className="settings-row settings-scale-row">
            <span className="settings-scale-label">
              <strong>{t("v33.material")}</strong>
              <small>{t("v33.materialHint")}</small>
            </span>
            <SegmentedToggle
              label={t("v33.material")}
              value={currentMaterial}
              options={UI_MATERIALS.map(value => ({ value, label: t(`v33.material.${value}`) }))}
              onChange={onChangeMaterial}
            />
          </div>
          <div className="settings-row settings-scale-row">
            <span className="settings-scale-label">
              <strong>{t("set.textSize")}</strong>
            </span>
            <SegmentedToggle
              label={t("set.textSize")}
              value={currentTextScale}
              options={UI_SCALE_OPTIONS.map(value => ({ value, label: t(`set.scale.${value}`) }))}
              onChange={onChangeTextScale}
            />
          </div>
          <div className="settings-row settings-scale-row">
            <span className="settings-scale-label">
              <strong>{t("set.iconSize")}</strong>
            </span>
            <SegmentedToggle
              label={t("set.iconSize")}
              value={currentIconScale}
              options={UI_SCALE_OPTIONS.map(value => ({ value, label: t(`set.scale.${value}`) }))}
              onChange={onChangeIconScale}
            />
          </div>
          <div className="settings-row">
            <strong>{t("v33.projectHome")}</strong>
            <button className="ghost-action small" onClick={onOpenProjectHome} type="button"><Icon name="github" /> GitHub</button>
          </div>
        </div>
      </section>

      {/* 2. 技能库位置 */}
      <section className="panel glow-card settings-section" id="settings-library">
        <header className="panel-head"><h3>{t("v33.setLibrary")}</h3></header>
        <div className="settings-paths">
          <div className="path-row">
            <span>{t("v33.libraryPath")}</span>
            <code>{snapshot?.skillsDir ?? "—"}</code>
            <button className="ghost-action small" onClick={() => void copyTextToClipboard(snapshot?.skillsDir ?? "", t("toast.pathCopied"))} type="button"><Icon name="copy" /> {t("v33.copy")}</button>
          </div>
          <div className="path-row">
            <span>{t("v33.packsPath")}</span>
            <code>{snapshot?.sourcesDir ?? "—"}</code>
          </div>
          <p className="muted">{t("set.updateSafeBody")}</p>
          <div>
            <button className="ghost-action small" disabled={disabled} onClick={onRefreshIndex} type="button"><Icon name="refresh" /> {t("v33.rescan")}</button>
          </div>
        </div>
      </section>

      {/* 3. 同步 */}
      <section className="panel glow-card settings-section" id="settings-sync" data-testid="settings-sync">
        <header className="panel-head"><h3>{t("v33.setSync")}</h3></header>
        <div className="settings-row toggle-row">
          <span>
            <strong>{t("v33.pauseSync")}</strong>
            <small>{t("v33.pauseSentence")}</small>
          </span>
          <ToggleSwitch
            disabled={!snapshot?.skillDelivery}
            enabled={paused}
            label={t("v33.pauseSync")}
            onClick={() => onSetPaused(!paused)}
            showLabel={false}
            testId="pause-switch"
          />
        </div>
        {!startupVerified && <p className="muted">{t("v33.startupPending")}</p>}
      </section>

      {/* 4. 更新 */}
      <section className="panel glow-card settings-section update-panel" id="settings-updates">
        <header className="panel-head">
          <div>
            <h3>{t("v33.setUpdates")}</h3>
            <p>{t("update.body")}</p>
          </div>
          <span className={`qa-status ${updateAvailable ? "planned" : appUpdate.phase === "error" ? "failed" : "done"}`}>
            {updateStatus}
          </span>
        </header>
        <div className="update-console">
          <div className="update-version-stack">
            <span>{t("update.current")}</span>
            <strong>v{APP_VERSION}</strong>
            <small>{t("update.channel")}</small>
          </div>
          <div className="update-actions">
            {updateBusy && (
              <span className="update-progress" aria-label={updateStatus}>
                <i style={{ "--update-progress": `${Math.max(4, appUpdate.progress)}%` } as CSSProperties} />
              </span>
            )}
            <button className="ghost-action" disabled={disabled || updateBusy} onClick={onCheckUpdate} type="button">
              <Icon className={appUpdate.phase === "checking" ? "icon-spin" : ""} name="refresh" />
              {appUpdate.phase === "checking" || appUpdate.phase === "retrying" ? t("update.checking") : t("update.check")}
            </button>
            {updateAvailable && (
              <button className="primary-action" disabled={disabled || updateBusy} onClick={onInstallUpdate} type="button">
                <Icon name="download" /> {t("update.install", { version: appUpdate.version })}
              </button>
            )}
            {(appUpdate.phase === "error" || appUpdate.phase === "available") && (
              <button className="ghost-action" onClick={onOpenOfficialReleases} type="button">
                <Icon name="github" /> {t("update.openReleases")}
              </button>
            )}
          </div>
        </div>
        {appUpdate.phase === "error" && updateFailureDetail && (
          <div className="update-diagnostic" role="status">
            <Icon name="alert" />
            <div>
              <strong>{t(`update.stage.${appUpdate.failureStage || "check"}`)}</strong>
              <span>{updateFailureDetail}</span>
              <small>{t("update.manualFallback")}</small>
            </div>
          </div>
        )}
        {gitRuntime && !gitRuntime.available && (
          <div className="git-runtime-card" role="status">
            <div>
              <strong>{t("set.gitTitle")}</strong>
              <p>{t("set.gitBody")}</p>
            </div>
            <div className="git-runtime-actions">
              {gitRuntime.wingetAvailable ? (
                <button className="primary-action small" disabled={disabled || gitInstallBusy} onClick={() => void installGitRuntime()} type="button">
                  <Icon name="download" /> {gitInstallBusy ? t("set.gitInstalling") : t("set.gitInstall")}
                </button>
              ) : (
                <p className="git-runtime-note">{t("set.gitNoWinget")}</p>
              )}
              <button className="ghost-action small" onClick={() => void openExternalUrl(gitRuntime.downloadPageUrl)} type="button">
                {t("set.gitOpenDownloadPage")}
              </button>
            </div>
            {gitInstallResult && <p className="git-runtime-result">{gitInstallResult.summary}</p>}
          </div>
        )}
        {gitRuntime?.available && (
          <p className="muted git-runtime-card is-ready">{t("set.gitReadyBody", { version: gitRuntime.version })}</p>
        )}
        {snapshot?.lastSyncSummary?.updateRun ? (
          <Suspense fallback={<DeferredSurface label={rt("run.title")} />}>
            <SourceUpdatePanel busy={disabled} onContinue={onContinueSourceUpdate} run={snapshot.lastSyncSummary.updateRun} />
          </Suspense>
        ) : sourceUpdateProblems.length > 0 && (
          <div className="source-update-problem-list" role="status">
            <strong>{t("set.sourceUpdatesTitle")}</strong>
            {sourceUpdateProblems.map((item, index) => (
              <article className="source-update-problem-card" key={`${item.repository}-${item.status}-${index}`}>
                <span className="source-update-problem-icon" aria-hidden="true"><Icon name="alert" /></span>
                <div>
                  <strong>{item.repository}</strong>
                  <p>{sourceUpdateProblemMessage(item.status, item.action)}</p>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      {/* 5. 历史与备份 */}
      <section className="panel glow-card settings-section" id="settings-history">
        <header className="panel-head">
          <div>
            <h3>{t("v33.setHistory")}</h3>
            <p>{t("v33.historyBody")}</p>
          </div>
        </header>
        {cleanupCandidates.length > 0 && (
          <div className="legacy-cleanup-list">
            {cleanupCandidates.map(candidate => (
              <article className="legacy-cleanup-card" key={candidate.id}>
                <div className="legacy-cleanup-copy">
                  <strong>{legacyCleanupName(candidate)}</strong>
                  <p>{legacyCleanupReason(candidate)}</p>
                  <code title={candidate.path}>{candidate.path}</code>
                  <small>{t("set.cleanupInventory", { size: formatFileSize(candidate.totalBytes), files: candidate.fileCount, links: candidate.linkCount })}</small>
                </div>
                <button
                  className="secondary-action legacy-cleanup-action"
                  disabled={disabled || cleanupBusyId.length > 0}
                  onClick={() => void cleanupLegacyCandidate(candidate)}
                  type="button"
                >
                  <Icon className={cleanupBusyId === candidate.id ? "icon-spin" : ""} name={cleanupBusyId === candidate.id ? "refresh" : "snapshots"} />
                  {cleanupBusyId === candidate.id ? t("set.cleanupMoving") : t("set.cleanupAction")}
                </button>
              </article>
            ))}
          </div>
        )}
      </section>

      {/* 6. 帮助与诊断 */}
      <section className="panel glow-card settings-section" id="settings-help">
        <header className="panel-head"><h3>{t("v33.setHelp")}</h3></header>
        <div className="settings-row">
          <span>
            <strong>{t("v33.reportTitle")}</strong>
            <small>{t("v33.reportBody")}</small>
          </span>
          <button className="ghost-action small" data-testid="export-report" disabled={busyAction === "report"} onClick={onExportReport} type="button">
            <Icon className={busyAction === "report" ? "icon-spin" : ""} name="download" /> {busyAction === "report" ? t("v33.reportWorking") : t("v33.reportAction")}
          </button>
        </div>
        <div className="path-row">
          <span>{t("v33.logsPath")}</span>
          <code>{snapshot?.diagnosticsFile ?? "—"}</code>
        </div>
        <div className="settings-row toggle-row" data-testid="telemetry-row">
          <span>
            <strong>{t("v33.telemetryTitle")}</strong>
            <small>{t("v33.telemetryBody")}</small>
          </span>
          <ToggleSwitch
            disabled={false}
            enabled={telemetryOn}
            label={t("v33.telemetryTitle")}
            onClick={() => onChangeTelemetry(!telemetryOn)}
            showLabel={false}
            testId="telemetry-switch"
          />
        </div>
      </section>

      {/* 7. 开发者模式 */}
      <section className="panel glow-card settings-section" id="settings-dev">
        <div className="settings-row toggle-row">
          <span>
            <strong>{t("v33.devMode")}</strong>
            <small>{t("v33.devModeBody")}</small>
          </span>
          <ToggleSwitch disabled={false} enabled={devMode} label={t("v33.devMode")} onClick={() => onChangeDevMode(!devMode)} showLabel={false} testId="dev-mode-switch" />
        </div>
        {devMode && (
          <Suspense fallback={<DeferredSurface label="" />}>
            <DevTools disabled={disabled} onError={onError} onRunRunner={onRunRunner} onSnapshotChange={onSnapshotChange} snapshot={snapshot} />
          </Suspense>
        )}
      </section>
    </div>
  );
}

/** 群岛 style: 3D islands, or simple category cards that use no GPU (software renderers start here). */
function SkySceneSettingRow() {
  const [enabled, setEnabled] = useState(skySceneEnabled);
  useEffect(() => {
    const onChange = (event: Event) => setEnabled(Boolean((event as CustomEvent<boolean>).detail));
    window.addEventListener(SKY_SCENE_EVENT, onChange);
    return () => window.removeEventListener(SKY_SCENE_EVENT, onChange);
  }, []);
  return (
    <div className="settings-row">
      <strong>{t("set.skyScene")}</strong>
      <SegmentedToggle
        label={t("set.skyScene")}
        value={enabled ? "on" : "off"}
        options={[{ value: "on", label: t("set.skySceneOn") }, { value: "off", label: t("set.skySceneOff") }]}
        onChange={value => setSkySceneEnabled(value === "on")}
      />
    </div>
  );
}

function legacyCleanupName(candidate: LegacyCleanupCandidateCard) {
  const key = `set.cleanupCandidate.${candidate.id}.name`;
  const translated = t(key);
  return translated === key ? candidate.name : translated;
}

function legacyCleanupReason(candidate: LegacyCleanupCandidateCard) {
  const key = `set.cleanupCandidate.${candidate.id}.reason`;
  const translated = t(key);
  return translated === key ? candidate.reason : translated;
}
