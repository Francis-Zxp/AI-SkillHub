//! Safe, static-only MCP configuration import from a public GitHub repository.
//! This module never starts a server, never uses GitHub credentials, and never
//! returns or persists configuration values that could be credentials.

use serde::{Deserialize, Serialize};
use serde_json::Value;
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
            return Ok(McpGithubImportPreview {
                source_display: format!(
                    "github.com/{}/{}/{}",
                    repository.owner, repository.repo, config_name
                ),
                candidates,
            });
        }
    }

    Err("该 GitHub 仓库根目录未找到 .mcp.json 或 mcp.json；可改用手动填写。".to_string())
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
            if command.is_empty() || contains_credential_like_value(command) {
                return None;
            }
            let args = string_array(object.get("args"))?;
            if args.len() > 64
                || args
                    .iter()
                    .any(|argument| contains_credential_like_value(argument))
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
    value.len() <= 64
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

fn contains_credential_like_value(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    value.contains('=')
        || ["sk-", "github_pat_", "ghp_", "xox", "aiza", "akia", "eyj"]
            .iter()
            .any(|prefix| lower.contains(prefix))
}

#[cfg(test)]
mod tests {
    use super::*;

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
