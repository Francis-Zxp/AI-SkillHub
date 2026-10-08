// Browser-preview mock of the v3.3 Skills backend (skills contract §5.3).
// Loaded only through preview.ts in `pnpm dev` without Tauri; nothing here touches disk.
// It keeps one in-memory library + delivery state and simulates the debounced queue
// (600 ms debounce, 3 s cap, 800 ms job, one follow-up batch) so every flow is testable.
import { buildLibraryRows, isCallableSkill, standaloneUnitId } from "./skillCounts";
import type {
  AdoptCandidate,
  AdoptPreview,
  AdoptReport,
  AgentDeliveryResult,
  AgentId,
  AgentSkillEntry,
  AgentSkillInventory,
  AgentStatusWord,
  DeliveryDepth,
  DeliveryJobStatus,
  DeliveryProblem,
  DeliveryUnit,
  InstallSkillSourceRequest,
  InstallSkillSourceResult,
  LegacySnapshot,
  OnboardingState,
  ParsedSkillSource,
  ProbeSkillGroup,
  ProbeSkillNode,
  SkillAgent,
  SkillCard,
  SkillDeliveryState,
  SkillHubError,
  SkillHubErrorCode,
  SkillSourceProbe,
  SkillTarget,
  SkillTargetStatus,
  SourceCard,
  TargetChange,
  TargetMutationResult
} from "./types";

const PREVIEW_DELIVERY_EVENT = "ai-skillhub-preview-delivery";
const PREVIEW_IMPORT_PROGRESS_EVENT = "ai-skillhub-preview-import-progress";
const HOME = "C:\\Users\\me";

type AgentSeed = {
  id: AgentId;
  name: string;
  vendor: string;
  installed: boolean;
  canDeliver: boolean;
  experimental: boolean;
  takeover: boolean;
  skillsPath: string;
  unsupportedReason?: string;
  linked?: AgentId[];
  sharedFolderNote?: string;
  afterSyncHint: string;
};

const AGENT_SEEDS: AgentSeed[] = [
  { id: "claude", name: "Claude Code", vendor: "Anthropic", installed: true, canDeliver: true, experimental: false, takeover: true, skillsPath: `${HOME}\\.claude\\skills`, afterSyncHint: "新开一个 Claude Code 会话后生效" },
  { id: "codex", name: "Codex", vendor: "OpenAI", installed: true, canDeliver: true, experimental: false, takeover: true, skillsPath: `${HOME}\\.agents\\skills`, linked: ["coze"], sharedFolderNote: "与 扣子 共用目录", afterSyncHint: "重启 Codex 后生效" },
  { id: "coze", name: "扣子", vendor: "ByteDance", installed: true, canDeliver: true, experimental: false, takeover: true, skillsPath: `${HOME}\\.agents\\skills`, linked: ["codex"], sharedFolderNote: "与 Codex 共用目录", afterSyncHint: "在扣子里重新扫描本机技能后生效" },
  { id: "workbuddy", name: "WorkBuddy", vendor: "Tencent", installed: true, canDeliver: true, experimental: false, takeover: true, skillsPath: `${HOME}\\.workbuddy\\skills`, afterSyncHint: "重新打开 WorkBuddy 的技能列表后生效" },
  { id: "antigravity", name: "Antigravity", vendor: "Google", installed: false, canDeliver: true, experimental: false, takeover: false, skillsPath: `${HOME}\\.gemini\\antigravity\\skills`, afterSyncHint: "" },
  { id: "cursor", name: "Cursor", vendor: "Anysphere", installed: true, canDeliver: true, experimental: true, takeover: false, skillsPath: `${HOME}\\.cursor\\skills`, afterSyncHint: "重启 Cursor 后生效" },
  { id: "gemini-cli", name: "Gemini CLI", vendor: "Google", installed: true, canDeliver: true, experimental: true, takeover: false, skillsPath: `${HOME}\\.gemini\\skills`, afterSyncHint: "新开一个 Gemini CLI 会话后生效" },
  { id: "opencode", name: "OpenCode", vendor: "SST", installed: true, canDeliver: false, experimental: false, takeover: false, skillsPath: "", unsupportedReason: "还不支持同步技能", afterSyncHint: "" },
  { id: "github-copilot", name: "GitHub Copilot", vendor: "GitHub", installed: false, canDeliver: false, experimental: false, takeover: false, skillsPath: "", unsupportedReason: "还不支持同步技能", afterSyncHint: "" }
];

type TargetRow = {
  desired: boolean;
  /** What is on "disk" in the simulated tool folder. */
  onDisk: "ours" | "none" | "conflict";
  error: SkillHubError | null;
  conflictSame: boolean;
  updatedAt: string;
  verifiedAt: string;
};

type QueueBatch = { depth: DeliveryDepth; reasons: Set<string>; first: number; last: number };

type PreviewEngine = {
  extraSources: SourceCard[];
  extraSkills: SkillCard[];
  childEnabled: Map<string, boolean>;
  libraryEnabled: Map<string, boolean>;
  reviewConfirmed: Set<string>;
  flagged: Set<string>;
  paused: boolean;
  onboarding: "pending" | "completed";
  takeover: Map<AgentId, boolean>;
  targets: Map<string, TargetRow>;
  touchedAgents: Set<AgentId>;
  lastResults: Map<AgentId, AgentDeliveryResult>;
  personal: Map<AgentId, number>;
  adopted: Set<string>;
  job: DeliveryJobStatus | null;
  nextJobId: number;
  pending: QueueBatch | null;
  running: boolean;
  timer: number | null;
  nextError: SkillHubErrorCode | null;
  probes: Map<string, SkillSourceProbe>;
};

type PreviewWindow = Window & { __skillhubPreview?: { jobs: DeliveryJobStatus[]; clientWrites: Array<{ agentId: string; unitId: string; action: string }> } };

let baseProvider: (() => LegacySnapshot) | null = null;
let engine: PreviewEngine | null = null;

function now() {
  return new Date().toISOString();
}

function key(unitId: string, agentId: string) {
  return `${unitId}\u0000${agentId}`;
}

function previewGlobals() {
  const target = window as PreviewWindow;
  target.__skillhubPreview ??= { jobs: [], clientWrites: [] };
  return target.__skillhubPreview;
}

function urlFlag(name: string): string | null {
  try {
    return new URLSearchParams(window.location.search).get(name);
  } catch {
    return null;
  }
}

function makeError(code: SkillHubErrorCode, message: string, extra: Partial<SkillHubError> = {}): SkillHubError {
  return { code, message, detail: "", action: null, agentId: null, sourceId: null, path: null, ...extra };
}

/** preview.ts registers the base fixture; the engine overlays installs and toggles on it. */
export function setPreviewBaseSnapshot(provider: () => LegacySnapshot) {
  baseProvider = provider;
}

function state(): PreviewEngine {
  if (engine) return engine;
  const takeover = new Map<AgentId, boolean>(AGENT_SEEDS.map(seed => [seed.id, seed.takeover]));
  engine = {
    extraSources: [FLAGGED_SOURCE, WRITING_KIT_SOURCE],
    extraSkills: [...FLAGGED_SKILLS, ...WRITING_KIT_SKILLS, STANDALONE_SKILL],
    childEnabled: new Map(),
    libraryEnabled: new Map([[FLAGGED_SOURCE.id, false]]),
    reviewConfirmed: new Set(),
    flagged: new Set([FLAGGED_SOURCE.id]),
    paused: false,
    onboarding: urlFlag("onboarding") === "1" ? "pending" : "completed",
    takeover,
    targets: new Map(),
    touchedAgents: new Set(),
    lastResults: new Map(),
    personal: new Map(),
    adopted: new Set(),
    job: null,
    nextJobId: 1,
    pending: null,
    running: false,
    timer: null,
    nextError: (urlFlag("previewError") as SkillHubErrorCode | null) || null,
    probes: new Map()
  };
  if (engine.onboarding === "pending") {
    for (const seed of AGENT_SEEDS) takeover.set(seed.id, false);
  } else {
    seedTargets(engine);
  }
  previewGlobals();
  return engine;
}

