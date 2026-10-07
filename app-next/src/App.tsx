import { invoke } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { type CSSProperties, Suspense, lazy, startTransition, useEffect, useMemo, useRef, useState } from "react";
import { Icon, type IconName } from "./icons";
import { ParticleField, useCardGlow } from "./effects";
import { type Lang, getLang, initialLang, setLang, t } from "./i18n";
import { rt, shouldAutoContinue, sourceUpdateFeedback, sourceUpdateToast, summarizeSourceUpdateRun } from "./sourceUpdateRun";
import { UI_ICON_SCALES, UI_ICON_SCALE_STORAGE_KEY, restoredIconScale } from "./iconScale";
import type {
  DesktopQaCheckCard,
  LegacySnapshot,
  LegacySummary,
  NavKey,
  ReleaseReportCard,
  RuntimeSnapshotHydration,
  SkillCard,
  SkillFolderCard,
  SourceCard,
  SourceImportExecutionCard,
  SourceImportPlanCard,
  SourceImportPromotionCard,
  SourcePopularityCard
} from "./types";
import {
  SourceUpdatePanel,
  type ThemeName,
  type UiScalePreset,
  type SkillDraft,
  type SourceDraft,
  type SourceImportProgressEvent,
  type ImportFeedbackOptions,
  type ToastTone,
  type AppUpdateState,
  type UpdateFailureKind,
  type UpdateFailureStage,
  TOAST_EVENT,
  APP_VERSION,
  hasInternalSkillDrag,
  loadPreviewModule,
  hasTauriRuntime,
  type SkyPhase,
  isAtlasTheme,
  atlasThemeVisual,
  themeLabel,
  showUiToast,
  messageFromError,
  createSourceImportOperationId,
  friendlyErrorMessage,
  parseTagInput,
  queryLooksLikeSkillCommand,
  normalizeSearch,
  compactSearch,
  skillMatchesSearch,
  sourceMatchesSearch,
  skillBelongsToSource,
  stableSkillClientId,
  formatScanTime,
  formatCompactNumber,
  copySkillPrompt
} from "./appShared";
import { DeferredSurface, LanguageSwitcher, ThemeSwitcher, GlobalSearchResults } from "./components/ui";
import { Advanced } from "./pages/Advanced";
import { Agents } from "./pages/Agents";
import { Dashboard } from "./pages/Dashboard";
import { Library } from "./pages/Library";
import { Settings } from "./pages/Settings";
import { Workspaces } from "./pages/Workspaces";

type SourceMutationResult = {
  source: SourceCard;
  snapshot?: LegacySnapshot | null;
  deliveryReconciled: boolean;
};
type SourcePopularityRefreshResult = {
  sourcePopularity: SourcePopularityCard[];
  summary: SourcePopularitySummary;
};
type QuickSourceDraft = Omit<SourceDraft, "name">;

function applySkillFolderCommandResult(
  snapshot: LegacySnapshot,
  command: string,
  args: Record<string, unknown>,
  folders: SkillFolderCard[]
): LegacySnapshot {
  const folderId = String(args.folderId ?? "");
  const targetFolder = folders.find(folder => folder.id === folderId);
  const folderFields = targetFolder
    ? {
        userFolderId: targetFolder.id,
        userFolderName: targetFolder.name,
        userFolderColor: targetFolder.color
      }
    : { userFolderId: "", userFolderName: "", userFolderColor: "" };

  if (command === "delete_skill_folder") {
    return {
      ...snapshot,
      skillFolders: folders,
      sources: snapshot.sources.map(source => source.userFolderId === folderId
        ? { ...source, userFolderId: "", userFolderName: "", userFolderColor: "" }
        : source),
      skills: snapshot.skills.map(skill => skill.userFolderId === folderId
        ? { ...skill, userFolderId: "", userFolderName: "", userFolderColor: "" }
        : skill)
    };
  }

  if (command === "move_source_skills_to_folder") {
    const sourceId = String(args.sourceId ?? "");
    return {
      ...snapshot,
      skillFolders: folders,
      sources: snapshot.sources.map(source => source.id === sourceId
        ? { ...source, ...folderFields }
        : source),
      skills: snapshot.skills.map(skill => skill.sourceId === sourceId
        ? { ...skill, ...folderFields }
        : skill)
    };
  }

  if (command === "move_skill_to_folder") {
    const skillId = String(args.skillId ?? "");
    const selected = snapshot.skills.find(skill => (skill.id ?? stableSkillClientId(skill)) === skillId);
    if (selected?.sourceId) {
      return {
        ...snapshot,
        skillFolders: folders,
        sources: snapshot.sources.map(source => source.id === selected.sourceId
          ? { ...source, ...folderFields }
          : source),
        skills: snapshot.skills.map(skill => skill.sourceId === selected.sourceId
          ? { ...skill, ...folderFields }
          : skill)
      };
    }
    return {
      ...snapshot,
      skillFolders: folders,
      skills: snapshot.skills.map(skill => (skill.id ?? stableSkillClientId(skill)) === skillId
        ? { ...skill, ...folderFields }
        : skill)
    };
  }

  return { ...snapshot, skillFolders: folders };
}
type OperationStatus = { title: string; detail: string; step: number; total: number; percent: number; stoppable?: boolean };
type StoredUpdateDiagnostic = {
  kind: UpdateFailureKind;
  stage: UpdateFailureStage;
  checkedAt: string;
  appVersion: string;
};
const PROJECT_HOME_URL = "https://github.com/Francis-Zxp/AI-SkillHub";
const PROJECT_RELEASES_URL = "https://github.com/Francis-Zxp/AI-SkillHub/releases/latest";
const UPDATE_DIAGNOSTIC_STORAGE_KEY = "ai-skillhub-update-diagnostic-v1";
const UPDATE_CHECK_HEADERS = { "Cache-Control": "no-cache", Pragma: "no-cache" } as const;
const UI_TEXT_SCALE_STORAGE_KEY = "ai-skillhub-ui-text-scale";
const UI_TEXT_SCALES: Record<UiScalePreset, number> = {
  compact: 0.92,
  standard: 1,
  comfortable: 1.08,
  large: 1.16
};
const NAV_ITEMS: Array<{ key: NavKey; icon: IconName }> = [
  { key: "dashboard", icon: "dashboard" },
  { key: "library", icon: "library" },
  { key: "workspaces", icon: "workspaces" },
  { key: "agents", icon: "agent" },
  { key: "connections", icon: "connections" }
];
const ADVANCED_NAV: NavKey[] = ["release", "snapshots"];
const McpCenter = lazy(() => import("./McpCenter").then(module => ({ default: module.McpCenter })));

/* =============================================================
   Root App
   ============================================================= */

