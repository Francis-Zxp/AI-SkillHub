//! v3.3 Skills delivery: per pack x AI tool targets, per-tool takeover, the
//! backend-enforced pause and the onboarding gate (skills contract §2-§4).
//!
//! User intent lives in `agent_skill_targets` and `agent_takeover`, two tables
//! that the rescan and the detection refresh never rebuild. Disk state is only
//! learned through read-back (I-3). Nothing in this module writes into an AI
//! tool's folder: every client write still goes through
//! `run_agent_link_script` (I-1, I-8), which consults
//! [`delivery_writes_blocked`] before anything else.

use super::{
    active_skills_dir, collect_active_agent_skill_entries, delivery_link_target, external_skills,
    normalize_skill_lookup, private_state_dir, router_hub_skill_name, shared_skill_catalog,
    stable_id, unix_timestamp_string, AgentDeliveryRecipientState, GeneratedAgentSkillDependency,
    ROUTER_HUB_FOLDER, ROUTER_HUB_MARKER,
};
use crate::skillhub_error::SkillHubError;
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

pub(crate) const PREF_PAUSED: &str = "skill_delivery_paused";
pub(crate) const PREF_ONBOARDING: &str = "onboarding_status";
pub(crate) const PREF_ONBOARDING_AT: &str = "onboarding_completed_at";
pub(crate) const PREF_MIGRATION: &str = "v33_delivery_migration";
pub(crate) const PREF_LAST_READBACK: &str = "skill_delivery_last_readback";
pub(crate) const TARGETS_FILE_NAME: &str = "agent-skill-targets.json";
pub(crate) const DELIVERY_REPORT_FILE_NAME: &str = "agent-skill-delivery-report.json";
pub(crate) const STANDALONE_PREFIX: &str = "standalone:";
pub(crate) const MAX_BATCH_CHANGES: usize = 2000;

// ---------------------------------------------------------------------------
// Agent catalog
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy)]
pub(crate) struct AgentSpec {
    pub id: &'static str,
    pub name: &'static str,
    pub vendor: &'static str,
    /// SkillHub has a writer for this tool's skills folder.
    pub deliverable: bool,
    /// Written and read back, but not yet confirmed inside the real host.
    pub experimental: bool,
    pub after_sync_hint: &'static str,
    pub unsupported_reason: &'static str,
}

const UNSUPPORTED: &str = "还不支持同步技能";

pub(crate) const AGENT_SPECS: &[AgentSpec] = &[
    AgentSpec {
        id: "claude",
        name: "Claude Code",
        vendor: "Anthropic",
        deliverable: true,
        experimental: false,
        after_sync_hint: "新开一个 Claude Code 会话后生效",
        unsupported_reason: "",
    },
    AgentSpec {
        id: "codex",
        name: "Codex",
        vendor: "OpenAI",
        deliverable: true,
        experimental: false,
        after_sync_hint: "重新打开 Codex 后生效",
        unsupported_reason: "",
    },
    AgentSpec {
        id: "coze",
        name: "扣子",
        vendor: "ByteDance",
        deliverable: true,
        experimental: false,
        after_sync_hint: "在扣子里重新加载技能后生效",
        unsupported_reason: "",
    },
    AgentSpec {
        id: "antigravity",
        name: "Antigravity",
        vendor: "Google",
        deliverable: true,
        experimental: false,
        after_sync_hint: "重新打开 Antigravity 后生效",
        unsupported_reason: "",
    },
    AgentSpec {
        id: "workbuddy",
        name: "WorkBuddy",
        vendor: "Tencent",
        deliverable: true,
        experimental: false,
        after_sync_hint: "重新打开 WorkBuddy 后生效",
        unsupported_reason: "",
    },
    AgentSpec {
        id: "cursor",
        name: "Cursor",
        vendor: "Anysphere",
        deliverable: true,
        experimental: true,
        after_sync_hint: "重新打开 Cursor 后生效",
        unsupported_reason: "",
    },
    AgentSpec {
        id: "gemini-cli",
        name: "Gemini CLI",
        vendor: "Google",
        deliverable: true,
        experimental: true,
        after_sync_hint: "新开一个 Gemini CLI 会话后生效",
        unsupported_reason: "",
    },
    AgentSpec {
        id: "opencode",
        name: "OpenCode",
        vendor: "OpenCode",
        deliverable: false,
        experimental: false,
        after_sync_hint: "",
        unsupported_reason: UNSUPPORTED,
    },
    AgentSpec {
        id: "github-copilot",
        name: "GitHub Copilot",
        vendor: "GitHub",
        deliverable: false,
        experimental: false,
        after_sync_hint: "",
        unsupported_reason: UNSUPPORTED,
    },
    AgentSpec {
        id: "windsurf",
        name: "Windsurf",
        vendor: "Codeium",
        deliverable: false,
        experimental: false,
        after_sync_hint: "",
        unsupported_reason: UNSUPPORTED,
    },
    AgentSpec {
        id: "kiro",
        name: "Kiro",
        vendor: "Kiro",
        deliverable: false,
        experimental: false,
        after_sync_hint: "",
        unsupported_reason: UNSUPPORTED,
    },
    AgentSpec {
        id: "hermes",
        name: "Hermes",
        vendor: "Hermes",
        deliverable: false,
        experimental: false,
        after_sync_hint: "",
        unsupported_reason: UNSUPPORTED,
    },
    AgentSpec {
        id: "openclaw",
        name: "OpenClaw",
        vendor: "OpenClaw",
        deliverable: false,
        experimental: false,
        after_sync_hint: "",
        unsupported_reason: UNSUPPORTED,
    },
    AgentSpec {
        id: "amp",
        name: "Amp",
        vendor: "Sourcegraph",
        deliverable: false,
        experimental: false,
        after_sync_hint: "",
        unsupported_reason: UNSUPPORTED,
    },
];

/// Agents with a writer, in catalog order.
pub(crate) const DELIVERABLE_AGENTS: &[&str] = &[
    "claude",
    "codex",
    "coze",
    "antigravity",
    "workbuddy",
    "cursor",
    "gemini-cli",
];

pub(crate) fn agent_spec(agent_id: &str) -> Option<&'static AgentSpec> {
    AGENT_SPECS.iter().find(|spec| spec.id == agent_id)
}

pub(crate) fn experimental_reason(spec: &AgentSpec) -> String {
    if spec.experimental {
        format!(
            "SkillHub 能写入并读回，但还没在真实的 {} 里确认能调用",
            spec.name
        )
    } else {
        String::new()
    }
}

/// Codex and Coze share `~/.agents/skills` while Coze's shared mode is active
/// (I-9): their takeover switches and per-pack targets are one group.
pub(crate) fn agent_group(agent_id: &str, real_shared: bool) -> Vec<&'static str> {
    match (agent_id, real_shared) {
        ("codex", true) | ("coze", true) => vec!["codex", "coze"],
        _ => agent_spec(agent_id)
            .map(|spec| vec![spec.id])
            .unwrap_or_default(),
    }
}

pub(crate) fn linked_agent_ids(agent_id: &str, real_shared: bool) -> Vec<String> {
    agent_group(agent_id, real_shared)
        .into_iter()
        .filter(|id| *id != agent_id)
        .map(str::to_string)
        .collect()
}

// ---------------------------------------------------------------------------
// Schema and preferences
// ---------------------------------------------------------------------------

pub(crate) fn ensure_schema(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS agent_skill_targets (
                source_id    TEXT NOT NULL,
                agent_id     TEXT NOT NULL,
                enabled      INTEGER NOT NULL DEFAULT 0,
                origin       TEXT NOT NULL DEFAULT 'user',
                mode         TEXT NOT NULL DEFAULT 'none',
                entry_name   TEXT NOT NULL DEFAULT '',
                target_path  TEXT NOT NULL DEFAULT '',
                content_hash TEXT NOT NULL DEFAULT '',
                status       TEXT NOT NULL DEFAULT 'pending',
                error_code   TEXT NOT NULL DEFAULT '',
                last_error   TEXT NOT NULL DEFAULT '',
                updated_at   TEXT NOT NULL,
                verified_at  TEXT NOT NULL DEFAULT '',
                PRIMARY KEY (source_id, agent_id)
            );
            CREATE INDEX IF NOT EXISTS idx_agent_skill_targets_agent
                ON agent_skill_targets(agent_id, enabled);
            CREATE TABLE IF NOT EXISTS agent_takeover (
                agent_id           TEXT PRIMARY KEY,
                enabled            INTEGER NOT NULL DEFAULT 0,
                auto_add_new       INTEGER NOT NULL DEFAULT 1,
                origin             TEXT NOT NULL DEFAULT 'user',
                custom_skills_path TEXT NOT NULL DEFAULT '',
                last_outcome       TEXT NOT NULL DEFAULT '',
                last_error_code    TEXT NOT NULL DEFAULT '',
                last_error         TEXT NOT NULL DEFAULT '',
                last_delivered_at  TEXT NOT NULL DEFAULT '',
                updated_at         TEXT NOT NULL
            );",
        )
        .map_err(|error| format!("Cannot ensure v3.3 delivery tables: {error}"))?;
    // A confirmed security review lets a flagged pack become library-enabled
    // (I-5): the scan result itself is never rewritten.
    let has_review_column = connection
        .prepare("PRAGMA table_info(source_security_state)")
        .and_then(|mut statement| {
            let names = statement
                .query_map([], |row| row.get::<_, String>(1))?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(names.iter().any(|name| name == "review_confirmed_at"))
        })
        .map_err(|error| format!("Cannot inspect source security schema: {error}"))?;
    if !has_review_column {
        connection
            .execute(
                "ALTER TABLE source_security_state
                 ADD COLUMN review_confirmed_at TEXT NOT NULL DEFAULT ''",
                [],
            )
            .map_err(|error| format!("Cannot add security review column: {error}"))?;
    }
    Ok(())
}

pub(crate) fn read_pref(connection: &Connection, key: &str) -> Result<Option<String>, String> {
    connection
        .query_row(
            "SELECT value FROM operator_preferences WHERE key = ?1",
            params![key],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("Cannot read preference {key}: {error}"))
}

pub(crate) fn write_pref(connection: &Connection, key: &str, value: &str) -> Result<(), String> {
    connection
        .execute(
            "INSERT INTO operator_preferences (key, value, updated_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            params![key, value, unix_timestamp_string()],
        )
        .map_err(|error| format!("Cannot save preference {key}: {error}"))?;
    Ok(())
}

pub(crate) fn is_paused(connection: &Connection) -> Result<bool, String> {
    Ok(read_pref(connection, PREF_PAUSED)?.as_deref() == Some("1"))
}

/// `pending` until the user finishes (or skips) onboarding. A database that
/// predates the migration reads as `completed` so nothing is gated before the
/// migration has decided.
pub(crate) fn onboarding_status(connection: &Connection) -> Result<&'static str, String> {
    Ok(match read_pref(connection, PREF_ONBOARDING)?.as_deref() {
        Some("pending") => "pending",
        _ => "completed",
    })
}

/// I-1: paused or onboarding pending means no create, delete or modify in any
/// AI tool's skills folder.
pub(crate) fn delivery_writes_blocked(connection: &Connection) -> Result<bool, String> {
    Ok(is_paused(connection)? || onboarding_status(connection)? == "pending")
}

// ---------------------------------------------------------------------------
// Takeover and targets storage
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default)]
pub(crate) struct TakeoverRow {
    pub enabled: bool,
    pub auto_add_new: bool,
    pub last_outcome: String,
    pub last_error_code: String,
    pub last_error: String,
    pub last_delivered_at: String,
    pub updated_at: String,
}

pub(crate) fn read_takeover(
    connection: &Connection,
) -> Result<BTreeMap<String, TakeoverRow>, String> {
    let mut statement = connection
        .prepare(
            "SELECT agent_id, enabled, auto_add_new, last_outcome, last_error_code,
                    last_error, last_delivered_at, updated_at
             FROM agent_takeover",
        )
        .map_err(|error| format!("Cannot prepare takeover query: {error}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                TakeoverRow {
                    enabled: row.get::<_, i64>(1)? != 0,
                    auto_add_new: row.get::<_, i64>(2)? != 0,
                    last_outcome: row.get(3)?,
                    last_error_code: row.get(4)?,
                    last_error: row.get(5)?,
                    last_delivered_at: row.get(6)?,
                    updated_at: row.get(7)?,
                },
            ))
        })
        .map_err(|error| format!("Cannot read takeover state: {error}"))?;
    let mut map = BTreeMap::new();
    for row in rows {
        let (id, value) = row.map_err(|error| format!("Cannot decode takeover row: {error}"))?;
        map.insert(id, value);
    }
    Ok(map)
}

pub(crate) fn takeover_enabled(map: &BTreeMap<String, TakeoverRow>, agent_id: &str) -> bool {
    map.get(agent_id).is_some_and(|row| row.enabled)
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct TargetRow {
    pub unit_id: String,
    pub agent_id: String,
    pub enabled: bool,
    pub origin: String,
    pub mode: String,
    pub entry_name: String,
    pub target_path: String,
    pub content_hash: String,
    pub status: String,
    pub error_code: String,
    pub last_error: String,
    pub updated_at: String,
    pub verified_at: String,
}

pub(crate) fn read_targets(
    connection: &Connection,
) -> Result<BTreeMap<(String, String), TargetRow>, String> {
    let mut statement = connection
        .prepare(
            "SELECT source_id, agent_id, enabled, origin, mode, entry_name, target_path,
                    content_hash, status, error_code, last_error, updated_at, verified_at
             FROM agent_skill_targets",
        )
        .map_err(|error| format!("Cannot prepare target query: {error}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok(TargetRow {
                unit_id: row.get(0)?,
                agent_id: row.get(1)?,
                enabled: row.get::<_, i64>(2)? != 0,
                origin: row.get(3)?,
                mode: row.get(4)?,
                entry_name: row.get(5)?,
                target_path: row.get(6)?,
                content_hash: row.get(7)?,
                status: row.get(8)?,
                error_code: row.get(9)?,
                last_error: row.get(10)?,
                updated_at: row.get(11)?,
                verified_at: row.get(12)?,
            })
        })
        .map_err(|error| format!("Cannot read targets: {error}"))?;
    let mut map = BTreeMap::new();
    for row in rows {
        let row = row.map_err(|error| format!("Cannot decode target row: {error}"))?;
        map.insert((row.unit_id.clone(), row.agent_id.clone()), row);
    }
    Ok(map)
}

/// SQL definition of a library-enabled unit (§3.1) that needs no filesystem
/// access: an enabled pack that is not waiting for a security review and has
/// at least one enabled skill, or an enabled standalone skill.
const LIBRARY_ENABLED_UNITS_SQL: &str = "
    SELECT s.id AS unit_id
    FROM sources s
    LEFT JOIN source_overrides so ON so.source_id = s.id
    LEFT JOIN source_security_state ss ON ss.source_id = s.id
    WHERE COALESCE(so.enabled, s.enabled, 1) = 1
      AND s.name <> 'AI-SkillHub-local-routers'
      AND (ss.scan_status IS NULL OR ss.scan_status NOT IN ('review', 'blocked')
           OR COALESCE(ss.review_confirmed_at, '') <> '')
      AND EXISTS (
        SELECT 1 FROM skills k LEFT JOIN skill_overrides ko ON ko.skill_id = k.id
        WHERE k.source_id = s.id AND COALESCE(ko.enabled, k.enabled, 1) = 1)
    UNION ALL
    SELECT 'standalone:' || k.id AS unit_id
    FROM skills k
    LEFT JOIN skill_overrides ko ON ko.skill_id = k.id
    WHERE (k.source_id IS NULL OR k.source_id = '')
      AND COALESCE(k.is_router_hub, 0) = 0
      AND COALESCE(ko.enabled, k.enabled, 1) = 1";

