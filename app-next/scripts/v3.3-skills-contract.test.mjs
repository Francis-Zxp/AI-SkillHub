// v3.3 Skills contract, frontend half (docs/v3.3/skills-contract.md §8.2).
// Checks that need the skills-backend track's lib.rs are skipped until that code is present.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { readAppSource } from "./app-source.mjs";

const read = async path => (await readFile(new URL(path, import.meta.url), "utf8")).replace(/\r\n/g, "\n");
const [contract, types, api, i18n, i18nV33, lib, capabilities, tauriConf, library, app, skillErrors, deliveryView, telemetry, indexHtml, main] = await Promise.all([
  read("../../docs/v3.3/skills-contract.md"),
  read("../src/types.ts"),
  read("../src/skillApi.ts"),
  read("../src/i18n.ts"),
  read("../src/i18nV33.ts"),
  read("../src-tauri/src/lib.rs"),
  read("../src-tauri/capabilities/default.json"),
  read("../src-tauri/tauri.conf.json"),
  read("../src/pages/Library.tsx"),
  readAppSource(),
  read("../src/skillErrors.ts"),
  read("../src/deliveryView.ts"),
  read("../src/telemetry.ts"),
  read("../index.html"),
  read("../src/main.tsx")
]);

async function loadModule(source) {
  const javascript = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 }
  }).outputText;
  return import(`data:text/javascript,${encodeURIComponent(javascript)}`);
}
const errors = await loadModule(skillErrors);
const view = await loadModule(deliveryView);

const backendMerged = /fn get_skill_delivery_state/.test(lib);
const backendSkip = backendMerged ? false : "lib.rs half lands with the skills-backend track";
const tsBlock = contract.slice(contract.indexOf("### 4.3 TS types"), contract.indexOf("### 4.4"));
const commandTable = contract.slice(contract.indexOf("### 4.2 Command list"), contract.indexOf("Event names, defined as constants"));
const commands = [...commandTable.matchAll(/^\| \d+ \| `([a-z_]+)` \|/gm)].map(match => match[1]);

test("1. types.ts carries every §4.3 type and the snapshot field", () => {
  const names = [...tsBlock.matchAll(/^export type ([A-Za-z]+)/gm)].map(match => match[1]);
  assert.ok(names.length >= 59, `parsed ${names.length} contract types`);
  for (const name of names) assert.match(types, new RegExp(`export type ${name}\\b`), name);
  assert.match(types, /skillDelivery\?: SkillDeliveryState;/);
  const navKey = types.slice(types.indexOf("export type NavKey"), types.indexOf(";", types.indexOf("export type NavKey")));
  assert.doesNotMatch(navKey, /"workspaces"|"sources"/, "NavKey drops workspaces and sources");
});

