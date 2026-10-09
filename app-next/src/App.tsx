import { invoke } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { type CSSProperties, Suspense, lazy, startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./icons";
import { ParticleField, useCardGlow } from "./effects";
import { type Lang, initialLang, setLang, t } from "./i18n";
import { rt, shouldAutoContinue, sourceUpdateFeedback, sourceUpdateToast, summarizeSourceUpdateRun } from "./sourceUpdateRun";
import { UI_ICON_SCALES, UI_ICON_SCALE_STORAGE_KEY, restoredIconScale } from "./iconScale";
import { initialUiMaterial, saveUiMaterial, type UiMaterial } from "./uiMaterial";
import type {
  AdoptReport,
  AgentId,
  DeliveryJobStatus,
  DeliveryUnit,
  ErrorAction,
  InstallSkillSourceResult,
  LegacySnapshot,
  LegacySummary,
  NavKey,
  OnboardingResult,
  RuntimeSnapshotHydration,
  SkillAgent,
  SkillCard,
  SkillDeliveryState,
  SkillFolderCard,
  SkillHubError,
  SkillTarget,
  SourceCard,
  SourcePopularityCard,
  TargetChange
} from "./types";
import {
  SourceUpdatePanel,
  type ThemeName,
  type UiScalePreset,
  type SkillDraft,
  type SourceDraft,
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
  parseTagInput,
  queryLooksLikeSkillCommand,
  normalizeSearch,
  compactSearch,
  skillMatchesSearch,
  sourceMatchesSearch,
  skillBelongsToSource,
  stableSkillClientId,
  displayCategoryName,
  copySkillPrompt,
  copyTextToClipboard
} from "./appShared";
import { DeferredSurface, useConfirm } from "./components/ui";
import { LanguageSwitcher, ThemeSwitcher } from "./components/topbarSwitchers";
import {
  ErrorBanner,
  GlobalSearchResults,
  ProblemsPopover,
  Sidebar,
  SyncIndicatorButton,
  type SearchPackResult,
  type SearchSkillResult
} from "./components/shell";
import { buildLibraryRows, countSkills, type LibraryRow } from "./skillCounts";
import { availableAgents, targetIconView, topSyncIndicator } from "./deliveryView";
import { normalizeSkillHubError } from "./skillErrors";
import * as skillApi from "./skillApi";
import { classifyAddInput, getMcpSummary, importMcpFromClients, requestOpenMcpAdd } from "./mcpBridge";
import { setTelemetryEnabled, telemetryEnabled } from "./telemetry";
import "./shell.css";
// Liquid glass material for the chrome; after shell.css so it wins ties.
import "./liquid.css";

// Every page is its own chunk: only the visible page's code, DOM and styles stay in memory.
const Dashboard = lazy(() => import("./pages/Dashboard").then(module => ({ default: module.Dashboard })));
const Library = lazy(() => import("./pages/Library").then(module => ({ default: module.Library })));
const Agents = lazy(() => import("./pages/Agents").then(module => ({ default: module.Agents })));
const Settings = lazy(() => import("./pages/Settings").then(module => ({ default: module.Settings })));
const ImportSheet = lazy(() => import("./pages/ImportSheet").then(module => ({ default: module.ImportSheet })));
const Onboarding = lazy(() => import("./pages/Onboarding").then(module => ({ default: module.Onboarding })));
const SkillDrawer = lazy(() => import("./pages/SkillDrawer").then(module => ({ default: module.SkillDrawer })));
const ReviewSecurityDialog = lazy(() => import("./pages/SkillDrawer").then(module => ({ default: module.ReviewSecurityDialog })));
const McpCenter = lazy(() => import("./McpCenter").then(module => ({ default: module.McpCenter })));

type SourceMutationResult = {
  source: SourceCard;
  snapshot?: LegacySnapshot | null;
  deliveryReconciled: boolean;
};
type SourcePopularityRefreshResult = {
  sourcePopularity: SourcePopularityCard[];
  summary: SourcePopularitySummary;
};

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
type BannerScope = "delivery" | "import" | "index" | "other";
type DrawerTab = "overview" | "versions" | "settings";
export type HomeVisual = "islands" | "universe" | "summary";

const PROJECT_HOME_URL = "https://github.com/Francis-Zxp/AI-SkillHub";
const PROJECT_RELEASES_URL = "https://github.com/Francis-Zxp/AI-SkillHub/releases/latest";
const UPDATE_DIAGNOSTIC_STORAGE_KEY = "ai-skillhub-update-diagnostic-v1";
const UPDATE_CHECK_HEADERS = { "Cache-Control": "no-cache", Pragma: "no-cache" } as const;
const UI_TEXT_SCALE_STORAGE_KEY = "ai-skillhub-ui-text-scale";
const DEV_MODE_STORAGE_KEY = "ai-skillhub-dev-mode";
const HOME_VISUAL_STORAGE_KEY = "skillhub-home-visual";
const UI_TEXT_SCALES: Record<UiScalePreset, number> = {
  compact: 0.92,
  standard: 1,
  comfortable: 1.08,
  large: 1.16
};
const TERMINAL_PHASES = new Set(["done", "failed", "paused"]);
const SEARCH_PACK_LIMIT = 8;
const SEARCH_SKILL_LIMIT = 12;

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
  const [agentDetailId, setAgentDetailId] = useState<string | null>(() => initialAgentDetail());
  const [showUpdateResults, setShowUpdateResults] = useState(false);
  const [theme, setTheme] = useState<ThemeName>(() => initialTheme());
  const skyPhase = useSkyPhase();
  // "sky-auto" follows the clock; everything that styles the app uses the
  // resolved phase, while settings keep showing the user's choice.
  const resolvedTheme: ThemeName = theme === "sky-auto" ? `sky-${skyPhase}` : theme;
  const [textScale, setTextScale] = useState<UiScalePreset>(() => initialUiScale(UI_TEXT_SCALE_STORAGE_KEY, "standard"));
  const [material, setMaterial] = useState<UiMaterial>(initialUiMaterial);
  const [iconScale, setIconScale] = useState<UiScalePreset>(() => restoredIconScale(
    window.localStorage.getItem(UI_ICON_SCALE_STORAGE_KEY), window.localStorage.getItem("ai-skillhub-ui-icon-scale")
  ));
  const [homeVisual, setHomeVisualState] = useState<HomeVisual>(() => initialHomeVisual());
  const [devMode, setDevModeState] = useState(() => readFlag(DEV_MODE_STORAGE_KEY));
  const [telemetryOn, setTelemetryOn] = useState(() => telemetryEnabled());
  const [sourceCheckFailed, setSourceCheckFailed] = useState(false);
  // The snapshot is kept without its skillDelivery block; delivery state lives in one place only.
  const [snapshot, setSnapshot] = useState<LegacySnapshot | null>(null);
  const [delivery, setDelivery] = useState<SkillDeliveryState | null>(null);
  const [banner, setBanner] = useState<{ error: SkillHubError; scope: BannerScope } | null>(null);
  const [loading, setLoading] = useState(true);
  const [metadataAnalyzing, setMetadataAnalyzing] = useState(false);
  const [startupVerified, setStartupVerified] = useState(() => !hasTauriRuntime());
  const [runtimeHydrated, setRuntimeHydrated] = useState(() => !hasTauriRuntime());
  const [indexRefreshing, setIndexRefreshing] = useState(false);
  const [popularityRefreshing, setPopularityRefreshing] = useState(false);
  const [agentsRefreshing, setAgentsRefreshing] = useState(false);
  const [importInFlight, setImportInFlight] = useState(false);
  const [busyAction, setBusyAction] = useState("");
  const [childBusy, setChildBusy] = useState<ReadonlySet<string>>(() => new Set());
  const [operation, setOperation] = useState<OperationStatus | null>(null);
  const [toast, setToast] = useState<{ message: string; tone: ToastTone } | null>(null);
  const [globalSearch, setGlobalSearch] = useState("");
  const [libraryFolderId, setLibraryFolderId] = useState("all");
  const [importSheet, setImportSheet] = useState<{ text: string; autoProbe: boolean; nonce: number } | null>(null);
  const [detail, setDetail] = useState<{ key: string; tab: DrawerTab; nonce: number } | null>(null);
  const [reviewSourceId, setReviewSourceId] = useState("");
  const [problemsOpen, setProblemsOpen] = useState(false);
  const [settingsFocus, setSettingsFocus] = useState("");
  const [onboardingDeferred, setOnboardingDeferred] = useState(false);
  const [mcpCount, setMcpCount] = useState<number | null>(null);
  const [appUpdate, setAppUpdate] = useState<AppUpdateState>(() => initialAppUpdateState());
  const [dashboardImmersive, setDashboardImmersive] = useState(false);
  const [confirmNode, askConfirm] = useConfirm();
  const backgrounded = useBackgrounded();
  const searchInputRef = useRef<HTMLInputElement | null>(null);
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
  const deliveryRefreshTimerRef = useRef<number | null>(null);
  const snapshotRef = useRef<LegacySnapshot | null>(null);
  snapshotRef.current = snapshot;
  // Set by the operation banner: finish the current round, then stop chaining.
  const updateRunStopRef = useRef(false);
  const runtimeAvailable = hasTauriRuntime();
  // Delivery and target actions never use this (I-4): it only covers the initial load,
  // index/popularity refreshes, the 更新 run and an import that is downloading or installing.
  const mutationBusy = loading || indexRefreshing || popularityRefreshing || Boolean(operation) || importInFlight;
  mutationBusyRef.current = mutationBusy;
  const importInFlightRef = useRef(false);
  importInFlightRef.current = importInFlight;

  useCardGlow();

  useEffect(() => {
    if (snapshot) runtimeMutationGenerationRef.current += 1;
  }, [snapshot]);

  /** The library as every page sees it: the lean snapshot plus the one delivery state. */
  const library = useMemo<LegacySnapshot | null>(
    () => (snapshot ? { ...snapshot, skillDelivery: delivery ?? undefined } : null),
    [snapshot, delivery]
  );
  const rows = useMemo(() => buildLibraryRows(library), [library]);
  const counts = useMemo(() => countSkills(library), [library]);

  const summary = useMemo<LegacySummary>(
    () => {
      const base = snapshot?.summary ?? {
        skills: 0,
        sources: 0,
        prompts: 0,
        agentsDetected: 0,
        warnings: 0,
        diagnosticsStatus: "loading"
      };
      // Skill and pack totals always come from the shared counting rule (I-11).
      return { ...base, skills: counts.skills, sources: counts.packs + counts.promptPacks };
    },
    [snapshot?.summary, counts]
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

  function changeMaterial(next: UiMaterial) {
    setMaterial(next);
    saveUiMaterial(next);
    toastMessage(t("set.displaySaved"), "ok");
  }

  function changeIconScale(nextScale: UiScalePreset) {
    setIconScale(nextScale);
    toastMessage(t("set.displaySaved"), "ok");
  }

  function changeHomeVisual(next: HomeVisual) {
    setHomeVisualState(next);
    try { window.localStorage.setItem(HOME_VISUAL_STORAGE_KEY, next); } catch { /* session preference */ }
  }

  function changeDevMode(next: boolean) {
    setDevModeState(next);
    try { window.localStorage.setItem(DEV_MODE_STORAGE_KEY, next ? "1" : "0"); } catch { /* session preference */ }
  }

  function changeTelemetry(next: boolean) {
    setTelemetryEnabled(next);
    setTelemetryOn(next);
    toastMessage(next ? t("v33.telemetryOnToast") : t("v33.telemetryOffToast"), "ok");
  }

  function toastMessage(message: string, tone: ToastTone = "info") {
    setToast({ message, tone });
  }

  function showError(error: unknown, scope: BannerScope) {
    const normalized = normalizeSkillHubError(error);
    if (normalized.code === "CANCELLED") return;
    setBanner({ error: normalized, scope });
  }

  function clearBanner(scope: BannerScope) {
    setBanner(current => (current?.scope === scope ? null : current));
  }

  function navigate(key: NavKey) {
    setActive(key);
    setProblemsOpen(false);
  }

  function openSettings(section = "") {
    setSettingsFocus(section ? `${section}:${Date.now()}` : "");
    navigate("settings");
  }

  function openLibrary(folderId = "all") {
    setLibraryFolderId(folderId || "unfiled");
    navigate("library");
  }

  function openAgent(agentId: string | null) {
    setAgentDetailId(agentId);
  }

  function openImport(text = "", autoProbe = false) {
    setImportSheet({ text, autoProbe, nonce: Date.now() });
  }

  function openDetail(key: string, tab: DrawerTab = "overview") {
    setDetail({ key, tab, nonce: Date.now() });
  }

  function mutationBlockedBySync(notify = true, markMutation = true) {
    if (!syncInFlightRef.current && !indexRefreshInFlightRef.current && !popularityRefreshInFlightRef.current && !importInFlight) {
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

  /** Keeps exactly one copy of the library in memory: the delivery block moves into its own state. */
  function applySnapshot(nextSnapshot: LegacySnapshot, background = false) {
    const { skillDelivery, ...lean } = nextSnapshot;
    if (skillDelivery) setDelivery(skillDelivery);
    if (background) startTransition(() => setSnapshot(lean as LegacySnapshot));
    else setSnapshot(lean as LegacySnapshot);
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
        const { createPreviewSnapshot, refreshPreviewSnapshot } = await loadPreviewModule();
        const previewSnapshot = snapshotRef.current ? refreshPreviewSnapshot(snapshotRef.current) : createPreviewSnapshot();
        applySnapshot(previewSnapshot);
        clearBanner("index");
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
      clearBanner("index");
      if (mode !== "indexed" && !options.quiet) toastMessage(t("toast.refreshDone"), "ok");
      return result;
    } catch (error) {
      showError(error, "index");
      return null;
    } finally {
      if (!options.background) setLoading(false);
    }
  }

  /* ---- delivery state (I-3: icons show only what the backend read back) ---- */

  async function refreshDelivery() {
    try {
      const next = await skillApi.getSkillDeliveryState();
      setDelivery(next);
    } catch (error) {
      // The last known state stays visible; the next job event retries.
      console.warn("Delivery state is unavailable; keeping the last known state.", messageFromError(error));
    }
  }

  function scheduleDeliveryRefresh(delay = 120) {
    if (deliveryRefreshTimerRef.current !== null) window.clearTimeout(deliveryRefreshTimerRef.current);
    deliveryRefreshTimerRef.current = window.setTimeout(() => {
      deliveryRefreshTimerRef.current = null;
      void refreshDelivery();
    }, delay);
  }

  function mergeTargets(targets: SkillTarget[]) {
    if (targets.length === 0) return;
    setDelivery(current => {
      if (!current) return current;
      const incoming = new Map(targets.map(target => [`${target.unitId}\u0000${target.agentId}`, target]));
      const next = current.targets.map(target => {
        const key = `${target.unitId}\u0000${target.agentId}`;
        const replacement = incoming.get(key);
        if (!replacement) return target;
        incoming.delete(key);
        return replacement;
      });
      return { ...current, targets: [...next, ...incoming.values()] };
    });
  }

  function mergeUnit(unit: DeliveryUnit | null) {
    if (!unit) return;
    setDelivery(current => current
      ? { ...current, units: current.units.some(item => item.unitId === unit.unitId)
          ? current.units.map(item => (item.unitId === unit.unitId ? unit : item))
          : [...current.units, unit] }
      : current);
  }

  function mergeAgents(agents: SkillAgent[]) {
    if (agents.length === 0) return;
    setDelivery(current => current
      ? { ...current, agents: current.agents.map(agent => agents.find(item => item.id === agent.id) ?? agent) }
      : current);
  }

  function onDeliveryStatus(status: DeliveryJobStatus) {
    setDelivery(current => (current ? { ...current, job: status } : current));
    if (!TERMINAL_PHASES.has(status.phase)) return;
    scheduleDeliveryRefresh();
    if (status.phase === "failed" && status.error) showError(status.error, "delivery");
    else clearBanner("delivery");
    if (status.snapshotStale) void reloadLibraryQuietly();
  }

  async function reloadLibraryQuietly() {
    if (indexRefreshInFlightRef.current || syncInFlightRef.current) return;
    await loadSnapshot("indexed", { background: true, quiet: true });
  }

  async function requestDelivery(reason: string, depth: "verify" | "links" | "full", refreshDetection?: boolean) {
    try {
      await skillApi.requestSkillDelivery(reason, depth, refreshDetection);
      clearBanner("delivery");
    } catch (error) {
      showError(error, "delivery");
    }
  }

  async function setTarget(unitId: string, agentId: AgentId, enabled: boolean) {
    try {
      const result = await skillApi.setSkillTarget(unitId, agentId, enabled);
      mergeTargets(result.targets);
      if (result.rejected.length > 0) showError(result.rejected[0].error, "delivery");
      else clearBanner("delivery");
    } catch (error) {
      showError(error, "delivery");
    }
  }

  async function setTargetsBatch(changes: TargetChange[]) {
    if (changes.length === 0) return null;
    try {
      const result = await skillApi.setSkillTargetsBatch(changes);
      mergeTargets(result.targets);
      if (result.rejected.length > 0) showError(result.rejected[0].error, "delivery");
      else clearBanner("delivery");
      toastMessage(t("v33.batchDone", { n: result.changed }), "ok");
      return result;
    } catch (error) {
      showError(error, "delivery");
      return null;
    }
  }

  function handleTargetClick(row: LibraryRow, target: SkillTarget) {
    const view = targetIconView(target, row.unit?.libraryOnlyReason ?? "");
    switch (view.action) {
      case "remove":
        void setTarget(target.unitId, target.agentId, false);
        break;
      case "add":
        void setTarget(target.unitId, target.agentId, true);
        break;
      case "open-settings":
        openSettings("sync");
        break;
      case "open-drawer":
        openDetail(row.key, "overview");
        break;
      case "retry":
        void requestDelivery("retry", "links");
        break;
      case "review":
        if (row.source) setReviewSourceId(row.source.id);
        break;
      case "takeover": {
        const agent = delivery?.agents.find(item => item.id === target.agentId);
        if (agent) void setTakeover(agent, true);
        break;
      }
      default:
        break;
    }
  }

  async function setTakeover(agent: SkillAgent, enabled: boolean) {
    if (!enabled) {
      const ok = await askConfirm({
        title: t("v33.takeoverOffTitle", { tool: agent.name }),
        body: t("v33.takeoverOffBody"),
        confirmLabel: t("v33.takeoverOffConfirm"),
        danger: true,
        testId: "takeover-off-dialog"
      });
      if (!ok) return;
    }
    try {
      const result = await skillApi.setAgentTakeover(agent.id, enabled);
      mergeAgents(result.agents);
      clearBanner("delivery");
      scheduleDeliveryRefresh(60);
    } catch (error) {
      // Before the first-run choice, taking over a tool happens on the onboarding screen.
      if (normalizeSkillHubError(error).code === "ONBOARDING_REQUIRED") {
        setOnboardingDeferred(false);
        navigate("dashboard");
        return;
      }
      showError(error, "delivery");
    }
  }

  async function setPaused(paused: boolean) {
    try {
      const result = await skillApi.setSkillDeliveryPaused(paused);
      setDelivery(current => (current ? { ...current, paused: result.paused, onboarding: result.onboarding } : current));
      toastMessage(paused ? t("v33.pausedToast") : t("v33.resumedToast"), "ok");
      scheduleDeliveryRefresh(60);
    } catch (error) {
      showError(error, "delivery");
    }
  }

  async function setChildSkillEnabled(skill: SkillCard, enabled: boolean): Promise<boolean> {
    setChildBusy(current => new Set(current).add(skill.folderName));
    try {
      const result = await skillApi.setChildSkillEnabled(skill.folderName, enabled);
      setSnapshot(current => current
        ? { ...current, skills: current.skills.map(item => (item.folderName === skill.folderName ? { ...item, enabled: result.skill.enabled } : item)) }
        : current);
      mergeUnit(result.unit);
      return true;
    } catch {
      // The switch reverts on its own (it shows only stored state); the toast offers the retry.
      toastMessage(t("v33.childSaveFailed"), "error");
      return false;
    } finally {
      setChildBusy(current => {
        const next = new Set(current);
        next.delete(skill.folderName);
        return next;
      });
    }
  }

  async function setSourceLibraryEnabled(source: SourceCard, enabled: boolean, confirmed: boolean): Promise<boolean> {
    try {
      const result = await skillApi.setSourceLibraryEnabled(source.id, enabled, confirmed);
      setSnapshot(current => current
        ? { ...current, sources: current.sources.map(item => (item.id === result.source.id ? { ...item, ...result.source } : item)) }
        : current);
      mergeUnit(result.unit);
      mergeTargets(result.targets);
      clearBanner("delivery");
      return true;
    } catch (error) {
      const normalized = normalizeSkillHubError(error);
      if (normalized.code === "SECURITY_REVIEW_REQUIRED") {
        setReviewSourceId(source.id);
        return false;
      }
      showError(normalized, "delivery");
      return false;
    }
  }

  async function updateDesktopQaStatus(id: string, status: "pending" | "passed" | "failed") {
    if (mutationBlockedBySync()) return;
    try {
      if (!runtimeAvailable) {
        const { createPreviewSnapshot, updatePreviewDesktopQaStatus } = await loadPreviewModule();
        setSnapshot(prev => updatePreviewDesktopQaStatus(prev ?? createPreviewSnapshot(), id, status));
        return;
      }
      const result = await invoke<LegacySnapshot>("set_desktop_qa_check_status", { id, status });
      applySnapshot(result);
      toastMessage(t("set.toastQa"), "ok");
    } catch (error) {
      showError(error, "other");
    }
  }

  /** Name, category, description and note, then tags. A failed second step is reported, never hidden (bug #13). */
  async function updateSkillMetadata(skill: SkillCard, draft: SkillDraft): Promise<"failed" | "partial" | "preview" | "saved"> {
    if (mutationBlockedBySync()) return "failed";
    if (!runtimeAvailable) return "preview";
    setBusyAction("save-skill");
    try {
      const result = await invoke<LegacySnapshot>("set_skill_metadata", {
        folderName: skill.folderName,
        name: draft.name,
        category: draft.category,
        description: draft.description,
        note: draft.note
      });
      applySnapshot(result);
      try {
        const tagged = await invoke<LegacySnapshot>("set_skill_tags", {
          folderName: skill.folderName,
          tags: parseTagInput(draft.tags)
        });
        applySnapshot(tagged);
      } catch (error) {
        toastMessage(t("v33.tagsNotSaved", { reason: normalizeSkillHubError(error).message }), "error");
        return "partial";
      }
      clearBanner("other");
      toastMessage(t("toast.skillSaved"), "ok");
      return "saved";
    } catch (error) {
      showError(error, "other");
      toastMessage(t("toast.saveFailed"), "error");
      return "failed";
    } finally {
      setBusyAction("");
    }
  }

  async function updateSkillRating(skill: SkillCard, rating: number): Promise<boolean> {
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
    try {
      const result = await invoke<LegacySnapshot>("set_skill_rating", {
        folderName: skill.folderName,
        rating: normalizedRating
      });
      applySnapshot(result, true);
      toastMessage(
        normalizedRating > 0
          ? t("toast.skillRated", { n: normalizedRating })
          : t("toast.skillRatingCleared"),
        "ok"
      );
      return true;
    } catch (error) {
      showError(error, "other");
      toastMessage(t("toast.skillRatingFailed"), "error");
      return false;
    }
  }

  async function setSourceVersionPin(source: SourceCard, pinned: boolean): Promise<boolean> {
    if (mutationBlockedBySync()) return false;
    if (!runtimeAvailable) {
      setSnapshot(previous => previous
        ? {
            ...previous,
            sourceGovernance: previous.sourceGovernance.map(item =>
              item.sourceId === source.id
                ? { ...item, pinned, pinnedRevision: pinned ? item.currentRevision : "", status: pinned ? "pinned" : "ready" }
                : item
            )
          }
        : previous);
      toastMessage(pinned ? t("governance.toastPinned") : t("governance.toastUnpinned"), "ok");
      return true;
    }
    setBusyAction("version");
    try {
      const result = await invoke<LegacySnapshot>("set_source_version_pin", { sourceId: source.id, pinned });
      applySnapshot(result);
      toastMessage(pinned ? t("governance.toastPinned") : t("governance.toastUnpinned"), "ok");
      return true;
    } catch (error) {
      showError(error, "other");
      toastMessage(t("governance.toastFailed"), "error");
      return false;
    } finally {
      setBusyAction("");
    }
  }

  async function refreshSourceVersionStatus(source: SourceCard): Promise<boolean> {
    if (mutationBlockedBySync()) return false;
    if (!runtimeAvailable) {
      setSnapshot(previous => previous
        ? {
            ...previous,
            sourceGovernance: previous.sourceGovernance.map(item =>
              item.sourceId === source.id ? { ...item, lastCheckedAt: new Date().toISOString(), diffSource: "live" } : item
            )
          }
        : previous);
      toastMessage(t("governance.toastRefreshed"), "ok");
      return true;
    }
    setBusyAction("version");
    try {
      const result = await invoke<LegacySnapshot>("refresh_source_version_status", { sourceId: source.id });
      applySnapshot(result);
      toastMessage(t("governance.toastRefreshed"), "ok");
      return true;
    } catch (error) {
      showError(error, "other");
      toastMessage(t("governance.toastFailed"), "error");
      return false;
    } finally {
      setBusyAction("");
    }
  }

  async function rollbackSourceVersion(source: SourceCard): Promise<boolean> {
    if (mutationBlockedBySync()) return false;
    const ok = await askConfirm({
      title: t("v33.rollbackTitle"),
      body: t("v33.rollbackBody", { name: source.name }),
      confirmLabel: t("governance.rollback")
    });
    if (!ok) return false;
    if (!runtimeAvailable) {
      setSnapshot(previous => previous
        ? {
            ...previous,
            sourceGovernance: previous.sourceGovernance.map(item =>
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
          }
        : previous);
      toastMessage(t("governance.toastRolledBack"), "ok");
      return true;
    }
    setBusyAction("version");
    try {
      const result = await invoke<LegacySnapshot>("rollback_source_to_latest_backup", { sourceId: source.id });
      applySnapshot(result);
      toastMessage(t("governance.toastRolledBack"), "ok");
      return true;
    } catch (error) {
      showError(error, "other");
      toastMessage(t("governance.toastFailed"), "error");
      return false;
    } finally {
      setBusyAction("");
    }
  }

  /** Saves the drawer's 设置 tab. The library switch is not part of this call (it goes through the review gate). */
  async function updateSourceMetadata(source: SourceCard, draft: SourceDraft): Promise<"failed" | "preview" | "saved"> {
    if (mutationBlockedBySync()) return "failed";
    if (!runtimeAvailable) {
      setSnapshot(current => current
        ? {
            ...current,
            sources: current.sources.map(item => item.id === source.id
              ? { ...item, name: draft.name, categoryId: draft.category, note: draft.note, tags: parseTagInput(draft.tags), sourceType: draft.sourceType }
              : item)
          }
        : current);
      toastMessage(t("toast.sourceSaved"), "ok");
      return "saved";
    }
    setBusyAction("save-source");
    try {
      const result = await invoke<SourceMutationResult>("save_source_metadata", {
        sourceId: source.id,
        name: draft.name,
        sourceType: draft.sourceType,
        category: draft.category,
        note: draft.note,
        enabled: source.enabled,
        tags: parseTagInput(draft.tags)
      });
      if (result.snapshot) applySnapshot(result.snapshot, true);
      else {
        startTransition(() => setSnapshot(current => current
          ? {
              ...current,
              sources: current.sources.map(item => item.id === result.source.id ? result.source : item),
              skills: current.skills.map(skill => skill.sourceId === result.source.id ? { ...skill, source: result.source.name } : skill)
            }
          : current));
      }
      clearBanner("other");
      toastMessage(t("toast.sourceSaved"), "ok");
      return "saved";
    } catch (error) {
      showError(error, "other");
      toastMessage(t("toast.sourceSaveFailed"), "error");
      return "failed";
    } finally {
      setBusyAction("");
    }
  }

  async function deleteSource(source: SourceCard): Promise<"failed" | "preview" | "deleted"> {
    if (mutationBlockedBySync()) return "failed";
    const ok = await askConfirm({
      title: t("v33.deleteTitle", { name: source.name }),
      body: t("v33.deleteBody"),
      confirmLabel: t("v33.deleteConfirm"),
      danger: true
    });
    if (!ok) return "failed";
    if (!runtimeAvailable) {
      setSnapshot(prev => prev
        ? {
            ...prev,
            sources: prev.sources.filter(item => item.id !== source.id),
            skills: prev.skills.filter(skill => !skillBelongsToSource(skill, source))
          }
        : prev);
      toastMessage(t("toast.sourceDeletePreview"), "info");
      return "preview";
    }
    setBusyAction("delete");
    try {
      const result = await invoke<LegacySnapshot>("delete_managed_source", { sourceId: source.id });
      applySnapshot(result);
      toastMessage(t("toast.sourceDeleted"), "ok");
      scheduleDeliveryRefresh(200);
      return "deleted";
    } catch (error) {
      showError(error, "other");
      toastMessage(t("toast.sourceDeleteFailed"), "error");
      return "failed";
    } finally {
      setBusyAction("");
    }
  }

  async function runReleaseGateRunner(runnerId: string) {
    if (mutationBlockedBySync()) return;
    setBusyAction(`runner:${runnerId}`);
    try {
      if (!runtimeAvailable) {
        const { createPreviewSnapshot, updatePreviewOperationRunner } = await loadPreviewModule();
        setSnapshot(prev => updatePreviewOperationRunner(prev ?? createPreviewSnapshot(), runnerId));
        toastMessage(t("toast.previewRunnerSim"), "info");
        return;
      }
      const result = await invoke<LegacySnapshot>("run_release_gate_runner", { runnerId });
      applySnapshot(result);
      toastMessage(t("adv.toastRunnerDone"), "ok");
    } catch (error) {
      showError(error, "other");
      toastMessage(t("adv.toastRunnerFailed"), "error");
    } finally {
      setBusyAction("");
    }
  }

  /** Usage bookkeeping is best effort: a failure is logged, never shown as an error (bug #6). */
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
      console.warn("Usage event was not recorded.", messageFromError(error));
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
      const previewSnapshot = snapshotRef.current;
      if (!options.quiet) toastMessage(t("pop.previewToast"), "info");
      return previewSnapshot
        ? { sourcePopularity: previewSnapshot.sourcePopularity, summary: summarizeSourcePopularity(previewSnapshot) }
        : null;
    }
    try {
      const result = await invoke<SourcePopularityRefreshResult>("refresh_source_popularity");
      const applyPopularity = () => setSnapshot(current => current
        ? { ...current, sourcePopularity: result.sourcePopularity }
        : current);
      if (options.background) startTransition(applyPopularity);
      else applyPopularity();
      clearBanner("index");
      if (!options.quiet) {
        const summaryText = sourcePopularityRefreshMessage(result.summary);
        toastMessage(summaryText, "ok");
      }
      return result;
    } catch (error) {
      if (!options.quiet) {
        showError(error, "index");
        toastMessage(t("pop.toastFailed"), "error");
      }
      return null;
    }
  }

  async function reanalyzeLibraryMetadata(): Promise<LegacySnapshot | null> {
    if (mutationBlockedBySync()) return null;
    if (!runtimeAvailable) {
      toastMessage(t("metadata.previewToast"), "info");
      return snapshotRef.current;
    }
    setMetadataAnalyzing(true);
    try {
      const result = await invoke<LegacySnapshot>("reanalyze_library_metadata");
      applySnapshot(result);
      // Same counting rule as every other number on screen (I-11): routers are not skills.
      const analyzed = countSkills(result);
      toastMessage(
        t("metadata.doneToast", {
          skills: analyzed.skills,
          sources: analyzed.packs
        }),
        "ok"
      );
      return result;
    } catch (error) {
      showError(error, "index");
      toastMessage(t("metadata.failedToast"), "error");
      return null;
    } finally {
      setMetadataAnalyzing(false);
    }
  }

  async function consolidateSources() {
    if (mutationBlockedBySync()) return;
    if (!runtimeAvailable) {
      toastMessage(t("v33.previewOnly"), "info");
      return;
    }
    setBusyAction("consolidate");
    try {
      const result = await invoke<LegacySnapshot>("consolidate_duplicate_sources");
      applySnapshot(result);
      toastMessage(t("v33.consolidated"), "ok");
    } catch (error) {
      showError(error, "index");
    } finally {
      setBusyAction("");
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
    if (importInFlight) {
      toastMessage(t("v33.importBusy"), "warn");
      return null;
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
      scheduleDeliveryRefresh(200);
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

  /** 检测 AI 工具: re-reads install evidence only. 立即同步 is a separate, queued action. */
  async function refreshLocalAgents(): Promise<void> {
    if (agentsRefreshing) return;
    setAgentsRefreshing(true);
    try {
      if (!runtimeAvailable) {
        await waitFor(400);
        toastMessage(t("agents.detectToast"), "ok");
      } else {
        const refreshed = await invoke<LegacySnapshot>("refresh_agent_detection");
        applySnapshot(refreshed);
        toastMessage(t("agents.detectToast"), "ok");
      }
      scheduleDeliveryRefresh(60);
    } catch (error) {
      showError(error, "index");
    } finally {
      setAgentsRefreshing(false);
    }
  }

  async function updateSourceRating(source: SourceCard, rating: number): Promise<boolean> {
    const normalizedRating = Math.max(0, Math.min(5, Math.round(rating)));
    if (!runtimeAvailable) {
      setSnapshot(previous => previous
        ? { ...previous, sources: previous.sources.map(item => (item.id === source.id ? { ...item, rating: normalizedRating } : item)) }
        : previous);
      toastMessage(
        normalizedRating > 0
          ? t("toast.sourceRated", { n: normalizedRating })
          : t("toast.sourceRatingCleared"),
        "ok"
      );
      return true;
    }
    try {
      const result = await invoke<LegacySnapshot>("set_source_rating", {
        sourceId: source.id,
        rating: normalizedRating
      });
      applySnapshot(result, true);
      toastMessage(
        normalizedRating > 0
          ? t("toast.sourceRated", { n: normalizedRating })
          : t("toast.sourceRatingCleared"),
        "ok"
      );
      return true;
    } catch (error) {
      showError(error, "other");
      toastMessage(t("toast.sourceRatingFailed"), "error");
      return false;
    }
  }

  async function runSkillFolderCommand(
    command: string,
    args: Record<string, unknown>,
    successMessage: string
  ): Promise<LegacySnapshot | null> {
    if (mutationBlockedBySync()) return null;
    if (!runtimeAvailable) {
      const current = snapshotRef.current;
      if (!current) return null;
      const folders = previewFolderResult(current.skillFolders ?? [], command, args);
      const next = applySkillFolderCommandResult(current, command, args, folders);
      setSnapshot(next);
      if (successMessage) toastMessage(successMessage, "ok");
      return next;
    }
    try {
      const currentSnapshot = snapshotRef.current;
      const folders = await invoke<SkillFolderCard[]>(command, args);
      setSnapshot(current => current ? applySkillFolderCommandResult(current, command, args, folders) : current);
      clearBanner("other");
      if (successMessage) toastMessage(successMessage, "ok");
      return currentSnapshot ? applySkillFolderCommandResult(currentSnapshot, command, args, folders) : null;
    } catch (error) {
      showError(error, "other");
      return null;
    }
  }

  /* ---- import (ImportSheet) ---- */

  function onImportInstalled(result: InstallSkillSourceResult) {
    mergeTargets(result.targets);
    mergeUnit(result.unit);
    clearBanner("import");
    if (result.snapshotStale) void reloadLibraryQuietly();
  }

  function onAdopted(report: AdoptReport) {
    if (report.snapshotStale) void reloadLibraryQuietly();
    scheduleDeliveryRefresh(80);
  }

  async function onOnboardingDone(result: OnboardingResult, importMcp: boolean) {
    mergeAgents(result.agents);
    setDelivery(current => (current ? { ...current, onboarding: result.status } : current));
    if (importMcp) {
      const ok = await importMcpFromClients("onboarding");
      if (ok) void getMcpSummary().then(value => setMcpCount(value?.servers ?? null));
    }
    if (result.adopt?.snapshotStale) void reloadLibraryQuietly();
    scheduleDeliveryRefresh(80);
    navigate("dashboard");
  }

  /* ---- banner and problem actions ---- */

  async function exportReport() {
    setBusyAction("report");
    try {
      const report = await skillApi.exportTroubleshootingReport();
      toastMessage(t("v33.reportReady"), "ok");
      if (runtimeAvailable) {
        try {
          await invoke("open_release_gate_export_path", { path: report.folderPath });
        } catch {
          await copyTextToClipboard(report.reportPath, t("toast.pathCopied"));
        }
      } else {
        await copyTextToClipboard(report.reportPath, t("toast.previewPathCopied"));
      }
    } catch (error) {
      showError(error, "other");
    } finally {
      setBusyAction("");
    }
  }

  async function openAgentFolder(agentId: string) {
    try {
      await skillApi.openAgentSkillsFolder(agentId as AgentId);
      if (!runtimeAvailable) toastMessage(t("v33.previewOnly"), "info");
    } catch (error) {
      showError(error, "other");
    }
  }

  function runErrorAction(action: ErrorAction, context: { agentId?: string | null; unitId?: string | null; sourceId?: string | null } = {}) {
    const payload = action.payload ?? {};
    const agentId = payload.agentId || context.agentId || "";
    const unitId = payload.unitId || context.unitId || "";
    const sourceId = payload.sourceId || context.sourceId || "";
    setBanner(null);
    setProblemsOpen(false);
    switch (action.kind) {
      case "retry":
        void requestDelivery("retry", "links");
        break;
      case "open-folder":
        if (agentId) void openAgentFolder(agentId);
        else if (unitId || sourceId) openDetail(unitId || sourceId, "overview");
        break;
      case "reinstall":
        void openOfficialReleases();
        break;
      case "export-report":
        void exportReport();
        break;
      case "takeover-agent": {
        const agent = delivery?.agents.find(item => item.id === agentId);
        if (agent) void setTakeover(agent, true);
        else navigate("agents");
        break;
      }
      case "review-security":
        if (sourceId) setReviewSourceId(sourceId);
        break;
      case "resolve-conflict":
        if (unitId) openDetail(unitId, "overview");
        else navigate("library");
        break;
      case "open-settings":
        openSettings();
        break;
      case "install-git":
        openSettings("updates");
        break;
      case "refresh":
        void loadSnapshot("indexed", { background: true, quiet: true });
        break;
      case "open-mcp-add":
        requestOpenMcpAdd(payload.text ?? "");
        navigate("connections");
        break;
      case "open-existing":
        if (sourceId || unitId) openDetail(sourceId || unitId, "overview");
        break;
      case "wait":
      default:
        break;
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

  /**
   * Startup: show the SQLite snapshot, then only *enqueue* a verify job (I-4). The window is
   * usable at once; the sync indicator reports the job. While onboarding is pending or sync is
   * paused the backend writes nothing to any AI tool folder (I-1).
   */
  async function verifyStartupSnapshot(
    loadIndexed: boolean,
    isCancelled: () => boolean = () => false,
    initialRun = false
  ) {
    if (!initialRun && initialDeliveryInFlightRef.current) return;
    let verified = !runtimeAvailable;
    initialDeliveryInFlightRef.current = true;
    try {
      if (loadIndexed) {
        const indexed = await loadSnapshot();
        if (!indexed || isCancelled()) return;
        if (!indexed.skillDelivery) await refreshDelivery();
      }
      if (isCancelled()) return;
      await skillApi.requestSkillDelivery("startup", "verify");
      verified = true;
    } catch (error) {
      if (!isCancelled()) showError(error, "delivery");
    } finally {
      initialDeliveryInFlightRef.current = false;
      if (!isCancelled()) {
        setStartupVerified(verified);
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
    let stop: (() => void) | null = null;
    let disposed = false;
    void skillApi.listenDeliveryStatus(onDeliveryStatus).then(unlisten => {
      if (disposed) unlisten();
      else stop = unlisten;
    });
    return () => {
      disposed = true;
      stop?.();
      if (deliveryRefreshTimerRef.current !== null) window.clearTimeout(deliveryRefreshTimerRef.current);
    };
  }, []);

  useEffect(() => {
    let stop: (() => void) | null = null;
    let disposed = false;
    void skillApi.listenSkillSourceDropped(event => {
      const path = event.paths[0];
      if (!path) return;
      // A drop must not replace a sheet that is downloading or installing (it would lose that work).
      if (importInFlightRef.current) {
        toastMessage(t("v33.importBusy"), "warn");
        return;
      }
      openImport(path, true);
    }).then(unlisten => {
      if (disposed) unlisten();
      else stop = unlisten;
    });
    return () => {
      disposed = true;
      stop?.();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void getMcpSummary().then(value => {
        if (!cancelled) setMcpCount(value?.servers ?? null);
      });
    }, 1_500);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [active === "dashboard"]);

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

  /* Ctrl/⌘+K focuses search from any page (bug #10); Ctrl+V outside a field means "+ 添加". */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "k") {
        if (document.querySelector("[data-overlay]")) return;
        event.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }
    };
    const onPaste = (event: ClipboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest?.("input, textarea, select, [contenteditable='true']")) return;
      if (document.querySelector("[data-overlay]")) return;
      const text = event.clipboardData?.getData("text/plain") ?? "";
      const kind = classifyAddInput(text);
      if (kind === "empty") return;
      event.preventDefault();
      if (kind === "mcp-config") {
        requestOpenMcpAdd(text);
        navigate("connections");
        return;
      }
      openImport(text.trim(), true);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("paste", onPaste);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("paste", onPaste);
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
  }, [active, agentDetailId]);

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
    const footers = [...document.querySelectorAll<HTMLElement>(".atlas-event-tape")];
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

  /* ---- global search: one result list, opening a drawer (I-6, bug #38) ---- */

  const skillCommandSearch = queryLooksLikeSkillCommand(globalSearch);
  const searchResults = useMemo(() => {
    const query = globalSearch.trim();
    if (!query) return { packs: [] as SearchPackResult[], skills: [] as SearchSkillResult[] };
    const packs: Array<SearchPackResult & { score: number }> = [];
    const skills: Array<SearchSkillResult & { score: number }> = [];
    for (const row of rows) {
      if (!skillCommandSearch && row.source && sourceMatchesSearch(row.source, query)) {
        packs.push({
          key: row.key,
          name: row.source.name,
          kind: row.kind,
          meta: row.kind === "prompt" ? t("v33.promptChip") : t("v33.skillsInPack", { n: row.skills.length }),
          score: sourceSearchScore(row.source, query)
        });
      }
      for (const skill of row.skills) {
        if (!skillMatchesSearch(skill, query)) continue;
        skills.push({
          key: row.key,
          skill,
          meta: row.source ? row.source.name : displayCategoryName(skill.category),
          score: skillSearchScore(skill, query)
        });
      }
    }
    packs.sort((a, b) => b.score - a.score);
    skills.sort((a, b) => b.score - a.score);
    return { packs: packs.slice(0, SEARCH_PACK_LIMIT), skills: skills.slice(0, SEARCH_SKILL_LIMIT) };
  }, [globalSearch, skillCommandSearch, rows, lang]);

  const operationProgress = operation ? Math.max(1, Math.min(100, Math.round(operation.percent))) : 0;
  const updateFeedback = useMemo(() => sourceCheckFailed
    ? { label: rt("run.checkFailed"), message: t("toast.syncFailed"), tone: "error" as const }
    : runtimeAvailable ? sourceUpdateFeedback(snapshot?.lastSyncSummary?.updateRun, snapshot?.sources) : null,
  [sourceCheckFailed, snapshot?.lastSyncSummary?.updateRun, snapshot?.sources, lang]);
  const atlasMode = isAtlasTheme(resolvedTheme);
  const atlasVisual = atlasThemeVisual(resolvedTheme);
  const indicator = useMemo(() => topSyncIndicator(delivery), [delivery]);
  const onboardingPending = delivery?.onboarding === "pending";
  const showOnboarding = onboardingPending && active === "dashboard" && !onboardingDeferred;
  const isMac = typeof navigator !== "undefined" && /mac/i.test(navigator.platform || navigator.userAgent);
  const closeProblems = useCallback(() => setProblemsOpen(false), []);
  const detailRow = detail ? rows.find(row => row.key === detail.key) ?? null : null;
  const reviewSource = reviewSourceId ? snapshot?.sources.find(source => source.id === reviewSourceId) ?? null : null;

  return (
    <main
      className={`${runtimeAvailable ? "shell v33" : "shell v33 browser-preview-shell"} theme-${resolvedTheme} ${atlasMode ? "theme-family-atlas" : "theme-family-classic"}${resolvedTheme.startsWith("sky-") ? " theme-family-sky" : ""} page-${active} lang-${lang} material-${material}${dashboardImmersive && active === "dashboard" ? " dashboard-immersive" : ""}`}
      data-runtime-hydrated={runtimeHydrated ? "true" : "false"}
      style={{
        "--ui-icon-scale": UI_ICON_SCALES[iconScale],
        "--ui-text-scale": UI_TEXT_SCALES[textScale]
      } as CSSProperties}
    >
      {atlasMode && active !== "dashboard" && !backgrounded && (
        <ParticleField
          accent={atlasVisual.accent}
          mode="backdrop"
          palette={atlasVisual.palette}
          sourceCount={summary.sources}
          skillCount={summary.skills}
        />
      )}
      <Sidebar
        active={active}
        onNavigate={key => {
          if (key === "agents") openAgent(null);
          if (key === "library") openLibrary();
          else navigate(key);
        }}
        updateCount={counts.updateRows}
      />

      <section className="workspace">
        <header className="topbar">
          <div className="command-search">
            <span className="search-icon" aria-hidden="true"><Icon name="search" /></span>
            <input
              aria-label={t("v33.searchLabel")}
              data-testid="global-search-input"
              onChange={event => setGlobalSearch(event.target.value)}
              onKeyDown={event => {
                if (event.key === "Escape") {
                  setGlobalSearch("");
                  event.currentTarget.blur();
                } else if (event.key === "Enter") {
                  const first = searchResults.packs[0]?.key ?? searchResults.skills[0]?.key;
                  if (first) openDetail(first);
                }
              }}
              placeholder={t("v33.searchPlaceholder")}
              ref={searchInputRef}
              value={globalSearch}
            />
            <kbd aria-hidden="true">{isMac ? "⌘ K" : "Ctrl K"}</kbd>
          </div>
          <div className="topbar-actions">
            <LanguageSwitcher current={lang} onChange={changeLang} />
            <ThemeSwitcher current={theme} onChange={changeTheme} />
            <button
              aria-label={t("project.openGithub")}
              className="icon-button project-home-link"
              data-testid="topbar-github"
              onClick={() => void openProjectHome()}
              title={t("project.openGithub")}
              type="button"
            >
              <Icon name="github" />
            </button>
            <button className="primary-pill add-pill" data-testid="add-button" onClick={() => openImport()} type="button">
              <Icon name="add" />
              <span>{t("v33.add")}</span>
            </button>
            <button
              className="ghost-pill update-pill"
              data-testid="update-button"
              disabled={mutationBusy}
              onClick={() => void syncAndRefreshAll()}
              title={updateFeedback ? `${t("v33.updateTip")} · ${updateFeedback.message}` : t("v33.updateTip")}
              type="button"
            >
              <Icon className={operation ? "icon-spin" : ""} name="refresh" />
              <span>{operation ? t("v33.updating") : t("v33.update")}</span>
              {!operation && counts.updateRows > 0 && <em className="pill-count">{counts.updateRows}</em>}
            </button>
            {appUpdate.phase === "available" && (
              <button className="update-available-pill" onClick={() => openSettings("updates")} type="button">
                <Icon name="download" />
                <span>{t("update.availableShort", { version: appUpdate.version })}</span>
              </button>
            )}
            <div className="sync-anchor">
              <SyncIndicatorButton indicator={indicator} onToggle={() => setProblemsOpen(value => !value)} open={problemsOpen} />
              {problemsOpen && (
                <ProblemsPopover
                  agents={delivery?.agents ?? []}
                  onAction={(action, problem) => runErrorAction(action, problem)}
                  onClose={closeProblems}
                  onRemoveEntry={problem => {
                    setProblemsOpen(false);
                    if (problem.unitId && problem.agentId) void setTarget(problem.unitId, problem.agentId, false);
                  }}
                  problems={delivery?.problems ?? []}
                  unitName={unitId => {
                    const row = rows.find(item => item.key === unitId);
                    return row?.source?.name ?? row?.skill?.name ?? "";
                  }}
                />
              )}
            </div>
            {snapshot?.lastSyncSummary?.updateRun && (
              <button className="icon-button" type="button" title={rt("run.title")} aria-label={rt("run.title")} aria-expanded={showUpdateResults} onClick={() => setShowUpdateResults(value => !value)}><Icon name="info" /></button>
            )}
          </div>
        </header>

        <div className="workspace-body">
          {globalSearch.trim() && (
            <GlobalSearchResults
              onClear={() => setGlobalSearch("")}
              onCopySkill={skill => void copySkillPrompt(skill, recordUsage)}
              onOpen={key => openDetail(key)}
              packs={searchResults.packs}
              query={globalSearch}
              skills={searchResults.skills}
            />
          )}

          {operation && (
            <section className="operation-banner" role="status" aria-live="polite">
              <div>
                <strong>{operation.title}</strong>
                <span>{operation.detail}</span>
                <small className="operation-percent">{operationProgress}%</small>
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

          {banner && (
            <ErrorBanner
              error={banner.error}
              onAction={action => runErrorAction(action, banner.error)}
              onDismiss={() => setBanner(null)}
            />
          )}

          <Suspense fallback={<DeferredSurface label={t("dash.loadingIndex")} />}>
            {showOnboarding && (
              <Onboarding
                onDone={(result, importMcp) => void onOnboardingDone(result, importMcp)}
                onLater={() => setOnboardingDeferred(true)}
                mcpEnabled
              />
            )}
            {active === "dashboard" && !showOnboarding && (
              <Dashboard
                counts={counts}
                delivery={delivery}
                homeVisual={homeVisual}
                immersive={dashboardImmersive}
                loading={loading}
                mcpCount={mcpCount}
                onAdd={text => {
                  if (text && classifyAddInput(text) === "mcp-config") {
                    requestOpenMcpAdd(text);
                    navigate("connections");
                    return;
                  }
                  // Pasted text is checked at once; a first typed character waits for more typing.
                  openImport(text ?? "", Boolean(text && text.length > 1));
                }}
                onChangeHomeVisual={changeHomeVisual}
                onOpenAgents={() => { openAgent(null); navigate("agents"); }}
                onOpenFolder={folderId => {
                  setGlobalSearch("");
                  openLibrary(folderId);
                }}
                onOpenLibrary={() => openLibrary()}
                onOpenMcp={() => navigate("connections")}
                onOpenOnboarding={() => setOnboardingDeferred(false)}
                onOpenProblems={() => setProblemsOpen(true)}
                onOpenSkill={skill => {
                  const row = rows.find(item => item.skills.includes(skill) || item.ownedSkills.includes(skill));
                  if (row) openDetail(row.key);
                }}
                onOpenSource={source => openDetail(source.id)}
                onRefreshPopularity={() => void refreshSourcePopularity()}
                onCopySkill={skill => void copySkillPrompt(skill, recordUsage)}
                onTakeover={agent => void setTakeover(agent, true)}
                onToggleImmersive={() => setDashboardImmersive(value => !value)}
                popularityRefreshing={popularityRefreshing}
                sceneSuspended={backgrounded}
                snapshot={snapshot}
                summary={summary}
                theme={resolvedTheme}
              />
            )}
            {active === "library" && (
              <Library
                agents={delivery?.agents ?? []}
                busyAction={busyAction}
                childBusy={childBusy}
                counts={counts}
                folderId={libraryFolderId}
                library={library}
                loading={loading}
                metadataAnalyzing={metadataAnalyzing}
                mutationBusy={mutationBusy}
                onAdd={() => openImport()}
                onBatchTargets={setTargetsBatch}
                onConsolidate={() => void consolidateSources()}
                onCopySkill={skill => void copySkillPrompt(skill, recordUsage)}
                onCreateFolder={(name, note, color) => runSkillFolderCommand(
                  "create_skill_folder", { name, note, color }, t("folders.created")
                )}
                onDeleteFolder={folderId => runSkillFolderCommand(
                  "delete_skill_folder", { folderId }, t("folders.deleted")
                )}
                onMoveSkillToFolder={(skillId, folderId) => runSkillFolderCommand(
                  "move_skill_to_folder", { skillId, folderId }, t("folders.moved")
                )}
                onMoveSourceToFolder={(sourceId, folderId) => runSkillFolderCommand(
                  "move_source_skills_to_folder", { sourceId, folderId }, t("folders.movedSource")
                )}
                onOpenDetail={openDetail}
                onSetLibraryEnabled={setSourceLibraryEnabled}
                onOpenLibraryFolder={() => void copyTextToClipboard(snapshot?.skillsDir ?? "", t("v33.libraryPathCopied"))}
                onReanalyze={() => void reanalyzeLibraryMetadata()}
                onRepair={() => void requestDelivery("repair", "full")}
                onSelectFolder={setLibraryFolderId}
                onSetChildEnabled={setChildSkillEnabled}
                onSetSkillRating={updateSkillRating}
                onSetSourceRating={updateSourceRating}
                onTargetClick={handleTargetClick}
                onUpdateFolder={(folderId, name, note, color) => runSkillFolderCommand(
                  "update_skill_folder", { folderId, name, note, color }, t("folders.updated")
                )}
                paused={delivery?.paused ?? false}
                rows={rows}
              />
            )}
            {active === "agents" && (
              <Agents
                agentDetailId={agentDetailId}
                delivery={delivery}
                onAdopted={onAdopted}
                onDetect={() => void refreshLocalAgents()}
                onOpenAgent={openAgent}
                onOpenFolder={agentId => void openAgentFolder(agentId)}
                onOpenLibraryRow={key => openDetail(key)}
                onOpenMcp={() => navigate("connections")}
                onProblemAction={(action, problem) => runErrorAction(action, problem)}
                onRemoveLeftovers={agentId => void setTargetsBatch((delivery?.targets ?? [])
                  .filter(target => target.agentId === agentId && target.status === "orphan")
                  .map(target => ({ unitId: target.unitId, agentId: target.agentId, enabled: false })))}
                onSyncNow={() => void requestDelivery("user", "full", true)}
                onTakeover={(agent, enabled) => void setTakeover(agent, enabled)}
                refreshing={agentsRefreshing}
                runtimeAvailable={runtimeAvailable}
                snapshot={snapshot}
              />
            )}
            {active === "connections" && (
              <McpCenter runtimeAvailable={runtimeAvailable} />
            )}
            {active === "settings" && (
              <Settings
                appUpdate={appUpdate}
                busyAction={busyAction}
                currentIconScale={iconScale}
                currentLang={lang}
                currentMaterial={material}
                currentTextScale={textScale}
                currentTheme={theme}
                devMode={devMode}
                disabled={mutationBusy}
                focus={settingsFocus}
                homeVisual={homeVisual}
                onChangeDevMode={changeDevMode}
                onChangeHomeVisual={changeHomeVisual}
                onChangeIconScale={changeIconScale}
                onChangeLang={changeLang}
                onChangeMaterial={changeMaterial}
                onChangeTelemetry={changeTelemetry}
                onChangeTextScale={changeTextScale}
                onChangeTheme={changeTheme}
                onCheckUpdate={() => void checkForAppUpdate(false)}
                onContinueSourceUpdate={() => void syncAndRefreshAll({ continueRun: true, refreshPopularity: false })}
                onError={message => showError(message, "other")}
                onExportReport={() => void exportReport()}
                onInstallUpdate={() => void installAppUpdate()}
                onOpenOfficialReleases={() => void openOfficialReleases()}
                onOpenProjectHome={() => void openProjectHome()}
                onQaStatus={(id, status) => void updateDesktopQaStatus(id, status)}
                onRefreshIndex={() => void refreshLocalIndex()}
                onRunRunner={runReleaseGateRunner}
                onSetPaused={paused => void setPaused(paused)}
                onSnapshotChange={next => {
                  applySnapshot(next);
                  clearBanner("other");
                  toastMessage(t("v33.identityDone"), "ok");
                }}
                paused={delivery?.paused ?? false}
                snapshot={library}
                startupVerified={startupVerified}
                telemetryOn={telemetryOn}
              />
            )}
          </Suspense>
        </div>

        <footer className="atlas-event-tape" aria-label={t("atlas.eventTape")}>
          <span><i /> {t("atlas.liveIndex")}</span>
          <span>{t("v33.tapeSkills")} <strong data-testid="tape-skill-count">{counts.skills.toLocaleString()}</strong></span>
          {/* Same pack number as the library header ("N 个技能 · M 个技能包"); 资料 are not packs. */}
          <span>{t("v33.tapePacks")} <strong data-testid="tape-pack-count">{counts.packs.toLocaleString()}</strong></span>
          <span className="atlas-event-mode">{runtimeAvailable ? t("atlas.desktopMode") : t("atlas.previewMode")}</span>
        </footer>

        {toast && (
          <div className={`toast tone-${toast.tone} is-visible`} role="status">
            <Icon name={toast.tone === "error" ? "alert" : toast.tone === "ok" ? "sparkle" : "info"} />
            <span>{toast.message}</span>
          </div>
        )}
      </section>

      <Suspense fallback={null}>
        {importSheet && (
          <ImportSheet
            agents={delivery?.agents ?? []}
            autoProbe={importSheet.autoProbe}
            folders={snapshot?.skillFolders ?? []}
            initialText={importSheet.text}
            key={importSheet.nonce}
            onBusyChange={setImportInFlight}
            onClose={() => setImportSheet(null)}
            onGoAgents={() => {
              setImportSheet(null);
              openAgent(null);
              navigate("agents");
            }}
            onInstalled={onImportInstalled}
            onOpenMcp={text => {
              setImportSheet(null);
              requestOpenMcpAdd(text);
              navigate("connections");
            }}
            onOpenRow={key => {
              setImportSheet(null);
              openDetail(key);
            }}
            onReloadLibrary={() => reloadLibraryQuietly()}
            rows={rows}
          />
        )}
        {detail && detailRow && (
          <SkillDrawer
            agents={delivery?.agents ?? []}
            busyAction={busyAction}
            childBusy={childBusy}
            folders={snapshot?.skillFolders ?? []}
            governance={detailRow.source ? snapshot?.sourceGovernance.find(item => item.sourceId === detailRow.source?.id) ?? null : null}
            initialTab={detail.tab}
            key={`${detail.key}:${detail.nonce}`}
            onClose={() => setDetail(null)}
            onDeleteSource={deleteSource}
            onMoveSkillToFolder={(skillId, folderId) => runSkillFolderCommand("move_skill_to_folder", { skillId, folderId }, "")}
            onMoveSourceToFolder={(sourceId, folderId) => runSkillFolderCommand("move_source_skills_to_folder", { sourceId, folderId }, "")}
            onOpenAgentFolder={agentId => void openAgentFolder(agentId)}
            onRefreshVersion={refreshSourceVersionStatus}
            onReview={sourceId => setReviewSourceId(sourceId)}
            onRollbackVersion={rollbackSourceVersion}
            onSaveSkillMetadata={updateSkillMetadata}
            onSaveSourceMetadata={updateSourceMetadata}
            onSetChildEnabled={setChildSkillEnabled}
            onSetLibraryEnabled={setSourceLibraryEnabled}
            onSetPinned={setSourceVersionPin}
            onSetSkillRating={updateSkillRating}
            onSetSourceRating={updateSourceRating}
            onTargetClick={handleTargetClick}
            onToggleTarget={(unitId, agentId, enabled) => void setTarget(unitId, agentId, enabled)}
            paused={delivery?.paused ?? false}
            popularity={detailRow.source ? snapshot?.sourcePopularity.find(item => item.sourceId === detailRow.source?.id) ?? null : null}
            row={detailRow}
            signals={detailRow.source ? snapshot?.sourceQualitySignals.find(item => item.sourceId === detailRow.source?.id) ?? null : null}
          />
        )}
        {reviewSource && (
          <ReviewSecurityDialog
            onClose={() => setReviewSourceId("")}
            onConfirm={async () => {
              const ok = await setSourceLibraryEnabled(reviewSource, true, true);
              if (ok) {
                setReviewSourceId("");
                toastMessage(t("v33.reviewEnabled", { name: reviewSource.name }), "ok");
              }
            }}
            signals={snapshot?.sourceQualitySignals.find(item => item.sourceId === reviewSource.id) ?? null}
            source={reviewSource}
          />
        )}
      </Suspense>
      {confirmNode}
      <div id="app-overlay-root" />
    </main>
  );
}

/**
 * True once the window has been hidden (minimized or in the tray) for a while. Heavy visuals
 * (the home 3D scene, the page backdrop) unmount then, so their GPU and canvas memory is released;
 * they come back as soon as the window is visible again.
 */
function useBackgrounded(delay = 20_000) {
  const [backgrounded, setBackgrounded] = useState(false);
  useEffect(() => {
    let timer: number | null = null;
    const update = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
      if (document.hidden) timer = window.setTimeout(() => setBackgrounded(true), delay);
      else setBackgrounded(false);
    };
    document.addEventListener("visibilitychange", update);
    update();
    return () => {
      document.removeEventListener("visibilitychange", update);
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [delay]);
  return backgrounded;
}

function readFlag(key: string) {
  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function initialHomeVisual(): HomeVisual {
  try {
    const value = window.localStorage.getItem(HOME_VISUAL_STORAGE_KEY);
    // 3.3.0's "off" became the 2D summary (归纳) view.
    if (value === "off" || value === "summary") return "summary";
    return value === "universe" ? value : "islands";
  } catch {
    return "islands";
  }
}

/** Preview-only folder commands, so the folder chips work with `pnpm dev`. */
function previewFolderResult(folders: SkillFolderCard[], command: string, args: Record<string, unknown>): SkillFolderCard[] {
  if (command === "create_skill_folder") {
    const name = String(args.name ?? "").trim();
    return [...folders, { id: `folder-preview-${Date.now()}`, name, note: String(args.note ?? ""), color: String(args.color ?? "cyan"), sortOrder: folders.length, skillCount: 0 } as SkillFolderCard];
  }
  if (command === "delete_skill_folder") return folders.filter(folder => folder.id !== args.folderId);
  if (command === "update_skill_folder") {
    return folders.map(folder => folder.id === args.folderId
      ? { ...folder, name: String(args.name ?? folder.name), note: String(args.note ?? folder.note), color: String(args.color ?? folder.color) }
      : folder);
  }
  return folders;
}

/** `?view=workspaces` → AI 工具, `?view=sources` → 技能, release tools → 设置 (bug #36). */
function initialNavKey(): NavKey {
  if (typeof window === "undefined") return "dashboard";
  const view = new URLSearchParams(window.location.search).get("view");
  if (view === "workspaces") return "agents";
  if (view === "sources") return "library";
  if (view === "release" || view === "snapshots" || view === "advanced") return "settings";
  return isNavKey(view) ? view : "dashboard";
}

function initialAgentDetail(): string | null {
  if (typeof window === "undefined") return null;
  const agent = new URLSearchParams(window.location.search).get("agent");
  return agent && /^[a-z-]{2,32}$/.test(agent) ? agent : null;
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
    value === "atlas-legacy-light"
  );
}

function isNavKey(value: string | null): value is NavKey {
  return (
    value === "dashboard" ||
    value === "library" ||
    value === "agents" ||
    value === "connections" ||
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
  // The whole redacted text, not just the first line: the updater often puts the cause
  // ("operation timed out", "invalid certificate") on a later line.
  const normalized = normalizeSkillHubError(error);
  const message = `${normalized.message} ${normalized.detail}`.toLocaleLowerCase("en-US");
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

function waitFor(milliseconds: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, milliseconds));
}
