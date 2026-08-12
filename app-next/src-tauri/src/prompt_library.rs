use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

const MAX_PROMPT_ASSET_BYTES: u64 = 256 * 1024;
const MAX_COMBINED_PROMPT_CHARS: usize = 96 * 1024;

#[derive(Clone)]
pub(crate) struct PromptSourceRecord {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) source_type: String,
    pub(crate) url: String,
    pub(crate) local_path: String,
}

#[derive(Clone)]
pub(crate) struct PromptHostStatus {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) detected: bool,
    pub(crate) managed: bool,
    pub(crate) enabled: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PromptInvocationCard {
    source_id: String,
    source_name: String,
    source_type: String,
    source_url: String,
    invocation_kind: String,
    invocation_name: String,
    copy_ready: bool,
    auto_delivered: bool,
    workspace_complete: bool,
    copy_text: String,
    assets: Vec<PromptAssetCard>,
    hosts: Vec<PromptHostCard>,
    warnings: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PromptAssetCard {
    name: String,
    relative_path: String,
    role: String,
    bytes: u64,
    included: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PromptHostCard {
    id: String,
    name: String,
    detected: bool,
    managed: bool,
    enabled: bool,
    auto_delivered: bool,
    delivery_status: String,
    invocation_steps: Vec<String>,
}

pub(crate) fn build_prompt_invocation(
    managed_sources_root: &Path,
    source: PromptSourceRecord,
    hosts: Vec<PromptHostStatus>,
) -> Result<PromptInvocationCard, String> {
    if !source.source_type.eq_ignore_ascii_case("prompt") {
        return Err("该来源不是 Prompt 资料；只有 Prompt 来源可生成复制调用内容。".to_string());
    }

    let canonical_source = managed_prompt_source_path(managed_sources_root, &source)?;

    let mut candidates = root_markdown_assets(&canonical_source)?;
    if candidates.is_empty() {
        return Err("该 Prompt 来源没有可读取的根目录 Markdown。".to_string());
    }
    candidates.sort_by(|left, right| {
        prompt_asset_priority(left)
            .cmp(&prompt_asset_priority(right))
            .then_with(|| {
                left.file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_lowercase()
                    .cmp(
                        &right
                            .file_name()
                            .unwrap_or_default()
                            .to_string_lossy()
                            .to_lowercase(),
                    )
            })
    });

    let mut assets = Vec::new();
    let mut included_sections = Vec::new();
    let mut combined_chars = 0usize;
    let mut warnings = vec![
        "Prompt 资料不会安装到 Skills 目录，也不会通过 /名称 或 @名称注册为 Skill。".to_string(),
    ];

    for path in candidates {
        let metadata = fs::symlink_metadata(&path)
            .map_err(|error| format!("无法读取 Prompt 文件信息：{}", error))?;
        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("prompt.md")
            .to_string();
        let role = prompt_asset_role(&name).to_string();
        let mut included = false;

        if metadata.file_type().is_symlink() {
            warnings.push(format!("已跳过符号链接 Markdown：{}", name));
        } else if metadata.len() > MAX_PROMPT_ASSET_BYTES {
            warnings.push(format!(
                "{} 超过 256 KB，只保留在来源库中，未加入复制内容。",
                name
            ));
        } else if matches!(role.as_str(), "instructions" | "context") {
            let raw = fs::read_to_string(&path)
                .map_err(|_| format!("{} 不是可安全读取的 UTF-8 Markdown。", name))?;
            let remaining = MAX_COMBINED_PROMPT_CHARS.saturating_sub(combined_chars);
            if remaining > 0 {
                let section = raw.chars().take(remaining).collect::<String>();
                combined_chars += section.chars().count();
                included_sections.push((name.clone(), role.clone(), section));
                included = true;
            }
        }

        assets.push(PromptAssetCard {
            name: name.clone(),
            relative_path: name,
            role,
            bytes: metadata.len(),
            included,
        });
    }

    if included_sections.is_empty() {
        return Err("该来源没有可加入调用内容的 program.md 或 README.md。".to_string());
    }
    if combined_chars >= MAX_COMBINED_PROMPT_CHARS {
        warnings.push("复制内容已按 96 KB 上限截断；原始文件仍保留在来源库中。".to_string());
    }

    let workspace_complete = has_non_markdown_project_file(&canonical_source)?;
    if !workspace_complete {
        warnings.push(
            "当前受管理副本只含 Markdown 资料；若 Prompt 引用了 train.py、prepare.py 等项目文件，请先打开该仓库的完整克隆再粘贴调用。"
                .to_string(),
        );
    }

    let copy_text = compose_copy_text(&source, &included_sections);
    let hosts = hosts
        .into_iter()
        .map(|host| prompt_host_card(host, workspace_complete))
        .collect();

    Ok(PromptInvocationCard {
        source_id: source.id,
        source_name: source.name,
        source_type: "prompt".to_string(),
        source_url: source.url,
        invocation_kind: "copy-paste".to_string(),
        invocation_name: String::new(),
        copy_ready: true,
        auto_delivered: false,
        workspace_complete,
        copy_text,
        assets,
        hosts,
        warnings,
    })
}

pub(crate) fn managed_prompt_source_path(
    managed_sources_root: &Path,
    source: &PromptSourceRecord,
) -> Result<PathBuf, String> {
    if !source.source_type.eq_ignore_ascii_case("prompt") {
        return Err("该来源不是 Prompt 资料；不能作为 Prompt 工作区打开。".to_string());
    }
    let canonical_sources_root = managed_sources_root
        .canonicalize()
        .map_err(|error| format!("无法读取受管理来源目录：{}", error))?;
    let source_path = PathBuf::from(source.local_path.trim());
    let canonical_source = source_path
        .canonicalize()
        .map_err(|error| format!("Prompt 来源目录不存在或不可读：{}", error))?;
    if canonical_source == canonical_sources_root
        || !canonical_source.starts_with(&canonical_sources_root)
    {
        return Err("Prompt 来源路径不在 AI SkillHub 受管理来源目录内，已拒绝读取。".to_string());
    }
    Ok(canonical_source)
}

fn root_markdown_assets(source_path: &Path) -> Result<Vec<PathBuf>, String> {
    let entries = fs::read_dir(source_path)
        .map_err(|error| format!("无法读取 Prompt 来源目录：{}", error))?;
    Ok(entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            let file_type = entry.file_type().ok()?;
            let is_markdown = path
                .extension()
                .and_then(|value| value.to_str())
                .map(|value| value.eq_ignore_ascii_case("md"))
                .unwrap_or(false);
            (file_type.is_file() && !file_type.is_symlink() && is_markdown).then_some(path)
        })
        .collect())
}

