//! Read installation evidence; never execute registry command strings or create client data.
use std::path::{Path, PathBuf};

const WORKBUDDY_BINARIES: &[&str] = &["WorkBuddy.exe", "WorkBuddyAI.exe"];
const WORKBUDDY_PRODUCTS: &[&str] = &["WorkBuddy", "WorkBuddy AI", "WorkBuddyAI"];
const WORKBUDDY_FOLDERS: &[&str] = &["WorkBuddy", "WorkBuddyAI", "WorkBuddy AI"];

fn default_desktop(roots: &[PathBuf], folders: &[&str], binaries: &[&str]) -> Option<PathBuf> {
    roots
        .iter()
        .filter(|root| root.is_absolute())
        .find_map(|root| {
            folders.iter().find_map(|folder| {
                binaries
                    .iter()
                    .map(|binary| root.join(folder).join(binary))
                    .find(|path| path.is_file())
            })
        })
}

#[cfg(test)]
pub(crate) fn workbuddy_in_default_locations(local: &Path, programs: &Path) -> bool {
    default_desktop(
        &[
            local.join("Programs"),
            local.to_path_buf(),
            programs.to_path_buf(),
        ],
        WORKBUDDY_FOLDERS,
        WORKBUDDY_BINARIES,
    )
    .is_some()
}

pub(crate) fn workbuddy_executable() -> Option<PathBuf> {
    desktop_executable(WORKBUDDY_PRODUCTS, WORKBUDDY_BINARIES, WORKBUDDY_FOLDERS)
}

pub(crate) fn antigravity_executable() -> Option<PathBuf> {
    desktop_executable(
        &["Antigravity", "Antigravity (User)"],
        &["Antigravity.exe"],
        &["Antigravity"],
    )
}

pub(crate) fn coze_executable() -> Option<PathBuf> {
    desktop_executable(&["Coze", "扣子"], &["Coze.exe"], &["Coze"])
}

fn desktop_executable(products: &[&str], binaries: &[&str], folders: &[&str]) -> Option<PathBuf> {
    registered_desktop(products, binaries)
        .or_else(|| {
            let qa_root = std::env::var_os("AI_SKILLHUB_QA_ROOT").map(PathBuf::from);
            let local = std::env::var_os("LOCALAPPDATA")
                .map(PathBuf::from)
                .unwrap_or_default();
            let mut roots = Vec::new();
            if qa_root
                .as_ref()
                .is_none_or(|root| confined_path(&local, root))
            {
                roots.extend([local.join("Programs"), local]);
            }
            if qa_root.is_none() {
                roots.extend(
                    ["ProgramFiles", "ProgramFiles(x86)"]
                        .into_iter()
                        .filter_map(|name| std::env::var_os(name).map(PathBuf::from)),
                );
            }
            default_desktop(&roots, folders, binaries)
        })
        .or_else(|| running_desktop(binaries))
}

fn confined_path(path: &Path, root: &Path) -> bool {
    path.is_absolute()
        && root.is_absolute()
        && path.starts_with(root)
        && !path
            .components()
            .any(|part| part == std::path::Component::ParentDir)
}

#[cfg(any(windows, test))]
fn registered_product_name(name: &str, products: &[&str]) -> bool {
    let name = name.trim().to_ascii_lowercase();
    products.iter().any(|product| {
        let product = product.to_ascii_lowercase();
        if name == product {
            return true;
        }
        let Some(suffix) = name.strip_prefix(&product) else {
            return false;
        };
        let version = suffix.trim_start();
        if version == suffix {
            return false;
        }
        let number = if let Some(index) = version.find(['-', '+']) {
            let extra = &version[index + 1..];
            if extra.is_empty()
                || !extra
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'.' || c == b'-')
            {
                return false;
            }
            &version[..index]
        } else {
            version
        };
        let parts = number.split('.').collect::<Vec<_>>();
        (2..=4).contains(&parts.len())
            && parts
                .iter()
                .all(|part| !part.is_empty() && part.bytes().all(|c| c.is_ascii_digit()))
    })
}

