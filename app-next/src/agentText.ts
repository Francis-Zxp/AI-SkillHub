// Sentences the backend sends in Chinese only (skills contract §4.3: SkillAgent hints,
// DeliveryProblem.message, OnboardingAgent.reason, probe chip and skill reasons). In zh the
// backend wording is the final copy and is shown as is; in en and ko the UI rebuilds the sentence
// from the structured fields, so no Chinese leaks into the other two languages (zh/en/ko parity).
import { getLang, t } from "./i18n";
import { skillHubErrorText } from "./skillErrors";
import type { DeliveryProblem, SkillAgent, SkillHubError } from "./types";

type NamedAgent = Pick<SkillAgent, "id" | "name">;

function backendWordingFits(text: string | null | undefined): text is string {
  return getLang() === "zh" && Boolean(text?.trim());
}

function agentName(agentId: string | null | undefined, agents: readonly NamedAgent[]) {
  if (!agentId) return "";
  return agents.find(agent => agent.id === agentId)?.name ?? agentId;
}

/** "与 扣子 共用目录" while Codex and 扣子 share ~/.agents/skills (I-9); "" otherwise. */
export function agentSharedNote(
  agent: Pick<SkillAgent, "id" | "linkedAgentIds" | "sharedFolderNote">,
  agents: readonly NamedAgent[]
): string {
  if (agent.linkedAgentIds.length === 0) return "";
  if (backendWordingFits(agent.sharedFolderNote)) return agent.sharedFolderNote;
  if (agent.id === "codex" && agent.linkedAgentIds.includes("coze")) return t("v33.sharedWithCoze");
  if (agent.id === "coze" && agent.linkedAgentIds.includes("codex")) return t("v33.sharedWithCodex");
  return t("v33.sharedWith", { name: agent.linkedAgentIds.map(id => agentName(id, agents)).join(", ") });
}

export function agentExperimentalReason(agent: Pick<SkillAgent, "name" | "experimental" | "experimentalReason">): string {
  if (!agent.experimental) return "";
  return backendWordingFits(agent.experimentalReason) ? agent.experimentalReason : t("v33.experimentalReason", { tool: agent.name });
}

export function agentAfterSyncHint(agent: Pick<SkillAgent, "name" | "afterSyncHint">): string {
  if (!agent.afterSyncHint.trim()) return "";
  return backendWordingFits(agent.afterSyncHint) ? agent.afterSyncHint : t("v33.afterSyncHint", { tool: agent.name });
}

export function agentUnsupportedReason(reason: string | null | undefined): string {
  return backendWordingFits(reason) ? reason : t("v33.notSupportedReason");
}

/** Onboarding row reason: the backend's words in zh, a status-based plain reason elsewhere. */
export function onboardingReason(agent: { statusWord: string; canDeliver: boolean; reason: string }): string {
  if (backendWordingFits(agent.reason)) return agent.reason;
  if (agent.statusWord === "not-installed") return t("v33.notInstalledReason");
  if (!agent.canDeliver || agent.statusWord === "unsupported") return t("v33.notSupportedReason");
  return "";
}

/** One line for the 问题 list and the AI 工具 cards (a card already names its tool: withTool = false). */
export function problemText(
  problem: Pick<DeliveryProblem, "code" | "message" | "agentId" | "unitId">,
  agents: readonly NamedAgent[],
  unitName: (unitId: string) => string = () => "",
  withTool = true
): string {
  if (backendWordingFits(problem.message)) return problem.message;
  const tool = agentName(problem.agentId, agents);
  if (problem.code === "AGENT_NOT_INSTALLED" && problem.unitId) {
    return t("v33.problemOrphan", { tool: tool || "—", pack: unitName(problem.unitId) || problem.unitId });
  }
  const key = `err.${problem.code}`;
  const localized = t(key, { agent: tool });
  const text = localized !== key ? localized : problem.message;
  return withTool && tool && text ? `${tool}: ${text}` : text;
}

/** A target's error in the icon tooltip: localized by code, the backend sentence as a fallback. */
export function targetErrorText(error: SkillHubError | null | undefined): string {
  return error ? skillHubErrorText(error, t) : "";
}

/** Why a skill in a probe can't be installed (backend wording in zh). */
export function invalidSkillReason(reason: string): string {
  return backendWordingFits(reason) ? reason : t("err.MANIFEST_INVALID");
}

/** Tooltip of a disabled install chip (backend wording in zh). */
export function chipDisabledReason(reason: string, fallback: string): string {
  if (!reason.trim()) return fallback;
  return backendWordingFits(reason) ? reason : fallback;
}
