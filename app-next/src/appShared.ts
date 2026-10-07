// Shared types, constants and pure helpers used by App.tsx, src/pages/* and
// src/components/*. Keep this module free of imports from App.tsx and page modules.
import { lazy } from "react";
import type { IconName } from "./icons";
import { categoryName, getLang, t } from "./i18n";
import { localizedSkillDescription } from "./localizedDescriptions";
import {
  isRouterHubSkill as modelIsRouterHubSkill,
  skillBelongsToSource as modelSkillBelongsToSource
} from "./skyIslandModel";
import type { SkillCard, SourceCard } from "./types";

export const SourceUpdatePanel = lazy(() => import("./SourceUpdatePanel").then(module => ({ default: module.SourceUpdatePanel })));

/* =============================================================
   Types and constants
   ============================================================= */

declare const __APP_VERSION__: string;

export type ThemeName =
  | "sky-auto"
  | "sky-dawn"
  | "sky-noon"
  | "sky-golden"
  | "sky-night"
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
export type UiScalePreset = "compact" | "standard" | "comfortable" | "large";

export type SkillDraft = { name: string; category: string; description: string; note: string; tags: string };
export type SourceDraft = {
  name: string;
  category: string;
  enabled: boolean;
  note: string;
  sourceType: SourceCard["sourceType"];
  tags: string;
};
export type ImportWizardDraft = {
  customCategory: string;
  customFolderName: string;
  enabled: boolean;
  importKind: "github" | "local" | "zip";
  input: string;
  folderId: string;
  note: string;
  selectedCategoryIds: string[];
  sourceType: SourceCard["sourceType"];
  tags: string;
};

export const IMPORT_WIZARD_DRAFT_STORAGE_KEY = "ai-skillhub-source-import-draft-v1";

export const EMPTY_IMPORT_WIZARD_DRAFT: ImportWizardDraft = {
  customCategory: "",
  customFolderName: "",
  enabled: true,
  importKind: "github",
  input: "",
  folderId: "",
  note: "",
  selectedCategoryIds: [],
  sourceType: "skill",
  tags: ""
};

export function loadImportWizardDraft(): ImportWizardDraft {
  try {
    const raw = window.localStorage.getItem(IMPORT_WIZARD_DRAFT_STORAGE_KEY);
    if (!raw) return { ...EMPTY_IMPORT_WIZARD_DRAFT };
    const saved = JSON.parse(raw) as Partial<ImportWizardDraft>;
    const importKind = ["github", "local", "zip"].includes(saved.importKind ?? "")
      ? saved.importKind as ImportWizardDraft["importKind"]
      : "github";
    const sourceType = ["skill", "prompt", "mixed"].includes(saved.sourceType ?? "")
      ? saved.sourceType as SourceCard["sourceType"]
      : "skill";
    const text = (value: unknown, maxLength: number) =>
      typeof value === "string" ? value.slice(0, maxLength) : "";
    return {
      customCategory: text(saved.customCategory, 500),
      customFolderName: text(saved.customFolderName, 48),
      enabled: typeof saved.enabled === "boolean" ? saved.enabled : true,
      importKind,
      input: text(saved.input, 10_000),
      folderId: text(saved.folderId, 200),
      note: text(saved.note, 20_000),
      selectedCategoryIds: Array.isArray(saved.selectedCategoryIds)
        ? saved.selectedCategoryIds.filter(value => typeof value === "string").slice(0, 100)
        : [],
      sourceType,
      tags: text(saved.tags, 10_000)
    };
  } catch {
    return { ...EMPTY_IMPORT_WIZARD_DRAFT };
  }
}

