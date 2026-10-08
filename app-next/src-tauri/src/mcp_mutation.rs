//! Transactional MCP configuration mutations.
//!
//! This module never starts an MCP server and never accepts a filesystem path
//! from the webview. Callers provide a server-owned context (home, registered
//! workspaces and private state root) plus logical host/scope changes. Plans are
//! secret-free; existing inline values are preserved in memory and in short-lived
//! rollback blobs under the app-private state directory, but are never returned,
//! logged or written to the manifest. On Windows those blobs are protected with
//! the current user's DPAPI key.

use crate::mcp_center;
use crate::mcp_json_doc::{JsonDoc, Node, ObjectMap};
use serde::{Deserialize, Serialize};
#[cfg(test)]
use serde_json::Value as JsonValue;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};
use toml_edit::{
    value, Array, DocumentMut, InlineTable, Item, Table, TableLike, Value as TomlValue,
};
use uuid::Uuid;

const MAX_CONFIG_BYTES: u64 = 2 * 1024 * 1024;
const MAX_JOURNAL_BYTES: u64 = 1024 * 1024;
const MAX_CACHED_PLANS: usize = 64;
const MAX_PLAN_CACHE_BYTES: usize = 8 * 1024 * 1024;
const PLAN_CACHE_TTL_MS: u128 = 15 * 60 * 1000;
pub(crate) const SNAPSHOT_TTL_MS: u128 = 7 * 24 * 60 * 60 * 1000;
// v3.3: each library operation creates one snapshot per target file.
const MAX_ROLLBACK_SNAPSHOTS: usize = 64;
const MAX_SNAPSHOT_STORE_BYTES: u64 = 128 * 1024 * 1024;
const PLAN_SCHEMA_VERSION: u8 = 3;
/// Terminal state for an interrupted transaction whose target was changed
/// externally afterwards. It never blocks reads or later writes (bug MCP#2).
pub(crate) const ABANDONED_EXTERNAL_CHANGE: &str = "abandoned-external-change";

pub const HOST_CODEX: &str = "host-codex";
pub const HOST_CLAUDE_CODE: &str = "host-claude-code";
pub const HOST_CLAUDE_DESKTOP: &str = "host-claude-desktop";
pub const HOST_CURSOR: &str = "host-cursor";

/// MSIX package folder of Claude Desktop (same package path as lib.rs).
const CLAUDE_DESKTOP_PACKAGE_ROAMING: &str = "Packages/Claude_pzs8sxrjxfjjc/LocalCache/Roaming";

/// Trusted paths supplied by the Rust command wrapper, never by the webview.
#[derive(Debug, Clone)]
pub struct McpMutationContext {
    pub home_dir: PathBuf,
    pub registered_workspaces: Vec<mcp_center::RegisteredWorkspace>,
    pub private_state_dir: PathBuf,
    /// `CLAUDE_CONFIG_DIR` (process or HKCU) when set; `None` means `~`.
    pub claude_config_dir: Option<PathBuf>,
    /// `%APPDATA%` (Roaming) for Claude Desktop.
    pub app_data_dir: Option<PathBuf>,
    /// `%LOCALAPPDATA%` for the MSIX Claude Desktop package.
    pub local_app_data_dir: Option<PathBuf>,
}

impl McpMutationContext {
    /// A context with only the required paths; optional client locations are
    /// derived from `home_dir` the way Windows lays them out.
    #[allow(dead_code)]
    pub fn basic(
        home_dir: PathBuf,
        registered_workspaces: Vec<mcp_center::RegisteredWorkspace>,
        private_state_dir: PathBuf,
    ) -> Self {
        Self {
            home_dir,
            registered_workspaces,
            private_state_dir,
            claude_config_dir: None,
            app_data_dir: None,
            local_app_data_dir: None,
        }
    }

    fn app_data(&self) -> PathBuf {
        self.app_data_dir
            .clone()
            .unwrap_or_else(|| self.home_dir.join("AppData").join("Roaming"))
    }

    fn local_app_data(&self) -> PathBuf {
        self.local_app_data_dir
            .clone()
            .unwrap_or_else(|| self.home_dir.join("AppData").join("Local"))
    }

    /// The Claude Code user config file and its display form.
    pub(crate) fn claude_user_config(&self) -> (PathBuf, String) {
        match &self.claude_config_dir {
            Some(dir) => (
                dir.join(".claude.json"),
                redact_home_path(&dir.join(".claude.json"), &self.home_dir),
            ),
            None => (
                self.home_dir.join(".claude.json"),
                "~/.claude.json".to_string(),
            ),
        }
    }

    /// The Claude Desktop config directory: the MSIX LocalCache copy when that
    /// directory exists, otherwise `%APPDATA%\Claude`.
    pub(crate) fn claude_desktop_dir(&self) -> PathBuf {
        let packaged = self
            .local_app_data()
            .join(CLAUDE_DESKTOP_PACKAGE_ROAMING)
            .join("Claude");
        if fs::symlink_metadata(&packaged).is_ok_and(|meta| meta.is_dir()) {
            packaged
        } else {
            self.app_data().join("Claude")
        }
    }
}

