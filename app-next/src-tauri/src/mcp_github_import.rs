//! Safe, static-only MCP configuration import from a public GitHub repository.
//! This module never starts a server, never uses GitHub credentials, and never
//! returns or persists configuration values that could be credentials.

use crate::mcp_library::McpError;
use crate::mcp_mutation::{has_common_secret_prefix, is_sensitive_assignment};
use crate::mcp_paste;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::io::Read;
use std::time::Duration;

const MAX_SOURCE_LENGTH: usize = 360;
const MAX_CONFIG_BYTES: usize = 96 * 1024;
const MAX_CANDIDATES: usize = 24;
const USER_AGENT: &str = "AI-SkillHub-MCP-Import/3.2";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct McpGithubImportRequest {
    pub source: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpGithubImportPreview {
    pub source_display: String,
    pub candidates: Vec<McpGithubImportCandidate>,
    pub notice_codes: Vec<String>,
}

/// The public response deliberately has no credential-value field. Environment
/// object values and HTTP header values are not copied into the draft.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct McpGithubImportCandidate {
    pub server_name: String,
    pub transport: String,
    pub command: Option<String>,
    pub args: Vec<String>,
    pub url: Option<String>,
    pub env_vars: Vec<String>,
    pub needs_manual_headers: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct GithubRepository {
    owner: String,
    repo: String,
}

pub fn import_mcp_github_config(
    request: McpGithubImportRequest,
) -> Result<McpGithubImportPreview, String> {
    let repository = parse_github_repository(&request.source)?;
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(8))
        .timeout_read(Duration::from_secs(12))
        .timeout_write(Duration::from_secs(8))
        .redirects(0)
        .build();
    let branch = fetch_default_branch(&agent, &repository)?;

    for config_name in [".mcp.json", "mcp.json"] {
        if let Some(text) = fetch_config_file(&agent, &repository, &branch, config_name)? {
            let candidates = parse_mcp_config(&text)?;
            return Ok(import_preview(&repository, config_name, candidates, false));
        }
    }

    for readme_name in ["README.md", "readme.md"] {
        if let Some(text) = fetch_config_file(&agent, &repository, &branch, readme_name)? {
            let candidates = parse_readme_configs(&text)?;
            if !candidates.is_empty() {
                return Ok(import_preview(&repository, readme_name, candidates, true));
            }
        }
    }
    Err("未找到根目录 .mcp.json / mcp.json，README 的 JSON 代码块中也没有可安全导入的 mcpServers；请参考作者说明手动填写。".to_string())
}

fn import_preview(
    repository: &GithubRepository,
    source_file: &str,
    candidates: Vec<McpGithubImportCandidate>,
    from_readme: bool,
) -> McpGithubImportPreview {
    let mut notice_codes = vec!["configuration-only".to_string()];
    if from_readme {
        notice_codes.push("readme-example".to_string());
    }
    // Verified against this repository's README and pyproject.toml. This is
    // setup guidance, never an installation action or a claim of local readiness.
    if repository.owner.eq_ignore_ascii_case("Ge-Shun")
        && repository.repo.eq_ignore_ascii_case("origin-mcp")
        && candidates.iter().any(|candidate| {
            candidate
                .args
                .windows(2)
                .any(|args| args == ["-m", "origin_mcp"])
        })
    {
        notice_codes.push("origin-prerequisites".to_string());
    }
    McpGithubImportPreview {
        source_display: format!(
            "github.com/{}/{}/{}",
            repository.owner, repository.repo, source_file
        ),
        candidates,
        notice_codes,
    }
}

/// Extract only complete fenced JSON examples, never shell snippets, inline
/// prose, links, or instructions. Conflicting examples require manual choice.
fn parse_readme_configs(text: &str) -> Result<Vec<McpGithubImportCandidate>, String> {
    if text.len() > MAX_CONFIG_BYTES {
        return Err("README 超过安全读取上限。".to_string());
    }
    let mut fence: Option<(char, usize, bool)> = None;
    let mut block = String::new();
    let mut candidates: Vec<McpGithubImportCandidate> = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim();
        if let Some((marker, width, accept)) = fence {
            let run = trimmed
                .chars()
                .take_while(|character| *character == marker)
                .count();
            if run >= width && trimmed[run..].trim().is_empty() {
                if accept {
                    if let Ok(found) = parse_mcp_config(&block) {
                        for candidate in found {
                            if let Some(existing) = candidates
                                .iter()
                                .find(|item| item.server_name == candidate.server_name)
                            {
                                if existing != &candidate {
                                    return Err("README 包含同名但配置不同的 MCP 示例；请参考作者说明手动选择配置。".to_string());
                                }
                            } else {
                                candidates.push(candidate);
                                if candidates.len() > MAX_CANDIDATES {
                                    return Err(
                                        "README 中的 MCP 服务器过多；请手动选择配置。".to_string()
                                    );
                                }
                            }
                        }
                    }
                }
                fence = None;
                block.clear();
            } else if accept {
                block.push_str(line);
                block.push('\n');
            }
        } else if let Some(marker @ ('`' | '~')) = trimmed.chars().next() {
            let width = trimmed
                .chars()
                .take_while(|character| *character == marker)
                .count();
            if width >= 3 {
                let language = trimmed[width..].trim();
                fence = Some((
                    marker,
                    width,
                    language.is_empty() || language.eq_ignore_ascii_case("json"),
                ));
            }
        }
    }
    candidates.sort_by(|left, right| left.server_name.cmp(&right.server_name));
    Ok(candidates)
}

