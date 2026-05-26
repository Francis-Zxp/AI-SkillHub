use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::Value;
use std::collections::{hash_map::DefaultHasher, BTreeMap, HashMap};
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

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
    agent_adapters: Vec<AgentAdapterCard>,
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SkillCard {
    name: String,
    folder_name: String,
    category: String,
    description: String,
    source: String,
    health: String,
    enabled: bool,
    relative_path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SourceCard {
    name: String,
    source_type: String,
    health: String,
    url: String,
    skill_count: usize,
    mode: String,
    category_id: String,
    note: String,
    local_path: String,
}

#[derive(Serialize)]
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

#[tauri::command]
fn scan_legacy_snapshot() -> Result<LegacySnapshot, String> {
    let root = resolve_legacy_root()?;

    let skills_dir = root.join("skills");
    let sources_dir = root.join("app").join("github_sources");
    let diagnostics_file = root
        .join("app")
        .join("reports")
        .join("latest-diagnostics.json");
    let config_file = root.join("app").join("skillhub.config.json");

    let diagnostics_json = read_json(&diagnostics_file);
    let config_json = read_json(&config_file);
    let diagnostic_skills = parse_diagnostic_skills(diagnostics_json.as_ref());
    let configured_sources = parse_configured_sources(config_json.as_ref());
    let mut sources = scan_sources(&sources_dir, &configured_sources);
    let mut skills = scan_skills(
        &skills_dir,
        &sources_dir,
        &diagnostic_skills,
        &configured_sources,
    );
    let agents = parse_agents(diagnostics_json.as_ref());
    let agent_adapters = derive_agent_adapters(&agents);
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

    skills.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    sources.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

    let prompts = sources
        .iter()
        .filter(|source| source.source_type.eq_ignore_ascii_case("prompt"))
        .count();
    let warnings = skills.iter().filter(|skill| skill.health != "ok").count();
    let agents_detected = agents.iter().filter(|agent| agent.detected).count();

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
        agent_adapters,
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
        release_reports: derive_release_reports(&root),
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
    snapshot.backup_targets = derive_backup_targets(&root, &snapshot.agent_adapters);
    snapshot.backup_dry_run = derive_backup_dry_run(&snapshot.backup_targets);
    snapshot.restore_dry_run = derive_restore_dry_run(&snapshot.backup_targets);
    snapshot.index = persist_snapshot(&root, &snapshot)?;
    if let Ok(connection) = open_index_database(&root) {
        snapshot.snapshots = read_indexed_snapshots(&connection).unwrap_or_default();
        snapshot.backup_targets = read_indexed_backup_targets(&connection).unwrap_or_default();
        snapshot.backup_dry_run = read_indexed_backup_dry_run(&connection).unwrap_or_default();
        snapshot.restore_dry_run = read_indexed_restore_dry_run(&connection).unwrap_or_default();
        snapshot.rollback_plan = read_indexed_rollback_plan(&connection).unwrap_or_default();
    }
    Ok(snapshot)
}

#[tauri::command]
fn load_indexed_snapshot() -> Result<LegacySnapshot, String> {
    let root = resolve_legacy_root()?;
    let db_file = database_file(&root);

    if !db_file.exists() {
        return scan_legacy_snapshot();
    }

    let connection = open_index_database(&root)?;
    let snapshot =
        read_snapshot_from_database(&root, &connection).or_else(|_| scan_legacy_snapshot())?;

    if !snapshot.skills.is_empty()
        && (snapshot.workspaces.is_empty()
            || snapshot.presets.is_empty()
            || snapshot.agent_adapters.is_empty()
            || snapshot.adapter_capabilities.is_empty()
            || snapshot.project_scans.is_empty()
            || snapshot.backup_targets.is_empty()
            || snapshot.backup_dry_run.is_empty()
            || snapshot.restore_dry_run.is_empty()
            || snapshot.rollback_plan.is_empty())
    {
        return scan_legacy_snapshot();
    }

    Ok(snapshot)
}

#[tauri::command]
fn set_agent_adapter_enabled(id: String, enabled: bool) -> Result<LegacySnapshot, String> {
    set_enabled_state("agent_adapters", &id, enabled)?;
    load_indexed_snapshot()
}

#[tauri::command]
fn set_workspace_enabled(id: String, enabled: bool) -> Result<LegacySnapshot, String> {
    set_enabled_state("workspaces", &id, enabled)?;
    load_indexed_snapshot()
}

#[tauri::command]
fn set_preset_enabled(id: String, enabled: bool) -> Result<LegacySnapshot, String> {
    set_enabled_state("presets", &id, enabled)?;
    load_indexed_snapshot()
}

fn resolve_legacy_root() -> Result<PathBuf, String> {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(PathBuf::from)
        .and_then(|path| path.parent().map(PathBuf::from))
        .ok_or_else(|| "Cannot resolve AI SkillHub root from app-next/src-tauri.".to_string())
}

fn read_json(path: &Path) -> Option<Value> {
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str(raw.trim_start_matches('\u{feff}')).ok()
}

fn app_next_root(root: &Path) -> PathBuf {
    root.join("app-next")
}

fn database_file(root: &Path) -> PathBuf {
    app_next_root(root)
        .join(".skillhub-next")
        .join("skillhub-next.sqlite3")
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

    Ok(connection)
}

fn ensure_runtime_schema(connection: &Connection) -> Result<(), String> {
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
    let sources = read_indexed_sources(connection)?;
    let agents = read_indexed_agents(connection)?;
    let agent_adapters = read_indexed_agent_adapters(connection)?;
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
    let skills_dir = root.join("skills");
    let sources_dir = root.join("app").join("github_sources");
    let diagnostics_file = root
        .join("app")
        .join("reports")
        .join("latest-diagnostics.json");

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
        agent_adapters,
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
        release_reports: derive_release_reports(root),
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

fn persist_snapshot(root: &Path, snapshot: &LegacySnapshot) -> Result<IndexReport, String> {
    let db_file = database_file(root);
    let mut connection = open_index_database(root)?;
    let enabled_state = load_enabled_state(&connection);

    let indexed_at = unix_timestamp_string();
    let snapshot_id = format!("legacy-import-{}", indexed_at);
    let transaction = connection
        .transaction()
        .map_err(|error| format!("Cannot start v2 SQLite transaction: {}", error))?;

    transaction
        .execute("DELETE FROM skill_tags", [])
        .map_err(|error| format!("Cannot clear skill tag index: {}", error))?;
    transaction
        .execute("DELETE FROM preset_skills", [])
        .map_err(|error| format!("Cannot clear preset skill index: {}", error))?;
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
        let source_id = stable_id("source", &source.name);
        source_ids.insert(source.name.to_lowercase(), source_id.clone());
        transaction
            .execute(
                "INSERT INTO sources (
                    id, name, source_type, url, local_path, install_mode,
                    category_id, note, enabled, created_at, updated_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1, ?9, ?9)",
                params![
                    source_id,
                    source.name,
                    source.source_type,
                    source.url,
                    source.local_path,
                    source.mode,
                    source.category_id,
                    source.note,
                    indexed_at
                ],
            )
            .map_err(|error| format!("Cannot index source {}: {}", source.name, error))?;
    }

    let mut skill_ids_by_category: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut all_skill_ids: Vec<String> = Vec::new();
    for skill in &snapshot.skills {
        let skill_id = stable_id("skill", &skill.folder_name);
        let source_id = source_ids.get(&skill.source.to_lowercase()).cloned();
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
                    created_at, updated_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, '', ?8, ?9, ?10, ?10)",
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
                    indexed_at
                ],
            )
            .map_err(|error| format!("Cannot index skill {}: {}", skill.name, error))?;
    }

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

