//! One "update all sources" run, possibly spread over several bounded rounds.
//!
//! A single sync spends a fixed Git budget; sources it cannot reach are
//! deferred to the next round. This module merges every round of the same run
//! into one per-source result, so the interface can say exactly which sources
//! are updated, unchanged, pinned, blocked by local edits, failed or still
//! waiting, instead of treating a refreshed index as a finished update.

use crate::sparse_scope::{SparseScopeOutcome, SparseScopeReport};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

pub(crate) const UPDATE_RUN_FILE: &str = "update-run.json";
const ROUTER_FOLDER: &str = "AI-SkillHub-local-routers";

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct SourceRunEntry {
    pub folder: String,
    /// updated | unchanged | pinned | local-changes | failed | deferred | not-git
    pub outcome: String,
    pub detail: String,
    /// What the clone follows, for example `origin/main`; empty for snapshots.
    pub tracking: String,
    pub checked_at: String,
    pub added_skills: Vec<String>,
    pub removed_paths: Vec<String>,
    pub added_dependencies: Vec<String>,
    pub discovered_skills: Vec<String>,
    pub kept_local_paths: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct UpdateRun {
    pub schema_version: u32,
    pub run_id: String,
    pub started_at: String,
    pub updated_at: String,
    pub rounds: u32,
    pub sources: Vec<SourceRunEntry>,
}

impl UpdateRun {
    pub(crate) fn pending(&self) -> usize {
        self.sources
            .iter()
            .filter(|entry| entry.outcome == "deferred")
            .count()
    }

    #[cfg(test)]
    pub(crate) fn count(&self, outcome: &str) -> usize {
        self.sources
            .iter()
            .filter(|entry| entry.outcome == outcome)
            .count()
    }
}

fn text(value: &Value, keys: &[&str]) -> String {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(Value::as_str))
        .unwrap_or_default()
        .to_string()
}

/// A fast-forward prints `Updating <old>..<new>` (localized wording, but the
/// hash range itself is language independent). No range means no new commit.
pub(crate) fn pull_message_moved_head(message: &str) -> bool {
    message.split_whitespace().any(|token| {
        let token = token
            .trim_matches(|character: char| !character.is_ascii_alphanumeric() && character != '.');
        let Some((left, right)) = token.split_once("..") else {
            return false;
        };
        let hex = |part: &str| part.len() >= 7 && part.chars().all(|c| c.is_ascii_hexdigit());
        hex(left) && hex(right)
    })
}

fn outcome_for_log(action: &str, status: &str, message: &str) -> (&'static str, String) {
    let lower = message.to_ascii_lowercase();
    match (action, status) {
        ("pull", "ok") if pull_message_moved_head(message) => ("updated", String::new()),
        ("pull", "ok") => ("unchanged", String::new()),
        ("clone", "ok") => ("updated", String::new()),
        (_, "pinned") => ("pinned", String::new()),
        (_, "dirty-blocked") => ("local-changes", String::new()),
        (_, "skipped") if lower.contains("budget") || lower.contains("deferred") => {
            ("deferred", String::new())
        }
        (_, "skipped") if lower.contains("nopull") => ("deferred", String::new()),
        (_, "not-git") => ("not-git", String::new()),
        (_, "timeout") => ("failed", "连接 GitHub 超时。".to_string()),
        (_, "safety-check-failed") => (
            "failed",
            "无法确认本地文件状态，已跳过以免覆盖。".to_string(),
        ),
        (_, "governance-blocked") => ("failed", "版本固定清单不可读，已暂停网络更新。".to_string()),
        (_, "pinned-missing") => ("failed", "固定版本在本机缺失。".to_string()),
        _ => ("failed", compact(message)),
    }
}

fn compact(message: &str) -> String {
    message
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(240)
        .collect()
}

fn snapshot_outcome(status: &str, detail: &str) -> (&'static str, String) {
    match status {
        "ok" => ("updated", String::new()),
        "unchanged" => ("unchanged", String::new()),
        "pinned" => ("pinned", String::new()),
        "local-changes" => ("local-changes", String::new()),
        "deferred" => ("deferred", String::new()),
        _ => ("failed", compact(detail)),
    }
}

