//! Acceptance tests for the v3.3 MCP library (docs/v3.3/mcp-contract.md §7.1).
//! Every test works in a private temp home with an in-memory environment
//! store: the real user's client configs and registry are never touched.

use super::*;
use crate::mcp_center::RegisteredWorkspace;
use crate::mcp_secrets::MemoryEnvStore;
use std::fs;

struct Fixture {
    root: PathBuf,
    ctx: McpLibraryContext,
    env: Arc<MemoryEnvStore>,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

impl Fixture {
    fn new(label: &str) -> Self {
        Self::with_windows(label, true)
    }

    fn with_windows(label: &str, windows: bool) -> Self {
        let root = std::env::temp_dir().join(format!(
            "ai-skillhub-mcp-library-{label}-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let home = root.join("home");
        for dir in [
            ".codex",
            ".claude",
            ".cursor",
            "AppData/Roaming/Claude",
            "AppData/Local",
        ] {
            fs::create_dir_all(home.join(dir)).unwrap();
        }
        let workspace = root.join("projects").join("Paper Lab");
        fs::create_dir_all(workspace.join(".codex")).unwrap();
        let mutation = McpMutationContext {
            home_dir: home.clone(),
            registered_workspaces: vec![RegisteredWorkspace {
                id: "ws-paper".to_string(),
                display_name: "Paper Lab".to_string(),
                path: workspace,
            }],
            private_state_dir: root.join("private"),
            claude_config_dir: None,
            app_data_dir: Some(home.join("AppData/Roaming")),
            local_app_data_dir: Some(home.join("AppData/Local")),
        };
        let env = Arc::new(MemoryEnvStore::new());
        let ctx = McpLibraryContext {
            mutation,
            db_path: root.join("private").join("skillhub-next.sqlite3"),
            windows,
            env: env.clone(),
            app_version: "test".to_string(),
        };
        Self { root, ctx, env }
    }

    fn home(&self) -> PathBuf {
        self.ctx.mutation.home_dir.clone()
    }

    fn codex(&self) -> PathBuf {
        self.home().join(".codex/config.toml")
    }

    fn claude(&self) -> PathBuf {
        self.home().join(".claude.json")
    }

    fn desktop(&self) -> PathBuf {
        self.home()
            .join("AppData/Roaming/Claude/claude_desktop_config.json")
    }

    fn cursor(&self) -> PathBuf {
        self.home().join(".cursor/mcp.json")
    }

    fn workspace(&self) -> PathBuf {
        self.ctx.mutation.registered_workspaces[0].path.clone()
    }

    fn import(&self) -> McpImportReport {
        import_from_clients(
            &self.ctx,
            McpImportRequest {
                reason: "first-run".to_string(),
                client_ids: None,
            },
        )
        .unwrap()
    }

    fn snapshot(&self) -> McpLibrarySnapshot {
        library_snapshot(&self.ctx).unwrap()
    }

    fn server_id(&self, name: &str) -> String {
        self.snapshot()
            .servers
            .iter()
            .find(|server| server.name == name)
            .unwrap_or_else(|| panic!("server {name} missing"))
            .id
            .clone()
    }

    fn cell(&self, name: &str, client: ClientId) -> McpCell {
        self.snapshot()
            .servers
            .iter()
            .find(|server| server.name == name)
            .unwrap()
            .cells
            .iter()
            .find(|cell| cell.client_id == client)
            .unwrap()
            .clone()
    }

    fn write_op(&self, outcome: Result<McpWriteOutcome, McpError>) -> McpWriteOutcome {
        prepare_write(&self.ctx).unwrap();
        outcome.unwrap()
    }
}

fn sha(path: &Path) -> String {
    fs::read(path)
        .map(|bytes| hex(&sha256_bytes(&[&bytes])))
        .unwrap_or_else(|_| "missing".to_string())
}

fn json_file(path: &Path) -> JsonValue {
    serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
}

fn done(outcome: &McpWriteOutcome) -> (&String, &Vec<McpClientResult>, &Option<String>) {
    match outcome {
        McpWriteOutcome::Done {
            operation_id,
            results,
            undo_token,
            ..
        } => (operation_id, results, undo_token),
        other => panic!(
            "expected done, got {}",
            serde_json::to_string(other).unwrap()
        ),
    }
}

fn confirmation(outcome: &McpWriteOutcome) -> &McpConfirmation {
    match outcome {
        McpWriteOutcome::NeedsConfirmation { confirmation } => confirmation,
        other => panic!(
            "expected needs-confirmation, got {}",
            serde_json::to_string(other).unwrap()
        ),
    }
}

fn stdio_input(name: &str, command: &str, args: &[&str]) -> McpServerInput {
    McpServerInput {
        name: name.to_string(),
        display_name: None,
        transport: Transport::Stdio,
        command: Some(command.to_string()),
        args: Some(args.iter().map(|arg| arg.to_string()).collect()),
        cwd: None,
        url: None,
        env: None,
        secrets: None,
        codex_required: None,
        source: McpServerSource::Manual,
    }
}

fn add(fixture: &Fixture, input: McpServerInput, clients: &[ClientId]) -> McpWriteOutcome {
    fixture.write_op(add_servers(
        &fixture.ctx,
        McpAddRequest {
            candidates: vec![McpAddCandidate {
                input,
                on_conflict: None,
            }],
            client_ids: clients.to_vec(),
            placement: None,
            paste_handle: None,
            confirm_token: None,
        },
    ))
}

const SAMPLE_CODEX: &str = r#"# my codex config
model = "gpt-test"

[mcp_servers.context7]
command = "npx"
args = ["-y", "@upstash/context7-mcp"]

[mcp_servers.fetch]
command = "uvx"
args = ["mcp-server-fetch"]
enabled = false

[mcp_servers."team.docs"]
url = "https://docs.example.test/mcp"
bearer_token_env_var = "DOCS_TOKEN"

[mcp_servers.structured]
command = "npx"
env_vars = [{ name = "REMOTE_TOKEN", source = "remote" }]
"#;

/// R1: import reads every client and writes nothing outside SQLite.
#[test]
fn first_import_reads_all_clients_without_touching_files() {
    let fixture = Fixture::new("r1");
    fs::write(fixture.codex(), SAMPLE_CODEX).unwrap();
    let local_key = fixture.workspace().to_string_lossy().replace('\\', "/");
    fs::write(
        fixture.claude(),
        serde_json::to_string_pretty(&json!({
            "numStartups": 3,
            "mcpServers": {
                "context7": {"type": "stdio", "command": "npx", "args": ["-y", "@upstash/context7-mcp"], "env": {}},
                "memory": {"type": "stdio", "command": "cmd", "args": ["/c", "npx", "-y", "@modelcontextprotocol/server-memory"], "env": {}}
            },
            "projects": {
                local_key: {"mcpServers": {"local-only": {"type": "stdio", "command": "node", "args": ["server.js"]}}}
            }
        }))
        .unwrap(),
    )
    .unwrap();
    fs::write(
        fixture.desktop(),
        "{\n    \"preferences\": {\"x\": 1},\n    \"mcpServers\": {\n        \"memory\": {\"command\": \"npx\", \"args\": [\"-y\", \"@modelcontextprotocol/server-memory\"]}\n    }\n}\n",
    )
    .unwrap();
    fs::write(
        fixture.cursor(),
        r#"{"mcpServers":{"context7":{"command":"npx","args":["-y","@upstash/context7-mcp","--other"]}}}"#,
    )
    .unwrap();
    let paths = [
        fixture.codex(),
        fixture.claude(),
        fixture.desktop(),
        fixture.cursor(),
    ];
    let before = paths.iter().map(|path| sha(path)).collect::<Vec<_>>();

    assert!(!fixture.snapshot().library_initialized);
    let report = fixture.import();
    let after = paths.iter().map(|path| sha(path)).collect::<Vec<_>>();
    assert_eq!(before, after, "import must not touch client files");
    assert!(!report.wrote_client_files);
    assert_eq!(report.files_read.len(), 4 + 1);
    let mut added = report.added.clone();
    added.sort();
    assert_eq!(
        added,
        ["context7", "fetch", "local-only", "memory", "team.docs"]
    );
    assert!(report
        .merged
        .iter()
        .any(|item| item.name == "context7" && item.client_ids == [ClientId::ClaudeCode]));
    assert!(report
        .merged
        .iter()
        .any(|item| item.name == "memory" && item.client_ids == [ClientId::ClaudeDesktop]));
    assert!(report
        .differing
        .iter()
        .any(|item| item.name == "context7" && item.client_ids == [ClientId::Cursor]));
    assert!(report
        .skipped
        .iter()
        .any(|skip| skip.name == "structured" && skip.reason == "codex-structured-env"));
    let snapshot = fixture.snapshot();
    assert!(snapshot.library_initialized);
    assert_eq!(fixture.cell("context7", ClientId::Codex).state, "on");
    assert_eq!(fixture.cell("context7", ClientId::ClaudeCode).state, "on");
    let fetch = fixture.cell("fetch", ClientId::Codex);
    assert_eq!(fetch.state, "off");
    assert!(fetch.disabled_in_file);
    assert_eq!(
        fixture
            .cell("team.docs", ClientId::ClaudeCode)
            .reason
            .as_deref(),
        Some("name-incompatible")
    );
    let codex_struct = fixture.cell("context7", ClientId::Codex);
    assert_eq!(codex_struct.project_count, 0);
    let local = snapshot
        .servers
        .iter()
        .find(|server| server.name == "local-only")
        .unwrap();
    assert_eq!(local.project_bindings.len(), 1);
    assert_eq!(local.project_bindings[0].project_label, "Paper Lab");
    // Memory imported from the wrapped Claude entry is stored unwrapped.
    let detail = get_server(
        &fixture.ctx,
        McpGetServerRequest {
            server_id: fixture.server_id("memory"),
        },
    )
    .unwrap();
    assert_eq!(detail.command.as_deref(), Some("npx"));
    let serialized = serde_json::to_string(&snapshot).unwrap();
    assert!(!serialized.contains(&fixture.home().to_string_lossy().to_string()));
}

/// R2: same name + same content merges flags; different content is marked.
#[test]
fn import_same_name_same_spec_merges_flags_and_different_spec_marks_changed_outside() {
    let fixture = Fixture::new("r2");
    fs::write(
        fixture.codex(),
        "[mcp_servers.context7]\ncommand = \"npx\"\nargs = [\"-y\", \"@upstash/context7-mcp\"]\n",
    )
    .unwrap();
    fs::write(
        fixture.cursor(),
        r#"{"mcpServers":{"context7":{"command":"npx","args":["-y","@upstash/context7-mcp","--debug"]}}}"#,
    )
    .unwrap();
    fs::write(
        fixture.claude(),
        r#"{"mcpServers":{"context7":{"type":"stdio","command":"cmd","args":["/c","npx","-y","@upstash/context7-mcp"],"env":{}}}}"#,
    )
    .unwrap();
    let report = fixture.import();
    assert_eq!(report.added, ["context7"]);
    assert_eq!(report.merged[0].client_ids, [ClientId::ClaudeCode]);
    assert_eq!(report.differing[0].client_ids, [ClientId::Cursor]);
    assert_eq!(fixture.cell("context7", ClientId::Codex).state, "on");
    assert_eq!(fixture.cell("context7", ClientId::ClaudeCode).state, "on");
    let cursor = fixture.cell("context7", ClientId::Cursor);
    assert_eq!(cursor.state, "changed-outside");
    assert_eq!(cursor.reason.as_deref(), Some("entry-edited-outside"));
}

/// R3: Codex disable writes `enabled = false`; undo restores the bytes.
#[test]
fn codex_cell_disable_writes_enabled_false_and_undo_is_byte_identical() {
    let fixture = Fixture::new("r3");
    let original = "# keep me\n[mcp_servers.context7]\ncommand = \"npx\" # inline\nargs = [\"-y\", \"@upstash/context7-mcp\"]\nstartup_timeout_sec = 30\n";
    fs::write(fixture.codex(), original).unwrap();
    fixture.import();
    let id = fixture.server_id("context7");
    let outcome = fixture.write_op(set_cell(
        &fixture.ctx,
        McpSetCellRequest {
            server_id: id.clone(),
            client_id: ClientId::Codex,
            enabled: false,
            allow_inline: None,
            confirm_token: None,
        },
    ));
    let (_, results, undo_token) = done(&outcome);
    assert_eq!(results[0].status, "written");
    assert!(results[0].restart_hint);
    let written = fs::read_to_string(fixture.codex()).unwrap();
    assert!(written.contains("enabled = false"));
    assert!(written.contains("# keep me"));
    assert!(written.contains("startup_timeout_sec = 30"));
    assert!(!written.contains("required"));
    assert!(!written.contains("env_http_headers"));
    let cell = fixture.cell("context7", ClientId::Codex);
    assert_eq!(cell.state, "off");
    assert!(cell.disabled_in_file);
    let undo_outcome = fixture.write_op(undo(
        &fixture.ctx,
        McpUndoRequest {
            undo_token: undo_token.clone().unwrap(),
        },
    ));
    let (_, results, _) = done(&undo_outcome);
    assert_eq!(results[0].status, "undone");
    assert_eq!(fs::read_to_string(fixture.codex()).unwrap(), original);
    assert_eq!(fixture.cell("context7", ClientId::Codex).state, "on");
}

/// R4: Claude disable removes the entry, the library keeps the spec, and
/// re-enabling restores the entry field for field (unknown keys included).
#[test]
fn claude_cell_disable_removes_entry_keeps_spec_and_reenable_restores_entry_field_for_field() {
    let fixture = Fixture::new("r4");
    let original = "{\n  \"theme\": \"dark\",\n  \"mcpServers\": {\n    \"github\": {\n      \"type\": \"http\",\n      \"url\": \"https://api.githubcopilot.com/mcp/\",\n      \"headers\": {\n        \"Authorization\": \"Bearer ${GITHUB_PAT}\"\n      },\n      \"headersHelper\": \"/opt/helper.sh\",\n      \"oauth\": {\n        \"clientId\": \"abc\"\n      }\n    }\n  },\n  \"zLast\": true\n}\n";
    fs::write(fixture.claude(), original).unwrap();
    fixture.import();
    let id = fixture.server_id("github");
    let before_entry = json_file(&fixture.claude())["mcpServers"]["github"].clone();
    let disable = fixture.write_op(set_cell(
        &fixture.ctx,
        McpSetCellRequest {
            server_id: id.clone(),
            client_id: ClientId::ClaudeCode,
            enabled: false,
            allow_inline: None,
            confirm_token: None,
        },
    ));
    done(&disable);
    let after_disable = json_file(&fixture.claude());
    assert!(after_disable["mcpServers"].get("github").is_none());
    assert_eq!(after_disable["theme"], "dark");
    assert_eq!(fixture.cell("github", ClientId::ClaudeCode).state, "off");
    let enable = fixture.write_op(set_cell(
        &fixture.ctx,
        McpSetCellRequest {
            server_id: id,
            client_id: ClientId::ClaudeCode,
            enabled: true,
            allow_inline: None,
            confirm_token: None,
        },
    ));
    done(&enable);
    let restored = json_file(&fixture.claude())["mcpServers"]["github"].clone();
    assert_eq!(restored, before_entry);
    // Field for field and in the same order: the file is byte-identical.
    assert_eq!(fs::read_to_string(fixture.claude()).unwrap(), original);
    assert_eq!(fixture.cell("github", ClientId::ClaudeCode).state, "on");
}

/// R5 + R7: Desktop and Cursor writers keep unknown keys, order and indent;
/// the npx family is wrapped with cmd /c for Claude clients only.
#[test]
fn desktop_and_cursor_writers_preserve_unknown_top_level_keys_order_and_indent() {
    let fixture = Fixture::new("r5");
    let desktop = "{\n    \"preferences\": {\n        \"menuBarEnabled\": false\n    },\n    \"coworkUserFilesPath\": \"D:\\\\Work\",\n    \"mcpServers\": {}\n}\n";
    fs::write(fixture.desktop(), desktop).unwrap();
    fs::write(
        fixture.cursor(),
        "{\n\t\"zeta\": 1,\n\t\"mcpServers\": {}\n}",
    )
    .unwrap();
    fixture.import();
    let outcome = add(
        &fixture,
        stdio_input(
            "memory",
            "npx",
            &["-y", "@modelcontextprotocol/server-memory"],
        ),
        &[
            ClientId::ClaudeDesktop,
            ClientId::Cursor,
            ClientId::ClaudeCode,
            ClientId::Codex,
        ],
    );
    let (_, results, _) = done(&outcome);
    assert!(
        results.iter().all(|result| result.status == "written"),
        "{results:?}"
    );
    let desktop_text = fs::read_to_string(fixture.desktop()).unwrap();
    assert!(desktop_text.starts_with("{\n    \"preferences\": {\n        \"menuBarEnabled\": false\n    },\n    \"coworkUserFilesPath\""));
    assert!(desktop_text.ends_with("}\n"));
    let desktop_json: JsonValue = serde_json::from_str(&desktop_text).unwrap();
    assert_eq!(desktop_json["mcpServers"]["memory"]["command"], "cmd");
    assert_eq!(
        desktop_json["mcpServers"]["memory"]["args"],
        json!(["/c", "npx", "-y", "@modelcontextprotocol/server-memory"])
    );
    assert!(desktop_json["mcpServers"]["memory"].get("type").is_none());
    let cursor_text = fs::read_to_string(fixture.cursor()).unwrap();
    assert!(cursor_text.starts_with("{\n\t\"zeta\": 1,\n\t\"mcpServers\""));
    assert!(!cursor_text.ends_with('\n'));
    let cursor_json: JsonValue = serde_json::from_str(&cursor_text).unwrap();
    assert_eq!(cursor_json["mcpServers"]["memory"]["command"], "npx");
    let claude_json = json_file(&fixture.claude());
    assert_eq!(claude_json["mcpServers"]["memory"]["command"], "cmd");
    assert_eq!(claude_json["mcpServers"]["memory"]["type"], "stdio");
    let codex = fs::read_to_string(fixture.codex()).unwrap();
    assert!(codex.contains("command = \"npx\""));
    for client in ClientId::ALL {
        assert_eq!(fixture.cell("memory", client).state, "on", "{client:?}");
    }
}

/// R7 (platform as a parameter): no wrapping off Windows.
#[test]
fn windows_family_commands_wrapped_for_claude_clients_only_and_unwrapped_on_import() {
    let fixture = Fixture::with_windows("r7", false);
    fixture.import();
    add(
        &fixture,
        stdio_input(
            "memory",
            "npx",
            &["-y", "@modelcontextprotocol/server-memory"],
        ),
        &[ClientId::ClaudeCode],
    );
    assert_eq!(
        json_file(&fixture.claude())["mcpServers"]["memory"]["command"],
        "npx"
    );

    let windows = Fixture::new("r7w");
    fs::write(
        windows.claude(),
        r#"{"mcpServers":{"memory":{"type":"stdio","command":"npx","args":["-y","@modelcontextprotocol/server-memory"],"env":{}}}}"#,
    )
    .unwrap();
    windows.import();
    // An unwrapped Claude entry is equal in meaning: on + windows fix offered.
    let cell = windows.cell("memory", ClientId::ClaudeCode);
    assert_eq!(cell.state, "on");
    assert!(cell.windows_fix_available);
    assert!(windows
        .snapshot()
        .issues
        .iter()
        .any(|issue| issue.kind == "windows-fix"));
    let outcome = windows.write_op(resync(&windows.ctx, McpResyncRequest::default()));
    done(&outcome);
    assert_eq!(
        json_file(&windows.claude())["mcpServers"]["memory"]["command"],
        "cmd"
    );
    assert!(
        !windows
            .cell("memory", ClientId::ClaudeCode)
            .windows_fix_available
    );
}

/// R8: `cmd` only as `cmd /c <family runner>` without shell metacharacters.
#[test]
fn validate_command_with_args_accepts_only_cmd_slash_c_runner() {
    let args = |values: &[&str]| {
        values
            .iter()
            .map(|value| value.to_string())
            .collect::<Vec<_>>()
    };
    assert!(engine::validate_command_with_args("cmd", &args(&["/c", "npx", "-y", "pkg"])).is_ok());
    assert!(
        engine::validate_command_with_args("cmd.exe", &args(&["/C", "npx.cmd", "-y", "pkg"]))
            .is_ok()
    );
    for (command, values) in [
        ("cmd", &[][..]),
        ("cmd", &["/k", "npx"][..]),
        ("cmd", &["/c", "powershell", "-c", "calc"][..]),
        ("cmd", &["/c", "npx", "a&calc"][..]),
        ("cmd", &["/c", "npx", "%PATH%"][..]),
        ("cmd", &["/c", "npx", "^x"][..]),
        ("cmd", &["/s", "/c", "npx"][..]),
        ("powershell", &["-c", "npx"][..]),
    ] {
        assert!(
            engine::validate_command_with_args(command, &args(values)).is_err(),
            "{command} {values:?}"
        );
    }
    assert!(engine::validate_command("cmd").is_err());
    assert!(engine::validate_command_with_args("npx", &args(&["-y", "pkg"])).is_ok());
}

/// R9: Codex stdio never gets env_http_headers or required = false, and the
/// strict validator rejects both transport mixes.
#[test]
fn codex_stdio_never_writes_env_http_headers_or_required_false() {
    let fixture = Fixture::new("r9");
    fixture.import();
    let mut input = stdio_input("demo", "npx", &["-y", "demo-mcp"]);
    input.secrets = Some(vec![McpSecretInput {
        kind: "env".to_string(),
        name: "DEMO_TOKEN".to_string(),
        env_var: None,
        header_template: None,
        value: None,
        paste_value_handle: None,
        mode: "user_env".to_string(),
        inline_clients: None,
        required: Some(true),
    }]);
    add(&fixture, input, &[ClientId::Codex]);
    let written = fs::read_to_string(fixture.codex()).unwrap();
    assert!(!written.contains("env_http_headers"));
    assert!(!written.contains("required"));
    assert!(!written.contains("enabled"));
    assert!(written.contains("env_vars = [\"DEMO_TOKEN\"]"));
    assert!(crate::mcp_center::validate_codex_mcp_config(&written));
    assert!(!crate::mcp_center::validate_codex_mcp_config(
        "[mcp_servers.x]\ncommand = \"npx\"\nenv_http_headers = {}\n"
    ));
    assert!(!crate::mcp_center::validate_codex_mcp_config(
        "[mcp_servers.x]\nurl = \"https://x.test/mcp\"\nenv = { A = \"b\" }\n"
    ));
    assert!(!crate::mcp_center::validate_codex_mcp_config(
        "[mcp_servers.x]\nurl = \"https://x.test/mcp\"\ncwd = \"C:/x\"\n"
    ));
    // A config an older version wrote with noise stays editable (lenient read).
    assert!(crate::mcp_center::codex_mcp_config_readable(
        "[mcp_servers.x]\ncommand = \"npx\"\nenv_http_headers = {}\nrequired = false\n"
    ));
}

/// R10: a transport switch removes keys invalid for the new transport and
/// keeps unknown valid ones.
#[test]
fn codex_transport_switch_removes_incompatible_keys_and_keeps_unknown_valid_ones() {
    let fixture = Fixture::new("r10");
    fs::write(
        fixture.codex(),
        "[mcp_servers.docs]\ncommand = \"uvx\"\nargs = [\"docs-mcp\"]\nenv = { MODE = \"fast\" }\nstartup_timeout_sec = 45\nenv_http_headers = {}\nrequired = false\n",
    )
    .unwrap();
    fixture.import();
    let id = fixture.server_id("docs");
    let detail = get_server(
        &fixture.ctx,
        McpGetServerRequest {
            server_id: id.clone(),
        },
    )
    .unwrap();
    let outcome = fixture.write_op(update_server(
        &fixture.ctx,
        McpUpdateRequest {
            server_id: id,
            input: McpServerInput {
                name: "docs".to_string(),
                display_name: None,
                transport: Transport::Http,
                command: None,
                args: None,
                cwd: None,
                url: Some("https://docs.example.test/mcp".to_string()),
                env: None,
                secrets: None,
                codex_required: None,
                source: McpServerSource::Manual,
            },
            expected_revision: detail.spec_revision,
            confirm_token: None,
        },
    ));
    let outcome = match outcome {
        McpWriteOutcome::NeedsConfirmation { confirmation } => {
            // The noisy entry differs from what SkillHub expects: confirm.
            fixture.write_op(update_server(
                &fixture.ctx,
                McpUpdateRequest {
                    server_id: fixture.server_id("docs"),
                    input: McpServerInput {
                        name: "docs".to_string(),
                        display_name: None,
                        transport: Transport::Http,
                        command: None,
                        args: None,
                        cwd: None,
                        url: Some("https://docs.example.test/mcp".to_string()),
                        env: None,
                        secrets: None,
                        codex_required: None,
                        source: McpServerSource::Manual,
                    },
                    expected_revision: detail.spec_revision,
                    confirm_token: Some(confirmation.confirm_token.clone()),
                },
            ))
        }
        other => other,
    };
    done(&outcome);
    let written = fs::read_to_string(fixture.codex()).unwrap();
    let document = written.parse::<toml_edit::DocumentMut>().unwrap();
    let entry = document["mcp_servers"]["docs"].as_table().unwrap();
    assert_eq!(entry["url"].as_str(), Some("https://docs.example.test/mcp"));
    for removed in ["command", "args", "env", "env_http_headers", "required"] {
        assert!(entry.get(removed).is_none(), "{removed} should be gone");
    }
    assert_eq!(entry["startup_timeout_sec"].as_integer(), Some(45));
    assert!(crate::mcp_center::validate_codex_mcp_config(&written));
}

/// R11: Claude local scope uses the forward-slash key, matches an existing
/// equivalent key and refuses ambiguous ones.
#[test]
fn claude_local_scope_uses_forward_slash_key_matches_existing_and_refuses_ambiguous() {
    let fixture = Fixture::new("r11");
    fs::write(fixture.claude(), "{\"projects\": {}}\n").unwrap();
    fixture.import();
    let placement = Some(McpPlacement {
        scope: Scope::Local,
        workspace_id: Some("ws-paper".to_string()),
    });
    let outcome = fixture.write_op(add_servers(
        &fixture.ctx,
        McpAddRequest {
            candidates: vec![McpAddCandidate {
                input: stdio_input("local-one", "node", &["server.js"]),
                on_conflict: None,
            }],
            client_ids: vec![ClientId::ClaudeCode],
            placement: placement.clone(),
            paste_handle: None,
            confirm_token: None,
        },
    ));
    done(&outcome);
    let json = json_file(&fixture.claude());
    let forward = fixture.workspace().to_string_lossy().replace('\\', "/");
    assert!(json["projects"][forward.as_str()]["mcpServers"]["local-one"].is_object());

    // An existing backslash key is matched instead of duplicated.
    let backslash = fixture.workspace().to_string_lossy().replace('/', "\\");
    fs::write(
        fixture.claude(),
        serde_json::to_string(&json!({"projects": {backslash.clone(): {"allowedTools": []}}}))
            .unwrap(),
    )
    .unwrap();
    let outcome = fixture.write_op(add_servers(
        &fixture.ctx,
        McpAddRequest {
            candidates: vec![McpAddCandidate {
                input: stdio_input("local-two", "node", &["two.js"]),
                on_conflict: None,
            }],
            client_ids: vec![ClientId::ClaudeCode],
            placement: placement.clone(),
            paste_handle: None,
            confirm_token: None,
        },
    ));
    done(&outcome);
    let json = json_file(&fixture.claude());
    let projects = json["projects"].as_object().unwrap();
    if cfg!(windows) {
        assert_eq!(projects.len(), 1);
        assert!(projects[&backslash]["mcpServers"]["local-two"].is_object());
    }

    // Two equivalent keys that both carry mcpServers: refuse, never guess.
    if cfg!(windows) {
        fs::write(
            fixture.claude(),
            serde_json::to_string(&json!({"projects": {
                backslash.clone(): {"mcpServers": {"a": {"command": "node"}}},
                forward.clone(): {"mcpServers": {"b": {"command": "node"}}}
            }}))
            .unwrap(),
        )
        .unwrap();
        let before = sha(&fixture.claude());
        let outcome = fixture.write_op(add_servers(
            &fixture.ctx,
            McpAddRequest {
                candidates: vec![McpAddCandidate {
                    input: stdio_input("local-three", "node", &["three.js"]),
                    on_conflict: None,
                }],
                client_ids: vec![ClientId::ClaudeCode],
                placement,
                paste_handle: None,
                confirm_token: None,
            },
        ));
        let (_, results, _) = done(&outcome);
        assert!(results.iter().any(|result| result.skipped_reason.as_deref()
            == Some("config-ambiguous-project")
            || result
                .error
                .as_ref()
                .is_some_and(|error| error.code == "config-ambiguous-project")));
        assert_eq!(sha(&fixture.claude()), before);
    }
}

/// R12: a one-entry change on a 40-key `~/.claude.json` touches only that
/// entry's lines.
#[test]
fn claude_json_single_entry_change_touches_only_that_entry() {
    let fixture = Fixture::new("r12");
    let mut root = serde_json::Map::new();
    let mut text = String::from("{\n");
    for index in 0..40 {
        let key = format!("zKey{:02}", 39 - index);
        text.push_str(&format!("  \"{key}\": {{\n    \"value\": {index},\n    \"list\": [\n      \"a\",\n      \"b\"\n    ]\n  }},\n"));
        root.insert(key, json!(index));
    }
    text.push_str("  \"mcpServers\": {\n    \"keep\": {\n      \"type\": \"stdio\",\n      \"command\": \"node\",\n      \"args\": [\n        \"keep.js\"\n      ],\n      \"env\": {}\n    }\n  }\n}\n");
    fs::write(fixture.claude(), &text).unwrap();
    fixture.import();
    add(
        &fixture,
        stdio_input("added", "uvx", &["added-mcp"]),
        &[ClientId::ClaudeCode],
    );
    let after = fs::read_to_string(fixture.claude()).unwrap();
    let before_lines = text.lines().collect::<Vec<_>>();
    let after_lines = after.lines().collect::<Vec<_>>();
    // Everything before the new entry is byte-identical, line for line.
    let keep_end = before_lines.len() - 2; // "  }" closing mcpServers, then "}"
    assert_eq!(&after_lines[..keep_end - 1], &before_lines[..keep_end - 1]);
    assert_eq!(after_lines[keep_end - 1], "    },");
    assert!(after_lines[keep_end].contains("\"added\""));
    // Every line of the original survives; only lines were added.
    assert!(before_lines.iter().all(|line| after_lines.contains(line)));
    assert!(after_lines.len() > before_lines.len());
}

/// R13: `${NAME}` env and `Bearer ${NAME}` headers are references with
/// presence, not inline secrets.
#[test]
fn claude_dollar_brace_env_and_bearer_headers_are_references_with_presence() {
    let fixture = Fixture::new("r13");
    fs::write(
        fixture.claude(),
        r#"{"mcpServers":{
            "local":{"type":"stdio","command":"npx","args":["-y","pkg"],"env":{"API_KEY":"${API_KEY}","MODE":"fast"}},
            "remote":{"type":"http","url":"https://x.test/mcp","headers":{"Authorization":"Bearer ${REMOTE_TOKEN}","X-Raw":"${RAW_HEADER}"}}
        }}"#,
    )
    .unwrap();
    fixture.env.set("API_KEY", "present-value").unwrap();
    fixture.import();
    let snapshot = fixture.snapshot();
    let local = snapshot
        .servers
        .iter()
        .find(|server| server.name == "local")
        .unwrap();
    assert_eq!(local.secrets.len(), 1);
    assert_eq!(local.secrets[0].storage, "external");
    assert!(local.secrets[0].present);
    let remote = snapshot
        .servers
        .iter()
        .find(|server| server.name == "remote")
        .unwrap();
    let bearer = remote
        .secrets
        .iter()
        .find(|secret| secret.name == "Authorization")
        .unwrap();
    assert_eq!(bearer.header_template.as_deref(), Some("bearer"));
    assert_eq!(bearer.env_var.as_deref(), Some("REMOTE_TOKEN"));
    assert!(!bearer.present);
    assert_eq!(remote.missing_secret_count, 2);
    assert_eq!(fixture.cell("local", ClientId::ClaudeCode).state, "on");
    assert_eq!(fixture.cell("remote", ClientId::ClaudeCode).state, "on");

