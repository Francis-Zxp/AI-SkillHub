/* Browser-preview mock for the v3.3 MCP commands (docs/v3.3/mcp-contract.md §6.10).
   Loaded lazily through preview.ts, only when the desktop runtime is absent.
   It keeps no secret values: pasted or typed values become a "present" flag and are dropped. */

import type {
  McpCandidate,
  McpCell,
  McpCellReason,
  McpCellState,
  McpClient,
  McpClientId,
  McpClientResult,
  McpCommand,
  McpConfirmation,
  McpConfirmationItem,
  McpConfirmationKind,
  McpEntryPreview,
  McpError,
  McpErrorCode,
  McpExportResult,
  McpHistoryEntry,
  McpImportReport,
  McpIssue,
  McpLibraryChangedEvent,
  McpLibrarySnapshot,
  McpOperationKind,
  McpPasteFormat,
  McpPasteResult,
  McpProjectBinding,
  McpSecretInput,
  McpSecretStatus,
  McpServerDetail,
  McpServerInput,
  McpServerRow,
  McpServerSource,
  McpSkipReason,
  McpTargetSummary,
  McpTemplate,
  McpTestPreview,
  McpTestProgressEvent,
  McpTestResult,
  McpTestSummary,
  McpTransport,
  McpWriteOutcome
} from "./mcp/mcpTypes";
import { SECRET_MASK } from "./mcp/mcpTypes";
import { normalizeCommand, sanitizeServerName, validateEnvName, validateServerName } from "./mcp/mcpLogic";

type Unlisten = () => void;

const CLIENT_ORDER: McpClientId[] = ["codex", "claude-code", "claude-desktop", "cursor"];
const CLIENT_LABEL: Record<McpClientId, string> = {
  codex: "Codex",
  "claude-code": "Claude Code",
  "claude-desktop": "Claude Desktop",
  cursor: "Cursor"
};
const CLIENT_TRANSPORTS: Record<McpClientId, McpTransport[]> = {
  codex: ["stdio", "http"],
  "claude-code": ["stdio", "http", "sse"],
  "claude-desktop": ["stdio"],
  cursor: ["stdio", "http", "sse"]
};
const CLIENT_PATH: Record<McpClientId, string> = {
  codex: "~/.codex/config.toml",
  "claude-code": "~/.claude.json",
  "claude-desktop": "%APPDATA%/Claude/claude_desktop_config.json",
  cursor: "~/.cursor/mcp.json"
};

type MockSecret = {
  kind: "env" | "header";
  name: string;
  envVar: string | null;
  headerTemplate?: "raw" | "bearer";
  storage: McpSecretStatus["storage"];
  present: boolean;
  inlineClients: McpClientId[];
  createdBySkillHub: boolean;
  required: boolean;
};

type MockCell = {
  state: McpCellState;
  reason?: McpCellReason;
  errorMessage?: string;
  presentInFile: boolean;
  disabledInFile: boolean;
  outOfDate: boolean;
  windowsFixAvailable: boolean;
  projectCount: number;
  failuresLeft?: number;
};

type MockServer = {
  id: string;
  name: string;
  displayName: string;
  transport: McpTransport;
  command?: string;
  args: Array<{ value: string; masked: boolean }>;
  cwd?: string;
  url?: string;
  env: Array<{ name: string; value: string }>;
  secrets: MockSecret[];
  codexRequired: boolean;
  source: McpServerSource;
  meta: McpServerDetail["meta"];
  specRevision: number;
  test: McpTestSummary | null;
  cells: Record<McpClientId, MockCell>;
  projectBindings: McpProjectBinding[];
  updatedAt: string;
  deleted?: boolean;
};

type MockOperation = {
  id: string;
  at: string;
  kind: McpOperationKind;
  serverNames: string[];
  clientIds: McpClientId[];
  failedClientIds: McpClientId[];
  envVarNames: string[];
  before: MockServer[] | null;
  undone: boolean;
  touched: string[];
  legacySnapshotId?: string;
  expired?: boolean;
};

type MockState = {
  generation: number;
  initialized: boolean;
  servers: MockServer[];
  operations: MockOperation[];
  unimported: Array<{ clientId: McpClientId; name: string }>;
  restart: Set<McpClientId>;
  envCreated: Set<string>;
  confirmCounter: number;
  opCounter: number;
  pasteCounter: number;
};

let state: MockState | null = null;
const libraryListeners = new Set<(event: McpLibraryChangedEvent) => void>();
const progressListeners = new Set<(event: McpTestProgressEvent) => void>();
let callCounter = 0;

function now() {
  return new Date().toISOString();
}

