//! Real-directory skill entries for clients whose scanners skip directory links.
//! Only our intact generated manifests are replaced or removed; source skills
//! and client configuration are never changed.

use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};

const MARKER: &str = "\n<!-- AI SkillHub shared-skill v1 sha256:";
const MAX_MANIFEST: u64 = 2 * 1024 * 1024;

enum Change {
    Write(PathBuf, String),
    Remove(PathBuf),
}

/// A same-name entry that SkillHub did not create (or that the user edited).
/// It is left untouched and reported instead of failing the whole folder.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SharedConflict {
    pub name: String,
    pub path: PathBuf,
    /// "personal-folder" | "external-link" | "not-a-folder"
    pub kind: &'static str,
    /// The existing SKILL.md bytes hash equals the original's.
    pub same_content: bool,
}

/// Per-entry outcome of one shared-folder sync. Entries that cannot be written
/// are skipped with a plain reason; they never block the other entries.
#[derive(Clone, Debug, Default)]
pub struct SharedSyncReport {
    pub written: Vec<String>,
    pub unchanged: Vec<String>,
    pub removed: Vec<String>,
    pub conflicts: Vec<SharedConflict>,
    /// (name, reason) for entries whose original manifest is unreadable.
    pub skipped: Vec<(String, String)>,
}

/// Entries contain a safe directory name and the original absolute SKILL.md path.
pub fn sync(root: &Path, entries: &[(String, PathBuf)]) -> Result<SharedSyncReport, String> {
    let (changes, mut report) = plan(root, entries)?;
    fs::create_dir_all(root).map_err(|e| e.to_string())?;
    for change in &changes {
        match change {
            Change::Write(path, _) => report.written.push(entry_name(path)),
            Change::Remove(path) => report.removed.push(entry_name(path)),
        }
    }
    apply_changes(changes)?;
    Ok(report)
}

fn entry_name(manifest: &Path) -> String {
    manifest
        .parent()
        .and_then(Path::file_name)
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_default()
}

fn apply_changes(changes: Vec<Change>) -> Result<(), String> {
    for change in changes {
        match change {
            Change::Write(path, content) => {
                let parent = path.parent().ok_or("Missing skill directory")?;
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                check_directory(parent)?;
                check_managed_manifest(&path)?;
                let temporary = parent.join(format!(".skillhub-{}.tmp", uuid::Uuid::new_v4()));
                let result = (|| -> std::io::Result<()> {
                    let mut file = OpenOptions::new()
                        .write(true)
                        .create_new(true)
                        .open(&temporary)?;
                    file.write_all(content.as_bytes())?;
                    file.sync_all()?;
                    drop(file);
                    fs::rename(&temporary, &path)
                })();
                if result.is_err() {
                    let _ = fs::remove_file(&temporary);
                }
                result.map_err(|e| e.to_string())?;
            }
            Change::Remove(path) => {
                check_directory(path.parent().ok_or("Missing skill directory")?)?;
                check_managed_manifest(&path)?;
                fs::remove_file(&path).map_err(|e| e.to_string())?;
                // Preserve any personal files in the directory.
                let _ = fs::remove_dir(path.parent().ok_or("Missing skill directory")?);
            }
        }
    }
    Ok(())
}

/// False also covers an absent compatibility catalog or changed upstream metadata.
pub fn verify(root: &Path, entries: &[(String, PathBuf)]) -> bool {
    root.is_dir() && plan(root, entries).is_ok_and(|(changes, _)| changes.is_empty())
}

// Shared host directories may also contain skills installed outside SkillHub.
// Plan before writing, and require exact ownership evidence for every mutation.
enum SharedChange {
    Manifest(Change),
    Migrate(PathBuf, String),
    RemoveLink(PathBuf),
}

