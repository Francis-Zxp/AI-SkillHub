//! Read-only adapter diagnosis.
//!
//! This module deliberately does not probe the operating system itself. Callers collect
//! command/app/package/path evidence and pass it to [`diagnose_adapter`]. Keeping the
//! decision engine pure makes it testable and prevents a diagnostics action from
//! creating a fake Skills directory or mutating another application's installation.

use serde::Serialize;

pub(crate) const VERDICT_READY: &str = "ready";
pub(crate) const VERDICT_CODE_DETECTED: &str = "code-detected";
pub(crate) const VERDICT_DESKTOP_ONLY: &str = "desktop-only";
pub(crate) const VERDICT_PATH_REFRESH_NEEDED: &str = "path-refresh-needed";
pub(crate) const VERDICT_DIRECTORY_RESIDUE: &str = "directory-residue";
pub(crate) const VERDICT_NOT_DETECTED: &str = "not-detected";

#[derive(Clone, Debug, Default)]
pub(crate) struct AdapterDoctorInput {
    pub adapter_id: String,
    pub adapter_name: String,
    pub detection_kind: String,
    pub path_hint: String,
    /// Optional profile directory used only for output redaction.
    pub home_dir: String,
    pub redact_paths: bool,
    pub commands: Vec<CommandProbeEvidence>,
    pub apps: Vec<AppProbeEvidence>,
    pub packages: Vec<PackageProbeEvidence>,
    pub paths: Vec<PathProbeEvidence>,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct CommandProbeEvidence {
    pub command: String,
    pub found_on_path: bool,
    pub resolved_path: String,
    pub version: String,
    pub detail: String,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct AppProbeEvidence {
    pub product_id: String,
    pub display_name: String,
    /// `desktop-app`, `code-app`, or `unknown`.
    pub role: String,
    pub installed: bool,
    pub running: bool,
    pub executable_path: String,
    /// For example `process`, `appx`, `uninstall-registry`, or `known-path`.
    pub evidence_source: String,
    pub detail: String,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct PackageProbeEvidence {
    pub package_id: String,
    pub display_name: String,
    /// `desktop-app`, `code-cli`, `code-app`, or `unknown`.
    pub role: String,
    pub installed: bool,
    pub provides_cli: bool,
    pub version: String,
    pub install_path: String,
    pub detail: String,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct PathProbeEvidence {
    pub path: String,
    /// `skills-directory`, `cli-executable`, `desktop-executable`,
    /// `package-root`, or another caller-defined value.
    pub purpose: String,
    pub exists: bool,
    pub is_directory: bool,
    pub writable: bool,
    pub is_link: bool,
    pub contains_skill_md: bool,
    pub detail: String,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentDoctorCard {
    pub adapter_id: String,
    pub adapter_name: String,
    pub detection_kind: String,
    pub path_hint: String,
    pub verdict: String,
    pub summary: String,
    pub desktop_status: String,
    pub cli_status: String,
    pub skills_status: String,
    pub evidence: Vec<AgentDoctorEvidenceCard>,
    pub checked_paths: Vec<String>,
    pub next_steps: Vec<String>,
    /// True only when the recommended recovery is non-destructive and can be
    /// offered without fabricating an installation (currently a PATH refresh).
    pub safe_fix_available: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AgentDoctorEvidenceCard {
    pub probe_kind: String,
    pub label: String,
    pub status: String,
    pub detail: String,
    pub path: String,
}

pub(crate) fn diagnose_adapter(input: &AdapterDoctorInput) -> AgentDoctorCard {
    let adapter_id = input.adapter_id.trim().to_ascii_lowercase();
    let is_split_product = matches!(adapter_id.as_str(), "codex" | "claude");

    let desktop_running = input
        .apps
        .iter()
        .any(|probe| is_desktop_app(&adapter_id, probe) && probe.running);
    let desktop_installed = desktop_running
        || input
            .apps
            .iter()
            .any(|probe| is_desktop_app(&adapter_id, probe) && probe.installed)
        || input
            .packages
            .iter()
            .any(|probe| is_desktop_package(&adapter_id, probe) && probe.installed);

    let cli_on_path = input.commands.iter().any(|probe| probe.found_on_path);
    let cli_executable_exists = input
        .paths
        .iter()
        .any(|probe| probe.exists && probe.purpose.eq_ignore_ascii_case("cli-executable"));
    let cli_package_installed = input
        .packages
        .iter()
        .any(|probe| probe.installed && (probe.provides_cli || is_code_package(probe)));
    let code_app_installed = input
        .apps
        .iter()
        .any(|probe| probe.installed && is_code_app(probe));
    let code_installed =
        cli_on_path || cli_executable_exists || cli_package_installed || code_app_installed;

    let skills_paths: Vec<&PathProbeEvidence> = input
        .paths
        .iter()
        .filter(|probe| probe.purpose.eq_ignore_ascii_case("skills-directory"))
        .collect();
    let skills_directory_exists = skills_paths.iter().any(|probe| probe.exists);
    let skills_directory_usable = skills_paths
        .iter()
        .any(|probe| probe.exists && probe.is_directory);
    let path_refresh_needed =
        !cli_on_path && (cli_executable_exists || cli_package_installed) && code_installed;

    let (verdict, summary, safe_fix_available) = if path_refresh_needed {
        (
            VERDICT_PATH_REFRESH_NEEDED,
            path_refresh_summary(&adapter_id),
            true,
        )
    } else if cli_on_path && skills_directory_usable {
        (
            VERDICT_READY,
            format!(
                "{} 的代码能力与 Skills 目录均已确认，可进入接管前检查。",
                display_name(input)
            ),
            false,
        )
    } else if code_installed {
        (
            VERDICT_CODE_DETECTED,
            format!(
                "{} 的代码能力已确认，但 Skills 目录尚未验证；不会为通过检测而创建空目录。",
                display_name(input)
            ),
            false,
        )
    } else if desktop_installed && is_split_product {
        (
            VERDICT_DESKTOP_ONLY,
            desktop_only_summary(&adapter_id, desktop_running),
            false,
        )
    } else if skills_directory_exists {
        (
            VERDICT_DIRECTORY_RESIDUE,
            format!(
                "只发现 {} 的 Skills 路径，未发现对应应用或 CLI；该目录可能是历史残留，不能作为已安装证据。",
                display_name(input)
            ),
            false,
        )
    } else if desktop_installed {
        (
            VERDICT_CODE_DETECTED,
            format!(
                "已检测到 {} 应用，但还需要验证其 Skills 能力与目录。",
                display_name(input)
            ),
            false,
        )
    } else {
        (
            VERDICT_NOT_DETECTED,
            format!(
                "未检测到 {} 的可靠安装证据；保持未接管，也不创建任何目录。",
                display_name(input)
            ),
            false,
        )
    };

    let desktop_status = if desktop_running {
        "running"
    } else if desktop_installed {
        "installed"
    } else {
        "not-detected"
    };
    let cli_status = if cli_on_path {
        "on-path"
    } else if path_refresh_needed {
        "path-refresh-needed"
    } else if code_installed {
        "installed-off-path"
    } else {
        "not-detected"
    };
    let skills_status = if skills_directory_usable {
        if cli_on_path {
            "ready"
        } else {
            "directory-only"
        }
    } else if skills_directory_exists {
        "invalid"
    } else {
        "missing"
    };

    let evidence = build_evidence(input);
    let checked_paths = collect_checked_paths(input);
    let next_steps = next_steps(input, verdict, desktop_running, skills_directory_exists);

    AgentDoctorCard {
        adapter_id: input.adapter_id.trim().to_string(),
        adapter_name: display_name(input).to_string(),
        detection_kind: input.detection_kind.trim().to_string(),
        path_hint: redact_path_or_text(input, input.path_hint.trim()),
        verdict: verdict.to_string(),
        summary,
        desktop_status: desktop_status.to_string(),
        cli_status: cli_status.to_string(),
        skills_status: skills_status.to_string(),
        evidence,
        checked_paths,
        next_steps,
        safe_fix_available,
    }
}

fn is_desktop_app(adapter_id: &str, probe: &AppProbeEvidence) -> bool {
    if probe.role.eq_ignore_ascii_case("desktop-app") {
        return true;
    }
    let haystack = format!("{} {}", probe.product_id, probe.display_name).to_ascii_lowercase();
    match adapter_id {
        "codex" => haystack.contains("chatgpt"),
        "claude" => haystack.contains("claude") && haystack.contains("desktop"),
        _ => false,
    }
}

fn is_desktop_package(adapter_id: &str, probe: &PackageProbeEvidence) -> bool {
    if probe.role.eq_ignore_ascii_case("desktop-app") {
        return true;
    }
    let haystack = format!("{} {}", probe.package_id, probe.display_name).to_ascii_lowercase();
    match adapter_id {
        "codex" => haystack.contains("chatgpt"),
        "claude" => haystack.contains("claude") && haystack.contains("desktop"),
        _ => false,
    }
}

fn is_code_app(probe: &AppProbeEvidence) -> bool {
    probe.role.eq_ignore_ascii_case("code-app")
}

fn is_code_package(probe: &PackageProbeEvidence) -> bool {
    matches!(
        probe.role.to_ascii_lowercase().as_str(),
        "code-cli" | "code-app"
    )
}

fn display_name(input: &AdapterDoctorInput) -> &str {
    let name = input.adapter_name.trim();
    if name.is_empty() {
        input.adapter_id.trim()
    } else {
        name
    }
}

fn path_refresh_summary(adapter_id: &str) -> String {
    match adapter_id {
        "codex" => {
            "已发现 Codex CLI 安装证据，但当前进程的 PATH 找不到 codex；这不同于仅安装或打开 ChatGPT Desktop。"
                .to_string()
        }
        "claude" => {
            "已发现 Claude Code 安装证据，但当前进程的 PATH 找不到 claude；这不同于仅安装或打开 Claude Desktop。"
                .to_string()
        }
        _ => "已发现 CLI 安装证据，但当前进程的 PATH 尚未包含其命令。".to_string(),
    }
}

fn desktop_only_summary(adapter_id: &str, running: bool) -> String {
    let activity = if running { "正在运行" } else { "已安装" };
    match adapter_id {
        "codex" => format!(
            "ChatGPT Desktop {}，但未发现 Codex CLI/代码能力；两者不能视为同一个安装。",
            activity
        ),
        "claude" => format!(
            "Claude Desktop {}，但未发现 Claude Code CLI；桌面聊天能力不等于本地 Skills 代码能力。",
            activity
        ),
        _ => format!("桌面应用{}，但未发现可管理的 CLI/Skills 能力。", activity),
    }
}

fn next_steps(
    input: &AdapterDoctorInput,
    verdict: &str,
    desktop_running: bool,
    skills_directory_exists: bool,
) -> Vec<String> {
    match verdict {
        VERDICT_READY => {
            vec!["检测结果完整；启用接管前仍应先创建快照并预览将写入的链接。".to_string()]
        }
        VERDICT_PATH_REFRESH_NEEDED => vec![
            "完全退出并重新打开 AI SkillHub 与终端，让新 PATH 进入应用进程。".to_string(),
            "重新运行适配器医生；若命令仍不可见，再检查安装器是否把 CLI 加入当前用户 PATH。"
                .to_string(),
        ],
        VERDICT_DESKTOP_ONLY => match input.adapter_id.trim().to_ascii_lowercase().as_str() {
            "codex" => vec![
                "ChatGPT Desktop 可以继续使用，但本地 Skills 接管必须另外确认 Codex CLI/代码能力。"
                    .to_string(),
                "不要因为 ~/.codex/skills 存在就把 ChatGPT Desktop 标记为 Codex 已安装。"
                    .to_string(),
            ],
            "claude" => vec![
                "Claude Desktop 可以继续使用；需要本地 Skills 时请另外安装或启用 Claude Code。"
                    .to_string(),
                "不要因为 ~/.claude/skills 存在就把 Claude Desktop 标记为 Claude Code。"
                    .to_string(),
            ],
            _ => vec!["确认该桌面产品是否公开支持本地 Skills，再决定是否接管。".to_string()],
        },
        VERDICT_CODE_DETECTED => {
            let mut steps = vec![
                "确认工具官方文档声明的 Skills 目录；诊断不会为了变成绿色而创建空目录。"
                    .to_string(),
            ];
            if desktop_running {
                steps.push("桌面应用运行状态仅作为辅助证据，不替代 CLI 能力检查。".to_string());
            }
            steps
        }
        VERDICT_DIRECTORY_RESIDUE => vec![
            "将该目录视为历史残留；先确认对应工具仍安装，再决定保留、迁移或手动清理。".to_string(),
            "当前保持未启用，不对残留目录写入或创建链接。".to_string(),
        ],
        _ => {
            let mut steps = vec![
                "确认工具是否安装在当前 Windows 用户下，然后重新检测。".to_string(),
                "未确认工具存在前，保持未启用且不创建默认 Skills 目录。".to_string(),
            ];
            if skills_directory_exists {
                steps.push(
                    "Skills 路径存在不代表工具存在，请结合应用、包或命令证据判断。".to_string(),
                );
            }
            steps
        }
    }
}

fn build_evidence(input: &AdapterDoctorInput) -> Vec<AgentDoctorEvidenceCard> {
    let mut output = Vec::new();
    for probe in &input.commands {
        let status = if probe.found_on_path { "ok" } else { "missing" };
        let detail = if probe.found_on_path {
            if probe.version.trim().is_empty() {
                "命令已在当前进程 PATH 中解析。".to_string()
            } else {
                format!("命令已解析，版本 {}。", probe.version.trim())
            }
        } else if probe.detail.trim().is_empty() {
            "当前进程 PATH 中未找到该命令。".to_string()
        } else {
            redact_text(input, &probe.detail)
        };
        output.push(AgentDoctorEvidenceCard {
            probe_kind: "command".to_string(),
            label: probe.command.trim().to_string(),
            status: status.to_string(),
            detail,
            path: redact_path_or_text(input, &probe.resolved_path),
        });
    }
    for probe in &input.apps {
        let status = if probe.running {
            "running"
        } else if probe.installed {
            "installed"
        } else {
            "missing"
        };
        let detail = if probe.detail.trim().is_empty() {
            format!(
                "来源：{}；角色：{}。",
                empty_as(&probe.evidence_source, "未声明"),
                empty_as(&probe.role, "unknown")
            )
        } else {
            redact_text(input, &probe.detail)
        };
        output.push(AgentDoctorEvidenceCard {
            probe_kind: "app".to_string(),
            label: empty_as(&probe.display_name, &probe.product_id).to_string(),
            status: status.to_string(),
            detail,
            path: redact_path_or_text(input, &probe.executable_path),
        });
    }
    for probe in &input.packages {
        let status = if probe.installed {
            "installed"
        } else {
            "missing"
        };
        let detail = if probe.detail.trim().is_empty() {
            format!(
                "角色：{}{}。",
                empty_as(&probe.role, "unknown"),
                if probe.version.trim().is_empty() {
                    String::new()
                } else {
                    format!("；版本 {}", probe.version.trim())
                }
            )
        } else {
            redact_text(input, &probe.detail)
        };
        output.push(AgentDoctorEvidenceCard {
            probe_kind: "package".to_string(),
            label: empty_as(&probe.display_name, &probe.package_id).to_string(),
            status: status.to_string(),
            detail,
            path: redact_path_or_text(input, &probe.install_path),
        });
    }
    for probe in &input.paths {
        let status = if !probe.exists {
            "missing"
        } else if probe.purpose.eq_ignore_ascii_case("skills-directory") && !probe.is_directory {
            "invalid"
        } else if probe.purpose.eq_ignore_ascii_case("skills-directory") && !probe.contains_skill_md
        {
            "directory-only"
        } else {
            "ok"
        };
        let detail = if probe.detail.trim().is_empty() {
            format!(
                "用途：{}；目录：{}；可写：{}；链接：{}；含 SKILL.md：{}。",
                empty_as(&probe.purpose, "unknown"),
                probe.is_directory,
                probe.writable,
                probe.is_link,
                probe.contains_skill_md
            )
        } else {
            redact_text(input, &probe.detail)
        };
        output.push(AgentDoctorEvidenceCard {
            probe_kind: "path".to_string(),
            label: empty_as(&probe.purpose, "path").to_string(),
            status: status.to_string(),
            detail,
            path: redact_path_or_text(input, &probe.path),
        });
    }
    output
}

fn collect_checked_paths(input: &AdapterDoctorInput) -> Vec<String> {
    let mut paths = Vec::new();
    push_unique_path(input, &mut paths, &input.path_hint);
    for probe in &input.commands {
        push_unique_path(input, &mut paths, &probe.resolved_path);
    }
    for probe in &input.apps {
        push_unique_path(input, &mut paths, &probe.executable_path);
    }
    for probe in &input.packages {
        push_unique_path(input, &mut paths, &probe.install_path);
    }
    for probe in &input.paths {
        push_unique_path(input, &mut paths, &probe.path);
    }
    paths
}

fn push_unique_path(input: &AdapterDoctorInput, output: &mut Vec<String>, path: &str) {
    if path.trim().is_empty() {
        return;
    }
    let path = redact_path_or_text(input, path);
    if !output.iter().any(|item| item.eq_ignore_ascii_case(&path)) {
        output.push(path);
    }
}

fn redact_path_or_text(input: &AdapterDoctorInput, value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() || !input.redact_paths {
        return trimmed.to_string();
    }
    redact_path(trimmed, input.home_dir.trim())
}

fn redact_text(input: &AdapterDoctorInput, value: &str) -> String {
    if !input.redact_paths {
        return value.trim().to_string();
    }
    let mut output = value.trim().to_string();
    let home = input.home_dir.trim();
    if !home.is_empty() {
        output = replace_case_insensitive(&output, home, "~");
    }
    redact_windows_user_segments(&output)
}

pub(crate) fn redact_path(value: &str, home_dir: &str) -> String {
    let trimmed = value.trim().trim_matches('"');
    if trimmed.is_empty() {
        return String::new();
    }
    if !home_dir.is_empty() {
        let normalized_path = trimmed.replace('/', "\\");
        let normalized_home = home_dir.trim_end_matches(['\\', '/']).replace('/', "\\");
        if normalized_path
            .to_ascii_lowercase()
            .starts_with(&normalized_home.to_ascii_lowercase())
        {
            let suffix = normalized_path
                .get(normalized_home.len()..)
                .unwrap_or_default()
                .trim_start_matches('\\');
            return if suffix.is_empty() {
                "~".to_string()
            } else {
                format!("~\\{}", suffix)
            };
        }
    }
    redact_windows_user_segments(trimmed)
}

fn redact_windows_user_segments(value: &str) -> String {
    let mut output = value.replace('/', "\\");
    let marker = "\\users\\";
    let mut cursor = 0usize;
    loop {
        let lower = output.to_ascii_lowercase();
        let Some(relative_start) = lower[cursor..].find(marker) else {
            break;
        };
        let start = cursor + relative_start;
        let user_start = start + marker.len();
        let user_end = output[user_start..]
            .find('\\')
            .map(|offset| user_start + offset)
            .unwrap_or(output.len());
        output.replace_range(user_start..user_end, "<user>");
        cursor = user_start + "<user>".len();
        if cursor >= output.len() {
            break;
        }
    }
    output
}

fn replace_case_insensitive(haystack: &str, needle: &str, replacement: &str) -> String {
    if needle.is_empty() {
        return haystack.to_string();
    }
    let lower_needle = needle.to_ascii_lowercase();
    let mut output = String::with_capacity(haystack.len());
    let mut cursor = 0usize;
    let lower_haystack = haystack.to_ascii_lowercase();
    while let Some(relative_index) = lower_haystack[cursor..].find(&lower_needle) {
        let index = cursor + relative_index;
        output.push_str(&haystack[cursor..index]);
        output.push_str(replacement);
        cursor = index + needle.len();
    }
    output.push_str(&haystack[cursor..]);
    output
}

fn empty_as<'a>(value: &'a str, fallback: &'a str) -> &'a str {
    let value = value.trim();
    if value.is_empty() {
        fallback
    } else {
        value
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn codex_input() -> AdapterDoctorInput {
        AdapterDoctorInput {
            adapter_id: "codex".to_string(),
            adapter_name: "ChatGPT Desktop / OpenAI Codex".to_string(),
            detection_kind: "split-product".to_string(),
            path_hint: r"C:\Users\ExampleUser\.codex\skills".to_string(),
            home_dir: r"C:\Users\ExampleUser".to_string(),
            redact_paths: true,
            ..AdapterDoctorInput::default()
        }
    }

    #[test]
    fn desktop_running_without_cli_is_not_codex_ready() {
        let mut input = codex_input();
        input.apps.push(AppProbeEvidence {
            product_id: "chatgpt-desktop".to_string(),
            display_name: "ChatGPT Desktop".to_string(),
            role: "desktop-app".to_string(),
            installed: true,
            running: true,
            executable_path: r"C:\Users\ExampleUser\AppData\Local\OpenAI\ChatGPT.exe".to_string(),
            evidence_source: "process".to_string(),
            ..AppProbeEvidence::default()
        });
        input.commands.push(CommandProbeEvidence {
            command: "codex".to_string(),
            found_on_path: false,
            ..CommandProbeEvidence::default()
        });

        let card = diagnose_adapter(&input);
        assert_eq!(card.verdict, VERDICT_DESKTOP_ONLY);
        assert_eq!(card.desktop_status, "running");
        assert_eq!(card.cli_status, "not-detected");
        assert!(card.summary.contains("不能视为同一个安装"));
        assert!(!card.safe_fix_available);
    }

    #[test]
    fn installed_cli_off_path_requests_process_refresh() {
        let mut input = codex_input();
        input.commands.push(CommandProbeEvidence {
            command: "codex".to_string(),
            found_on_path: false,
            detail: "codex is not recognized in this process".to_string(),
            ..CommandProbeEvidence::default()
        });
        input.packages.push(PackageProbeEvidence {
            package_id: "@openai/codex".to_string(),
            display_name: "OpenAI Codex CLI".to_string(),
            role: "code-cli".to_string(),
            installed: true,
            provides_cli: true,
            version: "1.2.3".to_string(),
            install_path: r"C:\Users\ExampleUser\AppData\Roaming\npm\node_modules\@openai\codex"
                .to_string(),
            ..PackageProbeEvidence::default()
        });
        input.paths.push(PathProbeEvidence {
            path: r"C:\Users\ExampleUser\AppData\Roaming\npm\codex.cmd".to_string(),
            purpose: "cli-executable".to_string(),
            exists: true,
            ..PathProbeEvidence::default()
        });

        let card = diagnose_adapter(&input);
        assert_eq!(card.verdict, VERDICT_PATH_REFRESH_NEEDED);
        assert_eq!(card.cli_status, "path-refresh-needed");
        assert!(card.safe_fix_available);
        assert!(card.next_steps[0].contains("重新打开"));
        assert!(card
            .checked_paths
            .iter()
            .all(|path| !path.contains("ExampleUser")));
        assert!(card.checked_paths.iter().any(|path| path.starts_with('~')));
    }

    #[test]
    fn skills_directory_alone_is_reported_as_residue() {
        let mut input = codex_input();
        input.paths.push(PathProbeEvidence {
            path: r"C:\Users\ExampleUser\.codex\skills".to_string(),
            purpose: "skills-directory".to_string(),
            exists: true,
            is_directory: true,
            writable: true,
            contains_skill_md: true,
            ..PathProbeEvidence::default()
        });

        let card = diagnose_adapter(&input);
        assert_eq!(card.verdict, VERDICT_DIRECTORY_RESIDUE);
        assert_eq!(card.skills_status, "directory-only");
        assert!(card.summary.contains("历史残留"));
        assert!(!card.safe_fix_available);
    }

    #[test]
    fn installed_claude_code_with_skills_is_ready_without_desktop() {
        let input = AdapterDoctorInput {
            adapter_id: "claude".to_string(),
            adapter_name: "Claude Desktop / Claude Code".to_string(),
            detection_kind: "split-product".to_string(),
            path_hint: r"C:\Users\ExampleUser\.claude\skills".to_string(),
            home_dir: r"C:\Users\ExampleUser".to_string(),
            redact_paths: true,
            commands: vec![CommandProbeEvidence {
                command: "claude".to_string(),
                found_on_path: true,
                resolved_path: r"C:\Users\ExampleUser\AppData\Roaming\npm\claude.cmd".to_string(),
                version: "2.1.0".to_string(),
                ..CommandProbeEvidence::default()
            }],
            paths: vec![PathProbeEvidence {
                path: r"C:\Users\ExampleUser\.claude\skills".to_string(),
                purpose: "skills-directory".to_string(),
                exists: true,
                is_directory: true,
                writable: true,
                contains_skill_md: true,
                ..PathProbeEvidence::default()
            }],
            ..AdapterDoctorInput::default()
        };

        let card = diagnose_adapter(&input);
        assert_eq!(card.verdict, VERDICT_READY);
        assert_eq!(card.desktop_status, "not-detected");
        assert_eq!(card.cli_status, "on-path");
        assert_eq!(card.skills_status, "ready");
        assert!(card.summary.contains("Claude Code"));
    }
}
