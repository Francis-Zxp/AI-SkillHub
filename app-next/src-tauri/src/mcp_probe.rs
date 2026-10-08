//! User-clicked MCP connection test (docs/v3.3/mcp-contract.md §3.10).
//!
//! This is the only generic place that starts an MCP server, and only after
//! the user clicked "测试" and saw the exact command (the preview token binds
//! the run to that command and spec revision). It sends `initialize`,
//! `notifications/initialized` and `tools/list` — never `tools/call` — with a
//! 20 s deadline, then kills the whole process tree. Opening the MCP page,
//! importing, pasting and browsing never reach this module.
//!
//! The runner is resolved on the effective PATH (process, HKCU and HKLM, with
//! `%VAR%` expanded) by checking files only; `where.exe` is never used.

use crate::mcp_library::{self as library, McpError, McpLibraryContext, McpServerSpec, Transport};
use crate::mcp_secrets::{self, EnvStore};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::ffi::OsString;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

pub(crate) const TEST_TIMEOUT: Duration = Duration::from_secs(20);
const STDERR_TAIL_BYTES: usize = 2048;
const MAX_MESSAGE_CHARS: usize = 240;
const MAX_CONCURRENT_TESTS: usize = 2;

// ---------------------------------------------------------------------------
// Shared stdio JSON-RPC session (also used by the Origin recipe)
// ---------------------------------------------------------------------------

/// Line-delimited JSON-RPC over a server's stdio, bounded by a deadline.
/// Dropping the session kills the whole process tree.
pub(crate) struct StdioSession {
    child: std::process::Child,
    stdin: std::process::ChildStdin,
    lines: mpsc::Receiver<String>,
    deadline: Instant,
    stderr_tail: Arc<Mutex<Vec<u8>>>,
}

impl StdioSession {
    pub(crate) fn start(
        program: &Path,
        args: &[OsString],
        env: &[(OsString, OsString)],
        cwd: Option<&Path>,
        timeout: Duration,
    ) -> Result<Self, std::io::Error> {
        let mut command = Command::new(program);
        command
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for (name, value) in env {
            command.env(name, value);
        }
        if let Some(cwd) = cwd {
            command.current_dir(cwd);
        }
        crate::configure_background_command(&mut command);
        let mut child = command.spawn()?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| std::io::Error::other("stdin"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| std::io::Error::other("stdout"))?;
        let stderr_tail = Arc::new(Mutex::new(Vec::new()));
        if let Some(mut stderr) = child.stderr.take() {
            // Drain stderr so a chatty server never blocks on a full pipe;
            // keep only the last 2 KiB in memory.
            let tail = Arc::clone(&stderr_tail);
            thread::spawn(move || {
                let mut buffer = [0u8; 1024];
                while let Ok(read) = stderr.read(&mut buffer) {
                    if read == 0 {
                        break;
                    }
                    let mut tail = tail.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
                    tail.extend_from_slice(&buffer[..read]);
                    if tail.len() > STDERR_TAIL_BYTES {
                        let excess = tail.len() - STDERR_TAIL_BYTES;
                        tail.drain(..excess);
                    }
                }
            });
        }
        let (sender, lines) = mpsc::channel();
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if sender.send(line).is_err() {
                    break;
                }
            }
        });
        Ok(Self {
            child,
            stdin,
            lines,
            deadline: Instant::now() + timeout,
            stderr_tail,
        })
    }

    pub(crate) fn send(&mut self, message: &Value) -> Result<(), String> {
        let mut line = serde_json::to_string(message).map_err(|error| error.to_string())?;
        line.push('\n');
        self.stdin
            .write_all(line.as_bytes())
            .and_then(|_| self.stdin.flush())
            .map_err(|_| "MCP 服务器已关闭输入。".to_string())
    }

    pub(crate) fn request(
        &mut self,
        id: u64,
        method: &str,
        params: Value,
    ) -> Result<Value, String> {
        self.send(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }))?;
        loop {
            let remaining = self.deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(format!("MCP 服务器在限定时间内没有响应 {method}。"));
            }
            let line = match self.lines.recv_timeout(remaining) {
                Ok(line) => line,
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    return Err(format!("MCP 服务器在限定时间内没有响应 {method}。"))
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err(format!("MCP 服务器在回应 {method} 之前退出了。"))
                }
            };
            // Non-JSON stdout lines (banners, logs) are ignored.
            let Ok(message) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if message.get("id").and_then(Value::as_u64) != Some(id) {
                continue;
            }
            if let Some(error) = message.get("error") {
                return Err(format!(
                    "{method} 返回错误：{}",
                    error
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown")
                ));
            }
            return Ok(message.get("result").cloned().unwrap_or(Value::Null));
        }
    }

    pub(crate) fn stderr_tail(&self) -> String {
        let tail = self
            .stderr_tail
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        String::from_utf8_lossy(&tail).to_string()
    }
}

