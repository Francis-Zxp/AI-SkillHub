// Server × AI tool matrix (contract §6.2). One click per cell; column and row menus for bulk work.
// Wide layout: a <table> with a sticky header. Narrow layout (< 760 px of page width): one card
// per server with a row of client chips. More than 200 rows are windowed against the page scroll.
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from "react";
import type { McpCell, McpClient, McpClientId, McpServerRow, McpTestProgressEvent } from "./mcpTypes";
import { cellFor, cellReasonText, cellStateText, columnStats, targetLine, testText, testTone } from "./mcpLogic";
import { Glyph, MenuButton, Spinner, t } from "./mcpUi";
import type { MenuItem } from "./mcpUi";

export const VIRTUAL_THRESHOLD = 200;
const ROW_HEIGHT = 60;
const OVERSCAN = 12;

export type MatrixHandlers = {
  onCell: (row: McpServerRow, client: McpClient, cell: McpCell) => void;
  onColumn: (clientId: McpClientId, enabled: boolean, serverIds?: string[]) => void;
  onOpenLocation: (clientId: McpClientId) => void;
  onRowAll: (row: McpServerRow, enabled: boolean) => void;
  onEdit: (row: McpServerRow, focus?: "secret") => void;
  onTest: (row: McpServerRow) => void;
  onCopyJson: (row: McpServerRow) => void;
  onDelete: (row: McpServerRow) => void;
};

type Props = MatrixHandlers & {
  columns: McpClient[];
  rows: McpServerRow[];
  totalRows: number;
  searchActive: boolean;
  pending: ReadonlySet<string>;
  testing: ReadonlyMap<string, McpTestProgressEvent["phase"]>;
  narrow: boolean;
  busy: boolean;
};

export function pendingKey(serverId: string, clientId: McpClientId) {
  return `${serverId}:${clientId}`;
}

function columnMenu(client: McpClient, rows: McpServerRow[], searchActive: boolean, handlers: MatrixHandlers, busy: boolean): MenuItem[] {
  const stats = columnStats(rows, client.id);
  const items: MenuItem[] = [{ kind: "text", label: t("mcp.col.enabledOf", { on: stats.on, total: stats.total }) }];
  if (!client.writable) {
    items.push({ kind: "text", tone: "warn", label: client.readonlyReason ? cellReasonText(client.readonlyReason, t, client.label) : t("mcp.cell.readonly") });
  } else {
    if (searchActive) items.push({ kind: "text", label: t("mcp.col.searchScope", { n: rows.length }) });
    items.push({
      kind: "action",
      icon: "check",
      label: t("mcp.col.enableRest", { n: stats.enableable }),
      disabled: busy || stats.enableable === 0,
      onSelect: () => handlers.onColumn(client.id, true, searchActive ? stats.enableableIds : undefined)
    });
    items.push({
      kind: "action",
      icon: "ban",
      label: t("mcp.col.disableAll"),
      disabled: busy || stats.on === 0,
      onSelect: () => handlers.onColumn(client.id, false, searchActive ? stats.onIds : undefined)
    });
  }
  items.push({ kind: "separator" });
  items.push({ kind: "action", icon: "folder", label: t("mcp.col.openLocation"), onSelect: () => handlers.onOpenLocation(client.id) });
  return items;
}

function rowMenu(row: McpServerRow, handlers: MatrixHandlers, busy: boolean): MenuItem[] {
  return [
    { kind: "action", icon: "check", label: t("mcp.row.enableAll"), disabled: busy, onSelect: () => handlers.onRowAll(row, true) },
    { kind: "action", icon: "ban", label: t("mcp.row.disableAll"), disabled: busy, onSelect: () => handlers.onRowAll(row, false) },
    { kind: "separator" },
    { kind: "action", icon: "key", label: t("mcp.row.edit"), onSelect: () => handlers.onEdit(row) },
    { kind: "action", icon: "play", label: t("mcp.row.testConnection"), onSelect: () => handlers.onTest(row) },
    { kind: "action", icon: "copy", label: t("mcp.row.copyJson"), onSelect: () => handlers.onCopyJson(row) },
    { kind: "separator" },
    { kind: "action", icon: "close", label: t("mcp.row.delete"), danger: true, disabled: busy, onSelect: () => handlers.onDelete(row) }
  ];
}

