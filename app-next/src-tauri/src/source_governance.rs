use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use super::SourceCard;

const GIT_TIMEOUT: Duration = Duration::from_secs(20);
const GIT_FETCH_TIMEOUT: Duration = Duration::from_secs(45);
const GOVERNANCE_SCHEMA_VERSION: u8 = 1;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SourceGovernanceCard {
    pub source_id: String,
    pub source_name: String,
    pub source_folder: String,
    pub support_status: String,
    pub pinned: bool,
    pub pinned_revision: String,
    pub current_revision: String,
    pub remote_revision: String,
    pub relation: String,
    pub ahead_count: u32,
    pub behind_count: u32,
    pub changed_files: u32,
    pub additions: u32,
    pub deletions: u32,
    pub remote_summary: String,
    pub last_checked_at: String,
    pub diff_source: String,
    pub backup_count: u32,
    pub latest_backup_id: String,
    pub latest_backup_revision: String,
    pub latest_backup_at: String,
    pub can_rollback: bool,
    pub status: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SourceQualitySignalCard {
    pub source_id: String,
    pub source_name: String,
    pub score: Option<u8>,
    pub status: String,
    pub evidence_count: u8,
    pub evidence_total: u8,
    pub summary: String,
    pub factors: Vec<SourceQualityFactorCard>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SourceQualityFactorCard {
    pub key: String,
    pub label: String,
    pub status: String,
    pub score: Option<u8>,
    pub weight: u8,
    pub detail: String,
}

#[derive(Debug, Clone)]
struct SourceRecord {
    id: String,
    name: String,
    source_type: String,
    local_path: String,
}

#[derive(Debug, Clone)]
struct BackupRecord {
    id: String,
    revision: String,
    created_at: String,
}

#[derive(Debug, Clone, Default)]
struct DiffSummary {
    remote_revision: String,
    relation: String,
    ahead_count: u32,
    behind_count: u32,
    changed_files: u32,
    additions: u32,
    deletions: u32,
    remote_summary: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PinManifest<'a> {
    schema_version: u8,
    updated_at: String,
    pins: Vec<PinManifestItem<'a>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PinManifestItem<'a> {
    source_id: &'a str,
    source_name: &'a str,
    source_folder: &'a str,
    pinned_revision: &'a str,
}

pub(crate) fn ensure_schema(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS source_governance (
                source_id TEXT PRIMARY KEY,
                source_folder TEXT NOT NULL DEFAULT '',
                pinned INTEGER NOT NULL DEFAULT 0,
                pinned_revision TEXT NOT NULL DEFAULT '',
                current_revision TEXT NOT NULL DEFAULT '',
                remote_revision TEXT NOT NULL DEFAULT '',
                relation TEXT NOT NULL DEFAULT 'unknown',
                ahead_count INTEGER NOT NULL DEFAULT 0,
                behind_count INTEGER NOT NULL DEFAULT 0,
                changed_files INTEGER NOT NULL DEFAULT 0,
                additions INTEGER NOT NULL DEFAULT 0,
                deletions INTEGER NOT NULL DEFAULT 0,
                remote_summary TEXT NOT NULL DEFAULT '',
                last_checked_at TEXT NOT NULL DEFAULT '',
                diff_source TEXT NOT NULL DEFAULT 'none',
                status TEXT NOT NULL DEFAULT 'not-inspected',
                message TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL DEFAULT ''
            );
            CREATE TABLE IF NOT EXISTS source_version_backups (
                id TEXT PRIMARY KEY,
                source_id TEXT NOT NULL,
                source_name TEXT NOT NULL DEFAULT '',
                source_folder TEXT NOT NULL DEFAULT '',
                revision TEXT NOT NULL,
                backup_ref TEXT NOT NULL DEFAULT '',
                snapshot_path TEXT NOT NULL DEFAULT '',
                verified INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_source_version_backups_source
                ON source_version_backups(source_id, created_at DESC);
            CREATE TABLE IF NOT EXISTS source_security_state (
                source_id TEXT PRIMARY KEY,
                scan_status TEXT NOT NULL DEFAULT 'not-scanned',
                risk_level TEXT NOT NULL DEFAULT 'unknown',
                scanned_files INTEGER NOT NULL DEFAULT 0,
                high_findings INTEGER NOT NULL DEFAULT 0,
                medium_findings INTEGER NOT NULL DEFAULT 0,
                checked_at TEXT NOT NULL DEFAULT ''
            );",
        )
        .map_err(|error| format!("Cannot ensure source governance schema: {error}"))
}

pub(crate) fn read_governance_cards(
    root: &Path,
    connection: &Connection,
    sources: &[SourceCard],
) -> Result<Vec<SourceGovernanceCard>, String> {
    ensure_schema(connection)?;
    let mut cards = Vec::with_capacity(sources.len());

    for source in sources {
        let folder = source_folder_name(&source.local_path, &source.name);
        let cached = connection
            .query_row(
                "SELECT
                    pinned, pinned_revision, current_revision, remote_revision,
                    relation, ahead_count, behind_count, changed_files, additions,
                    deletions, remote_summary, last_checked_at, diff_source, status, message
                 FROM source_governance WHERE source_id = ?1",
                params![source.id],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)? != 0,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, i64>(5)?.max(0) as u32,
                        row.get::<_, i64>(6)?.max(0) as u32,
                        row.get::<_, i64>(7)?.max(0) as u32,
                        row.get::<_, i64>(8)?.max(0) as u32,
                        row.get::<_, i64>(9)?.max(0) as u32,
                        row.get::<_, String>(10)?,
                        row.get::<_, String>(11)?,
                        row.get::<_, String>(12)?,
                        row.get::<_, String>(13)?,
                        row.get::<_, String>(14)?,
                    ))
                },
            )
            .optional()
            .map_err(|error| format!("Cannot read source governance state: {error}"))?;

        let path = resolve_source_path(root, &source.local_path, &folder);
        let live_revision = path
            .as_deref()
            .filter(|path| is_git_repository(path))
            .and_then(|path| git_revision(path).ok())
            .unwrap_or_default();
        let support_status = if path.as_deref().is_some_and(is_git_repository) {
            "git".to_string()
        } else if source.url.trim().is_empty() {
            "local".to_string()
        } else {
            "snapshot".to_string()
        };
        let (
            pinned,
            pinned_revision,
            cached_revision,
            remote_revision,
            relation,
            ahead_count,
            behind_count,
            changed_files,
            additions,
            deletions,
            remote_summary,
            last_checked_at,
            diff_source,
            mut status,
            mut message,
        ) = cached.unwrap_or_else(|| {
            (
                false,
                String::new(),
                String::new(),
                String::new(),
                "unknown".to_string(),
                0,
                0,
                0,
                0,
                0,
                String::new(),
                String::new(),
                "none".to_string(),
                "not-inspected".to_string(),
                String::new(),
            )
        });
        let current_revision = if live_revision.is_empty() {
            cached_revision
        } else {
            live_revision
        };
        if support_status != "git" {
            status = "unsupported".to_string();
            message = if support_status == "local" {
                "Local folders have no Git revision; AI SkillHub will never invent one.".to_string()
            } else {
                "This source was downloaded without Git history. Its cached identity is preserved, but commit pin/diff is unavailable.".to_string()
            };
        } else if pinned {
            status = "pinned".to_string();
            message = format!(
                "Sync keeps this source at {}.",
                short_revision(&pinned_revision)
            );
        }

        let (backup_count, latest_backup) =
            backup_summary(connection, &source.id, &current_revision)?;
        let latest_backup_id = latest_backup
            .as_ref()
            .map(|backup| backup.id.clone())
            .unwrap_or_default();
        let latest_backup_revision = latest_backup
            .as_ref()
            .map(|backup| backup.revision.clone())
            .unwrap_or_default();
        let latest_backup_at = latest_backup
            .as_ref()
            .map(|backup| backup.created_at.clone())
            .unwrap_or_default();
        let can_rollback = support_status == "git"
            && !latest_backup_revision.is_empty()
            && !current_revision.is_empty()
            && latest_backup_revision != current_revision;

        cards.push(SourceGovernanceCard {
            source_id: source.id.clone(),
            source_name: source.name.clone(),
            source_folder: folder,
            support_status,
            pinned,
            pinned_revision,
            current_revision,
            remote_revision,
            relation,
            ahead_count,
            behind_count,
            changed_files,
            additions,
            deletions,
            remote_summary,
            last_checked_at,
            diff_source,
            backup_count,
            latest_backup_id,
            latest_backup_revision,
            latest_backup_at,
            can_rollback,
            status,
            message,
        });
    }

    Ok(cards)
}

