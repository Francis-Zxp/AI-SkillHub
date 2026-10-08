import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { readAppSource } from "./app-source.mjs";

const files = {
  app: await readAppSource(),
  mcpUi: (await readFile(new URL("../src/mcp/McpPage.tsx", import.meta.url), "utf8")).replace(/\r\n/g, "\n"),
  mcpLogic: (await readFile(new URL("../src/mcp/mcpLogic.ts", import.meta.url), "utf8")).replace(/\r\n/g, "\n"),
  i18n: await readFile(new URL("../src/i18n.ts", import.meta.url), "utf8"),
  styles: await readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
  doctorUi: await readFile(new URL("../src/CodexPluginDoctorPanel.tsx", import.meta.url), "utf8"),
  capabilities: await readFile(new URL("../src-tauri/capabilities/default.json", import.meta.url), "utf8"),
  backend: await readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8"),
  mcp: await readFile(new URL("../src-tauri/src/mcp_center.rs", import.meta.url), "utf8"),
  mcpMutation: await readFile(new URL("../src-tauri/src/mcp_mutation.rs", import.meta.url), "utf8").catch(
    (error) => {
      if (error?.code === "ENOENT") return "";
      throw error;
    },
  ),
  doctor: await readFile(new URL("../src-tauri/src/codex_plugin_doctor.rs", import.meta.url), "utf8")
};

test("GitHub import is driven by backend stages and supports cancellation", () => {
  assert.match(files.backend, /SOURCE_IMPORT_PROGRESS_EVENT: &str = "source-import-progress"/);
  assert.match(files.backend, /fn cancel_source_import/);
  assert.ok(files.app.includes("listen<ImportProgress>(SOURCE_IMPORT_PROGRESS_EVENT"));
  assert.match(files.app, /cancel_source_import/);
  assert.doesNotMatch(files.app, /current\.percent >= 64/);
  assert.doesNotMatch(files.app, /setInterval\(\(\) => \{\s*setProgress/);
});

test("formal desktop ACL grants only the event commands required by import progress", () => {
  const capabilities = JSON.parse(files.capabilities);
  assert.ok(capabilities.permissions.includes("core:event:allow-listen"));
  assert.ok(capabilities.permissions.includes("core:event:allow-unlisten"));
  assert.ok(!capabilities.permissions.includes("core:event:default"));
  assert.ok(!capabilities.permissions.includes("core:event:allow-emit"));
  // v3.3 skillApi: a missing event permission degrades to "no live progress", never a failure,
  // and every listener is released when the command finishes.
  const listener = files.app.slice(files.app.indexOf("async function listenImportProgress"));
  assert.match(listener, /\} catch \{\s*return \(\) => undefined;\s*\}/);
  assert.match(files.app, /\} finally \{\s*stop\(\);\s*\}/);
});

test("archive symlinks are skipped without following or materializing", () => {
  assert.match(files.backend, /SkipSymlink/);
  assert.match(files.backend, /已跳过 .*个符号链接别名/);
  assert.match(files.backend, /不创建、不跟随/);
  assert.doesNotMatch(files.backend, /GitHub 归档包含符号链接，已拒绝导入/);
});

test("anonymous per-blob GitHub fallback is refused before API download", () => {
  assert.match(files.backend, /ensure_github_api_file_fallback_allowed\(github_api_token\(\)\.is_some\(\)\)\?/);
  assert.match(files.backend, /已停止匿名 GitHub API 逐文件回退/);
});