function minutesAgo(minutes: number) {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function mcpError(code: McpErrorCode, message: string, extra: Partial<McpError> = {}): McpError {
  return { code, message, ...extra };
}

function cell(stateName: McpCellState, extra: Partial<MockCell> = {}): MockCell {
  const on = stateName === "on";
  return {
    state: stateName,
    presentInFile: on || stateName === "changed-outside",
    disabledInFile: false,
    outOfDate: false,
    windowsFixAvailable: false,
    projectCount: 0,
    ...extra
  };
}

function offCell(): MockCell {
  return cell("off");
}

function cellsFor(partial: Partial<Record<McpClientId, MockCell>>): Record<McpClientId, MockCell> {
  return {
    codex: partial.codex ?? offCell(),
    "claude-code": partial["claude-code"] ?? offCell(),
    "claude-desktop": partial["claude-desktop"] ?? offCell(),
    cursor: partial.cursor ?? offCell()
  };
}

function seed(): MockState {
  const servers: MockServer[] = [
    {
      id: "mcps-context7",
      name: "context7",
      displayName: "context7",
      transport: "stdio",
      command: "npx",
      args: [{ value: "-y", masked: false }, { value: "@upstash/context7-mcp", masked: false }],
      env: [],
      secrets: [{ kind: "env", name: "CONTEXT7_API_KEY", envVar: "CONTEXT7_API_KEY", storage: "user_env", present: true, inlineClients: [], createdBySkillHub: true, required: false }],
      codexRequired: false,
      source: { kind: "template", id: "context7" },
      meta: { description: "最新的库文档和代码示例", docsUrl: "https://github.com/upstash/context7", templateId: "context7" },
      specRevision: 3,
      test: { status: "ok", toolsCount: 2, testedAt: minutesAgo(90), stale: false, messageCode: "ok" },
      cells: cellsFor({ codex: cell("on"), "claude-code": cell("on") }),
      projectBindings: [],
      updatedAt: minutesAgo(120)
    },
    {
      id: "mcps-github",
      name: "github",
      displayName: "github",
      transport: "http",
      url: "https://api.githubcopilot.com/mcp/",
      args: [],
      env: [],
      secrets: [{ kind: "header", name: "Authorization", envVar: "GITHUB_PERSONAL_ACCESS_TOKEN", headerTemplate: "bearer", storage: "user_env", present: false, inlineClients: [], createdBySkillHub: false, required: true }],
      codexRequired: false,
      source: { kind: "template", id: "github" },
      meta: { description: "GitHub 官方远程 MCP", docsUrl: "https://github.com/github/github-mcp-server", templateId: "github" },
      specRevision: 1,
      test: null,
      cells: cellsFor({
        codex: cell("on"),
        "claude-code": cell("on", { projectCount: 1 }),
        "claude-desktop": cell("unsupported", { reason: "transport-unsupported" })
      }),
      projectBindings: [{ clientId: "claude-code", scope: "local", projectLabel: "paper-notes", workspaceId: "ws-paper-notes", state: "on" }],
      updatedAt: minutesAgo(300)
    },
    {
      id: "mcps-filesystem",
      name: "filesystem",
      displayName: "filesystem",
      transport: "stdio",
      command: "npx",
      args: [
        { value: "-y", masked: false },
        { value: "@modelcontextprotocol/server-filesystem", masked: false },
        { value: "~/Documents/notes", masked: false }
      ],
      env: [],
      secrets: [],
      codexRequired: false,
      source: { kind: "import", clientId: "claude-desktop", scope: "user" },
      meta: { templateId: "filesystem" },
      specRevision: 1,
      test: null,
      cells: cellsFor({
        codex: cell("error", { reason: "write-failed", errorMessage: "Codex 的配置文件暂时被占用，没有写入。", failuresLeft: 1 }),
        "claude-desktop": cell("on")
      }),
      projectBindings: [],
      updatedAt: minutesAgo(2000)
    },
    {
      id: "mcps-memory",
      name: "memory",
      displayName: "memory",
      transport: "stdio",
      command: "npx",
      args: [{ value: "-y", masked: false }, { value: "@modelcontextprotocol/server-memory", masked: false }],
      env: [],
      secrets: [],
      codexRequired: false,
      source: { kind: "import", clientId: "codex", scope: "user" },
      meta: { templateId: "memory" },
      specRevision: 1,
      test: { status: "ok", toolsCount: 9, testedAt: minutesAgo(3000), stale: false, messageCode: "ok" },
      cells: cellsFor({
        codex: cell("on"),
        "claude-code": cell("on", { windowsFixAvailable: true }),
        "claude-desktop": cell("on"),
        cursor: cell("on")
      }),
      projectBindings: [{ clientId: "codex", scope: "project", projectLabel: "AI_global_skills", workspaceId: "ws-skillhub", state: "readonly", readonlyReason: "not-registered" }],
      updatedAt: minutesAgo(4000)
    },
    {
      id: "mcps-origin",
      name: "origin",
      displayName: "origin",
      transport: "stdio",
      command: "~/AppData/Local/AI SkillHub/origin-mcp/Scripts/python.exe",
      args: [{ value: "-m", masked: false }, { value: "origin_mcp", masked: false }],
      env: [],
      secrets: [],
      codexRequired: false,
      source: { kind: "recipe", id: "origin-mcp" },
      meta: { description: "Origin/OriginPro 绘图", docsUrl: "https://github.com/Ge-Shun/origin-mcp" },
      specRevision: 2,
      test: null,
      cells: cellsFor({ codex: cell("changed-outside", { reason: "entry-edited-outside" }) }),
      projectBindings: [],
      updatedAt: minutesAgo(6000)
    },
    {
      id: "mcps-team-docs",
      name: "team.docs",
      displayName: "team.docs",
      transport: "stdio",
      command: "node",
      args: [{ value: "~/work/team-docs/server.js", masked: false }],
      env: [{ name: "DOCS_PORT", value: "8085" }],
      secrets: [],
      codexRequired: true,
      source: { kind: "import", clientId: "codex", scope: "user" },
      meta: {},
      specRevision: 1,
      test: null,
      cells: cellsFor({
        codex: cell("on"),
        "claude-code": cell("unsupported", { reason: "name-incompatible" }),
        "claude-desktop": cell("unsupported", { reason: "name-incompatible" }),
        cursor: cell("unsupported", { reason: "name-incompatible" })
      }),
      projectBindings: [],
      updatedAt: minutesAgo(8000)
    },
    {
      id: "mcps-fetch",
      name: "fetch",
      displayName: "fetch",
      transport: "stdio",
      command: "uvx",
      args: [{ value: "mcp-server-fetch", masked: false }],
      env: [],
      secrets: [],
      codexRequired: false,
      source: { kind: "template", id: "fetch" },
      meta: { templateId: "fetch" },
      specRevision: 1,
      test: null,
      cells: cellsFor({}),
      projectBindings: [],
      updatedAt: minutesAgo(9000)
    },
    {
      // Imported from Claude Code as "NOTION_TOKEN": "${NOTION_API_KEY}": the key lives in a variable
      // SkillHub did not create, under another name. Editing must keep that reference.
      id: "mcps-notion",
      name: "notion",
      displayName: "notion",
      transport: "stdio",
      command: "npx",
      args: [{ value: "-y", masked: false }, { value: "@notionhq/notion-mcp-server", masked: false }],
      env: [],
      secrets: [{ kind: "env", name: "NOTION_TOKEN", envVar: "NOTION_API_KEY", storage: "external", present: true, inlineClients: [], createdBySkillHub: false, required: true }],
      codexRequired: false,
      source: { kind: "import", clientId: "claude-code", scope: "user" },
      meta: {},
      specRevision: 1,
      test: null,
      cells: cellsFor({ "claude-code": cell("on"), "claude-desktop": cell("blocked", { reason: "needs-inline-consent" }) }),
      projectBindings: [],
      updatedAt: minutesAgo(9500)
    }
  ];
  const large = previewLargeCount();
  for (let index = 0; index < large; index += 1) {
    const name = `demo-${String(index + 1).padStart(3, "0")}`;
    servers.push({
      id: `mcps-${name}`,
      name,
      displayName: name,
      transport: "stdio",
      command: "npx",
      args: [{ value: "-y", masked: false }, { value: `@demo/${name}-mcp`, masked: false }],
      env: [],
      secrets: [],
      codexRequired: false,
      source: { kind: "manual" },
      meta: {},
      specRevision: 1,
      test: null,
      cells: cellsFor(index % 3 === 0 ? { codex: cell("on") } : {}),
      projectBindings: [],
      updatedAt: minutesAgo(10000 + index)
    });
  }
  const operations: MockOperation[] = [
    {
      id: "mcp-op-preview-1",
      at: minutesAgo(48),
      kind: "add",
      serverNames: ["context7"],
      clientIds: ["codex", "claude-code"],
      failedClientIds: [],
      envVarNames: [],
      before: null,
      undone: false,
      touched: ["context7:codex", "context7:claude-code"]
    },
    {
      id: "mcp-op-preview-2",
      at: minutesAgo(65),
      kind: "secret",
      serverNames: ["context7"],
      clientIds: [],
      failedClientIds: [],
      envVarNames: ["CONTEXT7_API_KEY"],
      before: null,
      undone: false,
      touched: ["context7:secret"]
    },
    {
      id: "mcp-op-preview-3",
      at: minutesAgo(26 * 60),
      kind: "add",
      serverNames: ["filesystem"],
      clientIds: ["codex", "claude-desktop"],
      failedClientIds: ["codex"],
      envVarNames: [],
      before: null,
      undone: false,
      touched: ["filesystem:claude-desktop"]
    },
    {
      id: "mcp-op-preview-4",
      at: minutesAgo(3 * 24 * 60),
      kind: "legacy",
      serverNames: [],
      clientIds: ["codex", "claude-code"],
      failedClientIds: [],
      envVarNames: [],
      before: null,
      undone: false,
      touched: [],
      legacySnapshotId: "legacy-preview-1"
    }
  ];
  return {
    generation: 1,
    initialized: previewFlag("mcpInitialized"),
    servers,
    operations,
    unimported: [{ clientId: "cursor", name: "sqlite" }],
    restart: new Set(),
    envCreated: new Set(["CONTEXT7_API_KEY"]),
    confirmCounter: 0,
    opCounter: 10,
    pasteCounter: 0
  };
}

function previewFlag(name: string): boolean {
  try {
    return new URLSearchParams(window.location.search).get(name) === "1";
  } catch {
    return false;
  }
}

function previewLargeCount(): number {
  try {
    const value = Number(new URLSearchParams(window.location.search).get("mcpLarge") ?? "0");
    return Number.isFinite(value) ? Math.max(0, Math.min(1000, Math.floor(value))) : 0;
  } catch {
    return 0;
  }
}

function db(): MockState {
  state ??= seed();
  return state;
}

function live(): MockServer[] {
  return db().servers.filter(server => !server.deleted);
}

function findServer(serverId: string): MockServer {
  const server = live().find(item => item.id === serverId);
  if (!server) throw mcpError("not-found", "没有找到这个 MCP。");
  return server;
}

// ---------- projection helpers ----------

function supportsTransport(clientId: McpClientId, transport: McpTransport) {
  return CLIENT_TRANSPORTS[clientId].includes(transport);
}

function unsupportedReason(server: Pick<MockServer, "name" | "transport">, clientId: McpClientId): McpCellReason | null {
  if (!supportsTransport(clientId, server.transport)) return "transport-unsupported";
  if (server.name.includes(".") && clientId !== "codex") return "name-incompatible";
  return null;
}

function needsInlineConsent(server: MockServer, clientId: McpClientId) {
  if (clientId !== "claude-desktop") return false;
  return server.secrets.some(secret => secret.storage !== "none" && !secret.inlineClients.includes(clientId) && secret.storage !== "library");
}

function fileStem(command: string) {
  return (command.split(/[\\/]/).pop() ?? "").replace(/\.(exe|cmd|bat)$/i, "");
}

function targetOf(server: Pick<MockServer, "transport" | "command" | "args" | "url">): McpTargetSummary {
  if (server.transport !== "stdio") {
    let host: string | null = null;
    try {
      host = server.url ? new URL(server.url).hostname.toLowerCase() : null;
    } catch {
      host = null;
    }
    return { runner: null, subject: null, extraArgCount: 0, host };
  }
  const runner = server.command ? fileStem(server.command).toLowerCase() : null;
  const values = server.args.map(arg => arg.value);
  let subject: string | null = null;
  let used = 0;
  if (runner && ["npx", "pnpx", "bunx", "uvx"].includes(runner)) {
    const index = values.findIndex(value => !value.startsWith("-"));
    if (index >= 0) {
      subject = values[index];
      used = index + 1;
    }
  } else if (runner && runner.startsWith("python") && values[0] === "-m" && values[1]) {
    subject = values[1];
    used = 2;
  } else if (runner === "node" && values[0]) {
    subject = values[0].split(/[\\/]/).pop() ?? null;
    used = 1;
  } else if (runner === "docker") {
    const image = [...values].reverse().find(value => !value.startsWith("-"));
    subject = image ?? null;
    used = values.length;
  } else if (values[0] && /[\\/]/.test(values[0])) {
    subject = values[0].split(/[\\/]/).pop() ?? null;
    used = 1;
  }
  return { runner, subject, extraArgCount: Math.max(0, values.length - used), host: null };
}

function targetDisplay(server: Pick<MockServer, "transport" | "command" | "args" | "url">) {
  const target = targetOf(server);
  if (target.host) return target.host;
  return [target.runner, target.subject].filter(Boolean).join(" · ");
}

function entryPreview(server: MockServer): McpEntryPreview {
  return {
    transport: server.transport,
    targetDisplay: targetDisplay(server),
    envNames: [...server.env.map(item => item.name), ...server.secrets.filter(item => item.kind === "env").map(item => item.name)],
    headerNames: server.secrets.filter(item => item.kind === "header").map(item => item.name),
    argCount: server.args.length
  };
}

function toRow(server: MockServer): McpServerRow {
  const cells: McpCell[] = CLIENT_ORDER.map(clientId => {
    const value = server.cells[clientId];
    return {
      clientId,
      state: value.state,
      reason: value.reason,
      errorMessage: value.errorMessage,
      presentInFile: value.presentInFile,
      disabledInFile: value.disabledInFile,
      outOfDate: value.outOfDate,
      windowsFixAvailable: value.windowsFixAvailable,
      projectCount: value.projectCount
    };
  });
  // As in the backend: every key without a value counts, optional ones too.
  const missingSecretCount = server.secrets.filter(secret => !secret.present).length;
  const issueCount = cells.filter(item => item.state === "error" || item.state === "changed-outside" || item.state === "blocked").length + missingSecretCount;
  return {
    id: server.id,
    name: server.name,
    displayName: server.displayName,
    transport: server.transport,
    target: targetOf(server),
    cells,
    projectBindings: clone(server.projectBindings),
    secrets: server.secrets.map(secretStatus),
    missingSecretCount,
    test: server.test ? { ...server.test } : null,
    source: clone(server.source),
    specRevision: server.specRevision,
    issueCount,
    updatedAt: server.updatedAt
  };
}

function secretStatus(secret: MockSecret): McpSecretStatus {
  return { ...secret, inlineClients: [...secret.inlineClients] };
}

function clients(): McpClient[] {
  const servers = live();
  return CLIENT_ORDER.map(id => ({
    id,
    label: CLIENT_LABEL[id],
    adapterId: id === "codex" ? "codex" : id === "cursor" ? "cursor" : "claude",
    detected: true,
    writable: true,
    configPathDisplay: CLIENT_PATH[id],
    transports: [...CLIENT_TRANSPORTS[id]],
    secretReference: id === "codex" ? "env-forward" : id === "claude-code" ? "dollar-brace" : id === "cursor" ? "env-colon" : "none",
    disableMode: id === "codex" ? "flag" : "remove",
    enabledCount: servers.filter(server => server.cells[id].state === "on").length,
    restartNeeded: db().restart.has(id)
  }));
}

function issues(): McpIssue[] {
  const list: McpIssue[] = [];
  for (const server of live()) {
    for (const clientId of CLIENT_ORDER) {
      const value = server.cells[clientId];
      if (value.state === "error") list.push({ id: `wf-${server.id}-${clientId}`, kind: "write-failed", clientId, serverId: server.id, serverName: server.name, action: "retry" });
      if (value.state === "changed-outside") list.push({ id: `co-${server.id}-${clientId}`, kind: "changed-outside", clientId, serverId: server.id, serverName: server.name, action: "review-change" });
      if (value.state === "blocked" && value.reason === "needs-inline-consent") list.push({ id: `ic-${server.id}-${clientId}`, kind: "needs-inline-consent", clientId, serverId: server.id, serverName: server.name, action: "allow-inline" });
      if (value.windowsFixAvailable) list.push({ id: `wx-${server.id}-${clientId}`, kind: "windows-fix", clientId, serverId: server.id, serverName: server.name, action: "resync" });
      if (value.outOfDate) list.push({ id: `od-${server.id}-${clientId}`, kind: "out-of-date", clientId, serverId: server.id, serverName: server.name, action: "resync" });
    }
    if (server.secrets.some(secret => !secret.present)) {
      list.push({ id: `ms-${server.id}`, kind: "missing-secret", serverId: server.id, serverName: server.name, action: "fill-secret" });
    }
  }
  if (db().unimported.length > 0) {
    list.push({ id: "unimported", kind: "unimported", count: db().unimported.length, action: "import" });
  }
  return list;
}

function snapshot(): McpLibrarySnapshot {
  const current = db();
  return {
    generation: current.generation,
    generatedAt: now(),
    libraryInitialized: current.initialized,
    clients: clients(),
    otherClients: [{ adapterId: "gemini-cli", label: "Gemini CLI" }],
    servers: live().map(toRow).sort((a, b) => a.displayName.localeCompare(b.displayName, undefined, { sensitivity: "base" })),
    issues: issues(),
    unimported: clone(current.unimported),
    stuckTransactions: []
  };
}

function detail(server: MockServer): McpServerDetail {
  const row = toRow(server);
  return {
    id: server.id,
    name: server.name,
    displayName: server.displayName,
    transport: server.transport,
    command: server.command,
    args: server.args.map(arg => ({ value: arg.masked ? SECRET_MASK : arg.value, masked: arg.masked })),
    cwd: server.cwd,
    url: server.url,
    env: clone(server.env),
    secrets: row.secrets,
    codexRequired: server.codexRequired,
    source: clone(server.source),
    meta: clone(server.meta),
    specRevision: server.specRevision,
    cells: row.cells,
    projectBindings: row.projectBindings,
    test: row.test
  };
}

// ---------- operations ----------

function emit(reason: McpLibraryChangedEvent["reason"], operationId: string | null) {
  const event: McpLibraryChangedEvent = { generation: db().generation, operationId, reason };
  window.setTimeout(() => {
    for (const listener of libraryListeners) listener(event);
  }, 0);
}

/** Like the backend's request digest: everything the caller sent except the token itself. */
function requestDigest(request: unknown): string {
  const copy = { ...((request ?? {}) as Record<string, unknown>) };
  delete copy.confirmToken;
  const text = JSON.stringify(copy);
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) hash = (Math.imul(hash, 31) + text.charCodeAt(index)) | 0;
  return (hash >>> 0).toString(36);
}