#[cfg(test)]
fn workbuddy_registration(name: &str, icon: &str, location: &str) -> Option<PathBuf> {
    desktop_registration(name, icon, location, WORKBUDDY_PRODUCTS, WORKBUDDY_BINARIES)
}

#[cfg(any(windows, test))]
fn desktop_registration(
    name: &str,
    icon: &str,
    location: &str,
    products: &[&str],
    binaries: &[&str],
) -> Option<PathBuf> {
    if !registered_product_name(name, products) {
        return None;
    }
    let mut candidates = Vec::new();
    // DisplayIcon is a path with an optional icon index, not a command line.
    let icon = icon.trim();
    let icon = icon
        .rsplit_once(',')
        .filter(|(_, index)| index.trim().parse::<i32>().is_ok())
        .map_or(icon, |(path, _)| path)
        .trim()
        .trim_matches('"');
    candidates.push(PathBuf::from(icon));
    let location = Path::new(location.trim().trim_matches('"'));
    if location.is_absolute() {
        candidates.extend(binaries.iter().map(|binary| location.join(binary)));
    }
    candidates.into_iter().find(|candidate| {
        candidate.is_absolute()
            && candidate.file_name().is_some_and(|name| {
                binaries
                    .iter()
                    .any(|binary| name.to_string_lossy().eq_ignore_ascii_case(binary))
            })
            && candidate.is_file()
    })
}

#[cfg(test)]
pub(crate) fn registered_workbuddy() -> Option<PathBuf> {
    registered_desktop(WORKBUDDY_PRODUCTS, WORKBUDDY_BINARIES)
}

fn registered_desktop(_products: &[&str], _binaries: &[&str]) -> Option<PathBuf> {
    if std::env::var_os("AI_SKILLHUB_QA_ROOT").is_some() {
        return None;
    }
    #[cfg(windows)]
    {
        use winreg::{
            enums::{
                HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_32KEY, KEY_WOW64_64KEY,
            },
            RegKey,
        };
        for hive in [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE] {
            for view in [KEY_WOW64_64KEY, KEY_WOW64_32KEY] {
                let Ok(root) = RegKey::predef(hive).open_subkey_with_flags(
                    "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
                    KEY_READ | view,
                ) else {
                    continue;
                };
                for name in root.enum_keys().take(4096).flatten() {
                    let Ok(entry) = root.open_subkey_with_flags(name, KEY_READ) else {
                        continue;
                    };
                    if let Some(path) = desktop_registration(
                        &entry
                            .get_value::<String, _>("DisplayName")
                            .unwrap_or_default(),
                        &entry
                            .get_value::<String, _>("DisplayIcon")
                            .unwrap_or_default(),
                        &entry
                            .get_value::<String, _>("InstallLocation")
                            .unwrap_or_default(),
                        _products,
                        _binaries,
                    ) {
                        return Some(path);
                    }
                }
            }
        }
    }
    None
}

