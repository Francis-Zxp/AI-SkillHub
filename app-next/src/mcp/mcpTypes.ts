// Copied verbatim from docs/v3.3/mcp-contract.md §3.2 (frozen 2026-10-07).
// The Rust structs in src-tauri/src/mcp_library.rs mirror these field for field.
// Do not edit by hand: change the contract first, then copy again.

// ===== app-next/src/mcp/mcpTypes.ts — v3.3 MCP contract (docs/v3.3/mcp-contract.md §3.2) =====

export type McpClientId = "codex" | "claude-code" | "claude-desktop" | "cursor";
export type McpTransport = "stdio" | "http" | "sse";
export type McpScope = "user" | "project" | "local";
export type McpSecretStorage = "user_env" | "library" | "external" | "none";
export type McpSecretMode = "user_env" | "inline";
export const SECRET_MASK = "••••••••";
export const MCP_LIBRARY_CHANGED_EVENT = "mcp-library-changed";
export const MCP_TEST_PROGRESS_EVENT = "mcp-test-progress";

export type McpCommand =
  | "mcp_library_snapshot" | "mcp_get_server" | "mcp_list_templates" | "mcp_history"
  | "mcp_import_from_clients" | "mcp_set_cell" | "mcp_set_column" | "mcp_set_row"
  | "mcp_parse_paste" | "mcp_import_github" | "mcp_add_servers" | "mcp_update_server"
  | "mcp_remove_server" | "mcp_undo" | "mcp_rollback" | "mcp_set_secret"
  | "mcp_test_preview" | "mcp_test_server" | "mcp_export_json" | "mcp_resync"
  | "mcp_resolve_changed_outside" | "mcp_resolve_stuck_transaction" | "mcp_open_config_location";

// ---------- errors ----------
export type McpErrorCode =
  | "busy" | "not-found" | "invalid-input" | "invalid-name" | "name-taken" | "revision-conflict"
  | "client-not-installed" | "client-unsupported" | "transport-unsupported"
  | "config-unreadable" | "config-jsonc" | "config-parse-failed" | "config-too-large"
  | "config-changed" | "config-ambiguous-project" | "codex-structured-env" | "stuck-transaction"
  | "secret-name-invalid" | "secret-name-reserved" | "secret-value-invalid" | "env-write-failed"
  | "paste-unrecognized" | "paste-too-large" | "paste-expired"
  | "undo-unavailable" | "undo-conflict"
  | "test-preview-required" | "test-busy"
  | "github-invalid-source" | "github-unreachable" | "github-rate-limited" | "github-moved"
  | "github-not-found" | "github-too-large"
  | "library-write-failed" | "engine";

export type McpError = {
  code: McpErrorCode;
  message: string;                              // zh fallback, secret-free, ≤ 280 chars
  params?: Record<string, string | number>;     // e.g. { client: "Cursor", path: "~/.cursor/mcp.json" }
  clientId?: McpClientId;
};

// ---------- registry / snapshot ----------
export type McpReadonlyReason =
  | "config-jsonc" | "config-parse-failed" | "config-too-large" | "config-unreadable"
  | "client-not-installed" | "codex-structured-env" | "not-registered" | "team-shared-file"
  | "config-ambiguous-project";

export type McpClient = {
  id: McpClientId;
  label: string;                                // "Codex" | "Claude Code" | "Claude Desktop" | "Cursor"
  adapterId: "codex" | "claude" | "cursor";     // AI 工具 page adapter id (lib.rs:16182+) for "MCP 5" counts
  detected: boolean;
  writable: boolean;
  readonlyReason?: McpReadonlyReason;
  configPathDisplay: string;                    // "~/.codex/config.toml" (home-redacted)
  transports: McpTransport[];
  secretReference: "env-forward" | "dollar-brace" | "env-colon" | "none";
  disableMode: "flag" | "remove";
  enabledCount: number;                         // user-scope servers enabled in this client
  restartNeeded: boolean;                       // SkillHub wrote this client's file since app start
};

