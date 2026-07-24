//! Deterministic, offline metadata extraction for imported Skill repositories.
//!
//! The analyzer intentionally reads only a small set of bounded text files. It never
//! executes repository code, installs dependencies, or follows links embedded in
//! Markdown. Results are base metadata: SQLite/user overrides remain authoritative.

use serde_json::Value;
use std::collections::HashSet;
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};

const MAX_DOCUMENT_BYTES: u64 = 512 * 1024;
const MAX_GIT_CONFIG_BYTES: u64 = 128 * 1024;
const MAX_SOURCE_SKILLS: usize = 320;
const MAX_SCAN_ENTRIES: usize = 4_000;
const MAX_SCAN_DEPTH: usize = 10;
const MAX_TAGS: usize = 12;

pub(crate) const ANALYZER_VERSION: &str = "offline-v304-1";

#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct MetadataAnalysis {
    pub summary: String,
    pub usage_guide: String,
    pub category: String,
    pub tags: Vec<String>,
    pub origin: String,
    pub confidence: f64,
    pub git_origin: String,
}

#[derive(Default)]
struct Frontmatter {
    name: String,
    description: String,
    category: String,
    usage: String,
    tags: Vec<String>,
}

#[derive(Default)]
struct RepositoryDescriptor {
    summary: String,
    usage: String,
    category: String,
    tags: Vec<String>,
    url: String,
}

pub(crate) fn analyze_skill(skill_dir: &Path) -> MetadataAnalysis {
    let skill_path = skill_dir.join("SKILL.md");
    let Some(skill_text) = read_text_limited(&skill_path, MAX_DOCUMENT_BYTES) else {
        return fallback_skill_analysis(skill_dir);
    };

    let frontmatter = parse_frontmatter(&skill_text);
    let readme_text = find_readme(skill_dir)
        .and_then(|path| read_text_limited(&path, MAX_DOCUMENT_BYTES))
        .unwrap_or_default();

    let frontmatter_summary = clean_summary(&frontmatter.description);
    let readme_summary = first_meaningful_paragraph(&readme_text);
    let body_summary = first_meaningful_paragraph(&strip_frontmatter(&skill_text));
    let summary = first_nonempty(&[frontmatter_summary, readme_summary.clone(), body_summary]);

    let explicit_usage = clean_usage(&frontmatter.usage);
    let skill_usage = extract_usage_section(&skill_text);
    let readme_usage = extract_usage_section(&readme_text);
    let usage_guide = first_nonempty(&[explicit_usage, skill_usage, readme_usage]);

    let mut tags = frontmatter.tags.clone();
    tags.extend(extract_explicit_tags(&skill_text));
    tags.extend(extract_explicit_tags(&readme_text));

    let folder_name = skill_dir
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    let combined = format!(
        "{} {} {} {} {}",
        frontmatter.name,
        folder_name,
        summary,
        usage_guide,
        tags.join(" ")
    );
    let category = if is_meaningful_category(&frontmatter.category) {
        clean_label(&frontmatter.category, 80)
    } else {
        infer_category(&combined)
    };
    add_semantic_tags(&combined, &mut tags);
    if !category.is_empty() {
        tags.push(category.clone());
    }
    let tags = normalize_tags(tags);

    let mut origins = Vec::new();
    if !frontmatter.name.is_empty()
        || !frontmatter.description.is_empty()
        || !frontmatter.tags.is_empty()
    {
        origins.push("skill-frontmatter");
    }
    if !readme_text.is_empty() {
        origins.push("readme");
    }
    if origins.is_empty() {
        origins.push("skill-body");
    }

    let mut confidence: f64 = 0.18;
    if !frontmatter.description.is_empty() {
        confidence += 0.42;
    } else if !summary.is_empty() {
        confidence += 0.24;
    }
    if !usage_guide.is_empty() {
        confidence += 0.16;
    }
    if !category.is_empty() {
        confidence += 0.10;
    }
    if !tags.is_empty() {
        confidence += 0.08;
    }

    MetadataAnalysis {
        summary: if summary.is_empty() {
            format!(
                "{} Skill。",
                if frontmatter.name.is_empty() {
                    folder_name
                } else {
                    &frontmatter.name
                }
            )
        } else {
            truncate_chars(&summary, 600)
        },
        usage_guide: if usage_guide.is_empty() && !summary.is_empty() {
            truncate_chars(
                &format!("适用于：{}。", trim_terminal_punctuation(&summary)),
                900,
            )
        } else {
            truncate_chars(&usage_guide, 900)
        },
        category: if category.is_empty() {
            "auto".to_string()
        } else {
            category
        },
        tags,
        origin: format!("{}:{}", ANALYZER_VERSION, origins.join("+")),
        confidence: confidence.min(0.98),
        git_origin: String::new(),
    }
}