/// `origin/main` for a branch that tracks a remote branch, read from the
/// repository files so it costs no Git process inside the update budget.
pub(crate) fn tracked_branch(repo: &Path) -> String {
    let git_dir = repo.join(".git");
    let Ok(head) = fs::read_to_string(git_dir.join("HEAD")) else {
        return String::new();
    };
    let Some(branch) = head.trim().strip_prefix("ref: refs/heads/") else {
        let short = head.trim().chars().take(7).collect::<String>();
        return if short.is_empty() {
            String::new()
        } else {
            format!("detached@{short}")
        };
    };
    let config = fs::read_to_string(git_dir.join("config")).unwrap_or_default();
    let header = format!("[branch \"{branch}\"]");
    let mut in_section = false;
    let mut remote = String::new();
    let mut merge = String::new();
    for line in config.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            in_section = line == header;
            continue;
        }
        if !in_section {
            continue;
        }
        if let Some((key, value)) = line.split_once('=') {
            match key.trim() {
                "remote" => remote = value.trim().to_string(),
                "merge" => merge = value.trim().trim_start_matches("refs/heads/").to_string(),
                _ => {}
            }
        }
    }
    if remote.is_empty() || merge.is_empty() {
        branch.to_string()
    } else {
        format!("{remote}/{merge}")
    }
}

fn apply_scope(entry: &mut SourceRunEntry, scope: &SparseScopeOutcome) {
    entry.added_skills = scope.added_skills.clone();
    entry.removed_paths = scope.removed_paths.clone();
    entry.added_dependencies = scope.added_dependencies.clone();
    entry.discovered_skills = scope.discovered_skills.clone();
    entry.kept_local_paths = scope.kept_local_paths.clone();
    match scope.status.as_str() {
        "updated" | "full-checkout" => {
            // New Skills arrived even when HEAD did not move in this round
            // (for example a repair of an earlier incomplete pull).
            if matches!(entry.outcome.as_str(), "unchanged" | "pinned" | "") {
                entry.outcome = "updated".to_string();
            }
            if !scope.detail.is_empty() {
                entry.detail = scope.detail.clone();
            }
        }
        "deferred" => {
            entry.outcome = "deferred".to_string();
            entry.detail = scope.detail.clone();
        }
        "local-conflict" => {
            entry.outcome = "local-changes".to_string();
            entry.detail = format!("新增 Skill 未能落盘：{}", scope.detail);
        }
        "network-failed" | "failed" => {
            entry.outcome = "failed".to_string();
            entry.detail = format!("新增 Skill 未能落盘：{}", scope.detail);
        }
        _ => {}
    }
}

/// Builds this round's per-source results from the script log
/// (`last-sync.json`), the snapshot refresh report and the scope report.
pub(crate) fn round_entries(
    last_sync: Option<&Value>,
    snapshot_refresh: Option<&Value>,
    scope: Option<&SparseScopeReport>,
    sources_dir: &Path,
) -> Vec<SourceRunEntry> {
    let checked_at = last_sync
        .map(|payload| text(payload, &["generatedAt"]))
        .unwrap_or_default();
    let mut entries = BTreeMap::<String, SourceRunEntry>::new();
    let snapshots = snapshot_refresh
        .and_then(|payload| payload.get("sources"))
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(|item| (text(item, &["folder"]), item.clone()))
                .collect::<BTreeMap<_, _>>()
        })
        .unwrap_or_default();

    for item in last_sync
        .and_then(|payload| payload.get("repositories"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let folder = text(item, &["Repository", "repository"]);
        if folder.is_empty() || folder.starts_with("__") || folder == ROUTER_FOLDER {
            continue;
        }
        let action = text(item, &["Action", "action"]);
        let status = text(item, &["Status", "status"]);
        let message = text(item, &["Message", "message"]);
        let (outcome, detail) = if action == "snapshot-refresh" {
            match snapshots.get(&folder) {
                Some(snapshot) => {
                    snapshot_outcome(&text(snapshot, &["status"]), &text(snapshot, &["detail"]))
                }
                None => outcome_for_log(&action, &status, &message),
            }
        } else {
            outcome_for_log(&action, &status, &message)
        };
        entries.insert(
            folder.clone(),
            SourceRunEntry {
                tracking: tracked_branch(&sources_dir.join(&folder)),
                folder,
                outcome: outcome.to_string(),
                detail,
                checked_at: checked_at.clone(),
                ..SourceRunEntry::default()
            },
        );
    }

    for scope in scope
        .map(|report| report.sources.as_slice())
        .unwrap_or_default()
    {
        let entry = entries
            .entry(scope.folder.clone())
            .or_insert_with(|| SourceRunEntry {
                folder: scope.folder.clone(),
                outcome: "unchanged".to_string(),
                tracking: tracked_branch(&sources_dir.join(&scope.folder)),
                checked_at: checked_at.clone(),
                ..SourceRunEntry::default()
            });
        apply_scope(entry, scope);
    }
    entries.into_values().collect()
}