/// §2.4 default materialization: a library-enabled unit with zero rows gets a
/// desired row for every taken-over tool that auto-adds new packs. Existing
/// rows (including explicit offs) are never touched. Returns rows created.
pub(crate) fn materialize_defaults(connection: &Connection) -> Result<usize, String> {
    // Automatic rows for sources without any skill (Prompt sources, emptied
    // packs) could never be delivered and would stay "pending" forever; the
    // first 3.3.0 migration created such rows. Explicit user rows are kept.
    connection
        .execute(
            "DELETE FROM agent_skill_targets
             WHERE origin IN ('migration', 'default')
               AND source_id NOT LIKE 'standalone:%'
               AND NOT EXISTS (
                 SELECT 1 FROM skills k WHERE k.source_id = agent_skill_targets.source_id)",
            [],
        )
        .map_err(|error| format!("Cannot prune undeliverable targets: {error}"))?;
    let now = unix_timestamp_string();
    let sql = format!(
        "INSERT OR IGNORE INTO agent_skill_targets
            (source_id, agent_id, enabled, origin, status, updated_at)
         SELECT units.unit_id, t.agent_id, 1, 'default', 'pending', ?1
         FROM ({LIBRARY_ENABLED_UNITS_SQL}) AS units
         JOIN agent_takeover t ON t.enabled = 1 AND t.auto_add_new = 1
         WHERE NOT EXISTS (
            SELECT 1 FROM agent_skill_targets x WHERE x.source_id = units.unit_id)"
    );
    connection
        .execute(&sql, params![now])
        .map_err(|error| format!("Cannot materialize default targets: {error}"))
}

/// Fill rows for a tool whose takeover just went from 0 to 1 (§2.4).
fn fill_targets_for_agents(connection: &Connection, agents: &[&str]) -> Result<usize, String> {
    let now = unix_timestamp_string();
    let sql = format!(
        "INSERT OR IGNORE INTO agent_skill_targets
            (source_id, agent_id, enabled, origin, status, updated_at)
         SELECT units.unit_id, ?1, 1, 'default', 'pending', ?2
         FROM ({LIBRARY_ENABLED_UNITS_SQL}) AS units"
    );
    let mut created = 0;
    for agent in agents {
        created += connection
            .execute(&sql, params![agent, now])
            .map_err(|error| format!("Cannot fill targets for {agent}: {error}"))?;
    }
    Ok(created)
}

pub(crate) fn upsert_takeover(
    connection: &Connection,
    agent_id: &str,
    enabled: bool,
    origin: &str,
) -> Result<bool, String> {
    let previous = connection
        .query_row(
            "SELECT enabled FROM agent_takeover WHERE agent_id = ?1",
            params![agent_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|error| format!("Cannot read takeover for {agent_id}: {error}"))?
        .map(|value| value != 0);
    connection
        .execute(
            "INSERT INTO agent_takeover (agent_id, enabled, auto_add_new, origin, updated_at)
             VALUES (?1, ?2, 1, ?3, ?4)
             ON CONFLICT(agent_id) DO UPDATE SET
                enabled = excluded.enabled,
                origin = CASE WHEN agent_takeover.enabled = excluded.enabled
                              THEN agent_takeover.origin ELSE excluded.origin END,
                updated_at = CASE WHEN agent_takeover.enabled = excluded.enabled
                                  THEN agent_takeover.updated_at ELSE excluded.updated_at END",
            params![
                agent_id,
                i64::from(enabled),
                origin,
                unix_timestamp_string()
            ],
        )
        .map_err(|error| format!("Cannot save takeover for {agent_id}: {error}"))?;
    Ok(previous != Some(enabled))
}

/// Writes the desired state of one pair. Returns true when it really changed.
pub(crate) fn upsert_target(
    connection: &Connection,
    unit_id: &str,
    agent_id: &str,
    enabled: bool,
    origin: &str,
) -> Result<bool, String> {
    let previous = connection
        .query_row(
            "SELECT enabled FROM agent_skill_targets WHERE source_id = ?1 AND agent_id = ?2",
            params![unit_id, agent_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|error| format!("Cannot read target: {error}"))?
        .map(|value| value != 0);
    if previous == Some(enabled) {
        return Ok(false);
    }
    connection
        .execute(
            "INSERT INTO agent_skill_targets
                (source_id, agent_id, enabled, origin, status, updated_at)
             VALUES (?1, ?2, ?3, ?4, 'pending', ?5)
             ON CONFLICT(source_id, agent_id) DO UPDATE SET
                enabled = excluded.enabled,
                origin = excluded.origin,
                updated_at = excluded.updated_at",
            params![
                unit_id,
                agent_id,
                i64::from(enabled),
                origin,
                unix_timestamp_string()
            ],
        )
        .map_err(|error| format!("Cannot save target: {error}"))?;
    // A brand-new "off" row is stored (it stops the default materialization
    // from re-adding the pack) but is not a change of desired state: a missing
    // row already meant off, so it alone needs no delivery job.
    Ok(previous.is_some() || enabled)
}

// ---------------------------------------------------------------------------
// One-time migration (§2.3)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct MigrationReport {
    pub ran: bool,
    pub taken_over: Vec<String>,
    pub targets_created: usize,
    pub onboarding: String,
}

/// Which deliverable tools already hold SkillHub entries. Filesystem read only.
pub(crate) fn tools_with_skillhub_entries(
    active_root: &Path,
    recipients: &[AgentDeliveryRecipientState],
) -> BTreeSet<&'static str> {
    let real_shared = recipients
        .iter()
        .any(|recipient| recipient.id == "coze-shared" && recipient.detected);
    let mut found = BTreeSet::new();
    for recipient in recipients {
        let agent = match recipient.id {
            "claude" | "workbuddy" | "antigravity" | "cursor" | "gemini-cli" => recipient.id,
            "codex" | "codex-legacy" => "codex",
            "coze-shared" => "coze",
            _ => continue,
        };
        if folder_has_skillhub_entry(&recipient.path, active_root) {
            found.insert(agent);
        }
    }
    if real_shared && (found.contains("codex") || found.contains("coze")) {
        found.insert("codex");
        found.insert("coze");
    }
    found
}

fn folder_has_skillhub_entry(folder: &Path, active_root: &Path) -> bool {
    let Ok(entries) = fs::read_dir(folder) else {
        return false;
    };
    entries.flatten().take(4096).any(|entry| {
        let path = entry.path();
        if external_skills::is_link(&path) {
            delivery_link_target(&path).is_some_and(|target| path_is_under(&target, active_root))
        } else {
            shared_skill_catalog::is_managed_entry(&path)
        }
    })
}

pub(crate) fn path_is_under(path: &Path, root: &Path) -> bool {
    fn normalized(value: &Path) -> String {
        let raw = value.to_string_lossy().replace('/', "\\");
        let raw = raw
            .strip_prefix("\\\\?\\")
            .or_else(|| raw.strip_prefix("\\??\\"))
            .unwrap_or(&raw)
            .trim_end_matches('\\')
            .to_string();
        if cfg!(windows) {
            raw.to_lowercase()
        } else {
            raw
        }
    }
    let path = normalized(path);
    let root = normalized(root);
    !root.is_empty() && (path == root || path.starts_with(&format!("{root}\\")))
}

/// Idempotent through `v33_delivery_migration`; the SQL part is one IMMEDIATE
/// transaction. `has_entries` is computed by the caller from the filesystem.
pub(crate) fn migrate_v33_delivery_state(
    connection: &mut Connection,
    has_entries: &BTreeSet<&'static str>,
    stored_fingerprint: &str,
) -> Result<MigrationReport, String> {
    if read_pref(connection, PREF_MIGRATION)?.is_some_and(|value| value.starts_with("done:")) {
        return Ok(MigrationReport::default());
    }
    let now = unix_timestamp_string();
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("Cannot start delivery migration: {error}"))?;
    for agent in DELIVERABLE_AGENTS {
        // Cursor and Gemini CLI always start off: experimental, no entries yet.
        let enabled = !matches!(*agent, "cursor" | "gemini-cli") && has_entries.contains(agent);
        transaction
            .execute(
                "INSERT OR IGNORE INTO agent_takeover
                    (agent_id, enabled, auto_add_new, origin, updated_at)
                 VALUES (?1, ?2, 1, 'migration', ?3)",
                params![agent, i64::from(enabled), now],
            )
            .map_err(|error| format!("Cannot migrate takeover for {agent}: {error}"))?;
    }
    let mut targets_created = transaction
        .execute(
            "INSERT OR IGNORE INTO agent_skill_targets
                (source_id, agent_id, enabled, origin, status, updated_at)
             SELECT s.id, t.agent_id, 1, 'migration', 'pending', ?1
             FROM sources s
             LEFT JOIN source_overrides so ON so.source_id = s.id
             JOIN agent_takeover t ON t.enabled = 1
             WHERE COALESCE(so.enabled, s.enabled, 1) = 1
               AND s.name <> 'AI-SkillHub-local-routers'
               -- Prompt sources and empty packs have nothing to deliver.
               AND EXISTS (SELECT 1 FROM skills k WHERE k.source_id = s.id)",
            params![now],
        )
        .map_err(|error| format!("Cannot migrate pack targets: {error}"))?;
    targets_created += transaction
        .execute(
            "INSERT OR IGNORE INTO agent_skill_targets
                (source_id, agent_id, enabled, origin, status, updated_at)
             SELECT 'standalone:' || k.id, t.agent_id, 1, 'migration', 'pending', ?1
             FROM skills k
             LEFT JOIN skill_overrides ko ON ko.skill_id = k.id
             JOIN agent_takeover t ON t.enabled = 1
             WHERE (k.source_id IS NULL OR k.source_id = '')
               AND COALESCE(k.is_router_hub, 0) = 0
               AND COALESCE(ko.enabled, k.enabled, 1) = 1",
            params![now],
        )
        .map_err(|error| format!("Cannot migrate standalone targets: {error}"))?;
    // A flagged pack the user already turned on in 3.2.18 stays delivered:
    // that explicit enable counts as the confirmed review (I-5 applies to
    // every enable from now on). Packs added "library only" stay off.
    transaction
        .execute(
            "UPDATE source_security_state SET review_confirmed_at = ?1
             WHERE scan_status IN ('review', 'blocked')
               AND COALESCE(review_confirmed_at, '') = ''
               AND source_id IN (
                 SELECT s.id FROM sources s
                 LEFT JOIN source_overrides so ON so.source_id = s.id
                 WHERE COALESCE(so.enabled, s.enabled, 1) = 1)",
            params![format!("migration:{now}")],
        )
        .map_err(|error| format!("Cannot migrate reviewed packs: {error}"))?;
    let any_takeover: bool = transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM agent_takeover WHERE enabled = 1)",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| format!("Cannot read migrated takeover: {error}"))?
        != 0;
    let existing_onboarding = transaction
        .query_row(
            "SELECT value FROM operator_preferences WHERE key = ?1",
            params![PREF_ONBOARDING],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("Cannot read onboarding state: {error}"))?;
    let onboarding = match existing_onboarding.as_deref() {
        Some("completed") => "completed",
        _ if !stored_fingerprint.is_empty() || any_takeover => "completed",
        _ => "pending",
    };
    for (key, value) in [
        (PREF_ONBOARDING, onboarding.to_string()),
        (PREF_PAUSED, "0".to_string()),
        (PREF_MIGRATION, format!("done:{now}")),
    ] {
        transaction
            .execute(
                "INSERT INTO operator_preferences (key, value, updated_at) VALUES (?1, ?2, ?3)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
                params![key, value, now],
            )
            .map_err(|error| format!("Cannot save migration preference {key}: {error}"))?;
    }
    let taken_over = {
        let mut statement = transaction
            .prepare("SELECT agent_id FROM agent_takeover WHERE enabled = 1 ORDER BY agent_id")
            .map_err(|error| format!("Cannot list migrated takeover: {error}"))?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|error| format!("Cannot list migrated takeover: {error}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("Cannot decode migrated takeover: {error}"))?
    };
    transaction
        .execute(
            "INSERT INTO audit_events (id, event_type, summary, detail_json, created_at)
             VALUES (?1, 'v33_delivery_migrated', ?2, ?3, ?4)",
            params![
                stable_id("audit", &format!("v33_delivery_migrated-{now}")),
                format!(
                    "v3.3 delivery migration: {} tools taken over, {} targets",
                    taken_over.len(),
                    targets_created
                ),
                serde_json::json!({
                    "takenOver": taken_over.len(),
                    "targets": targets_created,
                    "onboarding": onboarding,
                })
                .to_string(),
                now
            ],
        )
        .map_err(|error| format!("Cannot audit delivery migration: {error}"))?;
    transaction
        .commit()
        .map_err(|error| format!("Cannot commit delivery migration: {error}"))?;
    Ok(MigrationReport {
        ran: true,
        taken_over,
        targets_created,
        onboarding: onboarding.to_string(),
    })
}

// ---------------------------------------------------------------------------
// Delivery units (§3.1)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct UnitInfo {
    pub unit_id: String,
    pub kind: &'static str,
    pub source_id: String,
    pub skill_id: String,
    /// Entry folder names delivered for this unit; the first is the primary one.
    pub entries: Vec<String>,
    pub callable_skills: usize,
    pub library_enabled: bool,
    pub library_only_reason: &'static str,
    /// An entry the 3.2.18 allowlist publishes that maps to no indexed pack or
    /// skill. It has no row the user could toggle, so it follows takeover:
    /// delivered to every taken-over tool unless a row says otherwise.
    pub implicit: bool,
}

impl UnitInfo {
    pub(crate) fn entry_name(&self) -> &str {
        self.entries.first().map(String::as_str).unwrap_or_default()
    }
}

struct SourceRow {
    id: String,
    name: String,
    local_path: String,
    source_type: String,
    enabled: bool,
    flagged: bool,
}

struct SkillRow {
    id: String,
    source_id: String,
    folder_name: String,
    is_router_hub: bool,
    enabled: bool,
}

fn read_unit_sources(connection: &Connection) -> Result<Vec<SourceRow>, String> {
    let mut statement = connection
        .prepare(
            "SELECT s.id, s.name, COALESCE(s.local_path, ''),
                    COALESCE(NULLIF(so.source_type, ''), s.source_type),
                    COALESCE(so.enabled, s.enabled, 1),
                    CASE WHEN ss.scan_status IN ('review', 'blocked')
                          AND COALESCE(ss.review_confirmed_at, '') = '' THEN 1 ELSE 0 END
             FROM sources s
             LEFT JOIN source_overrides so ON so.source_id = s.id
             LEFT JOIN source_security_state ss ON ss.source_id = s.id
             ORDER BY lower(s.name), s.id",
        )
        .map_err(|error| format!("Cannot prepare unit sources: {error}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok(SourceRow {
                id: row.get(0)?,
                name: row.get(1)?,
                local_path: row.get(2)?,
                source_type: row.get(3)?,
                enabled: row.get::<_, i64>(4)? != 0,
                flagged: row.get::<_, i64>(5)? != 0,
            })
        })
        .map_err(|error| format!("Cannot read unit sources: {error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Cannot decode unit sources: {error}"))
}

fn read_unit_skills(connection: &Connection) -> Result<Vec<SkillRow>, String> {
    let mut statement = connection
        .prepare(
            "SELECT k.id, COALESCE(k.source_id, ''), k.folder_name,
                    COALESCE(k.is_router_hub, 0), COALESCE(ko.enabled, k.enabled, 1)
             FROM skills k
             LEFT JOIN skill_overrides ko ON ko.skill_id = k.id
             ORDER BY lower(k.folder_name), k.id",
        )
        .map_err(|error| format!("Cannot prepare unit skills: {error}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok(SkillRow {
                id: row.get(0)?,
                source_id: row.get(1)?,
                folder_name: row.get(2)?,
                is_router_hub: row.get::<_, i64>(3)? != 0,
                enabled: row.get::<_, i64>(4)? != 0,
            })
        })
        .map_err(|error| format!("Cannot read unit skills: {error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Cannot decode unit skills: {error}"))
}

/// Callable rule shared with `countSkills` (§4.6): in a pack with exactly one
/// indexed skill that skill is callable even when flagged as a router; in a
/// pack with two or more skills, router hubs are excluded.
pub(crate) fn is_callable_skill(is_router_hub: bool, skills_in_same_pack: usize) -> bool {
    skills_in_same_pack == 1 || !is_router_hub
}

