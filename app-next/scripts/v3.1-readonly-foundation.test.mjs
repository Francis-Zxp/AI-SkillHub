import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const files = {
  app: await readFile(new URL("../src/App.tsx", import.meta.url), "utf8"),
  mcpUi: await readFile(new URL("../src/McpCenter.tsx", import.meta.url), "utf8"),
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
});

test("Codex doctor guarantees zero writes and does not execute the standalone repair path", () => {
  assert.match(files.doctor, /mutation_count: 0/);
  assert.match(files.doctor, /repair_available: false/);
  assert.match(files.doctor, /write_capable: false/);
  assert.doesNotMatch(files.doctor, /Command::new|powershell\.exe|setup\.ps1"\)/i);
  assert.doesNotMatch(files.doctorUi, /AutoRepair|ExecutionPolicy|setup\.ps1.*invoke/);
});

test("new capability surfaces are lazy-loaded instead of expanding the initial bundle", () => {
  assert.match(files.app, /lazy\(\(\) => import\("\.\/McpCenter"\)/);
  assert.match(files.app, /import\("\.\/CodexPluginDoctorPanel"\)/);
});
