import { invoke } from "@tauri-apps/api/core";
import { type CSSProperties, Fragment, useEffect, useMemo, useState } from "react";
import { Icon, type IconName } from "./icons";
import { CountUp, ParticleField, useCardGlow } from "./effects";
import { LANG_OPTIONS, type Lang, categoryName, getLang, initialLang, setLang, t } from "./i18n";
import {
  createPreviewSnapshot,
  createPreviewSourceImportExecution,
  createPreviewSourceImportPlan,
  createPreviewSourceImportPromotion,
  updatePreviewDesktopQaStatus,
  updatePreviewEnabled,
  updatePreviewOperationRunner,
  updatePreviewPresetDistribution,
  updatePreviewRealWriteAuthorization
} from "./preview";
import type {
  AgentSkillStatusCard,
  DesktopQaCheckCard,
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
  SourcePopularityCard,
  WorkspaceCard
} from "./types";

/* =============================================================
   Types and constants
   ============================================================= */

type ThemeName = "dark" | "light" | "classic-dark" | "classic-light";

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
type ImportFeedbackOptions = { quiet?: boolean };
type OperationStatus = { title: string; detail: string; step: number; total: number; percent: number };
type SourceSortKey = "recent" | "usage" | "heat" | "skillCount" | "health" | "name";
type ToastTone = "info" | "ok" | "warn" | "error";

const TOAST_EVENT = "ai-skillhub-toast";
const THEME_OPTIONS: Array<{ icon: IconName; labelKey: string; value: ThemeName }> = [
  { value: "dark", labelKey: "theme.dark", icon: "moon" },
  { value: "light", labelKey: "theme.light", icon: "sun" },
  { value: "classic-dark", labelKey: "theme.classicDark", icon: "sparkle" },
  { value: "classic-light", labelKey: "theme.classicLight", icon: "sparkle" }
];
const NAV_ITEMS: Array<{ key: NavKey; icon: IconName }> = [
  { key: "dashboard", icon: "dashboard" },
  { key: "library", icon: "library" },
  { key: "workspaces", icon: "workspaces" },
  { key: "presets", icon: "list" },
  { key: "agents", icon: "agent" }
];
const ADVANCED_NAV: NavKey[] = ["release", "snapshots"];
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
  const [snapshot, setSnapshot] = useState<LegacySnapshot | null>(null);
  const [loadError, setLoadError] = useState("");
  const [loading, setLoading] = useState(true);
  const [operation, setOperation] = useState<OperationStatus | null>(null);
  const [toast, setToast] = useState<{ message: string; tone: ToastTone } | null>(null);
  const [globalSearch, setGlobalSearch] = useState("");
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

  function toastMessage(message: string, tone: ToastTone = "info") {
    setToast({ message, tone });
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
      setSnapshot(result);
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

  async function updatePresetDistribution(presetId: string, workspaceId: string, enabled: boolean) {
    setLoading(true);
    try {
      if (!runtimeAvailable) {
        setSnapshot(prev =>
          updatePreviewPresetDistribution(prev ?? createPreviewSnapshot(), presetId, workspaceId, enabled)
        );
        toastMessage(t("toast.previewToggleSim"), "info");
        return;
      }
      const result = await invoke<LegacySnapshot>("set_preset_workspace_enabled", {
        presetId,
        workspaceId,
        enabled
      });
      setSnapshot(result);
      setLoadError("");
      toastMessage(enabled ? t("preset.toastOn") : t("preset.toastOff"), "ok");
    } catch (error) {
      setLoadError(messageFromError(error));
      toastMessage(t("preset.toastFailed"), "error");
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
      setSnapshot(result);
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

  async function syncAndRefreshAll(): Promise<LegacySnapshot | null> {
    if (operation) {
      toastMessage(t("toast.syncBusy"), "warn");
      return snapshot;
    }
    setOperation({ title: t("op.syncTitle"), detail: t("op.step1"), step: 1, total: 3, percent: 8 });
    const refreshed = await loadSnapshot("refresh", { background: true, quiet: true });
    if (!runtimeAvailable) {
      setOperation(null);
      return refreshed;
    }
    setOperation({ title: t("op.syncTitle"), detail: t("op.step2"), step: 2, total: 3, percent: 42 });
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
    const result = await invoke<SourceImportExecutionCard>("stage_source_import_candidate", {
      importKind,
      input
    });
    if (!options.quiet) toastMessage(result.status === "staged" ? t("toast.staged") : t("toast.stageDone"), "info");
    return result;
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
      sourceName
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
    document.body.dataset.theme = theme;
    window.localStorage.setItem("ai-skillhub-theme", theme);
  }, [theme]);

  useEffect(() => {
    document.documentElement.lang = lang === "zh" ? "zh-CN" : lang === "ko" ? "ko" : "en";
  }, [lang]);

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
    if (!operation || operation.percent >= 100) return;
    const timer = window.setInterval(() => {
      setOperation(current => {
        if (!current || current.percent >= 100) return current;
        const phaseEnd = Math.min(96, (current.step / current.total) * 100 - 3);
        if (current.percent >= phaseEnd) return current;
        return { ...current, percent: Math.min(phaseEnd, current.percent + 2) };
      });
    }, 520);
    return () => window.clearInterval(timer);
  }, [operation?.step, operation?.total]);

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

  return (
    <main className={`${runtimeAvailable ? "shell" : "shell browser-preview-shell"} theme-${theme} lang-${lang}`}>
      <aside className="sidebar">
        <div className="brand">
          <img alt="AI SkillHub" className="brand-logo" src="/ai-skillhub-logo.png" />
          <div>
            <strong>AI SkillHub</strong>
            <span>{t("app.subtitle")}</span>
          </div>
        </div>

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
              className="primary-pill"
              disabled={loading || Boolean(operation)}
              onClick={() => void syncAndRefreshAll()}
              type="button"
            >
              <Icon name="refresh" />
              <span>
                {runtimeAvailable
                  ? operation
                    ? t("topbar.backgroundSync")
                    : loading
                      ? t("topbar.syncing")
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
              loading={loading}
              onCopySkill={skill => void copySkillPrompt(skill, recordUsage)}
              onOpenAdvanced={() => setActive("release")}
              onOpenAgents={() => setActive("agents")}
              onOpenLibrary={() => setActive("library")}
              onRefreshPopularity={() => void refreshSourcePopularity()}
              onSync={() => void syncAndRefreshAll()}
              snapshot={snapshot}
              summary={summary}
              theme={theme}
            />
          )}
          {active === "library" && (
            <Library
              loading={loading}
              onBulkSaveMetadata={async () => "preview"}
              onDeleteSource={deleteSource}
              onPreviewImport={previewSourceImportCandidate}
              onStageImport={stageSourceImportCandidate}
              onPromoteImport={promoteStagedSourceImport}
              onRefreshIndex={() => syncAndRefreshAll()}
              onRecordUsage={recordUsage}
              onSaveSkillMetadata={updateSkillMetadata}
              onSaveSourceMetadata={updateSourceMetadata}
              onSetSkillConflictChoice={updateSkillConflictChoice}
              onSetSkillEnabled={updateSkillEnabled}
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
              onToggleDistribution={updatePresetDistribution}
              snapshot={snapshot}
            />
          )}
          {active === "agents" && (
            <Agents
              disabled={loading}
              onRefreshAgents={() => void refreshLocalAgents()}
              onToggle={updateEnabled}
              snapshot={snapshot}
            />
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
              currentLang={lang}
              currentTheme={theme}
              disabled={loading}
              onChangeLang={changeLang}
              onChangeTheme={changeTheme}
              onOpenAdvanced={() => setActive("release")}
              onQaStatus={updateDesktopQaStatus}
              snapshot={snapshot}
            />
          )}
        </div>

        {toast && (
          <div className={`toast tone-${toast.tone} is-visible`} role="status">
            <Icon name={toast.tone === "error" ? "alert" : toast.tone === "ok" ? "sparkle" : "info"} />
            <span>{toast.message}</span>
          </div>
        )}
      </section>
    </main>
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

