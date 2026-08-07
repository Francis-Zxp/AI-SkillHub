import { invoke } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import {
  type CSSProperties,
  Fragment,
  Suspense,
  type PointerEvent,
  lazy,
  startTransition,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { createPortal } from "react-dom";
import { Icon, type IconName } from "./icons";
import { CountUp, ParticleField, useCardGlow } from "./effects";
import { LANG_OPTIONS, type Lang, categoryName, getLang, initialLang, setLang, t } from "./i18n";
import { SkillUniverse } from "./SkillUniverse";
import {
  createPreviewSnapshot,
  createPreviewSourceImportExecution,
  createPreviewSourceImportPlan,
  createPreviewSourceImportPromotion,
  updatePreviewDesktopQaStatus,
  updatePreviewEnabled,
  updatePreviewOperationRunner,
  updatePreviewRealWriteAuthorization,
  updatePreviewSkillRating
} from "./preview";
import type {
  AgentSkillStatusCard,
  DesktopQaCheckCard,
  LegacyCleanupCandidateCard,
  LegacyCleanupOperationCard,
  LegacySnapshot,
  LegacySummary,
  NavKey,
  ReleaseReportCard,
  RouterHubReport,
  SkillCard,
  SkillConflictCard,
  SourceCard,
  SourceImportExecutionCard,
  SourceImportPlanCard,
  SourceImportPromotionCard,
  SourceGovernanceCard,
  SourcePopularityCard,
  SourceQualitySignalCard,
  WorkspaceCard
} from "./types";

/* =============================================================
   Types and constants
   ============================================================= */

declare const __APP_VERSION__: string;

type ThemeName =
  | "nocturne"
  | "parchment"
  | "atlas-dark"
  | "atlas-light"
  | "atlas-legacy-dark"
  | "atlas-legacy-light"
  | "dark"
  | "light"
  | "classic-dark"
  | "classic-light";
type UiScalePreset = "compact" | "standard" | "comfortable" | "large";

type SkillDraft = { name: string; category: string; description: string; note: string; tags: string };
type SourceDraft = {
  name: string;
  category: string;
  enabled: boolean;
  note: string;
  sourceType: SourceCard["sourceType"];
  tags: string;
};
type QuickSourceDraft = Omit<SourceDraft, "name">;

type QuickAddStatus = {
  body: string;
  title: string;
  tone: "info" | "ok" | "warn" | "error";
};
type ImportProgress = {
  detail: string;
  indeterminate?: boolean;
  percent: number;
  step: number;
  total: number;
};
type SourceImportProgressEvent = {
  operationId: string;
  stage: "inspect" | "git" | "zip" | "write" | "security" | string;
  state: "started" | "progress" | "completed" | "cancelled" | string;
  message: string;
  current: number;
  total: number;
};
type ImportFeedbackOptions = {
  quiet?: boolean;
  securityReviewConfirmed?: boolean;
  operationId?: string;
  onProgress?: (event: SourceImportProgressEvent) => void;
};
type OperationStatus = { title: string; detail: string; step: number; total: number; percent: number };
type SourceSortKey = "recent" | "rating" | "usage" | "heat" | "skillCount" | "health" | "name";
type ToastTone = "info" | "ok" | "warn" | "error";
type AppUpdatePhase =
  | "idle"
  | "checking"
  | "retrying"
  | "latest"
  | "available"
  | "downloading"
  | "installing"
  | "error";
type AppUpdateState = {
  phase: AppUpdatePhase;
  progress: number;
  version: string;
};

const TOAST_EVENT = "ai-skillhub-toast";
const APP_VERSION = __APP_VERSION__;
const PROJECT_HOME_URL = "https://github.com/Francis-Zxp/AI-SkillHub";
const UI_TEXT_SCALE_STORAGE_KEY = "ai-skillhub-ui-text-scale";
const UI_ICON_SCALE_STORAGE_KEY = "ai-skillhub-ui-icon-scale";
const UI_TEXT_SCALES: Record<UiScalePreset, number> = {
  compact: 0.92,
  standard: 1,
  comfortable: 1.08,
  large: 1.16
};
const UI_ICON_SCALES: Record<UiScalePreset, number> = {
  compact: 0.92,
  standard: 1,
  comfortable: 1.2,
  large: 1.36
};
const UI_SCALE_OPTIONS: UiScalePreset[] = ["compact", "standard", "comfortable", "large"];
const THEME_OPTIONS: Array<{ icon: IconName; labelKey: string; value: ThemeName }> = [
  { value: "nocturne", labelKey: "theme.nocturne", icon: "moon" },
  { value: "parchment", labelKey: "theme.parchment", icon: "sun" },
  { value: "atlas-dark", labelKey: "theme.atlasDark", icon: "moon" },
  { value: "atlas-light", labelKey: "theme.atlasLight", icon: "sun" },
  { value: "atlas-legacy-dark", labelKey: "theme.atlasLegacyDark", icon: "moon" },
  { value: "atlas-legacy-light", labelKey: "theme.atlasLegacyLight", icon: "sun" },
  { value: "dark", labelKey: "theme.dark", icon: "moon" },
  { value: "light", labelKey: "theme.light", icon: "sun" },
  { value: "classic-dark", labelKey: "theme.classicDark", icon: "moon" },
  { value: "classic-light", labelKey: "theme.classicLight", icon: "sun" }
];
const NAV_ITEMS: Array<{ key: NavKey; icon: IconName }> = [
  { key: "dashboard", icon: "dashboard" },
  { key: "library", icon: "library" },
  { key: "workspaces", icon: "workspaces" },
  { key: "presets", icon: "list" },
  { key: "agents", icon: "agent" },
  { key: "connections", icon: "connections" }
];
const ADVANCED_NAV: NavKey[] = ["release", "snapshots"];
const McpCenter = lazy(() => import("./McpCenter").then(module => ({ default: module.McpCenter })));
const CodexPluginDoctorPanel = lazy(() =>
  import("./CodexPluginDoctorPanel").then(module => ({ default: module.CodexPluginDoctorPanel }))
);
const CATEGORY_IDS = [
  "academic-writing",
  "literature-research",
  "scientific-figures",
  "ui-design",
  "security-audit",
  "agent-tools",
  "image-generation",
  "knowledge-retrieval",
  "presentations",
  "prompt-polishing",
  "life-sciences",
  "clinical-medical",
  "finance-economics",
  "document-tools",
  "browser-automation",
  "data-analysis",
  "development",
  "general"
] as const;
const CATEGORY_KEYWORDS: Record<string, string[]> = {
  "academic-writing": ["paper", "manuscript", "nature", "academic", "writing", "论文", "科研", "学术"],
  "literature-research": ["literature", "citation", "reference", "pubmed", "arxiv", "文献"],
  "scientific-figures": ["figure", "plot", "chart", "matplotlib", "图表", "绘图"],
  "ui-design": ["ui", "ux", "design", "frontend", "界面", "设计"],
  "security-audit": ["security", "audit", "vibesec", "vulnerability", "安全"],
  "agent-tools": ["agent", "claude", "codex", "gstack", "tool", "智能体"],
  "image-generation": ["image", "gpt-image", "diffusion", "图像", "生成"],
  "knowledge-retrieval": ["retrieval", "search", "kb", "lookup", "exa", "检索"],
  "presentations": ["presentation", "slides", "ppt", "poster", "汇报"],
  "prompt-polishing": ["prompt", "polish", "awesome-ai", "润色", "提示词"],
  "life-sciences": ["bioinformatics", "genomics", "protein", "molecular", "生物", "基因", "蛋白"],
  "clinical-medical": ["clinical", "medical", "drug", "fda", "医学", "临床", "药物"],
  "finance-economics": ["finance", "financial", "economic", "stock", "金融", "经济"],
  "document-tools": ["document", "pdf", "docx", "spreadsheet", "文档", "表格"],
  "browser-automation": ["browser", "playwright", "chrome", "automation", "浏览器", "自动化"],
  "data-analysis": ["data", "analysis", "single-cell", "rnaseq", "pandas", "数据"],
  "development": ["code", "dev", "engineering", "react", "rust", "tauri", "工程"],
  "general": ["general", "misc", "other", "通用"]
};

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
  const [theme, setTheme] = useState<ThemeName>(() => initialTheme());
  const [textScale, setTextScale] = useState<UiScalePreset>(() => initialUiScale(UI_TEXT_SCALE_STORAGE_KEY, "standard"));
  const [iconScale, setIconScale] = useState<UiScalePreset>(() => initialUiScale(UI_ICON_SCALE_STORAGE_KEY, "comfortable"));
  const [snapshot, setSnapshot] = useState<LegacySnapshot | null>(null);
  const [loadError, setLoadError] = useState("");
  const [loading, setLoading] = useState(true);
  const [operation, setOperation] = useState<OperationStatus | null>(null);
  const [toast, setToast] = useState<{ message: string; tone: ToastTone } | null>(null);
  const [globalSearch, setGlobalSearch] = useState("");
  const [appUpdate, setAppUpdate] = useState<AppUpdateState>({ phase: "idle", progress: 0, version: "" });
  const [dashboardImmersive, setDashboardImmersive] = useState(false);
  const updateRef = useRef<Update | null>(null);
  const updateRetryTimerRef = useRef<number | null>(null);
  const backgroundUpdateRetriesRef = useRef(0);
  const runtimeAvailable = hasTauriRuntime();
  const realWritesEnabled = snapshot?.operatorConsent?.realWritesEnabled === true;

  useCardGlow();

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

  async function checkForAppUpdate(silent = false) {
    if (!runtimeAvailable) {
      setAppUpdate({ phase: "idle", progress: 0, version: "" });
      if (!silent) toastMessage(t("update.desktopOnly"), "info");
      return;
    }
    if (updateRetryTimerRef.current !== null) {
      window.clearTimeout(updateRetryTimerRef.current);
      updateRetryTimerRef.current = null;
    }
    if (!silent) backgroundUpdateRetriesRef.current = 0;

    const retryDelays = silent ? [0, 1_600] : [0, 1_100, 3_200];
    for (let attempt = 0; attempt < retryDelays.length; attempt += 1) {
      const delay = retryDelays[attempt];
      if (delay > 0) {
        setAppUpdate({ phase: "retrying", progress: attempt, version: "" });
        await waitFor(delay);
      } else {
        setAppUpdate(current => ({ ...current, phase: "checking", progress: 0 }));
      }

      try {
        const nextUpdate = await check({ timeout: 15_000 });
        backgroundUpdateRetriesRef.current = 0;
        if (!nextUpdate) {
          if (updateRef.current) {
            await updateRef.current.close().catch(() => undefined);
            updateRef.current = null;
          }
          setAppUpdate({ phase: "latest", progress: 100, version: APP_VERSION });
          if (!silent) toastMessage(t("update.latestToast"), "ok");
          return;
        }
        if (updateRef.current) await updateRef.current.close().catch(() => undefined);
        updateRef.current = nextUpdate;
        setAppUpdate({ phase: "available", progress: 0, version: nextUpdate.version });
        toastMessage(t("update.availableToast", { version: nextUpdate.version }), "info");
        return;
      } catch {
        // A newly published release can take a short time to reach every
        // GitHub endpoint. The bounded retry state below is the user-facing
        // diagnostic; do not leak raw transport details into the UI/console.
      }
    }

    setAppUpdate({ phase: "error", progress: 0, version: "" });
    const retryNumber = backgroundUpdateRetriesRef.current;
    if (retryNumber < 2) {
      backgroundUpdateRetriesRef.current += 1;
      const retryAfter = retryNumber === 0 ? 45_000 : 120_000;
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
    const nextUpdate = updateRef.current;
    if (!nextUpdate) {
      await checkForAppUpdate(false);
      return;
    }
    let downloaded = 0;
    let total = 0;
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
          setAppUpdate(current => ({ ...current, phase: "installing", progress: 98 }));
        }
      }, { timeout: 120_000 });
      setAppUpdate(current => ({ ...current, phase: "installing", progress: 100 }));
      await relaunch();
    } catch {
      setAppUpdate(current => ({ ...current, phase: "error", progress: 0 }));
      toastMessage(t("update.errorToast"), "error");
    }
  }

  function applySnapshot(nextSnapshot: LegacySnapshot, background = false) {
    if (background) startTransition(() => setSnapshot(nextSnapshot));
    else setSnapshot(nextSnapshot);
  }

  /* ---- backend bridges ---- */

  async function loadSnapshot(
    mode: "indexed" | "refresh" = "indexed",
    options: { background?: boolean; quiet?: boolean } = {}
  ): Promise<LegacySnapshot | null> {
    if (!options.background) setLoading(true);
    try {
      if (!runtimeAvailable) {
        const preview = createPreviewSnapshot();
        setSnapshot(preview);
        setLoadError("");
        return preview;
      }
      const command = mode === "refresh" ? "run_skillhub_sync" : "load_indexed_snapshot";
      const result = await invoke<LegacySnapshot>(command);
      applySnapshot(result, Boolean(options.background));
      setLoadError("");
      if (mode === "refresh" && !options.quiet) toastMessage(t("toast.refreshDone"), "ok");
      return result;
    } catch (error) {
      setLoadError(messageFromError(error));
      return null;
    } finally {
      if (!options.background) setLoading(false);
    }
  }

  async function updateEnabled(command: string, id: string, enabled: boolean) {
    setLoading(true);
    try {
      if (!runtimeAvailable) {
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
    setLoading(true);
    try {
      if (!runtimeAvailable) {
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
    const normalizedRating = Math.max(0, Math.min(5, Math.round(rating)));
    if (!runtimeAvailable) {
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

  async function updateSourceRating(source: SourceCard, rating: number): Promise<boolean> {
    const normalizedRating = Math.max(0, Math.min(5, Math.round(rating)));
    if (!runtimeAvailable) {
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
          ? t("toast.skillRated", { n: normalizedRating })
          : t("toast.skillRatingCleared"),
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
    if (!runtimeAvailable) {
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
    if (!runtimeAvailable) {
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
    if (!runtimeAvailable) {
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
    if (!runtimeAvailable) return "preview";
    setLoading(true);
    try {
      let result = await invoke<LegacySnapshot>("set_source_metadata", {
        sourceId: source.id,
        name: draft.name,
        sourceType: draft.sourceType,
        category: draft.category,
        note: draft.note,
        enabled: draft.enabled
      });
      result = await invoke<LegacySnapshot>("set_source_tags", {
        sourceId: source.id,
        tags: parseTagInput(draft.tags)
      });
      setSnapshot(result);
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
    if (!runtimeAvailable) {
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

  async function updateSkillConflictChoice(
    conflictKey: string,
    defaultSkillId: string,
    status: "default-set" | "ignored" | "unresolved"
  ) {
    if (!runtimeAvailable) {
      setSnapshot(current => {
        if (!current) return current;
        return {
          ...current,
          skillConflicts: current.skillConflicts.map(conflict => {
            if (conflict.conflictKey !== conflictKey) return conflict;
            const automatic = conflict.choices[0];
            const selected =
              status === "unresolved"
                ? automatic
                : conflict.choices.find(choice => choice.skillId === defaultSkillId);
            const nextStatus = status === "unresolved" ? "auto-set" : status;
            return {
              ...conflict,
              defaultSkillId: nextStatus === "ignored" ? "" : selected?.skillId ?? "",
              defaultSourceName: nextStatus === "ignored" ? "" : selected?.sourceName ?? "",
              status: nextStatus,
              updatedAt: new Date().toISOString()
            };
          })
        };
      });
      toastMessage(t("toast.previewConflictSim"), "info");
      return;
    }
    setLoading(true);
    try {
      const result = await invoke<LegacySnapshot>("set_skill_conflict_choice", {
        conflictKey,
        defaultSkillId,
        status
      });
      setSnapshot(result);
      setLoadError("");
      toastMessage(
        status === "default-set"
          ? t("conf.toastDefault")
          : status === "ignored"
            ? t("conf.toastIgnored")
            : t("conf.toastReset"),
        "ok"
      );
    } catch (error) {
      setLoadError(messageFromError(error));
      toastMessage(t("conf.toastFailed"), "error");
    } finally {
      setLoading(false);
    }
  }

  async function runReleaseGateRunner(runnerId: string) {
    setLoading(true);
    try {
      if (!runtimeAvailable) {
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
    setLoading(true);
    try {
      if (!runtimeAvailable) {
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
    if (!runtimeAvailable) return;
    try {
      const result = await invoke<LegacySnapshot>("record_usage_event", {
        targetType,
        targetId,
        targetName,
        sourceName,
        eventType
      });
      setSnapshot(result);
    } catch (error) {
      setLoadError(messageFromError(error));
    }
  }

  async function refreshSourcePopularity(
    options: { quiet?: boolean; background?: boolean } = {}
  ): Promise<LegacySnapshot | null> {
    if (!runtimeAvailable) {
      setSnapshot(prev => prev ?? createPreviewSnapshot());
      if (!options.quiet) toastMessage(t("pop.previewToast"), "info");
      return snapshot ?? createPreviewSnapshot();
    }
    if (!options.background) setLoading(true);
    try {
      const result = await invoke<LegacySnapshot>("refresh_source_popularity");
      applySnapshot(result, Boolean(options.background));
      setLoadError("");
      if (!options.quiet) {
        const summaryText = sourcePopularityRefreshMessage(summarizeSourcePopularity(result));
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
    if (!runtimeAvailable) {
      toastMessage(t("metadata.previewToast"), "info");
      return snapshot ?? createPreviewSnapshot();
    }
    setLoading(true);
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
      setLoading(false);
    }
  }

  async function syncAndRefreshAll(): Promise<LegacySnapshot | null> {
    if (operation) {
      toastMessage(t("toast.syncBusy"), "warn");
      return snapshot;
    }
    setOperation({ title: t("op.syncTitle"), detail: t("op.step1"), step: 1, total: 3, percent: 28 });
    const refreshed = await loadSnapshot("refresh", { background: true, quiet: true });
    if (!runtimeAvailable) {
      setOperation(null);
      return refreshed;
    }
    setOperation({ title: t("op.syncTitle"), detail: t("op.step2"), step: 2, total: 3, percent: 68 });
    const popularity = await refreshSourcePopularity({ quiet: true, background: true });
    if (!popularity) {
      toastMessage(t("toast.indexNoHeat"), "warn");
      setOperation(null);
      return refreshed;
    }
    setOperation({ title: t("op.syncTitle"), detail: t("op.step3"), step: 3, total: 3, percent: 100 });
    toastMessage(
      `${t("toast.syncDone")} · ${sourcePopularityRefreshMessage(summarizeSourcePopularity(popularity))}`,
      "ok"
    );
    window.setTimeout(() => setOperation(null), 900);
    return popularity;
  }

  async function refreshLocalAgents(): Promise<LegacySnapshot | null> {
    if (!runtimeAvailable) {
      const preview = createPreviewSnapshot();
      setSnapshot(preview);
      toastMessage(t("agents.detectToast"), "ok");
      return preview;
    }
    setLoading(true);
    try {
      const refreshed = await invoke<LegacySnapshot>("refresh_agent_detection");
      setSnapshot(refreshed);
      setLoadError("");
      toastMessage(t("agents.detectToast"), "ok");
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

  /* ---- lifecycle ---- */

  useEffect(() => {
    void loadSnapshot();
  }, []);

  useEffect(() => {
    if (!runtimeAvailable) return;
    const timer = window.setTimeout(() => void checkForAppUpdate(true), 2600);
    return () => {
      window.clearTimeout(timer);
      if (updateRetryTimerRef.current !== null) {
        window.clearTimeout(updateRetryTimerRef.current);
        updateRetryTimerRef.current = null;
      }
    };
  }, [runtimeAvailable]);

  useEffect(() => {
    document.body.dataset.theme = theme;
    window.localStorage.setItem("ai-skillhub-theme", theme);
  }, [theme]);

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
  const advancedActive = active === "release" || active === "snapshots";
  const atlasMode = isAtlasTheme(theme);
  const atlasVisual = atlasThemeVisual(theme);

  return (
    <main
      className={`${runtimeAvailable ? "shell" : "shell browser-preview-shell"} theme-${theme} ${atlasMode ? "theme-family-atlas" : "theme-family-classic"} page-${active} lang-${lang}${dashboardImmersive && active === "dashboard" ? " dashboard-immersive" : ""}`}
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
              onClick={() => setActive(item.key)}
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
                if (event.key === "Enter" && globalSearch.trim()) setActive("library");
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
              disabled={loading || Boolean(operation)}
              onClick={() => void syncAndRefreshAll()}
              type="button"
            >
              <Icon className={loading || Boolean(operation) ? "icon-spin" : ""} name="refresh" />
              <span>
                {runtimeAvailable
                  ? operation
                    ? t("topbar.backgroundSync")
                    : loading
                      ? snapshot
                        ? t("topbar.processing")
                        : t("topbar.loadingIndex")
                      : realWritesEnabled
                        ? t("topbar.sync")
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
              <i style={{ "--operation-progress": `${operationProgress}%` } as CSSProperties} />
            </section>
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

          {globalSearch.trim() && (
            <GlobalSearchResults
              onClear={() => setGlobalSearch("")}
              onOpenLibrary={() => setActive("library")}
              onCopySkill={skill => void copySkillPrompt(skill, recordUsage)}
              query={globalSearch}
              skills={globalSearchResults.skills}
              sources={globalSearchResults.sources}
            />
          )}

          {active === "dashboard" && (
            <Dashboard
              immersive={dashboardImmersive}
              loading={loading}
              onCopySkill={skill => void copySkillPrompt(skill, recordUsage)}
              onOpenAdvanced={() => setActive("release")}
              onOpenAgents={() => setActive("agents")}
              onOpenLibrary={() => setActive("library")}
              onOpenSkill={skill => {
                setGlobalSearch(`/${skill.name}`);
                setActive("library");
              }}
              onOpenSource={source => {
                setGlobalSearch(source.name);
                setActive("library");
              }}
              onRefreshPopularity={() => void refreshSourcePopularity()}
              onSync={() => void syncAndRefreshAll()}
              onToggleImmersive={() => setDashboardImmersive(value => !value)}
              snapshot={snapshot}
              summary={summary}
              syncing={Boolean(operation)}
              theme={theme}
            />
          )}
          {active === "library" && (
            <Library
              loading={loading}
              onDeleteSource={deleteSource}
              onCancelImport={cancelSourceImport}
              onPreviewImport={previewSourceImportCandidate}
              onStageImport={stageSourceImportCandidate}
              onPromoteImport={promoteStagedSourceImport}
              onReanalyzeMetadata={reanalyzeLibraryMetadata}
              onRefreshIndex={() => syncAndRefreshAll()}
              onRecordUsage={recordUsage}
              onSaveSkillMetadata={updateSkillMetadata}
              onSaveSourceMetadata={updateSourceMetadata}
              onSetSkillConflictChoice={updateSkillConflictChoice}
              onSetSkillEnabled={updateSkillEnabled}
              onSetSkillRating={updateSkillRating}
              onSetSourceRating={updateSourceRating}
              onSetSourceVersionPin={setSourceVersionPin}
              onRefreshSourceVersion={refreshSourceVersionStatus}
              onRollbackSourceVersion={rollbackSourceVersion}
              atlasMode={atlasMode}
              realWritesEnabled={realWritesEnabled}
              searchQuery={globalSearch}
              snapshot={snapshot}
            />
          )}
          {active === "workspaces" && (
            <Workspaces disabled={loading} onToggle={updateEnabled} snapshot={snapshot} />
          )}
          {active === "presets" && (
            <Presets
              disabled={loading}
              onToggle={updateEnabled}
              snapshot={snapshot}
            />
          )}
          {active === "agents" && (
            <Agents
              disabled={loading}
              onRefreshAgents={() => void refreshLocalAgents()}
              onToggle={updateEnabled}
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
              disabled={loading}
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
              disabled={loading}
              appUpdate={appUpdate}
              onChangeIconScale={changeIconScale}
              onChangeLang={changeLang}
              onChangeTextScale={changeTextScale}
              onChangeTheme={changeTheme}
              onCheckUpdate={() => void checkForAppUpdate(false)}
              onInstallUpdate={() => void installAppUpdate()}
              onOpenAdvanced={() => setActive("release")}
              snapshot={snapshot}
            />
          )}
        </div>

        <footer className="atlas-event-tape" aria-label={t("atlas.eventTape")}>
          <span><i /> {t("atlas.liveIndex")}</span>
          <span>SKILLS <strong>{summary.skills.toLocaleString()}</strong></span>
          <span>SOURCES <strong>{summary.sources.toLocaleString()}</strong></span>
          <span>ROUTES <strong>{snapshot?.skillConflicts.length.toLocaleString() ?? "0"}</strong></span>
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

function DeferredSurface({ label }: { label: string }) {
  return (
    <section className="deferred-surface glow-card" role="status">
      <Icon className="icon-spin" name="refresh" />
      <span>{label}</span>
    </section>
  );
}

/* =============================================================
   Language switcher
   ============================================================= */

function LanguageSwitcher({ current, onChange }: { current: Lang; onChange: (lang: Lang) => void }) {
  const [open, setOpen] = useState(false);
  const currentOption = LANG_OPTIONS.find(option => option.value === current) ?? LANG_OPTIONS[0];

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest?.(".lang-switcher")) return;
      setOpen(false);
    };
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [open]);

  return (
    <div className={open ? "lang-switcher open" : "lang-switcher"}>
      <button
        aria-expanded={open}
        aria-haspopup="listbox"
        className="lang-trigger"
        onClick={event => {
          event.stopPropagation();
          setOpen(value => !value);
        }}
        type="button"
        title={currentOption.label}
      >
        <Icon name="globe" />
        <span>{currentOption.short}</span>
      </button>
      {open && (
        <ul className="lang-menu" role="listbox">
          {LANG_OPTIONS.map(option => (
            <li key={option.value}>
              <button
                aria-selected={option.value === current}
                className={option.value === current ? "active" : ""}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
                role="option"
                type="button"
              >
                <strong>{option.label}</strong>
                <small>{option.short}</small>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ThemeSwitcher({ current, onChange }: { current: ThemeName; onChange: (theme: ThemeName) => void }) {
  const [open, setOpen] = useState(false);
  const currentOption = THEME_OPTIONS.find(option => option.value === current) ?? THEME_OPTIONS[0];

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest?.(".theme-switcher")) return;
      setOpen(false);
    };
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [open]);

  return (
    <div className={open ? "theme-switcher open" : "theme-switcher"}>
      <button
        aria-expanded={open}
        aria-haspopup="listbox"
        className="theme-trigger"
        onClick={event => {
          event.stopPropagation();
          setOpen(value => !value);
        }}
        type="button"
        title={t("theme.choose", { current: themeLabel(current) })}
      >
        <Icon name={themeIcon(current)} />
      </button>
      {open && (
        <ul className="theme-menu" role="listbox">
          {THEME_OPTIONS.map(option => (
            <li key={option.value}>
              <button
                aria-selected={option.value === current}
                className={option.value === current ? "active" : ""}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
                role="option"
                type="button"
              >
                <span aria-hidden="true"><Icon name={option.icon} /></span>
                <strong>{t(option.labelKey)}</strong>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* =============================================================
   Global search results bar
   ============================================================= */

function GlobalSearchResults({
  onClear,
  onCopySkill,
  onOpenLibrary,
  query,
  skills,
  sources
}: {
  onClear: () => void;
  onCopySkill: (skill: SkillCard) => void;
  onOpenLibrary: () => void;
  query: string;
  skills: SkillCard[];
  sources: SourceCard[];
}) {
  const skillCommand = queryLooksLikeSkillCommand(query);
  return (
    <section className="global-search-results" role="search">
      <div className="global-search-head">
        <div>
          <strong>{t("search.searching", { query: query.trim() })}</strong>
          <span>{skillCommand ? t("search.skillHint") : t("search.bothHint")}</span>
        </div>
        <button className="ghost-action" onClick={onClear} type="button">{t("search.clear")}</button>
      </div>
      <div className="global-search-columns">
        {!skillCommand && (
          <div>
            <button className="search-column-title" onClick={onOpenLibrary} type="button">
              <Icon name="sources" /> {t("search.sources")} <em>{sources.length}</em>
            </button>
            {sources.length === 0 ? (
              <small className="search-empty">{t("search.noSources")}</small>
            ) : (
              sources.map(source => (
                <button className="search-result-item" key={source.id} onClick={onOpenLibrary} type="button">
                  <strong>{source.name}</strong>
                  <span>{displayCategoryName(source.categoryId)} · {sourceTypeLabel(source.sourceType)}</span>
                </button>
              ))
            )}
          </div>
        )}
        <div>
          <button className="search-column-title" onClick={onOpenLibrary} type="button">
            <Icon name="sparkle" /> {t("search.skills")} <em>{skills.length}</em>
          </button>
          {skills.length === 0 ? (
            <small className="search-empty">{t("search.noSkills")}</small>
          ) : (
            skills.map(skill => (
              <div className="search-result-item search-result-skill" key={skill.folderName}>
                <button className="search-result-main" onClick={onOpenLibrary} type="button">
                  <strong>/{skill.name}</strong>
                  <span>{displayCategoryName(skill.category)} · {skill.source || "local"}</span>
                </button>
                <button className="search-result-copy" onClick={() => onCopySkill(skill)} type="button">
                  <Icon name="copy" /> {t("search.copy")}
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </section>
  );
}

/* =============================================================
   Dashboard view
   ============================================================= */

const ATLAS_INTRO_VISIBILITY_KEY = "ai-skillhub-atlas-intro-visible";

function Dashboard({
  immersive,
  loading,
  onCopySkill,
  onOpenAdvanced,
  onOpenAgents,
  onOpenLibrary,
  onOpenSkill,
  onOpenSource,
  onRefreshPopularity,
  onSync,
  onToggleImmersive,
  snapshot,
  summary,
  syncing,
  theme
}: {
  immersive: boolean;
  loading: boolean;
  onCopySkill: (skill: SkillCard) => void;
  onOpenAdvanced: () => void;
  onOpenAgents: () => void;
  onOpenLibrary: () => void;
  onOpenSkill: (skill: SkillCard) => void;
  onOpenSource: (source: SourceCard) => void;
  onRefreshPopularity: () => void;
  onSync: () => void;
  onToggleImmersive: () => void;
  snapshot: LegacySnapshot | null;
  summary: LegacySummary;
  syncing: boolean;
  theme: ThemeName;
}) {
  const backupBlocked = countByStatus(snapshot?.backupDryRun ?? [], "blocked");
  const restoreBlocked = countByStatus(snapshot?.restoreDryRun ?? [], "blocked");
  const rollbackBlocked = countByStatus(snapshot?.rollbackPlan ?? [], "blocked");
  const healthIssues = summary.warnings + backupBlocked + restoreBlocked + rollbackBlocked;
  const [atlasIntroVisible, setAtlasIntroVisible] = useState(() => {
    try {
      return window.localStorage.getItem(ATLAS_INTRO_VISIBILITY_KEY) !== "false";
    } catch {
      return true;
    }
  });
  const alerts = [
    {
      icon: "alert" as const,
      title: healthIssues > 0 ? t("dash.alertGateReview") : t("dash.alertGateClear"),
      body:
        healthIssues > 0
          ? t("dash.alertGateReviewBody", { n: healthIssues })
          : t("dash.alertGateClearBody")
    },
    {
      icon: "refresh" as const,
      title: loading ? t("dash.alertIndexRunning") : t("dash.alertIndexReady"),
      body: snapshot?.index.databaseFile
        ? t("dash.alertIndexBodyReady")
        : t("dash.alertIndexBodySeed")
    },
    {
      icon: "info" as const,
      title: t("dash.alertDaily"),
      body: t("dash.alertDailyBody")
    }
  ];
  const atlasMode = isAtlasTheme(theme);
  const atlasVisual = atlasThemeVisual(theme);
  const toggleAtlasIntro = () => {
    const next = !atlasIntroVisible;
    setAtlasIntroVisible(next);
    try {
      window.localStorage.setItem(ATLAS_INTRO_VISIBILITY_KEY, String(next));
    } catch {
      // The visual preference can remain session-only when storage is unavailable.
    }
  };

  return (
    <div className="view dashboard-view">
      <section className={`dashboard-hero glow-card${atlasMode && !atlasIntroVisible ? " intro-collapsed" : ""}`}>
        {atlasMode && (
          <SkillUniverse
            centered={!atlasIntroVisible}
            lightTheme={isLightTheme(theme)}
            onOpenSkill={onOpenSkill}
            onOpenSource={onOpenSource}
            snapshot={snapshot}
            tone={
              theme === "nocturne"
                ? "prism"
                : theme === "parchment"
                  ? "parchment"
                  : theme === "atlas-light" || theme === "atlas-legacy-light"
                    ? "mist"
                    : "biolume"
            }
          />
        )}
        {!atlasMode && (
          <ParticleField
            accent={atlasVisual.accent}
            mode="ambient"
            palette={atlasVisual.palette}
            sourceCount={summary.sources}
            skillCount={summary.skills}
          />
        )}
        {atlasMode && (
          <button
            aria-pressed={immersive}
            className="atlas-immersive-toggle"
            onClick={onToggleImmersive}
            title={immersive ? t("atlas.exitImmersive") : t("atlas.enterImmersive")}
            type="button"
          >
            <Icon name={immersive ? "exitFullscreen" : "fullscreen"} />
            <span>{immersive ? t("atlas.exitImmersive") : t("atlas.enterImmersive")}</span>
          </button>
        )}
        {atlasMode && (
          <button
            aria-pressed={!atlasIntroVisible}
            className="atlas-intro-toggle"
            onClick={toggleAtlasIntro}
            title={atlasIntroVisible ? t("atlas.hideIntro") : t("atlas.showIntro")}
            type="button"
          >
            <Icon name="info" />
            <span>{atlasIntroVisible ? t("atlas.hideIntro") : t("atlas.showIntro")}</span>
          </button>
        )}
        <div aria-hidden={atlasMode && !atlasIntroVisible} className="dashboard-hero-inner">
          <div className="atlas-hero-copy">
            <span className="eyebrow"><Icon name="sparkle" /> AI SkillHub · {atlasMode ? t("atlas.releaseTag") : "3.0 / CLASSIC"}</span>
            <h2>{atlasMode ? t("atlas.heroTitle") : t("dash.title")}</h2>
            <p>{atlasMode ? t("atlas.heroSubtitle", { skills: summary.skills, sources: summary.sources }) : t("dash.subtitle")}</p>
            {atlasMode && (
              <span className="atlas-interaction-hint"><i aria-hidden="true" /> {t("atlas.interact")}</span>
            )}
          </div>
          {!atlasMode && (
            <div className="hero-actions">
              <button className="secondary-action" disabled={loading} onClick={onSync} type="button">
                <Icon className={loading ? "icon-spin" : ""} name="refresh" /> {syncing ? t("dash.syncing") : loading ? snapshot ? t("dash.processing") : t("dash.loadingIndex") : t("dash.sync")}
              </button>
              <button className="primary-action" onClick={onOpenLibrary} type="button">
                <Icon name="add" /> {t("dash.addSource")}
              </button>
            </div>
          )}
        </div>
      </section>

      <section className={`metric-grid${atlasMode ? " atlas-touchbar" : ""}`}>
        <Metric
          accent="violet"
          icon="sparkle"
          label={t("dash.metricSkills")}
          onClick={onOpenLibrary}
          trend={t("dash.trendSources", { n: summary.sources })}
          value={summary.skills}
        />
        <Metric
          accent="indigo"
          icon="sources"
          label={t("dash.metricSources")}
          onClick={onOpenLibrary}
          trend={t("dash.trendPrompts", { n: summary.prompts })}
          value={summary.sources}
        />
        <Metric
          accent="amber"
          icon="agent"
          label={t("dash.metricAgents")}
          onClick={onOpenAgents}
          trend={t("dash.trendAgents", { n: summary.agentsDetected })}
          value={summary.agentsDetected}
        />
        <Metric
          accent="rose"
          icon="alert"
          label={t("dash.metricIssues")}
          onClick={onOpenAdvanced}
          trend={healthIssues > 0 ? t("dash.trendAttention") : t("dash.trendClear")}
          value={healthIssues}
        />
        {atlasMode && (
          <div className="atlas-touchbar-actions">
            <button disabled={loading} onClick={onSync} title={t("dash.sync")} type="button">
              <Icon className={loading ? "icon-spin" : ""} name="refresh" />
              <span>{syncing ? t("dash.syncing") : loading ? snapshot ? t("dash.processing") : t("dash.loadingIndex") : t("dash.sync")}</span>
            </button>
            <button onClick={onOpenLibrary} title={t("dash.addSource")} type="button">
              <Icon name="add" />
              <span>{t("dash.addSource")}</span>
            </button>
          </div>
        )}
      </section>

      {!atlasMode && (
        <SkillShowcase
          loading={loading}
          onCopySkill={onCopySkill}
          onOpenLibrary={onOpenLibrary}
          snapshot={snapshot}
        />
      )}

      <section className="dashboard-grid">
        <UsageInsightPanel loading={loading} onRefreshPopularity={onRefreshPopularity} snapshot={snapshot} />

        <aside className="panel alerts-panel glow-card">
          <header className="panel-head">
            <div>
              <span className="eyebrow">{t("dash.alerts")}</span>
              <h3>{t("dash.alerts")}</h3>
            </div>
            <em className="badge-soft">{healthIssues} SYS</em>
          </header>
          <div className="alert-list">
            {alerts.map(alert => (
              <article className="alert-item" key={alert.title}>
                <span className="alert-icon"><Icon name={alert.icon} /></span>
                <div>
                  <strong>{alert.title}</strong>
                  <p>{alert.body}</p>
                </div>
              </article>
            ))}
          </div>
          <ActivityTimeline snapshot={snapshot} />
        </aside>
      </section>
    </div>
  );
}

function ActivityTimeline({ snapshot }: { snapshot: LegacySnapshot | null }) {
  const events = snapshot?.auditEvents ?? [];
  return (
    <section className="activity-timeline" aria-label={t("dash.activity")}>
      <header>
        <strong>{t("dash.activity")}</strong>
        <span>{t("dash.logs", { n: events.length })}</span>
      </header>
      <div>
        {events.slice(0, 4).map(event => (
          <article key={event.id}>
            <i />
            <div>
              <strong>{auditEventLabel(event.eventType)}</strong>
              <p>{event.summary}</p>
              <small>{formatScanTime(event.createdAt)}</small>
            </div>
          </article>
        ))}
        {events.length === 0 && <p className="empty-activity">{t("dash.noActivity")}</p>}
      </div>
    </section>
  );
}

/* =============================================================
   Skill showcase — the "wow" surface for installed skills
   ============================================================= */

function SkillShowcase({
  loading,
  onCopySkill,
  onOpenLibrary,
  snapshot
}: {
  loading: boolean;
  onCopySkill: (skill: SkillCard) => void;
  onOpenLibrary: () => void;
  snapshot: LegacySnapshot | null;
}) {
  const skills = snapshot?.skills ?? [];
  const sources = snapshot?.sources ?? [];
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const graphRef = useRef<SkillGraphRuntime | null>(null);
  const graphData = useMemo(() => buildSkillGraphData(skills, sources), [skills, sources]);
  const categoryLegend = useMemo(() => buildConstellationLegend(skills, sources), [skills, sources]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const host = canvas?.parentElement;
    if (!canvas || !host) return;

    const context = canvas.getContext("2d");
    if (!context) return;

    const runtime: SkillGraphRuntime = {
      dragStartX: 0,
      dragStartY: 0,
      dragged: false,
      dragging: false,
      hitNodes: [],
      hoverId: "",
      panX: 0,
      panY: 0,
      pointerX: 0,
      pointerY: 0
    };
    graphRef.current = runtime;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let frame = 0;
    let frameTimer = 0;
    let disposed = false;

    const resizeCanvas = () => {
      const rect = host.getBoundingClientRect();
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.floor(rect.width * ratio));
      canvas.height = Math.max(1, Math.floor(rect.height * ratio));
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
    };

    const draw = (time: number) => {
      if (disposed) return;
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      context.clearRect(0, 0, width, height);
      drawSkillGraph(context, graphData, runtime, width, height, reducedMotion ? 0 : time);
      frameTimer = window.setTimeout(() => {
        frame = window.requestAnimationFrame(draw);
      }, reducedMotion ? 250 : 80);
    };

    const observer = new ResizeObserver(resizeCanvas);
    observer.observe(host);
    resizeCanvas();
    frame = window.requestAnimationFrame(draw);

    return () => {
      disposed = true;
      observer.disconnect();
      window.clearTimeout(frameTimer);
      window.cancelAnimationFrame(frame);
      if (graphRef.current === runtime) graphRef.current = null;
    };
  }, [graphData]);

  const updateGraphHover = (event: PointerEvent<HTMLCanvasElement>) => {
    const runtime = graphRef.current;
    const canvas = canvasRef.current;
    if (!runtime || !canvas) return;
    const rect = canvas.getBoundingClientRect();
    runtime.pointerX = event.clientX - rect.left;
    runtime.pointerY = event.clientY - rect.top;
    if (runtime.dragging) {
      runtime.panX += event.movementX;
      runtime.panY += event.movementY;
      if (Math.abs(runtime.pointerX - runtime.dragStartX) + Math.abs(runtime.pointerY - runtime.dragStartY) > 4) {
        runtime.dragged = true;
      }
      canvas.style.cursor = "grabbing";
      return;
    }
    const hovered = findGraphHit(runtime, runtime.pointerX, runtime.pointerY);
    runtime.hoverId = hovered?.id ?? "";
    canvas.style.cursor = hovered?.skill ? "copy" : hovered?.kind === "source" ? "pointer" : "grab";
  };

  const startGraphDrag = (event: PointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0) return;
    const runtime = graphRef.current;
    const canvas = canvasRef.current;
    if (!runtime || !canvas) return;
    const rect = canvas.getBoundingClientRect();
    runtime.pointerX = event.clientX - rect.left;
    runtime.pointerY = event.clientY - rect.top;
    runtime.dragStartX = runtime.pointerX;
    runtime.dragStartY = runtime.pointerY;
    runtime.dragged = false;
    runtime.dragging = true;
    canvas.style.cursor = "grabbing";
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const endGraphDrag = (event: PointerEvent<HTMLCanvasElement>) => {
    const runtime = graphRef.current;
    const canvas = canvasRef.current;
    if (!runtime || !canvas) return;
    const hovered = findGraphHit(runtime, runtime.pointerX, runtime.pointerY);
    const wasDragged = runtime.dragged;
    runtime.dragging = false;
    runtime.dragged = false;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    canvas.style.cursor = hovered?.skill ? "copy" : hovered?.kind === "source" ? "pointer" : "grab";
    if (wasDragged || !hovered) return;
    if (hovered.skill) onCopySkill(hovered.skill);
    else if (hovered.kind === "source") onOpenLibrary();
  };

  return (
    <section className="skill-showcase glow-card">
      <header className="panel-head">
        <div>
          <span className="eyebrow"><Icon name="sparkle" /> {t("showcase.eyebrow")}</span>
          <h3>{t("showcase.title")}</h3>
          <p>{t("showcase.subtitle", { n: skills.length })}</p>
        </div>
        <button className="ghost-action" onClick={onOpenLibrary} type="button">
          <Icon name="library" /> <CountUp value={skills.length} />
        </button>
      </header>
      {loading && skills.length === 0 ? (
        <p className="skill-showcase-empty">{t("showcase.empty")}</p>
      ) : (
        <div className="skill-graph">
          <canvas
            aria-label={t("showcase.subtitle", { n: skills.length })}
            className="skill-graph-canvas"
            onPointerCancel={endGraphDrag}
            onPointerDown={startGraphDrag}
            onPointerLeave={updateGraphHover}
            onPointerMove={updateGraphHover}
            onPointerUp={endGraphDrag}
            ref={canvasRef}
            role="img"
          />
          <div className="skill-graph-meta" aria-hidden="true">
            <strong><CountUp value={skills.length} /></strong>
            <span>{t("showcase.nodes")}</span>
          </div>
          <div className="skill-graph-legend" aria-label={t("showcase.legend")}>
            {categoryLegend.map(item => (
              <span key={item.category} style={{ "--node-hue": `${item.hue}` } as CSSProperties}>
                <i />
                {item.label}
              </span>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

/* =============================================================
   Usage insights panel
   ============================================================= */

type UsageRange = "all" | "7d" | "30d";
type UsageViewMode = "heatmap" | "bars" | "trends";
type UsageHeatMetricKey = "usage" | "sevenDay" | "thirtyDay" | "stars" | "forks" | "skills";

function usageHeatMetrics(): Array<{ key: UsageHeatMetricKey; label: string }> {
  return [
    { key: "usage", label: t("usage.mUsage") },
    { key: "sevenDay", label: t("usage.m7") },
    { key: "thirtyDay", label: t("usage.m30") },
    { key: "stars", label: t("usage.mStars") },
    { key: "forks", label: t("usage.mForks") },
    { key: "skills", label: t("usage.mSkills") }
  ];
}

function UsageInsightPanel({
  loading,
  onRefreshPopularity,
  snapshot
}: {
  loading: boolean;
  onRefreshPopularity: () => void;
  snapshot: LegacySnapshot | null;
}) {
  const [range, setRange] = useState<UsageRange>("all");
  const [viewMode, setViewMode] = useState<UsageViewMode>("heatmap");
  const skills = snapshot?.skills ?? [];
  const sources = snapshot?.sources ?? [];
  const usageStats = snapshot?.usageStats ?? [];
  const sourcePopularity = snapshot?.sourcePopularity ?? [];
  const displaySources = useMemo(() => sources.filter(source => !isInternalRouterSource(source)), [sources]);
  const sourceScore = (source: { localTotalCount: number; localSevenDayCount: number; localThirtyDayCount: number }) => {
    if (range === "7d") return source.localSevenDayCount;
    if (range === "30d") return source.localThirtyDayCount;
    return source.localTotalCount;
  };
  const statScore = (stat: { totalCount: number; sevenDayCount: number; thirtyDayCount: number }) => {
    if (range === "7d") return stat.sevenDayCount;
    if (range === "30d") return stat.thirtyDayCount;
    return stat.totalCount;
  };
  const metrics = usageHeatMetrics();

  const heatRows = useMemo(() => {
    const rows: Array<{
      id: string;
      label: string;
      type: string;
      metrics: Record<UsageHeatMetricKey, number>;
    }> = [];
    const seen = new Set<string>();
    sourcePopularity.forEach(source => {
      const matched = displaySources.find(
        item => item.id === source.sourceId || item.name === source.sourceName
      );
      const id = source.sourceId || matched?.id || `${source.owner}/${source.repo}`;
      seen.add(id);
      if (matched) seen.add(matched.id);
      rows.push({
        id,
        label: sourcePopularityDisplayName(source),
        type: matched?.sourceType || "GitHub",
        metrics: {
          forks: source.forks,
          sevenDay: source.localSevenDayCount,
          skills: matched?.skillCount ?? 0,
          stars: source.stars,
          thirtyDay: source.localThirtyDayCount,
          usage: sourceScore(source)
        }
      });
    });
    displaySources.forEach(source => {
      if (seen.has(source.id) || rows.some(row => row.label === source.name)) return;
      const usage = usageStats.find(stat => stat.targetType === "source" && stat.targetId === source.id);
      rows.push({
        id: source.id,
        label: source.name,
        type: source.sourceType,
        metrics: {
          forks: 0,
          sevenDay: usage?.sevenDayCount ?? 0,
          skills: source.skillCount,
          stars: 0,
          thirtyDay: usage?.thirtyDayCount ?? 0,
          usage: usage ? statScore(usage) : 0
        }
      });
    });
    return rows.sort((a, b) => b.metrics.usage - a.metrics.usage || b.metrics.stars - a.metrics.stars);
  }, [displaySources, range, sourcePopularity, usageStats]);

  const heatMax = useMemo(
    () =>
      metrics.reduce<Record<UsageHeatMetricKey, number>>(
        (acc, metric) => {
          acc[metric.key] = Math.max(...heatRows.map(row => row.metrics[metric.key]), 1);
          return acc;
        },
        { forks: 1, sevenDay: 1, skills: 1, stars: 1, thirtyDay: 1, usage: 1 }
      ),
    [heatRows]
  );

  const rankedSkills = useMemo(() => {
    const statsBySkill = new Map(
      usageStats
        .filter(stat => stat.targetType === "skill")
        .map(stat => [stat.targetId, stat])
    );
    return skills
      .map(skill => {
        const stat = statsBySkill.get(skill.folderName) ?? statsBySkill.get(skill.name);
        return {
          id: skill.folderName,
          name: skill.name,
          category: skill.category,
          score: stat ? statScore(stat) : 0
        };
      })
      .filter(row => row.score > 0)
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  }, [range, skills, usageStats]);

  const rankedSources = sourcePopularity
    .map(source => ({ name: sourcePopularityDisplayName(source), stars: source.stars, score: sourceScore(source) }))
    .filter(row => row.stars > 0 || row.score > 0)
    .sort((a, b) => b.stars - a.stars || b.score - a.score);
  const maxSkillScore = Math.max(...rankedSkills.map(row => row.score), 1);
  const maxSourceHeat = Math.max(...rankedSources.map(row => Math.max(row.stars, row.score)), 1);
  const skillBarWidth = (score: number) => (score <= 0 ? "0%" : `${Math.max(6, Math.min(100, (score / maxSkillScore) * 100))}%`);
  const sourceBarWidth = (row: { score: number; stars: number }) => {
    const value = Math.max(row.stars, row.score);
    return value <= 0 ? "0%" : `${Math.max(6, Math.min(100, (value / maxSourceHeat) * 100))}%`;
  };

  return (
    <section className="usage-insight glow-card" aria-label="Usage insight panel">
      <header className="panel-head">
        <div>
          <span className="eyebrow">{t("usage.eyebrow")}</span>
          <h3>{t("usage.title")}</h3>
        </div>
        <div className="usage-toolbar">
          <SegmentedToggle
            value={range}
            options={[
              { value: "all", label: t("usage.rangeAll") },
              { value: "7d", label: t("usage.range7") },
              { value: "30d", label: t("usage.range30") }
            ]}
            onChange={value => setRange(value as UsageRange)}
          />
          <SegmentedToggle
            value={viewMode}
            options={[
              { value: "heatmap", label: t("usage.modeHeatmap") },
              { value: "bars", label: t("usage.modeBars") },
              { value: "trends", label: t("usage.modeTrends") }
            ]}
            onChange={value => setViewMode(value as UsageViewMode)}
          />
          <button className="ghost-action" disabled={loading} onClick={onRefreshPopularity} type="button">
            <Icon className={loading ? "icon-spin" : ""} name="refresh" /> {loading ? t("usage.refreshing") : t("usage.refresh")}
          </button>
        </div>
      </header>

      <div className="usage-body">
        {viewMode === "heatmap" && (
          <div className="usage-heatmap">
            <div className="heatmap-grid" style={{ "--heat-columns": metrics.length } as CSSProperties}>
              <span className="heatmap-corner">{t("usage.corner")}</span>
              {metrics.map(metric => (
                <span className="heatmap-column" key={metric.key}>{metric.label}</span>
              ))}
              {heatRows.map(row => (
                <Fragment key={row.id}>
                  <span className="heatmap-row-label" title={row.label}>
                    <strong>{row.label}</strong>
                    <em>{row.type}</em>
                  </span>
                  {metrics.map(metric => {
                    const value = row.metrics[metric.key];
                    const level = heatLevel(value, heatMax[metric.key]);
                    return (
                      <span
                        className={`heat-tile heat-level-${level}`}
                        key={`${row.id}-${metric.key}`}
                        title={`${row.label} · ${metric.label}: ${value}`}
                      >
                        {metric.key === "stars" || metric.key === "forks" ? formatCompactNumber(value) : value}
                      </span>
                    );
                  })}
                </Fragment>
              ))}
            </div>
            <div className="heatmap-legend">
              <span>{t("usage.low")}</span>
              {[0, 1, 2, 3, 4, 5, 6].map(level => (
                <i className={`heat-level-${level}`} key={level} />
              ))}
              <span>{t("usage.high")}</span>
            </div>
          </div>
        )}
        {viewMode === "bars" && (
          <div className="usage-bars">
            {rankedSkills.length === 0 && rankedSources.length === 0 && <p>{t("usage.noEvents")}</p>}
            {rankedSkills.map(row => (
              <div className="usage-bar-row" key={`skill-${row.id}`} title={row.name}>
                <span>{row.name}</span>
                <i><b style={{ width: skillBarWidth(row.score) }} /></i>
                <em>{row.score}</em>
              </div>
            ))}
            {rankedSources.map(row => (
              <div className="usage-bar-row source" key={`source-${row.name}`} title={row.name}>
                <span>{row.name}</span>
                <i><b style={{ width: sourceBarWidth(row) }} /></i>
                <em>{row.stars > 0 ? `★ ${formatCompactNumber(row.stars)}` : row.score}</em>
              </div>
            ))}
          </div>
        )}
        {viewMode === "trends" && (
          <div className="usage-trends">
            {sourcePopularity.length === 0 && <p>{t("usage.noTrends")}</p>}
            {sourcePopularity.map(source => {
              const points = source.trendPoints ?? [];
              const first = points[0]?.stars ?? 0;
              const last = points[points.length - 1]?.stars ?? source.stars;
              const delta = points.length >= 2 ? last - first : 0;
              return (
                <article className="trend-row" key={source.sourceId} title={sourcePopularityDisplayName(source)}>
                  <div>
                    <strong>{sourcePopularityDisplayName(source)}</strong>
                    <span>
                      {t("usage.trendMeta", {
                        stars: formatCompactNumber(source.stars),
                        forks: formatCompactNumber(source.forks),
                        usage: sourceScore(source),
                        samples: points.length
                      })}
                    </span>
                  </div>
                  <MiniTrendLine points={points.map(point => point.stars)} />
                  <em className={delta >= 0 ? "trend-up" : "trend-down"}>
                    {points.length >= 2
                      ? `${delta >= 0 ? "+" : "-"}${formatCompactNumber(Math.abs(delta))}`
                      : t("usage.trendPending")}
                  </em>
                </article>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}

function MiniTrendLine({ points }: { points: number[] }) {
  const safePoints = points.length > 1 ? points : [0, points[0] ?? 0];
  const max = Math.max(...safePoints, 1);
  const min = Math.min(...safePoints, 0);
  const span = Math.max(max - min, 1);
  const width = 112;
  const height = 34;
  const path = safePoints
    .map((point, index) => {
      const x = safePoints.length === 1 ? width : (index / (safePoints.length - 1)) * width;
      const y = height - ((point - min) / span) * (height - 6) - 3;
      return `${index === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg className="mini-trend-line" viewBox={`0 0 ${width} ${height}`} role="img">
      <path d={path} />
    </svg>
  );
}

/* =============================================================
   Library — merged sources + skills tree
   ============================================================= */

type LibraryProps = {
  atlasMode: boolean;
  loading: boolean;
  onCancelImport: (operationId: string) => Promise<boolean>;
  onDeleteSource: (source: SourceCard) => Promise<"failed" | "preview" | "deleted">;
  onPreviewImport: (importKind: string, input: string, options?: ImportFeedbackOptions) => Promise<SourceImportPlanCard>;
  onPromoteImport: (
    importKind: string,
    stagedPath: string,
    sourceName: string,
    options?: ImportFeedbackOptions
  ) => Promise<SourceImportPromotionCard>;
  onRecordUsage: (
    targetType: string,
    targetId: string,
    targetName: string,
    sourceName: string,
    eventType: string
  ) => Promise<void>;
  onReanalyzeMetadata: () => Promise<LegacySnapshot | null>;
  onRefreshIndex: () => Promise<LegacySnapshot | null>;
  onSaveSkillMetadata: (skill: SkillCard, draft: SkillDraft) => Promise<"failed" | "preview" | "saved">;
  onSaveSourceMetadata: (source: SourceCard, draft: SourceDraft) => Promise<"failed" | "preview" | "saved">;
  onSetSkillConflictChoice: (
    conflictKey: string,
    defaultSkillId: string,
    status: "default-set" | "ignored" | "unresolved"
  ) => Promise<void>;
  onSetSkillEnabled: (skill: SkillCard, enabled: boolean) => Promise<boolean>;
  onSetSkillRating: (skill: SkillCard, rating: number) => Promise<boolean>;
  onSetSourceRating: (source: SourceCard, rating: number) => Promise<boolean>;
  onSetSourceVersionPin: (source: SourceCard, pinned: boolean) => Promise<boolean>;
  onRefreshSourceVersion: (source: SourceCard) => Promise<boolean>;
  onRollbackSourceVersion: (source: SourceCard) => Promise<boolean>;
  onStageImport: (importKind: string, input: string, options?: ImportFeedbackOptions) => Promise<SourceImportExecutionCard>;
  realWritesEnabled: boolean;
  searchQuery: string;
  snapshot: LegacySnapshot | null;
};

function Library(props: LibraryProps) {
  const {
    atlasMode,
    loading,
    onCancelImport,
    onDeleteSource,
    onPreviewImport,
    onPromoteImport,
    onRecordUsage,
    onReanalyzeMetadata,
    onRefreshIndex,
    onSaveSkillMetadata,
    onSaveSourceMetadata,
    onSetSkillConflictChoice,
    onSetSkillEnabled,
    onSetSkillRating,
    onSetSourceRating,
    onSetSourceVersionPin,
    onRefreshSourceVersion,
    onRollbackSourceVersion,
    onStageImport,
    realWritesEnabled,
    searchQuery,
    snapshot
  } = props;
  const sources = snapshot?.sources ?? [];
  const skills = snapshot?.skills ?? [];
  const skillConflicts = snapshot?.skillConflicts ?? [];
  const [sortKey, setSortKey] = useState<SourceSortKey>("recent");
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [editingSourceId, setEditingSourceId] = useState("");
  const [editingSkillId, setEditingSkillId] = useState("");
  const [showImport, setShowImport] = useState(false);
  const [showMaintenance, setShowMaintenance] = useState(false);
  const [sourceDrafts, setSourceDrafts] = useState<Record<string, SourceDraft>>({});
  const [skillDrafts, setSkillDrafts] = useState<Record<string, SkillDraft>>({});

  useEffect(() => {
    if (!searchQuery.trim()) return;
    const matchingSourceIds = sources
      .filter(source =>
        sourceMatchesSearch(source, searchQuery) ||
        skills.some(skill => skillBelongsToSource(skill, source) && skillMatchesSearch(skill, searchQuery))
      )
      .map(source => source.id);
    if (!matchingSourceIds.length) return;
    setExpanded(previous => {
      const next = new Set(previous);
      matchingSourceIds.forEach(sourceId => next.add(sourceId));
      return next;
    });
  }, [searchQuery, skills, sources]);

  const popularityById = useMemo(
    () => new Map((snapshot?.sourcePopularity ?? []).map(item => [item.sourceId, item])),
    [snapshot?.sourcePopularity]
  );
  const governanceById = useMemo(
    () => new Map((snapshot?.sourceGovernance ?? []).map(item => [item.sourceId, item])),
    [snapshot?.sourceGovernance]
  );
  const qualityById = useMemo(
    () => new Map((snapshot?.sourceQualitySignals ?? []).map(item => [item.sourceId, item])),
    [snapshot?.sourceQualitySignals]
  );
  const agentStatusesBySkill = useMemo(() => {
    const groups = new Map<string, AgentSkillStatusCard[]>();
    for (const status of snapshot?.agentSkillStatuses ?? []) {
      groups.set(status.skillFolderName, [...(groups.get(status.skillFolderName) ?? []), status]);
    }
    return groups;
  }, [snapshot?.agentSkillStatuses]);

  const visibleSources = useMemo(() => {
    const drafted = sources.map(source => applySourceDraft(source, sourceDrafts[source.id]));
    const filtered = searchQuery.trim()
      ? drafted.filter(
          source =>
            sourceMatchesSearch(source, searchQuery) ||
            skills.some(
              skill => skillBelongsToSource(skill, source) && skillMatchesSearch(skill, searchQuery)
            )
        )
      : drafted;
    return sortSources(filtered, sortKey, popularityById, skills);
  }, [popularityById, skills, sources, sourceDrafts, sortKey, searchQuery]);

  const localSkills = useMemo(() => {
    const filtered = skills
      .map(skill => applySkillDraft(skill, skillDrafts[skill.folderName]))
      .filter(skill => {
        if (sources.some(source => skillBelongsToSource(skill, source))) {
          return false;
        }
        return searchQuery.trim() ? skillMatchesSearch(skill, searchQuery) : true;
      });
    return sortSkills(filtered, sortKey);
  }, [skillDrafts, skills, sources, searchQuery, sortKey]);

  const totalMatches =
    visibleSources.length +
    skills.filter(skill => skillMatchesSearch(skill, searchQuery)).length;

  function toggleExpand(sourceId: string) {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(sourceId)) next.delete(sourceId);
      else next.add(sourceId);
      return next;
    });
  }
  function expandSource(sourceId: string) {
    setExpanded(prev => {
      const next = new Set(prev);
      next.add(sourceId);
      return next;
    });
  }

  const editingSource = sources.find(source => source.id === editingSourceId) ?? null;
  const editingSkill = skills.find(skill => skill.folderName === editingSkillId) ?? null;

  async function saveSourceDraft(source: SourceCard, draft: SourceDraft) {
    const result = await onSaveSourceMetadata(source, draft);
    if (result === "preview") setSourceDrafts(prev => ({ ...prev, [source.id]: draft }));
    if (result !== "failed") setEditingSourceId("");
  }
  async function saveSkillDraft(skill: SkillCard, draft: SkillDraft) {
    const result = await onSaveSkillMetadata(skill, draft);
    if (result === "preview") setSkillDrafts(prev => ({ ...prev, [skill.folderName]: draft }));
    if (result !== "failed") setEditingSkillId("");
  }

  async function deleteSourceFromPanel(source: SourceCard) {
    const confirmed = window.confirm(t("srcEditor.confirmDelete", { name: source.name }));
    if (!confirmed) return;
    const result = await onDeleteSource(source);
    if (result !== "failed") setEditingSourceId("");
  }

  const githubSources = sources.filter(source => source.url).length;
  const localSources = sources.filter(source => !source.url && source.localPath).length;
  const enabledSkillCount = skills.filter(skill => skill.enabled).length;
  const topRatedSkill = [...skills]
    .filter(skill => (skill.rating ?? 0) > 0 && !isRouterHubSkill(skill))
    .sort((left, right) => (right.rating ?? 0) - (left.rating ?? 0) || left.name.localeCompare(right.name))[0];

  return (
    <div className="view library-view">
      <section className="page-header glow-card">
        <div>
          <span className="eyebrow"><Icon name="library" /> {t("nav.library")}</span>
          <h2>{t("lib.title")}</h2>
          <p>{t("lib.subtitle")}</p>
        </div>
        <div className="page-header-stats">
          <span>{t("lib.statSources", { n: sources.length })}</span>
          <span>{t("lib.statSkills", { n: skills.length })}</span>
          <span>{t("lib.statGithub", { n: githubSources })}</span>
          <span>{t("lib.statLocal", { n: localSources })}</span>
        </div>
      </section>

      <section className="library-toolbar">
        <div className="library-toolbar-left">
          <label className="library-sort">
            <span>{t("lib.sort")}</span>
            <select value={sortKey} onChange={event => setSortKey(event.target.value as SourceSortKey)}>
              <option value="recent">{t("lib.sortRecent")}</option>
              <option value="rating">{t("lib.sortRating")}</option>
              <option value="usage">{t("lib.sortUsage")}</option>
              <option value="heat">{t("lib.sortHeat")}</option>
              <option value="skillCount">{t("lib.sortSkillCount")}</option>
              <option value="health">{t("lib.sortHealth")}</option>
              <option value="name">{t("lib.sortName")}</option>
            </select>
          </label>
          <button
            className="ghost-action"
            onClick={() => setExpanded(new Set(sources.map(source => source.id)))}
            type="button"
          >
            {t("lib.expandAll")}
          </button>
          <button className="ghost-action" onClick={() => setExpanded(new Set())} type="button">
            {t("lib.collapseAll")}
          </button>
        </div>
        <div className="library-toolbar-right">
          <button
            className="ghost-action metadata-reanalyze-action"
            disabled={loading}
            onClick={() => void onReanalyzeMetadata()}
            title={t("metadata.reanalyzeTip")}
            type="button"
          >
            <Icon className={loading ? "icon-spin" : ""} name="sparkle" />
            {t("metadata.reanalyze")}
          </button>
          <button
            className={showMaintenance ? "ghost-action active" : "ghost-action"}
            onClick={() => setShowMaintenance(value => !value)}
            type="button"
          >
            <Icon name="settings" /> {t("lib.maintenance")}
          </button>
          <button
            className="primary-action"
            onClick={() => setShowImport(value => !value)}
            type="button"
          >
            <Icon name="add" /> {t("qa.title")}
          </button>
        </div>
      </section>

      {searchQuery.trim() && (
        <section className="search-scope-note">
          <Icon name="search" />
          <span>{t("lib.searchActive", { n: totalMatches })}</span>
        </section>
      )}

      {showImport && (
        <ImportWizard
          disabled={loading}
          onCancel={onCancelImport}
          onPreview={onPreviewImport}
          onPromote={onPromoteImport}
          onRefreshIndex={onRefreshIndex}
          onSaveSourceMetadata={onSaveSourceMetadata}
          onStage={onStageImport}
          sources={sources}
        />
      )}

      {showMaintenance && (
        <div className="library-maintenance">
          {atlasMode && skillConflicts.length > 0 && (
            <SkillConflictPanel
              conflicts={skillConflicts}
              disabled={loading}
              onResolve={onSetSkillConflictChoice}
            />
          )}
          <RouterHubPanel disabled={loading} realWritesEnabled={realWritesEnabled} />
          {!atlasMode && skillConflicts.length > 0 && (
            <SkillConflictPanel
              conflicts={skillConflicts}
              disabled={loading}
              onResolve={onSetSkillConflictChoice}
            />
          )}
        </div>
      )}

      <div className={atlasMode ? "library-stage atlas-library-stage" : "library-stage"}>
        {atlasMode && (
          <aside className="atlas-library-filter-deck" aria-label={t("atlas.filterDeck")}>
            <header>
              <span>INDEX / FILTER</span>
              <b>{visibleSources.length.toString().padStart(2, "0")}</b>
            </header>
            <div className="atlas-filter-meter">
              <span>{t("atlas.enabledSkills")}</span>
              <strong>{enabledSkillCount}</strong>
              <i style={{ "--meter": `${skills.length ? Math.round((enabledSkillCount / skills.length) * 100) : 0}%` } as CSSProperties} />
            </div>
            <dl>
              <div><dt>{t("atlas.skillSources")}</dt><dd>{sources.filter(source => source.sourceType === "skill").length}</dd></div>
              <div><dt>{t("atlas.promptSources")}</dt><dd>{sources.filter(source => source.sourceType === "prompt").length}</dd></div>
              <div><dt>{t("atlas.otherSources")}</dt><dd>{sources.filter(source => source.sourceType !== "skill" && source.sourceType !== "prompt").length}</dd></div>
              <div><dt>{t("atlas.routeGroups")}</dt><dd>{skillConflicts.length}</dd></div>
            </dl>
            <p>{t("atlas.filterDeckV0")}</p>
          </aside>
        )}

        <section className="library-tree">
        {visibleSources.map(source => {
          const isExpanded = expanded.has(source.id) || Boolean(searchQuery.trim());
          const sourceSkills = sortSkills(
            skills
              .map(skill => applySkillDraft(skill, skillDrafts[skill.folderName]))
              .filter(skill => skillBelongsToSource(skill, source)),
            sortKey
          );
          const totalSkillCount = Math.max(source.skillCount ?? 0, sourceSkills.length);
          const singleRootSkill = sourceSkills.length === 1;
          const parentSkills = singleRootSkill ? [] : sourceSkills.filter(isRouterHubSkill);
          const childSkills = singleRootSkill ? sourceSkills : sourceSkills.filter(skill => !isRouterHubSkill(skill));
          const parentSkill = sourceParentSkill(source, sourceSkills);
          const popularity = popularityById.get(source.id);
          const governance = governanceById.get(source.id);
          const quality = qualityById.get(source.id);
          const ratingSummary = skillRatingSummary(sourceSkills.filter(skill => skill !== parentSkill));
          const matchesQuery = searchQuery.trim()
            ? sourceSkills.some(skill => skillMatchesSearch(skill, searchQuery))
            : true;
          const skillCountText =
            source.sourceType === "prompt" && totalSkillCount === 0
              ? t("lib.promptSource")
              : t("lib.skillsTotal", { n: totalSkillCount });
          return (
            <article
              className={`source-group glow-card${isExpanded ? " expanded" : ""}${matchesQuery ? "" : " dimmed"}`}
              key={source.id}
            >
              <header className="source-group-head">
                <button
                  aria-expanded={isExpanded}
                  className="source-group-toggle"
                  onClick={() => toggleExpand(source.id)}
                  type="button"
                >
                  <span className={`source-group-chevron${isExpanded ? " open" : ""}`} aria-hidden="true">
                    <Icon name="chevron" />
                  </span>
                  <span className={`source-avatar tone-${source.url ? sourceTypeTone(source.sourceType, source.categoryId) : "local"}`} aria-hidden="true">
                    <Icon name={source.url ? sourceTypeIcon(source.sourceType) : "sources"} />
                  </span>
                  <div className="source-group-title">
                    <strong>{source.name}</strong>
                    <span>
                      {displayCategoryName(source.categoryId)} · {sourceTypeLabel(source.sourceType)} ·{" "}
                      {skillCountText}
                    </span>
                  </div>
                </button>
                <div className="source-group-meta">
                  <PopularityChip popularity={popularity} source={source} />
                  <SourceQualityChip quality={quality} />
                  <SourceVersionChip governance={governance} />
                  {source.sourceType !== "prompt" && totalSkillCount > 0 && (
                    <div className="source-parent-rating">
                      <span>{t("rating.parent")}</span>
                      <SkillRating
                        disabled={loading}
                        onChange={rating => void onSetSourceRating(source, rating)}
                        rating={source.rating ?? parentSkill?.rating ?? 0}
                        skillName={parentSkill?.name ?? source.name}
                      />
                    </div>
                  )}
                  {ratingSummary.count > 0 && <SourceRatingChip summary={ratingSummary} />}
                  <span className={`status-badge ${source.health}`}>
                    <span className={`status-dot ${statusDotClass(source.health)}`} />
                    {skillStatusLabel(source.health)}
                  </span>
                  <ToggleSwitch
                    disabled={loading}
                    enabled={source.enabled}
                    label={source.enabled ? t("common.enabled") : t("common.disabled")}
                    onClick={() =>
                      void onSaveSourceMetadata(source, {
                        category: source.categoryId,
                        enabled: !source.enabled,
                        name: source.name,
                        note: source.note,
                        sourceType: source.sourceType,
                        tags: tagInputValue(source.tags)
                      })
                    }
                  />
                  <button
                    className="icon-action"
                    onClick={() => setEditingSourceId(source.id)}
                    title={t("lib.editSource")}
                    type="button"
                  >
                    <Icon name="edit" />
                  </button>
                </div>
              </header>
              {source.note && <p className="source-note">{t("lib.note")}：{source.note}</p>}
              {source.usageGuide && !source.note.includes(source.usageGuide) && (
                <p className="source-usage-guide">
                  <strong>{t("metadata.usage")}：</strong>
                  {source.usageGuide}
                  {typeof source.metadataConfidence === "number" && source.metadataConfidence > 0 && (
                    <span
                      className="metadata-evidence"
                      title={t("metadata.evidenceTip", {
                        origin: source.metadataOrigin || "offline",
                        value: Math.round(source.metadataConfidence * 100)
                      })}
                    >
                      {t("metadata.auto")} {Math.round(source.metadataConfidence * 100)}%
                    </span>
                  )}
                </p>
              )}
              {isExpanded && (
                <div className="source-children">
                  {parentSkills.length > 0 && (
                    <div className="parent-skills">
                      {parentSkills.map(skill => (
                        <SkillRow
                          agentStatuses={agentStatusesBySkill.get(skill.folderName) ?? []}
                          isParent
                          key={skill.folderName}
                          loading={loading}
                          onCopy={() => void copySkillPrompt(skill, onRecordUsage)}
                          onEdit={() => setEditingSkillId(skill.folderName)}
                          onRate={rating => void onSetSkillRating(skill, rating)}
                          onToggleEnabled={() => void onSetSkillEnabled(skill, !skill.enabled)}
                          skill={skill}
                        />
                      ))}
                    </div>
                  )}
                  {childSkills.length === 0 && parentSkills.length === 0 ? (
                    <p className="source-children-empty">
                      {source.sourceType === "prompt" ? t("lib.promptOnly") : t("lib.noChildren")}
                    </p>
                  ) : (
                    <div className="child-skills">
                      {childSkills.map(skill => (
                        <SkillRow
                          agentStatuses={agentStatusesBySkill.get(skill.folderName) ?? []}
                          isParent={false}
                          key={skill.folderName}
                          loading={loading}
                          onCopy={() => void copySkillPrompt(skill, onRecordUsage)}
                          onEdit={() => setEditingSkillId(skill.folderName)}
                          onRate={rating => void onSetSkillRating(skill, rating)}
                          onToggleEnabled={() => void onSetSkillEnabled(skill, !skill.enabled)}
                          skill={skill}
                        />
                      ))}
                    </div>
                  )}
                </div>
              )}
            </article>
          );
        })}

        {localSkills.length > 0 && (
          <article className="source-group glow-card local-group expanded">
            <header className="source-group-head">
              <div className="source-group-toggle static">
                <span className="source-avatar tone-local" aria-hidden="true">
                  <Icon name="workspaces" />
                </span>
                <div className="source-group-title">
                  <strong>{t("lib.localGroup")}</strong>
                  <span>{t("lib.localGroupHint")} · {t("lib.skillsTotal", { n: localSkills.length })}</span>
                </div>
              </div>
            </header>
            <div className="source-children">
              <div className="child-skills">
                {localSkills.map(skill => (
                  <SkillRow
                    agentStatuses={agentStatusesBySkill.get(skill.folderName) ?? []}
                    isParent={isRouterHubSkill(skill)}
                    key={skill.folderName}
                    loading={loading}
                    onCopy={() => void copySkillPrompt(skill, onRecordUsage)}
                    onEdit={() => setEditingSkillId(skill.folderName)}
                    onRate={rating => void onSetSkillRating(skill, rating)}
                    onToggleEnabled={() => void onSetSkillEnabled(skill, !skill.enabled)}
                    skill={skill}
                  />
                ))}
              </div>
            </div>
          </article>
        )}

        {visibleSources.length === 0 && localSkills.length === 0 && (
          <p className="library-empty">{searchQuery.trim() ? t("lib.emptySearch") : t("lib.empty")}</p>
        )}
        </section>

        {atlasMode && (
          <aside className="atlas-library-inspector" aria-label={t("atlas.inspector")}>
            <header>
              <span>INSPECTOR / V0</span>
              <i aria-hidden="true" />
            </header>
            {topRatedSkill ? (
              <>
                <div className="atlas-inspector-glyph" aria-hidden="true"><Icon name="sparkle" /></div>
                <span>{t("atlas.topRated")}</span>
                <h3>/{topRatedSkill.name}</h3>
                <p>{cleanSkillDescription(topRatedSkill.description) || displayCategoryName(topRatedSkill.category)}</p>
                <dl>
                  <div><dt>{t("atlas.rating")}</dt><dd>{topRatedSkill.rating.toFixed(1)} / 5</dd></div>
                  <div><dt>{t("atlas.source")}</dt><dd>{topRatedSkill.source || t("lib.localGroup")}</dd></div>
                  <div><dt>{t("atlas.state")}</dt><dd>{topRatedSkill.enabled ? t("common.enabled") : t("common.disabled")}</dd></div>
                </dl>
                <button onClick={() => void copySkillPrompt(topRatedSkill, onRecordUsage)} type="button">
                  <Icon name="copy" /> {t("search.copy")}
                </button>
              </>
            ) : (
              <p className="atlas-inspector-empty">{t("atlas.inspectorEmpty")}</p>
            )}
          </aside>
        )}
      </div>

      {editingSkill && (
        <SkillEditPanel
          draft={skillDrafts[editingSkill.folderName]}
          onClose={() => setEditingSkillId("")}
          onSave={draft => void saveSkillDraft(editingSkill, draft)}
          skill={editingSkill}
        />
      )}
      {editingSource && (
        <SourceEditPanel
          draft={sourceDrafts[editingSource.id]}
          onClose={() => setEditingSourceId("")}
          onDelete={() => void deleteSourceFromPanel(editingSource)}
          onOpenChildren={() => expandSource(editingSource.id)}
          onRefreshVersion={() => void onRefreshSourceVersion(editingSource)}
          onRollbackVersion={() => {
            const governance = governanceById.get(editingSource.id);
            const revision = shortRevision(governance?.latestBackupRevision);
            if (
              window.confirm(
                t("governance.confirmRollback", {
                  name: editingSource.name,
                  revision: revision || t("governance.unknownRevision")
                })
              )
            ) {
              void onRollbackSourceVersion(editingSource);
            }
          }}
          onSave={draft => void saveSourceDraft(editingSource, draft)}
          onSetPinned={pinned => void onSetSourceVersionPin(editingSource, pinned)}
          governance={governanceById.get(editingSource.id)}
          popularity={popularityById.get(editingSource.id)}
          quality={qualityById.get(editingSource.id)}
          source={editingSource}
          sourceSkills={skills.filter(skill => skillBelongsToSource(skill, editingSource))}
        />
      )}
    </div>
  );
}

function SkillRow({
  agentStatuses,
  isParent,
  loading,
  onCopy,
  onEdit,
  onRate,
  onToggleEnabled,
  skill
}: {
  agentStatuses: AgentSkillStatusCard[];
  isParent: boolean;
  loading: boolean;
  onCopy: () => void;
  onEdit: () => void;
  onRate: (rating: number) => void;
  onToggleEnabled: () => void;
  skill: SkillCard;
}) {
  return (
    <article className={`skill-row glow-card ${skill.health}${isParent ? " is-parent" : ""}`}>
      <div className={`skill-row-icon tone-${skillTone(skill.category)}`}>
        <Icon name={skillIcon(skill.category)} />
      </div>
      <div className="skill-row-main">
        <header>
          <strong>/{skill.name}</strong>
          <span
            className={`kind-chip ${isParent ? "router" : "child"}`}
            title={isParent ? t("lib.parentTip") : t("lib.childTip")}
          >
            {isParent ? t("lib.parentSkill") : t("lib.childSkill")}
          </span>
          <span className={`status-badge ${skill.health}`}>
            <span className={`status-dot ${statusDotClass(skill.health)}`} />
            {skillStatusLabel(skill.health)}
          </span>
        </header>
        <p>{cleanSkillDescription(skill.description)}</p>
        <div className="skill-row-tags">
          <span>{displayCategoryName(skill.category) || t("conf.uncategorized")}</span>
          {(skill.tags ?? []).slice(0, 4).map(tag => (
            <span className="tag-chip" key={tag}>{tag}</span>
          ))}
          {agentStatuses.slice(0, 3).map(status => (
            <span
              className={`agent-skill-pill ${agentSkillStatusTone(status.status)}`}
              key={status.id}
              title={status.summary}
            >
              {compactAgentName(status.agentName)}
              <b>{agentSkillStatusLabel(status.status)}</b>
            </span>
          ))}
        </div>
        {skill.note && <small className="skill-row-note">{t("lib.note")}：{skill.note}</small>}
        {skill.usageGuide && !skill.note.includes(skill.usageGuide) && (
          <small className="skill-row-usage">
            <strong>{t("metadata.usage")}：</strong>{skill.usageGuide}
          </small>
        )}
      </div>
      <div className="skill-row-actions">
        <SkillRating disabled={loading} onChange={onRate} rating={skill.rating ?? 0} skillName={skill.name} />
        <ToggleSwitch
          disabled={loading}
          enabled={skill.enabled}
          label={skill.enabled ? t("common.enabled") : t("common.disabled")}
          onClick={onToggleEnabled}
        />
        <button className="icon-action" onClick={onCopy} title={t("lib.copy")} type="button">
          <Icon name="copy" />
        </button>
        <button className="icon-action" onClick={onEdit} title={t("lib.edit")} type="button">
          <Icon name="edit" />
        </button>
      </div>
    </article>
  );
}

function SkillRating({
  disabled,
  onChange,
  rating,
  skillName
}: {
  disabled: boolean;
  onChange: (rating: number) => void;
  rating: number;
  skillName: string;
}) {
  const normalizedRating = Math.max(0, Math.min(5, Math.round(rating)));
  return (
    <div
      aria-label={t("rating.group", { name: skillName })}
      className="skill-rating"
      role="group"
      title={normalizedRating > 0 ? t("rating.current", { n: normalizedRating }) : t("rating.unrated")}
    >
      {[1, 2, 3, 4, 5].map(value => (
        <button
          aria-label={t("rating.set", { n: value, name: skillName })}
          aria-pressed={value <= normalizedRating}
          className={value <= normalizedRating ? "filled" : ""}
          disabled={disabled}
          key={value}
          onClick={() => onChange(value === normalizedRating ? 0 : value)}
          title={value === normalizedRating ? t("rating.clear") : t("rating.setShort", { n: value })}
          type="button"
        >
          <span aria-hidden="true">★</span>
        </button>
      ))}
    </div>
  );
}

function SourceRatingChip({ summary }: { summary: SkillRatingSummary }) {
  return (
    <span
      className="source-rating-summary"
      title={t("rating.sourceTip", { average: summary.average.toFixed(1), n: summary.count })}
    >
      ★ {summary.average.toFixed(1)}
      <small>{summary.count}</small>
    </span>
  );
}

function PopularityChip({
  popularity,
  source
}: {
  popularity?: SourcePopularityCard;
  source: SourceCard;
}) {
  const info = sourcePopularityInfo(source, popularity);
  return (
    <span className={`source-popularity ${info.tone}`} title={info.title}>
      {info.label}
    </span>
  );
}

function SourceQualityChip({ quality }: { quality?: SourceQualitySignalCard }) {
  if (!quality) return null;
  const score = quality.score;
  return (
    <span
      className={`source-quality-chip tone-${quality.status}`}
      title={t("quality.chipTip", {
        evidence: quality.evidenceCount,
        total: quality.evidenceTotal
      })}
    >
      <Icon name="shield" />
      {score == null ? t("quality.pending") : t("quality.scoreShort", { n: score })}
    </span>
  );
}

function SourceVersionChip({ governance }: { governance?: SourceGovernanceCard }) {
  if (!governance || governance.supportStatus !== "git") return null;
  const label = governance.pinned
    ? t("governance.pinnedShort")
    : governance.relation === "update-available"
      ? t("governance.behindShort", { n: governance.behindCount })
      : governance.relation === "up-to-date"
        ? t("governance.currentShort")
        : t("governance.versionShort");
  return (
    <span
      className={`source-version-chip relation-${governance.pinned ? "pinned" : governance.relation}`}
      title={governance.message || t("governance.versionTip")}
    >
      <Icon name={governance.pinned ? "shield" : "refresh"} />
      {label}
    </span>
  );
}

function SkillEditPanel({
  draft,
  onClose,
  onSave,
  skill
}: {
  draft?: SkillDraft;
  onClose: () => void;
  onSave: (draft: SkillDraft) => void;
  skill: SkillCard;
}) {
  const [name, setName] = useState(draft?.name ?? skill.name);
  const [category, setCategory] = useState(draft?.category ?? skill.category);
  const [description, setDescription] = useState(draft?.description ?? skill.description);
  const [note, setNote] = useState(draft?.note ?? skill.note ?? "");
  const [tags, setTags] = useState(draft?.tags ?? tagInputValue(skill.tags ?? []));

  useEffect(() => {
    setName(draft?.name ?? skill.name);
    setCategory(draft?.category ?? skill.category);
    setDescription(draft?.description ?? skill.description);
    setNote(draft?.note ?? skill.note ?? "");
    setTags(draft?.tags ?? tagInputValue(skill.tags ?? []));
  }, [draft, skill.folderName]);

  return (
    <Drawer onClose={onClose} eyebrow={t("skillEditor.eyebrow")} title={skill.name}>
      <label>
        {t("skillEditor.name")}
        <input onChange={event => setName(event.target.value)} value={name} />
      </label>
      <label>
        {t("skillEditor.category")}
        <input onChange={event => setCategory(event.target.value)} value={category} />
      </label>
      <label>
        {t("skillEditor.tags")}
        <input
          onChange={event => setTags(event.target.value)}
          placeholder={t("skillEditor.tagsPlaceholder")}
          value={tags}
        />
      </label>
      <label>
        {t("skillEditor.description")}
        <textarea onChange={event => setDescription(event.target.value)} rows={4} value={description} />
      </label>
      <label>
        {t("skillEditor.note")}
        <textarea
          onChange={event => setNote(event.target.value)}
          placeholder={t("skillEditor.notePlaceholder")}
          rows={3}
          value={note}
        />
      </label>
      <footer>
        <button className="secondary-action" onClick={onClose} type="button">{t("common.cancel")}</button>
        <button
          className="primary-action"
          onClick={() => onSave({ category, description, name, note, tags })}
          type="button"
        >
          {t("common.save")}
        </button>
      </footer>
    </Drawer>
  );
}

function SourceEditPanel({
  draft,
  governance,
  onClose,
  onDelete,
  onOpenChildren,
  onRefreshVersion,
  onRollbackVersion,
  onSave,
  onSetPinned,
  popularity,
  quality,
  source,
  sourceSkills
}: {
  draft?: SourceDraft;
  governance?: SourceGovernanceCard;
  onClose: () => void;
  onDelete: () => void;
  onOpenChildren: () => void;
  onRefreshVersion: () => void;
  onRollbackVersion: () => void;
  onSave: (draft: SourceDraft) => void;
  onSetPinned: (pinned: boolean) => void;
  popularity?: SourcePopularityCard;
  quality?: SourceQualitySignalCard;
  source: SourceCard;
  sourceSkills: SkillCard[];
}) {
  const [name, setName] = useState(draft?.name ?? source.name);
  const [category, setCategory] = useState(draft?.category ?? source.categoryId);
  const [sourceType, setSourceType] = useState<SourceCard["sourceType"]>(draft?.sourceType ?? source.sourceType);
  const [note, setNote] = useState(draft?.note ?? source.note ?? "");
  const [enabled, setEnabled] = useState(draft?.enabled ?? source.enabled);
  const [tags, setTags] = useState(draft?.tags ?? tagInputValue(source.tags ?? []));
  const totalSkillCount = Math.max(source.skillCount ?? 0, sourceSkills.length);
  const singleRootSkill = sourceSkills.length === 1;
  const routerSkills = singleRootSkill ? [] : sourceSkills.filter(isRouterHubSkill);
  const childSkills = singleRootSkill ? sourceSkills : sourceSkills.filter(skill => !isRouterHubSkill(skill));
  const mapSkills = childSkills.length > 0 ? childSkills : sourceSkills;
  const projectAddress = source.url || source.localPath || t("srcEditor.noAddress");

  useEffect(() => {
    setName(draft?.name ?? source.name);
    setCategory(draft?.category ?? source.categoryId);
    setSourceType(draft?.sourceType ?? source.sourceType);
    setNote(draft?.note ?? source.note ?? "");
    setEnabled(draft?.enabled ?? source.enabled);
    setTags(draft?.tags ?? tagInputValue(source.tags ?? []));
  }, [draft, source.id]);

  return (
    <Drawer onClose={onClose} eyebrow={t("srcEditor.eyebrow")} title={source.name} wide>
      <div className="source-detail-address">
        <span>{t("srcEditor.address")}</span>
        <code title={projectAddress}>{projectAddress}</code>
      </div>
      <div className="source-detail-metrics">
        <span>
          <b>{totalSkillCount}</b>
          <small>{t("srcEditor.skills")}</small>
        </span>
        <span>
          <b>{popularity?.stars ? formatCompactNumber(popularity.stars) : t("srcEditor.notRefreshed")}</b>
          <small>{t("srcEditor.stars")}</small>
        </span>
        <span>
          <b>{popularity?.localTotalCount ?? 0}</b>
          <small>{t("srcEditor.calls")}</small>
        </span>
      </div>
      <section className="source-quality-panel" aria-label={t("quality.title")}>
        <header>
          <div>
            <span>{t("quality.eyebrow")}</span>
            <strong>
              {quality?.score == null
                ? t("quality.noScore")
                : t("quality.score", { n: quality.score })}
            </strong>
          </div>
          <em>
            {t("quality.evidence", {
              n: quality?.evidenceCount ?? 0,
              total: quality?.evidenceTotal ?? 4
            })}
          </em>
        </header>
        <p>{t("quality.explainer")}</p>
        <div className="source-quality-factors">
          {(quality?.factors ?? []).map(factor => (
            <span
              className={factor.status === "available" ? "available" : "missing"}
              key={factor.key}
              title={factor.detail}
            >
              <b>{qualityFactorLabel(factor.key, factor.label)}</b>
              <small>
                {factor.score == null
                  ? t("quality.excluded")
                  : t("quality.factorScore", { n: factor.score, weight: factor.weight })}
              </small>
            </span>
          ))}
        </div>
      </section>
      <section className="source-governance-panel" aria-label={t("governance.title")}>
        <header>
          <div>
            <span>{t("governance.eyebrow")}</span>
            <strong>
              {governance?.supportStatus === "git"
                ? governance.pinned
                  ? t("governance.pinned")
                  : t("governance.autoUpdate")
                : t("governance.localOnly")}
            </strong>
          </div>
          {governance?.diffSource === "cached" && <em>{t("governance.cached")}</em>}
        </header>
        {governance?.supportStatus === "git" ? (
          <>
            <dl className="source-governance-revisions">
              <div>
                <dt>{t("governance.current")}</dt>
                <dd>{shortRevision(governance.currentRevision) || "—"}</dd>
              </div>
              <div>
                <dt>{t("governance.upstream")}</dt>
                <dd>{shortRevision(governance.remoteRevision) || "—"}</dd>
              </div>
              <div>
                <dt>{t("governance.diff")}</dt>
                <dd>
                  {t("governance.diffValue", {
                    files: governance.changedFiles,
                    additions: governance.additions,
                    deletions: governance.deletions
                  })}
                </dd>
              </div>
              <div>
                <dt>{t("governance.backups")}</dt>
                <dd>{governance.backupCount}</dd>
              </div>
            </dl>
            {governance.remoteSummary && <p>{governance.remoteSummary}</p>}
            <div className="source-governance-actions">
              <button className="ghost-action small" onClick={onRefreshVersion} type="button">
                <Icon name="refresh" /> {t("governance.refresh")}
              </button>
              <button
                className={governance.pinned ? "ghost-action small active" : "ghost-action small"}
                onClick={() => onSetPinned(!governance.pinned)}
                type="button"
              >
                <Icon name="shield" />
                {governance.pinned ? t("governance.unpin") : t("governance.pin")}
              </button>
              <button
                className="ghost-action small"
                disabled={!governance.canRollback}
                onClick={onRollbackVersion}
                title={
                  governance.canRollback
                    ? t("governance.rollbackTip", {
                        revision: shortRevision(governance.latestBackupRevision)
                      })
                    : t("governance.noRollback")
                }
                type="button"
              >
                <Icon name="snapshots" /> {t("governance.rollback")}
              </button>
            </div>
          </>
        ) : (
          <p>{t("governance.localExplanation")}</p>
        )}
      </section>
      <div className="source-detail-skill-map">
        <div className="source-detail-section-title">
          <strong>{t("srcEditor.map")}</strong>
          <span>{t("srcEditor.mapCount", { total: totalSkillCount, routers: routerSkills.length, children: childSkills.length })}</span>
          <button className="ghost-action small" onClick={onOpenChildren} type="button">
            <Icon name="chevron" />
          </button>
        </div>
        {mapSkills.length === 0 && (
          <p className="source-detail-muted">
            {source.sourceType === "prompt" ? t("lib.promptOnly") : t("srcEditor.noChildren")}
          </p>
        )}
        {mapSkills.slice(0, 10).map(skill => (
          <article className="source-detail-child" key={skill.folderName}>
            <strong>{skill.name}</strong>
            <span>{cleanSkillDescription(skill.description) || displayCategoryName(skill.category)}</span>
          </article>
        ))}
      </div>
      <label>
        {t("srcEditor.name")}
        <input onChange={event => setName(event.target.value)} value={name} />
      </label>
      <label>
        {t("srcEditor.type")}
        <select onChange={event => setSourceType(event.target.value as SourceCard["sourceType"])} value={sourceType}>
          <option value="skill">{t("type.skill")}</option>
          <option value="prompt">{t("type.prompt")}</option>
          <option value="mixed">{t("type.mixed")}</option>
        </select>
      </label>
      <label>
        {t("srcEditor.category")}
        <input onChange={event => setCategory(event.target.value)} value={category} />
      </label>
      <label>
        {t("srcEditor.tags")}
        <input
          onChange={event => setTags(event.target.value)}
          placeholder={t("srcEditor.tagsPlaceholder")}
          value={tags}
        />
      </label>
      <label>
        {t("srcEditor.note")}
        <textarea
          onChange={event => setNote(event.target.value)}
          placeholder={t("srcEditor.notePlaceholder")}
          rows={3}
          value={note}
        />
      </label>
      <div className="source-editor-toggle">
        <div>
          <strong>{t("srcEditor.enable")}</strong>
          <span>{t("srcEditor.enableHint")}</span>
        </div>
        <ToggleSwitch
          disabled={false}
          enabled={enabled}
          label={enabled ? t("common.enabled") : t("common.disabled")}
          onClick={() => setEnabled(value => !value)}
        />
      </div>
      <footer>
        <button className="danger-action" onClick={onDelete} type="button">
          <Icon name="trash" /> {t("srcEditor.delete")}
        </button>
        <span className="footer-spacer" />
        <button className="secondary-action" onClick={onClose} type="button">{t("common.cancel")}</button>
        <button
          className="primary-action"
          onClick={() => onSave({ category, enabled, name, note, sourceType, tags })}
          type="button"
        >
          {t("common.save")}
        </button>
      </footer>
    </Drawer>
  );
}

function Drawer({
  children,
  eyebrow,
  onClose,
  title,
  wide = false
}: {
  children: React.ReactNode;
  eyebrow: string;
  onClose: () => void;
  title: string;
  wide?: boolean;
}) {
  return createPortal(
    <>
      <div className="drawer-backdrop" onClick={onClose} aria-hidden="true" />
      <aside aria-label={title} aria-modal="true" className={wide ? "drawer wide" : "drawer"} role="dialog">
        <header>
          <div>
            <span>{eyebrow}</span>
            <strong>{title}</strong>
          </div>
          <button className="icon-action" onClick={onClose} title={t("common.close")} type="button">
            <Icon name="add" className="rotate-45" />
          </button>
        </header>
        {children}
      </aside>
    </>,
    document.getElementById("app-overlay-root") ?? document.body
  );
}

/* =============================================================
   Router hub + conflict selector (used inside Library maintenance)
   ============================================================= */

function RouterHubPanel({
  disabled,
  realWritesEnabled
}: {
  disabled: boolean;
  realWritesEnabled: boolean;
}) {
  const [report, setReport] = useState<RouterHubReport | null>(null);
  const [pending, setPending] = useState<"" | "plan" | "commit">("");
  const [error, setError] = useState("");
  const runtimeAvailable = hasTauriRuntime();

  async function run(commit: boolean) {
    if (!runtimeAvailable) {
      setError(t("router.browserBlocked"));
      return;
    }
    setPending(commit ? "commit" : "plan");
    setError("");
    try {
      const next = await invoke<RouterHubReport>("regenerate_router_hubs", { commit });
      setReport(next);
      showUiToast(
        commit
          ? routerHubCommitMessage(next)
          : t("router.toastDryRun", {
              collections: next.totalCollections,
              duplicates: next.duplicateChildren.length
            }),
        "ok"
      );
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError(message);
      showUiToast(t("router.toastFailed", { message }), "error");
    } finally {
      setPending("");
    }
  }

  return (
    <section className="router-hub-panel glow-card">
      <header className="panel-head">
        <div>
          <span className="eyebrow">{t("router.eyebrow")}</span>
          <h3>{t("router.title")}</h3>
          <p>{t("router.subtitle")}</p>
        </div>
        <div className="panel-head-actions">
          <button
            className="ghost-action"
            disabled={disabled || pending !== ""}
            onClick={() => void run(false)}
            type="button"
          >
            {pending === "plan" ? t("router.previewing") : t("router.preview")}
          </button>
          <button
            className="primary-action"
            disabled={disabled || pending !== "" || !realWritesEnabled || !runtimeAvailable}
            onClick={() => void run(true)}
            title={
              !realWritesEnabled ? t("router.needAuth") : !runtimeAvailable ? t("router.previewOnly") : t("router.runNow")
            }
            type="button"
          >
            {pending === "commit" ? t("router.rebuilding") : t("router.rebuild")}
          </button>
        </div>
      </header>

      {!report && !error && <p className="router-hub-hint">{t("router.hint")}</p>}
      {error && <div className="router-hub-error">{error}</div>}

      {report && (
        <>
          <div className="router-hub-stats">
            <span className="router-hub-stat">
              <strong>{report.totalCollections}</strong>
              <em>{t("router.collections")}</em>
            </span>
            <span className="router-hub-stat ok">
              <strong>{report.writtenCount}</strong>
              <em>{report.committed ? t("router.written") : t("router.pendingWrite")}</em>
            </span>
            <span className="router-hub-stat">
              <strong>{routerHubUnchangedCount(report)}</strong>
              <em>{t("router.upToDate")}</em>
            </span>
            <span className="router-hub-stat">
              <strong>{report.skippedCount}</strong>
              <em>{t("router.skipped")}</em>
            </span>
            <span className="router-hub-stat warn">
              <strong>{report.duplicateChildren.length}</strong>
              <em>{t("router.duplicates")}</em>
            </span>
            <span className="router-hub-stat warn">
              <strong>{report.healthWarnings.length}</strong>
              <em>{t("router.formatWarnings")}</em>
            </span>
          </div>
          <button className="ghost-action small" onClick={() => setReport(null)} type="button">
            {t("router.collapse")}
          </button>
        </>
      )}
    </section>
  );
}

function SkillConflictPanel({
  conflicts,
  disabled,
  onResolve
}: {
  conflicts: SkillConflictCard[];
  disabled: boolean;
  onResolve: (
    conflictKey: string,
    defaultSkillId: string,
    status: "default-set" | "ignored" | "unresolved"
  ) => Promise<void>;
}) {
  const automatic = conflicts.filter(conflict => conflict.status === "auto-set" || conflict.status === "unresolved").length;
  const resolved = conflicts.filter(conflict => conflict.status === "default-set").length;
  const ignored = conflicts.filter(conflict => conflict.status === "ignored").length;
  const aliasCount = conflicts.reduce((total, conflict) => total + conflict.choices.length, 0);
  const [activeKey, setActiveKey] = useState(conflicts[0]?.conflictKey ?? "");
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<"attention" | "resolved" | "all">("attention");
  const visibleConflicts = useMemo(() => {
    const normalizedQuery = normalizeSearch(query);
    return conflicts.filter(conflict => {
      const scopeMatches =
        scope === "all" ||
        (scope === "attention" && (conflict.status === "auto-set" || conflict.status === "unresolved")) ||
        (scope === "resolved" && conflict.status === "default-set");
      if (!scopeMatches) return false;
      if (!normalizedQuery) return true;
      return normalizeSearch(
        `${conflict.childName} ${conflict.conflictKey} ${conflict.choices.map(choice => choice.sourceName).join(" ")}`
      ).includes(normalizedQuery);
    });
  }, [conflicts, query, scope]);
  const selected =
    visibleConflicts.find(conflict => conflict.conflictKey === activeKey) ??
    visibleConflicts[0] ??
    conflicts.find(conflict => conflict.conflictKey === activeKey) ??
    conflicts[0];

  useEffect(() => {
    if (selected && selected.conflictKey !== activeKey) setActiveKey(selected.conflictKey);
  }, [activeKey, selected]);

  if (!selected) return null;

  return (
    <section className="conflict-panel routing-observatory glow-card">
      <header className="routing-head">
        <div className="routing-heading">
          <span className="eyebrow"><Icon name="workspaces" /> {t("conf.observatoryEyebrow")}</span>
          <h3>{t("conf.observatoryTitle")}</h3>
          <p>{t("conf.observatorySubtitle")}</p>
        </div>
        <div className="routing-coordinate" aria-hidden="true">
          <span>ROUTE / 03</span>
          <strong>{conflicts.length.toString().padStart(3, "0")}</strong>
        </div>
      </header>

      <div className="routing-summary" aria-label={t("conf.routeSummary")}>
        <span className="tone-auto"><b>{automatic}</b>{t("conf.needsReview")}</span>
        <span className="tone-routed"><b>{resolved}</b>{t("conf.routed")}</span>
        <span><b>{aliasCount}</b>{t("conf.aliasesAlive")}</span>
        <span><b>{ignored}</b>{t("conf.deferred")}</span>
      </div>

      <div className="routing-toolbar">
        <label className="routing-search">
          <Icon name="search" />
          <input
            aria-label={t("conf.search")}
            onChange={event => setQuery(event.target.value)}
            placeholder={t("conf.searchPlaceholder")}
            value={query}
          />
        </label>
        <div className="routing-scopes" role="group" aria-label={t("conf.filter")}>
          {(["attention", "resolved", "all"] as const).map(value => (
            <button
              className={scope === value ? "active" : ""}
              key={value}
              onClick={() => setScope(value)}
              type="button"
            >
              {t(`conf.filter.${value}`)}
            </button>
          ))}
        </div>
        <button className="routing-safe-action" disabled type="button" title={t("conf.safePendingBackend")}>
          <Icon name="sparkle" /> {t("conf.acceptSafe")}
        </button>
      </div>

      <div className="routing-layout">
        <nav className="routing-queue" aria-label={t("conf.groups", { n: visibleConflicts.length })}>
          <div className="routing-queue-label">
            <span>{t("conf.queue")}</span>
            <b>{visibleConflicts.length.toString().padStart(2, "0")}</b>
          </div>
          <ul>
            {visibleConflicts.map((conflict, index) => (
              <li key={conflict.conflictKey}>
              <button
                className={conflict.conflictKey === selected.conflictKey ? "active" : ""}
                onClick={() => setActiveKey(conflict.conflictKey)}
                type="button"
              >
                <span>{String(index + 1).padStart(2, "0")}</span>
                <div>
                  <strong>/{conflict.childName}</strong>
                  <small>
                    {conflict.status === "default-set" && conflict.defaultSourceName
                      ? conflict.defaultSourceName
                      : conflictStatusLabel(conflict.status)}
                  </small>
                </div>
                <em>{conflict.choices.length}</em>
              </button>
              </li>
            ))}
          </ul>
          {visibleConflicts.length === 0 && <p>{t("conf.noFilterResults")}</p>}
        </nav>

        <div className="routing-stage">
          <header className="routing-stage-head">
            <div>
              <span>{t("conf.canonicalRoute")}</span>
              <h4>/{selected.childName}</h4>
              <p>{t("conf.detailHint", { name: selected.childName })}</p>
            </div>
            <span className={`routing-status status-${selected.status}`}>
              {conflictStatusLabel(selected.status)}
            </span>
          </header>

          <div className="routing-comparison" role="table" aria-label={t("conf.compareCandidates")}>
            <div className="routing-comparison-head" role="row">
              <span role="columnheader">{t("conf.source")}</span>
              <span role="columnheader">{t("conf.capability")}</span>
              <span role="columnheader">{t("conf.callRoute")}</span>
              <span role="columnheader">{t("conf.decision")}</span>
            </div>
            {selected.choices.map(choice => {
              const isDefault =
                selected.status === "default-set" && choice.skillId === selected.defaultSkillId;
              const alias = conflictAliasName(choice.sourceName, selected.childName);
              return (
                <article className={`routing-candidate${isDefault ? " selected" : ""}`} key={choice.skillId} role="row">
                  <div className="routing-source-cell" role="cell">
                    <i aria-hidden="true" />
                    <span>
                      <strong>{choice.sourceName}</strong>
                      <small>{displayCategoryName(choice.category) || t("conf.uncategorized")}</small>
                    </span>
                  </div>
                  <p role="cell">{choice.description || t("conf.noDescription")}</p>
                  <button
                    className="routing-alias"
                    onClick={() => void copyTextToClipboard(`/${alias}`, t("conf.aliasCopied"))}
                    title={choice.relativePath}
                    type="button"
                    role="cell"
                  >
                    <code>/{alias}</code><Icon name="copy" />
                  </button>
                  <div className="routing-decision-cell" role="cell">
                    <button
                      className={isDefault ? "routing-default is-default" : "routing-default"}
                      disabled={disabled || isDefault}
                      onClick={() => void onResolve(selected.conflictKey, choice.skillId, "default-set")}
                      type="button"
                    >
                      {isDefault ? t("conf.isDefault") : t("conf.setDefault")}
                    </button>
                  </div>
                </article>
              );
            })}
          </div>

          <footer className="routing-stage-foot">
            <span><Icon name="info" /> {t("conf.aliasGuarantee")}</span>
            <div>
            <button
                className="routing-text-action"
              disabled={disabled}
              onClick={() => void onResolve(selected.conflictKey, "", "unresolved")}
              type="button"
            >
              {t("conf.reset")}
            </button>
            <button
                className="routing-text-action"
              disabled={disabled}
              onClick={() => void onResolve(selected.conflictKey, "", "ignored")}
              type="button"
            >
              {t("conf.ignore")}
            </button>
            </div>
          </footer>
          </div>
      </div>
    </section>
  );
}

/* =============================================================
   Import wizard (simplified)
   ============================================================= */

function ImportWizard({
  disabled,
  onCancel,
  onPreview,
  onPromote,
  onRefreshIndex,
  onSaveSourceMetadata,
  onStage,
  sources
}: {
  disabled: boolean;
  onCancel: (operationId: string) => Promise<boolean>;
  onPreview: (importKind: string, input: string, options?: ImportFeedbackOptions) => Promise<SourceImportPlanCard>;
  onPromote: (
    importKind: string,
    stagedPath: string,
    sourceName: string,
    options?: ImportFeedbackOptions
  ) => Promise<SourceImportPromotionCard>;
  onRefreshIndex: () => Promise<LegacySnapshot | null>;
  onSaveSourceMetadata: (source: SourceCard, draft: SourceDraft) => Promise<"failed" | "preview" | "saved">;
  onStage: (importKind: string, input: string, options?: ImportFeedbackOptions) => Promise<SourceImportExecutionCard>;
  sources: SourceCard[];
}) {
  const [importKind, setImportKind] = useState("github");
  const [input, setInput] = useState("");
  const [sourceType, setSourceType] = useState<SourceCard["sourceType"]>("skill");
  const [note, setNote] = useState("");
  const [tags, setTags] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [customCategory, setCustomCategory] = useState("");
  const [selectedCategoryIds, setSelectedCategoryIds] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [activeOperationId, setActiveOperationId] = useState("");
  const [status, setStatus] = useState<QuickAddStatus | null>(null);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [securityReview, setSecurityReview] = useState<{
    execution: SourceImportExecutionCard;
    plan: SourceImportPlanCard;
  } | null>(null);

  const inferredIds = inferCategoryIds(`${input} ${note} ${sourceType} ${importKind}`);
  const effectiveCategoryIds = selectedCategoryIds.length > 0 ? selectedCategoryIds : inferredIds;

  function requiresSecurityReview(status: string) {
    return status === "review" || status === "warn";
  }

  function applyBackendProgress(event: SourceImportProgressEvent) {
    const ranges: Record<string, { start: number; end: number; step: number }> = {
      inspect: { start: 10, end: 20, step: 1 },
      git: { start: 24, end: 38, step: 2 },
      zip: { start: 40, end: 54, step: 2 },
      write: { start: 56, end: 68, step: 2 },
      security: { start: 70, end: 78, step: 3 }
    };
    const range = ranges[event.stage] ?? { start: 22, end: 68, step: 2 };
    const measured = event.total > 0 ? Math.min(1, Math.max(0, event.current / event.total)) : 0;
    const percent = event.state === "completed"
      ? range.end
      : Math.round(range.start + (range.end - range.start) * measured);
    setProgress(current => ({
      detail: event.message || current?.detail || t("qa.statusJoining"),
      indeterminate: event.total <= 0 && event.state !== "completed",
      percent: Math.max(current?.percent ?? 0, percent),
      step: Math.max(current?.step ?? 1, range.step),
      total: 5
    }));
  }

  async function promoteAndFinalize(
    plan: SourceImportPlanCard,
    execution: SourceImportExecutionCard,
    securityReviewConfirmed: boolean
  ): Promise<boolean> {
      setProgress({ detail: t("qa.statusWriting"), percent: 74, step: 3, total: 5 });
      setStatus({ tone: "info", title: t("qa.statusWriting"), body: t("qa.statusWritingBody") });
      const promotion = await onPromote(
        execution.importKind,
        execution.stagedPath,
        plan.displayName,
        { quiet: true, securityReviewConfirmed }
      );
      if (
        promotion.status === "blocked" &&
        requiresSecurityReview(promotion.securityStatus) &&
        !securityReviewConfirmed
      ) {
        setProgress({ detail: t("qa.securityReviewTitle"), percent: 70, step: 3, total: 5 });
        setSecurityReview({
          plan,
          execution: {
            ...execution,
            securityStatus: promotion.securityStatus,
            securityScannedFiles: promotion.securityScannedFiles,
            securityFindings: promotion.securityFindings,
            summary: promotion.summary
          }
        });
        setStatus({
          tone: "warn",
          title: t("qa.securityReviewTitle"),
          body: t("qa.securityReviewBody", {
            files: promotion.securityScannedFiles,
            findings: promotion.securityFindings.length
          })
        });
        showUiToast(t("qa.securityReviewToast"), "warn");
        return false;
      }
      if (promotion.status !== "promoted" && promotion.status !== "already-managed") {
        setSecurityReview(null);
        setProgress(null);
        setStatus({ tone: "warn", title: t("qa.statusNotWritten"), body: promotion.summary });
        showUiToast(t("qa.toastPromoteStop"), "warn");
        return false;
      }
      setSecurityReview(null);
      setProgress({ detail: t("qa.statusRefreshing"), percent: 88, step: 4, total: 5 });
      setStatus({ tone: "info", title: t("qa.statusRefreshing"), body: t("qa.statusRefreshingBody") });
      const refreshed = await onRefreshIndex();
      const promotedSource = refreshed?.sources.find(
        item => normalizeSourcePath(item.localPath) === normalizeSourcePath(promotion.targetPath)
      );
      if (promotedSource) {
        const detectedSourceType: SourceCard["sourceType"] =
          execution.skillCount === 0 && execution.promptCount > 0
            ? "prompt"
            : execution.skillCount > 0
              ? "skill"
              : sourceType;
        const customCategoryLabel = customCategory.trim();
        const primaryCategory =
          customCategoryLabel ||
          displayCategoryName(effectiveCategoryIds[0] ?? categoryIdForSourceType(detectedSourceType));
        const extraTags = effectiveCategoryIds.slice(customCategoryLabel ? 0 : 1).map(displayCategoryName).join(", ");
        const draft: SourceDraft = {
          category: primaryCategory,
          enabled,
          name: promotedSource.name,
          note,
          sourceType: detectedSourceType,
          tags: mergeTagInputs(tags, extraTags)
        };
        setProgress({ detail: t("qa.statusRefreshing"), percent: 96, step: 5, total: 5 });
        await onSaveSourceMetadata(promotedSource, draft);
      }
      setProgress({ detail: t("qa.statusAddedTitle"), percent: 100, step: 5, total: 5 });
      setStatus({
        tone: "ok",
        title: t("qa.statusAddedTitle"),
        body:
          execution.skillCount === 0 && execution.promptCount > 0
            ? t("qa.statusAddedPrompt")
            : t("qa.statusAddedSynced")
      });
      showUiToast(t("qa.toastSynced"), "ok");
      return true;
  }

  async function quickAdd() {
    const value = input.trim();
    if (!value) {
      showUiToast(t("qa.needInput"), "warn");
      return;
    }
    setPending(true);
    setSecurityReview(null);
    setProgress({ detail: t("qa.statusChecking"), percent: 8, step: 1, total: 5 });
    setStatus({ tone: "info", title: t("qa.statusChecking"), body: t("qa.statusCheckingBody") });
    try {
      const plan = await onPreview(importKind, value, { quiet: true });
      if (!plan.safeToContinue) {
        setProgress(null);
        setStatus({
          tone: "warn",
          title: t("qa.statusBlockedTitle"),
          body: plan.duplicateReason || plan.blockingChecks[0] || ""
        });
        showUiToast(t("qa.toastBlocked"), "warn");
        return;
      }
      setProgress({ detail: t("qa.statusJoining"), percent: 20, step: 2, total: 5 });
      setStatus({ tone: "info", title: t("qa.statusJoining"), body: t("qa.statusJoiningBody") });
      const operationId = createSourceImportOperationId();
      setActiveOperationId(operationId);
      const execution = await onStage(plan.importKind, plan.input, {
        quiet: true,
        operationId,
        onProgress: applyBackendProgress
      });
      setProgress(current => ({
        detail: t("qa.statusJoining"),
        percent: Math.max(current?.percent ?? 0, 68),
        step: Math.max(current?.step ?? 2, 2),
        total: 5
      }));
      if (execution.status !== "staged" && execution.status !== "warn") {
        const detail = execution.blockingChecks
          .filter(check => check.trim())
          .slice(0, 2)
          .join("；");
        setStatus({
          tone: "warn",
          title: t("qa.statusNotWritten"),
          body: `${execution.summary}${detail && detail !== execution.summary ? `\n${detail}` : ""}`
        });
        setProgress(null);
        showUiToast(t("qa.toastStagingStop"), "warn");
        return;
      }
      if (requiresSecurityReview(execution.securityStatus)) {
        setProgress({ detail: t("qa.securityReviewTitle"), percent: 70, step: 3, total: 5 });
        setSecurityReview({ execution, plan });
        setStatus({
          tone: "warn",
          title: t("qa.securityReviewTitle"),
          body: t("qa.securityReviewBody", {
            files: execution.securityScannedFiles,
            findings: execution.securityFindings.length
          })
        });
        showUiToast(t("qa.securityReviewToast"), "warn");
        return;
      }
      await promoteAndFinalize(plan, execution, false);
    } catch (error) {
      const message = messageFromError(error);
      const wasCancelled = /cancel|取消|취소/i.test(message);
      setProgress(null);
      setStatus({
        tone: wasCancelled ? "info" : "error",
        title: wasCancelled ? t("qa.cancelled") : t("qa.statusFailed"),
        body: message
      });
      showUiToast(wasCancelled ? t("qa.cancelled") : t("qa.toastFailed"), wasCancelled ? "info" : "error");
    } finally {
      setActiveOperationId("");
      setCancelling(false);
      setPending(false);
    }
  }

  async function cancelImport() {
    if (!activeOperationId || cancelling) return;
    setCancelling(true);
    setStatus({ tone: "info", title: t("qa.cancelling"), body: t("qa.cancellingBody") });
    try {
      const accepted = await onCancel(activeOperationId);
      if (!accepted) showUiToast(t("qa.cancelNoTask"), "info");
    } catch (error) {
      setCancelling(false);
      showUiToast(messageFromError(error), "error");
    }
  }

  async function confirmSecurityReview() {
    if (!securityReview) return;
    setPending(true);
    setProgress({ detail: t("qa.statusWriting"), percent: 74, step: 3, total: 5 });
    try {
      await promoteAndFinalize(securityReview.plan, securityReview.execution, true);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setProgress(null);
      setStatus({ tone: "error", title: t("qa.statusFailed"), body: message });
      showUiToast(t("qa.toastFailed"), "error");
    } finally {
      setPending(false);
    }
  }

  const isBusy = disabled || pending;
  const placeholder =
    importKind === "github"
      ? t("qa.placeholderGithub")
      : importKind === "local"
        ? t("qa.placeholderLocal")
        : t("qa.placeholderZip");
  const currentCategoryLabel =
    customCategory.trim() || effectiveCategoryIds.map(displayCategoryName).join("、") || t("type.mixed");

  return (
    <section className="import-wizard glow-card">
      <header className="panel-head">
        <div>
          <span className="eyebrow"><Icon name="add" /> {t("qa.eyebrow")}</span>
          <h3>{t("qa.title")}</h3>
          <p>{t("qa.subtitle")}</p>
        </div>
      </header>

      <div className="import-grid">
        <div className="import-field">
          <span className="field-label">{t("qa.kind")}</span>
          <SegmentedToggle
            value={importKind}
            options={[
              { value: "github", label: t("qa.kindGithub") },
              { value: "local", label: t("qa.kindLocal") },
              { value: "zip", label: t("qa.kindZip") }
            ]}
            onChange={value => {
              setImportKind(value);
              setSecurityReview(null);
              setProgress(null);
            }}
          />
        </div>
        <label className="import-field grow">
          <span className="field-label">{t("qa.input")}</span>
          <input
            disabled={isBusy}
            onChange={event => {
              setInput(event.target.value);
              setSecurityReview(null);
              setProgress(null);
            }}
            placeholder={placeholder}
            value={input}
          />
        </label>
        <label className="import-field">
          <span className="field-label">{t("qa.type")}</span>
          <select
            disabled={isBusy}
            onChange={event => setSourceType(event.target.value as SourceCard["sourceType"])}
            value={sourceType}
          >
            <option value="skill">{t("qa.typeSkill")}</option>
            <option value="prompt">{t("qa.typePrompt")}</option>
            <option value="mixed">{t("qa.typeMixed")}</option>
          </select>
        </label>
      </div>

      <div className="import-field">
        <span className="field-label">{t("qa.category")}</span>
        <div className="category-chip-grid">
          {CATEGORY_IDS.map(id => (
            <button
              className={
                effectiveCategoryIds.includes(id) ? "category-chip active" : "category-chip"
              }
              disabled={isBusy}
              key={id}
              onClick={() =>
                setSelectedCategoryIds(prev =>
                  prev.includes(id) ? prev.filter(value => value !== id) : [...prev, id]
                )
              }
              type="button"
            >
              {displayCategoryName(id)}
            </button>
          ))}
        </div>
        <input
          className="category-custom"
          disabled={isBusy}
          onChange={event => setCustomCategory(event.target.value)}
          placeholder={t("qa.customCategoryPlaceholder")}
          value={customCategory}
        />
        <small>{t("qa.currentCategory", { value: currentCategoryLabel })}</small>
      </div>

      <label className="import-field">
        <span className="field-label">{t("qa.tags")}</span>
        <input
          disabled={isBusy}
          onChange={event => setTags(event.target.value)}
          placeholder={t("qa.tagsPlaceholder")}
          value={tags}
        />
      </label>

      <label className="import-field">
        <span className="field-label">{t("qa.note")}</span>
        <textarea
          disabled={isBusy}
          onChange={event => setNote(event.target.value)}
          placeholder={t("qa.notePlaceholder")}
          rows={2}
          value={note}
        />
      </label>

      <div className="import-toggle-row">
        <div>
          <strong>{t("qa.enableAfter")}</strong>
          <span>{t("qa.enableAfterHint")}</span>
        </div>
        <ToggleSwitch
          disabled={isBusy}
          enabled={enabled}
          label={enabled ? t("common.enabled") : t("common.disabled")}
          onClick={() => setEnabled(value => !value)}
        />
      </div>

      {securityReview && (
        <section className="import-security-review" role="alert" aria-live="assertive">
          <header>
            <span className="import-security-review-icon"><Icon name="shield" /></span>
            <div>
              <strong>{t("qa.securityReviewTitle")}</strong>
              <p>
                {t("qa.securityReviewBody", {
                  files: securityReview.execution.securityScannedFiles,
                  findings: securityReview.execution.securityFindings.length
                })}
              </p>
            </div>
            <span className="qa-status planned">{t("qa.securityReviewIsolated")}</span>
          </header>
          <ul className="import-security-findings">
            {securityReview.execution.securityFindings.slice(0, 8).map(finding => (
              <li key={finding.id}>
                <span className={`security-severity severity-${finding.severity}`}>
                  {finding.severity}
                </span>
                <div>
                  <strong>
                    {finding.relativePath}
                    {finding.line > 0 ? `:${finding.line}` : ""}
                  </strong>
                  <span>{finding.summary}</span>
                  {finding.evidence && <code>{finding.evidence}</code>}
                </div>
              </li>
            ))}
            {securityReview.execution.securityFindings.length === 0 && (
              <li>
                <div>
                  <strong>{t("qa.securityReviewEvidenceFallback")}</strong>
                  <span>{securityReview.execution.summary}</span>
                </div>
              </li>
            )}
          </ul>
          {securityReview.execution.securityFindings.length > 8 && (
            <small>
              {t("qa.securityReviewMore", {
                n: securityReview.execution.securityFindings.length - 8
              })}
            </small>
          )}
          <div className="import-security-actions">
            <button
              className="ghost-action"
              disabled={isBusy}
              onClick={() => {
                setSecurityReview(null);
                setStatus({
                  tone: "info",
                  title: t("qa.securityReviewDeferredTitle"),
                  body: t("qa.securityReviewDeferredBody")
                });
              }}
              type="button"
            >
              {t("qa.securityReviewCancel")}
            </button>
            <button
              className="primary-action"
              disabled={isBusy}
              onClick={() => void confirmSecurityReview()}
              type="button"
            >
              <Icon name="shield" /> {t("qa.securityReviewConfirm")}
            </button>
          </div>
        </section>
      )}

      <div className="import-actions">
        {activeOperationId && (
          <button className="secondary-action import-cancel-action" disabled={cancelling} onClick={() => void cancelImport()} type="button">
            <Icon name="alert" /> {cancelling ? t("qa.cancelling") : t("qa.cancelImport")}
          </button>
        )}
        <button className="primary-action large" disabled={isBusy} onClick={() => void quickAdd()} type="button">
          <Icon name="add" /> {isBusy ? t("qa.submitting") : t("qa.submit")}
        </button>
      </div>

      {progress && (
        <div
          aria-label={`${progress.detail} ${progress.percent}%`}
          aria-valuemax={100}
          aria-valuemin={0}
          aria-valuenow={progress.indeterminate ? undefined : progress.percent}
          className={`import-progress${pending ? " is-active" : ""}${progress.indeterminate ? " is-indeterminate" : ""}`}
          role="progressbar"
        >
          <div className="import-progress-copy">
            <strong>{progress.detail}</strong>
            <span>{progress.step} / {progress.total}{progress.indeterminate ? ` · ${t("qa.measuring")}` : ` · ${progress.percent}%`}</span>
          </div>
          <div className="import-progress-track">
            <span style={{ width: progress.indeterminate ? "28%" : `${progress.percent}%` }} />
          </div>
        </div>
      )}

      {status && (
        <div className={`import-status tone-${status.tone}`} role="status">
          <strong>{status.title}</strong>
          <span>{status.body}</span>
        </div>
      )}

      <small className="import-foot">{sources.length} sources indexed</small>
    </section>
  );
}

/* =============================================================
   Workspaces / Presets / Agents views
   ============================================================= */

function Workspaces({
  disabled,
  onToggle,
  snapshot
}: {
  disabled: boolean;
  onToggle: (command: string, id: string, enabled: boolean) => Promise<void>;
  snapshot: LegacySnapshot | null;
}) {
  const workspaces = snapshot?.workspaces ?? [];
  const projectScans = snapshot?.projectScans ?? [];
  const [selectedId, setSelectedId] = useState("");

  useEffect(() => {
    if (workspaces.length === 0) {
      if (selectedId) setSelectedId("");
      return;
    }
    if (!workspaces.some(workspace => workspace.id === selectedId)) {
      setSelectedId(workspaces[0].id);
    }
  }, [workspaces, selectedId]);

  const selected = workspaces.find(workspace => workspace.id === selectedId) ?? workspaces[0];
  const selectedScan = selected ? projectScans.find(scan => scan.workspaceId === selected.id) : undefined;

  return (
    <div className="view workspaces-view">
      <section className="page-header glow-card">
        <div>
          <span className="eyebrow"><Icon name="workspaces" /> {t("nav.workspaces")}</span>
          <h2>{t("ws.title")}</h2>
          <p>{t("ws.subtitle")}</p>
        </div>
      </section>

      <div className="workspace-grid">
        {workspaces.map(workspace => (
          <article
            className={`workspace-card glow-card${workspace.id === selected?.id ? " selected" : ""}`}
            key={workspace.id}
          >
            <header>
              <strong>{workspace.name}</strong>
              <span className={`scope-pill ${workspace.scope}`}>{scopeLabel(workspace.scope)}</span>
            </header>
            <p>{workspace.path}</p>
            <div className="workspace-stats">
              <span>
                <b>{workspace.agentCount}</b>
                <small>{t("ws.aiTools")}</small>
              </span>
              <span>
                <b>{workspace.skillCount}</b>
                <small>{t("ws.skillsLabel")}</small>
              </span>
            </div>
            <footer>
              <button className="ghost-action" onClick={() => setSelectedId(workspace.id)} type="button">
                {t("ws.viewDetail")}
              </button>
              <ToggleSwitch
                disabled={disabled}
                enabled={workspace.enabled}
                label={workspace.enabled ? t("common.enabled") : t("common.disabled")}
                onClick={() => onToggle("set_workspace_enabled", workspace.id, !workspace.enabled)}
              />
            </footer>
          </article>
        ))}
        {workspaces.length === 0 && <p className="empty-state">{t("ws.empty")}</p>}
      </div>

      {selected && (
        <WorkspaceDetailPanel projectScan={selectedScan} workspace={selected} />
      )}

      <section className="panel glow-card">
        <header className="panel-head">
          <div>
            <span className="eyebrow">{t("ws.scannerEyebrow")}</span>
            <h3>{t("ws.scannerTitle")}</h3>
          </div>
        </header>
        <div className="project-scan-list">
          {projectScans.map(scan => (
            <article className="project-card" key={scan.id}>
              <header>
                <div>
                  <strong>{scan.path}</strong>
                  <span>{t("ws.files", { n: scan.fileCount })} · {t("ws.lastScan", { time: formatScanTime(scan.scannedAt) })}</span>
                </div>
                <span className="scope-pill project">{t("ws.readonly")}</span>
              </header>
              <div className="scan-flags">
                <ScanFlag enabled={scan.hasGit} label="Git" />
                <ScanFlag enabled={scan.hasPackageJson} label="package.json" />
                <ScanFlag enabled={scan.hasCargoToml} label="Cargo.toml" />
                <ScanFlag enabled={scan.hasTauriConfig} label="Tauri" />
                <ScanFlag enabled={scan.hasAgentsMd} label="AGENTS.md" />
                <ScanFlag enabled={scan.hasClaudeMd} label="CLAUDE.md" />
                <ScanFlag enabled={scan.hasReadmeMd} label="README.md" />
              </div>
            </article>
          ))}
          {projectScans.length === 0 && <p>{t("ws.noProjects")}</p>}
        </div>
      </section>
    </div>
  );
}

function WorkspaceDetailPanel({
  projectScan,
  workspace
}: {
  projectScan?: { path: string };
  workspace: WorkspaceCard;
}) {
  const isProject = workspace.scope === "project";
  return (
    <section className="panel glow-card workspace-detail-panel">
      <header className="panel-head">
        <div>
          <span className="eyebrow">{t("ws.detailEyebrow")}</span>
          <h3>{workspace.name}</h3>
          <span>{workspace.path}</span>
        </div>
        <span className={`scope-pill ${workspace.scope}`}>{scopeLabel(workspace.scope)}</span>
      </header>
      <div className="workspace-detail-metrics">
        <article>
          <span>{t("ws.scope")}</span>
          <strong>{scopeLabel(workspace.scope)}</strong>
        </article>
        <article>
          <span>{t("ws.aiTools")}</span>
          <strong>{workspace.agentCount}</strong>
        </article>
        <article>
          <span>{t("ws.skillsLabel")}</span>
          <strong>{workspace.skillCount}</strong>
        </article>
        <article>
          <span>{t("ws.state")}</span>
          <strong>{workspace.enabled ? t("common.enabled") : t("common.disabled")}</strong>
        </article>
      </div>
      <p className="workspace-detail-note">
        {isProject
          ? projectScan
            ? `${projectScan.path}`
            : t("ws.scanWaitingBody")
          : t("ws.readonlyDetailBody")}
      </p>
    </section>
  );
}

function Presets({
  disabled,
  onToggle,
  snapshot
}: {
  disabled: boolean;
  onToggle: (command: string, id: string, enabled: boolean) => Promise<void>;
  snapshot: LegacySnapshot | null;
}) {
  const presets = snapshot?.presets ?? [];
  return (
    <div className="view presets-view">
      <section className="page-header glow-card">
        <div>
          <span className="eyebrow"><Icon name="list" /> {t("nav.presets")}</span>
          <h2>{t("preset.title")}</h2>
          <p>{t("preset.subtitle")}</p>
        </div>
      </section>

      <div className="preset-grid">
        {presets.map(preset => (
          <article className={`preset-card glow-card ${preset.color}`} key={preset.id}>
            <header>
              <strong>{preset.name}</strong>
              <span className="preset-count">{preset.skillCount}</span>
            </header>
            <p>{preset.description}</p>
            <div className="preset-meta">
              <span>{t("preset.skills", { n: preset.skillCount })}</span>
              <span>{t("preset.workspaces", { n: preset.workspaceCount })}</span>
            </div>
            <footer>
              <ToggleSwitch
                disabled={disabled}
                enabled={preset.enabled}
                label={preset.enabled ? t("common.enabled") : t("common.disabled")}
                onClick={() => onToggle("set_preset_enabled", preset.id, !preset.enabled)}
              />
            </footer>
          </article>
        ))}
        {presets.length === 0 && <p className="empty-state">{t("preset.empty")}</p>}
      </div>

    </div>
  );
}

function Agents({
  disabled,
  onRefreshAgents,
  onToggle,
  runtimeAvailable,
  snapshot
}: {
  disabled: boolean;
  onRefreshAgents: () => void;
  onToggle: (command: string, id: string, enabled: boolean) => Promise<void>;
  runtimeAvailable: boolean;
  snapshot: LegacySnapshot | null;
}) {
  const adapters = snapshot?.agentAdapters ?? [];
  const doctors = snapshot?.agentDoctors ?? [];
  const capabilities = snapshot?.adapterCapabilities ?? [];
  const safetyChecks = snapshot?.adapterSafetyChecks ?? [];
  return (
    <div className="view agents-view">
      <section className="page-header glow-card">
        <div>
          <span className="eyebrow"><Icon name="agent" /> {t("nav.agents")}</span>
          <h2>{t("agents.title")}</h2>
          <p>{t("agents.subtitle")}</p>
        </div>
        <div className="page-header-side">
          <div className="page-header-stats">
            <span>{t("agents.supported", { n: adapters.length })}</span>
            <span>{t("agents.detected", { n: adapters.filter(adapter => adapter.detected).length })}</span>
            <span>{t("agents.enabled", { n: adapters.filter(adapter => adapter.enabled).length })}</span>
          </div>
          <button className="secondary-action" disabled={disabled} onClick={onRefreshAgents} type="button">
            <Icon className={disabled ? "icon-spin" : ""} name="refresh" /> {disabled ? t("agents.detecting") : t("agents.detectNow")}
          </button>
        </div>
      </section>

      <section className="panel glow-card">
        <header className="panel-head">
          <div>
            <span className="eyebrow">{t("agents.registryEyebrow")}</span>
            <h3>{t("agents.registryTitle")}</h3>
            <p>{t("agents.registryBody")}</p>
          </div>
        </header>
      </section>

      <Suspense fallback={<DeferredSurface label={t("pluginDoctor.scanning")} />}>
        <CodexPluginDoctorPanel runtimeAvailable={runtimeAvailable} />
      </Suspense>

      <div className="adapter-grid">
        {adapters.map(adapter => {
          const doctor = doctors.find(item => item.adapterId === adapter.id);
          return (
          <article className="adapter-card glow-card" key={adapter.id}>
            <header>
              <strong>{adapter.name}</strong>
              <span className={`adapter-status ${adapter.status}`}>{adapterStatusLabel(adapter.status)}</span>
            </header>
            <p>{adapter.skillsPathHint || t("agents.noPath")}</p>
            {adapter.id === "claude" && <p className="adapter-note">{t("agents.claudeSkillsNote")}</p>}
            {doctor && (
              <div className={`adapter-doctor verdict-${doctor.verdict}`}>
                <header>
                  <strong>{t("doctor.title")}</strong>
                  <span className="doctor-verdict">{doctorVerdictLabel(doctor.verdict)}</span>
                </header>
                <p>{doctor.summary}</p>
                <dl>
                  <div><dt>{t("doctor.desktop")}</dt><dd className={`doctor-state state-${doctor.desktopStatus}`}>{doctorStatusLabel(doctor.desktopStatus)}</dd></div>
                  <div><dt>{t("doctor.cli")}</dt><dd className={`doctor-state state-${doctor.cliStatus}`}>{doctorStatusLabel(doctor.cliStatus)}</dd></div>
                  <div><dt>{t("doctor.skills")}</dt><dd className={`doctor-state state-${doctor.skillsStatus}`}>{doctorStatusLabel(doctor.skillsStatus)}</dd></div>
                </dl>
                {(doctor.evidence.length > 0 || doctor.nextSteps.length > 0) && (
                  <details>
                    <summary>{t("doctor.evidence")}</summary>
                    <ul>
                      {doctor.evidence.slice(0, 6).map((item, index) => (
                        <li className={`doctor-evidence status-${item.status}`} key={`${item.probeKind}-${item.label}-${index}`}>
                          <strong>{item.label}</strong>
                          <span>{item.detail}{item.path ? ` · ${item.path}` : ""}</span>
                        </li>
                      ))}
                      {doctor.nextSteps.map((step, index) => (
                        <li className="doctor-next-step" key={`next-${index}`}>{step}</li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            )}
            <ul className="capabilities">
              {capabilities
                .filter(capability => capability.adapterId === adapter.id)
                .slice(0, 4)
                .map(capability => (
                  <li className={capability.enabled ? "is-on" : ""} key={capability.id}>
                    {capabilityLabel(capability.capabilityKey)}
                  </li>
                ))}
            </ul>
            <ul className="safety">
              {safetyChecks
                .filter(check => check.adapterId === adapter.id)
                .slice(0, 3)
                .map(check => (
                  <li className={`safety-item ${check.status}`} key={check.id}>{check.summary}</li>
                ))}
            </ul>
            <footer>
              <span>{adapter.vendor}</span>
              <span>{adapter.detected ? t("agents.detectedFlag") : t("agents.notDetectedFlag")}</span>
              <ToggleSwitch
                disabled={disabled || !adapter.detected}
                enabled={adapter.enabled}
                label={!adapter.detected ? t("agents.notDetectedFlag") : adapter.enabled ? t("common.enabled") : t("common.disabled")}
                onClick={() => onToggle("set_agent_adapter_enabled", adapter.id, !adapter.enabled)}
              />
            </footer>
          </article>
          );
        })}
      </div>
    </div>
  );
}

/* =============================================================
   Advanced view (merges release gate + snapshots)
   ============================================================= */

function Advanced({
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

/* =============================================================
   Settings
   ============================================================= */

function Settings({
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
  onOpenAdvanced,
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
  onOpenAdvanced: () => void;
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
  const updateStatus = t(`update.status.${appUpdate.phase}`, {
    progress: appUpdate.progress,
    version: appUpdate.version || APP_VERSION
  });

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
          </div>
        </div>
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

/* =============================================================
   Shared primitives
   ============================================================= */

function SegmentedToggle<T extends string>({
  onChange,
  options,
  value
}: {
  onChange: (value: T) => void;
  options: Array<{ value: T; label: string }>;
  value: T;
}) {
  return (
    <div className="segmented" role="tablist">
      {options.map(option => (
        <button
          aria-selected={option.value === value}
          className={option.value === value ? "active" : ""}
          data-segment-value={option.value}
          key={option.value}
          onClick={() => onChange(option.value)}
          role="tab"
          type="button"
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function ToggleSwitch({
  disabled,
  enabled,
  label,
  onClick
}: {
  disabled: boolean;
  enabled: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      aria-label={label}
      aria-pressed={enabled}
      className={enabled ? "switch is-on" : "switch"}
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      <span className="switch-track" aria-hidden="true">
        <span className="switch-thumb" />
      </span>
      <span className="switch-label">{label}</span>
    </button>
  );
}

function Metric({
  accent = "violet",
  icon,
  label,
  onClick,
  trend,
  value
}: {
  accent?: string;
  icon?: IconName;
  label: string;
  onClick?: () => void;
  trend?: string;
  value: number;
}) {
  return (
    <button
      aria-label={label}
      className={`metric glow-card metric-${accent}${onClick ? " interactive" : ""}`}
      onClick={onClick}
      type="button"
    >
      <div>
        <span>{label}</span>
        {icon && <em aria-hidden="true"><Icon name={icon} /></em>}
      </div>
      <strong><CountUp value={value} /></strong>
      {trend && <small>{trend}</small>}
    </button>
  );
}

function ScanFlag({ enabled, label }: { enabled: boolean; label: string }) {
  return <span className={enabled ? "scan-flag is-on" : "scan-flag"}>{label}</span>;
}

/* =============================================================
   Helpers
   ============================================================= */

function hasTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function initialNavKey(): NavKey {
  if (typeof window === "undefined") return "dashboard";
  const view = new URLSearchParams(window.location.search).get("view");
  return isNavKey(view) ? view : "dashboard";
}

function initialTheme(): ThemeName {
  if (typeof window === "undefined") return "nocturne";
  const searchTheme = new URLSearchParams(window.location.search).get("theme");
  if (isThemeName(searchTheme)) return searchTheme;
  const savedTheme = window.localStorage.getItem("ai-skillhub-theme");
  return isThemeName(savedTheme) ? savedTheme : "nocturne";
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

function isAtlasTheme(theme: ThemeName): boolean {
  return (
    theme === "nocturne" ||
    theme === "parchment" ||
    theme === "atlas-dark" ||
    theme === "atlas-light" ||
    theme === "atlas-legacy-dark" ||
    theme === "atlas-legacy-light"
  );
}

function isLightTheme(theme: ThemeName): boolean {
  return (
    theme === "parchment" ||
    theme === "atlas-light" ||
    theme === "atlas-legacy-light" ||
    theme === "light" ||
    theme === "classic-light"
  );
}

function atlasThemeVisual(theme: ThemeName) {
  if (theme === "parchment") {
    return {
      accent: "#b7603f",
      palette: ["#b7603f", "#6e7a6c", "#c79b48", "#425b72"]
    };
  }
  if (theme === "nocturne") {
    return {
      accent: "#6f9dff",
      palette: ["#6f9dff", "#d9e5ff", "#ffbd7a", "#b49cff", "#65c9df"]
    };
  }
  if (theme === "atlas-light" || theme === "atlas-legacy-light") {
    return {
      accent: "#16796f",
      palette: ["#16796f", "#295a80", "#b7882f", "#67746f"]
    };
  }
  return {
    accent: "#7ce9df",
    palette: ["#7ce9df", "#dcefed", "#79aee8", "#d6b76c"]
  };
}

function themeLabel(theme: ThemeName): string {
  const option = THEME_OPTIONS.find(item => item.value === theme);
  return option ? t(option.labelKey) : t("theme.dark");
}

function themeIcon(theme: ThemeName): IconName {
  return THEME_OPTIONS.find(option => option.value === theme)?.icon ?? "moon";
}

function isNavKey(value: string | null): value is NavKey {
  return (
    value === "dashboard" ||
    value === "library" ||
    value === "workspaces" ||
    value === "presets" ||
    value === "sources" ||
    value === "agents" ||
    value === "connections" ||
    value === "snapshots" ||
    value === "release" ||
    value === "settings"
  );
}

function showUiToast(message: string, tone: ToastTone = "info") {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(TOAST_EVENT, { detail: { message, tone } }));
}

function messageFromError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function createSourceImportOperationId() {
  const random = globalThis.crypto?.randomUUID?.().replace(/[^a-zA-Z0-9_-]/g, "")
    ?? Math.random().toString(36).slice(2);
  return `source-import-${Date.now()}-${random}`.slice(0, 92);
}

function friendlyErrorMessage(message: string) {
  if (message.includes("Source metadata is too long")) return t("error.sourceTooLong");
  if (message.includes("GitHub API")) return t("error.github");
  return message;
}

function parseTagInput(value: string): string[] {
  return Array.from(
    new Set(
      value
        .split(/[,\n，;；#]+/)
        .map(tag => tag.trim())
        .filter(Boolean)
    )
  ).slice(0, 12);
}

function tagInputValue(tags?: string[]): string {
  return (tags ?? []).join(", ");
}

function mergeTagInputs(...values: string[]): string {
  return parseTagInput(values.join(", ")).join(", ");
}

function queryLooksLikeSkillCommand(query: string) {
  return query.trim().startsWith("/");
}

function normalizeSearch(value: string) {
  return value.toLowerCase().replace(/^\/+/, "").replace(/[_/\\.-]+/g, " ").replace(/\s+/g, " ").trim();
}

function compactSearch(value: string) {
  return value.toLowerCase().replace(/^\/+/, "").replace(/[^a-z0-9一-鿿]+/g, "");
}

function textMatchesSearch(query: string, values: Array<string | string[] | undefined>) {
  const tokens = normalizeSearch(query).split(" ").filter(Boolean);
  if (tokens.length === 0) return true;
  const joined = values.flatMap(value => (Array.isArray(value) ? value : [value ?? ""])).join(" ");
  const haystack = normalizeSearch(joined);
  const compactQuery = compactSearch(query);
  const compactHaystack = compactSearch(joined);
  return (
    tokens.every(token => haystack.includes(token)) ||
    (compactQuery.length >= 2 && compactHaystack.includes(compactQuery))
  );
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

function skillMatchesSearch(skill: SkillCard, query: string) {
  return textMatchesSearch(query, [
    skill.name,
    skill.folderName,
    skill.category,
    displayCategoryName(skill.category),
    skill.description,
    skill.note,
    skill.source,
    skill.relativePath,
    skill.tags
  ]);
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

function sourceMatchesSearch(source: SourceCard, query: string) {
  return textMatchesSearch(query, [
    source.name,
    source.categoryId,
    displayCategoryName(source.categoryId),
    source.sourceType,
    source.note,
    source.url,
    source.localPath,
    source.tags
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

function sortSources(
  sources: SourceCard[],
  sortKey: SourceSortKey,
  popularityById: Map<string, SourcePopularityCard>,
  skills: SkillCard[]
): SourceCard[] {
  return [...sources].sort((left, right) => {
    const leftPop = popularityById.get(left.id);
    const rightPop = popularityById.get(right.id);
    const nameCompare = left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" });
    switch (sortKey) {
      case "rating": {
        const leftSkills = skills.filter(skill => skillBelongsToSource(skill, left));
        const rightSkills = skills.filter(skill => skillBelongsToSource(skill, right));
        const leftParent = sourceParentSkill(left, leftSkills);
        const rightParent = sourceParentSkill(right, rightSkills);
        const leftRating = skillRatingSummary(leftSkills.filter(skill => skill !== leftParent));
        const rightRating = skillRatingSummary(rightSkills.filter(skill => skill !== rightParent));
        return (
          normalizedSourceRating(right, rightParent) - normalizedSourceRating(left, leftParent) ||
          rightRating.max - leftRating.max ||
          rightRating.average - leftRating.average ||
          rightRating.count - leftRating.count ||
          nameCompare
        );
      }
      case "usage":
        return (rightPop?.localTotalCount ?? 0) - (leftPop?.localTotalCount ?? 0) || nameCompare;
      case "heat":
        return (rightPop?.stars ?? 0) - (leftPop?.stars ?? 0) || nameCompare;
      case "skillCount":
        return right.skillCount - left.skillCount || nameCompare;
      case "health":
        return healthRank(left) - healthRank(right) || nameCompare;
      case "name":
        return nameCompare;
      default:
        return dateValue(right.createdAt) - dateValue(left.createdAt) || nameCompare;
    }
  });
}

type SkillRatingSummary = { average: number; count: number; max: number };

function normalizedSkillRating(skill: SkillCard) {
  return Math.max(0, Math.min(5, Math.round(skill.rating ?? 0)));
}

function normalizedOptionalSkillRating(skill?: SkillCard) {
  return skill ? normalizedSkillRating(skill) : 0;
}

function normalizedSourceRating(source: SourceCard, parentSkill?: SkillCard) {
  const rating = Math.max(0, Math.min(5, Math.round(source.rating ?? 0)));
  return rating || normalizedOptionalSkillRating(parentSkill);
}

function sourceParentSkill(source: SourceCard, skills: SkillCard[]): SkillCard | undefined {
  const sourceKey = normalizeLookup(source.name);
  return (
    skills.find(
      skill =>
        isRouterHubSkill(skill) &&
        [skill.folderName, skill.name].some(candidate => normalizeLookup(candidate) === sourceKey)
    ) ??
    skills.find(isRouterHubSkill) ??
    (skills.length === 1 ? skills[0] : undefined)
  );
}

function skillRatingSummary(skills: SkillCard[]): SkillRatingSummary {
  const ratings = skills.map(normalizedSkillRating).filter(rating => rating > 0);
  if (ratings.length === 0) return { average: 0, count: 0, max: 0 };
  return {
    average: ratings.reduce((total, rating) => total + rating, 0) / ratings.length,
    count: ratings.length,
    max: Math.max(...ratings)
  };
}

function sortSkills(skills: SkillCard[], sortKey: SourceSortKey): SkillCard[] {
  if (sortKey !== "rating") return skills;
  return [...skills].sort((left, right) => {
    const ratingCompare = normalizedSkillRating(right) - normalizedSkillRating(left);
    return (
      ratingCompare ||
      left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" })
    );
  });
}

function healthRank(source: SourceCard) {
  const ranks: Record<string, number> = { error: 0, warn: 1, info: 2, ok: 3 };
  return ranks[source.health] ?? 4;
}

function dateValue(value?: string) {
  if (!value) return 0;
  if (/^\d+$/.test(value)) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? (value.length > 16 ? Math.floor(numeric / 1_000_000) : numeric) : 0;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function applySkillDraft(skill: SkillCard, draft?: SkillDraft): SkillCard {
  if (!draft) return skill;
  return {
    ...skill,
    category: draft.category.trim() || skill.category,
    description: draft.description.trim() || skill.description,
    name: draft.name.trim() || skill.name,
    note: draft.note.trim() || skill.note,
    tags: parseTagInput(draft.tags)
  };
}

function applySourceDraft(source: SourceCard, draft?: SourceDraft): SourceCard {
  if (!draft) return source;
  return {
    ...source,
    categoryId: draft.category.trim() || source.categoryId,
    enabled: draft.enabled,
    name: draft.name.trim() || source.name,
    note: draft.note.trim() || source.note,
    sourceType: draft.sourceType,
    tags: parseTagInput(draft.tags)
  };
}

function normalizeSourcePath(path: string) {
  return path.trim().replace(/[\\/]+/g, "/").replace(/\/+$/g, "").toLowerCase();
}

function skillBelongsToSource(skill: SkillCard, source: SourceCard): boolean {
  const sourceKey = normalizeLookup(source.name);
  const skillSource = normalizeLookup(skill.source);
  if (sourceKey && skillSource === sourceKey) return true;
  const sourcePath = normalizeSourcePath(source.localPath);
  const skillPath = normalizeSourcePath(skill.relativePath);
  const skillPathSegments = skillPath.split("/").filter(Boolean);
  const sourceFolder = sourcePath.split("/").filter(Boolean).pop() ?? "";
  if (sourceFolder && skillPathSegments.includes(sourceFolder)) return true;
  const sourceUrlName = normalizeLookup((source.url.split("/").pop() ?? "").replace(/\.git$/i, ""));
  return Boolean(sourceUrlName && (skillSource === sourceUrlName || skillPathSegments.includes(sourceUrlName)));
}

function normalizeLookup(value: string) {
  return value.trim().toLowerCase().replace(/[_\s]+/g, "-");
}

function conflictAliasName(sourceName: string, childName: string) {
  const normalized = normalizeLookup(`${sourceName}-${childName}`)
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return normalized || "conflict-skill";
}

function clampNumber(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function isRouterHubSkill(skill: SkillCard): boolean {
  if (typeof skill.isRouterHub === "boolean") return skill.isRouterHub;
  const description = String(skill.description || "");
  if (description.indexOf("[ROUTER-HUB]") !== -1) return true;
  const source = String(skill.source || skill.relativePath || "");
  if (source.indexOf("AI-SkillHub-local-routers") !== -1) return true;
  if (skill.folderName && skill.source && normalizeLookup(skill.folderName) === normalizeLookup(skill.source)) {
    return true;
  }
  return false;
}

function cleanSkillDescription(value: string | undefined | null) {
  if (!value) return "";
  return String(value).replace(/^\s*\[(?:ROUTER-HUB|CHILD-SKILL)\]\s*/i, "").trim();
}

function skillVisualCategory(skill: SkillCard) {
  const raw = normalizeLookup(skill.category || "");
  if (raw && !["auto", "general", "local"].includes(raw)) return raw;
  const inferred = inferCategoryIds(
    [skill.name, skill.source, skill.description, skill.tags.join(" ")].filter(Boolean).join(" ")
  );
  return inferred[0] ?? "general";
}

type SkillGraphNodeKind = "source" | "skill";
type SkillGraphNode = {
  category: string;
  enabled: boolean;
  groupIndex: number;
  hue: number;
  id: string;
  itemCount: number;
  itemIndex: number;
  kind: SkillGraphNodeKind;
  label: string;
  parentIndex: number;
  router: boolean;
  seed: number;
  skill?: SkillCard;
  source?: SourceCard;
};
type SkillGraphEdge = { hue: number; sourceIndex: number; targetIndex: number };
type SkillGraphData = { edges: SkillGraphEdge[]; nodes: SkillGraphNode[]; sourceCount: number };
type SkillGraphHitNode = SkillGraphNode & { radius: number; screenX: number; screenY: number };
type SkillGraphRuntime = {
  dragged: boolean;
  dragging: boolean;
  dragStartX: number;
  dragStartY: number;
  hitNodes: SkillGraphHitNode[];
  hoverId: string;
  panX: number;
  panY: number;
  pointerX: number;
  pointerY: number;
};

function buildSkillGraphData(skills: SkillCard[], sources: SourceCard[]): SkillGraphData {
  const sourceCategories = buildSourceCategoryLookup(sources);
  const groups = new Map<string, SkillCard[]>();
  for (const skill of skills) {
    const category = skillGraphCategory(skill, sourceCategories);
    groups.set(category, [...(groups.get(category) ?? []), skill]);
  }

  const orderedGroups = [...groups.entries()]
    .map(([category, bucket]) => ({
      category,
      id: `category-${normalizeLookup(category)}`,
      label: displayCategoryName(category),
      skills: bucket.sort((left, right) => left.name.localeCompare(right.name))
    }))
    .sort((left, right) => right.skills.length - left.skills.length || left.label.localeCompare(right.label));

  const nodes: SkillGraphNode[] = [];
  orderedGroups.forEach((group, groupIndex) => {
    const category = group.category || "general";
    const sourceIndex = nodes.length;
    nodes.push({
      category,
      enabled: true,
      groupIndex,
      hue: skillCategoryHue(category),
      id: `source-${group.id}`,
      itemCount: group.skills.length,
      itemIndex: groupIndex,
      kind: "source",
      label: group.label,
      parentIndex: -1,
      router: false,
      seed: stableSkillHash(group.id)
    });
    group.skills.forEach((skill, itemIndex) => {
      const skillCategory = skillVisualCategory(skill);
      nodes.push({
        category: skillCategory,
        enabled: skill.enabled,
        groupIndex,
        hue: skillCategoryHue(skillCategory),
        id: `skill-${skillGraphSkillId(skill)}`,
        itemCount: group.skills.length,
        itemIndex,
        kind: "skill",
        label: `/${skill.name}`,
        parentIndex: sourceIndex,
        router: isRouterHubSkill(skill),
        seed: stableSkillHash(`${skill.folderName}:${skill.relativePath}:${itemIndex}`),
        skill
      });
    });
  });

  return { edges: [], nodes, sourceCount: orderedGroups.length };
}

function skillGraphSkillId(skill: SkillCard) {
  return `${skill.folderName}::${skill.relativePath || skill.name}`;
}

function buildSourceCategoryLookup(sources: SourceCard[]) {
  const sourceCategories = new Map<string, string>();
  for (const source of sources) {
    const category = source.categoryId || "general";
    sourceCategories.set(normalizeLookup(source.name), category);
    const sourceUrlName = normalizeLookup((source.url.split("/").pop() ?? "").replace(/\.git$/i, ""));
    if (sourceUrlName) sourceCategories.set(sourceUrlName, category);
  }
  return sourceCategories;
}

function skillGraphCategory(skill: SkillCard, sourceCategories: Map<string, string>) {
  const sourceCategory = sourceCategories.get(normalizeLookup(skill.source));
  return sourceCategory && sourceCategory !== "auto" ? sourceCategory : skillVisualCategory(skill);
}

function drawSkillGraph(
  context: CanvasRenderingContext2D,
  graph: SkillGraphData,
  runtime: SkillGraphRuntime,
  width: number,
  height: number,
  time: number
) {
  const styles = getComputedStyle(context.canvas);
  const textColor = styles.getPropertyValue("--text").trim() || "#191426";
  const mutedColor = styles.getPropertyValue("--text-muted").trim() || "rgba(110, 102, 130, .76)";
  const surfaceColor = styles.getPropertyValue("--surface").trim() || "rgba(255, 255, 255, .9)";
  const clusterNodes = graph.nodes.filter(node => node.kind === "source");
  const sourcePositions = new Map<number, { radius: number; x: number; y: number }>();
  const nodePositions = new Map<number, SkillGraphHitNode>();
  runtime.hitNodes = [];

  context.save();

  const columns = skillGraphColumns(clusterNodes.length, width);
  const rows = Math.max(1, Math.ceil(clusterNodes.length / columns));
  const paddingX = 26;
  const plotTop = 58;
  const plotBottom = 72;
  const plotWidth = Math.max(1, width - paddingX * 2);
  const plotHeight = Math.max(1, height - plotTop - plotBottom);
  const cellWidth = plotWidth / columns;
  const cellHeight = plotHeight / rows;

  graph.nodes.forEach((node, index) => {
    if (node.kind !== "source") return;
    const column = node.itemIndex % columns;
    const row = Math.floor(node.itemIndex / columns);
    const drift = Math.sin(time * 0.00016 + node.seed * 0.01) * 3.5;
    const x = paddingX + cellWidth * (column + 0.5) + runtime.panX * 0.28 + drift;
    const y = plotTop + cellHeight * (row + 0.5) + runtime.panY * 0.28 + drift * 0.35;
    const radius = clampNumber(Math.min(cellWidth, cellHeight) * 0.34, 34, 68);
    const highlighted = runtime.hoverId === node.id;
    const haloRadius = radius + (highlighted ? 14 : 10);

    context.beginPath();
    context.arc(x, y, haloRadius, 0, Math.PI * 2);
    context.fillStyle = `hsla(${node.hue}, 84%, 60%, ${highlighted ? 0.16 : 0.075})`;
    context.fill();
    context.strokeStyle = `hsla(${node.hue}, 80%, 56%, ${highlighted ? 0.42 : 0.22})`;
    context.lineWidth = highlighted ? 1.6 : 1;
    context.stroke();

    context.beginPath();
    context.arc(x, y, 4.5, 0, Math.PI * 2);
    context.fillStyle = `hsla(${node.hue}, 82%, 56%, .86)`;
    context.shadowBlur = highlighted ? 18 : 10;
    context.shadowColor = `hsla(${node.hue}, 82%, 58%, .34)`;
    context.fill();
    context.shadowBlur = 0;

    const countLabel = `${node.label} · ${node.itemCount}`;
    drawGraphText(context, countLabel, x - radius, y - haloRadius - 12, textColor, radius * 2 + 22);

    const hitNode = { ...node, radius: haloRadius, screenX: x, screenY: y };
    sourcePositions.set(index, { radius, x, y });
    nodePositions.set(index, hitNode);
  });

  graph.nodes.forEach((node, index) => {
    if (node.kind !== "skill") return;
    const parent = sourcePositions.get(node.parentIndex) ?? { radius: 48, x: width / 2, y: height / 2 };
    const goldenAngle = Math.PI * (3 - Math.sqrt(5));
    const normalized = (node.itemIndex + 0.5) / Math.max(1, node.itemCount);
    const angle =
      node.itemIndex * goldenAngle +
      (node.seed % 360) * (Math.PI / 180) +
      Math.sin(time * 0.00012 + node.seed) * 0.045;
    const spread = Math.sqrt(normalized) * parent.radius * 0.88;
    const x = parent.x + Math.cos(angle) * spread;
    const y = parent.y + Math.sin(angle) * spread * 0.82;
    const dotSize = node.itemCount > 120 ? 2.1 : node.itemCount > 80 ? 2.5 : node.itemCount > 45 ? 3 : 3.7;
    const radius = node.router ? dotSize + 1.4 : dotSize + (node.seed % 3) * 0.18;
    const hitNode = { ...node, radius: radius + 6, screenX: x, screenY: y };
    nodePositions.set(index, hitNode);
  });

  for (const [index, node] of nodePositions) {
    if (node.kind === "source") continue;
    const highlighted = runtime.hoverId === node.id;
    const clusterHighlighted = runtime.hoverId === graph.nodes[node.parentIndex]?.id;
    const alpha = node.enabled ? (highlighted ? 1 : clusterHighlighted ? 0.92 : 0.72) : 0.3;
    context.beginPath();
    context.arc(node.screenX, node.screenY, node.radius - 6, 0, Math.PI * 2);
    context.fillStyle = `hsla(${node.hue}, 86%, 60%, ${alpha})`;
    context.shadowBlur = highlighted ? 16 : node.router ? 10 : 4;
    context.shadowColor = `hsla(${node.hue}, 86%, 58%, .48)`;
    context.fill();
    context.shadowBlur = 0;
    if (node.router) {
      context.beginPath();
      context.arc(node.screenX, node.screenY, node.radius - 2, 0, Math.PI * 2);
      context.strokeStyle = `hsla(${node.hue}, 86%, 72%, .34)`;
      context.lineWidth = 1;
      context.stroke();
    }
    runtime.hitNodes.push(node);
    nodePositions.set(index, node);
  }

  for (const [index, node] of nodePositions) {
    if (node.kind !== "source") continue;
    runtime.hitNodes.push(node);
    nodePositions.set(index, node);
  }

  const hovered = runtime.hoverId
    ? runtime.hitNodes.find(node => node.id === runtime.hoverId)
    : undefined;
  if (hovered) {
    drawGraphTooltip(context, hovered, textColor, mutedColor, surfaceColor, width, height);
  }
  context.restore();
}

function skillGraphColumns(count: number, width: number) {
  if (count <= 1) return 1;
  if (width < 620) return Math.min(2, count);
  if (count <= 4) return count;
  if (count <= 9) return 3;
  return 4;
}

function drawGraphText(
  context: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  color: string,
  maxWidth: number
) {
  context.save();
  context.font = "700 11px Inter, system-ui, sans-serif";
  context.fillStyle = color;
  context.textBaseline = "middle";
  context.fillText(truncateCanvasText(context, text, maxWidth), x, y);
  context.restore();
}

function drawGraphTooltip(
  context: CanvasRenderingContext2D,
  node: SkillGraphHitNode,
  textColor: string,
  mutedColor: string,
  surfaceColor: string,
  width: number,
  height: number
) {
  const title = node.label;
  const subtitle = node.skill
    ? cleanSkillDescription(node.skill.description) || displayCategoryName(node.category)
    : t("lib.skillsTotal", { n: node.itemCount });
  context.save();
  context.font = "800 12px Inter, system-ui, sans-serif";
  const titleWidth = context.measureText(title).width;
  context.font = "600 10.5px Inter, system-ui, sans-serif";
  const subtitleWidth = context.measureText(subtitle).width;
  const boxWidth = clampNumber(Math.max(titleWidth, subtitleWidth) + 24, 120, Math.min(260, width - 24));
  const boxHeight = 54;
  const x = clampNumber(node.screenX + 16, 12, width - boxWidth - 12);
  const y = clampNumber(node.screenY - boxHeight - 14, 12, height - boxHeight - 12);
  context.fillStyle = surfaceColor;
  context.strokeStyle = `hsla(${node.hue}, 76%, 62%, .32)`;
  context.lineWidth = 1;
  roundedCanvasRect(context, x, y, boxWidth, boxHeight, 12);
  context.fill();
  context.stroke();
  context.fillStyle = textColor;
  context.font = "800 12px Inter, system-ui, sans-serif";
  context.fillText(truncateCanvasText(context, title, boxWidth - 24), x + 12, y + 20);
  context.fillStyle = mutedColor;
  context.font = "600 10.5px Inter, system-ui, sans-serif";
  context.fillText(truncateCanvasText(context, subtitle, boxWidth - 24), x + 12, y + 38);
  context.restore();
}

function roundedCanvasRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
) {
  context.beginPath();
  context.moveTo(x + radius, y);
  context.arcTo(x + width, y, x + width, y + height, radius);
  context.arcTo(x + width, y + height, x, y + height, radius);
  context.arcTo(x, y + height, x, y, radius);
  context.arcTo(x, y, x + width, y, radius);
  context.closePath();
}

function truncateCanvasText(context: CanvasRenderingContext2D, text: string, maxWidth: number) {
  if (context.measureText(text).width <= maxWidth) return text;
  let clipped = text;
  while (clipped.length > 4 && context.measureText(`${clipped}...`).width > maxWidth) {
    clipped = clipped.slice(0, -1);
  }
  return `${clipped}...`;
}

function findGraphHit(runtime: SkillGraphRuntime, x: number, y: number) {
  for (let index = runtime.hitNodes.length - 1; index >= 0; index -= 1) {
    const node = runtime.hitNodes[index];
    const distance = Math.hypot(node.screenX - x, node.screenY - y);
    if (distance <= node.radius) return node;
  }
  return null;
}

function buildConstellationLegend(skills: SkillCard[], sources: SourceCard[]) {
  const sourceCategories = buildSourceCategoryLookup(sources);
  const counts = new Map<string, number>();
  for (const skill of skills) {
    const category = skillGraphCategory(skill, sourceCategories);
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([leftCategory, leftCount], [rightCategory, rightCount]) => {
      return rightCount - leftCount || displayCategoryName(leftCategory).localeCompare(displayCategoryName(rightCategory));
    })
    .slice(0, 7)
    .map(([category, count]) => ({
      category,
      count,
      hue: skillCategoryHue(category),
      label: `${displayCategoryName(category)} · ${count}`
    }));
}

function skillCategoryHue(category: string) {
  const id = normalizeLookup(category);
  const fixedHue = CATEGORY_HUES[id];
  if (typeof fixedHue === "number") return fixedHue;
  const hash = stableSkillHash(id || category);
  return (hash * 47 + 162) % 360;
}

const CATEGORY_HUES: Record<string, number> = {
  "academic-writing": 214,
  "agent-tools": 248,
  "browser-automation": 268,
  "clinical-medical": 358,
  "data-analysis": 190,
  "development": 226,
  "document-tools": 18,
  "finance-economics": 58,
  "general": 72,
  "image-generation": 326,
  "knowledge-retrieval": 136,
  "life-sciences": 108,
  "literature-research": 174,
  "presentation": 28,
  "presentations": 28,
  "prompt-polishing": 346,
  "scientific-figures": 46,
  "security": 8,
  "security-audit": 8,
  "ui-design": 292
};

function stableSkillHash(value: string) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash;
}

function inferCategoryIds(input: string): string[] {
  const text = normalizeSearch(input);
  const matches: string[] = [];
  for (const id of CATEGORY_IDS) {
    const keywords = [id, ...(CATEGORY_KEYWORDS[id] ?? [])].map(normalizeSearch);
    if (keywords.some(keyword => text.includes(keyword))) matches.push(id);
  }
  return matches.length > 0 ? Array.from(new Set(matches)).slice(0, 4) : ["general"];
}

function categoryIdForSourceType(sourceType: SourceCard["sourceType"]) {
  if (sourceType === "prompt") return "prompt-polishing";
  if (sourceType === "mixed") return "general";
  return "agent-tools";
}

function displayCategoryName(category: string) {
  const id = category.trim().toLowerCase();
  return categoryName(id) ?? category;
}

function categoryToneId(category: string): string {
  const value = (category || "").toLowerCase();
  if (value.includes("security") || value.includes("vibesec")) return "security";
  if (value.includes("design") || value.includes("ui") || value.includes("image")) return "design";
  if (value.includes("figure") || value.includes("chart") || value.includes("data")) return "figure";
  if (value.includes("presentation") || value.includes("ppt") || value.includes("slide")) return "presentation";
  if (value.includes("knowledge") || value.includes("retrieval") || value.includes("zotero") || value.includes("search")) return "knowledge";
  if (value.includes("research") || value.includes("paper") || value.includes("academic") || value.includes("literature") || value.includes("writing")) return "academic";
  if (value.includes("agent") || value.includes("automation") || value.includes("workflow") || value.includes("development") || value.includes("dev") || value.includes("browser")) return "agent";
  if (value.includes("prompt")) return "prompt";
  return "surface";
}

function skillTone(category: string): string {
  return categoryToneId(category);
}

function skillIcon(category: string): IconName {
  const value = (category || "").toLowerCase();
  if (value.includes("design") || value.includes("ui")) return "sparkle";
  if (value.includes("research") || value.includes("writing") || value.includes("paper")) return "library";
  if (value.includes("figure") || value.includes("data")) return "dashboard";
  if (value.includes("security")) return "shield";
  if (value.includes("presentation") || value.includes("ppt") || value.includes("slide")) return "snapshots";
  if (value.includes("knowledge") || value.includes("retrieval") || value.includes("zotero") || value.includes("search")) return "search";
  if (value.includes("prompt")) return "list";
  if (value.includes("development") || value.includes("dev")) return "workspaces";
  if (value.includes("agent")) return "agent";
  return "sparkle";
}

function sourceTypeTone(sourceType: SourceCard["sourceType"], _category: string): string {
  if (sourceType === "prompt") return "prompt";
  if (sourceType === "mixed") return "other";
  return "skill";
}

function sourceTypeIcon(sourceType: SourceCard["sourceType"]): IconName {
  if (sourceType === "prompt") return "list";
  if (sourceType === "mixed") return "sources";
  return "library";
}

function statusDotClass(health: string) {
  if (health === "ok") return "healthy";
  if (health === "error") return "error";
  return "syncing";
}

function skillStatusLabel(health: string) {
  if (health === "ok") return t("health.ok");
  if (health === "warn") return t("health.warn");
  if (health === "error") return t("health.error");
  if (health === "info") return t("health.info");
  return health;
}

function agentSkillStatusTone(status: string) {
  if (status === "installed") return "ok";
  if (status === "missing") return "danger";
  if (status === "agent-disabled") return "warn";
  return "info";
}

function agentSkillStatusLabel(status: string) {
  if (status === "installed") return t("agentSkill.installed");
  if (status === "missing") return t("agentSkill.missing");
  if (status === "agent-disabled") return t("agentSkill.disabled");
  if (status === "agent-missing") return t("agentSkill.notDetected");
  return status;
}

function compactAgentName(name: string) {
  const normalized = name.toLowerCase();
  if (normalized.includes("claude")) return "Claude";
  if (normalized.includes("codex")) return "Codex";
  if (normalized.includes("antigravity")) return "Antigravity";
  return name.replace(/\s+code$/i, "").trim();
}

function sourceTypeLabel(sourceType: string) {
  if (sourceType === "skill") return t("type.skill");
  if (sourceType === "prompt") return t("type.prompt");
  if (sourceType === "mixed") return t("type.mixed");
  return sourceType;
}

function scopeLabel(scope: string) {
  if (scope === "global") return t("scope.global");
  if (scope === "agent") return t("scope.agent");
  if (scope === "project") return t("scope.project");
  return scope;
}

function adapterStatusLabel(status: string) {
  if (status === "ready") return t("agents.statusReady");
  if (status === "detected-unmanaged") return t("agents.statusUnmanaged");
  return t("agents.statusMissing");
}

function doctorVerdictLabel(verdict: string) {
  if (verdict === "ready") return t("doctor.ready");
  if (verdict === "code-detected") return t("doctor.codeDetected");
  if (verdict === "desktop-only") return t("doctor.desktopOnly");
  if (verdict === "path-refresh-needed") return t("doctor.pathRefresh");
  if (verdict === "directory-residue") return t("doctor.directoryResidue");
  return t("doctor.notDetected");
}

function doctorStatusLabel(status: string) {
  const key = `doctor.status.${status}`;
  const translated = t(key);
  return translated === key ? status : translated;
}

function capabilityLabel(key: string) {
  if (key === "global-scope") return t("agents.capGlobal");
  if (key === "project-scope") return t("agents.capProject");
  if (key === "copy-fallback") return t("agents.capCopy");
  if (key === "instructions-generation") return t("agents.capInstructions");
  return key;
}

function isInternalRouterSource(source: SourceCard) {
  return source.name.trim().toLowerCase() === "ai-skillhub-local-routers" && !source.url.trim();
}

function sourcePopularityDisplayName(source: Pick<SourcePopularityCard, "owner" | "repo" | "sourceName">) {
  const repoName = [source.owner, source.repo].filter(Boolean).join("/");
  const sourceName = source.sourceName?.trim();
  if (!sourceName) return repoName || source.repo || "unknown-source";
  if (repoName && (sourceName === source.repo || sourceName.toLowerCase() === "skills")) return repoName;
  return sourceName;
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

function heatLevel(value: number, max: number) {
  if (value <= 0 || max <= 0) return 0;
  const ratio = value / max;
  if (ratio >= 0.86) return 6;
  if (ratio >= 0.68) return 5;
  if (ratio >= 0.5) return 4;
  if (ratio >= 0.32) return 3;
  if (ratio >= 0.16) return 2;
  return 1;
}

function formatScanTime(value: string) {
  if (!value) return "—";
  if (/^\d{16,}$/.test(value)) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString();
}

function formatCompactNumber(value: number) {
  if (!Number.isFinite(value)) return "0";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}K`;
  return String(Math.max(0, Math.round(value)));
}

function shortRevision(value?: string) {
  return (value ?? "").trim().slice(0, 8);
}

function qualityFactorLabel(key: string, fallback: string) {
  const translationKey = `quality.factor.${key}`;
  const translated = t(translationKey);
  return translated === translationKey ? fallback : translated;
}

function formatFileSize(value: number) {
  const bytes = Math.max(0, Number.isFinite(value) ? value : 0);
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let scaled = bytes / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && scaled >= 1024; index += 1) {
    scaled /= 1024;
    unit = units[index];
  }
  return `${scaled >= 100 ? scaled.toFixed(0) : scaled >= 10 ? scaled.toFixed(1) : scaled.toFixed(2)} ${unit}`;
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

function countByStatus(items: Array<{ status: string }>, status: string) {
  return items.filter(item => item.status === status).length;
}

function auditEventLabel(eventType: string) {
  if (eventType === "legacy_scan_indexed") return "Index refresh";
  if (eventType === "skill_metadata_updated") return "Skill metadata";
  if (eventType === "skill_enabled_updated") return "Skill state";
  if (eventType === "source_metadata_updated") return "Source metadata";
  if (eventType === "usage_recorded") return "Usage recorded";
  if (eventType === "state_updated") return "State updated";
  if (eventType === "desktop_qa_updated") return "Desktop QA";
  if (eventType === "operation_runner_completed") return "Runner completed";
  return eventType;
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

function conflictStatusLabel(status: string) {
  if (status === "default-set") return t("conf.statusDefault");
  if (status === "auto-set") return t("conf.statusAuto");
  if (status === "ignored") return t("conf.statusIgnored");
  return t("conf.statusPending");
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

function routerHubUnchangedCount(report: RouterHubReport) {
  return report.unchangedCount ?? report.plans.filter(plan => plan.status === "unchanged").length;
}

function routerHubCommitMessage(report: RouterHubReport) {
  const unchanged = routerHubUnchangedCount(report);
  const skipped = report.skippedCount;
  const duplicateCount = report.duplicateChildren.length;
  const warningCount = report.healthWarnings.length;
  const suffixParts = [
    skipped > 0 ? t("router.suffixSkipped", { n: skipped }) : "",
    duplicateCount > 0 ? t("router.suffixDuplicates", { n: duplicateCount }) : "",
    warningCount > 0 ? t("router.suffixWarnings", { n: warningCount }) : ""
  ].filter(Boolean);
  const suffix = suffixParts.length > 0 ? `; ${suffixParts.join(", ")}` : "";
  if (report.writtenCount === 0 && unchanged > 0) {
    return t("router.commitFresh", { unchanged, suffix });
  }
  return t("router.commitDone", { written: report.writtenCount, unchanged, suffix });
}

async function copyTextToClipboard(text: string, successMessage: string) {
  if (!text.trim()) {
    showUiToast(t("toast.noPath"), "warn");
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    showUiToast(successMessage, "ok");
  } catch {
    showUiToast(t("toast.copyManual"), "warn");
  }
}

function waitFor(milliseconds: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, milliseconds));
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

async function copySkillPrompt(
  skill: SkillCard,
  onRecordUsage?: (
    targetType: string,
    targetId: string,
    targetName: string,
    sourceName: string,
    eventType: string
  ) => Promise<void>
) {
  const context = cleanSkillDescription(skill.description) || displayCategoryName(skill.category) || t("copy.fallbackContext");
  const text = t("copy.template", { name: skill.name, context });
  try {
    await navigator.clipboard.writeText(text);
    showUiToast(t("toast.copied"), "ok");
  } catch {
    showUiToast(t("toast.copyBlocked"), "warn");
  }
  await onRecordUsage?.("skill", skill.folderName, skill.name, skill.source, "copy_prompt");
}