impl Drop for StdioSession {
    fn drop(&mut self) {
        crate::terminate_child_process_tree(&mut self.child);
    }
}

// ---------------------------------------------------------------------------
// Runner resolution without spawning (T4)
// ---------------------------------------------------------------------------

/// Process PATH ∪ HKCU Path ∪ HKLM Path, `%VAR%` expanded, de-duplicated.
pub(crate) fn effective_path_dirs(env: &dyn EnvStore) -> Vec<PathBuf> {
    let mut raw = Vec::new();
    if let Some(path) = std::env::var_os("PATH") {
        raw.push(path.to_string_lossy().to_string());
    }
    if let Ok(Some(user)) = env.get("Path") {
        raw.push(user);
    }
    if let Some(machine) = env.machine_get("Path") {
        raw.push(machine);
    }
    let separator = if cfg!(windows) { ';' } else { ':' };
    let mut seen = HashSet::new();
    let mut dirs = Vec::new();
    for value in raw {
        for part in value.split(separator) {
            let part = part.trim().trim_matches('"');
            if part.is_empty() {
                continue;
            }
            let expanded = mcp_secrets::expand_percent_vars(env, part);
            let key = if cfg!(windows) {
                expanded.to_ascii_lowercase()
            } else {
                expanded.clone()
            };
            if seen.insert(key) {
                dirs.push(PathBuf::from(expanded));
            }
        }
    }
    dirs
}

pub(crate) fn path_extensions() -> Vec<String> {
    if !cfg!(windows) {
        return vec![String::new()];
    }
    let raw = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string());
    raw.split(';')
        .map(|ext| ext.trim().to_ascii_lowercase())
        .filter(|ext| ext.starts_with('.'))
        .collect()
}

/// Finds the runner by checking files only (never `where.exe`).
pub(crate) fn resolve_runner(
    command: &str,
    dirs: &[PathBuf],
    extensions: &[String],
) -> Option<PathBuf> {
    let candidate = Path::new(command);
    let has_extension = candidate.extension().is_some();
    let try_file = |base: &Path| -> Option<PathBuf> {
        if has_extension && base.is_file() {
            return Some(base.to_path_buf());
        }
        for extension in extensions {
            let mut name = base.as_os_str().to_os_string();
            name.push(extension);
            let path = PathBuf::from(name);
            if path.is_file() {
                return Some(path);
            }
        }
        (!cfg!(windows) && base.is_file()).then(|| base.to_path_buf())
    };
    if candidate.is_absolute() || command.contains(['/', '\\']) {
        return try_file(candidate);
    }
    dirs.iter().find_map(|dir| try_file(&dir.join(command)))
}

