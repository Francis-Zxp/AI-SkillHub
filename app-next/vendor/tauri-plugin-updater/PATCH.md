# AI SkillHub updater patch

Base: crates.io `tauri-plugin-updater` 2.10.1. Original MIT/Apache-2.0 licenses are included. This is the Rust crate and its required build/permission inputs; unused package tooling is omitted.

The Windows `install_inner` previously hid windows/cleared resources through `on_before_exit`, ignored the `ShellExecuteW` result, then exited even when launch failed. We now check the result first and invoke cleanup only after successful launch. Download, HTTPS validation, minisign verification, installer arguments and version comparison are unchanged.

The return-value check follows the official upstream fix:
https://github.com/tauri-apps/plugins-workspace/commit/622f02bf21858f0cff95419fc042ce02b8c6b18b

The JavaScript check command also no longer accepts `allowDowngrades`: untrusted webview arguments cannot replace the native version comparator. AI SkillHub only supports forward updates. This is the bounded equivalent of the policy correction in upstream updater 2.12.0; no frontend-configurable downgrade path is retained.

Upstream 2.11.0 alone still cleans up before attempting launch. This bounded local patch avoids that premature cleanup and avoids unrelated dependency upgrades. Remove it when upgrading to an upstream release that covers both conditions, after running the regression tests.

Tests: `cargo test --manifest-path app-next/src-tauri/Cargo.toml -p tauri-plugin-updater --lib`. The Windows tests cover failure return codes, a native missing-file launch, and a successful retry callback. They do not prove Smart App Control will permit the distributed binary or that a successfully created installer process will finish installation.