function seedTargets(current: PreviewEngine) {
  const stamp = now();
  const put = (unitId: string, agentId: AgentId, desired: boolean, onDisk: TargetRow["onDisk"], error: SkillHubError | null = null, conflictSame = false) => {
    current.targets.set(key(unitId, agentId), { desired, onDisk, error, conflictSame, updatedAt: stamp, verifiedAt: stamp });
  };
  const packs = ["source-nature-paper-skills", "source-impeccable", "source-vibesec", "source-gstack", "source-karpathy", WRITING_KIT_SOURCE.id, standaloneUnitId(STANDALONE_SKILL)];
  for (const unitId of packs) {
    put(unitId, "claude", unitId !== "source-gstack", unitId !== "source-gstack" ? "ours" : "none");
    const shared = unitId === "source-nature-paper-skills" || unitId === "source-impeccable";
    put(unitId, "codex", shared, shared ? "ours" : "none");
    put(unitId, "coze", shared, shared ? "ours" : "none");
    put(unitId, "workbuddy", unitId === "source-nature-paper-skills" || unitId === "source-impeccable", unitId === "source-nature-paper-skills" ? "ours" : "none",
      unitId === "source-impeccable"
        ? makeError("AGENT_DIR_EXTERNAL_LINK", "WorkBuddy 的技能文件夹指向了别的位置，SkillHub 没有写入。", {
            agentId: "workbuddy",
            path: `${HOME}\\.workbuddy\\skills`,
            action: { kind: "open-folder", payload: { agentId: "workbuddy" } }
          })
        : null);
  }
  // Antigravity is uninstalled but one of our entries is still on disk: orphan.
  put("source-nature-paper-skills", "antigravity", false, "ours");
  // A same-name personal folder in Claude: conflict, never overwritten.
  put("source-karpathy", "claude", true, "conflict", null, true);
}

/* ---------- fixture additions (contract §5.3) ---------- */

const FLAGGED_SOURCE: SourceCard = {
  id: "source-flagged-demo",
  name: "flagged-demo-skills",
  sourceType: "skill",
  health: "warn",
  url: "https://github.com/example/flagged-demo-skills.git",
  skillCount: 2,
  mode: "scan",
  categoryId: "agent-tools",
  note: "",
  localPath: "../app-next/data/github_sources/flagged-demo-skills",
  enabled: false,
  tags: ["GitHub"],
  createdAt: "2026-10-01T00:00:00Z"
};

const FLAGGED_SKILLS: SkillCard[] = ["shell-helper", "release-notes"].map(name => ({
  id: `preview-skill-${name}`,
  sourceId: FLAGGED_SOURCE.id,
  name,
  folderName: name,
  category: "agent-tools",
  description: name === "shell-helper" ? "帮你拼写常见的命令行。" : "根据提交记录整理发布说明。",
  note: "",
  source: FLAGGED_SOURCE.name,
  health: "warn",
  enabled: true,
  rating: 0,
  relativePath: `skills/${name}`,
  tags: []
}));

/** A second multi-skill pack, so several child switches can be exercised at once. */
const WRITING_KIT_SOURCE: SourceCard = {
  id: "source-writing-kit",
  name: "writing-kit",
  sourceType: "skill",
  health: "ok",
  url: "https://github.com/example/writing-kit.git",
  skillCount: 3,
  mode: "scan",
  categoryId: "academic-writing",
  note: "",
  localPath: "../app-next/data/github_sources/writing-kit",
  enabled: true,
  rating: 4,
  tags: ["GitHub"],
  createdAt: "2026-09-20T00:00:00Z"
};

const WRITING_KIT_SKILLS: SkillCard[] = [
  ["outline-builder", "把零散想法整理成文章提纲。"],
  ["tone-checker", "检查语气是否和读者匹配。"],
  ["citation-helper", "按目标期刊整理参考文献格式。"]
].map(([name, description]) => ({
  id: `preview-skill-${name}`,
  sourceId: WRITING_KIT_SOURCE.id,
  name,
  folderName: name,
  category: "academic-writing",
  description,
  note: "",
  source: WRITING_KIT_SOURCE.name,
  health: "ok",
  enabled: true,
  rating: 0,
  relativePath: `skills/${name}`,
  tags: ["写作"]
}));

const STANDALONE_SKILL: SkillCard = {
  id: "preview-skill-meeting-notes",
  sourceId: "",
  name: "meeting-notes",
  folderName: "meeting-notes",
  category: "document-tools",
  description: "把会议录音转写整理成要点、决定和待办。",
  note: "",
  source: "",
  health: "ok",
  enabled: true,
  rating: 3,
  relativePath: "skills/meeting-notes",
  tags: ["文档"]
};

/* ---------- snapshot overlay ---------- */

function libraryEnabledFor(current: PreviewEngine, source: SourceCard) {
  return current.libraryEnabled.get(source.id) ?? source.enabled;
}

export function overlayPreviewSnapshot(base: LegacySnapshot): LegacySnapshot {
  const current = state();
  // Idempotent: the preview UI may pass a snapshot that already carries the extras.
  const extraSourceIds = new Set(current.extraSources.map(source => source.id));
  const extraSkillIds = new Set(current.extraSkills.map(skill => skill.id));
  const sources = [...base.sources.filter(source => !extraSourceIds.has(source.id)), ...current.extraSources].map(source => ({
    ...source,
    enabled: libraryEnabledFor(current, source)
  }));
  const skills = [...base.skills.filter(skill => !extraSkillIds.has(skill.id)), ...current.extraSkills].map(skill => ({
    ...skill,
    enabled: current.childEnabled.get(skill.folderName) ?? skill.enabled
  }));
  const library = { ...base, sources, skills };
  const delivery = buildDeliveryState(library);
  return {
    ...library,
    summary: { ...base.summary, skills: skills.length, sources: sources.length },
    skillDelivery: delivery
  };
}

function currentLibrary(): LegacySnapshot {
  if (!baseProvider) throw new Error("preview base snapshot not registered");
  return overlayPreviewSnapshot(baseProvider());
}

function unitsFor(library: Pick<LegacySnapshot, "skills" | "sources" | "skillFolders">): DeliveryUnit[] {
  const current = state();
  const rows = buildLibraryRows({ skills: library.skills, sources: library.sources, skillFolders: library.skillFolders });
  const units: DeliveryUnit[] = [];
  for (const row of rows) {
    if (row.kind === "empty") continue;
    if (row.kind === "prompt" && row.source) {
      units.push({ unitId: row.source.id, kind: "source", sourceId: row.source.id, skillId: "", entryName: "", callableSkills: 0, libraryEnabled: false, libraryOnlyReason: "prompt-only" });
      continue;
    }
    const enabledChildren = row.skills.filter(skill => skill.enabled).length;
    if (row.source) {
      const flagged = current.flagged.has(row.source.id) && !current.reviewConfirmed.has(row.source.id);
      const enabled = row.source.enabled !== false;
      const reason = flagged ? "security-review" : !enabled ? "disabled-by-user" : enabledChildren === 0 ? "no-enabled-skills" : "";
      units.push({
        unitId: row.source.id,
        kind: "source",
        sourceId: row.source.id,
        skillId: "",
        entryName: row.skills.length === 1 ? row.skills[0].folderName : row.source.name.toLowerCase().replace(/[^a-z0-9-]+/g, "-"),
        callableSkills: row.skills.length,
        libraryEnabled: reason === "",
        libraryOnlyReason: reason
      });
    } else if (row.skill) {
      units.push({
        unitId: row.key,
        kind: "standalone",
        sourceId: "",
        skillId: row.skill.id ?? "",
        entryName: row.skill.folderName,
        callableSkills: 1,
        libraryEnabled: row.skill.enabled,
        libraryOnlyReason: row.skill.enabled ? "" : "no-enabled-skills"
      });
    }
  }
  return units;
}

function seedOf(agentId: string) {
  return AGENT_SEEDS.find(seed => seed.id === agentId);
}

function statusWord(seed: AgentSeed, takeover: boolean): AgentStatusWord {
  if (!seed.canDeliver) return seed.installed ? "unsupported" : "not-installed";
  if (!seed.installed) return "not-installed";
  return takeover ? "taken-over" : "available";
}

function readBack(current: PreviewEngine, unit: DeliveryUnit, seed: AgentSeed, row: TargetRow | undefined): SkillTargetStatus {
  const desired = row?.desired ?? false;
  const onDisk = row?.onDisk ?? "none";
  const takeover = current.takeover.get(seed.id) ?? false;
  const blocked = current.paused || current.onboarding === "pending";
  if (!unit.libraryEnabled && unit.libraryOnlyReason === "security-review") return "blocked";
  if (onDisk === "conflict") return "conflict";
  if (row?.error && desired) return "error";
  if (!seed.installed && onDisk === "ours") {
    return row && row.updatedAt > row.verifiedAt && (current.pending || current.running) ? "removing" : "orphan";
  }
  const wantOnDisk = desired && takeover && unit.libraryEnabled && seed.installed;
  const isOnDisk = onDisk === "ours";
  if (wantOnDisk === isOnDisk) {
    if (desired && !unit.libraryEnabled) return "blocked";
    return isOnDisk ? "synced" : "off";
  }
  if (blocked) return "paused";
  if (desired && !unit.libraryEnabled) return "blocked";
  if (current.pending || current.running) return wantOnDisk ? "pending" : "removing";
  return wantOnDisk ? "error" : "removing";
}