    // The read-only scanner agrees (bug MCP#7).
    let inventory = crate::mcp_center::scan_read_only(
        &crate::mcp_center::McpScanRequest::for_home(fixture.home()),
    );
    let requirement = |name: &str| {
        inventory
            .secret_requirements
            .iter()
            .find(|requirement| requirement.key_name == name)
            .unwrap_or_else(|| panic!("{name}"))
            .clone()
    };
    assert_eq!(requirement("API_KEY").use_kind, "process-env");
    assert_eq!(requirement("REMOTE_TOKEN").use_kind, "bearer-token-env");
    assert_eq!(requirement("RAW_HEADER").use_kind, "http-header-env");
    assert_eq!(requirement("MODE").presence_state, "inline-value-present");
}

/// R14: one client's failure never rolls back another client's write.
#[test]
fn per_client_failure_is_isolated() {
    let fixture = Fixture::new("r14");
    fs::write(fixture.cursor(), "{\"mcpServers\": {}}\n").unwrap();
    fixture.import();
    let codex_before = sha(&fixture.codex());
    // The Cursor file changes (its managed entry too) at the final boundary.
    engine::install_atomic_replace_test_hook(
        fixture.home().join(".cursor").join("mcp.json"),
        br#"{"mcpServers":{"memory":{"command":"other"}}}"#.to_vec(),
    );
    let outcome = add(
        &fixture,
        stdio_input(
            "memory",
            "npx",
            &["-y", "@modelcontextprotocol/server-memory"],
        ),
        &[ClientId::Codex, ClientId::ClaudeCode, ClientId::Cursor],
    );
    let (_, results, _) = done(&outcome);
    let status = |client: ClientId| {
        results
            .iter()
            .find(|result| result.client_id == client)
            .unwrap()
            .status
            .clone()
    };
    assert_eq!(status(ClientId::Codex), "written");
    assert_eq!(status(ClientId::ClaudeCode), "written");
    assert_eq!(status(ClientId::Cursor), "failed");
    let cursor_error = results
        .iter()
        .find(|result| result.client_id == ClientId::Cursor)
        .unwrap()
        .error
        .clone()
        .unwrap();
    assert_eq!(cursor_error.code, "config-changed");
    assert_ne!(sha(&fixture.codex()), codex_before);
    assert!(fs::read_to_string(fixture.codex())
        .unwrap()
        .contains("[mcp_servers.memory]"));
    assert_eq!(fixture.cell("memory", ClientId::Codex).state, "on");
    assert_eq!(fixture.cell("memory", ClientId::Cursor).state, "error");
    if let McpWriteOutcome::Done { summary, .. } = &outcome {
        assert_eq!(summary.failed_client_ids, [ClientId::Cursor]);
    }
}

/// R15: removal always asks first; the token is bound to content, so an
/// external edit yields a fresh descriptor instead of an error.
#[test]
fn remove_requires_confirmation_and_token_is_content_bound() {
    let fixture = Fixture::new("r15");
    fs::write(
        fixture.codex(),
        "[mcp_servers.context7]\ncommand = \"npx\"\nargs = [\"-y\", \"@upstash/context7-mcp\"]\n",
    )
    .unwrap();
    fixture.import();
    let id = fixture.server_id("context7");
    let request = |token: Option<String>| McpRemoveRequest {
        server_id: id.clone(),
        from: McpRemoveFrom::Library,
        delete_env_vars: None,
        confirm_token: token,
    };
    let first = fixture.write_op(remove_server(&fixture.ctx, request(None)));
    let token = confirmation(&first).confirm_token.clone();
    assert_eq!(confirmation(&first).kinds, ["remove-from-library"]);
    assert_eq!(confirmation(&first).items[0].action, "remove");
    // External edit after the dialog opened.
    fs::write(
        fixture.codex(),
        "[mcp_servers.context7]\ncommand = \"npx\"\nargs = [\"-y\", \"@upstash/context7-mcp\"]\n# edited\n",
    )
    .unwrap();
    let second = fixture.write_op(remove_server(&fixture.ctx, request(Some(token))));
    let fresh = confirmation(&second).confirm_token.clone();
    let third = fixture.write_op(remove_server(&fixture.ctx, request(Some(fresh))));
    done(&third);
    assert!(!fs::read_to_string(fixture.codex())
        .unwrap()
        .contains("context7"));
    assert!(fixture.snapshot().servers.is_empty());
}

/// R16: overwriting a same-name entry with different content asks first,
/// unless the batch list's explicit "覆盖" choice was made.
#[test]
fn overwrite_same_name_different_requires_confirmation_but_batch_overwrite_choice_counts() {
    let fixture = Fixture::new("r16");
    fs::write(
        fixture.cursor(),
        r#"{"mcpServers":{"memory":{"command":"node","args":["old.js"]}}}"#,
    )
    .unwrap();
    let new_input = stdio_input(
        "memory",
        "npx",
        &["-y", "@modelcontextprotocol/server-memory"],
    );
    let first = add(&fixture, new_input.clone(), &[ClientId::Cursor]);
    let descriptor = confirmation(&first);
    assert_eq!(descriptor.kinds, ["overwrite-different"]);
    let item = &descriptor.items[0];
    assert_eq!(
        item.before.as_ref().unwrap().target_display,
        "node · old.js"
    );
    assert_eq!(
        item.after.as_ref().unwrap().target_display,
        "npx · @modelcontextprotocol/server-memory"
    );
    assert!(item.changed_fields.contains(&"command".to_string()));
    assert!(item.changed_fields.contains(&"args".to_string()));
    let outcome = fixture.write_op(add_servers(
        &fixture.ctx,
        McpAddRequest {
            candidates: vec![McpAddCandidate {
                input: new_input,
                on_conflict: Some("overwrite".to_string()),
            }],
            client_ids: vec![ClientId::Cursor],
            placement: None,
            paste_handle: None,
            confirm_token: None,
        },
    ));
    done(&outcome);
    assert_eq!(
        json_file(&fixture.cursor())["mcpServers"]["memory"]["command"],
        "npx"
    );
}

/// R17: undo after Claude rewrote unrelated keys reverts only the touched
/// entries (bug MCP#3).
#[test]
fn undo_after_claude_rewrites_unrelated_keys_reverts_only_touched_entries() {
    let fixture = Fixture::new("r17");
    fs::write(
        fixture.claude(),
        "{\n  \"numStartups\": 1,\n  \"mcpServers\": {}\n}\n",
    )
    .unwrap();
    fixture.import();
    let outcome = add(
        &fixture,
        stdio_input("context7", "npx", &["-y", "@upstash/context7-mcp"]),
        &[ClientId::ClaudeCode],
    );
    let (_, _, undo_token) = done(&outcome);
    // Claude Code starts and rewrites its own keys.
    let mut json = json_file(&fixture.claude());
    json["numStartups"] = json!(2);
    json["tipsHistory"] = json!({"a": 1});
    fs::write(
        fixture.claude(),
        serde_json::to_string_pretty(&json).unwrap(),
    )
    .unwrap();
    let undone = fixture.write_op(undo(
        &fixture.ctx,
        McpUndoRequest {
            undo_token: undo_token.clone().unwrap(),
        },
    ));
    let (_, results, _) = done(&undone);
    assert_eq!(results[0].status, "undone");
    let json = json_file(&fixture.claude());
    assert!(json["mcpServers"].get("context7").is_none());
    assert_eq!(json["numStartups"], 2);
    assert_eq!(json["tipsHistory"]["a"], 1);
    assert!(fixture.snapshot().servers.is_empty());
}

/// R18: an entry changed after the operation is a per-client conflict; the
/// other clients still undo.
#[test]
fn undo_reports_conflict_per_client_when_entry_changed_after_apply() {
    let fixture = Fixture::new("r18");
    fixture.import();
    let outcome = add(
        &fixture,
        stdio_input("context7", "npx", &["-y", "@upstash/context7-mcp"]),
        &[ClientId::Codex, ClientId::Cursor],
    );
    let (_, _, undo_token) = done(&outcome);
    let mut cursor = json_file(&fixture.cursor());
    cursor["mcpServers"]["context7"]["args"] = json!(["-y", "@upstash/context7-mcp", "--edited"]);
    fs::write(fixture.cursor(), serde_json::to_string(&cursor).unwrap()).unwrap();
    let undone = fixture.write_op(undo(
        &fixture.ctx,
        McpUndoRequest {
            undo_token: undo_token.clone().unwrap(),
        },
    ));
    let (_, results, _) = done(&undone);
    let codex = results
        .iter()
        .find(|result| result.client_id == ClientId::Codex)
        .unwrap();
    assert_eq!(codex.status, "undone");
    let conflict = results
        .iter()
        .find(|result| result.client_id == ClientId::Cursor)
        .unwrap();
    assert_eq!(conflict.status, "failed");
    assert_eq!(conflict.error.as_ref().unwrap().code, "undo-conflict");
    // Codex had no config before the add: undo removes the file it created.
    assert!(fs::read_to_string(fixture.codex())
        .map(|text| !text.contains("context7"))
        .unwrap_or(true));
    assert!(fs::read_to_string(fixture.cursor())
        .unwrap()
        .contains("--edited"));
}

const SENTINEL: &str = "S3NT1NEL-7f3a9c2e1d";

fn assert_no_sentinel(label: &str, text: &str) {
    assert!(!text.contains(SENTINEL), "sentinel leaked in {label}");
}

fn files_under(path: &Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
    if let Ok(entries) = fs::read_dir(path) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                found.extend(files_under(&path));
            } else {
                found.push(path);
            }
        }
    }
    found
}

