//! Shared parser for pasted MCP configuration (docs/v3.3/mcp-contract.md §3.6).
//!
//! Used by "paste a config", the GitHub README import and nothing else that
//! could run code: this module is pure text processing. It never touches the
//! file system or the network, never starts a process, and never logs values.
//! Secret-looking values are classified here; the caller moves them into the
//! in-memory paste vault and never returns them to the webview.

use crate::mcp_json_doc::{Node, ObjectMap};
use crate::mcp_mutation;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

pub(crate) const MAX_PASTE_BYTES: usize = 256 * 1024;
pub(crate) const MAX_CANDIDATES: usize = 24;
pub(crate) const MAX_ARGS: usize = 64;

/// Recognised shapes. Serialised as the contract's `McpPasteFormat`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PasteFormat {
    McpServers,
    Named,
    Single,
    CodexToml,
    CodexJson,
    Vscode,
    Opencode,
    Readme,
}

impl PasteFormat {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            PasteFormat::McpServers => "mcp-servers",
            PasteFormat::Named => "named",
            PasteFormat::Single => "single",
            PasteFormat::CodexToml => "codex-toml",
            PasteFormat::CodexJson => "codex-json",
            PasteFormat::Vscode => "vscode",
            PasteFormat::Opencode => "opencode",
            PasteFormat::Readme => "readme",
        }
    }
}

/// One recognised server. Values in `env` / `headers` may be secrets: they
/// are classified by [`classify_env_value`] / [`classify_header_value`] and
/// must never be returned to the webview as they are.
#[derive(Clone, Default)]
pub(crate) struct ParsedServer {
    pub name: String,
    pub name_suggested: bool,
    /// "stdio" | "http" | "sse"
    pub transport: &'static str,
    pub command: Option<String>,
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub url: Option<String>,
    pub env: Vec<(String, String)>,
    pub headers: Vec<(String, String)>,
    /// Codex `env_vars = ["NAME"]` (forwarded references).
    pub env_refs: Vec<String>,
    /// Codex `env_http_headers = {H = "NAME"}`.
    pub header_env_refs: Vec<(String, String)>,
    /// Codex `bearer_token_env_var`.
    pub bearer_env: Option<String>,
    pub codex_required: bool,
    pub warnings: Vec<&'static str>,
}

impl std::fmt::Debug for ParsedServer {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ParsedServer")
            .field("name", &self.name)
            .field("transport", &self.transport)
            .field("args", &self.args.len())
            .field("env", &self.env.len())
            .field("headers", &self.headers.len())
            .finish()
    }
}

#[derive(Debug, Default)]
pub(crate) struct ParseOutcome {
    pub format: Option<PasteFormat>,
    pub servers: Vec<ParsedServer>,
    /// (name, McpSkipReason)
    pub skipped: Vec<(String, &'static str)>,
}

/// Parses pasted text. `Err("paste-too-large")` above 256 KiB; an
/// unrecognised text is `Ok` with `format: None`.
pub(crate) fn parse(text: &str) -> Result<ParseOutcome, &'static str> {
    if text.len() > MAX_PASTE_BYTES {
        return Err("paste-too-large");
    }
    let body = strip_fence(text.trim_start_matches('\u{feff}'));
    if body.trim().is_empty() {
        return Ok(ParseOutcome::default());
    }
    if body
        .lines()
        .any(|line| line.trim_start().starts_with("[mcp_servers."))
    {
        return Ok(parse_codex_toml(body));
    }
    let Some(root) = parse_json_lenient(body) else {
        return Ok(ParseOutcome::default());
    };
    Ok(parse_json_root(&root))
}

/// Strips one surrounding Markdown code fence (any language).
fn strip_fence(text: &str) -> &str {
    let trimmed = text.trim();
    for marker in ["```", "~~~"] {
        if let Some(rest) = trimmed.strip_prefix(marker) {
            let after_info = rest.split_once('\n').map(|(_, body)| body).unwrap_or("");
            let body = after_info.trim_end();
            return body.strip_suffix(marker).unwrap_or(body);
        }
    }
    trimmed
}

/// Strict JSON, then JSONC (comments, trailing commas), then a bare
/// `"name": { … }` fragment wrapped in braces.
pub(crate) fn parse_json_lenient(text: &str) -> Option<Node> {
    let attempt = |candidate: &str| -> Option<Node> {
        if let Some(node) = Node::from_json_text(candidate) {
            return Some(node);
        }
        crate::mcp_json_doc::parse_jsonc_node(candidate).ok()
    };
    let trimmed = text.trim();
    if let Some(node) = attempt(trimmed) {
        return Some(node);
    }
    if trimmed.starts_with('"') {
        let wrapped = format!("{{{}}}", trimmed.trim_end_matches(','));
        return attempt(&wrapped);
    }
    None
}