fn running_desktop(_binaries: &[&str]) -> Option<PathBuf> {
    if std::env::var_os("AI_SKILLHUB_QA_ROOT").is_some() {
        return None;
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStringExt;
        use windows_sys::Win32::{
            Foundation::{CloseHandle, INVALID_HANDLE_VALUE},
            System::{
                Diagnostics::ToolHelp::{
                    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
                    TH32CS_SNAPPROCESS,
                },
                Threading::{
                    OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
                },
            },
        };
        // Only query matching executable names; never inspect arguments or process memory.
        unsafe {
            let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if snapshot == INVALID_HANDLE_VALUE {
                return None;
            }
            let mut entry: PROCESSENTRY32W = std::mem::zeroed();
            entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
            let mut candidates = Vec::new();
            let mut more = Process32FirstW(snapshot, &mut entry);
            while more != 0 {
                let length = entry
                    .szExeFile
                    .iter()
                    .position(|c| *c == 0)
                    .unwrap_or(entry.szExeFile.len());
                let name = String::from_utf16_lossy(&entry.szExeFile[..length]);
                if _binaries
                    .iter()
                    .any(|binary| name.eq_ignore_ascii_case(binary))
                {
                    let process =
                        OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, entry.th32ProcessID);
                    if !process.is_null() {
                        let mut buffer = vec![0u16; 32768];
                        let mut length = buffer.len() as u32;
                        if QueryFullProcessImageNameW(process, 0, buffer.as_mut_ptr(), &mut length)
                            != 0
                        {
                            let path = PathBuf::from(std::ffi::OsString::from_wide(
                                &buffer[..length as usize],
                            ));
                            if path.is_absolute()
                                && path.is_file()
                                && path.file_name().is_some_and(|name| {
                                    _binaries.iter().any(|binary| {
                                        name.to_string_lossy().eq_ignore_ascii_case(binary)
                                    })
                                })
                            {
                                candidates.push(path);
                            }
                        }
                        CloseHandle(process);
                    }
                }
                more = Process32NextW(snapshot, &mut entry);
            }
            CloseHandle(snapshot);
            _binaries.iter().find_map(|binary| {
                candidates
                    .iter()
                    .find(|path| {
                        path.file_name()
                            .is_some_and(|name| name.to_string_lossy().eq_ignore_ascii_case(binary))
                    })
                    .cloned()
            })
        }
    }
    #[cfg(not(windows))]
    None
}

pub(crate) fn workbuddy_skills_root(home: &Path) -> PathBuf {
    let isolated = std::env::var_os("AI_SKILLHUB_QA_ROOT").is_some();
    ["WORKBUDDY_CONFIG_DIR", "CODEBUDDY_CONFIG_DIR"]
        .into_iter()
        .filter_map(|name| std::env::var_os(name).map(PathBuf::from))
        .find(|path| path.is_absolute() && (!isolated || confined_path(path, home)))
        .unwrap_or_else(|| workbuddy_product_home(home, workbuddy_executable().as_deref()))
        .join("skills")
}

