//! Resumable, non-overwriting v4 migration support.
//!
//! This module deliberately has no knowledge of Tauri state or the process
//! environment. Callers provide every path explicitly, which keeps dry-runs
//! testable and prevents a migration from accidentally targeting a guessed
//! user-data directory.

use rusqlite::{params, Connection, OpenFlags, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::error::Error;
use std::fmt::{Display, Formatter};
use std::fs;
use std::hash::{Hash, Hasher};
use std::io::{self, Read};
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub const MIGRATION_V4_SCHEMA_VERSION: u32 = 4;
const COPY_TEMP_SUFFIX: &str = ".migration-v4-copying";

#[derive(Debug, Clone)]
pub struct MigrationV4Config {
    pub legacy_sources_root: PathBuf,
    pub current_sources_root: PathBuf,
    pub staging_root: PathBuf,
    pub legacy_database_path: Option<PathBuf>,
    pub current_database_path: Option<PathBuf>,
    pub database_backup_root: PathBuf,
    pub manifest_path: PathBuf,
    pub dry_run: bool,
}

impl MigrationV4Config {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        legacy_sources_root: impl Into<PathBuf>,
        current_sources_root: impl Into<PathBuf>,
        staging_root: impl Into<PathBuf>,
        legacy_database_path: Option<PathBuf>,
        current_database_path: Option<PathBuf>,
        database_backup_root: impl Into<PathBuf>,
        manifest_path: impl Into<PathBuf>,
        dry_run: bool,
    ) -> Self {
        Self {
            legacy_sources_root: legacy_sources_root.into(),
            current_sources_root: current_sources_root.into(),
            staging_root: staging_root.into(),
            legacy_database_path,
            current_database_path,
            database_backup_root: database_backup_root.into(),
            manifest_path: manifest_path.into(),
            dry_run,
        }
    }
}

#[derive(Debug, Clone)]
pub struct MigrationV4Error {
    pub stage: String,
    pub message: String,
}

impl MigrationV4Error {
    fn new(stage: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            stage: stage.into(),
            message: message.into(),
        }
    }

    fn io(stage: impl Into<String>, path: &Path, error: io::Error) -> Self {
        Self::new(stage, format!("{}: {}", path.to_string_lossy(), error))
    }

    fn sqlite(stage: impl Into<String>, error: rusqlite::Error) -> Self {
        Self::new(stage, error.to_string())
    }
}

impl Display for MigrationV4Error {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}: {}", self.stage, self.message)
    }
}