fn parse_json_root(root: &Node) -> ParseOutcome {
    let Some(object) = root.as_object() else {
        return ParseOutcome::default();
    };
    if let Some(servers) = object.get("mcpServers").and_then(Node::as_object) {
        return parse_named_map(servers, PasteFormat::McpServers);
    }
    if let Some(servers) = object.get("servers").and_then(Node::as_object) {
        return parse_named_map(servers, PasteFormat::Vscode);
    }
    if let Some(mcp) = object.get("mcp").and_then(Node::as_object) {
        if let Some(servers) = mcp.get("servers").and_then(Node::as_object) {
            return parse_named_map(servers, PasteFormat::Vscode);
        }
        let opencode = !mcp.is_empty()
            && mcp.iter().all(|(_, value)| {
                value
                    .get("type")
                    .and_then(Node::as_str)
                    .is_some_and(|kind| kind == "local" || kind == "remote")
                    || value.get("command").and_then(Node::as_array).is_some()
            });
        if opencode {
            return parse_named_map(mcp, PasteFormat::Opencode);
        }
    }
    if let Some(servers) = object.get("mcp_servers").and_then(Node::as_object) {
        return parse_named_map(servers, PasteFormat::CodexJson);
    }
    if is_server_object(object) {
        let mut outcome = ParseOutcome {
            format: Some(PasteFormat::Single),
            ..ParseOutcome::default()
        };
        match parse_json_entry("", object, PasteFormat::Single) {
            Ok(mut server) => {
                server.name = suggest_name(&server);
                server.name_suggested = true;
                outcome.servers.push(server);
            }
            Err(reason) => outcome.skipped.push((String::new(), reason)),
        }
        return outcome;
    }
    if !object.is_empty()
        && object
            .iter()
            .all(|(_, value)| value.as_object().is_some_and(is_server_object))
    {
        return parse_named_map(object, PasteFormat::Named);
    }
    ParseOutcome::default()
}

fn is_server_object(object: &ObjectMap) -> bool {
    matches!(
        object.get("command"),
        Some(Node::String(_)) | Some(Node::Array(_))
    ) || object.get("url").and_then(Node::as_str).is_some()
}

fn parse_named_map(map: &ObjectMap, format: PasteFormat) -> ParseOutcome {
    let mut outcome = ParseOutcome {
        format: Some(format),
        ..ParseOutcome::default()
    };
    for (name, value) in map.iter() {
        if outcome.servers.len() >= MAX_CANDIDATES {
            outcome.skipped.push((name.clone(), "too-many-args"));
            continue;
        }
        let Some(object) = value.as_object() else {
            outcome.skipped.push((name.clone(), "unknown-type"));
            continue;
        };
        match parse_json_entry(name, object, format) {
            Ok(mut server) => match normalize_name(name) {
                Some((normalized, suggested)) => {
                    server.name = normalized;
                    server.name_suggested = suggested;
                    outcome.servers.push(server);
                }
                None => outcome.skipped.push((name.clone(), "invalid-name")),
            },
            Err(reason) => outcome.skipped.push((name.clone(), reason)),
        }
    }
    outcome
}