pub fn sync_shared(
    root: &Path,
    entries: &[(String, PathBuf)],
    managed_source_root: &Path,
) -> Result<SharedSyncReport, String> {
    let (changes, mut report) = plan_shared(root, entries, managed_source_root)?;
    fs::create_dir_all(root).map_err(|e| e.to_string())?;
    for change in changes {
        check_directory(root)?;
        match change {
            SharedChange::Manifest(change) => {
                match &change {
                    Change::Write(path, _) => report.written.push(entry_name(path)),
                    Change::Remove(path) => report.removed.push(entry_name(path)),
                }
                apply_changes(vec![change])?
            }
            SharedChange::Migrate(path, content) => {
                migrate_link(&path, &content, managed_source_root, |from, to| {
                    fs::rename(from, to)
                })?;
                report.written.push(
                    path.file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .to_string(),
                );
            }
            SharedChange::RemoveLink(path) => {
                if !managed_link(&path, managed_source_root) {
                    return Err(format!(
                        "Changed shared Skill link preserved: {}",
                        path.display()
                    ));
                }
                remove_directory_link(&path).map_err(|e| e.to_string())?;
                report.removed.push(
                    path.file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .to_string(),
                );
            }
        }
    }
    Ok(report)
}

/// True when nothing is left to write. Same-name personal entries are conflicts,
/// not pending changes, so they do not make the folder unhealthy.
pub fn verify_shared(
    root: &Path,
    entries: &[(String, PathBuf)],
    managed_source_root: &Path,
) -> bool {
    root.is_dir()
        && plan_shared(root, entries, managed_source_root).is_ok_and(|(plan, _)| plan.is_empty())
}

fn same_manifest_bytes(entry: &Path, original_manifest: &Path) -> bool {
    match (
        read_manifest(&entry.join("SKILL.md")),
        read_manifest(original_manifest),
    ) {
        (Ok(left), Ok(right)) => {
            Sha256::digest(left.as_bytes()) == Sha256::digest(right.as_bytes())
        }
        _ => false,
    }
}

/// `path` is an entry directory, not its SKILL.md. Links never count as entries.
pub fn is_managed_entry(path: &Path) -> bool {
    path.is_dir()
        && !is_link(path).unwrap_or(true)
        && check_managed_manifest(&path.join("SKILL.md")).is_ok_and(|content| content.is_some())
}

fn shared_manifest(path: &Path) -> Result<Option<String>, String> {
    let manifest = path.join("SKILL.md");
    if !manifest.is_file() || is_link(&manifest).unwrap_or(true) {
        return Ok(None);
    }
    // Unknown personal files are left alone, including ones we cannot read.
    let Ok(content) = read_manifest(&manifest) else {
        return Ok(None);
    };
    if !content.contains(MARKER) {
        return Ok(None);
    }
    check_managed_manifest(&manifest)
}

fn valid_entry_name(name: &str) -> bool {
    let mut components = Path::new(name).components();
    matches!(components.next(), Some(Component::Normal(_)))
        && components.next().is_none()
        && !name.ends_with(['.', ' '])
        && !name
            .chars()
            .any(|c| c.is_control() || "<>:\"/\\|?*".contains(c))
}

fn plan_shared(
    root: &Path,
    entries: &[(String, PathBuf)],
    managed_source_root: &Path,
) -> Result<(Vec<SharedChange>, SharedSyncReport), String> {
    if !root.is_absolute()
        || !managed_source_root.is_absolute()
        || paths_equal(root, managed_source_root)
    {
        return Err("Shared and source Skills directories must be distinct absolute paths".into());
    }
    check_directory(root)?;
    let mut names = BTreeSet::new();
    let mut changes = Vec::new();
    let mut report = SharedSyncReport::default();
    for (name, source) in entries {
        // A bad name is a policy error: fail closed before anything is written.
        if !valid_entry_name(name) || !names.insert(name.to_lowercase()) {
            return Err("Invalid or duplicate shared Skill name".into());
        }
        let path = root.join(name);
        let content = match wrapper(name, source) {
            Ok(content) => content,
            Err(reason) => {
                // One unreadable original must not block every other entry.
                report.skipped.push((name.clone(), reason));
                continue;
            }
        };
        match fs::symlink_metadata(&path) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                changes.push(SharedChange::Manifest(Change::Write(
                    path.join("SKILL.md"),
                    content,
                )));
            }
            Ok(_) if managed_link(&path, managed_source_root) => {
                changes.push(SharedChange::Migrate(path, content));
            }
            Ok(metadata) if metadata.is_dir() && !is_link(&path)? => {
                // Only our intact sealed manifest may be replaced. A personal
                // folder or an edited copy is reported and left untouched.
                match shared_manifest(&path) {
                    Ok(Some(existing)) => {
                        if existing != content {
                            changes.push(SharedChange::Manifest(Change::Write(
                                path.join("SKILL.md"),
                                content,
                            )));
                        } else {
                            report.unchanged.push(name.clone());
                        }
                    }
                    _ => report.conflicts.push(SharedConflict {
                        name: name.clone(),
                        same_content: same_manifest_bytes(&path, source),
                        path,
                        kind: "personal-folder",
                    }),
                }
            }
            Ok(metadata) => report.conflicts.push(SharedConflict {
                name: name.clone(),
                same_content: metadata.is_dir() && same_manifest_bytes(&path, source),
                kind: if is_link(&path).unwrap_or(false) {
                    "external-link"
                } else if metadata.is_dir() {
                    "personal-folder"
                } else {
                    "not-a-folder"
                },
                path,
            }),
            Err(error) => return Err(error.to_string()),
        }
    }
    if root.exists() {
        for entry in fs::read_dir(root).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path();
            if names.contains(&entry.file_name().to_string_lossy().to_lowercase()) {
                continue;
            }
            if managed_link(&path, managed_source_root) {
                changes.push(SharedChange::RemoveLink(path));
            } else if entry.file_type().map_err(|e| e.to_string())?.is_dir()
                && !is_link(&path)?
                // An edited copy of our manifest is no longer ours: keep it.
                && matches!(shared_manifest(&path), Ok(Some(_)))
            {
                changes.push(SharedChange::Manifest(Change::Remove(
                    path.join("SKILL.md"),
                )));
            }
        }
    }
    Ok((changes, report))
}

