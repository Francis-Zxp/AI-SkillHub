//! v3.3 MCP library (docs/v3.3/mcp-contract.md §1–§4).
//!
//! The library is SkillHub's own record of every MCP server: the full spec is
//! stored DPAPI-protected in SQLite, and each (server × AI 工具) cell records
//! the desired state. Every client config write still goes through the
//! transaction engine in `mcp_mutation` (fingerprint → DPAPI snapshot →
//! atomic write → read-back), one file per transaction.
//!
//! Invariants kept here:
//! - no child process is ever started from this module;
//! - credential values never appear in returned structs, errors, logs,
//!   operation summaries or plaintext SQLite columns;
//! - import is read-only for client files;
//! - JSONC client files stay read-only.

use crate::mcp_json_doc::{Node, ObjectMap};
use crate::mcp_mutation::{
    self as engine, EntryChange, EntryOp, McpMutationContext, ProjectedEntry, TargetRead,
    TargetReadStatus, HOST_CLAUDE_CODE, HOST_CLAUDE_DESKTOP, HOST_CODEX, HOST_CURSOR,
};
use crate::mcp_paste;
use crate::mcp_secrets::{self, EnvStore};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value as JsonValue};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub(crate) const SECRET_MASK: &str = "••••••••";
pub(crate) const MCP_LIBRARY_CHANGED_EVENT: &str = "mcp-library-changed";
pub(crate) const MCP_TEST_PROGRESS_EVENT: &str = "mcp-test-progress";
const UNDO_WINDOW_NS: u128 = engine::SNAPSHOT_TTL_MS * 1_000_000;
const MAX_HISTORY_ROWS: usize = 200;
const PREF_INITIALIZED: &str = "mcp.library.initialized";
const MAX_CLAUDE_PROJECTS: usize = 128;
const MAX_ERROR_CHARS: usize = 280;

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum ClientId {
    Codex,
    ClaudeCode,
    ClaudeDesktop,
    Cursor,
}

impl ClientId {
    pub(crate) const ALL: [ClientId; 4] = [
        ClientId::Codex,
        ClientId::ClaudeCode,
        ClientId::ClaudeDesktop,
        ClientId::Cursor,
    ];

    pub(crate) fn as_str(self) -> &'static str {
        match self {
            ClientId::Codex => "codex",
            ClientId::ClaudeCode => "claude-code",
            ClientId::ClaudeDesktop => "claude-desktop",
            ClientId::Cursor => "cursor",
        }
    }

    pub(crate) fn parse(value: &str) -> Option<Self> {
        ClientId::ALL
            .into_iter()
            .find(|client| client.as_str() == value)
    }

    pub(crate) fn label(self) -> &'static str {
        match self {
            ClientId::Codex => "Codex",
            ClientId::ClaudeCode => "Claude Code",
            ClientId::ClaudeDesktop => "Claude Desktop",
            ClientId::Cursor => "Cursor",
        }
    }

    pub(crate) fn host_id(self) -> &'static str {
        match self {
            ClientId::Codex => HOST_CODEX,
            ClientId::ClaudeCode => HOST_CLAUDE_CODE,
            ClientId::ClaudeDesktop => HOST_CLAUDE_DESKTOP,
            ClientId::Cursor => HOST_CURSOR,
        }
    }

    pub(crate) fn from_host(host_id: &str) -> Option<Self> {
        ClientId::ALL
            .into_iter()
            .find(|client| client.host_id() == host_id)
    }

    fn adapter_id(self) -> &'static str {
        match self {
            ClientId::Codex => "codex",
            ClientId::ClaudeCode | ClientId::ClaudeDesktop => "claude",
            ClientId::Cursor => "cursor",
        }
    }

    fn transports(self) -> Vec<Transport> {
        match self {
            ClientId::Codex => vec![Transport::Stdio, Transport::Http],
            ClientId::ClaudeDesktop => vec![Transport::Stdio],
            ClientId::ClaudeCode | ClientId::Cursor => {
                vec![Transport::Stdio, Transport::Http, Transport::Sse]
            }
        }
    }

    fn secret_reference(self) -> &'static str {
        match self {
            ClientId::Codex => "env-forward",
            ClientId::ClaudeCode => "dollar-brace",
            ClientId::Cursor => "env-colon",
            ClientId::ClaudeDesktop => "none",
        }
    }

    fn supports_references(self) -> bool {
        self != ClientId::ClaudeDesktop
    }

    fn disable_mode(self) -> &'static str {
        if self == ClientId::Codex {
            "flag"
        } else {
            "remove"
        }
    }

    fn is_json(self) -> bool {
        self != ClientId::Codex
    }

    /// Whether a new or changed entry needs a restart of the AI 工具.
    fn restart_hint(self) -> bool {
        self != ClientId::Cursor
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum Transport {
    Stdio,
    Http,
    Sse,
}

impl Transport {
    fn as_str(self) -> &'static str {
        match self {
            Transport::Stdio => "stdio",
            Transport::Http => "http",
            Transport::Sse => "sse",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "stdio" => Some(Transport::Stdio),
            "http" => Some(Transport::Http),
            "sse" => Some(Transport::Sse),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum Scope {
    User,
    Project,
    Local,
}

impl Scope {
    fn as_str(self) -> &'static str {
        match self {
            Scope::User => "user",
            Scope::Project => "project",
            Scope::Local => "local",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "user" => Some(Scope::User),
            "project" => Some(Scope::Project),
            "local" => Some(Scope::Local),
            _ => None,
        }
    }
}

// ---------------------------------------------------------------------------
// Errors (§3.5): secret-free zh messages with a stable code.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct McpError {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub params: Option<BTreeMap<String, JsonValue>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_id: Option<ClientId>,
}

impl McpError {
    pub(crate) fn new(code: &str, message: impl Into<String>) -> Self {
        let message: String = message.into();
        let message = if message.chars().count() > MAX_ERROR_CHARS {
            let mut short = message
                .chars()
                .take(MAX_ERROR_CHARS - 1)
                .collect::<String>();
            short.push('…');
            short
        } else {
            message
        };
        Self {
            code: code.to_string(),
            message,
            params: None,
            client_id: None,
        }
    }

    pub(crate) fn with_client(mut self, client: ClientId) -> Self {
        self.client_id = Some(client);
        self.param("client", client.label())
    }

    pub(crate) fn param(mut self, key: &str, value: impl Into<JsonValue>) -> Self {
        self.params
            .get_or_insert_with(BTreeMap::new)
            .insert(key.to_string(), value.into());
        self
    }

    fn not_found() -> Self {
        Self::new("not-found", "没有找到这个 MCP，可能已被删除。")
    }

    fn invalid(message: impl Into<String>) -> Self {
        Self::new("invalid-input", message)
    }

    fn library(message: &str) -> Self {
        Self::new("library-write-failed", message)
    }
}

impl fmt::Display for McpError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}: {}", self.code, self.message)
    }
}

fn db_error(_: rusqlite::Error) -> McpError {
    McpError::new("engine", "MCP 库读写失败；没有改动任何 AI 工具配置。")
}

/// Maps an engine message (already secret-free zh text) to a contract code.
fn classify_engine_error(message: &str) -> McpError {
    let code = if message.contains("JSONC") || message.contains("严格 JSON") {
        "config-jsonc"
    } else if message.contains("2 MB") {
        "config-too-large"
    } else if message.contains("发生变化") || message.contains("外部修改") {
        "config-changed"
    } else if message.contains("对象式 env_vars") {
        "codex-structured-env"
    } else if message == engine::AMBIGUOUS_PROJECT_MESSAGE {
        "config-ambiguous-project"
    } else if message.contains("配置目录") && message.contains("不存在") {
        "client-not-installed"
    } else if message.contains("无法保真解析")
        || message.contains("无法解析")
        || message.contains("根节点")
        || message.contains("必须是对象")
        || message.contains("UTF-8")
    {
        "config-parse-failed"
    } else if message.contains("不可读")
        || message.contains("读取失败")
        || message.contains("符号链接")
    {
        "config-unreadable"
    } else {
        "engine"
    };
    McpError::new(code, message)
}

// ---------------------------------------------------------------------------
// Spec (DPAPI-protected; never `Debug`, never sent to the webview as is)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum SecretStorage {
    /// A non-secret literal value.
    Literal,
    /// Value in HKCU\Environment, written by SkillHub; configs get references.
    UserEnv,
    /// Value inside the DPAPI spec; written literally only with consent.
    Library,
    /// A reference to a variable SkillHub did not set.
    External,
}

impl SecretStorage {
    fn contract_name(self) -> &'static str {
        match self {
            SecretStorage::Literal => "none",
            SecretStorage::UserEnv => "user_env",
            SecretStorage::Library => "library",
            SecretStorage::External => "external",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum HeaderTemplate {
    Raw,
    Bearer,
    Literal,
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SpecArg {
    pub value: String,
    #[serde(default)]
    pub secret: bool,
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SpecEnv {
    pub name: String,
    #[serde(default)]
    pub secret: bool,
    pub storage: SecretStorage,
    /// The variable that holds the value when it differs from `name`.
    #[serde(default)]
    pub env_var: Option<String>,
    #[serde(default)]
    pub value: Option<String>,
    #[serde(default)]
    pub inline_clients: Vec<ClientId>,
    #[serde(default)]
    pub required: bool,
}

impl SpecEnv {
    fn variable(&self) -> &str {
        self.env_var.as_deref().unwrap_or(&self.name)
    }
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SpecHeader {
    pub name: String,
    pub template: HeaderTemplate,
    #[serde(default)]
    pub env_var: Option<String>,
    pub storage: SecretStorage,
    #[serde(default)]
    pub value: Option<String>,
    #[serde(default)]
    pub inline_clients: Vec<ClientId>,
    #[serde(default)]
    pub required: bool,
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct McpServerSpec {
    pub transport: Transport,
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub args: Vec<SpecArg>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub env: Vec<SpecEnv>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub headers: Vec<SpecHeader>,
    #[serde(default)]
    pub codex_required: bool,
    /// Per-client unknown keys seen at import, or the last entry removed on
    /// disable, as order-preserving JSON object text. Projected only back into
    /// that client.
    #[serde(default)]
    pub client_extra: BTreeMap<String, String>,
    /// Clients allowed to receive secret-looking arguments (imported as is).
    #[serde(default)]
    pub secret_arg_clients: Vec<ClientId>,
}

impl fmt::Debug for McpServerSpec {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("McpServerSpec")
            .field("transport", &self.transport)
            .field("args", &self.args.len())
            .field("env", &self.env.len())
            .field("headers", &self.headers.len())
            .finish()
    }
}

impl McpServerSpec {
    fn empty(transport: Transport) -> Self {
        Self {
            transport,
            command: None,
            args: Vec::new(),
            cwd: None,
            env: Vec::new(),
            url: None,
            headers: Vec::new(),
            codex_required: false,
            client_extra: BTreeMap::new(),
            secret_arg_clients: Vec::new(),
        }
    }

    /// Every secret value the spec holds, for redaction (never returned).
    fn secret_values(&self, env: &dyn EnvStore) -> Vec<String> {
        let mut values = Vec::new();
        for item in &self.env {
            if !item.secret {
                continue;
            }
            match item.storage {
                SecretStorage::Library | SecretStorage::Literal => {
                    values.extend(item.value.clone())
                }
                SecretStorage::UserEnv | SecretStorage::External => {
                    values.extend(mcp_secrets::resolve_env_value(env, item.variable()))
                }
            }
        }
        for header in &self.headers {
            match header.storage {
                SecretStorage::Library => values.extend(header.value.clone()),
                SecretStorage::UserEnv | SecretStorage::External => {
                    if let Some(variable) = &header.env_var {
                        values.extend(mcp_secrets::resolve_env_value(env, variable));
                    }
                }
                SecretStorage::Literal => {}
            }
        }
        values.extend(
            self.args
                .iter()
                .filter(|arg| arg.secret)
                .map(|arg| arg.value.clone()),
        );
        values.retain(|value| value.chars().count() >= 4);
        values
    }

    /// The same spec without client stashes (for change detection).
    fn without_extras(&self) -> Self {
        Self {
            client_extra: BTreeMap::new(),
            ..self.clone()
        }
    }
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

/// Trusted inputs resolved by the Rust command wrapper, never by the webview.
pub(crate) struct McpLibraryContext {
    pub mutation: McpMutationContext,
    pub db_path: PathBuf,
    /// Windows `cmd /c` wrapping applies (a parameter so tests run anywhere).
    pub windows: bool,
    pub env: Arc<dyn EnvStore>,
    /// `AI SkillHub` version for the MCP `clientInfo`.
    pub app_version: String,
}

impl McpLibraryContext {
    fn library_dir(&self) -> PathBuf {
        self.mutation.private_state_dir.join("mcp-library")
    }

    fn hash_key_path(&self) -> PathBuf {
        self.library_dir().join("hash.key")
    }

    fn home(&self) -> &Path {
        &self.mutation.home_dir
    }

    /// A planning copy in which the environment values `ops` are about to
    /// write are already visible. A client that receives a literal value
    /// (inline consent, e.g. Claude Desktop) must get the value the user just
    /// entered, not the one the registry still holds. Nothing is written.
    fn with_pending_env(&self, ops: &[EnvOp]) -> McpLibraryContext {
        let pending = ops
            .iter()
            .map(|op| match op {
                EnvOp::Set { name, value } => (name.clone(), Some(value.clone())),
                EnvOp::Delete { name } => (name.clone(), None),
            })
            .collect::<HashMap<_, _>>();
        McpLibraryContext {
            mutation: self.mutation.clone(),
            db_path: self.db_path.clone(),
            windows: self.windows,
            env: Arc::new(mcp_secrets::PendingEnvStore::new(
                Arc::clone(&self.env),
                pending,
            )),
            app_version: self.app_version.clone(),
        }
    }
}

// ---------------------------------------------------------------------------
// Time, generation and HMAC
// ---------------------------------------------------------------------------

static GENERATION: AtomicU64 = AtomicU64::new(1);

pub(crate) fn current_generation() -> u64 {
    GENERATION.load(Ordering::SeqCst)
}

fn bump_generation() -> u64 {
    GENERATION.fetch_add(1, Ordering::SeqCst) + 1
}

/// Clients whose config SkillHub wrote since this process started.
fn written_clients() -> &'static Mutex<BTreeSet<ClientId>> {
    static WRITTEN: OnceLock<Mutex<BTreeSet<ClientId>>> = OnceLock::new();
    WRITTEN.get_or_init(|| Mutex::new(BTreeSet::new()))
}

fn mark_client_written(client: ClientId) {
    written_clients()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(client);
}

fn client_written(client: ClientId) -> bool {
    written_clients()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .contains(&client)
}

fn now_ns() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default()
}

fn ns_text(value: u128) -> String {
    value.to_string()
}

fn parse_ns(value: &str) -> u128 {
    value.trim().parse::<u128>().unwrap_or_default()
}

/// ISO 8601 (UTC) for a unix-nanosecond timestamp.
pub(crate) fn iso_from_ns(value: u128) -> String {
    let seconds = (value / 1_000_000_000) as i64;
    let millis = ((value / 1_000_000) % 1000) as u32;
    let days = seconds.div_euclid(86_400);
    let rem = seconds.rem_euclid(86_400);
    let (hour, minute, second) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    // Civil-from-days (Howard Hinnant).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { year + 1 } else { year };
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z")
}

fn sha256_bytes(parts: &[&[u8]]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    for part in parts {
        hasher.update(part);
    }
    hasher.finalize().into()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// HMAC-SHA256 over the length-prefixed parts (no extra dependency).
pub(crate) fn hmac_hex(key: &[u8; 32], parts: &[&[u8]]) -> String {
    let mut inner_pad = [0x36u8; 64];
    let mut outer_pad = [0x5cu8; 64];
    for (index, byte) in key.iter().enumerate() {
        inner_pad[index] ^= byte;
        outer_pad[index] ^= byte;
    }
    let mut inner = Sha256::new();
    inner.update(inner_pad);
    for part in parts {
        inner.update((part.len() as u64).to_le_bytes());
        inner.update(part);
    }
    let inner_digest = inner.finalize();
    let mut outer = Sha256::new();
    outer.update(outer_pad);
    outer.update(inner_digest);
    hex(&outer.finalize())
}

/// The local HMAC key (§1.4): 32 bytes from two v4 UUIDs, DPAPI-protected at
/// `private_state_dir/mcp-library/hash.key`, cached per path.
fn hash_key(ctx: &McpLibraryContext) -> Result<[u8; 32], McpError> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, [u8; 32]>>> = OnceLock::new();
    let path = ctx.hash_key_path();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let mut cache = cache
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(key) = cache.get(&path) {
        return Ok(*key);
    }
    let failure = || McpError::new("engine", "无法准备 MCP 库的本地校验密钥。");
    let key = match std::fs::read(&path) {
        Ok(protected) => {
            let bytes = engine::unprotect_private_backup(&protected).map_err(|_| failure())?;
            <[u8; 32]>::try_from(bytes.as_slice()).map_err(|_| failure())?
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            engine::ensure_private_directory(&ctx.library_dir()).map_err(|_| failure())?;
            let mut key = [0u8; 32];
            key[..16].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
            key[16..].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
            let protected = engine::protect_private_backup(&key).map_err(|_| failure())?;
            let temp = path.with_extension(format!("tmp-{}", uuid::Uuid::new_v4().simple()));
            std::fs::write(&temp, protected).map_err(|_| failure())?;
            if std::fs::rename(&temp, &path).is_err() {
                let _ = std::fs::remove_file(&temp);
                // Another writer won the race: use its key.
                let protected = std::fs::read(&path).map_err(|_| failure())?;
                let bytes = engine::unprotect_private_backup(&protected).map_err(|_| failure())?;
                <[u8; 32]>::try_from(bytes.as_slice()).map_err(|_| failure())?
            } else {
                key
            }
        }
        Err(_) => return Err(failure()),
    };
    cache.insert(path, key);
    Ok(key)
}

fn protect_json<T: Serialize>(value: &T) -> Result<Vec<u8>, McpError> {
    let plain =
        serde_json::to_vec(value).map_err(|_| McpError::library("MCP 库数据序列化失败。"))?;
    engine::protect_private_backup(&plain)
        .map_err(|_| McpError::library("MCP 库数据无法加密保存。"))
}

fn unprotect_json<T: for<'de> Deserialize<'de>>(bytes: &[u8]) -> Result<T, McpError> {
    let plain = engine::unprotect_private_backup(bytes)
        .map_err(|_| McpError::new("engine", "MCP 库数据无法解开，可能属于其他 Windows 用户。"))?;
    serde_json::from_slice(&plain).map_err(|_| McpError::new("engine", "MCP 库数据格式无效。"))
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

pub(crate) fn ensure_schema(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS operator_preferences (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL DEFAULT '',
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS mcp_servers (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            name_key TEXT NOT NULL UNIQUE,
            display_name TEXT NOT NULL DEFAULT '',
            transport TEXT NOT NULL,
            spec_protected BLOB NOT NULL,
            spec_revision INTEGER NOT NULL DEFAULT 1,
            summary_json TEXT NOT NULL,
            source_json TEXT NOT NULL,
            meta_json TEXT NOT NULL DEFAULT '{}',
            test_json TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            deleted_at TEXT
        );
        CREATE TABLE IF NOT EXISTS mcp_server_clients (
            server_id TEXT NOT NULL,
            client_id TEXT NOT NULL,
            scope TEXT NOT NULL DEFAULT 'user',
            workspace_id TEXT NOT NULL DEFAULT '',
            enabled INTEGER NOT NULL DEFAULT 0,
            inline_consent INTEGER NOT NULL DEFAULT 0,
            last_written_hash TEXT NOT NULL DEFAULT '',
            last_seen_hash TEXT NOT NULL DEFAULT '',
            last_error_code TEXT NOT NULL DEFAULT '',
            last_error_message TEXT NOT NULL DEFAULT '',
            last_operation_id TEXT NOT NULL DEFAULT '',
            updated_at TEXT NOT NULL,
            PRIMARY KEY (server_id, client_id, scope, workspace_id)
        );
        CREATE TABLE IF NOT EXISTS mcp_operations (
            id TEXT PRIMARY KEY,
            created_at TEXT NOT NULL,
            kind TEXT NOT NULL,
            state TEXT NOT NULL,
            summary_json TEXT NOT NULL,
            snapshot_ids_json TEXT NOT NULL DEFAULT '[]',
            undo_protected BLOB,
            undone_by TEXT NOT NULL DEFAULT '',
            expires_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS mcp_env_vars (
            name TEXT PRIMARY KEY,
            created_by_skillhub INTEGER NOT NULL,
            updated_at TEXT NOT NULL
        );",
    )
}

fn open_db(ctx: &McpLibraryContext) -> Result<Connection, McpError> {
    if let Some(parent) = ctx.db_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|_| McpError::new("engine", "无法打开 MCP 库。"))?;
    }
    let connection = Connection::open(&ctx.db_path).map_err(db_error)?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(db_error)?;
    ensure_schema(&connection).map_err(db_error)?;
    Ok(connection)
}

fn read_preference(connection: &Connection, key: &str) -> Option<String> {
    connection
        .query_row(
            "SELECT value FROM operator_preferences WHERE key = ?1",
            params![key],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .ok()
        .flatten()
}

fn write_preference(connection: &Connection, key: &str, value: &str) -> Result<(), McpError> {
    connection
        .execute(
            "INSERT INTO operator_preferences (key, value, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            params![key, value, ns_text(now_ns())],
        )
        .map_err(db_error)?;
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub(crate) enum McpServerSource {
    Import { client_id: ClientId, scope: Scope },
    Paste { format: String },
    Template { id: String },
    Github { repo: String },
    Recipe { id: String },
    Manual,
}

/// Stored test summary (`test_json`), messages already redacted.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredTest {
    status: String,
    #[serde(default)]
    tools_count: Option<u32>,
    tested_at: String,
    message_code: String,
    spec_revision: i64,
}

/// One library server as stored.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServerRecord {
    id: String,
    name: String,
    display_name: String,
    spec: McpServerSpec,
    spec_revision: i64,
    source: McpServerSource,
    meta: JsonValue,
    #[serde(default)]
    test: Option<StoredTest>,
    created_at: String,
    updated_at: String,
    #[serde(default)]
    deleted_at: Option<String>,
}

impl fmt::Debug for ServerRecord {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "ServerRecord({})", self.name)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RowKey {
    server_id: String,
    client: ClientId,
    scope: Scope,
    workspace_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct ClientRow {
    key: RowKey,
    enabled: bool,
    inline_consent: bool,
    last_written_hash: String,
    last_seen_hash: String,
    last_error_code: String,
    last_error_message: String,
    last_operation_id: String,
}

impl ClientRow {
    fn new(key: RowKey) -> Self {
        Self {
            key,
            enabled: false,
            inline_consent: false,
            last_written_hash: String::new(),
            last_seen_hash: String::new(),
            last_error_code: String::new(),
            last_error_message: String::new(),
            last_operation_id: String::new(),
        }
    }
}

fn load_servers(
    connection: &Connection,
    include_deleted: bool,
) -> Result<Vec<ServerRecord>, McpError> {
    let mut statement = connection
        .prepare(
            "SELECT id, name, display_name, spec_protected, spec_revision, source_json, meta_json,
                    test_json, created_at, updated_at, deleted_at
             FROM mcp_servers",
        )
        .map_err(db_error)?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Vec<u8>>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, String>(7)?,
                row.get::<_, String>(8)?,
                row.get::<_, String>(9)?,
                row.get::<_, Option<String>>(10)?,
            ))
        })
        .map_err(db_error)?;
    let mut servers = Vec::new();
    for row in rows {
        let (
            id,
            name,
            display_name,
            protected,
            revision,
            source,
            meta,
            test,
            created,
            updated,
            deleted,
        ) = row.map_err(db_error)?;
        if deleted.is_some() && !include_deleted {
            continue;
        }
        let Ok(spec) = unprotect_json::<McpServerSpec>(&protected) else {
            // A row from another Windows profile cannot be read; skip it.
            continue;
        };
        servers.push(ServerRecord {
            id,
            name,
            display_name,
            spec,
            spec_revision: revision,
            source: serde_json::from_str(&source).unwrap_or(McpServerSource::Manual),
            meta: serde_json::from_str(&meta).unwrap_or_else(|_| json!({})),
            test: serde_json::from_str(&test).ok(),
            created_at: created,
            updated_at: updated,
            deleted_at: deleted,
        });
    }
    Ok(servers)
}

fn load_rows(connection: &Connection) -> Result<Vec<ClientRow>, McpError> {
    let mut statement = connection
        .prepare(
            "SELECT server_id, client_id, scope, workspace_id, enabled, inline_consent,
                    last_written_hash, last_seen_hash, last_error_code, last_error_message,
                    last_operation_id
             FROM mcp_server_clients",
        )
        .map_err(db_error)?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, String>(7)?,
                row.get::<_, String>(8)?,
                row.get::<_, String>(9)?,
                row.get::<_, String>(10)?,
            ))
        })
        .map_err(db_error)?;
    let mut result = Vec::new();
    for row in rows {
        let (
            server_id,
            client,
            scope,
            workspace_id,
            enabled,
            consent,
            written,
            seen,
            code,
            message,
            operation,
        ) = row.map_err(db_error)?;
        let (Some(client), Some(scope)) = (ClientId::parse(&client), Scope::parse(&scope)) else {
            continue;
        };
        result.push(ClientRow {
            key: RowKey {
                server_id,
                client,
                scope,
                workspace_id,
            },
            enabled: enabled != 0,
            inline_consent: consent != 0,
            last_written_hash: written,
            last_seen_hash: seen,
            last_error_code: code,
            last_error_message: message,
            last_operation_id: operation,
        });
    }
    Ok(result)
}

fn save_server(connection: &Connection, server: &ServerRecord) -> Result<(), McpError> {
    let summary = server_summary(&server.spec);
    let protected = protect_json(&server.spec)?;
    connection
        .execute(
            "INSERT INTO mcp_servers (id, name, name_key, display_name, transport, spec_protected,
                 spec_revision, summary_json, source_json, meta_json, test_json, created_at,
                 updated_at, deleted_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
             ON CONFLICT(id) DO UPDATE SET
                 name = excluded.name, name_key = excluded.name_key,
                 display_name = excluded.display_name, transport = excluded.transport,
                 spec_protected = excluded.spec_protected, spec_revision = excluded.spec_revision,
                 summary_json = excluded.summary_json, source_json = excluded.source_json,
                 meta_json = excluded.meta_json, test_json = excluded.test_json,
                 updated_at = excluded.updated_at, deleted_at = excluded.deleted_at",
            params![
                server.id,
                server.name,
                server.name.to_ascii_lowercase(),
                server.display_name,
                server.spec.transport.as_str(),
                protected,
                server.spec_revision,
                serde_json::to_string(&summary).unwrap_or_else(|_| "{}".to_string()),
                serde_json::to_string(&server.source).unwrap_or_else(|_| "{}".to_string()),
                serde_json::to_string(&server.meta).unwrap_or_else(|_| "{}".to_string()),
                server
                    .test
                    .as_ref()
                    .and_then(|test| serde_json::to_string(test).ok())
                    .unwrap_or_default(),
                server.created_at,
                server.updated_at,
                server.deleted_at,
            ],
        )
        .map_err(db_error)?;
    Ok(())
}

fn delete_server_hard(connection: &Connection, server_id: &str) -> Result<(), McpError> {
    connection
        .execute(
            "DELETE FROM mcp_server_clients WHERE server_id = ?1",
            params![server_id],
        )
        .map_err(db_error)?;
    connection
        .execute("DELETE FROM mcp_servers WHERE id = ?1", params![server_id])
        .map_err(db_error)?;
    Ok(())
}

fn save_row(connection: &Connection, row: &ClientRow) -> Result<(), McpError> {
    connection
        .execute(
            "INSERT INTO mcp_server_clients (server_id, client_id, scope, workspace_id, enabled,
                 inline_consent, last_written_hash, last_seen_hash, last_error_code,
                 last_error_message, last_operation_id, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
             ON CONFLICT(server_id, client_id, scope, workspace_id) DO UPDATE SET
                 enabled = excluded.enabled, inline_consent = excluded.inline_consent,
                 last_written_hash = excluded.last_written_hash,
                 last_seen_hash = excluded.last_seen_hash,
                 last_error_code = excluded.last_error_code,
                 last_error_message = excluded.last_error_message,
                 last_operation_id = excluded.last_operation_id,
                 updated_at = excluded.updated_at",
            params![
                row.key.server_id,
                row.key.client.as_str(),
                row.key.scope.as_str(),
                row.key.workspace_id,
                i64::from(row.enabled),
                i64::from(row.inline_consent),
                row.last_written_hash,
                row.last_seen_hash,
                row.last_error_code,
                row.last_error_message,
                row.last_operation_id,
                ns_text(now_ns()),
            ],
        )
        .map_err(db_error)?;
    Ok(())
}

fn delete_row(connection: &Connection, key: &RowKey) -> Result<(), McpError> {
    connection
        .execute(
            "DELETE FROM mcp_server_clients
             WHERE server_id = ?1 AND client_id = ?2 AND scope = ?3 AND workspace_id = ?4",
            params![
                key.server_id,
                key.client.as_str(),
                key.scope.as_str(),
                key.workspace_id
            ],
        )
        .map_err(db_error)?;
    Ok(())
}

fn env_var_created_by_skillhub(connection: &Connection, name: &str) -> Option<bool> {
    connection
        .query_row(
            "SELECT created_by_skillhub FROM mcp_env_vars WHERE upper(name) = upper(?1)",
            params![name],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .ok()
        .flatten()
        .map(|value| value != 0)
}

fn set_env_var_record(
    connection: &Connection,
    name: &str,
    created: Option<bool>,
) -> Result<(), McpError> {
    match created {
        Some(created) => connection
            .execute(
                "INSERT INTO mcp_env_vars (name, created_by_skillhub, updated_at) VALUES (?1, ?2, ?3)
                 ON CONFLICT(name) DO UPDATE SET created_by_skillhub = excluded.created_by_skillhub,
                     updated_at = excluded.updated_at",
                params![name, i64::from(created), ns_text(now_ns())],
            )
            .map(|_| ())
            .map_err(db_error),
        None => connection
            .execute(
                "DELETE FROM mcp_env_vars WHERE upper(name) = upper(?1)",
                params![name],
            )
            .map(|_| ())
            .map_err(db_error),
    }
}

// ---------------------------------------------------------------------------
// Display-safe summary (§1.3)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServerSummary {
    runner: Option<String>,
    subject: Option<String>,
    extra_arg_count: usize,
    host: Option<String>,
    env_names: Vec<String>,
    header_names: Vec<String>,
    secret_names: Vec<String>,
    secret_storage: BTreeMap<String, String>,
}

