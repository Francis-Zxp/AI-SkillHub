//! Sparse Git scope for managed GitHub sources.
//!
//! Import narrows a partial clone to the folders that hold `SKILL.md`. A later
//! `git pull --ff-only` moves HEAD but never widens that cone, so a Skill the
//! creator adds upstream exists in the commit yet never reaches the disk. Both
//! the importer and every sync use the rules below, so the two paths cannot
//! drift apart:
//!
//! 1. every folder that contains `SKILL.md` in HEAD belongs to the scope;
//! 2. a `SKILL.md` at the repository root makes the whole tree the Skill;
//! 3. a folder outside a Skill that the Skill's Markdown links to with `../`
//!    (shared references, scripts, assets) is a dependency and is included.
//!
//! Reconciliation is state based: it compares HEAD with the current patterns,
//! so it also repairs scopes left incomplete by any earlier pull. It only adds
//! folders that exist in HEAD and only drops patterns whose folder no longer
//! exists in HEAD, so tracked local edits are never moved out of the cone.

use crate::{
    command_output_with_input_timeout_and_cancel, command_output_with_timeout_and_cancel,
    compact_note, configure_safe_git_materialization, format_unix_epoch_utc, SourceImportControl,
    GITHUB_FALLBACK_MAX_BYTES, GITHUB_FALLBACK_MAX_FILES, GITHUB_FALLBACK_MAX_FILE_BYTES,
    SOURCE_IMPORT_MAX_DEPTH,
};
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeSet;
use std::fs;
use std::path::Path;
use std::process::{Command, Output};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub(crate) const SPARSE_SCOPE_REPORT_FILE: &str = "sparse-scope.json";
/// Lives inside `.git`, so it is never an untracked file that blocks a pull.
const SCOPE_MARKER_FILE: &str = "skillhub-sparse-scope.json";
const ROUTER_FOLDER: &str = "AI-SkillHub-local-routers";
const GIT_LOCAL_TIMEOUT: Duration = Duration::from_secs(45);
/// Materializing new folders may fetch blobs from the partial-clone promisor.
const GIT_MATERIALIZE_TIMEOUT: Duration = Duration::from_secs(180);
const DEPENDENCY_SCAN_MAX_FILES: usize = 6_000;
const DEPENDENCY_SCAN_MAX_FILE_BYTES: u64 = 512 * 1024;
const DEPENDENCY_SCAN_DEPTH: usize = 3;
const MAX_DEPENDENCY_DIRS: usize = 64;
/// A linked folder larger than this is a project area, not a Skill helper.
const MAX_FILES_PER_DEPENDENCY: usize = 400;
const MAX_DEPENDENCY_TREE_FILES: usize = 4_000;

/// File and folder paths of one commit, repository relative with `/`.
#[derive(Debug, Default, Clone)]
pub(crate) struct HeadTree {
    files: BTreeSet<String>,
    dirs: BTreeSet<String>,
}

impl HeadTree {
    pub(crate) fn from_paths<I, S>(paths: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        let mut tree = Self::default();
        for path in paths {
            let path = path.as_ref().replace('\\', "/");
            let path = path.trim_matches('/');
            if path.is_empty() {
                continue;
            }
            let mut ancestor = path;
            while let Some((parent, _)) = ancestor.rsplit_once('/') {
                if !tree.dirs.insert(parent.to_string()) {
                    break;
                }
                ancestor = parent;
            }
            tree.files.insert(path.to_string());
        }
        tree
    }

    /// Parses `git ls-tree -r --name-only -z` output.
    pub(crate) fn from_ls_tree_z(stdout: &[u8]) -> Self {
        Self::from_paths(
            stdout
                .split(|byte| *byte == 0)
                .filter_map(|path| std::str::from_utf8(path).ok())
                .filter(|path| !path.trim().is_empty()),
        )
    }

    /// Every folder that directly contains `SKILL.md`; `""` is the root.
    pub(crate) fn skill_roots(&self) -> Vec<String> {
        let mut roots = self
            .files
            .iter()
            .filter_map(|path| {
                let (parent, name) = match path.rsplit_once('/') {
                    Some((parent, name)) => (parent, name),
                    None => ("", path.as_str()),
                };
                name.eq_ignore_ascii_case("SKILL.md")
                    .then(|| parent.to_string())
            })
            .collect::<Vec<_>>();
        roots.sort();
        roots.dedup();
        roots
    }

    pub(crate) fn has_root_skill(&self) -> bool {
        self.skill_roots().iter().any(|root| root.is_empty())
    }

    pub(crate) fn contains_dir(&self, dir: &str) -> bool {
        self.dirs.contains(dir)
    }

    fn files_under(&self, dir: &str) -> usize {
        let prefix = format!("{dir}/");
        self.files
            .range(prefix.clone()..)
            .take_while(|path| path.starts_with(&prefix))
            .count()
    }

    pub(crate) fn file_count(&self) -> usize {
        self.files.len()
    }
}

/// True when `dir` is a strict ancestor of some pattern (for example `skills`
/// for `skills/first`).
fn is_cone_ancestor(patterns: &BTreeSet<String>, dir: &str) -> bool {
    let prefix = format!("{dir}/");
    patterns.iter().any(|pattern| pattern.starts_with(&prefix))
}

/// True when a cone pattern set already materializes `dir` recursively.
pub(crate) fn cone_covers(patterns: &BTreeSet<String>, dir: &str) -> bool {
    !dir.is_empty()
        && patterns
            .iter()
            .any(|pattern| dir == pattern || dir.starts_with(&format!("{pattern}/")))
}

pub(crate) fn read_head_tree_output(
    git_program: &str,
    repo: &Path,
    control: &SourceImportControl,
) -> Result<Output, String> {
    let mut command = Command::new(git_program);
    command.arg("-C").arg(repo).args([
        "-c",
        "core.quotepath=false",
        "ls-tree",
        "-r",
        "--name-only",
        "-z",
        "HEAD",
    ]);
    command_output_with_timeout_and_cancel(
        &mut command,
        GIT_LOCAL_TIMEOUT,
        "读取 GitHub 仓库目录超过 45 秒，已自动停止。",
        Some(control.cancelled.as_ref()),
    )
}

/// Applies a cone pattern set. Patterns travel on stdin so a source with
/// hundreds of Skills never hits the Windows command-line length limit.
pub(crate) fn set_cone_patterns(
    git_program: &str,
    repo: &Path,
    patterns: &BTreeSet<String>,
    control: &SourceImportControl,
) -> Result<Output, String> {
    let mut command = Command::new(git_program);
    configure_safe_git_materialization(&mut command, repo);
    command.args(["sparse-checkout", "set", "--cone", "--stdin"]);
    let mut input = String::new();
    for pattern in patterns {
        input.push_str(pattern);
        input.push('\n');
    }
    command_output_with_input_timeout_and_cancel(
        &mut command,
        Some(input.into_bytes()),
        GIT_MATERIALIZE_TIMEOUT,
        "Skill 文件下载超过 180 秒，已自动停止。请检查网络后重试。",
        Some(control.cancelled.as_ref()),
    )
}

/// Folders outside `scope` that the Markdown inside `skill_roots` links to
/// with `../`. Only folders that exist in `tree` qualify, so a broken or
/// templated link never widens the checkout. Reads files already on disk.
pub(crate) fn dependency_dirs(
    repo: &Path,
    tree: &HeadTree,
    scope: &BTreeSet<String>,
    skill_roots: &[String],
) -> Vec<String> {
    let mut documents = Vec::new();
    'roots: for root in skill_roots.iter().filter(|root| !root.is_empty()) {
        let mut stack = vec![(root.clone(), 0usize)];
        while let Some((dir, depth)) = stack.pop() {
            let Ok(entries) = fs::read_dir(repo.join(&dir)) else {
                continue;
            };
            for entry in entries.flatten() {
                let Ok(file_type) = entry.file_type() else {
                    continue;
                };
                if file_type.is_symlink() {
                    continue;
                }
                let name = entry.file_name().to_string_lossy().to_string();
                if file_type.is_dir() {
                    if depth < DEPENDENCY_SCAN_DEPTH && !name.eq_ignore_ascii_case(".git") {
                        stack.push((format!("{dir}/{name}"), depth + 1));
                    }
                    continue;
                }
                if !name.to_ascii_lowercase().ends_with(".md") {
                    continue;
                }
                if documents.len() >= DEPENDENCY_SCAN_MAX_FILES {
                    break 'roots;
                }
                let small = entry
                    .metadata()
                    .map(|metadata| metadata.len() <= DEPENDENCY_SCAN_MAX_FILE_BYTES)
                    .unwrap_or(false);
                if !small {
                    continue;
                }
                if let Ok(text) = fs::read_to_string(entry.path()) {
                    documents.push((dir.clone(), text));
                }
            }
        }
    }
    dependency_dirs_from_documents(tree, scope, &documents)
}