test("MCP scanner stays read-only, secret-safe and never probes live capabilities", () => {
  assert.match(files.mcp, /capability_state: "unprobed"\.to_string\(\)/);
  assert.match(files.mcp, /headersHelper/);
  assert.match(files.mcp, /Secret values[\s\S]*never enter the returned snapshot/);
  assert.doesNotMatch(files.mcp, /Command::new|\.spawn\(/);
  // v3.3: opening the page reads one snapshot; Origin detection and tests run only on clicks.
  const mount = files.mcpUi.slice(files.mcpUi.indexOf("useEffect(() => {\n    mounted.current = true;"), files.mcpUi.indexOf("// ---------- paste hand-off"));
  assert.match(mount, /const first = await refresh\(\);/);
  assert.doesNotMatch(mount, /testServer|testPreview|detect_mcp_recipe|importGithub/);
  assert.match(files.mcpUi, /const next = await mcpApi\.snapshot\(\);/);
});

test("optional MCP mutation module is gated, reversible and never starts a server", () => {
  if (!files.mcpMutation) return;
  for (const contract of [
    /plan_mcp_changes/,
    /apply_mcp_plan/,
    /rollback_mcp_snapshot/,
    /list_mcp_rollback_snapshots/,
    /create_private_backup/,
    /protect_private_backup/,
    /write_atomic/,
    /verify_written_config/,
    /restore_batch_after_failure/,
  ]) {
    assert.match(files.mcpMutation, contract);
  }
  assert.doesNotMatch(files.mcpMutation, /Command::new|\.spawn\(/);
  assert.doesNotMatch(files.mcpMutation, /secret_value|token_value|password_value/i);
  assert.match(files.mcpMutation, /env_vars/);
  assert.match(files.mcpMutation, /header_env/);
});

test("v3.3 MCP library modules never start a process (contract I1)", async () => {
  // mcp_probe.rs is the one place that may start a server: the user-clicked test (contract §3.10).
  for (const name of ["mcp_library.rs", "mcp_paste.rs", "mcp_secrets.rs", "mcp_json_doc.rs", "mcp_templates.rs", "mcp_github_import.rs"]) {
    const source = await readFile(new URL(`../src-tauri/src/${name}`, import.meta.url), "utf8").catch(error => {
      if (error?.code === "ENOENT") return "";
      throw error;
    });
    if (!source) continue;
    assert.doesNotMatch(source, /Command::new|\.spawn\(/, name);
  }
});

test("MCP read and parse failures remain visible even when no server row can be created", () => {
  // An unreadable, JSONC or oversized client file is a per-client issue with one action, pinned so
  // it is never hidden behind the issue toggle, and the import report lists every file it read.
  assert.match(files.mcpUi, /const PINNED_ISSUES = new Set<McpIssue\["kind"\]>\(\["stuck-transaction", "client-unwritable", "interrupted"\]\)/);
  assert.match(files.mcpUi, /case "open-file-location":\s*if \(issue\.clientId\) void openLocation\(issue\.clientId\);/);
  assert.match(files.mcpUi, /report\.filesRead\.map\(\(file, index\) =>/);
  assert.match(files.mcpUi, /t\(`mcp\.import\.status\.\$\{file\.status\}`, \{ n: file\.servers \}\)/);
  assert.match(files.mcpLogic, /if \(issue\.kind === "client-unwritable" && issue\.clientId\) \{/);
  // Paths are shown as the backend redacted them; the webview never sends a path to open.
  assert.doesNotMatch(files.mcpUi, /configPath\b(?!Display)/);
  assert.match(files.mcpUi, /mcpApi\.openConfigLocation\(\{ clientId, scope, workspaceId \}\)/);
});


test("Codex doctor guarantees zero writes and does not execute the standalone repair path", () => {
  assert.match(files.doctor, /mutation_count: 0/);
  assert.match(files.doctor, /repair_available: false/);
  assert.match(files.doctor, /write_capable: false/);
  assert.doesNotMatch(files.doctor, /Command::new|powershell\.exe|setup\.ps1"\)/i);
  assert.doesNotMatch(files.doctorUi, /AutoRepair|ExecutionPolicy|setup\.ps1.*invoke/);
  assert.match(files.doctorUi, /showAllEvidence/);
  assert.match(files.doctorUi, /pluginDoctor\.copy/);
});

test("Codex doctor copy exports every bounded, redacted diagnostic section", () => {
  const copyStart = files.doctorUi.indexOf("async function copyReport()");
  const copyEnd = files.doctorUi.indexOf("  useEffect", copyStart);
  assert.ok(copyStart >= 0 && copyEnd > copyStart, "copyReport body should be discoverable");
  const copyReport = files.doctorUi.slice(copyStart, copyEnd);
  for (const field of [
    "report.summary",
    "report.platform",
    "report.versionState",
    "report.mutationCount",
    "report.inventory",
    "report.guarantees",
    "report.findings",
    "report.evidence"
  ]) {
    assert.ok(copyReport.includes(field), `${field} should be copied`);
  }
  assert.match(copyReport, /report\.guarantees\.map/);
  assert.match(copyReport, /report\.findings\.flatMap/);
  assert.match(copyReport, /report\.evidence\.flatMap/);
  assert.match(copyReport, /safeDiagnosticPath\(item\.redactedPath\)/);
  assert.doesNotMatch(copyReport, /report\.evidence\.slice/);
  assert.doesNotMatch(copyReport, /sha256|byteSize/);
  assert.match(files.doctorUi, /DIAGNOSTIC_FIELD_LIMIT = 600/);
  assert.match(files.doctorUi, /DIAGNOSTIC_PATH_LIMIT = 500/);
  assert.match(files.doctorUi, /absolute path|copyPathRedacted|\[a-z\]:/i);
  assert.ok(files.doctorUi.includes("authorization|password|secret|token"));
  assert.equal([...files.i18n.matchAll(/"pluginDoctor\.copyEvidence":/g)].length, 3);
  assert.equal([...files.i18n.matchAll(/"pluginDoctor\.copyPathRedacted":/g)].length, 3);
});

test("new capability surfaces are lazy-loaded instead of expanding the initial bundle", () => {
  assert.match(files.app, /lazy\(\(\) => import\("\.\/McpCenter"\)/);
  assert.match(files.app, /lazy\(\(\) =>\s*import\("\.\.?\/CodexPluginDoctorPanel"\)/);
  assert.doesNotMatch(files.app, /from "\.\.?\/(McpCenter|CodexPluginDoctorPanel)"/);
});

test("an unfinished add is kept as text only and restored only when the user asks", () => {
  // v3.3 (bug #17): no automatic reopening; only the typed address is remembered.
  const sheet = files.app.slice(files.app.indexOf('const DRAFT_KEY = "ai-skillhub-import-draft-v33";'), files.app.indexOf("function ProbePreview"));
  assert.ok(sheet.length > 0);
  assert.ok(sheet.includes("window.localStorage.setItem(DRAFT_KEY, value.slice(0, 2048));"));
  assert.ok(sheet.includes("const [input, setInput] = useState(initialText);"));
  assert.ok(sheet.includes('const [draft] = useState(() => (initialText ? "" : readDraft()));'));
  assert.ok(sheet.includes('{empty && draft && phase.kind === "idle" && ('));
  assert.ok(sheet.includes('{t("v33.restoreDraft")}'));
  assert.doesNotMatch(sheet, /setItem\(DRAFT_KEY, JSON\.stringify/);
  assert.doesNotMatch(files.app, /loadImportWizardDraft\(\)|saveImportWizardDraft/);
});