// Tokens are bound to the request, as in mcp_library.rs: a confirmed call that changes anything
// (for example the env vars ticked in the dialog) gets a fresh confirmation instead of a write.
function nextConfirm(request: unknown, kinds: McpConfirmationKind[], items: McpConfirmationItem[], extra: Partial<McpConfirmation> = {}): McpWriteOutcome {
  const current = db();
  current.confirmCounter += 1;
  return {
    kind: "needs-confirmation",
    confirmation: { kinds, confirmToken: `preview-confirm-${current.confirmCounter}-${requestDigest(request)}`, items, undoable: true, ...extra }
  };
}

function tokenOk(request: { confirmToken?: string }) {
  const token = request.confirmToken;
  return typeof token === "string" && token.startsWith("preview-confirm-") && token.endsWith(`-${requestDigest(request)}`);
}

function beginOperation(kind: McpOperationKind, serverNames: string[], touched: string[]): MockOperation {
  const current = db();
  current.opCounter += 1;
  const operation: MockOperation = {
    id: `mcp-op-preview-${current.opCounter}`,
    at: now(),
    kind,
    serverNames,
    clientIds: [],
    failedClientIds: [],
    envVarNames: [],
    before: clone(current.servers),
    undone: false,
    touched
  };
  return operation;
}

function finishOperation(operation: MockOperation, results: McpClientResult[], reason: McpLibraryChangedEvent["reason"] = "write"): McpWriteOutcome {
  const current = db();
  operation.clientIds = unique(results.filter(result => result.status !== "skipped").map(result => result.clientId));
  operation.failedClientIds = unique(results.filter(result => result.status === "failed").map(result => result.clientId));
  current.operations.unshift(operation);
  current.generation += 1;
  for (const result of results) if (result.status === "written" || result.status === "undone") current.restart.add(result.clientId);
  emit(reason, operation.id);
  return {
    kind: "done",
    operationId: operation.id,
    undoToken: operation.id,
    summary: {
      kind: operation.kind,
      serverNames: [...operation.serverNames],
      clientIds: [...operation.clientIds],
      failedClientIds: [...operation.failedClientIds],
      envVarNames: [...operation.envVarNames]
    },
    results,
    generation: current.generation
  };
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function result(clientId: McpClientId, serverIds: string[], status: McpClientResult["status"], extra: Partial<McpClientResult> = {}): McpClientResult {
  return { clientId, scope: "user", serverIds, status, restartHint: status === "written" || status === "undone", ...extra };
}

/** Applies one desired state to one cell; returns the per-client result. */
function applyCell(server: MockServer, clientId: McpClientId, enabled: boolean, allowInline = false): McpClientResult {
  const value = server.cells[clientId];
  const unsupported = unsupportedReason(server, clientId);
  if (unsupported) {
    server.cells[clientId] = cell("unsupported", { reason: unsupported });
    return result(clientId, [server.id], "skipped", { skippedReason: unsupported });
  }
  if (enabled && needsInlineConsent(server, clientId) && !allowInline) {
    server.cells[clientId] = cell("blocked", { reason: "needs-inline-consent" });
    return result(clientId, [server.id], "skipped", { skippedReason: "needs-inline-consent" });
  }
  if (enabled && allowInline) {
    for (const secret of server.secrets) if (!secret.inlineClients.includes(clientId)) secret.inlineClients.push(clientId);
  }
  if (value.failuresLeft && value.failuresLeft > 0) {
    value.failuresLeft -= 1;
    value.state = "error";
    value.reason = "write-failed";
    value.errorMessage = "Codex 的配置文件暂时被占用，没有写入。";
    return result(clientId, [server.id], "failed", {
      error: mcpError("config-changed", "Codex 正在改写自己的配置，稍后点按重试。", { clientId })
    });
  }
  const wasOn = value.state === "on";
  if (enabled) {
    server.cells[clientId] = cell("on", { projectCount: value.projectCount });
  } else {
    server.cells[clientId] = cell("off", {
      projectCount: value.projectCount,
      presentInFile: clientId === "codex",
      disabledInFile: clientId === "codex"
    });
  }
  server.updatedAt = now();
  return result(clientId, [server.id], wasOn === enabled && value.state !== "error" ? "unchanged" : "written");
}

function setCell(request: { serverId: string; clientId: McpClientId; enabled: boolean; allowInline?: boolean; confirmToken?: string }): McpWriteOutcome {
  const server = findServer(request.serverId);
  const value = server.cells[request.clientId];
  if (value.state === "unsupported" || value.state === "readonly") return { kind: "noop", reason: "nothing-selected" };
  if (value.state === "changed-outside" && !tokenOk(request)) {
    return nextConfirm(request, ["changed-outside"], [confirmItem(server, request.clientId, request.enabled ? "update" : "disable")]);
  }
  const consented = Boolean(request.allowInline) || tokenOk(request);
  if (request.enabled && needsInlineConsent(server, request.clientId) && !consented) {
    return nextConfirm(request, ["inline-secret"], [confirmItem(server, request.clientId, "enable")]);
  }
  if (request.enabled && value.state === "on") return { kind: "noop", reason: "already-in-state" };
  if (!request.enabled && value.state === "off") return { kind: "noop", reason: "already-in-state" };
  const operation = beginOperation(request.enabled ? "enable" : "disable", [server.name], [`${server.name}:${request.clientId}`]);
  const outcome = applyCell(server, request.clientId, request.enabled, consented);
  return finishOperation(operation, [outcome]);
}

function confirmItem(server: MockServer, clientId: McpClientId, action: McpConfirmationItem["action"], before?: McpEntryPreview): McpConfirmationItem {
  return {
    clientId,
    clientLabel: CLIENT_LABEL[clientId],
    scope: "user",
    serverName: server.name,
    action,
    before: before ?? (server.cells[clientId].presentInFile ? { ...entryPreview(server), targetDisplay: server.name === "origin" ? "python · origin_mcp · +1 个参数" : entryPreview(server).targetDisplay } : undefined),
    after: action === "remove" || action === "disable" ? undefined : entryPreview(server),
    changedFields: action === "remove" ? [] : server.name === "origin" ? ["command", "args"] : action === "enable" ? ["env"] : ["command"]
  };
}

function setColumn(request: { clientId: McpClientId; enabled: boolean; serverIds?: string[]; confirmToken?: string }): McpWriteOutcome {
  const scope = live().filter(server => !request.serverIds || request.serverIds.includes(server.id));
  const targets = scope.filter(server => {
    const value = server.cells[request.clientId];
    if (request.enabled) return value.state === "off" || value.state === "error";
    return value.state === "on";
  });
  if (targets.length === 0) return { kind: "noop", reason: "nothing-selected" };
  const operation = beginOperation(request.enabled ? "enable" : "disable", targets.map(server => server.name), targets.map(server => `${server.name}:${request.clientId}`));
  const outcomes = targets.map(server => applyCell(server, request.clientId, request.enabled));
  const ok = outcomes.filter(item => item.status !== "failed");
  const failed = outcomes.filter(item => item.status === "failed");
  const results: McpClientResult[] = [];
  if (ok.length > 0) results.push(result(request.clientId, ok.flatMap(item => item.serverIds), "written"));
  if (failed.length > 0) results.push({ ...failed[0], serverIds: failed.flatMap(item => item.serverIds) });
  operation.serverNames = targets.filter(server => ok.some(item => item.serverIds.includes(server.id))).map(server => server.name);
  return finishOperation(operation, results);
}

function setRow(request: { serverId: string; enabled: boolean; clientIds?: McpClientId[]; confirmToken?: string }): McpWriteOutcome {
  const server = findServer(request.serverId);
  const ids = (request.clientIds ?? CLIENT_ORDER).filter(clientId => {
    const value = server.cells[clientId];
    if (value.state === "unsupported" || value.state === "readonly") return false;
    return request.enabled ? value.state !== "on" : value.state === "on" || value.state === "changed-outside";
  });
  if (ids.length === 0) return { kind: "noop", reason: "already-in-state" };
  const outside = ids.filter(clientId => server.cells[clientId].state === "changed-outside");
  if (outside.length > 0 && !tokenOk(request)) {
    return nextConfirm(request, ["changed-outside"], outside.map(clientId => confirmItem(server, clientId, request.enabled ? "update" : "disable")));
  }
  const operation = beginOperation(request.enabled ? "enable" : "disable", [server.name], ids.map(clientId => `${server.name}:${clientId}`));
  const results = ids.map(clientId => applyCell(server, clientId, request.enabled));
  return finishOperation(operation, results);
}

// ---------- paste ----------

function stripJsonc(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === "/" && next === "/") {
      while (index < text.length && text[index] !== "\n") index += 1;
      out += "\n";
      continue;
    }
    if (char === "/" && next === "*") {
      index += 2;
      while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) index += 1;
      index += 1;
      continue;
    }
    out += char;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

