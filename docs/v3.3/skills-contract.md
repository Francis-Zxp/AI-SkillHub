# AI SkillHub v3.3.0 — Skills contract (backend ⇄ frontend)

Status: design contract for parallel implementation. Owner of this file: Skills contract designer.
Base: branch `claude/v3.3-experience-overhaul`.

- The redesign brief, bug list (`bugs.json`) and `DECISIONS.md` line numbers refer to commit **`7b71c94`** (3.2.18 release). This document writes them as `App.tsx@7b71c94:934`.
- Commit **`d20c3b8`** ("split App.tsx into page modules, no behaviour change") moved the frontend into `src/pages/*.tsx`, `src/components/ui.tsx` and `src/appShared.ts`. Where it helps, the post-split location is written as `pages/Library.tsx@d20c3b8:147`.
- Rust line numbers (`lib.rs:2547`) are the same at both commits, because `d20c3b8` touched only the frontend.

Two agents implement this document **at the same time and without talking to each other**:

- **B (backend agent, Rust and PowerShell):** `app-next/src-tauri/**`, `app-next/runtime/*.ps1`, `app-next/scripts/*.ps1`, and the Rust and PowerShell tests.
- **F (frontend agent, React and TS):** `app-next/src/**`, `app-next/src-tauri/tauri.conf.json` (only the `dragDropEnabled` flag, see §3.9), and the node and Playwright tests in `app-next/scripts/*.mjs|*.cjs`.

The interface is §4. The TS block in §4.3 is canonical. The Rust DTOs in §4.4 must serialize to exactly that shape. If something here is ambiguous, F follows the TS block and B follows §4.4 plus the serde rules in §4.1.

Scope for this round: S0-1 … S0-11, S1-8 (onboarding), S1-9 (error banner), S1-10 (plain language), and every Skills, shell or rust-core bug in `bugs.json` and brief §7 (see §7). MCP items are covered by the separate MCP contract.

---

## 0. Invariants (both sides rely on these)

| # | Invariant | Enforced by |
|---|---|---|
| I-1 | **Write nothing to a client folder before consent, or while paused.** No create, delete or modify in any AI tool's skills folder (including `~/.agents/skills`, the shared Coze/Codex folder) while `onboarding_status = pending` or `skill_delivery_paused = 1`. The choke point is `run_agent_link_script` (lib.rs:2098), which is also the only caller of `shared_skill_catalog::sync_shared` and `::sync`. | B |
| I-2 | **Only remove or replace what SkillHub created.** A personal folder, an external link or a non-folder with the same name as a SkillHub entry is reported as `conflict` and left untouched. SkillHub never moves it into a backup either. This replaces `Manage-AgentSkillLinks.ps1:494-498`, which today moves the personal folder into `AI_global接管前备份_*`. | B |
| I-3 | **Icon state is read back from disk, never optimistic.** After a mutation the frontend shows only what the backend returns (`pending` or `removing`) until a `delivery-status` event with phase `done`, `failed` or `paused` arrives, followed by `get_skill_delivery_state()`. | F |
| I-4 | **No command that touches deliveries runs PowerShell inline or holds the UI.** It writes SQLite, enqueues a delivery job and returns in under 300 ms. The only long commands are probe, install, adopt, update and the startup verify, and none of them uses the global `setLoading`. | B + F |
| I-5 | **The security review keeps blocking.** A source flagged by the review (`review`, or `blocked` with findings) can only be added as **仅加入技能库（保持停用）**: library-enabled = false, no targets, nothing delivered. A structural block (size limit, path escape, link) cannot be added at all. Enabling a flagged source later requires `securityReviewConfirmed: true` on `set_source_library_enabled`. Nothing in this contract makes the scan non-blocking. | B |
| I-6 | **The default expansion of child Skills in the library does not change.** Search opens the detail drawer; it does not expand the tree. | F |
| I-7 | **The delivery unit is one parent entry per skill pack per AI tool.** A child Skill switch stays global and affects only the router contents (DECISIONS.md:1260 "父 Skill 保持唯一入口"). | B |
| I-8 | **The PowerShell 5.1 delivery contract is kept** (DECISIONS.md:1085). `Manage-AgentSkillLinks.ps1` still does every write to link-based clients. A non-empty policy that matches zero active entries still fails closed before anything is touched. | B |
| I-9 | **Codex and Coze share `~/.agents/skills` while Coze's shared mode is active** (`real_shared`, lib.rs:2599-2604). Their takeover switches and per-pack targets are one group: changing one changes both. The UI must not pretend otherwise. | B enforces, F renders |
| I-10 | **No credentials and no raw stack traces** appear in errors, events, reports or logs. Paths may appear, because they belong to the user's own machine. | B |
| I-11 | **Counts come from one function.** `countSkills()` in `src/skillCounts.ts` (§4.6) feeds the islands, the library header, the folder chips, the home metrics, the sidebar and the agent cards. | F |
| I-12 | **No fake directories.** SkillHub creates a client skills folder only when the client has install evidence (same rule as today) and its takeover is on. | B |

---

## 1. Plain-language vocabulary (S1-10)

The UI uses only three nouns: **技能 / 技能包**, **MCP** and **AI 工具**. Status uses one verb family: **已同步 / 未同步 / 不支持**.

| Old term (where it appears) | zh (new) | en | ko |
|---|---|---|---|
| 宿主、Agent、客户端、适配器 | AI 工具 | AI tool | AI 도구 |
| 来源、仓库 (as a library row) | 技能包 | skill pack | 스킬 팩 |
| 父 Skill、父入口、父路由 | *(not shown; the row is the entry)*. The copy button says 复制调用名 | Copy invocation name | 호출 이름 복사 |
| 子 Skill | 技能 / 包含的技能 | skills in this pack | 포함된 스킬 |
| 投递、交付、连接 Skills | 同步 | sync | 동기화 |
| 已投递、已交付、已接管 (per pack) | 已同步到 {tool} | Synced to {tool} | {tool}에 동기화됨 |
| 待同步、待接管 | 未同步 | Not synced | 동기화 안 됨 |
| 仅检测、尚不自动投递 | 不支持 | Not supported | 지원 안 됨 |
| 接管 (tool switch; this word stays) | 接管 / 已接管 / 可接管 | Managed / Manage | 관리 |
| 隔离区、staging、暂留隔离区 | 正在下载… / 正在检查安全… / 取消安装 | Downloading… / Checking safety… / Cancel | 다운로드 중… / 안전 검사 중… / 취소 |
| 提升为受管理来源 | 正在安装… | Installing… | 설치 중… |
| 安全复核、安全闸门 | 安装前需要你确认 | Needs your review before install | 설치 전 확인 필요 |
| 仅加入本地管理并保持停用 | 仅加入技能库（保持停用） | Add to library only (kept off) | 라이브러리에만 추가(꺼짐 유지) |
| 真实写入授权、未授权 · 只刷新索引、刷新本地索引 | *(deleted)* | — | — |
| 暂停 (new) | 暂停同步到 AI 工具 | Pause syncing to AI tools | AI 도구 동기화 일시 중지 |
| 路由、父路由隔离、路由观测站、裸名分发器 | *(never shown outside 开发者模式)* | — | — |
| 维护工具 | ⋯ → 修复 | ⋯ → Repair | ⋯ → 복구 |
| 重新读取简介 | 重新识别简介和分类 | Re-detect summaries & categories | 요약·분류 다시 인식 |
| 工作区 | *(page deleted; a later project feature will be called 项目)* | — | — |
| 连接中心 | MCP | MCP | MCP |
| 适配器注册表、识别规则 N 个 | 支持的工具 | Supported tools | 지원 도구 |
| 适配器医生、证据不足 | 诊断 / 没找到安装证据 | Diagnostics / No install evidence | 진단 / 설치 흔적 없음 |
| 健康问题、需复查 | 问题 / 需要注意 | Problems / Needs attention | 문제 / 확인 필요 |
| 同步并刷新、刷新本地索引 | 更新 | Update | 업데이트 |
| 导出排错包 | 生成排错报告 | Create troubleshooting report | 문제 해결 보고서 만들기 |
| (Coze card) | 与 Codex 共用目录 | Shares a folder with Codex | Codex와 폴더 공유 |
| (Cursor and Gemini CLI) | 实验性 | Experimental | 실험적 |

Banned in zh user-facing strings outside 开发者模式 (enforced by the node test in §8.2): `宿主 投递 交付 闸门 隔离区 路由 staging dry-run 适配器 待接管 真实写入`.

---

## 2. Data model

### 2.1 New tables (B; add to `ensure_runtime_schema`, lib.rs:5859-6111)

The rescan (`persist_snapshot`, lib.rs:8384-8710) and the detection refresh (lib.rs:8720-8790) delete and rebuild `sources`, `skills`, `agents` and `agent_adapters`. User intent therefore has to live in tables those two paths **never touch**, with no foreign keys to the rebuilt tables.

```sql
-- One row per (delivery unit × AI tool) that the user (or a default) has expressed intent for.
-- A missing row means "off", except for the default materialization rules in §2.4.
CREATE TABLE IF NOT EXISTS agent_skill_targets (
    source_id    TEXT NOT NULL,                 -- unit id: sources.id, or 'standalone:' || skills.id
    agent_id     TEXT NOT NULL,                 -- catalog id: claude|codex|coze|antigravity|workbuddy|cursor|gemini-cli
    enabled      INTEGER NOT NULL DEFAULT 0,    -- desired state (user intent); 1 = should be synced
    origin       TEXT NOT NULL DEFAULT 'user',  -- user|default|migration|install|onboarding|adopt
    mode         TEXT NOT NULL DEFAULT 'none',  -- mode used by the last successful write: link|shared-real|none
    entry_name   TEXT NOT NULL DEFAULT '',      -- folder name in the tool (parent entry or single skill), last read-back
    target_path  TEXT NOT NULL DEFAULT '',      -- absolute path of the entry, last read-back
    content_hash TEXT NOT NULL DEFAULT '',      -- sha256 of the delivered SKILL.md bytes, last read-back
    status       TEXT NOT NULL DEFAULT 'pending',  -- read-back status, see SkillTargetStatus (§4.3)
    error_code   TEXT NOT NULL DEFAULT '',      -- SkillHubErrorCode when status = error|conflict
    last_error   TEXT NOT NULL DEFAULT '',      -- plain-language, redacted, at most 400 chars
    updated_at   TEXT NOT NULL,                 -- time the desired state last changed
    verified_at  TEXT NOT NULL DEFAULT '',      -- time of the last read-back
    PRIMARY KEY (source_id, agent_id)
);
CREATE INDEX IF NOT EXISTS idx_agent_skill_targets_agent
    ON agent_skill_targets(agent_id, enabled);

-- Per-tool takeover switch. Replaces agent_adapters.enabled as the source of truth.
CREATE TABLE IF NOT EXISTS agent_takeover (
    agent_id          TEXT PRIMARY KEY,
    enabled           INTEGER NOT NULL DEFAULT 0,   -- 1 = SkillHub manages skills in this tool
    auto_add_new      INTEGER NOT NULL DEFAULT 1,   -- new library-enabled packs get a desired row (§2.4); not exposed in 3.3.0 UI
    origin            TEXT NOT NULL DEFAULT 'user', -- user|migration|onboarding
    custom_skills_path TEXT NOT NULL DEFAULT '',    -- reserved for S1-6; must stay '' in 3.3.0
    last_outcome      TEXT NOT NULL DEFAULT '',     -- AgentDeliveryOutcome of the last job
    last_error_code   TEXT NOT NULL DEFAULT '',
    last_error        TEXT NOT NULL DEFAULT '',
    last_delivered_at TEXT NOT NULL DEFAULT '',
    updated_at        TEXT NOT NULL
);
```

The column names `source_id, agent_id, enabled, mode, target_path, content_hash, status, last_error, updated_at` keep the names given in the brief (S0-4). The column is called `source_id` so that identity migration remaps it automatically (§2.6).

### 2.2 Preference keys (existing `operator_preferences` table, lib.rs:5924)

| key | values | meaning |
|---|---|---|
| `skill_delivery_paused` | `'0'` / `'1'` | Global pause, enforced by the backend (I-1). |
| `onboarding_status` | `'pending'` / `'completed'` | `pending` blocks client writes exactly like pause does. |
| `onboarding_completed_at` | ISO time | Diagnostics only. |
| `v33_delivery_migration` | `'done:<unix-ts>'` | Makes the one-time migration in §2.3 idempotent. |
| `agent_delivery_fingerprint_v1` (existing `AGENT_DELIVERY_FINGERPRINT_KEY`, lib.rs:71) | sha256 | Now also hashes the inputs in §2.5. |

The key `real_writes_enabled` stays in the table, but **nothing reads it any more** for delivery or UI. Only the developer-mode router preview (`regenerate_router_hubs`, lib.rs:19061-19075) reads it, and only as a dry run.

### 2.3 One-time migration `migrate_v33_delivery_state(root, connection)` (B)

Call it under the background write guard at the start of `ensure_agent_skill_delivery_blocking` (lib.rs:1922), of the first delivery-queue job and of `list_skill_agents`. It is idempotent through `v33_delivery_migration` and runs as one IMMEDIATE transaction for the SQL part.

1. **Find existing SkillHub entries per tool.** This is a filesystem read only. For each deliverable catalog agent (`claude, codex, coze, antigravity, workbuddy`), resolve its recipient path with the same rules as `delivery_recipient_states` (lib.rs:2547-2708). A tool **has entries** when its folder contains at least one:
   - reparse point whose target is under `active_skills_dir(root)` (lib.rs:5435), or
   - directory for which `shared_skill_catalog::is_managed_entry` returns true (shared_skill_catalog.rs:115).

   `codex` and `coze` share one result while `real_shared` is true. `codex-legacy` counts for `codex`.
2. **Takeover rows.**
   ```sql
   INSERT OR IGNORE INTO agent_takeover (agent_id, enabled, auto_add_new, origin, updated_at)
   VALUES (?agent, ?has_entries, 1, 'migration', ?now);          -- for every catalog agent id
   ```
   Cursor and Gemini CLI always start at `enabled = 0`. They have no entries yet and are experimental.