export function App() {
  const [lang, setLangState] = useState<Lang>(() => {
    const initial = initialLang();
    setLang(initial);
    return initial;
  });
  const [active, setActive] = useState<NavKey>(() => initialNavKey());
  const [showUpdateResults, setShowUpdateResults] = useState(false);
  const [dashboardVisited, setDashboardVisited] = useState(active === "dashboard");
  useEffect(() => { if (active === "dashboard") setDashboardVisited(true); }, [active]);
  const [externalImportPath, setExternalImportPath] = useState("");
  const [theme, setTheme] = useState<ThemeName>(() => initialTheme());
  const skyPhase = useSkyPhase();
  // "sky-auto" follows the clock; everything that styles the app uses the
  // resolved phase, while settings keep showing the user's choice.
  const resolvedTheme: ThemeName = theme === "sky-auto" ? `sky-${skyPhase}` : theme;
  const [textScale, setTextScale] = useState<UiScalePreset>(() => initialUiScale(UI_TEXT_SCALE_STORAGE_KEY, "standard"));
  const [iconScale, setIconScale] = useState<UiScalePreset>(() => restoredIconScale(
    window.localStorage.getItem(UI_ICON_SCALE_STORAGE_KEY), window.localStorage.getItem("ai-skillhub-ui-icon-scale")
  ));
  const [sourceCheckFailed, setSourceCheckFailed] = useState(false);
  const [snapshot, setSnapshot] = useState<LegacySnapshot | null>(null);
  const [loadError, setLoadError] = useState("");
  const [loading, setLoading] = useState(true);
  const [metadataAnalyzing, setMetadataAnalyzing] = useState(false);
  const [initialDeliveryBusy, setInitialDeliveryBusy] = useState(true);
  const [startupVerified, setStartupVerified] = useState(() => !hasTauriRuntime());
  const [runtimeHydrated, setRuntimeHydrated] = useState(() => !hasTauriRuntime());
  const [startupVerificationFailed, setStartupVerificationFailed] = useState(false);
  const [startupVerificationError, setStartupVerificationError] = useState("");
  const [indexRefreshing, setIndexRefreshing] = useState(false);
  const [popularityRefreshing, setPopularityRefreshing] = useState(false);
  const [operation, setOperation] = useState<OperationStatus | null>(null);
  const [toast, setToast] = useState<{ message: string; tone: ToastTone } | null>(null);
  const [globalSearch, setGlobalSearch] = useState("");
  const [libraryFolderId, setLibraryFolderId] = useState("all");
  function openLibrary(folderId = "all") {
    setLibraryFolderId(folderId || "unfiled");
    setActive("library");
  }
  const [appUpdate, setAppUpdate] = useState<AppUpdateState>(() => initialAppUpdateState());
  const [dashboardImmersive, setDashboardImmersive] = useState(false);
  const updateRef = useRef<Update | null>(null);
  const updateCheckInFlightRef = useRef<Promise<void> | null>(null);
  const updateInstallInFlightRef = useRef<Promise<void> | null>(null);
  const updateCheckStartedAtRef = useRef(0);
  const updateRetryTimerRef = useRef<number | null>(null);
  const initialUpdateTimerRef = useRef<number | null>(null);
  const initialUpdateIdleRef = useRef<number | null>(null);
  const backgroundUpdateRetriesRef = useRef(0);
  const initialDeliveryCheckStartedRef = useRef(false);
  const initialDeliveryInFlightRef = useRef(true);
  const runtimeHydrationInFlightRef = useRef<Promise<RuntimeSnapshotHydration> | null>(null);
  const runtimeHydrationRetryRef = useRef<number | null>(null);
  const runtimeMutationGenerationRef = useRef(0);
  const mutationBusyRef = useRef(true);
  const indexRefreshInFlightRef = useRef<Promise<LegacySnapshot | null> | null>(null);
  const popularityRefreshInFlightRef = useRef<Promise<SourcePopularityRefreshResult | null> | null>(null);
  const syncInFlightRef = useRef<Promise<LegacySnapshot | null> | null>(null);
  // Set by the operation banner: finish the current round, then stop chaining.
  const updateRunStopRef = useRef(false);
  const runtimeAvailable = hasTauriRuntime();
  const realWritesEnabled = snapshot?.operatorConsent?.realWritesEnabled === true;
  const mutationBusy = loading || initialDeliveryBusy || indexRefreshing || popularityRefreshing || Boolean(operation);
  mutationBusyRef.current = mutationBusy;

  useCardGlow();

  useEffect(() => {
    if (snapshot) runtimeMutationGenerationRef.current += 1;
  }, [snapshot]);

  const summary = useMemo<LegacySummary>(
    () =>
      snapshot?.summary ?? {
        skills: 0,
        sources: 0,
        prompts: 0,
        agentsDetected: 0,
        warnings: 0,
        diagnosticsStatus: "loading"
      },
    [snapshot]
  );

  function changeLang(nextLang: Lang) {
    setLang(nextLang);
    setLangState(nextLang);
    showUiToast(t("lang.toast"), "ok");
  }

  function changeTheme(nextTheme: ThemeName) {
    setTheme(nextTheme);
    toastMessage(t("theme.toast", { theme: themeLabel(nextTheme) }), "info");
  }

  function changeTextScale(nextScale: UiScalePreset) {
    setTextScale(nextScale);
    toastMessage(t("set.displaySaved"), "ok");
  }

  function changeIconScale(nextScale: UiScalePreset) {
    setIconScale(nextScale);
    toastMessage(t("set.displaySaved"), "ok");
  }

  function toastMessage(message: string, tone: ToastTone = "info") {
    setToast({ message, tone });
  }

  function mutationBlockedBySync(notify = true, markMutation = true) {
    if (!syncInFlightRef.current && !initialDeliveryInFlightRef.current && !indexRefreshInFlightRef.current && !popularityRefreshInFlightRef.current) {
      if (markMutation) runtimeMutationGenerationRef.current += 1;
      return false;
    }
    if (notify) toastMessage(t("toast.syncBusy"), "warn");
    return true;
  }

  function scheduleInitialUpdateCheck() {
    if (!runtimeAvailable || initialUpdateTimerRef.current !== null || initialUpdateIdleRef.current !== null) return;
    initialUpdateTimerRef.current = window.setTimeout(() => {
      initialUpdateTimerRef.current = null;
      const idleWindow = window as typeof window & {
        cancelIdleCallback?: (handle: number) => void;
        requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
      };
      const run = () => {
        initialUpdateIdleRef.current = null;
        void checkForAppUpdate(true);
      };
      if (idleWindow.requestIdleCallback) {
        initialUpdateIdleRef.current = idleWindow.requestIdleCallback(run, { timeout: 2_000 });
      } else {
        run();
      }
    }, 10_000);
  }

  function cancelInitialUpdateCheck() {
    if (initialUpdateTimerRef.current !== null) {
      window.clearTimeout(initialUpdateTimerRef.current);
      initialUpdateTimerRef.current = null;
    }
    if (initialUpdateIdleRef.current !== null) {
      const idleWindow = window as typeof window & { cancelIdleCallback?: (handle: number) => void };
      idleWindow.cancelIdleCallback?.(initialUpdateIdleRef.current);
      initialUpdateIdleRef.current = null;
    }
  }

  async function openProjectHome() {
    try {
      if (runtimeAvailable) {
        await invoke("plugin:opener|open_url", { url: PROJECT_HOME_URL, with: null });
      } else {
        window.open(PROJECT_HOME_URL, "_blank", "noopener,noreferrer");
      }
    } catch {
      toastMessage(t("project.openFailed"), "error");
    }
  }

  async function openOfficialReleases() {
    try {
      if (runtimeAvailable) {
        await invoke("plugin:opener|open_url", { url: PROJECT_RELEASES_URL, with: null });
      } else {
        window.open(PROJECT_RELEASES_URL, "_blank", "noopener,noreferrer");
      }
    } catch {
      toastMessage(t("project.openFailed"), "error");
    }
  }

  async function checkForAppUpdate(silent = false) {
    if (updateCheckInFlightRef.current) {
      if (!silent) toastMessage(t("update.checkInProgress"), "info");
      await updateCheckInFlightRef.current;
      return;
    }
    const task = runAppUpdateCheck(silent);
    updateCheckInFlightRef.current = task;
    try {
      await task;
    } finally {
      if (updateCheckInFlightRef.current === task) updateCheckInFlightRef.current = null;
    }
  }

  async function runAppUpdateCheck(silent: boolean) {
    updateCheckStartedAtRef.current = Date.now();
    if (!runtimeAvailable) {
      setAppUpdate(initialAppUpdateState());
      if (!silent) toastMessage(t("update.desktopOnly"), "info");
      return;
    }
    if (updateRetryTimerRef.current !== null) {
      window.clearTimeout(updateRetryTimerRef.current);
      updateRetryTimerRef.current = null;
    }
    if (!silent) backgroundUpdateRetriesRef.current = 0;

    const retryDelays = [0];
    let lastFailure: UpdateFailureKind = "unknown";
    for (let attempt = 0; attempt < retryDelays.length; attempt += 1) {
      const delay = retryDelays[attempt];
      if (delay > 0) {
        if (silent) await waitFor(delay);
        else {
        setAppUpdate(current => ({
          ...current,
          phase: "retrying",
          progress: attempt,
          failure: "",
          failureStage: "",
          attempts: attempt + 1
        }));
        await waitFor(delay);
        }
      } else if (!silent) {
        setAppUpdate(current => ({
          ...current,
          phase: "checking",
          progress: 0,
          failure: "",
          failureStage: "",
          attempts: attempt + 1
        }));
      }

      try {
        const nextUpdate = await check({ headers: UPDATE_CHECK_HEADERS, timeout: 8_000 });
        backgroundUpdateRetriesRef.current = 0;
        clearStoredUpdateDiagnostic();
        if (!nextUpdate) {
          if (updateRef.current) {
            await updateRef.current.close().catch(() => undefined);
            updateRef.current = null;
          }
          setAppUpdate({
            phase: "latest",
            progress: 100,
            version: APP_VERSION,
            failure: "",
            failureStage: "",
            attempts: attempt + 1,
            checkedAt: new Date().toISOString()
          });
          if (!silent) toastMessage(t("update.latestToast"), "ok");
          return;
        }
        if (updateRef.current) await updateRef.current.close().catch(() => undefined);
        updateRef.current = nextUpdate;
        setAppUpdate({
          phase: "available",
          progress: 0,
          version: nextUpdate.version,
          failure: "",
          failureStage: "",
          attempts: attempt + 1,
          checkedAt: new Date().toISOString()
        });
        toastMessage(t("update.availableToast", { version: nextUpdate.version }), "info");
        return;
      } catch (error) {
        lastFailure = classifyUpdateFailure(error, "check");
        // Store only an allowlisted category and timestamp. Raw transport
        // errors can contain proxy URLs or local details and never reach UI/storage.
      }
    }

    const checkedAt = new Date().toISOString();
    persistUpdateDiagnostic({ kind: lastFailure, stage: "check", checkedAt, appVersion: APP_VERSION });
    setAppUpdate({
      phase: "error",
      progress: 0,
      version: "",
      failure: lastFailure,
      failureStage: "check",
      attempts: retryDelays.length,
      checkedAt
    });
    const retryNumber = backgroundUpdateRetriesRef.current;
    if (retryNumber < 3) {
      backgroundUpdateRetriesRef.current += 1;
      const retryAfter = [30_000, 120_000, 480_000][retryNumber];
      updateRetryTimerRef.current = window.setTimeout(() => {
        updateRetryTimerRef.current = null;
        void checkForAppUpdate(true);
      }, retryAfter);
    }
    if (!silent) {
      toastMessage(
        backgroundUpdateRetriesRef.current > 0 ? t("update.retryToast") : t("update.errorToast"),
        "error"
      );
    }
  }

  async function installAppUpdate() {
    if (updateInstallInFlightRef.current) {
      await updateInstallInFlightRef.current;
      return;
    }
    const task = runAppUpdateInstall();
    updateInstallInFlightRef.current = task;
    try {
      await task;
    } finally {
      if (updateInstallInFlightRef.current === task) updateInstallInFlightRef.current = null;
    }
  }

  async function runAppUpdateInstall() {
    const nextUpdate = updateRef.current;
    if (!nextUpdate) {
      await checkForAppUpdate(false);
      return;
    }
    let downloaded = 0;
    let total = 0;
    const installStage: { current: UpdateFailureStage } = { current: "download" };
    setAppUpdate(current => ({ ...current, phase: "downloading", progress: 1 }));
    try {
      await nextUpdate.downloadAndInstall(event => {
        if (event.event === "Started") {
          total = event.data.contentLength ?? 0;
          downloaded = 0;
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          const progress = total > 0 ? Math.min(94, Math.max(2, Math.round((downloaded / total) * 94))) : 36;
          setAppUpdate(current => ({ ...current, phase: "downloading", progress }));
        } else {
          installStage.current = "install";
          setAppUpdate(current => ({ ...current, phase: "installing", progress: 98 }));
        }
      }, { headers: UPDATE_CHECK_HEADERS, timeout: 600_000 });
      setAppUpdate(current => ({ ...current, phase: "installing", progress: 100 }));
      await relaunch();
    } catch (error) {
      const stage = installStage.current;
      const failure = classifyUpdateFailure(error, stage);
      const checkedAt = new Date().toISOString();
      persistUpdateDiagnostic({ kind: failure, stage, checkedAt, appVersion: APP_VERSION });
      setAppUpdate(current => ({
        ...current,
        phase: "error",
        progress: 0,
        failure,
        failureStage: stage,
        checkedAt
      }));
      toastMessage(t(stage === "install" ? "update.failure.install" : "update.errorToast"), "error");
    }
  }

  function applySnapshot(nextSnapshot: LegacySnapshot, background = false) {
    if (background) startTransition(() => setSnapshot(nextSnapshot));
    else setSnapshot(nextSnapshot);
  }

  function markAfterNextPaint(name: string) {
    if (performance.getEntriesByName(name).length > 0) return;
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        if (performance.getEntriesByName(name).length === 0) performance.mark(name);
      });
    });
  }

  /* ---- backend bridges ---- */

  async function loadSnapshot(
    mode: "indexed" | "refresh" | "scan" = "indexed",
    options: { background?: boolean; quiet?: boolean; continueRun?: boolean } = {}
  ): Promise<LegacySnapshot | null> {
    if (!options.background) setLoading(true);
    try {
      if (!runtimeAvailable) {
        const { createPreviewSnapshot } = await loadPreviewModule();
        const previewSnapshot = createPreviewSnapshot();
        setSnapshot(previewSnapshot);
        setLoadError("");
        return previewSnapshot;
      }
      const command = mode === "refresh"
        ? "run_skillhub_sync"
        : mode === "scan"
          ? "scan_legacy_snapshot"
          : "load_indexed_snapshot";
      const result = mode === "refresh" && options.continueRun
        ? await invoke<LegacySnapshot>(command, { continueRun: true })
        : await invoke<LegacySnapshot>(command);
      applySnapshot(result, Boolean(options.background));
      if (mode === "indexed") markAfterNextPaint("ai-skillhub-index-visible");
      setLoadError("");
      if (mode !== "indexed" && !options.quiet) toastMessage(t("toast.refreshDone"), "ok");
      return result;
    } catch (error) {
      setLoadError(messageFromError(error));
      return null;
    } finally {
      if (!options.background) setLoading(false);
    }
  }

  async function updateEnabled(command: string, id: string, enabled: boolean) {
    if (mutationBlockedBySync()) return;
    setLoading(true);
    try {
      if (!runtimeAvailable) {
        const { createPreviewSnapshot, updatePreviewEnabled } = await loadPreviewModule();
        setSnapshot(prev => updatePreviewEnabled(prev ?? createPreviewSnapshot(), command, id, enabled));
        setLoadError("");
        return;
      }
      const result = await invoke<LegacySnapshot>(command, { id, enabled });
      setSnapshot(result);
      setLoadError("");
      toastMessage(enabled ? t("toast.enabledDb") : t("toast.disabledDb"), "ok");
    } catch (error) {
      setLoadError(messageFromError(error));
    } finally {
      setLoading(false);
    }
  }

  async function updateDesktopQaStatus(id: string, status: "pending" | "passed" | "failed") {
    if (mutationBlockedBySync()) return;
    setLoading(true);
    try {
      if (!runtimeAvailable) {
        const { createPreviewSnapshot, updatePreviewDesktopQaStatus } = await loadPreviewModule();
        setSnapshot(prev => updatePreviewDesktopQaStatus(prev ?? createPreviewSnapshot(), id, status));
        return;
      }
      const result = await invoke<LegacySnapshot>("set_desktop_qa_check_status", { id, status });
      setSnapshot(result);
      toastMessage(t("set.toastQa"), "ok");
    } catch (error) {
      setLoadError(messageFromError(error));
    } finally {
      setLoading(false);
    }
  }

  async function updateSkillMetadata(
    skill: SkillCard,
    draft: SkillDraft
  ): Promise<"failed" | "preview" | "saved"> {
    if (mutationBlockedBySync()) return "failed";
    if (!runtimeAvailable) return "preview";
    setLoading(true);
    try {
      let result = await invoke<LegacySnapshot>("set_skill_metadata", {
        folderName: skill.folderName,
        name: draft.name,
        category: draft.category,
        description: draft.description,
        note: draft.note
      });
      result = await invoke<LegacySnapshot>("set_skill_tags", {
        folderName: skill.folderName,
        tags: parseTagInput(draft.tags)
      });
      setSnapshot(result);
      setLoadError("");
      toastMessage(t("toast.skillSaved"), "ok");
      return "saved";
    } catch (error) {
      setLoadError(messageFromError(error));
      toastMessage(t("toast.saveFailed"), "error");
      return "failed";
    } finally {
      setLoading(false);
    }
  }

  async function updateSkillEnabled(skill: SkillCard, enabled: boolean): Promise<boolean> {
    if (mutationBlockedBySync()) return false;
    if (!runtimeAvailable) return false;
    setLoading(true);
    try {
      const result = await invoke<LegacySnapshot>("set_skill_enabled", {
        folderName: skill.folderName,
        enabled
      });
      setSnapshot(result);
      setLoadError("");
      toastMessage(enabled ? t("toast.skillOn") : t("toast.skillOff"), "ok");
      return true;
    } catch (error) {
      setLoadError(messageFromError(error));
      toastMessage(t("toast.skillToggleFailed"), "error");
      return true;
    } finally {
      setLoading(false);
    }
  }

  async function updateSkillRating(skill: SkillCard, rating: number): Promise<boolean> {
    if (mutationBlockedBySync()) return false;
    const normalizedRating = Math.max(0, Math.min(5, Math.round(rating)));
    if (!runtimeAvailable) {
      const { createPreviewSnapshot, updatePreviewSkillRating } = await loadPreviewModule();
      setSnapshot(prev =>
        updatePreviewSkillRating(prev ?? createPreviewSnapshot(), skill.folderName, normalizedRating)
      );
      toastMessage(
        normalizedRating > 0
          ? t("toast.skillRated", { n: normalizedRating })
          : t("toast.skillRatingCleared"),
        "ok"
      );
      return true;
    }
    setLoading(true);
    try {
      const result = await invoke<LegacySnapshot>("set_skill_rating", {
        folderName: skill.folderName,
        rating: normalizedRating
      });
      setSnapshot(result);
      setLoadError("");
      toastMessage(
        normalizedRating > 0
          ? t("toast.skillRated", { n: normalizedRating })
          : t("toast.skillRatingCleared"),
        "ok"
      );
      return true;
    } catch (error) {
      setLoadError(messageFromError(error));
      toastMessage(t("toast.skillRatingFailed"), "error");
      return false;
    } finally {
      setLoading(false);
    }
  }

  async function setSourceVersionPin(source: SourceCard, pinned: boolean): Promise<boolean> {
    if (mutationBlockedBySync()) return false;
    if (!runtimeAvailable) {
      const { createPreviewSnapshot } = await loadPreviewModule();
      setSnapshot(previous => {
        const current = previous ?? createPreviewSnapshot();
        return {
          ...current,
          sourceGovernance: current.sourceGovernance.map(item =>
            item.sourceId === source.id
              ? {
                  ...item,
                  pinned,
                  pinnedRevision: pinned ? item.currentRevision : "",
                  status: pinned ? "pinned" : "ready",
                  message: pinned
                    ? "Sync will keep this exact revision."
                    : "Automatic source updates are enabled."
                }
              : item
          )
        };
      });
      toastMessage(pinned ? t("governance.toastPinned") : t("governance.toastUnpinned"), "ok");
      return true;
    }
    setLoading(true);
    try {
      const result = await invoke<LegacySnapshot>("set_source_version_pin", {
        sourceId: source.id,
        pinned
      });
      setSnapshot(result);
      setLoadError("");
      toastMessage(pinned ? t("governance.toastPinned") : t("governance.toastUnpinned"), "ok");
      return true;
    } catch (error) {
      setLoadError(messageFromError(error));
      toastMessage(t("governance.toastFailed"), "error");
      return false;
    } finally {
      setLoading(false);
    }
  }

  async function refreshSourceVersionStatus(source: SourceCard): Promise<boolean> {
    if (mutationBlockedBySync()) return false;
    if (!runtimeAvailable) {
      const { createPreviewSnapshot } = await loadPreviewModule();
      setSnapshot(previous => {
        const current = previous ?? createPreviewSnapshot();
        return {
          ...current,
          sourceGovernance: current.sourceGovernance.map(item =>
            item.sourceId === source.id
              ? { ...item, lastCheckedAt: new Date().toISOString(), diffSource: "live" }
              : item
          )
        };
      });
      toastMessage(t("governance.toastRefreshed"), "ok");
      return true;
    }
    setLoading(true);
    try {
      const result = await invoke<LegacySnapshot>("refresh_source_version_status", {
        sourceId: source.id
      });
      setSnapshot(result);
      setLoadError("");
      toastMessage(t("governance.toastRefreshed"), "ok");
      return true;
    } catch (error) {
      setLoadError(messageFromError(error));
      toastMessage(t("governance.toastFailed"), "error");
      return false;
    } finally {
      setLoading(false);
    }
  }

  async function rollbackSourceVersion(source: SourceCard): Promise<boolean> {
    if (mutationBlockedBySync()) return false;
    if (!runtimeAvailable) {
      const { createPreviewSnapshot } = await loadPreviewModule();
      setSnapshot(previous => {
        const current = previous ?? createPreviewSnapshot();
        return {
          ...current,
          sourceGovernance: current.sourceGovernance.map(item =>
            item.sourceId === source.id
              ? {
                  ...item,
                  currentRevision: item.latestBackupRevision || item.currentRevision,
                  pinnedRevision: item.latestBackupRevision || item.currentRevision,
                  pinned: true,
                  relation: "rolled-back",
                  status: "pinned"
                }
              : item
          )
        };
      });
      toastMessage(t("governance.toastRolledBack"), "ok");
      return true;
    }
    setLoading(true);
    try {
      const result = await invoke<LegacySnapshot>("rollback_source_to_latest_backup", {
        sourceId: source.id
      });
      setSnapshot(result);
      setLoadError("");
      toastMessage(t("governance.toastRolledBack"), "ok");
      return true;
    } catch (error) {
      setLoadError(messageFromError(error));
      toastMessage(t("governance.toastFailed"), "error");
      return false;
    } finally {
      setLoading(false);
    }
  }

  async function updateSourceMetadata(
    source: SourceCard,
    draft: SourceDraft
  ): Promise<"failed" | "preview" | "saved"> {
    if (mutationBlockedBySync()) return "failed";
    if (!runtimeAvailable) return "preview";
    setLoading(true);
    try {
      const result = await invoke<SourceMutationResult>("save_source_metadata", {
        sourceId: source.id,
        name: draft.name,
        sourceType: draft.sourceType,
        category: draft.category,
        note: draft.note,
        enabled: draft.enabled,
        tags: parseTagInput(draft.tags)
      });
      startTransition(() => {
        setSnapshot(current => {
          if (result.snapshot) return result.snapshot;
          if (!current) return current;
          return {
            ...current,
            sources: current.sources.map(item => item.id === result.source.id ? result.source : item),
            skills: current.skills.map(skill => skill.sourceId === result.source.id
              ? { ...skill, source: result.source.name }
              : skill)
          };
        });
      });
      setLoadError("");
      toastMessage(t("toast.sourceSaved"), "ok");
      return "saved";
    } catch (error) {
      setLoadError(messageFromError(error));
      toastMessage(t("toast.sourceSaveFailed"), "error");
      return "failed";
    } finally {
      setLoading(false);
    }
  }

  async function deleteSource(source: SourceCard): Promise<"failed" | "preview" | "deleted"> {
    if (mutationBlockedBySync()) return "failed";
    if (!runtimeAvailable) {
      const { createPreviewSnapshot } = await loadPreviewModule();
      setSnapshot(prev => {
        const current = prev ?? createPreviewSnapshot();
        return {
          ...current,
          sources: current.sources.filter(item => item.id !== source.id),
          skills: current.skills.filter(skill => !skillBelongsToSource(skill, source))
        };
      });
      toastMessage(t("toast.sourceDeletePreview"), "info");
      return "preview";
    }
    setLoading(true);
    try {
      const result = await invoke<LegacySnapshot>("delete_managed_source", { sourceId: source.id });
      setSnapshot(result);
      setLoadError("");
      toastMessage(t("toast.sourceDeleted"), "ok");
      return "deleted";
    } catch (error) {
      setLoadError(messageFromError(error));
      toastMessage(t("toast.sourceDeleteFailed"), "error");
      return "failed";
    } finally {
      setLoading(false);
    }
  }

  async function runReleaseGateRunner(runnerId: string) {
    if (mutationBlockedBySync()) return;
    setLoading(true);
    try {
      if (!runtimeAvailable) {
        const { createPreviewSnapshot, updatePreviewOperationRunner } = await loadPreviewModule();
        setSnapshot(prev => updatePreviewOperationRunner(prev ?? createPreviewSnapshot(), runnerId));
        toastMessage(t("toast.previewRunnerSim"), "info");
        return;
      }
      const result = await invoke<LegacySnapshot>("run_release_gate_runner", { runnerId });
      setSnapshot(result);
      setLoadError("");
      toastMessage(t("adv.toastRunnerDone"), "ok");
    } catch (error) {
      setLoadError(messageFromError(error));
      toastMessage(t("adv.toastRunnerFailed"), "error");
    } finally {
      setLoading(false);
    }
  }

  async function updateRealWriteAuthorization(enabled: boolean) {
    if (mutationBlockedBySync()) return;
    setLoading(true);
    try {
      if (!runtimeAvailable) {
        const { createPreviewSnapshot, updatePreviewRealWriteAuthorization } = await loadPreviewModule();
        setSnapshot(prev => updatePreviewRealWriteAuthorization(prev ?? createPreviewSnapshot(), enabled));
        toastMessage(enabled ? t("toast.previewAuthOn") : t("toast.previewAuthOff"), "info");
        return;
      }
      const result = await invoke<LegacySnapshot>("set_real_write_authorization", { enabled });
      setSnapshot(result);
      setLoadError("");
      toastMessage(enabled ? t("adv.toastAuthOn") : t("adv.toastAuthOff"), "ok");
    } catch (error) {
      setLoadError(messageFromError(error));
      toastMessage(t("adv.toastAuthFailed"), "error");
    } finally {
      setLoading(false);
    }
  }

  async function recordUsage(
    targetType: string,
    targetId: string,
    targetName: string,
    sourceName: string,
    eventType: string
  ) {
    if (mutationBlockedBySync(false, false)) return;
    if (!runtimeAvailable) return;
    try {
      await invoke<void>("record_usage_event", {
        targetType,
        targetId,
        targetName,
        sourceName,
        eventType
      });
    } catch (error) {
      setLoadError(messageFromError(error));
    }
  }

  async function refreshSourcePopularity(
    options: { quiet?: boolean; background?: boolean } = {}
  ): Promise<SourcePopularityRefreshResult | null> {
    if (popularityRefreshInFlightRef.current) return popularityRefreshInFlightRef.current;
    if (mutationBlockedBySync(!options.quiet, false)) return null;
    const task = runSourcePopularityRefresh(options);
    popularityRefreshInFlightRef.current = task;
    setPopularityRefreshing(true);
    try {
      return await task;
    } finally {
      if (popularityRefreshInFlightRef.current === task) popularityRefreshInFlightRef.current = null;
      setPopularityRefreshing(false);
    }
  }

  async function runSourcePopularityRefresh(
    options: { quiet?: boolean; background?: boolean }
  ): Promise<SourcePopularityRefreshResult | null> {
    if (!runtimeAvailable) {
      const { createPreviewSnapshot } = await loadPreviewModule();
      const previewSnapshot = snapshot ?? createPreviewSnapshot();
      setSnapshot(previous => previous ?? previewSnapshot);
      if (!options.quiet) toastMessage(t("pop.previewToast"), "info");
      return {
        sourcePopularity: previewSnapshot.sourcePopularity,
        summary: summarizeSourcePopularity(previewSnapshot)
      };
    }
    if (!options.background) setLoading(true);
    try {
      const result = await invoke<SourcePopularityRefreshResult>("refresh_source_popularity");
      const applyPopularity = () => setSnapshot(current => current
        ? { ...current, sourcePopularity: result.sourcePopularity }
        : current);
      if (options.background) startTransition(applyPopularity);
      else applyPopularity();
      setLoadError("");
      if (!options.quiet) {
        const summaryText = sourcePopularityRefreshMessage(result.summary);
        toastMessage(summaryText, "ok");
      }
      return result;
    } catch (error) {
      setLoadError(messageFromError(error));
      if (!options.quiet) toastMessage(t("pop.toastFailed"), "error");
      return null;
    } finally {
      if (!options.background) setLoading(false);
    }
  }

  async function reanalyzeLibraryMetadata(): Promise<LegacySnapshot | null> {
    if (mutationBlockedBySync()) return null;
    if (!runtimeAvailable) {
      const { createPreviewSnapshot } = await loadPreviewModule();
      toastMessage(t("metadata.previewToast"), "info");
      return snapshot ?? createPreviewSnapshot();
    }
    setLoading(true);
    setMetadataAnalyzing(true);
    try {
      const result = await invoke<LegacySnapshot>("reanalyze_library_metadata");
      setSnapshot(result);
      setLoadError("");
      toastMessage(
        t("metadata.doneToast", {
          skills: result.skills.length,
          sources: result.sources.length
        }),
        "ok"
      );
      return result;
    } catch (error) {
      setLoadError(messageFromError(error));
      toastMessage(t("metadata.failedToast"), "error");
      return null;
    } finally {
      setMetadataAnalyzing(false);
      setLoading(false);
    }
  }

  async function refreshLocalIndex(): Promise<LegacySnapshot | null> {
    if (indexRefreshInFlightRef.current) return indexRefreshInFlightRef.current;
    setIndexRefreshing(true);
    const pending = loadSnapshot("scan", { background: true, quiet: true });
    indexRefreshInFlightRef.current = pending;
    try {
      return await pending;
    } finally {
      if (indexRefreshInFlightRef.current === pending) {
        indexRefreshInFlightRef.current = null;
        setIndexRefreshing(false);
      }
    }
  }

  async function syncAndRefreshAll(
    options: { refreshPopularity?: boolean; continueRun?: boolean } = {}
  ): Promise<LegacySnapshot | null> {
    if (syncInFlightRef.current) {
      toastMessage(t("toast.syncBusy"), "warn");
      return syncInFlightRef.current;
    }
    const task = runCoreSync(Boolean(options.continueRun));
    syncInFlightRef.current = task;
    let refreshed: LegacySnapshot | null = null;
    try {
      refreshed = await task;
      return refreshed;
    } finally {
      if (syncInFlightRef.current === task) syncInFlightRef.current = null;
      if (refreshed && runtimeAvailable && options.refreshPopularity !== false) {
        void refreshSourcePopularity({ background: true });
      }
    }
  }

  async function runCoreSync(continueRun = false): Promise<LegacySnapshot | null> {
    setSourceCheckFailed(false);
    updateRunStopRef.current = false;
    setOperation({ title: t("op.syncTitle"), detail: t("op.step1"), step: 1, total: 1, percent: 28 });
    try {
      let refreshed = await loadSnapshot("refresh", { background: true, quiet: true, continueRun });
      if (!refreshed) {
        setSourceCheckFailed(true);
        toastMessage(t("toast.syncFailed"), "error");
        return null;
      }
      if (!runtimeAvailable) return refreshed;
      // One click finishes the whole run: sources the Git budget could not
      // reach are continued in further bounded rounds, never silently dropped.
      let rounds = 1;
      while (shouldAutoContinue(refreshed.lastSyncSummary?.updateRun, rounds, updateRunStopRef.current)) {
        const run = summarizeSourceUpdateRun(refreshed.lastSyncSummary?.updateRun);
        rounds += 1;
        setOperation({
          title: t("op.syncTitle"),
          detail: rt("run.continuing", { n: run.pending, round: rounds }),
          step: run.checked,
          total: run.total,
          percent: run.total > 0 ? (run.checked / run.total) * 100 : 50,
          stoppable: true
        });
        const next = await loadSnapshot("refresh", { background: true, quiet: true, continueRun: true });
        if (!next) { setSourceCheckFailed(true); break; }
        refreshed = next;
      }
      setOperation({ title: t("op.syncTitle"), detail: t("op.step3"), step: 1, total: 1, percent: 100 });
      const runToast = sourceUpdateToast(refreshed.lastSyncSummary?.updateRun);
      if (runToast) {
        const stoppedEarly = updateRunStopRef.current && summarizeSourceUpdateRun(refreshed.lastSyncSummary?.updateRun).pending > 0;
        toastMessage(
          stoppedEarly ? rt("run.stopped", { n: summarizeSourceUpdateRun(refreshed.lastSyncSummary?.updateRun).pending }) : runToast.message,
          stoppedEarly ? "warn" : runToast.tone
        );
        await waitFor(650);
        return refreshed;
      }
      const syncSummary = refreshed.lastSyncSummary;
      const syncTone = syncSummary?.status === "failed"
        ? "error"
        : syncSummary?.status === "partial" || syncSummary?.status === "no-network-update"
          ? "warn"
          : "ok";
      const syncMessage = syncSummary?.status === "partial"
        ? t("toast.syncPartial", { ok: syncSummary.succeeded, failed: syncSummary.failed, skipped: syncSummary.skipped })
        : syncSummary?.status === "failed"
          ? t("toast.syncAllFailed", { failed: syncSummary.failed })
          : syncSummary?.status === "no-network-update"
            ? t("toast.syncLocalOnly", { skipped: syncSummary.skipped })
            : t("toast.syncDone");
      toastMessage(syncMessage, syncTone);
      await waitFor(650);
      return refreshed;
    } finally {
      setOperation(null);
    }
  }

  async function refreshLocalAgents(connect = false): Promise<LegacySnapshot | null> {
    if (mutationBlockedBySync()) return null;
    if (!runtimeAvailable) {
      const { createPreviewSnapshot } = await loadPreviewModule();
      const previewSnapshot = createPreviewSnapshot();
      setSnapshot(previewSnapshot);
      toastMessage(t("agents.detectToast"), "ok");
      return previewSnapshot;
    }
    setLoading(true);
    try {
      const refreshed = await invoke<LegacySnapshot>(connect ? "connect_detected_agents" : "refresh_agent_detection");
      setSnapshot(refreshed);
      setLoadError("");
      toastMessage(t(connect ? "agents.connectToast" : "agents.detectToast"), "ok");
      return refreshed;
    } catch (error) {
      setLoadError(messageFromError(error));
      return null;
    } finally {
      setLoading(false);
    }
  }

  /* ---- import wizard bridges ---- */

  async function previewSourceImportCandidate(
    importKind: string,
    input: string,
    options: ImportFeedbackOptions = {}
  ): Promise<SourceImportPlanCard> {
    if (!runtimeAvailable) {
      const { createPreviewSourceImportPlan } = await loadPreviewModule();
      const preview = createPreviewSourceImportPlan(importKind, input, snapshot?.sources ?? []);
      if (!options.quiet) {
        toastMessage(
          preview.safeToContinue ? t("toast.previewImportPlanSafe") : t("toast.previewImportPlanRisk"),
          preview.safeToContinue ? "ok" : "warn"
        );
      }
      return preview;
    }
    const result = await invoke<SourceImportPlanCard>("preview_source_import_candidate", {
      importKind,
      input
    });
    if (!options.quiet) {
      toastMessage(
        result.safeToContinue ? t("toast.importPlanSafe") : t("toast.importPlanRisk"),
        result.safeToContinue ? "ok" : "warn"
      );
    }
    return result;
  }

  async function stageSourceImportCandidate(
    importKind: string,
    input: string,
    options: ImportFeedbackOptions = {}
  ): Promise<SourceImportExecutionCard> {
    if (!runtimeAvailable) {
      const { createPreviewSourceImportExecution } = await loadPreviewModule();
      const execution = createPreviewSourceImportExecution(importKind, input);
      if (!options.quiet) toastMessage(t("toast.previewStaging"), "info");
      return execution;
    }
    const operationId = options.operationId ?? createSourceImportOperationId();
    let unlisten: (() => void) | null = null;
    try {
      const { listen } = await import("@tauri-apps/api/event");
      unlisten = await listen<SourceImportProgressEvent>("source-import-progress", event => {
        if (event.payload.operationId === operationId) options.onProgress?.(event.payload);
      });
    } catch (error) {
      console.warn("Source import progress events are unavailable; continuing without live progress.", error);
    }
    try {
      const result = await invoke<SourceImportExecutionCard>("stage_source_import_candidate", {
        operationId,
        importKind,
        input
      });
      if (!options.quiet) toastMessage(result.status === "staged" ? t("toast.staged") : t("toast.stageDone"), "info");
      return result;
    } finally {
      unlisten?.();
    }
  }

  async function cancelSourceImport(operationId: string): Promise<boolean> {
    if (!runtimeAvailable) return false;
    return invoke<boolean>("cancel_source_import", { operationId });
  }

  async function promoteStagedSourceImport(
    importKind: string,
    stagedPath: string,
    sourceName: string,
    options: ImportFeedbackOptions = {}
  ): Promise<SourceImportPromotionCard> {
    if (!runtimeAvailable) {
      const { createPreviewSourceImportPromotion } = await loadPreviewModule();
      const promotion = createPreviewSourceImportPromotion(importKind, stagedPath, sourceName);
      if (!options.quiet) toastMessage(t("toast.previewPromotion"), "info");
      return promotion;
    }
    const result = await invoke<SourceImportPromotionCard>("promote_staged_source_import", {
      importKind,
      stagedPath,
      sourceName,
      securityReviewConfirmed: options.securityReviewConfirmed === true
    });
    if (!options.quiet) {
      toastMessage(result.status === "promoted" ? t("toast.promoted") : t("toast.promoteBlockedToast"), "info");
    }
    return result;
  }

  async function updateSourceRating(source: SourceCard, rating: number): Promise<boolean> {
    if (mutationBlockedBySync()) return false;
    const normalizedRating = Math.max(0, Math.min(5, Math.round(rating)));
    if (!runtimeAvailable) {
      const { createPreviewSnapshot } = await loadPreviewModule();
      setSnapshot(previous => {
        const current = previous ?? createPreviewSnapshot();
        return {
          ...current,
          sources: current.sources.map(item =>
            item.id === source.id ? { ...item, rating: normalizedRating } : item
          )
        };
      });
      toastMessage(
        normalizedRating > 0
          ? t("toast.sourceRated", { n: normalizedRating })
          : t("toast.sourceRatingCleared"),
        "ok"
      );
      return true;
    }
    setLoading(true);
    try {
      const result = await invoke<LegacySnapshot>("set_source_rating", {
        sourceId: source.id,
        rating: normalizedRating
      });
      setSnapshot(result);
      setLoadError("");
      toastMessage(
        normalizedRating > 0
          ? t("toast.sourceRated", { n: normalizedRating })
          : t("toast.sourceRatingCleared"),
        "ok"
      );
      return true;
    } catch (error) {
      setLoadError(messageFromError(error));
      toastMessage(t("toast.sourceRatingFailed"), "error");
      return false;
    } finally {
      setLoading(false);
    }
  }

  async function runSkillFolderCommand(
    command: string,
    args: Record<string, unknown>,
    successMessage: string
  ): Promise<LegacySnapshot | null> {
    if (mutationBlockedBySync()) return null;
    if (!runtimeAvailable) {
      toastMessage(t("folders.previewOnly"), "info");
      return snapshot;
    }
    try {
      const currentSnapshot = snapshot ?? (await loadPreviewModule()).createPreviewSnapshot();
      const folders = await invoke<SkillFolderCard[]>(command, args);
      const fallbackResult = applySkillFolderCommandResult(
        currentSnapshot,
        command,
        args,
        folders
      );
      setSnapshot(current => applySkillFolderCommandResult(
        current ?? currentSnapshot,
        command,
        args,
        folders
      ));
      setLoadError("");
      if (successMessage) toastMessage(successMessage, "ok");
      return fallbackResult;
    } catch (error) {
      const message = messageFromError(error);
      setLoadError(message);
      toastMessage(message, "error");
      return null;
    }
  }

  /* ---- lifecycle ---- */

  function scheduleDeferredRuntimeRetry(isCancelled: () => boolean) {
    if (isCancelled() || runtimeHydrationRetryRef.current !== null) return;
    runtimeHydrationRetryRef.current = window.setTimeout(() => {
      runtimeHydrationRetryRef.current = null;
      void hydrateDeferredRuntime(isCancelled);
    }, 100);
  }

  async function hydrateDeferredRuntime(isCancelled: () => boolean = () => false) {
    if (!runtimeAvailable || isCancelled() || runtimeHydrationInFlightRef.current) return;
    if (mutationBusyRef.current) {
      scheduleDeferredRuntimeRetry(isCancelled);
      return;
    }
    const generation = runtimeMutationGenerationRef.current;
    const task = invoke<RuntimeSnapshotHydration>("hydrate_runtime_snapshot");
    runtimeHydrationInFlightRef.current = task;
    let retry = false;
    try {
      const hydration = await task;
      if (isCancelled()) return;
      if (generation !== runtimeMutationGenerationRef.current || mutationBusyRef.current) {
        retry = true;
        return;
      }
      setSnapshot(current => current ? { ...current, ...hydration } : current);
      setRuntimeHydrated(true);
      markAfterNextPaint("ai-skillhub-runtime-hydrated");
    } catch {
      // Core SQLite content is already usable. A deferred local-status read must
      // never blank the library or turn a successful startup into a failure;
      // the next verification/manual refresh can retry it.
      if (!isCancelled()) setRuntimeHydrated(false);
    } finally {
      if (runtimeHydrationInFlightRef.current === task) {
        runtimeHydrationInFlightRef.current = null;
      }
      if (retry && !isCancelled()) scheduleDeferredRuntimeRetry(isCancelled);
    }
  }

  async function verifyStartupSnapshot(
    loadIndexed: boolean,
    isCancelled: () => boolean = () => false,
    initialRun = false
  ) {
    if (!initialRun && (initialDeliveryInFlightRef.current || mutationBusy || mutationBlockedBySync(false, false))) return;
    let verified = !runtimeAvailable;
    initialDeliveryInFlightRef.current = true;
    setInitialDeliveryBusy(true);
    setStartupVerificationFailed(false);
    setStartupVerificationError("");
    try {
      if (loadIndexed) {
        const indexed = await loadSnapshot();
        if (!indexed) {
          if (!isCancelled()) setStartupVerificationError(t("error.verificationFailed"));
          return;
        }
        if (isCancelled()) return;
      }
      if (!runtimeAvailable || isCancelled()) return;
      // The SQLite snapshot is already visible. Startup only verifies the
      // parent-first delivery fingerprint and link health; a full Agent scan is
      // intentionally reserved for the explicit refresh action.
      const delivered = await invoke<LegacySnapshot>("ensure_agent_skill_delivery");
      if (isCancelled()) return;
      applySnapshot(delivered, true);
      verified = true;
    } catch (error) {
      if (!isCancelled()) setStartupVerificationError(messageFromError(error));
    } finally {
      initialDeliveryInFlightRef.current = false;
      if (!isCancelled()) {
        setStartupVerified(verified);
        setStartupVerificationFailed(runtimeAvailable && !verified);
        setInitialDeliveryBusy(false);
        if (verified) markAfterNextPaint("ai-skillhub-controls-unlocked");
        scheduleInitialUpdateCheck();
        if (verified && runtimeAvailable) void hydrateDeferredRuntime(isCancelled);
      }
    }
  }

  useEffect(() => {
    if (initialDeliveryCheckStartedRef.current) return;
    initialDeliveryCheckStartedRef.current = true;
    let cancelled = false;
    const startTimer = window.setTimeout(() => {
      void verifyStartupSnapshot(true, () => cancelled, true);
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(startTimer);
      initialDeliveryCheckStartedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!runtimeAvailable) return;
    return () => {
      cancelInitialUpdateCheck();
      if (runtimeHydrationRetryRef.current !== null) {
        window.clearTimeout(runtimeHydrationRetryRef.current);
        runtimeHydrationRetryRef.current = null;
      }
      if (updateRetryTimerRef.current !== null) {
        window.clearTimeout(updateRetryTimerRef.current);
        updateRetryTimerRef.current = null;
      }
      if (updateRef.current) {
        void updateRef.current.close().catch(() => undefined);
        updateRef.current = null;
      }
    };
  }, [runtimeAvailable]);

  useEffect(() => {
    if (!runtimeAvailable) return;
    const checkAfterReconnect = () => void checkForAppUpdate(true);
    const checkAfterResume = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - updateCheckStartedAtRef.current < 15 * 60_000) return;
      void checkForAppUpdate(true);
    };
    window.addEventListener("online", checkAfterReconnect);
    document.addEventListener("visibilitychange", checkAfterResume);
    return () => {
      window.removeEventListener("online", checkAfterReconnect);
      document.removeEventListener("visibilitychange", checkAfterResume);
    };
  }, [runtimeAvailable]);

  useEffect(() => {
    const preventExternalDropNavigation = (event: globalThis.DragEvent) => {
      if (!event.dataTransfer || hasInternalSkillDrag(event.dataTransfer)) return;
      const types = Array.from(event.dataTransfer.types);
      if (types.some(type => type === "Files" || type === "text/plain" || type === "text/uri-list")) {
        event.preventDefault();
      }
    };
    window.addEventListener("dragover", preventExternalDropNavigation);
    window.addEventListener("drop", preventExternalDropNavigation);
    return () => {
      window.removeEventListener("dragover", preventExternalDropNavigation);
      window.removeEventListener("drop", preventExternalDropNavigation);
    };
  }, []);

  useEffect(() => {
    document.body.dataset.theme = resolvedTheme;
    window.localStorage.setItem("ai-skillhub-theme", theme);
  }, [theme, resolvedTheme]);

  useEffect(() => {
    document.documentElement.style.setProperty("--ui-text-scale", String(UI_TEXT_SCALES[textScale]));
    window.localStorage.setItem(UI_TEXT_SCALE_STORAGE_KEY, textScale);
  }, [textScale]);

  useEffect(() => {
    document.documentElement.style.setProperty("--ui-icon-scale", String(UI_ICON_SCALES[iconScale]));
    window.localStorage.setItem(UI_ICON_SCALE_STORAGE_KEY, iconScale);
  }, [iconScale]);

  useEffect(() => {
    document.documentElement.lang = lang === "zh" ? "zh-CN" : lang === "ko" ? "ko" : "en";
  }, [lang]);

  useEffect(() => {
    document.scrollingElement?.scrollTo({ top: 0, left: 0, behavior: "auto" });
    if (active !== "dashboard") setDashboardImmersive(false);
  }, [active]);

  useEffect(() => {
    if (!dashboardImmersive) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDashboardImmersive(false);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [dashboardImmersive]);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ message: string; tone?: ToastTone }>).detail;
      if (detail?.message) setToast({ message: detail.message, tone: detail.tone ?? "info" });
    };
    window.addEventListener(TOAST_EVENT, handler as EventListener);
    return () => window.removeEventListener(TOAST_EVENT, handler as EventListener);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 3200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (!toast) return;
    const notification = document.querySelector<HTMLElement>(".toast");
    const footers = [...document.querySelectorAll<HTMLElement>(".atlas-touchbar, .atlas-event-tape")];
    const placeToast = () => {
      const occupied = footers.filter(element => element.getClientRects().length > 0)
        .map(element => Math.max(0, window.innerHeight - element.getBoundingClientRect().top));
      notification?.style.setProperty("--toast-bottom", `${Math.max(88, ...occupied.map(height => height + 20))}px`);
    };
    const observer = new ResizeObserver(placeToast);
    footers.forEach(element => observer.observe(element));
    window.addEventListener("resize", placeToast);
    placeToast();
    return () => { observer.disconnect(); window.removeEventListener("resize", placeToast); };
  }, [toast, active, theme, textScale, dashboardImmersive]);

  /* ---- global search results ---- */

  const skillCommandSearch = queryLooksLikeSkillCommand(globalSearch);
  const globalSearchResults = useMemo(() => {
    const skills = (snapshot?.skills ?? [])
      .filter(skill => skillMatchesSearch(skill, globalSearch))
      .sort((a, b) => skillSearchScore(b, globalSearch) - skillSearchScore(a, globalSearch))
      .slice(0, skillCommandSearch ? 12 : 8);
    const sources = skillCommandSearch
      ? []
      : (snapshot?.sources ?? [])
          .filter(source => sourceMatchesSearch(source, globalSearch))
          .sort((a, b) => sourceSearchScore(b, globalSearch) - sourceSearchScore(a, globalSearch))
          .slice(0, 8);
    return { skills, sources };
  }, [globalSearch, skillCommandSearch, snapshot]);

  const operationProgress = operation ? Math.max(1, Math.min(100, Math.round(operation.percent))) : 0;
  const updateFeedback = useMemo(() => sourceCheckFailed
    ? { label: rt("run.checkFailed"), message: t("toast.syncFailed"), tone: "error" as const }
    : runtimeAvailable ? sourceUpdateFeedback(snapshot?.lastSyncSummary?.updateRun, snapshot?.sources) : null,
  [sourceCheckFailed, snapshot?.lastSyncSummary?.updateRun, snapshot?.sources, lang]);
  const advancedActive = active === "release" || active === "snapshots";
  const atlasMode = isAtlasTheme(resolvedTheme);
  const atlasVisual = atlasThemeVisual(resolvedTheme);

  return (
    <main
      className={`${runtimeAvailable ? "shell" : "shell browser-preview-shell"} theme-${resolvedTheme} ${atlasMode ? "theme-family-atlas" : "theme-family-classic"}${resolvedTheme.startsWith("sky-") ? " theme-family-sky" : ""} page-${active} lang-${lang}${dashboardImmersive && active === "dashboard" ? " dashboard-immersive" : ""}`}
      data-runtime-hydrated={runtimeHydrated ? "true" : "false"}
      style={{
        "--ui-icon-scale": UI_ICON_SCALES[iconScale],
        "--ui-text-scale": UI_TEXT_SCALES[textScale]
      } as CSSProperties}
    >
      {atlasMode && active !== "dashboard" && (
        <ParticleField
          accent={atlasVisual.accent}
          mode="backdrop"
          palette={atlasVisual.palette}
          sourceCount={summary.sources}
          skillCount={summary.skills}
        />
      )}
      <aside className="sidebar">
        <div className="brand">
          <img alt="AI SkillHub" className="brand-logo" src="/ai-skillhub-logo.png" />
          <div>
            <strong>AI SkillHub</strong>
            <span>{t("app.subtitle")}</span>
          </div>
        </div>
        <span className="atlas-rail-mark" aria-hidden="true">V3 · KINETIC ATLAS</span>

        <nav className="nav" aria-label="primary">
          {NAV_ITEMS.map(item => (
            <button
              className={active === item.key ? "nav-item active" : "nav-item"}
              key={item.key}
              onClick={() => item.key === "library" ? openLibrary() : setActive(item.key)}
              type="button"
            >
              <span className="nav-icon" aria-hidden="true"><Icon name={item.icon} /></span>
              <span className="nav-text">
                <strong>{t(`nav.${item.key}`)}</strong>
                <small>{t(`nav.${item.key}.hint`)}</small>
              </span>
            </button>
          ))}
        </nav>

        <div className="sidebar-footer">
          <button
            className={active === "settings" ? "nav-item active" : "nav-item"}
            onClick={() => setActive("settings")}
            type="button"
          >
            <span className="nav-icon" aria-hidden="true"><Icon name="settings" /></span>
            <span className="nav-text">
              <strong>{t("nav.settings")}</strong>
            </span>
          </button>
          <button
            className={advancedActive ? "nav-item active" : "nav-item"}
            onClick={() => setActive("release")}
            type="button"
          >
            <span className="nav-icon" aria-hidden="true"><Icon name="shield" /></span>
            <span className="nav-text">
              <strong>{t("nav.advanced")}</strong>
            </span>
          </button>
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div className="command-search">
            <span className="search-icon" aria-hidden="true"><Icon name="search" /></span>
            <input
              aria-label="Search"
              onChange={event => setGlobalSearch(event.target.value)}
              onKeyDown={event => {
                if (event.key === "Enter" && globalSearch.trim()) openLibrary();
              }}
              placeholder={t("topbar.searchPlaceholder")}
              value={globalSearch}
            />
            <kbd>⌘</kbd>
            <kbd>K</kbd>
          </div>
          <div className="topbar-actions">
            <LanguageSwitcher current={lang} onChange={changeLang} />
            <ThemeSwitcher current={theme} onChange={changeTheme} />
            <button
              aria-label={t("project.openGithub")}
              className="icon-button project-home-link"
              onClick={() => void openProjectHome()}
              title={t("project.openGithub")}
              type="button"
            >
              <Icon name="github" />
            </button>
            {appUpdate.phase === "available" && (
              <button className="update-available-pill" onClick={() => setActive("settings")} type="button">
                <Icon name="download" />
                <span>{t("update.availableShort", { version: appUpdate.version })}</span>
              </button>
            )}
            <button
              className="primary-pill"
              disabled={mutationBusy}
              onClick={() => void syncAndRefreshAll()}
              title={updateFeedback ? `${t("topbar.sync")} · ${updateFeedback.message}` : t("topbar.sync")}
              aria-label={updateFeedback ? `${updateFeedback.label} · ${t("topbar.sync")}` : t("topbar.sync")}
              type="button"
            >
              <Icon className={loading || initialDeliveryBusy || indexRefreshing || Boolean(operation) ? "icon-spin" : ""} name="refresh" />
              <span>
                {runtimeAvailable
                  ? operation
                    ? t("topbar.backgroundSync")
                    : loading
                      ? snapshot
                        ? t("topbar.processing")
                        : t("topbar.loadingIndex")
                      : startupVerificationFailed
                        ? t("topbar.verificationFailed")
                        : initialDeliveryBusy || !startupVerified
                          ? t("topbar.verifyingIndex")
                          : realWritesEnabled
                            ? updateFeedback?.label ?? t("topbar.sync")
                            : t("topbar.refreshIndex")
                  : loading
                    ? t("topbar.loading")
                    : t("topbar.reloadPreview")}
              </span>
            </button>
            <span className={runtimeAvailable ? "status-pill" : "status-pill preview"}>
              <span className="status-dot" />
              {runtimeAvailable
                ? realWritesEnabled
                  ? t("topbar.statusAuthorized")
                  : t("topbar.statusUnauthorized")
                : t("topbar.statusPreview")}
            </span>
            {snapshot?.lastSyncSummary?.updateRun && (
              <button className="icon-button" type="button" title={rt("run.title")} aria-label={rt("run.title")} aria-expanded={showUpdateResults} onClick={() => setShowUpdateResults(value => !value)}><Icon name="info" /></button>
            )}
          </div>
        </header>

        <div className="workspace-body">
          {!runtimeAvailable && (
            <section className="preview-panel">
              <Icon name="info" />
              <div>
                <strong>{t("preview.title")}</strong>
                <span>{t("preview.body")}</span>
              </div>
            </section>
          )}

          {operation && (
            <section className="operation-banner" role="status" aria-live="polite">
              <div>
                <strong>{operation.title}</strong>
                <span>{operation.detail}</span>
              </div>
              <em>{operationProgress}% · {operation.step}/{operation.total}</em>
              {operation.stoppable && (
                <button
                  className="ghost-action small"
                  onClick={() => {
                    updateRunStopRef.current = true;
                    setOperation(current => current ? { ...current, stoppable: false } : current);
                  }}
                  type="button"
                >
                  {rt("run.stop")}
                </button>
              )}
              <i style={{ "--operation-progress": `${operationProgress}%` } as CSSProperties} />
            </section>
          )}

          {showUpdateResults && snapshot?.lastSyncSummary?.updateRun && (
            <div className="update-results-popover">
              <button className="ghost-action small" type="button" onClick={() => setShowUpdateResults(false)}>{t("common.close")}</button>
              <Suspense fallback={<DeferredSurface label={rt("run.title")} />}>
                <SourceUpdatePanel run={snapshot.lastSyncSummary.updateRun} busy={mutationBusy} initiallyExpanded />
              </Suspense>
            </div>
          )}

          {loadError && (
            <section className="status-banner error" role="alert">
              <Icon name="alert" />
              <div>
                <strong>{t("error.title")}</strong>
                <span>{friendlyErrorMessage(loadError)}</span>
              </div>
            </section>
          )}

          {startupVerificationFailed && (
            <section className="status-banner error" role="alert">
              <Icon name="alert" />
              <div>
                <strong>{t("topbar.verificationFailed")}</strong>
                <span>{friendlyErrorMessage(startupVerificationError || t("error.verificationFailed"))}</span>
              </div>
              <button
                className="ghost-action small"
                disabled={mutationBusy}
                onClick={() => void verifyStartupSnapshot(!snapshot)}
                type="button"
              >
                <Icon name="refresh" /> {t("error.retryVerification")}
              </button>
            </section>
          )}

          {globalSearch.trim() && (
            <GlobalSearchResults
              onClear={() => setGlobalSearch("")}
              onOpenLibrary={() => openLibrary()}
              onCopySkill={skill => void copySkillPrompt(skill, recordUsage)}
              query={globalSearch}
              skills={globalSearchResults.skills}
              sources={globalSearchResults.sources}
            />
          )}

          {(dashboardVisited || active === "dashboard") && (
            <Dashboard
              visible={active === "dashboard"}
              immersive={dashboardImmersive}
              loading={mutationBusy}
              onCopySkill={skill => void copySkillPrompt(skill, recordUsage)}
              onOpenAdvanced={() => setActive("release")}
              onOpenAgents={() => setActive("agents")}
              onOpenLibrary={() => openLibrary()}
              onOpenFolder={folderId => {
                setGlobalSearch("");
                openLibrary(folderId);
              }}
              onOpenSkill={skill => {
                setGlobalSearch(`$${skill.name}`);
                openLibrary();
              }}
              onOpenSource={source => {
                setGlobalSearch(source.name);
                openLibrary();
              }}
              onRefreshPopularity={() => void refreshSourcePopularity()}
              onSync={() => void syncAndRefreshAll()}
              onToggleImmersive={() => setDashboardImmersive(value => !value)}
              snapshot={snapshot}
              summary={summary}
              syncing={Boolean(operation)}
              updateFeedback={updateFeedback}
              theme={resolvedTheme}
            />
          )}
          {active === "library" && (
            <Library
              metadataAnalyzing={metadataAnalyzing}
              suggestedLocalPath={externalImportPath}
              onDismissLocalImport={() => setExternalImportPath("")}
              loading={mutationBusy}
              onDeleteSource={deleteSource}
              onCreateFolder={(name, note, color) => runSkillFolderCommand(
                "create_skill_folder", { name, note, color }, t("folders.created")
              )}
              onDeleteFolder={folderId => runSkillFolderCommand(
                "delete_skill_folder", { folderId }, t("folders.deleted")
              )}
              onCancelImport={cancelSourceImport}
              onPreviewImport={previewSourceImportCandidate}
              onStageImport={stageSourceImportCandidate}
              onPromoteImport={promoteStagedSourceImport}
              onReanalyzeMetadata={reanalyzeLibraryMetadata}
              onConsolidateSources={async () => {
                if (!runtimeAvailable || mutationBusy) return null;
                setLoading(true);
                try {
                  const result = await invoke<LegacySnapshot>("consolidate_duplicate_sources");
                  setSnapshot(result);
                  toastMessage(getLang() === "zh" ? "重复来源已整理，备份已保留。" : getLang() === "ko" ? "중복 소스를 정리하고 백업을 보관했습니다." : "Duplicate sources consolidated; backups retained.", "ok");
                  return result;
                } catch (error) { setLoadError(messageFromError(error)); return null; }
                finally { setLoading(false); }
              }}
              onRefreshIndex={localOnly => localOnly
                ? refreshLocalIndex()
                : syncAndRefreshAll({ refreshPopularity: false })}
              onRecordUsage={recordUsage}
              onSaveSkillMetadata={updateSkillMetadata}
              onSaveSourceMetadata={updateSourceMetadata}
              onMoveFolder={(folderId, direction) => runSkillFolderCommand(
                "move_skill_folder", { folderId, direction }, ""
              )}
              onMoveSkillToFolder={(skillId, folderId) => runSkillFolderCommand(
                "move_skill_to_folder", { skillId, folderId }, t("folders.moved")
              )}
              onMoveSourceSkillsToFolder={(sourceId, folderId) => runSkillFolderCommand(
                "move_source_skills_to_folder", { sourceId, folderId }, t("folders.movedSource")
              )}
              onSetSkillEnabled={updateSkillEnabled}
              onSetSkillRating={updateSkillRating}
              onSetSourceRating={updateSourceRating}
              onSetSourceVersionPin={setSourceVersionPin}
              onUpdateFolder={(folderId, name, note, color) => runSkillFolderCommand(
                "update_skill_folder", { folderId, name, note, color }, t("folders.updated")
              )}
              onRefreshSourceVersion={refreshSourceVersionStatus}
              onRollbackSourceVersion={rollbackSourceVersion}
              atlasMode={atlasMode}
              realWritesEnabled={realWritesEnabled}
              searchQuery={globalSearch}
              selectedFolderId={libraryFolderId}
              onSelectFolder={setLibraryFolderId}
              snapshot={snapshot}
            />
          )}
          {active === "workspaces" && (
            <Workspaces disabled={mutationBusy} onToggle={updateEnabled} snapshot={snapshot} />
          )}
          {active === "agents" && (
            <Agents
              disabled={mutationBusy}
              onImportLocalSkill={path => {
                setExternalImportPath(path);
                setGlobalSearch("");
                openLibrary();
              }}
              onRefreshAgents={() => void refreshLocalAgents()}
              onConnectAgents={() => void refreshLocalAgents(true)}
              runtimeAvailable={runtimeAvailable}
              snapshot={snapshot}
            />
          )}
          {active === "connections" && (
            <Suspense fallback={<DeferredSurface label={t("mcp.scanning")} />}>
              <McpCenter runtimeAvailable={runtimeAvailable} />
            </Suspense>
          )}
          {(active === "release" || active === "snapshots") && (
            <Advanced
              disabled={mutationBusy}
              onRealWriteAuthorization={updateRealWriteAuthorization}
              onRunRunner={runReleaseGateRunner}
              snapshot={snapshot}
            />
          )}
          {active === "settings" && (
            <Settings
              currentIconScale={iconScale}
              currentLang={lang}
              currentTextScale={textScale}
              currentTheme={theme}
              disabled={mutationBusy}
              appUpdate={appUpdate}
              onChangeIconScale={changeIconScale}
              onChangeLang={changeLang}
              onChangeTextScale={changeTextScale}
              onChangeTheme={changeTheme}
              onCheckUpdate={() => void checkForAppUpdate(false)}
              onInstallUpdate={() => void installAppUpdate()}
              onOpenOfficialReleases={() => void openOfficialReleases()}
              onOpenAdvanced={() => setActive("release")}
              onContinueSourceUpdate={() => void syncAndRefreshAll({ continueRun: true, refreshPopularity: false })}
              onSnapshotChange={next => {
                setSnapshot(next);
                toastMessage(getLang() === "zh" ? "来源命名已统一，索引与 AI 工具链接已重建。" : getLang() === "ko" ? "소스 이름을 통일하고 인덱스와 AI 도구 링크를 다시 만들었습니다." : "Source names unified; index and AI tool links rebuilt.", "ok");
              }}
              onError={message => setLoadError(message)}
              snapshot={snapshot}
            />
          )}
        </div>

        <footer className="atlas-event-tape" aria-label={t("atlas.eventTape")}>
          <span><i /> {t("atlas.liveIndex")}</span>
          <span>Skills <strong>{summary.skills.toLocaleString()}</strong></span>
          <span>{getLang() === "zh" ? "来源" : getLang() === "ko" ? "소스" : "Sources"} <strong>{summary.sources.toLocaleString()}</strong></span>
          <span className="atlas-event-mode">{runtimeAvailable ? t("atlas.desktopMode") : t("atlas.previewMode")}</span>
        </footer>

        {toast && (
          <div className={`toast tone-${toast.tone} is-visible`} role="status">
            <Icon name={toast.tone === "error" ? "alert" : toast.tone === "ok" ? "sparkle" : "info"} />
            <span>{toast.message}</span>
          </div>
        )}
      </section>
      <div id="app-overlay-root" />
    </main>
  );
}

