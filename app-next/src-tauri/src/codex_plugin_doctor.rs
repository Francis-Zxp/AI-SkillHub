//! Strictly read-only Codex plugin health probe.
//!
//! The probe is intentionally separated from every repair implementation. It never
//! launches Codex, PowerShell, npm, setup scripts, cached JavaScript, or any other
//! executable. It also never creates a directory. Callers provide an explicit
//! [`ProbeEnvironment`], which makes the same decision engine usable on Windows,
//! macOS, and in hermetic tests.

use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File};
use std::io::{self, Read};
use std::path::{Path, PathBuf};

pub const STATUS_READY: &str = "ready";
pub const STATUS_WARN: &str = "warn";
pub const STATUS_ERROR: &str = "error";
pub const STATUS_UNKNOWN: &str = "unknown";

const CONFIG_READ_LIMIT: u64 = 2 * 1024 * 1024;
const HASH_READ_LIMIT: u64 = 8 * 1024 * 1024;

#[derive(Clone, Debug)]
pub struct ProbeLimits {
    pub max_entries: usize,
    pub max_depth: usize,
    pub max_manifest_bytes: u64,
    pub max_hash_bytes: u64,
}

impl Default for ProbeLimits {
    fn default() -> Self {
        Self {
            max_entries: 2_048,
            max_depth: 5,
            max_manifest_bytes: CONFIG_READ_LIMIT,
            max_hash_bytes: HASH_READ_LIMIT,
        }
    }
}

/// Explicit inputs for a probe. This type deliberately does not implement
/// `Serialize` or `Debug`: environment values can contain secrets and must never
/// accidentally be returned to the frontend or formatted into diagnostics.
#[derive(Clone, Default)]
pub struct ProbeEnvironment {
    pub platform: String,
    pub user_home: PathBuf,
    pub local_app_data: Option<PathBuf>,
    pub roaming_app_data: Option<PathBuf>,
    pub environment: BTreeMap<String, String>,
    pub desktop_candidates: Vec<DesktopInstallCandidate>,
    pub appx_package_roots: Vec<PathBuf>,
    /// Versions for which the signed, bundled diagnostic rules are known. An
    /// absent or different version is still scanned, but remains read-only and
    /// receives an explicit `unknown` version verdict.
    pub known_codex_versions: Vec<String>,
    pub limits: ProbeLimits,
}

