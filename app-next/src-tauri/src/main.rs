#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if std::env::args().any(|arg| arg == "--merge-identical-sources") {
        if let Err(error) = ai_skillhub_next_lib::run_source_consolidation() {
            eprintln!("{error}");
            std::process::exit(1);
        }
        return;
    }
    ai_skillhub_next_lib::run();
}