/// R21: the sentinel secret appears only in the in-memory env store, the
/// DPAPI-decrypted spec and undo data, and client files with inline consent.
#[test]
fn sentinel_secret_never_leaks_outside_allowed_stores() {
    let fixture = Fixture::new("r21");
    fixture.import();
    let mut input = stdio_input("sentinel", "npx", &["-y", "sentinel-mcp"]);
    input.secrets = Some(vec![McpSecretInput {
        kind: "env".to_string(),
        name: "SENTINEL_TOKEN".to_string(),
        env_var: None,
        header_template: None,
        value: Some(SENTINEL.to_string()),
        paste_value_handle: None,
        mode: "user_env".to_string(),
        inline_clients: None,
        required: Some(true),
    }]);
    let outcome = add(
        &fixture,
        input,
        &[
            ClientId::Codex,
            ClientId::ClaudeCode,
            ClientId::ClaudeDesktop,
            ClientId::Cursor,
        ],
    );
    assert_no_sentinel("add outcome", &serde_json::to_string(&outcome).unwrap());
    let (_, results, _) = done(&outcome);
    // Desktop has no references: blocked until inline consent.
    assert!(results
        .iter()
        .any(|result| result.client_id == ClientId::ClaudeDesktop
            && result.skipped_reason.as_deref() == Some("needs-inline-consent")));
    assert!(fixture
        .env
        .snapshot_values()
        .contains(&SENTINEL.to_string()));
    let id = fixture.server_id("sentinel");
    // Inline consent for Claude Desktop through the cell dialog.
    let needs = fixture.write_op(set_cell(
        &fixture.ctx,
        McpSetCellRequest {
            server_id: id.clone(),
            client_id: ClientId::ClaudeDesktop,
            enabled: true,
            allow_inline: None,
            confirm_token: None,
        },
    ));
    assert_eq!(confirmation(&needs).kinds, ["inline-secret"]);
    assert_no_sentinel("confirmation", &serde_json::to_string(&needs).unwrap());
    let consent = fixture.write_op(set_cell(
        &fixture.ctx,
        McpSetCellRequest {
            server_id: id.clone(),
            client_id: ClientId::ClaudeDesktop,
            enabled: true,
            allow_inline: Some(true),
            confirm_token: None,
        },
    ));
    assert_no_sentinel("consent outcome", &serde_json::to_string(&consent).unwrap());
    assert!(fs::read_to_string(fixture.desktop())
        .unwrap()
        .contains(SENTINEL));
    // set_secret with a new value.
    let second = format!("{SENTINEL}-2");
    let secret = fixture.write_op(set_secret(
        &fixture.ctx,
        McpSetSecretRequest {
            server_id: id.clone(),
            name: "SENTINEL_TOKEN".to_string(),
            value: second.clone(),
            mode: "user_env".to_string(),
            inline_clients: None,
            confirm_token: None,
        },
    ));
    assert_no_sentinel("secret outcome", &serde_json::to_string(&secret).unwrap());
    assert_no_sentinel(
        "debug",
        &format!(
            "{:?}",
            McpSetSecretRequest {
                server_id: id.clone(),
                name: "X".to_string(),
                value: SENTINEL.to_string(),
                mode: "user_env".to_string(),
                inline_clients: None,
                confirm_token: None,
            }
        ),
    );
    for (label, text) in [
        (
            "snapshot",
            serde_json::to_string(&fixture.snapshot()).unwrap(),
        ),
        (
            "history",
            serde_json::to_string(&history(&fixture.ctx, McpHistoryRequest::default()).unwrap())
                .unwrap(),
        ),
        (
            "detail",
            serde_json::to_string(
                &get_server(
                    &fixture.ctx,
                    McpGetServerRequest {
                        server_id: id.clone(),
                    },
                )
                .unwrap(),
            )
            .unwrap(),
        ),
        (
            "export",
            serde_json::to_string(
                &export_json(
                    &fixture.ctx,
                    McpExportRequest {
                        server_ids: None,
                        format: "mcp-servers".to_string(),
                    },
                )
                .unwrap(),
            )
            .unwrap(),
        ),
        (
            "export toml",
            export_json(
                &fixture.ctx,
                McpExportRequest {
                    server_ids: None,
                    format: "codex-toml".to_string(),
                },
            )
            .unwrap()
            .text,
        ),
    ] {
        assert_no_sentinel(label, &text);
    }
    // Errors never echo values.
    let invalid = set_secret(
        &fixture.ctx,
        McpSetSecretRequest {
            server_id: id.clone(),
            name: "SENTINEL_TOKEN".to_string(),
            value: format!("{SENTINEL}\nline"),
            mode: "user_env".to_string(),
            inline_clients: None,
            confirm_token: None,
        },
    )
    .unwrap_err();
    assert_eq!(invalid.code, "secret-value-invalid");
    assert_no_sentinel("error", &serde_json::to_string(&invalid).unwrap());
    // SQLite file bytes, plaintext columns and every private state file
    // (DPAPI-protected on Windows) are free of the sentinel.
    let connection = open_db(&fixture.ctx).unwrap();
    for query in [
        "SELECT group_concat(summary_json, '|') FROM mcp_servers",
        "SELECT group_concat(test_json, '|') FROM mcp_servers",
        "SELECT group_concat(summary_json, '|') FROM mcp_operations",
        "SELECT group_concat(name, '|') FROM mcp_env_vars",
    ] {
        let value: Option<String> = connection.query_row(query, [], |row| row.get(0)).unwrap();
        assert_no_sentinel(query, &value.unwrap_or_default());
    }
    drop(connection);
    if cfg!(windows) {
        for file in files_under(&fixture.ctx.mutation.private_state_dir) {
            let bytes = fs::read(&file).unwrap();
            assert!(
                !bytes
                    .windows(SENTINEL.len())
                    .any(|window| window == SENTINEL.as_bytes()),
                "sentinel in {}",
                file.display()
            );
        }
    }
    // Client files without inline consent only hold references.
    assert_no_sentinel("codex", &fs::read_to_string(fixture.codex()).unwrap());
    assert_no_sentinel("claude", &fs::read_to_string(fixture.claude()).unwrap());
    assert_no_sentinel("cursor", &fs::read_to_string(fixture.cursor()).unwrap());
}

