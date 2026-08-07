#[path = "../src/codex_plugin_doctor.rs"]
mod codex_plugin_doctor;

#[test]
fn read_only_probe_module_is_covered_by_its_contract_tests() {
    assert_eq!(codex_plugin_doctor::STATUS_READY, "ready");
    assert_eq!(codex_plugin_doctor::STATUS_WARN, "warn");
    assert_eq!(codex_plugin_doctor::STATUS_ERROR, "error");
    assert_eq!(codex_plugin_doctor::STATUS_UNKNOWN, "unknown");
}
