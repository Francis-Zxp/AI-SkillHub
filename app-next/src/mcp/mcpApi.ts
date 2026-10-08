// The only module under src/mcp that talks to the desktop runtime (contract §3.3, test F1).
// In the browser preview every command is served by the stateful mock in src/mcpPreview.ts,
// reached through preview.ts so the mock never enters the desktop bundle.
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import * as T from "./mcpTypes";

export const isDesktop = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function call<R>(command: T.McpCommand, request: object = {}): Promise<R> {
  if (!isDesktop()) {
    const { previewMcp } = await import("../preview");
    return previewMcp<R>(command, request);
  }
  try {
    return await invoke<R>(command, { request });
  } catch (raw) {
    throw toMcpError(raw);
  }
}

export function toMcpError(raw: unknown): T.McpError {
  if (raw && typeof raw === "object" && "code" in raw && "message" in raw) return raw as T.McpError;
  const message = raw instanceof Error ? raw.message : String(raw ?? "");
  return { code: "engine", message: message.length > 280 ? `${message.slice(0, 277)}…` : message };
}

export function isMcpError(value: unknown): value is T.McpError {
  return Boolean(value) && typeof value === "object" && "code" in (value as object) && "message" in (value as object);
}

export const mcpApi = {
  snapshot:          ()                          => call<T.McpLibrarySnapshot>("mcp_library_snapshot"),
  getServer:         (serverId: string)          => call<T.McpServerDetail>("mcp_get_server", { serverId }),
  templates:         ()                          => call<T.McpTemplate[]>("mcp_list_templates"),
  history:           (r: T.McpHistoryRequest = {}) => call<T.McpHistoryEntry[]>("mcp_history", r),
  importFromClients: (r: T.McpImportRequest)     => call<T.McpImportReport>("mcp_import_from_clients", r),
  setCell:           (r: T.McpSetCellRequest)    => call<T.McpWriteOutcome>("mcp_set_cell", r),
  setColumn:         (r: T.McpSetColumnRequest)  => call<T.McpWriteOutcome>("mcp_set_column", r),
  setRow:            (r: T.McpSetRowRequest)     => call<T.McpWriteOutcome>("mcp_set_row", r),
  parsePaste:        (text: string)              => call<T.McpPasteResult>("mcp_parse_paste", { text }),
  importGithub:      (source: string)            => call<T.McpPasteResult>("mcp_import_github", { source }),
  addServers:        (r: T.McpAddRequest)        => call<T.McpWriteOutcome>("mcp_add_servers", r),
  updateServer:      (r: T.McpUpdateRequest)     => call<T.McpWriteOutcome>("mcp_update_server", r),
  removeServer:      (r: T.McpRemoveRequest)     => call<T.McpWriteOutcome>("mcp_remove_server", r),
  undo:              (undoToken: string)         => call<T.McpWriteOutcome>("mcp_undo", { undoToken }),
  rollback:          (r: T.McpRollbackRequest)   => call<T.McpWriteOutcome>("mcp_rollback", r),
  setSecret:         (r: T.McpSetSecretRequest)  => call<T.McpWriteOutcome>("mcp_set_secret", r),
  testPreview:       (serverId: string)          => call<T.McpTestPreview>("mcp_test_preview", { serverId }),
  testServer:        (r: T.McpTestRequest)       => call<T.McpTestResult>("mcp_test_server", r),
  exportJson:        (r: T.McpExportRequest)     => call<T.McpExportResult>("mcp_export_json", r),
  resync:            (r: T.McpResyncRequest = {}) => call<T.McpWriteOutcome>("mcp_resync", r),
  resolveChange:     (r: T.McpResolveChangeRequest) => call<T.McpWriteOutcome>("mcp_resolve_changed_outside", r),
  resolveStuck:      (r: T.McpResolveStuckRequest)  => call<T.McpWriteOutcome>("mcp_resolve_stuck_transaction", r),
  openConfigLocation:(r: T.McpOpenLocationRequest)  => call<void>("mcp_open_config_location", r),
  onLibraryChanged(cb: (e: T.McpLibraryChangedEvent) => void): Promise<UnlistenFn> {
    return isDesktop()
      ? listen<T.McpLibraryChangedEvent>(T.MCP_LIBRARY_CHANGED_EVENT, e => cb(e.payload))
      : import("../preview").then(m => m.previewMcpSubscribe(cb));
  },
  onTestProgress(cb: (e: T.McpTestProgressEvent) => void): Promise<UnlistenFn> {
    return isDesktop()
      ? listen<T.McpTestProgressEvent>(T.MCP_TEST_PROGRESS_EVENT, e => cb(e.payload))
      : import("../preview").then(m => m.previewMcpTestProgress(cb));
  }
};

/**
 * Opens a documentation or install-guide link in the system browser. Nothing is downloaded or run.
 * Returns false when the desktop opener refused the URL, so the caller can offer to copy it instead.
 */
export async function openExternalUrl(url: string): Promise<boolean> {
  if (!/^https:\/\//i.test(url)) return false;
  try {
    if (isDesktop()) await invoke("plugin:opener|open_url", { url, with: null });
    else window.open(url, "_blank", "noopener,noreferrer");
    return true;
  } catch {
    return false;
  }
}

/** Clipboard writes for display-safe text only (masked exports, commands with masked args, URLs). */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
