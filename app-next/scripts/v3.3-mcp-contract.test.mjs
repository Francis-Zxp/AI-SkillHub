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
  sanitizeServerName,
  serverMatchesQuery,
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
  assert.match(recipeCard, /onAdd\(\{\s*candidates: \[\{\s*input: \{ name: "origin", transport: "stdio", command: current\.runtimePython, args: \["-m", "origin_mcp"\], source: \{ kind: "recipe", id: "origin-mcp" \} \}/);
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
});

test("page rules: one write at a time, generation guard, no polling while hidden", () => {
  const page = code["McpPage.tsx"];
  assert.match(page, /function enqueue<T>\(job: \(\) => Promise<T>\): Promise<T> \{\s*const run = queue\.current\.then\(job, job\);/);
  assert.match(page, /if \(next\.generation < latestGeneration\.current\) return next;/);
  assert.match(page, /if \(document\.hidden\) \{\s*dirtyWhileHidden\.current = true;/);
  for (const [name, source] of Object.entries(code)) assert.doesNotMatch(source, /setInterval\(/, `${name} polls`);
  // busy → one automatic retry after 1 s (contract §3.5).
  assert.match(page, /if \(error\.code !== "busy"\) throw error;\s*await delay\(1000\);/);
  // Confirmations only come from the backend's needs-confirmation outcome.
  assert.match(page, /if \(outcome\.kind === "needs-confirmation"\) \{\s*const next = await askConfirm\(outcome\.confirmation\);/);
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
  assert.deepEqual(outcomeToast(done, t), { tone: "ok", text: "已在 Codex 启用 context7", failed: [], restartClients: ["codex"] });
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
