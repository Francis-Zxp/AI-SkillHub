//! Source identity, display and invocation-name unification.
//!
//! A GitHub source is identified by its canonical `owner/repo`, never by its
//! folder. Folders and parent invocation names use `repo--owner` (project first,
//! author as suffix). Sources installed by older versions live in a bare `repo`
//! or an `owner--repo` folder; the bare ones carry no author, so two authors'
//! `skills` repositories could collide.
//!
//! `build_plan` is read-only. `apply` renames only folders the app manages,
//! after a SQLite backup and a journal, and remaps every row keyed by the old
//! source id or the old parent Skill id, so notes, categories, ratings, pins,
//! tags, enabled state and usage history follow the source. Clients have no
//! alias mechanism we can rely on, so the old invocation name is not faked:
//! the plan lists old -> new names before anything changes, and the folder
//! keeps a record of its previous name.

use crate::source_identity::canonical_github_identity;
use crate::{
    github_git_origin_at, managed_sources_dir, read_indexed_sources, read_json,
    router_hub_skill_name, stable_id, SourceCard, MANAGED_SOURCE_METADATA_FILE, ROUTER_HUB_FOLDER,
};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

pub(crate) const JOURNAL_FILE: &str = "identity-migration-journal.json";

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IdentityPlanEntry {
    pub source_id: String,
    pub folder: String,
    /// Canonical lowercase `owner/repo`; empty for local folders.
    pub identity: String,
    pub owner: String,
    pub repo: String,
    pub github_repo_id: Option<i64>,
    /// Lowercase `owner/repo` GitHub reported last; differs after a transfer.
    pub github_full_name: String,
    pub current_parent: String,
    pub target_parent: String,
    pub target_folder: String,
    /// aligned | rename | local | ambiguous | blocked
    pub action: String,
    pub reasons: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct IdentityPlan {
    pub entries: Vec<IdentityPlanEntry>,
    pub rename_count: usize,
    pub aligned_count: usize,
    pub attention_count: usize,
    /// An interrupted migration was found and must be finished first.
    pub interrupted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct JournalEntry {
    pub old_folder: String,
    pub new_folder: String,
    pub old_source_id: String,
    pub new_source_id: String,
    pub old_parent: String,
    pub new_parent: String,
    /// planned | moved | remapped
    pub state: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Journal {
    pub schema_version: u32,
    pub backup_dir: String,
    pub entries: Vec<JournalEntry>,
    pub completed: bool,
}

fn folder_of(source: &SourceCard) -> String {
    Path::new(source.local_path.trim())
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| source.name.clone())
}

fn recorded_identity(path: &Path) -> Option<String> {
    let payload = read_json(&path.join(MANAGED_SOURCE_METADATA_FILE))?;
    canonical_github_identity(payload.get("url").and_then(Value::as_str)?)
}

/// The folder (and therefore the parent invocation name) for an identity:
/// project first, author as the disambiguating suffix. People remember and
/// type the project name, client pickers prefix-match it, and lists sort by
/// project instead of by a wall of author prefixes.
pub(crate) fn target_folder_for(identity: &str) -> Option<String> {
    let (owner, repo) = identity.split_once('/')?;
    Some(format!("{repo}--{owner}"))
}

fn github_cache(connection: &Connection, source_id: &str) -> (Option<i64>, String) {
    connection
        .query_row(
            "SELECT github_repo_id, COALESCE(github_full_name, '')
             FROM source_popularity_cache WHERE source_id = ?1",
            [source_id],
            |row| Ok((row.get::<_, Option<i64>>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .ok()
        .flatten()
        .unwrap_or((None, String::new()))
}

/// Read-only plan for every indexed source.
pub(crate) fn build_plan(root: &Path, connection: &Connection) -> Result<IdentityPlan, String> {
    let mut plan = build_plan_in(&managed_sources_dir(root), connection)?;
    plan.interrupted = read_journal(root).is_some_and(|journal| !journal.completed);
    Ok(plan)
}

/// Same plan against an explicit sources folder (also used for read-only
/// audits of a real library from tests).
pub(crate) fn build_plan_in(
    sources_dir: &Path,
    connection: &Connection,
) -> Result<IdentityPlan, String> {
    let sources = read_indexed_sources(connection)?;
    let sources_dir = sources_dir.to_path_buf();
    let canonical_sources = sources_dir.canonicalize().ok();
    let mut entries = Vec::new();
    for source in &sources {
        if source.name.eq_ignore_ascii_case(ROUTER_HUB_FOLDER) {
            continue;
        }
        let folder = folder_of(source);
        let path = sources_dir.join(&folder);
        let managed = canonical_sources.as_ref().is_some_and(|base| {
            path.canonicalize()
                .ok()
                .and_then(|resolved| resolved.parent().map(Path::to_path_buf))
                .is_some_and(|parent| &parent == base)
        });
        let origin = github_git_origin_at(&path).and_then(|url| canonical_github_identity(&url));
        let recorded = recorded_identity(&path).or_else(|| canonical_github_identity(&source.url));
        let identity = origin.clone().or(recorded.clone()).unwrap_or_default();
        let (owner, repo) = identity
            .split_once('/')
            .map(|(owner, repo)| (owner.to_string(), repo.to_string()))
            .unwrap_or_default();
        let (github_repo_id, github_full_name) = github_cache(connection, &source.id);
        let current_parent = router_hub_skill_name(&folder);
        let target_folder = target_folder_for(&identity).unwrap_or_else(|| folder.clone());
        let target_parent = router_hub_skill_name(&target_folder);
        let mut entry = IdentityPlanEntry {
            source_id: source.id.clone(),
            folder: folder.clone(),
            identity: identity.clone(),
            owner,
            repo,
            github_repo_id,
            github_full_name: github_full_name.to_lowercase(),
            current_parent: current_parent.clone(),
            target_parent: target_parent.clone(),
            target_folder: target_folder.clone(),
            action: String::new(),
            reasons: Vec::new(),
        };
        if identity.is_empty() {
            entry.action = "local".to_string();
            entry.target_parent = current_parent.clone();
            entry.target_folder = folder;
        } else if !managed {
            entry.action = "blocked".to_string();
            entry
                .reasons
                .push("不在 AI SkillHub 管理的来源目录内，不会改动。".to_string());
        } else if let (Some(origin), Some(recorded)) = (&origin, &recorded) {
            if origin != recorded {
                entry.action = "ambiguous".to_string();
                entry.reasons.push(format!(
                    "Git 地址是 {origin}，导入记录是 {recorded}；请先核对来源。"
                ));
            }
        }
        if entry.action.is_empty() {
            entry.action = if current_parent == target_parent {
                "aligned".to_string()
            } else {
                "rename".to_string()
            };
        }
        if !entry.github_full_name.is_empty()
            && !entry.identity.is_empty()
            && entry.github_full_name != entry.identity
        {
            entry.reasons.push(format!(
                "GitHub 显示该仓库现为 {}（可能已转移或改名）；身份按仓库 ID 视为同一仓库。",
                entry.github_full_name
            ));
        }
        entries.push(entry);
    }

    // The same repository in two folders is a duplicate to consolidate first;
    // a rename must never merge or overwrite copies by URL alone.
    let mut by_identity: BTreeMap<String, Vec<usize>> = BTreeMap::new();
    for (index, entry) in entries.iter().enumerate() {
        if !entry.identity.is_empty() {
            by_identity
                .entry(entry.identity.clone())
                .or_default()
                .push(index);
        }
    }
    for indexes in by_identity.values().filter(|indexes| indexes.len() > 1) {
        for &index in indexes {
            if entries[index].action == "aligned" {
                continue;
            }
            entries[index].action = "ambiguous".to_string();
            entries[index]
                .reasons
                .push("同一仓库在多个文件夹中，请先在技能库中整理重复来源。".to_string());
        }
    }
    // Never rename onto a name another source already uses.
    let taken = entries
        .iter()
        .map(|entry| entry.current_parent.clone())
        .collect::<Vec<_>>();
    for entry in &mut entries {
        if entry.action != "rename" {
            continue;
        }
        let occupied_folder = sources_dir.join(&entry.target_folder).exists();
        if occupied_folder || taken.contains(&entry.target_parent) {
            entry.action = "blocked".to_string();
            entry
                .reasons
                .push(format!("目标名称 {} 已被占用。", entry.target_folder));
        }
    }
    entries.sort_by(|left, right| {
        action_rank(&left.action)
            .cmp(&action_rank(&right.action))
            .then_with(|| left.folder.to_lowercase().cmp(&right.folder.to_lowercase()))
    });
    let count = |action: &str| {
        entries
            .iter()
            .filter(|entry| entry.action == action)
            .count()
    };
    Ok(IdentityPlan {
        rename_count: count("rename"),
        aligned_count: count("aligned") + count("local"),
        attention_count: count("ambiguous") + count("blocked"),
        interrupted: false,
        entries,
    })
}

fn action_rank(action: &str) -> u8 {
    match action {
        "rename" => 0,
        "ambiguous" => 1,
        "blocked" => 2,
        "aligned" => 3,
        _ => 4,
    }
}

fn journal_path(root: &Path) -> PathBuf {
    crate::private_state_dir(root).join(JOURNAL_FILE)
}

pub(crate) fn read_journal(root: &Path) -> Option<Journal> {
    let raw = fs::read_to_string(journal_path(root)).ok()?;
    serde_json::from_str(raw.trim_start_matches('\u{feff}')).ok()
}

fn write_journal(root: &Path, journal: &Journal) -> Result<(), String> {
    let path = journal_path(root);
    let temporary = path.with_extension("json.tmp");
    let text = serde_json::to_string_pretty(journal)
        .map_err(|error| format!("无法记录命名迁移进度：{error}"))?;
    fs::write(&temporary, text).map_err(|error| format!("无法记录命名迁移进度：{error}"))?;
    fs::rename(&temporary, &path).map_err(|error| format!("无法记录命名迁移进度：{error}"))
}

fn table_exists(connection: &Connection, table: &str) -> bool {
    connection
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1",
            [table],
            |_| Ok(()),
        )
        .optional()
        .ok()
        .flatten()
        .is_some()
}

fn column_exists(connection: &Connection, table: &str, column: &str) -> bool {
    connection
        .prepare(&format!("PRAGMA table_info('{table}')"))
        .and_then(|mut statement| {
            let names = statement
                .query_map([], |row| row.get::<_, String>(1))?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(names.iter().any(|name| name == column))
        })
        .unwrap_or(false)
}

/// Every table keyed by a source id. User data wins over a fresh empty row a
/// rescan may already have created under the new id (`OR REPLACE`).
const SOURCE_KEYED_TABLES: &[&str] = &[
    "source_overrides",
    "source_folder_memberships",
    "source_governance",
    "source_popularity_cache",
    "source_popularity_history",
    "source_security_state",
    "source_tag_overrides",
    "source_tags",
    "source_version_backups",
];

/// Every table keyed by a Skill id (the generated parent changes id with it).
const SKILL_KEYED_TABLES: &[(&str, &str)] = &[
    ("skill_overrides", "skill_id"),
    ("skill_tag_overrides", "skill_id"),
    ("skill_tags", "skill_id"),
    ("skill_folder_memberships", "skill_id"),
    ("preset_skills", "skill_id"),
    ("skill_conflict_choices", "default_skill_id"),
];

/// Moves every row from the old keys to the new ones. Idempotent: a second
/// run finds nothing under the old keys. Runs in the caller's transaction.
pub(crate) fn remap_keys(connection: &Connection, entry: &JournalEntry) -> Result<(), String> {
    let error = |table: &str, error: rusqlite::Error| format!("无法迁移 {table}：{error}");
    // Parent and child keys move together inside the caller's transaction;
    // if foreign keys are enforced, check them only at commit.
    connection
        .execute_batch("PRAGMA defer_foreign_keys = ON;")
        .map_err(|failure| error("foreign keys", failure))?;
    let (old_source, new_source) = (&entry.old_source_id, &entry.new_source_id);
    for table in SOURCE_KEYED_TABLES {
        if !table_exists(connection, table) {
            continue;
        }
        connection
            .execute(
                &format!("UPDATE OR REPLACE {table} SET source_id = ?2 WHERE source_id = ?1"),
                params![old_source, new_source],
            )
            .map_err(|failure| error(table, failure))?;
        for (column, old, new) in [
            ("source_folder", &entry.old_folder, &entry.new_folder),
            ("source_name", &entry.old_folder, &entry.new_folder),
        ] {
            if column_exists(connection, table, column) {
                connection
                    .execute(
                        &format!(
                            "UPDATE {table} SET {column} = ?3 WHERE source_id = ?1 AND {column} = ?2"
                        ),
                        params![new_source, old, new],
                    )
                    .map_err(|failure| error(table, failure))?;
            }
        }
    }
    if table_exists(connection, "sources") {
        // The next scan rebuilds this row from disk; remapping it now keeps the
        // plan idempotent even if that scan has not run yet.
        let path_column = column_exists(connection, "sources", "local_path");
        let sql = if path_column {
            "UPDATE OR REPLACE sources SET id = ?2,
                 name = CASE WHEN name = ?3 THEN ?4 ELSE name END,
                 local_path = CASE
                     WHEN local_path LIKE '%' || ?3 THEN substr(local_path, 1, length(local_path) - length(?3)) || ?4
                     ELSE local_path END
             WHERE id = ?1"
        } else {
            "UPDATE OR REPLACE sources SET id = ?2, name = CASE WHEN name = ?3 THEN ?4 ELSE name END WHERE id = ?1"
        };
        connection
            .execute(
                sql,
                params![old_source, new_source, entry.old_folder, entry.new_folder],
            )
            .map_err(|failure| error("sources", failure))?;
    }
    if table_exists(connection, "skills") {
        connection
            .execute(
                "UPDATE skills SET source_id = ?2 WHERE source_id = ?1",
                params![old_source, new_source],
            )
            .map_err(|failure| error("skills", failure))?;
    }
    let old_parent_id = stable_id("skill", &entry.old_parent);
    let new_parent_id = stable_id("skill", &entry.new_parent);
    if old_parent_id != new_parent_id {
        for (table, column) in SKILL_KEYED_TABLES {
            if !table_exists(connection, table) {
                continue;
            }
            connection
                .execute(
                    &format!("UPDATE OR REPLACE {table} SET {column} = ?2 WHERE {column} = ?1"),
                    params![old_parent_id, new_parent_id],
                )
                .map_err(|failure| error(table, failure))?;
        }
    }
    if table_exists(connection, "usage_events") {
        connection
            .execute(
                "UPDATE usage_events SET target_id = ?2, target_name = CASE WHEN target_name = ?3 THEN ?4 ELSE target_name END
                 WHERE target_type = 'source' AND target_id = ?1",
                params![old_source, new_source, entry.old_folder, entry.new_folder],
            )
            .map_err(|failure| error("usage_events", failure))?;
        connection
            .execute(
                "UPDATE usage_events SET target_id = ?2, target_name = CASE WHEN target_name = ?3 THEN ?4 ELSE target_name END
                 WHERE target_id = ?1",
                params![old_parent_id, new_parent_id, entry.old_parent, entry.new_parent],
            )
            .map_err(|failure| error("usage_events", failure))?;
        connection
            .execute(
                "UPDATE usage_events SET source_name = ?2 WHERE source_name = ?1",
                params![entry.old_folder, entry.new_folder],
            )
            .map_err(|failure| error("usage_events", failure))?;
    }
    Ok(())
}

/// The reverse bijection, used to roll back.
fn inverse(entry: &JournalEntry) -> JournalEntry {
    JournalEntry {
        old_folder: entry.new_folder.clone(),
        new_folder: entry.old_folder.clone(),
        old_source_id: entry.new_source_id.clone(),
        new_source_id: entry.old_source_id.clone(),
        old_parent: entry.new_parent.clone(),
        new_parent: entry.old_parent.clone(),
        state: entry.state.clone(),
    }
}

fn remember_previous_folder(folder: &Path, previous: &str) {
    let marker = folder.join(MANAGED_SOURCE_METADATA_FILE);
    let mut payload = read_json(&marker).unwrap_or_else(|| serde_json::json!({}));
    let Some(object) = payload.as_object_mut() else {
        return;
    };
    let mut names = object
        .get("previousFolders")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if !names.iter().any(|name| name.as_str() == Some(previous)) {
        names.push(Value::String(previous.to_string()));
    }
    object.insert("previousFolders".to_string(), Value::Array(names));
    if let Ok(text) = serde_json::to_string_pretty(&payload) {
        let _ = fs::write(marker, text);
    }
}

fn rename_config_repository(root: &Path, entry: &JournalEntry) -> Result<(), String> {
    let path = crate::skillhub_config_file(root);
    let Some(mut config) = read_json(&path) else {
        return Ok(());
    };
    let mut changed = false;
    if let Some(repositories) = config.get_mut("repositories").and_then(Value::as_array_mut) {
        for repository in repositories {
            if repository.get("name").and_then(Value::as_str) == Some(entry.old_folder.as_str()) {
                repository["name"] = Value::String(entry.new_folder.clone());
                changed = true;
            }
        }
    }
    if changed {
        let text = serde_json::to_string_pretty(&config).map_err(|error| error.to_string())?;
        fs::write(&path, text).map_err(|error| format!("无法更新来源配置：{error}"))?;
    }
    Ok(())
}

/// Renames the selected sources and remaps their data. The caller rebuilds
/// routers, the catalog and the index afterwards. Folder moves happen first
/// (journaled), then one SQLite transaction; any failure restores both.
pub(crate) fn apply(
    root: &Path,
    connection: &mut Connection,
    source_ids: &[String],
) -> Result<Journal, String> {
    if let Some(journal) = read_journal(root).filter(|journal| !journal.completed) {
        return resume(root, connection, journal);
    }
    let plan = build_plan(root, connection)?;
    let selected = plan
        .entries
        .iter()
        .filter(|entry| entry.action == "rename")
        .filter(|entry| source_ids.is_empty() || source_ids.contains(&entry.source_id))
        .collect::<Vec<_>>();
    if selected.is_empty() {
        return Ok(Journal {
            schema_version: 1,
            completed: true,
            ..Journal::default()
        });
    }
    let backup = crate::private_state_dir(root).join("backups").join(format!(
        "identity-migration-{}",
        crate::unix_timestamp_string()
    ));
    fs::create_dir_all(&backup).map_err(|error| format!("无法创建迁移备份：{error}"))?;
    connection
        .execute(
            "VACUUM INTO ?1",
            [backup.join("before.sqlite3").to_string_lossy().as_ref()],
        )
        .map_err(|error| format!("无法备份来源索引：{error}"))?;
    let config = crate::skillhub_config_file(root);
    if config.exists() {
        fs::copy(&config, backup.join("skillhub.config.json"))
            .map_err(|error| format!("无法备份来源配置：{error}"))?;
    }
    let mut journal = Journal {
        schema_version: 1,
        backup_dir: backup.display().to_string(),
        entries: selected
            .iter()
            .map(|entry| JournalEntry {
                old_folder: entry.folder.clone(),
                new_folder: entry.target_folder.clone(),
                old_source_id: entry.source_id.clone(),
                new_source_id: stable_id("source", &entry.target_folder),
                old_parent: entry.current_parent.clone(),
                new_parent: entry.target_parent.clone(),
                state: "planned".to_string(),
            })
            .collect(),
        completed: false,
    };
    write_journal(root, &journal)?;
    fs::write(
        backup.join("plan.json"),
        serde_json::to_string_pretty(&journal).unwrap_or_default(),
    )
    .map_err(|error| format!("无法写入迁移计划：{error}"))?;
    resume(root, connection, std::mem::take(&mut journal))
}

/// Finishes (or, on failure, reverses) a journaled migration. Safe to call
/// again after an interruption at any point.
pub(crate) fn resume(
    root: &Path,
    connection: &mut Connection,
    mut journal: Journal,
) -> Result<Journal, String> {
    let sources_dir = managed_sources_dir(root);
    let outcome = (|| -> Result<(), String> {
        for index in 0..journal.entries.len() {
            let entry = journal.entries[index].clone();
            if entry.state == "planned" {
                let from = sources_dir.join(&entry.old_folder);
                let to = sources_dir.join(&entry.new_folder);
                if from.exists() && !to.exists() {
                    fs::rename(&from, &to).map_err(|error| {
                        format!(
                            "无法重命名 {} → {}：{error}",
                            entry.old_folder, entry.new_folder
                        )
                    })?;
                } else if !to.exists() {
                    return Err(format!("找不到来源文件夹 {}。", entry.old_folder));
                }
                remember_previous_folder(&to, &entry.old_folder);
                journal.entries[index].state = "moved".to_string();
                write_journal(root, &journal)?;
            }
        }
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| format!("无法开始迁移事务：{error}"))?;
        for entry in journal
            .entries
            .iter()
            .filter(|entry| entry.state == "moved")
        {
            remap_keys(&transaction, entry)?;
        }
        transaction
            .commit()
            .map_err(|error| format!("无法提交迁移事务：{error}"))?;
        for entry in &mut journal.entries {
            if entry.state == "moved" {
                rename_config_repository(root, entry)?;
                entry.state = "remapped".to_string();
            }
        }
        write_journal(root, &journal)
    })();
    if let Err(failure) = outcome {
        rollback(root, connection, &journal);
        return Err(format!("{failure}；已恢复原文件夹与索引。"));
    }
    journal.completed = true;
    write_journal(root, &journal)?;
    Ok(journal)
}

/// Best-effort reversal of a journal: move folders back and invert the keys.
pub(crate) fn rollback(root: &Path, connection: &mut Connection, journal: &Journal) {
    let sources_dir = managed_sources_dir(root);
    if let Ok(transaction) = connection.transaction_with_behavior(TransactionBehavior::Immediate) {
        let mut ok = true;
        for entry in journal
            .entries
            .iter()
            .filter(|entry| entry.state == "remapped")
        {
            ok &= remap_keys(&transaction, &inverse(entry)).is_ok();
        }
        if ok {
            let _ = transaction.commit();
        }
    }
    for entry in &journal.entries {
        if entry.state == "planned" {
            continue;
        }
        let renamed = sources_dir.join(&entry.new_folder);
        let original = sources_dir.join(&entry.old_folder);
        if renamed.exists() && !original.exists() {
            let _ = fs::rename(&renamed, &original);
        }
        let _ = rename_config_repository(root, &inverse(entry));
    }
    let _ = fs::remove_file(journal_path(root));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn connection_with_schema() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE skills (id TEXT PRIMARY KEY, source_id TEXT, name TEXT, folder_name TEXT);
                 CREATE TABLE source_overrides (source_id TEXT PRIMARY KEY, display_name TEXT, note TEXT, rating INTEGER);
                 CREATE TABLE source_folder_memberships (source_id TEXT PRIMARY KEY, folder_id TEXT);
                 CREATE TABLE source_governance (source_id TEXT PRIMARY KEY, source_folder TEXT, pinned INTEGER);
                 CREATE TABLE source_tags (source_id TEXT, tag TEXT, PRIMARY KEY (source_id, tag));
                 CREATE TABLE skill_overrides (skill_id TEXT PRIMARY KEY, display_name TEXT, rating INTEGER);
                 CREATE TABLE usage_events (id TEXT PRIMARY KEY, target_type TEXT, target_id TEXT, target_name TEXT, source_name TEXT);",
            )
            .unwrap();
        connection
    }

    fn entry() -> JournalEntry {
        JournalEntry {
            old_folder: "gstack".into(),
            new_folder: "gstack--garrytan".into(),
            old_source_id: stable_id("source", "gstack"),
            new_source_id: stable_id("source", "gstack--garrytan"),
            old_parent: "gstack".into(),
            new_parent: "gstack--garrytan".into(),
            state: "moved".into(),
        }
    }

    #[test]
    fn remap_moves_every_user_record_and_is_idempotent_and_reversible() {
        let connection = connection_with_schema();
        let entry = entry();
        let old_parent = stable_id("skill", "gstack");
        connection
            .execute_batch(&format!(
                "INSERT INTO source_overrides VALUES ('{s}', '我的 gstack', '笔记', 5);
                 INSERT INTO source_folder_memberships VALUES ('{s}', 'folder-research');
                 INSERT INTO source_governance VALUES ('{s}', 'gstack', 1);
                 INSERT INTO source_tags VALUES ('{s}', 'agent');
                 INSERT INTO skills VALUES ('child-a', '{s}', 'autoplan', 'autoplan');
                 INSERT INTO skill_overrides VALUES ('{p}', '', 4);
                 INSERT INTO usage_events VALUES ('u1', 'source', '{s}', 'gstack', 'gstack');
                 INSERT INTO usage_events VALUES ('u2', 'skill', '{p}', 'gstack', 'gstack');",
                s = entry.old_source_id,
                p = old_parent
            ))
            .unwrap();
        // A rescan may already have created an empty row under the new id.
        connection
            .execute(
                "INSERT INTO source_overrides VALUES (?1, '', '', 0)",
                [&entry.new_source_id],
            )
            .unwrap();
        remap_keys(&connection, &entry).unwrap();
        remap_keys(&connection, &entry).unwrap();
        let (title, note, rating): (String, String, i64) = connection
            .query_row(
                "SELECT display_name, note, rating FROM source_overrides WHERE source_id = ?1",
                [&entry.new_source_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(
            (title.as_str(), note.as_str(), rating),
            ("我的 gstack", "笔记", 5)
        );
        let count = |sql: &str| -> i64 { connection.query_row(sql, [], |row| row.get(0)).unwrap() };
        assert_eq!(count("SELECT COUNT(*) FROM source_overrides"), 1);
        assert_eq!(
            count(&format!(
                "SELECT COUNT(*) FROM source_governance WHERE source_id = '{}' AND source_folder = 'gstack--garrytan' AND pinned = 1",
                entry.new_source_id
            )),
            1
        );
        assert_eq!(
            count(&format!(
                "SELECT COUNT(*) FROM skill_overrides WHERE skill_id = '{}'",
                stable_id("skill", "gstack--garrytan")
            )),
            1
        );
        assert_eq!(
            count(&format!(
                "SELECT COUNT(*) FROM skills WHERE source_id = '{}'",
                entry.new_source_id
            )),
            1
        );
        assert_eq!(
            count("SELECT COUNT(*) FROM usage_events WHERE source_name = 'gstack--garrytan'"),
            2
        );
        assert_eq!(
            count("SELECT COUNT(*) FROM usage_events WHERE target_name = 'gstack--garrytan'"),
            2
        );

        remap_keys(&connection, &inverse(&entry)).unwrap();
        assert_eq!(
            count(&format!(
                "SELECT COUNT(*) FROM source_folder_memberships WHERE source_id = '{}'",
                entry.old_source_id
            )),
            1
        );
        assert_eq!(
            count("SELECT COUNT(*) FROM usage_events WHERE target_name = 'gstack'"),
            2
        );
    }

    struct Library {
        root: PathBuf,
    }

    impl Drop for Library {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    impl Library {
        fn new(label: &str) -> (Self, Connection) {
            let root = std::env::temp_dir().join(format!(
                "skillhub-identity-{label}-{}",
                crate::unix_timestamp_string()
            ));
            fs::create_dir_all(managed_sources_dir(&root)).unwrap();
            let connection = crate::open_index_database(&root).unwrap();
            (Self { root }, connection)
        }

        fn sources(&self) -> PathBuf {
            managed_sources_dir(&self.root)
        }

        /// A source folder whose `.git/config` points at `origin`.
        fn add(&self, connection: &Connection, folder: &str, origin: Option<&str>) -> String {
            let path = self.sources().join(folder);
            fs::create_dir_all(path.join("skills/one")).unwrap();
            fs::write(
                path.join("skills/one/SKILL.md"),
                "---\nname: one\ndescription: d\n---\n",
            )
            .unwrap();
            if let Some(origin) = origin {
                fs::create_dir_all(path.join(".git")).unwrap();
                fs::write(
                    path.join(".git/config"),
                    format!("[remote \"origin\"]\n\turl = {origin}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n"),
                )
                .unwrap();
            }
            let id = stable_id("source", folder);
            connection
                .execute(
                    "INSERT INTO sources (id, name, source_type, url, local_path, created_at, updated_at)
                     VALUES (?1, ?2, 'skill', ?3, ?4, '1', '1')",
                    params![id, folder, origin.unwrap_or(""), path.display().to_string()],
                )
                .unwrap();
            id
        }
    }

    fn action<'a>(plan: &'a IdentityPlan, folder: &str) -> &'a str {
        plan.entries
            .iter()
            .find(|entry| entry.folder == folder)
            .map(|entry| entry.action.as_str())
            .unwrap_or("missing")
    }

    #[test]
    fn plan_distinguishes_rename_aligned_local_ambiguous_and_blocked() {
        let (library, connection) = Library::new("plan");
        library.add(
            &connection,
            "gstack",
            Some("https://github.com/garrytan/gstack.git"),
        );
        library.add(
            &connection,
            "Nature-Skills--Yuan1z0825",
            Some("https://github.com/Yuan1z0825/nature-skills"),
        );
        library.add(&connection, "my-local-pack", None);
        library.add(
            &connection,
            "acme--legacy-order",
            Some("https://github.com/acme/legacy-order"),
        );
        library.add(
            &connection,
            "skills",
            Some("https://github.com/mattpocock/skills"),
        );
        library.add(
            &connection,
            "mattpocock-copy",
            Some("git@github.com:MattPocock/Skills.git"),
        );
        library.add(&connection, "taken", Some("https://github.com/acme/taken"));
        fs::create_dir_all(library.sources().join("taken--acme")).unwrap();
        let plan = build_plan(&library.root, &connection).unwrap();
        assert_eq!(action(&plan, "gstack"), "rename");
        let gstack = plan
            .entries
            .iter()
            .find(|entry| entry.folder == "gstack")
            .unwrap();
        assert_eq!(gstack.target_folder, "gstack--garrytan");
        assert_eq!(gstack.target_parent, "gstack--garrytan");
        assert_eq!(gstack.identity, "garrytan/gstack");
        // Case and `.git` differences are one identity; the parent is already aligned.
        assert_eq!(action(&plan, "Nature-Skills--Yuan1z0825"), "aligned");
        // The earlier owner--repo order migrates to the same project-first rule.
        assert_eq!(action(&plan, "acme--legacy-order"), "rename");
        assert_eq!(action(&plan, "my-local-pack"), "local");
        // The same repository in two folders is never merged by URL alone.
        assert_eq!(action(&plan, "skills"), "ambiguous");
        assert_eq!(action(&plan, "mattpocock-copy"), "ambiguous");
        assert_eq!(action(&plan, "taken"), "blocked");
        assert_eq!(plan.rename_count, 2);
    }

    #[test]
    fn apply_renames_remaps_and_is_idempotent() {
        let (library, mut connection) = Library::new("apply");
        let old_id = library.add(
            &connection,
            "gstack",
            Some("https://github.com/garrytan/gstack.git"),
        );
        library.add(&connection, "other", Some("https://github.com/acme/other"));
        connection
            .execute(
                "INSERT INTO source_overrides (source_id, display_name, note, updated_at)
                 VALUES (?1, '我的 gstack', '常用', '1')",
                [&old_id],
            )
            .unwrap();
        let gstack_id = old_id.clone();
        let journal = apply(&library.root, &mut connection, &[gstack_id]).unwrap();
        assert!(journal.completed);
        assert_eq!(journal.entries.len(), 1);
        assert!(library
            .sources()
            .join("gstack--garrytan/skills/one/SKILL.md")
            .is_file());
        assert!(!library.sources().join("gstack").exists());
        assert!(
            library.sources().join("other").exists(),
            "unselected sources stay"
        );
        let new_id = stable_id("source", "gstack--garrytan");
        let note: String = connection
            .query_row(
                "SELECT note FROM source_overrides WHERE source_id = ?1",
                [&new_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(note, "常用");
        let metadata = read_json(
            &library
                .sources()
                .join("gstack--garrytan")
                .join(MANAGED_SOURCE_METADATA_FILE),
        )
        .unwrap();
        assert_eq!(metadata["previousFolders"][0], "gstack");
        assert!(Path::new(&journal.backup_dir)
            .join("before.sqlite3")
            .is_file());

        let again = build_plan(&library.root, &connection).unwrap();
        assert_eq!(action(&again, "gstack--garrytan"), "aligned");
        assert_eq!(again.rename_count, 1, "only `other` still needs a rename");
        assert!(!again.interrupted);
    }

    #[test]
    fn an_interrupted_migration_is_finished_on_the_next_call() {
        let (library, mut connection) = Library::new("resume");
        let old_id = library.add(
            &connection,
            "gstack",
            Some("https://github.com/garrytan/gstack"),
        );
        // Crash after the folder move, before the database transaction.
        fs::rename(
            library.sources().join("gstack"),
            library.sources().join("gstack--garrytan"),
        )
        .unwrap();
        let journal = Journal {
            schema_version: 1,
            backup_dir: String::new(),
            entries: vec![JournalEntry {
                old_folder: "gstack".into(),
                new_folder: "gstack--garrytan".into(),
                old_source_id: old_id.clone(),
                new_source_id: stable_id("source", "gstack--garrytan"),
                old_parent: "gstack".into(),
                new_parent: "gstack--garrytan".into(),
                state: "moved".into(),
            }],
            completed: false,
        };
        write_journal(&library.root, &journal).unwrap();
        assert!(build_plan(&library.root, &connection).unwrap().interrupted);
        let finished = apply(&library.root, &mut connection, &[]).unwrap();
        assert!(finished.completed);
        let moved: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sources WHERE id = ?1",
                [stable_id("source", "gstack--garrytan")],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(moved, 1);
        assert!(!build_plan(&library.root, &connection).unwrap().interrupted);
    }

    #[test]
    fn a_failed_move_restores_every_folder() {
        let (library, mut connection) = Library::new("rollback");
        library.add(&connection, "alpha", Some("https://github.com/acme/alpha"));
        let journal = Journal {
            schema_version: 1,
            backup_dir: String::new(),
            entries: vec![
                JournalEntry {
                    old_folder: "alpha".into(),
                    new_folder: "alpha--acme".into(),
                    old_source_id: stable_id("source", "alpha"),
                    new_source_id: stable_id("source", "alpha--acme"),
                    old_parent: "alpha".into(),
                    new_parent: "alpha--acme".into(),
                    state: "planned".into(),
                },
                JournalEntry {
                    old_folder: "vanished".into(),
                    new_folder: "vanished--acme".into(),
                    old_source_id: stable_id("source", "vanished"),
                    new_source_id: stable_id("source", "vanished--acme"),
                    old_parent: "vanished".into(),
                    new_parent: "vanished--acme".into(),
                    state: "planned".into(),
                },
            ],
            completed: false,
        };
        write_journal(&library.root, &journal).unwrap();
        let error = resume(&library.root, &mut connection, journal).unwrap_err();
        assert!(error.contains("已恢复"), "{error}");
        assert!(library.sources().join("alpha").is_dir());
        assert!(!library.sources().join("alpha--acme").exists());
        assert!(read_journal(&library.root).is_none());
    }

    /// Read-only audit of a real library: copy its SQLite file first, then
    /// `AI_SKILLHUB_IDENTITY_AUDIT_DB=<copy> AI_SKILLHUB_IDENTITY_AUDIT_SOURCES=<sources>
    /// cargo test --lib identity_audit -- --ignored --nocapture`.
    #[test]
    #[ignore = "reads a real user library; run manually against a database copy"]
    fn identity_audit_of_real_library_is_read_only() {
        let (Ok(database), Ok(sources)) = (
            std::env::var("AI_SKILLHUB_IDENTITY_AUDIT_DB"),
            std::env::var("AI_SKILLHUB_IDENTITY_AUDIT_SOURCES"),
        ) else {
            return;
        };
        let connection =
            Connection::open_with_flags(&database, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
                .unwrap();
        let plan = build_plan_in(Path::new(&sources), &connection).unwrap();
        for entry in &plan.entries {
            println!(
                "{:9} | {:48} | {:32} -> {:40} | {}",
                entry.action,
                entry.folder,
                entry.current_parent,
                entry.target_parent,
                entry.reasons.join(" / ")
            );
        }
        println!(
            "rename={} aligned={} attention={}",
            plan.rename_count, plan.aligned_count, plan.attention_count
        );
    }

    #[test]
    fn target_folder_is_lowercase_owner_double_dash_repo() {
        assert_eq!(
            target_folder_for("mattpocock/skills").as_deref(),
            Some("skills--mattpocock")
        );
        assert_eq!(target_folder_for("bad"), None);
        // Dots and underscores are folder-safe but not invocation-safe: the
        // parent name gets a stable digest, exactly like every other parent.
        let parent = router_hub_skill_name("my.repo_name--owner");
        assert!(parent.starts_with("my-repo-name-owner-"));
        assert!(parent.len() <= 64);
        assert_eq!(parent, router_hub_skill_name("my.repo_name--owner"));
    }
}