pub(crate) fn analyze_source(source_dir: &Path) -> MetadataAnalysis {
    let descriptor = read_repository_descriptor(source_dir);
    let readme_text = find_readme(source_dir)
        .and_then(|path| read_text_limited(&path, MAX_DOCUMENT_BYTES))
        .unwrap_or_default();
    let root_skill = if source_dir.join("SKILL.md").is_file() {
        Some(analyze_skill(source_dir))
    } else {
        None
    };
    let git_origin = read_git_origin(source_dir);

    let skill_files = collect_skill_files(source_dir);
    let mut child_names = Vec::new();
    let mut child_tags = Vec::new();
    let mut child_category_text = String::new();
    for skill_file in skill_files.iter().take(MAX_SOURCE_SKILLS) {
        let Some(text) = read_text_limited(skill_file, MAX_DOCUMENT_BYTES) else {
            continue;
        };
        let parsed = parse_frontmatter(&text);
        let name = if parsed.name.is_empty() {
            skill_file
                .parent()
                .and_then(Path::file_name)
                .and_then(|value| value.to_str())
                .unwrap_or_default()
                .to_string()
        } else {
            parsed.name
        };
        if !name.is_empty() && child_names.len() < 6 {
            child_names.push(name);
        }
        child_tags.extend(parsed.tags);
        child_category_text.push(' ');
        child_category_text.push_str(&parsed.category);
        child_category_text.push(' ');
        child_category_text.push_str(&parsed.description);
    }

    let readme_summary = first_meaningful_paragraph(&readme_text);
    let root_summary = root_skill
        .as_ref()
        .map(|analysis| analysis.summary.clone())
        .unwrap_or_default();
    let generated_summary = if skill_files.is_empty() {
        String::new()
    } else if child_names.is_empty() {
        format!("包含 {} 个可调用 Skill。", skill_files.len())
    } else {
        format!(
            "包含 {} 个可调用 Skill，主要包括 {}{}。",
            skill_files.len(),
            child_names.join("、"),
            if skill_files.len() > child_names.len() {
                " 等"
            } else {
                ""
            }
        )
    };
    let summary = first_nonempty(&[
        clean_summary(&descriptor.summary),
        readme_summary,
        root_summary,
        generated_summary,
    ]);

    let readme_usage = extract_usage_section(&readme_text);
    let root_usage = root_skill
        .as_ref()
        .map(|analysis| analysis.usage_guide.clone())
        .unwrap_or_default();
    let usage_guide = first_nonempty(&[clean_usage(&descriptor.usage), readme_usage, root_usage]);

    let mut tags = descriptor.tags.clone();
    tags.extend(extract_explicit_tags(&readme_text));
    if let Some(root) = &root_skill {
        tags.extend(root.tags.clone());
    }
    tags.extend(child_tags);

    let folder_name = source_dir
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    let combined = format!(
        "{} {} {} {} {} {}",
        folder_name,
        summary,
        usage_guide,
        descriptor.category,
        child_category_text,
        tags.join(" ")
    );
    let category = if is_meaningful_category(&descriptor.category) {
        clean_label(&descriptor.category, 80)
    } else {
        infer_category(&combined)
    };
    add_semantic_tags(&combined, &mut tags);
    if !category.is_empty() {
        tags.push(category.clone());
    }
    if !git_origin.is_empty() || !descriptor.url.is_empty() {
        tags.push("GitHub".to_string());
    }
    let tags = normalize_tags(tags);

    let mut origins = Vec::new();
    if !descriptor.summary.is_empty()
        || !descriptor.category.is_empty()
        || !descriptor.tags.is_empty()
    {
        origins.push("source-manifest");
    }
    if !readme_text.is_empty() {
        origins.push("readme");
    }
    if root_skill.is_some() || !skill_files.is_empty() {
        origins.push("skill-frontmatter");
    }
    if !git_origin.is_empty() {
        origins.push("git");
    }
    if origins.is_empty() {
        origins.push("folder");
    }

    let mut confidence: f64 = 0.16;
    if !descriptor.summary.is_empty() || !readme_text.is_empty() {
        confidence += 0.38;
    } else if !skill_files.is_empty() {
        confidence += 0.24;
    }
    if !usage_guide.is_empty() {
        confidence += 0.12;
    }
    if !category.is_empty() {
        confidence += 0.10;
    }
    if !tags.is_empty() {
        confidence += 0.08;
    }
    if !git_origin.is_empty() {
        confidence += 0.06;
    }

    MetadataAnalysis {
        summary: if summary.is_empty() {
            format!("{} Skill 来源。", folder_name)
        } else {
            truncate_chars(&summary, 600)
        },
        usage_guide: if usage_guide.is_empty() && !skill_files.is_empty() {
            "展开来源后按用途选择子 Skill，或直接调用对应的父 Skill 进行能力路由。".to_string()
        } else {
            truncate_chars(&usage_guide, 900)
        },
        category: if category.is_empty() {
            "auto".to_string()
        } else {
            category
        },
        tags,
        origin: format!("{}:{}", ANALYZER_VERSION, origins.join("+")),
        confidence: confidence.min(0.98),
        git_origin: if git_origin.is_empty() {
            descriptor.url
        } else {
            git_origin
        },
    }
}