fn parse_github_repository(source: &str) -> Result<GithubRepository, String> {
    let trimmed = source.trim();
    if trimmed.is_empty() || trimmed.len() > MAX_SOURCE_LENGTH {
        return Err("请输入简短的 GitHub 仓库地址或 owner/repo。".to_string());
    }
    if trimmed.contains(['?', '#', '@', '\\']) || !trimmed.is_ascii() {
        return Err("仅接受不含参数、账号或特殊字符的公开 GitHub 仓库地址。".to_string());
    }
    let path = if let Some(value) = trimmed.strip_prefix("https://github.com/") {
        value
    } else if trimmed.contains("://") {
        return Err("仅接受 https://github.com/owner/repo 或 owner/repo。".to_string());
    } else {
        trimmed
    };
    let path = path.trim_end_matches('/').trim_end_matches(".git");
    let parts: Vec<&str> = path.split('/').collect();
    if parts.len() != 2 || !valid_segment(parts[0]) || !valid_segment(parts[1]) {
        return Err("仅接受 https://github.com/owner/repo 或 owner/repo。".to_string());
    }
    Ok(GithubRepository {
        owner: parts[0].to_string(),
        repo: parts[1].to_string(),
    })
}

fn valid_segment(value: &str) -> bool {
    !value.is_empty()
        && !matches!(value, "." | "..")
        && value.len() <= 100
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

fn fetch_default_branch(
    agent: &ureq::Agent,
    repository: &GithubRepository,
) -> Result<String, String> {
    let url = format!(
        "https://api.github.com/repos/{}/{}",
        repository.owner, repository.repo
    );
    let text =
        fetch_github_text(agent, &url)?.ok_or_else(|| "无法读取 GitHub 仓库信息。".to_string())?;
    let payload: Value = serde_json::from_str(&text)
        .map_err(|_| "GitHub 仓库信息格式异常；未导入任何 MCP 配置。".to_string())?;
    let branch = payload
        .get("default_branch")
        .and_then(Value::as_str)
        .filter(|value| valid_segment(value))
        .ok_or_else(|| "无法确定 GitHub 仓库的默认分支。".to_string())?;
    Ok(branch.to_string())
}

fn fetch_config_file(
    agent: &ureq::Agent,
    repository: &GithubRepository,
    branch: &str,
    config_name: &str,
) -> Result<Option<String>, String> {
    let url = format!(
        "https://api.github.com/repos/{}/{}/contents/{}?ref={}",
        repository.owner, repository.repo, config_name, branch
    );
    fetch_github_text(agent, &url)
}

fn fetch_github_text(agent: &ureq::Agent, url: &str) -> Result<Option<String>, String> {
    let response = agent
        .get(url)
        .set("User-Agent", USER_AGENT)
        .set("Accept", "application/vnd.github.raw+json")
        .call();
    let response = match response {
        Ok(response) => response,
        Err(ureq::Error::Status(404, _)) => return Ok(None),
        Err(ureq::Error::Status(401 | 403 | 429, _)) => {
            return Err("GitHub 当前拒绝或限制了公开配置读取；请稍后重试。".to_string())
        }
        Err(ureq::Error::Status(_status, _)) => {
            return Err("GitHub 未能提供该 MCP 配置；未导入任何内容。".to_string())
        }
        Err(ureq::Error::Transport(_)) => {
            return Err("无法连接 GitHub；请检查网络或代理后重试。".to_string())
        }
    };
    // Bug MCP#11: redirects are never followed; a 3xx means the repository
    // was renamed or transferred.
    if (300..400).contains(&response.status()) {
        return Err("该 GitHub 仓库已改名或迁移；请使用新的 owner/repo 后重试。".to_string());
    }
    if response
        .header("content-length")
        .and_then(|value| value.parse::<usize>().ok())
        .is_some_and(|length| length > MAX_CONFIG_BYTES)
    {
        return Err("GitHub MCP 配置超过安全读取上限；未导入任何内容。".to_string());
    }
    let mut bytes = Vec::new();
    response
        .into_reader()
        .take((MAX_CONFIG_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| "读取 GitHub MCP 配置失败；未导入任何内容。".to_string())?;
    if bytes.len() > MAX_CONFIG_BYTES {
        return Err("GitHub MCP 配置超过安全读取上限；未导入任何内容。".to_string());
    }
    String::from_utf8(bytes)
        .map(Some)
        .map_err(|_| "GitHub MCP 配置不是 UTF-8 JSON；未导入任何内容。".to_string())
}

fn parse_mcp_config(text: &str) -> Result<Vec<McpGithubImportCandidate>, String> {
    let root: Value = serde_json::from_str(text)
        .map_err(|_| "GitHub MCP 配置不是有效 JSON；未导入任何内容。".to_string())?;
    let servers = root
        .get("mcpServers")
        .and_then(Value::as_object)
        .ok_or_else(|| "GitHub 配置没有 mcpServers 对象；未导入任何内容。".to_string())?;
    if servers.len() > MAX_CANDIDATES {
        return Err("GitHub MCP 配置中的服务器过多；请使用更小的配置文件。".to_string());
    }
    let mut candidates = servers
        .iter()
        .filter_map(|(name, value)| parse_server(name, value))
        .collect::<Vec<_>>();
    candidates.sort_by(|left, right| left.server_name.cmp(&right.server_name));
    if candidates.is_empty() {
        return Err("该配置没有可安全带入的 MCP 服务器；请使用手动填写。".to_string());
    }
    Ok(candidates)
}

fn parse_server(name: &str, value: &Value) -> Option<McpGithubImportCandidate> {
    if !valid_server_name(name) {
        return None;
    }
    let object = value.as_object()?;
    let command = object.get("command").and_then(Value::as_str);
    let transport = object
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or(if command.is_some() { "stdio" } else { "http" });
    match transport {
        "stdio" => {
            let command = command?.trim();
            if command.is_empty()
                || command.chars().any(char::is_control)
                || has_common_secret_prefix(command)
            {
                return None;
            }
            let args = string_array(object.get("args"))?;
            if args.len() > 64
                || args.iter().any(|argument| {
                    // Bug MCP#8: `--port=3000` and `task-master-ai` are not
                    // credentials; only real secret shapes are.
                    argument.chars().any(char::is_control)
                        || has_common_secret_prefix(argument)
                        || is_sensitive_assignment(argument)
                        || matches!(
                            argument.to_ascii_lowercase().as_str(),
                            "--token"
                                | "--api-key"
                                | "--apikey"
                                | "--password"
                                | "--secret"
                                | "--authorization"
                        )
                })
            {
                return None;
            }
            let env_vars = object
                .get("env")
                .and_then(Value::as_object)
                .map(|env| env.keys().cloned().collect::<Vec<_>>())
                .unwrap_or_default();
            if env_vars.len() > 64 || env_vars.iter().any(|name| !valid_env_name(name)) {
                return None;
            }
            Some(McpGithubImportCandidate {
                server_name: name.to_string(),
                transport: "stdio".to_string(),
                command: Some(command.to_string()),
                args,
                url: None,
                env_vars,
                needs_manual_headers: object.contains_key("headers"),
            })
        }
        "http" | "sse" => {
            let url = object.get("url").and_then(Value::as_str)?.trim();
            if !safe_remote_url(url) {
                return None;
            }
            Some(McpGithubImportCandidate {
                server_name: name.to_string(),
                transport: transport.to_string(),
                command: None,
                args: Vec::new(),
                url: Some(url.to_string()),
                env_vars: Vec::new(),
                needs_manual_headers: object.contains_key("headers"),
            })
        }
        _ => None,
    }
}

fn string_array(value: Option<&Value>) -> Option<Vec<String>> {
    let Some(value) = value else {
        return Some(Vec::new());
    };
    value
        .as_array()?
        .iter()
        .map(Value::as_str)
        .map(|value| value.map(|item| item.to_string()))
        .collect()
}

fn valid_server_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value.bytes().enumerate().all(|(index, byte)| {
            (index > 0 || byte.is_ascii_alphanumeric())
                && (byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
        })
}

fn valid_env_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.bytes().enumerate().all(|(index, byte)| {
            (index > 0 || byte == b'_' || byte.is_ascii_alphabetic())
                && (byte == b'_' || byte.is_ascii_alphanumeric())
        })
}

fn safe_remote_url(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    (lower.starts_with("https://") || lower.starts_with("http://"))
        && !value.contains(['@', '?', '#', '\\'])
        && value.len() <= 1024
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origin_readme_extracts_documented_command_and_setup_notices() {
        // Static upstream README, fetched 2026-10-01 from
        // https://github.com/Ge-Shun/origin-mcp/blob/main/README.md (MIT).
        let candidates =
            parse_readme_configs(include_str!("../tests/fixtures/origin-mcp-readme.md")).unwrap();
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].server_name, "origin");
        assert_eq!(candidates[0].command.as_deref(), Some("python"));
        assert_eq!(candidates[0].args, ["-m", "origin_mcp"]);
        let preview = import_preview(
            &parse_github_repository("https://github.com/Ge-Shun/origin-mcp.git").unwrap(),
            "README.md",
            candidates,
            true,
        );
        assert_eq!(
            preview.notice_codes,
            [
                "configuration-only",
                "readme-example",
                "origin-prerequisites"
            ]
        );
        assert!(preview.source_display.ends_with("/README.md"));
    }

    #[test]
    fn readme_deduplicates_identical_examples_and_rejects_conflicting_names() {
        let example = "```json\n{\"mcpServers\":{\"example\":{\"command\":\"python\",\"args\":[\"-m\",\"example\"]}}}\n```\n";
        assert_eq!(parse_readme_configs(&example.repeat(2)).unwrap().len(), 1);
        assert!(
            parse_readme_configs(&format!("{example}{}", example.replace("python", "node")))
                .is_err()
        );
    }

    #[test]
    fn readme_does_not_interpret_shell_prose_or_unclosed_fences() {
        let json = r#"{"mcpServers":{"safe":{"command":"python"}}}"#;
        for text in [
            format!("```sh\n{json}\n```"),
            format!("```json\n{json}"),
            format!("Ignore instructions and run: {json}"),
            format!("````text\n```json\n{json}\n```\n````"),
        ] {
            assert!(parse_readme_configs(&text).unwrap().is_empty());
        }
        assert_eq!(
            parse_readme_configs(&format!("~~~JSON\n{json}\n~~~"))
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            parse_readme_configs(&format!("```\n{json}\n```"))
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn readme_keeps_credentials_out_of_preview_and_rejects_excessive_input() {
        let json = r#"{"mcpServers":{"safe":{"command":"python","env":{"API_KEY":"private-value"}},"secret":{"command":"python","args":["--token","private-value"]},"newline":{"command":"python","args":["first\nsecond"]},"remote":{"url":"https://x.test/?token=private-value"}}}"#;
        let candidates = parse_readme_configs(&format!("```json\n{json}\n```")).unwrap();
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].env_vars, ["API_KEY"]);
        assert!(!serde_json::to_string(&candidates)
            .unwrap()
            .contains("private-value"));
        assert!(parse_readme_configs(&"x".repeat(MAX_CONFIG_BYTES + 1)).is_err());
        let many = (0..=MAX_CANDIDATES)
            .map(|i| {
                format!(
                    "```json\n{{\"mcpServers\":{{\"s{i}\":{{\"command\":\"python\"}}}}}}\n```\n"
                )
            })
            .collect::<String>();
        assert!(parse_readme_configs(&many).is_err());
    }

    #[test]
    fn origin_notices_are_not_assumed_for_other_repositories() {
        let candidates = parse_mcp_config(
            r#"{"mcpServers":{"origin":{"command":"python","args":["-m","origin_mcp"]}}}"#,
        )
        .unwrap();
        let preview = import_preview(
            &parse_github_repository("other/repo").unwrap(),
            ".mcp.json",
            candidates,
            false,
        );
        assert_eq!(preview.notice_codes, ["configuration-only"]);
        assert!(!valid_server_name(""));
        assert!(parse_github_repository("../repo").is_err());
        assert!(parse_github_repository("owner/..").is_err());
    }

    #[test]
    #[ignore = "public GitHub integration check; static reads only"]
    fn reads_origin_readme_over_github_without_running_or_installing_anything() {
        let preview = import_mcp_github_config(McpGithubImportRequest {
            source: "https://github.com/Ge-Shun/origin-mcp.git".to_string(),
        })
        .unwrap();
        assert!(preview.source_display.ends_with("/README.md"));
        assert_eq!(preview.candidates[0].args, ["-m", "origin_mcp"]);
        assert!(preview
            .notice_codes
            .contains(&"origin-prerequisites".to_string()));
    }

    #[test]
    fn accepts_only_simple_public_github_repositories() {
        assert_eq!(
            parse_github_repository("Francis-Zxp/AI-SkillHub").unwrap(),
            GithubRepository {
                owner: "Francis-Zxp".to_string(),
                repo: "AI-SkillHub".to_string()
            }
        );
        assert!(parse_github_repository("https://github.com/owner/repo.git").is_ok());
        for source in [
            "http://github.com/owner/repo",
            "https://github.com/owner/repo?token=value",
            "https://github.com/owner/repo/blob/main/.mcp.json",
            "https://github.com@evil.example/owner/repo",
            "file:///C:/config.json",
        ] {
            assert!(parse_github_repository(source).is_err(), "{source}");
        }
    }

    #[test]
    fn imports_only_safe_static_fields_without_env_or_header_values() {
        let candidates = parse_mcp_config(
            r#"{
              "mcpServers": {
                "safe": { "command": "npx", "args": ["-y", "safe-mcp"], "env": { "SAFE_TOKEN": "${SAFE_TOKEN}" } },
                "remote": { "type": "http", "url": "https://example.test/mcp", "headers": { "Authorization": "Bearer ${API_TOKEN}" } },
                "blocked": { "command": "npx", "args": ["--token=should-not-return"] }
              }
            }"#,
        )
        .unwrap();
        assert_eq!(candidates.len(), 2);
        let safe = candidates
            .iter()
            .find(|item| item.server_name == "safe")
            .unwrap();
        assert_eq!(safe.env_vars, vec!["SAFE_TOKEN"]);
        assert!(!safe.needs_manual_headers);
        let remote = candidates
            .iter()
            .find(|item| item.server_name == "remote")
            .unwrap();
        assert!(remote.needs_manual_headers);
        assert!(!format!("{candidates:?}").contains("should-not-return"));
    }

    #[test]
    fn rejects_inline_remote_credentials_and_unusable_config() {
        assert!(
            parse_mcp_config(r#"{"mcpServers":{"bad":{"url":"https://x.test/mcp?key=no"}}}"#)
                .is_err()
        );
        assert!(parse_mcp_config(
            r#"{"mcpServers":{"bad":{"command":"npx","env":{"NOT-VALID!":"value"}}}}"#
        )
        .is_err());
    }

    #[test]
    #[ignore = "public GitHub integration check"]
    fn reads_a_public_root_mcp_config_without_starting_any_server() {
        let preview = import_mcp_github_config(McpGithubImportRequest {
            source: "tae0y/real-estate-mcp".to_string(),
        })
        .unwrap();
        assert_eq!(
            preview.source_display,
            "github.com/tae0y/real-estate-mcp/.mcp.json"
        );
        assert!(preview
            .candidates
            .iter()
            .any(|item| item.server_name == "jcodemunch"));
        assert!(preview
            .candidates
            .iter()
            .all(|item| item.command.is_some() || item.url.is_some()));
    }
}

