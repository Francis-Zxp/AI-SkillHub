//! Secret storage for MCP credentials (docs/v3.3/mcp-contract.md §3.9).
//!
//! The default store is the current user's environment (`HKCU\Environment`),
//! written as `REG_SZ`. Machine-level variables are only ever *read* for
//! presence checks; SkillHub never writes HKLM. Values are never logged,
//! returned, or embedded in error messages. Everything here is a registry or
//! process-environment read/write; no child process is started.

use std::collections::HashMap;
use std::sync::Mutex;

pub(crate) const MAX_SECRET_VALUE_CHARS: usize = 8192;

/// Names refused for secret storage (`secret-name-reserved`).
const RESERVED_NAMES: [&str; 22] = [
    "PATH",
    "PATHEXT",
    "COMSPEC",
    "SYSTEMROOT",
    "WINDIR",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "USERNAME",
    "HOMEDRIVE",
    "HOMEPATH",
    "APPDATA",
    "LOCALAPPDATA",
    "PROGRAMDATA",
    "PROGRAMFILES",
    "PROGRAMFILES(X86)",
    "PSMODULEPATH",
    "NODE_OPTIONS",
    "PYTHONPATH",
    "PYTHONHOME",
    "CLAUDE_CONFIG_DIR",
    "CODEX_HOME",
];

/// Abstracts the per-user environment store so tests never touch the real
/// registry. Implementations must never log values.
pub(crate) trait EnvStore: Send + Sync {
    /// Reads a user-level variable. `Ok(None)` means absent.
    fn get(&self, name: &str) -> Result<Option<String>, ()>;
    /// Writes a user-level variable as `REG_SZ`.
    fn set(&self, name: &str, value: &str) -> Result<(), ()>;
    /// Deletes a user-level variable; deleting an absent one is not an error.
    fn delete(&self, name: &str) -> Result<(), ()>;
    /// Presence of a machine-level variable (read-only).
    fn machine_present(&self, name: &str) -> bool;
    /// Reads a machine-level variable (read-only), used for PATH resolution.
    fn machine_get(&self, name: &str) -> Option<String>;
    /// Notifies running programs that the environment changed. Returns false
    /// when the broadcast failed or timed out (non-fatal).
    fn broadcast(&self) -> bool;
    /// Whether this store reflects the real process environment as well.
    fn include_process_env(&self) -> bool {
        true
    }
}

/// `env_var_present(name) = process env || HKCU || HKLM Session Manager`.
pub(crate) fn env_var_present(store: &dyn EnvStore, name: &str) -> bool {
    if validate_env_name(name).is_err() {
        return false;
    }
    if store.include_process_env() && std::env::var_os(name).is_some_and(|value| !value.is_empty())
    {
        return true;
    }
    if store.get(name).ok().flatten().is_some_and(|value| !value.is_empty()) {
        return true;
    }
    store.machine_present(name)
}

/// Resolves the current value for a referenced variable at call time: the
/// user store first (the process environment is stale after the user saved a
/// key in the app), then the process environment.
pub(crate) fn resolve_env_value(store: &dyn EnvStore, name: &str) -> Option<String> {
    if let Ok(Some(value)) = store.get(name) {
        if !value.is_empty() {
            return Some(value);
        }
    }
    if store.include_process_env() {
        if let Some(value) = std::env::var_os(name) {
            let value = value.to_string_lossy().to_string();
            if !value.is_empty() {
                return Some(value);
            }
        }
    }
    store.machine_get(name).filter(|value| !value.is_empty())
}

pub(crate) fn validate_env_name(value: &str) -> Result<(), &'static str> {
    let mut chars = value.chars();
    let valid = value.len() <= 128
        && chars
            .next()
            .is_some_and(|ch| ch == '_' || ch.is_ascii_alphabetic())
        && chars.all(|ch| ch == '_' || ch.is_ascii_alphanumeric());
    if valid {
        Ok(())
    } else {
        Err("secret-name-invalid")
    }
}

/// Validates a variable name SkillHub may store a secret under.
pub(crate) fn validate_secret_name(value: &str) -> Result<(), &'static str> {
    validate_env_name(value)?;
    let upper = value.to_ascii_uppercase();
    if RESERVED_NAMES.contains(&upper.as_str()) || upper.starts_with("AI_SKILLHUB") {
        return Err("secret-name-reserved");
    }
    Ok(())
}

/// Trims surrounding ASCII whitespace and validates the value. The error never
/// contains the value.
pub(crate) fn normalize_secret_value(value: &str) -> Result<String, &'static str> {
    let trimmed = value.trim_matches(|ch: char| ch.is_ascii_whitespace());
    let count = trimmed.chars().count();
    if count == 0
        || count > MAX_SECRET_VALUE_CHARS
        || trimmed.contains(['\0', '\r', '\n'])
    {
        return Err("secret-value-invalid");
    }
    Ok(trimmed.to_string())
}

