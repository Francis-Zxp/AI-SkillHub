// Pure helpers for the MCP page. Type-only imports keep this module runnable
// under `node --test` (Node strips the types), so the rules below are unit-tested
// in scripts/v3.3-mcp-contract.test.mjs without a bundler.
import type {
  McpCell,
  McpCellReason,
  McpClient,
  McpClientId,
  McpClientResult,
  McpConfirmation,
  McpError,
  McpHistoryEntry,
  McpIssue,
  McpLibrarySnapshot,
  McpOperationSummary,
  McpServerRow,
  McpTargetSummary,
  McpTestSummary,
  McpTransport,
  McpWriteOutcome
} from "./mcpTypes";

export type Translate = (key: string, vars?: Record<string, string | number>) => string;

export const MCP_CLIENT_ORDER: readonly McpClientId[] = ["codex", "claude-code", "claude-desktop", "cursor"];

export const DEFAULT_CLIENT_LABELS: Readonly<Record<McpClientId, string>> = {
  codex: "Codex",
  "claude-code": "Claude Code",
  "claude-desktop": "Claude Desktop",
  cursor: "Cursor"
};

// ---------- names, URLs and commands (contract §2.2, §2.5) ----------

export const MCP_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const CLAUDE_RESERVED_NAMES = new Set(["workspace", "claude-in-chrome", "computer-use", "claude preview", "claude browser"]);

export type NameProblem = "empty" | "pattern" | "reserved" | "taken" | null;

/** New library names use the strictest rule every client accepts. */
export function validateServerName(name: string, existingNames: readonly string[] = []): NameProblem {
  const value = name.trim();
  if (!value) return "empty";
  if (!MCP_NAME_PATTERN.test(value)) return "pattern";
  if (CLAUDE_RESERVED_NAMES.has(value.toLowerCase())) return "reserved";
  if (existingNames.some(existing => existing.toLowerCase() === value.toLowerCase())) return "taken";
  return null;
}