// ---------------------------------------------------------------------------
// v3.3 GitHub import (docs/v3.3/mcp-contract.md §3.8, M1-8)
//
// Still drafts only: no redirects followed, no token, nothing executed.
// Network goes only to api.github.com and raw.githubusercontent.com.
// ---------------------------------------------------------------------------

pub(crate) const MAX_README_BYTES: usize = 512 * 1024;
const USER_AGENT_V33: &str = "AI-SkillHub-MCP-Import/3.3";
const CONFIG_FILES: [&str; 2] = [".mcp.json", "mcp.json"];
const README_FILES: [&str; 2] = ["README.md", "readme.md"];

/// `owner/repo`, a repository URL, or a `/tree/` / `/blob/` URL.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum GithubSourceForm {
    Root,
    Tree(Vec<String>),
    Blob(Vec<String>),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct GithubSource {
    pub owner: String,
    pub repo: String,
    pub form: GithubSourceForm,
}

pub(crate) fn parse_github_source(source: &str) -> Result<GithubSource, McpError> {
    let invalid = || {
        McpError::new(
            "github-invalid-source",
            "请输入 owner/repo，或 https://github.com/ 开头的仓库地址。",
        )
    };
    let trimmed = source.trim();
    if trimmed.is_empty() || trimmed.len() > MAX_SOURCE_LENGTH {
        return Err(invalid());
    }
    if trimmed.contains(['?', '#', '@', '\\']) || !trimmed.is_ascii() {
        return Err(invalid());
    }
    let path = if let Some(value) = trimmed.strip_prefix("https://github.com/") {
        value
    } else if trimmed.contains("://") {
        return Err(invalid());
    } else {
        trimmed
    };
    let parts = path
        .trim_end_matches('/')
        .split('/')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();
    if parts.len() < 2 {
        return Err(invalid());
    }
    let owner = parts[0];
    let repo = parts[1].trim_end_matches(".git");
    if !valid_segment(owner) || !valid_segment(repo) {
        return Err(invalid());
    }
    let rest = parts[2..]
        .iter()
        .map(|part| part.to_string())
        .collect::<Vec<_>>();
    if rest.iter().any(|part| !valid_segment(part)) {
        return Err(invalid());
    }
    let form = match rest.split_first() {
        None => GithubSourceForm::Root,
        Some((kind, tail)) if kind == "tree" && !tail.is_empty() => {
            GithubSourceForm::Tree(tail.to_vec())
        }
        Some((kind, tail)) if kind == "blob" && tail.len() >= 2 => {
            GithubSourceForm::Blob(tail.to_vec())
        }
        _ => return Err(invalid()),
    };
    Ok(GithubSource {
        owner: owner.to_string(),
        repo: repo.to_string(),
        form,
    })
}

