# AI SkillHub v3.3.0: MCP contract between the backend and the frontend

- **Status:** frozen for parallel implementation on 2026-10-07. Change it only by editing this file, and say what changed in the PR description.
- **Readers:** the Rust backend agent (`app-next/src-tauri/src`) and the React frontend agent (`app-next/src`).
- **Ground truth:** commit 7b71c94 on branch `claude/v3.3-experience-overhaul`. Every `file:line` below refers to 7b71c94.
  - While this contract was being written, commit d20c3b8 ("split App.tsx into page modules, no behaviour change") landed. It touches only `App.tsx`, `appShared.ts`, `components/ui.tsx`, `pages/*` and the `scripts/*.test.mjs` path helpers. No MCP source file or Rust file changed, so every MCP and Rust line reference is still valid.
  - Where this matters, the d20c3b8 location is given as "working tree".
- **Inputs:**
  - `scratchpad/v33/brief.md` (§4, §5, §6, §7)
  - `research.json` (the CC Switch study)
  - `audits.json` (the MCP UX audit)
  - `bugs.json` (13 confirmed `mcp` items)
  - `DECISIONS.md` (1245, 1323, 1334, 1173, 149)
- **Scope this round:**
  - M0-1 … M0-11
  - M1-1 in-app secrets
  - M1-2 test connection
  - M1-4 per-client results
  - M1-7 edit prefill
  - M1-8 GitHub import robustness
  - M1-9 human history and rollback confirmation
  - every confirmed MCP bug
  - the MCP rows of brief §7
- **Out of scope:**
  - M1-3, the official Registry in Discover
  - M1-5 beyond the minimum drift guard that the decisions require (§4.6)
  - M1-6, more writers
  - M2-*

---

## 0. Read this first

### 0.1 Non-negotiable invariants (both sides)

| # | Invariant | Enforced by |
|---|---|---|
| I1 | Opening the MCP page, building the snapshot, importing, parsing a paste, a GitHub import and listing templates never start a child process. Only `mcp_test_server` (a user click after the command is shown), the Discover recipe buttons and "打开文件位置" (`explorer.exe`, lib.rs:4808) may spawn one. | `mcp_center.rs`, `mcp_mutation.rs`, `mcp_library.rs`, `mcp_paste.rs`, `mcp_secrets.rs` and `mcp_json_doc.rs` contain no `Command::new` and no `.spawn(` (extends `scripts/v3.1-readonly-foundation.test.mjs:54-82`). Do **not** call `command_exists` (lib.rs:14060, it spawns `where.exe`). |
| I2 | Every write to a client config file goes through the existing transaction engine: derive the target → read and fingerprint → compute the final text → validate and verify → DPAPI snapshot → atomic replace with a fingerprint recheck → read-back verify (mcp_mutation.rs:505-719, 2434-2500). No other code writes client config files. | Rust review; §4 |
| I3 | Credential values never appear in: command return values, errors, logs, plan journals, snapshot manifests, `mcp_operations.summary_json`, plaintext SQLite columns, the search index, telemetry, or the clipboard (masked by default). A value may exist only in: HKCU\Environment (`user_env`), DPAPI blobs (`spec_protected`, `undo_protected`, snapshot backups), and the client config files the user opted into (`inline`). | Sentinel test §7.1 R21 |
| I4 | Import is read-only for client files. It writes only to SkillHub's SQLite. | R1 (hashes before = after) |
| I5 | Never create a client's directory (AGENTS.md "no fake Codex directories"). A config file may be created only inside an existing client config directory (today's rule: mcp_mutation.rs:1540-1573, 1626-1631). | `derive_target` |
| I6 | A plain-language confirmation is required **only** for: deleting a server from the library, hard-removing an entry from a client file, overwriting an entry that was changed outside SkillHub, overwriting a same-name entry with different content, rolling back from history, overwriting or deleting a user environment variable SkillHub did not create, and writing a secret value inline into a client file. Every other toggle, add or edit writes directly and shows an Undo toast. | §3.4 `needs-confirmation` |
| I7 | Files with comments or trailing commas (JSONC) stay read-only (mcp_center.rs:1019-1021, mcp_mutation.rs:1723-1738). | R6 |
| I8 | One client's failure never rolls back another client's successful write. Each target file is its own transaction. | R14 |
| I9 | The skills security scan and the default expansion of the skill tree are untouched (DECISIONS.md:149). The MCP side does not run the skills scanner, and nothing here may become a back door for it. | — |
| I10 | MCP code sends no telemetry. `record_usage_event` must never receive server names, commands, URLs, environment or header names. | Contract test F9 |

### 0.2 Decision prerequisites (DECISIONS.md entries to add, dated 2026-10-07)

The user's bold-redesign instruction of 2026-10-07 authorises these revisions. The backend agent writes them to `DECISIONS.md` in its first commit, newest first. This document assumes all of them.

1. **Revises 2026-08-25, "MCP P1 只开放可回滚的静态配置管理" (DECISIONS.md:1245).**
   - Everyday cell toggles, adds and edits write directly and show Undo. The safety engine keeps running internally: plan, fingerprint, DPAPI snapshot, atomic write, read-back.
   - Confirmation is kept only for the cases in I6.
   - A multi-client batch reports results per client; it is no longer "any failure restores all".
   - The MCP library stores full specs long-term, with sensitive parts DPAPI-protected. This replaces "command/URL/args only in process memory".
   - Credential values may be entered in the app. They go to HKCU\Environment by default and configs keep references. Inline writing happens only by explicit per-client opt-in.
2. **Revises 2026-08-07, "MCP P0 … 严格只读" (DECISIONS.md:945), and 2026-08-11 (DECISIONS.md:1108), "不启动 MCP Server".**
   - A **user-clicked** connection test may start the server. Conditions:
     - the exact command is shown first;
     - only `initialize` and `tools/list` are sent, never `tools/call`;
     - 20 s hard timeout, and the process tree is killed afterwards;
     - nothing starts automatically on paste, import, browsing, or opening the page.
   - Recipe verification (Origin) keeps its existing reviewed read-only `tools/call`.
3. **Revises 2026-08-28, "GitHub MCP 快速导入只生成可复核草稿" (DECISIONS.md:1323).**
   - Allowed now: README parsing (already in the code at mcp_github_import.rs:68-76), `/tree/<ref>/<path>` subpaths, a `raw.githubusercontent.com` fallback, and a 512 KiB README cap. Config files keep the 96 KiB cap.
   - Still allowed only: drafts, no redirects followed, no token, no execution.
4. **Reaffirms 2026-08-15 (DECISIONS.md:1173).** HKCU user environment variables are the default secret store. Machine-level variables are never written.
5. **Reaffirms 2026-08-26 (DECISIONS.md:1334)** and adds one rule: the Claude local-scope project key is normalised to the forward-slash form that Claude Code uses (§2.3). Unregistered projects stay read-only.

### 0.3 File ownership (so both agents can work in parallel)