function initialNavKey(): NavKey {
  if (typeof window === "undefined") return "dashboard";
  const view = new URLSearchParams(window.location.search).get("view");
  return isNavKey(view) ? view : "dashboard";
}

const DEFAULT_THEME: ThemeName = "sky-auto";
const SKY_THEME_MIGRATION_KEY = "ai-skillhub-theme-sky-default-v2";

/** Morning 5–10, midday 10–15, afternoon 15–19, night otherwise (local time). */
function skyPhaseAt(date: Date): SkyPhase {
  const hour = date.getHours();
  if (hour >= 5 && hour < 10) return "dawn";
  if (hour >= 10 && hour < 15) return "noon";
  if (hour >= 15 && hour < 19) return "golden";
  return "night";
}

function useSkyPhase(): SkyPhase {
  const [phase, setPhase] = useState<SkyPhase>(() => skyPhaseAt(new Date()));
  useEffect(() => {
    const timer = window.setInterval(() => setPhase(skyPhaseAt(new Date())), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  return phase;
}

function initialTheme(): ThemeName {
  if (typeof window === "undefined") return DEFAULT_THEME;
  const searchTheme = new URLSearchParams(window.location.search).get("theme");
  if (isThemeName(searchTheme)) return searchTheme;
  try {
    const savedTheme = window.localStorage.getItem("ai-skillhub-theme");
    // One time only: the earlier Sky day/dusk pair, the previous default and
    // fresh installs move to the time-of-day Sky theme. Any other saved
    // choice is kept, and every older theme stays selectable.
    if (!window.localStorage.getItem(SKY_THEME_MIGRATION_KEY)) {
      window.localStorage.setItem(SKY_THEME_MIGRATION_KEY, "1");
      if (!isThemeName(savedTheme) || savedTheme === "nocturne" || savedTheme === "atlas-legacy-light" || savedTheme === "atlas-light") {
        window.localStorage.setItem("ai-skillhub-theme", DEFAULT_THEME);
        return DEFAULT_THEME;
      }
    }
    return isThemeName(savedTheme) ? savedTheme : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

function initialUiScale(storageKey: string, fallback: UiScalePreset): UiScalePreset {
  if (typeof window === "undefined") return fallback;
  const value = window.localStorage.getItem(storageKey);
  return isUiScalePreset(value) ? value : fallback;
}

function isUiScalePreset(value: string | null): value is UiScalePreset {
  return value === "compact" || value === "standard" || value === "comfortable" || value === "large";
}

function isThemeName(value: string | null): value is ThemeName {
  return (
    value === "sky-auto" ||
    value === "sky-dawn" ||
    value === "sky-noon" ||
    value === "sky-golden" ||
    value === "sky-night" ||
    value === "nocturne" ||
    value === "parchment" ||
    value === "atlas-dark" ||
    value === "atlas-light" ||
    value === "atlas-legacy-dark" ||
    value === "atlas-legacy-light" ||
    value === "dark" ||
    value === "light" ||
    value === "classic-dark" ||
    value === "classic-light"
  );
}

function isNavKey(value: string | null): value is NavKey {
  return (
    value === "dashboard" ||
    value === "library" ||
    value === "workspaces" ||
    value === "sources" ||
    value === "agents" ||
    value === "connections" ||
    value === "snapshots" ||
    value === "release" ||
    value === "settings"
  );
}

function initialAppUpdateState(): AppUpdateState {
  const diagnostic = readStoredUpdateDiagnostic();
  return {
    phase: "idle",
    progress: 0,
    version: "",
    failure: diagnostic?.kind ?? "",
    failureStage: diagnostic?.stage ?? "",
    attempts: 0,
    checkedAt: diagnostic?.checkedAt ?? ""
  };
}

function classifyUpdateFailure(error: unknown, stage: UpdateFailureStage): UpdateFailureKind {
  const message = messageFromError(error).toLocaleLowerCase("en-US");
  if (/timed?\s*out|timeout|deadline/.test(message)) return "timeout";
  if (/tls|ssl|certificate|cert\b|unexpected end of file/.test(message)) return "tls";
  if (/proxy|407\b|tunnel/.test(message)) return "proxy";
  if (/signature|minisign|public key|verification/.test(message)) return "signature";
  if (/permission|access denied|eacces|eperm|privilege/.test(message)) return "permission";
  if (/manifest|json|semver|invalid version|release metadata|status code 4\d\d/.test(message)) return "manifest";
  if (/network|dns|connect|connection|request|socket|resolve|host|offline|failed to send/.test(message)) {
    return "network";
  }
  if (stage === "download") return "download";
  if (stage === "install") return "install";
  return "unknown";
}

function readStoredUpdateDiagnostic(): StoredUpdateDiagnostic | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(UPDATE_DIAGNOSTIC_STORAGE_KEY);
    if (!raw || raw.length > 1_024) return null;
    const value = JSON.parse(raw) as Partial<StoredUpdateDiagnostic>;
    const kinds: UpdateFailureKind[] = [
      "network", "timeout", "tls", "proxy", "manifest", "signature", "permission", "download", "install", "unknown"
    ];
    const stages: UpdateFailureStage[] = ["check", "download", "install"];
    if (!kinds.includes(value.kind as UpdateFailureKind) || !stages.includes(value.stage as UpdateFailureStage)) return null;
    if (typeof value.checkedAt !== "string" || !Number.isFinite(Date.parse(value.checkedAt))) return null;
    if (typeof value.appVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(value.appVersion)) return null;
    return value as StoredUpdateDiagnostic;
  } catch {
    return null;
  }
}

function persistUpdateDiagnostic(diagnostic: StoredUpdateDiagnostic) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(UPDATE_DIAGNOSTIC_STORAGE_KEY, JSON.stringify(diagnostic));
  } catch {
    // Diagnostics must never make a signed update check fail.
  }
}

function clearStoredUpdateDiagnostic() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(UPDATE_DIAGNOSTIC_STORAGE_KEY);
  } catch {
    // Storage can be unavailable in hardened WebView profiles.
  }
}