export function importWizardDraftHasContent(draft: ImportWizardDraft) {
  return Boolean(
    draft.input.trim() ||
    draft.folderId.trim() ||
    draft.note.trim() ||
    draft.tags.trim() ||
    draft.customCategory.trim() ||
    draft.customFolderName.trim() ||
    draft.selectedCategoryIds.length ||
    draft.importKind !== EMPTY_IMPORT_WIZARD_DRAFT.importKind ||
    draft.sourceType !== EMPTY_IMPORT_WIZARD_DRAFT.sourceType ||
    draft.enabled !== EMPTY_IMPORT_WIZARD_DRAFT.enabled
  );
}
export type SourceImportProgressEvent = {
  operationId: string;
  stage: "inspect" | "git" | "zip" | "write" | "security" | string;
  state: "started" | "progress" | "completed" | "cancelled" | string;
  message: string;
  current: number;
  total: number;
};
export type ImportFeedbackOptions = {
  quiet?: boolean;
  securityReviewConfirmed?: boolean;
  operationId?: string;
  onProgress?: (event: SourceImportProgressEvent) => void;
};
export type ToastTone = "info" | "ok" | "warn" | "error";
type AppUpdatePhase =
  | "idle"
  | "checking"
  | "retrying"
  | "latest"
  | "available"
  | "downloading"
  | "installing"
  | "error";
export type AppUpdateState = {
  phase: AppUpdatePhase;
  progress: number;
  version: string;
  failure: UpdateFailureKind | "";
  failureStage: UpdateFailureStage | "";
  attempts: number;
  checkedAt: string;
};
export type UpdateFailureKind =
  | "network"
  | "timeout"
  | "tls"
  | "proxy"
  | "manifest"
  | "signature"
  | "permission"
  | "download"
  | "install"
  | "unknown";
export type UpdateFailureStage = "check" | "download" | "install";

export const TOAST_EVENT = "ai-skillhub-toast";
export const APP_VERSION = __APP_VERSION__;
const INTERNAL_SKILL_DRAG_TYPES = [
  "application/x-ai-skillhub-source-id",
  "application/x-ai-skillhub-skill-id"
] as const;