| Area | Backend agent owns | Frontend agent owns |
|---|---|---|
| New modules | `src-tauri/src/mcp_library.rs` (library, projection, commands' core), `mcp_paste.rs` (shared parser), `mcp_probe.rs` (test connection plus the shared stdio session), `mcp_secrets.rs` (HKCU and presence checks), `mcp_json_doc.rs` (order-preserving JSON, §2.6), `mcp_templates.rs` (template data) | `src/mcp/mcpTypes.ts` (copied from §3.2), `src/mcp/mcpApi.ts`, `src/mcp/McpPage.tsx`, `McpMatrix.tsx`, `McpAddSheet.tsx`, `McpEditDrawer.tsx`, `McpHistoryDrawer.tsx`, `McpDiscover.tsx`, `McpToast.tsx`, `McpTestDialog.tsx`, `mcp.css` |
| Edited | `mcp_center.rs` (more clients, secret reference fix, Codex validation), `mcp_mutation.rs` (more hosts, executor split, writers, `validate_command`, recovery), `mcp_github_import.rs`, `mcp_recipes.rs` (uses `mcp_probe` sessions), `lib.rs` (registration at 19229-19246, context helpers next to 4575-4770), `Cargo.toml` (windows-sys feature `Win32_UI_WindowsAndMessaging`; `indexmap` is already in Cargo.lock) | `McpCenter.tsx` becomes `export { McpPage as McpCenter } from "./mcp/McpPage";` so `App.tsx` needs **no change** (7b71c94 App.tsx:384, 2202-2205; working tree App.tsx:176, 1945-1947). Also `McpRecipeCard.tsx`, `mcpManagementI18n.ts`, the MCP block of `i18n.ts`, `preview.ts` (or a new `mcpPreview.ts` re-exported from it), `scripts/v3.3-mcp-contract.test.mjs`, `scripts/v3.3-mcp-visual-qa.cjs` |
| Shared, coordinate first | `nav.connections` strings (i18n.ts:30, 1246, 2439) become "MCP". The shell agent may own the nav; whoever lands first tells the other. | `scripts/v3.1-readonly-foundation.test.mjs` was already touched by d20c3b8 and other agents may change it too. Edit only its MCP block (d20c3b8 lines 55-102: tests at 55, 65, 86). |

Sequencing: the frontend builds against the preview mocks (§6.10) from day one. The backend lands milestones in this order:
1. B1: schema, snapshot and import
2. B2: projection plus `set_cell`, `set_row` and `set_column`
3. B3: paste, add and update
4. B4: undo, history and rollback
5. B5: secrets
6. B6: test connection
7. B7: GitHub
8. B8: recipe migration

The frontend milestones are:
1. F1: page and matrix
2. F2: add sheet
3. F3: edit drawer
4. F4: toast and history
5. F5: secrets
6. F6: test
7. F7: Discover

Integration happens per pair, B*n* with F*n*.

### 0.4 Plain-language vocabulary (zh UI)

| Use | Never show in zh UI |
|---|---|
| MCP | 逻辑服务器, logical server |
| AI 工具 (Codex, Claude Code, Claude Desktop, Cursor) | 宿主, host, ChatGPT Desktop / OpenAI Codex (mcp_center.rs:205) |
| 已启用 / 未启用 / 写入失败，点按重试 / 不支持 / 只读 / 在外部被改过 | 绑定, binding, upsert, set-enabled, configured, absent, preserved |
| 测试 → 可用 · 12 个工具 / 启动失败：找不到 uvx / 需要 API Key / 未测试 | 能力未探测, unprobed, 静态验证 |
| API Key / 密钥（已隐藏） | redacted, secretReferences, inline-value-present |
| 撤销 / 历史版本 | 快照 ID, mcp-snap-…, 计划 ID, mcp-plan-…, DPAPI, 128 MiB |
| 本地命令 / 远程地址 | stdio / http / sse (allowed only under 高级) |
| 所有项目 / 某个项目 · 仅自己 / 某个项目 · 团队共享 | 作用域, 当前项目 (i18n.ts:1298) |

---

## 1. Data model

### 1.1 SQLite tables

Add the following to `ensure_runtime_schema` (lib.rs:5859, next to the other `CREATE TABLE IF NOT EXISTS` blocks at 5862-6005). The database is `private_state_dir/skillhub-next.sqlite3` (lib.rs:5826; `private_state_dir`, lib.rs:5427). Timestamps use `unix_timestamp_string()` (lib.rs:16717, unix nanoseconds as TEXT), as the rest of the database does.

```sql
-- One row per library server. The native name is the key written into every client config.
CREATE TABLE IF NOT EXISTS mcp_servers (
  id              TEXT PRIMARY KEY,              -- 'mcps-' || uuid simple
  name            TEXT NOT NULL,                 -- native key, e.g. 'context7'; immutable after creation
  name_key        TEXT NOT NULL UNIQUE,          -- lower(name)
  display_name    TEXT NOT NULL DEFAULT '',
  transport       TEXT NOT NULL,                 -- 'stdio' | 'http' | 'sse'
  spec_protected  BLOB NOT NULL,                 -- DPAPI(current user) of McpServerSpec JSON, INCLUDING library-stored secret values
  spec_revision   INTEGER NOT NULL DEFAULT 1,    -- +1 on every spec change; binds test previews and edits
  summary_json    TEXT NOT NULL,                 -- display-safe derived data only (see 1.3); NO values
  source_json     TEXT NOT NULL,                 -- McpServerSource (see 3.2)
  meta_json       TEXT NOT NULL DEFAULT '{}',    -- {description?, homepage?, docsUrl?, templateId?}; no secrets
  test_json       TEXT NOT NULL DEFAULT '',      -- last McpTestSummary + specRevision; message is secret-redacted
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  deleted_at      TEXT                           -- soft delete; purged after 7 days (undo window)
);

-- Desired and observed state per (server × client × scope). The matrix shows scope='user'.
CREATE TABLE IF NOT EXISTS mcp_server_clients (
  server_id           TEXT NOT NULL,
  client_id           TEXT NOT NULL,             -- 'codex' | 'claude-code' | 'claude-desktop' | 'cursor'
  scope               TEXT NOT NULL DEFAULT 'user',  -- 'user' | 'project' | 'local'
  workspace_id        TEXT NOT NULL DEFAULT '',  -- '' for user scope; registered workspace id otherwise
  enabled             INTEGER NOT NULL DEFAULT 0,-- desired state (user intent)
  inline_consent      INTEGER NOT NULL DEFAULT 0,-- user allowed literal secret values in THIS client file
  last_written_hash   TEXT NOT NULL DEFAULT '',  -- HMAC of the canonical entry SkillHub last wrote (1.4)
  last_seen_hash      TEXT NOT NULL DEFAULT '',  -- HMAC of the canonical entry seen at the last scan/import
  last_error_code     TEXT NOT NULL DEFAULT '',  -- McpErrorCode of the last failed write, '' when fine
  last_error_message  TEXT NOT NULL DEFAULT '',  -- secret-free zh fallback (≤280 chars)
  last_operation_id   TEXT NOT NULL DEFAULT '',
  updated_at          TEXT NOT NULL,
  PRIMARY KEY (server_id, client_id, scope, workspace_id)
);

-- Human history + undo. One row per user action (a toggle, an add to 4 clients, an import...).
CREATE TABLE IF NOT EXISTS mcp_operations (
  id                 TEXT PRIMARY KEY,           -- 'mcp-op-' || uuid simple  (== undoToken)
  created_at         TEXT NOT NULL,
  kind               TEXT NOT NULL,              -- add|enable|disable|remove|update|import|secret|undo|rollback|resync|resolve
  state              TEXT NOT NULL,              -- applying|applied|partial|failed|undone|interrupted|expired
  summary_json       TEXT NOT NULL,              -- {serverNames[], clientIds[], failedClientIds[], envVarNames[]} (names only)
  snapshot_ids_json  TEXT NOT NULL DEFAULT '[]', -- engine snapshot ids, one per target file
  undo_protected     BLOB,                       -- DPAPI: {libraryBefore, entries[{client,scope,ws,name,before,after}], envBefore[]}
  undone_by          TEXT NOT NULL DEFAULT '',
  expires_at         TEXT NOT NULL               -- created_at + 7 days (SNAPSHOT_TTL_MS, mcp_mutation.rs:29)
);

-- User environment variables SkillHub created or uses. Names only, never values.
CREATE TABLE IF NOT EXISTS mcp_env_vars (
  name                 TEXT PRIMARY KEY,
  created_by_skillhub  INTEGER NOT NULL,
  updated_at           TEXT NOT NULL
);
```

Rules:
- Do not rely on `ON DELETE CASCADE` (rusqlite leaves `foreign_keys` off). Delete child rows explicitly in the same transaction.
- Use `BEGIN IMMEDIATE` for every library mutation.
- Adding a name equal to a soft-deleted row's `name_key` hard-deletes that row first. Its history entry becomes `superseded`.
- Retention:
  - `mcp_operations`: rows older than `expires_at` are kept, with `undo_protected` set to NULL and `state` set to `expired`, up to 200 rows. Older rows are pruned.
  - Soft-deleted servers are purged with their expired operations.
- Preference keys go into the existing `operator_preferences` table (lib.rs:5924):
  - `mcp.library.initialized` = `'1'` after the first import.
  - `mcp.hash.key.v1` holds no value. The HMAC key lives in a DPAPI file, see 1.4.

### 1.2 The spec (inside `spec_protected`)

Rust-internal type in `mcp_library.rs`. It is **not** `Deserialize` from the webview; the webview sends `McpServerInput` (§3.2), which is validated and then converted.

```rust
pub(crate) struct McpServerSpec {
    pub transport: Transport,                  // Stdio | Http | Sse
    pub command: Option<String>,               // always UNWRAPPED ("npx", never "cmd"); see 2.5
    pub args: Vec<SpecArg>,                    // SpecArg { value: String, secret: bool } – secret only for imported legacy args
    pub cwd: Option<String>,
    pub env: Vec<SpecEnv>,                     // non-secret literal env AND secret env
    pub url: Option<String>,
    pub headers: Vec<SpecHeader>,
    pub codex_required: bool,
    pub client_extra: BTreeMap<String, JsonValue>, // per-client unknown keys seen at import (e.g. codex startup_timeout_sec,
                                               // claude headersHelper); projected only back into THAT client
}
pub(crate) struct SpecEnv {
    pub name: String,
    pub secret: bool,
    pub storage: SecretStorage,                // Literal (non-secret) | UserEnv | Library | External
    pub value: Option<String>,                 // Literal: always Some; Library: Some(secret); UserEnv/External: None
    pub inline_clients: Vec<ClientId>,         // clients that receive the literal value (opt-in)
    pub required: bool,
}
pub(crate) struct SpecHeader {
    pub name: String,                          // "Authorization"
    pub template: HeaderTemplate,              // Raw ("<secret>") | Bearer ("Bearer <secret>") | Literal (non-secret value)
    pub env_var: Option<String>,               // the variable that holds the secret (UserEnv/External)
    pub storage: SecretStorage,
    pub value: Option<String>,
    pub inline_clients: Vec<ClientId>,
    pub required: bool,
}
```

**What is protected and what is plain:**

| Data | Where | Protected? |
|---|---|---|
| Whole spec: command, args, url, cwd, env (names and literal values), headers, extras | `mcp_servers.spec_protected` | **DPAPI**, via `protect_private_backup` (mcp_mutation.rs:2308-2345); make it `pub(crate)` |
| Secret values in `user_env` mode | HKCU\Environment\<NAME> only | Windows profile ACL. Never stored in SQLite. |
| Secret values in `inline` / Library mode | inside `spec_protected` | DPAPI |
| Before/after entries for undo, env-var before-values | `mcp_operations.undo_protected` | DPAPI |
| Original config bytes | engine snapshot backups (mcp_mutation.rs:2270-2305) | DPAPI (unchanged) |
| Name, display name, transport, runner/package/host display, env/header **names**, `secretNames`, `missing` flags | `summary_json`, `mcp_server_clients`, `mcp_operations.summary_json` | plain (no values) |
| Cell hashes | `last_written_hash`, `last_seen_hash` | HMAC with a local key (1.4). Never a bare SHA-256 of an entry that may contain inline values. |

Non-Windows builds: `protect_private_backup` is the identity function (mcp_mutation.rs:2387-2395). That is acceptable because v3.3 is Windows-first. Note it in DECISIONS.

### 1.3 `summary_json` (display-safe, also the search source)

```json
{ "runner": "npx", "subject": "@upstash/context7-mcp", "extraArgCount": 0,
  "host": null, "envNames": ["CONTEXT7_API_KEY"], "headerNames": [],
  "secretNames": ["CONTEXT7_API_KEY"], "secretStorage": {"CONTEXT7_API_KEY": "user_env"} }
```

Derivation (replaces the English `"… · arguments redacted"` at mcp_center.rs:613-628, 1254-1261, 1297-1335):
- **stdio.** `runner` is the file stem of the command, e.g. `npx`, `uvx`, `docker`, `python`, `node`; an absolute path becomes its file stem only. `subject` is:
  - npx/pnpx/bunx/uvx/`npm exec`: the first argument that does not start with `-`, e.g. `@upstash/context7-mcp` or `mineru-open-mcp@latest`;
  - `python -m X`: `X`;
  - `node <file>`: the file name only;
  - `docker run … <image>`: the image, which is the last argument that is not a flag;
  - any other command: the first argument's file name if it looks like a path, otherwise empty.
- `extraArgCount` counts the remaining arguments; their values are never shown in the matrix.
- Paths are never shown in full in the matrix, because they may contain a user name.
- **http/sse.** `host` is the lowercase hostname only, e.g. `api.githubcopilot.com`. No path, query or port.
- Search matches `name`, `displayName`, `runner`, `subject` and `host` only. It never matches env, header names or args (CC Switch allow-list, UnifiedMcpPanel.tsx L52-76).

### 1.4 Canonical entry and hash

- `canonical_entry(client, entry)`:
  1. Parse the entry and keep only the **managed keys** of that client (§2.4).
  2. Unwrap `cmd /c <runner>`.
  3. Normalise `type` (missing means it is inferred from command/url) and `streamable-http` to `http`.
  4. Drop a Codex `enabled = true` key.
  5. Sort keys recursively and serialise compactly.
- Unknown keys are ignored for comparison and preserved on write.
- `entry_hash = HMAC-SHA256(k_local, canonical_bytes)`, hex.
  - `k_local` is 32 bytes generated once (two `Uuid::new_v4()`, ≥244 random bits), stored DPAPI-protected at `private_state_dir/mcp-library/hash.key`.
  - Implement HMAC over the existing `sha2` crate; no new dependency is required.
  - Reason: entries may contain inline values, and a bare hash would allow offline guessing.

### 1.5 Migration and first-run import (no write-back)

- **Schema:** the tables are created idempotently at database open. No data migration is needed: there was no MCP table before 3.3, as `migrations/001_initial.sql` shows.
- **When import runs:**
  - The import never runs inside `mcp_library_snapshot`, which stays read-only.
  - The snapshot returns `libraryInitialized: false` until `operator_preferences['mcp.library.initialized'] = '1'`.
  - The frontend then calls `mcp_import_from_clients({reason:"first-run"})` automatically, once, without a click, and shows the report as a non-blocking notice: "已从 AI 工具导入 5 个 MCP（只读进来，没有改动任何工具配置）· 查看".
  - Onboarding (S1-8) calls the same command with `reason:"onboarding"` when its "导入它们已有的 N 个 MCP" option is ticked. N is `snapshot.unimported.length`. If the user unticks it, onboarding sets the flag without importing; later imports come from the header button.
- **What import reads** (scanner `mcp_center::scan_read_only`, extended in §2):
  - user scope of the four clients;
  - Claude local and project bindings and Codex project configs of registered workspaces;
  - Claude-known projects from `~/.claude.json`, bounded at 128 (mcp_center.rs:16, 402-569).
  - **It writes nothing outside SQLite.**
- **Import algorithm** (deterministic):
  1. Group by `name_key`. For each group, the first source in client order `codex, claude-code, claude-desktop, cursor`, user scope before project scope, becomes the spec when the library has no row.
     - The spec takes the full entry: Windows `cmd /c` unwrapped; inline env and header values moved into Library storage with `secret` set by the name heuristic in §3.6; `${VAR}` / `${env:VAR}` / Codex `env_vars` / `env_http_headers` / `bearer_token_env_var` become UserEnv or External references; unknown keys go into `client_extra[client]`.
  2. For every (server, client, scope) where the entry exists:
     - upsert `mcp_server_clients` with `enabled = 1`, or `0` for Codex `enabled = false`;
     - `last_seen_hash = hash(file entry)`;
     - `last_written_hash = ''`, since SkillHub did not write it.
     - If `hash(projection(spec, client)) != hash(file entry)`, the cell shows `changed-outside` (CC Switch's "library wins" rule without the silent overwrite).
  3. Entries SkillHub cannot represent are **not** imported and are listed in `skipped` with a reason:
     - Codex structured `env_vars` objects (mcp_center.rs:821-827; guard mcp_mutation.rs:1808-1816);
     - unknown `type` values;
     - invalid names.
  4. Write `operator_preferences['mcp.library.initialized']='1'`.
  5. Record an `mcp_operations` row of kind `import`. `undoAvailable` is false; the entry is informational.
- **Report:** see `McpImportReport` (§3.2). It contains:
  - `added`, the new library servers;
  - `merged`, same name and same content, where only the client flags were turned on;
  - `differing`, same name with different content, left untouched and marked;
  - `skipped`, with reasons;
  - `filesRead`, each with path display and parse status. This replaces the "配置诊断" block at McpCenter.tsx:820-877.
- **Acceptance R1:** the SHA-256 of every client file before and after import is identical.

---

## 2. Client registry

### 2.1 The four writable clients (v3.3.0)

`ClientId` ↔ engine host id. Add `HOST_CLAUDE_DESKTOP = "host-claude-desktop"` and `HOST_CURSOR = "host-cursor"` next to mcp_mutation.rs:34-35.

| ClientId | Label | Engine host | User-scope file (Windows) | Exists-evidence: column `detected` | `writable` when | Transports | Secret references | Disable means |
|---|---|---|---|---|---|---|---|---|
| `codex` | Codex | `host-codex` | `~/.codex/config.toml` | the `~/.codex` directory exists, or the cached `agents` row for `codex` has `detected=1` | `~/.codex` is a real directory (not a symlink) and the file is missing or parses (mcp_mutation.rs:1540-1548, 1723-1729) | stdio, http (no sse, 1200-1202) | env: `env_vars = ["NAME"]`. Header: whole-value `env_http_headers = {H = "NAME"}`. `Authorization: Bearer` uses `bearer_token_env_var = "NAME"`. | `enabled = false`, the entry stays |
| `claude-code` | Claude Code | `host-claude-code` | `$CLAUDE_CONFIG_DIR/.claude.json` if `CLAUDE_CONFIG_DIR` is set (process env or HKCU), else `~/.claude.json`. Today only `~/.claude.json` is used (1563-1573); align with skills delivery, lib.rs:2556-2561. Top-level `mcpServers` | the file exists, or the `~/.claude` directory exists | strict JSON (1019-1021) | stdio, http, sse | `${NAME}` in env, args, url and headers; `"Authorization": "Bearer ${NAME}"` | **remove the entry**; the library keeps the spec |
| `claude-desktop` | Claude Desktop | `host-claude-desktop` | MSIX: `%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\claude_desktop_config.json` when that `…\LocalCache\Roaming\Claude` directory exists. Otherwise `%APPDATA%\Claude\claude_desktop_config.json`. Top-level `mcpServers`. Same package path as lib.rs:2539-2545. | either directory exists | strict JSON; preserve `preferences`, `coworkUserFilesPath` and unknown keys (seen on this machine) | **stdio only** | **none.** Child processes do not inherit arbitrary user variables, so secrets need per-client inline consent (`needs-inline-consent`). | remove the entry |
| `cursor` | Cursor | `host-cursor` | `~/.cursor/mcp.json`, top-level `mcpServers` | the `~/.cursor` directory exists | strict JSON; JSONC means read-only | stdio, http (`url`), sse (`url`) | `${env:NAME}` in env, args, url and headers | remove the entry |

- **Columns** = clients with `detected || any enabled cell`.
- A client that is detected but not writable shows a column with all cells `readonly` and the reason in the column tooltip and in the issue strip.
- Adapters that are not supported this round go into a collapsed `otherClients` chip, "其他 6 个工具（暂不支持 MCP）". Their reasons come from `agent_adapter_catalog`, lib.rs:16182-16271. The list replaces the hard-coded `SUPPORTED_MCP_HOSTS` at McpCenter.tsx:253-256.
- **Detection may read the filesystem and SQLite only.** No `where.exe` (I1).

### 2.2 Name rules

- New library names: `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`, which is the strictest common rule, and not one of the Claude reserved names (mcp_mutation.rs:1149-1155; mcpManagement.ts:35-41).
- Imported dotted names, e.g. Codex `team.docs`, are kept as is. Every Claude Code, Claude Desktop and Cursor cell for that server is `unsupported` with reason `name-incompatible`.
- Names are immutable after creation; to rename, create a new server and delete the old one. CC Switch has the same rule.

### 2.3 Scopes and the Claude local key (bug MCP#5)

- **The matrix is user scope only.** Project and local bindings are listed in the edit drawer's "项目" section, together with `McpServerRow.projectBindings`.
  - Claude `projects[<key>].mcpServers` (local) and Codex `<ws>/.codex/config.toml` (project) are writable only for registered workspaces. This is today's rule (mcp_mutation.rs:1549-1598; mcpManagement.ts:71-74).
  - Otherwise they are `readonly` with reason `not-registered`.
  - Claude `<project>/.mcp.json` is `readonly` with reason `team-shared-file` in the drawer. Writing it stays available only under 高级 in the add sheet, for registered workspaces, exactly as today.
- **Local key normalisation.** `claude_servers_mut` (1857-1883) and `claude_servers_ref` (2204-2230) must resolve the projects key as follows:
  1. Iterate `projects.keys()`.
  2. Normalise each key: strip `\\?\`, replace `\` with `/`, trim a trailing `/`, compare case-insensitively on Windows. Reuse `mcp_center::paths_equivalent` (1388-1403) after making it `pub(crate)`.
  3. Exactly one match: use that key.
  4. No match: insert `workspace_path.to_string_lossy().replace('\\', "/")`.
  5. More than one equivalent key **with** `mcpServers`: refuse with `config-ambiguous-project`. Never guess.
- The workspace page is being removed (brief §2 #2). Workspaces already registered in SQLite keep working (lib.rs:4671-4697). Registering new projects is P2 (M2-5).

### 2.4 Projection rules: managed keys per client

`project(spec, client, consent) -> Result<ProjectedEntry, Unsupported(reason)>`. Unknown keys of an existing entry are preserved in place. Managed keys are set or removed so that the entry is exactly valid for its transport. **Transport switch:** every managed key that is invalid for the new transport is removed (bug MCP#4). The library holds the values, so nothing is lost.

| Managed key | Codex (TOML, toml_edit, in place) | Claude Code (JSON) | Claude Desktop (JSON) | Cursor (JSON) |
|---|---|---|---|---|
| `type` | **never written** (mcp_mutation.rs:4108 asserts this) | `"stdio" \| "http" \| "sse"` (today: 1925-1928) | omitted | omitted |
| command, args | stdio only | stdio only, `cmd /c` wrapping §2.5 | stdio only, wrapped | stdio only, not wrapped (verify, §8) |
| cwd | stdio only, if set | not written | not written | not written |
| env (literal values) | stdio: `env` table. Keep an existing `[mcp_servers.x.env]` sub-table as a sub-table (user config shape). | `env` object | `env` object | `env` object |
| env (reference) | `env_vars = ["NAME", …]`, written **only when non-empty** | `"NAME": "${NAME}"` | needs inline consent; otherwise `Unsupported(needs-inline-consent)` | `"NAME": "${env:NAME}"` |
| url | http only | http/sse | n/a | http/sse |
| headers (literal or inline) | http: `http_headers` | `headers` | n/a | `headers` |
| header raw reference | http: `env_http_headers = {H = "NAME"}`, **only when non-empty** | `"H": "${NAME}"` | n/a | `"H": "${env:NAME}"` |
| header Bearer reference | `bearer_token_env_var = "NAME"` (Authorization only). A Bearer on another header name is `needs-inline-consent`. | `"Authorization": "Bearer ${NAME}"` | n/a | `"Authorization": "Bearer ${env:NAME}"` |
| enabled | write `enabled = false` when disabled. When enabling: set `true` if the key existed, otherwise leave it absent. Never add noise. | n/a (absence means off) | n/a | n/a |
| required | write `required = true` only when `codex_required`; otherwise **remove** (bug #40) | n/a | n/a | n/a |

Per transport, keys that must be **absent** after projection. These are also checked in `validate_codex_mcp_config` (mcp_center.rs:866-868), so `verify_written_config` (mcp_mutation.rs:2232-2268) rejects bad output (bugs MCP#1, #4):

| Client | stdio must not contain | http/sse must not contain |
|---|---|---|
| Codex | `url`, `http_headers`, `env_http_headers`, `bearer_token_env_var`, `bearer_token`, `oauth` | `command`, `args`, `env`, `env_vars`, `cwd` |
| Claude Code, Cursor | `url`, `headers` | `command`, `args`, `env` |

### 2.5 Windows command wrapping (bug #5)

- **Write.** Target `claude-code` or `claude-desktop` on Windows, command file stem (lowercased, `.cmd`/`.exe` stripped) ∈ {`npx`, `npm`, `pnpm`, `yarn`, `node`, `bun`, `deno`}: write `"command": "cmd"` and `"args": ["/c", "<command as stored>", …args]`.
  - Codex and Cursor are **not** wrapped this round. Verify on real machines, §8 Q1-Q2.
  - Skip wrapping for absolute command paths that end in `.exe`, which can start without a shell.
- **Import and display.** If `command` ∈ {`cmd`, `cmd.exe`} (case-insensitive), `args[0]` equals `/c` (case-insensitive) and the file stem of `args[1]` is in the family, store `command = args[1]` and `args = args[2..]`. The UI never shows the wrapper.
- **Validate.** `validate_command` (mcp_mutation.rs:1260-1299) still rejects shells and script hosts (1282-1297) with one exception: `cmd` / `cmd.exe` is accepted only when the full argument list matches `^/c$` followed by a family runner, case-insensitive.
  - In that form, **every following argument** must not contain any of `& | < > ^ % " ( ) !` or a newline, because `cmd` interprets them.
  - `/k`, `/s`, `/d`, `cmd` with no arguments, `cmd /c powershell …` and `cmd /c "npx & calc"` are all rejected.
  - This exception lives in a new `validate_command_with_args(command, args)`. Callers that pass only the command keep the old strict behaviour.
- **GitHub and paste.** Candidates in the `cmd /c npx …` form (mcp_github_import.rs:315-322) are unwrapped at parse time, so they never hit `validate_command`.

### 2.6 Preserving file format

- **TOML (Codex):** keep using `toml_edit::DocumentMut`. Update the existing entry table **in place**, so keys keep their position and comments and decor survive. Append new keys at the end. Never rewrite other tables.
- **JSON (Claude Code, Claude Desktop, Cursor), bug MCP#12.** Today the writer parses into `serde_json::Value`, which is a `BTreeMap` because `preserve_order` is off, and re-serialises with `to_string_pretty` (mcp_mutation.rs:1756-1767). That sorts every key in `~/.claude.json`. **Use Option B:**
  - Add `mcp_json_doc.rs`, an order-preserving JSON value: an enum with `IndexMap<String, Node>` objects, a custom `Deserialize` through `deserialize_any`, and serialisation through `serde_json::ser::PrettyFormatter::with_indent(detected_indent)`.
  - `indexmap` 2.x is already in Cargo.lock, so no new download.
  - Detect the indent from the first indented line (2 or 4 spaces, or a tab); the default is 2 spaces.
  - Keep or omit the trailing newline as in the original.
  - Do **not** enable `serde_json/preserve_order` globally in this round. It would change `json!` output order crate-wide, and these places compare or persist JSON text: migration_v4.rs:823, 2884; prompt_launcher.rs:118. Those need an audit first.
- **Acceptance R12:** a one-entry change on a fixture `~/.claude.json` with 40 top-level keys produces a diff that touches only that entry's lines.

### 2.7 Reading rules (scanner, `mcp_center.rs`)

- Add `scan_claude_desktop` and `scan_cursor` next to `scan_codex` / `scan_claude` (227-228). The hosts list (201-218) gets four entries, and Codex is called "Codex" (205; bug #28).
- `McpHost.config_count` stays a file count (230-236), but the UI no longer shows it. Matrix counts are server counts.
- **Secret reference fix (bug MCP#7).** `collect_json_inline_map_requirements` (1128-1143) must look at values:
  - a string that fully matches `${NAME}`, `${NAME:-default}` or `${env:NAME}` with a valid name becomes `env_requirement(NAME, "process-env" | "http-header-env")`;
  - for headers, a `Bearer ${NAME}` value becomes `bearer-token-env`;
  - only literal values are `inline-value-present`.
- **Presence (`env_requirement`, 1161-1172).** It must use `mcp_secrets::env_var_present(name)`: the process env **or** HKCU\Environment **or** HKLM `…\Session Manager\Environment`. All are registry reads, with no spawn. The process environment is stale after the user saves a key in the app.
- The size limit stays at 2 MiB (mcp_center.rs:15, mcp_mutation.rs:24). A larger file is reported per client as `config-too-large`, with "打开文件位置". See §8 Q4.

---

## 3. Tauri command API

### 3.1 Conventions

- Every new command is `async`, runs its work in `spawn_blocking` (pattern `run_blocking_task`, lib.rs:1366-1374), takes exactly one argument named `request` (an object, possibly `{}`), and returns `Result<T, McpError>`. `McpError` is a serialisable struct, so the frontend receives an object in `catch`.
- **Write commands:**
  - acquire `MCP_MUTATION_LOCK` (lib.rs:78) with a **bounded wait**: poll `try_lock` every 50 ms for up to 5 s, then return `busy`. Today the code fails immediately (lib.rs:4716-4724);
  - the engine also takes the cross-process lock (mcp_mutation.rs:2931-2947);
  - write commands are serialised;
  - after completing, a write command emits `mcp-library-changed`.
- **Read commands** (`mcp_library_snapshot`, `mcp_get_server`, `mcp_history`, `mcp_list_templates`, `mcp_test_preview`, `mcp_export_json`, `mcp_parse_paste`, `mcp_import_github`) never take the lock and never run crash recovery. This fixes bug MCP#10, where `list_mcp_rollback_snapshots` took the guard, lib.rs:4758-4764.
- **`generation`:** a process-wide `AtomicU64`, incremented after every write. It is returned in snapshots and outcomes. The frontend drops any snapshot whose generation is older than the newest it has seen (DECISIONS 2026-08-26, mutation generation).
- **Confirmation protocol:**
  1. A write command first computes everything (targets, final text, verification) **without writing**.
  2. If any I6 condition applies and `request.confirmToken` is missing or does not equal the freshly computed token, it returns `{kind:"needs-confirmation"}`.
  3. `confirmToken = hex(HMAC(k_local, canonical(descriptor) ‖ each target's current sha256 ‖ request digest))`.
  4. The token has **no time limit**. If the files changed, the token simply no longer matches and the command returns a fresh descriptor; this is not an error.
  5. Calling the same command again with the token performs the write.
- **No values in errors.** Engine errors are already secret-free zh strings (mcp_mutation.rs tests 3676-3760). They map to `code: "engine"` with the message kept. New errors use explicit codes (§3.5).

### 3.2 Types (ready to copy to `app-next/src/mcp/mcpTypes.ts`)

The Rust structs in `mcp_library.rs` mirror these field for field:
- `#[serde(rename_all = "camelCase")]` on structs;
- string enums with `#[serde(rename_all = "kebab-case")]`, except `user_env` / `inline` / `library` / `external` / `none`, which use `snake_case`;
- tagged unions with `#[serde(tag = "kind", rename_all = "kebab-case", rename_all_fields = "camelCase")]`.

Requests use `#[serde(deny_unknown_fields)]`.

```ts
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
```

### 3.3 Frontend wrapper (`app-next/src/mcp/mcpApi.ts`)

```ts
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import * as T from "./mcpTypes";

const isDesktop = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function call<R>(command: T.McpCommand, request: object = {}): Promise<R> {
  if (!isDesktop()) {
    const { previewMcp } = await import("../preview");      // §6.10
    return previewMcp<R>(command, request);
  }
  try {
    return await invoke<R>(command, { request });
  } catch (raw) {
    throw toMcpError(raw);
  }
}

export function toMcpError(raw: unknown): T.McpError {
  if (raw && typeof raw === "object" && "code" in raw && "message" in raw) return raw as T.McpError;
  const message = raw instanceof Error ? raw.message : String(raw ?? "");
  return { code: "engine", message: message.length > 280 ? `${message.slice(0, 277)}…` : message };
}

export const mcpApi = {
  snapshot:          ()                          => call<T.McpLibrarySnapshot>("mcp_library_snapshot"),
  getServer:         (serverId: string)          => call<T.McpServerDetail>("mcp_get_server", { serverId }),
  templates:         ()                          => call<T.McpTemplate[]>("mcp_list_templates"),
  history:           (r: T.McpHistoryRequest = {}) => call<T.McpHistoryEntry[]>("mcp_history", r),
  importFromClients: (r: T.McpImportRequest)     => call<T.McpImportReport>("mcp_import_from_clients", r),
  setCell:           (r: T.McpSetCellRequest)    => call<T.McpWriteOutcome>("mcp_set_cell", r),
  setColumn:         (r: T.McpSetColumnRequest)  => call<T.McpWriteOutcome>("mcp_set_column", r),
  setRow:            (r: T.McpSetRowRequest)     => call<T.McpWriteOutcome>("mcp_set_row", r),
  parsePaste:        (text: string)              => call<T.McpPasteResult>("mcp_parse_paste", { text }),
  importGithub:      (source: string)            => call<T.McpPasteResult>("mcp_import_github", { source }),
  addServers:        (r: T.McpAddRequest)        => call<T.McpWriteOutcome>("mcp_add_servers", r),
  updateServer:      (r: T.McpUpdateRequest)     => call<T.McpWriteOutcome>("mcp_update_server", r),
  removeServer:      (r: T.McpRemoveRequest)     => call<T.McpWriteOutcome>("mcp_remove_server", r),
  undo:              (undoToken: string)         => call<T.McpWriteOutcome>("mcp_undo", { undoToken }),
  rollback:          (r: T.McpRollbackRequest)   => call<T.McpWriteOutcome>("mcp_rollback", r),
  setSecret:         (r: T.McpSetSecretRequest)  => call<T.McpWriteOutcome>("mcp_set_secret", r),
  testPreview:       (serverId: string)          => call<T.McpTestPreview>("mcp_test_preview", { serverId }),
  testServer:        (r: T.McpTestRequest)       => call<T.McpTestResult>("mcp_test_server", r),
  exportJson:        (r: T.McpExportRequest)     => call<T.McpExportResult>("mcp_export_json", r),
  resync:            (r: T.McpResyncRequest = {}) => call<T.McpWriteOutcome>("mcp_resync", r),
  resolveChange:     (r: T.McpResolveChangeRequest) => call<T.McpWriteOutcome>("mcp_resolve_changed_outside", r),
  resolveStuck:      (r: T.McpResolveStuckRequest)  => call<T.McpWriteOutcome>("mcp_resolve_stuck_transaction", r),
  openConfigLocation:(r: T.McpOpenLocationRequest)  => call<void>("mcp_open_config_location", r),
  onLibraryChanged(cb: (e: T.McpLibraryChangedEvent) => void): Promise<UnlistenFn> {
    return isDesktop()
      ? listen<T.McpLibraryChangedEvent>(T.MCP_LIBRARY_CHANGED_EVENT, e => cb(e.payload))
      : import("../preview").then(m => m.previewMcpSubscribe(cb));
  },
  onTestProgress(cb: (e: T.McpTestProgressEvent) => void): Promise<UnlistenFn> {
    return isDesktop()
      ? listen<T.McpTestProgressEvent>(T.MCP_TEST_PROGRESS_EVENT, e => cb(e.payload))
      : Promise.resolve(() => {});
  }
};
```

Rules for the frontend:
- Never call `invoke` for MCP outside `mcpApi.ts` (contract F1).
- Keep a per-page **write queue**: one write in flight; later toggles wait. Never fire concurrent writes.
- Clear secret inputs from React state right after the request resolves or rejects.

### 3.4 Command reference

All commands are registered in `tauri::generate_handler!` next to lib.rs:19240-19246. Signature pattern:

```rust
#[tauri::command]
async fn mcp_set_cell(
    app: tauri::AppHandle,
    request: mcp_library::McpSetCellRequest,
) -> Result<mcp_library::McpWriteOutcome, mcp_library::McpError> {
    let outcome = mcp_library::run_write(move |ctx| mcp_library::set_cell(ctx, request)).await?;
    mcp_library::emit_changed(&app, &outcome);   // emits "mcp-library-changed" when kind == "done"
    Ok(outcome)
}
```

- `mcp_library::run_write` does the following:
  1. Builds `McpLibraryContext { mutation: mcp_mutation_context()?` (lib.rs:4700-4714), `db_path, platform, hash_key_path }`.
  2. Takes the bounded guard.
  3. Runs `spawn_blocking`.
  4. Maps `JoinError` to `McpError{code:"engine"}`.
- `run_read` is the same without the guard.
- All commands are `async`. None blocks the UI thread; this also addresses the rust-core finding at lib.rs:3479.

| Command (Rust name) | Request → Response | Lock | Confirms (I6) | Behaviour | Errors |
|---|---|---|---|---|---|
| `mcp_library_snapshot` | `McpEmptyRequest` → `McpLibrarySnapshot` | none | – | Pure reads: SQLite, the four client files, registered workspaces (lib.rs:4671-4697), HKCU presence. Recomputes cell states (§4.6). **No spawn, no import, no recovery.** Target under 150 ms with 4 files. | `config-*` appear as cell/issue data, never as a thrown error. A thrown error only means the database is unavailable (`engine`). |
| `mcp_get_server` | `McpGetServerRequest` → `McpServerDetail` | none | – | Edit-drawer prefill (M1-7): full command, args (secret-like args masked), url, non-secret env, secret **status**. | `not-found` |
| `mcp_list_templates` | `{}` → `McpTemplate[]` | none | – | Static data from `mcp_templates.rs` (§3.7). | – |
| `mcp_history` | `McpHistoryRequest` → `McpHistoryEntry[]` | none | – | Newest first. Includes legacy committed snapshots from `read_snapshot_manifests` (mcp_mutation.rs:2861-2893) as `kind:"legacy"`, read-only, without recovery. | – |
| `mcp_import_from_clients` | `McpImportRequest` → `McpImportReport` | write | – | §1.5. Writes SQLite only. Emits `reason:"import"`. | `busy` |
| `mcp_set_cell` | `McpSetCellRequest` → `McpWriteOutcome` | write | `changed-outside` when the entry was edited outside; `inline-secret` when enabling a client that needs a literal secret and `allowInline` is not set (the descriptor lists the secret **names**) | Enable: project the spec (§2.4), run one-target transaction (§4.2). Disable: Codex sets `enabled=false`; JSON clients remove the entry while the library keeps the spec. Unsupported or blocked: `noop` + the cell state explains. | `busy`, `not-found`, the per-client error goes into `results[0].error` (still `kind:"done"`, `status:"failed"`) |
| `mcp_set_column` | `McpSetColumnRequest` → `McpWriteOutcome` | write | `changed-outside` for listed items | `enabled:true` without `serverIds` = "启用其余 N 个": every server that is off and supported for this client. With `serverIds` = only the searched ones. `enabled:false` = all on. **One transaction for this client's file** (changes chunked at 64, validate_batch mcp_mutation.rs:1094); unsupported ones go to `skipped`. | as above |
| `mcp_set_row` | `McpSetRowRequest` → `McpWriteOutcome` | write | `changed-outside` | `clientIds` absent = every writable column. One transaction per client file, executed sequentially in client order. Per-client results (M1-4). "从所有 AI 工具移除" is `enabled:false`: the library keeps the server, so **no confirmation**. | as above |
| `mcp_parse_paste` | `McpParsePasteRequest` → `McpPasteResult` | none | – | §3.6. No writes. Pasted secret values go to an in-memory `PasteVault` (≤ 64 handles, 15 min TTL, cleared after use) and **are not returned**. | `paste-too-large` (>256 KiB), `paste-unrecognized` (returned as `format:"unrecognized"`, not thrown) |
| `mcp_import_github` | `McpGithubRequest` → `McpPasteResult` | none | – | §3.8 (M1-8). Network only to `api.github.com` and `raw.githubusercontent.com`. Old `import_mcp_github_config` stays registered, unchanged. | `github-*` |
| `mcp_add_servers` | `McpAddRequest` → `McpWriteOutcome` | write | `overwrite-different` for a same-name conflict the user did not explicitly choose (`onConflict:"overwrite"` from the batch list counts as confirmed **only** for conflicts that list showed); `changed-outside`; `overwrite-env-var`; `inline-secret` | Steps: (1) validate inputs (2.2, 2.5, URL rules mcp_mutation.rs:1417-1447); (2) insert or update `mcp_servers` + operation row; (3) apply HKCU vars (§3.9); (4) per-client transactions; (5) set cells. Unsupported clients are `skipped` with a reason, not an error. The result `undoToken` undoes the whole add. | `invalid-input`, `invalid-name`, `name-taken` (when `onConflict` is missing), `paste-expired` (frontend re-parses silently and retries once) |
| `mcp_update_server` | `McpUpdateRequest` → `McpWriteOutcome` | write | `changed-outside` for clients whose entry was edited outside | Name must equal the stored name. `expectedRevision` must match, otherwise `revision-conflict`. Transport switch clears incompatible spec fields (stdio→http drops command, args, env and cwd; http→stdio drops url and headers; HKCU vars are untouched). Re-projects to every enabled cell. Omitted secret `value` keeps the stored value. | `revision-conflict`, `invalid-*` |
| `mcp_remove_server` | `McpRemoveRequest` → `McpWriteOutcome` | write | **always** on the first call: `remove-from-library` (lists every client entry to be removed and the SkillHub-created env vars that would become unused, unticked by default) or `remove-from-client` (Codex: delete the entry instead of only disabling it) | Library removal soft-deletes the server and removes every client entry (user, local and project scopes that are writable). Readonly bindings are listed as "保持不变". | `not-found` |
| `mcp_undo` | `McpUndoRequest` → `McpWriteOutcome` | write | none (toast affordance right after the action) | §4.4 entry-level undo per client plus restoring the library before-state and env vars. Records an `undo` operation, so it can be undone too. Conflicts are reported per client. | `undo-unavailable` |
| `mcp_rollback` | `McpRollbackRequest` → `McpWriteOutcome` | write | **always** `rollback` on the first call (fix for McpCenter.tsx:805-813) | `operationId`: same as undo, from the history drawer. `legacySnapshotId`: the pre-3.3 byte-level `rollback_mcp_snapshot` (mcp_mutation.rs:876-1043), with a descriptor listing files. | `undo-unavailable`, `undo-conflict` (per client inside `results`) |
| `mcp_set_secret` | `McpSetSecretRequest` → `McpWriteOutcome` | write | `overwrite-env-var` when HKCU already has the name and SkillHub did not create it; `inline-secret` when `mode:"inline"` | §3.9. Re-projects affected enabled cells, e.g. adds the `env_vars` reference. Value is never returned or logged. | `secret-name-invalid`, `secret-name-reserved`, `secret-value-invalid`, `env-write-failed` |
| `mcp_test_preview` | `McpTestPreviewRequest` → `McpTestPreview` | none | – | Builds the exact command line (or URL), resolves the runner on the effective PATH **without spawning** (§3.10), lists missing secrets, returns `previewToken = HMAC(k_local, serverId‖specRevision‖commandLine‖url)`. | `not-found` |
| `mcp_test_server` | `McpTestRequest` → `McpTestResult` | test lock (§3.10), not the write lock | the UI shows the preview before the first test per `specRevision` | Requires a `previewToken` that matches the current revision, otherwise `status:"stale-preview"`. Starts the process, sends `initialize`, `notifications/initialized` and `tools/list` only, with a 20 s deadline, then kills the tree. HTTP: POST `initialize` + `tools/list`. Saves `test_json`. Emits `mcp-test-progress`, then `mcp-library-changed{reason:"test"}`. | `test-preview-required`, `test-busy` |
| `mcp_export_json` | `McpExportRequest` → `McpExportResult` | none | – | Masked export: every secret value becomes `SECRET_MASK`; references stay (`${NAME}`); masked args stay masked. There is no "reveal" in 3.3.0 (§8 Q6). | – |
| `mcp_resync` | `McpResyncRequest` → `McpWriteOutcome` | write | `changed-outside` / `resync` listing every entry that differs from the library | "按这里的开关重写各工具配置" (⋯ menu). Also used by the `windows-fix` and `out-of-date` issue actions, which need no confirmation because the content is semantically equal or was written by SkillHub. | – |
| `mcp_resolve_changed_outside` | `McpResolveChangeRequest` → `McpWriteOutcome` | write | `take:"library"`: `changed-outside`. `take:"file"`: `resync`, listing the other enabled clients that will receive the adopted version. | Minimum M1-5 needed for the decision guard (I6). `file` re-imports that client's entry into the spec, then re-projects to the other enabled clients. | – |
| `mcp_resolve_stuck_transaction` | `McpResolveStuckRequest` → `McpWriteOutcome` | write | – | Fix for bug MCP#2: marks a non-committed manifest `abandoned-external-change`, keeps the current files, unblocks later writes. | `not-found` |
| `mcp_open_config_location` | `McpOpenLocationRequest` → `void` | none | – | Resolves the path in Rust (the webview never sends paths) and calls `open_path_with_system` (lib.rs:4808, `explorer /select,`). | `client-not-installed` |

**Events:**
- `mcp-library-changed` (`McpLibraryChangedEvent`), emitted after each `done` write, after import, and after a test result is saved.
  - Consumers: the MCP page refetches the snapshot when `generation` is newer.
  - The AI 工具 page (pages/Agents.tsx in the working tree) refreshes "MCP N".
  - The Discover recipe card re-derives its client status (bug MCP#9).
- `mcp-test-progress` (`McpTestProgressEvent`).

### 3.5 Error codes, plain-language copy and actions (S1-9)

The frontend maps each `code` to i18n `mcp.err.<code>` (zh, en, ko) and shows one action button. zh examples:

| code | zh copy (template) | action |
|---|---|---|
| `busy` | 另一项 MCP 操作还没完成，请稍候。 | auto-retry once after 1 s |
| `config-jsonc` | {client} 的配置文件里有注释，SkillHub 只读不写。 | 打开文件位置 |
| `config-parse-failed` | {client} 的配置文件格式有误，SkillHub 没有改动它。 | 打开文件位置 |
| `config-too-large` | {client} 的配置文件超过 2 MB，SkillHub 不写入。 | 打开文件位置 |
| `config-changed` | {client} 正在改写自己的配置，稍后点按重试。 | 重试 (the backend already retried twice, §4.2) |
| `client-not-installed` | 没有检测到 {client}。 | – |
| `transport-unsupported` | {client} 只支持本地命令方式的 MCP。 | – |
| `codex-structured-env` | 这一项使用了 SkillHub 暂不支持的写法，保持只读。 | 打开文件位置 |
| `stuck-transaction` | 上次写入 {client} 时被中断，文件之后又被改过。 | 保留现在的文件 (`resolve-stuck`) |
| `secret-name-reserved` | {name} 是系统变量名，不能用来保存密钥。 | – |
| `env-write-failed` | 没能保存到当前用户环境变量。 | 重试 |
| `paste-unrecognized` | 没认出这段配置。支持 mcpServers JSON、Codex TOML、VS Code、OpenCode 的写法。 | – |
| `github-moved` | 这个 GitHub 仓库已改名或迁移，请用新的 owner/repo。 | – |
| `github-rate-limited` | GitHub 暂时限制了访问，请稍后再试。 | 重试 |
| `undo-conflict` | {client} 里的 {server} 之后又被改过，没有撤销这一项。 | 打开文件位置 |
| `revision-conflict` | 这个 MCP 刚被改过，已重新载入。 | (reload the drawer) |
| `engine` | (backend zh message as-is) | 导出排错报告 (S1-9) |

### 3.6 Paste parser (`mcp_paste.rs`, M0-6): shared by paste, GitHub and import

- **Input:**
  1. Strip a surrounding code fence (`` ``` `` with any language).
  2. Remove a BOM.
  3. JSONC tolerance: comments and trailing commas, reusing the logic of `strip_json_comments` / `strip_json_trailing_commas` (mcp_center.rs:1023-1126), made `pub(crate)`.
- **Recognition order:**

| # | Shape | Format |
|---|---|---|
| 1 | Text has a line matching `^\s*\[mcp_servers\.` | `codex-toml` (toml_edit). `[mcp_servers.x.env]` sub-tables, `env_vars`, `env_http_headers` and `bearer_token_env_var` are understood. |
| 2 | Object with `mcpServers` | `mcp-servers` |
| 3 | Object with `servers`, or `mcp.servers` (VS Code; `type`; `${input:x}` placeholders) | `vscode` |
| 4 | Object with `mcp` whose values have `type: "local" \| "remote"` or an array `command` | `opencode`: `command[0]` becomes command, the rest become args; `environment` becomes env; `remote` becomes http + headers |
| 5 | Object with `mcp_servers` (JSON) | `codex-json` |
| 6 | Object that itself has `command` (string or array) or `url` | `single`: no name, so `nameSuggested` |
| 7 | Object whose every value has the shape of #6 | `named` |
| 8 | Text like `"name": { … }` without outer braces | try `{` + text + `}`, then rule #7 |

- **Normalisation:**
  - `streamable-http` / `streamableHttp` becomes `http`.
  - Missing `type`: http if there is a `url` and no `command`, otherwise stdio.
  - `http_headers` becomes headers.
  - `cmd /c` unwrap (§2.5) with warning `windows-cmd-unwrapped`.
- **Suggested name** for `single`:
  - npm scope stripped and common affixes dropped: `@upstash/context7-mcp` → `context7`, `mcp-server-fetch` → `fetch`, `@modelcontextprotocol/server-memory` → `memory`, `@playwright/mcp` → `playwright`;
  - for a URL, the second-level host label: `api.githubcopilot.com` → `githubcopilot`;
  - the result is sanitised to the name rule (§2.2).
- **Secrets:**
  - An env or header value is a **placeholder** if it matches any of: `${VAR}`, `${env:VAR}`, `$VAR`, `${input:x}`, `<…>`, `YOUR_…`, `your-…`, `xxx…`, `…_HERE`, or is empty. A placeholder becomes a secret field without a value (`placeholder:true`). The `envVar` name comes from the placeholder when one is present.
  - A real-looking literal value whose name matches the secret heuristic goes into the `PasteVault`, and the candidate gets `pasteValueHandle` (`hasPastedValue:true`). The heuristic: `TOKEN|SECRET|PASSWORD|PASSWD|KEY|PAT|AUTH|CREDENTIAL|COOKIE|SESSION`, case-insensitive, or any value with `has_common_secret_prefix` (mcp_mutation.rs:1391-1415). Non-secret literals stay plain env (e.g. `GITHUB_OAUTH_CALLBACK_PORT=8085`).
  - **Header values** are always treated as secrets.
- **Args:**
  - Arguments containing `=` are kept. `--port=3000` is never dropped; this fixes `contains_credential_like_value`, mcp_github_import.rs:415-421 (bug MCP#8).
  - An argument that is a credential is **not silently dropped**. The candidate is `skipped` with `secret-in-args`. A credential means: `has_common_secret_prefix(v) || is_sensitive_assignment(v)`, or the value following an `is_sensitive_argument_key` flag (mcp_mutation.rs:1329-1389, made `pub(crate)`).
- **`exists`:**
  - compare by `name_key` with the library;
  - `same` if `hash(projection)` equals the library and every client file;
  - `different` if the library or any client file holds a different entry (`differsIn` lists the clients);
  - otherwise `new`.
- **Limits:** text ≤ 256 KiB, ≤ 24 candidates (MAX_CANDIDATES, mcp_github_import.rs:12), ≤ 64 args.

### 3.7 Built-in templates (`mcp_templates.rs`, data)

| id | input | secrets | notes |
|---|---|---|---|
| `context7` | stdio `npx -y @upstash/context7-mcp` | `CONTEXT7_API_KEY` (env, **optional**) | brief example "+ context7 → npx -y @upstash/context7-mcp" |
| `fetch` | stdio `uvx mcp-server-fetch` | – | needs `uv` (install hint) |
| `filesystem` | stdio `npx -y @modelcontextprotocol/server-filesystem <allowedPath>` | – | `params: allowedPath`, a folder at argIndex 2, required. No default path. |
| `memory` | stdio `npx -y @modelcontextprotocol/server-memory` | – | |
| `sequential-thinking` | stdio `npx -y @modelcontextprotocol/server-sequential-thinking` | – | |
| `playwright` | stdio `npx @playwright/mcp@latest` | – | as in the playwright-mcp README |
| `github` | http `https://api.githubcopilot.com/mcp/` | header `Authorization`, Bearer, envVar `GITHUB_PERSONAL_ACCESS_TOKEN`, **required** | Claude Desktop cell `unsupported` (remote); Codex uses `bearer_token_env_var` |

- Every template carries `verifiedAt`, set by the release checklist (§7.4).
- A template that fails the release test is removed from the list for that release. CC Switch shipped a broken `time` preset; this rule avoids that.

### 3.8 GitHub import robustness (`mcp_github_import.rs`, M1-8)

- **Source forms** (extends `parse_github_repository`, 175-199): `owner/repo`, `https://github.com/owner/repo(.git)`, `…/tree/<ref>/<path>`, and `…/blob/<ref>/<path-to-file>`.
  - A ref is one segment; if that 404s, retry with the next 1-2 segments joined into the ref, so refs with slashes work.
  - Still rejected: `? # @ \`, non-ASCII, and anything other than `github.com` (180-194).
- **Fetch plan** (agent `.redirects(0)` stays, 53-58):
  1. Default branch via `api.github.com/repos/o/r` (210-228). On a transport error, 403, 429 or 5xx, use ref `HEAD` on raw instead of failing.
  2. For `dir` in [subpath, root], each file in `.mcp.json`, `mcp.json`, `README.md`, `readme.md`: first `https://raw.githubusercontent.com/o/r/<ref>/<dir>/<file>`; on a transport error, `api.github.com …/contents/…?ref=` (230-241).
  3. A 3xx status becomes `github-moved` (bug MCP#11, add after line 261).
- **Caps:** config files 96 KiB (11). README **512 KiB**, a separate constant; the error message names the right file (bug #19).
- **README parsing** (replaces 114-173):
  - Every fenced block whose language ∈ {``, `json`, `jsonc`, `json5`, `js`, `javascript`, `ts`, `typescript`, `toml`} goes through `mcp_paste::parse`.
  - For js and ts blocks, extract the first balanced `{…}` containing `mcpServers` or `mcp_servers` and parse it as JSONC. Unquoted keys simply fail and are skipped.
  - A parse error in one block **never aborts** the others (fixes the swallow at 130).
- **Same-name conflicts** (no longer an error, fixes 132-138):
  - Candidates that are identical after normalisation (e.g. the `npx` and `cmd /c npx` variants of `memory`) are merged.
  - Others become `variants`. `preferred` is the first `npx`/`uvx` variant that does not use docker and contains no `/Users/` or `~/Library` path; otherwise the first in README order.
- **Dropped servers** are listed in `skipped` with `McpSkipReason`.
- `origin-prerequisites` copy leaves the generic import (McpCenter.tsx:219-223). When the repo is `Ge-Shun/origin-mcp`, `notices` contains `has-verified-recipe` and the UI links to Discover.

### 3.9 Secrets (`mcp_secrets.rs`, M1-1)

- **Storage modes:**

| Mode | Value lives in | Client configs get |
|---|---|---|
| `user_env` (default) | `HKCU\Environment\<NAME>`, written as `REG_SZ` (never `REG_EXPAND_SZ`) with `winreg` 0.55 (Cargo.toml:31) | references (§2.4). Clients without reference support (Claude Desktop, or a Codex non-Authorization Bearer header) get the literal **only** for clients in `inlineClients`; otherwise the cell is `blocked: needs-inline-consent`. |
| `inline` | DPAPI inside `spec_protected` | the literal value in every enabled client. Requires an `inline-secret` confirmation the first time. |

- **Broadcast** after a set or delete: `SendMessageTimeoutW(HWND_BROADCAST, WM_SETTINGCHANGE, 0, "Environment", SMTO_ABORTIFHUNG, 5000, …)`. Add windows-sys feature `Win32_UI_WindowsAndMessaging` (Cargo.toml:32). A failed broadcast is non-fatal; the per-client result says "重启后生效".
- **Validation:**
  - Name `^[A-Za-z_][A-Za-z0-9_]{0,127}$` (validate_env_name, mcp_mutation.rs:1449-1460).
  - Reserved names are refused (`secret-name-reserved`): `PATH, PATHEXT, COMSPEC, SYSTEMROOT, WINDIR, TEMP, TMP, USERPROFILE, USERNAME, HOMEDRIVE, HOMEPATH, APPDATA, LOCALAPPDATA, PROGRAMDATA, PROGRAMFILES, PROGRAMFILES(X86), PSMODULEPATH, NODE_OPTIONS, PYTHONPATH, PYTHONHOME, CLAUDE_CONFIG_DIR, CODEX_HOME`, and anything starting with `AI_SKILLHUB`.
  - Value: trim surrounding ASCII whitespace; 1 to 8192 chars; no NUL, CR or LF. Otherwise `secret-value-invalid`.
- **Overwrite rules:**
  - An existing HKCU value that SkillHub did not create (`mcp_env_vars.created_by_skillhub = 0` or no row): `overwrite-env-var` confirmation. The copy says "已存在且不同", never the value.
  - SkillHub never writes HKLM.
- **Undo:** the previous value (or "absent") is stored DPAPI-protected in `undo_protected`. Undo restores it, or deletes a variable that SkillHub created.
- **Deletion:** only names with `created_by_skillhub = 1` that no other server references, always with `delete-env-var` listed in a confirmation.
- **Presence:** `env_var_present(name) = process env || HKCU || HKLM Session Manager`. It is used by the snapshot, the scanner (§2.7) and the test preview.
- **Never log or return values.**
  - Errors are built without the value.
  - The `Debug` impl of request structs redacts `value`: implement `Debug` manually.
  - Tauri IPC logging stays off.
  - Frontend inputs are `type="password"`, `autoComplete="off"`, `spellCheck={false}`, and are cleared after the call settles.

### 3.10 Test connection (`mcp_probe.rs`, M1-2)

- **Shared session.** Move `StdioSession` (mcp_recipes.rs:1022-1115) to `mcp_probe.rs` as `StdioSession::start(program: &Path, args: &[OsString], env: &[(OsString, OsString)], cwd: Option<&Path>, timeout: Duration)`. Origin's `handshake` (1155-1237) and `verify` (1239-1258) call it with `python -m origin_mcp`. Drop still calls `terminate_child_process_tree` (lib.rs:3409-3433, which runs `taskkill /T /F`).
- **Effective PATH:** `process PATH ∪ HKCU\Environment\Path ∪ HKLM …\Environment\Path`, with `%VAR%` expanded, so a Node.js installed after SkillHub started is still found. Resolve the runner by iterating PATH × PATHEXT. **No `where.exe`.**
- **Install hints:**
  - node / npx / npm / pnpm / yarn: https://nodejs.org/
  - uv / uvx: https://docs.astral.sh/uv/getting-started/installation/
  - docker: https://docs.docker.com/desktop/setup/install/windows-install/
  - python: https://www.python.org/downloads/windows/
  - These are data only; nothing is downloaded or run.
- **Spawn:**
  - Run the **resolved absolute path**, e.g. `C:\Program Files\nodejs\npx.cmd`, with argument vectors. Never `cmd /c` with a concatenated string.
  - Rust std escapes `.cmd`/`.bat` arguments safely and refuses unsafe ones (CVE-2024-24576 fix). A refusal becomes `failed`, "参数包含 Windows 批处理不支持的字符".
  - `configure_background_command` (lib.rs:3435-3438) hides the window.
- **Environment:** inherit the current process env, overlay the HKCU values for referenced `user_env` names (read from the registry at call time), overlay Library or inline values (DPAPI), add non-secret literal env, and use `cwd` when set.
- **Protocol (stdio):**
  1. `initialize` with `protocolVersion "2025-06-18"` and `clientInfo {name:"AI SkillHub", version}`, as in mcp_recipes.rs:1162-1170.
  2. `notifications/initialized`.
  3. `tools/list`.
  4. Stop. **No `tools/call`, ever, in the generic test.**
  - Non-JSON stdout lines are ignored (1091-1096). stderr keeps the last 2 KiB in memory.
- **Protocol (http):**
  - POST `initialize` with `Accept: application/json, text/event-stream` and the resolved headers; parse a JSON or SSE `data:` body.
  - Then `tools/list` with `Mcp-Session-Id` if one was returned.
  - Use `ureq` with `.redirects(0)`.
  - Legacy `sse` transport: `status:"unsupported"`, message "暂不支持测试旧版 SSE 连接".
- **Deadline:** 20 s for the whole test. The tree is killed on success, failure or timeout.
- **Message redaction:** replace every known secret value (≥ 4 chars) and the user profile path with `••••` / `~`, truncate to 240 chars, and map known failures to a `messageCode`: `runner-missing`, `needs-secret`, `exit-early`, `timeout`, `http-401`, `http-404`, `invalid-response`.
- **Concurrency:** one test per server; at most 2 tests at once (`test-busy`). The test does not take `MCP_MUTATION_LOCK`, because it never touches configs.
- **Persistence:** the summary goes to `mcp_servers.test_json` with `specRevision`. It is `stale` when the revision changes.

---

## 4. Internal reuse: how the new commands use the existing engine

### 4.1 What stays and what is deprecated

| Existing command (lib.rs) | 3.3.0 status |
|---|---|
| `scan_mcp_connections` (4579) | Kept. Used internally by the snapshot and import through `mcp_center::scan_read_only`. The new page does not call it. |
| `plan_mcp_changes`, `apply_mcp_plan` (4727-4745) | Kept registered for one release, **for compatibility only**. The new frontend must not call them (contract F2). The recipe card migrates to `mcp_add_servers` (§6.8). |
| `rollback_mcp_snapshot`, `list_mcp_rollback_snapshots` (4747-4764) | Kept. Used internally by `mcp_rollback({legacySnapshotId})` and `mcp_history` for pre-3.3 snapshots. |
| `list_mcp_mutation_targets` (4767) | Kept and extended to the four hosts. Not used by the new page; columns come from `snapshot.clients`. |
| `import_mcp_github_config` (4657) | Kept unchanged. `mcp_import_github` is the new shape. |
| `detect_mcp_recipe`, `install_mcp_recipe`, `verify_mcp_recipe`, `prepare_origin_bridge` (4613-4655) | Kept. Called **only** from the Discover recipe card, on explicit clicks. |

Remove them in 3.4 once nothing references them.

### 4.2 The executor split (single-target transactions)

- **Split `apply_mcp_plan_once`** (mcp_mutation.rs:525-719) at line 586:
  - Lines 531-584 are the **legacy preflight**: plan journal, memory cache, recorded-fingerprint comparison.
  - Lines 586-718 are the **core executor**: snapshot store, DPAPI backups, manifest prepared→applying, per-target fingerprint recheck, `write_atomic` with an expected fingerprint, read-back byte and semantic verification, manifest committed, crash recovery on error.
  - Extract the core into `pub(crate) fn execute_prepared_writes(context, prepared: Vec<PreparedWrite>, operation_label: &str) -> Result<McpApplyResult, String>`.
  - The legacy path keeps calling it after its preflight.
- **New internal entry point:**

```rust
pub(crate) enum EntryOp { Upsert(ProjectedEntry), Remove, SetCodexEnabled(bool) }
pub(crate) struct EntryChange { pub host_id: String, pub scope: String, pub workspace_id: Option<String>,
                                pub server_name: String, pub op: EntryOp }
/// One target file per call. Reads + fingerprints, computes final text with mcp_json_doc / toml_edit,
/// validate_host_document + verify_written_config (semantic: managed keys equal the projection),
/// then execute_prepared_writes. NOT Deserialize: the webview can never send a ProjectedEntry.
pub(crate) fn apply_entry_changes_now(context: &McpMutationContext, changes: Vec<EntryChange>, operation_id: &str)
    -> Result<McpApplyResult, String>;
/// Same computation without writing: used for confirmation descriptors and confirm tokens.
pub(crate) fn dry_run_entry_changes(context: &McpMutationContext, changes: &[EntryChange])
    -> Result<DryRun /* {target_id, path_display, current_sha256, before_entries, after_entries} */, String>;
```

- **One file per transaction:** all changes in one call must resolve to one target file. `group_changes`' "same file, different scope" rule at line 1488 then never fires. The library calls `apply_entry_changes_now` once per (client, scope, workspace) target, sequentially, in client order.
- **Snapshot ids:** `mcp-snapshot-<opid>-<n>`, which passes `validate_stored_id` (3001-3012). The manifest's `plan_id` field holds the operation id. `snapshot_ids_json` lists them.
- **Retry on `config-changed`:** Claude Code rewrites `~/.claude.json` on launch, per bug MCP#3. The library retries a target up to **2 times**, 300 ms apart, with a fresh read, as long as the managed entry itself did not change. Otherwise the failure is reported for that client only.
- **Limits:**
  - `MAX_ROLLBACK_SNAPSHOTS` 16 → **64** (mcp_mutation.rs:30), because each operation now creates one snapshot per file.
  - `MAX_SNAPSHOT_STORE_BYTES` stays 128 MiB (31).
  - `SNAPSHOT_TTL_MS` stays 7 days (29).
- **Hosts:** `validate_change` (1114-1146) accepts the four hosts. `set-enabled` stays **Codex-only**: JSON clients express enable and disable as upsert and remove at the library layer. The engine-level rejection (1135-1138, 1910-1912) stays as an internal invariant. The **frontend block** (McpCenter.tsx:511-514, 930-931) is deleted with the old page (M0-5).
- `derive_target` (1525-1624) gains `(host-claude-desktop, user)` and `(host-cursor, user)`. Each requires the client directory to exist (I5); `empty_config` is `"{}"`.
- `list_mcp_mutation_targets` (406-445) adds both hosts at user scope.

### 4.3 Mapping table

| New command | Library steps | Engine calls |
|---|---|---|
| `mcp_set_cell` | load spec → `project()` → classify current entry (§4.6) → confirm? → op row → … | 1 × `apply_entry_changes_now` (Upsert, Remove, or SetCodexEnabled) |
| `mcp_set_column` | projections for N servers (one client) | 1 call per ≤64 changes on the same file |
| `mcp_set_row` / `mcp_add_servers` / `mcp_update_server` / `mcp_resync` | one projection per client | 1 call per client file, sequential, per-client results |
| `mcp_remove_server` | soft-delete + removal per writable binding | 1 call per file |
| `mcp_undo` / `mcp_rollback{operationId}` | §4.4 | 1 call per file (Upsert(before) or Remove) |
| `mcp_rollback{legacySnapshotId}` | descriptor from the manifest (`targets[].path_display`) | `rollback_mcp_snapshot` (876) |
| `mcp_set_secret` | HKCU write + re-projection of the referencing enabled cells | 1 call per affected file |
| `mcp_import_from_clients` / `mcp_library_snapshot` | `mcp_center::scan_read_only` + raw entry reads through the same `read_regular_config` (1641-1669, read-only) | none |

### 4.4 Undo and rollback (fixes bug MCP#3 and brief §7 #8)

- `undo_protected` stores, for each touched entry, `{clientId, scope, workspaceId, serverName, before: canonical entry | null, after: canonical entry | null}`, plus the library rows before and the env-var before-values.
- **Undo, per entry, grouped per file:**
  1. If the whole file's sha256 still equals the operation's applied sha256 **and** the engine snapshot still exists, restore the snapshot bytes. This is byte-identical, satisfying the M0-3 acceptance "撤销后文件和原来逐字节一致".
  2. Otherwise parse the current file. If the current entry equals `after`, write `before` back (Upsert, or Remove when `before` is null) through `apply_entry_changes_now`. Other keys, such as the ones Claude Code rewrote, stay as they are.
  3. Otherwise report `undo-conflict` for that client. Other clients still undo (I8).
- Then restore the library rows and env vars, and record an `undo` operation that can itself be undone.
- `undoAvailable = state ∈ {applied, partial} && now < expires_at && undo_protected != NULL && no later operation touched the same (server, client) entries`. A later touch gives `superseded`; the drawer then offers only "回到这一步之前", which is a rollback of every later operation in reverse order, behind a confirmation.
- **History text is built by the frontend from structured fields**, e.g. zh `"{time} 给 {clients} {verb} {servers}"` → "10:42 给 Codex、Claude Code 添加 context7". Kind-to-verb: add 添加, enable 启用, disable 停用, remove 移除, update 修改, secret "保存了 {envVarNames} 的值（已隐藏）", import "从 AI 工具导入了", undo "撤销了", rollback "回滚了", resync "重新写入了".

### 4.5 Crash recovery and stuck transactions (bug MCP#2)

- `recover_incomplete_snapshot` (742-874):
  - In the preflight loop (786-791), a target that matches none of original, applied or planned gets `externally_changed = true` and is **not** restored. The remaining targets that match applied or planned are still restored.
  - The manifest ends in the terminal state `abandoned-external-change`, which `recover_incomplete_snapshots` (721-740) excludes from `pending`.
  - The outcome is a warning, not an error, and shows in `snapshot.stuckTransactions` / `issues`.
- `prune_snapshot_store` (2769-2859): non-committed manifests older than `SNAPSHOT_TTL_MS` are removed, as the `Err` branch at 2821-2834 already does. Today they are counted as protected orphans forever (2816-2820).
- `mcp_resolve_stuck_transaction` sets `abandoned-external-change` on demand.
- Recovery runs only inside write commands. Reads never fail because of a stuck manifest (bug MCP#10).
- Operations left in `applying` after a crash become `interrupted` at the next write. Cells always come from the files (§4.6), so the UI shows the truth.

### 4.6 Cell state computation (snapshot)

For each (server, client) at user scope, with P = `project(spec, client, consent)`, F = the current file entry (or none), W = `last_written_hash`, and `enabled` the desired state. The **first** matching rule wins:

1. Client not writable: `readonly` (reason from the registry).
2. `project()` returns Unsupported(transport or name): `unsupported`.
3. A secret is needed and not consented for this client: `blocked: needs-inline-consent`. (A missing **value** does not block a write: references still work once the user sets the key. It shows as `missingSecretCount` / issue `missing-secret`.)
4. `last_error_code != ''`: `error: write-failed` ("写入失败，点按重试"; clicking retries the same desired state).
5. `enabled` and F is none: `changed-outside: entry-removed-outside`.
6. Not `enabled`, F exists, JSON client: `changed-outside: entry-added-outside`. For Codex, F with `enabled=false` is `off` with `disabledInFile`.
7. `enabled` and F exists:
   - `hash(F) == hash(P)`: `on`;
   - `hash(F) == W`: `on` + `outOfDate` (silent resync issue);
   - `semantic_equal_ignoring_cmd_wrap(F, P)`: `on` + `windowsFixAvailable`;
   - otherwise `changed-outside: entry-edited-outside`.
8. Otherwise: `off`.

`out-of-date` and `windows-fix` resyncs need no confirmation, because the content is SkillHub's own or semantically equal. Only `changed-outside` requires one (I6).

### 4.7 What the 15-minute plan expiry becomes (brief §7 #41)

- `PLAN_CACHE_TTL_MS` (mcp_mutation.rs:28) applies **only** to the legacy `plan_mcp_changes` → `apply_mcp_plan` pair, which the new UI no longer uses.
- The new path plans and applies inside **one** command call while holding the lock, so nothing can expire between them.
- Confirmations use content-bound `confirmToken`s with **no TTL**: a confirmation dialog left open for an hour still works if nothing changed. If something did change, the user gets an updated plain-language dialog instead of "计划无效".

---

## 5. Bug fixes the backend and frontend must include

| Bug | Fix location in this contract | Owner |
|---|---|---|
| bugs.json MCP#1: Codex stdio gets `env_http_headers = {}`, so Codex fails to load (mcp_mutation.rs:1840-1847) | §2.4 managed-key table + Codex per-transport validation in `validate_codex_mcp_config`; test R9 | BE |
| MCP#2: a failed apply permanently locks list, apply and rollback (786-791, 2816-2820) | §4.5 + `mcp_resolve_stuck_transaction` + reads never recover | BE |
| MCP#3: rollback unusable after Claude rewrites `~/.claude.json` (928-936) | §4.4 entry-level undo; legacy entries show `legacy-changed` with a reason | BE |
| MCP#4: Codex transport switch leaves invalid fields (1821-1839) | §2.4 must-be-absent table; test R10 | BE |
| MCP#5: Claude local key uses backslashes (1864-1878, 2211-2224) | §2.3 key normalisation; test R11 | BE |
| MCP#6: reconfigure drops `required` and refs; diff says "preserved" (2081-2092) | `mcp_get_server` prefill (M1-7) + `McpConfirmationItem.changedFields` / previews with real names; delete the `"preserved"` literal | BE+FE |
| MCP#7: `${VAR}` refs shown as inline secrets (mcp_center.rs:1128-1143) | §2.7; test R13 | BE |
| MCP#8: credential heuristic drops `task-master-ai` and `--x=y` (mcp_github_import.rs:415-421) | §3.6 args rule; test P3 | BE |
| MCP#9: recipe card stale after center changes (McpRecipeCard.tsx:79-83) | §6.8: the card derives client status from the snapshot and listens to `mcp-library-changed` | FE |
| MCP#10: one failed listing leaves the add form without targets (McpCenter.tsx:374-381) | Obsolete: columns come from the read-only snapshot, and reads take no lock (§3.1) | BE+FE |
| MCP#11: renamed repo 301 gives a misleading message (mcp_github_import.rs:57, 243-261) | §3.8 `github-moved` | BE |
| MCP#12: Claude JSON writes re-sort all keys (1765) | §2.6 `mcp_json_doc.rs`; test R12 | BE |
| MCP#13: clipboard failure shown as "Scan failed"; raw diff codes (McpCenter.tsx:667, 1330-1340) | New page: copy failures go to a local warning toast. The confirmation dialog renders `changedFields` and actions through i18n, never backend tokens. | FE |
| brief §7 #4: results render out of view (McpCenter.tsx:756-784) | §6: sheet and drawer are overlays with a focus trap; results appear as a toast anchored to the viewport and in the cell itself | FE |
| #5: no `cmd /c`; `validate_command` rejects cmd (1260-1299; 1928-1937) | §2.5; tests R7, R8 | BE |
| #6: "重新配置" resets http to stdio (McpCenter.tsx:451-469) | `mcp_get_server` prefill; transport select defaults to the stored transport; test F6 | FE+BE |
| #7: diff shows no command, args or URL change (2051-2093) | `McpEntryPreview` before/after + `changedFields` | BE |
| #8: rollback without confirmation (805-813) | `mcp_rollback` always confirms first; toast undo is immediate by design | FE+BE |
| #19: top 4 repos fail GitHub import | §3.8; test G1 with the 4 fixtures | BE |
| #20: DECISIONS.md:1323 vs the code; stale i18n `mcp.githubImportBody` (mcpManagementI18n.ts:85 + zh/ko) | §0.2 item 3; delete the stale key | BE (decision) + FE (key) |
| #21: Claude Code toggle blocked in frontend and backend | §4.2: frontend block removed; the library maps to upsert/remove | FE+BE |
| #22: no Bearer header; Codex `bearer_token_env_var` not writable (2013-2017; mcp_center.rs:813) | §2.4 Bearer row + `headerTemplate:"bearer"` | BE |
| #23: page open spawns reg, tasklist, py, where, python; `list_mcp_mutation_targets` called twice (McpCenter.tsx:377; McpRecipeCard.tsx:66) | I1; §6.8 recipe detection only on click; the page calls only `mcp_library_snapshot` | FE |
| #24: Origin cannot be added to a second client (McpRecipeCard.tsx:277) | §6.8: client chips always visible; the matrix row works too | FE |
| #26: `.sr-only` undefined (McpCenter.tsx:1082) | Define `.sr-only` in `mcp.css` (or reuse a global one if the shell adds it); contract F8 | FE |
| #27: English raw tokens in the zh UI | §0.4 + i18n for every code; contract F7 | FE+BE |
| #28: inconsistent Codex naming; pill counts are file counts | §2.7 "Codex" everywhere; the matrix shows server counts only | BE+FE |
| #29: `scopeLabel('local')` = "当前项目" (i18n.ts:1298) | Project bindings show `projectLabel`; the scope words come from §0.4 | FE |
| #40: Codex `required = false` / empty `env_http_headers` noise | §2.4 | BE |
| #41: 15-minute plan expiry | §4.7 | BE |
| audits: `api.github.com` flaky | §3.8 raw fallback | BE |

---

## 6. Page-level UI spec

The component tree is under `app-next/src/mcp/`. `McpCenter.tsx` re-exports `McpPage as McpCenter`. The old metric tiles, host strip, inline form, plan card, snapshot panel, diagnostics block and inspector (McpCenter.tsx:697-992) are **deleted** (brief §2 #12-#17).

### 6.1 Layout (1440×900; matrix header top < 180 px, M0-1)

```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│ MCP  (?)                                     [从 AI 工具导入]  [+ 添加 MCP]  [⋯]           │  header, 56px
│ [我的 MCP] [发现]                                                                          │  tabs
├──────────────────────────────────────────────────────────────────────────────────────────┤
│ 🔍 搜索名称、命令或地址           7 个 MCP · 4 个 AI 工具 · ⚠ 2 个问题                     │  search row
│ ⚠ github 缺少 API Key [填写]    ⚠ Cursor 的配置文件里有注释，只读 [打开文件位置]  ×        │  issue strip (only if issues)
├────────────────────────────────┬──────────┬────────────┬───────────────┬────────────────┤
│ MCP                            │ Codex ▾  │ Claude Code▾│ Claude Desktop▾│ Cursor ▾       │  sticky header
├────────────────────────────────┼──────────┼────────────┼───────────────┼────────────────┤
│ ● context7   [测试]        ⋯   │   ●      │    ●       │      ○        │     ○          │
│   npx · @upstash/context7-mcp  │          │            │               │                │
│ ◐ github  需要 API Key [测试] ⋯│   ●      │    ●       │   ⊘ 不支持     │     ○          │
│   api.githubcopilot.com        │          │            │               │                │
│ ○ filesystem              ⋯    │ ⚠ 重试   │    ●       │      ●        │     ○          │
│ ○ team.docs               ⋯    │   ●      │  ⊘ 不支持  │   ⊘ 不支持    │   ⊘ 不支持     │
└────────────────────────────────┴──────────┴────────────┴───────────────┴────────────────┘
  其他 6 个工具（暂不支持 MCP） ▸
```

- **Header:**
  - Title "MCP" with a (?) tip. The tip holds the long explanations that used to be permanent paragraphs (i18n.ts:1253 subtitle, mcpManagementI18n.ts noSecretValues, planFirst, confirmBoundary, snapshotRetention).
  - `[从 AI 工具导入]` (quiet) calls `importFromClients({reason:"user"})` and then shows the report dialog: "新增 N 个 MCP：…" / "已有的同名 MCP 只打开了对应工具的开关" / "同名但配置不同：… 已保持原样" / a "读取了哪些文件" disclosure.
  - `[+ 添加 MCP]` (solid) opens the add sheet.
  - The `⋯` menu holds:
    - 复制全部为 JSON（密钥已隐藏）, which uses `exportJson`;
    - 按这里的开关重写各工具配置, which uses `resync` and its confirmation;
    - 历史版本, which opens the drawer.
- **Search row:**
  - Filters rows client-side on `name`, `displayName`, `target.runner`, `target.subject` and `target.host` only.
  - The summary is `{servers} 个 MCP · {clients} 个 AI 工具 · {issues} 个问题`. The issue count is a button that expands or focuses the issue strip.
- **Issue strip:**
  - One line per `McpIssue`, each with exactly one action button (S1-9), and dismissible per session.
  - Per-client failures read "无法写入 {client} 的配置：{reason}。[重试] [打开文件位置]". This replaces the generic "MCP 变更失败" (McpCenter.tsx:719-724).
- **Empty state:** "还没有 MCP" / "已经在 AI 工具里配过的 MCP，可以直接导入" with `[从 AI 工具导入]` and `[添加 MCP]`.
- **Narrow layout:** below 1000 px the matrix becomes one card per server with a row of client chips. No horizontal page scroll; a 16 px gutter.

### 6.2 Matrix

- `<table>`. The header row is sticky; the first column is sticky on the left when columns overflow.
- **Column header button** (`aria-haspopup="menu"`):
  - The icon, the label, and a `restartNeeded` dot with tooltip "写入后需要重启 {client}".
  - Menu items:
    - "已在 {on}/{total} 个 MCP 上启用" (text);
    - "启用其余 {n} 个", which uses `setColumn({enabled:true})`;
    - "全部关闭", which uses `setColumn({enabled:false})`;
    - while a search is active, a scope line "只作用于搜索出的 {n} 个" and `serverIds` is the filtered set;
    - "打开配置文件位置";
    - for a readonly column, the reason line.
- **Cell** = `<button aria-pressed>`. Its `aria-label` is "{name} · {client}：{stateText}". Visual and text per state:

| State | Visual | Click |
|---|---|---|
| on | filled dot | `setCell(false)` |
| off | hollow dot | `setCell(true)` |
| error | amber ⚠, "写入失败，点按重试" | retry the desired state |
| unsupported | ⊘ greyed; tooltip reason ("Claude Desktop 只支持本地命令" / "名称里有点号，{client} 不接受") | none (disabled) |
| readonly | 🔒 greyed; tooltip reason | none |
| blocked: needs-inline-consent | lock-open icon "需要确认" | small confirm dialog: "{client} 不支持引用环境变量。要把 {names} 的值直接写进 {client} 的配置文件吗？只有这个文件里会有明文。" [写入] calls `setCell({enabled:true, allowInline:true})` |
| changed-outside | ⚑ "在外部被改过" | popover: [采用文件中的版本] / [用库里的版本覆盖] → `resolveChange` → confirmation dialog |
| pending (frontend only) | spinner in **this cell only** | none |

  - Badges: `projectCount > 0` shows a small "+{n} 项目" badge; `outOfDate` and `windowsFixAvailable` are surfaced through the issue strip, not in the cell.
- **Optimistic UI:** none for the final state. The cell spins, then shows the state computed by the snapshot, which comes from read-back (S0-4 parity). A failed write shows `error` in that cell plus the toast.
- **First column:**
  - status dot: grey 未测试, green 可用 · N 个工具, red 启动失败…, amber 需要 API Key;
  - the name;
  - `[测试]` (quiet text button);
  - the target line `runner · subject`, `+{extraArgCount} 个参数`, or the host;
  - a missing-secret chip "需要 API Key [填写]" that opens the edit drawer focused on the secret;
  - the row `⋯` menu: 接入全部 AI 工具 (`setRow(true)`) / 从所有 AI 工具移除 (`setRow(false)`) / 编辑 / 测试连接 / 复制为 JSON（密钥已隐藏）/ 删除 (`removeServer({from:{kind:"library"}})` + confirmation).
- **Keyboard:** Tab reaches the column headers and the cells. Arrow keys move between cells (roving tabindex). Space or Enter toggles. Escape closes menus and returns focus.

### 6.3 Add sheet (M0-6, M0-7)

- A modal sheet on the right (or centred below 1000 px). Focus is trapped; on open, focus goes to the paste box and the sheet scrolls to the top. This replaces the in-page form inserted at y=851.
- It asks before discarding unsaved input.

```
添加 MCP                                                           ×
┌───────────────────────────────────────────────────────────────┐
│ 粘贴 JSON 或 TOML，自动识别 mcpServers、Codex、VS Code、OpenCode │  textarea, auto-parse 300 ms after paste/typing stops
└───────────────────────────────────────────────────────────────┘
识别为 mcpServers：2 个服务器                                          (result line)
 ☑ context7   npx · @upstash/context7-mcp   新的
 ☑ github     api.githubcopilot.com         已存在同名（Codex 里的配置不同） [跳过 | 覆盖]
     需要 API Key：GITHUB_PERSONAL_ACCESS_TOKEN ••••••••（已从粘贴内容读取） [替换]
从模板开始： [context7] [fetch] [filesystem] [memory] [sequential-thinking] [playwright] [github]
           去「发现」找更多 →
── 或手动填写 ───────────────────────────────────────────────────
名称 [__________]
命令或地址 [npx -y @upstash/context7-mcp______]   ← one field: http(s)://… ⇒ 远程地址, else 本地命令 (split on whitespace into command+args, editable list below)
参数 [ -y ] [ @upstash/context7-mcp ] [+]
API Key   名称 [CONTEXT7_API_KEY]  值 [••••••••] (显示 toggle while typing only)
          保存到：● 当前用户环境变量（推荐）  ○ 只写进 AI 工具配置（不推荐）
          [+ 添加请求头 Authorization: Bearer …]
▸ 高级：作用域（所有项目 / 某个项目）· Codex 中设为必需 · 连接方式（本地命令/远程地址/旧版 SSE）· 工作目录 · 普通环境变量
写入到： [☑ Codex] [☑ Claude Code] [☑ Claude Desktop ⊘ 不支持远程] [☑ Cursor]
                                               [取消]  [添加到 3 个 AI 工具]
```

- **Defaults:** every detected writable client is ticked. Unsupported ones show their reason and are excluded from N.
- **Button text:**
  - single add: "添加到 {n} 个 AI 工具";
  - batch: "添加 {count} 个，覆盖 {replaced} 个 · 写入 {n} 个 AI 工具".
- **Template chip, two-click target (M0-7):**
  - Clicking a chip prefills the form, shows the secrets the template needs, and focuses the first empty required field, or the button when there is none. Clicking the button writes.
  - Templates with a required secret need the value or an explicit "稍后填写": the server is added and the cell shows `missing-secret`.
- **Removed controls** (vs McpCenter.tsx:1241-1262): the forced "应用后启用" checkbox, the three safety paragraphs, the visible scope and transport selects. Scope, transport, "Codex 中设为必需" and cwd move into 高级.
- **Validation messages are inline per field:**
  - name rule (§2.2);
  - URL rule (no query or fragment, no credentials);
  - `cmd` not allowed as a command, with the explanation "Windows 上需要的 cmd /c 会自动加上".
- **On a `needs-confirmation` result,** show the confirmation dialog (§6.7), then resend the same request with `confirmToken`.
- **After `done`:** close the sheet and show the toast "已添加 {name} 到 {clients} · [撤销] [测试]". When some clients failed: "已写入 2 个，1 个失败（Cursor：{reason}）· [重试 Cursor] [撤销]".

### 6.4 Edit drawer (M1-7)

- Opens from the row's ⋯ > 编辑, from a click on the row name, or from "填写" on a missing secret.
- Calls `getServer`. The form shows the **stored** values, including the transport, which never resets (bug #6).
- **Fields:**
  - Name: read-only, with tip "名称是各工具配置里的键。要改名，请新建再删除旧的".
  - Transport: if the user changes it, an inline notice reads "切换后会清除不适用的字段".
- **Secrets:**
  - A stored value shows as "已保存 ••••••••（当前用户环境变量 GITHUB_PERSONAL_ACCESS_TOKEN）[替换]". There is no reveal.
  - "替换" opens a masked input. Saving calls `setSecret` (or the secret goes inside `updateServer`).
  - A missing value shows "缺少 API Key" with the input already open.
- **项目 section:** `projectBindings` with `projectLabel`, state and readonly reason. Writable ones have toggles that call `setRow`/`setCell` with scope. That is an advanced path.
- **Per-client section:** the same cells as the matrix, plus "打开配置文件位置" per client.
- **Footer:** "保存并同步到 {n} 个 AI 工具" calls `updateServer({expectedRevision})`. On `revision-conflict` the drawer reloads and shows "这个 MCP 刚被改过，已重新载入".
- **Test area:** a status line with the last result and a `[测试连接]` button (§6.6).

### 6.5 Undo toast and history drawer (M0-3, M1-9)

- **Toast:**
  - An MCP-local component (the global `showUiToast` in working-tree appShared.ts:299 has no action buttons).
  - Bottom-right, `role="status"`, stays 8 s, pauses on hover or focus, at most 3 stacked.
  - Text comes from `summary`:
    - single cell: "已在 Codex 启用 context7";
    - disable: "已在 Claude Code 停用 context7（库里保留着，随时可以再打开）";
    - restart hint: "重启 Codex 后生效".
  - `[撤销]` calls `undo(undoToken)` and then shows "已撤销".
- **History drawer** (⋯ > 历史版本):
  - entries newest first, e.g. "10:42 给 Codex、Claude Code 添加 context7"; partial entries read "（Cursor 未成功）";
  - legacy entries read "3.2 版本的更改 · 2 个配置文件";
  - each entry has [撤销此次更改], which calls `rollback({operationId})` → confirmation → result;
  - unavailable entries are greyed with a reason: 已过期（超过 7 天）/ 已撤销 / 之后又改过 / 导入记录无需撤销.
  - No IDs and no DPAPI or size text anywhere.

### 6.6 Test connection

- The `[测试]` button runs the following:
  1. `testPreview(serverId)`.
  2. If this server's `specRevision` has not been acknowledged in this session (a per-viewer convenience in `localStorage` keyed by serverId+revision, wrapped in try/catch), open `McpTestDialog`:
     - "将运行：`npx -y @upstash/context7-mcp`";
     - "这会在你的电脑上启动这个 MCP，最多 20 秒，只查询它提供哪些工具，不会调用任何工具。";
     - [运行测试] [取消].
     - When `runner.found` is false, the dialog instead shows "没有找到 uvx。[安装指引]" (opens `installHint.url` with the opener plugin; no download) and the run button is disabled.
     - When `missingSecrets` is non-empty: "需要先填写 API Key：…" [填写].
  3. `testServer({serverId, previewToken})`. The row dot shows `mcp-test-progress` phases as a spinner.
  4. Result on the dot: "可用 · 12 个工具" / "启动失败：找不到 uvx" / "需要 API Key" / "超时（20 秒）" / "暂不支持测试旧版 SSE 连接".
- Test runs **only** from this click path. Paste, import, browsing Discover and opening the page never test (contract F5).

### 6.7 Confirmation dialog (plain language)

Rendered from `McpConfirmation`; every string goes through i18n.

| kinds | zh title | body |
|---|---|---|
| `remove-from-library` | 删除 {server}？ | "会从 {clients} 里移除，并从库里删除。7 天内可以在「历史版本」里撤销。" Items: "− {server} → {targetDisplay}". Optional checkbox per SkillHub-created env var: "同时删除不再使用的环境变量 {name}". |
| `remove-from-client` | 从 {client} 的配置里删除 {server}？ | "不只是停用：这一项会从文件里拿掉，库里保留一份。" |
| `overwrite-different` | 覆盖 {client} 里同名的 {server}？ | before/after previews: "现在：npx · @foo/old → 改为：npx · @upstash/context7-mcp"; the changed fields as words (命令 / 参数 / 地址 / 环境变量 / 请求头 / 连接方式) |
| `changed-outside` | {server} 在 {client} 里被手动改过 | "用库里的版本覆盖它？你在 {client} 里做的修改会被替换（可以撤销）。" |
| `rollback` | 撤销这次更改？ | "会恢复：{per client: + / − / 改回 …}"; per-client conflicts are listed after the result |
| `overwrite-env-var` | 覆盖已有的环境变量 {name}？ | "当前用户环境变量里已经有 {name}，而且不是 SkillHub 建的。其他程序也可能在用它。" |
| `inline-secret` | 把密钥直接写进配置文件？ | "{clients} 的配置文件里会出现 {names} 的明文。推荐改用环境变量。" |
| `resync` | 按这里的开关重写各工具配置？ | the entries that will change |

Buttons: the primary action uses a verb ("删除" / "覆盖" / "撤销" / "写入"), and [取消]. Escape cancels.

### 6.8 Discover tab (M0-11)

Sections:
1. **"已验证一键安装"** holds the Origin recipe card (McpRecipeCard), **collapsed** by default.
   - Delete the mount effect that calls `detect()` (McpRecipeCard.tsx:79-83). Detection runs only on [检查这台电脑] or [展开].
   - Remove the `list_mcp_mutation_targets` call (66). Client choices come from `snapshot.clients` (stdio-capable and writable).
   - Replace `planConnection` / `applyPlan` (85-151) with `mcpApi.addServers({candidates:[{input:{name:"origin", transport:"stdio", command: status.runtimePython, args:["-m","origin_mcp"], source:{kind:"recipe", id:"origin-mcp"}}, onConflict:"skip"}], clientIds})`, and handle `needs-confirmation` with the shared dialog. Example: the user's own Codex has `origin = python -m origin_mcp`, so the dialog is a plain-language overwrite question.
   - Client chips stay visible after connecting (bug #24).
   - The status of each client comes from the `origin` row of the snapshot and is re-derived on `mcp-library-changed` (bug MCP#9).
   - Verify stays as is (`verify_mcp_recipe`).
   - The Origin-specific prerequisite text moves here from McpCenter.tsx:219-223.
2. **"常用模板"** holds the template cards, each with [添加], which opens the add sheet prefilled.
3. **"从 GitHub 导入"** is an input for `owner/repo`, a URL, or a `/tree/…` URL, and calls `importGithub`.
   - The result list has the same shape as the paste list, with `variants` as a "其他写法" dropdown and `skipped` with reasons.
   - The `has-verified-recipe` notice links to section 1.

No Registry this round (M1-3).

### 6.9 Copy rules

- zh copy for every new key lives in `mcpManagementI18n.ts` (zh, en and ko must have identical key sets).
- Remove the keys that are no longer used, including `mcp.githubImportBody` (bug #20), `mcp.unprobed*`, `mcp.staticVerified`, `mcp.planFirst`, `mcp.confirm*` and `mcp.snapshot*`, unless the legacy paths need them.
- The banned-word list in §0.4 is enforced for the zh dictionaries used by `src/mcp/**` (contract F7).

### 6.10 Browser preview mocks (`preview.ts`)

- Add `export function previewMcp<R>(command: McpCommand, request: unknown): Promise<R>` and `previewMcpSubscribe(cb)` to `preview.ts`, or to `mcpPreview.ts` re-exported from it. Together they hold a stateful in-memory mock that implements **every** `McpCommand`. Replace `previewInventory()` (McpCenter.tsx:1552-1566). Each call resolves after 150-400 ms to show spinners.
- **Clients:** codex, claude-code, claude-desktop and cursor, all detected and writable. One `otherClients` entry: "Gemini CLI".
- **Servers**, chosen to exercise every state:
  - `context7`: npx; on for Codex and Claude Code; test ok with 2 tools.
  - `github`: http; on for Codex and Claude Code; `unsupported` for Claude Desktop; off for Cursor; missing secret `GITHUB_PERSONAL_ACCESS_TOKEN`.
  - `filesystem`: on for Claude Desktop; `error` for Codex. Retry succeeds on the second click.
  - `memory`: on everywhere; Claude Code has `windowsFixAvailable`.
  - `origin`: `changed-outside` for Codex.
  - `team.docs`: Codex only; the other clients are `name-incompatible`.
  - `fetch`: off everywhere; the test returns `runner-missing` (uvx).
- **History:** 4 entries, one of them partial and one legacy.
- **Paste:** a small JS recogniser for `mcpServers`, `named`, `single`, a minimal Codex TOML (`[mcp_servers.x]` with `command`/`args`/`url` strings), VS Code `servers`, and OpenCode. Pasted secret values are replaced by a fake handle and never kept in the mock state.
- **Writes** mutate the mock, append history and return realistic outcomes. Every toast carries the suffix "（预览：没有写入任何文件）".
- `?view=connections` opens the page, as today (`isNavKey`: 7b71c94 App.tsx:6904; working tree App.tsx:2090). `&mcpTab=discover` opens Discover.

---

## 7. Acceptance tests

### 7.1 Backend (Rust unit tests in the modules; fixtures as in mcp_mutation.rs:3155-3176)

| ID | Test | Covers |
|---|---|---|
| R1 | `first_import_reads_all_clients_without_touching_files`: four fixture files plus a Claude local project. Import, then assert each file's sha256 is unchanged and the report counts (added, merged, differing, skipped, filesRead). | M0-4, I4 |
| R2 | `import_same_name_same_spec_merges_flags_and_different_spec_marks_changed_outside` | M0-4 |
| R3 | `codex_cell_disable_writes_enabled_false_and_undo_is_byte_identical` | M0-3 |
| R4 | `claude_cell_disable_removes_entry_keeps_spec_and_reenable_restores_entry_field_for_field` (unknown keys preserved, including `headersHelper`) | M0-5 |
| R5 | `desktop_and_cursor_writers_preserve_unknown_top_level_keys_order_and_indent` (fixture with `preferences`, `coworkUserFilesPath`) | M0-9 |
| R6 | `jsonc_client_file_is_readonly_reported_and_never_written` (Cursor with `// comment`) | I7 |
| R7 | `windows_family_commands_wrapped_for_claude_clients_only_and_unwrapped_on_import` (platform passed as a parameter so it runs on CI) | #5 |
| R8 | `validate_command_with_args_accepts_only_cmd_slash_c_runner`: accepts `cmd /c npx -y pkg`; rejects `cmd`, `cmd /k npx`, `cmd /c powershell`, `cmd /c npx a&calc`, `cmd /c npx %PATH%`, `cmd /c npx ^x` | #5 |
| R9 | `codex_stdio_never_writes_env_http_headers_or_required_false`, plus `validate_codex_mcp_config` rejects stdio with `env_http_headers` and http with `env`/`cwd` | MCP#1, MCP#4, #40 |
| R10 | `codex_transport_switch_removes_incompatible_keys_and_keeps_unknown_valid_ones` (`startup_timeout_sec` survives) | MCP#4 |
| R11 | `claude_local_scope_uses_forward_slash_key_matches_existing_and_refuses_ambiguous` | MCP#5 |
| R12 | `claude_json_single_entry_change_touches_only_that_entry` (line-diff assertion on a 40-key fixture) | MCP#12 |
| R13 | `claude_dollar_brace_env_and_bearer_headers_are_references_with_presence` | MCP#7 |
| R14 | `per_client_failure_is_isolated`: fail the Cursor target through the test hook (2502-2522 pattern). Codex and Claude are written; the outcome statuses are correct; no other file is restored. | M1-4, I8 |
| R15 | `remove_requires_confirmation_and_token_is_content_bound`: the token is accepted, then rejected after an external edit, which yields a fresh `needs-confirmation`, not an error | I6, #41 |
| R16 | `overwrite_same_name_different_requires_confirmation_but_batch_overwrite_choice_counts` | I6 |
| R17 | `undo_after_claude_rewrites_unrelated_keys_reverts_only_touched_entries` | MCP#3 |
| R18 | `undo_reports_conflict_per_client_when_entry_changed_after_apply` | M1-9 |
| R19 | `stuck_manifest_with_external_change_becomes_terminal_and_does_not_block_writes_or_reads` | MCP#2 |
| R20 | `history_entries_are_structured_and_secret_free` (sentinel) | M1-9 |
| R21 | **Sentinel test.** Set secret `S3NT1NEL-…` through add and through set_secret (in-memory `EnvStore` trait implementation), then grep the following for the sentinel and expect it to be absent: every returned struct (serde_json), every `McpError`, plan journals, decrypted manifests, `mcp_operations.summary_json`, the SQLite **file bytes**, `summary_json`, `test_json`, log files under user data, and the export output. It may be present only in: the DPAPI-decrypted spec and `undo_protected`, the in-memory env store, and the client files for which inline consent was given. | M1-1, I3 |
| R22 | `set_secret_user_env_projects_references_per_client`: Codex `env_vars`, Claude `${X}`, Cursor `${env:X}`; Claude Desktop is `blocked` until `allowInline` | M1-1 |
| R23 | `bearer_header_projects_per_client` (Codex `bearer_token_env_var`) | #22 |
| R24 | `reserved_env_names_and_invalid_values_rejected_without_echo` | M1-1 |
| R25 | `real_hkcu_roundtrip` (`#[ignore]`, Windows only, unique variable name, cleanup): set, presence true, broadcast does not hang (>5 s fails), delete | M1-1 |
| P1 | `paste_recognizes_all_formats`: mcpServers, named fragment, single, Codex TOML with an env sub-table, Codex JSON, VS Code `servers` + `${input:x}`, OpenCode local and remote, fenced and JSONC | M0-6 |
| P2 | `paste_moves_secret_values_into_vault_and_never_returns_them`, plus placeholders become missing secrets | M0-6, I3 |
| P3 | `paste_keeps_equals_args_and_names_skip_reasons` (`--port=3000` kept; `task-master-ai` kept; `--api-key sk-…` skipped with `secret-in-args`) | MCP#8 |
| G1 | `github_readme_fixtures_yield_candidates`, using **excerpted config blocks** of github-mcp-server, playwright-mcp, modelcontextprotocol/servers and context7. Store only the snippets plus license notes under `tests/fixtures/`, following the `origin-mcp-LICENSE` pattern, plus a synthetic 200 KB README for the cap. Expect ≥1 candidate each; playwright `variants`; servers `memory` merged after unwrap. | #19 |
| G2 | `github_source_forms_and_3xx_moved` (tree, blob, `.git`; 301 maps to `github-moved`) | MCP#11 |
| T1 | `preview_token_required_and_bound_to_spec_revision` | M1-2 |
| T2 | `generic_test_runs_only_initialize_and_tools_list_and_kills_tree`. A fake server (`tests/fixtures/fake-mcp-server.mjs`, run with node only in tests) logs every method to a temp file and spawns a grandchild. Assert: methods = [initialize, notifications/initialized, tools/list]; no `tools/call`; neither PID is alive after the result. | M1-2 |
| T3 | `test_timeout_is_enforced` (fake server that never answers; the timeout is injectable for the test, 20 s in production) | M1-2 |
| T4 | `runner_resolution_uses_path_and_pathext_without_spawning` | M1-2, I1 |
| T5 | `stderr_and_message_redact_secret_values_and_profile_path` | I3 |

Existing tests that must still pass, with assertion updates where the contract changed: the 32 tests in `mcp_mutation.rs`, 11 in `mcp_center.rs`, 10 in `mcp_github_import.rs` and 12 in `mcp_recipes.rs`, plus `tests/mcp_mutation.rs` and `tests/mcp_center_read_only.rs`. Notably:
- `claude_enablement_mutations_are_rejected` (3817) stays: the engine invariant.
- `normal_npx_package_arguments_remain_valid` (3760) stays.

### 7.2 Frontend contract tests (`app-next/scripts/v3.3-mcp-contract.test.mjs`, `node --test`)

| ID | Assertion |
|---|---|
| F1 | No file under `src/mcp/**` except `mcpApi.ts` imports `invoke` from `@tauri-apps/api/core`. Every `McpCommand` literal in `mcpTypes.ts` is handled in the preview mock. |
| F2 | `src/mcp/**` and `McpRecipeCard.tsx` never reference `plan_mcp_changes`, `apply_mcp_plan`, `list_mcp_mutation_targets` or `list_mcp_rollback_snapshots`. |
| F3 | `McpRecipeCard.tsx` has no `useEffect` calling `detect(`. `detect_mcp_recipe` is invoked only inside click handlers. |
| F4 | Secret value inputs are `type="password"` with `autoComplete="off"` and `spellCheck={false}`. The state setter for each secret input is reset in a `finally` block. No `console.*` call in `src/mcp/**` receives a secret variable. This **replaces** `scripts/mcp-management-ui.test.mjs:69`, which forbade password inputs. |
| F5 | `testServer(` appears only after `testPreview(` in the click flow. No `useEffect` calls `testServer`, `importGithub` or `parsePaste` with a test. |
| F6 | The edit drawer initialises transport from `detail.transport` (no `"stdio"` literal default when detail exists). |
| F7 | The zh dictionary values used by `src/mcp/**` and the new `mcpManagementI18n.ts` keys contain none of: 宿主, 绑定, 逻辑服务器, 能力未探测, 静态验证, 当前项目, binding, upsert, set-enabled, redacted, secretReferences, preserved, configured, absent, mcp-plan-, mcp-snap. zh, en and ko key sets are equal (pattern of mcp-management-ui.test.mjs:99). |
| F8 | `.sr-only` is defined in CSS reachable from the MCP page. |
| F9 | `src/mcp/**` never calls `record_usage_event` or a telemetry helper. |
| F10 | `McpCenter.tsx` exports `McpCenter` (App.tsx lazy import stays valid). |

Rewrite or retire the old suites:
- `scripts/mcp-management-ui.test.mjs`: retire it. Keep the `mcpManagement.ts` unit asserts only if `mcpManagement.ts` survives, e.g. for the name rule.
- The MCP block of `scripts/v3.1-readonly-foundation.test.mjs:54-92`: keep the no-spawn asserts and extend the module list (I1); drop `mcp.unprobed` and diagnostics. Coordinate with the shell agent.
- `scripts/mcp-recipe-contract.test.mjs`: keep the pin tests and add F3.

### 7.3 Preview UI QA (`app-next/scripts/v3.3-mcp-visual-qa.cjs`, Playwright on `pnpm dev`)

1. At 1440×900, `?view=connections`: the `thead` top is < 180 px (M0-1). No element with the text 宿主, 能力未探测 or mcp-snap.
2. Click "添加 MCP": the sheet is inside the viewport and the paste textarea has focus (M0-7, #4).
3. Paste the 2-server sample: two rows, with "新的" and "已存在同名" plus [跳过|覆盖] (M0-6).
4. Close it, then template chip `context7` → "添加到 4 个 AI 工具": at most **2 clicks** from chip to toast. The toast with [撤销] is in the viewport (M0-7, M0-3).
5. Click [撤销]: the context7 row disappears and the toast says "已撤销".
6. Column menu on Cursor shows "已在 x/N 个 MCP 上启用", and "启用其余 N 个" flips the cells (M0-2).
7. A `filesystem` × Codex error cell shows "写入失败，点按重试" and the second click shows "on" (M1-4).
8. The history drawer shows "给 Codex、Claude Code 添加 context7". [撤销此次更改] opens a confirmation listing the clients (M1-9).
9. github → [测试] opens the dialog with "将运行"/URL text. The fetch test shows "找不到 uvx" + 安装指引 (M1-2).
10. Edit `github`: transport shows 远程地址 and stays after saving (#6).
11. At 1024 px and 390 px: no horizontal page scroll. Light and dark themes both render.

### 7.4 Manual acceptance on a real Windows machine (desktop build)

| # | Steps | Pass |
|---|---|---|
| D1 | Clean profile, open the MCP page | Process count under SkillHub before and after page open is equal (`Get-CimInstance Win32_Process -Filter "ParentProcessId=<pid>"`), i.e. 0 new processes (M0-11) |
| D2 | First run with existing Codex and Claude configs | Notice "已从 AI 工具导入 N 个 MCP"; file hashes unchanged (M0-4) |
| D3 | Add `memory` (template) to Codex, Claude Code and Claude Desktop | `codex mcp list` loads (no `env_http_headers` error); Claude Code `/mcp` in **native Windows** shows connected (cmd /c); Claude Desktop shows the server after restart (M0-8, M0-9) |
| D4 | Disable then enable context7 in Claude Code | The entry is identical field for field (M0-5) |
| D5 | Undo a toggle right away without starting any client | The file is byte-identical to before (M0-3) |
| D6 | Undo after launching Claude Code (which rewrites `~/.claude.json`) | Only the context7 entry is reverted; Claude's other keys stay (MCP#3) |
| D7 | Save the github key in the app | `reg query HKCU\Environment /v GITHUB_PERSONAL_ACCESS_TOKEN` exists; Claude config has `Bearer ${…}`; Codex has `bearer_token_env_var`; after restarting Codex, `/mcp` lists github; a grep of the SkillHub user-data folder for the token finds 0 hits (M1-1) |
| D8 | Test context7 and fetch (uv missing) | "可用 · N 个工具"; "启动失败：找不到 uvx" with the guide; after each test no `node`/`npx`/`uvx` processes remain (M1-2) |
| D9 | Import the 4 GitHub repos (`github/github-mcp-server`, `microsoft/playwright-mcp`, `modelcontextprotocol/servers/tree/main/src/memory`, `upstash/context7`) | Candidates for each, or a clear reason in `skipped` (M1-8) |
| D10 | Origin recipe on a machine without Origin | Detection runs only after "检查这台电脑"; once connected to Codex, it can still be added to Claude Code (#24) |
| D11 | Release gate for templates | Run `mcp_test_server` on every template on a clean machine and record `verifiedAt`. Remove failing templates from that release. |

---

## 8. Verify before shipping (do not assume)

| # | Question | Default in this contract | How to settle it |
|---|---|---|---|
| Q1 | Does Cursor on Windows start a bare `npx`? | not wrapped | D3 with Cursor installed. If it fails, add `cursor` to the wrap list (one-line registry change). |
| Q2 | Does Codex on Windows start a bare `npx` (the user's Codex config uses absolute `.exe` paths)? | not wrapped | D3. If it fails, wrap for Codex too. Codex has no `type` key, so `cmd` + args is fine. |
| Q3 | `CLAUDE_CONFIG_DIR` is set: is the user config `$CLAUDE_CONFIG_DIR/.claude.json`? | yes (§2.1) | A scratch `CLAUDE_CONFIG_DIR` and `claude mcp get`, as the bug verifiers did |
| Q4 | Real `~/.claude.json` files larger than 2 MiB | refuse with `config-too-large` | Measure on 3 heavy users. If common, raise the read and write cap to 8 MiB and the snapshot store to 256 MiB together. |
| Q5 | Does a running Claude Desktop overwrite `mcpServers` added while it is open? | tell the user to restart | Add with Desktop open, change a preference, check that the entry survives |
| Q6 | Should the edit drawer offer "显示值"? | no reveal in 3.3.0 | Product decision; it needs a new DECISIONS entry if added |
| Q7 | Does MSIX Claude Desktop read only the LocalCache copy once it exists? | write LocalCache when the package directory exists | Verify on the MSIX install (this machine has both copies) |

**Out of scope, not to be done silently:**
- Registry search (M1-3).
- Gemini CLI, Windsurf, Antigravity, Kiro, VS Code and OpenCode writers (M1-6, M2-1).
- Per-client env overrides (M2-4).
- Deep links (M2-3).
- A project registration shortcut (M2-5).
- Relaunching apps (M2-6).
- Anything that weakens the skills security gate or changes the default expansion of the skill tree (DECISIONS.md:149).

---

## 9. Backend implementation notes (mcp-backend, 2026-10-08)

These clarify how the backend implements the contract. Nothing here changes a request or response shape in §3.2.

1. **Hash vs. meaning (§1.4, §4.6).** The stored cell hash keeps a Windows `cmd /c` wrapper, so a Claude entry written without it can be told apart and offered as `windowsFixAvailable`. Semantic comparison (`semantic_equal_ignoring_cmd_wrap`, import "merged") unwraps both sides.
2. **Disable keeps the whole entry.** Turning off a JSON client stores the removed entry (DPAPI, inside the spec, for that client only). Re-enabling writes it back field for field and in the same key order, with the managed keys re-projected from the library.
3. **Codex documents.** The current file only has to parse (older versions wrote `env_http_headers = {}` / `required = false`; a write cleans those up). Every entry a write touches is checked strictly for its transport before and after the atomic write. `validate_codex_mcp_config` is the strict whole-document check.
4. **Prefill-safe updates (M1-7).** In `mcp_update_server`, an omitted `args`, `cwd`, `env`, `secrets`, `displayName` or `codexRequired` keeps the stored value; `cwd: ""` clears it. A `SECRET_MASK` argument, or an argument equal to the stored one at the same index, keeps the stored argument.
5. **Add conflicts.** `onConflict` omitted with a same-name library server → `name-taken`. `"skip"` leaves that server untouched (results `skipped`, reason `entry-added-outside`); a same-name, different entry in a client file with `"skip"` skips that client. `"overwrite"` counts as the confirmation and also re-projects the other enabled clients.
6. **Transport switch to an unsupported client.** After an update, a JSON client that no longer supports the transport (for example Claude Desktop and a remote server) has its entry removed and the cell turns off; Codex gets `enabled = false`.
7. **Onboarding without import.** `mcp_import_from_clients({reason:"onboarding", clientIds: []})` sets `libraryInitialized` without importing anything.
8. **Undo results.** Restored targets report `status:"undone"`. Entries changed after the operation are reported as a separate `failed` result with `error.code:"undo-conflict"` (`params.server` lists the names); the other clients still undo. Undo operations are themselves undoable.
9. **History.** Pre-3.3 snapshots appear as `kind:"legacy"` with `operationId:"legacy-<id>"` and `legacySnapshotId`; roll them back with `mcp_rollback({legacySnapshotId})`.
10. **Arguments `cmd` interprets.** If an argument of an npx-family command contains `& | < > ^ % " ( ) !`, the Claude entry is written without `cmd /c` instead of handing those characters to the shell.
11. **Opener allow-list.** `capabilities/default.json` now also allows the install-guide URLs (§3.10) and the template docs/help URLs (§3.7), so "安装指引" opens in the browser instead of falling back to copy.
12. **Legacy listing.** `list_mcp_rollback_snapshots` no longer takes the in-process write guard (bug MCP#10); stuck manifests never make it fail (bug MCP#2).
13. **Tests never touch the real machine.** Library tests use a temp home and an in-memory environment store; scanner tests do not read the registry; R25 (`real_hkcu_roundtrip`) stays `#[ignore]` and uses a unique `SKH_TEST_ONLY_…` name with cleanup.

### 9.1 Review notes (mcp-backend review, 2026-10-08)

No request or response shape changed. These pin down behaviour the frontend can rely on.

1. **Inline values are the ones being saved.** When an add, `mcp_set_secret` or `mcp_update_server` saves a `user_env` value, a client that receives the literal by consent (Claude Desktop, a Codex non-Authorization Bearer header) gets that new value in the same write.
2. **Keys inside an imported URL are secrets.** A URL with a query, fragment or account part (`…/mcp?api_key=…`, `https://user:pass@…`) is shown masked in `mcp_get_server.url` and in `mcp_export_json` (for example `https://host/mcp?••••••••`). Other clients get it only with inline consent (`blocked: needs-inline-consent`). An update that sends the masked or the unchanged stored URL keeps the stored one. A new URL still must have no query, fragment or account part.
3. **Both reasons in one dialog.** Enabling a cell that needs inline consent whose entry was also changed outside returns `kinds: ["changed-outside", "inline-secret"]`. With `allowInline: true`, only `changed-outside` is asked.
4. **Env-var boxes in the removal dialog.** The `deleteEnvVars` the user ticks are not part of the confirm token. Resend the first dialog's token together with the ticked names; no second dialog appears.
5. **"保留现在的文件" keeps the files.** `mcp_resolve_stuck_transaction` runs under both locks but without crash recovery first. If the record is already gone, the error is `not-found`; refresh the snapshot.
6. **Undo and environment variables.** Undo restores a variable only while it still holds the value the operation wrote. A value the user changed afterwards is kept as it is.
7. **Optional keys are not missing.** `missingSecretCount` and `mcp_test_preview.missingSecrets` count only secrets with `required: true`. An optional key that is not set (context7's `CONTEXT7_API_KEY`) does not block the test. Secrets imported from client files are `required: true`.
8. **References with defaults.** An imported `${NAME:-value}` is kept as written, as a plain value, and is never turned into a `${NAME}` reference.
9. **Keep a reference when editing.** If `envVar` is omitted for an env secret that references a differently named variable (`"KEY": "${OTHER}"`), the edit keeps `OTHER`. A header's `envVar` must be a valid variable name (`secret-name-invalid`).
10. **Same literal key in two clients.** On import, a literal key that already sits in a client's own file counts as consent for that client only, so two clients configured with the same key merge.
11. **Not installed vs unreadable.** A client detected on the AI 工具 page whose config folder does not exist yet is reported as `client-not-installed`, never `config-unreadable`. The folder is still never created.
12. **Integration notes for the frontend.**
    - Manual and template adds send `onConflict: "skip"`. When the library already has that name, the add is skipped (`noop`) instead of returning `name-taken`. Omit `onConflict` for manual adds to get `name-taken`.
    - The edit drawer omits `cwd` when the field is empty, which keeps the stored `cwd`. Send `cwd: ""` to clear it.
