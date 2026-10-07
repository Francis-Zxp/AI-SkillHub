//! v3.3 structured error model (skills contract §4.5).
//!
//! New commands return `SkillHubError`; legacy `String` errors are classified
//! with the same pattern table the frontend uses. Messages are plain Chinese,
//! `detail` is a short redacted technical summary, never a stack trace or a
//! credential.

use serde::Serialize;
use std::collections::BTreeMap;

pub(crate) const DETAIL_LIMIT: usize = 400;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ErrorAction {
    pub kind: String,
    pub payload: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SkillHubError {
    pub code: String,
    pub message: String,
    pub detail: String,
    pub action: Option<ErrorAction>,
    pub agent_id: Option<String>,
    pub source_id: Option<String>,
    pub path: Option<String>,
}

impl std::fmt::Display for SkillHubError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.detail.is_empty() {
            write!(formatter, "{}", self.message)
        } else {
            write!(formatter, "{}（{}）", self.message, self.detail)
        }
    }
}

impl SkillHubError {
    pub(crate) fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
            detail: String::new(),
            action: default_action(code).map(|kind| ErrorAction {
                kind: kind.to_string(),
                payload: BTreeMap::new(),
            }),
            agent_id: None,
            source_id: None,
            path: None,
        }
    }

    /// Plain default message for a code; the UI prefers its own `err.<CODE>` text.
    pub(crate) fn code(code: &str) -> Self {
        Self::new(code, default_message(code))
    }

    pub(crate) fn with_detail(mut self, detail: impl AsRef<str>) -> Self {
        self.detail = redact(detail.as_ref());
        self
    }

    pub(crate) fn with_agent(mut self, agent_id: &str) -> Self {
        self.agent_id = Some(agent_id.to_string());
        self
    }

    pub(crate) fn with_source(mut self, source_id: &str) -> Self {
        self.source_id = Some(source_id.to_string());
        self
    }

    pub(crate) fn with_path(mut self, path: impl Into<String>) -> Self {
        self.path = Some(path.into());
        self
    }

    pub(crate) fn with_action(mut self, kind: &str, payload: &[(&str, &str)]) -> Self {
        self.action = Some(ErrorAction {
            kind: kind.to_string(),
            payload: payload
                .iter()
                .map(|(key, value)| (key.to_string(), value.to_string()))
                .collect(),
        });
        self
    }

    pub(crate) fn without_action(mut self) -> Self {
        self.action = None;
        self
    }
}

impl From<String> for SkillHubError {
    fn from(message: String) -> Self {
        classify_legacy_error(&message)
    }
}

impl From<&str> for SkillHubError {
    fn from(message: &str) -> Self {
        classify_legacy_error(message)
    }
}

/// The §4.5 pattern table, shared with `normalizeSkillHubError` in the UI.
const LEGACY_PATTERNS: &[(&[&str], &str)] = &[
    (
        &["另一项刷新或写入任务正在运行", "无法取得数据写入锁"],
        "WRITE_BUSY",
    ),
    (&["GitHub API", "rate limit"], "NETWORK_FAILED"),
    (&["超过 240 秒", "超过 180 秒"], "SCRIPT_TIMEOUT"),
    (&["超过 120 秒"], "DOWNLOAD_TIMEOUT"),
    (&["Source metadata is too long"], "INPUT_TOO_LONG"),
    (
        &[
            "Personal or external Skill entry preserved",
            "Personal Skill",
        ],
        "TARGET_CONFLICT",
    ),
    (
        &["Recipient Skills root is an external link"],
        "AGENT_DIR_EXTERNAL_LINK",
    ),
    (
        &["完整性核对未通过", "交付验收失败"],
        "DELIVERY_VERIFY_FAILED",
    ),
    (
        &["找不到同步脚本", "找不到 AI 工具链接脚本"],
        "SCRIPT_MISSING",
    ),
    (
        &["Cannot open v2 SQLite database", "Cannot commit v2 SQLite"],
        "INDEX_FAILED",
    ),
    (&["导入已取消"], "CANCELLED"),
    (
        &["Agent Skill allowlist contains"],
        "DELIVERY_POLICY_INVALID",
    ),
    (
        &["name and description", "没有可读的 SKILL.md"],
        "MANIFEST_INVALID",
    ),
];