fn install_hint(runner: &str) -> Option<(&'static str, &'static str)> {
    match runner {
        "node" | "npx" | "npm" | "pnpm" | "yarn" | "pnpx" => Some(("node", "https://nodejs.org/")),
        "uv" | "uvx" => Some((
            "uv",
            "https://docs.astral.sh/uv/getting-started/installation/",
        )),
        "docker" => Some((
            "docker",
            "https://docs.docker.com/desktop/setup/install/windows-install/",
        )),
        "python" | "python3" | "py" => {
            Some(("python", "https://www.python.org/downloads/windows/"))
        }
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Preview (no spawn) and test
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InstallHint {
    kind: String,
    url: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RunnerView {
    name: String,
    found: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    path_display: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    install_hint: Option<InstallHint>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct McpTestPreview {
    server_id: String,
    spec_revision: i64,
    kind: String,
    command_line: Option<String>,
    url: Option<String>,
    runner: Option<RunnerView>,
    missing_secrets: Vec<String>,
    preview_token: String,
    timeout_seconds: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct McpTestResult {
    server_id: String,
    spec_revision: i64,
    tested_at: String,
    status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    tools_count: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    server_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    server_version: Option<String>,
    message_code: String,
    message: String,
}

fn quote_arg(value: &str) -> String {
    if value.is_empty() || value.contains([' ', '\t', '"']) {
        format!("\"{}\"", value.replace('"', "\\\""))
    } else {
        value.to_string()
    }
}

fn redact_home(text: &str, home: &Path) -> String {
    let home_text = home.to_string_lossy().to_string();
    if home_text.len() < 3 {
        return text.to_string();
    }
    let mut out = text.to_string();
    for form in [home_text.clone(), home_text.replace('\\', "/")] {
        let lower = out.to_ascii_lowercase();
        let needle = form.to_ascii_lowercase();
        let mut result = String::with_capacity(out.len());
        let mut index = 0;
        while let Some(found) = lower[index..].find(&needle) {
            result.push_str(&out[index..index + found]);
            result.push('~');
            index += found + needle.len();
        }
        result.push_str(&out[index..]);
        out = result;
    }
    out
}

/// Replaces every known secret value (≥ 4 chars) and the profile path, then
/// truncates to 240 chars (T5).
pub(crate) fn redact_message(text: &str, secrets: &[String], home: &Path) -> String {
    let mut out = text.to_string();
    let mut sorted = secrets
        .iter()
        .filter(|secret| secret.chars().count() >= 4)
        .collect::<Vec<_>>();
    sorted.sort_by_key(|secret| std::cmp::Reverse(secret.len()));
    for secret in sorted {
        out = out.replace(secret.as_str(), "••••");
    }
    let out = redact_home(&out, home);
    let out = out
        .chars()
        .map(|ch| if ch.is_control() { ' ' } else { ch })
        .collect::<String>();
    let trimmed = out.trim();
    if trimmed.chars().count() > MAX_MESSAGE_CHARS {
        let mut short = trimmed
            .chars()
            .take(MAX_MESSAGE_CHARS - 1)
            .collect::<String>();
        short.push('…');
        short
    } else {
        trimmed.to_string()
    }
}

struct PlannedRun {
    preview: McpTestPreview,
    program: Option<PathBuf>,
}

fn plan_run(ctx: &McpLibraryContext, target: &library::TestTarget) -> PlannedRun {
    let spec = &target.spec;
    let (kind, command_line, url, runner, program, missing) = match spec.transport {
        Transport::Stdio => {
            let command = spec.command.clone().unwrap_or_default();
            let all = spec
                .args
                .iter()
                .map(|arg| arg.value.clone())
                .collect::<Vec<_>>();
            let mut parts = vec![quote_arg(&redact_home(&command, &ctx.mutation.home_dir))];
            for (index, arg) in spec.args.iter().enumerate() {
                let masked = arg.secret
                    || crate::mcp_mutation::has_common_secret_prefix(&arg.value)
                    || crate::mcp_mutation::is_sensitive_assignment(&arg.value)
                    || (index > 0
                        && crate::mcp_mutation::is_sensitive_argument_key(&all[index - 1])
                        && !all[index - 1].contains('='));
                parts.push(if masked {
                    library::SECRET_MASK.to_string()
                } else {
                    quote_arg(&redact_home(&arg.value, &ctx.mutation.home_dir))
                });
            }
            let dirs = effective_path_dirs(&*ctx.env);
            let resolved = resolve_runner(&command, &dirs, &path_extensions());
            let runner_name = crate::mcp_mutation::command_stem(&command);
            let runner = RunnerView {
                name: runner_name.clone(),
                found: resolved.is_some(),
                path_display: resolved.as_ref().map(|path| {
                    crate::mcp_mutation::redact_home_path(path, &ctx.mutation.home_dir)
                }),
                install_hint: install_hint(&runner_name).map(|(kind, url)| InstallHint {
                    kind: kind.to_string(),
                    url: url.to_string(),
                }),
            };
            let (_, missing) = library::test_environment(ctx, spec);
            (
                "process",
                Some(parts.join(" ")),
                None,
                Some(runner),
                resolved,
                missing,
            )
        }
        Transport::Http | Transport::Sse => {
            let url = spec
                .url
                .as_deref()
                .map(|url| url.split(['?', '#']).next().unwrap_or_default().to_string());
            let (_, missing) = library::test_headers(ctx, spec);
            ("http", None, url, None, None, missing)
        }
    };
    let preview_token = library::hmac_hex(
        &target.key,
        &[
            b"preview",
            target.server_id.as_bytes(),
            target.spec_revision.to_string().as_bytes(),
            command_line.as_deref().unwrap_or_default().as_bytes(),
            url.as_deref().unwrap_or_default().as_bytes(),
        ],
    );
    PlannedRun {
        preview: McpTestPreview {
            server_id: target.server_id.clone(),
            spec_revision: target.spec_revision,
            kind: kind.to_string(),
            command_line,
            url,
            runner,
            missing_secrets: missing,
            preview_token,
            timeout_seconds: TEST_TIMEOUT.as_secs() as u32,
        },
        program,
    }
}

/// Builds the exact command line and resolves the runner without spawning.
pub(crate) fn test_preview(
    ctx: &McpLibraryContext,
    server_id: &str,
) -> Result<McpTestPreview, McpError> {
    let target = library::load_test_target(ctx, server_id)?;
    Ok(plan_run(ctx, &target).preview)
}

fn running_tests() -> &'static Mutex<HashSet<String>> {
    static RUNNING: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    RUNNING.get_or_init(|| Mutex::new(HashSet::new()))
}

struct RunningGuard(String);

impl Drop for RunningGuard {
    fn drop(&mut self) {
        running_tests()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&self.0);
    }
}

/// Outcome of one probe before redaction.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ProbeOutcome {
    pub status: &'static str,
    pub message_code: &'static str,
    pub message: String,
    pub tools_count: Option<u32>,
    pub server_name: Option<String>,
    pub server_version: Option<String>,
}

impl ProbeOutcome {
    fn failure(status: &'static str, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            message_code: code,
            message: message.into(),
            tools_count: None,
            server_name: None,
            server_version: None,
        }
    }
}

fn tool_count(result: &Value) -> u32 {
    result
        .get("tools")
        .and_then(Value::as_array)
        .map(|tools| tools.len() as u32)
        .unwrap_or_default()
}

/// initialize → notifications/initialized → tools/list, then stop. Never
/// `tools/call`. The deadline covers the whole run; the tree is killed on
/// every path when the session drops.
pub(crate) fn run_stdio_probe(
    program: &Path,
    args: &[OsString],
    env: &[(OsString, OsString)],
    cwd: Option<&Path>,
    timeout: Duration,
    app_version: &str,
    progress: &dyn Fn(&str),
) -> ProbeOutcome {
    progress("starting");
    let mut session = match StdioSession::start(program, args, env, cwd, timeout) {
        Ok(session) => session,
        Err(error) if error.kind() == std::io::ErrorKind::InvalidInput => {
            return ProbeOutcome::failure(
                "failed",
                "exit-early",
                "参数包含 Windows 批处理不支持的字符。",
            )
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return ProbeOutcome::failure(
                "runner-missing",
                "runner-missing",
                "找不到要运行的程序。",
            )
        }
        Err(_) => return ProbeOutcome::failure("failed", "exit-early", "无法启动这个 MCP。"),
    };
    let classify = |error: String, session: &StdioSession| -> ProbeOutcome {
        let tail = session.stderr_tail();
        let detail = tail
            .lines()
            .rev()
            .find(|line| !line.trim().is_empty())
            .unwrap_or_default();
        if error.contains("限定时间") {
            ProbeOutcome::failure(
                "timeout",
                "timeout",
                format!("超时（{} 秒）", timeout.as_secs()),
            )
        } else if error.contains("退出") || error.contains("关闭输入") {
            ProbeOutcome::failure(
                "failed",
                "exit-early",
                format!("启动后很快退出了。{detail}"),
            )
        } else {
            ProbeOutcome::failure("failed", "invalid-response", error)
        }
    };
    progress("initialize");
    let initialized = match session.request(
        1,
        "initialize",
        json!({
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": { "name": "AI SkillHub", "version": app_version }
        }),
    ) {
        Ok(result) => result,
        Err(error) => {
            let outcome = classify(error, &session);
            progress("stopping");
            return outcome;
        }
    };
    if session
        .send(&json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }))
        .is_err()
    {
        progress("stopping");
        return ProbeOutcome::failure("failed", "exit-early", "启动后很快退出了。");
    }
    progress("tools-list");
    let tools = match session.request(2, "tools/list", json!({})) {
        Ok(result) => result,
        Err(error) => {
            let outcome = classify(error, &session);
            progress("stopping");
            return outcome;
        }
    };
    progress("stopping");
    let count = tool_count(&tools);
    let field = |pointer: &str| {
        initialized
            .pointer(pointer)
            .and_then(Value::as_str)
            .map(|value| value.chars().take(80).collect::<String>())
    };
    ProbeOutcome {
        status: "ok",
        message_code: "ok",
        message: format!("可用 · {count} 个工具"),
        tools_count: Some(count),
        server_name: field("/serverInfo/name"),
        server_version: field("/serverInfo/version"),
    }
}