#[derive(Clone, Debug, Default)]
pub struct DesktopInstallCandidate {
    pub label: String,
    pub path: PathBuf,
    pub version: String,
    pub evidence_source: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CodexPluginDoctorReport {
    pub status: String,
    pub summary: String,
    pub mode: String,
    pub platform: String,
    pub version_state: String,
    pub detected_version: String,
    pub repair_available: bool,
    pub write_capable: bool,
    pub read_only: bool,
    pub mutation_count: u32,
    pub evidence: Vec<ProbeEvidence>,
    pub findings: Vec<ProbeFinding>,
    pub inventory: PluginInventorySummary,
    pub guarantees: Vec<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProbeEvidence {
    pub id: String,
    pub kind: String,
    pub status: String,
    pub label: String,
    pub detail: String,
    pub redacted_path: String,
    pub entry_kind: String,
    pub sha256: String,
    pub byte_size: u64,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProbeFinding {
    pub code: String,
    pub severity: String,
    pub title: String,
    pub detail: String,
    pub remediation: String,
}

#[derive(Clone, Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PluginInventorySummary {
    pub cache_present: bool,
    pub directories: usize,
    pub files: usize,
    pub links: usize,
    pub manifests: usize,
    pub hashed_files: usize,
    pub truncated: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum EntryKind {
    File,
    Directory,
    Link,
    Other,
}

impl EntryKind {
    fn label(self) -> &'static str {
        match self {
            Self::File => "file",
            Self::Directory => "directory",
            Self::Link => "link",
            Self::Other => "other",
        }
    }
}

/// Perform a bounded, read-only inspection of Codex configuration and plugin cache.
/// Build a conservative environment from the current process and run the
/// read-only probe. Only the four documented path overrides are captured; the
/// complete process environment is never retained.
#[allow(dead_code)] // The standalone integration-test module does not call the command wrapper.
pub fn scan_default() -> CodexPluginDoctorReport {
    let mut environment_values = BTreeMap::new();
    for variable in [
        "CODEX_HOME",
        "CODEX_ELECTRON_RESOURCES_PATH",
        "CODEX_PLUGIN_ROOT",
        "CODEX_PLUGIN_CACHE_DIR",
    ] {
        if let Ok(value) = std::env::var(variable) {
            environment_values.insert(variable.to_string(), value);
        }
    }
    let user_home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_default();
    let environment = ProbeEnvironment {
        platform: std::env::consts::OS.to_string(),
        user_home,
        local_app_data: std::env::var_os("LOCALAPPDATA").map(PathBuf::from),
        roaming_app_data: std::env::var_os("APPDATA").map(PathBuf::from),
        environment: environment_values,
        desktop_candidates: Vec::new(),
        appx_package_roots: Vec::new(),
        known_codex_versions: Vec::new(),
        limits: ProbeLimits::default(),
    };
    scan(&environment)
}

/// Run the probe against explicit inputs. This is the preferred entry for tests
/// and for future platform adapters that already hold package-manager evidence.
pub fn scan(environment: &ProbeEnvironment) -> CodexPluginDoctorReport {
    let mut evidence = Vec::new();
    let mut findings = Vec::new();
    let mut inventory = PluginInventorySummary::default();
    let codex_home = resolve_codex_home(environment);

    let home_kind = inspect_entry_kind(&codex_home);
    let home_exists = matches!(home_kind, Ok(EntryKind::Directory | EntryKind::Link));
    let home_status = match &home_kind {
        Ok(EntryKind::Directory) => STATUS_READY,
        Ok(EntryKind::Link) => STATUS_WARN,
        Ok(_) => STATUS_ERROR,
        Err(error) if error.kind() != io::ErrorKind::NotFound => STATUS_ERROR,
        Err(_) => STATUS_UNKNOWN,
    };
    evidence.push(path_evidence(
        "codex-home",
        "codex-home",
        home_status,
        "Codex 用户目录",
        match &home_kind {
            Ok(EntryKind::Directory) => "目录存在；扫描只读取，不会创建或改写目录。",
            Ok(EntryKind::Link) => "目录是链接；仅记录链接状态，不跟随到插件缓存之外。",
            Ok(_) => "路径存在但不是目录。",
            Err(ref error) if error.kind() == io::ErrorKind::NotFound => {
                "目录不存在；扫描不会为了通过检测而创建它。"
            }
            Err(_) => "目录状态无法读取。",
        },
        &codex_home,
        environment,
        home_kind.as_ref().ok().copied(),
        String::new(),
        0,
    ));

    match &home_kind {
        Ok(EntryKind::Link) => findings.push(finding(
            "codex-home-link",
            STATUS_WARN,
            "Codex 用户目录是链接",
            "只读探针不会跨越该链接执行或修改任何内容。",
            "请确认该链接由你本人创建并指向可信位置。",
        )),
        Ok(kind) if *kind != EntryKind::Directory => findings.push(finding(
            "codex-home-not-directory",
            STATUS_ERROR,
            "Codex 用户路径不是目录",
            "当前路径无法作为 Codex 配置与插件缓存根目录。",
            "在 Codex 中确认用户目录设置；本探针不会自动修复。",
        )),
        Err(ref error) if error.kind() != io::ErrorKind::NotFound => findings.push(finding(
            "codex-home-unreadable",
            STATUS_ERROR,
            "Codex 用户目录不可读",
            "系统拒绝读取目录元数据。",
            "检查当前用户权限；不要通过禁用系统安全策略来绕过。",
        )),
        _ => {}
    }

    inspect_environment_overrides(environment, &mut evidence, &mut findings);
    let can_scan_codex_home = matches!(home_kind, Ok(EntryKind::Directory));
    if can_scan_codex_home {
        inspect_codex_config(&codex_home, environment, &mut evidence, &mut findings);
    }

    let detected_versions =
        inspect_installation_evidence(environment, &mut evidence, &mut findings);
    let (version_state, detected_version) = classify_version(
        &detected_versions,
        &environment.known_codex_versions,
        home_exists,
        &mut findings,
    );

    if can_scan_codex_home {
        inspect_plugin_cache(
            &codex_home.join("plugins").join("cache"),
            environment,
            &mut evidence,
            &mut findings,
            &mut inventory,
        );
        inspect_current_bundled_plugin_evidence(
            &codex_home,
            environment,
            &mut evidence,
            &mut findings,
        );
    }

    let status = overall_status(&findings, &version_state, home_exists);
    let summary = match status.as_str() {
        STATUS_READY => "只读检查完成，未发现阻断性问题。不会执行或修复任何插件。",
        STATUS_WARN => "只读检查完成，发现需要人工确认的项目；没有执行任何修复。",
        STATUS_ERROR => "只读检查发现配置或缓存结构错误；没有修改任何文件。",
        _ => "只读检查完成，但当前证据不足以确认 Codex 插件环境是否健康。",
    }
    .to_string();

    CodexPluginDoctorReport {
        status,
        summary,
        mode: "read-only".to_string(),
        platform: normalized_platform(&environment.platform),
        version_state,
        detected_version,
        repair_available: false,
        write_capable: false,
        read_only: true,
        mutation_count: 0,
        evidence,
        findings,
        inventory,
        guarantees: vec![
            "不执行 Codex、PowerShell、npm、setup.ps1 或插件缓存脚本。".to_string(),
            "不创建目录，不复制文件，不修改桌面上的独立健康检查工具。".to_string(),
            "不返回 Token、API Key、Authorization 或环境变量值。".to_string(),
            "未知 Codex 版本只允许查看证据，不提供修复入口。".to_string(),
        ],
    }
}

fn inspect_current_bundled_plugin_evidence(
    codex_home: &Path,
    environment: &ProbeEnvironment,
    evidence: &mut Vec<ProbeEvidence>,
    findings: &mut Vec<ProbeFinding>,
) {
    let bundled_root = codex_home
        .join("plugins")
        .join("cache")
        .join("openai-bundled");
    if !matches!(inspect_entry_kind(&bundled_root), Ok(EntryKind::Directory)) {
        return;
    }
    for component in ["chrome", "computer-use"] {
        let latest = bundled_root.join(component).join("latest");
        let kind = inspect_entry_kind(&latest);
        let status = match kind {
            Ok(EntryKind::Directory | EntryKind::Link) => STATUS_READY,
            Ok(_) => STATUS_ERROR,
            Err(ref error) if error.kind() == io::ErrorKind::NotFound => STATUS_WARN,
            Err(_) => STATUS_ERROR,
        };
        evidence.push(path_evidence(
            &format!("bundled-{component}-latest"),
            "bundled-plugin-current",
            status,
            &format!(
                "{} 当前缓存",
                if component == "chrome" {
                    "Chrome"
                } else {
                    "Computer Use"
                }
            ),
            if status == STATUS_READY {
                "发现当前缓存入口；只读取路径类型，不执行缓存内容。"
            } else {
                "当前缓存入口缺失或类型异常。"
            },
            &latest,
            environment,
            kind.ok(),
            String::new(),
            0,
        ));
        if status != STATUS_READY {
            findings.push(finding(
                &format!("bundled-{component}-latest-missing"),
                status,
                &format!(
                    "{} 当前缓存不完整",
                    if component == "chrome" {
                        "Chrome"
                    } else {
                        "Computer Use"
                    }
                ),
                "只读检查没有找到可信的 latest 缓存入口。",
                "先更新或重启 Codex；如仍异常，再使用独立健康检查工具进行明确确认的修复。",
            ));
        }
    }

    if let Some(local) = &environment.local_app_data {
        let runtime_root = local
            .join("OpenAI")
            .join("Codex")
            .join("runtimes")
            .join("cua_node");
        let runtime_kind = inspect_entry_kind(&runtime_root);
        let runtime_status = if matches!(runtime_kind, Ok(EntryKind::Directory)) {
            STATUS_READY
        } else {
            STATUS_WARN
        };
        evidence.push(path_evidence(
            "computer-use-runtime",
            "computer-use-runtime",
            runtime_status,
            "Computer Use 用户运行时",
            if runtime_status == STATUS_READY {
                "发现用户运行时目录；没有启动 Node 或任何插件脚本。"
            } else {
                "未发现当前用户的 Computer Use 运行时目录。"
            },
            &runtime_root,
            environment,
            runtime_kind.ok(),
            String::new(),
            0,
        ));
        if runtime_status != STATUS_READY {
            findings.push(finding(
                "computer-use-runtime-missing",
                STATUS_WARN,
                "Computer Use 运行时未发现",
                "插件缓存存在时仍需要与当前 Codex 版本匹配的用户运行时。",
                "先启动最新版 Codex 让它完成初始化；只读医生不会创建假目录。",
            ));
        }

        let native_manifest = local
            .join("OpenAI")
            .join("extension")
            .join("com.openai.codexextension.json");
        if matches!(inspect_entry_kind(&native_manifest), Ok(EntryKind::File)) {
            let (status, hash, size) = match read_bounded(&native_manifest, CONFIG_READ_LIMIT) {
                Ok(bytes) if serde_json::from_slice::<serde_json::Value>(&bytes).is_ok() => {
                    (STATUS_READY, sha256_hex(&bytes), bytes.len() as u64)
                }
                Ok(bytes) => (STATUS_ERROR, sha256_hex(&bytes), bytes.len() as u64),
                Err(_) => (STATUS_ERROR, String::new(), 0),
            };
            evidence.push(path_evidence(
                "chrome-native-manifest",
                "chrome-native-host",
                status,
                "Chrome 原生通信清单",
                if status == STATUS_READY {
                    "清单是有效 JSON；未读取凭据，也未启动 Chrome。"
                } else {
                    "清单无法安全解析。"
                },
                &native_manifest,
                environment,
                Some(EntryKind::File),
                hash,
                size,
            ));
            if status == STATUS_ERROR {
                findings.push(finding(
                    "chrome-native-manifest-invalid",
                    STATUS_ERROR,
                    "Chrome 原生通信清单异常",
                    "清单不是有效 JSON 或超过安全读取上限。",
                    "使用独立健康检查工具检查并在明确确认后修复；AI SkillHub 不会改写它。",
                ));
            }
        }
    }
}

#[cfg(test)]
#[allow(dead_code)]
fn probe_codex_plugin_health(environment: &ProbeEnvironment) -> CodexPluginDoctorReport {
    scan(environment)
}

fn resolve_codex_home(environment: &ProbeEnvironment) -> PathBuf {
    environment
        .environment
        .get("CODEX_HOME")
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| environment.user_home.join(".codex"))
}

fn inspect_environment_overrides(
    environment: &ProbeEnvironment,
    evidence: &mut Vec<ProbeEvidence>,
    findings: &mut Vec<ProbeFinding>,
) {
    const PATH_OVERRIDES: &[&str] = &[
        "CODEX_HOME",
        "CODEX_ELECTRON_RESOURCES_PATH",
        "CODEX_PLUGIN_ROOT",
        "CODEX_PLUGIN_CACHE_DIR",
    ];

    for variable in PATH_OVERRIDES {
        let Some(value) = environment.environment.get(*variable) else {
            continue;
        };
        if value.trim().is_empty() {
            evidence.push(ProbeEvidence {
                id: format!("env-{}", variable.to_ascii_lowercase()),
                kind: "environment-override".to_string(),
                status: STATUS_WARN.to_string(),
                label: (*variable).to_string(),
                detail: "变量已声明但值为空；具体值不会进入诊断结果。".to_string(),
                redacted_path: String::new(),
                entry_kind: "missing".to_string(),
                sha256: String::new(),
                byte_size: 0,
            });
            findings.push(finding(
                &format!("empty-env-{}", variable.to_ascii_lowercase()),
                STATUS_WARN,
                "Codex 路径覆盖变量为空",
                &format!("{} 已声明但没有可用路径。", variable),
                "在系统环境变量设置中删除空变量，或改为有效路径。",
            ));
            continue;
        }

        let path = PathBuf::from(value);
        let kind = inspect_entry_kind(&path);
        let stale = matches!(&kind, Err(error) if error.kind() == io::ErrorKind::NotFound);
        let mut override_evidence = path_evidence(
            &format!("env-{}", variable.to_ascii_lowercase()),
            "environment-override",
            if stale {
                STATUS_WARN
            } else if kind.is_ok() {
                STATUS_READY
            } else {
                STATUS_ERROR
            },
            variable,
            if stale {
                "环境变量指向不存在的位置；具体值已脱敏。"
            } else if kind.is_ok() {
                "环境变量目标存在；具体值已脱敏。"
            } else {
                "环境变量目标无法读取；具体值已脱敏。"
            },
            &path,
            environment,
            kind.ok(),
            String::new(),
            0,
        );
        // Never return even a redacted fragment of an environment-variable
        // value: a custom leaf name can itself contain a credential or private
        // project name.
        override_evidence.redacted_path = "<redacted>".to_string();
        evidence.push(override_evidence);
        if stale {
            findings.push(finding(
                &format!("stale-env-{}", variable.to_ascii_lowercase()),
                STATUS_WARN,
                "Codex 路径覆盖已失效",
                &format!("{} 指向的位置已经不存在。", variable),
                "确认旧版本是否已卸载，再从系统环境变量中移除失效覆盖。",
            ));
        }
    }
}

fn inspect_codex_config(
    codex_home: &Path,
    environment: &ProbeEnvironment,
    evidence: &mut Vec<ProbeEvidence>,
    findings: &mut Vec<ProbeFinding>,
) {
    let config_path = codex_home.join("config.toml");
    let kind = inspect_entry_kind(&config_path);
    match kind {
        Err(ref error) if error.kind() == io::ErrorKind::NotFound => {
            evidence.push(path_evidence(
                "codex-config",
                "config",
                STATUS_UNKNOWN,
                "Codex config.toml",
                "未发现配置文件；只读检查不会创建默认配置。",
                &config_path,
                environment,
                None,
                String::new(),
                0,
            ));
        }
        Err(_) => {
            evidence.push(path_evidence(
                "codex-config",
                "config",
                STATUS_ERROR,
                "Codex config.toml",
                "配置文件元数据无法读取。",
                &config_path,
                environment,
                None,
                String::new(),
                0,
            ));
            findings.push(finding(
                "config-unreadable",
                STATUS_ERROR,
                "Codex 配置不可读",
                "只读探针无法打开 config.toml。",
                "检查文件权限；不要删除原配置，必要时先手动备份。",
            ));
        }
        Ok(EntryKind::Link) => {
            evidence.push(path_evidence(
                "codex-config",
                "config",
                STATUS_WARN,
                "Codex config.toml",
                "配置文件是链接；为避免越界，本次不读取链接目标。",
                &config_path,
                environment,
                Some(EntryKind::Link),
                String::new(),
                0,
            ));
            findings.push(finding(
                "config-is-link",
                STATUS_WARN,
                "Codex 配置文件是链接",
                "安全边界要求只记录链接状态，不跟随读取目标。",
                "人工确认链接目标可信后再决定是否保留。",
            ));
        }
        Ok(EntryKind::File) => match read_bounded(&config_path, CONFIG_READ_LIMIT) {
            Ok(bytes) => {
                let byte_size = bytes.len() as u64;
                let has_bom = bytes.starts_with(&[0xEF, 0xBB, 0xBF]);
                let body = if has_bom { &bytes[3..] } else { &bytes[..] };
                match std::str::from_utf8(body) {
                    Err(_) => {
                        evidence.push(path_evidence(
                            "codex-config",
                            "config",
                            STATUS_ERROR,
                            "Codex config.toml",
                            "配置不是有效 UTF-8；内容未返回。",
                            &config_path,
                            environment,
                            Some(EntryKind::File),
                            sha256_hex(&bytes),
                            byte_size,
                        ));
                        findings.push(finding(
                            "config-invalid-utf8",
                            STATUS_ERROR,
                            "Codex 配置编码无效",
                            "config.toml 不是有效 UTF-8。",
                            "先备份文件，再使用 UTF-8 文本编辑器修复编码。",
                        ));
                    }
                    Ok(text) => {
                        let validation = validate_toml_shape(text);
                        let status = if validation.is_err() {
                            STATUS_ERROR
                        } else if has_bom {
                            STATUS_WARN
                        } else {
                            STATUS_READY
                        };
                        let detail = match validation {
                            Ok(()) if has_bom => {
                                "静态结构检查通过，但检测到 UTF-8 BOM；未执行 Codex。".to_string()
                            }
                            Ok(()) => "静态结构检查通过；未执行 Codex。".to_string(),
                            Err(ref reason) => {
                                format!("静态结构检查失败：{}；内容未返回。", reason)
                            }
                        };
                        evidence.push(path_evidence(
                            "codex-config",
                            "config",
                            status,
                            "Codex config.toml",
                            &detail,
                            &config_path,
                            environment,
                            Some(EntryKind::File),
                            sha256_hex(&bytes),
                            byte_size,
                        ));
                        if let Err(reason) = validation {
                            findings.push(finding(
                                "config-invalid-toml-shape",
                                STATUS_ERROR,
                                "Codex 配置结构异常",
                                &format!("config.toml 的静态结构检查失败：{}。", reason),
                                "不要让 AI SkillHub 自动改写；先备份，再在 Codex 官方配置说明下人工修复。",
                            ));
                        } else if has_bom {
                            findings.push(finding(
                                "config-utf8-bom",
                                STATUS_WARN,
                                "Codex 配置包含 UTF-8 BOM",
                                "部分 TOML 读取器可能不接受文件头 BOM。",
                                "先备份，再用 UTF-8 无 BOM 格式保存；只读医生不会替你改写。",
                            ));
                        }

                        let secret_keys = sensitive_assignment_keys(text);
                        if !secret_keys.is_empty() {
                            findings.push(finding(
                                "config-inline-secret",
                                STATUS_WARN,
                                "配置可能包含内联凭据",
                                &format!(
                                    "检测到 {} 个敏感字段名；值未读取到诊断结果。",
                                    secret_keys.len()
                                ),
                                "优先改用宿主支持的登录流程或环境变量引用；操作前先备份。",
                            ));
                        }
                    }
                }
            }
            Err(error) => {
                let code = if error.kind() == io::ErrorKind::InvalidData {
                    "config-too-large"
                } else {
                    "config-read-failed"
                };
                evidence.push(path_evidence(
                    "codex-config",
                    "config",
                    STATUS_ERROR,
                    "Codex config.toml",
                    "配置无法在安全读取上限内检查。",
                    &config_path,
                    environment,
                    Some(EntryKind::File),
                    String::new(),
                    0,
                ));
                findings.push(finding(
                    code,
                    STATUS_ERROR,
                    "Codex 配置读取失败",
                    "文件无法读取或超过 2 MiB 安全上限。",
                    "人工检查文件大小和权限；只读医生不会截断或改写。",
                ));
            }
        },
        Ok(kind) => {
            evidence.push(path_evidence(
                "codex-config",
                "config",
                STATUS_ERROR,
                "Codex config.toml",
                "路径存在，但不是普通文件。",
                &config_path,
                environment,
                Some(kind),
                String::new(),
                0,
            ));
            findings.push(finding(
                "config-not-file",
                STATUS_ERROR,
                "Codex 配置路径类型异常",
                "config.toml 不是普通文件。",
                "人工检查路径；只读医生不会删除或替换它。",
            ));
        }
    }
}

fn inspect_installation_evidence(
    environment: &ProbeEnvironment,
    evidence: &mut Vec<ProbeEvidence>,
    findings: &mut Vec<ProbeFinding>,
) -> Vec<String> {
    let mut candidates = environment.desktop_candidates.clone();
    if let Some(local) = &environment.local_app_data {
        for relative in [
            ["Programs", "ChatGPT", "ChatGPT.exe"].as_slice(),
            ["Programs", "OpenAI", "ChatGPT.exe"].as_slice(),
            ["OpenAI", "ChatGPT.exe"].as_slice(),
        ] {
            let mut path = local.clone();
            for segment in relative {
                path.push(segment);
            }
            candidates.push(DesktopInstallCandidate {
                label: "ChatGPT Desktop".to_string(),
                path,
                version: String::new(),
                evidence_source: "known-path".to_string(),
            });
        }
        candidates.push(DesktopInstallCandidate {
            label: "OpenAI Codex CLI".to_string(),
            path: local
                .join("OpenAI")
                .join("Codex")
                .join("bin")
                .join("codex.exe"),
            version: String::new(),
            evidence_source: "known-path".to_string(),
        });
        candidates.push(DesktopInstallCandidate {
            label: "OpenAI Codex AppX user data".to_string(),
            path: local.join("Packages").join("OpenAI.Codex_2p2nqsd0c76g0"),
            version: String::new(),
            evidence_source: "known-package-family".to_string(),
        });
    }
    if let Some(roaming) = &environment.roaming_app_data {
        candidates.push(DesktopInstallCandidate {
            label: "OpenAI Codex launcher".to_string(),
            path: roaming.join("npm").join("codex.cmd"),
            version: String::new(),
            evidence_source: "known-path".to_string(),
        });
    }

    let mut seen = BTreeSet::new();
    let mut versions = Vec::new();
    for (index, candidate) in candidates.into_iter().enumerate() {
        let key = candidate.path.to_string_lossy().to_ascii_lowercase();
        if !seen.insert(key) {
            continue;
        }
        let kind = inspect_entry_kind(&candidate.path);
        if matches!(&kind, Err(error) if error.kind() == io::ErrorKind::NotFound) {
            continue;
        }
        if !candidate.version.trim().is_empty() {
            versions.push(candidate.version.trim().to_string());
        }
        let detail = match kind {
            Ok(EntryKind::File) => format!(
                "发现只读安装证据（{}）；没有启动程序。",
                safe_source_label(&candidate.evidence_source)
            ),
            Ok(EntryKind::Directory) => format!(
                "发现只读包目录证据（{}）；没有启动程序。",
                safe_source_label(&candidate.evidence_source)
            ),
            Ok(EntryKind::Link) => "安装证据是链接；未跟随或执行目标。".to_string(),
            Ok(EntryKind::Other) => "安装证据类型无法确认。".to_string(),
            Err(_) => "安装证据无法读取。".to_string(),
        };
        evidence.push(path_evidence(
            &format!("desktop-evidence-{index}"),
            "desktop-install",
            if kind.is_ok() {
                STATUS_READY
            } else {
                STATUS_ERROR
            },
            if candidate.label.trim().is_empty() {
                "Codex / ChatGPT Desktop"
            } else {
                &candidate.label
            },
            &detail,
            &candidate.path,
            environment,
            kind.ok(),
            String::new(),
            0,
        ));
    }

    for (index, package_root) in environment.appx_package_roots.iter().enumerate() {
        if matches!(inspect_entry_kind(package_root), Ok(EntryKind::Link)) {
            evidence.push(path_evidence(
                &format!("appx-package-link-{index}"),
                "desktop-install",
                STATUS_WARN,
                "ChatGPT Desktop AppX 包目录",
                "包目录是链接；为避免越界，本次不读取其清单。",
                package_root,
                environment,
                Some(EntryKind::Link),
                String::new(),
                0,
            ));
            findings.push(finding(
                "appx-package-root-link",
                STATUS_WARN,
                "AppX 包目录是链接",
                "只读探针不会跨越该链接读取 AppX 清单。",
                "通过 Microsoft Store 或系统应用设置确认真实安装。",
            ));
            continue;
        }
        let manifest = package_root.join("AppxManifest.xml");
        let kind = inspect_entry_kind(&manifest);
        if !matches!(kind, Ok(EntryKind::File)) {
            continue;
        }
        let (status, version, hash, bytes) = match read_bounded(&manifest, CONFIG_READ_LIMIT) {
            Ok(body) => {
                let version = std::str::from_utf8(&body)
                    .ok()
                    .and_then(extract_appx_version)
                    .unwrap_or_default();
                (STATUS_READY, version, sha256_hex(&body), body.len() as u64)
            }
            Err(_) => (STATUS_ERROR, String::new(), String::new(), 0),
        };
        if !version.is_empty() {
            versions.push(version.clone());
        }
        evidence.push(path_evidence(
            &format!("appx-manifest-{index}"),
            "desktop-install",
            status,
            "ChatGPT Desktop AppX manifest",
            if version.is_empty() {
                "发现 AppX 清单，但没有读取到可识别版本；未启动应用。"
            } else {
                "发现 AppX 清单与版本；未启动应用。"
            },
            &manifest,
            environment,
            Some(EntryKind::File),
            hash,
            bytes,
        ));
        if status == STATUS_ERROR {
            findings.push(finding(
                "appx-manifest-unreadable",
                STATUS_WARN,
                "ChatGPT Desktop 清单不可读",
                "只读探针无法确认 AppX 版本。",
                "通过 Microsoft Store 或系统应用设置确认安装状态。",
            ));
        }
    }
    versions.sort();
    versions.dedup();
    versions
}

fn classify_version(
    detected_versions: &[String],
    known_versions: &[String],
    has_codex_evidence: bool,
    findings: &mut Vec<ProbeFinding>,
) -> (String, String) {
    let detected = detected_versions.first().cloned().unwrap_or_default();
    if detected.is_empty() {
        if has_codex_evidence {
            findings.push(finding(
                "codex-version-unknown",
                STATUS_WARN,
                "Codex 版本未知",
                "发现 Codex 用户数据，但没有可信版本证据；只允许查看，不提供修复。",
                "从 Codex/ChatGPT 官方界面确认版本；不要运行来源不明的修复脚本。",
            ));
        }
        return (STATUS_UNKNOWN.to_string(), String::new());
    }

    if known_versions
        .iter()
        .any(|known| known.trim().eq_ignore_ascii_case(&detected))
    {
        return ("known".to_string(), detected);
    }

    findings.push(finding(
        "codex-version-unsupported",
        STATUS_WARN,
        "Codex 版本尚未验证",
        "检测到版本，但当前正式包没有匹配的签名诊断规则；保持完全只读。",
        "更新 AI SkillHub 后重新扫描；不要套用其他版本的修复规则。",
    ));
    (STATUS_UNKNOWN.to_string(), detected)
}

fn inspect_plugin_cache(
    cache_root: &Path,
    environment: &ProbeEnvironment,
    evidence: &mut Vec<ProbeEvidence>,
    findings: &mut Vec<ProbeFinding>,
    inventory: &mut PluginInventorySummary,
) {
    let kind = inspect_entry_kind(cache_root);
    match kind {
        Err(ref error) if error.kind() == io::ErrorKind::NotFound => {
            evidence.push(path_evidence(
                "plugin-cache",
                "plugin-cache",
                STATUS_UNKNOWN,
                "Codex 插件缓存",
                "未发现插件缓存；扫描不会创建空目录。",
                cache_root,
                environment,
                None,
                String::new(),
                0,
            ));
            return;
        }
        Err(_) => {
            evidence.push(path_evidence(
                "plugin-cache",
                "plugin-cache",
                STATUS_ERROR,
                "Codex 插件缓存",
                "缓存根目录无法读取。",
                cache_root,
                environment,
                None,
                String::new(),
                0,
            ));
            findings.push(finding(
                "plugin-cache-unreadable",
                STATUS_ERROR,
                "插件缓存不可读",
                "只读探针无法列出插件缓存。",
                "检查当前用户权限；不要直接删除整个缓存。",
            ));
            return;
        }
        Ok(EntryKind::Link) => {
            evidence.push(path_evidence(
                "plugin-cache",
                "plugin-cache",
                STATUS_WARN,
                "Codex 插件缓存",
                "缓存根目录是链接；为避免越界，本次不跟随。",
                cache_root,
                environment,
                Some(EntryKind::Link),
                String::new(),
                0,
            ));
            findings.push(finding(
                "plugin-cache-is-link",
                STATUS_WARN,
                "插件缓存根目录是链接",
                "只读探针不会跨越缓存根目录链接。",
                "人工确认链接目标与权限边界。",
            ));
            return;
        }
        Ok(EntryKind::Directory) => {}
        Ok(_) => {
            findings.push(finding(
                "plugin-cache-not-directory",
                STATUS_ERROR,
                "插件缓存路径类型异常",
                "缓存根路径不是目录。",
                "人工检查路径；只读医生不会替换它。",
            ));
            return;
        }
    }

    inventory.cache_present = true;
    evidence.push(path_evidence(
        "plugin-cache",
        "plugin-cache",
        STATUS_READY,
        "Codex 插件缓存",
        "缓存存在；仅列出、校验清单与计算有限文件哈希。",
        cache_root,
        environment,
        Some(EntryKind::Directory),
        String::new(),
        0,
    ));

    let mut stack = vec![(cache_root.to_path_buf(), 0usize)];
    let mut visited = 0usize;
    while let Some((directory, depth)) = stack.pop() {
        if depth > environment.limits.max_depth {
            inventory.truncated = true;
            continue;
        }
        let entries = match fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(_) => {
                findings.push(finding(
                    "plugin-cache-entry-unreadable",
                    STATUS_WARN,
                    "部分插件缓存不可读",
                    "一个缓存目录无法列出；未尝试提升权限。",
                    "检查该目录权限或使用 Codex 官方更新流程重建缓存。",
                ));
                continue;
            }
        };

        for entry in entries {
            if visited >= environment.limits.max_entries {
                inventory.truncated = true;
                break;
            }
            visited += 1;
            let Ok(entry) = entry else {
                continue;
            };
            let path = entry.path();
            let Ok(kind) = inspect_entry_kind(&path) else {
                continue;
            };
            match kind {
                EntryKind::Directory => {
                    inventory.directories += 1;
                    stack.push((path, depth + 1));
                }
                EntryKind::Link => {
                    inventory.links += 1;
                    let broken = !path.exists();
                    evidence.push(path_evidence(
                        &format!("plugin-link-{visited}"),
                        "plugin-link",
                        if broken { STATUS_WARN } else { STATUS_READY },
                        "插件缓存链接",
                        if broken {
                            "链接目标不存在；未跟随链接。"
                        } else {
                            "链接目标存在；仅记录状态，未跟随链接。"
                        },
                        &path,
                        environment,
                        Some(EntryKind::Link),
                        String::new(),
                        0,
                    ));
                    if broken {
                        findings.push(finding(
                            "plugin-cache-broken-link",
                            STATUS_WARN,
                            "插件缓存链接已失效",
                            "发现目标不存在的插件缓存链接。",
                            "优先使用 Codex 官方更新或重装流程；只读医生不会删除链接。",
                        ));
                    }
                }
                EntryKind::File => {
                    inventory.files += 1;
                    let file_name = path
                        .file_name()
                        .and_then(|value| value.to_str())
                        .unwrap_or_default();
                    let manifest = is_manifest_candidate(file_name);
                    let hash_candidate = manifest || is_executable_payload_name(file_name);
                    if manifest {
                        inventory.manifests += 1;
                    }
                    if !hash_candidate {
                        continue;
                    }
                    let limit = if manifest {
                        environment.limits.max_manifest_bytes
                    } else {
                        environment.limits.max_hash_bytes
                    };
                    match read_bounded(&path, limit) {
                        Ok(bytes) => {
                            inventory.hashed_files += 1;
                            let mut status = STATUS_READY;
                            let mut detail = if manifest {
                                "清单已静态读取并计算 SHA-256；未加载插件。".to_string()
                            } else {
                                "可执行载荷仅计算 SHA-256；从未执行。".to_string()
                            };
                            if manifest && file_name.to_ascii_lowercase().ends_with(".json") {
                                if let Err(error) =
                                    serde_json::from_slice::<serde_json::Value>(&bytes)
                                {
                                    status = STATUS_ERROR;
                                    detail = format!(
                                        "JSON 清单格式无效（第 {} 行，第 {} 列）；内容未返回。",
                                        error.line(),
                                        error.column()
                                    );
                                    findings.push(finding(
                                        "plugin-manifest-invalid-json",
                                        STATUS_ERROR,
                                        "插件清单 JSON 无效",
                                        "一个缓存清单无法解析；没有执行相关插件代码。",
                                        "使用 Codex 官方更新流程恢复；不要从任意 Skill 复制修复脚本。",
                                    ));
                                }
                            }
                            evidence.push(path_evidence(
                                &format!("plugin-file-{visited}"),
                                if manifest {
                                    "plugin-manifest"
                                } else {
                                    "plugin-payload"
                                },
                                status,
                                if manifest {
                                    "插件清单"
                                } else {
                                    "插件可执行载荷"
                                },
                                &detail,
                                &path,
                                environment,
                                Some(EntryKind::File),
                                sha256_hex(&bytes),
                                bytes.len() as u64,
                            ));
                        }
                        Err(error) => {
                            let too_large = error.kind() == io::ErrorKind::InvalidData;
                            evidence.push(path_evidence(
                                &format!("plugin-file-{visited}"),
                                if manifest {
                                    "plugin-manifest"
                                } else {
                                    "plugin-payload"
                                },
                                if too_large { STATUS_WARN } else { STATUS_ERROR },
                                if manifest {
                                    "插件清单"
                                } else {
                                    "插件可执行载荷"
                                },
                                if too_large {
                                    "文件超过只读哈希上限，已跳过；从未执行。"
                                } else {
                                    "文件无法读取；从未执行。"
                                },
                                &path,
                                environment,
                                Some(EntryKind::File),
                                String::new(),
                                0,
                            ));
                            findings.push(finding(
                                if too_large {
                                    "plugin-file-too-large"
                                } else {
                                    "plugin-file-unreadable"
                                },
                                if too_large { STATUS_WARN } else { STATUS_ERROR },
                                "插件缓存文件未完成校验",
                                if too_large {
                                    "文件超过只读扫描大小上限。"
                                } else {
                                    "文件无法读取。"
                                },
                                "通过 Codex 官方更新流程核验缓存；只读医生不会运行或替换文件。",
                            ));
                        }
                    }
                }
                EntryKind::Other => {}
            }
        }
        if inventory.truncated {
            break;
        }
    }

