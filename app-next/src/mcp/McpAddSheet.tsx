// Add sheet (contract §6.3, M0-6/M0-7): paste box first, then template chips, then the manual form.
// Secret values typed here are write-only: they live in React state until the request settles and
// are cleared in a finally block (contract §3.3, test F4). Nothing here starts a process.
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  McpAddRequest,
  McpCandidate,
  McpClient,
  McpClientId,
  McpError,
  McpLibrarySnapshot,
  McpPasteResult,
  McpScope,
  McpSecretInput,
  McpSecretMode,
  McpServerInput,
  McpTemplate,
  McpTemplateId,
  McpTransport
} from "./mcpTypes";
import { mcpApi } from "./mcpApi";
import {
  argsContainCredential,
  clientAvailability,
  errorText,
  isRemoteTarget,
  joinCommandLine,
  normalizeCommand,
  splitCommandLine,
  validateEnvName,
  validateRemoteUrl,
  validateServerName
} from "./mcpLogic";
import { Glyph, Overlay, Spinner, t } from "./mcpUi";

export type AddSubmitResult = { status: "done" } | { status: "cancelled" } | { status: "failed"; error: McpError };

type Props = {
  snapshot: McpLibrarySnapshot;
  initialText?: string;
  initialTemplate?: McpTemplateId;
  initialGithub?: string;
  preview: boolean;
  onClose: () => void;
  onSubmit: (request: McpAddRequest) => Promise<AddSubmitResult>;
  onOpenDiscover: () => void;
  onOpenUrl: (url: string) => void;
};

type SecretRow = {
  id: number;
  kind: "env" | "header";
  name: string;
  envVar: string;
  headerTemplate: "raw" | "bearer";
  value: string;
  later: boolean;
  mode: McpSecretMode;
  required: boolean;
  helpUrl?: string;
};

type EnvRow = { id: number; name: string; value: string };
type TransportChoice = "auto" | "stdio" | "http" | "sse";

type CandidateChoice = {
  include: boolean;
  onConflict: "skip" | "overwrite";
  name: string;
  values: Record<string, string>;
  later: Record<string, boolean>;
  replace: Record<string, boolean>;
  activeKey: string;
};

let templateCache: McpTemplate[] | null = null;
let rowCounter = 0;
const nextId = () => {
  rowCounter += 1;
  return rowCounter;
};

