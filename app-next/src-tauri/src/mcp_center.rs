//! Read-only MCP connection inventory.
//!
//! This module deliberately does not start MCP servers, execute helper commands,
//! create configuration directories, or modify host-owned configuration files.
//! It extracts only structural metadata and secret *requirements*. Secret values
//! are discarded while parsing and never enter the returned snapshot.

use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use std::collections::{BTreeMap, HashMap};
use std::env;
use std::fs;
use std::path::{Component, Path, PathBuf};

const MAX_CONFIG_BYTES: u64 = 2 * 1024 * 1024;
const MAX_CLAUDE_PROJECTS: usize = 128;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpScanRequest {
    pub home_dir: PathBuf,
    #[serde(default)]
    pub registered_workspaces: Vec<RegisteredWorkspace>,
    /// Profiles must be explicitly registered. We never glob `$CODEX_HOME`.
    #[serde(default)]
    pub registered_codex_profiles: Vec<String>,
    #[serde(default)]
    pub platform: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisteredWorkspace {
    pub id: String,
    pub display_name: String,
    pub path: PathBuf,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpReadOnlySnapshot {
    pub generated_at_unix_ms: u128,
    pub capability_state: String,
    pub summary: McpScanSummary,
    pub hosts: Vec<McpHost>,
    pub config_locations: Vec<McpConfigLocation>,
    pub servers: Vec<McpServer>,
    pub bindings: Vec<McpBinding>,
    pub secret_requirements: Vec<McpSecretRequirement>,
    pub findings: Vec<McpFinding>,
}

pub type McpInventory = McpReadOnlySnapshot;

/// Public command-facing entry point. The caller owns home/workspace discovery;
/// the scanner itself accepts only an explicit, bounded set of locations.
pub fn scan_connections(request: McpScanRequest) -> McpInventory {
    scan_read_only(&request)
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpScanSummary {
    pub host_count: usize,
    pub detected_host_count: usize,
    pub config_count: usize,
    pub server_count: usize,
    pub binding_count: usize,
    pub missing_secret_count: usize,
    pub finding_count: usize,
    pub error_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpHost {
    pub id: String,
    pub adapter_key: String,
    pub display_name: String,
    pub platform: String,
    pub detected: bool,
    pub config_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpConfigLocation {
    pub id: String,
    pub host_id: String,
    pub workspace_id: Option<String>,
    pub native_scope: String,
    pub path_display: String,
    pub parse_status: String,
    pub precedence_rank: u8,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServer {
    pub id: String,
    pub fingerprint: String,
    pub display_name: String,
    pub transport: String,
    pub target_kind: String,
    pub target_display_redacted: String,
    pub provenance_kind: String,
    pub provenance_ref: String,
    pub version_hint: Option<String>,
    /// Static configuration cannot prove live tools/resources/prompts.
    pub capability_state: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpBinding {
    pub id: String,
    pub server_id: String,
    pub host_id: String,
    pub config_location_id: String,
    pub workspace_id: Option<String>,
    pub native_name: String,
    pub native_scope: String,
    pub enabled: bool,
    pub required: bool,
    pub effective_state: String,
    pub approval_state: String,
    pub auth_kind: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpSecretRequirement {
    pub id: String,
    pub binding_id: String,
    /// Environment/header names are identifiers, never values.
    pub key_name: String,
    pub use_kind: String,
    pub presence_state: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpFinding {
    pub id: String,
    pub severity: String,
    pub code: String,
    pub title: String,
    pub message: String,
    pub host_id: String,
    pub config_location_id: Option<String>,
    pub path_display: Option<String>,
}

#[derive(Debug, Clone, Default)]
struct RawBinding {
    name: String,
    transport: String,
    command: Option<String>,
    url: Option<String>,
    enabled: bool,
    required: bool,
    auth_kind: String,
    secret_requirements: Vec<RawSecretRequirement>,
    warnings: Vec<RawWarning>,
}

#[derive(Debug, Clone)]
struct RawSecretRequirement {
    key_name: String,
    use_kind: String,
    presence_state: String,
}

#[derive(Debug, Clone)]
struct RawWarning {
    code: String,
    title: String,
    message: String,
}

#[derive(Debug)]
struct ScanAccumulator<'a> {
    request: &'a McpScanRequest,
    hosts: Vec<McpHost>,
    config_locations: Vec<McpConfigLocation>,
    servers: Vec<McpServer>,
    bindings: Vec<McpBinding>,
    secret_requirements: Vec<McpSecretRequirement>,
    findings: Vec<McpFinding>,
    server_by_fingerprint: HashMap<String, String>,
}

/// Scan registered MCP configuration locations without mutating the filesystem.
pub fn scan_read_only(request: &McpScanRequest) -> McpReadOnlySnapshot {
    let platform = request
        .platform
        .clone()
        .unwrap_or_else(|| env::consts::OS.to_string());
    let mut accumulator = ScanAccumulator {
        request,
        hosts: vec![
            McpHost {
                id: "host-codex".to_string(),
                adapter_key: "openai-codex".to_string(),
                display_name: "ChatGPT Desktop / OpenAI Codex".to_string(),
                platform: platform.clone(),
                detected: false,
                config_count: 0,
            },
            McpHost {
                id: "host-claude-code".to_string(),
                adapter_key: "anthropic-claude-code".to_string(),
                display_name: "Claude Code".to_string(),
                platform,
                detected: false,
                config_count: 0,
            },
        ],
        config_locations: Vec::new(),
        servers: Vec::new(),
        bindings: Vec::new(),
        secret_requirements: Vec::new(),
        findings: Vec::new(),
        server_by_fingerprint: HashMap::new(),
    };

    scan_codex(&mut accumulator);
    scan_claude(&mut accumulator);

    for host in &mut accumulator.hosts {
        host.config_count = accumulator
            .config_locations
            .iter()
            .filter(|location| location.host_id == host.id)
            .count();
        host.detected = host.config_count > 0;
    }

    accumulator.servers.sort_by(|left, right| {
        left.display_name
            .to_lowercase()
            .cmp(&right.display_name.to_lowercase())
            .then(left.id.cmp(&right.id))
    });
    accumulator.bindings.sort_by(|left, right| {
        left.host_id
            .cmp(&right.host_id)
            .then(left.native_scope.cmp(&right.native_scope))
            .then(
                left.native_name
                    .to_lowercase()
                    .cmp(&right.native_name.to_lowercase()),
            )
    });

    let summary = McpScanSummary {
        host_count: accumulator.hosts.len(),
        detected_host_count: accumulator
            .hosts
            .iter()
            .filter(|host| host.detected)
            .count(),
        config_count: accumulator.config_locations.len(),
        server_count: accumulator.servers.len(),
        binding_count: accumulator.bindings.len(),
        missing_secret_count: accumulator
            .secret_requirements
            .iter()
            .filter(|requirement| requirement.presence_state == "missing")
            .count(),
        finding_count: accumulator.findings.len(),
        error_count: accumulator
            .findings
            .iter()
            .filter(|finding| finding.severity == "error")
            .count(),
    };

    McpReadOnlySnapshot {
        generated_at_unix_ms: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_millis())
            .unwrap_or_default(),
        capability_state: "unprobed".to_string(),
        summary,
        hosts: accumulator.hosts,
        config_locations: accumulator.config_locations,
        servers: accumulator.servers,
        bindings: accumulator.bindings,
        secret_requirements: accumulator.secret_requirements,
        findings: accumulator.findings,
    }
}

fn scan_codex(accumulator: &mut ScanAccumulator<'_>) {
    let codex_home = accumulator.request.home_dir.join(".codex");
    scan_codex_config(
        accumulator,
        &codex_home.join("config.toml"),
        None,
        "user",
        30,
    );

    for profile in &accumulator.request.registered_codex_profiles {
        if !is_safe_profile_name(profile) {
            accumulator.push_finding(
                "host-codex",
                None,
                None,
                "warning",
                "codex_profile_name_rejected",
                "已跳过不安全的 Codex Profile 名称",
                "Profile 名称只能包含字母、数字、点、下划线和短横线。",
            );
            continue;
        }
        scan_codex_config(
            accumulator,
            &codex_home.join(format!("{profile}.config.toml")),
            None,
            &format!("profile:{profile}"),
            20,
        );
    }

    let workspaces = accumulator.request.registered_workspaces.clone();
    for workspace in &workspaces {
        scan_codex_config(
            accumulator,
            &workspace.path.join(".codex").join("config.toml"),
            Some(workspace),
            "project",
            10,
        );
    }
}

fn scan_codex_config(
    accumulator: &mut ScanAccumulator<'_>,
    path: &Path,
    workspace: Option<&RegisteredWorkspace>,
    native_scope: &str,
    precedence_rank: u8,
) {
    let path_display = display_config_path(accumulator.request, path, workspace);
    let Some(read_result) = read_existing_config(path) else {
        return;
    };
    let location_id = accumulator.add_location(
        "host-codex",
        workspace.map(|item| item.id.clone()),
        native_scope,
        path_display.clone(),
        precedence_rank,
    );
    let text = match read_result {
        Ok(text) => text,
        Err(code) => {
            accumulator.mark_location_error(&location_id);
            accumulator.push_finding(
                "host-codex",
                Some(location_id),
                Some(path_display),
                "error",
                code,
                "无法安全读取 Codex MCP 配置",
                "配置未被修改；请检查文件大小、链接或读取权限。",
            );
            return;
        }
    };

    match parse_codex_mcp_toml(&text) {
        Ok(bindings) => {
            for binding in bindings {
                accumulator.add_binding(
                    "host-codex",
                    &location_id,
                    workspace,
                    native_scope,
                    &path_display,
                    binding,
                );
            }
        }
        Err(()) => {
            accumulator.mark_location_error(&location_id);
            accumulator.push_finding(
                "host-codex",
                Some(location_id),
                Some(path_display),
                "error",
                "codex_config_parse_failed",
                "Codex MCP 配置格式无法解析",
                "只读扫描已跳过该文件；原配置没有发生任何改变。",
            );
        }
    }
}

fn scan_claude(accumulator: &mut ScanAccumulator<'_>) {
    let mut project_targets: Vec<(PathBuf, Option<RegisteredWorkspace>, usize)> = Vec::new();
    let user_path = accumulator.request.home_dir.join(".claude.json");
    let user_display = display_config_path(accumulator.request, &user_path, None);
    if let Some(read_result) = read_existing_config(&user_path) {
        let location_id = accumulator.add_location(
            "host-claude-code",
            None,
            "user/local",
            user_display.clone(),
            30,
        );
        match read_result {
            Ok(text) => match parse_json_or_jsonc(&text) {
                Ok(root) => {
                    for binding in json_mcp_servers(root.get("mcpServers")) {
                        accumulator.add_binding(
                            "host-claude-code",
                            &location_id,
                            None,
                            "user",
                            &user_display,
                            binding,
                        );
                    }

                    let workspaces = accumulator.request.registered_workspaces.clone();
                    if let Some(projects) = root.get("projects").and_then(JsonValue::as_object) {
                        for (index, (configured_path, project)) in
                            projects.iter().take(MAX_CLAUDE_PROJECTS).enumerate()
                        {
                            let workspace = workspaces
                                .iter()
                                .find(|workspace| {
                                    paths_equivalent(configured_path, &workspace.path)
                                })
                                .cloned();
                            let bindings = json_mcp_servers(project.get("mcpServers"));
                            if !bindings.is_empty() {
                                let local_display = claude_local_config_display(
                                    &user_display,
                                    workspace.as_ref(),
                                    configured_path,
                                    index,
                                );
                                let local_location_id = accumulator.add_location(
                                    "host-claude-code",
                                    workspace.as_ref().map(|item| item.id.clone()),
                                    "user/local",
                                    local_display.clone(),
                                    25,
                                );
                                for binding in bindings {
                                    accumulator.add_binding(
                                        "host-claude-code",
                                        &local_location_id,
                                        workspace.as_ref(),
                                        "local",
                                        &local_display,
                                        binding,
                                    );
                                }
                            }
                            if let Some(project_path) = safe_claude_project_path(configured_path) {
                                project_targets.push((project_path, workspace, index));
                            }
                        }
                    }
                }
                Err(()) => {
                    accumulator.mark_location_error(&location_id);
                    accumulator.push_finding(
                        "host-claude-code",
                        Some(location_id),
                        Some(user_display),
                        "error",
                        "claude_user_config_parse_failed",
                        "Claude Code 用户配置格式无法解析",
                        "只读扫描仅检查 MCP 字段；原配置和其它 Claude 数据均未修改。",
                    );
                }
            },
            Err(code) => {
                accumulator.mark_location_error(&location_id);
                accumulator.push_finding(
                    "host-claude-code",
                    Some(location_id),
                    Some(user_display),
                    "error",
                    code,
                    "无法安全读取 Claude Code 用户配置",
                    "配置未被修改；请检查文件大小、链接或读取权限。",
                );
            }
        }
    }

    let workspaces = accumulator.request.registered_workspaces.clone();
    for workspace in workspaces {
        if let Some(target) = project_targets
            .iter_mut()
            .find(|(path, _, _)| paths_equivalent(&workspace.path.to_string_lossy(), path))
        {
            target.1 = Some(workspace);
        } else {
            let index = project_targets.len();
            project_targets.push((workspace.path.clone(), Some(workspace), index));
        }
    }

    for (project_root, workspace, index) in project_targets {
        let project_path = project_root.join(".mcp.json");
        let path_display = workspace.as_ref().map_or_else(
            || claude_project_config_display(&project_root, index),
            |workspace| display_config_path(accumulator.request, &project_path, Some(workspace)),
        );
        let Some(read_result) = read_existing_config(&project_path) else {
            continue;
        };
        let location_id = accumulator.add_location(
            "host-claude-code",
            workspace.as_ref().map(|item| item.id.clone()),
            "project",
            path_display.clone(),
            20,
        );
        match read_result {
            Ok(text) => match parse_json_or_jsonc(&text) {
                Ok(root) => {
                    for binding in json_mcp_servers(root.get("mcpServers")) {
                        accumulator.add_binding(
                            "host-claude-code",
                            &location_id,
                            workspace.as_ref(),
                            "project",
                            &path_display,
                            binding,
                        );
                    }
                }
                Err(()) => {
                    accumulator.mark_location_error(&location_id);
                    accumulator.push_finding(
                        "host-claude-code",
                        Some(location_id),
                        Some(path_display),
                        "error",
                        "claude_project_config_parse_failed",
                        "项目 MCP 配置格式无法解析",
                        "只读扫描已跳过该文件；原配置没有发生任何改变。",
                    );
                }
            },
            Err(code) => {
                accumulator.mark_location_error(&location_id);
                accumulator.push_finding(
                    "host-claude-code",
                    Some(location_id),
                    Some(path_display),
                    "error",
                    code,
                    "无法安全读取项目 MCP 配置",
                    "配置未被修改；请检查文件大小、链接或读取权限。",
                );
            }
        }
    }
}

impl ScanAccumulator<'_> {
    fn add_location(
        &mut self,
        host_id: &str,
        workspace_id: Option<String>,
        native_scope: &str,
        path_display: String,
        precedence_rank: u8,
    ) -> String {
        let id = format!("cfg-{:016x}", fnv1a64(&format!("{host_id}:{path_display}")));
        self.config_locations.push(McpConfigLocation {
            id: id.clone(),
            host_id: host_id.to_string(),
            workspace_id,
            native_scope: native_scope.to_string(),
            path_display,
            parse_status: "ok".to_string(),
            precedence_rank,
        });
        id
    }

    fn mark_location_error(&mut self, location_id: &str) {
        if let Some(location) = self
            .config_locations
            .iter_mut()
            .find(|location| location.id == location_id)
        {
            location.parse_status = "error".to_string();
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn add_binding(
        &mut self,
        host_id: &str,
        location_id: &str,
        workspace: Option<&RegisteredWorkspace>,
        native_scope: &str,
        path_display: &str,
        raw: RawBinding,
    ) {
        let (target_kind, target_display, target_identity) = if let Some(url) = raw.url.as_deref() {
            ("url", redact_url(url), private_url_identity(url, &raw.name))
        } else if let Some(command) = raw.command.as_deref() {
            let (class_key, class_label) = command_classification(command);
            (
                "command",
                format!("{class_label} · arguments redacted"),
                format!("{class_key}:{}", raw.name.trim().to_lowercase()),
            )
        } else {
            (
                "unknown",
                "未声明目标".to_string(),
                format!("unknown:{}", raw.name.trim().to_lowercase()),
            )
        };
        // Keep raw endpoint identity only inside this bounded scan so equivalent
        // host bindings can be grouped. The serialized id is an opaque sequence,
        // never a hash derived from a potentially sensitive URL or argument.
        let identity_key = format!("{}:{}:{}", raw.transport, target_kind, target_identity);
        let server_id = if let Some(existing) = self.server_by_fingerprint.get(&identity_key) {
            existing.clone()
        } else {
            let server_id = format!("mcp-server-{:04}", self.servers.len() + 1);
            self.servers.push(McpServer {
                id: server_id.clone(),
                fingerprint: server_id.clone(),
                display_name: raw.name.clone(),
                transport: raw.transport.clone(),
                target_kind: target_kind.to_string(),
                target_display_redacted: target_display,
                provenance_kind: "host-config".to_string(),
                provenance_ref: path_display.to_string(),
                version_hint: None,
                capability_state: "unprobed".to_string(),
            });
            self.server_by_fingerprint
                .insert(identity_key, server_id.clone());
            server_id
        };

        let binding_id = format!(
            "binding-{:016x}",
            fnv1a64(&format!(
                "{host_id}:{location_id}:{native_scope}:{}",
                raw.name
            ))
        );
        self.bindings.push(McpBinding {
            id: binding_id.clone(),
            server_id,
            host_id: host_id.to_string(),
            config_location_id: location_id.to_string(),
            workspace_id: workspace.map(|item| item.id.clone()),
            native_name: raw.name,
            native_scope: native_scope.to_string(),
            enabled: raw.enabled,
            required: raw.required,
            effective_state: if raw.enabled {
                "configured"
            } else {
                "disabled"
            }
            .to_string(),
            approval_state: "not-managed".to_string(),
            auth_kind: raw.auth_kind,
        });

        for requirement in raw.secret_requirements {
            let id = format!(
                "secret-{:016x}",
                fnv1a64(&format!(
                    "{binding_id}:{}:{}",
                    requirement.use_kind, requirement.key_name
                ))
            );
            self.secret_requirements.push(McpSecretRequirement {
                id,
                binding_id: binding_id.clone(),
                key_name: sanitize_identifier(&requirement.key_name),
                use_kind: requirement.use_kind,
                presence_state: requirement.presence_state,
            });
        }

        for warning in raw.warnings {
            self.push_finding(
                host_id,
                Some(location_id.to_string()),
                Some(path_display.to_string()),
                "warning",
                &warning.code,
                &warning.title,
                &warning.message,
            );
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn push_finding(
        &mut self,
        host_id: &str,
        config_location_id: Option<String>,
        path_display: Option<String>,
        severity: &str,
        code: &str,
        title: &str,
        message: &str,
    ) {
        let id = format!(
            "finding-{:016x}",
            fnv1a64(&format!(
                "{host_id}:{code}:{}",
                config_location_id.as_deref().unwrap_or_default()
            ))
        );
        self.findings.push(McpFinding {
            id,
            severity: severity.to_string(),
            code: code.to_string(),
            title: title.to_string(),
            message: message.to_string(),
            host_id: host_id.to_string(),
            config_location_id,
            path_display,
        });
    }
}

fn read_existing_config(path: &Path) -> Option<Result<String, &'static str>> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return None,
        Err(_) => return Some(Err("config_metadata_unavailable")),
    };
    if metadata.file_type().is_symlink() {
        return Some(Err("config_symlink_skipped"));
    }
    if !metadata.is_file() {
        return Some(Err("config_not_regular_file"));
    }
    if metadata.len() > MAX_CONFIG_BYTES {
        return Some(Err("config_too_large"));
    }
    Some(
        fs::read_to_string(path)
            .map(|text| text.trim_start_matches('\u{feff}').to_string())
            .map_err(|_| "config_read_failed"),
    )
}

fn parse_codex_mcp_toml(text: &str) -> Result<Vec<RawBinding>, ()> {
    let mut entries: BTreeMap<String, BTreeMap<String, String>> = BTreeMap::new();
    let mut current: Option<(String, String)> = None;
    let mut pending = String::new();
    for raw_line in text.lines() {
        let line = strip_toml_comment(raw_line).trim().to_string();
        if line.is_empty() {
            continue;
        }
        if !pending.is_empty() {
            pending.push(' ');
            pending.push_str(&line);
            if toml_value_complete(&pending) {
                if let Some((name, subsection)) = &current {
                    parse_toml_assignment(&mut entries, name, subsection, &pending)?;
                }
                pending.clear();
            }
            continue;
        }
        if line.starts_with('[') {
            if !line.ends_with(']') || line.starts_with("[[") {
                return Err(());
            }
            current = parse_mcp_toml_section(&line)?;
            continue;
        }
        let Some((name, subsection)) = &current else {
            continue;
        };
        if !line.contains('=') {
            return Err(());
        }
        if !toml_value_complete(&line) {
            pending = line;
            continue;
        }
        parse_toml_assignment(&mut entries, name, subsection, &line)?;
    }
    if !pending.is_empty() {
        return Err(());
    }

    let mut result = Vec::new();
    for (name, values) in entries {
        let command = values.get("command").and_then(|value| toml_string(value));
        let url = values.get("url").and_then(|value| toml_string(value));
        let mut requirements = Vec::new();
        collect_toml_map_requirements(&values, "env", "process-env-inline", &mut requirements);
        collect_toml_map_requirements(
            &values,
            "http_headers",
            "http-header-inline",
            &mut requirements,
        );
        collect_toml_env_reference_requirements(
            &values,
            "env_http_headers",
            "http-header-env",
            &mut requirements,
        );
        if let Some(env_name) = values
            .get("bearer_token_env_var")
            .and_then(|value| toml_string(value))
        {
            requirements.push(env_requirement(&env_name, "bearer-token-env"));
        }
        if let Some(url_value) = url.as_deref() {
            collect_url_secret_requirements(url_value, &mut requirements);
        }
        if let Some(env_names) = values.get("env_vars") {
            for env_name in toml_string_array(env_names) {
                requirements.push(env_requirement(&env_name, "process-env"));
            }
        }
        let args = values
            .get("args")
            .map(|value| toml_string_array(value))
            .unwrap_or_default();
        collect_sensitive_args(&args, &mut requirements);
        let enabled = values
            .get("enabled")
            .and_then(|value| parse_bool(value))
            .unwrap_or(true);
        let required = values
            .get("required")
            .and_then(|value| parse_bool(value))
            .unwrap_or(false);
        let transport = if url.is_some() {
            "http"
        } else if command.is_some() {
            "stdio"
        } else {
            "unknown"
        };
        let auth_kind = auth_kind(&requirements);
        result.push(RawBinding {
            name,
            transport: transport.to_string(),
            command,
            url,
            enabled,
            required,
            auth_kind,
            secret_requirements: requirements,
            warnings: Vec::new(),
        });
    }
    Ok(result)
}

/// Mutation code uses the same bounded static interpretation as the read-only
/// inventory after an atomic write. This validates configuration structure
/// only; it never starts a server or exposes parsed credential values.
pub(crate) fn validate_codex_mcp_config(text: &str) -> bool {
    parse_codex_mcp_toml(text).is_ok()
}

fn parse_mcp_toml_section(line: &str) -> Result<Option<(String, String)>, ()> {
    let inner = line[1..line.len() - 1].trim();
    let Some(rest) = inner.strip_prefix("mcp_servers.") else {
        return Ok(None);
    };
    let parts = split_toml_path(rest)?;
    if parts.is_empty() || parts[0].is_empty() {
        return Err(());
    }
    Ok(Some((parts[0].clone(), parts[1..].join("."))))
}

fn split_toml_path(input: &str) -> Result<Vec<String>, ()> {
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut quote = None;
    let mut escaped = false;
    for character in input.chars() {
        if escaped {
            current.push(character);
            escaped = false;
            continue;
        }
        if character == '\\' && quote == Some('"') {
            escaped = true;
            continue;
        }
        if character == '\'' || character == '"' {
            if quote == Some(character) {
                quote = None;
            } else if quote.is_none() {
                quote = Some(character);
            } else {
                current.push(character);
            }
            continue;
        }
        if character == '.' && quote.is_none() {
            parts.push(current.trim().to_string());
            current.clear();
        } else {
            current.push(character);
        }
    }
    if quote.is_some() || escaped {
        return Err(());
    }
    parts.push(current.trim().to_string());
    Ok(parts)
}

fn parse_toml_assignment(
    entries: &mut BTreeMap<String, BTreeMap<String, String>>,
    name: &str,
    subsection: &str,
    line: &str,
) -> Result<(), ()> {
    let Some((key, value)) = split_unquoted_once(line, '=') else {
        return Err(());
    };
    let key = key.trim().trim_matches(['"', '\'']).to_string();
    if key.is_empty() {
        return Err(());
    }
    let full_key = if subsection.is_empty() {
        key
    } else {
        format!("{subsection}.{key}")
    };
    entries
        .entry(name.to_string())
        .or_default()
        .insert(full_key, value.trim().to_string());
    Ok(())
}

fn collect_toml_map_requirements(
    values: &BTreeMap<String, String>,
    prefix: &str,
    use_kind: &str,
    requirements: &mut Vec<RawSecretRequirement>,
) {
    for key in values.keys() {
        if let Some(name) = key.strip_prefix(&format!("{prefix}.")) {
            requirements.push(RawSecretRequirement {
                key_name: name.to_string(),
                use_kind: use_kind.to_string(),
                presence_state: "inline-value-present".to_string(),
            });
        }
    }
    if let Some(map) = values.get(prefix) {
        for (key, _) in parse_toml_inline_map(map) {
            requirements.push(RawSecretRequirement {
                key_name: key,
                use_kind: use_kind.to_string(),
                presence_state: "inline-value-present".to_string(),
            });
        }
    }
}

fn collect_toml_env_reference_requirements(
    values: &BTreeMap<String, String>,
    prefix: &str,
    use_kind: &str,
    requirements: &mut Vec<RawSecretRequirement>,
) {
    if let Some(map) = values.get(prefix) {
        for (_, raw_value) in parse_toml_inline_map(map) {
            if let Some(env_name) = toml_string(&raw_value) {
                requirements.push(env_requirement(&env_name, use_kind));
            }
        }
    }
    for (key, raw_value) in values {
        if key.starts_with(&format!("{prefix}.")) {
            if let Some(env_name) = toml_string(raw_value) {
                requirements.push(env_requirement(&env_name, use_kind));
            }
        }
    }
}

fn json_mcp_servers(value: Option<&JsonValue>) -> Vec<RawBinding> {
    let Some(servers) = value.and_then(JsonValue::as_object) else {
        return Vec::new();
    };
    servers
        .iter()
        .filter_map(|(name, config)| json_mcp_binding(name, config))
        .collect()
}

fn json_mcp_binding(name: &str, value: &JsonValue) -> Option<RawBinding> {
    let object = value.as_object()?;
    let command = object
        .get("command")
        .and_then(JsonValue::as_str)
        .map(ToString::to_string);
    let url = object
        .get("url")
        .and_then(JsonValue::as_str)
        .map(ToString::to_string);
    let configured_type = object.get("type").and_then(JsonValue::as_str);
    let transport = match configured_type {
        Some("streamable-http") | Some("http") => "http",
        Some("sse") => "sse",
        Some("stdio") => "stdio",
        Some(_) => "unknown",
        None if url.is_some() => "http",
        None if command.is_some() => "stdio",
        None => "unknown",
    };
    let mut requirements = Vec::new();
    collect_json_inline_map_requirements(
        object.get("env"),
        "process-env-inline",
        &mut requirements,
    );
    if let Some(url_value) = url.as_deref() {
        collect_url_secret_requirements(url_value, &mut requirements);
    }
    collect_json_inline_map_requirements(
        object.get("headers"),
        "http-header-inline",
        &mut requirements,
    );
    let args = object
        .get("args")
        .and_then(JsonValue::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(JsonValue::as_str)
                .map(ToString::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    collect_sensitive_args(&args, &mut requirements);
    let mut warnings = Vec::new();
    if object.get("headersHelper").is_some() {
        warnings.push(RawWarning {
            code: "headers_helper_not_executed".to_string(),
            title: "未执行 headersHelper".to_string(),
            message: "只读扫描不会运行外部凭据命令；请在 Claude Code 原生流程中验证。".to_string(),
        });
    }
    let enabled = object
        .get("enabled")
        .and_then(JsonValue::as_bool)
        .or_else(|| {
            object
                .get("disabled")
                .and_then(JsonValue::as_bool)
                .map(|v| !v)
        })
        .unwrap_or(true);
    let auth_kind = auth_kind(&requirements);
    Some(RawBinding {
        name: name.to_string(),
        transport: transport.to_string(),
        command,
        url,
        enabled,
        required: false,
        auth_kind,
        secret_requirements: requirements,
        warnings,
    })
}

fn safe_claude_project_path(configured_path: &str) -> Option<PathBuf> {
    let trimmed = configured_path.trim();
    if trimmed.starts_with(r"\\") || trimmed.starts_with("//") {
        return None;
    }
    let path = PathBuf::from(trimmed);
    if !path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, Component::ParentDir))
    {
        return None;
    }
    Some(path)
}

fn claude_local_config_display(
    user_display: &str,
    workspace: Option<&RegisteredWorkspace>,
    configured_path: &str,
    index: usize,
) -> String {
    let project = workspace.map_or_else(
        || claude_project_reference(configured_path, index),
        |workspace| {
            format!(
                "${{workspace:{}}}",
                sanitize_identifier(&workspace.display_name)
            )
        },
    );
    format!("{user_display} · {project}")
}

fn claude_project_config_display(project_root: &Path, index: usize) -> String {
    format!(
        "{}/.mcp.json",
        claude_project_reference(&project_root.to_string_lossy(), index)
    )
}

fn claude_project_reference(configured_path: &str, index: usize) -> String {
    let label = configured_path
        .trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .next()
        .map(sanitize_identifier)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "project".to_string());
    format!("${{claude-project:{label}-{}}}", index + 1)
}

fn parse_json_or_jsonc(text: &str) -> Result<JsonValue, ()> {
    let stripped = strip_json_comments(text)?;
    let without_trailing_commas = strip_json_trailing_commas(&stripped);
    serde_json::from_str(&without_trailing_commas).map_err(|_| ())
}

/// Claude writes deliberately accept strict JSON only. The read-only scanner
/// remains more tolerant, but a mutation must never erase JSONC comments or
/// trailing commas as a side effect of serialisation.
pub(crate) fn validate_claude_mcp_config_strict(text: &str) -> bool {
    serde_json::from_str::<JsonValue>(text).is_ok_and(|value| value.as_object().is_some())
}

fn strip_json_comments(input: &str) -> Result<String, ()> {
    let chars: Vec<char> = input.chars().collect();
    let mut output = String::with_capacity(input.len());
    let mut index = 0;
    let mut in_string = false;
    let mut escaped = false;
    while index < chars.len() {
        let character = chars[index];
        if in_string {
            output.push(character);
            if escaped {
                escaped = false;
            } else if character == '\\' {
                escaped = true;
            } else if character == '"' {
                in_string = false;
            }
            index += 1;
            continue;
        }
        if character == '"' {
            in_string = true;
            output.push(character);
            index += 1;
            continue;
        }
        if character == '/' && chars.get(index + 1) == Some(&'/') {
            index += 2;
            while index < chars.len() && chars[index] != '\n' {
                index += 1;
            }
            output.push('\n');
            index += usize::from(index < chars.len());
            continue;
        }
        if character == '/' && chars.get(index + 1) == Some(&'*') {
            index += 2;
            let mut closed = false;
            while index + 1 < chars.len() {
                if chars[index] == '*' && chars[index + 1] == '/' {
                    index += 2;
                    closed = true;
                    break;
                }
                if chars[index] == '\n' {
                    output.push('\n');
                }
                index += 1;
            }
            if !closed {
                return Err(());
            }
            continue;
        }
        output.push(character);
        index += 1;
    }
    if in_string {
        return Err(());
    }
    Ok(output)
}

fn strip_json_trailing_commas(input: &str) -> String {
    let chars: Vec<char> = input.chars().collect();
    let mut output = String::with_capacity(input.len());
    let mut index = 0;
    let mut in_string = false;
    let mut escaped = false;
    while index < chars.len() {
        let character = chars[index];
        if in_string {
            output.push(character);
            if escaped {
                escaped = false;
            } else if character == '\\' {
                escaped = true;
            } else if character == '"' {
                in_string = false;
            }
            index += 1;
            continue;
        }
        if character == '"' {
            in_string = true;
            output.push(character);
            index += 1;
            continue;
        }
        if character == ',' {
            let mut lookahead = index + 1;
            while lookahead < chars.len() && chars[lookahead].is_whitespace() {
                lookahead += 1;
            }
            if matches!(chars.get(lookahead), Some('}') | Some(']')) {
                index += 1;
                continue;
            }
        }
        output.push(character);
        index += 1;
    }
    output
}

fn collect_json_inline_map_requirements(
    value: Option<&JsonValue>,
    use_kind: &str,
    requirements: &mut Vec<RawSecretRequirement>,
) {
    let Some(map) = value.and_then(JsonValue::as_object) else {
        return;
    };
    for key in map.keys() {
        requirements.push(RawSecretRequirement {
            key_name: key.clone(),
            use_kind: use_kind.to_string(),
            presence_state: "inline-value-present".to_string(),
        });
    }
}

fn auth_kind(requirements: &[RawSecretRequirement]) -> String {
    let has_inline = requirements
        .iter()
        .any(|requirement| requirement.presence_state == "inline-value-present");
    let has_env = requirements
        .iter()
        .any(|requirement| requirement.use_kind.ends_with("-env"));
    match (has_inline, has_env) {
        (true, true) => "mixed",
        (true, false) => "inline-reference",
        (false, true) => "environment",
        (false, false) => "none",
    }
    .to_string()
}

fn env_requirement(name: &str, use_kind: &str) -> RawSecretRequirement {
    RawSecretRequirement {
        key_name: name.to_string(),
        use_kind: use_kind.to_string(),
        presence_state: if env::var_os(name).is_some() {
            "present"
        } else {
            "missing"
        }
        .to_string(),
    }
}

fn collect_url_secret_requirements(url: &str, requirements: &mut Vec<RawSecretRequirement>) {
    if url.contains('?') {
        requirements.push(RawSecretRequirement {
            key_name: "URL query".to_string(),
            use_kind: "url-query-inline".to_string(),
            presence_state: "inline-value-present".to_string(),
        });
    }
    if let Some(scheme_index) = url.find("://") {
        let authority = url[scheme_index + 3..]
            .split(['/', '?', '#'])
            .next()
            .unwrap_or_default();
        if authority.contains('@') {
            requirements.push(RawSecretRequirement {
                key_name: "URL credentials".to_string(),
                use_kind: "url-credentials-inline".to_string(),
                presence_state: "inline-value-present".to_string(),
            });
        }
    }
}

fn collect_sensitive_args(args: &[String], requirements: &mut Vec<RawSecretRequirement>) {
    let sensitive_markers = [
        "token",
        "secret",
        "password",
        "passwd",
        "api-key",
        "apikey",
        "auth",
        "credential",
    ];
    for (index, argument) in args.iter().enumerate() {
        let lower = argument.to_lowercase();
        if sensitive_markers
            .iter()
            .any(|marker| lower.contains(marker))
        {
            let key = if argument.starts_with('-') {
                argument
                    .split(['=', ':'])
                    .next()
                    .unwrap_or("sensitive-argument")
            } else if index > 0 && args[index - 1].starts_with('-') {
                args[index - 1]
                    .split(['=', ':'])
                    .next()
                    .unwrap_or("sensitive-argument")
            } else {
                "sensitive-argument"
            };
            let has_inline =
                argument.contains('=') || argument.contains(':') || args.get(index + 1).is_some();
            requirements.push(RawSecretRequirement {
                key_name: key.to_string(),
                use_kind: "command-argument".to_string(),
                presence_state: if has_inline {
                    "inline-value-present"
                } else {
                    "declared"
                }
                .to_string(),
            });
        }
    }
}

fn sanitize_identifier(value: &str) -> String {
    value
        .chars()
        .filter(|character| {
            character.is_ascii_alphanumeric()
                || matches!(character, '_' | '-' | '.' | ':' | '/' | ' ')
        })
        .take(120)
        .collect()
}

fn redact_url(value: &str) -> String {
    match url_scheme(value) {
        Some("https") => "HTTPS remote endpoint · address redacted".to_string(),
        Some("http") => "HTTP remote endpoint · address redacted".to_string(),
        Some("sse") => "SSE remote endpoint · address redacted".to_string(),
        _ => "Remote endpoint · address redacted".to_string(),
    }
}

fn url_scheme(value: &str) -> Option<&str> {
    let (scheme, _) = value.trim().split_once("://")?;
    if scheme.eq_ignore_ascii_case("https") {
        Some("https")
    } else if scheme.eq_ignore_ascii_case("http") {
        Some("http")
    } else if scheme.eq_ignore_ascii_case("sse") {
        Some("sse")
    } else {
        None
    }
}

fn private_url_identity(value: &str, native_name: &str) -> String {
    let without_query = value.split(['?', '#']).next().unwrap_or_default().trim();
    let Some((scheme, remainder)) = without_query.split_once("://") else {
        return format!("remote:{}", native_name.trim().to_lowercase());
    };
    let authority_end = remainder.find('/').unwrap_or(remainder.len());
    let authority = remainder[..authority_end]
        .rsplit_once('@')
        .map(|(_, host)| host)
        .unwrap_or(&remainder[..authority_end]);
    if authority.is_empty() {
        return format!("remote:{}", native_name.trim().to_lowercase());
    }
    format!(
        "{}://{}{}",
        scheme.to_lowercase(),
        authority.to_lowercase(),
        &remainder[authority_end..]
    )
}

fn command_classification(command: &str) -> (&'static str, &'static str) {
    let trimmed = command.trim();
    let unquoted = if trimmed.len() >= 2
        && ((trimmed.starts_with('"') && trimmed.ends_with('"'))
            || (trimmed.starts_with('\'') && trimmed.ends_with('\'')))
    {
        &trimmed[1..trimmed.len() - 1]
    } else {
        trimmed
    };
    let executable = unquoted
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    let executable = executable
        .strip_suffix(".exe")
        .or_else(|| executable.strip_suffix(".cmd"))
        .or_else(|| executable.strip_suffix(".bat"))
        .unwrap_or(&executable);
    match executable {
        "npx" => ("package-runner:npx", "npx package runner"),
        "pnpx" => ("package-runner:pnpx", "pnpx package runner"),
        "bunx" => ("package-runner:bunx", "bunx package runner"),
        "uvx" => ("package-runner:uvx", "uvx package runner"),
        "npm" => ("package-manager:npm", "npm package manager"),
        "pnpm" => ("package-manager:pnpm", "pnpm package manager"),
        "yarn" | "yarnpkg" => ("package-manager:yarn", "Yarn package manager"),
        "node" => ("runtime:node", "Node.js runtime"),
        "python" | "python3" | "py" => ("runtime:python", "Python runtime"),
        "deno" => ("runtime:deno", "Deno runtime"),
        "bun" => ("runtime:bun", "Bun runtime"),
        "java" => ("runtime:java", "Java runtime"),
        "dotnet" => ("runtime:dotnet", ".NET runtime"),
        "docker" | "podman" => ("container-runtime", "Container runtime"),
        "powershell" | "pwsh" | "cmd" | "bash" | "sh" | "zsh" => ("shell", "Shell executable"),
        _ => ("custom-executable", "Custom executable"),
    }
}

fn display_config_path(
    request: &McpScanRequest,
    path: &Path,
    workspace: Option<&RegisteredWorkspace>,
) -> String {
    if let Some(workspace) = workspace {
        if let Ok(relative) = path.strip_prefix(&workspace.path) {
            return format!(
                "${{workspace:{}}}/{}",
                sanitize_identifier(&workspace.display_name),
                normalize_path(relative)
            );
        }
    }
    redact_path(path, &request.home_dir)
}

fn redact_path(path: &Path, home: &Path) -> String {
    if let Ok(relative) = path.strip_prefix(home) {
        let relative = normalize_path(relative);
        return if relative.is_empty() {
            "~".to_string()
        } else {
            format!("~/{relative}")
        };
    }
    let path_text = normalize_path(path);
    let home_text = normalize_path(home);
    if !home_text.is_empty()
        && path_text
            .to_lowercase()
            .starts_with(&home_text.to_lowercase())
    {
        return format!("~{}", &path_text[home_text.len()..]);
    }
    "<registered-path>".to_string()
}

fn normalize_path(path: &Path) -> String {
    path.components()
        .filter_map(|component| match component {
            Component::Normal(value) => value.to_str().map(ToString::to_string),
            Component::Prefix(value) => Some(value.as_os_str().to_string_lossy().to_string()),
            Component::RootDir => Some(String::new()),
            Component::CurDir => None,
            Component::ParentDir => Some("..".to_string()),
        })
        .collect::<Vec<_>>()
        .join("/")
}

fn paths_equivalent(configured_path: &str, actual_path: &Path) -> bool {
    let normalize = |value: &str| {
        value
            .trim_start_matches(r"\\?\")
            .replace('\\', "/")
            .trim_end_matches('/')
            .to_string()
    };
    let configured = normalize(configured_path);
    let actual = normalize(&actual_path.to_string_lossy());
    if cfg!(windows) {
        configured.eq_ignore_ascii_case(&actual)
    } else {
        configured == actual
    }
}

fn is_safe_profile_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 80
        && value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
        })
        && !value.contains("..")
}

fn strip_toml_comment(line: &str) -> &str {
    let mut quote = None;
    let mut escaped = false;
    for (index, character) in line.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        if character == '\\' && quote == Some('"') {
            escaped = true;
            continue;
        }
        if character == '\'' || character == '"' {
            if quote == Some(character) {
                quote = None;
            } else if quote.is_none() {
                quote = Some(character);
            }
        } else if character == '#' && quote.is_none() {
            return &line[..index];
        }
    }
    line
}

fn toml_value_complete(value: &str) -> bool {
    let mut quote = None;
    let mut escaped = false;
    let mut square = 0_i32;
    let mut curly = 0_i32;
    for character in value.chars() {
        if escaped {
            escaped = false;
            continue;
        }
        if character == '\\' && quote == Some('"') {
            escaped = true;
            continue;
        }
        if character == '\'' || character == '"' {
            if quote == Some(character) {
                quote = None;
            } else if quote.is_none() {
                quote = Some(character);
            }
            continue;
        }
        if quote.is_none() {
            match character {
                '[' => square += 1,
                ']' => square -= 1,
                '{' => curly += 1,
                '}' => curly -= 1,
                _ => {}
            }
        }
    }
    quote.is_none() && square == 0 && curly == 0
}

fn split_unquoted_once(input: &str, delimiter: char) -> Option<(&str, &str)> {
    let mut quote = None;
    let mut escaped = false;
    for (index, character) in input.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        if character == '\\' && quote == Some('"') {
            escaped = true;
            continue;
        }
        if character == '\'' || character == '"' {
            if quote == Some(character) {
                quote = None;
            } else if quote.is_none() {
                quote = Some(character);
            }
        } else if character == delimiter && quote.is_none() {
            return Some((&input[..index], &input[index + delimiter.len_utf8()..]));
        }
    }
    None
}

fn toml_string(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.len() < 2 {
        return None;
    }
    let quote = trimmed.chars().next()?;
    if (quote != '"' && quote != '\'') || !trimmed.ends_with(quote) {
        return None;
    }
    let inner = &trimmed[1..trimmed.len() - 1];
    if quote == '\'' {
        Some(inner.to_string())
    } else {
        let mut result = String::new();
        let mut escaped = false;
        for character in inner.chars() {
            if escaped {
                result.push(match character {
                    'n' => '\n',
                    'r' => '\r',
                    't' => '\t',
                    other => other,
                });
                escaped = false;
            } else if character == '\\' {
                escaped = true;
            } else {
                result.push(character);
            }
        }
        if escaped {
            result.push('\\');
        }
        Some(result)
    }
}

fn toml_string_array(value: &str) -> Vec<String> {
    let trimmed = value.trim();
    if !trimmed.starts_with('[') || !trimmed.ends_with(']') {
        return Vec::new();
    }
    split_unquoted_list(&trimmed[1..trimmed.len() - 1], ',')
        .into_iter()
        .filter_map(|item| toml_string(item.trim()))
        .collect()
}

fn parse_toml_inline_map(value: &str) -> Vec<(String, String)> {
    let trimmed = value.trim();
    if !trimmed.starts_with('{') || !trimmed.ends_with('}') {
        return Vec::new();
    }
    split_unquoted_list(&trimmed[1..trimmed.len() - 1], ',')
        .into_iter()
        .filter_map(|item| {
            let (key, raw_value) = split_unquoted_once(item.trim(), '=')?;
            Some((
                key.trim().trim_matches(['"', '\'']).to_string(),
                raw_value.trim().to_string(),
            ))
        })
        .collect()
}

fn split_unquoted_list(input: &str, delimiter: char) -> Vec<&str> {
    let mut result = Vec::new();
    let mut start = 0;
    let mut quote = None;
    let mut escaped = false;
    let mut square = 0_i32;
    let mut curly = 0_i32;
    for (index, character) in input.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        if character == '\\' && quote == Some('"') {
            escaped = true;
            continue;
        }
        if character == '\'' || character == '"' {
            if quote == Some(character) {
                quote = None;
            } else if quote.is_none() {
                quote = Some(character);
            }
            continue;
        }
        if quote.is_none() {
            match character {
                '[' => square += 1,
                ']' => square -= 1,
                '{' => curly += 1,
                '}' => curly -= 1,
                _ => {}
            }
            if character == delimiter && square == 0 && curly == 0 {
                result.push(&input[start..index]);
                start = index + character.len_utf8();
            }
        }
    }
    result.push(&input[start..]);
    result
}

fn parse_bool(value: &str) -> Option<bool> {
    match value.trim() {
        "true" => Some(true),
        "false" => Some(false),
        _ => None,
    }
}

fn fnv1a64(value: &str) -> u64 {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in value.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    struct TestDir(PathBuf);

    impl TestDir {
        fn new(label: &str) -> Self {
            let unique = format!(
                "ai-skillhub-mcp-{label}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            );
            let path = env::temp_dir().join(unique);
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn request(home: &Path) -> McpScanRequest {
        McpScanRequest {
            home_dir: home.to_path_buf(),
            registered_workspaces: Vec::new(),
            registered_codex_profiles: Vec::new(),
            platform: Some("test".to_string()),
        }
    }

    fn write(path: &Path, content: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut file = fs::File::create(path).unwrap();
        file.write_all(content.as_bytes()).unwrap();
    }

    #[test]
    fn missing_configs_do_not_create_directories() {
        let root = TestDir::new("missing");
        let home = root.path().join("never-created-home");
        let snapshot = scan_read_only(&request(&home));
        assert!(!home.exists());
        assert_eq!(snapshot.summary.config_count, 0);
        assert_eq!(snapshot.summary.binding_count, 0);
    }

    #[test]
    fn broken_configs_become_findings_without_panicking() {
        let root = TestDir::new("broken");
        write(
            &root.path().join(".codex/config.toml"),
            "[mcp_servers.\"broken\"\n",
        );
        write(&root.path().join(".claude.json"), "{\"mcpServers\":");
        let snapshot = scan_read_only(&request(root.path()));
        assert_eq!(snapshot.summary.error_count, 2);
        assert!(snapshot
            .config_locations
            .iter()
            .all(|location| location.parse_status == "error"));
    }

    #[test]
    fn secret_values_never_leave_the_scanner() {
        let root = TestDir::new("secret");
        write(
            &root.path().join(".codex/config.toml"),
            r#"
[mcp_servers.demo]
url = "https://user:SUPER_URL_SECRET@example.test/mcp?apiKey=SUPER_QUERY_SECRET"
bearer_token_env_var = "AI_SKILLHUB_TEST_MISSING_TOKEN"
http_headers = { "X-Api-Key" = "SUPER_HEADER_SECRET" }
env = { PRIVATE_KEY = "SUPER_ENV_SECRET" }
"#,
        );
        write(
            &root.path().join(".claude.json"),
            r#"{
              "mcpServers": {
                "local": {
                  "command": "npx",
                  "args": ["@example/server", "--token", "SUPER_ARG_SECRET"],
                  "env": {"CLAUDE_KEY": "SUPER_CLAUDE_SECRET"},
                  "headers": {"Authorization": "SUPER_AUTH_SECRET"}
                }
              },
              "oauthAccount": {"accessToken": "SUPER_OAUTH_SECRET"}
            }"#,
        );
        let snapshot = scan_read_only(&request(root.path()));
        let serialized = serde_json::to_string(&snapshot).unwrap();
        for secret in [
            "SUPER_URL_SECRET",
            "SUPER_QUERY_SECRET",
            "SUPER_HEADER_SECRET",
            "SUPER_ENV_SECRET",
            "SUPER_ARG_SECRET",
            "SUPER_CLAUDE_SECRET",
            "SUPER_AUTH_SECRET",
            "SUPER_OAUTH_SECRET",
        ] {
            assert!(!serialized.contains(secret), "leaked {secret}");
        }
        assert!(serialized.contains("PRIVATE_KEY"));
        assert!(serialized.contains("Authorization"));
        assert!(serialized.contains("unprobed"));
    }

    #[test]
    fn target_displays_never_include_command_arguments_or_url_details() {
        let root = TestDir::new("target-display-redaction");
        write(
            &root.path().join(".codex/config.toml"),
            r#"
[mcp_servers.keyed]
command = "npx"
args = ["--key", "KEY_VALUE_MUST_NOT_LEAK"]

[mcp_servers.remote]
url = "https://example.test/PATH_TOKEN_MUST_NOT_LEAK?token=QUERY_TOKEN_MUST_NOT_LEAK#FRAGMENT_TOKEN_MUST_NOT_LEAK"
"#,
        );
        write(
            &root.path().join(".claude.json"),
            r#"{
              "mcpServers": {
                "positional": {
                  "command": "python",
                  "args": ["UNNAMED_POSITIONAL_TOKEN_MUST_NOT_LEAK"]
                }
              }
            }"#,
        );

        let snapshot = scan_read_only(&request(root.path()));
        let target_display = |native_name: &str| {
            let binding = snapshot
                .bindings
                .iter()
                .find(|binding| binding.native_name == native_name)
                .unwrap();
            snapshot
                .servers
                .iter()
                .find(|server| server.id == binding.server_id)
                .unwrap()
                .target_display_redacted
                .clone()
        };

        assert_eq!(
            target_display("keyed"),
            "npx package runner · arguments redacted"
        );
        assert_eq!(
            target_display("positional"),
            "Python runtime · arguments redacted"
        );
        assert_eq!(
            target_display("remote"),
            "HTTPS remote endpoint · address redacted"
        );

        let serialized = serde_json::to_string(&snapshot).unwrap();
        for sensitive_value in [
            "KEY_VALUE_MUST_NOT_LEAK",
            "UNNAMED_POSITIONAL_TOKEN_MUST_NOT_LEAK",
            "example.test",
            "PATH_TOKEN_MUST_NOT_LEAK",
            "QUERY_TOKEN_MUST_NOT_LEAK",
            "FRAGMENT_TOKEN_MUST_NOT_LEAK",
        ] {
            assert!(
                !serialized.contains(sensitive_value),
                "leaked {sensitive_value}"
            );
        }
    }

    #[test]
    fn same_logical_server_can_have_distinct_host_bindings() {
        let root = TestDir::new("bindings");
        write(
            &root.path().join(".codex/config.toml"),
            r#"[mcp_servers.codex_name]
url = "https://mcp.example.test/api?token=FIRST"
"#,
        );
        write(
            &root.path().join(".claude.json"),
            r#"{"mcpServers":{"claude_name":{"type":"http","url":"https://mcp.example.test/api?token=SECOND"}}}"#,
        );
        let snapshot = scan_read_only(&request(root.path()));
        assert_eq!(snapshot.servers.len(), 1);
        assert_eq!(snapshot.bindings.len(), 2);
        assert_ne!(snapshot.bindings[0].id, snapshot.bindings[1].id);
        assert_eq!(
            snapshot.bindings[0].server_id,
            snapshot.bindings[1].server_id
        );
    }

    #[test]
    fn registered_windows_and_macos_workspace_paths_are_redacted() {
        let windows_home = PathBuf::from(r"C:\Users\Example");
        let windows_config = windows_home.join(".codex").join("config.toml");
        assert_eq!(
            redact_path(&windows_config, &windows_home),
            "~/.codex/config.toml"
        );

        let mac_home = PathBuf::from("/Users/example");
        let mac_config = mac_home.join(".claude.json");
        assert_eq!(redact_path(&mac_config, &mac_home), "~/.claude.json");

        let workspace = RegisteredWorkspace {
            id: "w1".to_string(),
            display_name: "Paper Lab".to_string(),
            path: PathBuf::from("/Users/example/Work/Paper"),
        };
        let request = McpScanRequest {
            home_dir: mac_home,
            registered_workspaces: vec![workspace.clone()],
            registered_codex_profiles: Vec::new(),
            platform: Some("macos".to_string()),
        };
        assert_eq!(
            display_config_path(
                &request,
                &workspace.path.join(".mcp.json"),
                Some(&workspace)
            ),
            "${workspace:Paper Lab}/.mcp.json"
        );
        assert_eq!(
            claude_project_reference(r"C:\Users\Example\Private\SecretProject", 0),
            "${claude-project:SecretProject-1}"
        );
    }

    #[test]
    fn claude_known_projects_are_discovered_without_becoming_writable() {
        let root = TestDir::new("claude-local");
        let registered = root.path().join("registered");
        let unregistered = root.path().join("unregistered");
        write(
            &unregistered.join(".mcp.json"),
            r#"{"mcpServers":{"project-file":{"command":"node","args":["project.js"]}}}"#,
        );
        let json = serde_json::json!({
            "projects": {
                registered.to_string_lossy().to_string(): {
                    "mcpServers": { "kept": { "command": "node", "args": ["server.js"] } }
                },
                unregistered.to_string_lossy().to_string(): {
                    "mcpServers": { "jCodeMunch": { "command": "node", "args": ["other.js"] } }
                }
            }
        });
        write(&root.path().join(".claude.json"), &json.to_string());
        let mut scan_request = request(root.path());
        scan_request
            .registered_workspaces
            .push(RegisteredWorkspace {
                id: "registered".to_string(),
                display_name: "Registered".to_string(),
                path: registered,
            });
        let snapshot = scan_read_only(&scan_request);
        assert_eq!(snapshot.bindings.len(), 3);
        assert!(snapshot
            .bindings
            .iter()
            .any(|binding| binding.native_name == "kept"
                && binding.workspace_id.as_deref() == Some("registered")));
        let discovered = snapshot
            .bindings
            .iter()
            .find(|binding| binding.native_name == "jCodeMunch")
            .expect("Claude-known local binding should be inventoried");
        assert_eq!(discovered.native_scope, "local");
        assert_eq!(discovered.workspace_id, None);
        assert!(snapshot
            .bindings
            .iter()
            .any(|binding| binding.native_name == "project-file"
                && binding.native_scope == "project"
                && binding.workspace_id.is_none()));
        let serialized = serde_json::to_string(&snapshot).unwrap();
        assert!(!serialized.contains(&unregistered.to_string_lossy().to_string()));
    }

    #[test]
    fn headers_helper_is_reported_but_never_executed() {
        let root = TestDir::new("headers-helper");
        write(
            &root.path().join(".claude.json"),
            r#"{"mcpServers":{"remote":{"url":"https://example.test/mcp","headersHelper":"SHOULD_NEVER_RUN"}}}"#,
        );
        let snapshot = scan_read_only(&request(root.path()));
        assert!(snapshot
            .findings
            .iter()
            .any(|finding| finding.code == "headers_helper_not_executed"));
        assert!(!serde_json::to_string(&snapshot)
            .unwrap()
            .contains("SHOULD_NEVER_RUN"));
    }
}