fn prompt_asset_priority(path: &Path) -> u8 {
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if name == "program.md" || name.starts_with("program.") {
        0
    } else if name == "readme.md" || name.starts_with("readme.") {
        1
    } else {
        2
    }
}

fn prompt_asset_role(name: &str) -> &'static str {
    let lowered = name.to_ascii_lowercase();
    if lowered == "program.md" || lowered.starts_with("program.") {
        "instructions"
    } else if lowered == "readme.md" || lowered.starts_with("readme.") {
        "context"
    } else {
        "reference"
    }
}

fn has_non_markdown_project_file(source_path: &Path) -> Result<bool, String> {
    let entries = fs::read_dir(source_path)
        .map_err(|error| format!("无法检查 Prompt 工作区完整性：{}", error))?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name == ".git" || name == ".skillhub-source.json" {
            continue;
        }
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_dir() {
            return Ok(true);
        }
        if file_type.is_file()
            && !entry
                .path()
                .extension()
                .and_then(|value| value.to_str())
                .map(|value| value.eq_ignore_ascii_case("md"))
                .unwrap_or(false)
        {
            return Ok(true);
        }
    }
    Ok(false)
}

fn compose_copy_text(source: &PromptSourceRecord, sections: &[(String, String, String)]) -> String {
    let mut output = format!(
        "以下是 AI SkillHub 管理的 Prompt 资料，不是已安装 Skill。请把它作为当前任务说明执行；如果内容引用项目文件，请先在包含这些文件的完整项目工作区中打开对话。\n\n来源：{}",
        source.name
    );
    if !source.url.trim().is_empty() {
        output.push_str(&format!("\n上游：{}", source.url.trim()));
    }
    for (name, role, content) in sections {
        let label = if role == "instructions" {
            "任务指令"
        } else {
            "背景资料"
        };
        output.push_str(&format!(
            "\n\n## {} · {}\n\n{}",
            label,
            name,
            content.trim()
        ));
    }
    output
}