fn string_field(object: &ObjectMap, key: &str) -> Option<String> {
    object
        .get(key)
        .and_then(Node::as_str)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn string_pairs(value: Option<&Node>) -> Vec<(String, String)> {
    let Some(map) = value.and_then(Node::as_object) else {
        return Vec::new();
    };
    map.iter()
        .filter_map(|(key, value)| match value {
            Node::String(text) => Some((key.clone(), text.clone())),
            Node::Number(number) => Some((key.clone(), number.to_string())),
            Node::Bool(flag) => Some((key.clone(), flag.to_string())),
            _ => None,
        })
        .collect()
}

fn parse_json_entry(
    name: &str,
    object: &ObjectMap,
    format: PasteFormat,
) -> Result<ParsedServer, &'static str> {
    let declared = object.get("type").and_then(Node::as_str);
    let (mut command, mut args) = match object.get("command") {
        Some(Node::String(text)) => (Some(text.trim().to_string()), Vec::new()),
        Some(Node::Array(items)) => {
            let mut parts = items
                .iter()
                .map(|item| item.as_str().map(str::to_string).ok_or("unknown-type"))
                .collect::<Result<Vec<_>, _>>()?;
            if parts.is_empty() {
                return Err("unknown-type");
            }
            let first = parts.remove(0);
            (Some(first), parts)
        }
        Some(_) => return Err("unknown-type"),
        None => (None, Vec::new()),
    };
    if let Some(Node::Array(items)) = object.get("args") {
        for item in items {
            match item {
                Node::String(text) => args.push(text.clone()),
                Node::Number(number) => args.push(number.to_string()),
                _ => return Err("unknown-type"),
            }
        }
    }
    let url = string_field(object, "url").or_else(|| string_field(object, "serverUrl"));
    let transport = match declared {
        Some("stdio") | Some("local") => "stdio",
        Some("http") | Some("streamable-http") | Some("streamableHttp") | Some("remote") => "http",
        Some("sse") => "sse",
        Some(_) => return Err("unknown-type"),
        None if url.is_some() && command.is_none() => "http",
        None => "stdio",
    };
    let mut server = ParsedServer {
        name: name.to_string(),
        transport,
        ..ParsedServer::default()
    };
    if transport == "stdio" {
        let Some(raw_command) = command.take().filter(|value| !value.is_empty()) else {
            return Err("unknown-type");
        };
        let (command, args, unwrapped) = unwrap_windows_cmd(raw_command, args);
        if unwrapped {
            server.warnings.push("windows-cmd-unwrapped");
        }
        if args.len() > MAX_ARGS {
            return Err("too-many-args");
        }
        if mcp_mutation::validate_command(&command).is_err() {
            return Err("shell-command");
        }
        if mcp_mutation::validate_arguments(&args).is_err() {
            return Err("secret-in-args");
        }
        if mcp_mutation::command_stem(&command) == "docker" {
            server.warnings.push("docker-needs-running");
        }
        server.command = Some(command);
        server.args = args;
        server.cwd = string_field(object, "cwd");
        let env_key = if format == PasteFormat::Opencode {
            "environment"
        } else {
            "env"
        };
        server.env = string_pairs(object.get(env_key));
    } else {
        let Some(url) = url else {
            return Err("invalid-url");
        };
        if mcp_mutation::validate_safe_url(&url).is_err() {
            return Err("invalid-url");
        }
        server.url = Some(url);
        server.headers = string_pairs(object.get("headers"));
        server
            .headers
            .extend(string_pairs(object.get("http_headers")));
    }
    if format == PasteFormat::CodexJson {
        apply_codex_reference_keys_json(object, &mut server)?;
    }
    if server.env.len() > MAX_ARGS || server.headers.len() > MAX_ARGS {
        return Err("too-many-args");
    }
    Ok(server)
}

fn apply_codex_reference_keys_json(
    object: &ObjectMap,
    server: &mut ParsedServer,
) -> Result<(), &'static str> {
    if let Some(Node::Array(items)) = object.get("env_vars") {
        for item in items {
            let name = item.as_str().ok_or("codex-structured-env")?;
            server.env_refs.push(name.to_string());
        }
    }
    for (header, variable) in string_pairs(object.get("env_http_headers")) {
        server.header_env_refs.push((header, variable));
    }
    server.bearer_env = string_field(object, "bearer_token_env_var");
    server.codex_required = object.get("required").and_then(Node::as_bool) == Some(true);
    Ok(())
}

fn parse_codex_toml(text: &str) -> ParseOutcome {
    let mut outcome = ParseOutcome {
        format: Some(PasteFormat::CodexToml),
        ..ParseOutcome::default()
    };
    let Ok(document) = text.parse::<toml_edit::DocumentMut>() else {
        outcome.format = None;
        return outcome;
    };
    let Some(servers) = document
        .get("mcp_servers")
        .and_then(|item| item.as_table_like())
    else {
        return outcome;
    };
    for (name, item) in servers.iter() {
        if outcome.servers.len() >= MAX_CANDIDATES {
            outcome.skipped.push((name.to_string(), "too-many-args"));
            continue;
        }
        let Some(node) = mcp_mutation::toml_item_to_node(item) else {
            continue;
        };
        let Some(object) = node.as_object() else {
            outcome.skipped.push((name.to_string(), "unknown-type"));
            continue;
        };
        if let Some(Node::Array(items)) = object.get("env_vars") {
            if items.iter().any(|item| item.as_str().is_none()) {
                outcome
                    .skipped
                    .push((name.to_string(), "codex-structured-env"));
                continue;
            }
        }
        match parse_json_entry(name, object, PasteFormat::CodexJson) {
            Ok(mut server) => match normalize_name(name) {
                Some((normalized, suggested)) => {
                    server.name = normalized;
                    server.name_suggested = suggested;
                    outcome.servers.push(server);
                }
                None => outcome.skipped.push((name.to_string(), "invalid-name")),
            },
            Err(reason) => outcome.skipped.push((name.to_string(), reason)),
        }
    }
    outcome
}

