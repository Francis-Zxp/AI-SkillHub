// v3.3 Skills commands (skills contract §4.2). One typed wrapper per Tauri command.
// In the browser preview every wrapper is served by the stateful mock in
// skillsPreview.ts (loaded lazily through preview.ts), so all flows work with `pnpm dev`.
import { invoke } from "@tauri-apps/api/core";
import { normalizeSkillHubError } from "./skillErrors";
import type {
  AdoptPreview,
  AdoptReport,
  AgentId,
  AgentSkillInventory,
  ChildSkillToggleResult,
  DeliveryControlState,
  DeliveryDepth,
  DeliveryJobStatus,
  DeliveryJobTicket,
  InstallSkillSourceRequest,
  InstallSkillSourceResult,
  LibrarySkillDocument,
  OnboardingResult,
  OnboardingState,
  ParsedSkillSource,
  ProbeFileText,
  SkillAgentList,
  SkillDeliveryState,
  SkillSourceDroppedEvent,
  SkillSourceProbe,
  SourceLibraryResult,
  TakeoverResult,
  TargetChange,
  TargetMutationResult,
  TroubleshootingReport
} from "./types";

export const DELIVERY_STATUS_EVENT = "delivery-status";
export const SKILL_SOURCE_DROPPED_EVENT = "skill-source-dropped";
export const SOURCE_IMPORT_PROGRESS_EVENT = "source-import-progress";
/** Browser-preview mirror of delivery-status, dispatched on window by the mock queue. */
export const PREVIEW_DELIVERY_EVENT = "ai-skillhub-preview-delivery";
/** Browser-preview mirror of source-import-progress. */
export const PREVIEW_IMPORT_PROGRESS_EVENT = "ai-skillhub-preview-import-progress";

export type ImportProgress = {
  operationId: string;
  stage: string;
  state: string;
  message: string;
  current: number;
  total: number;
};

function desktop() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function wrap<T>(task: Promise<T>): Promise<T> {
  try {
    return await task;
  } catch (error) {
    throw normalizeSkillHubError(error);
  }
}

async function preview<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  const module = await import("./preview");
  try {
    return await module.previewSkillCommand<T>(command, args);
  } catch (error) {
    throw normalizeSkillHubError(error);
  }
}

export function createOperationId(prefix = "op") {
  const random = globalThis.crypto?.randomUUID?.().replace(/[^a-zA-Z0-9_-]/g, "") ?? Math.random().toString(36).slice(2);
  return `${prefix}-${Date.now()}-${random}`.slice(0, 92);
}

/* ---------- read state ---------- */

export async function getSkillDeliveryState(): Promise<SkillDeliveryState> {
  if (!desktop()) return preview("get_skill_delivery_state");
  return wrap(invoke<SkillDeliveryState>("get_skill_delivery_state"));
}

export async function listSkillAgents(): Promise<SkillAgentList> {
  if (!desktop()) return preview("list_skill_agents");
  return wrap(invoke<SkillAgentList>("list_skill_agents"));
}

/* ---------- takeover, pause, targets ---------- */

export async function setAgentTakeover(agentId: AgentId, enabled: boolean, fillTargets?: boolean): Promise<TakeoverResult> {
  if (!desktop()) return preview("set_agent_takeover", { agentId, enabled, fillTargets });
  return wrap(invoke<TakeoverResult>("set_agent_takeover", { agentId, enabled, fillTargets: fillTargets ?? null }));
}

export async function setSkillDeliveryPaused(paused: boolean): Promise<DeliveryControlState> {
  if (!desktop()) return preview("set_skill_delivery_paused", { paused });
  return wrap(invoke<DeliveryControlState>("set_skill_delivery_paused", { paused }));
}

export async function setSkillTarget(unitId: string, agentId: AgentId, enabled: boolean): Promise<TargetMutationResult> {
  if (!desktop()) return preview("set_skill_target", { unitId, agentId, enabled });
  return wrap(invoke<TargetMutationResult>("set_skill_target", { unitId, agentId, enabled }));
}

