// MCP page (contract §6): header, two tabs (我的 MCP / 发现), search + issue strip, then the matrix.
// Everyday toggles write directly and offer Undo; confirmations appear only for the I6 cases the
// backend reports. Opening this page reads one snapshot and starts no process (I1).
//
// Shell integration (for App.tsx / the "+ 添加" hand-off):
//   <McpCenter runtimeAvailable={…} takePendingPaste={takePendingMcpPaste} />
// - `takePendingPaste` is called once on mount and again whenever the window event
//   "ai-skillhub-open-mcp-add" fires; a non-empty result opens the add sheet with that text.
// - `initialPaste` does the same for a value the shell already holds.
// The text stays in memory only (never sessionStorage/localStorage): it may contain API keys.
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  McpAddRequest,
  McpCell,
  McpClient,
  McpClientId,
  McpConfirmation,
  McpError,
  McpErrorCode,
  McpHistoryEntry,
  McpImportReport,
  McpIssue,
  McpLibrarySnapshot,
  McpScope,
  McpServerRow,
  McpSetSecretRequest,
  McpTemplateId,
  McpTestPreview,
  McpTestProgressEvent,
  McpUpdateRequest,
  McpWriteOutcome
} from "./mcpTypes";
import { copyText, isDesktop, mcpApi, openExternalUrl, toMcpError } from "./mcpApi";
import {
  cellFor,
  cellIntent,
  clientLabel,
  clientNames,
  errorText,
  filterServers,
  issueText,
  outcomeToast,
  rememberAck,
  sortIssues,
  testAckKey,
  testFailureText,
  testText
} from "./mcpLogic";
import { McpMatrix, pendingKey } from "./McpMatrix";
import { McpAddSheet } from "./McpAddSheet";
import type { AddSubmitResult } from "./McpAddSheet";
import { McpEditDrawer } from "./McpEditDrawer";
import { McpHistoryDrawer } from "./McpHistoryDrawer";
import { McpConfirmDialog } from "./McpConfirmDialog";
import type { ConfirmAnswer } from "./McpConfirmDialog";
import { McpTestDialog } from "./McpTestDialog";
import { McpToastStack, MAX_TOASTS } from "./McpToast";
import type { McpToastAction, McpToastItem } from "./McpToast";
import { Glyph, HelpTip, MenuButton, Overlay, Spinner, t, useNarrow } from "./mcpUi";
import "./mcp.css";

const McpDiscover = lazy(() => import("./McpDiscover"));

export const OPEN_MCP_ADD_EVENT = "ai-skillhub-open-mcp-add";
const TEST_ACK_STORAGE_KEY = "ai-skillhub-mcp-test-ack-v1";
const NARROW_WIDTH = 760;
// Issues that have no cell or chip of their own in the matrix stay visible without expanding.
const PINNED_ISSUES = new Set<McpIssue["kind"]>(["stuck-transaction", "client-unwritable", "interrupted"]);

export type McpPageProps = {
  runtimeAvailable?: boolean;
  /** Pasted MCP config handed over by the shell; opens the add sheet with it once. */
  initialPaste?: string | null;
  /** Returns and clears the shell's pending pasted config (e.g. mcpBridge.takePendingMcpPaste). */
  takePendingPaste?: () => string | null;
};

type AddSheetState = { key: number; text?: string; template?: McpTemplateId; github?: string };
type WriteResult = { status: "done"; outcome: McpWriteOutcome } | { status: "cancelled" } | { status: "failed"; error: McpError };
type WriteOptions = {
  pending?: string[];
  silentCodes?: McpErrorCode[];
  quiet?: boolean;
};

// Session-scoped (memory only): the first-run import runs once per app session, and dismissed
// issue lines stay dismissed while the app is open.
let firstRunImportStarted = false;
const dismissedIssues = new Set<string>();