fn fallback_skill_analysis(skill_dir: &Path) -> MetadataAnalysis {
    let name = skill_dir
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("Unknown")
        .to_string();
    MetadataAnalysis {
        summary: format!("{} Skill。", name),
        usage_guide: String::new(),
        category: "auto".to_string(),
        tags: Vec::new(),
        origin: format!("{}:folder", ANALYZER_VERSION),
        confidence: 0.12,
        git_origin: String::new(),
    }
}

fn read_repository_descriptor(source_dir: &Path) -> RepositoryDescriptor {
    let path = source_dir.join(".skillhub-source.json");
    let Some(raw) = read_text_limited(&path, MAX_GIT_CONFIG_BYTES) else {
        return RepositoryDescriptor::default();
    };
    let Ok(value) = serde_json::from_str::<Value>(&raw) else {
        return RepositoryDescriptor::default();
    };
    let string = |keys: &[&str]| -> String {
        keys.iter()
            .find_map(|key| value.get(*key).and_then(Value::as_str))
            .unwrap_or_default()
            .trim()
            .to_string()
    };
    let tags = ["tags", "keywords", "labels"]
        .iter()
        .find_map(|key| value.get(*key).and_then(Value::as_array))
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    RepositoryDescriptor {
        summary: string(&["summary", "description", "note"]),
        usage: string(&["usageGuide", "usage", "whenToUse"]),
        category: string(&["category", "categoryId"]),
        tags,
        url: string(&["url", "sourceUrl", "repository"]),
    }
}

fn read_git_origin(source_dir: &Path) -> String {
    let dot_git = source_dir.join(".git");
    let config_path = if dot_git.is_dir() {
        dot_git.join("config")
    } else if dot_git.is_file() {
        let Some(pointer) = read_text_limited(&dot_git, 16 * 1024) else {
            return String::new();
        };
        let Some(git_dir) = pointer
            .lines()
            .find_map(|line| line.trim().strip_prefix("gitdir:"))
            .map(str::trim)
        else {
            return String::new();
        };
        let git_dir = PathBuf::from(git_dir);
        let candidate = if git_dir.is_absolute() {
            git_dir.join("config")
        } else {
            source_dir.join(git_dir).join("config")
        };
        let canonical_source = source_dir.canonicalize().ok();
        let canonical_candidate = candidate.canonicalize().ok();
        match (canonical_source, canonical_candidate) {
            (Some(source), Some(candidate)) if candidate.starts_with(&source) => candidate,
            _ => return String::new(),
        }
    } else {
        return String::new();
    };

    let Some(config) = read_text_limited(&config_path, MAX_GIT_CONFIG_BYTES) else {
        return String::new();
    };
    let mut in_origin = false;
    for line in config.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') {
            in_origin = trimmed
                .to_ascii_lowercase()
                .starts_with("[remote \"origin\"]");
            continue;
        }
        if in_origin {
            if let Some((key, value)) = trimmed.split_once('=') {
                if key.trim().eq_ignore_ascii_case("url") {
                    return value.trim().to_string();
                }
            }
        }
    }
    String::new()
}

