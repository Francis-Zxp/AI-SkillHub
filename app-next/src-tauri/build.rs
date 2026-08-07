fn main() {
    tauri_build::build();

    // `tauri-build` embeds the Windows application manifest and icon into binary
    // targets, but Cargo's library test harness is a separate executable.  Tauri's
    // Windows dependencies import Common Controls v6 APIs (for example
    // TaskDialogIndirect), so an unmanifested test harness fails before any test can
    // run with STATUS_ENTRYPOINT_NOT_FOUND.  Reuse the exact resource compiled by
    // tauri-build for tests instead of maintaining a second, drifting manifest.
    #[cfg(target_os = "windows")]
    if let Ok(out_dir) = std::env::var("OUT_DIR") {
        let resource = std::path::Path::new(&out_dir).join("resource.lib");
        if resource.exists() {
            println!("cargo:rustc-link-search=native={out_dir}");
        }
    }
}