function readAcks(): string[] {
  try {
    const raw = window.localStorage.getItem(TEST_ACK_STORAGE_KEY);
    const value = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function writeAcks(list: string[]) {
  try {
    window.localStorage.setItem(TEST_ACK_STORAGE_KEY, JSON.stringify(list));
  } catch {
    // Per-viewer convenience only; without storage the dialog simply shows again.
  }
}

function initialTab(): "mine" | "discover" {
  try {
    return new URLSearchParams(window.location.search).get("mcpTab") === "discover" ? "discover" : "mine";
  } catch {
    return "mine";
  }
}

function delay(ms: number) {
  return new Promise<void>(resolve => window.setTimeout(resolve, ms));
}

export function McpPage({ runtimeAvailable = isDesktop(), initialPaste, takePendingPaste }: McpPageProps) {
  const preview = !isDesktop();
  const rootRef = useRef<HTMLDivElement>(null);
  const narrow = useNarrow(rootRef, NARROW_WIDTH);

  const [snapshot, setSnapshot] = useState<McpLibrarySnapshot | null>(null);
  const [loadError, setLoadError] = useState("");
  const [tab, setTab] = useState<"mine" | "discover">(initialTab);
  const [query, setQuery] = useState("");
  const [addSheet, setAddSheet] = useState<AddSheetState | null>(null);
  const [editing, setEditing] = useState<{ serverId: string; focus?: "secret" } | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [confirm, setConfirm] = useState<{ confirmation: McpConfirmation; resolve: (answer: ConfirmAnswer | null) => void } | null>(null);
  const [consent, setConsent] = useState<{ row: McpServerRow; clientId: McpClientId } | null>(null);
  const [resolveChange, setResolveChange] = useState<{ row: McpServerRow; clientId: McpClientId } | null>(null);
  const [testDialog, setTestDialog] = useState<{ preview: McpTestPreview; serverName: string } | null>(null);
  const [report, setReport] = useState<McpImportReport | null>(null);
  const [toasts, setToasts] = useState<McpToastItem[]>([]);
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  const [testing, setTesting] = useState<ReadonlyMap<string, McpTestProgressEvent["phase"]>>(() => new Map());
  const [issuesOpen, setIssuesOpen] = useState(false);
  const [dismissTick, setDismissTick] = useState(0);
  const [writing, setWriting] = useState(0);
  const [otherOpen, setOtherOpen] = useState(false);
  const [importing, setImporting] = useState(false);

  const latestGeneration = useRef(0);
  const refreshSeq = useRef(0);
  const dirtyWhileHidden = useRef(false);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const toastId = useRef(0);
  const addKey = useRef(0);
  const mounted = useRef(true);
  const testingRef = useRef(testing);
  testingRef.current = testing;

  // ---------- snapshot ----------
  const refresh = useCallback(async () => {
    const seq = ++refreshSeq.current;
    try {
      const next = await mcpApi.snapshot();
      if (!mounted.current || seq !== refreshSeq.current) return next;
      // Drop snapshots older than one we have already shown (mutation generation guard).
      if (next.generation < latestGeneration.current) return next;
      latestGeneration.current = next.generation;
      setSnapshot(next);
      setLoadError("");
      return next;
    } catch (raw) {
      if (mounted.current && seq === refreshSeq.current) setLoadError(errorText(toMcpError(raw), t));
      return null;
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    let unlistenChanged: (() => void) | null = null;
    let unlistenProgress: (() => void) | null = null;
    let disposed = false;

    void (async () => {
      const first = await refresh();
      if (disposed || !first) return;
      if (!first.libraryInitialized && !firstRunImportStarted) {
        firstRunImportStarted = true;
        try {
          const result = await enqueue(() => mcpApi.importFromClients({ reason: "first-run" }));
          if (!disposed) {
            await refresh();
            // Non-blocking notice: a toast, so the first visit does not push the matrix down.
            pushToast({
              tone: "ok",
              text: result.added.length > 0 ? t("mcp.import.firstRun", { n: result.added.length }) : t("mcp.import.firstRunNone"),
              actions: [{ label: t("mcp.import.view"), run: () => setReport(result) }]
            });
          }
        } catch (raw) {
          firstRunImportStarted = false;
          if (!disposed) pushError(toMcpError(raw));
        }
      }
    })();

    mcpApi.onLibraryChanged(event => {
      if (event.generation <= latestGeneration.current) return;
      if (document.hidden) {
        dirtyWhileHidden.current = true;
        return;
      }
      void refresh();
    }).then(stop => {
      if (disposed) stop();
      else unlistenChanged = stop;
    }).catch(() => undefined);

    mcpApi.onTestProgress(event => {
      if (!testingRef.current.has(event.serverId)) return;
      setTesting(current => new Map(current).set(event.serverId, event.phase));
    }).then(stop => {
      if (disposed) stop();
      else unlistenProgress = stop;
    }).catch(() => undefined);

    function onVisibility() {
      if (!document.hidden && dirtyWhileHidden.current) {
        dirtyWhileHidden.current = false;
        void refresh();
      }
    }
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      disposed = true;
      mounted.current = false;
      unlistenChanged?.();
      unlistenProgress?.();
      document.removeEventListener("visibilitychange", onVisibility);
    };
    // Mount-only wiring.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------- paste hand-off from the shell ----------
  useEffect(() => {
    const handed = (initialPaste ?? "").trim() || (takePendingPaste?.() ?? "").trim();
    if (handed) openAdd({ text: handed });
    function onOpenAdd(event: Event) {
      const fromBridge = takePendingPaste?.() ?? "";
      const detail = (event as CustomEvent<{ text?: string }>).detail;
      const text = (fromBridge || detail?.text || "").trim();
      setTab("mine");
      openAdd(text ? { text } : {});
    }
    window.addEventListener(OPEN_MCP_ADD_EVENT, onOpenAdd);
    return () => window.removeEventListener(OPEN_MCP_ADD_EVENT, onOpenAdd);
    // The hand-off is read once per mount and per event.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------- toasts ----------
  function pushToast(item: Omit<McpToastItem, "id">) {
    toastId.current += 1;
    const next = { ...item, id: toastId.current };
    setToasts(current => [...current, next].slice(-MAX_TOASTS));
  }

  function dismissToast(id: number) {
    setToasts(current => current.filter(item => item.id !== id));
  }

  function previewSuffix(text: string) {
    return preview ? `${text}${t("mcp.preview.suffix")}` : text;
  }

  function pushError(error: McpError, actions: McpToastAction[] = []) {
    const extra = [...actions];
    if (["config-jsonc", "config-parse-failed", "config-too-large", "codex-structured-env", "undo-conflict"].includes(error.code) && error.clientId) {
      const clientId = error.clientId;
      extra.push({ label: t("mcp.col.openLocation"), run: () => void openLocation(clientId) });
    }
    pushToast({ tone: "error", text: errorText(error, t, snapshot?.clients), actions: extra });
  }

  // ---------- write queue ----------
  function enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = queue.current.then(job, job);
    queue.current = run.catch(() => undefined);
    return run;
  }

  async function withBusyRetry<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (raw) {
      const error = toMcpError(raw);
      if (error.code !== "busy") throw error;
      await delay(1000);
      return call();
    }
  }

  function askConfirm(confirmation: McpConfirmation): Promise<ConfirmAnswer | null> {
    return new Promise(resolve => setConfirm({ confirmation, resolve }));
  }

  function markPending(keys: string[], on: boolean) {
    if (keys.length === 0) return;
    setPending(current => {
      const next = new Set(current);
      for (const key of keys) {
        if (on) next.add(key);
        else next.delete(key);
      }
      return next;
    });
  }

  function runWrite(attempt: (answer?: ConfirmAnswer) => Promise<McpWriteOutcome>, options: WriteOptions = {}): Promise<WriteResult> {
    const keys = options.pending ?? [];
    markPending(keys, true);
    setWriting(count => count + 1);
    return enqueue(async (): Promise<WriteResult> => {
      try {
        let answer: ConfirmAnswer | undefined;
        for (let round = 0; round < 3; round += 1) {
          const outcome = await withBusyRetry(() => attempt(answer));
          if (outcome.kind === "needs-confirmation") {
            const next = await askConfirm(outcome.confirmation);
            if (!next) return { status: "cancelled" };
            answer = next;
            continue;
          }
          await refresh();
          if (outcome.kind === "done" && !options.quiet) showOutcome(outcome);
          return { status: "done", outcome };
        }
        return { status: "cancelled" };
      } catch (raw) {
        const error = toMcpError(raw);
        if (!options.silentCodes?.includes(error.code)) pushError(error);
        await refresh();
        return { status: "failed", error };
      } finally {
        markPending(keys, false);
        setWriting(count => Math.max(0, count - 1));
      }
    });
  }

  function toSubmitResult(result: WriteResult): AddSubmitResult {
    if (result.status === "done") return { status: "done" };
    if (result.status === "failed") return { status: "failed", error: result.error };
    return { status: "cancelled" };
  }

  function showOutcome(outcome: Extract<McpWriteOutcome, { kind: "done" }>) {
    const clients = snapshot?.clients ?? null;
    const toast = outcomeToast(outcome, t, clients);
    const { summary } = outcome;
    let text = toast.text;
    if (toast.tone === "ok" && summary.kind === "add" && summary.clientIds.length === 0) text = t("mcp.toast.add.noClient", { servers: summary.serverNames.join(t("mcp.list.sep")) });
    const actions: McpToastAction[] = [];
    const desired = !(summary.kind === "disable" || summary.kind === "remove");
    for (const failed of outcome.results.filter(item => item.status === "failed")) {
      const clientId = failed.clientId;
      const serverIds = failed.serverIds;
      actions.push({
        label: t("mcp.toast.retryClient", { client: clientLabel(clientId, clients) }),
        run: () => {
          for (const serverId of serverIds) void setCell(serverId, clientId, desired);
        }
      });
    }
    if (outcome.undoToken && summary.kind !== "undo" && summary.kind !== "rollback" && summary.kind !== "import") {
      const token = outcome.undoToken;
      actions.push({ label: t("mcp.toast.undoAction"), primary: actions.length === 0, run: () => void undo(token) });
    }
    if (summary.kind === "add" && summary.serverNames.length === 1 && toast.tone !== "error") {
      const name = summary.serverNames[0];
      actions.push({
        label: t("mcp.row.test"),
        run: () => {
          const row = latestSnapshot.current?.servers.find(item => item.name === name);
          if (row) void startTest(row.id);
        }
      });
    }
    const detail = toast.restartClients.length > 0 ? t("mcp.toast.restart", { clients: clientNames(toast.restartClients, t, clients) }) : undefined;
    pushToast({ tone: toast.tone, text: previewSuffix(text), detail, actions });
  }

  const latestSnapshot = useRef(snapshot);
  latestSnapshot.current = snapshot;

  // ---------- actions ----------
  function setCell(serverId: string, clientId: McpClientId, enabled: boolean, allowInline?: boolean) {
    return runWrite(answer => mcpApi.setCell({ serverId, clientId, enabled, allowInline, confirmToken: answer?.token }), {
      pending: [pendingKey(serverId, clientId)]
    });
  }

  async function undo(undoToken: string) {
    await runWrite(() => mcpApi.undo(undoToken));
  }

  const onCell = useCallback((row: McpServerRow, client: McpClient, cell: McpCell) => {
    const intent = cellIntent(cell);
    if (intent.kind === "toggle" || intent.kind === "retry") void setCell(row.id, client.id, intent.enabled);
    else if (intent.kind === "consent") setConsent({ row, clientId: client.id });
    else if (intent.kind === "resolve") setResolveChange({ row, clientId: client.id });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot]);

  function onColumn(clientId: McpClientId, enabled: boolean, serverIds?: string[]) {
    const rows = snapshot?.servers ?? [];
    const affected = rows.filter(row => {
      if (serverIds && !serverIds.includes(row.id)) return false;
      const cell = cellFor(row, clientId);
      return enabled ? cell?.state === "off" : cell?.state === "on";
    });
    void runWrite(answer => mcpApi.setColumn({ clientId, enabled, serverIds, confirmToken: answer?.token }), {
      pending: affected.map(row => pendingKey(row.id, clientId))
    });
  }

  function onRowAll(row: McpServerRow, enabled: boolean) {
    const keys = row.cells.filter(cell => cell.state !== "unsupported" && cell.state !== "readonly").map(cell => pendingKey(row.id, cell.clientId));
    void runWrite(answer => mcpApi.setRow({ serverId: row.id, enabled, confirmToken: answer?.token }), { pending: keys });
  }

  async function deleteServer(serverId: string) {
    const result = await runWrite(answer =>
      mcpApi.removeServer({ serverId, from: { kind: "library" }, deleteEnvVars: answer?.deleteEnvVars.length ? answer.deleteEnvVars : undefined, confirmToken: answer?.token })
    );
    if (result.status === "done") setEditing(current => (current?.serverId === serverId ? null : current));
  }

  function removeFromClient(serverId: string, clientId: McpClientId) {
    void runWrite(answer => mcpApi.removeServer({ serverId, from: { kind: "client", clientId }, confirmToken: answer?.token }), {
      pending: [pendingKey(serverId, clientId)]
    });
  }

  async function openLocation(clientId: McpClientId, scope?: McpScope, workspaceId?: string) {
    if (preview) {
      const path = snapshot?.clients.find(item => item.id === clientId)?.configPathDisplay ?? "";
      pushToast({ tone: "info", text: t("mcp.preview.openLocation", { path }), actions: [] });
      return;
    }
    try {
      await mcpApi.openConfigLocation({ clientId, scope, workspaceId });
    } catch (raw) {
      pushError(toMcpError(raw));
    }
  }

  async function openUrl(url: string) {
    if (!url) return;
    const opened = await openExternalUrl(url);
    if (opened) return;
    const copied = await copyText(url);
    pushToast({ tone: copied ? "info" : "warn", text: copied ? t("mcp.toast.linkCopied", { url }) : t("mcp.toast.linkManual", { url }), actions: [] });
  }

  async function copyJson(serverIds?: string[]) {
    try {
      const result = await mcpApi.exportJson({ serverIds, format: "mcp-servers" });
      const copied = await copyText(result.text);
      // Bug MCP#13: a clipboard failure is a local warning, never a "scan failed" banner.
      pushToast(copied
        ? { tone: "ok", text: t("mcp.toast.copied", { n: result.maskedSecretCount }), actions: [] }
        : { tone: "warn", text: t("mcp.toast.copyFailed"), actions: [] });
    } catch (raw) {
      pushError(toMcpError(raw));
    }
  }

  async function runImport() {
    setImporting(true);
    try {
      const result = await enqueue(() => withBusyRetry(() => mcpApi.importFromClients({ reason: "user" })));
      setReport(result);
      await refresh();
    } catch (raw) {
      pushError(toMcpError(raw));
    } finally {
      setImporting(false);
    }
  }

  function resync(clientIds?: McpClientId[], serverIds?: string[]) {
    const keys = (snapshot?.servers ?? [])
      .filter(row => !serverIds || serverIds.includes(row.id))
      .flatMap(row => row.cells.filter(cell => (!clientIds || clientIds.includes(cell.clientId)) && (cell.windowsFixAvailable || cell.outOfDate || cell.state === "changed-outside")).map(cell => pendingKey(row.id, cell.clientId)));
    void runWrite(answer => mcpApi.resync({ clientIds, serverIds, confirmToken: answer?.token }), { pending: keys });
  }

  async function rollbackEntry(entry: McpHistoryEntry) {
    await runWrite(answer =>
      mcpApi.rollback(entry.kind === "legacy" && entry.legacySnapshotId
        ? { legacySnapshotId: entry.legacySnapshotId, confirmToken: answer?.token }
        : { operationId: entry.operationId, confirmToken: answer?.token })
    );
  }

  // ---------- test connection (contract §6.6) ----------
  async function startTest(serverId: string) {
    const row = latestSnapshot.current?.servers.find(item => item.id === serverId);
    if (!row || testingRef.current.has(serverId)) return;
    try {
      const testPreview = await mcpApi.testPreview(serverId);
      const acknowledged = readAcks().includes(testAckKey(serverId, testPreview.specRevision));
      const blocked = (testPreview.runner !== null && !testPreview.runner.found) || testPreview.missingSecrets.length > 0;
      if (!acknowledged || blocked) {
        setTestDialog({ preview: testPreview, serverName: row.name });
        return;
      }
      await runTest(testPreview, row.name);
    } catch (raw) {
      pushError(toMcpError(raw));
    }
  }

  async function runTest(testPreview: McpTestPreview, serverName: string) {
    const serverId = testPreview.serverId;
    writeAcks(rememberAck(readAcks(), testAckKey(serverId, testPreview.specRevision)));
    setTesting(current => new Map(current).set(serverId, "resolving"));
    try {
      const result = await mcpApi.testServer({ serverId, previewToken: testPreview.previewToken });
      if (result.status === "stale-preview") {
        const fresh = await mcpApi.testPreview(serverId);
        setTestDialog({ preview: fresh, serverName });
        return;
      }
      const summary = { status: result.status, toolsCount: result.toolsCount, testedAt: result.testedAt, stale: false, messageCode: result.messageCode };
      const runner = testPreview.runner?.name ?? null;
      const text = result.status === "failed" ? testFailureText(result.messageCode, t, runner) : testText(summary, t, 0, runner);
      const actions: McpToastAction[] = [];
      if (result.status === "needs-secret") actions.push({ label: t("mcp.row.fill"), run: () => setEditing({ serverId, focus: "secret" }) });
      pushToast({
        tone: result.status === "ok" ? "ok" : result.status === "needs-secret" || result.status === "unsupported" ? "warn" : "error",
        text: t("mcp.test.toast", { name: serverName, result: text }),
        actions
      });
    } catch (raw) {
      pushError(toMcpError(raw));
    } finally {
      setTesting(current => {
        const next = new Map(current);
        next.delete(serverId);
        return next;
      });
      void refresh();
    }
  }

  // ---------- add / edit submit ----------
  function openAdd(state: Omit<AddSheetState, "key">) {
    addKey.current += 1;
    setAddSheet({ key: addKey.current, ...state });
  }

  async function submitAdd(request: McpAddRequest): Promise<AddSubmitResult> {
    const result = await runWrite(answer => mcpApi.addServers({ ...request, confirmToken: answer?.token }), { silentCodes: ["paste-expired"] });
    return toSubmitResult(result);
  }

  async function submitUpdate(request: McpUpdateRequest): Promise<AddSubmitResult> {
    const result = await runWrite(answer => mcpApi.updateServer({ ...request, confirmToken: answer?.token }), { silentCodes: ["revision-conflict"] });
    return toSubmitResult(result);
  }

  async function submitSecret(request: McpSetSecretRequest): Promise<AddSubmitResult> {
    const result = await runWrite(answer => mcpApi.setSecret({ ...request, confirmToken: answer?.token }));
    return toSubmitResult(result);
  }

  // ---------- issues ----------
  function runIssue(issue: McpIssue) {
    const row = snapshot?.servers.find(item => item.id === issue.serverId);
    switch (issue.action) {
      case "retry": {
        if (!row || !issue.clientId) return;
        const cell = cellFor(row, issue.clientId);
        if (cell) {
          const intent = cellIntent(cell);
          if (intent.kind === "toggle" || intent.kind === "retry") void setCell(row.id, issue.clientId, intent.enabled);
        }
        return;
      }
      case "open-file-location":
        if (issue.clientId) void openLocation(issue.clientId);
        return;
      case "fill-secret":
        if (issue.serverId) setEditing({ serverId: issue.serverId, focus: "secret" });
        return;
      case "review-change":
        if (row && issue.clientId) setResolveChange({ row, clientId: issue.clientId });
        return;
      case "import":
        void runImport();
        return;
      case "resolve-stuck": {
        const stuck = snapshot?.stuckTransactions.find(item => item.clientId === (issue.clientId ?? null)) ?? snapshot?.stuckTransactions[0];
        if (stuck) void runWrite(() => mcpApi.resolveStuck({ snapshotId: stuck.snapshotId, action: "keep-current" }));
        return;
      }
      case "allow-inline":
        if (row && issue.clientId) setConsent({ row, clientId: issue.clientId });
        return;
      case "resync":
        resync(issue.clientId ? [issue.clientId] : undefined, issue.serverId ? [issue.serverId] : undefined);
        return;
      default:
        return;
    }
  }

  // ---------- derived ----------
  const columns = useMemo(() => (snapshot?.clients ?? []).filter(client => client.detected || client.enabledCount > 0), [snapshot]);
  const rows = useMemo(() => filterServers(snapshot?.servers ?? [], query), [snapshot, query]);
  const issues = useMemo(() => {
    void dismissTick;
    return snapshot ? sortIssues(snapshot.issues).filter(issue => !dismissedIssues.has(issue.id)) : [];
  }, [snapshot, dismissTick]);
  const pinnedIssues = issues.filter(issue => PINNED_ISSUES.has(issue.kind));
  const dismissIssue = (issue: McpIssue) => {
    dismissedIssues.add(issue.id);
    setDismissTick(value => value + 1);
  };
  const searchActive = query.trim().length > 0;
  const editingRow = editing ? snapshot?.servers.find(row => row.id === editing.serverId) : undefined;

  useEffect(() => {
    if (editing && snapshot && !editingRow) setEditing(null);
  }, [editing, editingRow, snapshot]);

  const handlers = {
    onCell,
    onColumn,
    onOpenLocation: (clientId: McpClientId) => void openLocation(clientId),
    onRowAll,
    onEdit: (row: McpServerRow, focus?: "secret") => setEditing({ serverId: row.id, focus }),
    onTest: (row: McpServerRow) => void startTest(row.id),
    onCopyJson: (row: McpServerRow) => void copyJson([row.id]),
    onDelete: (row: McpServerRow) => void deleteServer(row.id)
  };

  const headerMenu = () => [
    { kind: "action" as const, icon: "copy" as const, label: t("mcp.header.copyAll"), onSelect: () => void copyJson() },
    { kind: "action" as const, icon: "refresh" as const, label: t("mcp.header.resync"), disabled: !snapshot || snapshot.servers.length === 0, onSelect: () => resync() },
    { kind: "separator" as const },
    { kind: "action" as const, icon: "history" as const, label: t("mcp.header.history"), onSelect: () => setHistoryOpen(true) }
  ];

  const consentRow = consent ? snapshot?.servers.find(row => row.id === consent.row.id) ?? consent.row : null;
  const consentNames = consentRow ? consentRow.secrets.map(secret => secret.envVar ?? secret.name).join(t("mcp.list.sep")) : "";

  return (
    <div aria-busy={!snapshot && !loadError} className={`view mcp-page${narrow ? " is-narrow" : ""}`} ref={rootRef}>
      <header className="mcp-head">
        <div className="mcp-title">
          <h1>{t("mcp.page.title")}</h1>
          <HelpTip label={t("mcp.help.label")}>
            <strong>{t("mcp.help.title")}</strong>
            <span>{t("mcp.help.what")}</span>
            <span>{t("mcp.help.safety")}</span>
            <span>{t("mcp.help.secrets")}</span>
            <span>{t("mcp.help.undo")}</span>
          </HelpTip>
          <div aria-label={t("mcp.tabs.label")} className="mcp-tabs" role="tablist">
            <button aria-controls="mcp-panel-mine" aria-selected={tab === "mine"} className={tab === "mine" ? "active" : ""} id="mcp-tab-mine" onClick={() => setTab("mine")} role="tab" type="button">
              {t("mcp.tabs.mine")}
            </button>
            <button aria-controls="mcp-panel-discover" aria-selected={tab === "discover"} className={tab === "discover" ? "active" : ""} id="mcp-tab-discover" onClick={() => setTab("discover")} role="tab" type="button">
              {t("mcp.tabs.discover")}
            </button>
          </div>
          {preview && <span className="mcp-tag" title={t("mcp.preview.note")}>{t("mcp.preview.badge")}</span>}
        </div>
        {tab === "mine" && snapshot && (
          <p className="mcp-summary">
            <span className="mcp-summary-counts">
              {t("mcp.summary.servers", { n: snapshot.servers.length })}
              <span aria-hidden="true"> · </span>
              {t("mcp.summary.clients", { n: columns.length })}
            </span>
            {issues.length > 0 && (
              <button aria-controls="mcp-issue-list" aria-expanded={issuesOpen} className="mcp-issue-count" onClick={() => setIssuesOpen(value => !value)} type="button">
                <Glyph name="warn" /> {t("mcp.summary.issues", { n: issues.length })}
                <Glyph className={issuesOpen ? "open" : ""} name="chevron" />
              </button>
            )}
          </p>
        )}
        <div className="mcp-head-actions">
          {tab === "mine" && (
            <label className="mcp-search">
              <Glyph name="search" />
              <span className="sr-only">{t("mcp.search.label")}</span>
              <input
                onChange={event => setQuery(event.target.value)}
                onKeyDown={event => {
                  if (event.key === "Escape" && query) {
                    event.stopPropagation();
                    setQuery("");
                  }
                }}
                placeholder={t("mcp.search.placeholder")}
                type="search"
                value={query}
              />
            </label>
          )}
          <button className="mcp-btn quiet mcp-import-button" disabled={importing} onClick={() => void runImport()} title={t("mcp.header.import")} type="button">
            {importing ? <Spinner /> : <Glyph name="import" />} <span className="mcp-btn-text">{t("mcp.header.import")}</span>
          </button>
          <button className="mcp-btn solid" onClick={() => {
            setTab("mine");
            openAdd({});
          }} type="button">
            <Glyph name="plus" /> {t("mcp.header.add")}
          </button>
          <MenuButton items={headerMenu} label={t("mcp.header.more")} title={t("mcp.header.more")}>
            <Glyph name="more" />
          </MenuButton>
        </div>
      </header>

      {tab === "mine" ? (
        <section aria-labelledby="mcp-tab-mine" className="mcp-panel" id="mcp-panel-mine" role="tabpanel">
          {/* Issues are also visible in place (cell states, the key chip). The strip lists them on demand;
              the few that have no cell of their own stay pinned so they are never missed. */}
          {snapshot && (issuesOpen ? issues : pinnedIssues).length > 0 && (
            <ul aria-label={t("mcp.issues.label")} className="mcp-issues" id="mcp-issue-list">
              {(issuesOpen ? issues : pinnedIssues).map(issue => (
                <IssueLine issue={issue} key={issue.id} onAction={runIssue} onDismiss={dismissIssue} snapshot={snapshot} />
              ))}
            </ul>
          )}

          {loadError && (
            <div className="mcp-callout error" role="alert">
              <Glyph name="warn" />
              <span>{t("mcp.load.failed")} {loadError}</span>
              <button className="mcp-btn small quiet" onClick={() => void refresh()} type="button">{t("mcp.load.retry")}</button>
            </div>
          )}

          {!snapshot && !loadError && (
            <div aria-label={t("mcp.load.loading")} className="mcp-skeleton">
              {[0, 1, 2, 3].map(index => <span key={index} />)}
            </div>
          )}

          {snapshot && snapshot.servers.length === 0 && (
            <div className="mcp-empty">
              <div aria-hidden="true" className="mcp-empty-mark"><Glyph name="plus" /></div>
              <h2>{t("mcp.empty.title")}</h2>
              <p>{t("mcp.empty.body")}</p>
              <div className="mcp-empty-actions">
                <button className="mcp-btn quiet" disabled={importing} onClick={() => void runImport()} type="button"><Glyph name="import" /> {t("mcp.header.import")}</button>
                <button className="mcp-btn solid" onClick={() => openAdd({})} type="button"><Glyph name="plus" /> {t("mcp.header.add")}</button>
              </div>
            </div>
          )}

          {snapshot && snapshot.servers.length > 0 && rows.length === 0 && (
            <p className="mcp-empty-line">
              {t("mcp.search.none", { q: query.trim() })}
              <button className="mcp-link" onClick={() => setQuery("")} type="button">{t("mcp.search.clear")}</button>
            </p>
          )}

          {snapshot && rows.length > 0 && (
            <McpMatrix
              busy={false}
              columns={columns}
              narrow={narrow}
              pending={pending}
              rows={rows}
              searchActive={searchActive}
              testing={testing}
              totalRows={snapshot.servers.length}
              {...handlers}
            />
          )}

          {snapshot && snapshot.otherClients.length > 0 && (
            <div className="mcp-other-clients">
              <button aria-expanded={otherOpen} className="mcp-link" onClick={() => setOtherOpen(value => !value)} type="button">
                {t("mcp.other.title", { n: snapshot.otherClients.length })}
                <Glyph className={otherOpen ? "open" : ""} name="chevron" />
              </button>
              {otherOpen && (
                <p className="mcp-muted small">{snapshot.otherClients.map(item => item.label).join(t("mcp.list.sep"))} · {t("mcp.other.body")}</p>
              )}
            </div>
          )}
          {writing > 0 && <span className="sr-only" role="status">{t("mcp.status.writing")}</span>}
        </section>
      ) : (
        <section aria-labelledby="mcp-tab-discover" className="mcp-panel" id="mcp-panel-discover" role="tabpanel">
          <Suspense fallback={<p className="mcp-muted"><Spinner /> {t("mcp.discover.loading")}</p>}>
            <McpDiscover
              onAdd={async request => toSubmitResult(await runWrite(answer => mcpApi.addServers({ ...request, confirmToken: answer?.token })))}
              onAddTemplate={id => openAdd({ template: id })}
              onGithub={source => openAdd({ github: source })}
              onOpenUrl={url => void openUrl(url)}
              runtimeAvailable={runtimeAvailable}
              snapshot={snapshot}
            />
          </Suspense>
        </section>
      )}

      {addSheet && snapshot && (
        <McpAddSheet
          initialGithub={addSheet.github}
          initialTemplate={addSheet.template}
          initialText={addSheet.text}
          key={addSheet.key}
          onClose={() => setAddSheet(null)}
          onOpenDiscover={() => {
            setAddSheet(null);
            setTab("discover");
          }}
          onOpenUrl={url => void openUrl(url)}
          onSubmit={submitAdd}
          preview={preview}
          snapshot={snapshot}
        />
      )}

      {editing && snapshot && editingRow && (
        <McpEditDrawer
          focus={editing.focus}
          key={editing.serverId}
          onCell={onCell}
          onClose={() => setEditing(null)}
          onDelete={serverId => void deleteServer(serverId)}
          onOpenLocation={(clientId, scope, workspaceId) => void openLocation(clientId, scope, workspaceId)}
          onOpenUrl={url => void openUrl(url)}
          onRemoveFromClient={removeFromClient}
          onSave={submitUpdate}
          onSetSecret={submitSecret}
          onTest={serverId => void startTest(serverId)}
          pending={pending}
          serverId={editing.serverId}
          snapshot={snapshot}
        />
      )}

      {historyOpen && (
        <McpHistoryDrawer
          clients={snapshot?.clients ?? []}
          generation={snapshot?.generation ?? 0}
          onClose={() => setHistoryOpen(false)}
          onRollback={rollbackEntry}
        />
      )}

      {consent && consentRow && (
        <Overlay label={t("mcp.consent.title", { client: clientLabel(consent.clientId, snapshot?.clients) })} onClose={() => setConsent(null)} variant="dialog">
          <div className="mcp-dialog-body">
            <div aria-hidden="true" className="mcp-dialog-icon warn"><Glyph name="unlock" /></div>
            <h2>{t("mcp.consent.title", { client: clientLabel(consent.clientId, snapshot?.clients) })}</h2>
            <p>{t("mcp.consent.body", { client: clientLabel(consent.clientId, snapshot?.clients), names: consentNames || t("mcp.word.apiKey") })}</p>
          </div>
          <footer className="mcp-dialog-foot">
            <button className="mcp-btn quiet" onClick={() => setConsent(null)} type="button">{t("mcp.common.cancel")}</button>
            <button className="mcp-btn solid" onClick={() => {
              const target = consent;
              setConsent(null);
              void setCell(target.row.id, target.clientId, true, true);
            }} type="button">{t("mcp.confirm.verb.write")}</button>
          </footer>
        </Overlay>
      )}

      {resolveChange && (
        <Overlay label={t("mcp.resolve.title", { server: resolveChange.row.name, client: clientLabel(resolveChange.clientId, snapshot?.clients) })} onClose={() => setResolveChange(null)} variant="dialog">
          <div className="mcp-dialog-body">
            <div aria-hidden="true" className="mcp-dialog-icon warn"><Glyph name="flag" /></div>
            <h2>{t("mcp.resolve.title", { server: resolveChange.row.name, client: clientLabel(resolveChange.clientId, snapshot?.clients) })}</h2>
            <p>{t("mcp.resolve.body", { client: clientLabel(resolveChange.clientId, snapshot?.clients) })}</p>
          </div>
          <footer className="mcp-dialog-foot stack">
            <button className="mcp-btn quiet" onClick={() => setResolveChange(null)} type="button">{t("mcp.common.cancel")}</button>
            <button className="mcp-btn quiet" onClick={() => void openLocation(resolveChange.clientId)} type="button"><Glyph name="folder" /> {t("mcp.col.openLocation")}</button>
            <button className="mcp-btn quiet" onClick={() => {
              const target = resolveChange;
              setResolveChange(null);
              void runWrite(answer => mcpApi.resolveChange({ serverId: target.row.id, clientId: target.clientId, take: "file", confirmToken: answer?.token }), { pending: [pendingKey(target.row.id, target.clientId)] });
            }} type="button">{t("mcp.resolve.takeFile")}</button>
            <button className="mcp-btn solid" onClick={() => {
              const target = resolveChange;
              setResolveChange(null);
              void runWrite(answer => mcpApi.resolveChange({ serverId: target.row.id, clientId: target.clientId, take: "library", confirmToken: answer?.token }), { pending: [pendingKey(target.row.id, target.clientId)] });
            }} type="button">{t("mcp.resolve.takeLibrary")}</button>
          </footer>
        </Overlay>
      )}

      {testDialog && (
        <McpTestDialog
          onCancel={() => setTestDialog(null)}
          onFillSecret={() => {
            const serverId = testDialog.preview.serverId;
            setTestDialog(null);
            setEditing({ serverId, focus: "secret" });
          }}
          onOpenGuide={url => void openUrl(url)}
          onRun={() => {
            const current = testDialog;
            setTestDialog(null);
            void runTest(current.preview, current.serverName);
          }}
          preview={testDialog.preview}
          serverName={testDialog.serverName}
        />
      )}

      {report && <ImportReportDialog clients={snapshot?.clients ?? []} onClose={() => setReport(null)} report={report} />}

      {confirm && snapshot && (
        <McpConfirmDialog
          clients={snapshot.clients}
          confirmation={confirm.confirmation}
          onAnswer={answer => {
            const current = confirm;
            setConfirm(null);
            current.resolve(answer);
          }}
        />
      )}

      <McpToastStack items={toasts} onDismiss={dismissToast} />
    </div>
  );
}

/** One issue with exactly one action (S1-9) and a per-session dismiss. `inline` renders it in the status line. */
function IssueLine({
  issue,
  snapshot,
  inline = false,
  onAction,
  onDismiss
}: {
  issue: McpIssue;
  snapshot: McpLibrarySnapshot;
  inline?: boolean;
  onAction: (issue: McpIssue) => void;
  onDismiss: (issue: McpIssue) => void;
}) {
  const Tag = inline ? "div" : "li";
  const text = issueText(issue, snapshot, t);
  return (
    <Tag className={`mcp-issue kind-${issue.kind}${inline ? " inline" : ""}`}>
      <Glyph name={issue.kind === "missing-secret" ? "key" : issue.kind === "windows-fix" || issue.kind === "out-of-date" ? "refresh" : "warn"} />
      <span className="mcp-issue-text" title={text}>{text}</span>
      {issue.action !== "none" && (
        <button className="mcp-btn small quiet" onClick={() => onAction(issue)} type="button">{t(`mcp.issue.action.${issue.action}`)}</button>
      )}
      <button aria-label={t("mcp.issues.dismiss")} className="mcp-icon-button small" onClick={() => onDismiss(issue)} title={t("mcp.issues.dismiss")} type="button">
        <Glyph name="close" />
      </button>
    </Tag>
  );
}

function ImportReportDialog({ report, clients, onClose }: { report: McpImportReport; clients: readonly McpClient[]; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const label = (id: McpClientId) => clientLabel(id, clients);
  return (
    <Overlay initialFocus={closeRef} label={t("mcp.import.title")} onClose={onClose} variant="dialog">
      <div className="mcp-dialog-body">
        <div aria-hidden="true" className="mcp-dialog-icon"><Glyph name="import" /></div>
        <h2>{t("mcp.import.title")}</h2>
        <p className="mcp-muted">{t("mcp.import.readOnly")}</p>
        <ul className="mcp-report">
          <li>
            {report.added.length > 0
              ? t("mcp.import.added", { n: report.added.length, names: report.added.join(t("mcp.list.sep")) })
              : t("mcp.import.noneNew")}
          </li>
          {report.merged.length > 0 && <li>{t("mcp.import.merged", { names: report.merged.map(item => item.name).join(t("mcp.list.sep")) })}</li>}
          {report.differing.length > 0 && (
            <li className="warn">{t("mcp.import.differing", { names: report.differing.map(item => `${item.name}（${item.clientIds.map(label).join(t("mcp.list.sep"))}）`).join(t("mcp.list.sep")) })}</li>
          )}
          {report.skipped.length > 0 && (
            <li className="warn">
              {t("mcp.import.skipped", { n: report.skipped.length })}
              <ul>
                {report.skipped.map((item, index) => (
                  <li key={`${item.name}-${index}`}>{item.name} · {label(item.clientId)} · {t(`mcp.skip.${item.reason}`)}</li>
                ))}
              </ul>
            </li>
          )}
        </ul>
        <details className="mcp-files-read">
          <summary>{t("mcp.import.filesRead")}</summary>
          <ul>
            {report.filesRead.map((file, index) => (
              <li key={`${file.clientId}-${file.pathDisplay}-${index}`}>
                <strong>{label(file.clientId)}</strong>
                <code>{file.pathDisplay}</code>
                <span className={`mcp-tag${file.status === "ok" || file.status === "missing" ? "" : " warn"}`}>{t(`mcp.import.status.${file.status}`, { n: file.servers })}</span>
              </li>
            ))}
          </ul>
        </details>
      </div>
      <footer className="mcp-dialog-foot">
        <button className="mcp-btn solid" onClick={onClose} ref={closeRef} type="button">{t("mcp.common.done")}</button>
      </footer>
    </Overlay>
  );
}
