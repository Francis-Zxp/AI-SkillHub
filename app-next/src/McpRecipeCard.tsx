// Origin one-click recipe, shown in MCP → 发现 → "已验证一键安装" (contract §6.8, M0-11).
// - Collapsed by default. Detection (which starts reg/tasklist/python) runs only after a click on
//   "检查这台电脑" or on expanding the card, never on mount (bug #23).
// - Writing to AI tools goes through the shared MCP library command (mcp_add_servers) and its
//   plain-language confirmation; the client list comes from the read-only snapshot (bug MCP#10).
// - Client chips stay visible after connecting, so origin can be added to a second tool (bug #24),
//   and their state is re-derived from the snapshot whenever the library changes (bug MCP#9).
import { invoke } from "@tauri-apps/api/core";
import { useMemo, useState } from "react";
import { getLang } from "./i18n";
import type { Lang } from "./i18n";
import { Icon } from "./icons";
import type { McpAddRequest, McpClientId, McpLibrarySnapshot } from "./mcp/mcpTypes";
import type { AddSubmitResult } from "./mcp/McpAddSheet";
import "./McpRecipeCard.css";

export type RecipeStep = { id: string; status: "ok" | "pending" | "failed" | "user" | string; detail: string };

export type RecipeStatus = {
  recipeId: string;
  packageVersion: string;
  state: "not-installed" | "needs-origin" | "needs-connection" | "ready" | "error" | string;
  nextStep: string;
  steps: RecipeStep[];
  origin?: { name: string; version: string; installDir: string; running: boolean } | null;
  basePython: string;
  basePythonVersion: string;
  runtimePython: string;
  installedVersion: string;
  appStaged: boolean;
  appRegistered: boolean;
  mkopxCommands: string[];
  clients: Array<{ hostId: string; configured: boolean; matchesRuntime: boolean }>;
  verification?: {
    verifiedAt: string;
    toolCount: number;
    bridgeState: string;
    originPingOk: boolean;
    failure: string;
    serverVersion: string;
  } | null;
  verificationStale: boolean;
  failure: string;
};

type Phase = "" | "detecting" | "installing" | "applying" | "verifying" | "starting";

type Props = {
  runtimeAvailable: boolean;
  snapshot: McpLibrarySnapshot | null;
  /** Adds origin to the chosen AI tools through the MCP library (shared confirmation and toasts). */
  onAdd: (request: McpAddRequest) => Promise<AddSubmitResult>;
};

async function recipeCommand(command: "detect_mcp_recipe" | "install_mcp_recipe" | "verify_mcp_recipe" | "prepare_origin_bridge", runtimeAvailable: boolean): Promise<RecipeStatus> {
  if (!runtimeAvailable) {
    const { previewMcpRecipeStatus } = await import("./preview");
    return (await previewMcpRecipeStatus()) as RecipeStatus;
  }
  return invoke<RecipeStatus>(command);
}