    if inventory.truncated {
        findings.push(finding(
            "plugin-cache-scan-truncated",
            STATUS_WARN,
            "插件缓存扫描已达到安全上限",
            "缓存条目或目录深度超过只读扫描预算，剩余内容未遍历。",
            "可在高级诊断中缩小到单个插件；不要提高到无限制扫描。",
        ));
    }
}

fn inspect_entry_kind(path: &Path) -> io::Result<EntryKind> {
    let metadata = fs::symlink_metadata(path)?;
    Ok(classify_entry_kind(
        metadata_is_link_or_reparse_point(&metadata),
        metadata.is_dir(),
        metadata.is_file(),
    ))
}

#[cfg(windows)]
fn metadata_is_link_or_reparse_point(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;

    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
    metadata.file_type().is_symlink()
        || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn metadata_is_link_or_reparse_point(metadata: &fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

fn classify_entry_kind(is_link: bool, is_dir: bool, is_file: bool) -> EntryKind {
    if is_link {
        EntryKind::Link
    } else if is_dir {
        EntryKind::Directory
    } else if is_file {
        EntryKind::File
    } else {
        EntryKind::Other
    }
}

#[allow(clippy::too_many_arguments)]
fn path_evidence(
    id: &str,
    kind: &str,
    status: &str,
    label: &str,
    detail: &str,
    path: &Path,
    environment: &ProbeEnvironment,
    entry_kind: Option<EntryKind>,
    sha256: String,
    byte_size: u64,
) -> ProbeEvidence {
    ProbeEvidence {
        id: id.to_string(),
        kind: kind.to_string(),
        status: status.to_string(),
        label: label.to_string(),
        detail: detail.to_string(),
        redacted_path: redact_path(path, environment),
        entry_kind: entry_kind
            .map(EntryKind::label)
            .unwrap_or("missing")
            .to_string(),
        sha256,
        byte_size,
    }
}

fn finding(
    code: &str,
    severity: &str,
    title: &str,
    detail: &str,
    remediation: &str,
) -> ProbeFinding {
    ProbeFinding {
        code: code.to_string(),
        severity: severity.to_string(),
        title: title.to_string(),
        detail: detail.to_string(),
        remediation: remediation.to_string(),
    }
}

fn overall_status(findings: &[ProbeFinding], version_state: &str, has_home: bool) -> String {
    if findings.iter().any(|item| item.severity == STATUS_ERROR) {
        STATUS_ERROR.to_string()
    } else if findings.iter().any(|item| item.severity == STATUS_WARN) {
        STATUS_WARN.to_string()
    } else if has_home && version_state == "known" {
        STATUS_READY.to_string()
    } else {
        STATUS_UNKNOWN.to_string()
    }
}

fn normalized_platform(platform: &str) -> String {
    match platform.trim().to_ascii_lowercase().as_str() {
        "windows" | "win32" => "windows".to_string(),
        "macos" | "darwin" => "macos".to_string(),
        "linux" => "linux".to_string(),
        _ => "unknown".to_string(),
    }
}

fn safe_source_label(source: &str) -> &'static str {
    match source.trim().to_ascii_lowercase().as_str() {
        "appx" | "appx-manifest" => "AppX 清单",
        "known-path" => "已知安装路径",
        "host-diagnostics" => "宿主只读诊断",
        _ => "调用方提供的只读证据",
    }
}

fn redact_path(path: &Path, environment: &ProbeEnvironment) -> String {
    if path.as_os_str().is_empty() {
        return String::new();
    }
    if let Some(codex_home) = environment
        .environment
        .get("CODEX_HOME")
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
    {
        if let Ok(relative) = path.strip_prefix(codex_home) {
            return display_redacted("<CODEX_HOME>", relative);
        }
    }
    if !environment.user_home.as_os_str().is_empty() {
        if let Ok(relative) = path.strip_prefix(&environment.user_home) {
            return display_redacted("~", relative);
        }
    }
    if let Some(local) = &environment.local_app_data {
        if let Ok(relative) = path.strip_prefix(local) {
            return display_redacted("<LOCALAPPDATA>", relative);
        }
    }
    if let Some(roaming) = &environment.roaming_app_data {
        if let Ok(relative) = path.strip_prefix(roaming) {
            return display_redacted("<APPDATA>", relative);
        }
    }
    let leaf = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("path");
    format!("<external>{}{}", std::path::MAIN_SEPARATOR, leaf)
}

fn display_redacted(prefix: &str, relative: &Path) -> String {
    if relative.as_os_str().is_empty() {
        prefix.to_string()
    } else {
        format!(
            "{}{}{}",
            prefix,
            std::path::MAIN_SEPARATOR,
            relative.display()
        )
    }
}

fn read_bounded(path: &Path, limit: u64) -> io::Result<Vec<u8>> {
    let metadata = fs::metadata(path)?;
    if metadata.len() > limit {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "file exceeds read-only probe limit",
        ));
    }
    let mut file = File::open(path)?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.by_ref().take(limit + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "file exceeds read-only probe limit",
        ));
    }
    Ok(bytes)
}