/// Classify a legacy string error. The original text becomes the redacted
/// `detail`; the message is the plain default for the code.
pub(crate) fn classify_legacy_error(message: &str) -> SkillHubError {
    let code = LEGACY_PATTERNS
        .iter()
        .find(|(needles, _)| needles.iter().any(|needle| message.contains(needle)))
        .map(|(_, code)| *code)
        .or_else(|| git_missing(message).then_some("GIT_MISSING"))
        .unwrap_or("INTERNAL");
    let mut error = SkillHubError::code(code).with_detail(message);
    if code == "INTERNAL" && !message.trim().is_empty() {
        // Keep the backend's own plain sentence when it already is one.
        let first = message.lines().next().unwrap_or_default().trim();
        if first
            .chars()
            .any(|c| ('\u{4e00}'..='\u{9fff}').contains(&c))
        {
            error.message = redact(first);
        }
    }
    error
}

fn git_missing(message: &str) -> bool {
    message.contains("系统 Git")
        || (message.to_ascii_lowercase().contains("git")
            && (message.contains("not found")
                || message.contains("找不到")
                || message.contains("未安装")))
}

pub(crate) fn default_action(code: &str) -> Option<&'static str> {
    Some(match code {
        "WRITE_BUSY" => "wait",
        "NETWORK_FAILED" | "DOWNLOAD_TIMEOUT" | "DELIVERY_VERIFY_FAILED" => "retry",
        "SCRIPT_TIMEOUT"
        | "INDEX_FAILED"
        | "DELIVERY_POLICY_INVALID"
        | "INTERNAL"
        | "SCRIPT_FAILED" => "export-report",
        "TARGET_CONFLICT" => "resolve-conflict",
        "AGENT_DIR_EXTERNAL_LINK" | "MANIFEST_INVALID" | "AGENT_DIR_NOT_WRITABLE" => "open-folder",
        "SCRIPT_MISSING" => "reinstall",
        "GIT_MISSING" => "install-git",
        "AGENT_NOT_TAKEN_OVER" => "takeover-agent",
        "SECURITY_REVIEW_REQUIRED" => "review-security",
        "INPUT_IS_MCP_CONFIG" => "open-mcp-add",
        "DUPLICATE_SOURCE" => "open-existing",
        "PROBE_EXPIRED" | "PROBE_STALE" => "retry",
        "DELIVERY_PAUSED" => "open-settings",
        _ => return None,
    })
}

pub(crate) fn default_message(code: &str) -> &'static str {
    match code {
        "WRITE_BUSY" => "另一项任务正在进行，请稍等片刻再试。",
        "DELIVERY_PAUSED" => "已暂停同步到 AI 工具。恢复同步后会继续。",
        "ONBOARDING_REQUIRED" => "请先完成首次设置，选择要接管的 AI 工具。",
        "AGENT_UNKNOWN" => "不认识这个 AI 工具。",
        "AGENT_UNSUPPORTED" => "这个 AI 工具还不支持同步技能。",
        "AGENT_NOT_INSTALLED" => "这台电脑上没找到这个 AI 工具。",
        "AGENT_NOT_TAKEN_OVER" => "请先接管这个 AI 工具。",
        "AGENT_DIR_EXTERNAL_LINK" => "这个 AI 工具的技能文件夹指向了别处，SkillHub 没有改动它。",
        "AGENT_DIR_NOT_WRITABLE" => "无法写入这个 AI 工具的技能文件夹。",
        "TARGET_CONFLICT" => "AI 工具里已有同名的个人技能，SkillHub 没有覆盖它。",
        "MANIFEST_INVALID" => "这个技能的 SKILL.md 缺少名称或简介。",
        "DELIVERY_VERIFY_FAILED" => "同步后核对没有通过，请重试。",
        "DELIVERY_POLICY_INVALID" => "同步清单异常，已停止，没有改动任何 AI 工具。",
        "SCRIPT_FAILED" => "同步脚本没有完成。",
        "SCRIPT_TIMEOUT" => "同步用时太久，已自动停止。",
        "SCRIPT_MISSING" => "缺少 SkillHub 的同步脚本，请重新安装。",
        "UNIT_NOT_FOUND" => "找不到这个技能包，请刷新后再试。",
        "SOURCE_LIBRARY_ONLY" => "这个技能包只在技能库里，当前是停用状态。",
        "SECURITY_REVIEW_REQUIRED" => "这个技能包需要你先查看风险并确认。",
        "SECURITY_BLOCKED" => "这个来源没有通过安全检查，无法添加。",
        "INPUT_EMPTY" => "请粘贴 GitHub 地址、本地文件夹或 .zip。",
        "INPUT_UNRECOGNIZED" => "暂时只支持 GitHub 地址、本地文件夹和 .zip。",
        "INPUT_IS_MCP_CONFIG" => "这是一段 MCP 配置，请到 MCP 页面添加。",
        "INPUT_TOO_LONG" => "输入内容太长了。",
        "PATH_NOT_FOUND" => "找不到这个路径。",
        "PATH_NOT_ABSOLUTE" => "请粘贴完整路径，或点「选择文件夹」。",
        "ZIP_INVALID" => "这个压缩包无法读取。",
        "GITHUB_NOT_FOUND" => "GitHub 上找不到这个仓库。",
        "GITHUB_RENAMED" => "这个 GitHub 仓库已改名或转移。",
        "GITHUB_REF_NOT_FOUND" => "找不到这个分支或版本。",
        "GITHUB_SUBPATH_NOT_FOUND" => "仓库里找不到这个文件夹。",
        "NETWORK_FAILED" => "网络连接失败，请稍后重试。",
        "DOWNLOAD_TIMEOUT" => "下载用时太久，已停止。",
        "GIT_MISSING" => "这台电脑没有可用的 Git，备用下载也没有成功。",
        "NO_SKILLS_FOUND" => "这里没有找到技能（SKILL.md）。",
        "PROBE_EXPIRED" => "这次检查已过期，请重新检查。",
        "PROBE_STALE" => "来源内容已变化，请重新检查。",
        "DUPLICATE_SOURCE" => "这个技能包已经在技能库里了。",
        "CANCELLED" => "已取消。",
        "INDEX_FAILED" => "本地技能库索引出错了。",
        _ => "出了点问题，请生成排错报告查看详情。",
    }
}

