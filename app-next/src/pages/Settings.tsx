// Settings page. Split out of App.tsx;
// App() still owns the shared state and handlers. Never import from App.tsx here (use appShared.ts).
import { invoke } from "@tauri-apps/api/core";
import { type CSSProperties, Suspense, lazy, useEffect, useState } from "react";
import { Icon } from "../icons";
import { LANG_OPTIONS, type Lang, t } from "../i18n";
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
  friendlyErrorMessage,
  formatFileSize
} from "../appShared";
import { DeferredSurface, SegmentedToggle } from "../components/ui";

const SourceIdentityPanel = lazy(() => import("../SourceIdentityPanel").then(module => ({ default: module.SourceIdentityPanel })));

const UI_SCALE_OPTIONS: UiScalePreset[] = ["compact", "standard", "comfortable", "large"];

/* =============================================================
   Settings
   ============================================================= */

export function Settings({
  appUpdate,
  currentIconScale,
  currentLang,
  currentTextScale,
  currentTheme,
  disabled,
  onChangeIconScale,
  onChangeLang,
  onChangeTextScale,
  onChangeTheme,
  onCheckUpdate,
  onInstallUpdate,
  onOpenOfficialReleases,
  onOpenAdvanced,
  onContinueSourceUpdate,
  onSnapshotChange,
  onError,
  snapshot
}: {
  appUpdate: AppUpdateState;
  currentIconScale: UiScalePreset;
  currentLang: Lang;
  currentTextScale: UiScalePreset;
  currentTheme: ThemeName;
  disabled: boolean;
  onChangeIconScale: (scale: UiScalePreset) => void;
  onChangeLang: (lang: Lang) => void;
  onChangeTextScale: (scale: UiScalePreset) => void;
  onChangeTheme: (theme: ThemeName) => void;
  onCheckUpdate: () => void;
  onInstallUpdate: () => void;
  onOpenOfficialReleases: () => void;
  onOpenAdvanced: () => void;
  onContinueSourceUpdate: () => void;
  onSnapshotChange: (snapshot: LegacySnapshot) => void;
  onError: (message: string) => void;
  snapshot: LegacySnapshot | null;
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
      showUiToast(friendlyErrorMessage(messageFromError(error)), "error");
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
      showUiToast(
        t("set.cleanupDone", { path: operation.backupPath }),
        "ok"
      );
    } catch (error) {
      showUiToast(
        t("set.cleanupFailed", { message: friendlyErrorMessage(messageFromError(error)) }),
        "error"
      );
    } finally {
      setCleanupBusyId("");
    }
  }

  return (
    <div className="view settings-view">
      <section className="page-header glow-card">
        <div>
          <span className="eyebrow"><Icon name="settings" /> {t("nav.settings")}</span>
          <h2>{t("set.title")}</h2>
          <p>{t("set.subtitle")}</p>
        </div>
      </section>

      <section className="panel glow-card update-panel">
        <header className="panel-head">
          <div>
            <span className="eyebrow">{t("update.eyebrow")}</span>
            <h3>{t("update.title")}</h3>
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
          <div className="update-policy">
            <Icon name="shield" />
            <div>
              <strong>{t("update.signedTitle")}</strong>
              <span>{t("update.signedBody")}</span>
            </div>
          </div>
          <div className="update-actions">
            {updateBusy && (
              <span className="update-progress" aria-label={updateStatus}>
                <i style={{ "--update-progress": `${Math.max(4, appUpdate.progress)}%` } as CSSProperties} />
              </span>
            )}
            <button className="ghost-action" disabled={disabled || updateBusy} onClick={onCheckUpdate} type="button">
              <Icon className={appUpdate.phase === "checking" ? "icon-spin" : ""} name="refresh" />
              {appUpdate.phase === "checking" || appUpdate.phase === "retrying"
                ? t("update.checking")
                : t("update.check")}
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
      </section>

      {gitRuntime && !gitRuntime.available && (
        <section className="panel glow-card git-runtime-card" role="status">
          <header className="panel-head">
            <div>
              <span className="eyebrow">{t("set.gitEyebrow")}</span>
              <h3>{t("set.gitTitle")}</h3>
              <p>{t("set.gitBody")}</p>
            </div>
          </header>
          <div className="git-runtime-actions">
            {gitRuntime.wingetAvailable ? (
              <button
                className="primary-action"
                disabled={disabled || gitInstallBusy}
                onClick={() => void installGitRuntime()}
                type="button"
              >
                <Icon name="download" />
                {gitInstallBusy ? t("set.gitInstalling") : t("set.gitInstall")}
              </button>
            ) : (
              <p className="git-runtime-note">{t("set.gitNoWinget")}</p>
            )}
            <button
              className="ghost-action"
              onClick={() => void openExternalUrl(gitRuntime.downloadPageUrl)}
              type="button"
            >
              {t("set.gitOpenDownloadPage")}
            </button>
          </div>
          {gitInstallResult && (
            <p className="git-runtime-result">{gitInstallResult.summary}</p>
          )}
        </section>
      )}
      {gitRuntime?.available && (
        <section className="panel glow-card git-runtime-card is-ready" role="status">
          <header className="panel-head">
            <div>
              <span className="eyebrow">{t("set.gitEyebrow")}</span>
              <h3>{t("set.gitReadyTitle")}</h3>
              <p>{t("set.gitReadyBody", { version: gitRuntime.version })}</p>
            </div>
          </header>
        </section>
      )}

      {snapshot?.lastSyncSummary?.updateRun ? (
        <Suspense fallback={<DeferredSurface label={rt("run.title")} />}>
        <SourceUpdatePanel
          busy={disabled}
          onContinue={onContinueSourceUpdate}
          run={snapshot.lastSyncSummary.updateRun}
        />
        </Suspense>
      ) : sourceUpdateProblems.length > 0 && (
        <section className="panel glow-card source-update-problems" role="status">
          <header className="panel-head">
            <div>
              <span className="eyebrow">{t("set.sourceUpdatesEyebrow")}</span>
              <h3>{t("set.sourceUpdatesTitle")}</h3>
              <p>{t("set.sourceUpdatesBody")}</p>
            </div>
            <span className="legacy-cleanup-count">{sourceUpdateProblems.length}</span>
          </header>
          <div className="source-update-problem-list">
            {sourceUpdateProblems.map((item, index) => (
              <article className="source-update-problem-card" key={`${item.repository}-${item.status}-${index}`}>
                <span className="source-update-problem-icon" aria-hidden="true"><Icon name="alert" /></span>
                <div>
                  <strong>{item.repository}</strong>
                  <p>{sourceUpdateProblemMessage(item.status, item.action)}</p>
                </div>
                <span className={`qa-status ${item.status === "dirty-blocked" ? "planned" : "failed"}`}>
                  {item.status === "dirty-blocked"
                    ? t("set.sourceUpdatesLocalChanges")
                    : item.status === "not-git"
                      ? t("set.sourceUpdatesReinstall")
                      : t("set.sourceUpdatesRetry")}
                </span>
              </article>
            ))}
          </div>
        </section>
      )}

      <Suspense fallback={<DeferredSurface label="" />}>
      <SourceIdentityPanel
        disabled={disabled}
        onApplied={onSnapshotChange}
        onError={onError}
        runtimeAvailable={hasTauriRuntime()}
      />
      </Suspense>

      <section className="preset-concept-strip glow-card">
        <article><Icon name="folder" /><div><strong>{t("preset.folderTitle")}</strong><span>{t("preset.folderBody")}</span></div></article>
        <article><Icon name="search" /><div><strong>{t("preset.tagTitle")}</strong><span>{t("preset.tagBody")}</span></div></article>
      </section>

      {cleanupCandidates.length > 0 && (
        <section className="panel glow-card legacy-cleanup-panel">
          <header className="panel-head">
            <div>
              <span className="eyebrow">{t("set.cleanupEyebrow")}</span>
              <h3>{t("set.cleanupTitle")}</h3>
              <p>{t("set.cleanupBody")}</p>
            </div>
            <span className="legacy-cleanup-count">{cleanupCandidates.length}</span>
          </header>
          <div className="legacy-cleanup-list">
            {cleanupCandidates.map(candidate => (
              <article className="legacy-cleanup-card" key={candidate.id}>
                <div className="legacy-cleanup-icon" aria-hidden="true">
                  <Icon name="snapshots" />
                </div>
                <div className="legacy-cleanup-copy">
                  <strong>{legacyCleanupName(candidate)}</strong>
                  <p>{legacyCleanupReason(candidate)}</p>
                  <code title={candidate.path}>{candidate.path}</code>
                  <small>
                    {t("set.cleanupInventory", {
                      size: formatFileSize(candidate.totalBytes),
                      files: candidate.fileCount,
                      links: candidate.linkCount
                    })}
                  </small>
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
        </section>
      )}

      <section className="panel glow-card">
        <header className="panel-head">
          <div>
            <span className="eyebrow">{t("set.appearanceEyebrow")}</span>
            <h3>{t("set.appearanceTitle")}</h3>
          </div>
        </header>
        <div className="settings-grid">
          <div className="settings-row version-row">
            <strong>{t("set.version")}</strong>
            <span className="version-badge">AI SkillHub v{APP_VERSION}</span>
          </div>
          <div className="settings-row settings-theme-row">
            <strong>{t("set.theme")}</strong>
            <SegmentedToggle
              value={currentTheme}
              options={THEME_OPTIONS.map(option => ({ value: option.value, label: t(option.labelKey) }))}
              onChange={value => onChangeTheme(value as ThemeName)}
            />
          </div>
          <SkySceneSettingRow />
          <div className="settings-row">
            <strong>{t("set.language")}</strong>
            <SegmentedToggle
              value={currentLang}
              options={LANG_OPTIONS.map(option => ({ value: option.value, label: option.label }))}
              onChange={value => onChangeLang(value as Lang)}
            />
          </div>
          <div className="settings-row settings-scale-row">
            <span className="settings-scale-label">
              <strong>{t("set.textSize")}</strong>
              <small>{t("set.textSizeHint")}</small>
            </span>
            <SegmentedToggle
              value={currentTextScale}
              options={UI_SCALE_OPTIONS.map(value => ({ value, label: t(`set.scale.${value}`) }))}
              onChange={onChangeTextScale}
            />
          </div>
          <div className="settings-row settings-scale-row">
            <span className="settings-scale-label">
              <strong>{t("set.iconSize")}</strong>
              <small>{t("set.iconSizeHint")}</small>
            </span>
            <SegmentedToggle
              value={currentIconScale}
              options={UI_SCALE_OPTIONS.map(value => ({ value, label: t(`set.scale.${value}`) }))}
              onChange={onChangeIconScale}
            />
          </div>
        </div>
      </section>

      <section className="panel glow-card">
        <header className="panel-head">
          <div>
            <span className="eyebrow">{t("set.pathsEyebrow")}</span>
            <h3>{t("set.pathsTitle")}</h3>
            <p>{t("set.pathsBody")}</p>
          </div>
        </header>
        <div className="settings-paths">
          <div className="settings-data-note">
            <Icon name="shield" />
            <div>
              <strong>{t("set.updateSafeTitle")}</strong>
              <span>{t("set.updateSafeBody")}</span>
            </div>
          </div>
          <div className="path-row">
            <span>{t("set.centralDir")}</span>
            <code>{snapshot?.skillsDir ?? "../skills"}</code>
          </div>
          <div className="path-row">
            <span>{t("set.sourcesDir")}</span>
            <code>{snapshot?.sourcesDir ?? "../app-next/data/github_sources"}</code>
          </div>
          <div className="path-row">
            <span>{t("set.diagnostics")}</span>
            <code>{snapshot?.diagnosticsFile ?? "../app-next/reports/latest-diagnostics.json"}</code>
          </div>
        </div>
      </section>

      <section className="panel glow-card">
        <header className="panel-head">
          <div>
            <span className="eyebrow">{t("set.advancedEyebrow")}</span>
            <h3>{t("set.advancedTitle")}</h3>
            <p>{t("set.advancedBody")}</p>
          </div>
          <button className="secondary-action" onClick={onOpenAdvanced} type="button">
            <Icon name="shield" /> {t("set.openAdvanced")}
          </button>
        </header>
      </section>
    </div>
  );
}

/** Home: 3D sky islands or the simple category cards (no GPU). */
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
