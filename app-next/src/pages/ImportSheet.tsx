// "+ 添加" sheet (skills contract §6.4, S0-1/S0-2). One box: paste an address, owner/repo, a
// /tree/ link, a local folder or a .zip; it checks automatically, shows what is inside, the
// safety result and which AI tools get it, then installs with one click. A flagged source can
// only be added to the library and stays off (I-5). Nothing here runs anything from the source.
import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../icons";
import { t } from "../i18n";
import {
  cancelSourceImport,
  createOperationId,
  discardSkillSourceProbe,
  installSkillSource,
  parseSkillSourceInput,
  pickSkillSourcePath,
  probeSkillSource,
  readSkillSourceProbeFile,
  type ImportProgress
} from "../skillApi";
import { normalizeSkillHubError, redactSecrets, skillHubErrorText } from "../skillErrors";
import type { LibraryRow } from "../skillCounts";
import type {
  AgentId,
  InstallSkillSourceResult,
  ParsedSkillSource,
  ProbeSkillGroup,
  SkillAgent,
  SkillFolderCard,
  SkillHubError,
  SkillSourceProbe
} from "../types";
import { CATEGORY_IDS, displayCategoryName, inferCategoryIds, parseTagInput } from "../appShared";
import { useFocusTrap } from "../components/ui";
import { AgentGlyph } from "../components/shell";
import "./import.css";

const DRAFT_KEY = "ai-skillhub-import-draft-v33";
const NEW_FOLDER = "__new__";
const AUTO_CLOSE_MS = 4_000;

type Phase =
  | { kind: "idle" }
  | { kind: "parsing" }
  | { kind: "mcp"; text: string }
  | { kind: "invalid"; error: SkillHubError }
  | { kind: "probing"; stage: string }
  | { kind: "failed"; error: SkillHubError }
  | { kind: "preview"; probe: SkillSourceProbe }
  | { kind: "installing"; probe: SkillSourceProbe }
  | { kind: "done"; probe: SkillSourceProbe; result: InstallSkillSourceResult; agents: number };

function readDraft(): string {
  try {
    return window.localStorage.getItem(DRAFT_KEY)?.slice(0, 2048) ?? "";
  } catch {
    return "";
  }
}

/** A draft that carries a credential (a token, or a URL with user:password@) is never stored. */
function draftLooksSecret(value: string) {
  return redactSecrets(value) !== value || /\/\/[^/\s@]+@/.test(value);
}

function writeDraft(value: string) {
  try {
    if (value.trim() && !draftLooksSecret(value)) window.localStorage.setItem(DRAFT_KEY, value.slice(0, 2048));
    else window.localStorage.removeItem(DRAFT_KEY);
  } catch {
    // The draft is a convenience only.
  }
}

function stageLabel(stage: string) {
  if (stage === "inspect") return t("v33.stageInspect");
  if (stage === "git" || stage === "zip" || stage === "write") return t("v33.stageDownload");
  if (stage === "security") return t("v33.stageSecurity");
  if (stage === "enumerate") return t("v33.stageEnumerate");
  if (stage === "wait") return t("v33.stageWait");
  if (stage === "install" || stage === "index") return t("v33.stageInstall");
  return t("v33.stageInspect");
}

