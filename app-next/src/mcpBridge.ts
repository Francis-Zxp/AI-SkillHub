// The few places where the Skills shell touches MCP (home metric, onboarding import,
// "+ 添加" hand-off). The MCP page itself is owned by the MCP track (docs/v3.3/mcp-contract.md);
// this bridge only calls its documented commands and never writes MCP files itself.
import { invoke } from "@tauri-apps/api/core";

export type McpSummary = { servers: number; issues: number; unimported: number; initialized: boolean };

/** Dispatched on window when a pasted MCP config should open the MCP add sheet. */
export const OPEN_MCP_ADD_EVENT = "ai-skillhub-open-mcp-add";
const PENDING_TTL_MS = 2 * 60_000;

/**
 * The hand-off text lives in memory only. A pasted MCP config can carry API keys, and WebView2
 * writes sessionStorage and localStorage to disk in the user-data folder (MCP contract D7: no
 * token may be found there). The MCP page takes it once on mount; it expires after two minutes.
 */
let pendingPaste: { text: string; at: number } | null = null;

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
  pendingPaste = { text: text.slice(0, 256 * 1024), at: Date.now() };
  window.dispatchEvent(new CustomEvent(OPEN_MCP_ADD_EVENT, { detail: { text } }));
}

/** For the MCP page (MCP track): the text handed over from 添加 / Ctrl+V, at most once. */
export function takePendingMcpPaste(): string | null {
  const value = pendingPaste && Date.now() - pendingPaste.at < PENDING_TTL_MS ? pendingPaste.text : null;
  pendingPaste = null;
  return value;
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
