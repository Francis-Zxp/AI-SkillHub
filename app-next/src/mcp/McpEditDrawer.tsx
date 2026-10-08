// Edit drawer (contract §6.4, M1-7): full prefill from mcp_get_server. The transport always starts
// from the stored value (bug #6: http was reset to stdio). Secret values are never shown; replacing
// one opens a masked input whose value is cleared as soon as the request settles.
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  McpCell,
  McpClient,
  McpClientId,
  McpError,
  McpLibrarySnapshot,
  McpScope,
  McpSecretInput,
  McpSecretMode,
  McpSecretStatus,
  McpServerDetail,
  McpServerInput,
  McpServerRow,
  McpSetSecretRequest,
  McpTransport,
  McpUpdateRequest
} from "./mcpTypes";
import { SECRET_MASK } from "./mcpTypes";
import { mcpApi } from "./mcpApi";
import {
  argsContainCredential,
  cellReasonText,
  cellStateText,
  clientLabel,
  errorText,
  normalizeCommand,
  testText,
  testTone,
  validateEnvName,
  validateRemoteUrl
} from "./mcpLogic";
import { Glyph, Overlay, Spinner, t } from "./mcpUi";
import type { AddSubmitResult } from "./McpAddSheet";

type Props = {
  serverId: string;
  focus?: "secret";
  snapshot: McpLibrarySnapshot;
  pending: ReadonlySet<string>;
  onClose: () => void;
  onSave: (request: McpUpdateRequest) => Promise<AddSubmitResult>;
  onSetSecret: (request: McpSetSecretRequest) => Promise<AddSubmitResult>;
  onCell: (row: McpServerRow, client: McpClient, cell: McpCell) => void;
  onOpenLocation: (clientId: McpClientId, scope?: McpScope, workspaceId?: string) => void;
  onRemoveFromClient: (serverId: string, clientId: McpClientId) => void;
  onDelete: (serverId: string) => void;
  onTest: (serverId: string) => void;
  onOpenUrl: (url: string) => void;
};

type ArgRow = { id: number; value: string; masked: boolean };
type EnvRow = { id: number; name: string; value: string };
type NewSecret = { id: number; kind: "env" | "header"; name: string; envVar: string; value: string; mode: McpSecretMode };
type Form = {
  transport: McpTransport;
  command: string;
  args: ArgRow[];
  url: string;
  cwd: string;
  env: EnvRow[];
  codexRequired: boolean;
};

let counter = 0;
const nextId = () => {
  counter += 1;
  return counter;
};

function formFrom(detail: McpServerDetail): Form {
  return {
    transport: detail.transport,
    command: detail.command ?? "",
    args: detail.args.map(arg => ({ id: nextId(), value: arg.masked ? SECRET_MASK : arg.value, masked: arg.masked })),
    url: detail.url ?? "",
    cwd: detail.cwd ?? "",
    env: detail.env.map(row => ({ id: nextId(), ...row })),
    codexRequired: detail.codexRequired
  };
}

function formKey(form: Form) {
  return JSON.stringify({ ...form, args: form.args.map(arg => [arg.value, arg.masked]), env: form.env.map(row => [row.name, row.value]) });
}

function storageText(secret: McpSecretStatus) {
  if (secret.storage === "user_env") return t("mcp.edit.storedUserEnv", { name: secret.envVar ?? secret.name });
  if (secret.storage === "library") return t("mcp.edit.storedLibrary");
  if (secret.storage === "external") return t("mcp.edit.storedExternal", { name: secret.envVar ?? secret.name });
  return "";
}