fn redact_subject(value: &str) -> String {
    // Paths are never shown in full: they may contain a user name.
    if value.contains('/') && !value.starts_with('@') || value.contains('\\') {
        value
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or(value)
            .to_string()
    } else {
        value.to_string()
    }
}

fn server_summary(spec: &McpServerSpec) -> ServerSummary {
    let mut summary = ServerSummary::default();
    match spec.transport {
        Transport::Stdio => {
            let command = spec.command.clone().unwrap_or_default();
            let args = spec
                .args
                .iter()
                .map(|arg| arg.value.clone())
                .collect::<Vec<_>>();
            let runner = engine::command_stem(&command);
            summary.runner = (!runner.is_empty()).then_some(runner);
            let subject = mcp_paste::subject_of(&command, &args)
                .filter(|subject| !mcp_mutation_secret(subject));
            let extra = args.len() - usize::from(subject.is_some());
            summary.subject = subject.map(|value| redact_subject(&value));
            summary.extra_arg_count = extra;
        }
        Transport::Http | Transport::Sse => {
            summary.host = spec.url.as_deref().and_then(mcp_paste::url_host);
        }
    }
    for item in &spec.env {
        summary.env_names.push(item.name.clone());
        if item.secret {
            summary.secret_names.push(item.name.clone());
            summary
                .secret_storage
                .insert(item.name.clone(), item.storage.contract_name().to_string());
        }
    }
    for header in &spec.headers {
        summary.header_names.push(header.name.clone());
        if header.template != HeaderTemplate::Literal {
            summary.secret_names.push(header.name.clone());
            summary.secret_storage.insert(
                header.name.clone(),
                header.storage.contract_name().to_string(),
            );
        }
    }
    summary
}

fn mcp_mutation_secret(value: &str) -> bool {
    engine::has_common_secret_prefix(value) || engine::is_sensitive_assignment(value)
}

/// The URL with any account part and any query or fragment replaced by
/// `SECRET_MASK`. Imported remote entries may carry a key there
/// (`…/mcp?api_key=…`, `https://user:pass@…`); like the scanner, SkillHub
/// treats both as inline secrets.
pub(crate) fn masked_url(url: &str) -> String {
    let Some((scheme, rest)) = url.split_once("://") else {
        return url.to_string();
    };
    let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let (authority, after) = rest.split_at(authority_end);
    let mut out = format!("{scheme}://");
    match authority.rsplit_once('@') {
        Some((_, host)) => {
            out.push_str(SECRET_MASK);
            out.push('@');
            out.push_str(host);
        }
        None => out.push_str(authority),
    }
    let path_end = after.find(['?', '#']).unwrap_or(after.len());
    out.push_str(&after[..path_end]);
    if path_end < after.len() {
        out.push('?');
        out.push_str(SECRET_MASK);
    }
    out
}

/// Whether a URL carries an account part, a query or a fragment.
fn url_has_secret(url: &str) -> bool {
    masked_url(url) != url
}

fn target_display(summary: &ServerSummary) -> String {
    match (&summary.runner, &summary.subject, &summary.host) {
        (_, _, Some(host)) => host.clone(),
        (Some(runner), Some(subject), _) => format!("{runner} · {subject}"),
        (Some(runner), None, _) => runner.clone(),
        _ => String::new(),
    }
}

// ---------------------------------------------------------------------------
// Canonical entry and hash (§1.4)
// ---------------------------------------------------------------------------

fn managed_keys(client: ClientId) -> &'static [&'static str] {
    match client {
        ClientId::Codex => &[
            "command",
            "args",
            "cwd",
            "env",
            "env_vars",
            "url",
            "http_headers",
            "env_http_headers",
            "bearer_token_env_var",
            "required",
        ],
        ClientId::ClaudeCode | ClientId::Cursor => {
            &["type", "command", "args", "env", "url", "headers"]
        }
        ClientId::ClaudeDesktop => &["type", "command", "args", "env"],
    }
}

/// Splits `cmd /c <runner> …` into the runner form; returns whether it did.
fn unwrap_entry_command(command: &str, args: &[String]) -> (String, Vec<String>, bool) {
    mcp_paste::unwrap_windows_cmd(command.to_string(), args.to_vec())
}

fn node_strings(node: Option<&Node>) -> Vec<String> {
    node.and_then(Node::as_array)
        .map(|items| {
            items
                .iter()
                .map(|item| match item {
                    Node::String(text) => text.clone(),
                    other => other.to_compact_string(),
                })
                .collect()
        })
        .unwrap_or_default()
}

fn entry_transport(client: ClientId, entry: &ObjectMap) -> &'static str {
    if client == ClientId::Codex {
        if entry.get("url").is_some() {
            "http"
        } else {
            "stdio"
        }
    } else {
        match engine::json_entry_transport(entry) {
            "http" => "http",
            "sse" => "sse",
            "stdio" => "stdio",
            _ => "unknown",
        }
    }
}

/// Canonical JSON of the managed keys of an entry. `unwrap` removes a
/// Windows `cmd /c` wrapper (semantic comparison); the stored hash keeps it so
/// a missing wrapper can be detected (`windowsFixAvailable`).
fn canonical_entry(client: ClientId, entry: &Node, unwrap: bool) -> String {
    let Some(object) = entry.as_object() else {
        return "null".to_string();
    };
    let mut canonical = serde_json::Map::new();
    for key in managed_keys(client) {
        if *key == "type" {
            continue;
        }
        let Some(value) = object.get(key) else {
            continue;
        };
        let json = value.to_value();
        let empty = match &json {
            JsonValue::Array(items) => items.is_empty(),
            JsonValue::Object(map) => map.is_empty(),
            JsonValue::Null => true,
            JsonValue::Bool(flag) => *key == "required" && !flag,
            _ => false,
        };
        if !empty {
            canonical.insert((*key).to_string(), json);
        }
    }
    canonical.insert(
        "type".to_string(),
        JsonValue::String(entry_transport(client, object).to_string()),
    );
    if unwrap {
        if let Some(JsonValue::String(command)) = canonical.get("command").cloned() {
            let args = node_strings(object.get("args"));
            let (command, args, unwrapped) = unwrap_entry_command(&command, &args);
            if unwrapped {
                canonical.insert("command".to_string(), JsonValue::String(command));
                if args.is_empty() {
                    canonical.remove("args");
                } else {
                    canonical.insert(
                        "args".to_string(),
                        JsonValue::Array(args.into_iter().map(JsonValue::String).collect()),
                    );
                }
            }
        }
    }
    JsonValue::Object(canonical).to_string()
}

fn entry_hash(key: &[u8; 32], client: ClientId, entry: &Node) -> String {
    let canonical = canonical_entry(client, entry, false);
    hmac_hex(
        key,
        &[b"entry", client.as_str().as_bytes(), canonical.as_bytes()],
    )
}

fn semantic_equal(client: ClientId, left: &Node, right: &Node) -> bool {
    canonical_entry(client, left, true) == canonical_entry(client, right, true)
}

fn entry_is_wrapped(entry: &Node) -> bool {
    entry
        .get("command")
        .and_then(Node::as_str)
        .is_some_and(|command| engine::command_stem(command) == "cmd")
}

/// Codex `enabled = false` on an entry.
fn codex_disabled(entry: &Node) -> bool {
    entry.get("enabled").and_then(Node::as_bool) == Some(false)
}

// ---------------------------------------------------------------------------
// Projection (§2.4)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProjectError {
    Unsupported(&'static str),
    Blocked(&'static str),
}

/// A name that this client accepts (§2.2).
fn name_supported(client: ClientId, name: &str) -> bool {
    if client == ClientId::Codex {
        return !name.is_empty()
            && name.len() <= 64
            && name.bytes().enumerate().all(|(index, byte)| {
                byte.is_ascii_alphanumeric() || (index > 0 && matches!(byte, b'.' | b'_' | b'-'))
            });
    }
    let valid = !name.is_empty()
        && name.len() <= 64
        && name.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_alphanumeric() || (index > 0 && matches!(byte, b'_' | b'-'))
        });
    let reserved = client == ClientId::ClaudeCode
        && engine::CLAUDE_RESERVED_NAMES
            .iter()
            .any(|reserved| name.eq_ignore_ascii_case(reserved));
    valid && !reserved
}

fn json_reference(client: ClientId, variable: &str) -> String {
    if client == ClientId::Cursor {
        format!("${{env:{variable}}}")
    } else {
        format!("${{{variable}}}")
    }
}

fn wrap_command(
    ctx: &McpLibraryContext,
    client: ClientId,
    command: &str,
    args: Vec<String>,
) -> (String, Vec<String>) {
    let absolute_exe =
        Path::new(command).is_absolute() && command.to_ascii_lowercase().ends_with(".exe");
    if ctx.windows
        && matches!(client, ClientId::ClaudeCode | ClientId::ClaudeDesktop)
        && engine::is_wrap_family(command)
        && !absolute_exe
    {
        let mut wrapped = vec!["/c".to_string(), command.to_string()];
        wrapped.extend(args.iter().cloned());
        // `cmd` interprets & | < > ^ % " ( ) !: such arguments stay unwrapped
        // rather than being handed to the shell (§2.5).
        if engine::validate_command_with_args("cmd", &wrapped).is_ok() {
            return ("cmd".to_string(), wrapped);
        }
    }
    (command.to_string(), args)
}

fn string_map(pairs: &[(String, String)]) -> Node {
    let mut map = ObjectMap::new();
    for (key, value) in pairs {
        map.insert(key.clone(), Node::string(value.clone()));
    }
    Node::Object(map)
}

/// Builds the managed keys of `spec` for `client` (§2.4). The webview can
/// never send a projection: it is computed here from the stored spec.
fn project(
    ctx: &McpLibraryContext,
    name: &str,
    spec: &McpServerSpec,
    client: ClientId,
) -> Result<ProjectedEntry, ProjectError> {
    if !name_supported(client, name) {
        return Err(ProjectError::Unsupported("name-incompatible"));
    }
    if !client.transports().contains(&spec.transport) {
        return Err(ProjectError::Unsupported("transport-unsupported"));
    }
    let env_store = &*ctx.env;
    let literal_secret = |storage: SecretStorage,
                          value: &Option<String>,
                          variable: &str,
                          inline: &[ClientId]|
     -> Result<String, ProjectError> {
        if !inline.contains(&client) {
            return Err(ProjectError::Blocked("needs-inline-consent"));
        }
        let resolved = match storage {
            SecretStorage::Library | SecretStorage::Literal => value.clone(),
            SecretStorage::UserEnv | SecretStorage::External => {
                mcp_secrets::resolve_env_value(env_store, variable)
            }
        };
        resolved.ok_or(ProjectError::Blocked("missing-secret"))
    };

    let mut set: Vec<(String, Node)> = Vec::new();
    let mut set_if_present: Vec<(String, Node)> = Vec::new();
    match spec.transport {
        Transport::Stdio => {
            let mut args = Vec::with_capacity(spec.args.len());
            for arg in &spec.args {
                if arg.secret && !spec.secret_arg_clients.contains(&client) {
                    return Err(ProjectError::Blocked("needs-inline-consent"));
                }
                args.push(arg.value.clone());
            }
            let command = spec.command.clone().unwrap_or_default();
            let (command, args) = wrap_command(ctx, client, &command, args);
            let mut literal_env: Vec<(String, String)> = Vec::new();
            let mut referenced: Vec<String> = Vec::new();
            for item in &spec.env {
                if !item.secret || item.storage == SecretStorage::Literal {
                    literal_env.push((item.name.clone(), item.value.clone().unwrap_or_default()));
                    continue;
                }
                let reference_ok = matches!(
                    item.storage,
                    SecretStorage::UserEnv | SecretStorage::External
                ) && client.supports_references()
                    && (client != ClientId::Codex || item.variable() == item.name);
                if reference_ok {
                    if client == ClientId::Codex {
                        referenced.push(item.name.clone());
                    } else {
                        literal_env
                            .push((item.name.clone(), json_reference(client, item.variable())));
                    }
                } else {
                    let value = literal_secret(
                        item.storage,
                        &item.value,
                        item.variable(),
                        &item.inline_clients,
                    )?;
                    literal_env.push((item.name.clone(), value));
                }
            }
            if client.is_json() {
                if client == ClientId::ClaudeCode {
                    set.push(("type".to_string(), Node::string("stdio")));
                } else {
                    set_if_present.push(("type".to_string(), Node::string("stdio")));
                }
            }
            set.push(("command".to_string(), Node::string(command)));
            if args.is_empty() {
                set_if_present.push(("args".to_string(), Node::Array(Vec::new())));
            } else {
                set.push(("args".to_string(), Node::string_array(args)));
            }
            if literal_env.is_empty() {
                set_if_present.push(("env".to_string(), Node::object()));
            } else {
                set.push(("env".to_string(), string_map(&literal_env)));
            }
            if client == ClientId::Codex {
                if let Some(cwd) = &spec.cwd {
                    set.push(("cwd".to_string(), Node::string(cwd.clone())));
                }
                if !referenced.is_empty() {
                    set.push(("env_vars".to_string(), Node::string_array(referenced)));
                }
            }
        }
        Transport::Http | Transport::Sse => {
            let url = spec.url.clone().unwrap_or_default();
            // An imported URL with a key in its query or account part is an
            // inline secret: other clients get it only with consent (I6).
            if url_has_secret(&url) && !spec.secret_arg_clients.contains(&client) {
                return Err(ProjectError::Blocked("needs-inline-consent"));
            }
            let mut literal_headers: Vec<(String, String)> = Vec::new();
            let mut header_refs: Vec<(String, String)> = Vec::new();
            let mut bearer_env: Option<String> = None;
            for header in &spec.headers {
                if header.template == HeaderTemplate::Literal {
                    literal_headers.push((
                        header.name.clone(),
                        header.value.clone().unwrap_or_default(),
                    ));
                    continue;
                }
                let variable = header.env_var.clone().unwrap_or_default();
                let by_reference = matches!(
                    header.storage,
                    SecretStorage::UserEnv | SecretStorage::External
                ) && !variable.is_empty();
                let bearer = header.template == HeaderTemplate::Bearer;
                if by_reference && client == ClientId::Codex {
                    if !bearer {
                        header_refs.push((header.name.clone(), variable));
                        continue;
                    }
                    if header.name.eq_ignore_ascii_case("authorization") && bearer_env.is_none() {
                        bearer_env = Some(variable);
                        continue;
                    }
                } else if by_reference && client.supports_references() {
                    let reference = json_reference(client, &variable);
                    let value = if bearer {
                        format!("Bearer {reference}")
                    } else {
                        reference
                    };
                    literal_headers.push((header.name.clone(), value));
                    continue;
                }
                let value = literal_secret(
                    header.storage,
                    &header.value,
                    &variable,
                    &header.inline_clients,
                )?;
                let value = if bearer {
                    format!("Bearer {value}")
                } else {
                    value
                };
                literal_headers.push((header.name.clone(), value));
            }
            if client == ClientId::Codex {
                set.push(("url".to_string(), Node::string(url)));
                if !literal_headers.is_empty() {
                    set.push(("http_headers".to_string(), string_map(&literal_headers)));
                }
                if !header_refs.is_empty() {
                    set.push(("env_http_headers".to_string(), string_map(&header_refs)));
                }
                if let Some(variable) = bearer_env {
                    set.push(("bearer_token_env_var".to_string(), Node::string(variable)));
                }
            } else {
                let kind = spec.transport.as_str();
                if client == ClientId::ClaudeCode {
                    set.push(("type".to_string(), Node::string(kind)));
                } else {
                    set_if_present.push(("type".to_string(), Node::string(kind)));
                }
                set.push(("url".to_string(), Node::string(url)));
                if literal_headers.is_empty() {
                    set_if_present.push(("headers".to_string(), Node::object()));
                } else {
                    set.push(("headers".to_string(), string_map(&literal_headers)));
                }
            }
        }
    }
    if client == ClientId::Codex && spec.codex_required {
        set.push(("required".to_string(), Node::Bool(true)));
    }
    let kept = set
        .iter()
        .chain(set_if_present.iter())
        .map(|(key, _)| key.as_str())
        .collect::<HashSet<_>>();
    let mut remove = managed_keys(client)
        .iter()
        .filter(|key| !kept.contains(**key))
        .map(|key| (*key).to_string())
        .collect::<Vec<_>>();
    if client == ClientId::Codex && spec.transport == Transport::Stdio {
        remove.push("bearer_token".to_string());
        remove.push("oauth".to_string());
    }
    let base = spec
        .client_extra
        .get(client.as_str())
        .and_then(|text| Node::from_json_text(text))
        .filter(|node| node.as_object().is_some());
    Ok(ProjectedEntry {
        set,
        set_if_present,
        remove,
        codex_enabled: None,
        base,
    })
}

/// The entry a projection produces on top of `existing` (or its base), for
/// hashing and previews. Never written by itself.
fn projected_node(client: ClientId, projected: &ProjectedEntry, existing: Option<&Node>) -> Node {
    let mut entry = existing
        .cloned()
        .or_else(|| projected.base.clone())
        .filter(|node| node.as_object().is_some())
        .unwrap_or_else(Node::object);
    let object = entry.as_object_mut().expect("object entry");
    for key in &projected.remove {
        object.remove(key);
    }
    for (key, value) in &projected.set {
        object.insert(key.clone(), value.clone());
    }
    for (key, value) in &projected.set_if_present {
        if object.contains_key(key) {
            object.insert(key.clone(), value.clone());
        }
    }
    if client == ClientId::Codex {
        match projected.codex_enabled {
            Some(false) => object.insert("enabled", Node::Bool(false)),
            Some(true) if object.contains_key("enabled") => {
                object.insert("enabled", Node::Bool(true))
            }
            _ => {}
        }
    }
    entry
}

/// The unknown (non-managed) keys of an entry, in order, as JSON text.
fn unknown_keys_text(client: ClientId, entry: &Node) -> Option<String> {
    let object = entry.as_object()?;
    let managed = managed_keys(client);
    let mut unknown = ObjectMap::new();
    for (key, value) in object.iter() {
        if managed.contains(&key.as_str()) || (client == ClientId::Codex && key == "enabled") {
            continue;
        }
        unknown.insert(key.clone(), value.clone());
    }
    (!unknown.is_empty()).then(|| Node::Object(unknown).to_compact_string())
}

// ---------------------------------------------------------------------------
// Spec from a client entry (import, "采用文件中的版本")
// ---------------------------------------------------------------------------

fn looks_like_secret_arg(args: &[String], index: usize) -> bool {
    let value = &args[index];
    if engine::has_common_secret_prefix(value) || engine::is_sensitive_assignment(value) {
        return true;
    }
    index > 0
        && engine::is_sensitive_argument_key(&args[index - 1])
        && !args[index - 1].contains('=')
        && !matches!(args[index - 1].as_str(), "--env" | "-e")
}

fn spec_from_entry(client: ClientId, entry: &Node) -> Result<McpServerSpec, &'static str> {
    let object = entry.as_object().ok_or("unknown-type")?;
    let transport = match entry_transport(client, object) {
        "stdio" => Transport::Stdio,
        "http" => Transport::Http,
        "sse" => Transport::Sse,
        _ => return Err("unknown-type"),
    };
    let mut spec = McpServerSpec::empty(transport);
    let text = |key: &str| object.get(key).and_then(Node::as_str).map(str::to_string);
    if transport == Transport::Stdio {
        let command = text("command")
            .filter(|value| !value.is_empty())
            .ok_or("unknown-type")?;
        let args = node_strings(object.get("args"));
        let (command, args, _) = unwrap_entry_command(&command, &args);
        if args.len() > mcp_paste::MAX_ARGS {
            return Err("too-many-args");
        }
        let mut has_secret_arg = false;
        for index in 0..args.len() {
            let secret = looks_like_secret_arg(&args, index);
            has_secret_arg |= secret;
            spec.args.push(SpecArg {
                value: args[index].clone(),
                secret,
            });
        }
        if has_secret_arg {
            spec.secret_arg_clients.push(client);
        }
        spec.command = Some(command);
        spec.cwd = text("cwd");
        if let Some(env) = object.get("env").and_then(Node::as_object) {
            for (name, value) in env.iter() {
                let value = match value {
                    Node::String(text) => text.clone(),
                    other => other.to_compact_string(),
                };
                spec.env.push(env_from_value(client, name, &value));
            }
        }
        if client == ClientId::Codex {
            if let Some(Node::Array(items)) = object.get("env_vars") {
                for item in items {
                    let name = item.as_str().ok_or("codex-structured-env")?;
                    if spec.env.iter().any(|existing| existing.name == name) {
                        continue;
                    }
                    spec.env.push(SpecEnv {
                        name: name.to_string(),
                        secret: true,
                        storage: SecretStorage::External,
                        env_var: None,
                        value: None,
                        inline_clients: Vec::new(),
                        required: false,
                    });
                }
            }
        }
    } else {
        spec.url = text("url").or_else(|| text("serverUrl"));
        if spec.url.is_none() {
            return Err("invalid-url");
        }
        if spec.url.as_deref().is_some_and(url_has_secret) {
            // Only the client it came from may keep receiving it as is.
            spec.secret_arg_clients.push(client);
        }
        let header_key = if client == ClientId::Codex {
            "http_headers"
        } else {
            "headers"
        };
        if let Some(headers) = object.get(header_key).and_then(Node::as_object) {
            for (name, value) in headers.iter() {
                let value = value.as_str().unwrap_or_default();
                spec.headers.push(header_from_value(client, name, value));
            }
        }
        if client == ClientId::Codex {
            if let Some(refs) = object.get("env_http_headers").and_then(Node::as_object) {
                for (name, value) in refs.iter() {
                    spec.headers.push(SpecHeader {
                        name: name.clone(),
                        template: HeaderTemplate::Raw,
                        env_var: value.as_str().map(str::to_string),
                        storage: SecretStorage::External,
                        value: None,
                        inline_clients: Vec::new(),
                        required: false,
                    });
                }
            }
            if let Some(variable) = text("bearer_token_env_var") {
                spec.headers.push(SpecHeader {
                    name: "Authorization".to_string(),
                    template: HeaderTemplate::Bearer,
                    env_var: Some(variable),
                    storage: SecretStorage::External,
                    value: None,
                    inline_clients: Vec::new(),
                    required: false,
                });
            }
        }
    }
    if client == ClientId::Codex {
        spec.codex_required = object.get("required").and_then(Node::as_bool) == Some(true);
    }
    if let Some(extra) = unknown_keys_text(client, entry) {
        spec.client_extra.insert(client.as_str().to_string(), extra);
    }
    Ok(spec)
}

fn env_from_value(client: ClientId, name: &str, value: &str) -> SpecEnv {
    if let Some(variable) = crate::mcp_center::env_reference_name(value) {
        return SpecEnv {
            name: name.to_string(),
            secret: true,
            storage: SecretStorage::External,
            env_var: (variable != name).then(|| variable.to_string()),
            value: None,
            inline_clients: Vec::new(),
            required: false,
        };
    }
    let secret = mcp_paste::name_looks_secret(name) || engine::has_common_secret_prefix(value);
    SpecEnv {
        name: name.to_string(),
        secret,
        storage: if secret {
            SecretStorage::Library
        } else {
            SecretStorage::Literal
        },
        env_var: None,
        value: Some(value.to_string()),
        inline_clients: if secret { vec![client] } else { Vec::new() },
        required: false,
    }
}

fn header_from_value(client: ClientId, name: &str, value: &str) -> SpecHeader {
    let trimmed = value.trim();
    let (bearer, rest) = match trimmed.strip_prefix("Bearer ") {
        Some(rest) => (true, rest.trim()),
        None => (false, trimmed),
    };
    let template = if bearer {
        HeaderTemplate::Bearer
    } else {
        HeaderTemplate::Raw
    };
    if let Some(variable) = crate::mcp_center::env_reference_name(rest) {
        return SpecHeader {
            name: name.to_string(),
            template,
            env_var: Some(variable.to_string()),
            storage: SecretStorage::External,
            value: None,
            inline_clients: Vec::new(),
            required: false,
        };
    }
    SpecHeader {
        name: name.to_string(),
        template,
        env_var: None,
        storage: SecretStorage::Library,
        value: Some(rest.to_string()),
        inline_clients: vec![client],
        required: false,
    }
}