pub(crate) fn read_quality_signals(
    connection: &Connection,
    sources: &[SourceCard],
) -> Result<Vec<SourceQualitySignalCard>, String> {
    ensure_schema(connection)?;
    let mut cards = Vec::with_capacity(sources.len());
    for source in sources {
        let mut factors = Vec::with_capacity(4);

        let child_ratings: (i64, f64) = connection
            .query_row(
                "SELECT
                    COUNT(CASE WHEN COALESCE(skill_overrides.rating, 0) > 0 THEN 1 END),
                    COALESCE(AVG(CASE WHEN COALESCE(skill_overrides.rating, 0) > 0
                        THEN skill_overrides.rating END), 0)
                 FROM skills
                 LEFT JOIN skill_overrides ON skill_overrides.skill_id = skills.id
                 WHERE skills.source_id = ?1",
                params![source.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap_or((0, 0.0));
        let personal_rating = if source.rating > 0 {
            Some((source.rating as f64, "parent/source rating".to_string()))
        } else if child_ratings.0 > 0 {
            Some((
                child_ratings.1,
                format!("average of {} rated child Skill(s)", child_ratings.0),
            ))
        } else {
            None
        };
        factors.push(quality_factor(
            "personal-rating",
            "Personal rating",
            40,
            personal_rating.map(|(rating, detail)| {
                (
                    (rating.clamp(0.0, 5.0) * 20.0).round() as u8,
                    format!("{rating:.1}/5 · {detail}"),
                )
            }),
            "No personal rating yet; excluded from the score.",
        ));

        let health_counts: (i64, i64, i64) = connection
            .query_row(
                "SELECT
                    COUNT(*),
                    SUM(CASE WHEN health_status = 'ok' THEN 1 ELSE 0 END),
                    SUM(CASE WHEN health_status = 'error' THEN 1 ELSE 0 END)
                 FROM skills WHERE source_id = ?1",
                params![source.id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap_or((0, 0, 0));
        let health_score = if health_counts.0 > 0 {
            let healthy = health_counts.1.max(0) as f64 / health_counts.0 as f64;
            let errors = health_counts.2.max(0) as f64 / health_counts.0 as f64;
            ((healthy * 100.0) - (errors * 25.0)).clamp(0.0, 100.0) as u8
        } else if source.source_type.eq_ignore_ascii_case("prompt") {
            75
        } else {
            match source.health.as_str() {
                "ok" => 100,
                "info" => 75,
                "warn" => 45,
                "error" => 10,
                _ => 50,
            }
        };
        factors.push(quality_factor(
            "health",
            "Health",
            25,
            Some((
                health_score,
                if health_counts.0 > 0 {
                    format!(
                        "{} healthy / {} indexed Skill(s), {} error(s)",
                        health_counts.1.max(0),
                        health_counts.0,
                        health_counts.2.max(0)
                    )
                } else {
                    format!("source health: {}", source.health)
                },
            )),
            "",
        ));

        let usage_count = connection
            .query_row(
                "SELECT COUNT(*) FROM usage_events
                 WHERE target_id = ?1
                    OR lower(source_name) = lower(?2)",
                params![source.id, source.name],
                |row| row.get::<_, i64>(0),
            )
            .unwrap_or(0)
            .max(0) as u64;
        factors.push(quality_factor(
            "actual-usage",
            "Actual local usage",
            15,
            (usage_count > 0).then(|| {
                let score = (35.0 + ((usage_count + 1) as f64).log2() * 15.0).min(100.0) as u8;
                (
                    score,
                    format!("{usage_count} locally recorded use event(s)"),
                )
            }),
            "No locally recorded use event; excluded from the score.",
        ));

        let security = connection
            .query_row(
                "SELECT scan_status, risk_level, scanned_files, high_findings, medium_findings, checked_at
                 FROM source_security_state WHERE source_id = ?1",
                params![source.id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?.max(0) as u64,
                        row.get::<_, i64>(3)?.max(0) as u64,
                        row.get::<_, i64>(4)?.max(0) as u64,
                        row.get::<_, String>(5)?,
                    ))
                },
            )
            .optional()
            .map_err(|error| format!("Cannot read source security evidence: {error}"))?;
        factors.push(quality_factor(
            "security",
            "Security scan",
            20,
            security.map(
                |(scan_status, risk_level, scanned_files, high, medium, checked_at)| {
                    let score = match risk_level.as_str() {
                        "low" => 100,
                        "medium" => 60,
                        "high" => 0,
                        _ if scan_status == "clean" => 100,
                        _ if scan_status == "review" => 60,
                        _ if scan_status == "blocked" => 0,
                        _ => 50,
                    };
                    (
                        score,
                        format!(
                            "{scan_status}/{risk_level} · {scanned_files} file(s), {high} high, {medium} medium · {checked_at}"
                        ),
                    )
                },
            ),
            "Not scanned; excluded instead of being treated as safe.",
        ));

        let present: Vec<&SourceQualityFactorCard> = factors
            .iter()
            .filter(|factor| factor.score.is_some())
            .collect();
        let evidence_count = present.len() as u8;
        let total_weight: u32 = present.iter().map(|factor| factor.weight as u32).sum();
        let weighted_score: u32 = present
            .iter()
            .map(|factor| factor.score.unwrap_or(0) as u32 * factor.weight as u32)
            .sum();
        // One signal alone is context, not a defensible composite. Keep its
        // factor visible but do not publish a 0–100 headline until at least
        // two independent local evidence types exist.
        let score = (total_weight > 0 && evidence_count >= 2)
            .then(|| ((weighted_score as f64 / total_weight as f64).round() as u8).min(100));
        let status = match (score, evidence_count) {
            (None, _) | (_, 0..=1) => "insufficient",
            (Some(_), 2) => "limited",
            (Some(value), _) if value >= 85 => "excellent",
            (Some(value), _) if value >= 70 => "good",
            (Some(value), _) if value >= 50 => "mixed",
            _ => "weak",
        }
        .to_string();
        let summary = match score {
            Some(value) => format!(
                "{value}/100 from {evidence_count}/4 local evidence types; missing evidence is excluded."
            ),
            None => {
                "Not enough independent local quality evidence; no score was invented and missing evidence is excluded."
                    .to_string()
            }
        };
        cards.push(SourceQualitySignalCard {
            source_id: source.id.clone(),
            source_name: source.name.clone(),
            score,
            status,
            evidence_count,
            evidence_total: 4,
            summary,
            factors,
        });
    }
    Ok(cards)
}

pub(crate) fn set_pin(
    root: &Path,
    connection: &Connection,
    source_id: &str,
    pinned: bool,
) -> Result<(), String> {
    ensure_schema(connection)?;
    let source = read_source(connection, source_id)?;
    let folder = source_folder_name(&source.local_path, &source.name);
    let path = guarded_git_source_path(root, &source, &folder)?;
    let revision = git_revision(&path)?;
    let timestamp = super::unix_timestamp_string();
    if pinned {
        create_version_backup(connection, &source, &folder, &path, &revision, &timestamp)?;
    }
    connection
        .execute(
            "INSERT INTO source_governance (
                source_id, source_folder, pinned, pinned_revision, current_revision,
                status, message, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(source_id) DO UPDATE SET
                source_folder = excluded.source_folder,
                pinned = excluded.pinned,
                pinned_revision = excluded.pinned_revision,
                current_revision = excluded.current_revision,
                status = excluded.status,
                message = excluded.message,
                updated_at = excluded.updated_at",
            params![
                source.id,
                folder,
                if pinned { 1 } else { 0 },
                if pinned { revision.as_str() } else { "" },
                revision,
                if pinned { "pinned" } else { "ready" },
                if pinned {
                    "Sync will keep this exact revision."
                } else {
                    "Automatic source updates are enabled."
                },
                timestamp
            ],
        )
        .map_err(|error| format!("Cannot save source version pin: {error}"))?;
    write_pin_manifest(root, connection)?;
    write_governance_audit(
        connection,
        if pinned {
            "source_version_pinned"
        } else {
            "source_version_unpinned"
        },
        &source,
        serde_json::json!({
            "sourceId": source.id,
            "sourceName": source.name,
            "revision": revision,
            "pinned": pinned
        }),
    )
}

pub(crate) fn refresh_status(
    root: &Path,
    connection: &Connection,
    source_id: &str,
) -> Result<(), String> {
    ensure_schema(connection)?;
    let source = read_source(connection, source_id)?;
    let folder = source_folder_name(&source.local_path, &source.name);
    let path = guarded_git_source_path(root, &source, &folder)?;
    let current_revision = git_revision(&path)?;
    let timestamp = super::unix_timestamp_string();
    let fetch_result = run_git(
        &path,
        &["fetch", "--quiet", "--prune", "origin"],
        GIT_FETCH_TIMEOUT,
    );
    let remote = resolve_upstream_revision(&path);

    let (diff, diff_source, status, message) = match remote {
        Ok((remote_ref, remote_revision)) => {
            let mut diff = compute_diff_summary(&path, &remote_ref)?;
            diff.remote_revision = remote_revision;
            let fetch_ok = fetch_result.is_ok();
            let message = if fetch_ok {
                "Compared with the fetched upstream revision.".to_string()
            } else {
                format!(
                    "Network refresh failed; compared with cached remote refs: {}",
                    compact_error(fetch_result.err().unwrap_or_default())
                )
            };
            (
                diff,
                if fetch_ok { "live" } else { "cached" },
                if fetch_ok { "ready" } else { "cached" },
                message,
            )
        }
        Err(remote_error) => {
            let cached = read_cached_diff(connection, source_id)?;
            if let Some(diff) = cached {
                (
                    diff,
                    "cached",
                    "cached",
                    format!(
                        "Upstream is unavailable; showing the last cached comparison: {}",
                        compact_error(remote_error)
                    ),
                )
            } else {
                (
                    DiffSummary {
                        relation: "unknown".to_string(),
                        ..DiffSummary::default()
                    },
                    "none",
                    "unavailable",
                    format!(
                        "No upstream or cached comparison is available: {}",
                        compact_error(remote_error)
                    ),
                )
            }
        }
    };

    let pinned = connection
        .query_row(
            "SELECT pinned FROM source_governance WHERE source_id = ?1",
            params![source_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|error| format!("Cannot read source pin state: {error}"))?
        .unwrap_or(0)
        != 0;
    connection
        .execute(
            "INSERT INTO source_governance (
                source_id, source_folder, pinned, current_revision, remote_revision,
                relation, ahead_count, behind_count, changed_files, additions,
                deletions, remote_summary, last_checked_at, diff_source, status,
                message, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?13)
             ON CONFLICT(source_id) DO UPDATE SET
                source_folder = excluded.source_folder,
                current_revision = excluded.current_revision,
                remote_revision = excluded.remote_revision,
                relation = excluded.relation,
                ahead_count = excluded.ahead_count,
                behind_count = excluded.behind_count,
                changed_files = excluded.changed_files,
                additions = excluded.additions,
                deletions = excluded.deletions,
                remote_summary = excluded.remote_summary,
                last_checked_at = excluded.last_checked_at,
                diff_source = excluded.diff_source,
                status = CASE WHEN source_governance.pinned = 1 THEN 'pinned' ELSE excluded.status END,
                message = CASE WHEN source_governance.pinned = 1
                    THEN 'Sync will keep the pinned revision.'
                    ELSE excluded.message END,
                updated_at = excluded.updated_at",
            params![
                source.id,
                folder,
                if pinned { 1 } else { 0 },
                current_revision,
                diff.remote_revision,
                diff.relation,
                diff.ahead_count,
                diff.behind_count,
                diff.changed_files,
                diff.additions,
                diff.deletions,
                diff.remote_summary,
                timestamp,
                diff_source,
                status,
                message
            ],
        )
        .map_err(|error| format!("Cannot cache source revision comparison: {error}"))?;
    write_governance_audit(
        connection,
        "source_version_checked",
        &source,
        serde_json::json!({
            "sourceId": source.id,
            "currentRevision": current_revision,
            "remoteRevision": diff.remote_revision,
            "relation": diff.relation,
            "diffSource": diff_source
        }),
    )
}

pub(crate) fn prepare_sync_backups(root: &Path, connection: &Connection) -> Result<(), String> {
    ensure_schema(connection)?;
    write_pin_manifest(root, connection)?;
    let sources = read_sources(connection)?;
    let timestamp = super::unix_timestamp_string();
    for source in sources {
        let folder = source_folder_name(&source.local_path, &source.name);
        let Some(path) = resolve_source_path(root, &source.local_path, &folder) else {
            continue;
        };
        if !is_git_repository(&path) {
            continue;
        }
        let pinned = connection
            .query_row(
                "SELECT pinned FROM source_governance WHERE source_id = ?1",
                params![source.id],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map_err(|error| format!("Cannot read source pin before sync: {error}"))?
            .unwrap_or(0)
            != 0;
        let revision = git_revision(&path)?;
        if !pinned {
            create_version_backup(connection, &source, &folder, &path, &revision, &timestamp)?;
        }
        upsert_local_revision(
            connection,
            &source.id,
            &folder,
            &revision,
            if pinned { "pinned" } else { "ready" },
        )?;
    }
    Ok(())
}

pub(crate) fn refresh_local_revisions(root: &Path, connection: &Connection) -> Result<(), String> {
    ensure_schema(connection)?;
    for source in read_sources(connection)? {
        let folder = source_folder_name(&source.local_path, &source.name);
        let Some(path) = resolve_source_path(root, &source.local_path, &folder) else {
            continue;
        };
        if !is_git_repository(&path) {
            continue;
        }
        let revision = git_revision(&path)?;
        let pinned = connection
            .query_row(
                "SELECT pinned FROM source_governance WHERE source_id = ?1",
                params![source.id],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map_err(|error| format!("Cannot read source pin after sync: {error}"))?
            .unwrap_or(0)
            != 0;
        upsert_local_revision(
            connection,
            &source.id,
            &folder,
            &revision,
            if pinned { "pinned" } else { "ready" },
        )?;
    }
    Ok(())
}

pub(crate) fn rollback_latest(
    root: &Path,
    connection: &Connection,
    source_id: &str,
) -> Result<(), String> {
    ensure_schema(connection)?;
    let source = read_source(connection, source_id)?;
    let folder = source_folder_name(&source.local_path, &source.name);
    let source_path = guarded_git_source_path(root, &source, &folder)?;
    let current_revision = git_revision(&source_path)?;
    let target = latest_backup(connection, source_id, &current_revision)?.ok_or_else(|| {
        "No different verified source backup is available for rollback.".to_string()
    })?;

    let timestamp = super::unix_timestamp_string();
    let pre_rollback_backup_id = create_version_backup(
        connection,
        &source,
        &folder,
        &source_path,
        &current_revision,
        &timestamp,
    )?;
    let managed_root = super::managed_sources_dir(root);
    let staging_path = managed_root.join(format!(
        ".skillhub-rollback-staging-{}-{timestamp}",
        safe_name(&folder)
    ));
    if staging_path.exists() {
        return Err(
            "Rollback staging path already exists; no source file was changed.".to_string(),
        );
    }
    let source_parent = source_path
        .parent()
        .ok_or_else(|| "Cannot resolve the managed source parent folder.".to_string())?;
    let source_folder = source_path
        .file_name()
        .ok_or_else(|| "Cannot resolve the managed source folder name.".to_string())?;
    let mut clone = Command::new("git");
    clone
        .current_dir(source_parent)
        .args(["clone", "--no-hardlinks", "--quiet"])
        // Git for Windows can interpret canonical \\?\C:\... paths as an SSH
        // host. Cloning from the verified parent by relative folder avoids it.
        .arg(source_folder)
        .arg(&staging_path);
    run_command(
        &mut clone,
        GIT_FETCH_TIMEOUT,
        "Creating rollback staging clone timed out.",
    )?;
    let local_source = format!("../{}", source_folder.to_string_lossy().replace('\\', "/"));
    run_git(
        &staging_path,
        &[
            "fetch",
            "--quiet",
            "--no-tags",
            &local_source,
            "+refs/ai-skillhub/backups/*:refs/ai-skillhub/backups/*",
        ],
        GIT_TIMEOUT,
    )
    .map_err(|error| {
        let _ = fs::remove_dir_all(&staging_path);
        format!(
            "Cannot preserve verified backup refs in rollback staging; the live source was not changed: {error}"
        )
    })?;
    let checkout_result = run_git(
        &staging_path,
        &["checkout", "--detach", "--quiet", &target.revision],
        GIT_TIMEOUT,
    );
    if let Err(error) = checkout_result {
        let _ = fs::remove_dir_all(&staging_path);
        return Err(format!(
            "Cannot prepare the verified rollback revision; the live source was not changed: {error}"
        ));
    }
    let staged_revision = git_revision(&staging_path)?;
    if staged_revision != target.revision {
        let _ = fs::remove_dir_all(&staging_path);
        return Err(
            "Rollback staging verification failed; the live source was not changed.".to_string(),
        );
    }
    let current_skill_markers = count_skill_markers(&source_path);
    let staged_skill_markers = count_skill_markers(&staging_path);
    if source.source_type != "prompt" && current_skill_markers > 0 && staged_skill_markers == 0 {
        let _ = fs::remove_dir_all(&staging_path);
        return Err(
            "Rollback candidate contains no SKILL.md although the live source does; nothing changed."
                .to_string(),
        );
    }
    let identity_file = source_path.join(super::MANAGED_SOURCE_METADATA_FILE);
    if identity_file.is_file()
        && !staging_path
            .join(super::MANAGED_SOURCE_METADATA_FILE)
            .exists()
    {
        fs::copy(
            &identity_file,
            staging_path.join(super::MANAGED_SOURCE_METADATA_FILE),
        )
        .map_err(|error| format!("Cannot preserve source identity before rollback: {error}"))?;
    }

    let snapshot_path = rollback_snapshot_root(root)
        .join(safe_name(&folder))
        .join(format!("{timestamp}-before-rollback"));
    let snapshot_parent = snapshot_path
        .parent()
        .ok_or_else(|| "Cannot resolve rollback snapshot folder.".to_string())?;
    fs::create_dir_all(snapshot_parent)
        .map_err(|error| format!("Cannot create rollback snapshot folder: {error}"))?;
    if snapshot_path.exists() {
        let _ = fs::remove_dir_all(&staging_path);
        return Err("Rollback snapshot path already exists; nothing changed.".to_string());
    }

    fs::rename(&source_path, &snapshot_path).map_err(|error| {
        let _ = fs::remove_dir_all(&staging_path);
        format!("Cannot snapshot the live source before rollback; nothing changed: {error}")
    })?;
    if let Err(error) = fs::rename(&staging_path, &source_path) {
        let restore_error = fs::rename(&snapshot_path, &source_path).err();
        return Err(match restore_error {
            Some(restore_error) => format!(
                "Rollback placement failed and automatic restoration also failed. The complete source remains at {}. Placement error: {error}; restore error: {restore_error}",
                snapshot_path.display()
            ),
            None => format!(
                "Rollback placement failed; the original source was restored automatically: {error}"
            ),
        });
    }

    connection
        .execute(
            "UPDATE source_version_backups SET snapshot_path = ?1 WHERE id = ?2",
            params![snapshot_path.display().to_string(), pre_rollback_backup_id],
        )
        .map_err(|error| format!("Cannot record pre-rollback snapshot path: {error}"))?;
    connection
        .execute(
            "INSERT INTO source_governance (
                source_id, source_folder, pinned, pinned_revision, current_revision,
                relation, status, message, updated_at
             ) VALUES (?1, ?2, 1, ?3, ?3, 'rolled-back', 'pinned', ?4, ?5)
             ON CONFLICT(source_id) DO UPDATE SET
                source_folder = excluded.source_folder,
                pinned = 1,
                pinned_revision = excluded.pinned_revision,
                current_revision = excluded.current_revision,
                relation = excluded.relation,
                status = excluded.status,
                message = excluded.message,
                updated_at = excluded.updated_at",
            params![
                source.id,
                folder,
                target.revision,
                format!(
                    "Rolled back to {} and pinned. The complete pre-rollback tree is preserved.",
                    short_revision(&target.revision)
                ),
                timestamp
            ],
        )
        .map_err(|error| format!("Cannot record rollback result: {error}"))?;
    write_pin_manifest(root, connection)?;
    write_governance_audit(
        connection,
        "source_version_rolled_back",
        &source,
        serde_json::json!({
            "sourceId": source.id,
            "fromRevision": current_revision,
            "toRevision": target.revision,
            "targetBackupId": target.id,
            "preRollbackSnapshotPreserved": true
        }),
    )
}

pub(crate) fn record_security_scan(
    connection: &Connection,
    source_id: &str,
    scan_status: &str,
    scanned_files: usize,
    high_findings: usize,
    medium_findings: usize,
) -> Result<(), String> {
    ensure_schema(connection)?;
    let risk_level = if high_findings > 0 || scan_status == "blocked" {
        "high"
    } else if medium_findings > 0 || scan_status == "review" {
        "medium"
    } else if scan_status == "clean" || scan_status == "passed" {
        "low"
    } else {
        "unknown"
    };
    connection
        .execute(
            "INSERT INTO source_security_state (
                source_id, scan_status, risk_level, scanned_files,
                high_findings, medium_findings, checked_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(source_id) DO UPDATE SET
                scan_status = excluded.scan_status,
                risk_level = excluded.risk_level,
                scanned_files = excluded.scanned_files,
                high_findings = excluded.high_findings,
                medium_findings = excluded.medium_findings,
                checked_at = excluded.checked_at",
            params![
                source_id,
                scan_status,
                risk_level,
                scanned_files as i64,
                high_findings as i64,
                medium_findings as i64,
                super::unix_timestamp_string()
            ],
        )
        .map_err(|error| format!("Cannot persist source security evidence: {error}"))?;
    Ok(())
}

pub(crate) fn remove_source_state(
    root: &Path,
    connection: &Connection,
    source_id: &str,
) -> Result<(), String> {
    ensure_schema(connection)?;
    connection
        .execute(
            "DELETE FROM source_version_backups WHERE source_id = ?1",
            params![source_id],
        )
        .map_err(|error| format!("Cannot remove deleted source backup metadata: {error}"))?;
    connection
        .execute(
            "DELETE FROM source_security_state WHERE source_id = ?1",
            params![source_id],
        )
        .map_err(|error| format!("Cannot remove deleted source security metadata: {error}"))?;
    connection
        .execute(
            "DELETE FROM source_governance WHERE source_id = ?1",
            params![source_id],
        )
        .map_err(|error| format!("Cannot remove deleted source governance metadata: {error}"))?;
    // The recoverable full source directory is kept by the caller, but stale
    // pins must disappear immediately so a later source with the same folder
    // name is never governed by deleted state.
    write_pin_manifest(root, connection)
}

fn read_source(connection: &Connection, source_id: &str) -> Result<SourceRecord, String> {
    connection
        .query_row(
            "SELECT id, name, source_type, local_path FROM sources WHERE id = ?1",
            params![source_id],
            |row| {
                Ok(SourceRecord {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    source_type: row.get(2)?,
                    local_path: row.get(3)?,
                })
            },
        )
        .optional()
        .map_err(|error| format!("Cannot read source for version governance: {error}"))?
        .ok_or_else(|| "Source no longer exists in the managed index.".to_string())
}

fn read_sources(connection: &Connection) -> Result<Vec<SourceRecord>, String> {
    let mut statement = connection
        .prepare("SELECT id, name, source_type, local_path FROM sources ORDER BY lower(name)")
        .map_err(|error| format!("Cannot prepare source governance inventory: {error}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok(SourceRecord {
                id: row.get(0)?,
                name: row.get(1)?,
                source_type: row.get(2)?,
                local_path: row.get(3)?,
            })
        })
        .map_err(|error| format!("Cannot read source governance inventory: {error}"))?;
    let mut result = Vec::new();
    for row in rows {
        result.push(row.map_err(|error| format!("Cannot decode source inventory: {error}"))?);
    }
    Ok(result)
}

fn guarded_git_source_path(
    root: &Path,
    source: &SourceRecord,
    folder: &str,
) -> Result<PathBuf, String> {
    let path = resolve_source_path(root, &source.local_path, folder)
        .ok_or_else(|| "Managed source folder is missing.".to_string())?;
    if !is_git_repository(&path) {
        return Err(
            "This source has no local Git history. Pin/diff/rollback requires a verifiable commit."
                .to_string(),
        );
    }
    Ok(path)
}

fn resolve_source_path(root: &Path, stored_path: &str, folder: &str) -> Option<PathBuf> {
    let managed_root = super::managed_sources_dir(root);
    let managed_canonical = managed_root.canonicalize().ok()?;
    let stored = PathBuf::from(stored_path);
    let candidates = [stored, managed_root.join(folder)];
    for candidate in candidates {
        let canonical = candidate.canonicalize().ok()?;
        if canonical.starts_with(&managed_canonical) && canonical.is_dir() {
            return Some(canonical);
        }
    }
    None
}

fn source_folder_name(local_path: &str, fallback: &str) -> String {
    Path::new(local_path)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.trim().is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| super::sanitize_source_folder_name(fallback))
}