const GITHUB_SOURCE = /^(?:https:\/\/github\.com\/)?[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?(?:\/(?:tree|blob)\/\S+)?\/?$/i;

function looksLikeGithub(text: string) {
  const value = text.trim();
  return value.length > 2 && !/[{}\[\]=\n]/.test(value) && GITHUB_SOURCE.test(value) && !/^https?:\/\/(?!github\.com)/i.test(value);
}

function emptySecret(kind: "env" | "header" = "env"): SecretRow {
  return {
    id: nextId(),
    kind,
    name: kind === "header" ? "Authorization" : "",
    envVar: "",
    headerTemplate: kind === "header" ? "bearer" : "raw",
    value: "",
    later: false,
    mode: "user_env",
    required: true
  };
}

function knownWorkspaces(snapshot: McpLibrarySnapshot) {
  const seen = new Map<string, string>();
  for (const row of snapshot.servers) {
    for (const binding of row.projectBindings) {
      if (binding.workspaceId && !seen.has(binding.workspaceId)) seen.set(binding.workspaceId, binding.projectLabel);
    }
  }
  return [...seen.entries()].map(([id, label]) => ({ id, label }));
}

export function McpAddSheet({ snapshot, initialText = "", initialTemplate, initialGithub, preview, onClose, onSubmit, onOpenDiscover, onOpenUrl }: Props) {
  const clients = useMemo(() => snapshot.clients.filter(client => client.detected || client.enabledCount > 0), [snapshot.clients]);
  const existingNames = useMemo(() => snapshot.servers.map(row => row.name), [snapshot.servers]);
  const workspaces = useMemo(() => knownWorkspaces(snapshot), [snapshot]);

  const pasteRef = useRef<HTMLTextAreaElement>(null);
  const sheetBodyRef = useRef<HTMLDivElement>(null);
  const submitRef = useRef<HTMLButtonElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const targetRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const secretRefs = useRef(new Map<number, HTMLInputElement>());

  // ---------- paste ----------
  const [pasteText, setPasteText] = useState(initialText);
  const [parsing, setParsing] = useState(false);
  const [result, setResult] = useState<McpPasteResult | null>(null);
  const [pasteError, setPasteError] = useState("");
  const [choices, setChoices] = useState<Record<string, CandidateChoice>>({});
  const [batchMode, setBatchMode] = useState<McpSecretMode>("user_env");
  const parseSeq = useRef(0);
  const parseTimer = useRef<number | null>(null);

  // ---------- manual form ----------
  const [templates, setTemplates] = useState<McpTemplate[] | null>(templateCache);
  const [templateId, setTemplateId] = useState<McpTemplateId | null>(null);
  const [manualOpen, setManualOpen] = useState(!initialText && !initialGithub);
  const [name, setName] = useState("");
  const [target, setTarget] = useState("");
  const [folder, setFolder] = useState<{ argIndex: number; value: string } | null>(null);
  const [secrets, setSecrets] = useState<SecretRow[]>([]);
  const [envRows, setEnvRows] = useState<EnvRow[]>([]);
  const [transportChoice, setTransportChoice] = useState<TransportChoice>("auto");
  const [cwd, setCwd] = useState("");
  const [codexRequired, setCodexRequired] = useState(false);
  const [placement, setPlacement] = useState("user");
  const [shown, setShown] = useState<Record<number, boolean>>({});

  // ---------- targets ----------
  const [picked, setPicked] = useState<McpClientId[] | null>(null);
  const [inlineDesktop, setInlineDesktop] = useState(false);

  // ---------- flow ----------
  const [attempted, setAttempted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [submitError, setSubmitError] = useState("");

  const candidates = result?.candidates ?? [];
  const pasteActive = candidates.length > 0;

  useEffect(() => {
    if (templateCache) return;
    let cancelled = false;
    mcpApi.templates().then(list => {
      templateCache = list;
      if (!cancelled) setTemplates(list);
    }).catch(() => {
      if (!cancelled) setTemplates([]);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    sheetBodyRef.current?.scrollTo({ top: 0 });
    if (initialText.trim()) void runParse(initialText);
    if (initialGithub) {
      setPasteText(initialGithub);
      void runGithub(initialGithub);
    }
    return () => {
      if (parseTimer.current !== null) window.clearTimeout(parseTimer.current);
    };
    // Mount-only: the initial hand-off text is parsed once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (initialTemplate && templates) {
      const template = templates.find(item => item.id === initialTemplate);
      if (template) applyTemplate(template);
    }
    // Apply once when the templates arrive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialTemplate, templates]);

  // ---------- derived manual input ----------
  const remote = isRemoteTarget(target);
  const transport: McpTransport = transportChoice === "auto" ? (remote ? "http" : "stdio") : transportChoice;
  const split = useMemo(() => splitCommandLine(target), [target]);
  const commandCheck = useMemo(() => (transport === "stdio" ? normalizeCommand(split.command, split.args) : null), [transport, split]);

  const manualArgs = useMemo(() => {
    if (!commandCheck || commandCheck.kind !== "ok") return [];
    const args = [...commandCheck.args];
    // The template's folder parameter goes back to its position; an empty slot blocks the submit.
    if (folder) args.splice(Math.min(folder.argIndex, args.length), 0, folder.value.trim());
    return args;
  }, [commandCheck, folder]);

  const nameProblem = validateServerName(name, existingNames);
  const targetProblem = (() => {
    if (!target.trim()) return "mcp.add.err.targetEmpty";
    if (transport !== "stdio") {
      const problem = validateRemoteUrl(target);
      return problem ? `mcp.add.err.url.${problem}` : "";
    }
    if (remote) return "mcp.add.err.remoteAsLocal";
    if (!commandCheck || commandCheck.kind === "shell") return "mcp.add.err.shell";
    if (argsContainCredential(commandCheck.args)) return "mcp.add.err.argSecret";
    return "";
  })();
  const folderProblem = folder && !folder.value.trim() ? "mcp.add.err.folder" : "";
  const secretProblems = new Map<number, string>();
  for (const row of secrets) {
    if (row.kind === "env") {
      const problem = validateEnvName(row.name);
      if (problem) secretProblems.set(row.id, `mcp.add.err.env.${problem}`);
    } else if (!row.name.trim()) {
      secretProblems.set(row.id, "mcp.add.err.headerName");
    } else if (row.envVar && validateEnvName(row.envVar)) {
      secretProblems.set(row.id, `mcp.add.err.env.${validateEnvName(row.envVar)}`);
    }
    if (!secretProblems.has(row.id) && row.required && !row.value.trim() && !row.later) secretProblems.set(row.id, "mcp.add.err.secretValue");
    if (!secretProblems.has(row.id) && /[\r\n]/.test(row.value)) secretProblems.set(row.id, "mcp.add.err.secretNewline");
  }
  const envProblem = envRows.some(row => row.name.trim() && validateEnvName(row.name)) ? "mcp.add.err.plainEnv" : "";
  const manualValid = !nameProblem && !targetProblem && !folderProblem && secretProblems.size === 0 && !envProblem;

  // ---------- paste candidates ----------
  const groups = useMemo(() => {
    const byName = new Map<string, McpCandidate[]>();
    for (const candidate of candidates) {
      const list = byName.get(candidate.name.toLowerCase()) ?? [];
      list.push(candidate);
      byName.set(candidate.name.toLowerCase(), list);
    }
    return [...byName.values()];
  }, [candidates]);

  function activeCandidate(group: McpCandidate[]): McpCandidate {
    const choice = choices[group[0].key];
    return group.find(item => item.key === choice?.activeKey) ?? group.find(item => item.variants.find(v => v.key === item.key)?.preferred) ?? group[0];
  }

  const includedCandidates = groups
    .map(group => ({ group, candidate: activeCandidate(group), choice: choices[group[0].key] }))
    .filter(item => item.choice?.include);

  const transportsInPlay: McpTransport[] = pasteActive
    ? [...new Set(includedCandidates.map(item => item.candidate.input.transport))]
    : [transport];
  const nameInPlay = pasteActive ? includedCandidates.map(item => item.choice.name).join(",") : name;

  const availability = clients.map(client => {
    const options = transportsInPlay.map(value => clientAvailability(client, value, nameInPlay));
    const available = options.some(option => option.available);
    return { client, available, reason: options.find(option => !option.available)?.reason, partial: available && options.some(option => !option.available) };
  });
  const defaultPicked = availability.filter(item => item.available).map(item => item.client.id);
  const pickedIds = (picked ?? defaultPicked).filter(id => availability.find(item => item.client.id === id)?.available);
  const targetCount = pickedIds.length;

  const hasSecrets = pasteActive ? includedCandidates.some(item => item.candidate.secrets.length > 0) : secrets.length > 0;
  const desktopNeedsConsent = hasSecrets && pickedIds.includes("claude-desktop");

  const candidateProblems = new Map<string, string>();
  for (const item of includedCandidates) {
    const problem = validateServerName(item.choice.name);
    const existing = item.candidate.exists !== "new";
    if (problem && !existing && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(item.choice.name)) candidateProblems.set(item.group[0].key, `mcp.add.err.name.${problem}`);
    for (const secret of item.candidate.secrets) {
      const typed = item.choice.values[secret.name] ?? "";
      const replacing = item.choice.replace[secret.name];
      if (secret.hasPastedValue && !replacing) continue;
      if (!typed.trim() && !item.choice.later[secret.name]) candidateProblems.set(`${item.group[0].key}:${secret.name}`, "mcp.add.err.secretValue");
    }
  }
  const pasteValid = includedCandidates.length > 0 && candidateProblems.size === 0;

  const replacedCount = includedCandidates.filter(item => item.candidate.exists === "different" && item.choice.onConflict === "overwrite").length;
  const addCount = includedCandidates.filter(item => !(item.candidate.exists !== "new" && item.choice.onConflict === "skip")).length;

  const dirty = Boolean(pasteText.trim() || name.trim() || target.trim() || secrets.some(row => row.value) || envRows.length > 0);

  // ---------- actions ----------
  function schedulePaste(text: string, immediate = false) {
    if (parseTimer.current !== null) window.clearTimeout(parseTimer.current);
    parseTimer.current = null;
    if (!text.trim()) {
      parseSeq.current += 1;
      setResult(null);
      setPasteError("");
      setParsing(false);
      return;
    }
    if (looksLikeGithub(text)) {
      setResult(null);
      setPasteError("");
      return;
    }
    parseTimer.current = window.setTimeout(() => void runParse(text), immediate ? 0 : 300);
  }

  function resetChoices(next: McpPasteResult) {
    const map: Record<string, CandidateChoice> = {};
    const seen = new Set<string>();
    for (const candidate of next.candidates) {
      const groupKey = candidate.name.toLowerCase();
      if (seen.has(groupKey)) continue;
      seen.add(groupKey);
      const preferred = candidate.variants.find(variant => variant.preferred)?.key;
      map[candidate.key] = {
        include: true,
        onConflict: candidate.exists === "different" ? "skip" : "overwrite",
        name: candidate.name,
        values: {},
        later: {},
        replace: {},
        activeKey: next.candidates.some(item => item.key === preferred) ? (preferred as string) : candidate.key
      };
    }
    setChoices(map);
  }

  async function runParse(text: string) {
    const seq = ++parseSeq.current;
    setParsing(true);
    setPasteError("");
    try {
      const next = await mcpApi.parsePaste(text);
      if (seq !== parseSeq.current) return;
      setResult(next);
      resetChoices(next);
      if (next.candidates.length > 0) setManualOpen(false);
    } catch (raw) {
      if (seq !== parseSeq.current) return;
      setResult(null);
      setPasteError(errorText(raw as McpError, t, clients));
    } finally {
      if (seq === parseSeq.current) setParsing(false);
    }
  }

  async function runGithub(source: string) {
    const seq = ++parseSeq.current;
    setParsing(true);
    setPasteError("");
    try {
      const next = await mcpApi.importGithub(source.trim());
      if (seq !== parseSeq.current) return;
      setResult(next);
      resetChoices(next);
      if (next.candidates.length > 0) setManualOpen(false);
    } catch (raw) {
      if (seq !== parseSeq.current) return;
      setResult(null);
      setPasteError(errorText(raw as McpError, t, clients));
    } finally {
      if (seq === parseSeq.current) setParsing(false);
    }
  }

  function updateChoice(key: string, patch: Partial<CandidateChoice>) {
    setChoices(current => ({ ...current, [key]: { ...current[key], ...patch } }));
  }

  function applyTemplate(template: McpTemplate) {
    parseSeq.current += 1;
    setPasteText("");
    setResult(null);
    setPasteError("");
    setChoices({});
    setManualOpen(true);
    setTemplateId(template.id);
    setAttempted(false);
    setPicked(null);
    setName(template.input.name);
    const param = template.params[0];
    if (template.input.transport === "stdio") {
      const args = (template.input.args ?? []).filter((_value, index) => !param || index !== param.argIndex);
      setTarget(joinCommandLine(template.input.command ?? "", args));
    } else {
      setTarget(template.input.url ?? "");
    }
    setTransportChoice(template.input.transport === "sse" ? "sse" : "auto");
    setFolder(param ? { argIndex: param.argIndex, value: "" } : null);
    setEnvRows((template.input.env ?? []).map(row => ({ id: nextId(), ...row })));
    setCwd("");
    setCodexRequired(false);
    const rows = template.secrets.map(secret => ({
      id: nextId(),
      kind: secret.kind,
      name: secret.name,
      envVar: secret.kind === "header" ? secret.envVar : "",
      headerTemplate: (secret.headerTemplate ?? "raw") as "raw" | "bearer",
      value: "",
      later: false,
      mode: "user_env" as McpSecretMode,
      required: secret.required,
      helpUrl: secret.helpUrl
    }));
    setSecrets(rows);
    window.requestAnimationFrame(() => {
      if (param) folderRef.current?.focus();
      else {
        const firstRequired = rows.find(row => row.required);
        if (firstRequired) secretRefs.current.get(firstRequired.id)?.focus();
        else submitRef.current?.focus();
      }
    });
  }

  function requestClose() {
    if (submitting) return;
    if (dirty && !confirmDiscard) {
      setConfirmDiscard(true);
      return;
    }
    onClose();
  }

  function manualInput(): McpServerInput {
    const secretInputs: McpSecretInput[] = secrets.map(row => ({
      kind: row.kind,
      name: row.name.trim(),
      envVar: row.kind === "header" ? row.envVar.trim() || undefined : undefined,
      headerTemplate: row.kind === "header" ? row.headerTemplate : undefined,
      value: row.value.trim() ? row.value : undefined,
      mode: row.mode,
      inlineClients: inlineDesktop && pickedIds.includes("claude-desktop") ? ["claude-desktop"] : undefined,
      required: row.required
    }));
    const base = { name: name.trim(), transport, secrets: secretInputs, codexRequired: codexRequired || undefined };
    const source = templateId ? { kind: "template" as const, id: templateId } : { kind: "manual" as const };
    if (transport === "stdio" && commandCheck?.kind === "ok") {
      return {
        ...base,
        command: commandCheck.command,
        args: manualArgs,
        cwd: cwd.trim() || undefined,
        env: envRows.filter(row => row.name.trim()).map(row => ({ name: row.name.trim(), value: row.value })),
        source
      };
    }
    return { ...base, url: target.trim(), source };
  }

  function candidateInput(candidate: McpCandidate, choice: CandidateChoice): McpServerInput {
    const secretsIn: McpSecretInput[] = (candidate.input.secrets ?? []).map(secret => {
      const typed = choice.values[secret.name] ?? "";
      const replacing = choice.replace[secret.name];
      const keepPasted = Boolean(secret.pasteValueHandle) && !replacing;
      return {
        ...secret,
        value: keepPasted ? undefined : typed.trim() ? typed : undefined,
        pasteValueHandle: keepPasted ? secret.pasteValueHandle : undefined,
        mode: batchMode,
        inlineClients: inlineDesktop && pickedIds.includes("claude-desktop") ? ["claude-desktop"] : secret.inlineClients
      };
    });
    return { ...candidate.input, name: choice.name.trim(), secrets: secretsIn };
  }

  function buildRequest(): McpAddRequest {
    const [scope, workspaceId] = placement === "user" ? ["user", undefined] : placement.split(":");
    const request: McpAddRequest = pasteActive
      ? {
          candidates: includedCandidates.map(item => ({
            input: candidateInput(item.candidate, item.choice),
            onConflict: item.candidate.exists === "new" ? "skip" : item.choice.onConflict
          })),
          clientIds: pickedIds,
          pasteHandle: result?.pasteHandle ?? undefined
        }
      : { candidates: [{ input: manualInput(), onConflict: "skip" }], clientIds: pickedIds };
    if (scope !== "user") request.placement = { scope: scope as McpScope, workspaceId };
    return request;
  }

  function clearSecretState() {
    setSecrets(rows => rows.map(row => ({ ...row, value: "" })));
    setChoices(current => {
      const next: Record<string, CandidateChoice> = {};
      for (const [key, value] of Object.entries(current)) next[key] = { ...value, values: {} };
      return next;
    });
  }

  async function submit() {
    setAttempted(true);
    setSubmitError("");
    if (pasteActive ? !pasteValid : !manualValid) {
      window.requestAnimationFrame(() => sheetBodyRef.current?.querySelector<HTMLElement>("[aria-invalid='true']")?.focus());
      return;
    }
    setSubmitting(true);
    try {
      let outcome = await onSubmit(buildRequest());
      if (outcome.status === "failed" && outcome.error.code === "paste-expired" && pasteActive) {
        // The paste vault forgets values after 15 minutes: parse again silently and retry once.
        const fresh = await mcpApi.parsePaste(pasteText);
        const byName = new Map(fresh.candidates.map(item => [item.name.toLowerCase(), item]));
        const request = buildRequest();
        request.pasteHandle = fresh.pasteHandle ?? undefined;
        request.candidates = request.candidates.map(entry => {
          const match = byName.get(entry.input.name.toLowerCase());
          if (!match) return entry;
          const secretsIn = (entry.input.secrets ?? []).map(secret => {
            const freshSecret = match.input.secrets?.find(item => item.name === secret.name && item.kind === secret.kind);
            return secret.pasteValueHandle && freshSecret?.pasteValueHandle ? { ...secret, pasteValueHandle: freshSecret.pasteValueHandle } : secret;
          });
          return { ...entry, input: { ...entry.input, secrets: secretsIn } };
        });
        outcome = await onSubmit(request);
      }
      if (outcome.status === "done") {
        onClose();
        return;
      }
      if (outcome.status === "failed") setSubmitError(errorText(outcome.error, t, clients));
    } finally {
      clearSecretState();
      setSubmitting(false);
    }
  }

  // ---------- render helpers ----------
  const resultLine = (() => {
    if (parsing) return <span className="mcp-muted"><Spinner /> {t("mcp.add.parsing")}</span>;
    if (pasteError) return <span className="mcp-field-error" role="alert">{pasteError}</span>;
    if (looksLikeGithub(pasteText) && !result) {
      return (
        <span className="mcp-paste-github">
          {t("mcp.add.githubDetected")}
          <button className="mcp-btn small solid" onClick={() => void runGithub(pasteText)} type="button">
            <Glyph name="import" /> {t("mcp.add.readGithub")}
          </button>
        </span>
      );
    }
    if (!result) return null;
    if (result.format === "unrecognized") return <span className="mcp-field-error" role="alert">{t("mcp.err.paste-unrecognized")}</span>;
    return (
      <span className="mcp-paste-ok">
        <Glyph name="check" />
        {result.sourceDisplay
          ? t("mcp.add.recognizedFrom", { source: result.sourceDisplay, n: candidates.length })
          : t("mcp.add.recognized", { format: t(`mcp.format.${result.format}`), n: candidates.length })}
      </span>
    );
  })();

  const submitLabel = (() => {
    if (submitting) return t("mcp.add.adding");
    if (pasteActive && (includedCandidates.length > 1 || replacedCount > 0)) {
      return replacedCount > 0
        ? t("mcp.add.batchReplace", { count: addCount, replaced: replacedCount, n: targetCount })
        : t("mcp.add.batch", { count: addCount, n: targetCount });
    }
    return targetCount > 0 ? t("mcp.add.submit", { n: targetCount }) : t("mcp.add.submitLibraryOnly");
  })();

  function secretRowView(row: SecretRow) {
    const problem = attempted ? secretProblems.get(row.id) : undefined;
    const label = row.kind === "header" ? t("mcp.add.header") : t("mcp.word.apiKey");
    return (
      <div className="mcp-secret-row" key={row.id}>
        <div className="mcp-secret-fields">
          <label className="mcp-field compact">
            <span>{row.kind === "header" ? t("mcp.add.headerName") : t("mcp.add.secretName")}</span>
            <input
              aria-invalid={Boolean(problem && problem.includes(".env.")) || undefined}
              autoComplete="off"
              onChange={event => setSecrets(rows => rows.map(item => (item.id === row.id ? { ...item, name: event.target.value } : item)))}
              placeholder={row.kind === "header" ? "Authorization" : "CONTEXT7_API_KEY"}
              spellCheck={false}
              value={row.name}
            />
          </label>
          {row.kind === "header" && (
            <label className="mcp-field compact">
              <span>{t("mcp.add.headerVar")}</span>
              <input
                autoComplete="off"
                onChange={event => setSecrets(rows => rows.map(item => (item.id === row.id ? { ...item, envVar: event.target.value } : item)))}
                placeholder="GITHUB_PERSONAL_ACCESS_TOKEN"
                spellCheck={false}
                value={row.envVar}
              />
            </label>
          )}
          <label className="mcp-field compact grow">
            <span>
              {label}
              {!row.required && <em className="mcp-optional">{t("mcp.add.optional")}</em>}
            </span>
            <span className="mcp-secret-input">
              <input
                aria-invalid={Boolean(problem && !problem.includes(".env.")) || undefined}
                autoComplete="off"
                disabled={row.later}
                name={`mcp-secret-${row.id}`}
                onChange={event => setSecrets(rows => rows.map(item => (item.id === row.id ? { ...item, value: event.target.value } : item)))}
                placeholder={row.later ? t("mcp.add.later") : t("mcp.add.secretPlaceholder")}
                ref={element => {
                  if (element) secretRefs.current.set(row.id, element);
                  else secretRefs.current.delete(row.id);
                }}
                spellCheck={false}
                type={shown[row.id] ? "text" : "password"}
                value={row.value}
              />
              <button
                aria-label={shown[row.id] ? t("mcp.add.hideValue") : t("mcp.add.showValue")}
                aria-pressed={Boolean(shown[row.id])}
                className="mcp-icon-button small"
                disabled={!row.value}
                onClick={() => setShown(current => ({ ...current, [row.id]: !current[row.id] }))}
                title={shown[row.id] ? t("mcp.add.hideValue") : t("mcp.add.showValue")}
                type="button"
              >
                <Glyph name="key" />
              </button>
            </span>
          </label>
          <button aria-label={t("mcp.add.removeSecret")} className="mcp-icon-button small mcp-secret-remove" onClick={() => setSecrets(rows => rows.filter(item => item.id !== row.id))} title={t("mcp.add.removeSecret")} type="button">
            <Glyph name="close" />
          </button>
        </div>
        {problem && <p className="mcp-field-error">{t(problem)}</p>}
        <div className="mcp-secret-options">
          {row.required && (
            <label className="mcp-check">
              <input checked={row.later} onChange={event => setSecrets(rows => rows.map(item => (item.id === row.id ? { ...item, later: event.target.checked, value: "" } : item)))} type="checkbox" />
              {t("mcp.add.fillLater")}
            </label>
          )}
          <span className="mcp-radio-group" role="radiogroup" aria-label={t("mcp.add.saveTo")}>
            <span className="mcp-muted">{t("mcp.add.saveTo")}</span>
            <label className="mcp-check">
              <input checked={row.mode === "user_env"} name={`mode-${row.id}`} onChange={() => setSecrets(rows => rows.map(item => (item.id === row.id ? { ...item, mode: "user_env" } : item)))} type="radio" />
              {t("mcp.add.modeUserEnv")}
            </label>
            <label className="mcp-check">
              <input checked={row.mode === "inline"} name={`mode-${row.id}`} onChange={() => setSecrets(rows => rows.map(item => (item.id === row.id ? { ...item, mode: "inline" } : item)))} type="radio" />
              {t("mcp.add.modeInline")}
            </label>
          </span>
          {row.helpUrl && (
            <button className="mcp-link" onClick={() => onOpenUrl(row.helpUrl ?? "")} type="button">
              {t("mcp.add.whereKey")} <Glyph name="external" />
            </button>
          )}
        </div>
      </div>
    );
  }

  function candidateView(group: McpCandidate[]) {
    const head = group[0];
    const choice = choices[head.key];
    if (!choice) return null;
    const candidate = activeCandidate(group);
    const variants = head.variants.length > 0 ? head.variants : candidate.variants;
    const nameEditable = candidate.nameSuggested || !candidate.nameValid;
    const nameProblemKey = attempted ? candidateProblems.get(head.key) : undefined;
    return (
      <li className={`mcp-candidate${choice.include ? "" : " excluded"}`} key={head.key}>
        <label className="mcp-candidate-main">
          <input checked={choice.include} onChange={event => updateChoice(head.key, { include: event.target.checked })} type="checkbox" />
          {nameEditable ? (
            <input
              aria-invalid={Boolean(nameProblemKey) || undefined}
              aria-label={t("mcp.add.name")}
              className="mcp-candidate-name-input"
              onChange={event => updateChoice(head.key, { name: event.target.value })}
              onClick={event => event.preventDefault()}
              spellCheck={false}
              value={choice.name}
            />
          ) : (
            <strong className="mcp-candidate-name">{candidate.name}</strong>
          )}
          <span className="mcp-candidate-target" title={candidate.targetDisplay}>{candidate.targetDisplay}</span>
        </label>
        <div className="mcp-candidate-status">
          {candidate.exists === "new" && <span className="mcp-tag ok">{t("mcp.add.isNew")}</span>}
          {candidate.exists === "same" && <span className="mcp-tag">{t("mcp.add.isSame")}</span>}
          {candidate.exists === "different" && (
            <>
              <span className="mcp-tag warn">
                {candidate.differsIn.length > 0
                  ? t("mcp.add.existsDiffersIn", { clients: candidate.differsIn.map(id => clients.find(item => item.id === id)?.label ?? id).join(t("mcp.list.sep")) })
                  : t("mcp.add.existsDiffers")}
              </span>
              <span className="mcp-segmented" role="radiogroup" aria-label={t("mcp.add.conflictChoice", { name: candidate.name })}>
                <button aria-checked={choice.onConflict === "skip"} className={choice.onConflict === "skip" ? "active" : ""} onClick={() => updateChoice(head.key, { onConflict: "skip" })} role="radio" type="button">
                  {t("mcp.add.skip")}
                </button>
                <button aria-checked={choice.onConflict === "overwrite"} className={choice.onConflict === "overwrite" ? "active" : ""} onClick={() => updateChoice(head.key, { onConflict: "overwrite" })} role="radio" type="button">
                  {t("mcp.add.overwrite")}
                </button>
              </span>
            </>
          )}
        </div>
        {nameProblemKey && <p className="mcp-field-error">{t(nameProblemKey)}</p>}
        {variants.length > 1 && (
          <label className="mcp-variant">
            <span className="mcp-muted">{t("mcp.add.variants")}</span>
            <select
              onChange={event => {
                if (group.some(item => item.key === event.target.value)) updateChoice(head.key, { activeKey: event.target.value });
              }}
              value={candidate.key}
            >
              {variants.map(variant => (
                <option disabled={!group.some(item => item.key === variant.key) && variant.key !== candidate.key} key={variant.key} value={variant.key}>
                  {variant.targetDisplay}{variant.preferred ? ` · ${t("mcp.add.recommended")}` : ""}
                </option>
              ))}
            </select>
          </label>
        )}
        {candidate.warnings.length > 0 && (
          <ul className="mcp-candidate-warnings">
            {candidate.warnings.map(warning => <li key={warning}>{t(`mcp.add.warn.${warning}`)}</li>)}
          </ul>
        )}
        {choice.include && candidate.secrets.length > 0 && (
          <div className="mcp-candidate-secrets">
            {candidate.secrets.map(secret => {
              const replacing = choice.replace[secret.name];
              const problem = attempted ? candidateProblems.get(`${head.key}:${secret.name}`) : undefined;
              if (secret.hasPastedValue && !replacing) {
                return (
                  <div className="mcp-candidate-secret" key={secret.name}>
                    <Glyph name="key" />
                    <span>{t("mcp.add.secretFromPaste", { name: secret.envVar ?? secret.name })}</span>
                    <code>••••••••</code>
                    <button className="mcp-link" onClick={() => updateChoice(head.key, { replace: { ...choice.replace, [secret.name]: true } })} type="button">{t("mcp.add.replace")}</button>
                  </div>
                );
              }
              return (
                <div className="mcp-candidate-secret editing" key={secret.name}>
                  <Glyph name="key" />
                  <span>{t("mcp.add.needsKeyNamed", { name: secret.envVar ?? secret.name })}</span>
                  <input
                    aria-invalid={Boolean(problem) || undefined}
                    aria-label={t("mcp.add.secretValueFor", { name: secret.envVar ?? secret.name })}
                    autoComplete="off"
                    disabled={Boolean(choice.later[secret.name])}
                    onChange={event => updateChoice(head.key, { values: { ...choice.values, [secret.name]: event.target.value } })}
                    placeholder={choice.later[secret.name] ? t("mcp.add.later") : t("mcp.add.secretPlaceholder")}
                    spellCheck={false}
                    type="password"
                    value={choice.values[secret.name] ?? ""}
                  />
                  <label className="mcp-check">
                    <input
                      checked={Boolean(choice.later[secret.name])}
                      onChange={event => updateChoice(head.key, { later: { ...choice.later, [secret.name]: event.target.checked }, values: { ...choice.values, [secret.name]: "" } })}
                      type="checkbox"
                    />
                    {t("mcp.add.fillLater")}
                  </label>
                  {problem && <p className="mcp-field-error">{t(problem)}</p>}
                </div>
              );
            })}
          </div>
        )}
      </li>
    );
  }

  const workspacesOptions = workspaces.flatMap(workspace => [
    { value: `local:${workspace.id}`, label: t("mcp.scope.localNamed", { project: workspace.label }) },
    { value: `project:${workspace.id}`, label: t("mcp.scope.projectNamed", { project: workspace.label }) }
  ]);

  return (
    <Overlay initialFocus={initialTemplate ? undefined : pasteRef} label={t("mcp.add.title")} onClose={requestClose} variant="sheet">
      <header className="mcp-overlay-head">
        <h2>{t("mcp.add.title")}</h2>
        {preview && <span className="mcp-tag">{t("mcp.preview.badge")}</span>}
        <button aria-label={t("mcp.common.close")} className="mcp-icon-button" onClick={requestClose} title={t("mcp.common.close")} type="button">
          <Glyph name="close" />
        </button>
      </header>

      <div className="mcp-sheet-body" ref={sheetBodyRef}>
        <section className="mcp-paste">
          <label className="mcp-sr-label sr-only" htmlFor="mcp-paste-box">{t("mcp.add.pasteLabel")}</label>
          <textarea
            id="mcp-paste-box"
            onChange={event => {
              setPasteText(event.target.value);
              schedulePaste(event.target.value);
            }}
            onPaste={event => {
              const text = event.clipboardData.getData("text");
              if (text) {
                const next = pasteText ? `${pasteText}${text}` : text;
                window.setTimeout(() => schedulePaste(pasteRef.current?.value ?? next, true), 0);
              }
            }}
            placeholder={t("mcp.add.pastePlaceholder")}
            ref={pasteRef}
            rows={pasteActive ? 4 : 5}
            spellCheck={false}
            value={pasteText}
          />
          <div aria-live="polite" className="mcp-paste-result">{resultLine}</div>
          {result?.notices.includes("has-verified-recipe") && (
            <p className="mcp-callout info">
              <Glyph name="check" />
              <span>{t("mcp.add.verifiedRecipe")}</span>
              <button className="mcp-btn small quiet" onClick={onOpenDiscover} type="button">{t("mcp.add.goDiscover")}</button>
            </p>
          )}
          {result?.notices.includes("readme-example") && <p className="mcp-muted small">{t("mcp.add.readmeExample")}</p>}
          {pasteActive && (
            <>
              <ul className="mcp-candidates">{groups.map(candidateView)}</ul>
              {includedCandidates.some(item => item.candidate.secrets.length > 0) && (
                <div className="mcp-radio-group batch" role="radiogroup" aria-label={t("mcp.add.saveTo")}>
                  <span className="mcp-muted">{t("mcp.add.saveTo")}</span>
                  <label className="mcp-check">
                    <input checked={batchMode === "user_env"} name="batch-mode" onChange={() => setBatchMode("user_env")} type="radio" />
                    {t("mcp.add.modeUserEnv")}
                  </label>
                  <label className="mcp-check">
                    <input checked={batchMode === "inline"} name="batch-mode" onChange={() => setBatchMode("inline")} type="radio" />
                    {t("mcp.add.modeInline")}
                  </label>
                </div>
              )}
            </>
          )}
          {result && result.skipped.length > 0 && (
            <details className="mcp-skipped">
              <summary>{t("mcp.add.skippedCount", { n: result.skipped.length })}</summary>
              <ul>
                {result.skipped.map((item, index) => (
                  <li key={`${item.name}-${index}`}><strong>{item.name}</strong> · {t(`mcp.skip.${item.reason}`)}</li>
                ))}
              </ul>
            </details>
          )}
        </section>

        <section className="mcp-templates" aria-label={t("mcp.add.fromTemplate")}>
          <span className="mcp-section-label">{t("mcp.add.fromTemplate")}</span>
          <div className="mcp-chip-row">
            {templates === null && <Spinner />}
            {(templates ?? []).map(template => (
              <button
                aria-pressed={templateId === template.id}
                className={`mcp-template-chip${templateId === template.id ? " active" : ""}`}
                key={template.id}
                onClick={() => applyTemplate(template)}
                type="button"
              >
                {template.id}
              </button>
            ))}
            <button className="mcp-link" onClick={onOpenDiscover} type="button">{t("mcp.add.moreInDiscover")}</button>
          </div>
        </section>

        <section className={`mcp-manual${manualOpen ? " open" : ""}`}>
          <button aria-expanded={manualOpen} className="mcp-divider-button" onClick={() => setManualOpen(value => !value)} type="button">
            <span>{t("mcp.add.orManual")}</span>
            <Glyph className={manualOpen ? "open" : ""} name="chevron" />
          </button>
          {manualOpen && (
            <div className="mcp-form">
              <label className="mcp-field">
                <span>{t("mcp.add.name")}</span>
                <input
                  aria-invalid={(attempted && Boolean(nameProblem)) || undefined}
                  autoComplete="off"
                  onChange={event => setName(event.target.value)}
                  placeholder="context7"
                  ref={nameRef}
                  spellCheck={false}
                  value={name}
                />
                {attempted && nameProblem && <span className="mcp-field-error">{t(`mcp.add.err.name.${nameProblem}`)}</span>}
              </label>
              <label className="mcp-field">
                <span>{t("mcp.add.target")}</span>
                <input
                  aria-invalid={(attempted && Boolean(targetProblem)) || undefined}
                  autoComplete="off"
                  onChange={event => setTarget(event.target.value)}
                  placeholder={t("mcp.add.targetPlaceholder")}
                  ref={targetRef}
                  spellCheck={false}
                  value={target}
                />
                {attempted && targetProblem ? (
                  <span className="mcp-field-error">{t(targetProblem)}</span>
                ) : target.trim() ? (
                  <span className="mcp-field-hint">
                    {transport === "stdio" ? t("mcp.add.kindLocal") : transport === "sse" ? t("mcp.add.kindSse") : t("mcp.add.kindRemote")}
                    {commandCheck?.kind === "ok" && commandCheck.unwrapped ? ` · ${t("mcp.add.cmdUnwrapped")}` : ""}
                  </span>
                ) : null}
              </label>
              {transport === "stdio" && commandCheck?.kind === "ok" && commandCheck.command && (
                <div aria-label={t("mcp.add.parts")} className="mcp-arg-preview">
                  <span className="mcp-arg command" title={t("mcp.add.command")}>{commandCheck.command}</span>
                  {manualArgs.map((arg, index) => (
                    <span className={`mcp-arg${folder && index === folder.argIndex ? " param" : ""}`} key={`${arg}-${index}`}>
                      {arg || t("mcp.add.folderSlot")}
                    </span>
                  ))}
                </div>
              )}
              {folder && (
                <label className="mcp-field">
                  <span>{t("mcp.add.folder")}</span>
                  <input
                    aria-invalid={(attempted && Boolean(folderProblem)) || undefined}
                    autoComplete="off"
                    onChange={event => setFolder({ ...folder, value: event.target.value })}
                    placeholder={t("mcp.add.folderPlaceholder")}
                    ref={folderRef}
                    spellCheck={false}
                    value={folder.value}
                  />
                  {attempted && folderProblem ? <span className="mcp-field-error">{t(folderProblem)}</span> : <span className="mcp-field-hint">{t("mcp.add.folderHint")}</span>}
                </label>
              )}

              {secrets.map(secretRowView)}
              <div className="mcp-inline-actions">
                <button className="mcp-btn small quiet" onClick={() => setSecrets(rows => [...rows, emptySecret("env")])} type="button">
                  <Glyph name="plus" /> {t("mcp.add.addKey")}
                </button>
                {transport !== "stdio" && (
                  <button className="mcp-btn small quiet" onClick={() => setSecrets(rows => [...rows, emptySecret("header")])} type="button">
                    <Glyph name="plus" /> {t("mcp.add.addBearer")}
                  </button>
                )}
              </div>

              <details className="mcp-advanced">
                <summary>{t("mcp.add.advanced")}</summary>
                <div className="mcp-advanced-grid">
                  <label className="mcp-field">
                    <span>{t("mcp.add.scope")}</span>
                    <select onChange={event => setPlacement(event.target.value)} value={placement}>
                      <option value="user">{t("mcp.scope.user")}</option>
                      {workspacesOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                    </select>
                    {workspaces.length === 0 && <span className="mcp-field-hint">{t("mcp.scope.noProjects")}</span>}
                  </label>
                  <label className="mcp-field">
                    <span>{t("mcp.add.transport")}</span>
                    <select onChange={event => setTransportChoice(event.target.value as TransportChoice)} value={transportChoice}>
                      <option value="auto">{t("mcp.transport.auto")}</option>
                      <option value="stdio">{t("mcp.transport.stdio")}</option>
                      <option value="http">{t("mcp.transport.http")}</option>
                      <option value="sse">{t("mcp.transport.sse")}</option>
                    </select>
                  </label>
                  {transport === "stdio" && (
                    <label className="mcp-field">
                      <span>{t("mcp.add.cwd")}</span>
                      <input autoComplete="off" onChange={event => setCwd(event.target.value)} placeholder={t("mcp.add.cwdPlaceholder")} spellCheck={false} value={cwd} />
                    </label>
                  )}
                  <label className="mcp-check">
                    <input checked={codexRequired} onChange={event => setCodexRequired(event.target.checked)} type="checkbox" />
                    {t("mcp.add.codexRequired")}
                  </label>
                </div>
                {transport === "stdio" && (
                  <div className="mcp-plain-env">
                    <span className="mcp-section-label">{t("mcp.add.plainEnv")}</span>
                    {envRows.map(row => (
                      <div className="mcp-env-row" key={row.id}>
                        <input aria-label={t("mcp.add.envName")} autoComplete="off" onChange={event => setEnvRows(rows => rows.map(item => (item.id === row.id ? { ...item, name: event.target.value } : item)))} placeholder="PORT" spellCheck={false} value={row.name} />
                        <span aria-hidden="true">=</span>
                        <input aria-label={t("mcp.add.envValue")} autoComplete="off" onChange={event => setEnvRows(rows => rows.map(item => (item.id === row.id ? { ...item, value: event.target.value } : item)))} placeholder="8085" spellCheck={false} value={row.value} />
                        <button aria-label={t("mcp.add.removeSecret")} className="mcp-icon-button small" onClick={() => setEnvRows(rows => rows.filter(item => item.id !== row.id))} type="button"><Glyph name="close" /></button>
                      </div>
                    ))}
                    {envProblem && attempted && <p className="mcp-field-error">{t(envProblem)}</p>}
                    <button className="mcp-btn small quiet" onClick={() => setEnvRows(rows => [...rows, { id: nextId(), name: "", value: "" }])} type="button">
                      <Glyph name="plus" /> {t("mcp.add.addPlainEnv")}
                    </button>
                    <p className="mcp-field-hint">{t("mcp.add.plainEnvHint")}</p>
                  </div>
                )}
              </details>
            </div>
          )}
        </section>
      </div>

      <footer className="mcp-sheet-foot">
        <div className="mcp-targets" role="group" aria-label={t("mcp.add.writeTo")}>
          <span className="mcp-section-label">{t("mcp.add.writeTo")}</span>
          <div className="mcp-chip-row">
            {availability.map(({ client, available, reason, partial }) => {
              const on = available && pickedIds.includes(client.id);
              return (
                <button
                  aria-pressed={on}
                  className={`mcp-client-chip${on ? " on" : ""}${available ? "" : " unavailable"}`}
                  disabled={!available}
                  key={client.id}
                  onClick={() => {
                    const base = picked ?? defaultPicked;
                    setPicked(on ? base.filter(id => id !== client.id) : [...base, client.id]);
                  }}
                  title={!available && reason ? t(`mcp.add.unavailable.${reason}`, { client: client.label }) : partial && reason ? t(`mcp.add.partial.${reason}`, { client: client.label }) : client.configPathDisplay}
                  type="button"
                >
                  <span className="mcp-chip-box" aria-hidden="true">{on ? <Glyph name="check" /> : null}</span>
                  {client.label}
                  {!available && reason && <em>{t(`mcp.add.unavailableShort.${reason}`)}</em>}
                </button>
              );
            })}
          </div>
          {desktopNeedsConsent && (
            <label className="mcp-check mcp-consent">
              <input checked={inlineDesktop} onChange={event => setInlineDesktop(event.target.checked)} type="checkbox" />
              {t("mcp.add.desktopInline")}
            </label>
          )}
        </div>
        {confirmDiscard ? (
          <div className="mcp-discard" role="alert">
            <span>{t("mcp.add.discardAsk")}</span>
            <button className="mcp-btn quiet" onClick={() => setConfirmDiscard(false)} type="button">{t("mcp.add.keepEditing")}</button>
            <button className="mcp-btn solid danger" onClick={onClose} type="button">{t("mcp.add.discard")}</button>
          </div>
        ) : (
          <div className="mcp-foot-actions">
            {submitError && <span className="mcp-field-error" role="alert">{submitError}</span>}
            <button className="mcp-btn quiet" disabled={submitting} onClick={requestClose} type="button">{t("mcp.common.cancel")}</button>
            <button className="mcp-btn solid" disabled={submitting || (!pasteActive && !manualOpen && !templateId)} onClick={() => void submit()} ref={submitRef} type="button">
              {submitting ? <Spinner /> : <Glyph name="plus" />} {submitLabel}
            </button>
          </div>
        )}
      </footer>
    </Overlay>
  );
}