/// `cmd /c <runner> …` → `<runner> …` (§2.5); returns whether it unwrapped.
pub(crate) fn unwrap_windows_cmd(
    command: String,
    args: Vec<String>,
) -> (String, Vec<String>, bool) {
    let is_cmd = command.eq_ignore_ascii_case("cmd") || command.eq_ignore_ascii_case("cmd.exe");
    if is_cmd
        && args.len() >= 2
        && args[0].eq_ignore_ascii_case("/c")
        && mcp_mutation::is_wrap_family(&args[1])
    {
        let mut rest = args;
        let runner = rest.remove(1);
        rest.remove(0);
        return (runner, rest, true);
    }
    (command, args, false)
}

/// Library name rule (§2.2): `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`.
pub(crate) fn is_valid_library_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_alphanumeric() || (index > 0 && matches!(byte, b'_' | b'-'))
        })
        && !mcp_mutation::CLAUDE_RESERVED_NAMES
            .iter()
            .any(|reserved| name.eq_ignore_ascii_case(reserved))
}

/// Keeps a valid name; otherwise suggests a sanitised one.
fn normalize_name(name: &str) -> Option<(String, bool)> {
    if is_valid_library_name(name) {
        return Some((name.to_string(), false));
    }
    let sanitized = sanitize_name(name);
    is_valid_library_name(&sanitized).then_some((sanitized, true))
}

pub(crate) fn sanitize_name(raw: &str) -> String {
    let mut out = String::new();
    for ch in raw.trim().chars() {
        let mapped = if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
            ch.to_ascii_lowercase()
        } else {
            '-'
        };
        if mapped == '-' && (out.is_empty() || out.ends_with('-')) {
            continue;
        }
        out.push(mapped);
    }
    let trimmed = out.trim_matches(|ch| ch == '-' || ch == '_').to_string();
    trimmed.chars().take(64).collect()
}

/// A name for a server pasted without one (§3.6 "Suggested name").
pub(crate) fn suggest_name(server: &ParsedServer) -> String {
    let candidate = if let Some(url) = &server.url {
        host_label(url)
    } else {
        package_label(server.command.as_deref().unwrap_or_default(), &server.args)
    };
    let sanitized = sanitize_name(&candidate);
    if is_valid_library_name(&sanitized) {
        sanitized
    } else {
        "mcp-server".to_string()
    }
}

fn host_label(url: &str) -> String {
    let host = url_host(url).unwrap_or_default();
    let labels = host.split('.').collect::<Vec<_>>();
    if labels.len() >= 2 {
        labels[labels.len() - 2].to_string()
    } else {
        host
    }
}

/// Lowercase hostname without port, credentials, path or query.
pub(crate) fn url_host(url: &str) -> Option<String> {
    let rest = url.split_once("://")?.1;
    let authority = rest.split(['/', '?', '#']).next()?;
    let authority = authority
        .rsplit_once('@')
        .map_or(authority, |(_, host)| host);
    let host = if authority.starts_with('[') {
        authority
            .split_once(']')
            .map(|(host, _)| format!("{host}]"))
            .unwrap_or_default()
    } else {
        authority.split(':').next().unwrap_or_default().to_string()
    };
    let host = host.to_ascii_lowercase();
    (!host.is_empty()).then_some(host)
}