fn parse_rpc_body(body: &str) -> Option<Value> {
    if let Ok(value) = serde_json::from_str::<Value>(body) {
        return Some(value);
    }
    // SSE: the last `data:` line that parses as JSON-RPC.
    body.lines()
        .filter_map(|line| line.strip_prefix("data:"))
        .filter_map(|data| serde_json::from_str::<Value>(data.trim()).ok())
        .next_back()
}

fn run_http_probe(
    url: &str,
    headers: &[(String, String)],
    timeout: Duration,
    app_version: &str,
    progress: &dyn Fn(&str),
) -> ProbeOutcome {
    let agent = ureq::AgentBuilder::new()
        .timeout(timeout)
        .redirects(0)
        .build();
    let deadline = Instant::now() + timeout;
    let post =
        |body: &Value, session: Option<&str>| -> Result<(Value, Option<String>), ProbeOutcome> {
            if Instant::now() >= deadline {
                return Err(ProbeOutcome::failure(
                    "timeout",
                    "timeout",
                    format!("超时（{} 秒）", timeout.as_secs()),
                ));
            }
            let mut request = agent
                .post(url)
                .set("Accept", "application/json, text/event-stream")
                .set("Content-Type", "application/json")
                .set("User-Agent", "AI-SkillHub-MCP-Test/3.3");
            for (name, value) in headers {
                request = request.set(name, value);
            }
            if let Some(session) = session {
                request = request.set("Mcp-Session-Id", session);
            }
            let response = match request.send_string(&body.to_string()) {
                Ok(response) => response,
                Err(ureq::Error::Status(401 | 403, _)) => {
                    return Err(ProbeOutcome::failure(
                        "needs-secret",
                        "http-401",
                        "需要 API Key，或 API Key 不正确。",
                    ))
                }
                Err(ureq::Error::Status(404, _)) => {
                    return Err(ProbeOutcome::failure(
                        "failed",
                        "http-404",
                        "这个地址上没有 MCP 服务（404）。",
                    ))
                }
                Err(ureq::Error::Status(code, _)) => {
                    return Err(ProbeOutcome::failure(
                        "failed",
                        "invalid-response",
                        format!("服务返回了 HTTP {code}。"),
                    ))
                }
                Err(ureq::Error::Transport(transport)) => {
                    let timed_out =
                        transport.kind() == ureq::ErrorKind::Io && Instant::now() >= deadline;
                    return Err(if timed_out {
                        ProbeOutcome::failure(
                            "timeout",
                            "timeout",
                            format!("超时（{} 秒）", timeout.as_secs()),
                        )
                    } else {
                        ProbeOutcome::failure("failed", "exit-early", "无法连接这个地址。")
                    });
                }
            };
            let session_id = response.header("Mcp-Session-Id").map(str::to_string);
            let mut text = String::new();
            let _ = response
                .into_reader()
                .take(1024 * 1024)
                .read_to_string(&mut text);
            let value = parse_rpc_body(&text).ok_or_else(|| {
                ProbeOutcome::failure("failed", "invalid-response", "服务的回应不是 MCP 格式。")
            })?;
            if value.get("error").is_some() {
                return Err(ProbeOutcome::failure(
                    "failed",
                    "invalid-response",
                    "服务返回了错误。",
                ));
            }
            Ok((
                value.get("result").cloned().unwrap_or(Value::Null),
                session_id,
            ))
        };
    progress("initialize");
    let (initialized, session) = match post(
        &json!({
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {
                "protocolVersion": "2025-06-18",
                "capabilities": {},
                "clientInfo": { "name": "AI SkillHub", "version": app_version }
            }
        }),
        None,
    ) {
        Ok(result) => result,
        Err(outcome) => return outcome,
    };
    let _ = post(
        &json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }),
        session.as_deref(),
    );
    progress("tools-list");
    let tools = match post(
        &json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {} }),
        session.as_deref(),
    ) {
        Ok((tools, _)) => tools,
        Err(outcome) => return outcome,
    };
    let count = tool_count(&tools);
    ProbeOutcome {
        status: "ok",
        message_code: "ok",
        message: format!("可用 · {count} 个工具"),
        tools_count: Some(count),
        server_name: initialized
            .pointer("/serverInfo/name")
            .and_then(Value::as_str)
            .map(str::to_string),
        server_version: initialized
            .pointer("/serverInfo/version")
            .and_then(Value::as_str)
            .map(str::to_string),
    }
}