/// R22: user_env secrets project as references per client; Claude Desktop is
/// blocked until inline consent.
#[test]
fn set_secret_user_env_projects_references_per_client() {
    let fixture = Fixture::new("r22");
    fixture.import();
    let mut input = stdio_input("brave", "npx", &["-y", "brave-mcp"]);
    input.secrets = Some(vec![McpSecretInput {
        kind: "env".to_string(),
        name: "BRAVE_API_KEY".to_string(),
        env_var: None,
        header_template: None,
        value: None,
        paste_value_handle: None,
        mode: "user_env".to_string(),
        inline_clients: None,
        required: Some(true),
    }]);
    add(
        &fixture,
        input,
        &[
            ClientId::Codex,
            ClientId::ClaudeCode,
            ClientId::Cursor,
            ClientId::ClaudeDesktop,
        ],
    );
    let id = fixture.server_id("brave");
    assert_eq!(fixture.snapshot().servers[0].missing_secret_count, 1);
    let outcome = fixture.write_op(set_secret(
        &fixture.ctx,
        McpSetSecretRequest {
            server_id: id,
            name: "BRAVE_API_KEY".to_string(),
            value: "brave-value-123".to_string(),
            mode: "user_env".to_string(),
            inline_clients: None,
            confirm_token: None,
        },
    ));
    done(&outcome);
    assert_eq!(
        fixture.env.get("BRAVE_API_KEY").unwrap().as_deref(),
        Some("brave-value-123")
    );
    assert!(fs::read_to_string(fixture.codex())
        .unwrap()
        .contains("env_vars = [\"BRAVE_API_KEY\"]"));
    assert_eq!(
        json_file(&fixture.claude())["mcpServers"]["brave"]["env"]["BRAVE_API_KEY"],
        "${BRAVE_API_KEY}"
    );
    assert_eq!(
        json_file(&fixture.cursor())["mcpServers"]["brave"]["env"]["BRAVE_API_KEY"],
        "${env:BRAVE_API_KEY}"
    );
    let desktop = fixture.cell("brave", ClientId::ClaudeDesktop);
    assert_eq!(desktop.state, "blocked");
    assert_eq!(desktop.reason.as_deref(), Some("needs-inline-consent"));
    let snapshot = fixture.snapshot();
    assert_eq!(snapshot.servers[0].missing_secret_count, 0);
    assert!(snapshot.servers[0].secrets[0].created_by_skillhub);
}