export function ImportSheet({
  agents,
  autoProbe,
  folders,
  initialText,
  onBusyChange,
  onClose,
  onGoAgents,
  onInstalled,
  onOpenMcp,
  onOpenRow,
  onReloadLibrary,
  rows
}: {
  agents: SkillAgent[];
  autoProbe: boolean;
  folders: SkillFolderCard[];
  initialText: string;
  onBusyChange: (busy: boolean) => void;
  onClose: () => void;
  onGoAgents: () => void;
  onInstalled: (result: InstallSkillSourceResult) => void;
  onOpenMcp: (text: string) => void;
  onOpenRow: (key: string) => void;
  onReloadLibrary: () => Promise<void>;
  rows: LibraryRow[];
}) {
  const [input, setInput] = useState(initialText);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [draft] = useState(() => (initialText ? "" : readDraft()));
  const [tab, setTab] = useState<"skills" | "mcp" | "docs">("skills");
  const [selectedPaths, setSelectedPaths] = useState<ReadonlySet<string>>(() => new Set());
  const [chips, setChips] = useState<ReadonlySet<AgentId>>(() => new Set());
  const [moreOpen, setMoreOpen] = useState(false);
  const [name, setName] = useState("");
  const [folderId, setFolderId] = useState("");
  const [newFolderName, setNewFolderName] = useState("");
  const [category, setCategory] = useState("");
  const [tags, setTags] = useState("");
  const [note, setNote] = useState("");
  const [touched, setTouched] = useState(false);
  const [installStage, setInstallStage] = useState("install");
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const operationRef = useRef<string>("");
  const probeIdRef = useRef<string>("");
  const generationRef = useRef(0);
  const parseTimer = useRef<number | null>(null);
  const probeTimer = useRef<number | null>(null);
  const installedRef = useRef(false);

  const managedAgents = agents.filter(agent => agent.takeover && agent.canDeliver);

  function cleanupProbe() {
    if (operationRef.current) void cancelSourceImport(operationRef.current);
    if (probeIdRef.current && !installedRef.current) void discardSkillSourceProbe(probeIdRef.current);
    operationRef.current = "";
    probeIdRef.current = "";
  }

  function close() {
    // A started install is not cancellable: closing now would discard the staged copy it is
    // promoting and unlock 更新 while it still runs. The sheet closes itself when it is done.
    if (phase.kind === "installing") return;
    if (!installedRef.current && phase.kind !== "done") writeDraft(input);
    else writeDraft("");
    cleanupProbe();
    onBusyChange(false);
    onClose();
  }

  useFocusTrap(sheetRef, close);

  useEffect(() => () => {
    if (parseTimer.current) window.clearTimeout(parseTimer.current);
    if (probeTimer.current) window.clearTimeout(probeTimer.current);
    onBusyChange(false);
  }, []);

  useEffect(() => {
    onBusyChange(phase.kind === "probing" || phase.kind === "installing");
  }, [phase.kind]);

  useEffect(() => {
    if (!initialText.trim()) return;
    // Text typed on the home box continues here: put the caret after it.
    inputRef.current?.setSelectionRange(initialText.length, initialText.length);
    scheduleCheck(initialText, autoProbe ? 0 : 300, autoProbe);
  }, []);

  // After a successful install the sheet closes by itself unless the user touched it.
  useEffect(() => {
    if (phase.kind !== "done" || touched) return;
    const timer = window.setTimeout(() => close(), AUTO_CLOSE_MS);
    return () => window.clearTimeout(timer);
  }, [phase.kind, touched]);

  function scheduleCheck(value: string, delay = 300, immediate = false) {
    if (parseTimer.current) window.clearTimeout(parseTimer.current);
    if (probeTimer.current) window.clearTimeout(probeTimer.current);
    generationRef.current += 1;
    const generation = generationRef.current;
    cleanupProbe();
    if (!value.trim()) {
      setPhase({ kind: "idle" });
      return;
    }
    setPhase({ kind: "parsing" });
    parseTimer.current = window.setTimeout(() => void check(value, generation, immediate), delay);
  }

  async function check(value: string, generation: number, immediate: boolean) {
    let parsed: ParsedSkillSource;
    try {
      parsed = await parseSkillSourceInput(value);
    } catch (error) {
      if (generation === generationRef.current) setPhase({ kind: "invalid", error: normalizeSkillHubError(error) });
      return;
    }
    if (generation !== generationRef.current) return;
    if (parsed.routeTo === "mcp") {
      setPhase({ kind: "mcp", text: value });
      return;
    }
    if (parsed.error || parsed.routeTo === "invalid") {
      setPhase({ kind: "invalid", error: parsed.error ?? normalizeSkillHubError("INPUT_UNRECOGNIZED") });
      return;
    }
    const wait = immediate || parsed.kind !== "github" ? 0 : 600;
    probeTimer.current = window.setTimeout(() => void probe(value, generation), wait);
  }

  async function probe(value: string, generation: number) {
    const operationId = createOperationId("probe");
    operationRef.current = operationId;
    setPhase({ kind: "probing", stage: "inspect" });
    try {
      const result = await probeSkillSource(value, operationId, (event: ImportProgress) => {
        if (generation === generationRef.current) setPhase({ kind: "probing", stage: event.stage });
      });
      if (generation !== generationRef.current) {
        void discardSkillSourceProbe(result.probeId);
        return;
      }
      operationRef.current = "";
      probeIdRef.current = result.probeId;
      acceptProbe(result);
    } catch (error) {
      if (generation !== generationRef.current) return;
      operationRef.current = "";
      const normalized = normalizeSkillHubError(error);
      if (normalized.code === "CANCELLED") return;
      if (normalized.code === "INPUT_IS_MCP_CONFIG") setPhase({ kind: "mcp", text: value });
      else setPhase({ kind: "failed", error: normalized });
    }
  }

  function acceptProbe(result: SkillSourceProbe) {
    const valid = result.skillGroups.flatMap(group => [...(group.parent ? [group.parent] : []), ...group.children]).filter(node => node.valid);
    setSelectedPaths(new Set(valid.map(node => node.path)));
    setChips(new Set(result.agentChips.filter(chip => chip.preselected && !chip.disabled).map(chip => chip.agentId)));
    setName(result.displayName);
    const descriptions = valid.slice(0, 12).map(node => `${node.name} ${node.description}`).join(" ");
    setCategory(inferCategoryIds(`${result.displayName} ${descriptions}`)[0] ?? "general");
    setTab(result.skillCount > 0 ? "skills" : result.mcpConfigs.length > 0 ? "mcp" : "docs");
    setPhase({ kind: "preview", probe: result });
  }

  async function pick(kind: "folder" | "zip") {
    try {
      const path = await pickSkillSourcePath(kind);
      if (!path) return;
      setInput(path);
      scheduleCheck(path, 0, true);
    } catch (error) {
      setPhase({ kind: "failed", error: normalizeSkillHubError(error) });
    }
  }

  async function submit(probe: SkillSourceProbe) {
    const review = probe.security.status === "review";
    const blocked = probe.security.status === "blocked" || !probe.security.canAddToLibrary;
    if (blocked) return;
    setInstallStage("install");
    setPhase({ kind: "installing", probe });
    const operationId = probe.operationId || createOperationId("install");
    const promptOnly = probe.skillCount === 0 && probe.promptDocs.length > 0;
    const agentIds = review || promptOnly || !probe.security.canSyncToAgents ? [] : [...chips];
    const valid = probe.skillGroups.flatMap(group => [...(group.parent ? [group.parent] : []), ...group.children]).filter(node => node.valid);
    const allSelected = valid.every(node => selectedPaths.has(node.path));
    try {
      const result = await installSkillSource({
        probeId: probe.probeId,
        selectedSkillPaths: allSelected ? [] : valid.filter(node => selectedPaths.has(node.path)).map(node => node.path),
        agentIds,
        securityReviewConfirmed: review,
        displayName: name.trim() && name.trim() !== probe.displayName ? name.trim() : null,
        folderId: folderId && folderId !== NEW_FOLDER ? folderId : null,
        newFolderName: folderId === NEW_FOLDER && newFolderName.trim() ? newFolderName.trim() : null,
        categoryId: category || null,
        tags: parseTagInput(tags),
        note: note.trim() ? note.trim() : null
      }, event => setInstallStage(event.stage), operationId);
      installedRef.current = true;
      probeIdRef.current = "";
      writeDraft("");
      onInstalled(result);
      if (result.snapshotStale) void onReloadLibrary();
      setPhase({ kind: "done", probe, result, agents: agentIds.length });
    } catch (error) {
      const normalized = normalizeSkillHubError(error);
      if (normalized.code === "PROBE_EXPIRED" || normalized.code === "PROBE_STALE") {
        scheduleCheck(input, 0, true);
        return;
      }
      setPhase({ kind: "failed", error: normalized });
    }
  }

  const progressStage = phase.kind === "probing" ? phase.stage : phase.kind === "parsing" ? "inspect" : phase.kind === "installing" ? installStage : "";
  const empty = !input.trim();
  const installing = phase.kind === "installing";

  return createPortal(
    <div className="sheet-layer">
      <div className="drawer-backdrop" onClick={close} aria-hidden="true" />
      <div
        aria-label={t("v33.addTitle")}
        aria-modal="true"
        className="import-sheet"
        data-overlay=""
        data-testid="import-sheet"
        onPointerDown={() => setTouched(true)}
        onKeyDown={() => setTouched(true)}
        ref={sheetRef}
        role="dialog"
        tabIndex={-1}
      >
        <header className="import-head">
          <strong>{t("v33.addTitle")}</strong>
          <button
            aria-label={t("common.close")}
            className="icon-action"
            data-testid="import-close"
            disabled={installing}
            onClick={close}
            title={installing ? t("v33.installingLabel") : t("common.close")}
            type="button"
          >
            <Icon name="close" />
          </button>
        </header>

        <div className="import-box">
          <div className="import-input-row">
            <Icon name="search" />
            <input
              aria-label={t("v33.addPlaceholder")}
              data-autofocus=""
              data-testid="import-input"
              readOnly={installing}
              onChange={event => {
                setInput(event.target.value);
                scheduleCheck(event.target.value, 300, false);
              }}
              onKeyDown={event => {
                if (event.key === "Enter" && input.trim() && !installing) {
                  event.preventDefault();
                  scheduleCheck(input, 0, true);
                }
              }}
              placeholder={t("v33.addPlaceholder")}
              ref={inputRef}
              spellCheck={false}
              value={input}
            />
          </div>
          <div className="import-pickers">
            <button className="ghost-action small" data-testid="import-pick-folder" disabled={installing} onClick={() => void pick("folder")} type="button">
              <Icon name="folder" /> {t("v33.pickFolder")}
            </button>
            <button className="ghost-action small" data-testid="import-pick-zip" disabled={installing} onClick={() => void pick("zip")} type="button">
              <Icon name="download" /> {t("v33.pickZip")}
            </button>
            <span className="muted">{t("v33.dropHint")}</span>
          </div>
          {empty && draft && phase.kind === "idle" && (
            <button
              className="link-action"
              onClick={() => {
                setInput(draft);
                scheduleCheck(draft, 0, true);
              }}
              type="button"
            >
              {t("v33.restoreDraft")}
            </button>
          )}
        </div>

        {progressStage && (
          <p className="import-progress" data-testid="import-progress" role="status">
            <Icon className="icon-spin" name="refresh" /> {stageLabel(progressStage)}
            {phase.kind === "probing" && (
              <button className="link-action" onClick={() => scheduleCheck("", 0)} type="button">{t("v33.cancelInstall")}</button>
            )}
          </p>
        )}

        {phase.kind === "mcp" && (
          <section className="import-notice" data-testid="import-mcp-handoff">
            <Icon name="plug" />
            <span>{t("v33.mcpDetected")}</span>
            <button className="primary-action small" onClick={() => onOpenMcp(phase.text)} type="button">{t("v33.goAddMcp")}</button>
          </section>
        )}
        {(phase.kind === "invalid" || phase.kind === "failed") && (
          <section className="import-notice error" data-testid="import-error" data-code={phase.error.code} role="alert">
            <Icon name="alert" />
            <span>{skillHubErrorText(phase.error, t)}</span>
            {phase.kind === "failed" && phase.error.code !== "SECURITY_BLOCKED" && (
              <button className="ghost-action small" onClick={() => scheduleCheck(input, 0, true)} type="button">{t("err.action.retry")}</button>
            )}
          </section>
        )}

        {(phase.kind === "preview" || phase.kind === "installing") && (
          <ProbePreview
            category={category}
            chips={chips}
            folderId={folderId}
            folders={folders}
            installing={phase.kind === "installing"}
            managedCount={managedAgents.length}
            moreOpen={moreOpen}
            name={name}
            newFolderName={newFolderName}
            note={note}
            onCategory={setCategory}
            onFolder={setFolderId}
            onGoAgents={onGoAgents}
            onMoreOpen={setMoreOpen}
            onName={setName}
            onNewFolderName={setNewFolderName}
            onNote={setNote}
            onOpenMcp={async relativePath => {
              try {
                const file = await readSkillSourceProbeFile(phase.probe.probeId, relativePath);
                onOpenMcp(file.text);
              } catch (error) {
                setPhase({ kind: "failed", error: normalizeSkillHubError(error) });
              }
            }}
            onOpenRow={() => phase.probe.duplicate && onOpenRow(phase.probe.duplicate.sourceId)}
            onSelectPaths={setSelectedPaths}
            onSubmit={() => void submit(phase.probe)}
            onTab={setTab}
            onTags={setTags}
            onToggleChip={agentId => setChips(current => {
              const next = new Set(current);
              if (next.has(agentId)) next.delete(agentId);
              else next.add(agentId);
              return next;
            })}
            probe={phase.probe}
            selectedPaths={selectedPaths}
            tab={tab}
            tags={tags}
          />
        )}

        {phase.kind === "done" && (
          <section className="import-done" data-testid="import-done">
            <Icon name="check" />
            <div>
              <strong>
                {phase.result.outcome === "library-only"
                  ? t("v33.doneLibraryOnly")
                  : phase.result.outcome === "prompt-library"
                    ? t("v33.donePrompt")
                    : phase.agents > 0
                      ? t("v33.doneSyncing", { n: phase.agents })
                      : t("v33.doneLibrary")}
              </strong>
              {phase.result.disabledSkills.length > 0 && <span>{t("v33.doneDisabledSkills", { n: phase.result.disabledSkills.length })}</span>}
            </div>
            <button className="ghost-action small" onClick={() => onOpenRow(phase.result.source.id)} type="button">{t("v33.view")}</button>
            <button
              className="primary-action small"
              onClick={() => {
                installedRef.current = false;
                setInput("");
                setPhase({ kind: "idle" });
                inputRef.current?.focus();
              }}
              type="button"
            >
              {t("v33.addMore")}
            </button>
          </section>
        )}
        {rows.length === 0 && phase.kind === "idle" && <p className="import-foot muted">{t("v33.firstAddHint")}</p>}
      </div>
    </div>,
    document.getElementById("app-overlay-root") ?? document.body
  );
}