/// True for a Markdown file that the dependency scan reads: inside a Skill
/// root, at most `DEPENDENCY_SCAN_DEPTH` folders below it.
fn is_dependency_scan_document(path: &str, skill_roots: &[String]) -> bool {
    if !path.to_ascii_lowercase().ends_with(".md") {
        return false;
    }
    skill_roots
        .iter()
        .filter(|root| !root.is_empty())
        .any(|root| {
            path.strip_prefix(&format!("{root}/"))
                .is_some_and(|rest| rest.matches('/').count() <= DEPENDENCY_SCAN_DEPTH)
        })
}

pub(crate) const DEPENDENCY_DOCUMENT_MAX_BYTES: u64 = DEPENDENCY_SCAN_MAX_FILE_BYTES;

/// Dependency folders for an archive download (no Git, no working tree).
/// `files` lists every archive file as `(path, size)`; `read` returns the text
/// of the file at that position. Empty when the root itself is a Skill or the
/// archive holds no Skill, because then the whole archive is kept anyway.
pub(crate) fn archive_dependency_dirs(
    files: &[(String, u64)],
    mut read: impl FnMut(usize) -> Option<String>,
) -> Vec<String> {
    let tree = HeadTree::from_paths(files.iter().map(|(path, _)| path.as_str()));
    let roots = tree.skill_roots();
    if roots.is_empty() || roots.iter().any(|root| root.is_empty()) {
        return Vec::new();
    }
    let scope = roots.iter().cloned().collect::<BTreeSet<_>>();
    let mut documents = Vec::new();
    for (position, (path, size)) in files.iter().enumerate() {
        if documents.len() >= DEPENDENCY_SCAN_MAX_FILES {
            break;
        }
        if *size > DEPENDENCY_SCAN_MAX_FILE_BYTES || !is_dependency_scan_document(path, &roots) {
            continue;
        }
        if let Some(text) = read(position) {
            let dir = path
                .rsplit_once('/')
                .map(|(dir, _)| dir.to_string())
                .unwrap_or_default();
            documents.push((dir, text));
        }
    }
    dependency_dirs_from_documents(&tree, &scope, &documents)
}

/// Pure core shared by the Git and the archive paths. Each document is
/// `(repository-relative folder of the file, file text)`.
pub(crate) fn dependency_dirs_from_documents(
    tree: &HeadTree,
    scope: &BTreeSet<String>,
    documents: &[(String, String)],
) -> Vec<String> {
    let mut found = BTreeSet::new();
    let mut tree_files = 0usize;
    for (dir, text) in documents.iter().take(DEPENDENCY_SCAN_MAX_FILES) {
        for reference in relative_references(text) {
            let Some(target) = resolve_repo_relative(dir, &reference) else {
                continue;
            };
            let dependency = if tree.files.contains(&target) {
                target
                    .rsplit_once('/')
                    .map(|(parent, _)| parent.to_string())
                    .unwrap_or_default()
            } else if tree.dirs.contains(&target) {
                target
            } else {
                continue;
            };
            // A cone checkout already contains every file that sits directly
            // in the root or in an ancestor of a pattern, and a link to an
            // ancestor folder is navigation, not a dependency. Never widen to
            // a whole parent collection.
            if dependency.is_empty()
                || is_cone_ancestor(scope, &dependency)
                || cone_covers(scope, &dependency)
                || cone_covers(&found, &dependency)
            {
                continue;
            }
            let files = tree.files_under(&dependency);
            if files > MAX_FILES_PER_DEPENDENCY || tree_files + files > MAX_DEPENDENCY_TREE_FILES {
                continue;
            }
            tree_files += files;
            // A wider folder supersedes narrower ones already found.
            found.retain(|existing: &String| !existing.starts_with(&format!("{dependency}/")));
            found.insert(dependency);
            if found.len() >= MAX_DEPENDENCY_DIRS {
                return found.into_iter().collect();
            }
        }
    }
    found.into_iter().collect()
}

/// Relative link targets that start with `../` at a token boundary.
fn relative_references(text: &str) -> Vec<String> {
    let bytes = text.as_bytes();
    let mut references = Vec::new();
    let mut cursor = 0usize;
    while let Some(offset) = text[cursor..].find("../") {
        let start = cursor + offset;
        let at_boundary = start == 0
            || matches!(
                bytes[start - 1],
                b' ' | b'\t' | b'\n' | b'\r' | b'(' | b'`' | b'"' | b'\'' | b'[' | b'<' | b'='
            );
        if !at_boundary {
            cursor = start + 3;
            continue;
        }
        let end = text[start..]
            .find(|character: char| {
                character.is_whitespace()
                    || matches!(
                        character,
                        ')' | '`' | '"' | '\'' | '>' | ']' | ',' | ';' | '|' | '*'
                    )
            })
            .map(|length| start + length)
            .unwrap_or(text.len());
        let mut reference = text[start..end]
            .split(['#', '?'])
            .next()
            .unwrap_or_default()
            .to_string();
        while reference.ends_with('.') && !reference.ends_with("/..") {
            reference.pop();
        }
        while reference.ends_with(':') {
            reference.pop();
        }
        if !reference.is_empty() {
            references.push(percent_decode(&reference));
        }
        cursor = end.max(start + 3);
    }
    references
}

fn percent_decode(value: &str) -> String {
    if !value.contains('%') {
        return value.to_string();
    }
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(&value[index + 1..index + 3], 16) {
                decoded.push(byte);
                index += 3;
                continue;
            }
        }
        decoded.push(bytes[index]);
        index += 1;
    }
    String::from_utf8(decoded).unwrap_or_else(|_| value.to_string())
}

/// Lexically joins `target` onto `base_dir`; `None` when it escapes the repo.
fn resolve_repo_relative(base_dir: &str, target: &str) -> Option<String> {
    let mut parts = base_dir
        .split('/')
        .filter(|part| !part.is_empty())
        .map(str::to_string)
        .collect::<Vec<_>>();
    for segment in target.replace('\\', "/").split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            other => parts.push(other.to_string()),
        }
    }
    Some(parts.join("/"))
}

/// Who decides which Skills of a source are installed.
#[derive(Debug, Clone, Default)]
pub(crate) struct ScopePolicy {
    /// `Some` when the user picked an explicit Skill list; new upstream Skills
    /// are then reported as discovered and are not enabled automatically.
    pub explicit_paths: Option<Vec<String>>,
}