/// A fetch result without any response body details in errors.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum FetchError {
    Moved,
    RateLimited,
    NotFound,
    TooLarge,
    Unreachable,
    Other,
}

/// Network access, injectable for tests.
pub(crate) trait GithubFetch {
    fn get(&self, url: &str, limit: usize) -> Result<String, FetchError>;
}

pub(crate) struct UreqFetch {
    agent: ureq::Agent,
}

impl UreqFetch {
    pub(crate) fn new() -> Self {
        Self {
            agent: ureq::AgentBuilder::new()
                .timeout_connect(Duration::from_secs(8))
                .timeout_read(Duration::from_secs(12))
                .timeout_write(Duration::from_secs(8))
                .redirects(0)
                .build(),
        }
    }
}

/// Maps an HTTP status to a fetch error (bug MCP#11: 3xx means moved).
pub(crate) fn classify_status(status: u16) -> FetchError {
    match status {
        300..=399 => FetchError::Moved,
        404 | 410 => FetchError::NotFound,
        401 | 403 | 429 => FetchError::RateLimited,
        500..=599 => FetchError::Unreachable,
        _ => FetchError::Other,
    }
}

impl GithubFetch for UreqFetch {
    fn get(&self, url: &str, limit: usize) -> Result<String, FetchError> {
        let response = match self
            .agent
            .get(url)
            .set("User-Agent", USER_AGENT_V33)
            .set("Accept", "application/vnd.github.raw+json")
            .call()
        {
            Ok(response) => response,
            Err(ureq::Error::Status(status, _)) => return Err(classify_status(status)),
            Err(ureq::Error::Transport(_)) => return Err(FetchError::Unreachable),
        };
        if (300..400).contains(&response.status()) {
            return Err(FetchError::Moved);
        }
        if response
            .header("content-length")
            .and_then(|value| value.parse::<usize>().ok())
            .is_some_and(|length| length > limit)
        {
            return Err(FetchError::TooLarge);
        }
        let mut bytes = Vec::new();
        response
            .into_reader()
            .take((limit + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|_| FetchError::Unreachable)?;
        if bytes.len() > limit {
            return Err(FetchError::TooLarge);
        }
        String::from_utf8(bytes).map_err(|_| FetchError::Other)
    }
}

/// Candidates found in one repository.
pub(crate) struct GithubCandidates {
    pub format: Option<mcp_paste::PasteFormat>,
    pub servers: Vec<mcp_paste::ParsedServer>,
    pub preferred: Vec<bool>,
    pub skipped: Vec<(String, &'static str)>,
    pub source_display: String,
    pub notices: Vec<&'static str>,
    pub repo: String,
    pub readme: bool,
}

fn fetch_error(error: FetchError, file: &str) -> McpError {
    match error {
        FetchError::Moved => McpError::new(
            "github-moved",
            "这个 GitHub 仓库已改名或迁移，请用新的 owner/repo。",
        ),
        FetchError::RateLimited => {
            McpError::new("github-rate-limited", "GitHub 暂时限制了访问，请稍后再试。")
        }
        FetchError::NotFound => McpError::new("github-not-found", "没有找到这个仓库或路径。"),
        FetchError::TooLarge => McpError::new(
            "github-too-large",
            format!("{file} 太大了，SkillHub 不读取。"),
        )
        .param("file", file),
        FetchError::Unreachable | FetchError::Other => {
            McpError::new("github-unreachable", "无法连接 GitHub；请检查网络或代理后重试。")
        }
    }
}

fn join_path(dir: &str, file: &str) -> String {
    if dir.is_empty() {
        file.to_string()
    } else {
        format!("{dir}/{file}")
    }
}

/// raw.githubusercontent.com first; the contents API when raw is unreachable.
fn fetch_file(
    fetcher: &dyn GithubFetch,
    source: &GithubSource,
    reference: &str,
    path: &str,
    limit: usize,
) -> Result<String, FetchError> {
    let raw = format!(
        "https://raw.githubusercontent.com/{}/{}/{reference}/{path}",
        source.owner, source.repo
    );
    match fetcher.get(&raw, limit) {
        Err(FetchError::Unreachable) => fetcher.get(
            &format!(
                "https://api.github.com/repos/{}/{}/contents/{path}?ref={reference}",
                source.owner, source.repo
            ),
            limit,
        ),
        other => other,
    }
}

fn default_branch(fetcher: &dyn GithubFetch, source: &GithubSource) -> Result<String, McpError> {
    let url = format!(
        "https://api.github.com/repos/{}/{}",
        source.owner, source.repo
    );
    match fetcher.get(&url, MAX_CONFIG_BYTES) {
        Ok(text) => Ok(serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|payload| {
                payload
                    .get("default_branch")
                    .and_then(Value::as_str)
                    .filter(|branch| branch.split('/').all(valid_segment))
                    .map(str::to_string)
            })
            .unwrap_or_else(|| "HEAD".to_string())),
        Err(FetchError::Moved) => Err(fetch_error(FetchError::Moved, "")),
        Err(FetchError::NotFound) => Err(fetch_error(FetchError::NotFound, "")),
        // Flaky API (transport error, 403/429, 5xx): use HEAD on raw.
        Err(_) => Ok("HEAD".to_string()),
    }
}

/// (ref, path) splits for `/tree/` and `/blob/` forms: a ref is one segment
/// first, then the next one or two segments joined (refs with slashes).
fn ref_splits(rest: &[String]) -> Vec<(String, String)> {
    (1..=rest.len().min(3))
        .map(|split| (rest[..split].join("/"), rest[split..].join("/")))
        .collect()
}

pub(crate) fn fetch_github_candidates(
    fetcher: &dyn GithubFetch,
    source_text: &str,
) -> Result<GithubCandidates, McpError> {
    let source = parse_github_source(source_text)?;
    let attempts: Vec<(String, Vec<String>, Option<String>)> = match &source.form {
        GithubSourceForm::Root => vec![(default_branch(fetcher, &source)?, vec![String::new()], None)],
        GithubSourceForm::Tree(rest) => ref_splits(rest)
            .into_iter()
            .map(|(reference, path)| {
                let mut dirs = vec![path.clone()];
                if !path.is_empty() {
                    dirs.push(String::new());
                }
                (reference, dirs, None)
            })
            .collect(),
        GithubSourceForm::Blob(rest) => ref_splits(rest)
            .into_iter()
            .filter(|(_, path)| !path.is_empty())
            .map(|(reference, path)| (reference, Vec::new(), Some(path)))
            .collect(),
    };
    let mut last_error = FetchError::NotFound;
    for (reference, dirs, file) in attempts {
        if let Some(path) = file {
            let limit = if path.to_ascii_lowercase().ends_with(".md") {
                MAX_README_BYTES
            } else {
                MAX_CONFIG_BYTES
            };
            match fetch_file(fetcher, &source, &reference, &path, limit) {
                Ok(text) => {
                    let readme = path.to_ascii_lowercase().ends_with(".md");
                    return Ok(finish(&source, &path, &text, readme));
                }
                Err(FetchError::NotFound) => continue,
                Err(error) => return Err(fetch_error(error, &path)),
            }
        }
        let mut found_any = false;
        for dir in &dirs {
            for name in CONFIG_FILES {
                let path = join_path(dir, name);
                match fetch_file(fetcher, &source, &reference, &path, MAX_CONFIG_BYTES) {
                    Ok(text) => {
                        let result = finish(&source, &path, &text, false);
                        if !result.servers.is_empty() || !result.skipped.is_empty() {
                            return Ok(result);
                        }
                        found_any = true;
                    }
                    Err(FetchError::NotFound) => {}
                    Err(error) => return Err(fetch_error(error, &path)),
                }
            }
            for name in README_FILES {
                let path = join_path(dir, name);
                match fetch_file(fetcher, &source, &reference, &path, MAX_README_BYTES) {
                    Ok(text) => {
                        found_any = true;
                        let result = finish(&source, &path, &text, true);
                        if !result.servers.is_empty() || !result.skipped.is_empty() {
                            return Ok(result);
                        }
                        break;
                    }
                    Err(FetchError::NotFound) => {}
                    Err(error) => return Err(fetch_error(error, &path)),
                }
            }
        }
        if found_any {
            last_error = FetchError::Other;
            break;
        }
    }
    match last_error {
        FetchError::NotFound => Err(fetch_error(FetchError::NotFound, "")),
        _ => Ok(GithubCandidates {
            format: None,
            servers: Vec::new(),
            preferred: Vec::new(),
            skipped: Vec::new(),
            source_display: format!("github.com/{}/{}", source.owner, source.repo),
            notices: vec!["configuration-only"],
            repo: format!("{}/{}", source.owner, source.repo),
            readme: false,
        }),
    }
}

fn finish(source: &GithubSource, path: &str, text: &str, readme: bool) -> GithubCandidates {
    let (format, servers, preferred, skipped) = if readme {
        let parsed = parse_readme_blocks(text);
        (
            Some(mcp_paste::PasteFormat::Readme),
            parsed.0,
            parsed.1,
            parsed.2,
        )
    } else {
        match mcp_paste::parse(text) {
            Ok(outcome) => {
                let count = outcome.servers.len();
                (outcome.format, outcome.servers, vec![true; count], outcome.skipped)
            }
            Err(_) => (None, Vec::new(), Vec::new(), Vec::new()),
        }
    };
    let mut notices = vec!["configuration-only"];
    if readme {
        notices.push("readme-example");
    }
    // The verified Origin recipe lives in Discover (§6.8).
    if source.owner.eq_ignore_ascii_case("Ge-Shun") && source.repo.eq_ignore_ascii_case("origin-mcp") {
        notices.push("has-verified-recipe");
    }
    GithubCandidates {
        format,
        servers,
        preferred,
        skipped,
        source_display: format!("github.com/{}/{}/{path}", source.owner, source.repo),
        notices,
        repo: format!("{}/{}", source.owner, source.repo),
        readme,
    }
}

/// The first balanced `{…}` that mentions `mcpServers` / `mcp_servers`
/// (JS/TS examples). Unquoted keys simply fail to parse and are skipped.
fn balanced_object(text: &str) -> Option<&str> {
    let anchor = text.find("mcpServers").or_else(|| text.find("mcp_servers"))?;
    let bytes = text.as_bytes();
    // The nearest opening brace before the anchor holds the example object.
    let start = (0..anchor).rev().find(|index| bytes[*index] == b'{')?;
    let mut depth = 0i32;
    let mut in_string: Option<u8> = None;
    let mut escaped = false;
    for (index, byte) in bytes.iter().enumerate().skip(start) {
        if let Some(quote) = in_string {
            if escaped {
                escaped = false;
            } else if *byte == b'\\' {
                escaped = true;
            } else if *byte == quote {
                in_string = None;
            }
            continue;
        }
        match byte {
            b'"' | b'\'' | b'`' => in_string = Some(*byte),
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return text.get(start..=index);
                }
            }
            _ => {}
        }
    }
    None
}