function searchScore(query: string, priorityValues: string[], values: Array<string | string[] | undefined>) {
  const normalizedQuery = normalizeSearch(query);
  const compactQuery = compactSearch(query);
  if (!normalizedQuery && !compactQuery) return 0;
  let score = 0;
  for (const value of priorityValues) {
    const normalized = normalizeSearch(value);
    const compact = compactSearch(value);
    if (normalized && normalized === normalizedQuery) score = Math.max(score, 120);
    if (compact && compact === compactQuery) score = Math.max(score, 118);
    if (normalized && normalized.startsWith(normalizedQuery)) score = Math.max(score, 96);
    if (compact && compact.startsWith(compactQuery)) score = Math.max(score, 92);
    if (normalized && normalized.includes(normalizedQuery)) score = Math.max(score, 72);
    if (compact && compact.includes(compactQuery)) score = Math.max(score, 68);
  }
  const joined = values.flatMap(value => (Array.isArray(value) ? value : [value ?? ""])).join(" ");
  if (normalizeSearch(joined).includes(normalizedQuery)) score = Math.max(score, 42);
  if (compactQuery && compactSearch(joined).includes(compactQuery)) score = Math.max(score, 40);
  return score;
}

function skillSearchScore(skill: SkillCard, query: string) {
  return searchScore(query, [skill.name, skill.folderName], [
    skill.name,
    skill.folderName,
    skill.category,
    skill.description,
    skill.source,
    skill.tags
  ]);
}