impl Error for MigrationV4Error {}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TreeInventory {
    pub file_count: u64,
    pub skill_md_count: u64,
    pub total_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SourceRecoveryStatus {
    WouldPromote,
    Promoted,
    KeptCurrent,
    RepairNeeded,
    SourceInvalid,
    StagingConflict,
    CopyFailed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceRecoveryEntry {
    pub source_name: String,
    pub legacy_path: String,
    pub target_path: String,
    pub staging_path: Option<String>,
    pub status: SourceRecoveryStatus,
    pub resumed: bool,
    pub legacy_inventory: Option<TreeInventory>,
    pub target_inventory: Option<TreeInventory>,
    pub legacy_git_head: Option<String>,
    pub target_git_head: Option<String>,
    pub backup_path: Option<String>,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SourceRecoverySummary {
    pub discovered: usize,
    pub would_promote: usize,
    pub promoted: usize,
    pub resumed: usize,
    pub kept_current: usize,
    pub repair_needed: usize,
    pub invalid: usize,
    pub failed: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceRecoveryReport {
    pub dry_run: bool,
    pub legacy_root: String,
    pub current_root: String,
    pub staging_root: String,
    pub summary: SourceRecoverySummary,
    pub entries: Vec<SourceRecoveryEntry>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum MetadataMergeStatus {
    Merged,
    DryRun,
    SkippedNoLegacyDatabase,
    SkippedNoCurrentDatabase,
    SkippedSameDatabase,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MetadataMergeReport {
    pub status: MetadataMergeStatus,
    pub dry_run: bool,
    pub legacy_database: Option<String>,
    pub current_database: Option<String>,
    pub backup_path: Option<String>,
    pub would_backup: bool,
    pub source_overrides_merged: usize,
    pub skill_overrides_merged: usize,
    pub tags_merged: usize,
    pub source_tag_overrides_merged: usize,
    pub skill_tag_overrides_merged: usize,
    pub usage_events_merged: usize,
    pub deferred_tag_overrides: usize,
    pub detail: String,
}

impl MetadataMergeReport {
    fn skipped(
        status: MetadataMergeStatus,
        config: &MigrationV4Config,
        detail: impl Into<String>,
    ) -> Self {
        Self {
            status,
            dry_run: config.dry_run,
            legacy_database: path_option_to_string(config.legacy_database_path.as_deref()),
            current_database: path_option_to_string(config.current_database_path.as_deref()),
            backup_path: None,
            would_backup: false,
            source_overrides_merged: 0,
            skill_overrides_merged: 0,
            tags_merged: 0,
            source_tag_overrides_merged: 0,
            skill_tag_overrides_merged: 0,
            usage_events_merged: 0,
            deferred_tag_overrides: 0,
            detail: detail.into(),
        }
    }

    #[cfg(test)]
    fn failed(config: &MigrationV4Config, detail: impl Into<String>) -> Self {
        let mut report = Self::skipped(MetadataMergeStatus::Failed, config, detail);
        report.would_backup = config
            .current_database_path
            .as_deref()
            .is_some_and(Path::exists);
        report
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationV4Report {
    pub schema_version: u32,
    pub attempt: u32,
    pub dry_run: bool,
    pub started_at: String,
    pub completed_at: String,
    pub manifest_path: String,
    pub source_recovery: SourceRecoveryReport,
    pub metadata_merge: MetadataMergeReport,
    pub warnings: Vec<String>,
}

/// Runs both phases and, unless this is a dry-run, writes `migration-v4.json`.
///
/// It is safe to call this repeatedly. Sources that were already promoted are
/// never overwritten, and incomplete per-source staging directories are
/// resumed after their ownership marker is verified.
#[cfg(test)]
pub fn run_migration_v4(config: &MigrationV4Config) -> Result<MigrationV4Report, MigrationV4Error> {
    let source_recovery = recover_sources_v4(config)?;
    let metadata_merge = match merge_legacy_metadata_v4(config) {
        Ok(report) => report,
        Err(error) => MetadataMergeReport::failed(config, error.to_string()),
    };
    finalize_migration_v4_report(config, source_recovery, metadata_merge)
}

/// Finalizes and persists a report when the caller runs the two migration
/// phases around its own re-index step.
///
/// Recommended integration order:
/// `recover_sources_v4` -> re-index current sources ->
/// `merge_legacy_metadata_v4` -> `finalize_migration_v4_report`.
pub fn finalize_migration_v4_report(
    config: &MigrationV4Config,
    source_recovery: SourceRecoveryReport,
    metadata_merge: MetadataMergeReport,
) -> Result<MigrationV4Report, MigrationV4Error> {
    let (attempt, mut warnings) = next_manifest_attempt(&config.manifest_path);
    warnings.extend(source_recovery.warnings.iter().cloned());
    if metadata_merge.status == MetadataMergeStatus::Failed {
        warnings.push(metadata_merge.detail.clone());
    }
    let report = MigrationV4Report {
        schema_version: MIGRATION_V4_SCHEMA_VERSION,
        attempt,
        dry_run: config.dry_run,
        started_at: unix_timestamp_string(),
        completed_at: unix_timestamp_string(),
        manifest_path: config.manifest_path.to_string_lossy().into_owned(),
        source_recovery,
        metadata_merge,
        warnings,
    };

    if !config.dry_run {
        write_migration_v4_manifest(&config.manifest_path, &report)?;
    }

    Ok(report)
}

/// Recovers every top-level legacy source independently.
///
/// This phase never opens either SQLite database and never replaces an
/// existing destination directory.
pub fn recover_sources_v4(
    config: &MigrationV4Config,
) -> Result<SourceRecoveryReport, MigrationV4Error> {
    let mut report = SourceRecoveryReport {
        dry_run: config.dry_run,
        legacy_root: config.legacy_sources_root.to_string_lossy().into_owned(),
        current_root: config.current_sources_root.to_string_lossy().into_owned(),
        staging_root: config.staging_root.to_string_lossy().into_owned(),
        summary: SourceRecoverySummary::default(),
        entries: Vec::new(),
        warnings: Vec::new(),
    };

    if !config.legacy_sources_root.exists() {
        report.warnings.push(format!(
            "Legacy source root does not exist: {}",
            config.legacy_sources_root.to_string_lossy()
        ));
        return Ok(report);
    }

    if !config.legacy_sources_root.is_dir() {
        return Err(MigrationV4Error::new(
            "enumerate legacy sources",
            format!(
                "Legacy source root is not a directory: {}",
                config.legacy_sources_root.to_string_lossy()
            ),
        ));
    }

    if !config.dry_run {
        fs::create_dir_all(&config.current_sources_root).map_err(|error| {
            MigrationV4Error::io(
                "create current source root",
                &config.current_sources_root,
                error,
            )
        })?;
        fs::create_dir_all(&config.staging_root).map_err(|error| {
            MigrationV4Error::io("create migration staging root", &config.staging_root, error)
        })?;
    }

    let mut source_paths = Vec::new();
    let entries = fs::read_dir(&config.legacy_sources_root).map_err(|error| {
        MigrationV4Error::io(
            "enumerate legacy sources",
            &config.legacy_sources_root,
            error,
        )
    })?;

    for entry_result in entries {
        let entry = match entry_result {
            Ok(entry) => entry,
            Err(error) => {
                report
                    .warnings
                    .push(format!("Cannot read a legacy source entry: {}", error));
                continue;
            }
        };
        let path = entry.path();
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) => {
                report.warnings.push(format!(
                    "Cannot inspect legacy source entry {}: {}",
                    path.to_string_lossy(),
                    error
                ));
                continue;
            }
        };
        if metadata.is_dir() && !is_link_like(&metadata) {
            source_paths.push(path);
        }
    }

    source_paths.sort_by(|left, right| {
        path_file_name_lossy(left)
            .to_lowercase()
            .cmp(&path_file_name_lossy(right).to_lowercase())
    });
    report.summary.discovered = source_paths.len();

    for legacy_path in source_paths {
        let entry = recover_one_source(config, &legacy_path);
        update_source_summary(&mut report.summary, &entry);
        report.entries.push(entry);
    }

    Ok(report)
}

fn recover_one_source(config: &MigrationV4Config, legacy_path: &Path) -> SourceRecoveryEntry {
    let source_name = path_file_name_lossy(legacy_path);
    let target_path = config.current_sources_root.join(&source_name);
    let (staging_path, owner_path) = staging_paths(config, &source_name);
    let legacy_string = legacy_path.to_string_lossy().into_owned();
    let target_string = target_path.to_string_lossy().into_owned();

    let mut entry = SourceRecoveryEntry {
        source_name: source_name.clone(),
        legacy_path: legacy_string,
        target_path: target_string,
        staging_path: Some(staging_path.to_string_lossy().into_owned()),
        status: SourceRecoveryStatus::CopyFailed,
        resumed: staging_path.exists(),
        legacy_inventory: None,
        target_inventory: None,
        legacy_git_head: None,
        target_git_head: None,
        backup_path: None,
        detail: String::new(),
    };

    let legacy_inventory = match inventory_tree(legacy_path) {
        Ok(inventory) => inventory,
        Err(error) => {
            entry.status = SourceRecoveryStatus::SourceInvalid;
            entry.detail = format!("Cannot inventory legacy source: {}", error);
            return entry;
        }
    };
    entry.legacy_inventory = Some(legacy_inventory.clone());

    let legacy_git = inspect_git_head(legacy_path);
    match &legacy_git {
        GitHeadState::Valid(head) => entry.legacy_git_head = Some(head.clone()),
        GitHeadState::Invalid(reason) => {
            entry.status = SourceRecoveryStatus::SourceInvalid;
            entry.detail = format!("Legacy Git metadata is invalid: {}", reason);
            return entry;
        }
        GitHeadState::NotGit => {}
    }

    let repairing_existing = if target_path.exists() {
        let mut inspected =
            inspect_existing_target(entry, &target_path, &legacy_inventory, &legacy_git);
        if inspected.status != SourceRecoveryStatus::RepairNeeded {
            if !config.dry_run {
                match clear_owned_staging_artifacts(
                    &source_name,
                    legacy_path,
                    &staging_path,
                    &owner_path,
                ) {
                    Ok(true) => inspected
                        .detail
                        .push_str(" Completed migration staging was removed."),
                    Ok(false) => {}
                    Err(error) => inspected.detail.push_str(&format!(
                        " The usable destination was kept, but owned staging cleanup was deferred: {}",
                        error
                    )),
                }
            }
            return inspected;
        }
        entry = inspected;
        true
    } else {
        false
    };

    if let Err(reason) = inspect_or_prepare_staging(
        config,
        &source_name,
        legacy_path,
        &staging_path,
        &owner_path,
    ) {
        entry.status = SourceRecoveryStatus::StagingConflict;
        entry.detail = reason;
        return entry;
    }

    if config.dry_run {
        entry.status = SourceRecoveryStatus::WouldPromote;
        entry.detail = if repairing_existing {
            "Dry-run: the unusable destination would first be moved to a recoverable backup, then a verified legacy source would be atomically promoted.".to_string()
        } else if entry.resumed {
            "Dry-run: the owned partial staging source would be resumed, verified, and promoted."
                .to_string()
        } else {
            "Dry-run: the source would be copied to staging, verified, and promoted.".to_string()
        };
        return entry;
    }

    if let Err(error) = copy_missing_tree(legacy_path, &staging_path) {
        entry.status = SourceRecoveryStatus::CopyFailed;
        entry.detail = format!("Staging copy did not complete: {}", error);
        return entry;
    }

    let staged_inventory = match inventory_tree(&staging_path) {
        Ok(inventory) => inventory,
        Err(error) => {
            entry.status = SourceRecoveryStatus::CopyFailed;
            entry.detail = format!("Cannot verify staged source: {}", error);
            return entry;
        }
    };

    if staged_inventory != legacy_inventory {
        entry.status = SourceRecoveryStatus::StagingConflict;
        entry.detail = format!(
            "Staged inventory differs from the legacy source (legacy files={}, skills={}, bytes={}; staged files={}, skills={}, bytes={}).",
            legacy_inventory.file_count,
            legacy_inventory.skill_md_count,
            legacy_inventory.total_bytes,
            staged_inventory.file_count,
            staged_inventory.skill_md_count,
            staged_inventory.total_bytes
        );
        return entry;
    }

    if let GitHeadState::Valid(legacy_head) = &legacy_git {
        match inspect_git_head(&staging_path) {
            GitHeadState::Valid(staged_head) if &staged_head == legacy_head => {}
            GitHeadState::Valid(staged_head) => {
                entry.status = SourceRecoveryStatus::StagingConflict;
                entry.detail = format!(
                    "Staged Git HEAD {} does not match legacy HEAD {}.",
                    staged_head, legacy_head
                );
                return entry;
            }
            GitHeadState::Invalid(reason) => {
                entry.status = SourceRecoveryStatus::StagingConflict;
                entry.detail = format!("Staged Git metadata is invalid: {}", reason);
                return entry;
            }
            GitHeadState::NotGit => {
                entry.status = SourceRecoveryStatus::StagingConflict;
                entry.detail = "Staged source lost its Git metadata.".to_string();
                return entry;
            }
        }
    }

    let replacement_backup = if target_path.exists() && repairing_existing {
        match backup_repair_target(config, &source_name, &target_path) {
            Ok(path) => {
                entry.backup_path = Some(path.to_string_lossy().into_owned());
                Some(path)
            }
            Err(error) => {
                entry.status = SourceRecoveryStatus::CopyFailed;
                entry.detail = format!(
                    "The replacement source was verified, but the unusable destination could not be moved to a recoverable backup: {}",
                    error
                );
                return entry;
            }
        }
    } else {
        None
    };

    if target_path.exists() {
        entry.status = SourceRecoveryStatus::KeptCurrent;
        entry.detail =
            "The destination appeared during staging; it was kept and staging was not promoted."
                .to_string();
        return entry;
    }

    match fs::rename(&staging_path, &target_path) {
        Ok(()) => {
            entry.status = SourceRecoveryStatus::Promoted;
            entry.target_inventory = Some(staged_inventory);
            entry.target_git_head = entry.legacy_git_head.clone();
            entry.detail = if replacement_backup.is_some() {
                "The unusable destination was preserved in a recoverable backup, and the verified legacy source was atomically promoted.".to_string()
            } else if entry.resumed {
                "Resumed staging was verified and atomically promoted.".to_string()
            } else {
                "Staging was verified and atomically promoted.".to_string()
            };
            if let Err(error) =
                clear_owned_staging_artifacts(&source_name, legacy_path, &staging_path, &owner_path)
            {
                entry.detail.push_str(&format!(
                    " The source is usable, but its owned staging marker cleanup was deferred: {}",
                    error
                ));
            }
        }
        Err(error) => {
            let restore_note = replacement_backup
                .as_ref()
                .map(|backup| match fs::rename(backup, &target_path) {
                    Ok(()) => " The original destination was restored from its backup.".to_string(),
                    Err(restore_error) => format!(
                        " Automatic restore also failed ({}); the original remains at {}.",
                        restore_error,
                        backup.to_string_lossy()
                    ),
                })
                .unwrap_or_default();
            entry.status = SourceRecoveryStatus::CopyFailed;
            entry.detail = format!(
                "Verified staging could not be atomically promoted: {}{}",
                error, restore_note
            );
        }
    }

    entry
}

fn backup_repair_target(
    config: &MigrationV4Config,
    source_name: &str,
    target_path: &Path,
) -> Result<PathBuf, MigrationV4Error> {
    let backup_root = config.database_backup_root.join("sources");
    fs::create_dir_all(&backup_root).map_err(|error| {
        MigrationV4Error::io("create source repair backup root", &backup_root, error)
    })?;
    let timestamp = unix_timestamp_string();
    let mut backup_path = backup_root.join(format!("{}-before-repair-{}", source_name, timestamp));
    let mut collision = 1u32;
    while backup_path.exists() {
        backup_path = backup_root.join(format!(
            "{}-before-repair-{}-{}",
            source_name, timestamp, collision
        ));
        collision += 1;
    }
    fs::rename(target_path, &backup_path).map_err(|error| {
        MigrationV4Error::io(
            "move unusable source into recoverable repair backup",
            target_path,
            error,
        )
    })?;
    Ok(backup_path)
}

fn inspect_existing_target(
    mut entry: SourceRecoveryEntry,
    target_path: &Path,
    legacy_inventory: &TreeInventory,
    legacy_git: &GitHeadState,
) -> SourceRecoveryEntry {
    if !target_path.is_dir() {
        entry.status = SourceRecoveryStatus::RepairNeeded;
        entry.detail =
            "The destination exists but is not a directory; it was not modified.".to_string();
        return entry;
    }

    let target_inventory = match inventory_tree(target_path) {
        Ok(inventory) => inventory,
        Err(error) => {
            entry.status = SourceRecoveryStatus::RepairNeeded;
            entry.detail = format!(
                "The existing destination could not be inventoried and was not modified: {}",
                error
            );
            return entry;
        }
    };
    entry.target_inventory = Some(target_inventory.clone());

    let target_git = inspect_git_head(target_path);
    if let GitHeadState::Valid(head) = &target_git {
        entry.target_git_head = Some(head.clone());
    }

    let repair_reason = if target_inventory.file_count == 0 {
        Some("the existing destination is empty".to_string())
    } else if legacy_inventory.skill_md_count > 0 && target_inventory.skill_md_count == 0 {
        Some("the existing destination contains no SKILL.md files".to_string())
    } else if matches!(legacy_git, GitHeadState::Valid(_)) {
        match target_git {
            GitHeadState::NotGit => {
                Some("the existing destination lost its Git metadata".to_string())
            }
            GitHeadState::Invalid(reason) => Some(format!(
                "the existing destination has invalid Git metadata ({})",
                reason
            )),
            GitHeadState::Valid(_) => None,
        }
    } else {
        None
    };

    if let Some(reason) = repair_reason {
        entry.status = SourceRecoveryStatus::RepairNeeded;
        entry.detail = format!(
            "Repair is needed because {}; the existing destination was not replaced.",
            reason
        );
    } else {
        entry.status = SourceRecoveryStatus::KeptCurrent;
        entry.detail =
            "An existing usable destination was kept without comparing age or overwriting files."
                .to_string();
    }

    entry
}

fn update_source_summary(summary: &mut SourceRecoverySummary, entry: &SourceRecoveryEntry) {
    if entry.resumed {
        summary.resumed += 1;
    }
    match entry.status {
        SourceRecoveryStatus::WouldPromote => summary.would_promote += 1,
        SourceRecoveryStatus::Promoted => summary.promoted += 1,
        SourceRecoveryStatus::KeptCurrent => summary.kept_current += 1,
        SourceRecoveryStatus::RepairNeeded | SourceRecoveryStatus::StagingConflict => {
            summary.repair_needed += 1
        }
        SourceRecoveryStatus::SourceInvalid => summary.invalid += 1,
        SourceRecoveryStatus::CopyFailed => summary.failed += 1,
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StagingOwner {
    schema_version: u32,
    source_name: String,
    legacy_source: String,
}

fn inspect_or_prepare_staging(
    config: &MigrationV4Config,
    source_name: &str,
    legacy_path: &Path,
    staging_path: &Path,
    owner_path: &Path,
) -> Result<(), String> {
    let expected = StagingOwner {
        schema_version: MIGRATION_V4_SCHEMA_VERSION,
        source_name: source_name.to_string(),
        legacy_source: normalized_absolute_path(legacy_path),
    };

    if staging_path.exists() {
        if !staging_path.is_dir() {
            return Err(format!(
                "The deterministic staging path is not a directory: {}",
                staging_path.to_string_lossy()
            ));
        }
        ensure_tree_has_no_links(staging_path)?;
        let owner_text = fs::read_to_string(owner_path).map_err(|error| {
            format!(
                "The partial staging directory has no readable ownership marker ({}): {}",
                owner_path.to_string_lossy(),
                error
            )
        })?;
        let owner: StagingOwner = serde_json::from_str(&owner_text).map_err(|error| {
            format!(
                "The partial staging ownership marker is invalid ({}): {}",
                owner_path.to_string_lossy(),
                error
            )
        })?;
        if owner.schema_version != expected.schema_version
            || owner.source_name != expected.source_name
            || normalize_path_text(&owner.legacy_source)
                != normalize_path_text(&expected.legacy_source)
        {
            return Err(format!(
                "The partial staging directory belongs to a different source; it was not reused: {}",
                staging_path.to_string_lossy()
            ));
        }
        return Ok(());
    }

    if config.dry_run {
        if owner_path.exists() {
            let owner_text = fs::read_to_string(owner_path).map_err(|error| {
                format!(
                    "Cannot read the existing staging ownership marker {}: {}",
                    owner_path.to_string_lossy(),
                    error
                )
            })?;
            let owner: StagingOwner = serde_json::from_str(&owner_text).map_err(|error| {
                format!(
                    "The existing staging ownership marker is invalid {}: {}",
                    owner_path.to_string_lossy(),
                    error
                )
            })?;
            if owner.source_name != expected.source_name
                || normalize_path_text(&owner.legacy_source)
                    != normalize_path_text(&expected.legacy_source)
            {
                return Err(format!(
                    "The deterministic staging marker belongs to a different source: {}",
                    owner_path.to_string_lossy()
                ));
            }
        }
        return Ok(());
    }

    if owner_path.exists() {
        let owner_text = fs::read_to_string(owner_path).map_err(|error| {
            format!(
                "Cannot read the existing staging ownership marker {}: {}",
                owner_path.to_string_lossy(),
                error
            )
        })?;
        let owner: StagingOwner = serde_json::from_str(&owner_text).map_err(|error| {
            format!(
                "The existing staging ownership marker is invalid {}: {}",
                owner_path.to_string_lossy(),
                error
            )
        })?;
        if owner.source_name != expected.source_name
            || normalize_path_text(&owner.legacy_source)
                != normalize_path_text(&expected.legacy_source)
        {
            return Err(format!(
                "The deterministic staging marker belongs to a different source: {}",
                owner_path.to_string_lossy()
            ));
        }
    } else {
        let text = serde_json::to_string_pretty(&expected)
            .map_err(|error| format!("Cannot serialize staging owner: {}", error))?;
        fs::write(owner_path, text).map_err(|error| {
            format!(
                "Cannot write staging ownership marker {}: {}",
                owner_path.to_string_lossy(),
                error
            )
        })?;
    }

    fs::create_dir_all(staging_path).map_err(|error| {
        format!(
            "Cannot create per-source staging directory {}: {}",
            staging_path.to_string_lossy(),
            error
        )
    })
}

fn clear_owned_staging_artifacts(
    source_name: &str,
    legacy_path: &Path,
    staging_path: &Path,
    owner_path: &Path,
) -> Result<bool, String> {
    if !staging_path.exists() && !owner_path.exists() {
        return Ok(false);
    }

    let expected = StagingOwner {
        schema_version: MIGRATION_V4_SCHEMA_VERSION,
        source_name: source_name.to_string(),
        legacy_source: normalized_absolute_path(legacy_path),
    };
    let owner_text = fs::read_to_string(owner_path).map_err(|error| {
        format!(
            "the staging ownership marker is unavailable ({}): {}",
            owner_path.to_string_lossy(),
            error
        )
    })?;
    let owner: StagingOwner = serde_json::from_str(&owner_text).map_err(|error| {
        format!(
            "the staging ownership marker is invalid ({}): {}",
            owner_path.to_string_lossy(),
            error
        )
    })?;
    if owner.schema_version != expected.schema_version
        || owner.source_name != expected.source_name
        || normalize_path_text(&owner.legacy_source) != normalize_path_text(&expected.legacy_source)
    {
        return Err(format!(
            "the staging ownership marker belongs to another source: {}",
            owner_path.to_string_lossy()
        ));
    }

    if staging_path.exists() {
        if !staging_path.is_dir() {
            return Err(format!(
                "the owned staging path is not a directory: {}",
                staging_path.to_string_lossy()
            ));
        }
        ensure_tree_has_no_links(staging_path)?;
        fs::remove_dir_all(staging_path).map_err(|error| {
            format!(
                "cannot remove completed staging directory {}: {}",
                staging_path.to_string_lossy(),
                error
            )
        })?;
    }
    fs::remove_file(owner_path).map_err(|error| {
        format!(
            "cannot remove completed staging ownership marker {}: {}",
            owner_path.to_string_lossy(),
            error
        )
    })?;
    Ok(true)
}

fn staging_paths(config: &MigrationV4Config, source_name: &str) -> (PathBuf, PathBuf) {
    let safe_name = source_name
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '-' || character == '_' {
                character
            } else {
                '-'
            }
        })
        .collect::<String>();
    let key = format!("{}-{:016x}", safe_name, fnv1a64(source_name.as_bytes()));
    (
        config.staging_root.join(format!("{}.partial", key)),
        config.staging_root.join(format!("{}.owner.json", key)),
    )
}

fn inventory_tree(root: &Path) -> Result<TreeInventory, String> {
    let canonical_root = fs::canonicalize(root).map_err(|error| {
        format!(
            "Cannot resolve tree root {}: {}",
            root.to_string_lossy(),
            error
        )
    })?;
    let mut inventory = TreeInventory::default();
    let mut pending = vec![root.to_path_buf()];

    while let Some(directory) = pending.pop() {
        let mut entries = fs::read_dir(&directory)
            .map_err(|error| {
                format!(
                    "Cannot enumerate directory {}: {}",
                    directory.to_string_lossy(),
                    error
                )
            })?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| {
                format!(
                    "Cannot enumerate an entry below {}: {}",
                    directory.to_string_lossy(),
                    error
                )
            })?;
        entries.sort_by_key(|entry| entry.file_name());

        for entry in entries {
            let path = entry.path();
            if path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.ends_with(COPY_TEMP_SUFFIX))
            {
                continue;
            }
            let metadata = fs::symlink_metadata(&path)
                .map_err(|error| format!("Cannot inspect {}: {}", path.to_string_lossy(), error))?;
            if is_link_like(&metadata) {
                continue;
            }
            if metadata.is_dir() {
                let resolved = fs::canonicalize(&path).map_err(|error| {
                    format!(
                        "Cannot resolve directory {}: {}",
                        path.to_string_lossy(),
                        error
                    )
                })?;
                if !resolved.starts_with(&canonical_root) {
                    continue;
                }
                pending.push(path);
            } else if metadata.is_file() {
                inventory.file_count += 1;
                inventory.total_bytes = inventory.total_bytes.saturating_add(metadata.len());
                if path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.eq_ignore_ascii_case("SKILL.md"))
                {
                    inventory.skill_md_count += 1;
                }
            }
        }
    }

    Ok(inventory)
}

fn copy_missing_tree(source_root: &Path, staging_root: &Path) -> Result<(), String> {
    let canonical_source = fs::canonicalize(source_root).map_err(|error| {
        format!(
            "Cannot resolve source root {}: {}",
            source_root.to_string_lossy(),
            error
        )
    })?;
    let mut pending = vec![(source_root.to_path_buf(), staging_root.to_path_buf())];

    while let Some((source_dir, destination_dir)) = pending.pop() {
        fs::create_dir_all(&destination_dir).map_err(|error| {
            format!(
                "Cannot create staging directory {}: {}",
                destination_dir.to_string_lossy(),
                error
            )
        })?;
        let mut entries = fs::read_dir(&source_dir)
            .map_err(|error| {
                format!(
                    "Cannot enumerate source directory {}: {}",
                    source_dir.to_string_lossy(),
                    error
                )
            })?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| {
                format!(
                    "Cannot enumerate an entry below {}: {}",
                    source_dir.to_string_lossy(),
                    error
                )
            })?;
        entries.sort_by_key(|entry| entry.file_name());

        for entry in entries {
            let source_path = entry.path();
            let destination_path = destination_dir.join(entry.file_name());
            let metadata = fs::symlink_metadata(&source_path).map_err(|error| {
                format!(
                    "Cannot inspect source entry {}: {}",
                    source_path.to_string_lossy(),
                    error
                )
            })?;
            if is_link_like(&metadata) {
                continue;
            }
            if metadata.is_dir() {
                let resolved = fs::canonicalize(&source_path).map_err(|error| {
                    format!(
                        "Cannot resolve source directory {}: {}",
                        source_path.to_string_lossy(),
                        error
                    )
                })?;
                if !resolved.starts_with(&canonical_source) {
                    continue;
                }
                pending.push((source_path, destination_path));
            } else if metadata.is_file() {
                copy_missing_file(&source_path, &destination_path, metadata.len())?;
            }
        }
    }

    Ok(())
}

fn copy_missing_file(
    source_path: &Path,
    destination_path: &Path,
    expected_len: u64,
) -> Result<(), String> {
    let temp_name = format!(
        "{}{}",
        destination_path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("file"),
        COPY_TEMP_SUFFIX
    );
    let temp_path = destination_path.with_file_name(temp_name);

    if destination_path.exists() {
        let destination_metadata = fs::metadata(destination_path).map_err(|error| {
            format!(
                "Cannot inspect staged file {}: {}",
                destination_path.to_string_lossy(),
                error
            )
        })?;
        if !destination_metadata.is_file() || destination_metadata.len() != expected_len {
            return Err(format!(
                "A staged file conflicts with the legacy source: {}",
                destination_path.to_string_lossy()
            ));
        }
        if !files_equal(source_path, destination_path).map_err(|error| {
            format!(
                "Cannot compare resumed staged file {}: {}",
                destination_path.to_string_lossy(),
                error
            )
        })? {
            return Err(format!(
                "A resumed staged file has the expected size but different content: {}",
                destination_path.to_string_lossy()
            ));
        }
        if temp_path.exists() {
            fs::remove_file(&temp_path).map_err(|error| {
                format!(
                    "Cannot remove an owned stale copy temporary file {}: {}",
                    temp_path.to_string_lossy(),
                    error
                )
            })?;
        }
        return Ok(());
    }

    if let Some(parent) = destination_path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "Cannot create staged file parent {}: {}",
                parent.to_string_lossy(),
                error
            )
        })?;
    }

    fs::copy(source_path, &temp_path).map_err(|error| {
        format!(
            "Cannot copy {} to staging: {}",
            source_path.to_string_lossy(),
            error
        )
    })?;
    let copied_len = fs::metadata(&temp_path)
        .map_err(|error| {
            format!(
                "Cannot inspect staged temporary file {}: {}",
                temp_path.to_string_lossy(),
                error
            )
        })?
        .len();
    if copied_len != expected_len {
        return Err(format!(
            "Staged temporary file size differs for {} (expected {}, copied {}).",
            source_path.to_string_lossy(),
            expected_len,
            copied_len
        ));
    }

    if destination_path.exists() {
        return Err(format!(
            "The staged destination appeared while a file was being copied: {}",
            destination_path.to_string_lossy()
        ));
    }
    fs::rename(&temp_path, destination_path).map_err(|error| {
        format!(
            "Cannot atomically finish staged file {}: {}",
            destination_path.to_string_lossy(),
            error
        )
    })
}