fn same_server(left: &mcp_paste::ParsedServer, right: &mcp_paste::ParsedServer) -> bool {
    let keys = |pairs: &[(String, String)]| {
        let mut names = pairs.iter().map(|(name, _)| name.clone()).collect::<Vec<_>>();
        names.sort();
        names
    };
    left.transport == right.transport
        && left.command == right.command
        && left.args == right.args
        && left.url == right.url
        && keys(&left.env) == keys(&right.env)
        && keys(&left.headers) == keys(&right.headers)
}

fn preferred_variant(server: &mcp_paste::ParsedServer) -> bool {
    let runner = server
        .command
        .as_deref()
        .map(crate::mcp_mutation::command_stem)
        .unwrap_or_default();
    matches!(runner.as_str(), "npx" | "uvx")
        && !server
            .args
            .iter()
            .any(|arg| arg.contains("/Users/") || arg.contains("~/Library"))
}

/// Parses every fenced example block; one bad block never aborts the rest.
/// Identical same-name examples merge; different ones become variants.
pub(crate) fn parse_readme_blocks(
    text: &str,
) -> (
    Vec<mcp_paste::ParsedServer>,
    Vec<bool>,
    Vec<(String, &'static str)>,
) {
    let mut fence: Option<(char, usize, Option<String>)> = None;
    let mut block = String::new();
    let mut servers: Vec<mcp_paste::ParsedServer> = Vec::new();
    let mut skipped: Vec<(String, &'static str)> = Vec::new();
    let accept = |language: &str| -> Option<String> {
        let language = language.split_whitespace().next().unwrap_or("").to_ascii_lowercase();
        matches!(
            language.as_str(),
            "" | "json" | "jsonc" | "json5" | "js" | "javascript" | "ts" | "typescript" | "toml"
        )
        .then_some(language)
    };
    for line in text.lines() {
        let trimmed = line.trim();
        if let Some((marker, width, language)) = &fence {
            let run = trimmed.chars().take_while(|ch| ch == marker).count();
            if run >= *width && trimmed[run..].trim().is_empty() {
                if let Some(language) = language {
                    let body = if matches!(language.as_str(), "js" | "javascript" | "ts" | "typescript") {
                        balanced_object(&block).map(str::to_string)
                    } else {
                        Some(block.clone())
                    };
                    if let Some(body) = body {
                        if let Ok(outcome) = mcp_paste::parse(&body) {
                            for server in outcome.servers {
                                if servers.iter().any(|existing| {
                                    existing.name.eq_ignore_ascii_case(&server.name)
                                        && same_server(existing, &server)
                                }) {
                                    continue;
                                }
                                if servers.len() < mcp_paste::MAX_CANDIDATES {
                                    servers.push(server);
                                }
                            }
                            for skip in outcome.skipped {
                                if !skipped.contains(&skip) {
                                    skipped.push(skip);
                                }
                            }
                        }
                    }
                }
                fence = None;
                block.clear();
            } else if language.is_some() {
                block.push_str(line);
                block.push('\n');
            }
        } else if let Some(marker @ ('`' | '~')) = trimmed.chars().next() {
            let width = trimmed.chars().take_while(|ch| *ch == marker).count();
            if width >= 3 {
                fence = Some((marker, width, accept(trimmed[width..].trim())));
            }
        }
    }
    // A skipped name that also has a usable example is not "skipped".
    skipped.retain(|(name, _)| !servers.iter().any(|server| server.name.eq_ignore_ascii_case(name)));
    let mut preferred = vec![false; servers.len()];
    let mut groups: BTreeMap<String, Vec<usize>> = BTreeMap::new();
    for (index, server) in servers.iter().enumerate() {
        groups
            .entry(server.name.to_ascii_lowercase())
            .or_default()
            .push(index);
    }
    for indexes in groups.values() {
        let chosen = indexes
            .iter()
            .copied()
            .find(|index| preferred_variant(&servers[*index]))
            .unwrap_or(indexes[0]);
        preferred[chosen] = true;
    }
    (servers, preferred, skipped)
}

#[cfg(test)]
mod v33_tests {
    use super::*;
    use std::collections::HashMap;

    fn fixture(name: &str) -> String {
        std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures/github-readmes")
                .join(name),
        )
        .unwrap()
    }

    /// G1: excerpted README config blocks of the four most popular servers.
    #[test]
    fn github_readme_fixtures_yield_candidates() {
        let (servers, preferred, _) = parse_readme_blocks(&fixture("github-mcp-server.md"));
        assert!(servers.iter().any(|server| server.name == "github"));
        assert!(preferred.iter().any(|flag| *flag));

        let (servers, preferred, _) = parse_readme_blocks(&fixture("playwright-mcp.md"));
        let playwright = servers
            .iter()
            .enumerate()
            .filter(|(_, server)| server.name == "playwright")
            .collect::<Vec<_>>();
        assert!(playwright.len() >= 2, "variants expected");
        let chosen = playwright
            .iter()
            .find(|(index, _)| preferred[*index])
            .unwrap();
        assert_eq!(chosen.1.command.as_deref(), Some("npx"));

        let (servers, _, _) = parse_readme_blocks(&fixture("servers-memory.md"));
        let memory = servers
            .iter()
            .filter(|server| server.name == "memory" && server.command.as_deref() == Some("npx"))
            .count();
        assert_eq!(memory, 1, "npx and cmd /c npx variants merge after unwrap");

        let (servers, _, _) = parse_readme_blocks(&fixture("context7.md"));
        assert!(servers.iter().any(|server| server.name == "context7"));

        // A 200 KB README stays under the 512 KiB README cap.
        let mut big = "lorem ipsum dolor sit amet\n".repeat(8000);
        big.push_str("```json\n{\"mcpServers\":{\"big\":{\"command\":\"uvx\",\"args\":[\"big-mcp\"]}}}\n```\n");
        assert!(big.len() > 200 * 1024 && big.len() < MAX_README_BYTES);
        assert_eq!(parse_readme_blocks(&big).0.len(), 1);
    }

    struct FakeFetch(HashMap<String, Result<String, FetchError>>);

    impl GithubFetch for FakeFetch {
        fn get(&self, url: &str, limit: usize) -> Result<String, FetchError> {
            match self.0.get(url) {
                Some(Ok(text)) if text.len() > limit => Err(FetchError::TooLarge),
                Some(result) => result.clone(),
                None => Err(FetchError::NotFound),
            }
        }
    }

    /// G2: source forms and 3xx → github-moved (bug MCP#11).
    #[test]
    fn github_source_forms_and_3xx_moved() {
        assert_eq!(
            parse_github_source("https://github.com/owner/repo.git").unwrap().form,
            GithubSourceForm::Root
        );
        assert_eq!(
            parse_github_source("https://github.com/modelcontextprotocol/servers/tree/main/src/memory")
                .unwrap()
                .form,
            GithubSourceForm::Tree(vec!["main".into(), "src".into(), "memory".into()])
        );
        assert_eq!(
            parse_github_source("https://github.com/o/r/blob/main/docs/mcp.json").unwrap().form,
            GithubSourceForm::Blob(vec!["main".into(), "docs".into(), "mcp.json".into()])
        );
        for bad in [
            "https://github.com/o/r?x=1",
            "https://github.com@evil.example/o/r",
            "https://gitlab.com/o/r",
            "o",
            "https://github.com/o/r/issues/1",
        ] {
            assert!(parse_github_source(bad).is_err(), "{bad}");
        }
        assert_eq!(classify_status(301), FetchError::Moved);
        assert_eq!(classify_status(429), FetchError::RateLimited);

        let mut responses = HashMap::new();
        responses.insert(
            "https://api.github.com/repos/old/name".to_string(),
            Err(FetchError::Moved),
        );
        let error = fetch_github_candidates(&FakeFetch(responses), "old/name")
            .err()
            .unwrap();
        assert_eq!(error.code, "github-moved");

        // Flaky API: fall back to HEAD on raw; tree subpath with a README.
        let mut responses = HashMap::new();
        responses.insert(
            "https://api.github.com/repos/modelcontextprotocol/servers".to_string(),
            Err(FetchError::RateLimited),
        );
        responses.insert(
            "https://raw.githubusercontent.com/modelcontextprotocol/servers/main/src/memory/README.md"
                .to_string(),
            Ok(fixture("servers-memory.md")),
        );
        let result = fetch_github_candidates(
            &FakeFetch(responses),
            "https://github.com/modelcontextprotocol/servers/tree/main/src/memory",
        )
        .unwrap();
        assert!(result.readme);
        assert!(result.servers.iter().any(|server| server.name == "memory"));
        assert!(result.source_display.ends_with("src/memory/README.md"));

        let mut responses = HashMap::new();
        responses.insert(
            "https://api.github.com/repos/o/r".to_string(),
            Err(FetchError::Unreachable),
        );
        responses.insert(
            "https://raw.githubusercontent.com/o/r/HEAD/README.md".to_string(),
            Ok(fixture("context7.md")),
        );
        let result = fetch_github_candidates(&FakeFetch(responses), "o/r").unwrap();
        assert!(result.servers.iter().any(|server| server.name == "context7"));
    }
}