function sourceSearchScore(source: SourceCard, query: string) {
  return searchScore(query, [source.name, source.url ?? "", source.localPath ?? ""], [
    source.name,
    source.categoryId,
    source.note,
    source.url,
    source.localPath,
    source.tags
  ]);
}

function sourcePopularityIsDeferred(status: string, error = "") {
  const text = `${status} ${error}`.toLowerCase();
  return (
    status === "deferred" ||
    status === "stale" ||
    status === "rate-limited" ||
    text.includes("status 403") ||
    text.includes("status 429") ||
    text.includes("rate limit") ||
    text.includes("network") ||
    text.includes("timed out")
  );
}

function sourceIsGithub(source: SourceCard) {
  const url = source.url?.trim() ?? "";
  return /(^https?:\/\/github\.com\/|^git@github\.com:)/i.test(url);
}

function sourcePopularityInfo(
  source: SourceCard,
  popularity?: SourcePopularityCard
): { label: string; title: string; tone: "fresh" | "pending" | "error" | "muted" } {
  if (!sourceIsGithub(source)) {
    return { label: t("pop.notGithub"), title: t("pop.notGithubTip"), tone: "muted" };
  }
  if (!popularity) {
    return { label: t("pop.pending"), title: t("pop.pendingTip"), tone: "pending" };
  }
  if (sourcePopularityIsDeferred(popularity.cacheStatus, popularity.error)) {
    return {
      label: popularity.stars > 0 ? `★ ${formatCompactNumber(popularity.stars)}` : t("pop.deferred"),
      title: popularity.error || t("pop.deferredTip"),
      tone: "pending"
    };
  }
  if (popularity.cacheStatus === "error") {
    return { label: t("pop.errorLabel"), title: popularity.error || t("pop.errorTip"), tone: "error" };
  }
  return {
    label: `★ ${formatCompactNumber(popularity.stars)}`,
    title: t("pop.freshTip", { stars: formatCompactNumber(popularity.stars), time: formatScanTime(popularity.fetchedAt) }),
    tone: "fresh"
  };
}

