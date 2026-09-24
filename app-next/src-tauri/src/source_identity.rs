//! Repository identity and non-destructive metadata reconciliation.
//! Filesystem promotion/removal and restoration remain the caller's responsibility.

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::Serialize;

/// Accept repository identities only, never URLs with credentials, query strings,
/// encoded path separators, subpaths, or a lookalike GitHub hostname.
pub(crate) fn canonical_github_identity(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty()
        || value
            .chars()
            .any(|ch| ch.is_whitespace() || ch.is_control())
        || value.contains(['?', '#', '%', '\\'])
    {
        return None;
    }
    let lower = value.to_ascii_lowercase();
    let mut path = if lower.starts_with("https://github.com/") {
        &value[19..]
    } else if lower.starts_with("http://github.com/") {
        &value[18..]
    } else if lower.starts_with("ssh://git@github.com/") {
        &value[21..]
    } else if lower.starts_with("git@github.com:") {
        &value[15..]
    } else if value.contains("://") || value.contains(['@', ':']) {
        return None;
    } else {
        value
    };
    path = path.trim_end_matches('/');
    if path.to_ascii_lowercase().ends_with(".git") {
        path = &path[..path.len() - 4];
    }
    let (owner, repo) = path.split_once('/')?;
    if owner.is_empty()
        || owner.len() > 39
        || owner.starts_with('-')
        || owner.ends_with('-')
        || !owner
            .bytes()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == b'-')
        || repo.is_empty()
        || matches!(repo, "." | "..")
        || !repo
            .bytes()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, b'-' | b'_' | b'.'))
    {
        return None;
    }
    Some(format!(
        "{}/{}",
        owner.to_ascii_lowercase(),
        repo.to_ascii_lowercase()
    ))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SourceMergeReport {
    pub primary_id: String,
    pub duplicate_id: String,
    pub github_identity: String,
    pub note_appended: bool,
    pub inherited_rating: bool,
    pub added_tags: usize,
    pub added_tag_overrides: usize,
    pub inherited_folder: bool,
    pub primary_folder_name: Option<String>,
    pub additional_folder_name: Option<String>,
    /// Caller must preserve these in its recoverable snapshot before deleting a source.
    pub duplicate_skill_override_ids: Vec<String>,
    /// Oversized notes remain in the duplicate row and in this report.
    pub duplicate_note_not_merged: Option<String>,
}

struct SourceState {
    name: String,
    url: String,
    note: String,
    rating: i64,
}

fn read_source(connection: &Connection, id: &str) -> Result<SourceState, String> {
    connection
        .query_row(
            "SELECT s.name, COALESCE(s.url, ''),
                CASE WHEN o.display_name <> '' OR o.source_type <> '' OR o.category_id <> '' OR o.note <> ''
                    THEN o.note ELSE s.note END, COALESCE(o.rating, 0)
         FROM sources s LEFT JOIN source_overrides o ON o.source_id = s.id
         WHERE s.id = ?1",
            [id],
            |row| {
                Ok(SourceState {
                    name: row.get(0)?,
                    url: row.get(1)?,
                    note: row.get(2)?,
                    rating: row.get(3)?,
                })
            },
        )
        .map_err(|error| format!("无法读取合并来源 {id}：{error}"))
}

