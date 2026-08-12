import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const files = {
  app: await readFile(new URL("../src/App.tsx", import.meta.url), "utf8"),
  mcpUi: await readFile(new URL("../src/McpCenter.tsx", import.meta.url), "utf8"),
  i18n: await readFile(new URL("../src/i18n.ts", import.meta.url), "utf8"),
  styles: await readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
  doctorUi: await readFile(new URL("../src/CodexPluginDoctorPanel.tsx", import.meta.url), "utf8"),
  capabilities: await readFile(new URL("../src-tauri/capabilities/default.json", import.meta.url), "utf8"),
  backend: await readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8"),
  mcp: await readFile(new URL("../src-tauri/src/mcp_center.rs", import.meta.url), "utf8"),
  doctor: await readFile(new URL("../src-tauri/src/codex_plugin_doctor.rs", import.meta.url), "utf8")
};

test("GitHub import is driven by backend stages and supports cancellation", () => {
  assert.match(files.backend, /SOURCE_IMPORT_PROGRESS_EVENT: &str = "source-import-progress"/);
  assert.match(files.backend, /fn cancel_source_import/);
  assert.match(files.app, /listen<SourceImportProgressEvent>\("source-import-progress"/);
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
  assert.match(files.app, /catch \(error\) \{[\s\S]*continuing without live progress/);
  assert.match(files.app, /unlisten\?\.\(\)/);
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

test("MCP center is read-only, secret-safe and never probes live capabilities", () => {
  assert.match(files.mcp, /capability_state: "unprobed"\.to_string\(\)/);
  assert.match(files.mcp, /headersHelper/);
  assert.match(files.mcp, /Secret values[\s\S]*never enter the returned snapshot/);
  assert.doesNotMatch(files.mcp, /Command::new|\.spawn\(/);
  assert.match(files.mcpUi, /Capabilities not probed|mcp\.unprobed/);
  assert.match(files.mcpUi, /next\.bindings\.some\(item => item\.id === current\)/);
  assert.match(files.mcpUi, /mcp\.copyPath/);
});

test("MCP read and parse failures remain visible even when no binding can be created", () => {
  assert.match(files.mcpUi, /const globalDiagnosticGroups = useMemo/);
  assert.match(files.mcpUi, /locationId && inventory\.bindings\.some\(binding => binding\.configLocationId === locationId\)/);
  assert.match(files.mcpUi, /!locationId && inventory\.bindings\.some\(binding => binding\.hostId === finding\.hostId\)/);
  assert.match(files.mcpUi, /location\?\.pathDisplay \?\? finding\.pathDisplay \?\? ""/);
  assert.match(files.mcpUi, /location\.parseStatus === "ok"/);
  assert.match(files.mcpUi, /className="mcp-global-diagnostics"/);
  assert.match(files.mcpUi, /copyConfigPath\(group\.pathDisplay, group\.key\)/);
  assert.match(files.mcpUi, /copyConfigPath\(selectedLocation\?\.pathDisplay, "selected-binding"\)/);
  assert.doesNotMatch(files.mcpUi, /copyConfigPath\([^)]*\.configPath/);

  assert.match(files.mcpUi, /finding\.configLocationId === binding\.configLocationId/);
  assert.match(files.mcpUi, /finding\.hostId === binding\.hostId/);
  assert.match(files.i18n, /"mcp\.diagnosticsBody"/);
  assert.match(files.i18n, /界面中的路径均已脱敏/);
  assert.match(files.styles, /\.mcp-diagnostic-findings li \{[\s\S]*border: 1px solid var\(--border\)/);
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
  assert.match(files.app, /import\("\.\/CodexPluginDoctorPanel"\)/);
});

test("source import drafts survive navigation without persisting transient execution state", () => {
  assert.match(files.app, /IMPORT_WIZARD_DRAFT_STORAGE_KEY = "ai-skillhub-source-import-draft-v1"/);
  assert.match(files.app, /const \[initialDraft\] = useState\(loadImportWizardDraft\)/);
  assert.match(files.app, /useEffect\(\(\) => \{\s*saveImportWizardDraft\(\{/);
  assert.match(files.app, /resetImportDraft\(\);\s*setStatus\(\{\s*tone: "ok"/);
  assert.match(files.app, /t\("qa\.clearDraft"\)/);

  const draftType = files.app.match(/type ImportWizardDraft = \{([\s\S]*?)\n\};/)?.[1] ?? "";
  assert.match(draftType, /input: string/);
  assert.match(draftType, /selectedCategoryIds: string\[\]/);
  assert.doesNotMatch(draftType, /progress|status|securityReview|activeOperationId|operationId/);
});