test("2. skillApi.ts invokes exactly the §4.2 commands", () => {
  assert.equal(commands.length, 23);
  const invoked = new Set([...api.matchAll(/invoke<[^>]*>\("([a-z_]+)"/g)].map(match => match[1]));
  for (const command of commands) assert.ok(invoked.has(command), `skillApi wraps ${command}`);
  // Argument keys are camelCase, as Tauri 2 maps them to the snake_case Rust parameters.
  assert.match(api, /invoke<TakeoverResult>\("set_agent_takeover", \{ agentId, enabled, fillTargets: fillTargets \?\? null \}\)/);
  assert.match(api, /invoke<TargetMutationResult>\("set_skill_target", \{ unitId, agentId, enabled \}\)/);
  assert.match(api, /invoke<SourceLibraryResult>\("set_source_library_enabled", \{ sourceId, enabled, securityReviewConfirmed \}\)/);
  assert.match(api, /invoke<DeliveryJobTicket>\("request_skill_delivery", \{ reason, depth, refreshDetection: refreshDetection \?\? null \}\)/);
  assert.match(api, /invoke<SkillSourceProbe>\("probe_skill_source", \{ operationId, input \}\)/);
  assert.match(api, /invoke<InstallSkillSourceResult>\("install_skill_source", \{ request \}\)/);
  assert.match(api, /invoke<OnboardingResult>\("complete_onboarding", \{ agentIds, adoptExistingSkills \}\)/);
  for (const event of ["delivery-status", "skill-source-dropped", "source-import-progress"]) assert.ok(api.includes(`"${event}"`));
});

test("2b. every wrapped command is registered in lib.rs", { skip: backendSkip }, () => {
  const handler = lib.slice(lib.indexOf("generate_handler!["), lib.indexOf("])", lib.indexOf("generate_handler![")));
  for (const command of commands) assert.match(handler, new RegExp(`\\b${command}\\b`), command);
});

test("3. the consent pill and Workspaces are gone from the UI", () => {
  assert.doesNotMatch(app, /set_real_write_authorization|topbar\.statusUnauthorized|<Workspaces|status-pill/);
  assert.doesNotMatch(app, /key: "workspaces"|value === "workspaces" \|\|/);
  assert.match(app, /if \(view === "workspaces"\) return "agents";/);
  assert.match(app, /if \(view === "sources"\) return "library";/);
});

test("3b. lib.rs no longer registers the no-op commands", { skip: backendSkip }, () => {
  const handler = lib.slice(lib.indexOf("generate_handler!["), lib.indexOf("])", lib.indexOf("generate_handler![")));
  for (const command of ["set_real_write_authorization", "set_workspace_enabled", "set_preset_enabled", "set_preset_workspace_enabled"]) {
    assert.doesNotMatch(handler, new RegExp(`\\b${command}\\b`), command);
  }
});

test("4-5. new commands are async and client writes stop while blocked", { skip: backendSkip }, () => {
  for (const command of commands.filter(name => name !== "parse_skill_source_input")) {
    assert.match(lib, new RegExp(`async fn ${command}\\(`), command);
  }
  const linkScript = lib.slice(lib.indexOf("fn run_agent_link_script"), lib.indexOf("fn run_agent_link_script") + 600);
  assert.match(linkScript, /delivery_writes_blocked/);
});

test("6. no dialog capability, and native drop means no HTML5 drag inside the library", () => {
  assert.doesNotMatch(capabilities, /"dialog:/);
  const dragDropEnabled = JSON.parse(tauriConf).app.windows[0].dragDropEnabled;
  assert.equal(dragDropEnabled, true);
  assert.doesNotMatch(library, /draggable=/);
  assert.doesNotMatch(library, /dataTransfer\.setData/);
});

test("7. zh UI strings outside developer mode use none of the banned words", () => {
  const banned = /宿主|投递|交付|闸门|隔离区|路由|staging|dry-run|适配器|待接管|真实写入/;
  // dev.* / adv.* / router.* are developer-mode only; mcp.* is owned by the MCP contract.
  const allowed = /^(dev|adv|router|mcp)\./;
  const zh = i18n.slice(i18n.indexOf("const zh: Dict = {"), i18n.indexOf("const ko: Dict = {"));
  const zhV33 = i18nV33.slice(i18nV33.indexOf("const ERR_CODES_ZH"), i18nV33.indexOf("const ERR_CODES_KO"))
    + i18nV33.slice(i18nV33.indexOf("const AUDIT_ZH"), i18nV33.indexOf("const AUDIT_KO"))
    + i18nV33.slice(i18nV33.indexOf("export const v33zh"), i18nV33.indexOf("export const v33ko"));
  const offenders = [];
  for (const block of [zh, zhV33]) {
    for (const match of block.matchAll(/^\s*"([^"]+)":\s*"((?:[^"\\]|\\.)*)"/gm)) {
      if (!allowed.test(match[1]) && banned.test(match[2])) offenders.push(`${match[1]}: ${match[2]}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("8. the child switch reports failure and delivery actions never lock the window", () => {
  const child = app.slice(app.indexOf("async function setChildSkillEnabled"), app.indexOf("async function setSourceLibraryEnabled"));
  assert.match(child, /catch \{[\s\S]*?return false;/);
  assert.doesNotMatch(child, /catch[^{]*\{[^}]*return true/);
  for (const name of ["setChildSkillEnabled", "setTarget", "setTargetsBatch", "setTakeover", "setPaused", "requestDelivery", "setSourceLibraryEnabled"]) {
    const start = app.indexOf(`async function ${name}(`);
    assert.ok(start >= 0, name);
    const body = app.slice(start, app.indexOf("\n  }\n", start));
    assert.doesNotMatch(body, /setLoading\(true\)/, name);
  }
});

test("10. the sync indicator has five tones in priority order; every target status has a look", () => {
  const agent = (extra = {}) => ({ id: "claude", takeover: true, installed: true, ...extra });
  const base = { paused: false, onboarding: "completed", agents: [agent()], problems: [], job: null };
  assert.equal(view.topSyncIndicator({ ...base, paused: true, problems: [{}], job: { phase: "running", waitingFor: "" } }).tone, "busy");
  assert.equal(view.topSyncIndicator({ ...base, paused: true, problems: [{}] }).tone, "paused");
  assert.equal(view.topSyncIndicator({ ...base, onboarding: "pending", problems: [{}] }).tone, "idle");
  assert.equal(view.topSyncIndicator({ ...base, agents: [agent({ takeover: false })], problems: [{}] }).tone, "idle");
  assert.equal(view.topSyncIndicator({ ...base, problems: [{}, {}] }).tone, "problem");
  assert.deepEqual(view.topSyncIndicator(base), { tone: "ok", labelKey: "sync.ok", vars: { n: 1 }, waitingFor: "" });
  const statuses = ["synced", "off", "pending", "removing", "paused", "conflict", "error", "orphan", "blocked", "takeover-off", "unsupported"];
  assert.deepEqual(Object.keys(view.TARGET_ICON_VIEWS).sort(), [...statuses].sort());
  assert.equal(view.targetIconView({ status: "synced", conflict: null }).action, "remove");
  assert.equal(view.targetIconView({ status: "off", conflict: null }).action, "add");
  assert.equal(view.targetIconView({ status: "pending", conflict: null }).disabled, true);
  assert.equal(view.targetIconView({ status: "blocked", conflict: null }, "security-review").action, "review");
  assert.equal(view.targetIconView({ status: "blocked", conflict: null }, "disabled-by-user").disabled, true);
  assert.equal(view.targetIconView({ status: "conflict", conflict: { sameContent: true } }).tooltipKey, "target.conflictSame");
  for (const status of statuses) {
    const key = view.TARGET_ICON_VIEWS[status].tooltipKey;
    for (const block of ["export const v33en", "export const v33zh", "export const v33ko"]) {
      const start = i18nV33.indexOf(block);
      assert.ok(i18nV33.slice(start, i18nV33.indexOf("\n};", start)).includes(`"${key}":`), `${key} in ${block}`);
    }
  }
});

test("11. normalizeSkillHubError never renders [object Object] and classifies every legacy pattern", () => {
  const samples = {
    "另一项刷新或写入任务正在运行": "WRITE_BUSY",
    "无法取得数据写入锁": "WRITE_BUSY",
    "GitHub API rate limit exceeded": "NETWORK_FAILED",
    "脚本运行超过 240 秒": "SCRIPT_TIMEOUT",
    "下载超过 120 秒": "DOWNLOAD_TIMEOUT",
    "Source metadata is too long": "INPUT_TOO_LONG",
    "Personal or external Skill entry preserved": "TARGET_CONFLICT",
    "Recipient Skills root is an external link": "AGENT_DIR_EXTERNAL_LINK",
    "交付验收失败": "DELIVERY_VERIFY_FAILED",
    "找不到同步脚本": "SCRIPT_MISSING",
    "Cannot open v2 SQLite database": "INDEX_FAILED",
    "导入已取消": "CANCELLED",
    "Agent Skill allowlist contains bad": "DELIVERY_POLICY_INVALID",
    "SKILL.md needs name and description": "MANIFEST_INVALID",
    "系统 Git 不可用": "GIT_MISSING",
    "something unexpected": "INTERNAL"
  };
  assert.ok(Object.keys(samples).length > 10);
  for (const [message, code] of Object.entries(samples)) assert.equal(errors.normalizeSkillHubError(message).code, code, message);
  assert.equal(errors.normalizeSkillHubError(new Error("导入已取消")).code, "CANCELLED");
  const structured = { code: "TARGET_CONFLICT", message: "冲突", detail: "", action: { kind: "resolve-conflict", payload: {} }, agentId: "claude", sourceId: null, path: null };
  assert.deepEqual(errors.normalizeSkillHubError(structured).action, { kind: "resolve-conflict", payload: {} });
  for (const value of [undefined, null, {}, { nested: { deep: true } }, 42]) {
    const normalized = errors.normalizeSkillHubError(value);
    assert.doesNotMatch(`${normalized.message} ${normalized.detail}`, /\[object Object\]/);
  }
  assert.doesNotMatch(errors.normalizeSkillHubError("token=ghp_abcdefghijklmnopqrstuvwxyz123456").message, /ghp_/);
  assert.match(app, /onDismiss=\{\(\) => setBanner\(null\)\}/);
  assert.match(app, /console\.warn\("Usage event was not recorded\."/);
});

test("shell: Ctrl/⌘+K focuses search; Ctrl+V outside a field routes to MCP or the add sheet", () => {
  assert.match(app, /\(event\.ctrlKey \|\| event\.metaKey\) && !event\.altKey && !event\.shiftKey && event\.key\.toLowerCase\(\) === "k"/);
  assert.match(app, /searchInputRef\.current\?\.focus\(\)/);
  assert.match(app, /\{isMac \? "⌘ K" : "Ctrl K"\}/);
  assert.match(app, /if \(target\?\.closest\?\.\("input, textarea, select, \[contenteditable='true'\]"\)\) return;/);
  assert.match(app, /if \(kind === "mcp-config"\) \{\s*requestOpenMcpAdd\(text\);/);
  assert.match(app, /openImport\(text\.trim\(\), true\)/);
});

test("usage statistics are disclosed, default on, and not loaded while off", () => {
  assert.match(indexHtml, /<script\s+type="text\/plain"\s+id="vc-telemetry-config"/);
  assert.doesNotMatch(indexHtml, /<script[^>]*\ssrc="https:\/\/vibecafe/);
  assert.match(telemetry, /return window\.localStorage\.getItem\(TELEMETRY_KEY\) !== "0";/);
  assert.match(telemetry, /if \(injected \|\| typeof document === "undefined" \|\| !telemetryEnabled\(\)\) return;/);
  assert.match(main, /window\.setTimeout\(loadTelemetry, 4_000\)/);
  assert.match(i18nV33, /"v33\.telemetryBody": "通过 vibecafe\.ai 发送匿名的使用次数/);
});

test("memory: pages load on demand and the library keeps one snapshot copy", () => {
  for (const page of ["Dashboard", "Library", "Agents", "Settings", "ImportSheet", "Onboarding", "SkillDrawer"]) {
    assert.match(app, new RegExp(`lazy\\(\\(\\) => import\\("\\./pages/${page}"\\)`), page);
  }
  assert.match(app, /const \{ skillDelivery, \.\.\.lean \} = nextSnapshot;/);
  assert.match(app, /\{active === "dashboard" && !showOnboarding && \(/, "home and its 3D scene unmount when another page is open");
  assert.doesNotMatch(app, /dashboardVisited/);
});

/* ---------- review fixes (frontend) ---------- */

const [agentTextSource, shellSource, dashboardSource, homeCss, importSheetSource, agentsSource] = await Promise.all([
  read("../src/agentText.ts"),
  read("../src/components/shell.tsx"),
  read("../src/pages/Dashboard.tsx"),
  read("../src/pages/home.css"),
  read("../src/pages/ImportSheet.tsx"),
  read("../src/pages/Agents.tsx")
]);

async function loadAgentText() {
  const stubI18n = `let lang = "zh"; export const getLang = () => lang; export const __setLang = value => { lang = value; };
    export const t = (key, vars = {}) => key.startsWith("err.") && key !== "err.TARGET_CONFLICT" ? key : \`\${key}\${JSON.stringify(vars)}\`;`;
  const i18nUrl = `data:text/javascript,${encodeURIComponent(stubI18n)}`;
  const errorsUrl = `data:text/javascript,${encodeURIComponent(ts.transpileModule(skillErrors, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText)}`;
  const javascript = ts.transpileModule(agentTextSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText
    .replace(/from\s+["']\.\/i18n["']/, `from "${i18nUrl}"`)
    .replace(/from\s+["']\.\/skillErrors["']/, `from "${errorsUrl}"`);
  const [module, i18nModule] = await Promise.all([import(`data:text/javascript,${encodeURIComponent(javascript)}`), import(i18nUrl)]);
  return { ...module, setLang: i18nModule.__setLang };
}

test("review: en and ko rebuild the backend's Chinese sentences; zh keeps them", async () => {
  const text = await loadAgentText();
  const agents = [{ id: "antigravity", name: "Antigravity" }, { id: "codex", name: "Codex" }, { id: "coze", name: "扣子" }];
  const orphan = { code: "AGENT_NOT_INSTALLED", message: "Antigravity 已不在这台电脑上，但入口还在", agentId: "antigravity", unitId: "source-a" };
  const conflict = { code: "TARGET_CONFLICT", message: "Claude Code 里已有同名的个人技能", agentId: "antigravity", unitId: "source-a" };
  const codex = { id: "codex", linkedAgentIds: ["coze"], sharedFolderNote: "与 扣子 共用目录" };
  const cursor = { name: "Cursor", experimental: true, experimentalReason: "SkillHub 能写入并读回", afterSyncHint: "重新打开 Cursor 后生效" };
  text.setLang("zh");
  assert.equal(text.problemText(orphan, agents, () => "Pack A"), orphan.message);
  assert.equal(text.agentSharedNote(codex, agents), "与 扣子 共用目录");
  assert.equal(text.agentAfterSyncHint(cursor), "重新打开 Cursor 后生效");
  for (const lang of ["en", "ko"]) {
    text.setLang(lang);
    const lines = [
      text.problemText(orphan, agents, () => "Pack A"),
      text.problemText(conflict, agents),
      text.agentSharedNote(codex, agents),
      text.agentExperimentalReason(cursor),
      text.agentAfterSyncHint(cursor),
      text.agentUnsupportedReason("还不支持同步技能"),
      text.onboardingReason({ statusWord: "not-installed", canDeliver: true, reason: "没在这台电脑上找到" }),
      text.invalidSkillReason("缺少 name"),
      text.chipDisabledReason("需要先接管", "Cursor")
    ];
    for (const line of lines) assert.doesNotMatch(line, /[一-鿿]{2}/, `${lang}: ${line}`);
    assert.match(lines[0], /^v33\.problemOrphan.*"pack":"Pack A"/);
    assert.match(lines[2], /^v33\.sharedWithCoze/);
  }
  // Every caller goes through agentText instead of printing the backend field.
  assert.doesNotMatch(shellSource, /\{problem\.message\}/);
  assert.doesNotMatch(agentsSource, /\{problem\.message\}|\{agent\.(sharedFolderNote|experimentalReason|afterSyncHint)\}/);
  for (const key of ["v33.experimentalReason", "v33.afterSyncHint", "v33.problemOrphan", "v33.removeEntry"]) {
    for (const block of ["export const v33en", "export const v33zh", "export const v33ko"]) {
      const start = i18nV33.indexOf(block);
      assert.ok(i18nV33.slice(start, i18nV33.indexOf("\n};", start)).includes(`"${key}":`), `${key} in ${block}`);
    }
  }
});

test("review: a leftover entry in the 问题 list offers 移除入口", () => {
  assert.match(shellSource, /problem\.code === "AGENT_NOT_INSTALLED" && Boolean\(problem\.unitId && problem\.agentId\)/);
  assert.match(shellSource, /onClick=\{\(\) => onRemoveEntry\(problem\)\}/);
  assert.match(app, /onRemoveEntry=\{problem => \{[\s\S]*?setTarget\(problem\.unitId, problem\.agentId, false\)/);
});

test("review: a closed add sheet cancels its probe and cannot be torn down mid-install", () => {
  assert.match(importSheetSource, /if \(phaseKindRef\.current !== "installing"\) cleanupProbe\(\);/);
  for (const action of ["onOpenRow", "onGoAgents"]) {
    assert.match(importSheetSource, new RegExp(`disabled=\{installing\} onClick=\{${action}\}`), action);
  }
  assert.match(importSheetSource, /disabled=\{installing\} onClick=\{\(\) => onOpenMcp\(config\.relativePath\)\}/);
});

test("home keeps the 3.2.x layout: the scene fills the page, the numbers sit in the bottom bar", () => {
  // Nothing floats over the top of the scene any more (users: it covered the star map).
  assert.doesNotMatch(dashboardSource, /className="home-top"|--home-top-bottom|data-testid="home-add-input"/);
  assert.match(dashboardSource, /className=\{`metric-grid\$\{atlasMode \? " atlas-touchbar" : ""\}`\}/);
  assert.match(dashboardSource, /\{ value: "summary", label: t\("v33\.sceneSummary"\) \}/);
  assert.match(dashboardSource, /<div className="home-summary-scene" data-testid="home-summary">/);
  assert.doesNotMatch(homeCss, /--home-top-bottom/);
  // 首页场景: 归纳 spans the window without depending on the 3D stylesheet.
  assert.match(homeCss, /\.v33\.theme-family-atlas\.page-dashboard \.workspace \{ grid-column: 1 \/ -1; grid-row: 1; \}/);
});

test("review: pasted MCP text and add-sheet drafts never reach disk storage", async () => {
  const bridge = await read("../src/mcpBridge.ts");
  // WebView2 persists sessionStorage/localStorage in the user-data folder; MCP configs can hold keys.
  assert.doesNotMatch(bridge, /window.(sessionStorage|localStorage)/);
  assert.match(bridge, /export function takePendingMcpPaste\(\): string \| null/);
  assert.ok(importSheetSource.includes("/[\\r\\n]/.test(value.trim()) || looksLikeMcpConfig(value)"), "multi-line text and MCP configs are never drafts");
  assert.match(importSheetSource, /if \(value && draftLooksSecret\(value\)\) \{\s*window\.localStorage\.removeItem\(DRAFT_KEY\);/);
});
