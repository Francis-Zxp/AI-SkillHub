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
}