/* ---------- preview ---------- */

function ProbePreview({
  category,
  chips,
  folderId,
  folders,
  installing,
  managedCount,
  moreOpen,
  name,
  newFolderName,
  note,
  onCategory,
  onFolder,
  onGoAgents,
  onMoreOpen,
  onName,
  onNewFolderName,
  onNote,
  onOpenMcp,
  onOpenRow,
  onSelectPaths,
  onSubmit,
  onTab,
  onTags,
  onToggleChip,
  probe,
  selectedPaths,
  tab,
  tags
}: {
  category: string;
  chips: ReadonlySet<AgentId>;
  folderId: string;
  folders: SkillFolderCard[];
  installing: boolean;
  managedCount: number;
  moreOpen: boolean;
  name: string;
  newFolderName: string;
  note: string;
  onCategory: (value: string) => void;
  onFolder: (value: string) => void;
  onGoAgents: () => void;
  onMoreOpen: (value: boolean) => void;
  onName: (value: string) => void;
  onNewFolderName: (value: string) => void;
  onNote: (value: string) => void;
  onOpenMcp: (relativePath: string) => void;
  onOpenRow: () => void;
  onSelectPaths: (paths: ReadonlySet<string>) => void;
  onSubmit: () => void;
  onTab: (tab: "skills" | "mcp" | "docs") => void;
  onTags: (value: string) => void;
  onToggleChip: (agentId: AgentId) => void;
  probe: SkillSourceProbe;
  selectedPaths: ReadonlySet<string>;
  tab: "skills" | "mcp" | "docs";
  tags: string;
}) {
  const security = probe.security;
  const review = security.status === "review";
  const blocked = security.status === "blocked" || !security.canAddToLibrary;
  const promptOnly = probe.skillCount === 0 && probe.promptDocs.length > 0;
  const duplicate = probe.duplicate;
  const mcpServers = probe.mcpConfigs.reduce((total, config) => total + config.serverNames.length, 0);
  const showTabs = [probe.skillCount > 0, mcpServers > 0, probe.promptDocs.length > 0].filter(Boolean).length > 1;
  const chipsLocked = !security.canSyncToAgents || review;
  const chosen = chipsLocked ? 0 : chips.size;
  const categories = CATEGORY_IDS.includes(category as (typeof CATEGORY_IDS)[number]) || !category ? CATEGORY_IDS : [...CATEGORY_IDS, category];
  const nothingSelected = probe.skillCount > 0 && selectedPaths.size === 0;
  // The same pack is already in the library: the button only adds AI tools, so with no tool
  // chosen there is nothing to do (the backend would answer DUPLICATE_SOURCE).
  const sameAsExisting = duplicate?.relation === "same";
  const nothingToDo = sameAsExisting && chosen === 0;

  let submitLabel: string;
  if (blocked) submitLabel = t("v33.submitBlocked");
  else if (nothingToDo) submitLabel = t("v33.inLibrary");
  else if (review) submitLabel = t("v33.submitLibraryOnly");
  else if (promptOnly) submitLabel = t("v33.submitPrompt");
  else if (sameAsExisting) submitLabel = t("v33.submitSyncExisting", { n: chosen });
  else if (managedCount === 0 || chosen === 0) submitLabel = t("v33.submitLibrary");
  else submitLabel = t("v33.submitInstall", { n: chosen });

  return (
    <section className="import-preview" data-testid="import-preview">
      <header className="import-preview-head">
        <span className="lib-avatar" style={{ "--avatar-hue": 210 } as CSSProperties} aria-hidden="true">{(probe.displayName || "?").slice(0, 1).toUpperCase()}</span>
        <div>
          <strong>{probe.displayName}</strong>
          <small>
            {probe.owner && <>{probe.owner} · </>}
            {promptOnly ? t("v33.docsCount", { n: probe.promptDocs.length }) : t("v33.skillsInPack", { n: probe.skillCount })}
          </small>
        </div>
        <span className="chip">{probe.parsed.kind === "github" ? "GitHub" : probe.parsed.kind === "zip" ? ".zip" : t("v33.local")}</span>
      </header>
      {duplicate && (
        <p className="import-notice" data-testid="import-duplicate">
          <Icon name="info" /> <span>{t("v33.alreadyInLibrary")}</span>
          <button className="link-action" onClick={onOpenRow} type="button">{t("v33.open")}</button>
        </p>
      )}

      {showTabs && (
        <div className="import-tabs" role="tablist">
          {probe.skillCount > 0 && <button aria-selected={tab === "skills"} className={tab === "skills" ? "active" : ""} onClick={() => onTab("skills")} role="tab" type="button">{t("v33.tabSkills", { n: probe.skillCount })}</button>}
          {mcpServers > 0 && <button aria-selected={tab === "mcp"} className={tab === "mcp" ? "active" : ""} data-testid="import-tab-mcp" onClick={() => onTab("mcp")} role="tab" type="button">MCP ({mcpServers})</button>}
          {probe.promptDocs.length > 0 && <button aria-selected={tab === "docs"} className={tab === "docs" ? "active" : ""} onClick={() => onTab("docs")} role="tab" type="button">{t("v33.tabDocs", { n: probe.promptDocs.length })}</button>}
        </div>
      )}

      <div className="import-tab-body">
        {(tab === "skills" || !showTabs) && probe.skillGroups.length > 0 && (
          <SkillGroups groups={probe.skillGroups} onSelect={onSelectPaths} selected={selectedPaths} />
        )}
        {(tab === "mcp" || (!showTabs && mcpServers > 0 && probe.skillCount === 0)) && (
          <div className="import-mcp" data-testid="import-mcp">
            {probe.mcpConfigs.map(config => (
              <div className="import-mcp-file" key={config.relativePath}>
                <code>{config.relativePath}</code>
                <span>{config.serverNames.join(" · ")}</span>
                <button className="ghost-action small" onClick={() => onOpenMcp(config.relativePath)} type="button">{t("v33.addTheseMcp")}</button>
              </div>
            ))}
            <p className="muted">{t("v33.mcpNeverRun")}</p>
          </div>
        )}
        {(tab === "docs" || (!showTabs && promptOnly)) && (
          <ul className="import-docs">
            {probe.promptDocs.map(doc => <li key={doc.relativePath}>{doc.title || doc.relativePath}</li>)}
          </ul>
        )}
      </div>

      <section className={`import-security tone-${security.status}`} data-testid="import-security-card" data-status={security.status}>
        <Icon name={security.status === "passed" ? "shield" : "alert"} />
        <div>
          <strong>
            {security.status === "passed"
              ? probe.downloadMethod === "index" && security.scannedFiles === 0
                // Duplicate fast path: nothing was downloaded now, so "0 files checked" would mislead.
                ? t("v33.securityCheckedBefore")
                : t("v33.securityPassed", { n: security.scannedFiles })
              : security.status === "review"
                ? t("v33.securityReview", { n: security.findingCount })
                : t("v33.securityBlocked", { summary: security.plainSummary })}
          </strong>
          {review && (
            <>
              <ul className="import-findings">
                {security.findings.slice(0, 8).map(finding => (
                  <li key={finding.id}><code>{finding.relativePath}{finding.line ? `:${finding.line}` : ""}</code> · {finding.summary}</li>
                ))}
              </ul>
              <span>{t("v33.securityNotRun")}</span>
              <span>{t("v33.securityKeptOff")}</span>
            </>
          )}
        </div>
      </section>

      {!promptOnly && (
        <div className="import-chips" role="group" aria-label={t("v33.installTo")}>
          <span>{t("v33.installTo")}</span>
          {probe.agentChips.length === 0 && <span className="muted">{t("v33.noToolsFound")}</span>}
          {probe.agentChips.map(chip => {
            const disabled = chip.disabled || chipsLocked || installing;
            const on = !chipsLocked && chips.has(chip.agentId);
            return (
              <button
                aria-pressed={on}
                className={`agent-chip${on ? " on" : ""}`}
                data-testid={`import-agent-chip-${chip.agentId}`}
                disabled={disabled}
                key={chip.agentId}
                onClick={() => onToggleChip(chip.agentId)}
                title={chipsLocked ? t("v33.needsReviewFirst") : chip.disabledReason || chip.name}
                type="button"
              >
                <AgentGlyph agentId={chip.agentId} name={chip.name} size="sm" />
                {chip.name}
                {chip.experimental && <em className="chip-tag">{t("v33.experimental")}</em>}
                {on && <Icon name="check" />}
              </button>
            );
          })}
          {chipsLocked && probe.agentChips.length > 0 && <small className="muted">{t("v33.needsReviewFirst")}</small>}
        </div>
      )}
      {managedCount === 0 && !promptOnly && !blocked && (
        <p className="import-notice subtle">
          <span>{t("v33.noManagedHint")}</span>
          <button className="link-action" onClick={onGoAgents} type="button">{t("v33.goTakeover")}</button>
        </p>
      )}

      <details className="import-more" open={moreOpen} onToggle={event => onMoreOpen((event.currentTarget as HTMLDetailsElement).open)}>
        <summary>{t("v33.moreOptions")}</summary>
        <div className="import-more-grid">
          <label className="field">
            <span>{t("v33.fieldName")}</span>
            <input maxLength={120} onChange={event => onName(event.target.value)} value={name} />
          </label>
          <label className="field">
            <span>{t("v33.folder")}</span>
            <select onChange={event => onFolder(event.target.value)} value={folderId}>
              <option value="">{t("v33.folderUnfiled")}</option>
              {folders.map(folder => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
              <option value={NEW_FOLDER}>{t("v33.folderNewOption")}</option>
            </select>
          </label>
          {folderId === NEW_FOLDER && (
            <label className="field">
              <span>{t("v33.folderName")}</span>
              <input maxLength={48} onChange={event => onNewFolderName(event.target.value)} value={newFolderName} />
            </label>
          )}
          <label className="field">
            <span>{t("v33.fieldCategory")}</span>
            <select onChange={event => onCategory(event.target.value)} value={category}>
              {categories.map(id => <option key={id} value={id}>{displayCategoryName(id)}</option>)}
            </select>
          </label>
          <label className="field">
            <span>{t("v33.fieldTags")}</span>
            <input onChange={event => onTags(event.target.value)} placeholder={t("srcEditor.tagsPlaceholder")} value={tags} />
          </label>
          <label className="field wide">
            <span>{t("v33.fieldNote")}</span>
            <textarea onChange={event => onNote(event.target.value)} rows={2} value={note} />
          </label>
        </div>
      </details>

      <footer className="import-foot-actions">
        <button
          className="primary-action"
          data-testid="import-submit"
          disabled={blocked || installing || nothingSelected || nothingToDo}
          onClick={onSubmit}
          type="button"
        >
          {installing ? <><Icon className="icon-spin" name="refresh" /> {t("v33.installingLabel")}</> : submitLabel}
        </button>
      </footer>
    </section>
  );
}

function SkillGroups({
  groups,
  onSelect,
  selected
}: {
  groups: ProbeSkillGroup[];
  onSelect: (paths: ReadonlySet<string>) => void;
  selected: ReadonlySet<string>;
}) {
  const [openGroups, setOpenGroups] = useState<ReadonlySet<string>>(() => new Set(groups.length <= 3 ? groups.map(group => group.groupId) : []));
  const lists = useMemo(() => groups.map(group => ({
    group,
    nodes: [...(group.parent ? [group.parent] : []), ...group.children]
  })), [groups]);
  return (
    <div className="import-groups">
      {lists.map(({ group, nodes }) => {
        const valid = nodes.filter(node => node.valid);
        const checked = valid.filter(node => selected.has(node.path)).length;
        const all = checked === valid.length && valid.length > 0;
        const open = openGroups.has(group.groupId);
        return (
          <section className="import-group" data-testid="import-skill-group" key={group.groupId}>
            <header>
              <input
                aria-label={group.title}
                checked={all}
                disabled={valid.length === 0}
                onChange={() => {
                  const next = new Set(selected);
                  for (const node of valid) {
                    if (all) next.delete(node.path);
                    else next.add(node.path);
                  }
                  onSelect(next);
                }}
                ref={element => {
                  if (element) element.indeterminate = checked > 0 && !all;
                }}
                type="checkbox"
              />
              <button className="import-group-toggle" onClick={() => setOpenGroups(current => {
                const next = new Set(current);
                if (next.has(group.groupId)) next.delete(group.groupId);
                else next.add(group.groupId);
                return next;
              })} type="button">
                <strong>{group.title}</strong>
                <small>{t("v33.groupCount", { checked, n: valid.length })}</small>
                <Icon className={open ? "rotate-90" : ""} name="chevron" />
              </button>
            </header>
            {open && (
              <ul>
                {nodes.map(node => (
                  <li className={node.valid ? "" : "invalid"} key={node.path}>
                    <label>
                      <input
                        checked={node.valid && selected.has(node.path)}
                        disabled={!node.valid}
                        onChange={() => {
                          const next = new Set(selected);
                          if (next.has(node.path)) next.delete(node.path);
                          else next.add(node.path);
                          onSelect(next);
                        }}
                        type="checkbox"
                      />
                      <span>
                        <strong>{node.name}</strong>
                        <small>{node.valid ? node.description : node.invalidReason}</small>
                      </span>
                      {node.inLibrary && <em className="chip">{t("v33.inLibrary")}</em>}
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}