/// `~`-relative display of a path; never a full path containing a user name.
pub(crate) fn redact_home_path(path: &Path, home: &Path) -> String {
    let normalize = |value: &Path| value.to_string_lossy().replace('\\', "/");
    let path_text = normalize(path);
    let home_text = normalize(home);
    let home_text = home_text.trim_end_matches('/');
    // `get` instead of slicing: a non-ASCII path outside the home folder
    // (for example a redirected %APPDATA% under D:\资料) must never panic on
    // a byte index inside a character. The prefix must also end at a folder
    // boundary, so `C:/Users/ab` never redacts `C:/Users/abc/…`.
    if let Some(prefix) = path_text
        .get(..home_text.len())
        .filter(|_| !home_text.is_empty())
    {
        let rest = &path_text[home_text.len()..];
        if prefix.eq_ignore_ascii_case(home_text) && (rest.is_empty() || rest.starts_with('/')) {
            return format!("~{rest}");
        }
    }
    path.file_name()
        .map(|name| format!("…/{}", name.to_string_lossy()))
        .unwrap_or_else(|| "…".to_string())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct McpMutationBatchRequest {
    pub changes: Vec<McpBindingChange>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct McpBindingChange {
    pub host_id: String,
    pub scope: String,
    #[serde(default)]
    pub workspace_id: Option<String>,
    pub action: String,
    pub server_name: String,
    #[serde(default)]
    pub draft: Option<McpBindingDraft>,
    #[serde(default)]
    pub enabled: Option<bool>,
}

/// Only references are accepted. There is intentionally no environment/header
/// value field in this public type.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct McpBindingDraft {
    pub transport: String,
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub env_vars: Vec<String>,
    #[serde(default)]
    pub header_env: Vec<McpHeaderEnvRef>,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub required: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct McpHeaderEnvRef {
    pub header_name: String,
    pub env_var_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpFieldDiff {
    pub target_id: String,
    pub host_id: String,
    pub scope: String,
    pub workspace_id: Option<String>,
    pub server_name: String,
    pub field: String,
    pub change: String,
    pub before: String,
    pub after: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpPlanTarget {
    pub id: String,
    pub host_id: String,
    pub scope: String,
    pub workspace_id: Option<String>,
    pub path_display: String,
    pub existed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpMutationPlan {
    pub plan_id: String,
    pub targets: Vec<McpPlanTarget>,
    pub diffs: Vec<McpFieldDiff>,
    pub requires_confirmation: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpApplyResult {
    pub plan_id: String,
    pub snapshot_id: String,
    pub changed_targets: usize,
    pub verified: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpRollbackResult {
    pub snapshot_id: String,
    pub restored_targets: usize,
    pub verified: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpRollbackSnapshot {
    pub snapshot_id: String,
    pub created_at_unix_ms: u128,
    pub expires_at_unix_ms: u128,
    pub target_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpMutationTargetOption {
    pub host_id: String,
    pub scope: String,
    pub workspace_id: Option<String>,
    pub workspace_label: Option<String>,
    pub path_display: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct FileFingerprint {
    exists: bool,
    byte_len: u64,
    sha256: String,
    modified_nanos: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredTarget {
    id: String,
    host_id: String,
    scope: String,
    workspace_id: Option<String>,
    path_display: String,
    path_binding_sha256: String,
    fingerprint: FileFingerprint,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredPlan {
    schema_version: u8,
    plan_id: String,
    created_at_unix_ms: u128,
    cache_nonce: String,
    targets: Vec<StoredTarget>,
    diffs: Vec<McpFieldDiff>,
}

#[derive(Debug, Clone)]
struct CachedPlan {
    created_at_unix_ms: u128,
    byte_len: usize,
    cache_nonce: String,
    request: McpMutationBatchRequest,
}

static PLAN_CACHE: OnceLock<Mutex<HashMap<String, CachedPlan>>> = OnceLock::new();

#[cfg(test)]
type AtomicReplaceTestHook = Option<(PathBuf, Vec<u8>)>;

#[cfg(test)]
static ATOMIC_REPLACE_TEST_HOOK: OnceLock<Mutex<AtomicReplaceTestHook>> = OnceLock::new();

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotTarget {
    id: String,
    host_id: String,
    scope: String,
    workspace_id: Option<String>,
    path_display: String,
    path_binding_sha256: String,
    original: FileFingerprint,
    planned: FileFingerprint,
    applied: Option<FileFingerprint>,
    backup_file_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotManifest {
    schema_version: u8,
    snapshot_id: String,
    plan_id: String,
    created_at_unix_ms: u128,
    expires_at_unix_ms: u128,
    #[serde(default = "committed_snapshot_state")]
    state: String,
    rolled_back: bool,
    targets: Vec<SnapshotTarget>,
    /// The user chose "keep the current files" for a stuck transaction.
    #[serde(default)]
    dismissed: bool,
}

#[derive(Debug, Clone)]
pub(crate) struct ResolvedTarget {
    id: String,
    host_id: String,
    scope: String,
    workspace_id: Option<String>,
    workspace_path: Option<PathBuf>,
    path: PathBuf,
    path_display: String,
}

impl ResolvedTarget {
    pub(crate) fn path(&self) -> &Path {
        &self.path
    }

    pub(crate) fn path_display(&self) -> &str {
        &self.path_display
    }
}

#[derive(Debug)]
struct ConfigFile {
    bytes: Vec<u8>,
    text: String,
    metadata: fs::Metadata,
    fingerprint: FileFingerprint,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct BindingSummary {
    exists: bool,
    enabled: bool,
    transport: String,
    required: bool,
    env_ref_count: usize,
    header_ref_count: usize,
}

struct TargetGroup<'a> {
    target: ResolvedTarget,
    changes: Vec<&'a McpBindingChange>,
}

struct PreparedWrite {
    target: ResolvedTarget,
    path_binding_sha256: String,
    verification: WriteVerification,
    original: Option<ConfigFile>,
    final_bytes: Vec<u8>,
    backup_path: Option<PathBuf>,
    applied_fingerprint: Option<FileFingerprint>,
}

/// Semantic read-back verification after the atomic write.
enum WriteVerification {
    Legacy(Vec<McpBindingChange>),
    Entries(Vec<EntryChange>),
}

impl WriteVerification {
    fn verify(&self, target: &ResolvedTarget, text: &str) -> Result<(), String> {
        match self {
            WriteVerification::Legacy(changes) => {
                let refs = changes.iter().collect::<Vec<_>>();
                verify_written_config(target, text, &refs)
            }
            WriteVerification::Entries(changes) => verify_entry_changes(target, text, changes),
        }
    }
}

struct RollbackPreparation {
    target: ResolvedTarget,
    post_plan: ConfigFile,
    original: Option<(PathBuf, Vec<u8>)>,
    restored_fingerprint: Option<FileFingerprint>,
}

struct CrashRecoveryItem {
    target: ResolvedTarget,
    current: Option<ConfigFile>,
    original: Option<Vec<u8>>,
    needs_restore: bool,
    externally_changed: bool,
}

pub(crate) struct CrossProcessMutationLock {
    file: File,
}

impl Drop for CrossProcessMutationLock {
    fn drop(&mut self) {
        let _ = self.file.unlock();
    }
}

fn default_true() -> bool {
    true
}

fn committed_snapshot_state() -> String {
    "committed".to_string()
}

pub fn plan_mcp_changes(
    context: &McpMutationContext,
    request: McpMutationBatchRequest,
) -> Result<McpMutationPlan, String> {
    validate_context(context)?;
    validate_batch(&request)?;
    let request_bytes =
        serde_json::to_vec(&request).map_err(|_| "MCP 计划内存摘要生成失败。".to_string())?;
    if request_bytes.len() > MAX_PLAN_CACHE_BYTES {
        return Err("MCP 变更计划过大，请拆分后重试。".to_string());
    }
    let groups = group_changes(context, &request)?;
    let mut targets = Vec::with_capacity(groups.len());
    let mut public_targets = Vec::with_capacity(groups.len());
    let mut diffs = Vec::new();

    for group in groups {
        let original = read_regular_config(&group.target.path, true)?;
        let original_text = original
            .as_ref()
            .map(|file| file.text.as_str())
            .unwrap_or_else(|| empty_config(&group.target));
        validate_host_document(&group.target, original_text)?;
        let final_text = apply_changes_to_text(&group.target, original_text, &group.changes)?;
        if final_text.len() as u64 > MAX_CONFIG_BYTES {
            return Err("MCP 配置变更后超过 2 MB，已停止。".to_string());
        }
        verify_written_config(&group.target, &final_text, &group.changes)?;
        diffs.extend(build_diffs(
            &group.target,
            original_text,
            &final_text,
            &group.changes,
        )?);
        let fingerprint = original
            .as_ref()
            .map(|file| file.fingerprint.clone())
            .unwrap_or_else(FileFingerprint::missing);
        public_targets.push(McpPlanTarget {
            id: group.target.id.clone(),
            host_id: group.target.host_id.clone(),
            scope: group.target.scope.clone(),
            workspace_id: group.target.workspace_id.clone(),
            path_display: group.target.path_display.clone(),
            existed: fingerprint.exists,
        });
        let path_binding_sha256 = target_path_binding(&group.target.path)?;
        targets.push(StoredTarget {
            id: group.target.id,
            host_id: group.target.host_id,
            scope: group.target.scope,
            workspace_id: group.target.workspace_id,
            path_display: group.target.path_display,
            path_binding_sha256,
            fingerprint,
        });
    }

    let created_at_unix_ms = now_unix_ms();
    let plan_id = format!("mcp-plan-{}", Uuid::new_v4().simple());
    let cache_nonce = Uuid::new_v4().simple().to_string();
    let stored = StoredPlan {
        schema_version: PLAN_SCHEMA_VERSION,
        plan_id: plan_id.clone(),
        created_at_unix_ms,
        cache_nonce: cache_nonce.clone(),
        targets,
        diffs: diffs.clone(),
    };
    let stored_bytes = serde_json::to_vec(&stored)
        .map_err(|_| "MCP 计划存储大小计算失败。".to_string())?
        .len() as u64;
    prune_plan_store(context, stored_bytes.saturating_add(64 * 1024), 1)?;
    write_protected_journal(&plan_path(context, &plan_id)?, &stored)?;
    cache_plan(
        &plan_id,
        CachedPlan {
            created_at_unix_ms,
            byte_len: request_bytes.len(),
            cache_nonce,
            request,
        },
    );
    Ok(McpMutationPlan {
        plan_id,
        targets: public_targets,
        diffs,
        requires_confirmation: true,
    })
}

pub fn list_mcp_mutation_targets(
    context: &McpMutationContext,
) -> Result<Vec<McpMutationTargetOption>, String> {
    validate_context(context)?;
    let mut options = Vec::new();
    let hosts_and_scopes = [
        (HOST_CODEX, "user", None),
        (HOST_CLAUDE_CODE, "user", None),
        (HOST_CLAUDE_DESKTOP, "user", None),
        (HOST_CURSOR, "user", None),
    ];
    for (host_id, scope, workspace_id) in hosts_and_scopes {
        if let Ok(target) = derive_target(
            context,
            &target_probe_change(host_id, scope, workspace_id.map(str::to_string)),
        ) {
            if target_accepts_static_mutation(&target) {
                options.push(target_option(target, None));
            }
        }
    }
    for workspace in &context.registered_workspaces {
        for (host_id, scope) in [
            (HOST_CODEX, "project"),
            (HOST_CLAUDE_CODE, "project"),
            (HOST_CLAUDE_CODE, "local"),
        ] {
            if let Ok(target) = derive_target(
                context,
                &target_probe_change(host_id, scope, Some(workspace.id.clone())),
            ) {
                if target_accepts_static_mutation(&target) {
                    options.push(target_option(target, Some(workspace.display_name.clone())));
                }
            }
        }
    }
    options.sort_by(|left, right| {
        left.scope
            .cmp(&right.scope)
            .then(left.workspace_label.cmp(&right.workspace_label))
            .then(left.host_id.cmp(&right.host_id))
    });
    Ok(options)
}

pub fn list_mcp_rollback_snapshots(
    context: &McpMutationContext,
) -> Result<Vec<McpRollbackSnapshot>, String> {
    validate_context(context)?;
    let _process_lock = acquire_cross_process_mutation_lock(context)?;
    recover_incomplete_snapshots(context)?;
    prune_snapshot_store(context, 0, 0)?;
    let mut snapshots = read_snapshot_manifests(context)?
        .into_iter()
        .filter(|(_, manifest, _)| {
            !manifest.rolled_back
                && manifest.state == "committed"
                && manifest.plan_id.starts_with("mcp-plan-")
        })
        .map(|(_, manifest, _)| McpRollbackSnapshot {
            snapshot_id: manifest.snapshot_id,
            created_at_unix_ms: manifest.created_at_unix_ms,
            expires_at_unix_ms: manifest.expires_at_unix_ms,
            target_count: manifest.targets.len(),
        })
        .collect::<Vec<_>>();
    snapshots.sort_by_key(|snapshot| std::cmp::Reverse(snapshot.created_at_unix_ms));
    Ok(snapshots)
}

fn target_probe_change(
    host_id: &str,
    scope: &str,
    workspace_id: Option<String>,
) -> McpBindingChange {
    McpBindingChange {
        host_id: host_id.to_string(),
        scope: scope.to_string(),
        workspace_id,
        action: "delete".to_string(),
        server_name: "target-probe".to_string(),
        draft: None,
        enabled: None,
    }
}

fn target_option(
    target: ResolvedTarget,
    workspace_label: Option<String>,
) -> McpMutationTargetOption {
    McpMutationTargetOption {
        host_id: target.host_id,
        scope: target.scope,
        workspace_id: target.workspace_id,
        workspace_label,
        path_display: target.path_display,
    }
}

fn target_accepts_static_mutation(target: &ResolvedTarget) -> bool {
    match read_regular_config(&target.path, true) {
        Ok(Some(file)) => validate_host_document(target, &file.text).is_ok(),
        Ok(None) => true,
        Err(_) => false,
    }
}

pub fn apply_mcp_plan(
    context: &McpMutationContext,
    plan_id: &str,
) -> Result<McpApplyResult, String> {
    apply_mcp_plan_internal(context, plan_id, None)
}

fn apply_mcp_plan_internal(
    context: &McpMutationContext,
    plan_id: &str,
    fail_after_write: Option<usize>,
) -> Result<McpApplyResult, String> {
    validate_context(context)?;
    let _process_lock = acquire_cross_process_mutation_lock(context)?;
    let result = apply_mcp_plan_once(context, plan_id, fail_after_write, true);
    remove_cached_plan(plan_id);
    let _ = remove_plan_journal(context, plan_id);
    result
}

fn apply_mcp_plan_once(
    context: &McpMutationContext,
    plan_id: &str,
    fail_after_write: Option<usize>,
    recover_on_error: bool,
) -> Result<McpApplyResult, String> {
    validate_context(context)?;
    recover_incomplete_snapshots(context)?;
    validate_stored_id(plan_id, "plan")?;
    let stored: StoredPlan = read_protected_journal(&plan_path(context, plan_id)?)?;
    if stored.schema_version != PLAN_SCHEMA_VERSION || stored.plan_id != plan_id {
        return Err("MCP 变更计划无效或版本不受支持。".to_string());
    }
    let cached =
        cached_plan(plan_id).ok_or_else(|| "MCP 变更计划已过期；请重新生成并确认。".to_string())?;
    if cached.cache_nonce != stored.cache_nonce {
        return Err("MCP 变更计划内存数据与落盘摘要不匹配。".to_string());
    }
    validate_batch(&cached.request)?;
    let groups = group_changes(context, &cached.request)?;
    if groups.len() != stored.targets.len() {
        return Err("MCP 变更目标已漂移，请重新生成计划。".to_string());
    }

    // Legacy preflight: plan journal, memory cache and recorded fingerprints.
    let snapshot_id = format!("mcp-snapshot-{}", plan_id.trim_start_matches("mcp-plan-"));
    let mut prepared = Vec::with_capacity(groups.len());
    for group in groups {
        let recorded = stored
            .targets
            .iter()
            .find(|target| target.id == group.target.id)
            .ok_or_else(|| "MCP 变更目标已漂移，请重新生成计划。".to_string())?;
        let path_binding_sha256 = target_path_binding(&group.target.path)?;
        if recorded.path_binding_sha256 != path_binding_sha256 {
            return Err("MCP 变更目标物理位置已漂移，请重新生成计划。".to_string());
        }
        let original = read_regular_config(&group.target.path, true)?;
        let actual = original
            .as_ref()
            .map(|file| file.fingerprint.clone())
            .unwrap_or_else(FileFingerprint::missing);
        if actual != recorded.fingerprint {
            return Err("MCP 配置在计划后发生变化；为避免覆盖，已停止写入。".to_string());
        }
        let original_text = original
            .as_ref()
            .map(|file| file.text.as_str())
            .unwrap_or_else(|| empty_config(&group.target));
        let final_text = apply_changes_to_text(&group.target, original_text, &group.changes)?;
        verify_written_config(&group.target, &final_text, &group.changes)?;
        prepared.push(PreparedWrite {
            target: group.target,
            path_binding_sha256,
            verification: WriteVerification::Legacy(group.changes.into_iter().cloned().collect()),
            original,
            final_bytes: final_text.into_bytes(),
            backup_path: None,
            applied_fingerprint: None,
        });
    }

    let changed_targets = prepared.len();
    execute_prepared_writes(
        context,
        &mut prepared,
        &snapshot_id,
        plan_id,
        fail_after_write,
        recover_on_error,
    )?;
    Ok(McpApplyResult {
        plan_id: plan_id.to_string(),
        snapshot_id,
        changed_targets,
        verified: true,
    })
}

/// The core executor shared by the legacy plan path and the v3.3 library:
/// protected snapshot store, DPAPI backups, manifest prepared → applying,
/// per-target fingerprint recheck, atomic write with an expected fingerprint,
/// byte and semantic read-back verification, manifest committed, and crash
/// recovery on error. Every target must already be preflighted.
fn execute_prepared_writes(
    context: &McpMutationContext,
    prepared: &mut [PreparedWrite],
    snapshot_id: &str,
    plan_id: &str,
    fail_after_write: Option<usize>,
    recover_on_error: bool,
) -> Result<(), String> {
    let backup_count = prepared
        .iter()
        .filter(|item| item.original.is_some())
        .count() as u64;
    let backup_bytes = prepared
        .iter()
        .filter_map(|item| item.original.as_ref())
        .map(|file| file.bytes.len() as u64)
        .sum::<u64>()
        .saturating_add(backup_count.saturating_mul(64 * 1024));
    prepare_snapshot_store(context, backup_bytes, snapshot_id)?;
    for (index, item) in prepared.iter_mut().enumerate() {
        let backup_result = if let Some(original) = &item.original {
            let backup_path = snapshot_backup_path(context, snapshot_id, index)?;
            create_private_backup(&backup_path, &original.bytes).map(|_| backup_path)
        } else {
            continue;
        };
        match backup_result {
            Ok(path) => item.backup_path = Some(path),
            Err(error) => {
                cleanup_snapshot_dir(context, snapshot_id);
                return Err(error);
            }
        }
    }

    let created_at_unix_ms = now_unix_ms();
    let mut manifest = SnapshotManifest {
        schema_version: PLAN_SCHEMA_VERSION,
        snapshot_id: snapshot_id.to_string(),
        plan_id: plan_id.to_string(),
        created_at_unix_ms,
        expires_at_unix_ms: created_at_unix_ms.saturating_add(SNAPSHOT_TTL_MS),
        state: "prepared".to_string(),
        rolled_back: false,
        targets: prepared
            .iter()
            .map(|item| SnapshotTarget {
                id: item.target.id.clone(),
                host_id: item.target.host_id.clone(),
                scope: item.target.scope.clone(),
                workspace_id: item.target.workspace_id.clone(),
                path_display: item.target.path_display.clone(),
                path_binding_sha256: item.path_binding_sha256.clone(),
                original: item
                    .original
                    .as_ref()
                    .map(|file| file.fingerprint.clone())
                    .unwrap_or_else(FileFingerprint::missing),
                planned: planned_fingerprint(&item.final_bytes),
                applied: None,
                backup_file_name: item
                    .backup_path
                    .as_ref()
                    .and_then(|path| path.file_name())
                    .map(|name| name.to_string_lossy().to_string()),
            })
            .collect(),
        dismissed: false,
    };
    let manifest_path = snapshot_manifest_path(context, snapshot_id)?;
    if let Err(error) = write_protected_journal(&manifest_path, &manifest) {
        cleanup_snapshot_dir(context, snapshot_id);
        return Err(error);
    }
    manifest.state = "applying".to_string();
    if let Err(error) = write_replaceable_protected_journal(&manifest_path, &manifest) {
        cleanup_snapshot_dir(context, snapshot_id);
        return Err(error);
    }

    let mut written = 0usize;
    let apply_result = (|| -> Result<(), String> {
        for (index, item) in prepared.iter_mut().enumerate() {
            let current = read_regular_config(&item.target.path, true)?;
            let current_fingerprint = current
                .as_ref()
                .map(|file| file.fingerprint.clone())
                .unwrap_or_else(FileFingerprint::missing);
            let expected = item
                .original
                .as_ref()
                .map(|file| file.fingerprint.clone())
                .unwrap_or_else(FileFingerprint::missing);
            if current_fingerprint != expected {
                return Err("MCP 配置在应用期间发生变化；已恢复已写目标。".to_string());
            }
            write_atomic(
                &item.target.path,
                &item.final_bytes,
                item.original.as_ref(),
                snapshot_id,
                Some(&expected),
            )?;
            written += 1;
            let written_file = read_regular_config(&item.target.path, false)?
                .ok_or_else(|| "MCP 写后验证未找到目标文件。".to_string())?;
            if written_file.bytes != item.final_bytes {
                return Err("MCP 写后字节验证失败。".to_string());
            }
            item.verification.verify(&item.target, &written_file.text)?;
            item.applied_fingerprint = Some(written_file.fingerprint.clone());
            manifest.targets[index].applied = Some(written_file.fingerprint);
            write_replaceable_protected_journal(&manifest_path, &manifest)?;
            if fail_after_write == Some(written) {
                return Err("测试注入：MCP 批量写入中断。".to_string());
            }
        }
        manifest.state = "committed".to_string();
        write_replaceable_protected_journal(&manifest_path, &manifest)?;
        Ok(())
    })();

    if let Err(error) = apply_result {
        if !recover_on_error {
            return Err(error);
        }
        if written == 0 {
            // Nothing reached a target file: drop the unused snapshot instead
            // of leaving a transaction that looks interrupted.
            cleanup_snapshot_dir(context, snapshot_id);
            return Err(error);
        }
        return match recover_incomplete_snapshot(context, snapshot_id) {
            Ok(RecoveryOutcome::Restored) => Err(error),
            Ok(RecoveryOutcome::ExternallyChanged) => Err(format!(
                "{error}；目标文件在中断后又被外部修改，已保留外部改动。"
            )),
            Err(restore_error) => Err(format!(
                "{error}；崩溃安全恢复已停止（{restore_error}）。受保护恢复数据仍保存在应用私有状态中；请先处理外部改动后重新扫描。"
            )),
        };
    }
    Ok(())
}

/// Result of crash recovery for one interrupted transaction.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RecoveryOutcome {
    /// Every target is back to its original bytes; the snapshot was removed.
    Restored,
    /// At least one target was changed outside SkillHub after the interruption.
    /// That target was kept as is; the others were restored. The manifest is
    /// now in the terminal `abandoned-external-change` state (bug MCP#2).
    ExternallyChanged,
}

/// Recovers interrupted transactions before a write. Never fatal: a manifest
/// that cannot be recovered stays visible as a stuck transaction and no longer
/// blocks later reads or writes (bug MCP#2).
fn recover_incomplete_snapshots(context: &McpMutationContext) -> Result<(), String> {
    let pending = read_snapshot_manifests(context)?
        .into_iter()
        .filter(|(_, manifest, _)| manifest_is_pending(manifest))
        .map(|(_, manifest, _)| manifest.snapshot_id)
        .collect::<Vec<_>>();
    for snapshot_id in pending {
        let _ = recover_incomplete_snapshot(context, &snapshot_id);
    }
    Ok(())
}

fn manifest_is_pending(manifest: &SnapshotManifest) -> bool {
    !manifest.rolled_back
        && manifest.state != "committed"
        && manifest.state != ABANDONED_EXTERNAL_CHANGE
        && !manifest.dismissed
}

/// Public entry point for the v3.3 library write path (runs only inside write
/// commands, never during reads).
pub(crate) fn recover_before_write(context: &McpMutationContext) -> Result<(), String> {
    validate_context(context)?;
    recover_incomplete_snapshots(context)
}

fn recover_incomplete_snapshot(
    context: &McpMutationContext,
    snapshot_id: &str,
) -> Result<RecoveryOutcome, String> {
    let manifest_path = snapshot_manifest_path(context, snapshot_id)?;
    let mut manifest: SnapshotManifest = read_protected_journal(&manifest_path)?;
    if manifest.schema_version != PLAN_SCHEMA_VERSION || manifest.snapshot_id != snapshot_id {
        return Err("MCP 崩溃恢复清单无效或版本不受支持。".to_string());
    }
    if manifest.rolled_back || manifest.state == "committed" {
        return Ok(RecoveryOutcome::Restored);
    }
    if manifest.state == ABANDONED_EXTERNAL_CHANGE {
        return Ok(RecoveryOutcome::ExternallyChanged);
    }

    let preflight = (|| -> Result<Vec<CrashRecoveryItem>, String> {
        let mut items = Vec::with_capacity(manifest.targets.len());
        for recorded in &manifest.targets {
            let change_stub = McpBindingChange {
                host_id: recorded.host_id.clone(),
                scope: recorded.scope.clone(),
                workspace_id: recorded.workspace_id.clone(),
                action: "delete".to_string(),
                server_name: "snapshot-recovery".to_string(),
                draft: None,
                enabled: None,
            };
            let target = derive_target(context, &change_stub)?;
            if target.id != recorded.id
                || target.path_display != recorded.path_display
                || target_path_binding(&target.path)? != recorded.path_binding_sha256
            {
                return Err("MCP 崩溃恢复目标物理位置已漂移。".to_string());
            }
            cleanup_known_atomic_temp(&target.path, snapshot_id, recorded)?;
            let current = read_regular_config(&target.path, true)?;
            let current_fingerprint = current
                .as_ref()
                .map(|file| file.fingerprint.clone())
                .unwrap_or_else(FileFingerprint::missing);
            let already_original = same_file_content(&current_fingerprint, &recorded.original);
            let matches_applied = recorded
                .applied
                .as_ref()
                .is_some_and(|applied| same_file_content(&current_fingerprint, applied));
            let matches_planned = same_file_content(&current_fingerprint, &recorded.planned);
            let externally_changed = !already_original && !matches_applied && !matches_planned;
            let needs_restore = !already_original && !externally_changed;
            let original = if needs_restore && recorded.original.exists {
                let backup_name = recorded
                    .backup_file_name
                    .as_deref()
                    .ok_or_else(|| "MCP 崩溃恢复备份记录不完整。".to_string())?;
                validate_artifact_file_name(backup_name)?;
                let backup_path = snapshot_backup_path_by_name(context, snapshot_id, backup_name)?;
                let backup = read_private_backup(&backup_path)?;
                if backup.len() as u64 != recorded.original.byte_len
                    || sha256_hex(&backup) != recorded.original.sha256
                {
                    return Err("MCP 崩溃恢复备份校验失败。".to_string());
                }
                Some(backup)
            } else {
                None
            };
            items.push(CrashRecoveryItem {
                target,
                current,
                original,
                needs_restore,
                externally_changed,
            });
        }
        Ok(items)
    })();

    let mut items = match preflight {
        Ok(items) => items,
        Err(error) => {
            manifest.state = "recovery-needed".to_string();
            let _ = write_replaceable_protected_journal(&manifest_path, &manifest);
            return Err(error);
        }
    };
    manifest.state = "recovering".to_string();
    write_replaceable_protected_journal(&manifest_path, &manifest)?;

    for item in &mut items {
        if !item.needs_restore {
            continue;
        }
        let expected = item
            .current
            .as_ref()
            .map(|file| file.fingerprint.clone())
            .unwrap_or_else(FileFingerprint::missing);
        ensure_target_fingerprint(
            &item.target.path,
            &expected,
            "MCP 配置在崩溃恢复确认后又被外部修改；已停止且不会覆盖外部改动。",
        )?;
        if let Some(original) = &item.original {
            write_atomic(
                &item.target.path,
                original,
                item.current.as_ref(),
                snapshot_id,
                Some(&expected),
            )?;
        } else if item.current.is_some() {
            ensure_target_fingerprint(
                &item.target.path,
                &expected,
                "MCP 配置在崩溃恢复删除前又被外部修改；已停止且不会覆盖外部改动。",
            )?;
            fs::remove_file(&item.target.path)
                .map_err(|_| "MCP 崩溃恢复无法移除新建配置。".to_string())?;
        }
    }

    let mut any_external = false;
    for (item, recorded) in items.iter().zip(&manifest.targets) {
        if item.externally_changed {
            any_external = true;
            continue;
        }
        let restored =
            current_fingerprint(&item.target.path)?.unwrap_or_else(FileFingerprint::missing);
        if !same_file_content(&restored, &recorded.original) {
            manifest.state = "recovery-needed".to_string();
            let _ = write_replaceable_protected_journal(&manifest_path, &manifest);
            return Err(format!("{} 未能恢复到原始内容", recorded.path_display));
        }
    }
    if any_external {
        manifest.state = ABANDONED_EXTERNAL_CHANGE.to_string();
        write_replaceable_protected_journal(&manifest_path, &manifest)?;
        return Ok(RecoveryOutcome::ExternallyChanged);
    }
    cleanup_snapshot_dir(context, snapshot_id);
    Ok(RecoveryOutcome::Restored)
}

pub fn rollback_mcp_snapshot(
    context: &McpMutationContext,
    snapshot_id: &str,
) -> Result<McpRollbackResult, String> {
    validate_context(context)?;
    let _process_lock = acquire_cross_process_mutation_lock(context)?;
    rollback_mcp_snapshot_once(context, snapshot_id, None, true)
}

fn rollback_mcp_snapshot_once(
    context: &McpMutationContext,
    snapshot_id: &str,
    fail_after_restore: Option<usize>,
    recover_on_error: bool,
) -> Result<McpRollbackResult, String> {
    validate_context(context)?;
    recover_incomplete_snapshots(context)?;
    validate_stored_id(snapshot_id, "snapshot")?;
    let manifest_path = snapshot_manifest_path(context, snapshot_id)?;
    let mut manifest: SnapshotManifest = read_protected_journal(&manifest_path)?;
    if manifest.schema_version != PLAN_SCHEMA_VERSION || manifest.snapshot_id != snapshot_id {
        return Err("MCP 回滚快照无效或版本不受支持。".to_string());
    }
    if manifest.rolled_back {
        return Err("这个 MCP 快照已经回滚。".to_string());
    }
    if manifest.state != "committed" {
        return Err("这个 MCP 快照仍处于恢复状态；请先重新扫描。".to_string());
    }
    if now_unix_ms() > manifest.expires_at_unix_ms {
        cleanup_snapshot_dir(context, snapshot_id);
        return Err("这个 MCP 回滚快照已按 7 天保留策略过期并清理。".to_string());
    }

    let mut prepared = Vec::with_capacity(manifest.targets.len());
    for recorded in &manifest.targets {
        let change_stub = McpBindingChange {
            host_id: recorded.host_id.clone(),
            scope: recorded.scope.clone(),
            workspace_id: recorded.workspace_id.clone(),
            action: "delete".to_string(),
            server_name: "snapshot-validation".to_string(),
            draft: None,
            enabled: None,
        };
        let target = derive_target(context, &change_stub)?;
        if target.id != recorded.id
            || target.path_display != recorded.path_display
            || target_path_binding(&target.path)? != recorded.path_binding_sha256
        {
            return Err("MCP 快照目标已漂移，已停止回滚。".to_string());
        }
        let current = read_regular_config(&target.path, false)?
            .ok_or_else(|| "MCP 配置已被外部删除，已停止回滚。".to_string())?;
        let applied = recorded
            .applied
            .as_ref()
            .ok_or_else(|| "MCP 已提交快照缺少写后指纹。".to_string())?;
        if current.fingerprint != *applied {
            return Err("MCP 配置在应用后又发生变化；为避免覆盖，已停止回滚。".to_string());
        }
        let original_bytes = if recorded.original.exists {
            let backup_name = recorded
                .backup_file_name
                .as_deref()
                .ok_or_else(|| "MCP 回滚备份记录不完整。".to_string())?;
            validate_artifact_file_name(backup_name)?;
            let backup_path = snapshot_backup_path_by_name(context, snapshot_id, backup_name)?;
            let backup = read_private_backup(&backup_path)?;
            if sha256_hex(&backup) != recorded.original.sha256
                || backup.len() as u64 != recorded.original.byte_len
            {
                return Err("MCP 回滚备份校验失败。".to_string());
            }
            Some((backup_path, backup))
        } else {
            None
        };
        prepared.push(RollbackPreparation {
            target,
            post_plan: current,
            original: original_bytes,
            restored_fingerprint: None,
        });
    }

    manifest.state = "rolling-back".to_string();
    write_replaceable_protected_journal(&manifest_path, &manifest)?;
    let mut restored = 0usize;
    let rollback_result = (|| -> Result<(), String> {
        for item in &mut prepared {
            ensure_target_fingerprint(
                &item.target.path,
                &item.post_plan.fingerprint,
                "MCP 配置在回滚确认后又被外部修改；已停止且不会覆盖外部改动。",
            )?;
            if let Some((_backup_path, backup)) = &item.original {
                write_atomic(
                    item.target.path.as_path(),
                    backup,
                    Some(&item.post_plan),
                    snapshot_id,
                    Some(&item.post_plan.fingerprint),
                )?;
            } else {
                fs::remove_file(&item.target.path)
                    .map_err(|_| "无法移除由 MCP 计划新建的配置文件。".to_string())?;
            }
            item.restored_fingerprint = Some(
                current_fingerprint(&item.target.path)?.unwrap_or_else(FileFingerprint::missing),
            );
            restored += 1;
            if fail_after_restore == Some(restored) {
                return Err("测试注入：MCP 回滚中断。".to_string());
            }
        }

        for item in &prepared {
            if let Some((_backup_path, backup)) = &item.original {
                let restored_file = read_regular_config(&item.target.path, false)?
                    .ok_or_else(|| "MCP 回滚后未找到配置文件。".to_string())?;
                if restored_file.bytes != *backup {
                    return Err("MCP 回滚后字节验证失败。".to_string());
                }
                validate_host_document(&item.target, &restored_file.text)?;
            } else if fs::symlink_metadata(&item.target.path).is_ok() {
                return Err("MCP 新建配置回滚后仍存在。".to_string());
            }
        }
        Ok(())
    })();
    if let Err(error) = rollback_result {
        if !recover_on_error {
            return Err(error);
        }
        return match restore_post_plan_state(&prepared, restored, snapshot_id) {
            Ok(()) => {
                manifest.state = "committed".to_string();
                write_replaceable_protected_journal(&manifest_path, &manifest)?;
                Err(error)
            }
            Err(recovery_error) => {
                manifest.state = "recovery-needed".to_string();
                let _ = write_replaceable_protected_journal(&manifest_path, &manifest);
                Err(format!(
                    "{error}；回滚事务恢复已安全停止（{recovery_error}）。不会覆盖外部改动，受保护快照仍保留在应用私有状态中。"
                ))
            }
        };
    }

    manifest.rolled_back = true;
    manifest.state = "rolled-back".to_string();
    if let Err(error) = write_replaceable_protected_journal(&manifest_path, &manifest) {
        return match recover_incomplete_snapshot(context, snapshot_id) {
            Ok(_) => Err(error),
            Err(recovery_error) => Err(format!(
                "{error}；回滚完成状态恢复已安全停止（{recovery_error}）。不会覆盖外部改动，受保护快照仍保留在应用私有状态中。"
            )),
        };
    }
    cleanup_snapshot_dir(context, snapshot_id);
    Ok(McpRollbackResult {
        snapshot_id: snapshot_id.to_string(),
        restored_targets: restored,
        verified: true,
    })
}

impl FileFingerprint {
    fn missing() -> Self {
        Self {
            exists: false,
            byte_len: 0,
            sha256: String::new(),
            modified_nanos: 0,
        }
    }
}

fn planned_fingerprint(bytes: &[u8]) -> FileFingerprint {
    FileFingerprint {
        exists: true,
        byte_len: bytes.len() as u64,
        sha256: sha256_hex(bytes),
        modified_nanos: 0,
    }
}

fn same_file_content(left: &FileFingerprint, right: &FileFingerprint) -> bool {
    left.exists == right.exists
        && (!left.exists || (left.byte_len == right.byte_len && left.sha256 == right.sha256))
}

fn validate_context(context: &McpMutationContext) -> Result<(), String> {
    if !context.home_dir.is_absolute() || !context.private_state_dir.is_absolute() {
        return Err("MCP 写入上下文不是绝对路径。".to_string());
    }
    validate_existing_directory(&context.home_dir, "用户目录")?;
    for workspace in &context.registered_workspaces {
        if !workspace.path.is_absolute() || workspace.id.trim().is_empty() {
            return Err("MCP 已注册工作区无效。".to_string());
        }
        validate_existing_directory(&workspace.path, "工作区")?;
    }
    ensure_private_directory(&context.private_state_dir)?;
    Ok(())
}

fn validate_existing_directory(path: &Path, label: &str) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path).map_err(|_| format!("{label}不存在或不可读。"))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(format!("{label}不是可写入的普通目录。"));
    }
    Ok(())
}

fn validate_batch(request: &McpMutationBatchRequest) -> Result<(), String> {
    if request.changes.is_empty() || request.changes.len() > 64 {
        return Err("一次 MCP 计划必须包含 1–64 项变更。".to_string());
    }
    let mut seen = HashSet::new();
    for change in &request.changes {
        validate_change(change)?;
        let key = format!(
            "{}|{}|{}|{}",
            change.host_id,
            change.scope,
            change.workspace_id.as_deref().unwrap_or_default(),
            change.server_name.to_ascii_lowercase()
        );
        if !seen.insert(key) {
            return Err("同一 MCP Binding 在一个计划中只能变更一次。".to_string());
        }
    }
    Ok(())
}

fn is_known_host(host_id: &str) -> bool {
    matches!(
        host_id,
        HOST_CODEX | HOST_CLAUDE_CODE | HOST_CLAUDE_DESKTOP | HOST_CURSOR
    )
}

fn is_json_host(host_id: &str) -> bool {
    matches!(
        host_id,
        HOST_CLAUDE_CODE | HOST_CLAUDE_DESKTOP | HOST_CURSOR
    )
}

fn validate_change(change: &McpBindingChange) -> Result<(), String> {
    if !is_known_host(&change.host_id) {
        return Err(
            "仅支持 Codex、Claude Code、Claude Desktop 与 Cursor 的 MCP 配置。".to_string(),
        );
    }
    validate_server_name(&change.host_id, &change.server_name)?;
    match change.action.as_str() {
        "upsert" => {
            if change.enabled.is_some() {
                return Err("upsert 请在草稿中提供 enabled。".to_string());
            }
            let draft = change
                .draft
                .as_ref()
                .ok_or_else(|| "新增或编辑 MCP Server 需要完整草稿。".to_string())?;
            validate_draft(change, draft)?;
        }
        "delete" => {
            if change.draft.is_some() || change.enabled.is_some() {
                return Err("删除 MCP Server 不接受草稿或 enabled 字段。".to_string());
            }
        }
        "set-enabled" => {
            // Engine invariant: only Codex has an `enabled` flag. JSON clients
            // express enable/disable as upsert/remove at the library layer.
            if change.host_id != HOST_CODEX {
                return Err("Claude Code 启停状态按项目管理；当前版本不支持直接修改。".to_string());
            }
            if change.draft.is_some() || change.enabled.is_none() {
                return Err("启停 MCP Server 只接受 enabled 状态。".to_string());
            }
        }
        _ => return Err("不支持的 MCP 变更动作。".to_string()),
    }
    Ok(())
}

pub(crate) const CLAUDE_RESERVED_NAMES: [&str; 5] = [
    "workspace",
    "claude-in-chrome",
    "computer-use",
    "claude preview",
    "claude browser",
];

fn validate_server_name(host_id: &str, value: &str) -> Result<(), String> {
    if host_id == HOST_CLAUDE_CODE
        && CLAUDE_RESERVED_NAMES
            .iter()
            .any(|reserved| value.eq_ignore_ascii_case(reserved))
    {
        return Err("这个名称由 Claude Code 保留，请使用其他 MCP Server 名称。".to_string());
    }
    let allowed_punctuation = if is_json_host(host_id) {
        b"_-".as_slice()
    } else {
        b"._-".as_slice()
    };
    let valid = !value.is_empty()
        && value.len() <= 64
        && value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_alphanumeric() || (index > 0 && allowed_punctuation.contains(&byte))
        });
    if valid {
        Ok(())
    } else if is_json_host(host_id) {
        Err(
            "Claude Code MCP Server 名称只能使用 1–64 个字母、数字、下划线或短横线，并以字母或数字开头。"
                .to_string(),
        )
    } else {
        Err(
            "MCP Server 名称只能使用 1–64 个字母、数字、点、下划线或短横线，并以字母或数字开头。"
                .to_string(),
        )
    }
}

fn validate_draft(change: &McpBindingChange, draft: &McpBindingDraft) -> Result<(), String> {
    if !matches!(draft.transport.as_str(), "stdio" | "http" | "sse") {
        return Err("MCP transport 只能是 stdio、http 或 sse。".to_string());
    }
    if is_json_host(&change.host_id) && draft.required {
        return Err("Claude Code Binding 不支持 required 字段。".to_string());
    }
    if is_json_host(&change.host_id) && !draft.enabled {
        return Err(
            "Claude Code 启停状态按项目管理；新增或编辑时 enabled 必须为 true。".to_string(),
        );
    }
    if change.host_id == HOST_CODEX && draft.transport == "sse" {
        return Err("Codex Binding 不支持独立 sse transport；请使用 http。".to_string());
    }
    if change.host_id == HOST_CLAUDE_DESKTOP {
        if draft.transport != "stdio" {
            return Err("Claude Desktop 只支持本地命令方式的 MCP。".to_string());
        }
        if !draft.env_vars.is_empty() || !draft.header_env.is_empty() {
            return Err("Claude Desktop 不支持引用环境变量。".to_string());
        }
    }
    match draft.transport.as_str() {
        "stdio" => {
            let command = draft
                .command
                .as_deref()
                .ok_or_else(|| "stdio MCP Server 必须提供 command。".to_string())?;
            validate_command(command)?;
            if command.starts_with('-') || draft.url.is_some() {
                return Err("stdio MCP Server 的 command/url 组合无效。".to_string());
            }
            if !draft.header_env.is_empty() {
                // Bug MCP#1: header references are meaningless for stdio and
                // Codex refuses `env_http_headers` on stdio servers.
                return Err("本地命令方式的 MCP 不接受请求头引用。".to_string());
            }
        }
        "http" | "sse" => {
            let url = draft
                .url
                .as_deref()
                .ok_or_else(|| "远程 MCP Server 必须提供 URL。".to_string())?;
            validate_safe_url(url)?;
            if draft.command.is_some() || !draft.args.is_empty() || !draft.env_vars.is_empty() {
                return Err("远程 MCP Server 不接受 command、args 或进程环境变量。".to_string());
            }
        }
        _ => unreachable!(),
    }
    if draft.args.len() > 64 || draft.env_vars.len() > 64 || draft.header_env.len() > 64 {
        return Err("MCP 参数或引用数量超过上限。".to_string());
    }
    validate_arguments(&draft.args)?;
    let mut env_seen = HashSet::new();
    for name in &draft.env_vars {
        validate_env_name(name)?;
        if !env_seen.insert(name.to_ascii_uppercase()) {
            return Err("MCP 环境变量引用重复。".to_string());
        }
    }
    let mut header_seen = HashSet::new();
    for reference in &draft.header_env {
        validate_header_name(&reference.header_name)?;
        validate_env_name(&reference.env_var_name)?;
        if !header_seen.insert(reference.header_name.to_ascii_lowercase()) {
            return Err("MCP Header 引用重复。".to_string());
        }
    }
    Ok(())
}

pub(crate) fn validate_plain_field(value: &str, max: usize, label: &str) -> Result<(), String> {
    if value.is_empty()
        || value.chars().count() > max
        || value
            .chars()
            .any(|ch| ch.is_control() || matches!(ch, '\r' | '\n'))
    {
        return Err(format!("MCP {label} 字段无效。"));
    }
    Ok(())
}

/// Strict command validation: a direct executable, never a shell or script
/// host. Callers that pass only the command keep this behaviour.
pub(crate) fn validate_command(value: &str) -> Result<(), String> {
    validate_plain_field(value, 512, "command")?;
    if value.trim() != value
        || value.contains(['"', '\'', '`', '&', '|', ';', '>', '<'])
        || value.contains("$(")
        || value.contains("${")
        || has_common_secret_prefix(value)
    {
        return Err("MCP command 包含高风险内容；请只填写直接可执行文件。".to_string());
    }
    if value.chars().any(char::is_whitespace) && !Path::new(value).is_absolute() {
        return Err("MCP command 不接受命令拼接；参数请逐项填写。".to_string());
    }
    let executable = command_stem(value);
    if matches!(
        executable.as_str(),
        "cmd"
            | "powershell"
            | "pwsh"
            | "sh"
            | "bash"
            | "zsh"
            | "fish"
            | "wscript"
            | "cscript"
            | "mshta"
            | "rundll32"
    ) {
        return Err("MCP 命令不能是 shell 或脚本解释器。".to_string());
    }
    Ok(())
}

/// The lowercase file stem of a command with `.exe`, `.cmd`, `.bat` and
/// `.com` stripped (`C:\nodejs\npx.cmd` → `npx`).
pub(crate) fn command_stem(value: &str) -> String {
    let file = value
        .trim()
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(value)
        .to_ascii_lowercase();
    for suffix in [".exe", ".cmd", ".bat", ".com"] {
        if let Some(stripped) = file.strip_suffix(suffix) {
            return stripped.to_string();
        }
    }
    file
}

/// Windows runners that need `cmd /c` to start from a GUI host (§2.5).
pub(crate) const WINDOWS_WRAP_FAMILY: [&str; 7] =
    ["npx", "npm", "pnpm", "yarn", "node", "bun", "deno"];

pub(crate) fn is_wrap_family(command: &str) -> bool {
    WINDOWS_WRAP_FAMILY.contains(&command_stem(command).as_str())
}

/// Like [`validate_command`], with one exception: `cmd` / `cmd.exe` is
/// accepted only as `cmd /c <family runner> …`, and then no following
/// argument may contain a character `cmd` interprets (bug #5).
pub(crate) fn validate_command_with_args(command: &str, args: &[String]) -> Result<(), String> {
    if command_stem(command) != "cmd" {
        return validate_command(command);
    }
    validate_plain_field(command, 512, "command")?;
    if !(command.eq_ignore_ascii_case("cmd") || command.eq_ignore_ascii_case("cmd.exe")) {
        return Err("MCP 命令不能是 shell 或脚本解释器。".to_string());
    }
    let valid_wrapper = args.len() >= 2
        && args[0].eq_ignore_ascii_case("/c")
        && is_wrap_family(&args[1])
        && validate_command(&args[1]).is_ok();
    if !valid_wrapper {
        return Err(
            "cmd 只能以 cmd /c npx（或 npm、pnpm、yarn、node、bun、deno）的形式使用。".to_string(),
        );
    }
    if args[1..].iter().any(|argument| {
        argument.contains(['&', '|', '<', '>', '^', '%', '"', '(', ')', '!', '\r', '\n'])
    }) {
        return Err("cmd /c 后的参数包含 cmd 会解释的特殊字符，已拒绝。".to_string());
    }
    Ok(())
}

pub(crate) fn validate_arguments(arguments: &[String]) -> Result<(), String> {
    let mut index = 0usize;
    while index < arguments.len() {
        let argument = &arguments[index];
        validate_plain_field(argument, 512, "argument")?;
        if argument == "--env" || argument == "-e" {
            let env_name = arguments
                .get(index + 1)
                .ok_or_else(|| "MCP --env 只接受环境变量名称引用。".to_string())?;
            validate_plain_field(env_name, 128, "environment variable")?;
            if validate_env_name(env_name).is_err() {
                return Err("MCP --env 只接受环境变量名称引用。".to_string());
            }
            index += 2;
            continue;
        }
        if has_common_secret_prefix(argument)
            || is_sensitive_argument_key(argument)
            || is_sensitive_assignment(argument)
            || argument.trim() == "-H"
        {
            return Err("MCP 参数疑似包含凭据；请改用环境变量引用。".to_string());
        }
        index += 1;
    }
    Ok(())
}

pub(crate) fn is_sensitive_assignment(value: &str) -> bool {
    let Some((name, _)) = value.split_once('=') else {
        return false;
    };
    let normalized = name
        .trim()
        .trim_start_matches('-')
        .replace('-', "_")
        .to_ascii_lowercase();
    matches!(
        normalized.as_str(),
        "token"
            | "secret"
            | "password"
            | "passwd"
            | "api_key"
            | "apikey"
            | "access_token"
            | "auth_token"
            | "authorization"
            | "credential"
            | "credentials"
    ) || normalized.ends_with("_token")
        || normalized.ends_with("_secret")
        || normalized.ends_with("_password")
        || normalized.ends_with("_passwd")
        || normalized.ends_with("_api_key")
        || normalized.ends_with("_credential")
        || normalized.ends_with("_credentials")
}

pub(crate) fn is_sensitive_argument_key(value: &str) -> bool {
    let key = value
        .split_once('=')
        .map(|(key, _)| key)
        .unwrap_or(value)
        .trim()
        .to_ascii_lowercase();
    matches!(
        key.as_str(),
        "--api-key"
            | "--apikey"
            | "--key"
            | "--token"
            | "--access-token"
            | "--auth-token"
            | "--auth"
            | "--authorization"
            | "--secret"
            | "--password"
            | "--passwd"
            | "--credential"
            | "--credentials"
            | "--header"
            | "--headers"
            | "--env"
            | "/key"
            | "/token"
            | "/password"
    )
}

pub(crate) fn has_common_secret_prefix(value: &str) -> bool {
    let candidate = value.trim().trim_matches(['"', '\'']).to_ascii_lowercase();
    let prefixes = [
        "sk-",
        "sk_",
        "rk-",
        "ghp_",
        "gho_",
        "ghu_",
        "ghs_",
        "github_pat_",
        "glpat-",
        "xoxb-",
        "xoxp-",
        "xapp-",
    ];
    let credential = candidate
        .split_once('=')
        .map(|(_, value)| value)
        .unwrap_or(candidate.as_str());
    prefixes.iter().any(|prefix| credential.starts_with(prefix))
        || ((credential.starts_with("akia") || credential.starts_with("asia"))
            && credential.len() >= 16)
        || (credential.starts_with("eyj") && credential.matches('.').count() == 2)
}

pub(crate) fn validate_safe_url(value: &str) -> Result<(), String> {
    validate_plain_field(value, 2048, "URL")?;
    let lower = value.to_ascii_lowercase();
    if !(lower.starts_with("https://") || lower.starts_with("http://"))
        || value.contains('?')
        || value.contains('#')
        || value.contains('%')
        || has_common_secret_prefix(value)
    {
        return Err("MCP URL 必须是无 query/fragment 的 http(s) 地址。".to_string());
    }
    let authority = value
        .split_once("://")
        .map(|(_, tail)| tail.split('/').next().unwrap_or_default())
        .unwrap_or_default();
    let path = value
        .split_once("://")
        .map(|(_, tail)| {
            tail.split_once('/')
                .map(|(_, path)| path)
                .unwrap_or_default()
        })
        .unwrap_or_default();
    if authority.is_empty()
        || authority.contains('@')
        || path.split('/').any(has_common_secret_prefix)
    {
        return Err("MCP URL 不得包含内联凭据。".to_string());
    }
    Ok(())
}

fn validate_env_name(value: &str) -> Result<(), String> {
    let mut chars = value.chars();
    let first = chars.next();
    let valid = value.len() <= 128
        && first.is_some_and(|ch| ch == '_' || ch.is_ascii_alphabetic())
        && chars.all(|ch| ch == '_' || ch.is_ascii_alphanumeric());
    if valid {
        Ok(())
    } else {
        Err("MCP 环境变量名称无效。".to_string())
    }
}

pub(crate) fn validate_header_name(value: &str) -> Result<(), String> {
    let valid = !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-');
    if valid {
        Ok(())
    } else {
        Err("MCP Header 名称无效。".to_string())
    }
}

fn group_changes<'a>(
    context: &McpMutationContext,
    request: &'a McpMutationBatchRequest,
) -> Result<Vec<TargetGroup<'a>>, String> {
    let mut groups: Vec<TargetGroup<'a>> = Vec::new();
    for change in &request.changes {
        let target = derive_target(context, change)?;
        if let Some(group) = groups.iter_mut().find(|group| group.target.id == target.id) {
            group.changes.push(change);
        } else if groups
            .iter()
            .any(|group| paths_equal(&group.target.path, &target.path))
        {
            return Err("同一个宿主配置文件的不同作用域请分成两个确认计划。".to_string());
        } else {
            groups.push(TargetGroup {
                target,
                changes: vec![change],
            });
        }
    }
    groups.sort_by(|left, right| left.target.id.cmp(&right.target.id));
    Ok(groups)
}

fn paths_equal(left: &Path, right: &Path) -> bool {
    if cfg!(windows) {
        left.to_string_lossy()
            .eq_ignore_ascii_case(&right.to_string_lossy())
    } else {
        left == right
    }
}

fn target_path_binding(path: &Path) -> Result<String, String> {
    let parent = path
        .parent()
        .ok_or_else(|| "MCP 配置父目录无效。".to_string())?;
    let leaf = path
        .file_name()
        .ok_or_else(|| "MCP 配置文件名无效。".to_string())?;
    let canonical_parent = fs::canonicalize(parent)
        .map_err(|_| "无法确认 MCP 配置文件夹的实际位置；没有写入。".to_string())?;
    let mut identity = canonical_parent.join(leaf).to_string_lossy().to_string();
    if cfg!(windows) {
        identity.make_ascii_lowercase();
    }
    Ok(sha256_hex(identity.as_bytes()))
}

/// Resolves the writable config file of a (host, scope, workspace) target.
/// Never creates a client directory (I5); a config file may be created only
/// inside an existing client config directory.
pub(crate) fn resolve_target(
    context: &McpMutationContext,
    host_id: &str,
    scope: &str,
    workspace_id: Option<&str>,
) -> Result<ResolvedTarget, String> {
    derive_target(
        context,
        &target_probe_change(host_id, scope, workspace_id.map(str::to_string)),
    )
}

fn derive_target(
    context: &McpMutationContext,
    change: &McpBindingChange,
) -> Result<ResolvedTarget, String> {
    let workspace = match change.workspace_id.as_deref() {
        Some(id) => Some(
            context
                .registered_workspaces
                .iter()
                .find(|workspace| workspace.id == id)
                .ok_or_else(|| "MCP 工作区未注册或已停用。".to_string())?,
        ),
        None => None,
    };
    let (path, display, workspace_path) = match (change.host_id.as_str(), change.scope.as_str()) {
        (HOST_CODEX, "user") if workspace.is_none() => {
            let parent = context.home_dir.join(".codex");
            validate_existing_directory(&parent, "Codex 配置目录")?;
            (
                parent.join("config.toml"),
                "~/.codex/config.toml".to_string(),
                None,
            )
        }
        (HOST_CODEX, "project") => {
            let workspace =
                workspace.ok_or_else(|| "Codex project scope 需要已注册工作区。".to_string())?;
            let parent = workspace.path.join(".codex");
            validate_existing_directory(&parent, "工作区 Codex 配置目录")?;
            (
                parent.join("config.toml"),
                format!(
                    "${{workspace:{}}}/.codex/config.toml",
                    safe_label(&workspace.display_name)
                ),
                Some(workspace.path.clone()),
            )
        }
        (HOST_CLAUDE_CODE, "user") if workspace.is_none() => {
            let (path, display) = context.claude_user_config();
            if !path.is_file() {
                let claude_dir = context
                    .claude_config_dir
                    .clone()
                    .unwrap_or_else(|| context.home_dir.join(".claude"));
                validate_existing_directory(&claude_dir, "Claude Code 配置目录")?;
            }
            (path, display, None)
        }
        (HOST_CLAUDE_CODE, "local") => {
            let workspace =
                workspace.ok_or_else(|| "Claude local scope 需要已注册工作区。".to_string())?;
            let (path, display) = context.claude_user_config();
            if !path.is_file() {
                return Err("Claude Code 的配置文件还不存在；SkillHub 不会替它新建。".to_string());
            }
            (path, display, Some(workspace.path.clone()))
        }
        (HOST_CLAUDE_CODE, "project") => {
            let workspace =
                workspace.ok_or_else(|| "Claude project scope 需要已注册工作区。".to_string())?;
            (
                workspace.path.join(".mcp.json"),
                format!(
                    "${{workspace:{}}}/.mcp.json",
                    safe_label(&workspace.display_name)
                ),
                Some(workspace.path.clone()),
            )
        }
        (HOST_CLAUDE_DESKTOP, "user") if workspace.is_none() => {
            let directory = context.claude_desktop_dir();
            validate_existing_directory(&directory, "Claude Desktop 配置目录")?;
            let path = directory.join("claude_desktop_config.json");
            let display = redact_home_path(&path, &context.home_dir);
            (path, display, None)
        }
        (HOST_CURSOR, "user") if workspace.is_none() => {
            let directory = context.home_dir.join(".cursor");
            validate_existing_directory(&directory, "Cursor 配置目录")?;
            (
                directory.join("mcp.json"),
                "~/.cursor/mcp.json".to_string(),
                None,
            )
        }
        _ => return Err("这个 AI 工具不支持这种作用域。".to_string()),
    };
    validate_target_parent(&path)?;
    let workspace_id = change.workspace_id.clone();
    let id = format!(
        "mcp-target-{}",
        &sha256_hex(
            format!(
                "{}|{}|{}",
                change.host_id,
                change.scope,
                workspace_id.as_deref().unwrap_or_default()
            )
            .as_bytes()
        )[..16]
    );
    Ok(ResolvedTarget {
        id,
        host_id: change.host_id.clone(),
        scope: change.scope.clone(),
        workspace_id,
        workspace_path,
        path,
        path_display: display,
    })
}

fn validate_target_parent(path: &Path) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "MCP 配置父目录无效。".to_string())?;
    validate_existing_directory(parent, "MCP 配置父目录")
}

pub(crate) fn safe_label(value: &str) -> String {
    value
        .chars()
        .filter(|ch| ch.is_alphanumeric() || matches!(ch, ' ' | '-' | '_' | '.'))
        .take(80)
        .collect()
}

fn read_regular_config(path: &Path, allow_missing: bool) -> Result<Option<ConfigFile>, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound && allow_missing => {
            return Ok(None)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("MCP 配置元数据不可读。".to_string()),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("MCP 配置不是普通文件或是符号链接，已拒绝写入。".to_string());
    }
    if metadata.len() > MAX_CONFIG_BYTES {
        return Err("MCP 配置超过 2 MB，已拒绝写入。".to_string());
    }
    let mut file = File::open(path).map_err(|_| "MCP 配置不可读。".to_string())?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.read_to_end(&mut bytes)
        .map_err(|_| "MCP 配置读取失败。".to_string())?;
    let text = String::from_utf8(bytes.clone())
        .map_err(|_| "MCP 配置不是有效 UTF-8，已拒绝写入。".to_string())?;
    let fingerprint = fingerprint(&metadata, &bytes);
    Ok(Some(ConfigFile {
        bytes,
        text: text.trim_start_matches('\u{feff}').to_string(),
        metadata,
        fingerprint,
    }))
}

fn current_fingerprint(path: &Path) -> Result<Option<FileFingerprint>, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("MCP 目标元数据不可读。".to_string()),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("MCP 目标不是安全的普通文件。".to_string());
    }
    if metadata.len() > MAX_CONFIG_BYTES.saturating_add(64 * 1024) {
        return Err("MCP 目标超过安全读取上限。".to_string());
    }
    let bytes = fs::read(path).map_err(|_| "MCP 目标读取失败。".to_string())?;
    Ok(Some(fingerprint(&metadata, &bytes)))
}