export function McpEditDrawer(props: Props) {
  const { serverId, focus, snapshot, pending, onClose } = props;
  const [detail, setDetail] = useState<McpServerDetail | null>(null);
  const [loadError, setLoadError] = useState("");
  const [form, setForm] = useState<Form | null>(null);
  const [initialKey, setInitialKey] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [attempted, setAttempted] = useState(false);
  const [replacing, setReplacing] = useState<Record<string, boolean>>({});
  const [secretValues, setSecretValues] = useState<Record<string, string>>({});
  const [secretModes, setSecretModes] = useState<Record<string, McpSecretMode>>({});
  const [secretBusy, setSecretBusy] = useState("");
  const [secretErrors, setSecretErrors] = useState<Record<string, string>>({});
  const [newSecrets, setNewSecrets] = useState<NewSecret[]>([]);
  const firstSecretRef = useRef<HTMLInputElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const loadSeq = useRef(0);

  const row = snapshot.servers.find(item => item.id === serverId) ?? null;
  const clients = useMemo(() => snapshot.clients.filter(client => client.detected || client.enabledCount > 0), [snapshot.clients]);

  async function load(reasonNotice = "") {
    const seq = ++loadSeq.current;
    try {
      const next = await mcpApi.getServer(serverId);
      if (seq !== loadSeq.current) return;
      setDetail(next);
      const nextForm = formFrom(next);
      setForm(nextForm);
      setInitialKey(formKey(nextForm));
      setNewSecrets([]);
      setLoadError("");
      setNotice(reasonNotice);
      if (focus === "secret") {
        const missing = next.secrets.filter(secret => !secret.present).map(secret => secret.name);
        if (missing.length > 0) setReplacing(current => ({ ...current, ...Object.fromEntries(missing.map(name => [name, true])) }));
      }
    } catch (raw) {
      if (seq !== loadSeq.current) return;
      setLoadError(errorText(raw as McpError, t, clients));
    }
  }

  useEffect(() => {
    void load();
    // Reload only when the drawer is pointed at another server.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId]);

  // Another writer (a toggle in the matrix, a test, Undo) changed this server: refresh the read-only
  // parts silently, and the form too when the user has not started editing.
  const rowRevision = row?.specRevision;
  useEffect(() => {
    if (!detail || rowRevision === undefined || rowRevision === detail.specRevision) return;
    if (form && formKey(form) === initialKey && newSecrets.length === 0) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowRevision]);

  useEffect(() => {
    if (focus === "secret" && detail) window.requestAnimationFrame(() => firstSecretRef.current?.focus());
  }, [focus, detail]);

  const dirty = Boolean(form && (formKey(form) !== initialKey || newSecrets.length > 0));
  const transportChanged = Boolean(detail && form && form.transport !== detail.transport);

  const problems = useMemo(() => {
    const list: Record<string, string> = {};
    if (!form) return list;
    if (form.transport === "stdio") {
      if (!form.command.trim()) list.command = "mcp.add.err.targetEmpty";
      else if (normalizeCommand(form.command, form.args.map(arg => arg.value)).kind === "shell") list.command = "mcp.add.err.shell";
      else if (argsContainCredential(form.args.filter(arg => !arg.masked).map(arg => arg.value))) list.args = "mcp.add.err.argSecret";
    } else {
      const problem = validateRemoteUrl(form.url);
      if (problem) list.url = `mcp.add.err.url.${problem}`;
    }
    if (form.env.some(row => row.name.trim() && validateEnvName(row.name))) list.env = "mcp.add.err.plainEnv";
    for (const secret of newSecrets) {
      const problem = secret.kind === "env" ? validateEnvName(secret.name) : secret.name.trim() ? null : "empty";
      if (problem) list[`new-${secret.id}`] = secret.kind === "env" ? `mcp.add.err.env.${problem}` : "mcp.add.err.headerName";
    }
    return list;
  }, [form, newSecrets]);

  const enabledCount = row ? row.cells.filter(cell => cell.state === "on" || cell.state === "changed-outside" || cell.state === "error").length : 0;

  function patch(next: Partial<Form>) {
    setForm(current => (current ? { ...current, ...next } : current));
  }

  function buildInput(): McpServerInput | null {
    if (!detail || !form) return null;
    const keepSecrets: McpSecretInput[] = detail.secrets.map(secret => ({
      kind: secret.kind,
      name: secret.name,
      envVar: secret.kind === "header" ? secret.envVar ?? undefined : undefined,
      headerTemplate: secret.headerTemplate,
      mode: secret.storage === "library" ? "inline" : "user_env",
      inlineClients: secret.inlineClients,
      required: secret.required
    }));
    const added: McpSecretInput[] = newSecrets.map(secret => ({
      kind: secret.kind,
      name: secret.name.trim(),
      envVar: secret.kind === "header" ? secret.envVar.trim() || undefined : undefined,
      headerTemplate: secret.kind === "header" ? "bearer" : undefined,
      value: secret.value.trim() ? secret.value : undefined,
      mode: secret.mode,
      required: true
    }));
    const base = {
      name: detail.name,
      displayName: detail.displayName,
      transport: form.transport,
      secrets: [...keepSecrets, ...added],
      codexRequired: form.codexRequired,
      source: detail.source
    };
    if (form.transport === "stdio") {
      const checked = normalizeCommand(form.command, form.args.map(arg => arg.value));
      const command = checked.kind === "ok" ? checked.command : form.command.trim();
      const args = checked.kind === "ok" ? checked.args : form.args.map(arg => arg.value);
      return {
        ...base,
        command,
        args,
        cwd: form.cwd.trim() || undefined,
        env: form.env.filter(row => row.name.trim()).map(row => ({ name: row.name.trim(), value: row.value }))
      };
    }
    return { ...base, url: form.url.trim() };
  }

  async function save() {
    setAttempted(true);
    setSaveError("");
    if (!detail || Object.keys(problems).length > 0) return;
    const input = buildInput();
    if (!input) return;
    setSaving(true);
    try {
      const outcome = await props.onSave({ serverId: detail.id, input, expectedRevision: detail.specRevision });
      if (outcome.status === "done") {
        onClose();
        return;
      }
      if (outcome.status === "failed") {
        if (outcome.error.code === "revision-conflict") await load(t("mcp.err.revision-conflict"));
        else setSaveError(errorText(outcome.error, t, clients));
      }
    } finally {
      setNewSecrets(rows => rows.map(row => ({ ...row, value: "" })));
      setSaving(false);
    }
  }

  async function saveSecret(secret: McpSecretStatus) {
    const value = secretValues[secret.name] ?? "";
    if (!value.trim()) {
      setSecretErrors(current => ({ ...current, [secret.name]: t("mcp.add.err.secretValue") }));
      return;
    }
    if (/[\r\n]/.test(value)) {
      setSecretErrors(current => ({ ...current, [secret.name]: t("mcp.add.err.secretNewline") }));
      return;
    }
    setSecretBusy(secret.name);
    setSecretErrors(current => ({ ...current, [secret.name]: "" }));
    try {
      const outcome = await props.onSetSecret({
        serverId,
        name: secret.name,
        value,
        mode: secretModes[secret.name] ?? (secret.storage === "library" ? "inline" : "user_env")
      });
      if (outcome.status === "done") {
        setReplacing(current => ({ ...current, [secret.name]: false }));
        await load();
      } else if (outcome.status === "failed") {
        setSecretErrors(current => ({ ...current, [secret.name]: errorText(outcome.error, t, clients) }));
      }
    } finally {
      setSecretValues(current => ({ ...current, [secret.name]: "" }));
      setSecretBusy("");
    }
  }

  function requestClose() {
    if (saving || secretBusy) return;
    onClose();
  }

  const test = row?.test ?? detail?.test ?? null;
  const tone = testTone(test, row?.missingSecretCount ?? 0);

  let firstSecretAssigned = false;

  return (
    <Overlay className="mcp-edit" initialFocus={titleRef} label={t("mcp.edit.title", { name: detail?.name ?? row?.name ?? "" })} onClose={requestClose} variant="drawer">
      <header className="mcp-overlay-head">
        <h2 ref={titleRef} tabIndex={-1}>{detail?.displayName || row?.displayName || t("mcp.edit.loading")}</h2>
        <button aria-label={t("mcp.common.close")} className="mcp-icon-button" onClick={requestClose} title={t("mcp.common.close")} type="button">
          <Glyph name="close" />
        </button>
      </header>
      <div className="mcp-sheet-body">
        {loadError && <p className="mcp-callout error" role="alert"><Glyph name="warn" /><span>{loadError}</span></p>}
        {!detail || !form ? (
          !loadError && <p className="mcp-muted"><Spinner /> {t("mcp.edit.loading")}</p>
        ) : (
          <>
            {notice && <p className="mcp-callout info" role="status"><Glyph name="refresh" /><span>{notice}</span></p>}

            <section className="mcp-edit-test">
              <span className={`mcp-status-dot tone-${tone}`} aria-hidden="true" />
              <span>{testText(test, t, row?.missingSecretCount ?? 0)}</span>
              <button className="mcp-btn small quiet" onClick={() => props.onTest(detail.id)} type="button">
                <Glyph name="play" /> {t("mcp.row.testConnection")}
              </button>
              {detail.meta.docsUrl && (
                <button className="mcp-link" onClick={() => props.onOpenUrl(detail.meta.docsUrl ?? "")} type="button">
                  {t("mcp.edit.docs")} <Glyph name="external" />
                </button>
              )}
            </section>

            <section className="mcp-form">
              <label className="mcp-field">
                <span>{t("mcp.add.name")}</span>
                <input readOnly title={t("mcp.edit.nameTip")} value={detail.name} />
                <span className="mcp-field-hint">{t("mcp.edit.nameTip")}</span>
              </label>
              <label className="mcp-field">
                <span>{t("mcp.add.transport")}</span>
                <select onChange={event => patch({ transport: event.target.value as McpTransport })} value={form.transport}>
                  <option value="stdio">{t("mcp.transport.stdio")}</option>
                  <option value="http">{t("mcp.transport.http")}</option>
                  <option value="sse">{t("mcp.transport.sse")}</option>
                </select>
                {transportChanged && <span className="mcp-field-hint warn">{t("mcp.edit.transportSwitch")}</span>}
              </label>

              {form.transport === "stdio" ? (
                <>
                  <label className="mcp-field">
                    <span>{t("mcp.add.command")}</span>
                    <input
                      aria-invalid={(attempted && Boolean(problems.command)) || undefined}
                      autoComplete="off"
                      onChange={event => patch({ command: event.target.value })}
                      spellCheck={false}
                      value={form.command}
                    />
                    {attempted && problems.command && <span className="mcp-field-error">{t(problems.command)}</span>}
                  </label>
                  <div className="mcp-field">
                    <span>{t("mcp.add.args")}</span>
                    <div className="mcp-args-editor">
                      {form.args.map((arg, index) => (
                        <span className="mcp-arg-input" key={arg.id}>
                          {arg.masked ? (
                            <input aria-label={t("mcp.edit.maskedArg")} readOnly title={t("mcp.edit.maskedArg")} value={SECRET_MASK} />
                          ) : (
                            <input
                              aria-label={t("mcp.edit.argN", { n: index + 1 })}
                              autoComplete="off"
                              onChange={event => patch({ args: form.args.map(item => (item.id === arg.id ? { ...item, value: event.target.value } : item)) })}
                              spellCheck={false}
                              value={arg.value}
                            />
                          )}
                          <button
                            aria-label={t("mcp.edit.removeArg")}
                            className="mcp-icon-button small"
                            disabled={index <= form.args.map(item => item.masked).lastIndexOf(true)}
                            onClick={() => patch({ args: form.args.filter(item => item.id !== arg.id) })}
                            title={index <= form.args.map(item => item.masked).lastIndexOf(true) ? t("mcp.edit.maskedArgOrder") : t("mcp.edit.removeArg")}
                            type="button"
                          >
                            <Glyph name="close" />
                          </button>
                        </span>
                      ))}
                      <button aria-label={t("mcp.edit.addArg")} className="mcp-btn small quiet" onClick={() => patch({ args: [...form.args, { id: nextId(), value: "", masked: false }] })} type="button">
                        <Glyph name="plus" />
                      </button>
                    </div>
                    {attempted && problems.args && <span className="mcp-field-error">{t(problems.args)}</span>}
                  </div>
                  <label className="mcp-field">
                    <span>{t("mcp.add.cwd")}</span>
                    <input autoComplete="off" onChange={event => patch({ cwd: event.target.value })} placeholder={t("mcp.add.cwdPlaceholder")} spellCheck={false} value={form.cwd} />
                  </label>
                </>
              ) : (
                <label className="mcp-field">
                  <span>{t("mcp.edit.url")}</span>
                  <input
                    aria-invalid={(attempted && Boolean(problems.url)) || undefined}
                    autoComplete="off"
                    onChange={event => patch({ url: event.target.value })}
                    placeholder="https://"
                    spellCheck={false}
                    value={form.url}
                  />
                  {attempted && problems.url && <span className="mcp-field-error">{t(problems.url)}</span>}
                </label>
              )}
            </section>

            <section className="mcp-edit-section">
              <h3>{t("mcp.edit.secrets")}</h3>
              {detail.secrets.length === 0 && newSecrets.length === 0 && <p className="mcp-muted small">{t("mcp.edit.noSecrets")}</p>}
              <ul className="mcp-secret-list">
                {detail.secrets.map(secret => {
                  const open = replacing[secret.name] || !secret.present;
                  const label = secret.kind === "header" ? `${secret.name}${secret.headerTemplate === "bearer" ? " · Bearer" : ""}` : secret.name;
                  const assignRef = open && !firstSecretAssigned;
                  if (assignRef) firstSecretAssigned = true;
                  return (
                    <li className={`mcp-secret-status${secret.present ? "" : " missing"}`} key={`${secret.kind}-${secret.name}`}>
                      <div className="mcp-secret-head">
                        <Glyph name="key" />
                        <strong>{label}</strong>
                        {secret.present ? (
                          <span className="mcp-muted">{t("mcp.edit.saved")} <code>{SECRET_MASK}</code> {storageText(secret)}</span>
                        ) : (
                          <span className="mcp-tag warn">{secret.required ? t("mcp.row.needsKey") : t("mcp.edit.optionalMissing")}</span>
                        )}
                        {secret.present && !replacing[secret.name] && (
                          <button className="mcp-link" onClick={() => setReplacing(current => ({ ...current, [secret.name]: true }))} type="button">{t("mcp.add.replace")}</button>
                        )}
                      </div>
                      {open && (
                        <div className="mcp-secret-editor">
                          <input
                            aria-invalid={Boolean(secretErrors[secret.name]) || undefined}
                            aria-label={t("mcp.add.secretValueFor", { name: secret.envVar ?? secret.name })}
                            autoComplete="off"
                            onChange={event => setSecretValues(current => ({ ...current, [secret.name]: event.target.value }))}
                            placeholder={t("mcp.add.secretPlaceholder")}
                            ref={assignRef ? firstSecretRef : undefined}
                            spellCheck={false}
                            type="password"
                            value={secretValues[secret.name] ?? ""}
                          />
                          <select
                            aria-label={t("mcp.add.saveTo")}
                            onChange={event => setSecretModes(current => ({ ...current, [secret.name]: event.target.value as McpSecretMode }))}
                            value={secretModes[secret.name] ?? (secret.storage === "library" ? "inline" : "user_env")}
                          >
                            <option value="user_env">{t("mcp.add.modeUserEnv")}</option>
                            <option value="inline">{t("mcp.add.modeInline")}</option>
                          </select>
                          <button className="mcp-btn small solid" disabled={secretBusy === secret.name} onClick={() => void saveSecret(secret)} type="button">
                            {secretBusy === secret.name ? <Spinner /> : null} {t("mcp.edit.saveKey")}
                          </button>
                          {secret.present && (
                            <button className="mcp-btn small quiet" onClick={() => {
                              setReplacing(current => ({ ...current, [secret.name]: false }));
                              setSecretValues(current => ({ ...current, [secret.name]: "" }));
                            }} type="button">{t("mcp.common.cancel")}</button>
                          )}
                          {secretErrors[secret.name] && <p className="mcp-field-error">{secretErrors[secret.name]}</p>}
                        </div>
                      )}
                    </li>
                  );
                })}
                {newSecrets.map(secret => (
                  <li className="mcp-secret-status new" key={secret.id}>
                    <div className="mcp-secret-editor">
                      <input
                        aria-invalid={(attempted && Boolean(problems[`new-${secret.id}`])) || undefined}
                        aria-label={secret.kind === "header" ? t("mcp.add.headerName") : t("mcp.add.secretName")}
                        autoComplete="off"
                        onChange={event => setNewSecrets(rows => rows.map(item => (item.id === secret.id ? { ...item, name: event.target.value } : item)))}
                        placeholder={secret.kind === "header" ? "Authorization" : "API_KEY"}
                        spellCheck={false}
                        value={secret.name}
                      />
                      {secret.kind === "header" && (
                        <input
                          aria-label={t("mcp.add.headerVar")}
                          autoComplete="off"
                          onChange={event => setNewSecrets(rows => rows.map(item => (item.id === secret.id ? { ...item, envVar: event.target.value } : item)))}
                          placeholder="API_TOKEN"
                          spellCheck={false}
                          value={secret.envVar}
                        />
                      )}
                      <input
                        aria-label={t("mcp.word.apiKey")}
                        autoComplete="off"
                        onChange={event => setNewSecrets(rows => rows.map(item => (item.id === secret.id ? { ...item, value: event.target.value } : item)))}
                        placeholder={t("mcp.add.secretPlaceholder")}
                        spellCheck={false}
                        type="password"
                        value={secret.value}
                      />
                      <button aria-label={t("mcp.add.removeSecret")} className="mcp-icon-button small" onClick={() => setNewSecrets(rows => rows.filter(item => item.id !== secret.id))} type="button">
                        <Glyph name="close" />
                      </button>
                    </div>
                    {attempted && problems[`new-${secret.id}`] && <p className="mcp-field-error">{t(problems[`new-${secret.id}`])}</p>}
                  </li>
                ))}
              </ul>
              <div className="mcp-inline-actions">
                <button className="mcp-btn small quiet" onClick={() => setNewSecrets(rows => [...rows, { id: nextId(), kind: "env", name: "", envVar: "", value: "", mode: "user_env" }])} type="button">
                  <Glyph name="plus" /> {t("mcp.add.addKey")}
                </button>
                {form.transport !== "stdio" && (
                  <button className="mcp-btn small quiet" onClick={() => setNewSecrets(rows => [...rows, { id: nextId(), kind: "header", name: "Authorization", envVar: "", value: "", mode: "user_env" }])} type="button">
                    <Glyph name="plus" /> {t("mcp.add.addBearer")}
                  </button>
                )}
              </div>
            </section>

            {form.transport === "stdio" && (
              <section className="mcp-edit-section">
                <h3>{t("mcp.add.plainEnv")}</h3>
                {form.env.map(row => (
                  <div className="mcp-env-row" key={row.id}>
                    <input aria-label={t("mcp.add.envName")} autoComplete="off" onChange={event => patch({ env: form.env.map(item => (item.id === row.id ? { ...item, name: event.target.value } : item)) })} spellCheck={false} value={row.name} />
                    <span aria-hidden="true">=</span>
                    <input aria-label={t("mcp.add.envValue")} autoComplete="off" onChange={event => patch({ env: form.env.map(item => (item.id === row.id ? { ...item, value: event.target.value } : item)) })} spellCheck={false} value={row.value} />
                    <button aria-label={t("mcp.add.removeSecret")} className="mcp-icon-button small" onClick={() => patch({ env: form.env.filter(item => item.id !== row.id) })} type="button"><Glyph name="close" /></button>
                  </div>
                ))}
                {attempted && problems.env && <p className="mcp-field-error">{t(problems.env)}</p>}
                <button className="mcp-btn small quiet" onClick={() => patch({ env: [...form.env, { id: nextId(), name: "", value: "" }] })} type="button">
                  <Glyph name="plus" /> {t("mcp.add.addPlainEnv")}
                </button>
              </section>
            )}

            <section className="mcp-edit-section">
              <h3>{t("mcp.edit.clients")}</h3>
              <ul className="mcp-client-list">
                {clients.map(client => {
                  const cell = row?.cells.find(item => item.clientId === client.id) ?? detail.cells.find(item => item.clientId === client.id);
                  if (!cell) return null;
                  const busy = pending.has(`${serverId}:${client.id}`);
                  const inert = cell.state === "unsupported" || cell.state === "readonly";
                  return (
                    <li key={client.id}>
                      <button
                        aria-disabled={inert || busy || undefined}
                        aria-pressed={cell.state === "on"}
                        className={`mcp-cell state-${cell.state} as-chip wide`}
                        onClick={() => {
                          if (!inert && !busy && row) props.onCell(row, client, cell);
                        }}
                        title={cell.reason ? cellReasonText(cell.reason, t, client.label) : undefined}
                        type="button"
                      >
                        <span className="mcp-chip-label">{client.label}</span>
                        <span className="mcp-cell-visual">{busy ? <Spinner /> : <span className={`mcp-dot ${cell.state === "on" ? "on" : "off"}`} />}</span>
                        <span className="mcp-cell-word">{cellStateText(cell, t, client.label)}</span>
                      </button>
                      <span className="mcp-client-tools">
                        {cell.presentInFile && client.writable && (
                          <button className="mcp-link subtle" onClick={() => props.onRemoveFromClient(serverId, client.id)} type="button">
                            {t("mcp.edit.removeFromFile")}
                          </button>
                        )}
                        <button
                          aria-label={`${t("mcp.col.openLocation")} · ${client.label}`}
                          className="mcp-icon-button small"
                          onClick={() => props.onOpenLocation(client.id)}
                          title={t("mcp.col.openLocation")}
                          type="button"
                        >
                          <Glyph name="folder" />
                        </button>
                      </span>
                    </li>
                  );
                })}
              </ul>
            </section>

            {detail.projectBindings.length > 0 && (
              <section className="mcp-edit-section">
                <h3>{t("mcp.edit.projects")}</h3>
                <ul className="mcp-project-list">
                  {detail.projectBindings.map((binding, index) => (
                    <li key={`${binding.clientId}-${binding.scope}-${binding.projectLabel}-${index}`}>
                      <strong>{binding.projectLabel}</strong>
                      <span className="mcp-muted">
                        {clientLabel(binding.clientId, clients)} · {t(`mcp.scope.${binding.scope}Short`)}
                      </span>
                      <span className={`mcp-tag ${binding.state === "on" ? "ok" : ""}`}>
                        {binding.state === "readonly"
                          ? binding.readonlyReason
                            ? cellReasonText(binding.readonlyReason, t, clientLabel(binding.clientId, clients))
                            : t("mcp.cell.readonly")
                          : t(binding.state === "on" ? "mcp.cell.on" : "mcp.cell.off")}
                      </span>
                      <button className="mcp-link" onClick={() => props.onOpenLocation(binding.clientId, binding.scope, binding.workspaceId)} type="button">
                        <Glyph name="folder" /> {t("mcp.col.openLocation")}
                      </button>
                    </li>
                  ))}
                </ul>
                <p className="mcp-field-hint">{t("mcp.edit.projectsHint")}</p>
              </section>
            )}

            <label className="mcp-check">
              <input checked={form.codexRequired} onChange={event => patch({ codexRequired: event.target.checked })} type="checkbox" />
              {t("mcp.add.codexRequired")}
            </label>
          </>
        )}
      </div>
      <footer className="mcp-sheet-foot row">
        <button className="mcp-btn quiet danger" disabled={!detail || saving} onClick={() => detail && props.onDelete(detail.id)} type="button">
          {t("mcp.row.delete")}
        </button>
        <span className="mcp-foot-spacer" />
        {saveError && <span className="mcp-field-error" role="alert">{saveError}</span>}
        <button className="mcp-btn quiet" disabled={saving} onClick={requestClose} type="button">{t("mcp.common.cancel")}</button>
        <button className="mcp-btn solid" disabled={!detail || saving || !dirty} onClick={() => void save()} type="button">
          {saving ? <Spinner /> : null} {t("mcp.edit.save", { n: enabledCount })}
        </button>
      </footer>
    </Overlay>
  );
}