fn workbuddy_product_home(home: &Path, executable: Option<&Path>) -> PathBuf {
    use std::io::Read;
    let product = executable
        .and_then(Path::parent)
        .map(|root| root.join("resources/app.asar.unpacked/cli/product.json"));
    let folder = product
        .and_then(|path| {
            let file = std::fs::File::open(path).ok()?;
            if file.metadata().ok()?.len() > 2 * 1024 * 1024 {
                return None;
            }
            let mut text = String::new();
            file.take(2 * 1024 * 1024).read_to_string(&mut text).ok()?;
            let json: serde_json::Value = serde_json::from_str(&text).ok()?;
            let folder = json.get("dataFolderName")?.as_str()?;
            (folder.starts_with('.')
                && folder.len() > 1
                && folder.len() <= 64
                && folder[1..]
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_'))
            .then(|| folder.to_string())
        })
        .unwrap_or_else(|| ".workbuddy".to_string());
    home.join(folder)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn product_identity_allows_version_suffixes_but_not_helpers() {
        for name in [
            "WorkBuddy",
            "WorkBuddy AI 5.6.2",
            "WorkBuddyAI 5.6.2-beta.1",
            "WorkBuddy 5.6.2+release",
        ] {
            assert!(registered_product_name(name, WORKBUDDY_PRODUCTS), "{name}");
        }
        for name in [
            "WorkBuddy AI Helper",
            "WorkBuddyAI5.6.2",
            "WorkBuddy 5",
            "WorkBuddy 5.6.2.",
            "WorkBuddy 5.6.2-beta+extra",
            "WorkBuddy 5.6.2 Installer",
        ] {
            assert!(!registered_product_name(name, WORKBUDDY_PRODUCTS), "{name}");
        }
    }

    #[test]
    fn isolated_paths_must_stay_inside_the_fixture() {
        let root = std::env::temp_dir().join("skillhub-profile-fixture");
        assert!(confined_path(&root.join("AppData/Local/Programs"), &root));
        assert!(!confined_path(&root.with_file_name("real-user"), &root));
        assert!(!confined_path(&root.join("../real-user"), &root));
        assert!(!confined_path(Path::new("relative"), &root));
    }

    #[test]
    fn antigravity_uses_registered_and_default_installation_evidence() {
        let root =
            std::env::temp_dir().join(format!("antigravity-registration-{}", uuid::Uuid::new_v4()));
        let folder = root.join("Antigravity");
        let binary = folder.join("Antigravity.exe");
        fs::create_dir_all(&folder).unwrap();
        assert!(default_desktop(&[root.clone()], &["Antigravity"], &["Antigravity.exe"]).is_none());
        fs::write(&binary, b"fixture; never executed").unwrap();
        assert_eq!(
            default_desktop(&[root.clone()], &["Antigravity"], &["Antigravity.exe"]),
            Some(binary.clone())
        );
        assert_eq!(
            desktop_registration(
                "Antigravity (User) 1.2.3",
                "",
                &folder.to_string_lossy(),
                &["Antigravity", "Antigravity (User)"],
                &["Antigravity.exe"]
            ),
            Some(binary)
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn custom_install_icon_requires_current_executable_and_product_identity() {
        let root =
            std::env::temp_dir().join(format!("workbuddy-registration-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let binary = root.join("WorkBuddyAI.exe");
        let icon = format!("\"{}\",0", binary.display());
        assert!(workbuddy_registration("WorkBuddy AI 5.6.2", &icon, "").is_none());
        fs::write(&binary, b"fixture; never executed").unwrap();
        assert_eq!(
            workbuddy_registration("WorkBuddy AI 5.6.2", &icon, ""),
            Some(binary.clone())
        );
        assert!(workbuddy_registration("CodeBuddy", &icon, "").is_none());
        assert!(workbuddy_registration("WorkBuddy AI Helper", &icon, "").is_none());
        assert!(workbuddy_registration(
            "WorkBuddy AI",
            &format!("{} --flag", binary.display()),
            ""
        )
        .is_none());
        assert_eq!(
            workbuddy_registration("WorkBuddy AI", "", &root.to_string_lossy()),
            Some(binary)
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn both_workbuddy_executable_names_are_supported_without_folder_false_positives() {
        let root =
            std::env::temp_dir().join(format!("workbuddy-locations-{}", uuid::Uuid::new_v4()));
        let local = root.join("Local");
        let folder = local.join("Programs/WorkBuddyAI");
        fs::create_dir_all(&folder).unwrap();
        assert!(!workbuddy_in_default_locations(
            &local,
            &root.join("ProgramFiles")
        ));
        fs::write(folder.join("WorkBuddyAI.exe"), b"fixture").unwrap();
        assert!(workbuddy_in_default_locations(
            &local,
            &root.join("ProgramFiles")
        ));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn installed_product_metadata_selects_current_profile_without_traversal() {
        let root = std::env::temp_dir().join(format!("workbuddy-profile-{}", uuid::Uuid::new_v4()));
        let binary = root.join("WorkBuddyAI.exe");
        let file = root.join("resources/app.asar.unpacked/cli/product.json");
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(&file, serde_json::json!({"dataFolderName":".workbuddy-ai", "otherProductMetadata": "x".repeat(400_000)}).to_string()).unwrap();
        assert_eq!(
            workbuddy_product_home(&root, Some(&binary)),
            root.join(".workbuddy-ai")
        );
        for invalid in [
            "../outside",
            ".",
            "..",
            ".workbuddy/elsewhere",
            "C:\\outside",
        ] {
            fs::write(
                &file,
                serde_json::json!({"dataFolderName":invalid}).to_string(),
            )
            .unwrap();
            assert_eq!(
                workbuddy_product_home(&root, Some(&binary)),
                root.join(".workbuddy")
            );
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    #[ignore = "Read-only check of the current Windows installation; opt in explicitly"]
    fn current_workbuddy_installation_is_registered() {
        let binary = registered_workbuddy().expect("registered WorkBuddy executable");
        assert!(binary.is_file());
    }
}