fn ensure_target_fingerprint(
    path: &Path,
    expected: &FileFingerprint,
    message: &str,
) -> Result<(), String> {
    let current = current_fingerprint(path)?.unwrap_or_else(FileFingerprint::missing);
    if &current == expected {
        Ok(())
    } else {
        Err(message.to_string())
    }
}

fn fingerprint(metadata: &fs::Metadata, bytes: &[u8]) -> FileFingerprint {
    let modified_nanos = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos().min(u128::from(u64::MAX)) as u64)
        .unwrap_or_default();
    FileFingerprint {
        exists: true,
        byte_len: bytes.len() as u64,
        sha256: sha256_hex(bytes),
        modified_nanos,
    }
}

fn empty_config(target: &ResolvedTarget) -> &'static str {
    if target.host_id == HOST_CODEX {
        ""
    } else {
        "{}"
    }
}

/// Validates the *current* document before a write. Codex documents only need
/// to parse (entries written by older versions may carry noise that this
/// write cleans up); the entries a write touches are checked strictly after
/// the write (`verify_*`). JSON documents must be strict JSON objects.
fn validate_host_document(target: &ResolvedTarget, text: &str) -> Result<(), String> {
    if target.host_id == HOST_CODEX {
        text.parse::<DocumentMut>()
            .map_err(|_| "Codex TOML 无法保真解析，已拒绝写入。".to_string())?;
        if !mcp_center::codex_mcp_config_readable(text) {
            return Err("Codex MCP 静态回读验证失败。".to_string());
        }
    } else {
        let parsed = JsonDoc::parse(text).map_err(|_| {
            "Claude MCP 写入仅支持严格 JSON；JSONC 注释或尾逗号文件保持只读。".to_string()
        })?;
        if parsed.root.as_object().is_none() {
            return Err(
                "Claude MCP 写入仅支持严格 JSON；JSONC 注释或尾逗号文件保持只读。".to_string(),
            );
        }
    }
    Ok(())
}

fn apply_changes_to_text(
    target: &ResolvedTarget,
    original: &str,
    changes: &[&McpBindingChange],
) -> Result<String, String> {
    if target.host_id == HOST_CODEX {
        let mut document = original
            .parse::<DocumentMut>()
            .map_err(|_| "Codex TOML 无法保真解析，已拒绝写入。".to_string())?;
        for change in changes {
            apply_codex_change(&mut document, change)?;
        }
        let rendered = document.to_string();
        validate_host_document(target, &rendered)?;
        Ok(rendered)
    } else {
        let mut document = JsonDoc::parse(original).map_err(|_| {
            "Claude MCP 写入仅支持严格 JSON；JSONC 注释或尾逗号文件保持只读。".to_string()
        })?;
        if document.root.as_object().is_none() {
            return Err("Claude MCP 配置根节点必须是对象。".to_string());
        }
        for change in changes {
            apply_json_change(&mut document.root, target, change)?;
        }
        let rendered = document
            .render()
            .map_err(|_| "Claude MCP 配置序列化失败。".to_string())?;
        validate_host_document(target, &rendered)?;
        Ok(rendered)
    }
}

fn codex_servers_mut(document: &mut DocumentMut) -> Result<&mut Table, String> {
    if !document.as_table().contains_key("mcp_servers") {
        let mut servers = Table::new();
        servers.set_implicit(true);
        document
            .as_table_mut()
            .insert("mcp_servers", Item::Table(servers));
    }
    document["mcp_servers"]
        .as_table_mut()
        .ok_or_else(|| "Codex mcp_servers 必须是 TOML table。".to_string())
}

fn codex_has_structured_env_vars(table: &dyn TableLike) -> bool {
    table.get("env_vars").is_some_and(|item| {
        item.as_value()
            .and_then(TomlValue::as_array)
            .is_none_or(|array| array.iter().any(|entry| !entry.is_str()))
    })
}

const CODEX_STRUCTURED_ENV_MESSAGE: &str =
    "这个 Codex MCP Server 使用当前版本无法安全编辑的对象式 env_vars；已保持只读。";

fn apply_codex_change(document: &mut DocumentMut, change: &McpBindingChange) -> Result<(), String> {
    let servers = codex_servers_mut(document)?;
    match change.action.as_str() {
        "delete" => {
            if servers.remove(&change.server_name).is_none() {
                return Err("要删除的 Codex MCP Server 不存在。".to_string());
            }
        }
        "set-enabled" => {
            let enabled = change.enabled.expect("validated enabled state");
            let table = servers
                .get_mut(&change.server_name)
                .and_then(Item::as_table_mut)
                .ok_or_else(|| "要启停的 Codex MCP Server 不存在或结构无效。".to_string())?;
            table["enabled"] = value(enabled);
        }
        "upsert" => {
            if !servers.contains_key(&change.server_name) {
                servers.insert(&change.server_name, Item::Table(Table::new()));
            }
            let table = servers
                .get_mut(&change.server_name)
                .and_then(Item::as_table_mut)
                .ok_or_else(|| "Codex MCP Server 不是可编辑 table。".to_string())?;
            if codex_has_structured_env_vars(&*table) {
                return Err(CODEX_STRUCTURED_ENV_MESSAGE.to_string());
            }
            let draft = change.draft.as_ref().expect("validated draft");
            // Bug #40: never add `enabled = true` or `required = false` noise.
            if !draft.enabled {
                table["enabled"] = value(false);
            } else if table.contains_key("enabled") {
                table["enabled"] = value(true);
            }
            if draft.required {
                table["required"] = value(true);
            } else {
                table.remove("required");
            }
            if draft.transport == "stdio" {
                // Bug MCP#4: a transport switch must not leave inline values
                // Codex rejects; they are never silently deleted here.
                if table.contains_key("http_headers") {
                    return Err(
                        "该配置包含远程方式的内联请求头；请删除后重新添加，或在新版 MCP 页面中编辑。"
                            .to_string(),
                    );
                }
                for key in [
                    "url",
                    "env_http_headers",
                    "bearer_token_env_var",
                    "bearer_token",
                    "oauth",
                ] {
                    table.remove(key);
                }
                table["command"] = value(draft.command.as_deref().unwrap_or_default());
                if draft.args.is_empty() {
                    table.remove("args");
                } else {
                    let mut args = Array::new();
                    for argument in &draft.args {
                        args.push(argument.as_str());
                    }
                    table["args"] = value(args);
                }
                if draft.env_vars.is_empty() {
                    table.remove("env_vars");
                } else {
                    let mut env_vars = Array::new();
                    for name in &draft.env_vars {
                        env_vars.push(name.as_str());
                    }
                    table["env_vars"] = value(env_vars);
                }
            } else {
                if table.contains_key("env") {
                    return Err(
                        "该配置包含本地命令方式的内联环境变量；请删除后重新添加，或在新版 MCP 页面中编辑。"
                            .to_string(),
                    );
                }
                for key in ["command", "args", "env_vars", "cwd"] {
                    table.remove(key);
                }
                table["url"] = value(draft.url.as_deref().unwrap_or_default());
                if draft.header_env.is_empty() {
                    table.remove("env_http_headers");
                } else {
                    let mut header_refs = InlineTable::new();
                    for reference in &draft.header_env {
                        header_refs.insert(
                            &reference.header_name,
                            TomlValue::from(reference.env_var_name.as_str()),
                        );
                    }
                    table["env_http_headers"] = value(header_refs);
                }
            }
            // Existing `env` and `http_headers` entries may contain inline
            // values. They are deliberately left byte-preserved unless the
            // user explicitly deletes the entire binding.
        }
        _ => unreachable!("validated action"),
    }
    Ok(())
}

/// Resolves the `mcpServers` container of a JSON target. Claude local scope
/// lives under `projects[<key>]`, where the key is matched after
/// normalisation (bug MCP#5): exactly one equivalent key is used; none means
/// the forward-slash form is inserted; several equivalent keys that carry
/// `mcpServers` are refused instead of guessed.
fn json_project_key(projects: &ObjectMap, workspace_path: &Path) -> Result<Option<String>, String> {
    let matches = projects
        .keys()
        .filter(|key| mcp_center::paths_equivalent(key, workspace_path))
        .cloned()
        .collect::<Vec<_>>();
    if matches.len() <= 1 {
        return Ok(matches.into_iter().next());
    }
    let with_servers = matches
        .iter()
        .filter(|key| {
            projects
                .get(key)
                .and_then(|project| project.get("mcpServers"))
                .is_some()
        })
        .cloned()
        .collect::<Vec<_>>();
    match with_servers.len() {
        0 => Ok(matches.into_iter().next()),
        1 => Ok(with_servers.into_iter().next()),
        _ => Err(AMBIGUOUS_PROJECT_MESSAGE.to_string()),
    }
}