function Dashboard({
  loading,
  onCopySkill,
  onOpenAdvanced,
  onOpenAgents,
  onOpenLibrary,
  onRefreshPopularity,
  onSync,
  snapshot,
  summary,
  theme
}: {
  loading: boolean;
  onCopySkill: (skill: SkillCard) => void;
  onOpenAdvanced: () => void;
  onOpenAgents: () => void;
  onOpenLibrary: () => void;
  onRefreshPopularity: () => void;
  onSync: () => void;
  snapshot: LegacySnapshot | null;
  summary: LegacySummary;
  theme: ThemeName;
}) {
  const backupBlocked = countByStatus(snapshot?.backupDryRun ?? [], "blocked");
  const restoreBlocked = countByStatus(snapshot?.restoreDryRun ?? [], "blocked");
  const lockedRollback = (snapshot?.rollbackPlan ?? []).filter(step => step.status === "locked").length;
  const healthIssues = summary.warnings + backupBlocked + restoreBlocked + lockedRollback;
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
  const accent = theme === "dark" ? "#bebaff" : "#6c6fc3";

  return (
    <div className="view dashboard-view">
      <section className="dashboard-hero glow-card">
        <ParticleField accent={accent} />
        <div className="dashboard-hero-inner">
          <div>
            <span className="eyebrow"><Icon name="sparkle" /> AI SkillHub · 2.0</span>
            <h2>{t("dash.title")}</h2>
            <p>{t("dash.subtitle")}</p>
          </div>
          <div className="hero-actions">
            <button className="secondary-action" disabled={loading} onClick={onSync} type="button">
              <Icon name="refresh" /> {loading ? t("dash.syncing") : t("dash.sync")}
            </button>
            <button className="primary-action" onClick={onOpenLibrary} type="button">
              <Icon name="add" /> {t("dash.addSource")}
            </button>
          </div>
        </div>
      </section>

      <section className="metric-grid">
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
      </section>

      <SkillShowcase
        loading={loading}
        onCopySkill={onCopySkill}
        onOpenLibrary={onOpenLibrary}
        snapshot={snapshot}
      />

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
  const showcaseSkills = useMemo(() => {
    const enabled = skills.filter(skill => skill.enabled);
    return (enabled.length > 0 ? enabled : skills).slice(0, 18);
  }, [skills]);

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
        <div className="skill-showcase-grid">
          {showcaseSkills.map((skill, index) => (
            <button
              className={`skill-chip glow-card tone-${skillTone(skill.category)}`}
              key={skill.folderName}
              onClick={() => onCopySkill(skill)}
              style={{ "--enter-delay": `${index * 40}ms` } as CSSProperties}
              type="button"
              title={cleanSkillDescription(skill.description)}
            >
              <span className="skill-chip-icon" aria-hidden="true"><Icon name={skillIcon(skill.category)} /></span>
              <span className="skill-chip-main">
                <strong>/{skill.name}</strong>
                <small>{displayCategoryName(skill.category) || skill.source}</small>
              </span>
              <span className="skill-chip-copy" aria-hidden="true"><Icon name="copy" /></span>
            </button>
          ))}
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
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  }, [range, skills, usageStats]);

  const rankedSources = sourcePopularity
    .map(source => ({ name: sourcePopularityDisplayName(source), stars: source.stars, score: sourceScore(source) }))
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
            <Icon name="refresh" /> {loading ? t("usage.refreshing") : t("usage.refresh")}
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
  loading: boolean;
  onBulkSaveMetadata: (sourceIds: string[], category: string, enabled: boolean | null) => Promise<"failed" | "preview" | "saved">;
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
  onRefreshIndex: () => Promise<LegacySnapshot | null>;
  onSaveSkillMetadata: (skill: SkillCard, draft: SkillDraft) => Promise<"failed" | "preview" | "saved">;
  onSaveSourceMetadata: (source: SourceCard, draft: SourceDraft) => Promise<"failed" | "preview" | "saved">;
  onSetSkillConflictChoice: (
    conflictKey: string,
    defaultSkillId: string,
    status: "default-set" | "ignored" | "unresolved"
  ) => Promise<void>;
  onSetSkillEnabled: (skill: SkillCard, enabled: boolean) => Promise<boolean>;
  onStageImport: (importKind: string, input: string, options?: ImportFeedbackOptions) => Promise<SourceImportExecutionCard>;
  realWritesEnabled: boolean;
  searchQuery: string;
  snapshot: LegacySnapshot | null;
};