fn read_indexed_sources(connection: &Connection) -> Result<Vec<SourceCard>, String> {
    let mut statement = connection
        .prepare(
            "SELECT
                sources.name,
                sources.source_type,
                sources.url,
                sources.local_path,
                sources.install_mode,
                sources.category_id,
                sources.note,
                CASE
                    WHEN sources.source_type = 'prompt' THEN 'info'
                    WHEN COUNT(skills.id) > 0 THEN 'ok'
                    ELSE 'warn'
                END AS health_status,
                COUNT(skills.id) AS skill_count
            FROM sources
            LEFT JOIN skills ON skills.source_id = sources.id
            GROUP BY sources.id
            ORDER BY lower(sources.name)",
        )
        .map_err(|error| format!("Cannot prepare indexed source query: {}", error))?;

    let rows = statement
        .query_map([], |row| {
            Ok(SourceCard {
                name: row.get(0)?,
                source_type: row.get(1)?,
                url: row.get(2)?,
                local_path: row.get(3)?,
                mode: row.get(4)?,
                category_id: row.get(5)?,
                note: row.get(6)?,
                health: row.get(7)?,
                skill_count: row.get::<_, i64>(8)? as usize,
            })
        })
        .map_err(|error| format!("Cannot read indexed sources: {}", error))?;

    collect_rows(rows, "source")
}