function cellVisual(cell: McpCell, pending: boolean) {
  if (pending) return <Spinner />;
  switch (cell.state) {
    case "on":
      return <span className="mcp-dot on" />;
    case "off":
      return <span className="mcp-dot off" />;
    case "error":
      return <><Glyph name="warn" /><span className="mcp-cell-word">{t("mcp.cell.retryShort")}</span></>;
    case "unsupported":
      return <><Glyph name="ban" /><span className="mcp-cell-word">{t("mcp.cell.unsupportedShort")}</span></>;
    case "readonly":
      return <><Glyph name="lock" /><span className="mcp-cell-word">{t("mcp.cell.readonlyShort")}</span></>;
    case "blocked":
      return <><Glyph name="unlock" /><span className="mcp-cell-word">{t(cell.reason === "missing-secret" ? "mcp.cell.needsKeyShort" : "mcp.cell.blockedShort")}</span></>;
    case "changed-outside":
      return <><Glyph name="flag" /><span className="mcp-cell-word">{t("mcp.cell.changedShort")}</span></>;
    default:
      return null;
  }
}

function cellTitle(cell: McpCell, client: McpClient): string {
  if (cell.state === "unsupported" || cell.state === "readonly") return cell.reason ? cellReasonText(cell.reason, t, client.label) : cellStateText(cell, t, client.label);
  if (cell.state === "error") return cell.errorMessage ? `${t("mcp.cell.error")} · ${cell.errorMessage}` : t("mcp.cell.error");
  if (cell.state === "changed-outside" && cell.reason) return cellReasonText(cell.reason, t, client.label);
  if (cell.state === "blocked") return cell.reason ? cellReasonText(cell.reason, t, client.label) : t("mcp.cell.blocked");
  return cellStateText(cell, t, client.label);
}

const CellButton = memo(function CellButton({
  row,
  client,
  cell,
  pending,
  r,
  c,
  active,
  onCell,
  chip = false
}: {
  row: McpServerRow;
  client: McpClient;
  cell: McpCell;
  pending: boolean;
  r: number;
  c: number;
  active: boolean;
  onCell: MatrixHandlers["onCell"];
  chip?: boolean;
}) {
  const inert = cell.state === "unsupported" || cell.state === "readonly";
  const stateText = cellStateText(cell, t, client.label);
  return (
    <button
      aria-disabled={inert || pending ? true : undefined}
      aria-label={t("mcp.cell.aria", { name: row.name, client: client.label, state: stateText })}
      aria-pressed={cell.state === "on"}
      className={`mcp-cell state-${cell.state}${pending ? " is-pending" : ""}${chip ? " as-chip" : ""}`}
      data-c={c}
      data-r={r}
      onClick={() => {
        if (!inert && !pending) onCell(row, client, cell);
      }}
      tabIndex={active ? 0 : -1}
      title={cellTitle(cell, client)}
      type="button"
    >
      {chip && <span className="mcp-chip-label">{client.label}</span>}
      <span className="mcp-cell-visual">{cellVisual(cell, pending)}</span>
      {!chip && cell.projectCount > 0 && <span className="mcp-cell-badge">{t("mcp.cell.projects", { n: cell.projectCount })}</span>}
    </button>
  );
});

function StatusDot({ row, phase }: { row: McpServerRow; phase?: McpTestProgressEvent["phase"] }) {
  if (phase && phase !== "done") {
    return (
      <span className="mcp-status-dot testing" title={t(`mcp.test.phase.${phase}`)}>
        <Spinner label={t(`mcp.test.phase.${phase}`)} />
      </span>
    );
  }
  const tone = testTone(row.test, row.missingSecretCount);
  const text = testText(row.test, t, row.missingSecretCount, row.target.runner);
  return <span aria-label={text} className={`mcp-status-dot tone-${tone}`} role="img" title={text} />;
}