fn files_equal(left: &Path, right: &Path) -> io::Result<bool> {
    let mut left_file = fs::File::open(left)?;
    let mut right_file = fs::File::open(right)?;
    let mut left_buffer = [0u8; 64 * 1024];
    let mut right_buffer = [0u8; 64 * 1024];
    loop {
        let left_read = left_file.read(&mut left_buffer)?;
        let right_read = right_file.read(&mut right_buffer)?;
        if left_read != right_read {
            return Ok(false);
        }
        if left_read == 0 {
            return Ok(true);
        }
        if left_buffer[..left_read] != right_buffer[..right_read] {
            return Ok(false);
        }
    }
}

fn ensure_tree_has_no_links(root: &Path) -> Result<(), String> {
    let root_metadata = fs::symlink_metadata(root).map_err(|error| {
        format!(
            "Cannot inspect staging root {}: {}",
            root.to_string_lossy(),
            error
        )
    })?;
    if is_link_like(&root_metadata) {
        return Err(format!(
            "The staging root is a link or reparse point and cannot be resumed safely: {}",
            root.to_string_lossy()
        ));
    }

    let canonical_root = fs::canonicalize(root).map_err(|error| {
        format!(
            "Cannot resolve staging root {}: {}",
            root.to_string_lossy(),
            error
        )
    })?;
    let mut pending = vec![root.to_path_buf()];
    while let Some(directory) = pending.pop() {
        for entry in fs::read_dir(&directory).map_err(|error| {
            format!(
                "Cannot inspect staged directory {}: {}",
                directory.to_string_lossy(),
                error
            )
        })? {
            let entry = entry.map_err(|error| {
                format!(
                    "Cannot inspect an entry below staged directory {}: {}",
                    directory.to_string_lossy(),
                    error
                )
            })?;
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path).map_err(|error| {
                format!(
                    "Cannot inspect staged entry {}: {}",
                    path.to_string_lossy(),
                    error
                )
            })?;
            if is_link_like(&metadata) {
                return Err(format!(
                    "The partial staging tree contains a link or reparse point and was not reused: {}",
                    path.to_string_lossy()
                ));
            }
            if metadata.is_dir() {
                let resolved = fs::canonicalize(&path).map_err(|error| {
                    format!(
                        "Cannot resolve staged directory {}: {}",
                        path.to_string_lossy(),
                        error
                    )
                })?;
                if !resolved.starts_with(&canonical_root) {
                    return Err(format!(
                        "The partial staging tree leaves its owned root: {}",
                        path.to_string_lossy()
                    ));
                }
                pending.push(path);
            }
        }
    }
    Ok(())
}

