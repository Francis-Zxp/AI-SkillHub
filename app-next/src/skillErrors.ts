// v3.3 error model (skills contract §4.5, S1-9). Every failure the UI shows goes
// through normalizeSkillHubError, so an object never renders as "[object Object]"
// and every error class carries one plain next step.
// Pure: only `import type`, so node tests can transpile it alone.
import type { ErrorAction, ErrorActionKind, SkillHubError, SkillHubErrorCode } from "./types";

type Pattern = { test: RegExp; code: SkillHubErrorCode; action: ErrorActionKind | null };

/** Same table as the Rust classify_legacy_error (§4.5). Order matters: first match wins. */
export const LEGACY_ERROR_PATTERNS: readonly Pattern[] = [
  { test: /另一项刷新或写入任务正在运行/, code: "WRITE_BUSY", action: "wait" },
  { test: /无法取得数据写入锁/, code: "WRITE_BUSY", action: "wait" },
  { test: /GitHub API|rate limit/i, code: "NETWORK_FAILED", action: "retry" },
  { test: /超过\s*(240|180)\s*秒/, code: "SCRIPT_TIMEOUT", action: "export-report" },
  { test: /超过\s*120\s*秒/, code: "DOWNLOAD_TIMEOUT", action: "retry" },
  { test: /Source metadata is too long/i, code: "INPUT_TOO_LONG", action: null },
  { test: /Personal or external Skill entry preserved|Personal Skill/i, code: "TARGET_CONFLICT", action: "resolve-conflict" },
  { test: /Recipient Skills root is an external link/i, code: "AGENT_DIR_EXTERNAL_LINK", action: "open-folder" },
  { test: /完整性核对未通过|交付验收失败/, code: "DELIVERY_VERIFY_FAILED", action: "retry" },
  { test: /找不到同步脚本|找不到 AI 工具链接脚本/, code: "SCRIPT_MISSING", action: "reinstall" },
  { test: /Cannot open v2 SQLite database|Cannot commit v2 SQLite/i, code: "INDEX_FAILED", action: "export-report" },
  { test: /导入已取消/, code: "CANCELLED", action: null },
  { test: /Agent Skill allowlist contains/i, code: "DELIVERY_POLICY_INVALID", action: "export-report" },
  { test: /name and description|没有可读的 SKILL\.md/i, code: "MANIFEST_INVALID", action: "open-folder" },
  { test: /系统 Git|\bgit\b.*(not found|not recognized|找不到)|(not found|找不到).*\bgit\b/i, code: "GIT_MISSING", action: "install-git" }
];

const KNOWN_CODES = new Set<string>([
  "WRITE_BUSY", "DELIVERY_PAUSED", "ONBOARDING_REQUIRED",
  "AGENT_UNKNOWN", "AGENT_UNSUPPORTED", "AGENT_NOT_INSTALLED", "AGENT_NOT_TAKEN_OVER",
  "AGENT_DIR_EXTERNAL_LINK", "AGENT_DIR_NOT_WRITABLE",
  "TARGET_CONFLICT", "MANIFEST_INVALID", "DELIVERY_VERIFY_FAILED", "DELIVERY_POLICY_INVALID",
  "SCRIPT_FAILED", "SCRIPT_TIMEOUT", "SCRIPT_MISSING",
  "UNIT_NOT_FOUND", "SOURCE_LIBRARY_ONLY", "SECURITY_REVIEW_REQUIRED", "SECURITY_BLOCKED",
  "INPUT_EMPTY", "INPUT_UNRECOGNIZED", "INPUT_IS_MCP_CONFIG", "INPUT_TOO_LONG",
  "PATH_NOT_FOUND", "PATH_NOT_ABSOLUTE", "ZIP_INVALID",
  "GITHUB_NOT_FOUND", "GITHUB_RENAMED", "GITHUB_REF_NOT_FOUND", "GITHUB_SUBPATH_NOT_FOUND",
  "NETWORK_FAILED", "DOWNLOAD_TIMEOUT", "GIT_MISSING",
  "NO_SKILLS_FOUND", "PROBE_EXPIRED", "PROBE_STALE", "DUPLICATE_SOURCE", "CANCELLED",
  "INDEX_FAILED", "INTERNAL"
]);