export type McpCellState =
  | "on" | "off" | "error" | "unsupported" | "readonly" | "blocked" | "changed-outside";
export type McpCellReason =
  | McpReadonlyReason
  | "transport-unsupported" | "name-incompatible"
  | "needs-inline-consent" | "missing-secret"          // blocked
  | "write-failed" | "stuck-transaction"               // error
  | "entry-removed-outside" | "entry-edited-outside" | "entry-added-outside"; // changed-outside

export type McpCell = {
  clientId: McpClientId;
  state: McpCellState;
  reason?: McpCellReason;
  errorMessage?: string;                        // secret-free zh fallback for state "error"
  presentInFile: boolean;
  disabledInFile: boolean;                      // codex: entry present with enabled = false
  outOfDate: boolean;                           // on, but file holds an older projection SkillHub wrote → silent resync offered
  windowsFixAvailable: boolean;                 // claude-*: npx-family entry written without cmd /c
  projectCount: number;                         // project/local bindings of this server in this client
};

export type McpProjectBinding = {
  clientId: "codex" | "claude-code";
  scope: "project" | "local";
  projectLabel: string;                         // sanitized folder name, never a full path
  workspaceId?: string;
  state: "on" | "off" | "readonly";
  readonlyReason?: McpReadonlyReason;
};

export type McpTargetSummary = {
  runner: string | null; subject: string | null; extraArgCount: number; host: string | null;
};

export type McpSecretStatus = {
  kind: "env" | "header";
  name: string;                                 // env var name, or header name
  envVar: string | null;                        // variable that holds the value (user_env/external)
  headerTemplate?: "raw" | "bearer";
  storage: McpSecretStorage;
  present: boolean;                             // value exists (HKCU/HKLM/process env, or DPAPI)
  inlineClients: McpClientId[];
  createdBySkillHub: boolean;
  required: boolean;
};

export type McpTestStatus =
  | "ok" | "failed" | "timeout" | "runner-missing" | "needs-secret" | "unsupported" | "stale-preview";
export type McpTestSummary = {
  status: McpTestStatus; toolsCount?: number; testedAt: string; stale: boolean; messageCode: string;
};

export type McpServerSource =
  | { kind: "import"; clientId: McpClientId; scope: McpScope }
  | { kind: "paste"; format: McpPasteFormat }
  | { kind: "template"; id: McpTemplateId }
  | { kind: "github"; repo: string }            // "owner/repo"
  | { kind: "recipe"; id: "origin-mcp" }
  | { kind: "manual" };

export type McpServerRow = {
  id: string;
  name: string;
  displayName: string;
  transport: McpTransport;
  target: McpTargetSummary;
  cells: McpCell[];                             // same order as snapshot.clients
  projectBindings: McpProjectBinding[];
  secrets: McpSecretStatus[];
  missingSecretCount: number;
  test: McpTestSummary | null;
  source: McpServerSource;
  specRevision: number;
  issueCount: number;
  updatedAt: string;
};

export type McpIssueKind =
  | "client-unwritable" | "write-failed" | "missing-secret" | "changed-outside" | "unimported"
  | "stuck-transaction" | "needs-inline-consent" | "windows-fix" | "out-of-date" | "interrupted";
export type McpIssue = {
  id: string;
  kind: McpIssueKind;
  clientId?: McpClientId; serverId?: string; serverName?: string;
  count?: number;
  pathDisplay?: string;
  action: "retry" | "open-file-location" | "fill-secret" | "review-change" | "import"
        | "resolve-stuck" | "allow-inline" | "resync" | "none";
};

export type McpLibrarySnapshot = {
  generation: number;
  generatedAt: string;
  libraryInitialized: boolean;                  // false → frontend auto-calls mcp_import_from_clients once
  clients: McpClient[];                         // matrix columns, stable order: codex, claude-code, claude-desktop, cursor
  otherClients: Array<{ adapterId: string; label: string }>; // detected adapters without MCP support this round
  servers: McpServerRow[];                      // sorted by displayName (case-insensitive)
  issues: McpIssue[];
  unimported: Array<{ clientId: McpClientId; name: string }>;
  stuckTransactions: Array<{ snapshotId: string; clientId: McpClientId | null; pathDisplay: string }>;
};

