use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

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
    diagnostics: DiagnosticSummary,
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
    let diagnostics_file = root.join("app").join("reports").join("latest-diagnostics.json");
    let config_file = root.join("app").join("skillhub.config.json");

    let diagnostics_json = read_json(&diagnostics_file);
    let config_json = read_json(&config_file);
    let diagnostic_skills = parse_diagnostic_skills(diagnostics_json.as_ref());
    let configured_sources = parse_configured_sources(config_json.as_ref());
    let mut sources = scan_sources(&sources_dir, &configured_sources);
    let mut skills = scan_skills(&skills_dir, &sources_dir, &diagnostic_skills, &configured_sources);
    let agents = parse_agents(diagnostics_json.as_ref());
    let diagnostics = parse_diagnostic_summary(diagnostics_json.as_ref());

    let mut source_counts: HashMap<String, usize> = HashMap::new();
    for skill in &skills {
        *source_counts.entry(skill.source.clone()).or_insert(0) += 1;
    }
    for source in &mut sources {
        source.skill_count = *source_counts.get(&source.name).unwrap_or(&0);
    }

    skills.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    sources.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

    let prompts = sources
        .iter()
        .filter(|source| source.source_type.eq_ignore_ascii_case("prompt"))
        .count();
    let warnings = skills
        .iter()
        .filter(|skill| skill.health != "ok")
        .count();
    let agents_detected = agents.iter().filter(|agent| agent.detected).count();

    Ok(LegacySnapshot {
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
        diagnostics,
    })
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
    serde_json::from_str(&raw).ok()
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

fn scan_sources(sources_dir: &Path, configured_sources: &HashMap<String, SourceConfig>) -> Vec<SourceCard> {
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
            .or_else(|| fs::read_link(entry.path()).ok().map(|path| path.display().to_string()))
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
    let normalized_sources = sources_dir.display().to_string().replace('/', "\\").to_lowercase();
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
        .invoke_handler(tauri::generate_handler![scan_legacy_snapshot])
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
        assert!(snapshot.diagnostics_file.ends_with("latest-diagnostics.json"));
    }
}