fn package_label(command: &str, args: &[String]) -> String {
    let subject = subject_of(command, args).unwrap_or_default();
    let mut name = subject.as_str();
    // Drop a version suffix (`pkg@latest`) but keep the scope's leading `@`.
    let without_version = match name.rfind('@') {
        Some(index) if index > 0 => &name[..index],
        _ => name,
    };
    name = without_version;
    let (scope, package) = match name.strip_prefix('@') {
        Some(scoped) => match scoped.split_once('/') {
            Some((scope, package)) => (Some(scope), package),
            None => (None, scoped),
        },
        None => (None, name),
    };
    let package = package.rsplit(['/', '\\']).next().unwrap_or(package);
    let mut stripped = package.to_ascii_lowercase();
    for prefix in ["mcp-server-", "server-", "mcp-"] {
        if let Some(rest) = stripped.strip_prefix(prefix) {
            stripped = rest.to_string();
        }
    }
    for suffix in ["-mcp-server", "-server", "-mcp", ".py", ".js"] {
        if let Some(rest) = stripped.strip_suffix(suffix) {
            stripped = rest.to_string();
        }
    }
    if stripped.is_empty() || stripped == "mcp" || stripped == "server" {
        return scope.unwrap_or("mcp-server").to_string();
    }
    stripped
}

/// The display subject of a stdio command (§1.3): the package for runners,
/// `python -m X`, the file of `node <file>`, the image of `docker run`.
pub(crate) fn subject_of(command: &str, args: &[String]) -> Option<String> {
    let runner = mcp_mutation::command_stem(command);
    let first_positional =
        |items: &[String]| items.iter().find(|item| !item.starts_with('-')).cloned();
    let file_name = |value: &str| {
        value
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or(value)
            .to_string()
    };
    match runner.as_str() {
        "npx" | "pnpx" | "bunx" | "uvx" => first_positional(args),
        "npm" | "pnpm" | "yarn"
            if args
                .first()
                .is_some_and(|first| first == "exec" || first == "dlx") =>
        {
            first_positional(&args[1..])
        }
        "python" | "python3" | "py" => args
            .windows(2)
            .find(|pair| pair[0] == "-m")
            .map(|pair| pair[1].clone())
            .or_else(|| first_positional(args).map(|value| file_name(&value))),
        "node" | "deno" | "bun" => first_positional(args).map(|value| file_name(&value)),
        "docker" | "podman" => args
            .iter()
            .rev()
            .find(|item| !item.starts_with('-'))
            .cloned(),
        _ => args.first().and_then(|first| {
            (first.contains('/') || first.contains('\\')).then(|| file_name(first))
        }),
    }
}

/// How a pasted env/header value should be treated.
#[derive(Clone, PartialEq, Eq)]
pub(crate) enum ValueKind {
    /// A placeholder: the field becomes a secret without a value. The
    /// variable name comes from the placeholder when it names one.
    Placeholder { env_var: Option<String> },
    /// A real-looking secret value (goes to the paste vault).
    Secret(String),
    /// A non-secret literal (stays plain env).
    Literal(String),
}

impl std::fmt::Debug for ValueKind {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ValueKind::Placeholder { env_var } => write!(formatter, "Placeholder({env_var:?})"),
            ValueKind::Secret(_) => formatter.write_str("Secret(••••)"),
            ValueKind::Literal(_) => formatter.write_str("Literal(…)"),
        }
    }
}

/// The variable a placeholder names (`${VAR}`, `${env:VAR}`, `$VAR`).
pub(crate) fn placeholder_variable(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if let Some(name) = crate::mcp_center::env_reference_name(trimmed) {
        return Some(name.to_string());
    }
    let bare = trimmed.strip_prefix('$')?;
    let valid = !bare.is_empty()
        && bare
            .chars()
            .next()
            .is_some_and(|ch| ch == '_' || ch.is_ascii_alphabetic())
        && bare
            .chars()
            .all(|ch| ch == '_' || ch.is_ascii_alphanumeric());
    valid.then(|| bare.to_string())
}

pub(crate) fn is_placeholder(value: &str) -> bool {
    let trimmed = value.trim();
    if trimmed.is_empty() || placeholder_variable(trimmed).is_some() {
        return true;
    }
    let lower = trimmed.to_ascii_lowercase();
    (trimmed.starts_with("${input:") && trimmed.ends_with('}'))
        || (trimmed.starts_with('<') && trimmed.ends_with('>'))
        || lower.starts_with("your_")
        || lower.starts_with("your-")
        || lower.starts_with("your ")
        || lower.starts_with("xxx")
        || lower.ends_with("_here")
        || lower.ends_with("-here")
        || lower == "changeme"
}

/// Secret heuristic on a variable / header name (§3.6).
pub(crate) fn name_looks_secret(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    const SUBSTRINGS: [&str; 7] = [
        "TOKEN",
        "SECRET",
        "PASSWORD",
        "PASSWD",
        "CREDENTIAL",
        "COOKIE",
        "APIKEY",
    ];
    const SEGMENTS: [&str; 7] = [
        "KEY",
        "PAT",
        "AUTH",
        "AUTHORIZATION",
        "SESSION",
        "PWD",
        "SID",
    ];
    SUBSTRINGS.iter().any(|marker| upper.contains(marker))
        || upper
            .split(['_', '-'])
            .any(|segment| SEGMENTS.contains(&segment))
}