/// Runs the test the user confirmed. Not under the write lock: it never
/// touches client configs. At most one test per server and two at once.
pub(crate) fn run_test(
    ctx: &McpLibraryContext,
    server_id: &str,
    preview_token: &str,
    progress: &dyn Fn(&str),
) -> Result<McpTestResult, McpError> {
    let target = library::load_test_target(ctx, server_id)?;
    progress("resolving");
    let planned = plan_run(ctx, &target);
    let tested_at = library::iso_from_ns(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or_default(),
    );
    let result = |outcome: ProbeOutcome| McpTestResult {
        server_id: target.server_id.clone(),
        spec_revision: target.spec_revision,
        tested_at: tested_at.clone(),
        status: outcome.status.to_string(),
        tools_count: outcome.tools_count,
        server_name: outcome.server_name.clone(),
        server_version: outcome.server_version.clone(),
        message_code: outcome.message_code.to_string(),
        message: redact_message(
            &outcome.message,
            &target.secret_values,
            &ctx.mutation.home_dir,
        ),
    };
    if preview_token.is_empty() {
        return Err(McpError::new(
            "test-preview-required",
            "请先查看将要运行的命令。",
        ));
    }
    if planned.preview.preview_token != preview_token {
        return Ok(result(ProbeOutcome::failure(
            "stale-preview",
            "stale-preview",
            "这个 MCP 刚被改过，请重新确认要运行的命令。",
        )));
    }
    let _guard = {
        let mut running = running_tests()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if running.contains(&target.server_id) || running.len() >= MAX_CONCURRENT_TESTS {
            return Err(McpError::new("test-busy", "正在测试其他 MCP，请稍候。"));
        }
        running.insert(target.server_id.clone());
        RunningGuard(target.server_id.clone())
    };
    let outcome = run_planned(ctx, &target.spec, &planned, progress);
    progress("done");
    let outcome = result(outcome);
    let _ = library::save_test_result(
        ctx,
        &target.server_id,
        target.spec_revision,
        &outcome.status,
        outcome.tools_count,
        &outcome.message_code,
        &outcome.tested_at,
    );
    Ok(outcome)
}