fn find_readme(directory: &Path) -> Option<PathBuf> {
    let entries = fs::read_dir(directory).ok()?;
    let mut candidates = Vec::new();
    for entry in entries.flatten().take(256) {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
        if let Some(rank) = readme_rank(&name) {
            candidates.push((rank, entry.path()));
        }
    }
    candidates.sort_by_key(|(rank, _)| *rank);
    candidates.into_iter().next().map(|(_, path)| path)
}

fn readme_rank(name: &str) -> Option<usize> {
    const NAMES: [&str; 15] = [
        "readme.zh-cn.md",
        "readme_zh-cn.md",
        "readme.zh.md",
        "readme_zh.md",
        "readme-cn.md",
        "readme_cn.md",
        "readme.en.md",
        "readme_en.md",
        "readme-en.md",
        "readme.md",
        "readme.zh",
        "readme_zh",
        "readme_en",
        "readme",
        "readme.txt",
    ];
    NAMES.iter().position(|candidate| *candidate == name)
}

fn read_text_limited(path: &Path, limit: u64) -> Option<String> {
    if fs::symlink_metadata(path).ok()?.file_type().is_symlink() {
        return None;
    }
    let metadata = fs::metadata(path).ok()?;
    if !metadata.is_file() {
        return None;
    }
    let mut bytes = Vec::with_capacity(metadata.len().min(limit) as usize);
    File::open(path)
        .ok()?
        .take(limit)
        .read_to_end(&mut bytes)
        .ok()?;
    Some(String::from_utf8_lossy(&bytes).replace('\0', ""))
}

fn collect_skill_files(source_dir: &Path) -> Vec<PathBuf> {
    let mut result = Vec::new();
    let mut stack = vec![(source_dir.to_path_buf(), 0usize)];
    let mut visited = 0usize;
    while let Some((directory, depth)) = stack.pop() {
        if visited >= MAX_SCAN_ENTRIES
            || result.len() >= MAX_SOURCE_SKILLS
            || depth > MAX_SCAN_DEPTH
        {
            continue;
        }
        visited += 1;
        let Ok(entries) = fs::read_dir(&directory) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_file() && name.eq_ignore_ascii_case("SKILL.md") {
                result.push(entry.path());
            } else if file_type.is_dir() && !should_skip_dir(&name) {
                stack.push((entry.path(), depth + 1));
            }
        }
    }
    result.sort_by_key(|path| path.display().to_string().to_ascii_lowercase());
    result.truncate(MAX_SOURCE_SKILLS);
    result
}

fn should_skip_dir(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        ".git"
            | ".svn"
            | ".hg"
            | "node_modules"
            | "target"
            | "dist"
            | "build"
            | "vendor"
            | ".venv"
            | "venv"
            | "__pycache__"
    )
}

fn parse_frontmatter(raw: &str) -> Frontmatter {
    let mut result = Frontmatter::default();
    let mut lines = raw.lines();
    let Some(first) = lines.next() else {
        return result;
    };
    if first.trim_start_matches('\u{feff}').trim() != "---" {
        return result;
    }

    let mut current_key = String::new();
    let mut block_values: Vec<String> = Vec::new();
    for line in lines {
        if line.trim() == "---" {
            flush_frontmatter_block(&mut result, &current_key, &block_values);
            break;
        }
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let is_indented = line.starts_with(' ') || line.starts_with('\t');
        if !is_indented {
            flush_frontmatter_block(&mut result, &current_key, &block_values);
            current_key.clear();
            block_values.clear();
            if let Some((key, value)) = trimmed.split_once(':') {
                let normalized_key = key.trim().to_ascii_lowercase().replace(['-', ' '], "_");
                let value = clean_yaml_scalar(value);
                match normalized_key.as_str() {
                    "name" => result.name = value,
                    "description" | "summary" | "purpose" => {
                        if is_block_marker(&value) {
                            current_key = "description".to_string();
                        } else {
                            result.description = value;
                        }
                    }
                    "category" | "category_id" => result.category = value,
                    "usage" | "usage_guide" | "when_to_use" | "use_cases" => {
                        if is_block_marker(&value) {
                            current_key = "usage".to_string();
                        } else {
                            result.usage = value;
                        }
                    }
                    "tags" | "keywords" | "labels" => {
                        result.tags.extend(split_tag_values(&value));
                        current_key = "tags".to_string();
                    }
                    _ => {}
                }
            }
        } else if !current_key.is_empty() {
            block_values.push(trimmed.trim_start_matches("- ").to_string());
        }
    }
    result
}