impl ScopePolicy {
    pub(crate) fn from_config(config: Option<&Value>, folder: &str) -> Self {
        let explicit_paths = config
            .and_then(|config| config.get("repositories"))
            .and_then(Value::as_array)
            .and_then(|repositories| {
                repositories.iter().find(|repository| {
                    repository
                        .get("name")
                        .and_then(Value::as_str)
                        .is_some_and(|name| name.eq_ignore_ascii_case(folder))
                })
            })
            .filter(|repository| repository.get("mode").and_then(Value::as_str) == Some("explicit"))
            .map(|repository| {
                repository
                    .get("skillPaths")
                    .and_then(Value::as_array)
                    .map(|paths| {
                        paths
                            .iter()
                            .filter_map(Value::as_str)
                            .map(|path| path.replace('\\', "/").trim_matches('/').to_string())
                            .filter(|path| !path.is_empty())
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default()
            });
        Self { explicit_paths }
    }
}

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SparseScopeOutcome {
    pub folder: String,
    /// unchanged | updated | full-checkout | discovered | local-conflict |
    /// network-failed | failed | deferred
    pub status: String,
    pub added_skills: Vec<String>,
    pub removed_paths: Vec<String>,
    pub added_dependencies: Vec<String>,
    /// Upstream Skills outside an explicit selection: found, not enabled.
    pub discovered_skills: Vec<String>,
    /// Files inside newly added folders where a local file already existed.
    /// Git keeps the local version; it now shows as a local modification.
    pub kept_local_paths: Vec<String>,
    pub detail: String,
    pub checked_at: String,
}

impl SparseScopeOutcome {
    fn new(folder: &str, status: &str, detail: impl Into<String>) -> Self {
        Self {
            folder: folder.to_string(),
            status: status.to_string(),
            detail: detail.into(),
            checked_at: now_utc(),
            ..Self::default()
        }
    }

    /// The working tree changed, so routers and the index must be rebuilt.
    pub(crate) fn changed_files(&self) -> bool {
        matches!(self.status.as_str(), "updated" | "full-checkout")
    }
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SparseScopeReport {
    pub schema_version: u32,
    pub generated_at: String,
    pub sources: Vec<SparseScopeOutcome>,
}

impl SparseScopeReport {
    pub(crate) fn changed_files(&self) -> bool {
        self.sources.iter().any(SparseScopeOutcome::changed_files)
    }
}

fn now_utc() -> String {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default();
    format_unix_epoch_utc(seconds)
}

fn git_output(git_program: &str, repo: &Path, args: &[&str]) -> Result<Output, String> {
    let mut command = Command::new(git_program);
    command.arg("-C").arg(repo).args(args);
    command_output_with_timeout_and_cancel(
        &mut command,
        GIT_LOCAL_TIMEOUT,
        "读取本地 Git 状态超过 45 秒，已自动停止。",
        None,
    )
}

fn git_bool_config(git_program: &str, repo: &Path, key: &str) -> bool {
    git_output(git_program, repo, &["config", "--bool", "--get", key])
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim() == "true")
        .unwrap_or(false)
}

fn current_cone_patterns(git_program: &str, repo: &Path) -> Result<BTreeSet<String>, String> {
    let output = git_output(
        git_program,
        repo,
        &["-c", "core.quotepath=false", "sparse-checkout", "list"],
    )?;
    if !output.status.success() {
        return Err(git_failure_detail(&output));
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(|line| line.trim().trim_matches('/').replace('\\', "/"))
        .filter(|line| !line.is_empty())
        .collect())
}

fn git_failure_detail(output: &Output) -> String {
    let stderr = compact_note(&String::from_utf8_lossy(&output.stderr));
    let stdout = compact_note(&String::from_utf8_lossy(&output.stdout));
    let detail = if stderr.is_empty() { stdout } else { stderr };
    if detail.is_empty() {
        "Git 返回失败，但没有提供错误详情。".to_string()
    } else {
        detail.chars().take(320).collect()
    }
}

fn classify_git_failure(detail: &str) -> &'static str {
    let lower = detail.to_ascii_lowercase();
    if lower.contains("would be overwritten")
        || lower.contains("untracked working tree")
        || lower.contains("not uptodate")
        || lower.contains("local changes")
    {
        "local-conflict"
    } else if lower.contains("could not resolve host")
        || lower.contains("unable to access")
        || lower.contains("failed to connect")
        || lower.contains("could not read from remote")
        || lower.contains("does not appear to be a git repository")
        || lower.contains("promisor")
        || lower.contains("timed out")
        || lower.contains("connection")
        || lower.contains("超时")
        || (lower.contains("超过") && lower.contains("秒"))
    {
        "network-failed"
    } else {
        "failed"
    }
}

/// Tracked paths under `folders` whose working copy differs from HEAD.
fn modified_paths_under(git_program: &str, repo: &Path, folders: &[String]) -> Vec<String> {
    if folders.is_empty() {
        return Vec::new();
    }
    let Ok(output) = git_output(
        git_program,
        repo,
        &[
            "-c",
            "core.quotepath=false",
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=no",
        ],
    ) else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }
    let prefixes = folders
        .iter()
        .map(|folder| format!("{folder}/"))
        .collect::<Vec<_>>();
    output
        .stdout
        .split(|byte| *byte == 0)
        .filter_map(|entry| std::str::from_utf8(entry).ok())
        .filter(|entry| entry.len() > 3)
        .map(|entry| entry[3..].replace('\\', "/"))
        .filter(|path| {
            prefixes
                .iter()
                .any(|prefix| path.starts_with(prefix.as_str()))
        })
        .collect()
}

fn has_skill_file(directory: &Path) -> bool {
    fs::read_dir(directory).ok().is_some_and(|entries| {
        entries.flatten().any(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .eq_ignore_ascii_case("SKILL.md")
                && entry
                    .file_type()
                    .map(|kind| kind.is_file())
                    .unwrap_or(false)
        })
    })
}

/// Bounded size check for folders that this reconciliation added.
fn added_folders_within_bounds(repo: &Path, folders: &[String]) -> Result<(), String> {
    let mut files = 0usize;
    let mut bytes = 0u64;
    for folder in folders {
        let mut stack = vec![(repo.join(folder), 0usize)];
        while let Some((directory, depth)) = stack.pop() {
            if depth > SOURCE_IMPORT_MAX_DEPTH {
                return Err(format!(
                    "新增目录层级超过安全上限（{SOURCE_IMPORT_MAX_DEPTH} 层）：{folder}"
                ));
            }
            let Ok(entries) = fs::read_dir(&directory) else {
                continue;
            };
            for entry in entries.flatten() {
                let Ok(file_type) = entry.file_type() else {
                    continue;
                };
                if file_type.is_symlink() {
                    continue;
                }
                if file_type.is_dir() {
                    stack.push((entry.path(), depth + 1));
                    continue;
                }
                let size = entry.metadata().map(|metadata| metadata.len()).unwrap_or(0);
                if size > GITHUB_FALLBACK_MAX_FILE_BYTES {
                    return Err(format!("新增内容含超过 16 MB 的单个文件：{folder}"));
                }
                files += 1;
                bytes = bytes.saturating_add(size);
                if files > GITHUB_FALLBACK_MAX_FILES || bytes > GITHUB_FALLBACK_MAX_BYTES {
                    return Err("新增内容超过单次更新的文件数或 80 MB 容量上限。".to_string());
                }
            }
        }
    }
    Ok(())
}

fn write_marker(repo: &Path, mode: &str, patterns: &BTreeSet<String>, dependencies: &[String]) {
    let git_dir = repo.join(".git");
    if !git_dir.is_dir() {
        return;
    }
    let payload = serde_json::json!({
        "schemaVersion": 1,
        "mode": mode,
        "patterns": patterns,
        "dependencies": dependencies,
        "updatedAt": now_utc(),
    });
    if let Ok(text) = serde_json::to_string_pretty(&payload) {
        let _ = fs::write(git_dir.join(SCOPE_MARKER_FILE), text);
    }
}

/// Brings one sparse source in line with its HEAD. Returns `None` for a
/// source that is not a managed sparse clone. Only the exact legacy importer
/// Markdown pattern may be migrated; custom non-cone selections stay intact.
pub(crate) fn reconcile_repository(
    git_program: &str,
    repo: &Path,
    folder: &str,
    policy: &ScopePolicy,
    control: &SourceImportControl,
) -> Option<SparseScopeOutcome> {
    if !repo.join(".git").is_dir() || !git_bool_config(git_program, repo, "core.sparseCheckout") {
        return None;
    }
    if !git_bool_config(git_program, repo, "core.sparseCheckoutCone") {
        return reconcile_legacy_prompt(git_program, repo, folder, policy, control);
    }
    let outcome = match read_head_tree_output(git_program, repo, control) {
        Ok(output) if output.status.success() => {
            let tree = HeadTree::from_ls_tree_z(&output.stdout);
            reconcile_with_tree(git_program, repo, folder, policy, control, &tree)
        }
        Ok(output) => SparseScopeOutcome::new(folder, "failed", git_failure_detail(&output)),
        Err(error) => SparseScopeOutcome::new(folder, "failed", error),
    };
    Some(outcome)
}