pub(crate) const AMBIGUOUS_PROJECT_MESSAGE: &str =
    "~/.claude.json 里有多个指向同一项目的记录，SkillHub 不猜测，保持只读。";

pub(crate) fn normalized_project_key(workspace_path: &Path) -> String {
    let text = workspace_path.to_string_lossy();
    let text = text.trim_start_matches(r"\\?\");
    if cfg!(windows) {
        text.replace('\\', "/")
    } else {
        text.to_string()
    }
}

fn json_servers_mut<'a>(
    root: &'a mut Node,
    target: &ResolvedTarget,
) -> Result<&'a mut ObjectMap, String> {
    let root = root
        .as_object_mut()
        .ok_or_else(|| "Claude MCP 配置根节点必须是对象。".to_string())?;
    let container = if target.scope == "local" {
        let workspace_path = target
            .workspace_path
            .as_ref()
            .ok_or_else(|| "Claude local 工作区丢失。".to_string())?;
        let projects = object_field_mut(root, "projects")?;
        let key = match json_project_key(projects, workspace_path)? {
            Some(key) => key,
            None => {
                let key = normalized_project_key(workspace_path);
                projects.insert(key.clone(), Node::object());
                key
            }
        };
        projects
            .get_mut(&key)
            .and_then(Node::as_object_mut)
            .ok_or_else(|| "Claude local 工作区配置必须是对象。".to_string())?
    } else {
        root
    };
    object_field_mut(container, "mcpServers")
}

fn object_field_mut<'a>(object: &'a mut ObjectMap, key: &str) -> Result<&'a mut ObjectMap, String> {
    if !object.contains_key(key) {
        object.insert(key, Node::object());
    }
    object
        .get_mut(key)
        .and_then(Node::as_object_mut)
        .ok_or_else(|| format!("Claude {key} 必须是对象。"))
}

fn json_servers_ref<'a>(
    root: &'a Node,
    target: &ResolvedTarget,
) -> Result<Option<&'a ObjectMap>, String> {
    let root = root
        .as_object()
        .ok_or_else(|| "Claude MCP 配置根节点必须是对象。".to_string())?;
    let container = if target.scope == "local" {
        let workspace_path = target
            .workspace_path
            .as_ref()
            .ok_or_else(|| "Claude local 工作区丢失。".to_string())?;
        let Some(projects) = root.get("projects").and_then(Node::as_object) else {
            return Ok(None);
        };
        let Some(key) = json_project_key(projects, workspace_path)? else {
            return Ok(None);
        };
        let Some(project) = projects.get(&key).and_then(Node::as_object) else {
            return Ok(None);
        };
        project
    } else {
        root
    };
    Ok(container.get("mcpServers").and_then(Node::as_object))
}

/// The reference form each JSON host uses for an environment variable.
fn json_env_reference(host_id: &str, name: &str) -> String {
    if host_id == HOST_CURSOR {
        format!("${{env:{name}}}")
    } else {
        format!("${{{name}}}")
    }
}

fn apply_json_change(
    root: &mut Node,
    target: &ResolvedTarget,
    change: &McpBindingChange,
) -> Result<(), String> {
    let servers = json_servers_mut(root, target)?;
    match change.action.as_str() {
        "delete" => {
            if servers.remove(&change.server_name).is_none() {
                return Err("要删除的 Claude MCP Server 不存在。".to_string());
            }
        }
        "set-enabled" => {
            return Err("Claude Code 启停状态按项目管理；当前版本不支持直接修改。".to_string());
        }
        "upsert" => {
            if !servers.contains_key(&change.server_name) {
                servers.insert(change.server_name.clone(), Node::object());
            }
            let binding = servers
                .get_mut(&change.server_name)
                .and_then(Node::as_object_mut)
                .ok_or_else(|| "Claude MCP Server 不是可编辑对象。".to_string())?;
            let draft = change.draft.as_ref().expect("validated draft");
            if target.host_id == HOST_CLAUDE_CODE || binding.contains_key("type") {
                binding.insert("type", Node::string(draft.transport.clone()));
            }
            if draft.transport == "stdio" {
                binding.insert(
                    "command",
                    Node::string(draft.command.clone().unwrap_or_default()),
                );
                binding.insert("args", Node::string_array(draft.args.iter().cloned()));
                binding.remove("url");
            } else {
                binding.insert("url", Node::string(draft.url.clone().unwrap_or_default()));
                binding.remove("command");
                binding.remove("args");
            }
            replace_json_env_refs(binding, &target.host_id, &draft.env_vars)?;
            replace_json_header_refs(binding, &target.host_id, &draft.header_env)?;
            // Unknown keys and inline env/header values remain intact. Exact
            // `${ENV}` references are the fields managed by this form.
        }
        _ => unreachable!("validated action"),
    }
    Ok(())
}

fn replace_json_env_refs(
    binding: &mut ObjectMap,
    host_id: &str,
    names: &[String],
) -> Result<(), String> {
    let remove_empty = if let Some(value) = binding.get_mut("env") {
        let Some(env) = value.as_object_mut() else {
            if names.is_empty() {
                return Ok(());
            }
            return Err("Claude MCP env 字段必须是对象；现有值已保留。".to_string());
        };
        env.retain(|key, value| simple_env_reference(value) != Some(key));
        for name in names {
            env.insert(
                name.clone(),
                Node::string(json_env_reference(host_id, name)),
            );
        }
        env.is_empty()
    } else if names.is_empty() {
        false
    } else {
        let env = object_field_mut(binding, "env")?;
        for name in names {
            env.insert(
                name.clone(),
                Node::string(json_env_reference(host_id, name)),
            );
        }
        false
    };
    if remove_empty {
        binding.remove("env");
    }
    Ok(())
}

fn replace_json_header_refs(
    binding: &mut ObjectMap,
    host_id: &str,
    references: &[McpHeaderEnvRef],
) -> Result<(), String> {
    let remove_empty = if let Some(value) = binding.get_mut("headers") {
        let Some(headers) = value.as_object_mut() else {
            if references.is_empty() {
                return Ok(());
            }
            return Err("Claude MCP headers 字段必须是对象；现有值已保留。".to_string());
        };
        headers.retain(|_, value| simple_env_reference(value).is_none());
        for reference in references {
            headers.insert(
                reference.header_name.clone(),
                Node::string(json_env_reference(host_id, &reference.env_var_name)),
            );
        }
        headers.is_empty()
    } else if references.is_empty() {
        false
    } else {
        let headers = object_field_mut(binding, "headers")?;
        for reference in references {
            headers.insert(
                reference.header_name.clone(),
                Node::string(json_env_reference(host_id, &reference.env_var_name)),
            );
        }
        false
    };
    if remove_empty {
        binding.remove("headers");
    }
    Ok(())
}

/// `${NAME}` or `${env:NAME}` with a valid variable name.
fn simple_env_reference(value: &Node) -> Option<&str> {
    let inner = value.as_str()?.strip_prefix("${")?.strip_suffix('}')?;
    let reference = inner.strip_prefix("env:").unwrap_or(inner);
    validate_env_name(reference).is_ok().then_some(reference)
}

fn count_json_references(binding: &ObjectMap) -> (usize, usize) {
    let count = |key: &str| {
        binding
            .get(key)
            .and_then(Node::as_object)
            .map(|map| {
                map.iter()
                    .filter(|(_, value)| {
                        simple_env_reference(value).is_some()
                            || value
                                .as_str()
                                .and_then(|text| text.strip_prefix("Bearer "))
                                .is_some_and(|rest| {
                                    simple_env_reference(&Node::string(rest)).is_some()
                                })
                    })
                    .count()
            })
            .unwrap_or_default()
    };
    (count("env"), count("headers"))
}

fn build_diffs(
    target: &ResolvedTarget,
    before_text: &str,
    after_text: &str,
    changes: &[&McpBindingChange],
) -> Result<Vec<McpFieldDiff>, String> {
    let mut diffs = Vec::new();
    for change in changes {
        let before = binding_summary(target, before_text, &change.server_name)?;
        let after = binding_summary(target, after_text, &change.server_name)?;
        push_diff(
            &mut diffs,
            target,
            change,
            "binding",
            &state_label(before.exists),
            &state_label(after.exists),
        );
        if before.transport != after.transport {
            push_diff(
                &mut diffs,
                target,
                change,
                "transport",
                safe_state(&before.transport),
                safe_state(&after.transport),
            );
        }
        if before.exists && after.exists && before.enabled != after.enabled {
            push_diff(
                &mut diffs,
                target,
                change,
                "enabled",
                &before.enabled.to_string(),
                &after.enabled.to_string(),
            );
        }
        if before.required != after.required {
            push_diff(
                &mut diffs,
                target,
                change,
                "required",
                &before.required.to_string(),
                &after.required.to_string(),
            );
        }
        // Bug MCP#6: real before/after reference counts, never a "preserved"
        // placeholder.
        let before_refs = before.env_ref_count + before.header_ref_count;
        let after_refs = after.env_ref_count + after.header_ref_count;
        if before_refs != after_refs {
            push_diff(
                &mut diffs,
                target,
                change,
                "secretReferences",
                &before_refs.to_string(),
                &after_refs.to_string(),
            );
        }
    }
    Ok(diffs)
}

fn push_diff(
    diffs: &mut Vec<McpFieldDiff>,
    target: &ResolvedTarget,
    change: &McpBindingChange,
    field: &str,
    before: &str,
    after: &str,
) {
    if before == after {
        return;
    }
    diffs.push(McpFieldDiff {
        target_id: target.id.clone(),
        host_id: target.host_id.clone(),
        scope: target.scope.clone(),
        workspace_id: target.workspace_id.clone(),
        server_name: change.server_name.clone(),
        field: field.to_string(),
        change: change.action.clone(),
        before: before.to_string(),
        after: after.to_string(),
    });
}

fn state_label(value: bool) -> String {
    if value { "configured" } else { "absent" }.to_string()
}

fn safe_state(value: &str) -> &str {
    if value.is_empty() {
        "absent"
    } else {
        value
    }
}

fn binding_summary(
    target: &ResolvedTarget,
    text: &str,
    server_name: &str,
) -> Result<BindingSummary, String> {
    if target.host_id == HOST_CODEX {
        let document = text
            .parse::<DocumentMut>()
            .map_err(|_| "Codex TOML 无法解析。".to_string())?;
        let Some(table) = document
            .get("mcp_servers")
            .and_then(Item::as_table_like)
            .and_then(|servers| servers.get(server_name))
            .and_then(Item::as_table_like)
        else {
            return Ok(BindingSummary::default());
        };
        let enabled = table
            .get("enabled")
            .and_then(Item::as_value)
            .and_then(TomlValue::as_bool)
            .unwrap_or(true);
        let required = table
            .get("required")
            .and_then(Item::as_value)
            .and_then(TomlValue::as_bool)
            .unwrap_or(false);
        let transport = if table.get("url").is_some() {
            "http"
        } else if table.get("command").is_some() {
            "stdio"
        } else {
            "unknown"
        };
        let env_ref_count = table
            .get("env_vars")
            .and_then(Item::as_array)
            .map(|array| array.len())
            .unwrap_or_default();
        let header_ref_count = table
            .get("env_http_headers")
            .and_then(Item::as_table_like)
            .map(|map| map.len())
            .unwrap_or_default()
            + usize::from(table.get("bearer_token_env_var").is_some());
        Ok(BindingSummary {
            exists: true,
            enabled,
            transport: transport.to_string(),
            required,
            env_ref_count,
            header_ref_count,
        })
    } else {
        let document = JsonDoc::parse(text).map_err(|_| "Claude JSON 无法解析。".to_string())?;
        let servers = json_servers_ref(&document.root, target)?;
        let Some(binding) = servers
            .and_then(|servers| servers.get(server_name))
            .and_then(Node::as_object)
        else {
            return Ok(BindingSummary::default());
        };
        // Claude Code stores enablement per project outside the binding. The
        // mutation layer therefore treats a binding as configured here and
        // leaves any legacy/unknown `enabled` or `disabled` keys untouched.
        let enabled = true;
        let transport = json_entry_transport(binding).to_string();
        let (env_ref_count, header_ref_count) = count_json_references(binding);
        Ok(BindingSummary {
            exists: true,
            enabled,
            transport,
            required: false,
            env_ref_count,
            header_ref_count,
        })
    }
}

/// The transport of a JSON entry: `type` when present (`streamable-http`
/// means `http`), otherwise inferred from `url` / `command`.
pub(crate) fn json_entry_transport(binding: &ObjectMap) -> &str {
    match binding.get("type").and_then(Node::as_str) {
        Some("streamable-http") | Some("streamableHttp") | Some("http") => "http",
        Some("sse") => "sse",
        Some("stdio") => "stdio",
        Some(_) => "unknown",
        None if binding.get("url").is_some() && binding.get("command").is_none() => "http",
        None => "stdio",
    }
}

fn verify_written_config(
    target: &ResolvedTarget,
    text: &str,
    changes: &[&McpBindingChange],
) -> Result<(), String> {
    validate_host_document(target, text)?;
    for change in changes {
        let summary = binding_summary(target, text, &change.server_name)?;
        match change.action.as_str() {
            "delete" if summary.exists => {
                return Err("MCP 写后验证发现已删除 Binding 仍存在。".to_string())
            }
            "upsert" | "set-enabled" if !summary.exists => {
                return Err("MCP 写后验证找不到目标 Binding。".to_string())
            }
            "upsert" => {
                let draft = change.draft.as_ref().expect("validated draft");
                let expected_transport = if draft.transport == "sse" {
                    "sse"
                } else {
                    draft.transport.as_str()
                };
                if summary.enabled != draft.enabled || summary.transport != expected_transport {
                    return Err("MCP 写后 Binding 状态不匹配。".to_string());
                }
                verify_codex_entry_shape(target, text, &change.server_name)?;
            }
            "set-enabled" => {
                let enabled = change.enabled.expect("validated enabled state");
                if summary.enabled != enabled {
                    return Err("MCP 写后启停状态不匹配。".to_string());
                }
            }
            _ => {}
        }
    }
    Ok(())
}

/// Bugs MCP#1/#4: a Codex entry this write touched must be exactly valid for
/// its transport, or the read-back verification rejects the write.
fn verify_codex_entry_shape(
    target: &ResolvedTarget,
    text: &str,
    server_name: &str,
) -> Result<(), String> {
    if target.host_id != HOST_CODEX {
        return Ok(());
    }
    let document = text
        .parse::<DocumentMut>()
        .map_err(|_| "Codex TOML 无法解析。".to_string())?;
    let Some(entry) = document
        .get("mcp_servers")
        .and_then(Item::as_table_like)
        .and_then(|servers| servers.get(server_name))
        .and_then(Item::as_table_like)
    else {
        return Ok(());
    };
    if mcp_center::codex_entry_shape_ok(entry) {
        Ok(())
    } else {
        Err("MCP 写后验证发现 Codex 不接受的字段组合，已停止。".to_string())
    }
}

// ---------------------------------------------------------------------------
// v3.3 entry-level operations (docs/v3.3/mcp-contract.md §4.2)
// ---------------------------------------------------------------------------

/// Managed keys of a projected entry. Built only inside Rust from the
/// library spec; deliberately not `Deserialize`, so the webview can never send
/// one.
#[derive(Clone, Default)]
pub(crate) struct ProjectedEntry {
    /// Managed keys set in place (insert keeps an existing key's position).
    pub set: Vec<(String, Node)>,
    /// Keys that are set only when the existing entry already has them.
    pub set_if_present: Vec<(String, Node)>,
    /// Managed keys that must be absent after the write.
    pub remove: Vec<String>,
    /// Codex: `Some(false)` writes `enabled = false`; `Some(true)` sets `true`
    /// only when the key exists (never adds noise).
    pub codex_enabled: Option<bool>,
    /// Starting object (unknown keys, or a stashed entry) for an absent entry.
    pub base: Option<Node>,
}

#[derive(Clone)]
pub(crate) enum EntryOp {
    Upsert(ProjectedEntry),
    /// Replace the entry verbatim (undo of an earlier change).
    Restore(Node),
    Remove,
    SetCodexEnabled(bool),
}

#[derive(Clone)]
pub(crate) struct EntryChange {
    pub host_id: String,
    pub scope: String,
    pub workspace_id: Option<String>,
    pub server_name: String,
    pub op: EntryOp,
}

/// The computed (not yet written) result of a set of entry changes on one file.
pub(crate) struct EntryDryRun {
    pub target: ResolvedTarget,
    pub current_sha256: String,
    pub before: Vec<(String, Option<Node>)>,
    pub after: Vec<(String, Option<Node>)>,
    pub changed: bool,
    original: Option<ConfigFile>,
    final_text: String,
}

/// Result of [`apply_entry_changes_now`].
pub(crate) struct EntryApplyOutcome {
    pub changed: bool,
    pub snapshot_id: Option<String>,
    pub applied_sha256: String,
    pub before: Vec<(String, Option<Node>)>,
    pub after: Vec<(String, Option<Node>)>,
}

/// Status of a client config file for read-only views.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TargetReadStatus {
    Ok,
    Missing,
    Jsonc,
    ParseFailed,
    TooLarge,
    Unreadable,
    Ambiguous,
}

/// Read-only entries of one target container.
#[derive(Clone)]
pub(crate) struct TargetRead {
    pub status: TargetReadStatus,
    pub sha256: String,
    pub entries: Vec<(String, Node)>,
    /// Codex entries with structured `env_vars` objects (kept read-only).
    pub structured_env: Vec<String>,
}

impl TargetRead {
    /// An empty view of a file that does not exist.
    pub(crate) fn missing() -> Self {
        Self::with_status(TargetReadStatus::Missing)
    }

    fn with_status(status: TargetReadStatus) -> Self {
        Self {
            status,
            sha256: String::new(),
            entries: Vec::new(),
            structured_env: Vec::new(),
        }
    }

    pub(crate) fn entry(&self, name: &str) -> Option<&Node> {
        self.entries
            .iter()
            .find(|(existing, _)| existing == name)
            .map(|(_, node)| node)
    }
}

/// Reads the entries of a target container without writing anything. Never
/// fails: problems become a status. JSONC files are readable but not writable.
pub(crate) fn read_target_entries(target: &ResolvedTarget) -> TargetRead {
    let file = match read_regular_config(&target.path, true) {
        Ok(Some(file)) => file,
        Ok(None) => return TargetRead::with_status(TargetReadStatus::Missing),
        Err(error) if error.contains("2 MB") => {
            return TargetRead::with_status(TargetReadStatus::TooLarge)
        }
        Err(_) => return TargetRead::with_status(TargetReadStatus::Unreadable),
    };
    let sha256 = file.fingerprint.sha256.clone();
    let mut read = if target.host_id == HOST_CODEX {
        read_codex_entries(&file.text)
    } else {
        read_json_entries(target, &file.text)
    };
    read.sha256 = sha256;
    read
}

fn read_codex_entries(text: &str) -> TargetRead {
    let Ok(document) = text.parse::<DocumentMut>() else {
        return TargetRead::with_status(TargetReadStatus::ParseFailed);
    };
    if !mcp_center::codex_mcp_config_readable(text) {
        return TargetRead::with_status(TargetReadStatus::ParseFailed);
    }
    let mut read = TargetRead::with_status(TargetReadStatus::Ok);
    if let Some(servers) = document.get("mcp_servers").and_then(Item::as_table_like) {
        for (name, item) in servers.iter() {
            let Some(table) = item.as_table_like() else {
                continue;
            };
            if codex_has_structured_env_vars(table) {
                read.structured_env.push(name.to_string());
            }
            if let Some(node) = toml_item_to_node(item) {
                read.entries.push((name.to_string(), node));
            }
        }
    }
    read
}

fn read_json_entries(target: &ResolvedTarget, text: &str) -> TargetRead {
    let (root, status) = match JsonDoc::parse(text) {
        Ok(document) if document.root.as_object().is_some() => {
            (document.root, TargetReadStatus::Ok)
        }
        Ok(_) => return TargetRead::with_status(TargetReadStatus::ParseFailed),
        Err(()) => match crate::mcp_json_doc::parse_jsonc_node(text) {
            Ok(root) if root.as_object().is_some() => (root, TargetReadStatus::Jsonc),
            _ => return TargetRead::with_status(TargetReadStatus::ParseFailed),
        },
    };
    let servers = match json_servers_ref(&root, target) {
        Ok(servers) => servers,
        Err(error) if error == AMBIGUOUS_PROJECT_MESSAGE => {
            return TargetRead::with_status(TargetReadStatus::Ambiguous)
        }
        Err(_) => return TargetRead::with_status(TargetReadStatus::ParseFailed),
    };
    let mut read = TargetRead::with_status(status);
    if let Some(servers) = servers {
        for (name, node) in servers.iter() {
            if node.as_object().is_some() {
                read.entries.push((name.clone(), node.clone()));
            }
        }
    }
    read
}

/// Reads a client JSON config (strict, or JSONC read-only) as a node.
pub(crate) fn read_config_node(path: &Path) -> Option<Node> {
    let file = read_regular_config(path, true).ok()??;
    JsonDoc::parse(&file.text)
        .map(|document| document.root)
        .ok()
        .or_else(|| crate::mcp_json_doc::parse_jsonc_node(&file.text).ok())
}

/// A TOML value for a node (used by the masked Codex export).
pub(crate) fn node_to_toml(node: &Node) -> Option<TomlValue> {
    node_to_toml_value(node)
}

/// Converts a TOML item to an order-preserving node (datetimes become text).
pub(crate) fn toml_item_to_node(item: &Item) -> Option<Node> {
    match item {
        Item::None => None,
        Item::Value(value) => Some(toml_value_to_node(value)),
        Item::Table(table) => {
            let mut map = ObjectMap::new();
            for (key, child) in table.iter() {
                if let Some(node) = toml_item_to_node(child) {
                    map.insert(key, node);
                }
            }
            Some(Node::Object(map))
        }
        Item::ArrayOfTables(array) => Some(Node::Array(
            array
                .iter()
                .filter_map(|table| toml_item_to_node(&Item::Table(table.clone())))
                .collect(),
        )),
    }
}

fn toml_value_to_node(value: &TomlValue) -> Node {
    match value {
        TomlValue::String(text) => Node::String(text.value().clone()),
        TomlValue::Integer(number) => Node::Number((*number.value()).into()),
        TomlValue::Float(number) => serde_json::Number::from_f64(*number.value())
            .map(Node::Number)
            .unwrap_or(Node::Null),
        TomlValue::Boolean(flag) => Node::Bool(*flag.value()),
        TomlValue::Datetime(datetime) => Node::String(datetime.value().to_string()),
        TomlValue::Array(array) => Node::Array(array.iter().map(toml_value_to_node).collect()),
        TomlValue::InlineTable(table) => {
            let mut map = ObjectMap::new();
            for (key, child) in table.iter() {
                map.insert(key, toml_value_to_node(child));
            }
            Node::Object(map)
        }
    }
}

fn node_to_toml_value(node: &Node) -> Option<TomlValue> {
    Some(match node {
        Node::Null => return None,
        Node::Bool(flag) => TomlValue::from(*flag),
        Node::Number(number) => {
            if let Some(integer) = number.as_i64() {
                TomlValue::from(integer)
            } else {
                TomlValue::from(number.as_f64()?)
            }
        }
        Node::String(text) => TomlValue::from(text.as_str()),
        Node::Array(items) => {
            let mut array = Array::new();
            for item in items {
                array.push(node_to_toml_value(item)?);
            }
            TomlValue::Array(array)
        }
        Node::Object(map) => {
            let mut table = InlineTable::new();
            for (key, child) in map.iter() {
                if let Some(value) = node_to_toml_value(child) {
                    table.insert(key, value);
                }
            }
            TomlValue::InlineTable(table)
        }
    })
}

/// Sets one Codex key in place. An existing `[x.env]`-style sub-table keeps
/// its shape (user config shape, §2.4).
fn codex_set_key(table: &mut Table, key: &str, node: &Node) -> Result<(), String> {
    if let (Some(Item::Table(existing)), Node::Object(map)) = (table.get_mut(key), node) {
        let wanted = map.keys().cloned().collect::<HashSet<_>>();
        let stale = existing
            .iter()
            .map(|(name, _)| name.to_string())
            .filter(|name| !wanted.contains(name))
            .collect::<Vec<_>>();
        for name in stale {
            existing.remove(&name);
        }
        for (name, child) in map.iter() {
            let value = node_to_toml_value(child)
                .ok_or_else(|| "Codex MCP 字段值无法转换为 TOML。".to_string())?;
            existing[name.as_str()] = Item::Value(value);
        }
        return Ok(());
    }
    let value =
        node_to_toml_value(node).ok_or_else(|| "Codex MCP 字段值无法转换为 TOML。".to_string())?;
    table[key] = Item::Value(value);
    Ok(())
}