fn read_indexed_skills(connection: &Connection) -> Result<Vec<SkillCard>, String> {
    let mut statement = connection
        .prepare(
            "SELECT
                skills.name,
                skills.folder_name,
                skills.category_id,
                skills.description,
                COALESCE(sources.name, 'local') AS source_name,
                skills.health_status,
                skills.enabled,
                skills.relative_path
            FROM skills
            LEFT JOIN sources ON sources.id = skills.source_id
            ORDER BY lower(skills.name)",
        )
        .map_err(|error| format!("Cannot prepare indexed skill query: {}", error))?;

    let rows = statement
        .query_map([], |row| {
            Ok(SkillCard {
                name: row.get(0)?,
                folder_name: row.get(1)?,
                category: row.get(2)?,
                description: row.get(3)?,
                source: row.get(4)?,
                health: row.get(5)?,
                enabled: row.get::<_, i64>(6)? != 0,
                relative_path: row.get(7)?,
            })
        })
        .map_err(|error| format!("Cannot read indexed skills: {}", error))?;

    collect_rows(rows, "skill")
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
            Ok(AgentCard {
                id: row.get(0)?,
                name: row.get(1)?,
                path: row.get(2)?,
                detected: row.get::<_, i64>(3)? != 0,
                managed: row.get::<_, i64>(4)? != 0,
                enabled: row.get::<_, i64>(5)? != 0,
                skill_count: 0,
            })
        })
        .map_err(|error| format!("Cannot read indexed agents: {}", error))?;

    collect_rows(rows, "agent")
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
                COUNT(preset_skills.skill_id)
            FROM presets
            LEFT JOIN preset_skills ON preset_skills.preset_id = presets.id
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
            })
        })
        .map_err(|error| format!("Cannot read indexed presets: {}", error))?;

    collect_rows(rows, "preset")
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