// ---------- server input / detail ----------
export type McpSecretInput = {
  kind: "env" | "header";
  name: string;                                 // env var name, or header name ("Authorization")
  envVar?: string;                              // header kind: variable holding the value; default derived
  headerTemplate?: "raw" | "bearer";
  value?: string;                               // WRITE-ONLY; omitted = keep the stored value
  pasteValueHandle?: string;                    // value captured by mcp_parse_paste, held in Rust memory
  mode: McpSecretMode;                          // default "user_env"
  inlineClients?: McpClientId[];                // literal value allowed in these client files
  required?: boolean;
};

export type McpServerInput = {
  name: string;                                 // immutable after creation; update must send the same name
  displayName?: string;
  transport: McpTransport;
  command?: string;                             // stdio, unwrapped ("npx", never "cmd")
  args?: string[];                              // a SECRET_MASK element at a masked index keeps the stored value
  cwd?: string;
  url?: string;                                 // http/sse; https or http, no query/fragment/credentials
  env?: Array<{ name: string; value: string }>; // NON-secret literal env (e.g. GITHUB_OAUTH_CALLBACK_PORT=8085)
  secrets?: McpSecretInput[];
  codexRequired?: boolean;
  source: McpServerSource;
};

export type McpServerDetail = {
  id: string; name: string; displayName: string;
  transport: McpTransport;
  command?: string;
  args: Array<{ value: string; masked: boolean }>; // masked → value === SECRET_MASK
  cwd?: string;
  url?: string;
  env: Array<{ name: string; value: string }>;  // non-secret only
  secrets: McpSecretStatus[];                   // never values
  codexRequired: boolean;
  source: McpServerSource;
  meta: { description?: string; homepage?: string; docsUrl?: string; templateId?: McpTemplateId };
  specRevision: number;
  cells: McpCell[];
  projectBindings: McpProjectBinding[];
  test: McpTestSummary | null;
};

// ---------- write outcomes ----------
export type McpClientResult = {
  clientId: McpClientId;
  scope: McpScope;
  projectLabel?: string;
  serverIds: string[];
  status: "written" | "unchanged" | "skipped" | "failed" | "undone";
  skippedReason?: McpCellReason;
  error?: McpError;
  restartHint: boolean;                         // "重启 Codex 后生效"
};

export type McpOperationKind =
  | "add" | "enable" | "disable" | "remove" | "update" | "import" | "secret"
  | "undo" | "rollback" | "resync" | "resolve" | "legacy";

export type McpOperationSummary = {
  kind: McpOperationKind;
  serverNames: string[];
  clientIds: McpClientId[];
  failedClientIds: McpClientId[];
  envVarNames: string[];
};

export type McpEntryPreview = {
  transport: McpTransport;
  targetDisplay: string;                        // "npx · @upstash/context7-mcp" / "api.githubcopilot.com"
  envNames: string[]; headerNames: string[]; argCount: number;
};

export type McpConfirmationKind =
  | "remove-from-library" | "remove-from-client" | "overwrite-different" | "changed-outside"
  | "rollback" | "overwrite-env-var" | "delete-env-var" | "inline-secret" | "resync";

export type McpConfirmationItem = {
  clientId: McpClientId; clientLabel: string;
  scope: McpScope; projectLabel?: string;
  serverName: string;
  action: "add" | "update" | "remove" | "enable" | "disable";
  before?: McpEntryPreview;
  after?: McpEntryPreview;
  changedFields: Array<"command" | "args" | "url" | "env" | "headers" | "transport" | "enabled" | "required" | "cwd">;
};

export type McpConfirmation = {
  kinds: McpConfirmationKind[];                 // usually one; e.g. ["changed-outside","overwrite-different"]
  confirmToken: string;
  items: McpConfirmationItem[];
  envVars?: Array<{ name: string; exists: boolean; createdBySkillHub: boolean; action: "set" | "delete" }>;
  undoable: boolean;                            // true for everything except an expired history rollback
};