/// Folds one round into the run. A new run starts unless the caller asked
/// to continue and the stored run still has waiting sources. A source that
/// was already finished in this run keeps its result when a later round only
/// deferred it again (the rotation re-checks finished sources last).
pub(crate) fn merge_round(
    previous: Option<UpdateRun>,
    round: Vec<SourceRunEntry>,
    continue_run: bool,
    now: &str,
    run_id: impl FnOnce() -> String,
) -> UpdateRun {
    let mut run = match previous {
        Some(run) if continue_run && run.pending() > 0 => run,
        _ => UpdateRun {
            schema_version: 1,
            run_id: run_id(),
            started_at: now.to_string(),
            ..UpdateRun::default()
        },
    };
    run.rounds += 1;
    run.updated_at = now.to_string();
    let mut by_folder = run
        .sources
        .drain(..)
        .map(|entry| (entry.folder.to_lowercase(), entry))
        .collect::<BTreeMap<_, _>>();
    for entry in round {
        let key = entry.folder.to_lowercase();
        let keep_previous = entry.outcome == "deferred"
            && by_folder
                .get(&key)
                .is_some_and(|previous| previous.outcome != "deferred");
        if !keep_previous {
            // An earlier round may already have recorded new Skills; a later
            // unchanged pull must not erase that evidence from the same run.
            let merged = match by_folder.remove(&key) {
                Some(previous) if entry.outcome == "unchanged" && previous.outcome == "updated" => {
                    SourceRunEntry {
                        checked_at: entry.checked_at,
                        ..previous
                    }
                }
                _ => entry,
            };
            by_folder.insert(key, merged);
        }
    }
    // Keyed by the lowercase folder, so this is already in display order.
    run.sources = by_folder.into_values().collect();
    run
}

pub(crate) fn read_run(state_dir: &Path) -> Option<UpdateRun> {
    let raw = fs::read_to_string(state_dir.join(UPDATE_RUN_FILE)).ok()?;
    serde_json::from_str(raw.trim_start_matches('\u{feff}')).ok()
}