fn is_git_repository(path: &Path) -> bool {
    path.join(".git").exists()
}

fn git_revision(path: &Path) -> Result<String, String> {
    let revision = run_git(path, &["rev-parse", "--verify", "HEAD"], GIT_TIMEOUT)?;
    let revision = revision.trim().to_lowercase();
    if revision.len() != 40
        || !revision
            .chars()
            .all(|character| character.is_ascii_hexdigit())
    {
        return Err("Git HEAD did not resolve to a full verifiable commit.".to_string());
    }
    Ok(revision)
}

fn resolve_upstream_revision(path: &Path) -> Result<(String, String), String> {
    for reference in ["@{upstream}", "origin/HEAD", "origin/main", "origin/master"] {
        if let Ok(revision) = run_git(path, &["rev-parse", "--verify", reference], GIT_TIMEOUT) {
            let revision = revision.trim().to_lowercase();
            if revision.len() == 40
                && revision
                    .chars()
                    .all(|character| character.is_ascii_hexdigit())
            {
                return Ok((reference.to_string(), revision));
            }
        }
    }
    Err("No verifiable upstream branch is configured.".to_string())
}

fn compute_diff_summary(path: &Path, remote_ref: &str) -> Result<DiffSummary, String> {
    let counts = run_git(
        path,
        &[
            "rev-list",
            "--left-right",
            "--count",
            &format!("HEAD...{remote_ref}"),
        ],
        GIT_TIMEOUT,
    )?;
    let mut count_parts = counts.split_whitespace();
    let ahead_count = count_parts
        .next()
        .and_then(|value| value.parse::<u32>().ok())
        .unwrap_or(0);
    let behind_count = count_parts
        .next()
        .and_then(|value| value.parse::<u32>().ok())
        .unwrap_or(0);
    let relation = match (ahead_count, behind_count) {
        (0, 0) => "up-to-date",
        (0, _) => "update-available",
        (_, 0) => "local-ahead",
        _ => "diverged",
    }
    .to_string();

    let numstat = run_git(
        path,
        &["diff", "--numstat", &format!("HEAD..{remote_ref}")],
        GIT_TIMEOUT,
    )?;
    let mut changed_files = 0u32;
    let mut additions = 0u32;
    let mut deletions = 0u32;
    for line in numstat.lines().filter(|line| !line.trim().is_empty()) {
        let mut parts = line.split('\t');
        let added = parts.next().unwrap_or_default();
        let deleted = parts.next().unwrap_or_default();
        if parts.next().is_none() {
            continue;
        }
        changed_files = changed_files.saturating_add(1);
        additions = additions.saturating_add(added.parse::<u32>().unwrap_or(0));
        deletions = deletions.saturating_add(deleted.parse::<u32>().unwrap_or(0));
    }
    let remote_summary =
        run_git(path, &["log", "-1", "--format=%s", remote_ref], GIT_TIMEOUT).unwrap_or_default();
    Ok(DiffSummary {
        relation,
        ahead_count,
        behind_count,
        changed_files,
        additions,
        deletions,
        remote_summary: remote_summary.chars().take(240).collect(),
        ..DiffSummary::default()
    })
}