fn reconcile_legacy_prompt(
    git_program: &str,
    repo: &Path,
    folder: &str,
    policy: &ScopePolicy,
    control: &SourceImportControl,
) -> Option<SparseScopeOutcome> {
    if policy.explicit_paths.is_some() {
        return None;
    }
    let marker_path = repo.join(crate::MANAGED_SOURCE_METADATA_FILE);
    let marker_meta = fs::symlink_metadata(&marker_path).ok()?;
    if !marker_meta.is_file() || marker_meta.len() > 128 * 1024 {
        return None;
    }
    let marker = crate::read_json(&marker_path)?;
    // This exact rule was generated by the old Prompt importer. Neither a
    // similarly named folder nor arbitrary hand-written sparse rules qualify.
    if marker.get("downloadMethod").and_then(Value::as_str) != Some("git")
        || marker
            .get("url")
            .and_then(Value::as_str)
            .and_then(crate::parse_github_repo)
            .is_none()
    {
        return None;
    }
    let pattern_path = repo.join(".git/info/sparse-checkout");
    let patterns = fs::read_to_string(&pattern_path).ok()?;
    if patterns.trim() != "/*.md" {
        return None;
    }
    if let Err(error) = crate::github_origin_at(repo) {
        return Some(SparseScopeOutcome::new(folder, "failed", error));
    }
    let status = match git_output(
        git_program,
        repo,
        &[
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
            "--ignored=matching",
        ],
    ) {
        Ok(output) if output.status.success() => output,
        Ok(output) => {
            return Some(SparseScopeOutcome::new(
                folder,
                "failed",
                git_failure_detail(&output),
            ))
        }
        Err(error) => return Some(SparseScopeOutcome::new(folder, "failed", error)),
    };
    // Even ignored/untracked files can collide with newly downloaded files.
    // Only SkillHub's own untracked import record is expected in this checkout.
    let dirty = status.stdout.split(|byte| *byte == 0).any(|entry| {
        !entry.is_empty()
            && entry != format!("?? {}", crate::MANAGED_SOURCE_METADATA_FILE).as_bytes()
    });
    if dirty {
        return Some(SparseScopeOutcome::new(
            folder,
            "local-conflict",
            "旧版 Prompt 来源含本地修改或未跟踪文件；已保留文件与原下载范围，处理后重试即可补齐。",
        ));
    }
    // Check sizes before materialization, including paths outside the old
    // Markdown selection. Use the same limits as a fresh Prompt import.
    if let Err(error) = crate::validate_prompt_git_tree_before_checkout(git_program, repo, control)
    {
        return Some(SparseScopeOutcome::new(
            folder,
            classify_git_failure(&error),
            error,
        ));
    }
    let output = match read_head_tree_output(git_program, repo, control) {
        Ok(output) if output.status.success() => output,
        Ok(output) => {
            return Some(SparseScopeOutcome::new(
                folder,
                "failed",
                git_failure_detail(&output),
            ))
        }
        Err(error) => return Some(SparseScopeOutcome::new(folder, "failed", error)),
    };
    let tree = HeadTree::from_ls_tree_z(&output.stdout);
    let missing_skills = tree
        .skill_roots()
        .into_iter()
        .filter(|path| !has_skill_file(&repo.join(path)))
        .collect::<Vec<_>>();
    // Keep the original selection beside Git metadata, never in the source
    // worktree or the user's global Git configuration.
    let backup = repo.join(".git/skillhub-legacy-prompt-sparse.backup");
    if let Err(error) = fs::write(&backup, &patterns) {
        return Some(SparseScopeOutcome::new(
            folder,
            "failed",
            format!("无法备份原下载范围：{error}"),
        ));
    }
    let mut command = Command::new(git_program);
    configure_safe_git_materialization(&mut command, repo);
    command.args(["sparse-checkout", "disable"]);
    let failure = match command_output_with_timeout_and_cancel(
        &mut command,
        GIT_MATERIALIZE_TIMEOUT,
        "完整检出超过 180 秒，已停止。请检查网络后重试。",
        Some(control.cancelled.as_ref()),
    ) {
        Ok(output) if output.status.success() => {
            crate::validate_staged_repository_bounds(repo).err()
        }
        Ok(output) => Some(git_failure_detail(&output)),
        Err(error) => Some(error),
    };
    if let Some(error) = failure {
        // Restoration must still run if cancellation caused the failure.
        let mut restore = Command::new(git_program);
        configure_safe_git_materialization(&mut restore, repo);
        restore.args(["sparse-checkout", "set", "--no-cone", "--stdin"]);
        let restored = matches!(
            command_output_with_input_timeout_and_cancel(
                &mut restore,
                Some(patterns.into_bytes()),
                GIT_MATERIALIZE_TIMEOUT,
                "恢复旧下载范围超时。",
                None,
            ),
            Ok(output) if output.status.success()
        );
        return Some(SparseScopeOutcome::new(
            folder,
            classify_git_failure(&error),
            format!(
                "{error}；{}",
                if restored {
                    "已恢复原下载范围。"
                } else {
                    "原范围备份已保留，恢复失败，请重试同步。"
                }
            ),
        ));
    }
    write_marker(repo, "full", &BTreeSet::new(), &[]);
    let mut outcome = SparseScopeOutcome::new(
        folder,
        "full-checkout",
        "已补齐旧版 Prompt 来源的项目文件；以后更新会同步完整内容。",
    );
    outcome.added_skills = missing_skills;
    Some(outcome)
}

fn reconcile_with_tree(
    git_program: &str,
    repo: &Path,
    folder: &str,
    policy: &ScopePolicy,
    control: &SourceImportControl,
    tree: &HeadTree,
) -> SparseScopeOutcome {
    let current = match current_cone_patterns(git_program, repo) {
        Ok(patterns) => patterns,
        Err(error) => return SparseScopeOutcome::new(folder, "failed", error),
    };
    let tree_roots = tree
        .skill_roots()
        .into_iter()
        .filter(|root| !root.is_empty())
        .collect::<Vec<_>>();

    let mut outcome = SparseScopeOutcome::new(folder, "unchanged", "");
    let (wanted_roots, mode) = match &policy.explicit_paths {
        Some(paths) => {
            let selected = paths
                .iter()
                .filter(|path| tree.contains_dir(path))
                .cloned()
                .collect::<Vec<_>>();
            let selected_set = selected.iter().cloned().collect::<BTreeSet<_>>();
            outcome.discovered_skills = tree_roots
                .iter()
                .filter(|root| !cone_covers(&selected_set, root))
                .cloned()
                .collect();
            let missing = paths.iter().filter(|path| !tree.contains_dir(path)).count();
            if missing > 0 {
                outcome.detail =
                    format!("{missing} 个已选 Skill 路径在上游已不存在，已保留其余选择。");
            }
            (selected, "explicit")
        }
        None => {
            if tree.has_root_skill() {
                return enable_full_checkout(git_program, repo, folder, control, tree, &current);
            }
            (tree_roots.clone(), "all-skills")
        }
    };

    // Patterns whose folder vanished upstream (deleted or renamed) are stale.
    // Patterns for folders that still exist stay, including any the user added.
    let removed = current
        .iter()
        .filter(|pattern| !tree.contains_dir(pattern))
        .cloned()
        .collect::<Vec<_>>();
    let mut desired = current
        .iter()
        .filter(|pattern| tree.contains_dir(pattern))
        .cloned()
        .collect::<BTreeSet<_>>();
    let added_roots = wanted_roots
        .iter()
        .filter(|root| !cone_covers(&current, root))
        .cloned()
        .collect::<Vec<_>>();
    desired.extend(wanted_roots.iter().cloned());

    // Dependencies of Skills already on disk can be resolved before any write.
    let on_disk_roots = wanted_roots
        .iter()
        .filter(|root| cone_covers(&current, root))
        .cloned()
        .collect::<Vec<_>>();
    let mut dependencies = dependency_dirs(repo, tree, &desired, &on_disk_roots);
    desired.extend(dependencies.iter().cloned());

    if added_roots.is_empty() && removed.is_empty() && dependencies.is_empty() {
        if !outcome.discovered_skills.is_empty() {
            outcome.status = "discovered".to_string();
        }
        write_marker(repo, mode, &current, &[]);
        return outcome;
    }

    if let Err(failure) = apply_patterns(git_program, repo, &desired, &current, control) {
        outcome.status = classify_git_failure(&failure).to_string();
        outcome.detail = failure;
        return outcome;
    }

    // Newly materialized Skills can link to shared folders of their own.
    if !added_roots.is_empty() {
        let extra = dependency_dirs(repo, tree, &desired, &added_roots);
        if !extra.is_empty() {
            let mut widened = desired.clone();
            widened.extend(extra.iter().cloned());
            match apply_patterns(git_program, repo, &widened, &current, control) {
                Ok(()) => {
                    desired = widened;
                    dependencies.extend(extra);
                }
                Err(failure) => {
                    outcome.status = classify_git_failure(&failure).to_string();
                    outcome.detail = failure;
                    return outcome;
                }
            }
        }
    }

    let missing_skill = added_roots
        .iter()
        .find(|root| !has_skill_file(&repo.join(root.as_str())));
    let mut added_folders = added_roots.clone();
    added_folders.extend(dependencies.iter().cloned());
    let verification = match missing_skill {
        Some(root) => Err(format!("新 Skill 检出后仍缺少 SKILL.md：{root}")),
        None => added_folders_within_bounds(repo, &added_folders),
    };
    if let Err(failure) = verification {
        let restored = restore_patterns(git_program, repo, &current, control);
        outcome.status = "failed".to_string();
        outcome.detail = if restored {
            format!("{failure}；已恢复到更新前的检出范围。")
        } else {
            format!("{failure}；恢复原检出范围失败，请在维护工具中重试同步。")
        };
        return outcome;
    }

    outcome.status = "updated".to_string();
    outcome.kept_local_paths = modified_paths_under(git_program, repo, &added_folders);
    if !outcome.kept_local_paths.is_empty() {
        outcome.detail = format!(
            "{} 个新增文件与本地已有文件同名，已保留本地版本；该来源之后的更新会因本地修改而暂停，处理后即可恢复。",
            outcome.kept_local_paths.len()
        );
    }
    outcome.added_skills = added_roots;
    outcome.removed_paths = removed;
    outcome.added_dependencies = dependencies.clone();
    write_marker(repo, mode, &desired, &dependencies);
    outcome
}

fn apply_patterns(
    git_program: &str,
    repo: &Path,
    desired: &BTreeSet<String>,
    previous: &BTreeSet<String>,
    control: &SourceImportControl,
) -> Result<(), String> {
    let failure = match set_cone_patterns(git_program, repo, desired, control) {
        Ok(output) if output.status.success() => return Ok(()),
        Ok(output) => git_failure_detail(&output),
        Err(error) => error,
    };
    // Git normally keeps the previous patterns when the working tree update
    // fails; restore explicitly so a timeout or kill cannot leave a half scope.
    let _ = restore_patterns(git_program, repo, previous, control);
    Err(failure)
}

