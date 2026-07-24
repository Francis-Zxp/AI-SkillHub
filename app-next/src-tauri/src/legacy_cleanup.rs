//! User-facing cleanup for portable v3 leftovers.
//!
//! The cleanup assistant is deliberately allowlist-only. It never discovers
//! arbitrary folders, never follows links while measuring/copying/removing a
//! candidate, and only becomes available after v4 migration and the stable
//! SQLite index have both been verified.

use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_INVENTORY_ENTRIES: u64 = 500_000;
const LINK_MANIFEST_SUFFIX: &str = "-links.json";
const OPERATION_MANIFEST_SUFFIX: &str = "-operation.json";

#[derive(Debug, Clone)]
pub(crate) struct LegacyCleanupConfig {
    pub project_root: PathBuf,
    pub user_data_root: PathBuf,
    pub migration_manifest: PathBuf,
    pub current_database: PathBuf,
    pub backup_root: PathBuf,
}

impl LegacyCleanupConfig {
    pub(crate) fn new(
        project_root: impl Into<PathBuf>,
        user_data_root: impl Into<PathBuf>,
        migration_manifest: impl Into<PathBuf>,
        current_database: impl Into<PathBuf>,
        backup_root: impl Into<PathBuf>,
    ) -> Self {
        Self {
            project_root: project_root.into(),
            user_data_root: user_data_root.into(),
            migration_manifest: migration_manifest.into(),
            current_database: current_database.into(),
            backup_root: backup_root.into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LegacyCleanupCandidateCard {
    pub id: String,
    pub name: String,
    pub reason: String,
    pub path: String,
    pub total_bytes: u64,
    pub file_count: u64,
    pub directory_count: u64,
    pub link_count: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LegacyCleanupOperationCard {
    pub candidate_id: String,
    pub original_path: String,
    pub backup_path: String,
    pub total_bytes: u64,
    pub file_count: u64,
    pub link_count: u64,
    pub recoverable: bool,
    pub detail: String,
}

#[derive(Debug, Clone, Copy)]
struct CandidateSpec {
    id: &'static str,
    name: &'static str,
    reason: &'static str,
    relative_components: &'static [&'static str],
}

const CANDIDATE_SPECS: &[CandidateSpec] = &[
    CandidateSpec {
        id: "portable-skills-view",
        name: "旧版 Skills 链接视图",
        reason: "旧便携版在项目目录维护的链接视图；稳定版已改用用户数据目录。",
        relative_components: &["skills"],
    },
    CandidateSpec {
        id: "portable-private-index",
        name: "旧版本地索引",
        reason: "旧便携版的索引、报告与临时状态；v4 迁移完成后不再作为当前数据源。",
        relative_components: &["app-next", ".skillhub-next"],
    },
    CandidateSpec {
        id: "portable-source-cache",
        name: "旧版来源副本",
        reason: "旧便携版保存在项目目录的来源副本；稳定版来源已迁移到用户数据目录。",
        relative_components: &["app-next", "data", "github_sources"],
    },
];

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct TreeInventory {
    total_bytes: u64,
    file_count: u64,
    directory_count: u64,
    link_count: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredLink {
    relative_path: String,
    target: String,
    directory_link: bool,
}

pub(crate) fn list_legacy_cleanup_candidates(
    config: &LegacyCleanupConfig,
) -> Result<Vec<LegacyCleanupCandidateCard>, String> {
    let Some(boundaries) = verified_boundaries(config)? else {
        return Ok(Vec::new());
    };

    let mut candidates = Vec::new();
    for spec in CANDIDATE_SPECS {
        let candidate_path = candidate_path(&config.project_root, spec);
        if !candidate_path.exists() {
            continue;
        }
        let Ok(candidate_canonical) = canonical_existing(&candidate_path, "旧版候选路径")
        else {
            continue;
        };
        if validate_candidate_boundary(
            &candidate_canonical,
            &boundaries.project_root,
            &boundaries.user_data_root,
        )
        .is_err()
        {
            // A moved junction or manually replaced folder must never turn the
            // assistant into an arbitrary filesystem browser.
            continue;
        }
        let Ok(inventory) = inventory_tree(
            &candidate_path,
            &candidate_canonical,
            &boundaries.project_root,
        ) else {
            continue;
        };
        candidates.push(LegacyCleanupCandidateCard {
            id: spec.id.to_string(),
            name: spec.name.to_string(),
            reason: spec.reason.to_string(),
            path: candidate_path.to_string_lossy().into_owned(),
            total_bytes: inventory.total_bytes,
            file_count: inventory.file_count,
            directory_count: inventory.directory_count,
            link_count: inventory.link_count,
        });
    }
    Ok(candidates)
}

pub(crate) fn move_legacy_cleanup_candidate(
    config: &LegacyCleanupConfig,
    candidate_id: &str,
) -> Result<LegacyCleanupOperationCard, String> {
    let boundaries = verified_boundaries(config)?
        .ok_or_else(|| "旧版数据迁移尚未完成，当前不能整理旧文件。".to_string())?;
    let spec = candidate_spec(candidate_id)
        .ok_or_else(|| "不支持整理这个路径；清理助手只处理明确列出的旧版残留。".to_string())?;
    let source = candidate_path(&config.project_root, spec);
    if !source.exists() {
        return Err("这个旧版残留已不存在，请重新打开设置页检查。".to_string());
    }
    let source_canonical = canonical_existing(&source, "旧版候选路径")?;
    validate_candidate_boundary(
        &source_canonical,
        &boundaries.project_root,
        &boundaries.user_data_root,
    )?;
    let before = inventory_tree(&source, &source_canonical, &boundaries.project_root)?;

    let backup_root = prepare_backup_root(config, &boundaries.user_data_root)?;
    let session = unique_backup_session(&backup_root)?;
    fs::create_dir_all(&session)
        .map_err(|error| format!("无法创建旧版备份目录 {}：{error}", session.display()))?;
    let backup = session.join(spec.id);

    let used_rename = match fs::rename(&source, &backup) {
        Ok(()) => true,
        Err(_) => {
            copy_then_remove(
                &source,
                &source_canonical,
                &backup,
                &boundaries.project_root,
                before,
            )?;
            false
        }
    };

    if !backup.exists() {
        return Err(format!("旧版备份未生成：{}", backup.display()));
    }
    let operation = LegacyCleanupOperationCard {
        candidate_id: spec.id.to_string(),
        original_path: source.to_string_lossy().into_owned(),
        backup_path: backup.to_string_lossy().into_owned(),
        total_bytes: before.total_bytes,
        file_count: before.file_count,
        link_count: before.link_count,
        recoverable: true,
        detail: if used_rename {
            "旧版残留已整体移动到用户数据备份区，没有永久删除。".to_string()
        } else {
            "旧版残留已安全复制并核对后移入用户数据备份区，没有永久删除。".to_string()
        },
    };
    write_operation_manifest(&backup, &operation)?;
    Ok(operation)
}

#[derive(Debug)]
struct VerifiedBoundaries {
    project_root: PathBuf,
    user_data_root: PathBuf,
}

fn verified_boundaries(config: &LegacyCleanupConfig) -> Result<Option<VerifiedBoundaries>, String> {
    let project_root = canonical_existing(&config.project_root, "项目根目录")?;
    let user_data_root = canonical_existing(&config.user_data_root, "用户数据目录")?;
    if paths_overlap(&project_root, &user_data_root) {
        return Err("用户数据目录不能与项目根目录重叠，已停止旧版清理。".to_string());
    }

    let manifest_canonical = match fs::canonicalize(&config.migration_manifest) {
        Ok(path) => path,
        Err(_) => return Ok(None),
    };
    if !manifest_canonical.starts_with(&user_data_root)
        || !migration_manifest_is_complete(&manifest_canonical)
    {
        return Ok(None);
    }

    let database_canonical = match fs::canonicalize(&config.current_database) {
        Ok(path) => path,
        Err(_) => return Ok(None),
    };
    if !database_canonical.starts_with(&user_data_root)
        || !stable_database_is_healthy(&database_canonical)
    {
        return Ok(None);
    }
    Ok(Some(VerifiedBoundaries {
        project_root,
        user_data_root,
    }))
}

fn migration_manifest_is_complete(path: &Path) -> bool {
    let Ok(raw) = fs::read_to_string(path) else {
        return false;
    };
    let Ok(value) = serde_json::from_str::<Value>(raw.trim_start_matches('\u{feff}')) else {
        return false;
    };
    let schema_ok = value.get("schemaVersion").and_then(Value::as_u64) == Some(4);
    let completed = value
        .get("completedAt")
        .and_then(Value::as_str)
        .is_some_and(|value| !value.trim().is_empty());
    let not_dry_run = !value.get("dryRun").and_then(Value::as_bool).unwrap_or(true);
    let source_summary = value.pointer("/sourceRecovery/summary");
    let no_failed_sources = source_summary
        .and_then(|summary| summary.get("failed"))
        .and_then(Value::as_u64)
        .unwrap_or(1)
        == 0;
    let no_pending_repairs = source_summary
        .and_then(|summary| summary.get("repairNeeded"))
        .and_then(Value::as_u64)
        .unwrap_or(1)
        == 0;
    let metadata_ok = matches!(
        value
            .pointer("/metadataMerge/status")
            .and_then(Value::as_str),
        Some("merged" | "skipped-no-legacy-database" | "skipped-same-database")
    );
    schema_ok && completed && not_dry_run && no_failed_sources && no_pending_repairs && metadata_ok
}

fn stable_database_is_healthy(path: &Path) -> bool {
    let Ok(connection) = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) else {
        return false;
    };
    let quick_check =
        connection.query_row("PRAGMA quick_check(1)", [], |row| row.get::<_, String>(0));
    if !matches!(quick_check, Ok(result) if result.eq_ignore_ascii_case("ok")) {
        return false;
    }
    ["sources", "skills", "audit_events"].iter().all(|table| {
        connection
            .query_row(
                "SELECT EXISTS(
                    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1
                )",
                [table],
                |row| row.get::<_, i64>(0),
            )
            .is_ok_and(|exists| exists == 1)
    })
}

fn candidate_spec(candidate_id: &str) -> Option<&'static CandidateSpec> {
    CANDIDATE_SPECS
        .iter()
        .find(|spec| spec.id.eq_ignore_ascii_case(candidate_id.trim()))
}

fn candidate_path(project_root: &Path, spec: &CandidateSpec) -> PathBuf {
    spec.relative_components
        .iter()
        .fold(project_root.to_path_buf(), |path, part| path.join(part))
}

fn canonical_existing(path: &Path, label: &str) -> Result<PathBuf, String> {
    fs::canonicalize(path).map_err(|error| format!("无法验证{label} {}：{error}", path.display()))
}

fn validate_candidate_boundary(
    candidate: &Path,
    project_root: &Path,
    user_data_root: &Path,
) -> Result<(), String> {
    if candidate == project_root || !candidate.starts_with(project_root) {
        return Err("候选路径不在 AI SkillHub 项目目录内，已拒绝处理。".to_string());
    }
    if candidate.starts_with(user_data_root) || user_data_root.starts_with(candidate) {
        return Err("候选路径与当前用户数据目录重叠，已拒绝处理。".to_string());
    }
    if candidate
        .strip_prefix(project_root)
        .ok()
        .and_then(|relative| relative.components().next())
        .is_some_and(|component| {
            component
                .as_os_str()
                .to_string_lossy()
                .eq_ignore_ascii_case("release")
        })
    {
        return Err("release 目录始终由用户手动管理，清理助手不会处理。".to_string());
    }
    Ok(())
}

fn paths_overlap(left: &Path, right: &Path) -> bool {
    left.starts_with(right) || right.starts_with(left)
}

fn inventory_tree(
    display_root: &Path,
    canonical_root: &Path,
    project_root: &Path,
) -> Result<TreeInventory, String> {
    let root_metadata = fs::symlink_metadata(display_root)
        .map_err(|error| format!("无法读取旧版候选 {}：{error}", display_root.display()))?;
    if metadata_is_link(&root_metadata) {
        return Ok(TreeInventory {
            link_count: 1,
            ..TreeInventory::default()
        });
    }
    if root_metadata.is_file() {
        return Ok(TreeInventory {
            total_bytes: root_metadata.len(),
            file_count: 1,
            ..TreeInventory::default()
        });
    }

    let mut inventory = TreeInventory {
        directory_count: 1,
        ..TreeInventory::default()
    };
    let mut stack = vec![display_root.to_path_buf()];
    while let Some(directory) = stack.pop() {
        let entries = fs::read_dir(&directory)
            .map_err(|error| format!("无法读取旧版目录 {}：{error}", directory.display()))?;
        for entry in entries {
            let entry = entry
                .map_err(|error| format!("无法读取旧版目录项 {}：{error}", directory.display()))?;
            let metadata = fs::symlink_metadata(entry.path()).map_err(|error| {
                format!("无法检查旧版目录项 {}：{error}", entry.path().display())
            })?;
            let visited = inventory.file_count + inventory.directory_count + inventory.link_count;
            if visited >= MAX_INVENTORY_ENTRIES {
                return Err("旧版残留超过安全检查上限，已停止处理。".to_string());
            }
            if metadata_is_link(&metadata) {
                inventory.link_count += 1;
            } else if metadata.is_dir() {
                let canonical = canonical_existing(&entry.path(), "旧版子目录")?;
                if !canonical.starts_with(canonical_root) || !canonical.starts_with(project_root) {
                    return Err("旧版目录包含指向项目外部的子目录，已停止处理。".to_string());
                }
                inventory.directory_count += 1;
                stack.push(entry.path());
            } else if metadata.is_file() {
                inventory.file_count += 1;
                inventory.total_bytes = inventory.total_bytes.saturating_add(metadata.len());
            }
        }
    }
    Ok(inventory)
}

fn prepare_backup_root(
    config: &LegacyCleanupConfig,
    user_data_root: &Path,
) -> Result<PathBuf, String> {
    if !config.backup_root.starts_with(&config.user_data_root) {
        return Err("旧版备份目录不在当前用户数据目录内，已停止处理。".to_string());
    }
    fs::create_dir_all(&config.backup_root).map_err(|error| {
        format!(
            "无法创建旧版备份根目录 {}：{error}",
            config.backup_root.display()
        )
    })?;
    let canonical = canonical_existing(&config.backup_root, "旧版备份根目录")?;
    if canonical == user_data_root || !canonical.starts_with(user_data_root) {
        return Err("旧版备份目录验证失败，已停止处理。".to_string());
    }
    Ok(canonical)
}

fn unique_backup_session(backup_root: &Path) -> Result<PathBuf, String> {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("无法生成旧版备份时间：{error}"))?
        .as_millis();
    for suffix in 0..100u32 {
        let name = if suffix == 0 {
            timestamp.to_string()
        } else {
            format!("{timestamp}-{suffix}")
        };
        let candidate = backup_root.join(name);
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err("无法为旧版备份分配唯一目录。".to_string())
}

fn copy_then_remove(
    source: &Path,
    source_canonical: &Path,
    backup: &Path,
    project_root: &Path,
    expected: TreeInventory,
) -> Result<(), String> {
    let parent = backup
        .parent()
        .ok_or_else(|| "无法确定旧版备份目录。".to_string())?;
    let staging = parent.join(format!(
        ".{}-copying",
        backup
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("legacy")
    ));
    if staging.exists() || backup.exists() {
        return Err("旧版备份暂存目录已存在，已停止处理。".to_string());
    }
    fs::create_dir_all(&staging)
        .map_err(|error| format!("无法创建旧版备份暂存目录 {}：{error}", staging.display()))?;

    let mut stored_links = Vec::new();
    if let Err(error) = copy_tree_without_links(
        source,
        source,
        &staging,
        source_canonical,
        project_root,
        &mut stored_links,
    ) {
        let _ = remove_tree_without_following(&staging, parent);
        return Err(error);
    }
    let staging_canonical = canonical_existing(&staging, "旧版备份暂存目录")?;
    let copied = inventory_tree(&staging, &staging_canonical, &staging_canonical)?;
    if copied.total_bytes != expected.total_bytes
        || copied.file_count != expected.file_count
        || copied.directory_count != expected.directory_count
        || stored_links.len() as u64 != expected.link_count
    {
        let _ = remove_tree_without_following(&staging, parent);
        return Err("旧版备份核对失败，原目录保持不变。".to_string());
    }
    fs::rename(&staging, backup)
        .map_err(|error| format!("无法完成旧版备份 {}：{error}", backup.display()))?;
    if !stored_links.is_empty() {
        let link_manifest = serde_json::to_string_pretty(&stored_links)
            .map_err(|error| format!("无法生成旧版链接清单：{error}"))?;
        let link_manifest_path = parent.join(format!(
            "{}{}",
            backup
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("legacy"),
            LINK_MANIFEST_SUFFIX
        ));
        fs::write(&link_manifest_path, format!("{link_manifest}\n")).map_err(|error| {
            format!(
                "无法写入旧版链接清单 {}：{error}",
                link_manifest_path.display()
            )
        })?;
    }

    let current_canonical = canonical_existing(source, "待整理旧版目录")?;
    if current_canonical != source_canonical {
        return Err("旧版目录在备份过程中发生变化，已保留原目录与备份。".to_string());
    }
    let current = inventory_tree(source, source_canonical, project_root)?;
    if current != expected {
        return Err("旧版目录在备份过程中发生变化，已保留原目录与备份。".to_string());
    }
    remove_tree_without_following(source, project_root)
        .map_err(|error| format!("备份已完成，但无法移走旧版目录：{error}"))
}

fn copy_tree_without_links(
    source_root: &Path,
    current: &Path,
    destination_root: &Path,
    source_canonical: &Path,
    project_root: &Path,
    stored_links: &mut Vec<StoredLink>,
) -> Result<(), String> {
    let entries = fs::read_dir(current)
        .map_err(|error| format!("无法读取旧版目录 {}：{error}", current.display()))?;
    for entry in entries {
        let entry =
            entry.map_err(|error| format!("无法读取旧版目录项 {}：{error}", current.display()))?;
        let source_path = entry.path();
        let relative = source_path
            .strip_prefix(source_root)
            .map_err(|_| "无法计算旧版备份相对路径。".to_string())?;
        let destination = destination_root.join(relative);
        let metadata = fs::symlink_metadata(&source_path)
            .map_err(|error| format!("无法检查旧版目录项 {}：{error}", source_path.display()))?;
        if metadata_is_link(&metadata) {
            let target = fs::read_link(&source_path).map_err(|error| {
                format!(
                    "无法读取旧版链接 {}，原目录保持不变：{error}",
                    source_path.display()
                )
            })?;
            stored_links.push(StoredLink {
                relative_path: relative.to_string_lossy().replace('\\', "/"),
                target: target.to_string_lossy().into_owned(),
                directory_link: fs::metadata(&source_path)
                    .map(|target_metadata| target_metadata.is_dir())
                    .unwrap_or(false),
            });
        } else if metadata.is_dir() {
            let canonical = canonical_existing(&source_path, "旧版子目录")?;
            if !canonical.starts_with(source_canonical) || !canonical.starts_with(project_root) {
                return Err("旧版目录包含项目外部内容，原目录保持不变。".to_string());
            }
            fs::create_dir_all(&destination).map_err(|error| {
                format!("无法创建旧版备份目录 {}：{error}", destination.display())
            })?;
            copy_tree_without_links(
                source_root,
                &source_path,
                destination_root,
                source_canonical,
                project_root,
                stored_links,
            )?;
        } else if metadata.is_file() {
            if let Some(parent) = destination.parent() {
                fs::create_dir_all(parent).map_err(|error| {
                    format!("无法创建旧版备份目录 {}：{error}", parent.display())
                })?;
            }
            fs::copy(&source_path, &destination).map_err(|error| {
                format!(
                    "无法备份旧版文件 {} 到 {}：{error}",
                    source_path.display(),
                    destination.display()
                )
            })?;
        }
    }
    Ok(())
}

fn remove_tree_without_following(path: &Path, boundary: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("无法检查待移走路径 {}：{error}", path.display()))?;
    if metadata_is_link(&metadata) {
        return remove_link(path);
    }
    if metadata.is_file() {
        return fs::remove_file(path)
            .map_err(|error| format!("无法移走文件 {}：{error}", path.display()));
    }
    let canonical = canonical_existing(path, "待移走目录")?;
    let boundary = canonical_existing(boundary, "清理边界")?;
    if canonical == boundary || !canonical.starts_with(&boundary) {
        return Err("待移走目录超出允许边界。".to_string());
    }
    for entry in fs::read_dir(path)
        .map_err(|error| format!("无法读取待移走目录 {}：{error}", path.display()))?
    {
        let entry =
            entry.map_err(|error| format!("无法读取待移走目录项 {}：{error}", path.display()))?;
        remove_tree_without_following(&entry.path(), &boundary)?;
    }
    fs::remove_dir(path).map_err(|error| format!("无法移走目录 {}：{error}", path.display()))
}