#[derive(Debug, Clone)]
enum GitHeadState {
    NotGit,
    Valid(String),
    Invalid(String),
}

fn inspect_git_head(repository_root: &Path) -> GitHeadState {
    let dot_git = repository_root.join(".git");
    if !dot_git.exists() {
        return GitHeadState::NotGit;
    }

    let repository_canonical = match fs::canonicalize(repository_root) {
        Ok(path) => path,
        Err(error) => {
            return GitHeadState::Invalid(format!("cannot resolve repository root: {}", error))
        }
    };

    let git_dir = if dot_git.is_dir() {
        dot_git
    } else if dot_git.is_file() {
        let pointer = match fs::read_to_string(&dot_git) {
            Ok(pointer) => pointer,
            Err(error) => {
                return GitHeadState::Invalid(format!("cannot read .git pointer: {}", error))
            }
        };
        let Some(raw_path) = pointer.trim().strip_prefix("gitdir:") else {
            return GitHeadState::Invalid(".git file has no gitdir pointer".to_string());
        };
        let candidate = PathBuf::from(raw_path.trim());
        let candidate = if candidate.is_absolute() {
            candidate
        } else {
            repository_root.join(candidate)
        };
        let resolved = match fs::canonicalize(&candidate) {
            Ok(path) => path,
            Err(error) => {
                return GitHeadState::Invalid(format!("cannot resolve gitdir pointer: {}", error))
            }
        };
        if !resolved.starts_with(&repository_canonical) {
            return GitHeadState::Invalid(
                "gitdir pointer leaves the source tree and is not portable".to_string(),
            );
        }
        resolved
    } else {
        return GitHeadState::Invalid(".git is neither a file nor a directory".to_string());
    };

    let head_text = match fs::read_to_string(git_dir.join("HEAD")) {
        Ok(text) => text,
        Err(error) => {
            return GitHeadState::Invalid(format!("cannot read .git/HEAD: {}", error));
        }
    };
    let head = head_text.trim();
    if let Some(reference) = head.strip_prefix("ref:") {
        let reference = reference.trim();
        let reference_path = Path::new(reference);
        if !is_safe_relative_path(reference_path) {
            return GitHeadState::Invalid("HEAD contains an unsafe ref path".to_string());
        }
        let loose_ref = git_dir.join(reference_path);
        if let Ok(value) = fs::read_to_string(&loose_ref) {
            let object_id = value.trim();
            if is_git_object_id(object_id) {
                return GitHeadState::Valid(object_id.to_ascii_lowercase());
            }
            return GitHeadState::Invalid(format!(
                "loose ref {} does not contain a Git object id",
                reference
            ));
        }

        let packed_refs = match fs::read_to_string(git_dir.join("packed-refs")) {
            Ok(text) => text,
            Err(error) => {
                return GitHeadState::Invalid(format!(
                    "HEAD ref {} cannot be resolved: {}",
                    reference, error
                ))
            }
        };
        for line in packed_refs.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.starts_with('#') || trimmed.starts_with('^') {
                continue;
            }
            let mut parts = trimmed.split_whitespace();
            let object_id = parts.next().unwrap_or_default();
            let packed_reference = parts.next().unwrap_or_default();
            if packed_reference == reference && is_git_object_id(object_id) {
                return GitHeadState::Valid(object_id.to_ascii_lowercase());
            }
        }
        GitHeadState::Invalid(format!("HEAD ref {} is missing", reference))
    } else if is_git_object_id(head) {
        GitHeadState::Valid(head.to_ascii_lowercase())
    } else {
        GitHeadState::Invalid("HEAD is neither a valid ref nor an object id".to_string())
    }
}