fn flush_frontmatter_block(result: &mut Frontmatter, key: &str, values: &[String]) {
    if values.is_empty() {
        return;
    }
    match key {
        "description" => result.description = values.join(" "),
        "usage" => result.usage = values.join(" "),
        "tags" => {
            for value in values {
                result.tags.extend(split_tag_values(value));
            }
        }
        _ => {}
    }
}

fn clean_yaml_scalar(value: &str) -> String {
    value
        .trim()
        .trim_matches('"')
        .trim_matches('\'')
        .trim()
        .to_string()
}

fn is_block_marker(value: &str) -> bool {
    matches!(value, "|" | "|-" | "|+" | ">" | ">-" | ">+")
}

fn strip_frontmatter(raw: &str) -> String {
    let mut lines = raw.lines();
    let Some(first) = lines.next() else {
        return String::new();
    };
    if first.trim_start_matches('\u{feff}').trim() != "---" {
        return raw.to_string();
    }
    let mut ended = false;
    let mut output = Vec::new();
    for line in lines {
        if !ended {
            if line.trim() == "---" {
                ended = true;
            }
            continue;
        }
        output.push(line);
    }
    output.join("\n")
}

fn first_meaningful_paragraph(raw: &str) -> String {
    if raw.trim().is_empty() {
        return String::new();
    }
    let body = strip_frontmatter(raw);
    let mut paragraph = Vec::new();
    let mut in_code = false;
    for line in body.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_code = !in_code;
            continue;
        }
        if in_code {
            continue;
        }
        if trimmed.is_empty() {
            if !paragraph.is_empty() {
                break;
            }
            continue;
        }
        if should_skip_markdown_line(trimmed) {
            continue;
        }
        let text = markdown_to_plain(trimmed);
        if text.chars().count() < 8 {
            continue;
        }
        paragraph.push(text);
        if paragraph.join(" ").chars().count() >= 240 {
            break;
        }
    }
    clean_summary(&paragraph.join(" "))
}

fn should_skip_markdown_line(line: &str) -> bool {
    let lower = line.to_ascii_lowercase();
    line.starts_with('#')
        || line.starts_with("![")
        || line.starts_with("[![")
        || line.starts_with('<')
        || line.starts_with('|')
        || line == "---"
        || lower.starts_with("name:")
        || lower.starts_with("description:")
        || lower.starts_with("tags:")
        || lower.starts_with("keywords:")
        || lower.starts_with("table of contents")
        || line.starts_with("目录")
}

fn extract_usage_section(raw: &str) -> String {
    if raw.trim().is_empty() {
        return String::new();
    }
    let body = strip_frontmatter(raw);
    let lines: Vec<&str> = body.lines().collect();
    let mut start = None;
    let mut heading_level = 7usize;
    for (index, line) in lines.iter().enumerate() {
        let trimmed = line.trim();
        let level = trimmed.chars().take_while(|ch| *ch == '#').count();
        if level == 0 {
            continue;
        }
        let heading = trimmed[level..].trim().to_lowercase();
        if is_usage_heading(&heading) {
            start = Some(index + 1);
            heading_level = level;
            break;
        }
    }
    let Some(start) = start else {
        return String::new();
    };
    let mut values = Vec::new();
    let mut in_code = false;
    for line in lines.iter().skip(start).take(40) {
        let trimmed = line.trim();
        let level = trimmed.chars().take_while(|ch| *ch == '#').count();
        if level > 0 && level <= heading_level {
            break;
        }
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_code = !in_code;
            continue;
        }
        if trimmed.is_empty() || trimmed.starts_with('<') {
            continue;
        }
        let text = if in_code {
            trimmed.to_string()
        } else {
            markdown_to_plain(trimmed.trim_start_matches("- ").trim_start_matches("* "))
        };
        if !text.is_empty() {
            values.push(text);
        }
        if values.join(" ").chars().count() >= 900 {
            break;
        }
    }
    clean_usage(&values.join(" "))
}

fn is_usage_heading(heading: &str) -> bool {
    const KEYS: [&str; 15] = [
        "usage",
        "how to use",
        "when to use",
        "use cases",
        "getting started",
        "quick start",
        "instructions",
        "使用方法",
        "使用说明",
        "如何使用",
        "适用场景",
        "何时使用",
        "调用方法",
        "快速开始",
        "典型场景",
    ];
    KEYS.iter().any(|key| heading.contains(key))
}