fn apply_projection_to_codex_table(
    table: &mut Table,
    projected: &ProjectedEntry,
) -> Result<(), String> {
    for key in &projected.remove {
        table.remove(key);
    }
    for (key, node) in &projected.set {
        codex_set_key(table, key, node)?;
    }
    for (key, node) in &projected.set_if_present {
        if table.contains_key(key) {
            codex_set_key(table, key, node)?;
        }
    }
    match projected.codex_enabled {
        Some(false) => table["enabled"] = value(false),
        Some(true) if table.contains_key("enabled") => table["enabled"] = value(true),
        _ => {}
    }
    Ok(())
}

fn apply_projection_to_json_entry(entry: &mut ObjectMap, projected: &ProjectedEntry) {
    for key in &projected.remove {
        entry.remove(key);
    }
    for (key, node) in &projected.set {
        entry.insert(key.clone(), node.clone());
    }
    for (key, node) in &projected.set_if_present {
        if entry.contains_key(key) {
            entry.insert(key.clone(), node.clone());
        }
    }
}

fn apply_entry_change_codex(
    document: &mut DocumentMut,
    change: &EntryChange,
) -> Result<(), String> {
    let servers = codex_servers_mut(document)?;
    match &change.op {
        EntryOp::Remove => {
            servers.remove(&change.server_name);
        }
        EntryOp::SetCodexEnabled(enabled) => {
            let table = servers
                .get_mut(&change.server_name)
                .and_then(Item::as_table_mut)
                .ok_or_else(|| "要启停的 Codex MCP Server 不存在或结构无效。".to_string())?;
            if !enabled {
                table["enabled"] = value(false);
            } else if table.contains_key("enabled") {
                table["enabled"] = value(true);
            }
        }
        EntryOp::Upsert(projected) => {
            if !servers.contains_key(&change.server_name) {
                let mut table = Table::new();
                if let Some(Node::Object(base)) = &projected.base {
                    for (key, node) in base.iter() {
                        codex_set_key(&mut table, key, node)?;
                    }
                }
                servers.insert(&change.server_name, Item::Table(table));
            }
            let table = servers
                .get_mut(&change.server_name)
                .and_then(Item::as_table_mut)
                .ok_or_else(|| "Codex MCP Server 不是可编辑 table。".to_string())?;
            if codex_has_structured_env_vars(&*table) {
                return Err(CODEX_STRUCTURED_ENV_MESSAGE.to_string());
            }
            apply_projection_to_codex_table(table, projected)?;
        }
        EntryOp::Restore(node) => {
            let Node::Object(map) = node else {
                return Err("MCP 撤销内容无效。".to_string());
            };
            if !servers.contains_key(&change.server_name) {
                servers.insert(&change.server_name, Item::Table(Table::new()));
            }
            let table = servers
                .get_mut(&change.server_name)
                .and_then(Item::as_table_mut)
                .ok_or_else(|| "Codex MCP Server 不是可编辑 table。".to_string())?;
            let wanted = map.keys().cloned().collect::<HashSet<_>>();
            let stale = table
                .iter()
                .map(|(name, _)| name.to_string())
                .filter(|name| !wanted.contains(name))
                .collect::<Vec<_>>();
            for name in stale {
                table.remove(&name);
            }
            for (key, child) in map.iter() {
                codex_set_key(table, key, child)?;
            }
        }
    }
    Ok(())
}

fn apply_entry_change_json(
    root: &mut Node,
    target: &ResolvedTarget,
    change: &EntryChange,
) -> Result<(), String> {
    if matches!(change.op, EntryOp::Remove) {
        // Removing an absent entry never creates containers.
        let present = json_servers_ref(root, target)?
            .is_some_and(|servers| servers.contains_key(&change.server_name));
        if !present {
            return Ok(());
        }
    }
    let servers = json_servers_mut(root, target)?;
    match &change.op {
        EntryOp::Remove => {
            servers.remove(&change.server_name);
        }
        EntryOp::SetCodexEnabled(_) => {
            return Err("Claude Code 启停状态按项目管理；当前版本不支持直接修改。".to_string());
        }
        EntryOp::Upsert(projected) => {
            if !servers.contains_key(&change.server_name) {
                let base = match &projected.base {
                    Some(base @ Node::Object(_)) => base.clone(),
                    _ => Node::object(),
                };
                servers.insert(change.server_name.clone(), base);
            }
            let entry = servers
                .get_mut(&change.server_name)
                .and_then(Node::as_object_mut)
                .ok_or_else(|| "Claude MCP Server 不是可编辑对象。".to_string())?;
            apply_projection_to_json_entry(entry, projected);
        }
        EntryOp::Restore(node) => {
            if node.as_object().is_none() {
                return Err("MCP 撤销内容无效。".to_string());
            }
            servers.insert(change.server_name.clone(), node.clone());
        }
    }
    Ok(())
}

fn apply_entry_changes_to_text(
    target: &ResolvedTarget,
    original: &str,
    changes: &[EntryChange],
) -> Result<String, String> {
    if target.host_id == HOST_CODEX {
        let mut document = original
            .parse::<DocumentMut>()
            .map_err(|_| "Codex TOML 无法保真解析，已拒绝写入。".to_string())?;
        for change in changes {
            apply_entry_change_codex(&mut document, change)?;
        }
        let rendered = document.to_string();
        validate_host_document(target, &rendered)?;
        Ok(rendered)
    } else {
        let mut document = JsonDoc::parse(original).map_err(|_| {
            "Claude MCP 写入仅支持严格 JSON；JSONC 注释或尾逗号文件保持只读。".to_string()
        })?;
        if document.root.as_object().is_none() {
            return Err("Claude MCP 配置根节点必须是对象。".to_string());
        }
        for change in changes {
            apply_entry_change_json(&mut document.root, target, change)?;
        }
        let rendered = document
            .render()
            .map_err(|_| "Claude MCP 配置序列化失败。".to_string())?;
        validate_host_document(target, &rendered)?;
        Ok(rendered)
    }
}

fn entries_of(
    target: &ResolvedTarget,
    text: &str,
    names: &[&str],
) -> Result<Vec<(String, Option<Node>)>, String> {
    let read = if target.host_id == HOST_CODEX {
        read_codex_entries(text)
    } else {
        read_json_entries(target, text)
    };
    if read.status == TargetReadStatus::Ambiguous {
        return Err(AMBIGUOUS_PROJECT_MESSAGE.to_string());
    }
    if !matches!(read.status, TargetReadStatus::Ok) {
        return Err("MCP 配置无法解析。".to_string());
    }
    Ok(names
        .iter()
        .map(|name| (name.to_string(), read.entry(name).cloned()))
        .collect())
}

/// Semantic read-back verification of entry changes (managed keys equal the
/// projection, removed keys absent, Codex entries valid for their transport).
fn verify_entry_changes(
    target: &ResolvedTarget,
    text: &str,
    changes: &[EntryChange],
) -> Result<(), String> {
    validate_host_document(target, text)?;
    let names = changes
        .iter()
        .map(|change| change.server_name.as_str())
        .collect::<Vec<_>>();
    let entries = entries_of(target, text, &names)?;
    for (change, (_, entry)) in changes.iter().zip(entries) {
        match (&change.op, entry) {
            (EntryOp::Remove, None) => {}
            (EntryOp::Remove, Some(_)) => {
                return Err("MCP 写后验证发现已删除的配置仍存在。".to_string())
            }
            (_, None) => return Err("MCP 写后验证找不到目标配置。".to_string()),
            (EntryOp::SetCodexEnabled(enabled), Some(entry)) => {
                let actual = entry.get("enabled").and_then(Node::as_bool).unwrap_or(true);
                if actual != *enabled {
                    return Err("MCP 写后启停状态不匹配。".to_string());
                }
            }
            (EntryOp::Upsert(projected), Some(entry)) => {
                for (key, expected) in &projected.set {
                    if !nodes_equivalent(entry.get(key), Some(expected)) {
                        return Err("MCP 写后配置内容不匹配。".to_string());
                    }
                }
                for key in &projected.remove {
                    if entry.get(key).is_some() {
                        return Err("MCP 写后验证发现不应保留的字段。".to_string());
                    }
                }
                if projected.codex_enabled == Some(false)
                    && entry.get("enabled").and_then(Node::as_bool) != Some(false)
                {
                    return Err("MCP 写后启停状态不匹配。".to_string());
                }
            }
            (EntryOp::Restore(expected), Some(entry)) => {
                if !nodes_equivalent(Some(&entry), Some(expected)) {
                    return Err("MCP 撤销后配置内容不匹配。".to_string());
                }
            }
        }
        verify_codex_entry_shape(target, text, &change.server_name)?;
    }
    Ok(())
}

/// Order-insensitive equality (TOML/JSON number forms compare by value).
pub(crate) fn nodes_equivalent(left: Option<&Node>, right: Option<&Node>) -> bool {
    match (left, right) {
        (None, None) => true,
        (Some(left), Some(right)) => left.to_value() == right.to_value(),
        _ => false,
    }
}

/// Computes the result of `changes` on their single target file without
/// writing (used for confirmation descriptors and confirm tokens).
pub(crate) fn dry_run_entry_changes(
    context: &McpMutationContext,
    changes: &[EntryChange],
) -> Result<EntryDryRun, String> {
    validate_context(context)?;
    let first = changes
        .first()
        .ok_or_else(|| "MCP 写入没有任何变更。".to_string())?;
    if changes.len() > 64 {
        return Err("一次 MCP 写入最多包含 64 项变更。".to_string());
    }
    let target = resolve_target(
        context,
        &first.host_id,
        &first.scope,
        first.workspace_id.as_deref(),
    )?;
    let mut seen = HashSet::new();
    for change in changes {
        if change.host_id != first.host_id
            || change.scope != first.scope
            || change.workspace_id != first.workspace_id
        {
            return Err("一次 MCP 写入只能修改一个配置文件。".to_string());
        }
        if !seen.insert(change.server_name.to_ascii_lowercase()) {
            return Err("同一 MCP 在一次写入中只能修改一次。".to_string());
        }
        if change.server_name.is_empty()
            || change.server_name.len() > 64
            || change.server_name.chars().any(char::is_control)
        {
            return Err("MCP 名称无效。".to_string());
        }
    }
    let original = read_regular_config(&target.path, true)?;
    let original_text = original
        .as_ref()
        .map(|file| file.text.clone())
        .unwrap_or_else(|| empty_config(&target).to_string());
    validate_host_document(&target, &original_text)?;
    let names = changes
        .iter()
        .map(|change| change.server_name.as_str())
        .collect::<Vec<_>>();
    let before = entries_of(&target, &original_text, &names)?;
    let final_text = apply_entry_changes_to_text(&target, &original_text, changes)?;
    if final_text.len() as u64 > MAX_CONFIG_BYTES {
        return Err("MCP 配置变更后超过 2 MB，已停止。".to_string());
    }
    verify_entry_changes(&target, &final_text, changes)?;
    let after = entries_of(&target, &final_text, &names)?;
    let changed = match &original {
        Some(file) => file.text != final_text,
        // A missing file is created only when an entry is actually added.
        None => after.iter().any(|(_, entry)| entry.is_some()),
    };
    Ok(EntryDryRun {
        current_sha256: original
            .as_ref()
            .map(|file| file.fingerprint.sha256.clone())
            .unwrap_or_default(),
        before,
        after,
        changed,
        original,
        final_text,
        target,
    })
}

/// One target file per call: read + fingerprint, compute the final text with
/// `mcp_json_doc` / `toml_edit`, validate and verify, then run the shared
/// executor (DPAPI snapshot, atomic write with fingerprint recheck, read-back).
/// The caller holds the cross-process lock.
pub(crate) fn apply_entry_changes_now(
    context: &McpMutationContext,
    changes: Vec<EntryChange>,
    operation_id: &str,
    target_index: usize,
) -> Result<EntryApplyOutcome, String> {
    validate_stored_id(operation_id, "operation")?;
    let snapshot_id = &format!(
        "mcp-snapshot-{}-{target_index}",
        operation_id.trim_start_matches("mcp-op-")
    );
    let dry_run = dry_run_entry_changes(context, &changes)?;
    if !dry_run.changed {
        return Ok(EntryApplyOutcome {
            changed: false,
            snapshot_id: None,
            applied_sha256: dry_run.current_sha256,
            before: dry_run.before,
            after: dry_run.after,
        });
    }
    let path_binding_sha256 = target_path_binding(&dry_run.target.path)?;
    let final_bytes = if let Some(original) = &dry_run.original {
        // Keep a UTF-8 BOM exactly as it was.
        if original.bytes.starts_with(&[0xEF, 0xBB, 0xBF])
            && !dry_run.final_text.starts_with('\u{feff}')
        {
            let mut bytes = vec![0xEF, 0xBB, 0xBF];
            bytes.extend_from_slice(dry_run.final_text.as_bytes());
            bytes
        } else {
            dry_run.final_text.clone().into_bytes()
        }
    } else {
        dry_run.final_text.clone().into_bytes()
    };
    let applied_sha256 = sha256_hex(&final_bytes);
    let mut prepared = vec![PreparedWrite {
        target: dry_run.target,
        path_binding_sha256,
        verification: WriteVerification::Entries(changes),
        original: dry_run.original,
        final_bytes,
        backup_path: None,
        applied_fingerprint: None,
    }];
    execute_prepared_writes(
        context,
        &mut prepared,
        snapshot_id,
        operation_id,
        None,
        true,
    )?;
    Ok(EntryApplyOutcome {
        changed: true,
        snapshot_id: Some(snapshot_id.to_string()),
        applied_sha256,
        before: dry_run.before,
        after: dry_run.after,
    })
}

/// Restores the bytes a single-target snapshot saved, when the file still
/// holds exactly the bytes that snapshot's write produced (byte-identical
/// undo, M0-3). Returns `Ok(false)` when the snapshot is gone or the file has
/// changed since; the caller then falls back to entry-level undo.
pub(crate) fn restore_snapshot_if_unchanged(
    context: &McpMutationContext,
    snapshot_id: &str,
) -> Result<bool, String> {
    validate_stored_id(snapshot_id, "snapshot")?;
    let manifest_path = snapshot_manifest_path(context, snapshot_id)?;
    let Ok(mut manifest) = read_protected_journal::<SnapshotManifest>(&manifest_path) else {
        return Ok(false);
    };
    if manifest.rolled_back
        || manifest.state != "committed"
        || manifest.targets.len() != 1
        || now_unix_ms() > manifest.expires_at_unix_ms
    {
        return Ok(false);
    }
    let recorded = manifest.targets[0].clone();
    let target = resolve_target(
        context,
        &recorded.host_id,
        &recorded.scope,
        recorded.workspace_id.as_deref(),
    )?;
    if target.id != recorded.id
        || target_path_binding(&target.path)? != recorded.path_binding_sha256
    {
        return Ok(false);
    }
    let Some(applied) = recorded.applied.as_ref() else {
        return Ok(false);
    };
    let Some(current) = read_regular_config(&target.path, true)? else {
        return Ok(false);
    };
    if !same_file_content(&current.fingerprint, applied) {
        return Ok(false);
    }
    let original = if recorded.original.exists {
        let backup_name = recorded
            .backup_file_name
            .as_deref()
            .ok_or_else(|| "MCP 撤销备份记录不完整。".to_string())?;
        let backup = read_private_backup(&snapshot_backup_path_by_name(
            context,
            snapshot_id,
            backup_name,
        )?)?;
        if sha256_hex(&backup) != recorded.original.sha256 {
            return Err("MCP 撤销备份校验失败。".to_string());
        }
        Some(backup)
    } else {
        None
    };
    manifest.state = "rolling-back".to_string();
    write_replaceable_protected_journal(&manifest_path, &manifest)?;
    let result = match &original {
        Some(bytes) => write_atomic(
            &target.path,
            bytes,
            Some(&current),
            snapshot_id,
            Some(&current.fingerprint),
        )
        .and_then(|_| {
            let restored = read_regular_config(&target.path, false)?
                .ok_or_else(|| "MCP 撤销后未找到配置文件。".to_string())?;
            if restored.bytes != *bytes {
                return Err("MCP 撤销后字节验证失败。".to_string());
            }
            Ok(())
        }),
        None => ensure_target_fingerprint(
            &target.path,
            &current.fingerprint,
            "MCP 配置在撤销前又被外部修改；已停止且不会覆盖外部改动。",
        )
        .and_then(|_| {
            fs::remove_file(&target.path)
                .map_err(|_| "无法移除由 MCP 写入新建的配置文件。".to_string())
        }),
    };
    if let Err(error) = result {
        manifest.state = "committed".to_string();
        let _ = write_replaceable_protected_journal(&manifest_path, &manifest);
        return Err(error);
    }
    manifest.rolled_back = true;
    manifest.state = "rolled-back".to_string();
    let _ = write_replaceable_protected_journal(&manifest_path, &manifest);
    cleanup_snapshot_dir(context, snapshot_id);
    Ok(true)
}

/// A non-committed transaction that recovery could not finish, for display.
#[derive(Debug, Clone)]
pub(crate) struct StuckTransaction {
    pub snapshot_id: String,
    pub host_ids: Vec<String>,
    pub path_displays: Vec<String>,
}

/// Lists stuck transactions read-only: no lock, no recovery (bug MCP#10).
pub(crate) fn list_stuck_transactions(context: &McpMutationContext) -> Vec<StuckTransaction> {
    let Ok(manifests) = read_snapshot_manifests_quiet(context) else {
        return Vec::new();
    };
    manifests
        .into_iter()
        .filter(|manifest| {
            !manifest.rolled_back && manifest.state != "committed" && !manifest.dismissed
        })
        .map(|manifest| StuckTransaction {
            snapshot_id: manifest.snapshot_id,
            host_ids: manifest
                .targets
                .iter()
                .map(|target| target.host_id.clone())
                .collect(),
            path_displays: manifest
                .targets
                .iter()
                .map(|target| target.path_display.clone())
                .collect(),
        })
        .collect()
}

/// "保留现在的文件": marks a non-committed manifest as abandoned so it no
/// longer blocks anything. The current files are kept as they are.
pub(crate) fn resolve_stuck_transaction(
    context: &McpMutationContext,
    snapshot_id: &str,
) -> Result<(), String> {
    validate_stored_id(snapshot_id, "snapshot")?;
    let manifest_path = snapshot_manifest_path(context, snapshot_id)?;
    let mut manifest: SnapshotManifest = read_protected_journal(&manifest_path)
        .map_err(|_| "没有找到这次中断的写入记录。".to_string())?;
    if manifest.state == "committed" || manifest.rolled_back {
        return Err("没有找到这次中断的写入记录。".to_string());
    }
    for recorded in &manifest.targets {
        if let Ok(target) = resolve_target(
            context,
            &recorded.host_id,
            &recorded.scope,
            recorded.workspace_id.as_deref(),
        ) {
            let _ = cleanup_known_atomic_temp(&target.path, snapshot_id, recorded);
        }
    }
    manifest.state = ABANDONED_EXTERNAL_CHANGE.to_string();
    manifest.dismissed = true;
    write_replaceable_protected_journal(&manifest_path, &manifest)
}

/// A pre-3.3 plan/apply snapshot, listed read-only for the history drawer.
#[derive(Debug, Clone)]
pub(crate) struct LegacySnapshotInfo {
    pub snapshot_id: String,
    pub created_at_unix_ms: u128,
    pub host_ids: Vec<String>,
    pub path_displays: Vec<String>,
    /// Every target still holds exactly the bytes that snapshot wrote.
    pub restorable: bool,
}

/// Legacy committed snapshots (plan ids `mcp-plan-…`), read-only: no lock,
/// no recovery, no pruning.
pub(crate) fn list_legacy_snapshots(context: &McpMutationContext) -> Vec<LegacySnapshotInfo> {
    let Ok(manifests) = read_snapshot_manifests_quiet(context) else {
        return Vec::new();
    };
    let now = now_unix_ms();
    let mut result = manifests
        .into_iter()
        .filter(|manifest| {
            manifest.plan_id.starts_with("mcp-plan-")
                && !manifest.rolled_back
                && manifest.state == "committed"
                && now <= manifest.expires_at_unix_ms
        })
        .map(|manifest| {
            let restorable = manifest.targets.iter().all(|recorded| {
                let Ok(target) = resolve_target(
                    context,
                    &recorded.host_id,
                    &recorded.scope,
                    recorded.workspace_id.as_deref(),
                ) else {
                    return false;
                };
                let current = current_fingerprint(&target.path)
                    .ok()
                    .flatten()
                    .unwrap_or_else(FileFingerprint::missing);
                recorded
                    .applied
                    .as_ref()
                    .is_some_and(|applied| same_file_content(&current, applied))
            });
            LegacySnapshotInfo {
                snapshot_id: manifest.snapshot_id,
                created_at_unix_ms: manifest.created_at_unix_ms,
                host_ids: manifest
                    .targets
                    .iter()
                    .map(|target| target.host_id.clone())
                    .collect(),
                path_displays: manifest
                    .targets
                    .iter()
                    .map(|target| target.path_display.clone())
                    .collect(),
                restorable,
            }
        })
        .collect::<Vec<_>>();
    result.sort_by_key(|item| std::cmp::Reverse(item.created_at_unix_ms));
    result
}

/// Legacy rollback for a caller that already holds the cross-process lock.
pub(crate) fn rollback_legacy_snapshot_locked(
    context: &McpMutationContext,
    snapshot_id: &str,
) -> Result<McpRollbackResult, String> {
    validate_context(context)?;
    rollback_mcp_snapshot_once(context, snapshot_id, None, true)
}

/// Reads manifests without creating directories or failing on odd entries.
fn read_snapshot_manifests_quiet(
    context: &McpMutationContext,
) -> Result<Vec<SnapshotManifest>, String> {
    let root = snapshots_dir(context);
    let entries = match fs::read_dir(&root) {
        Ok(entries) => entries,
        Err(_) => return Ok(Vec::new()),
    };
    let mut result = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            continue;
        };
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if validate_stored_id(name, "snapshot").is_err() {
            continue;
        }
        let Ok(manifest) = read_protected_journal::<SnapshotManifest>(&path.join("manifest.bin"))
        else {
            continue;
        };
        if manifest.schema_version == PLAN_SCHEMA_VERSION && manifest.snapshot_id == name {
            result.push(manifest);
        }
    }
    Ok(result)
}

fn create_private_backup(path: &Path, original: &[u8]) -> Result<(), String> {
    let protected = protect_private_backup(original)?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|_| "MCP 受保护回滚文件已存在或无法创建。".to_string())?;
    if file
        .write_all(&protected)
        .and_then(|_| file.sync_all())
        .is_err()
    {
        drop(file);
        let _ = fs::remove_file(path);
        return Err("MCP 受保护回滚文件写入失败。".to_string());
    }
    tighten_private_permissions(path, false)?;
    Ok(())
}

fn read_private_backup(path: &Path) -> Result<Vec<u8>, String> {
    let metadata =
        fs::symlink_metadata(path).map_err(|_| "MCP 受保护回滚文件不存在或不可读。".to_string())?;
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.len() > MAX_CONFIG_BYTES.saturating_add(64 * 1024)
    {
        return Err("MCP 受保护回滚文件不是安全的普通文件。".to_string());
    }
    let protected = fs::read(path).map_err(|_| "MCP 受保护回滚文件读取失败。".to_string())?;
    let bytes = unprotect_private_backup(&protected)?;
    if bytes.len() as u64 > MAX_CONFIG_BYTES || std::str::from_utf8(&bytes).is_err() {
        return Err("MCP 受保护回滚内容无效。".to_string());
    }
    Ok(bytes)
}