fn is_git_object_id(value: &str) -> bool {
    matches!(value.len(), 40 | 64) && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn is_safe_relative_path(path: &Path) -> bool {
    !path.as_os_str().is_empty()
        && !path.is_absolute()
        && path
            .components()
            .all(|component| matches!(component, Component::Normal(_) | Component::CurDir))
}

/// Merges only user-authored metadata and usage history.
///
/// The current database is backed up before any schema or row change. Current
/// non-empty strings, non-zero ratings, explicit enabled values, and non-empty
/// tag selections win over legacy values. Audit events, snapshots, popularity
/// caches, and other derived tables are never read.
pub fn merge_legacy_metadata_v4(
    config: &MigrationV4Config,
) -> Result<MetadataMergeReport, MigrationV4Error> {
    let Some(legacy_path) = config.legacy_database_path.as_deref() else {
        return Ok(MetadataMergeReport::skipped(
            MetadataMergeStatus::SkippedNoLegacyDatabase,
            config,
            "No legacy database path was configured.",
        ));
    };
    if !legacy_path.is_file() {
        return Ok(MetadataMergeReport::skipped(
            MetadataMergeStatus::SkippedNoLegacyDatabase,
            config,
            "The configured legacy database does not exist.",
        ));
    }

    let Some(current_path) = config.current_database_path.as_deref() else {
        return Ok(MetadataMergeReport::skipped(
            MetadataMergeStatus::SkippedNoCurrentDatabase,
            config,
            "No current database path was configured.",
        ));
    };
    if !current_path.is_file() {
        return Ok(MetadataMergeReport::skipped(
            MetadataMergeStatus::SkippedNoCurrentDatabase,
            config,
            "The current database does not exist; index it before merging metadata.",
        ));
    }

    if paths_refer_to_same_file(legacy_path, current_path) {
        return Ok(MetadataMergeReport::skipped(
            MetadataMergeStatus::SkippedSameDatabase,
            config,
            "Legacy and current database paths resolve to the same file.",
        ));
    }

    let legacy = open_read_only_database(legacy_path, "open legacy metadata database")?;
    ensure_database_healthy(&legacy, "legacy database integrity check")?;

    if config.dry_run {
        let current =
            open_read_only_database(current_path, "open current metadata database for dry-run")?;
        ensure_database_healthy(&current, "current database integrity check")?;
        let plan = build_merge_plan(&legacy, &current)?;
        return Ok(metadata_report_from_plan(
            config,
            MetadataMergeStatus::DryRun,
            &plan,
            None,
            "Dry-run only; no backup, schema change, or metadata write was performed.",
        ));
    }

    let backup_path = backup_current_database(current_path, &config.database_backup_root)?;
    let mut current = Connection::open(current_path)
        .map_err(|error| MigrationV4Error::sqlite("open current metadata database", error))?;
    current
        .busy_timeout(Duration::from_secs(10))
        .map_err(|error| MigrationV4Error::sqlite("configure database busy timeout", error))?;
    ensure_database_healthy(&current, "current database integrity check")?;
    current
        .execute_batch("PRAGMA foreign_keys = ON;")
        .map_err(|error| MigrationV4Error::sqlite("enable metadata foreign keys", error))?;
    ensure_metadata_merge_schema(&current)?;

    let plan = build_merge_plan(&legacy, &current)?;
    let transaction = current
        .transaction()
        .map_err(|error| MigrationV4Error::sqlite("begin metadata migration transaction", error))?;
    apply_merge_plan(&transaction, &plan)?;
    transaction.commit().map_err(|error| {
        MigrationV4Error::sqlite("commit metadata migration transaction", error)
    })?;

    Ok(metadata_report_from_plan(
        config,
        MetadataMergeStatus::Merged,
        &plan,
        Some(backup_path),
        "Legacy manual metadata was merged; current manual values took precedence.",
    ))
}

fn metadata_report_from_plan(
    config: &MigrationV4Config,
    status: MetadataMergeStatus,
    plan: &MergePlan,
    backup_path: Option<PathBuf>,
    detail: impl Into<String>,
) -> MetadataMergeReport {
    MetadataMergeReport {
        status,
        dry_run: config.dry_run,
        legacy_database: path_option_to_string(config.legacy_database_path.as_deref()),
        current_database: path_option_to_string(config.current_database_path.as_deref()),
        backup_path: backup_path.map(|path| path.to_string_lossy().into_owned()),
        would_backup: true,
        source_overrides_merged: plan.source_overrides.len(),
        skill_overrides_merged: plan.skill_overrides.len(),
        tags_merged: plan.tags.len(),
        source_tag_overrides_merged: plan.source_tag_overrides.len(),
        skill_tag_overrides_merged: plan.skill_tag_overrides.len(),
        usage_events_merged: plan.usage_events.len(),
        deferred_tag_overrides: plan.deferred_tag_overrides,
        detail: detail.into(),
    }
}

#[derive(Debug, Clone)]
struct SourceIdentity {
    id: String,
    name: String,
    url: String,
    local_path: String,
}

#[derive(Debug, Clone)]
struct SkillIdentity {
    id: String,
    source_id: Option<String>,
    folder_name: String,
    relative_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SourceOverride {
    target_id: String,
    display_name: String,
    source_type: String,
    category_id: String,
    note: String,
    enabled: Option<i64>,
    rating: i64,
    updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SkillOverride {
    target_id: String,
    display_name: String,
    category_id: String,
    description: String,
    note: String,
    enabled: Option<i64>,
    rating: i64,
    updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct TagRecord {
    id: String,
    name: String,
    color: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct TagOverrideRecord {
    target_id: String,
    tag_id: String,
    updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct UsageEventRecord {
    id: String,
    target_type: String,
    target_id: String,
    target_name: String,
    source_name: String,
    event_type: String,
    created_at: String,
}

#[derive(Debug, Default)]
struct MergePlan {
    source_overrides: Vec<SourceOverride>,
    skill_overrides: Vec<SkillOverride>,
    tags: Vec<TagRecord>,
    source_tag_overrides: Vec<TagOverrideRecord>,
    skill_tag_overrides: Vec<TagOverrideRecord>,
    usage_events: Vec<UsageEventRecord>,
    deferred_tag_overrides: usize,
}

fn build_merge_plan(
    legacy: &Connection,
    current: &Connection,
) -> Result<MergePlan, MigrationV4Error> {
    let legacy_sources = read_sources(legacy)?;
    let current_sources = read_sources(current)?;
    let legacy_skills = read_skills(legacy)?;
    let current_skills = read_skills(current)?;

    let source_map = map_sources(&legacy_sources, &current_sources);
    let skill_map = map_skills(&legacy_skills, &current_skills, &source_map);
    let current_source_ids = current_sources
        .iter()
        .map(|source| source.id.clone())
        .collect::<HashSet<_>>();
    let current_skill_ids = current_skills
        .iter()
        .map(|skill| skill.id.clone())
        .collect::<HashSet<_>>();

    let legacy_source_overrides = read_source_overrides(legacy)?;
    let current_source_overrides = read_source_overrides(current)?
        .into_iter()
        .map(|value| (value.target_id.clone(), value))
        .collect::<HashMap<_, _>>();
    let legacy_skill_overrides = read_skill_overrides(legacy)?;
    let current_skill_overrides = read_skill_overrides(current)?
        .into_iter()
        .map(|value| (value.target_id.clone(), value))
        .collect::<HashMap<_, _>>();

    let mut plan = MergePlan::default();

    for legacy_override in legacy_source_overrides {
        let target_id = source_map
            .get(&legacy_override.target_id)
            .cloned()
            .unwrap_or_else(|| legacy_override.target_id.clone());
        let merged = merge_source_override(
            &target_id,
            &legacy_override,
            current_source_overrides.get(&target_id),
        );
        if current_source_overrides.get(&target_id) != Some(&merged) {
            plan.source_overrides.push(merged);
        }
    }

    for legacy_override in legacy_skill_overrides {
        let target_id = skill_map
            .get(&legacy_override.target_id)
            .cloned()
            .unwrap_or_else(|| legacy_override.target_id.clone());
        let merged = merge_skill_override(
            &target_id,
            &legacy_override,
            current_skill_overrides.get(&target_id),
        );
        if current_skill_overrides.get(&target_id) != Some(&merged) {
            plan.skill_overrides.push(merged);
        }
    }

    let legacy_tags = read_tags(legacy)?;
    let current_tags = read_tags(current)?;
    let (tag_plan, tag_map) = plan_tags(&legacy_tags, &current_tags);
    plan.tags = tag_plan;

    let current_source_tag_overrides =
        read_tag_overrides(current, "source_tag_overrides", "source_id")?;
    let current_skill_tag_overrides =
        read_tag_overrides(current, "skill_tag_overrides", "skill_id")?;
    let current_source_tag_targets = current_source_tag_overrides
        .iter()
        .map(|value| value.target_id.clone())
        .collect::<HashSet<_>>();
    let current_skill_tag_targets = current_skill_tag_overrides
        .iter()
        .map(|value| value.target_id.clone())
        .collect::<HashSet<_>>();
    let current_source_tag_pairs = current_source_tag_overrides
        .iter()
        .map(|value| (value.target_id.clone(), value.tag_id.clone()))
        .collect::<HashSet<_>>();
    let current_skill_tag_pairs = current_skill_tag_overrides
        .iter()
        .map(|value| (value.target_id.clone(), value.tag_id.clone()))
        .collect::<HashSet<_>>();

    for legacy_override in read_tag_overrides(legacy, "source_tag_overrides", "source_id")? {
        let Some(target_id) = source_map
            .get(&legacy_override.target_id)
            .cloned()
            .or_else(|| {
                current_source_ids
                    .contains(&legacy_override.target_id)
                    .then(|| legacy_override.target_id.clone())
            })
        else {
            plan.deferred_tag_overrides += 1;
            continue;
        };
        if current_source_tag_targets.contains(&target_id) {
            continue;
        }
        let Some(tag_id) = tag_map.get(&legacy_override.tag_id).cloned() else {
            plan.deferred_tag_overrides += 1;
            continue;
        };
        if !current_source_tag_pairs.contains(&(target_id.clone(), tag_id.clone())) {
            plan.source_tag_overrides.push(TagOverrideRecord {
                target_id,
                tag_id,
                updated_at: nonempty_or_timestamp(&legacy_override.updated_at),
            });
        }
    }

    for legacy_override in read_tag_overrides(legacy, "skill_tag_overrides", "skill_id")? {
        let Some(target_id) = skill_map
            .get(&legacy_override.target_id)
            .cloned()
            .or_else(|| {
                current_skill_ids
                    .contains(&legacy_override.target_id)
                    .then(|| legacy_override.target_id.clone())
            })
        else {
            plan.deferred_tag_overrides += 1;
            continue;
        };
        if current_skill_tag_targets.contains(&target_id) {
            continue;
        }
        let Some(tag_id) = tag_map.get(&legacy_override.tag_id).cloned() else {
            plan.deferred_tag_overrides += 1;
            continue;
        };
        if !current_skill_tag_pairs.contains(&(target_id.clone(), tag_id.clone())) {
            plan.skill_tag_overrides.push(TagOverrideRecord {
                target_id,
                tag_id,
                updated_at: nonempty_or_timestamp(&legacy_override.updated_at),
            });
        }
    }

    let current_usage_ids = read_usage_events(current)?
        .into_iter()
        .map(|event| event.id)
        .collect::<HashSet<_>>();
    for mut event in read_usage_events(legacy)? {
        if current_usage_ids.contains(&event.id) {
            continue;
        }
        event.target_id = match event.target_type.as_str() {
            "source" => source_map
                .get(&event.target_id)
                .cloned()
                .unwrap_or(event.target_id),
            "skill" => skill_map
                .get(&event.target_id)
                .cloned()
                .unwrap_or(event.target_id),
            _ => event.target_id,
        };
        plan.usage_events.push(event);
    }

    Ok(plan)
}

fn merge_source_override(
    target_id: &str,
    legacy: &SourceOverride,
    current: Option<&SourceOverride>,
) -> SourceOverride {
    let Some(current) = current else {
        let mut value = legacy.clone();
        value.target_id = target_id.to_string();
        value.updated_at = nonempty_or_timestamp(&value.updated_at);
        return value;
    };
    SourceOverride {
        target_id: target_id.to_string(),
        display_name: prefer_current_text(&current.display_name, &legacy.display_name),
        source_type: prefer_current_text(&current.source_type, &legacy.source_type),
        category_id: prefer_current_text(&current.category_id, &legacy.category_id),
        note: prefer_current_text(&current.note, &legacy.note),
        enabled: current.enabled.or(legacy.enabled),
        rating: prefer_current_rating(current.rating, legacy.rating),
        updated_at: nonempty_or_timestamp(&current.updated_at),
    }
}

fn merge_skill_override(
    target_id: &str,
    legacy: &SkillOverride,
    current: Option<&SkillOverride>,
) -> SkillOverride {
    let Some(current) = current else {
        let mut value = legacy.clone();
        value.target_id = target_id.to_string();
        value.updated_at = nonempty_or_timestamp(&value.updated_at);
        return value;
    };
    SkillOverride {
        target_id: target_id.to_string(),
        display_name: prefer_current_text(&current.display_name, &legacy.display_name),
        category_id: prefer_current_text(&current.category_id, &legacy.category_id),
        description: prefer_current_text(&current.description, &legacy.description),
        note: prefer_current_text(&current.note, &legacy.note),
        enabled: current.enabled.or(legacy.enabled),
        rating: prefer_current_rating(current.rating, legacy.rating),
        updated_at: nonempty_or_timestamp(&current.updated_at),
    }
}

fn prefer_current_text(current: &str, legacy: &str) -> String {
    if current.trim().is_empty() {
        legacy.to_string()
    } else {
        current.to_string()
    }
}

fn prefer_current_rating(current: i64, legacy: i64) -> i64 {
    if current != 0 {
        current
    } else {
        legacy
    }
}

fn plan_tags(
    legacy_tags: &[TagRecord],
    current_tags: &[TagRecord],
) -> (Vec<TagRecord>, HashMap<String, String>) {
    let mut planned = Vec::new();
    let mut mapping = HashMap::new();
    let mut current_by_name = current_tags
        .iter()
        .map(|tag| (normalize_key(&tag.name), tag.clone()))
        .collect::<HashMap<_, _>>();
    let mut used_ids = current_tags
        .iter()
        .map(|tag| tag.id.clone())
        .collect::<HashSet<_>>();

    for legacy in legacy_tags {
        let key = normalize_key(&legacy.name);
        if key.is_empty() {
            continue;
        }
        if let Some(current) = current_by_name.get(&key) {
            mapping.insert(legacy.id.clone(), current.id.clone());
            if current.color.trim().is_empty() && !legacy.color.trim().is_empty() {
                let updated = TagRecord {
                    id: current.id.clone(),
                    name: current.name.clone(),
                    color: legacy.color.clone(),
                };
                planned.push(updated.clone());
                current_by_name.insert(key, updated);
            }
            continue;
        }

        let mut id = legacy.id.clone();
        if id.trim().is_empty() || used_ids.contains(&id) {
            id = stable_id("tag", &key);
            let mut collision = 1u32;
            while used_ids.contains(&id) {
                id = stable_id("tag", &format!("{}-{}", key, collision));
                collision += 1;
            }
        }
        let inserted = TagRecord {
            id: id.clone(),
            name: legacy.name.clone(),
            color: legacy.color.clone(),
        };
        used_ids.insert(id.clone());
        mapping.insert(legacy.id.clone(), id);
        current_by_name.insert(key, inserted.clone());
        planned.push(inserted);
    }

    (planned, mapping)
}

fn map_sources(
    legacy_sources: &[SourceIdentity],
    current_sources: &[SourceIdentity],
) -> HashMap<String, String> {
    let current_ids = current_sources
        .iter()
        .map(|source| source.id.clone())
        .collect::<HashSet<_>>();
    let url_index = unique_string_index(current_sources.iter().filter_map(|source| {
        let key = normalize_repository_url(&source.url);
        (!key.is_empty()).then(|| (key, source.id.clone()))
    }));
    let path_index = unique_string_index(current_sources.iter().filter_map(|source| {
        let key = source_identity_path_key(source);
        (!key.is_empty()).then(|| (key, source.id.clone()))
    }));
    let name_index = unique_string_index(
        current_sources
            .iter()
            .map(|source| (normalize_key(&source.name), source.id.clone())),
    );

    let mut mapping = HashMap::new();
    for legacy in legacy_sources {
        let matched = if current_ids.contains(&legacy.id) {
            Some(legacy.id.clone())
        } else {
            let url_key = normalize_repository_url(&legacy.url);
            unique_lookup(&url_index, &url_key)
                .or_else(|| unique_lookup(&path_index, &source_identity_path_key(legacy)))
                .or_else(|| unique_lookup(&name_index, &normalize_key(&legacy.name)))
        };
        if let Some(current_id) = matched {
            mapping.insert(legacy.id.clone(), current_id);
        }
    }
    mapping
}

fn map_skills(
    legacy_skills: &[SkillIdentity],
    current_skills: &[SkillIdentity],
    source_map: &HashMap<String, String>,
) -> HashMap<String, String> {
    let current_ids = current_skills
        .iter()
        .map(|skill| skill.id.clone())
        .collect::<HashSet<_>>();
    let folder_index = unique_string_index(
        current_skills
            .iter()
            .map(|skill| (normalize_key(&skill.folder_name), skill.id.clone())),
    );
    let source_path_index = unique_string_index(current_skills.iter().map(|skill| {
        (
            format!(
                "{}|{}",
                skill
                    .source_id
                    .as_deref()
                    .map(normalize_key)
                    .unwrap_or_default(),
                normalize_path_text(&skill.relative_path)
            ),
            skill.id.clone(),
        )
    }));

    let mut mapping = HashMap::new();
    for legacy in legacy_skills {
        let matched = if current_ids.contains(&legacy.id) {
            Some(legacy.id.clone())
        } else {
            unique_lookup(&folder_index, &normalize_key(&legacy.folder_name)).or_else(|| {
                let mapped_source = legacy
                    .source_id
                    .as_deref()
                    .and_then(|source_id| source_map.get(source_id))
                    .map(|value| normalize_key(value))
                    .unwrap_or_default();
                unique_lookup(
                    &source_path_index,
                    &format!(
                        "{}|{}",
                        mapped_source,
                        normalize_path_text(&legacy.relative_path)
                    ),
                )
            })
        };
        if let Some(current_id) = matched {
            mapping.insert(legacy.id.clone(), current_id);
        }
    }
    mapping
}

fn unique_string_index(
    values: impl IntoIterator<Item = (String, String)>,
) -> HashMap<String, Option<String>> {
    let mut index = HashMap::<String, Option<String>>::new();
    for (key, id) in values {
        if key.is_empty() {
            continue;
        }
        index
            .entry(key)
            .and_modify(|value| *value = None)
            .or_insert(Some(id));
    }
    index
}

fn unique_lookup(index: &HashMap<String, Option<String>>, key: &str) -> Option<String> {
    if key.is_empty() {
        None
    } else {
        index.get(key).and_then(Clone::clone)
    }
}

fn source_identity_path_key(source: &SourceIdentity) -> String {
    let path = normalize_path_text(&source.local_path);
    if path.is_empty() {
        return String::new();
    }
    Path::new(&path)
        .file_name()
        .and_then(|name| name.to_str())
        .map(normalize_key)
        .unwrap_or(path)
}

fn read_sources(connection: &Connection) -> Result<Vec<SourceIdentity>, MigrationV4Error> {
    if !table_exists(connection, "sources")? {
        return Ok(Vec::new());
    }
    let mut statement = connection
        .prepare(
            "SELECT id, name, COALESCE(url, ''), COALESCE(local_path, '')
             FROM sources",
        )
        .map_err(|error| MigrationV4Error::sqlite("read source identities", error))?;
    let rows = statement
        .query_map([], |row| {
            Ok(SourceIdentity {
                id: row.get(0)?,
                name: row.get(1)?,
                url: row.get(2)?,
                local_path: row.get(3)?,
            })
        })
        .map_err(|error| MigrationV4Error::sqlite("query source identities", error))?;
    collect_sql_rows(rows, "collect source identities")
}

fn read_skills(connection: &Connection) -> Result<Vec<SkillIdentity>, MigrationV4Error> {
    if !table_exists(connection, "skills")? {
        return Ok(Vec::new());
    }
    let mut statement = connection
        .prepare(
            "SELECT id, source_id, folder_name, relative_path
             FROM skills",
        )
        .map_err(|error| MigrationV4Error::sqlite("read skill identities", error))?;
    let rows = statement
        .query_map([], |row| {
            Ok(SkillIdentity {
                id: row.get(0)?,
                source_id: row.get(1)?,
                folder_name: row.get(2)?,
                relative_path: row.get(3)?,
            })
        })
        .map_err(|error| MigrationV4Error::sqlite("query skill identities", error))?;
    collect_sql_rows(rows, "collect skill identities")
}

fn read_source_overrides(connection: &Connection) -> Result<Vec<SourceOverride>, MigrationV4Error> {
    if !table_exists(connection, "source_overrides")? {
        return Ok(Vec::new());
    }
    let rating_expression = if column_exists(connection, "source_overrides", "rating")? {
        "COALESCE(rating, 0)"
    } else {
        "0"
    };
    let sql = format!(
        "SELECT source_id, COALESCE(display_name, ''), COALESCE(source_type, ''),
                COALESCE(category_id, ''), COALESCE(note, ''), enabled,
                {}, COALESCE(updated_at, '')
         FROM source_overrides",
        rating_expression
    );
    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| MigrationV4Error::sqlite("read source overrides", error))?;
    let rows = statement
        .query_map([], |row| {
            Ok(SourceOverride {
                target_id: row.get(0)?,
                display_name: row.get(1)?,
                source_type: row.get(2)?,
                category_id: row.get(3)?,
                note: row.get(4)?,
                enabled: row.get(5)?,
                rating: row.get(6)?,
                updated_at: row.get(7)?,
            })
        })
        .map_err(|error| MigrationV4Error::sqlite("query source overrides", error))?;
    collect_sql_rows(rows, "collect source overrides")
}

fn read_skill_overrides(connection: &Connection) -> Result<Vec<SkillOverride>, MigrationV4Error> {
    if !table_exists(connection, "skill_overrides")? {
        return Ok(Vec::new());
    }
    let rating_expression = if column_exists(connection, "skill_overrides", "rating")? {
        "COALESCE(rating, 0)"
    } else {
        "0"
    };
    let sql = format!(
        "SELECT skill_id, COALESCE(display_name, ''), COALESCE(category_id, ''),
                COALESCE(description, ''), COALESCE(note, ''), enabled,
                {}, COALESCE(updated_at, '')
         FROM skill_overrides",
        rating_expression
    );
    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| MigrationV4Error::sqlite("read skill overrides", error))?;
    let rows = statement
        .query_map([], |row| {
            Ok(SkillOverride {
                target_id: row.get(0)?,
                display_name: row.get(1)?,
                category_id: row.get(2)?,
                description: row.get(3)?,
                note: row.get(4)?,
                enabled: row.get(5)?,
                rating: row.get(6)?,
                updated_at: row.get(7)?,
            })
        })
        .map_err(|error| MigrationV4Error::sqlite("query skill overrides", error))?;
    collect_sql_rows(rows, "collect skill overrides")
}

fn read_tags(connection: &Connection) -> Result<Vec<TagRecord>, MigrationV4Error> {
    if !table_exists(connection, "tags")? {
        return Ok(Vec::new());
    }
    let mut statement = connection
        .prepare("SELECT id, COALESCE(name, ''), COALESCE(color, '') FROM tags")
        .map_err(|error| MigrationV4Error::sqlite("read tags", error))?;
    let rows = statement
        .query_map([], |row| {
            Ok(TagRecord {
                id: row.get(0)?,
                name: row.get(1)?,
                color: row.get(2)?,
            })
        })
        .map_err(|error| MigrationV4Error::sqlite("query tags", error))?;
    collect_sql_rows(rows, "collect tags")
}

fn read_tag_overrides(
    connection: &Connection,
    table: &str,
    target_column: &str,
) -> Result<Vec<TagOverrideRecord>, MigrationV4Error> {
    if !table_exists(connection, table)? {
        return Ok(Vec::new());
    }
    let sql = format!(
        "SELECT {}, tag_id, COALESCE(updated_at, '') FROM {}",
        target_column, table
    );
    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| MigrationV4Error::sqlite(format!("read {}", table), error))?;
    let rows = statement
        .query_map([], |row| {
            Ok(TagOverrideRecord {
                target_id: row.get(0)?,
                tag_id: row.get(1)?,
                updated_at: row.get(2)?,
            })
        })
        .map_err(|error| MigrationV4Error::sqlite(format!("query {}", table), error))?;
    collect_sql_rows(rows, &format!("collect {}", table))
}

fn read_usage_events(connection: &Connection) -> Result<Vec<UsageEventRecord>, MigrationV4Error> {
    if !table_exists(connection, "usage_events")? {
        return Ok(Vec::new());
    }
    let mut statement = connection
        .prepare(
            "SELECT id, target_type, target_id, COALESCE(target_name, ''),
                    COALESCE(source_name, ''), event_type, created_at
             FROM usage_events",
        )
        .map_err(|error| MigrationV4Error::sqlite("read usage events", error))?;
    let rows = statement
        .query_map([], |row| {
            Ok(UsageEventRecord {
                id: row.get(0)?,
                target_type: row.get(1)?,
                target_id: row.get(2)?,
                target_name: row.get(3)?,
                source_name: row.get(4)?,
                event_type: row.get(5)?,
                created_at: row.get(6)?,
            })
        })
        .map_err(|error| MigrationV4Error::sqlite("query usage events", error))?;
    collect_sql_rows(rows, "collect usage events")
}

fn collect_sql_rows<T>(
    rows: rusqlite::MappedRows<'_, impl FnMut(&rusqlite::Row<'_>) -> rusqlite::Result<T>>,
    stage: &str,
) -> Result<Vec<T>, MigrationV4Error> {
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| MigrationV4Error::sqlite(stage, error))
}

fn apply_merge_plan(
    transaction: &Transaction<'_>,
    plan: &MergePlan,
) -> Result<(), MigrationV4Error> {
    for tag in &plan.tags {
        transaction
            .execute(
                "INSERT INTO tags (id, name, color)
                 VALUES (?1, ?2, ?3)
                 ON CONFLICT(id) DO UPDATE SET
                    name = excluded.name,
                    color = excluded.color",
                params![tag.id, tag.name, tag.color],
            )
            .map_err(|error| MigrationV4Error::sqlite("merge tags", error))?;
    }

    for value in &plan.source_overrides {
        transaction
            .execute(
                "INSERT INTO source_overrides (
                    source_id, display_name, source_type, category_id, note,
                    enabled, rating, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                 ON CONFLICT(source_id) DO UPDATE SET
                    display_name = excluded.display_name,
                    source_type = excluded.source_type,
                    category_id = excluded.category_id,
                    note = excluded.note,
                    enabled = excluded.enabled,
                    rating = excluded.rating,
                    updated_at = excluded.updated_at",
                params![
                    value.target_id,
                    value.display_name,
                    value.source_type,
                    value.category_id,
                    value.note,
                    value.enabled,
                    value.rating,
                    value.updated_at
                ],
            )
            .map_err(|error| MigrationV4Error::sqlite("merge source overrides", error))?;
    }

    for value in &plan.skill_overrides {
        transaction
            .execute(
                "INSERT INTO skill_overrides (
                    skill_id, display_name, category_id, description, note,
                    enabled, rating, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                 ON CONFLICT(skill_id) DO UPDATE SET
                    display_name = excluded.display_name,
                    category_id = excluded.category_id,
                    description = excluded.description,
                    note = excluded.note,
                    enabled = excluded.enabled,
                    rating = excluded.rating,
                    updated_at = excluded.updated_at",
                params![
                    value.target_id,
                    value.display_name,
                    value.category_id,
                    value.description,
                    value.note,
                    value.enabled,
                    value.rating,
                    value.updated_at
                ],
            )
            .map_err(|error| MigrationV4Error::sqlite("merge skill overrides", error))?;
    }

    for value in &plan.source_tag_overrides {
        transaction
            .execute(
                "INSERT OR IGNORE INTO source_tag_overrides (
                    source_id, tag_id, updated_at
                 ) VALUES (?1, ?2, ?3)",
                params![value.target_id, value.tag_id, value.updated_at],
            )
            .map_err(|error| MigrationV4Error::sqlite("merge source tag overrides", error))?;
    }

    for value in &plan.skill_tag_overrides {
        transaction
            .execute(
                "INSERT OR IGNORE INTO skill_tag_overrides (
                    skill_id, tag_id, updated_at
                 ) VALUES (?1, ?2, ?3)",
                params![value.target_id, value.tag_id, value.updated_at],
            )
            .map_err(|error| MigrationV4Error::sqlite("merge skill tag overrides", error))?;
    }

    for event in &plan.usage_events {
        transaction
            .execute(
                "INSERT OR IGNORE INTO usage_events (
                    id, target_type, target_id, target_name, source_name,
                    event_type, created_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    event.id,
                    event.target_type,
                    event.target_id,
                    event.target_name,
                    event.source_name,
                    event.event_type,
                    event.created_at
                ],
            )
            .map_err(|error| MigrationV4Error::sqlite("merge usage events", error))?;
    }

    Ok(())
}