function buildTargets(current: PreviewEngine, units: DeliveryUnit[]): SkillTarget[] {
  const targets: SkillTarget[] = [];
  for (const unit of units) {
    if (unit.libraryOnlyReason === "prompt-only") continue;
    for (const seed of AGENT_SEEDS) {
      if (!seed.canDeliver) continue;
      const row = current.targets.get(key(unit.unitId, seed.id));
      const takeover = current.takeover.get(seed.id) ?? false;
      if (!takeover && row?.onDisk !== "ours") continue;
      const status = readBack(current, unit, seed, row);
      targets.push({
        unitId: unit.unitId,
        agentId: seed.id,
        desired: row?.desired ?? false,
        status,
        mode: row?.onDisk === "ours" ? (seed.id === "coze" || seed.id === "codex" ? "shared-real" : "link") : "none",
        entryName: unit.entryName,
        targetPath: seed.skillsPath ? `${seed.skillsPath}\\${unit.entryName}` : "",
        contentHash: row?.onDisk === "ours" ? "sha256:preview" : "",
        verifiedAt: row?.verifiedAt ?? "",
        updatedAt: row?.updatedAt ?? "",
        error: status === "error" ? row?.error ?? makeError("DELIVERY_VERIFY_FAILED", "写入后没有读回这个技能。", { agentId: seed.id }) : null,
        conflict: status === "conflict"
          ? { kind: "personal-folder", sameContent: Boolean(row?.conflictSame), path: `${seed.skillsPath}\\${unit.entryName}` }
          : null
      });
    }
  }
  return targets;
}

function buildDeliveryState(library: LegacySnapshot): SkillDeliveryState {
  const current = state();
  const units = unitsFor(library);
  const targets = buildTargets(current, units);
  const unitById = new Map(units.map(unit => [unit.unitId, unit]));
  const busy = current.pending !== null || current.running;
  const problems: DeliveryProblem[] = [];
  for (const target of targets) {
    if (target.status !== "error" && target.status !== "conflict" && target.status !== "orphan") continue;
    const seed = seedOf(target.agentId);
    const source = library.sources.find(item => item.id === target.unitId);
    const name = source?.name ?? target.entryName;
    problems.push({
      id: `${target.status}:${target.unitId}:${target.agentId}`,
      code: target.status === "error" ? target.error?.code ?? "DELIVERY_VERIFY_FAILED" : target.status === "conflict" ? "TARGET_CONFLICT" : "AGENT_NOT_INSTALLED",
      message: target.status === "error"
        ? `${name} 没能同步到 ${seed?.name ?? target.agentId}：${target.error?.message ?? ""}`
        : target.status === "conflict"
          ? `${seed?.name ?? target.agentId} 里已有同名的个人技能「${target.entryName}」，没有覆盖。`
          : `${seed?.name ?? target.agentId} 已不在这台电脑上，但 ${name} 的入口还在。`,
      agentId: target.agentId,
      unitId: target.unitId,
      action: target.status === "error"
        ? target.error?.action ?? { kind: "retry", payload: {} }
        : target.status === "conflict"
          ? { kind: "resolve-conflict", payload: { unitId: target.unitId, agentId: target.agentId } }
          // Same as the backend: a leftover entry of a missing tool carries no action; the UI offers 移除入口.
          : null
    });
  }
  const agents: SkillAgent[] = AGENT_SEEDS.map(seed => {
    const takeover = current.takeover.get(seed.id) ?? false;
    const mine = targets.filter(target => target.agentId === seed.id);
    const synced = mine.filter(target => target.status === "synced");
    const problemCount = mine.filter(target => target.status === "error" || target.status === "conflict" || target.status === "orphan").length;
    const doctor = library.agentDoctors?.find(item => item.adapterId === seed.id);
    return {
      id: seed.id,
      name: seed.name,
      vendor: seed.vendor,
      installed: seed.installed,
      canDeliver: seed.canDeliver,
      experimental: seed.experimental,
      experimentalReason: seed.experimental ? `SkillHub 能写入并读回，但还没在真实的 ${seed.name} 里确认能调用` : "",
      unsupportedReason: seed.unsupportedReason ?? "",
      takeover,
      statusWord: statusWord(seed, takeover),
      health: !takeover ? "off" : busy && mine.some(target => target.status === "pending" || target.status === "removing") ? "busy" : problemCount > 0 ? "problem" : "ok",
      skillsPath: seed.skillsPath,
      linkedAgentIds: seed.linked ?? [],
      sharedFolderNote: seed.sharedFolderNote ?? "",
      afterSyncHint: current.touchedAgents.has(seed.id) ? seed.afterSyncHint : "",
      counts: {
        packsSynced: synced.length,
        skillsSynced: synced.reduce((total, target) => total + (unitById.get(target.unitId)?.callableSkills ?? 0), 0),
        packsWanted: mine.filter(target => target.desired).length,
        problems: problemCount,
        personal: current.personal.get(seed.id) ?? null
      },
      lastResult: current.lastResults.get(seed.id) ?? null,
      doctorVerdict: doctor?.verdict ?? (seed.installed ? "ready" : "not-detected")
    };
  });
  const order: Record<AgentStatusWord, number> = { "taken-over": 0, available: 1, unsupported: 2, "not-installed": 3 };
  agents.sort((a, b) => order[a.statusWord] - order[b.statusWord]);
  return {
    paused: current.paused,
    onboarding: current.onboarding,
    agents,
    units,
    targets,
    problems,
    job: current.job,
    generatedAt: now()
  };
}

/* ---------- debounced queue simulator ---------- */

const DEPTH_RANK: Record<DeliveryDepth, number> = { verify: 0, links: 1, full: 2 };

function emit(status: DeliveryJobStatus) {
  window.dispatchEvent(new CustomEvent(PREVIEW_DELIVERY_EVENT, { detail: status }));
}

function jobStatus(id: number, phase: DeliveryJobStatus["phase"], batch: QueueBatch, extra: Partial<DeliveryJobStatus> = {}): DeliveryJobStatus {
  return {
    jobId: id,
    phase,
    depth: batch.depth,
    reasons: [...batch.reasons],
    queuedAt: new Date(batch.first).toISOString(),
    startedAt: "",
    finishedAt: "",
    waitingFor: "",
    agents: [],
    changedTargets: [],
    snapshotStale: false,
    error: null,
    ...extra
  };
}

function schedule() {
  const current = state();
  if (current.timer !== null) window.clearTimeout(current.timer);
  current.timer = null;
  if (!current.pending || current.running) return;
  const at = Math.min(current.pending.last + 600, current.pending.first + 3000);
  current.timer = window.setTimeout(startBatch, Math.max(0, at - Date.now()));
}

function request(depth: DeliveryDepth, reason: string): { jobId: number; coalesced: boolean } {
  const current = state();
  const time = Date.now();
  let coalesced = true;
  if (!current.pending) {
    current.pending = { depth, reasons: new Set([reason]), first: time, last: time };
    coalesced = false;
  } else {
    current.pending.reasons.add(reason);
    current.pending.last = time;
    if (DEPTH_RANK[depth] > DEPTH_RANK[current.pending.depth]) current.pending.depth = depth;
  }
  const jobId = current.nextJobId + (current.running ? 1 : 0);
  const queued = jobStatus(jobId, "queued", current.pending);
  current.job = current.running ? current.job : queued;
  emit(queued);
  schedule();
  return { jobId, coalesced };
}

function startBatch() {
  const current = state();
  current.timer = null;
  if (!current.pending || current.running) return;
  const batch = current.pending;
  current.pending = null;
  current.running = true;
  const jobId = current.nextJobId++;
  const running = jobStatus(jobId, "running", batch, { startedAt: now() });
  current.job = running;
  previewGlobals().jobs.push(running);
  emit(running);
  window.setTimeout(() => finishBatch(jobId, batch, running.startedAt), 800);
}