#[cfg(windows)]
pub(crate) fn protect_private_backup(bytes: &[u8]) -> Result<Vec<u8>, String> {
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CryptProtectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    let input_len =
        u32::try_from(bytes.len()).map_err(|_| "MCP 回滚内容超过系统保护上限。".to_string())?;
    let input = CRYPT_INTEGER_BLOB {
        cbData: input_len,
        pbData: bytes.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: null_mut(),
    };
    let ok = unsafe {
        CryptProtectData(
            &input,
            null(),
            null(),
            null(),
            null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if ok == 0 || output.pbData.is_null() {
        return Err("Windows 无法为 MCP 回滚内容启用当前用户保护。".to_string());
    }
    let result =
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe {
        LocalFree(output.pbData.cast());
    }
    Ok(result)
}

#[cfg(windows)]
pub(crate) fn unprotect_private_backup(bytes: &[u8]) -> Result<Vec<u8>, String> {
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    let input_len = u32::try_from(bytes.len())
        .map_err(|_| "MCP 受保护回滚内容超过系统读取上限。".to_string())?;
    let input = CRYPT_INTEGER_BLOB {
        cbData: input_len,
        pbData: bytes.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: null_mut(),
    };
    let ok = unsafe {
        CryptUnprotectData(
            &input,
            null_mut(),
            null(),
            null(),
            null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if ok == 0 || output.pbData.is_null() {
        return Err("Windows 无法解开 MCP 回滚内容；快照可能损坏或不属于当前用户。".to_string());
    }
    let result =
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe {
        LocalFree(output.pbData.cast());
    }
    Ok(result)
}

#[cfg(not(windows))]
pub(crate) fn protect_private_backup(bytes: &[u8]) -> Result<Vec<u8>, String> {
    Ok(bytes.to_vec())
}

#[cfg(not(windows))]
pub(crate) fn unprotect_private_backup(bytes: &[u8]) -> Result<Vec<u8>, String> {
    Ok(bytes.to_vec())
}

fn sibling_artifact_path(target: &Path, kind: &str, id: &str) -> Result<PathBuf, String> {
    validate_stored_id(id, kind)?;
    let parent = target
        .parent()
        .ok_or_else(|| "MCP 配置父目录无效。".to_string())?;
    let name = target
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "MCP 配置文件名无效。".to_string())?;
    Ok(parent.join(format!(".{name}.ai-skillhub-{kind}-{id}")))
}

fn cleanup_known_atomic_temp(
    target: &Path,
    operation_id: &str,
    recorded: &SnapshotTarget,
) -> Result<(), String> {
    let temp = sibling_artifact_path(target, "temp", operation_id)?;
    let metadata = match fs::symlink_metadata(&temp) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err("MCP 崩溃恢复临时文件不可读。".to_string()),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() > MAX_CONFIG_BYTES
    {
        return Err("MCP 崩溃恢复发现不安全的临时文件，已保留并停止。".to_string());
    }
    let bytes = fs::read(&temp).map_err(|_| "MCP 崩溃恢复临时文件读取失败。".to_string())?;
    let actual = fingerprint(&metadata, &bytes);
    if !same_file_content(&actual, &recorded.original)
        && !same_file_content(&actual, &recorded.planned)
    {
        return Err("MCP 崩溃恢复临时文件内容不匹配，已保留并停止。".to_string());
    }
    fs::remove_file(&temp).map_err(|_| "MCP 崩溃恢复临时文件清理失败。".to_string())
}

fn write_atomic(
    target: &Path,
    bytes: &[u8],
    original: Option<&ConfigFile>,
    operation_id: &str,
    expected: Option<&FileFingerprint>,
) -> Result<(), String> {
    if bytes.len() as u64 > MAX_CONFIG_BYTES {
        return Err("MCP 配置超过 2 MB，已停止原子写入。".to_string());
    }
    let temp = sibling_artifact_path(target, "temp", operation_id)?;
    if fs::symlink_metadata(&temp).is_ok() {
        return Err("MCP 临时文件已存在，已停止写入。".to_string());
    }
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)
        .map_err(|_| "MCP 临时文件无法创建。".to_string())?;
    if let Some(original) = original {
        if fs::set_permissions(&temp, original.metadata.permissions()).is_err() {
            drop(file);
            let _ = fs::remove_file(&temp);
            return Err("MCP 临时文件权限复制失败。".to_string());
        }
    } else if let Err(error) = tighten_private_permissions(&temp, false) {
        drop(file);
        let _ = fs::remove_file(&temp);
        return Err(error);
    }
    if let Err(error) = file.write_all(bytes).and_then(|_| file.sync_all()) {
        let _ = fs::remove_file(&temp);
        return Err(format!("MCP 临时文件写入失败：{}", error.kind()));
    }
    if let Some(expected) = expected {
        if let Err(error) = ensure_target_fingerprint(
            target,
            expected,
            "MCP 目标在最终原子替换前被外部修改；已停止且不会覆盖外部改动。",
        ) {
            let _ = fs::remove_file(&temp);
            return Err(error);
        }
    }
    #[cfg(test)]
    run_atomic_replace_test_hook(target);
    if let Some(expected) = expected {
        if let Err(error) = ensure_target_fingerprint(
            target,
            expected,
            "MCP 目标在最终原子替换瞬间被外部修改；已停止且不会覆盖外部改动。",
        ) {
            let _ = fs::remove_file(&temp);
            return Err(error);
        }
    }
    if let Err(error) = atomic_replace_file(&temp, target) {
        let _ = fs::remove_file(&temp);
        return Err(error);
    }
    if let Some(parent) = target.parent() {
        if let Ok(directory) = File::open(parent) {
            let _ = directory.sync_all();
        }
    }
    Ok(())
}

#[cfg(test)]
fn run_atomic_replace_test_hook(target: &Path) {
    let hook = ATOMIC_REPLACE_TEST_HOOK.get_or_init(|| Mutex::new(None));
    let mut slot = hook.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if slot
        .as_ref()
        .is_some_and(|(expected_target, _)| paths_equal(expected_target, target))
    {
        if let Some((_, bytes)) = slot.take() {
            let _ = fs::write(target, bytes);
        }
    }
}

/// Test-only: turns a committed snapshot back into an interrupted one (as if
/// the app stopped between the write and the commit record).
#[cfg(test)]
pub(crate) fn mark_snapshot_interrupted_for_test(context: &McpMutationContext, snapshot_id: &str) {
    let path = snapshot_manifest_path(context, snapshot_id).unwrap();
    let mut manifest: SnapshotManifest = read_protected_journal(&path).unwrap();
    manifest.state = "applying".to_string();
    write_replaceable_protected_journal(&path, &manifest).unwrap();
}

/// Test-only: the ids of every snapshot directory in the private store.
#[cfg(test)]
pub(crate) fn snapshot_ids_for_test(context: &McpMutationContext) -> Vec<String> {
    fs::read_dir(snapshots_dir(context))
        .map(|entries| {
            entries
                .flatten()
                .map(|entry| entry.file_name().to_string_lossy().to_string())
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
pub(crate) fn install_atomic_replace_test_hook(target: PathBuf, bytes: Vec<u8>) {
    *ATOMIC_REPLACE_TEST_HOOK
        .get_or_init(|| Mutex::new(None))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some((target, bytes));
}

#[cfg(windows)]
fn atomic_replace_file(temp: &Path, target: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    let mut temp_wide = temp.as_os_str().encode_wide().collect::<Vec<_>>();
    temp_wide.push(0);
    let mut target_wide = target.as_os_str().encode_wide().collect::<Vec<_>>();
    target_wide.push(0);
    let success = unsafe {
        MoveFileExW(
            temp_wide.as_ptr(),
            target_wide.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if success == 0 {
        Err("Windows 无法原子替换 MCP 配置。".to_string())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn atomic_replace_file(temp: &Path, target: &Path) -> Result<(), String> {
    fs::rename(temp, target).map_err(|_| "无法原子替换 MCP 配置。".to_string())
}

#[cfg(test)]
fn restore_batch_after_failure(
    prepared: &[PreparedWrite],
    written: usize,
    operation_id: &str,
) -> Result<(), String> {
    for item in prepared.iter().take(written) {
        let expected = item
            .applied_fingerprint
            .as_ref()
            .ok_or_else(|| "MCP 自动恢复缺少写后指纹，已安全停止。".to_string())?;
        ensure_target_fingerprint(
            &item.target.path,
            expected,
            "MCP 配置在自动恢复前被外部修改；已安全停止且不会覆盖外部改动。",
        )?;
    }
    for item in prepared.iter().take(written).rev() {
        let expected = item
            .applied_fingerprint
            .as_ref()
            .ok_or_else(|| "MCP 自动恢复缺少写后指纹，已安全停止。".to_string())?;
        ensure_target_fingerprint(
            &item.target.path,
            expected,
            "MCP 配置在自动恢复期间被外部修改；已安全停止且不会覆盖外部改动。",
        )?;
        if let Some(original) = &item.original {
            write_atomic(
                &item.target.path,
                &original.bytes,
                Some(original),
                operation_id,
                Some(expected),
            )?;
        } else if fs::symlink_metadata(&item.target.path).is_ok() {
            fs::remove_file(&item.target.path)
                .map_err(|_| "MCP 批量失败后无法移除新配置。".to_string())?;
        }
    }
    Ok(())
}

fn restore_post_plan_state(
    prepared: &[RollbackPreparation],
    restored: usize,
    operation_id: &str,
) -> Result<(), String> {
    for item in prepared.iter().take(restored) {
        let expected = item
            .restored_fingerprint
            .as_ref()
            .ok_or_else(|| "MCP 回滚事务恢复缺少回滚后指纹，已安全停止。".to_string())?;
        ensure_target_fingerprint(
            &item.target.path,
            expected,
            "MCP 配置在回滚事务恢复前被外部修改；已安全停止且不会覆盖外部改动。",
        )?;
    }
    for item in prepared.iter().take(restored).rev() {
        let expected = item
            .restored_fingerprint
            .as_ref()
            .ok_or_else(|| "MCP 回滚事务恢复缺少回滚后指纹，已安全停止。".to_string())?;
        ensure_target_fingerprint(
            &item.target.path,
            expected,
            "MCP 配置在回滚事务恢复期间被外部修改；已安全停止且不会覆盖外部改动。",
        )?;
        write_atomic(
            &item.target.path,
            &item.post_plan.bytes,
            Some(&item.post_plan),
            operation_id,
            Some(expected),
        )?;
    }
    Ok(())
}

fn plans_dir(context: &McpMutationContext) -> PathBuf {
    context
        .private_state_dir
        .join("mcp-mutations")
        .join("plans")
}

fn snapshots_dir(context: &McpMutationContext) -> PathBuf {
    context
        .private_state_dir
        .join("mcp-mutations")
        .join("snapshots")
}

fn plan_path(context: &McpMutationContext, plan_id: &str) -> Result<PathBuf, String> {
    validate_stored_id(plan_id, "plan")?;
    ensure_private_child_directory(&context.private_state_dir, &plans_dir(context))?;
    Ok(plans_dir(context).join(format!("{plan_id}.bin")))
}

fn remove_plan_journal(context: &McpMutationContext, plan_id: &str) -> Result<(), String> {
    let path = plan_path(context, plan_id)?;
    match fs::symlink_metadata(&path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            Err("MCP 计划清理目标不是安全的普通文件。".to_string())
        }
        Ok(_) => fs::remove_file(path).map_err(|_| "MCP 计划清理失败。".to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("MCP 计划清理目标不可读。".to_string()),
    }
}

fn prune_plan_store(
    context: &McpMutationContext,
    required_bytes: u64,
    required_entries: usize,
) -> Result<(), String> {
    ensure_private_child_directory(&context.private_state_dir, &plans_dir(context))?;
    if required_bytes > MAX_PLAN_CACHE_BYTES as u64 {
        return Err("MCP 计划超过 8 MiB 私有存储上限。".to_string());
    }
    let root = plans_dir(context);
    let now = SystemTime::now();
    let mut active = Vec::new();
    for entry in fs::read_dir(&root).map_err(|_| "MCP 计划存储目录不可读。".to_string())?
    {
        let entry = entry.map_err(|_| "MCP 计划存储条目不可读。".to_string())?;
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path)
            .map_err(|_| "MCP 计划存储条目元数据不可读。".to_string())?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err("MCP 计划存储包含不安全条目，已停止。".to_string());
        }
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            return Err("MCP 计划存储包含无效文件名。".to_string());
        };
        let Some(plan_id) = name.strip_suffix(".bin") else {
            return Err("MCP 计划存储包含未知文件，已停止。".to_string());
        };
        validate_stored_id(plan_id, "plan")?;
        let modified = metadata.modified().unwrap_or(UNIX_EPOCH);
        let age = now
            .duration_since(modified)
            .map(|duration| duration.as_millis())
            .unwrap_or_default();
        if age > PLAN_CACHE_TTL_MS {
            fs::remove_file(&path).map_err(|_| "MCP 过期计划清理失败。".to_string())?;
        } else {
            active.push((path, modified, metadata.len()));
        }
    }
    active.sort_by_key(|(_, modified, _)| *modified);
    let mut total_bytes = active.iter().map(|(_, _, size)| *size).sum::<u64>();
    while active.len().saturating_add(required_entries) > MAX_CACHED_PLANS
        || total_bytes.saturating_add(required_bytes) > MAX_PLAN_CACHE_BYTES as u64
    {
        if active.is_empty() {
            return Err("MCP 私有计划存储空间不足。".to_string());
        }
        let (path, _, size) = active.remove(0);
        fs::remove_file(path).map_err(|_| "MCP 最旧计划清理失败。".to_string())?;
        total_bytes = total_bytes.saturating_sub(size);
    }
    Ok(())
}

fn snapshot_dir_path(context: &McpMutationContext, snapshot_id: &str) -> Result<PathBuf, String> {
    validate_stored_id(snapshot_id, "snapshot")?;
    ensure_private_child_directory(&context.private_state_dir, &snapshots_dir(context))?;
    Ok(snapshots_dir(context).join(snapshot_id))
}

fn snapshot_manifest_path(
    context: &McpMutationContext,
    snapshot_id: &str,
) -> Result<PathBuf, String> {
    Ok(snapshot_dir_path(context, snapshot_id)?.join("manifest.bin"))
}

fn snapshot_backup_path(
    context: &McpMutationContext,
    snapshot_id: &str,
    index: usize,
) -> Result<PathBuf, String> {
    if index >= 64 {
        return Err("MCP 回滚目标索引超出上限。".to_string());
    }
    Ok(snapshot_dir_path(context, snapshot_id)?.join(format!("original-{index:02}.blob")))
}

fn snapshot_backup_path_by_name(
    context: &McpMutationContext,
    snapshot_id: &str,
    name: &str,
) -> Result<PathBuf, String> {
    validate_artifact_file_name(name)?;
    if !name.starts_with("original-") || !name.ends_with(".blob") {
        return Err("MCP 回滚文件名与受保护快照格式不匹配。".to_string());
    }
    Ok(snapshot_dir_path(context, snapshot_id)?.join(name))
}

fn prepare_snapshot_store(
    context: &McpMutationContext,
    required_bytes: u64,
    snapshot_id: &str,
) -> Result<(), String> {
    if required_bytes > MAX_SNAPSHOT_STORE_BYTES {
        return Err("MCP 回滚内容超过 128 MiB 私有快照上限，请拆分变更。".to_string());
    }
    prune_snapshot_store(context, required_bytes, 1)?;
    let directory = snapshot_dir_path(context, snapshot_id)?;
    fs::create_dir(&directory).map_err(|_| "MCP 私有回滚目录已存在或无法创建。".to_string())?;
    tighten_private_permissions(&directory, true)
}

fn prune_snapshot_store(
    context: &McpMutationContext,
    required_bytes: u64,
    required_entries: usize,
) -> Result<(), String> {
    ensure_private_child_directory(&context.private_state_dir, &snapshots_dir(context))?;
    let now = now_unix_ms();
    let root = snapshots_dir(context);
    let mut active = Vec::new();
    let mut protected_orphan_bytes = 0u64;
    let mut protected_orphan_entries = 0usize;
    for entry in fs::read_dir(&root).map_err(|_| "MCP 私有快照目录不可读。".to_string())?
    {
        let Ok(entry) = entry else { continue };
        let path = entry.path();
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            continue;
        };
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if validate_stored_id(name, "snapshot").is_err() {
            continue;
        }
        let manifest_path = path.join("manifest.bin");
        match read_protected_journal::<SnapshotManifest>(&manifest_path) {
            Ok(manifest)
                if manifest.schema_version == PLAN_SCHEMA_VERSION
                    && manifest.snapshot_id == name
                    && !manifest.rolled_back
                    && manifest.state == "committed"
                    && now <= manifest.expires_at_unix_ms =>
            {
                active.push((path, manifest, private_directory_size(&entry.path())?));
            }
            Ok(manifest)
                if manifest.schema_version == PLAN_SCHEMA_VERSION
                    && manifest.snapshot_id == name
                    && (manifest.rolled_back
                        || (manifest.state == "committed"
                            && now > manifest.expires_at_unix_ms)) =>
            {
                remove_private_snapshot_dir(&root, &path)?
            }
            Ok(manifest) if now > manifest.created_at_unix_ms.saturating_add(SNAPSHOT_TTL_MS) => {
                // A non-committed transaction older than the retention
                // window no longer counts as a protected orphan (bug MCP#2).
                remove_private_snapshot_dir(&root, &path)?
            }
            Ok(_) => {
                protected_orphan_bytes =
                    protected_orphan_bytes.saturating_add(private_directory_size(&path)?);
                protected_orphan_entries = protected_orphan_entries.saturating_add(1);
            }
            Err(_) => {
                let age_ms = metadata
                    .modified()
                    .ok()
                    .and_then(|time| SystemTime::now().duration_since(time).ok())
                    .map(|duration| duration.as_millis())
                    .unwrap_or_default();
                if age_ms > SNAPSHOT_TTL_MS {
                    remove_private_snapshot_dir(&root, &path)?;
                } else {
                    protected_orphan_bytes =
                        protected_orphan_bytes.saturating_add(private_directory_size(&path)?);
                    protected_orphan_entries = protected_orphan_entries.saturating_add(1);
                }
            }
        }
    }
    active.sort_by_key(|(_, manifest, _)| manifest.created_at_unix_ms);
    let mut total_bytes = active
        .iter()
        .map(|(_, _, size)| *size)
        .sum::<u64>()
        .saturating_add(protected_orphan_bytes);
    while active
        .len()
        .saturating_add(protected_orphan_entries)
        .saturating_add(required_entries)
        > MAX_ROLLBACK_SNAPSHOTS
        || total_bytes.saturating_add(required_bytes) > MAX_SNAPSHOT_STORE_BYTES
    {
        if active.is_empty() {
            return Err("MCP 私有回滚存储空间不足；请先完成或清理旧快照。".to_string());
        }
        let (path, _, size) = active.remove(0);
        remove_private_snapshot_dir(&root, &path)?;
        total_bytes = total_bytes.saturating_sub(size);
    }
    Ok(())
}

fn read_snapshot_manifests(
    context: &McpMutationContext,
) -> Result<Vec<(PathBuf, SnapshotManifest, u64)>, String> {
    ensure_private_child_directory(&context.private_state_dir, &snapshots_dir(context))?;
    let mut result = Vec::new();
    for entry in
        fs::read_dir(snapshots_dir(context)).map_err(|_| "MCP 私有快照目录不可读。".to_string())?
    {
        let Ok(entry) = entry else { continue };
        let path = entry.path();
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            continue;
        };
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if validate_stored_id(name, "snapshot").is_err() {
            continue;
        }
        let Ok(manifest) = read_protected_journal::<SnapshotManifest>(&path.join("manifest.bin"))
        else {
            continue;
        };
        if manifest.schema_version == PLAN_SCHEMA_VERSION && manifest.snapshot_id == name {
            let size = private_directory_size(&path)?;
            result.push((path, manifest, size));
        }
    }
    Ok(result)
}

fn private_directory_size(path: &Path) -> Result<u64, String> {
    let mut total = 0u64;
    for entry in fs::read_dir(path).map_err(|_| "MCP 私有快照不可读。".to_string())? {
        let entry = entry.map_err(|_| "MCP 私有快照条目不可读。".to_string())?;
        let metadata = fs::symlink_metadata(entry.path())
            .map_err(|_| "MCP 私有快照条目元数据不可读。".to_string())?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err("MCP 私有快照包含不安全条目，已停止。".to_string());
        }
        total = total.saturating_add(metadata.len());
    }
    Ok(total)
}

fn cleanup_snapshot_dir(context: &McpMutationContext, snapshot_id: &str) {
    let root = snapshots_dir(context);
    if let Ok(path) = snapshot_dir_path(context, snapshot_id) {
        let _ = remove_private_snapshot_dir(&root, &path);
    }
}

fn remove_private_snapshot_dir(root: &Path, path: &Path) -> Result<(), String> {
    if path.parent() != Some(root) {
        return Err("MCP 私有快照清理目标越界，已拒绝。".to_string());
    }
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err("MCP 私有快照清理目标不可读。".to_string()),
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("MCP 私有快照清理目标不安全，已拒绝。".to_string());
    }
    fs::remove_dir_all(path).map_err(|_| "MCP 私有快照清理失败。".to_string())
}

pub(crate) fn acquire_cross_process_mutation_lock(
    context: &McpMutationContext,
) -> Result<CrossProcessMutationLock, String> {
    ensure_private_directory(&context.private_state_dir)?;
    let path = context.private_state_dir.join("mcp-mutation.lock");
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&path)
        .map_err(|_| "MCP 跨进程写锁无法打开。".to_string())?;
    tighten_private_permissions(&path, false)?;
    file.try_lock()
        .map_err(|_| "另一个 AI SkillHub 进程正在修改 MCP 配置；请稍后重试。".to_string())?;
    Ok(CrossProcessMutationLock { file })
}

pub(crate) fn ensure_private_directory(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|_| "MCP 私有状态目录无法创建。".to_string())?;
    let metadata =
        fs::symlink_metadata(path).map_err(|_| "MCP 私有状态目录不可读。".to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("MCP 私有状态路径不是安全的普通目录。".to_string());
    }
    tighten_private_permissions(path, true)
}

fn ensure_private_child_directory(base: &Path, target: &Path) -> Result<(), String> {
    ensure_private_directory(base)?;
    let relative = target
        .strip_prefix(base)
        .map_err(|_| "MCP 私有状态子目录越界，已拒绝。".to_string())?;
    let mut current = base.to_path_buf();
    for component in relative.components() {
        use std::path::Component;
        let Component::Normal(name) = component else {
            return Err("MCP 私有状态子目录包含不安全路径。".to_string());
        };
        current.push(name);
        match fs::create_dir(&current) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(_) => return Err("MCP 私有状态子目录无法创建。".to_string()),
        }
        let metadata =
            fs::symlink_metadata(&current).map_err(|_| "MCP 私有状态子目录不可读。".to_string())?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err("MCP 私有状态子路径不是安全的普通目录。".to_string());
        }
        tighten_private_permissions(&current, true)?;
    }
    Ok(())
}

#[cfg(unix)]
fn tighten_private_permissions(path: &Path, is_directory: bool) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let mode = if is_directory { 0o700 } else { 0o600 };
    fs::set_permissions(path, fs::Permissions::from_mode(mode))
        .map_err(|_| "MCP 私有状态权限收紧失败。".to_string())
}

#[cfg(windows)]
fn tighten_private_permissions(_path: &Path, _is_directory: bool) -> Result<(), String> {
    // Files live below the current user's app-data state root and inherit that
    // ACL. Backup payloads are additionally protected by current-user DPAPI.
    Ok(())
}

fn validate_stored_id(value: &str, label: &str) -> Result<(), String> {
    let valid = !value.is_empty()
        && value.len() <= 120
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-');
    if valid {
        Ok(())
    } else {
        Err(format!("MCP {label} 标识无效。"))
    }
}

fn validate_artifact_file_name(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 240
        || value.contains(['/', '\\'])
        || value == "."
        || value == ".."
    {
        return Err("MCP 备份文件名无效。".to_string());
    }
    Ok(())
}

fn protected_journal_bytes<T: Serialize>(value: &T) -> Result<Vec<u8>, String> {
    let plain =
        serde_json::to_vec_pretty(value).map_err(|_| "MCP journal 序列化失败。".to_string())?;
    if plain.len() as u64 > MAX_JOURNAL_BYTES {
        return Err("MCP journal 超过大小上限。".to_string());
    }
    protect_private_backup(&plain)
}

fn write_protected_journal<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "MCP journal 路径无效。".to_string())?;
    ensure_private_directory(parent)?;
    let bytes = protected_journal_bytes(value)?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|_| "MCP journal 已存在或无法创建。".to_string())?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| "MCP journal 写入失败。".to_string())?;
    tighten_private_permissions(path, false)
}

fn write_replaceable_protected_journal<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let bytes = protected_journal_bytes(value)?;
    let expected = current_fingerprint(path)?.unwrap_or_else(FileFingerprint::missing);
    let operation_id = format!("journal-{}", Uuid::new_v4().simple());
    write_atomic(path, &bytes, None, &operation_id, Some(&expected))?;
    tighten_private_permissions(path, false)
}

fn read_protected_journal<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T, String> {
    let metadata =
        fs::symlink_metadata(path).map_err(|_| "MCP journal 不存在或不可读。".to_string())?;
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.len() > MAX_JOURNAL_BYTES.saturating_add(64 * 1024)
    {
        return Err("MCP journal 不是安全的普通文件。".to_string());
    }
    let protected = fs::read(path).map_err(|_| "MCP journal 读取失败。".to_string())?;
    let bytes = unprotect_private_backup(&protected)?;
    if bytes.len() as u64 > MAX_JOURNAL_BYTES {
        return Err("MCP journal 解密后超过大小上限。".to_string());
    }
    serde_json::from_slice(&bytes).map_err(|_| "MCP journal 解析失败。".to_string())
}