fn paths_equal(left: &Path, right: &Path) -> bool {
    fn normalize(path: &Path) -> String {
        let text = path.to_string_lossy().replace('\\', "/");
        let text = text
            .strip_prefix("//?/")
            .or_else(|| text.strip_prefix("/??/"))
            .unwrap_or(&text)
            .trim_end_matches('/');
        if cfg!(windows) {
            text.to_lowercase()
        } else {
            text.to_string()
        }
    }
    normalize(left) == normalize(right)
}

fn managed_link(path: &Path, managed_source_root: &Path) -> bool {
    if !is_link(path).unwrap_or(false) {
        return false;
    }
    let Some(name) = path.file_name() else {
        return false;
    };
    let Ok(target) = fs::read_link(path) else {
        return false;
    };
    let target = if target.is_absolute() {
        target
    } else {
        let Some(parent) = path.parent() else {
            return false;
        };
        parent.join(target)
    };
    paths_equal(&target, &managed_source_root.join(name))
}

fn remove_directory_link(path: &Path) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        fs::remove_dir(path)
    }
    #[cfg(not(windows))]
    {
        fs::remove_file(path)
    }
}

fn migrate_link(
    path: &Path,
    content: &str,
    managed_source_root: &Path,
    publish: impl FnOnce(&Path, &Path) -> std::io::Result<()>,
) -> Result<(), String> {
    if !managed_link(path, managed_source_root) {
        return Err("Shared Skill link ownership changed".into());
    }
    let parent = path.parent().ok_or("Shared Skill parent missing")?;
    let nonce = uuid::Uuid::new_v4();
    let stage = parent.join(format!(".skillhub-stage-{nonce}"));
    let backup = parent.join(format!(".skillhub-link-backup-{nonce}"));
    fs::create_dir(&stage).map_err(|e| e.to_string())?;
    let prepared = (|| -> std::io::Result<()> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(stage.join("SKILL.md"))?;
        file.write_all(content.as_bytes())?;
        file.sync_all()
    })();
    if let Err(error) = prepared {
        let _ = fs::remove_file(stage.join("SKILL.md"));
        let _ = fs::remove_dir(&stage);
        return Err(error.to_string());
    }
    if !managed_link(path, managed_source_root) {
        let _ = fs::remove_file(stage.join("SKILL.md"));
        let _ = fs::remove_dir(&stage);
        return Err("Shared Skill link ownership changed before migration".into());
    }
    if let Err(error) = fs::rename(path, &backup) {
        let _ = fs::remove_file(stage.join("SKILL.md"));
        let _ = fs::remove_dir(&stage);
        return Err(error.to_string());
    }
    if let Err(error) = publish(&stage, path) {
        let restored = fs::rename(&backup, path);
        let _ = fs::remove_file(stage.join("SKILL.md"));
        let _ = fs::remove_dir(&stage);
        return match restored {
            Ok(()) => Err(format!("Shared Skill migration failed; original link restored: {error}")),
            Err(restore_error) => Err(format!("Shared Skill migration failed: {error}; recoverable link retained at {} ({restore_error})", backup.display())),
        };
    }
    // Remove only the renamed link, never recurse into its author/source target.
    remove_directory_link(&backup).map_err(|error| {
        format!(
            "Shared Skill migrated; old link remains at {}: {error}",
            backup.display()
        )
    })
}