pub(crate) fn classify_env_value(name: &str, value: &str) -> ValueKind {
    if is_placeholder(value) {
        return ValueKind::Placeholder {
            env_var: placeholder_variable(value),
        };
    }
    if name_looks_secret(name) || mcp_mutation::has_common_secret_prefix(value) {
        ValueKind::Secret(value.to_string())
    } else {
        ValueKind::Literal(value.to_string())
    }
}

/// Header values are always secrets (§3.6). Returns whether the value was a
/// `Bearer …` value, and the classified remainder.
pub(crate) fn classify_header_value(value: &str) -> (bool, ValueKind) {
    let trimmed = value.trim();
    let (bearer, rest) = match trimmed
        .strip_prefix("Bearer ")
        .or_else(|| trimmed.strip_prefix("bearer "))
    {
        Some(rest) => (true, rest.trim()),
        None => (false, trimmed),
    };
    if is_placeholder(rest) {
        return (
            bearer,
            ValueKind::Placeholder {
                env_var: placeholder_variable(rest),
            },
        );
    }
    (bearer, ValueKind::Secret(rest.to_string()))
}

// ---------------------------------------------------------------------------
// Paste vault: pasted secret values live only here, in process memory.
// ---------------------------------------------------------------------------

const VAULT_TTL: Duration = Duration::from_secs(15 * 60);
const VAULT_MAX_HANDLES: usize = 64;

struct VaultEntry {
    created: Instant,
    values: HashMap<String, String>,
}

fn vault() -> &'static Mutex<HashMap<String, VaultEntry>> {
    static VAULT: OnceLock<Mutex<HashMap<String, VaultEntry>>> = OnceLock::new();
    VAULT.get_or_init(|| Mutex::new(HashMap::new()))
}

fn prune_vault(map: &mut HashMap<String, VaultEntry>) {
    map.retain(|_, entry| entry.created.elapsed() <= VAULT_TTL);
    while map.len() >= VAULT_MAX_HANDLES {
        let Some(oldest) = map
            .iter()
            .min_by_key(|(_, entry)| entry.created)
            .map(|(key, _)| key.clone())
        else {
            break;
        };
        map.remove(&oldest);
    }
}

/// Stores pasted secret values and returns the paste handle. `values` maps
/// per-value handles (`v1`, `v2`, …) to secret values.
pub(crate) fn vault_store(values: HashMap<String, String>) -> Option<String> {
    if values.is_empty() {
        return None;
    }
    let handle = format!("paste-{}", uuid::Uuid::new_v4().simple());
    let mut map = vault()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    prune_vault(&mut map);
    map.insert(
        handle.clone(),
        VaultEntry {
            created: Instant::now(),
            values,
        },
    );
    Some(handle)
}

/// Looks up a pasted value. `None` means expired or unknown.
pub(crate) fn vault_get(handle: &str, value_handle: &str) -> Option<String> {
    let mut map = vault()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    map.retain(|_, entry| entry.created.elapsed() <= VAULT_TTL);
    map.get(handle)
        .and_then(|entry| entry.values.get(value_handle).cloned())
}