function finishBatch(jobId: number, batch: QueueBatch, startedAt: string) {
  const current = state();
  const blocked = current.paused || current.onboarding === "pending";
  const library = currentLibrary();
  const units = unitsFor(library);
  const changed: Array<{ unitId: string; agentId: AgentId }> = [];
  const perAgent = new Map<AgentId, AgentDeliveryResult>();
  const stamp = now();
  if (!blocked) {
    for (const unit of units) {
      if (unit.libraryOnlyReason === "prompt-only") continue;
      for (const seed of AGENT_SEEDS) {
        if (!seed.canDeliver) continue;
        const rowKey = key(unit.unitId, seed.id);
        const row = current.targets.get(rowKey);
        if (!row || row.onDisk === "conflict") continue;
        const takeover = current.takeover.get(seed.id) ?? false;
        const want = row.desired && takeover && unit.libraryEnabled && seed.installed && !row.error;
        const has = row.onDisk === "ours";
        const result = perAgent.get(seed.id) ?? { agentId: seed.id, outcome: "ok", linked: 0, removed: 0, unchanged: 0, conflicts: 0, errors: 0, error: null, finishedAt: stamp };
        if (want && !has) {
          row.onDisk = "ours";
          result.linked += 1;
          changed.push({ unitId: unit.unitId, agentId: seed.id });
          previewGlobals().clientWrites.push({ agentId: seed.id, unitId: unit.unitId, action: "link" });
        } else if (!want && has && (seed.installed || row.updatedAt > row.verifiedAt)) {
          // An entry left behind by an uninstalled tool (orphan) is only removed after the user asks.
          if (!takeover || !row.desired || !unit.libraryEnabled) {
            row.onDisk = "none";
            result.removed += 1;
            changed.push({ unitId: unit.unitId, agentId: seed.id });
            previewGlobals().clientWrites.push({ agentId: seed.id, unitId: unit.unitId, action: "remove" });
          }
        } else {
          result.unchanged += 1;
        }
        if (row.error && row.desired) result.errors += 1;
        row.verifiedAt = stamp;
        perAgent.set(seed.id, result);
      }
    }
    for (const result of perAgent.values()) {
      if (result.errors > 0) result.outcome = result.linked + result.removed > 0 ? "partial" : "failed";
      if (result.linked + result.removed > 0) current.touchedAgents.add(result.agentId);
      current.lastResults.set(result.agentId, result);
    }
  }
  current.running = false;
  const done = jobStatus(jobId, blocked ? "paused" : "done", batch, {
    startedAt,
    finishedAt: now(),
    agents: [...perAgent.values()],
    changedTargets: changed,
    snapshotStale: batch.depth === "full"
  });
  current.job = done;
  const list = previewGlobals().jobs;
  const index = list.findIndex(item => item.jobId === jobId);
  if (index >= 0) list[index] = done;
  emit(done);
  schedule();
}

/* ---------- mutations ---------- */

function consumeInjectedError() {
  const current = state();
  if (!current.nextError) return;
  const code = current.nextError;
  current.nextError = null;
  const actions: Partial<Record<SkillHubErrorCode, SkillHubError["action"]>> = {
    TARGET_CONFLICT: { kind: "resolve-conflict", payload: {} },
    WRITE_BUSY: { kind: "wait", payload: {} },
    SCRIPT_TIMEOUT: { kind: "export-report", payload: {} },
    NETWORK_FAILED: { kind: "retry", payload: {} },
    AGENT_DIR_EXTERNAL_LINK: { kind: "open-folder", payload: {} }
  };
  throw makeError(code, "预览中模拟的错误。", { action: actions[code] ?? { kind: "retry", payload: {} }, detail: "?previewError 注入" });
}

function mutationTargets(pairs: Array<{ unitId: string; agentId: AgentId }>): SkillTarget[] {
  const delivery = currentLibrary().skillDelivery;
  return (delivery?.targets ?? []).filter(target => pairs.some(pair => pair.unitId === target.unitId && pair.agentId === target.agentId));
}

function groupOf(agentId: AgentId): AgentId[] {
  const seed = seedOf(agentId);
  return [agentId, ...(seed?.linked ?? [])];
}

function setTargets(changes: TargetChange[]): TargetMutationResult {
  const current = state();
  consumeInjectedError();
  const library = currentLibrary();
  const units = new Map((library.skillDelivery?.units ?? []).map(unit => [unit.unitId, unit]));
  const rejected: TargetMutationResult["rejected"] = [];
  const touched: Array<{ unitId: string; agentId: AgentId }> = [];
  let changedCount = 0;
  let unchanged = 0;
  for (const change of changes.slice(0, 2000)) {
    const unit = units.get(change.unitId);
    if (!unit) {
      rejected.push({ unitId: change.unitId, agentId: change.agentId, error: makeError("UNIT_NOT_FOUND", "找不到这个技能包。") });
      continue;
    }
    const seed = seedOf(change.agentId);
    if (!seed?.canDeliver) {
      rejected.push({ unitId: change.unitId, agentId: change.agentId, error: makeError("AGENT_UNSUPPORTED", "这个 AI 工具还不支持同步技能。") });
      continue;
    }
    if (change.enabled && !(current.takeover.get(change.agentId) ?? false)) {
      rejected.push({ unitId: change.unitId, agentId: change.agentId, error: makeError("AGENT_NOT_TAKEN_OVER", `${seed.name} 还没有接管。`, { agentId: change.agentId, action: { kind: "takeover-agent", payload: { agentId: change.agentId } } }) });
      continue;
    }
    if (change.enabled && !unit.libraryEnabled) {
      rejected.push({
        unitId: change.unitId,
        agentId: change.agentId,
        error: makeError("SOURCE_LIBRARY_ONLY", "这个技能包只在技能库里，还没启用。", {
          sourceId: unit.sourceId || null,
          action: unit.libraryOnlyReason === "security-review" ? { kind: "review-security", payload: { sourceId: unit.sourceId } } : null
        })
      });
      continue;
    }
    for (const agentId of groupOf(change.agentId)) {
      const rowKey = key(change.unitId, agentId);
      const row = current.targets.get(rowKey) ?? { desired: false, onDisk: "none" as const, error: null, conflictSame: false, updatedAt: "", verifiedAt: "" };
      const orphanRemoval = !change.enabled && row.onDisk === "ours" && !(seedOf(agentId)?.installed ?? true);
      if (row.desired === change.enabled && row.onDisk !== "conflict" && !orphanRemoval) {
        unchanged += agentId === change.agentId ? 1 : 0;
        continue;
      }
      row.desired = change.enabled;
      row.updatedAt = now();
      if (row.error && !change.enabled) row.error = null;
      if (row.onDisk === "conflict" && !change.enabled) row.onDisk = "none";
      current.targets.set(rowKey, row);
      touched.push({ unitId: change.unitId, agentId });
      if (agentId === change.agentId) changedCount += 1;
    }
  }
  const ticket = touched.length > 0 ? request("links", "target") : null;
  return { targets: mutationTargets(touched), changed: changedCount, unchanged, rejected, jobId: ticket?.jobId ?? null };
}

function setTakeover(agentId: AgentId, enabled: boolean, fillTargets: boolean | undefined) {
  const current = state();
  consumeInjectedError();
  const seed = seedOf(agentId);
  if (!seed) throw makeError("AGENT_UNKNOWN", "不认识这个 AI 工具。");
  if (!seed.canDeliver) throw makeError("AGENT_UNSUPPORTED", "这个 AI 工具还不支持同步技能。", { agentId });
  if (enabled && !seed.installed) throw makeError("AGENT_NOT_INSTALLED", `没在这台电脑上找到 ${seed.name}。`, { agentId });
  if (enabled && current.onboarding === "pending") throw makeError("ONBOARDING_REQUIRED", "请先完成首次设置。");
  const group = groupOf(agentId);
  let created = 0;
  const units = currentLibrary().skillDelivery?.units ?? [];
  for (const id of group) {
    const wasOn = current.takeover.get(id) ?? false;
    current.takeover.set(id, enabled);
    if (enabled && !wasOn && fillTargets !== false) {
      for (const unit of units) {
        if (!unit.libraryEnabled) continue;
        const rowKey = key(unit.unitId, id);
        if (current.targets.has(rowKey)) continue;
        current.targets.set(rowKey, { desired: true, onDisk: "none", error: null, conflictSame: false, updatedAt: now(), verifiedAt: "" });
        created += 1;
      }
    }
  }
  const ticket = request("links", "takeover");
  const agents = currentLibrary().skillDelivery?.agents ?? [];
  return { agents: agents.filter(agent => group.includes(agent.id)), linkedAgentIds: seed.linked ?? [], targetsCreated: created, jobId: ticket.jobId };
}

