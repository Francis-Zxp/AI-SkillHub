import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { getLang } from "./i18n";
import type { Lang } from "./i18n";
import { Icon } from "./icons";
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

type TargetOption = { hostId: "host-codex" | "host-claude-code"; scope: string; workspaceId?: string | null; pathDisplay: string };
type FieldDiff = { targetId: string; hostId: string; serverName: string; field: string; change: string; before: string; after: string };
type MutationPlan = { planId: string; targets: Array<{ id: string; hostId: string; pathDisplay: string; existed: boolean }>; diffs: FieldDiff[] };

type Phase = "" | "detecting" | "installing" | "planning" | "applying" | "verifying" | "starting";

type Props = {
  runtimeAvailable: boolean;
  /** Called after a client configuration was written so the inventory rescans. */
  onConfigChanged: () => void;
};

export function McpRecipeCard({ runtimeAvailable, onConfigChanged }: Props) {
  const [status, setStatus] = useState<RecipeStatus | null>(null);
  const [phase, setPhase] = useState<Phase>("");
  const [error, setError] = useState("");
  const [showDetails, setShowDetails] = useState(false);
  const [targets, setTargets] = useState<TargetOption[]>([]);
  const [hosts, setHosts] = useState<Set<string>>(new Set());
  const [plan, setPlan] = useState<MutationPlan | null>(null);
  const [copied, setCopied] = useState(-1);

  async function detect(clearError = true) {
    if (!runtimeAvailable) return;
    setPhase("detecting");
    if (clearError) setError("");
    try {
      const [next, options] = await Promise.all([
        invoke<RecipeStatus>("detect_mcp_recipe"),
        invoke<TargetOption[]>("list_mcp_mutation_targets")
      ]);
      const userTargets = options.filter(option => option.scope === "user" && !option.workspaceId);
      setTargets(userTargets);
      setHosts(current => current.size > 0 ? current : new Set(userTargets.map(option => option.hostId)));
      setStatus(next);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setPhase("");
    }
  }

  useEffect(() => {
    void detect();
    // Detection is explicit afterwards.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtimeAvailable]);

  async function planConnection(current: RecipeStatus) {
    const chosen = targets.filter(option => hosts.has(option.hostId));
    if (chosen.length === 0) {
      setError(rt("chooseHost"));
      return;
    }
    setPhase("planning");
    try {
      const next = await invoke<MutationPlan>("plan_mcp_changes", {
        request: {
          changes: chosen.map(option => ({
            hostId: option.hostId,
            scope: "user",
            action: "upsert",
            serverName: "origin",
            draft: {
              transport: "stdio",
              command: current.runtimePython,
              args: ["-m", "origin_mcp"],
              envVars: [],
              headerEnv: [],
              enabled: true,
              required: false
            }
          }))
        }
      });
      setPlan(next);
    } catch (reason) {
      setError(String(reason));
    } finally {
      setPhase("");
    }
  }

  async function installAndConnect() {
    setError("");
    setPhase("installing");
    try {
      const installed = await invoke<RecipeStatus>("install_mcp_recipe");
      setStatus(installed);
      setPhase("");
      if (installed.clients.every(client => !client.matchesRuntime)) await planConnection(installed);
      else await verify();
    } catch (reason) {
      setError(String(reason));
      setPhase("");
      await detect(false);
    }
  }

  async function applyPlan() {
    if (!plan) return;
    setPhase("applying");
    setError("");
    try {
      await invoke("apply_mcp_plan", { planId: plan.planId });
      setPlan(null);
      onConfigChanged();
      setPhase("");
      await verify();
    } catch (reason) {
      setError(String(reason));
      setPlan(null);
      setPhase("");
    }
  }

  async function verify() {
    setPhase("verifying");
    setError("");
    try {
      setStatus(await invoke<RecipeStatus>("verify_mcp_recipe"));
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
      setStatus(await invoke<RecipeStatus>("prepare_origin_bridge"));
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

  if (!runtimeAvailable) return null;
  const busy = phase !== "";
  const state = status?.state ?? (error ? "error" : "");
  const next = status?.nextStep ?? "";
  const primary = (() => {
    if (!status) return { label: rt("recheck"), run: detect };
    if (next === "install") return { label: rt("installAndConnect"), run: installAndConnect };
    if (next === "connect") return { label: rt("connect"), run: () => planConnection(status) };
    if (next === "register-app") return { label: rt("registerAndStart"), run: prepareBridge };
    if (next === "start-bridge") return { label: rt("startBridge"), run: prepareBridge };
    if (["verify", "open-origin"].includes(next)) return { label: rt("verify"), run: verify };
    if (state === "ready") return { label: rt("verifyAgain"), run: verify };
    return { label: rt("recheck"), run: detect };
  })();

  return (
    <section className={`recipe-card state-${state || "unknown"}`} aria-label={rt("title")}>
      <header className="recipe-head">
        <div className="recipe-title">
          <span className="recipe-mark" aria-hidden="true"><Icon name="connections" /></span>
          <div>
            <h3>{rt("title")}</h3>
            <p>{rt("subtitle", { version: status?.packageVersion ?? "" })}</p>
          </div>
        </div>
        <span className={`recipe-state state-${state || "unknown"}`}>
          <i aria-hidden="true" />
          {next === "register-app" ? rt("state.needs-registration") : next === "start-bridge" ? rt("state.needs-bridge") : state ? rt(`state.${state}`) : rt("checking")}
        </span>
      </header>

      {status && (
        <p className="recipe-next">
          <strong>{rt("nextLabel")}</strong> {rt(`next.${next}`)}
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

      {plan && (
        <div className="recipe-plan" role="alertdialog" aria-label={rt("planTitle")}>
          <strong>{rt("planTitle")}</strong>
          <ul>
            {plan.targets.map(target => (
              <li key={target.id}>
                <span>{hostName(target.hostId)}</span>
                <code>{target.pathDisplay}</code>
                <small>{target.existed ? rt("planMerge") : rt("planCreate")}</small>
              </li>
            ))}
          </ul>
          <p className="recipe-muted">{rt("planSafety")}</p>
          <div className="recipe-actions">
            <button className="ghost-action" disabled={busy} onClick={() => setPlan(null)} type="button">{rt("cancel")}</button>
            <button className="primary-action" disabled={busy} onClick={() => void applyPlan()} type="button">{rt("applyPlan")}</button>
          </div>
        </div>
      )}

      {(error || status?.failure) && <p className="recipe-error" role="alert">{error || status?.failure}</p>}

      {!plan && primary && (
        <div className="recipe-actions">
          {(next === "install" || next === "connect") && targets.length > 0 && (
            <fieldset className="recipe-hosts">
              <legend>{rt("writeTo")}</legend>
              {targets.map(option => (
                <label key={option.hostId}>
                  <input
                    checked={hosts.has(option.hostId)}
                    disabled={busy}
                    onChange={event => {
                      const nextHosts = new Set(hosts);
                      if (event.target.checked) nextHosts.add(option.hostId); else nextHosts.delete(option.hostId);
                      setHosts(nextHosts);
                    }}
                    type="checkbox"
                  />
                  {hostName(option.hostId)}
                </label>
              ))}
            </fieldset>
          )}
          <button className="primary-action" disabled={busy} onClick={() => void primary.run()} type="button">
            {busy ? <Icon className="icon-spin" name="refresh" /> : null}
            {busy ? rt(`phase.${phase}`) : primary.label}
          </button>
          {primary.label !== rt("recheck") && (
            <button className="ghost-action" disabled={busy} onClick={() => void detect()} type="button">{rt("recheck")}</button>
          )}
        </div>
      )}

      {status && (
        <div className="recipe-details">
          <button aria-expanded={showDetails} className="text-action" onClick={() => setShowDetails(value => !value)} type="button">
            <Icon className={showDetails ? "chevron-open" : ""} name="chevron" /> {showDetails ? rt("hideDetails") : rt("showDetails")}
          </button>
          {showDetails && (
            <ol className="recipe-steps">
              {status.steps.map(item => (
                <li className={`step-${item.status}`} key={item.id}>
                  <span className="recipe-step-dot" aria-hidden="true" />
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
    </section>
  );
}

function hostName(hostId: string) {
  return hostId === "host-codex" ? "Codex" : hostId === "host-claude-code" ? "Claude Code" : hostId;
}

type Dictionary = Record<string, string>;

const zh: Dictionary = {
  title: "Origin 绘图（origin-mcp）",
  "guide.title": "查看首次注册步骤",
  "check.ok": "通过",
  "check.pending": "待检测",
  "check.failed": "失败",
  "check.user": "待操作",
  copyFailed: "未能复制，请选中命令手动复制。",
  subtitle: "让 AI 工具操作本机 Origin/OriginPro · 安装目标 {version}",
  checking: "检测中",
  "state.not-installed": "待安装",
  "state.needs-origin": "待启动 Origin",
  "state.needs-registration": "待注册 App",
  "state.needs-bridge": "待启动 Bridge",
  "state.needs-connection": "待连接",
  "state.ready": "可用",
  "state.error": "异常",
  nextLabel: "下一步：",
  "next.install-origin": "安装并激活 Origin/OriginPro 2026，然后点“重新检测”。",
  "next.install-python": "安装 Python 3.10–3.14（不会改动现有环境），然后点“重新检测”。",
  "next.install": "安装独立运行环境，并写入所选 AI 工具。",
  "next.connect": "把 Origin 服务器写入所选 AI 工具。",
  "next.open-origin": "打开 Origin 后点“重新检测”，即可在这里注册并启动桥接。",
  "next.register-app": "Origin 已打开。点击“注册并启动”，首次安装时确认 Origin 弹窗即可。",
  "next.start-bridge": "App 已注册。点击“启动并验证”，连接当前 Origin 会话。",
  "next.verify": "进行连接验证（握手、工具列表、桥接和一次只读调用）。",
  "next.none": "已就绪。重启或重新连接 AI 工具后即可使用。",
  registerAndStart: "注册并启动",
  startBridge: "启动并验证",
  startingHint: "请留意 Origin 的安装提示。若提示同版本文件已存在，可选“全部跳过”；完成后将自动验证连接。",
  "phase.starting": "正在连接 Origin…",
  installAndConnect: "安装并连接",
  connect: "连接到 AI 工具",
  verify: "验证连接",
  verifyAgain: "再次验证",
  recheck: "重新检测",
  lastVerified: "上次验证 {time}",
  writeTo: "写入",
  chooseHost: "请至少选择一个 AI 工具。",
  planTitle: "将写入以下配置",
  planMerge: "合并到现有文件，保留其他 MCP",
  planCreate: "新建文件",
  planSafety: "只添加名为 origin 的条目；写入前自动备份，可在下方快照中回滚。",
  applyPlan: "确认写入并验证",
  cancel: "取消",
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
  "phase.planning": "正在生成配置预览…",
  "phase.applying": "正在写入…",
  "phase.verifying": "正在验证…"
};

const en: Dictionary = {
  title: "Origin plotting (origin-mcp)",
  "guide.title": "Show first-time registration steps",
  "check.ok": "Passed",
  "check.pending": "Pending",
  "check.failed": "Failed",
  "check.user": "Action needed",
  copyFailed: "Could not copy. Select the command and copy it manually.",
  subtitle: "Lets AI tools drive Origin/OriginPro on this PC · target version {version}",
  checking: "Checking",
  "state.not-installed": "Not installed",
  "state.needs-origin": "Start Origin",
  "state.needs-registration": "Register Apps",
  "state.needs-bridge": "Start Bridge",
  "state.needs-connection": "Not connected",
  "state.ready": "Ready",
  "state.error": "Problem",
  nextLabel: "Next:",
  "next.install-origin": "Install and activate Origin/OriginPro 2026, then click “Check again”.",
  "next.install-python": "Install Python 3.10–3.14 (existing environments stay untouched), then click “Check again”.",
  "next.install": "Install the isolated runtime and add it to the selected AI tools.",
  "next.connect": "Add the Origin server to the selected AI tools.",
  "next.open-origin": "Open Origin and check again to register and start the bridge here.",
  "next.register-app": "Origin is open. Register and start the bridge; confirm the native installation prompt if shown.",
  "next.start-bridge": "The Apps are registered. Start and verify the bridge in the current Origin session.",
  "next.verify": "Verify the connection (handshake, tool list, bridge and one read-only call).",
  "next.none": "Ready. Restart or reconnect your AI tool to use it.",
  registerAndStart: "Register and start",
  startBridge: "Start and verify",
  startingHint: "Check Origin for an installation prompt. Choose Skip All for the existing same-version files. Connection verification follows automatically.",
  "phase.starting": "Connecting to Origin…",
  installAndConnect: "Install and connect",
  connect: "Connect to AI tools",
  verify: "Verify",
  verifyAgain: "Verify again",
  recheck: "Check again",
  lastVerified: "Last verified {time}",
  writeTo: "Write to",
  chooseHost: "Choose at least one AI tool.",
  planTitle: "These configurations will be written",
  planMerge: "Merged into the existing file; other MCP servers kept",
  planCreate: "New file",
  planSafety: "Only an entry named origin is added. A backup is taken first and can be rolled back from the snapshots below.",
  applyPlan: "Write and verify",
  cancel: "Cancel",
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
  "phase.planning": "Preparing the preview…",
  "phase.applying": "Writing…",
  "phase.verifying": "Verifying…"
};

const ko: Dictionary = {
  title: "Origin 그래프 (origin-mcp)",
  "guide.title": "최초 등록 단계 보기",
  "check.ok": "통과",
  "check.pending": "확인 대기",
  "check.failed": "실패",
  "check.user": "조치 필요",
  copyFailed: "복사하지 못했습니다. 명령을 선택하여 직접 복사하세요.",
  subtitle: "AI 도구가 이 PC의 Origin/OriginPro를 조작 · 설치 대상 버전 {version}",
  checking: "확인 중",
  "state.not-installed": "설치 필요",
  "state.needs-origin": "Origin 시작 필요",
  "state.needs-registration": "앱 등록 필요",
  "state.needs-bridge": "Bridge 시작 필요",
  "state.needs-connection": "연결 필요",
  "state.ready": "사용 가능",
  "state.error": "문제",
  nextLabel: "다음:",
  "next.install-origin": "Origin/OriginPro 2026을 설치하고 활성화한 뒤 “다시 확인”을 누르세요.",
  "next.install-python": "Python 3.10–3.14를 설치하세요(기존 환경은 그대로). 그런 다음 “다시 확인”을 누르세요.",
  "next.install": "독립 실행 환경을 설치하고 선택한 AI 도구에 추가합니다.",
  "next.connect": "선택한 AI 도구에 Origin 서버를 추가합니다.",
  "next.open-origin": "Origin을 열고 다시 확인하면 여기에서 브리지를 등록하고 시작할 수 있습니다.",
  "next.register-app": "Origin이 열려 있습니다. 등록하고 시작을 누르고 설치 창이 나타나면 확인하세요.",
  "next.start-bridge": "앱이 등록되어 있습니다. 현재 Origin 세션에서 브리지를 시작하고 확인하세요.",
  "next.verify": "연결을 확인합니다(핸드셰이크, 도구 목록, 브리지, 읽기 전용 호출 1회).",
  "next.none": "준비되었습니다. AI 도구를 다시 시작하거나 다시 연결하세요.",
  registerAndStart: "등록하고 시작",
  startBridge: "시작하고 확인",
  startingHint: "Origin의 설치 창을 확인하세요. 동일 버전 파일이 이미 있으면 모두 건너뛰기를 선택하세요. 이후 연결을 자동으로 확인합니다.",
  "phase.starting": "Origin 연결 중…",
  installAndConnect: "설치하고 연결",
  connect: "AI 도구에 연결",
  verify: "연결 확인",
  verifyAgain: "다시 확인",
  recheck: "다시 확인",
  lastVerified: "마지막 확인 {time}",
  writeTo: "쓰기 대상",
  chooseHost: "AI 도구를 하나 이상 선택하세요.",
  planTitle: "다음 설정을 씁니다",
  planMerge: "기존 파일에 병합하며 다른 MCP는 유지",
  planCreate: "새 파일",
  planSafety: "origin 항목만 추가합니다. 먼저 백업하며 아래 스냅샷에서 되돌릴 수 있습니다.",
  applyPlan: "쓰고 확인",
  cancel: "취소",
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
  "phase.planning": "미리보기 준비 중…",
  "phase.applying": "쓰는 중…",
  "phase.verifying": "확인 중…"
};

const dictionaries: Record<Lang, Dictionary> = { zh, en, ko };

function rt(key: string, vars?: Record<string, string | number>) {
  let text = dictionaries[getLang()][key] ?? en[key] ?? key;
  for (const [name, value] of Object.entries(vars ?? {})) text = text.split(`{${name}}`).join(String(value));
  return text;
}