fn read_cached_diff(
    connection: &Connection,
    source_id: &str,
) -> Result<Option<DiffSummary>, String> {
    connection
        .query_row(
            "SELECT remote_revision, relation, ahead_count, behind_count,
                    changed_files, additions, deletions, remote_summary
             FROM source_governance
             WHERE source_id = ?1 AND remote_revision <> ''",
            params![source_id],
            |row| {
                Ok(DiffSummary {
                    remote_revision: row.get(0)?,
                    relation: row.get(1)?,
                    ahead_count: row.get::<_, i64>(2)?.max(0) as u32,
                    behind_count: row.get::<_, i64>(3)?.max(0) as u32,
                    changed_files: row.get::<_, i64>(4)?.max(0) as u32,
                    additions: row.get::<_, i64>(5)?.max(0) as u32,
                    deletions: row.get::<_, i64>(6)?.max(0) as u32,
                    remote_summary: row.get(7)?,
                })
            },
        )
        .optional()
        .map_err(|error| format!("Cannot read cached source comparison: {error}"))
}

fn run_git(path: &Path, args: &[&str], timeout: Duration) -> Result<String, String> {
    let mut command = Command::new("git");
    command.arg("-C").arg(path).args(args);
    let output = super::command_output_with_timeout(
        &mut command,
        timeout,
        "Git source governance command timed out.",
    )?;
    if !output.status.success() {
        let stderr = compact_error(String::from_utf8_lossy(&output.stderr));
        let stdout = compact_error(String::from_utf8_lossy(&output.stdout));
        let detail = if stderr.is_empty() { stdout } else { stderr };
        return Err(if detail.is_empty() {
            "Git source governance command failed without details.".to_string()
        } else {
            detail
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn run_command(
    command: &mut Command,
    timeout: Duration,
    timeout_message: &str,
) -> Result<(), String> {
    let output = super::command_output_with_timeout(command, timeout, timeout_message)?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = compact_error(String::from_utf8_lossy(&output.stderr));
    let stdout = compact_error(String::from_utf8_lossy(&output.stdout));
    Err(if stderr.is_empty() { stdout } else { stderr })
}

fn create_version_backup(
    connection: &Connection,
    source: &SourceRecord,
    folder: &str,
    path: &Path,
    revision: &str,
    timestamp: &str,
) -> Result<String, String> {
    let existing = connection
        .query_row(
            "SELECT id FROM source_version_backups
             WHERE source_id = ?1 AND revision = ?2 AND verified = 1
             ORDER BY created_at DESC LIMIT 1",
            params![source.id, revision],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("Cannot read existing source backup: {error}"))?;
    if let Some(existing) = existing {
        return Ok(existing);
    }
    let suffix = format!("{}-{}", timestamp, short_revision(revision));
    let backup_ref = format!("refs/ai-skillhub/backups/{suffix}");
    run_git(path, &["update-ref", &backup_ref, revision], GIT_TIMEOUT)?;
    run_git(
        path,
        &["cat-file", "-e", &format!("{revision}^{{commit}}")],
        GIT_TIMEOUT,
    )?;
    let id = format!(
        "source-backup-{}-{}",
        super::stable_id("source-backup", &source.id),
        timestamp
    );
    connection
        .execute(
            "INSERT INTO source_version_backups (
                id, source_id, source_name, source_folder, revision,
                backup_ref, snapshot_path, verified, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, '', 1, ?7)",
            params![
                id,
                source.id,
                source.name,
                folder,
                revision,
                backup_ref,
                timestamp
            ],
        )
        .map_err(|error| format!("Cannot record verified source backup: {error}"))?;
    Ok(id)
}

fn backup_summary(
    connection: &Connection,
    source_id: &str,
    current_revision: &str,
) -> Result<(u32, Option<BackupRecord>), String> {
    let count = connection
        .query_row(
            "SELECT COUNT(*) FROM source_version_backups
             WHERE source_id = ?1 AND verified = 1",
            params![source_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| format!("Cannot count source backups: {error}"))?
        .max(0) as u32;
    Ok((
        count,
        latest_backup(connection, source_id, current_revision)?,
    ))
}

fn latest_backup(
    connection: &Connection,
    source_id: &str,
    current_revision: &str,
) -> Result<Option<BackupRecord>, String> {
    connection
        .query_row(
            "SELECT id, revision, created_at
             FROM source_version_backups
             WHERE source_id = ?1
               AND verified = 1
               AND (?2 = '' OR revision <> ?2)
             ORDER BY created_at DESC, id DESC LIMIT 1",
            params![source_id, current_revision],
            |row| {
                Ok(BackupRecord {
                    id: row.get(0)?,
                    revision: row.get(1)?,
                    created_at: row.get(2)?,
                })
            },
        )
        .optional()
        .map_err(|error| format!("Cannot read latest verified source backup: {error}"))
}

fn upsert_local_revision(
    connection: &Connection,
    source_id: &str,
    folder: &str,
    revision: &str,
    status: &str,
) -> Result<(), String> {
    let timestamp = super::unix_timestamp_string();
    connection
        .execute(
            "INSERT INTO source_governance (
                source_id, source_folder, current_revision, status, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(source_id) DO UPDATE SET
                source_folder = excluded.source_folder,
                current_revision = excluded.current_revision,
                relation = CASE
                    WHEN source_governance.remote_revision = excluded.current_revision
                         AND source_governance.remote_revision <> '' THEN 'up-to-date'
                    ELSE 'unknown'
                END,
                ahead_count = 0,
                behind_count = 0,
                changed_files = 0,
                additions = 0,
                deletions = 0,
                diff_source = 'none',
                status = CASE WHEN source_governance.pinned = 1 THEN 'pinned' ELSE excluded.status END,
                updated_at = excluded.updated_at",
            params![source_id, folder, revision, status, timestamp],
        )
        .map_err(|error| format!("Cannot update local source revision: {error}"))?;
    Ok(())
}

fn write_pin_manifest(root: &Path, connection: &Connection) -> Result<(), String> {
    ensure_schema(connection)?;
    let mut statement = connection
        .prepare(
            "SELECT
                source_governance.source_id,
                COALESCE(sources.name, source_governance.source_id),
                source_governance.source_folder,
                source_governance.pinned_revision
             FROM source_governance
             LEFT JOIN sources ON sources.id = source_governance.source_id
             WHERE source_governance.pinned = 1
               AND source_governance.pinned_revision <> ''
             ORDER BY lower(source_governance.source_folder)",
        )
        .map_err(|error| format!("Cannot prepare source pin manifest: {error}"))?;
    let owned = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })
        .map_err(|error| format!("Cannot read source pins: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Cannot decode source pins: {error}"))?;
    let pins = owned
        .iter()
        .map(
            |(source_id, source_name, source_folder, pinned_revision)| PinManifestItem {
                source_id,
                source_name,
                source_folder,
                pinned_revision,
            },
        )
        .collect();
    let manifest = PinManifest {
        schema_version: GOVERNANCE_SCHEMA_VERSION,
        updated_at: super::unix_timestamp_string(),
        pins,
    };
    let body = serde_json::to_string_pretty(&manifest)
        .map_err(|error| format!("Cannot serialize source pin manifest: {error}"))?;
    let path = governance_manifest_path(root);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Cannot create source governance state folder: {error}"))?;
    }
    fs::write(&path, format!("{body}\n")).map_err(|error| {
        format!(
            "Cannot write source pin manifest {}: {error}",
            path.display()
        )
    })
}

fn governance_manifest_path(root: &Path) -> PathBuf {
    super::private_state_dir(root).join("source-governance.json")
}

fn rollback_snapshot_root(root: &Path) -> PathBuf {
    super::private_state_dir(root)
        .join("source-governance")
        .join("rollback-snapshots")
}

fn quality_factor(
    key: &str,
    label: &str,
    weight: u8,
    evidence: Option<(u8, String)>,
    missing_detail: &str,
) -> SourceQualityFactorCard {
    match evidence {
        Some((score, detail)) => SourceQualityFactorCard {
            key: key.to_string(),
            label: label.to_string(),
            status: "available".to_string(),
            score: Some(score.min(100)),
            weight,
            detail,
        },
        None => SourceQualityFactorCard {
            key: key.to_string(),
            label: label.to_string(),
            status: "missing".to_string(),
            score: None,
            weight,
            detail: missing_detail.to_string(),
        },
    }
}

fn write_governance_audit(
    connection: &Connection,
    event_type: &str,
    source: &SourceRecord,
    detail: serde_json::Value,
) -> Result<(), String> {
    connection
        .execute(
            "INSERT INTO audit_events (
                id, event_type, summary, detail_json, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                format!(
                    "audit-source-governance-{}-{}",
                    super::stable_id(event_type, &source.id),
                    super::unix_timestamp_string()
                ),
                event_type,
                format!("Source governance: {}", source.name),
                detail.to_string(),
                super::unix_timestamp_string()
            ],
        )
        .map_err(|error| format!("Cannot write source governance audit event: {error}"))?;
    Ok(())
}

