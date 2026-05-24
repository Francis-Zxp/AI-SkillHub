use serde::Serialize;
use std::path::PathBuf;

#[derive(Serialize)]
struct LegacySnapshot {
    root: String,
    skills_dir: String,
    sources_dir: String,
    diagnostics_file: String,
    mode: String,
}

#[tauri::command]
fn scan_legacy_snapshot() -> Result<LegacySnapshot, String> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(PathBuf::from)
        .and_then(|path| path.parent().map(PathBuf::from))
        .ok_or_else(|| "Cannot resolve AI SkillHub root from app-next/src-tauri.".to_string())?;

    let skills_dir = root.join("skills");
    let sources_dir = root.join("app").join("github_sources");
    let diagnostics_file = root.join("app").join("reports").join("latest-diagnostics.json");

    Ok(LegacySnapshot {
        root: root.display().to_string(),
        skills_dir: skills_dir.display().to_string(),
        sources_dir: sources_dir.display().to_string(),
        diagnostics_file: diagnostics_file.display().to_string(),
        mode: "read-only".to_string(),
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![scan_legacy_snapshot])
        .run(tauri::generate_context!())
        .expect("failed to run AI SkillHub v2 app");
}