/// In-memory store for tests and previews. Never touches the registry.
#[derive(Default)]
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) struct MemoryEnvStore {
    user: Mutex<HashMap<String, String>>,
    machine: Mutex<HashMap<String, String>>,
    fail_writes: Mutex<bool>,
}

#[cfg_attr(not(test), allow(dead_code))]
impl MemoryEnvStore {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    #[cfg(test)]
    pub(crate) fn set_machine(&self, name: &str, value: &str) {
        self.machine
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(name.to_ascii_uppercase(), value.to_string());
    }

    #[cfg(test)]
    pub(crate) fn fail_writes(&self, fail: bool) {
        *self
            .fail_writes
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = fail;
    }

    #[cfg(test)]
    pub(crate) fn snapshot_values(&self) -> Vec<String> {
        self.user
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .values()
            .cloned()
            .collect()
    }
}

impl EnvStore for MemoryEnvStore {
    fn get(&self, name: &str) -> Result<Option<String>, ()> {
        Ok(self
            .user
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(&name.to_ascii_uppercase())
            .cloned())
    }

    fn set(&self, name: &str, value: &str) -> Result<(), ()> {
        if *self
            .fail_writes
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
        {
            return Err(());
        }
        self.user
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(name.to_ascii_uppercase(), value.to_string());
        Ok(())
    }

    fn delete(&self, name: &str) -> Result<(), ()> {
        self.user
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&name.to_ascii_uppercase());
        Ok(())
    }

    fn machine_present(&self, name: &str) -> bool {
        self.machine
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .contains_key(&name.to_ascii_uppercase())
    }

    fn machine_get(&self, name: &str) -> Option<String> {
        self.machine
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(&name.to_ascii_uppercase())
            .cloned()
    }

    fn broadcast(&self) -> bool {
        true
    }

    fn include_process_env(&self) -> bool {
        false
    }
}

/// The real store: `HKCU\Environment` (read/write) and HKLM Session Manager
/// environment (read-only).
pub(crate) struct RegistryEnvStore;

#[cfg(windows)]
impl EnvStore for RegistryEnvStore {
    fn get(&self, name: &str) -> Result<Option<String>, ()> {
        use winreg::enums::{HKEY_CURRENT_USER, KEY_READ};
        use winreg::RegKey;
        let key = match RegKey::predef(HKEY_CURRENT_USER).open_subkey_with_flags("Environment", KEY_READ)
        {
            Ok(key) => key,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(()),
        };
        match key.get_value::<String, _>(name) {
            Ok(value) => Ok(Some(value)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(_) => Err(()),
        }
    }

    fn set(&self, name: &str, value: &str) -> Result<(), ()> {
        use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_SET_VALUE};
        use winreg::RegKey;
        let (key, _) = RegKey::predef(HKEY_CURRENT_USER)
            .create_subkey_with_flags("Environment", KEY_READ | KEY_SET_VALUE)
            .map_err(|_| ())?;
        // `String` is written as REG_SZ by winreg, never REG_EXPAND_SZ.
        key.set_value(name, &value.to_string()).map_err(|_| ())
    }

    fn delete(&self, name: &str) -> Result<(), ()> {
        use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_SET_VALUE};
        use winreg::RegKey;
        let key = match RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey_with_flags("Environment", KEY_READ | KEY_SET_VALUE)
        {
            Ok(key) => key,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(_) => return Err(()),
        };
        match key.delete_value(name) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err(()),
        }
    }

    fn machine_present(&self, name: &str) -> bool {
        self.machine_get(name).is_some_and(|value| !value.is_empty())
    }

    fn machine_get(&self, name: &str) -> Option<String> {
        use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_READ};
        use winreg::RegKey;
        RegKey::predef(HKEY_LOCAL_MACHINE)
            .open_subkey_with_flags(
                r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment",
                KEY_READ,
            )
            .ok()?
            .get_value::<String, _>(name)
            .ok()
    }

    fn broadcast(&self) -> bool {
        broadcast_environment_change()
    }
}

#[cfg(not(windows))]
impl EnvStore for RegistryEnvStore {
    fn get(&self, _name: &str) -> Result<Option<String>, ()> {
        Ok(None)
    }

    fn set(&self, _name: &str, _value: &str) -> Result<(), ()> {
        Err(())
    }

    fn delete(&self, _name: &str) -> Result<(), ()> {
        Err(())
    }

    fn machine_present(&self, _name: &str) -> bool {
        false
    }

    fn machine_get(&self, _name: &str) -> Option<String> {
        None
    }

    fn broadcast(&self) -> bool {
        false
    }
}