pub(crate) fn write_run(state_dir: &Path, run: &UpdateRun) -> Result<(), String> {
    fs::create_dir_all(state_dir).map_err(|error| format!("无法创建同步状态目录：{error}"))?;
    let text = serde_json::to_string_pretty(run)
        .map_err(|error| format!("无法序列化来源更新进度：{error}"))?;
    let path = state_dir.join(UPDATE_RUN_FILE);
    let temporary = state_dir.join(format!("{UPDATE_RUN_FILE}.tmp"));
    fs::write(&temporary, text).map_err(|error| format!("无法写入来源更新进度：{error}"))?;
    fs::rename(&temporary, &path).map_err(|error| format!("无法保存来源更新进度：{error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn log(repository: &str, action: &str, status: &str, message: &str) -> Value {
        serde_json::json!({ "Repository": repository, "Action": action, "Status": status, "Message": message })
    }

    #[test]
    fn fast_forward_ranges_are_detected_in_any_locale() {
        assert!(pull_message_moved_head(
            "Updating dd23dc2..7a8b9a7\nFast-forward"
        ));
        assert!(pull_message_moved_head("更新 dd23dc2..7a8b9a7 快进"));
        assert!(!pull_message_moved_head("Already up to date."));
        assert!(!pull_message_moved_head("已经是最新的。"));
        assert!(!pull_message_moved_head("see ../shared or v1.2..v1.3"));
    }

    #[test]
    fn round_entries_classify_every_script_status() {
        let last_sync = serde_json::json!({
            "generatedAt": "2026-10-01T08:00:00Z",
            "repositories": [
                log("moved", "pull", "ok", "Updating 1111111..2222222 Fast-forward"),
                log("same", "pull", "ok", "Already up to date."),
                log("fixed", "pull", "pinned", "Pinned revision"),
                log("edited", "pull", "dirty-blocked", "Local modified"),
                log("waiting", "pull", "skipped", "Git update budget exhausted; deferred by the persistent rotation."),
                log("broken", "pull", "timeout", "Timed out"),
                log("zip", "snapshot-refresh", "ok", ""),
                log("manual", "reinstall", "not-git", ""),
                log("__rotation__", "cursor-read", "failed", "")
            ]
        });
        let snapshots = serde_json::json!({ "sources": [ { "folder": "zip", "status": "unchanged", "detail": "" } ] });
        let entries = round_entries(
            Some(&last_sync),
            Some(&snapshots),
            None,
            Path::new("Z:/none"),
        );
        let outcome = |folder: &str| {
            entries
                .iter()
                .find(|entry| entry.folder == folder)
                .map(|entry| entry.outcome.as_str())
                .unwrap_or("missing")
                .to_string()
        };
        assert_eq!(outcome("moved"), "updated");
        assert_eq!(outcome("same"), "unchanged");
        assert_eq!(outcome("fixed"), "pinned");
        assert_eq!(outcome("edited"), "local-changes");
        assert_eq!(outcome("waiting"), "deferred");
        assert_eq!(outcome("broken"), "failed");
        assert_eq!(outcome("zip"), "unchanged");
        assert_eq!(outcome("manual"), "not-git");
        assert_eq!(outcome("__rotation__"), "missing");
        assert!(entries
            .iter()
            .all(|entry| entry.checked_at == "2026-10-01T08:00:00Z"));
    }

    #[test]
    fn scope_results_override_a_clean_pull_that_missed_new_skills() {
        let last_sync = serde_json::json!({
            "generatedAt": "t",
            "repositories": [
                log("repaired", "pull", "ok", "Already up to date."),
                log("offline", "pull", "ok", "Updating 1111111..2222222"),
            ]
        });
        let repaired = SparseScopeOutcome {
            folder: "repaired".to_string(),
            status: "updated".to_string(),
            added_skills: vec!["skills/new".to_string()],
            ..SparseScopeOutcome::default()
        };
        let offline = SparseScopeOutcome {
            folder: "offline".to_string(),
            status: "network-failed".to_string(),
            detail: "Could not resolve host".to_string(),
            ..SparseScopeOutcome::default()
        };
        let scope = SparseScopeReport {
            schema_version: 1,
            generated_at: "t".to_string(),
            sources: vec![repaired, offline],
        };
        let entries = round_entries(Some(&last_sync), None, Some(&scope), Path::new("Z:/none"));
        assert_eq!(entries[0].folder, "offline");
        assert_eq!(
            entries[0].outcome, "failed",
            "HEAD moved but new Skills are missing"
        );
        assert!(entries[0].detail.contains("Could not resolve host"));
        assert_eq!(entries[1].outcome, "updated");
        assert_eq!(entries[1].added_skills, vec!["skills/new".to_string()]);
    }

    fn entry(folder: &str, outcome: &str) -> SourceRunEntry {
        SourceRunEntry {
            folder: folder.to_string(),
            outcome: outcome.to_string(),
            ..SourceRunEntry::default()
        }
    }

    #[test]
    fn continued_rounds_finish_waiting_sources_without_losing_results() {
        let first = merge_round(
            None,
            vec![
                entry("a", "updated"),
                entry("b", "deferred"),
                entry("c", "deferred"),
            ],
            false,
            "t1",
            || "run-1".to_string(),
        );
        assert_eq!(first.pending(), 2);
        assert_eq!(first.rounds, 1);

        // Round two reaches b and c first; a is deferred by the rotation.
        let second = merge_round(
            Some(first),
            vec![
                entry("a", "deferred"),
                entry("b", "unchanged"),
                entry("c", "failed"),
            ],
            true,
            "t2",
            || "unused".to_string(),
        );
        assert_eq!(second.run_id, "run-1");
        assert_eq!(second.rounds, 2);
        assert_eq!(second.pending(), 0);
        assert_eq!(second.count("updated"), 1, "finished result must survive");
        assert_eq!(second.count("failed"), 1);
        assert_eq!(second.started_at, "t1");

        // A finished run is never silently continued: a new click starts over.
        let third = merge_round(
            Some(second),
            vec![entry("a", "unchanged")],
            true,
            "t3",
            || "run-2".to_string(),
        );
        assert_eq!(third.run_id, "run-2");
        assert_eq!(third.rounds, 1);
    }

    #[test]
    fn tracked_branch_reads_head_and_branch_config() {
        let root = std::env::temp_dir().join(format!(
            "skillhub-tracked-branch-{}",
            crate::unix_timestamp_string()
        ));
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::write(root.join(".git/HEAD"), "ref: refs/heads/dev\n").unwrap();
        fs::write(
            root.join(".git/config"),
            "[core]\n\tbare = false\n[branch \"main\"]\n\tremote = origin\n\tmerge = refs/heads/main\n[branch \"dev\"]\n\tremote = upstream\n\tmerge = refs/heads/develop\n",
        )
        .unwrap();
        assert_eq!(tracked_branch(&root), "upstream/develop");
        fs::write(root.join(".git/HEAD"), "0123456789abcdef\n").unwrap();
        assert_eq!(tracked_branch(&root), "detached@0123456");
        let _ = fs::remove_dir_all(root);
    }
}
