//! v3.3 one-box source input: parsing (skills contract §4.7), probe, install
//! and the adopt flow live here. Parsing is pure and never touches the network.

use crate::skillhub_error::SkillHubError;
use serde::Serialize;
use std::path::{Path, PathBuf};

pub(crate) const MAX_INPUT_CHARS: usize = 2048;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ParsedGithubSource {
    pub owner: String,
    pub repo: String,
    #[serde(rename = "ref")]
    pub git_ref: String,
    pub subpath: String,
    pub clone_url: String,
    pub web_url: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ParsedSkillSource {
    pub input: String,
    /// github | local-folder | zip | mcp-config | unknown
    pub kind: String,
    /// skills | mcp | invalid
    pub route_to: String,
    pub display: String,
    pub github: Option<ParsedGithubSource>,
    pub local_path: String,
    pub error: Option<SkillHubError>,
}

impl ParsedSkillSource {
    fn invalid(input: &str, kind: &str, error: SkillHubError) -> Self {
        Self {
            input: input.to_string(),
            kind: kind.to_string(),
            route_to: "invalid".to_string(),
            display: String::new(),
            github: None,
            local_path: String::new(),
            error: Some(error),
        }
    }
}

fn strip_quotes(value: &str) -> &str {
    let value = value.trim();
    for quote in ['"', '\'', '`'] {
        if value.len() >= 2 && value.starts_with(quote) && value.ends_with(quote) {
            return value[1..value.len() - 1].trim();
        }
    }
    value
}

/// Text that clearly is an MCP server configuration (JSON or Codex TOML).
pub(crate) fn looks_like_mcp_config(text: &str) -> bool {
    if text.contains("[mcp_servers.") || text.contains("[mcp_servers]") {
        return true;
    }
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
        return false;
    };
    let Some(object) = value.as_object() else {
        return false;
    };
    if object.contains_key("mcpServers") || object.contains_key("servers") {
        return true;
    }
    if object.contains_key("command") || object.contains_key("url") {
        return true;
    }
    !object.is_empty()
        && object.values().all(|server| {
            server
                .as_object()
                .is_some_and(|server| server.contains_key("command") || server.contains_key("url"))
        })
}