/// Light manifest check equal to the PowerShell `Test-ValidSkillManifest`:
/// non-empty name and description, and a canonical name for generated parents.
pub(crate) fn manifest_is_deliverable(skill_dir: &Path) -> bool {
    let Ok(raw) = fs::read_to_string(skill_dir.join("SKILL.md")) else {
        return false;
    };
    let Some((name, description)) = manifest_name_and_description(&raw) else {
        return false;
    };
    if name.trim().is_empty() || description.trim().is_empty() {
        return false;
    }
    if raw.contains(ROUTER_HUB_MARKER) {
        let folder = skill_dir
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        return folder == name && super::canonical_parent_delivery_name(&name);
    }
    true
}

/// `(name, description)` read the way the delivery validators read them.
pub(crate) fn manifest_name_and_description(raw: &str) -> Option<(String, String)> {
    let lines = raw
        .trim_start_matches('\u{feff}')
        .lines()
        .take(256)
        .collect::<Vec<_>>();
    if lines.len() < 4 || lines[0].trim() != "---" {
        return None;
    }
    let end = lines
        .iter()
        .enumerate()
        .skip(1)
        .find_map(|(index, line)| (line.trim() == "---").then_some(index))?;
    if end < 2 {
        return None;
    }
    let frontmatter = &lines[1..end];
    let value_of = |key: &str| -> Option<(usize, String)> {
        frontmatter.iter().enumerate().find_map(|(index, line)| {
            let (left, right) = line.split_once(':')?;
            left.trim().eq_ignore_ascii_case(key).then(|| {
                (
                    index,
                    right.trim().trim_matches(&['\'', '"'][..]).to_string(),
                )
            })
        })
    };
    let name = value_of("name").map(|(_, value)| value).unwrap_or_default();
    let mut description = value_of("description");
    if let Some((index, value)) = &mut description {
        if matches!(value.as_str(), ">" | ">+" | ">-" | "|" | "|+" | "|-") {
            *value = frontmatter[*index + 1..]
                .iter()
                .take_while(|line| {
                    line.trim().is_empty() || line.chars().next().is_some_and(char::is_whitespace)
                })
                .map(|line| line.trim())
                .filter(|line| !line.is_empty())
                .collect::<Vec<_>>()
                .join(" ");
        }
    }
    Some((
        name,
        description.map(|(_, value)| value).unwrap_or_default(),
    ))
}

fn source_keys(name: &str, local_path: &str) -> Vec<String> {
    let mut keys = vec![normalize_skill_lookup(name)];
    if let Some(folder) = Path::new(local_path)
        .file_name()
        .and_then(|value| value.to_str())
    {
        keys.push(normalize_skill_lookup(folder));
    }
    keys.retain(|key| !key.is_empty());
    keys.sort();
    keys.dedup();
    keys
}

/// Builds every delivery unit from the index and the final active catalog.
/// `union` is the 3.2.18 allowlist; per-agent lists are always subsets of it.
pub(crate) fn read_delivery_units(
    root: &Path,
    connection: &Connection,
    union: &[String],
) -> Result<Vec<UnitInfo>, String> {
    read_delivery_units_at(&active_skills_dir(root), connection, union)
}

/// Same as [`read_delivery_units`] for an explicit active catalog folder.
pub(crate) fn read_delivery_units_at(
    active_root: &Path,
    connection: &Connection,
    union: &[String],
) -> Result<Vec<UnitInfo>, String> {
    let active_root = active_root.to_path_buf();
    let active_entries = collect_active_agent_skill_entries(&active_root).unwrap_or_default();
    let union_keys = union
        .iter()
        .map(|name| name.to_lowercase())
        .collect::<BTreeSet<_>>();
    let sources = read_unit_sources(connection)?;
    let skills = read_unit_skills(connection)?;
    let mut skills_by_source: HashMap<&str, Vec<&SkillRow>> = HashMap::new();
    for skill in &skills {
        skills_by_source
            .entry(skill.source_id.as_str())
            .or_default()
            .push(skill);
    }
    let mut assigned = BTreeSet::new();
    let mut units = Vec::new();

    for source in &sources {
        if source.name.eq_ignore_ascii_case(ROUTER_HUB_FOLDER) {
            continue;
        }
        let keys = source_keys(&source.name, &source.local_path);
        let source_skills = skills_by_source
            .get(source.id.as_str())
            .cloned()
            .unwrap_or_default();
        let mut entries = active_entries
            .iter()
            .filter(|entry| {
                matches!(&entry.dependency,
                    Some(GeneratedAgentSkillDependency::Source(dep))
                        if keys.contains(&normalize_skill_lookup(dep)))
            })
            .map(|entry| entry.name.clone())
            .collect::<Vec<_>>();
        if entries.is_empty() {
            // No generated parent: the pack's skills are published directly.
            entries = active_entries
                .iter()
                .filter(|entry| entry.dependency.is_none())
                .filter(|entry| {
                    source_skills
                        .iter()
                        .any(|skill| skill.folder_name.eq_ignore_ascii_case(&entry.name))
                })
                .map(|entry| entry.name.clone())
                .collect();
        }
        if entries.is_empty() && !source_skills.is_empty() {
            let folder = Path::new(&source.local_path)
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or(&source.name)
                .to_string();
            entries.push(router_hub_skill_name(&folder));
        }
        for entry in &entries {
            assigned.insert(entry.to_lowercase());
        }
        let count = source_skills.len();
        let callable = source_skills
            .iter()
            .filter(|skill| is_callable_skill(skill.is_router_hub, count))
            .count();
        let enabled_children = source_skills.iter().filter(|skill| skill.enabled).count();
        let entries_valid = !entries.is_empty()
            && entries.iter().all(|entry| {
                union_keys.contains(&entry.to_lowercase())
                    && manifest_is_deliverable(&active_root.join(entry))
            });
        let reason =
            if count == 0 || source.source_type.eq_ignore_ascii_case("prompt") && callable == 0 {
                "prompt-only"
            } else if source.flagged {
                "security-review"
            } else if !source.enabled {
                "disabled-by-user"
            } else if enabled_children == 0 {
                "no-enabled-skills"
            } else if !entries_valid {
                "invalid-manifest"
            } else {
                ""
            };
        units.push(UnitInfo {
            unit_id: source.id.clone(),
            kind: "source",
            source_id: source.id.clone(),
            skill_id: String::new(),
            entries,
            callable_skills: callable,
            library_enabled: reason.is_empty(),
            library_only_reason: reason,
            implicit: false,
        });
    }

    let source_ids = sources
        .iter()
        .map(|source| source.id.as_str())
        .collect::<BTreeSet<_>>();
    for skill in &skills {
        let owned_by_known_pack =
            !skill.source_id.is_empty() && source_ids.contains(skill.source_id.as_str());
        if owned_by_known_pack
            || skill.is_router_hub
            || assigned.contains(&skill.folder_name.to_lowercase())
        {
            continue;
        }
        assigned.insert(skill.folder_name.to_lowercase());
        let valid = union_keys.contains(&skill.folder_name.to_lowercase())
            && manifest_is_deliverable(&active_root.join(&skill.folder_name));
        let reason = if !skill.enabled {
            "disabled-by-user"
        } else if !valid {
            "invalid-manifest"
        } else {
            ""
        };
        units.push(UnitInfo {
            unit_id: format!("{STANDALONE_PREFIX}{}", skill.id),
            kind: "standalone",
            source_id: String::new(),
            skill_id: skill.id.clone(),
            entries: vec![skill.folder_name.clone()],
            callable_skills: 1,
            library_enabled: reason.is_empty(),
            library_only_reason: reason,
            implicit: false,
        });
    }

    // Anything the 3.2.18 allowlist would publish must stay deliverable.
    for name in union {
        if assigned.contains(&name.to_lowercase()) {
            continue;
        }
        let skill_id = stable_id("skill", name);
        let deliverable = manifest_is_deliverable(&active_root.join(name));
        units.push(UnitInfo {
            unit_id: format!("{STANDALONE_PREFIX}{skill_id}"),
            kind: "standalone",
            source_id: String::new(),
            skill_id,
            entries: vec![name.clone()],
            callable_skills: 1,
            library_enabled: deliverable,
            library_only_reason: if deliverable { "" } else { "invalid-manifest" },
            implicit: true,
        });
    }
    Ok(units)
}

/// Unit existence check for mutations, SQL only.
pub(crate) fn unit_exists(connection: &Connection, unit_id: &str) -> Result<bool, String> {
    let (sql, key) = match unit_id.strip_prefix(STANDALONE_PREFIX) {
        Some(skill_id) => (
            "SELECT EXISTS(SELECT 1 FROM skills WHERE id = ?1)",
            skill_id,
        ),
        None => (
            "SELECT EXISTS(SELECT 1 FROM sources WHERE id = ?1)",
            unit_id,
        ),
    };
    connection
        .query_row(sql, params![key], |row| row.get::<_, i64>(0))
        .map(|value| value != 0)
        .map_err(|error| format!("Cannot look up unit: {error}"))
}

