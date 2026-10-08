#[path = "../src/mcp_center.rs"]
#[allow(dead_code)]
mod mcp_center;
#[path = "../src/mcp_secrets.rs"]
#[allow(dead_code)]
mod mcp_secrets;

#[test]
fn command_facing_entry_point_is_available() {
    let temp_home = std::env::temp_dir().join(format!(
        "ai-skillhub-mcp-entrypoint-missing-{}",
        std::process::id()
    ));
    let request = mcp_center::McpScanRequest {
        platform: Some("test".to_string()),
        ..mcp_center::McpScanRequest::for_home(temp_home.clone())
    };
    let inventory: mcp_center::McpInventory = mcp_center::scan_connections(request);
    assert_eq!(inventory.summary.binding_count, 0);
    assert!(!temp_home.exists());
}