/// R23: Bearer headers project per client (Codex `bearer_token_env_var`).
#[test]
fn bearer_header_projects_per_client() {
    let fixture = Fixture::new("r23");
    fixture.import();
    let input = McpServerInput {
        name: "github".to_string(),
        display_name: None,
        transport: Transport::Http,
        command: None,
        args: None,
        cwd: None,
        url: Some("https://api.githubcopilot.com/mcp/".to_string()),
        env: None,
        secrets: Some(vec![McpSecretInput {
            kind: "header".to_string(),
            name: "Authorization".to_string(),
            env_var: Some("GITHUB_PERSONAL_ACCESS_TOKEN".to_string()),
            header_template: Some("bearer".to_string()),
            value: None,
            paste_value_handle: None,
            mode: "user_env".to_string(),
            inline_clients: None,
            required: Some(true),
        }]),
        codex_required: None,
        source: McpServerSource::Template {
            id: "github".to_string(),
        },
    };
    let outcome = add(
        &fixture,
        input,
        &[
            ClientId::Codex,
            ClientId::ClaudeCode,
            ClientId::Cursor,
            ClientId::ClaudeDesktop,
        ],
    );
    let (_, results, _) = done(&outcome);
    assert!(results
        .iter()
        .any(|result| result.client_id == ClientId::ClaudeDesktop
            && result.skipped_reason.as_deref() == Some("transport-unsupported")));
    let codex = fs::read_to_string(fixture.codex()).unwrap();
    assert!(codex.contains("bearer_token_env_var = \"GITHUB_PERSONAL_ACCESS_TOKEN\""));
    assert!(!codex.contains("env_http_headers"));
    assert_eq!(
        json_file(&fixture.claude())["mcpServers"]["github"]["headers"]["Authorization"],
        "Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}"
    );
    assert_eq!(
        json_file(&fixture.claude())["mcpServers"]["github"]["type"],
        "http"
    );
    assert_eq!(
        json_file(&fixture.cursor())["mcpServers"]["github"]["headers"]["Authorization"],
        "Bearer ${env:GITHUB_PERSONAL_ACCESS_TOKEN}"
    );
    assert_eq!(
        fixture
            .cell("github", ClientId::ClaudeDesktop)
            .reason
            .as_deref(),
        Some("transport-unsupported")
    );
}

/// R24: reserved names and invalid values are refused without echoing.
#[test]
fn reserved_env_names_and_invalid_values_rejected_without_echo() {
    let fixture = Fixture::new("r24");
    fixture.import();
    let mut input = stdio_input("demo", "npx", &["-y", "demo-mcp"]);
    input.secrets = Some(vec![McpSecretInput {
        kind: "env".to_string(),
        name: "PATH".to_string(),
        env_var: None,
        header_template: None,
        value: Some("very-secret-path-value".to_string()),
        paste_value_handle: None,
        mode: "user_env".to_string(),
        inline_clients: None,
        required: None,
    }]);
    let error = add_servers(
        &fixture.ctx,
        McpAddRequest {
            candidates: vec![McpAddCandidate {
                input,
                on_conflict: None,
            }],
            client_ids: vec![ClientId::Codex],
            placement: None,
            paste_handle: None,
            confirm_token: None,
        },
    )
    .unwrap_err();
    assert_eq!(error.code, "secret-name-reserved");
    assert!(!serde_json::to_string(&error)
        .unwrap()
        .contains("very-secret-path-value"));
    assert!(fixture.env.get("PATH").unwrap().is_none());
    assert!(!fixture.codex().exists());
}

/// R20: history is structured, newest first, and secret-free.
#[test]
fn history_entries_are_structured_and_secret_free() {
    let fixture = Fixture::new("r20");
    fixture.import();
    add(
        &fixture,
        stdio_input("context7", "npx", &["-y", "@upstash/context7-mcp"]),
        &[ClientId::Codex, ClientId::ClaudeCode],
    );
    let entries = history(&fixture.ctx, McpHistoryRequest::default()).unwrap();
    assert_eq!(entries[0].kind, "add");
    assert_eq!(entries[0].server_names, ["context7"]);
    assert_eq!(
        entries[0].client_ids,
        [ClientId::Codex, ClientId::ClaudeCode]
    );
    assert!(entries[0].undo_available);
    assert!(entries[0].at.ends_with('Z'));
    let import = entries.iter().find(|entry| entry.kind == "import").unwrap();
    assert!(!import.undo_available);
    assert_eq!(
        import.undo_unavailable_reason.as_deref(),
        Some("import-only")
    );
    let text = serde_json::to_string(&entries).unwrap();
    for banned in ["mcp-snapshot-", "DPAPI", "npx"] {
        assert!(!text.contains(banned), "{banned}");
    }
    // Rollback from history always asks first.
    let rollback_outcome = fixture.write_op(rollback(
        &fixture.ctx,
        McpRollbackRequest {
            operation_id: Some(entries[0].operation_id.clone()),
            legacy_snapshot_id: None,
            confirm_token: None,
        },
    ));
    let descriptor = confirmation(&rollback_outcome);
    assert_eq!(descriptor.kinds, ["rollback"]);
    assert_eq!(descriptor.items.len(), 2);
    let token = descriptor.confirm_token.clone();
    let done_outcome = fixture.write_op(rollback(
        &fixture.ctx,
        McpRollbackRequest {
            operation_id: Some(entries[0].operation_id.clone()),
            legacy_snapshot_id: None,
            confirm_token: Some(token),
        },
    ));
    done(&done_outcome);
    assert!(fixture.snapshot().servers.is_empty());
    let entries = history(&fixture.ctx, McpHistoryRequest::default()).unwrap();
    assert_eq!(entries[0].kind, "rollback");
    let added = entries.iter().find(|entry| entry.kind == "add").unwrap();
    assert_eq!(
        added.undo_unavailable_reason.as_deref(),
        Some("already-undone")
    );
}

/// P2: pasted secret values go to the vault and are never returned;
/// placeholders become missing secrets.
#[test]
fn paste_moves_secret_values_into_vault_and_never_returns_them() {
    let fixture = Fixture::new("p2");
    let text = format!(
        r#"{{"mcpServers":{{"brave":{{"command":"npx","args":["-y","brave-mcp"],"env":{{"BRAVE_API_KEY":"{SENTINEL}","MODE":"fast"}}}},"github":{{"url":"https://api.githubcopilot.com/mcp/","headers":{{"Authorization":"Bearer YOUR_GITHUB_PAT"}}}}}}}}"#
    );
    let result = parse_paste(&fixture.ctx, McpParsePasteRequest { text }).unwrap();
    let serialized = serde_json::to_string(&result).unwrap();
    assert_no_sentinel("paste result", &serialized);
    assert_eq!(result.format, "mcp-servers");
    let brave = result
        .candidates
        .iter()
        .find(|candidate| candidate.name == "brave")
        .unwrap();
    assert!(brave.secrets[0].has_pasted_value);
    assert_eq!(brave.exists, "new");
    let github = result
        .candidates
        .iter()
        .find(|candidate| candidate.name == "github")
        .unwrap();
    assert!(github.secrets[0].placeholder);
    assert_eq!(github.target_display, "api.githubcopilot.com");
    // Adding with the handle writes the value to HKCU (memory store) only.
    fixture.import();
    let outcome = fixture.write_op(add_servers(
        &fixture.ctx,
        McpAddRequest {
            candidates: vec![McpAddCandidate {
                input: brave.input.clone(),
                on_conflict: None,
            }],
            client_ids: vec![ClientId::Codex],
            placement: None,
            paste_handle: result.paste_handle.clone(),
            confirm_token: None,
        },
    ));
    done(&outcome);
    assert_eq!(
        fixture.env.get("BRAVE_API_KEY").unwrap().as_deref(),
        Some(SENTINEL)
    );
    assert_no_sentinel("codex", &fs::read_to_string(fixture.codex()).unwrap());
    // The handle is cleared after use: a retry is told to re-paste.
    let again = add_servers(
        &fixture.ctx,
        McpAddRequest {
            candidates: vec![McpAddCandidate {
                input: brave.input.clone(),
                on_conflict: Some("overwrite".to_string()),
            }],
            client_ids: vec![ClientId::Codex],
            placement: None,
            paste_handle: result.paste_handle.clone(),
            confirm_token: None,
        },
    )
    .unwrap_err();
    assert_eq!(again.code, "paste-expired");
}

/// T1: the preview token binds a test to the command and spec revision.
#[test]
fn preview_token_required_and_bound_to_spec_revision() {
    let fixture = Fixture::new("t1");
    fixture.import();
    add(
        &fixture,
        stdio_input("fetch", "uvx", &["mcp-server-fetch"]),
        &[ClientId::Codex],
    );
    let id = fixture.server_id("fetch");
    let preview = crate::mcp_probe::test_preview(&fixture.ctx, &id).unwrap();
    let preview_json = serde_json::to_value(&preview).unwrap();
    assert_eq!(preview_json["commandLine"], "uvx mcp-server-fetch");
    assert_eq!(preview_json["timeoutSeconds"], 20);
    let token = preview_json["previewToken"].as_str().unwrap().to_string();
    let missing = crate::mcp_probe::run_test(&fixture.ctx, &id, "", &|_| {}).unwrap_err();
    assert_eq!(missing.code, "test-preview-required");
    // Change the spec: the old token is stale and nothing runs.
    let detail = get_server(
        &fixture.ctx,
        McpGetServerRequest {
            server_id: id.clone(),
        },
    )
    .unwrap();
    let outcome = fixture.write_op(update_server(
        &fixture.ctx,
        McpUpdateRequest {
            server_id: id.clone(),
            input: stdio_input("fetch", "uvx", &["mcp-server-fetch", "--ignore-robots-txt"]),
            expected_revision: detail.spec_revision,
            confirm_token: None,
        },
    ));
    done(&outcome);
    let stale = crate::mcp_probe::run_test(&fixture.ctx, &id, &token, &|_| {}).unwrap();
    assert_eq!(
        serde_json::to_value(&stale).unwrap()["status"],
        "stale-preview"
    );
    // A revision conflict is reported, not silently overwritten.
    let conflict = update_server(
        &fixture.ctx,
        McpUpdateRequest {
            server_id: id,
            input: stdio_input("fetch", "uvx", &["mcp-server-fetch"]),
            expected_revision: detail.spec_revision,
            confirm_token: None,
        },
    )
    .unwrap_err();
    assert_eq!(conflict.code, "revision-conflict");
}

