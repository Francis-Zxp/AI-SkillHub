//! Verified install-and-connect recipes for specific MCP servers.
//!
//! Importing a configuration snippet proves nothing about whether a server can
//! run. A recipe owns the whole chain for one server whose author documentation
//! has been reviewed: prerequisites, an isolated runtime with a pinned version,
//! the client entry (written through the existing plan/backup/rollback path),
//! and a real MCP handshake followed by one read-only call. Steps that cannot be
//! automated reliably (Origin licensing and native installation confirmations)
//! are reported as the exact next user action.
//!
//! No arbitrary README or webview commands are evaluated. The fixed recipe
//! provisions a pinned Python package and uses Origin's official COM interface
//! to register its two reviewed Apps and launch their fixed bridge entry point.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub(crate) const ORIGIN_RECIPE_ID: &str = "origin-mcp";
/// Reviewed against the author's README, docs/mcp-config.md,
/// docs/origin-ui-buttons.md and docs/agentic/origin-mcp-bootstrap.md.
/// PyPI wheel sha256 2a9a3a31a41b23dd0a328c1a383f819c3966d9f6de518ef08a546f3cfdf4f845.
pub(crate) const ORIGIN_MCP_VERSION: &str = "0.1.4";
/// origin-mcp 0.1.4 asks for `mcp>=1.8.0` with no upper bound, and mcp 2.x
/// renamed FastMCP, so the server fails at import with the newest SDK. This
/// pair was verified on 2026-10-02: initialize answers and tools/list returns
/// the 25 Origin tools.
pub(crate) const ORIGIN_MCP_SDK_VERSION: &str = "1.30.0";
pub(crate) const ORIGIN_SERVER_NAME: &str = "origin";
const START_APP: &str = "Origin MCP Bridge Start";
const STOP_APP: &str = "Origin MCP Bridge Stop";
const VERIFICATION_FILE: &str = "verification.json";
const INSTALL_LOG_FILE: &str = "install.log";

/// Trusted paths resolved in Rust, never supplied by the webview.
#[derive(Debug, Clone)]
pub(crate) struct RecipeContext {
    pub runtime_dir: PathBuf,
    pub home_dir: PathBuf,
    pub local_app_data: PathBuf,
    pub app_version: String,
}

impl RecipeContext {
    fn venv_dir(&self) -> PathBuf {
        self.runtime_dir.join("venv")
    }

    pub(crate) fn runtime_python(&self) -> PathBuf {
        self.venv_dir().join("Scripts").join("python.exe")
    }

