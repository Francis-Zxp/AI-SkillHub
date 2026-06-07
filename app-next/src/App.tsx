import { invoke } from "@tauri-apps/api/core";
import { Fragment, type CSSProperties, useEffect, useMemo, useState } from "react";
import type {
  DesktopQaCheckCard,
  ImportPreviewCard,
  LegacySnapshot,
  LegacySummary,
  NavKey,
  PresetDistributionCard,
  ProjectScanCard,
  ReleaseReportCard,
  RouterHubReport,
  SkillCard,
  SkillConflictCard,
  SourceCard,
  SourceImportExecutionCard,
  SourceImportPlanCard,
  SourceImportPromotionCard,
  SourcePopularityCard,
  WriteGateCard,
  WorkspaceCard
} from "./types";

type IconName =
  | "add"
  | "agent"
  | "alert"
  | "bell"
  | "dashboard"
  | "edit"
  | "help"
  | "info"
  | "library"
  | "list"
  | "menu"
  | "moon"
  | "more"
  | "refresh"
  | "release"
  | "search"
  | "settings"
  | "snapshots"
  | "sources"
  | "sparkle"
  | "sun"
  | "workspaces";

const navItems: Array<{ key: NavKey; label: string; hint: string; icon: IconName }> = [
  { key: "dashboard", label: "Dashboard", hint: "Overview", icon: "dashboard" },
  { key: "sources", label: "Sources", hint: "GitHub and local", icon: "sources" },
  { key: "library", label: "Skill Library", hint: "Central skills", icon: "sparkle" },
  { key: "workspaces", label: "Workspaces", hint: "Global and projects", icon: "workspaces" },
  { key: "presets", label: "Presets", hint: "Skill bundles", icon: "list" },
  { key: "agents", label: "Agents", hint: "Claude, Codex, Antigravity", icon: "agent" }
];
const advancedNavKeys: NavKey[] = ["snapshots", "release"];

type ThemeName = "dark" | "light";
type SkillDraft = {
  category: string;
  description: string;
  name: string;
  note: string;
  tags: string;
};

type SourceDraft = {
  category: string;
  enabled: boolean;
  name: string;
  note: string;
  sourceType: SourceCard["sourceType"];
  tags: string;
};

type QuickSourceDraft = Omit<SourceDraft, "name">;

type ImportFeedbackOptions = {
  quiet?: boolean;
};

type QuickAddStatus = {
  body: string;
  title: string;
  tone: "info" | "ok" | "warn" | "error";
};

type SourceSortKey = "recent" | "usage" | "heat" | "skillCount" | "health" | "name";

type SkillCollectionGroup = {
  children: SkillCard[];
  childPreview: string[];
  name: string;
  parent?: SkillCard;
};

const TOAST_EVENT = "ai-skillhub-toast";
const AUTO_CATEGORY_ID = "auto";

type CategoryOption = {
  id: string;
  label: string;
  keywords: string[];
};

const CATEGORY_OPTIONS: CategoryOption[] = [
  {
    id: "academic-writing",
    label: "论文科研",
    keywords: ["paper", "manuscript", "nature", "academic", "writing", "research-writing", "sci", "论文", "科研", "稿件", "学术"]
  },
  {
    id: "literature-research",
    label: "文献研究",
    keywords: ["literature", "citation", "reference", "pubmed", "arxiv", "review", "deep-research", "文献", "引文", "综述", "检索"]
  },
  {
    id: "scientific-figures",
    label: "科研图表",
    keywords: ["figure", "plot", "chart", "graph", "matplotlib", "visualization", "figures4papers", "图表", "绘图", "可视化", "科研图"]
  },
  {
    id: "ui-design",
    label: "界面设计",
    keywords: ["ui", "ux", "design", "frontend", "figma", "interface", "impeccable", "界面", "设计", "前端"]
  },
  {
    id: "security-audit",
    label: "安全审计",
    keywords: ["security", "audit", "vibesec", "vulnerability", "review", "安全", "审计", "漏洞"]
  },
  {
    id: "agent-tools",
    label: "智能体工具",
    keywords: ["agent", "claude", "codex", "gstack", "tool", "automation", "智能体", "工具", "自动化"]
  },
  {
    id: "image-generation",
    label: "图像生成",
    keywords: ["image", "gpt-image", "generate-image", "diffusion", "图像", "图片", "生成"]
  },
  {
    id: "knowledge-retrieval",
    label: "知识检索",
    keywords: ["retrieval", "search", "kb", "database", "lookup", "exa", "知识", "检索", "搜索"]
  },
  {
    id: "presentations",
    label: "汇报演示",
    keywords: ["presentation", "slides", "ppt", "poster", "汇报", "演示", "幻灯", "PPT"]
  },
  {
    id: "prompt-polishing",
    label: "提示词润色",
    keywords: ["prompt", "polish", "awesome-ai", "润色", "提示词", "改写"]
  },
  {
    id: "data-analysis",
    label: "数据分析",
    keywords: ["data", "analysis", "single-cell", "rnaseq", "pandas", "统计", "分析", "数据"]
  },
  {
    id: "development",
    label: "工程开发",
    keywords: ["code", "dev", "engineering", "react", "rust", "tauri", "工程", "开发", "代码"]
  },
  {
    id: "general",
    label: "通用",
    keywords: ["general", "misc", "other", "通用", "其它", "其他"]
  }
];

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

type OperationStatus = {
  title: string;
  detail: string;
  step: number;
  total: number;
  percent: number;
};

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function friendlyErrorMessage(message: string): string {
  if (message.includes("Source metadata is too long")) {
    return "来源信息过长：请缩短备注后再试。";
  }
  if (message.includes("来源备注过长")) {
    return message;
  }
  if (message.includes("GitHub API")) {
    return "GitHub 热度刷新失败：请检查网络或稍后重试。";
  }
  return message;
}