fn derive_adapter_safety_checks(adapters: &[AgentAdapterCard]) -> Vec<AdapterSafetyCheckCard> {
    let mut checks = Vec::new();

    for adapter in adapters {
        checks.push(adapter_safety_check(
            adapter,
            "detection",
            if adapter.detected { "ok" } else { "info" },
            if adapter.detected {
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
            let backup_path = root
                .join("app-next")
                .join(".skillhub-next")
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
            "Claude / Claude Code",
            "Anthropic",
            "~\\.claude\\skills",
            "global",
        ),
        agent_adapter(
            "codex",
            "OpenAI Codex",
            "OpenAI",
            "~\\.codex\\skills",
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
            name: "AI SkillHub v2 项目工作区".to_string(),
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
    }];

    for (index, (category, count)) in counts.into_iter().enumerate() {
        presets.push(PresetCard {
            id: stable_id("preset", &category),
            name: category.clone(),
            description: format!("自动从分类“{}”生成的 Preset。", category),
            color: preset_color(index).to_string(),
            enabled: true,
            skill_count: count,
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

fn derive_release_reports(root: &Path) -> Vec<ReleaseReportCard> {
    let reports_root = root.join("app").join("reports");
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
        if json_bool(&root, "ok") { "ok" } else { "error" },
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
                target: json_string(item, "target"),
                has_skill_md: json_bool(item, "hasSkillMd"),
                has_front_matter: json_bool(item, "hasFrontMatter"),
            },
        );
    }
    result
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
            let config = configured_sources.get(&folder_name.to_lowercase());
            let source_type = config
                .map(|item| item.source_type.clone())
                .unwrap_or_else(|| infer_source_type(&entry.path()));

            sources.push(SourceCard {
                name: config
                    .map(|item| item.name.clone())
                    .unwrap_or(folder_name.clone()),
                source_type,
                health: source_health(&entry.path(), config),
                url: config.map(|item| item.url.clone()).unwrap_or_default(),
                skill_count: 0,
                mode: config
                    .map(|item| item.mode.clone())
                    .filter(|value| !value.is_empty())
                    .unwrap_or_else(|| "scan".to_string()),
                category_id: config
                    .map(|item| item.category_id.clone())
                    .filter(|value| !value.is_empty())
                    .unwrap_or_else(|| "auto".to_string()),
                note: config.map(|item| item.note.clone()).unwrap_or_default(),
                local_path: entry.path().display().to_string(),
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
        let source = infer_source_name(&target, sources_dir).unwrap_or_else(|| "local".to_string());
        let category = configured_sources
            .get(&source.to_lowercase())
            .map(|source| source.category_id.clone())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "auto".to_string());
        let description = diagnostic
            .map(|item| item.description.clone())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| read_skill_description(&entry.path()));

        skills.push(SkillCard {
            name: diagnostic
                .map(|item| item.name.clone())
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| folder_name.clone()),
            folder_name: folder_name.clone(),
            category,
            description,
            source,
            health: skill_health(&entry.path(), diagnostic),
            enabled: true,
            relative_path: format!("skills\\{}", folder_name),
        });
    }

    skills
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
            let skills_dirs = agent
                .get("skillsDirs")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let managed = skills_dirs
                .iter()
                .any(|dir| json_bool(dir, "isLink") || json_bool(dir, "writable"));
            AgentCard {
                id: json_string(agent, "id"),
                name: json_string(agent, "name"),
                path: skills_dirs
                    .first()
                    .map(|dir| json_string(dir, "path"))
                    .unwrap_or_default(),
                detected: json_bool(agent, "detected"),
                managed,
                enabled: json_bool(agent, "detected") && managed,
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

fn skill_health(path: &Path, diagnostic: Option<&SkillDiagnostic>) -> String {
    if let Some(item) = diagnostic {
        if item.has_skill_md && item.has_front_matter && !item.description.is_empty() {
            return "ok".to_string();
        }
        if item.has_skill_md {
            return "info".to_string();
        }
        return "warn".to_string();
    }

    if path.join("SKILL.md").exists() {
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

fn normalize_source_type(value: &str) -> String {
    match value.to_lowercase().as_str() {
        "skills" | "skill" => "skill".to_string(),
        "prompt" | "prompts" => "prompt".to_string(),
        "mixed" => "mixed".to_string(),
        _ => "skill".to_string(),
    }
}

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
        .invoke_handler(tauri::generate_handler![
            load_indexed_snapshot,
            scan_legacy_snapshot,
            set_agent_adapter_enabled,
            set_workspace_enabled,
            set_preset_enabled
        ])
        .run(tauri::generate_context!())
        .expect("failed to run AI SkillHub v2 app");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scan_legacy_snapshot_is_read_only_and_resolves_root() {
        let snapshot = scan_legacy_snapshot().expect("legacy snapshot should scan");

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
        scan_legacy_snapshot().expect("legacy snapshot should seed sqlite");
        let snapshot = load_indexed_snapshot().expect("indexed snapshot should load");

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
        let root = resolve_legacy_root().expect("legacy root should resolve");
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
        let snapshot = scan_legacy_snapshot().expect("legacy snapshot should scan");
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
            "~\\.codex\\skills",
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
            "~\\.codex\\skills",
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
            "~\\.codex\\skills",
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
    fn release_reports_parse_v1_preflight_inputs_without_paths() {
        let root = std::env::temp_dir().join(format!(
            "skillhub-release-report-test-{}",
            unix_timestamp_string()
        ));
        let reports = root.join("app").join("reports");
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
}