export function McpRecipeCard({ runtimeAvailable, snapshot, onAdd }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [status, setStatus] = useState<RecipeStatus | null>(null);
  const [phase, setPhase] = useState<Phase>("");
  const [error, setError] = useState("");
  const [showDetails, setShowDetails] = useState(false);
  const [chosen, setChosen] = useState<McpClientId[] | null>(null);
  const [copied, setCopied] = useState(-1);

  // Stdio-capable, writable AI tools from the snapshot; their origin state comes from the library row.
  const originRow = snapshot?.servers.find(row => row.name.toLowerCase() === "origin") ?? null;
  const clientOptions = useMemo(() => (snapshot?.clients ?? [])
    .filter(client => client.detected && client.writable && client.transports.includes("stdio"))
    .map(client => {
      const cell = originRow?.cells.find(item => item.clientId === client.id);
      return { id: client.id, label: client.label, connected: cell?.state === "on", changed: cell?.state === "changed-outside" };
    }), [snapshot, originRow]);
  const notConnected = clientOptions.filter(option => !option.connected).map(option => option.id);
  const selected = (chosen ?? notConnected).filter(id => notConnected.includes(id));
  const connectedLabels = clientOptions.filter(option => option.connected).map(option => option.label);

  async function detect(clearError = true) {
    setPhase("detecting");
    if (clearError) setError("");
    try {
      setStatus(await recipeCommand("detect_mcp_recipe", runtimeAvailable));
    } catch (reason) {
      setError(String(reason));
    } finally {
      setPhase("");
    }
  }

  async function connect(current: RecipeStatus) {
    if (selected.length === 0) {
      setError(rt("chooseHost"));
      return;
    }
    setPhase("applying");
    setError("");
    try {
      const outcome = await onAdd({
        candidates: [{
          input: { name: "origin", transport: "stdio", command: current.runtimePython, args: ["-m", "origin_mcp"], source: { kind: "recipe", id: "origin-mcp" } },
          onConflict: "skip"
        }],
        clientIds: selected
      });
      setChosen(null);
      setPhase("");
      if (outcome.status === "done" && runtimeAvailable) await verify();
    } catch (reason) {
      setError(String(reason));
      setPhase("");
    }
  }

  async function installAndConnect() {
    setError("");
    setPhase("installing");
    try {
      const installed = await recipeCommand("install_mcp_recipe", runtimeAvailable);
      setStatus(installed);
      setPhase("");
      if (notConnected.length > 0 && selected.length > 0) await connect(installed);
      else await verify();
    } catch (reason) {
      setError(String(reason));
      setPhase("");
      await detect(false);
    }
  }

  async function verify() {
    setPhase("verifying");
    setError("");
    try {
      setStatus(await recipeCommand("verify_mcp_recipe", runtimeAvailable));
    } catch (reason) {
      setError(String(reason));
    } finally {
      setPhase("");
    }
  }

  async function prepareBridge() {
    setPhase("starting");
    setError("");
    try {
      setStatus(await recipeCommand("prepare_origin_bridge", runtimeAvailable));
    } catch (reason) {
      setError(String(reason));
      await detect(false);
    } finally {
      setPhase("");
    }
  }

  async function copy(text: string, index: number) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(index);
      window.setTimeout(() => setCopied(-1), 1600);
    } catch {
      setCopied(-1);
      setError(rt("copyFailed"));
    }
  }

  const busy = phase !== "";
  const state = status?.state ?? (error ? "error" : "");
  const next = status?.nextStep ?? "";
  const primary = (() => {
    if (!status) return { label: rt("check"), run: () => detect() };
    if (next === "install") return { label: rt("installAndConnect"), run: installAndConnect };
    if (next === "register-app") return { label: rt("registerAndStart"), run: prepareBridge };
    if (next === "start-bridge") return { label: rt("startBridge"), run: prepareBridge };
    if (["verify", "open-origin"].includes(next)) return { label: rt("verify"), run: verify };
    if (notConnected.length > 0 && status.runtimePython) {
      return { label: selected.length > 0 ? rt("connectN", { n: selected.length }) : rt("connect"), run: () => connect(status) };
    }
    if (state === "ready") return { label: rt("verifyAgain"), run: verify };
    return { label: rt("recheck"), run: () => detect() };
  })();

  const summary = connectedLabels.length > 0 ? rt("connectedTo", { clients: connectedLabels.join(rt("sep")) }) : rt("notConnected");

  return (
    <section aria-label={rt("title")} className={`recipe-card state-${state || "unknown"}${expanded ? " expanded" : " collapsed"}`}>
      <header className="recipe-head">
        <div className="recipe-title">
          <span aria-hidden="true" className="recipe-mark"><Icon name="connections" /></span>
          <div>
            <h3>{rt("title")}</h3>
            <p>{status ? rt("subtitle", { version: status.packageVersion }) : rt("subtitleShort")}</p>
          </div>
        </div>
        <span className={`recipe-state state-${state || "unknown"}`}>
          <i aria-hidden="true" />
          {status
            ? next === "register-app" ? rt("state.needs-registration") : next === "start-bridge" ? rt("state.needs-bridge") : rt(`state.${state}`)
            : summary}
        </span>
        <button
          aria-expanded={expanded}
          className="ghost-action small"
          onClick={() => {
            const opening = !expanded;
            setExpanded(opening);
            if (opening && !status && !busy) void detect();
          }}
          type="button"
        >
          <Icon className={expanded ? "chevron-open" : ""} name="chevron" /> {expanded ? rt("collapse") : rt("expand")}
        </button>
      </header>

      {!expanded && (
        <p className="recipe-next">
          {rt("collapsedHint")}
          <button className="text-action" disabled={busy} onClick={() => {
            setExpanded(true);
            void detect();
          }} type="button">{rt("check")}</button>
        </p>
      )}

      {expanded && (
        <>
          <p className="recipe-muted">{rt("prereq")}</p>
          {!runtimeAvailable && <p className="recipe-muted">{rt("previewNote")}</p>}

          {status && (
            <p className="recipe-next">
              <strong>{rt("nextLabel")}</strong> {notConnected.length > 0 && next === "none" ? rt("next.connect") : rt(`next.${next}`)}
              {status.verification?.verifiedAt && !status.verificationStale && (
                <span className="recipe-time">{rt("lastVerified", { time: status.verification.verifiedAt })}</span>
              )}
            </p>
          )}

          {phase === "starting" && <p className="recipe-next" role="status">{rt("startingHint")}</p>}

          {status && ["register-app", "open-origin", "start-bridge"].includes(next) && status.mkopxCommands.length > 0 && (
            <details className="recipe-guide-disclosure">
              <summary>{rt("guide.title")}</summary>
              <ol className="recipe-guide">
                <li>{rt("guide.open")}</li>
                <li>
                  {rt("guide.pack")}
                  {status.mkopxCommands.map((command, index) => (
                    <div className="recipe-command" key={command}>
                      <code>{command}</code>
                      <button className="ghost-action small" onClick={() => void copy(command, index)} type="button">
                        <Icon name="copy" /> {copied === index ? rt("copied") : rt("copy")}
                      </button>
                    </div>
                  ))}
                </li>
                <li>{rt("guide.drag")}</li>
                <li>{rt("guide.start")}</li>
              </ol>
            </details>
          )}

          {(error || status?.failure) && <p className="recipe-error" role="alert">{error || status?.failure}</p>}

          {status && clientOptions.length > 0 && (
            <fieldset className="recipe-hosts">
              <legend>{rt("writeTo")}</legend>
              {clientOptions.map(option => (
                <label className={option.connected ? "connected" : ""} key={option.id}>
                  <input
                    checked={option.connected || selected.includes(option.id)}
                    disabled={busy || option.connected}
                    onChange={event => {
                      const base = chosen ?? notConnected;
                      setChosen(event.target.checked ? [...base, option.id] : base.filter(id => id !== option.id));
                    }}
                    type="checkbox"
                  />
                  {option.label}
                  {option.connected && <em>{rt("alreadyIn")}</em>}
                  {option.changed && <em>{rt("changedOutside")}</em>}
                </label>
              ))}
            </fieldset>
          )}

          <div className="recipe-actions">
            <button className="primary-action" disabled={busy} onClick={() => void primary.run()} type="button">
              {busy ? <Icon className="icon-spin" name="refresh" /> : null}
              {busy ? rt(`phase.${phase}`) : primary.label}
            </button>
            {status && primary.label !== rt("recheck") && (
              <button className="ghost-action" disabled={busy} onClick={() => void detect()} type="button">{rt("recheck")}</button>
            )}
          </div>

          {status && (
            <div className="recipe-details">
              <button aria-expanded={showDetails} className="text-action" onClick={() => setShowDetails(value => !value)} type="button">
                <Icon className={showDetails ? "chevron-open" : ""} name="chevron" /> {showDetails ? rt("hideDetails") : rt("showDetails")}
              </button>
              {showDetails && (
                <ol className="recipe-steps">
                  {status.steps.map(item => (
                    <li className={`step-${item.status}`} key={item.id}>
                      <span aria-hidden="true" className="recipe-step-dot" />
                      <div>
                        <strong>{rt(`step.${item.id}`)} <em>{rt(`check.${item.status}`)}</em></strong>
                        <small>{item.detail}</small>
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}

type Dictionary = Record<string, string>;

const zh: Dictionary = {
  title: "Origin 绘图（origin-mcp）",
  subtitleShort: "让 AI 工具操作本机的 Origin/OriginPro",
  collapsedHint: "需要先在这台电脑上装好 Origin。检查只在你点按后进行。",
  check: "检查这台电脑",
  expand: "展开",
  collapse: "收起",
  prereq: "需要：Windows、已授权的 Origin/OriginPro（作者目前针对 2026/2026b）、Python 3.10–3.14。SkillHub 会把 origin-mcp 装进单独的运行环境，不改动你现有的 Python；首次使用还要在 Origin 里注册它的 Start/Stop 小程序，每次打开 Origin 后启动桥接。",
  previewNote: "浏览器预览：检查结果是示例，不会启动任何程序。",
  connectedTo: "已接入 {clients}",
  notConnected: "未接入",
  sep: "、",
  alreadyIn: "已接入",
  changedOutside: "在外部被改过",
  connectN: "接入 {n} 个 AI 工具",
  "guide.title": "查看首次注册步骤",
  "check.ok": "通过",
  "check.pending": "待检测",
  "check.failed": "失败",
  "check.user": "待操作",
  copyFailed: "未能复制，请选中命令手动复制。",
  subtitle: "让 AI 工具操作本机 Origin/OriginPro · 安装目标 {version}",
  "state.not-installed": "待安装",
  "state.needs-origin": "待启动 Origin",
  "state.needs-registration": "待注册 App",
  "state.needs-bridge": "待启动桥接",
  "state.needs-connection": "待接入",
  "state.ready": "可用",
  "state.error": "异常",
  nextLabel: "下一步：",
  "next.install-origin": "安装并激活 Origin/OriginPro 2026，然后点“重新检测”。",
  "next.install-python": "安装 Python 3.10–3.14（不会改动现有环境），然后点“重新检测”。",
  "next.install": "安装独立运行环境，并接入下面勾选的 AI 工具。",
  "next.connect": "把 origin 接入下面勾选的 AI 工具。",
  "next.open-origin": "打开 Origin 后点“重新检测”，即可在这里注册并启动桥接。",
  "next.register-app": "Origin 已打开。点击“注册并启动”，首次安装时确认 Origin 弹窗即可。",
  "next.start-bridge": "App 已注册。点击“启动并验证”，连接当前 Origin 会话。",
  "next.verify": "进行连接验证（握手、工具列表、桥接和一次只读调用）。",
  "next.none": "已就绪。重启或重新连接 AI 工具后即可使用。",
  "next.": "点“检查这台电脑”。",
  registerAndStart: "注册并启动",
  startBridge: "启动并验证",
  startingHint: "请留意 Origin 的安装提示。若提示同版本文件已存在，可选“全部跳过”；完成后将自动验证连接。",
  "phase.starting": "正在连接 Origin…",
  installAndConnect: "安装并接入",
  connect: "接入 AI 工具",
  verify: "验证连接",
  verifyAgain: "再次验证",
  recheck: "重新检测",
  lastVerified: "上次验证 {time}",
  writeTo: "接入到",
  chooseHost: "请至少选择一个 AI 工具。",
  copy: "复制",
  copied: "已复制",
  "guide.open": "打开 Origin，菜单 Window → Command Window。",
  "guide.pack": "依次粘贴并执行这两行：",
  "guide.drag": "把生成的两个 .opx 文件拖进 Origin 窗口完成注册。",
  "guide.start": "在 Apps 中点击 Origin MCP Bridge Start，再回到这里点“验证连接”。",
  showDetails: "查看检测详情",
  hideDetails: "收起详情",
  "step.origin": "Origin",
  "step.python": "Python",
  "step.runtime": "独立运行环境",
  "step.app": "Origin App",
  "step.client": "AI 工具配置",
  "step.handshake": "MCP 握手",
  "step.bridge": "Origin 桥接",
  "step.origin-call": "只读调用",
  "phase.detecting": "检测中…",
  "phase.installing": "正在下载并安装…",
  "phase.applying": "正在写入…",
  "phase.verifying": "正在验证…"
};

const en: Dictionary = {
  title: "Origin plotting (origin-mcp)",
  subtitleShort: "Lets AI tools drive Origin/OriginPro on this PC",
  collapsedHint: "Needs Origin installed on this PC. Nothing is checked until you click.",
  check: "Check this PC",
  expand: "Expand",
  collapse: "Collapse",
  prereq: "Needs Windows, licensed Origin/OriginPro (the author targets 2026/2026b) and Python 3.10–3.14. SkillHub installs origin-mcp into its own runtime and leaves your Python alone. The first time, register its Start/Stop Apps in Origin, and start the bridge each time Origin opens.",
  previewNote: "Browser preview: the check result is an example and nothing is started.",
  connectedTo: "Added to {clients}",
  notConnected: "Not added",
  sep: ", ",
  alreadyIn: "Added",
  changedOutside: "Changed outside",
  connectN: "Add to {n} AI tools",
  "guide.title": "Show first-time registration steps",
  "check.ok": "Passed",
  "check.pending": "Pending",
  "check.failed": "Failed",
  "check.user": "Action needed",
  copyFailed: "Could not copy. Select the command and copy it manually.",
  subtitle: "Lets AI tools drive Origin/OriginPro on this PC · target version {version}",
  "state.not-installed": "Not installed",
  "state.needs-origin": "Start Origin",
  "state.needs-registration": "Register Apps",
  "state.needs-bridge": "Start bridge",
  "state.needs-connection": "Not added",
  "state.ready": "Ready",
  "state.error": "Problem",
  nextLabel: "Next:",
  "next.install-origin": "Install and activate Origin/OriginPro 2026, then click “Check again”.",
  "next.install-python": "Install Python 3.10–3.14 (existing environments stay untouched), then click “Check again”.",
  "next.install": "Install the isolated runtime and add it to the AI tools ticked below.",
  "next.connect": "Add origin to the AI tools ticked below.",
  "next.open-origin": "Open Origin and check again to register and start the bridge here.",
  "next.register-app": "Origin is open. Register and start the bridge; confirm the native installation prompt if shown.",
  "next.start-bridge": "The Apps are registered. Start and verify the bridge in the current Origin session.",
  "next.verify": "Verify the connection (handshake, tool list, bridge and one read-only call).",
  "next.none": "Ready. Restart or reconnect your AI tool to use it.",
  "next.": "Click “Check this PC”.",
  registerAndStart: "Register and start",
  startBridge: "Start and verify",
  startingHint: "Check Origin for an installation prompt. Choose Skip All for the existing same-version files. Connection verification follows automatically.",
  "phase.starting": "Connecting to Origin…",
  installAndConnect: "Install and add",
  connect: "Add to AI tools",
  verify: "Verify",
  verifyAgain: "Verify again",
  recheck: "Check again",
  lastVerified: "Last verified {time}",
  writeTo: "Add to",
  chooseHost: "Choose at least one AI tool.",
  copy: "Copy",
  copied: "Copied",
  "guide.open": "Open Origin, then Window → Command Window.",
  "guide.pack": "Paste and run these two lines:",
  "guide.drag": "Drag the two generated .opx files into Origin to register them.",
  "guide.start": "Click Origin MCP Bridge Start in Apps, then come back and click “Verify”.",
  showDetails: "Show checks",
  hideDetails: "Hide checks",
  "step.origin": "Origin",
  "step.python": "Python",
  "step.runtime": "Isolated runtime",
  "step.app": "Origin App",
  "step.client": "AI tool config",
  "step.handshake": "MCP handshake",
  "step.bridge": "Origin bridge",
  "step.origin-call": "Read-only call",
  "phase.detecting": "Checking…",
  "phase.installing": "Downloading and installing…",
  "phase.applying": "Writing…",
  "phase.verifying": "Verifying…"
};

const ko: Dictionary = {
  title: "Origin 그래프 (origin-mcp)",
  subtitleShort: "AI 도구가 이 PC의 Origin/OriginPro를 조작",
  collapsedHint: "이 PC에 Origin이 설치되어 있어야 합니다. 누르기 전에는 아무것도 확인하지 않습니다.",
  check: "이 PC 확인",
  expand: "펼치기",
  collapse: "접기",
  prereq: "Windows, 정품 Origin/OriginPro(작성자 대상 2026/2026b), Python 3.10–3.14가 필요합니다. SkillHub는 origin-mcp를 별도 실행 환경에 설치하며 기존 Python은 건드리지 않습니다. 처음에는 Origin에 Start/Stop 앱을 등록하고, Origin을 열 때마다 브리지를 시작하세요.",
  previewNote: "브라우저 미리보기: 확인 결과는 예시이며 아무것도 실행하지 않습니다.",
  connectedTo: "{clients}에 추가됨",
  notConnected: "추가 안 됨",
  sep: ", ",
  alreadyIn: "추가됨",
  changedOutside: "외부에서 변경됨",
  connectN: "AI 도구 {n}개에 추가",
  "guide.title": "최초 등록 단계 보기",
  "check.ok": "통과",
  "check.pending": "확인 대기",
  "check.failed": "실패",
  "check.user": "조치 필요",
  copyFailed: "복사하지 못했습니다. 명령을 선택하여 직접 복사하세요.",
  subtitle: "AI 도구가 이 PC의 Origin/OriginPro를 조작 · 설치 대상 버전 {version}",
  "state.not-installed": "설치 필요",
  "state.needs-origin": "Origin 시작 필요",
  "state.needs-registration": "앱 등록 필요",
  "state.needs-bridge": "브리지 시작 필요",
  "state.needs-connection": "추가 필요",
  "state.ready": "사용 가능",
  "state.error": "문제",
  nextLabel: "다음:",
  "next.install-origin": "Origin/OriginPro 2026을 설치하고 활성화한 뒤 “다시 확인”을 누르세요.",
  "next.install-python": "Python 3.10–3.14를 설치하세요(기존 환경은 그대로). 그런 다음 “다시 확인”을 누르세요.",
  "next.install": "독립 실행 환경을 설치하고 아래에서 선택한 AI 도구에 추가합니다.",
  "next.connect": "아래에서 선택한 AI 도구에 origin을 추가합니다.",
  "next.open-origin": "Origin을 열고 다시 확인하면 여기에서 브리지를 등록하고 시작할 수 있습니다.",
  "next.register-app": "Origin이 열려 있습니다. 등록하고 시작을 누르고 설치 창이 나타나면 확인하세요.",
  "next.start-bridge": "앱이 등록되어 있습니다. 현재 Origin 세션에서 브리지를 시작하고 확인하세요.",
  "next.verify": "연결을 확인합니다(핸드셰이크, 도구 목록, 브리지, 읽기 전용 호출 1회).",
  "next.none": "준비되었습니다. AI 도구를 다시 시작하거나 다시 연결하세요.",
  "next.": "“이 PC 확인”을 누르세요.",
  registerAndStart: "등록하고 시작",
  startBridge: "시작하고 확인",
  startingHint: "Origin의 설치 창을 확인하세요. 동일 버전 파일이 이미 있으면 모두 건너뛰기를 선택하세요. 이후 연결을 자동으로 확인합니다.",
  "phase.starting": "Origin 연결 중…",
  installAndConnect: "설치하고 추가",
  connect: "AI 도구에 추가",
  verify: "연결 확인",
  verifyAgain: "다시 확인",
  recheck: "다시 확인",
  lastVerified: "마지막 확인 {time}",
  writeTo: "추가 대상",
  chooseHost: "AI 도구를 하나 이상 선택하세요.",
  copy: "복사",
  copied: "복사됨",
  "guide.open": "Origin을 열고 Window → Command Window를 선택하세요.",
  "guide.pack": "다음 두 줄을 붙여 넣어 실행하세요:",
  "guide.drag": "생성된 .opx 파일 두 개를 Origin 창으로 끌어 등록하세요.",
  "guide.start": "Apps에서 Origin MCP Bridge Start를 누른 뒤 여기로 돌아와 “연결 확인”을 누르세요.",
  showDetails: "확인 내역 보기",
  hideDetails: "접기",
  "step.origin": "Origin",
  "step.python": "Python",
  "step.runtime": "독립 실행 환경",
  "step.app": "Origin 앱",
  "step.client": "AI 도구 설정",
  "step.handshake": "MCP 핸드셰이크",
  "step.bridge": "Origin 브리지",
  "step.origin-call": "읽기 전용 호출",
  "phase.detecting": "확인 중…",
  "phase.installing": "다운로드 및 설치 중…",
  "phase.applying": "쓰는 중…",
  "phase.verifying": "확인 중…"
};

const dictionaries: Record<Lang, Dictionary> = { zh, en, ko };

function rt(key: string, vars?: Record<string, string | number>) {
  let text = dictionaries[getLang()][key] ?? en[key] ?? key;
  for (const [name, value] of Object.entries(vars ?? {})) text = text.split(`{${name}}`).join(String(value));
  return text;
}