fn run_planned(
    ctx: &McpLibraryContext,
    spec: &McpServerSpec,
    planned: &PlannedRun,
    progress: &dyn Fn(&str),
) -> ProbeOutcome {
    if !planned.preview.missing_secrets.is_empty() {
        return ProbeOutcome::failure(
            "needs-secret",
            "needs-secret",
            format!(
                "需要先填写 API Key：{}",
                planned.preview.missing_secrets.join("、")
            ),
        );
    }
    match spec.transport {
        Transport::Sse => {
            ProbeOutcome::failure("unsupported", "unsupported", "暂不支持测试旧版 SSE 连接")
        }
        Transport::Http => {
            let (headers, _) = library::test_headers(ctx, spec);
            let url = spec.url.clone().unwrap_or_default();
            run_http_probe(&url, &headers, TEST_TIMEOUT, &ctx.app_version, progress)
        }
        Transport::Stdio => {
            let Some(program) = planned.program.clone() else {
                let runner = planned
                    .preview
                    .runner
                    .as_ref()
                    .map(|runner| runner.name.clone())
                    .unwrap_or_default();
                return ProbeOutcome::failure(
                    "runner-missing",
                    "runner-missing",
                    format!("启动失败：找不到 {runner}"),
                );
            };
            let (literal_env, _) = library::test_environment(ctx, spec);
            let mut env = literal_env
                .into_iter()
                .map(|(name, value)| (OsString::from(name), OsString::from(value)))
                .collect::<Vec<_>>();
            // A runner installed after SkillHub started still finds its
            // dependencies (node for npx.cmd).
            let separator = if cfg!(windows) { ";" } else { ":" };
            let path = effective_path_dirs(&*ctx.env)
                .iter()
                .map(|dir| dir.to_string_lossy().to_string())
                .collect::<Vec<_>>()
                .join(separator);
            env.push((OsString::from("PATH"), OsString::from(path)));
            let args = spec
                .args
                .iter()
                .map(|arg| OsString::from(&arg.value))
                .collect::<Vec<_>>();
            let cwd = spec
                .cwd
                .as_deref()
                .map(Path::new)
                .filter(|cwd| cwd.is_dir());
            run_stdio_probe(
                &program,
                &args,
                &env,
                cwd,
                TEST_TIMEOUT,
                &ctx.app_version,
                progress,
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp_secrets::MemoryEnvStore;

    fn temp_dir(label: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "skillhub-probe-{label}-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    /// T4: resolution checks files on PATH × PATHEXT and never spawns.
    #[test]
    fn runner_resolution_uses_path_and_pathext_without_spawning() {
        let root = temp_dir("runner");
        let bin = root.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let file = if cfg!(windows) {
            bin.join("fakerunner.cmd")
        } else {
            bin.join("fakerunner")
        };
        std::fs::write(&file, "echo").unwrap();
        let extensions = vec![".exe".to_string(), ".cmd".to_string()];
        let found = resolve_runner(
            "fakerunner",
            &[root.join("missing"), bin.clone()],
            &extensions,
        );
        if cfg!(windows) {
            assert_eq!(found.as_deref(), Some(file.as_path()));
        }
        assert!(resolve_runner("nope-runner", std::slice::from_ref(&bin), &extensions).is_none());
        let store = MemoryEnvStore::new();
        store
            .set("SKH_TEST_ONLY_BIN", &bin.to_string_lossy())
            .unwrap();
        store.set("Path", "%SKH_TEST_ONLY_BIN%").unwrap();
        let dirs = effective_path_dirs(&store);
        assert!(dirs.iter().any(|dir| dir == &bin));
        let _ = std::fs::remove_dir_all(root);
    }

    /// T5: secret values and the profile path never reach the message.
    #[test]
    fn stderr_and_message_redact_secret_values_and_profile_path() {
        let home = PathBuf::from(r"C:\Users\Example");
        let message = redact_message(
            r"failed with key sk-SENTINEL-123 at C:\Users\Example\AppData\x and c:/users/example/y",
            &["sk-SENTINEL-123".to_string(), "abc".to_string()],
            &home,
        );
        assert!(!message.contains("SENTINEL"));
        assert!(!message.to_ascii_lowercase().contains("users\\example"));
        assert!(!message.to_ascii_lowercase().contains("users/example"));
        assert!(message.contains("~"));
        let long = redact_message(&"x".repeat(1000), &[], &home);
        assert_eq!(long.chars().count(), MAX_MESSAGE_CHARS);
    }

    fn node_program() -> Option<PathBuf> {
        let store = MemoryEnvStore::new();
        resolve_runner("node", &effective_path_dirs(&store), &path_extensions())
    }

    fn fixture_script() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fake-mcp-server.mjs")
    }

    #[cfg(windows)]
    fn process_alive(pid: u32) -> bool {
        use windows_sys::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
        use windows_sys::Win32::System::Threading::{
            GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if handle.is_null() {
                return false;
            }
            let mut code = 0u32;
            let ok = GetExitCodeProcess(handle, &mut code);
            CloseHandle(handle);
            ok != 0 && code == STILL_ACTIVE as u32
        }
    }

    #[cfg(not(windows))]
    fn process_alive(pid: u32) -> bool {
        Path::new(&format!("/proc/{pid}")).exists()
    }

    /// T2: only initialize, notifications/initialized and tools/list are
    /// sent, and the server and its grandchild are gone afterwards.
    #[test]
    fn generic_test_runs_only_initialize_and_tools_list_and_kills_tree() {
        let Some(node) = node_program() else {
            eprintln!("node not found; skipping");
            return;
        };
        let root = temp_dir("fake-server");
        let log = root.join("methods.log");
        let env = vec![(OsString::from("FAKE_MCP_LOG"), log.clone().into_os_string())];
        let outcome = run_stdio_probe(
            &node,
            &[fixture_script().into_os_string()],
            &env,
            None,
            Duration::from_secs(20),
            "test",
            &|_| {},
        );
        assert_eq!(outcome.status, "ok", "{outcome:?}");
        assert_eq!(outcome.tools_count, Some(2));
        // Give the OS a moment to finish tearing the tree down.
        thread::sleep(Duration::from_millis(500));
        let logged = std::fs::read_to_string(&log).unwrap();
        let methods = logged
            .lines()
            .filter_map(|line| line.strip_prefix("method "))
            .collect::<Vec<_>>();
        assert_eq!(
            methods,
            ["initialize", "notifications/initialized", "tools/list"]
        );
        assert!(!logged.contains("tools/call"));
        let pids = logged
            .lines()
            .filter_map(|line| line.strip_prefix("pid "))
            .filter_map(|pid| pid.trim().parse::<u32>().ok())
            .collect::<Vec<_>>();
        assert_eq!(pids.len(), 2, "{logged}");
        for pid in pids {
            assert!(!process_alive(pid), "process {pid} still alive");
        }
        let _ = std::fs::remove_dir_all(root);
    }

    /// T3: a server that never answers hits the (injected) deadline.
    #[test]
    fn test_timeout_is_enforced() {
        let Some(node) = node_program() else {
            eprintln!("node not found; skipping");
            return;
        };
        let root = temp_dir("silent-server");
        let env = vec![
            (OsString::from("FAKE_MCP_SILENT"), OsString::from("1")),
            (
                OsString::from("FAKE_MCP_LOG"),
                root.join("log").into_os_string(),
            ),
        ];
        let started = Instant::now();
        let outcome = run_stdio_probe(
            &node,
            &[fixture_script().into_os_string()],
            &env,
            None,
            Duration::from_millis(1500),
            "test",
            &|_| {},
        );
        assert_eq!(outcome.status, "timeout");
        assert!(started.elapsed() < Duration::from_secs(10));
        let _ = std::fs::remove_dir_all(root);
    }
}