fn ensure_metadata_merge_schema(connection: &Connection) -> Result<(), MigrationV4Error> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS tags (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL UNIQUE,
                color TEXT NOT NULL DEFAULT ''
             );
             CREATE TABLE IF NOT EXISTS skill_overrides (
                skill_id TEXT PRIMARY KEY,
                display_name TEXT NOT NULL DEFAULT '',
                category_id TEXT NOT NULL DEFAULT '',
                description TEXT NOT NULL DEFAULT '',
                note TEXT NOT NULL DEFAULT '',
                enabled INTEGER,
                rating INTEGER NOT NULL DEFAULT 0,
                updated_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS source_overrides (
                source_id TEXT PRIMARY KEY,
                display_name TEXT NOT NULL DEFAULT '',
                source_type TEXT NOT NULL DEFAULT '',
                category_id TEXT NOT NULL DEFAULT '',
                note TEXT NOT NULL DEFAULT '',
                enabled INTEGER,
                rating INTEGER NOT NULL DEFAULT 0,
                updated_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS source_tag_overrides (
                source_id TEXT NOT NULL,
                tag_id TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                PRIMARY KEY(source_id, tag_id),
                FOREIGN KEY(source_id) REFERENCES sources(id),
                FOREIGN KEY(tag_id) REFERENCES tags(id)
             );
             CREATE TABLE IF NOT EXISTS skill_tag_overrides (
                skill_id TEXT NOT NULL,
                tag_id TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                PRIMARY KEY(skill_id, tag_id),
                FOREIGN KEY(skill_id) REFERENCES skills(id),
                FOREIGN KEY(tag_id) REFERENCES tags(id)
             );
             CREATE TABLE IF NOT EXISTS usage_events (
                id TEXT PRIMARY KEY,
                target_type TEXT NOT NULL,
                target_id TEXT NOT NULL,
                target_name TEXT NOT NULL DEFAULT '',
                source_name TEXT NOT NULL DEFAULT '',
                event_type TEXT NOT NULL,
                created_at TEXT NOT NULL
             );",
        )
        .map_err(|error| MigrationV4Error::sqlite("ensure metadata merge schema", error))?;

    if !column_exists(connection, "source_overrides", "rating")? {
        connection
            .execute(
                "ALTER TABLE source_overrides
                 ADD COLUMN rating INTEGER NOT NULL DEFAULT 0",
                [],
            )
            .map_err(|error| {
                MigrationV4Error::sqlite("add source override rating column", error)
            })?;
    }
    if !column_exists(connection, "skill_overrides", "rating")? {
        connection
            .execute(
                "ALTER TABLE skill_overrides
                 ADD COLUMN rating INTEGER NOT NULL DEFAULT 0",
                [],
            )
            .map_err(|error| MigrationV4Error::sqlite("add skill override rating column", error))?;
    }
    Ok(())
}

