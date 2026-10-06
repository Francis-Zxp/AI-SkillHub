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

/// Entries contain a safe directory name and the original absolute SKILL.md path.
pub fn sync(root: &Path, entries: &[(String, PathBuf)]) -> Result<(), String> {
    let changes = plan(root, entries)?;
    fs::create_dir_all(root).map_err(|e| e.to_string())?;
    apply_changes(changes)
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
    root.is_dir() && plan(root, entries).is_ok_and(|changes| changes.is_empty())
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
) -> Result<(), String> {
    let changes = plan_shared(root, entries, managed_source_root)?;
    fs::create_dir_all(root).map_err(|e| e.to_string())?;
    for change in changes {
        check_directory(root)?;
        match change {
            SharedChange::Manifest(change) => apply_changes(vec![change])?,
            SharedChange::Migrate(path, content) => {
                migrate_link(&path, &content, managed_source_root, |from, to| {
                    fs::rename(from, to)
                })?;
            }
            SharedChange::RemoveLink(path) => {
                if !managed_link(&path, managed_source_root) {
                    return Err(format!(
                        "Changed shared Skill link preserved: {}",
                        path.display()
                    ));
                }
                remove_directory_link(&path).map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(())
}

pub fn verify_shared(
    root: &Path,
    entries: &[(String, PathBuf)],
    managed_source_root: &Path,
) -> bool {
    root.is_dir()
        && plan_shared(root, entries, managed_source_root).is_ok_and(|plan| plan.is_empty())
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

fn plan_shared(
    root: &Path,
    entries: &[(String, PathBuf)],
    managed_source_root: &Path,
) -> Result<Vec<SharedChange>, String> {
    if !root.is_absolute()
        || !managed_source_root.is_absolute()
        || paths_equal(root, managed_source_root)
    {
        return Err("Shared and source Skills directories must be distinct absolute paths".into());
    }
    check_directory(root)?;
    let mut names = BTreeSet::new();
    let mut changes = Vec::new();
    for (name, source) in entries {
        let mut components = Path::new(name).components();
        if !matches!(components.next(), Some(Component::Normal(_)))
            || components.next().is_some()
            || name.ends_with(['.', ' '])
            || name
                .chars()
                .any(|c| c.is_control() || "<>:\"/\\|?*".contains(c))
            || !names.insert(name.to_lowercase())
        {
            return Err("Invalid or duplicate shared Skill name".into());
        }
        let path = root.join(name);
        let content = wrapper(name, source)?;
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
                let existing = shared_manifest(&path)?.ok_or_else(|| {
                    format!(
                        "Personal Skill with the same name preserved: {}",
                        path.display()
                    )
                })?;
                if existing != content {
                    changes.push(SharedChange::Manifest(Change::Write(
                        path.join("SKILL.md"),
                        content,
                    )));
                }
            }
            _ => {
                return Err(format!(
                    "Personal Skill or external link with the same name preserved: {}",
                    path.display()
                ))
            }
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
                && shared_manifest(&path)?.is_some()
            {
                changes.push(SharedChange::Manifest(Change::Remove(
                    path.join("SKILL.md"),
                )));
            }
        }
    }
    Ok(changes)
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

fn plan(root: &Path, entries: &[(String, PathBuf)]) -> Result<Vec<Change>, String> {
    if !root.is_absolute() {
        return Err("Shared Skills directory must be absolute".into());
    }
    check_directory(root)?;
    let mut names = BTreeSet::new();
    let mut changes = Vec::new();
    for (name, source) in entries {
        let mut components = Path::new(name).components();
        if !matches!(components.next(), Some(Component::Normal(_)))
            || components.next().is_some()
            || name.ends_with(['.', ' '])
            || name
                .chars()
                .any(|c| c.is_control() || "<>:\"/\\|?*".contains(c))
            || !names.insert(name.to_lowercase())
        {
            return Err("Invalid or duplicate shared Skill name".into());
        }
        let directory = root.join(name);
        check_directory(&directory)?;
        let target = directory.join("SKILL.md");
        let existing = check_managed_manifest(&target)?;
        let content = wrapper(name, source)?;
        if existing.as_deref() != Some(&content) {
            changes.push(Change::Write(target, content));
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
    Ok(changes)
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
    let original = read_manifest(source)?;
    let name = field(&original, "name").unwrap_or_else(|| fallback_name.to_string());
    let description = field(&original, "description")
        .filter(|s| !s.trim().is_empty())
        .ok_or("Original Skill has no usable description")?;
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
        assert!(sync_shared(&root, &pending, &source_root).is_err());
        assert!(!root.join("new-skill").exists());
        assert_eq!(
            fs::read_to_string(target.join("SKILL.md")).unwrap(),
            "my own skill"
        );
        fs::remove_file(target.join("SKILL.md")).unwrap();
        fs::remove_dir(&target).unwrap();
        // Even another directory inside the managed root is not the exact target.
        let other = source_root.join("other");
        fs::create_dir_all(&other).unwrap();
        fs::write(other.join("SKILL.md"), "other original").unwrap();
        directory_link(&target, &other);
        assert!(sync_shared(&root, &entries, &source_root).is_err());
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
        assert!(sync_shared(&root, &[], &source_root).is_err());
        assert!(sync_shared(&root, &entries, &source_root).is_err());
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
