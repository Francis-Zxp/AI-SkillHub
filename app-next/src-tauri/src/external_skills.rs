//! Read-only inventory of Skills already present in other clients.
//! Presence is directory evidence, not a claim that a client is installed.
use serde::Serialize;
use std::collections::HashSet;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

const MAX_ENTRIES: usize = 12_000;
const MAX_DEPTH: usize = 8;
const MAX_DOCUMENT_BYTES: u64 = 256 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExternalAgentSkillInventory {
    generated_at: String,
    roots: Vec<ExternalSkillRoot>,
    skills: Vec<ExternalAgentSkill>,
    warnings: Vec<String>,
    truncated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExternalSkillRoot {
    agent_id: String,
    agent_name: String,
    scope: String,
    path: String,
    status: String,
    skill_count: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExternalAgentSkill {
    id: String,
    name: String,
    description: String,
    path: String,
    canonical_path: String,
    agent_id: String,
    agent_name: String,
    scope: String,
    storage_kind: String,
    managed: bool,
    can_import: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExternalSkillDocument {
    path: String,
    content: String,
}

#[derive(Debug)]
struct ScanRoot {
    agent_id: String,
    agent_name: String,
    scope: String,
    path: PathBuf,
}

fn root(agent_id: &str, agent_name: &str, scope: &str, path: PathBuf) -> ScanRoot {
    ScanRoot {
        agent_id: agent_id.into(),
        agent_name: agent_name.into(),
        scope: scope.into(),
        path,
    }
}

fn roots(home: &Path, project: Option<&Path>) -> Result<Vec<ScanRoot>, String> {
    if !home.is_absolute() || !home.is_dir() {
        return Err("无法确定当前用户目录，已停止外部 Skill 扫描。".into());
    }
    let mut result = Vec::new();
    for adapter in crate::agent_adapter_catalog() {
        if let Some(relative) = adapter.skills_path_hint.strip_prefix("~\\") {
            // Path components must also work in the Unix test harness.
            let path = relative
                .split('\\')
                .fold(home.to_path_buf(), |base, part| base.join(part));
            result.push(root(&adapter.id, &adapter.name, "global", path));
        }
    }
    result.push(root(
        "codex-legacy",
        "Codex（兼容目录）",
        "global",
        home.join(".codex/skills"),
    ));
    if let Some(codex_home) = std::env::var_os("CODEX_HOME").map(PathBuf::from) {
        if codex_home.is_absolute() && codex_home != home.join(".codex") {
            result.push(root(
                "codex-custom",
                "Codex（自定义目录）",
                "global",
                codex_home.join("skills"),
            ));
        }
    }
    if let Some(project) = project {
        if !project.is_absolute() || !project.is_dir() {
            return Err("项目路径必须是已存在的绝对文件夹路径。".into());
        }
        let project = project.canonicalize().map_err(|_| "无法读取项目目录。")?;
        // Only known project Skill roots, never recursively walk the user's project.
        for (id, name, relative) in [
            ("agents", "共享 Agent Skills", ".agents/skills"),
            ("claude", "Claude Code", ".claude/skills"),
            ("cursor", "Cursor", ".cursor/skills"),
            ("github-copilot", "GitHub Copilot", ".github/skills"),
            ("gemini-cli", "Gemini CLI", ".gemini/skills"),
            ("opencode", "OpenCode", ".opencode/skills"),
            ("windsurf", "Windsurf", ".windsurf/skills"),
        ] {
            let candidate = project.join(relative);
            if let Ok(canonical) = candidate.canonicalize() {
                if !canonical.starts_with(&project) {
                    return Err(format!(
                        "项目 Skills 根目录指向项目范围外，已停止扫描：{relative}"
                    ));
                }
            }
            result.push(root(id, name, "project", candidate));
        }
    }
    Ok(result)
}

pub(crate) fn scan(
    app_root: &Path,
    home: &Path,
    project: Option<&Path>,
) -> Result<ExternalAgentSkillInventory, String> {
    let managed = [
        crate::user_data_root(app_root),
        crate::active_skills_dir(app_root),
        crate::managed_sources_dir(app_root),
    ]
    .into_iter()
    .filter_map(|path| path.canonicalize().ok())
    .collect::<Vec<_>>();
    Ok(scan_roots(roots(home, project)?, &managed))
}

fn scan_roots(roots: Vec<ScanRoot>, managed_roots: &[PathBuf]) -> ExternalAgentSkillInventory {
    let mut result = ExternalAgentSkillInventory {
        generated_at: crate::unix_timestamp_string(),
        roots: Vec::new(),
        skills: Vec::new(),
        warnings: Vec::new(),
        truncated: false,
    };
    let mut entries_seen = 0;
    for root in roots {
        let count_before = result.skills.len();
        let mut status = "missing";
        if root.path.is_dir() {
            status = "scanned";
            let mut stack = vec![(root.path.clone(), 0)];
            let mut visited = HashSet::new();
            while let Some((path, depth)) = stack.pop() {
                if entries_seen >= MAX_ENTRIES {
                    result.truncated = true;
                    status = "partial";
                    break;
                }
                let canonical = match path.canonicalize() {
                    Ok(path) => path,
                    Err(_) => {
                        result
                            .warnings
                            .push(format!("无法读取目录：{}", path.display()));
                        status = "partial";
                        continue;
                    }
                };
                if !visited.insert(canonical.clone()) {
                    continue;
                }
                let manifest = canonical.join("SKILL.md");
                if manifest.exists() {
                    match read_document(&canonical) {
                        Ok(content) => {
                            let folder_name =
                                path.file_name().unwrap_or_default().to_string_lossy();
                            let name = frontmatter_value(&content, "name")
                                .filter(|v| !v.is_empty())
                                .unwrap_or_else(|| folder_name.into_owned());
                            let description =
                                frontmatter_value(&content, "description").unwrap_or_default();
                            let managed =
                                managed_roots.iter().any(|base| canonical.starts_with(base));
                            let linked =
                                is_link(&path) || path.ancestors().take(depth + 1).any(is_link);
                            result.skills.push(ExternalAgentSkill {
                                id: crate::stable_id(
                                    "external-skill",
                                    &format!("{}:{}:{}", root.agent_id, root.scope, path.display()),
                                ),
                                name,
                                description,
                                path: display_path(&path),
                                canonical_path: display_path(&canonical),
                                agent_id: root.agent_id.clone(),
                                agent_name: root.agent_name.clone(),
                                scope: root.scope.clone(),
                                storage_kind: if linked { "link" } else { "directory" }.into(),
                                managed,
                                can_import: !managed,
                            });
                        }
                        Err(error) => {
                            result.warnings.push(format!("{}：{error}", path.display()));
                            status = "partial";
                        }
                    }
                    // A Skill is a self-contained unit; do not expose its fixtures as independent Skills.
                    continue;
                }
                if depth >= MAX_DEPTH {
                    result.truncated = true;
                    status = "partial";
                    continue;
                }
                // Follow direct Skill links, but never walk an arbitrary linked collection.
                if depth > 0 && is_link(&path) {
                    continue;
                }
                let entries = match fs::read_dir(&path) {
                    Ok(entries) => entries,
                    Err(_) => {
                        result
                            .warnings
                            .push(format!("目录无读取权限或已被移动：{}", path.display()));
                        status = "partial";
                        continue;
                    }
                };
                for entry in entries {
                    entries_seen += 1;
                    if entries_seen >= MAX_ENTRIES {
                        result.truncated = true;
                        status = "partial";
                        break;
                    }
                    let entry = match entry {
                        Ok(entry) => entry,
                        Err(_) => {
                            status = "partial";
                            continue;
                        }
                    };
                    let name = entry.file_name();
                    let name = name.to_string_lossy();
                    if matches!(
                        name.as_ref(),
                        ".git" | "node_modules" | "target" | "cache" | "__pycache__"
                    ) {
                        continue;
                    }
                    if entry.path().is_dir() {
                        stack.push((entry.path(), depth + 1));
                    }
                }
            }
        } else if fs::symlink_metadata(&root.path).is_ok() {
            status = "unreadable";
            result.warnings.push(format!(
                "Skills 路径不是可读文件夹，或链接已失效：{}",
                root.path.display()
            ));
        }
        result.roots.push(ExternalSkillRoot {
            agent_id: root.agent_id,
            agent_name: root.agent_name,
            scope: root.scope,
            path: display_path(&root.path),
            status: status.into(),
            skill_count: result.skills.len() - count_before,
        });
    }
    result.skills.sort_by(|a, b| {
        (&a.agent_name, &a.scope, &a.name, &a.path).cmp(&(
            &b.agent_name,
            &b.scope,
            &b.name,
            &b.path,
        ))
    });
    result.warnings.truncate(100);
    result
}

fn display_path(path: &Path) -> String {
    let value = path.to_string_lossy();
    if let Some(unc) = value.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{unc}")
    } else {
        value.strip_prefix(r"\\?\").unwrap_or(&value).to_string()
    }
}

pub(crate) fn is_link(path: &Path) -> bool {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return false;
    };
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

fn read_document(directory: &Path) -> Result<String, String> {
    let canonical_dir = directory
        .canonicalize()
        .map_err(|_| "Skill 文件夹已不可读。")?;
    let path = canonical_dir.join("SKILL.md");
    if is_link(&path) {
        return Err("SKILL.md 是文件链接，已跳过以防读取目录外内容。".into());
    }
    let metadata = fs::symlink_metadata(&path).map_err(|_| "SKILL.md 不可读。")?;
    if !metadata.is_file() || metadata.len() > MAX_DOCUMENT_BYTES {
        return Err("SKILL.md 不是普通文件或超过 256 KiB 预览上限。".into());
    }
    let file = fs::File::open(&path).map_err(|_| "SKILL.md 无读取权限。")?;
    let mut bytes = Vec::new();
    file.take(MAX_DOCUMENT_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "读取 SKILL.md 失败。")?;
    if bytes.len() as u64 > MAX_DOCUMENT_BYTES {
        return Err("SKILL.md 超过预览上限。".into());
    }
    String::from_utf8(bytes).map_err(|_| "SKILL.md 不是 UTF-8 文本，未进行自动转码。".into())
}

fn frontmatter_value(content: &str, key: &str) -> Option<String> {
    let mut lines = content.trim_start_matches('\u{feff}').lines();
    if lines.next()?.trim() != "---" {
        return None;
    }
    let frontmatter = lines
        .take_while(|line| line.trim() != "---")
        .take(128)
        .collect::<Vec<_>>();
    let (index, value) = frontmatter.iter().enumerate().find_map(|(index, line)| {
        let (candidate, value) = line.split_once(':')?;
        (candidate == key).then_some((index, value.trim()))
    })?;
    let value = if matches!(value, ">" | ">-" | ">+" | "|" | "|-" | "|+") {
        frontmatter[index + 1..]
            .iter()
            .take_while(|line| line.starts_with(char::is_whitespace))
            .map(|line| line.trim())
            .collect::<Vec<_>>()
            .join(" ")
    } else {
        value.trim_matches(&['\'', '"'][..]).into()
    };
    Some(
        value
            .chars()
            .take(if key == "name" { 160 } else { 500 })
            .collect(),
    )
}

pub(crate) fn read(
    app_root: &Path,
    home: &Path,
    project: Option<&Path>,
    path: &Path,
) -> Result<ExternalSkillDocument, String> {
    if !path.is_absolute() {
        return Err("请选择扫描结果中的 Skill。".into());
    }
    let canonical = path
        .canonicalize()
        .map_err(|_| "Skill 已移动，请重新扫描。")?;
    let inventory = scan(app_root, home, project)?;
    if !inventory.skills.iter().any(|skill| {
        Path::new(&skill.canonical_path)
            .canonicalize()
            .ok()
            .as_ref()
            == Some(&canonical)
    }) {
        return Err("该路径不在当前外部 Skills 扫描结果中。".into());
    }
    Ok(ExternalSkillDocument {
        path: display_path(&canonical.join("SKILL.md")),
        content: read_document(&canonical)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("skillhub-external-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
        fn skill(&self, relative: &str) -> PathBuf {
            let path = self.0.join(relative);
            fs::create_dir_all(&path).unwrap();
            fs::write(path.join("SKILL.md"), "---\nname: paper-review\ndescription: >-\n  Review research\n  carefully.\n---\nBody").unwrap();
            path
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    #[test]
    fn finds_nested_external_skills_without_writing_or_counting_fixtures() {
        let fixture = Fixture::new();
        let directory = fixture.skill("home/.claude/skills/science/review");
        fixture.skill("home/.claude/skills/science/review/fixtures/example");
        let scan_root = fixture.0.join("home/.claude/skills");
        let report = scan_roots(vec![root("claude", "Claude", "global", scan_root)], &[]);
        assert_eq!(report.skills.len(), 1);
        assert_eq!(report.skills[0].name, "paper-review");
        assert_eq!(report.skills[0].description, "Review research carefully.");
        assert_eq!(report.skills[0].storage_kind, "directory");
        assert!(report.skills[0].can_import);
        assert_eq!(
            Path::new(&report.skills[0].canonical_path)
                .canonicalize()
                .unwrap(),
            directory.canonicalize().unwrap()
        );
        assert!(!fixture.0.join("home/.cursor").exists());
    }

    #[test]
    fn shared_roots_keep_each_client_visible_and_mark_managed() {
        let fixture = Fixture::new();
        fixture.skill("shared/review");
        let shared = fixture.0.join("shared");
        let report = scan_roots(
            vec![
                root("a", "A", "global", shared.clone()),
                root("b", "B", "global", shared.clone()),
            ],
            &[shared.canonicalize().unwrap()],
        );
        assert_eq!(report.skills.len(), 2);
        assert!(report
            .skills
            .iter()
            .all(|skill| skill.managed && !skill.can_import));
        assert_ne!(report.skills[0].id, report.skills[1].id);
    }

    #[test]
    fn invalid_utf8_large_files_and_invalid_roots_report_partial_results() {
        let fixture = Fixture::new();
        let invalid = fixture.skill("skills/invalid");
        fs::write(invalid.join("SKILL.md"), [0xff]).unwrap();
        let large = fixture.skill("skills/large");
        fs::write(
            large.join("SKILL.md"),
            vec![b'x'; MAX_DOCUMENT_BYTES as usize + 1],
        )
        .unwrap();
        fixture.skill("skills/valid");
        fs::write(fixture.0.join("file-root"), "not a directory").unwrap();
        let report = scan_roots(
            vec![
                root("a", "A", "global", fixture.0.join("skills")),
                root("b", "B", "global", fixture.0.join("file-root")),
            ],
            &[],
        );
        assert_eq!(report.skills.len(), 1);
        assert_eq!(report.roots[0].status, "partial");
        assert_eq!(report.roots[1].status, "unreadable");
        assert_eq!(report.warnings.len(), 3);
    }

    #[test]
    fn project_scan_is_limited_to_known_skill_roots() {
        let fixture = Fixture::new();
        let home = fixture.0.join("home");
        fs::create_dir_all(&home).unwrap();
        fixture.skill("project/.claude/skills/review");
        fixture.skill("project/unrelated/review");
        let result = scan_roots(roots(&home, Some(&fixture.0.join("project"))).unwrap(), &[]);
        assert_eq!(
            result
                .skills
                .iter()
                .filter(|skill| skill.scope == "project")
                .count(),
            1
        );
        assert!(roots(&home, Some(Path::new("relative/project"))).is_err());
        assert!(roots(&home, Some(&fixture.0.join("absent"))).is_err());
    }

    fn link_directory(target: &Path, link: &Path) {
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            let status = std::process::Command::new("cmd")
                .args(["/C", "mklink", "/J"])
                .arg(link.to_string_lossy().replace('/', "\\"))
                .arg(target.to_string_lossy().replace('/', "\\"))
                .creation_flags(crate::CREATE_NO_WINDOW)
                .output()
                .unwrap();
            assert!(
                status.status.success(),
                "{}",
                String::from_utf8_lossy(&status.stderr)
            );
        }
        #[cfg(unix)]
        std::os::unix::fs::symlink(target, link).unwrap();
    }

    #[test]
    fn links_are_resolved_cycles_are_bounded_and_managed_targets_cannot_import() {
        let fixture = Fixture::new();
        let skill = fixture.skill("managed/review");
        let client = fixture.0.join("client");
        fs::create_dir_all(&client).unwrap();
        link_directory(&skill, &client.join("review"));
        link_directory(&client, &client.join("cycle"));
        let result = scan_roots(
            vec![root("test", "Test", "global", client)],
            &[fixture.0.join("managed").canonicalize().unwrap()],
        );
        assert_eq!(result.skills.len(), 1);
        assert_eq!(result.skills[0].storage_kind, "link");
        assert!(result.skills[0].managed);
        assert!(!result.skills[0].can_import);
        assert!(!result.truncated);
    }

    #[test]
    fn project_skill_root_cannot_redirect_outside_selected_project() {
        let fixture = Fixture::new();
        fixture.skill("outside/review");
        fs::create_dir_all(fixture.0.join("project/.claude")).unwrap();
        link_directory(
            &fixture.0.join("outside"),
            &fixture.0.join("project/.claude/skills"),
        );
        assert!(roots(&fixture.0, Some(&fixture.0.join("project")))
            .unwrap_err()
            .contains("项目范围外"));
    }

    #[test]
    fn document_preview_rejects_arbitrary_paths() {
        let fixture = Fixture::new();
        let outside = fixture.skill("arbitrary");
        let home = fixture.0.join("home");
        fs::create_dir_all(&home).unwrap();
        assert!(read(&fixture.0, &home, None, &outside).is_err());
        let valid = fixture.skill("home/.claude/skills/review");
        assert!(read(&fixture.0, &home, None, &valid)
            .unwrap()
            .content
            .ends_with("Body"));
    }

    #[test]
    fn external_skill_junction_import_copies_original_without_modifying_it() {
        let fixture = Fixture::new();
        let skill = fixture.skill("original/review");
        let original = fs::read(skill.join("SKILL.md")).unwrap();
        let alias = fixture.0.join("linked-review");
        link_directory(&skill, &alias);
        let app = fixture.0.join("app");
        let connection = crate::open_index_database(&app).unwrap();
        let execution = crate::stage_source_import_candidate_in_connection(
            &app,
            &connection,
            "local",
            &alias.to_string_lossy(),
        )
        .unwrap();
        assert_eq!(execution.status, "staged");
        assert_eq!(
            fs::read(Path::new(&execution.staged_path).join("SKILL.md")).unwrap(),
            original
        );
        assert_eq!(fs::read(skill.join("SKILL.md")).unwrap(), original);
        assert!(is_link(&alias));
    }

    #[test]
    fn local_import_rejects_nested_junctions_and_private_data_aliases() {
        let fixture = Fixture::new();
        let outside = fixture.skill("outside/review");
        let collection = fixture.0.join("collection");
        fs::create_dir_all(&collection).unwrap();
        link_directory(&outside, &collection.join("alias"));
        assert!(crate::local_copy_preflight(&collection)
            .unwrap_err()
            .contains("来源内含链接"));

        let app = fixture.0.join("app");
        let connection = crate::open_index_database(&app).unwrap();
        let private = crate::private_state_dir(&app).join("private-skill");
        fs::create_dir_all(&private).unwrap();
        fs::write(private.join("SKILL.md"), "# private").unwrap();
        let alias = fixture.0.join("private-alias");
        link_directory(&private, &alias);
        let execution = crate::stage_source_import_candidate_in_connection(
            &app,
            &connection,
            "local",
            &alias.to_string_lossy(),
        )
        .unwrap();
        assert_eq!(execution.status, "blocked");
        assert_eq!(execution.copied_files, 0);
        assert_eq!(
            fs::read_to_string(private.join("SKILL.md")).unwrap(),
            "# private"
        );
    }
}
