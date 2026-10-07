// v3.3 delivery presentation rules (skills contract §6.1, §6.3).
// Pure functions that turn backend state into what the shell and the icon row show.
// No runtime imports: the node contract test transpiles this file alone.
import type {
  AgentHealth,
  AgentId,
  SkillAgent,
  SkillDeliveryState,
  SkillTarget,
  SkillTargetStatus
} from "./types";

export type SyncTone = "busy" | "paused" | "idle" | "problem" | "ok";

export type SyncIndicator = {
  tone: SyncTone;
  /** i18n key of the short label; vars fill {n}. */
  labelKey: string;
  vars: Record<string, string | number>;
  /** Plain label of whatever holds the write lock while waiting ("" otherwise). */
  waitingFor: string;
};

const BUSY_PHASES = new Set(["queued", "waiting", "running"]);

export function deliveryJobBusy(state: Pick<SkillDeliveryState, "job"> | null | undefined): boolean {
  return Boolean(state?.job && BUSY_PHASES.has(state.job.phase));
}

/** Priority: busy > paused > idle > problem > ok. */
export function topSyncIndicator(state: SkillDeliveryState | null | undefined): SyncIndicator {
  if (!state) return { tone: "idle", labelKey: "sync.idle", vars: {}, waitingFor: "" };
  if (deliveryJobBusy(state)) {
    return { tone: "busy", labelKey: "sync.busy", vars: {}, waitingFor: state.job?.waitingFor ?? "" };
  }
  if (state.paused) return { tone: "paused", labelKey: "sync.paused", vars: {}, waitingFor: "" };
  const managed = state.agents.filter(agent => agent.takeover);
  if (state.onboarding === "pending" || managed.length === 0) {
    return { tone: "idle", labelKey: "sync.idle", vars: {}, waitingFor: "" };
  }
  if (state.problems.length > 0) {
    return { tone: "problem", labelKey: "sync.problem", vars: { n: state.problems.length }, waitingFor: "" };
  }
  const n = managed.filter(agent => agent.installed).length;
  return { tone: "ok", labelKey: "sync.ok", vars: { n }, waitingFor: "" };
}

export type TargetIconLook = "solid" | "dim" | "spin" | "paused" | "amber" | "red" | "blocked";
export type TargetIconAction = "remove" | "add" | "none" | "open-settings" | "open-drawer" | "retry" | "review" | "takeover";

export type TargetIconView = {
  look: TargetIconLook;
  /** i18n key of the tooltip; vars: {tool}, {message}. */
  tooltipKey: string;
  action: TargetIconAction;
  disabled: boolean;
};

/** Every one of the 11 SkillTargetStatus values maps to a look, a tooltip and one click action. */
export const TARGET_ICON_VIEWS: Readonly<Record<SkillTargetStatus, TargetIconView>> = {
  synced: { look: "solid", tooltipKey: "target.synced", action: "remove", disabled: false },
  off: { look: "dim", tooltipKey: "target.off", action: "add", disabled: false },
  pending: { look: "spin", tooltipKey: "target.pending", action: "none", disabled: true },
  removing: { look: "spin", tooltipKey: "target.removing", action: "none", disabled: true },
  paused: { look: "paused", tooltipKey: "target.paused", action: "open-settings", disabled: false },
  orphan: { look: "amber", tooltipKey: "target.orphan", action: "remove", disabled: false },
  conflict: { look: "red", tooltipKey: "target.conflict", action: "open-drawer", disabled: false },
  error: { look: "red", tooltipKey: "target.error", action: "retry", disabled: false },
  blocked: { look: "blocked", tooltipKey: "target.blocked", action: "review", disabled: false },
  "takeover-off": { look: "dim", tooltipKey: "target.takeoverOff", action: "takeover", disabled: false },
  unsupported: { look: "blocked", tooltipKey: "target.unsupported", action: "none", disabled: true }
};

export function targetIconView(target: Pick<SkillTarget, "status" | "conflict">, libraryOnlyReason = ""): TargetIconView {
  const view = TARGET_ICON_VIEWS[target.status] ?? TARGET_ICON_VIEWS.off;
  if (target.status === "conflict" && target.conflict?.sameContent) {
    return { ...view, tooltipKey: "target.conflictSame" };
  }
  if (target.status === "blocked") {
    return libraryOnlyReason === "security-review"
      ? view
      : { ...view, tooltipKey: libraryOnlyReason === "no-enabled-skills" ? "target.blockedNoSkills" : "target.blockedOff", action: "none", disabled: true };
  }
  return view;
}

/** Codex and Coze render adjacent with a link glyph while they share ~/.agents/skills (I-9). */
export function orderTargetsForRow(targets: readonly SkillTarget[], agents: readonly SkillAgent[]): SkillTarget[] {
  const order = new Map(agents.map((agent, index) => [agent.id, index]));
  const sorted = [...targets].sort((a, b) => (order.get(a.agentId) ?? 99) - (order.get(b.agentId) ?? 99));
  const codex = sorted.findIndex(target => target.agentId === "codex");
  const coze = sorted.findIndex(target => target.agentId === "coze");
  if (codex >= 0 && coze >= 0 && Math.abs(codex - coze) !== 1) {
    const [cozeTarget] = sorted.splice(coze, 1);
    const at = sorted.findIndex(target => target.agentId === "codex");
    sorted.splice(at + 1, 0, cozeTarget);
  }
  return sorted;
}

export function agentDotTone(health: AgentHealth | undefined): "ok" | "busy" | "problem" | "off" {
  if (health === "ok" || health === "busy" || health === "problem") return health;
  return "off";
}

/** Agents shown under "AI 工具" in the sidebar: the taken-over ones. */
export function sidebarAgents(state: SkillDeliveryState | null | undefined): SkillAgent[] {
  return (state?.agents ?? []).filter(agent => agent.takeover);
}

/** Installed, deliverable tools the user has not taken over yet ("发现 N 个新工具"). */
export function availableAgents(state: SkillDeliveryState | null | undefined): SkillAgent[] {
  return (state?.agents ?? []).filter(agent => agent.statusWord === "available");
}

export function linkedAgentIds(agent: Pick<SkillAgent, "linkedAgentIds">): AgentId[] {
  return agent.linkedAgentIds ?? [];
}

/** Count of the targets a batch would really change for one agent. */
export function batchChangeCount(
  targets: readonly SkillTarget[],
  unitIds: ReadonlySet<string>,
  agentId: AgentId,
  enable: boolean
): number {
  let changed = 0;
  for (const unitId of unitIds) {
    const target = targets.find(item => item.unitId === unitId && item.agentId === agentId);
    if (!target) continue;
    if (enable ? !target.desired && target.status !== "blocked" : target.desired) changed += 1;
  }
  return changed;
}