fn prompt_host_card(host: PromptHostStatus, workspace_complete: bool) -> PromptHostCard {
    let ready = host.detected && host.enabled;
    let mut steps = vec![
        "打开普通对话输入框；不要输入 /Prompt名 或 @Prompt名。".to_string(),
        "复制 AI SkillHub 生成的完整调用内容并粘贴发送。".to_string(),
    ];
    if !workspace_complete {
        steps.insert(
            0,
            "先在宿主中打开该项目的完整仓库目录；受管理来源副本只保存了 Markdown。".to_string(),
        );
    }
    PromptHostCard {
        id: host.id,
        name: host.name,
        detected: host.detected,
        managed: host.managed,
        enabled: host.enabled,
        auto_delivered: false,
        delivery_status: if ready {
            "copy-paste-ready"
        } else {
            "host-not-ready"
        }
        .to_string(),
        invocation_steps: steps,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn fixture_root(label: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be valid")
            .as_nanos();
        std::env::temp_dir().join(format!("skillhub-prompt-{label}-{stamp}"))
    }

    fn prompt_record(local_path: &Path) -> PromptSourceRecord {
        PromptSourceRecord {
            id: "source-karpathy-autoresearch".to_string(),
            name: "karpathy--autoresearch".to_string(),
            source_type: "prompt".to_string(),
            url: "https://github.com/karpathy/autoresearch.git".to_string(),
            local_path: local_path.display().to_string(),
        }
    }

    #[test]
    fn prompt_payload_combines_program_then_readme_without_fake_invocation() {
        let root = fixture_root("compose");
        let sources = root.join("sources");
        let source = sources.join("karpathy--autoresearch");
        fs::create_dir_all(source.join(".git")).expect("fixture should create");
        fs::write(source.join("program.md"), "PROGRAM INSTRUCTIONS").expect("program should write");
        fs::write(source.join("README.md"), "README CONTEXT").expect("readme should write");
        fs::write(source.join("notes.md"), "NOT INCLUDED").expect("notes should write");

        let card = build_prompt_invocation(
            &sources,
            prompt_record(&source),
            vec![PromptHostStatus {
                id: "codex".to_string(),
                name: "ChatGPT Desktop / OpenAI Codex".to_string(),
                detected: true,
                managed: true,
                enabled: true,
            }],
        )
        .expect("prompt payload should build");

        assert!(card.copy_ready);
        assert!(!card.auto_delivered);
        assert!(card.invocation_name.is_empty());
        assert!(!card.workspace_complete);
        assert!(
            card.copy_text.find("PROGRAM INSTRUCTIONS").unwrap()
                < card.copy_text.find("README CONTEXT").unwrap()
        );
        assert!(!card.copy_text.contains("NOT INCLUDED"));
        assert_eq!(card.hosts[0].delivery_status, "copy-paste-ready");
        assert!(card
            .warnings
            .iter()
            .any(|warning| warning.contains("不是已安装 Skill") || warning.contains("不会安装")));

        fs::remove_dir_all(root).expect("fixture should clean");
    }

    #[test]
    fn prompt_payload_reports_complete_project_when_code_is_present() {
        let root = fixture_root("workspace");
        let sources = root.join("sources");
        let source = sources.join("karpathy--autoresearch");
        fs::create_dir_all(&source).expect("fixture should create");
        fs::write(source.join("program.md"), "RUN TRAINING").expect("program should write");
        fs::write(source.join("train.py"), "print('fixture')").expect("code should write");

        let card = build_prompt_invocation(&sources, prompt_record(&source), Vec::new())
            .expect("prompt payload should build");
        assert!(card.workspace_complete);
        assert!(!card
            .warnings
            .iter()
            .any(|warning| warning.contains("只含 Markdown")));

        fs::remove_dir_all(root).expect("fixture should clean");
    }

    #[test]
    fn prompt_payload_rejects_paths_outside_managed_sources() {
        let root = fixture_root("boundary");
        let sources = root.join("sources");
        let outside = root.join("outside");
        fs::create_dir_all(&sources).expect("sources should create");
        fs::create_dir_all(&outside).expect("outside should create");
        fs::write(outside.join("program.md"), "DO NOT READ").expect("program should write");

        let error = build_prompt_invocation(&sources, prompt_record(&outside), Vec::new())
            .err()
            .expect("outside path should be rejected");
        assert!(error.contains("不在 AI SkillHub 受管理来源目录内"));

        fs::remove_dir_all(root).expect("fixture should clean");
    }

    #[test]
    fn prompt_payload_refuses_skill_sources() {
        let root = fixture_root("type");
        let sources = root.join("sources");
        let source = sources.join("real-skill");
        fs::create_dir_all(&source).expect("fixture should create");
        fs::write(source.join("README.md"), "README").expect("readme should write");
        let mut record = prompt_record(&source);
        record.source_type = "skill".to_string();

        let error = build_prompt_invocation(&sources, record, Vec::new())
            .err()
            .expect("Skill source should be rejected");
        assert!(error.contains("不是 Prompt 资料"));

        fs::remove_dir_all(root).expect("fixture should clean");
    }
}