function Library(props: LibraryProps) {
  const {
    loading,
    onDeleteSource,
    onPreviewImport,
    onPromoteImport,
    onRecordUsage,
    onRefreshIndex,
    onSaveSkillMetadata,
    onSaveSourceMetadata,
    onSetSkillConflictChoice,
    onSetSkillEnabled,
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

  const popularityById = useMemo(
    () => new Map((snapshot?.sourcePopularity ?? []).map(item => [item.sourceId, item])),
    [snapshot?.sourcePopularity]
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
    return sortSources(filtered, sortKey, popularityById);
  }, [popularityById, skills, sources, sourceDrafts, sortKey, searchQuery]);

  const localSkills = useMemo(() => {
    return skills
      .map(skill => applySkillDraft(skill, skillDrafts[skill.folderName]))
      .filter(skill => {
        if (skill.source && sources.some(source => normalizeLookup(source.name) === normalizeLookup(skill.source))) {
          return false;
        }
        return searchQuery.trim() ? skillMatchesSearch(skill, searchQuery) : true;
      });
  }, [skillDrafts, skills, sources, searchQuery]);

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
          <RouterHubPanel disabled={loading} realWritesEnabled={realWritesEnabled} />
          {skillConflicts.length > 0 && (
            <SkillConflictPanel
              conflicts={skillConflicts}
              disabled={loading}
              onResolve={onSetSkillConflictChoice}
            />
          )}
        </div>
      )}

      <section className="library-tree">
        {visibleSources.map(source => {
          const isExpanded = expanded.has(source.id) || Boolean(searchQuery.trim());
          const sourceSkills = skills
            .map(skill => applySkillDraft(skill, skillDrafts[skill.folderName]))
            .filter(skill => skillBelongsToSource(skill, source));
          const parentSkills = sourceSkills.filter(isRouterHubSkill);
          const childSkills = sourceSkills.filter(skill => !isRouterHubSkill(skill));
          const popularity = popularityById.get(source.id);
          const matchesQuery = searchQuery.trim()
            ? childSkills.some(skill => skillMatchesSearch(skill, searchQuery))
            : true;
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
                  <span className={`source-avatar tone-${categoryToneId(source.categoryId)}`} aria-hidden="true">
                    <Icon name={source.url ? "sources" : "library"} />
                  </span>
                  <div className="source-group-title">
                    <strong>{source.name}</strong>
                    <span>
                      {displayCategoryName(source.categoryId)} · {sourceTypeLabel(source.sourceType)} ·{" "}
                      {t("lib.children", { n: childSkills.length })}
                    </span>
                  </div>
                </button>
                <div className="source-group-meta">
                  <PopularityChip popularity={popularity} source={source} />
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
                <span className="source-avatar tone-tertiary" aria-hidden="true">
                  <Icon name="sparkle" />
                </span>
                <div className="source-group-title">
                  <strong>{t("lib.localGroup")}</strong>
                  <span>{t("lib.localGroupHint")} · {t("lib.children", { n: localSkills.length })}</span>
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
          onSave={draft => void saveSourceDraft(editingSource, draft)}
          popularity={popularityById.get(editingSource.id)}
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
  onToggleEnabled,
  skill
}: {
  agentStatuses: AgentSkillStatusCard[];
  isParent: boolean;
  loading: boolean;
  onCopy: () => void;
  onEdit: () => void;
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
      </div>
      <div className="skill-row-actions">
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
  onClose,
  onDelete,
  onOpenChildren,
  onSave,
  popularity,
  source,
  sourceSkills
}: {
  draft?: SourceDraft;
  onClose: () => void;
  onDelete: () => void;
  onOpenChildren: () => void;
  onSave: (draft: SourceDraft) => void;
  popularity?: SourcePopularityCard;
  source: SourceCard;
  sourceSkills: SkillCard[];
}) {
  const [name, setName] = useState(draft?.name ?? source.name);
  const [category, setCategory] = useState(draft?.category ?? source.categoryId);
  const [sourceType, setSourceType] = useState<SourceCard["sourceType"]>(draft?.sourceType ?? source.sourceType);
  const [note, setNote] = useState(draft?.note ?? source.note ?? "");
  const [enabled, setEnabled] = useState(draft?.enabled ?? source.enabled);
  const [tags, setTags] = useState(draft?.tags ?? tagInputValue(source.tags ?? []));
  const routerSkills = sourceSkills.filter(isRouterHubSkill);
  const childSkills = sourceSkills.filter(skill => !isRouterHubSkill(skill));
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
          <b>{source.skillCount}</b>
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
      <div className="source-detail-skill-map">
        <div className="source-detail-section-title">
          <strong>{t("srcEditor.map")}</strong>
          <span>{t("srcEditor.mapCount", { routers: routerSkills.length, children: childSkills.length })}</span>
          <button className="ghost-action small" onClick={onOpenChildren} type="button">
            <Icon name="chevron" />
          </button>
        </div>
        {childSkills.length === 0 && <p className="source-detail-muted">{t("srcEditor.noChildren")}</p>}
        {childSkills.slice(0, 10).map(skill => (
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
  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} aria-hidden="true" />
      <aside className={wide ? "drawer wide" : "drawer"} role="dialog" aria-label={title}>
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
    </>
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
  const unresolved = conflicts.filter(conflict => conflict.status === "unresolved").length;
  const [activeKey, setActiveKey] = useState(conflicts[0]?.conflictKey ?? "");
  const selected = conflicts.find(conflict => conflict.conflictKey === activeKey) ?? conflicts[0];

  if (!selected) return null;

  return (
    <section className="conflict-panel glow-card">
      <header className="panel-head">
        <div>
          <span className="eyebrow">{t("conf.eyebrow")}</span>
          <h3>{t("conf.title")}</h3>
          <p>{t("conf.subtitle")}</p>
        </div>
        <div className="panel-head-meta">
          <span>{t("conf.groups", { n: conflicts.length })}</span>
          <strong>{t("conf.pending", { n: unresolved })}</strong>
        </div>
      </header>
      <div className="conflict-layout">
        <ul className="conflict-tabs">
          {conflicts.map(conflict => (
            <li key={conflict.conflictKey}>
              <button
                className={conflict.conflictKey === selected.conflictKey ? "active" : ""}
                onClick={() => setActiveKey(conflict.conflictKey)}
                type="button"
              >
                <strong>/{conflict.childName}</strong>
                <span>{t("conf.candidates", { n: conflict.choices.length })}</span>
                <small>{conflict.defaultSourceName || conflictStatusLabel(conflict.status)}</small>
              </button>
            </li>
          ))}
        </ul>
        <div className="conflict-detail">
          <p>{t("conf.detailHint", { name: selected.childName })}</p>
          <div className="conflict-choices">
            {selected.choices.map(choice => {
              const isDefault = choice.skillId === selected.defaultSkillId;
              return (
                <article className={`conflict-choice${isDefault ? " selected" : ""}`} key={choice.skillId}>
                  <div>
                    <strong>{choice.sourceName}:{choice.skillName}</strong>
                    <span>{displayCategoryName(choice.category) || t("conf.uncategorized")}</span>
                  </div>
                  <p>{choice.description || t("conf.noDescription")}</p>
                  <button
                    className={isDefault ? "ghost-action small" : "primary-action small"}
                    disabled={disabled || isDefault}
                    onClick={() => void onResolve(selected.conflictKey, choice.skillId, "default-set")}
                    type="button"
                  >
                    {isDefault ? t("conf.isDefault") : t("conf.setDefault")}
                  </button>
                </article>
              );
            })}
          </div>
          <div className="conflict-actions">
            <button
              className="ghost-action small"
              disabled={disabled}
              onClick={() => void onResolve(selected.conflictKey, "", "unresolved")}
              type="button"
            >
              {t("conf.reset")}
            </button>
            <button
              className="ghost-action small"
              disabled={disabled}
              onClick={() => void onResolve(selected.conflictKey, "", "ignored")}
              type="button"
            >
              {t("conf.ignore")}
            </button>
          </div>
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
  onPreview,
  onPromote,
  onRefreshIndex,
  onSaveSourceMetadata,
  onStage,
  sources
}: {
  disabled: boolean;
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
  const [status, setStatus] = useState<QuickAddStatus | null>(null);

  const inferredIds = inferCategoryIds(`${input} ${note} ${sourceType} ${importKind}`);
  const effectiveCategoryIds = selectedCategoryIds.length > 0 ? selectedCategoryIds : inferredIds;

  async function quickAdd() {
    const value = input.trim();
    if (!value) {
      showUiToast(t("qa.needInput"), "warn");
      return;
    }
    setPending(true);
    setStatus({ tone: "info", title: t("qa.statusChecking"), body: t("qa.statusCheckingBody") });
    try {
      const plan = await onPreview(importKind, value, { quiet: true });
      if (!plan.safeToContinue) {
        setStatus({
          tone: "warn",
          title: t("qa.statusBlockedTitle"),
          body: plan.duplicateReason || plan.blockingChecks[0] || ""
        });
        showUiToast(t("qa.toastBlocked"), "warn");
        return;
      }
      setStatus({ tone: "info", title: t("qa.statusJoining"), body: t("qa.statusJoiningBody") });
      const execution = await onStage(plan.importKind, plan.input, { quiet: true });
      if (execution.status !== "staged" && execution.status !== "warn") {
        setStatus({ tone: "warn", title: t("qa.statusNotWritten"), body: execution.summary });
        showUiToast(t("qa.toastStagingStop"), "warn");
        return;
      }
      setStatus({ tone: "info", title: t("qa.statusWriting"), body: t("qa.statusWritingBody") });
      const promotion = await onPromote(execution.importKind, execution.stagedPath, plan.displayName, {
        quiet: true
      });
      if (promotion.status !== "promoted" && promotion.status !== "already-managed") {
        setStatus({ tone: "warn", title: t("qa.statusNotWritten"), body: promotion.summary });
        showUiToast(t("qa.toastPromoteStop"), "warn");
        return;
      }
      setStatus({ tone: "info", title: t("qa.statusRefreshing"), body: t("qa.statusRefreshingBody") });
      const refreshed = await onRefreshIndex();
      const promotedSource = refreshed?.sources.find(
        item => normalizeSourcePath(item.localPath) === normalizeSourcePath(promotion.targetPath)
      );
      if (promotedSource) {
        const customCategoryLabel = customCategory.trim();
        const primaryCategory =
          customCategoryLabel || displayCategoryName(effectiveCategoryIds[0] ?? categoryIdForSourceType(sourceType));
        const extraTags = effectiveCategoryIds.slice(customCategoryLabel ? 0 : 1).map(displayCategoryName).join(", ");
        const draft: SourceDraft = {
          category: primaryCategory,
          enabled,
          name: promotedSource.name,
          note,
          sourceType,
          tags: mergeTagInputs(tags, extraTags)
        };
        await onSaveSourceMetadata(promotedSource, draft);
      }
      setStatus({ tone: "ok", title: t("qa.statusAddedTitle"), body: t("qa.statusAddedSynced") });
      showUiToast(t("qa.toastSynced"), "ok");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
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
            onChange={setImportKind}
          />
        </div>
        <label className="import-field grow">
          <span className="field-label">{t("qa.input")}</span>
          <input disabled={isBusy} onChange={event => setInput(event.target.value)} placeholder={placeholder} value={input} />
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

      <div className="import-actions">
        <button className="primary-action large" disabled={isBusy} onClick={() => void quickAdd()} type="button">
          <Icon name="add" /> {isBusy ? t("qa.submitting") : t("qa.submit")}
        </button>
      </div>

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
  onToggleDistribution,
  snapshot
}: {
  disabled: boolean;
  onToggle: (command: string, id: string, enabled: boolean) => Promise<void>;
  onToggleDistribution: (presetId: string, workspaceId: string, enabled: boolean) => Promise<void>;
  snapshot: LegacySnapshot | null;
}) {
  const presets = snapshot?.presets ?? [];
  const distributions = snapshot?.presetDistributions ?? [];
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

      <section className="panel glow-card">
        <header className="panel-head">
          <div>
            <span className="eyebrow">{t("preset.matrixEyebrow")}</span>
            <h3>{t("preset.matrixTitle")}</h3>
            <p>{t("preset.matrixBody")}</p>
          </div>
          <span className="badge-soft">{t("preset.plans", { n: distributions.length })}</span>
        </header>
        <div className="distribution-grid">
          {distributions.map(item => (
            <article className={`distribution-row${item.enabled ? " enabled" : ""}`} key={item.id}>
              <div>
                <strong>{item.presetName}</strong>
                <span>{item.workspaceName} · {scopeLabel(item.workspaceScope)}</span>
              </div>
              <small>{item.summary}</small>
              <ToggleSwitch
                disabled={disabled}
                enabled={item.enabled}
                label={item.enabled ? t("preset.distributed") : t("preset.notDistributed")}
                onClick={() => void onToggleDistribution(item.presetId, item.workspaceId, !item.enabled)}
              />
            </article>
          ))}
          {distributions.length === 0 && <p>{t("preset.matrixEmpty")}</p>}
        </div>
      </section>
    </div>
  );
}

function Agents({
  disabled,
  onRefreshAgents,
  onToggle,
  snapshot
}: {
  disabled: boolean;
  onRefreshAgents: () => void;
  onToggle: (command: string, id: string, enabled: boolean) => Promise<void>;
  snapshot: LegacySnapshot | null;
}) {
  const adapters = snapshot?.agentAdapters ?? [];
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
            <Icon name="refresh" /> {disabled ? t("agents.detecting") : t("agents.detectNow")}
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

      <div className="adapter-grid">
        {adapters.map(adapter => (
          <article className="adapter-card glow-card" key={adapter.id}>
            <header>
              <strong>{adapter.name}</strong>
              <span className={`adapter-status ${adapter.status}`}>{adapterStatusLabel(adapter.status)}</span>
            </header>
            <p>{adapter.skillsPathHint || t("agents.noPath")}</p>
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
        ))}
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
  const diagnostics = snapshot?.diagnostics;
  const releaseReports = snapshot?.releaseReports ?? [];
  const operationRunners = snapshot?.operationRunners ?? [];
  const desktopQaChecks = snapshot?.desktopQaChecks ?? [];
  const backupDryRun = snapshot?.backupDryRun ?? [];
  const restoreDryRun = snapshot?.restoreDryRun ?? [];
  const rollbackPlan = snapshot?.rollbackPlan ?? [];
  const snapshots = snapshot?.snapshots ?? [];
  const latestSnapshot = snapshots.find(item => item.isLatest) ?? snapshots[0];
  const operatorConsent = snapshot?.operatorConsent ?? {
    realWritesEnabled: false,
    enabledAt: "",
    updatedAt: "",
    summary: ""
  };
  const diagnosticsReport = releaseReports.find(report => report.id === "diagnostics");
  const preflightReport = releaseReports.find(report => report.id === "release-preflight");
  const shareReport = releaseReports.find(report => report.id === "share-recipient");
  const zipReport = releaseReports.find(report => report.id === "zip-preview");
  const blockedBackups = countByStatus(backupDryRun, "blocked");
  const plannedBackups = countByStatus(backupDryRun, "planned");
  const blockedRestores = countByStatus(restoreDryRun, "blocked");
  const plannedRestores = countByStatus(restoreDryRun, "planned");
  const lockedRollbackSteps = rollbackPlan.filter(step => step.status === "locked").length;
  const diagnosticsReady = Boolean(diagnosticsReport?.ok ?? (diagnostics?.available && diagnostics.error === 0));

  const gateItems = [
    {
      status: diagnosticsReady ? "done" : "blocked",
      title: t("gate.diagnostics"),
      label: diagnosticsReady ? t("adv.labelDone") : t("adv.labelPlanned"),
      summary: diagnosticsReady
        ? diagnosticsReport?.summary ??
          t("gate.diagnosticsOkFallback", {
            ok: diagnostics?.ok ?? 0,
            warn: diagnostics?.warn ?? 0,
            error: diagnostics?.error ?? 0
          })
        : t("gate.diagnosticsBad")
    },
    {
      status: backupDryRun.length > 0 && blockedBackups === 0 && plannedBackups === 0 ? "done" : "planned",
      title: t("gate.backup"),
      label: backupDryRun.length > 0 ? t("gate.dryRunOnly") : t("gate.toGenerate"),
      summary:
        backupDryRun.length > 0
          ? t("gate.backupReady", { total: backupDryRun.length, planned: plannedBackups, blocked: blockedBackups })
          : t("gate.backupWaiting")
    },
    {
      status: restoreDryRun.length > 0 && blockedRestores === 0 && plannedRestores === 0 ? "done" : "planned",
      title: t("gate.restore"),
      label: restoreDryRun.length > 0 ? t("gate.dryRunOnly") : t("gate.toGenerate"),
      summary:
        restoreDryRun.length > 0
          ? t("gate.backupReady", { total: restoreDryRun.length, planned: plannedRestores, blocked: blockedRestores })
          : t("gate.restoreWaiting")
    },
    {
      status: lockedRollbackSteps === 0 && rollbackPlan.length > 0 ? "done" : "blocked",
      title: t("gate.rollback"),
      label: lockedRollbackSteps === 0 ? t("gate.rollbackUnlocked") : t("gate.rollbackLocked"),
      summary:
        rollbackPlan.length > 0
          ? t("gate.rollbackSummary", { total: rollbackPlan.length, locked: lockedRollbackSteps })
          : t("gate.rollbackWaiting")
    },
    {
      status: desktopQaGateStatus(desktopQaChecks),
      title: t("gate.desktopQa"),
      label: desktopQaGateLabel(desktopQaChecks),
      summary: desktopQaGateSummary(desktopQaChecks)
    },
    {
      status: releaseReportGateStatus(preflightReport),
      title: t("gate.preflight"),
      label: releaseReportGateLabel(preflightReport),
      summary: preflightReport?.summary ?? t("gate.preflightMissing")
    },
    {
      status: releaseReportGateStatus(shareReport),
      title: t("gate.share"),
      label: releaseReportGateLabel(shareReport),
      summary: shareReport?.summary ?? t("gate.shareMissing")
    },
    {
      status: releaseReportGateStatus(zipReport),
      title: t("gate.zip"),
      label: releaseReportGateLabel(zipReport),
      summary: zipReport?.summary ?? t("gate.zipMissing")
    }
  ];
  const doneCount = gateItems.filter(item => item.status === "done").length;
  const blockedCount = gateItems.filter(item => item.status === "blocked").length;
  const plannedCount = gateItems.filter(item => item.status === "planned").length;
  const readinessStatus = blockedCount > 0 ? "blocked" : plannedCount > 0 ? "planned" : "done";

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

      <section className={`panel glow-card readiness-${readinessStatus}`}>
        <header className="panel-head">
          <div>
            <span className="eyebrow">{t("adv.gatesEyebrow")}</span>
            <h3>
              {readinessStatus === "done"
                ? t("adv.readinessDone")
                : readinessStatus === "blocked"
                  ? t("adv.readinessBlocked")
                  : t("adv.readinessPlanned")}
            </h3>
            <p>{t("adv.gatesProgress", { done: doneCount, total: gateItems.length, planned: plannedCount, blocked: blockedCount })}</p>
          </div>
        </header>
        <div className="gate-grid">
          {gateItems.map(item => (
            <article className={`gate-card ${item.status}`} key={item.title}>
              <span className={`qa-status ${item.status}`}>{item.label}</span>
              <strong>{item.title}</strong>
              <small>{item.summary}</small>
            </article>
          ))}
        </div>
      </section>

      <section className="panel glow-card">
        <header className="panel-head">
          <div>
            <span className="eyebrow">{t("adv.runnersEyebrow")}</span>
            <h3>{t("adv.runnersTitle")}</h3>
            <p>{t("adv.runnersBody")}</p>
          </div>
          <span className="badge-soft warn">{t("adv.runnersLocked")}</span>
        </header>
        <div className="runner-grid">
          {operationRunners.map(runner => (
            <article className={`runner-card ${runner.status}`} key={runner.id}>
              <header>
                <strong>{runner.title}</strong>
                <span className={`qa-status ${operationRunnerStatusClass(runner.status, runner.locked)}`}>
                  {operationRunnerStatusLabel(runner.status, runner.locked)}
                </span>
              </header>
              <p>{runner.summary}</p>
              <div className="runner-meta">
                <span>{runner.lastRunAt ? formatScanTime(runner.lastRunAt) : t("adv.notRun")}</span>
                <span>{runner.fileCount ? t("adv.exports", { n: runner.fileCount }) : t("adv.waitingExport")}</span>
              </div>
              <div className="runner-actions">
                <button
                  className="ghost-action small"
                  disabled={disabled || runner.fileCount === 0 || !runner.exportDir}
                  onClick={() => void openReleaseGateExportPath(runner.exportDir)}
                  type="button"
                >
                  {t("adv.openDir")}
                </button>
                <button
                  className="ghost-action small"
                  disabled={disabled || !(runner.latestMarkdownPath || runner.reportPath)}
                  onClick={() =>
                    void copyTextToClipboard(runner.latestMarkdownPath || runner.reportPath, t("toast.pathCopied"))
                  }
                  type="button"
                >
                  {t("adv.copyPath")}
                </button>
                <button
                  className="secondary-action small"
                  disabled={disabled}
                  onClick={() => void onRunRunner(runner.id)}
                  type="button"
                >
                  {runner.locked ? t("adv.runLocked") : t("adv.run")}
                </button>
              </div>
            </article>
          ))}
          {operationRunners.length === 0 && <p className="empty-state">{t("adv.runnersEmpty")}</p>}
        </div>
      </section>

      <section className="panel glow-card">
        <header className="panel-head">
          <div>
            <span className="eyebrow">{t("adv.snapEyebrow")}</span>
            <h3>{t("adv.snapTitle")}</h3>
          </div>
        </header>
        <div className="snapshot-summary">
          <article>
            <span>{t("adv.snapLatest")}</span>
            <strong>{latestSnapshot?.name ?? t("adv.snapWaiting")}</strong>
            <p>{latestSnapshot?.summary ?? t("adv.snapWaitingBody")}</p>
            <small>
              {latestSnapshot ? formatScanTime(latestSnapshot.createdAt) : t("adv.snapNoId")}
            </small>
          </article>
          <article>
            <span>{t("adv.rollbackTitle")}</span>
            <ul className="rollback-mini">
              {rollbackPlan.map(step => (
                <li className={`rollback-step ${step.status}`} key={step.id}>
                  <span className={`step-dot ${step.status}`} />
                  <div>
                    <strong>{step.title}</strong>
                    <small>{step.summary}</small>
                  </div>
                </li>
              ))}
              {rollbackPlan.length === 0 && <li className="empty-state">{t("adv.rollbackEmpty")}</li>}
            </ul>
          </article>
        </div>
        <div className="snapshot-history">
          <strong>{t("adv.historyTitle")}</strong>
          <div>
            {snapshots.map(item => (
              <article className={item.isLatest ? "snapshot-history-row latest" : "snapshot-history-row"} key={item.id}>
                <strong>{item.name}</strong>
                <span>{item.summary}</span>
                <small>{formatScanTime(item.createdAt)}</small>
              </article>
            ))}
            {snapshots.length === 0 && <p className="empty-state">{t("adv.historyEmpty")}</p>}
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
  currentLang,
  currentTheme,
  disabled,
  onChangeLang,
  onChangeTheme,
  onOpenAdvanced,
  onQaStatus,
  snapshot
}: {
  currentLang: Lang;
  currentTheme: ThemeName;
  disabled: boolean;
  onChangeLang: (lang: Lang) => void;
  onChangeTheme: (theme: ThemeName) => void;
  onOpenAdvanced: () => void;
  onQaStatus: (id: string, status: "pending" | "passed" | "failed") => void;
  snapshot: LegacySnapshot | null;
}) {
  const desktopQaChecks = snapshot?.desktopQaChecks ?? [];
  return (
    <div className="view settings-view">
      <section className="page-header glow-card">
        <div>
          <span className="eyebrow"><Icon name="settings" /> {t("nav.settings")}</span>
          <h2>{t("set.title")}</h2>
          <p>{t("set.subtitle")}</p>
        </div>
      </section>

      <section className="panel glow-card">
        <header className="panel-head">
          <div>
            <span className="eyebrow">{t("set.appearanceEyebrow")}</span>
            <h3>{t("set.appearanceTitle")}</h3>
          </div>
        </header>
        <div className="settings-grid">
          <div className="settings-row">
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
          <div className="path-row">
            <span>{t("set.centralDir")}</span>
            <code>{snapshot?.skillsDir ?? "../skills"}</code>
          </div>
          <div className="path-row">
            <span>{t("set.sourcesDir")}</span>
            <code>{snapshot?.sourcesDir ?? "../app/github_sources"}</code>
          </div>
          <div className="path-row">
            <span>{t("set.diagnostics")}</span>
            <code>{snapshot?.diagnosticsFile ?? "../app/reports/latest-diagnostics.json"}</code>
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

      <section className="panel glow-card">
        <header className="panel-head">
          <div>
            <span className="eyebrow">{t("set.guideEyebrow")}</span>
            <h3>{t("set.guideTitle")}</h3>
          </div>
        </header>
        <div className="guide-grid">
          <article>
            <strong>{t("set.guideNow")}</strong>
            <span>{t("set.guideNowSub")}</span>
            <code>pnpm dev:desktop</code>
            <small>{t("set.guideNowHint")}</small>
          </article>
          <article>
            <strong>{t("set.guideDebug")}</strong>
            <span>{t("set.guideDebugSub")}</span>
            <code>src-tauri\target\debug\ai-skillhub-next.exe</code>
            <small>{t("set.guideDebugHint")}</small>
          </article>
          <article>
            <strong>{t("set.guideRelease")}</strong>
            <span>{t("set.guideReleaseSub")}</span>
            <code>pnpm tauri build</code>
            <small>{t("set.guideReleaseHint")}</small>
          </article>
        </div>
      </section>

      <section className="panel glow-card">
        <header className="panel-head">
          <div>
            <span className="eyebrow">{t("set.qaEyebrow")}</span>
            <h3>{t("set.qaTitle")}</h3>
            <p>{t("set.qaBody")}</p>
          </div>
        </header>
        <div className="qa-grid">
          {desktopQaChecks.map(check => (
            <article className={`qa-card ${qaStatusClass(check.status)}`} key={check.id}>
              <header>
                <span className={`qa-status ${qaStatusClass(check.status)}`}>{qaStatusLabel(check.status)}</span>
                <strong>{check.title}</strong>
              </header>
              <small>{check.description}</small>
              <div className="qa-actions">
                <button
                  className={check.status === "passed" ? "qa-action active" : "qa-action"}
                  disabled={disabled}
                  onClick={() => onQaStatus(check.id, "passed")}
                  type="button"
                >
                  {t("qaCheck.pass")}
                </button>
                <button
                  className={check.status === "failed" ? "qa-action danger active" : "qa-action danger"}
                  disabled={disabled}
                  onClick={() => onQaStatus(check.id, "failed")}
                  type="button"
                >
                  {t("qaCheck.fail")}
                </button>
                <button
                  className={check.status === "pending" ? "qa-action muted active" : "qa-action muted"}
                  disabled={disabled}
                  onClick={() => onQaStatus(check.id, "pending")}
                  type="button"
                >
                  {t("qaCheck.pending")}
                </button>
              </div>
              <small className="qa-updated">{t("qaCheck.updated", { time: formatScanTime(check.updatedAt) })}</small>
            </article>
          ))}
          {desktopQaChecks.length === 0 && <p className="empty-state">{t("set.qaEmpty")}</p>}
        </div>
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
  if (typeof window === "undefined") return "dark";
  const searchTheme = new URLSearchParams(window.location.search).get("theme");
  if (isThemeName(searchTheme)) return searchTheme;
  const savedTheme = window.localStorage.getItem("ai-skillhub-theme");
  return isThemeName(savedTheme) ? savedTheme : "dark";
}

function isThemeName(value: string | null): value is ThemeName {
  return value === "dark" || value === "light" || value === "classic-dark" || value === "classic-light";
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
  popularityById: Map<string, SourcePopularityCard>
): SourceCard[] {
  return [...sources].sort((left, right) => {
    const leftPop = popularityById.get(left.id);
    const rightPop = popularityById.get(right.id);
    const nameCompare = left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" });
    switch (sortKey) {
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
  const sourceFolder = sourcePath.split("/").filter(Boolean).pop() ?? "";
  if (sourceFolder && skillPath.includes(`/${sourceFolder}/`)) return true;
  const sourceUrlName = normalizeLookup((source.url.split("/").pop() ?? "").replace(/\.git$/i, ""));
  return Boolean(sourceUrlName && (skillSource === sourceUrlName || skillPath.includes(`/${sourceUrlName}/`)));
}

function normalizeLookup(value: string) {
  return value.trim().toLowerCase().replace(/[_\s]+/g, "-");
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
  if (value.includes("design") || value.includes("ui")) return "tertiary";
  if (value.includes("research") || value.includes("paper")) return "primary";
  if (value.includes("security")) return "error";
  if (value.includes("development") || value.includes("dev")) return "secondary";
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
  if (value.includes("development") || value.includes("dev")) return "workspaces";
  if (value.includes("agent")) return "agent";
  return "sparkle";
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