const MAX_DETAIL = 400;

function clip(value: string, max = MAX_DETAIL) {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** Strip anything that looks like a credential before it can reach the screen. */
export function redactSecrets(value: string): string {
  return value
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{12,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9-_]{16,}|vc_web_[A-Za-z0-9]{12,})\b/g, "••••")
    .replace(/\b(token|password|secret|api[_-]?key|authorization)\s*[:=]\s*\S+/gi, "$1=••••");
}

export function classifyLegacyError(message: string): { code: SkillHubErrorCode; action: ErrorAction | null } {
  for (const pattern of LEGACY_ERROR_PATTERNS) {
    if (pattern.test.test(message)) {
      return { code: pattern.code, action: pattern.action ? { kind: pattern.action, payload: {} } : null };
    }
  }
  return { code: "INTERNAL", action: { kind: "export-report", payload: {} } };
}

function isSkillHubErrorShape(value: unknown): value is Partial<SkillHubError> & { code: string } {
  return Boolean(value) && typeof value === "object" && typeof (value as { code?: unknown }).code === "string"
    && KNOWN_CODES.has((value as { code: string }).code);
}

function fromMessage(raw: string): SkillHubError {
  const message = redactSecrets(raw.trim());
  const { code, action } = classifyLegacyError(message);
  // Raw stack traces never reach the user (AGENTS.md); the first line is the readable part.
  const firstLine = message.split(/\r?\n/)[0] ?? "";
  return {
    code,
    message: clip(firstLine || message, 280),
    detail: message.includes("\n") ? clip(message) : "",
    action,
    agentId: null,
    sourceId: null,
    path: null
  };
}

/** Accepts a SkillHubError, an Error, a legacy string, a Tauri error object or undefined. */
export function normalizeSkillHubError(error: unknown): SkillHubError {
  if (isSkillHubErrorShape(error)) {
    const action = error.action && typeof error.action === "object" && typeof error.action.kind === "string"
      ? { kind: error.action.kind, payload: error.action.payload && typeof error.action.payload === "object" ? error.action.payload : {} }
      : null;
    return {
      code: error.code as SkillHubErrorCode,
      message: redactSecrets(typeof error.message === "string" ? error.message : ""),
      detail: clip(redactSecrets(typeof error.detail === "string" ? error.detail : "")),
      action,
      agentId: typeof error.agentId === "string" ? error.agentId : null,
      sourceId: typeof error.sourceId === "string" ? error.sourceId : null,
      path: typeof error.path === "string" ? error.path : null
    };
  }
  if (error instanceof Error) return fromMessage(error.message || error.name || "");
  if (typeof error === "string") return fromMessage(error);
  if (error && typeof error === "object") {
    const candidate = (error as { message?: unknown; error?: unknown }).message ?? (error as { error?: unknown }).error;
    if (typeof candidate === "string") return fromMessage(candidate);
    try {
      return fromMessage(JSON.stringify(error).slice(0, MAX_DETAIL));
    } catch {
      return fromMessage("");
    }
  }
  return {
    code: "INTERNAL",
    message: "",
    detail: "",
    action: { kind: "export-report", payload: {} },
    agentId: null,
    sourceId: null,
    path: null
  };
}

/** Message the UI should show: the localized t(`err.${code}`) when it exists, else the backend text. */
export function skillHubErrorText(error: SkillHubError, translate: (key: string, vars?: Record<string, string | number>) => string): string {
  const key = `err.${error.code}`;
  const localized = translate(key, { agent: error.agentId ?? "", path: error.path ?? "" });
  if (localized !== key && error.code !== "INTERNAL") return localized;
  if (error.message.trim()) return error.message;
  return localized !== key ? localized : translate("err.INTERNAL");
}
