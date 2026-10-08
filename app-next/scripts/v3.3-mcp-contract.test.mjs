// v3.3 MCP frontend contract (docs/v3.3/mcp-contract.md §7.2, F1–F10) plus unit tests of the
// pure page rules in src/mcp/mcpLogic.ts. Static checks read the sources; nothing is executed
// against a real AI tool. The browser flow itself is covered by scripts/v3.3-mcp-visual-qa.cjs.
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import {
  argsContainCredential,
  cellIntent,
  clientAvailability,
  columnStats,
  errorText,
  filterServers,
  historyLabel,
  historyPartialText,
  isRemoteTarget,
  normalizeCommand,
  outcomeToast,
  parseTimestamp,
  rememberAck,
  sameConfirmation,
  sanitizeServerName,
  serverMatchesQuery,
  skippedLines,
  sortIssues,
  splitCommandLine,
  targetLine,
  testAckKey,
  testText,
  validateEnvName,
  validateRemoteUrl,
  validateServerName
} from "../src/mcp/mcpLogic.ts";

const src = new URL("../src/", import.meta.url);
const read = path => readFile(new URL(path, src), "utf8");
const mcpDir = new URL("mcp/", src);
const mcpFiles = (await readdir(mcpDir)).filter(name => /\.(ts|tsx|css)$/.test(name));
const mcp = Object.fromEntries(await Promise.all(mcpFiles.map(async name => [name, await readFile(new URL(name, mcpDir), "utf8")])));
const code = Object.fromEntries(Object.entries(mcp).filter(([name]) => /\.(ts|tsx)$/.test(name)));
const recipeCard = await read("McpRecipeCard.tsx");
const center = await read("McpCenter.tsx");
const preview = await read("preview.ts");
const mcpPreview = await read("mcpPreview.ts");
const i18n = await read("mcpManagementI18n.ts");
const app = await read("App.tsx");
const githubImport = await readFile(new URL("../src-tauri/src/mcp_github_import.rs", import.meta.url), "utf8").catch(() => "");