export type McpWriteOutcome =
  | { kind: "done"; operationId: string; undoToken: string | null; summary: McpOperationSummary;
      results: McpClientResult[]; generation: number }
  | { kind: "needs-confirmation"; confirmation: McpConfirmation }
  | { kind: "noop"; reason: "already-in-state" | "nothing-selected" };

// ---------- requests ----------
export type McpEmptyRequest = Record<string, never>;
export type McpGetServerRequest = { serverId: string };
export type McpImportRequest = { reason: "first-run" | "onboarding" | "user"; clientIds?: McpClientId[] };
export type McpSetCellRequest = {
  serverId: string; clientId: McpClientId; enabled: boolean;
  allowInline?: boolean;                        // consent: write literal secret values into this client file
  confirmToken?: string;
};
export type McpSetColumnRequest = { clientId: McpClientId; enabled: boolean; serverIds?: string[]; confirmToken?: string };
export type McpSetRowRequest = { serverId: string; enabled: boolean; clientIds?: McpClientId[]; confirmToken?: string };
export type McpParsePasteRequest = { text: string };                // ≤ 256 KiB
export type McpGithubRequest = { source: string };                  // owner/repo, URL, /tree/ or /blob/ URL
export type McpAddRequest = {
  candidates: Array<{ input: McpServerInput; onConflict: "skip" | "overwrite" }>;
  clientIds: McpClientId[];
  placement?: { scope: McpScope; workspaceId?: string };            // 高级; default user scope
  pasteHandle?: string;
  confirmToken?: string;
};
export type McpUpdateRequest = { serverId: string; input: McpServerInput; expectedRevision: number; confirmToken?: string };
export type McpRemoveRequest = {
  serverId: string;
  from: { kind: "library" } | { kind: "client"; clientId: McpClientId; scope?: McpScope; workspaceId?: string };
  deleteEnvVars?: string[];                     // only SkillHub-created, now-unreferenced names listed in the confirmation
  confirmToken?: string;
};
export type McpUndoRequest = { undoToken: string };
export type McpHistoryRequest = { limit?: number };                 // default 50, max 200
export type McpRollbackRequest = { operationId?: string; legacySnapshotId?: string; confirmToken?: string };
export type McpSetSecretRequest = {
  serverId: string;
  name: string;                                 // McpSecretStatus.name
  value: string;                                // write-only, never echoed
  mode: McpSecretMode;                          // "user_env" (HKCU + references) | "inline" (DPAPI + literal in configs)
  inlineClients?: McpClientId[];                // user_env mode: clients without reference support allowed to get the literal
  confirmToken?: string;                        // overwriting an existing HKCU var not created by SkillHub
};
export type McpTestPreviewRequest = { serverId: string };
export type McpTestRequest = { serverId: string; previewToken: string };
export type McpExportRequest = { serverIds?: string[]; format: "mcp-servers" | "codex-toml" };
export type McpResyncRequest = { clientIds?: McpClientId[]; serverIds?: string[]; confirmToken?: string };
export type McpResolveChangeRequest = { serverId: string; clientId: McpClientId; take: "file" | "library"; confirmToken?: string };
export type McpResolveStuckRequest = { snapshotId: string; action: "keep-current" };
export type McpOpenLocationRequest = { clientId: McpClientId; scope?: McpScope; workspaceId?: string };

// ---------- paste / github ----------
export type McpPasteFormat =
  | "mcp-servers" | "named" | "single" | "codex-toml" | "codex-json" | "vscode" | "opencode" | "readme";
export type McpSkipReason =
  | "secret-in-args" | "shell-command" | "unsupported-transport" | "invalid-name" | "too-many-args"
  | "invalid-url" | "codex-structured-env" | "unknown-type";