type SourcePopularitySummary = { deferred: number; failed: number; fresh: number; githubTotal: number; missing: number };

function summarizeSourcePopularity(snapshot: LegacySnapshot): SourcePopularitySummary {
  const popularityBySourceId = new Map(snapshot.sourcePopularity.map(item => [item.sourceId, item]));
  const summary: SourcePopularitySummary = { deferred: 0, failed: 0, fresh: 0, githubTotal: 0, missing: 0 };
  for (const source of snapshot.sources) {
    if (!sourceIsGithub(source)) continue;
    summary.githubTotal += 1;
    const popularity = popularityBySourceId.get(source.id);
    if (!popularity || popularity.cacheStatus === "missing") summary.missing += 1;
    else if (popularity.cacheStatus === "fresh") summary.fresh += 1;
    else if (sourcePopularityIsDeferred(popularity.cacheStatus, popularity.error)) summary.deferred += 1;
    else if (popularity.cacheStatus === "error") summary.failed += 1;
    else summary.deferred += 1;
  }
  return summary;
}

function sourcePopularityRefreshMessage(summary: SourcePopularitySummary) {
  if (summary.githubTotal === 0) return t("pop.refreshNone");
  const parts: string[] = [t("pop.refreshUpdated", { n: summary.fresh })];
  if (summary.deferred > 0) parts.push(t("pop.refreshDeferred", { n: summary.deferred }));
  if (summary.missing > 0) parts.push(t("pop.refreshMissing", { n: summary.missing }));
  if (summary.failed > 0) parts.push(t("pop.refreshFailed", { n: summary.failed }));
  return parts.join("; ");
}