fn remove_link(path: &Path) -> Result<(), String> {
    let directory_target = fs::metadata(path)
        .map(|metadata| metadata.is_dir())
        .unwrap_or(false);
    let first = if directory_target {
        fs::remove_dir(path)
    } else {
        fs::remove_file(path)
    };
    if first.is_ok() {
        return Ok(());
    }
    let second = if directory_target {
        fs::remove_file(path)
    } else {
        fs::remove_dir(path)
    };
    second.map_err(|error| format!("无法移走旧版链接 {}：{error}", path.display()))
}

fn write_operation_manifest(
    backup: &Path,
    operation: &LegacyCleanupOperationCard,
) -> Result<(), String> {
    let manifest = serde_json::to_string_pretty(operation)
        .map_err(|error| format!("无法生成旧版备份记录：{error}"))?;
    let parent = backup
        .parent()
        .ok_or_else(|| "无法确定旧版备份记录目录。".to_string())?;
    let manifest_path = parent.join(format!(
        "{}{}",
        backup
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("legacy"),
        OPERATION_MANIFEST_SUFFIX
    ));
    fs::write(&manifest_path, format!("{manifest}\n"))
        .map_err(|error| format!("无法写入旧版备份记录 {}：{error}", manifest_path.display()))
}

#[cfg(target_os = "windows")]
fn metadata_is_link(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
    metadata.file_type().is_symlink()
        || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(target_os = "windows"))]