fn plan(
    root: &Path,
    entries: &[(String, PathBuf)],
) -> Result<(Vec<Change>, SharedSyncReport), String> {
    if !root.is_absolute() {
        return Err("Shared Skills directory must be absolute".into());
    }
    check_directory(root)?;
    let mut names = BTreeSet::new();
    let mut changes = Vec::new();
    let mut report = SharedSyncReport::default();
    for (name, source) in entries {
        if !valid_entry_name(name) || !names.insert(name.to_lowercase()) {
            return Err("Invalid or duplicate shared Skill name".into());
        }
        let directory = root.join(name);
        check_directory(&directory)?;
        let target = directory.join("SKILL.md");
        let existing = check_managed_manifest(&target)?;
        let content = match wrapper(name, source) {
            Ok(content) => content,
            Err(reason) => {
                report.skipped.push((name.clone(), reason));
                continue;
            }
        };
        if existing.as_deref() != Some(&content) {
            changes.push(Change::Write(target, content));
        } else {
            report.unchanged.push(name.clone());
        }
    }
    if root.exists() {
        for entry in fs::read_dir(root).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path();
            if names.contains(&entry.file_name().to_string_lossy().to_lowercase())
                || !entry.file_type().map_err(|e| e.to_string())?.is_dir()
                || is_link(&path)?
            {
                continue;
            }
            let manifest = path.join("SKILL.md");
            if check_managed_manifest(&manifest)?.is_some() {
                changes.push(Change::Remove(manifest));
            }
        }
    }
    Ok((changes, report))
}

fn check_directory(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() && !is_link(path)? => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        _ => Err(format!(
            "Shared Skills path is not a real directory: {}",
            path.display()
        )),
    }
}

fn is_link(path: &Path) -> Result<bool, String> {
    let metadata = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        Ok(metadata.file_type().is_symlink() || metadata.file_attributes() & 0x400 != 0)
    }
    #[cfg(not(windows))]
    Ok(metadata.file_type().is_symlink())
}

fn read_manifest(path: &Path) -> Result<String, String> {
    let mut bytes = Vec::new();
    File::open(path)
        .map_err(|e| e.to_string())?
        .take(MAX_MANIFEST + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_MANIFEST {
        return Err("Skill manifest exceeds 2 MiB".into());
    }
    String::from_utf8(bytes).map_err(|e| e.to_string())
}

fn seal(body: &str) -> String {
    format!("{body}{MARKER}{:x} -->\n", Sha256::digest(body.as_bytes()))
}

fn check_managed_manifest(path: &Path) -> Result<Option<String>, String> {
    match fs::symlink_metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Ok(metadata) if metadata.is_file() && !is_link(path)? => {}
        _ => {
            return Err(format!(
                "Unmanaged Skill entry preserved: {}",
                path.display()
            ))
        }
    }
    let content = read_manifest(path)?;
    if content
        .rfind(MARKER)
        .is_some_and(|offset| seal(&content[..offset]) == content)
    {
        Ok(Some(content))
    } else {
        Err(format!(
            "Modified or unmanaged Skill preserved: {}",
            path.display()
        ))
    }
}