export function hasInternalSkillDrag(dataTransfer: DataTransfer) {
  const types = Array.from(dataTransfer.types);
  return INTERNAL_SKILL_DRAG_TYPES.some(type => types.includes(type));
}
export const THEME_OPTIONS: Array<{ icon: IconName; labelKey: string; value: ThemeName }> = [
  { value: "sky-auto", labelKey: "theme.skyAuto", icon: "sparkle" },
  { value: "sky-dawn", labelKey: "theme.skyDawn", icon: "sun" },
  { value: "sky-noon", labelKey: "theme.skyNoon", icon: "sun" },
  { value: "sky-golden", labelKey: "theme.skyGolden", icon: "sun" },
  { value: "sky-night", labelKey: "theme.skyNight", icon: "moon" },
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
let previewModulePromise: Promise<typeof import("./preview")> | null = null;

export function loadPreviewModule() {
  previewModulePromise ??= import("./preview");
  return previewModulePromise;
}
export const CATEGORY_IDS = [
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
   Helpers
   ============================================================= */

export function hasTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}
export type SkyPhase = "dawn" | "noon" | "golden" | "night";

export function isAtlasTheme(theme: ThemeName): boolean {
  return (
    theme.startsWith("sky-") ||
    theme === "nocturne" ||
    theme === "parchment" ||
    theme === "atlas-dark" ||
    theme === "atlas-light" ||
    theme === "atlas-legacy-dark" ||
    theme === "atlas-legacy-light"
  );
}

export function atlasThemeVisual(theme: ThemeName) {
  if (theme.startsWith("sky-")) {
    return theme === "sky-night"
      ? { accent: "#f2b866", palette: ["#f2b866", "#86b4ff", "#6fcf9f", "#aeb9cb"] }
      : { accent: "#1d6fb8", palette: ["#1d6fb8", "#c8662c", "#2c8a5f", "#7a8794"] };
  }
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

export function themeLabel(theme: ThemeName): string {
  const option = THEME_OPTIONS.find(item => item.value === theme);
  return option ? t(option.labelKey) : t("theme.dark");
}

export function showUiToast(message: string, tone: ToastTone = "info") {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(TOAST_EVENT, { detail: { message, tone } }));
}

export function messageFromError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function createSourceImportOperationId() {
  const random = globalThis.crypto?.randomUUID?.().replace(/[^a-zA-Z0-9_-]/g, "")
    ?? Math.random().toString(36).slice(2);
  return `source-import-${Date.now()}-${random}`.slice(0, 92);
}

export function friendlyErrorMessage(message: string) {
  if (message.includes("Source metadata is too long")) return t("error.sourceTooLong");
  if (message.includes("GitHub API")) return t("error.github");
  return message;
}

export function parseTagInput(value: string): string[] {
  return Array.from(
    new Set(
      value
        .split(/[,\n，;；#]+/)
        .map(tag => tag.trim())
        .filter(Boolean)
    )
  ).slice(0, 12);
}

export function queryLooksLikeSkillCommand(query: string) {
  return /^[\/@$]/.test(query.trim());
}

export function normalizeSearch(value: string) {
  return value.toLowerCase().replace(/^[\/@$]+/, "").replace(/[_/\\.-]+/g, " ").replace(/\s+/g, " ").trim();
}

export function compactSearch(value: string) {
  return value.toLowerCase().replace(/^[\/@$]+/, "").replace(/[^a-z0-9一-鿿]+/g, "");
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

export function skillMatchesSearch(skill: SkillCard, query: string) {
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

export function sourceMatchesSearch(source: SourceCard, query: string) {
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

export function skillBelongsToSource(skill: SkillCard, source: SourceCard): boolean {
  return modelSkillBelongsToSource(skill, source);
}

export function normalizeLookup(value: string) {
  return value.trim().toLowerCase().replace(/[_\s]+/g, "-");
}

export function isRouterHubSkill(skill: SkillCard): boolean {
  return modelIsRouterHubSkill(skill);
}

export function stableSkillClientId(skill: SkillCard) {
  return skill.id || `preview-skill-${skill.folderName}`;
}

export function skillInvocationName(skill: SkillCard) {
  return skill.invocationName?.trim() || skill.folderName.trim() || skill.name.trim();
}

export function inferCategoryIds(input: string): string[] {
  const text = normalizeSearch(input);
  const matches: string[] = [];
  for (const id of CATEGORY_IDS) {
    const keywords = [id, ...(CATEGORY_KEYWORDS[id] ?? [])].map(normalizeSearch);
    if (keywords.some(keyword => text.includes(keyword))) matches.push(id);
  }
  return matches.length > 0 ? Array.from(new Set(matches)).slice(0, 4) : ["general"];
}

export function displayCategoryName(category: string) {
  const id = category.trim().toLowerCase();
  return categoryName(id) ?? category;
}

export function sourceTypeLabel(sourceType: string) {
  if (sourceType === "skill") return t("type.skill");
  if (sourceType === "prompt") return t("type.prompt");
  if (sourceType === "mixed") return t("type.mixed");
  return sourceType;
}

export function formatScanTime(value: string) {
  if (!value) return "—";
  if (/^\d{16,}$/.test(value)) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString();
}

export function formatCompactNumber(value: number) {
  if (!Number.isFinite(value)) return "0";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}K`;
  return String(Math.max(0, Math.round(value)));
}

export function formatFileSize(value: number) {
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

export async function copyTextToClipboard(text: string, successMessage: string) {
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

export async function copySkillPrompt(
  skill: SkillCard,
  onRecordUsage?: (
    targetType: string,
    targetId: string,
    targetName: string,
    sourceName: string,
    eventType: string
  ) => Promise<void>
) {
  const context = localizedSkillDescription(skill, getLang()) || displayCategoryName(skill.category) || t("copy.fallbackContext");
  const text = t("copy.template", { name: skillInvocationName(skill), context });
  try {
    await navigator.clipboard.writeText(text);
    showUiToast(t("toast.copied"), "ok");
  } catch {
    showUiToast(t("toast.copyBlocked"), "warn");
  }
  await onRecordUsage?.("skill", skill.folderName, skill.name, skill.source, "copy_prompt");
}
