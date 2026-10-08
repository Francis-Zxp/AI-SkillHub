//! Built-in MCP templates (docs/v3.3/mcp-contract.md §3.7). Static data only:
//! nothing here downloads, installs or runs anything. A template is a prefill
//! for the add sheet; the user's click on "添加" writes it like any other add.
//!
//! `verifiedAt` is set by the release checklist (§7.4 D11). A template that
//! fails the release-time connection test is removed from the list for that
//! release instead of shipping broken.

use serde_json::{json, Value};

/// Release-time verification stamp. `None` until the D11 gate has run on a
/// clean machine for this release.
const VERIFIED_AT: Option<&str> = None;

pub(crate) fn list_templates() -> Vec<Value> {
    let verified = VERIFIED_AT.map(Value::from).unwrap_or(Value::Null);
    let stdio = |id: &str, command: &str, args: &[&str]| {
        json!({
            "name": id,
            "transport": "stdio",
            "command": command,
            "args": args,
            "source": { "kind": "template", "id": id }
        })
    };
    vec![
        json!({
            "id": "context7",
            "input": stdio("context7", "npx", &["-y", "@upstash/context7-mcp"]),
            "params": [],
            "secrets": [{
                "kind": "env",
                "name": "CONTEXT7_API_KEY",
                "envVar": "CONTEXT7_API_KEY",
                "required": false,
                "helpUrl": "https://context7.com/dashboard"
            }],
            "runner": "npx",
            "docsUrl": "https://github.com/upstash/context7",
            "verifiedAt": verified
        }),
        json!({
            "id": "fetch",
            "input": stdio("fetch", "uvx", &["mcp-server-fetch"]),
            "params": [],
            "secrets": [],
            "runner": "uvx",
            "docsUrl": "https://github.com/modelcontextprotocol/servers/tree/main/src/fetch",
            "verifiedAt": verified
        }),
        json!({
            "id": "filesystem",
            // argIndex 2 is the folder the user picks; there is no default path.
            "input": stdio("filesystem", "npx", &["-y", "@modelcontextprotocol/server-filesystem"]),
            "params": [{ "key": "allowedPath", "kind": "folder", "required": true, "argIndex": 2 }],
            "secrets": [],
            "runner": "npx",
            "docsUrl": "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem",
            "verifiedAt": verified
        }),
        json!({
            "id": "memory",
            "input": stdio("memory", "npx", &["-y", "@modelcontextprotocol/server-memory"]),
            "params": [],
            "secrets": [],
            "runner": "npx",
            "docsUrl": "https://github.com/modelcontextprotocol/servers/tree/main/src/memory",
            "verifiedAt": verified
        }),
        json!({
            "id": "sequential-thinking",
            "input": stdio(
                "sequential-thinking",
                "npx",
                &["-y", "@modelcontextprotocol/server-sequential-thinking"]
            ),
            "params": [],
            "secrets": [],
            "runner": "npx",
            "docsUrl": "https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking",
            "verifiedAt": verified
        }),
        json!({
            "id": "playwright",
            "input": stdio("playwright", "npx", &["@playwright/mcp@latest"]),
            "params": [],
            "secrets": [],
            "runner": "npx",
            "docsUrl": "https://github.com/microsoft/playwright-mcp",
            "verifiedAt": verified
        }),
        json!({
            "id": "github",
            "input": {
                "name": "github",
                "transport": "http",
                "url": "https://api.githubcopilot.com/mcp/",
                "source": { "kind": "template", "id": "github" }
            },
            "params": [],
            "secrets": [{
                "kind": "header",
                "name": "Authorization",
                "envVar": "GITHUB_PERSONAL_ACCESS_TOKEN",
                "headerTemplate": "bearer",
                "required": true,
                "helpUrl": "https://github.com/settings/personal-access-tokens"
            }],
            "runner": null,
            "docsUrl": "https://github.com/github/github-mcp-server",
            "verifiedAt": verified
        }),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn templates_match_the_contract_ids_and_never_carry_values() {
        let templates = list_templates();
        let ids = templates
            .iter()
            .map(|template| template["id"].as_str().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            ids,
            [
                "context7",
                "fetch",
                "filesystem",
                "memory",
                "sequential-thinking",
                "playwright",
                "github"
            ]
        );
        for template in &templates {
            assert_eq!(template["input"]["source"]["kind"], "template");
            assert_eq!(template["input"]["source"]["id"], template["id"]);
            for secret in template["secrets"].as_array().unwrap() {
                assert!(secret.get("value").is_none());
            }
        }
        assert_eq!(templates[6]["secrets"][0]["headerTemplate"], "bearer");
        assert_eq!(templates[2]["params"][0]["argIndex"], 2);
    }
}