fn extract_explicit_tags(raw: &str) -> Vec<String> {
    let mut tags = Vec::new();
    let lines: Vec<&str> = raw.lines().collect();
    let mut in_fenced_code = false;
    for (index, line) in lines.iter().enumerate() {
        let trimmed = line.trim();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_fenced_code = !in_fenced_code;
            continue;
        }
        if in_fenced_code {
            continue;
        }
        let lower = trimmed.to_ascii_lowercase();
        for prefix in [
            "tags:",
            "keywords:",
            "labels:",
            "标签:",
            "标签：",
            "关键词:",
            "关键词：",
        ] {
            if lower.starts_with(prefix) || trimmed.starts_with(prefix) {
                let value = trimmed
                    .split_once(':')
                    .or_else(|| trimmed.split_once('：'))
                    .map(|(_, value)| value)
                    .unwrap_or_default();
                tags.extend(split_tag_values(value));
            }
        }
        let level = trimmed.chars().take_while(|ch| *ch == '#').count();
        if level > 0 {
            let heading = trimmed[level..].trim().to_ascii_lowercase();
            if matches!(
                heading.as_str(),
                "tags" | "keywords" | "labels" | "标签" | "关键词"
            ) {
                for value in lines.iter().skip(index + 1).take(16) {
                    let value = value.trim();
                    if value.starts_with('#') || value.is_empty() {
                        break;
                    }
                    tags.extend(split_tag_values(
                        value.trim_start_matches("- ").trim_start_matches("* "),
                    ));
                }
            }
        }
    }
    tags
}

fn split_tag_values(value: &str) -> Vec<String> {
    value
        .trim()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .split([',', '，', ';', '；', '|', '、'])
        .map(|tag| {
            tag.trim()
                .trim_matches(['[', ']', '(', ')', '{', '}'])
                .trim()
                .trim_matches('"')
                .trim_matches('\'')
                .trim_start_matches('#')
                .trim()
                .to_string()
        })
        .filter(|tag| is_valid_tag(tag))
        .collect()
}

fn normalize_tags(tags: Vec<String>) -> Vec<String> {
    let mut output = Vec::new();
    let mut seen = HashSet::new();
    for tag in tags {
        let tag = clean_label(&tag, 40);
        if !is_valid_tag(&tag) {
            continue;
        }
        let key = tag.to_lowercase();
        if seen.insert(key) {
            output.push(tag);
        }
        if output.len() >= MAX_TAGS {
            break;
        }
    }
    output
}

fn is_valid_tag(tag: &str) -> bool {
    let length = tag.chars().count();
    length > 0
        && length <= 40
        && !tag.contains("://")
        && !tag.contains('\n')
        && tag.split_whitespace().count() <= 5
}

fn add_semantic_tags(text: &str, tags: &mut Vec<String>) {
    let normalized = text.to_lowercase();
    const RULES: [(&str, &str); 20] = [
        ("zotero", "Zotero"),
        ("latex", "LaTeX"),
        ("python", "Python"),
        ("react", "React"),
        ("rust", "Rust"),
        ("tauri", "Tauri"),
        ("claude", "Claude"),
        ("codex", "Codex"),
        ("single-cell", "单细胞"),
        ("single cell", "单细胞"),
        ("单细胞", "单细胞"),
        ("spatial transcript", "空间组学"),
        ("空间组学", "空间组学"),
        ("citation", "引用核验"),
        ("引用", "引用核验"),
        ("visualization", "数据可视化"),
        ("可视化", "数据可视化"),
        ("security", "安全"),
        ("安全", "安全"),
        ("prompt", "Prompt"),
    ];
    for (needle, tag) in RULES {
        if normalized.contains(needle) {
            tags.push(tag.to_string());
        }
    }
}