/// Clears a paste handle after use.
pub(crate) fn vault_clear(handle: &str) {
    vault()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .remove(handle);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(outcome: &ParseOutcome) -> Vec<String> {
        outcome
            .servers
            .iter()
            .map(|server| server.name.clone())
            .collect()
    }

    /// P1: every documented format, fenced and JSONC.
    #[test]
    fn paste_recognizes_all_formats() {
        let mcp_servers = r#"{"mcpServers":{"context7":{"command":"npx","args":["-y","@upstash/context7-mcp"]},"github":{"type":"http","url":"https://api.githubcopilot.com/mcp/","headers":{"Authorization":"Bearer ${GITHUB_PAT}"}}}}"#;
        let outcome = parse(mcp_servers).unwrap();
        assert_eq!(outcome.format, Some(PasteFormat::McpServers));
        assert_eq!(names(&outcome), ["context7", "github"]);
        assert_eq!(outcome.servers[1].transport, "http");

        let named = "\"memory\": {\"command\": \"npx\", \"args\": [\"-y\", \"@modelcontextprotocol/server-memory\"]}";
        let outcome = parse(named).unwrap();
        assert_eq!(outcome.format, Some(PasteFormat::Named));
        assert_eq!(names(&outcome), ["memory"]);

        let single = r#"{"command":"npx","args":["-y","@upstash/context7-mcp"]}"#;
        let outcome = parse(single).unwrap();
        assert_eq!(outcome.format, Some(PasteFormat::Single));
        assert_eq!(names(&outcome), ["context7"]);
        assert!(outcome.servers[0].name_suggested);

        let toml = "[mcp_servers.docs]\ncommand = \"uvx\"\nargs = [\"mcp-server-fetch\"]\nenv_vars = [\"DOCS_TOKEN\"]\n\n[mcp_servers.docs.env]\nMODE = \"fast\"\n\n[mcp_servers.remote]\nurl = \"https://example.test/mcp\"\nbearer_token_env_var = \"REMOTE_TOKEN\"\n";
        let outcome = parse(toml).unwrap();
        assert_eq!(outcome.format, Some(PasteFormat::CodexToml));
        assert_eq!(names(&outcome), ["docs", "remote"]);
        assert_eq!(
            outcome.servers[0].env,
            [("MODE".to_string(), "fast".to_string())]
        );
        assert_eq!(outcome.servers[0].env_refs, ["DOCS_TOKEN"]);
        assert_eq!(
            outcome.servers[1].bearer_env.as_deref(),
            Some("REMOTE_TOKEN")
        );

        let codex_json = r#"{"mcp_servers":{"docs":{"command":"uvx","args":["mcp-server-fetch"],"env_vars":["DOCS_TOKEN"]}}}"#;
        let outcome = parse(codex_json).unwrap();
        assert_eq!(outcome.format, Some(PasteFormat::CodexJson));
        assert_eq!(outcome.servers[0].env_refs, ["DOCS_TOKEN"]);

        let vscode = r#"{"servers":{"github":{"type":"http","url":"https://api.githubcopilot.com/mcp/","headers":{"Authorization":"Bearer ${input:github_mcp_pat}"}}},"inputs":[]}"#;
        let outcome = parse(vscode).unwrap();
        assert_eq!(outcome.format, Some(PasteFormat::Vscode));
        let (bearer, kind) = classify_header_value(&outcome.servers[0].headers[0].1);
        assert!(bearer);
        assert_eq!(kind, ValueKind::Placeholder { env_var: None });

        let opencode = r#"{"mcp":{"local-one":{"type":"local","command":["npx","-y","@playwright/mcp@latest"],"environment":{"MODE":"x"}},"remote-one":{"type":"remote","url":"https://mcp.context7.com/mcp","headers":{"CONTEXT7_API_KEY":"YOUR_API_KEY"}}}}"#;
        let outcome = parse(opencode).unwrap();
        assert_eq!(outcome.format, Some(PasteFormat::Opencode));
        assert_eq!(outcome.servers[0].command.as_deref(), Some("npx"));
        assert_eq!(outcome.servers[0].args, ["-y", "@playwright/mcp@latest"]);
        assert_eq!(
            outcome.servers[0].env,
            [("MODE".to_string(), "x".to_string())]
        );
        assert_eq!(outcome.servers[1].transport, "http");

        let fenced = "```jsonc\n{\n  // comment\n  \"mcpServers\": {\"fetch\": {\"command\": \"uvx\", \"args\": [\"mcp-server-fetch\"],},},\n}\n```";
        let outcome = parse(fenced).unwrap();
        assert_eq!(names(&outcome), ["fetch"]);

        let wrapped = r#"{"mcpServers":{"memory":{"command":"cmd","args":["/c","npx","-y","@modelcontextprotocol/server-memory"]}}}"#;
        let outcome = parse(wrapped).unwrap();
        assert_eq!(outcome.servers[0].command.as_deref(), Some("npx"));
        assert!(outcome.servers[0]
            .warnings
            .contains(&"windows-cmd-unwrapped"));

        assert_eq!(parse("not a config").unwrap().format, None);
        assert_eq!(
            parse(&"x".repeat(MAX_PASTE_BYTES + 1)).unwrap_err(),
            "paste-too-large"
        );
    }

    /// P3: `--port=3000` and `task-master-ai` are kept; credentials in args
    /// skip the candidate with a reason instead of dropping it silently.
    #[test]
    fn paste_keeps_equals_args_and_names_skip_reasons() {
        let text = r#"{"mcpServers":{
            "ports":{"command":"node","args":["server.js","--port=3000"]},
            "taskmaster":{"command":"npx","args":["-y","--package=task-master-ai","task-master-ai"]},
            "leaky":{"command":"npx","args":["-y","pkg","--api-key","sk-live-should-not-pass"]},
            "shell":{"command":"powershell","args":["-c","calc"]},
            "remote":{"url":"https://example.test/mcp?token=abc"},
            "odd":{"type":"websocket","url":"wss://example.test"}
        }}"#;
        let outcome = parse(text).unwrap();
        assert_eq!(names(&outcome), ["ports", "taskmaster"]);
        assert_eq!(outcome.servers[0].args, ["server.js", "--port=3000"]);
        let reasons = outcome
            .skipped
            .iter()
            .map(|(name, reason)| (name.as_str(), *reason))
            .collect::<Vec<_>>();
        assert!(reasons.contains(&("leaky", "secret-in-args")));
        assert!(reasons.contains(&("shell", "shell-command")));
        assert!(reasons.contains(&("remote", "invalid-url")));
        assert!(reasons.contains(&("odd", "unknown-type")));
        assert!(!format!("{outcome:?}").contains("sk-live-should-not-pass"));
    }

    #[test]
    fn suggested_names_follow_the_contract_examples() {
        let server = |command: &str, args: &[&str]| ParsedServer {
            command: Some(command.to_string()),
            args: args.iter().map(|value| value.to_string()).collect(),
            ..ParsedServer::default()
        };
        assert_eq!(
            suggest_name(&server("npx", &["-y", "@upstash/context7-mcp"])),
            "context7"
        );
        assert_eq!(suggest_name(&server("uvx", &["mcp-server-fetch"])), "fetch");
        assert_eq!(
            suggest_name(&server(
                "npx",
                &["-y", "@modelcontextprotocol/server-memory"]
            )),
            "memory"
        );
        assert_eq!(
            suggest_name(&server("npx", &["@playwright/mcp@latest"])),
            "playwright"
        );
        let remote = ParsedServer {
            url: Some("https://api.githubcopilot.com/mcp/".to_string()),
            ..ParsedServer::default()
        };
        assert_eq!(suggest_name(&remote), "githubcopilot");
        assert_eq!(
            subject_of(
                "docker",
                &[
                    "run".into(),
                    "-i".into(),
                    "--rm".into(),
                    "mcp/memory".into()
                ]
            )
            .as_deref(),
            Some("mcp/memory")
        );
        assert_eq!(
            subject_of("python", &["-m".into(), "origin_mcp".into()]).as_deref(),
            Some("origin_mcp")
        );
    }

    /// P2 (parser part): placeholders and secret classification.
    #[test]
    fn placeholders_and_secret_values_are_classified() {
        for placeholder in [
            "${API_KEY}",
            "${env:API_KEY}",
            "$API_KEY",
            "${input:token}",
            "<your key>",
            "YOUR_API_KEY",
            "your-token",
            "xxxxxxxx",
            "PASTE_KEY_HERE",
            "",
        ] {
            assert!(is_placeholder(placeholder), "{placeholder}");
        }
        assert_eq!(
            classify_env_value("GITHUB_TOKEN", "${GH_TOKEN}"),
            ValueKind::Placeholder {
                env_var: Some("GH_TOKEN".to_string())
            }
        );
        assert!(matches!(
            classify_env_value("GITHUB_TOKEN", "ghp_realvalue123"),
            ValueKind::Secret(_)
        ));
        assert!(matches!(
            classify_env_value("MODE", "sk-live-1234567890"),
            ValueKind::Secret(_)
        ));
        assert!(matches!(
            classify_env_value("GITHUB_OAUTH_CALLBACK_PORT", "8085"),
            ValueKind::Literal(_)
        ));
        assert!(!name_looks_secret("PYTHONPATH"));
        assert!(name_looks_secret("BRAVE_API_KEY"));
        assert!(
            !format!("{:?}", classify_env_value("TOKEN", "never-print")).contains("never-print")
        );
    }

    #[test]
    fn vault_values_expire_and_clear() {
        let mut values = HashMap::new();
        values.insert("v1".to_string(), "secret-value".to_string());
        let handle = vault_store(values).unwrap();
        assert_eq!(vault_get(&handle, "v1").as_deref(), Some("secret-value"));
        vault_clear(&handle);
        assert!(vault_get(&handle, "v1").is_none());
        assert!(vault_store(HashMap::new()).is_none());
    }
}