/// Strip anything that looks like a credential and cap the length. Paths stay:
/// they belong to the user's own machine (I-10).
pub(crate) fn redact(text: &str) -> String {
    let mut output = String::with_capacity(text.len().min(DETAIL_LIMIT * 4));
    for (index, line) in text.lines().enumerate() {
        if index > 0 {
            output.push(' ');
        }
        output.push_str(&redact_line(line.trim()));
    }
    let output = output.trim().to_string();
    if output.chars().count() > DETAIL_LIMIT {
        let mut truncated = output.chars().take(DETAIL_LIMIT - 1).collect::<String>();
        truncated.push('…');
        truncated
    } else {
        output
    }
}

fn redact_line(line: &str) -> String {
    let mut words = Vec::new();
    let mut hide_next = false;
    for word in line.split(' ') {
        let lower = word.to_ascii_lowercase();
        if lower.ends_with("authorization:") {
            // Everything after an Authorization header is a credential.
            words.push(word.to_string());
            words.push("[已隐藏]".to_string());
            break;
        }
        if hide_next {
            words.push("[已隐藏]".to_string());
            hide_next = false;
            continue;
        }
        if lower == "bearer" || lower == "token" || lower == "basic" {
            words.push(word.to_string());
            hide_next = true;
            continue;
        }
        words.push(redact_word(word));
    }
    words.join(" ")
}