fn plan_cache() -> &'static Mutex<HashMap<String, CachedPlan>> {
    PLAN_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cache_plan(plan_id: &str, plan: CachedPlan) {
    let mut cache = plan_cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    prune_plan_cache(&mut cache, now_unix_ms());
    while cache.len() >= MAX_CACHED_PLANS
        || cache.values().map(|item| item.byte_len).sum::<usize>() + plan.byte_len
            > MAX_PLAN_CACHE_BYTES
    {
        if let Some(oldest) = cache
            .iter()
            .min_by_key(|(_, item)| item.created_at_unix_ms)
            .map(|(id, _)| id.clone())
        {
            cache.remove(&oldest);
        } else {
            break;
        }
    }
    cache.insert(plan_id.to_string(), plan);
}

fn prune_plan_cache(cache: &mut HashMap<String, CachedPlan>, now_unix_ms: u128) {
    cache
        .retain(|_, plan| now_unix_ms.saturating_sub(plan.created_at_unix_ms) <= PLAN_CACHE_TTL_MS);
    while cache.len() > MAX_CACHED_PLANS
        || cache.values().map(|plan| plan.byte_len).sum::<usize>() > MAX_PLAN_CACHE_BYTES
    {
        if let Some(oldest) = cache
            .iter()
            .min_by_key(|(_, item)| item.created_at_unix_ms)
            .map(|(id, _)| id.clone())
        {
            cache.remove(&oldest);
        } else {
            break;
        }
    }
}

fn cached_plan(plan_id: &str) -> Option<CachedPlan> {
    let mut cache = plan_cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    prune_plan_cache(&mut cache, now_unix_ms());
    cache.get(plan_id).cloned()
}

fn remove_cached_plan(plan_id: &str) {
    plan_cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .remove(plan_id);
}