/// I6/M0-3: everyday toggles write directly; set_column enables the rest.
#[test]
fn column_toggle_enables_the_rest_and_disables_all() {
    let fixture = Fixture::new("column");
    fixture.import();
    add(
        &fixture,
        stdio_input("one", "uvx", &["one-mcp"]),
        &[ClientId::Codex],
    );
    add(
        &fixture,
        stdio_input("two", "uvx", &["two-mcp"]),
        &[ClientId::Codex],
    );
    let enable = fixture.write_op(set_column(
        &fixture.ctx,
        McpSetColumnRequest {
            client_id: ClientId::Cursor,
            enabled: true,
            server_ids: None,
            confirm_token: None,
        },
    ));
    let (_, results, _) = done(&enable);
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].server_ids.len(), 2);
    assert_eq!(fixture.cell("one", ClientId::Cursor).state, "on");
    assert_eq!(fixture.cell("two", ClientId::Cursor).state, "on");
    let disable = fixture.write_op(set_column(
        &fixture.ctx,
        McpSetColumnRequest {
            client_id: ClientId::Cursor,
            enabled: false,
            server_ids: None,
            confirm_token: None,
        },
    ));
    done(&disable);
    let cursor = json_file(&fixture.cursor());
    assert!(cursor["mcpServers"].as_object().unwrap().is_empty());
    let noop = fixture.write_op(set_column(
        &fixture.ctx,
        McpSetColumnRequest {
            client_id: ClientId::Cursor,
            enabled: false,
            server_ids: None,
            confirm_token: None,
        },
    ));
    assert!(matches!(noop, McpWriteOutcome::Noop { .. }));
}

/// I7/R6: a JSONC client file is reported read-only and never written.
#[test]
fn jsonc_client_file_is_readonly_reported_and_never_written() {
    let fixture = Fixture::new("r6");
    let jsonc = "{\n  // my servers\n  \"mcpServers\": {\"x\": {\"command\": \"node\"},},\n}\n";
    fs::write(fixture.cursor(), jsonc).unwrap();
    fixture.import();
    let snapshot = fixture.snapshot();
    let cursor = snapshot
        .clients
        .iter()
        .find(|client| client.id == ClientId::Cursor)
        .unwrap();
    assert!(!cursor.writable);
    assert_eq!(cursor.readonly_reason.as_deref(), Some("config-jsonc"));
    assert!(snapshot.issues.iter().any(
        |issue| issue.kind == "client-unwritable" && issue.client_id == Some(ClientId::Cursor)
    ));
    let id = fixture.server_id("x");
    let outcome = fixture.write_op(set_cell(
        &fixture.ctx,
        McpSetCellRequest {
            server_id: id,
            client_id: ClientId::Cursor,
            enabled: false,
            allow_inline: None,
            confirm_token: None,
        },
    ));
    assert!(matches!(outcome, McpWriteOutcome::Noop { .. }));
    assert_eq!(fs::read_to_string(fixture.cursor()).unwrap(), jsonc);
}

/// A failed HKCU write stops before any client file is touched.
#[test]
fn env_write_failure_stops_before_any_client_write() {
    let fixture = Fixture::new("env-fail");
    fixture.import();
    fixture.env.fail_writes(true);
    let mut input = stdio_input("brave", "npx", &["-y", "brave-mcp"]);
    input.secrets = Some(vec![McpSecretInput {
        kind: "env".to_string(),
        name: "BRAVE_API_KEY".to_string(),
        env_var: None,
        header_template: None,
        value: Some("value-that-cannot-be-saved".to_string()),
        paste_value_handle: None,
        mode: "user_env".to_string(),
        inline_clients: None,
        required: Some(true),
    }]);
    let error = add_servers(
        &fixture.ctx,
        McpAddRequest {
            candidates: vec![McpAddCandidate {
                input,
                on_conflict: None,
            }],
            client_ids: vec![ClientId::Codex, ClientId::Cursor],
            placement: None,
            paste_handle: None,
            confirm_token: None,
        },
    )
    .unwrap_err();
    assert_eq!(error.code, "env-write-failed");
    assert!(!fixture.codex().exists());
    assert!(!fixture.cursor().exists());
    assert!(fixture.snapshot().servers.is_empty());
}

/// M1-7: an edit that omits fields keeps the stored values (secrets,
/// arguments, cwd); a masked argument keeps its stored value.
#[test]
fn update_keeps_omitted_fields_and_masked_arguments() {
    let fixture = Fixture::new("prefill");
    fs::write(
        fixture.codex(),
        "[mcp_servers.legacy]\ncommand = \"npx\"\nargs = [\"-y\", \"legacy-mcp\", \"--api-key\", \"sk-imported-secret-1234\"]\ncwd = \"C:/work\"\nenv_vars = [\"LEGACY_TOKEN\"]\n",
    )
    .unwrap();
    fixture.import();
    let id = fixture.server_id("legacy");
    let detail = get_server(
        &fixture.ctx,
        McpGetServerRequest {
            server_id: id.clone(),
        },
    )
    .unwrap();
    assert_eq!(detail.args[3].value, SECRET_MASK);
    assert!(detail.args[3].masked);
    assert_eq!(detail.secrets.len(), 1);
    // The drawer sends the masked arguments back plus a display name only.
    let input = McpServerInput {
        name: "legacy".to_string(),
        display_name: Some("Legacy".to_string()),
        transport: Transport::Stdio,
        command: Some("npx".to_string()),
        args: Some(detail.args.iter().map(|arg| arg.value.clone()).collect()),
        cwd: None,
        url: None,
        env: None,
        secrets: None,
        codex_required: None,
        source: McpServerSource::Manual,
    };
    let outcome = fixture.write_op(update_server(
        &fixture.ctx,
        McpUpdateRequest {
            server_id: id.clone(),
            input,
            expected_revision: detail.spec_revision,
            confirm_token: None,
        },
    ));
    assert!(matches!(
        outcome,
        McpWriteOutcome::Done { .. } | McpWriteOutcome::Noop { .. }
    ));
    let codex = fs::read_to_string(fixture.codex()).unwrap();
    assert!(codex.contains("sk-imported-secret-1234"));
    assert!(codex.contains("env_vars = [\"LEGACY_TOKEN\"]"));
    assert!(codex.contains("cwd = \"C:/work\""));
    let after = get_server(&fixture.ctx, McpGetServerRequest { server_id: id }).unwrap();
    assert_eq!(after.display_name, "Legacy");
    assert_eq!(after.secrets.len(), 1);
    assert!(!serde_json::to_string(&after)
        .unwrap()
        .contains("sk-imported-secret-1234"));
}

/// Undo of an undo restores the change again (undo is itself undoable), and a
/// library-only add (no AI 工具 selected) is undoable too.
#[test]
fn undo_is_itself_undoable_and_library_only_add_undoes() {
    let fixture = Fixture::new("redo");
    fixture.import();
    let outcome = add(
        &fixture,
        stdio_input("context7", "npx", &["-y", "@upstash/context7-mcp"]),
        &[ClientId::Cursor],
    );
    let (_, _, token) = done(&outcome);
    let undone = fixture.write_op(undo(
        &fixture.ctx,
        McpUndoRequest {
            undo_token: token.clone().unwrap(),
        },
    ));
    let (_, _, redo_token) = done(&undone);
    assert!(fixture.snapshot().servers.is_empty());
    let redone = fixture.write_op(undo(
        &fixture.ctx,
        McpUndoRequest {
            undo_token: redo_token.clone().unwrap(),
        },
    ));
    done(&redone);
    assert_eq!(fixture.cell("context7", ClientId::Cursor).state, "on");
    assert!(json_file(&fixture.cursor())["mcpServers"]["context7"].is_object());

    let library_only = add(&fixture, stdio_input("solo", "uvx", &["solo-mcp"]), &[]);
    let (_, results, token) = done(&library_only);
    assert!(results.is_empty());
    assert!(fixture
        .snapshot()
        .servers
        .iter()
        .any(|server| server.name == "solo"));
    let undone = fixture.write_op(undo(
        &fixture.ctx,
        McpUndoRequest {
            undo_token: token.clone().unwrap(),
        },
    ));
    done(&undone);
    assert!(!fixture
        .snapshot()
        .servers
        .iter()
        .any(|server| server.name == "solo"));
}

// ---------------------------------------------------------------------------
// Review fixes (mcp-backend review, 2026-10-08)
// ---------------------------------------------------------------------------

fn env_secret(name: &str, value: Option<&str>, inline: Option<Vec<ClientId>>) -> McpSecretInput {
    McpSecretInput {
        kind: "env".to_string(),
        name: name.to_string(),
        env_var: None,
        header_template: None,
        value: value.map(str::to_string),
        paste_value_handle: None,
        mode: "user_env".to_string(),
        inline_clients: inline,
        required: Some(true),
    }
}

/// Runs a write; when it asks for confirmation, answers once with its token.
fn confirmed(
    fixture: &Fixture,
    call: impl Fn(Option<String>) -> Result<McpWriteOutcome, McpError>,
) -> McpWriteOutcome {
    let first = fixture.write_op(call(None));
    match &first {
        McpWriteOutcome::NeedsConfirmation { confirmation } => {
            fixture.write_op(call(Some(confirmation.confirm_token.clone())))
        }
        _ => first,
    }
}

/// A client that receives a literal value with inline consent (Claude
/// Desktop) gets the value being saved — on add, set_secret and update —
/// never the older value the user store still held while planning.
#[test]
fn inline_consented_clients_receive_the_value_being_saved() {
    let fixture = Fixture::new("inline-pending");
    fixture.import();
    let desktop_value =
        || json_file(&fixture.desktop())["mcpServers"]["brave"]["env"]["BRAVE_API_KEY"].clone();
    let mut input = stdio_input("brave", "npx", &["-y", "brave-mcp"]);
    input.secrets = Some(vec![env_secret(
        "BRAVE_API_KEY",
        Some("first-value-111"),
        Some(vec![ClientId::ClaudeDesktop]),
    )]);
    let added = confirmed(&fixture, |token| {
        add_servers(
            &fixture.ctx,
            McpAddRequest {
                candidates: vec![McpAddCandidate {
                    input: input.clone(),
                    on_conflict: None,
                }],
                client_ids: vec![ClientId::ClaudeCode, ClientId::ClaudeDesktop],
                placement: None,
                paste_handle: None,
                confirm_token: token,
            },
        )
    });
    let (_, results, _) = done(&added);
    assert!(
        results
            .iter()
            .any(|result| result.client_id == ClientId::ClaudeDesktop
                && result.status == "written"),
        "{}",
        serde_json::to_string(&added).unwrap()
    );
    assert_eq!(desktop_value(), "first-value-111");
    assert_eq!(
        json_file(&fixture.claude())["mcpServers"]["brave"]["env"]["BRAVE_API_KEY"],
        "${BRAVE_API_KEY}"
    );
    assert_eq!(fixture.cell("brave", ClientId::ClaudeDesktop).state, "on");

    let id = fixture.server_id("brave");
    let changed = confirmed(&fixture, |token| {
        set_secret(
            &fixture.ctx,
            McpSetSecretRequest {
                server_id: id.clone(),
                name: "BRAVE_API_KEY".to_string(),
                value: "second-value-222".to_string(),
                mode: "user_env".to_string(),
                inline_clients: None,
                confirm_token: token,
            },
        )
    });
    done(&changed);
    assert_eq!(desktop_value(), "second-value-222");
    assert_eq!(fixture.cell("brave", ClientId::ClaudeDesktop).state, "on");

    let detail = get_server(
        &fixture.ctx,
        McpGetServerRequest {
            server_id: id.clone(),
        },
    )
    .unwrap();
    let mut edit = stdio_input("brave", "npx", &["-y", "brave-mcp"]);
    edit.secrets = Some(vec![env_secret(
        "BRAVE_API_KEY",
        Some("third-value-333"),
        Some(vec![ClientId::ClaudeDesktop]),
    )]);
    let updated = confirmed(&fixture, |token| {
        update_server(
            &fixture.ctx,
            McpUpdateRequest {
                server_id: id.clone(),
                input: edit.clone(),
                expected_revision: detail.spec_revision,
                confirm_token: token,
            },
        )
    });
    done(&updated);
    assert_eq!(desktop_value(), "third-value-333");
    assert_eq!(
        fixture.env.get("BRAVE_API_KEY").unwrap().as_deref(),
        Some("third-value-333")
    );
}