fn validate_toml_shape(text: &str) -> Result<(), String> {
    if text.contains('\0') {
        return Err("包含 NUL 字符".to_string());
    }
    let mut square_depth = 0i32;
    let mut curly_depth = 0i32;
    let mut in_basic = false;
    let mut in_literal = false;
    let mut escaped = false;

    for (line_index, raw_line) in text.lines().enumerate() {
        let trimmed = raw_line.trim();
        if trimmed.starts_with('[') && !trimmed.starts_with("[[") && !trimmed.ends_with(']') {
            return Err(format!("第 {} 行的表头缺少 ]", line_index + 1));
        }
        if trimmed.starts_with("[[") && !trimmed.ends_with("]]") {
            return Err(format!("第 {} 行的数组表头缺少 ]]", line_index + 1));
        }
        let mut in_comment = false;
        for character in raw_line.chars() {
            if in_comment {
                break;
            }
            if in_basic {
                if escaped {
                    escaped = false;
                } else if character == '\\' {
                    escaped = true;
                } else if character == '"' {
                    in_basic = false;
                }
                continue;
            }
            if in_literal {
                if character == '\'' {
                    in_literal = false;
                }
                continue;
            }
            match character {
                '#' => in_comment = true,
                '"' => in_basic = true,
                '\'' => in_literal = true,
                '[' => square_depth += 1,
                ']' => square_depth -= 1,
                '{' => curly_depth += 1,
                '}' => curly_depth -= 1,
                _ => {}
            }
            if square_depth < 0 || curly_depth < 0 {
                return Err(format!("第 {} 行存在多余的闭合符号", line_index + 1));
            }
        }
    }
    if in_basic || in_literal {
        return Err("字符串引号未闭合".to_string());
    }
    if square_depth != 0 || curly_depth != 0 {
        return Err("数组、表头或内联表未闭合".to_string());
    }
    Ok(())
}