/** Turns a free-form title into a name that passes the rule ("Context 7 Docs" → "context-7-docs"). */
export function sanitizeServerName(value: string): string {
  const cleaned = value
    .trim()
    .replace(/^@[^/]+\//, "")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .toLowerCase();
  return cleaned.slice(0, 64);
}

export type UrlProblem = "empty" | "scheme" | "credentials" | "query" | "invalid" | null;

/** Remote address rule: http(s) only, no credentials, query or fragment (mcp_mutation.rs:1417-1447). */
export function validateRemoteUrl(value: string): UrlProblem {
  const text = value.trim();
  if (!text) return "empty";
  if (!/^https?:\/\//i.test(text)) return "scheme";
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return "invalid";
  }
  if (parsed.username || parsed.password) return "credentials";
  if (parsed.search || parsed.hash || text.includes("?") || text.includes("#")) return "query";
  if (!parsed.hostname) return "invalid";
  return null;
}

export function isRemoteTarget(text: string): boolean {
  return /^\s*https?:\/\//i.test(text);
}

// An unquoted Windows program path with spaces, e.g. C:\Program Files\nodejs\npx.cmd -y pkg:
// everything up to the first ".exe/.cmd/.bat/.com" is the program, as Windows itself reads it.
const UNQUOTED_WINDOWS_PROGRAM = /^([A-Za-z]:[\\/][^"'\r\n]*?\.(?:exe|cmd|bat|com))(?=\s|$)/i;

/** Splits "npx -y @scope/pkg" into command + args, honouring simple quotes. */
export function splitCommandLine(text: string): { command: string; args: string[] } {
  const trimmed = text.trim();
  const program = trimmed.match(UNQUOTED_WINDOWS_PROGRAM);
  if (program && /\s/.test(program[1])) {
    const rest = splitCommandLine(`x ${trimmed.slice(program[1].length)}`);
    return { command: program[1], args: rest.args };
  }
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let hasToken = false;
  for (const char of trimmed) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      hasToken = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (hasToken) tokens.push(current);
      current = "";
      hasToken = false;
      continue;
    }
    current += char;
    hasToken = true;
  }
  if (hasToken) tokens.push(current);
  const [command = "", ...args] = tokens;
  return { command, args };
}

/** Quotes an argument for display only; the backend always receives argument vectors. */
export function joinCommandLine(command: string, args: readonly string[]): string {
  return [command, ...args]
    .filter(part => part !== "")
    .map(part => (/\s/.test(part) ? `"${part}"` : part))
    .join(" ");
}

const WINDOWS_RUNNER_FAMILY = new Set(["npx", "npm", "pnpm", "yarn", "node", "bun", "deno"]);
const SHELL_HOSTS = new Set(["cmd", "powershell", "pwsh", "bash", "sh", "zsh", "wsl", "cscript", "wscript"]);

function fileStem(command: string): string {
  const base = command.trim().split(/[\\/]/).pop() ?? "";
  return base.replace(/\.(cmd|exe|bat|ps1)$/i, "").toLowerCase();
}

export type CommandCheck =
  | { kind: "ok"; command: string; args: string[]; unwrapped: boolean }
  | { kind: "shell" };

/**
 * `cmd /c npx …` is unwrapped (SkillHub adds the wrapper back where Windows needs it);
 * any other shell or script host is refused, as validate_command does.
 */
export function normalizeCommand(command: string, args: readonly string[]): CommandCheck {
  const stem = fileStem(command);
  if (stem === "cmd") {
    const [flag, runner, ...rest] = args;
    if (flag && flag.toLowerCase() === "/c" && runner && WINDOWS_RUNNER_FAMILY.has(fileStem(runner))) {
      return { kind: "ok", command: runner, args: rest, unwrapped: true };
    }
    return { kind: "shell" };
  }
  if (SHELL_HOSTS.has(stem)) return { kind: "shell" };
  return { kind: "ok", command: command.trim(), args: [...args], unwrapped: false };
}

const KEY_VALUE_SECRET = /(?:^|[\s,{])(?:--)?(?:[A-Za-z0-9_]*_)?(?:api[_-]?key|token|secret|password|passwd|authorization)\s*(?:=|:)\s*["']?\S+/im;
const COMMON_TOKEN_PREFIX = /(?:^|[^A-Za-z0-9])(?:sk-(?:proj-)?[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{12,}|github_pat_[A-Za-z0-9_]{12,}|xox[baprs]-[A-Za-z0-9-]{12,}|AIza[0-9A-Za-z_-]{20,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/i;
const SECRET_FLAG = /^--?(?:api[-_]?key|token|secret|password|passwd|authorization)$/i;

/** True when command arguments carry a credential; it belongs in the API Key field instead. */
export function argsContainCredential(args: readonly string[]): boolean {
  const joined = args.join("\n");
  if (KEY_VALUE_SECRET.test(joined) || COMMON_TOKEN_PREFIX.test(joined)) return true;
  return args.some((arg, index) => SECRET_FLAG.test(arg.trim()) && Boolean(args[index + 1]) && !args[index + 1].startsWith("-"));
}

export const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const RESERVED_ENV_NAMES = new Set([
  "PATH", "PATHEXT", "COMSPEC", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "USERPROFILE", "USERNAME", "HOMEDRIVE",
  "HOMEPATH", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "PSMODULEPATH",
  "NODE_OPTIONS", "PYTHONPATH", "PYTHONHOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME"
]);

export type EnvNameProblem = "empty" | "pattern" | "reserved" | null;

export function validateEnvName(name: string): EnvNameProblem {
  const value = name.trim();
  if (!value) return "empty";
  if (!ENV_NAME_PATTERN.test(value)) return "pattern";
  const upper = value.toUpperCase();
  if (RESERVED_ENV_NAMES.has(upper) || upper.startsWith("AI_SKILLHUB")) return "reserved";
  return null;
}

/** "Authorization" → "AUTHORIZATION_TOKEN"; "X-Api-Key" → "X_API_KEY". Used as the default variable for a header. */
export function defaultEnvVarForHeader(serverName: string, headerName: string): string {
  const base = `${serverName}_${headerName.toLowerCase() === "authorization" ? "token" : headerName}`;
  const cleaned = base.replace(/[^A-Za-z0-9_]+/g, "_").replace(/_{2,}/g, "_").replace(/^_+|_+$/g, "").toUpperCase();
  return /^[A-Za-z_]/.test(cleaned) ? cleaned : `MCP_${cleaned}`;
}

// ---------- search and counts (contract §1.3, §6.1, §6.2) ----------

/** Matches name, display name, runner, subject and host only; never env, headers or args. */
export function serverMatchesQuery(server: McpServerRow, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [server.name, server.displayName, server.target.runner, server.target.subject, server.target.host]
    .some(value => typeof value === "string" && value.toLowerCase().includes(needle));
}

export function filterServers(servers: readonly McpServerRow[], query: string): McpServerRow[] {
  return servers.filter(server => serverMatchesQuery(server, query));
}

export function cellFor(server: McpServerRow, clientId: McpClientId): McpCell | undefined {
  return server.cells.find(cell => cell.clientId === clientId);
}

export type ColumnStats = { on: number; total: number; enableable: number; enableableIds: string[]; onIds: string[] };

/** "已在 {on}/{total} 个 MCP 上启用" and "启用其余 {enableable} 个" for one client over the given rows. */
export function columnStats(rows: readonly McpServerRow[], clientId: McpClientId): ColumnStats {
  const onIds: string[] = [];
  const enableableIds: string[] = [];
  for (const row of rows) {
    const cell = cellFor(row, clientId);
    if (!cell) continue;
    if (cell.state === "on") onIds.push(row.id);
    else if (cell.state === "off") enableableIds.push(row.id);
  }
  return { on: onIds.length, total: rows.length, enableable: enableableIds.length, enableableIds, onIds };
}

export type CellIntent =
  | { kind: "toggle"; enabled: boolean }
  | { kind: "retry"; enabled: boolean }
  | { kind: "consent" }
  | { kind: "resolve" }
  | { kind: "none" };

/** What one click on a cell does (contract §6.2 table). */
export function cellIntent(cell: McpCell): CellIntent {
  switch (cell.state) {
    case "on":
      return { kind: "toggle", enabled: false };
    case "off":
      return { kind: "toggle", enabled: true };
    case "error":
      // A failed write leaves the file as it was, so the desired state is the opposite of what the file holds.
      return { kind: "retry", enabled: !(cell.presentInFile && !cell.disabledInFile) };
    case "blocked":
      return cell.reason === "needs-inline-consent" ? { kind: "consent" } : { kind: "toggle", enabled: true };
    case "changed-outside":
      return { kind: "resolve" };
    default:
      return { kind: "none" };
  }
}

/** Default "写入到" choice: every detected writable client that supports the transport. */
export function defaultTargetClients(clients: readonly McpClient[], transport: McpTransport): McpClientId[] {
  return clients.filter(client => client.detected && client.writable && client.transports.includes(transport)).map(client => client.id);
}

export type ClientAvailability = { clientId: McpClientId; available: boolean; reason?: "transport" | "readonly" | "not-installed" | "name" };

export function clientAvailability(client: McpClient, transport: McpTransport, name = ""): ClientAvailability {
  if (!client.detected) return { clientId: client.id, available: false, reason: "not-installed" };
  if (!client.writable) return { clientId: client.id, available: false, reason: "readonly" };
  if (!client.transports.includes(transport)) return { clientId: client.id, available: false, reason: "transport" };
  if (name.includes(".") && client.id !== "codex") return { clientId: client.id, available: false, reason: "name" };
  return { clientId: client.id, available: true };
}

// ---------- labels ----------

export function clientLabel(clientId: McpClientId, clients?: readonly McpClient[] | null): string {
  return clients?.find(client => client.id === clientId)?.label || DEFAULT_CLIENT_LABELS[clientId] || clientId;
}

export function joinNames(items: readonly string[], t: Translate, limit = 3): string {
  const separator = t("mcp.list.sep");
  if (items.length <= limit) return items.join(separator);
  return t("mcp.list.more", { items: items.slice(0, limit).join(separator), n: items.length - limit });
}

export function clientNames(ids: readonly McpClientId[], t: Translate, clients?: readonly McpClient[] | null): string {
  return joinNames(ids.map(id => clientLabel(id, clients)), t, 4);
}

/** "npx · @upstash/context7-mcp · +1 个参数" or "api.githubcopilot.com". Never shows argument values or full paths. */
export function targetLine(target: McpTargetSummary, t: Translate): string {
  if (target.host) return target.host;
  const parts: string[] = [];
  if (target.runner) parts.push(target.runner);
  if (target.subject) parts.push(target.subject);
  if (target.extraArgCount > 0) parts.push(t("mcp.row.extraArgs", { n: target.extraArgCount }));
  return parts.join(" · ") || t("mcp.row.noTarget");
}

export type TestTone = "untested" | "ok" | "failed" | "warn";

export function testTone(test: McpTestSummary | null, missingSecretCount = 0): TestTone {
  if (!test || test.stale) return missingSecretCount > 0 ? "warn" : "untested";
  if (test.status === "ok") return "ok";
  if (test.status === "needs-secret") return "warn";
  if (test.status === "unsupported" || test.status === "stale-preview") return "untested";
  return "failed";
}

export function testText(test: McpTestSummary | null, t: Translate, missingSecretCount = 0, runner: string | null = null): string {
  if (!test || test.stale) return missingSecretCount > 0 ? t("mcp.test.status.needs-secret") : t("mcp.test.untested");
  if (test.status === "ok") return t("mcp.test.okTools", { n: test.toolsCount ?? 0 });
  if (test.status === "failed") return testFailureText(test.messageCode, t, runner);
  if (test.status === "runner-missing" && runner) return t("mcp.test.runnerMissingNamed", { runner });
  return t(`mcp.test.status.${test.status}`);
}

export function testFailureText(messageCode: string, t: Translate, runner: string | null = null): string {
  if (messageCode === "runner-missing" && runner) return t("mcp.test.runnerMissingNamed", { runner });
  const known = ["runner-missing", "needs-secret", "exit-early", "timeout", "http-401", "http-404", "invalid-response"];
  return known.includes(messageCode) ? t(`mcp.test.msg.${messageCode}`) : t("mcp.test.status.failed");
}

export function cellStateText(cell: McpCell, t: Translate, client: string): string {
  if (cell.state === "on") return t("mcp.cell.on");
  if (cell.state === "off") return t("mcp.cell.off");
  if (cell.state === "error") return t("mcp.cell.error");
  if (cell.state === "blocked") return cell.reason === "missing-secret" ? t("mcp.reason.missing-secret", { client }) : t("mcp.cell.blocked");
  if (cell.state === "changed-outside") return t("mcp.cell.changed");
  return cell.reason ? cellReasonText(cell.reason, t, client) : t(`mcp.cell.${cell.state}`);
}

export function cellReasonText(reason: McpCellReason, t: Translate, client: string): string {
  return t(`mcp.reason.${reason}`, { client });
}

// Codes whose backend message names the exact field to fix ("工作目录需要是完整的文件夹路径。").
// The backend writes these in plain zh, so the zh UI shows them as they are; en/ko keep the i18n copy.
const DETAILED_CODES = new Set<McpError["code"]>(["invalid-input"]);

export function errorText(error: McpError, t: Translate, clients?: readonly McpClient[] | null): string {
  const params: Record<string, string | number> = { ...(error.params ?? {}) };
  if (error.clientId && params.client === undefined) params.client = clientLabel(error.clientId, clients);
  if (params.client === undefined) params.client = t("mcp.word.aiTool");
  if (error.code === "engine") return error.message || t("mcp.err.engine");
  if (DETAILED_CODES.has(error.code) && error.message && t("mcp.err.backendDetail") === "zh") return error.message;
  const key = `mcp.err.${error.code}`;
  const text = t(key, params);
  return text === key ? error.message : text;
}

// ---------- outcomes → toasts (contract §6.3, §6.5) ----------

export type OutcomeToast = {
  tone: "ok" | "warn" | "error" | "info";
  text: string;
  failed: Array<{ clientId: McpClientId; text: string }>;
  /** Clients that were left out on purpose (unsupported, needs consent, same-name entry kept); never silent. */
  skipped: Array<{ clientId: McpClientId; text: string }>;
  restartClients: McpClientId[];
};

function verbKey(summary: McpOperationSummary): string {
  return `mcp.toast.${summary.kind}`;
}

// The cell itself already shows these (⊘), so a toast does not repeat them.
const EXPECTED_SKIPS = new Set<McpCellReason>(["transport-unsupported", "name-incompatible"]);

/** "Claude Desktop：需要确认是否写入明文" lines for results the backend skipped on purpose. */
export function skippedLines(results: readonly McpClientResult[], t: Translate, clients?: readonly McpClient[] | null) {
  const lines: Array<{ clientId: McpClientId; text: string }> = [];
  for (const result of results) {
    if (result.status !== "skipped") continue;
    if (result.skippedReason && EXPECTED_SKIPS.has(result.skippedReason)) continue;
    if (lines.some(line => line.clientId === result.clientId)) continue;
    const client = clientLabel(result.clientId, clients);
    // "entry-added-outside" on a skip means the same-name entry already in that file was kept.
    const reason = result.skippedReason === "entry-added-outside"
      ? t("mcp.toast.skipKept", { client })
      : result.skippedReason
        ? cellReasonText(result.skippedReason, t, client)
        : t("mcp.toast.skippedUnknown", { client });
    lines.push({ clientId: result.clientId, text: reason.includes(client) ? reason : `${client}${t("mcp.toast.skipSep")}${reason}` });
  }
  return lines;
}

export function outcomeToast(
  outcome: Extract<McpWriteOutcome, { kind: "done" }>,
  t: Translate,
  clients?: readonly McpClient[] | null
): OutcomeToast {
  const { summary, results } = outcome;
  const failedResults = results.filter(result => result.status === "failed");
  const okClients = uniqueClients(results.filter(result => result.status === "written" || result.status === "unchanged" || result.status === "undone"));
  const restartClients = uniqueClients(results.filter(result => result.restartHint && result.status !== "failed"));
  const skipped = skippedLines(results, t, clients).filter(line => !okClients.includes(line.clientId));
  const servers = joinNames(summary.serverNames, t);
  const failed = failedResults.map(result => ({
    clientId: result.clientId,
    text: result.error ? errorText(result.error, t, clients) : t("mcp.cell.error")
  }));
  // Name only the clients that really changed; a skipped client is reported on its own line.
  const failedIds = uniqueClients(failedResults);
  const listed = summary.clientIds.filter(id => !failedIds.includes(id) && !skipped.some(line => line.clientId === id));
  const allClientIds = listed.length ? listed : okClients;
  const vars = {
    servers,
    clients: clientNames(allClientIds, t, clients),
    names: joinNames(summary.envVarNames, t),
    n: summary.serverNames.length
  };
  const undoing = summary.kind === "undo" || summary.kind === "rollback" || summary.kind === "legacy";
  if (failedResults.length > 0 && okClients.length === 0) {
    const first = failedResults[0];
    return {
      tone: "error",
      text: t(undoing ? "mcp.toast.failedAll.undo" : "mcp.toast.failedAll", { client: clientLabel(first.clientId, clients), reason: failed[0]?.text ?? "" }),
      failed,
      skipped,
      restartClients: []
    };
  }
  if (failedResults.length > 0) {
    const first = failedResults[0];
    return {
      tone: "warn",
      text: t(undoing ? "mcp.toast.partial.undo" : "mcp.toast.partial", {
        ok: okClients.length,
        failed: failedResults.length,
        client: clientLabel(first.clientId, clients),
        reason: failed[0]?.text ?? ""
      }),
      failed,
      skipped,
      restartClients
    };
  }
  if (okClients.length === 0 && skipped.length > 0 && !undoing) {
    // Everything was skipped: say so instead of claiming it was written.
    const key = summary.kind === "add" ? "mcp.toast.nothingWritten.add" : "mcp.toast.nothingWritten";
    return { tone: "warn", text: t(key, { servers }), failed: [], skipped, restartClients: [] };
  }
  const key = verbKey(summary);
  const text = t(key, vars);
  return { tone: skipped.length > 0 ? "warn" : "ok", text: text === key ? t("mcp.toast.done") : text, failed: [], skipped, restartClients };
}

/**
 * Two confirmations ask the same question when everything but the token is equal. The token binds
 * the request too, so a choice made inside the dialog (e.g. "also delete GITHUB_TOKEN") yields a
 * fresh token for the very same content; that one is accepted without asking twice.
 */
export function sameConfirmation(a: McpConfirmation, b: McpConfirmation): boolean {
  const strip = (value: McpConfirmation) => JSON.stringify({
    kinds: [...value.kinds].sort(),
    items: value.items,
    envVars: value.envVars ?? [],
    undoable: value.undoable
  });
  return strip(a) === strip(b);
}

function uniqueClients(results: readonly McpClientResult[]): McpClientId[] {
  const seen: McpClientId[] = [];
  for (const result of results) if (!seen.includes(result.clientId)) seen.push(result.clientId);
  return seen;
}

// ---------- history (contract §4.4) ----------

/** Accepts ISO 8601 or a unix timestamp string (seconds, milliseconds or nanoseconds). */
export function parseTimestamp(value: string): Date | null {
  if (!value) return null;
  if (/^\d+$/.test(value.trim())) {
    const digits = value.trim();
    const number = Number(digits.length > 16 ? digits.slice(0, 13) : digits);
    const ms = digits.length > 16 ? number : digits.length > 11 ? number : number * 1000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatWhen(value: string, locale: string, now: Date, t: Translate): string {
  const date = parseTimestamp(value);
  if (!date) return "";
  const time = date.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", hour12: false });
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const dayMs = 24 * 60 * 60 * 1000;
  if (date.getTime() >= startOfToday) return time;
  if (date.getTime() >= startOfToday - dayMs) return t("mcp.time.yesterday", { time });
  return `${date.toLocaleDateString(locale, { month: "short", day: "numeric" })} ${time}`;
}

export function historyLabel(entry: McpHistoryEntry, t: Translate, clients?: readonly McpClient[] | null): string {
  if (entry.kind === "legacy") {
    return entry.clientIds.length > 0
      ? t("mcp.history.legacyFiles", { n: entry.clientIds.length })
      : t("mcp.history.legacy");
  }
  const vars = {
    clients: clientNames(entry.clientIds, t, clients),
    servers: joinNames(entry.serverNames, t),
    names: joinNames(entry.envVarNames, t)
  };
  const key = entry.clientIds.length > 0 ? `mcp.history.${entry.kind}` : `mcp.history.${entry.kind}.noClient`;
  const text = t(key, vars);
  return text === key ? t(`mcp.history.${entry.kind}`, vars) : text;
}

export function historyPartialText(entry: McpHistoryEntry, t: Translate, clients?: readonly McpClient[] | null): string {
  if (!entry.partial || entry.failedClientIds.length === 0) return "";
  return t("mcp.history.partial", { clients: clientNames(entry.failedClientIds, t, clients) });
}

// ---------- issues (contract §6.1) ----------

const ISSUE_PRIORITY: Record<McpIssue["kind"], number> = {
  "stuck-transaction": 0,
  "write-failed": 1,
  "client-unwritable": 2,
  "changed-outside": 3,
  "missing-secret": 4,
  "needs-inline-consent": 5,
  "interrupted": 6,
  "windows-fix": 7,
  "out-of-date": 8,
  unimported: 9
};

export function sortIssues(issues: readonly McpIssue[]): McpIssue[] {
  return [...issues].sort((a, b) => ISSUE_PRIORITY[a.kind] - ISSUE_PRIORITY[b.kind]);
}

export function issueText(issue: McpIssue, snapshot: McpLibrarySnapshot, t: Translate): string {
  const client = issue.clientId ? clientLabel(issue.clientId, snapshot.clients) : t("mcp.word.aiTool");
  const server = issue.serverName ?? snapshot.servers.find(row => row.id === issue.serverId)?.name ?? "";
  let reason = "";
  if (issue.kind === "client-unwritable" && issue.clientId) {
    const readonlyReason = snapshot.clients.find(item => item.id === issue.clientId)?.readonlyReason;
    reason = readonlyReason ? t(`mcp.reason.${readonlyReason}`, { client }) : "";
  }
  if (issue.kind === "write-failed" && issue.serverId && issue.clientId) {
    const row = snapshot.servers.find(item => item.id === issue.serverId);
    const cell = row ? cellFor(row, issue.clientId) : undefined;
    reason = cell?.errorMessage ?? "";
  }
  return t(`mcp.issue.${issue.kind}`, { client, server, n: issue.count ?? 0, reason: reason || t("mcp.issue.reasonUnknown") });
}

// ---------- test acknowledgement (contract §6.6) ----------

export function testAckKey(serverId: string, specRevision: number): string {
  return `${serverId}@${specRevision}`;
}

export function rememberAck(previous: readonly string[], key: string, limit = 200): string[] {
  const next = previous.filter(item => item !== key);
  next.push(key);
  return next.slice(-limit);
}