fn folder(connection: &Connection, id: &str) -> rusqlite::Result<Option<(String, String)>> {
    connection
        .query_row(
            "SELECT f.id, f.name FROM source_folder_memberships m
         JOIN skill_folders f ON f.id=m.folder_id WHERE m.source_id=?1",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
}

/// Merge source-level metadata in one SQLite transaction, leaving both source
/// rows, every child Skill, and the filesystem intact. Requires no outer transaction.
pub(crate) fn merge_source_metadata(
    connection: &mut Connection,
    primary_id: &str,
    duplicate_id: &str,
) -> Result<SourceMergeReport, String> {
    if primary_id.is_empty() || duplicate_id.is_empty() || primary_id == duplicate_id {
        return Err("合并需要两个不同且非空的来源 ID。".into());
    }
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("无法开始来源合并事务：{error}"))?;
    let primary = read_source(&transaction, primary_id)?;
    let duplicate = read_source(&transaction, duplicate_id)?;
    let identity = canonical_github_identity(&primary.url)
        .ok_or_else(|| "主来源没有可核验的 GitHub 仓库身份。".to_string())?;
    if canonical_github_identity(&duplicate.url).as_deref() != Some(identity.as_str()) {
        return Err("两个来源不属于同一 GitHub 仓库，已停止合并。".into());
    }
    let mut report = SourceMergeReport {
        primary_id: primary_id.into(),
        duplicate_id: duplicate_id.into(),
        github_identity: identity,
        note_appended: false,
        inherited_rating: primary.rating == 0 && duplicate.rating > 0,
        added_tags: 0,
        added_tag_overrides: 0,
        inherited_folder: false,
        primary_folder_name: None,
        additional_folder_name: None,
        duplicate_skill_override_ids: Vec::new(),
        duplicate_note_not_merged: None,
    };
    let entry = format!("[合并自 {}]\n{}", duplicate.name, duplicate.note.trim());
    let mut note = primary.note.clone();
    if !duplicate.note.trim().is_empty()
        && primary.note.trim() != duplicate.note.trim()
        && !primary.note.contains(&entry)
    {
        let merged = if note.trim().is_empty() {
            entry
        } else {
            format!("{}\n\n{entry}", note.trim_end())
        };
        if merged.len() <= 2000 {
            note = merged;
            report.note_appended = true;
        } else {
            report.duplicate_note_not_merged = Some(duplicate.note.clone());
        }
    }
    let rating = if report.inherited_rating {
        duplicate.rating
    } else {
        primary.rating
    };
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| format!("无法读取合并时间：{error}"))?
        .as_nanos()
        .to_string();
    transaction.execute(
        "INSERT INTO source_overrides(source_id,note,rating,updated_at) VALUES(?1,?2,?3,?4)
         ON CONFLICT(source_id) DO UPDATE SET note=CASE WHEN ?5 THEN excluded.note ELSE source_overrides.note END,
             rating=excluded.rating,updated_at=excluded.updated_at",
        params![primary_id, if report.note_appended { note.as_str() } else { "" }, rating, timestamp, report.note_appended],
    ).map_err(|error| format!("无法保留来源备注与评分：{error}"))?;
    report.added_tags = transaction
        .execute(
            "INSERT OR IGNORE INTO source_tags(source_id,tag_id)
         SELECT ?1,tag_id FROM source_tags WHERE source_id=?2",
            params![primary_id, duplicate_id],
        )
        .map_err(|error| format!("无法合并来源标签：{error}"))?;
    report.added_tag_overrides = transaction
        .execute(
            "INSERT OR IGNORE INTO source_tag_overrides(source_id,tag_id,updated_at)
         SELECT ?1,tag_id,?3 FROM source_tag_overrides WHERE source_id=?2",
            params![primary_id, duplicate_id, timestamp],
        )
        .map_err(|error| format!("无法保留自定义标签：{error}"))?;
    // Some custom tags may not have entered the last base scan yet.
    report.added_tags += transaction
        .execute(
            "INSERT OR IGNORE INTO source_tags(source_id,tag_id)
         SELECT ?1,tag_id FROM source_tag_overrides WHERE source_id=?1",
            [primary_id],
        )
        .map_err(|error| format!("无法刷新合并标签：{error}"))?;
    let primary_folder = folder(&transaction, primary_id).map_err(|error| error.to_string())?;
    let duplicate_folder = folder(&transaction, duplicate_id).map_err(|error| error.to_string())?;
    report.primary_folder_name = primary_folder.as_ref().map(|(_, name)| name.clone());
    match (&primary_folder, &duplicate_folder) {
        (None, Some((folder_id, name))) => {
            transaction.execute(
                "INSERT INTO source_folder_memberships(source_id,folder_id,sort_order,updated_at)
                 SELECT ?1,folder_id,sort_order,?3 FROM source_folder_memberships WHERE source_id=?2 AND folder_id=?4",
                params![primary_id, duplicate_id, timestamp, folder_id],
            ).map_err(|error| format!("无法继承来源文件夹：{error}"))?;
            report.inherited_folder = true;
            report.primary_folder_name = Some(name.clone());
        }
        (Some((primary_folder_id, _)), Some((duplicate_folder_id, name)))
            if primary_folder_id != duplicate_folder_id =>
        {
            report.additional_folder_name = Some(name.clone());
        }
        _ => {}
    }
    {
        let mut statement = transaction.prepare(
            "SELECT o.skill_id FROM skill_overrides o JOIN skills s ON s.id=o.skill_id WHERE s.source_id=?1 ORDER BY o.skill_id",
        ).map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([duplicate_id], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?;
        report.duplicate_skill_override_ids = rows
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|error| error.to_string())?;
    }
    transaction
        .commit()
        .map_err(|error| format!("来源合并提交失败：{error}"))?;
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parent_delivery_rejects_same_named_child_from_another_source() {
        let root =
            std::env::temp_dir().join(format!("skillhub-source-scope-{}", uuid::Uuid::new_v4()));
        let sources = root.join("sources");
        let first = sources.join("first");
        let second = sources.join("second");
        let parent = root.join("first");
        for path in [&first, &second, &parent] {
            std::fs::create_dir_all(path).unwrap();
        }
        for path in [&first, &second] {
            std::fs::write(
                path.join("SKILL.md"),
                "---\nname: shared\ndescription: Review\n---\n",
            )
            .unwrap();
        }
        let canonical_sources = sources.canonicalize().unwrap();
        let render = |child: &std::path::Path| {
            format!(
            "---\nname: first\ndescription: Review\n---\n<!-- [ROUTER-HUB] -->\n- 管理来源：`first`\n- [CHILD-SKILL] `$shared` — 来源文件：`{}`\n", child.display()
        )
        };
        std::fs::write(parent.join("SKILL.md"), render(&first.join("SKILL.md"))).unwrap();
        assert!(crate::delivery_manifest_is_valid(
            &parent,
            Some(&canonical_sources)
        ));
        std::fs::write(parent.join("SKILL.md"), render(&second.join("SKILL.md"))).unwrap();
        assert!(!crate::delivery_manifest_is_valid(
            &parent,
            Some(&canonical_sources)
        ));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn router_collection_never_walks_cross_source_directory_links() {
        let root =
            std::env::temp_dir().join(format!("skillhub-source-link-{}", uuid::Uuid::new_v4()));
        let first = root.join("first");
        let second = root.join("second");
        std::fs::create_dir_all(&first).unwrap();
        std::fs::create_dir_all(&second).unwrap();
        std::fs::write(
            second.join("SKILL.md"),
            "---\nname: foreign\ndescription: Foreign\n---\n",
        )
        .unwrap();
        let link = first.join("foreign");
        #[cfg(windows)]
        {
            let output = std::process::Command::new("cmd")
                .args(["/C", "mklink", "/J"])
                .arg(&link)
                .arg(&second)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "junction fixture must be available"
            );
        }
        #[cfg(not(windows))]
        std::os::unix::fs::symlink(&second, &link).unwrap();
        assert!(crate::collect_child_skill_links_for_collection(&first).is_empty());
        assert_eq!(
            crate::collect_child_skill_links_for_collection(&second).len(),
            1
        );
        #[cfg(windows)]
        std::fs::remove_dir(&link).unwrap();
        #[cfg(not(windows))]
        std::fs::remove_file(&link).unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }

    fn fixture() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch(
            "CREATE TABLE sources(id TEXT PRIMARY KEY,name TEXT,url TEXT,note TEXT);
             CREATE TABLE source_overrides(source_id TEXT PRIMARY KEY,display_name TEXT DEFAULT '',source_type TEXT DEFAULT '',category_id TEXT DEFAULT '',note TEXT DEFAULT '',rating INTEGER DEFAULT 0,enabled INTEGER,updated_at TEXT);
             CREATE TABLE source_tags(source_id TEXT,tag_id TEXT,PRIMARY KEY(source_id,tag_id));
             CREATE TABLE source_tag_overrides(source_id TEXT,tag_id TEXT,updated_at TEXT,PRIMARY KEY(source_id,tag_id));
             CREATE TABLE skill_folders(id TEXT PRIMARY KEY,name TEXT);
             CREATE TABLE source_folder_memberships(source_id TEXT PRIMARY KEY,folder_id TEXT,sort_order INTEGER,updated_at TEXT);
             CREATE TABLE skills(id TEXT PRIMARY KEY,source_id TEXT);
             CREATE TABLE skill_overrides(skill_id TEXT PRIMARY KEY,note TEXT);
             INSERT INTO sources VALUES('primary','PaperSpine','https://github.com/WUBING2023/PaperSpine.git','inferred'),('duplicate','WUBING2023--PaperSpine','git@github.com:wubing2023/paperspine.git','other inferred');
             INSERT INTO source_overrides(source_id,display_name,note,rating,enabled,updated_at) VALUES('primary','My name','My note',0,0,'old'),('duplicate','Other name','All workflows',5,1,'old');
             INSERT INTO source_tags VALUES('primary','a'),('duplicate','a'),('duplicate','b');
             INSERT INTO source_tag_overrides VALUES('duplicate','c','old');
             INSERT INTO skill_folders VALUES('f1','Writing'),('f2','Research');
             INSERT INTO source_folder_memberships VALUES('primary','f1',0,'old'),('duplicate','f2',1,'old');
             INSERT INTO skills VALUES('child','duplicate');
             INSERT INTO skill_overrides VALUES('child','Keep child note');"
        ).unwrap();
        connection
    }

    #[test]
    fn identity_normalizes_repo_forms_but_rejects_lookalikes_and_subpaths() {
        for value in [
            "WUBING2023/PaperSpine",
            "HTTPS://GITHUB.COM/WUBING2023/PaperSpine.GIT/",
            "git@github.com:WUBING2023/PaperSpine.git",
            "ssh://git@github.com/WUBING2023/PaperSpine.git",
        ] {
            assert_eq!(
                canonical_github_identity(value).as_deref(),
                Some("wubing2023/paperspine"),
                "{value}"
            );
        }
        for value in [
            "https://github.com.evil/a/b",
            "https://user:secret@github.com/a/b",
            "a/b/tree/main",
            "../repo",
            "a/%2e%2e",
            "a/b?token=x",
            "file:///a/b",
            "a/b#x",
            "a\\b",
            "ssh://root@github.com/a/b",
            "a/b\nc/d",
        ] {
            assert_eq!(canonical_github_identity(value), None, "{value}");
        }
        assert_ne!(
            canonical_github_identity("first/repo"),
            canonical_github_identity("second/repo")
        );
    }

    #[test]
    fn merge_preserves_primary_and_duplicate_state_and_is_idempotent() {
        let mut connection = fixture();
        let report = merge_source_metadata(&mut connection, "primary", "duplicate").unwrap();
        assert!(report.note_appended && report.inherited_rating);
        assert_eq!(report.additional_folder_name.as_deref(), Some("Research"));
        assert_eq!(report.duplicate_skill_override_ids, ["child"]);
        let (name, enabled, rating, note): (String, i64, i64, String) = connection.query_row(
            "SELECT display_name,enabled,rating,note FROM source_overrides WHERE source_id='primary'", [],
            |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?)),
        ).unwrap();
        assert_eq!((name.as_str(), enabled, rating), ("My name", 0, 5));
        assert_eq!(
            note,
            "My note\n\n[合并自 WUBING2023--PaperSpine]\nAll workflows"
        );
        assert_eq!(
            folder(&connection, "primary").unwrap().unwrap().1,
            "Writing"
        );
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM sources", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            2
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT note FROM skill_overrides WHERE skill_id='child'",
                    [],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            "Keep child note"
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM source_tags WHERE source_id='primary'",
                    [],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            3
        );
        let again = merge_source_metadata(&mut connection, "primary", "duplicate").unwrap();
        assert!(!again.note_appended && !again.inherited_rating);
        assert_eq!(again.added_tags + again.added_tag_overrides, 0);
    }

    #[test]
    fn mismatched_repo_and_midway_failure_leave_original_metadata() {
        let mut connection = fixture();
        connection
            .execute(
                "UPDATE sources SET url='other/paperspine' WHERE id='duplicate'",
                [],
            )
            .unwrap();
        assert!(merge_source_metadata(&mut connection, "primary", "duplicate").is_err());
        connection
            .execute(
                "UPDATE sources SET url='wubing2023/paperspine' WHERE id='duplicate'",
                [],
            )
            .unwrap();
        connection.execute_batch("CREATE TRIGGER fail_tags BEFORE INSERT ON source_tags WHEN NEW.source_id='primary' BEGIN SELECT RAISE(ABORT,'injected failure'); END;").unwrap();
        assert!(merge_source_metadata(&mut connection, "primary", "duplicate").is_err());
        assert_eq!(read_source(&connection, "primary").unwrap().note, "My note");
        assert_eq!(read_source(&connection, "primary").unwrap().rating, 0);
    }

    #[test]
    fn missing_primary_folder_inherits_duplicate_and_long_notes_are_reported() {
        let mut connection = fixture();
        connection
            .execute(
                "DELETE FROM source_folder_memberships WHERE source_id='primary'",
                [],
            )
            .unwrap();
        connection
            .execute(
                "UPDATE source_overrides SET note=?1,rating=3 WHERE source_id='primary'",
                ["x".repeat(1990)],
            )
            .unwrap();
        let report = merge_source_metadata(&mut connection, "primary", "duplicate").unwrap();
        assert!(report.inherited_folder);
        assert_eq!(report.primary_folder_name.as_deref(), Some("Research"));
        assert_eq!(
            report.duplicate_note_not_merged.as_deref(),
            Some("All workflows")
        );
        assert_eq!(read_source(&connection, "primary").unwrap().rating, 3);
    }
}