fn table_exists(connection: &Connection, table: &str) -> Result<bool, MigrationV4Error> {
    connection
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1 LIMIT 1",
            params![table],
            |_| Ok(()),
        )
        .optional()
        .map(|value| value.is_some())
        .map_err(|error| MigrationV4Error::sqlite(format!("inspect table {}", table), error))
}

fn column_exists(
    connection: &Connection,
    table: &str,
    column: &str,
) -> Result<bool, MigrationV4Error> {
    if !table_exists(connection, table)? {
        return Ok(false);
    }
    let mut statement = connection
        .prepare(&format!("PRAGMA table_info({})", table))
        .map_err(|error| {
            MigrationV4Error::sqlite(format!("inspect columns for {}", table), error)
        })?;
    let names = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| MigrationV4Error::sqlite(format!("query columns for {}", table), error))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| {
            MigrationV4Error::sqlite(format!("collect columns for {}", table), error)
        })?;
    Ok(names.iter().any(|name| name == column))
}

fn open_read_only_database(path: &Path, stage: &str) -> Result<Connection, MigrationV4Error> {
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| MigrationV4Error::sqlite(stage, error))?;
    connection
        .busy_timeout(Duration::from_secs(10))
        .map_err(|error| MigrationV4Error::sqlite("configure database busy timeout", error))?;
    Ok(connection)
}

fn ensure_database_healthy(connection: &Connection, stage: &str) -> Result<(), MigrationV4Error> {
    let result = connection
        .query_row("PRAGMA quick_check", [], |row| row.get::<_, String>(0))
        .map_err(|error| MigrationV4Error::sqlite(stage, error))?;
    if result.eq_ignore_ascii_case("ok") {
        Ok(())
    } else {
        Err(MigrationV4Error::new(stage, result))
    }
}

fn backup_current_database(
    current_database: &Path,
    backup_root: &Path,
) -> Result<PathBuf, MigrationV4Error> {
    fs::create_dir_all(backup_root)
        .map_err(|error| MigrationV4Error::io("create database backup root", backup_root, error))?;

    {
        let connection = Connection::open(current_database).map_err(|error| {
            MigrationV4Error::sqlite("open current database for checkpoint", error)
        })?;
        connection
            .busy_timeout(Duration::from_secs(10))
            .map_err(|error| MigrationV4Error::sqlite("configure checkpoint timeout", error))?;
        connection
            .execute_batch("PRAGMA wal_checkpoint(FULL);")
            .map_err(|error| MigrationV4Error::sqlite("checkpoint current database", error))?;
    }

    let stem = current_database
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("skillhub-next");
    let mut backup_path = backup_root.join(format!(
        "{}-before-migration-v4-{}.sqlite3",
        stem,
        unix_timestamp_string()
    ));
    let mut collision = 1u32;
    while backup_path.exists() {
        backup_path = backup_root.join(format!(
            "{}-before-migration-v4-{}-{}.sqlite3",
            stem,
            unix_timestamp_string(),
            collision
        ));
        collision += 1;
    }

    fs::copy(current_database, &backup_path).map_err(|error| {
        MigrationV4Error::io("copy current database backup", &backup_path, error)
    })?;
    let source_len = fs::metadata(current_database)
        .map_err(|error| {
            MigrationV4Error::io(
                "inspect current database after backup",
                current_database,
                error,
            )
        })?
        .len();
    let backup_len = fs::metadata(&backup_path)
        .map_err(|error| MigrationV4Error::io("inspect database backup", &backup_path, error))?
        .len();
    if source_len == 0 || source_len != backup_len {
        return Err(MigrationV4Error::new(
            "verify database backup",
            format!(
                "Backup length {} does not match current database length {}.",
                backup_len, source_len
            ),
        ));
    }

    let backup = open_read_only_database(&backup_path, "open database backup for verification")?;
    ensure_database_healthy(&backup, "database backup integrity check")?;
    Ok(backup_path)
}

fn paths_refer_to_same_file(left: &Path, right: &Path) -> bool {
    match (fs::canonicalize(left), fs::canonicalize(right)) {
        (Ok(left), Ok(right)) => {
            normalize_path_text(&left.to_string_lossy())
                == normalize_path_text(&right.to_string_lossy())
        }
        _ => {
            normalize_path_text(&left.to_string_lossy())
                == normalize_path_text(&right.to_string_lossy())
        }
    }
}

pub fn write_migration_v4_manifest(
    manifest_path: &Path,
    report: &MigrationV4Report,
) -> Result<(), MigrationV4Error> {
    if report.dry_run {
        return Ok(());
    }
    if let Some(parent) = manifest_path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            MigrationV4Error::io("create migration manifest parent", parent, error)
        })?;
    }
    let json = serde_json::to_vec_pretty(report).map_err(|error| {
        MigrationV4Error::new("serialize migration v4 manifest", error.to_string())
    })?;
    let temporary_path = manifest_path.with_extension(format!(
        "{}.tmp",
        manifest_path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("json")
    ));
    fs::write(&temporary_path, json).map_err(|error| {
        MigrationV4Error::io(
            "write migration v4 manifest temporary file",
            &temporary_path,
            error,
        )
    })?;

    if manifest_path.exists() {
        fs::copy(&temporary_path, manifest_path).map_err(|error| {
            MigrationV4Error::io("replace migration v4 manifest", manifest_path, error)
        })?;
        fs::remove_file(&temporary_path).map_err(|error| {
            MigrationV4Error::io(
                "remove migration v4 manifest temporary file",
                &temporary_path,
                error,
            )
        })?;
    } else {
        fs::rename(&temporary_path, manifest_path).map_err(|error| {
            MigrationV4Error::io("promote migration v4 manifest", manifest_path, error)
        })?;
    }
    Ok(())
}

fn next_manifest_attempt(manifest_path: &Path) -> (u32, Vec<String>) {
    if !manifest_path.is_file() {
        return (1, Vec::new());
    }
    match fs::read_to_string(manifest_path)
        .ok()
        .and_then(|text| serde_json::from_str::<MigrationV4Report>(&text).ok())
    {
        Some(previous) if previous.schema_version == MIGRATION_V4_SCHEMA_VERSION => {
            (previous.attempt.saturating_add(1), Vec::new())
        }
        _ => (
            1,
            vec![format!(
                "The previous migration-v4 manifest could not be parsed; recovery remains resumable from per-source staging: {}",
                manifest_path.to_string_lossy()
            )],
        ),
    }
}

fn normalize_repository_url(value: &str) -> String {
    let mut normalized = value.trim().replace('\\', "/").to_lowercase();
    while normalized.ends_with('/') {
        normalized.pop();
    }
    if normalized.ends_with(".git") {
        normalized.truncate(normalized.len().saturating_sub(4));
    }
    normalized
}

fn normalize_key(value: &str) -> String {
    value.trim().to_lowercase()
}

fn normalize_path_text(value: &str) -> String {
    value
        .trim()
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_lowercase()
}

fn normalized_absolute_path(path: &Path) -> String {
    fs::canonicalize(path)
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .into_owned()
}

fn path_option_to_string(path: Option<&Path>) -> Option<String> {
    path.map(|value| value.to_string_lossy().into_owned())
}

fn path_file_name_lossy(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "source".to_string())
}

fn nonempty_or_timestamp(value: &str) -> String {
    if value.trim().is_empty() {
        unix_timestamp_string()
    } else {
        value.to_string()
    }
}

fn stable_id(prefix: &str, value: &str) -> String {
    let slug = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect::<String>()
        .split('-')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-");

    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    value.hash(&mut hasher);
    let hash = format!("{:016x}", hasher.finish());
    let suffix = &hash[..10];
    if slug.is_empty() {
        format!("{}-{}", prefix, suffix)
    } else {
        format!("{}-{}-{}", prefix, slug, suffix)
    }
}

fn fnv1a64(bytes: &[u8]) -> u64 {
    let mut hash = 0xcbf29ce484222325u64;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

fn unix_timestamp_string() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos().to_string())
        .unwrap_or_else(|_| "0".to_string())
}