function NameBlock({ row, phase, handlers, busy }: { row: McpServerRow; phase?: McpTestProgressEvent["phase"]; handlers: MatrixHandlers; busy: boolean }) {
  const tone = testTone(row.test, row.missingSecretCount);
  // The key chip already says "需要 API Key"; the text only repeats a real test result.
  const showText = Boolean(row.test && !row.test.stale) || Boolean(phase && phase !== "done");
  return (
    <div className="mcp-name-block">
      <div className="mcp-name-line">
        <StatusDot phase={phase} row={row} />
        <button className="mcp-name" onClick={() => handlers.onEdit(row)} title={t("mcp.row.editTip")} type="button">
          {row.displayName || row.name}
        </button>
        <button className="mcp-test-link" disabled={Boolean(phase && phase !== "done")} onClick={() => handlers.onTest(row)} type="button">
          {t("mcp.row.test")}
        </button>
        <MenuButton className="mcp-row-menu" items={() => rowMenu(row, handlers, busy)} label={t("mcp.row.menu", { name: row.name })} title={t("mcp.row.menu", { name: row.name })}>
          <Glyph name="more" />
        </MenuButton>
      </div>
      <div className="mcp-target-line">
        {showText && <span className={`mcp-test-text tone-${tone}`}>{phase && phase !== "done" ? t(`mcp.test.phase.${phase}`) : testText(row.test, t, row.missingSecretCount, row.target.runner)}</span>}
        <span className="mcp-target" title={targetLine(row.target, t)}>{targetLine(row.target, t)}</span>
        {row.missingSecretCount > 0 && (
          <button className="mcp-key-chip" onClick={() => handlers.onEdit(row, "secret")} type="button">
            <Glyph name="key" /> {t("mcp.row.needsKey")} <strong>{t("mcp.row.fill")}</strong>
          </button>
        )}
      </div>
    </div>
  );
}

function useWindowedRange(enabled: boolean, count: number, anchor: RefObject<HTMLElement | null>) {
  const [range, setRange] = useState({ start: 0, end: Math.min(count, 60) });
  useEffect(() => {
    if (!enabled) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const top = anchor.current?.getBoundingClientRect().top ?? 0;
      const start = Math.max(0, Math.floor(-top / ROW_HEIGHT) - OVERSCAN);
      const end = Math.min(count, start + Math.ceil(window.innerHeight / ROW_HEIGHT) + OVERSCAN * 2);
      setRange(previous => (previous.start === start && previous.end === end ? previous : { start, end }));
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", schedule, { passive: true, capture: true });
    window.addEventListener("resize", schedule);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule, { capture: true });
      window.removeEventListener("resize", schedule);
    };
  }, [enabled, count, anchor]);
  return enabled ? range : { start: 0, end: count };
}