fn restore_patterns(
    git_program: &str,
    repo: &Path,
    previous: &BTreeSet<String>,
    control: &SourceImportControl,
) -> bool {
    if previous.is_empty() {
        return false;
    }
    if current_cone_patterns(git_program, repo).ok().as_ref() == Some(previous) {
        return true;
    }
    matches!(
        set_cone_patterns(git_program, repo, previous, control),
        Ok(output) if output.status.success()
    )
}

fn enable_full_checkout(
    git_program: &str,
    repo: &Path,
    folder: &str,
    control: &SourceImportControl,
    tree: &HeadTree,
    current: &BTreeSet<String>,
) -> SparseScopeOutcome {
    let mut outcome = SparseScopeOutcome::new(folder, "full-checkout", "");
    if tree.file_count() > GITHUB_FALLBACK_MAX_FILES {
        outcome.status = "failed".to_string();
        outcome.detail = format!(
            "仓库根目录新增了 SKILL.md，但完整仓库文件数超过安全上限（{} > {}）；保持原检出范围。",
            tree.file_count(),
            GITHUB_FALLBACK_MAX_FILES
        );
        return outcome;
    }
    let mut command = Command::new(git_program);
    configure_safe_git_materialization(&mut command, repo);
    command.args(["sparse-checkout", "disable"]);
    let result = command_output_with_timeout_and_cancel(
        &mut command,
        GIT_MATERIALIZE_TIMEOUT,
        "完整检出超过 180 秒，已自动停止。请检查网络后重试。",
        Some(control.cancelled.as_ref()),
    );
    let failure = match result {
        Ok(output) if output.status.success() => None,
        Ok(output) => Some(git_failure_detail(&output)),
        Err(error) => Some(error),
    };
    let failure = failure.or_else(|| crate::validate_staged_repository_bounds(repo).err());
    if let Some(failure) = failure {
        let restored = restore_patterns(git_program, repo, current, control);
        outcome.status = classify_git_failure(&failure).to_string();
        outcome.detail = if restored {
            format!("{failure}；已恢复到更新前的检出范围。")
        } else {
            failure
        };
        return outcome;
    }
    outcome.added_skills = vec![String::new()];
    outcome.detail = "仓库根目录现在就是一个 Skill，已切换为完整检出。".to_string();
    write_marker(repo, "full", &BTreeSet::new(), &[]);
    outcome
}