fn redact_word(word: &str) -> String {
    let lower = word.to_ascii_lowercase();
    // key=value pairs whose key names a secret.
    for marker in [
        "token=",
        "password=",
        "passwd=",
        "secret=",
        "api_key=",
        "apikey=",
        "access_key=",
        "authorization=",
        "auth=",
        "key=",
    ] {
        if let Some(position) = lower.find(marker) {
            return format!("{}[已隐藏]", &word[..position + marker.len()]);
        }
    }
    // https://user:secret@host
    if let Some(scheme_end) = word.find("://") {
        let rest = &word[scheme_end + 3..];
        if let Some(at) = rest.find('@') {
            if rest[..at].contains(':') || rest[..at].len() > 20 {
                return format!("{}[已隐藏]@{}", &word[..scheme_end + 3], &rest[at + 1..]);
            }
        }
    }
    // Well-known token prefixes.
    let trimmed = word.trim_matches(|c: char| !c.is_ascii_alphanumeric() && c != '_' && c != '-');
    for prefix in [
        "ghp_",
        "gho_",
        "ghu_",
        "ghs_",
        "github_pat_",
        "sk-",
        "xoxb-",
        "xoxp-",
        "AKIA",
    ] {
        if trimmed.starts_with(prefix) && trimmed.len() >= prefix.len() + 12 {
            return word.replace(trimmed, "[已隐藏]");
        }
    }
    word.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_classifier_table() {
        let cases = [
            (
                "另一项刷新或写入任务正在运行；请等待",
                "WRITE_BUSY",
                Some("wait"),
            ),
            ("无法取得数据写入锁，其他窗口", "WRITE_BUSY", Some("wait")),
            (
                "GitHub API 403 for owner/repo",
                "NETWORK_FAILED",
                Some("retry"),
            ),
            ("hit the rate limit", "NETWORK_FAILED", Some("retry")),
            (
                "SkillHub 同步超过 240 秒，已自动停止。",
                "SCRIPT_TIMEOUT",
                Some("export-report"),
            ),
            (
                "AI 工具链接同步超过 180 秒",
                "SCRIPT_TIMEOUT",
                Some("export-report"),
            ),
            ("下载超过 120 秒", "DOWNLOAD_TIMEOUT", Some("retry")),
            ("Source metadata is too long", "INPUT_TOO_LONG", None),
            (
                "Personal Skill with the same name preserved: x",
                "TARGET_CONFLICT",
                Some("resolve-conflict"),
            ),
            (
                "Personal or external Skill entry preserved: y",
                "TARGET_CONFLICT",
                Some("resolve-conflict"),
            ),
            (
                "Recipient Skills root is an external link and was preserved",
                "AGENT_DIR_EXTERNAL_LINK",
                Some("open-folder"),
            ),
            (
                "交付后的完整性核对未通过",
                "DELIVERY_VERIFY_FAILED",
                Some("retry"),
            ),
            (
                "Agent Skill 交付验收失败；",
                "DELIVERY_VERIFY_FAILED",
                Some("retry"),
            ),
            ("找不到同步脚本：C:\\x", "SCRIPT_MISSING", Some("reinstall")),
            (
                "找不到 AI 工具链接脚本：C:\\x",
                "SCRIPT_MISSING",
                Some("reinstall"),
            ),
            (
                "Cannot open v2 SQLite database x",
                "INDEX_FAILED",
                Some("export-report"),
            ),
            (
                "Cannot commit v2 SQLite transaction",
                "INDEX_FAILED",
                Some("export-report"),
            ),
            ("导入已取消；本次未完成", "CANCELLED", None),
            (
                "Agent Skill allowlist contains 3 entries",
                "DELIVERY_POLICY_INVALID",
                Some("export-report"),
            ),
            (
                "SKILL.md needs non-empty name and description",
                "MANIFEST_INVALID",
                Some("open-folder"),
            ),
            (
                "入口没有可读的 SKILL.md：a",
                "MANIFEST_INVALID",
                Some("open-folder"),
            ),
            ("系统 Git 不可用", "GIT_MISSING", Some("install-git")),
            (
                "git executable not found",
                "GIT_MISSING",
                Some("install-git"),
            ),
            ("something unexpected", "INTERNAL", Some("export-report")),
        ];
        for (message, code, action) in cases {
            let error = SkillHubError::from(message.to_string());
            assert_eq!(error.code, code, "{message}");
            assert_eq!(
                error.action.as_ref().map(|a| a.kind.as_str()),
                action,
                "{message}"
            );
            assert!(!error.message.is_empty());
            assert!(error.detail.chars().count() <= DETAIL_LIMIT);
        }
    }

    #[test]
    fn redaction_hides_credentials_and_caps_length() {
        let text = "fatal: https://user:ghp_abcdefghijklmnopqrstuvwxyz0123@github.com/o/r token=abc123 Authorization: Bearer xyz";
        let redacted = redact(text);
        assert!(!redacted.contains("ghp_abcdefghijklmnopqrstuvwxyz0123"));
        assert!(!redacted.contains("abc123"));
        assert!(!redacted.contains("xyz"));
        assert!(redacted.contains("github.com/o/r"));
        let long = "路".repeat(1000);
        assert_eq!(redact(&long).chars().count(), DETAIL_LIMIT);
        assert!(
            !redact("github_pat_11ABCDEFGHIJKLMNOPQRST_secret").contains("github_pat_11ABCDEFGH")
        );
    }

    #[test]
    fn serialization_matches_the_ts_contract() {
        let error = SkillHubError::code("TARGET_CONFLICT").with_agent("claude");
        let value = serde_json::to_value(&error).unwrap();
        for key in [
            "code", "message", "detail", "action", "agentId", "sourceId", "path",
        ] {
            assert!(value.get(key).is_some(), "{key}");
        }
        assert!(value["sourceId"].is_null());
        assert_eq!(value["action"]["kind"], "resolve-conflict");
        assert!(value["action"]["payload"].is_object());
    }
}