export function McpMatrix(props: Props) {
  const { columns, rows, searchActive, pending, testing, narrow, busy } = props;
  const handlers: MatrixHandlers = props;
  const [active, setActive] = useState({ r: 0, c: 0 });
  const bodyRef = useRef<HTMLTableSectionElement>(null);
  const focusAfter = useRef<{ r: number; c: number } | null>(null);
  const virtual = !narrow && rows.length > VIRTUAL_THRESHOLD;
  const range = useWindowedRange(virtual, rows.length, bodyRef);
  const [cardLimit, setCardLimit] = useState(VIRTUAL_THRESHOLD);

  useEffect(() => {
    setActive(current => ({ r: Math.min(current.r, Math.max(0, rows.length - 1)), c: Math.min(current.c, Math.max(0, columns.length - 1)) }));
  }, [rows.length, columns.length]);

  useLayoutEffect(() => {
    const target = focusAfter.current;
    if (!target) return;
    focusAfter.current = null;
    bodyRef.current?.querySelector<HTMLElement>(`[data-r="${target.r}"][data-c="${target.c}"]`)?.focus();
  });

  function onGridKey(event: ReactKeyboardEvent<HTMLElement>) {
    const element = event.target as HTMLElement;
    if (!element.dataset || element.dataset.r === undefined) return;
    const r = Number(element.dataset.r);
    const c = Number(element.dataset.c);
    let next: { r: number; c: number } | null = null;
    if (event.key === "ArrowRight") next = { r, c: Math.min(columns.length - 1, c + 1) };
    else if (event.key === "ArrowLeft") next = { r, c: Math.max(0, c - 1) };
    else if (event.key === "ArrowDown") next = { r: Math.min(rows.length - 1, r + 1), c };
    else if (event.key === "ArrowUp") next = { r: Math.max(0, r - 1), c };
    else if (event.key === "Home") next = { r, c: 0 };
    else if (event.key === "End") next = { r, c: columns.length - 1 };
    if (!next) return;
    event.preventDefault();
    focusAfter.current = next;
    setActive(next);
    if (virtual && (next.r < range.start + 2 || next.r > range.end - 3)) {
      window.scrollBy({ top: (next.r - r) * ROW_HEIGHT });
    }
  }

  const visibleRows = useMemo(() => rows.slice(range.start, range.end), [rows, range.start, range.end]);
  const activeRow = active.r >= range.start && active.r < range.end ? active.r : range.start;

  if (narrow) {
    const shown = rows.slice(0, cardLimit);
    return (
      <div className="mcp-cards-wrap">
        <div aria-label={t("mcp.matrix.clients")} className="mcp-client-bar" role="toolbar">
          {columns.map(client => (
            <MenuButton items={() => columnMenu(client, rows, searchActive, handlers, busy)} key={client.id} label={t("mcp.col.menu", { client: client.label })}>
              <span>{client.label}</span>
              {client.restartNeeded && <span className="mcp-restart-dot" title={t("mcp.col.restart", { client: client.label })} />}
              <Glyph name="chevron" />
            </MenuButton>
          ))}
        </div>
        <ul className="mcp-cards" onKeyDown={onGridKey}>
          {shown.map((row, r) => (
            <li className="mcp-card" key={row.id}>
              <NameBlock busy={busy} handlers={handlers} phase={testing.get(row.id)} row={row} />
              <div className="mcp-card-chips">
                {columns.map((client, c) => {
                  const cell = cellFor(row, client.id);
                  if (!cell) return null;
                  return (
                    <CellButton
                      active={r === active.r && c === active.c}
                      c={c}
                      cell={cell}
                      chip
                      client={client}
                      key={client.id}
                      onCell={handlers.onCell}
                      pending={pending.has(pendingKey(row.id, client.id))}
                      r={r}
                      row={row}
                    />
                  );
                })}
              </div>
            </li>
          ))}
        </ul>
        {rows.length > shown.length && (
          <button className="mcp-btn quiet mcp-more" onClick={() => setCardLimit(limit => limit + VIRTUAL_THRESHOLD)} type="button">
            {t("mcp.matrix.showMore", { n: rows.length - shown.length })}
          </button>
        )}
      </div>
    );
  }

  return (
    <table aria-label={t("mcp.matrix.label")} className={`mcp-matrix${virtual ? " virtual" : ""}`} style={{ ["--mcp-cols" as string]: columns.length }}>
      <thead>
        <tr>
          <th className="mcp-col-name" scope="col">{t("mcp.matrix.serverColumn")}</th>
          {columns.map(client => {
            const stats = columnStats(rows, client.id);
            return (
              <th className={`mcp-col-client${client.writable ? "" : " readonly"}`} key={client.id} scope="col">
                <MenuButton
                  className="mcp-col-button"
                  items={() => columnMenu(client, rows, searchActive, handlers, busy)}
                  label={t("mcp.col.menu", { client: client.label })}
                  title={client.writable ? client.configPathDisplay : client.readonlyReason ? cellReasonText(client.readonlyReason, t, client.label) : client.configPathDisplay}
                >
                  <span className="mcp-col-label">
                    {!client.writable && <Glyph name="lock" />}
                    <span className="mcp-col-text">{client.label}</span>
                    {client.restartNeeded && <span className="mcp-restart-dot" title={t("mcp.col.restart", { client: client.label })} />}
                    <Glyph className="mcp-col-chevron" name="chevron" />
                  </span>
                  <span className="mcp-col-count">{t("mcp.col.count", { on: stats.on, total: stats.total })}</span>
                </MenuButton>
              </th>
            );
          })}
        </tr>
      </thead>
      <tbody onKeyDown={onGridKey} ref={bodyRef}>
        {virtual && range.start > 0 && (
          <tr aria-hidden="true" className="mcp-spacer" style={{ height: range.start * ROW_HEIGHT }}><td colSpan={columns.length + 1} /></tr>
        )}
        {visibleRows.map((row, index) => {
          const r = range.start + index;
          return (
            <tr key={row.id}>
              <th className="mcp-col-name" scope="row">
                <NameBlock busy={busy} handlers={handlers} phase={testing.get(row.id)} row={row} />
              </th>
              {columns.map((client, c) => {
                const cell = cellFor(row, client.id);
                return (
                  <td className="mcp-col-client" key={client.id}>
                    {cell ? (
                      <CellButton
                        active={r === activeRow && c === active.c}
                        c={c}
                        cell={cell}
                        client={client}
                        onCell={handlers.onCell}
                        pending={pending.has(pendingKey(row.id, client.id))}
                        r={r}
                        row={row}
                      />
                    ) : null}
                  </td>
                );
              })}
            </tr>
          );
        })}
        {virtual && range.end < rows.length && (
          <tr aria-hidden="true" className="mcp-spacer" style={{ height: (rows.length - range.end) * ROW_HEIGHT }}><td colSpan={columns.length + 1} /></tr>
        )}
      </tbody>
    </table>
  );
}