function setChild(folderName: string, enabled: boolean) {
  const current = state();
  consumeInjectedError();
  const library = currentLibrary();
  const skill = library.skills.find(item => item.folderName === folderName);
  if (!skill) throw makeError("UNIT_NOT_FOUND", "找不到这个技能。");
  current.childEnabled.set(folderName, enabled);
  const ticket = request("full", "child-skill");
  const after = currentLibrary();
  const updated = after.skills.find(item => item.folderName === folderName) ?? { ...skill, enabled };
  const unitId = skill.sourceId ? skill.sourceId : standaloneUnitId(skill);
  return { skill: updated, unit: after.skillDelivery?.units.find(unit => unit.unitId === unitId) ?? null, jobId: ticket.jobId };
}

function setLibrary(sourceId: string, enabled: boolean, confirmed: boolean) {
  const current = state();
  consumeInjectedError();
  const library = currentLibrary();
  const source = library.sources.find(item => item.id === sourceId);
  if (!source) throw makeError("UNIT_NOT_FOUND", "找不到这个技能包。");
  if (enabled && current.flagged.has(sourceId) && !current.reviewConfirmed.has(sourceId)) {
    if (!confirmed) {
      throw makeError("SECURITY_REVIEW_REQUIRED", "启用前需要你先查看安全检查发现的内容。", {
        sourceId,
        detail: "scripts/install.sh:12 · 下载并执行远程脚本",
        action: { kind: "review-security", payload: { sourceId } }
      });
    }
    current.reviewConfirmed.add(sourceId);
  }
  current.libraryEnabled.set(sourceId, enabled);
  if (enabled) {
    for (const seed of AGENT_SEEDS) {
      if (!seed.canDeliver || !(current.takeover.get(seed.id) ?? false)) continue;
      const rowKey = key(sourceId, seed.id);
      const row = current.targets.get(rowKey);
      if (!row) current.targets.set(rowKey, { desired: true, onDisk: "none", error: null, conflictSame: false, updatedAt: now(), verifiedAt: "" });
    }
  }
  const ticket = request("full", "library");
  const after = currentLibrary();
  const unit = after.skillDelivery?.units.find(item => item.unitId === sourceId);
  return {
    source: after.sources.find(item => item.id === sourceId) ?? source,
    unit: unit ?? null,
    targets: after.skillDelivery?.targets.filter(target => target.unitId === sourceId) ?? [],
    jobId: ticket.jobId
  };
}

/* ---------- input parsing mirror (§4.7) ---------- */

