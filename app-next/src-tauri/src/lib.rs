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
    workspaces: Vec<WorkspaceCard>,
    presets: Vec<PresetCard>,
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceCard {
    id: String,
    name: String,
    scope: String,
    path: String,
    agent_count: usize,
    skill_count: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PresetCard {
    id: String,
    name: String,
    description: String,
    color: String,
    skill_count: usize,
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
        workspaces: Vec::new(),
        presets: Vec::new(),
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
    snapshot.presets = derive_presets(&snapshot.skills);
    snapshot.index = persist_snapshot(&root, &snapshot)?;
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
            || snapshot.agent_adapters.is_empty())
    {
        return scan_legacy_snapshot();
    }

    Ok(snapshot)
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

    Ok(connection)
}

fn read_snapshot_from_database(
    root: &Path,
    connection: &Connection,
) -> Result<LegacySnapshot, String> {
    let skills = read_indexed_skills(connection)?;
    let sources = read_indexed_sources(connection)?;
    let agents = read_indexed_agents(connection)?;
    let agent_adapters = read_indexed_agent_adapters(connection)?;
    let workspaces = read_indexed_workspaces(connection)?;
    let presets = read_indexed_presets(connection)?;
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
        workspaces,
        presets,
        diagnostics,
        index,
    })
}

fn persist_snapshot(root: &Path, snapshot: &LegacySnapshot) -> Result<IndexReport, String> {
    let db_file = database_file(root);
    let mut connection = open_index_database(root)?;

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
                    if agent.detected { 1 } else { 0 },
                    indexed_at
                ],
            )
            .map_err(|error| format!("Cannot index agent {}: {}", agent.name, error))?;
    }

    seed_agent_adapters(&transaction, &snapshot.agent_adapters, &indexed_at)?;
    seed_workspaces(
        &transaction,
        root,
        &snapshot.agents,
        snapshot.skills.len(),
        &indexed_at,
    )?;
    seed_presets(
        &transaction,
        &all_skill_ids,
        &skill_ids_by_category,
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
            "SELECT id, name, skills_path, detected, managed
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
                agent_count: row.get::<_, i64>(4)? as usize,
                skill_count: if scope == "global" { total_skills } else { 0 },
            })
        })
        .map_err(|error| format!("Cannot read indexed workspaces: {}", error))?;

    collect_rows(rows, "workspace")
}

fn read_indexed_presets(connection: &Connection) -> Result<Vec<PresetCard>, String> {
    let mut statement = connection
        .prepare(
            "SELECT
                presets.id,
                presets.name,
                presets.description,
                presets.color,
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
                skill_count: row.get::<_, i64>(4)? as usize,
            })
        })
        .map_err(|error| format!("Cannot read indexed presets: {}", error))?;

    collect_rows(rows, "preset")
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

fn seed_agent_adapters(
    transaction: &rusqlite::Transaction<'_>,
    adapters: &[AgentAdapterCard],
    timestamp: &str,
) -> Result<(), String> {
    for adapter in adapters {
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
                    if adapter.enabled { 1 } else { 0 },
                    timestamp
                ],
            )
            .map_err(|error| format!("Cannot seed agent adapter {}: {}", adapter.name, error))?;
    }

    Ok(())
}

fn seed_workspaces(
    transaction: &rusqlite::Transaction<'_>,
    root: &Path,
    agents: &[AgentCard],
    total_skills: usize,
    timestamp: &str,
) -> Result<(), String> {
    let workspaces = derive_workspaces(root, agents, total_skills);

    for workspace in &workspaces {
        transaction
            .execute(
                "INSERT INTO workspaces (
                    id, name, scope, path, created_at, updated_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
                params![
                    workspace.id,
                    workspace.name,
                    workspace.scope,
                    workspace.path,
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

fn seed_presets(
    transaction: &rusqlite::Transaction<'_>,
    all_skill_ids: &[String],
    skill_ids_by_category: &BTreeMap<String, Vec<String>>,
    timestamp: &str,
) -> Result<(), String> {
    insert_preset(
        transaction,
        "preset-all",
        "全部技能",
        "中央技能库中的全部已索引 Skill。",
        "mint",
        all_skill_ids,
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
    timestamp: &str,
) -> Result<(), String> {
    transaction
        .execute(
            "INSERT INTO presets (
                id, name, description, color, created_at, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
            params![preset_id, name, description, color, timestamp],
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
        agent_count: agents.iter().filter(|agent| agent.detected).count(),
        skill_count: total_skills,
    }];

    for agent in agents.iter().filter(|agent| agent.detected) {
        workspaces.push(WorkspaceCard {
            id: stable_id("workspace-agent", &agent.id),
            name: format!("{} 工作区", agent.name),
            scope: "agent".to_string(),
            path: agent.path.clone(),
            agent_count: 1,
            skill_count: if agent.managed { total_skills } else { 0 },
        });
    }

    workspaces
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
        skill_count: skills.len(),
    }];

    for (index, (category, count)) in counts.into_iter().enumerate() {
        presets.push(PresetCard {
            id: stable_id("preset", &category),
            name: category.clone(),
            description: format!("自动从分类“{}”生成的 Preset。", category),
            color: preset_color(index).to_string(),
            skill_count: count,
        });
    }

    presets
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
        .map(|duration| duration.as_millis().to_string())
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
            scan_legacy_snapshot
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
}