fn wrapper(fallback_name: &str, source: &Path) -> Result<String, String> {
    if !source.is_absolute() || source.file_name().is_none_or(|name| name != "SKILL.md") {
        return Err("Original Skill must be an absolute SKILL.md path".into());
    }
    let original = read_manifest(source)
        .map_err(|error| format!("{fallback_name}: SKILL.md 无法读取（{error}）"))?;
    let name = field(&original, "name")
        .or_else(|| lenient_field(&original, "name"))
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| fallback_name.to_string());
    // Accept everything the PowerShell and Rust delivery validators accept
    // (`[Beta] …`, Windows paths in quotes, indented keys, trailing comments).
    // A strict YAML failure here used to block delivery to every AI tool.
    let description = field(&original, "description")
        .filter(|s| !s.trim().is_empty())
        .or_else(|| lenient_field(&original, "description"))
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| format!("Skill {name}"));
    let source_path = source.to_string_lossy().replace('\\', "/");
    let parent = source
        .parent()
        .ok_or("Original Skill directory missing")?
        .to_string_lossy()
        .replace('\\', "/");
    // JSON strings are valid YAML quoted scalars, including colons and newlines.
    let body = format!(
        "---\nname: {}\ndescription: {}\n---\n\nRead the original skill instructions before performing this skill: [{}](<{}>).\nResolve its relative files and scripts from the original skill directory: `{}`.\nFollow that original SKILL.md; this entry only makes it discoverable.\n\n<!-- source-sha256:{:x} -->\n",
        serde_json::to_string(&name).map_err(|e| e.to_string())?,
        serde_json::to_string(&description).map_err(|e| e.to_string())?,
        name, source_path, parent, Sha256::digest(original.as_bytes())
    );
    Ok(seal(&body))
}

fn field(text: &str, key: &str) -> Option<String> {
    let mut lines = text.trim_start_matches('\u{feff}').lines();
    if lines.next()?.trim() != "---" {
        return None;
    }
    let mut lines = lines.take_while(|line| line.trim() != "---").peekable();
    while let Some(line) = lines.next() {
        let Some(raw) = line.strip_prefix(&format!("{key}:")) else {
            continue;
        };
        let raw = raw.trim();
        if raw.starts_with('"') {
            return serde_json::from_str(raw).ok();
        }
        if raw.starts_with('\'') && raw.ends_with('\'') && raw.len() >= 2 {
            return Some(raw[1..raw.len() - 1].replace("''", "'"));
        }
        if raw.starts_with(['|', '>']) || raw.is_empty() {
            let mut parts = Vec::new();
            while lines
                .peek()
                .is_some_and(|line| line.starts_with(char::is_whitespace) || line.is_empty())
            {
                parts.push(lines.next()?.trim());
            }
            return Some(parts.join(" "));
        }
        return (!raw.starts_with(['&', '*', '!', '[', '{'])).then(|| raw.to_string());
    }
    None
}

