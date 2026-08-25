import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  containsObviousCredentialValue,
  evaluateMcpBindingManagement,
  mcpLocationScopeCompatible,
  mcpServerNameCompatible
} from "../src/mcpManagement.ts";

const files = {
  ui: await readFile(new URL("../src/McpCenter.tsx", import.meta.url), "utf8"),
  management: await readFile(new URL("../src/mcpManagement.ts", import.meta.url), "utf8"),
  managementI18n: await readFile(new URL("../src/mcpManagementI18n.ts", import.meta.url), "utf8"),
  managementStyles: await readFile(new URL("../src/McpCenter.css", import.meta.url), "utf8"),
  i18n: await readFile(new URL("../src/i18n.ts", import.meta.url), "utf8"),
  styles: await readFile(new URL("../src/styles.css", import.meta.url), "utf8")
};

function section(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.ok(startIndex >= 0, `${start} should exist`);
  assert.ok(endIndex > startIndex, `${end} should follow ${start}`);
  return source.slice(startIndex, endIndex);
}

test("MCP management uses the strict plan, confirm, apply and rollback command schema", () => {
  assert.match(files.ui, /invoke<McpMutationPlan>\("plan_mcp_changes", \{ request: \{ changes \} \}\)/);
  assert.match(files.ui, /data-requires-confirmation=\{plan\.requiresConfirmation \? "true" : "false"\}/);
  assert.match(files.ui, /invoke<McpApplyResult>\("apply_mcp_plan", \{ planId: pendingPlan\.planId \}\)/);
  assert.match(files.ui, /invoke<McpRollbackResult>\("rollback_mcp_snapshot", \{\s*snapshotId/);
  assert.match(files.ui, /invoke<McpRollbackSnapshot\[\]>\("list_mcp_rollback_snapshots"\)/);
  assert.match(files.ui, /invoke<McpMutationTargetOption\[\]>\("list_mcp_mutation_targets"\)/);

  const apply = section(files.ui, "async function applyPendingPlan()", "async function rollbackSnapshot(");
  const rollback = section(files.ui, "async function rollbackSnapshot(", "useEffect(() =>");
  assert.match(apply, /await Promise\.all\(\[scan\(\), loadManagementState\(\)\]\)/);
  assert.match(rollback, /await Promise\.all\(\[scan\(\), loadManagementState\(\)\]\)/);
  assert.match(files.ui, /rollbackSnapshots\.map\(snapshot =>/);
});

test("set-enabled keeps enabled at change top level while upsert keeps it in draft", () => {
  const selectedAction = section(files.ui, "async function planSelectedBinding", "async function applyPendingPlan");
  assert.match(selectedAction, /action === "set-enabled"\) change\.enabled = Boolean\(enabled\)/);
  assert.match(selectedAction, /action === "set-enabled" && management\.hostId === "host-claude-code"/);
  assert.doesNotMatch(selectedAction, /draft\s*:/);

  const parser = section(files.ui, "function parseMcpFormDraft", "function splitNonEmptyLines");
  assert.match(parser, /const bindingDraft: McpBindingDraft = \{[\s\S]*enabled: hostId === "host-claude-code" \? true : draft\.enabled/);
  assert.match(parser, /action: "upsert"[\s\S]*draft: bindingDraft/);
  assert.match(parser, /required: hostId === "host-codex" \? draft\.required : false/);
});

test("add form offers only discovered host scopes and blocks obvious credential values before planning", () => {
  assert.match(files.ui, /hostIds: \["host-codex", "host-claude-code"\]/);
  assert.match(files.ui, /scope: "user"/);
  assert.match(files.ui, /commonMcpTargets\(targetOptions, draft\.hostIds\)/);
  assert.match(files.ui, /scopeOptions\.map\(scope => <option/);
  assert.match(files.ui, /workspaceOptions\.map\(target =>/);
  assert.match(files.ui, /selectedTargets\.length !== draft\.hostIds\.length/);
  assert.match(files.ui, /"mcp\.targetUnavailable"/);
  assert.match(files.ui, /type="checkbox"/);
  assert.match(files.ui, /draft\.envVarsText\.split\(","\)/);
  assert.match(files.ui, /headerEnv\.push\(\{ headerName, envVarName \}\)/);
  assert.match(files.ui, /placeholder=\{"Authorization=API_TOKEN\\nX-Workspace=WORKSPACE_ID"\}/);
  const form = section(files.ui, "function McpManagementForm", "function McpPlanConfirmation");
  assert.doesNotMatch(form, /\stype="password"/i);
  assert.doesNotMatch(form, /\sname="[^"]*(?:token|secret|password|api.?key)/i);
  assert.doesNotMatch(files.ui, /\b(?:envValues|tokenValue|passwordValue|apiKeyValue)\s*[:=]/i);
  assert.match(files.ui, /"mcp\.noSecretValues"/);
  const parser = section(files.ui, "function parseMcpFormDraft", "function splitNonEmptyLines");
  assert.match(parser, /containsObviousCredentialValue\(\[draft\.command, draft\.url, draft\.argsText\]\.join\("\\n"\)\)/);
  assert.match(parser, /\/\[=:\]\/\.test\(draft\.envVarsText\)/);
  assert.match(parser, /containsObviousCredentialValue\(envVarName\)/);
  const credentialGuard = section(files.management, "export function containsObviousCredentialValue", "function writableHostId");
  for (const prefix of ["sk-", "github_pat_", "xox", "AIza", "AKIA", "eyJ"]) {
    assert.ok(credentialGuard.includes(prefix), `${prefix} should be blocked as an obvious credential prefix`);
  }
  assert.equal(containsObviousCredentialValue("--api-key\nordinary-looking-value"), true);
  assert.equal(containsObviousCredentialValue("-y\npackage-name"), false);
  assert.equal(containsObviousCredentialValue("-y\n@scope/token-helper"), false);
  assert.equal(containsObviousCredentialValue("--env\nAPI_TOKEN"), false);
  assert.equal(containsObviousCredentialValue("--env\nAPI_TOKEN=ordinary-looking-value"), true);
  assert.equal(containsObviousCredentialValue("API_TOKEN=ordinary-looking-value"), true);
  assert.match(files.managementI18n, /不要输入凭据值，只填环境变量名/);
});

test("existing bindings expose planned enable, delete and blank-target reconfiguration", () => {
  assert.match(files.ui, /export type McpBindingCard = \{[\s\S]*workspaceId\?: string \| null/);
  assert.match(files.ui, /planSelectedBinding\("set-enabled", !selectedBinding\.enabled\)/);
  assert.match(files.ui, /planSelectedBinding\("delete"\)/);
  assert.match(files.ui, /startReconfigure\(selectedBinding, selectedLocation\)/);

  const reconfigure = section(files.ui, "function startReconfigure", "async function planChanges");
  assert.match(reconfigure, /\.\.\.emptyMcpFormDraft\(\)/);
  assert.match(reconfigure, /hostIds: \[management\.hostId\]/);
  assert.match(reconfigure, /scope: management\.scope/);
  assert.match(reconfigure, /workspaceId: management\.workspaceId/);
  assert.match(reconfigure, /serverName: binding\.nativeName/);
  assert.doesNotMatch(reconfigure, /selectedServer|targetDisplayRedacted|binding\.enabled|command:|url:|secret/);
});

test("Claude enable state is delegated to host while delete and reconfigure remain available", () => {
  const actions = section(files.ui, '<div className="mcp-binding-actions"', '{selectedManagement && !selectedManagement.writable');
  assert.match(actions, /selectedBinding\.hostId === "host-claude-code"/);
  assert.match(actions, /"mcp\.claudeToggleInHost"/);
  assert.match(actions, /planSelectedBinding\("set-enabled", !selectedBinding\.enabled\)/);
  assert.match(actions, /startReconfigure\(selectedBinding, selectedLocation\)/);
  assert.match(actions, /planSelectedBinding\("delete"\)/);
  assert.equal([...files.managementI18n.matchAll(/"mcp\.claudeToggleInHost":/g)].length, 3);
});

test("Claude upserts stay enabled and use the no-dot shared name rule", () => {
  assert.equal(mcpServerNameCompatible("team.server", ["host-codex"]), true);
  assert.equal(mcpServerNameCompatible("team.server", ["host-claude-code"]), false);
  assert.equal(mcpServerNameCompatible("team.server", ["host-codex", "host-claude-code"]), false);
  assert.equal(mcpServerNameCompatible("team-server_2", ["host-codex", "host-claude-code"]), true);
  for (const reserved of ["workspace", "claude-in-chrome", "computer-use"]) {
    assert.equal(mcpServerNameCompatible(reserved, ["host-claude-code"]), false);
    assert.equal(mcpServerNameCompatible(reserved, ["host-codex"]), true);
  }

  const claudeDotted = evaluateMcpBindingManagement(
    { hostId: "host-claude-code", nativeScope: "user", nativeName: "team.server" },
    { hostId: "host-claude-code", nativeScope: "user/local", parseStatus: "ok" },
    true
  );
  assert.deepEqual(claudeDotted, { writable: false, reason: "invalid-name" });
  const codexDotted = evaluateMcpBindingManagement(
    { hostId: "host-codex", nativeScope: "user", nativeName: "team.server" },
    { hostId: "host-codex", nativeScope: "user", parseStatus: "ok" },
    true
  );
  assert.equal(codexDotted.writable, true);

  const form = section(files.ui, "function McpManagementForm", "function McpPlanConfirmation");
  assert.match(form, /const claudeSelected = draft\.hostIds\.includes\("host-claude-code"\)/);
  assert.match(form, /enabled: hostIds\.includes\("host-claude-code"\) \? true : draft\.enabled/);
  assert.match(form, /checked=\{claudeSelected \|\| draft\.enabled\}/);
  assert.match(form, /disabled=\{busy \|\| claudeSelected\}/);
  assert.match(form, /"mcp\.claudeEnabledRequired"/);

  const parser = section(files.ui, "function parseMcpFormDraft", "function splitNonEmptyLines");
  assert.match(parser, /mcpServerNameCompatible\(serverName, hostIds\)/);
  assert.match(parser, /hostId === "host-claude-code" \? true : draft\.enabled/);
  assert.equal([...files.managementI18n.matchAll(/"mcp\.invalidClaudeServerName":/g)].length, 3);
  assert.equal([...files.managementI18n.matchAll(/"mcp\.claudeEnabledRequired":/g)].length, 3);
});

test("existing project and Claude local bindings use binding workspace before location fallback", () => {
  const claudeLocal = evaluateMcpBindingManagement(
    {
      hostId: "host-claude-code",
      nativeScope: "local",
      nativeName: "demo",
      workspaceId: "workspace-from-binding"
    },
    {
      hostId: "host-claude-code",
      nativeScope: "user/local",
      parseStatus: "ok",
      workspaceId: null
    },
    true
  );
  assert.deepEqual(claudeLocal, {
    writable: true,
    hostId: "host-claude-code",
    scope: "local",
    workspaceId: "workspace-from-binding"
  });

  const codexProjectFallback = evaluateMcpBindingManagement(
    { hostId: "host-codex", nativeScope: "project", nativeName: "demo", workspaceId: null },
    { hostId: "host-codex", nativeScope: "project", parseStatus: "ok", workspaceId: "workspace-from-location" },
    true
  );
  assert.equal(codexProjectFallback.writable, true);
  assert.equal(codexProjectFallback.workspaceId, "workspace-from-location");

  const selectedAction = section(files.ui, "async function planSelectedBinding", "async function applyPendingPlan");
  assert.match(selectedAction, /if \(management\.workspaceId\) change\.workspaceId = management\.workspaceId/);
  assert.doesNotMatch(selectedAction, /selectedLocation\?\.workspaceId/);
});

test("binding management is enabled only for writable, parsed desktop targets", () => {
  assert.equal(mcpLocationScopeCompatible("host-claude-code", "user", "user/local"), true);
  assert.equal(mcpLocationScopeCompatible("host-claude-code", "local", "user/local"), true);
  assert.equal(mcpLocationScopeCompatible("host-claude-code", "project", "project"), true);
  assert.equal(mcpLocationScopeCompatible("host-codex", "user", "user"), true);
  assert.equal(mcpLocationScopeCompatible("host-codex", "project", "project"), true);
  assert.equal(mcpLocationScopeCompatible("host-codex", "user", "project"), false);
  assert.equal(mcpLocationScopeCompatible("host-claude-code", "local", "local"), false);

  const parseFailure = evaluateMcpBindingManagement(
    { hostId: "host-codex", nativeScope: "user", nativeName: "demo" },
    { hostId: "host-codex", nativeScope: "user", parseStatus: "error" },
    true
  );
  assert.deepEqual(parseFailure, { writable: false, reason: "parse-failed" });
  assert.match(files.ui, /disabled=\{!selectedManagement\?\.writable \|\| mutationBusy\}/);
  assert.match(files.ui, /className="mcp-management-readonly-note"/);
  assert.equal([...files.managementI18n.matchAll(/"mcp\.managementUnsupported":/g)].length, 3);
  assert.match(files.managementI18n, /Codex profile 绑定/);
  assert.doesNotMatch(files.managementI18n, /工作区不可用。仍可启停或删除/);
});

test("browser preview blocks writes and applied copy never claims a live call", () => {
  assert.match(files.ui, /disabled=\{!runtimeAvailable \|\| busy \|\| workspaceMissing \|\| targetUnavailable\}/);
  assert.match(files.ui, /bindingManagement\(selectedBinding, selectedLocation, runtimeAvailable\)/);
  assert.match(files.ui, /if \(!runtimeAvailable\) \{\s*setMutationError\(t\("mcp\.desktopOnly"\)\)/);
  assert.equal([...files.managementI18n.matchAll(/"mcp\.applySuccessBody":/g)].length, 3);
  assert.match(files.managementI18n, /配置已静态验证；重启宿主后在 \/mcp 验证运行。/);
  assert.doesNotMatch(files.managementI18n, /MCP (?:调用|서버 호출|server call)(?:成功| succeeded| 성공)/i);
});

test("rollback snapshots survive page remount discovery and disclose retention without secret material", () => {
  const loader = section(files.ui, "async function loadManagementState()", "function startAdd()");
  assert.match(loader, /list_mcp_rollback_snapshots/);
  assert.match(loader, /setRollbackSnapshots\(snapshots\)/);
  const effect = section(files.ui, "useEffect(() =>", "const selectedBinding");
  assert.match(effect, /void loadManagementState\(\)/);
  assert.match(files.managementI18n, /最多保留 7 天、16 份或 128 MiB/);
  assert.match(files.managementI18n, /Windows 会按当前用户加密保护原始字节/);
  const snapshotPanel = section(files.ui, "{rollbackSnapshots.length > 0 && (", "{globalDiagnosticGroups.length > 0 && (");
  assert.doesNotMatch(snapshotPanel, /backupPath|originalBytes|credentialValue/);
});

test("page header uses one concise static-validation boundary", () => {
  const header = section(files.ui, '<section className="page-header glow-card mcp-page-header">', '<section className="mcp-metrics"');
  assert.doesNotMatch(header, /mcp\.readOnly/);
  assert.match(files.i18n, /"mcp\.subtitle": "静态验证，不启动服务器。"/);
  assert.doesNotMatch(files.i18n, /看清连接，不冒险启动|完全只读/);
});

test("management and confirmation surfaces keep themed, responsive form controls", () => {
  assert.match(files.managementStyles, /\.mcp-management-panel,[\s\S]*\.mcp-plan-confirmation/);
  assert.match(files.managementStyles, /\.mcp-form-grid input,[\s\S]*background: color-mix\(in srgb, var\(--surface-soft\)/);
  assert.match(files.managementStyles, /\.mcp-form-grid input:focus-visible,[\s\S]*box-shadow:/);
  assert.match(files.managementStyles, /@container \(max-width: 680px\)[\s\S]*\.mcp-plan-targets li \{ grid-template-columns: 1fr; \}/);
});

test("MCP management copy and CSS stay in the lazy center chunk", () => {
  assert.match(files.ui, /import \{ mt as t \} from "\.\/mcpManagementI18n"/);
  assert.match(files.ui, /import "\.\/McpCenter\.css"/);
  assert.doesNotMatch(files.i18n, /"mcp\.add":/);
  assert.doesNotMatch(files.styles, /\.mcp-management-panel/);
  assert.equal([...files.managementI18n.matchAll(/"mcp\.add":/g)].length, 3);
  assert.match(files.managementI18n, /return sharedT\(key, vars\)/);
});
