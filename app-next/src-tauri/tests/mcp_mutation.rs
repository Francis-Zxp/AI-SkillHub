#[path = "../src/mcp_center.rs"]
#[allow(dead_code)]
mod mcp_center;
#[path = "../src/mcp_json_doc.rs"]
#[allow(dead_code)]
mod mcp_json_doc;
#[path = "../src/mcp_mutation.rs"]
#[allow(dead_code)]
mod mcp_mutation;
#[path = "../src/mcp_secrets.rs"]
#[allow(dead_code)]
mod mcp_secrets;

#[test]
fn mutation_module_exports_transactional_entry_points() {
    let _plan = mcp_mutation::plan_mcp_changes;
    let _apply = mcp_mutation::apply_mcp_plan;
    let _rollback = mcp_mutation::rollback_mcp_snapshot;
    let _list_snapshots = mcp_mutation::list_mcp_rollback_snapshots;
    let _list_targets = mcp_mutation::list_mcp_mutation_targets;
}