fn sensitive_assignment_keys(text: &str) -> Vec<String> {
    let mut keys = BTreeSet::new();
    for raw_line in text.lines() {
        let line = raw_line.trim();
        if line.starts_with('#') || line.starts_with('[') {
            continue;
        }
        let Some((key, _value)) = line.split_once('=') else {
            continue;
        };
        let normalized = key
            .trim()
            .trim_matches('"')
            .trim_matches('\'')
            .to_ascii_lowercase();
        if [
            "token",
            "api_key",
            "apikey",
            "authorization",
            "password",
            "secret",
            "client_secret",
        ]
        .iter()
        .any(|needle| normalized == *needle || normalized.ends_with(&format!("_{needle}")))
        {
            keys.insert(normalized);
        }
    }
    keys.into_iter().collect()
}

fn is_manifest_candidate(file_name: &str) -> bool {
    matches!(
        file_name.to_ascii_lowercase().as_str(),
        "plugin.json"
            | "manifest.json"
            | "package.json"
            | "marketplace.json"
            | "plugin.toml"
            | "plugin.yaml"
            | "plugin.yml"
    )
}

fn is_executable_payload_name(file_name: &str) -> bool {
    let lower = file_name.to_ascii_lowercase();
    lower == "setup.ps1"
        || lower == "index.js"
        || lower == "main.js"
        || lower.ends_with(".ps1")
        || lower.ends_with(".cmd")
        || lower.ends_with(".exe")
}