/// Reconciles every sparse clone inside `sources_dir`. A source the budget
/// cannot reach is reported as deferred; the next sync repairs it because the
/// comparison is always against HEAD.
pub(crate) fn reconcile_sources(
    git_program: &str,
    sources_dir: &Path,
    config: Option<&Value>,
    budget: Duration,
) -> SparseScopeReport {
    let started = Instant::now();
    let mut folders = fs::read_dir(sources_dir)
        .map(|entries| {
            entries
                .flatten()
                .filter(|entry| entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false))
                .map(|entry| entry.file_name().to_string_lossy().to_string())
                .filter(|name| name != ROUTER_FOLDER)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    folders.sort_by_key(|name| name.to_lowercase());
    let mut sources = Vec::new();
    for folder in folders {
        let repo = sources_dir.join(&folder);
        if started.elapsed() >= budget {
            if repo.join(".git").is_dir()
                && git_bool_config(git_program, &repo, "core.sparseCheckout")
            {
                sources.push(SparseScopeOutcome::new(
                    &folder,
                    "deferred",
                    "本次同步时间已用完；下次同步会继续核对该来源的 Skill 范围。",
                ));
            }
            continue;
        }
        let policy = ScopePolicy::from_config(config, &folder);
        let control = SourceImportControl::detached(format!("sparse-scope-{folder}"));
        if let Some(outcome) = reconcile_repository(git_program, &repo, &folder, &policy, &control)
        {
            sources.push(outcome);
        }
    }
    SparseScopeReport {
        schema_version: 1,
        generated_at: now_utc(),
        sources,
    }
}

pub(crate) fn write_report(state_dir: &Path, report: &SparseScopeReport) -> Result<(), String> {
    fs::create_dir_all(state_dir).map_err(|error| format!("无法创建同步状态目录：{error}"))?;
    let text = serde_json::to_string_pretty(report)
        .map_err(|error| format!("无法序列化 Skill 范围核对结果：{error}"))?;
    fs::write(state_dir.join(SPARSE_SCOPE_REPORT_FILE), text)
        .map_err(|error| format!("无法写入 Skill 范围核对结果：{error}"))
}

#[cfg(test)]
pub(crate) fn read_report(state_dir: &Path) -> Option<SparseScopeReport> {
    let raw = fs::read_to_string(state_dir.join(SPARSE_SCOPE_REPORT_FILE)).ok()?;
    let value = serde_json::from_str::<Value>(raw.trim_start_matches('\u{feff}')).ok()?;
    let strings = |item: &Value, key: &str| -> Vec<String> {
        item.get(key)
            .and_then(Value::as_array)
            .map(|values| {
                values
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default()
    };
    let text = |item: &Value, key: &str| -> String {
        item.get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    let sources = value
        .get("sources")
        .and_then(Value::as_array)?
        .iter()
        .map(|item| SparseScopeOutcome {
            folder: text(item, "folder"),
            status: text(item, "status"),
            added_skills: strings(item, "addedSkills"),
            removed_paths: strings(item, "removedPaths"),
            added_dependencies: strings(item, "addedDependencies"),
            discovered_skills: strings(item, "discoveredSkills"),
            kept_local_paths: strings(item, "keptLocalPaths"),
            detail: text(item, "detail"),
            checked_at: text(item, "checkedAt"),
        })
        .collect();
    Some(SparseScopeReport {
        schema_version: value
            .get("schemaVersion")
            .and_then(Value::as_u64)
            .unwrap_or(1) as u32,
        generated_at: text(&value, "generatedAt"),
        sources,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn head_tree_finds_nested_and_root_skill_folders() {
        let tree = HeadTree::from_paths([
            "README.md",
            "skills/first/SKILL.md",
            "skills/first/scripts/run.py",
            "skills/中文 技能/SKILL.md",
            "plugins/x/skills/second/skill.md",
        ]);
        assert_eq!(
            tree.skill_roots(),
            vec![
                "plugins/x/skills/second".to_string(),
                "skills/first".to_string(),
                "skills/中文 技能".to_string(),
            ]
        );
        assert!(!tree.has_root_skill());
        assert!(tree.contains_dir("skills/first/scripts"));
        assert!(HeadTree::from_paths(["SKILL.md", "docs/a.md"]).has_root_skill());
    }

    #[test]
    fn cone_coverage_is_recursive_and_exact_on_segments() {
        let patterns = BTreeSet::from(["skills/first".to_string()]);
        assert!(cone_covers(&patterns, "skills/first"));
        assert!(cone_covers(&patterns, "skills/first/codex"));
        assert!(!cone_covers(&patterns, "skills/first-variant"));
        assert!(!cone_covers(&patterns, ""));
    }

    #[test]
    fn relative_references_cover_markdown_code_and_plain_forms() {
        let text = "See [contract](../shared-references/integration-contract.md#top).\n\
                    Load `../nature-shared/core/terms.md` first, then ../../docs/guide.md.\n\
                    Ignore a/../b, https://x/../y and [web](https://example.com).\n\
                    Spaces: [x](../My%20Shared/a.md)";
        let references = relative_references(text);
        assert_eq!(
            references,
            vec![
                "../shared-references/integration-contract.md".to_string(),
                "../nature-shared/core/terms.md".to_string(),
                "../../docs/guide.md".to_string(),
                "../My Shared/a.md".to_string(),
            ]
        );
    }

    #[test]
    fn resolution_never_escapes_the_repository() {
        assert_eq!(
            resolve_repo_relative("skills/a", "../shared/x.md").as_deref(),
            Some("skills/shared/x.md")
        );
        assert_eq!(resolve_repo_relative("skills/a", "../../../x.md"), None);
        assert_eq!(
            resolve_repo_relative("skills/a/references", "./../../b/").as_deref(),
            Some("skills/b")
        );
    }

    #[test]
    fn archive_download_keeps_linked_helpers_but_not_parent_collections() {
        let files = vec![
            ("README.md".to_string(), 10),
            ("skills/alpha/SKILL.md".to_string(), 80),
            ("skills/alpha/references/deep.md".to_string(), 40),
            ("skills/shared/contract.md".to_string(), 10),
            ("skills/README.md".to_string(), 10),
            ("tools/run.py".to_string(), 10),
            ("docs/huge/a.md".to_string(), 10),
        ];
        let texts = [
            "",
            "Read [c](../shared/contract.md) and [index](../README.md).",
            "Run `../../../tools/run.py`.",
            "",
            "",
            "",
            "",
        ];
        let dependencies =
            archive_dependency_dirs(&files, |position| Some(texts[position].to_string()));
        assert_eq!(
            dependencies,
            vec!["skills/shared".to_string(), "tools".to_string()]
        );

        let root_skill = vec![("SKILL.md".to_string(), 10), ("lib/x.md".to_string(), 10)];
        assert!(
            archive_dependency_dirs(&root_skill, |_| Some("../lib/x.md".to_string())).is_empty()
        );
    }

    #[test]
    fn explicit_policy_reads_only_matching_explicit_repository() {
        let config = serde_json::json!({
            "repositories": [
                { "name": "Nature-Skills", "mode": "explicit", "skillPaths": ["skills\\nature-figure", "skills/nature-writing/"] },
                { "name": "other", "mode": "auto" }
            ]
        });
        let policy = ScopePolicy::from_config(Some(&config), "nature-skills");
        assert_eq!(
            policy.explicit_paths,
            Some(vec![
                "skills/nature-figure".to_string(),
                "skills/nature-writing".to_string()
            ])
        );
        assert!(ScopePolicy::from_config(Some(&config), "other")
            .explicit_paths
            .is_none());
        assert!(ScopePolicy::from_config(None, "x").explicit_paths.is_none());
    }

    /// Real Git fixtures: an upstream repository and a consumer created by the
    /// production import path (partial clone + shared sparse rules).
    mod git_fixtures {
        use super::super::*;
        use std::path::PathBuf;

        struct Fixture {
            root: PathBuf,
            upstream: PathBuf,
            sources: PathBuf,
        }

        impl Drop for Fixture {
            fn drop(&mut self) {
                let _ = fs::remove_dir_all(&self.root);
            }
        }

        fn git_available() -> bool {
            Command::new("git").arg("--version").output().is_ok()
        }

        fn git(cwd: &Path, args: &[&str]) -> Output {
            let output = Command::new("git")
                .arg("-C")
                .arg(cwd)
                .args([
                    "-c",
                    "user.name=SkillHub Fixture",
                    "-c",
                    "user.email=fixture@example.invalid",
                ])
                .args(["-c", "core.autocrlf=false", "-c", "init.defaultBranch=main"])
                .args(args)
                .output()
                .expect("fixture git should start");
            assert!(
                output.status.success(),
                "git {:?} failed: {}",
                args,
                String::from_utf8_lossy(&output.stderr)
            );
            output
        }

        fn write(path: &Path, text: &str) {
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, text).unwrap();
        }

        fn skill(name: &str) -> String {
            format!("---\nname: {name}\ndescription: Fixture skill {name}.\n---\n# {name}\n")
        }

        impl Fixture {
            fn new(label: &str) -> Self {
                let root = std::env::temp_dir().join(format!(
                    "skillhub-sparse-{label}-{}",
                    crate::unix_timestamp_string()
                ));
                let upstream = root.join("upstream");
                let sources = root.join("sources");
                fs::create_dir_all(&upstream).unwrap();
                fs::create_dir_all(&sources).unwrap();
                git(&upstream, &["init", "-b", "main"]);
                git(&upstream, &["config", "uploadpack.allowFilter", "true"]);
                git(
                    &upstream,
                    &["config", "uploadpack.allowAnySHA1InWant", "true"],
                );
                Self {
                    root,
                    upstream,
                    sources,
                }
            }

            fn commit(&self, message: &str) {
                git(&self.upstream, &["add", "-A"]);
                git(&self.upstream, &["commit", "-q", "-m", message]);
            }

            fn upstream_url(&self) -> String {
                format!(
                    "file:///{}",
                    self.upstream.display().to_string().replace('\\', "/")
                )
            }

            /// Mirrors the production import: partial clone, then the shared
            /// sparse rules in `complete_sparse_skill_checkout`.
            fn import(&self, folder: &str) -> PathBuf {
                let consumer = self.sources.join(folder);
                let url = self.upstream_url();
                git(
                    &self.sources,
                    &[
                        "clone",
                        "-q",
                        "--filter=blob:none",
                        "--no-checkout",
                        "--no-tags",
                        &url,
                        folder,
                    ],
                );
                let control = SourceImportControl::detached("sparse-fixture-import");
                let output =
                    crate::complete_sparse_skill_checkout("git", &consumer, &control, None)
                        .expect("fixture import should run");
                assert!(
                    output.status.success(),
                    "fixture import failed: {}",
                    String::from_utf8_lossy(&output.stderr)
                );
                consumer
            }

            fn pull(&self, consumer: &Path) -> Output {
                git(consumer, &["pull", "-q", "--ff-only"])
            }

            fn legacy_prompt(&self) -> PathBuf {
                let consumer = self.sources.join("prompt--fixture");
                git(
                    &self.sources,
                    &["clone", "-q", &self.upstream_url(), "prompt--fixture"],
                );
                git(&consumer, &["sparse-checkout", "set", "--no-cone", "/*.md"]);
                git(
                    &consumer,
                    &[
                        "remote",
                        "set-url",
                        "origin",
                        "https://github.com/fixture/prompt.git",
                    ],
                );
                crate::write_managed_source_metadata(
                    &consumer,
                    "https://github.com/fixture/prompt.git",
                    "git",
                    "main",
                )
                .unwrap();
                consumer
            }
        }

        fn reconcile(consumer: &Path, policy: &ScopePolicy) -> SparseScopeOutcome {
            let control = SourceImportControl::detached("sparse-fixture-reconcile");
            let folder = consumer.file_name().unwrap().to_string_lossy().to_string();
            reconcile_repository("git", consumer, &folder, policy, &control)
                .expect("fixture consumer should be a sparse cone clone")
        }

        fn head(path: &Path) -> String {
            String::from_utf8_lossy(&git(path, &["rev-parse", "HEAD"]).stdout)
                .trim()
                .to_string()
        }

        #[test]
        fn legacy_prompt_migration_materializes_project_and_new_upstream_skill() {
            if !git_available() {
                return;
            }
            let fixture = Fixture::new("legacy-prompt");
            write(&fixture.upstream.join("README.md"), "prompt instructions");
            write(
                &fixture.upstream.join("train.py"),
                "print('project dependency')",
            );
            fixture.commit("initial prompt");
            let consumer = fixture.legacy_prompt();
            assert!(!consumer.join("train.py").exists());
            write(&fixture.upstream.join("skills/new/SKILL.md"), &skill("new"));
            fixture.commit("add new skill");
            git(
                &consumer,
                &["pull", "-q", "--ff-only", &fixture.upstream_url(), "main"],
            );
            assert!(!consumer.join("skills/new/SKILL.md").exists());

            let outcome = reconcile(&consumer, &ScopePolicy::default());
            assert_eq!(outcome.status, "full-checkout", "{outcome:?}");
            assert_eq!(outcome.added_skills, vec!["skills/new"]);
            assert!(consumer.join("train.py").is_file());
            assert!(consumer.join("skills/new/SKILL.md").is_file());
            assert!(consumer
                .join(".git/skillhub-legacy-prompt-sparse.backup")
                .is_file());
            assert!(!git_bool_config("git", &consumer, "core.sparseCheckout"));
            assert!(reconcile_repository(
                "git",
                &consumer,
                "prompt--fixture",
                &ScopePolicy::default(),
                &SourceImportControl::detached("again")
            )
            .is_none());
        }

        #[test]
        fn legacy_prompt_migration_preserves_local_and_untracked_changes() {
            if !git_available() {
                return;
            }
            let fixture = Fixture::new("legacy-local");
            write(&fixture.upstream.join("README.md"), "prompt");
            write(&fixture.upstream.join("train.py"), "upstream code");
            fixture.commit("initial prompt");
            let consumer = fixture.legacy_prompt();
            write(&consumer.join("README.md"), "my notes");
            let outcome = reconcile(&consumer, &ScopePolicy::default());
            assert_eq!(outcome.status, "local-conflict");
            assert_eq!(
                fs::read_to_string(consumer.join("README.md")).unwrap(),
                "my notes"
            );
            assert!(!consumer.join("train.py").exists());
            git(&consumer, &["restore", "README.md"]);
            write(&consumer.join("train.py"), "my local program");
            let outcome = reconcile(&consumer, &ScopePolicy::default());
            assert_eq!(outcome.status, "local-conflict");
            assert_eq!(
                fs::read_to_string(consumer.join("train.py")).unwrap(),
                "my local program"
            );
            assert!(git_bool_config("git", &consumer, "core.sparseCheckout"));
        }

        #[test]
        fn legacy_prompt_migration_leaves_custom_explicit_and_unmanaged_scopes() {
            if !git_available() {
                return;
            }
            let fixture = Fixture::new("legacy-policy");
            write(&fixture.upstream.join("README.md"), "prompt");
            write(&fixture.upstream.join("train.py"), "code");
            fixture.commit("initial prompt");
            let consumer = fixture.legacy_prompt();
            let control = SourceImportControl::detached("legacy-policy");
            let explicit = ScopePolicy {
                explicit_paths: Some(vec![]),
            };
            assert!(
                reconcile_repository("git", &consumer, "prompt--fixture", &explicit, &control)
                    .is_none()
            );
            git(
                &consumer,
                &["sparse-checkout", "set", "--no-cone", "/README.md"],
            );
            assert!(reconcile_repository(
                "git",
                &consumer,
                "prompt--fixture",
                &ScopePolicy::default(),
                &control
            )
            .is_none());
            git(&consumer, &["sparse-checkout", "set", "--no-cone", "/*.md"]);
            fs::remove_file(consumer.join(crate::MANAGED_SOURCE_METADATA_FILE)).unwrap();
            assert!(reconcile_repository(
                "git",
                &consumer,
                "prompt--fixture",
                &ScopePolicy::default(),
                &control
            )
            .is_none());
            assert!(!consumer.join("train.py").exists());
        }

        #[test]
        fn legacy_prompt_migration_rejects_origin_mismatch() {
            if !git_available() {
                return;
            }
            let fixture = Fixture::new("legacy-identity");
            write(&fixture.upstream.join("README.md"), "prompt");
            write(&fixture.upstream.join("train.py"), "code");
            fixture.commit("initial prompt");
            let consumer = fixture.legacy_prompt();
            git(
                &consumer,
                &[
                    "remote",
                    "set-url",
                    "origin",
                    "https://github.com/other/prompt.git",
                ],
            );
            let outcome = reconcile(&consumer, &ScopePolicy::default());
            assert_eq!(outcome.status, "failed");
            assert!(!consumer.join("train.py").exists());
        }

        #[test]
        fn legacy_prompt_migration_checks_size_before_checkout() {
            if !git_available() {
                return;
            }
            let fixture = Fixture::new("legacy-size");
            write(&fixture.upstream.join("README.md"), "prompt");
            fs::write(
                fixture.upstream.join("large.bin"),
                vec![0; GITHUB_FALLBACK_MAX_FILE_BYTES as usize + 1],
            )
            .unwrap();
            fixture.commit("oversized repository");
            let consumer = fixture.legacy_prompt();
            let outcome = reconcile(&consumer, &ScopePolicy::default());
            assert_eq!(outcome.status, "failed", "{outcome:?}");
            assert!(outcome.detail.contains("16 MB"));
            assert!(!consumer.join("large.bin").exists());
            assert!(git_bool_config("git", &consumer, "core.sparseCheckout"));
        }

        #[test]
        fn update_materializes_sibling_top_level_and_unicode_skills() {
            if !git_available() {
                return;
            }
            let fixture = Fixture::new("add");
            write(&fixture.upstream.join("README.md"), "root");
            write(
                &fixture.upstream.join("skills/first/SKILL.md"),
                &skill("first"),
            );
            write(
                &fixture.upstream.join("docs/big.md"),
                "not part of any Skill",
            );
            fixture.commit("initial");
            let consumer = fixture.import("owner--repo");
            assert!(consumer.join("skills/first/SKILL.md").is_file());
            assert!(!consumer.join("docs/big.md").exists());

            write(
                &fixture.upstream.join("skills/second/SKILL.md"),
                &skill("second"),
            );
            write(
                &fixture.upstream.join("skills/second/scripts/run.py"),
                "print(1)",
            );
            write(
                &fixture.upstream.join("extras/third/SKILL.md"),
                &skill("third"),
            );
            write(
                &fixture.upstream.join("skills/中文 技能/SKILL.md"),
                &skill("chinese"),
            );
            fixture.commit("add skills");
            fixture.pull(&consumer);

            // The original defect: identical HEADs, but the new folder is missing.
            assert_eq!(head(&consumer), head(&fixture.upstream));
            assert!(!consumer.join("skills/second/SKILL.md").exists());

            let outcome = reconcile(&consumer, &ScopePolicy::default());
            assert_eq!(outcome.status, "updated", "{outcome:?}");
            assert_eq!(
                outcome.added_skills,
                vec![
                    "extras/third".to_string(),
                    "skills/second".to_string(),
                    "skills/中文 技能".to_string()
                ]
            );
            assert!(consumer.join("skills/second/SKILL.md").is_file());
            assert!(consumer.join("skills/second/scripts/run.py").is_file());
            assert!(consumer.join("extras/third/SKILL.md").is_file());
            assert!(consumer.join("skills/中文 技能/SKILL.md").is_file());
            assert!(
                !consumer.join("docs/big.md").exists(),
                "scope must stay narrow"
            );
            assert!(consumer.join(".git").join(SCOPE_MARKER_FILE).is_file());

            // Idempotent: a second pass changes nothing.
            let again = reconcile(&consumer, &ScopePolicy::default());
            assert_eq!(again.status, "unchanged", "{again:?}");
        }

        #[test]
        fn rename_and_delete_drop_stale_patterns_and_keep_the_rest() {
            if !git_available() {
                return;
            }
            let fixture = Fixture::new("rename");
            write(
                &fixture.upstream.join("skills/old-name/SKILL.md"),
                &skill("old"),
            );
            write(
                &fixture.upstream.join("skills/doomed/SKILL.md"),
                &skill("doomed"),
            );
            write(
                &fixture.upstream.join("skills/stays/SKILL.md"),
                &skill("stays"),
            );
            fixture.commit("initial");
            let consumer = fixture.import("owner--rename");

            git(
                &fixture.upstream,
                &["mv", "skills/old-name", "skills/new-name"],
            );
            fs::remove_dir_all(fixture.upstream.join("skills/doomed")).unwrap();
            fixture.commit("rename and delete");
            fixture.pull(&consumer);
            assert!(!consumer.join("skills/doomed").exists());

            let outcome = reconcile(&consumer, &ScopePolicy::default());
            assert_eq!(outcome.status, "updated", "{outcome:?}");
            assert_eq!(outcome.added_skills, vec!["skills/new-name".to_string()]);
            assert_eq!(
                outcome.removed_paths,
                vec!["skills/doomed".to_string(), "skills/old-name".to_string()]
            );
            assert!(consumer.join("skills/new-name/SKILL.md").is_file());
            assert!(consumer.join("skills/stays/SKILL.md").is_file());
            let patterns = current_cone_patterns("git", &consumer).unwrap();
            assert!(!patterns.contains("skills/old-name"));
            assert!(!patterns.contains("skills/doomed"));
        }

        #[test]
        fn import_and_update_both_complete_linked_dependencies() {
            if !git_available() {
                return;
            }
            let fixture = Fixture::new("deps");
            write(
                &fixture.upstream.join("skills/alpha/SKILL.md"),
                &format!(
                    "{}See [contract](../shared/contract.md).\n\
                     Browse [all skills](../README.md) or [the index](../).\n",
                    skill("alpha")
                ),
            );
            write(&fixture.upstream.join("skills/README.md"), "index");
            write(
                &fixture.upstream.join("skills/shared/contract.md"),
                "contract",
            );
            write(
                &fixture.upstream.join("skills/unrelated/notes.md"),
                "unrelated",
            );
            fixture.commit("initial");
            let consumer = fixture.import("owner--deps");
            assert!(
                consumer.join("skills/shared/contract.md").is_file(),
                "import must include linked shared folders"
            );
            assert!(!consumer.join("skills/unrelated/notes.md").exists());

            write(
                &fixture.upstream.join("skills/beta/SKILL.md"),
                &format!("{}Run `../../tools/helper/run.py`.\n", skill("beta")),
            );
            write(
                &fixture.upstream.join("tools/helper/run.py"),
                "print('helper')",
            );
            fixture.commit("beta with helper");
            fixture.pull(&consumer);

            let outcome = reconcile(&consumer, &ScopePolicy::default());
            assert_eq!(outcome.status, "updated", "{outcome:?}");
            assert_eq!(outcome.added_skills, vec!["skills/beta".to_string()]);
            assert_eq!(outcome.added_dependencies, vec!["tools/helper".to_string()]);
            assert!(consumer.join("tools/helper/run.py").is_file());
            assert!(!consumer.join("skills/unrelated/notes.md").exists());
        }

        #[test]
        fn root_skill_switches_to_a_bounded_full_checkout() {
            if !git_available() {
                return;
            }
            let fixture = Fixture::new("root");
            write(
                &fixture.upstream.join("skills/first/SKILL.md"),
                &skill("first"),
            );
            write(&fixture.upstream.join("lib/helper.py"), "print('lib')");
            fixture.commit("initial");
            let consumer = fixture.import("owner--root");
            assert!(!consumer.join("lib/helper.py").exists());

            write(&fixture.upstream.join("SKILL.md"), &skill("whole-repo"));
            fixture.commit("root skill");
            fixture.pull(&consumer);
            let outcome = reconcile(&consumer, &ScopePolicy::default());
            assert_eq!(outcome.status, "full-checkout", "{outcome:?}");
            assert!(consumer.join("lib/helper.py").is_file());
            assert!(consumer.join("SKILL.md").is_file());
        }

        #[test]
        fn explicit_selection_reports_new_skills_without_enabling_them() {
            if !git_available() {
                return;
            }
            let fixture = Fixture::new("explicit");
            write(
                &fixture.upstream.join("skills/chosen/SKILL.md"),
                &skill("chosen"),
            );
            fixture.commit("initial");
            let consumer = fixture.import("owner--explicit");
            write(
                &fixture.upstream.join("skills/new-one/SKILL.md"),
                &skill("new-one"),
            );
            fixture.commit("new skill");
            fixture.pull(&consumer);

            let policy = ScopePolicy {
                explicit_paths: Some(vec!["skills/chosen".to_string()]),
            };
            let outcome = reconcile(&consumer, &policy);
            assert_eq!(outcome.status, "discovered", "{outcome:?}");
            assert_eq!(
                outcome.discovered_skills,
                vec!["skills/new-one".to_string()]
            );
            assert!(!consumer.join("skills/new-one").exists());
            assert!(!outcome.changed_files());
        }

        #[test]
        fn local_edits_survive_and_conflicting_untracked_files_block_safely() {
            if !git_available() {
                return;
            }
            let fixture = Fixture::new("local");
            write(
                &fixture.upstream.join("skills/first/SKILL.md"),
                &skill("first"),
            );
            fixture.commit("initial");
            let consumer = fixture.import("owner--local");
            write(
                &fixture.upstream.join("skills/second/SKILL.md"),
                &skill("second"),
            );
            write(
                &fixture.upstream.join("skills/third/SKILL.md"),
                &skill("third"),
            );
            fixture.commit("two more");
            fixture.pull(&consumer);

            // A tracked edit stays exactly as the user left it.
            let edited = consumer.join("skills/first/SKILL.md");
            fs::write(&edited, "my local edit").unwrap();
            // An untracked user file where upstream now has a tracked file.
            write(&consumer.join("skills/third/SKILL.md"), "user draft");

            let outcome = reconcile(&consumer, &ScopePolicy::default());
            // Git never overwrites the existing file: it keeps the user's
            // version and the report names it instead of claiming a clean update.
            assert_eq!(outcome.status, "updated", "{outcome:?}");
            assert_eq!(
                outcome.kept_local_paths,
                vec!["skills/third/SKILL.md".to_string()]
            );
            assert!(!outcome.detail.is_empty());
            assert!(consumer.join("skills/second/SKILL.md").is_file());
            assert_eq!(fs::read_to_string(&edited).unwrap(), "my local edit");
            assert_eq!(
                fs::read_to_string(consumer.join("skills/third/SKILL.md")).unwrap(),
                "user draft"
            );
            // The kept draft now counts as a local change, so a later pull is
            // protected by the existing dirty-tree guard.
            let status = git(&consumer, &["status", "--porcelain"]);
            assert!(String::from_utf8_lossy(&status.stdout).contains("skills/third/SKILL.md"));
        }

        #[test]
        fn offline_source_fails_alone_and_recovers_on_the_next_sync() {
            if !git_available() {
                return;
            }
            let fixture = Fixture::new("offline");
            write(
                &fixture.upstream.join("skills/first/SKILL.md"),
                &skill("first"),
            );
            fixture.commit("initial");
            let offline = fixture.import("owner--offline");
            let online = fixture.import("owner--online");
            write(
                &fixture.upstream.join("skills/second/SKILL.md"),
                &skill("second"),
            );
            fixture.commit("second");
            fixture.pull(&offline);
            fixture.pull(&online);

            // The promisor remote disappears for one source only.
            git(
                &offline,
                &[
                    "remote",
                    "set-url",
                    "origin",
                    "file:///Z:/skillhub-unreachable-remote",
                ],
            );
            let before = current_cone_patterns("git", &offline).unwrap();
            let report = reconcile_sources("git", &fixture.sources, None, Duration::from_secs(120));
            let status = |folder: &str| {
                report
                    .sources
                    .iter()
                    .find(|outcome| outcome.folder == folder)
                    .map(|outcome| outcome.status.clone())
                    .unwrap_or_default()
            };
            assert_eq!(status("owner--online"), "updated");
            assert_eq!(status("owner--offline"), "network-failed", "{report:?}");
            assert!(report.changed_files());
            assert!(online.join("skills/second/SKILL.md").is_file());
            assert!(!offline.join("skills/second").exists());
            assert_eq!(current_cone_patterns("git", &offline).unwrap(), before);
            assert!(offline.join("skills/first/SKILL.md").is_file());

            let url = fixture.upstream_url();
            git(&offline, &["remote", "set-url", "origin", &url]);
            let outcome = reconcile(&offline, &ScopePolicy::default());
            assert_eq!(outcome.status, "updated", "{outcome:?}");
            assert!(offline.join("skills/second/SKILL.md").is_file());
        }

        #[test]
        fn exhausted_budget_defers_instead_of_claiming_completion() {
            if !git_available() {
                return;
            }
            let fixture = Fixture::new("budget");
            write(
                &fixture.upstream.join("skills/first/SKILL.md"),
                &skill("first"),
            );
            fixture.commit("initial");
            fixture.import("owner--budget");
            let report = reconcile_sources("git", &fixture.sources, None, Duration::ZERO);
            assert_eq!(report.sources.len(), 1);
            assert_eq!(report.sources[0].status, "deferred");
            assert!(!report.changed_files());
        }

        /// Read-only audit of a real sources folder: prints what a sync would
        /// add without running any write. Run with
        /// `AI_SKILLHUB_SCOPE_AUDIT_DIR=<sources> cargo test --lib scope_audit -- --ignored --nocapture`.
        #[test]
        #[ignore = "reads a real user sources folder; run manually"]
        fn scope_audit_of_real_sources_is_read_only() {
            let Ok(dir) = std::env::var("AI_SKILLHUB_SCOPE_AUDIT_DIR") else {
                return;
            };
            let control = SourceImportControl::detached("scope-audit");
            let mut entries = fs::read_dir(&dir)
                .unwrap()
                .flatten()
                .map(|entry| entry.path())
                .collect::<Vec<_>>();
            entries.sort();
            for repo in entries {
                if !repo.join(".git").is_dir()
                    || !git_bool_config("git", &repo, "core.sparseCheckout")
                    || !git_bool_config("git", &repo, "core.sparseCheckoutCone")
                {
                    continue;
                }
                let output = read_head_tree_output("git", &repo, &control).unwrap();
                let tree = HeadTree::from_ls_tree_z(&output.stdout);
                let current = current_cone_patterns("git", &repo).unwrap();
                let roots = tree
                    .skill_roots()
                    .into_iter()
                    .filter(|root| !root.is_empty())
                    .collect::<Vec<_>>();
                let missing = roots
                    .iter()
                    .filter(|root| !cone_covers(&current, root))
                    .cloned()
                    .collect::<Vec<_>>();
                let stale = current
                    .iter()
                    .filter(|pattern| !tree.contains_dir(pattern))
                    .cloned()
                    .collect::<Vec<_>>();
                let on_disk = roots
                    .iter()
                    .filter(|root| cone_covers(&current, root))
                    .cloned()
                    .collect::<Vec<_>>();
                let deps = dependency_dirs(&repo, &tree, &current, &on_disk);
                println!(
                    "{} | root_skill={} roots={} missing={:?} stale={:?} deps={:?}",
                    repo.file_name().unwrap().to_string_lossy(),
                    tree.has_root_skill(),
                    roots.len(),
                    missing,
                    stale,
                    deps
                );
            }
        }

        #[test]
        fn report_round_trips_through_the_state_file() {
            let root = std::env::temp_dir().join(format!(
                "skillhub-sparse-report-{}",
                crate::unix_timestamp_string()
            ));
            let mut outcome = SparseScopeOutcome::new("owner--repo", "updated", "");
            outcome.added_skills = vec!["skills/新 技能".to_string()];
            let report = SparseScopeReport {
                schema_version: 1,
                generated_at: "now".to_string(),
                sources: vec![outcome.clone()],
            };
            write_report(&root, &report).unwrap();
            let read = read_report(&root).unwrap();
            assert_eq!(read.sources, vec![outcome]);
            let _ = fs::remove_dir_all(root);
        }
    }
}