#[cfg(windows)]
fn is_link_like(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
    metadata.file_type().is_symlink()
        || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn is_link_like(metadata: &fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEST_COUNTER: AtomicU64 = AtomicU64::new(0);

    struct TestDirectory {
        path: PathBuf,
    }

    impl TestDirectory {
        fn new(name: &str) -> Self {
            let counter = TEST_COUNTER.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "ai-skillhub-migration-v4-{}-{}-{}",
                name,
                std::process::id(),
                counter
            ));
            if path.exists() {
                fs::remove_dir_all(&path).expect("remove stale test directory");
            }
            fs::create_dir_all(&path).expect("create test directory");
            Self { path }
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn test_config(root: &Path) -> MigrationV4Config {
        MigrationV4Config::new(
            root.join("legacy-sources"),
            root.join("current-sources"),
            root.join("staging"),
            Some(root.join("legacy.sqlite3")),
            Some(root.join("current.sqlite3")),
            root.join("backups"),
            root.join("migration-v4.json"),
            false,
        )
    }

    fn write_file(path: &Path, text: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("create file parent");
        }
        fs::write(path, text).expect("write test file");
    }

    fn create_git_source(path: &Path, head: &str) {
        write_file(&path.join("SKILL.md"), "# Test Skill");
        write_file(&path.join("nested").join("notes.txt"), "notes");
        write_file(&path.join(".git").join("HEAD"), "ref: refs/heads/main\n");
        write_file(
            &path.join(".git").join("refs").join("heads").join("main"),
            &format!("{}\n", head),
        );
    }

    fn create_metadata_schema(connection: &Connection) {
        connection
            .execute_batch(
                "PRAGMA foreign_keys = ON;
                 CREATE TABLE sources (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    url TEXT,
                    local_path TEXT
                 );
                 CREATE TABLE skills (
                    id TEXT PRIMARY KEY,
                    source_id TEXT,
                    folder_name TEXT NOT NULL,
                    relative_path TEXT NOT NULL
                 );
                 CREATE TABLE tags (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL UNIQUE,
                    color TEXT NOT NULL DEFAULT ''
                 );
                 CREATE TABLE source_overrides (
                    source_id TEXT PRIMARY KEY,
                    display_name TEXT NOT NULL DEFAULT '',
                    source_type TEXT NOT NULL DEFAULT '',
                    category_id TEXT NOT NULL DEFAULT '',
                    note TEXT NOT NULL DEFAULT '',
                    enabled INTEGER,
                    rating INTEGER NOT NULL DEFAULT 0,
                    updated_at TEXT NOT NULL
                 );
                 CREATE TABLE skill_overrides (
                    skill_id TEXT PRIMARY KEY,
                    display_name TEXT NOT NULL DEFAULT '',
                    category_id TEXT NOT NULL DEFAULT '',
                    description TEXT NOT NULL DEFAULT '',
                    note TEXT NOT NULL DEFAULT '',
                    enabled INTEGER,
                    rating INTEGER NOT NULL DEFAULT 0,
                    updated_at TEXT NOT NULL
                 );
                 CREATE TABLE source_tag_overrides (
                    source_id TEXT NOT NULL,
                    tag_id TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY(source_id, tag_id),
                    FOREIGN KEY(source_id) REFERENCES sources(id),
                    FOREIGN KEY(tag_id) REFERENCES tags(id)
                 );
                 CREATE TABLE skill_tag_overrides (
                    skill_id TEXT NOT NULL,
                    tag_id TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY(skill_id, tag_id),
                    FOREIGN KEY(skill_id) REFERENCES skills(id),
                    FOREIGN KEY(tag_id) REFERENCES tags(id)
                 );
                 CREATE TABLE usage_events (
                    id TEXT PRIMARY KEY,
                    target_type TEXT NOT NULL,
                    target_id TEXT NOT NULL,
                    target_name TEXT NOT NULL DEFAULT '',
                    source_name TEXT NOT NULL DEFAULT '',
                    event_type TEXT NOT NULL,
                    created_at TEXT NOT NULL
                 );",
            )
            .expect("create metadata schema");
    }

    fn seed_identity_rows(connection: &Connection) {
        connection
            .execute(
                "INSERT INTO sources (id, name, url, local_path)
                 VALUES ('source-research', 'Research', 'https://github.com/example/research.git', 'Research')",
                [],
            )
            .expect("insert source");
        connection
            .execute(
                "INSERT INTO skills (id, source_id, folder_name, relative_path)
                 VALUES ('skill-review', 'source-research', 'paper-review', 'skills/paper-review')",
                [],
            )
            .expect("insert skill");
    }

    #[test]
    fn resumes_interrupted_source_copy_and_promotes_only_after_verification() {
        let root = TestDirectory::new("resume-copy");
        let config = test_config(&root.path);
        let legacy = config.legacy_sources_root.join("Research");
        let head = "1111111111111111111111111111111111111111";
        create_git_source(&legacy, head);
        fs::create_dir_all(&config.staging_root).expect("create staging root");

        let (staging, owner) = staging_paths(&config, "Research");
        let marker = StagingOwner {
            schema_version: MIGRATION_V4_SCHEMA_VERSION,
            source_name: "Research".to_string(),
            legacy_source: normalized_absolute_path(&legacy),
        };
        write_file(
            &owner,
            &serde_json::to_string_pretty(&marker).expect("serialize owner"),
        );
        write_file(&staging.join("SKILL.md"), "# Test Skill");

        let report = recover_sources_v4(&config).expect("recover source");
        assert_eq!(report.summary.promoted, 1);
        assert_eq!(report.summary.resumed, 1);
        assert_eq!(report.entries[0].status, SourceRecoveryStatus::Promoted);
        let target = config.current_sources_root.join("Research");
        assert!(target.join("SKILL.md").is_file());
        assert!(target.join("nested").join("notes.txt").is_file());
        assert!(matches!(
            inspect_git_head(&target),
            GitHeadState::Valid(value) if value == head
        ));
        assert!(!staging.exists());
        assert!(!owner.exists());
    }

    #[test]
    fn keeps_a_newer_existing_target_without_overwrite() {
        let root = TestDirectory::new("keep-current");
        let config = test_config(&root.path);
        let legacy = config.legacy_sources_root.join("Research");
        let target = config.current_sources_root.join("Research");
        create_git_source(&legacy, "1111111111111111111111111111111111111111");
        create_git_source(&target, "2222222222222222222222222222222222222222");
        write_file(&target.join("newer-only.txt"), "keep me");

        let report = recover_sources_v4(&config).expect("inspect source");
        assert_eq!(report.summary.kept_current, 1);
        assert_eq!(report.entries[0].status, SourceRecoveryStatus::KeptCurrent);
        assert_eq!(
            fs::read_to_string(target.join("newer-only.txt")).expect("read newer file"),
            "keep me"
        );
        assert!(matches!(
            inspect_git_head(&target),
            GitHeadState::Valid(value)
                if value == "2222222222222222222222222222222222222222"
        ));
    }

    #[test]
    fn repairs_an_unusable_existing_target_without_losing_its_files() {
        let root = TestDirectory::new("repair-current");
        let config = test_config(&root.path);
        let legacy = config.legacy_sources_root.join("Research");
        let target = config.current_sources_root.join("Research");
        let legacy_head = "1111111111111111111111111111111111111111";
        create_git_source(&legacy, legacy_head);
        write_file(&target.join("SKILL.md"), "# Partial Skill");
        write_file(&target.join("current-only.txt"), "preserve me");

        let report = recover_sources_v4(&config).expect("repair source");
        assert_eq!(report.summary.promoted, 1);
        assert_eq!(report.entries[0].status, SourceRecoveryStatus::Promoted);
        assert!(matches!(
            inspect_git_head(&target),
            GitHeadState::Valid(value) if value == legacy_head
        ));

        let backup = PathBuf::from(
            report.entries[0]
                .backup_path
                .as_ref()
                .expect("repair backup path"),
        );
        assert_eq!(
            fs::read_to_string(backup.join("current-only.txt")).expect("read backup file"),
            "preserve me"
        );
    }

    #[test]
    fn dry_run_reports_work_without_creating_targets_staging_or_manifest() {
        let root = TestDirectory::new("dry-run");
        let mut config = test_config(&root.path);
        config.dry_run = true;
        create_git_source(
            &config.legacy_sources_root.join("Research"),
            "1111111111111111111111111111111111111111",
        );

        let report = run_migration_v4(&config).expect("run dry migration");
        assert!(report.dry_run);
        assert_eq!(report.source_recovery.summary.would_promote, 1);
        assert_eq!(
            report.source_recovery.entries[0].status,
            SourceRecoveryStatus::WouldPromote
        );
        assert!(!config.current_sources_root.exists());
        assert!(!config.staging_root.exists());
        assert!(!config.manifest_path.exists());
        assert!(!config.database_backup_root.exists());
    }

    #[test]
    fn current_manual_override_values_win_and_blank_fields_are_filled() {
        let root = TestDirectory::new("current-wins");
        let config = test_config(&root.path);
        let legacy = Connection::open(config.legacy_database_path.as_deref().expect("legacy path"))
            .expect("open legacy");
        let current = Connection::open(
            config
                .current_database_path
                .as_deref()
                .expect("current path"),
        )
        .expect("open current");
        create_metadata_schema(&legacy);
        create_metadata_schema(&current);
        seed_identity_rows(&legacy);
        seed_identity_rows(&current);

        legacy
            .execute(
                "INSERT INTO source_overrides (
                    source_id, display_name, source_type, category_id, note,
                    enabled, rating, updated_at
                 ) VALUES (
                    'source-research', 'Legacy Name', 'github', 'research',
                    'Legacy note', 1, 5, 'old'
                 )",
                [],
            )
            .expect("insert legacy source override");
        current
            .execute(
                "INSERT INTO source_overrides (
                    source_id, display_name, source_type, category_id, note,
                    enabled, rating, updated_at
                 ) VALUES (
                    'source-research', 'Current Name', '', '', '',
                    0, 4, 'current'
                 )",
                [],
            )
            .expect("insert current source override");
        drop(legacy);
        drop(current);

        let report = merge_legacy_metadata_v4(&config).expect("merge metadata");
        assert_eq!(report.status, MetadataMergeStatus::Merged);
        let current = Connection::open(
            config
                .current_database_path
                .as_deref()
                .expect("current path"),
        )
        .expect("reopen current");
        let row = current
            .query_row(
                "SELECT display_name, source_type, category_id, note, enabled, rating
                 FROM source_overrides WHERE source_id = 'source-research'",
                [],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, i64>(4)?,
                        row.get::<_, i64>(5)?,
                    ))
                },
            )
            .expect("read merged source override");
        assert_eq!(row.0, "Current Name");
        assert_eq!(row.1, "github");
        assert_eq!(row.2, "research");
        assert_eq!(row.3, "Legacy note");
        assert_eq!(row.4, 0);
        assert_eq!(row.5, 4);
        assert!(report
            .backup_path
            .as_deref()
            .is_some_and(|path| Path::new(path).is_file()));
    }

    #[test]
    fn restores_five_star_ratings_and_tag_overrides() {
        let root = TestDirectory::new("rating-tags");
        let config = test_config(&root.path);
        let legacy = Connection::open(config.legacy_database_path.as_deref().expect("legacy path"))
            .expect("open legacy");
        let current = Connection::open(
            config
                .current_database_path
                .as_deref()
                .expect("current path"),
        )
        .expect("open current");
        create_metadata_schema(&legacy);
        create_metadata_schema(&current);
        seed_identity_rows(&legacy);
        seed_identity_rows(&current);

        legacy
            .execute(
                "INSERT INTO source_overrides (
                    source_id, display_name, source_type, category_id, note,
                    enabled, rating, updated_at
                 ) VALUES ('source-research', '', '', '', '', NULL, 5, 'old')",
                [],
            )
            .expect("insert source rating");
        legacy
            .execute(
                "INSERT INTO skill_overrides (
                    skill_id, display_name, category_id, description, note,
                    enabled, rating, updated_at
                 ) VALUES ('skill-review', '', '', '', '', NULL, 5, 'old')",
                [],
            )
            .expect("insert skill rating");
        legacy
            .execute(
                "INSERT INTO tags (id, name, color)
                 VALUES ('tag-academic', '学术研究', '#6c63ff')",
                [],
            )
            .expect("insert legacy tag");
        legacy
            .execute(
                "INSERT INTO source_tag_overrides (source_id, tag_id, updated_at)
                 VALUES ('source-research', 'tag-academic', 'old')",
                [],
            )
            .expect("insert source tag override");
        legacy
            .execute(
                "INSERT INTO skill_tag_overrides (skill_id, tag_id, updated_at)
                 VALUES ('skill-review', 'tag-academic', 'old')",
                [],
            )
            .expect("insert skill tag override");
        drop(legacy);
        drop(current);

        let report = merge_legacy_metadata_v4(&config).expect("merge metadata");
        assert_eq!(report.source_overrides_merged, 1);
        assert_eq!(report.skill_overrides_merged, 1);
        assert_eq!(report.tags_merged, 1);
        assert_eq!(report.source_tag_overrides_merged, 1);
        assert_eq!(report.skill_tag_overrides_merged, 1);

        let current = Connection::open(
            config
                .current_database_path
                .as_deref()
                .expect("current path"),
        )
        .expect("reopen current");
        let source_rating: i64 = current
            .query_row(
                "SELECT rating FROM source_overrides WHERE source_id = 'source-research'",
                [],
                |row| row.get(0),
            )
            .expect("read source rating");
        let skill_rating: i64 = current
            .query_row(
                "SELECT rating FROM skill_overrides WHERE skill_id = 'skill-review'",
                [],
                |row| row.get(0),
            )
            .expect("read skill rating");
        let source_tag_count: i64 = current
            .query_row("SELECT COUNT(*) FROM source_tag_overrides", [], |row| {
                row.get(0)
            })
            .expect("count source tags");
        let skill_tag_count: i64 = current
            .query_row("SELECT COUNT(*) FROM skill_tag_overrides", [], |row| {
                row.get(0)
            })
            .expect("count skill tags");
        assert_eq!(source_rating, 5);
        assert_eq!(skill_rating, 5);
        assert_eq!(source_tag_count, 1);
        assert_eq!(skill_tag_count, 1);
    }
}