/** Bodies of every useEffect(...) call, found by brace matching. */
function effectBodies(source) {
  const bodies = [];
  let index = source.indexOf("useEffect(");
  while (index >= 0) {
    const open = source.indexOf("{", index);
    let depth = 0;
    let end = open;
    for (; end < source.length; end += 1) {
      if (source[end] === "{") depth += 1;
      else if (source[end] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    bodies.push(source.slice(open, end + 1));
    index = source.indexOf("useEffect(", end);
  }
  return bodies;
}

function dictionary(name) {
  const start = i18n.indexOf(`const ${name}: Dictionary = {`);
  const end = i18n.indexOf("\n};", start);
  assert.ok(start >= 0 && end > start, `${name} dictionary`);
  const map = new Map();
  for (const match of i18n.slice(start, end).matchAll(/^\s*"([^"]+)":\s*"((?:[^"\\]|\\.)*)"/gm)) map.set(match[1], match[2]);
  return map;
}

const COMMANDS = [...mcp["mcpTypes.ts"].matchAll(/"(mcp_[a-z_]+)"/g)].map(match => match[1]).filter((name, index, list) => list.indexOf(name) === index);

test("F1 only mcpApi.ts talks to the runtime, and the preview mock answers every command", () => {
  for (const [name, source] of Object.entries(code)) {
    if (name === "mcpApi.ts") continue;
    assert.doesNotMatch(source, /from "@tauri-apps\/api\/core"/, `${name} imports invoke`);
    assert.doesNotMatch(source, /\binvoke\s*[<(]/, `${name} calls invoke`);
  }
  assert.match(code["mcpApi.ts"], /import \{ invoke \} from "@tauri-apps\/api\/core"/);
  assert.equal(COMMANDS.length, 23);
  const handlers = mcpPreview.slice(mcpPreview.indexOf("const HANDLERS"), mcpPreview.indexOf("export async function previewMcp"));
  for (const command of COMMANDS) {
    assert.match(handlers, new RegExp(`\\b${command}:`), `preview mock misses ${command}`);
    assert.match(code["mcpApi.ts"], new RegExp(`"${command}"`), `mcpApi misses ${command}`);
  }
  // The mock stays out of the desktop bundle: preview.ts reaches it through a dynamic import only.
  assert.match(preview, /export function previewMcp<R>/);
  assert.match(preview, /export function previewMcpSubscribe/);
  assert.match(preview, /import\("\.\/mcpPreview"\)/);
  assert.doesNotMatch(preview, /from "\.\/mcpPreview"/);
});

test("F2 the old plan/apply/list commands are gone from the MCP UI", () => {
  for (const [name, source] of [...Object.entries(code), ["McpRecipeCard.tsx", recipeCard]]) {
    assert.doesNotMatch(source, /plan_mcp_changes|apply_mcp_plan|list_mcp_mutation_targets|list_mcp_rollback_snapshots/, name);
  }
});

test("F3 Origin detection runs only on a click, never on mount (bug #23, M0-11)", () => {
  assert.doesNotMatch(recipeCard, /useEffect\s*\(/);
  assert.equal([...recipeCard.matchAll(/"detect_mcp_recipe"/g)].length, 2, "type union + the detect() call only");
  const detect = recipeCard.slice(recipeCard.indexOf("async function detect("), recipeCard.indexOf("async function connect("));
  assert.match(detect, /recipeCommand\("detect_mcp_recipe", runtimeAvailable\)/);
  // detect() is reached only from onClick handlers or explicit retries after a failed click action.
  const callers = [...recipeCard.matchAll(/\bdetect\(/g)].length;
  const clickCallers = [...recipeCard.matchAll(/onClick=\{[^}]*?detect\(/gs)].length;
  assert.ok(clickCallers >= 2 && callers >= clickCallers, `${clickCallers}/${callers}`);
  // Writing goes through the MCP library (one confirmation path, per-client results) …
  assert.match(recipeCard, /return \{ name: "origin", transport: "stdio", command: runtimePython, args: \[\.\.\.ORIGIN_ARGS\], source: \{ kind: "recipe", id: "origin-mcp" \} \};/);
  // … never with "skip": against the real backend that leaves a listed origin untouched and writes
  // nothing (noop), which is exactly bug #24 again. A listed origin with this runtime is switched on
  // in the new tools; another Python is replaced only after a plain "yes" in the card.
  assert.doesNotMatch(recipeCard, /onConflict: "skip"/);
  assert.match(recipeCard, /outcome = await onEnable\(originRow\.id, selected\);/);
  assert.match(recipeCard, /if \(!matchesRecipe\(stored, current\.runtimePython\)\) \{\s*setReplaceAsk\(current\);/);
  assert.match(recipeCard, /onClick=\{\(\) => void connect\(replaceAsk, true\)\}/);
  // … and client chips come from the snapshot and stay visible after connecting (bugs #24, MCP#9).
  assert.match(recipeCard, /snapshot\?\.clients \?\? \[\]/);
  assert.match(recipeCard, /originRow\?\.cells\.find/);
  assert.match(recipeCard, /disabled=\{busy \|\| option\.connected\}/);
});

test("F4 secret inputs are masked, never autofilled and cleared after every request", () => {
  for (const name of ["McpAddSheet.tsx", "McpEditDrawer.tsx"]) {
    const source = code[name];
    const inputs = [...source.matchAll(/<input\b[\s\S]*?\/>/g)].map(match => match[0]).filter(tag => /type=\{?[^}\n]*"password"/.test(tag));
    assert.ok(inputs.length >= 2, `${name} has password inputs`);
    for (const tag of inputs) {
      assert.match(tag, /autoComplete="off"/, `${name}: ${tag.slice(0, 80)}`);
      assert.match(tag, /spellCheck=\{false\}/, `${name}: ${tag.slice(0, 80)}`);
    }
  }
  const sheet = code["McpAddSheet.tsx"];
  assert.match(sheet, /\} finally \{\s*clearSecretState\(\);/);
  assert.match(sheet, /function clearSecretState\(\) \{\s*setSecrets\(rows => rows\.map\(row => \(\{ \.\.\.row, value: "" \}\)\)\);/);
  const drawer = code["McpEditDrawer.tsx"];
  assert.match(drawer, /\} finally \{\s*setNewSecrets\(rows => rows\.map\(row => \(\{ \.\.\.row, value: "" \}\)\)\);/);
  assert.match(drawer, /\} finally \{\s*setSecretValues\(current => \(\{ \.\.\.current, \[secret\.name\]: "" \}\)\);/);
  for (const [name, source] of Object.entries(code)) assert.doesNotMatch(source, /console\.(log|info|warn|error|debug)/, name);
  // Pasted values stay in the backend vault: the sheet sends handles, never re-reads them.
  assert.match(sheet, /pasteValueHandle: keepPasted \? secret\.pasteValueHandle : undefined/);
  // Nothing in the MCP page persists pasted text or secrets to browser storage.
  for (const [name, source] of Object.entries(code)) {
    assert.doesNotMatch(source, /sessionStorage\./, name);
    const writes = [...source.matchAll(/localStorage\.setItem\(([^,]+),/g)].map(match => match[1].trim());
    for (const key of writes) assert.equal(key, "TEST_ACK_STORAGE_KEY", `${name} writes ${key}`);
  }
});

test("F5 a test runs only from the click path, after the command was shown", () => {
  const page = code["McpPage.tsx"];
  const runTest = page.slice(page.indexOf("async function runTest("), page.indexOf("// ---------- add / edit submit"));
  const startTest = page.slice(page.indexOf("async function startTest("), page.indexOf("async function runTest("));
  assert.match(startTest, /await mcpApi\.testPreview\(serverId\)/);
  assert.ok(startTest.indexOf("testPreview(") < startTest.indexOf("runTest("));
  assert.match(runTest, /mcpApi\.testServer\(\{ serverId, previewToken: testPreview\.previewToken \}\)/);
  for (const [name, source] of Object.entries(code)) {
    const outside = name === "McpPage.tsx" ? source.replace(runTest, "") : source;
    if (name !== "mcpApi.ts") assert.doesNotMatch(outside, /\.testServer\(/, `${name} calls testServer outside runTest`);
    for (const body of effectBodies(source)) {
      assert.doesNotMatch(body, /testServer\(|runTest\(|startTest\(|importGithub\(|runGithub\(/, `${name} effect starts a test or a network import`);
    }
  }
  // GitHub reads happen in click handlers: Discover's submit and the paste box button.
  assert.match(page, /async function openGithub\(source: string\)[\s\S]*?await mcpApi\.importGithub\(source\)/);
  assert.match(code["McpAddSheet.tsx"], /onClick=\{\(\) => void runGithub\(pasteText\)\}/);
  // Acknowledgement is a per-viewer convenience keyed by server and revision, wrapped in try/catch.
  assert.match(page, /function readAcks\(\): string\[\] \{\s*try \{/);
  assert.match(page, /function writeAcks\(list: string\[\]\) \{\s*try \{/);
});

test("F6 the edit drawer starts from the stored transport (bug #6)", () => {
  const drawer = code["McpEditDrawer.tsx"];
  assert.match(drawer, /function formFrom\(detail: McpServerDetail\): Form \{\s*return \{\s*transport: detail\.transport,/);
  assert.doesNotMatch(drawer, /useState<McpTransport>\("stdio"\)|transport: "stdio"/);
  assert.match(drawer, /mcpApi\.getServer\(serverId\)/);
  assert.match(drawer, /expectedRevision: detail\.specRevision/);
  assert.match(drawer, /outcome\.error\.code === "revision-conflict"\) await load\(t\("mcp\.err\.revision-conflict"\)\)/);
  // Masked arguments are sent back as the mask so the stored value is kept.
  assert.match(drawer, /value: arg\.masked \? SECRET_MASK : arg\.value/);
});

test("F7 plain-language zh copy and identical zh/en/ko key sets", () => {
  const zh = dictionary("zh");
  const en = dictionary("en");
  const ko = dictionary("ko");
  assert.deepEqual([...en.keys()].sort(), [...zh.keys()].sort());
  assert.deepEqual([...ko.keys()].sort(), [...zh.keys()].sort());
  const banned = ["宿主", "绑定", "逻辑服务器", "能力未探测", "静态验证", "当前项目", "作用域", "binding", "upsert", "set-enabled", "redacted", "secretReferences", "preserved", "configured", "absent", "mcp-plan-", "mcp-snap"];
  for (const [key, value] of zh) for (const word of banned) assert.ok(!value.includes(word), `${key} contains ${word}`);
  // Every key the page uses exists; placeholders match across languages.
  const used = new Set();
  for (const source of Object.values(code)) for (const match of source.matchAll(/"(mcp\.[a-zA-Z0-9.\-]+)"/g)) used.add(match[1]);
  for (const key of used) assert.ok(zh.has(key), `missing ${key}`);
  const holes = value => [...(value ?? "").matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort().join(",");
  for (const [key, value] of zh) {
    assert.equal(holes(en.get(key)), holes(value), `en placeholders of ${key}`);
    assert.equal(holes(ko.get(key)), holes(value), `ko placeholders of ${key}`);
  }
  // Every error code, readonly reason and cell reason has copy.
  const errorCodes = [...mcp["mcpTypes.ts"].slice(mcp["mcpTypes.ts"].indexOf("export type McpErrorCode"), mcp["mcpTypes.ts"].indexOf("export type McpError =")).matchAll(/"([a-z-]+)"/g)].map(match => match[1]);
  assert.ok(errorCodes.length > 30);
  for (const code of errorCodes) assert.ok(zh.has(`mcp.err.${code}`), `mcp.err.${code}`);
  const reasons = [...mcp["mcpTypes.ts"].slice(mcp["mcpTypes.ts"].indexOf("export type McpReadonlyReason"), mcp["mcpTypes.ts"].indexOf("export type McpClient =")).matchAll(/"([a-z-]+)"/g)].map(match => match[1]);
  const cellReasons = [...mcp["mcpTypes.ts"].slice(mcp["mcpTypes.ts"].indexOf("export type McpCellReason"), mcp["mcpTypes.ts"].indexOf("export type McpCell =")).matchAll(/"([a-z-]+)"/g)].map(match => match[1]);
  for (const reason of [...reasons, ...cellReasons]) assert.ok(zh.has(`mcp.reason.${reason}`), `mcp.reason.${reason}`);
  // Retired keys (bug #20) are gone.
  for (const key of ["mcp.githubImportBody", "mcp.unprobed", "mcp.staticVerified", "mcp.planFirst", "mcp.confirmBoundary", "mcp.snapshotRetention"]) {
    assert.ok(!i18n.includes(`"${key}"`), key);
  }
  assert.match(i18n, /return sharedT\(key, vars\)/);
});

test("F8 .sr-only is defined in CSS the MCP page loads (bug #26)", () => {
  assert.match(mcp["mcp.css"], /\.sr-only \{[\s\S]*?clip: rect\(0 0 0 0\)/);
  assert.match(code["McpPage.tsx"], /import "\.\/mcp\.css";/);
});

test("F9 MCP code sends no telemetry", () => {
  for (const [name, source] of [...Object.entries(code), ["McpRecipeCard.tsx", recipeCard]]) {
    assert.doesNotMatch(source, /record_usage_event|telemetry|vibecafe|trackEvent/i, name);
  }
});

test("F10 McpCenter re-exports the new page so App.tsx needs no change", () => {
  assert.match(center, /export \{ McpPage as McpCenter \} from "\.\/mcp\/McpPage";/);
  assert.match(app, /lazy\(\(\) => import\("\.\/McpCenter"\)\.then\(module => \(\{ default: module\.McpCenter \}\)\)\)/);
  assert.match(code["McpPage.tsx"], /export function McpPage\(\{ runtimeAvailable = isDesktop\(\), initialPaste, takePendingPaste \}: McpPageProps\)/);
  // Hand-off from "+ 添加": memory only, opened once per mount or per event.
  assert.match(code["McpPage.tsx"], /export const OPEN_MCP_ADD_EVENT = "ai-skillhub-open-mcp-add";/);
  assert.match(code["McpPage.tsx"], /window\.addEventListener\(OPEN_MCP_ADD_EVENT, onOpenAdd\)/);
  // With the Skills shell merged, its in-memory takePendingMcpPaste() is used without an App.tsx prop.
  assert.match(code["McpPage.tsx"], /import\.meta\.glob<\{ takePendingMcpPaste\?: \(\) => string \| null \}>\("\.\.\/mcpBridge\.ts"\)/);
  // MCP overlays tell the shell to keep its global shortcuts and paste routing quiet.
  assert.match(code["mcpUi.tsx"], /data-overlay="mcp"/);
});

test("page rules: one write at a time, generation guard, no polling while hidden", () => {
  const page = code["McpPage.tsx"];
  assert.match(page, /function enqueue<T>\(job: \(\) => Promise<T>\): Promise<T> \{\s*const run = queue\.current\.then\(job, job\);/);
  assert.match(page, /if \(next\.generation < latestGeneration\.current\) return next;/);
  assert.match(page, /if \(document\.hidden\) \{\s*dirtyWhileHidden\.current = true;/);
  for (const [name, source] of Object.entries(code)) assert.doesNotMatch(source, /setInterval\(/, `${name} polls`);
  // busy → one automatic retry after 1 s (contract §3.5).
  assert.match(page, /if \(error\.code !== "busy"\) throw error;\s*await delay\(1000\);/);
  // Confirmations only come from the backend's needs-confirmation outcome. A confirmed call that
  // comes back with the same question under a fresh token (the token binds deleteEnvVars ticked in
  // the dialog) is accepted once without asking again; anything that changed is asked again.
  assert.match(page, /if \(outcome\.kind === "needs-confirmation"\) \{[\s\S]*?if \(approved && answer && sameConfirmation\(approved, outcome\.confirmation\)\) \{[\s\S]*?const next = await askConfirm\(outcome\.confirmation\);/);
  assert.match(page, /approved = null;\s*continue;/);
  // Results appear where the user is: a fixed toast stack and the cell itself (brief §7 #4).
  assert.match(mcp["mcp.css"], /\.mcp-toast-stack \{\s*position: fixed;/);
});

test("GitHub import stays bounded, redirect-free and token-free (backend safety intent)", { skip: !githubImport }, () => {
  assert.match(githubImport, /const MAX_CONFIG_BYTES: usize = 96 \* 1024/);
  assert.match(githubImport, /\.redirects\(0\)/);
  assert.doesNotMatch(githubImport, /github_api_token/);
  assert.doesNotMatch(githubImport, /Authorization.*Bearer \{token\}/);
});

// ---------- unit tests of mcpLogic.ts ----------

const t = (key, vars = {}) => {
  const table = {
    "mcp.list.sep": "、",
    "mcp.list.more": "{items} 等另外 {n} 个",
    "mcp.row.extraArgs": "+{n} 个参数",
    "mcp.row.noTarget": "没有命令",
    "mcp.test.untested": "未测试",
    "mcp.test.okTools": "可用 · {n} 个工具",
    "mcp.test.runnerMissingNamed": "启动失败：找不到 {runner}",
    "mcp.test.status.needs-secret": "需要 API Key",
    "mcp.toast.enable": "已在 {clients} 启用 {servers}",
    "mcp.toast.partial": "已写入 {ok} 个，{failed} 个失败（{client}：{reason}）",
    "mcp.toast.failedAll": "无法写入 {client} 的配置：{reason}",
    "mcp.err.config-jsonc": "{client} 的配置文件里有注释，SkillHub 只读不写。",
    "mcp.history.add": "给 {clients} 添加 {servers}",
    "mcp.history.partial": "（{clients} 未成功）",
    "mcp.word.aiTool": "AI 工具"
  };
  let text = table[key] ?? key;
  for (const [name, value] of Object.entries(vars)) text = text.split(`{${name}}`).join(String(value));
  return text;
};

const row = (name, extra = {}) => ({
  id: `id-${name}`, name, displayName: name, transport: "stdio",
  target: { runner: "npx", subject: `@scope/${name}-mcp`, extraArgCount: 0, host: null },
  cells: [], projectBindings: [], secrets: [], missingSecretCount: 0, test: null,
  source: { kind: "manual" }, specRevision: 1, issueCount: 0, updatedAt: "", ...extra
});

test("names, URLs and commands follow the contract rules", () => {
  assert.equal(validateServerName("context7"), null);
  assert.equal(validateServerName("team.docs"), "pattern");
  assert.equal(validateServerName("-x"), "pattern");
  assert.equal(validateServerName("workspace"), "reserved");
  assert.equal(validateServerName("Memory", ["memory"]), "taken");
  assert.equal(sanitizeServerName("@upstash/Context 7"), "context-7");
  assert.equal(validateRemoteUrl("https://api.githubcopilot.com/mcp/"), null);
  assert.equal(validateRemoteUrl("https://x.dev/mcp?key=1"), "query");
  assert.equal(validateRemoteUrl("https://user:pw@x.dev/"), "credentials");
  assert.equal(validateRemoteUrl("ftp://x.dev"), "scheme");
  assert.equal(isRemoteTarget(" https://x.dev"), true);
  assert.deepEqual(splitCommandLine('npx -y "@scope/pkg name"'), { command: "npx", args: ["-y", "@scope/pkg name"] });
  assert.deepEqual(normalizeCommand("cmd", ["/c", "npx", "-y", "pkg"]), { kind: "ok", command: "npx", args: ["-y", "pkg"], unwrapped: true });
  assert.equal(normalizeCommand("cmd", ["/k", "npx"]).kind, "shell");
  assert.equal(normalizeCommand("powershell.exe", ["-c", "x"]).kind, "shell");
  // Bug MCP#8: --x=y and task-master-ai stay valid; real credentials are caught.
  assert.equal(argsContainCredential(["--port=3000", "task-master-ai"]), false);
  assert.equal(argsContainCredential(["--api-key", "abc123"]), true);
  assert.equal(argsContainCredential(["ghp_abcdefghijklmnopqrstu"]), true);
  assert.equal(validateEnvName("GITHUB_PERSONAL_ACCESS_TOKEN"), null);
  assert.equal(validateEnvName("PATH"), "reserved");
  assert.equal(validateEnvName("AI_SKILLHUB_X"), "reserved");
  assert.equal(validateEnvName("1X"), "pattern");
});

test("search matches only name, display name, runner, subject and host", () => {
  const rows = [row("context7"), row("github", { transport: "http", target: { runner: null, subject: null, extraArgCount: 0, host: "api.githubcopilot.com" }, secrets: [{ kind: "header", name: "Authorization", envVar: "SECRET_TOKEN_NAME" }] })];
  assert.deepEqual(filterServers(rows, "githubcopilot").map(item => item.name), ["github"]);
  assert.deepEqual(filterServers(rows, "SECRET_TOKEN").map(item => item.name), []);
  assert.equal(serverMatchesQuery(rows[0], "@scope"), true);
  assert.equal(targetLine(rows[1].target, t), "api.githubcopilot.com");
  assert.equal(targetLine({ runner: "npx", subject: "pkg", extraArgCount: 2, host: null }, t), "npx · pkg · +2 个参数");
});

test("column stats and one-click cell intents", () => {
  const cells = states => states.map((state, index) => ({ clientId: ["codex", "claude-code", "claude-desktop", "cursor"][index], state, presentInFile: state === "on", disabledInFile: false, outOfDate: false, windowsFixAvailable: false, projectCount: 0 }));
  const rows = [row("a", { cells: cells(["on", "off", "unsupported", "off"]) }), row("b", { cells: cells(["off", "on", "off", "error"]) })];
  assert.deepEqual(columnStats(rows, "codex"), { on: 1, total: 2, enableable: 1, enableableIds: ["id-b"], onIds: ["id-a"] });
  assert.equal(columnStats(rows, "claude-desktop").enableable, 1);
  assert.deepEqual(cellIntent(rows[0].cells[0]), { kind: "toggle", enabled: false });
  assert.deepEqual(cellIntent(rows[0].cells[1]), { kind: "toggle", enabled: true });
  assert.deepEqual(cellIntent(rows[1].cells[3]), { kind: "retry", enabled: true });
  assert.deepEqual(cellIntent({ ...rows[1].cells[3], presentInFile: true }), { kind: "retry", enabled: false });
  assert.deepEqual(cellIntent({ ...rows[0].cells[2] }), { kind: "none" });
  assert.deepEqual(cellIntent({ ...rows[0].cells[2], state: "blocked", reason: "needs-inline-consent" }), { kind: "consent" });
  assert.deepEqual(cellIntent({ ...rows[0].cells[2], state: "changed-outside" }), { kind: "resolve" });
  const desktop = { id: "claude-desktop", label: "Claude Desktop", detected: true, writable: true, transports: ["stdio"] };
  assert.deepEqual(clientAvailability(desktop, "http"), { clientId: "claude-desktop", available: false, reason: "transport" });
  assert.deepEqual(clientAvailability(desktop, "stdio", "team.docs"), { clientId: "claude-desktop", available: false, reason: "name" });
});

test("outcome toasts, errors and history read as plain language", () => {
  const done = {
    kind: "done", operationId: "op", undoToken: "op", generation: 2,
    summary: { kind: "enable", serverNames: ["context7"], clientIds: ["codex"], failedClientIds: [], envVarNames: [] },
    results: [{ clientId: "codex", scope: "user", serverIds: ["id"], status: "written", restartHint: true }]
  };
  assert.deepEqual(outcomeToast(done, t), { tone: "ok", text: "已在 Codex 启用 context7", failed: [], skipped: [], restartClients: ["codex"] });
  const partial = {
    ...done,
    summary: { ...done.summary, clientIds: ["codex", "cursor"], failedClientIds: ["cursor"] },
    results: [done.results[0], { clientId: "cursor", scope: "user", serverIds: ["id"], status: "failed", restartHint: false, error: { code: "config-jsonc", message: "x", clientId: "cursor" } }]
  };
  const toast = outcomeToast(partial, t);
  assert.equal(toast.tone, "warn");
  assert.equal(toast.text, "已写入 1 个，1 个失败（Cursor：Cursor 的配置文件里有注释，SkillHub 只读不写。）");
  assert.equal(errorText({ code: "engine", message: "写入后读回不一致" }, t), "写入后读回不一致");
  const entry = { operationId: "x", at: "2026-10-08T10:42:00Z", kind: "add", serverNames: ["context7"], clientIds: ["codex", "claude-code"], failedClientIds: ["claude-code"], envVarNames: [], partial: true, undoAvailable: true };
  assert.equal(historyLabel(entry, t), "给 Codex、Claude Code 添加 context7");
  assert.equal(historyPartialText(entry, t), "（Claude Code 未成功）");
  assert.equal(parseTimestamp("1759917720000000000").getUTCFullYear(), 2025);
  assert.equal(testText(null, t), "未测试");
  assert.equal(testText(null, t, 1), "需要 API Key");
  assert.equal(testText({ status: "ok", toolsCount: 12, testedAt: "", stale: false, messageCode: "ok" }, t), "可用 · 12 个工具");
  assert.equal(testText({ status: "runner-missing", testedAt: "", stale: false, messageCode: "runner-missing" }, t, 0, "uvx"), "启动失败：找不到 uvx");
  assert.deepEqual(sortIssues([{ id: "a", kind: "unimported", action: "import" }, { id: "b", kind: "write-failed", action: "retry" }]).map(item => item.id), ["b", "a"]);
  assert.deepEqual(rememberAck(["x@1", "y@1"], testAckKey("x", 1)), ["y@1", "x@1"]);
});

// ---------- review fixes (v33/mcp-frontend-reviewed) ----------

test("every dynamic i18n key the page builds exists in zh, en and ko", () => {
  const types = mcp["mcpTypes.ts"];
  const union = (name, end) => {
    const start = types.indexOf(`export type ${name}`);
    return [...types.slice(start, types.indexOf(end, start + 10)).matchAll(/"([a-z0-9_-]+)"/g)].map(match => match[1]);
  };
  const field = (typeName, fieldName) => {
    const start = types.indexOf(`export type ${typeName}`);
    const body = types.slice(start, types.indexOf("\n};", start));
    const line = body.split("\n").find(item => new RegExp(`\\b${fieldName}\\??:`).test(item)) ?? "";
    return [...line.replace(/\/\/.*$/, "").matchAll(/"([a-z0-9_-]+)"/g)].map(match => match[1]);
  };
  const families = {
    "mcp.err.": union("McpErrorCode", "export type McpError ="),
    "mcp.reason.": [...union("McpReadonlyReason", "export type McpClient ="), ...union("McpCellReason", "export type McpCell =")],
    "mcp.skip.": union("McpSkipReason", "export type McpCandidate"),
    "mcp.issue.": union("McpIssueKind", "export type McpIssue ="),
    "mcp.issue.action.": field("McpIssue", "action").concat(["retry", "open-file-location", "fill-secret", "review-change", "import", "resolve-stuck", "allow-inline", "resync"]),
    "mcp.test.phase.": field("McpTestProgressEvent", "phase"),
    "mcp.test.status.": union("McpTestStatus", "export type McpTestSummary"),
    "mcp.history.": union("McpOperationKind", "export type McpOperationSummary"),
    "mcp.toast.": union("McpOperationKind", "export type McpOperationSummary"),
    "mcp.format.": union("McpPasteFormat", "export type McpSkipReason"),
    "mcp.add.warn.": field("McpCandidate", "warnings"),
    "mcp.field.": field("McpConfirmationItem", "changedFields"),
    "mcp.action.": field("McpConfirmationItem", "action"),
    "mcp.import.status.": ["ok", "missing", "jsonc-readonly", "parse-failed", "too-large", "unreadable"],
    "mcp.history.unavailable.": field("McpHistoryEntry", "undoUnavailableReason"),
    "mcp.cell.": union("McpCellState", "export type McpCellReason"),
    "mcp.template.": union("McpTemplateId", "export type McpTemplate =")
  };
  const keys = union("McpConfirmationKind", "export type McpConfirmationItem").flatMap(kind => [`mcp.confirm.${kind}.title`, `mcp.confirm.${kind}.body`]);
  for (const reason of ["transport", "readonly", "not-installed", "name"]) keys.push(`mcp.add.unavailable.${reason}`, `mcp.add.unavailableShort.${reason}`, `mcp.add.partial.${reason}`);
  for (const scope of ["user", "project", "local"]) keys.push(`mcp.scope.${scope}Short`);
  for (const variant of ["", ".removed", ".added"]) {
    keys.push(`mcp.resolve.title${variant}`);
    for (const part of ["takeFile", "takeFileHint", "takeLibrary", "takeLibraryHint"]) keys.push(`mcp.resolve${variant}.${part}`);
  }
  for (const [prefix, values] of Object.entries(families)) {
    assert.ok(values.length > 0, `${prefix} enum is empty`);
    for (const value of new Set(values)) keys.push(prefix + value);
  }
  const zh = dictionary("zh");
  const en = dictionary("en");
  const ko = dictionary("ko");
  for (const key of keys) for (const [lang, map] of [["zh", zh], ["en", en], ["ko", ko]]) assert.ok(map.has(key), `${lang} misses ${key}`);
});

test("opening the page and its drawers only reads (I1): effects call read commands only", () => {
  // Commands that never start a process and never write a client file.
  const allowed = new Set(["snapshot", "importFromClients", "templates", "getServer", "history", "parsePaste", "onLibraryChanged", "onTestProgress"]);
  const helpers = { refresh: "McpPage.tsx", load: "McpEditDrawer.tsx", runParse: "McpAddSheet.tsx" };
  const helperCalls = name => {
    const source = code[helpers[name]];
    const start = source.search(new RegExp(`(?:const ${name} = useCallback\\(async|async function ${name}\\()`));
    assert.ok(start >= 0, `${name} not found`);
    return source.slice(start, source.indexOf("\n  }", start));
  };
  for (const [name, source] of Object.entries(code)) {
    for (const body of effectBodies(source)) {
      const reached = [body, ...Object.keys(helpers).filter(helper => new RegExp(`\\b${helper}\\(`).test(body)).map(helperCalls)].join("\n");
      for (const match of reached.matchAll(/mcpApi\.(\w+)\(/g)) assert.ok(allowed.has(match[1]), `${name}: an effect reaches mcpApi.${match[1]}`);
      assert.doesNotMatch(reached, /openConfigLocation|openExternalUrl|detect_mcp_recipe|install_mcp_recipe|verify_mcp_recipe|prepare_origin_bridge/, name);
    }
  }
  // The automatic import on first visit is the documented read-only one (SQLite only).
  assert.match(code["McpPage.tsx"], /mcpApi\.importFromClients\(\{ reason: "first-run" \}\)/);
});

test("the edit drawer keeps stored keys exactly: no secrets sent unless a key was added", () => {
  const drawer = code["McpEditDrawer.tsx"];
  // A kept key goes back with the variable that holds it, for env keys too ("GITHUB_TOKEN": "${GH_PAT}").
  assert.match(drawer, /const keepSecrets: McpSecretInput\[\] = detail\.secrets\.map\(secret => \(\{\s*kind: secret\.kind,\s*name: secret\.name,\s*envVar: secret\.envVar \?\? undefined,/);
  // "user_env" without a value means "keep where it is stored"; "inline" would re-ask for consent.
  assert.match(drawer, /headerTemplate: secret\.headerTemplate,\s*mode: "user_env",/);
  assert.match(drawer, /secrets: added\.length === 0\s*\? undefined/);
});

test("the add sheet asks before replacing and never sends an empty optional key", () => {
  const sheet = code["McpAddSheet.tsx"];
  // onConflict only from the user's 跳过/覆盖 choice; otherwise the backend asks (I6).
  assert.doesNotMatch(sheet, /input: manualInput\(\), onConflict/);
  assert.doesNotMatch(sheet, /exists === "new" \? "skip"/);
  assert.match(sheet, /candidates: \[addCandidate\(manualInput\(\)\)\]/);
  assert.match(sheet, /item\.candidate\.exists === "new" \? undefined : item\.choice\.onConflict/);
  // An optional key left empty is not turned into a dangling reference.
  assert.match(sheet, /activeSecrets\.filter\(row => row\.required \|\| row\.value\.trim\(\)\)/);
  // One invalid name would fail the whole batch in the backend, so every sent name is checked.
  assert.match(sheet, /const problem = validateServerName\(item\.choice\.name\);\s*const existing = item\.candidate\.exists !== "new";\s*if \(problem\) candidateProblems\.set/);
});

test("skipped clients are named in the toast, and the same confirmation is not asked twice", () => {
  const tr = (key, vars = {}) => {
    const table = {
      "mcp.list.sep": "、",
      "mcp.toast.add": "已添加 {servers} 到 {clients}",
      "mcp.toast.nothingWritten.add": "已把 {servers} 加进列表，但没有写入任何 AI 工具",
      "mcp.toast.skipKept": "{client} 里已有同名的不同配置，保持原样",
      "mcp.toast.skipSep": "：",
      "mcp.reason.needs-inline-consent": "{client} 不支持引用环境变量，需要你同意后才写入密钥",
      "mcp.reason.transport-unsupported": "{client} 不支持这种连接方式",
      "mcp.reason.config-unreadable": "读不到 {client} 的配置文件",
      "mcp.reason.codex-structured-env": "这一项用了 SkillHub 暂不支持的写法，保持只读",
      "mcp.err.backendDetail": "zh",
      "mcp.err.invalid-input": "填写的内容有误，请检查后再试。"
    };
    let text = table[key] ?? key;
    for (const [name, value] of Object.entries(vars)) text = text.split(`{${name}}`).join(String(value));
    return text;
  };
  const results = [
    { clientId: "codex", scope: "user", serverIds: ["s"], status: "written", restartHint: true },
    { clientId: "claude-desktop", scope: "user", serverIds: ["s"], status: "skipped", skippedReason: "needs-inline-consent", restartHint: false },
    { clientId: "cursor", scope: "user", serverIds: ["s"], status: "skipped", skippedReason: "transport-unsupported", restartHint: false },
    { clientId: "claude-code", scope: "user", serverIds: ["s"], status: "skipped", skippedReason: "codex-structured-env", restartHint: false }
  ];
  assert.deepEqual(skippedLines(results, tr).map(line => line.text), [
    "Claude Desktop 不支持引用环境变量，需要你同意后才写入密钥",
    "Claude Code：这一项用了 SkillHub 暂不支持的写法，保持只读"
  ]);
  const done = { kind: "done", operationId: "op", undoToken: "op", generation: 3, results, summary: { kind: "add", serverNames: ["notion"], clientIds: ["codex"], failedClientIds: [], envVarNames: [] } };
  const toast = outcomeToast(done, tr);
  assert.equal(toast.tone, "warn");
  assert.equal(toast.text, "已添加 notion 到 Codex");
  const onlySkipped = { ...done, results: [{ clientId: "codex", scope: "user", serverIds: ["s"], status: "skipped", skippedReason: "entry-added-outside", restartHint: false }], summary: { ...done.summary, clientIds: [] } };
  assert.equal(outcomeToast(onlySkipped, tr).text, "已把 notion 加进列表，但没有写入任何 AI 工具");
  assert.deepEqual(outcomeToast(onlySkipped, tr).skipped.map(line => line.text), ["Codex 里已有同名的不同配置，保持原样"]);
  // invalid-input keeps the backend's exact zh reason (e.g. which field) in the zh UI.
  assert.equal(errorText({ code: "invalid-input", message: "工作目录需要是完整的文件夹路径。" }, tr), "工作目录需要是完整的文件夹路径。");
  assert.equal(errorText({ code: "invalid-input", message: "工作目录需要是完整的文件夹路径。" }, (key, vars) => (key === "mcp.err.backendDetail" ? "en" : tr(key, vars))), "填写的内容有误，请检查后再试。");
  const confirmation = { kinds: ["remove-from-library"], confirmToken: "a", items: [], envVars: [{ name: "GH", exists: true, createdBySkillHub: true, action: "delete" }], undoable: true };
  assert.equal(sameConfirmation(confirmation, { ...confirmation, confirmToken: "b" }), true);
  assert.equal(sameConfirmation(confirmation, { ...confirmation, confirmToken: "b", envVars: [] }), false);
});

test("the preview mock follows the backend's add and token rules", () => {
  // Tokens bind the request; "skip" on a listed server writes nothing; a missing onConflict on a
  // listed server is name-taken; an unlisted name in a client file asks overwrite-different.
  assert.match(mcpPreview, /function tokenOk\(request: \{ confirmToken\?: string \}\) \{[\s\S]*?token\.endsWith\(`-\$\{requestDigest\(request\)\}`\)/);
  assert.match(mcpPreview, /if \(existing && !candidate\.onConflict\) throw mcpError\("name-taken"/);
  assert.match(mcpPreview, /if \(conflicts\.length > 0 && !tokenOk\(request\)\) return nextConfirm\(request, \["overwrite-different"\], conflicts\);/);
  assert.match(mcpPreview, /if \(existing && candidate\.onConflict === "skip"\) \{\s*for \(const clientId of request\.clientIds\) results\.push\(result\(clientId, \[existing\.id\], "skipped", \{ skippedReason: "entry-added-outside" \}\)\);/);
  // Omitted secrets on update keep the stored keys.
  assert.match(mcpPreview, /if \(request\.input\.secrets === undefined\) \{/);
});

test("an unquoted Windows program path with spaces stays one command", () => {
  assert.deepEqual(splitCommandLine("C:\\Program Files\\nodejs\\npx.cmd -y @scope/pkg"), { command: "C:\\Program Files\\nodejs\\npx.cmd", args: ["-y", "@scope/pkg"] });
  assert.deepEqual(splitCommandLine("D:/工具/My Python/python.exe -m origin_mcp"), { command: "D:/工具/My Python/python.exe", args: ["-m", "origin_mcp"] });
  assert.deepEqual(splitCommandLine('"C:\\Program Files\\nodejs\\node.exe" "C:\\My Servers\\server.js"'), { command: "C:\\Program Files\\nodejs\\node.exe", args: ["C:\\My Servers\\server.js"] });
  assert.deepEqual(splitCommandLine("C:\\tools\\uvx.exe mcp-server-fetch"), { command: "C:\\tools\\uvx.exe", args: ["mcp-server-fetch"] });
  assert.deepEqual(normalizeCommand("C:\\Windows\\System32\\cmd.exe", ["/C", "npx.cmd", "-y", "pkg"]), { kind: "ok", command: "npx.cmd", args: ["-y", "pkg"], unwrapped: true });
  assert.equal(normalizeCommand("cmd", ["/c", "powershell", "-c", "x"]).kind, "shell");
});