fn valid_owner(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 100
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

fn valid_repo(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 100
        && value != "."
        && value != ".."
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

/// Decoded, validated POSIX subpath. Rejects `..`, `.`, empty segments,
/// backslashes and drive letters; percent-decoding never panics (bug #21).
pub(crate) fn safe_subpath(raw: &str) -> Result<String, SkillHubError> {
    let decoded = crate::sparse_scope::percent_decode(raw.trim_matches('/'));
    if decoded.is_empty() {
        return Ok(String::new());
    }
    let unsafe_path = || {
        SkillHubError::code("GITHUB_SUBPATH_NOT_FOUND")
            .with_detail("路径里有不安全的片段（.. 或盘符），已拒绝。")
    };
    if decoded.contains('\\') || decoded.contains('\0') {
        return Err(unsafe_path());
    }
    let segments = decoded.split('/').collect::<Vec<_>>();
    for segment in &segments {
        if segment.is_empty()
            || *segment == "."
            || *segment == ".."
            || segment.contains(':')
            || segment.chars().any(char::is_control)
        {
            return Err(unsafe_path());
        }
    }
    Ok(segments.join("/"))
}

fn github_result(
    input: &str,
    owner: &str,
    repo: &str,
    git_ref: &str,
    subpath: &str,
) -> ParsedSkillSource {
    let repo = repo.strip_suffix(".git").unwrap_or(repo);
    if !valid_owner(owner) || !valid_repo(repo) {
        return ParsedSkillSource::invalid(
            input,
            "unknown",
            SkillHubError::code("INPUT_UNRECOGNIZED"),
        );
    }
    let subpath = match safe_subpath(subpath) {
        Ok(subpath) => subpath,
        Err(error) => return ParsedSkillSource::invalid(input, "github", error),
    };
    let git_ref = crate::sparse_scope::percent_decode(git_ref);
    if git_ref.contains("..")
        || git_ref
            .chars()
            .any(|c| c.is_control() || c == ' ' || c == '\\')
    {
        return ParsedSkillSource::invalid(
            input,
            "github",
            SkillHubError::code("GITHUB_REF_NOT_FOUND"),
        );
    }
    let mut web_url = format!("https://github.com/{owner}/{repo}");
    if !git_ref.is_empty() {
        web_url.push_str(&format!("/tree/{git_ref}"));
        if !subpath.is_empty() {
            web_url.push_str(&format!("/{subpath}"));
        }
    }
    let display = if subpath.is_empty() {
        format!("{owner}/{repo}")
    } else {
        format!("{owner}/{repo} · {subpath}")
    };
    ParsedSkillSource {
        input: input.to_string(),
        kind: "github".to_string(),
        route_to: "skills".to_string(),
        display,
        github: Some(ParsedGithubSource {
            owner: owner.to_string(),
            repo: repo.to_string(),
            git_ref,
            subpath,
            clone_url: format!("https://github.com/{owner}/{repo}.git"),
            web_url,
        }),
        local_path: String::new(),
        error: None,
    }
}

/// `github.com/...` path segments after the host, with query and fragment cut.
fn github_segments(rest: &str) -> Vec<&str> {
    let rest = rest.split(['?', '#']).next().unwrap_or_default();
    rest.split('/').filter(|part| !part.is_empty()).collect()
}

fn parse_github_url(input: &str, rest: &str) -> ParsedSkillSource {
    let segments = github_segments(rest);
    if segments.len() < 2 {
        return ParsedSkillSource::invalid(
            input,
            "unknown",
            SkillHubError::code("INPUT_UNRECOGNIZED"),
        );
    }
    let (owner, repo) = (segments[0], segments[1]);
    match segments.get(2).copied() {
        None => github_result(input, owner, repo, "", ""),
        Some("tree") if segments.len() >= 4 => {
            github_result(input, owner, repo, segments[3], &segments[4..].join("/"))
        }
        Some("blob") if segments.len() >= 5 => {
            let file = segments[segments.len() - 1];
            let folder = if file.eq_ignore_ascii_case("SKILL.md") {
                segments[4..segments.len() - 1].join("/")
            } else {
                segments[4..].join("/")
            };
            github_result(input, owner, repo, segments[3], &folder)
        }
        _ => github_result(input, owner, repo, "", ""),
    }
}

fn is_windows_absolute(value: &str) -> bool {
    let bytes = value.as_bytes();
    (bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/'))
        || value.starts_with("\\\\")
}

fn home_dir() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_default()
}

fn local_candidate(text: &str) -> Option<PathBuf> {
    if let Some(rest) = text
        .strip_prefix("file:///")
        .or_else(|| text.strip_prefix("file://"))
    {
        let decoded = crate::sparse_scope::percent_decode(rest);
        return Some(PathBuf::from(decoded.replace('/', "\\")));
    }
    if let Some(rest) = text.strip_prefix("~\\").or_else(|| text.strip_prefix("~/")) {
        return Some(home_dir().join(rest));
    }
    if is_windows_absolute(text) || (cfg!(not(windows)) && text.starts_with('/')) {
        return Some(PathBuf::from(text));
    }
    None
}

/// §4.7. At most one `fs::metadata` call; never touches the network.
pub(crate) fn parse_skill_source_input(raw: &str) -> ParsedSkillSource {
    let input = raw.to_string();
    if raw.chars().count() > MAX_INPUT_CHARS {
        return ParsedSkillSource::invalid(
            &input,
            "unknown",
            SkillHubError::code("INPUT_TOO_LONG"),
        );
    }
    let text = strip_quotes(raw);
    if text.is_empty() {
        return ParsedSkillSource::invalid(&input, "unknown", SkillHubError::code("INPUT_EMPTY"));
    }
    if looks_like_mcp_config(text) {
        return ParsedSkillSource {
            input,
            kind: "mcp-config".to_string(),
            route_to: "mcp".to_string(),
            display: "MCP 配置".to_string(),
            github: None,
            local_path: String::new(),
            error: None,
        };
    }
    if let Some(path) = local_candidate(text) {
        let display = path.display().to_string();
        let lower = display.to_ascii_lowercase();
        let is_package = lower.ends_with(".zip") || lower.ends_with(".skill");
        return match std::fs::metadata(&path) {
            Ok(metadata) if metadata.is_dir() => ParsedSkillSource {
                input,
                kind: "local-folder".to_string(),
                route_to: "skills".to_string(),
                display: display.clone(),
                github: None,
                local_path: display,
                error: None,
            },
            Ok(metadata) if metadata.is_file() && is_package => ParsedSkillSource {
                input,
                kind: "zip".to_string(),
                route_to: "skills".to_string(),
                display: display.clone(),
                github: None,
                local_path: display,
                error: None,
            },
            Ok(_) => ParsedSkillSource::invalid(
                &input,
                if is_package { "zip" } else { "local-folder" },
                SkillHubError::code(if is_package {
                    "ZIP_INVALID"
                } else {
                    "PATH_NOT_FOUND"
                })
                .with_path(display),
            ),
            Err(_) => ParsedSkillSource::invalid(
                &input,
                if is_package { "zip" } else { "local-folder" },
                SkillHubError::code("PATH_NOT_FOUND").with_path(display),
            ),
        };
    }
    let lower = text.to_ascii_lowercase();
    for prefix in [
        "https://github.com/",
        "http://github.com/",
        "https://www.github.com/",
        "http://www.github.com/",
        "github.com/",
        "www.github.com/",
        "ssh://git@github.com/",
        "git://github.com/",
    ] {
        if lower.starts_with(prefix) {
            return parse_github_url(&input, &text[prefix.len()..]);
        }
    }
    if let Some(rest) = text.strip_prefix("git@github.com:") {
        return parse_github_url(&input, rest);
    }
    if lower.starts_with("http://")
        || lower.starts_with("https://")
        || lower.contains("gitlab")
        || lower.contains("gitee")
        || lower.contains("bitbucket")
    {
        return ParsedSkillSource::invalid(
            &input,
            "unknown",
            SkillHubError::code("INPUT_UNRECOGNIZED"),
        );
    }
    let segments = text.split('/').collect::<Vec<_>>();
    if segments.len() == 2
        && !text.contains('\\')
        && valid_owner(segments[0])
        && valid_repo(segments[1])
        && segments[0] != "."
    {
        return github_result(&input, segments[0], segments[1], "", "");
    }
    if text.starts_with("./")
        || text.starts_with(".\\")
        || text.starts_with("../")
        || text.contains('\\')
        || segments.len() >= 3
    {
        return ParsedSkillSource::invalid(
            &input,
            "unknown",
            SkillHubError::code("PATH_NOT_ABSOLUTE"),
        );
    }
    ParsedSkillSource::invalid(&input, "unknown", SkillHubError::code("INPUT_UNRECOGNIZED"))
}

/// Paths of `.zip`/`.skill` files and existing folders from a native drop,
/// at most five (§3.9).
pub(crate) fn accepted_drop_paths(paths: &[PathBuf]) -> Vec<String> {
    paths
        .iter()
        .filter(|path| {
            path.is_dir()
                || (path.is_file()
                    && path
                        .extension()
                        .and_then(|extension| extension.to_str())
                        .is_some_and(|extension| {
                            extension.eq_ignore_ascii_case("zip")
                                || extension.eq_ignore_ascii_case("skill")
                        }))
        })
        .take(5)
        .map(|path| path.display().to_string())
        .collect()
}

pub(crate) fn path_is_inside(path: &Path, root: &Path) -> bool {
    match (path.canonicalize(), root.canonicalize()) {
        (Ok(path), Ok(root)) => path.starts_with(root),
        _ => false,
    }
}

// ---------------------------------------------------------------------------
// Probe, install, adopt, per-tool inventory and library documents
// ---------------------------------------------------------------------------

use crate::skill_delivery::{self, iso_from_seconds, Evidence};
use rusqlite::{params, Connection, OptionalExtension};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// A probe's staging copy lives for 30 minutes or until discarded.
pub(crate) const PROBE_TTL: Duration = Duration::from_secs(30 * 60);
const MAX_PROBE_SKILLS: usize = 2000;
const MAX_PROBE_FILE_BYTES: u64 = 96 * 1024;
const MAX_DOCUMENT_BYTES: u64 = 256 * 1024;
const MAX_DOCUMENT_FILES: usize = 200;

fn sha256_file(path: &Path) -> String {
    fs::read(path)
        .map(|bytes| format!("{:x}", Sha256::digest(&bytes)))
        .unwrap_or_default()
}

fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default()
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProbeSkillNode {
    pub path: String,
    pub name: String,
    pub description: String,
    pub valid: bool,
    pub invalid_reason: String,
    pub in_library: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProbeSkillGroup {
    pub group_id: String,
    pub title: String,
    pub parent: Option<ProbeSkillNode>,
    pub children: Vec<ProbeSkillNode>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProbeSecurity {
    pub status: String,
    pub scanned_files: usize,
    pub finding_count: usize,
    pub findings: Vec<crate::security_scan::SourceSecurityFinding>,
    pub plain_summary: String,
    pub can_add_to_library: bool,
    pub can_sync_to_agents: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProbeAgentChip {
    pub agent_id: String,
    pub name: String,
    pub preselected: bool,
    pub disabled: bool,
    pub disabled_reason: String,
    pub experimental: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProbeDuplicate {
    pub source_id: String,
    pub name: String,
    pub relation: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProbePromptDoc {
    pub relative_path: String,
    pub title: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProbeMcpConfig {
    pub relative_path: String,
    pub format: String,
    pub server_names: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SkillSourceProbe {
    pub probe_id: String,
    pub operation_id: String,
    pub parsed: ParsedSkillSource,
    pub display_name: String,
    pub owner: String,
    pub source_type: String,
    pub skill_groups: Vec<ProbeSkillGroup>,
    pub skill_count: usize,
    pub prompt_docs: Vec<ProbePromptDoc>,
    pub mcp_configs: Vec<ProbeMcpConfig>,
    pub security: ProbeSecurity,
    pub agent_chips: Vec<ProbeAgentChip>,
    pub duplicate: Option<ProbeDuplicate>,
    pub download_method: String,
    pub expires_at: String,
    pub warnings: Vec<String>,
}

/// What install needs from a probe. Kept in memory (a few KB per probe) and
/// dropped on install, discard or expiry; the staging copy goes with it.
#[derive(Debug, Clone)]
pub(crate) struct ProbeRecord {
    pub probe: SkillSourceProbe,
    pub import_kind: String,
    pub staged_path: Option<PathBuf>,
    /// Root inside the staged tree that the listed skill paths are relative to.
    pub scope_root: String,
    pub created: Instant,
}

static PROBES: OnceLock<Mutex<HashMap<String, ProbeRecord>>> = OnceLock::new();

fn probes() -> &'static Mutex<HashMap<String, ProbeRecord>> {
    PROBES.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Drops expired probes and their staging copies.
pub(crate) fn prune_expired_probes() {
    let expired = probes()
        .lock()
        .map(|mut map| {
            let ids = map
                .iter()
                .filter(|(_, record)| record.created.elapsed() >= PROBE_TTL)
                .map(|(id, _)| id.clone())
                .collect::<Vec<_>>();
            ids.into_iter()
                .filter_map(|id| map.remove(&id))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    for record in expired {
        remove_staging(&record);
    }
}

fn remove_staging(record: &ProbeRecord) {
    if let Some(path) = &record.staged_path {
        let _ = fs::remove_dir_all(path);
    }
}

pub(crate) fn store_probe(record: ProbeRecord) {
    prune_expired_probes();
    if let Ok(mut map) = probes().lock() {
        map.insert(record.probe.probe_id.clone(), record);
    }
}

pub(crate) fn take_probe(probe_id: &str) -> Option<ProbeRecord> {
    probes()
        .lock()
        .ok()
        .and_then(|mut map| map.remove(probe_id))
}

pub(crate) fn peek_probe(probe_id: &str) -> Option<ProbeRecord> {
    prune_expired_probes();
    probes()
        .lock()
        .ok()
        .and_then(|map| map.get(probe_id).cloned())
}

pub(crate) fn discard_probe(probe_id: &str) -> bool {
    match take_probe(probe_id) {
        Some(record) => {
            remove_staging(&record);
            true
        }
        None => false,
    }
}

pub(crate) fn probe_expiry_label() -> String {
    iso_from_seconds(now_seconds() + PROBE_TTL.as_secs())
}

/// Security as the install flow sees it (I-5). A structural block (limits,
/// links, path escapes) can never be added; content findings can only be
/// added to the library and stay off.
pub(crate) fn probe_security(
    status: &str,
    scanned_files: usize,
    findings: &[crate::security_scan::SourceSecurityFinding],
    blocking_checks: &[String],
) -> ProbeSecurity {
    let structural = blocking_checks
        .iter()
        .any(|check| check.contains("limit exceeded") || check.contains("上限"))
        || findings
            .iter()
            .any(|finding| finding.category == "path-boundary");
    let status = match status {
        "passed" => "passed",
        "blocked" if structural => "blocked",
        "not-run" if structural => "blocked",
        "not-run" => "passed",
        _ => "review",
    };
    let finding_count = findings.len();
    let plain_summary = match status {
        "passed" => format!("检查了 {scanned_files} 个文件，没有发现需要注意的内容"),
        "review" => {
            format!("检查了 {scanned_files} 个文件，发现 {finding_count} 处需要注意（不会被执行）")
        }
        _ => "超出安全检查的范围（文件太多、太大或含有链接），不能添加".to_string(),
    };
    ProbeSecurity {
        status: status.to_string(),
        scanned_files,
        finding_count,
        findings: findings.iter().take(8).cloned().collect(),
        plain_summary,
        can_add_to_library: status != "blocked",
        can_sync_to_agents: status == "passed",
    }
}

/// Library skills by normalized name → set of SKILL.md content hashes.
pub(crate) fn library_skill_hashes(
    root: &Path,
    connection: &Connection,
) -> HashMap<String, BTreeSet<String>> {
    let mut map: HashMap<String, BTreeSet<String>> = HashMap::new();
    let Ok(mut statement) =
        connection.prepare("SELECT name, folder_name, relative_path FROM skills")
    else {
        return map;
    };
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map(|rows| rows.filter_map(Result::ok).collect::<Vec<_>>())
        .unwrap_or_default();
    for (name, folder, relative) in rows {
        let Some(dir) = library_skill_dir(root, &folder, &relative) else {
            continue;
        };
        let hash = sha256_file(&dir.join("SKILL.md"));
        if hash.is_empty() {
            continue;
        }
        for key in [
            crate::normalize_skill_lookup(&name),
            crate::normalize_skill_lookup(&folder),
        ] {
            if !key.is_empty() {
                map.entry(key).or_default().insert(hash.clone());
            }
        }
    }
    map
}

/// The managed folder of an indexed skill, if it still exists.
pub(crate) fn library_skill_dir(root: &Path, folder: &str, relative: &str) -> Option<PathBuf> {
    let normalized = relative.replace('/', "\\");
    let candidate = if let Some(rest) = normalized.strip_prefix("github_sources\\") {
        crate::managed_sources_dir(root).join(rest)
    } else {
        crate::active_skills_dir(root).join(folder)
    };
    candidate.join("SKILL.md").is_file().then_some(candidate)
}

/// Every skill directory under `scope` (relative POSIX paths), bounded.
pub(crate) fn enumerate_skill_dirs(scope: &Path) -> Vec<String> {
    let mut found = Vec::new();
    let mut stack = vec![(scope.to_path_buf(), 0usize)];
    let mut visited = 0usize;
    while let Some((dir, depth)) = stack.pop() {
        visited += 1;
        if visited > 20_000 || found.len() >= MAX_PROBE_SKILLS || depth > 12 {
            break;
        }
        if crate::external_skills::is_link(&dir) {
            continue;
        }
        if dir.join("SKILL.md").is_file() {
            let relative = dir
                .strip_prefix(scope)
                .unwrap_or(&dir)
                .to_string_lossy()
                .replace('\\', "/");
            found.push(relative);
        }
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if matches!(
                name.as_str(),
                ".git" | "node_modules" | "target" | ".skillhub-extracted" | "__pycache__"
            ) || name == crate::ROUTER_HUB_FOLDER
            {
                continue;
            }
            if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                stack.push((entry.path(), depth + 1));
            }
        }
    }
    found.sort();
    found
}

/// Groups skill directories for the preview: one group per parent folder; a
/// folder that ships its own umbrella `SKILL.md` becomes the group parent.
pub(crate) fn build_skill_groups(
    scope: &Path,
    paths: &[String],
    library: &HashMap<String, BTreeSet<String>>,
    fallback_title: &str,
) -> Vec<ProbeSkillGroup> {
    let node = |relative: &str| -> ProbeSkillNode {
        let dir = if relative.is_empty() {
            scope.to_path_buf()
        } else {
            scope.join(relative)
        };
        let manifest = dir.join("SKILL.md");
        let raw = fs::read_to_string(&manifest).unwrap_or_default();
        let (name, description) =
            skill_delivery::manifest_name_and_description(&raw).unwrap_or_default();
        let folder = relative.rsplit('/').next().unwrap_or(relative).to_string();
        let display = if name.trim().is_empty() {
            if folder.is_empty() {
                fallback_title.to_string()
            } else {
                folder
            }
        } else {
            name.clone()
        };
        let valid = !name.trim().is_empty() && !description.trim().is_empty();
        let hash = sha256_file(&manifest);
        let in_library = library
            .get(&crate::normalize_skill_lookup(&display))
            .is_some_and(|hashes| hashes.contains(&hash));
        ProbeSkillNode {
            path: relative.to_string(),
            name: display,
            description: description.chars().take(240).collect(),
            valid,
            invalid_reason: if valid {
                String::new()
            } else {
                "SKILL.md 缺少名称或简介".to_string()
            },
            in_library,
        }
    };
    let path_set = paths.iter().cloned().collect::<BTreeSet<_>>();
    let mut groups: BTreeMap<String, ProbeSkillGroup> = BTreeMap::new();
    for relative in paths {
        let parent = relative
            .rsplit_once('/')
            .map(|(parent, _)| parent.to_string())
            .unwrap_or_default();
        // A skill that is itself the parent folder of other skills is that
        // group's umbrella, not a child.
        if paths
            .iter()
            .any(|other| other != relative && other.starts_with(&format!("{relative}/")))
            || (relative.is_empty() && paths.len() > 1)
        {
            let group = groups
                .entry(relative.clone())
                .or_insert_with(|| ProbeSkillGroup {
                    group_id: if relative.is_empty() {
                        ".".to_string()
                    } else {
                        relative.clone()
                    },
                    title: String::new(),
                    parent: None,
                    children: Vec::new(),
                });
            group.parent = Some(node(relative));
            continue;
        }
        let group = groups
            .entry(parent.clone())
            .or_insert_with(|| ProbeSkillGroup {
                group_id: if parent.is_empty() {
                    ".".to_string()
                } else {
                    parent.clone()
                },
                title: String::new(),
                parent: None,
                children: Vec::new(),
            });
        if path_set.contains(&parent) && group.parent.is_none() {
            group.parent = Some(node(&parent));
        }
        group.children.push(node(relative));
    }
    groups
        .into_iter()
        .map(|(key, mut group)| {
            group.title = group
                .parent
                .as_ref()
                .map(|parent| parent.name.clone())
                .unwrap_or_else(|| {
                    if key.is_empty() {
                        fallback_title.to_string()
                    } else {
                        key.rsplit('/').next().unwrap_or(&key).to_string()
                    }
                });
            group
        })
        .collect()
}

/// Static MCP config detection (nothing is executed): JSON files whose top
/// level looks like a server map, and Codex TOML snippets.
pub(crate) fn detect_mcp_configs(scope: &Path) -> Vec<ProbeMcpConfig> {
    let mut configs = Vec::new();
    let Ok(entries) = fs::read_dir(scope) else {
        return configs;
    };
    for entry in entries.flatten().take(400) {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        let lower = name.to_ascii_lowercase();
        let is_json = lower.ends_with(".mcp.json") || lower == "mcp.json" || lower == ".mcp.json";
        let is_toml = lower.ends_with(".toml") && lower.contains("mcp");
        if !(is_json || is_toml) || !path.is_file() {
            continue;
        }
        if fs::metadata(&path)
            .map(|meta| meta.len())
            .unwrap_or(u64::MAX)
            > MAX_PROBE_FILE_BYTES
        {
            continue;
        }
        let Ok(text) = fs::read_to_string(&path) else {
            continue;
        };
        if !looks_like_mcp_config(&text) {
            continue;
        }
        let server_names = if is_json {
            serde_json::from_str::<serde_json::Value>(&text)
                .ok()
                .and_then(|value| {
                    value
                        .get("mcpServers")
                        .or_else(|| value.get("servers"))
                        .and_then(|servers| servers.as_object().cloned())
                        .or_else(|| value.as_object().cloned())
                })
                .map(|servers| servers.keys().take(50).cloned().collect())
                .unwrap_or_default()
        } else {
            text.lines()
                .filter_map(|line| {
                    line.trim()
                        .strip_prefix("[mcp_servers.")
                        .and_then(|rest| rest.strip_suffix(']'))
                        .map(|name| name.trim_matches('"').to_string())
                })
                .take(50)
                .collect()
        };
        configs.push(ProbeMcpConfig {
            relative_path: name,
            format: if is_json { "json" } else { "toml" }.to_string(),
            server_names,
        });
    }
    configs.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    configs
}

/// Prompt documents (titles only) when a source ships no skills.
pub(crate) fn detect_prompt_docs(scope: &Path) -> Vec<ProbePromptDoc> {
    let mut docs = Vec::new();
    let mut stack = vec![(scope.to_path_buf(), 0usize)];
    while let Some((dir, depth)) = stack.pop() {
        if docs.len() >= 50 || depth > 4 {
            continue;
        }
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten().take(500) {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') || name == "node_modules" {
                continue;
            }
            if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                stack.push((path, depth + 1));
            } else if name.to_ascii_lowercase().ends_with(".md")
                && !name.eq_ignore_ascii_case("README.md")
                && !name.eq_ignore_ascii_case("LICENSE.md")
                && !name.eq_ignore_ascii_case("CHANGELOG.md")
            {
                let title = fs::read_to_string(&path)
                    .ok()
                    .and_then(|text| {
                        text.lines()
                            .find_map(|line| line.trim().strip_prefix("# ").map(str::to_string))
                    })
                    .unwrap_or_else(|| name.trim_end_matches(".md").to_string());
                docs.push(ProbePromptDoc {
                    relative_path: path
                        .strip_prefix(scope)
                        .unwrap_or(&path)
                        .to_string_lossy()
                        .replace('\\', "/"),
                    title: title.chars().take(120).collect(),
                });
            }
        }
    }
    docs.sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    docs.truncate(50);
    docs
}

pub(crate) fn agent_chips(
    evidence: &Evidence,
    takeover: &BTreeMap<String, skill_delivery::TakeoverRow>,
    can_sync: bool,
) -> Vec<ProbeAgentChip> {
    skill_delivery::DELIVERABLE_AGENTS
        .iter()
        .filter(|agent| evidence.can_deliver(agent))
        .filter(|agent| {
            skill_delivery::agent_group(agent, evidence.real_shared)
                .iter()
                .any(|member| evidence.installed(member))
        })
        .filter_map(|agent| skill_delivery::agent_spec(agent))
        .map(|spec| {
            let taken_over = skill_delivery::takeover_enabled(takeover, spec.id);
            let (disabled, reason) = if !can_sync {
                (true, "需要先查看风险")
            } else if !taken_over {
                (true, "还没有接管")
            } else {
                (false, "")
            };
            ProbeAgentChip {
                agent_id: spec.id.to_string(),
                name: spec.name.to_string(),
                preselected: can_sync && taken_over && !spec.experimental,
                disabled,
                disabled_reason: reason.to_string(),
                experimental: spec.experimental,
            }
        })
        .collect()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProbeFileText {
    pub relative_path: String,
    pub text: String,
    pub truncated: bool,
}

/// Only files the probe itself listed (MCP configs and prompt docs).
pub(crate) fn read_probe_file(
    probe_id: &str,
    relative_path: &str,
) -> Result<ProbeFileText, SkillHubError> {
    let record = peek_probe(probe_id).ok_or_else(|| SkillHubError::code("PROBE_EXPIRED"))?;
    let listed = record
        .probe
        .mcp_configs
        .iter()
        .any(|config| config.relative_path == relative_path)
        || record
            .probe
            .prompt_docs
            .iter()
            .any(|doc| doc.relative_path == relative_path);
    let staged = record
        .staged_path
        .as_ref()
        .ok_or_else(|| SkillHubError::code("PATH_NOT_FOUND"))?;
    let scope = if record.scope_root.is_empty() {
        staged.clone()
    } else {
        staged.join(&record.scope_root)
    };
    let path = scope.join(relative_path);
    if !listed || !path_is_inside(&path, staged) || !path.is_file() {
        return Err(SkillHubError::code("PATH_NOT_FOUND").with_path(relative_path.to_string()));
    }
    let bytes = fs::read(&path).map_err(|_| SkillHubError::code("PATH_NOT_FOUND"))?;
    let truncated = bytes.len() as u64 > MAX_PROBE_FILE_BYTES;
    let bytes = &bytes[..bytes.len().min(MAX_PROBE_FILE_BYTES as usize)];
    Ok(ProbeFileText {
        relative_path: relative_path.to_string(),
        text: String::from_utf8_lossy(bytes).to_string(),
        truncated,
    })
}

// ---------------------------------------------------------------------------
// Adopt existing skills (S0-11)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AdoptLocation {
    pub agent_id: String,
    pub path: String,
    pub storage_kind: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AdoptCandidate {
    pub id: String,
    pub name: String,
    pub description: String,
    pub state: String,
    pub selected_by_default: bool,
    pub canonical_path: String,
    pub content_hash: String,
    pub agent_ids: Vec<String>,
    pub locations: Vec<AdoptLocation>,
    pub duplicate_of: String,
    pub managed_unit_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AdoptPreview {
    pub candidates: Vec<AdoptCandidate>,
    pub importable: usize,
    pub already_managed: usize,
    pub duplicates: usize,
    pub warnings: Vec<String>,
    pub truncated: bool,
    pub scanned_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AdoptItemResult {
    pub candidate_id: String,
    pub name: String,
    pub outcome: String,
    pub source_id: String,
    pub error: Option<SkillHubError>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AdoptReport {
    pub results: Vec<AdoptItemResult>,
    pub adopted: usize,
    pub library_only: usize,
    pub skipped: usize,
    pub failed: usize,
    pub job_id: Option<u64>,
    pub snapshot_stale: bool,
}

/// Maps the inventory roots to catalog agents (`codex-legacy` → codex).
fn adopt_agent_id(root_agent: &str) -> String {
    match root_agent {
        "codex-legacy" | "codex-custom" => "codex".to_string(),
        "workbuddy-ai" | "workbuddy-custom" => "workbuddy".to_string(),
        other => other.to_string(),
    }
}

/// Pure dedupe step, unit-tested: one candidate per canonical path; a later
/// canonical path with the same content is a `duplicate`; same name and hash
/// as a library skill is `already-managed`, same name other content is a
/// `name-clash`.
pub(crate) fn build_adopt_candidates(
    found: Vec<(String, String, String, String, String, String, bool)>,
    library: &HashMap<String, BTreeSet<String>>,
    hash_of: &dyn Fn(&str) -> String,
) -> Vec<AdoptCandidate> {
    // (agent, path, canonical, name, description, storage_kind, valid)
    let mut by_canonical: BTreeMap<String, AdoptCandidate> = BTreeMap::new();
    for (agent, path, canonical, name, description, storage, valid) in found {
        let key = canonical.to_lowercase();
        let entry = by_canonical.entry(key).or_insert_with(|| AdoptCandidate {
            id: crate::stable_id("adopt", &canonical.to_lowercase()),
            name: name.clone(),
            description: description.chars().take(240).collect(),
            state: if valid { "new" } else { "invalid-manifest" }.to_string(),
            selected_by_default: false,
            canonical_path: canonical.clone(),
            content_hash: hash_of(&canonical),
            agent_ids: Vec::new(),
            locations: Vec::new(),
            duplicate_of: String::new(),
            managed_unit_id: String::new(),
        });
        let agent = adopt_agent_id(&agent);
        if !entry.agent_ids.contains(&agent) {
            entry.agent_ids.push(agent.clone());
        }
        entry.locations.push(AdoptLocation {
            agent_id: agent,
            path,
            storage_kind: storage,
        });
    }
    let mut seen_hashes: HashMap<String, String> = HashMap::new();
    let mut candidates = by_canonical.into_values().collect::<Vec<_>>();
    candidates.sort_by(|left, right| {
        left.name
            .to_lowercase()
            .cmp(&right.name.to_lowercase())
            .then(left.canonical_path.cmp(&right.canonical_path))
    });
    for candidate in &mut candidates {
        if candidate.state != "new" {
            continue;
        }
        if candidate.content_hash.is_empty() {
            candidate.state = "unreadable".to_string();
            continue;
        }
        let key = crate::normalize_skill_lookup(&candidate.name);
        if let Some(hashes) = library.get(&key) {
            candidate.state = if hashes.contains(&candidate.content_hash) {
                "already-managed"
            } else {
                "name-clash"
            }
            .to_string();
            continue;
        }
        match seen_hashes.get(&candidate.content_hash) {
            Some(first) => {
                candidate.state = "duplicate".to_string();
                candidate.duplicate_of = first.clone();
            }
            None => {
                seen_hashes.insert(candidate.content_hash.clone(), candidate.id.clone());
            }
        }
    }
    for candidate in &mut candidates {
        candidate.selected_by_default = candidate.state == "new";
    }
    candidates
}

pub(crate) fn adopt_preview(
    root: &Path,
    connection: &Connection,
    project: Option<&Path>,
) -> Result<AdoptPreview, SkillHubError> {
    let home = crate::delivery_home_dir();
    let inventory = crate::external_skills::scan(root, &home, project)
        .map_err(|error| SkillHubError::code("INDEX_FAILED").with_detail(error))?;
    let library = library_skill_hashes(root, connection);
    let found = inventory
        .skills
        .iter()
        .filter(|skill| !skill.managed)
        .map(|skill| {
            let raw = fs::read_to_string(Path::new(&skill.canonical_path).join("SKILL.md"))
                .unwrap_or_default();
            let valid = skill_delivery::manifest_name_and_description(&raw).is_some_and(
                |(name, description)| !name.trim().is_empty() && !description.trim().is_empty(),
            );
            (
                skill.agent_id.clone(),
                skill.path.clone(),
                skill.canonical_path.clone(),
                skill.name.clone(),
                skill.description.clone(),
                skill.storage_kind.clone(),
                valid,
            )
        })
        .collect::<Vec<_>>();
    let candidates = build_adopt_candidates(found, &library, &|canonical| {
        sha256_file(&Path::new(canonical).join("SKILL.md"))
    });
    Ok(AdoptPreview {
        importable: candidates.iter().filter(|c| c.state == "new").count(),
        already_managed: candidates
            .iter()
            .filter(|c| c.state == "already-managed")
            .count(),
        duplicates: candidates.iter().filter(|c| c.state == "duplicate").count(),
        warnings: inventory.warnings.clone(),
        truncated: inventory.truncated,
        scanned_at: skill_delivery::iso_now(),
        candidates,
    })
}

pub(crate) fn adopt_preview_blocking(
    project: Option<String>,
) -> Result<AdoptPreview, SkillHubError> {
    let root = crate::resolve_legacy_root()?;
    let connection = crate::open_index_database(&root)?;
    adopt_preview(
        &root,
        &connection,
        project
            .as_deref()
            .filter(|path| !path.trim().is_empty())
            .map(Path::new),
    )
}

/// Copies each selected skill into the library (originals untouched,
/// DECISIONS.md:179), runs the security scan for every one, rebuilds the index
/// exactly once and enqueues exactly one delivery job.
pub(crate) fn adopt_blocking(
    app: Option<tauri::AppHandle>,
    candidate_ids: Vec<String>,
    operation_id: String,
    enqueue: bool,
) -> Result<AdoptReport, SkillHubError> {
    let preview = adopt_preview_blocking(None)?;
    let selected = preview
        .candidates
        .into_iter()
        .filter(|candidate| candidate_ids.contains(&candidate.id))
        .collect::<Vec<_>>();
    let cancellation = crate::register_import_cancellation(&operation_id)?;
    let control = match app.clone() {
        Some(app) => {
            crate::SourceImportControl::with_app(operation_id.clone(), cancellation.clone(), app)
        }
        None => crate::SourceImportControl::detached(operation_id.clone()),
    };
    let result = adopt_selected(&control, app.as_ref(), selected, enqueue);
    crate::unregister_import_cancellation(&operation_id);
    result
}

fn adopt_selected(
    control: &crate::SourceImportControl,
    app: Option<&tauri::AppHandle>,
    selected: Vec<AdoptCandidate>,
    enqueue: bool,
) -> Result<AdoptReport, SkillHubError> {
    let _guard = crate::acquire_background_write_guard_waiting(
        "纳入已有技能",
        crate::LONG_COMMAND_GUARD_WAIT,
        |holder| crate::emit_wait_progress(app, &control.operation_id, holder),
    )?;
    let root = crate::resolve_legacy_root()?;
    let connection = crate::open_index_database(&root)?;
    let total = selected.len() as u64;
    let mut results = Vec::new();
    let mut promoted = Vec::new();
    for (index, candidate) in selected.into_iter().enumerate() {
        control.emit(
            "adopt",
            "progress",
            format!("正在纳入 {}", candidate.name),
            index as u64,
            total,
        );
        if control.is_cancelled() {
            results.push(AdoptItemResult {
                candidate_id: candidate.id.clone(),
                name: candidate.name.clone(),
                outcome: "failed".to_string(),
                source_id: String::new(),
                error: Some(SkillHubError::code("CANCELLED")),
            });
            continue;
        }
        let outcome = match candidate.state.as_str() {
            "duplicate" => Err("skipped-duplicate"),
            "already-managed" => Err("skipped-managed"),
            "new" | "name-clash" => Ok(()),
            _ => Err("failed"),
        };
        if let Err(skip) = outcome {
            results.push(AdoptItemResult {
                candidate_id: candidate.id.clone(),
                name: candidate.name.clone(),
                outcome: skip.to_string(),
                source_id: String::new(),
                error: (skip == "failed").then(|| {
                    SkillHubError::code("MANIFEST_INVALID")
                        .with_path(candidate.canonical_path.clone())
                }),
            });
            continue;
        }
        match crate::adopt_one_skill(&root, &connection, control, &candidate) {
            Ok((target_path, reviewed)) => {
                promoted.push((candidate.clone(), target_path, reviewed));
            }
            Err(error) => results.push(AdoptItemResult {
                candidate_id: candidate.id.clone(),
                name: candidate.name.clone(),
                outcome: "failed".to_string(),
                source_id: String::new(),
                error: Some(error),
            }),
        }
    }
    // Exactly one index rebuild for the whole batch.
    let mut snapshot_stale = false;
    if !promoted.is_empty() {
        control.emit("index", "started", "正在刷新技能库", 0, 1);
        let indexed = crate::scan_legacy_snapshot_under_write_guard()?;
        snapshot_stale = true;
        let connection = crate::open_index_database(&root)?;
        for (candidate, target_path, reviewed) in promoted {
            let source = indexed.sources.iter().find(|source| {
                crate::normalize_path_for_compare(&source.local_path)
                    == crate::normalize_path_for_compare(&target_path)
            });
            match source {
                Some(source) => {
                    if reviewed {
                        // I-5: flagged content is added to the library only.
                        skill_delivery::set_source_library_enabled_rows(
                            &connection,
                            &source.id,
                            false,
                            false,
                        )?;
                    } else {
                        crate::write_install_targets(&connection, &source.id, None, "adopt")?;
                    }
                    results.push(AdoptItemResult {
                        candidate_id: candidate.id.clone(),
                        name: candidate.name.clone(),
                        outcome: if reviewed { "library-only" } else { "adopted" }.to_string(),
                        source_id: source.id.clone(),
                        error: None,
                    });
                }
                None => results.push(AdoptItemResult {
                    candidate_id: candidate.id.clone(),
                    name: candidate.name.clone(),
                    outcome: "failed".to_string(),
                    source_id: String::new(),
                    error: Some(SkillHubError::code("INDEX_FAILED")),
                }),
            }
        }
        control.emit("index", "completed", "技能库已刷新", 1, 1);
    }
    let count = |outcome: &str| results.iter().filter(|r| r.outcome == outcome).count();
    let adopted = count("adopted");
    let library_only = count("library-only");
    let job_id = (enqueue && adopted + library_only > 0).then(|| {
        crate::delivery_queue::request(crate::delivery_queue::Depth::Full, "adopt", false).job_id
    });
    Ok(AdoptReport {
        adopted,
        library_only,
        skipped: count("skipped-duplicate") + count("skipped-managed"),
        failed: count("failed"),
        job_id,
        snapshot_stale,
        results,
    })
}

// ---------------------------------------------------------------------------
// Per-tool inventory (S1-2) and library documents (S1-5)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentSkillEntry {
    pub name: String,
    pub description: String,
    pub path: String,
    pub storage_kind: String,
    pub state: String,
    pub unit_id: String,
    pub adopt_candidate_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentSkillInventory {
    pub agent_id: String,
    pub skills_path: String,
    pub entries: Vec<AgentSkillEntry>,
    pub warnings: Vec<String>,
    pub scanned_at: String,
}

pub(crate) fn list_agent_skills(
    root: &Path,
    connection: &Connection,
    evidence: &Evidence,
    agent_id: &str,
) -> Result<AgentSkillInventory, SkillHubError> {
    if skill_delivery::agent_spec(agent_id).is_none() {
        return Err(SkillHubError::code("AGENT_UNKNOWN").with_agent(agent_id));
    }
    let folder = evidence.path(agent_id).cloned().unwrap_or_default();
    let active_root = crate::active_skills_dir(root);
    let union = crate::expected_agent_skill_allowlist(root, connection)?;
    let units = skill_delivery::read_delivery_units(root, connection, &union)?;
    let targets = skill_delivery::read_targets(connection)?;
    let entry_units = units
        .iter()
        .flat_map(|unit| {
            unit.entries
                .iter()
                .map(move |entry| (entry.to_lowercase(), unit.unit_id.clone()))
        })
        .collect::<HashMap<_, _>>();
    let mut entries = Vec::new();
    let mut warnings = Vec::new();
    if !folder.as_os_str().is_empty() {
        match fs::read_dir(&folder) {
            Ok(items) => {
                for item in items.flatten().take(4096) {
                    let path = item.path();
                    let name = item.file_name().to_string_lossy().to_string();
                    if name.starts_with('.') {
                        continue;
                    }
                    let is_link = crate::external_skills::is_link(&path);
                    if !is_link && !path.is_dir() {
                        continue;
                    }
                    let raw = fs::read_to_string(path.join("SKILL.md")).unwrap_or_default();
                    let parsed = skill_delivery::manifest_name_and_description(&raw);
                    let description = parsed
                        .as_ref()
                        .map(|(_, description)| description.chars().take(240).collect())
                        .unwrap_or_default();
                    let ours = if is_link {
                        crate::delivery_link_target(&path).is_some_and(|target| {
                            skill_delivery::path_is_under(&target, &active_root)
                        })
                    } else {
                        crate::shared_skill_catalog::is_managed_entry(&path)
                    };
                    let unit_id = entry_units
                        .get(&name.to_lowercase())
                        .cloned()
                        .unwrap_or_default();
                    let manifest_ok = parsed
                        .as_ref()
                        .is_some_and(|(n, d)| !n.trim().is_empty() && !d.trim().is_empty());
                    let state = if ours {
                        if !path.join("SKILL.md").is_file() || unit_id.is_empty() {
                            "stale"
                        } else {
                            "managed"
                        }
                    } else if !manifest_ok {
                        "invalid"
                    } else if !unit_id.is_empty()
                        && targets
                            .get(&(unit_id.clone(), agent_id.to_string()))
                            .is_some_and(|row| row.enabled)
                    {
                        "conflict"
                    } else {
                        "personal"
                    };
                    let canonical = path.canonicalize().unwrap_or_else(|_| path.clone());
                    let canonical = canonical
                        .to_string_lossy()
                        .strip_prefix(r"\\?\")
                        .map(str::to_string)
                        .unwrap_or_else(|| canonical.to_string_lossy().to_string());
                    entries.push(AgentSkillEntry {
                        name: parsed
                            .as_ref()
                            .map(|(n, _)| n.clone())
                            .filter(|n| !n.trim().is_empty())
                            .unwrap_or_else(|| name.clone()),
                        description,
                        path: path.display().to_string(),
                        storage_kind: if is_link { "link" } else { "directory" }.to_string(),
                        state: state.to_string(),
                        unit_id: if ours || state == "conflict" {
                            unit_id
                        } else {
                            String::new()
                        },
                        adopt_candidate_id: if matches!(state, "personal" | "conflict") {
                            crate::stable_id("adopt", &canonical.to_lowercase())
                        } else {
                            String::new()
                        },
                    });
                }
            }
            Err(_) if folder.exists() => warnings.push(format!("无法读取 {}", folder.display())),
            Err(_) => {}
        }
    }
    entries.sort_by_key(|entry| entry.name.to_lowercase());
    skill_delivery::set_personal_count(
        agent_id,
        entries
            .iter()
            .filter(|entry| entry.state == "personal")
            .count(),
    );
    Ok(AgentSkillInventory {
        agent_id: agent_id.to_string(),
        skills_path: folder.display().to_string(),
        entries,
        warnings,
        scanned_at: skill_delivery::iso_now(),
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LibrarySkillDocument {
    pub skill_id: String,
    pub path: String,
    pub content: String,
    pub truncated: bool,
    pub files: Vec<String>,
}

/// `SKILL.md` and up to 200 file names of a library skill; managed roots only.
pub(crate) fn read_library_skill_document(
    root: &Path,
    connection: &Connection,
    skill_id: &str,
) -> Result<LibrarySkillDocument, SkillHubError> {
    let row = connection
        .query_row(
            "SELECT folder_name, relative_path FROM skills WHERE id = ?1",
            params![skill_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(|error| SkillHubError::code("INDEX_FAILED").with_detail(error.to_string()))?
        .ok_or_else(|| SkillHubError::code("UNIT_NOT_FOUND"))?;
    let dir = library_skill_dir(root, &row.0, &row.1)
        .ok_or_else(|| SkillHubError::code("UNIT_NOT_FOUND"))?;
    let managed = [
        crate::managed_sources_dir(root),
        crate::active_skills_dir(root),
    ];
    let canonical = dir
        .canonicalize()
        .map_err(|_| SkillHubError::code("UNIT_NOT_FOUND"))?;
    // Active entries are junctions into the sources; either root is fine.
    if !managed.iter().any(|base| {
        base.canonicalize()
            .is_ok_and(|base| canonical.starts_with(base))
    }) {
        return Err(SkillHubError::code("UNIT_NOT_FOUND"));
    }
    let manifest = canonical.join("SKILL.md");
    let bytes = fs::read(&manifest).map_err(|_| SkillHubError::code("UNIT_NOT_FOUND"))?;
    let truncated = bytes.len() as u64 > MAX_DOCUMENT_BYTES;
    let content =
        String::from_utf8_lossy(&bytes[..bytes.len().min(MAX_DOCUMENT_BYTES as usize)]).to_string();
    let mut files = Vec::new();
    let mut stack = vec![canonical.clone()];
    while let Some(current) = stack.pop() {
        if files.len() >= MAX_DOCUMENT_FILES {
            break;
        }
        let Ok(items) = fs::read_dir(&current) else {
            continue;
        };
        for item in items.flatten() {
            if files.len() >= MAX_DOCUMENT_FILES {
                break;
            }
            let path = item.path();
            let name = item.file_name().to_string_lossy().to_string();
            if name == ".git" || name == "node_modules" {
                continue;
            }
            if item.file_type().is_ok_and(|kind| kind.is_dir())
                && !crate::external_skills::is_link(&path)
            {
                stack.push(path);
            } else {
                files.push(
                    path.strip_prefix(&canonical)
                        .unwrap_or(&path)
                        .to_string_lossy()
                        .replace('\\', "/"),
                );
            }
        }
    }
    files.sort();
    Ok(LibrarySkillDocument {
        skill_id: skill_id.to_string(),
        path: manifest
            .display()
            .to_string()
            .trim_start_matches(r"\\?\")
            .to_string(),
        content,
        truncated,
        files,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn github(input: &str) -> ParsedGithubSource {
        let parsed = parse_skill_source_input(input);
        assert!(parsed.error.is_none(), "{input}: {:?}", parsed.error);
        assert_eq!(parsed.kind, "github", "{input}");
        assert_eq!(parsed.route_to, "skills");
        parsed.github.expect("github")
    }

    fn code(input: &str) -> String {
        parse_skill_source_input(input)
            .error
            .map(|error| error.code)
            .unwrap_or_default()
    }

    #[test]
    fn parse_skill_source_input_table() {
        for input in [
            "anthropics/skills",
            "https://github.com/anthropics/skills",
            "http://github.com/anthropics/skills/",
            "github.com/anthropics/skills.git",
            "\"https://github.com/anthropics/skills.git\"",
            "git@github.com:anthropics/skills.git",
            "ssh://git@github.com/anthropics/skills",
            "https://github.com/anthropics/skills?tab=readme-ov-file#top",
        ] {
            let parsed = github(input);
            assert_eq!(
                (parsed.owner.as_str(), parsed.repo.as_str()),
                ("anthropics", "skills"),
                "{input}"
            );
            assert_eq!(parsed.git_ref, "");
            assert_eq!(parsed.subpath, "");
            assert_eq!(parsed.clone_url, "https://github.com/anthropics/skills.git");
        }
        let tree = github("https://github.com/anthropics/skills/tree/main/skills/pdf");
        assert_eq!(
            (tree.git_ref.as_str(), tree.subpath.as_str()),
            ("main", "skills/pdf")
        );
        assert_eq!(
            parse_skill_source_input("https://github.com/anthropics/skills/tree/main/skills/pdf")
                .display,
            "anthropics/skills · skills/pdf"
        );
        let tree_only = github("https://github.com/anthropics/skills/tree/v1.2");
        assert_eq!(
            (tree_only.git_ref.as_str(), tree_only.subpath.as_str()),
            ("v1.2", "")
        );
        let blob = github("https://github.com/anthropics/skills/blob/main/skills/pdf/SKILL.md");
        assert_eq!(
            (blob.git_ref.as_str(), blob.subpath.as_str()),
            ("main", "skills/pdf")
        );
        let root_blob = github("https://github.com/o/r/blob/main/SKILL.md");
        assert_eq!(root_blob.subpath, "");

        // Percent-encoded non-ASCII subpath decodes without a panic.
        let encoded = github("https://github.com/o/r/tree/main/%E6%8A%98%E6%89%A3/50%折");
        assert_eq!(encoded.subpath, "折扣/50%折");
        assert_eq!(
            code("https://github.com/o/r/tree/main/a/../../etc"),
            "GITHUB_SUBPATH_NOT_FOUND"
        );
        assert_eq!(
            code("https://github.com/o/r/tree/main/a/%2e%2e/b"),
            "GITHUB_SUBPATH_NOT_FOUND"
        );
        assert_eq!(
            code("https://github.com/o/r/tree/main/C:/x"),
            "GITHUB_SUBPATH_NOT_FOUND"
        );

        assert_eq!(code(""), "INPUT_EMPTY");
        assert_eq!(code("   \"\"  "), "INPUT_EMPTY");
        assert_eq!(code(&"a".repeat(2049)), "INPUT_TOO_LONG");
        assert_eq!(code("https://gitlab.com/x/y"), "INPUT_UNRECOGNIZED");
        assert_eq!(code("gitee.com/x/y"), "INPUT_UNRECOGNIZED");
        assert_eq!(code("./skills"), "PATH_NOT_ABSOLUTE");
        assert_eq!(code("skills\\demo"), "PATH_NOT_ABSOLUTE");
        assert_eq!(code("a/b/c"), "PATH_NOT_ABSOLUTE");
        assert_eq!(code("just-a-word"), "INPUT_UNRECOGNIZED");

        for mcp in [
            r#"{"mcpServers":{}}"#,
            r#"{"servers":{"x":{"command":"npx"}}}"#,
            r#"{"context7":{"command":"npx","args":["-y","@upstash/context7-mcp"]}}"#,
            "[mcp_servers.context7]\ncommand = \"npx\"",
        ] {
            let parsed = parse_skill_source_input(mcp);
            assert_eq!(parsed.kind, "mcp-config", "{mcp}");
            assert_eq!(parsed.route_to, "mcp");
            assert!(parsed.error.is_none());
        }
    }

    #[test]
    fn local_paths_and_packages_are_recognized_with_one_metadata_call() {
        let root = std::env::temp_dir().join(format!("skillhub-parse-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("folder")).unwrap();
        std::fs::write(root.join("demo.skill.zip"), b"PK").unwrap();
        std::fs::write(root.join("notes.txt"), b"x").unwrap();
        let folder = parse_skill_source_input(&root.join("folder").display().to_string());
        assert_eq!(
            (folder.kind.as_str(), folder.route_to.as_str()),
            ("local-folder", "skills")
        );
        let forward = root.join("folder").display().to_string().replace('\\', "/");
        assert_eq!(parse_skill_source_input(&forward).kind, "local-folder");
        let zip = parse_skill_source_input(&root.join("demo.skill.zip").display().to_string());
        assert_eq!(zip.kind, "zip");
        assert_eq!(
            code(&root.join("missing").display().to_string()),
            "PATH_NOT_FOUND"
        );
        assert_eq!(
            code(&root.join("notes.txt").display().to_string()),
            "PATH_NOT_FOUND"
        );
        let file_url = format!(
            "file:///{}",
            root.join("folder").display().to_string().replace('\\', "/")
        );
        assert_eq!(parse_skill_source_input(&file_url).kind, "local-folder");
        let dropped = accepted_drop_paths(&[
            root.join("folder"),
            root.join("demo.skill.zip"),
            root.join("notes.txt"),
            root.join("missing"),
        ]);
        assert_eq!(dropped.len(), 2);
        std::fs::remove_dir_all(root).unwrap();
    }
}