fn metadata_is_link(metadata: &fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use std::collections::HashSet;

    fn test_root(name: &str) -> PathBuf {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        std::env::temp_dir().join(format!("skillhub-legacy-cleanup-{name}-{now}"))
    }

    fn create_healthy_database(path: &Path) {
        fs::create_dir_all(path.parent().expect("database parent")).expect("database parent");
        let connection = Connection::open(path).expect("database");
        connection
            .execute_batch(
                "CREATE TABLE sources (id TEXT PRIMARY KEY);
                 CREATE TABLE skills (id TEXT PRIMARY KEY);
                 CREATE TABLE audit_events (id TEXT PRIMARY KEY);",
            )
            .expect("schema");
    }

    fn write_complete_manifest(path: &Path) {
        fs::create_dir_all(path.parent().expect("manifest parent")).expect("manifest parent");
        fs::write(
            path,
            r#"{
              "schemaVersion": 4,
              "dryRun": false,
              "completedAt": "100",
              "sourceRecovery": {
                "summary": { "failed": 0, "repairNeeded": 0 }
              },
              "metadataMerge": { "status": "merged" }
            }"#,
        )
        .expect("manifest");
    }

    fn config(root: &Path) -> LegacyCleanupConfig {
        let user_data = root.parent().expect("parent").join(format!(
            "{}-userdata",
            root.file_name().expect("root name").to_string_lossy()
        ));
        fs::create_dir_all(&user_data).expect("user data");
        let manifest = user_data.join("migration-v4.json");
        let database = user_data.join("state").join("skillhub-next.sqlite3");
        LegacyCleanupConfig::new(
            root,
            &user_data,
            &manifest,
            &database,
            user_data
                .join("state")
                .join("backups")
                .join("legacy-cleanup"),
        )
    }

    fn make_eligible(config: &LegacyCleanupConfig) {
        write_complete_manifest(&config.migration_manifest);
        create_healthy_database(&config.current_database);
    }

    fn cleanup_test_paths(config: &LegacyCleanupConfig) {
        if config.project_root.exists() {
            let _ = fs::remove_dir_all(&config.project_root);
        }
        if config.user_data_root.exists() {
            let _ = fs::remove_dir_all(&config.user_data_root);
        }
    }

    #[test]
    fn incomplete_manifest_never_lists_candidates() {
        let root = test_root("incomplete");
        fs::create_dir_all(root.join("skills")).expect("legacy candidate");
        let config = config(&root);
        create_healthy_database(&config.current_database);
        fs::write(
            &config.migration_manifest,
            r#"{
              "schemaVersion": 4,
              "dryRun": false,
              "completedAt": "",
              "sourceRecovery": {
                "summary": { "failed": 0, "repairNeeded": 0 }
              },
              "metadataMerge": { "status": "merged" }
            }"#,
        )
        .expect("incomplete manifest");

        let candidates = list_legacy_cleanup_candidates(&config).expect("candidate preview");
        assert!(candidates.is_empty());
        cleanup_test_paths(&config);
    }

    #[test]
    fn release_is_never_a_cleanup_candidate() {
        let root = test_root("release");
        fs::create_dir_all(root.join("release").join("AI SkillHub")).expect("release");
        fs::create_dir_all(root.join("skills")).expect("legacy candidate");
        let config = config(&root);
        make_eligible(&config);

        let candidates = list_legacy_cleanup_candidates(&config).expect("candidate preview");
        assert_eq!(candidates.len(), 1);
        let release_canonical = fs::canonicalize(root.join("release")).expect("release canonical");
        assert!(candidates.iter().all(|candidate| {
            fs::canonicalize(&candidate.path)
                .map(|path| !path.starts_with(&release_canonical))
                .unwrap_or(false)
        }));
        assert!(root.join("release").exists());
        cleanup_test_paths(&config);
    }

    #[test]
    fn path_outside_project_root_is_rejected() {
        let root = test_root("outside");
        let outside = root
            .parent()
            .expect("parent")
            .join("skillhub-cleanup-outside");
        fs::create_dir_all(&root).expect("root");
        fs::create_dir_all(&outside).expect("outside");
        let config = config(&root);
        let root_canonical = fs::canonicalize(&root).expect("root canonical");
        let outside_canonical = fs::canonicalize(&outside).expect("outside canonical");
        let user_data_canonical =
            fs::canonicalize(&config.user_data_root).expect("user data canonical");

        let error =
            validate_candidate_boundary(&outside_canonical, &root_canonical, &user_data_canonical)
                .expect_err("outside path must be rejected");
        assert!(error.contains("项目目录"));
        cleanup_test_paths(&config);
        let _ = fs::remove_dir_all(outside);
    }

    #[test]
    fn cleanup_moves_candidate_to_a_recoverable_user_backup() {
        let root = test_root("recoverable");
        let candidate = root.join("app-next").join(".skillhub-next");
        fs::create_dir_all(candidate.join("reports")).expect("candidate");
        fs::write(candidate.join("reports").join("old.json"), b"legacy-state")
            .expect("legacy file");
        let config = config(&root);
        make_eligible(&config);

        let operation =
            move_legacy_cleanup_candidate(&config, "portable-private-index").expect("cleanup");
        let backup = PathBuf::from(&operation.backup_path);
        assert!(!candidate.exists());
        assert!(backup.join("reports").join("old.json").is_file());
        assert!(backup
            .parent()
            .expect("backup session")
            .join(format!(
                "{}{}",
                backup.file_name().expect("backup name").to_string_lossy(),
                OPERATION_MANIFEST_SUFFIX
            ))
            .is_file());
        assert!(operation.recoverable);
        assert!(backup
            .starts_with(fs::canonicalize(&config.backup_root).expect("backup root canonical")));

        // A same-volume backup can be restored without reconstructing content.
        fs::create_dir_all(candidate.parent().expect("candidate parent"))
            .expect("candidate parent");
        fs::rename(&backup, &candidate).expect("restore backup");
        assert_eq!(
            fs::read(candidate.join("reports").join("old.json")).expect("restored file"),
            b"legacy-state"
        );
        cleanup_test_paths(&config);
    }

    #[test]
    fn allowlist_has_no_duplicate_ids_and_never_contains_release() {
        let mut ids = HashSet::new();
        for spec in CANDIDATE_SPECS {
            assert!(ids.insert(spec.id));
            assert!(spec
                .relative_components
                .iter()
                .all(|part| !part.eq_ignore_ascii_case("release")));
        }
    }
}