export function parseSourceInputMirror(raw: string): ParsedSkillSource {
  const input = raw.trim().replace(/^["'“”]+|["'“”]+$/g, "");
  const base = (kind: ParsedSkillSource["kind"], routeTo: ParsedSkillSource["routeTo"], display: string): ParsedSkillSource =>
    ({ input: raw, kind, routeTo, display, github: null, localPath: "", error: null });
  const invalid = (code: SkillHubErrorCode, message: string) => ({ ...base("unknown", "invalid", ""), error: makeError(code, message) });
  if (!input) return invalid("INPUT_EMPTY", "请粘贴一个地址。");
  if (input.length > 2048) return invalid("INPUT_TOO_LONG", "地址太长了。");
  if (/\[mcp_servers\./.test(input)) return base("mcp-config", "mcp", "MCP");
  if (/^[[{]/.test(input)) {
    try {
      const value = JSON.parse(input) as Record<string, unknown>;
      if (value && typeof value === "object" && ("mcpServers" in value || "servers" in value || Object.values(value).some(entry => entry && typeof entry === "object" && ("command" in (entry as object) || "url" in (entry as object))))) {
        return base("mcp-config", "mcp", "MCP");
      }
    } catch {
      // fall through
    }
  }
  const github = (owner: string, repo: string, ref = "", subpath = "") => {
    const cleanRepo = repo.replace(/\.git$/i, "");
    return {
      ...base("github", "skills", `${owner}/${cleanRepo}${subpath ? ` · ${subpath}` : ""}`),
      github: { owner, repo: cleanRepo, ref, subpath, cloneUrl: `https://github.com/${owner}/${cleanRepo}.git`, webUrl: `https://github.com/${owner}/${cleanRepo}` }
    };
  };
  const short = input.match(/^([A-Za-z0-9_-]+)\/([A-Za-z0-9_.-]+)$/);
  if (short) return github(short[1], short[2]);
  const ssh = input.match(/^(?:git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i);
  if (ssh) return github(ssh[1], ssh[2]);
  const web = input.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:\/(tree|blob)\/([^/]+)(?:\/(.*))?)?\/?$/i);
  if (web) {
    const [, owner, repo, mode, ref = "", rest = ""] = web;
    let subpath = decodeURIComponent(rest).replace(/\/+$/, "");
    if (mode === "blob") subpath = subpath.replace(/\/?SKILL\.md$/i, "");
    if (subpath.split("/").some(part => part === ".." || part === ".")) return invalid("INPUT_UNRECOGNIZED", "地址里有不安全的路径。");
    return github(owner, repo, ref, subpath);
  }
  if (/^[A-Za-z]:[\\/]|^\\\\|^~[\\/]|^file:\/\/\//i.test(input)) {
    const localPath = input.replace(/^file:\/\/\//i, "").replace(/^~(?=[\\/])/, HOME);
    const zip = /\.(zip|skill)$/i.test(localPath);
    return { ...base(zip ? "zip" : "local-folder", "skills", localPath.split(/[\\/]/).filter(Boolean).pop() ?? localPath), localPath };
  }
  if (/^https?:\/\//i.test(input) || /^(gitlab|gitee|bitbucket)\./i.test(input)) {
    return invalid("INPUT_UNRECOGNIZED", "暂时只支持 GitHub 地址、本地文件夹和 .zip");
  }
  return invalid("PATH_NOT_ABSOLUTE", "请粘贴完整路径，或点「选择文件夹」");
}

/* ---------- probe fixtures ---------- */

function node(path: string, name: string, description: string, extra: Partial<ProbeSkillNode> = {}): ProbeSkillNode {
  return { path, name, description, valid: true, invalidReason: "", inLibrary: false, ...extra };
}

function chipsFor(securityPassed: boolean) {
  const current = state();
  return AGENT_SEEDS.filter(seed => seed.canDeliver && seed.installed).map(seed => ({
    agentId: seed.id,
    name: seed.name,
    preselected: (current.takeover.get(seed.id) ?? false) && !seed.experimental,
    disabled: !securityPassed,
    disabledReason: securityPassed ? "" : "需要先查看风险",
    experimental: seed.experimental
  }));
}

function emitProgress(operationId: string, stage: string, message: string, current = 0, total = 0) {
  window.dispatchEvent(new CustomEvent(PREVIEW_IMPORT_PROGRESS_EVENT, {
    detail: { operationId, stage, state: "progress", message, current, total }
  }));
}

const wait = (ms: number) => new Promise(resolve => window.setTimeout(resolve, ms));

async function probe(input: string, operationId: string): Promise<SkillSourceProbe> {
  const parsed = parseSourceInputMirror(input);
  if (parsed.error) throw parsed.error;
  if (parsed.routeTo === "mcp") throw makeError("INPUT_IS_MCP_CONFIG", "这是一段 MCP 配置。");
  const library = currentLibrary();
  const display = parsed.github ? `${parsed.github.owner}/${parsed.github.repo}` : parsed.display;
  const existing = parsed.github
    ? library.sources.find(source => source.url.toLowerCase().includes(`github.com/${parsed.github!.owner}/${parsed.github!.repo}`.toLowerCase()))
    : null;
  emitProgress(operationId, "inspect", "正在识别地址");
  await wait(250);
  const base = {
    probeId: `probe-${Date.now()}`,
    operationId,
    parsed,
    displayName: parsed.github ? parsed.github.repo : parsed.display,
    owner: parsed.github?.owner ?? "",
    sourceType: "skill" as const,
    skillGroups: [] as ProbeSkillGroup[],
    skillCount: 0,
    promptDocs: [] as SkillSourceProbe["promptDocs"],
    mcpConfigs: [] as SkillSourceProbe["mcpConfigs"],
    security: { status: "passed" as const, scannedFiles: 0, findingCount: 0, findings: [], plainSummary: "", canAddToLibrary: true, canSyncToAgents: true },
    agentChips: chipsFor(true),
    duplicate: null as SkillSourceProbe["duplicate"],
    downloadMethod: parsed.github ? "git" as const : parsed.kind === "zip" ? "zip" as const : "copy" as const,
    expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    warnings: [] as string[]
  };
  if (existing) {
    const owned = library.skills.filter(skill => skill.sourceId === existing.id);
    const callable = owned.filter(skill => isCallableSkill(skill, owned.length));
    const result: SkillSourceProbe = {
      ...base,
      displayName: existing.name,
      skillGroups: [{ groupId: "existing", title: existing.name, parent: null, children: callable.map(skill => node(skill.relativePath, skill.name, skill.description, { inLibrary: true })) }],
      skillCount: callable.length,
      duplicate: { sourceId: existing.id, name: existing.name, relation: "same" },
      downloadMethod: "index",
      security: { ...base.security, scannedFiles: 0, plainSummary: "已在技能库中" }
    };
    state().probes.set(result.probeId, result);
    return result;
  }
  emitProgress(operationId, parsed.github ? "git" : "write", "正在下载…");
  await wait(350);
  emitProgress(operationId, "security", "正在检查安全…");
  await wait(300);
  emitProgress(operationId, "enumerate", "正在列出技能…");
  await wait(150);
  let result: SkillSourceProbe;
  const lower = display.toLowerCase();
  if (parsed.github && lower === "anthropics/skills" && parsed.github.subpath) {
    const leaf = parsed.github.subpath.split("/").pop() ?? "pdf";
    result = { ...base, displayName: `skills · ${leaf}`, skillGroups: [{ groupId: "sub", title: leaf, parent: null, children: [node(parsed.github.subpath, leaf, "读取、拆分、合并 PDF，并提取表格和文字。")] }], skillCount: 1 };
    result.security = { ...base.security, scannedFiles: 14, plainSummary: "检查了 14 个文件，没有发现问题" };
  } else if (lower === "anthropics/skills") {
    const groups: ProbeSkillGroup[] = [
      { groupId: "document", title: "文档", parent: null, children: ["pdf", "docx", "xlsx", "pptx", "markdown"].map(name => node(`skills/${name}`, name, `处理 ${name.toUpperCase()} 文件。`)) },
      { groupId: "creative", title: "创作", parent: null, children: ["algorithmic-art", "canvas-design", "slack-gif-creator", "theme-factory", "brand-guidelines", "frontend-design"].map(name => node(`skills/${name}`, name, "创作与设计相关的技能。")) },
      { groupId: "dev", title: "开发", parent: null, children: ["mcp-builder", "webapp-testing", "skill-creator", "artifacts-builder", "internal-comms", "template-skill"].map(name => node(`skills/${name}`, name, "开发与协作相关的技能。", name === "template-skill" ? { valid: false, invalidReason: "SKILL.md 缺少 description" } : {})) }
    ];
    result = { ...base, skillGroups: groups, skillCount: 17 };
    result.security = { ...base.security, scannedFiles: 312, plainSummary: "检查了 312 个文件，没有发现问题" };
  } else if (lower === "example/flagged-skills") {
    const findings = [
      { id: "f1", severity: "high", category: "remote-script", relativePath: "scripts/install.sh", line: 12, summary: "下载并执行远程脚本", evidence: "curl … | sh" },
      { id: "f2", severity: "medium", category: "credential-path", relativePath: "skills/sync/SKILL.md", line: 40, summary: "读取用户目录下的密钥文件", evidence: "~/.ssh" }
    ];
    result = {
      ...base,
      skillGroups: [{ groupId: "main", title: "flagged-skills", parent: null, children: [node("skills/sync", "sync-helper", "同步配置文件。"), node("skills/deploy", "deploy-helper", "一键部署脚本。")] }],
      skillCount: 2,
      security: { status: "review", scannedFiles: 48, findingCount: 2, findings, plainSummary: "检查了 48 个文件，发现 2 处需要注意（不会被执行）", canAddToLibrary: true, canSyncToAgents: false },
      agentChips: chipsFor(false)
    };
  } else if (lower === "owner/prompt-pack") {
    result = { ...base, sourceType: "prompt", promptDocs: [{ relativePath: "prompts/polish.md", title: "论文润色" }, { relativePath: "prompts/review.md", title: "审稿意见回复" }, { relativePath: "prompts/abstract.md", title: "摘要改写" }] };
    result.security = { ...base.security, scannedFiles: 9, plainSummary: "检查了 9 个文件，没有发现问题" };
  } else if (lower === "owner/skills-and-mcp") {
    result = {
      ...base,
      sourceType: "mixed",
      skillGroups: [{ groupId: "main", title: "skills-and-mcp", parent: null, children: [node("skills/research", "research-helper", "检索并整理资料。"), node("skills/notes", "note-taker", "整理笔记。")] }],
      skillCount: 2,
      mcpConfigs: [{ relativePath: ".mcp.json", format: "json", serverNames: ["context7", "fetch"] }]
    };
    result.security = { ...base.security, scannedFiles: 21, plainSummary: "检查了 21 个文件，没有发现问题" };
  } else if (parsed.kind === "zip") {
    result = { ...base, displayName: "demo-skill", skillGroups: [{ groupId: "zip", title: "demo-skill", parent: null, children: [node("demo-skill", "demo-skill", "压缩包里的示例技能。")] }], skillCount: 1 };
    result.security = { ...base.security, scannedFiles: 4, plainSummary: "检查了 4 个文件，没有发现问题" };
  } else if (parsed.kind === "local-folder") {
    result = { ...base, displayName: parsed.display || "demo-folder", skillGroups: [{ groupId: "local", title: parsed.display || "demo-folder", parent: null, children: [node("writing-coach", "writing-coach", "逐段给出写作建议。"), node("citation-check", "citation-check", "核对引用格式。")] }], skillCount: 2 };
    result.security = { ...base.security, scannedFiles: 11, plainSummary: "检查了 11 个文件，没有发现问题" };
  } else if (parsed.github) {
    result = { ...base, skillGroups: [{ groupId: "main", title: parsed.github.repo, parent: null, children: [node("SKILL.md", parsed.github.repo, "从 GitHub 找到的技能。")] }], skillCount: 1 };
    result.security = { ...base.security, scannedFiles: 6, plainSummary: "检查了 6 个文件，没有发现问题" };
  } else {
    throw makeError("NO_SKILLS_FOUND", "没有找到 SKILL.md。");
  }
  state().probes.set(result.probeId, result);
  return result;
}

async function install(request: InstallSkillSourceRequest): Promise<InstallSkillSourceResult> {
  const current = state();
  consumeInjectedError();
  const probeResult = current.probes.get(request.probeId);
  if (!probeResult) throw makeError("PROBE_EXPIRED", "预览已过期，请重新检查一次。");
  if (probeResult.security.status === "blocked") throw makeError("SECURITY_BLOCKED", "这个来源无法安装。");
  if (probeResult.security.status === "review" && !request.securityReviewConfirmed) {
    throw makeError("SECURITY_REVIEW_REQUIRED", "安装前需要你确认安全检查发现的内容。", { action: { kind: "review-security", payload: {} } });
  }
  await wait(400);
  if (probeResult.duplicate) {
    const existing = currentLibrary().sources.find(source => source.id === probeResult.duplicate?.sourceId);
    const changes = request.agentIds.map(agentId => ({ unitId: probeResult.duplicate!.sourceId, agentId, enabled: true }));
    const mutation = changes.length ? setTargets(changes) : null;
    return {
      outcome: "updated-existing",
      source: existing!,
      unit: currentLibrary().skillDelivery?.units.find(unit => unit.unitId === probeResult.duplicate?.sourceId) ?? null,
      targets: mutation?.targets ?? [],
      disabledSkills: [],
      jobId: mutation?.jobId ?? null,
      snapshotStale: false,
      summary: "已在技能库中"
    };
  }
  const review = probeResult.security.status === "review";
  const prompt = probeResult.sourceType === "prompt";
  const id = `source-preview-${Date.now()}`;
  const name = request.displayName?.trim() || probeResult.displayName;
  const source: SourceCard = {
    id,
    name,
    sourceType: probeResult.sourceType,
    health: review ? "warn" : "ok",
    url: probeResult.parsed.github?.cloneUrl ?? "",
    skillCount: probeResult.skillCount,
    mode: probeResult.parsed.github?.subpath ? "explicit" : "scan",
    categoryId: request.categoryId ?? "general",
    note: request.note ?? "",
    localPath: probeResult.parsed.localPath || `../app-next/data/github_sources/${name}`,
    enabled: !review,
    tags: request.tags,
    createdAt: now(),
    userFolderId: request.folderId ?? undefined
  };
  const selected = new Set(request.selectedSkillPaths);
  const children = probeResult.skillGroups.flatMap(group => group.children).filter(child => child.valid);
  const disabledSkills: string[] = [];
  const skills: SkillCard[] = children.map(child => {
    const enabled = selected.size === 0 || selected.has(child.path);
    if (!enabled) disabledSkills.push(child.name);
    return {
      id: `preview-skill-${id}-${child.name}`,
      sourceId: id,
      name: child.name,
      folderName: child.name,
      category: source.categoryId,
      description: child.description,
      note: "",
      source: name,
      health: "ok",
      enabled,
      rating: 0,
      relativePath: child.path,
      tags: []
    };
  });
  current.extraSources.push(source);
  current.extraSkills.push(...skills);
  if (review) {
    current.flagged.add(id);
    current.libraryEnabled.set(id, false);
  }
  const agentIds = review || prompt ? [] : request.agentIds;
  for (const agentId of agentIds) {
    for (const member of groupOf(agentId)) {
      current.targets.set(key(id, member), { desired: true, onDisk: "none", error: null, conflictSame: false, updatedAt: now(), verifiedAt: "" });
    }
  }
  const ticket = request_("full", "install");
  const after = currentLibrary();
  return {
    outcome: review ? "library-only" : prompt ? "prompt-library" : "installed",
    source: after.sources.find(item => item.id === id) ?? source,
    unit: after.skillDelivery?.units.find(unit => unit.unitId === id) ?? null,
    targets: after.skillDelivery?.targets.filter(target => target.unitId === id) ?? [],
    disabledSkills,
    jobId: ticket.jobId,
    snapshotStale: true,
    summary: review ? "已加入技能库并保持停用" : `已加入技能库 · 正在同步到 ${agentIds.length} 个 AI 工具`
  };
}

const request_ = request;

/* ---------- adopt ---------- */

function adoptCandidates(): AdoptCandidate[] {
  const names = ["daily-standup", "pr-review", "sql-helper", "regex-explainer", "commit-message", "unit-test-writer", "api-docs", "changelog", "refactor-guide", "bug-triage",
    "translate-zh", "email-polish", "slide-outline", "data-cleaning", "chart-advisor", "meeting-agenda", "code-explainer", "dependency-audit", "release-check", "ux-review"];
  const list: AdoptCandidate[] = names.map((name, index) => ({
    id: `adopt-${name}`,
    name,
    description: `个人技能 ${index + 1}：${name}`,
    state: "new",
    selectedByDefault: true,
    canonicalPath: `${HOME}\\.claude\\skills\\${name}`,
    contentHash: `sha256:${name}`,
    agentIds: ["claude"],
    locations: [{ agentId: "claude", path: `${HOME}\\.claude\\skills\\${name}`, storageKind: "directory" }],
    duplicateOf: "",
    managedUnitId: ""
  }));
  list.push(
    { id: "adopt-dup-1", name: "pr-review", description: "同一个文件夹在 Codex 旧目录里也出现了。", state: "duplicate", selectedByDefault: false, canonicalPath: `${HOME}\\.claude\\skills\\pr-review`, contentHash: "sha256:pr-review", agentIds: ["codex"], locations: [{ agentId: "codex-legacy", path: `${HOME}\\.codex\\skills\\pr-review`, storageKind: "link" }], duplicateOf: "adopt-pr-review", managedUnitId: "" },
    { id: "adopt-dup-2", name: "sql-helper", description: "同一个文件夹在 Codex 旧目录里也出现了。", state: "duplicate", selectedByDefault: false, canonicalPath: `${HOME}\\.claude\\skills\\sql-helper`, contentHash: "sha256:sql-helper", agentIds: ["codex"], locations: [{ agentId: "codex-legacy", path: `${HOME}\\.codex\\skills\\sql-helper`, storageKind: "link" }], duplicateOf: "adopt-sql-helper", managedUnitId: "" },
    { id: "adopt-managed", name: "impeccable", description: "和技能库里的 impeccable 内容相同。", state: "already-managed", selectedByDefault: false, canonicalPath: `${HOME}\\.gemini\\antigravity\\skills\\impeccable-copy`, contentHash: "sha256:impeccable", agentIds: ["antigravity"], locations: [{ agentId: "antigravity", path: `${HOME}\\.gemini\\antigravity\\skills\\impeccable-copy`, storageKind: "directory" }], duplicateOf: "", managedUnitId: "source-impeccable" },
    { id: "adopt-clash", name: "figure-planner", description: "技能库里已有同名但内容不同的技能。", state: "name-clash", selectedByDefault: false, canonicalPath: `${HOME}\\.agents\\skills\\figure-planner`, contentHash: "sha256:figure-planner-mine", agentIds: ["codex"], locations: [{ agentId: "codex", path: `${HOME}\\.agents\\skills\\figure-planner`, storageKind: "directory" }], duplicateOf: "", managedUnitId: "" }
  );
  const adopted = state().adopted;
  return list.filter(candidate => !adopted.has(candidate.id));
}

function adoptPreview(): AdoptPreview {
  const candidates = adoptCandidates();
  return {
    candidates,
    importable: candidates.filter(item => item.state === "new").length,
    alreadyManaged: candidates.filter(item => item.state === "already-managed").length,
    duplicates: candidates.filter(item => item.state === "duplicate").length,
    warnings: [],
    truncated: false,
    scannedAt: now()
  };
}

async function adopt(candidateIds: string[], operationId: string): Promise<AdoptReport> {
  const current = state();
  const candidates = adoptCandidates();
  const results: AdoptReport["results"] = [];
  let index = 0;
  for (const id of candidateIds) {
    index += 1;
    const candidate = candidates.find(item => item.id === id);
    if (!candidate) continue;
    emitProgress(operationId, "adopt", `正在纳入 ${candidate.name}`, index, candidateIds.length);
    await wait(25);
    if (candidate.state === "duplicate") {
      results.push({ candidateId: id, name: candidate.name, outcome: "skipped-duplicate", sourceId: "", error: null });
      continue;
    }
    if (candidate.state === "already-managed") {
      results.push({ candidateId: id, name: candidate.name, outcome: "skipped-managed", sourceId: candidate.managedUnitId, error: null });
      continue;
    }
    if (candidate.state === "name-clash") {
      results.push({ candidateId: id, name: candidate.name, outcome: "failed", sourceId: "", error: makeError("DUPLICATE_SOURCE", "技能库里已有同名但内容不同的技能。") });
      continue;
    }
    const sourceId = `source-adopted-${candidate.name}`;
    current.extraSources.push({ id: sourceId, name: candidate.name, sourceType: "skill", health: "ok", url: "", skillCount: 1, mode: "explicit", categoryId: "general", note: "", localPath: candidate.canonicalPath, enabled: true, tags: [], createdAt: now() });
    current.extraSkills.push({ id: `preview-skill-${sourceId}`, sourceId, name: candidate.name, folderName: candidate.name, category: "general", description: candidate.description, note: "", source: candidate.name, health: "ok", enabled: true, rating: 0, relativePath: "SKILL.md", tags: [] });
    for (const seed of AGENT_SEEDS) {
      if (seed.canDeliver && (current.takeover.get(seed.id) ?? false)) {
        current.targets.set(key(sourceId, seed.id), { desired: true, onDisk: seed.id === "claude" ? "none" : "none", error: null, conflictSame: false, updatedAt: now(), verifiedAt: "" });
      }
    }
    current.adopted.add(id);
    results.push({ candidateId: id, name: candidate.name, outcome: "adopted", sourceId, error: null });
  }
  current.personal.set("claude", Math.max(0, (current.personal.get("claude") ?? 20) - results.filter(item => item.outcome === "adopted").length));
  const adoptedCount = results.filter(item => item.outcome === "adopted").length;
  const ticket = adoptedCount > 0 ? request("full", "adopt") : null;
  return {
    results,
    adopted: adoptedCount,
    libraryOnly: results.filter(item => item.outcome === "library-only").length,
    skipped: results.filter(item => item.outcome === "skipped-duplicate" || item.outcome === "skipped-managed").length,
    failed: results.filter(item => item.outcome === "failed").length,
    jobId: ticket?.jobId ?? null,
    snapshotStale: adoptedCount > 0
  };
}

function inventory(agentId: AgentId): AgentSkillInventory {
  const current = state();
  const seed = seedOf(agentId);
  if (!seed) throw makeError("AGENT_UNKNOWN", "不认识这个 AI 工具。");
  const delivery = currentLibrary().skillDelivery;
  const entries: AgentSkillEntry[] = [];
  for (const target of delivery?.targets ?? []) {
    if (target.agentId !== agentId) continue;
    if (target.status === "synced" || target.status === "removing" || target.status === "orphan") {
      entries.push({ name: target.entryName, description: "", path: target.targetPath, storageKind: target.mode === "shared-real" ? "directory" : "link", state: target.status === "orphan" ? "stale" : "managed", unitId: target.unitId, adoptCandidateId: "" });
    } else if (target.status === "conflict") {
      entries.push({ name: target.entryName, description: "同名的个人技能，没有覆盖。", path: target.targetPath, storageKind: "directory", state: "conflict", unitId: target.unitId, adoptCandidateId: "" });
    }
  }
  const personal = adoptCandidates().filter(candidate => candidate.state === "new" && candidate.agentIds.includes(agentId));
  for (const candidate of personal) {
    entries.push({ name: candidate.name, description: candidate.description, path: candidate.canonicalPath, storageKind: "directory", state: "personal", unitId: "", adoptCandidateId: candidate.id });
  }
  if (agentId === "claude") {
    entries.push({ name: "old-router", description: "SkillHub 以前建的入口，技能包已删除。", path: `${seed.skillsPath}\\old-router`, storageKind: "link", state: "stale", unitId: "", adoptCandidateId: "" });
  }
  current.personal.set(agentId, personal.length);
  return { agentId, skillsPath: seed.skillsPath, entries, warnings: [], scannedAt: now() };
}

function onboardingState(): OnboardingState {
  const current = state();
  const preview = adoptPreview();
  return {
    status: current.onboarding,
    agents: AGENT_SEEDS.map(seed => ({
      agentId: seed.id,
      name: seed.name,
      statusWord: statusWord(seed, false),
      canDeliver: seed.canDeliver,
      experimental: seed.experimental,
      preselected: seed.installed && seed.canDeliver && !seed.experimental,
      reason: !seed.canDeliver ? (seed.unsupportedReason || "还不支持同步技能") : !seed.installed ? "没在这台电脑上找到" : seed.experimental ? "实验性" : ""
    })),
    existingSkills: { importable: preview.importable + 17, alreadyManaged: preview.alreadyManaged, duplicates: preview.duplicates, byAgent: [{ agentId: "claude", count: 20 }, { agentId: "codex", count: 17 }] }
  };
}

async function completeOnboarding(agentIds: AgentId[], adoptExisting: boolean) {
  const current = state();
  current.onboarding = "completed";
  for (const seed of AGENT_SEEDS) current.takeover.set(seed.id, false);
  for (const agentId of agentIds) {
    const seed = seedOf(agentId);
    if (!seed?.canDeliver) throw makeError("AGENT_UNSUPPORTED", "这个 AI 工具还不支持同步技能。");
    if (!seed.installed) throw makeError("AGENT_NOT_INSTALLED", `没在这台电脑上找到 ${seed.name}。`);
    for (const member of groupOf(agentId)) current.takeover.set(member, true);
  }
  const units = currentLibrary().skillDelivery?.units ?? [];
  for (const unit of units) {
    if (!unit.libraryEnabled) continue;
    for (const [agentId, on] of current.takeover) {
      if (on) current.targets.set(key(unit.unitId, agentId), { desired: true, onDisk: "none", error: null, conflictSame: false, updatedAt: now(), verifiedAt: "" });
    }
  }
  const adoptReport = adoptExisting
    ? await adopt(adoptCandidates().filter(item => item.selectedByDefault).map(item => item.id), `onboarding-${Date.now()}`)
    : null;
  const ticket = request("full", "onboarding");
  return { status: current.onboarding, agents: currentLibrary().skillDelivery?.agents ?? [], adopt: adoptReport, jobId: ticket.jobId };
}

function readDocument(skillId: string) {
  const library = currentLibrary();
  const skill = library.skills.find(item => (item.id || `preview-skill-${item.folderName}`) === skillId);
  if (!skill) throw makeError("UNIT_NOT_FOUND", "找不到这个技能。");
  const content = [
    "---",
    `name: ${skill.folderName}`,
    `description: ${skill.description}`,
    "---",
    "",
    `# ${skill.name}`,
    "",
    skill.description.replace("[ROUTER-HUB]", "").trim(),
    "",
    "## 什么时候用",
    "",
    "- 当任务和上面的说明相符时，直接说出技能名即可调用。",
    "- 预览中的内容是示例，真实内容来自你的技能文件夹。"
  ].join("\n");
  return { skillId, path: `${library.skillsDir}\\${skill.folderName}\\SKILL.md`, content, truncated: false, files: ["SKILL.md", "references/examples.md", "scripts/README.md"] };
}

/* ---------- dispatcher ---------- */

export async function previewSkillCommand<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  const value = await dispatch(command, args);
  return value as T;
}

async function dispatch(command: string, args: Record<string, unknown>): Promise<unknown> {
  await wait(40);
  switch (command) {
    case "get_skill_delivery_state":
      return currentLibrary().skillDelivery;
    case "list_skill_agents": {
      const delivery = currentLibrary().skillDelivery!;
      return { agents: delivery.agents, paused: delivery.paused, onboarding: delivery.onboarding, generatedAt: delivery.generatedAt };
    }
    case "set_agent_takeover":
      return setTakeover(args.agentId as AgentId, Boolean(args.enabled), args.fillTargets as boolean | undefined);
    case "set_skill_delivery_paused": {
      const current = state();
      consumeInjectedError();
      current.paused = Boolean(args.paused);
      const ticket = current.paused ? null : request("full", "unpause");
      return { paused: current.paused, onboarding: current.onboarding, jobId: ticket?.jobId ?? null };
    }
    case "set_skill_target":
      return setTargets([{ unitId: String(args.unitId), agentId: args.agentId as AgentId, enabled: Boolean(args.enabled) }]);
    case "set_skill_targets_batch":
      return setTargets((args.changes as TargetChange[]) ?? []);
    case "set_child_skill_enabled":
      return setChild(String(args.folderName), Boolean(args.enabled));
    case "set_source_library_enabled":
      return setLibrary(String(args.sourceId), Boolean(args.enabled), Boolean(args.securityReviewConfirmed));
    case "request_skill_delivery": {
      const depth = String(args.depth) as DeliveryDepth;
      if (!(depth in DEPTH_RANK)) throw makeError("INTERNAL", "未知的同步方式。");
      const ticket = request(depth, String(args.reason || "user"));
      return { jobId: ticket.jobId, phase: "queued", coalesced: ticket.coalesced };
    }
    case "get_onboarding_state":
      return onboardingState();
    case "complete_onboarding":
      return completeOnboarding((args.agentIds as AgentId[]) ?? [], Boolean(args.adoptExistingSkills));
    case "parse_skill_source_input":
      return parseSourceInputMirror(String(args.input ?? ""));
    case "probe_skill_source":
      return probe(String(args.input ?? ""), String(args.operationId ?? ""));
    case "install_skill_source":
      return install(args.request as InstallSkillSourceRequest);
    case "discard_skill_source_probe":
      return state().probes.delete(String(args.probeId));
    case "read_skill_source_probe_file":
      return { relativePath: String(args.relativePath), text: "{\n  \"mcpServers\": {\n    \"context7\": { \"command\": \"npx\", \"args\": [\"-y\", \"@upstash/context7-mcp\"] },\n    \"fetch\": { \"command\": \"uvx\", \"args\": [\"mcp-server-fetch\"] }\n  }\n}", truncated: false };
    case "pick_skill_source_path":
      return args.kind === "zip" ? `${HOME}\\Downloads\\demo.skill.zip` : `${HOME}\\skills\\demo-folder`;
    case "cancel_source_import":
      return true;
    case "preview_adopt_external_skills":
      return adoptPreview();
    case "adopt_external_skills":
      return adopt((args.candidateIds as string[]) ?? [], String(args.operationId ?? ""));
    case "list_agent_skills":
      return inventory(args.agentId as AgentId);
    case "open_agent_skills_folder":
      return null;
    case "read_library_skill_document":
      return readDocument(String(args.skillId));
    case "export_troubleshooting_report":
      return { reportPath: `${HOME}\\AppData\\Local\\AI SkillHub\\reports\\troubleshooting-preview.zip`, folderPath: `${HOME}\\AppData\\Local\\AI SkillHub\\reports`, generatedAt: now() };
    default:
      throw makeError("INTERNAL", `预览不支持 ${command}`);
  }
}