3. **Targets for library-enabled packs × taken-over tools** (the brief's rule: "every source currently enabled → targets on for those agents"):
   ```sql
   INSERT OR IGNORE INTO agent_skill_targets (source_id, agent_id, enabled, origin, status, updated_at)
   SELECT s.id, t.agent_id, 1, 'migration', 'pending', ?now
   FROM sources s
   LEFT JOIN source_overrides so ON so.source_id = s.id
   JOIN agent_takeover t ON t.enabled = 1
   WHERE COALESCE(so.enabled, s.enabled, 1) = 1;

   INSERT OR IGNORE INTO agent_skill_targets (source_id, agent_id, enabled, origin, status, updated_at)
   SELECT 'standalone:' || k.id, t.agent_id, 1, 'migration', 'pending', ?now
   FROM skills k
   LEFT JOIN skill_overrides ko ON ko.skill_id = k.id
   JOIN agent_takeover t ON t.enabled = 1
   WHERE (k.source_id IS NULL OR k.source_id = '')
     AND k.is_router_hub = 0
     AND COALESCE(ko.enabled, k.enabled, 1) = 1;
   ```
   Packs that are library-disabled get **no** rows. They materialize when they are enabled again (§2.4), which keeps the 3.2.18 meaning of "enable means deliver to every managed tool".
4. **Onboarding and pause.**
   - `onboarding_status = 'completed'` when the stored delivery fingerprint is non-empty **or** any takeover row has `enabled = 1`. This is an existing user, who sees no onboarding screen.
   - Otherwise `onboarding_status = 'pending'`. This is a fresh install: I-1 applies and the onboarding screen shows.
   - Set `skill_delivery_paused = '0'`.
5. **Runtime config.** Force `manageAgentLinks = false` in `skillhub.config.json`, replacing the `or_insert` at lib.rs:5807 with an unconditional insert. Otherwise `SkillHub.ps1:1814-1818` could call the link script without the targets file and bypass I-1 and I-2.
6. Bump `AGENT_DELIVERY_POLICY_VERSION` (lib.rs:72) to `"parent-first-v3.3-targets"`. That forces one asynchronous full reconcile after the upgrade, which moves existing users onto targets mode.
7. Write `v33_delivery_migration`, and write an audit event `v33_delivery_migrated` with counts only.

### 2.4 Default materialization (B; runs at the start of every delivery job, as pure SQL)

- **A pack becomes library-enabled and has zero rows** (new install, enabled again, or discovered by update): insert `enabled = 1, origin = 'default'` for every agent with `agent_takeover.enabled = 1 AND auto_add_new = 1`.
- **A tool's takeover goes from 0 to 1** with `fill_targets != false`: `INSERT OR IGNORE` an `enabled = 1, origin = 'default'` row for every library-enabled unit. Existing rows, including explicit offs, are kept.
- **Takeover goes off:** rows are kept, so earlier per-pack choices survive. The next job *releases* that tool (§3.4).
- **A unit disappears** (pack deleted) and the read-back finds no entry for it: delete its rows.
- **Install and adopt** write rows explicitly (`origin = 'install' | 'adopt'`). Because rows then exist, materialization does not override the agent chips the user chose.

### 2.5 Delivery fingerprint (B)

`agent_delivery_fingerprint_for_plan` (lib.rs:2726-2851) must additionally hash:

- `paused` and `onboarding_status`
- the sorted list of `(agent_id, takeover)`
- for each recipient, its action and its sorted names (§3.3)

While paused or pending: never write the fingerprint, and `agent_delivery_links_are_healthy_for_plan` (lib.rs:3155) is not evaluated. Unpausing therefore always triggers a reconcile.

### 2.6 Identity migration (B)

Add `"agent_skill_targets"` to `SOURCE_KEYED_TABLES` (identity_migration.rs:323-333). `UPDATE OR REPLACE … SET source_id` works with the composite primary key. `standalone:` keys are never source ids, so they are unaffected.

### 2.7 SQLite concurrency (B)

`open_index_database` (lib.rs:5830-5857) sets `PRAGMA busy_timeout = 5000`. Target and takeover mutations write SQLite without the background write guard (I-4), so they must wait for, not fail on, a concurrent IMMEDIATE rescan transaction.

---

## 3. Delivery engine (B-internal; F needs the behaviour, not the code)

### 3.1 Delivery units and entry names

- **Source unit:** `unitId = sources.id`. Its entry is the generated parent (`GeneratedAgentSkillDependency::Source`, lib.rs:2226-2242) when the pack has two or more skills. A single-skill pack's entry is that skill's own folder (router status `skipped-single-child`, lib.rs:307).
- **Standalone unit:** `unitId = "standalone:" + skills.id` for a skill with an empty `source_id` that is not a router hub. Its entry is its folder name (the direct entry at lib.rs:2363-2371).
- **Library-enabled** = source effective-enabled (`COALESCE(source_overrides.enabled, sources.enabled, 1)`) **and** at least one effective-enabled child **and** the entry is present in the final active catalog with a valid manifest.

  Otherwise `libraryOnlyReason` is one of `security-review` (also when `source_security_state.scan_status` is not `passed`), `disabled-by-user`, `no-enabled-skills`, `prompt-only` or `invalid-manifest`.
- **Union allowlist** = exactly today's `expected_agent_skill_allowlist` (lib.rs:2414-2420). Per-agent lists are always subsets of it.

### 3.2 Recipients per agent

| agent_id | recipient path | mode | write path | can deliver | experimental |
|---|---|---|---|---|---|
| `claude` | `$CLAUDE_CONFIG_DIR/skills` or `~/.claude/skills` (lib.rs:2555-2560) | link | PS `Sync-ManagedSkillDirectory` | yes | no |
| `codex` | `~/.agents/skills`, plus `~/.codex/skills` only if that folder already exists (lib.rs:2596, 2647, 2703-2706) | link, or shared-real when `real_shared` | PS; Rust `sync_shared` when shared | yes | no |
| `coze` | `~/.agents/skills` (shared-real only) | shared-real | Rust `shared_skill_catalog::sync_shared` (lib.rs:2106-2115) | yes | no |
| `antigravity` | `~/.gemini/antigravity/skills` | link | PS | yes | no |
| `workbuddy` | `client_installation::workbuddy_skills_root(home)` | link | PS | yes | no |
| `cursor` | `~/.cursor/skills` | link | PS (new) | yes | **yes** |
| `gemini-cli` | `~/.gemini/skills` | link | PS (new) | yes | **yes** |
| `opencode`, `github-copilot`, `windsurf`, `kiro`, `hermes`, `openclaw`, `amp` | — | — | — | no (`unsupportedReason`) | — |

- **Cursor and Gemini CLI install evidence (I-12).**
  - Cursor: `client_installation::cursor_executable()`, a new function using the same registry and known-path probes as `AgentInstallDiscovery.ps1:527` (`Cursor.exe` under `%LOCALAPPDATA%\Programs\cursor`, or the registry `InstallLocation`), or `command_exists("cursor")`.
  - Gemini CLI: `command_exists("gemini")`, or `%APPDATA%\npm\gemini.cmd`.
  - A pre-existing `~/.cursor` or `~/.gemini` folder alone never counts as evidence.
- **Experimental.** `experimental: true` means SkillHub writes the entry and verifies the read-back (`SKILL.md` readable with non-empty `name` and `description`, DECISIONS.md:1062), but nobody has yet confirmed in the real host that the skill can be invoked. Such tools are not preselected in onboarding or in the install chips. `experimentalReason` = "SkillHub 能写入并读回，但还没在真实的 {name} 里确认能调用".
- **Codex/Coze group (I-9).** While `real_shared` is true:
  - `set_agent_takeover("codex" | "coze", …)` writes both rows in one transaction.
  - `set_skill_target(unit, "codex" | "coze", …)` writes both rows.
  - Both report `linkedAgentIds`.
  - When `real_shared` is false they are independent. `coze` is then deliverable only if Coze is installed, which would make `real_shared` true anyway.

### 3.3 Targets file (Rust → PowerShell), the new input to `Manage-AgentSkillLinks.ps1`

Rust writes `private_state_dir(root)/agent-skill-targets.json` (UTF-8, no BOM) and passes it in the environment variable `AI_SKILLHUB_AGENT_SKILL_TARGETS`. It keeps setting `AI_SKILLHUB_AGENT_SKILL_ALLOWLIST` to the union (lib.rs:2129-2132) for backward compatibility.

```json
{
  "version": 1,
  "policyVersion": "parent-first-v3.3-targets",
  "union": ["nature-paper-skills--boom5426", "impeccable"],
  "recipients": [
    { "id": "claude",       "action": "deliver", "path": "C:\\Users\\u\\.claude\\skills",            "names": ["impeccable"] },
    { "id": "workbuddy",    "action": "release", "path": "C:\\Users\\u\\.workbuddy\\skills",          "names": [] },
    { "id": "antigravity",  "action": "skip" },
    { "id": "codex",        "action": "deliver", "path": "C:\\Users\\u\\.agents\\skills", "shared": true, "names": ["impeccable"] },
    { "id": "codex-legacy", "action": "deliver", "path": "C:\\Users\\u\\.codex\\skills", "linkRoot": "C:\\Users\\u\\.agents\\skills", "names": ["impeccable"] },
    { "id": "cursor",       "action": "deliver", "path": "C:\\Users\\u\\.cursor\\skills",             "names": ["impeccable"] },
    { "id": "gemini-cli",   "action": "skip" }
  ]
}
```

The three actions:

- **`deliver`:** make the recipient contain exactly our entries for `names`, plus whatever personal entries are already there.
- **`release`:** remove only reparse points whose target is under `$Shared` or `linkRoot`. This is the existing cleanup at PS:473-483 with an empty name set. No presence check, because releasing an uninstalled tool's leftovers is allowed.
- **`skip`:** do not touch the recipient.

PowerShell rules. These are additive: when the targets variable is absent, the script behaves byte-for-byte as in 3.2.18, so the existing PS tests keep passing.

1. Parse the targets JSON before touching anything, using the same 5.1 decoding caution as PS:315-326. Fail closed, with no recipient touched, when:
   - `union` is non-empty and matches zero valid active entries (the existing check at PS:331-333), or
   - any recipient's `names` contains a name outside `union`, or
   - an unknown `action` or `id` appears.
2. Run `deliver` only if the PowerShell presence check for that id also passes:
   - existing checks: `Test-ClaudeCodePresent`, Codex/OpenAI, `Test-AntigravityPresent`, `Test-WorkBuddyPresent`
   - new checks: `Test-CursorPresent` and `Test-GeminiCliPresent`, reusing `Get-AgentDesktopExecutable` and `Get-AgentCliExecutable` from `AgentInstallDiscovery.ps1`

   If the check fails, record `skipped-not-installed` and never create the folder (I-12).
3. Per recipient, call `Sync-ManagedSkillDirectory` with the new `-Names <string[]> -ConflictPolicy Skip`:
   - A same-name entry that is not a reparse point into `$Shared` or `linkRoot` is **skipped and recorded as a `conflict`** entry. It is not moved (I-2) and the recipient does not fail.
   - The post-write `SKILL.md` and child-path verification (PS:503-540) runs only for the names actually linked.
4. A failure in one recipient is recorded and the script **continues with the other recipients and exits 0**. Only the global fail-closed conditions in rule 1 exit non-zero. (Today PS:639-641 throws when any recipient fails.)
5. Write a report to `$env:AI_SKILLHUB_DELIVERY_REPORT` (UTF-8 with BOM, like the other PS reports):
   ```json
   { "version": 1, "generatedAt": "2026-10-07T10:42:00Z",
     "recipients": [ { "id": "claude", "path": "…", "action": "deliver",
       "outcome": "ok|partial|failed|skipped|skipped-not-installed|released",
       "error": "", "entries": [ { "name": "impeccable", "state": "linked|unchanged|removed|conflict|invalid-manifest", "detail": "" } ] } ] }
   ```
6. The shared Coze/Codex folder stays in Rust (`sync_shared`), called with the `codex` or `coze` group names, or with `[]` for release. `plan_shared` (shared_skill_catalog.rs:136-216) changes so that a same-name personal entry (lines 174-193) is skipped and returned as a conflict list instead of `Err`. Bug #15 (lenient `wrapper()`) is fixed in the same file.

### 3.4 What each job does

| depth | Steps | Used by |
|---|---|---|
| `verify` | Migration if needed → materialize (§2.4). If paused or pending: read back, phase `paused`, stop. If `agent_delivery_is_current` (lib.rs:3236): read back, done. Otherwise escalate to `full`. | startup, `ensure_agent_skill_delivery` |
| `links` | Materialize → write targets file → `run_agent_link_script` (which includes `sync_shared`) → read back all targets → fingerprint, only if no agent `failed` | target toggles, takeover toggles, pause off |
| `full` | Existing `reconcile_agent_skill_delivery` (lib.rs:2006-2023): routers → dispatchers → `SkillHub.ps1 -NoPull` → `finalize_agent_skill_delivery` (scan → links → health → fingerprint), with the link step as in `links` → read back | child-skill toggle, library enable or disable, install, adopt, delete, rollback, conflict choice, "立即同步" / "修复", and `verify` escalation |

Read-back is the authority for `SkillTarget.status` (I-3). For every `(unit, agent)` in the targets set (§4.3), in this order:

1. The agent cannot deliver → the pair is not listed.
2. Paused or pending, and the desired state differs from what is on disk → `paused`. Otherwise use the disk state from step 3.
3. Look at the entry `<recipient>/<entryName>`:
   - Absent: `off` when not desired. When desired, `pending` if a job is queued, or `error` with code `DELIVERY_VERIFY_FAILED` after a job.
   - Ours (a reparse point whose target equals `active/<entry>`, or `shared/<entry>` for codex-legacy; or `is_managed_entry` in shared mode):
     - If `SKILL.md` is readable with non-empty name and description: `synced`. If it is not desired: `removing` while a job is queued, otherwise `error`.
     - If the manifest is unreadable or invalid: `error` with code `MANIFEST_INVALID`.
   - Not ours: `conflict`, with `conflict.kind` set. `sameContent` is true when the sha256 of the bytes of its `SKILL.md` equals ours.
4. The tool is not installed but our entry exists → `orphan`.
5. The unit is not library-enabled while the desired state is on → `blocked`.
6. Takeover is off but our entry still exists → `removing` (queued) or `paused`.

### 3.5 Debounced queue (`delivery_queue.rs`, new)

- **Single worker thread**, started in `tauri::Builder::setup` (lib.rs:19189) with the `AppHandle`. It is the only code path that runs the link script for UI mutations.
- **`request(depth, reason)`** merges into one pending batch: depth becomes the max over `verify < links < full`, and reasons are unioned. It returns `{jobId, phase:"queued", coalesced}` and emits `delivery-status` with phase `queued`.
- **Debounce.** The batch starts when the newest request is **600 ms** old, or at the latest **3 s** after the first one. Requests that arrive while a job runs collect into exactly **one** follow-up batch.
- **Write guard.** The worker acquires the background write guard (lib.rs:1399) by waiting, not by `try_lock`. It retries every 250 ms for up to 15 min and emits phase `waiting`, with `waitingFor` set to the plain-language label of the operation holding the lock (for example "正在更新技能包").
- **Phases:**
  - `running` when the guard is held
  - then `done`, `failed` (a global error such as `DELIVERY_POLICY_INVALID`, `SCRIPT_TIMEOUT` or `INDEX_FAILED`), or `paused`
  - Per-agent failures still finish as `done`, with `AgentDeliveryResult.outcome = failed`.
- **Testability.** The core state machine `DeliveryQueueCore { request(now,…), due(now) -> Option<Batch>, finish(batch) }` is pure: it takes the clock as a parameter, so it can be unit-tested (§8.1).
- **Other link-script callers.** Every other path that runs the link script (`run_skillhub_sync`, rollback and so on) calls the shared `deliver_and_verify` helper, so read-back and the `done` event happen there too. The `AppHandle` is kept in a `OnceLock` for this.

### 3.6 Pause and onboarding enforcement (I-1)

At the very top of `run_agent_link_script` (lib.rs:2098):

```rust
if delivery_writes_blocked(connection)? {   // paused == '1' || onboarding_status == 'pending'
    return Ok(DeliveryRun::Blocked);         // nothing under any client path is created, changed or removed
}
```

The following still run while blocked, because they touch only SkillHub-owned data under `UserData`:

- router regeneration
- `SkillHub.ps1 -NoPull`
- the index scan
- writing the targets file (the report only)
- the read-back

The UserData `skills-catalog` (`shared_skill_catalog::sync`, lib.rs:2160) is **also** skipped while blocked, because older Coze setups registered it as a scan folder.

Pause semantics in user words: **"暂停后，SkillHub 不会在任何 AI 工具的目录里新建、删除或修改入口。已有入口保持原样；技能包更新后，已有入口里看到的是更新后的内容。"**

### 3.7 Child-skill switch (S0-4, S0-5, bug #18 rust-core)

`set_child_skill_enabled` writes `skill_overrides.enabled` (lib.rs:8191-8221) and enqueues `full`.

Router generation (`plan_or_write_router_hubs`, lib.rs:18774; the `SkillHub.ps1` router builder at about lines 783-878) must **leave disabled children out** of the parent's child list. A pack with no enabled children is unpublished (`no-enabled-skills`). This fixes bug #18: today a disabled child is still reachable through the parent.

### 3.8 Write-guard waiting for long commands

`install_skill_source`, `adopt_external_skills` and `run_skillhub_sync` use `acquire_background_write_guard_waiting(operation, timeout = 120 s)`. While waiting they emit `source-import-progress` with stage `wait`, so they do not fail on a running delivery job (bug #1 frontend-shell is the matching UI half).

### 3.9 Folder picker and drop

- **Picker.** `pick_skill_source_path` uses `tauri-plugin-dialog` **from Rust only**: `app.dialog().file().blocking_pick_folder()` or `.add_filter("技能包", &["zip","skill"]).blocking_pick_file()`, inside `spawn_blocking`. The frontend never calls a `dialog:` plugin command, so `capabilities/default.json` gets **no** `dialog:*` permission. The DECISIONS.md:969 capability gate is satisfied and checked by a test.
- **Drop.** On Windows, native file drop needs `"dragDropEnabled": true` (tauri.conf.json, window 0). That setting disables HTML5 drag and drop *inside* the webview (Tauri documents this).
  - **F** flips the flag **and** converts the two internal drags to pointer-event drags with a grip handle (DECISIONS.md:1097 handle semantics): pack row → folder chip, and standalone skill → folder chip (`pages/Library.tsx@d20c3b8` `draggable` uses).
  - **B** adds `.on_window_event` that handles `WindowEvent::DragDrop(DragDropEvent::Drop{paths,..})`. It keeps at most 5 paths that are existing directories or `.zip`/`.skill` files and emits `skill-source-dropped` `{paths}`.

  Either half works without the other: without the flag the event never fires, and without the handler a drop does nothing.

---

## 4. Tauri API

### 4.1 Conventions (unchanged from the existing code)

- `#[tauri::command]` functions take snake_case parameters. JS passes camelCase keys, and Tauri 2 converts them (for example `invoke("set_source_version_pin", { sourceId, pinned })`, App.tsx@7b71c94:1008).
- Every DTO is `#[derive(Serialize, Clone)] #[serde(rename_all = "camelCase")]`, like `SourceCard` at lib.rs:551-574.
  - `Option<T>` serializes as `null`. **Never** use `skip_serializing_if`, because the TS types say `T | null`, not optional.
  - Request structs are `#[derive(Deserialize)] #[serde(rename_all = "camelCase")]`, with `#[serde(default)]` on every `Option` and `Vec` field.
  - String enums are lowercase-kebab `&'static str` constants.
- Every **new** command returns `Result<T, SkillHubError>` (§4.5). Existing commands keep `Result<T, String>`.
- Long or filesystem-heavy commands are `async fn` with `run_blocking_task(...)` (lib.rs:1366). No new command may be a sync `fn` doing IO on the main thread (bug #16). The one exception is `parse_skill_source_input`, which does at most one `fs::metadata` call.
- Events are emitted with `app.emit(name, payload)`. Listening needs `core:event:allow-listen`, which is already granted (capabilities/default.json).

### 4.2 Command list

| # | Rust command (exact) | Parameters (Rust) | TS wrapper (`src/skillApi.ts`) | Returns | Blocking? | Events | Error codes |
|---|---|---|---|---|---|---|---|
| 1 | `get_skill_delivery_state` | — | `getSkillDeliveryState()` | `SkillDeliveryState` | async, SQLite only, no read-back | — | INDEX_FAILED |
| 2 | `list_skill_agents` | — | `listSkillAgents()` | `SkillAgentList` | async, cached evidence (no PS) | — | INDEX_FAILED |
| 3 | `set_agent_takeover` | `agent_id: String, enabled: bool, fill_targets: Option<bool>` | `setAgentTakeover(agentId, enabled, fillTargets?)` | `TakeoverResult` | async, under 300 ms, enqueues `links` | `delivery-status` | AGENT_UNKNOWN, AGENT_UNSUPPORTED, AGENT_NOT_INSTALLED (enable only), ONBOARDING_REQUIRED (enable while pending → use `complete_onboarding`) |
| 4 | `set_skill_delivery_paused` | `paused: bool` | `setSkillDeliveryPaused(paused)` | `DeliveryControlState` | async; unpause enqueues `full` | `delivery-status` | — |
| 5 | `set_skill_target` | `unit_id: String, agent_id: String, enabled: bool` | `setSkillTarget(unitId, agentId, enabled)` | `TargetMutationResult` | async, under 300 ms, enqueues `links` | `delivery-status` | UNIT_NOT_FOUND, AGENT_UNKNOWN, AGENT_UNSUPPORTED, AGENT_NOT_TAKEN_OVER (action `takeover-agent`), SOURCE_LIBRARY_ONLY (enable only; action `review-security` when the reason is `security-review`) |
| 6 | `set_skill_targets_batch` | `changes: Vec<TargetChangeInput>` (at most 2000) | `setSkillTargetsBatch(changes)` | `TargetMutationResult` (per-item `rejected`, never all-or-nothing) | async, one enqueue | `delivery-status` | same as #5, per item |
| 7 | `set_child_skill_enabled` | `folder_name: String, enabled: bool` | `setChildSkillEnabled(folderName, enabled)` | `ChildSkillToggleResult` | async, under 300 ms, enqueues `full` | `delivery-status` | UNIT_NOT_FOUND, INDEX_FAILED |
| 8 | `set_source_library_enabled` | `source_id: String, enabled: bool, security_review_confirmed: bool` | `setSourceLibraryEnabled(sourceId, enabled, securityReviewConfirmed)` | `SourceLibraryResult` | async, enqueues `full` | `delivery-status` | UNIT_NOT_FOUND, SECURITY_REVIEW_REQUIRED (enable a flagged pack without confirmation; `detail` = finding summary), SECURITY_BLOCKED |
| 9 | `request_skill_delivery` | `reason: String, depth: String /*verify,links,full*/, refresh_detection: Option<bool>` | `requestSkillDelivery(reason, depth, refreshDetection?)` | `DeliveryJobTicket` | async, returns immediately | `delivery-status` | INTERNAL (bad depth) |
| 10 | `get_onboarding_state` | — | `getOnboardingState()` | `OnboardingState` | async (runs the adopt-preview scan) | — | INDEX_FAILED |
| 11 | `complete_onboarding` | `agent_ids: Vec<String>, adopt_existing_skills: bool` | `completeOnboarding(agentIds, adoptExistingSkills)` | `OnboardingResult` | async; adopt is long and cancellable through `cancel_source_import(operationId)` | `delivery-status`, `source-import-progress` (stage `adopt`) | AGENT_UNSUPPORTED, AGENT_NOT_INSTALLED |
| 12 | `parse_skill_source_input` | `input: String` | `parseSkillSourceInput(input)` | `ParsedSkillSource` (errors are inside `error`, never thrown) | sync, pure | — | — |
| 13 | `probe_skill_source` | `app: AppHandle, operation_id: Option<String>, input: String` | `probeSkillSource(input, operationId)` | `SkillSourceProbe` | async, long, cancellable through the existing `cancel_source_import` (lib.rs:4932) | `source-import-progress` (existing payload, lib.rs:986-995; stages `inspect`, `git`, `zip`, `write`, `security`, `enumerate`) | INPUT_EMPTY, INPUT_UNRECOGNIZED, INPUT_IS_MCP_CONFIG, PATH_NOT_FOUND, PATH_NOT_ABSOLUTE, ZIP_INVALID, GITHUB_NOT_FOUND, GITHUB_RENAMED, GITHUB_REF_NOT_FOUND, GITHUB_SUBPATH_NOT_FOUND, NETWORK_FAILED, DOWNLOAD_TIMEOUT, GIT_MISSING (only when the ZIP fallback also failed), NO_SKILLS_FOUND (only when there are also no prompt docs and no MCP configs), CANCELLED |
| 14 | `install_skill_source` | `request: InstallSkillSourceRequest` | `installSkillSource(request)` | `InstallSkillSourceResult` | async; promote and one index scan inline, then enqueue `full` | `source-import-progress` (stages `wait`, `install`, `index`), `delivery-status` | PROBE_EXPIRED, PROBE_STALE, SECURITY_REVIEW_REQUIRED (flagged and not confirmed), SECURITY_BLOCKED, DUPLICATE_SOURCE (only when `relation=same` and nothing to change), WRITE_BUSY (guard wait timed out) |
| 15 | `discard_skill_source_probe` | `probe_id: String` | `discardSkillSourceProbe(probeId)` | `bool` | async | — | — |
| 16 | `read_skill_source_probe_file` | `probe_id: String, relative_path: String` | `readSkillSourceProbeFile(probeId, relativePath)` | `ProbeFileText` (at most 96 KiB; only paths listed in `probe.mcpConfigs` or `promptDocs`) | async | — | PROBE_EXPIRED, PATH_NOT_FOUND |
| 17 | `pick_skill_source_path` | `app: AppHandle, kind: String /*folder,zip*/` | `pickSkillSourcePath(kind)` | `Option<String>` | async (native dialog) | — | INTERNAL |
| 18 | `preview_adopt_external_skills` | `project_path: Option<String>` | `previewAdoptExternalSkills(projectPath?)` | `AdoptPreview` | async, read-only | — | INDEX_FAILED |
| 19 | `adopt_external_skills` | `app: AppHandle, candidate_ids: Vec<String>, operation_id: Option<String>` | `adoptExternalSkills(candidateIds, operationId)` | `AdoptReport` | async, long, cancellable | `source-import-progress` (stage `adopt`, current/total), then `delivery-status` once | WRITE_BUSY, CANCELLED |
| 20 | `list_agent_skills` | `agent_id: String` | `listAgentSkills(agentId)` | `AgentSkillInventory` (also refreshes the cached `counts.personal`) | async, read-only | — | AGENT_UNKNOWN |
| 21 | `open_agent_skills_folder` | `agent_id: String` | `openAgentSkillsFolder(agentId)` | `()` | async (reuses `open_path_with_system`) | — | AGENT_UNKNOWN, PATH_NOT_FOUND |
| 22 | `read_library_skill_document` | `skill_id: String` | `readLibrarySkillDocument(skillId)` | `LibrarySkillDocument` (`SKILL.md` and up to 200 file names, at most 256 KiB, managed roots only) | async | — | UNIT_NOT_FOUND |
| 23 | `export_troubleshooting_report` | — | `exportTroubleshootingReport()` | `TroubleshootingReport` (runs the existing `diagnostics-export` runner, lib.rs:16610, then returns its folder) | async | — | SCRIPT_FAILED |

Event names, defined as constants in `src/skillApi.ts` and as `const` values in Rust:

| Event | Payload | When |
|---|---|---|
| `delivery-status` | `DeliveryJobStatus` | on every phase change of every job |
| `skill-source-dropped` | `SkillSourceDroppedEvent` | native drop (§3.9) |
| `source-import-progress` (existing, lib.rs:85) | `SourceImportProgressEvent` (App.tsx@7b71c94; now `appShared.ts:120`) | probe, install and adopt |

### 4.3 TS types — paste this block at the end of `app-next/src/types.ts`

```ts
/* ===================== v3.3 Skills delivery contract =====================
   Canonical: docs/v3.3/skills-contract.md §4.3. Rust DTOs mirror these 1:1. */

export type AgentId =
  | "claude" | "codex" | "coze" | "antigravity" | "workbuddy" | "cursor" | "gemini-cli"
  | "opencode" | "github-copilot" | "windsurf" | "kiro" | "hermes" | "openclaw" | "amp";

/* ---------- errors (S1-9) ---------- */
export type SkillHubErrorCode =
  | "WRITE_BUSY" | "DELIVERY_PAUSED" | "ONBOARDING_REQUIRED"
  | "AGENT_UNKNOWN" | "AGENT_UNSUPPORTED" | "AGENT_NOT_INSTALLED" | "AGENT_NOT_TAKEN_OVER"
  | "AGENT_DIR_EXTERNAL_LINK" | "AGENT_DIR_NOT_WRITABLE"
  | "TARGET_CONFLICT" | "MANIFEST_INVALID" | "DELIVERY_VERIFY_FAILED" | "DELIVERY_POLICY_INVALID"
  | "SCRIPT_FAILED" | "SCRIPT_TIMEOUT" | "SCRIPT_MISSING"
  | "UNIT_NOT_FOUND" | "SOURCE_LIBRARY_ONLY" | "SECURITY_REVIEW_REQUIRED" | "SECURITY_BLOCKED"
  | "INPUT_EMPTY" | "INPUT_UNRECOGNIZED" | "INPUT_IS_MCP_CONFIG" | "INPUT_TOO_LONG"
  | "PATH_NOT_FOUND" | "PATH_NOT_ABSOLUTE" | "ZIP_INVALID"
  | "GITHUB_NOT_FOUND" | "GITHUB_RENAMED" | "GITHUB_REF_NOT_FOUND" | "GITHUB_SUBPATH_NOT_FOUND"
  | "NETWORK_FAILED" | "DOWNLOAD_TIMEOUT" | "GIT_MISSING"
  | "NO_SKILLS_FOUND" | "PROBE_EXPIRED" | "PROBE_STALE" | "DUPLICATE_SOURCE" | "CANCELLED"
  | "INDEX_FAILED" | "INTERNAL";

export type ErrorActionKind =
  | "retry" | "open-folder" | "reinstall" | "export-report" | "takeover-agent" | "review-security"
  | "resolve-conflict" | "open-settings" | "install-git" | "refresh" | "wait" | "open-mcp-add" | "open-existing";

/** The label is localized by the frontend: t(`err.action.${kind}`). */
export type ErrorAction = { kind: ErrorActionKind; payload: Record<string, string> };

export type SkillHubError = {
  code: SkillHubErrorCode;
  /** Backend plain-language fallback (zh). The UI prefers t(`err.${code}`, …) when that key exists. */
  message: string;
  /** Optional technical summary, at most 400 chars, redacted. Shown only under a "详情" disclosure. */
  detail: string;
  action: ErrorAction | null;
  agentId: string | null;
  sourceId: string | null;
  path: string | null;
};

/* ---------- AI tools ---------- */
export type AgentStatusWord = "taken-over" | "available" | "unsupported" | "not-installed";
export type AgentHealth = "ok" | "busy" | "problem" | "off";

export type AgentSkillCounts = {
  /** Units whose target status is "synced" for this tool. */
  packsSynced: number;
  /** Callable skills inside those units (same rule as countSkills, §4.6). */
  skillsSynced: number;
  /** Units with desired = true. */
  packsWanted: number;
  /** Targets in error | conflict | orphan. */
  problems: number;
  /** Unmanaged skills seen in the tool's folder at the last inventory; null = never scanned. */
  personal: number | null;
};

export type SkillAgent = {
  id: AgentId;
  /** Short plain name: "Claude Code", "Codex", "扣子", "Antigravity", "WorkBuddy", "Cursor", "Gemini CLI", … */
  name: string;
  vendor: string;
  installed: boolean;
  canDeliver: boolean;
  experimental: boolean;
  experimentalReason: string;
  unsupportedReason: string;
  takeover: boolean;
  statusWord: AgentStatusWord;
  health: AgentHealth;
  /** Absolute path; "" when unknown. The UI may display the home folder as "~". */
  skillsPath: string;
  /** ["coze"] on codex and ["codex"] on coze while they share ~/.agents/skills (I-9). */
  linkedAgentIds: AgentId[];
  /** "与 Codex 共用目录" / "与 扣子 共用目录" or "". */
  sharedFolderNote: string;
  /** Plain next step after syncing, e.g. "新开一个 Claude Code 会话后生效"; "" if none. */
  afterSyncHint: string;
  counts: AgentSkillCounts;
  lastResult: AgentDeliveryResult | null;
  /** AgentDoctorCard.verdict passthrough for the 诊断 tab. */
  doctorVerdict: string;
};

/* ---------- units & targets ---------- */
export type DeliveryUnitKind = "source" | "standalone";
export type LibraryOnlyReason =
  | "" | "security-review" | "disabled-by-user" | "no-enabled-skills" | "prompt-only" | "invalid-manifest";

export type DeliveryUnit = {
  /** sources.id, or "standalone:" + skills.id */
  unitId: string;
  kind: DeliveryUnitKind;
  sourceId: string;
  skillId: string;
  /** Folder name created in each AI tool (the parent entry, or the single skill). */
  entryName: string;
  callableSkills: number;
  libraryEnabled: boolean;
  libraryOnlyReason: LibraryOnlyReason;
};

export type SkillTargetStatus =
  | "synced" | "off" | "pending" | "removing" | "paused"
  | "conflict" | "error" | "orphan" | "blocked" | "takeover-off" | "unsupported";

export type SkillTargetConflict = {
  kind: "personal-folder" | "external-link" | "not-a-folder";
  /** The existing SKILL.md bytes equal ours. */
  sameContent: boolean;
  path: string;
};

export type SkillTarget = {
  unitId: string;
  agentId: AgentId;
  desired: boolean;
  status: SkillTargetStatus;
  mode: "link" | "shared-real" | "none";
  entryName: string;
  targetPath: string;
  contentHash: string;
  verifiedAt: string;
  updatedAt: string;
  error: SkillHubError | null;
  conflict: SkillTargetConflict | null;
};
export type SkillTargetKey = { unitId: string; agentId: AgentId };

export type DeliveryProblem = {
  id: string;
  code: SkillHubErrorCode;
  message: string;
  agentId: AgentId | null;
  unitId: string | null;
  action: ErrorAction | null;
};

/* ---------- delivery jobs ---------- */
export type DeliveryJobPhase = "queued" | "waiting" | "running" | "done" | "failed" | "paused";
export type DeliveryDepth = "verify" | "links" | "full";
export type AgentDeliveryOutcome =
  | "ok" | "partial" | "failed" | "skipped" | "paused" | "released" | "not-installed";

export type AgentDeliveryResult = {
  agentId: AgentId;
  outcome: AgentDeliveryOutcome;
  linked: number;
  removed: number;
  unchanged: number;
  conflicts: number;
  errors: number;
  error: SkillHubError | null;
  finishedAt: string;
};

export type DeliveryJobStatus = {
  jobId: number;
  phase: DeliveryJobPhase;
  depth: DeliveryDepth;
  /** Diagnostics only, e.g. "target", "child-skill", "startup". Never rendered as UI copy. */
  reasons: string[];
  queuedAt: string;
  startedAt: string;
  finishedAt: string;
  /** Plain label of the operation holding the write lock while phase = "waiting"; "" otherwise. */
  waitingFor: string;
  agents: AgentDeliveryResult[];
  changedTargets: SkillTargetKey[];
  /** True when library content or the index changed: reload the snapshot in the background. */
  snapshotStale: boolean;
  error: SkillHubError | null;
};
export type DeliveryJobTicket = { jobId: number; phase: DeliveryJobPhase; coalesced: boolean };

export type OnboardingStatus = "pending" | "completed";

/**
 * Agents are sorted: taken-over → available → unsupported → not-installed, then catalog order.
 * targets contains exactly one entry for every (unit × agent) where agent.canDeliver and
 * (agent.takeover || a SkillHub entry exists on disk). Pairs without a DB row appear as desired=false, status "off".
 */
export type SkillDeliveryState = {
  paused: boolean;
  onboarding: OnboardingStatus;
  agents: SkillAgent[];
  units: DeliveryUnit[];
  targets: SkillTarget[];
  problems: DeliveryProblem[];
  /** Running job, or the last finished one; null before the first job of this app run. */
  job: DeliveryJobStatus | null;
  generatedAt: string;
};
export type SkillAgentList = Pick<SkillDeliveryState, "agents" | "paused" | "onboarding" | "generatedAt">;

/* ---------- mutations ---------- */
export type TargetChange = { unitId: string; agentId: AgentId; enabled: boolean };
export type TargetRejection = { unitId: string; agentId: AgentId; error: SkillHubError };
export type TargetMutationResult = {
  /** Affected targets with their new status (pending | removing | paused | blocked …), never "synced" optimistically. */
  targets: SkillTarget[];
  /** Number of rows whose desired state really changed. */
  changed: number;
  unchanged: number;
  rejected: TargetRejection[];
  jobId: number | null;
};
export type TakeoverResult = {
  agents: SkillAgent[];
  linkedAgentIds: AgentId[];
  targetsCreated: number;
  jobId: number | null;
};
export type DeliveryControlState = { paused: boolean; onboarding: OnboardingStatus; jobId: number | null };
export type ChildSkillToggleResult = { skill: SkillCard; unit: DeliveryUnit | null; jobId: number | null };
export type SourceLibraryResult = {
  source: SourceCard;
  unit: DeliveryUnit;
  targets: SkillTarget[];
  jobId: number | null;
};

/* ---------- onboarding (S1-8) ---------- */
export type OnboardingAgent = {
  agentId: AgentId;
  name: string;
  statusWord: AgentStatusWord;
  canDeliver: boolean;
  experimental: boolean;
  /** installed && canDeliver && !experimental */
  preselected: boolean;
  /** Plain reason when not preselectable ("还不支持同步技能", "实验性", …). */
  reason: string;
};
export type OnboardingState = {
  status: OnboardingStatus;
  agents: OnboardingAgent[];
  /** null when the scan failed; the checkbox is then hidden. */
  existingSkills: {
    importable: number;
    alreadyManaged: number;
    duplicates: number;
    byAgent: Array<{ agentId: string; count: number }>;
  } | null;
};
export type OnboardingResult = {
  status: OnboardingStatus;
  agents: SkillAgent[];
  adopt: AdoptReport | null;
  jobId: number | null;
};

/* ---------- one-box source input, probe, install (S0-2) ---------- */
export type SkillSourceKind = "github" | "local-folder" | "zip" | "mcp-config" | "unknown";
export type ParsedGithubSource = {
  owner: string;
  repo: string;
  /** "" = default branch */
  ref: string;
  /** "" = whole repository; POSIX relative, no "..". */
  subpath: string;
  cloneUrl: string;
  webUrl: string;
};
export type ParsedSkillSource = {
  input: string;
  kind: SkillSourceKind;
  routeTo: "skills" | "mcp" | "invalid";
  /** e.g. "anthropics/skills · skills/pdf" */
  display: string;
  github: ParsedGithubSource | null;
  localPath: string;
  error: SkillHubError | null;
};

export type ProbeSkillNode = {
  /** Directory of SKILL.md, relative to the probed root, POSIX. */
  path: string;
  name: string;
  description: string;
  valid: boolean;
  invalidReason: string;
  /** A skill with the same name and content hash is already in the library. */
  inLibrary: boolean;
};
export type ProbeSkillGroup = {
  groupId: string;
  title: string;
  /** Set when the upstream repo ships its own parent/umbrella SKILL.md for this group. */
  parent: ProbeSkillNode | null;
  children: ProbeSkillNode[];
};
export type ProbeSecurity = {
  status: "passed" | "review" | "blocked";
  scannedFiles: number;
  findingCount: number;
  /** At most 8, most severe first. */
  findings: SourceSecurityFindingCard[];
  /** e.g. "检查了 312 个文件，发现 2 处需要注意（不会被执行）". */
  plainSummary: string;
  /** false for structural blocks. */
  canAddToLibrary: boolean;
  /** false whenever status !== "passed" (I-5). */
  canSyncToAgents: boolean;
};
export type ProbeAgentChip = {
  agentId: AgentId;
  name: string;
  preselected: boolean;
  disabled: boolean;
  disabledReason: string;
  experimental: boolean;
};
export type ProbeDuplicate = {
  sourceId: string;
  name: string;
  relation: "same" | "subset-of-existing" | "extends-existing";
};
export type SkillSourceProbe = {
  probeId: string;
  operationId: string;
  parsed: ParsedSkillSource;
  displayName: string;
  owner: string;
  sourceType: "skill" | "prompt" | "mixed";
  skillGroups: ProbeSkillGroup[];
  skillCount: number;
  promptDocs: Array<{ relativePath: string; title: string }>;
  /** Static detection only, nothing executed. Hand off to the MCP add flow (MCP contract). */
  mcpConfigs: Array<{ relativePath: string; format: "json" | "toml" | "readme-snippet"; serverNames: string[] }>;
  security: ProbeSecurity;
  /** One chip per deliverable, installed agent; preselected = takeover && !experimental. */
  agentChips: ProbeAgentChip[];
  duplicate: ProbeDuplicate | null;
  downloadMethod: "git" | "zip" | "copy" | "index";
  /** The staging copy is deleted after this time (30 min) or on discard. */
  expiresAt: string;
  warnings: string[];
};
export type InstallSkillSourceRequest = {
  probeId: string;
  /** Empty = all valid skills. Unselected valid children are imported but child-disabled. */
  selectedSkillPaths: string[];
  /** May be empty (= library only). Ignored and forced empty when security.status !== "passed". */
  agentIds: AgentId[];
  /** Must be true when security.status === "review"; the result is then library-only (I-5). */
  securityReviewConfirmed: boolean;
  displayName: string | null;
  folderId: string | null;
  newFolderName: string | null;
  categoryId: string | null;
  tags: string[];
  note: string | null;
};
export type InstallSkillSourceResult = {
  outcome: "installed" | "library-only" | "updated-existing" | "prompt-library";
  source: SourceCard;
  unit: DeliveryUnit | null;
  targets: SkillTarget[];
  disabledSkills: string[];
  jobId: number | null;
  snapshotStale: boolean;
  summary: string;
};
export type ProbeFileText = { relativePath: string; text: string; truncated: boolean };
export type SkillSourceDroppedEvent = { paths: string[] };

/* ---------- adopt existing skills (S0-11) ---------- */
export type AdoptCandidateState =
  | "new" | "already-managed" | "duplicate" | "name-clash" | "invalid-manifest" | "unreadable";
export type AdoptCandidate = {
  /** stable_id("adopt", canonicalPath) */
  id: string;
  name: string;
  description: string;
  state: AdoptCandidateState;
  /** true only for state "new" */
  selectedByDefault: boolean;
  canonicalPath: string;
  contentHash: string;
  agentIds: string[];
  locations: Array<{ agentId: string; path: string; storageKind: "directory" | "link" }>;
  /** Candidate id this one duplicates, "" otherwise. */
  duplicateOf: string;
  /** Unit that already holds the same content, "" otherwise. */
  managedUnitId: string;
};
export type AdoptPreview = {
  candidates: AdoptCandidate[];
  importable: number;
  alreadyManaged: number;
  duplicates: number;
  warnings: string[];
  truncated: boolean;
  scannedAt: string;
};
export type AdoptItemResult = {
  candidateId: string;
  name: string;
  outcome: "adopted" | "library-only" | "skipped-duplicate" | "skipped-managed" | "failed";
  sourceId: string;
  error: SkillHubError | null;
};
export type AdoptReport = {
  results: AdoptItemResult[];
  adopted: number;
  libraryOnly: number;
  skipped: number;
  failed: number;
  jobId: number | null;
  snapshotStale: boolean;
};

/* ---------- per-tool inventory, documents, report ---------- */
export type AgentSkillEntryState = "managed" | "personal" | "stale" | "conflict" | "invalid";
export type AgentSkillEntry = {
  name: string;
  description: string;
  path: string;
  storageKind: "directory" | "link";
  state: AgentSkillEntryState;
  unitId: string;
  adoptCandidateId: string;
};
export type AgentSkillInventory = {
  agentId: AgentId;
  skillsPath: string;
  entries: AgentSkillEntry[];
  warnings: string[];
  scannedAt: string;
};
export type LibrarySkillDocument = { skillId: string; path: string; content: string; truncated: boolean; files: string[] };
export type TroubleshootingReport = { reportPath: string; folderPath: string; generatedAt: string };
```

Also add this field to `LegacySnapshot` (types.ts:12-53):

```ts
  /** v3.3: filled by read_snapshot_from_database; optional only for old fixtures. */
  skillDelivery?: SkillDeliveryState;
```

Change these existing types:

- `NavKey` (types.ts:1-10): remove `"workspaces"` and `"sources"`, and add `"mcp"` as an alias target only if the MCP contract renames `connections`. Otherwise keep `"connections"` with the label **MCP**.

### 4.4 Rust DTOs (B) — must serialize to §4.3

Put them in the new `skill_delivery.rs`, `skill_source.rs` and `skillhub_error.rs`. Each Rust field is the snake_case form of the TS field:

```rust
#[derive(Debug, Clone, Serialize)] #[serde(rename_all = "camelCase")]
pub(crate) struct SkillHubError { pub code: String, pub message: String, pub detail: String,
    pub action: Option<ErrorAction>, pub agent_id: Option<String>, pub source_id: Option<String>, pub path: Option<String> }
#[derive(Debug, Clone, Serialize)] #[serde(rename_all = "camelCase")]
pub(crate) struct ErrorAction { pub kind: String, pub payload: BTreeMap<String, String> }
impl From<String> for SkillHubError { /* classify_legacy_error(&message): patterns of §4.5, default INTERNAL */ }

#[derive(Clone, Serialize)] #[serde(rename_all = "camelCase")]
pub(crate) struct SkillAgent { id: String, name: String, vendor: String, installed: bool, can_deliver: bool,
    experimental: bool, experimental_reason: String, unsupported_reason: String, takeover: bool,
    status_word: String, health: String, skills_path: String, linked_agent_ids: Vec<String>,
    shared_folder_note: String, after_sync_hint: String, counts: AgentSkillCounts,
    last_result: Option<AgentDeliveryResult>, doctor_verdict: String }
#[derive(Clone, Serialize)] #[serde(rename_all = "camelCase")]
pub(crate) struct AgentSkillCounts { packs_synced: usize, skills_synced: usize, packs_wanted: usize, problems: usize, personal: Option<usize> }
#[derive(Clone, Serialize)] #[serde(rename_all = "camelCase")]
pub(crate) struct DeliveryUnit { unit_id: String, kind: String, source_id: String, skill_id: String,
    entry_name: String, callable_skills: usize, library_enabled: bool, library_only_reason: String }
#[derive(Clone, Serialize)] #[serde(rename_all = "camelCase")]
pub(crate) struct SkillTarget { unit_id: String, agent_id: String, desired: bool, status: String, mode: String,
    entry_name: String, target_path: String, content_hash: String, verified_at: String, updated_at: String,
    error: Option<SkillHubError>, conflict: Option<SkillTargetConflict> }
#[derive(Clone, Serialize)] #[serde(rename_all = "camelCase")]
pub(crate) struct SkillTargetConflict { kind: String, same_content: bool, path: String }
#[derive(Clone, Serialize)] #[serde(rename_all = "camelCase")]
pub(crate) struct DeliveryJobStatus { job_id: u64, phase: String, depth: String, reasons: Vec<String>,
    queued_at: String, started_at: String, finished_at: String, waiting_for: String,
    agents: Vec<AgentDeliveryResult>, changed_targets: Vec<SkillTargetKey>, snapshot_stale: bool,
    error: Option<SkillHubError> }
#[derive(Deserialize)] #[serde(rename_all = "camelCase")]
pub(crate) struct TargetChangeInput { unit_id: String, agent_id: String, enabled: bool }
#[derive(Deserialize)] #[serde(rename_all = "camelCase")]
pub(crate) struct InstallSkillSourceRequest { probe_id: String,
    #[serde(default)] selected_skill_paths: Vec<String>, #[serde(default)] agent_ids: Vec<String>,
    #[serde(default)] security_review_confirmed: bool, #[serde(default)] display_name: Option<String>,
    #[serde(default)] folder_id: Option<String>, #[serde(default)] new_folder_name: Option<String>,
    #[serde(default)] category_id: Option<String>, #[serde(default)] tags: Vec<String>,
    #[serde(default)] note: Option<String> }
// …all remaining §4.3 types the same way.
```

`LegacySnapshot` (lib.rs:91-132) gains `skill_delivery: Option<SkillDeliveryState>`. It is filled by `read_snapshot_from_database_with_runtime` from SQLite only, with no disk read-back, so snapshot loading stays as fast as before.

### 4.5 Error model and banner contract (S1-9)

- **New commands** construct `SkillHubError` directly.
- **Legacy string errors** are classified by both B (`From<String>`) and F (`normalizeSkillHubError`) using the same pattern table, which has more than 10 patterns, as required by S1-9:

| Pattern in legacy message | code | action.kind |
|---|---|---|
| `另一项刷新或写入任务正在运行` | WRITE_BUSY | wait |
| `无法取得数据写入锁` | WRITE_BUSY | wait |
| `GitHub API` / `rate limit` | NETWORK_FAILED | retry |
| `超过 240 秒` / `超过 180 秒` | SCRIPT_TIMEOUT | export-report |
| `超过 120 秒` (download) | DOWNLOAD_TIMEOUT | retry |
| `Source metadata is too long` | INPUT_TOO_LONG | — |
| `Personal Skill` / `Personal or external Skill entry preserved` | TARGET_CONFLICT | resolve-conflict |
| `Recipient Skills root is an external link` | AGENT_DIR_EXTERNAL_LINK | open-folder |
| `完整性核对未通过` / `交付验收失败` | DELIVERY_VERIFY_FAILED | retry |
| `找不到同步脚本` / `找不到 AI 工具链接脚本` | SCRIPT_MISSING | reinstall |
| `Cannot open v2 SQLite database` / `Cannot commit v2 SQLite` | INDEX_FAILED | export-report |
| `导入已取消` | CANCELLED | — |
| `Agent Skill allowlist contains` | DELIVERY_POLICY_INVALID | export-report |
| `name and description` / `没有可读的 SKILL.md` | MANIFEST_INVALID | open-folder |
| `系统 Git` / `git` not found | GIT_MISSING | install-git |
| otherwise | INTERNAL | export-report |

- **Bug #14 (lib.rs:2091).** Replace "请打开“维护工具 → 导出排错包”" with **"请到「设置 → 帮助与诊断 → 生成排错报告」查看详情"**.
- **Banner behaviour (F):**
  - Maximum one banner.
  - It shows `t("err.<CODE>")` or else `message`. `detail` sits inside a `<details>` element.
  - It always has a dismiss button, and the action button appears when `action` is not null.
  - It clears itself on the next successful operation of the same scope (delivery, import, or index).
  - `recordUsage` failures never raise it; bug #6 frontend-shell.
  - `messageFromError` (appShared.ts:302) is replaced by `normalizeSkillHubError(e).message` everywhere, so an object error never renders as `[object Object]`.

### 4.6 Counting rules — `src/skillCounts.ts` (F; pure, **no runtime imports**, only `import type`)

```ts
export type CountScope = {
  /** "all" | "unfiled" | folder id. Membership = skill.userFolderId || owner.userFolderId (as in skyIslandModel). */
  folderId?: string;
  /** Restrict to these unit ids. */
  unitIds?: ReadonlySet<string>;
};
export type SkillCounts = {
  /** Callable skills (技能). */
  skills: number;
  /** Callable skills with skill.enabled && pack library-enabled. */
  enabledSkills: number;
  /** Sources with ≥1 callable skill (技能包). */
  packs: number;
  /** Sources with 0 callable skills and sourceType prompt|mixed (资料). */
  promptPacks: number;
  /** Callable skills with no owning source; each is its own library row. */
  standaloneSkills: number;
  /** packs + promptPacks + standaloneSkills = rows under the 全部 filter. */
  rows: number;
  /** Rows with ≥1 target status "synced" (0 when skillDelivery is absent). */
  syncedRows: number;
  /** Deliverable rows with no synced target. */
  unsyncedRows: number;
  /** Rows whose sourceGovernance.relation === "update-available". */
  updateRows: number;
  /** Rows matching rowFilterState(...).problem. */
  problemRows: number;
};
/** Callable rule: in a pack with exactly 1 indexed skill, that skill is callable even if isRouterHub (fixes bug #40);
 *  in a pack with ≥2 skills, router hubs are excluded; standalone skills are callable unless they are generated routers. */
export function isCallableSkill(skill: SkillCard, skillsInSamePack: number): boolean;
export function callableSkillsOf(source: SourceCard, skills: readonly SkillCard[]): SkillCard[];
export function countSkills(
  snapshot: Pick<LegacySnapshot, "skills" | "sources"> & Partial<Pick<LegacySnapshot, "skillDelivery" | "sourceGovernance">>,
  scope?: CountScope
): SkillCounts;
/** Used by the library filter bar and by countSkills. */
export function rowFilterState(row: {
  unit: DeliveryUnit | null;
  targets: readonly SkillTarget[];
  source: SourceCard | null;
  governance: SourceGovernanceCard | null;
}): { synced: boolean; unsynced: boolean; update: boolean; problem: boolean };
```

`rowFilterState` definitions:

- `synced` = at least one target with `status === "synced"`.
- `unsynced` = the unit is deliverable (`libraryOnlyReason` is not `prompt-only`) and has no synced target.
- `update` = `governance?.relation === "update-available"`.
- `problem` = any of:
  - any target status in `error`, `conflict` or `orphan`
  - `source.health === "error"`
  - `unit.libraryOnlyReason` is `security-review` or `invalid-manifest`
  - `governance.status` indicates a failed check

**Mandatory users of `countSkills()` (I-11):**

- `skyIslandModel.buildSkyIslands` (skyIslandModel.ts:74-80) imports `isCallableSkill`.
- The library header (pages/Library.tsx@d20c3b8:297 replaces App.tsx@7b71c94:3536-3541) uses `countSkills` for "N 个技能 · M 个技能包".
- The 全部 folder chip (App.tsx@7b71c94:4231) and every folder chip use `countSkills(…, {folderId})`.
- Home metrics, sidebar counts and `SkillAgent.counts` must match. B computes `skillsSynced` with the identical rule, mirrored in Rust as `is_callable_skill`.
- `scripts/sky-island-model.test.cjs` gets a `require` shim that transpiles `../src/skillCounts.ts`.

### 4.7 Input parsing rules (B authoritative; F mirrors them in `preview.ts` for browser preview)

| Input (trimmed; surrounding quotes stripped; at most 2048 chars, else INPUT_TOO_LONG) | kind / route | Result |
|---|---|---|
| `owner/repo` (exactly 2 segments, `[A-Za-z0-9_-]+/[A-Za-z0-9_.-]+`) | github | ref "", subpath "" |
| `https://github.com/o/r`, `http://…`, `github.com/o/r`, `.git` suffix, trailing `/` | github | as above |
| `git@github.com:o/r(.git)`, `ssh://git@github.com/o/r` | github | as above (parse_github_repo, lib.rs:13541-13588) |
| `https://github.com/o/r/tree/<ref>/<path…>` | github | `ref` = first segment. Probe resolves ambiguous refs by `git ls-remote` with 1, 2, 3, then 4 joined segments; else GITHUB_REF_NOT_FOUND. `subpath` = the rest. |
| `https://github.com/o/r/tree/<ref>` | github | subpath "" |
| `https://github.com/o/r/blob/<ref>/<path>/SKILL.md` | github | subpath = parent folder of `SKILL.md` |
| `C:\…`, `D:/…`, `\\server\share\…`, `~\…`, `~/…`, `file:///C:/…` | local-folder (must exist and be a directory) or zip (`.zip` / `.skill` file) | PATH_NOT_FOUND / ZIP_INVALID |
| Text that parses as JSON containing `mcpServers`, `servers`, or an object whose values have `command`/`url`; or text containing `[mcp_servers.` | mcp-config, `routeTo: "mcp"` | F opens the MCP add flow with the text |
| `./x`, `x\y`, 3+ bare segments | unknown | `PATH_NOT_ABSOLUTE` ("请粘贴完整路径，或点「选择文件夹」") |
| Other hosts (gitlab, gitee …) | unknown | INPUT_UNRECOGNIZED ("暂时只支持 GitHub 地址、本地文件夹和 .zip") |

**Subpath safety:**

- Percent-decode bytes only. Decoding non-ASCII must never panic (bug #21, sparse_scope.rs:399-404).
- Reject `..`, `.`, empty segments, `\`, and drive letters.
- After cloning, the canonical subpath must stay inside the clone.

**Probe download rules:**

- GitHub reuses the existing staging clone (lib.rs:10043-10160) with `--branch <ref>` when `ref` is set.
- The sparse cone is restricted to `subpath` when one is given.
- A subpath install records `mode: "explicit", skillPaths: [subpath…]` in `skillhub.config.json` `repositories[]`, so updates keep the scope (`ScopePolicy`, sparse_scope.rs:433-466).
- Local and zip inputs reuse the existing local and package staging.
- The security scan runs on the staged tree, as today (lib.rs:9928-9946).

**Duplicate fast path:** when owner/repo (plus subpath) already exist in the library, the probe returns `duplicate.relation = "same"` and `downloadMethod: "index"` without downloading anything, and lists skills from the index.

**Install with a selection:** every valid child is imported. Children not in `selectedSkillPaths` get `skill_overrides.enabled = 0` and are returned in `disabledSkills`. This is reversible from the drawer and fits the existing sparse and update model.

---

## 5. Old → new mapping

### 5.1 Commands (B)

| Existing command (`generate_handler`, lib.rs:19194-19261) | 3.3.0 | Notes |
|---|---|---|
| `set_workspace_enabled` (lib.rs:3448-3452) | **delete** | It is a no-op (bug #15 brief). `workspaces` table data stays, unused. |
| `set_preset_enabled` (3454), `set_preset_workspace_enabled` (4541) | **delete** | Presets were retired (DECISIONS.md:1074). Tables stay for migration compatibility. |
| `set_real_write_authorization` (4553) | **delete** | The consent pill is gone (S0-8). |
| `set_agent_adapter_enabled` (3443) | keep as a **deprecated alias** → `set_agent_takeover` semantics, returns `LegacySnapshot` | Delete the override at lib.rs:15511. `AgentAdapterCard.enabled` = `agent_takeover.enabled`. |
| `set_skill_enabled` (3479, sync) | keep, **make it async**, and implement it through the same path as `set_child_skill_enabled` (enqueue `full`, return `load_indexed_snapshot_blocking()`) | The UI switches to `set_child_skill_enabled` (bugs #2 and #3 brief; #16 rust-core). |
| `connect_detected_agents` (1264) | keep → implemented as `request_skill_delivery("connect","full", Some(true))` plus waiting for the result | The UI uses #9. |
| `ensure_agent_skill_delivery` (1239) | keep → `verify` job, waits for the result, honours I-1 | The UI uses #9 at startup. |
| `preview_source_import_candidate`, `stage_source_import_candidate`, `promote_staged_source_import` | keep (used internally by probe and install; existing tests) | Not called by the new UI. Promote's inline `reconcile_agent_skill_delivery` (lib.rs:5128) becomes an enqueue. |
| `cancel_source_import` | keep | Also cancels probe and adopt. |
| `scan_external_agent_skills`, `read_external_agent_skill` | keep | Fix bug #19: `managed` also uses `shared_skill_catalog::is_managed_entry` (external_skills.rs:222-223). |
| `delete_managed_source` (4336), `regenerate_router_hubs` (19062), `set_skill_conflict_choice` (19079), `set_skill_metadata`, `set_skill_rating`, `set_source_rating`, `set_skill_tags`, `set_source_tags` | keep, **make async** (bug #16 rust-core); delivery-affecting ones enqueue `full` instead of calling reconcile inline | `regenerate_router_hubs` is used only by developer mode (dry run). |
| `save_source_metadata` (1223) | keep; **flipping `enabled` on a flagged source returns `SECURITY_REVIEW_REQUIRED`** (I-5); delivery now enqueued, not inline (lib.rs:3860-3872) | The drawer sends the unchanged `enabled` value. The library gate uses #8. |
| `rollback_source_to_latest_backup`, `refresh_source_version_status`, `set_source_version_pin`, `run_skillhub_sync` | keep; the link step goes through `deliver_and_verify` (read-back plus event); `run_skillhub_sync` waits for the guard (§3.8) | |
| `consolidate_duplicate_sources`, `reanalyze_library_metadata` | keep | They move into the library ⋯ menu. |
| `plan/apply_source_identity_migration` | keep | The panel moves to Settings → 开发者模式. Bug #20 (identity_migration.rs:629-637) and bug #0's backend half (identity_migration.rs:539) are fixed. Automatic rename on upgrade is **not** in this round. |
| everything MCP | unchanged here | See the MCP contract. |

New commands #1-#23 from §4.2 are added to `generate_handler`.

### 5.2 UI (F) — delete, merge, keep

| Existing UI (location) | 3.3.0 |
|---|---|
| Topbar consent pill and "刷新本地索引" label (App.tsx@7b71c94:1968-2004; App.tsx@d20c3b8:1740-1748) | **Delete.** Replaced by the sync indicator (§6.1). |
| Topbar language, theme and GitHub buttons (App.tsx@7b71c94:1951-1961) | Move to Settings → 常规. |
| `⌘ K` kbd that does nothing (App.tsx@7b71c94:1945-1948) | Real Ctrl/⌘+K handler. Show "Ctrl K" on Windows (bug #10). |
| Workspaces nav and page (App.tsx@7b71c94:5721-5878; pages/Workspaces.tsx) | **Delete** the nav item and the page. `?view=workspaces` → `agents`; `?view=sources` → `library` (bug #36). |
| "高级" nav (App.tsx@7b71c94:1921-1930), Advanced page (pages/Advanced.tsx) | Moves to Settings → 开发者模式 (default off; localStorage `ai-skillhub-dev-mode`). |
| Agents page top panels: ExternalSkillsPanel, registry text, CodexPluginDoctorPanel (pages/Agents.tsx@d20c3b8:61-78) | **Move.** External skills → Agent detail → 技能 tab. Plugin doctor → Codex → 诊断 tab. Registry text deleted. |
| Adapter card with 3 status vocabularies (App.tsx@7b71c94:5952, 5971, 6017-6020) | One `statusWord` chip, a takeover switch, one path line, a counts line and ⋯. |
| `agents.connectNow` "连接 Skills" button | "立即同步" → `requestSkillDelivery("user","full",true)`. |
| Library header stats, atlas filter deck, footer tape counts (App.tsx@7b71c94:3536-3541, 3654-3672, 2242-2247) | One filter bar (§6.3). The atlas deck is removed; the footer tape uses `countSkills`. |
| Folder shelf, about 240 px (App.tsx@7b71c94:3639-3652, 4220-4300) | One row of folder chips. |
| Source row controls (App.tsx@7b71c94:3726-3806): copy parent, drag handle, folder `<select>`, parent rating, health badge, enable switch, edit | Row = ☐, name, summary, "N 个技能", ★ parent rating (kept per DECISIONS.md:1097), icon row, ⋯. Drag handle on hover. Folder select and copy go into ⋯. The enable switch goes to drawer → 设置 ("在所有 AI 工具中停用"). Health badge only when there is a problem. |
| Expanded parent `SkillRow` that duplicates the source row (App.tsx@7b71c94:3811-3827) | **Delete.** The row itself is the parent entry. |
| Child row "子 Skill" / "正常" chips and duplicate tags (App.tsx@7b71c94:4358-4374) | Badges only for problems; tags de-duplicated. Stars show on hover. |
| Agent pills, max 3, and per-row "已启用" switch (App.tsx@7b71c94:4375-4384, 4408-4413) | The row-level icon row replaces the pills. The child switch stays (global; it affects the router). |
| "重新读取简介" button and "维护工具" panel incl. RouterHubPanel, duplicate repos, ParentIsolationPanel (App.tsx@7b71c94:3570-3637, 4863-4972) | Library ⋯: 重新识别简介和分类, 修复 (`requestSkillDelivery("repair","full")`), 合并重复副本. RouterHubPanel and ParentIsolationPanel move to developer mode. The getLang ternaries (pages/Library.tsx@d20c3b8:385-387) move into i18n (bug #36). |
| ImportWizard: 13 controls, inline in the library, auto-reopens drafts (App.tsx@7b71c94:4996-5720, 3387; pages/ImportWizard.tsx) | **Replace** with an app-level `ImportSheet` modal (§6.4). Drafts are restored only when the user clicks "恢复上次未完成的添加" (bug #17). The hard-coded footer goes (bug #11). |
| Settings "来源命名统一" panel (pages/Settings.tsx@d20c3b8:372) and the "文件夹 / 标签" concept bar (App.tsx@7b71c94:6480-6483) | Panel → 开发者模式. Concept bar deleted. |
| 15 themes in a flat list (App.tsx@7b71c94:359-375) | 外观: 自动 / 亮 / 暗, plus 首页场景: 群岛 / 星图 / 关闭, plus "更多主题" (collapsed). |
| Nav hint subtitles; icon-only sidebar at every width | Text labels when the window is at least 1200 px wide. Hints are deleted. Tooltips appear on hover only, never stuck on focus (bug #32). |
| `friendlyErrorMessage` (appShared.ts:312-316) | `normalizeSkillHubError` with the §4.5 table. |

i18n (F, i18n.ts, zh/en/ko):

- **Delete** or rewrite the untrue strings: `adv.consentOffHint`, `adv.toastAuthOff`, `dash.alertDailyBody`, `toast.promotedNeedAuth`, `topbar.statusAuthorized`, `topbar.statusUnauthorized`, `topbar.refreshIndex`.
- Fix the stale copy at i18n.ts:1245, 1740, 2081 and 2159 (bug #34).
- Fix the empty states at 1642 and 2033 (bug #35).
- Add the `err.*`, `err.action.*` and `v33.*` keys used in §6.

### 5.3 `preview.ts` mocks (F) — every new flow must work with `pnpm dev` and no Tauri

| Mock (new unless stated) | Behaviour |
|---|---|
| `createPreviewSnapshot()` (**change**) | Adds `skillDelivery`: 9 agents (see below) and units and targets for the 6 fixture sources with mixed statuses. The fixture adds `source-flagged-demo` (`libraryOnlyReason: "security-review"`) and one standalone skill. `operatorConsent` stays but is unused. |
| Preview agents | <ul><li>`claude`: taken-over, ok</li><li>`codex` and `coze`: taken-over and linked, with `sharedFolderNote`</li><li>`workbuddy`: taken-over, one target `error` with AGENT_DIR_EXTERNAL_LINK</li><li>`antigravity`: not-installed, with one `orphan` target</li><li>`cursor`: available, experimental</li><li>`gemini-cli`: available, experimental</li><li>`opencode`: unsupported</li><li>`github-copilot`: not-installed</li></ul> |
| `previewDelivery` simulator (module-level) | Implements the queue semantics: 600 ms debounce, 3 s cap, 800 ms "job", one follow-up batch. Emits `window` CustomEvent `ai-skillhub-preview-delivery` with a `DeliveryJobStatus` detail. Exposes `window.__skillhubPreview = { jobs, clientWrites: Array<{agentId, unitId, action}> }` for Playwright. While paused or pending, no `clientWrites` are appended. |
| `previewGetSkillDeliveryState`, `previewSetSkillTarget`, `previewSetSkillTargetsBatch`, `previewSetAgentTakeover` (enforces the codex/coze link), `previewSetPaused`, `previewSetChildSkillEnabled`, `previewSetSourceLibraryEnabled` (flagged without confirmation → throws SECURITY_REVIEW_REQUIRED) | Return the §4.3 shapes. Statuses go `pending`/`removing` → `synced`/`off` only after the simulated job. |
| `previewOnboardingState`, `previewCompleteOnboarding` | `?onboarding=1` forces `pending`. The existing-skills count comes from the adopt fixture. |
| `previewParseSkillSourceInput` | A TS mirror of §4.7. |
| `previewProbeSkillSource` (replaces `createPreviewSourceImportPlan` / `Execution` for the new UI) | Fixtures, each emitting staged `source-import-progress`-shaped progress via callback: <ul><li>`anthropics/skills`: 3 groups, 17 skills, passed</li><li>`…/tree/main/skills/pdf`: 1 skill</li><li>`example/flagged-skills`: review, 2 findings</li><li>`owner/prompt-pack`: prompt docs only</li><li>`owner/skills-and-mcp`: 2 skills plus `.mcp.json` with servers `context7` and `fetch`</li><li>`C:\Users\me\Downloads\demo.skill.zip`: 1 skill</li><li>an existing fixture URL: `duplicate.relation = "same"`</li><li>`gitlab.com/x/y`: INPUT_UNRECOGNIZED</li></ul> |
| `previewInstallSkillSource` (replaces `createPreviewSourceImportPromotion`, fixing bug #16) | Adds the source and skills to the preview snapshot, creates targets as `pending`, and lets the simulator resolve them. Flagged → `library-only`. |
| `previewAdoptPreview`, `previewAdoptExternalSkills` | 24 candidates: 20 `new`, 2 `duplicate` (same canonical path under claude and codex-legacy), 1 `already-managed`, 1 `name-clash`. Adopt produces one simulated job. |
| `previewListAgentSkills(agentId)` | managed, personal, stale and conflict entries. |
| `previewPickSkillSourcePath` | Returns `C:\Users\me\skills\demo-folder`. |
| `?previewError=<CODE>` | Makes the next mutation reject with that `SkillHubError`, for banner tests. |
| **Remove** | `updatePreviewRealWriteAuthorization`, `updatePreviewPresetDistribution`, the workspace branch of `updatePreviewEnabled`. |

---

## 6. Page-level UI spec (F)

Measurements are taken at a 1440×900 window unless stated. All zh copy is final. en and ko follow §1.

### 6.1 Shell

**Topbar** (left to right):

1. `[🔍 搜索技能、技能包…  Ctrl K]` (`data-testid="global-search-input"`). Ctrl/⌘+K focuses it from any page; Esc clears it.
   - The results panel sits above the scenes: `position: relative`, fixing styles.css:3992 and bug #10 brief.
   - Clicking a result opens that item's **detail drawer** without changing the tree's expansion (I-6). The duplicated library list is removed (bug #38).
2. `[+ 添加]` (`add-button`). It opens the ImportSheet. Ctrl+V while focus is not in an input calls `classifyAddInput(text)`: `mcp-config` → MCP add (MCP contract), otherwise the ImportSheet with the text pre-filled.
3. `[更新 3]`. The count is the packs with `relation === "update-available"`. It calls the existing `run_skillhub_sync` and keeps the existing operation banner. It is disabled while an import is staging or installing (bug #1).
4. **Sync indicator** (`sync-indicator`, with `data-tone`). This is a pure function `topSyncIndicator(state)` in `src/deliveryView.ts`:

| tone | dot | zh label | when |
|---|---|---|---|
| `busy` | blue spinner | 正在同步… | `job.phase` is queued, waiting or running (tooltip shows `waitingFor` when set) |
| `paused` | amber | 已暂停同步 | `paused` |
| `idle` | grey ring | 还没有接管 AI 工具 | `onboarding === "pending"` or no agent has takeover |
| `problem` | red | {n} 个问题 | `problems.length > 0` |
| `ok` | green | 已同步到 {n} 个 AI 工具 | otherwise; n = taken-over and installed agents |

Clicking the indicator opens a **问题** popover that lists `problems`, each with its action button. This also fixes bug #12 brief, the "健康问题" metric that pointed at an empty page.

**Sidebar** (labels shown at ≥1200 px, icons only below):

- `+ 添加`
- 首页
- 技能 `(3)` (packs with updates)
- MCP
- AI 工具, with one sub-item per **taken-over** agent: `Claude Code  42 ●`
  - The number is `counts.skillsSynced`.
  - The dot is green (ok), blue (busy), red (problem) or a grey ring (off).
- `+ 发现 1 个新工具` when any agent is `available`
- separator
- 设置

The global `setLoading(true)` is no longer used by any delivery or target action (I-4, S0-5). `mutationBusy` (App.tsx@d20c3b8:245) also includes `importInFlight` (bug #1).

### 6.2 Home

1. One row of four clickable metrics:
   - AI 工具 已接管 {taken}/{installedDeliverable} → AI 工具
   - 技能 {countSkills().skills} (有更新 {updateRows}) → 技能
   - MCP {n} → MCP (count from the MCP contract)
   - 问题 {n} → 问题 popover
2. A card:
   - when `onboarding === "pending"`: the **first-run** card "发现 {n} 个 AI 工具 · 开始接管" → Onboarding;
   - otherwise, when an agent is `available`: "发现 Cursor · [接管]", dismissible per agent (localStorage).
3. The "添加" input. It opens the ImportSheet with the typed text (S0-1: one click, input focused).
4. The islands or star map, as before. The island title count uses `countSkills`. The empty-state button points to "+ 添加" (brief §3; bug #35).

### 6.3 技能 (Library)

- **Header:** `技能` · `{skills} 个技能 · {packs} 个技能包` · `[⋯]` (重新识别简介和分类 · 修复 · 合并重复副本 · 打开技能库文件夹).
- **Filter bar** (`library-filter-<key>`): `全部 {rows}` · `已同步 {syncedRows}` · `未同步 {unsyncedRows}` · `有更新 {updateRows}` · `有问题 {problemRows}`, using `rowFilterState`. This replaces the hidden source-type filter, fixing bug #5.
- **Folder chips row:** `全部` · `未归档` · each folder (colour dot and count) · `+ 新建`. Chips are drop targets for pointer drags (§3.9). The `全部` count equals `rows` (bug #13 brief, #40).
- **Row** (`library-row-<unitId>`, height ≤ 64 px):
  `☐ | [avatar] 名称 (owner small) | 一行简介 | {n} 个技能 | ★4 | [icon row] | ⋯`
  - A prompt pack shows the chip `资料` instead of "N 个技能" and has no icon row.
  - The chevron expands child rows. Collapsed is the default (I-6).
  - Child row: name · summary · copy name · child switch (`setChildSkillEnabled`) · stars on hover. It shows a spinner only on itself while the switch is pending.
  - **Icon row** (`target-icon-<unitId>-<agentId>`, with `data-status`). One icon per target in `skillDelivery.targets` for this unit, at most 6 plus `+N`. The codex and coze icons render adjacent with a link glyph.

| status | icon look | tooltip (zh) | click |
|---|---|---|---|
| synced | solid | 已同步到 {tool} · 点击移除 | `setSkillTarget(u,a,false)` |
| off | dimmed (opacity .45) | 未同步到 {tool} · 点击同步 | `setSkillTarget(u,a,true)` |
| pending / removing | spinner | 正在同步到 {tool}… / 正在从 {tool} 移除… | disabled |
| paused | dimmed + pause badge | 已暂停同步 · 恢复后会同步到 {tool} | opens Settings → 同步 |
| orphan | amber ring | {tool} 已不在这台电脑上，但入口还在 · 点击移除 | `setSkillTarget(u,a,false)` |
| conflict | red dot | {tool} 里已有同名的个人技能，没有覆盖 (sameContent: 内容相同，正在使用你的版本) | opens drawer → 概览 → 冲突说明 with [打开文件夹] |
| error | red dot | 同步到 {tool} 失败：{message} · 点击重试 | `requestSkillDelivery("retry","links")` |
| blocked | ⊘ | 这个技能包仅在技能库（已停用） / 没有启用的技能 | `security-review` → "查看风险并启用" dialog |

  A failed child switch reverts the switch and toasts "没能保存 · 重试". A failed delivery leaves the switch on and shows the row error with **重试** (S0-5 acceptance).

  The `updateSkillEnabled` successor returns `false` on catch (bug #3 brief, App.tsx@d20c3b8:677).

- **Selection bar** (when ≥1 row is checked):
  - `同步到… ▾` lists the taken-over agents with "已同步 x/N", and applies `setSkillTargetsBatch` only to rows missing that agent. The label states the real count: "同步 7 项".
  - `从… 移除 ▾` works the same way.
  - Selection covers only the current filter results. Shift-click selects a range; Esc clears the selection.
- **Detail drawer** (opens from a row or a search result; it takes focus, Esc closes it, and focus returns afterwards; bug #7):
  - **概览:**
    - `readLibrarySkillDocument` preview of SKILL.md (any `[ROUTER-HUB]` text stripped for display; bug #18 brief), plus the file list.
    - The included skills with their switches.
    - "同步到": one labelled switch per taken-over agent, the same targets as the icon row.
    - The conflict explanation, if any.
  - **版本:** existing governance (更新 / 不再自动更新 / 回到上一版) through the existing commands.
  - **设置:** 名称, 分类 (localized name, never a raw id; bug #18 brief), 标签, ★ 评分, 备注, 文件夹, "在所有 AI 工具中停用这个技能包" (`setSourceLibraryEnabled`), and 删除 (confirm).
    - These save on **保存**.
    - Closing with unsaved changes asks "放弃修改？" (bug #31).
    - A metadata save that writes tags separately must report a partial failure (bug #13 frontend-shell).
- **"查看风险并启用" dialog:** lists the probe-style findings from the stored `source_security_state` (scan status, counts) with the copy "这些内容不会被执行。确认后，这个技能包会同步到已接管的 AI 工具。" → `setSourceLibraryEnabled(id,true,true)`.

### 6.4 ImportSheet (+ 添加) — S0-1, S0-2

The sheet is a modal at app level (`import-sheet`), opened from the topbar, the sidebar, the home page, a drop event or Ctrl+V. The input gets focus when it opens.

1. **First view: at most 3 controls besides the sheet's close button.**
   - Input `import-input`, placeholder "粘贴 GitHub 地址、owner/repo、本地文件夹或 .zip"
   - `[选择文件夹]` → `pickSkillSourcePath("folder")`
   - `[选择 .zip]` → `pickSkillSourcePath("zip")`

   Below them, a muted line: "也可以把文件夹或 .zip 拖进窗口".
2. **Auto-check:**
   - `parseSkillSourceInput` runs on every change, debounced 300 ms.
   - If the result routes to `mcp`, the sheet shows "这是一段 MCP 配置 · [去添加 MCP]".
   - For a valid input, `probeSkillSource` starts automatically: 600 ms after typing stops for GitHub input, immediately for local paths and drops. Enter starts it at once.
   - A new input cancels the previous probe (`cancel_source_import`).
   - Progress line: 正在识别地址 → 正在下载… → 正在检查安全… → 正在列出技能….
3. **Preview** (`import-preview`):
   - **Header:** displayName, owner, "{n} 个技能", and a GitHub/local badge. A duplicate shows "已在技能库中 · [打开]"; the primary button then becomes "同步到 {n} 个 AI 工具" and only sets targets.
   - **Tabs** (shown only when relevant): `技能 ({n})` · `MCP ({m})` · `资料 ({k})`.
     - **技能:** groups (`import-skill-group`) with a tri-state group checkbox and child checkboxes, all checked. Invalid skills are greyed with the reason. Skills already in the library show "已在技能库".
     - **MCP:** server names, plus `[添加这些 MCP]` → `readSkillSourceProbeFile` → the MCP add flow (MCP contract). It never auto-runs anything.
     - **资料:** prompt docs (titles only).
   - **Safety card** (`import-security-card`):
     - `passed`: green "安全检查通过（检查了 {n} 个文件）"
     - `review`: amber "安装前需要你确认：发现 {n} 处需要注意". It lists up to 8 findings (`relativePath:line` · plain summary), says "这些内容不会被执行", and ends with "这个技能包会先保持停用，只加入技能库。"
     - `blocked`: red "无法安装：{plainSummary}"
   - **Agent chips:** "安装到：" followed by the chips `import-agent-chip-<id>`. They are preselected per probe. Experimental chips carry an "实验性" tag. When `canSyncToAgents` is false, every chip is disabled with "需要先查看风险".
   - **"更多选项" (collapsed):** 名称 · 文件夹 (incl. 新建) · 分类 (auto-inferred, editable) · 标签 · 备注.
   - **Primary button** (`import-submit`):

| condition | label |
|---|---|
| passed, n chips selected > 0 | 安装到 {n} 个 AI 工具 |
| passed, 0 chips | 加入技能库 |
| review | 仅加入技能库（保持停用） (sends `securityReviewConfirmed: true`, `agentIds: []`) |
| blocked | disabled: 无法安装 |
| prompt-only | 加入资料库 |
| no taken-over agents | 加入技能库, plus the hint "还没有接管 AI 工具 · [去接管]" |

4. **After install:**
   - The sheet shows "已加入技能库 · 正在同步到 {n} 个 AI 工具" with [查看] (opens the row's drawer) and [继续添加]. It closes by itself after 4 s if untouched.
   - The row's icons spin until the job finishes (I-3).
   - A `library-only` outcome shows "已加入技能库并保持停用 · 可在这一行「查看风险并启用」".
5. **Cancel:** the sheet's close button or Esc → `discardSkillSourceProbe` and `cancel_source_import`.

### 6.5 AI 工具 (Agents) — S0-3, S0-10

The page header is `AI 工具` · `[检测 AI 工具]` (`refresh_agent_detection`) · `[立即同步]`.

**List of cards** (`agent-card-<id>`). In a 900 px tall window the first card's top is under 200 px (S0-10):

```
[icon] Claude Code        已接管 ▢━●   (switch: agent-takeover-claude, role=switch aria-checked)
       技能 42 · MCP 5                         ⋯ (打开目录 · 诊断 · 移除残留入口)
       ~\.claude\skills
       新开一个 Claude Code 会话后生效            ← afterSyncHint, only after a job touched this tool
```

- The `statusWord` chip: 已接管 (green) / 可接管 (blue) / 不支持 (grey) / 未安装 (grey).
- The switch is enabled only for `canDeliver && installed`. Turning it **off** asks "停止管理 {tool} 里的技能？SkillHub 只会删除它自己建的入口，你自己的技能不会动。"
- **Linked switch:** on codex and coze it shows the link glyph and `sharedFolderNote`. Toggling one shows both flip (the backend returns both in `TakeoverResult.agents`).
- `experimental` shows the chip 实验性 with `experimentalReason`.
- `health === "problem"` shows a red line with the first problem and its action.
- The collapsed group "其他支持的工具（{n}）" holds the `unsupported` and `not-installed` agents, each with its reason.
- "+ 自定义工具" is **not shown** in 3.3.0 (S1-6 is P1).

**Agent detail** (route `agents/<id>`, opened from a card or a sidebar sub-item), with tabs:

- **技能:** `listAgentSkills(id)`, grouped as
  - 由 SkillHub 管理 ({n}),
  - 你自己的 ({m}), each with `[纳入管理]`, plus `[全部纳入管理 ({m})]` → `previewAdoptExternalSkills` → confirm sheet → `adoptExternalSkills`,
  - 有问题 ({k}): stale and conflict, with [打开文件夹].

  This replaces ExternalSkillsPanel's one-at-a-time import (ExternalSkillsPanel.tsx:122, S0-11).
- **MCP:** that tool's column of the MCP matrix (MCP contract component). In the Skills scope it is a placeholder link to MCP.
- **诊断:** the existing doctor card data (verdict, evidence, next steps) and, for `codex`, `CodexPluginDoctorPanel`.

**Adopt confirm sheet:**

- Header: "纳入 {n} 个技能".
- List: name · from {tools} · state chip.
  - Duplicates are collapsed: "{x} 个重复已合并".
  - Already managed: "已在技能库".
  - Name clash: unchecked, "技能库里已有同名但内容不同的技能".
- Footer note: "会复制到技能库，原文件夹保持不变。每一个都会先做安全检查。"
- Primary: `[纳入 {n} 个]`.
- Result: "已纳入 {a} 个 · {b} 个保持停用（需要查看风险） · {c} 个失败", with a row-level list. Exactly **one** library refresh happens afterwards.

### 6.6 Onboarding (S1-8)

The full page `onboarding-screen` appears when `skillDelivery.onboarding === "pending"`, in place of the home page. It does not show for existing users (§2.3 step 4).

```
发现 {n} 个 AI 工具
SkillHub 会把你的技能同步到下面勾选的工具。没点「接管」之前，不会改动任何工具的文件夹。

☑ Claude Code          ~\.claude\skills
☑ Codex   ⛓ 与 扣子 共用目录
☐ Cursor  实验性
▢ OpenCode             还不支持同步技能（灰）

☑ 纳入它们已有的 37 个技能（已去重，原文件夹不动）
☑ 导入它们已有的 5 个 MCP（只读进来，不回写）        ← MCP contract command; hidden if MCP returns 0

[接管 {k} 个工具]        暂不接管
```

- **Primary** (`onboarding-submit`) → `completeOnboarding(agentIds, adoptChecked)`, then the MCP import command if that box is checked, then the home page with the progress shown in the sync indicator.
- **暂不接管** → `completeOnboarding([], false)`. Status becomes `completed` with no tools taken over. The home page then shows "发现 {n} 个 AI 工具 · 接管".

### 6.7 设置 (Settings)

Sections, in order:

1. **常规:** 语言 · 外观 (自动 / 亮 / 暗) · 首页场景 (群岛 / 星图 / 关闭) · 更多主题 (collapsed) · 文字和图标大小.
2. **技能库位置:** path, with [打开] (existing data from pages/Settings.tsx@d20c3b8:486).
3. **同步:** a switch "暂停同步到 AI 工具" (`setSkillDeliveryPaused`) with the pause sentence from §3.6.
4. **更新:** the app update (existing) and the Git runtime (existing).
5. **历史与备份:** source backups and versions (existing). MCP snapshots belong to the MCP contract.
6. **帮助与诊断:**
   - [生成排错报告] → `exportTroubleshootingReport` → open the folder.
   - Logs location.
   - **使用统计** disclosure and switch. The third-party analytics script in `index.html:8-13` moves to a runtime loader in `main.tsx` that loads only when the switch is on; the default is an open decision, see §9.
7. **开发者模式** (switch, default off). It reveals the former Advanced page (发布检查), 来源命名统一 (SourceIdentityPanel, with bug #0 fixed), the router preview and the parent-isolation panel.

---

## 7. Bug assignment (all confirmed Skills, shell and rust-core bugs)

`bugs.json` confirmed[] index → owner. Line numbers refer to `@7b71c94`.

| bugs.json # | Title (short) | Owner | Fix reference |
|---|---|---|---|
| 0 | SourceIdentityPanel confirm with 0 selected renames all | F + B (identity_migration.rs:539) | as in bugs.json; the panel moves to dev mode |
| 1 | Topbar Sync enabled during import staging | F (importInFlight) + B (waiting guard §3.8) | |
| 2 | Library search count wrong | F | the count is derived from rendered rows via `countSkills` |
| 3 | Language change leaves constellation legend stale | F | `lang` in useMemo deps |
| 4 | Activity timeline raw event ids | F | `audit.*` i18n keys |
| 5 | Hidden source-type filter persists | F | the filter bar replaces it |
| 6 | Error banner not dismissible | F | §4.5 banner |
| 7 | Drawers ignore focus and Esc | F | §6.3 drawer |
| 8 | Direct search hits dimmed | F | as in bugs.json |
| 9 | Busy labels name the wrong action | F | per-action busy states |
| 10 | ⌘K hint without a handler | F | §6.1 |
| 11 | Import footer hard-coded English | F | removed with the ImportSheet |
| 12 | CountUp restarts from a stale origin | F | effects.tsx |
| 13 | Metadata save partial persist | F (+ B optional single command) | |
| 14 | `move_directory` deletes the source after a non-cross-volume rename error | B | lib.rs:11945 |
| 15 | Shared catalog strict description blocks all delivery | B | shared_skill_catalog.rs:438-441, §3.3 rule 6 |
| 16 | Heavy reconcile in sync commands freezes the window | B | §5.1 async; queue §3.5 |
| 17 | Unresolvable Git HEAD aborts full sync | B | source_governance.rs:821, 846 |
| 18 | Disabled child still reachable through the parent | B | §3.7 |
| 19 | Coze shared entries shown as external | B | external_skills.rs:222-223 |
| 20 | Identity rollback leaves keys remapped | B | identity_migration.rs:629-637 |
| 21 | `percent_decode` panics on non-ASCII | B | sparse_scope.rs:399-404 |
| 22 | Backup prune prefix match deletes other sources' backups | B | lib.rs:11997 |
| 40 | Island and folder counts leave out single-skill repos | F | §4.6 |
| 23-35 | MCP | — | MCP contract |
| 36-39, 41-49 | sky/visual | — | visual workstream (not in this contract) |

Brief §7 (Skills, shell and cross-cutting) → owner:

| brief §7 # | Owner |
|---|---|
| 1 (consent pill, startup writes) | B: I-1 and §3.6. F: §5.2. |
| 2, 3 (full rebuild per toggle; `return true` in catch) | B: §3.5. F: §6.3. |
| 9, 17 (home "添加来源"; draft auto-reopen) | F: §6.4 |
| 10, 11, 38 (search behind the canvas; ⌘K; search opens the page instead of the drawer) | F: §6.1 |
| 12 (health metric with no list) | F: problems popover. B: `problems`. |
| 13 (counts) | F: §4.6 |
| 14 (non-existent "维护工具 → 导出排错包") | B: §4.5 |
| 15 (no-op workspace and adapter switches) | B and F: §5 |
| 16 (preview import always "未写入") | F: §5.3 |
| 18 (`[ROUTER-HUB]` in editable description) | B: strip the marker from `SkillCard.description` on read; `is_router_hub` must not depend on an override description (lib.rs:322, `set_skill_metadata`). F: §6.3. |
| 30, 31, 32, 33, 34, 35, 36, 37, 39 | F (39: B too, §3.9) |
| 25 (telemetry script) | F: §6.7 (default is an open decision) |
| 42 (Codex path on a clean machine) | not in scope; must be checked on a real clean machine before any path change |
| MCP items (4-8, 19-24, 26-29, 40, 41) | MCP contract |

---

## 8. Acceptance tests

### 8.1 Rust (B) — `cargo test`, new tests in `skill_delivery.rs`, `delivery_queue.rs`, `skill_source.rs`, plus `lib.rs` tests

1. `v33_migration_existing_user_takes_over_tools_with_entries`. Fixture: temp home with `.claude/skills/x`, a junction into active; `.agents/skills` with managed manifests (Coze real-shared); `.workbuddy/skills` with only personal folders.
   - Takeover is on for claude, codex and coze, and off for workbuddy, cursor and gemini-cli.
   - Targets exist for every enabled source × {claude, codex, coze}. Disabled sources have no rows.
   - `onboarding_status = completed`.
   - Running it a second time is a no-op.
2. `v33_migration_fresh_install_is_pending_and_writes_nothing`. Fresh DB and an empty temp home. `onboarding = pending`, no takeover on, no targets. A sha256 tree hash of the home before and after `ensure_agent_skill_delivery_blocking`, `run_skillhub_sync_blocking` (with a stub script) and a `full` job must be identical, including that no folder was created (I-1).
3. `paused_blocks_every_client_write`. Same as 2, with an existing user and `paused = 1`. Also check that `skills-catalog` is untouched and no fingerprint is written. After unpause the job runs `full`.
4. `derive_agent_adapters_reports_takeover_not_detection`. After `persist_agent_detection_refresh`, `AgentAdapterCard.enabled == agent_takeover.enabled` (the lib.rs:15511 override is removed).
5. `per_agent_plan_is_subset_of_union`. The union equals the 3.2.18 allowlist for the same fixture. Taking over everything gives `names == union` for each agent. An agent with a row off excludes that entry. A single-skill pack maps to the child folder, a multi-skill pack to its router, and a standalone skill to its folder.
6. `codex_and_coze_are_one_group_in_shared_mode`. `set_agent_takeover("coze", false)` turns off both. `set_skill_target(u,"codex",false)` writes both rows. Without shared mode they are independent.
7. `takeover_off_releases_only_skillhub_entries`. A WorkBuddy fixture with 3 SkillHub junctions, 1 personal folder and 1 external junction. After release, only the 3 junctions are gone. Claude and Codex dirs are byte-identical. After a restart (migration plus verify) nothing is re-added.
8. `targets_file_roundtrip_and_validation`. Serialization matches §3.3. A name outside the union → `DELIVERY_POLICY_INVALID` before any write.
9. `delivery_queue_coalesces`. With an injected clock: 5 requests within 2 s → 1 batch. Requests during a running batch → exactly one follow-up. A steady stream → a batch at 3 s. Depth is the max. `jobId` increases monotonically.
10. `readback_status_matrix`. Fixtures for synced, off, pending, removing, conflict (personal folder, external link, file; `sameContent` true and false), orphan (agent uninstalled), error (missing manifest), blocked (library-only), paused.
11. `parse_skill_source_input_table`. Every row of §4.7, plus a percent-encoded non-ASCII subpath (no panic), `..` rejected, a 2049-char input → INPUT_TOO_LONG, and JSON/TOML → `routeTo mcp`.
12. `install_flagged_source_is_library_only`. A review fixture with `agentIds` = all → outcome `library-only`, source disabled, zero targets, nothing delivered. Without `securityReviewConfirmed` → `SECURITY_REVIEW_REQUIRED`. A structural block → `SECURITY_BLOCKED` with no source created.
13. `install_selection_disables_unselected_children` and `subpath_install_records_explicit_scope`.
14. `set_source_library_enabled_requires_review_for_flagged`. The same applies to `save_source_metadata` flipping `enabled`.
15. `adopt_dedupes_by_canonical_path_and_hash`. Two locations of one physical dir → 1 candidate. Same name and hash as a managed skill → `already-managed`. Coze managed entries are not listed (bug #19). Adopting 20 runs 20 scans and exactly 1 index rebuild and 1 delivery job. Originals are byte-identical afterwards.
16. `fingerprint_changes_with_targets_takeover_pause`.
17. `identity_migration_remaps_agent_skill_targets`.
18. `shared_catalog_lenient_description_and_conflict_skip` (bug #15, §3.3 rule 6).
19. `run_skillhub_script_error_points_to_real_report_path` (bug #14 brief; no "维护工具").
20. Regression tests for rust-core bugs 14, 17, 18, 20, 21 and 22, as described in `bugs.json`.
21. `error_classifier_table`. Every row of §4.5 maps to its code.

PowerShell 5.1 (B): add `scripts/test-agent-skill-targets.ps1`, run with `powershell.exe` 5.1 like `test-workbuddy-skill-delivery.ps1`.

- (a) Targets mode delivers per-recipient names only.
- (b) `release` removes only managed reparse points.
- (c) A same-name personal folder is reported as `conflict` and neither moved nor deleted, and no `AI_global接管前备份_*` folder is created.
- (d) A union with zero intersection exits non-zero before any recipient changes.
- (e) Cursor and Gemini without presence → `skipped-not-installed` and no folder created; with the simulated presence switches → linked and verified.
- (f) One failing recipient (an external-link root) → the others are still delivered and the script exits 0 with the report.
- (g) Without `AI_SKILLHUB_AGENT_SKILL_TARGETS` the output equals the 3.2.18 behaviour, and the existing `test-codex-skill-delivery.ps1`, `test-shared-skill-delivery.ps1` and `test-workbuddy-skill-delivery.ps1` still pass.

### 8.2 Node contract tests (F, plus B for lib.rs assertions) — `scripts/v3.3-skills-contract.test.mjs`

1. `types.ts` contains every type name from §4.3, and `LegacySnapshot` has `skillDelivery?: SkillDeliveryState`.
2. `src/skillApi.ts` calls `invoke("<name>", …)` with exactly the §4.2 command names and argument keys. Every one is present in lib.rs `generate_handler!`.
3. lib.rs `generate_handler!` has no `set_real_write_authorization`, `set_workspace_enabled`, `set_preset_enabled` or `set_preset_workspace_enabled`. `src/**` has no `set_real_write_authorization`, `topbar.statusUnauthorized`, `<Workspaces` or `"workspaces"` nav key.
4. None of the new command fns in lib.rs is a sync `fn` with IO: each listed name is declared `async fn`, except `parse_skill_source_input`.
5. lib.rs `run_agent_link_script` starts with the `delivery_writes_blocked` check, and `Manage-AgentSkillLinks.ps1` reads `AI_SKILLHUB_AGENT_SKILL_TARGETS` and contains `ConflictPolicy`.
6. `capabilities/default.json` contains no `"dialog:` permission (DECISIONS.md:969). If `tauri.conf.json` has `dragDropEnabled: true`, then `src/pages/Library.tsx` contains no `draggable=` and no `dataTransfer.setData` for internal moves.
7. The zh values in `i18n.ts`, outside the `dev.*` / `adv.*` namespaces, contain none of the banned words in §1.
8. App code no longer has `return true` in the catch of the child-skill toggle wrapper, and no delivery-related wrapper calls `setLoading(true)`.
9. `scripts/skill-counts.test.cjs` (transpile `src/skillCounts.ts` as `sky-island-model.test.cjs` does): a single-skill pack counts 1; a multi-skill pack excludes its router; standalone skills count; `rows = packs + promptPacks + standaloneSkills`; a folder scope works; `rowFilterState` matches the truth table in §4.6.
10. `src/deliveryView.ts`: `topSyncIndicator` covers the 5 tones in priority order busy > paused > idle > problem > ok; the target icon mapping covers all 11 statuses.
11. `normalizeSkillHubError` handles a string (every §4.5 pattern), an Error, a `SkillHubError` object and `undefined`, never returning "[object Object]".

### 8.3 Browser preview Playwright (F) — `scripts/v3.3-skills-preview-qa.cjs` against `pnpm dev`

Use a 1440×900 window unless stated.

1. **S0-1.** From the home page, one click on `add-button` (and separately on the home "添加" input) gives `.import-sheet` count 1 and `document.activeElement` = `import-input`.
2. **S0-2.**
   - Before typing, the sheet has at most 3 enabled controls besides close.
   - `anthropics/skills` shows ≥2 `import-skill-group`, the chips preselected = taken-over non-experimental agents, and the submit text matches `/^安装到 \d+ 个 AI 工具$/`.
   - `…/tree/main/skills/pdf` shows exactly 1 skill.
   - `example/flagged-skills` shows the submit text "仅加入技能库（保持停用）" with all chips disabled. After submit the new row has every `target-icon-*` with `data-status="blocked"`.
   - Typing `{"mcpServers":{}}` shows the MCP hand-off.
3. **S0-4 / I-3.** Click `target-icon-<unit>-cursor` (status off) → `data-status` becomes `pending` → `synced` within 3 s. No other icon changes `data-status`.
4. **S0-5.** Toggle 5 child switches within 2 s → `window.__skillhubPreview.jobs` grows by exactly 1. During the job the Agents page can be opened and clicked (no global overlay or `disabled` on nav).
5. **S0-3 / S0-10.**
   - On Agents at 1440×900 and 1280×900, `agent-card-*`[0] top < 200.
   - Toggle `agent-takeover-coze` → both codex and coze switches flip, and codex shows "与 扣子 共用目录".
   - Turning workbuddy off shows the confirm dialog text with "只会删除它自己建的入口".
6. **Pause.** Settings → 同步 → pause → `sync-indicator[data-tone=paused]`. Clicking an off icon → `data-status="paused"`. `__skillhubPreview.clientWrites` length unchanged.
7. **S1-8.** `?onboarding=1` shows `onboarding-screen`. `clientWrites` stays empty until `onboarding-submit`. The button text is "接管 N 个工具", where N = the checked rows.
8. **S0-11.** Agent detail claude → 技能 → "全部纳入管理 (20)" → confirm → the report shows 20 adopted. `jobs` grows by exactly 1.
9. **S0-9.** Ctrl+K focuses `global-search-input` on every nav page. On the home page, `document.elementFromPoint` at the centre of the first result returns an element inside `global-search-results`. Clicking a result opens the drawer and the expanded tree set is unchanged.
10. **S0-7.** `data-count` is equal on the home skills metric, the library header, the 全部 folder chip and the island title, using the preview fixture that includes a single-skill pack.
11. **S1-9.** `?previewError=TARGET_CONFLICT`, then click an icon → `error-banner` with `error-banner-action`. Dismiss hides it.
12. **S1-10.** On every page in zh, `document.body.innerText` contains none of the banned words in §1 (developer mode off).
13. **S0-8.** No `.status-pill` consent text, no workspace nav, no "高级" nav item. The problems popover lists the workbuddy error with an action.
14. **Narrow and wide.** At 1920 px the sidebar shows text labels. At 1100 px it shows icons, and no tooltip remains visible after keyboard focus moves away.

---

## 9. Risks and open decisions (to record in DECISIONS.md, which the orchestrator writes)

1. **`dragDropEnabled: true`** disables HTML5 drag and drop on Windows. F must convert the internal moves to pointer drags in the same release. Fallback if that slips: keep `false` and ship only [选择文件夹] / [选择 .zip], with a "拖入暂不可用" hint.
2. **Never moving personal folders** (I-2) changes 3.2.18 behaviour, where a same-name personal folder was moved to `AI_global接管前备份_*` and replaced. Users who relied on that will now see `conflict` with [打开文件夹]. This is intentional and matches brief §6.4.
3. **Cursor and Gemini CLI** are experimental. Whether those hosts actually invoke skills from these folders, and whether they follow junctions, has not been verified on a real machine. They are off by default and labelled.
4. **Codex path** (brief §7 #42) is unchanged. A clean-machine test is still needed before any change.
5. **Unselected children are imported but disabled** rather than left out. This is reversible and simpler. The cost is disk space for large monorepos; a `/tree/` subpath avoids it.
6. **The telemetry default** (on, as today, or off) is the user's decision. This contract requires only disclosure, a switch and no loading while it is off.
7. **Decision text the orchestrator should add:**
   - per-tool targets and takeover, with the backend-enforced pause and onboarding rule (I-1);
   - the debounced asynchronous queue, still on the PowerShell 5.1 engine;
   - per-agent results that no longer fail all-or-nothing for Skills;
   - folder picking through the Rust-only dialog plugin;
   - the identity panel moved to developer mode, with no automatic rename.

   The two blocked items (non-blocking security scan; changing the default child expansion) remain **unchanged** (DECISIONS.md:149).