fn infer_category(text: &str) -> String {
    let normalized = text.to_lowercase();
    const RULES: [(&str, &[&str]); 17] = [
        (
            "临床医学",
            &["clinical", "patient", "diagnosis", "临床", "患者", "医学"],
        ),
        (
            "生命科学",
            &[
                "biology",
                "bioinformatics",
                "protein",
                "genome",
                "single-cell",
                "生物",
                "蛋白",
                "基因",
                "单细胞",
            ],
        ),
        (
            "文献研究",
            &[
                "literature",
                "citation",
                "references",
                "zotero",
                "文献",
                "引用",
                "检索",
            ],
        ),
        (
            "科研图表",
            &[
                "scientific figure",
                "diagram",
                "plot",
                "chart",
                "科研图",
                "论文图",
                "图表",
            ],
        ),
        (
            "论文科研",
            &[
                "academic",
                "research",
                "paper",
                "manuscript",
                "论文",
                "科研",
                "学术",
            ],
        ),
        (
            "界面设计",
            &[
                "ui",
                "ux",
                "interface",
                "design system",
                "界面",
                "交互",
                "设计系统",
            ],
        ),
        (
            "安全审计",
            &["security", "audit", "vulnerability", "安全", "审计", "漏洞"],
        ),
        (
            "数据分析",
            &[
                "data analysis",
                "statistics",
                "analytics",
                "数据分析",
                "统计",
            ],
        ),
        (
            "图像生成",
            &["image generation", "diffusion", "绘图", "图像生成", "生图"],
        ),
        (
            "知识检索",
            &[
                "search",
                "retrieval",
                "knowledge base",
                "搜索",
                "知识库",
                "检索",
            ],
        ),
        (
            "汇报演示",
            &[
                "presentation",
                "slides",
                "powerpoint",
                "ppt",
                "演示",
                "汇报",
            ],
        ),
        ("提示词润色", &["prompt", "提示词", "润色", "改写"]),
        (
            "金融经济",
            &["finance", "economics", "stock", "金融", "经济", "股票"],
        ),
        ("文档工具", &["document", "pdf", "word", "文档", "表格"]),
        (
            "浏览器自动化",
            &["browser", "playwright", "selenium", "浏览器", "网页自动化"],
        ),
        (
            "工程开发",
            &[
                "coding",
                "developer",
                "software",
                "编程",
                "代码",
                "工程开发",
            ],
        ),
        (
            "智能体工具",
            &["agent", "mcp", "workflow", "智能体", "工作流"],
        ),
    ];

    let mut best = ("", 0usize);
    for (category, keywords) in RULES {
        let score = keywords
            .iter()
            .map(|keyword| keyword_occurrences(&normalized, keyword))
            .sum::<usize>();
        if score > best.1 {
            best = (category, score);
        }
    }
    if best.1 == 0 {
        String::new()
    } else {
        best.0.to_string()
    }
}

fn keyword_occurrences(text: &str, keyword: &str) -> usize {
    if keyword.is_ascii()
        && keyword
            .chars()
            .all(|character| character.is_ascii_alphanumeric())
        && keyword.len() <= 3
    {
        text.split(|character: char| !character.is_ascii_alphanumeric())
            .filter(|token| *token == keyword)
            .count()
    } else {
        text.matches(keyword).count()
    }
}

fn is_meaningful_category(value: &str) -> bool {
    let trimmed = value.trim();
    !trimmed.is_empty() && !trimmed.eq_ignore_ascii_case("auto")
}

fn first_nonempty(values: &[String]) -> String {
    values
        .iter()
        .find(|value| !value.trim().is_empty())
        .cloned()
        .unwrap_or_default()
}

fn clean_summary(value: &str) -> String {
    let value = value
        .replace("[ROUTER-HUB]", "")
        .replace("[CHILD-SKILL]", "")
        .replace("[CONFLICT-DISPATCHER]", "");
    truncate_chars(&compact_whitespace(&markdown_to_plain(&value)), 600)
}

fn clean_usage(value: &str) -> String {
    truncate_chars(&compact_whitespace(&markdown_to_plain(value)), 900)
}

fn clean_label(value: &str, limit: usize) -> String {
    truncate_chars(
        value
            .trim()
            .trim_matches('"')
            .trim_matches('\'')
            .trim_matches('#')
            .trim(),
        limit,
    )
}