export async function setSkillTargetsBatch(changes: TargetChange[]): Promise<TargetMutationResult> {
  if (!desktop()) return preview("set_skill_targets_batch", { changes });
  return wrap(invoke<TargetMutationResult>("set_skill_targets_batch", { changes }));
}

export async function setChildSkillEnabled(folderName: string, enabled: boolean): Promise<ChildSkillToggleResult> {
  if (!desktop()) return preview("set_child_skill_enabled", { folderName, enabled });
  return wrap(invoke<ChildSkillToggleResult>("set_child_skill_enabled", { folderName, enabled }));
}

export async function setSourceLibraryEnabled(
  sourceId: string,
  enabled: boolean,
  securityReviewConfirmed: boolean
): Promise<SourceLibraryResult> {
  if (!desktop()) return preview("set_source_library_enabled", { sourceId, enabled, securityReviewConfirmed });
  return wrap(invoke<SourceLibraryResult>("set_source_library_enabled", { sourceId, enabled, securityReviewConfirmed }));
}

export async function requestSkillDelivery(reason: string, depth: DeliveryDepth, refreshDetection?: boolean): Promise<DeliveryJobTicket> {
  if (!desktop()) return preview("request_skill_delivery", { reason, depth, refreshDetection });
  return wrap(invoke<DeliveryJobTicket>("request_skill_delivery", { reason, depth, refreshDetection: refreshDetection ?? null }));
}

/* ---------- onboarding ---------- */

export async function getOnboardingState(): Promise<OnboardingState> {
  if (!desktop()) return preview("get_onboarding_state");
  return wrap(invoke<OnboardingState>("get_onboarding_state"));
}

export async function completeOnboarding(agentIds: AgentId[], adoptExistingSkills: boolean): Promise<OnboardingResult> {
  if (!desktop()) return preview("complete_onboarding", { agentIds, adoptExistingSkills });
  return wrap(invoke<OnboardingResult>("complete_onboarding", { agentIds, adoptExistingSkills }));
}

/* ---------- one-box input, probe, install ---------- */

export async function parseSkillSourceInput(input: string): Promise<ParsedSkillSource> {
  if (!desktop()) return preview("parse_skill_source_input", { input });
  return wrap(invoke<ParsedSkillSource>("parse_skill_source_input", { input }));
}

export async function probeSkillSource(
  input: string,
  operationId: string,
  onProgress?: (event: ImportProgress) => void
): Promise<SkillSourceProbe> {
  const stop = await listenImportProgress(operationId, onProgress);
  try {
    if (!desktop()) return await preview<SkillSourceProbe>("probe_skill_source", { input, operationId });
    return await wrap(invoke<SkillSourceProbe>("probe_skill_source", { operationId, input }));
  } finally {
    stop();
  }
}

export async function installSkillSource(
  request: InstallSkillSourceRequest,
  onProgress?: (event: ImportProgress) => void,
  operationId?: string
): Promise<InstallSkillSourceResult> {
  const stop = operationId ? await listenImportProgress(operationId, onProgress) : () => undefined;
  try {
    if (!desktop()) return await preview<InstallSkillSourceResult>("install_skill_source", { request });
    return await wrap(invoke<InstallSkillSourceResult>("install_skill_source", { request }));
  } finally {
    stop();
  }
}

export async function discardSkillSourceProbe(probeId: string): Promise<boolean> {
  if (!desktop()) return preview("discard_skill_source_probe", { probeId });
  return wrap(invoke<boolean>("discard_skill_source_probe", { probeId }));
}

export async function readSkillSourceProbeFile(probeId: string, relativePath: string): Promise<ProbeFileText> {
  if (!desktop()) return preview("read_skill_source_probe_file", { probeId, relativePath });
  return wrap(invoke<ProbeFileText>("read_skill_source_probe_file", { probeId, relativePath }));
}

export async function pickSkillSourcePath(kind: "folder" | "zip"): Promise<string | null> {
  if (!desktop()) return preview("pick_skill_source_path", { kind });
  return wrap(invoke<string | null>("pick_skill_source_path", { kind }));
}