function desktopQaGateStatus(checks: DesktopQaCheckCard[]) {
  if (checks.length === 0) return "planned";
  if (checks.some(check => check.required && check.status === "failed")) return "blocked";
  if (checks.filter(check => check.required).every(check => check.status === "passed")) return "done";
  return "planned";
}

function desktopQaGateLabel(checks: DesktopQaCheckCard[]) {
  const status = desktopQaGateStatus(checks);
  if (status === "done") return t("adv.labelDone");
  if (status === "blocked") return t("adv.labelBlocked");
  return t("adv.labelPlanned");
}

function desktopQaGateSummary(checks: DesktopQaCheckCard[]) {
  if (checks.length === 0) return t("gate.qaNone");
  const required = checks.filter(check => check.required);
  const passed = required.filter(check => check.status === "passed").length;
  const failed = required.filter(check => check.status === "failed").length;
  const pending = required.length - passed - failed;
  return t("gate.qaSummary", { passed, total: required.length, pending, failed });
}

function releaseReportGateStatus(report?: ReleaseReportCard) {
  if (!report) return "planned";
  if (report.ok && report.status === "ok") return "done";
  if (report.status === "warn") return "planned";
  return "blocked";
}

function releaseReportGateLabel(report?: ReleaseReportCard) {
  if (!report) return t("gate.pendingLabel");
  if (report.ok && report.status === "ok") return t("adv.labelDone");
  if (report.status === "warn") return t("gate.reviewLabel");
  return t("adv.labelBlocked");
}

function operationRunnerStatusClass(status: string, locked: boolean) {
  if (locked) return "blocked";
  if (status === "completed" || status === "ok") return "done";
  if (status === "error" || status === "blocked") return "blocked";
  return "planned";
}

function operationRunnerStatusLabel(status: string, locked: boolean) {
  if (locked) return t("runner.locked");
  if (status === "completed" || status === "ok") return t("runner.completed");
  if (status === "armed") return t("runner.armed");
  if (status === "warn") return t("runner.review");
  if (status === "blocked") return t("runner.blocked");
  if (status === "error") return t("runner.failed");
  return t("runner.ready");
}

function qaStatusClass(status: string) {
  if (status === "passed") return "done";
  if (status === "failed") return "blocked";
  return "planned";
}

function qaStatusLabel(status: string) {
  if (status === "passed") return t("qaCheck.passed");
  if (status === "failed") return t("qaCheck.failed");
  return t("qaCheck.toCheck");
}

function waitFor(milliseconds: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, milliseconds));
}