pub(crate) fn now_unix_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static FIXTURE_COUNTER: AtomicU64 = AtomicU64::new(0);

    fn fixture(name: &str) -> (PathBuf, McpMutationContext) {
        let root = std::env::temp_dir().join(format!(
            "ai-skillhub-mcp-mutation-{name}-{}-{}",
            now_unix_ms(),
            FIXTURE_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let home = root.join("home");
        let workspace = root.join("workspace");
        fs::create_dir_all(home.join(".codex")).unwrap();
        fs::create_dir_all(home.join(".claude")).unwrap();
        fs::create_dir_all(workspace.join(".codex")).unwrap();
        let context = McpMutationContext::basic(
            home,
            vec![mcp_center::RegisteredWorkspace {
                id: "workspace-one".to_string(),
                display_name: "Workspace One".to_string(),
                path: workspace,
            }],
            root.join("private"),
        );
        (root, context)
    }

    fn stdio_draft(enabled: bool) -> McpBindingDraft {
        McpBindingDraft {
            transport: "stdio".to_string(),
            command: Some("npx".to_string()),
            args: vec!["-y".to_string(), "demo-mcp".to_string()],
            url: None,
            env_vars: vec!["DEMO_TOKEN".to_string()],
            header_env: Vec::new(),
            enabled,
            required: false,
        }
    }

    fn request(changes: Vec<McpBindingChange>) -> McpMutationBatchRequest {
        McpMutationBatchRequest { changes }
    }

    #[test]
    fn codex_plan_apply_and_rollback_preserve_unknowns_and_secrets() {
        let (root, context) = fixture("codex");
        let path = context.home_dir.join(".codex/config.toml");
        let original = r#"# keep this comment
model = "gpt-test"

[mcp_servers.demo]
command = "old-command"
args = ["old-package"]
env = { API_TOKEN = "do-not-leak-this-secret" }
custom_key = "keep-me"

[[skills.config]]
path = 'C:\Skills\fixture'
enabled = false

[profiles.fixture]
developer_instructions = '''
Preserve this multiline note and unrelated tables.
'''
"#;
        fs::write(&path, original).unwrap();
        let plan = plan_mcp_changes(
            &context,
            request(vec![McpBindingChange {
                host_id: HOST_CODEX.to_string(),
                scope: "user".to_string(),
                workspace_id: None,
                action: "upsert".to_string(),
                server_name: "demo".to_string(),
                draft: Some(stdio_draft(false)),
                enabled: None,
            }]),
        )
        .unwrap();
        let stored: StoredPlan =
            read_protected_journal(&plan_path(&context, &plan.plan_id).unwrap()).unwrap();
        let plan_json = serde_json::to_string(&stored).unwrap();
        assert!(!plan_json.contains("do-not-leak-this-secret"));
        assert!(!plan_json.contains("npx"));
        assert!(!plan_json.contains("demo-mcp"));
        assert!(!plan_json.contains("DEMO_TOKEN"));
        assert!(!plan_json.contains("\"request\""));
        assert!(plan_json.contains("cacheNonce"));
        assert!(!serde_json::to_string(&plan)
            .unwrap()
            .contains("do-not-leak-this-secret"));

        let applied = apply_mcp_plan(&context, &plan.plan_id).unwrap();
        let written = fs::read_to_string(&path).unwrap();
        assert!(written.contains("# keep this comment"));
        assert!(written.contains("custom_key = \"keep-me\""));
        assert!(written.contains("[[skills.config]]"));
        assert!(written.contains("Preserve this multiline note and unrelated tables."));
        assert!(written.contains("do-not-leak-this-secret"));
        assert!(written.contains("DEMO_TOKEN"));
        assert!(written.contains("enabled = false"));

        let rolled_back = rollback_mcp_snapshot(&context, &applied.snapshot_id).unwrap();
        assert!(rolled_back.verified);
        assert_eq!(fs::read_to_string(&path).unwrap(), original);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn claude_strict_json_preserves_unknown_and_inline_values_without_journaling_them() {
        let (root, context) = fixture("claude");
        let path = context.home_dir.join(".claude.json");
        let original = r#"{
  "theme": "dark",
  "mcpServers": {
    "demo": {
      "command": "old",
      "env": { "API_TOKEN": "never-return-this" },
      "unknown": { "keep": true }
    }
  }
}"#;
        fs::write(&path, original).unwrap();
        let plan = plan_mcp_changes(
            &context,
            request(vec![McpBindingChange {
                host_id: HOST_CLAUDE_CODE.to_string(),
                scope: "user".to_string(),
                workspace_id: None,
                action: "upsert".to_string(),
                server_name: "demo".to_string(),
                draft: Some(stdio_draft(true)),
                enabled: None,
            }]),
        )
        .unwrap();
        let stored: StoredPlan =
            read_protected_journal(&plan_path(&context, &plan.plan_id).unwrap()).unwrap();
        let journal = serde_json::to_string(&stored).unwrap();
        assert!(!journal.contains("never-return-this"));
        let applied = apply_mcp_plan(&context, &plan.plan_id).unwrap();
        let written: JsonValue = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(written["theme"], "dark");
        assert_eq!(written["mcpServers"]["demo"]["unknown"]["keep"], true);
        assert_eq!(
            written["mcpServers"]["demo"]["env"]["API_TOKEN"],
            "never-return-this"
        );
        assert_eq!(
            written["mcpServers"]["demo"]["env"]["DEMO_TOKEN"],
            "${DEMO_TOKEN}"
        );
        rollback_mcp_snapshot(&context, &applied.snapshot_id).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), original);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn disk_journal_cannot_apply_after_process_memory_plan_is_gone() {
        let (root, context) = fixture("memory-only-plan");
        let path = context.home_dir.join(".codex/config.toml");
        fs::write(&path, "# unchanged\n").unwrap();
        let plan = plan_mcp_changes(
            &context,
            request(vec![McpBindingChange {
                host_id: HOST_CODEX.to_string(),
                scope: "user".to_string(),
                workspace_id: None,
                action: "upsert".to_string(),
                server_name: "demo".to_string(),
                draft: Some(stdio_draft(true)),
                enabled: None,
            }]),
        )
        .unwrap();
        remove_cached_plan(&plan.plan_id);
        let error = apply_mcp_plan(&context, &plan.plan_id).unwrap_err();
        assert!(error.contains("已过期"));
        assert_eq!(fs::read_to_string(&path).unwrap(), "# unchanged\n");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn claude_jsonc_is_readable_elsewhere_but_remains_write_blocked() {
        let (root, context) = fixture("jsonc");
        fs::write(
            context.home_dir.join(".claude.json"),
            "{\n // preserve me\n \"mcpServers\": {},\n}\n",
        )
        .unwrap();
        let error = plan_mcp_changes(
            &context,
            request(vec![McpBindingChange {
                host_id: HOST_CLAUDE_CODE.to_string(),
                scope: "user".to_string(),
                workspace_id: None,
                action: "upsert".to_string(),
                server_name: "demo".to_string(),
                draft: Some(stdio_draft(true)),
                enabled: None,
            }]),
        )
        .unwrap_err();
        assert!(error.contains("严格 JSON"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn changed_file_after_plan_is_rejected_without_backup_or_write() {
        let (root, context) = fixture("toctou");
        let path = context.home_dir.join(".codex/config.toml");
        fs::write(&path, "[mcp_servers.demo]\ncommand = \"old\"\n").unwrap();
        let plan = plan_mcp_changes(
            &context,
            request(vec![McpBindingChange {
                host_id: HOST_CODEX.to_string(),
                scope: "user".to_string(),
                workspace_id: None,
                action: "set-enabled".to_string(),
                server_name: "demo".to_string(),
                draft: None,
                enabled: Some(false),
            }]),
        )
        .unwrap();
        fs::write(&path, "[mcp_servers.demo]\ncommand = \"external-change\"\n").unwrap();
        let error = apply_mcp_plan(&context, &plan.plan_id).unwrap_err();
        assert!(error.contains("计划后发生变化"));
        assert!(cached_plan(&plan.plan_id).is_none());
        assert!(fs::read_to_string(&path)
            .unwrap()
            .contains("external-change"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn set_enabled_and_delete_apply_together_and_rollback_exactly() {
        let (root, context) = fixture("set-enabled-delete");
        let path = context.home_dir.join(".codex/config.toml");
        let original = r#"[mcp_servers.demo]
command = "demo"
enabled = true

[mcp_servers.obsolete]
command = "obsolete"
"#;
        fs::write(&path, original).unwrap();
        let plan = plan_mcp_changes(
            &context,
            request(vec![
                McpBindingChange {
                    host_id: HOST_CODEX.to_string(),
                    scope: "user".to_string(),
                    workspace_id: None,
                    action: "set-enabled".to_string(),
                    server_name: "demo".to_string(),
                    draft: None,
                    enabled: Some(false),
                },
                McpBindingChange {
                    host_id: HOST_CODEX.to_string(),
                    scope: "user".to_string(),
                    workspace_id: None,
                    action: "delete".to_string(),
                    server_name: "obsolete".to_string(),
                    draft: None,
                    enabled: None,
                },
            ]),
        )
        .unwrap();
        let applied = apply_mcp_plan(&context, &plan.plan_id).unwrap();
        let written = fs::read_to_string(&path).unwrap();
        assert!(written.contains("enabled = false"));
        assert!(!written.contains("mcp_servers.obsolete"));
        rollback_mcp_snapshot(&context, &applied.snapshot_id).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), original);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn multi_host_failure_restores_every_already_written_config() {
        let (root, context) = fixture("batch-rollback");
        let codex_path = context.home_dir.join(".codex/config.toml");
        let claude_path = context.home_dir.join(".claude.json");
        let codex_original = "[mcp_servers.demo]\ncommand = \"old-codex\"\n";
        let claude_original = "{\"mcpServers\":{\"demo\":{\"command\":\"old-claude\"}}}";
        fs::write(&codex_path, codex_original).unwrap();
        fs::write(&claude_path, claude_original).unwrap();
        let plan = plan_mcp_changes(
            &context,
            request(vec![
                McpBindingChange {
                    host_id: HOST_CODEX.to_string(),
                    scope: "user".to_string(),
                    workspace_id: None,
                    action: "upsert".to_string(),
                    server_name: "demo".to_string(),
                    draft: Some(stdio_draft(true)),
                    enabled: None,
                },
                McpBindingChange {
                    host_id: HOST_CLAUDE_CODE.to_string(),
                    scope: "user".to_string(),
                    workspace_id: None,
                    action: "upsert".to_string(),
                    server_name: "demo".to_string(),
                    draft: Some(stdio_draft(true)),
                    enabled: None,
                },
            ]),
        )
        .unwrap();
        let error = apply_mcp_plan_internal(&context, &plan.plan_id, Some(1)).unwrap_err();
        assert!(error.contains("测试注入"));
        assert_eq!(fs::read_to_string(&codex_path).unwrap(), codex_original);
        assert_eq!(fs::read_to_string(&claude_path).unwrap(), claude_original);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn incomplete_apply_after_unrecorded_write_recovers_on_next_list() {
        let (root, context) = fixture("crash-apply-single");
        let path = context.home_dir.join(".codex/config.toml");
        let original = "[mcp_servers.demo]\ncommand = \"before\"\n";
        fs::write(&path, original).unwrap();
        let plan = plan_mcp_changes(
            &context,
            request(vec![McpBindingChange {
                host_id: HOST_CODEX.to_string(),
                scope: "user".to_string(),
                workspace_id: None,
                action: "upsert".to_string(),
                server_name: "demo".to_string(),
                draft: Some(stdio_draft(true)),
                enabled: None,
            }]),
        )
        .unwrap();
        let snapshot_id = format!(
            "mcp-snapshot-{}",
            plan.plan_id.trim_start_matches("mcp-plan-")
        );
        let error = apply_mcp_plan_once(&context, &plan.plan_id, Some(1), false).unwrap_err();
        assert!(error.contains("测试注入"));
        assert_ne!(fs::read_to_string(&path).unwrap(), original);

        let manifest_path = snapshot_manifest_path(&context, &snapshot_id).unwrap();
        let mut manifest: SnapshotManifest = read_protected_journal(&manifest_path).unwrap();
        manifest.targets[0].applied = None;
        write_replaceable_protected_journal(&manifest_path, &manifest).unwrap();
        remove_cached_plan(&plan.plan_id);

        let listed = list_mcp_rollback_snapshots(&context).unwrap();
        assert!(listed.is_empty());
        assert_eq!(fs::read_to_string(&path).unwrap(), original);
        assert!(!snapshot_dir_path(&context, &snapshot_id).unwrap().exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn incomplete_multi_host_apply_recovers_every_target_on_next_list() {
        let (root, context) = fixture("crash-apply-multi");
        let codex_path = context.home_dir.join(".codex/config.toml");
        let claude_path = context.home_dir.join(".claude.json");
        let codex_original = "[mcp_servers.demo]\ncommand = \"before-codex\"\n";
        let claude_original = "{\"mcpServers\":{\"demo\":{\"command\":\"before-claude\"}}}";
        fs::write(&codex_path, codex_original).unwrap();
        fs::write(&claude_path, claude_original).unwrap();
        let plan = plan_mcp_changes(
            &context,
            request(vec![
                McpBindingChange {
                    host_id: HOST_CODEX.to_string(),
                    scope: "user".to_string(),
                    workspace_id: None,
                    action: "upsert".to_string(),
                    server_name: "demo".to_string(),
                    draft: Some(stdio_draft(true)),
                    enabled: None,
                },
                McpBindingChange {
                    host_id: HOST_CLAUDE_CODE.to_string(),
                    scope: "user".to_string(),
                    workspace_id: None,
                    action: "upsert".to_string(),
                    server_name: "demo".to_string(),
                    draft: Some(stdio_draft(true)),
                    enabled: None,
                },
            ]),
        )
        .unwrap();
        let error = apply_mcp_plan_once(&context, &plan.plan_id, Some(1), false).unwrap_err();
        assert!(error.contains("测试注入"));
        remove_cached_plan(&plan.plan_id);

        assert!(list_mcp_rollback_snapshots(&context).unwrap().is_empty());
        assert_eq!(fs::read_to_string(&codex_path).unwrap(), codex_original);
        assert_eq!(fs::read_to_string(&claude_path).unwrap(), claude_original);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn interrupted_multi_host_rollback_finishes_on_next_list() {
        let (root, context) = fixture("crash-rollback-multi");
        let codex_path = context.home_dir.join(".codex/config.toml");
        let claude_path = context.home_dir.join(".claude.json");
        let codex_original = "[mcp_servers.demo]\ncommand = \"before-codex\"\n";
        let claude_original = "{\"mcpServers\":{\"demo\":{\"command\":\"before-claude\"}}}";
        fs::write(&codex_path, codex_original).unwrap();
        fs::write(&claude_path, claude_original).unwrap();
        let plan = plan_mcp_changes(
            &context,
            request(vec![
                McpBindingChange {
                    host_id: HOST_CODEX.to_string(),
                    scope: "user".to_string(),
                    workspace_id: None,
                    action: "upsert".to_string(),
                    server_name: "demo".to_string(),
                    draft: Some(stdio_draft(true)),
                    enabled: None,
                },
                McpBindingChange {
                    host_id: HOST_CLAUDE_CODE.to_string(),
                    scope: "user".to_string(),
                    workspace_id: None,
                    action: "upsert".to_string(),
                    server_name: "demo".to_string(),
                    draft: Some(stdio_draft(true)),
                    enabled: None,
                },
            ]),
        )
        .unwrap();
        let applied = apply_mcp_plan(&context, &plan.plan_id).unwrap();
        let error =
            rollback_mcp_snapshot_once(&context, &applied.snapshot_id, Some(1), false).unwrap_err();
        assert!(error.contains("测试注入"));

        assert!(list_mcp_rollback_snapshots(&context).unwrap().is_empty());
        assert_eq!(fs::read_to_string(&codex_path).unwrap(), codex_original);
        assert_eq!(fs::read_to_string(&claude_path).unwrap(), claude_original);
        assert!(!snapshot_dir_path(&context, &applied.snapshot_id)
            .unwrap()
            .exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn crash_after_temp_fsync_cleans_known_plaintext_temp_on_recovery() {
        let (root, context) = fixture("crash-temp");
        let path = context.home_dir.join(".codex/config.toml");
        let original = "[mcp_servers.demo]\ncommand = \"before\"\n";
        fs::write(&path, original).unwrap();
        let plan = plan_mcp_changes(
            &context,
            request(vec![McpBindingChange {
                host_id: HOST_CODEX.to_string(),
                scope: "user".to_string(),
                workspace_id: None,
                action: "upsert".to_string(),
                server_name: "demo".to_string(),
                draft: Some(stdio_draft(true)),
                enabled: None,
            }]),
        )
        .unwrap();
        let snapshot_id = format!(
            "mcp-snapshot-{}",
            plan.plan_id.trim_start_matches("mcp-plan-")
        );
        apply_mcp_plan_once(&context, &plan.plan_id, Some(1), false).unwrap_err();
        let final_bytes = fs::read(&path).unwrap();
        fs::write(&path, original).unwrap();
        let temp = sibling_artifact_path(&path, "temp", &snapshot_id).unwrap();
        fs::write(&temp, final_bytes).unwrap();
        remove_cached_plan(&plan.plan_id);

        assert!(list_mcp_rollback_snapshots(&context).unwrap().is_empty());
        assert_eq!(fs::read_to_string(&path).unwrap(), original);
        assert!(!temp.exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn incomplete_apply_preserves_external_change_and_recovery_evidence() {
        let (root, context) = fixture("crash-external");
        let path = context.home_dir.join(".codex/config.toml");
        fs::write(&path, "[mcp_servers.demo]\ncommand = \"before\"\n").unwrap();
        let plan = plan_mcp_changes(
            &context,
            request(vec![McpBindingChange {
                host_id: HOST_CODEX.to_string(),
                scope: "user".to_string(),
                workspace_id: None,
                action: "upsert".to_string(),
                server_name: "demo".to_string(),
                draft: Some(stdio_draft(true)),
                enabled: None,
            }]),
        )
        .unwrap();
        let snapshot_id = format!(
            "mcp-snapshot-{}",
            plan.plan_id.trim_start_matches("mcp-plan-")
        );
        apply_mcp_plan_once(&context, &plan.plan_id, Some(1), false).unwrap_err();
        let external = "[mcp_servers.demo]\ncommand = \"external\"\n";
        fs::write(&path, external).unwrap();
        remove_cached_plan(&plan.plan_id);

        // R19: the external change is kept, the transaction becomes terminal
        // and neither reads nor later writes are blocked (bug MCP#2).
        assert!(list_mcp_rollback_snapshots(&context).unwrap().is_empty());
        assert_eq!(fs::read_to_string(&path).unwrap(), external);
        let manifest: SnapshotManifest =
            read_protected_journal(&snapshot_manifest_path(&context, &snapshot_id).unwrap())
                .unwrap();
        assert_eq!(manifest.state, ABANDONED_EXTERNAL_CHANGE);
        let stuck = list_stuck_transactions(&context);
        assert_eq!(stuck.len(), 1);
        assert_eq!(stuck[0].snapshot_id, snapshot_id);
        let next = plan_mcp_changes(
            &context,
            request(vec![McpBindingChange {
                host_id: HOST_CODEX.to_string(),
                scope: "user".to_string(),
                workspace_id: None,
                action: "set-enabled".to_string(),
                server_name: "demo".to_string(),
                draft: None,
                enabled: Some(false),
            }]),
        )
        .unwrap();
        apply_mcp_plan(&context, &next.plan_id).unwrap();
        assert!(fs::read_to_string(&path)
            .unwrap()
            .contains("enabled = false"));
        resolve_stuck_transaction(&context, &snapshot_id).unwrap();
        assert!(list_stuck_transactions(&context).is_empty());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn values_and_sensitive_arguments_are_not_accepted_by_the_public_schema() {
        let parsed = serde_json::from_str::<McpBindingDraft>(
            r#"{"transport":"stdio","command":"npx","envValues":{"TOKEN":"secret"}}"#,
        );
        assert!(parsed.is_err());
        let change = McpBindingChange {
            host_id: HOST_CODEX.to_string(),
            scope: "user".to_string(),
            workspace_id: None,
            action: "upsert".to_string(),
            server_name: "demo".to_string(),
            draft: Some(McpBindingDraft {
                args: vec!["--api-key=secret".to_string()],
                ..stdio_draft(true)
            }),
            enabled: None,
        };
        assert!(validate_change(&change).unwrap_err().contains("凭据"));
    }

    #[test]
    fn split_and_prefixed_credentials_are_rejected_without_echoing_values() {
        for flag in ["--api-key", "--key"] {
            let credential = ["sk-", "live-value-that-must-not-be-returned"].concat();
            let change = McpBindingChange {
                host_id: HOST_CODEX.to_string(),
                scope: "user".to_string(),
                workspace_id: None,
                action: "upsert".to_string(),
                server_name: "demo".to_string(),
                draft: Some(McpBindingDraft {
                    args: vec![flag.to_string(), credential.clone()],
                    ..stdio_draft(true)
                }),
                enabled: None,
            };
            let error = validate_change(&change).unwrap_err();
            assert!(error.contains("凭据"));
            assert!(!error.contains(&credential));
        }
    }

    #[test]
    fn high_risk_command_and_url_are_rejected_without_echoing_values() {
        let command_value = "npx --key sk-command-value";
        let command = McpBindingChange {
            host_id: HOST_CODEX.to_string(),
            scope: "user".to_string(),
            workspace_id: None,
            action: "upsert".to_string(),
            server_name: "demo".to_string(),
            draft: Some(McpBindingDraft {
                command: Some(command_value.to_string()),
                ..stdio_draft(true)
            }),
            enabled: None,
        };
        let command_error = validate_change(&command).unwrap_err();
        assert!(!command_error.contains(command_value));

        let url_value = "https://example.test/sk-live-url-value";
        let url = McpBindingChange {
            host_id: HOST_CLAUDE_CODE.to_string(),
            scope: "user".to_string(),
            workspace_id: None,
            action: "upsert".to_string(),
            server_name: "demo".to_string(),
            draft: Some(McpBindingDraft {
                transport: "http".to_string(),
                command: None,
                args: Vec::new(),
                url: Some(url_value.to_string()),
                env_vars: Vec::new(),
                header_env: Vec::new(),
                enabled: true,
                required: false,
            }),
            enabled: None,
        };
        let url_error = validate_change(&url).unwrap_err();
        assert!(!url_error.contains(url_value));
    }

    #[test]
    fn normal_npx_package_arguments_remain_valid() {
        let change = McpBindingChange {
            host_id: HOST_CODEX.to_string(),
            scope: "user".to_string(),
            workspace_id: None,
            action: "upsert".to_string(),
            server_name: "demo".to_string(),
            draft: Some(stdio_draft(true)),
            enabled: None,
        };
        validate_change(&change).unwrap();
    }

    #[test]
    fn claude_upsert_omits_binding_enablement_and_preserves_unknown_keys() {
        let (root, context) = fixture("claude-no-binding-enablement");
        let path = context.home_dir.join(".claude.json");
        fs::write(
            &path,
            r#"{"mcpServers":{"legacy":{"command":"old","disabled":true}}}"#,
        )
        .unwrap();
        let plan = plan_mcp_changes(
            &context,
            request(vec![
                McpBindingChange {
                    host_id: HOST_CLAUDE_CODE.to_string(),
                    scope: "user".to_string(),
                    workspace_id: None,
                    action: "upsert".to_string(),
                    server_name: "new-server".to_string(),
                    draft: Some(stdio_draft(true)),
                    enabled: None,
                },
                McpBindingChange {
                    host_id: HOST_CLAUDE_CODE.to_string(),
                    scope: "user".to_string(),
                    workspace_id: None,
                    action: "upsert".to_string(),
                    server_name: "legacy".to_string(),
                    draft: Some(stdio_draft(true)),
                    enabled: None,
                },
            ]),
        )
        .unwrap();
        apply_mcp_plan(&context, &plan.plan_id).unwrap();

        let written: JsonValue = serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap();
        let new_binding = written["mcpServers"]["new-server"].as_object().unwrap();
        assert!(!new_binding.contains_key("enabled"));
        assert!(!new_binding.contains_key("disabled"));
        assert_eq!(written["mcpServers"]["legacy"]["disabled"], true);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn claude_enablement_mutations_are_rejected() {
        let toggle = McpBindingChange {
            host_id: HOST_CLAUDE_CODE.to_string(),
            scope: "user".to_string(),
            workspace_id: None,
            action: "set-enabled".to_string(),
            server_name: "demo".to_string(),
            draft: None,
            enabled: Some(false),
        };
        assert!(validate_change(&toggle).unwrap_err().contains("按项目管理"));

        let disabled_upsert = McpBindingChange {
            host_id: HOST_CLAUDE_CODE.to_string(),
            scope: "user".to_string(),
            workspace_id: None,
            action: "upsert".to_string(),
            server_name: "demo".to_string(),
            draft: Some(stdio_draft(false)),
            enabled: None,
        };
        assert!(validate_change(&disabled_upsert)
            .unwrap_err()
            .contains("enabled 必须为 true"));
    }

    #[test]
    fn claude_rejects_dotted_server_names_while_codex_accepts_them() {
        let mut change = McpBindingChange {
            host_id: HOST_CLAUDE_CODE.to_string(),
            scope: "user".to_string(),
            workspace_id: None,
            action: "upsert".to_string(),
            server_name: "demo.server".to_string(),
            draft: Some(stdio_draft(true)),
            enabled: None,
        };
        assert!(validate_change(&change)
            .unwrap_err()
            .contains("Claude Code"));

        change.host_id = HOST_CODEX.to_string();
        validate_change(&change).unwrap();

        let (root, context) = fixture("codex-dotted-server-name");
        let plan = plan_mcp_changes(&context, request(vec![change])).unwrap();
        apply_mcp_plan(&context, &plan.plan_id).unwrap();
        let document = fs::read_to_string(context.home_dir.join(".codex/config.toml"))
            .unwrap()
            .parse::<DocumentMut>()
            .unwrap();
        assert!(document["mcp_servers"]
            .as_table()
            .unwrap()
            .contains_key("demo.server"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn claude_reserved_names_are_rejected_while_codex_keeps_them_available() {
        for name in ["workspace", "claude-in-chrome", "computer-use"] {
            let mut change = McpBindingChange {
                host_id: HOST_CLAUDE_CODE.to_string(),
                scope: "user".to_string(),
                workspace_id: None,
                action: "upsert".to_string(),
                server_name: name.to_string(),
                draft: Some(stdio_draft(true)),
                enabled: None,
            };
            assert!(validate_change(&change).unwrap_err().contains("保留"));
            change.host_id = HOST_CODEX.to_string();
            validate_change(&change).unwrap();
        }
    }

    #[test]
    fn claude_reconfigure_replaces_known_refs_and_preserves_inline_values() {
        let (root, context) = fixture("claude-replace-refs");
        let path = context.home_dir.join(".claude.json");
        fs::write(
            &path,
            r#"{
  "mcpServers": {
    "demo": {
      "command": "old",
      "env": { "OLD_REF": "${OLD_REF}", "INLINE": "keep-inline" },
      "headers": { "Authorization": "${OLD_TOKEN}", "X-Static": "keep-header" }
    }
  }
}"#,
        )
        .unwrap();
        let mut draft = stdio_draft(true);
        draft.env_vars.clear();
        draft.header_env.clear();
        let plan = plan_mcp_changes(
            &context,
            request(vec![McpBindingChange {
                host_id: HOST_CLAUDE_CODE.to_string(),
                scope: "user".to_string(),
                workspace_id: None,
                action: "upsert".to_string(),
                server_name: "demo".to_string(),
                draft: Some(draft),
                enabled: None,
            }]),
        )
        .unwrap();
        apply_mcp_plan(&context, &plan.plan_id).unwrap();

        let written: JsonValue = serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap();
        let binding = &written["mcpServers"]["demo"];
        assert!(binding["env"].get("OLD_REF").is_none());
        assert_eq!(binding["env"]["INLINE"], "keep-inline");
        assert!(binding["headers"].get("Authorization").is_none());
        assert_eq!(binding["headers"]["X-Static"], "keep-header");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn docker_env_reference_and_token_named_packages_are_safe_but_assignments_are_not() {
        let safe = McpBindingChange {
            host_id: HOST_CODEX.to_string(),
            scope: "user".to_string(),
            workspace_id: None,
            action: "upsert".to_string(),
            server_name: "demo".to_string(),
            draft: Some(McpBindingDraft {
                command: Some("docker".to_string()),
                args: vec![
                    "run".to_string(),
                    "--env".to_string(),
                    "API_TOKEN".to_string(),
                    "example/token-helper:latest".to_string(),
                ],
                env_vars: Vec::new(),
                ..stdio_draft(true)
            }),
            enabled: None,
        };
        validate_change(&safe).unwrap();

        let package = McpBindingChange {
            draft: Some(McpBindingDraft {
                args: vec!["-y".to_string(), "@scope/token-helper".to_string()],
                ..stdio_draft(true)
            }),
            ..safe.clone()
        };
        validate_change(&package).unwrap();

        for unsafe_argument in ["API_TOKEN=ordinary-value", "--env=API_TOKEN"] {
            let unsafe_change = McpBindingChange {
                draft: Some(McpBindingDraft {
                    args: vec![unsafe_argument.to_string()],
                    ..stdio_draft(true)
                }),
                ..safe.clone()
            };
            let error = validate_change(&unsafe_change).unwrap_err();
            assert!(error.contains("凭据") || error.contains("环境变量名称"));
        }
        let env_assignment = McpBindingChange {
            draft: Some(McpBindingDraft {
                args: vec!["--env".to_string(), "API_TOKEN=ordinary-value".to_string()],
                ..stdio_draft(true)
            }),
            ..safe
        };
        assert!(validate_change(&env_assignment)
            .unwrap_err()
            .contains("环境变量名称"));
    }

    #[test]
    fn codex_object_env_vars_are_kept_read_only() {
        let (root, context) = fixture("codex-object-env-vars");
        let path = context.home_dir.join(".codex/config.toml");
        let original = r#"[mcp_servers.demo]
command = "npx"
env_vars = [{ name = "REMOTE_TOKEN", source = "remote" }]
"#;
        fs::write(&path, original).unwrap();
        let error = plan_mcp_changes(
            &context,
            request(vec![McpBindingChange {
                host_id: HOST_CODEX.to_string(),
                scope: "user".to_string(),
                workspace_id: None,
                action: "upsert".to_string(),
                server_name: "demo".to_string(),
                draft: Some(stdio_draft(true)),
                enabled: None,
            }]),
        )
        .unwrap_err();
        assert!(error.contains("对象式 env_vars"));
        assert_eq!(fs::read_to_string(path).unwrap(), original);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn common_stdio_commands_and_http_bindings_have_host_native_shapes() {
        let (root, context) = fixture("common-golden-configs");
        let commands = [
            ("uvx-server", "uvx", vec!["mcp-server-fetch"]),
            ("python-server", "python", vec!["-m", "mcp_server_demo"]),
            ("node-server", "node", vec!["server.js"]),
            (
                "docker-server",
                "docker",
                vec![
                    "run",
                    "--rm",
                    "-i",
                    "--env",
                    "MCP_API_TOKEN",
                    "example/mcp:latest",
                ],
            ),
        ];
        let mut changes = commands
            .iter()
            .map(|(name, command, args)| McpBindingChange {
                host_id: HOST_CODEX.to_string(),
                scope: "user".to_string(),
                workspace_id: None,
                action: "upsert".to_string(),
                server_name: (*name).to_string(),
                draft: Some(McpBindingDraft {
                    command: Some((*command).to_string()),
                    args: args.iter().map(|value| (*value).to_string()).collect(),
                    env_vars: Vec::new(),
                    ..stdio_draft(true)
                }),
                enabled: None,
            })
            .collect::<Vec<_>>();
        let http_url = "https://token-helper.example.test/mcp";
        let http_draft = McpBindingDraft {
            transport: "http".to_string(),
            command: None,
            args: Vec::new(),
            url: Some(http_url.to_string()),
            env_vars: Vec::new(),
            header_env: vec![McpHeaderEnvRef {
                header_name: "Authorization".to_string(),
                env_var_name: "MCP_AUTH_HEADER".to_string(),
            }],
            enabled: true,
            required: false,
        };
        for host_id in [HOST_CODEX, HOST_CLAUDE_CODE] {
            changes.push(McpBindingChange {
                host_id: host_id.to_string(),
                scope: "user".to_string(),
                workspace_id: None,
                action: "upsert".to_string(),
                server_name: format!("{host_id}-http"),
                draft: Some(http_draft.clone()),
                enabled: None,
            });
        }
        let plan = plan_mcp_changes(&context, request(changes)).unwrap();
        let stored: StoredPlan =
            read_protected_journal(&plan_path(&context, &plan.plan_id).unwrap()).unwrap();
        let journal = serde_json::to_string(&stored).unwrap();
        assert!(!journal.contains(http_url));
        assert!(!journal.contains("MCP_AUTH_HEADER"));
        apply_mcp_plan(&context, &plan.plan_id).unwrap();

        let codex_text = fs::read_to_string(context.home_dir.join(".codex/config.toml")).unwrap();
        let codex = codex_text.parse::<DocumentMut>().unwrap();
        let servers = codex["mcp_servers"].as_table().unwrap();
        for (name, command, args) in commands {
            let table = servers.get(name).and_then(Item::as_table).unwrap();
            assert_eq!(table["command"].as_str(), Some(command));
            let written_args = table["args"]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(TomlValue::as_str)
                .collect::<Vec<_>>();
            assert_eq!(written_args, args);
        }
        let codex_http = servers
            .get("host-codex-http")
            .and_then(Item::as_table)
            .unwrap();
        assert_eq!(codex_http["url"].as_str(), Some(http_url));
        assert!(codex_http.get("type").is_none());

        let claude: JsonValue = serde_json::from_str(
            &fs::read_to_string(context.home_dir.join(".claude.json")).unwrap(),
        )
        .unwrap();
        let claude_http = &claude["mcpServers"]["host-claude-code-http"];
        assert_eq!(claude_http["type"], "http");
        assert_eq!(claude_http["url"], http_url);
        assert_eq!(
            claude_http["headers"]["Authorization"],
            "${MCP_AUTH_HEADER}"
        );
        assert!(claude_http.get("disabled").is_none());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn rollback_snapshot_is_private_encrypted_discoverable_and_not_sibling_backed_up() {
        let (root, context) = fixture("private-snapshot");
        let path = context.home_dir.join(".codex/config.toml");
        let secret = "credential-that-must-not-be-written-beside-config";
        fs::write(
            &path,
            format!(
                "[mcp_servers.demo]\ncommand = \"old\"\nenv = {{ API_TOKEN = \"{secret}\" }}\n"
            ),
        )
        .unwrap();
        let plan = plan_mcp_changes(
            &context,
            request(vec![McpBindingChange {
                host_id: HOST_CODEX.to_string(),
                scope: "user".to_string(),
                workspace_id: None,
                action: "upsert".to_string(),
                server_name: "demo".to_string(),
                draft: Some(stdio_draft(true)),
                enabled: None,
            }]),
        )
        .unwrap();
        let applied = apply_mcp_plan(&context, &plan.plan_id).unwrap();

        let sibling_names = fs::read_dir(path.parent().unwrap())
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .collect::<Vec<_>>();
        assert!(!sibling_names
            .iter()
            .any(|name| name.contains("ai-skillhub-backup")));

        let manifest_path = snapshot_manifest_path(&context, &applied.snapshot_id).unwrap();
        let manifest: SnapshotManifest = read_protected_journal(&manifest_path).unwrap();
        #[cfg(windows)]
        assert!(!fs::read(&manifest_path)
            .unwrap()
            .windows(secret.len())
            .any(|window| window == secret.as_bytes()));
        let backup_name = manifest.targets[0].backup_file_name.as_deref().unwrap();
        let backup_path =
            snapshot_backup_path_by_name(&context, &applied.snapshot_id, backup_name).unwrap();
        assert!(backup_path.starts_with(&context.private_state_dir));
        #[cfg(windows)]
        assert!(!fs::read(&backup_path)
            .unwrap()
            .windows(secret.len())
            .any(|window| window == secret.as_bytes()));

        remove_cached_plan(&plan.plan_id);
        let discovered = list_mcp_rollback_snapshots(&context).unwrap();
        assert_eq!(discovered.len(), 1);
        assert_eq!(discovered[0].snapshot_id, applied.snapshot_id);
        rollback_mcp_snapshot(&context, &applied.snapshot_id).unwrap();
        assert!(!snapshot_dir_path(&context, &applied.snapshot_id)
            .unwrap()
            .exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn snapshot_listing_prunes_expired_and_oldest_entries() {
        let (root, context) = fixture("snapshot-pruning");
        ensure_private_directory(&snapshots_dir(&context)).unwrap();
        let now = now_unix_ms();
        for index in 0..(MAX_ROLLBACK_SNAPSHOTS + 2) {
            let snapshot_id = format!("mcp-snapshot-retention-{index:02}");
            let directory = snapshot_dir_path(&context, &snapshot_id).unwrap();
            fs::create_dir(&directory).unwrap();
            let manifest = SnapshotManifest {
                schema_version: PLAN_SCHEMA_VERSION,
                snapshot_id: snapshot_id.clone(),
                plan_id: format!("mcp-plan-retention-{index:02}"),
                created_at_unix_ms: now + index as u128,
                expires_at_unix_ms: now + SNAPSHOT_TTL_MS,
                state: "committed".to_string(),
                rolled_back: false,
                targets: Vec::new(),
                dismissed: false,
            };
            write_protected_journal(&directory.join("manifest.bin"), &manifest).unwrap();
        }
        let expired_id = "mcp-snapshot-expired";
        let expired_dir = snapshot_dir_path(&context, expired_id).unwrap();
        fs::create_dir(&expired_dir).unwrap();
        write_protected_journal(
            &expired_dir.join("manifest.bin"),
            &SnapshotManifest {
                schema_version: PLAN_SCHEMA_VERSION,
                snapshot_id: expired_id.to_string(),
                plan_id: "mcp-plan-expired".to_string(),
                created_at_unix_ms: now.saturating_sub(SNAPSHOT_TTL_MS + 2),
                expires_at_unix_ms: now.saturating_sub(1),
                state: "committed".to_string(),
                rolled_back: false,
                targets: Vec::new(),
                dismissed: false,
            },
        )
        .unwrap();

        let listed = list_mcp_rollback_snapshots(&context).unwrap();
        assert_eq!(listed.len(), MAX_ROLLBACK_SNAPSHOTS);
        assert!(!expired_dir.exists());
        assert_eq!(
            listed[0].snapshot_id,
            format!("mcp-snapshot-retention-{:02}", MAX_ROLLBACK_SNAPSHOTS + 1)
        );
        assert!(!snapshot_dir_path(&context, "mcp-snapshot-retention-00")
            .unwrap()
            .exists());
        assert!(!snapshot_dir_path(&context, "mcp-snapshot-retention-01")
            .unwrap()
            .exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn automatic_recovery_refuses_to_overwrite_external_toctou_change() {
        let (root, context) = fixture("recovery-toctou");
        let path = context.home_dir.join(".codex/config.toml");
        fs::write(&path, "# original\n").unwrap();
        let original = read_regular_config(&path, false).unwrap().unwrap();
        let final_bytes = b"# applied\n".to_vec();
        write_atomic(
            &path,
            &final_bytes,
            Some(&original),
            "mcp-snapshot-toctou",
            Some(&original.fingerprint),
        )
        .unwrap();
        let applied = read_regular_config(&path, false).unwrap().unwrap();
        let prepared = vec![PreparedWrite {
            target: ResolvedTarget {
                id: "target".to_string(),
                host_id: HOST_CODEX.to_string(),
                scope: "user".to_string(),
                workspace_id: None,
                workspace_path: None,
                path: path.clone(),
                path_display: "~/.codex/config.toml".to_string(),
            },
            path_binding_sha256: target_path_binding(&path).unwrap(),
            verification: WriteVerification::Legacy(Vec::new()),
            original: Some(original),
            final_bytes,
            backup_path: None,
            applied_fingerprint: Some(applied.fingerprint),
        }];
        fs::write(&path, "# external change\n").unwrap();
        let error = restore_batch_after_failure(&prepared, 1, "mcp-snapshot-toctou").unwrap_err();
        assert!(error.contains("外部修改"));
        assert_eq!(fs::read_to_string(&path).unwrap(), "# external change\n");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn final_atomic_recheck_preserves_last_moment_external_write() {
        let (root, context) = fixture("final-atomic-recheck");
        let path = context.home_dir.join(".codex/config.toml");
        fs::write(&path, "# original\n").unwrap();
        let original = read_regular_config(&path, false).unwrap().unwrap();
        let external = b"# external at final boundary\n".to_vec();
        install_atomic_replace_test_hook(path.clone(), external.clone());

        let error = write_atomic(
            &path,
            b"# planned\n",
            Some(&original),
            "mcp-snapshot-final-recheck",
            Some(&original.fingerprint),
        )
        .unwrap_err();

        assert!(error.contains("外部修改"));
        assert_eq!(fs::read(&path).unwrap(), external);
        assert!(
            !sibling_artifact_path(&path, "temp", "mcp-snapshot-final-recheck")
                .unwrap()
                .exists()
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn user_rollback_refuses_external_change_and_preserves_it() {
        let (root, context) = fixture("rollback-toctou");
        let path = context.home_dir.join(".codex/config.toml");
        fs::write(&path, "[mcp_servers.demo]\ncommand = \"old\"\n").unwrap();
        let plan = plan_mcp_changes(
            &context,
            request(vec![McpBindingChange {
                host_id: HOST_CODEX.to_string(),
                scope: "user".to_string(),
                workspace_id: None,
                action: "upsert".to_string(),
                server_name: "demo".to_string(),
                draft: Some(stdio_draft(true)),
                enabled: None,
            }]),
        )
        .unwrap();
        let applied = apply_mcp_plan(&context, &plan.plan_id).unwrap();
        fs::write(&path, "# external after apply\n").unwrap();
        let error = rollback_mcp_snapshot(&context, &applied.snapshot_id).unwrap_err();
        assert!(error.contains("发生变化"));
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "# external after apply\n"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn mutation_targets_offer_supported_scopes_without_creating_host_directories() {
        let (root, context) = fixture("target-options");
        fs::remove_dir_all(context.home_dir.join(".codex")).unwrap();
        fs::remove_dir_all(context.home_dir.join(".claude")).unwrap();
        fs::remove_dir_all(context.registered_workspaces[0].path.join(".codex")).unwrap();

        let options = list_mcp_mutation_targets(&context).unwrap();
        assert_eq!(options.len(), 1);
        assert_eq!(options[0].host_id, HOST_CLAUDE_CODE);
        assert_eq!(options[0].scope, "project");
        assert_eq!(options[0].workspace_id.as_deref(), Some("workspace-one"));
        assert!(!context.home_dir.join(".codex").exists());
        assert!(!context.home_dir.join(".claude").exists());
        assert!(!context.home_dir.join(".claude.json").exists());
        assert!(!context.registered_workspaces[0]
            .path
            .join(".codex")
            .exists());
        assert!(!context.registered_workspaces[0]
            .path
            .join(".mcp.json")
            .exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn plan_cache_pruning_enforces_ttl_entry_and_byte_limits() {
        let template = request(vec![McpBindingChange {
            host_id: HOST_CODEX.to_string(),
            scope: "user".to_string(),
            workspace_id: None,
            action: "upsert".to_string(),
            server_name: "demo".to_string(),
            draft: Some(stdio_draft(true)),
            enabled: None,
        }]);
        let now = now_unix_ms();
        let mut cache = HashMap::new();
        cache.insert(
            "expired".to_string(),
            CachedPlan {
                created_at_unix_ms: now.saturating_sub(PLAN_CACHE_TTL_MS + 1),
                byte_len: 1,
                cache_nonce: "expired".to_string(),
                request: template.clone(),
            },
        );
        for index in 0..=MAX_CACHED_PLANS {
            cache.insert(
                format!("plan-{index}"),
                CachedPlan {
                    created_at_unix_ms: now + index as u128,
                    byte_len: 1,
                    cache_nonce: format!("plan-{index}"),
                    request: template.clone(),
                },
            );
        }
        prune_plan_cache(&mut cache, now + MAX_CACHED_PLANS as u128);
        assert!(!cache.contains_key("expired"));
        assert!(cache.len() <= MAX_CACHED_PLANS);

        cache.clear();
        for index in 0..3 {
            cache.insert(
                format!("large-{index}"),
                CachedPlan {
                    created_at_unix_ms: now + index,
                    byte_len: MAX_PLAN_CACHE_BYTES / 2,
                    cache_nonce: format!("large-{index}"),
                    request: template.clone(),
                },
            );
        }
        prune_plan_cache(&mut cache, now + 3);
        assert!(cache.values().map(|plan| plan.byte_len).sum::<usize>() <= MAX_PLAN_CACHE_BYTES);
    }

    #[test]
    fn protected_plan_store_is_bounded_and_applied_plan_is_removed() {
        let (root, context) = fixture("plan-store");
        let change = McpBindingChange {
            host_id: HOST_CODEX.to_string(),
            scope: "user".to_string(),
            workspace_id: None,
            action: "upsert".to_string(),
            server_name: "demo".to_string(),
            draft: Some(stdio_draft(true)),
            enabled: None,
        };
        let mut latest = None;
        for _ in 0..(MAX_CACHED_PLANS + 6) {
            latest = Some(plan_mcp_changes(&context, request(vec![change.clone()])).unwrap());
        }
        let entries = fs::read_dir(plans_dir(&context))
            .unwrap()
            .filter_map(Result::ok)
            .collect::<Vec<_>>();
        assert!(entries.len() <= MAX_CACHED_PLANS);
        assert!(
            entries
                .iter()
                .map(|entry| entry.metadata().unwrap().len())
                .sum::<u64>()
                <= MAX_PLAN_CACHE_BYTES as u64
        );

        let latest = latest.unwrap();
        let latest_path = plan_path(&context, &latest.plan_id).unwrap();
        assert!(latest_path.exists());
        apply_mcp_plan(&context, &latest.plan_id).unwrap();
        assert!(!latest_path.exists());
        let _ = fs::remove_dir_all(root);
    }

    /// A path outside the home folder with non-ASCII characters (a redirected
    /// %APPDATA%, a CLAUDE_CONFIG_DIR or a runner under D:\工具) never panics,
    /// and only a real folder prefix is shown as `~`.
    #[test]
    fn home_redaction_never_panics_on_non_ascii_paths_outside_home() {
        let home = PathBuf::from(r"C:\Users\abcd");
        for path in [
            r"D:\用户数据\Claude\claude_desktop_config.json",
            r"C:\Users\用户\x.json",
            r"C:\Users\abcde\x.json",
        ] {
            let shown = redact_home_path(Path::new(path), &home);
            assert!(!shown.starts_with('~'), "{path} -> {shown}");
        }
        assert_eq!(
            redact_home_path(Path::new(r"C:\Users\ABCD\.cursor\mcp.json"), &home),
            "~/.cursor/mcp.json"
        );
        assert_eq!(redact_home_path(Path::new(r"C:\Users\abcd"), &home), "~");
        let chinese_home = PathBuf::from(r"C:\Users\张三");
        assert_eq!(
            redact_home_path(Path::new(r"C:\Users\张三\.claude.json"), &chinese_home),
            "~/.claude.json"
        );
    }
}