/** Existing command (lib.rs:4932); also cancels probe and adopt. */
export async function cancelSourceImport(operationId: string): Promise<boolean> {
  if (!desktop()) return preview("cancel_source_import", { operationId });
  try {
    return await invoke<boolean>("cancel_source_import", { operationId });
  } catch {
    return false;
  }
}

/* ---------- adopt existing skills ---------- */

export async function previewAdoptExternalSkills(projectPath?: string): Promise<AdoptPreview> {
  if (!desktop()) return preview("preview_adopt_external_skills", { projectPath });
  return wrap(invoke<AdoptPreview>("preview_adopt_external_skills", { projectPath: projectPath ?? null }));
}

export async function adoptExternalSkills(
  candidateIds: string[],
  operationId: string,
  onProgress?: (event: ImportProgress) => void
): Promise<AdoptReport> {
  const stop = await listenImportProgress(operationId, onProgress);
  try {
    if (!desktop()) return await preview<AdoptReport>("adopt_external_skills", { candidateIds, operationId });
    return await wrap(invoke<AdoptReport>("adopt_external_skills", { candidateIds, operationId }));
  } finally {
    stop();
  }
}

/* ---------- per tool, documents, report ---------- */

export async function listAgentSkills(agentId: AgentId): Promise<AgentSkillInventory> {
  if (!desktop()) return preview("list_agent_skills", { agentId });
  return wrap(invoke<AgentSkillInventory>("list_agent_skills", { agentId }));
}

export async function openAgentSkillsFolder(agentId: AgentId): Promise<void> {
  if (!desktop()) return preview("open_agent_skills_folder", { agentId });
  return wrap(invoke<void>("open_agent_skills_folder", { agentId }));
}

export async function readLibrarySkillDocument(skillId: string): Promise<LibrarySkillDocument> {
  if (!desktop()) return preview("read_library_skill_document", { skillId });
  return wrap(invoke<LibrarySkillDocument>("read_library_skill_document", { skillId }));
}

export async function exportTroubleshootingReport(): Promise<TroubleshootingReport> {
  if (!desktop()) return preview("export_troubleshooting_report");
  return wrap(invoke<TroubleshootingReport>("export_troubleshooting_report"));
}

/* ---------- events ---------- */

type Unlisten = () => void;

export async function listenDeliveryStatus(handler: (status: DeliveryJobStatus) => void): Promise<Unlisten> {
  if (!desktop()) {
    const onEvent = (event: Event) => {
      const detail = (event as CustomEvent<DeliveryJobStatus>).detail;
      if (detail) handler(detail);
    };
    window.addEventListener(PREVIEW_DELIVERY_EVENT, onEvent);
    return () => window.removeEventListener(PREVIEW_DELIVERY_EVENT, onEvent);
  }
  try {
    const { listen } = await import("@tauri-apps/api/event");
    return await listen<DeliveryJobStatus>(DELIVERY_STATUS_EVENT, event => handler(event.payload));
  } catch {
    return () => undefined;
  }
}

export async function listenSkillSourceDropped(handler: (event: SkillSourceDroppedEvent) => void): Promise<Unlisten> {
  if (!desktop()) return () => undefined;
  try {
    const { listen } = await import("@tauri-apps/api/event");
    return await listen<SkillSourceDroppedEvent>(SKILL_SOURCE_DROPPED_EVENT, event => handler(event.payload));
  } catch {
    return () => undefined;
  }
}

async function listenImportProgress(operationId: string, handler?: (event: ImportProgress) => void): Promise<Unlisten> {
  if (!handler) return () => undefined;
  if (!desktop()) {
    const onEvent = (event: Event) => {
      const detail = (event as CustomEvent<ImportProgress>).detail;
      if (detail?.operationId === operationId) handler(detail);
    };
    window.addEventListener(PREVIEW_IMPORT_PROGRESS_EVENT, onEvent);
    return () => window.removeEventListener(PREVIEW_IMPORT_PROGRESS_EVENT, onEvent);
  }
  try {
    const { listen } = await import("@tauri-apps/api/event");
    return await listen<ImportProgress>(SOURCE_IMPORT_PROGRESS_EVENT, event => {
      if (event.payload.operationId === operationId) handler(event.payload);
    });
  } catch {
    return () => undefined;
  }
}