    fn apps_dir(&self) -> PathBuf {
        self.local_app_data.join("OriginLab").join("Apps")
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct RecipeStep {
    pub id: String,
    /// ok | pending | failed | user
    pub status: String,
    pub detail: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct OriginInstallation {
    pub name: String,
    pub version: String,
    pub install_dir: String,
    pub running: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct ClientBinding {
    pub host_id: String,
    pub configured: bool,
    /// The entry launches this recipe's runtime with `-m origin_mcp`.
    pub matches_runtime: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct Verification {
    pub app_version: String,
    pub package_version: String,
    pub runtime_python: String,
    pub verified_at: String,
    pub protocol_version: String,
    pub server_name: String,
    pub server_version: String,
    pub tool_count: usize,
    pub bridge_state: String,
    pub origin_ping_ok: bool,
    pub failure: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct RecipeStatus {
    pub recipe_id: String,
    pub package_version: String,
    /// not-installed | needs-origin | needs-connection | ready | error
    pub state: String,
    /// install-python | install-origin | install | connect | register-app |
    /// open-origin | start-bridge | verify | none
    pub next_step: String,
    pub steps: Vec<RecipeStep>,
    pub origin: Option<OriginInstallation>,
    pub base_python: String,
    pub base_python_version: String,
    pub runtime_python: String,
    pub installed_version: String,
    pub app_staged: bool,
    pub app_registered: bool,
    pub mkopx_commands: Vec<String>,
    pub clients: Vec<ClientBinding>,
    pub verification: Option<Verification>,
    /// The stored verification no longer applies (app or runtime changed).
    pub verification_stale: bool,
    pub failure: String,
}

fn step(id: &str, status: &str, detail: impl Into<String>) -> RecipeStep {
    RecipeStep {
        id: id.to_string(),
        status: status.to_string(),
        detail: detail.into(),
    }
}

fn iso_now() -> String {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default();
    crate::format_unix_epoch_utc(seconds)
}

fn run(
    command: &mut Command,
    timeout: Duration,
    label: &str,
) -> Result<std::process::Output, String> {
    crate::command_output_with_timeout(command, timeout, &format!("{label}超时，已停止。"))
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).trim().to_string()
}

/// `3.13.9` -> (3, 13, 9)
fn parse_version(value: &str) -> Option<(u32, u32, u32)> {
    let mut parts = value.trim().split('.').map(|part| part.parse::<u32>().ok());
    Some((
        parts.next()??,
        parts.next()??,
        parts.next().flatten().unwrap_or(0),
    ))
}

fn python_version(python: &Path) -> Option<String> {
    let mut command = Command::new(python);
    command.args(["-c", "import sys;print('%d.%d.%d'%sys.version_info[:3])"]);
    let output = run(&mut command, Duration::from_secs(15), "读取 Python 版本").ok()?;
    output.status.success().then(|| text(&output.stdout))
}

fn launcher_python_path(line: &str) -> Option<PathBuf> {
    let start = line.as_bytes().windows(3).position(|part| {
        part[0].is_ascii_alphabetic() && part[1] == b':' && matches!(part[2], b'\\' | b'/')
    })?;
    let path = line[start..].trim().trim_matches('"');
    path.to_ascii_lowercase()
        .ends_with("python.exe")
        .then(|| PathBuf::from(path))
}

/// Interpreters that can host the isolated runtime, best first. The Microsoft
/// Store alias under WindowsApps is skipped: it opens the Store instead.
pub(crate) fn find_base_pythons(home: &Path, local_app_data: &Path) -> Vec<(PathBuf, String)> {
    let mut candidates = Vec::<PathBuf>::new();
    if let Ok(output) = run(
        Command::new("py").arg("-0p"),
        Duration::from_secs(10),
        "列出 Python",
    ) {
        for line in String::from_utf8_lossy(&output.stdout).lines() {
            if let Some(path) = launcher_python_path(line) {
                candidates.push(path);
            }
        }
    }
    if let Ok(output) = run(
        Command::new("where.exe").arg("python"),
        Duration::from_secs(10),
        "查找 Python",
    ) {
        for line in String::from_utf8_lossy(&output.stdout).lines() {
            candidates.push(PathBuf::from(line.trim()));
        }
    }
    let programs = local_app_data.join("Programs").join("Python");
    if let Ok(entries) = fs::read_dir(&programs) {
        for entry in entries.flatten() {
            candidates.push(entry.path().join("python.exe"));
        }
    }
    for base in [
        home.join("anaconda3"),
        home.join("miniconda3"),
        PathBuf::from(r"C:\ProgramData\anaconda3"),
        PathBuf::from(r"C:\ProgramData\miniconda3"),
    ] {
        candidates.push(base.join("python.exe"));
    }
    let mut seen = BTreeSet::new();
    let mut found = Vec::new();
    for candidate in candidates {
        let key = candidate.display().to_string().to_lowercase();
        if key.contains("\\windowsapps\\") || !candidate.is_file() || !seen.insert(key) {
            continue;
        }
        if let Some(version) = python_version(&candidate) {
            if let Some((3, minor, _)) = parse_version(&version) {
                if (10..=14).contains(&minor) {
                    found.push((candidate, version));
                }
            }
        }
    }
    found.sort_by_key(|candidate| std::cmp::Reverse(parse_version(&candidate.1)));
    found
}

/// Bounded Origin detection: the uninstall registry first, then the common
/// install roots the author's bootstrap guide probes. Never a full-disk scan.
pub(crate) fn find_origin() -> Option<OriginInstallation> {
    let mut found = None;
    for key in [
        r"HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
        r"HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall",
        r"HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
    ] {
        let Ok(output) = run(
            Command::new("reg.exe").args(["query", key, "/s", "/f", "OriginLab", "/d"]),
            Duration::from_secs(15),
            "读取 Origin 安装信息",
        ) else {
            continue;
        };
        if let Some(installation) = parse_origin_registry(&String::from_utf8_lossy(&output.stdout))
        {
            found = Some(installation);
            break;
        }
    }
    if found.is_none() {
        for drive in ['C', 'D', 'E', 'F'] {
            for root in [
                format!(r"{drive}:\Program Files\OriginLab"),
                format!(r"{drive}:\OriginLab"),
            ] {
                let Ok(entries) = fs::read_dir(&root) else {
                    continue;
                };
                for entry in entries.flatten() {
                    let dir = entry.path();
                    if dir.join("Origin64.exe").is_file() {
                        found = Some(OriginInstallation {
                            name: entry.file_name().to_string_lossy().to_string(),
                            version: String::new(),
                            install_dir: dir.display().to_string(),
                            running: false,
                        });
                    }
                }
            }
        }
    }
    found.map(|mut installation| {
        installation.running = origin_running();
        installation
    })
}

/// Parses `reg query ... /s` blocks: DisplayName / DisplayVersion / InstallLocation.
fn parse_origin_registry(listing: &str) -> Option<OriginInstallation> {
    let mut best: Option<OriginInstallation> = None;
    for block in listing
        .split("\r\n\r\n")
        .flat_map(|block| block.split("\n\n"))
    {
        let value = |name: &str| {
            block.lines().find_map(|line| {
                let line = line.trim();
                let rest = line.strip_prefix(name)?;
                let rest = rest.trim_start();
                let rest = rest
                    .strip_prefix("REG_SZ")
                    .or_else(|| rest.strip_prefix("REG_EXPAND_SZ"))?;
                Some(rest.trim().to_string())
            })
        };
        let Some(name) = value("DisplayName") else {
            continue;
        };
        if !name.to_ascii_lowercase().starts_with("origin") {
            continue;
        }
        let install_dir = value("InstallLocation").unwrap_or_default();
        if install_dir.is_empty() || !Path::new(&install_dir).join("Origin64.exe").is_file() {
            continue;
        }
        let candidate = OriginInstallation {
            name,
            version: value("DisplayVersion").unwrap_or_default(),
            install_dir: install_dir.trim_end_matches('\\').to_string(),
            running: false,
        };
        if best
            .as_ref()
            .is_none_or(|current| candidate.version > current.version)
        {
            best = Some(candidate);
        }
    }
    best
}

fn origin_running() -> bool {
    run(
        Command::new("tasklist.exe").args([
            "/FI",
            "IMAGENAME eq Origin64.exe",
            "/NH",
            "/FO",
            "CSV",
        ]),
        Duration::from_secs(10),
        "检查 Origin 进程",
    )
    .map(|output| {
        String::from_utf8_lossy(&output.stdout)
            .to_ascii_lowercase()
            .contains("origin64.exe")
    })
    .unwrap_or(false)
}

fn installed_package_version(python: &Path) -> Option<String> {
    if !python.is_file() {
        return None;
    }
    let mut command = Command::new(python);
    command.args(["-c", "import origin_mcp;print(origin_mcp.__version__)"]);
    let output = run(
        &mut command,
        Duration::from_secs(30),
        "读取 origin-mcp 版本",
    )
    .ok()?;
    output.status.success().then(|| text(&output.stdout))
}

/// Version of the `mcp` SDK in the runtime (origin-mcp imports it at start).
fn installed_sdk_version(python: &Path) -> Option<String> {
    if !python.is_file() {
        return None;
    }
    let mut command = Command::new(python);
    command.args([
        "-c",
        "import importlib.metadata as m;print(m.version('mcp'))",
    ]);
    let output = run(&mut command, Duration::from_secs(30), "读取 MCP SDK 版本").ok()?;
    output.status.success().then(|| text(&output.stdout))
}

/// `origin-mcp status --json` -> state (`running`, `not_running`, `stale`, ...).
fn bridge_state(python: &Path) -> String {
    bridge_state_with_env(python, &[])
}

fn bridge_state_with_env(python: &Path, extra_env: &[(&str, String)]) -> String {
    let mut command = Command::new(python);
    command.args(["-m", "origin_mcp", "status", "--json", "--timeout", "1"]);
    for (name, value) in extra_env {
        command.env(name, value);
    }
    let Ok(output) = run(&mut command, Duration::from_secs(20), "检查 Origin 桥接") else {
        return "unknown".to_string();
    };
    serde_json::from_slice::<Value>(&output.stdout)
        .ok()
        .and_then(|payload| {
            payload
                .get("state")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_else(|| "unknown".to_string())
}

fn same_path(left: &str, right: &Path) -> bool {
    let normalize = |value: &str| {
        value
            .replace('/', "\\")
            .trim_end_matches('\\')
            .to_lowercase()
    };
    normalize(left) == normalize(&right.display().to_string())
}

fn binding_matches(command: Option<&str>, args: &[String], runtime: &Path) -> bool {
    command.is_some_and(|command| same_path(command, runtime))
        && args.iter().map(String::as_str).collect::<Vec<_>>() == ["-m", "origin_mcp"]
}

/// Reads only the `origin` entry of the user-level client configs to compare
/// it with the runtime; no other server and no secret value is returned.
pub(crate) fn client_bindings(home: &Path, runtime: &Path) -> Vec<ClientBinding> {
    let mut bindings = Vec::new();
    let codex = fs::read_to_string(home.join(".codex").join("config.toml"))
        .ok()
        .and_then(|text| text.parse::<toml_edit::DocumentMut>().ok());
    let codex_entry = codex.as_ref().and_then(|document| {
        document
            .get("mcp_servers")?
            .as_table_like()?
            .get(ORIGIN_SERVER_NAME)?
            .as_table_like()
            .map(|table| {
                let command = table
                    .get("command")
                    .and_then(|item| item.as_str())
                    .map(str::to_string);
                let args = table
                    .get("args")
                    .and_then(|item| item.as_array())
                    .map(|array| {
                        array
                            .iter()
                            .filter_map(|value| value.as_str())
                            .map(str::to_string)
                            .collect()
                    })
                    .unwrap_or_default();
                (command, args)
            })
    });
    bindings.push(ClientBinding {
        host_id: crate::mcp_mutation::HOST_CODEX.to_string(),
        configured: codex_entry.is_some(),
        matches_runtime: codex_entry.as_ref().is_some_and(
            |(command, args): &(Option<String>, Vec<String>)| {
                binding_matches(command.as_deref(), args, runtime)
            },
        ),
    });
    let claude = fs::read_to_string(home.join(".claude.json"))
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(text.trim_start_matches('\u{feff}')).ok());
    let claude_entry = claude
        .as_ref()
        .and_then(|config| config.get("mcpServers")?.get(ORIGIN_SERVER_NAME))
        .map(|entry| {
            let command = entry
                .get("command")
                .and_then(Value::as_str)
                .map(str::to_string);
            let args = entry
                .get("args")
                .and_then(Value::as_array)
                .map(|array| {
                    array
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default();
            (command, args)
        });
    bindings.push(ClientBinding {
        host_id: crate::mcp_mutation::HOST_CLAUDE_CODE.to_string(),
        configured: claude_entry.is_some(),
        matches_runtime: claude_entry.as_ref().is_some_and(
            |(command, args): &(Option<String>, Vec<String>)| {
                binding_matches(command.as_deref(), args, runtime)
            },
        ),
    });
    bindings
}

pub(crate) fn mkopx_commands(apps_dir: &Path) -> Vec<String> {
    [START_APP, STOP_APP]
        .iter()
        .map(|app| {
            let opx = apps_dir.join(format!("{app}.opx"));
            format!("mkOPX app:=\"{app}\" opx:=\"{}\";", opx.display())
        })
        .collect()
}

fn read_verification(context: &RecipeContext) -> Option<Verification> {
    let raw = fs::read_to_string(context.runtime_dir.join(VERIFICATION_FILE)).ok()?;
    serde_json::from_str(&raw).ok()
}

fn origin_helper_command(context: &RecipeContext, action: &str) -> Result<Command, String> {
    use base64::Engine;
    if !matches!(action, "register" | "start") {
        return Err("不支持的 Origin 桥接操作。".to_string());
    }
    let apps = context.apps_dir();
    if apps.to_string_lossy().contains(['"', '%', ';', '\r', '\n']) {
        return Err("当前路径包含 LabTalk 特殊字符，请使用手动注册步骤。".to_string());
    }
    let script = include_str!("origin_bridge_helper.ps1");
    let encoded = base64::engine::general_purpose::STANDARD.encode(
        script
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>(),
    );
    let windows = std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .ok_or("无法定位 Windows PowerShell。")?;
    let mut command = Command::new(windows.join("System32/WindowsPowerShell/v1.0/powershell.exe"));
    command
        .args(["-NoProfile", "-NonInteractive", "-EncodedCommand", &encoded])
        .env("SKILLHUB_ORIGIN_APPS", apps)
        .env("SKILLHUB_ORIGIN_ACTION", action)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    crate::configure_background_command(&mut command);
    Ok(command)
}

/// Registers only the two reviewed Apps and starts their fixed entry point in
/// the one already-running Origin. No arbitrary command/path is accepted.
pub(crate) fn prepare_bridge(context: &RecipeContext) -> Result<RecipeStatus, String> {
    let runtime = context.runtime_python();
    if installed_package_version(&runtime).as_deref() != Some(ORIGIN_MCP_VERSION)
        || installed_sdk_version(&runtime).as_deref() != Some(ORIGIN_MCP_SDK_VERSION)
    {
        return Err("请先安装 Origin MCP 的独立运行环境。".to_string());
    }
    if !origin_running() {
        return Err("请先打开 Origin，然后点击“注册并启动”。".to_string());
    }
    if bridge_state(&runtime) == "running" {
        return Ok(verify(context));
    }
    let apps = context.apps_dir();
    let registered = registered_apps(&runtime, &apps)?;
    for name in [START_APP, STOP_APP] {
        for file in ["package.ini", "launch.ogs"] {
            if !apps.join(name).join(file).is_file() {
                return Err("Origin App 文件不完整，请先重新安装运行环境。".to_string());
            }
        }
    }
    if [START_APP, STOP_APP]
        .iter()
        .any(|name| !registered.iter().any(|found| found == name))
    {
        let backup = context
            .runtime_dir
            .join("app-backups")
            .join(uuid::Uuid::new_v4().to_string());
        fs::create_dir_all(&backup).map_err(|error| format!("无法备份 Origin App：{error}"))?;
        for file in ["OPXList.xml", "AppsTabs.xml"] {
            if apps.join(file).is_file() {
                fs::copy(apps.join(file), backup.join(file))
                    .map_err(|error| format!("无法备份 Origin 注册信息：{error}"))?;
            }
        }
        for name in [START_APP, STOP_APP] {
            crate::copy_directory_tree(&apps.join(name), &backup.join(name))?;
        }
        append_log(context, &format!("Origin App backup: {}", backup.display()));
        run_origin_helper(context, "register")?;
        let registered = registered_apps(&runtime, &apps)?;
        if [START_APP, STOP_APP]
            .iter()
            .any(|name| !registered.iter().any(|found| found == name))
        {
            return Err(
                "Origin 尚未完成 App 注册。请完成 Origin 安装窗口中的确认后重试。".to_string(),
            );
        }
    }
    run_origin_helper(context, "start")?;
    Ok(verify(context))
}

fn run_origin_helper(context: &RecipeContext, action: &str) -> Result<(), String> {
    let mut child = origin_helper_command(context, action)?
        .spawn()
        .map_err(|error| format!("无法连接到 Origin：{error}"))?;
    let started = Instant::now();
    loop {
        if let Some(exit) = child.try_wait().map_err(|error| error.to_string())? {
            return if exit.success() {
                Ok(())
            } else {
                Err("Origin 未完成操作。请保留一个 Origin 窗口，关闭其安装/错误对话框后重试；也可展开手动步骤。".to_string())
            };
        }
        if action == "start" && bridge_state(&context.runtime_python()) == "running" {
            // Keep the COM caller alive until the author's foreground bridge
            // returns. This thread owns/reaps only our helper, never Origin.
            thread::spawn(move || {
                let _ = child.wait();
            });
            return Ok(());
        }
        if started.elapsed() > Duration::from_secs(if action == "register" { 90 } else { 60 }) {
            // Do not use taskkill /T: a COM server is the user's running app.
            let _ = child.kill();
            let _ = child.wait();
            return Err(if action == "register" {
                "等待 Origin 注册确认超时。请在 Origin 中完成安装提示，再重试；已部署的同版本文件可选“全部跳过”。"
            } else {
                "桥接尚未响应。请检查 Origin 的 Python/Bridge 提示后重试；当前工程未关闭或重启。"
            }.to_string());
        }
        thread::sleep(Duration::from_millis(500));
    }
}

fn write_verification(context: &RecipeContext, verification: &Verification) {
    if let Ok(text) = serde_json::to_string_pretty(verification) {
        let _ = fs::create_dir_all(&context.runtime_dir);
        let _ = fs::write(context.runtime_dir.join(VERIFICATION_FILE), text);
    }
}

fn bridge_next_step(app_staged: bool, app_registered: bool, origin_running: bool) -> &'static str {
    if !app_staged {
        "install"
    } else if !origin_running {
        // A closed Origin process says nothing about whether its Apps were
        // already registered. Do not ask users to register them again.
        "open-origin"
    } else if !app_registered {
        "register-app"
    } else {
        "start-bridge"
    }
}

/// Origin records installed Apps in OPXList.xml. Directory existence only
/// proves staging. Parse the registry with Python's standard XML parser; no
/// external entities or user configuration are evaluated.
fn registered_apps(python: &Path, apps: &Path) -> Result<Vec<String>, String> {
    let registry = apps.join("OPXList.xml");
    if !registry.exists() {
        return Ok(Vec::new());
    }
    let script = r#"import json, pathlib, sys, xml.etree.ElementTree as ET
path = pathlib.Path(sys.argv[1])
if path.stat().st_size > 8*1024*1024: raise ValueError('App registry too large')
raw = path.read_bytes()
if len(raw) > 8*1024*1024 or b'<!DOCTYPE' in raw.upper(): raise ValueError('Unsupported App registry')
root = ET.fromstring(raw)
if root.tag != 'OriginStorage': raise ValueError('Invalid App registry')
print(json.dumps([p.get('Label') for p in root.findall('Package') if p.get('Label') == p.findtext('Package/Name')]))
"#;
    let output = run(
        Command::new(python)
            .args(["-I", "-c", script])
            .arg(registry),
        Duration::from_secs(10),
        "读取 Origin App 注册信息",
    )?;
    if !output.status.success() {
        return Err(
            "无法读取 Origin App 注册表；请在 Origin 的 Apps 中检查，未改动注册信息。".to_string(),
        );
    }
    serde_json::from_slice(&output.stdout).map_err(|_| "Origin App 注册信息格式无效。".to_string())
}

/// Read-only status. Starts no server; runs the runtime's own `status` CLI
/// only when the runtime exists.
pub(crate) fn detect(context: &RecipeContext) -> RecipeStatus {
    let runtime = context.runtime_python();
    let mut status = RecipeStatus {
        recipe_id: ORIGIN_RECIPE_ID.to_string(),
        package_version: ORIGIN_MCP_VERSION.to_string(),
        runtime_python: runtime.display().to_string(),
        mkopx_commands: mkopx_commands(&context.apps_dir()),
        ..RecipeStatus::default()
    };
    let origin = find_origin();
    match &origin {
        Some(installation) => status.steps.push(step(
            "origin",
            "ok",
            format!(
                "{} {} · {}",
                installation.name, installation.version, installation.install_dir
            ),
        )),
        None => status.steps.push(step(
            "origin",
            "user",
            "未检测到 Origin/OriginPro（需要有效授权的 2026/2026b）。",
        )),
    }
    status.origin = origin.clone();

    let installed = installed_package_version(&runtime).unwrap_or_default();
    let sdk = if installed.is_empty() {
        String::new()
    } else {
        installed_sdk_version(&runtime).unwrap_or_default()
    };
    // A runtime counts only with the verified package and SDK pair; anything
    // else is repaired by installing again.
    let runtime_ready = installed == ORIGIN_MCP_VERSION && sdk == ORIGIN_MCP_SDK_VERSION;
    status.installed_version = installed.clone();
    if installed.is_empty() {
        let bases = find_base_pythons(&context.home_dir, &context.local_app_data);
        if let Some((path, version)) = bases.first() {
            status.base_python = path.display().to_string();
            status.base_python_version = version.clone();
            status.steps.push(step(
                "python",
                "ok",
                format!("Python {version} · {}", path.display()),
            ));
        } else {
            status.steps.push(step(
                "python",
                "user",
                "需要 Python 3.10–3.14 来创建独立运行环境。",
            ));
        }
        status
            .steps
            .push(step("runtime", "pending", "尚未安装独立运行环境。"));
    } else if installed != ORIGIN_MCP_VERSION {
        status.steps.push(step(
            "runtime",
            "failed",
            format!("运行环境中的 origin-mcp 是 {installed}，已核验版本是 {ORIGIN_MCP_VERSION}。"),
        ));
    } else if !runtime_ready {
        status.steps.push(step(
            "runtime",
            "failed",
            format!(
                "运行环境中的 MCP SDK 是 {}，origin-mcp {ORIGIN_MCP_VERSION} 只能在 1.x 上启动（已核验 {ORIGIN_MCP_SDK_VERSION}）。点“安装并连接”修复。",
                if sdk.is_empty() { "未知版本" } else { sdk.as_str() }
            ),
        ));
    } else {
        status.steps.push(step(
            "runtime",
            "ok",
            format!("origin-mcp {installed} · 独立环境"),
        ));
    }

    status.app_staged =
        context.apps_dir().join(START_APP).is_dir() && context.apps_dir().join(STOP_APP).is_dir();
    let apps = registered_apps(&runtime, &context.apps_dir());
    status.app_registered = apps.as_ref().is_ok_and(|names| {
        [START_APP, STOP_APP]
            .iter()
            .all(|name| names.iter().any(|found| found == name))
    });
    status.steps.push(if status.app_registered {
        step("app", "ok", "Start/Stop App 已注册。")
    } else if let Err(failure) = apps {
        step("app", "failed", failure)
    } else if status.app_staged {
        step(
            "app",
            "user",
            "App 文件已就位但尚未注册。点击“注册并启动”；若 Origin 提示文件已存在，可选“全部跳过”。",
        )
    } else {
        step(
            "app",
            "pending",
            "Origin Start/Stop App 尚未放入 Apps 文件夹。",
        )
    });

    status.clients = client_bindings(&context.home_dir, &runtime);
    let connected = status
        .clients
        .iter()
        .filter(|client| client.matches_runtime)
        .count();
    let misconfigured = status
        .clients
        .iter()
        .filter(|client| client.configured && !client.matches_runtime)
        .count();
    status.steps.push(if connected > 0 {
        step(
            "client",
            "ok",
            format!("{connected} 个 AI 工具已指向此运行环境。"),
        )
    } else if misconfigured > 0 {
        step(
            "client",
            "failed",
            "已有名为 origin 的配置，但没有指向此运行环境。",
        )
    } else {
        step("client", "pending", "尚未写入 AI 工具配置。")
    });

    let stored = read_verification(context);
    let stale = stored.as_ref().is_some_and(|verification| {
        verification.app_version != context.app_version
            || verification.package_version != installed
            || !same_path(&verification.runtime_python, &runtime)
    });
    status.verification_stale = stale;
    let bridge = if runtime_ready {
        bridge_state(&runtime)
    } else {
        String::new()
    };
    match stored.as_ref() {
        Some(verification) if !stale && verification.failure.is_empty() => status.steps.push(step(
            "handshake",
            "ok",
            format!(
                "MCP 握手成功 · {} 个工具 · {}",
                verification.tool_count, verification.verified_at
            ),
        )),
        Some(verification) if !stale => {
            status
                .steps
                .push(step("handshake", "failed", verification.failure.clone()))
        }
        _ => status
            .steps
            .push(step("handshake", "pending", "尚未验证 MCP 连接。")),
    }
    status.steps.push(match bridge.as_str() {
        "running" => step("bridge", "ok", "Origin 桥接正在运行。"),
        "" => step("bridge", "pending", "安装后检测。"),
        state => step(
            "bridge",
            "user",
            format!("桥接状态：{state}。在 Origin 中点击 Origin MCP Bridge Start。"),
        ),
    });
    let ping_ok = stored
        .as_ref()
        .is_some_and(|verification| !stale && verification.origin_ping_ok && bridge == "running");
    status.steps.push(if ping_ok {
        step("origin-call", "ok", "只读调用 origin_ping 成功。")
    } else {
        step("origin-call", "pending", "桥接运行后进行一次只读调用。")
    });
    status.verification = stored;

    let (state, next) = if origin.is_none() {
        ("not-installed", "install-origin")
    } else if installed.is_empty() && status.base_python.is_empty() {
        ("not-installed", "install-python")
    } else if !runtime_ready {
        ("not-installed", "install")
    } else if connected == 0 {
        ("needs-connection", "connect")
    } else if bridge != "running" {
        (
            "needs-origin",
            bridge_next_step(
                status.app_staged,
                status.app_registered,
                origin
                    .as_ref()
                    .is_some_and(|installation| installation.running),
            ),
        )
    } else if !ping_ok || stale {
        ("needs-connection", "verify")
    } else {
        ("ready", "none")
    };
    status.state = state.to_string();
    status.next_step = next.to_string();
    status
}

fn append_log(context: &RecipeContext, line: &str) {
    let _ = fs::create_dir_all(&context.runtime_dir);
    if let Ok(mut file) = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(context.runtime_dir.join(INSTALL_LOG_FILE))
    {
        let _ = writeln!(file, "[{}] {}", iso_now(), line);
    }
}

fn tail(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    let lines = text.lines().rev().take(6).collect::<Vec<_>>();
    lines
        .into_iter()
        .rev()
        .collect::<Vec<_>>()
        .join(" | ")
        .chars()
        .take(600)
        .collect()
}

/// Creates the isolated runtime, installs the pinned package and stages the
/// Origin Apps. A runtime created by this call is removed again on failure.
pub(crate) fn install(context: &RecipeContext, base_python: &Path) -> Result<RecipeStatus, String> {
    let version = python_version(base_python).ok_or("所选 Python 无法运行。")?;
    match parse_version(&version) {
        Some((3, minor, _)) if (10..=14).contains(&minor) => {}
        _ => return Err(format!("需要 Python 3.10–3.14，所选解释器是 {version}。")),
    }
    let venv = context.venv_dir();
    let created_now = !context.runtime_python().is_file();
    let cleanup = |reason: String| -> String {
        if created_now {
            let _ = fs::remove_dir_all(&venv);
        }
        append_log(context, &format!("failed: {reason}"));
        reason
    };
    fs::create_dir_all(&context.runtime_dir)
        .map_err(|error| format!("无法创建运行环境目录：{error}"))?;
    append_log(
        context,
        &format!("base python {} ({version})", base_python.display()),
    );
    if created_now {
        let output = run(
            Command::new(base_python).arg("-m").arg("venv").arg(&venv),
            Duration::from_secs(180),
            "创建独立运行环境",
        )
        .map_err(cleanup)?;
        if !output.status.success() {
            return Err(cleanup(format!(
                "创建独立运行环境失败：{}",
                tail(&output.stderr)
            )));
        }
    }
    let python = context.runtime_python();
    let output = run(
        Command::new(&python).args([
            "-m",
            "pip",
            "install",
            "--disable-pip-version-check",
            "--no-input",
            "--no-warn-script-location",
            &format!("origin-mcp=={ORIGIN_MCP_VERSION}"),
            &format!("mcp=={ORIGIN_MCP_SDK_VERSION}"),
        ]),
        Duration::from_secs(900),
        "下载并安装 origin-mcp",
    )
    .map_err(cleanup)?;
    if !output.status.success() {
        return Err(cleanup(format!(
            "安装 origin-mcp {ORIGIN_MCP_VERSION} 失败：{}",
            tail(&output.stderr)
        )));
    }
    let installed = installed_package_version(&python).unwrap_or_default();
    let sdk = installed_sdk_version(&python).unwrap_or_default();
    if installed != ORIGIN_MCP_VERSION || sdk != ORIGIN_MCP_SDK_VERSION {
        return Err(cleanup(format!(
            "安装后版本校验失败（得到 origin-mcp {installed}、MCP SDK {sdk}）。"
        )));
    }
    append_log(context, &format!("origin-mcp {installed} installed"));
    // Stages the two Origin App folders under %LOCALAPPDATA%\OriginLab\Apps.
    // Registering them (mkOPX + drag into Origin) stays a user step.
    let output = run(
        Command::new(&python).args(["-m", "origin_mcp", "install-origin-app", "--force"]),
        Duration::from_secs(120),
        "放置 Origin Start/Stop App",
    )?;
    if !output.status.success() {
        append_log(
            context,
            &format!("install-origin-app failed: {}", tail(&output.stderr)),
        );
        return Err(format!("Origin App 文件放置失败：{}", tail(&output.stderr)));
    }
    append_log(context, "origin apps staged");
    Ok(detect(context))
}

/// Line-delimited JSON-RPC over the server's stdio, bounded by `deadline`.
struct StdioSession {
    child: std::process::Child,
    stdin: std::process::ChildStdin,
    lines: mpsc::Receiver<String>,
    deadline: Instant,
}

impl StdioSession {
    fn start(
        python: &Path,
        extra_env: &[(&str, String)],
        timeout: Duration,
    ) -> Result<Self, String> {
        let mut command = Command::new(python);
        command
            .args(["-m", "origin_mcp"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .env("PYTHONIOENCODING", "utf-8");
        for (name, value) in extra_env {
            command.env(name, value);
        }
        crate::configure_background_command(&mut command);
        let mut child = command
            .spawn()
            .map_err(|error| format!("无法启动 MCP 服务器：{error}"))?;
        let stdin = child.stdin.take().ok_or("无法连接 MCP 服务器输入。")?;
        let stdout = child.stdout.take().ok_or("无法读取 MCP 服务器输出。")?;
        if let Some(stderr) = child.stderr.take() {
            // Drain stderr so a chatty server can never block on a full pipe.
            thread::spawn(move || for _ in BufReader::new(stderr).lines() {});
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
        })
    }

    fn send(&mut self, message: &Value) -> Result<(), String> {
        let mut line = serde_json::to_string(message).map_err(|error| error.to_string())?;
        line.push('\n');
        self.stdin
            .write_all(line.as_bytes())
            .and_then(|_| self.stdin.flush())
            .map_err(|error| format!("MCP 服务器已关闭输入：{error}"))
    }

    fn request(&mut self, id: u64, method: &str, params: Value) -> Result<Value, String> {
        self.send(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }))?;
        loop {
            let remaining = self.deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(format!("MCP 服务器在限定时间内没有响应 {method}。"));
            }
            let line = self
                .lines
                .recv_timeout(remaining)
                .map_err(|_| format!("MCP 服务器在限定时间内没有响应 {method}。"))?;
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
}

impl Drop for StdioSession {
    fn drop(&mut self) {
        crate::terminate_child_process_tree(&mut self.child);
    }
}

fn tool_result_text(result: &Value) -> String {
    result
        .get("content")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join(" ")
        })
        .unwrap_or_default()
}

/// The origin-mcp tool envelope: `{ ok, message, error_code? }`, delivered as
/// structured content and as JSON text.
fn tool_envelope(result: &Value) -> (bool, String) {
    let envelope = result
        .get("structuredContent")
        .cloned()
        .or_else(|| serde_json::from_str::<Value>(&tool_result_text(result)).ok())
        .unwrap_or(Value::Null);
    let ok = result.get("isError").and_then(Value::as_bool) != Some(true)
        && envelope.get("ok").and_then(Value::as_bool) == Some(true);
    let message = [
        envelope.get("error_code").and_then(Value::as_str),
        envelope.get("message").and_then(Value::as_str),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join(": ");
    (ok, message.chars().take(240).collect())
}

/// initialize -> tools/list -> origin_bridge_status -> origin_ping(show=false).
/// Fills `verification` as far as it gets; tools/list alone does not prove
/// that Origin automation works, so each level is recorded separately.
fn handshake(
    python: &Path,
    extra_env: &[(&str, String)],
    app_version: &str,
    verification: &mut Verification,
) -> Result<(), String> {
    let mut session = StdioSession::start(python, extra_env, Duration::from_secs(60))?;
    let initialized = session.request(
        1,
        "initialize",
        json!({
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": { "name": "AI SkillHub", "version": app_version }
        }),
    )?;
    let field = |pointer: &str| {
        initialized
            .pointer(pointer)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    verification.protocol_version = field("/protocolVersion");
    verification.server_name = field("/serverInfo/name");
    verification.server_version = field("/serverInfo/version");
    session.send(&json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }))?;
    let tools = session.request(2, "tools/list", json!({}))?;
    let names = tools
        .get("tools")
        .and_then(Value::as_array)
        .map(|tools| {
            tools
                .iter()
                .filter_map(|tool| tool.get("name").and_then(Value::as_str))
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    verification.tool_count = names.len();
    if names.is_empty() {
        return Err("MCP 服务器没有返回任何工具。".to_string());
    }
    if !names.iter().any(|name| name == "origin_bridge_status") {
        verification.bridge_state = bridge_state_with_env(python, extra_env);
        if verification.bridge_state != "running" {
            return Ok(());
        }
        // The author's default compact profile includes origin_ping but omits
        // origin_bridge_status. A successful CLI status must still be followed
        // by the actual MCP ping; it cannot terminate verification early.
    } else {
        let status = session.request(
            3,
            "tools/call",
            json!({ "name": "origin_bridge_status", "arguments": {} }),
        )?;
        let (bridge_ok, bridge_message) = tool_envelope(&status);
        verification.bridge_state = if bridge_ok { "running" } else { "not_running" }.to_string();
        if !bridge_ok {
            // Not a failure of the install: Origin or its bridge is simply not up.
            verification.bridge_state = format!("not_running {bridge_message}").trim().to_string();
            return Ok(());
        }
    }
    if names.iter().any(|name| name == "origin_ping") {
        // Connects to the running Origin session and reports it; it does not
        // create, open, modify or save any project.
        let ping = session.request(
            4,
            "tools/call",
            json!({ "name": "origin_ping", "arguments": { "show": false } }),
        )?;
        let (ping_ok, ping_message) = tool_envelope(&ping);
        verification.origin_ping_ok = ping_ok;
        if !ping_ok {
            return Err(format!("Origin 只读调用失败：{ping_message}"));
        }
    } else {
        return Err("当前工具集未提供 origin_ping，无法确认 Origin 实际可调用。".to_string());
    }
    Ok(())
}

pub(crate) fn verify(context: &RecipeContext) -> RecipeStatus {
    let python = context.runtime_python();
    let mut verification = Verification {
        app_version: context.app_version.clone(),
        package_version: installed_package_version(&python).unwrap_or_default(),
        runtime_python: python.display().to_string(),
        verified_at: iso_now(),
        ..Verification::default()
    };
    let outcome = if verification.package_version != ORIGIN_MCP_VERSION {
        Err("独立运行环境未安装已核验版本，请先安装。".to_string())
    } else {
        handshake(&python, &[], &context.app_version, &mut verification)
    };
    if let Err(failure) = outcome {
        verification.failure = failure;
    }
    write_verification(context, &verification);
    detect(context)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn launcher_keeps_python_paths_containing_spaces() {
        assert_eq!(
            launcher_python_path(r" -V:3.13 * C:\Program Files\Python313\python.exe"),
            Some(PathBuf::from(r"C:\Program Files\Python313\python.exe")),
        );
        assert_eq!(launcher_python_path("No installed Pythons found"), None);
    }

    #[test]
    fn closed_origin_does_not_imply_missing_app_registration() {
        assert_eq!(bridge_next_step(true, true, false), "open-origin");
        assert_eq!(bridge_next_step(true, false, false), "open-origin");
        assert_eq!(bridge_next_step(true, true, true), "start-bridge");
        assert_eq!(bridge_next_step(true, false, true), "register-app");
        assert_eq!(bridge_next_step(false, false, false), "install");
    }

    #[test]
    fn app_files_do_not_count_as_registration_and_invalid_registry_is_rejected() {
        let home = std::env::var_os("USERPROFILE")
            .map(PathBuf::from)
            .unwrap_or_default();
        let local = std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_default();
        let Some((python, _)) = find_base_pythons(&home, &local).into_iter().next() else {
            return;
        };
        let root =
            std::env::temp_dir().join(format!("skillhub-app-registry-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join(START_APP)).unwrap();
        assert!(registered_apps(&python, &root).unwrap().is_empty());
        fs::write(root.join("OPXList.xml"), format!(r#"<OriginStorage><Package Label="{START_APP}"><Package><Name>{START_APP}</Name></Package></Package><Package Label="{STOP_APP}"><Package><Name>Unrelated App</Name></Package></Package></OriginStorage>"#)).unwrap();
        assert_eq!(
            registered_apps(&python, &root).unwrap(),
            vec![START_APP.to_string()]
        );
        fs::write(
            root.join("OPXList.xml"),
            "<!DOCTYPE x [<!ENTITY file SYSTEM 'file:///private'>]><OriginStorage/>",
        )
        .unwrap();
        assert!(registered_apps(&python, &root).is_err());
        fs::write(root.join("OPXList.xml"), "<OriginStorage><broken>").unwrap();
        assert!(registered_apps(&python, &root).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn bridge_helper_rejects_unreviewed_actions_and_labtalk_path_injection() {
        let mut context = RecipeContext {
            runtime_dir: PathBuf::from("runtime"),
            home_dir: PathBuf::from("home"),
            local_app_data: PathBuf::from("safe"),
            app_version: "test".to_string(),
        };
        assert!(origin_helper_command(&context, "run arbitrary script").is_err());
        for path in ["A\";exit", "A%", "A;exit", "A\nexit"] {
            context.local_app_data = PathBuf::from(path);
            assert!(origin_helper_command(&context, "start").is_err());
        }
    }

    #[test]
    fn registry_listing_picks_the_origin_entry_with_a_real_install_dir() {
        let root = std::env::temp_dir().join(format!(
            "skillhub-origin-{}",
            crate::unix_timestamp_string()
        ));
        let install = root.join("Origin2026");
        fs::create_dir_all(&install).unwrap();
        fs::write(install.join("Origin64.exe"), b"").unwrap();
        let listing = format!(
            "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{{X}}\r\n    DisplayName    REG_SZ    Origin 2026\r\n    DisplayVersion    REG_SZ    10.30.0000\r\n    InstallLocation    REG_SZ    {}\\\r\n\r\nHKEY_LOCAL_MACHINE\\...\\{{Y}}\r\n    DisplayName    REG_SZ    OriginLab Viewer\r\n    InstallLocation    REG_SZ    Z:\\missing\r\n",
            install.display()
        );
        let found = parse_origin_registry(&listing).expect("origin entry");
        assert_eq!(found.name, "Origin 2026");
        assert_eq!(found.version, "10.30.0000");
        assert!(found.install_dir.ends_with("Origin2026"));
        assert!(parse_origin_registry("    DisplayName    REG_SZ    Something Else\r\n").is_none());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn versions_and_binding_matching_are_strict() {
        assert_eq!(parse_version("3.13.9"), Some((3, 13, 9)));
        assert_eq!(parse_version("3.10"), Some((3, 10, 0)));
        assert_eq!(parse_version("abc"), None);
        let runtime = Path::new(
            r"C:\Users\A\AppData\Local\AI SkillHub\UserData\mcp-runtimes\origin-mcp\venv\Scripts\python.exe",
        );
        let args = vec!["-m".to_string(), "origin_mcp".to_string()];
        assert!(binding_matches(
            Some("c:/users/a/appdata/local/ai skillhub/userdata/mcp-runtimes/origin-mcp/venv/scripts/python.exe"),
            &args,
            runtime
        ));
        assert!(!binding_matches(Some("python"), &args, runtime));
        assert!(!binding_matches(
            Some(&runtime.display().to_string()),
            &["-m".to_string()],
            runtime
        ));
    }

    #[test]
    fn client_entries_are_read_without_touching_other_servers() {
        let home = std::env::temp_dir().join(format!(
            "skillhub-origin-home-{}",
            crate::unix_timestamp_string()
        ));
        let runtime = home.join("runtime").join("python.exe");
        fs::create_dir_all(home.join(".codex")).unwrap();
        fs::write(
            home.join(".codex").join("config.toml"),
            format!(
                "[mcp_servers.other]\ncommand = \"node\"\n\n[mcp_servers.origin]\ncommand = '{}'\nargs = [\"-m\", \"origin_mcp\"]\n",
                runtime.display()
            ),
        )
        .unwrap();
        fs::write(
            home.join(".claude.json"),
            r#"{"mcpServers":{"origin":{"command":"python","args":["-m","origin_mcp"]},"keep":{"command":"x"}}}"#,
        )
        .unwrap();
        let bindings = client_bindings(&home, &runtime);
        let codex = bindings
            .iter()
            .find(|binding| binding.host_id == crate::mcp_mutation::HOST_CODEX)
            .unwrap();
        let claude = bindings
            .iter()
            .find(|binding| binding.host_id == crate::mcp_mutation::HOST_CLAUDE_CODE)
            .unwrap();
        assert!(codex.configured && codex.matches_runtime);
        assert!(
            claude.configured && !claude.matches_runtime,
            "bare `python` is not this runtime"
        );
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn stale_verification_never_reports_ready() {
        let root = std::env::temp_dir().join(format!(
            "skillhub-origin-verify-{}",
            crate::unix_timestamp_string()
        ));
        let context = RecipeContext {
            runtime_dir: root.join("runtime"),
            home_dir: root.join("home"),
            local_app_data: root.join("local"),
            app_version: "3.2.8".to_string(),
        };
        write_verification(
            &context,
            &Verification {
                app_version: "3.2.7".to_string(),
                package_version: ORIGIN_MCP_VERSION.to_string(),
                runtime_python: context.runtime_python().display().to_string(),
                origin_ping_ok: true,
                bridge_state: "running".to_string(),
                ..Verification::default()
            },
        );
        let status = detect(&context);
        assert_ne!(status.state, "ready");
        assert!(status.verification_stale || status.installed_version.is_empty());
        let _ = fs::remove_dir_all(root);
    }

    const FAKE_SERVER: &str = r#"import json, os, sys
mode = os.environ.get("FAKE_BRIDGE", "down")
is_up = mode in ("up", "compact-up")
if 'status' in sys.argv:
    print(json.dumps({'state': 'running' if is_up else 'not_running'}))
    sys.exit(0)
for line in sys.stdin:
    message = json.loads(line)
    ident = message.get("id")
    if ident is None:
        continue
    method = message.get("method")
    if method == "initialize":
        result = {"protocolVersion": "2025-06-18", "serverInfo": {"name": "origin-mcp", "version": "0.1.4"}, "capabilities": {"tools": {}}}
    elif method == "tools/list":
        result = {"tools": [{"name": "origin_ping"}, {"name": "origin_plot"}]}
        if not mode.startswith('compact'):
            result['tools'].append({"name": "origin_bridge_status"})
    else:
        name = message["params"]["name"]
        if name == "origin_bridge_status":
            envelope = {"ok": is_up, "message": "Origin bridge responded." if is_up else "not reachable"}
            if not is_up:
                envelope["error_code"] = "origin_bridge_unavailable"
        else:
            # Only a read-only, hidden ping is acceptable.
            envelope = {"ok": message["params"]["arguments"].get("show") is False, "message": "Connected to Origin."}
        result = {"content": [{"type": "text", "text": json.dumps(envelope)}], "structuredContent": envelope, "isError": False}
    sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": ident, "result": result}) + "\n")
    sys.stdout.flush()
"#;

    #[test]
    fn handshake_reaches_tools_bridge_and_read_only_ping() {
        let home = std::env::var_os("USERPROFILE")
            .map(PathBuf::from)
            .unwrap_or_default();
        let local = std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_default();
        let Some((python, _)) = find_base_pythons(&home, &local).into_iter().next() else {
            return;
        };
        let root = std::env::temp_dir().join(format!(
            "skillhub-fake-mcp-{}",
            crate::unix_timestamp_string()
        ));
        let package = root.join("origin_mcp");
        fs::create_dir_all(&package).unwrap();
        fs::write(package.join("__init__.py"), "__version__ = '0.1.4'\n").unwrap();
        fs::write(package.join("__main__.py"), FAKE_SERVER).unwrap();
        let path = root.display().to_string();

        let mut down = Verification::default();
        handshake(
            &python,
            &[
                ("PYTHONPATH", path.clone()),
                ("FAKE_BRIDGE", "down".to_string()),
            ],
            "3.2.8",
            &mut down,
        )
        .expect("handshake with bridge down still succeeds");
        assert_eq!(down.server_name, "origin-mcp");
        assert_eq!(down.tool_count, 3);
        assert!(down.bridge_state.starts_with("not_running"));
        assert!(down.bridge_state.contains("origin_bridge_unavailable"));
        assert!(!down.origin_ping_ok);

        let mut up = Verification::default();
        handshake(
            &python,
            &[
                ("PYTHONPATH", path.clone()),
                ("FAKE_BRIDGE", "up".to_string()),
            ],
            "3.2.8",
            &mut up,
        )
        .expect("handshake with bridge up");
        assert_eq!(up.bridge_state, "running");
        assert!(up.origin_ping_ok, "ping must be sent with show=false");
        for mode in ["compact-up", "compact-down"] {
            let mut compact = Verification::default();
            handshake(
                &python,
                &[
                    ("PYTHONPATH", path.clone()),
                    ("FAKE_BRIDGE", mode.to_string()),
                ],
                "3.2.12",
                &mut compact,
            )
            .expect("Compact profile verification");
            assert_eq!(
                compact.tool_count, 2,
                "No origin_bridge_status tool in compact mode"
            );
            assert_eq!(compact.origin_ping_ok, mode == "compact-up");
        }
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn a_silent_server_times_out_instead_of_hanging() {
        let home = std::env::var_os("USERPROFILE")
            .map(PathBuf::from)
            .unwrap_or_default();
        let local = std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_default();
        let Some((python, _)) = find_base_pythons(&home, &local).into_iter().next() else {
            return;
        };
        let root = std::env::temp_dir().join(format!(
            "skillhub-silent-mcp-{}",
            crate::unix_timestamp_string()
        ));
        let package = root.join("origin_mcp");
        fs::create_dir_all(&package).unwrap();
        fs::write(package.join("__init__.py"), "").unwrap();
        fs::write(package.join("__main__.py"), "import time\ntime.sleep(30)\n").unwrap();
        let mut session = StdioSession::start(
            &python,
            &[("PYTHONPATH", root.display().to_string())],
            Duration::from_secs(2),
        )
        .unwrap();
        let started = Instant::now();
        let error = session.request(1, "initialize", json!({})).unwrap_err();
        assert!(error.contains("没有响应"));
        assert!(started.elapsed() < Duration::from_secs(10));
        drop(session);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    #[ignore = "Explicit live Origin session; only origin_ping(show=false), no project edits"]
    fn live_origin_read_only_handshake() {
        let runtime = std::env::var_os("AI_SKILLHUB_ORIGIN_RUNTIME")
            .map(PathBuf::from)
            .expect("Explicit runtime path required");
        let mut verification = Verification::default();
        handshake(&runtime, &[], "3.2.12", &mut verification).expect("Live Origin MCP handshake");
        assert_eq!(verification.bridge_state, "running");
        assert!(
            verification.origin_ping_ok,
            "A tool list alone is insufficient"
        );
        println!("Origin live verification: protocol={}, tools={}, bridge={}, origin_ping(show=false)={}",
            verification.protocol_version, verification.tool_count, verification.bridge_state,
            verification.origin_ping_ok);
    }

    #[test]
    fn mkopx_commands_use_backslash_paths_and_app_names() {
        let commands = mkopx_commands(Path::new(r"C:\Users\A\AppData\Local\OriginLab\Apps"));
        assert_eq!(commands.len(), 2);
        assert!(commands[0].starts_with("mkOPX app:=\"Origin MCP Bridge Start\""));
        assert!(commands[0].contains(r"Apps\Origin MCP Bridge Start.opx"));
        assert!(!commands[1].contains('/'));
    }
}