/// An imported remote URL with a key in its query stays hidden in the edit
/// drawer and the export, other clients need inline consent for it (I3, I6),
/// and an edit that sends the masked URL back keeps the stored one.
#[test]
fn imported_url_with_query_key_is_masked_and_needs_consent_elsewhere() {
    let fixture = Fixture::new("url-secret");
    fs::write(
        fixture.cursor(),
        r#"{"mcpServers":{"smith":{"url":"https://smith.example.test/mcp?api_key=url-secret-777"}}}"#,
    )
    .unwrap();
    fixture.import();
    let id = fixture.server_id("smith");
    let detail = get_server(
        &fixture.ctx,
        McpGetServerRequest {
            server_id: id.clone(),
        },
    )
    .unwrap();
    let shown = detail.url.clone().unwrap();
    assert_eq!(
        shown,
        format!("https://smith.example.test/mcp?{SECRET_MASK}")
    );
    assert!(!serde_json::to_string(&detail)
        .unwrap()
        .contains("url-secret-777"));
    let export = export_json(
        &fixture.ctx,
        McpExportRequest {
            server_ids: None,
            format: "mcp-servers".to_string(),
        },
    )
    .unwrap();
    assert!(!export.text.contains("url-secret-777"));
    assert_eq!(export.masked_secret_count, 1);
    // Cursor, where it came from, is on; Claude Code needs consent first.
    assert_eq!(fixture.cell("smith", ClientId::Cursor).state, "on");
    let claude = fixture.cell("smith", ClientId::ClaudeCode);
    assert_eq!(
        (claude.state.as_str(), claude.reason.as_deref()),
        ("blocked", Some("needs-inline-consent"))
    );
    let asked = fixture.write_op(set_cell(
        &fixture.ctx,
        McpSetCellRequest {
            server_id: id.clone(),
            client_id: ClientId::ClaudeCode,
            enabled: true,
            allow_inline: None,
            confirm_token: None,
        },
    ));
    assert_eq!(confirmation(&asked).kinds, ["inline-secret"]);
    assert!(!serde_json::to_string(&asked)
        .unwrap()
        .contains("url-secret-777"));
    // An edit that only sets a display name keeps the stored URL.
    let input = McpServerInput {
        name: "smith".to_string(),
        display_name: Some("Smith".to_string()),
        transport: Transport::Http,
        command: None,
        args: None,
        cwd: None,
        url: Some(shown),
        env: None,
        secrets: None,
        codex_required: None,
        source: McpServerSource::Manual,
    };
    let outcome = fixture.write_op(update_server(
        &fixture.ctx,
        McpUpdateRequest {
            server_id: id,
            input,
            expected_revision: detail.spec_revision,
            confirm_token: None,
        },
    ));
    assert!(
        matches!(
            outcome,
            McpWriteOutcome::Done { .. } | McpWriteOutcome::Noop { .. }
        ),
        "{}",
        serde_json::to_string(&outcome).unwrap()
    );
    assert!(fs::read_to_string(fixture.cursor())
        .unwrap()
        .contains("api_key=url-secret-777"));
    assert_eq!(fixture.cell("smith", ClientId::Cursor).state, "on");
    assert!(!fs::read_to_string(fixture.claude())
        .unwrap_or_default()
        .contains("url-secret-777"));
}

/// Enabling a client that needs inline consent *and* whose same-name entry
/// was edited outside SkillHub names both reasons (I6); consent alone never
/// skips the overwrite question.
#[test]
fn inline_consent_and_changed_outside_are_confirmed_together() {
    let fixture = Fixture::new("both-kinds");
    fixture.import();
    let mut input = stdio_input("brave", "npx", &["-y", "brave-mcp"]);
    input.secrets = Some(vec![env_secret("BRAVE_API_KEY", Some("value-444"), None)]);
    add(&fixture, input, &[ClientId::ClaudeCode]);
    let id = fixture.server_id("brave");
    fs::write(
        fixture.desktop(),
        r#"{"mcpServers":{"brave":{"command":"node","args":["mine.js"]}}}"#,
    )
    .unwrap();
    let request = |allow_inline: Option<bool>| McpSetCellRequest {
        server_id: id.clone(),
        client_id: ClientId::ClaudeDesktop,
        enabled: true,
        allow_inline,
        confirm_token: None,
    };
    let asked = fixture.write_op(set_cell(&fixture.ctx, request(None)));
    let kinds = &confirmation(&asked).kinds;
    assert!(
        kinds.contains(&"changed-outside".to_string())
            && kinds.contains(&"inline-secret".to_string()),
        "{kinds:?}"
    );
    let consented = fixture.write_op(set_cell(&fixture.ctx, request(Some(true))));
    assert_eq!(confirmation(&consented).kinds, ["changed-outside"]);
    assert!(fs::read_to_string(fixture.desktop())
        .unwrap()
        .contains("mine.js"));
}

/// Ticking "also delete the unused variable" inside the removal dialog works
/// with the token the dialog was opened with: one confirmation, not two.
#[test]
fn remove_with_ticked_env_var_needs_one_confirmation() {
    let fixture = Fixture::new("remove-env");
    fixture.import();
    let mut input = stdio_input("brave", "npx", &["-y", "brave-mcp"]);
    input.secrets = Some(vec![env_secret("BRAVE_API_KEY", Some("value-555"), None)]);
    add(&fixture, input, &[ClientId::Cursor]);
    let id = fixture.server_id("brave");
    let first = fixture.write_op(remove_server(
        &fixture.ctx,
        McpRemoveRequest {
            server_id: id.clone(),
            from: McpRemoveFrom::Library,
            delete_env_vars: None,
            confirm_token: None,
        },
    ));
    let descriptor = confirmation(&first);
    let listed = descriptor.env_vars.clone().unwrap();
    assert_eq!(listed[0].name, "BRAVE_API_KEY");
    let second = fixture.write_op(remove_server(
        &fixture.ctx,
        McpRemoveRequest {
            server_id: id,
            from: McpRemoveFrom::Library,
            delete_env_vars: Some(vec!["BRAVE_API_KEY".to_string()]),
            confirm_token: Some(descriptor.confirm_token.clone()),
        },
    ));
    done(&second);
    assert_eq!(fixture.env.get("BRAVE_API_KEY").unwrap(), None);
    assert!(fixture.snapshot().servers.is_empty());
    assert!(!fs::read_to_string(fixture.cursor())
        .unwrap()
        .contains("brave"));
}

/// Undo restores an environment variable only while it still holds the value
/// the operation wrote; a later change by the user is kept.
#[test]
fn undo_keeps_an_environment_variable_changed_afterwards() {
    let fixture = Fixture::new("undo-env");
    fixture.import();
    let mut input = stdio_input("brave", "npx", &["-y", "brave-mcp"]);
    input.secrets = Some(vec![env_secret("BRAVE_API_KEY", Some("value-666"), None)]);
    let outcome = add(&fixture, input, &[ClientId::Cursor]);
    let (_, _, token) = done(&outcome);
    fixture.env.set("BRAVE_API_KEY", "changed-by-user").unwrap();
    let undone = fixture.write_op(undo(
        &fixture.ctx,
        McpUndoRequest {
            undo_token: token.clone().unwrap(),
        },
    ));
    done(&undone);
    assert_eq!(
        fixture.env.get("BRAVE_API_KEY").unwrap().as_deref(),
        Some("changed-by-user")
    );
    assert!(fixture.snapshot().servers.is_empty());
    // An untouched variable SkillHub created is still removed by undo.
    let mut again = stdio_input("other", "npx", &["-y", "other-mcp"]);
    again.secrets = Some(vec![env_secret("OTHER_API_KEY", Some("value-667"), None)]);
    let outcome = add(&fixture, again, &[ClientId::Cursor]);
    let (_, _, token) = done(&outcome);
    let undone = fixture.write_op(undo(
        &fixture.ctx,
        McpUndoRequest {
            undo_token: token.clone().unwrap(),
        },
    ));
    done(&undone);
    assert_eq!(fixture.env.get("OTHER_API_KEY").unwrap(), None);
}

/// An edit that omits envVar keeps an env secret's differently named
/// variable (`"KEY": "${OTHER}"`, what the edit drawer sends), and a header
/// variable name is validated even when no value is saved.
#[test]
fn update_keeps_secret_variable_reference_and_validates_header_variables() {
    let fixture = Fixture::new("envvar-keep");
    fs::write(
        fixture.claude(),
        r#"{"mcpServers":{"brave":{"type":"stdio","command":"npx","args":["-y","brave-mcp"],"env":{"BRAVE_API_KEY":"${MY_BRAVE}"}}}}"#,
    )
    .unwrap();
    fixture.import();
    let id = fixture.server_id("brave");
    let detail = get_server(
        &fixture.ctx,
        McpGetServerRequest {
            server_id: id.clone(),
        },
    )
    .unwrap();
    assert_eq!(detail.secrets[0].env_var.as_deref(), Some("MY_BRAVE"));
    let mut input = stdio_input("brave", "npx", &["-y", "brave-mcp"]);
    input.display_name = Some("Brave".to_string());
    input.secrets = Some(vec![McpSecretInput {
        required: Some(false),
        inline_clients: Some(Vec::new()),
        ..env_secret("BRAVE_API_KEY", None, None)
    }]);
    let outcome = confirmed(&fixture, |token| {
        update_server(
            &fixture.ctx,
            McpUpdateRequest {
                server_id: id.clone(),
                input: input.clone(),
                expected_revision: detail.spec_revision,
                confirm_token: token,
            },
        )
    });
    assert!(matches!(
        outcome,
        McpWriteOutcome::Done { .. } | McpWriteOutcome::Noop { .. }
    ));
    assert_eq!(
        json_file(&fixture.claude())["mcpServers"]["brave"]["env"]["BRAVE_API_KEY"],
        "${MY_BRAVE}"
    );
    assert_eq!(fixture.cell("brave", ClientId::ClaudeCode).state, "on");
    let after = get_server(&fixture.ctx, McpGetServerRequest { server_id: id }).unwrap();
    assert_eq!(after.secrets[0].env_var.as_deref(), Some("MY_BRAVE"));

    let remote = McpServerInput {
        name: "remote".to_string(),
        display_name: None,
        transport: Transport::Http,
        command: None,
        args: None,
        cwd: None,
        url: Some("https://remote.example.test/mcp".to_string()),
        env: None,
        secrets: Some(vec![McpSecretInput {
            kind: "header".to_string(),
            name: "Authorization".to_string(),
            env_var: Some("BAD NAME}".to_string()),
            header_template: Some("bearer".to_string()),
            value: None,
            paste_value_handle: None,
            mode: "user_env".to_string(),
            inline_clients: None,
            required: Some(true),
        }]),
        codex_required: None,
        source: McpServerSource::Manual,
    };
    let error = add_servers(
        &fixture.ctx,
        McpAddRequest {
            candidates: vec![McpAddCandidate {
                input: remote,
                on_conflict: None,
            }],
            client_ids: vec![ClientId::Codex, ClientId::ClaudeCode],
            placement: None,
            paste_handle: None,
            confirm_token: None,
        },
    )
    .unwrap_err();
    assert_eq!(error.code, "secret-name-invalid");
    assert!(!fs::read_to_string(fixture.codex())
        .unwrap_or_default()
        .contains("remote"));
}

/// A Claude Desktop folder under a non-ASCII path outside the home folder (a
/// redirected %APPDATA%) never crashes the snapshot, and its path stays
/// redacted.
#[test]
fn snapshot_survives_non_ascii_client_paths_outside_home() {
    let mut fixture = Fixture::new("non-ascii");
    let roaming = fixture.root.join("用户数据").join("Roaming");
    fs::create_dir_all(roaming.join("Claude")).unwrap();
    fixture.ctx.mutation.app_data_dir = Some(roaming);
    let snapshot = fixture.snapshot();
    let desktop = snapshot
        .clients
        .iter()
        .find(|client| client.id == ClientId::ClaudeDesktop)
        .unwrap();
    assert!(desktop
        .config_path_display
        .ends_with("claude_desktop_config.json"));
    assert!(!desktop.config_path_display.contains("用户数据"));
}

/// A column change over more than 64 servers (two transactions on one file)
/// undoes every entry.
#[test]
fn undo_of_a_column_change_over_64_servers_restores_every_entry() {
    let fixture = Fixture::new("chunked");
    let mut text = String::new();
    for index in 0..70 {
        text.push_str(&format!(
            "[mcp_servers.s{index:02}]\ncommand = \"uvx\"\nargs = [\"s{index:02}-mcp\"]\nenabled = false\n\n"
        ));
    }
    fs::write(fixture.codex(), &text).unwrap();
    fixture.import();
    let outcome = fixture.write_op(set_column(
        &fixture.ctx,
        McpSetColumnRequest {
            client_id: ClientId::Codex,
            enabled: true,
            server_ids: None,
            confirm_token: None,
        },
    ));
    let (_, results, token) = done(&outcome);
    assert_eq!(
        results
            .iter()
            .filter(|result| result.status == "written")
            .count(),
        2
    );
    assert!(!fs::read_to_string(fixture.codex())
        .unwrap()
        .contains("enabled = false"));
    let undone = fixture.write_op(undo(
        &fixture.ctx,
        McpUndoRequest {
            undo_token: token.clone().unwrap(),
        },
    ));
    let (_, results, _) = done(&undone);
    assert!(
        results.iter().all(|result| result.status != "failed"),
        "{}",
        serde_json::to_string(&undone).unwrap()
    );
    assert_eq!(
        fs::read_to_string(fixture.codex())
            .unwrap()
            .matches("enabled = false")
            .count(),
        70
    );
}