function stripFence(text: string) {
  const trimmed = text.replace(/^\uFEFF/, "").trim();
  const fence = trimmed.match(/^```[^\n]*\n([\s\S]*?)\n?```\s*$/);
  return fence ? fence[1] : trimmed;
}

type RawServer = Record<string, unknown>;

const SECRET_NAME = /TOKEN|SECRET|PASSWORD|PASSWD|KEY|PAT|AUTH|CREDENTIAL|COOKIE|SESSION/i;
const SECRET_PREFIX = /^(?:sk-|ghp_|gho_|ghs_|ghu_|github_pat_|xox[baprs]-|AIza|AKIA|eyJ)/;

function placeholderVar(value: string): { placeholder: boolean; envVar: string | null } {
  const text = value.trim();
  const brace = text.match(/^\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}$/);
  if (brace) return { placeholder: true, envVar: brace[1] };
  const bearer = text.match(/^Bearer\s+\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)\}$/i);
  if (bearer) return { placeholder: true, envVar: bearer[1] };
  const dollar = text.match(/^\$([A-Za-z_][A-Za-z0-9_]*)$/);
  if (dollar) return { placeholder: true, envVar: dollar[1] };
  if (/^\$\{input:[^}]+\}$/.test(text)) return { placeholder: true, envVar: null };
  if (!text || /^<.*>$/.test(text) || /^YOUR_/i.test(text) || /^your-/i.test(text) || /^x{3,}/i.test(text) || /_HERE$/i.test(text) || /^Bearer\s+(?:<.*>|YOUR_.*|\$\{input:.*\})$/i.test(text)) {
    return { placeholder: true, envVar: null };
  }
  return { placeholder: false, envVar: null };
}

function suggestName(input: { command?: string; args?: string[]; url?: string }): string {
  if (input.url) {
    try {
      const parts = new URL(input.url).hostname.split(".");
      return sanitizeServerName(parts.length >= 2 ? parts[parts.length - 2] : parts[0]);
    } catch {
      return "remote";
    }
  }
  let base = ((input.args ?? []).find(arg => !arg.startsWith("-")) ?? input.command ?? "server").replace(/@(?:latest|[\d.]+)$/, "");
  const scoped = base.match(/^@([^/]+)\/(.+)$/);
  if (scoped) base = scoped[2] === "mcp" ? scoped[1] : scoped[2];
  base = base.split(/[\\/]/).pop() ?? base;
  base = base.replace(/^server-/, "").replace(/^mcp-server-|-mcp-server$|-mcp$|^mcp-/g, "");
  return sanitizeServerName(base) || "server";
}

function candidateFrom(name: string | null, raw: RawServer, format: McpPasteFormat, key: string, skipped: McpPasteResult["skipped"], vault: { used: boolean }, renamed = false): McpCandidate | null {
  let command: string | undefined;
  let args: string[] = [];
  let url: string | undefined;
  let transport: McpTransport = "stdio";
  const warnings: McpCandidate["warnings"] = [];
  const typeValue = typeof raw.type === "string" ? raw.type.toLowerCase() : "";
  if (format === "opencode") {
    if (Array.isArray(raw.command)) {
      command = String(raw.command[0] ?? "");
      args = raw.command.slice(1).map(String);
    }
    if (typeValue === "remote") transport = "http";
  } else {
    if (Array.isArray(raw.command)) {
      command = String(raw.command[0] ?? "");
      args = raw.command.slice(1).map(String);
    } else if (typeof raw.command === "string") {
      command = raw.command;
    }
    if (Array.isArray(raw.args)) args = [...args, ...raw.args.map(String)];
  }
  if (typeof raw.url === "string") url = raw.url;
  if (typeof raw.serverUrl === "string") url = raw.serverUrl;
  if (typeValue === "sse") transport = "sse";
  else if (["http", "streamable-http", "streamablehttp", "remote"].includes(typeValue)) transport = "http";
  else if (!typeValue && url && !command) transport = "http";
  const label = name ?? suggestName({ command, args, url });
  if (transport === "stdio") {
    if (!command) {
      skipped.push({ name: label, reason: "unknown-type" });
      return null;
    }
    const checked = normalizeCommand(command, args);
    if (checked.kind === "shell") {
      skipped.push({ name: label, reason: "shell-command" });
      return null;
    }
    if (checked.unwrapped) warnings.push("windows-cmd-unwrapped");
    command = checked.command;
    args = checked.args;
    if (args.some((arg, index) => SECRET_PREFIX.test(arg.split("=").pop() ?? "") || (/^--?(?:api[-_]?key|token|secret|password)$/i.test(arg) && args[index + 1]))) {
      skipped.push({ name: label, reason: "secret-in-args" });
      return null;
    }
    if (args.length > 64) {
      skipped.push({ name: label, reason: "too-many-args" });
      return null;
    }
    if (command.toLowerCase() === "docker") warnings.push("docker-needs-running");
    if (args.some(arg => /\/path\/to|<path>|\{path\}/i.test(arg))) warnings.push("needs-folder-path");
  } else if (!url || !/^https?:\/\//i.test(url) || /[?#]/.test(url)) {
    skipped.push({ name: label, reason: "invalid-url" });
    return null;
  }

  const env: Array<{ name: string; value: string }> = [];
  const secrets: McpSecretInput[] = [];
  const secretView: McpCandidate["secrets"] = [];
  const envSource = (format === "opencode" ? raw.environment : raw.env) as Record<string, unknown> | undefined;
  if (envSource && typeof envSource === "object" && !Array.isArray(envSource)) {
    for (const [envName, envValue] of Object.entries(envSource)) {
      const text = String(envValue ?? "");
      const holder = placeholderVar(text);
      const secretLike = SECRET_NAME.test(envName) || SECRET_PREFIX.test(text);
      if (holder.placeholder) {
        secrets.push({ kind: "env", name: envName, mode: "user_env", required: true });
        secretView.push({ kind: "env", name: envName, envVar: holder.envVar ?? envName, hasPastedValue: false, placeholder: true });
      } else if (secretLike) {
        vault.used = true;
        db().pasteCounter += 1;
        secrets.push({ kind: "env", name: envName, mode: "user_env", required: true, pasteValueHandle: `preview-vault-${db().pasteCounter}` });
        secretView.push({ kind: "env", name: envName, envVar: envName, hasPastedValue: true, placeholder: false });
      } else {
        env.push({ name: envName, value: text });
      }
    }
  }
  const headerSource = (raw.headers ?? raw.http_headers) as Record<string, unknown> | undefined;
  if (transport !== "stdio" && headerSource && typeof headerSource === "object") {
    for (const [headerName, headerValue] of Object.entries(headerSource)) {
      const text = String(headerValue ?? "");
      const holder = placeholderVar(text);
      const bearer = /^Bearer\s/i.test(text);
      const envVar = holder.envVar ?? `${sanitizeServerName(label).replace(/-/g, "_").toUpperCase()}_${headerName.toLowerCase() === "authorization" ? "TOKEN" : headerName.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase()}`;
      if (holder.placeholder) {
        secrets.push({ kind: "header", name: headerName, envVar, headerTemplate: bearer ? "bearer" : "raw", mode: "user_env", required: true });
        secretView.push({ kind: "header", name: headerName, envVar, hasPastedValue: false, placeholder: true });
      } else {
        vault.used = true;
        db().pasteCounter += 1;
        secrets.push({ kind: "header", name: headerName, envVar, headerTemplate: bearer ? "bearer" : "raw", mode: "user_env", required: true, pasteValueHandle: `preview-vault-${db().pasteCounter}` });
        secretView.push({ kind: "header", name: headerName, envVar, hasPastedValue: true, placeholder: false });
      }
    }
  }
  const input: McpServerInput = {
    name: label,
    transport,
    command: transport === "stdio" ? command : undefined,
    args: transport === "stdio" ? args : undefined,
    url: transport === "stdio" ? undefined : url,
    env: transport === "stdio" ? env : undefined,
    secrets,
    source: { kind: "paste", format }
  };
  const existing = live().find(server => server.name.toLowerCase() === label.toLowerCase());
  let exists: McpCandidate["exists"] = "new";
  let differsIn: McpClientId[] = [];
  if (existing) {
    const same = existing.transport === transport && (existing.command ?? "") === (input.command ?? "") &&
      existing.args.map(arg => arg.value).join("\u0000") === (input.args ?? []).join("\u0000") && (existing.url ?? "") === (input.url ?? "");
    exists = same ? "same" : "different";
    differsIn = same ? [] : CLIENT_ORDER.filter(clientId => existing.cells[clientId].presentInFile);
  } else {
    // Not in the list, but an AI tool's file already has this name (compared with client files too).
    differsIn = db().unimported.filter(entry => entry.name.toLowerCase() === label.toLowerCase()).map(entry => entry.clientId);
    if (differsIn.length > 0) exists = "different";
  }
  return {
    key,
    name: label,
    nameSuggested: name === null || renamed,
    nameValid: validateServerName(label) === null,
    input,
    targetDisplay: targetDisplay({ transport, command, args: args.map(value => ({ value, masked: false })), url }),
    exists,
    existingServerId: existing?.id,
    differsIn,
    secrets: secretView,
    warnings,
    variants: []
  };
}