export function App() {
  const [active, setActive] = useState<NavKey>(() => initialNavKey());
  const [theme, setTheme] = useState<ThemeName>(() => initialTheme());
  const [snapshot, setSnapshot] = useState<LegacySnapshot | null>(null);
  const [loadError, setLoadError] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(true);
  const [operation, setOperation] = useState<OperationStatus | null>(null);
  const [toast, setToast] = useState<string>("");
  const [globalSearch, setGlobalSearch] = useState<string>("");
  const runtimeAvailable = hasTauriRuntime();
  const realWritesEnabled = snapshot?.operatorConsent?.realWritesEnabled === true;
  const skillCommandSearch = queryLooksLikeSkillCommand(globalSearch);

  const summary = useMemo(() => {
    return (
      snapshot?.summary ?? {
        skills: 0,
        sources: 0,
        prompts: 0,
        agentsDetected: 0,
        warnings: 0,
        diagnosticsStatus: "loading"
      }
    );
  }, [snapshot]);
  const globalSearchResults = useMemo(() => {
    const skills = (snapshot?.skills ?? [])
      .filter(skill => skillMatchesSearch(skill, globalSearch))
      .sort((left, right) => skillSearchScore(right, globalSearch) - skillSearchScore(left, globalSearch))
      .slice(0, skillCommandSearch ? 12 : 8);
    const sources = skillCommandSearch
      ? []
      : (snapshot?.sources ?? [])
          .filter(source => sourceMatchesSearch(source, globalSearch))
          .sort((left, right) => sourceSearchScore(right, globalSearch) - sourceSearchScore(left, globalSearch))
          .slice(0, 8);
    return { skills, sources };
  }, [globalSearch, skillCommandSearch, snapshot]);

  async function loadSnapshot(
    mode: "indexed" | "refresh" = "indexed",
    options: { background?: boolean } = {}
  ): Promise<LegacySnapshot | null> {
    if (!options.background) {
      setLoading(true);
    }
    try {
      if (!hasTauriRuntime()) {
        const preview = createPreviewSnapshot();
        setSnapshot(preview);
        setLoadError("");
        return preview;
      }

      const shouldRunRealSync = mode === "refresh" && snapshot?.operatorConsent?.realWritesEnabled === true;
      const command = shouldRunRealSync
        ? "run_skillhub_sync"
        : mode === "refresh"
          ? "scan_legacy_snapshot"
          : "load_indexed_snapshot";
      const result = await invoke<LegacySnapshot>(command);
      setSnapshot(result);
      setLoadError("");
      if (mode === "refresh") {
        setToast(
          shouldRunRealSync
            ? "已执行 GitHub 更新、Skill 路由重建、AI 工具链接同步，并刷新本地索引。"
            : "未开启真实写入授权：已刷新索引，但没有写入 Claude/Codex/Antigravity。"
        );
      }
      return result;
    } catch (error) {
      setLoadError(messageFromError(error));
      return null;
    } finally {
      if (!options.background) {
        setLoading(false);
      }
    }
  }

  async function updateEnabled(command: string, id: string, enabled: boolean) {
    setLoading(true);
    try {
      if (!hasTauriRuntime()) {
        setSnapshot(previous => updatePreviewEnabled(previous ?? createPreviewSnapshot(), command, id, enabled));
        setLoadError("");
        return;
      }

      const result = await invoke<LegacySnapshot>(command, { id, enabled });
      setSnapshot(result);
      setLoadError("");
      setToast(enabled ? "已启用，状态已写入 SQLite。" : "已停用，状态已写入 SQLite。");
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }

  async function updateDesktopQaStatus(id: string, status: "pending" | "passed" | "failed") {
    setLoading(true);
    try {
      if (!hasTauriRuntime()) {
        setSnapshot(previous => updatePreviewDesktopQaStatus(previous ?? createPreviewSnapshot(), id, status));
        setLoadError("");
        return;
      }

      const result = await invoke<LegacySnapshot>("set_desktop_qa_check_status", { id, status });
      setSnapshot(result);
      setLoadError("");
      setToast("桌面 QA 状态已更新。");
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }

  async function updateSkillMetadata(
    skill: SkillCard,
    draft: SkillDraft
  ): Promise<"failed" | "preview" | "saved"> {
    if (!hasTauriRuntime()) {
      return "preview";
    }

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
      setToast("Skill 名称、分类、备注和多标签已永久保存到本地 SQLite。");
      return "saved";
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
      setToast("保存失败，请查看顶部错误提示。");
      return "failed";
    } finally {
      setLoading(false);
    }
  }

  async function updateSkillEnabled(skill: SkillCard, enabled: boolean): Promise<boolean> {
    if (!hasTauriRuntime()) {
      return false;
    }

    setLoading(true);
    try {
      const result = await invoke<LegacySnapshot>("set_skill_enabled", {
        folderName: skill.folderName,
        enabled
      });
      setSnapshot(result);
      setLoadError("");
      setToast(enabled ? "Skill 已启用，状态已写入 SQLite。" : "Skill 已停用，状态已写入 SQLite。");
      return true;
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
      setToast("更新 Skill 启用状态失败，请查看顶部错误提示。");
      return true;
    } finally {
      setLoading(false);
    }
  }

  async function updateSourceMetadata(
    source: SourceCard,
    draft: SourceDraft
  ): Promise<"failed" | "preview" | "saved"> {
    if (!hasTauriRuntime()) {
      return "preview";
    }

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
      setToast("来源元数据和多标签已永久保存到本地 SQLite。");
      return "saved";
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
      setToast("来源保存失败，请查看顶部错误提示。");
      return "failed";
    } finally {
      setLoading(false);
    }
  }

  async function updateSkillConflictChoice(
    conflictKey: string,
    defaultSkillId: string,
    status: "default-set" | "ignored" | "unresolved"
  ): Promise<void> {
    if (!hasTauriRuntime()) {
      setSnapshot(previous => {
        const current = previous ?? createPreviewSnapshot();
        return {
          ...current,
          skillConflicts: (current.skillConflicts ?? []).map(conflict =>
            conflict.conflictKey === conflictKey
              ? {
                  ...conflict,
                  status,
                  defaultSkillId: status === "default-set" ? defaultSkillId : "",
                  defaultSourceName:
                    status === "default-set"
                      ? conflict.choices.find(choice => choice.skillId === defaultSkillId)?.sourceName ?? ""
                      : ""
                }
              : conflict
          )
        };
      });
      setToast("浏览器预览已模拟保存冲突选择。");
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
      setToast(
        status === "default-set"
          ? "同名 Skill 默认来源已保存。"
          : status === "ignored"
            ? "该同名 Skill 已标记为忽略；不会再作为待处理项提醒。"
            : "该同名 Skill 已恢复为待选择状态。"
      );
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
      setToast("保存冲突选择失败，请查看顶部错误提示。");
    } finally {
      setLoading(false);
    }
  }

  async function updateSourcesBulkMetadata(
    sourceIds: string[],
    category: string,
    enabled: boolean | null
  ): Promise<"failed" | "preview" | "saved"> {
    if (sourceIds.length === 0) {
      setToast("请先选择需要批量修改的来源。");
      return "failed";
    }
    if (!category.trim() && enabled === null) {
      setToast("请至少填写一个批量修改项。");
      return "failed";
    }

    if (!hasTauriRuntime()) {
      setSnapshot(previous => {
        const current = previous ?? createPreviewSnapshot();
        return {
          ...current,
          sources: current.sources.map(source =>
            sourceIds.includes(source.id)
              ? {
                  ...source,
                  categoryId: category.trim() || source.categoryId,
                  enabled: enabled === null ? source.enabled : enabled
                }
              : source
          )
        };
      });
      setToast("浏览器预览已应用批量来源草稿。");
      return "preview";
    }

    setLoading(true);
    try {
      const result = await invoke<LegacySnapshot>("set_sources_bulk_metadata", {
        sourceIds,
        category,
        enabled
      });
      setSnapshot(result);
      setLoadError("");
      setToast(`已批量更新 ${sourceIds.length} 个来源，结果已写入本地 SQLite。`);
      return "saved";
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
      setToast("批量来源编辑失败，请查看顶部错误提示。");
      return "failed";
    } finally {
      setLoading(false);
    }
  }

  async function updatePresetWorkspaceDistribution(presetId: string, workspaceId: string, enabled: boolean) {
    setLoading(true);
    try {
      if (!hasTauriRuntime()) {
        setSnapshot(previous =>
          updatePreviewPresetDistribution(previous ?? createPreviewSnapshot(), presetId, workspaceId, enabled)
        );
        setLoadError("");
        setToast(enabled ? "浏览器预览已启用该 Preset 分发。" : "浏览器预览已停用该 Preset 分发。");
        return;
      }

      const result = await invoke<LegacySnapshot>("set_preset_workspace_enabled", {
        presetId,
        workspaceId,
        enabled
      });
      setSnapshot(result);
      setLoadError("");
      setToast(enabled ? "Preset 已分发到工作区。" : "Preset 已从工作区停用。");
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
      setToast("Preset 分发状态更新失败，请查看顶部错误提示。");
    } finally {
      setLoading(false);
    }
  }

  async function runReleaseGateRunner(runnerId: string) {
    setLoading(true);
    try {
      if (!hasTauriRuntime()) {
        setSnapshot(previous => updatePreviewOperationRunner(previous ?? createPreviewSnapshot(), runnerId));
        setLoadError("");
        setToast("浏览器预览已模拟执行器状态；桌面版会写入本地 SQLite 审计记录。");
        return;
      }

      const result = await invoke<LegacySnapshot>("run_release_gate_runner", { runnerId });
      setSnapshot(result);
      setLoadError("");
      setToast("发布闸门执行器已完成 dry-run 记录。");
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
      setToast("执行器运行失败，请查看顶部错误提示。");
    } finally {
      setLoading(false);
    }
  }

  async function updateRealWriteAuthorization(enabled: boolean) {
    setLoading(true);
    try {
      if (!hasTauriRuntime()) {
        setSnapshot(previous => updatePreviewRealWriteAuthorization(previous ?? createPreviewSnapshot(), enabled));
        setLoadError("");
        setToast(enabled ? "浏览器预览已模拟开启真实写入授权。" : "浏览器预览已模拟关闭真实写入授权。");
        return;
      }

      const result = await invoke<LegacySnapshot>("set_real_write_authorization", { enabled });
      setSnapshot(result);
      setLoadError("");
      setToast(
        enabled
          ? "真实写入授权已开启；点击“同步 / 刷新”会运行 GitHub 更新和 AI 工具链接同步。"
          : "真实写入授权已关闭；同步按钮只刷新索引，不会改 Claude/Codex/Antigravity。"
      );
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
      setToast("真实写入授权更新失败，请查看顶部错误提示。");
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
    if (!hasTauriRuntime()) {
      return;
    }

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
      setLoadError(error instanceof Error ? error.message : String(error));
    }
  }

  async function refreshSourcePopularity(options: { quiet?: boolean; background?: boolean } = {}): Promise<LegacySnapshot | null> {
    if (!hasTauriRuntime()) {
      setSnapshot(previous => previous ?? createPreviewSnapshot());
      if (!options.quiet) {
        setToast("浏览器预览不会请求 GitHub；桌面版会把热度缓存到 SQLite。");
      }
      return snapshot ?? createPreviewSnapshot();
    }

    if (!options.background) {
      setLoading(true);
    }
    try {
      const result = await invoke<LegacySnapshot>("refresh_source_popularity");
      setSnapshot(result);
      setLoadError("");
      const refreshed = result.sourcePopularity.filter(source => source.cacheStatus === "fresh").length;
      const failed = result.sourcePopularity.filter(source => source.cacheStatus === "error").length;
      if (!options.quiet) {
        setToast(`GitHub 热度已刷新：${refreshed} 个成功，${failed} 个失败。趋势需要至少两次刷新才会出现变化。`);
      }
      return result;
    } catch (error) {
      setLoadError(messageFromError(error));
      if (!options.quiet) {
        setToast("GitHub 热度刷新失败；已保留旧缓存。");
      }
      return null;
    } finally {
      if (!options.background) {
        setLoading(false);
      }
    }
  }

  async function syncAndRefreshAll(): Promise<LegacySnapshot | null> {
    if (operation) {
      setToast("同步已经在后台运行，请等待当前任务完成。");
      return snapshot;
    }

    setOperation({
      title: "同步并刷新",
      detail: realWritesEnabled ? "正在更新 GitHub 来源并同步 AI 工具链接。" : "正在刷新索引，不写入 AI 工具目录。",
      step: 1,
      total: 3,
      percent: 8
    });
    const refreshedIndex = await loadSnapshot("refresh", { background: true });
    if (!hasTauriRuntime()) {
      setOperation(null);
      return refreshedIndex;
    }

    setOperation({
      title: "同步并刷新",
      detail: "正在刷新 GitHub 星标、Fork 和热度缓存。",
      step: 2,
      total: 3,
      percent: 42
    });
    const refreshedPopularity = await refreshSourcePopularity({ quiet: true, background: true });
    if (!refreshedPopularity) {
      setToast("索引已刷新；GitHub 热度刷新失败，来源列表保留旧缓存。");
      setOperation(null);
      return refreshedIndex;
    }

    const refreshed = refreshedPopularity.sourcePopularity.filter(source => source.cacheStatus === "fresh").length;
    const failed = refreshedPopularity.sourcePopularity.filter(source => source.cacheStatus === "error").length;
    const syncSummary = refreshedIndex?.operatorConsent?.realWritesEnabled
      ? "已同步 AI 工具并刷新索引"
      : "已刷新索引，未写入 AI 工具";
    setOperation({
      title: "同步并刷新",
      detail: "完成，正在更新界面。",
      step: 3,
      total: 3,
      percent: 100
    });
    setToast(`${syncSummary}；GitHub 热度 ${refreshed} 个成功、${failed} 个失败。`);
    window.setTimeout(() => setOperation(null), 900);
    return refreshedPopularity;
  }

  async function previewSourceImportCandidate(
    importKind: string,
    input: string,
    options: ImportFeedbackOptions = {}
  ): Promise<SourceImportPlanCard> {
    if (!hasTauriRuntime()) {
      const preview = createPreviewSourceImportPlan(importKind, input, snapshot?.sources ?? []);
      if (!options.quiet) {
        setToast(preview.safeToContinue ? "已生成浏览器导入 dry-run 预览。" : "已生成浏览器预览；存在需要处理的风险。");
      }
      return preview;
    }

    const result = await invoke<SourceImportPlanCard>("preview_source_import_candidate", { importKind, input });
    if (!options.quiet) {
      setToast(result.safeToContinue ? "导入 dry-run 已生成，未写入任何目录。" : "导入 dry-run 已生成，但当前计划不能继续。");
    }
    return result;
  }

  async function stageSourceImportCandidate(
    importKind: string,
    input: string,
    options: ImportFeedbackOptions = {}
  ): Promise<SourceImportExecutionCard> {
    if (!hasTauriRuntime()) {
      const execution = createPreviewSourceImportExecution(importKind, input);
      if (!options.quiet) {
        setToast("浏览器预览已模拟 staging；桌面版才会写入隔离 staging 目录。");
      }
      return execution;
    }

    const result = await invoke<SourceImportExecutionCard>("stage_source_import_candidate", { importKind, input });
    if (!options.quiet) {
      setToast(
        result.status === "staged"
          ? "来源已写入隔离 staging，正式安装仍未开放。"
          : "staging 执行完成；请查看阻断项和报告。"
      );
    }
    return result;
  }

  async function promoteStagedSourceImport(
    importKind: string,
    stagedPath: string,
    sourceName: string,
    options: ImportFeedbackOptions = {}
  ): Promise<SourceImportPromotionCard> {
    if (!hasTauriRuntime()) {
      const promotion = createPreviewSourceImportPromotion(importKind, stagedPath, sourceName);
      if (!options.quiet) {
        setToast("浏览器预览已模拟提升；桌面版才会写入 app/github_sources。");
      }
      return promotion;
    }

    const result = await invoke<SourceImportPromotionCard>("promote_staged_source_import", {
      importKind,
      stagedPath,
      sourceName
    });
    if (!options.quiet) {
      setToast(
        result.status === "promoted"
          ? "来源已提升为受管理来源；AI 工具同步仍保持锁定。"
          : "提升被阻止，请查看结果卡片。"
      );
    }
    return result;
  }

  useEffect(() => {
    void loadSnapshot();
  }, []);

  useEffect(() => {
    document.body.dataset.theme = theme;
    window.localStorage.setItem("ai-skillhub-theme", theme);
  }, [theme]);

  useEffect(() => {
    const handler = (event: Event) => {
      const message = (event as CustomEvent<string>).detail;
      if (message) {
        setToast(message);
      }
    };
    window.addEventListener(TOAST_EVENT, handler as EventListener);
    return () => window.removeEventListener(TOAST_EVENT, handler as EventListener);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (!operation || operation.percent >= 100) return;
    const timer = window.setInterval(() => {
      setOperation(current => {
        if (!current || current.percent >= 100) return current;
        const phaseStart = ((current.step - 1) / current.total) * 100;
        const phaseEnd = Math.min(96, (current.step / current.total) * 100 - 3);
        if (current.percent >= phaseEnd) return current;
        const increment = current.percent < phaseStart + 18 ? 2 : 1;
        return {
          ...current,
          percent: Math.min(phaseEnd, current.percent + increment)
        };
      });
    }, 520);
    return () => window.clearInterval(timer);
  }, [operation?.step, operation?.total]);

  const operationProgress = operation ? Math.max(1, Math.min(100, Math.round(operation.percent))) : 0;

  return (
    <main className={`${runtimeAvailable ? "shell" : "shell browser-preview-shell"} theme-${theme}`}>
      <aside className="sidebar">
        <div className="brand">
          <img alt="AI SkillHub" className="brand-logo" src="/ai-skillhub-logo.png" />
          <div>
            <strong>AI SkillHub</strong>
            <span>Management Platform</span>
          </div>
        </div>

        <nav className="nav">
          {navItems.map(item => (
            <button
              className={active === item.key ? "nav-item active" : "nav-item"}
              key={item.key}
              onClick={() => setActive(item.key)}
              type="button"
            >
              <span className="nav-icon" aria-hidden="true"><Icon name={item.icon} /></span>
              <strong>{item.label}</strong>
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
            <strong>Settings</strong>
          </button>
          <button
            className={active === "release" || active === "snapshots" ? "nav-item active" : "nav-item"}
            onClick={() => setActive("release")}
            type="button"
          >
            <span className="nav-icon" aria-hidden="true"><Icon name="release" /></span>
            <strong>高级安全</strong>
          </button>
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div className="command-search">
            <span className="search-icon" aria-hidden="true"><Icon name="search" /></span>
            <input
              aria-label="Search sources and skills"
              onChange={event => setGlobalSearch(event.target.value)}
              onKeyDown={event => {
                if (event.key !== "Enter" || !globalSearch.trim()) return;
                setActive(
                  queryLooksLikeSkillCommand(globalSearch) || globalSearchResults.skills.length > globalSearchResults.sources.length
                    ? "library"
                    : "sources"
                );
              }}
              placeholder="搜索来源和 Skills；例如 /nature 或 research-writing"
              value={globalSearch}
            />
            <kbd>⌘</kbd>
            <kbd>K</kbd>
          </div>
          <div className="topbar-actions">
            <button
              className="icon-button"
              aria-label="Notifications"
              onClick={() => showUiToast("通知中心将在 Diagnostics 与 Release Gate 接入。")}
              type="button"
            >
              <Icon name="bell" />
            </button>
            <button
              className="theme-mode-button"
              aria-label={theme === "dark" ? "当前暗色主题，点击切换到亮色主题" : "当前亮色主题，点击切换到暗色主题"}
              onClick={() => {
                const nextTheme = theme === "dark" ? "light" : "dark";
                setTheme(nextTheme);
                showUiToast(nextTheme === "dark" ? "已切换到暗色 Linear 主题。" : "已切换到亮色 Parchment 主题。");
              }}
              title={theme === "dark" ? "当前暗色主题，点击切换到亮色主题" : "当前亮色主题，点击切换到暗色主题"}
              type="button"
            >
              <Icon name={theme === "dark" ? "moon" : "sun"} />
              <span>主题：{theme === "dark" ? "暗色" : "亮色"}</span>
            </button>
            <span className="topbar-divider" />
            <img alt="AI SkillHub" className="topbar-avatar" src="/ai-skillhub-logo.png" />
            <button
              className="ghost-button sr-refresh"
              disabled={loading || Boolean(operation)}
              onClick={() => void syncAndRefreshAll()}
              type="button"
            >
              {runtimeAvailable
                ? operation
                  ? "后台同步中"
                  : loading
                    ? "正在同步"
                  : realWritesEnabled
                    ? "同步并刷新"
                    : "刷新索引"
                : loading
                  ? "正在载入"
                  : "重载预览"}
            </button>
            <div className={runtimeAvailable ? "status-pill" : "status-pill preview"}>
              {runtimeAvailable
                ? realWritesEnabled
                  ? "已授权 · 可同步 AI 工具"
                  : "未授权 · 只刷新索引"
                : "浏览器预览 · 桌面窗口读取真实数据"}
            </div>
          </div>
        </header>

        {!runtimeAvailable && (
          <section className="panel preview-panel">
            <strong>当前是浏览器预览模式</strong>
            <span>这里不会读取真实 SQLite，也不会接管本机 AI 工具；用 Tauri 桌面窗口打开时会显示真实数据。</span>
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
            <div>
              <strong>操作未完成</strong>
              <span>{friendlyErrorMessage(loadError)}</span>
            </div>
          </section>
        )}

        {globalSearch.trim() && (
          <GlobalSearchResults
            onClear={() => setGlobalSearch("")}
            onOpenLibrary={() => setActive("library")}
            onOpenSources={() => setActive("sources")}
            onCopySkill={skill => void copySkillPrompt(skill, recordUsage)}
            query={globalSearch}
            skills={globalSearchResults.skills}
            sources={globalSearchResults.sources}
          />
        )}

        {active === "dashboard" && (
          <Dashboard
            loading={loading}
            onOpenRelease={() => setActive("release")}
            onOpenSources={() => setActive("sources")}
            onRefreshPopularity={() => void refreshSourcePopularity()}
            onSync={() => void syncAndRefreshAll()}
            snapshot={snapshot}
            summary={summary}
          />
        )}
        {active === "library" && (
          <Library
            loading={loading}
            onOpenSources={() => setActive("sources")}
            onRecordUsage={recordUsage}
            onSetSkillEnabled={updateSkillEnabled}
            onSaveMetadata={updateSkillMetadata}
            onSync={() => void syncAndRefreshAll()}
            searchQuery={globalSearch}
            snapshot={snapshot}
          />
        )}
        {active === "workspaces" && <Workspaces disabled={loading} onToggle={updateEnabled} snapshot={snapshot} />}
        {active === "presets" && (
          <Presets
            disabled={loading}
            onToggle={updateEnabled}
            onToggleDistribution={updatePresetWorkspaceDistribution}
            snapshot={snapshot}
          />
        )}
        {active === "sources" && (
          <Sources
            loading={loading}
            onBulkSaveMetadata={updateSourcesBulkMetadata}
            onPreviewImport={previewSourceImportCandidate}
            onStageImport={stageSourceImportCandidate}
            onPromoteImport={promoteStagedSourceImport}
            onRefreshIndex={() => syncAndRefreshAll()}
            onRealWriteAuthorization={updateRealWriteAuthorization}
            onSaveMetadata={updateSourceMetadata}
            onSetSkillConflictChoice={updateSkillConflictChoice}
            snapshot={snapshot}
            searchQuery={globalSearch}
          />
        )}
        {active === "agents" && <Agents disabled={loading} onToggle={updateEnabled} snapshot={snapshot} />}
        {active === "snapshots" && <Snapshots snapshot={snapshot} />}
        {active === "release" && (
          <ReleaseGate
            disabled={loading}
            onRealWriteAuthorization={updateRealWriteAuthorization}
            onRunRunner={runReleaseGateRunner}
            snapshot={snapshot}
          />
        )}
        {active === "settings" && (
          <Settings
            disabled={loading}
            onOpenRelease={() => setActive("release")}
            onOpenSnapshots={() => setActive("snapshots")}
            onQaStatus={updateDesktopQaStatus}
            snapshot={snapshot}
          />
        )}
        <div className={toast ? "toast is-visible" : "toast"} role="status">
          {toast}
        </div>
      </section>
    </main>
  );
}

function GlobalSearchResults({
  onClear,
  onCopySkill,
  onOpenLibrary,
  onOpenSources,
  query,
  skills,
  sources
}: {
  onClear: () => void;
  onCopySkill: (skill: SkillCard) => void;
  onOpenLibrary: () => void;
  onOpenSources: () => void;
  query: string;
  skills: SkillCard[];
  sources: SourceCard[];
}) {
  const skillCommand = queryLooksLikeSkillCommand(query);

  return (
    <section className="global-search-results" role="search">
      <div className="global-search-head">
        <div>
          <strong>正在搜索：{query.trim()}</strong>
          <span>
            {skillCommand
              ? "已按 Skill 调用名搜索。点击复制后，可直接把调用提示粘贴给 Codex / Claude。"
              : "默认同时筛选 Sources 和 Skill Library。按 Enter 会跳到匹配更多的一页。"}
          </span>
        </div>
        <button className="ghost-action compact" onClick={onClear} type="button">清空</button>
      </div>
      <div className="global-search-columns">
        {!skillCommand && (
        <div>
          <button className="search-column-title" onClick={onOpenSources} type="button">
            Sources <span>{sources.length}</span>
          </button>
          {sources.length === 0 ? (
            <small className="search-empty">来源库没有匹配项。</small>
          ) : (
            sources.map(source => (
              <button className="search-result-item" key={source.id} onClick={onOpenSources} type="button">
                <strong>{source.name}</strong>
                <span>{categoryDisplayName(source.categoryId)} · {sourceTypeLabel(source.sourceType)}</span>
              </button>
            ))
          )}
        </div>
        )}
        <div>
          <button className="search-column-title" onClick={onOpenLibrary} type="button">
            Skill Library <span>{skills.length}</span>
          </button>
          {skills.length === 0 ? (
            <small className="search-empty">技能库没有匹配项。</small>
          ) : (
            skills.map(skill => (
              <div className="search-result-item search-result-skill" key={skill.folderName}>
                <button className="search-result-main" onClick={onOpenLibrary} type="button">
                  <strong>/{skill.name}</strong>
                  <span>{categoryDisplayName(skill.category)} · {skill.source || "local"} · {skill.folderName}</span>
                </button>
                <button className="search-result-copy" onClick={() => onCopySkill(skill)} type="button">
                  复制调用
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </section>
  );
}

function Icon({ className = "", name }: { className?: string; name: IconName }) {
  const props = {
    className: `ui-icon ${className}`.trim(),
    fill: "none",
    stroke: "currentColor",
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    strokeWidth: 1.8,
    viewBox: "0 0 24 24"
  };

  switch (name) {
    case "add":
      return <svg {...props}><path d="M12 5v14M5 12h14" /></svg>;
    case "agent":
      return <svg {...props}><circle cx="12" cy="12" r="7" /><circle cx="12" cy="12" r="2.5" /><path d="M12 3v2M21 12h-2M12 21v-2M3 12h2" /></svg>;
    case "alert":
      return <svg {...props}><path d="M12 4 21 20H3L12 4Z" /><path d="M12 9v5M12 17h.01" /></svg>;
    case "bell":
      return <svg {...props}><path d="M18 9a6 6 0 1 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9Z" /><path d="M10 21h4" /></svg>;
    case "dashboard":
      return <svg {...props}><rect x="4" y="4" width="6" height="6" /><rect x="14" y="4" width="6" height="6" /><rect x="4" y="14" width="6" height="6" /><rect x="14" y="14" width="6" height="6" /></svg>;
    case "edit":
      return <svg {...props}><path d="M4 20h4L19 9l-4-4L4 16v4Z" /><path d="m13.5 6.5 4 4" /></svg>;
    case "help":
      return <svg {...props}><circle cx="12" cy="12" r="9" /><path d="M9.8 9a2.4 2.4 0 0 1 4.6 1c0 1.8-2.4 2.1-2.4 4" /><path d="M12 17h.01" /></svg>;
    case "info":
      return <svg {...props}><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></svg>;
    case "library":
      return <svg {...props}><path d="M6 4h10a2 2 0 0 1 2 2v14H8a2 2 0 0 1-2-2V4Z" /><path d="M8 18h10M9 8h6M9 12h5" /></svg>;
    case "list":
      return <svg {...props}><path d="M8 6h12M8 12h12M8 18h12" /><path d="M4 6h.01M4 12h.01M4 18h.01" /></svg>;
    case "menu":
      return <svg {...props}><path d="M5 7h14M5 12h14M5 17h14" /></svg>;
    case "moon":
      return <svg {...props}><path d="M20 15.5A8.5 8.5 0 0 1 8.5 4 7 7 0 1 0 20 15.5Z" /></svg>;
    case "more":
      return <svg {...props}><circle cx="12" cy="5" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="12" cy="19" r="1" /></svg>;
    case "refresh":
      return <svg {...props}><path d="M20 6v5h-5" /><path d="M4 18v-5h5" /><path d="M18 11a6 6 0 0 0-10-4.5L4 10" /><path d="M6 13a6 6 0 0 0 10 4.5L20 14" /></svg>;
    case "release":
      return <svg {...props}><path d="M12 4 21 20H3L12 4Z" /></svg>;
    case "search":
      return <svg {...props}><circle cx="11" cy="11" r="7" /><path d="m16.5 16.5 3.5 3.5" /></svg>;
    case "settings":
      return <svg {...props}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2 3-.2-.1a1.8 1.8 0 0 0-2 .2 1.7 1.7 0 0 0-.8 1.7V22h-3.6v-.2a1.7 1.7 0 0 0-.8-1.7 1.8 1.8 0 0 0-2-.2l-.2.1-2-3 .1-.1A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.5-1.1H3v-3.8h.1A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.3-1.9l-.1-.1 2-3 .2.1a1.8 1.8 0 0 0 2-.2 1.7 1.7 0 0 0 .8-1.7V2h3.6v.2a1.7 1.7 0 0 0 .8 1.7 1.8 1.8 0 0 0 2 .2l.2-.1 2 3-.1.1A1.7 1.7 0 0 0 19.4 9a1.7 1.7 0 0 0 1.5 1.1h.1v3.8h-.1A1.7 1.7 0 0 0 19.4 15Z" /></svg>;
    case "snapshots":
      return <svg {...props}><path d="m12 3 9 9-9 9-9-9 9-9Z" /><path d="m12 8 4 4-4 4-4-4 4-4Z" /></svg>;
    case "sources":
      return <svg {...props}><rect x="5" y="4" width="14" height="16" rx="2" /><path d="M8 8h8M8 12h8M8 16h5" /></svg>;
    case "sparkle":
      return <svg {...props}><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Z" /><path d="m18 15 .7 2.3L21 18l-2.3.7L18 21l-.7-2.3L15 18l2.3-.7L18 15Z" /></svg>;
    case "sun":
      return <svg {...props}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>;
    case "workspaces":
      return <svg {...props}><circle cx="6" cy="6" r="2" /><circle cx="18" cy="6" r="2" /><circle cx="6" cy="18" r="2" /><circle cx="18" cy="18" r="2" /><path d="M8 6h8M6 8v8M18 8v8M8 18h8" /></svg>;
  }
}

function Dashboard({
  loading,
  onOpenRelease,
  onOpenSources,
  onRefreshPopularity,
  onSync,
  snapshot,
  summary
}: {
  loading: boolean;
  onOpenRelease: () => void;
  onOpenSources: () => void;
  onRefreshPopularity: () => void;
  onSync: () => void;
  snapshot: LegacySnapshot | null;
  summary: LegacySummary;
}) {
  const backupBlocked = countByStatus(snapshot?.backupDryRun ?? [], "blocked");
  const restoreBlocked = countByStatus(snapshot?.restoreDryRun ?? [], "blocked");
  const lockedRollback = (snapshot?.rollbackPlan ?? []).filter(step => step.status === "locked").length;
  const desktopQaStatus = desktopQaGateStatus(snapshot?.desktopQaChecks ?? []);
  const releaseReportsOk = (snapshot?.releaseReports ?? []).filter(report => report.ok).length;
  const releaseReportsTotal = Math.max((snapshot?.releaseReports ?? []).length, 1);
  const readinessScore = Math.max(
    20,
    Math.min(
      92,
      Math.round(
        (summary.diagnosticsStatus === "ok" ? 28 : 10) +
          (backupBlocked === 0 ? 22 : 8) +
          (restoreBlocked === 0 ? 18 : 6) +
          (desktopQaStatus === "done" ? 16 : desktopQaStatus === "blocked" ? 3 : 8) +
          (releaseReportsOk / releaseReportsTotal) * 8
      )
    )
  );
  const healthIssues = summary.warnings + backupBlocked + restoreBlocked + lockedRollback;
  const readinessRows = [
    {
      label: "Core Safety Gate",
      value: readinessScore,
      caption: `${summary.diagnosticsStatus} diagnostics · ${summary.warnings} warnings`
    },
    {
      label: "Backup / Restore Dry Run",
      value: backupBlocked + restoreBlocked === 0 ? 72 : 38,
      caption: `${backupBlocked + restoreBlocked} blocking checks`
    },
    {
      label: "Release Package Readiness",
      value: desktopQaStatus === "done" ? 66 : 24,
      caption: desktopQaGateLabel(snapshot?.desktopQaChecks ?? [])
    }
  ];
  const alerts = [
    {
      icon: "alert" as const,
      title: healthIssues > 0 ? "Safety Gate Requires Review" : "Safety Gate Clear",
      body:
        healthIssues > 0
          ? `${healthIssues} items still need review before deployment.`
          : "No blocking release issue is currently visible.",
      action: "Inspect Gate"
    },
    {
      icon: "refresh" as const,
      title: loading ? "Index Refresh Running" : "SQLite Index Ready",
      body: snapshot?.index.databaseFile
        ? "Current dashboard is loaded from the local SQLite index."
        : "Refresh once to seed the local SQLite index.",
      action: loading ? "Watching" : "Open Index"
    },
    {
      icon: "info" as const,
      title: "Daily Driver Mode",
      body: "AI SkillHub now manages sources, metadata, staging, QA, and calls the proven sync engine when real-write authorization is enabled.",
      action: "Open Sources"
    }
  ];

  return (
    <div className="view command-center">
      <section className="command-hero">
        <div>
          <h2>Command Center</h2>
          <p>System overview and AI skill deployment status.</p>
        </div>
        <div className="hero-actions">
          <button className="secondary-action" disabled={loading} onClick={onSync} type="button">
            <Icon name="refresh" /> {loading ? "正在同步" : "同步 / 刷新"}
          </button>
          <button className="primary-action" onClick={onOpenSources} type="button">
            <Icon name="add" /> 添加来源
          </button>
        </div>
      </section>

      <section className="metrics command-metrics">
        <Metric accent="violet" icon="sparkle" label="Active Skills" trend={`+${summary.sources} sources indexed`} value={summary.skills} />
        <Metric accent="indigo" icon="sources" label="Sources Indexed" trend={`${summary.prompts} prompt collections`} value={summary.sources} />
        <Metric accent="amber" icon="agent" label="AI Agents" trend={`${summary.agentsDetected} detected locally`} value={summary.agentsDetected} />
        <Metric accent="rose" icon="alert" label="Health Issues" trend={healthIssues > 0 ? "Requires attention" : "All clear"} value={healthIssues} />
      </section>

      <section className="command-grid">
        <article className="linear-panel readiness-command-panel">
          <header className="linear-panel-head">
            <h3>Release Readiness</h3>
            <button className="pipeline-link" onClick={onOpenRelease} type="button">
              View Pipeline →
            </button>
          </header>
          <div className="readiness-stack">
            {readinessRows.map(row => (
              <div className="readiness-row" key={row.label}>
                <div>
                  <strong>{row.label}</strong>
                  <span>{row.caption}</span>
                </div>
                <b>{row.value}%</b>
                <div className="linear-progress">
                  <i style={{ width: `${row.value}%` }} />
                </div>
              </div>
            ))}
          </div>
          <UsageInsightPanel loading={loading} onRefreshPopularity={onRefreshPopularity} snapshot={snapshot} />
        </article>

        <aside className="linear-panel alerts-panel">
          <header className="linear-panel-head">
            <h3><Icon name="alert" /> Active Alerts</h3>
            <em>{healthIssues} SYS</em>
          </header>
          <div className="alert-list">
            {alerts.map(alert => (
              <article className="alert-item" key={alert.title}>
                <span className="alert-icon"><Icon name={alert.icon} /></span>
                <div>
                  <strong>{alert.title}</strong>
                  <p>{alert.body}</p>
                  <small>{alert.action}</small>
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
    <section className="activity-timeline" aria-label="Activity timeline">
      <header>
        <strong>Activity Timeline</strong>
        <span>{events.length} logs</span>
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
        {events.length === 0 && <p className="empty-activity">暂无本地操作历史。</p>}
      </div>
    </section>
  );
}

type UsageRange = "all" | "7d" | "30d";
type UsageViewMode = "heatmap" | "bars" | "trends";
type UsageHeatMetricKey = "usage" | "sevenDay" | "thirtyDay" | "stars" | "forks" | "skills";

const usageHeatMetrics: Array<{ key: UsageHeatMetricKey; label: string }> = [
  { key: "usage", label: "调用" },
  { key: "sevenDay", label: "7 天" },
  { key: "thirtyDay", label: "30 天" },
  { key: "stars", label: "星标" },
  { key: "forks", label: "分叉" },
  { key: "skills", label: "Skills" }
];

function sourcePopularityDisplayName(source: Pick<SourcePopularityCard, "owner" | "repo" | "sourceName">) {
  const repoName = [source.owner, source.repo].filter(Boolean).join("/");
  const sourceName = source.sourceName?.trim();
  if (!sourceName) return repoName || source.repo || "unknown-source";
  if (repoName && (sourceName === source.repo || sourceName.toLowerCase() === "skills")) {
    return repoName;
  }
  return sourceName;
}

function isInternalRouterSource(source: Pick<SourceCard, "name" | "url">) {
  return source.name.trim().toLowerCase() === "ai-skillhub-local-routers" && !source.url.trim();
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
  const rangeFactor = range === "all" ? 1 : range === "30d" ? 0.62 : 0.34;
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

  const rankedSkills = useMemo(() => {
    const realSkillStats = usageStats
      .filter(stat => stat.targetType === "skill")
      .map(stat => ({
        name: stat.targetName,
        category: skills.find(skill => skill.folderName === stat.targetId)?.category || "usage",
        score: statScore(stat)
      }))
      .filter(stat => stat.score > 0)
      .sort((a, b) => b.score - a.score);

    if (realSkillStats.length > 0) {
      return realSkillStats;
    }

    return skills
      .map((skill, index) => ({
        name: skill.name,
        category: skill.category || "uncategorized",
        score: Math.max(
          1,
          Math.round(
            ((skill.enabled ? 48 : 18) +
              (skill.health === "ok" ? 24 : skill.health === "warn" ? 12 : 6) +
              Math.max(0, 18 - (index % 19))) *
              rangeFactor
          )
        )
      }))
      .sort((a, b) => b.score - a.score);
  }, [range, rangeFactor, skills, usageStats]);

  const rankedSources = useMemo(() => {
    const popularityStats = sourcePopularity
      .map(source => ({
        cacheStatus: source.cacheStatus,
        forks: source.forks,
        name: sourcePopularityDisplayName(source),
        score: sourceScore(source),
        stars: source.stars
      }))
      .filter(source => source.score > 0 || source.stars > 0)
      .sort((a, b) => b.stars - a.stars || b.score - a.score);

    if (popularityStats.length > 0) {
      return popularityStats;
    }

    const realSourceStats = usageStats
      .filter(stat => stat.targetType === "source")
      .map(stat => ({ cacheStatus: "", forks: 0, name: stat.targetName, score: statScore(stat), stars: 0 }))
      .filter(stat => stat.score > 0)
      .sort((a, b) => b.score - a.score);

    if (realSourceStats.length > 0) {
      return realSourceStats;
    }

    return displaySources
      .map((source, index) => ({
        cacheStatus: "",
        forks: 0,
        name: source.name,
        score: Math.max(1, Math.round(((source.skillCount || 1) * 6 + Math.max(0, 14 - index)) * rangeFactor)),
        stars: 0
      }))
      .sort((a, b) => b.score - a.score);
  }, [displaySources, range, rangeFactor, sourcePopularity, usageStats]);

  const heatRows = useMemo(() => {
    const rows: Array<{
      id: string;
      label: string;
      type: string;
      metrics: Record<UsageHeatMetricKey, number>;
    }> = [];
    const seen = new Set<string>();

    sourcePopularity.forEach(source => {
      const matchedSource = displaySources.find(
        item =>
          item.id === source.sourceId ||
          item.name === source.sourceName ||
          (!!source.url && item.url === source.url)
      );
      const id = source.sourceId || matchedSource?.id || `${source.owner}/${source.repo}`;
      seen.add(id);
      if (matchedSource) seen.add(matchedSource.id);
      rows.push({
        id,
        label: sourcePopularityDisplayName(source),
        type: matchedSource?.sourceType || "GitHub",
        metrics: {
          forks: source.forks,
          sevenDay: source.localSevenDayCount,
          skills: matchedSource?.skillCount ?? 0,
          stars: source.stars,
          thirtyDay: source.localThirtyDayCount,
          usage: sourceScore(source)
        }
      });
    });

    displaySources.forEach(source => {
      if (seen.has(source.id) || rows.some(row => row.label === source.name)) return;
      const usage = usageStats.find(stat => stat.targetType === "source" && (stat.targetId === source.id || stat.targetName === source.name));
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
          usage: usage ? statScore(usage) : Math.max(0, source.skillCount)
        }
      });
    });

    if (rows.length === 0) {
      const seed = skills.length + (snapshot?.summary.warnings ?? 0) * 5;
      return Array.from({ length: 8 }, (_, index) => ({
        id: `fallback-${index}`,
        label: `来源 ${index + 1}`,
        type: "preview",
        metrics: {
          forks: 0,
          sevenDay: (seed + index * 2) % 8,
          skills: (seed + index * 5) % 14,
          stars: (seed + index * 13) % 90,
          thirtyDay: (seed + index * 3) % 18,
          usage: (seed + index * 7) % 30
        }
      }));
    }

    return rows.sort((a, b) => b.metrics.usage - a.metrics.usage || b.metrics.stars - a.metrics.stars || a.label.localeCompare(b.label));
  }, [displaySources, range, skills.length, snapshot?.summary.warnings, sourcePopularity, usageStats]);

  const heatMaxByMetric = useMemo(
    () =>
      usageHeatMetrics.reduce<Record<UsageHeatMetricKey, number>>((acc, metric) => {
        acc[metric.key] = Math.max(...heatRows.map(row => row.metrics[metric.key]), 1);
        return acc;
      }, { forks: 1, sevenDay: 1, skills: 1, stars: 1, thirtyDay: 1, usage: 1 }),
    [heatRows]
  );

  const barRows = useMemo(() => {
    const rows = [
      ...rankedSources.map(source => ({ label: source.name, score: source.stars || source.score, type: "Source" })),
      ...rankedSkills.map(skill => ({ label: skill.name, score: skill.score, type: "Skill" }))
    ].filter(row => row.score > 0);
    const max = Math.max(...rows.map(row => row.score), 1);
    return rows
      .sort((a, b) => b.score - a.score || a.label.localeCompare(b.label))
      .map(row => ({
        ...row,
        level: heatLevel(row.score, max),
        scoreLabel: formatCompactNumber(row.score),
        width: Math.max(6, Math.round((row.score / max) * 100))
      }));
  }, [rankedSkills, rankedSources]);

  const githubLeaders = sourcePopularity
    .filter(source => source.stars > 0 || source.cacheStatus === "error")
    .slice()
    .sort((a, b) => b.stars - a.stars || b.localTotalCount - a.localTotalCount)
    .slice(0, 3);

  const usedSkillIds = new Set(usageStats.filter(stat => stat.targetType === "skill").map(stat => stat.targetId));
  const lowUseSkills = skills
    .filter(skill => skill.enabled && !usedSkillIds.has(skill.folderName))
    .slice(0, 3)
    .map(skill => ({ name: skill.name, score: 0 }));
  const fallbackLowUseSkills = rankedSkills.slice(-3).reverse();

  const trendRows = useMemo(() => {
    const rows =
      sourcePopularity.length > 0
        ? sourcePopularity.map(source => {
            const points = source.trendPoints?.length > 0 ? source.trendPoints : [];
            const first = points[0]?.stars ?? 0;
            const last = points[points.length - 1]?.stars ?? source.stars;
            return {
              createdAt: source.createdAt,
              forks: source.forks,
              id: source.sourceId,
              name: sourcePopularityDisplayName(source),
              points,
              sampleCount: points.length,
              stars: source.stars,
              trendDelta: points.length >= 2 ? last - first : 0,
              usage: sourceScore(source)
            };
          })
        : sources.map(source => ({
            createdAt: "",
            forks: 0,
            id: source.id,
            name: source.name,
            points: [],
            sampleCount: 0,
            stars: 0,
            trendDelta: 0,
            usage: Math.max(0, source.skillCount)
          }));

    return rows
      .sort((a, b) => b.stars - a.stars || b.usage - a.usage || a.name.localeCompare(b.name));
  }, [range, sourcePopularity, sources]);

  return (
    <section className="usage-insight" aria-label="Usage insight panel">
      <header>
        <div>
          <span>Usage Insights</span>
          <strong>常用 Skill 与来源热力</strong>
        </div>
        <div className="usage-toolbar">
          <div className="usage-range-toggle" aria-label="Usage range">
            {([
              ["all", "自安装以来"],
              ["7d", "7 天"],
              ["30d", "30 天"]
            ] as Array<[UsageRange, string]>).map(([key, label]) => (
              <button className={range === key ? "active" : ""} key={key} onClick={() => setRange(key)} type="button">
                {label}
              </button>
            ))}
          </div>
          <div className="usage-range-toggle" aria-label="Usage chart mode">
            {([
              ["heatmap", "热力图"],
              ["bars", "柱状图"],
              ["trends", "趋势"]
            ] as Array<[UsageViewMode, string]>).map(([key, label]) => (
              <button className={viewMode === key ? "active" : ""} key={key} onClick={() => setViewMode(key)} type="button">
                {label}
              </button>
            ))}
          </div>
          <button className="usage-refresh" disabled={loading} onClick={onRefreshPopularity} type="button">
            <Icon name="refresh" /> {loading ? "刷新中" : "刷新 GitHub 热度"}
          </button>
        </div>
      </header>

      <div className="usage-body">
        {viewMode === "heatmap" ? (
          <div className="usage-heatmap source-heatmap" aria-label="Source metric heatmap">
            <div className="heatmap-grid" style={{ "--heat-columns": usageHeatMetrics.length } as CSSProperties}>
              <span className="heatmap-corner">来源 / 指标</span>
              {usageHeatMetrics.map(metric => (
                <span className="heatmap-column" key={metric.key}>
                  {metric.label}
                </span>
              ))}
              {heatRows.map(row => (
                <Fragment key={row.id}>
                  <span className="heatmap-row-label" title={row.label}>
                    <strong>{row.label}</strong>
                    <em>{row.type}</em>
                  </span>
                  {usageHeatMetrics.map(metric => {
                    const value = row.metrics[metric.key];
                    const level = heatLevel(value, heatMaxByMetric[metric.key]);
                    return (
                      <span
                        aria-label={`${row.label} ${metric.label}: ${value}`}
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
            <div className="heatmap-legend" aria-label="Heatmap color legend">
              <span>低</span>
              {[0, 1, 2, 3, 4, 5, 6].map(level => (
                <i className={`heat-level-${level}`} key={level} />
              ))}
              <span>高</span>
            </div>
          </div>
        ) : viewMode === "bars" ? (
          <div className="usage-bars" aria-label="Skill usage bar chart">
            {barRows.map(row => (
              <div className="usage-bar-row" key={`${row.type}-${row.label}`}>
                <span>{row.label}</span>
                <i><b className={`bar-level-${row.level}`} style={{ width: `${row.width}%` }} /></i>
                <em>{row.scoreLabel}</em>
              </div>
            ))}
            {barRows.length === 0 && <p>暂无真实使用事件。</p>}
          </div>
        ) : (
          <div className="usage-trends" aria-label="GitHub source popularity trends">
            {trendRows.map(row => (
              <article className="trend-row" key={row.id}>
                <div>
                  <strong>{row.name}</strong>
                  <span>
                    ★ {formatCompactNumber(row.stars)} · Fork {formatCompactNumber(row.forks)} · 调用 {row.usage} · 采样 {row.sampleCount}
                  </span>
                </div>
                <MiniTrendLine points={row.points.map(point => point.stars)} />
                <em className={row.trendDelta >= 0 ? "trend-up" : "trend-down"}>
                  {row.sampleCount >= 2
                    ? `${row.trendDelta >= 0 ? "+" : "-"}${formatCompactNumber(Math.abs(row.trendDelta))}`
                    : "待二次刷新"}
                </em>
              </article>
            ))}
            {trendRows.length === 0 && <p>暂无 GitHub 来源；刷新来源热度后会记录历史点。</p>}
          </div>
        )}
        <div className="usage-lists">
          <article>
            <span>常用 Skill</span>
            {rankedSkills.slice(0, 5).map(skill => (
              <p key={skill.name}>
                <strong>{skill.name}</strong>
                <em>{skill.score}</em>
              </p>
            ))}
          </article>
          <article>
            <span>热门来源</span>
            {rankedSources.slice(0, 5).map(source => (
              <p key={source.name}>
                <strong>{source.name}</strong>
                <em>{source.stars > 0 ? `★ ${formatCompactNumber(source.stars)}` : `调用 ${source.score}`}</em>
              </p>
            ))}
          </article>
          <article>
            <span>GitHub 热度</span>
            {githubLeaders.length > 0 ? (
              githubLeaders.map(source => (
                <p key={source.sourceId}>
                  <strong>{sourcePopularityDisplayName(source)}</strong>
                  <em>★ {formatCompactNumber(source.stars)}</em>
                </p>
              ))
            ) : (
              <p>
                <strong>未刷新缓存</strong>
                <em>0</em>
              </p>
            )}
          </article>
          <article>
            <span>低频未用</span>
            {(lowUseSkills.length > 0 ? lowUseSkills : fallbackLowUseSkills).map(skill => (
              <p key={skill.name}>
                <strong>{skill.name}</strong>
                <em>{skill.score}</em>
              </p>
            ))}
          </article>
        </div>
      </div>
      <small>
        {sourcePopularity.some(source => source.fetchedAt)
          ? "GitHub 星标来自手动刷新缓存；趋势从 AI SkillHub 开始同步后精确记录，创建日前的完整历史无法由 GitHub 仓库接口直接还原。"
          : usageStats.length > 0
            ? "当前统计来自本地事件记录；GitHub 热度可手动刷新缓存。"
            : "还没有真实使用事件，当前展示为索引健康度推算。"}
      </small>
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
    <svg className="mini-trend-line" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="source popularity trend">
      <path d={path} />
    </svg>
  );
}

function Library({
  loading,
  onOpenSources,
  onRecordUsage,
  onSetSkillEnabled,
  onSaveMetadata,
  onSync,
  searchQuery,
  snapshot
}: {
  loading: boolean;
  onOpenSources: () => void;
  onRecordUsage: (
    targetType: string,
    targetId: string,
    targetName: string,
    sourceName: string,
    eventType: string
  ) => Promise<void>;
  onSetSkillEnabled: (skill: SkillCard, enabled: boolean) => Promise<boolean>;
  onSaveMetadata: (skill: SkillCard, draft: SkillDraft) => Promise<"failed" | "preview" | "saved">;
  onSync: () => void;
  searchQuery: string;
  snapshot: LegacySnapshot | null;
}) {
  const skills = snapshot?.skills ?? [];
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [healthFilter, setHealthFilter] = useState<string>("all");
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  const [openSkillMenuId, setOpenSkillMenuId] = useState<string>("");
  const [editingSkillId, setEditingSkillId] = useState<string>("");
  const [skillDrafts, setSkillDrafts] = useState<Record<string, SkillDraft>>({});
  const displaySkills = skills.map(skill => applySkillDraft(skill, skillDrafts[skill.folderName]));
  const searchActive = searchQuery.trim().length > 0;
  const collectionGroups = useMemo(() => deriveSkillCollectionGroups(displaySkills), [displaySkills]);
  const categories = CATEGORY_OPTIONS.filter(option =>
    displaySkills.some(skill => categoryMatchesFilter(skill.category, option.id))
  ).slice(0, 10);
  const filteredSkills = displaySkills.filter(skill => {
    const categoryMatches = searchActive || categoryFilter === "all" || categoryMatchesFilter(skill.category, categoryFilter);
    const healthMatches = searchActive || healthFilter === "all" || skill.health === healthFilter;
    const searchMatches = skillMatchesSearch(skill, searchQuery);
    return categoryMatches && healthMatches && searchMatches;
  });
  const editingSkill = displaySkills.find(skill => skill.folderName === editingSkillId);
  const healthCounts = {
    ok: displaySkills.filter(skill => skill.health === "ok").length,
    warn: displaySkills.filter(skill => skill.health === "warn").length,
    error: displaySkills.filter(skill => skill.health === "error").length,
    info: displaySkills.filter(skill => skill.health === "info").length
  };

  function openEditor(skill: SkillCard) {
    setEditingSkillId(skill.folderName);
    setOpenSkillMenuId("");
  }

  async function saveSkillDraft(skill: SkillCard, draft: SkillDraft) {
    const saveResult = await onSaveMetadata(skill, draft);
    if (saveResult === "preview") {
      setSkillDrafts(previous => ({ ...previous, [skill.folderName]: draft }));
      setEditingSkillId("");
      showUiToast("浏览器预览已保存为本次界面草稿。");
    }
    if (saveResult === "saved") {
      setSkillDrafts(previous => {
        const next = { ...previous };
        delete next[skill.folderName];
        return next;
      });
      setEditingSkillId("");
    }
  }

  async function toggleSkillEnabled(skill: SkillCard) {
    setOpenSkillMenuId("");
    const nextEnabled = !skill.enabled;
    const handledByDatabase = await onSetSkillEnabled(skill, nextEnabled);
    if (!handledByDatabase) {
      showUiToast("浏览器预览不会写入 Skill 启用状态，请用桌面版测试。");
    }
  }

  return (
    <div className="view skill-library-view">
      <section className="library-header">
        <div>
          <h2>Skill Library</h2>
          <p>Manage, configure, and monitor all active AI capabilities across your workspaces.</p>
        </div>
        <div className="library-actions">
          <button className="secondary-action library-action" disabled={loading} onClick={onSync} type="button">
            <Icon name="refresh" /> {loading ? "正在同步" : "同步来源"}
          </button>
          <button className="primary-action library-action" onClick={onOpenSources} type="button">
            <Icon name="add" /> 添加 Skill
          </button>
        </div>
      </section>

      <section className="library-controls glass-panel">
        <div className="library-filter-row" aria-label="Skill category filters">
          <button
            className={categoryFilter === "all" ? "filter-chip active" : "filter-chip"}
            onClick={() => setCategoryFilter("all")}
            type="button"
          >
            All Skills
          </button>
          {categories.map(category => (
            <button
              className={categoryFilter === category.id ? "filter-chip active" : "filter-chip"}
              key={category.id}
              onClick={() => setCategoryFilter(category.id)}
              type="button"
            >
              {category.label}
            </button>
          ))}
          <span className="filter-divider" />
          <button
            className={healthFilter === "ok" ? "filter-chip active" : "filter-chip"}
            onClick={() => setHealthFilter(healthFilter === "ok" ? "all" : "ok")}
            type="button"
          >
            <span className="status-dot healthy" />
            Healthy {healthCounts.ok}
          </button>
          <button
            className={healthFilter === "warn" ? "filter-chip active" : "filter-chip"}
            onClick={() => setHealthFilter(healthFilter === "warn" ? "all" : "warn")}
            type="button"
          >
            <span className="status-dot syncing" />
            Warnings {healthCounts.warn}
          </button>
          <button
            className={healthFilter === "error" ? "filter-chip active" : "filter-chip"}
            onClick={() => setHealthFilter(healthFilter === "error" ? "all" : "error")}
            type="button"
          >
            <span className="status-dot error" />
            Errors {healthCounts.error}
          </button>
        </div>
        <div className="view-toggle" aria-label="Skill view mode">
          <button
            className={viewMode === "grid" ? "active" : ""}
            onClick={() => setViewMode("grid")}
            type="button"
          >
            <Icon name="dashboard" />
          </button>
          <button
            className={viewMode === "list" ? "active" : ""}
            onClick={() => setViewMode("list")}
            type="button"
          >
            <Icon name="list" />
          </button>
        </div>
      </section>

      {searchActive && (
        <section className="search-scope-note">
          <strong>正在全库搜索 Skill</strong>
          <span>已临时忽略分类和健康筛选，找到 {filteredSkills.length} 个匹配项。可直接搜索 `/nature`、`/research-writing-skill` 或子 Skill 名。</span>
        </section>
      )}

      {collectionGroups.length > 0 && (
        <section className="skill-collection-panel glass-panel">
          <div className="collection-panel-copy">
            <span className="eyebrow">Skill Collections</span>
            <h3>母 Skill 负责选择路线，子 Skill 负责执行任务</h3>
            <p>
              不确定该用哪个时，先调用集合入口；已经知道具体任务时，直接调用子 Skill。
            </p>
          </div>
          <div className="collection-grid">
            {collectionGroups.slice(0, 6).map(group => (
              <article className="collection-card" key={group.name}>
                <div>
                  <strong>{group.name}</strong>
                  <span>{group.children.length} 个子 Skill</span>
                </div>
                <p>{group.childPreview.join(" / ")}</p>
                <button
                  className="secondary-action compact"
                  onClick={() => {
                    const targetSkill = group.parent ?? group.children[0];
                    if (targetSkill) {
                      void copySkillPrompt(targetSkill, onRecordUsage);
                    }
                  }}
                  type="button"
                >
                  <Icon name={group.parent ? "library" : "sparkle"} />
                  {group.parent ? "复制母入口调用" : "复制推荐子 Skill"}
                </button>
              </article>
            ))}
          </div>
        </section>
      )}

      <section className={viewMode === "grid" ? "skill-library-grid" : "skill-library-grid list-mode"}>
        {filteredSkills.map(skill => {
          const isRouter = isRouterHubSkill(skill);
          return (
          <article className={`skill-library-card glow-card ${skill.health}${isRouter ? " is-router" : ""}`} key={skill.folderName}>
            <div className="skill-card-top">
              <div className={`skill-card-icon ${categoryTone(skill.category)}`}>
                <Icon name={skillIcon(skill.category)} />
              </div>
              <div className="skill-card-status">
                <span
                  className={`kind-chip ${isRouter ? "router" : "child"}`}
                  title={isRouter
                    ? "母 Skill：负责为集合选择路线，不确定时调用它"
                    : "子 Skill：完成具体任务"}
                >
                  {isRouter ? "母 Skill" : "子 Skill"}
                </span>
                <span className={`status-badge ${skill.health}`}>
                  <span className={`status-dot ${statusDotClass(skill.health)}`} />
                  {skillStatusLabel(skill.health)}
                </span>
                <div className="card-menu-host">
                  <button
                    aria-expanded={openSkillMenuId === skill.folderName}
                    aria-label={`More actions for ${skill.name}`}
                    className="icon-action"
                    onClick={() => setOpenSkillMenuId(openSkillMenuId === skill.folderName ? "" : skill.folderName)}
                    type="button"
                  >
                    <Icon name="more" />
                  </button>
                  {openSkillMenuId === skill.folderName && (
                    <div className="card-popover" role="menu">
                      <button onClick={() => openEditor(skill)} role="menuitem" type="button">编辑名称/标签</button>
                      <button
                        onClick={() => {
                          setOpenSkillMenuId("");
                          void copySkillPrompt(skill, onRecordUsage);
                        }}
                        role="menuitem"
                        type="button"
                      >
                        复制调用提示
                      </button>
                      <button
                        onClick={() => {
                          void toggleSkillEnabled(skill);
                        }}
                        role="menuitem"
                        type="button"
                      >
                        {skill.enabled ? "停用 Skill" : "启用 Skill"}
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>
            <h3>{skill.name}</h3>
            <p>{cleanSkillDescription(skill.description) || "No description provided yet."}</p>
            <div className="skill-tags">
              <span>{categoryDisplayName(skill.category) || "Uncategorized"}</span>
              {skill.enabled ? <span>Enabled</span> : <span>Disabled</span>}
              {(skill.tags ?? []).slice(0, 4).map(tag => (
                <span className={`tag-chip ${categoryTone(tag)}`} key={tag}>{tag}</span>
              ))}
            </div>
            {skill.note && <div className="skill-note">备注：{skill.note}</div>}
            <footer>
              <div>
                <span aria-hidden="true"><Icon name="sources" /></span>
                <small>Source: {skill.source || skill.relativePath || "local"}</small>
              </div>
              <button
                aria-label={`Configure ${skill.name}`}
                className="icon-action"
                onClick={() => openEditor(skill)}
                type="button"
              >
                <Icon name="edit" />
              </button>
            </footer>
          </article>
          );
        })}
        {filteredSkills.length === 0 && (
          <div className="empty-state library-empty">
            {skills.length === 0 ? "正在等待历史 Skill 扫描结果。" : "当前筛选条件下没有 Skill。"}
          </div>
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
    </div>
  );
}

function deriveSkillCollectionGroups(skills: SkillCard[]): SkillCollectionGroup[] {
  const bySource = new Map<string, SkillCard[]>();

  for (const skill of skills) {
    const source = skill.source.trim();
    if (!source || source === "local" || source === "AI-SkillHub-local-routers") {
      continue;
    }
    bySource.set(source, [...(bySource.get(source) ?? []), skill]);
  }

  return Array.from(bySource.entries())
    .map(([source, sourceSkills]) => {
      const sourceKey = normalizeLookup(source);
      const parent = skills.find(skill => {
        const folderKey = normalizeLookup(skill.folderName);
        const nameKey = normalizeLookup(skill.name);
        return folderKey === sourceKey || nameKey === sourceKey;
      });
      const children = sourceSkills
        .filter(skill => skill.folderName !== parent?.folderName)
        .sort((left, right) => left.name.localeCompare(right.name));

      return {
        children,
        childPreview: children.slice(0, 4).map(skill => skill.name),
        name: source,
        parent
      };
    })
    // Loosened from >=3 to >=2 — small collections also benefit from the parent / child explanation.
    // Aligns with feedback that "有的可行有的不可行" — 2-child collections were silently dropped.
    .filter(group => group.children.length >= 2 || Boolean(group.parent))
    .sort((left, right) => {
      if (left.parent && !right.parent) return -1;
      if (!left.parent && right.parent) return 1;
      return right.children.length - left.children.length;
    });
}

// Strip the [ROUTER-HUB] / [CHILD-SKILL] marker prefix from a description so the
// human-readable text stays clean while the markers still exist in the underlying SKILL.md.
function cleanSkillDescription(value: string | undefined | null): string {
  if (!value) return "";
  return String(value).replace(/^\s*\[(?:ROUTER-HUB|CHILD-SKILL)\]\s*/i, "").trim();
}

// Decide whether this Skill is the parent / router-hub entry of a collection.
// Trusts the backend `isRouterHub` field first (single source of truth, populated
// by compute_is_router_hub() in lib.rs). Falls back to the same three heuristics
// only when the field is missing, e.g. when reading an older SQLite snapshot.
function isRouterHubSkill(skill: SkillCard): boolean {
  if (typeof skill.isRouterHub === "boolean") {
    return skill.isRouterHub;
  }
  const description = String(skill.description || "");
  if (description.indexOf("[ROUTER-HUB]") !== -1) return true;
  const source = String(skill.source || skill.relativePath || "");
  if (source.indexOf("AI-SkillHub-local-routers") !== -1) return true;
  if (skill.folderName && skill.source && normalizeLookup(skill.folderName) === normalizeLookup(skill.source)) {
    return true;
  }
  return false;
}

function normalizeLookup(value: string): string {
  return value.trim().toLowerCase().replace(/[_\s]+/g, "-");
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
    <aside aria-label={`${skill.name} details`} className="skill-editor-panel" role="dialog">
      <header>
        <div>
          <span>Skill Metadata</span>
          <strong>{skill.name}</strong>
        </div>
        <button aria-label="Close skill editor" className="icon-action" onClick={onClose} type="button">
          <Icon name="add" />
        </button>
      </header>
      <label>
        名称
        <input onChange={event => setName(event.target.value)} value={name} />
      </label>
      <label>
        细分分类 / 标签
        <input onChange={event => setCategory(event.target.value)} value={category} />
      </label>
      <label>
        多标签
        <input
          onChange={event => setTags(event.target.value)}
          placeholder="例如：论文科研, 写作, 常用"
          value={tags}
        />
      </label>
      <label>
        说明
        <textarea onChange={event => setDescription(event.target.value)} rows={4} value={description} />
      </label>
      <label>
        手动备注
        <textarea
          onChange={event => setNote(event.target.value)}
          placeholder="例如：适合论文初稿；暂不建议给所有工作区启用。"
          rows={3}
          value={note}
        />
      </label>
      <footer>
        <button className="secondary-action" onClick={onClose} type="button">取消</button>
        <button
          className="primary-action"
          onClick={() => onSave({ category, description, name, note, tags })}
          type="button"
        >
          保存
        </button>
      </footer>
    </aside>
  );
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
  const text = `请调用 ${skill.name} 这个 Skill，处理当前任务。适用场景：${skill.description || skill.category || "当前上下文"}`;
  try {
    await navigator.clipboard.writeText(text);
    showUiToast("已复制 Skill 调用提示。");
  } catch {
    showUiToast("复制权限不可用，但调用提示已在菜单动作中生成。");
  }
  await onRecordUsage?.("skill", skill.folderName, skill.name, skill.source, "copy_prompt");
}

async function copyTextToClipboard(text: string, successMessage: string) {
  if (!text.trim()) {
    showUiToast("暂无可复制路径。");
    return;
  }

  try {
    await navigator.clipboard.writeText(text);
    showUiToast(successMessage);
  } catch {
    showUiToast("复制权限不可用，请手动选中路径复制。");
  }
}

async function openReleaseGateExportPath(path: string) {
  if (!path.trim()) {
    showUiToast("暂无可打开路径。");
    return;
  }

  if (!hasTauriRuntime()) {
    await copyTextToClipboard(path, "浏览器预览不能打开本地路径，已复制路径。");
    return;
  }

  try {
    await invoke("open_release_gate_export_path", { path });
    showUiToast("已打开导出位置。");
  } catch (error) {
    showUiToast(`打开失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

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
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>("");

  useEffect(() => {
    if (workspaces.length === 0) {
      if (selectedWorkspaceId) setSelectedWorkspaceId("");
      return;
    }

    if (!workspaces.some(workspace => workspace.id === selectedWorkspaceId)) {
      setSelectedWorkspaceId(workspaces[0].id);
    }
  }, [selectedWorkspaceId, workspaces]);

  const selectedWorkspace = workspaces.find(workspace => workspace.id === selectedWorkspaceId) ?? workspaces[0];
  const selectedProjectScan = selectedWorkspace
    ? projectScans.find(scan => scan.workspaceId === selectedWorkspace.id)
    : undefined;

  return (
    <div className="view workspaces-view">
      <div className="card-grid">
        {workspaces.map(workspace => (
          <article
            className={workspace.id === selectedWorkspace?.id ? "workspace-card is-selected" : "workspace-card"}
            key={workspace.id}
          >
            <div className="card-head">
              <strong>{workspace.name}</strong>
              <span className={`scope ${workspace.scope}`}>{scopeLabel(workspace.scope)}</span>
            </div>
            <p>{workspace.path}</p>
            <footer>
              <button
                className="detail-button"
                onClick={() => setSelectedWorkspaceId(workspace.id)}
                type="button"
              >
                查看详情
              </button>
              <span>{workspace.agentCount} 个 AI 工具</span>
              <span>{workspace.skillCount} 个 Skills</span>
              <ToggleSwitch
                disabled={disabled}
                enabled={workspace.enabled}
                label={workspace.enabled ? "已启用" : "未启用"}
                onClick={() => onToggle("set_workspace_enabled", workspace.id, !workspace.enabled)}
              />
            </footer>
          </article>
        ))}
        {workspaces.length === 0 && <EmptyState text="正在等待工作区索引结果。" />}
      </div>

      {selectedWorkspace && (
        <WorkspaceDetailPanel projectScan={selectedProjectScan} workspace={selectedWorkspace} />
      )}

      <section className="panel workspace-scan-panel">
        <p className="eyebrow">Project Workspace Scanner</p>
        <h3>只读项目扫描</h3>
        <div className="project-scan-list">
          {projectScans.map(scan => (
            <article className="project-detail-card" key={scan.id}>
              <div className="project-detail-head">
                <div>
                  <strong>{scan.path}</strong>
                  <span>{scan.fileCount} 个文件 · 最近扫描 {formatScanTime(scan.scannedAt)}</span>
                </div>
                <span className="scope project">只读</span>
              </div>
              <div className="scan-flags">
                <ScanFlag enabled={scan.hasGit} label="Git" />
                <ScanFlag enabled={scan.hasPackageJson} label="package.json" />
                <ScanFlag enabled={scan.hasCargoToml} label="Cargo.toml" />
                <ScanFlag enabled={scan.hasTauriConfig} label="Tauri" />
                <ScanFlag enabled={scan.hasAgentsMd} label="AGENTS.md" />
                <ScanFlag enabled={scan.hasClaudeMd} label="CLAUDE.md" />
                <ScanFlag enabled={scan.hasReadmeMd} label="README.md" />
              </div>
              <div className="instruction-preview">
                <p className="eyebrow">只读说明预览</p>
                <pre>{projectInstructionPreview(scan)}</pre>
              </div>
            </article>
          ))}
          {projectScans.length === 0 && <p>暂未发现项目级工作区。</p>}
        </div>
      </section>
    </div>
  );
}

function WorkspaceDetailPanel({
  projectScan,
  workspace
}: {
  projectScan?: ProjectScanCard;
  workspace: WorkspaceCard;
}) {
  const isProject = workspace.scope === "project";

  return (
    <section className="panel workspace-detail-panel">
      <div className="workspace-detail-head">
        <div>
          <p className="eyebrow">Workspace Detail</p>
          <h3>{workspace.name}</h3>
          <span>{workspace.path}</span>
        </div>
        <span className={`scope ${workspace.scope}`}>{scopeLabel(workspace.scope)}</span>
      </div>

      <div className="workspace-detail-metrics">
        <article>
          <span>范围</span>
          <strong>{scopeLabel(workspace.scope)}</strong>
        </article>
        <article>
          <span>AI 工具</span>
          <strong>{workspace.agentCount}</strong>
        </article>
        <article>
          <span>Skills</span>
          <strong>{workspace.skillCount}</strong>
        </article>
        <article>
          <span>状态</span>
          <strong>{workspace.enabled ? "已启用" : "已停用"}</strong>
        </article>
      </div>

      {isProject && projectScan ? (
        <div className="workspace-detail-scan">
          <div className="scan-flags">
            <ScanFlag enabled={projectScan.hasGit} label="Git" />
            <ScanFlag enabled={projectScan.hasPackageJson} label="package.json" />
            <ScanFlag enabled={projectScan.hasCargoToml} label="Cargo.toml" />
            <ScanFlag enabled={projectScan.hasTauriConfig} label="Tauri" />
            <ScanFlag enabled={projectScan.hasAgentsMd} label="AGENTS.md" />
            <ScanFlag enabled={projectScan.hasClaudeMd} label="CLAUDE.md" />
            <ScanFlag enabled={projectScan.hasReadmeMd} label="README.md" />
          </div>
          <div className="instruction-preview">
            <p className="eyebrow">只读说明预览</p>
            <pre>{projectInstructionPreview(projectScan)}</pre>
          </div>
        </div>
      ) : (
        <div className="workspace-detail-note">
          <strong>{isProject ? "等待项目扫描结果" : "当前是只读工作区详情"}</strong>
          <span>
            {isProject
              ? "项目详情页会在扫描完成后显示技术栈、说明文件和只读说明草稿。"
              : "全局和 Agent 工作区先展示范围、路径和启用状态；真实同步仍需等待备份、回滚和发布闸门完成。"}
          </span>
        </div>
      )}
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
      <section className="page-header compact">
        <div>
          <h2>Presets</h2>
          <p>Group related Skills into reusable bundles before enabling them for workspaces.</p>
        </div>
      </section>

      <div className="preset-grid">
      {presets.map(preset => (
        <article className={`preset-card ${preset.color}`} key={preset.id}>
          <div className="card-head">
            <strong>{preset.name}</strong>
            <span>{preset.skillCount}</span>
          </div>
          <p>{preset.description}</p>
          <div className="preset-meta-row">
            <span>{preset.skillCount} Skills</span>
            <span>{preset.workspaceCount} 工作区</span>
          </div>
          <footer>
            <ToggleSwitch
              disabled={disabled}
              enabled={preset.enabled}
              label={preset.enabled ? "已启用" : "未启用"}
              onClick={() => onToggle("set_preset_enabled", preset.id, !preset.enabled)}
            />
          </footer>
        </article>
      ))}
      {presets.length === 0 && <EmptyState text="正在等待 Preset 索引结果。" />}
      </div>

      <section className="panel distribution-panel">
        <div className="section-title-row">
          <div>
            <p className="eyebrow">Distribution Matrix</p>
            <h3>Preset / 工作区分发矩阵</h3>
            <p>这里只管理本地 SQLite 中的分发计划，不会把 Skill 写入 Claude、Codex 或 Antigravity。</p>
          </div>
          <span className="status-badge info">{distributions.length} 条计划</span>
        </div>
        <div className="distribution-grid">
          {distributions.map(item => (
            <PresetDistributionRow
              disabled={disabled}
              item={item}
              key={item.id}
              onToggle={enabled => void onToggleDistribution(item.presetId, item.workspaceId, enabled)}
            />
          ))}
          {distributions.length === 0 && <EmptyState text="等待本地 SQLite 生成 Preset/工作区矩阵。" />}
        </div>
      </section>
    </div>
  );
}

function PresetDistributionRow({
  disabled,
  item,
  onToggle
}: {
  disabled: boolean;
  item: PresetDistributionCard;
  onToggle: (enabled: boolean) => void;
}) {
  return (
    <article className={item.enabled ? "distribution-row is-enabled" : "distribution-row"}>
      <div>
        <strong>{item.presetName}</strong>
        <span>{item.workspaceName} · {scopeLabel(item.workspaceScope)}</span>
      </div>
      <span className="distribution-count">{item.skillCount} Skills</span>
      <small>{item.summary}</small>
      <ToggleSwitch
        disabled={disabled}
        enabled={item.enabled}
        label={item.enabled ? "已分发" : "未分发"}
        onClick={() => onToggle(!item.enabled)}
      />
    </article>
  );
}

function Sources({
  loading,
  onBulkSaveMetadata,
  onPromoteImport,
  onPreviewImport,
  onRefreshIndex,
  onRealWriteAuthorization,
  onSaveMetadata,
  onSetSkillConflictChoice,
  onStageImport,
  searchQuery,
  snapshot
}: {
  loading: boolean;
  onBulkSaveMetadata: (
    sourceIds: string[],
    category: string,
    enabled: boolean | null
  ) => Promise<"failed" | "preview" | "saved">;
  onPromoteImport: (
    importKind: string,
    stagedPath: string,
    sourceName: string,
    options?: ImportFeedbackOptions
  ) => Promise<SourceImportPromotionCard>;
  onPreviewImport: (importKind: string, input: string, options?: ImportFeedbackOptions) => Promise<SourceImportPlanCard>;
  onRefreshIndex: () => Promise<LegacySnapshot | null>;
  onRealWriteAuthorization: (enabled: boolean) => Promise<void>;
  onSaveMetadata: (source: SourceCard, draft: SourceDraft) => Promise<"failed" | "preview" | "saved">;
  onSetSkillConflictChoice: (
    conflictKey: string,
    defaultSkillId: string,
    status: "default-set" | "ignored" | "unresolved"
  ) => Promise<void>;
  onStageImport: (importKind: string, input: string, options?: ImportFeedbackOptions) => Promise<SourceImportExecutionCard>;
  searchQuery: string;
  snapshot: LegacySnapshot | null;
}) {
  const sources = snapshot?.sources ?? [];
  const skillConflicts = snapshot?.skillConflicts ?? [];
  const importPreviews = snapshot?.importPreviews ?? [];
  const githubSources = sources.filter(source => source.url).length;
  const localSources = sources.filter(source => !source.url && source.localPath).length;
  const [editingSourceId, setEditingSourceId] = useState<string>("");
  const [sourceDrafts, setSourceDrafts] = useState<Record<string, SourceDraft>>({});
  const [importPlan, setImportPlan] = useState<SourceImportPlanCard | null>(null);
  const [importExecution, setImportExecution] = useState<SourceImportExecutionCard | null>(null);
  const [importPromotion, setImportPromotion] = useState<SourceImportPromotionCard | null>(null);
  const [importPending, setImportPending] = useState<boolean>(false);
  const [quickAddStatus, setQuickAddStatus] = useState<QuickAddStatus | null>(null);
  const [selectedSourceIds, setSelectedSourceIds] = useState<string[]>([]);
  const [bulkCategory, setBulkCategory] = useState<string>("");
  const [bulkEnabled, setBulkEnabled] = useState<"keep" | "enabled" | "disabled">("keep");
  const [sourceSortKey, setSourceSortKey] = useState<SourceSortKey>("recent");
  const displaySources = sources.map(source => applySourceDraft(source, sourceDrafts[source.id]));
  const filteredSources = displaySources.filter(source => sourceMatchesSearch(source, searchQuery));
  const sourcePopularityById = useMemo(() => {
    return new Map((snapshot?.sourcePopularity ?? []).map(source => [source.sourceId, source]));
  }, [snapshot?.sourcePopularity]);
  const sortedSources = useMemo(
    () => sortSources(filteredSources, sourceSortKey, sourcePopularityById),
    [filteredSources, sourcePopularityById, sourceSortKey]
  );
  const sourceIdsSignature = sortedSources.map(source => source.id).join("\u001f");
  const editingSource = displaySources.find(source => source.id === editingSourceId) ?? null;
  const editingSourcePopularity = editingSource ? sourcePopularityById.get(editingSource.id) : undefined;
  const editingSourceSkills = useMemo(() => {
    if (!editingSource) return [];
    return (snapshot?.skills ?? []).filter(skill => skillBelongsToSource(skill, editingSource));
  }, [editingSource?.id, editingSource?.localPath, editingSource?.name, snapshot?.skills]);
  const selectedSources = displaySources.filter(source => selectedSourceIds.includes(source.id));
  const operatorConsent = snapshot?.operatorConsent ?? {
    realWritesEnabled: false,
    enabledAt: "",
    updatedAt: "",
    summary: "真实写入授权未开启；同步按钮只刷新索引，不会写入 AI 工具目录。"
  };

  useEffect(() => {
    setSelectedSourceIds(previous => {
      const next = previous.filter(id => sources.some(source => source.id === id));
      return next.length === previous.length ? previous : next;
    });
  }, [sources]);

  useEffect(() => {
    setEditingSourceId(previous => {
      if (previous && sortedSources.some(source => source.id === previous)) {
        return previous;
      }
      return "";
    });
  }, [sourceIdsSignature, sortedSources]);

  function openSourceDetails(source: SourceCard) {
    setEditingSourceId(source.id);
  }

  async function saveSourceDraft(source: SourceCard, draft: SourceDraft) {
    const saveResult = await onSaveMetadata(source, draft);
    if (saveResult === "preview") {
      setSourceDrafts(previous => ({ ...previous, [source.id]: draft }));
      showUiToast("浏览器预览已保存为本次来源草稿。");
    }
    if (saveResult === "saved") {
      setSourceDrafts(previous => {
        const next = { ...previous };
        delete next[source.id];
        return next;
      });
    }
  }

  async function previewImportPlan(importKind: string, input: string) {
    setImportPending(true);
    try {
      const plan = await onPreviewImport(importKind, input);
      setImportPlan(plan);
      setImportExecution(null);
      setImportPromotion(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setImportPlan({
        id: "import-plan-error",
        importKind,
        input,
        normalizedTarget: input.trim(),
        displayName: "导入计划生成失败",
        status: "blocked",
        riskLevel: "high",
        safeToContinue: false,
        duplicateSourceId: "",
        duplicateReason: message,
        skillCount: 0,
        promptCount: 0,
        targetRoot: "",
        targetPath: "",
        backupPath: "",
        writeGateStatus: "blocked",
        plannedSteps: ["请修正输入后重新生成 dry-run。"],
        installPlanSteps: [],
        blockingChecks: [message],
        rollbackSummary: "预检失败，没有执行任何文件写入。"
      });
      showUiToast("导入 dry-run 失败，请查看计划卡片。");
    } finally {
      setImportPending(false);
    }
  }

  async function stageImportPlan(importKind: string, input: string) {
    setImportPending(true);
    try {
      const execution = await onStageImport(importKind, input);
      setImportExecution(execution);
      setImportPromotion(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setImportExecution({
        id: "import-stage-error",
        importKind,
        input,
        status: "blocked",
        riskLevel: "high",
        summary: message,
        stagedPath: "",
        reportPath: "",
        manifestPath: "",
        copiedFiles: 0,
        copiedBytes: 0,
        skillCount: 0,
        promptCount: 0,
        blockingChecks: [message],
        rollbackSteps: ["没有执行 staging 写入。"],
        realWriteScope: "none"
      });
      showUiToast("隔离 staging 执行失败，请查看结果卡片。");
    } finally {
      setImportPending(false);
    }
  }

  async function promoteImportExecution(execution: SourceImportExecutionCard, plan: SourceImportPlanCard | null) {
    if (execution.status !== "staged" && execution.status !== "warn") {
      showUiToast("只有已经进入 staging 的来源才能提升。");
      return;
    }
    setImportPending(true);
    try {
      const sourceName = plan?.displayName || execution.id.replace(/^preview-stage-/, "");
      const promotion = await onPromoteImport(execution.importKind, execution.stagedPath, sourceName);
      setImportPromotion(promotion);
      if (promotion.status === "promoted") {
        await onRefreshIndex();
        showUiToast(
          operatorConsent.realWritesEnabled
            ? "来源已加入来源库，并已执行 AI 工具同步。"
            : "来源已加入来源库并刷新索引；打开授权后点击同步即可写入 AI 工具。"
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setImportPromotion({
        id: "import-promotion-error",
        importKind: execution.importKind,
        sourceName: plan?.displayName || "unknown-source",
        status: "blocked",
        riskLevel: "high",
        summary: message,
        stagedPath: execution.stagedPath,
        targetPath: "",
        reportPath: "",
        manifestPath: "",
        copiedFiles: 0,
        copiedBytes: 0,
        skillCount: 0,
        promptCount: 0,
        blockingChecks: [message],
        rollbackSteps: ["没有执行受管理来源写入。"],
        realWriteScope: "none"
      });
      showUiToast("提升为受管理来源失败，请查看结果卡片。");
    } finally {
      setImportPending(false);
    }
  }

  async function quickAddImport(importKind: string, input: string, draft: QuickSourceDraft) {
    const value = input.trim();
    if (!value) {
      showUiToast("请先粘贴 GitHub 地址、本地文件夹路径或 zip/.skill 文件路径。");
      return;
    }
    setImportPending(true);
    setQuickAddStatus({
      tone: "info",
      title: "正在检查来源",
      body: "正在校验地址、重复来源和安全条件。"
    });
    try {
      const plan = await onPreviewImport(importKind, value, { quiet: true });
      setImportPlan(plan);
      setImportExecution(null);
      setImportPromotion(null);
      if (!plan.safeToContinue) {
        const reason = plan.duplicateReason || plan.blockingChecks[0] || "预检未通过，请展开高级详情查看原因。";
        if (plan.duplicateSourceId) {
          const duplicateSource = displaySources.find(source => source.id === plan.duplicateSourceId);
          if (duplicateSource) {
            const saveResult = await onSaveMetadata(duplicateSource, { ...draft, name: duplicateSource.name });
            if (saveResult === "preview") {
              setSourceDrafts(previous => ({ ...previous, [duplicateSource.id]: { ...draft, name: duplicateSource.name } }));
            }
            await onRefreshIndex();
            setQuickAddStatus({
              tone: "ok",
              title: "来源已存在，已刷新",
              body: "没有重复克隆；已按当前分类、备注和标签刷新来源库。"
            });
            showUiToast("来源已存在，已刷新元数据和索引。");
            return;
          }
        }
        setQuickAddStatus({
          tone: "warn",
          title: "需要先处理",
          body: reason
        });
        showUiToast("一键添加没有继续：请查看需要处理的原因。");
        return;
      }

      setQuickAddStatus({
        tone: "info",
        title: "正在加入来源库",
        body: "安全检查已通过，正在下载到隔离区。这个阶段如果网络较慢会等待，但不会无限卡住。"
      });
      const execution = await onStageImport(plan.importKind, plan.input, { quiet: true });
      setImportExecution(execution);
      if (execution.status !== "staged" && execution.status !== "warn") {
        setQuickAddStatus({
          tone: "warn",
          title: "未写入来源库",
          body: execution.summary || "隔离写入未通过，请展开高级详情查看原因。"
        });
        showUiToast("一键添加停在隔离区写入阶段。");
        return;
      }

      setQuickAddStatus({
        tone: "info",
        title: "正在写入来源库",
        body: "隔离区检查已通过，正在提升为受管理来源。"
      });
      const sourceName = plan.displayName || execution.id.replace(/^preview-stage-/, "");
      const promotion = await onPromoteImport(execution.importKind, execution.stagedPath, sourceName, { quiet: true });
      setImportPromotion(promotion);
      if (!sourceImportPromotionIsUsable(promotion.status)) {
        setQuickAddStatus({
          tone: "warn",
          title: "未写入来源库",
          body: promotion.summary || "提升为来源被阻止，请展开高级详情查看原因。"
        });
        showUiToast("一键添加被阻止，请查看状态说明。");
        return;
      }

      setQuickAddStatus({
        tone: "info",
        title: "正在刷新索引",
        body: "来源已写入，正在刷新 Skill / Prompt / AI 工具索引。"
      });
      const refreshed = await onRefreshIndex();
      const promotedSource = findPromotedSource(refreshed?.sources ?? [], promotion);
      if (promotedSource) {
        await onSaveMetadata(promotedSource, {
          ...draft,
          category: draft.category.trim() || promotedSource.categoryId,
          name: promotedSource.name,
          note: draft.note,
          tags: draft.tags
        });
        const syncWasExecuted = operatorConsent.realWritesEnabled;
        setQuickAddStatus({
          tone: "ok",
          title: promotion.status === "already-managed" ? "来源已存在，已刷新" : "已添加到来源库",
          body: syncWasExecuted
            ? "已添加来源、执行 GitHub 更新和 AI 工具链接同步，并保存分类、备注和标签。"
            : "已添加来源并刷新索引；打开真实写入授权后点击同步，即可写入 Claude/Codex/Antigravity。"
        });
        showUiToast(
          syncWasExecuted
            ? "已添加来源并同步到 AI 工具。"
            : promotion.status === "already-managed"
              ? "来源已存在，已刷新索引并保存分类/备注/标签。"
              : "已添加来源并刷新索引；打开授权后可一键同步到 AI 工具。"
        );
      } else {
        setQuickAddStatus({
          tone: "warn",
          title: "已添加但需确认",
          body: "来源库已刷新，但没有自动匹配到元数据记录，请在下方来源列表确认。"
        });
        showUiToast("已添加来源并刷新索引；未自动匹配元数据，请在来源列表中手动确认。");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setQuickAddStatus({
        tone: "error",
        title: "一键添加失败",
        body: message
      });
      setImportPlan({
        id: "quick-add-error",
        importKind,
        input: value,
        normalizedTarget: value,
        displayName: "一键添加失败",
        status: "blocked",
        riskLevel: "high",
        safeToContinue: false,
        duplicateSourceId: "",
        duplicateReason: message,
        skillCount: 0,
        promptCount: 0,
        targetRoot: "",
        targetPath: "",
        backupPath: "",
        writeGateStatus: "blocked",
        plannedSteps: ["没有执行正式来源写入。"],
        installPlanSteps: [],
        blockingChecks: [message],
        rollbackSummary: "失败前没有改动 AI 工具目录。"
      });
      showUiToast("一键添加失败，请查看状态说明。");
    } finally {
      setImportPending(false);
    }
  }

  function toggleSourceSelection(sourceId: string) {
    setSelectedSourceIds(previous =>
      previous.includes(sourceId) ? previous.filter(id => id !== sourceId) : [...previous, sourceId]
    );
  }

  async function applyBulkSourceEdit() {
    const enabled = bulkEnabled === "keep" ? null : bulkEnabled === "enabled";
    const result = await onBulkSaveMetadata(selectedSourceIds, bulkCategory, enabled);
    if (result === "saved" || result === "preview") {
      setSelectedSourceIds([]);
      setBulkCategory("");
      setBulkEnabled("keep");
    }
  }

  return (
    <div className="view sources-view">
      <section className="page-header">
        <div>
          <h2>Sources</h2>
          <p>Track GitHub repositories, local folders, Prompt material, and current source health before syncing.</p>
        </div>
        <div className="page-header-stats">
          <span>{sources.length} total</span>
          <span>{githubSources} GitHub</span>
          <span>{localSources} local</span>
        </div>
      </section>

      <SourceImportPreviewPanel previews={importPreviews} />
      <SourceImportWizardPanel
        disabled={loading || importPending}
        onPreview={(importKind, input) => void previewImportPlan(importKind, input)}
        onQuickAdd={(importKind, input, draft) => void quickAddImport(importKind, input, draft)}
        onRealWriteAuthorization={onRealWriteAuthorization}
        onStage={(importKind, input) => void stageImportPlan(importKind, input)}
        onPromote={execution => void promoteImportExecution(execution, importPlan)}
        execution={importExecution}
        operatorConsent={operatorConsent}
        promotion={importPromotion}
        plan={importPlan}
        quickAddStatus={quickAddStatus}
      />

      <section className={`sources-workbench ${editingSource ? "has-detail" : ""}`}>
        <div className="sources-main-column">
          <SourceBulkEditPanel
            category={bulkCategory}
            disabled={loading}
            enabledMode={bulkEnabled}
            onApply={() => void applyBulkSourceEdit()}
            onCategoryChange={setBulkCategory}
            onClear={() => setSelectedSourceIds([])}
            onEnabledModeChange={setBulkEnabled}
            onSelectAll={() => setSelectedSourceIds(sortedSources.map(source => source.id))}
            selectedCount={selectedSources.length}
            totalCount={sortedSources.length}
          />

          <RouterHubPanel
            disabled={loading || importPending}
            realWritesEnabled={operatorConsent.realWritesEnabled}
          />

          <SkillConflictSelectorPanel
            conflicts={skillConflicts}
            disabled={loading || importPending}
            onResolve={onSetSkillConflictChoice}
          />

          <SourceListToolbar
            resultCount={sortedSources.length}
            sortKey={sourceSortKey}
            onSortKeyChange={setSourceSortKey}
          />

          <div className="table-panel source-table">
            {sortedSources.map(source => {
              const popularity = sourcePopularityById.get(source.id);
              const popularityInfo = sourcePopularityInfo(source, popularity);
              const usageLabel = popularity?.localTotalCount ? `${popularity.localTotalCount} 次` : "0 次";
              const activeSource = editingSource?.id === source.id;
              return (
                <div
                  className={`source-row ${source.health} ${source.enabled ? "" : "disabled"} ${activeSource ? "active" : ""}`}
                  key={source.id}
                  onClick={() => openSourceDetails(source)}
                  role="button"
                  tabIndex={0}
                >
                  <label className="source-select-check" title="选择此来源用于批量编辑">
                    <input
                      aria-label={`选择来源 ${source.name}`}
                      checked={selectedSourceIds.includes(source.id)}
                      disabled={loading}
                      onChange={event => {
                        event.stopPropagation();
                        toggleSourceSelection(source.id);
                      }}
                      onClick={event => event.stopPropagation()}
                      type="checkbox"
                    />
                  </label>
                  <strong>{source.name}</strong>
                  <span>{sourceTypeLabel(source.sourceType)}</span>
                  <span>{source.skillCount} Skills</span>
                  <span className={`source-popularity ${popularityInfo.tone}`} title={popularityInfo.title}>
                    {popularityInfo.label}
                  </span>
                  <span className="source-usage" title="本地 Skill 调用次数；不统计打开或编辑来源。">
                    {usageLabel}
                  </span>
                  <span className={`status-badge ${source.health}`}>
                    <span className={`status-dot ${statusDotClass(source.health)}`} />
                    {skillStatusLabel(source.health)}
                  </span>
                  <span>{source.enabled ? "Enabled" : "Disabled"}</span>
                  <small>
                    {(source.tags ?? []).length > 0 ? `标签：${(source.tags ?? []).join(" / ")} · ` : ""}
                    {source.url || source.localPath}
                  </small>
                  <button
                    className="icon-action"
                    disabled={loading}
                    onClick={event => {
                      event.stopPropagation();
                      openSourceDetails(source);
                    }}
                    type="button"
                  >
                    <Icon name="edit" />
                  </button>
                </div>
              );
            })}
            {sortedSources.length === 0 && (
              <EmptyState text={searchQuery.trim() ? "当前搜索条件下没有来源。" : "正在等待来源扫描结果。"} />
            )}
          </div>
        </div>

        {editingSource && (
          <SourceEditPanel
            draft={sourceDrafts[editingSource.id]}
            onClose={() => setEditingSourceId("")}
            onSave={draft => void saveSourceDraft(editingSource, draft)}
            popularity={editingSourcePopularity}
            source={editingSource}
            sourceSkills={editingSourceSkills}
          />
        )}
      </section>
    </div>
  );
}

/**
 * Surfaces the router-hub regeneration state to the user. Lets them:
 *   - run a dry-run plan to see which collections would get a parent SKILL.md
 *   - commit (writes real files) — only when real_writes consent is on
 *   - read the duplicate-children and unquoted-marker warnings the backend collected
 *
 * Routes through the regenerate_router_hubs Tauri command. In browser preview
 * (no Tauri runtime) the button is disabled with an explanatory hint.
 */
function RouterHubPanel({
  disabled,
  realWritesEnabled
}: {
  disabled: boolean;
  realWritesEnabled: boolean;
}) {
  const [report, setReport] = useState<RouterHubReport | null>(null);
  const [pending, setPending] = useState<"" | "plan" | "commit">("");
  const [error, setError] = useState<string>("");
  const runtimeAvailable = hasTauriRuntime();

  async function runRouterHubs(commit: boolean) {
    if (!runtimeAvailable) {
      setError("浏览器预览模式下无法重建母 Skill 路由；请在 Tauri 桌面窗口运行。");
      return;
    }
    setPending(commit ? "commit" : "plan");
    setError("");
    try {
      const next = await invoke<RouterHubReport>("regenerate_router_hubs", { commit });
      setReport(next);
      showUiToast(
        commit
          ? `母 Skill 路由已重建：写入 ${next.writtenCount}，跳过 ${next.skippedCount}。`
          : `母 Skill 路由 dry-run：${next.totalCollections} 个集合，${next.duplicateChildren.length} 个重名子 Skill。`
      );
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError(message);
      showUiToast(`重建母 Skill 路由失败：${message}`);
    } finally {
      setPending("");
    }
  }

  const writtenPlans = report?.plans.filter(plan => plan.status === "written") ?? [];
  const plannedPlans = report?.plans.filter(plan => plan.status === "planned") ?? [];
  const skippedPlans = report?.plans.filter(plan => plan.status.startsWith("skipped")) ?? [];

  return (
    <section className="router-hub-panel glass-panel">
      <div className="router-hub-head">
        <div>
          <p className="eyebrow">Router Hubs</p>
          <h3>母 Skill 路由</h3>
          <p>让 /nature-skills 这类集合入口保持可用。日常只需要点“立即重建”。</p>
        </div>
        <div className="router-hub-actions">
          <button
            className="ghost-action compact"
            disabled={disabled || pending !== ""}
            onClick={() => void runRouterHubs(false)}
            type="button"
          >
            {pending === "plan" ? "正在预览" : "预览"}
          </button>
          <button
            className="primary-action compact"
            disabled={disabled || pending !== "" || !realWritesEnabled || !runtimeAvailable}
            onClick={() => void runRouterHubs(true)}
            type="button"
            title={
              !realWritesEnabled
                ? "需要先在上方一键添加来源面板里打开「同步到 AI 工具授权」"
                : !runtimeAvailable
                  ? "浏览器预览模式只读"
                : "立即重建母 Skill 入口"
            }
          >
            {pending === "commit" ? "正在重建" : "立即重建"}
          </button>
        </div>
      </div>

      {error && (
        <div className="router-hub-error" role="alert">
          <strong>失败：</strong>
          <span>{error}</span>
        </div>
      )}

      {!report && !error && (
        <div className="router-hub-hint">
          <span>如果母 Skill 调不出来，先预览，再重建。</span>
        </div>
      )}

      {report && (
        <>
          <div className="router-hub-stats">
            <span className="router-hub-stat ok">
              <strong>{report.totalCollections}</strong>
              <em>collections</em>
            </span>
            <span className="router-hub-stat brand">
              <strong>{writtenPlans.length + plannedPlans.length}</strong>
              <em>{report.committed ? "written" : "planned"}</em>
            </span>
            <span className="router-hub-stat warn">
              <strong>{skippedPlans.length}</strong>
              <em>skipped</em>
            </span>
            <span className="router-hub-stat danger">
              <strong>{report.duplicateChildren.length}</strong>
              <em>duplicate child</em>
            </span>
            <span className="router-hub-stat warn">
              <strong>{report.healthWarnings.length}</strong>
              <em>unquoted</em>
            </span>
          </div>
          <div className="router-hub-summary">{report.summary}</div>

          {report.duplicateChildren.length > 0 && (
            <div className="router-hub-duplicates">
              <strong>跨集合重名子 Skill</strong>
              <span>同一个 <code>name:</code> 出现在多个集合里，Claude 只会载入其中一个；建议改名或合并：</span>
              <ul>
                {report.duplicateChildren.map(dup => (
                  <li key={dup.childName}>
                    <code>/{dup.childName}</code>
                    <span>{dup.collections.join("、")}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {report.healthWarnings.length > 0 && (
            <div className="router-hub-warnings">
              <strong>未引号 [ROUTER-HUB] 描述</strong>
              <span>这些 SKILL.md 的描述以 [ROUTER-HUB] 开头但没有用引号包起来；严格的 YAML 解析器会把它当作 flow 序列从而把整个 Skill 丢弃：</span>
              <ul>
                {report.healthWarnings.map(warn => (
                  <li key={warn.skillMdPath}>
                    <code>{warn.skillMdPath}</code>
                    <small>{warn.issue}</small>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="router-hub-plan-grid">
            {report.plans.map(plan => (
              <article
                className={`router-hub-card status-${plan.status}`}
                key={`${plan.collectionName}:${plan.routerSkillName || plan.status}`}
              >
                <header>
                  <strong>{plan.collectionName}</strong>
                  <span className={`router-hub-pill ${planStatusTone(plan.status)}`}>
                    {planStatusLabel(plan.status)}
                  </span>
                </header>
                {plan.routerSkillName && (
                  <div className="router-hub-name">
                    <small>母 Skill</small>
                    <code>/{plan.routerSkillName}</code>
                  </div>
                )}
                <p>{plan.summary}</p>
                {plan.children.length > 0 && (
                  <div className="router-hub-children">
                    <small>子 Skill × {plan.childCount}</small>
                    <ul>
                      {plan.children.slice(0, 5).map(child => (
                        <li key={child}>
                          <code>/{child}</code>
                        </li>
                      ))}
                      {plan.children.length > 5 && <li className="router-hub-more">+{plan.children.length - 5}</li>}
                    </ul>
                  </div>
                )}
              </article>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function SkillConflictSelectorPanel({
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
  const activeConflicts = conflicts.filter(conflict => conflict.status !== "ignored");
  const unresolvedCount = conflicts.filter(conflict => conflict.status === "unresolved").length;
  const initialKey =
    conflicts.find(conflict => conflict.status === "unresolved")?.conflictKey ??
    conflicts[0]?.conflictKey ??
    "";
  const [activeKey, setActiveKey] = useState(initialKey);

  useEffect(() => {
    if (!conflicts.some(conflict => conflict.conflictKey === activeKey)) {
      setActiveKey(initialKey);
    }
  }, [activeKey, conflicts, initialKey]);

  if (conflicts.length === 0) {
    return (
      <section className="skill-conflict-panel glass-panel is-clear">
        <div>
          <p className="eyebrow">Conflict Selector</p>
          <h3>同名 Skill 冲突</h3>
          <p>当前没有需要选择默认来源的同名子 Skill。</p>
        </div>
        <span className="status-badge ok"><span className="status-dot ok" />0 个冲突</span>
      </section>
    );
  }

  const selectedConflict =
    conflicts.find(conflict => conflict.conflictKey === activeKey) ??
    conflicts.find(conflict => conflict.status === "unresolved") ??
    conflicts[0];

  return (
    <section className="skill-conflict-panel glass-panel">
      <div className="skill-conflict-head">
        <div>
          <p className="eyebrow">Conflict Selector</p>
          <h3>同名 Skill 冲突选择器</h3>
          <p>同名可以同时保留；这里只决定直接调用子 Skill 名时默认走哪个来源。</p>
        </div>
        <div className="skill-conflict-summary">
          <span>{conflicts.length} 组重名</span>
          <strong>{unresolvedCount} 待选择</strong>
        </div>
      </div>

      <div className="skill-conflict-layout">
        <div className="skill-conflict-list" role="list">
          {conflicts.map(conflict => {
            const isActive = selectedConflict.conflictKey === conflict.conflictKey;
            const choiceLabel = conflict.defaultSourceName || conflictStatusLabel(conflict.status);
            return (
              <button
                className={`skill-conflict-tab ${isActive ? "active" : ""} ${conflict.status}`}
                key={conflict.conflictKey}
                onClick={() => setActiveKey(conflict.conflictKey)}
                type="button"
              >
                <strong>/{conflict.childName}</strong>
                <span>{conflict.choices.length} 个候选</span>
                <small>{choiceLabel}</small>
              </button>
            );
          })}
        </div>

        <div className="skill-conflict-detail">
          <header>
            <div>
              <small>冲突项</small>
              <h4>/{selectedConflict.childName}</h4>
            </div>
            <span className={`status-badge ${conflictStatusTone(selectedConflict.status)}`}>
              <span className={`status-dot ${conflictStatusTone(selectedConflict.status)}`} />
              {conflictStatusLabel(selectedConflict.status)}
            </span>
          </header>
          <p>
            精确调用仍建议使用 <code>来源:Skill</code>。默认项只用于未来直接调用
            <code>/{selectedConflict.childName}</code> 时的推荐来源。
          </p>

          <div className="skill-conflict-choice-grid">
            {selectedConflict.choices.map(choice => {
              const selected = choice.skillId === selectedConflict.defaultSkillId;
              return (
                <article className={`skill-conflict-choice ${selected ? "selected" : ""}`} key={choice.skillId}>
                  <div>
                    <strong>{choice.sourceName}:{choice.skillName}</strong>
                    <span>{choice.category || "未分类"}</span>
                  </div>
                  <p>{choice.description || choice.relativePath || "没有描述。"}</p>
                  <small>{choice.relativePath}</small>
                  <button
                    className={selected ? "ghost-action compact" : "primary-action compact"}
                    disabled={disabled || selected}
                    onClick={() => void onResolve(selectedConflict.conflictKey, choice.skillId, "default-set")}
                    type="button"
                  >
                    {selected ? "当前默认" : "设为默认"}
                  </button>
                </article>
              );
            })}
          </div>

          <div className="skill-conflict-actions">
            <button
              className="ghost-action compact"
              disabled={disabled}
              onClick={() => void onResolve(selectedConflict.conflictKey, "", "unresolved")}
              type="button"
            >
              重置为待选择
            </button>
            <button
              className="ghost-action compact"
              disabled={disabled}
              onClick={() => void onResolve(selectedConflict.conflictKey, "", "ignored")}
              type="button"
            >
              忽略提醒
            </button>
          </div>
        </div>
      </div>

      {activeConflicts.length === 0 && (
        <p className="skill-conflict-note">所有同名冲突都已忽略；可以随时重置。</p>
      )}
    </section>
  );
}

function conflictStatusTone(status: string): "ok" | "warn" | "info" | "danger" {
  if (status === "default-set") return "ok";
  if (status === "ignored") return "info";
  return "warn";
}

function conflictStatusLabel(status: string): string {
  if (status === "default-set") return "已设默认";
  if (status === "ignored") return "已忽略";
  return "待选择";
}

function planStatusTone(status: string): "ok" | "warn" | "info" | "danger" {
  if (status === "written") return "ok";
  if (status === "planned") return "info";
  if (status === "skipped-collision") return "danger";
  return "warn";
}

function planStatusLabel(status: string): string {
  switch (status) {
    case "written":
      return "已写入";
    case "planned":
      return "待写入";
    case "skipped-empty":
      return "跳过 · 无 Skill";
    case "skipped-single-child":
      return "跳过 · 单子";
    case "skipped-collision":
      return "跳过 · 名冲突";
    default:
      return status;
  }
}

function SourceListToolbar({
  onSortKeyChange,
  resultCount,
  sortKey
}: {
  onSortKeyChange: (value: SourceSortKey) => void;
  resultCount: number;
  sortKey: SourceSortKey;
}) {
  return (
    <section className="source-list-toolbar">
      <div>
        <p className="eyebrow">Source List</p>
        <h3>来源列表</h3>
        <p>{resultCount} 个来源；支持按加入时间、使用频率、GitHub 热度、Skill 数量和风险状态排序。</p>
      </div>
      <label>
        <span>排序</span>
        <select value={sortKey} onChange={event => onSortKeyChange(event.target.value as SourceSortKey)}>
          <option value="recent">最近加入/刷新</option>
          <option value="usage">使用频率最高</option>
          <option value="heat">GitHub 热度最高</option>
          <option value="skillCount">Skill 数量最多</option>
          <option value="health">风险优先</option>
          <option value="name">名称 A-Z</option>
        </select>
      </label>
    </section>
  );
}

function SourceBulkEditPanel({
  category,
  disabled,
  enabledMode,
  onApply,
  onCategoryChange,
  onClear,
  onEnabledModeChange,
  onSelectAll,
  selectedCount,
  totalCount
}: {
  category: string;
  disabled: boolean;
  enabledMode: "keep" | "enabled" | "disabled";
  onApply: () => void;
  onCategoryChange: (value: string) => void;
  onClear: () => void;
  onEnabledModeChange: (value: "keep" | "enabled" | "disabled") => void;
  onSelectAll: () => void;
  selectedCount: number;
  totalCount: number;
}) {
  return (
    <section className="source-bulk-panel">
      <div>
        <p className="eyebrow">Bulk Source Edit</p>
        <h3>批量来源编辑</h3>
        <p>批量修改分类或启用状态；当前只写入本地 SQLite 元数据，不会修改仓库文件。</p>
      </div>
      <div className="source-bulk-fields">
        <span className="selection-count">
          已选择 {selectedCount} / {totalCount}
        </span>
        <input
          disabled={disabled}
          onChange={event => onCategoryChange(event.target.value)}
          placeholder="批量分类，例如 ui-design / paper-research"
          value={category}
        />
        <select
          disabled={disabled}
          onChange={event => onEnabledModeChange(event.target.value as "keep" | "enabled" | "disabled")}
          value={enabledMode}
        >
          <option value="keep">保持启用状态</option>
          <option value="enabled">全部启用</option>
          <option value="disabled">全部停用</option>
        </select>
        <button className="secondary-action compact" disabled={disabled || totalCount === 0} onClick={onSelectAll} type="button">
          全选
        </button>
        <button className="secondary-action compact" disabled={disabled || selectedCount === 0} onClick={onClear} type="button">
          清空
        </button>
        <button className="primary-action compact" disabled={disabled || selectedCount === 0} onClick={onApply} type="button">
          应用批量修改
        </button>
      </div>
    </section>
  );
}

function SourceImportPreviewPanel({ previews }: { previews: ImportPreviewCard[] }) {
  const cards =
    previews.length > 0
      ? previews
      : [
          {
            id: "import-github",
            title: "GitHub 仓库导入",
            importKind: "github",
            status: "empty",
            summary: "可添加 GitHub 仓库并扫描其中的 Skill。",
            detail: "可添加 GitHub 仓库并扫描其中的 Skill。",
            skillCount: 0,
            promptCount: 0,
            safeToContinue: true
          },
          {
            id: "import-local",
            title: "本地文件夹导入",
            importKind: "local",
            status: "empty",
            summary: "可选择本地文件夹，只有 SKILL.md 会被识别。",
            detail: "可选择本地文件夹，只有 SKILL.md 会被识别。",
            skillCount: 0,
            promptCount: 0,
            safeToContinue: true
          },
          {
            id: "import-zip",
            title: "zip / .skill 包导入",
            importKind: "zip",
            status: "missing",
            summary: "可预览压缩包，确认安全后再导入。",
            detail: "可预览压缩包，确认安全后再导入。",
            skillCount: 0,
            promptCount: 0,
            safeToContinue: false
          }
        ];

  return (
    <section className="import-preview-panel">
      <div className="section-title-row">
        <div>
          <p className="eyebrow">Import Wizard</p>
          <h3>来源预览</h3>
          <p>先看能识别多少 Skill，再决定是否添加。</p>
        </div>
        <span className="status-badge info">只读预览</span>
      </div>
      <div className="import-preview-grid">
        {cards.map(card => (
          <article className={`import-preview-card ${card.status}`} key={card.id}>
            <div className="card-head">
              <strong>{card.title}</strong>
              <span className={`status-badge ${card.safeToContinue ? "ok" : "warn"}`}>
                {importPreviewStatusLabel(card)}
              </span>
            </div>
            <p>{card.summary}</p>
            <footer>
              <span>{card.skillCount} Skills</span>
              <span>{card.promptCount} Prompt</span>
              <span>{importKindLabel(card.importKind)}</span>
            </footer>
          </article>
        ))}
      </div>
    </section>
  );
}

function CategoryPicker({
  customCategory,
  disabled,
  inferredIds,
  mode,
  onCustomCategoryChange,
  onModeChange,
  onToggleCategory,
  selectedIds
}: {
  customCategory: string;
  disabled: boolean;
  inferredIds: string[];
  mode: "auto" | "manual";
  onCustomCategoryChange: (category: string) => void;
  onModeChange: (mode: "auto" | "manual") => void;
  onToggleCategory: (categoryId: string) => void;
  selectedIds: string[];
}) {
  const activeIds = mode === "auto" ? inferredIds : selectedIds;
  const customCategoryLabel = customCategory.trim();

  return (
    <div className="category-picker">
      <div className="category-picker-head">
        <span>分类</span>
        <button
          className={mode === "auto" ? "category-chip active" : "category-chip"}
          disabled={disabled}
          onClick={() => onModeChange("auto")}
          type="button"
        >
          自动分类
        </button>
      </div>
      <div className="category-chip-grid" role="group" aria-label="选择来源分类">
        {CATEGORY_OPTIONS.map(option => (
          <button
            className={activeIds.includes(option.id) ? "category-chip active" : "category-chip"}
            disabled={disabled}
            key={option.id}
            onClick={() => onToggleCategory(option.id)}
            type="button"
          >
            {option.label}
          </button>
        ))}
      </div>
      <label className="category-custom-field">
        自定义分类
        <input
          disabled={disabled}
          maxLength={80}
          onChange={event => onCustomCategoryChange(event.target.value)}
          placeholder="例如 Zotero / 文献管理"
          value={customCategory}
        />
      </label>
      <small>
        当前：{customCategoryLabel || (activeIds.length > 0 ? activeIds.map(categoryDisplayName).join("、") : "通用")}
      </small>
    </div>
  );
}

function quickAddProgressState(status: QuickAddStatus | null, disabled: boolean) {
  if (disabled) {
    return { index: 2, tone: "running", label: "正在处理" };
  }
  if (!status) {
    return { index: 0, tone: "idle", label: "等待添加" };
  }
  if (status.tone === "ok") {
    return { index: 4, tone: "ok", label: "已完成" };
  }
  if (status.tone === "error") {
    return { index: 1, tone: "error", label: "需要处理" };
  }
  return { index: 1, tone: "warn", label: "请查看提示" };
}

function QuickAddProgress({ disabled, status }: { disabled: boolean; status: QuickAddStatus | null }) {
  const steps = ["检查", "加入", "刷新", "同步"];
  const progress = quickAddProgressState(status, disabled);
  const width = progress.index === 0 ? 8 : Math.min(100, progress.index * 25);

  return (
    <div className={`quick-add-progress ${progress.tone}`} aria-label="添加进度">
      <div className="quick-add-progress-head">
        <strong>{progress.label}</strong>
        <span>{steps[Math.min(progress.index, steps.length - 1)]}</span>
      </div>
      <div className="quick-add-progress-track">
        <i style={{ width: `${width}%` }} />
      </div>
      <ol>
        {steps.map((step, index) => (
          <li className={index < progress.index ? "done" : index === progress.index ? "active" : ""} key={step}>
            {step}
          </li>
        ))}
      </ol>
    </div>
  );
}

function SourceImportWizardPanel({
  disabled,
  execution,
  onPreview,
  onQuickAdd,
  onPromote,
  onRealWriteAuthorization,
  onStage,
  operatorConsent,
  plan,
  promotion,
  quickAddStatus
}: {
  disabled: boolean;
  execution: SourceImportExecutionCard | null;
  onPreview: (importKind: string, input: string) => void;
  onQuickAdd: (importKind: string, input: string, draft: QuickSourceDraft) => void;
  onPromote: (execution: SourceImportExecutionCard) => void;
  onRealWriteAuthorization: (enabled: boolean) => Promise<void>;
  onStage: (importKind: string, input: string) => void;
  operatorConsent: LegacySnapshot["operatorConsent"];
  plan: SourceImportPlanCard | null;
  promotion: SourceImportPromotionCard | null;
  quickAddStatus: QuickAddStatus | null;
}) {
  const [importKind, setImportKind] = useState<string>("github");
  const [input, setInput] = useState<string>("");
  const [sourceType, setSourceType] = useState<SourceCard["sourceType"]>("skill");
  const [categoryMode, setCategoryMode] = useState<"auto" | "manual">("auto");
  const [selectedCategoryIds, setSelectedCategoryIds] = useState<string[]>([]);
  const [customCategory, setCustomCategory] = useState<string>("");
  const [note, setNote] = useState<string>("");
  const [tags, setTags] = useState<string>("");
  const [enabled, setEnabled] = useState<boolean>(true);
  const [showAdvanced, setShowAdvanced] = useState<boolean>(false);
  const inferredCategoryIds = inferCategoryIds(`${input} ${note} ${sourceType} ${importKind}`);
  const effectiveCategoryIds = resolveCategoryIds(categoryMode, selectedCategoryIds, inferredCategoryIds, sourceType);

  function submitPreview() {
    const value = input.trim();
    if (!value) {
      showUiToast("请先粘贴 GitHub 地址、本地文件夹路径或 zip/.skill 文件路径。");
      return;
    }
    onPreview(importKind, value);
  }

  function submitStage() {
    if (!plan) {
      return;
    }
    if (!plan.safeToContinue) {
      showUiToast("当前计划还不能执行 staging，请先处理阻断项。");
      return;
    }
    onStage(plan.importKind, plan.input);
  }

  function submitQuickAdd() {
    const value = input.trim();
    if (!value) {
      showUiToast("请先粘贴 GitHub 地址、本地文件夹路径或 zip/.skill 文件路径。");
      return;
    }
    const customCategoryLabel = customCategory.trim();
    const primaryCategory =
      customCategoryLabel || categoryDisplayName(effectiveCategoryIds[0] ?? categoryIdForSourceType(sourceType));
    const categoryTags = customCategoryLabel
      ? effectiveCategoryIds.map(categoryDisplayName).join(", ")
      : effectiveCategoryIds.slice(1).map(categoryDisplayName).join(", ");
    const mergedTags = mergeTagInputs(tags, categoryTags);
    onQuickAdd(importKind, value, { category: primaryCategory, enabled, note, sourceType, tags: mergedTags });
  }

  return (
    <section className="source-import-wizard">
      <div className="section-title-row">
        <div>
          <p className="eyebrow">Quick Add</p>
          <h3>一键添加来源</h3>
          <p>粘贴地址，选择类型和分类，然后一键添加并刷新。</p>
        </div>
        <span className="status-badge info">普通模式</span>
      </div>
      <div className="source-add-grid">
        <div className="quick-field-group source-add-kind">
          <span className="quick-field-label">来源类型</span>
          <div className="segmented-control import-kind-control" role="group" aria-label="选择导入类型">
            {[
              ["github", "GitHub"],
              ["local", "本地文件夹"],
              ["zip", "zip / .skill"]
            ].map(([value, label]) => (
              <button
                className={importKind === value ? "active" : ""}
                disabled={disabled}
                key={value}
                onClick={() => setImportKind(value)}
                type="button"
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <label className="import-input-label source-add-input">
          来源地址或路径
          <input
            disabled={disabled}
            onChange={event => setInput(event.target.value)}
            placeholder={
              importKind === "github"
                ? "https://github.com/owner/repo.git"
                : importKind === "local"
                  ? "D:\\My Skills\\some-skill-pack"
                  : "D:\\Downloads\\some-skill-pack.zip"
            }
            value={input}
          />
        </label>
        <label className="quick-source-type-field source-add-type">
          类型
          <select
            disabled={disabled}
            onChange={event => setSourceType(event.target.value as SourceCard["sourceType"])}
            value={sourceType}
          >
            <option value="skill">技能 Skill</option>
            <option value="prompt">润色提示词 Prompt</option>
            <option value="mixed">混合 Mixed</option>
          </select>
        </label>
        <div className="quick-category-field source-add-category">
          <CategoryPicker
            customCategory={customCategory}
            disabled={disabled}
            inferredIds={inferredCategoryIds}
            mode={categoryMode}
            onCustomCategoryChange={value => {
              setCustomCategory(value);
              if (value.trim()) {
                setCategoryMode("manual");
              }
            }}
            onModeChange={setCategoryMode}
            onToggleCategory={categoryId => {
              setCategoryMode("manual");
              setSelectedCategoryIds(previous =>
                previous.includes(categoryId)
                  ? previous.filter(id => id !== categoryId)
                  : [...previous, categoryId]
              );
            }}
            selectedIds={selectedCategoryIds}
          />
        </div>
        <label className="quick-source-tags-field source-add-tags">
          标签
          <input
            disabled={disabled}
            onChange={event => setTags(event.target.value)}
            placeholder="论文, 常用, GitHub"
            value={tags}
          />
        </label>
      </div>
      <label className="quick-source-note">
        备注
        <textarea
          disabled={disabled}
          onChange={event => setNote(event.target.value)}
          placeholder="例如：Nature 写作技能；科研图表常用；只是 Prompt 资料不安装。"
          rows={2}
          value={note}
        />
      </label>
      <div className="quick-source-state-grid">
        <div className="quick-source-setting-row">
          <div className="quick-source-toggle">
            <div>
              <strong>加入后启用</strong>
              <span>只控制来源库显示，不等于同步到 AI 工具。</span>
            </div>
            <ToggleSwitch
              disabled={disabled}
              enabled={enabled}
              label={enabled ? "启用" : "停用"}
              onClick={() => setEnabled(previous => !previous)}
            />
          </div>
        </div>
        <div className={`source-sync-state ${operatorConsent.realWritesEnabled ? "authorized" : "locked"}`}>
          <div>
            <strong>同步到 AI 工具授权</strong>
            <span>
              打开后，“同步 / 刷新”会执行 GitHub 更新、Skill 路由重建，并把共享 Skills 链接同步到 Claude/Codex/Antigravity。
            </span>
          </div>
          <ToggleSwitch
            disabled={disabled}
            enabled={operatorConsent.realWritesEnabled}
            label={operatorConsent.realWritesEnabled ? "已授权" : "未授权"}
            onClick={() => void onRealWriteAuthorization(!operatorConsent.realWritesEnabled)}
          />
        </div>
      </div>
      <div className="quick-source-action-row">
        <div className="quick-source-action-copy">
          <strong>最后一步</strong>
          <span>点击后会加入来源库、刷新索引，并按授权状态同步到 AI 工具。</span>
        </div>
        <button className="primary-action import-quick-add-button" disabled={disabled} onClick={submitQuickAdd} type="button">
          {disabled ? "正在添加" : "一键添加并刷新"}
        </button>
      </div>
      <QuickAddProgress disabled={disabled} status={quickAddStatus} />
      {quickAddStatus && (
        <div className={`quick-add-status-card ${quickAddStatus.tone}`} role="status">
          <strong>{quickAddStatus.title}</strong>
          <span>{quickAddStatus.body}</span>
        </div>
      )}
      <div className="advanced-import-toggle-row">
        <div>
          <strong>高级安全详情</strong>
          <span>排错时再展开，日常添加不需要手动操作。</span>
        </div>
        <button
          className="ghost-action compact"
          onClick={() => setShowAdvanced(previous => !previous)}
          type="button"
        >
          {showAdvanced ? "收起详情" : "展开详情"}
        </button>
      </div>
      {showAdvanced && (
        <div className="advanced-import-details">
          <div className="advanced-import-actions">
            <button className="ghost-button import-preview-button" disabled={disabled} onClick={submitPreview} type="button">
              只生成安全预览
            </button>
          </div>
          {plan && (
        <article className={`import-plan-card ${plan.status}`}>
          <div className="import-plan-head">
            <div>
              <span className="eyebrow">{importKindLabel(plan.importKind)} Plan</span>
              <strong>{plan.displayName}</strong>
              <small>{plan.normalizedTarget || plan.input}</small>
            </div>
            <div className="import-plan-badges">
              <span className={`status-badge ${plan.safeToContinue ? "ok" : "warn"}`}>
                {sourceImportPlanStatusLabel(plan)}
              </span>
              <span className={`risk ${plan.riskLevel}`}>风险：{sourceImportRiskLabel(plan.riskLevel)}</span>
            </div>
          </div>
          <div className="import-plan-metrics">
            <span>{plan.skillCount} Skills</span>
            <span>{plan.promptCount} Prompt 资料</span>
            <span>{plan.duplicateSourceId ? "发现重复" : "未发现重复"}</span>
            <span>写入闸门：{sourceImportWriteGateLabel(plan.writeGateStatus)}</span>
          </div>
          <div className="install-plan-paths">
            <div>
              <strong>目标根目录</strong>
              <code>{plan.targetRoot || "未生成"}</code>
            </div>
            <div>
              <strong>计划目标</strong>
              <code>{plan.targetPath || "需要先修正来源"}</code>
            </div>
            <div>
              <strong>备份位置</strong>
              <code>{plan.backupPath || "当前不会写入，因此未生成备份路径"}</code>
            </div>
          </div>
          {plan.duplicateReason && <p className="import-plan-warning">{plan.duplicateReason}</p>}
          {plan.blockingChecks.length > 0 && (
            <div className="blocking-checks">
              <strong>阻断 / 复核条件</strong>
              <ul>
                {plan.blockingChecks.map(check => (
                  <li key={check}>{check}</li>
                ))}
              </ul>
            </div>
          )}
          <ol className="import-plan-steps">
            {plan.plannedSteps.map(step => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          {plan.installPlanSteps.length > 0 && (
            <div className="install-plan-steps">
              <strong>未来可回滚安装步骤</strong>
              <ol>
                {plan.installPlanSteps.map(step => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
            </div>
          )}
          <footer>
            <strong>回滚要求</strong>
            <span>{plan.rollbackSummary}</span>
          </footer>
          <div className="staging-action-row">
            <div>
              <strong>隔离执行器</strong>
              <span>只写入 app-next/.skillhub-next/staging，不安装到正式来源目录。</span>
            </div>
            <button
              className="primary-action"
              disabled={disabled || !plan.safeToContinue}
              onClick={submitStage}
              type="button"
            >
              执行隔离 staging
            </button>
          </div>
        </article>
          )}
          {execution && (
        <article className={`import-execution-card ${execution.status}`}>
          <div className="import-plan-head">
            <div>
              <span className="eyebrow">Staging Result</span>
              <strong>{sourceImportExecutionStatusLabel(execution.status)}</strong>
              <small>{execution.summary}</small>
            </div>
            <div className="import-plan-badges">
              <span className={`status-badge ${execution.status === "staged" ? "ok" : "warn"}`}>
                {execution.realWriteScope}
              </span>
              <span className={`risk ${execution.riskLevel}`}>风险：{sourceImportRiskLabel(execution.riskLevel)}</span>
            </div>
          </div>
          <div className="import-plan-metrics">
            <span>{execution.skillCount} Skills</span>
            <span>{execution.promptCount} Prompt 资料</span>
            <span>{execution.copiedFiles} files</span>
            <span>{formatBytes(execution.copiedBytes)}</span>
          </div>
          <div className="install-plan-paths">
            <div>
              <strong>Staging 目录</strong>
              <code>{execution.stagedPath || "未写入"}</code>
            </div>
            <div>
              <strong>报告</strong>
              <code>{execution.reportPath || "未生成"}</code>
            </div>
            <div>
              <strong>Manifest</strong>
              <code>{execution.manifestPath || "未生成"}</code>
            </div>
          </div>
          {execution.blockingChecks.length > 0 && (
            <div className="blocking-checks">
              <strong>仍然锁定的正式动作</strong>
              <ul>
                {execution.blockingChecks.map(check => (
                  <li key={check}>{check}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="staging-action-row">
            <div>
              <strong>提升为受管理来源</strong>
              <span>写入 app/github_sources 后，v2 会重新扫描；AI 工具同步仍然保持锁定。</span>
            </div>
            <button
              className="primary-action"
              disabled={disabled || (execution.status !== "staged" && execution.status !== "warn")}
              onClick={() => onPromote(execution)}
              type="button"
            >
              提升为来源
            </button>
          </div>
          <footer>
            <strong>回滚</strong>
            <span>{execution.rollbackSteps.join(" / ")}</span>
          </footer>
        </article>
          )}
          {promotion && (
        <article className={`import-execution-card ${promotion.status}`}>
          <div className="import-plan-head">
            <div>
              <span className="eyebrow">Promotion Result</span>
              <strong>{sourceImportPromotionStatusLabel(promotion.status)}</strong>
              <small>{promotion.summary}</small>
            </div>
            <div className="import-plan-badges">
              <span className={`status-badge ${sourceImportPromotionIsUsable(promotion.status) ? "ok" : "warn"}`}>
                {promotion.realWriteScope}
              </span>
              <span className={`risk ${promotion.riskLevel}`}>风险：{sourceImportRiskLabel(promotion.riskLevel)}</span>
            </div>
          </div>
          <div className="import-plan-metrics">
            <span>{promotion.skillCount} Skills</span>
            <span>{promotion.promptCount} Prompt 资料</span>
            <span>{promotion.copiedFiles} files</span>
            <span>{formatBytes(promotion.copiedBytes)}</span>
          </div>
          <div className="install-plan-paths">
            <div>
              <strong>受管理来源目录</strong>
              <code>{promotion.targetPath || "未写入"}</code>
            </div>
            <div>
              <strong>报告</strong>
              <code>{promotion.reportPath || "未生成"}</code>
            </div>
            <div>
              <strong>Manifest</strong>
              <code>{promotion.manifestPath || "未生成"}</code>
            </div>
          </div>
          {promotion.blockingChecks.length > 0 && (
            <div className="blocking-checks">
              <strong>{sourceImportPromotionIsUsable(promotion.status) ? "状态说明" : "阻断原因"}</strong>
              <ul>
                {promotion.blockingChecks.map(check => (
                  <li key={check}>{check}</li>
                ))}
              </ul>
            </div>
          )}
          <footer>
            <strong>回滚</strong>
            <span>{promotion.rollbackSteps.join(" / ")}</span>
          </footer>
        </article>
          )}
        </div>
      )}
    </section>
  );
}

function SourceEditPanel({
  draft,
  onClose,
  onSave,
  popularity,
  sourceSkills = [],
  source
}: {
  draft?: SourceDraft;
  onClose: () => void;
  onSave: (draft: SourceDraft) => void;
  popularity?: SourcePopularityCard;
  source: SourceCard;
  sourceSkills?: SkillCard[];
}) {
  const [name, setName] = useState(draft?.name ?? source.name);
  const [category, setCategory] = useState(draft?.category ?? source.categoryId);
  const [sourceType, setSourceType] = useState<SourceCard["sourceType"]>(draft?.sourceType ?? source.sourceType);
  const [note, setNote] = useState(draft?.note ?? source.note ?? "");
  const [enabled, setEnabled] = useState(draft?.enabled ?? source.enabled);
  const [tags, setTags] = useState(draft?.tags ?? tagInputValue(source.tags ?? []));
  const routerSkills = sourceSkills.filter(isRouterHubSkill);
  const childSkills = sourceSkills.filter(skill => !isRouterHubSkill(skill));
  const projectAddress = source.url || source.localPath || "未记录项目地址";

  useEffect(() => {
    setName(draft?.name ?? source.name);
    setCategory(draft?.category ?? source.categoryId);
    setSourceType(draft?.sourceType ?? source.sourceType);
    setNote(draft?.note ?? source.note ?? "");
    setEnabled(draft?.enabled ?? source.enabled);
    setTags(draft?.tags ?? tagInputValue(source.tags ?? []));
  }, [draft, source.id]);

  return (
    <aside aria-label={`${source.name} source details`} className="source-detail-panel source-editor-panel" role="complementary">
      <header>
        <div>
          <span>来源详情</span>
          <strong>{source.name}</strong>
        </div>
        <button className="secondary-action compact" onClick={onClose} type="button">
          收起
        </button>
      </header>
      <div className="source-detail-address">
        <span>项目地址</span>
        <code title={projectAddress}>{projectAddress}</code>
      </div>
      <div className="source-detail-metrics">
        <span>
          <b>{source.skillCount}</b>
          <small>Skills</small>
        </span>
        <span>
          <b>{popularity?.stars ? formatCompactNumber(popularity.stars) : "未刷新"}</b>
          <small>GitHub 星标</small>
        </span>
        <span>
          <b>{popularity?.localTotalCount ?? 0}</b>
          <small>本地调用</small>
        </span>
      </div>
      <div className="source-detail-skill-map">
        <div className="source-detail-section-title">
          <strong>母/子 Skill</strong>
          <span>{routerSkills.length} 母入口 · {childSkills.length} 子 Skill</span>
        </div>
        {routerSkills.length > 0 && (
          <div className="source-detail-chip-list">
            {routerSkills.slice(0, 4).map(skill => (
              <span className="kind-chip router" key={skill.relativePath || skill.folderName}>
                [ROUTER-HUB] {skill.name}
              </span>
            ))}
          </div>
        )}
        {childSkills.length > 0 ? (
          <div className="source-detail-child-list">
            {childSkills.slice(0, 12).map(skill => (
              <article key={skill.relativePath || skill.folderName}>
                <strong>{skill.name}</strong>
                <span>{cleanSkillDescription(skill.description) || skill.category || "子 Skill"}</span>
              </article>
            ))}
          </div>
        ) : (
          <p className="source-detail-muted">暂未识别到子 Skill；如果这是多 Skill 仓库，请先重建母 Skill 路由。</p>
        )}
      </div>
      <label>
        名称
        <input onChange={event => setName(event.target.value)} value={name} />
      </label>
      <label>
        类型
        <select onChange={event => setSourceType(event.target.value as SourceCard["sourceType"])} value={sourceType}>
          <option value="skill">Skill</option>
          <option value="prompt">Prompt</option>
          <option value="mixed">Mixed</option>
        </select>
      </label>
      <label>
        细分分类 / 标签
        <input onChange={event => setCategory(event.target.value)} value={category} />
      </label>
      <label>
        多标签
        <input
          onChange={event => setTags(event.target.value)}
          placeholder="例如：GitHub, UI 设计, 常用"
          value={tags}
        />
      </label>
      <label>
        手动备注
        <textarea
          onChange={event => setNote(event.target.value)}
          placeholder="例如：UI 设计参考；Prompt 资料不安装；科研绘图常用。"
          rows={3}
          value={note}
        />
      </label>
      <div className="source-editor-toggle">
        <div>
          <strong>启用此来源</strong>
          <span>只影响管理视图，不会删除本地仓库。</span>
        </div>
        <ToggleSwitch
          disabled={false}
          enabled={enabled}
          label={enabled ? "已启用" : "已停用"}
          onClick={() => setEnabled(previous => !previous)}
        />
      </div>
      <footer>
        <button className="secondary-action" onClick={onClose} type="button">取消</button>
        <button
          className="primary-action"
          onClick={() => onSave({ category, enabled, name, note, sourceType, tags })}
          type="button"
        >
          保存
        </button>
      </footer>
    </aside>
  );
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

function findPromotedSource(sources: SourceCard[], promotion: SourceImportPromotionCard): SourceCard | undefined {
  const targetPath = normalizeSourcePath(promotion.targetPath);
  const sourceName = promotion.sourceName.trim().toLowerCase();

  return sources.find(source => {
    const localPath = normalizeSourcePath(source.localPath);
    const name = source.name.trim().toLowerCase();
    return Boolean(targetPath && localPath === targetPath) || Boolean(sourceName && name === sourceName);
  });
}

function normalizeSourcePath(path: string): string {
  return path.trim().replace(/[\\/]+/g, "/").replace(/\/+$/g, "").toLowerCase();
}

function skillBelongsToSource(skill: SkillCard, source: SourceCard): boolean {
  const sourceName = normalizeLookup(source.name);
  const skillSource = normalizeLookup(skill.source);
  if (sourceName && skillSource === sourceName) {
    return true;
  }

  const sourcePath = normalizeSourcePath(source.localPath);
  const skillPath = normalizeSourcePath(skill.relativePath);
  const sourceFolder = sourcePath.split("/").filter(Boolean).pop() ?? "";
  if (sourceFolder && skillPath.includes(`/${sourceFolder}/`)) {
    return true;
  }

  const sourceUrlName = normalizeLookup((source.url.split("/").pop() ?? "").replace(/\.git$/i, ""));
  return Boolean(sourceUrlName && (skillSource === sourceUrlName || skillPath.includes(`/${sourceUrlName}/`)));
}

function Agents({
  disabled,
  onToggle,
  snapshot
}: {
  disabled: boolean;
  onToggle: (command: string, id: string, enabled: boolean) => Promise<void>;
  snapshot: LegacySnapshot | null;
}) {
  const agents = snapshot?.agents ?? [];
  const adapters = snapshot?.agentAdapters ?? [];
  const safetyChecks = snapshot?.adapterSafetyChecks ?? [];
  const capabilities = snapshot?.adapterCapabilities ?? [];

  return (
    <div className="view agents-view">
      <section className="page-header">
        <div>
          <h2>Agents</h2>
          <p>Separate supported AI tools from tools detected on this machine, then enable adapters safely.</p>
        </div>
        <div className="page-header-stats">
          <span>{adapters.length} supported</span>
          <span>{adapters.filter(adapter => adapter.detected).length} detected</span>
          <span>{adapters.filter(adapter => adapter.enabled).length} enabled</span>
        </div>
      </section>

      <section className="panel">
        <p className="eyebrow">Agent Adapter Registry</p>
        <h3>统一 AI 工具适配器</h3>
        <p>
          AI SkillHub 会先维护“支持哪些工具”的清单，再读取本机检测结果。这样未安装的工具会显示为未检测，而不是报错。
        </p>
      </section>

      <div className="adapter-grid">
        {adapters.map(adapter => (
          <article className="adapter-card" key={adapter.id}>
            <div className="card-head">
              <strong>{adapter.name}</strong>
              <span className={`adapter-status ${adapter.status}`}>{adapterStatusLabel(adapter.status)}</span>
            </div>
            <p>{adapter.skillsPathHint || "此工具暂未提供默认 Skills 目录。"}</p>
            <footer>
              <span>{adapter.vendor}</span>
              <span>{adapter.detected ? "已检测" : "未检测"}</span>
              <span>{adapter.managed ? "已接管" : "未接管"}</span>
              <ToggleSwitch
                disabled={disabled || !adapter.detected}
                enabled={adapter.enabled}
                label={!adapter.detected ? "未检测" : adapter.enabled ? "已启用" : "未启用"}
                onClick={() => onToggle("set_agent_adapter_enabled", adapter.id, !adapter.enabled)}
              />
            </footer>
            <ul className="safety-list">
              {capabilities
                .filter(capability => capability.adapterId === adapter.id)
                .slice(0, 4)
                .map(capability => (
                  <li className={capability.enabled ? "capability-item is-on" : "capability-item"} key={capability.id}>
                    {capabilityLabel(capability.capabilityKey)}
                  </li>
                ))}
              {safetyChecks
                .filter(check => check.adapterId === adapter.id)
                .slice(0, 3)
                .map(check => (
                  <li className={`safety-item ${check.status}`} key={check.id}>
                    {check.summary}
                  </li>
                ))}
            </ul>
          </article>
        ))}
      </div>

      <section className="panel">
        <h3>本机检测结果</h3>
        <div className="agent-list">
          {agents.map(agent => (
            <div className="agent-row" key={agent.name}>
              <strong>{agent.name}</strong>
              <span>{agent.detected ? "已检测" : "未检测"}</span>
              <span>{agent.managed ? "已接管" : "未接管"}</span>
              <span>{agent.enabled ? "v2 启用" : "v2 停用"}</span>
              <small>{agent.path}</small>
            </div>
          ))}
          {agents.length === 0 && <p>正在等待 AI 工具检测结果。</p>}
        </div>
      </section>
    </div>
  );
}

function Snapshots({ snapshot }: { snapshot: LegacySnapshot | null }) {
  const snapshots = snapshot?.snapshots ?? [];
  const backupTargets = snapshot?.backupTargets ?? [];
  const backupDryRun = snapshot?.backupDryRun ?? [];
  const restoreDryRun = snapshot?.restoreDryRun ?? [];
  const rollbackPlan = snapshot?.rollbackPlan ?? [];
  const latest = snapshots.find(item => item.isLatest) ?? snapshots[0];

  return (
    <div className="view snapshots-view">
      <section className="hero-panel snapshot-hero">
        <div>
          <p className="eyebrow">Snapshot / Rollback Gate</p>
          <h2>先把退路修好，再开放真实同步</h2>
          <p>
            当前阶段只记录本地 SQLite 索引快照和回滚计划。真实恢复按钮会保持锁定，直到备份、dry-run
            和路径安全检查全部完成。
          </p>
        </div>
      </section>

      <section className="snapshot-layout">
        <article className="panel">
          <p className="eyebrow">最新快照</p>
          <h3>{latest?.name ?? "等待生成快照"}</h3>
          <p>{latest?.summary ?? "点击刷新后，v2 会把当前只读索引写入 SQLite 快照记录。"}</p>
          <div className="snapshot-meta">
            <span>{latest ? formatScanTime(latest.createdAt) : "未生成"}</span>
            <span>{snapshot?.index.snapshotId ?? "无快照 ID"}</span>
          </div>
        </article>

        <article className="panel rollback-gate">
          <p className="eyebrow">写入闸门</p>
          <h3>真实恢复仍然锁定</h3>
          <p>
            现在能做的是看见风险和准备步骤；不能直接删除链接、覆盖目录或恢复文件。这个闸门以后会保护分享版用户。
          </p>
        </article>
      </section>

      <section className="panel">
        <p className="eyebrow">回滚计划</p>
        <h3>执行前必须逐步通过</h3>
        <div className="rollback-steps">
          {rollbackPlan.map(step => (
            <article className={`rollback-step ${step.status}`} key={step.id}>
              <div className="step-number">{step.stepOrder}</div>
              <div>
                <div className="rollback-step-head">
                  <strong>{step.title}</strong>
                  <span className={`risk ${step.riskLevel}`}>{riskLabel(step.riskLevel)}</span>
                  <span className={`step-status ${step.status}`}>{stepStatusLabel(step.status)}</span>
                </div>
                <p>{step.summary}</p>
              </div>
            </article>
          ))}
          {rollbackPlan.length === 0 && <p>等待下一次刷新生成回滚计划。</p>}
        </div>
      </section>

      <section className="panel">
        <p className="eyebrow">Backup Target Inventory</p>
        <h3>真实接管前必须先备份的目录</h3>
        <div className="backup-target-list">
          {backupTargets.map(target => (
            <article className={`backup-target-card ${target.preflightStatus}`} key={target.id}>
              <div className="backup-target-head">
                <strong>{target.agentName}</strong>
                <span className={`step-status ${target.preflightStatus}`}>
                  {backupStatusLabel(target.preflightStatus)}
                </span>
                <span className={`risk ${target.riskLevel}`}>{riskLabel(target.riskLevel)}</span>
              </div>
              <div className="backup-paths">
                <span>目标</span>
                <code>{target.targetPath}</code>
                <span>备份</span>
                <code>{target.backupPath}</code>
              </div>
              <div className="backup-flags">
                <span>{target.detected ? "已检测" : "未检测"}</span>
                <span>{target.managed ? "已接管" : "未接管"}</span>
                <span>{target.required ? "必须备份" : "暂不需要"}</span>
              </div>
              <p>{target.blocker}</p>
            </article>
          ))}
          {backupTargets.length === 0 && <p>等待下一次刷新生成备份目标清单。</p>}
        </div>
      </section>

      <section className="panel">
        <p className="eyebrow">Backup Dry-run Plan</p>
        <h3>只预演，不复制真实文件</h3>
        <div className="dry-run-list">
          {backupDryRun.map(item => (
            <article className={`dry-run-row ${item.status}`} key={item.id}>
              <div>
                <strong>{item.agentName}</strong>
                <span>{backupActionLabel(item.action)}</span>
              </div>
              <div className="dry-run-paths">
                <code>{item.targetPath}</code>
                <span>→</span>
                <code>{item.backupPath}</code>
              </div>
              <span className={`step-status ${item.status}`}>{dryRunStatusLabel(item.status)}</span>
              <span className={`risk ${item.riskLevel}`}>{riskLabel(item.riskLevel)}</span>
              <p>{item.summary}</p>
            </article>
          ))}
          {backupDryRun.length === 0 && <p>等待下一次刷新生成备份预演计划。</p>}
        </div>
      </section>

      <section className="panel">
        <p className="eyebrow">Restore Dry-run Report</p>
        <h3>只预演，不执行真实恢复</h3>
        <div className="dry-run-list">
          {restoreDryRun.map(item => (
            <article className={`dry-run-row ${item.status}`} key={item.id}>
              <div>
                <strong>{item.agentName}</strong>
                <span>{restoreActionLabel(item.action)}</span>
              </div>
              <div className="dry-run-paths">
                <code>{item.backupPath}</code>
                <span>→</span>
                <code>{item.targetPath}</code>
              </div>
              <span className={`step-status ${item.status}`}>{dryRunStatusLabel(item.status)}</span>
              <span className={`risk ${item.riskLevel}`}>{riskLabel(item.riskLevel)}</span>
              <p>{item.summary}</p>
            </article>
          ))}
          {restoreDryRun.length === 0 && <p>等待下一次刷新生成恢复预演报告。</p>}
        </div>
      </section>

      <section className="panel">
        <p className="eyebrow">历史快照</p>
        <h3>最近记录</h3>
        <div className="snapshot-list">
          {snapshots.map(item => (
            <article className={item.isLatest ? "snapshot-row latest" : "snapshot-row"} key={item.id}>
              <strong>{item.name}</strong>
              <span>{item.summary}</span>
              <small>{formatScanTime(item.createdAt)}</small>
            </article>
          ))}
          {snapshots.length === 0 && <p>暂无历史快照。</p>}
        </div>
      </section>
    </div>
  );
}

function ReleaseGate({
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
  const writeGates = snapshot?.writeGates ?? [];
  const diagnosticsReport = releaseReports.find(report => report.id === "diagnostics");
  const releasePreflight = releaseReports.find(report => report.id === "release-preflight");
  const shareRecipient = releaseReports.find(report => report.id === "share-recipient");
  const zipPreview = releaseReports.find(report => report.id === "zip-preview");
  const desktopQaChecks = snapshot?.desktopQaChecks ?? [];
  const backupDryRun = snapshot?.backupDryRun ?? [];
  const restoreDryRun = snapshot?.restoreDryRun ?? [];
  const rollbackPlan = snapshot?.rollbackPlan ?? [];
  const operatorConsent = snapshot?.operatorConsent ?? {
    realWritesEnabled: false,
    enabledAt: "",
    updatedAt: "",
    summary: "真实写入授权未开启；同步按钮只刷新索引，不会写入 AI 工具目录。"
  };
  const blockedBackups = countByStatus(backupDryRun, "blocked");
  const plannedBackups = countByStatus(backupDryRun, "planned");
  const blockedRestores = countByStatus(restoreDryRun, "blocked");
  const plannedRestores = countByStatus(restoreDryRun, "planned");
  const lockedRollbackSteps = rollbackPlan.filter(step => step.status === "locked").length;
  const diagnosticsReady = Boolean(
    diagnosticsReport?.ok ?? (diagnostics?.available && diagnostics.error === 0)
  );

  const gateItems = [
    {
      status: diagnosticsReady ? "done" : "blocked",
      title: "诊断体检",
      label: diagnosticsReady ? "已通过" : "待处理",
      summary: diagnosticsReady
        ? diagnosticsReport?.summary ??
          `诊断可读取：${diagnostics?.ok ?? 0} ok / ${diagnostics?.warn ?? 0} warn / ${diagnostics?.error ?? 0} error。`
        : "没有可用诊断，或诊断仍包含错误。"
    },
    {
      status: backupDryRun.length > 0 && blockedBackups === 0 && plannedBackups === 0 ? "done" : "planned",
      title: "备份预演",
      label: backupDryRun.length > 0 ? "只读预演" : "待生成",
      summary:
        backupDryRun.length > 0
          ? `${backupDryRun.length} 项预演，${plannedBackups} 项仍在计划中，${blockedBackups} 项阻断。`
          : "等待刷新后生成备份 dry-run。"
    },
    {
      status: restoreDryRun.length > 0 && blockedRestores === 0 && plannedRestores === 0 ? "done" : "planned",
      title: "恢复预演",
      label: restoreDryRun.length > 0 ? "只读预演" : "待生成",
      summary:
        restoreDryRun.length > 0
          ? `${restoreDryRun.length} 项预演，${plannedRestores} 项仍在计划中，${blockedRestores} 项阻断。`
          : "等待刷新后生成恢复 dry-run。"
    },
    {
      status: lockedRollbackSteps === 0 && rollbackPlan.length > 0 ? "done" : "blocked",
      title: "回滚锁",
      label: lockedRollbackSteps === 0 ? "未锁定" : "仍锁定",
      summary:
        rollbackPlan.length > 0
          ? `${rollbackPlan.length} 个回滚步骤，${lockedRollbackSteps} 个真实执行步骤仍锁定。`
          : "等待刷新后生成回滚计划。"
    },
    {
      status: desktopQaGateStatus(desktopQaChecks),
      title: "桌面 QA",
      label: desktopQaGateLabel(desktopQaChecks),
      summary: desktopQaGateSummary(desktopQaChecks)
    },
    {
      status: releaseReportGateStatus(releasePreflight),
      title: "发布预检",
      label: releaseReportGateLabel(releasePreflight),
      summary: releasePreflight?.summary ?? "还没有找到发布预检报告。"
    },
    {
      status: releaseReportGateStatus(shareRecipient),
      title: "分享验证",
      label: releaseReportGateLabel(shareRecipient),
      summary: shareRecipient?.summary ?? "还没有找到分享验收报告。"
    },
    {
      status: releaseReportGateStatus(zipPreview),
      title: "zip 预览",
      label: releaseReportGateLabel(zipPreview),
      summary: zipPreview?.summary ?? "还没有找到 zip 导入预览报告。"
    }
  ];
  const doneCount = gateItems.filter(item => item.status === "done").length;
  const blockedCount = gateItems.filter(item => item.status === "blocked").length;
  const plannedCount = gateItems.filter(item => item.status === "planned").length;
  const readinessStatus = blockedCount > 0 ? "blocked" : plannedCount > 0 ? "planned" : "done";
  const readinessLabel =
    readinessStatus === "done" ? "候选可复查" : readinessStatus === "blocked" ? "禁止发布" : "暂不发布";
  const readinessTitle =
    readinessStatus === "done"
      ? "所有发布闸门已通过"
      : readinessStatus === "blocked"
        ? "现在不能发布"
        : "现在暂不发布";
  const readinessReason = releaseReadinessReason(gateItems);
  const readinessSummary =
    readinessStatus === "done"
      ? "可以进入候选打包复查；此页面仍不会直接执行打包。"
      : readinessReason;
  const readinessDetails = gateItems
    .filter(item => item.status !== "done")
    .slice(0, 4);

  return (
    <div className="view release-view">
      <section className="hero-panel release-hero">
        <div>
          <p className="eyebrow">Release Gate</p>
          <h2>所有安全闸门通过前，不生成可分享版本</h2>
          <p>
            这个页面把备份预演、恢复预演、诊断、桌面 QA 和分享验证集中到一个发布前入口。
            当前仍是只读状态面板，不会执行打包或写入。
          </p>
        </div>
      </section>

      <section className={`panel readiness-panel ${readinessStatus}`}>
        <div>
          <p className="eyebrow">Release Readiness</p>
          <h3>{readinessTitle}</h3>
          <p>
            {readinessSummary} 当前进度：{doneCount}/{gateItems.length} 个闸门通过，{plannedCount} 个待复查，{blockedCount} 个阻断。
          </p>
        </div>
        <span className={`qa-status ${readinessStatus}`}>{readinessLabel}</span>
        {readinessDetails.length > 0 && (
          <div className="readiness-reasons">
            {readinessDetails.map(item => (
              <span key={item.title}>{item.title}：{item.label}</span>
            ))}
          </div>
        )}
      </section>

      <section className="release-summary-grid">
        <article className="metric">
          <span>闸门总数</span>
          <strong>{gateItems.length}</strong>
        </article>
        <article className="metric">
          <span>已通过</span>
          <strong>{doneCount}</strong>
        </article>
        <article className="metric">
          <span>待处理</span>
          <strong>{gateItems.length - doneCount}</strong>
        </article>
        <article className="metric">
          <span>阻断项</span>
          <strong>{blockedCount}</strong>
        </article>
      </section>

      <section className="panel release-gate-panel">
        <p className="eyebrow">Preflight Status</p>
        <h3>发布仍保持锁定</h3>
        <p>
          只有当诊断、备份预演、恢复预演、回滚、桌面 QA、发布预检和分享验证都通过后，v2 才应该开放打包入口。
        </p>
        <div className="release-gate-grid">
          {gateItems.map(item => (
            <article className={`release-gate-card ${item.status}`} key={item.title}>
              <span className={`qa-status ${item.status}`}>{item.label}</span>
              <strong>{item.title}</strong>
              <small>{item.summary}</small>
            </article>
          ))}
        </div>
      </section>

      <section className="panel write-gate-panel">
        <div className="section-title-row">
          <div>
            <p className="eyebrow">Real Write Unlock Matrix</p>
            <h3>真实导入 / 同步 / 打包解锁条件</h3>
            <p>
              这里列出每类真实写入的通过项、阻断项和下一步。用户授权只是最后一道许可，不会绕过备份、恢复、QA 和报告闸门。
            </p>
          </div>
          <span className={`status-badge ${operatorConsent.realWritesEnabled ? "ok" : "warn"}`}>
            {operatorConsent.realWritesEnabled ? "真实写入已授权" : "真实写入未授权"}
          </span>
        </div>
        <article className={`real-write-consent-card ${operatorConsent.realWritesEnabled ? "armed" : ""}`}>
          <div>
            <span className="eyebrow">Operator Authorization</span>
            <strong>真实写入授权开关</strong>
            <p>{operatorConsent.summary}</p>
            <small>
              {operatorConsent.realWritesEnabled
                ? `开启时间：${formatScanTime(operatorConsent.enabledAt || operatorConsent.updatedAt)}`
                : "关闭状态下，最终执行器只会生成阻断报告，不会改 Claude / Codex / Antigravity 目录。"}
            </small>
          </div>
          <ToggleSwitch
            disabled={disabled}
            enabled={operatorConsent.realWritesEnabled}
            label={operatorConsent.realWritesEnabled ? "已授权" : "未授权"}
            onClick={() => void onRealWriteAuthorization(!operatorConsent.realWritesEnabled)}
          />
        </article>
        <div className="write-gate-grid">
          {writeGates.map(gate => (
            <article className={`write-gate-card ${writeGateStatusClass(gate)}`} key={gate.id}>
              <div className="card-head">
                <div>
                  <strong>{gate.title}</strong>
                  <small>{gate.operationType} · 风险 {writeGateRiskLabel(gate.riskLevel)}</small>
                </div>
                <span className={`qa-status ${writeGateStatusClass(gate)}`}>
                  {writeGateStatusLabel(gate)}
                </span>
              </div>
              <p>{gate.summary}</p>
              <div className="write-gate-checks">
                {gate.blockingChecks.slice(0, 4).map(check => (
                  <span className="check-line blocked" key={`blocked-${gate.id}-${check}`}>{check}</span>
                ))}
                {gate.passingChecks.slice(0, 3).map(check => (
                  <span className="check-line ok" key={`ok-${gate.id}-${check}`}>{check}</span>
                ))}
              </div>
              <div className="write-plan-preview">
                <div>
                  <span>执行预览</span>
                  {gate.planSteps.slice(0, 4).map(step => (
                    <small key={`plan-${gate.id}-${step}`}>{step}</small>
                  ))}
                </div>
                <div>
                  <span>回滚预案</span>
                  {gate.rollbackSteps.slice(0, 3).map(step => (
                    <small key={`rollback-${gate.id}-${step}`}>{step}</small>
                  ))}
                </div>
              </div>
              <small>{gate.nextAction}</small>
            </article>
          ))}
          {writeGates.length === 0 && <EmptyState text="等待本地 SQLite 生成真实写入解锁矩阵。" />}
        </div>
      </section>

      <section className="panel release-report-panel">
        <p className="eyebrow">Report Inputs</p>
        <h3>已接入的报告摘要</h3>
        <p>
          当前版本只读取这些报告的摘要，不执行历史脚本，也不修改任何本机 AI 工具目录。
        </p>
        <div className="release-report-grid">
          {releaseReports.map(report => (
            <article className={`release-report-card ${releaseReportGateStatus(report)}`} key={report.id}>
              <div>
                <span className={`qa-status ${releaseReportGateStatus(report)}`}>{releaseReportGateLabel(report)}</span>
                <strong>{report.title}</strong>
              </div>
              <small>{formatScanTime(report.generatedAt)}</small>
              <p>{report.summary}</p>
              <div className="release-report-stats">
                <span>{report.passed}/{report.total} 通过</span>
                <span>{report.warn} warn</span>
                <span>{report.error} error</span>
              </div>
            </article>
          ))}
          {releaseReports.length === 0 && <p>未找到报告。请先生成诊断包、发布预检或分享验收。</p>}
        </div>
      </section>

      <section className="panel release-next-panel">
        <p className="eyebrow">Next Safe Step</p>
        <h3>下一步执行 dry-run 发布工具</h3>
        <p>
          诊断、预检、分享和 zip 预览已经进入发布闸门；真实同步和正式打包先经过解锁检查，
          没有通过前只允许生成可审计 dry-run 报告。
        </p>
      </section>

      <section className="panel operation-runner-panel">
        <div className="section-title-row">
          <div>
            <p className="eyebrow">Dry-run Executors</p>
            <h3>诊断 / 分享 / 解锁检查 / 发布执行器</h3>
            <p>
              执行器会先生成 dry-run、解锁检查和最终执行尝试报告；安全闸门未全部通过前，不会接管 AI
              工具目录，也不会生成发布包或 GitHub Release。
            </p>
          </div>
          <span className="status-badge warn">真实写入锁定</span>
        </div>
        <div className="operation-runner-grid">
          {operationRunners.map(runner => (
            <article className={`operation-runner-card ${runner.status}`} key={runner.id}>
              <div className="card-head">
                <strong>{runner.title}</strong>
                <span className={`qa-status ${operationRunnerStatusClass(runner.status, runner.locked)}`}>
                  {operationRunnerStatusLabel(runner.status, runner.locked)}
                </span>
              </div>
              <p>{runner.summary}</p>
              <div className="runner-meta">
                <span>{runner.runnerType}</span>
                <span>{runner.lastRunAt ? formatScanTime(runner.lastRunAt) : "未运行"}</span>
                <span>{runner.fileCount ? `${runner.fileCount} 个导出文件` : "等待导出"}</span>
              </div>
              <small>{runner.nextAction}</small>
              <div className="runner-export-paths">
                <span>目录</span>
                <code title={runner.exportDir}>{runner.exportDir}</code>
                <span>最新报告</span>
                <code title={runner.latestMarkdownPath || runner.reportPath}>
                  {runner.latestMarkdownPath || runner.reportPath}
                </code>
                <span>清单</span>
                <code title={runner.manifestPath}>{runner.manifestPath}</code>
              </div>
              <div className="runner-export-actions">
                <button
                  className="ghost-action compact"
                  disabled={disabled || runner.fileCount === 0 || !runner.exportDir}
                  onClick={() => void openReleaseGateExportPath(runner.exportDir)}
                  type="button"
                >
                  打开目录
                </button>
                <button
                  className="ghost-action compact"
                  disabled={disabled || runner.fileCount === 0 || !(runner.latestMarkdownPath || runner.reportPath)}
                  onClick={() => void openReleaseGateExportPath(runner.latestMarkdownPath || runner.reportPath)}
                  type="button"
                >
                  打开报告
                </button>
                <button
                  className="ghost-action compact"
                  disabled={disabled || !(runner.latestMarkdownPath || runner.reportPath)}
                  onClick={() =>
                    void copyTextToClipboard(runner.latestMarkdownPath || runner.reportPath, "已复制报告路径。")
                  }
                  type="button"
                >
                  复制路径
                </button>
              </div>
              <button
                className="secondary-action compact"
                disabled={disabled}
                onClick={() => void onRunRunner(runner.id)}
                type="button"
              >
                {operationRunnerActionLabel(runner.runnerType, runner.locked)}
              </button>
            </article>
          ))}
          {operationRunners.length === 0 && <EmptyState text="等待本地 SQLite 生成 dry-run 执行器清单。" />}
        </div>
      </section>
    </div>
  );
}

function Settings({
  disabled,
  onOpenRelease,
  onOpenSnapshots,
  onQaStatus,
  snapshot
}: {
  disabled: boolean;
  onOpenRelease: () => void;
  onOpenSnapshots: () => void;
  onQaStatus: (id: string, status: "pending" | "passed" | "failed") => void;
  snapshot: LegacySnapshot | null;
}) {
  const desktopQaChecks = snapshot?.desktopQaChecks ?? [];

  return (
    <div className="view settings-view">
      <section className="panel">
        <h3>迁移策略</h3>
        <p>
          AI SkillHub 现在作为日常 UI 使用：添加来源、搜索 Skill、刷新索引和同步入口都在这里。真实写入 AI 工具目录仍需要在 Sources 里开启授权。
        </p>
        <div className="setting-row">
          <span>中央目录</span>
          <code>{snapshot?.skillsDir ?? "../skills"}</code>
        </div>
        <div className="setting-row">
          <span>来源目录</span>
          <code>{snapshot?.sourcesDir ?? "../app/github_sources"}</code>
        </div>
        <div className="setting-row">
          <span>诊断报告</span>
          <code>{snapshot?.diagnosticsFile ?? "../app/reports/latest-diagnostics.json"}</code>
        </div>
      </section>

      <section className="panel advanced-tools-panel">
        <p className="eyebrow">Advanced Tools</p>
        <h3>高级安全工具已从主导航降级</h3>
        <p>
          Snapshots 和 Release Gate 仍然有用：它们负责备份、回滚、分享和发布前检查；但它们不应该挡住日常“添加来源 -&gt; 搜索 Skill -&gt; 同步刷新”的主流程。
        </p>
        <div className="advanced-tools-actions">
          <button className="secondary-action" onClick={onOpenSnapshots} type="button">
            <Icon name="snapshots" /> 打开快照 / 回滚
          </button>
          <button className="secondary-action" onClick={onOpenRelease} type="button">
            <Icon name="release" /> 打开发布检查
          </button>
        </div>
      </section>

      <section className="panel release-guide">
        <p className="eyebrow">Build / Release Guide</p>
        <h3>开发版 exe 和正式发布版不是一回事</h3>
        <p>
          当前版本仍在开发线。日常测试请用开发命令启动桌面窗口；最终给别人使用的安装包，要等安全闸门和分享验证通过后再打包。
        </p>
        <div className="release-guide-grid">
          <article>
            <strong>现在测试</strong>
            <span>开发桌面窗口</span>
            <code>pnpm dev:desktop</code>
            <small>会先清理残留调试进程，再启动 Tauri dev。</small>
          </article>
          <article>
            <strong>调试 exe</strong>
            <span>只给开发阶段使用</span>
            <code>src-tauri\target\debug\ai-skillhub-next.exe</code>
            <small>它不是可分享安装包，直接复制给别人不稳定。</small>
          </article>
          <article>
            <strong>正式发布</strong>
            <span>以后才开放</span>
            <code>pnpm tauri build</code>
            <small>通过备份、回滚、发布预检和分享验证后再生成。</small>
          </article>
        </div>
      </section>

      <section className="panel desktop-qa">
        <p className="eyebrow">Desktop QA Checklist</p>
        <h3>桌面窗口发布前检查</h3>
        <p>
          每次准备打包前都要用真实 Tauri 桌面窗口检查，不用浏览器预览代替。这里的状态只写入本地 SQLite，不会修改历史目录或 AI 工具目录。
        </p>
        <div className="qa-checklist-grid">
          {desktopQaChecks.map(check => (
            <article className={`qa-check-card ${qaStatusClass(check.status)}`} key={check.id}>
              <span className={`qa-status ${qaStatusClass(check.status)}`}>{qaStatusLabel(check.status)}</span>
              <strong>{check.title}</strong>
              <small>{check.description}</small>
              <div className="qa-actions" aria-label={`${check.title} 状态`}>
                <button
                  className={check.status === "passed" ? "qa-action active" : "qa-action"}
                  disabled={disabled}
                  onClick={() => onQaStatus(check.id, "passed")}
                  type="button"
                >
                  通过
                </button>
                <button
                  className={check.status === "failed" ? "qa-action danger active" : "qa-action danger"}
                  disabled={disabled}
                  onClick={() => onQaStatus(check.id, "failed")}
                  type="button"
                >
                  失败
                </button>
                <button
                  className={check.status === "pending" ? "qa-action muted active" : "qa-action muted"}
                  disabled={disabled}
                  onClick={() => onQaStatus(check.id, "pending")}
                  type="button"
                >
                  待查
                </button>
              </div>
              <small className="qa-updated">更新：{formatScanTime(check.updatedAt)}</small>
            </article>
          ))}
          {desktopQaChecks.length === 0 && <EmptyState text="等待本地 SQLite 生成桌面 QA 检查项。" />}
        </div>
      </section>
    </div>
  );
}

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
  if (searchTheme === "light" || searchTheme === "dark") return searchTheme;
  const savedTheme = window.localStorage.getItem("ai-skillhub-theme");
  return savedTheme === "light" || savedTheme === "dark" ? savedTheme : "dark";
}

function isNavKey(value: string | null): value is NavKey {
  return navItems.some(item => item.key === value) || advancedNavKeys.includes(value as NavKey) || value === "settings";
}

function showUiToast(message: string) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(TOAST_EVENT, { detail: message }));
}

function normalizeSearch(value: string): string {
  return value
    .toLowerCase()
    .replace(/^\/+/, "")
    .replace(/[_/\\.-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function compactSearch(value: string): string {
  return value
    .toLowerCase()
    .replace(/^\/+/, "")
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "");
}

function queryLooksLikeSkillCommand(query: string): boolean {
  return query.trim().startsWith("/");
}

function textMatchesSearch(query: string, values: Array<string | string[] | undefined>): boolean {
  const tokens = normalizeSearch(query).split(" ").filter(Boolean);
  if (tokens.length === 0) return true;
  const joinedValues = values
    .flatMap(value => (Array.isArray(value) ? value : [value ?? ""]))
    .join(" ");
  const haystack = normalizeSearch(joinedValues);
  const compactQuery = compactSearch(query);
  const compactHaystack = compactSearch(joinedValues);
  return tokens.every(token => haystack.includes(token))
    || (compactQuery.length >= 2 && compactHaystack.includes(compactQuery));
}

function searchScore(query: string, priorityValues: string[], values: Array<string | string[] | undefined>): number {
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

  const joinedValues = values
    .flatMap(value => (Array.isArray(value) ? value : [value ?? ""]))
    .join(" ");
  const haystack = normalizeSearch(joinedValues);
  const compactHaystack = compactSearch(joinedValues);
  if (haystack.includes(normalizedQuery)) score = Math.max(score, 42);
  if (compactQuery && compactHaystack.includes(compactQuery)) score = Math.max(score, 40);
  return score;
}

function categoryDisplayName(category: string): string {
  const option = findCategoryOption(category);
  return option?.label ?? category;
}

function findCategoryOption(category: string): CategoryOption | undefined {
  const normalized = normalizeSearch(category);
  if (!normalized) return undefined;
  return CATEGORY_OPTIONS.find(option => {
    const values = [option.id, option.label, ...option.keywords].map(normalizeSearch);
    return values.some(value => value === normalized);
  });
}

function categoryMatchesFilter(category: string, filterId: string): boolean {
  if (filterId === "all") return true;
  const filter = CATEGORY_OPTIONS.find(option => option.id === filterId);
  if (!filter) return normalizeSearch(category) === normalizeSearch(filterId);
  const normalizedCategory = normalizeSearch(category);
  if (!normalizedCategory) return filter.id === "general";
  return [filter.id, filter.label, ...filter.keywords].some(value => {
    const normalizedValue = normalizeSearch(value);
    return normalizedCategory.includes(normalizedValue) || normalizedValue.includes(normalizedCategory);
  });
}

function categoryIdForSourceType(sourceType: SourceCard["sourceType"]): string {
  if (sourceType === "prompt") return "prompt-polishing";
  if (sourceType === "mixed") return "general";
  return "agent-tools";
}

function inferCategoryIds(input: string): string[] {
  const text = normalizeSearch(input);
  const matches = CATEGORY_OPTIONS.filter(option =>
    [option.id, option.label, ...option.keywords].some(keyword => text.includes(normalizeSearch(keyword)))
  ).map(option => option.id);
  return matches.length > 0 ? Array.from(new Set(matches)).slice(0, 4) : ["general"];
}

function resolveCategoryIds(
  mode: "auto" | "manual",
  selectedIds: string[],
  inferredIds: string[],
  sourceType: SourceCard["sourceType"]
): string[] {
  if (mode === "manual") {
    return selectedIds.length > 0 ? selectedIds : [categoryIdForSourceType(sourceType)];
  }
  if (inferredIds.length === 0 || (inferredIds.length === 1 && inferredIds[0] === "general")) {
    return [categoryIdForSourceType(sourceType)];
  }
  return inferredIds;
}

function mergeTagInputs(...values: string[]): string {
  return parseTagInput(values.join(", ")).join(", ");
}

function skillMatchesSearch(skill: SkillCard, query: string): boolean {
  return textMatchesSearch(query, [
    skill.name,
    skill.folderName,
    skill.category,
    categoryDisplayName(skill.category),
    skill.description,
    skill.note,
    skill.source,
    skill.relativePath,
    skill.tags
  ]);
}

function skillSearchScore(skill: SkillCard, query: string): number {
  return searchScore(query, [skill.name, skill.folderName], [
    skill.name,
    skill.folderName,
    skill.category,
    categoryDisplayName(skill.category),
    skill.description,
    skill.note,
    skill.source,
    skill.relativePath,
    skill.tags
  ]);
}

function sourceMatchesSearch(source: SourceCard, query: string): boolean {
  return textMatchesSearch(query, [
    source.name,
    source.categoryId,
    categoryDisplayName(source.categoryId),
    source.sourceType,
    source.health,
    source.mode,
    source.note,
    source.url,
    source.localPath,
    source.tags
  ]);
}

function sourceSearchScore(source: SourceCard, query: string): number {
  return searchScore(query, [source.name, source.url ?? "", source.localPath ?? ""], [
    source.name,
    source.categoryId,
    categoryDisplayName(source.categoryId),
    source.sourceType,
    source.health,
    source.mode,
    source.note,
    source.url,
    source.localPath,
    source.tags
  ]);
}

function sortSources(
  sources: SourceCard[],
  sortKey: SourceSortKey,
  sourcePopularityById: Map<string, SourcePopularityCard>
): SourceCard[] {
  return [...sources].sort((left, right) => {
    const leftPopularity = sourcePopularityById.get(left.id);
    const rightPopularity = sourcePopularityById.get(right.id);
    const nameCompare = left.name.localeCompare(right.name, "zh-Hans-CN", {
      numeric: true,
      sensitivity: "base"
    });

    switch (sortKey) {
      case "usage":
        return sourceUsageValue(rightPopularity) - sourceUsageValue(leftPopularity) || nameCompare;
      case "heat":
        return sourceHeatValue(rightPopularity) - sourceHeatValue(leftPopularity) || nameCompare;
      case "skillCount":
        return right.skillCount - left.skillCount || nameCompare;
      case "health":
        return sourceHealthRank(left) - sourceHealthRank(right) || nameCompare;
      case "name":
        return nameCompare;
      case "recent":
      default:
        return sourceRecentValue(right, rightPopularity) - sourceRecentValue(left, leftPopularity) || nameCompare;
    }
  });
}

function sourceUsageValue(popularity?: SourcePopularityCard): number {
  return popularity?.localTotalCount ?? 0;
}

function sourceHeatValue(popularity?: SourcePopularityCard): number {
  return popularity?.stars ?? 0;
}

function sourceRecentValue(source: SourceCard, popularity?: SourcePopularityCard): number {
  return (
    dateValue(source.createdAt) ||
    dateValue(popularity?.fetchedAt) ||
    dateValue(popularity?.lastUpdatedAt) ||
    dateValue(popularity?.createdAt)
  );
}

function sourceHealthRank(source: SourceCard): number {
  const ranks: Record<string, number> = { error: 0, warn: 1, info: 2, ok: 3 };
  return ranks[source.health] ?? 4;
}

function dateValue(value?: string): number {
  if (!value) return 0;
  if (/^\d+$/.test(value)) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return 0;
    return value.length > 16 ? Math.floor(numeric / 1_000_000) : numeric;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function categoryTone(category: string): string {
  const value = category.toLowerCase();
  if (value.includes("design") || value.includes("ui") || category.includes("设计")) return "tone-tertiary";
  if (value.includes("research") || category.includes("科研") || category.includes("论文")) return "tone-primary";
  if (value.includes("security") || category.includes("安全")) return "tone-error";
  if (value.includes("development") || value.includes("dev") || category.includes("工程")) return "tone-secondary";
  return "tone-surface";
}

function skillIcon(category: string): IconName {
  const value = category.toLowerCase();
  if (value.includes("design") || value.includes("ui") || category.includes("设计")) return "sparkle";
  if (value.includes("research") || category.includes("科研") || category.includes("论文")) return "library";
  if (value.includes("figure") || category.includes("图")) return "dashboard";
  if (value.includes("security") || category.includes("安全")) return "alert";
  if (value.includes("development") || value.includes("dev") || category.includes("工程")) return "workspaces";
  return "sparkle";
}

function statusDotClass(health: string): string {
  if (health === "ok") return "healthy";
  if (health === "error") return "error";
  return "syncing";
}

function skillStatusLabel(health: string): string {
  if (health === "ok") return "Active";
  if (health === "warn") return "Review";
  if (health === "error") return "Failed";
  if (health === "info") return "Info";
  return health;
}

function sourceTypeLabel(sourceType: string): string {
  if (sourceType === "skill") return "Skill";
  if (sourceType === "prompt") return "Prompt";
  if (sourceType === "mixed") return "Mixed";
  return sourceType;
}

function sourceIsGithub(source: SourceCard): boolean {
  const url = source.url?.trim() ?? "";
  return /(^https?:\/\/github\.com\/|^git@github\.com:)/i.test(url);
}

function sourcePopularityInfo(
  source: SourceCard,
  popularity?: SourcePopularityCard
): { label: string; title: string; tone: "fresh" | "pending" | "error" | "muted" } {
  if (!sourceIsGithub(source)) {
    return {
      label: "非 GitHub",
      title: "本地文件夹、Prompt 或 zip 来源没有 GitHub 星标。",
      tone: "muted"
    };
  }

  if (!popularity) {
    return {
      label: "★ 待刷新",
      title: "还没有 GitHub 热度缓存；点击“同步并刷新”会刷新索引并请求 GitHub 热度。",
      tone: "pending"
    };
  }

  if (popularity.cacheStatus === "error") {
    return {
      label: "★ 失败",
      title: popularity.error ? `GitHub 热度刷新失败：${popularity.error}` : "GitHub 热度刷新失败；可能是网络、限流或仓库不可访问。",
      tone: "error"
    };
  }

  return {
    label: `★ ${formatCompactNumber(popularity.stars)}`,
    title: `GitHub 星标：${formatCompactNumber(popularity.stars)}；缓存时间：${formatScanTime(popularity.fetchedAt)}`,
    tone: "fresh"
  };
}

function importKindLabel(importKind: string): string {
  if (importKind === "github") return "GitHub";
  if (importKind === "local") return "Local";
  if (importKind === "zip") return "Package";
  return importKind;
}

function importPreviewStatusLabel(card: ImportPreviewCard): string {
  if (card.status === "ready") return "Ready";
  if (card.status === "empty") return "Empty";
  if (card.status === "ok") return "Safe";
  if (card.status === "missing") return "Missing";
  if (card.status === "error" || card.status === "blocked") return "Blocked";
  if (card.status === "warn") return "Review";
  return card.safeToContinue ? "Ready" : "Review";
}

function sourceImportPlanStatusLabel(plan: SourceImportPlanCard): string {
  if (plan.status === "ready") return "可进入下一步";
  if (plan.status === "warn") return "需要复核";
  if (plan.status === "locked") return "真实导入锁定";
  if (plan.status === "blocked") return "已阻止";
  return plan.safeToContinue ? "可进入下一步" : "需要复核";
}

function sourceImportRiskLabel(riskLevel: string): string {
  if (riskLevel === "low") return "低";
  if (riskLevel === "medium") return "中";
  if (riskLevel === "high") return "高";
  return riskLevel || "未知";
}

function sourceImportExecutionStatusLabel(status: string): string {
  if (status === "staged") return "已进入隔离 staging";
  if (status === "warn") return "已 staging，需复核";
  if (status === "locked") return "执行器锁定";
  if (status === "blocked") return "已阻止";
  return status || "未知状态";
}

function sourceImportPromotionStatusLabel(status: string): string {
  if (status === "promoted") return "已提升为受管理来源";
  if (status === "already-managed") return "来源已存在，已纳入管理";
  if (status === "blocked") return "提升已阻止";
  return status || "未知状态";
}

function sourceImportPromotionIsUsable(status: string): boolean {
  return status === "promoted" || status === "already-managed";
}

function sourceImportWriteGateLabel(status: string): string {
  if (status === "dry-run-ready") return "dry-run 可继续";
  if (status === "locked") return "真实写入锁定";
  if (status === "blocked") return "已阻断";
  return status || "未知";
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function createPreviewSourceImportPlan(
  importKind: string,
  input: string,
  sources: SourceCard[]
): SourceImportPlanCard {
  const value = input.trim();
  const displayName = value
    .split(/[\\/]/)
    .filter(Boolean)
    .pop()
    ?.replace(/\.git$/i, "")
    .replace(/\.(zip|skill)$/i, "") || "未命名来源";
  const normalizedGithub = normalizePreviewGithubUrl(value);
  const normalizedTarget = importKind === "github" ? normalizedGithub : value;
  const duplicate = sources.find(source => {
    if (importKind === "github") {
      return normalizePreviewGithubUrl(source.url) === normalizedGithub;
    }
    return (source.localPath || source.url || "").trim().toLowerCase() === value.toLowerCase();
  });
  const isGithubValid = importKind !== "github" || Boolean(normalizedGithub);
  const isPackage = importKind === "zip";
  const safeToContinue = Boolean(value && isGithubValid && !duplicate && !isPackage);
  const status = duplicate || !isGithubValid ? "blocked" : isPackage ? "locked" : safeToContinue ? "ready" : "warn";
  const targetRoot = "浏览器预览/app/github_sources";
  const targetPath = `${targetRoot}/${displayName}`;
  const backupPath = `浏览器预览/app-next/.skillhub-next/backups/source-imports/${displayName}`;
  const blockingChecks = [
    duplicate ? `重复来源：${duplicate.name}` : "",
    !isGithubValid ? "GitHub 地址格式不符合普通仓库地址。" : "",
    isPackage ? "zip/.skill 必须先通过解压安全扫描。" : "",
    "未开启真实写入授权时，只会刷新 AI SkillHub 索引，不会写入 AI 工具目录。"
  ].filter((check): check is string => Boolean(check));

  return {
    id: `preview-${importKind}-${displayName}`,
    importKind,
    input: value,
    normalizedTarget,
    targetRoot,
    targetPath,
    backupPath,
    displayName,
    status,
    riskLevel: duplicate || !isGithubValid ? "high" : isPackage ? "medium" : "low",
    writeGateStatus: safeToContinue ? "dry-run-ready" : isPackage ? "locked" : "blocked",
    safeToContinue,
    duplicateSourceId: duplicate?.id ?? "",
    duplicateReason: duplicate
      ? `已存在同一来源：${duplicate.name}。真实导入前必须合并或改名。`
      : !isGithubValid
        ? "GitHub 地址格式不符合普通仓库地址。"
        : isPackage
          ? "zip/.skill 仍需要解压安全扫描，当前只允许生成计划。"
          : "",
    skillCount: 0,
    promptCount: 0,
    plannedSteps:
      importKind === "github"
        ? [
            "校验 GitHub 普通仓库地址。",
            "检查本地 SQLite 是否已有同源仓库。",
            "生成快照后 clone/pull 到 github_sources。",
            "扫描 SKILL.md，只把有效 Skill 进入候选库。"
          ]
        : importKind === "local"
          ? [
              "检查本地路径是否可访问。",
              "递归扫描 SKILL.md，并跳过 target/node_modules/.git 等目录。",
              "检查重复来源和重复 Skill 名称。",
              "生成快照和回滚计划后登记为来源。"
            ]
          : [
              "验证 zip/.skill 文件扩展名。",
              "先做 zip-slip 与路径穿越扫描。",
              "解压到临时目录后统计 SKILL.md。",
              "解压安全报告通过后才允许登记为来源。"
            ],
    installPlanSteps:
      importKind === "github"
        ? [
            "创建来源导入快照。",
            "如果目标目录已存在，先备份到 source-imports。",
            "clone 或 pull 到 github_sources 的隔离目录。",
            "重新扫描 SKILL.md 并更新本地 SQLite 来源记录。",
            "如果已开启真实写入授权，点击“同步 / 刷新”会同步到 AI 工具。"
          ]
        : importKind === "local"
          ? [
              "创建来源导入快照。",
              "把本地来源登记为可管理候选，不直接修改原目录。",
              "按有效 SKILL.md 目录生成候选索引。",
              "更新本地 SQLite 来源记录。",
              "如果已开启真实写入授权，点击“同步 / 刷新”会同步到 AI 工具。"
            ]
          : [
              "创建临时解压目录。",
              "先执行路径穿越和重复名称扫描。",
              "安全通过后生成导入快照和备份计划。",
              "解压进入隔离来源目录并重新扫描。",
              "如果已开启真实写入授权，点击“同步 / 刷新”会同步到 AI 工具。"
            ],
    blockingChecks,
    rollbackSummary: "当前只生成 dry-run；没有写入任何文件，因此不需要执行回滚。"
  };
}

function normalizePreviewGithubUrl(input: string): string {
  const value = input.trim().replace(/^git@github\.com:/i, "https://github.com/").replace(/^ssh:\/\/git@github\.com\//i, "https://github.com/");
  const match = value.match(/^https?:\/\/github\.com\/([^/\s]+)\/([^/\s?#]+?)(?:\.git)?(?:[?#].*)?$/i);
  if (!match) return "";
  return `https://github.com/${match[1]}/${match[2].replace(/\.git$/i, "")}.git`.toLowerCase();
}

function createPreviewSourceImportExecution(importKind: string, input: string): SourceImportExecutionCard {
  const value = input.trim();
  const displayName =
    value
      .split(/[\\/]/)
      .filter(Boolean)
      .pop()
      ?.replace(/\.git$/i, "")
      .replace(/\.(zip|skill)$/i, "") || "preview-source";
  const isLockedPackage = importKind === "zip";
  return {
    id: `preview-stage-${Date.now()}`,
    importKind,
    input: value,
    status: isLockedPackage ? "locked" : "staged",
    riskLevel: isLockedPackage ? "medium" : "low",
    summary: isLockedPackage
      ? "浏览器预览：zip/.skill staging 仍锁定。"
      : "浏览器预览：已模拟写入隔离 staging，桌面版才会真实创建 staging 文件夹。",
    stagedPath: `浏览器预览/app-next/.skillhub-next/staging/source-imports/${displayName}`,
    reportPath: `浏览器预览/app-next/.skillhub-next/reports/source-import-staging/${displayName}.md`,
    manifestPath: `浏览器预览/app-next/.skillhub-next/reports/source-import-staging/${displayName}-manifest.json`,
    copiedFiles: isLockedPackage ? 0 : 12,
    copiedBytes: isLockedPackage ? 0 : 48 * 1024,
    skillCount: isLockedPackage ? 0 : 1,
    promptCount: 0,
    blockingChecks: [
      "浏览器预览不执行本机文件写入。",
      "正式 app/github_sources 安装仍锁定。",
      "AI 工具同步/接管仍锁定。"
    ],
    rollbackSteps: ["删除 staging 目录即可撤销。", "正式来源目录和 AI 工具目录保持不变。"],
    realWriteScope: "preview-only"
  };
}

function createPreviewSourceImportPromotion(
  importKind: string,
  stagedPath: string,
  sourceName: string
): SourceImportPromotionCard {
  const safeName = (sourceName || "preview-source")
    .trim()
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^-+|-+$/g, "") || "preview-source";
  return {
    id: `preview-promotion-${Date.now()}`,
    importKind,
    sourceName: safeName,
    status: "promoted",
    riskLevel: importKind === "github" ? "medium" : "low",
    summary: "浏览器预览：已模拟提升为受管理来源；桌面版才会写入 app/github_sources。",
    stagedPath,
    targetPath: `浏览器预览/app/github_sources/${safeName}`,
    reportPath: `浏览器预览/app-next/.skillhub-next/reports/source-import-promotion/${safeName}.md`,
    manifestPath: `浏览器预览/app-next/.skillhub-next/reports/source-import-promotion/${safeName}-manifest.json`,
    copiedFiles: 12,
    copiedBytes: 48 * 1024,
    skillCount: 1,
    promptCount: 0,
    blockingChecks: [
      "浏览器预览不执行本机文件写入。",
      "AI 工具同步/接管仍锁定。"
    ],
    rollbackSteps: ["删除受管理来源目录即可回滚。", "重新扫描本地 SQLite 索引。"],
    realWriteScope: "preview-only"
  };
}

function createPreviewSnapshot(): LegacySnapshot {
  return {
    root: "浏览器预览模式",
    skillsDir: "../skills",
    sourcesDir: "../app/github_sources",
    diagnosticsFile: "../app/reports/latest-diagnostics.json",
    mode: "browser-preview",
    summary: {
      skills: 48,
      sources: 9,
      prompts: 2,
      agentsDetected: 3,
      warnings: 1,
      diagnosticsStatus: "preview"
    },
    skills: [
      {
        name: "paper-workflow",
        folderName: "paper-workflow",
        category: "论文科研",
        description: "判断当前论文下一步该进入构思、写作、图表、引用核查还是投稿审计。",
        note: "",
        source: "Nature-Paper-Skills",
        health: "ok",
        enabled: true,
        relativePath: "skills/core/paper-workflow",
        tags: ["论文科研", "写作", "常用"]
      },
      {
        name: "figure-planner",
        folderName: "figure-planner",
        category: "科研图表",
        description: "把实验结果拆成清晰的图组、面板顺序和图注结构。",
        note: "",
        source: "Nature-Paper-Skills",
        health: "ok",
        enabled: true,
        relativePath: "skills/core/figure-planner",
        tags: ["科研图表", "论文科研"]
      },
      {
        name: "impeccable",
        folderName: "impeccable",
        category: "界面设计",
        description: "用于检查界面审美、布局层级、交互细节和视觉一致性。",
        note: "",
        source: "impeccable",
        health: "info",
        enabled: true,
        relativePath: ".claude/skills/impeccable",
        tags: ["界面设计", "UI", "审美"]
      },
      {
        name: "VibeSec-Skill",
        folderName: "VibeSec-Skill",
        category: "安全",
        description: "扫描脚本、路径、命令和发布边界中的安全风险。",
        note: "",
        source: "VibeSec-Skill",
        health: "warn",
        enabled: true,
        relativePath: "SKILL.md",
        tags: ["安全", "发布闸门"]
      },
      {
        name: "gstack",
        folderName: "gstack",
        category: "产品规划",
        description: "把长期目标拆成可验证、可回退、可持续推进的产品路线。",
        note: "",
        source: "gstack",
        health: "ok",
        enabled: true,
        relativePath: "SKILL.md",
        tags: ["产品规划", "路线图"]
      },
      {
        name: "karpathy-guidelines",
        folderName: "karpathy-guidelines",
        category: "工程质量",
        description: "保持小步验证、清晰状态和稳定推进的工程开发守则。",
        note: "",
        source: "andrej-karpathy-skills",
        health: "ok",
        enabled: true,
        relativePath: "skills/karpathy-guidelines",
        tags: ["工程质量", "稳定推进"]
      }
    ],
      sources: [
        {
          id: "source-nature-paper-skills",
          name: "Nature-Paper-Skills",
          sourceType: "skill",
          health: "ok",
        url: "https://github.com/Boom5426/Nature-Paper-Skills.git",
        skillCount: 18,
        mode: "scan",
          createdAt: "2026-05-01T00:00:00Z",
          categoryId: "paper",
          note: "论文科研工作流。",
          localPath: "../app/github_sources/Nature-Paper-Skills",
          enabled: true,
          tags: ["GitHub", "论文科研", "常用"]
        },
        {
          id: "source-impeccable",
          name: "impeccable",
          sourceType: "skill",
        health: "info",
        url: "https://github.com/pbakaus/impeccable.git",
        skillCount: 1,
        mode: "explicit",
          createdAt: "2026-05-01T00:00:00Z",
          categoryId: "design",
          note: "UI 审美检查来源。",
          localPath: "../app/github_sources/impeccable",
          enabled: true,
          tags: ["GitHub", "界面设计"]
        },
        {
          id: "source-awesome-ai-research-writing",
          name: "awesome-ai-research-writing",
          sourceType: "prompt",
        health: "info",
        url: "https://github.com/Leey21/awesome-ai-research-writing.git",
        skillCount: 0,
        mode: "do-not-install",
          createdAt: "2026-05-01T00:00:00Z",
          categoryId: "prompt",
          note: "这是润色 Prompt 资料，不作为 Skill 安装。",
          localPath: "../app/github_sources/awesome-ai-research-writing",
          enabled: true,
          tags: ["Prompt", "润色资料"]
        }
      ],
    agents: [
      {
        id: "claude",
        name: "Claude / Claude Code",
        path: "~\\.claude\\skills",
        detected: true,
        managed: true,
        enabled: true,
        skillCount: 48
      },
      {
        id: "codex",
        name: "OpenAI Codex",
        path: "~\\.codex\\skills",
        detected: true,
        managed: false,
        enabled: false,
        skillCount: 0
      },
      {
        id: "antigravity",
        name: "Antigravity",
        path: "~\\.gemini\\antigravity\\skills",
        detected: false,
        managed: false,
        enabled: false,
        skillCount: 0
      }
    ],
    agentAdapters: [
      {
        id: "claude",
        name: "Claude / Claude Code",
        vendor: "Anthropic",
        skillsPathHint: "~\\.claude\\skills",
        detectionKind: "directory",
        installScope: "global",
        capabilityLevel: "full",
        docsUrl: "",
        status: "ready",
        detected: true,
        managed: true,
        enabled: true
      },
      {
        id: "codex",
        name: "OpenAI Codex",
        vendor: "OpenAI",
        skillsPathHint: "~\\.codex\\skills",
        detectionKind: "directory",
        installScope: "global",
        capabilityLevel: "full",
        docsUrl: "",
        status: "detected-unmanaged",
        detected: true,
        managed: false,
        enabled: false
      },
      {
        id: "antigravity",
        name: "Antigravity",
        vendor: "Google",
        skillsPathHint: "~\\.gemini\\antigravity\\skills",
        detectionKind: "directory",
        installScope: "global",
        capabilityLevel: "planned",
        docsUrl: "",
        status: "not-detected",
        detected: false,
        managed: false,
        enabled: false
      }
    ],
    adapterSafetyChecks: [
      {
        id: "claude-path",
        adapterId: "claude",
        checkKey: "path-writable",
        status: "ok",
        summary: "Claude Skills 目录可写，已由 AI SkillHub 管理。"
      },
      {
        id: "codex-link",
        adapterId: "codex",
        checkKey: "managed-link",
        status: "warn",
        summary: "已检测到 Codex，但尚未接管链接。"
      },
      {
        id: "antigravity-missing",
        adapterId: "antigravity",
        checkKey: "installed",
        status: "info",
        summary: "未检测到 Antigravity，本机可暂不处理。"
      }
    ],
    adapterCapabilities: [
      {
        id: "claude-global",
        adapterId: "claude",
        capabilityKey: "global-scope",
        enabled: true,
        summary: "支持全局 Skills。"
      },
      {
        id: "claude-project",
        adapterId: "claude",
        capabilityKey: "project-scope",
        enabled: true,
        summary: "支持项目级工作区。"
      },
      {
        id: "codex-global",
        adapterId: "codex",
        capabilityKey: "global-scope",
        enabled: true,
        summary: "支持 Codex 全局 Skills。"
      },
      {
        id: "antigravity-copy",
        adapterId: "antigravity",
        capabilityKey: "copy-fallback",
        enabled: false,
        summary: "后续提供复制兜底。"
      }
    ],
    workspaces: [
      {
        id: "global",
        name: "全局技能库",
        scope: "global",
        path: "../skills",
        enabled: true,
        agentCount: 3,
        skillCount: 48
      },
      {
        id: "claude-agent",
        name: "Claude 工作区",
        scope: "agent",
        path: "~\\.claude\\skills",
        enabled: true,
        agentCount: 1,
        skillCount: 48
      },
      {
        id: "app-next",
        name: "AI SkillHub 项目",
        scope: "project",
        path: "../app-next",
        enabled: true,
        agentCount: 2,
        skillCount: 12
      }
    ],
    projectScans: [
      {
        id: "app-next-scan",
        workspaceId: "app-next",
        path: "../app-next",
        hasGit: true,
        hasPackageJson: true,
        hasCargoToml: true,
        hasTauriConfig: true,
        hasAgentsMd: false,
        hasClaudeMd: false,
        hasReadmeMd: true,
        fileCount: 126,
        scannedAt: new Date().toISOString()
      }
    ],
    presets: [
      {
        id: "paper",
        name: "论文科研",
        description: "写作、图表、引用、投稿审计的组合预设。",
        color: "mint",
        enabled: true,
        skillCount: 18,
        workspaceCount: 2
      },
      {
        id: "design",
        name: "界面设计",
        description: "UI 检查、视觉优化和产品体验打磨。",
        color: "peach",
        enabled: true,
        skillCount: 7,
        workspaceCount: 1
      },
      {
        id: "security",
        name: "安全检查",
        description: "命令、路径、发布边界和风险模式扫描。",
        color: "violet",
        enabled: true,
        skillCount: 4,
        workspaceCount: 1
      }
    ],
    snapshots: [
      {
        id: "preview-snapshot",
        name: "浏览器预览快照",
        summary: "48 skills, 9 sources, 3 agents",
        createdAt: new Date().toISOString(),
        isLatest: true
      }
    ],
    backupTargets: [
      {
        id: "preview-backup-claude",
        adapterId: "claude",
        agentName: "Claude / Claude Code",
        targetPath: "~\\.claude\\skills",
        backupPath: "../app-next/.skillhub-next/backups/claude/skills",
        detected: true,
        managed: true,
        required: true,
        preflightStatus: "required",
        riskLevel: "medium",
        blocker: "已接管目标目录；真实同步前必须先生成可恢复备份。"
      },
      {
        id: "preview-backup-codex",
        adapterId: "codex",
        agentName: "OpenAI Codex",
        targetPath: "~\\.codex\\skills",
        backupPath: "../app-next/.skillhub-next/backups/codex/skills",
        detected: true,
        managed: false,
        required: true,
        preflightStatus: "blocked",
        riskLevel: "medium",
        blocker: "检测到但尚未接管；真实同步前必须先完成备份和接管确认。"
      },
      {
        id: "preview-backup-antigravity",
        adapterId: "antigravity",
        agentName: "Antigravity",
        targetPath: "~\\.gemini\\antigravity\\skills",
        backupPath: "../app-next/.skillhub-next/backups/antigravity/skills",
        detected: false,
        managed: false,
        required: false,
        preflightStatus: "skipped",
        riskLevel: "low",
        blocker: "未检测到该工具；不会创建假目录，也不会执行接管写入。"
      }
    ],
    backupDryRun: [
      {
        id: "preview-backup-plan-claude",
        backupTargetId: "preview-backup-claude",
        adapterId: "claude",
        agentName: "Claude / Claude Code",
        action: "copy-to-backup",
        targetPath: "~\\.claude\\skills",
        backupPath: "../app-next/.skillhub-next/backups/claude/skills",
        status: "planned",
        riskLevel: "medium",
        summary: "真实同步前会先检查目标路径边界，再把目标目录复制到备份位置；当前仍只预演。"
      },
      {
        id: "preview-backup-plan-codex",
        backupTargetId: "preview-backup-codex",
        adapterId: "codex",
        agentName: "OpenAI Codex",
        action: "block-backup",
        targetPath: "~\\.codex\\skills",
        backupPath: "../app-next/.skillhub-next/backups/codex/skills",
        status: "blocked",
        riskLevel: "high",
        summary: "当前目标仍被阻断，备份预演只报告原因，不复制任何文件。"
      },
      {
        id: "preview-backup-plan-antigravity",
        backupTargetId: "preview-backup-antigravity",
        adapterId: "antigravity",
        agentName: "Antigravity",
        action: "skip",
        targetPath: "~\\.gemini\\antigravity\\skills",
        backupPath: "../app-next/.skillhub-next/backups/antigravity/skills",
        status: "skipped",
        riskLevel: "low",
        summary: "未检测到该工具，备份预演会跳过此目标，不创建备份目录。"
      }
    ],
    restoreDryRun: [
      {
        id: "preview-restore-claude",
        backupTargetId: "preview-backup-claude",
        adapterId: "claude",
        agentName: "Claude / Claude Code",
        action: "prepare-restore",
        targetPath: "~\\.claude\\skills",
        backupPath: "../app-next/.skillhub-next/backups/claude/skills",
        status: "planned",
        riskLevel: "medium",
        summary: "真实同步前会先生成备份；恢复预演会列出从备份位置还原到目标目录的计划。"
      },
      {
        id: "preview-restore-codex",
        backupTargetId: "preview-backup-codex",
        adapterId: "codex",
        agentName: "OpenAI Codex",
        action: "block-restore",
        targetPath: "~\\.codex\\skills",
        backupPath: "../app-next/.skillhub-next/backups/codex/skills",
        status: "blocked",
        riskLevel: "high",
        summary: "当前目标仍被阻断，恢复预演只能报告原因，不能进入真实恢复。"
      },
      {
        id: "preview-restore-antigravity",
        backupTargetId: "preview-backup-antigravity",
        adapterId: "antigravity",
        agentName: "Antigravity",
        action: "skip",
        targetPath: "~\\.gemini\\antigravity\\skills",
        backupPath: "../app-next/.skillhub-next/backups/antigravity/skills",
        status: "skipped",
        riskLevel: "low",
        summary: "未检测到该工具，恢复预演会跳过此目标，不创建目录、不写入文件。"
      }
    ],
    rollbackPlan: [
      {
        id: "preview-step-1",
        snapshotId: "preview-snapshot",
        stepOrder: 1,
        title: "冻结本地 SQLite 基线",
        riskLevel: "low",
        status: "ready",
        summary: "预览模式已生成示例基线；真实数据请在 Tauri 桌面窗口查看。"
      },
      {
        id: "preview-step-2",
        snapshotId: "preview-snapshot",
        stepOrder: 2,
        title: "备份目标 AI 工具目录",
        riskLevel: "medium",
        status: "planned",
        summary: "真实同步前必须备份 Claude、Codex、Antigravity 等目标目录。"
      },
      {
        id: "preview-step-3",
        snapshotId: "preview-snapshot",
        stepOrder: 3,
        title: "真实回滚执行",
        riskLevel: "high",
        status: "locked",
        summary: "恢复按钮保持锁定，直到备份和 dry-run 通过。"
      }
    ],
    releaseReports: [
      {
        id: "diagnostics",
        title: "诊断包结果",
        reportType: "diagnostics",
        status: "ok",
        generatedAt: new Date().toISOString(),
        version: "v1.1.1",
        ok: true,
        total: 9,
        passed: 6,
        warn: 1,
        error: 0,
        summary: "诊断报告：6 ok / 1 warn / 0 error / 2 info。"
      },
      {
        id: "release-preflight",
        title: "发布预检",
        reportType: "release-preflight",
        status: "ok",
        generatedAt: new Date().toISOString(),
        version: "v1.1.1",
        ok: true,
        total: 12,
        passed: 12,
        warn: 0,
        error: 0,
        summary: "发布预检：12/12 项通过；当前包名 AI SkillHub.exe。"
      },
      {
        id: "share-recipient",
        title: "分享验收",
        reportType: "share-recipient-test",
        status: "ok",
        generatedAt: new Date().toISOString(),
        version: "v1.1.1",
        ok: true,
        total: 8,
        passed: 8,
        warn: 2,
        error: 1,
        summary: "分享验收：8/8 个场景按预期通过；含无 Codex、缺 Git/WebView2 等模拟场景。"
      },
      {
        id: "zip-preview",
        title: "zip 导入预览",
        reportType: "zip-preview-test",
        status: "ok",
        generatedAt: new Date().toISOString(),
        version: "",
        ok: true,
        total: 4,
        passed: 4,
        warn: 0,
        error: 0,
        summary: "zip 预览：2 个 Skill 可识别；路径穿越防护已通过。"
      }
    ],
    importPreviews: [
      {
        id: "import-github",
        title: "GitHub 仓库导入",
        importKind: "github",
        status: "ready",
        summary: "已索引 3 个 GitHub 来源。",
        detail: "下一步只做 clone/pull 预览，不直接安装。",
        skillCount: 19,
        promptCount: 1,
        safeToContinue: true
      },
      {
        id: "import-local",
        title: "本地文件夹导入",
        importKind: "local",
        status: "empty",
        summary: "还没有单独登记的本地来源。",
        detail: "只有包含 SKILL.md 的目录会被视为 Skill；Prompt 资料会继续标记为资料源。",
        skillCount: 0,
        promptCount: 0,
        safeToContinue: true
      },
      {
        id: "import-zip",
        title: "zip / .skill 包导入",
        importKind: "zip",
        status: "ok",
        summary: "zip 预览：2 个 Skill 可识别；路径穿越防护已通过。",
        detail: "zip slip 防护和 SKILL.md 预览已通过；当前仍保持只读，不会真实解压。",
        skillCount: 2,
        promptCount: 0,
        safeToContinue: true
      }
    ],
    sourcePopularity: [
      {
        sourceId: "source-nature-paper-skills",
        sourceName: "Nature-Paper-Skills",
        url: "https://github.com/Boom5426/Nature-Paper-Skills.git",
        owner: "Boom5426",
        repo: "Nature-Paper-Skills",
        createdAt: "2025-01-10T00:00:00Z",
        stars: 1280,
        forks: 146,
        openIssues: 3,
        lastUpdatedAt: new Date().toISOString(),
        fetchedAt: new Date().toISOString(),
        cacheStatus: "fresh",
        error: "",
        localTotalCount: 8,
        localSevenDayCount: 3,
        localThirtyDayCount: 8,
        trendPoints: [
          { sampledAt: "1717200000000000000", stars: 860, forks: 91, openIssues: 4, lastUpdatedAt: "2025-11-01T00:00:00Z", cacheStatus: "fresh" },
          { sampledAt: "1748736000000000000", stars: 1120, forks: 128, openIssues: 2, lastUpdatedAt: "2026-03-01T00:00:00Z", cacheStatus: "fresh" },
          { sampledAt: "1780272000000000000", stars: 1280, forks: 146, openIssues: 3, lastUpdatedAt: new Date().toISOString(), cacheStatus: "fresh" }
        ]
      },
      {
        sourceId: "source-impeccable",
        sourceName: "impeccable",
        url: "https://github.com/pbakaus/impeccable.git",
        owner: "pbakaus",
        repo: "impeccable",
        createdAt: "2024-09-12T00:00:00Z",
        stars: 920,
        forks: 88,
        openIssues: 1,
        lastUpdatedAt: new Date().toISOString(),
        fetchedAt: new Date().toISOString(),
        cacheStatus: "fresh",
        error: "",
        localTotalCount: 4,
        localSevenDayCount: 1,
        localThirtyDayCount: 4,
        trendPoints: [
          { sampledAt: "1717200000000000000", stars: 530, forks: 42, openIssues: 2, lastUpdatedAt: "2025-10-01T00:00:00Z", cacheStatus: "fresh" },
          { sampledAt: "1748736000000000000", stars: 790, forks: 66, openIssues: 1, lastUpdatedAt: "2026-02-01T00:00:00Z", cacheStatus: "fresh" },
          { sampledAt: "1780272000000000000", stars: 920, forks: 88, openIssues: 1, lastUpdatedAt: new Date().toISOString(), cacheStatus: "fresh" }
        ]
      }
    ],
    skillConflicts: [
      {
        conflictKey: "figure-planner",
        childName: "figure-planner",
        status: "unresolved",
        defaultSkillId: "",
        defaultSourceName: "",
        updatedAt: "",
        choices: [
          {
            skillId: "Nature-Paper-Skills/skills/core/figure-planner",
            skillName: "figure-planner",
            folderName: "figure-planner",
            sourceName: "Nature-Paper-Skills",
            relativePath: "skills/core/figure-planner",
            category: "科研图表",
            description: "Nature 论文图表规划。"
          },
          {
            skillId: "PaperSpine/dist/codex/skills/figure-planner",
            skillName: "figure-planner",
            folderName: "figure-planner",
            sourceName: "PaperSpine",
            relativePath: "dist/codex/skills/figure-planner",
            category: "论文科研",
            description: "PaperSpine 论文工作流图表规划。"
          }
        ]
      }
    ],
    operatorConsent: {
      realWritesEnabled: false,
      enabledAt: "",
      updatedAt: "",
      summary: "真实写入授权未开启；同步按钮只刷新索引，不会写入 AI 工具目录。"
    },
    tags: [
      { id: "tag-paper", name: "论文科研", color: "mint", targetCount: 3 },
      { id: "tag-design", name: "界面设计", color: "peach", targetCount: 2 },
      { id: "tag-security", name: "安全", color: "violet", targetCount: 2 },
      { id: "tag-prompt", name: "Prompt", color: "amber", targetCount: 1 }
    ],
    presetDistributions: [
      {
        id: "dist-paper-global",
        presetId: "paper",
        presetName: "论文科研",
        workspaceId: "global",
        workspaceName: "全局技能库",
        workspaceScope: "global",
        enabled: true,
        skillCount: 18,
        status: "enabled",
        summary: "全局默认启用论文科研组合。"
      },
      {
        id: "dist-paper-claude",
        presetId: "paper",
        presetName: "论文科研",
        workspaceId: "claude-agent",
        workspaceName: "Claude 工作区",
        workspaceScope: "agent",
        enabled: true,
        skillCount: 18,
        status: "enabled",
        summary: "Claude 可优先使用论文写作和投稿审计技能。"
      },
      {
        id: "dist-design-app-next",
        presetId: "design",
        presetName: "界面设计",
        workspaceId: "app-next",
        workspaceName: "AI SkillHub 项目",
        workspaceScope: "project",
        enabled: true,
        skillCount: 7,
        status: "enabled",
        summary: "v2 项目工作区启用 UI 审查和交互打磨组合。"
      },
      {
        id: "dist-security-global",
        presetId: "security",
        presetName: "安全检查",
        workspaceId: "global",
        workspaceName: "全局技能库",
        workspaceScope: "global",
        enabled: false,
        skillCount: 4,
        status: "disabled",
        summary: "安全组合默认保留为可选，发布前再启用。"
      }
    ],
    operationRunners: [
      {
        id: "diagnostics-export",
        title: "导出诊断包",
        runnerType: "diagnostics",
        status: "ready",
        locked: false,
        lastRunAt: "",
        exportDir: "../app-next/.skillhub-next/reports/diagnostics",
        reportPath: "../app-next/.skillhub-next/reports/diagnostics/latest-diagnostics-export.md",
        latestJsonPath: "../app-next/.skillhub-next/reports/diagnostics/latest-diagnostics-export.json",
        latestMarkdownPath: "../app-next/.skillhub-next/reports/diagnostics/latest-diagnostics-export.md",
        manifestPath: "../app-next/.skillhub-next/reports/diagnostics/latest-diagnostics-export-manifest.json",
        fileCount: 0,
        summary: "生成脱敏诊断摘要、SQLite 状态和发布闸门输入。",
        nextAction: "运行 dry-run，记录报告摘要。"
      },
      {
        id: "share-validation",
        title: "分享验收执行器",
        runnerType: "share-validation",
        status: "ready",
        locked: false,
        lastRunAt: "",
        exportDir: "../app-next/.skillhub-next/reports/share-validation",
        reportPath: "../app-next/.skillhub-next/reports/share-validation/latest-share-validation.md",
        latestJsonPath: "../app-next/.skillhub-next/reports/share-validation/latest-share-validation.json",
        latestMarkdownPath: "../app-next/.skillhub-next/reports/share-validation/latest-share-validation.md",
        manifestPath: "../app-next/.skillhub-next/reports/share-validation/latest-share-validation-manifest.json",
        fileCount: 0,
        summary: "检查无 AI 工具、仅 Claude、缺 Git、路径含空格等分享场景。",
        nextAction: "运行 dry-run，生成分享可用性结论。"
      },
      {
        id: "report-bundle",
        title: "报告包索引",
        runnerType: "report-bundle",
        status: "ready",
        locked: false,
        lastRunAt: "",
        exportDir: "../app-next/.skillhub-next/reports/report-bundle",
        reportPath: "../app-next/.skillhub-next/reports/report-bundle/latest-report-bundle.md",
        latestJsonPath: "../app-next/.skillhub-next/reports/report-bundle/latest-report-bundle.json",
        latestMarkdownPath: "../app-next/.skillhub-next/reports/report-bundle/latest-report-bundle.md",
        manifestPath: "../app-next/.skillhub-next/reports/report-bundle/latest-report-bundle-manifest.json",
        fileCount: 0,
        summary: "汇总诊断、分享和发布计划报告，只生成报告索引，不制作正式发布包。",
        nextAction: "先运行前置执行器，再生成最终报告包索引。"
      },
      {
        id: "write-execution-plan",
        title: "真实写入执行计划",
        runnerType: "write-plan",
        status: "ready",
        locked: false,
        lastRunAt: "",
        exportDir: "../app-next/.skillhub-next/reports/write-execution-plan",
        reportPath: "../app-next/.skillhub-next/reports/write-execution-plan/latest-write-execution-plan.md",
        latestJsonPath: "../app-next/.skillhub-next/reports/write-execution-plan/latest-write-execution-plan.json",
        latestMarkdownPath: "../app-next/.skillhub-next/reports/write-execution-plan/latest-write-execution-plan.md",
        manifestPath:
          "../app-next/.skillhub-next/reports/write-execution-plan/latest-write-execution-plan-manifest.json",
        fileCount: 0,
        summary: "把真实导入、同步和打包闸门合成可审计执行计划，包含阻断项和回滚预案。",
        nextAction: "生成真实写入执行计划报告。"
      },
      {
        id: "v2-completion-audit",
        title: "完成度审计",
        runnerType: "completion-audit",
        status: "ready",
        locked: false,
        lastRunAt: "",
        exportDir: "../app-next/.skillhub-next/reports/v2-completion-audit",
        reportPath: "../app-next/.skillhub-next/reports/v2-completion-audit/latest-v2-completion-audit.md",
        latestJsonPath: "../app-next/.skillhub-next/reports/v2-completion-audit/latest-v2-completion-audit.json",
        latestMarkdownPath:
          "../app-next/.skillhub-next/reports/v2-completion-audit/latest-v2-completion-audit.md",
        manifestPath:
          "../app-next/.skillhub-next/reports/v2-completion-audit/latest-v2-completion-audit-manifest.json",
        fileCount: 0,
        summary: "检查当前版本是否可以称为完整版本，并列出剩余发布阻断项。",
        nextAction: "生成完成度审计报告。"
      },
      {
        id: "release-package",
        title: "发布打包执行器",
        runnerType: "release-package",
        status: "locked",
        locked: true,
        lastRunAt: "",
        exportDir: "../app-next/.skillhub-next/reports/release-package",
        reportPath: "../app-next/.skillhub-next/reports/release-package/latest-release-package.md",
        latestJsonPath: "../app-next/.skillhub-next/reports/release-package/latest-release-package.json",
        latestMarkdownPath: "../app-next/.skillhub-next/reports/release-package/latest-release-package.md",
        manifestPath: "../app-next/.skillhub-next/reports/release-package/latest-release-package-manifest.json",
        fileCount: 0,
        summary: "正式打包仍锁定，直到诊断、桌面 QA、备份和分享验收全部通过。",
        nextAction: "先完成全部发布闸门，再开放真实打包。"
      }
    ],
    writeGates: [
      {
        id: "github-import",
        title: "GitHub 来源真实导入",
        operationType: "clone-pull",
        status: "blocked",
        unlocked: false,
        riskLevel: "medium",
        summary: "还有 2 个条件未满足；真实写入保持关闭。",
        nextAction: "先生成具体来源的 dry-run 计划，再开放逐项 clone/pull。",
        planSteps: [
          "标准化 GitHub URL 并锁定目标来源目录。",
          "执行 clone/pull dry-run，记录将新增、更新或跳过的来源。",
          "扫描 SKILL.md 并区分 Prompt 资料。",
          "刷新 SQLite 索引，不修改 AI 工具目录。"
        ],
        rollbackSteps: ["保留 clone/pull 前来源清单快照。", "失败时删除本次新增的临时来源目录。"],
        passingChecks: ["诊断报告没有 error", "已生成 GitHub 来源导入预览"],
        blockingChecks: [
          "报告包索引尚未生成",
          "真实 clone/pull 执行器尚未开放；当前只允许 dry-run 计划。"
        ]
      },
      {
        id: "local-zip-import",
        title: "本地 / zip 真实导入",
        operationType: "local-zip-copy",
        status: "blocked",
        unlocked: false,
        riskLevel: "high",
        summary: "还有 2 个条件未满足；真实写入保持关闭。",
        nextAction: "先补齐 zip 预览报告和重复名称检查，再生成可回滚安装计划。",
        planSteps: [
          "复制/解压到临时隔离目录。",
          "扫描 SKILL.md、重复名称、路径穿越和超大文件。",
          "生成目标目录和备份目录清单。",
          "安全报告通过后才允许移动到正式来源目录。"
        ],
        rollbackSteps: ["保留导入前来源目录索引。", "失败时删除临时目录，不碰正式目录。"],
        passingChecks: ["诊断报告没有 error"],
        blockingChecks: [
          "本地文件夹或 zip/.skill 导入预览尚未通过",
          "真实复制 / 解压执行器尚未开放；当前只允许预览。"
        ]
      },
      {
        id: "agent-sync",
        title: "AI 工具真实接管同步",
        operationType: "agent-link-sync",
        status: "blocked",
        unlocked: false,
        riskLevel: "high",
        summary: "还有 4 个条件未满足；真实写入保持关闭。",
        nextAction: "先让备份、恢复、回滚和桌面 QA 全部变成可审计通过状态。",
        planSteps: [
          "冻结本地 SQLite 快照和启用 Skill 清单。",
          "备份每个已接管 AI 工具的目标 skills 目录。",
          "生成将创建/替换/删除的链接或复制项清单。",
          "逐工具执行，同步后立即验证。"
        ],
        rollbackSteps: ["从备份目录恢复每个 AI 工具原始 skills 目录。", "撤销本次托管链接，保留用户非托管文件。"],
        passingChecks: ["诊断报告没有 error", "至少有一个已检测、已启用且由 AI SkillHub 管理的 AI 工具适配器"],
        blockingChecks: [
          "备份 dry-run 仍有 planned / blocked 项",
          "回滚计划仍含 locked / planned 步骤",
          "必需桌面 QA 未全部通过",
          "真实链接替换执行器尚未开放；当前不会写入 Claude/Codex/Antigravity 目录。"
        ]
      },
      {
        id: "release-package",
        title: "正式发布包生成",
        operationType: "release-package",
        status: "blocked",
        unlocked: false,
        riskLevel: "medium",
        summary: "还有 5 个条件未满足；真实写入保持关闭。",
        nextAction: "完成全部报告与桌面 QA 后，再把 release-package 从计划模式切到真实打包。",
        planSteps: [
          "运行诊断、分享验收、发布预检、zip 预览和报告包索引。",
          "确认公开仓库排除 personal skills / reports / local paths。",
          "生成发布目录、校验清单、版本说明和 SHA256。",
          "只在用户确认后推送 tag / release。"
        ],
        rollbackSteps: ["发布前保留本地 release manifest。", "失败时删除候选包并保留上一个稳定包。"],
        passingChecks: ["诊断报告没有 error"],
        blockingChecks: [
          "发布预检报告未通过",
          "分享验收报告未通过",
          "zip 预览报告未通过",
          "必需桌面 QA 未全部通过",
          "正式打包执行器尚未开放；当前 release-package 只写计划报告。"
        ]
      }
    ],
    desktopQaChecks: [
      {
        id: "window-readable",
        title: "默认窗口完整可读",
        description: "侧边栏、主标题、指标卡和滚动条不能被裁切；默认窗口尺寸下必须能直接操作。",
        status: "passed",
        required: true,
        evidence: "",
        updatedAt: new Date().toISOString()
      },
      {
        id: "dpi-clarity",
        title: "高 DPI 清晰度",
        description: "真实 Tauri 桌面窗口里的中文、英文、数字和胶囊状态不能发虚，不能用浏览器预览代替。",
        status: "pending",
        required: true,
        evidence: "",
        updatedAt: new Date().toISOString()
      },
      {
        id: "release-gate-readable",
        title: "发布闸门可读",
        description: "诊断、发布预检、分享验收、zip 预览和桌面 QA 状态必须能被清楚读到。",
        status: "pending",
        required: true,
        evidence: "",
        updatedAt: new Date().toISOString()
      },
      {
        id: "snapshot-safety",
        title: "快照与恢复仍锁定",
        description: "备份、恢复和真实同步必须保持预演/锁定状态，不能出现误触发真实写入的入口。",
        status: "pending",
        required: true,
        evidence: "",
        updatedAt: new Date().toISOString()
      },
      {
        id: "release-build-guidance",
        title: "发布说明清楚",
        description: "用户必须能区分开发命令、调试 exe 和未来正式打包产物。",
        status: "pending",
        required: true,
        evidence: "",
        updatedAt: new Date().toISOString()
      }
    ],
    usageStats: [
      {
        targetType: "skill",
        targetId: "paper-workflow",
        targetName: "paper-workflow",
        sourceName: "Nature-Paper-Skills",
        totalCount: 8,
        sevenDayCount: 3,
        thirtyDayCount: 8,
        lastUsedAt: new Date().toISOString()
      },
      {
        targetType: "source",
        targetId: "source-impeccable",
        targetName: "impeccable",
        sourceName: "impeccable",
        totalCount: 4,
        sevenDayCount: 1,
        thirtyDayCount: 4,
        lastUsedAt: new Date().toISOString()
      }
    ],
    auditEvents: [
      {
        id: "preview-audit-usage",
        eventType: "usage_recorded",
        summary: "Recorded skill usage",
        detailJson: "{}",
        createdAt: new Date().toISOString()
      },
      {
        id: "preview-audit-index",
        eventType: "legacy_scan_indexed",
        summary: "Indexed legacy data into local SQLite",
        detailJson: "{}",
        createdAt: new Date().toISOString()
      }
    ],
    diagnostics: {
      available: false,
      appVersion: "0.1.0 preview",
      generatedAt: new Date().toISOString(),
      overallStatus: "preview",
      ok: 6,
      warn: 1,
      error: 0,
      info: 2
    },
    index: {
      persisted: false,
      databaseFile: "浏览器预览不读取 SQLite",
      indexedAt: new Date().toISOString(),
      sourcesIndexed: 3,
      skillsIndexed: 6,
      agentsIndexed: 3,
      snapshotId: "browser-preview"
    }
  };
}

function updatePreviewEnabled(
  snapshot: LegacySnapshot,
  command: string,
  id: string,
  enabled: boolean
): LegacySnapshot {
  if (command === "set_workspace_enabled") {
    return {
      ...snapshot,
      workspaces: snapshot.workspaces.map(item => (item.id === id ? { ...item, enabled } : item))
    };
  }

  if (command === "set_preset_enabled") {
    return {
      ...snapshot,
      presets: snapshot.presets.map(item => (item.id === id ? { ...item, enabled } : item))
    };
  }

  if (command === "set_agent_adapter_enabled") {
    return {
      ...snapshot,
      agentAdapters: snapshot.agentAdapters.map(item => (item.id === id ? { ...item, enabled } : item))
    };
  }

  return snapshot;
}

function updatePreviewPresetDistribution(
  snapshot: LegacySnapshot,
  presetId: string,
  workspaceId: string,
  enabled: boolean
): LegacySnapshot {
  const presetDistributions = snapshot.presetDistributions.map(item =>
    item.presetId === presetId && item.workspaceId === workspaceId
      ? {
          ...item,
          enabled,
          status: enabled ? "enabled" : "disabled",
          summary: enabled
            ? `${item.presetName} 已计划分发到 ${item.workspaceName}。`
            : `${item.presetName} 已从 ${item.workspaceName} 的分发计划中停用。`
        }
      : item
  );
  const workspaceCountByPreset = new Map<string, number>();
  for (const item of presetDistributions) {
    if (item.enabled) {
      workspaceCountByPreset.set(item.presetId, (workspaceCountByPreset.get(item.presetId) ?? 0) + 1);
    }
  }

  return {
    ...snapshot,
    presetDistributions,
    presets: snapshot.presets.map(preset => ({
      ...preset,
      workspaceCount: workspaceCountByPreset.get(preset.id) ?? 0
    }))
  };
}

function updatePreviewOperationRunner(snapshot: LegacySnapshot, runnerId: string): LegacySnapshot {
  const now = new Date().toISOString();
  return {
    ...snapshot,
    operationRunners: snapshot.operationRunners.map(runner =>
      runner.id === runnerId
        ? {
          ...runner,
          status: runner.locked ? "locked" : "completed",
          lastRunAt: now,
          fileCount: Math.max(runner.fileCount, 6),
          summary: runner.locked
            ? `${runner.title} 已生成锁定计划；没有执行真实打包。`
            : `${runner.title} 已完成 dry-run 记录；没有执行真实写入。`
        }
        : runner
    ),
    auditEvents: [
      {
        id: `preview-runner-${runnerId}-${Date.now()}`,
        eventType: "operation_runner_completed",
        summary: `Completed dry-run runner ${runnerId}`,
        detailJson: "{}",
        createdAt: now
      },
      ...snapshot.auditEvents
    ].slice(0, 30)
  };
}

function updatePreviewRealWriteAuthorization(snapshot: LegacySnapshot, enabled: boolean): LegacySnapshot {
  const now = new Date().toISOString();
  return {
    ...snapshot,
    operatorConsent: {
      realWritesEnabled: enabled,
      enabledAt: enabled ? now : "",
      updatedAt: now,
      summary: enabled
        ? "用户已手动授权真实写入；同步按钮会运行 GitHub 更新、Skill 路由重建和 AI 工具链接同步。"
        : "真实写入授权未开启；同步按钮只刷新索引，不会写入 AI 工具目录。"
    },
    writeGates: snapshot.writeGates.map(gate => {
      if (gate.id !== "agent-sync" && gate.id !== "release-package") return gate;
      const authLabel = "用户已在界面手动开启真实写入授权开关。";
      return enabled
        ? {
            ...gate,
            passingChecks: Array.from(new Set([...gate.passingChecks, authLabel])),
            blockingChecks: gate.blockingChecks.filter(check => !check.includes("真实写入授权开关"))
          }
        : {
            ...gate,
            blockingChecks: Array.from(new Set([...gate.blockingChecks, authLabel])),
            passingChecks: gate.passingChecks.filter(check => !check.includes("真实写入授权开关"))
          };
    })
  };
}

function updatePreviewDesktopQaStatus(
  snapshot: LegacySnapshot,
  id: string,
  status: "pending" | "passed" | "failed"
): LegacySnapshot {
  return {
    ...snapshot,
    desktopQaChecks: snapshot.desktopQaChecks.map(check =>
      check.id === id ? { ...check, status, updatedAt: new Date().toISOString() } : check
    )
  };
}

function scopeLabel(scope: string) {
  if (scope === "global") return "全局";
  if (scope === "agent") return "Agent";
  if (scope === "project") return "项目";
  return scope;
}

function ScanFlag({ enabled, label }: { enabled: boolean; label: string }) {
  return <span className={enabled ? "scan-flag is-on" : "scan-flag"}>{enabled ? "有" : "缺"} {label}</span>;
}

function riskLabel(riskLevel: string) {
  if (riskLevel === "low") return "低风险";
  if (riskLevel === "medium") return "中风险";
  if (riskLevel === "high") return "高风险";
  return riskLevel;
}

function stepStatusLabel(status: string) {
  if (status === "ready") return "已准备";
  if (status === "planned") return "待实现";
  if (status === "locked") return "已锁定";
  return status;
}

function backupStatusLabel(status: string) {
  if (status === "ready") return "已备份";
  if (status === "required") return "必须备份";
  if (status === "blocked") return "已阻断";
  if (status === "skipped") return "暂不处理";
  return status;
}

function dryRunStatusLabel(status: string) {
  if (status === "ready") return "可恢复";
  if (status === "planned") return "预演中";
  if (status === "blocked") return "已阻断";
  if (status === "skipped") return "跳过";
  return status;
}

function auditEventLabel(eventType: string) {
  if (eventType === "legacy_scan_indexed") return "索引刷新";
  if (eventType === "skill_metadata_updated") return "Skill 元数据";
  if (eventType === "skill_enabled_updated") return "Skill 状态";
  if (eventType === "source_metadata_updated") return "来源元数据";
  if (eventType === "usage_recorded") return "使用记录";
  if (eventType === "state_updated") return "状态更新";
  if (eventType === "desktop_qa_updated") return "桌面 QA";
  return eventType;
}

function backupActionLabel(action: string) {
  if (action === "copy-to-backup") return "复制到备份位置";
  if (action === "verify-backup") return "校验已有备份";
  if (action === "block-backup") return "阻断真实备份";
  if (action === "skip") return "跳过未检测工具";
  return action;
}

function restoreActionLabel(action: string) {
  if (action === "prepare-restore") return "等待备份后才能恢复";
  if (action === "restore-from-backup") return "从备份恢复";
  if (action === "block-restore") return "阻断真实恢复";
  if (action === "skip") return "跳过未检测工具";
  return action;
}

function releaseReportGateStatus(report?: ReleaseReportCard) {
  if (!report) return "planned";
  if (report.ok && report.status === "ok") return "done";
  if (report.status === "warn") return "planned";
  return "blocked";
}

function releaseReportGateLabel(report?: ReleaseReportCard) {
  if (!report) return "待接入";
  if (report.ok && report.status === "ok") return "已通过";
  if (report.status === "warn") return "需复查";
  return "已阻断";
}

function operationRunnerStatusClass(status: string, locked: boolean) {
  if (locked) return "blocked";
  if (status === "completed" || status === "ok") return "done";
  if (status === "error" || status === "blocked") return "blocked";
  if (status === "armed") return "planned";
  return "planned";
}

function operationRunnerStatusLabel(status: string, locked: boolean) {
  if (locked) return "已锁定";
  if (status === "completed" || status === "ok") return "已完成";
  if (status === "armed") return "待确认";
  if (status === "warn") return "需复查";
  if (status === "blocked") return "阻断";
  if (status === "error") return "失败";
  return "可运行";
}

function operationRunnerActionLabel(runnerType: string, locked: boolean) {
  if (locked) return "生成锁定计划";
  if (runnerType === "real-write-check") return "运行解锁检查";
  if (runnerType === "real-write-executor") return "尝试最终执行";
  if (runnerType === "release-package") return "生成打包计划";
  return "运行 dry-run";
}

function writeGateStatusClass(gate: WriteGateCard) {
  if (gate.unlocked) return "done";
  if (gate.status === "locked") return "planned";
  if (gate.status === "ready") return "planned";
  return "blocked";
}

function writeGateStatusLabel(gate: WriteGateCard) {
  if (gate.unlocked) return "可执行";
  if (gate.status === "locked") return "仍锁定";
  if (gate.status === "ready") return "待解锁";
  return "阻断";
}

function writeGateRiskLabel(riskLevel: string) {
  if (riskLevel === "high") return "高";
  if (riskLevel === "medium") return "中";
  if (riskLevel === "low") return "低";
  return riskLevel || "未知";
}

function releaseReadinessReason(items: Array<{ status: string; title: string; label: string }>) {
  const blocked = items.find(item => item.status === "blocked");
  if (blocked) {
    return `因为“${blocked.title}”仍处于${blocked.label}状态，不能生成可分享版本。`;
  }

  const planned = items.find(item => item.status === "planned");
  if (planned) {
    return `因为“${planned.title}”仍处于${planned.label}状态，需要复查后再考虑候选打包。`;
  }

  return "所有发布闸门已通过，可以进入候选打包复查；此页面仍不会直接执行打包。";
}

function desktopQaGateStatus(checks: DesktopQaCheckCard[]) {
  if (checks.length === 0) return "planned";
  if (checks.some(check => check.required && check.status === "failed")) return "blocked";
  if (checks.filter(check => check.required).every(check => check.status === "passed")) return "done";
  return "planned";
}

function desktopQaGateLabel(checks: DesktopQaCheckCard[]) {
  const status = desktopQaGateStatus(checks);
  if (status === "done") return "已通过";
  if (status === "blocked") return "已阻断";
  return "待复查";
}

function desktopQaGateSummary(checks: DesktopQaCheckCard[]) {
  if (checks.length === 0) return "还没有生成桌面 QA 检查项。";
  const required = checks.filter(check => check.required);
  const passed = required.filter(check => check.status === "passed").length;
  const failed = required.filter(check => check.status === "failed").length;
  const pending = required.length - passed - failed;
  return `桌面 QA：${passed}/${required.length} 项通过，${pending} 项待检查，${failed} 项失败。`;
}

function qaStatusClass(status: string) {
  if (status === "passed") return "done";
  if (status === "failed") return "blocked";
  return "planned";
}

function qaStatusLabel(status: string) {
  if (status === "passed") return "已通过";
  if (status === "failed") return "未通过";
  return "待检查";
}

function formatScanTime(value: string) {
  if (!value) {
    return "待生成";
  }
  if (/^\d{16,}$/.test(value)) {
    return "刚刚";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "已记录";
  }
  return date.toLocaleString();
}

function formatCompactNumber(value: number) {
  if (!Number.isFinite(value)) {
    return "0";
  }
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}K`;
  }
  return String(Math.max(0, Math.round(value)));
}

function countByStatus(items: Array<{ status: string }>, status: string) {
  return items.filter(item => item.status === status).length;
}

function projectInstructionPreview(scan: ProjectScanCard) {
  const stack = [
    scan.hasPackageJson ? "前端 package.json" : "",
    scan.hasCargoToml ? "Rust/Cargo" : "",
    scan.hasTauriConfig ? "Tauri 桌面壳" : ""
  ].filter(Boolean);
  const instructionFiles = [
    scan.hasAgentsMd ? "AGENTS.md 已存在" : "AGENTS.md 待补",
    scan.hasClaudeMd ? "CLAUDE.md 已存在" : "CLAUDE.md 待补"
  ];

  return [
    "# 项目工作区说明草稿",
    `项目路径：${scan.path}`,
    `识别技术栈：${stack.length > 0 ? stack.join(" / ") : "暂未识别"}`,
    `AI 说明文件：${instructionFiles.join("，")}`,
    "",
    "建议策略：先保持只读扫描；等快照、备份和回滚完成后，再允许生成或更新项目级说明文件。"
  ].join("\n");
}

function adapterStatusLabel(status: string) {
  if (status === "ready") return "可用";
  if (status === "detected-unmanaged") return "待接管";
  return "未检测";
}

function capabilityLabel(key: string) {
  if (key === "global-scope") return "全局";
  if (key === "project-scope") return "项目";
  if (key === "copy-fallback") return "复制兜底";
  if (key === "instructions-generation") return "生成说明";
  return key;
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
      data-state={enabled ? "on" : "off"}
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
  trend,
  value
}: {
  accent?: string;
  icon?: IconName;
  label: string;
  trend?: string;
  value: number;
}) {
  return (
    <article className={`metric metric-${accent}`}>
      <div>
        <span>{label}</span>
        {icon && <em aria-hidden="true"><Icon name={icon} /></em>}
      </div>
      <strong>{value.toLocaleString()}</strong>
      {trend && <small>{trend}</small>}
    </article>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <section className="panel empty-state">
      <p>{text}</p>
    </section>
  );
}