/// SQL-only library state for one unit, used by mutations (< 300 ms).
pub(crate) fn unit_library_reason(
    connection: &Connection,
    unit_id: &str,
) -> Result<&'static str, String> {
    if let Some(skill_id) = unit_id.strip_prefix(STANDALONE_PREFIX) {
        let enabled = connection
            .query_row(
                "SELECT COALESCE(ko.enabled, k.enabled, 1) FROM skills k
                 LEFT JOIN skill_overrides ko ON ko.skill_id = k.id WHERE k.id = ?1",
                params![skill_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map_err(|error| format!("Cannot read standalone unit: {error}"))?;
        return Ok(match enabled {
            Some(1) | None => "",
            _ => "disabled-by-user",
        });
    }
    let row = connection
        .query_row(
            "SELECT COALESCE(so.enabled, s.enabled, 1),
                    CASE WHEN ss.scan_status IN ('review', 'blocked')
                          AND COALESCE(ss.review_confirmed_at, '') = '' THEN 1 ELSE 0 END,
                    (SELECT COUNT(*) FROM skills k WHERE k.source_id = s.id),
                    (SELECT COUNT(*) FROM skills k LEFT JOIN skill_overrides ko ON ko.skill_id = k.id
                      WHERE k.source_id = s.id AND COALESCE(ko.enabled, k.enabled, 1) = 1)
             FROM sources s
             LEFT JOIN source_overrides so ON so.source_id = s.id
             LEFT JOIN source_security_state ss ON ss.source_id = s.id
             WHERE s.id = ?1",
            params![unit_id],
            |row| {
                Ok((
                    row.get::<_, i64>(0)? != 0,
                    row.get::<_, i64>(1)? != 0,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            },
        )
        .optional()
        .map_err(|error| format!("Cannot read pack state: {error}"))?;
    Ok(match row {
        None => "",
        Some((_, _, 0, _)) => "prompt-only",
        Some((_, true, _, _)) => "security-review",
        Some((false, _, _, _)) => "disabled-by-user",
        Some((_, _, _, 0)) => "no-enabled-skills",
        _ => "",
    })
}

// ---------------------------------------------------------------------------
// Per-agent plan and the targets file (§3.3)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum RecipientAction {
    Deliver,
    Release,
    Skip,
}

impl RecipientAction {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Deliver => "deliver",
            Self::Release => "release",
            Self::Skip => "skip",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RecipientPlan {
    /// PowerShell recipient id: claude | workbuddy | antigravity | codex |
    /// codex-legacy | cursor | gemini-cli.
    pub id: &'static str,
    pub agent_id: &'static str,
    pub action: RecipientAction,
    pub path: PathBuf,
    pub names: Vec<String>,
    /// Codex in Coze shared mode: Rust writes real entries, PS only verifies.
    pub shared: bool,
    /// codex-legacy in shared mode links to the shared folder instead.
    pub link_root: Option<PathBuf>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct SharedPlan {
    pub path: PathBuf,
    pub action: Option<RecipientAction>,
    pub names: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct TargetsPlan {
    pub union: Vec<String>,
    pub recipients: Vec<RecipientPlan>,
    pub shared: Option<SharedPlan>,
    pub real_shared: bool,
}

/// Deliverable-tool evidence derived from the recipient states.
#[derive(Debug, Clone, Default)]
pub(crate) struct Evidence {
    pub real_shared: bool,
    pub installed: BTreeMap<&'static str, bool>,
    pub paths: BTreeMap<&'static str, PathBuf>,
    pub codex_legacy: Option<PathBuf>,
}

impl Evidence {
    pub(crate) fn from_recipients(recipients: &[AgentDeliveryRecipientState]) -> Self {
        let mut evidence = Self::default();
        for recipient in recipients {
            match recipient.id {
                "coze-shared" => {
                    evidence.real_shared = recipient.detected;
                    evidence.paths.insert("coze", recipient.path.clone());
                }
                "coze" => {
                    evidence.installed.insert("coze", recipient.detected);
                }
                "codex-legacy" => {
                    if recipient.detected {
                        evidence.codex_legacy = Some(recipient.path.clone());
                    }
                }
                id => {
                    if let Some(agent) = DELIVERABLE_AGENTS.iter().find(|agent| **agent == id) {
                        evidence.installed.insert(agent, recipient.detected);
                        evidence.paths.insert(agent, recipient.path.clone());
                    }
                }
            }
        }
        evidence
    }

    pub(crate) fn installed(&self, agent_id: &str) -> bool {
        self.installed.get(agent_id).copied().unwrap_or(false)
    }

    pub(crate) fn can_deliver(&self, agent_id: &str) -> bool {
        match agent_id {
            "coze" => self.real_shared,
            other => DELIVERABLE_AGENTS.contains(&other),
        }
    }

    pub(crate) fn path(&self, agent_id: &str) -> Option<&PathBuf> {
        self.paths.get(agent_id)
    }
}

/// Desired state of one pair: the row when there is one; an implicit unit
/// (allowlisted, with nothing the user could toggle) follows takeover.
pub(crate) fn pair_desired(unit: &UnitInfo, row: Option<&TargetRow>) -> bool {
    match row {
        Some(row) => row.enabled,
        None => unit.implicit,
    }
}

/// Names this agent should hold: entries of every library-enabled unit with a
/// desired row, restricted to the union allowlist. Only called for an agent
/// whose takeover is on.
pub(crate) fn names_for_agent(
    agent_id: &str,
    units: &[UnitInfo],
    targets: &BTreeMap<(String, String), TargetRow>,
    union: &[String],
) -> Vec<String> {
    let union_keys = union
        .iter()
        .map(|name| (name.to_lowercase(), name.clone()))
        .collect::<BTreeMap<_, _>>();
    let mut names = units
        .iter()
        .filter(|unit| unit.library_enabled)
        .filter(|unit| {
            pair_desired(
                unit,
                targets.get(&(unit.unit_id.clone(), agent_id.to_string())),
            )
        })
        .flat_map(|unit| unit.entries.iter())
        .filter_map(|entry| union_keys.get(&entry.to_lowercase()).cloned())
        .collect::<Vec<_>>();
    names.sort_by_key(|name| name.to_lowercase());
    names.dedup_by(|left, right| left.eq_ignore_ascii_case(right));
    names
}

pub(crate) fn compute_targets_plan(
    union: &[String],
    units: &[UnitInfo],
    targets: &BTreeMap<(String, String), TargetRow>,
    takeover: &BTreeMap<String, TakeoverRow>,
    evidence: &Evidence,
) -> TargetsPlan {
    let action_for = |agent: &str| -> RecipientAction {
        if !takeover_enabled(takeover, agent) {
            RecipientAction::Release
        } else if evidence.installed(agent) {
            RecipientAction::Deliver
        } else {
            RecipientAction::Skip
        }
    };
    let mut recipients = Vec::new();
    for agent in ["claude", "workbuddy", "antigravity", "cursor", "gemini-cli"] {
        let Some(path) = evidence.path(agent) else {
            continue;
        };
        let action = action_for(agent);
        recipients.push(RecipientPlan {
            id: agent,
            agent_id: agent,
            action,
            path: path.clone(),
            names: if action == RecipientAction::Deliver {
                names_for_agent(agent, units, targets, union)
            } else {
                Vec::new()
            },
            shared: false,
            link_root: None,
        });
    }
    let shared_path = evidence.path("coze").cloned();
    let codex_action = if evidence.real_shared {
        // The group is one switch; either installed tool keeps it delivering.
        if !takeover_enabled(takeover, "codex") {
            RecipientAction::Release
        } else if evidence.installed("codex") || evidence.installed("coze") {
            RecipientAction::Deliver
        } else {
            RecipientAction::Skip
        }
    } else {
        action_for("codex")
    };
    let codex_names = if codex_action == RecipientAction::Deliver {
        names_for_agent("codex", units, targets, union)
    } else {
        Vec::new()
    };
    if let Some(path) = evidence.path("codex") {
        // In shared mode PS only verifies what Rust wrote, and only when Codex
        // itself is installed.
        let action = if evidence.real_shared && !evidence.installed("codex") {
            RecipientAction::Skip
        } else {
            codex_action
        };
        recipients.push(RecipientPlan {
            id: "codex",
            agent_id: "codex",
            action,
            path: path.clone(),
            names: if action == RecipientAction::Deliver {
                codex_names.clone()
            } else {
                Vec::new()
            },
            shared: evidence.real_shared,
            link_root: None,
        });
    }
    if let Some(legacy) = &evidence.codex_legacy {
        let action = if evidence.real_shared && !evidence.installed("codex") {
            RecipientAction::Skip
        } else {
            codex_action
        };
        recipients.push(RecipientPlan {
            id: "codex-legacy",
            agent_id: "codex",
            action,
            path: legacy.clone(),
            names: if action == RecipientAction::Deliver {
                codex_names.clone()
            } else {
                Vec::new()
            },
            shared: false,
            link_root: if evidence.real_shared {
                shared_path.clone()
            } else {
                None
            },
        });
    }
    let shared = evidence.real_shared.then(|| SharedPlan {
        path: shared_path.unwrap_or_default(),
        action: Some(codex_action),
        names: codex_names,
    });
    TargetsPlan {
        union: union.to_vec(),
        recipients,
        shared,
        real_shared: evidence.real_shared,
    }
}

const KNOWN_RECIPIENT_IDS: &[&str] = &[
    "claude",
    "workbuddy",
    "antigravity",
    "codex",
    "codex-legacy",
    "cursor",
    "gemini-cli",
];

/// Fail closed before any write when the plan is inconsistent (rule 1).
pub(crate) fn validate_targets_plan(plan: &TargetsPlan) -> Result<(), SkillHubError> {
    let union_keys = plan
        .union
        .iter()
        .map(|name| name.to_lowercase())
        .collect::<BTreeSet<_>>();
    for recipient in &plan.recipients {
        if !KNOWN_RECIPIENT_IDS.contains(&recipient.id) {
            return Err(SkillHubError::code("DELIVERY_POLICY_INVALID")
                .with_detail(format!("unknown recipient {}", recipient.id)));
        }
        if let Some(name) = recipient
            .names
            .iter()
            .find(|name| !union_keys.contains(&name.to_lowercase()))
        {
            return Err(
                SkillHubError::code("DELIVERY_POLICY_INVALID").with_detail(format!(
                    "{} lists {name}, which is outside the allowlist",
                    recipient.id
                )),
            );
        }
    }
    if let Some(shared) = &plan.shared {
        if let Some(name) = shared
            .names
            .iter()
            .find(|name| !union_keys.contains(&name.to_lowercase()))
        {
            return Err(SkillHubError::code("DELIVERY_POLICY_INVALID")
                .with_detail(format!("shared folder lists {name} outside the allowlist")));
        }
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TargetsFile<'a> {
    version: u32,
    policy_version: &'a str,
    union: &'a [String],
    recipients: Vec<TargetsFileRecipient>,
    /// Shared Coze/Codex folder written by Rust; PowerShell only uses the names
    /// to keep the legacy UserData catalog aliases in step.
    #[serde(skip_serializing_if = "Option::is_none")]
    shared: Option<TargetsFileShared<'a>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TargetsFileShared<'a> {
    action: &'static str,
    names: &'a [String],
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TargetsFileRecipient {
    id: String,
    action: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    shared: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    link_root: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    names: Option<Vec<String>>,
}

pub(crate) fn targets_file_json(
    plan: &TargetsPlan,
    policy_version: &str,
) -> Result<String, String> {
    let recipients = plan
        .recipients
        .iter()
        .map(|recipient| {
            if recipient.action == RecipientAction::Skip {
                return TargetsFileRecipient {
                    id: recipient.id.to_string(),
                    action: "skip",
                    path: None,
                    shared: None,
                    link_root: None,
                    names: None,
                };
            }
            TargetsFileRecipient {
                id: recipient.id.to_string(),
                action: recipient.action.as_str(),
                path: Some(recipient.path.display().to_string()),
                shared: recipient.shared.then_some(true),
                link_root: recipient
                    .link_root
                    .as_ref()
                    .map(|path| path.display().to_string()),
                names: Some(recipient.names.clone()),
            }
        })
        .collect();
    serde_json::to_string_pretty(&TargetsFile {
        version: 1,
        policy_version,
        union: &plan.union,
        recipients,
        shared: plan.shared.as_ref().map(|shared| TargetsFileShared {
            action: shared.action.map(RecipientAction::as_str).unwrap_or("skip"),
            names: &shared.names,
        }),
    })
    .map_err(|error| format!("Cannot serialize targets file: {error}"))
}

pub(crate) fn targets_file_path(root: &Path) -> PathBuf {
    private_state_dir(root).join(TARGETS_FILE_NAME)
}

pub(crate) fn delivery_report_path(root: &Path) -> PathBuf {
    private_state_dir(root).join(DELIVERY_REPORT_FILE_NAME)
}

pub(crate) fn write_targets_file(
    root: &Path,
    plan: &TargetsPlan,
    policy_version: &str,
) -> Result<PathBuf, String> {
    let path = targets_file_path(root);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Cannot create targets folder: {error}"))?;
    }
    let body = targets_file_json(plan, policy_version)?;
    fs::write(&path, format!("{body}\n"))
        .map_err(|error| format!("Cannot write targets file {}: {error}", path.display()))?;
    Ok(path)
}

/// Extra fingerprint input (§2.5): pause, onboarding, takeover and every
/// recipient's action and names.
pub(crate) fn fingerprint_lines(
    paused: bool,
    onboarding: &str,
    takeover: &BTreeMap<String, TakeoverRow>,
    plan: &TargetsPlan,
) -> Vec<String> {
    let mut lines = vec![
        format!("paused={}", u8::from(paused)),
        format!("onboarding={onboarding}"),
    ];
    for agent in DELIVERABLE_AGENTS {
        lines.push(format!(
            "takeover:{agent}={}",
            u8::from(takeover_enabled(takeover, agent))
        ));
    }
    for recipient in &plan.recipients {
        lines.push(format!(
            "recipient:{}:{}:{}",
            recipient.id,
            recipient.action.as_str(),
            recipient.names.join("|")
        ));
    }
    if let Some(shared) = &plan.shared {
        lines.push(format!(
            "shared:{}:{}",
            shared.action.map(RecipientAction::as_str).unwrap_or("none"),
            shared.names.join("|")
        ));
    }
    lines
}

// ---------------------------------------------------------------------------
// Delivery report (PowerShell → Rust) and per-agent results
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct ReportEntry {
    pub name: String,
    pub state: String,
    pub detail: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct ReportRecipient {
    pub id: String,
    pub path: String,
    pub action: String,
    pub outcome: String,
    pub error: String,
    pub entries: Vec<ReportEntry>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct DeliveryReport {
    pub version: u32,
    pub generated_at: String,
    pub recipients: Vec<ReportRecipient>,
}

pub(crate) fn read_delivery_report(path: &Path) -> Option<DeliveryReport> {
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str(raw.trim_start_matches('\u{feff}')).ok()
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentDeliveryResult {
    pub agent_id: String,
    pub outcome: String,
    pub linked: usize,
    pub removed: usize,
    pub unchanged: usize,
    pub conflicts: usize,
    pub errors: usize,
    pub error: Option<SkillHubError>,
    pub finished_at: String,
}

impl AgentDeliveryResult {
    pub(crate) fn new(agent_id: &str, outcome: &str) -> Self {
        Self {
            agent_id: agent_id.to_string(),
            outcome: outcome.to_string(),
            linked: 0,
            removed: 0,
            unchanged: 0,
            conflicts: 0,
            errors: 0,
            error: None,
            finished_at: iso_now(),
        }
    }
}

fn outcome_rank(outcome: &str) -> u8 {
    match outcome {
        "failed" => 6,
        "partial" => 5,
        "ok" => 4,
        "released" => 3,
        "not-installed" => 2,
        "paused" => 1,
        _ => 0,
    }
}

/// Folds PowerShell recipients into per-agent results (codex + codex-legacy).
pub(crate) fn results_from_report(
    report: &DeliveryReport,
) -> BTreeMap<String, AgentDeliveryResult> {
    let mut results: BTreeMap<String, AgentDeliveryResult> = BTreeMap::new();
    for recipient in &report.recipients {
        let agent = if recipient.id == "codex-legacy" {
            "codex"
        } else {
            recipient.id.as_str()
        };
        if agent_spec(agent).is_none() {
            continue;
        }
        let outcome = match recipient.outcome.as_str() {
            "skipped-not-installed" => "not-installed",
            "ok" | "partial" | "failed" | "skipped" | "released" => recipient.outcome.as_str(),
            _ => "failed",
        };
        let result = results
            .entry(agent.to_string())
            .or_insert_with(|| AgentDeliveryResult::new(agent, "skipped"));
        if outcome_rank(outcome) > outcome_rank(&result.outcome) {
            result.outcome = outcome.to_string();
        }
        for entry in &recipient.entries {
            match entry.state.as_str() {
                "linked" => result.linked += 1,
                "unchanged" => result.unchanged += 1,
                "removed" => result.removed += 1,
                "conflict" => result.conflicts += 1,
                _ => result.errors += 1,
            }
        }
        if !recipient.error.trim().is_empty() && result.error.is_none() {
            result.error = Some(
                crate::skillhub_error::classify_legacy_error(&recipient.error).with_agent(agent),
            );
        }
    }
    results
}

pub(crate) fn result_from_shared(
    agent_id: &str,
    action: RecipientAction,
    report: &Result<shared_skill_catalog::SharedSyncReport, String>,
) -> AgentDeliveryResult {
    match report {
        Ok(report) => {
            let mut result = AgentDeliveryResult::new(agent_id, "ok");
            result.linked = report.written.len();
            result.unchanged = report.unchanged.len();
            result.removed = report.removed.len();
            result.conflicts = report.conflicts.len();
            result.errors = report.skipped.len();
            result.outcome = match action {
                RecipientAction::Release => "released",
                RecipientAction::Skip => "skipped",
                RecipientAction::Deliver if result.conflicts + result.errors > 0 => "partial",
                RecipientAction::Deliver => "ok",
            }
            .to_string();
            if let Some(conflict) = report.conflicts.first() {
                result.error = Some(
                    SkillHubError::code("TARGET_CONFLICT")
                        .with_agent(agent_id)
                        .with_path(conflict.path.display().to_string()),
                );
            } else if let Some((name, reason)) = report.skipped.first() {
                result.error = Some(
                    SkillHubError::code("MANIFEST_INVALID")
                        .with_agent(agent_id)
                        .with_detail(format!("{name}: {reason}")),
                );
            }
            result
        }
        Err(error) => {
            let mut result = AgentDeliveryResult::new(agent_id, "failed");
            result.errors = 1;
            result.error =
                Some(crate::skillhub_error::classify_legacy_error(error).with_agent(agent_id));
            result
        }
    }
}

pub(crate) fn record_agent_results(
    connection: &Connection,
    results: &BTreeMap<String, AgentDeliveryResult>,
) -> Result<(), String> {
    for (agent, result) in results {
        let (code, message) = result
            .error
            .as_ref()
            .map(|error| (error.code.clone(), error.message.clone()))
            .unwrap_or_default();
        connection
            .execute(
                "INSERT INTO agent_takeover (agent_id, enabled, auto_add_new, origin, updated_at,
                    last_outcome, last_error_code, last_error, last_delivered_at)
                 VALUES (?1, 0, 1, 'user', ?2, ?3, ?4, ?5, ?2)
                 ON CONFLICT(agent_id) DO UPDATE SET
                    last_outcome = excluded.last_outcome,
                    last_error_code = excluded.last_error_code,
                    last_error = excluded.last_error,
                    last_delivered_at = excluded.last_delivered_at",
                params![
                    agent,
                    unix_timestamp_string(),
                    result.outcome,
                    code,
                    crate::skillhub_error::redact(&message)
                ],
            )
            .map_err(|error| format!("Cannot record delivery result for {agent}: {error}"))?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Read-back (§3.4) and status resolution
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum DiskState {
    Absent,
    Ours {
        manifest_ok: bool,
        hash: String,
        target: PathBuf,
    },
    Conflict {
        kind: &'static str,
        same_content: bool,
        path: PathBuf,
    },
}

impl DiskState {
    pub(crate) fn is_ours(&self) -> bool {
        matches!(self, Self::Ours { .. })
    }

    fn label(&self) -> &'static str {
        match self {
            Self::Absent => "off",
            Self::Ours {
                manifest_ok: true, ..
            } => "synced",
            Self::Ours { .. } => "error",
            Self::Conflict { .. } => "conflict",
        }
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn manifest_hash(dir: &Path) -> String {
    fs::read(dir.join("SKILL.md"))
        .map(|bytes| sha256_hex(&bytes))
        .unwrap_or_default()
}

/// Inspects `<recipient>/<entry>` without following anything that is not ours.
/// `link_roots`: a reparse point whose target is under one of these is ours.
/// `managed_dirs`: real wrapper directories (`is_managed_entry`) are ours.
pub(crate) fn inspect_entry(
    recipient_root: &Path,
    entry: &str,
    link_roots: &[PathBuf],
    managed_dirs: bool,
    original_dir: &Path,
) -> DiskState {
    let path = recipient_root.join(entry);
    let Ok(metadata) = fs::symlink_metadata(&path) else {
        return DiskState::Absent;
    };
    let original_hash = || manifest_hash(original_dir);
    if external_skills::is_link(&path) {
        let target = delivery_link_target(&path).unwrap_or_default();
        if link_roots.iter().any(|root| path_is_under(&target, root)) {
            return DiskState::Ours {
                manifest_ok: manifest_name_and_description(
                    &fs::read_to_string(path.join("SKILL.md")).unwrap_or_default(),
                )
                .is_some_and(|(name, description)| {
                    !name.trim().is_empty() && !description.trim().is_empty()
                }),
                hash: manifest_hash(&path),
                target,
            };
        }
        let same_content = {
            let hash = manifest_hash(&path);
            !hash.is_empty() && hash == original_hash()
        };
        return DiskState::Conflict {
            kind: "external-link",
            same_content,
            path,
        };
    }
    if metadata.is_dir() {
        if managed_dirs && shared_skill_catalog::is_managed_entry(&path) {
            return DiskState::Ours {
                manifest_ok: manifest_name_and_description(
                    &fs::read_to_string(path.join("SKILL.md")).unwrap_or_default(),
                )
                .is_some_and(|(name, description)| {
                    !name.trim().is_empty() && !description.trim().is_empty()
                }),
                hash: manifest_hash(&path),
                target: path.clone(),
            };
        }
        let hash = manifest_hash(&path);
        return DiskState::Conflict {
            kind: "personal-folder",
            same_content: !hash.is_empty() && hash == original_hash(),
            path,
        };
    }
    DiskState::Conflict {
        kind: "not-a-folder",
        same_content: false,
        path,
    }
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct StatusInput<'a> {
    pub desired: bool,
    pub disk: &'a DiskState,
    pub installed: bool,
    pub takeover: bool,
    pub library_enabled: bool,
    /// Paused or onboarding pending (I-1).
    pub writes_blocked: bool,
    /// A delivery job is queued, waiting or running.
    pub job_active: bool,
    /// The last read-back happened after the last change of intent.
    pub verified_after_change: bool,
}

/// The single place that turns intent plus read-back into a target status.
pub(crate) fn resolve_status(input: StatusInput<'_>) -> (&'static str, Option<&'static str>) {
    let ours_ok = matches!(
        input.disk,
        DiskState::Ours {
            manifest_ok: true,
            ..
        }
    );
    let settling = input.job_active || !input.verified_after_change;
    if input.desired && !input.library_enabled && !input.disk.is_ours() {
        return ("blocked", None);
    }
    if !input.installed && input.disk.is_ours() {
        return ("orphan", None);
    }
    let wanted = input.desired && input.takeover && input.library_enabled;
    if input.writes_blocked && wanted != ours_ok {
        return ("paused", None);
    }
    if !input.takeover || !input.library_enabled {
        return match input.disk {
            DiskState::Ours { .. } if input.writes_blocked => ("paused", None),
            DiskState::Ours { .. } if settling => ("removing", None),
            DiskState::Ours { .. } => ("error", Some("DELIVERY_VERIFY_FAILED")),
            _ if !input.takeover => ("takeover-off", None),
            _ => ("off", None),
        };
    }
    match input.disk {
        DiskState::Conflict { .. } if input.desired => ("conflict", Some("TARGET_CONFLICT")),
        DiskState::Conflict { .. } => ("off", None),
        DiskState::Ours {
            manifest_ok: false, ..
        } => ("error", Some("MANIFEST_INVALID")),
        DiskState::Ours { .. } if input.desired => ("synced", None),
        DiskState::Ours { .. } if settling => ("removing", None),
        DiskState::Ours { .. } => ("error", Some("DELIVERY_VERIFY_FAILED")),
        DiskState::Absent if !input.desired => ("off", None),
        DiskState::Absent if !input.installed => ("error", Some("AGENT_NOT_INSTALLED")),
        DiskState::Absent if settling => ("pending", None),
        DiskState::Absent => ("error", Some("DELIVERY_VERIFY_FAILED")),
    }
}

/// Last read-back of one pair, kept in memory for pairs without a row.
#[derive(Debug, Clone)]
pub(crate) struct PairDisk {
    pub disk: DiskState,
    pub entry_name: String,
    pub mode: &'static str,
    pub verified_at: String,
}

static READBACK_CACHE: OnceLock<Mutex<HashMap<(String, String), PairDisk>>> = OnceLock::new();

fn readback_cache() -> &'static Mutex<HashMap<(String, String), PairDisk>> {
    READBACK_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Read the disk state of every (unit x deliverable agent) pair, persist it
/// into existing rows and keep the full set in memory. Never writes to disk
/// outside SQLite.
pub(crate) fn read_back(
    root: &Path,
    connection: &Connection,
    units: &[UnitInfo],
    evidence: &Evidence,
) -> Result<usize, String> {
    read_back_at(&active_skills_dir(root), connection, units, evidence)
}

/// [`read_back`] for an explicit active catalog folder.
pub(crate) fn read_back_at(
    active_root: &Path,
    connection: &Connection,
    units: &[UnitInfo],
    evidence: &Evidence,
) -> Result<usize, String> {
    let active_root = active_root.to_path_buf();
    let now = unix_timestamp_string();
    let mut pairs = HashMap::new();
    for agent in DELIVERABLE_AGENTS {
        if !evidence.can_deliver(agent) {
            continue;
        }
        let Some(path) = evidence.path(agent) else {
            continue;
        };
        let shared_mode = evidence.real_shared && matches!(*agent, "codex" | "coze");
        let link_roots = vec![active_root.clone()];
        let mode = if shared_mode { "shared-real" } else { "link" };
        for unit in units {
            let entry = unit.entry_name();
            if entry.is_empty() {
                continue;
            }
            let disk = inspect_entry(
                path,
                entry,
                &link_roots,
                shared_mode,
                &active_root.join(entry),
            );
            pairs.insert(
                (unit.unit_id.clone(), agent.to_string()),
                PairDisk {
                    disk,
                    entry_name: entry.to_string(),
                    mode,
                    verified_at: now.clone(),
                },
            );
        }
    }
    let mut updated = 0;
    for ((unit, agent), pair) in &pairs {
        let (target_path, hash, code, error) = match &pair.disk {
            DiskState::Ours { hash, target, .. } => {
                (target.display().to_string(), hash.clone(), "", "")
            }
            DiskState::Conflict { path, .. } => (
                path.display().to_string(),
                String::new(),
                "TARGET_CONFLICT",
                "AI 工具里已有同名的个人技能，SkillHub 没有覆盖它。",
            ),
            DiskState::Absent => (String::new(), String::new(), "", ""),
        };
        let mode = if pair.disk.is_ours() {
            pair.mode
        } else {
            "none"
        };
        updated += connection
            .execute(
                "UPDATE agent_skill_targets SET
                    status = ?3, mode = ?4, entry_name = ?5, target_path = ?6,
                    content_hash = ?7, error_code = ?8, last_error = ?9, verified_at = ?10
                 WHERE source_id = ?1 AND agent_id = ?2",
                params![
                    unit,
                    agent,
                    pair.disk.label(),
                    mode,
                    pair.entry_name,
                    target_path,
                    hash,
                    code,
                    error,
                    now
                ],
            )
            .map_err(|error| format!("Cannot store read-back: {error}"))?;
    }
    // A unit that disappeared and has nothing left on disk loses its rows.
    let unit_ids = units
        .iter()
        .map(|unit| unit.unit_id.as_str())
        .collect::<BTreeSet<_>>();
    let stale = read_targets(connection)?
        .into_keys()
        .filter(|(unit, _)| !unit_ids.contains(unit.as_str()))
        .collect::<Vec<_>>();
    for (unit, agent) in stale {
        if unit_exists(connection, &unit)? {
            continue;
        }
        connection
            .execute(
                "DELETE FROM agent_skill_targets WHERE source_id = ?1 AND agent_id = ?2",
                params![unit, agent],
            )
            .map_err(|error| format!("Cannot drop stale target: {error}"))?;
    }
    write_pref(connection, PREF_LAST_READBACK, &now)?;
    if let Ok(mut cache) = readback_cache().lock() {
        *cache = pairs;
    }
    Ok(updated)
}

/// Unmanaged skills seen in each tool's folder at the last inventory
/// (`AgentSkillCounts.personal`); absent until `list_agent_skills` ran.
static PERSONAL_COUNTS: OnceLock<Mutex<BTreeMap<String, usize>>> = OnceLock::new();

pub(crate) fn set_personal_count(agent_id: &str, count: usize) {
    if let Ok(mut counts) = PERSONAL_COUNTS
        .get_or_init(|| Mutex::new(BTreeMap::new()))
        .lock()
    {
        counts.insert(agent_id.to_string(), count);
    }
}

pub(crate) fn personal_counts() -> BTreeMap<String, usize> {
    PERSONAL_COUNTS
        .get_or_init(|| Mutex::new(BTreeMap::new()))
        .lock()
        .map(|counts| counts.clone())
        .unwrap_or_default()
}

pub(crate) fn cached_pair(unit_id: &str, agent_id: &str) -> Option<PairDisk> {
    readback_cache().lock().ok().and_then(|cache| {
        cache
            .get(&(unit_id.to_string(), agent_id.to_string()))
            .cloned()
    })
}

// ---------------------------------------------------------------------------
// DTOs (§4.3 / §4.4)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeliveryUnitDto {
    pub unit_id: String,
    pub kind: String,
    pub source_id: String,
    pub skill_id: String,
    pub entry_name: String,
    pub callable_skills: usize,
    pub library_enabled: bool,
    pub library_only_reason: String,
}

impl From<&UnitInfo> for DeliveryUnitDto {
    fn from(unit: &UnitInfo) -> Self {
        Self {
            unit_id: unit.unit_id.clone(),
            kind: unit.kind.to_string(),
            source_id: unit.source_id.clone(),
            skill_id: unit.skill_id.clone(),
            entry_name: unit.entry_name().to_string(),
            callable_skills: unit.callable_skills,
            library_enabled: unit.library_enabled,
            library_only_reason: unit.library_only_reason.to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SkillTargetConflict {
    pub kind: String,
    pub same_content: bool,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SkillTarget {
    pub unit_id: String,
    pub agent_id: String,
    pub desired: bool,
    pub status: String,
    pub mode: String,
    pub entry_name: String,
    pub target_path: String,
    pub content_hash: String,
    pub verified_at: String,
    pub updated_at: String,
    pub error: Option<SkillHubError>,
    pub conflict: Option<SkillTargetConflict>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SkillTargetKey {
    pub unit_id: String,
    pub agent_id: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentSkillCounts {
    pub packs_synced: usize,
    pub skills_synced: usize,
    pub packs_wanted: usize,
    pub problems: usize,
    pub personal: Option<usize>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SkillAgent {
    pub id: String,
    pub name: String,
    pub vendor: String,
    pub installed: bool,
    pub can_deliver: bool,
    pub experimental: bool,
    pub experimental_reason: String,
    pub unsupported_reason: String,
    pub takeover: bool,
    pub status_word: String,
    pub health: String,
    pub skills_path: String,
    pub linked_agent_ids: Vec<String>,
    pub shared_folder_note: String,
    pub after_sync_hint: String,
    pub counts: AgentSkillCounts,
    pub last_result: Option<AgentDeliveryResult>,
    pub doctor_verdict: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeliveryProblem {
    pub id: String,
    pub code: String,
    pub message: String,
    pub agent_id: Option<String>,
    pub unit_id: Option<String>,
    pub action: Option<crate::skillhub_error::ErrorAction>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SkillDeliveryState {
    pub paused: bool,
    pub onboarding: String,
    pub agents: Vec<SkillAgent>,
    pub units: Vec<DeliveryUnitDto>,
    pub targets: Vec<SkillTarget>,
    pub problems: Vec<DeliveryProblem>,
    pub job: Option<crate::delivery_queue::DeliveryJobStatus>,
    pub generated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SkillAgentList {
    pub agents: Vec<SkillAgent>,
    pub paused: bool,
    pub onboarding: String,
    pub generated_at: String,
}

/// Inputs the state builder needs besides SQLite.
pub(crate) struct StateInputs<'a> {
    pub units: &'a [UnitInfo],
    pub evidence: &'a Evidence,
    /// Adapter detection for tools SkillHub cannot write (status word only).
    pub detected_unsupported: &'a BTreeSet<String>,
    pub doctor_verdicts: &'a BTreeMap<String, String>,
    pub personal_counts: &'a BTreeMap<String, usize>,
    pub job_active: bool,
    pub job_agents: &'a BTreeSet<String>,
}

fn nanos(value: &str) -> u128 {
    value.trim().parse::<u128>().unwrap_or(0)
}

/// `YYYY-MM-DDTHH:MM:SSZ` from a stored unix-nanosecond string.
pub(crate) fn iso_from_nanos(value: &str) -> String {
    let nanos = nanos(value);
    if nanos == 0 {
        return String::new();
    }
    iso_from_seconds((nanos / 1_000_000_000) as u64)
}

pub(crate) fn iso_from_seconds(seconds: u64) -> String {
    let days = (seconds / 86_400) as i64;
    let rest = seconds % 86_400;
    let (year, month, day) = super::civil_date_from_unix_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rest / 3_600,
        (rest % 3_600) / 60,
        rest % 60
    )
}

pub(crate) fn iso_now() -> String {
    iso_from_nanos(&unix_timestamp_string())
}

fn target_error(
    code: Option<&str>,
    agent_id: &str,
    unit_id: &str,
    path: &str,
) -> Option<SkillHubError> {
    let code = code?;
    let mut error = SkillHubError::code(code).with_agent(agent_id);
    if !unit_id.starts_with(STANDALONE_PREFIX) {
        error = error.with_source(unit_id);
    }
    if !path.is_empty() {
        error = error.with_path(path.to_string());
    }
    if code == "DELIVERY_VERIFY_FAILED" {
        error = error.with_action("retry", &[("agentId", agent_id), ("unitId", unit_id)]);
    }
    if code == "TARGET_CONFLICT" {
        error = error.with_action(
            "resolve-conflict",
            &[("agentId", agent_id), ("unitId", unit_id)],
        );
    }
    Some(error)
}

/// Builds the full delivery state from SQLite, the last read-back and cached
/// evidence. Performs no read-back of its own.
pub(crate) fn build_state(
    connection: &Connection,
    inputs: &StateInputs<'_>,
    job: Option<crate::delivery_queue::DeliveryJobStatus>,
) -> Result<SkillDeliveryState, String> {
    let paused = is_paused(connection)?;
    let onboarding = onboarding_status(connection)?;
    let writes_blocked = paused || onboarding == "pending";
    let takeover = read_takeover(connection)?;
    let targets_db = read_targets(connection)?;
    let last_readback = read_pref(connection, PREF_LAST_READBACK)?.unwrap_or_default();
    let evidence = inputs.evidence;
    let unit_map = inputs
        .units
        .iter()
        .map(|unit| (unit.unit_id.as_str(), unit))
        .collect::<BTreeMap<_, _>>();

    let mut targets = Vec::new();
    for agent in DELIVERABLE_AGENTS {
        if !evidence.can_deliver(agent) {
            continue;
        }
        let agent_takeover = takeover.get(*agent);
        let takeover_on = agent_takeover.is_some_and(|row| row.enabled);
        let takeover_changed = agent_takeover
            .map(|row| row.updated_at.as_str())
            .unwrap_or("");
        let installed = evidence.installed(agent);
        // A prompt-only pack has no entry and therefore no icon row.
        for unit in inputs.units.iter().filter(|unit| !unit.entries.is_empty()) {
            let key = (unit.unit_id.clone(), agent.to_string());
            let row = targets_db.get(&key);
            let cached = cached_pair(&unit.unit_id, agent);
            let disk = match (&cached, row) {
                (Some(pair), _) => pair.disk.clone(),
                (None, Some(row)) => disk_from_row(row),
                (None, None) => DiskState::Absent,
            };
            if !takeover_on && !disk.is_ours() {
                continue;
            }
            let desired = match row {
                Some(row) => row.enabled,
                None => takeover_on && pair_desired(unit, None),
            };
            let changed_at = nanos(row.map(|row| row.updated_at.as_str()).unwrap_or(""))
                .max(nanos(takeover_changed));
            let verified_at = cached
                .as_ref()
                .map(|pair| pair.verified_at.clone())
                .or_else(|| row.map(|row| row.verified_at.clone()))
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| last_readback.clone());
            let (status, code) = resolve_status(StatusInput {
                desired,
                disk: &disk,
                installed,
                takeover: takeover_on,
                library_enabled: unit.library_enabled,
                writes_blocked,
                job_active: inputs.job_active,
                verified_after_change: nanos(&verified_at) >= changed_at,
            });
            let (target_path, hash, conflict) = match &disk {
                DiskState::Ours { hash, target, .. } => {
                    (target.display().to_string(), hash.clone(), None)
                }
                DiskState::Conflict {
                    kind,
                    same_content,
                    path,
                } => (
                    path.display().to_string(),
                    String::new(),
                    Some(SkillTargetConflict {
                        kind: kind.to_string(),
                        same_content: *same_content,
                        path: path.display().to_string(),
                    }),
                ),
                DiskState::Absent => (String::new(), String::new(), None),
            };
            let mode = if disk.is_ours() {
                if evidence.real_shared && matches!(*agent, "codex" | "coze") {
                    "shared-real"
                } else {
                    "link"
                }
            } else {
                "none"
            };
            targets.push(SkillTarget {
                unit_id: unit.unit_id.clone(),
                agent_id: agent.to_string(),
                desired,
                status: status.to_string(),
                mode: mode.to_string(),
                entry_name: unit.entry_name().to_string(),
                target_path: target_path.clone(),
                content_hash: hash,
                verified_at: iso_from_nanos(&verified_at),
                updated_at: iso_from_nanos(row.map(|row| row.updated_at.as_str()).unwrap_or("")),
                error: target_error(code, agent, &unit.unit_id, &target_path),
                conflict: if status == "conflict" { conflict } else { None },
            });
        }
    }

    let mut problems = Vec::new();
    for target in &targets {
        if !matches!(target.status.as_str(), "error" | "conflict" | "orphan") {
            continue;
        }
        let (code, message, action) = match target.status.as_str() {
            "orphan" => (
                "AGENT_NOT_INSTALLED".to_string(),
                format!(
                    "{} 已不在这台电脑上，但入口还在",
                    agent_spec(&target.agent_id)
                        .map(|spec| spec.name)
                        .unwrap_or("AI 工具")
                ),
                None,
            ),
            _ => {
                let error = target
                    .error
                    .clone()
                    .unwrap_or_else(|| SkillHubError::code("DELIVERY_VERIFY_FAILED"));
                (
                    error.code.clone(),
                    error.message.clone(),
                    error.action.clone(),
                )
            }
        };
        problems.push(DeliveryProblem {
            id: format!("target:{}:{}", target.unit_id, target.agent_id),
            code,
            message,
            agent_id: Some(target.agent_id.clone()),
            unit_id: Some(target.unit_id.clone()),
            action,
        });
    }
    for (agent, row) in &takeover {
        if row.last_outcome == "failed" && row.enabled {
            problems.push(DeliveryProblem {
                id: format!("agent:{agent}"),
                code: if row.last_error_code.is_empty() {
                    "SCRIPT_FAILED".to_string()
                } else {
                    row.last_error_code.clone()
                },
                message: if row.last_error.is_empty() {
                    "同步到这个 AI 工具没有完成。".to_string()
                } else {
                    row.last_error.clone()
                },
                agent_id: Some(agent.clone()),
                unit_id: None,
                action: Some(crate::skillhub_error::ErrorAction {
                    kind: "retry".to_string(),
                    payload: BTreeMap::from([("agentId".to_string(), agent.clone())]),
                }),
            });
        }
    }

    let agents = build_agents(&takeover, &targets, &unit_map, inputs);
    Ok(SkillDeliveryState {
        paused,
        onboarding: onboarding.to_string(),
        agents,
        units: inputs.units.iter().map(DeliveryUnitDto::from).collect(),
        targets,
        problems,
        job,
        generated_at: iso_now(),
    })
}

fn disk_from_row(row: &TargetRow) -> DiskState {
    match row.status.as_str() {
        "synced" => DiskState::Ours {
            manifest_ok: true,
            hash: row.content_hash.clone(),
            target: PathBuf::from(&row.target_path),
        },
        "error" if row.mode != "none" => DiskState::Ours {
            manifest_ok: false,
            hash: row.content_hash.clone(),
            target: PathBuf::from(&row.target_path),
        },
        "conflict" => DiskState::Conflict {
            kind: "personal-folder",
            same_content: false,
            path: PathBuf::from(&row.target_path),
        },
        _ => DiskState::Absent,
    }
}

pub(crate) fn build_agents(
    takeover: &BTreeMap<String, TakeoverRow>,
    targets: &[SkillTarget],
    unit_map: &BTreeMap<&str, &UnitInfo>,
    inputs: &StateInputs<'_>,
) -> Vec<SkillAgent> {
    let evidence = inputs.evidence;
    let mut agents = AGENT_SPECS
        .iter()
        .enumerate()
        .map(|(order, spec)| {
            let can_deliver = spec.deliverable && evidence.can_deliver(spec.id);
            let installed = if spec.deliverable {
                evidence.installed(spec.id)
            } else {
                inputs.detected_unsupported.contains(spec.id)
            };
            let takeover_on = can_deliver && takeover_enabled(takeover, spec.id);
            let status_word = if takeover_on {
                "taken-over"
            } else if can_deliver && installed {
                "available"
            } else if installed && !can_deliver {
                "unsupported"
            } else {
                "not-installed"
            };
            let agent_targets = targets
                .iter()
                .filter(|target| target.agent_id == spec.id)
                .collect::<Vec<_>>();
            let synced = agent_targets
                .iter()
                .filter(|target| target.status == "synced")
                .collect::<Vec<_>>();
            let problems = agent_targets
                .iter()
                .filter(|target| matches!(target.status.as_str(), "error" | "conflict" | "orphan"))
                .count();
            let row = takeover.get(spec.id);
            let last_result =
                row.filter(|row| !row.last_outcome.is_empty())
                    .map(|row| AgentDeliveryResult {
                        agent_id: spec.id.to_string(),
                        outcome: row.last_outcome.clone(),
                        linked: 0,
                        removed: 0,
                        unchanged: 0,
                        conflicts: 0,
                        errors: usize::from(row.last_outcome == "failed"),
                        error: (!row.last_error_code.is_empty()).then(|| {
                            SkillHubError::new(&row.last_error_code, row.last_error.clone())
                                .with_agent(spec.id)
                        }),
                        finished_at: iso_from_nanos(&row.last_delivered_at),
                    });
            let busy = inputs.job_active
                && (inputs.job_agents.contains(spec.id)
                    || agent_targets
                        .iter()
                        .any(|target| matches!(target.status.as_str(), "pending" | "removing")));
            let failed = last_result
                .as_ref()
                .is_some_and(|result| result.outcome == "failed");
            let health = if !takeover_on {
                "off"
            } else if busy {
                "busy"
            } else if problems > 0 || failed {
                "problem"
            } else {
                "ok"
            };
            let linked = if can_deliver {
                linked_agent_ids(spec.id, evidence.real_shared)
            } else {
                Vec::new()
            };
            let shared_folder_note = match (spec.id, linked.is_empty()) {
                ("codex", false) => "与 扣子 共用目录",
                ("coze", false) => "与 Codex 共用目录",
                _ => "",
            };
            let skills_path = evidence
                .path(spec.id)
                .map(|path| path.display().to_string())
                .unwrap_or_default();
            let after_sync_hint = if takeover_on
                && last_result
                    .as_ref()
                    .is_some_and(|result| matches!(result.outcome.as_str(), "ok" | "partial"))
            {
                spec.after_sync_hint
            } else {
                ""
            };
            (
                order,
                SkillAgent {
                    id: spec.id.to_string(),
                    name: spec.name.to_string(),
                    vendor: spec.vendor.to_string(),
                    installed,
                    can_deliver,
                    experimental: spec.experimental,
                    experimental_reason: experimental_reason(spec),
                    unsupported_reason: if can_deliver {
                        String::new()
                    } else if spec.deliverable {
                        "需要先安装扣子才能共用这个目录".to_string()
                    } else {
                        spec.unsupported_reason.to_string()
                    },
                    takeover: takeover_on,
                    status_word: status_word.to_string(),
                    health: health.to_string(),
                    skills_path,
                    linked_agent_ids: linked,
                    shared_folder_note: shared_folder_note.to_string(),
                    after_sync_hint: after_sync_hint.to_string(),
                    counts: AgentSkillCounts {
                        packs_synced: synced.len(),
                        skills_synced: synced
                            .iter()
                            .map(|target| {
                                unit_map
                                    .get(target.unit_id.as_str())
                                    .map(|unit| unit.callable_skills)
                                    .unwrap_or(0)
                            })
                            .sum(),
                        packs_wanted: agent_targets.iter().filter(|target| target.desired).count(),
                        problems,
                        personal: inputs.personal_counts.get(spec.id).copied(),
                    },
                    last_result,
                    doctor_verdict: inputs
                        .doctor_verdicts
                        .get(spec.id)
                        .cloned()
                        .unwrap_or_default(),
                },
            )
        })
        .collect::<Vec<_>>();
    let rank = |word: &str| match word {
        "taken-over" => 0,
        "available" => 1,
        "unsupported" => 2,
        _ => 3,
    };
    agents.sort_by_key(|(order, agent)| (rank(&agent.status_word), *order));
    agents.into_iter().map(|(_, agent)| agent).collect()
}

/// Targets of the given pairs from a freshly built state.
pub(crate) fn pick_targets(
    state: &SkillDeliveryState,
    keys: &[(String, String)],
) -> Vec<SkillTarget> {
    state
        .targets
        .iter()
        .filter(|target| {
            keys.iter()
                .any(|(unit, agent)| &target.unit_id == unit && &target.agent_id == agent)
        })
        .cloned()
        .collect()
}

// ---------------------------------------------------------------------------
// Mutations (SQL only, < 300 ms)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TargetChangeInput {
    pub unit_id: String,
    pub agent_id: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TargetRejection {
    pub unit_id: String,
    pub agent_id: String,
    pub error: SkillHubError,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct TargetMutation {
    pub changed: usize,
    pub unchanged: usize,
    pub rejected: Vec<TargetRejection>,
    pub keys: Vec<(String, String)>,
}

/// Validates and applies one target change, writing both rows of the
/// Codex/Coze group in shared mode (I-9).
pub(crate) fn apply_target_change(
    connection: &Connection,
    change: &TargetChangeInput,
    evidence: &Evidence,
    takeover: &BTreeMap<String, TakeoverRow>,
    mutation: &mut TargetMutation,
) -> Result<(), String> {
    let reject = |mutation: &mut TargetMutation, error: SkillHubError| {
        mutation.rejected.push(TargetRejection {
            unit_id: change.unit_id.clone(),
            agent_id: change.agent_id.clone(),
            error,
        });
    };
    let Some(spec) = agent_spec(&change.agent_id) else {
        reject(
            mutation,
            SkillHubError::code("AGENT_UNKNOWN").with_agent(&change.agent_id),
        );
        return Ok(());
    };
    if !spec.deliverable || !evidence.can_deliver(spec.id) {
        reject(
            mutation,
            SkillHubError::code("AGENT_UNSUPPORTED").with_agent(spec.id),
        );
        return Ok(());
    }
    if !unit_exists(connection, &change.unit_id)? {
        reject(
            mutation,
            SkillHubError::code("UNIT_NOT_FOUND").with_source(&change.unit_id),
        );
        return Ok(());
    }
    if change.enabled {
        if !takeover_enabled(takeover, spec.id) {
            reject(
                mutation,
                SkillHubError::code("AGENT_NOT_TAKEN_OVER")
                    .with_agent(spec.id)
                    .with_action("takeover-agent", &[("agentId", spec.id)]),
            );
            return Ok(());
        }
        let reason = unit_library_reason(connection, &change.unit_id)?;
        if !reason.is_empty() {
            let mut error = SkillHubError::code("SOURCE_LIBRARY_ONLY")
                .with_detail(reason)
                .without_action();
            if !change.unit_id.starts_with(STANDALONE_PREFIX) {
                error = error.with_source(&change.unit_id);
            }
            if reason == "security-review" {
                error = error.with_action("review-security", &[("sourceId", &change.unit_id)]);
            }
            reject(mutation, error);
            return Ok(());
        }
    }
    let mut any_changed = false;
    for agent in agent_group(spec.id, evidence.real_shared) {
        if upsert_target(connection, &change.unit_id, agent, change.enabled, "user")? {
            any_changed = true;
        }
        mutation
            .keys
            .push((change.unit_id.clone(), agent.to_string()));
    }
    if any_changed {
        mutation.changed += 1;
    } else {
        mutation.unchanged += 1;
    }
    Ok(())
}

/// Turns takeover on or off for an agent and its group. Returns the agents
/// written and the number of target rows created by the 0 -> 1 fill.
pub(crate) fn apply_takeover(
    connection: &mut Connection,
    agent_id: &str,
    enabled: bool,
    fill_targets: bool,
    origin: &str,
    evidence: &Evidence,
) -> Result<(Vec<&'static str>, usize), SkillHubError> {
    let Some(spec) = agent_spec(agent_id) else {
        return Err(SkillHubError::code("AGENT_UNKNOWN").with_agent(agent_id));
    };
    if !spec.deliverable || !evidence.can_deliver(spec.id) {
        return Err(SkillHubError::code("AGENT_UNSUPPORTED").with_agent(spec.id));
    }
    let group = agent_group(spec.id, evidence.real_shared);
    if enabled && !group.iter().any(|agent| evidence.installed(agent)) {
        return Err(SkillHubError::code("AGENT_NOT_INSTALLED").with_agent(spec.id));
    }
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| SkillHubError::from(format!("Cannot start takeover change: {error}")))?;
    let mut switched_on = Vec::new();
    for agent in &group {
        if upsert_takeover(&transaction, agent, enabled, origin).map_err(SkillHubError::from)?
            && enabled
        {
            switched_on.push(*agent);
        }
    }
    let created = if enabled && fill_targets && !switched_on.is_empty() {
        fill_targets_for_agents(&transaction, &switched_on).map_err(SkillHubError::from)?
    } else {
        0
    };
    transaction
        .commit()
        .map_err(|error| SkillHubError::from(format!("Cannot commit takeover change: {error}")))?;
    Ok((group, created))
}

pub(crate) fn set_paused(connection: &Connection, paused: bool) -> Result<(), String> {
    write_pref(connection, PREF_PAUSED, if paused { "1" } else { "0" })
}

pub(crate) fn complete_onboarding_state(connection: &Connection) -> Result<(), String> {
    write_pref(connection, PREF_ONBOARDING, "completed")?;
    write_pref(connection, PREF_ONBOARDING_AT, &iso_now())
}

/// Writes `source_overrides.enabled` and, for an enable of a flagged pack,
/// records the confirmed review (I-5). The caller checks the confirmation.
pub(crate) fn set_source_library_enabled_rows(
    connection: &Connection,
    source_id: &str,
    enabled: bool,
    review_confirmed: bool,
) -> Result<(), String> {
    let now = unix_timestamp_string();
    connection
        .execute(
            "INSERT INTO source_overrides
                (source_id, display_name, source_type, category_id, note, enabled, updated_at)
             VALUES (?1, '', '', '', '', ?2, ?3)
             ON CONFLICT(source_id) DO UPDATE SET enabled = excluded.enabled,
                updated_at = excluded.updated_at",
            params![source_id, i64::from(enabled), now],
        )
        .map_err(|error| format!("Cannot save pack state: {error}"))?;
    if enabled && review_confirmed {
        connection
            .execute(
                "UPDATE source_security_state SET review_confirmed_at = ?2 WHERE source_id = ?1",
                params![source_id, now],
            )
            .map_err(|error| format!("Cannot record security review: {error}"))?;
    }
    Ok(())
}

/// `(scan_status, findings summary)` of a pack still waiting for a review.
pub(crate) fn pending_security_review(
    connection: &Connection,
    source_id: &str,
) -> Result<Option<(String, String)>, String> {
    connection
        .query_row(
            "SELECT scan_status, high_findings, medium_findings, scanned_files
             FROM source_security_state
             WHERE source_id = ?1 AND scan_status IN ('review', 'blocked')
               AND COALESCE(review_confirmed_at, '') = ''",
            params![source_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            },
        )
        .optional()
        .map(|row| {
            row.map(|(status, high, medium, scanned)| {
                (
                    status,
                    format!(
                        "检查了 {scanned} 个文件，发现 {} 处需要注意（不会被执行）",
                        high + medium
                    ),
                )
            })
        })
        .map_err(|error| format!("Cannot read security review state: {error}"))
}

/// Prefix of the folders SkillHub 3.1/3.2 made when it replaced an entry during a takeover.
const TAKEOVER_BACKUP_PREFIX: &str = "AI_global接管前备份_";

/// SkillHub 3.1/3.2 put its takeover backups *inside* the skills folder
/// (`<skills>/AI_global接管前备份_YYYYMMDD_HHMMSS/<skill>/SKILL.md`). AI tools look one
/// level down, so Codex listed every skill once more per backup. Such folders (exactly
/// that name, a real directory, never a link) are moved next to the skills folder, into
/// `<parent>/AI_global接管前备份/<skills folder>_<stamp>`. Nothing is deleted; a backup
/// whose destination already exists is left where it is.
pub(crate) fn relocate_takeover_backups(skills_root: &Path) -> Vec<PathBuf> {
    let mut moved = Vec::new();
    let (Some(parent), Some(leaf)) = (skills_root.parent(), skills_root.file_name()) else {
        return moved;
    };
    if crate::external_skills::is_link(skills_root) {
        return moved;
    }
    let Ok(entries) = fs::read_dir(skills_root) else {
        return moved;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let Some(stamp) = name.strip_prefix(TAKEOVER_BACKUP_PREFIX) else {
            continue;
        };
        let bytes = stamp.as_bytes();
        let stamp_ok = bytes.len() == 15
            && bytes[8] == b'_'
            && bytes
                .iter()
                .enumerate()
                .all(|(index, byte)| index == 8 || byte.is_ascii_digit());
        let path = entry.path();
        if !stamp_ok || crate::external_skills::is_link(&path) || !path.is_dir() {
            continue;
        }
        let destination = parent
            .join("AI_global接管前备份")
            .join(format!("{}_{stamp}", leaf.to_string_lossy()));
        if destination.exists() || fs::create_dir_all(parent.join("AI_global接管前备份")).is_err()
        {
            continue;
        }
        if fs::rename(&path, &destination).is_ok() {
            moved.push(destination);
        }
    }
    moved
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn takeover_backups_move_out_of_the_skills_folder_and_nothing_else_does() {
        let base = std::env::temp_dir().join(format!("skillhub-takeover-{}", uuid::Uuid::new_v4()));
        let skills = base.join(".agents").join("skills");
        let backup = skills.join("AI_global接管前备份_20261009_024300");
        fs::create_dir_all(backup.join("nature-skills--yuan1z0825")).unwrap();
        fs::write(
            backup.join("nature-skills--yuan1z0825/SKILL.md"),
            "---\nname: x\n---",
        )
        .unwrap();
        // Look-alikes and personal folders stay.
        for keep in [
            "AI_global接管前备份_notes",
            "AI_global接管前备份_2026100_024300",
            "my-skill",
        ] {
            fs::create_dir_all(skills.join(keep)).unwrap();
        }
        let moved = relocate_takeover_backups(&skills);
        let expected = base.join(".agents/AI_global接管前备份/skills_20261009_024300");
        assert_eq!(moved, vec![expected.clone()]);
        assert!(expected
            .join("nature-skills--yuan1z0825/SKILL.md")
            .is_file());
        assert!(!backup.exists());
        for keep in [
            "AI_global接管前备份_notes",
            "AI_global接管前备份_2026100_024300",
            "my-skill",
        ] {
            assert!(skills.join(keep).is_dir(), "{keep} stays");
        }
        // A second backup with the same stamp is not merged into the first.
        fs::create_dir_all(&backup).unwrap();
        assert!(relocate_takeover_backups(&skills).is_empty());
        assert!(backup.is_dir());
        fs::remove_dir_all(base).unwrap();
    }

    fn memory_db() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(include_str!("../migrations/001_initial.sql"))
            .unwrap();
        connection
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS operator_preferences (
                    key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL);
                 ALTER TABLE skills ADD COLUMN is_router_hub INTEGER NOT NULL DEFAULT 0;",
            )
            .unwrap();
        crate::source_governance::ensure_schema(&connection).unwrap();
        ensure_schema(&connection).unwrap();
        connection
    }

    fn add_source(connection: &Connection, id: &str, enabled: bool) {
        connection
            .execute(
                "INSERT INTO sources (id, name, source_type, url, local_path, install_mode,
                    category_id, note, enabled, created_at, updated_at)
                 VALUES (?1, ?1, 'skill', '', '', 'scan', 'auto', '', ?2, '1', '1')",
                params![id, i64::from(enabled)],
            )
            .unwrap();
    }

    fn add_skill(connection: &Connection, id: &str, source: &str) {
        let source = (!source.is_empty()).then_some(source);
        connection
            .execute(
                "INSERT INTO skills (id, source_id, name, folder_name, description, category_id,
                    health_status, health_summary, enabled, relative_path, created_at, updated_at)
                 VALUES (?1, ?2, ?1, ?1, 'd', 'auto', 'ok', '', 1, ?1, '1', '1')",
                params![id, source],
            )
            .unwrap();
    }

    fn count(connection: &Connection, sql: &str) -> i64 {
        connection.query_row(sql, [], |row| row.get(0)).unwrap()
    }

    #[test]
    fn migration_existing_user_takes_over_tools_with_entries_once() {
        let mut connection = memory_db();
        add_source(&connection, "pack-on", true);
        add_skill(&connection, "on-1", "pack-on");
        add_source(&connection, "pack-off", false);
        add_skill(&connection, "off-1", "pack-off");
        add_skill(&connection, "local-skill", "");
        let has = BTreeSet::from(["claude", "codex", "coze"]);
        let report = migrate_v33_delivery_state(&mut connection, &has, "").unwrap();
        assert!(report.ran);
        assert_eq!(report.onboarding, "completed");
        let takeover = read_takeover(&connection).unwrap();
        for agent in ["claude", "codex", "coze"] {
            assert!(takeover_enabled(&takeover, agent), "{agent}");
        }
        for agent in ["workbuddy", "antigravity", "cursor", "gemini-cli"] {
            assert!(!takeover_enabled(&takeover, agent), "{agent}");
        }
        assert_eq!(
            count(
                &connection,
                "SELECT COUNT(*) FROM agent_skill_targets WHERE source_id = 'pack-on'"
            ),
            3
        );
        assert_eq!(
            count(
                &connection,
                "SELECT COUNT(*) FROM agent_skill_targets WHERE source_id = 'pack-off'"
            ),
            0
        );
        assert_eq!(
            count(
                &connection,
                "SELECT COUNT(*) FROM agent_skill_targets WHERE source_id = 'standalone:local-skill'"
            ),
            3
        );
        let second = migrate_v33_delivery_state(&mut connection, &BTreeSet::new(), "").unwrap();
        assert!(!second.ran);
        assert_eq!(
            count(&connection, "SELECT COUNT(*) FROM agent_skill_targets"),
            6
        );
        assert!(!delivery_writes_blocked(&connection).unwrap());
    }

    #[test]
    fn migration_fresh_install_is_pending_and_gates_writes() {
        let mut connection = memory_db();
        add_source(&connection, "pack-on", true);
        let report = migrate_v33_delivery_state(&mut connection, &BTreeSet::new(), "").unwrap();
        assert_eq!(report.onboarding, "pending");
        assert_eq!(
            count(&connection, "SELECT COUNT(*) FROM agent_skill_targets"),
            0
        );
        assert_eq!(
            count(
                &connection,
                "SELECT COUNT(*) FROM agent_takeover WHERE enabled = 1"
            ),
            0
        );
        assert!(delivery_writes_blocked(&connection).unwrap());
        complete_onboarding_state(&connection).unwrap();
        assert!(!delivery_writes_blocked(&connection).unwrap());
        set_paused(&connection, true).unwrap();
        assert!(delivery_writes_blocked(&connection).unwrap());
    }

    #[test]
    fn migration_keeps_flagged_packs_the_user_already_enabled() {
        let mut connection = memory_db();
        add_source(&connection, "pack-enabled-flagged", true);
        add_skill(&connection, "e1", "pack-enabled-flagged");
        add_source(&connection, "pack-library-only", true);
        add_skill(&connection, "l1", "pack-library-only");
        connection
            .execute_batch(
                "INSERT INTO source_overrides (source_id, enabled, updated_at)
                    VALUES ('pack-library-only', 0, '1');
                 INSERT INTO source_security_state (source_id, scan_status)
                    VALUES ('pack-enabled-flagged', 'review'), ('pack-library-only', 'review');",
            )
            .unwrap();
        migrate_v33_delivery_state(&mut connection, &BTreeSet::from(["claude"]), "").unwrap();
        assert_eq!(
            unit_library_reason(&connection, "pack-enabled-flagged").unwrap(),
            ""
        );
        assert_eq!(
            unit_library_reason(&connection, "pack-library-only").unwrap(),
            "security-review"
        );
        assert!(pending_security_review(&connection, "pack-library-only")
            .unwrap()
            .is_some());
    }

    #[test]
    fn migration_with_stored_fingerprint_counts_as_existing_user() {
        let mut connection = memory_db();
        let report = migrate_v33_delivery_state(&mut connection, &BTreeSet::new(), "abc").unwrap();
        assert_eq!(report.onboarding, "completed");
    }

    #[test]
    fn prompt_sources_get_no_targets_and_stale_rows_are_pruned() {
        let mut connection = memory_db();
        add_source(&connection, "pack-a", true);
        add_skill(&connection, "a1", "pack-a");
        // A Prompt source: enabled, but it has no skills to deliver.
        add_source(&connection, "prompts", true);
        migrate_v33_delivery_state(&mut connection, &BTreeSet::from(["claude"]), "").unwrap();
        let targets = read_targets(&connection).unwrap();
        assert!(targets.contains_key(&("pack-a".to_string(), "claude".to_string())));
        assert!(!targets.contains_key(&("prompts".to_string(), "claude".to_string())));

        // Rows the first 3.3.0 migration created for such sources are pruned;
        // an explicit user row is kept.
        add_source(&connection, "notes", true);
        connection
            .execute(
                "INSERT INTO agent_skill_targets (source_id, agent_id, enabled, origin, status, updated_at)
                 VALUES ('prompts', 'claude', 1, 'migration', 'pending', '1'),
                        ('notes', 'claude', 1, 'user', 'pending', '1')",
                [],
            )
            .unwrap();
        materialize_defaults(&connection).unwrap();
        let targets = read_targets(&connection).unwrap();
        assert!(!targets.contains_key(&("prompts".to_string(), "claude".to_string())));
        assert!(targets.contains_key(&("notes".to_string(), "claude".to_string())));
        assert!(targets.contains_key(&("pack-a".to_string(), "claude".to_string())));
    }

    #[test]
    fn materialization_fills_only_units_without_rows() {
        let mut connection = memory_db();
        add_source(&connection, "pack-a", true);
        add_skill(&connection, "a1", "pack-a");
        add_source(&connection, "pack-b", true);
        add_skill(&connection, "b1", "pack-b");
        migrate_v33_delivery_state(&mut connection, &BTreeSet::from(["claude"]), "").unwrap();
        // The user explicitly turned pack-a off for Claude.
        upsert_target(&connection, "pack-a", "claude", false, "user").unwrap();
        connection
            .execute(
                "DELETE FROM agent_skill_targets WHERE source_id = 'pack-b'",
                [],
            )
            .unwrap();
        add_source(&connection, "pack-c", true);
        add_skill(&connection, "c1", "pack-c");
        add_source(&connection, "pack-flagged", true);
        add_skill(&connection, "f1", "pack-flagged");
        connection
            .execute(
                "INSERT INTO source_security_state (source_id, scan_status) VALUES ('pack-flagged', 'review')",
                [],
            )
            .unwrap();
        let created = materialize_defaults(&connection).unwrap();
        assert_eq!(created, 2, "pack-b and pack-c");
        let targets = read_targets(&connection).unwrap();
        assert!(!targets[&("pack-a".to_string(), "claude".to_string())].enabled);
        assert!(targets[&("pack-c".to_string(), "claude".to_string())].enabled);
        assert!(!targets.contains_key(&("pack-flagged".to_string(), "claude".to_string())));
        assert_eq!(
            unit_library_reason(&connection, "pack-flagged").unwrap(),
            "security-review"
        );
        set_source_library_enabled_rows(&connection, "pack-flagged", true, true).unwrap();
        assert_eq!(
            unit_library_reason(&connection, "pack-flagged").unwrap(),
            ""
        );
    }

    fn evidence(real_shared: bool) -> Evidence {
        let mut evidence = Evidence {
            real_shared,
            ..Evidence::default()
        };
        for agent in DELIVERABLE_AGENTS {
            evidence.installed.insert(agent, *agent != "gemini-cli");
            evidence
                .paths
                .insert(agent, PathBuf::from(format!("C:/home/{agent}")));
        }
        evidence
            .paths
            .insert("coze", PathBuf::from("C:/home/.agents/skills"));
        evidence
            .paths
            .insert("codex", PathBuf::from("C:/home/.agents/skills"));
        evidence
    }

    fn unit(id: &str, entry: &str, enabled: bool) -> UnitInfo {
        UnitInfo {
            unit_id: id.to_string(),
            kind: "source",
            source_id: id.to_string(),
            skill_id: String::new(),
            entries: vec![entry.to_string()],
            callable_skills: 2,
            library_enabled: enabled,
            library_only_reason: if enabled { "" } else { "disabled-by-user" },
            implicit: false,
        }
    }

    fn row(unit: &str, agent: &str, enabled: bool) -> ((String, String), TargetRow) {
        (
            (unit.to_string(), agent.to_string()),
            TargetRow {
                unit_id: unit.to_string(),
                agent_id: agent.to_string(),
                enabled,
                ..TargetRow::default()
            },
        )
    }

    fn takeover_of(agents: &[&str]) -> BTreeMap<String, TakeoverRow> {
        agents
            .iter()
            .map(|agent| {
                (
                    agent.to_string(),
                    TakeoverRow {
                        enabled: true,
                        auto_add_new: true,
                        ..TakeoverRow::default()
                    },
                )
            })
            .collect()
    }

    #[test]
    fn implicit_allowlisted_entry_follows_takeover_until_a_row_says_otherwise() {
        // An entry 3.2.18 published that maps to no indexed pack must not be
        // silently released from every tool on upgrade.
        let union = vec!["alpha".to_string(), "orphan-entry".to_string()];
        let mut implicit = unit("standalone:x", "orphan-entry", true);
        implicit.kind = "standalone";
        implicit.implicit = true;
        let units = vec![unit("pack-a", "alpha", true), implicit.clone()];
        let mut targets = BTreeMap::new();
        let (key, value) = row("pack-a", "claude", true);
        targets.insert(key, value);
        let plan = compute_targets_plan(
            &union,
            &units,
            &targets,
            &takeover_of(&["claude"]),
            &evidence(false),
        );
        let claude = plan.recipients.iter().find(|r| r.id == "claude").unwrap();
        assert_eq!(
            claude.names,
            vec!["alpha".to_string(), "orphan-entry".to_string()]
        );
        assert!(pair_desired(&implicit, None));
        // An explicit off row still wins.
        let (key, value) = row("standalone:x", "claude", false);
        targets.insert(key, value);
        let plan = compute_targets_plan(
            &union,
            &units,
            &targets,
            &takeover_of(&["claude"]),
            &evidence(false),
        );
        let claude = plan.recipients.iter().find(|r| r.id == "claude").unwrap();
        assert_eq!(claude.names, vec!["alpha".to_string()]);
    }

    #[test]
    fn per_agent_plan_is_subset_of_union() {
        let union = vec!["alpha".to_string(), "beta".to_string(), "gamma".to_string()];
        let units = vec![
            unit("pack-a", "alpha", true),
            unit("pack-b", "beta", true),
            unit("pack-off", "gamma", false),
        ];
        let mut targets = BTreeMap::new();
        for agent in DELIVERABLE_AGENTS {
            for unit in &units {
                let (key, value) = row(&unit.unit_id, agent, true);
                targets.insert(key, value);
            }
        }
        let (key, value) = row("pack-b", "claude", false);
        targets.insert(key, value);
        let plan = compute_targets_plan(
            &union,
            &units,
            &targets,
            &takeover_of(DELIVERABLE_AGENTS),
            &evidence(false),
        );
        validate_targets_plan(&plan).unwrap();
        let claude = plan.recipients.iter().find(|r| r.id == "claude").unwrap();
        assert_eq!(claude.names, vec!["alpha".to_string()]);
        let workbuddy = plan
            .recipients
            .iter()
            .find(|r| r.id == "workbuddy")
            .unwrap();
        assert_eq!(
            workbuddy.names,
            vec!["alpha".to_string(), "beta".to_string()]
        );
        let gemini = plan
            .recipients
            .iter()
            .find(|r| r.id == "gemini-cli")
            .unwrap();
        assert_eq!(gemini.action, RecipientAction::Skip, "not installed");
        for recipient in &plan.recipients {
            assert!(recipient.names.iter().all(|name| union.contains(name)));
        }
        assert!(plan.shared.is_none());

        // Takeover off → release, never deliver.
        let mut takeover = takeover_of(DELIVERABLE_AGENTS);
        takeover.get_mut("workbuddy").unwrap().enabled = false;
        let plan = compute_targets_plan(&union, &units, &targets, &takeover, &evidence(false));
        let workbuddy = plan
            .recipients
            .iter()
            .find(|r| r.id == "workbuddy")
            .unwrap();
        assert_eq!(workbuddy.action, RecipientAction::Release);
        assert!(workbuddy.names.is_empty());

        let json = targets_file_json(&plan, "parent-first-v3.3-targets").unwrap();
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(value["version"], 1);
        assert_eq!(value["policyVersion"], "parent-first-v3.3-targets");
        let gemini = value["recipients"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["id"] == "gemini-cli")
            .unwrap();
        assert_eq!(gemini["action"], "skip");
        assert!(gemini.get("names").is_none());
    }

    #[test]
    fn targets_file_validation_rejects_names_outside_the_union() {
        let mut plan = TargetsPlan {
            union: vec!["alpha".to_string()],
            ..TargetsPlan::default()
        };
        plan.recipients.push(RecipientPlan {
            id: "claude",
            agent_id: "claude",
            action: RecipientAction::Deliver,
            path: PathBuf::from("C:/x"),
            names: vec!["alpha".to_string(), "evil".to_string()],
            shared: false,
            link_root: None,
        });
        let error = validate_targets_plan(&plan).unwrap_err();
        assert_eq!(error.code, "DELIVERY_POLICY_INVALID");
        plan.recipients[0].names.pop();
        plan.recipients[0].id = "unknown-tool";
        assert_eq!(
            validate_targets_plan(&plan).unwrap_err().code,
            "DELIVERY_POLICY_INVALID"
        );
    }

    #[test]
    fn codex_and_coze_are_one_group_in_shared_mode() {
        let union = vec!["alpha".to_string()];
        let units = vec![unit("pack-a", "alpha", true)];
        let mut targets = BTreeMap::new();
        for agent in ["codex", "coze"] {
            let (key, value) = row("pack-a", agent, true);
            targets.insert(key, value);
        }
        let plan = compute_targets_plan(
            &union,
            &units,
            &targets,
            &takeover_of(&["codex", "coze"]),
            &evidence(true),
        );
        let shared = plan.shared.as_ref().unwrap();
        assert_eq!(shared.action, Some(RecipientAction::Deliver));
        assert_eq!(shared.names, union);
        let codex = plan.recipients.iter().find(|r| r.id == "codex").unwrap();
        assert!(codex.shared);
        assert_eq!(agent_group("coze", true), vec!["codex", "coze"]);
        assert_eq!(agent_group("coze", false), vec!["coze"]);
        assert_eq!(linked_agent_ids("codex", true), vec!["coze".to_string()]);

        let mut connection = memory_db();
        add_source(&connection, "pack-a", true);
        add_skill(&connection, "a1", "pack-a");
        let shared_evidence = evidence(true);
        let (group, _) = apply_takeover(
            &mut connection,
            "coze",
            true,
            true,
            "user",
            &shared_evidence,
        )
        .unwrap();
        assert_eq!(group, vec!["codex", "coze"]);
        let takeover = read_takeover(&connection).unwrap();
        assert!(takeover_enabled(&takeover, "codex") && takeover_enabled(&takeover, "coze"));
        let mut mutation = TargetMutation::default();
        apply_target_change(
            &connection,
            &TargetChangeInput {
                unit_id: "pack-a".to_string(),
                agent_id: "codex".to_string(),
                enabled: false,
            },
            &shared_evidence,
            &takeover,
            &mut mutation,
        )
        .unwrap();
        let targets = read_targets(&connection).unwrap();
        assert!(!targets[&("pack-a".to_string(), "codex".to_string())].enabled);
        assert!(!targets[&("pack-a".to_string(), "coze".to_string())].enabled);
        apply_takeover(
            &mut connection,
            "coze",
            false,
            true,
            "user",
            &shared_evidence,
        )
        .unwrap();
        let takeover = read_takeover(&connection).unwrap();
        assert!(!takeover_enabled(&takeover, "codex") && !takeover_enabled(&takeover, "coze"));

        // Without shared mode Coze cannot deliver and Codex is independent.
        let independent = evidence(false);
        assert_eq!(
            apply_takeover(&mut connection, "coze", true, true, "user", &independent)
                .unwrap_err()
                .code,
            "AGENT_UNSUPPORTED"
        );
        apply_takeover(&mut connection, "codex", true, true, "user", &independent).unwrap();
        let takeover = read_takeover(&connection).unwrap();
        assert!(takeover_enabled(&takeover, "codex") && !takeover_enabled(&takeover, "coze"));
    }

    #[test]
    fn mutation_rejections_follow_the_contract() {
        let mut connection = memory_db();
        add_source(&connection, "pack-a", true);
        add_skill(&connection, "a1", "pack-a");
        add_source(&connection, "pack-flagged", true);
        add_skill(&connection, "f1", "pack-flagged");
        connection
            .execute(
                "INSERT INTO source_security_state (source_id, scan_status) VALUES ('pack-flagged', 'review')",
                [],
            )
            .unwrap();
        let evidence = evidence(false);
        apply_takeover(&mut connection, "claude", true, false, "user", &evidence).unwrap();
        let takeover = read_takeover(&connection).unwrap();
        let mut mutation = TargetMutation::default();
        for (unit, agent, enabled) in [
            ("pack-a", "nobody", true),
            ("pack-a", "opencode", true),
            ("missing", "claude", true),
            ("pack-a", "workbuddy", true),
            ("pack-flagged", "claude", true),
            ("pack-a", "claude", true),
            ("pack-a", "claude", true),
        ] {
            apply_target_change(
                &connection,
                &TargetChangeInput {
                    unit_id: unit.to_string(),
                    agent_id: agent.to_string(),
                    enabled,
                },
                &evidence,
                &takeover,
                &mut mutation,
            )
            .unwrap();
        }
        let codes = mutation
            .rejected
            .iter()
            .map(|rejection| rejection.error.code.as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            codes,
            vec![
                "AGENT_UNKNOWN",
                "AGENT_UNSUPPORTED",
                "UNIT_NOT_FOUND",
                "AGENT_NOT_TAKEN_OVER",
                "SOURCE_LIBRARY_ONLY"
            ]
        );
        assert_eq!(
            mutation.rejected[3].error.action.as_ref().unwrap().kind,
            "takeover-agent"
        );
        assert_eq!(
            mutation.rejected[4].error.action.as_ref().unwrap().kind,
            "review-security"
        );
        assert_eq!((mutation.changed, mutation.unchanged), (1, 1));
        let not_installed = Evidence {
            installed: BTreeMap::from([("claude", false)]),
            ..evidence.clone()
        };
        assert_eq!(
            apply_takeover(
                &mut connection,
                "claude",
                true,
                true,
                "user",
                &not_installed
            )
            .unwrap_err()
            .code,
            "AGENT_NOT_INSTALLED"
        );
    }

    #[test]
    fn readback_status_matrix() {
        let ours = DiskState::Ours {
            manifest_ok: true,
            hash: "h".into(),
            target: PathBuf::from("t"),
        };
        let broken = DiskState::Ours {
            manifest_ok: false,
            hash: String::new(),
            target: PathBuf::from("t"),
        };
        let conflict = DiskState::Conflict {
            kind: "personal-folder",
            same_content: false,
            path: PathBuf::from("p"),
        };
        let base = StatusInput {
            desired: true,
            disk: &DiskState::Absent,
            installed: true,
            takeover: true,
            library_enabled: true,
            writes_blocked: false,
            job_active: false,
            verified_after_change: true,
        };
        let status = |input: StatusInput<'_>| resolve_status(input);
        assert_eq!(
            status(StatusInput {
                disk: &ours,
                ..base
            })
            .0,
            "synced"
        );
        assert_eq!(
            status(StatusInput {
                desired: false,
                ..base
            })
            .0,
            "off"
        );
        assert_eq!(
            status(StatusInput {
                job_active: true,
                ..base
            })
            .0,
            "pending"
        );
        assert_eq!(
            status(StatusInput {
                verified_after_change: false,
                ..base
            })
            .0,
            "pending"
        );
        assert_eq!(status(base), ("error", Some("DELIVERY_VERIFY_FAILED")));
        assert_eq!(
            status(StatusInput {
                desired: false,
                disk: &ours,
                job_active: true,
                ..base
            })
            .0,
            "removing"
        );
        assert_eq!(
            status(StatusInput {
                disk: &conflict,
                ..base
            }),
            ("conflict", Some("TARGET_CONFLICT"))
        );
        assert_eq!(
            status(StatusInput {
                desired: false,
                disk: &conflict,
                ..base
            })
            .0,
            "off"
        );
        assert_eq!(
            status(StatusInput {
                disk: &broken,
                ..base
            }),
            ("error", Some("MANIFEST_INVALID"))
        );
        assert_eq!(
            status(StatusInput {
                disk: &ours,
                installed: false,
                ..base
            })
            .0,
            "orphan"
        );
        assert_eq!(
            status(StatusInput {
                library_enabled: false,
                ..base
            })
            .0,
            "blocked"
        );
        assert_eq!(
            status(StatusInput {
                writes_blocked: true,
                ..base
            })
            .0,
            "paused"
        );
        assert_eq!(
            status(StatusInput {
                writes_blocked: true,
                disk: &ours,
                ..base
            })
            .0,
            "synced"
        );
        assert_eq!(
            status(StatusInput {
                takeover: false,
                disk: &ours,
                job_active: true,
                ..base
            })
            .0,
            "removing"
        );
        assert_eq!(
            status(StatusInput {
                takeover: false,
                disk: &ours,
                writes_blocked: true,
                ..base
            })
            .0,
            "paused"
        );
        assert_eq!(
            status(StatusInput {
                takeover: false,
                ..base
            })
            .0,
            "takeover-off"
        );
    }

    #[test]
    fn inspect_entry_classifies_conflicts_without_touching_them() {
        let root = std::env::temp_dir().join(format!("skillhub-inspect-{}", uuid::Uuid::new_v4()));
        let active = root.join("active");
        let recipient = root.join("recipient");
        fs::create_dir_all(active.join("alpha")).unwrap();
        fs::write(
            active.join("alpha/SKILL.md"),
            "---\nname: alpha\ndescription: A.\n---\n",
        )
        .unwrap();
        fs::create_dir_all(recipient.join("alpha")).unwrap();
        fs::write(
            recipient.join("alpha/SKILL.md"),
            "---\nname: alpha\ndescription: A.\n---\n",
        )
        .unwrap();
        fs::write(recipient.join("file-entry"), "x").unwrap();
        let roots = vec![active.clone()];
        match inspect_entry(&recipient, "alpha", &roots, false, &active.join("alpha")) {
            DiskState::Conflict {
                kind, same_content, ..
            } => {
                assert_eq!(kind, "personal-folder");
                assert!(same_content);
            }
            other => panic!("{other:?}"),
        }
        assert!(matches!(
            inspect_entry(&recipient, "file-entry", &roots, false, &active.join("x")),
            DiskState::Conflict {
                kind: "not-a-folder",
                ..
            }
        ));
        assert_eq!(
            inspect_entry(&recipient, "missing", &roots, false, &active.join("x")),
            DiskState::Absent
        );
        assert_eq!(
            fs::read_to_string(recipient.join("file-entry")).unwrap(),
            "x"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn callable_rule_matches_count_skills() {
        assert!(is_callable_skill(true, 1));
        assert!(!is_callable_skill(true, 2));
        assert!(is_callable_skill(false, 5));
    }

    #[test]
    fn fingerprint_lines_cover_pause_onboarding_takeover_and_names() {
        let plan = TargetsPlan {
            union: vec!["a".into()],
            recipients: vec![RecipientPlan {
                id: "claude",
                agent_id: "claude",
                action: RecipientAction::Deliver,
                path: PathBuf::from("x"),
                names: vec!["a".into()],
                shared: false,
                link_root: None,
            }],
            shared: None,
            real_shared: false,
        };
        let takeover = takeover_of(&["claude"]);
        let base = fingerprint_lines(false, "completed", &takeover, &plan);
        assert_ne!(base, fingerprint_lines(true, "completed", &takeover, &plan));
        assert_ne!(base, fingerprint_lines(false, "pending", &takeover, &plan));
        assert_ne!(
            base,
            fingerprint_lines(false, "completed", &BTreeMap::new(), &plan)
        );
        let mut other = plan.clone();
        other.recipients[0].names.clear();
        assert_ne!(
            base,
            fingerprint_lines(false, "completed", &takeover, &other)
        );
    }

    #[test]
    fn iso_times_are_rfc3339_utc() {
        assert_eq!(iso_from_seconds(0), "1970-01-01T00:00:00Z");
        assert_eq!(
            iso_from_nanos("1791369720000000000"),
            "2026-10-07T10:42:00Z"
        );
        assert_eq!(iso_from_nanos(""), "");
    }

    /// Read-only audit of a real library: copy its SQLite file first, then
    /// `AI_SKILLHUB_UNITS_AUDIT_DB=<copy> AI_SKILLHUB_UNITS_AUDIT_ACTIVE=<UserData\skills>
    /// cargo test --lib units_audit -- --ignored --nocapture`.
    /// Reads the active catalog (never writes it) and checks that every entry
    /// the 3.2.18 allowlist would publish belongs to exactly one unit.
    #[test]
    #[ignore = "reads a real user library; run manually against a database copy"]
    fn units_audit_of_real_library_maps_every_allowlisted_entry() {
        let (Ok(db), Ok(active)) = (
            std::env::var("AI_SKILLHUB_UNITS_AUDIT_DB"),
            std::env::var("AI_SKILLHUB_UNITS_AUDIT_ACTIVE"),
        ) else {
            return;
        };
        let connection = Connection::open(&db).unwrap();
        crate::source_governance::ensure_schema(&connection).unwrap();
        ensure_schema(&connection).unwrap();
        let rules = crate::read_agent_skill_allowlist_rules(&connection).unwrap();
        let union =
            crate::select_agent_skill_allowlist_entries(Path::new(&active), &rules).unwrap();
        let units = read_delivery_units_at(Path::new(&active), &connection, &union).unwrap();
        let mut owners: BTreeMap<String, Vec<String>> = BTreeMap::new();
        for unit in &units {
            for entry in &unit.entries {
                owners
                    .entry(entry.to_lowercase())
                    .or_default()
                    .push(unit.unit_id.clone());
            }
        }
        for name in &union {
            let owner = owners
                .get(&name.to_lowercase())
                .cloned()
                .unwrap_or_default();
            assert_eq!(owner.len(), 1, "{name} owned by {owner:?}");
        }
        let enabled = units.iter().filter(|unit| unit.library_enabled).count();
        let mut reasons: BTreeMap<&str, usize> = BTreeMap::new();
        for unit in &units {
            *reasons.entry(unit.library_only_reason).or_default() += 1;
        }
        println!(
            "units={} libraryEnabled={} union={} reasons={reasons:?}",
            units.len(),
            enabled,
            union.len()
        );
        for unit in units.iter().filter(|unit| unit.library_enabled) {
            assert!(
                unit.entries
                    .iter()
                    .all(|entry| union.iter().any(|name| name.eq_ignore_ascii_case(entry))),
                "{unit:?}"
            );
        }
        // Simulate the upgrade on the copy: probes the machine read-only and
        // writes only the copied database.
        let recipients = crate::delivery_recipient_states(&connection).unwrap();
        let has = tools_with_skillhub_entries(Path::new(&active), &recipients);
        let fingerprint = crate::read_agent_delivery_fingerprint(&connection).unwrap();
        let mut connection = connection;
        let report = migrate_v33_delivery_state(&mut connection, &has, &fingerprint).unwrap();
        materialize_defaults(&connection).unwrap();
        println!("tools with entries: {has:?}; migration: {report:?}");
        let units = read_delivery_units_at(Path::new(&active), &connection, &union).unwrap();
        let evidence = Evidence::from_recipients(&recipients);
        let plan = compute_targets_plan(
            &union,
            &units,
            &read_targets(&connection).unwrap(),
            &read_takeover(&connection).unwrap(),
            &evidence,
        );
        validate_targets_plan(&plan).unwrap();
        for recipient in &plan.recipients {
            println!(
                "recipient {} {:?} names={}",
                recipient.id,
                recipient.action,
                recipient.names.len()
            );
            if recipient.action == RecipientAction::Deliver {
                assert_eq!(recipient.names.len(), union.len(), "{}", recipient.id);
            }
        }
        if let Some(shared) = &plan.shared {
            println!("shared {:?} names={}", shared.action, shared.names.len());
        }
        // Read back the real tool folders (read only) into the copy and show
        // what the icon row would say right after the upgrade.
        read_back_at(Path::new(&active), &connection, &units, &evidence).unwrap();
        let mut statuses: BTreeMap<(String, String), usize> = BTreeMap::new();
        for row in read_targets(&connection).unwrap().values() {
            *statuses
                .entry((row.agent_id.clone(), row.status.clone()))
                .or_default() += 1;
        }
        println!("read-back statuses: {statuses:?}");
    }
}