export type McpCandidate = {
  key: string;                                  // stable within this result
  name: string; nameSuggested: boolean; nameValid: boolean;
  input: McpServerInput;                        // secrets carry pasteValueHandle instead of value
  targetDisplay: string;
  exists: "new" | "same" | "different";        // vs library AND client files
  existingServerId?: string;
  differsIn: McpClientId[];                     // clients whose current file entry differs
  secrets: Array<{ kind: "env" | "header"; name: string; envVar: string | null;
                   hasPastedValue: boolean; placeholder: boolean }>;
  warnings: Array<"windows-cmd-unwrapped" | "needs-folder-path" | "docker-needs-running" | "readme-example">;
  variants: Array<{ key: string; targetDisplay: string; preferred: boolean }>; // same-name README variants
};
export type McpPasteResult = {
  format: McpPasteFormat | "unrecognized";
  pasteHandle: string | null;                   // Rust in-memory, 15 min, holds pasted secret values only
  candidates: McpCandidate[];
  skipped: Array<{ name: string; reason: McpSkipReason }>;
  sourceDisplay?: string;                       // github: "github.com/owner/repo/README.md"
  notices: Array<"configuration-only" | "readme-example" | "has-verified-recipe">;
};

// ---------- import / history / test / templates / export ----------
export type McpImportReport = {
  operationId: string | null;
  added: string[];
  merged: Array<{ name: string; clientIds: McpClientId[] }>;
  differing: Array<{ name: string; clientIds: McpClientId[] }>;
  skipped: Array<{ name: string; clientId: McpClientId; reason: McpSkipReason }>;
  filesRead: Array<{ clientId: McpClientId; scope: McpScope; pathDisplay: string;
                     status: "ok" | "missing" | "jsonc-readonly" | "parse-failed" | "too-large" | "unreadable";
                     servers: number }>;
  wroteClientFiles: false;
};

export type McpHistoryEntry = {
  operationId: string;
  at: string;                                   // ISO 8601
  kind: McpOperationKind;
  serverNames: string[];
  clientIds: McpClientId[];
  failedClientIds: McpClientId[];
  envVarNames: string[];
  partial: boolean;
  undoAvailable: boolean;
  undoUnavailableReason?: "expired" | "already-undone" | "superseded" | "import-only" | "legacy-changed";
  legacySnapshotId?: string;                    // pre-3.3 plan/apply snapshots
};

export type McpTestPreview = {
  serverId: string; specRevision: number;
  kind: "process" | "http";
  commandLine: string | null;                   // "npx -y @upstash/context7-mcp" (secret args masked, paths ~-redacted)
  url: string | null;                           // scheme+host+path, no query
  runner: { name: string; found: boolean; pathDisplay?: string;
            installHint?: { kind: "node" | "uv" | "docker" | "python"; url: string } } | null;
  missingSecrets: string[];
  previewToken: string;
  timeoutSeconds: 20;
};
export type McpTestResult = {
  serverId: string; specRevision: number; testedAt: string;
  status: McpTestStatus;
  toolsCount?: number; serverName?: string; serverVersion?: string;
  messageCode: string;                          // i18n key suffix, e.g. "runner-missing"
  message: string;                              // secret-redacted, ≤ 240 chars
};

export type McpTemplateId =
  | "context7" | "fetch" | "filesystem" | "memory" | "sequential-thinking" | "playwright" | "github";
export type McpTemplate = {
  id: McpTemplateId;
  input: McpServerInput;                        // source = { kind: "template", id }
  params: Array<{ key: "allowedPath"; kind: "folder"; required: true; argIndex: number }>;
  secrets: Array<{ kind: "env" | "header"; name: string; envVar: string; headerTemplate?: "bearer";
                   required: boolean; helpUrl: string }>;
  runner: "npx" | "uvx" | null;
  docsUrl: string;
  verifiedAt: string | null;                    // last release-time test pass (§7.4)
};

export type McpExportResult = { text: string; maskedSecretCount: number };

// ---------- events ----------
export type McpLibraryChangedEvent = {
  generation: number; operationId: string | null;
  reason: "write" | "import" | "undo" | "secret" | "test";
};
export type McpTestProgressEvent = {
  serverId: string;
  phase: "resolving" | "starting" | "initialize" | "tools-list" | "stopping" | "done";
};