fn compact_whitespace(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn markdown_to_plain(value: &str) -> String {
    let mut output = value
        .trim()
        .trim_start_matches("- ")
        .trim_start_matches("* ")
        .trim_start_matches("> ")
        .replace("**", "")
        .replace("__", "")
        .replace('`', "");
    while let Some(open) = output.find('[') {
        let Some(close_offset) = output[open + 1..].find("](") else {
            break;
        };
        let close = open + 1 + close_offset;
        let Some(end_offset) = output[close + 2..].find(')') else {
            break;
        };
        let end = close + 2 + end_offset;
        let label = output[open + 1..close].to_string();
        output.replace_range(open..=end, &label);
    }
    output
}

fn trim_terminal_punctuation(value: &str) -> &str {
    value.trim_end_matches(['。', '.', '！', '!', '？', '?', ';', '；'])
}

fn truncate_chars(value: &str, limit: usize) -> String {
    if value.chars().count() <= limit {
        value.to_string()
    } else {
        value.chars().take(limit).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("skillhub-metadata-{label}-{nonce}"));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn analyzes_chinese_readme_and_skill_usage() {
        let root = temp_dir("zh");
        fs::write(
            root.join("README.zh.md"),
            "# 空间组学科研工具\n\n用于单细胞与空间转录组分析，辅助科研论文写作。\n\n## 适用场景\n\n- 聚类空间表达数据\n- 生成论文结果说明\n\n标签：空间组学，生物信息\n",
        )
        .unwrap();
        let skill = root.join("skills").join("spatial-analysis");
        fs::create_dir_all(&skill).unwrap();
        fs::write(
            skill.join("SKILL.md"),
            "---\nname: spatial-analysis\ndescription: 分析空间转录组数据并解释细胞聚类。\ntags: [spatial-omics, custom-lab-tag]\n---\n\n## 使用方法\n\n提供表达矩阵和研究问题后调用。\n",
        )
        .unwrap();

        let source = analyze_source(&root);
        let child = analyze_skill(&skill);
        assert!(source.summary.contains("空间转录组"));
        assert!(source.usage_guide.contains("聚类空间表达数据"));
        assert_eq!(source.category, "生命科学");
        assert!(child.usage_guide.contains("表达矩阵"));
        assert!(child.tags.contains(&"custom-lab-tag".to_string()));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn analyzes_english_readme_frontmatter_and_arbitrary_tags() {
        let root = temp_dir("en");
        fs::write(
            root.join("README_EN.md"),
            "# Citation Lab\n\nA research workflow for literature retrieval and citation verification.\n\n## When to use\n\nUse it before submitting a manuscript to verify references.\n",
        )
        .unwrap();
        fs::write(
            root.join("SKILL.md"),
            "---\nname: citation-lab\ndescription: Verify scholarly citations against reliable sources.\nkeywords:\n  - evidence-graph\n  - DOI-check\ncategory: Evidence Engineering\n---\n",
        )
        .unwrap();

        let source = analyze_source(&root);
        let skill = analyze_skill(&root);
        assert!(source.summary.contains("literature retrieval"));
        assert!(source.usage_guide.contains("submitting a manuscript"));
        assert_eq!(skill.category, "Evidence Engineering");
        assert!(skill.tags.contains(&"evidence-graph".to_string()));
        assert!(skill.tags.contains(&"DOI-check".to_string()));
        assert!(skill.origin.contains("skill-frontmatter"));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn ignores_tag_like_labels_inside_fenced_code() {
        let root = temp_dir("fenced-code-tags");
        fs::write(
            root.join("SKILL.md"),
            "---\nname: chart-designer\ntags: [visualization, custom-chart]\n---\n\n```js\nconst chart = {\n  labels: ['Sep', 'Oct', 'Nov', 'Dec'],\n};\n```\n",
        )
        .unwrap();

        let skill = analyze_skill(&root);
        assert!(skill.tags.contains(&"visualization".to_string()));
        assert!(skill.tags.contains(&"custom-chart".to_string()));
        for month in ["Sep", "Oct", "Nov", "Dec"] {
            assert!(!skill.tags.iter().any(|tag| tag == month));
        }

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn reads_git_origin_without_executing_repository_code() {
        let root = temp_dir("git-origin");
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::write(
            root.join(".git").join("config"),
            "[core]\n\trepositoryformatversion = 0\n[remote \"origin\"]\n\turl = https://github.com/example/offline-metadata.git\n",
        )
        .unwrap();
        fs::write(
            root.join("README.md"),
            "# Offline Metadata\n\nA local-first Skill metadata analyzer for agent workflows.\n",
        )
        .unwrap();

        let source = analyze_source(&root);
        assert_eq!(
            source.git_origin,
            "https://github.com/example/offline-metadata.git"
        );
        assert!(source.origin.contains("git"));
        assert!(source.tags.contains(&"GitHub".to_string()));

        let _ = fs::remove_dir_all(root);
    }
}
