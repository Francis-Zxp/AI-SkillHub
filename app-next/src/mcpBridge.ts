// The few places where the Skills shell touches MCP (home metric, onboarding import,
// "+ 添加" hand-off). The MCP page itself is owned by the MCP track (docs/v3.3/mcp-contract.md);
// this bridge only calls its documented commands and never writes MCP files itself.
import { invoke } from "@tauri-apps/api/core";

export type McpSummary = { servers: number; issues: number; unimported: number; initialized: boolean };

/** Dispatched on window when a pasted MCP config should open the MCP add sheet. */
export const OPEN_MCP_ADD_EVENT = "ai-skillhub-open-mcp-add";
/** The MCP page reads (and clears) this once on mount, so a hand-off survives the lazy load. */
export const PENDING_MCP_PASTE_KEY = "ai-skillhub-pending-mcp-paste";

type LooseSnapshot = {
  servers?: unknown[];
  issues?: unknown[];
  unimported?: unknown[];
  libraryInitialized?: boolean;
};

function desktop() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function callMcp<T>(command: string, request: object = {}): Promise<T | null> {
  try {
    if (desktop()) return await invoke<T>(command, { request });
    const module = (await import("./preview")) as unknown as Record<string, unknown>;
    const previewMcp = module.previewMcp;
    if (typeof previewMcp !== "function") return null;
    return await (previewMcp as (cmd: string, req: unknown) => Promise<T>)(command, request);
  } catch {
    return null;
  }
}

/** Read-only summary from mcp_library_snapshot; null when the MCP library is not available. */
export async function getMcpSummary(): Promise<McpSummary | null> {
  const snapshot = await callMcp<LooseSnapshot>("mcp_library_snapshot");
  if (!snapshot || !Array.isArray(snapshot.servers)) return null;
  return {
    servers: snapshot.servers.length,
    issues: Array.isArray(snapshot.issues) ? snapshot.issues.length : 0,
    unimported: Array.isArray(snapshot.unimported) ? snapshot.unimported.length : 0,
    initialized: snapshot.libraryInitialized !== false
  };
}

/** Onboarding "导入它们已有的 N 个 MCP": SQLite only, never writes a client file (MCP contract §1.5). */
export async function importMcpFromClients(reason: "onboarding" | "user"): Promise<boolean> {
  const report = await callMcp<unknown>("mcp_import_from_clients", { reason });
  return report !== null;
}

export function requestOpenMcpAdd(text: string) {
  try {
    window.sessionStorage.setItem(PENDING_MCP_PASTE_KEY, text.slice(0, 256 * 1024));
  } catch {
    // Session storage can be unavailable; the event below still reaches a mounted page.
  }
  window.dispatchEvent(new CustomEvent(OPEN_MCP_ADD_EVENT, { detail: { text } }));
}

/** Same detection as skills contract §4.7 row "mcp-config", used for Ctrl+V outside inputs. */
export function looksLikeMcpConfig(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (/\[mcp_servers\./.test(trimmed)) return true;
  if (!/^[[{]/.test(trimmed)) return false;
  try {
    const value = JSON.parse(trimmed) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    if ("mcpServers" in record || "servers" in record) return true;
    if ("command" in record || "url" in record) return true;
    return Object.values(record).some(entry =>
      Boolean(entry) && typeof entry === "object" && ("command" in (entry as object) || "url" in (entry as object)));
  } catch {
    return false;
  }
}

/** "+ 添加" / Ctrl+V routing (§6.1): MCP configs go to the MCP add flow, everything else to the ImportSheet. */
export function classifyAddInput(text: string): "mcp-config" | "skills" | "empty" {
  if (!text.trim()) return "empty";
  return looksLikeMcpConfig(text) ? "mcp-config" : "skills";
}