function parseTomlServers(text: string): Array<{ name: string; raw: RawServer }> {
  const servers = new Map<string, RawServer>();
  let current: RawServer | null = null;
  let sub: Record<string, unknown> | null = null;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const table = trimmed.match(/^\[mcp_servers\.("?)([^\]"]+)\1(?:\.(env|http_headers|env_http_headers))?\]$/);
    if (table) {
      const name = table[2];
      current = servers.get(name) ?? {};
      servers.set(name, current);
      if (table[3]) {
        const key = table[3] === "http_headers" ? "headers" : table[3];
        sub = (current[key] as Record<string, unknown>) ?? {};
        current[key] = sub;
      } else {
        sub = null;
      }
      continue;
    }
    if (trimmed.startsWith("[")) {
      current = null;
      sub = null;
      continue;
    }
    if (!current) continue;
    const pair = trimmed.match(/^([A-Za-z0-9_."-]+)\s*=\s*(.+)$/);
    if (!pair) continue;
    const key = pair[1].replace(/^"|"$/g, "");
    let value: unknown;
    try {
      value = JSON.parse(pair[2].replace(/'/g, '"').replace(/^\{(.*)\}$/, (_all, body: string) => `{${body.replace(/([A-Za-z0-9_-]+)\s*=/g, '"$1":')}}`));
    } catch {
      value = pair[2].replace(/^"|"$/g, "");
    }
    if (sub) sub[key] = value;
    else current[key === "http_headers" ? "headers" : key] = value;
  }
  return [...servers.entries()].map(([name, raw]) => ({ name, raw }));
}

function parsePaste(text: string): McpPasteResult {
  if (text.length > 256 * 1024) throw mcpError("paste-too-large", "粘贴的内容超过 256 KB。");
  const body = stripFence(text);
  const skipped: McpPasteResult["skipped"] = [];
  const vault = { used: false };
  let format: McpPasteFormat | "unrecognized" = "unrecognized";
  let entries: Array<{ name: string | null; raw: RawServer }> = [];
  if (/^\s*\[mcp_servers\./m.test(body)) {
    format = "codex-toml";
    entries = parseTomlServers(body);
  } else {
    let value: unknown = null;
    const cleaned = stripJsonc(body);
    try {
      value = JSON.parse(cleaned);
    } catch {
      try {
        value = JSON.parse(`{${cleaned}}`);
      } catch {
        value = null;
      }
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      const objectEntries = (map: unknown) =>
        map && typeof map === "object" && !Array.isArray(map) ? Object.entries(map as Record<string, RawServer>).map(([name, raw]) => ({ name, raw })) : [];
      const mcp = record.mcp as Record<string, unknown> | undefined;
      if (record.mcpServers) {
        format = "mcp-servers";
        entries = objectEntries(record.mcpServers);
      } else if (record.servers || (mcp && typeof mcp === "object" && "servers" in mcp)) {
        format = "vscode";
        entries = objectEntries(record.servers ?? mcp?.servers);
      } else if (mcp && typeof mcp === "object" && Object.values(mcp).some(item => item && typeof item === "object" && ["local", "remote"].includes(String((item as RawServer).type)))) {
        format = "opencode";
        entries = objectEntries(mcp);
      } else if (record.mcp_servers) {
        format = "codex-json";
        entries = objectEntries(record.mcp_servers);
      } else if ("command" in record || "url" in record) {
        format = "single";
        entries = [{ name: null, raw: record }];
      } else if (Object.values(record).length > 0 && Object.values(record).every(item => item && typeof item === "object" && ("command" in (item as object) || "url" in (item as object)))) {
        format = "named";
        entries = objectEntries(record);
      }
    }
  }
  if (format === "unrecognized") return { format, pasteHandle: null, candidates: [], skipped: [], notices: [] };
  const candidates: McpCandidate[] = [];
  entries.slice(0, 24).forEach((entry, index) => {
    // As mcp_paste::normalize_name: an invalid name ("team.docs") becomes a suggested one ("team-docs").
    let name = entry.name;
    let renamed = false;
    if (name !== null && validateServerName(name) !== null) {
      const sanitized = sanitizeServerName(name);
      if (validateServerName(sanitized) !== null) {
        skipped.push({ name, reason: "invalid-name" });
        return;
      }
      name = sanitized;
      renamed = true;
    }
    const candidate = candidateFrom(name, entry.raw, format as McpPasteFormat, `c${index}`, skipped, vault, renamed);
    if (candidate) candidates.push(candidate);
  });
  return {
    format,
    pasteHandle: vault.used ? `preview-paste-${db().pasteCounter}` : null,
    candidates,
    skipped,
    notices: []
  };
}

const GITHUB_SAMPLES: Record<string, { text: string; source: string; notices?: McpPasteResult["notices"] }> = {
  "upstash/context7": {
    source: "github.com/upstash/context7/README.md",
    text: JSON.stringify({ mcpServers: { context7: { command: "npx", args: ["-y", "@upstash/context7-mcp"], env: { CONTEXT7_API_KEY: "YOUR_API_KEY" } } } })
  },
  "microsoft/playwright-mcp": {
    source: "github.com/microsoft/playwright-mcp/README.md",
    text: JSON.stringify({ mcpServers: { playwright: { command: "npx", args: ["@playwright/mcp@latest"] } } })
  },
  "github/github-mcp-server": {
    source: "github.com/github/github-mcp-server/README.md",
    text: JSON.stringify({ mcpServers: { github: { type: "http", url: "https://api.githubcopilot.com/mcp/", headers: { Authorization: "Bearer ${input:github_mcp_pat}" } } } })
  },
  "modelcontextprotocol/servers": {
    source: "github.com/modelcontextprotocol/servers/src/memory/README.md",
    text: JSON.stringify({ mcpServers: { memory: { command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"] } } })
  },
  "ge-shun/origin-mcp": {
    source: "github.com/Ge-Shun/origin-mcp/README.md",
    text: JSON.stringify({ mcpServers: { origin: { command: "python", args: ["-m", "origin_mcp"] } } }),
    notices: ["has-verified-recipe", "readme-example"]
  }
};

function importGithub(source: string): McpPasteResult {
  const value = source.trim().replace(/\.git$/i, "").replace(/\/+$/, "");
  const match = value.match(/^(?:https:\/\/github\.com\/)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\/(?:tree|blob)\/[^?#\s]+)?$/i);
  if (!match || /[?#@\\]/.test(value)) {
    throw mcpError("github-invalid-source", "请填写 owner/repo 或 https://github.com/owner/repo。");
  }
  const key = `${match[1]}/${match[2]}`.toLowerCase();
  const sample = GITHUB_SAMPLES[key];
  if (!sample) throw mcpError("github-not-found", "这个仓库里没有找到 MCP 配置示例。");
  const parsed = parsePaste(sample.text);
  if (key === "microsoft/playwright-mcp" && parsed.candidates[0]) {
    parsed.candidates[0].variants = [
      { key: "v0", targetDisplay: "npx · @playwright/mcp@latest", preferred: true },
      { key: "v1", targetDisplay: "docker · mcr.microsoft.com/playwright/mcp", preferred: false }
    ];
  }
  for (const candidate of parsed.candidates) candidate.input.source = { kind: "github", repo: `${match[1]}/${match[2]}` };
  return { ...parsed, format: "readme", sourceDisplay: sample.source, notices: sample.notices ?? ["readme-example"] };
}

// ---------- add / update / remove ----------

function serverFromInput(input: McpServerInput, id: string): MockServer {
  const secrets: MockSecret[] = (input.secrets ?? []).map(secret => ({
    kind: secret.kind,
    name: secret.name,
    envVar: secret.kind === "header" ? secret.envVar ?? null : secret.mode === "inline" ? null : secret.envVar ?? secret.name,
    headerTemplate: secret.kind === "header" ? secret.headerTemplate ?? "raw" : undefined,
    storage: secret.mode === "inline" ? "library" : "user_env",
    present: Boolean((secret.value && secret.value.trim()) || secret.pasteValueHandle),
    inlineClients: [...(secret.inlineClients ?? [])],
    createdBySkillHub: true,
    required: secret.required ?? true
  }));
  return {
    id,
    name: input.name,
    displayName: input.displayName || input.name,
    transport: input.transport,
    command: input.transport === "stdio" ? input.command : undefined,
    args: input.transport === "stdio" ? (input.args ?? []).map(value => ({ value, masked: false })) : [],
    cwd: input.transport === "stdio" ? input.cwd : undefined,
    url: input.transport === "stdio" ? undefined : input.url,
    env: input.transport === "stdio" ? [...(input.env ?? [])] : [],
    secrets,
    codexRequired: Boolean(input.codexRequired),
    source: clone(input.source),
    meta: input.source.kind === "template" ? { templateId: input.source.id } : {},
    specRevision: 1,
    test: null,
    cells: cellsFor({}),
    projectBindings: [],
    updatedAt: now()
  };
}

function validateInput(input: McpServerInput): void {
  if (input.transport === "stdio") {
    if (!input.command?.trim()) throw mcpError("invalid-input", "本地命令不能为空。");
    if (normalizeCommand(input.command, input.args ?? []).kind === "shell") throw mcpError("invalid-input", "不能用 cmd、PowerShell 之类的命令行程序直接启动。");
  } else if (!input.url || !/^https?:\/\/[^\s?#]+$/i.test(input.url)) {
    throw mcpError("invalid-input", "远程地址需要以 http(s):// 开头，不能带 ? 或 #。");
  }
  for (const secret of input.secrets ?? []) {
    if (secret.kind === "env" && validateEnvName(secret.name) === "reserved") throw mcpError("secret-name-reserved", `${secret.name} 是系统变量名，不能用来保存密钥。`, { params: { name: secret.name } });
    if (secret.value !== undefined && /[\r\n\0]/.test(secret.value)) throw mcpError("secret-value-invalid", "密钥里不能有换行。");
  }
}

/**
 * Same conflict rules as mcp_library::add_servers:
 * - a same-name library server needs onConflict: "skip" leaves it untouched (nothing written for it),
 *   "overwrite" replaces it, missing → name-taken;
 * - a different same-name entry only in a client file (here: `unimported`): "skip" skips that client,
 *   "overwrite" replaces it, missing → a plain-language overwrite-different confirmation.
 */
function addServers(request: { candidates: Array<{ input: McpServerInput; onConflict?: "skip" | "overwrite" }>; clientIds: McpClientId[]; confirmToken?: string; pasteHandle?: string }): McpWriteOutcome {
  if (request.candidates.length === 0) return { kind: "noop", reason: "nothing-selected" };
  const conflicts: McpConfirmationItem[] = [];
  for (const candidate of request.candidates) {
    validateInput(candidate.input);
    const problem = validateServerName(candidate.input.name);
    if (problem && problem !== "taken") throw mcpError("invalid-name", "名称只能用字母、数字、下划线或短横线，最长 64 个字符，并以字母或数字开头。", { params: { name: candidate.input.name } });
    const existing = live().find(server => server.name.toLowerCase() === candidate.input.name.toLowerCase());
    if (existing && !candidate.onConflict) throw mcpError("name-taken", `已经有一个叫 ${candidate.input.name} 的 MCP。`, { params: { name: candidate.input.name } });
    if (!existing && !candidate.onConflict) {
      for (const entry of db().unimported) {
        if (entry.name.toLowerCase() !== candidate.input.name.toLowerCase() || !request.clientIds.includes(entry.clientId)) continue;
        const draft = serverFromInput(candidate.input, "draft");
        conflicts.push({
          clientId: entry.clientId,
          clientLabel: CLIENT_LABEL[entry.clientId],
          scope: "user",
          serverName: candidate.input.name,
          action: "update",
          before: { transport: "stdio", targetDisplay: "uvx · mcp-server-sqlite · +2 个参数", envNames: [], headerNames: [], argCount: 3 },
          after: entryPreview(draft),
          changedFields: ["command", "args"]
        });
      }
    }
  }
  if (conflicts.length > 0 && !tokenOk(request)) return nextConfirm(request, ["overwrite-different"], conflicts);
  const operation = beginOperation("add", [], []);
  const added: MockServer[] = [];
  const results: McpClientResult[] = [];
  const skipFile = new Map<string, McpClientId[]>();
  for (const candidate of request.candidates) {
    const existing = live().find(server => server.name.toLowerCase() === candidate.input.name.toLowerCase());
    if (existing && candidate.onConflict === "skip") {
      for (const clientId of request.clientIds) results.push(result(clientId, [existing.id], "skipped", { skippedReason: "entry-added-outside" }));
      continue;
    }
    if (candidate.onConflict === "skip") {
      skipFile.set(candidate.input.name.toLowerCase(), db().unimported.filter(entry => entry.name.toLowerCase() === candidate.input.name.toLowerCase()).map(entry => entry.clientId));
    }
    if (existing) {
      const replacement = serverFromInput(candidate.input, existing.id);
      replacement.cells = existing.cells;
      replacement.specRevision = existing.specRevision + 1;
      Object.assign(existing, replacement);
      added.push(existing);
    } else {
      const server = serverFromInput(candidate.input, `mcps-${sanitizeServerName(candidate.input.name)}-${db().opCounter}`);
      db().servers.push(server);
      added.push(server);
    }
  }
  for (const clientId of request.clientIds) {
    const ok: string[] = [];
    for (const server of added) {
      if (skipFile.get(server.name.toLowerCase())?.includes(clientId)) {
        results.push(result(clientId, [server.id], "skipped", { skippedReason: "entry-added-outside" }));
        continue;
      }
      const outcome = applyCell(server, clientId, true);
      if (outcome.status === "skipped") results.push(outcome);
      else ok.push(server.id);
    }
    if (ok.length > 0) results.push(result(clientId, ok, "written"));
  }
  if (added.length === 0) return { kind: "noop", reason: "nothing-selected" };
  // A written same-name file entry now belongs to the list.
  db().unimported = db().unimported.filter(entry => !added.some(server => server.name.toLowerCase() === entry.name.toLowerCase() && results.some(item => item.clientId === entry.clientId && item.status === "written")));
  operation.serverNames = added.map(server => server.name);
  operation.touched = added.flatMap(server => request.clientIds.map(clientId => `${server.name}:${clientId}`));
  return finishOperation(operation, results);
}

function updateServer(request: { serverId: string; input: McpServerInput; expectedRevision: number; confirmToken?: string }): McpWriteOutcome {
  const server = findServer(request.serverId);
  if (request.expectedRevision !== server.specRevision) throw mcpError("revision-conflict", "这个 MCP 刚被改过，已重新载入。");
  if (request.input.name !== server.name) throw mcpError("invalid-input", "名称不能修改。");
  validateInput(request.input);
  const outside = CLIENT_ORDER.filter(clientId => server.cells[clientId].state === "changed-outside");
  if (outside.length > 0 && !tokenOk(request)) {
    return nextConfirm(request, ["changed-outside"], outside.map(clientId => confirmItem(server, clientId, "update")));
  }
  const operation = beginOperation("update", [server.name], CLIENT_ORDER.map(clientId => `${server.name}:${clientId}`));
  const previousArgs = server.args;
  const next = serverFromInput(request.input, server.id);
  next.args = (request.input.args ?? []).map((value, index) =>
    value === SECRET_MASK && previousArgs[index]?.masked ? { ...previousArgs[index] } : { value, masked: false });
  // Omitted secrets keep every stored key that still fits the transport (backend: prefill-safe update).
  if (request.input.secrets === undefined) {
    next.secrets = server.secrets.filter(secret => (next.transport === "stdio" ? secret.kind === "env" : secret.kind === "header")).map(secret => ({ ...secret, inlineClients: [...secret.inlineClients] }));
  }
  next.secrets = next.secrets.map(secret => {
    const previous = server.secrets.find(item => item.kind === secret.kind && item.name === secret.name);
    const typed = (request.input.secrets ?? []).find(item => item.kind === secret.kind && item.name === secret.name);
    const hasValue = Boolean(typed?.value?.trim() || typed?.pasteValueHandle);
    // A kept key keeps where its value lives (no value sent = keep). The variable comes from the
    // request exactly as in spec_from_input: an env key without envVar falls back to its own name,
    // so a client that drops envVar would break an imported "NAME": "${OTHER}" here too.
    const fromRequest = typed ? typed.envVar ?? (secret.kind === "header" ? previous?.envVar ?? null : secret.name) : previous?.envVar ?? null;
    const kept = previous && !hasValue ? { storage: previous.storage, envVar: fromRequest } : {};
    return { ...secret, ...kept, present: hasValue || Boolean(previous?.present), createdBySkillHub: previous?.createdBySkillHub ?? true };
  });
  const enabled = CLIENT_ORDER.filter(clientId => ["on", "error", "changed-outside", "blocked"].includes(server.cells[clientId].state));
  next.cells = server.cells;
  next.projectBindings = server.projectBindings;
  next.meta = server.meta;
  next.specRevision = server.specRevision + 1;
  next.test = server.test ? { ...server.test, stale: true } : null;
  Object.assign(server, next);
  const results: McpClientResult[] = [];
  for (const clientId of CLIENT_ORDER) {
    const reason = unsupportedReason(server, clientId);
    if (reason) {
      const wasOn = enabled.includes(clientId);
      server.cells[clientId] = cell("unsupported", { reason });
      if (wasOn) results.push(result(clientId, [server.id], "skipped", { skippedReason: reason }));
      continue;
    }
    if (server.cells[clientId].state === "unsupported") server.cells[clientId] = offCell();
    if (enabled.includes(clientId)) results.push(applyCell(server, clientId, true));
  }
  return finishOperation(operation, results);
}

function removeServer(request: { serverId: string; from: { kind: "library" } | { kind: "client"; clientId: McpClientId }; deleteEnvVars?: string[]; confirmToken?: string }): McpWriteOutcome {
  const server = findServer(request.serverId);
  if (request.from.kind === "client") {
    const clientId = request.from.clientId;
    if (!tokenOk(request)) return nextConfirm(request, ["remove-from-client"], [confirmItem(server, clientId, "remove", entryPreview(server))]);
    const operation = beginOperation("remove", [server.name], [`${server.name}:${clientId}`]);
    server.cells[clientId] = offCell();
    return finishOperation(operation, [result(clientId, [server.id], "written")]);
  }
  const inFiles = CLIENT_ORDER.filter(clientId => server.cells[clientId].presentInFile);
  if (!tokenOk(request)) {
    const envVars = server.secrets
      .filter(secret => secret.envVar && secret.createdBySkillHub && secret.storage === "user_env")
      .map(secret => ({ name: secret.envVar as string, exists: secret.present, createdBySkillHub: true, action: "delete" as const }));
    return nextConfirm(request, ["remove-from-library"], inFiles.map(clientId => confirmItem(server, clientId, "remove", entryPreview(server))), { envVars });
  }
  const operation = beginOperation("remove", [server.name], inFiles.map(clientId => `${server.name}:${clientId}`));
  operation.envVarNames = [...(request.deleteEnvVars ?? [])];
  server.deleted = true;
  return finishOperation(operation, inFiles.map(clientId => result(clientId, [server.id], "written")));
}

function restoreOperation(operation: MockOperation, kind: McpOperationKind): McpWriteOutcome {
  const current = db();
  if (!operation.before) throw mcpError("undo-unavailable", "这一步没有可撤销的内容。");
  const undoOp = beginOperation(kind, operation.serverNames, operation.touched);
  const clientsTouched = unique(operation.touched.map(item => item.split(":")[1]).filter((item): item is McpClientId => CLIENT_ORDER.includes(item as McpClientId)));
  current.servers = clone(operation.before);
  operation.undone = true;
  return finishOperation(undoOp, clientsTouched.map(clientId => result(clientId, [], "undone")), "undo");
}

function undo(request: { undoToken: string }): McpWriteOutcome {
  const operation = db().operations.find(item => item.id === request.undoToken);
  if (!operation || operation.undone) throw mcpError("undo-unavailable", "这一步已经撤销过了。");
  return restoreOperation(operation, "undo");
}

function rollback(request: { operationId?: string; legacySnapshotId?: string; confirmToken?: string }): McpWriteOutcome {
  const operation = db().operations.find(item => (request.operationId && item.id === request.operationId) || (request.legacySnapshotId && item.legacySnapshotId === request.legacySnapshotId));
  if (!operation || operation.undone) throw mcpError("undo-unavailable", "这一步已经撤销过了。");
  if (!tokenOk(request)) {
    const items: McpConfirmationItem[] = operation.clientIds.map(clientId => ({
      clientId,
      clientLabel: CLIENT_LABEL[clientId],
      scope: "user",
      serverName: operation.serverNames[0] ?? "",
      action: operation.kind === "add" || operation.kind === "enable" ? "remove" : operation.kind === "disable" || operation.kind === "remove" ? "add" : "update",
      changedFields: []
    }));
    return nextConfirm(request, ["rollback"], items);
  }
  if (!operation.before) {
    // Seeded history entries carry no before-state; the preview just marks them undone.
    operation.undone = true;
    const rollbackOp = beginOperation("rollback", operation.serverNames, operation.touched);
    return finishOperation(rollbackOp, operation.clientIds.map(clientId => result(clientId, [], "undone")), "undo");
  }
  return restoreOperation(operation, "rollback");
}

function setSecret(request: { serverId: string; name: string; value: string; mode: "user_env" | "inline"; inlineClients?: McpClientId[]; confirmToken?: string }): McpWriteOutcome {
  const server = findServer(request.serverId);
  const secret = server.secrets.find(item => item.name === request.name);
  if (!secret) throw mcpError("not-found", "没有找到这个密钥。");
  const value = request.value.trim();
  if (!value || value.length > 8192 || /[\r\n\0]/.test(value)) throw mcpError("secret-value-invalid", "密钥需要 1 到 8192 个字符，不能有换行。");
  const envVar = secret.envVar ?? secret.name;
  if (request.mode === "user_env" && !db().envCreated.has(envVar) && !secret.createdBySkillHub && !tokenOk(request) && envVar === "OPENAI_API_KEY") {
    return nextConfirm(request, ["overwrite-env-var"], [], { envVars: [{ name: envVar, exists: true, createdBySkillHub: false, action: "set" }] });
  }
  if (request.mode === "inline" && !tokenOk(request)) {
    return nextConfirm(request, ["inline-secret"], CLIENT_ORDER.filter(clientId => server.cells[clientId].state === "on").map(clientId => confirmItem(server, clientId, "update")));
  }
  const operation = beginOperation("secret", [server.name], [`${server.name}:secret`]);
  secret.present = true;
  secret.storage = request.mode === "inline" ? "library" : "user_env";
  secret.createdBySkillHub = true;
  for (const clientId of request.inlineClients ?? []) if (!secret.inlineClients.includes(clientId)) secret.inlineClients.push(clientId);
  if (request.mode === "user_env") db().envCreated.add(envVar);
  operation.envVarNames = request.mode === "user_env" ? [envVar] : [];
  if (server.test?.status === "needs-secret") server.test = { ...server.test, stale: true };
  const results = CLIENT_ORDER.filter(clientId => server.cells[clientId].state === "on").map(clientId => result(clientId, [server.id], "written"));
  return finishOperation(operation, results, "secret");
}

// ---------- test ----------

const INSTALL_HINTS = {
  node: "https://nodejs.org/",
  uv: "https://docs.astral.sh/uv/getting-started/installation/",
  docker: "https://docs.docker.com/desktop/setup/install/windows-install/",
  python: "https://www.python.org/downloads/windows/"
} as const;

function testPreview(serverId: string): McpTestPreview {
  const server = findServer(serverId);
  const missingSecrets = server.secrets.filter(secret => !secret.present).map(secret => secret.name);
  if (server.transport !== "stdio") {
    let url: string | null = null;
    try {
      const parsed = new URL(server.url ?? "");
      url = `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
    } catch {
      url = server.url ?? null;
    }
    return { serverId, specRevision: server.specRevision, kind: "http", commandLine: null, url, runner: null, missingSecrets, previewToken: `preview-test-${serverId}-${server.specRevision}`, timeoutSeconds: 20 };
  }
  const runner = fileStem(server.command ?? "").toLowerCase();
  const found = runner !== "uvx" && runner !== "docker";
  const kind = runner === "uvx" || runner === "uv" ? "uv" : runner === "docker" ? "docker" : runner.startsWith("python") ? "python" : "node";
  const commandLine = [server.command ?? "", ...server.args.map(arg => (arg.masked ? SECRET_MASK : arg.value))]
    .map(part => (/\s/.test(part) ? `"${part}"` : part))
    .join(" ");
  return {
    serverId,
    specRevision: server.specRevision,
    kind: "process",
    commandLine,
    url: null,
    runner: {
      name: runner || "?",
      found,
      pathDisplay: found ? (runner === "npx" ? "C:/Program Files/nodejs/npx.cmd" : server.command) : undefined,
      installHint: found ? undefined : { kind, url: INSTALL_HINTS[kind] }
    },
    missingSecrets,
    previewToken: `preview-test-${serverId}-${server.specRevision}`,
    timeoutSeconds: 20
  };
}

async function testServer(request: { serverId: string; previewToken: string }): Promise<McpTestResult> {
  const server = findServer(request.serverId);
  const testedAt = now();
  if (request.previewToken !== `preview-test-${server.id}-${server.specRevision}`) {
    return { serverId: server.id, specRevision: server.specRevision, testedAt, status: "stale-preview", messageCode: "stale-preview", message: "配置刚改过，请重新确认要运行的命令。" };
  }
  const phases: McpTestProgressEvent["phase"][] = ["resolving", "starting", "initialize", "tools-list", "stopping", "done"];
  for (const phase of phases) {
    for (const listener of progressListeners) listener({ serverId: server.id, phase });
    await delay(phase === "initialize" ? 520 : 260);
  }
  const preview = testPreview(server.id);
  let outcome: McpTestResult;
  if (server.transport === "sse") {
    outcome = { serverId: server.id, specRevision: server.specRevision, testedAt, status: "unsupported", messageCode: "sse-unsupported", message: "暂不支持测试旧版 SSE 连接" };
  } else if (preview.runner && !preview.runner.found) {
    outcome = { serverId: server.id, specRevision: server.specRevision, testedAt, status: "runner-missing", messageCode: "runner-missing", message: `找不到 ${preview.runner.name}` };
  } else if (preview.missingSecrets.length > 0) {
    outcome = { serverId: server.id, specRevision: server.specRevision, testedAt, status: "needs-secret", messageCode: "needs-secret", message: "需要 API Key" };
  } else {
    const toolsCount = server.name === "context7" ? 2 : server.name === "github" ? 41 : 3 + (server.name.length % 9);
    outcome = { serverId: server.id, specRevision: server.specRevision, testedAt, status: "ok", toolsCount, serverName: server.name, serverVersion: "1.0.0", messageCode: "ok", message: "" };
  }
  server.test = { status: outcome.status, toolsCount: outcome.toolsCount, testedAt, stale: false, messageCode: outcome.messageCode };
  db().generation += 1;
  emit("test", null);
  return outcome;
}

// ---------- import / export / history / misc ----------

function importFromClients(): McpImportReport {
  const current = db();
  const added: string[] = [];
  for (const item of current.unimported) {
    const server: MockServer = serverFromInput({ name: item.name, transport: "stdio", command: "uvx", args: ["mcp-server-sqlite", "--db-path", "~/data/notes.db"], source: { kind: "import", clientId: item.clientId, scope: "user" } }, `mcps-${item.name}`);
    server.cells[item.clientId] = cell("on");
    current.servers.push(server);
    added.push(item.name);
  }
  current.unimported = [];
  current.initialized = true;
  current.opCounter += 1;
  const operationId = `mcp-op-preview-${current.opCounter}`;
  current.operations.unshift({ id: operationId, at: now(), kind: "import", serverNames: added, clientIds: ["cursor"], failedClientIds: [], envVarNames: [], before: null, undone: false, touched: [] });
  current.generation += 1;
  emit("import", operationId);
  return {
    operationId,
    added,
    merged: [{ name: "memory", clientIds: ["codex", "claude-code", "claude-desktop", "cursor"] }],
    differing: [{ name: "origin", clientIds: ["codex"] }],
    skipped: [{ name: "team-wiki", clientId: "codex", reason: "codex-structured-env" }],
    filesRead: CLIENT_ORDER.map(clientId => ({
      clientId,
      scope: "user" as const,
      pathDisplay: CLIENT_PATH[clientId],
      status: "ok" as const,
      servers: live().filter(server => server.cells[clientId].presentInFile).length
    })),
    wroteClientFiles: false
  };
}

function exportJson(request: { serverIds?: string[]; format: "mcp-servers" | "codex-toml" }): McpExportResult {
  let masked = 0;
  const servers = live().filter(server => !request.serverIds || request.serverIds.includes(server.id));
  const map: Record<string, unknown> = {};
  for (const server of servers) {
    const entry: Record<string, unknown> = {};
    if (server.transport === "stdio") {
      entry.command = server.command;
      entry.args = server.args.map(arg => {
        if (arg.masked) masked += 1;
        return arg.masked ? SECRET_MASK : arg.value;
      });
      const env: Record<string, string> = {};
      for (const item of server.env) env[item.name] = item.value;
      for (const secret of server.secrets.filter(item => item.kind === "env")) {
        if (secret.storage === "library") masked += 1;
        env[secret.name] = secret.storage === "library" ? SECRET_MASK : `\${${secret.envVar ?? secret.name}}`;
      }
      if (Object.keys(env).length > 0) entry.env = env;
    } else {
      entry.type = server.transport;
      entry.url = server.url;
      const headers: Record<string, string> = {};
      for (const secret of server.secrets.filter(item => item.kind === "header")) {
        if (secret.storage === "library") masked += 1;
        const reference = secret.storage === "library" ? SECRET_MASK : `\${${secret.envVar ?? secret.name}}`;
        headers[secret.name] = secret.headerTemplate === "bearer" ? `Bearer ${reference}` : reference;
      }
      if (Object.keys(headers).length > 0) entry.headers = headers;
    }
    map[server.name] = entry;
  }
  return { text: JSON.stringify({ mcpServers: map }, null, 2), maskedSecretCount: masked };
}

function history(limit = 50): McpHistoryEntry[] {
  const operations = db().operations.slice(0, Math.min(200, limit));
  return operations.map((operation, index) => {
    const later = operations.slice(0, index).some(item => !item.undone && item.kind !== "undo" && item.kind !== "rollback" && item.touched.some(touch => operation.touched.includes(touch)));
    let undoUnavailableReason: McpHistoryEntry["undoUnavailableReason"];
    if (operation.undone) undoUnavailableReason = "already-undone";
    else if (operation.kind === "import") undoUnavailableReason = "import-only";
    else if (operation.kind === "undo" || operation.kind === "rollback") undoUnavailableReason = "already-undone";
    else if (operation.expired) undoUnavailableReason = "expired";
    else if (later) undoUnavailableReason = "superseded";
    return {
      operationId: operation.id,
      at: operation.at,
      kind: operation.kind,
      serverNames: [...operation.serverNames],
      clientIds: [...operation.clientIds],
      failedClientIds: [...operation.failedClientIds],
      envVarNames: [...operation.envVarNames],
      partial: operation.failedClientIds.length > 0,
      undoAvailable: !undoUnavailableReason,
      undoUnavailableReason,
      legacySnapshotId: operation.legacySnapshotId
    };
  });
}

function resync(request: { clientIds?: McpClientId[]; serverIds?: string[]; confirmToken?: string }): McpWriteOutcome {
  const targets: Array<{ server: MockServer; clientId: McpClientId }> = [];
  for (const server of live()) {
    if (request.serverIds && !request.serverIds.includes(server.id)) continue;
    for (const clientId of request.clientIds ?? CLIENT_ORDER) {
      const value = server.cells[clientId];
      if (value.windowsFixAvailable || value.outOfDate || value.state === "changed-outside") targets.push({ server, clientId });
    }
  }
  if (targets.length === 0) return { kind: "noop", reason: "already-in-state" };
  const outside = targets.filter(item => item.server.cells[item.clientId].state === "changed-outside");
  if (outside.length > 0 && !tokenOk(request)) {
    return nextConfirm(request, ["resync"], outside.map(item => confirmItem(item.server, item.clientId, "update")));
  }
  const operation = beginOperation("resync", unique(targets.map(item => item.server.name)), targets.map(item => `${item.server.name}:${item.clientId}`));
  const results = targets.map(item => applyCell(item.server, item.clientId, true));
  return finishOperation(operation, results);
}

function resolveChange(request: { serverId: string; clientId: McpClientId; take: "file" | "library"; confirmToken?: string }): McpWriteOutcome {
  const server = findServer(request.serverId);
  if (server.cells[request.clientId].state !== "changed-outside") return { kind: "noop", reason: "already-in-state" };
  if (!tokenOk(request)) {
    if (request.take === "library") return nextConfirm(request, ["changed-outside"], [confirmItem(server, request.clientId, "update")]);
    const others = CLIENT_ORDER.filter(clientId => clientId !== request.clientId && server.cells[clientId].state === "on");
    return nextConfirm(request, ["resync"], others.map(clientId => confirmItem(server, clientId, "update")));
  }
  const operation = beginOperation("resolve", [server.name], [`${server.name}:${request.clientId}`]);
  if (request.take === "file") {
    server.args = [{ value: "-m", masked: false }, { value: "origin_mcp", masked: false }, { value: "--verbose", masked: false }];
    server.specRevision += 1;
    if (server.test) server.test = { ...server.test, stale: true };
  }
  server.cells[request.clientId] = cell("on");
  return finishOperation(operation, [result(request.clientId, [server.id], request.take === "file" ? "unchanged" : "written")]);
}

function templates(): McpTemplate[] {
  const base = (id: McpTemplate["id"], input: Omit<McpServerInput, "source" | "name">, extra: Partial<McpTemplate> = {}): McpTemplate => ({
    id,
    input: { name: id, ...input, source: { kind: "template", id } },
    params: [],
    secrets: [],
    runner: input.command === "uvx" ? "uvx" : input.command === "npx" ? "npx" : null,
    docsUrl: `https://github.com/modelcontextprotocol/servers`,
    verifiedAt: "2026-10-01",
    ...extra
  });
  return [
    base("context7", { transport: "stdio", command: "npx", args: ["-y", "@upstash/context7-mcp"] }, {
      secrets: [{ kind: "env", name: "CONTEXT7_API_KEY", envVar: "CONTEXT7_API_KEY", required: false, helpUrl: "https://context7.com/dashboard" }],
      docsUrl: "https://github.com/upstash/context7"
    }),
    base("fetch", { transport: "stdio", command: "uvx", args: ["mcp-server-fetch"] }),
    base("filesystem", { transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem"] }, {
      params: [{ key: "allowedPath", kind: "folder", required: true, argIndex: 2 }]
    }),
    base("memory", { transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"] }),
    base("sequential-thinking", { transport: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-sequential-thinking"] }),
    base("playwright", { transport: "stdio", command: "npx", args: ["@playwright/mcp@latest"] }, { docsUrl: "https://github.com/microsoft/playwright-mcp" }),
    base("github", { transport: "http", url: "https://api.githubcopilot.com/mcp/" }, {
      secrets: [{ kind: "header", name: "Authorization", envVar: "GITHUB_PERSONAL_ACCESS_TOKEN", headerTemplate: "bearer", required: true, helpUrl: "https://github.com/settings/personal-access-tokens" }],
      docsUrl: "https://github.com/github/github-mcp-server"
    })
  ];
}

// ---------- recipe (Discover card) ----------

/** Canned Origin recipe status for the browser preview; detection only ever runs on a click. */
export function previewRecipeStatus() {
  return {
    recipeId: "origin-mcp",
    packageVersion: "0.1.4",
    state: "needs-connection",
    nextStep: "connect",
    steps: [
      { id: "origin", status: "ok", detail: "OriginPro 2026 (预览)" },
      { id: "python", status: "ok", detail: "Python 3.12" },
      { id: "runtime", status: "ok", detail: "origin-mcp 0.1.4" },
      { id: "client", status: "pending", detail: "" }
    ],
    origin: { name: "OriginPro", version: "2026", installDir: "C:/Program Files/OriginLab/Origin2026", running: false },
    basePython: "C:/Python312/python.exe",
    basePythonVersion: "3.12.6",
    runtimePython: "~/AppData/Local/AI SkillHub/origin-mcp/Scripts/python.exe",
    installedVersion: "0.1.4",
    appStaged: true,
    appRegistered: false,
    mkopxCommands: [],
    clients: [],
    verification: null,
    verificationStale: false,
    failure: ""
  };
}

// ---------- dispatcher ----------

function delay(ms: number) {
  return new Promise<void>(resolve => window.setTimeout(resolve, ms));
}

type AnyRequest = Record<string, unknown>;

const HANDLERS: Record<McpCommand, (request: AnyRequest) => unknown | Promise<unknown>> = {
  mcp_library_snapshot: () => snapshot(),
  mcp_get_server: request => detail(findServer(String(request.serverId))),
  mcp_list_templates: () => templates(),
  mcp_history: request => history(Number(request.limit ?? 50)),
  mcp_import_from_clients: () => importFromClients(),
  mcp_set_cell: request => setCell(request as Parameters<typeof setCell>[0]),
  mcp_set_column: request => setColumn(request as Parameters<typeof setColumn>[0]),
  mcp_set_row: request => setRow(request as Parameters<typeof setRow>[0]),
  mcp_parse_paste: request => parsePaste(String(request.text ?? "")),
  mcp_import_github: request => importGithub(String(request.source ?? "")),
  mcp_add_servers: request => addServers(request as Parameters<typeof addServers>[0]),
  mcp_update_server: request => updateServer(request as Parameters<typeof updateServer>[0]),
  mcp_remove_server: request => removeServer(request as Parameters<typeof removeServer>[0]),
  mcp_undo: request => undo(request as Parameters<typeof undo>[0]),
  mcp_rollback: request => rollback(request as Parameters<typeof rollback>[0]),
  mcp_set_secret: request => setSecret(request as Parameters<typeof setSecret>[0]),
  mcp_test_preview: request => testPreview(String(request.serverId)),
  mcp_test_server: request => testServer(request as Parameters<typeof testServer>[0]),
  mcp_export_json: request => exportJson(request as Parameters<typeof exportJson>[0]),
  mcp_resync: request => resync(request as Parameters<typeof resync>[0]),
  mcp_resolve_changed_outside: request => resolveChange(request as Parameters<typeof resolveChange>[0]),
  mcp_resolve_stuck_transaction: () => {
    throw mcpError("not-found", "没有需要处理的中断写入。");
  },
  mcp_open_config_location: () => undefined
};

export async function previewMcp<R>(command: McpCommand, request: unknown): Promise<R> {
  callCounter += 1;
  await delay(150 + ((callCounter * 97) % 250));
  const handler = HANDLERS[command];
  if (!handler) throw mcpError("engine", `预览里没有 ${command}。`);
  return (await handler((request ?? {}) as AnyRequest)) as R;
}

export function previewMcpSubscribe(cb: (event: McpLibraryChangedEvent) => void): Unlisten {
  libraryListeners.add(cb);
  return () => {
    libraryListeners.delete(cb);
  };
}

export function previewMcpTestProgress(cb: (event: McpTestProgressEvent) => void): Unlisten {
  progressListeners.add(cb);
  return () => {
    progressListeners.delete(cb);
  };
}

/** Test hook: forget all mock state (used by the visual QA between scenarios). */
export function resetPreviewMcp() {
  state = null;
}

export type { McpSkipReason };