// ---------------------------------------------------------------------------
// API types (§3.2) — mirrored field for field
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct McpClient {
    id: ClientId,
    label: String,
    adapter_id: String,
    detected: bool,
    writable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    readonly_reason: Option<String>,
    config_path_display: String,
    transports: Vec<Transport>,
    secret_reference: String,
    disable_mode: String,
    enabled_count: usize,
    restart_needed: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct McpCell {
    client_id: ClientId,
    state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error_message: Option<String>,
    present_in_file: bool,
    disabled_in_file: bool,
    out_of_date: bool,
    windows_fix_available: bool,
    project_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct McpProjectBinding {
    client_id: ClientId,
    scope: Scope,
    project_label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    workspace_id: Option<String>,
    state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    readonly_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct McpTargetSummary {
    runner: Option<String>,
    subject: Option<String>,
    extra_arg_count: usize,
    host: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct McpSecretStatus {
    kind: String,
    name: String,
    env_var: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    header_template: Option<String>,
    storage: String,
    present: bool,
    inline_clients: Vec<ClientId>,
    #[serde(rename = "createdBySkillHub")]
    created_by_skillhub: bool,
    required: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct McpTestSummary {
    status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    tools_count: Option<u32>,
    tested_at: String,
    stale: bool,
    message_code: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct McpServerRow {
    id: String,
    name: String,
    display_name: String,
    transport: Transport,
    target: McpTargetSummary,
    cells: Vec<McpCell>,
    project_bindings: Vec<McpProjectBinding>,
    secrets: Vec<McpSecretStatus>,
    missing_secret_count: usize,
    test: Option<McpTestSummary>,
    source: McpServerSource,
    spec_revision: i64,
    issue_count: usize,
    updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct McpIssue {
    id: String,
    kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    client_id: Option<ClientId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    server_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    server_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    path_display: Option<String>,
    action: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OtherClient {
    adapter_id: String,
    label: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UnimportedEntry {
    client_id: ClientId,
    name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StuckTransactionView {
    snapshot_id: String,
    client_id: Option<ClientId>,
    path_display: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct McpLibrarySnapshot {
    generation: u64,
    generated_at: String,
    library_initialized: bool,
    clients: Vec<McpClient>,
    other_clients: Vec<OtherClient>,
    servers: Vec<McpServerRow>,
    issues: Vec<McpIssue>,
    unimported: Vec<UnimportedEntry>,
    stuck_transactions: Vec<StuckTransactionView>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct McpArgView {
    value: String,
    masked: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct McpNameValue {
    name: String,
    value: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct McpServerDetail {
    id: String,
    name: String,
    display_name: String,
    transport: Transport,
    #[serde(skip_serializing_if = "Option::is_none")]
    command: Option<String>,
    args: Vec<McpArgView>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    url: Option<String>,
    env: Vec<McpNameValue>,
    secrets: Vec<McpSecretStatus>,
    codex_required: bool,
    source: McpServerSource,
    meta: JsonValue,
    spec_revision: i64,
    cells: Vec<McpCell>,
    project_bindings: Vec<McpProjectBinding>,
    test: Option<McpTestSummary>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct McpClientResult {
    client_id: ClientId,
    scope: Scope,
    #[serde(skip_serializing_if = "Option::is_none")]
    project_label: Option<String>,
    server_ids: Vec<String>,
    status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    skipped_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<McpError>,
    restart_hint: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct McpOperationSummary {
    kind: String,
    server_names: Vec<String>,
    client_ids: Vec<ClientId>,
    failed_client_ids: Vec<ClientId>,
    env_var_names: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct McpEntryPreview {
    transport: Transport,
    target_display: String,
    env_names: Vec<String>,
    header_names: Vec<String>,
    arg_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct McpConfirmationItem {
    client_id: ClientId,
    client_label: String,
    scope: Scope,
    #[serde(skip_serializing_if = "Option::is_none")]
    project_label: Option<String>,
    server_name: String,
    action: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    before: Option<McpEntryPreview>,
    #[serde(skip_serializing_if = "Option::is_none")]
    after: Option<McpEntryPreview>,
    changed_fields: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct McpEnvVarConfirmation {
    name: String,
    exists: bool,
    #[serde(rename = "createdBySkillHub")]
    created_by_skillhub: bool,
    action: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct McpConfirmation {
    kinds: Vec<String>,
    confirm_token: String,
    items: Vec<McpConfirmationItem>,
    #[serde(skip_serializing_if = "Option::is_none")]
    env_vars: Option<Vec<McpEnvVarConfirmation>>,
    undoable: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub(crate) enum McpWriteOutcome {
    Done {
        operation_id: String,
        undo_token: Option<String>,
        summary: McpOperationSummary,
        results: Vec<McpClientResult>,
        generation: u64,
    },
    NeedsConfirmation {
        confirmation: McpConfirmation,
    },
    Noop {
        reason: String,
    },
}

impl McpWriteOutcome {
    pub(crate) fn operation_id(&self) -> Option<&str> {
        match self {
            McpWriteOutcome::Done { operation_id, .. } => Some(operation_id),
            _ => None,
        }
    }

    fn noop(reason: &str) -> Self {
        McpWriteOutcome::Noop {
            reason: reason.to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct McpImportReport {
    operation_id: Option<String>,
    added: Vec<String>,
    merged: Vec<NameClients>,
    differing: Vec<NameClients>,
    skipped: Vec<ImportSkip>,
    files_read: Vec<FileRead>,
    wrote_client_files: bool,
}

impl McpImportReport {
    pub(crate) fn operation_id(&self) -> Option<&str> {
        self.operation_id.as_deref()
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NameClients {
    name: String,
    client_ids: Vec<ClientId>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImportSkip {
    name: String,
    client_id: ClientId,
    reason: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileRead {
    client_id: ClientId,
    scope: Scope,
    path_display: String,
    status: String,
    servers: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct McpHistoryEntry {
    operation_id: String,
    at: String,
    kind: String,
    server_names: Vec<String>,
    client_ids: Vec<ClientId>,
    failed_client_ids: Vec<ClientId>,
    env_var_names: Vec<String>,
    partial: bool,
    undo_available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    undo_unavailable_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    legacy_snapshot_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct McpExportResult {
    text: String,
    masked_secret_count: usize,
}

// ---------------------------------------------------------------------------
// Requests (deny unknown fields; values are write-only and never `Debug`)
// ---------------------------------------------------------------------------

#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub(crate) struct McpEmptyRequest {}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct McpGetServerRequest {
    pub server_id: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct McpImportRequest {
    pub reason: String,
    #[serde(default)]
    pub client_ids: Option<Vec<ClientId>>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct McpSetCellRequest {
    pub server_id: String,
    pub client_id: ClientId,
    pub enabled: bool,
    #[serde(default)]
    pub allow_inline: Option<bool>,
    #[serde(default)]
    pub confirm_token: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct McpSetColumnRequest {
    pub client_id: ClientId,
    pub enabled: bool,
    #[serde(default)]
    pub server_ids: Option<Vec<String>>,
    #[serde(default)]
    pub confirm_token: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct McpSetRowRequest {
    pub server_id: String,
    pub enabled: bool,
    #[serde(default)]
    pub client_ids: Option<Vec<ClientId>>,
    #[serde(default)]
    pub confirm_token: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct McpParsePasteRequest {
    pub text: String,
}

impl fmt::Debug for McpParsePasteRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "McpParsePasteRequest({} bytes)", self.text.len())
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct McpGithubRequest {
    pub source: String,
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct McpSecretInput {
    pub kind: String,
    pub name: String,
    #[serde(default)]
    pub env_var: Option<String>,
    #[serde(default)]
    pub header_template: Option<String>,
    /// Write-only. Omitted keeps the stored value.
    #[serde(default)]
    pub value: Option<String>,
    #[serde(default)]
    pub paste_value_handle: Option<String>,
    #[serde(default = "default_secret_mode")]
    pub mode: String,
    #[serde(default)]
    pub inline_clients: Option<Vec<ClientId>>,
    #[serde(default)]
    pub required: Option<bool>,
}

fn default_secret_mode() -> String {
    "user_env".to_string()
}

impl fmt::Debug for McpSecretInput {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("McpSecretInput")
            .field("kind", &self.kind)
            .field("name", &self.name)
            .field("value", &self.value.as_ref().map(|_| "••••"))
            .finish()
    }
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct McpNameValueInput {
    pub name: String,
    pub value: String,
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct McpServerInput {
    pub name: String,
    #[serde(default)]
    pub display_name: Option<String>,
    pub transport: Transport,
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub args: Option<Vec<String>>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub env: Option<Vec<McpNameValueInput>>,
    #[serde(default)]
    pub secrets: Option<Vec<McpSecretInput>>,
    #[serde(default)]
    pub codex_required: Option<bool>,
    pub source: McpServerSource,
}

impl fmt::Debug for McpServerInput {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "McpServerInput({})", self.name)
    }
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct McpAddCandidate {
    pub input: McpServerInput,
    #[serde(default)]
    pub on_conflict: Option<String>,
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct McpPlacement {
    pub scope: Scope,
    #[serde(default)]
    pub workspace_id: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct McpAddRequest {
    pub candidates: Vec<McpAddCandidate>,
    pub client_ids: Vec<ClientId>,
    #[serde(default)]
    pub placement: Option<McpPlacement>,
    #[serde(default)]
    pub paste_handle: Option<String>,
    #[serde(default)]
    pub confirm_token: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct McpUpdateRequest {
    pub server_id: String,
    pub input: McpServerInput,
    pub expected_revision: i64,
    #[serde(default)]
    pub confirm_token: Option<String>,
}

#[derive(Deserialize, Serialize, Clone)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum McpRemoveFrom {
    Library,
    Client {
        client_id: ClientId,
        #[serde(default)]
        scope: Option<Scope>,
        #[serde(default)]
        workspace_id: Option<String>,
    },
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct McpRemoveRequest {
    pub server_id: String,
    pub from: McpRemoveFrom,
    #[serde(default)]
    pub delete_env_vars: Option<Vec<String>>,
    #[serde(default)]
    pub confirm_token: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct McpUndoRequest {
    pub undo_token: String,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct McpHistoryRequest {
    #[serde(default)]
    pub limit: Option<usize>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct McpRollbackRequest {
    #[serde(default)]
    pub operation_id: Option<String>,
    #[serde(default)]
    pub legacy_snapshot_id: Option<String>,
    #[serde(default)]
    pub confirm_token: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct McpSetSecretRequest {
    pub server_id: String,
    pub name: String,
    /// Write-only, never echoed.
    pub value: String,
    pub mode: String,
    #[serde(default)]
    pub inline_clients: Option<Vec<ClientId>>,
    #[serde(default)]
    pub confirm_token: Option<String>,
}

impl fmt::Debug for McpSetSecretRequest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("McpSetSecretRequest")
            .field("server_id", &self.server_id)
            .field("name", &self.name)
            .field("value", &"••••")
            .field("mode", &self.mode)
            .finish()
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct McpTestPreviewRequest {
    pub server_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct McpTestRequest {
    pub server_id: String,
    pub preview_token: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct McpExportRequest {
    #[serde(default)]
    pub server_ids: Option<Vec<String>>,
    pub format: String,
}

#[derive(Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct McpResyncRequest {
    #[serde(default)]
    pub client_ids: Option<Vec<ClientId>>,
    #[serde(default)]
    pub server_ids: Option<Vec<String>>,
    #[serde(default)]
    pub confirm_token: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct McpResolveChangeRequest {
    pub server_id: String,
    pub client_id: ClientId,
    pub take: String,
    #[serde(default)]
    pub confirm_token: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct McpResolveStuckRequest {
    pub snapshot_id: String,
    pub action: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct McpOpenLocationRequest {
    pub client_id: ClientId,
    #[serde(default)]
    pub scope: Option<Scope>,
    #[serde(default)]
    pub workspace_id: Option<String>,
}

// ---------------------------------------------------------------------------
// Client registry and read-only file views (§2.1, §2.3)
// ---------------------------------------------------------------------------

struct ClientState {
    client: ClientId,
    detected: bool,
    writable: bool,
    readonly_reason: Option<&'static str>,
    path_display: String,
    read: TargetRead,
}

impl ClientState {
    fn entry(&self, name: &str) -> Option<&Node> {
        self.read.entry(name)
    }
}

fn empty_read() -> TargetRead {
    TargetRead::missing()
}

fn read_status_reason(status: TargetReadStatus) -> Option<&'static str> {
    match status {
        TargetReadStatus::Ok | TargetReadStatus::Missing => None,
        TargetReadStatus::Jsonc => Some("config-jsonc"),
        TargetReadStatus::ParseFailed => Some("config-parse-failed"),
        TargetReadStatus::TooLarge => Some("config-too-large"),
        TargetReadStatus::Unreadable => Some("config-unreadable"),
        TargetReadStatus::Ambiguous => Some("config-ambiguous-project"),
    }
}

fn read_status_text(status: TargetReadStatus) -> &'static str {
    match status {
        TargetReadStatus::Ok => "ok",
        TargetReadStatus::Missing => "missing",
        TargetReadStatus::Jsonc => "jsonc-readonly",
        TargetReadStatus::ParseFailed | TargetReadStatus::Ambiguous => "parse-failed",
        TargetReadStatus::TooLarge => "too-large",
        TargetReadStatus::Unreadable => "unreadable",
    }
}

fn is_directory(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|meta| meta.is_dir())
}

fn adapter_detected(connection: Option<&Connection>, adapter_id: &str) -> bool {
    connection
        .and_then(|connection| {
            connection
                .query_row(
                    "SELECT detected FROM agent_adapters WHERE id = ?1",
                    params![adapter_id],
                    |row| row.get::<_, i64>(0),
                )
                .optional()
                .ok()
                .flatten()
        })
        .is_some_and(|value| value != 0)
}

/// Detection reads the file system and SQLite only (never `where.exe`).
fn client_detected(
    ctx: &McpLibraryContext,
    connection: Option<&Connection>,
    client: ClientId,
) -> bool {
    let home = ctx.home();
    match client {
        ClientId::Codex => {
            is_directory(&home.join(".codex")) || adapter_detected(connection, "codex")
        }
        ClientId::ClaudeCode => {
            let (path, _) = ctx.mutation.claude_user_config();
            path.is_file()
                || is_directory(
                    &ctx.mutation
                        .claude_config_dir
                        .clone()
                        .unwrap_or_else(|| home.join(".claude")),
                )
        }
        ClientId::ClaudeDesktop => is_directory(&ctx.mutation.claude_desktop_dir()),
        ClientId::Cursor => is_directory(&home.join(".cursor")),
    }
}

fn default_path_display(ctx: &McpLibraryContext, client: ClientId) -> String {
    match client {
        ClientId::Codex => "~/.codex/config.toml".to_string(),
        ClientId::ClaudeCode => ctx.mutation.claude_user_config().1,
        ClientId::ClaudeDesktop => engine::redact_home_path(
            &ctx.mutation
                .claude_desktop_dir()
                .join("claude_desktop_config.json"),
            ctx.home(),
        ),
        ClientId::Cursor => "~/.cursor/mcp.json".to_string(),
    }
}

fn client_state(
    ctx: &McpLibraryContext,
    connection: Option<&Connection>,
    client: ClientId,
) -> ClientState {
    let detected = client_detected(ctx, connection, client);
    match engine::resolve_target(&ctx.mutation, client.host_id(), "user", None) {
        Ok(target) => {
            let read = engine::read_target_entries(&target);
            let reason = read_status_reason(read.status);
            ClientState {
                client,
                detected,
                writable: reason.is_none(),
                readonly_reason: reason,
                path_display: target.path_display().to_string(),
                read,
            }
        }
        Err(_) => ClientState {
            client,
            detected,
            writable: false,
            readonly_reason: Some(if detected {
                "config-unreadable"
            } else {
                "client-not-installed"
            }),
            path_display: default_path_display(ctx, client),
            read: empty_read(),
        },
    }
}

fn client_states(ctx: &McpLibraryContext, connection: Option<&Connection>) -> Vec<ClientState> {
    ClientId::ALL
        .into_iter()
        .map(|client| client_state(ctx, connection, client))
        .collect()
}

/// A project-level config (Codex project file, Claude local/project scope).
struct ProjectSource {
    client: ClientId,
    scope: Scope,
    workspace_id: Option<String>,
    label: String,
    writable: bool,
    readonly_reason: Option<&'static str>,
    path_display: String,
    read: TargetRead,
}

fn folder_label(path: &str) -> String {
    let leaf = path
        .trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("project");
    let label = engine::safe_label(leaf);
    if label.is_empty() {
        "project".to_string()
    } else {
        label
    }
}

fn project_sources(ctx: &McpLibraryContext) -> Vec<ProjectSource> {
    let mut sources = Vec::new();
    for workspace in &ctx.mutation.registered_workspaces {
        let label = engine::safe_label(&workspace.display_name);
        let label = if label.is_empty() {
            folder_label(&workspace.path.to_string_lossy())
        } else {
            label
        };
        for (client, scope) in [
            (ClientId::Codex, Scope::Project),
            (ClientId::ClaudeCode, Scope::Local),
            (ClientId::ClaudeCode, Scope::Project),
        ] {
            let Ok(target) = engine::resolve_target(
                &ctx.mutation,
                client.host_id(),
                scope.as_str(),
                Some(&workspace.id),
            ) else {
                continue;
            };
            let read = engine::read_target_entries(&target);
            if read.status == TargetReadStatus::Missing {
                continue;
            }
            let team_file = client == ClientId::ClaudeCode && scope == Scope::Project;
            let status_reason = read_status_reason(read.status);
            sources.push(ProjectSource {
                client,
                scope,
                workspace_id: Some(workspace.id.clone()),
                label: label.clone(),
                writable: status_reason.is_none() && !team_file,
                readonly_reason: status_reason.or(team_file.then_some("team-shared-file")),
                path_display: target.path_display().to_string(),
                read,
            });
        }
    }
    // Claude-known projects that are not registered: read-only (§2.3).
    let (claude_path, claude_display) = ctx.mutation.claude_user_config();
    if let Some(root) = engine::read_config_node(&claude_path) {
        if let Some(projects) = root.get("projects").and_then(Node::as_object) {
            for (key, project) in projects.iter().take(MAX_CLAUDE_PROJECTS) {
                let registered = ctx
                    .mutation
                    .registered_workspaces
                    .iter()
                    .any(|workspace| crate::mcp_center::paths_equivalent(key, &workspace.path));
                if registered {
                    continue;
                }
                let Some(servers) = project.get("mcpServers").and_then(Node::as_object) else {
                    continue;
                };
                let mut read = TargetRead::missing();
                for (name, entry) in servers.iter() {
                    if entry.as_object().is_some() {
                        read.entries.push((name.clone(), entry.clone()));
                    }
                }
                if read.entries.is_empty() {
                    continue;
                }
                sources.push(ProjectSource {
                    client: ClientId::ClaudeCode,
                    scope: Scope::Local,
                    workspace_id: None,
                    label: folder_label(key),
                    writable: false,
                    readonly_reason: Some("not-registered"),
                    path_display: claude_display.clone(),
                    read,
                });
            }
        }
    }
    sources
}

// ---------------------------------------------------------------------------
// Cell state (§4.6)
// ---------------------------------------------------------------------------

struct CellInput<'a> {
    state: &'a ClientState,
    server: &'a ServerRecord,
    row: Option<&'a ClientRow>,
    project_count: usize,
}

fn compute_cell(ctx: &McpLibraryContext, key: &[u8; 32], input: CellInput<'_>) -> McpCell {
    let client = input.state.client;
    let entry = input.state.entry(&input.server.name);
    let mut cell = McpCell {
        client_id: client,
        state: "off".to_string(),
        reason: None,
        error_message: None,
        present_in_file: entry.is_some(),
        disabled_in_file: client == ClientId::Codex && entry.is_some_and(codex_disabled),
        out_of_date: false,
        windows_fix_available: false,
        project_count: input.project_count,
    };
    let set = |cell: &mut McpCell, state: &str, reason: Option<&str>| {
        cell.state = state.to_string();
        cell.reason = reason.map(str::to_string);
    };
    if !input.state.writable {
        set(
            &mut cell,
            "readonly",
            input.state.readonly_reason.or(Some("config-unreadable")),
        );
        return cell;
    }
    if client == ClientId::Codex
        && input
            .state
            .read
            .structured_env
            .iter()
            .any(|name| name == &input.server.name)
    {
        set(&mut cell, "readonly", Some("codex-structured-env"));
        return cell;
    }
    let projected = match project(ctx, &input.server.name, &input.server.spec, client) {
        Ok(projected) => projected,
        Err(ProjectError::Unsupported(reason)) => {
            set(&mut cell, "unsupported", Some(reason));
            return cell;
        }
        Err(ProjectError::Blocked(reason)) => {
            set(&mut cell, "blocked", Some(reason));
            return cell;
        }
    };
    let enabled = input.row.is_some_and(|row| row.enabled);
    if let Some(row) = input.row.filter(|row| !row.last_error_code.is_empty()) {
        set(&mut cell, "error", Some("write-failed"));
        cell.error_message = Some(row.last_error_message.clone());
        return cell;
    }
    match (enabled, entry) {
        (true, None) => set(&mut cell, "changed-outside", Some("entry-removed-outside")),
        (false, Some(file)) => {
            if client == ClientId::Codex && codex_disabled(file) {
                set(&mut cell, "off", None);
            } else {
                set(&mut cell, "changed-outside", Some("entry-added-outside"));
            }
        }
        (true, Some(file)) => {
            if client == ClientId::Codex && codex_disabled(file) {
                set(&mut cell, "changed-outside", Some("entry-edited-outside"));
                return cell;
            }
            let wanted = projected_node(client, &projected, Some(file));
            let file_hash = entry_hash(key, client, file);
            let row = input.row.expect("enabled row");
            if file_hash == entry_hash(key, client, &wanted) {
                set(&mut cell, "on", None);
            } else if !row.last_written_hash.is_empty() && file_hash == row.last_written_hash {
                set(&mut cell, "on", None);
                cell.out_of_date = true;
            } else if semantic_equal(client, file, &wanted) {
                set(&mut cell, "on", None);
                cell.windows_fix_available = client != ClientId::Codex
                    && client != ClientId::Cursor
                    && entry_is_wrapped(&wanted)
                    && !entry_is_wrapped(file);
            } else {
                set(&mut cell, "changed-outside", Some("entry-edited-outside"));
            }
        }
        (false, None) => set(&mut cell, "off", None),
    }
    cell
}

fn secret_statuses(
    ctx: &McpLibraryContext,
    connection: Option<&Connection>,
    spec: &McpServerSpec,
) -> Vec<McpSecretStatus> {
    let created = |name: &str| {
        connection
            .and_then(|connection| env_var_created_by_skillhub(connection, name))
            .unwrap_or(false)
    };
    let present = |storage: SecretStorage, value: &Option<String>, variable: &str| match storage {
        SecretStorage::Library | SecretStorage::Literal => value.is_some(),
        SecretStorage::UserEnv | SecretStorage::External => {
            mcp_secrets::env_var_present(&*ctx.env, variable)
        }
    };
    let mut statuses = Vec::new();
    for item in spec.env.iter().filter(|item| item.secret) {
        let variable = item.variable().to_string();
        let by_variable = matches!(
            item.storage,
            SecretStorage::UserEnv | SecretStorage::External
        );
        statuses.push(McpSecretStatus {
            kind: "env".to_string(),
            name: item.name.clone(),
            env_var: by_variable.then(|| variable.clone()),
            header_template: None,
            storage: item.storage.contract_name().to_string(),
            present: present(item.storage, &item.value, &variable),
            inline_clients: item.inline_clients.clone(),
            created_by_skillhub: by_variable && created(&variable),
            required: item.required,
        });
    }
    for header in spec
        .headers
        .iter()
        .filter(|header| header.template != HeaderTemplate::Literal)
    {
        let variable = header.env_var.clone().unwrap_or_default();
        let by_variable = matches!(
            header.storage,
            SecretStorage::UserEnv | SecretStorage::External
        );
        statuses.push(McpSecretStatus {
            kind: "header".to_string(),
            name: header.name.clone(),
            env_var: header.env_var.clone(),
            header_template: Some(
                if header.template == HeaderTemplate::Bearer {
                    "bearer"
                } else {
                    "raw"
                }
                .to_string(),
            ),
            storage: header.storage.contract_name().to_string(),
            present: present(header.storage, &header.value, &variable),
            inline_clients: header.inline_clients.clone(),
            created_by_skillhub: by_variable && !variable.is_empty() && created(&variable),
            required: header.required,
        });
    }
    statuses
}

fn test_summary(server: &ServerRecord) -> Option<McpTestSummary> {
    server.test.as_ref().map(|test| McpTestSummary {
        status: test.status.clone(),
        tools_count: test.tools_count,
        tested_at: test.tested_at.clone(),
        stale: test.spec_revision != server.spec_revision,
        message_code: test.message_code.clone(),
    })
}

fn project_bindings_for(
    server: &ServerRecord,
    sources: &[ProjectSource],
    rows: &[ClientRow],
) -> Vec<McpProjectBinding> {
    let mut bindings = Vec::new();
    for source in sources {
        let Some(entry) = source.read.entry(&server.name) else {
            continue;
        };
        let state = if !source.writable {
            "readonly"
        } else if source.client == ClientId::Codex && codex_disabled(entry) {
            "off"
        } else {
            "on"
        };
        let _ = rows;
        bindings.push(McpProjectBinding {
            client_id: source.client,
            scope: source.scope,
            project_label: source.label.clone(),
            workspace_id: source.workspace_id.clone(),
            state: state.to_string(),
            readonly_reason: (!source.writable).then(|| {
                source
                    .readonly_reason
                    .unwrap_or("not-registered")
                    .to_string()
            }),
        });
    }
    bindings
}

// ---------------------------------------------------------------------------
// Snapshot (read-only: no spawn, no import, no recovery)
// ---------------------------------------------------------------------------

fn find_row<'a>(rows: &'a [ClientRow], server_id: &str, client: ClientId) -> Option<&'a ClientRow> {
    rows.iter().find(|row| {
        row.key.server_id == server_id
            && row.key.client == client
            && row.key.scope == Scope::User
            && row.key.workspace_id.is_empty()
    })
}

fn other_clients(connection: &Connection) -> Vec<OtherClient> {
    let Ok(mut statement) = connection
        .prepare("SELECT id, name FROM agent_adapters WHERE detected = 1 ORDER BY lower(name)")
    else {
        return Vec::new();
    };
    let Ok(rows) = statement.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    }) else {
        return Vec::new();
    };
    rows.flatten()
        .filter(|(id, _)| !matches!(id.as_str(), "codex" | "claude" | "cursor"))
        .map(|(adapter_id, label)| OtherClient {
            adapter_id,
            label: engine::safe_label(&label),
        })
        .collect()
}

pub(crate) fn library_snapshot(ctx: &McpLibraryContext) -> Result<McpLibrarySnapshot, McpError> {
    // Read before anything else: a write that finishes while this snapshot is
    // being built must make it look older, never newer (stale-drop rule).
    let generation = current_generation();
    let connection = open_db(ctx)?;
    let key = hash_key(ctx)?;
    let servers = load_servers(&connection, false)?;
    let rows = load_rows(&connection)?;
    let states = client_states(ctx, Some(&connection));
    let sources = project_sources(ctx);
    let library_initialized =
        read_preference(&connection, PREF_INITIALIZED).as_deref() == Some("1");

    let column_clients = states
        .iter()
        .filter(|state| {
            state.detected
                || rows
                    .iter()
                    .any(|row| row.key.client == state.client && row.enabled)
        })
        .map(|state| state.client)
        .collect::<Vec<_>>();

    let mut issues: Vec<McpIssue> = Vec::new();
    let mut server_rows = Vec::new();
    for server in &servers {
        let bindings = project_bindings_for(server, &sources, &rows);
        let mut cells = Vec::new();
        for state in states
            .iter()
            .filter(|state| column_clients.contains(&state.client))
        {
            let cell = compute_cell(
                ctx,
                &key,
                CellInput {
                    state,
                    server,
                    row: find_row(&rows, &server.id, state.client),
                    project_count: bindings
                        .iter()
                        .filter(|binding| binding.client_id == state.client)
                        .count(),
                },
            );
            cells.push(cell);
        }
        let secrets = secret_statuses(ctx, Some(&connection), &server.spec);
        let missing_secret_count = secrets.iter().filter(|secret| !secret.present).count();
        let issues_before = issues.len();
        for cell in &cells {
            let issue = |kind: &str, action: &str| McpIssue {
                id: format!("{kind}:{}:{}", server.id, cell.client_id.as_str()),
                kind: kind.to_string(),
                client_id: Some(cell.client_id),
                server_id: Some(server.id.clone()),
                server_name: Some(server.name.clone()),
                count: None,
                path_display: None,
                action: action.to_string(),
            };
            match (cell.state.as_str(), cell.reason.as_deref()) {
                ("error", _) => issues.push(issue("write-failed", "retry")),
                ("changed-outside", _) => issues.push(issue("changed-outside", "review-change")),
                ("blocked", Some("needs-inline-consent")) => {
                    issues.push(issue("needs-inline-consent", "allow-inline"))
                }
                _ => {}
            }
            if cell.out_of_date {
                issues.push(issue("out-of-date", "resync"));
            }
            if cell.windows_fix_available {
                issues.push(issue("windows-fix", "resync"));
            }
        }
        if missing_secret_count > 0 {
            issues.push(McpIssue {
                id: format!("missing-secret:{}", server.id),
                kind: "missing-secret".to_string(),
                client_id: None,
                server_id: Some(server.id.clone()),
                server_name: Some(server.name.clone()),
                count: Some(missing_secret_count),
                path_display: None,
                action: "fill-secret".to_string(),
            });
        }
        let summary = server_summary(&server.spec);
        server_rows.push(McpServerRow {
            id: server.id.clone(),
            name: server.name.clone(),
            display_name: if server.display_name.is_empty() {
                server.name.clone()
            } else {
                server.display_name.clone()
            },
            transport: server.spec.transport,
            target: McpTargetSummary {
                runner: summary.runner.clone(),
                subject: summary.subject.clone(),
                extra_arg_count: summary.extra_arg_count,
                host: summary.host.clone(),
            },
            cells,
            project_bindings: bindings,
            secrets,
            missing_secret_count,
            test: test_summary(server),
            source: server.source.clone(),
            spec_revision: server.spec_revision,
            issue_count: issues.len() - issues_before,
            updated_at: iso_from_ns(parse_ns(&server.updated_at)),
        });
    }
    server_rows.sort_by(|left, right| {
        left.display_name
            .to_lowercase()
            .cmp(&right.display_name.to_lowercase())
            .then(left.name.cmp(&right.name))
    });

    let library_names = servers
        .iter()
        .map(|server| server.name.to_ascii_lowercase())
        .collect::<HashSet<_>>();
    let mut unimported = Vec::new();
    for state in &states {
        if state.detected && !state.writable {
            issues.push(McpIssue {
                id: format!("client-unwritable:{}", state.client.as_str()),
                kind: "client-unwritable".to_string(),
                client_id: Some(state.client),
                server_id: None,
                server_name: None,
                count: None,
                path_display: Some(state.path_display.clone()),
                action: if state.readonly_reason == Some("client-not-installed") {
                    "none"
                } else {
                    "open-file-location"
                }
                .to_string(),
            });
        }
        for (name, entry) in &state.read.entries {
            // Entries import would skip (structured env, unsupported shapes or
            // names) are not offered again and again.
            let importable = !state.read.structured_env.contains(name)
                && name_supported(state.client, name)
                && spec_from_entry(state.client, entry).is_ok();
            if importable && !library_names.contains(&name.to_ascii_lowercase()) {
                unimported.push(UnimportedEntry {
                    client_id: state.client,
                    name: name.clone(),
                });
            }
        }
    }
    if library_initialized && !unimported.is_empty() {
        issues.push(McpIssue {
            id: "unimported".to_string(),
            kind: "unimported".to_string(),
            client_id: None,
            server_id: None,
            server_name: None,
            count: Some(unimported.len()),
            path_display: None,
            action: "import".to_string(),
        });
    }

    let stuck = engine::list_stuck_transactions(&ctx.mutation)
        .into_iter()
        .map(|item| StuckTransactionView {
            client_id: item
                .host_ids
                .first()
                .and_then(|host| ClientId::from_host(host)),
            path_display: item.path_displays.join("、"),
            snapshot_id: item.snapshot_id,
        })
        .collect::<Vec<_>>();
    for item in &stuck {
        issues.push(McpIssue {
            id: format!("stuck-transaction:{}", item.snapshot_id),
            kind: "stuck-transaction".to_string(),
            client_id: item.client_id,
            server_id: None,
            server_name: None,
            count: None,
            path_display: Some(item.path_display.clone()),
            action: "resolve-stuck".to_string(),
        });
    }
    let interrupted = count_interrupted(&connection);
    if interrupted > 0 {
        issues.push(McpIssue {
            id: "interrupted".to_string(),
            kind: "interrupted".to_string(),
            client_id: None,
            server_id: None,
            server_name: None,
            count: Some(interrupted),
            path_display: None,
            action: "none".to_string(),
        });
    }

    let clients = states
        .iter()
        .filter(|state| column_clients.contains(&state.client))
        .map(|state| McpClient {
            id: state.client,
            label: state.client.label().to_string(),
            adapter_id: state.client.adapter_id().to_string(),
            detected: state.detected,
            writable: state.writable,
            readonly_reason: (!state.writable).then(|| {
                state
                    .readonly_reason
                    .unwrap_or("config-unreadable")
                    .to_string()
            }),
            config_path_display: state.path_display.clone(),
            transports: state.client.transports(),
            secret_reference: state.client.secret_reference().to_string(),
            disable_mode: state.client.disable_mode().to_string(),
            enabled_count: server_rows
                .iter()
                .filter(|row| {
                    row.cells
                        .iter()
                        .any(|cell| cell.client_id == state.client && cell.state == "on")
                })
                .count(),
            restart_needed: client_written(state.client),
        })
        .collect();

    Ok(McpLibrarySnapshot {
        generation,
        generated_at: iso_from_ns(now_ns()),
        library_initialized,
        clients,
        other_clients: other_clients(&connection),
        servers: server_rows,
        issues,
        unimported,
        stuck_transactions: stuck,
    })
}

fn count_interrupted(connection: &Connection) -> usize {
    connection
        .query_row(
            "SELECT COUNT(*) FROM mcp_operations WHERE state = 'interrupted'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map(|count| count.max(0) as usize)
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// First-run import (§1.5): reads client files, writes SQLite only.
// ---------------------------------------------------------------------------

struct ImportSource {
    client: ClientId,
    scope: Scope,
    workspace_id: Option<String>,
    writable: bool,
    name: String,
    entry: Node,
}

pub(crate) fn import_from_clients(
    ctx: &McpLibraryContext,
    request: McpImportRequest,
) -> Result<McpImportReport, McpError> {
    if !matches!(request.reason.as_str(), "first-run" | "onboarding" | "user") {
        return Err(McpError::invalid("导入原因无效。"));
    }
    let connection = open_db(ctx)?;
    let key = hash_key(ctx)?;
    let wanted = request
        .client_ids
        .clone()
        .unwrap_or_else(|| ClientId::ALL.to_vec());
    let states = client_states(ctx, Some(&connection));
    let mut files_read = Vec::new();
    let mut sources: Vec<ImportSource> = Vec::new();
    let mut structured: Vec<(ClientId, String)> = Vec::new();
    for state in states.iter().filter(|state| wanted.contains(&state.client)) {
        if state.read.status != TargetReadStatus::Missing || state.detected {
            files_read.push(FileRead {
                client_id: state.client,
                scope: Scope::User,
                path_display: state.path_display.clone(),
                status: if state.readonly_reason == Some("client-not-installed") {
                    "missing".to_string()
                } else {
                    read_status_text(state.read.status).to_string()
                },
                servers: state.read.entries.len(),
            });
        }
        for name in &state.read.structured_env {
            structured.push((state.client, name.clone()));
        }
        for (name, entry) in &state.read.entries {
            sources.push(ImportSource {
                client: state.client,
                scope: Scope::User,
                workspace_id: None,
                writable: state.writable,
                name: name.clone(),
                entry: entry.clone(),
            });
        }
    }
    for source in project_sources(ctx)
        .into_iter()
        .filter(|source| wanted.contains(&source.client))
    {
        if source.workspace_id.is_some() {
            files_read.push(FileRead {
                client_id: source.client,
                scope: source.scope,
                path_display: format!("{} · {}", source.path_display, source.label),
                status: read_status_text(source.read.status).to_string(),
                servers: source.read.entries.len(),
            });
        }
        for name in &source.read.structured_env {
            structured.push((source.client, name.clone()));
        }
        for (name, entry) in source.read.entries {
            sources.push(ImportSource {
                client: source.client,
                scope: source.scope,
                workspace_id: source.workspace_id.clone(),
                writable: source.writable,
                name,
                entry,
            });
        }
    }
    // Deterministic order: client order, user scope before project scopes.
    sources.sort_by_key(|source| (source.scope != Scope::User, source.client));

    connection
        .execute_batch("BEGIN IMMEDIATE")
        .map_err(db_error)?;
    let outcome = (|| -> Result<McpImportReport, McpError> {
        let mut servers = load_servers(&connection, true)?;
        let rows = load_rows(&connection)?;
        let mut added = Vec::new();
        let mut merged: BTreeMap<String, BTreeSet<ClientId>> = BTreeMap::new();
        let mut differing: BTreeMap<String, BTreeSet<ClientId>> = BTreeMap::new();
        let mut skipped = Vec::new();
        let now = ns_text(now_ns());
        let mut touched_names = BTreeSet::new();
        for source in &sources {
            let name_key = source.name.to_ascii_lowercase();
            if structured
                .iter()
                .any(|(client, name)| *client == source.client && name == &source.name)
            {
                skipped.push(ImportSkip {
                    name: source.name.clone(),
                    client_id: source.client,
                    reason: "codex-structured-env".to_string(),
                });
                continue;
            }
            if !name_supported(source.client, &source.name) {
                skipped.push(ImportSkip {
                    name: source.name.clone(),
                    client_id: source.client,
                    reason: "invalid-name".to_string(),
                });
                continue;
            }
            let existing_index = servers.iter().position(|server| {
                server.name.to_ascii_lowercase() == name_key && server.deleted_at.is_none()
            });
            let server_index = match existing_index {
                Some(index) => index,
                None => {
                    let spec = match spec_from_entry(source.client, &source.entry) {
                        Ok(spec) => spec,
                        Err(reason) => {
                            skipped.push(ImportSkip {
                                name: source.name.clone(),
                                client_id: source.client,
                                reason: reason.to_string(),
                            });
                            continue;
                        }
                    };
                    // A soft-deleted row with the same name is superseded.
                    if let Some(index) = servers
                        .iter()
                        .position(|server| server.name.to_ascii_lowercase() == name_key)
                    {
                        delete_server_hard(&connection, &servers[index].id)?;
                        servers.remove(index);
                    }
                    let record = ServerRecord {
                        id: format!("mcps-{}", uuid::Uuid::new_v4().simple()),
                        name: source.name.clone(),
                        display_name: String::new(),
                        spec,
                        spec_revision: 1,
                        source: McpServerSource::Import {
                            client_id: source.client,
                            scope: source.scope,
                        },
                        meta: json!({}),
                        test: None,
                        created_at: now.clone(),
                        updated_at: now.clone(),
                        deleted_at: None,
                    };
                    save_server(&connection, &record)?;
                    added.push(record.name.clone());
                    servers.push(record);
                    servers.len() - 1
                }
            };
            let server = &servers[server_index];
            touched_names.insert(server.name.clone());
            let same = match project(ctx, &server.name, &server.spec, source.client) {
                Ok(projected) => {
                    let wanted = projected_node(source.client, &projected, Some(&source.entry));
                    entry_hash(&key, source.client, &wanted)
                        == entry_hash(&key, source.client, &source.entry)
                        || semantic_equal(source.client, &wanted, &source.entry)
                }
                Err(_) => false,
            };
            if !added.contains(&server.name) || existing_index.is_some() {
                let bucket = if same { &mut merged } else { &mut differing };
                bucket
                    .entry(server.name.clone())
                    .or_default()
                    .insert(source.client);
            } else if !same {
                differing
                    .entry(server.name.clone())
                    .or_default()
                    .insert(source.client);
            }
            if !source.writable && source.scope != Scope::User {
                continue;
            }
            let row_key = RowKey {
                server_id: server.id.clone(),
                client: source.client,
                scope: source.scope,
                workspace_id: source.workspace_id.clone().unwrap_or_default(),
            };
            let existing_row = rows.iter().find(|row| row.key == row_key);
            if existing_row.is_some_and(|row| !row.last_written_hash.is_empty()) {
                // SkillHub manages this cell already; never reset its record.
                continue;
            }
            let mut row = existing_row
                .cloned()
                .unwrap_or_else(|| ClientRow::new(row_key));
            row.enabled = !(source.client == ClientId::Codex && codex_disabled(&source.entry));
            row.last_seen_hash = entry_hash(&key, source.client, &source.entry);
            row.last_written_hash = String::new();
            row.inline_consent = server_needs_inline(&server.spec, source.client);
            save_row(&connection, &row)?;
        }
        write_preference(&connection, PREF_INITIALIZED, "1")?;
        let operation_id = format!("mcp-op-{}", uuid::Uuid::new_v4().simple());
        let summary = McpOperationSummary {
            kind: "import".to_string(),
            server_names: touched_names.iter().cloned().collect(),
            client_ids: sources
                .iter()
                .map(|source| source.client)
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect(),
            failed_client_ids: Vec::new(),
            env_var_names: Vec::new(),
        };
        insert_operation(
            &connection,
            &operation_id,
            "import",
            "applied",
            &summary,
            &[],
            None,
        )?;
        prune_operations(&connection)?;
        Ok(McpImportReport {
            operation_id: Some(operation_id),
            added,
            merged: merged
                .into_iter()
                .map(|(name, clients)| NameClients {
                    name,
                    client_ids: clients.into_iter().collect(),
                })
                .collect(),
            differing: differing
                .into_iter()
                .map(|(name, clients)| NameClients {
                    name,
                    client_ids: clients.into_iter().collect(),
                })
                .collect(),
            skipped,
            files_read,
            wrote_client_files: false,
        })
    })();
    match outcome {
        Ok(report) => {
            connection.execute_batch("COMMIT").map_err(db_error)?;
            bump_generation();
            Ok(report)
        }
        Err(error) => {
            let _ = connection.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}

/// Whether a spec carries literal secrets meant for `client` (consent given).
fn server_needs_inline(spec: &McpServerSpec, client: ClientId) -> bool {
    spec.env
        .iter()
        .any(|item| item.secret && item.inline_clients.contains(&client))
        || spec
            .headers
            .iter()
            .any(|header| header.inline_clients.contains(&client))
        || spec.secret_arg_clients.contains(&client)
}

// ---------------------------------------------------------------------------
// Operations table (§1.1) and undo data (§4.4)
// ---------------------------------------------------------------------------

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UndoEntry {
    client: ClientId,
    scope: Scope,
    workspace_id: String,
    name: String,
    /// Compact JSON of the entry before / after (order kept).
    before: Option<String>,
    after: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UndoTarget {
    client: ClientId,
    scope: Scope,
    workspace_id: String,
    snapshot_id: Option<String>,
    applied_sha256: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EnvBefore {
    name: String,
    value: Option<String>,
    created_by_skillhub: Option<bool>,
    /// The value the operation wrote (`None` = deleted). Undo restores the
    /// variable only while it still holds exactly that value.
    #[serde(default)]
    after: Option<String>,
    #[serde(default)]
    after_recorded: bool,
}

/// DPAPI-protected (`undo_protected`): library rows, entries and env values
/// before the operation.
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UndoBlob {
    servers_before: Vec<(String, Option<ServerRecord>)>,
    rows_before: Vec<(RowKey, Option<ClientRow>)>,
    entries: Vec<UndoEntry>,
    targets: Vec<UndoTarget>,
    env_before: Vec<EnvBefore>,
}

fn insert_operation(
    connection: &Connection,
    operation_id: &str,
    kind: &str,
    state: &str,
    summary: &McpOperationSummary,
    snapshot_ids: &[String],
    undo: Option<&UndoBlob>,
) -> Result<(), McpError> {
    let created = now_ns();
    let protected = match undo {
        Some(blob) => Some(protect_json(blob)?),
        None => None,
    };
    connection
        .execute(
            "INSERT INTO mcp_operations (id, created_at, kind, state, summary_json,
                 snapshot_ids_json, undo_protected, undone_by, expires_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, '', ?8)
             ON CONFLICT(id) DO UPDATE SET state = excluded.state,
                 summary_json = excluded.summary_json,
                 snapshot_ids_json = excluded.snapshot_ids_json,
                 undo_protected = excluded.undo_protected",
            params![
                operation_id,
                ns_text(created),
                kind,
                state,
                serde_json::to_string(summary).unwrap_or_else(|_| "{}".to_string()),
                serde_json::to_string(snapshot_ids).unwrap_or_else(|_| "[]".to_string()),
                protected,
                ns_text(created + UNDO_WINDOW_NS),
            ],
        )
        .map_err(db_error)?;
    Ok(())
}

fn update_operation(
    connection: &Connection,
    operation_id: &str,
    state: &str,
    summary: &McpOperationSummary,
    snapshot_ids: &[String],
    undo: Option<&UndoBlob>,
) -> Result<(), McpError> {
    let protected = match undo {
        Some(blob) => Some(protect_json(blob)?),
        None => None,
    };
    connection
        .execute(
            "UPDATE mcp_operations SET state = ?2, summary_json = ?3, snapshot_ids_json = ?4,
                 undo_protected = ?5 WHERE id = ?1",
            params![
                operation_id,
                state,
                serde_json::to_string(summary).unwrap_or_else(|_| "{}".to_string()),
                serde_json::to_string(snapshot_ids).unwrap_or_else(|_| "[]".to_string()),
                protected,
            ],
        )
        .map_err(db_error)?;
    Ok(())
}

/// Retention (§1.1): expired rows lose their undo data; at most 200 rows.
fn prune_operations(connection: &Connection) -> Result<(), McpError> {
    let now = ns_text(now_ns());
    connection
        .execute(
            "UPDATE mcp_operations SET undo_protected = NULL, state = 'expired'
             WHERE CAST(expires_at AS INTEGER) < CAST(?1 AS INTEGER)
               AND state IN ('applied', 'partial', 'failed', 'interrupted', 'undone')",
            params![now],
        )
        .map_err(db_error)?;
    connection
        .execute(
            "DELETE FROM mcp_operations WHERE id NOT IN (
                 SELECT id FROM mcp_operations ORDER BY CAST(created_at AS INTEGER) DESC LIMIT ?1)",
            params![MAX_HISTORY_ROWS as i64],
        )
        .map_err(db_error)?;
    // Soft-deleted servers are purged once their undo window has passed.
    let cutoff = now_ns().saturating_sub(UNDO_WINDOW_NS);
    let mut statement = connection
        .prepare("SELECT id, deleted_at FROM mcp_servers WHERE deleted_at IS NOT NULL")
        .map_err(db_error)?;
    let expired = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(db_error)?
        .flatten()
        .filter(|(_, deleted)| parse_ns(deleted) < cutoff)
        .map(|(id, _)| id)
        .collect::<Vec<_>>();
    for id in expired {
        delete_server_hard(connection, &id)?;
    }
    Ok(())
}

/// Operations left in `applying` by a crash become `interrupted` at the
/// next write (§4.5). The cells always come from the files.
fn mark_interrupted(connection: &Connection) -> Result<(), McpError> {
    connection
        .execute(
            "UPDATE mcp_operations SET state = 'interrupted' WHERE state = 'applying'",
            [],
        )
        .map_err(db_error)?;
    Ok(())
}

struct OperationRow {
    id: String,
    created_at: u128,
    kind: String,
    state: String,
    summary: McpOperationSummary,
    has_undo: bool,
    expires_at: u128,
}

fn load_operations(connection: &Connection) -> Result<Vec<OperationRow>, McpError> {
    let mut statement = connection
        .prepare(
            "SELECT id, created_at, kind, state, summary_json, undo_protected IS NOT NULL, expires_at
             FROM mcp_operations ORDER BY CAST(created_at AS INTEGER) DESC",
        )
        .map_err(db_error)?;
    let rows = statement
        .query_map([], |row| {
            Ok(OperationRow {
                id: row.get(0)?,
                created_at: parse_ns(&row.get::<_, String>(1)?),
                kind: row.get(2)?,
                state: row.get(3)?,
                summary: serde_json::from_str(&row.get::<_, String>(4)?).unwrap_or_default(),
                has_undo: row.get::<_, bool>(5)?,
                expires_at: parse_ns(&row.get::<_, String>(6)?),
            })
        })
        .map_err(db_error)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(db_error)
}

fn load_undo_blob(
    connection: &Connection,
    operation_id: &str,
) -> Result<Option<UndoBlob>, McpError> {
    let protected = connection
        .query_row(
            "SELECT undo_protected FROM mcp_operations WHERE id = ?1",
            params![operation_id],
            |row| row.get::<_, Option<Vec<u8>>>(0),
        )
        .optional()
        .map_err(db_error)?
        .flatten();
    match protected {
        Some(bytes) => Ok(Some(unprotect_json(&bytes)?)),
        None => Ok(None),
    }
}

fn overlaps(left: &McpOperationSummary, right: &McpOperationSummary) -> bool {
    let names = left
        .server_names
        .iter()
        .map(|name| name.to_ascii_lowercase())
        .collect::<HashSet<_>>();
    let name_overlap = right
        .server_names
        .iter()
        .any(|name| names.contains(&name.to_ascii_lowercase()));
    let client_overlap = left.client_ids.is_empty()
        || right.client_ids.is_empty()
        || right
            .client_ids
            .iter()
            .any(|client| left.client_ids.contains(client));
    let env_overlap = right
        .env_var_names
        .iter()
        .any(|name| left.env_var_names.contains(name));
    (name_overlap && client_overlap) || env_overlap
}

/// Later operations (newest first in `operations`) that touched the same
/// entries and are still in effect.
fn later_overlapping<'a>(
    operations: &'a [OperationRow],
    target: &OperationRow,
) -> Vec<&'a OperationRow> {
    operations
        .iter()
        .filter(|other| {
            other.created_at > target.created_at
                && other.id != target.id
                && matches!(other.state.as_str(), "applied" | "partial")
                && !matches!(other.kind.as_str(), "import" | "undo" | "rollback")
                && overlaps(&target.summary, &other.summary)
        })
        .collect()
}

fn undo_unavailable_reason(
    operations: &[OperationRow],
    operation: &OperationRow,
    now: u128,
) -> Option<&'static str> {
    if operation.kind == "import" {
        return Some("import-only");
    }
    if operation.state == "undone" {
        return Some("already-undone");
    }
    if operation.state == "expired" || now > operation.expires_at || !operation.has_undo {
        return Some("expired");
    }
    if !matches!(operation.state.as_str(), "applied" | "partial") {
        return Some("expired");
    }
    if !later_overlapping(operations, operation).is_empty() {
        return Some("superseded");
    }
    None
}

// ---------------------------------------------------------------------------
// Write plans
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ItemAction {
    Add,
    Update,
    Remove,
    Enable,
    Disable,
}

impl ItemAction {
    fn as_str(self) -> &'static str {
        match self {
            ItemAction::Add => "add",
            ItemAction::Update => "update",
            ItemAction::Remove => "remove",
            ItemAction::Enable => "enable",
            ItemAction::Disable => "disable",
        }
    }
}

struct PlanItem {
    server_id: String,
    server_name: String,
    action: ItemAction,
    /// `None`: only the library row changes (file already as desired).
    op: Option<EntryOp>,
    desired_enabled: Option<bool>,
    confirm: Option<&'static str>,
    /// Consent recorded on the row (inline values allowed for this client).
    consent: Option<bool>,
    /// Restore an exact earlier row (undo).
    /// A second plain-language confirmation for the same item (for
    /// example inline consent *and* an entry changed outside SkillHub).
    confirm_also: Option<&'static str>,
    row_override: Option<Option<ClientRow>>,
}

struct TargetPlan {
    client: ClientId,
    scope: Scope,
    workspace_id: String,
    project_label: Option<String>,
    items: Vec<PlanItem>,
    /// Undo: restore this snapshot's bytes when the file is untouched since.
    restore_snapshot: Option<String>,
    /// Undo: entries changed after the operation (reported, not touched).
    conflicts: Vec<String>,
}

enum EnvOp {
    Set { name: String, value: String },
    Delete { name: String },
}

impl EnvOp {
    fn name(&self) -> &str {
        match self {
            EnvOp::Set { name, .. } | EnvOp::Delete { name } => name,
        }
    }
}

impl fmt::Debug for EnvOp {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            EnvOp::Set { name, .. } => write!(formatter, "Set({name}, ••••)"),
            EnvOp::Delete { name } => write!(formatter, "Delete({name})"),
        }
    }
}

#[derive(Default)]
struct WritePlan {
    kind: &'static str,
    targets: Vec<TargetPlan>,
    skipped: Vec<McpClientResult>,
    /// Servers saved before the file writes (desired state lives here).
    servers_after: Vec<ServerRecord>,
    servers_soft_deleted: Vec<String>,
    servers_hard_deleted: Vec<String>,
    rows_deleted: Vec<RowKey>,
    env_ops: Vec<EnvOp>,
    /// Environment variables SkillHub records as its own after the write.
    env_created: Vec<String>,
    kinds: Vec<&'static str>,
    env_confirm: Vec<McpEnvVarConfirmation>,
    server_names: Vec<String>,
    env_var_names: Vec<String>,
    undoable: bool,
    /// Library and env state to restore instead of capturing it (undo).
    undo_restore: Option<UndoBlob>,
}

impl WritePlan {
    fn new(kind: &'static str) -> Self {
        Self {
            kind,
            undoable: true,
            ..Self::default()
        }
    }

    fn target_mut(
        &mut self,
        client: ClientId,
        scope: Scope,
        workspace_id: &str,
        project_label: Option<String>,
    ) -> &mut TargetPlan {
        if let Some(index) = self.targets.iter().position(|target| {
            target.client == client
                && target.scope == scope
                && target.workspace_id == workspace_id
                && target.items.len() < 64
        }) {
            return &mut self.targets[index];
        }
        self.targets.push(TargetPlan {
            client,
            scope,
            workspace_id: workspace_id.to_string(),
            project_label,
            items: Vec::new(),
            restore_snapshot: None,
            conflicts: Vec::new(),
        });
        self.targets.last_mut().expect("just pushed")
    }

    fn add_kind(&mut self, kind: &'static str) {
        if !self.kinds.contains(&kind) {
            self.kinds.push(kind);
        }
    }

    fn note_server(&mut self, name: &str) {
        if !self.server_names.iter().any(|existing| existing == name) {
            self.server_names.push(name.to_string());
        }
    }

    fn skip(&mut self, client: ClientId, scope: Scope, server_id: &str, reason: &str) {
        if let Some(existing) = self.skipped.iter_mut().find(|result| {
            result.client_id == client
                && result.scope == scope
                && result.skipped_reason.as_deref() == Some(reason)
        }) {
            existing.server_ids.push(server_id.to_string());
            return;
        }
        self.skipped.push(McpClientResult {
            client_id: client,
            scope,
            project_label: None,
            server_ids: vec![server_id.to_string()],
            status: "skipped".to_string(),
            skipped_reason: Some(reason.to_string()),
            error: None,
            restart_hint: false,
        });
    }

    fn has_effect(&self) -> bool {
        self.undo_restore.is_some()
            || !self.targets.is_empty()
            || !self.servers_after.is_empty()
            || !self.servers_soft_deleted.is_empty()
            || !self.servers_hard_deleted.is_empty()
            || !self.rows_deleted.is_empty()
            || !self.env_ops.is_empty()
    }
}

fn request_digest<T: Serialize>(request: &T) -> Vec<u8> {
    let mut value = serde_json::to_value(request).unwrap_or(JsonValue::Null);
    if let Some(object) = value.as_object_mut() {
        object.remove("confirmToken");
    }
    let bytes = serde_json::to_vec(&value).unwrap_or_default();
    sha256_bytes(&[&bytes]).to_vec()
}

// ---------------------------------------------------------------------------
// Previews for plain-language confirmations
// ---------------------------------------------------------------------------

fn entry_preview(client: ClientId, entry: &Node) -> McpEntryPreview {
    let object = entry.as_object().cloned().unwrap_or_default();
    let transport = Transport::parse(entry_transport(client, &object)).unwrap_or(Transport::Stdio);
    let command = object
        .get("command")
        .and_then(Node::as_str)
        .unwrap_or_default();
    let args = node_strings(object.get("args"));
    let (command, args, _) = unwrap_entry_command(command, &args);
    let target_display = match transport {
        Transport::Stdio => {
            let runner = engine::command_stem(&command);
            match mcp_paste::subject_of(&command, &args)
                .filter(|subject| !mcp_mutation_secret(subject))
            {
                Some(subject) => format!("{runner} · {}", redact_subject(&subject)),
                None => runner,
            }
        }
        Transport::Http | Transport::Sse => object
            .get("url")
            .and_then(Node::as_str)
            .and_then(mcp_paste::url_host)
            .unwrap_or_default(),
    };
    let keys = |key: &str| {
        object
            .get(key)
            .and_then(Node::as_object)
            .map(|map| map.keys().cloned().collect::<Vec<_>>())
            .unwrap_or_default()
    };
    let mut env_names = keys("env");
    env_names.extend(node_strings(object.get("env_vars")));
    let mut header_names = keys("headers");
    header_names.extend(keys("http_headers"));
    header_names.extend(keys("env_http_headers"));
    if object.get("bearer_token_env_var").is_some() {
        header_names.push("Authorization".to_string());
    }
    McpEntryPreview {
        transport,
        target_display,
        env_names,
        header_names,
        arg_count: args.len(),
    }
}

fn changed_fields(client: ClientId, before: Option<&Node>, after: Option<&Node>) -> Vec<String> {
    let (Some(before), Some(after)) = (before, after) else {
        return Vec::new();
    };
    let canonical = |node: &Node| -> JsonValue {
        serde_json::from_str(&canonical_entry(client, node, true)).unwrap_or(JsonValue::Null)
    };
    let (left, right) = (canonical(before), canonical(after));
    let mut fields = Vec::new();
    let differs = |keys: &[&str]| keys.iter().any(|key| left.get(key) != right.get(key));
    for (field, keys) in [
        ("transport", &["type"][..]),
        ("command", &["command"][..]),
        ("args", &["args"][..]),
        ("url", &["url"][..]),
        ("env", &["env", "env_vars"][..]),
        (
            "headers",
            &[
                "headers",
                "http_headers",
                "env_http_headers",
                "bearer_token_env_var",
            ][..],
        ),
        ("cwd", &["cwd"][..]),
        ("required", &["required"][..]),
    ] {
        if differs(keys) {
            fields.push(field.to_string());
        }
    }
    if client == ClientId::Codex && codex_disabled(before) != codex_disabled(after) {
        fields.push("enabled".to_string());
    }
    fields
}

// ---------------------------------------------------------------------------
// Plan execution: confirmation, library, env, then one transaction per file
// ---------------------------------------------------------------------------

struct DryRunView {
    current_sha256: String,
    before: Vec<(String, Option<Node>)>,
    after: Vec<(String, Option<Node>)>,
}

fn entry_changes(target: &TargetPlan) -> Vec<EntryChange> {
    target
        .items
        .iter()
        .filter_map(|item| {
            item.op.clone().map(|op| EntryChange {
                host_id: target.client.host_id().to_string(),
                scope: target.scope.as_str().to_string(),
                workspace_id: (!target.workspace_id.is_empty())
                    .then(|| target.workspace_id.clone()),
                server_name: item.server_name.clone(),
                op,
            })
        })
        .collect()
}

fn lookup<'a>(entries: &'a [(String, Option<Node>)], name: &str) -> Option<&'a Node> {
    entries
        .iter()
        .find(|(existing, _)| existing == name)
        .and_then(|(_, node)| node.as_ref())
}

fn is_config_changed(message: &str) -> bool {
    message.contains("发生变化") || message.contains("外部修改")
}

/// One target with up to two retries when the client rewrote its own file
/// meanwhile but the managed entries are unchanged (§4.2, bug MCP#3).
fn apply_target_with_retry(
    ctx: &McpLibraryContext,
    changes: Vec<EntryChange>,
    operation_id: &str,
    index: usize,
    first_before: &[(String, Option<Node>)],
) -> Result<engine::EntryApplyOutcome, String> {
    let mut attempt = 0usize;
    loop {
        match engine::apply_entry_changes_now(
            &ctx.mutation,
            changes.clone(),
            operation_id,
            index * 4 + attempt,
        ) {
            Ok(outcome) => return Ok(outcome),
            Err(error) if is_config_changed(&error) && attempt < 2 => {
                attempt += 1;
                std::thread::sleep(Duration::from_millis(300));
                let fresh = engine::dry_run_entry_changes(&ctx.mutation, &changes)?;
                let unchanged = fresh.before.iter().all(|(name, node)| {
                    engine::nodes_equivalent(node.as_ref(), lookup(first_before, name))
                });
                if !unchanged {
                    return Err(error);
                }
            }
            Err(error) => return Err(error),
        }
    }
}

fn execute_plan(
    ctx: &McpLibraryContext,
    connection: &Connection,
    mut plan: WritePlan,
    confirm_token: Option<&str>,
    digest: &[u8],
) -> Result<McpWriteOutcome, McpError> {
    let key = hash_key(ctx)?;
    // 1. Compute everything first, without writing.
    let mut dry_runs: Vec<Option<Result<DryRunView, String>>> = Vec::new();
    for target in &plan.targets {
        let changes = entry_changes(target);
        if changes.is_empty() {
            dry_runs.push(None);
            continue;
        }
        dry_runs.push(Some(
            engine::dry_run_entry_changes(&ctx.mutation, &changes).map(|dry| DryRunView {
                current_sha256: dry.current_sha256.clone(),
                before: dry.before,
                after: dry.after,
            }),
        ));
    }
    let item_kinds = plan
        .targets
        .iter()
        .flat_map(|target| {
            target
                .items
                .iter()
                .flat_map(|item| item.confirm.into_iter().chain(item.confirm_also))
        })
        .collect::<Vec<_>>();
    for kind in item_kinds {
        plan.add_kind(kind);
    }
    let mut items_view = Vec::new();
    if !plan.kinds.is_empty() {
        for (target, dry) in plan.targets.iter().zip(&dry_runs) {
            for item in target.items.iter().filter(|item| item.op.is_some()) {
                let (before, after) = match dry {
                    Some(Ok(view)) => (
                        lookup(&view.before, &item.server_name),
                        lookup(&view.after, &item.server_name),
                    ),
                    _ => (None, None),
                };
                items_view.push(McpConfirmationItem {
                    client_id: target.client,
                    client_label: target.client.label().to_string(),
                    scope: target.scope,
                    project_label: target.project_label.clone(),
                    server_name: item.server_name.clone(),
                    action: item.action.as_str().to_string(),
                    before: before.map(|node| entry_preview(target.client, node)),
                    after: after.map(|node| entry_preview(target.client, node)),
                    changed_fields: changed_fields(target.client, before, after),
                });
            }
        }
    }
    // 2. Plain-language confirmation (I6), bound to content, not time.
    if !plan.kinds.is_empty() {
        let mut parts: Vec<Vec<u8>> = vec![
            b"confirm".to_vec(),
            serde_json::to_vec(&plan.kinds).unwrap_or_default(),
            serde_json::to_vec(&items_view).unwrap_or_default(),
            serde_json::to_vec(&plan.env_confirm).unwrap_or_default(),
        ];
        for dry in dry_runs.iter().flatten() {
            parts.push(match dry {
                Ok(view) => view.current_sha256.clone().into_bytes(),
                Err(error) => error.clone().into_bytes(),
            });
        }
        parts.push(digest.to_vec());
        let refs = parts.iter().map(Vec::as_slice).collect::<Vec<_>>();
        let token = hmac_hex(&key, &refs);
        if confirm_token != Some(token.as_str()) {
            return Ok(McpWriteOutcome::NeedsConfirmation {
                confirmation: McpConfirmation {
                    kinds: plan.kinds.iter().map(|kind| kind.to_string()).collect(),
                    confirm_token: token,
                    items: items_view,
                    env_vars: (!plan.env_confirm.is_empty()).then(|| plan.env_confirm.clone()),
                    undoable: plan.undoable,
                },
            });
        }
    }
    if !plan.has_effect() {
        if !plan.skipped.is_empty() {
            return Ok(McpWriteOutcome::noop("nothing-selected"));
        }
        return Ok(McpWriteOutcome::noop("already-in-state"));
    }

    // 3. Operation row first (state `applying`).
    let operation_id = format!("mcp-op-{}", uuid::Uuid::new_v4().simple());
    let mut summary = McpOperationSummary {
        kind: plan.kind.to_string(),
        server_names: plan.server_names.clone(),
        client_ids: plan
            .targets
            .iter()
            .map(|target| target.client)
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect(),
        failed_client_ids: Vec::new(),
        env_var_names: plan.env_var_names.clone(),
    };
    insert_operation(
        connection,
        &operation_id,
        plan.kind,
        "applying",
        &summary,
        &[],
        None,
    )?;

    // Capture the library and env state before anything changes.
    let all_servers = load_servers(connection, true)?;
    let all_rows = load_rows(connection)?;
    let mut touched_servers = BTreeSet::new();
    touched_servers.extend(plan.servers_after.iter().map(|server| server.id.clone()));
    touched_servers.extend(plan.servers_soft_deleted.iter().cloned());
    touched_servers.extend(plan.servers_hard_deleted.iter().cloned());
    let mut touched_rows: BTreeSet<RowKey> = plan.rows_deleted.iter().cloned().collect();
    for target in &plan.targets {
        for item in &target.items {
            touched_servers.insert(item.server_id.clone());
            touched_rows.insert(RowKey {
                server_id: item.server_id.clone(),
                client: target.client,
                scope: target.scope,
                workspace_id: target.workspace_id.clone(),
            });
        }
    }
    for server_id in &plan.servers_hard_deleted {
        touched_rows.extend(
            all_rows
                .iter()
                .filter(|row| &row.key.server_id == server_id)
                .map(|row| row.key.clone()),
        );
    }
    if let Some(restore) = &plan.undo_restore {
        // Undo of an undo must be able to bring back everything it restores.
        touched_servers.extend(restore.servers_before.iter().map(|(id, _)| id.clone()));
        touched_rows.extend(restore.rows_before.iter().map(|(key, _)| key.clone()));
    }
    let mut blob = UndoBlob {
        servers_before: touched_servers
            .iter()
            .map(|id| {
                (
                    id.clone(),
                    all_servers.iter().find(|server| &server.id == id).cloned(),
                )
            })
            .collect(),
        rows_before: touched_rows
            .iter()
            .map(|key| {
                (
                    key.clone(),
                    all_rows.iter().find(|row| &row.key == key).cloned(),
                )
            })
            .collect(),
        entries: Vec::new(),
        targets: Vec::new(),
        env_before: plan
            .env_ops
            .iter()
            .map(|op| EnvBefore {
                name: op.name().to_string(),
                value: ctx.env.get(op.name()).ok().flatten(),
                created_by_skillhub: env_var_created_by_skillhub(connection, op.name()),
                after: match op {
                    EnvOp::Set { value, .. } => Some(value.clone()),
                    EnvOp::Delete { .. } => None,
                },
                after_recorded: true,
            })
            .collect(),
    };

    // 4. Environment variables (HKCU) before any config references them.
    if !plan.env_ops.is_empty() {
        let mut applied: Vec<&EnvBefore> = Vec::new();
        for (op, before) in plan.env_ops.iter().zip(&blob.env_before) {
            let result = match op {
                EnvOp::Set { name, value } => ctx.env.set(name, value),
                EnvOp::Delete { name } => ctx.env.delete(name),
            };
            if result.is_err() {
                for done in applied {
                    let _ = match &done.value {
                        Some(value) => ctx.env.set(&done.name, value),
                        None => ctx.env.delete(&done.name),
                    };
                }
                update_operation(connection, &operation_id, "failed", &summary, &[], None)?;
                return Err(McpError::new(
                    "env-write-failed",
                    "没能保存到当前用户环境变量。",
                ));
            }
            applied.push(before);
        }
        for op in &plan.env_ops {
            match op {
                EnvOp::Set { name, .. } => {
                    let created = plan.env_created.iter().any(|created| created == name);
                    let existing = env_var_created_by_skillhub(connection, name);
                    set_env_var_record(connection, name, Some(created || existing == Some(true)))?;
                }
                EnvOp::Delete { name } => set_env_var_record(connection, name, None)?,
            }
        }
        let _ = ctx.env.broadcast();
    }
    if let Some(restore) = &plan.undo_restore {
        // Undo: SkillHub's record of who created each variable goes back too.
        for before in &restore.env_before {
            set_env_var_record(connection, &before.name, before.created_by_skillhub)?;
        }
    }

    // 5. Library rows (desired state) in one SQLite transaction.
    connection
        .execute_batch("BEGIN IMMEDIATE")
        .map_err(db_error)?;
    let library = (|| -> Result<(), McpError> {
        for id in &plan.servers_hard_deleted {
            delete_server_hard(connection, id)?;
        }
        for server in &plan.servers_after {
            save_server(connection, server)?;
        }
        let now = ns_text(now_ns());
        for id in &plan.servers_soft_deleted {
            connection
                .execute(
                    "UPDATE mcp_servers SET deleted_at = ?2, updated_at = ?2 WHERE id = ?1",
                    params![id, now],
                )
                .map_err(db_error)?;
            connection
                .execute(
                    "DELETE FROM mcp_server_clients WHERE server_id = ?1",
                    params![id],
                )
                .map_err(db_error)?;
        }
        for key in &plan.rows_deleted {
            delete_row(connection, key)?;
        }
        if let Some(restore) = &plan.undo_restore {
            for (id, before) in &restore.servers_before {
                match before {
                    Some(server) => save_server(connection, server)?,
                    None => delete_server_hard(connection, id)?,
                }
            }
        }
        for target in &plan.targets {
            for item in &target.items {
                let key = RowKey {
                    server_id: item.server_id.clone(),
                    client: target.client,
                    scope: target.scope,
                    workspace_id: target.workspace_id.clone(),
                };
                if let Some(override_row) = &item.row_override {
                    match override_row {
                        Some(row) => save_row(connection, row)?,
                        None => delete_row(connection, &key)?,
                    }
                    continue;
                }
                let mut row = all_rows
                    .iter()
                    .find(|row| row.key == key)
                    .cloned()
                    .unwrap_or_else(|| ClientRow::new(key.clone()));
                if let Some(desired) = item.desired_enabled {
                    row.enabled = desired;
                }
                if let Some(consent) = item.consent {
                    row.inline_consent = consent;
                }
                if item.op.is_none() {
                    // The file already holds the desired state.
                    row.last_error_code.clear();
                    row.last_error_message.clear();
                }
                row.last_operation_id = operation_id.clone();
                save_row(connection, &row)?;
            }
        }
        if let Some(restore) = &plan.undo_restore {
            for (key, before) in &restore.rows_before {
                match before {
                    Some(row) => save_row(connection, row)?,
                    None => delete_row(connection, key)?,
                }
            }
        }
        Ok(())
    })();
    match library {
        Ok(()) => connection.execute_batch("COMMIT").map_err(db_error)?,
        Err(error) => {
            let _ = connection.execute_batch("ROLLBACK");
            update_operation(connection, &operation_id, "failed", &summary, &[], None)?;
            return Err(error);
        }
    }

    // 6. One transaction per client file, sequentially; failures stay local.
    let mut results = plan.skipped.clone();
    let mut snapshot_ids = Vec::new();
    let mut any_written = false;
    let mut file_targets = 0usize;
    let mut failed_targets = 0usize;
    let undo_kind = matches!(plan.kind, "undo" | "rollback");
    for (index, target) in plan.targets.iter().enumerate() {
        if !target.conflicts.is_empty() {
            summary.failed_client_ids.push(target.client);
            results.push(McpClientResult {
                client_id: target.client,
                scope: target.scope,
                project_label: target.project_label.clone(),
                server_ids: Vec::new(),
                status: "failed".to_string(),
                skipped_reason: None,
                error: Some(
                    McpError::new(
                        "undo-conflict",
                        format!(
                            "{} 里的 {} 之后又被改过，没有撤销这一项。",
                            target.client.label(),
                            target.conflicts.join("、")
                        ),
                    )
                    .with_client(target.client)
                    .param("server", target.conflicts.join("、")),
                ),
                restart_hint: false,
            });
        }
        if let Some(snapshot_id) = &target.restore_snapshot {
            if let Ok(true) = engine::restore_snapshot_if_unchanged(&ctx.mutation, snapshot_id) {
                // Byte-identical undo (M0-3).
                file_targets += 1;
                any_written = true;
                mark_client_written(target.client);
                let before = match &dry_runs[index] {
                    Some(Ok(view)) => view.before.clone(),
                    _ => Vec::new(),
                };
                let reread = resolve_read(ctx, target.client, target.scope, &target.workspace_id);
                for item in &target.items {
                    let previous = lookup(&before, &item.server_name);
                    let now = reread
                        .as_ref()
                        .and_then(|read| read.entry(&item.server_name));
                    if !engine::nodes_equivalent(previous, now) {
                        blob.entries.push(UndoEntry {
                            client: target.client,
                            scope: target.scope,
                            workspace_id: target.workspace_id.clone(),
                            name: item.server_name.clone(),
                            before: previous.map(Node::to_compact_string),
                            after: now.map(Node::to_compact_string),
                        });
                    }
                }
                blob.targets.push(UndoTarget {
                    client: target.client,
                    scope: target.scope,
                    workspace_id: target.workspace_id.clone(),
                    snapshot_id: None,
                    applied_sha256: reread.map(|read| read.sha256).unwrap_or_default(),
                });
                results.push(McpClientResult {
                    client_id: target.client,
                    scope: target.scope,
                    project_label: target.project_label.clone(),
                    server_ids: target
                        .items
                        .iter()
                        .map(|item| item.server_id.clone())
                        .collect(),
                    status: "undone".to_string(),
                    skipped_reason: None,
                    error: None,
                    restart_hint: target.client.restart_hint(),
                });
                continue;
            }
        }
        let changes = entry_changes(target);
        if changes.is_empty() && !target.conflicts.is_empty() {
            continue;
        }
        let server_ids = target
            .items
            .iter()
            .map(|item| item.server_id.clone())
            .collect::<Vec<_>>();
        let mut result = McpClientResult {
            client_id: target.client,
            scope: target.scope,
            project_label: target.project_label.clone(),
            server_ids,
            status: "unchanged".to_string(),
            skipped_reason: None,
            error: None,
            restart_hint: false,
        };
        if changes.is_empty() {
            results.push(result);
            continue;
        }
        file_targets += 1;
        let first_before = match &dry_runs[index] {
            Some(Ok(view)) => view.before.clone(),
            _ => Vec::new(),
        };
        let applied = match &dry_runs[index] {
            Some(Err(error)) => Err(error.clone()),
            _ => apply_target_with_retry(ctx, changes, &operation_id, index, &first_before),
        };
        match applied {
            Ok(outcome) => {
                if outcome.changed {
                    any_written = true;
                    mark_client_written(target.client);
                    result.status = if undo_kind { "undone" } else { "written" }.to_string();
                    result.restart_hint = target.client.restart_hint();
                }
                if let Some(snapshot_id) = &outcome.snapshot_id {
                    snapshot_ids.push(snapshot_id.clone());
                }
                blob.targets.push(UndoTarget {
                    client: target.client,
                    scope: target.scope,
                    workspace_id: target.workspace_id.clone(),
                    snapshot_id: outcome.snapshot_id.clone(),
                    applied_sha256: outcome.applied_sha256.clone(),
                });
                for item in target.items.iter().filter(|item| item.op.is_some()) {
                    let before = lookup(&outcome.before, &item.server_name);
                    let after = lookup(&outcome.after, &item.server_name);
                    if !engine::nodes_equivalent(before, after) {
                        blob.entries.push(UndoEntry {
                            client: target.client,
                            scope: target.scope,
                            workspace_id: target.workspace_id.clone(),
                            name: item.server_name.clone(),
                            before: before.map(Node::to_compact_string),
                            after: after.map(Node::to_compact_string),
                        });
                    }
                    let key_row = RowKey {
                        server_id: item.server_id.clone(),
                        client: target.client,
                        scope: target.scope,
                        workspace_id: target.workspace_id.clone(),
                    };
                    if item.row_override.is_some() {
                        // Undo restores the exact earlier row.
                        continue;
                    }
                    let mut row = load_rows(connection)?
                        .into_iter()
                        .find(|row| row.key == key_row)
                        .unwrap_or_else(|| ClientRow::new(key_row.clone()));
                    let hash = after
                        .map(|node| entry_hash(&key, target.client, node))
                        .unwrap_or_default();
                    row.last_written_hash = hash.clone();
                    row.last_seen_hash = hash;
                    row.last_error_code.clear();
                    row.last_error_message.clear();
                    row.last_operation_id = operation_id.clone();
                    save_row(connection, &row)?;
                }
            }
            Err(message) => {
                failed_targets += 1;
                let error = classify_engine_error(&message).with_client(target.client);
                summary.failed_client_ids.push(target.client);
                for item in &target.items {
                    if item.row_override.is_some() {
                        continue;
                    }
                    let key_row = RowKey {
                        server_id: item.server_id.clone(),
                        client: target.client,
                        scope: target.scope,
                        workspace_id: target.workspace_id.clone(),
                    };
                    if let Some(mut row) = load_rows(connection)?
                        .into_iter()
                        .find(|row| row.key == key_row)
                    {
                        row.last_error_code = error.code.clone();
                        row.last_error_message = error.message.clone();
                        row.last_operation_id = operation_id.clone();
                        save_row(connection, &row)?;
                    }
                }
                result.status = "failed".to_string();
                result.error = Some(error);
            }
        }
        results.push(result);
    }

    let state = if file_targets > 0 && failed_targets == file_targets && !any_written {
        if plan.servers_after.is_empty() && plan.env_ops.is_empty() {
            "failed"
        } else {
            "partial"
        }
    } else if failed_targets > 0 {
        "partial"
    } else {
        "applied"
    };
    let undo_available = plan.undoable && state != "failed";
    update_operation(
        connection,
        &operation_id,
        state,
        &summary,
        &snapshot_ids,
        undo_available.then_some(&blob),
    )?;
    prune_operations(connection)?;
    let generation = bump_generation();
    Ok(McpWriteOutcome::Done {
        undo_token: undo_available.then(|| operation_id.clone()),
        operation_id,
        summary,
        results,
        generation,
    })
}

// ---------------------------------------------------------------------------
// Write entry point helpers
// ---------------------------------------------------------------------------

/// Runs inside every write command, under the locks: finish or park
/// interrupted transactions (never fatal) and mark crashed operations.
pub(crate) fn prepare_write(ctx: &McpLibraryContext) -> Result<(), McpError> {
    let _ = engine::recover_before_write(&ctx.mutation);
    let connection = open_db(ctx)?;
    mark_interrupted(&connection)
}

type LoadedState = (Connection, [u8; 32], Vec<ServerRecord>, Vec<ClientRow>);

fn load_state(ctx: &McpLibraryContext) -> Result<LoadedState, McpError> {
    let connection = open_db(ctx)?;
    let key = hash_key(ctx)?;
    let servers = load_servers(&connection, false)?;
    let rows = load_rows(&connection)?;
    Ok((connection, key, servers, rows))
}

fn find_server<'a>(servers: &'a [ServerRecord], id: &str) -> Result<&'a ServerRecord, McpError> {
    servers
        .iter()
        .find(|server| server.id == id && server.deleted_at.is_none())
        .ok_or_else(McpError::not_found)
}

fn env_needs_literal(item: &SpecEnv, client: ClientId) -> bool {
    match item.storage {
        SecretStorage::Literal => false,
        SecretStorage::Library => true,
        SecretStorage::UserEnv | SecretStorage::External => {
            !client.supports_references()
                || (client == ClientId::Codex && item.variable() != item.name)
        }
    }
}

fn header_needs_literal(header: &SpecHeader, client: ClientId) -> bool {
    match header.storage {
        SecretStorage::Literal => false,
        SecretStorage::Library => true,
        SecretStorage::UserEnv | SecretStorage::External => {
            header.env_var.is_none()
                || !client.supports_references()
                || (client == ClientId::Codex
                    && header.template == HeaderTemplate::Bearer
                    && !header.name.eq_ignore_ascii_case("authorization"))
        }
    }
}

/// Records consent to write literal secret values into `client`'s file.
fn grant_inline(spec: &mut McpServerSpec, client: ClientId) {
    for item in spec.env.iter_mut().filter(|item| item.secret) {
        if env_needs_literal(item, client) && !item.inline_clients.contains(&client) {
            item.inline_clients.push(client);
        }
    }
    for header in spec
        .headers
        .iter_mut()
        .filter(|header| header.template != HeaderTemplate::Literal)
    {
        if header_needs_literal(header, client) && !header.inline_clients.contains(&client) {
            header.inline_clients.push(client);
        }
    }
    let secret_url = spec.url.as_deref().is_some_and(url_has_secret);
    if (spec.args.iter().any(|arg| arg.secret) || secret_url)
        && !spec.secret_arg_clients.contains(&client)
    {
        spec.secret_arg_clients.push(client);
    }
}

enum CellDecision {
    Item(Box<PlanItem>),
    Skip(&'static str),
    Noop,
}

/// Decides how to reach the desired state of one cell. `working` is the
/// server as it will be saved (stashes and consent are recorded on it).
#[allow(clippy::too_many_arguments)]
fn decide_cell(
    ctx: &McpLibraryContext,
    key: &[u8; 32],
    working: &mut ServerRecord,
    entry: Option<&Node>,
    client: ClientId,
    row: Option<&ClientRow>,
    enabled: bool,
    allow_inline: bool,
) -> CellDecision {
    let row_enabled = row.is_some_and(|row| row.enabled);
    let has_error = row.is_some_and(|row| !row.last_error_code.is_empty());
    let written = row
        .map(|row| row.last_written_hash.clone())
        .unwrap_or_default();
    let item = |op: Option<EntryOp>, action: ItemAction, confirm: Option<&'static str>| {
        Box::new(PlanItem {
            server_id: working.id.clone(),
            server_name: working.name.clone(),
            action,
            op,
            desired_enabled: Some(enabled),
            confirm,
            consent: None,
            confirm_also: None,
            row_override: None,
        })
    };
    if enabled {
        let mut confirm = None;
        let mut changed_outside = false;
        let mut consent = None;
        let projected = match project(ctx, &working.name, &working.spec, client) {
            Ok(projected) => projected,
            Err(ProjectError::Unsupported(reason)) => return CellDecision::Skip(reason),
            Err(ProjectError::Blocked("needs-inline-consent")) => {
                let mut granted = working.spec.clone();
                grant_inline(&mut granted, client);
                match project(ctx, &working.name, &granted, client) {
                    Ok(projected) => {
                        if !allow_inline {
                            confirm = Some("inline-secret");
                        }
                        working.spec = granted;
                        consent = Some(true);
                        projected
                    }
                    Err(ProjectError::Blocked(reason) | ProjectError::Unsupported(reason)) => {
                        return CellDecision::Skip(reason)
                    }
                }
            }
            Err(ProjectError::Blocked(reason)) => return CellDecision::Skip(reason),
        };
        let mut projected = projected;
        if client == ClientId::Codex {
            projected.codex_enabled = Some(true);
        }
        let wanted = projected_node(client, &projected, entry);
        if let Some(file) = entry {
            let disabled = client == ClientId::Codex && codex_disabled(file);
            let file_hash = entry_hash(key, client, file);
            if !disabled && file_hash == entry_hash(key, client, &wanted) {
                if row_enabled && !has_error && consent.is_none() {
                    return CellDecision::Noop;
                }
                let mut decided = item(None, ItemAction::Enable, None);
                decided.consent = consent;
                return CellDecision::Item(decided);
            }
            if file_hash != written
                && !semantic_equal(client, file, &wanted)
                && !(disabled
                    && canonical_entry(client, file, true)
                        == canonical_entry(client, &wanted, true))
            {
                // Overwriting an entry edited outside SkillHub is always
                // confirmed, also when inline consent is asked at the same
                // time (I6): both reasons appear in one dialog.
                changed_outside = true;
            }
        }
        let mut decided = item(
            Some(EntryOp::Upsert(projected)),
            ItemAction::Enable,
            if changed_outside {
                Some("changed-outside")
            } else {
                confirm
            },
        );
        if changed_outside {
            decided.confirm_also = confirm;
        }
        decided.consent = consent;
        CellDecision::Item(decided)
    } else {
        let present = entry.filter(|file| !(client == ClientId::Codex && codex_disabled(file)));
        let Some(file) = present else {
            if row_enabled || has_error {
                return CellDecision::Item(item(None, ItemAction::Disable, None));
            }
            return CellDecision::Noop;
        };
        if client == ClientId::Codex {
            return CellDecision::Item(item(
                Some(EntryOp::SetCodexEnabled(false)),
                ItemAction::Disable,
                None,
            ));
        }
        let file_hash = entry_hash(key, client, file);
        let confirm = if file_hash == written {
            None
        } else {
            match project(ctx, &working.name, &working.spec, client) {
                Ok(projected) => {
                    let wanted = projected_node(client, &projected, Some(file));
                    (file_hash != entry_hash(key, client, &wanted)
                        && !semantic_equal(client, file, &wanted))
                    .then_some("changed-outside")
                }
                Err(_) => (!written.is_empty()).then_some("changed-outside"),
            }
        };
        // The library keeps the full entry, so re-enabling restores it field
        // for field (M0-5).
        working
            .spec
            .client_extra
            .insert(client.as_str().to_string(), file.to_compact_string());
        CellDecision::Item(item(Some(EntryOp::Remove), ItemAction::Disable, confirm))
    }
}

fn push_decision(
    plan: &mut WritePlan,
    decision: CellDecision,
    client: ClientId,
    scope: Scope,
    workspace_id: &str,
    project_label: Option<String>,
    server_id: &str,
) {
    match decision {
        CellDecision::Item(item) => plan
            .target_mut(client, scope, workspace_id, project_label)
            .items
            .push(*item),
        CellDecision::Skip(reason) => plan.skip(client, scope, server_id, reason),
        CellDecision::Noop => {}
    }
}

fn save_working_if_changed(plan: &mut WritePlan, original: &ServerRecord, working: ServerRecord) {
    if working.spec != original.spec
        || working.display_name != original.display_name
        || working.source != original.source
        || working.spec_revision != original.spec_revision
    {
        let mut working = working;
        working.updated_at = ns_text(now_ns());
        plan.servers_after.push(working);
    }
}

// ---------------------------------------------------------------------------
// Cells, rows and columns (M0-2, M0-3, M0-5)
// ---------------------------------------------------------------------------

pub(crate) fn set_cell(
    ctx: &McpLibraryContext,
    request: McpSetCellRequest,
) -> Result<McpWriteOutcome, McpError> {
    let (connection, key, servers, rows) = load_state(ctx)?;
    let server = find_server(&servers, &request.server_id)?;
    let state = client_state(ctx, Some(&connection), request.client_id);
    let mut plan = WritePlan::new(if request.enabled { "enable" } else { "disable" });
    plan.note_server(&server.name);
    if !state.writable {
        return Ok(McpWriteOutcome::noop("nothing-selected"));
    }
    if request.client_id == ClientId::Codex
        && state
            .read
            .structured_env
            .iter()
            .any(|name| name == &server.name)
    {
        return Ok(McpWriteOutcome::noop("nothing-selected"));
    }
    let mut working = server.clone();
    let decision = decide_cell(
        ctx,
        &key,
        &mut working,
        state.entry(&server.name),
        request.client_id,
        find_row(&rows, &server.id, request.client_id),
        request.enabled,
        request.allow_inline == Some(true),
    );
    match decision {
        CellDecision::Noop => return Ok(McpWriteOutcome::noop("already-in-state")),
        CellDecision::Skip(_) => return Ok(McpWriteOutcome::noop("nothing-selected")),
        decision => push_decision(
            &mut plan,
            decision,
            request.client_id,
            Scope::User,
            "",
            None,
            &server.id,
        ),
    }
    save_working_if_changed(&mut plan, server, working);
    let digest = request_digest(&request);
    execute_plan(
        ctx,
        &connection,
        plan,
        request.confirm_token.as_deref(),
        &digest,
    )
}

pub(crate) fn set_row(
    ctx: &McpLibraryContext,
    request: McpSetRowRequest,
) -> Result<McpWriteOutcome, McpError> {
    let (connection, key, servers, rows) = load_state(ctx)?;
    let server = find_server(&servers, &request.server_id)?;
    let states = client_states(ctx, Some(&connection));
    let mut plan = WritePlan::new(if request.enabled { "enable" } else { "disable" });
    plan.note_server(&server.name);
    let mut working = server.clone();
    for state in &states {
        let selected = match &request.client_ids {
            Some(ids) => ids.contains(&state.client),
            None => state.detected && state.writable,
        };
        if !selected {
            continue;
        }
        if !state.writable {
            plan.skip(
                state.client,
                Scope::User,
                &server.id,
                state.readonly_reason.unwrap_or("config-unreadable"),
            );
            continue;
        }
        if state.client == ClientId::Codex
            && state
                .read
                .structured_env
                .iter()
                .any(|name| name == &server.name)
        {
            plan.skip(
                state.client,
                Scope::User,
                &server.id,
                "codex-structured-env",
            );
            continue;
        }
        let decision = decide_cell(
            ctx,
            &key,
            &mut working,
            state.entry(&server.name),
            state.client,
            find_row(&rows, &server.id, state.client),
            request.enabled,
            false,
        );
        push_decision(
            &mut plan,
            decision,
            state.client,
            Scope::User,
            "",
            None,
            &server.id,
        );
    }
    save_working_if_changed(&mut plan, server, working);
    let digest = request_digest(&request);
    execute_plan(
        ctx,
        &connection,
        plan,
        request.confirm_token.as_deref(),
        &digest,
    )
}

pub(crate) fn set_column(
    ctx: &McpLibraryContext,
    request: McpSetColumnRequest,
) -> Result<McpWriteOutcome, McpError> {
    let (connection, key, servers, rows) = load_state(ctx)?;
    let state = client_state(ctx, Some(&connection), request.client_id);
    let mut plan = WritePlan::new(if request.enabled { "enable" } else { "disable" });
    if !state.writable {
        return Ok(McpWriteOutcome::noop("nothing-selected"));
    }
    for server in &servers {
        if let Some(ids) = &request.server_ids {
            if !ids.contains(&server.id) {
                continue;
            }
        }
        if state.client == ClientId::Codex
            && state
                .read
                .structured_env
                .iter()
                .any(|name| name == &server.name)
        {
            continue;
        }
        let row = find_row(&rows, &server.id, state.client);
        let cell = compute_cell(
            ctx,
            &key,
            CellInput {
                state: &state,
                server,
                row,
                project_count: 0,
            },
        );
        // "启用其余 N 个" touches the cells that are off; "全部关闭" the ones on.
        let eligible = if request.enabled {
            matches!(cell.state.as_str(), "off" | "error")
        } else {
            matches!(cell.state.as_str(), "on" | "error")
        };
        if !eligible {
            continue;
        }
        let mut working = server.clone();
        let decision = decide_cell(
            ctx,
            &key,
            &mut working,
            state.entry(&server.name),
            state.client,
            row,
            request.enabled,
            false,
        );
        if matches!(decision, CellDecision::Item(_)) {
            plan.note_server(&server.name);
        }
        push_decision(
            &mut plan,
            decision,
            state.client,
            Scope::User,
            "",
            None,
            &server.id,
        );
        save_working_if_changed(&mut plan, server, working);
    }
    if plan.targets.is_empty() && plan.servers_after.is_empty() {
        return Ok(McpWriteOutcome::noop(if plan.skipped.is_empty() {
            "already-in-state"
        } else {
            "nothing-selected"
        }));
    }
    let digest = request_digest(&request);
    execute_plan(
        ctx,
        &connection,
        plan,
        request.confirm_token.as_deref(),
        &digest,
    )
}

// ---------------------------------------------------------------------------
// Input → spec (add, update): validation, secrets, prefill-safe edits
// ---------------------------------------------------------------------------

struct SpecBuild {
    spec: McpServerSpec,
    env_ops: Vec<EnvOp>,
    env_created: Vec<String>,
    kinds: Vec<&'static str>,
    env_confirm: Vec<McpEnvVarConfirmation>,
    env_var_names: Vec<String>,
}

fn invalid_text(value: &str, max: usize) -> bool {
    value.is_empty() || value.chars().count() > max || value.chars().any(char::is_control)
}

fn secret_error(code: &'static str, name: &str) -> McpError {
    let message = match code {
        "secret-name-reserved" => format!("{name} 是系统变量名，不能用来保存密钥。"),
        "secret-value-invalid" => {
            "密钥值无效：不能为空、不能含换行，最长 8192 个字符。".to_string()
        }
        _ => format!("{name} 不是有效的变量名。"),
    };
    McpError::new(code, message).param("name", name)
}

fn derived_variable(server_name: &str, header: &str, bearer: bool) -> String {
    let base = server_name
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() {
                ch.to_ascii_uppercase()
            } else {
                '_'
            }
        })
        .collect::<String>();
    let suffix = if bearer && header.eq_ignore_ascii_case("authorization") {
        "TOKEN".to_string()
    } else {
        header
            .chars()
            .map(|ch| {
                if ch.is_ascii_alphanumeric() {
                    ch.to_ascii_uppercase()
                } else {
                    '_'
                }
            })
            .collect()
    };
    let name = format!("{base}_{suffix}");
    if name.starts_with(|ch: char| ch.is_ascii_digit()) {
        format!("MCP_{name}")
    } else {
        name
    }
}

#[allow(clippy::too_many_arguments)]
fn spec_from_input(
    ctx: &McpLibraryContext,
    connection: &Connection,
    input: &McpServerInput,
    existing: Option<&ServerRecord>,
    paste_handle: Option<&str>,
    target_clients: &[ClientId],
) -> Result<SpecBuild, McpError> {
    let old = existing.map(|server| &server.spec);
    let mut spec = McpServerSpec::empty(input.transport);
    if let Some(old) = old {
        spec.client_extra = old.client_extra.clone();
        spec.secret_arg_clients = old.secret_arg_clients.clone();
    }
    // Prefill-safe edits (M1-7): a field the request omits keeps its stored
    // value; an explicit empty value clears it.
    spec.codex_required = input
        .codex_required
        .or(old.map(|old| old.codex_required))
        .unwrap_or(false);
    let old_stdio = old.filter(|old| old.transport == Transport::Stdio);
    let old_remote = old.filter(|old| old.transport != Transport::Stdio);
    let mut build = SpecBuild {
        spec: McpServerSpec::empty(input.transport),
        env_ops: Vec::new(),
        env_created: Vec::new(),
        kinds: Vec::new(),
        env_confirm: Vec::new(),
        env_var_names: Vec::new(),
    };
    match input.transport {
        Transport::Stdio => {
            let command = input
                .command
                .as_deref()
                .map(str::trim)
                .filter(|command| !command.is_empty())
                .ok_or_else(|| McpError::invalid("本地命令方式需要填写命令。"))?;
            if engine::command_stem(command) == "cmd" {
                return Err(McpError::invalid(
                    "命令里不需要写 cmd。Windows 上需要的 cmd /c 会自动加上。",
                ));
            }
            engine::validate_command(command).map_err(|_| {
                McpError::invalid("命令无效：请只填写一个可执行程序，参数逐项填写。")
            })?;
            let args = match (&input.args, old_stdio) {
                (Some(args), _) => args.clone(),
                (None, Some(old)) => old
                    .args
                    .iter()
                    .map(|arg| {
                        if arg.secret {
                            SECRET_MASK.to_string()
                        } else {
                            arg.value.clone()
                        }
                    })
                    .collect(),
                (None, None) => Vec::new(),
            };
            if args.len() > mcp_paste::MAX_ARGS {
                return Err(McpError::invalid("参数最多 64 个。"));
            }
            let old_args = old.map(|old| old.args.as_slice()).unwrap_or(&[]);
            let mut new_args = Vec::with_capacity(args.len());
            let mut plain = Vec::new();
            for (index, value) in args.iter().enumerate() {
                if value == SECRET_MASK {
                    // A masked argument keeps its stored value as is.
                    let kept = old_args
                        .get(index)
                        .cloned()
                        .ok_or_else(|| McpError::invalid("被隐藏的参数已经变化，请重新填写。"))?;
                    new_args.push(kept);
                } else if let Some(stored) =
                    old_args.get(index).filter(|stored| &stored.value == value)
                {
                    // Unchanged stored arguments (e.g. an imported flag before
                    // a masked value) are kept as they are.
                    new_args.push(stored.clone());
                } else {
                    plain.push(value.clone());
                    new_args.push(SpecArg {
                        value: value.clone(),
                        secret: false,
                    });
                }
            }
            engine::validate_arguments(&plain).map_err(|_| {
                McpError::invalid("参数里像是包含密钥；请删掉它，改用下面的 API Key 字段。")
            })?;
            spec.command = Some(command.to_string());
            spec.args = new_args;
            let cwd = match &input.cwd {
                Some(cwd) => Some(cwd.trim().to_string()).filter(|cwd| !cwd.is_empty()),
                None => old_stdio.and_then(|old| old.cwd.clone()),
            };
            if let Some(cwd) = cwd {
                if invalid_text(&cwd, 1024) || !Path::new(&cwd).is_absolute() {
                    return Err(McpError::invalid("工作目录需要是完整的文件夹路径。"));
                }
                spec.cwd = Some(cwd);
            }
            let literal_env = match (&input.env, old_stdio) {
                (Some(env), _) => env.clone(),
                (None, Some(old)) => old
                    .env
                    .iter()
                    .filter(|item| !item.secret)
                    .map(|item| McpNameValueInput {
                        name: item.name.clone(),
                        value: item.value.clone().unwrap_or_default(),
                    })
                    .collect(),
                (None, None) => Vec::new(),
            };
            for item in literal_env {
                mcp_secrets::validate_env_name(&item.name).map_err(|_| {
                    McpError::invalid(format!("{} 不是有效的环境变量名。", item.name))
                })?;
                if item.value.chars().count() > 8192 || item.value.contains(['\0', '\r', '\n']) {
                    return Err(McpError::invalid(format!("{} 的值无效。", item.name)));
                }
                if engine::has_common_secret_prefix(&item.value) {
                    return Err(McpError::invalid(format!(
                        "{} 的值像是密钥；请把它填到 API Key 里。",
                        item.name
                    )));
                }
                if spec
                    .env
                    .iter()
                    .any(|existing| existing.name.eq_ignore_ascii_case(&item.name))
                {
                    return Err(McpError::invalid(format!("{} 重复了。", item.name)));
                }
                spec.env.push(SpecEnv {
                    name: item.name.clone(),
                    secret: false,
                    storage: SecretStorage::Literal,
                    env_var: None,
                    value: Some(item.value.clone()),
                    inline_clients: Vec::new(),
                    required: false,
                });
            }
        }
        Transport::Http | Transport::Sse => {
            let url = input
                .url
                .as_deref()
                .map(str::trim)
                .filter(|url| !url.is_empty())
                .ok_or_else(|| McpError::invalid("远程地址方式需要填写网址。"))?;
            // An unchanged stored URL (sent back as is, or in the masked form
            // the edit drawer shows) keeps the stored value, even when an
            // imported URL carries a key in its query.
            let kept = old_remote
                .and_then(|old| old.url.as_deref())
                .filter(|stored| url == *stored || url == masked_url(stored));
            match kept {
                Some(stored) => spec.url = Some(stored.to_string()),
                None => {
                    engine::validate_safe_url(url).map_err(|_| {
                        McpError::invalid(
                            "网址需要以 https:// 或 http:// 开头，不能带 ? 参数、# 片段或账号密码。",
                        )
                    })?;
                    spec.url = Some(url.to_string());
                }
            }
        }
    }

    for secret in input.secrets.clone().unwrap_or_default() {
        let header = match secret.kind.as_str() {
            "env" => false,
            "header" => true,
            _ => return Err(McpError::invalid("密钥类型无效。")),
        };
        if header {
            if spec.transport == Transport::Stdio {
                continue; // Transport switch: headers do not apply.
            }
            engine::validate_header_name(&secret.name).map_err(|_| {
                McpError::invalid(format!("{} 不是有效的请求头名称。", secret.name))
            })?;
        } else {
            if spec.transport != Transport::Stdio {
                continue; // Transport switch: process env does not apply.
            }
            mcp_secrets::validate_env_name(&secret.name)
                .map_err(|code| secret_error(code, &secret.name))?;
        }
        let bearer = header && secret.header_template.as_deref() == Some("bearer");
        let template = if !header {
            HeaderTemplate::Raw
        } else if bearer {
            HeaderTemplate::Bearer
        } else {
            HeaderTemplate::Raw
        };
        let previous_env = old.and_then(|old| {
            old.env
                .iter()
                .find(|item| !header && item.secret && item.name.eq_ignore_ascii_case(&secret.name))
        });
        let previous_header = old.and_then(|old| {
            old.headers
                .iter()
                .find(|item| header && item.name.eq_ignore_ascii_case(&secret.name))
        });
        let pasted = match (&secret.paste_value_handle, paste_handle) {
            (Some(value_handle), Some(handle)) => {
                Some(mcp_paste::vault_get(handle, value_handle).ok_or_else(|| {
                    McpError::new("paste-expired", "粘贴的内容已过期，请重新粘贴。")
                })?)
            }
            (Some(_), None) => {
                return Err(McpError::new(
                    "paste-expired",
                    "粘贴的内容已过期，请重新粘贴。",
                ))
            }
            _ => None,
        };
        let value = match secret.value.clone().or(pasted) {
            Some(raw) => Some(
                mcp_secrets::normalize_secret_value(&raw)
                    .map_err(|code| secret_error(code, &secret.name))?,
            ),
            None => None,
        };
        let required = secret.required.unwrap_or(false);
        let inline_requested = secret.inline_clients.clone().unwrap_or_default();
        let previous_inline = previous_env
            .map(|item| item.inline_clients.clone())
            .or_else(|| previous_header.map(|item| item.inline_clients.clone()))
            .unwrap_or_default();
        let (storage, stored_value, variable, inline_clients) =
            match secret.mode.as_str() {
                "inline" => {
                    let value = match value.clone() {
                        Some(value) => Some(value),
                        None => previous_env
                            .and_then(|item| item.value.clone())
                            .or_else(|| previous_header.and_then(|item| item.value.clone())),
                    };
                    let value =
                        value.ok_or_else(|| secret_error("secret-value-invalid", &secret.name))?;
                    let clients = if inline_requested.is_empty() {
                        target_clients.to_vec()
                    } else {
                        inline_requested.clone()
                    };
                    if value_changed(previous_env, previous_header, &value)
                        || clients != previous_inline
                    {
                        build.kinds.push("inline-secret");
                    }
                    (SecretStorage::Library, Some(value), None, clients)
                }
                "user_env" => {
                    let variable = secret
                        .env_var
                        .clone()
                        .filter(|name| !name.trim().is_empty())
                        .or_else(|| previous_header.and_then(|item| item.env_var.clone()))
                        // Prefill-safe (M1-7): an env secret that references
                        // a differently named variable (`"KEY": "${OTHER}"`)
                        // keeps that reference when the edit omits envVar.
                        .or_else(|| previous_env.and_then(|item| item.env_var.clone()))
                        .unwrap_or_else(|| {
                            if header {
                                derived_variable(&input.name, &secret.name, bearer)
                            } else {
                                secret.name.clone()
                            }
                        });
                    // The variable lands in client files as `${NAME}` /
                    // `bearer_token_env_var`: it must be a valid name even
                    // when no value is saved now.
                    mcp_secrets::validate_env_name(&variable)
                        .map_err(|code| secret_error(code, &variable))?;
                    if !inline_requested.is_empty() && inline_requested != previous_inline {
                        build.kinds.push("inline-secret");
                    }
                    match value {
                        Some(value) => {
                            mcp_secrets::validate_secret_name(&variable)
                                .map_err(|code| secret_error(code, &variable))?;
                            let current = ctx.env.get(&variable).ok().flatten();
                            let created = env_var_created_by_skillhub(connection, &variable);
                            if current.as_deref() != Some(value.as_str()) {
                                if current.as_ref().is_some_and(|current| !current.is_empty())
                                    && created != Some(true)
                                {
                                    build.kinds.push("overwrite-env-var");
                                    build.env_confirm.push(McpEnvVarConfirmation {
                                        name: variable.clone(),
                                        exists: true,
                                        created_by_skillhub: false,
                                        action: "set".to_string(),
                                    });
                                }
                                if current.is_none() {
                                    build.env_created.push(variable.clone());
                                }
                                build.env_ops.push(EnvOp::Set {
                                    name: variable.clone(),
                                    value,
                                });
                            }
                            build.env_var_names.push(variable.clone());
                            (
                                SecretStorage::UserEnv,
                                None,
                                Some(variable),
                                inline_requested,
                            )
                        }
                        None => {
                            let previous_storage = previous_env
                                .map(|item| item.storage)
                                .or_else(|| previous_header.map(|item| item.storage));
                            match previous_storage {
                                // Omitted value keeps the stored value (§3.2).
                                Some(SecretStorage::Library) => (
                                    SecretStorage::Library,
                                    previous_env.and_then(|item| item.value.clone()).or_else(
                                        || previous_header.and_then(|item| item.value.clone()),
                                    ),
                                    None,
                                    if inline_requested.is_empty() {
                                        previous_inline.clone()
                                    } else {
                                        inline_requested
                                    },
                                ),
                                Some(storage) => (
                                    storage,
                                    None,
                                    Some(variable),
                                    if inline_requested.is_empty() {
                                        previous_inline.clone()
                                    } else {
                                        inline_requested
                                    },
                                ),
                                None => (
                                    SecretStorage::External,
                                    None,
                                    Some(variable),
                                    inline_requested,
                                ),
                            }
                        }
                    }
                }
                _ => return Err(McpError::invalid("密钥保存方式无效。")),
            };
        if header {
            if spec
                .headers
                .iter()
                .any(|item| item.name.eq_ignore_ascii_case(&secret.name))
            {
                return Err(McpError::invalid(format!("{} 重复了。", secret.name)));
            }
            spec.headers.push(SpecHeader {
                name: secret.name.clone(),
                template,
                env_var: variable,
                storage,
                value: stored_value,
                inline_clients,
                required,
            });
        } else {
            if spec
                .env
                .iter()
                .any(|item| item.name.eq_ignore_ascii_case(&secret.name))
            {
                return Err(McpError::invalid(format!("{} 重复了。", secret.name)));
            }
            let env_var = variable.filter(|name| name != &secret.name);
            if let Some(name) = &env_var {
                mcp_secrets::validate_env_name(name).map_err(|code| secret_error(code, name))?;
            }
            spec.env.push(SpecEnv {
                name: secret.name.clone(),
                secret: true,
                storage,
                env_var,
                value: stored_value,
                inline_clients,
                required,
            });
        }
    }
    if input.secrets.is_none() {
        // Secrets omitted entirely: keep the stored ones that still apply.
        if spec.transport == Transport::Stdio {
            if let Some(old) = old_stdio {
                spec.env
                    .extend(old.env.iter().filter(|item| item.secret).cloned());
            }
        } else if let Some(old) = old_remote {
            spec.headers = old.headers.clone();
        }
    } else if spec.transport != Transport::Stdio {
        // Literal (non-secret) headers are not part of `secrets`: keep them.
        if let Some(old) = old_remote {
            for header in old
                .headers
                .iter()
                .filter(|header| header.template == HeaderTemplate::Literal)
            {
                if !spec
                    .headers
                    .iter()
                    .any(|item| item.name.eq_ignore_ascii_case(&header.name))
                {
                    spec.headers.push(header.clone());
                }
            }
        }
    }
    if spec.env.len() > 64 || spec.headers.len() > 64 {
        return Err(McpError::invalid("环境变量或请求头最多 64 个。"));
    }
    build.kinds.dedup();
    build.spec = spec;
    Ok(build)
}

fn value_changed(env: Option<&SpecEnv>, header: Option<&SpecHeader>, value: &str) -> bool {
    let previous = env
        .and_then(|item| item.value.as_deref())
        .or_else(|| header.and_then(|item| item.value.as_deref()));
    previous != Some(value)
}

fn merge_build(plan: &mut WritePlan, build: &mut SpecBuild) {
    plan.env_ops.append(&mut build.env_ops);
    plan.env_created.append(&mut build.env_created);
    for kind in build.kinds.drain(..) {
        plan.add_kind(kind);
    }
    plan.env_confirm.append(&mut build.env_confirm);
    for name in build.env_var_names.drain(..) {
        if !plan.env_var_names.contains(&name) {
            plan.env_var_names.push(name);
        }
    }
}

fn sanitize_display_name(value: Option<&str>) -> String {
    value
        .map(str::trim)
        .unwrap_or_default()
        .chars()
        .filter(|ch| !ch.is_control())
        .take(80)
        .collect()
}

/// Where an add or edit lands for one client (user scope, or a registered
/// workspace under 高级).
struct PlacementTarget {
    scope: Scope,
    workspace_id: String,
    label: Option<String>,
    writable: bool,
    reason: Option<&'static str>,
    read: TargetRead,
}

fn placement_target(
    ctx: &McpLibraryContext,
    states: &[ClientState],
    client: ClientId,
    placement: Option<&McpPlacement>,
) -> PlacementTarget {
    let scope = placement
        .map(|placement| placement.scope)
        .unwrap_or(Scope::User);
    if scope == Scope::User {
        let state = states
            .iter()
            .find(|state| state.client == client)
            .expect("all clients have a state");
        return PlacementTarget {
            scope,
            workspace_id: String::new(),
            label: None,
            writable: state.writable,
            reason: state.readonly_reason,
            read: state.read.clone(),
        };
    }
    let workspace_id = placement
        .and_then(|placement| placement.workspace_id.clone())
        .unwrap_or_default();
    let workspace = ctx
        .mutation
        .registered_workspaces
        .iter()
        .find(|workspace| workspace.id == workspace_id);
    let supported = matches!(
        (client, scope),
        (ClientId::Codex, Scope::Project)
            | (ClientId::ClaudeCode, Scope::Local)
            | (ClientId::ClaudeCode, Scope::Project)
    );
    let Some(workspace) = workspace.filter(|_| supported) else {
        return PlacementTarget {
            scope,
            workspace_id,
            label: None,
            writable: false,
            reason: Some(if supported {
                "not-registered"
            } else {
                "transport-unsupported"
            }),
            read: empty_read(),
        };
    };
    let label = Some(engine::safe_label(&workspace.display_name));
    match engine::resolve_target(
        &ctx.mutation,
        client.host_id(),
        scope.as_str(),
        Some(&workspace.id),
    ) {
        Ok(target) => {
            let read = engine::read_target_entries(&target);
            let reason = read_status_reason(read.status);
            PlacementTarget {
                scope,
                workspace_id,
                label,
                writable: reason.is_none(),
                reason,
                read,
            }
        }
        Err(_) => PlacementTarget {
            scope,
            workspace_id,
            label,
            writable: false,
            reason: Some("config-unreadable"),
            read: empty_read(),
        },
    }
}

fn find_row_scoped<'a>(
    rows: &'a [ClientRow],
    server_id: &str,
    client: ClientId,
    scope: Scope,
    workspace_id: &str,
) -> Option<&'a ClientRow> {
    rows.iter().find(|row| {
        row.key.server_id == server_id
            && row.key.client == client
            && row.key.scope == scope
            && row.key.workspace_id == workspace_id
    })
}

// ---------------------------------------------------------------------------
// Add (M0-6, M0-7) and update (M1-7)
// ---------------------------------------------------------------------------

pub(crate) fn add_servers(
    ctx: &McpLibraryContext,
    request: McpAddRequest,
) -> Result<McpWriteOutcome, McpError> {
    if request.candidates.is_empty() {
        return Ok(McpWriteOutcome::noop("nothing-selected"));
    }
    if request.candidates.len() > mcp_paste::MAX_CANDIDATES {
        return Err(McpError::invalid("一次最多添加 24 个 MCP。"));
    }
    let connection = open_db(ctx)?;
    let key = hash_key(ctx)?;
    let all_servers = load_servers(&connection, true)?;
    let rows = load_rows(&connection)?;
    let states = client_states(ctx, Some(&connection));
    let mut plan = WritePlan::new("add");
    let mut seen_names = HashSet::new();
    for candidate in &request.candidates {
        let input = &candidate.input;
        if !mcp_paste::is_valid_library_name(&input.name) {
            return Err(McpError::new(
                "invalid-name",
                "名称只能用字母、数字、下划线或短横线，最长 64 个字符，并以字母或数字开头。",
            )
            .param("name", input.name.clone()));
        }
        let name_key = input.name.to_ascii_lowercase();
        if !seen_names.insert(name_key.clone()) {
            return Err(McpError::invalid(format!("{} 重复了。", input.name)));
        }
        let existing = all_servers.iter().find(|server| {
            server.name.to_ascii_lowercase() == name_key && server.deleted_at.is_none()
        });
        let overwrite = candidate.on_conflict.as_deref() == Some("overwrite");
        if let Some(existing) = existing {
            match candidate.on_conflict.as_deref() {
                Some("skip") => {
                    for client in &request.client_ids {
                        plan.skip(*client, Scope::User, &existing.id, "entry-added-outside");
                    }
                    continue;
                }
                Some("overwrite") => {}
                _ => {
                    return Err(McpError::new(
                        "name-taken",
                        format!("已经有一个叫 {} 的 MCP。", input.name),
                    )
                    .param("name", input.name.clone()))
                }
            }
        }
        if let Some(deleted) = all_servers.iter().find(|server| {
            server.name.to_ascii_lowercase() == name_key && server.deleted_at.is_some()
        }) {
            plan.servers_hard_deleted.push(deleted.id.clone());
        }
        let mut build = spec_from_input(
            ctx,
            &connection,
            input,
            existing.filter(|_| overwrite),
            request.paste_handle.as_deref(),
            &request.client_ids,
        )?;
        merge_build(&mut plan, &mut build);
        let now = ns_text(now_ns());
        let mut record = match existing {
            Some(existing) => ServerRecord {
                spec: build.spec,
                spec_revision: existing.spec_revision + 1,
                display_name: sanitize_display_name(input.display_name.as_deref()),
                source: input.source.clone(),
                updated_at: now.clone(),
                ..existing.clone()
            },
            None => ServerRecord {
                id: format!("mcps-{}", uuid::Uuid::new_v4().simple()),
                name: input.name.clone(),
                display_name: sanitize_display_name(input.display_name.as_deref()),
                spec: build.spec,
                spec_revision: 1,
                source: input.source.clone(),
                meta: json!({}),
                test: None,
                created_at: now.clone(),
                updated_at: now,
                deleted_at: None,
            },
        };
        plan.note_server(&record.name);
        // Projections see the environment values this add is about to set.
        let planning = ctx.with_pending_env(&plan.env_ops);
        for client in &request.client_ids {
            let place = placement_target(ctx, &states, *client, request.placement.as_ref());
            if !place.writable {
                plan.skip(
                    *client,
                    place.scope,
                    &record.id,
                    place.reason.unwrap_or("config-unreadable"),
                );
                continue;
            }
            if *client == ClientId::Codex && place.read.structured_env.contains(&record.name) {
                plan.skip(*client, place.scope, &record.id, "codex-structured-env");
                continue;
            }
            let entry = place.read.entry(&record.name);
            let row = find_row_scoped(&rows, &record.id, *client, place.scope, &place.workspace_id);
            let mut projected = match project(&planning, &record.name, &record.spec, *client) {
                Ok(projected) => projected,
                Err(ProjectError::Unsupported(reason) | ProjectError::Blocked(reason)) => {
                    plan.skip(*client, place.scope, &record.id, reason);
                    continue;
                }
            };
            if *client == ClientId::Codex {
                projected.codex_enabled = Some(true);
            }
            let wanted = projected_node(*client, &projected, entry);
            let mut confirm = None;
            if let Some(file) = entry {
                let file_hash = entry_hash(&key, *client, file);
                let same = file_hash == entry_hash(&key, *client, &wanted)
                    && !(*client == ClientId::Codex && codex_disabled(file));
                if same {
                    plan.target_mut(
                        *client,
                        place.scope,
                        &place.workspace_id,
                        place.label.clone(),
                    )
                    .items
                    .push(PlanItem {
                        server_id: record.id.clone(),
                        server_name: record.name.clone(),
                        action: ItemAction::Add,
                        op: None,
                        desired_enabled: Some(true),
                        confirm: None,
                        consent: Some(server_needs_inline(&record.spec, *client)),
                        confirm_also: None,
                        row_override: None,
                    });
                    continue;
                }
                let managed_by_us = row.is_some_and(|row| row.last_written_hash == file_hash);
                if !managed_by_us && !semantic_equal(*client, file, &wanted) {
                    match candidate.on_conflict.as_deref() {
                        Some("overwrite") => {}
                        Some("skip") => {
                            plan.skip(*client, place.scope, &record.id, "entry-added-outside");
                            continue;
                        }
                        _ => confirm = Some("overwrite-different"),
                    }
                }
            }
            plan.target_mut(
                *client,
                place.scope,
                &place.workspace_id,
                place.label.clone(),
            )
            .items
            .push(PlanItem {
                server_id: record.id.clone(),
                server_name: record.name.clone(),
                action: ItemAction::Add,
                op: Some(EntryOp::Upsert(projected)),
                desired_enabled: Some(true),
                confirm,
                consent: Some(server_needs_inline(&record.spec, *client)),
                confirm_also: None,
                row_override: None,
            });
        }
        if let Some(existing) = existing.filter(|_| overwrite) {
            // Overwriting keeps every other enabled AI 工具 in step.
            reproject_enabled(
                ctx,
                &key,
                &mut plan,
                existing,
                &record,
                &states,
                &rows,
                ItemAction::Update,
                "overwrite-different",
                &request.client_ids,
            );
        }
        record.updated_at = ns_text(now_ns());
        plan.servers_after.push(record);
    }
    let digest = request_digest(&request);
    let outcome = execute_plan(
        ctx,
        &connection,
        plan,
        request.confirm_token.as_deref(),
        &digest,
    )?;
    if matches!(outcome, McpWriteOutcome::Done { .. }) {
        if let Some(handle) = &request.paste_handle {
            mcp_paste::vault_clear(handle);
        }
    }
    Ok(outcome)
}

/// Re-projects one enabled cell after a spec change (update, secret, file
/// adoption). Unsupported after a transport switch: the entry is removed.
/// `planning` sees the environment values this write is about to set; `ctx`
/// is the state before it (used for the old projection).
#[allow(clippy::too_many_arguments)]
fn reproject_cell(
    ctx: &McpLibraryContext,
    planning: &McpLibraryContext,
    key: &[u8; 32],
    plan: &mut WritePlan,
    old: &ServerRecord,
    new: &ServerRecord,
    client: ClientId,
    scope: Scope,
    workspace_id: &str,
    label: Option<String>,
    entry: Option<&Node>,
    row: &ClientRow,
    action: ItemAction,
    confirm_kind: &'static str,
) {
    match project(planning, &new.name, &new.spec, client) {
        Ok(mut projected) => {
            if client == ClientId::Codex {
                projected.codex_enabled = Some(true);
            }
            let wanted = projected_node(client, &projected, entry);
            if entry.is_some_and(|file| {
                entry_hash(key, client, file) == entry_hash(key, client, &wanted)
                    && !(client == ClientId::Codex && codex_disabled(file))
            }) {
                return;
            }
            let confirm = entry.and_then(|file| {
                let file_hash = entry_hash(key, client, file);
                if file_hash == row.last_written_hash {
                    return None;
                }
                let expected_old = project(ctx, &old.name, &old.spec, client)
                    .ok()
                    .map(|projected| projected_node(client, &projected, Some(file)));
                let matches_old = expected_old.is_some_and(|old_entry| {
                    file_hash == entry_hash(key, client, &old_entry)
                        || semantic_equal(client, file, &old_entry)
                });
                (!matches_old).then_some(confirm_kind)
            });
            plan.target_mut(client, scope, workspace_id, label)
                .items
                .push(PlanItem {
                    server_id: new.id.clone(),
                    server_name: new.name.clone(),
                    action,
                    op: Some(EntryOp::Upsert(projected)),
                    desired_enabled: Some(true),
                    confirm,
                    consent: None,
                    confirm_also: None,
                    row_override: None,
                });
        }
        Err(ProjectError::Unsupported(reason)) => {
            if entry.is_some() && client.is_json() {
                plan.target_mut(client, scope, workspace_id, label)
                    .items
                    .push(PlanItem {
                        server_id: new.id.clone(),
                        server_name: new.name.clone(),
                        action: ItemAction::Remove,
                        op: Some(EntryOp::Remove),
                        desired_enabled: Some(false),
                        confirm: None,
                        consent: None,
                        confirm_also: None,
                        row_override: None,
                    });
            } else if client == ClientId::Codex && entry.is_some() {
                plan.target_mut(client, scope, workspace_id, label)
                    .items
                    .push(PlanItem {
                        server_id: new.id.clone(),
                        server_name: new.name.clone(),
                        action: ItemAction::Disable,
                        op: Some(EntryOp::SetCodexEnabled(false)),
                        desired_enabled: Some(false),
                        confirm: None,
                        consent: None,
                        confirm_also: None,
                        row_override: None,
                    });
            } else {
                plan.skip(client, scope, &new.id, reason);
            }
        }
        Err(ProjectError::Blocked(reason)) => plan.skip(client, scope, &new.id, reason),
    }
}

/// Re-projects every enabled cell (user scope and registered workspaces).
#[allow(clippy::too_many_arguments)]
fn reproject_enabled(
    ctx: &McpLibraryContext,
    key: &[u8; 32],
    plan: &mut WritePlan,
    old: &ServerRecord,
    new: &ServerRecord,
    states: &[ClientState],
    rows: &[ClientRow],
    action: ItemAction,
    confirm_kind: &'static str,
    skip_clients: &[ClientId],
) {
    // The new projection sees the environment values this write sets.
    let planning = ctx.with_pending_env(&plan.env_ops);
    let sources = project_sources(ctx);
    for row in rows
        .iter()
        .filter(|row| row.key.server_id == new.id && row.enabled)
    {
        if skip_clients.contains(&row.key.client) && row.key.scope == Scope::User {
            continue;
        }
        if row.key.scope == Scope::User {
            let state = states
                .iter()
                .find(|state| state.client == row.key.client)
                .expect("all clients have a state");
            if !state.writable {
                plan.skip(
                    state.client,
                    Scope::User,
                    &new.id,
                    state.readonly_reason.unwrap_or("config-unreadable"),
                );
                continue;
            }
            reproject_cell(
                ctx,
                &planning,
                key,
                plan,
                old,
                new,
                state.client,
                Scope::User,
                "",
                None,
                state.entry(&new.name),
                row,
                action,
                confirm_kind,
            );
        } else if let Some(source) = sources.iter().find(|source| {
            source.client == row.key.client
                && source.scope == row.key.scope
                && source.workspace_id.as_deref() == Some(row.key.workspace_id.as_str())
        }) {
            if !source.writable {
                continue;
            }
            reproject_cell(
                ctx,
                &planning,
                key,
                plan,
                old,
                new,
                source.client,
                source.scope,
                &row.key.workspace_id,
                Some(source.label.clone()),
                source.read.entry(&new.name),
                row,
                action,
                confirm_kind,
            );
        }
    }
}

pub(crate) fn update_server(
    ctx: &McpLibraryContext,
    request: McpUpdateRequest,
) -> Result<McpWriteOutcome, McpError> {
    let (connection, key, servers, rows) = load_state(ctx)?;
    let server = find_server(&servers, &request.server_id)?;
    if request.input.name != server.name {
        return Err(McpError::invalid(
            "名称是各工具配置里的键，不能修改。要改名，请新建再删除旧的。",
        ));
    }
    if request.expected_revision != server.spec_revision {
        return Err(McpError::new(
            "revision-conflict",
            "这个 MCP 刚被改过，已重新载入。",
        ));
    }
    let enabled_clients = rows
        .iter()
        .filter(|row| row.key.server_id == server.id && row.enabled)
        .map(|row| row.key.client)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    let mut build = spec_from_input(
        ctx,
        &connection,
        &request.input,
        Some(server),
        None,
        &enabled_clients,
    )?;
    let mut plan = WritePlan::new("update");
    merge_build(&mut plan, &mut build);
    plan.note_server(&server.name);
    let spec_changed = build.spec.without_extras() != server.spec.without_extras();
    let mut updated = ServerRecord {
        spec: build.spec,
        display_name: match request.input.display_name.as_deref() {
            Some(name) => sanitize_display_name(Some(name)),
            None => server.display_name.clone(),
        },
        ..server.clone()
    };
    if spec_changed {
        updated.spec_revision += 1;
    }
    if !spec_changed && updated.display_name == server.display_name && plan.env_ops.is_empty() {
        return Ok(McpWriteOutcome::noop("already-in-state"));
    }
    let states = client_states(ctx, Some(&connection));
    reproject_enabled(
        ctx,
        &key,
        &mut plan,
        server,
        &updated,
        &states,
        &rows,
        ItemAction::Update,
        "changed-outside",
        &[],
    );
    updated.updated_at = ns_text(now_ns());
    plan.servers_after.push(updated);
    let digest = request_digest(&request);
    execute_plan(
        ctx,
        &connection,
        plan,
        request.confirm_token.as_deref(),
        &digest,
    )
}

// ---------------------------------------------------------------------------
// Remove (always confirmed)
// ---------------------------------------------------------------------------

/// SkillHub-created variables this server references that no other server
/// uses.
fn unused_owned_variables(
    connection: &Connection,
    server: &ServerRecord,
    servers: &[ServerRecord],
) -> Vec<String> {
    let variables = |spec: &McpServerSpec| {
        let mut names = spec
            .env
            .iter()
            .filter(|item| item.storage == SecretStorage::UserEnv)
            .map(|item| item.variable().to_string())
            .collect::<Vec<_>>();
        names.extend(
            spec.headers
                .iter()
                .filter(|header| header.storage == SecretStorage::UserEnv)
                .filter_map(|header| header.env_var.clone()),
        );
        names
    };
    let others = servers
        .iter()
        .filter(|other| other.id != server.id && other.deleted_at.is_none())
        .flat_map(|other| variables(&other.spec))
        .map(|name| name.to_ascii_uppercase())
        .collect::<HashSet<_>>();
    let mut result = variables(&server.spec)
        .into_iter()
        .filter(|name| !others.contains(&name.to_ascii_uppercase()))
        .filter(|name| env_var_created_by_skillhub(connection, name) == Some(true))
        .collect::<Vec<_>>();
    result.sort();
    result.dedup();
    result
}

pub(crate) fn remove_server(
    ctx: &McpLibraryContext,
    request: McpRemoveRequest,
) -> Result<McpWriteOutcome, McpError> {
    let (connection, _key, servers, rows) = load_state(ctx)?;
    let server = find_server(&servers, &request.server_id)?;
    let mut plan = WritePlan::new("remove");
    plan.note_server(&server.name);
    match &request.from {
        McpRemoveFrom::Library => {
            plan.add_kind("remove-from-library");
            let states = client_states(ctx, Some(&connection));
            for state in states.iter().filter(|state| state.writable) {
                if state.entry(&server.name).is_none()
                    || (state.client == ClientId::Codex
                        && state.read.structured_env.contains(&server.name))
                {
                    continue;
                }
                plan.target_mut(state.client, Scope::User, "", None)
                    .items
                    .push(PlanItem {
                        server_id: server.id.clone(),
                        server_name: server.name.clone(),
                        action: ItemAction::Remove,
                        op: Some(EntryOp::Remove),
                        desired_enabled: Some(false),
                        confirm: None,
                        consent: None,
                        confirm_also: None,
                        row_override: None,
                    });
            }
            for source in project_sources(ctx)
                .into_iter()
                .filter(|source| source.writable)
            {
                if source.read.entry(&server.name).is_none() {
                    continue;
                }
                let workspace_id = source.workspace_id.clone().unwrap_or_default();
                plan.target_mut(
                    source.client,
                    source.scope,
                    &workspace_id,
                    Some(source.label.clone()),
                )
                .items
                .push(PlanItem {
                    server_id: server.id.clone(),
                    server_name: server.name.clone(),
                    action: ItemAction::Remove,
                    op: Some(EntryOp::Remove),
                    desired_enabled: Some(false),
                    confirm: None,
                    consent: None,
                    confirm_also: None,
                    row_override: None,
                });
            }
            let owned = unused_owned_variables(&connection, server, &servers);
            for name in &owned {
                plan.env_confirm.push(McpEnvVarConfirmation {
                    name: name.clone(),
                    exists: mcp_secrets::env_var_present(&*ctx.env, name),
                    created_by_skillhub: true,
                    action: "delete".to_string(),
                });
            }
            for name in request.delete_env_vars.clone().unwrap_or_default() {
                if !owned.iter().any(|owned| owned.eq_ignore_ascii_case(&name)) {
                    return Err(McpError::invalid(format!(
                        "{name} 不是 SkillHub 建的、或仍在被其他 MCP 使用，不能删除。"
                    )));
                }
                plan.env_ops.push(EnvOp::Delete { name: name.clone() });
                plan.env_var_names.push(name);
            }
            plan.servers_soft_deleted.push(server.id.clone());
            plan.rows_deleted.extend(
                rows.iter()
                    .filter(|row| row.key.server_id == server.id)
                    .map(|row| row.key.clone()),
            );
        }
        McpRemoveFrom::Client {
            client_id,
            scope,
            workspace_id,
        } => {
            plan.add_kind("remove-from-client");
            let scope = scope.unwrap_or(Scope::User);
            let placement = McpPlacement {
                scope,
                workspace_id: workspace_id.clone(),
            };
            let states = client_states(ctx, Some(&connection));
            let place = placement_target(ctx, &states, *client_id, Some(&placement));
            if !place.writable {
                return Err(McpError::new(
                    place.reason.unwrap_or("config-unreadable"),
                    format!("{} 的配置文件现在不能写入。", client_id.label()),
                )
                .with_client(*client_id));
            }
            if place.read.entry(&server.name).is_none() {
                return Ok(McpWriteOutcome::noop("already-in-state"));
            }
            plan.target_mut(
                *client_id,
                place.scope,
                &place.workspace_id,
                place.label.clone(),
            )
            .items
            .push(PlanItem {
                server_id: server.id.clone(),
                server_name: server.name.clone(),
                action: ItemAction::Remove,
                op: Some(EntryOp::Remove),
                desired_enabled: Some(false),
                confirm: None,
                consent: None,
                confirm_also: None,
                row_override: None,
            });
        }
    }
    // The "also delete the unused variable" boxes are ticked inside the
    // confirmation dialog, after the token was issued. The token already
    // binds the listed candidates (only those can be deleted), so the ticked
    // subset stays out of the digest: one confirmation, not two.
    let digest = request_digest(&McpRemoveRequest {
        server_id: request.server_id.clone(),
        from: request.from.clone(),
        delete_env_vars: None,
        confirm_token: None,
    });
    execute_plan(
        ctx,
        &connection,
        plan,
        request.confirm_token.as_deref(),
        &digest,
    )
}

// ---------------------------------------------------------------------------
// Secrets (M1-1)
// ---------------------------------------------------------------------------

pub(crate) fn set_secret(
    ctx: &McpLibraryContext,
    request: McpSetSecretRequest,
) -> Result<McpWriteOutcome, McpError> {
    let (connection, key, servers, rows) = load_state(ctx)?;
    let server = find_server(&servers, &request.server_id)?;
    let value = mcp_secrets::normalize_secret_value(&request.value)
        .map_err(|code| secret_error(code, &request.name))?;
    let mut updated = server.clone();
    let mut plan = WritePlan::new("secret");
    plan.note_server(&server.name);
    let enabled_clients = rows
        .iter()
        .filter(|row| row.key.server_id == server.id && row.enabled)
        .map(|row| row.key.client)
        .collect::<BTreeSet<_>>();
    let requested_inline = request.inline_clients.clone().unwrap_or_default();
    let env_index = updated
        .spec
        .env
        .iter()
        .position(|item| item.secret && item.name.eq_ignore_ascii_case(&request.name));
    let header_index = updated.spec.headers.iter().position(|header| {
        header.template != HeaderTemplate::Literal
            && header.name.eq_ignore_ascii_case(&request.name)
    });
    if env_index.is_none() && header_index.is_none() {
        return Err(McpError::not_found());
    }
    let (variable, previous_inline) = match (env_index, header_index) {
        (Some(index), _) => {
            let item = &updated.spec.env[index];
            (item.variable().to_string(), item.inline_clients.clone())
        }
        (None, Some(index)) => {
            let header = &updated.spec.headers[index];
            (
                header.env_var.clone().unwrap_or_else(|| {
                    derived_variable(
                        &server.name,
                        &header.name,
                        header.template == HeaderTemplate::Bearer,
                    )
                }),
                header.inline_clients.clone(),
            )
        }
        _ => unreachable!(),
    };
    let (storage, stored_value, inline_clients) = match request.mode.as_str() {
        "user_env" => {
            mcp_secrets::validate_secret_name(&variable)
                .map_err(|code| secret_error(code, &variable))?;
            let current = ctx.env.get(&variable).ok().flatten();
            let created = env_var_created_by_skillhub(&connection, &variable);
            if current.as_deref() != Some(value.as_str()) {
                if current.as_ref().is_some_and(|current| !current.is_empty())
                    && created != Some(true)
                {
                    plan.add_kind("overwrite-env-var");
                    plan.env_confirm.push(McpEnvVarConfirmation {
                        name: variable.clone(),
                        exists: true,
                        created_by_skillhub: false,
                        action: "set".to_string(),
                    });
                }
                if current.is_none() {
                    plan.env_created.push(variable.clone());
                }
                plan.env_ops.push(EnvOp::Set {
                    name: variable.clone(),
                    value,
                });
            }
            let inline = if request.inline_clients.is_some() {
                requested_inline.clone()
            } else {
                previous_inline.clone()
            };
            if inline
                .iter()
                .any(|client| !previous_inline.contains(client))
            {
                plan.add_kind("inline-secret");
            }
            (SecretStorage::UserEnv, None, inline)
        }
        "inline" => {
            plan.add_kind("inline-secret");
            let mut clients = enabled_clients.iter().copied().collect::<Vec<_>>();
            for client in requested_inline {
                if !clients.contains(&client) {
                    clients.push(client);
                }
            }
            (SecretStorage::Library, Some(value), clients)
        }
        _ => return Err(McpError::invalid("密钥保存方式无效。")),
    };
    plan.env_var_names.push(variable.clone());
    if let Some(index) = env_index {
        let item = &mut updated.spec.env[index];
        item.storage = storage;
        item.value = stored_value;
        item.env_var =
            (storage == SecretStorage::UserEnv && variable != item.name).then(|| variable.clone());
        item.inline_clients = inline_clients;
    } else if let Some(index) = header_index {
        let header = &mut updated.spec.headers[index];
        header.storage = storage;
        header.value = stored_value;
        header.env_var = (storage == SecretStorage::UserEnv).then(|| variable.clone());
        header.inline_clients = inline_clients;
    }
    updated.spec_revision += 1;
    let states = client_states(ctx, Some(&connection));
    reproject_enabled(
        ctx,
        &key,
        &mut plan,
        server,
        &updated,
        &states,
        &rows,
        ItemAction::Update,
        "changed-outside",
        &[],
    );
    updated.updated_at = ns_text(now_ns());
    plan.servers_after.push(updated);
    let digest = request_digest(&request);
    execute_plan(
        ctx,
        &connection,
        plan,
        request.confirm_token.as_deref(),
        &digest,
    )
}

// ---------------------------------------------------------------------------
// Resync and "changed outside" resolution (minimum M1-5 guard)
// ---------------------------------------------------------------------------

pub(crate) fn resync(
    ctx: &McpLibraryContext,
    request: McpResyncRequest,
) -> Result<McpWriteOutcome, McpError> {
    let (connection, key, servers, rows) = load_state(ctx)?;
    let states = client_states(ctx, Some(&connection));
    let mut plan = WritePlan::new("resync");
    for server in &servers {
        if request
            .server_ids
            .as_ref()
            .is_some_and(|ids| !ids.contains(&server.id))
        {
            continue;
        }
        let mut working = server.clone();
        for state in states.iter().filter(|state| state.writable) {
            if request
                .client_ids
                .as_ref()
                .is_some_and(|ids| !ids.contains(&state.client))
            {
                continue;
            }
            if state.client == ClientId::Codex && state.read.structured_env.contains(&server.name) {
                continue;
            }
            let row = find_row(&rows, &server.id, state.client);
            let enabled = row.is_some_and(|row| row.enabled);
            let entry = state.entry(&server.name);
            let written = row
                .map(|row| row.last_written_hash.clone())
                .unwrap_or_default();
            if enabled {
                let Ok(mut projected) = project(ctx, &server.name, &working.spec, state.client)
                else {
                    continue;
                };
                if state.client == ClientId::Codex {
                    projected.codex_enabled = Some(true);
                }
                let wanted = projected_node(state.client, &projected, entry);
                let confirm = match entry {
                    Some(file) => {
                        let file_hash = entry_hash(&key, state.client, file);
                        let disabled = state.client == ClientId::Codex && codex_disabled(file);
                        if file_hash == entry_hash(&key, state.client, &wanted) && !disabled {
                            continue;
                        }
                        // Out-of-date (SkillHub's own write) and Windows fix
                        // (semantically equal) need no confirmation.
                        if file_hash == written || semantic_equal(state.client, file, &wanted) {
                            None
                        } else {
                            Some("changed-outside")
                        }
                    }
                    None => Some("resync"),
                };
                plan.note_server(&server.name);
                plan.target_mut(state.client, Scope::User, "", None)
                    .items
                    .push(PlanItem {
                        server_id: server.id.clone(),
                        server_name: server.name.clone(),
                        action: ItemAction::Update,
                        op: Some(EntryOp::Upsert(projected)),
                        desired_enabled: Some(true),
                        confirm,
                        consent: None,
                        confirm_also: None,
                        row_override: None,
                    });
            } else if let Some(file) = entry {
                if state.client == ClientId::Codex {
                    if codex_disabled(file) {
                        continue;
                    }
                    plan.note_server(&server.name);
                    plan.target_mut(state.client, Scope::User, "", None)
                        .items
                        .push(PlanItem {
                            server_id: server.id.clone(),
                            server_name: server.name.clone(),
                            action: ItemAction::Disable,
                            op: Some(EntryOp::SetCodexEnabled(false)),
                            desired_enabled: Some(false),
                            confirm: Some("resync"),
                            consent: None,
                            confirm_also: None,
                            row_override: None,
                        });
                } else {
                    working
                        .spec
                        .client_extra
                        .insert(state.client.as_str().to_string(), file.to_compact_string());
                    plan.note_server(&server.name);
                    plan.target_mut(state.client, Scope::User, "", None)
                        .items
                        .push(PlanItem {
                            server_id: server.id.clone(),
                            server_name: server.name.clone(),
                            action: ItemAction::Disable,
                            op: Some(EntryOp::Remove),
                            desired_enabled: Some(false),
                            confirm: Some("resync"),
                            consent: None,
                            confirm_also: None,
                            row_override: None,
                        });
                }
            }
        }
        save_working_if_changed(&mut plan, server, working);
    }
    if plan
        .targets
        .iter()
        .any(|target| target.items.iter().any(|item| item.confirm.is_some()))
    {
        plan.add_kind("resync");
    }
    let digest = request_digest(&request);
    execute_plan(
        ctx,
        &connection,
        plan,
        request.confirm_token.as_deref(),
        &digest,
    )
}

pub(crate) fn resolve_changed_outside(
    ctx: &McpLibraryContext,
    request: McpResolveChangeRequest,
) -> Result<McpWriteOutcome, McpError> {
    let (connection, key, servers, rows) = load_state(ctx)?;
    let server = find_server(&servers, &request.server_id)?;
    let state = client_state(ctx, Some(&connection), request.client_id);
    if !state.writable {
        return Err(McpError::new(
            state.readonly_reason.unwrap_or("config-unreadable"),
            format!("{} 的配置文件现在不能写入。", request.client_id.label()),
        )
        .with_client(request.client_id));
    }
    let row = find_row(&rows, &server.id, request.client_id);
    let enabled = row.is_some_and(|row| row.enabled);
    let entry = state.entry(&server.name);
    let mut plan = WritePlan::new("resolve");
    plan.note_server(&server.name);
    match request.take.as_str() {
        "library" => {
            plan.add_kind("changed-outside");
            let mut working = server.clone();
            let decision = decide_cell(
                ctx,
                &key,
                &mut working,
                entry,
                request.client_id,
                row.map(|row| ClientRow {
                    // Treat the file as not ours so the overwrite is explicit.
                    last_written_hash: String::new(),
                    ..row.clone()
                })
                .as_ref(),
                enabled,
                false,
            );
            match decision {
                CellDecision::Item(mut item) => {
                    if item.op.is_none() {
                        return Ok(McpWriteOutcome::noop("already-in-state"));
                    }
                    item.confirm = Some("changed-outside");
                    plan.target_mut(request.client_id, Scope::User, "", None)
                        .items
                        .push(*item);
                }
                CellDecision::Skip(_) => return Ok(McpWriteOutcome::noop("nothing-selected")),
                CellDecision::Noop => return Ok(McpWriteOutcome::noop("already-in-state")),
            }
            save_working_if_changed(&mut plan, server, working);
        }
        "file" => {
            let row_key = RowKey {
                server_id: server.id.clone(),
                client: request.client_id,
                scope: Scope::User,
                workspace_id: String::new(),
            };
            match entry {
                None => {
                    // Accept the removal: the cell becomes off, nothing is written.
                    let mut adopted = row.cloned().unwrap_or_else(|| ClientRow::new(row_key));
                    adopted.enabled = false;
                    adopted.last_written_hash.clear();
                    adopted.last_error_code.clear();
                    adopted.last_error_message.clear();
                    plan.target_mut(request.client_id, Scope::User, "", None)
                        .items
                        .push(PlanItem {
                            server_id: server.id.clone(),
                            server_name: server.name.clone(),
                            action: ItemAction::Disable,
                            op: None,
                            desired_enabled: Some(false),
                            confirm: None,
                            consent: None,
                            confirm_also: None,
                            row_override: Some(Some(adopted)),
                        });
                }
                Some(file) => {
                    let mut spec = spec_from_entry(request.client_id, file).map_err(|reason| {
                        McpError::new(
                            if reason == "codex-structured-env" {
                                reason
                            } else {
                                "invalid-input"
                            },
                            "这一项使用了 SkillHub 暂不支持的写法，保持只读。",
                        )
                    })?;
                    for (client, extra) in &server.spec.client_extra {
                        if client != request.client_id.as_str() {
                            spec.client_extra.insert(client.clone(), extra.clone());
                        }
                    }
                    let mut updated = server.clone();
                    updated.spec = spec;
                    updated.spec_revision += 1;
                    let mut adopted = row.cloned().unwrap_or_else(|| ClientRow::new(row_key));
                    adopted.enabled =
                        !(request.client_id == ClientId::Codex && codex_disabled(file));
                    adopted.last_written_hash = entry_hash(&key, request.client_id, file);
                    adopted.last_seen_hash = adopted.last_written_hash.clone();
                    adopted.last_error_code.clear();
                    adopted.last_error_message.clear();
                    adopted.inline_consent = server_needs_inline(&updated.spec, request.client_id);
                    plan.target_mut(request.client_id, Scope::User, "", None)
                        .items
                        .push(PlanItem {
                            server_id: server.id.clone(),
                            server_name: server.name.clone(),
                            action: ItemAction::Update,
                            op: None,
                            desired_enabled: Some(adopted.enabled),
                            confirm: None,
                            consent: None,
                            confirm_also: None,
                            row_override: Some(Some(adopted)),
                        });
                    let states = client_states(ctx, Some(&connection));
                    reproject_enabled(
                        ctx,
                        &key,
                        &mut plan,
                        server,
                        &updated,
                        &states,
                        &rows,
                        ItemAction::Update,
                        "resync",
                        &[request.client_id],
                    );
                    if plan.targets.iter().any(|target| {
                        target.client != request.client_id && !target.items.is_empty()
                    }) {
                        plan.add_kind("resync");
                    }
                    updated.updated_at = ns_text(now_ns());
                    plan.servers_after.push(updated);
                }
            }
        }
        _ => {
            return Err(McpError::invalid(
                "请选择采用文件中的版本，或用库里的版本覆盖。",
            ))
        }
    }
    let digest = request_digest(&request);
    execute_plan(
        ctx,
        &connection,
        plan,
        request.confirm_token.as_deref(),
        &digest,
    )
}

pub(crate) fn resolve_stuck_transaction(
    ctx: &McpLibraryContext,
    request: McpResolveStuckRequest,
) -> Result<McpWriteOutcome, McpError> {
    if request.action != "keep-current" {
        return Err(McpError::invalid("只能选择保留现在的文件。"));
    }
    engine::resolve_stuck_transaction(&ctx.mutation, &request.snapshot_id)
        .map_err(|message| McpError::new("not-found", message))?;
    let connection = open_db(ctx)?;
    let operation_id = format!("mcp-op-{}", uuid::Uuid::new_v4().simple());
    let summary = McpOperationSummary {
        kind: "resolve".to_string(),
        ..McpOperationSummary::default()
    };
    insert_operation(
        &connection,
        &operation_id,
        "resolve",
        "applied",
        &summary,
        &[],
        None,
    )?;
    let generation = bump_generation();
    Ok(McpWriteOutcome::Done {
        operation_id,
        undo_token: None,
        summary,
        results: Vec::new(),
        generation,
    })
}

// ---------------------------------------------------------------------------
// Undo, rollback and history (§4.4, M1-9)
// ---------------------------------------------------------------------------

fn resolve_read(
    ctx: &McpLibraryContext,
    client: ClientId,
    scope: Scope,
    workspace_id: &str,
) -> Option<TargetRead> {
    let target = engine::resolve_target(
        &ctx.mutation,
        client.host_id(),
        scope.as_str(),
        (!workspace_id.is_empty()).then_some(workspace_id),
    )
    .ok()?;
    Some(engine::read_target_entries(&target))
}

/// Builds the plan that undoes one operation: byte restore when the file is
/// untouched since, otherwise entry-level restore of exactly the touched
/// entries; anything changed after the operation is a per-client conflict.
fn build_undo_plan(
    ctx: &McpLibraryContext,
    connection: &Connection,
    operation_id: &str,
    kind: &'static str,
) -> Result<(WritePlan, McpOperationSummary), McpError> {
    let operations = load_operations(connection)?;
    let operation = operations
        .iter()
        .find(|operation| operation.id == operation_id)
        .ok_or_else(|| McpError::new("undo-unavailable", "这条记录已经不能撤销。"))?;
    if let Some(reason) = undo_unavailable_reason(&operations, operation, now_ns()) {
        if reason != "superseded" || kind == "undo" {
            return Err(
                McpError::new("undo-unavailable", "这条记录已经不能撤销。").param("reason", reason)
            );
        }
    }
    let mut blob = load_undo_blob(connection, operation_id)?
        .ok_or_else(|| McpError::new("undo-unavailable", "这条记录已经不能撤销。"))?;
    // A variable changed after the operation (by the user or another program)
    // is left as it is: undo never overwrites or deletes a value SkillHub did
    // not write.
    blob.env_before.retain(|before| {
        !before.after_recorded || ctx.env.get(&before.name).ok().flatten() == before.after
    });
    let servers = load_servers(connection, true)?;
    let server_id_for = |name: &str| -> String {
        blob.servers_before
            .iter()
            .filter_map(|(_, server)| server.as_ref())
            .chain(servers.iter())
            .find(|server| server.name.eq_ignore_ascii_case(name))
            .map(|server| server.id.clone())
            .unwrap_or_default()
    };
    let mut plan = WritePlan::new(kind);
    plan.server_names = operation.summary.server_names.clone();
    plan.env_var_names = operation.summary.env_var_names.clone();
    for before in &blob.env_before {
        plan.env_ops.push(match &before.value {
            Some(value) => EnvOp::Set {
                name: before.name.clone(),
                value: value.clone(),
            },
            None => EnvOp::Delete {
                name: before.name.clone(),
            },
        });
    }
    let mut targets: Vec<UndoTarget> = Vec::new();
    for target in blob.targets.iter().cloned() {
        match targets.iter_mut().find(|existing| {
            existing.client == target.client
                && existing.scope == target.scope
                && existing.workspace_id == target.workspace_id
        }) {
            // Several transactions on one file (a column change over more
            // than 64 servers): no single snapshot holds the original bytes,
            // so that file is restored entry by entry, once.
            Some(existing) => {
                existing.snapshot_id = None;
                existing.applied_sha256.clear();
            }
            None => targets.push(target),
        }
    }
    for entry in &blob.entries {
        if !targets.iter().any(|target| {
            target.client == entry.client
                && target.scope == entry.scope
                && target.workspace_id == entry.workspace_id
        }) {
            targets.push(UndoTarget {
                client: entry.client,
                scope: entry.scope,
                workspace_id: entry.workspace_id.clone(),
                snapshot_id: None,
                applied_sha256: String::new(),
            });
        }
    }
    for undo_target in &targets {
        let entries = blob
            .entries
            .iter()
            .filter(|entry| {
                entry.client == undo_target.client
                    && entry.scope == undo_target.scope
                    && entry.workspace_id == undo_target.workspace_id
            })
            .collect::<Vec<_>>();
        if entries.is_empty() {
            continue;
        }
        let read = resolve_read(
            ctx,
            undo_target.client,
            undo_target.scope,
            &undo_target.workspace_id,
        );
        let mut target_items = Vec::new();
        let mut conflicts = Vec::new();
        for entry in &entries {
            let before = entry.before.as_deref().and_then(Node::from_json_text);
            let after = entry.after.as_deref().and_then(Node::from_json_text);
            let current = read.as_ref().and_then(|read| read.entry(&entry.name));
            if !engine::nodes_equivalent(current, after.as_ref()) {
                conflicts.push(entry.name.clone());
                continue;
            }
            let server_id = server_id_for(&entry.name);
            let row_key = RowKey {
                server_id: server_id.clone(),
                client: undo_target.client,
                scope: undo_target.scope,
                workspace_id: undo_target.workspace_id.clone(),
            };
            let row_before = blob
                .rows_before
                .iter()
                .find(|(key, _)| key == &row_key)
                .map(|(_, row)| row.clone());
            target_items.push(PlanItem {
                server_id,
                server_name: entry.name.clone(),
                action: match (&before, &after) {
                    (None, _) => ItemAction::Remove,
                    (_, None) => ItemAction::Add,
                    _ => ItemAction::Update,
                },
                op: Some(match before {
                    Some(node) => EntryOp::Restore(node),
                    None => EntryOp::Remove,
                }),
                desired_enabled: None,
                confirm: None,
                consent: None,
                confirm_also: None,
                row_override: row_before,
            });
        }
        let byte_restore = conflicts.is_empty()
            && undo_target.snapshot_id.is_some()
            && read.as_ref().is_some_and(|read| {
                !read.sha256.is_empty() && read.sha256 == undo_target.applied_sha256
            });
        // One transaction holds at most 64 changes: a larger undo (a column
        // change over many servers) is split into several, in order.
        let mut items = target_items.into_iter().peekable();
        let mut first = true;
        loop {
            let target = plan.target_mut(
                undo_target.client,
                undo_target.scope,
                &undo_target.workspace_id,
                None,
            );
            while target.items.len() < 64 {
                match items.next() {
                    Some(item) => target.items.push(item),
                    None => break,
                }
            }
            if first {
                target.conflicts.append(&mut conflicts);
                if byte_restore {
                    target.restore_snapshot = undo_target.snapshot_id.clone();
                }
                first = false;
            }
            if items.peek().is_none() {
                break;
            }
        }
    }
    plan.undo_restore = Some(blob);
    Ok((plan, operation.summary.clone()))
}

fn finish_undo(
    connection: &Connection,
    undone: &str,
    outcome: &McpWriteOutcome,
) -> Result<(), McpError> {
    if let Some(new_id) = outcome.operation_id() {
        connection
            .execute(
                "UPDATE mcp_operations SET state = 'undone', undone_by = ?2 WHERE id = ?1",
                params![undone, new_id],
            )
            .map_err(db_error)?;
    }
    Ok(())
}

pub(crate) fn undo(
    ctx: &McpLibraryContext,
    request: McpUndoRequest,
) -> Result<McpWriteOutcome, McpError> {
    let connection = open_db(ctx)?;
    let (plan, _) = build_undo_plan(ctx, &connection, &request.undo_token, "undo")?;
    let outcome = execute_plan(ctx, &connection, plan, None, &[])?;
    finish_undo(&connection, &request.undo_token, &outcome)?;
    Ok(outcome)
}

pub(crate) fn rollback(
    ctx: &McpLibraryContext,
    request: McpRollbackRequest,
) -> Result<McpWriteOutcome, McpError> {
    let connection = open_db(ctx)?;
    let key = hash_key(ctx)?;
    let digest = request_digest(&request);
    if let Some(snapshot_id) = &request.legacy_snapshot_id {
        let legacy = engine::list_legacy_snapshots(&ctx.mutation)
            .into_iter()
            .find(|item| &item.snapshot_id == snapshot_id)
            .ok_or_else(|| {
                McpError::new("undo-unavailable", "这条 3.2 版本的记录已经不能撤销。")
            })?;
        if !legacy.restorable {
            return Err(
                McpError::new("undo-conflict", "这些配置文件在之后又被改过，没有撤销。")
                    .param("reason", "legacy-changed"),
            );
        }
        let items = legacy
            .host_ids
            .iter()
            .filter_map(|host| ClientId::from_host(host))
            .map(|client| McpConfirmationItem {
                client_id: client,
                client_label: client.label().to_string(),
                scope: Scope::User,
                project_label: None,
                server_name: String::new(),
                action: "update".to_string(),
                before: None,
                after: None,
                changed_fields: Vec::new(),
            })
            .collect::<Vec<_>>();
        let token = hmac_hex(
            &key,
            &[
                b"legacy-rollback",
                snapshot_id.as_bytes(),
                legacy.path_displays.join("|").as_bytes(),
                &digest,
            ],
        );
        if request.confirm_token.as_deref() != Some(token.as_str()) {
            return Ok(McpWriteOutcome::NeedsConfirmation {
                confirmation: McpConfirmation {
                    kinds: vec!["rollback".to_string()],
                    confirm_token: token,
                    items,
                    env_vars: None,
                    undoable: false,
                },
            });
        }
        let result = engine::rollback_legacy_snapshot_locked(&ctx.mutation, snapshot_id);
        let operation_id = format!("mcp-op-{}", uuid::Uuid::new_v4().simple());
        let clients = legacy
            .host_ids
            .iter()
            .filter_map(|host| ClientId::from_host(host))
            .collect::<Vec<_>>();
        let mut summary = McpOperationSummary {
            kind: "rollback".to_string(),
            client_ids: clients.clone(),
            ..McpOperationSummary::default()
        };
        let results = clients
            .iter()
            .map(|client| McpClientResult {
                client_id: *client,
                scope: Scope::User,
                project_label: None,
                server_ids: Vec::new(),
                status: if result.is_ok() { "undone" } else { "failed" }.to_string(),
                skipped_reason: None,
                error: result
                    .as_ref()
                    .err()
                    .map(|message| classify_engine_error(message)),
                restart_hint: result.is_ok() && client.restart_hint(),
            })
            .collect();
        if result.is_err() {
            summary.failed_client_ids = clients;
        }
        insert_operation(
            &connection,
            &operation_id,
            "rollback",
            if result.is_ok() { "applied" } else { "failed" },
            &summary,
            &[],
            None,
        )?;
        let generation = bump_generation();
        return Ok(McpWriteOutcome::Done {
            operation_id,
            undo_token: None,
            summary,
            results,
            generation,
        });
    }
    let operation_id = request
        .operation_id
        .clone()
        .ok_or_else(|| McpError::invalid("请选择要撤销的记录。"))?;
    let operations = load_operations(&connection)?;
    let operation = operations
        .iter()
        .find(|operation| operation.id == operation_id)
        .ok_or_else(|| McpError::new("undo-unavailable", "这条记录已经不能撤销。"))?;
    // "回到这一步之前": later operations on the same entries are undone first,
    // newest first, behind one confirmation.
    let mut chain = later_overlapping(&operations, operation)
        .into_iter()
        .map(|later| later.id.clone())
        .collect::<Vec<_>>();
    chain.push(operation_id.clone());
    let mut descriptor_items = Vec::new();
    let mut shas = Vec::new();
    for id in &chain {
        let blob = load_undo_blob(&connection, id)?
            .ok_or_else(|| McpError::new("undo-unavailable", "这条记录已经不能撤销。"))?;
        for entry in &blob.entries {
            let before = entry.before.as_deref().and_then(Node::from_json_text);
            let after = entry.after.as_deref().and_then(Node::from_json_text);
            descriptor_items.push(McpConfirmationItem {
                client_id: entry.client,
                client_label: entry.client.label().to_string(),
                scope: entry.scope,
                project_label: None,
                server_name: entry.name.clone(),
                action: match (&before, &after) {
                    (None, _) => "remove",
                    (_, None) => "add",
                    _ => "update",
                }
                .to_string(),
                before: after.as_ref().map(|node| entry_preview(entry.client, node)),
                after: before
                    .as_ref()
                    .map(|node| entry_preview(entry.client, node)),
                changed_fields: changed_fields(entry.client, after.as_ref(), before.as_ref()),
            });
            if let Some(read) = resolve_read(ctx, entry.client, entry.scope, &entry.workspace_id) {
                shas.push(read.sha256);
            }
        }
    }
    let mut parts: Vec<Vec<u8>> = vec![
        b"rollback".to_vec(),
        chain.join("|").into_bytes(),
        serde_json::to_vec(&descriptor_items).unwrap_or_default(),
    ];
    parts.extend(shas.into_iter().map(String::into_bytes));
    parts.push(digest);
    let refs = parts.iter().map(Vec::as_slice).collect::<Vec<_>>();
    let token = hmac_hex(&key, &refs);
    if request.confirm_token.as_deref() != Some(token.as_str()) {
        return Ok(McpWriteOutcome::NeedsConfirmation {
            confirmation: McpConfirmation {
                kinds: vec!["rollback".to_string()],
                confirm_token: token,
                items: descriptor_items,
                env_vars: None,
                undoable: true,
            },
        });
    }
    let mut combined: Option<McpWriteOutcome> = None;
    let mut all_results = Vec::new();
    for id in &chain {
        let (plan, _) = build_undo_plan(ctx, &connection, id, "rollback")?;
        let outcome = execute_plan(ctx, &connection, plan, None, &[])?;
        finish_undo(&connection, id, &outcome)?;
        if let McpWriteOutcome::Done { results, .. } = &outcome {
            all_results.extend(results.clone());
        }
        combined = Some(outcome);
    }
    match combined {
        Some(McpWriteOutcome::Done {
            operation_id,
            undo_token,
            mut summary,
            generation,
            ..
        }) => {
            summary.failed_client_ids = all_results
                .iter()
                .filter(|result| result.status == "failed")
                .map(|result| result.client_id)
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect();
            Ok(McpWriteOutcome::Done {
                operation_id,
                undo_token,
                summary,
                results: all_results,
                generation,
            })
        }
        Some(other) => Ok(other),
        None => Ok(McpWriteOutcome::noop("already-in-state")),
    }
}

pub(crate) fn history(
    ctx: &McpLibraryContext,
    request: McpHistoryRequest,
) -> Result<Vec<McpHistoryEntry>, McpError> {
    let limit = request.limit.unwrap_or(50).clamp(1, MAX_HISTORY_ROWS);
    let connection = open_db(ctx)?;
    let operations = load_operations(&connection)?;
    let now = now_ns();
    let mut entries = operations
        .iter()
        .filter(|operation| operation.state != "applying")
        .map(|operation| {
            let reason = undo_unavailable_reason(&operations, operation, now);
            (
                operation.created_at,
                McpHistoryEntry {
                    operation_id: operation.id.clone(),
                    at: iso_from_ns(operation.created_at),
                    kind: operation.kind.clone(),
                    server_names: operation.summary.server_names.clone(),
                    client_ids: operation.summary.client_ids.clone(),
                    failed_client_ids: operation.summary.failed_client_ids.clone(),
                    env_var_names: operation.summary.env_var_names.clone(),
                    partial: operation.state == "partial",
                    // A superseded entry still offers "回到这一步之前"
                    // (rollback of every later operation) behind a confirmation.
                    undo_available: reason.is_none(),
                    undo_unavailable_reason: reason.map(str::to_string),
                    legacy_snapshot_id: None,
                },
            )
        })
        .collect::<Vec<_>>();
    for legacy in engine::list_legacy_snapshots(&ctx.mutation) {
        let created = legacy.created_at_unix_ms * 1_000_000;
        entries.push((
            created,
            McpHistoryEntry {
                operation_id: format!("legacy-{}", legacy.snapshot_id),
                at: iso_from_ns(created),
                kind: "legacy".to_string(),
                server_names: Vec::new(),
                client_ids: legacy
                    .host_ids
                    .iter()
                    .filter_map(|host| ClientId::from_host(host))
                    .collect(),
                failed_client_ids: Vec::new(),
                env_var_names: Vec::new(),
                partial: false,
                undo_available: legacy.restorable,
                undo_unavailable_reason: (!legacy.restorable).then(|| "legacy-changed".to_string()),
                legacy_snapshot_id: Some(legacy.snapshot_id),
            },
        ));
    }
    entries.sort_by_key(|(created, _)| std::cmp::Reverse(*created));
    Ok(entries
        .into_iter()
        .take(limit)
        .map(|(_, entry)| entry)
        .collect())
}

// ---------------------------------------------------------------------------
// Detail, export and file location (reads)
// ---------------------------------------------------------------------------

pub(crate) fn get_server(
    ctx: &McpLibraryContext,
    request: McpGetServerRequest,
) -> Result<McpServerDetail, McpError> {
    let snapshot_cells = library_snapshot(ctx)?;
    let connection = open_db(ctx)?;
    let servers = load_servers(&connection, false)?;
    let server = find_server(&servers, &request.server_id)?;
    let row = snapshot_cells
        .servers
        .iter()
        .find(|row| row.id == server.id)
        .cloned();
    let args = server
        .spec
        .args
        .iter()
        .enumerate()
        .map(|(index, arg)| {
            let all = server
                .spec
                .args
                .iter()
                .map(|arg| arg.value.clone())
                .collect::<Vec<_>>();
            let masked = arg.secret || looks_like_secret_arg(&all, index);
            McpArgView {
                value: if masked {
                    SECRET_MASK.to_string()
                } else {
                    arg.value.clone()
                },
                masked,
            }
        })
        .collect();
    Ok(McpServerDetail {
        id: server.id.clone(),
        name: server.name.clone(),
        display_name: server.display_name.clone(),
        transport: server.spec.transport,
        command: server.spec.command.clone(),
        args,
        cwd: server.spec.cwd.clone(),
        // A key in an imported URL's query or account part stays hidden.
        url: server.spec.url.as_deref().map(masked_url),
        env: server
            .spec
            .env
            .iter()
            .filter(|item| !item.secret)
            .map(|item| McpNameValue {
                name: item.name.clone(),
                value: item.value.clone().unwrap_or_default(),
            })
            .collect(),
        secrets: secret_statuses(ctx, Some(&connection), &server.spec),
        codex_required: server.spec.codex_required,
        source: server.source.clone(),
        meta: server.meta.clone(),
        spec_revision: server.spec_revision,
        cells: row
            .as_ref()
            .map(|row| row.cells.clone())
            .unwrap_or_default(),
        project_bindings: row
            .as_ref()
            .map(|row| row.project_bindings.clone())
            .unwrap_or_default(),
        test: test_summary(server),
    })
}

/// Masked export: secret values become `SECRET_MASK`, references stay.
pub(crate) fn export_json(
    ctx: &McpLibraryContext,
    request: McpExportRequest,
) -> Result<McpExportResult, McpError> {
    let connection = open_db(ctx)?;
    let servers = load_servers(&connection, false)?;
    let mut masked = 0usize;
    let mut selected = servers
        .iter()
        .filter(|server| {
            request
                .server_ids
                .as_ref()
                .is_none_or(|ids| ids.contains(&server.id))
        })
        .collect::<Vec<_>>();
    selected.sort_by_key(|server| server.name.to_lowercase());
    let mask = |count: &mut usize| {
        *count += 1;
        SECRET_MASK.to_string()
    };
    let mut entries: Vec<(String, Node)> = Vec::new();
    for server in &selected {
        let spec = &server.spec;
        let mut entry = ObjectMap::new();
        let codex = request.format == "codex-toml";
        if !codex {
            entry.insert("type", Node::string(spec.transport.as_str()));
        }
        match spec.transport {
            Transport::Stdio => {
                entry.insert(
                    "command",
                    Node::string(spec.command.clone().unwrap_or_default()),
                );
                let all = spec
                    .args
                    .iter()
                    .map(|arg| arg.value.clone())
                    .collect::<Vec<_>>();
                let args = spec
                    .args
                    .iter()
                    .enumerate()
                    .map(|(index, arg)| {
                        if arg.secret || looks_like_secret_arg(&all, index) {
                            mask(&mut masked)
                        } else {
                            arg.value.clone()
                        }
                    })
                    .collect::<Vec<_>>();
                if !args.is_empty() {
                    entry.insert("args", Node::string_array(args));
                }
                let mut env = ObjectMap::new();
                let mut env_vars = Vec::new();
                for item in &spec.env {
                    let value = if !item.secret {
                        item.value.clone().unwrap_or_default()
                    } else if matches!(
                        item.storage,
                        SecretStorage::UserEnv | SecretStorage::External
                    ) {
                        if codex && item.variable() == item.name {
                            env_vars.push(item.name.clone());
                            continue;
                        }
                        format!("${{{}}}", item.variable())
                    } else {
                        mask(&mut masked)
                    };
                    env.insert(item.name.clone(), Node::string(value));
                }
                if !env.is_empty() {
                    entry.insert("env", Node::Object(env));
                }
                if !env_vars.is_empty() {
                    entry.insert("env_vars", Node::string_array(env_vars));
                }
            }
            Transport::Http | Transport::Sse => {
                let url = spec.url.clone().unwrap_or_default();
                let shown = masked_url(&url);
                if shown != url {
                    masked += 1;
                }
                entry.insert("url", Node::string(shown));
                let mut headers = ObjectMap::new();
                for header in &spec.headers {
                    let value = match header.storage {
                        SecretStorage::Literal => header.value.clone().unwrap_or_default(),
                        SecretStorage::UserEnv | SecretStorage::External => {
                            format!("${{{}}}", header.env_var.clone().unwrap_or_default())
                        }
                        SecretStorage::Library => mask(&mut masked),
                    };
                    let value = if header.template == HeaderTemplate::Bearer {
                        format!("Bearer {value}")
                    } else {
                        value
                    };
                    headers.insert(header.name.clone(), Node::string(value));
                }
                if !headers.is_empty() {
                    entry.insert(
                        if codex { "http_headers" } else { "headers" },
                        Node::Object(headers),
                    );
                }
            }
        }
        entries.push((server.name.clone(), Node::Object(entry)));
    }
    let text = if request.format == "codex-toml" {
        let mut document = toml_edit::DocumentMut::new();
        let mut servers_table = toml_edit::Table::new();
        servers_table.set_implicit(true);
        for (name, entry) in &entries {
            let mut table = toml_edit::Table::new();
            if let Node::Object(map) = entry {
                for (key, value) in map.iter() {
                    if let Some(value) = engine::node_to_toml(value) {
                        table.insert(key, toml_edit::Item::Value(value));
                    }
                }
            }
            servers_table.insert(name, toml_edit::Item::Table(table));
        }
        document.insert("mcp_servers", toml_edit::Item::Table(servers_table));
        document.to_string()
    } else if request.format == "mcp-servers" {
        let mut servers_map = ObjectMap::new();
        for (name, entry) in entries {
            servers_map.insert(name, entry);
        }
        let mut root = ObjectMap::new();
        root.insert("mcpServers", Node::Object(servers_map));
        let mut document = crate::mcp_json_doc::JsonDoc::new_empty();
        document.root = Node::Object(root);
        document.render().unwrap_or_default()
    } else {
        return Err(McpError::invalid("导出格式无效。"));
    };
    Ok(McpExportResult {
        text,
        masked_secret_count: masked,
    })
}

/// Resolves a config location in Rust (the webview never sends paths).
pub(crate) fn config_location(
    ctx: &McpLibraryContext,
    request: &McpOpenLocationRequest,
) -> Result<PathBuf, McpError> {
    let scope = request.scope.unwrap_or(Scope::User);
    let target = engine::resolve_target(
        &ctx.mutation,
        request.client_id.host_id(),
        scope.as_str(),
        request.workspace_id.as_deref(),
    )
    .map_err(|_| {
        McpError::new(
            "client-not-installed",
            format!("没有检测到 {}。", request.client_id.label()),
        )
        .with_client(request.client_id)
    })?;
    let path = target.path().to_path_buf();
    if path.is_file() {
        Ok(path)
    } else {
        path.parent()
            .map(Path::to_path_buf)
            .ok_or_else(|| McpError::new("client-not-installed", "没有找到配置文件位置。"))
    }
}

// ---------------------------------------------------------------------------
// Paste and GitHub candidates (M0-6, M1-8)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct McpCandidateSecret {
    kind: String,
    name: String,
    env_var: Option<String>,
    has_pasted_value: bool,
    placeholder: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct McpCandidateVariant {
    key: String,
    target_display: String,
    preferred: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct McpCandidate {
    key: String,
    name: String,
    name_suggested: bool,
    name_valid: bool,
    input: McpServerInput,
    target_display: String,
    exists: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    existing_server_id: Option<String>,
    differs_in: Vec<ClientId>,
    secrets: Vec<McpCandidateSecret>,
    warnings: Vec<String>,
    variants: Vec<McpCandidateVariant>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct McpPasteResult {
    format: String,
    paste_handle: Option<String>,
    candidates: Vec<McpCandidate>,
    skipped: Vec<PasteSkip>,
    #[serde(skip_serializing_if = "Option::is_none")]
    source_display: Option<String>,
    notices: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PasteSkip {
    name: String,
    reason: String,
}

/// A candidate group from one source: the servers plus same-name variants
/// (GitHub README) and the source attribution.
pub(crate) struct CandidateSource {
    pub format: Option<mcp_paste::PasteFormat>,
    pub servers: Vec<mcp_paste::ParsedServer>,
    pub skipped: Vec<(String, &'static str)>,
    pub source: McpServerSource,
    pub source_display: Option<String>,
    pub notices: Vec<&'static str>,
    pub readme: bool,
    /// For each server, the index of the preferred variant of its name group.
    pub preferred: Vec<bool>,
}

fn path_placeholder(arg: &str) -> bool {
    let lower = arg.to_ascii_lowercase();
    lower.contains("/path/to")
        || lower.contains("\\path\\to")
        || (arg.starts_with('<') && arg.ends_with('>'))
        || lower.contains("/users/username")
        || lower.contains("your/")
}

pub(crate) fn candidates_from(
    ctx: &McpLibraryContext,
    source: CandidateSource,
) -> Result<McpPasteResult, McpError> {
    let connection = open_db(ctx)?;
    let key = hash_key(ctx)?;
    let servers = load_servers(&connection, false)?;
    let states = client_states(ctx, Some(&connection));
    let mut vault_values = HashMap::new();
    let mut candidates = Vec::new();
    for (index, parsed) in source.servers.iter().enumerate() {
        let mut secrets_view = Vec::new();
        let mut secret_inputs = Vec::new();
        let mut literal_env = Vec::new();
        let mut provisional =
            McpServerSpec::empty(Transport::parse(parsed.transport).unwrap_or(Transport::Stdio));
        for (name, value) in &parsed.env {
            match mcp_paste::classify_env_value(name, value) {
                mcp_paste::ValueKind::Literal(value) => {
                    literal_env.push(McpNameValueInput {
                        name: name.clone(),
                        value: value.clone(),
                    });
                    provisional.env.push(SpecEnv {
                        name: name.clone(),
                        secret: false,
                        storage: SecretStorage::Literal,
                        env_var: None,
                        value: Some(value),
                        inline_clients: Vec::new(),
                        required: false,
                    });
                }
                mcp_paste::ValueKind::Placeholder { env_var } => {
                    let variable = env_var.clone().unwrap_or_else(|| name.clone());
                    secrets_view.push(McpCandidateSecret {
                        kind: "env".to_string(),
                        name: name.clone(),
                        env_var: Some(variable.clone()),
                        has_pasted_value: false,
                        placeholder: true,
                    });
                    secret_inputs.push(McpSecretInput {
                        kind: "env".to_string(),
                        name: name.clone(),
                        env_var: Some(variable.clone()),
                        header_template: None,
                        value: None,
                        paste_value_handle: None,
                        mode: "user_env".to_string(),
                        inline_clients: None,
                        required: Some(true),
                    });
                    provisional.env.push(SpecEnv {
                        name: name.clone(),
                        secret: true,
                        storage: SecretStorage::External,
                        env_var: (variable != *name).then_some(variable),
                        value: None,
                        inline_clients: Vec::new(),
                        required: true,
                    });
                }
                mcp_paste::ValueKind::Secret(value) => {
                    let handle = format!("v{}", vault_values.len() + 1);
                    vault_values.insert(handle.clone(), value.clone());
                    secrets_view.push(McpCandidateSecret {
                        kind: "env".to_string(),
                        name: name.clone(),
                        env_var: Some(name.clone()),
                        has_pasted_value: true,
                        placeholder: false,
                    });
                    secret_inputs.push(McpSecretInput {
                        kind: "env".to_string(),
                        name: name.clone(),
                        env_var: Some(name.clone()),
                        header_template: None,
                        value: None,
                        paste_value_handle: Some(handle),
                        mode: "user_env".to_string(),
                        inline_clients: None,
                        required: Some(true),
                    });
                    provisional.env.push(SpecEnv {
                        name: name.clone(),
                        secret: true,
                        storage: SecretStorage::Library,
                        env_var: None,
                        value: Some(value),
                        inline_clients: ClientId::ALL.to_vec(),
                        required: true,
                    });
                }
            }
        }
        for name in &parsed.env_refs {
            secrets_view.push(McpCandidateSecret {
                kind: "env".to_string(),
                name: name.clone(),
                env_var: Some(name.clone()),
                has_pasted_value: false,
                placeholder: true,
            });
            secret_inputs.push(McpSecretInput {
                kind: "env".to_string(),
                name: name.clone(),
                env_var: Some(name.clone()),
                header_template: None,
                value: None,
                paste_value_handle: None,
                mode: "user_env".to_string(),
                inline_clients: None,
                required: Some(true),
            });
            provisional.env.push(SpecEnv {
                name: name.clone(),
                secret: true,
                storage: SecretStorage::External,
                env_var: None,
                value: None,
                inline_clients: Vec::new(),
                required: true,
            });
        }
        let mut header_inputs: Vec<(String, bool, Option<String>, Option<String>)> = Vec::new();
        for (name, value) in &parsed.headers {
            let (bearer, kind) = mcp_paste::classify_header_value(value);
            match kind {
                mcp_paste::ValueKind::Placeholder { env_var } => {
                    header_inputs.push((name.clone(), bearer, env_var, None))
                }
                mcp_paste::ValueKind::Secret(value) | mcp_paste::ValueKind::Literal(value) => {
                    header_inputs.push((name.clone(), bearer, None, Some(value)))
                }
            }
        }
        for (name, variable) in &parsed.header_env_refs {
            header_inputs.push((name.clone(), false, Some(variable.clone()), None));
        }
        if let Some(variable) = &parsed.bearer_env {
            header_inputs.push((
                "Authorization".to_string(),
                true,
                Some(variable.clone()),
                None,
            ));
        }
        for (name, bearer, env_var, value) in header_inputs {
            let variable = env_var.unwrap_or_else(|| derived_variable(&parsed.name, &name, bearer));
            let handle = value.as_ref().map(|value| {
                let handle = format!("v{}", vault_values.len() + 1);
                vault_values.insert(handle.clone(), value.clone());
                handle
            });
            secrets_view.push(McpCandidateSecret {
                kind: "header".to_string(),
                name: name.clone(),
                env_var: Some(variable.clone()),
                has_pasted_value: handle.is_some(),
                placeholder: handle.is_none(),
            });
            secret_inputs.push(McpSecretInput {
                kind: "header".to_string(),
                name: name.clone(),
                env_var: Some(variable.clone()),
                header_template: Some(if bearer { "bearer" } else { "raw" }.to_string()),
                value: None,
                paste_value_handle: handle,
                mode: "user_env".to_string(),
                inline_clients: None,
                required: Some(true),
            });
            provisional.headers.push(SpecHeader {
                name: name.clone(),
                template: if bearer {
                    HeaderTemplate::Bearer
                } else {
                    HeaderTemplate::Raw
                },
                env_var: value.is_none().then(|| variable.clone()),
                storage: if value.is_some() {
                    SecretStorage::Library
                } else {
                    SecretStorage::External
                },
                value,
                inline_clients: ClientId::ALL.to_vec(),
                required: true,
            });
        }
        provisional.command = parsed.command.clone();
        provisional.args = parsed
            .args
            .iter()
            .map(|value| SpecArg {
                value: value.clone(),
                secret: false,
            })
            .collect();
        provisional.cwd = parsed.cwd.clone();
        provisional.url = parsed.url.clone();
        provisional.codex_required = parsed.codex_required;

        // exists: library and every client file (§3.6).
        let name_key = parsed.name.to_ascii_lowercase();
        let existing = servers
            .iter()
            .find(|server| server.name.to_ascii_lowercase() == name_key);
        let mut differs_in = Vec::new();
        let mut any_file = false;
        for state in &states {
            let Some(file) = state.entry(&parsed.name) else {
                continue;
            };
            any_file = true;
            let same = project(ctx, &parsed.name, &provisional, state.client)
                .map(|projected| {
                    let wanted = projected_node(state.client, &projected, Some(file));
                    entry_hash(&key, state.client, file) == entry_hash(&key, state.client, &wanted)
                        || semantic_equal(state.client, file, &wanted)
                })
                .unwrap_or(false);
            if !same {
                differs_in.push(state.client);
            }
        }
        let library_same = existing.is_some_and(|server| {
            let reference = ClientId::ClaudeCode;
            match (
                project(ctx, &server.name, &server.spec, reference),
                project(ctx, &parsed.name, &provisional, reference),
            ) {
                (Ok(left), Ok(right)) => semantic_equal(
                    reference,
                    &projected_node(reference, &left, None),
                    &projected_node(reference, &right, None),
                ),
                _ => {
                    server.spec.transport == provisional.transport
                        && server.spec.command == provisional.command
                        && server.spec.url == provisional.url
                }
            }
        });
        let exists = if existing.is_none() && !any_file {
            "new"
        } else if (existing.is_none() || library_same) && differs_in.is_empty() {
            "same"
        } else {
            "different"
        };
        let mut warnings = parsed
            .warnings
            .iter()
            .map(|warning| warning.to_string())
            .collect::<Vec<_>>();
        if parsed.args.iter().any(|arg| path_placeholder(arg)) {
            warnings.push("needs-folder-path".to_string());
        }
        if source.readme {
            warnings.push("readme-example".to_string());
        }
        let summary = server_summary(&provisional);
        let input = McpServerInput {
            name: parsed.name.clone(),
            display_name: None,
            transport: provisional.transport,
            command: parsed.command.clone(),
            args: (!parsed.args.is_empty()).then(|| parsed.args.clone()),
            cwd: parsed.cwd.clone(),
            url: parsed.url.clone(),
            env: (!literal_env.is_empty()).then_some(literal_env),
            secrets: (!secret_inputs.is_empty()).then_some(secret_inputs),
            codex_required: parsed.codex_required.then_some(true),
            source: source.source.clone(),
        };
        candidates.push(McpCandidate {
            key: format!("c{}", index + 1),
            name: parsed.name.clone(),
            name_suggested: parsed.name_suggested,
            name_valid: mcp_paste::is_valid_library_name(&parsed.name),
            input,
            target_display: target_display(&summary),
            exists: exists.to_string(),
            existing_server_id: existing.map(|server| server.id.clone()),
            differs_in,
            secrets: secrets_view,
            warnings,
            variants: Vec::new(),
        });
    }
    // Same-name variants (README): every candidate lists its group.
    let groups = candidates
        .iter()
        .enumerate()
        .map(|(index, candidate)| (candidate.name.to_ascii_lowercase(), index))
        .fold(
            BTreeMap::<String, Vec<usize>>::new(),
            |mut map, (name, index)| {
                map.entry(name).or_default().push(index);
                map
            },
        );
    for indexes in groups.values().filter(|indexes| indexes.len() > 1) {
        let variants = indexes
            .iter()
            .map(|index| McpCandidateVariant {
                key: candidates[*index].key.clone(),
                target_display: candidates[*index].target_display.clone(),
                preferred: source.preferred.get(*index).copied().unwrap_or(false),
            })
            .collect::<Vec<_>>();
        for index in indexes {
            candidates[*index].variants = variants.clone();
        }
    }
    let paste_handle = mcp_paste::vault_store(vault_values);
    Ok(McpPasteResult {
        format: source
            .format
            .map(|format| format.as_str().to_string())
            .unwrap_or_else(|| "unrecognized".to_string()),
        paste_handle,
        candidates,
        skipped: source
            .skipped
            .into_iter()
            .map(|(name, reason)| PasteSkip {
                name,
                reason: reason.to_string(),
            })
            .collect(),
        source_display: source.source_display,
        notices: source
            .notices
            .iter()
            .map(|notice| notice.to_string())
            .collect(),
    })
}

pub(crate) fn parse_paste(
    ctx: &McpLibraryContext,
    request: McpParsePasteRequest,
) -> Result<McpPasteResult, McpError> {
    let outcome = mcp_paste::parse(&request.text)
        .map_err(|_| McpError::new("paste-too-large", "粘贴的内容太长了（超过 256 KB）。"))?;
    let format = outcome.format;
    let count = outcome.servers.len();
    candidates_from(
        ctx,
        CandidateSource {
            format,
            source: McpServerSource::Paste {
                format: format
                    .map(|format| format.as_str().to_string())
                    .unwrap_or_else(|| "mcp-servers".to_string()),
            },
            servers: outcome.servers,
            skipped: outcome.skipped,
            source_display: None,
            notices: Vec::new(),
            readme: false,
            preferred: vec![true; count],
        },
    )
}

// ---------------------------------------------------------------------------
// Connection-test support (the process work lives in `mcp_probe`)
// ---------------------------------------------------------------------------

/// What the probe needs: never returned to the webview as is.
pub(crate) struct TestTarget {
    pub server_id: String,
    pub spec: McpServerSpec,
    pub spec_revision: i64,
    pub secret_values: Vec<String>,
    pub key: [u8; 32],
}

pub(crate) fn load_test_target(
    ctx: &McpLibraryContext,
    server_id: &str,
) -> Result<TestTarget, McpError> {
    let connection = open_db(ctx)?;
    let servers = load_servers(&connection, false)?;
    let server = find_server(&servers, server_id)?;
    Ok(TestTarget {
        server_id: server.id.clone(),
        secret_values: server.spec.secret_values(&*ctx.env),
        spec: server.spec.clone(),
        spec_revision: server.spec_revision,
        key: hash_key(ctx)?,
    })
}

pub(crate) fn save_test_result(
    ctx: &McpLibraryContext,
    server_id: &str,
    spec_revision: i64,
    status: &str,
    tools_count: Option<u32>,
    message_code: &str,
    tested_at: &str,
) -> Result<(), McpError> {
    let connection = open_db(ctx)?;
    let stored = StoredTest {
        status: status.to_string(),
        tools_count,
        tested_at: tested_at.to_string(),
        message_code: message_code.to_string(),
        spec_revision,
    };
    connection
        .execute(
            "UPDATE mcp_servers SET test_json = ?2 WHERE id = ?1 AND deleted_at IS NULL",
            params![
                server_id,
                serde_json::to_string(&stored).unwrap_or_default()
            ],
        )
        .map_err(db_error)?;
    bump_generation();
    Ok(())
}

/// Effective literal environment for a test run: non-secret env, HKCU /
/// process values for references, and library values.
pub(crate) fn test_environment(
    ctx: &McpLibraryContext,
    spec: &McpServerSpec,
) -> (Vec<(String, String)>, Vec<String>) {
    let mut env = Vec::new();
    let mut missing = Vec::new();
    for item in &spec.env {
        let value = match item.storage {
            SecretStorage::Literal | SecretStorage::Library => item.value.clone(),
            SecretStorage::UserEnv | SecretStorage::External => {
                mcp_secrets::resolve_env_value(&*ctx.env, item.variable())
            }
        };
        match value {
            Some(value) => env.push((item.name.clone(), value)),
            None if item.secret => missing.push(item.name.clone()),
            None => {}
        }
    }
    (env, missing)
}

/// Resolved request headers for an HTTP test, and the names still missing.
pub(crate) fn test_headers(
    ctx: &McpLibraryContext,
    spec: &McpServerSpec,
) -> (Vec<(String, String)>, Vec<String>) {
    let mut headers = Vec::new();
    let mut missing = Vec::new();
    for header in &spec.headers {
        let value = match header.storage {
            SecretStorage::Literal | SecretStorage::Library => header.value.clone(),
            SecretStorage::UserEnv | SecretStorage::External => header
                .env_var
                .as_deref()
                .and_then(|variable| mcp_secrets::resolve_env_value(&*ctx.env, variable)),
        };
        match value {
            Some(value) if header.template == HeaderTemplate::Bearer => {
                headers.push((header.name.clone(), format!("Bearer {value}")))
            }
            Some(value) => headers.push((header.name.clone(), value)),
            None => missing.push(header.name.clone()),
        }
    }
    (headers, missing)
}

pub(crate) fn emit_payload(outcome: &McpWriteOutcome, reason: &str) -> Option<JsonValue> {
    match outcome {
        McpWriteOutcome::Done {
            operation_id,
            generation,
            ..
        } => Some(json!({
            "generation": generation,
            "operationId": operation_id,
            "reason": reason,
        })),
        _ => None,
    }
}

#[cfg(test)]
#[path = "mcp_library_tests.rs"]
mod tests;