fn count_skill_markers(root: &Path) -> usize {
    fn visit(path: &Path, count: &mut usize) {
        let Ok(entries) = fs::read_dir(path) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if path.is_dir() {
                if matches!(
                    name.to_ascii_lowercase().as_str(),
                    ".git" | "node_modules" | "target" | "dist"
                ) {
                    continue;
                }
                visit(&path, count);
            } else if name.eq_ignore_ascii_case("SKILL.md") {
                *count += 1;
            }
        }
    }
    let mut count = 0;
    visit(root, &mut count);
    count
}

fn short_revision(revision: &str) -> String {
    revision.chars().take(8).collect()
}

fn safe_name(value: &str) -> String {
    let value = super::sanitize_source_folder_name(value);
    if value.is_empty() {
        "source".to_string()
    } else {
        value
    }
}

fn compact_error(value: impl AsRef<str>) -> String {
    value
        .as_ref()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(360)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(path: &Path, args: &[&str]) {
        let status = Command::new("git")
            .arg("-C")
            .arg(path)
            .args(args)
            .status()
            .expect("git should start");
        assert!(status.success(), "git command should succeed: {args:?}");
    }

    fn init_repository(root: &Path) -> (PathBuf, String) {
        let sources = root.join("app-next").join("data").join("github_sources");
        let repo = sources.join("sample-source");
        fs::create_dir_all(&repo).expect("repo should be created");
        run(&repo, &["init", "--quiet"]);
        run(&repo, &["config", "user.name", "AI SkillHub Test"]);
        run(&repo, &["config", "user.email", "test@example.invalid"]);
        fs::create_dir_all(repo.join("skill-a")).expect("skill folder should exist");
        fs::write(
            repo.join("skill-a").join("SKILL.md"),
            "---\nname: skill-a\ndescription: test\n---\n",
        )
        .expect("skill should be written");
        run(&repo, &["add", "."]);
        run(&repo, &["commit", "--quiet", "-m", "first"]);
        let first = git_revision(&repo).expect("first revision should resolve");
        (repo, first)
    }

    fn insert_source(connection: &Connection, root: &Path) -> SourceRecord {
        let repo = root
            .join("app-next")
            .join("data")
            .join("github_sources")
            .join("sample-source");
        connection
            .execute_batch(include_str!("../migrations/001_initial.sql"))
            .expect("base schema should exist");
        ensure_schema(connection).expect("governance schema should exist");
        connection
            .execute(
                "INSERT INTO sources (
                    id, name, source_type, url, local_path, install_mode,
                    category_id, note, enabled, created_at, updated_at
                 ) VALUES ('source-sample', 'Sample Source', 'skill',
                    'https://github.com/example/sample.git', ?1, 'git',
                    'general', '', 1, '1', '1')",
                params![repo.display().to_string()],
            )
            .expect("source should insert");
        SourceRecord {
            id: "source-sample".to_string(),
            name: "Sample Source".to_string(),
            source_type: "skill".to_string(),
            local_path: repo.display().to_string(),
        }
    }

    #[test]
    fn pin_manifest_keeps_exact_current_revision() {
        let root = std::env::temp_dir().join(format!(
            "skillhub-source-pin-test-{}",
            super::super::unix_timestamp_string()
        ));
        let (_repo, revision) = init_repository(&root);
        let connection = Connection::open_in_memory().expect("database should open");
        insert_source(&connection, &root);

        set_pin(&root, &connection, "source-sample", true).expect("pin should succeed");
        let saved: (i64, String) = connection
            .query_row(
                "SELECT pinned, pinned_revision FROM source_governance WHERE source_id = 'source-sample'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("pin should read");
        assert_eq!(saved.0, 1);
        assert_eq!(saved.1, revision);
        let manifest =
            fs::read_to_string(governance_manifest_path(&root)).expect("pin manifest should exist");
        assert!(manifest.contains("\"sourceFolder\": \"sample-source\""));
        assert!(manifest.contains(&revision));
        remove_source_state(&root, &connection, "source-sample")
            .expect("deleted source governance should be removed");
        let cleared = fs::read_to_string(governance_manifest_path(&root))
            .expect("cleared pin manifest should exist");
        assert!(cleared.contains("\"pins\": []"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn rollback_preserves_complete_live_tree_and_pins_target() {
        let root = std::env::temp_dir().join(format!(
            "skillhub-source-rollback-test-{}",
            super::super::unix_timestamp_string()
        ));
        let (repo, first) = init_repository(&root);
        let connection = Connection::open_in_memory().expect("database should open");
        let source = insert_source(&connection, &root);
        let folder = "sample-source";
        create_version_backup(&connection, &source, folder, &repo, &first, "100")
            .expect("first revision should be backed up");

        fs::write(repo.join("skill-a").join("SKILL.md"), "second revision\n")
            .expect("second revision should be written");
        fs::write(repo.join("private-note.txt"), "preserve me")
            .expect("untracked note should be written");
        run(&repo, &["add", "skill-a/SKILL.md"]);
        run(&repo, &["commit", "--quiet", "-m", "second"]);
        let second = git_revision(&repo).expect("second revision should resolve");
        assert_ne!(first, second);

        rollback_latest(&root, &connection, "source-sample").expect("rollback should succeed");
        assert_eq!(git_revision(&repo).unwrap(), first);
        let state: (i64, String) = connection
            .query_row(
                "SELECT pinned, pinned_revision FROM source_governance WHERE source_id = 'source-sample'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(state, (1, first));
        let snapshot_path: String = connection
            .query_row(
                "SELECT snapshot_path FROM source_version_backups
                 WHERE source_id = 'source-sample' AND revision = ?1",
                params![second],
                |row| row.get(0),
            )
            .unwrap();
        assert!(Path::new(&snapshot_path).join("private-note.txt").is_file());
        let preserved_refs = run_git(
            &repo,
            &[
                "for-each-ref",
                "--format=%(refname)",
                "refs/ai-skillhub/backups",
            ],
            GIT_TIMEOUT,
        )
        .expect("verified backup refs should remain in the restored repository");
        assert!(preserved_refs.lines().count() >= 2);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn quality_signal_excludes_missing_rating_usage_and_security() {
        let connection = Connection::open_in_memory().expect("database should open");
        connection
            .execute_batch(include_str!("../migrations/001_initial.sql"))
            .expect("base schema should exist");
        ensure_schema(&connection).unwrap();
        connection
            .execute_batch(
                "INSERT INTO sources (
                    id, name, source_type, url, local_path, install_mode,
                    category_id, note, enabled, created_at, updated_at
                 ) VALUES (
                    'source-sample', 'Sample Source', 'skill', '', '', 'scan',
                    'general', '', 1, '1', '1'
                 );
                 INSERT INTO skills (
                    id, source_id, name, folder_name, description, category_id,
                    health_status, health_summary, enabled, relative_path,
                    created_at, updated_at
                 ) VALUES (
                    'skill-a', 'source-sample', 'Skill A', 'skill-a', '',
                    'general', 'ok', '', 1, 'skill-a', '1', '1'
                 );",
            )
            .expect("quality fixture should insert");
        let source = SourceCard {
            id: "source-sample".to_string(),
            name: "Sample Source".to_string(),
            source_type: "skill".to_string(),
            health: "ok".to_string(),
            url: String::new(),
            skill_count: 1,
            mode: "scan".to_string(),
            category_id: "general".to_string(),
            note: String::new(),
            local_path: String::new(),
            enabled: true,
            rating: 0,
            tags: Vec::new(),
            created_at: "1".to_string(),
            usage_guide: "Use it".to_string(),
            metadata_origin: "README+SKILL".to_string(),
            metadata_confidence: 0.8,
            user_folder_id: String::new(),
            user_folder_name: String::new(),
            user_folder_color: String::new(),
        };
        let card = read_quality_signals(&connection, &[source])
            .expect("quality should calculate")
            .remove(0);
        assert_eq!(card.evidence_count, 1);
        assert_eq!(card.status, "insufficient");
        assert_eq!(card.score, None);
        assert_eq!(
            card.factors
                .iter()
                .find(|factor| factor.key == "security")
                .unwrap()
                .score,
            None
        );
        assert!(card.summary.contains("missing evidence is excluded"));
    }
}