/// `SendMessageTimeoutW(HWND_BROADCAST, WM_SETTINGCHANGE, 0, "Environment",
/// SMTO_ABORTIFHUNG, 5000, …)`. Non-fatal on failure.
#[cfg(windows)]
pub(crate) fn broadcast_environment_change() -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        SendMessageTimeoutW, HWND_BROADCAST, SMTO_ABORTIFHUNG, WM_SETTINGCHANGE,
    };
    let area: Vec<u16> = "Environment\0".encode_utf16().collect();
    let mut result: usize = 0;
    let status = unsafe {
        SendMessageTimeoutW(
            HWND_BROADCAST,
            WM_SETTINGCHANGE,
            0,
            area.as_ptr() as isize,
            SMTO_ABORTIFHUNG,
            5000,
            &mut result,
        )
    };
    status != 0
}

#[cfg(not(windows))]
pub(crate) fn broadcast_environment_change() -> bool {
    false
}

/// Expands `%VAR%` references using the process environment, then the user
/// and machine stores. Unknown references are kept literally.
pub(crate) fn expand_percent_vars(store: &dyn EnvStore, value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut rest = value;
    while let Some(start) = rest.find('%') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        if let Some(end) = after.find('%') {
            let name = &after[..end];
            let resolved = if !name.is_empty() && validate_env_name(name).is_ok() {
                std::env::var(name)
                    .ok()
                    .or_else(|| store.get(name).ok().flatten())
                    .or_else(|| store.machine_get(name))
            } else {
                None
            };
            match resolved {
                Some(found) => out.push_str(&found),
                None => {
                    out.push('%');
                    out.push_str(name);
                    out.push('%');
                }
            }
            rest = &after[end + 1..];
        } else {
            out.push_str(&rest[start..]);
            rest = "";
        }
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reserved_and_invalid_names_and_values_are_rejected_without_echo() {
        assert_eq!(validate_secret_name("PATH"), Err("secret-name-reserved"));
        assert_eq!(validate_secret_name("path"), Err("secret-name-reserved"));
        assert_eq!(
            validate_secret_name("AI_SKILLHUB_TOKEN"),
            Err("secret-name-reserved")
        );
        assert_eq!(
            validate_secret_name("ProgramFiles(x86)"),
            Err("secret-name-invalid")
        );
        assert_eq!(validate_secret_name("1BAD"), Err("secret-name-invalid"));
        assert!(validate_secret_name("GITHUB_PERSONAL_ACCESS_TOKEN").is_ok());
        assert_eq!(normalize_secret_value("  abc \t").unwrap(), "abc");
        for bad in ["", "   ", "a\nb", "a\rb", "a\0b"] {
            assert_eq!(normalize_secret_value(bad), Err("secret-value-invalid"));
        }
        let long = "x".repeat(MAX_SECRET_VALUE_CHARS + 1);
        assert_eq!(normalize_secret_value(&long), Err("secret-value-invalid"));
    }

    #[test]
    fn memory_store_presence_covers_user_and_machine() {
        let store = MemoryEnvStore::new();
        assert!(!env_var_present(&store, "SKH_TEST_ONLY_A"));
        store.set("SKH_TEST_ONLY_A", "v").unwrap();
        assert!(env_var_present(&store, "SKH_TEST_ONLY_A"));
        store.set_machine("SKH_TEST_ONLY_B", "v");
        assert!(env_var_present(&store, "SKH_TEST_ONLY_B"));
        store.delete("SKH_TEST_ONLY_A").unwrap();
        assert!(!env_var_present(&store, "SKH_TEST_ONLY_A"));
    }

    #[test]
    fn percent_variables_expand_from_the_store() {
        let store = MemoryEnvStore::new();
        store.set("SKH_TEST_ONLY_DIR", r"C:\Tools").unwrap();
        assert_eq!(
            expand_percent_vars(&store, r"%SKH_TEST_ONLY_DIR%\bin;%NOPE_SKH_X%"),
            r"C:\Tools\bin;%NOPE_SKH_X%"
        );
    }

    /// R25: real HKCU round trip with a unique test-only variable name.
    #[test]
    #[cfg(windows)]
    #[ignore = "writes a unique test-only variable to HKCU\\Environment and removes it"]
    fn real_hkcu_roundtrip() {
        let name = format!(
            "SKH_TEST_ONLY_{}",
            uuid::Uuid::new_v4().simple().to_string().to_ascii_uppercase()
        );
        let store = RegistryEnvStore;
        store.set(&name, "roundtrip-value").unwrap();
        assert!(env_var_present(&store, &name));
        let started = std::time::Instant::now();
        let _ = store.broadcast();
        assert!(started.elapsed() < std::time::Duration::from_secs(6));
        store.delete(&name).unwrap();
        assert!(!env_var_present(&store, &name));
    }
}