fn extract_appx_version(xml: &str) -> Option<String> {
    let identity = xml.find("<Identity")?;
    let rest = &xml[identity..];
    let version = rest.find("Version=")?;
    let rest = &rest[version + "Version=".len()..];
    let quote = rest.chars().next()?;
    if quote != '"' && quote != '\'' {
        return None;
    }
    let value = &rest[1..];
    let end = value.find(quote)?;
    let version = value[..end].trim();
    if version.is_empty()
        || !version
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '.' || ch == '-')
    {
        None
    } else {
        Some(version.to_string())
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    const INITIAL: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
        0x5be0cd19,
    ];
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];

    let mut padded = bytes.to_vec();
    let bit_length = (bytes.len() as u64).wrapping_mul(8);
    padded.push(0x80);
    while padded.len() % 64 != 56 {
        padded.push(0);
    }
    padded.extend_from_slice(&bit_length.to_be_bytes());

    let mut state = INITIAL;
    for chunk in padded.as_chunks::<64>().0 {
        let mut words = [0u32; 64];
        for (index, word) in words.iter_mut().take(16).enumerate() {
            let offset = index * 4;
            *word = u32::from_be_bytes([
                chunk[offset],
                chunk[offset + 1],
                chunk[offset + 2],
                chunk[offset + 3],
            ]);
        }
        for index in 16..64 {
            let s0 = words[index - 15].rotate_right(7)
                ^ words[index - 15].rotate_right(18)
                ^ (words[index - 15] >> 3);
            let s1 = words[index - 2].rotate_right(17)
                ^ words[index - 2].rotate_right(19)
                ^ (words[index - 2] >> 10);
            words[index] = words[index - 16]
                .wrapping_add(s0)
                .wrapping_add(words[index - 7])
                .wrapping_add(s1);
        }

        let mut a = state[0];
        let mut b = state[1];
        let mut c = state[2];
        let mut d = state[3];
        let mut e = state[4];
        let mut f = state[5];
        let mut g = state[6];
        let mut h = state[7];
        for index in 0..64 {
            let sigma1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let choice = (e & f) ^ ((!e) & g);
            let temp1 = h
                .wrapping_add(sigma1)
                .wrapping_add(choice)
                .wrapping_add(K[index])
                .wrapping_add(words[index]);
            let sigma0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let majority = (a & b) ^ (a & c) ^ (b & c);
            let temp2 = sigma0.wrapping_add(majority);
            h = g;
            g = f;
            f = e;
            e = d.wrapping_add(temp1);
            d = c;
            c = b;
            b = a;
            a = temp1.wrapping_add(temp2);
        }
        for (slot, value) in state.iter_mut().zip([a, b, c, d, e, f, g, h]) {
            *slot = slot.wrapping_add(value);
        }
    }

    state
        .iter()
        .map(|word| format!("{word:08x}"))
        .collect::<String>()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn fixture_root(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("ai-skillhub-doctor-{name}-{nonce}"))
    }

    fn environment(root: &Path) -> ProbeEnvironment {
        ProbeEnvironment {
            platform: "windows".to_string(),
            user_home: root.join("用户-弗朗西斯"),
            local_app_data: Some(root.join("本地数据")),
            roaming_app_data: Some(root.join("漫游数据")),
            environment: BTreeMap::new(),
            desktop_candidates: Vec::new(),
            appx_package_roots: Vec::new(),
            known_codex_versions: Vec::new(),
            limits: ProbeLimits::default(),
        }
    }

    fn snapshot(root: &Path) -> Vec<(PathBuf, u64, EntryKind)> {
        fn visit(root: &Path, output: &mut Vec<(PathBuf, u64, EntryKind)>) {
            let Ok(entries) = fs::read_dir(root) else {
                return;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                let kind = inspect_entry_kind(&path).unwrap();
                let len = fs::symlink_metadata(&path)
                    .map(|item| item.len())
                    .unwrap_or(0);
                output.push((path.clone(), len, kind));
                if kind == EntryKind::Directory {
                    visit(&path, output);
                }
            }
        }
        let mut output = Vec::new();
        visit(root, &mut output);
        output.sort_by(|left, right| left.0.cmp(&right.0));
        output
    }

    #[test]
    fn probe_is_read_only_and_redacts_non_ascii_home_and_secrets() {
        let root = fixture_root("readonly");
        let env = environment(&root);
        let codex_home = env.user_home.join(".codex");
        fs::create_dir_all(codex_home.join("plugins/cache/openai/browser/1.0.0")).unwrap();
        fs::write(
            codex_home.join("config.toml"),
            "model = \"gpt-test\"\napi_key = \"do-not-leak-this-token\"\n",
        )
        .unwrap();
        fs::write(
            codex_home.join("plugins/cache/openai/browser/1.0.0/plugin.json"),
            r#"{"name":"browser","version":"1.0.0"}"#,
        )
        .unwrap();
        fs::write(
            codex_home.join("plugins/cache/openai/browser/1.0.0/index.js"),
            "throw new Error('must never execute');",
        )
        .unwrap();

        let before = snapshot(&root);
        let report = probe_codex_plugin_health(&env);
        let after = snapshot(&root);
        assert_eq!(before, after, "probe must not create or mutate files");
        assert!(!report.write_capable);
        assert!(!report.repair_available);
        assert!(report.read_only);
        assert_eq!(report.mutation_count, 0);
        assert_eq!(report.mode, "read-only");
        let serialized = serde_json::to_string(&report).unwrap();
        assert!(!serialized.contains("do-not-leak-this-token"));
        assert!(!serialized.contains(&env.user_home.display().to_string()));
        assert!(serialized.contains("~"));
        assert!(report
            .findings
            .iter()
            .any(|item| item.code == "config-inline-secret"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn missing_codex_home_is_not_created() {
        let root = fixture_root("missing");
        fs::create_dir_all(&root).unwrap();
        let env = environment(&root);
        let expected_home = env.user_home.join(".codex");
        assert!(!expected_home.exists());
        let report = probe_codex_plugin_health(&env);
        assert!(!expected_home.exists());
        assert_eq!(report.status, STATUS_UNKNOWN);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn bom_and_broken_toml_are_reported_without_content() {
        let root = fixture_root("toml");
        let env = environment(&root);
        let codex_home = env.user_home.join(".codex");
        fs::create_dir_all(&codex_home).unwrap();
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice(b"[mcp_servers\ntoken = \"hidden\"\n");
        fs::write(codex_home.join("config.toml"), bytes).unwrap();
        let report = probe_codex_plugin_health(&env);
        assert_eq!(report.status, STATUS_ERROR);
        assert!(report
            .findings
            .iter()
            .any(|item| item.code == "config-invalid-toml-shape"));
        let serialized = serde_json::to_string(&report).unwrap();
        assert!(!serialized.contains("hidden"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn broken_json_manifest_is_an_error_and_never_loaded() {
        let root = fixture_root("json");
        let env = environment(&root);
        let plugin = env
            .user_home
            .join(".codex/plugins/cache/openai/browser/1.0.0");
        fs::create_dir_all(&plugin).unwrap();
        fs::write(plugin.join("plugin.json"), b"{ broken json").unwrap();
        let report = probe_codex_plugin_health(&env);
        assert!(report
            .findings
            .iter()
            .any(|item| item.code == "plugin-manifest-invalid-json"));
        assert_eq!(report.status, STATUS_ERROR);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn stale_environment_override_reports_name_not_value() {
        let root = fixture_root("stale-env");
        fs::create_dir_all(&root).unwrap();
        let mut env = environment(&root);
        let missing = root.join("private-location-that-does-not-exist");
        env.environment.insert(
            "CODEX_ELECTRON_RESOURCES_PATH".to_string(),
            missing.display().to_string(),
        );
        let report = probe_codex_plugin_health(&env);
        assert!(report
            .findings
            .iter()
            .any(|item| item.code == "stale-env-codex_electron_resources_path"));
        let serialized = serde_json::to_string(&report).unwrap();
        assert!(!serialized.contains("private-location-that-does-not-exist"));
        assert!(serialized.contains("CODEX_ELECTRON_RESOURCES_PATH"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn directory_and_link_classification_are_distinct() {
        assert_eq!(
            classify_entry_kind(false, true, false),
            EntryKind::Directory
        );
        assert_eq!(classify_entry_kind(true, true, false), EntryKind::Link);
        assert_eq!(classify_entry_kind(true, false, true), EntryKind::Link);
    }

    #[test]
    fn unknown_version_is_explicit_and_disables_repair() {
        let root = fixture_root("unknown-version");
        let mut env = environment(&root);
        let codex_home = env.user_home.join(".codex");
        let desktop = root.join("ChatGPT.exe");
        fs::create_dir_all(&codex_home).unwrap();
        fs::write(&desktop, b"not executable fixture").unwrap();
        env.desktop_candidates.push(DesktopInstallCandidate {
            label: "ChatGPT Desktop".to_string(),
            path: desktop,
            version: "99.0.0".to_string(),
            evidence_source: "host-diagnostics".to_string(),
        });
        env.known_codex_versions = vec!["1.0.0".to_string()];
        let report = probe_codex_plugin_health(&env);
        assert_eq!(report.version_state, STATUS_UNKNOWN);
        assert_eq!(report.detected_version, "99.0.0");
        assert!(!report.repair_available);
        assert!(!report.write_capable);
        assert!(report
            .findings
            .iter()
            .any(|item| item.code == "codex-version-unsupported"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn current_bundled_plugin_evidence_is_checked_without_running_tools() {
        let root = fixture_root("bundled-current");
        let env = environment(&root);
        let codex_home = env.user_home.join(".codex");
        for component in ["chrome", "computer-use"] {
            fs::create_dir_all(
                codex_home
                    .join("plugins/cache/openai-bundled")
                    .join(component)
                    .join("latest"),
            )
            .unwrap();
        }
        let local = env.local_app_data.as_ref().unwrap();
        fs::create_dir_all(local.join("OpenAI/Codex/runtimes/cua_node")).unwrap();
        let manifest = local.join("OpenAI/extension/com.openai.codexextension.json");
        fs::create_dir_all(manifest.parent().unwrap()).unwrap();
        fs::write(&manifest, br#"{"name":"com.openai.codexextension"}"#).unwrap();

        let before = snapshot(&root);
        let report = probe_codex_plugin_health(&env);
        let after = snapshot(&root);
        assert_eq!(before, after);
        assert!(report
            .evidence
            .iter()
            .any(|item| item.id == "bundled-chrome-latest" && item.status == STATUS_READY));
        assert!(report
            .evidence
            .iter()
            .any(|item| item.id == "bundled-computer-use-latest" && item.status == STATUS_READY));
        assert!(report
            .evidence
            .iter()
            .any(|item| item.id == "computer-use-runtime" && item.status == STATUS_READY));
        assert!(report
            .evidence
            .iter()
            .any(|item| item.id == "chrome-native-manifest" && item.status == STATUS_READY));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn sha256_matches_standard_vector() {
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn appx_version_parser_is_bounded_and_strict() {
        assert_eq!(
            extract_appx_version(
                r#"<Package><Identity Name="OpenAI.ChatGPT" Version="3.1.4.0" /></Package>"#
            ),
            Some("3.1.4.0".to_string())
        );
        assert_eq!(extract_appx_version("<Package />"), None);
    }

    #[test]
    fn environment_values_are_not_debug_or_serializable_contract() {
        let _compile_guard: OsString =
            OsString::from("ProbeEnvironment intentionally has no Debug");
    }
}