/// Forgiving frontmatter read used only when the strict parser fails: the
/// first `key:` line (indentation allowed), quotes trimmed, plus indented
/// continuation lines, with a trailing ` # comment` removed from plain values.
fn lenient_field(text: &str, key: &str) -> Option<String> {
    let mut lines = text.trim_start_matches('\u{feff}').lines();
    if lines.next()?.trim() != "---" {
        return None;
    }
    let frontmatter = lines
        .take_while(|line| line.trim() != "---")
        .take(256)
        .collect::<Vec<_>>();
    let prefix = format!("{key}:");
    let (index, raw) = frontmatter.iter().enumerate().find_map(|(index, line)| {
        line.trim_start()
            .strip_prefix(&prefix)
            .map(|raw| (index, raw.trim()))
    })?;
    let indent = frontmatter[index].len() - frontmatter[index].trim_start().len();
    let continuation = frontmatter[index + 1..]
        .iter()
        .take_while(|line| line.trim().is_empty() || line.len() - line.trim_start().len() > indent)
        .map(|line| line.trim())
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>();
    let mut value = if raw.is_empty() || raw.starts_with(['|', '>']) {
        continuation.join(" ")
    } else if let Some(quote) = raw.chars().next().filter(|c| *c == '"' || *c == '\'') {
        let inner = &raw[1..];
        match inner.find(quote) {
            Some(end) => inner[..end].to_string(),
            None => {
                let mut parts = vec![inner.to_string()];
                parts.extend(continuation.iter().map(|line| line.to_string()));
                parts.join(" ").trim_end_matches(quote).to_string()
            }
        }
    } else {
        let plain = raw.split(" #").next().unwrap_or(raw).trim().to_string();
        let mut parts = vec![plain];
        parts.extend(continuation.iter().map(|line| line.to_string()));
        parts.join(" ")
    };
    value = value.trim().to_string();
    (!value.is_empty()).then_some(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (PathBuf, PathBuf, Vec<(String, PathBuf)>) {
        let base = std::env::temp_dir().join(format!("skillhub-shared-{}", uuid::Uuid::new_v4()));
        let source = base.join("author skill").join("SKILL.md");
        fs::create_dir_all(source.parent().unwrap()).unwrap();
        fs::write(&source, "---\nname: author-skill\ndescription: >-\n  绘图: figures\n  and tables\nlicense: MIT\n---\nUse scripts/draw.py\n").unwrap();
        (
            base.clone(),
            base.join("shared-skills"),
            vec![("author-skill".into(), source)],
        )
    }

    #[test]
    fn real_catalog_refreshes_and_preserves_original_resources() {
        let (base, root, entries) = fixture();
        let original = fs::read(&entries[0].1).unwrap();
        assert!(!verify(&root, &entries));
        sync(&root, &entries).unwrap();
        assert!(verify(&root, &entries));
        let child = root.join("author-skill");
        assert!(!is_link(&child).unwrap());
        let content = fs::read_to_string(child.join("SKILL.md")).unwrap();
        assert!(content.contains("绘图: figures and tables"));
        assert!(content.contains(&entries[0].1.to_string_lossy().replace('\\', "/")));
        assert!(!content.contains("license:"));
        assert_eq!(fs::read(&entries[0].1).unwrap(), original);
        fs::write(
            &entries[0].1,
            String::from_utf8(original)
                .unwrap()
                .replace("figures", "charts"),
        )
        .unwrap();
        assert!(!verify(&root, &entries));
        sync(&root, &entries).unwrap();
        assert!(verify(&root, &entries));
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn edits_and_unmanaged_collisions_are_preserved_before_any_write() {
        let (base, root, entries) = fixture();
        sync(&root, &entries).unwrap();
        let manifest = root.join("author-skill/SKILL.md");
        let modified = format!("{}\nMy note", fs::read_to_string(&manifest).unwrap());
        fs::write(&manifest, &modified).unwrap();
        assert!(sync(&root, &entries).is_err());
        assert!(sync(&root, &[]).is_err());
        assert_eq!(fs::read_to_string(&manifest).unwrap(), modified);
        fs::write(&manifest, "personal skill").unwrap();
        assert!(sync(&root, &entries).is_err());
        assert_eq!(fs::read_to_string(&manifest).unwrap(), "personal skill");
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn disabling_removes_only_intact_generated_manifest_and_keeps_personal_files() {
        let (base, root, entries) = fixture();
        sync(&root, &entries).unwrap();
        let child = root.join("author-skill");
        fs::write(child.join("personal.txt"), "keep").unwrap();
        assert!(!verify(&root, &[]));
        sync(&root, &[]).unwrap();
        assert!(!child.join("SKILL.md").exists());
        assert_eq!(
            fs::read_to_string(child.join("personal.txt")).unwrap(),
            "keep"
        );
        assert!(verify(&root, &[]));
        assert!(sync(&root, &[("../outside".into(), entries[0].1.clone())]).is_err());
        fs::remove_dir_all(base).unwrap();
    }

    fn directory_link(link: &Path, target: &Path) {
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            let output = std::process::Command::new("cmd")
                .args(["/D", "/C", "mklink", "/J"])
                .arg(link)
                .arg(target)
                .creation_flags(0x08000000)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
        #[cfg(unix)]
        std::os::unix::fs::symlink(target, link).unwrap();
    }

    fn shared_fixture() -> (PathBuf, PathBuf, PathBuf, Vec<(String, PathBuf)>) {
        let (base, root, mut entries) = fixture();
        let source_root = base.join("active");
        let original = source_root.join(&entries[0].0).join("SKILL.md");
        fs::create_dir_all(original.parent().unwrap()).unwrap();
        fs::copy(&entries[0].1, &original).unwrap();
        entries[0].1 = original;
        fs::create_dir_all(&root).unwrap();
        (base, root, source_root, entries)
    }

    #[test]
    fn shared_catalog_migrates_only_its_exact_legacy_junction() {
        let (base, root, source_root, entries) = shared_fixture();
        let source = entries[0].1.parent().unwrap();
        let original = fs::read(&entries[0].1).unwrap();
        fs::write(source.join("resource.txt"), "author data").unwrap();
        let target = root.join(&entries[0].0);
        directory_link(&target, source);
        assert!(!verify_shared(&root, &entries, &source_root));
        sync_shared(&root, &entries, &source_root).unwrap();
        assert!(verify_shared(&root, &entries, &source_root));
        assert!(is_managed_entry(&target));
        assert!(!is_link(&target).unwrap());
        assert_eq!(fs::read(&entries[0].1).unwrap(), original);
        assert_eq!(
            fs::read_to_string(source.join("resource.txt")).unwrap(),
            "author data"
        );
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
        assert!(fs::read_to_string(target.join("SKILL.md"))
            .unwrap()
            .contains(&entries[0].1.to_string_lossy().replace('\\', "/")));
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn shared_catalog_preserves_unrelated_personal_skills_and_external_links() {
        let (base, root, source_root, entries) = shared_fixture();
        let personal = root.join("personal");
        let outside = base.join("outside");
        fs::create_dir_all(&personal).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(personal.join("SKILL.md"), "my own skill").unwrap();
        fs::write(outside.join("SKILL.md"), "external skill").unwrap();
        directory_link(&root.join("external"), &outside);
        sync_shared(&root, &entries, &source_root).unwrap();
        assert!(verify_shared(&root, &entries, &source_root));
        sync_shared(&root, &[], &source_root).unwrap();
        assert_eq!(
            fs::read_to_string(personal.join("SKILL.md")).unwrap(),
            "my own skill"
        );
        assert!(is_link(&root.join("external")).unwrap());
        assert_eq!(
            fs::read_to_string(outside.join("SKILL.md")).unwrap(),
            "external skill"
        );
        assert!(!root.join(&entries[0].0).exists());
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn shared_catalog_collision_is_preflighted_without_overwriting_personal_content() {
        let (base, root, source_root, entries) = shared_fixture();
        let target = root.join(&entries[0].0);
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("SKILL.md"), "my own skill").unwrap();
        let pending = vec![
            ("new-skill".into(), entries[0].1.clone()),
            entries[0].clone(),
        ];
        // v3.3: a same-name personal entry is a conflict for that entry only;
        // the other entries are still delivered and nothing personal is touched.
        let report = sync_shared(&root, &pending, &source_root).unwrap();
        assert!(root.join("new-skill").join("SKILL.md").is_file());
        assert_eq!(report.conflicts.len(), 1);
        assert_eq!(report.conflicts[0].kind, "personal-folder");
        assert!(!report.conflicts[0].same_content);
        assert_eq!(
            fs::read_to_string(target.join("SKILL.md")).unwrap(),
            "my own skill"
        );
        assert!(verify_shared(&root, &pending, &source_root));
        fs::remove_file(target.join("SKILL.md")).unwrap();
        fs::remove_dir(&target).unwrap();
        // Even another directory inside the managed root is not the exact target.
        let other = source_root.join("other");
        fs::create_dir_all(&other).unwrap();
        fs::write(other.join("SKILL.md"), "other original").unwrap();
        directory_link(&target, &other);
        let report = sync_shared(&root, &entries, &source_root).unwrap();
        assert_eq!(report.conflicts.len(), 1);
        assert_eq!(report.conflicts[0].kind, "external-link");
        assert!(is_link(&target).unwrap());
        assert_eq!(
            fs::read_to_string(other.join("SKILL.md")).unwrap(),
            "other original"
        );
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn shared_catalog_updates_disables_and_protects_user_edits() {
        let (base, root, source_root, entries) = shared_fixture();
        sync_shared(&root, &entries, &source_root).unwrap();
        let target = root.join(&entries[0].0);
        let original = fs::read_to_string(&entries[0].1).unwrap();
        fs::write(&entries[0].1, original.replace("figures", "new figures")).unwrap();
        assert!(!verify_shared(&root, &entries, &source_root));
        sync_shared(&root, &entries, &source_root).unwrap();
        let generated = fs::read_to_string(target.join("SKILL.md")).unwrap();
        assert!(generated.contains("new figures"));
        fs::write(target.join("SKILL.md"), format!("{generated}my edit")).unwrap();
        // An edited copy is no longer ours: never removed, reported as a conflict.
        let report = sync_shared(&root, &[], &source_root).unwrap();
        assert!(report.removed.is_empty());
        let report = sync_shared(&root, &entries, &source_root).unwrap();
        assert_eq!(report.conflicts.len(), 1);
        assert!(report.written.is_empty());
        assert!(fs::read_to_string(target.join("SKILL.md"))
            .unwrap()
            .ends_with("my edit"));
        fs::write(target.join("SKILL.md"), generated).unwrap();
        fs::write(target.join("personal.txt"), "keep").unwrap();
        sync_shared(&root, &[], &source_root).unwrap();
        assert!(!target.join("SKILL.md").exists());
        assert_eq!(
            fs::read_to_string(target.join("personal.txt")).unwrap(),
            "keep"
        );
        assert!(verify_shared(&root, &[], &source_root));
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn shared_catalog_lenient_description_and_conflict_skip() {
        // bug #15: descriptions the strict parser rejected blocked every client.
        let (base, root, source_root, _) = shared_fixture();
        let cases = [
            (
                "beta",
                "---\nname: beta\ndescription: [Beta] Draws charts\n---\n",
                "[Beta] Draws charts",
            ),
            (
                "windows",
                "---\nname: windows\ndescription: \"Reads C:\\Users\\data\"\n---\n",
                "Reads C:\\Users\\data",
            ),
            (
                "multi",
                "---\nname: multi\ndescription: \"first line\n  second line\"\n---\n",
                "first line second line",
            ),
            (
                "comment",
                "---\nname: comment\ndescription: \"x\" # note\n---\n",
                "x",
            ),
            (
                "indented",
                "---\n  name: indented\n  description: plain text\n---\n",
                "plain text",
            ),
            ("empty", "---\nname: empty\n---\nBody\n", "Skill empty"),
        ];
        let mut entries = Vec::new();
        for (name, body, _) in &cases {
            let manifest = source_root.join(name).join("SKILL.md");
            fs::create_dir_all(manifest.parent().unwrap()).unwrap();
            fs::write(&manifest, body).unwrap();
            entries.push((name.to_string(), manifest));
        }
        // An unreadable original is skipped by name; the rest still deliver.
        let broken = source_root.join("broken").join("SKILL.md");
        fs::create_dir_all(broken.parent().unwrap()).unwrap();
        fs::write(&broken, [0xff, 0xfe, 0x00]).unwrap();
        entries.push(("broken".into(), broken));
        // A personal same-name folder is a conflict, not a failure.
        let personal = root.join("personal-clash");
        fs::create_dir_all(&personal).unwrap();
        fs::write(personal.join("SKILL.md"), "---\nname: mine\n---\n").unwrap();
        let clash_original = source_root.join("personal-clash").join("SKILL.md");
        fs::create_dir_all(clash_original.parent().unwrap()).unwrap();
        fs::write(&clash_original, "---\nname: mine\n---\n").unwrap();
        entries.push(("personal-clash".into(), clash_original));

        let report = sync_shared(&root, &entries, &source_root).unwrap();
        assert_eq!(report.skipped.len(), 1);
        assert_eq!(report.skipped[0].0, "broken");
        assert_eq!(report.conflicts.len(), 1);
        assert!(report.conflicts[0].same_content);
        for (name, _, expected) in &cases {
            let generated = fs::read_to_string(root.join(name).join("SKILL.md")).unwrap();
            let description = field(&generated, "description").unwrap();
            assert_eq!(&description, expected, "{name}");
        }
        assert_eq!(
            fs::read_to_string(personal.join("SKILL.md")).unwrap(),
            "---\nname: mine\n---\n"
        );
        assert!(!root.join("broken").exists());
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn shared_catalog_migration_restores_old_junction_when_publication_fails() {
        let (base, root, source_root, entries) = shared_fixture();
        let target = root.join(&entries[0].0);
        directory_link(&target, entries[0].1.parent().unwrap());
        let content = wrapper(&entries[0].0, &entries[0].1).unwrap();
        let result = migrate_link(&target, &content, &source_root, |stage, path| {
            assert!(stage.join("SKILL.md").is_file());
            assert!(!path.exists());
            Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "injected publication failure",
            ))
        });
        assert!(result.unwrap_err().contains("original link restored"));
        assert!(managed_link(&target, &source_root));
        assert!(entries[0].1.is_file());
        assert_eq!(fs::read_dir(&root).unwrap().count(), 1);
        // Disabled legacy links are also removed without touching their targets.
        sync_shared(&root, &[], &source_root).unwrap();
        assert!(!target.exists());
        assert!(entries[0].1.is_file());
        fs::remove_dir_all(base).unwrap();
    }
}