/// The request objects the frontend sends (camelCase, tagged unions, omitted
/// optionals, and paste candidates sent back with `null`s) deserialize as the
/// contract shows; unknown fields are refused.
#[test]
fn frontend_request_shapes_deserialize() {
    let remove: McpRemoveRequest = serde_json::from_value(json!({
        "serverId": "mcps-1", "from": {"kind": "library"}, "deleteEnvVars": ["A"], "confirmToken": "t"
    }))
    .unwrap();
    assert!(matches!(remove.from, McpRemoveFrom::Library));
    let remove: McpRemoveRequest = serde_json::from_value(json!({
        "serverId": "mcps-1", "from": {"kind": "client", "clientId": "claude-desktop", "scope": "user"}
    }))
    .unwrap();
    assert!(matches!(
        remove.from,
        McpRemoveFrom::Client {
            client_id: ClientId::ClaudeDesktop,
            ..
        }
    ));
    let add: McpAddRequest = serde_json::from_value(json!({
        "candidates": [{
            "input": {
                "name": "context7", "transport": "stdio", "command": "npx",
                "args": ["-y", "@upstash/context7-mcp"],
                "secrets": [{"kind": "env", "name": "CONTEXT7_API_KEY", "mode": "user_env", "value": "x"}],
                "source": {"kind": "template", "id": "context7"}
            },
            "onConflict": "skip"
        }],
        "clientIds": ["codex", "claude-code", "claude-desktop", "cursor"],
        "placement": {"scope": "local", "workspaceId": "ws-paper"},
        "pasteHandle": "paste-1"
    }))
    .unwrap();
    assert_eq!(add.client_ids.len(), 4);
    let update: McpUpdateRequest = serde_json::from_value(json!({
        "serverId": "mcps-1", "expectedRevision": 3,
        "input": {
            "name": "github", "displayName": "GitHub", "transport": "http",
            "url": "https://api.githubcopilot.com/mcp/", "codexRequired": false,
            "secrets": [{"kind": "header", "name": "Authorization", "envVar": "GITHUB_PERSONAL_ACCESS_TOKEN",
                         "headerTemplate": "bearer", "mode": "user_env", "inlineClients": [], "required": true}],
            "source": {"kind": "import", "clientId": "codex", "scope": "user"}
        }
    }))
    .unwrap();
    assert_eq!(update.expected_revision, 3);
    for value in [
        json!({"serverId": "s", "clientId": "cursor", "enabled": true, "allowInline": true}),
        json!({"serverId": "s", "clientId": "codex", "enabled": false, "confirmToken": "t"}),
    ] {
        serde_json::from_value::<McpSetCellRequest>(value).unwrap();
    }
    serde_json::from_value::<McpSetColumnRequest>(
        json!({"clientId": "cursor", "enabled": true, "serverIds": ["a"]}),
    )
    .unwrap();
    serde_json::from_value::<McpSetRowRequest>(json!({"serverId": "s", "enabled": false})).unwrap();
    serde_json::from_value::<McpEmptyRequest>(json!({})).unwrap();
    serde_json::from_value::<McpHistoryRequest>(json!({})).unwrap();
    serde_json::from_value::<McpImportRequest>(json!({"reason": "onboarding", "clientIds": []}))
        .unwrap();
    serde_json::from_value::<McpRollbackRequest>(
        json!({"legacySnapshotId": "mcp-snapshot-x", "confirmToken": "t"}),
    )
    .unwrap();
    serde_json::from_value::<McpResolveChangeRequest>(
        json!({"serverId": "s", "clientId": "codex", "take": "file"}),
    )
    .unwrap();
    serde_json::from_value::<McpResolveStuckRequest>(
        json!({"snapshotId": "mcp-snapshot-x", "action": "keep-current"}),
    )
    .unwrap();
    serde_json::from_value::<McpOpenLocationRequest>(json!({"clientId": "codex"})).unwrap();
    serde_json::from_value::<McpExportRequest>(json!({"format": "codex-toml"})).unwrap();
    serde_json::from_value::<McpSetSecretRequest>(json!({
        "serverId": "s", "name": "N", "value": "v", "mode": "inline", "inlineClients": ["claude-desktop"]
    }))
    .unwrap();
    serde_json::from_value::<McpTestRequest>(json!({"serverId": "s", "previewToken": "p"}))
        .unwrap();
    serde_json::from_value::<McpResyncRequest>(json!({})).unwrap();
    // A paste candidate's input goes back as it came (optional fields null).
    let candidate_input = stdio_input("memory", "npx", &["-y", "server-memory"]);
    let echoed = serde_json::to_value(&candidate_input).unwrap();
    assert!(echoed["cwd"].is_null());
    serde_json::from_value::<McpServerInput>(echoed).unwrap();
    assert!(serde_json::from_value::<McpSetCellRequest>(
        json!({"serverId": "s", "clientId": "codex", "enabled": true, "extra": 1})
    )
    .is_err());
}

/// I1: the modules behind opening the page, the snapshot, import, paste,
/// GitHub import, templates, secrets and config writes never start a process
/// (only `mcp_probe`, after a user click, and "打开文件位置" may).
#[test]
fn page_open_import_and_parse_modules_never_start_a_process() {
    let forbidden = [concat!("Command", "::new"), concat!(".spa", "wn(")];
    for (name, source) in [
        ("mcp_center.rs", include_str!("mcp_center.rs")),
        ("mcp_mutation.rs", include_str!("mcp_mutation.rs")),
        ("mcp_library.rs", include_str!("mcp_library.rs")),
        ("mcp_paste.rs", include_str!("mcp_paste.rs")),
        ("mcp_secrets.rs", include_str!("mcp_secrets.rs")),
        ("mcp_json_doc.rs", include_str!("mcp_json_doc.rs")),
        ("mcp_templates.rs", include_str!("mcp_templates.rs")),
        ("mcp_github_import.rs", include_str!("mcp_github_import.rs")),
    ] {
        for pattern in forbidden {
            assert!(!source.contains(pattern), "{name} contains {pattern}");
        }
    }
    // Runner and client detection read files and the registry only.
    let where_exe = concat!("\"where", ".exe\"");
    for (name, source) in [
        ("mcp_library.rs", include_str!("mcp_library.rs")),
        ("mcp_probe.rs", include_str!("mcp_probe.rs")),
    ] {
        assert!(!source.contains(where_exe), "{name} runs where.exe");
    }
}

/// "保留现在的文件" keeps the current bytes of a stuck transaction's target
/// and stops listing it; later writes are not blocked.
#[test]
fn keeping_current_files_resolves_a_stuck_transaction_without_restoring() {
    let fixture = Fixture::new("stuck");
    fixture.import();
    let outcome = add(
        &fixture,
        stdio_input("memory", "npx", &["-y", "server-memory"]),
        &[ClientId::Cursor],
    );
    done(&outcome);
    // Simulate an interrupted transaction: mark the committed manifest as
    // still applying, then edit the file outside SkillHub.
    assert!(
        engine::list_legacy_snapshots(&fixture.ctx.mutation).is_empty(),
        "v3.3 snapshots are not legacy"
    );
    let ids = engine::snapshot_ids_for_test(&fixture.ctx.mutation);
    assert_eq!(ids.len(), 1);
    // The app stopped after the write but before the commit record: the file
    // holds the new bytes, which the user chooses to keep.
    let edited = fs::read_to_string(fixture.cursor()).unwrap();
    assert!(edited.contains("memory"));
    engine::mark_snapshot_interrupted_for_test(&fixture.ctx.mutation, &ids[0]);
    let listed = fixture.snapshot().stuck_transactions;
    assert_eq!(listed.len(), 1);
    // Resolve without running recovery first (the command's write runner
    // skips prepare_write for this action).
    let resolved = resolve_stuck_transaction(
        &fixture.ctx,
        McpResolveStuckRequest {
            snapshot_id: listed[0].snapshot_id.clone(),
            action: "keep-current".to_string(),
        },
    )
    .unwrap();
    done(&resolved);
    assert_eq!(fs::read_to_string(fixture.cursor()).unwrap(), edited);
    assert!(fixture.snapshot().stuck_transactions.is_empty());
    // Recovery before the next write leaves the kept file alone.
    prepare_write(&fixture.ctx).unwrap();
    assert_eq!(fs::read_to_string(fixture.cursor()).unwrap(), edited);
}

/// A reference with a default (`${NAME:-value}`) is imported as written, so
/// the cell is "on" right after import and the default survives re-writes.
#[test]
fn import_keeps_references_with_defaults_as_written() {
    let fixture = Fixture::new("ref-default");
    fs::write(
        fixture.cursor(),
        r#"{"mcpServers":{"api":{"command":"node","args":["api.js"],"env":{"API_URL":"${API_URL:-https://api.example.test}","API_TOKEN":"${env:API_TOKEN}"}}}}"#,
    )
    .unwrap();
    fixture.import();
    assert_eq!(fixture.cell("api", ClientId::Cursor).state, "on");
    let detail = get_server(
        &fixture.ctx,
        McpGetServerRequest {
            server_id: fixture.server_id("api"),
        },
    )
    .unwrap();
    assert!(
        detail
            .env
            .iter()
            .any(|item| item.name == "API_URL"
                && item.value == "${API_URL:-https://api.example.test}")
    );
    // The plain reference is a secret the server needs.
    let token = detail
        .secrets
        .iter()
        .find(|secret| secret.name == "API_TOKEN")
        .unwrap();
    assert!(token.required);
    assert_eq!(fixture.snapshot().servers[0].missing_secret_count, 1);
}

/// An optional key (context7's CONTEXT7_API_KEY) that is not set is neither
/// "missing" in the matrix nor a reason to refuse the connection test.
#[test]
fn optional_secrets_are_not_missing_and_do_not_block_the_test() {
    let fixture = Fixture::new("optional");
    fixture.import();
    let mut input = stdio_input("context7", "npx", &["-y", "@upstash/context7-mcp"]);
    input.secrets = Some(vec![McpSecretInput {
        required: Some(false),
        ..env_secret("CONTEXT7_API_KEY", None, None)
    }]);
    add(&fixture, input, &[ClientId::Cursor]);
    let row = fixture.snapshot().servers[0].clone();
    assert_eq!(row.missing_secret_count, 0);
    assert!(!row.secrets[0].present);
    let preview = crate::mcp_probe::test_preview(&fixture.ctx, &row.id).unwrap();
    let preview = serde_json::to_value(&preview).unwrap();
    assert_eq!(preview["missingSecrets"], json!([]));
}

/// Codex found by the AI 工具 page but never started (no `~/.codex` yet):
/// its column is "not installed here", never "unreadable", and SkillHub does
/// not create the folder (I5).
#[test]
fn detected_client_without_config_folder_is_not_installed_not_unreadable() {
    let fixture = Fixture::new("no-codex-dir");
    fs::remove_dir_all(fixture.home().join(".codex")).unwrap();
    let connection = open_db(&fixture.ctx).unwrap();
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS agent_adapters (
                 id TEXT PRIMARY KEY, name TEXT NOT NULL, detected INTEGER NOT NULL);
             INSERT INTO agent_adapters VALUES ('codex', 'Codex', 1);",
        )
        .unwrap();
    drop(connection);
    let snapshot = fixture.snapshot();
    let codex = snapshot
        .clients
        .iter()
        .find(|client| client.id == ClientId::Codex)
        .unwrap();
    assert!(codex.detected && !codex.writable);
    assert_eq!(
        codex.readonly_reason.as_deref(),
        Some("client-not-installed")
    );
    let outcome = add(
        &fixture,
        stdio_input("memory", "npx", &["-y", "server-memory"]),
        &[ClientId::Codex],
    );
    let (_, results, _) = done(&outcome);
    assert_eq!(
        results[0].skipped_reason.as_deref(),
        Some("client-not-installed")
    );
    assert!(!fixture.home().join(".codex").exists());
}
