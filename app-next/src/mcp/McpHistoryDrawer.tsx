// History drawer (contract §6.5, M1-9): human labels built from structured fields; no ids, no
// snapshot sizes. Every rollback asks first (bug #8); the backend lists what will be restored.
import { useEffect, useRef, useState } from "react";
import type { McpClient, McpError, McpHistoryEntry } from "./mcpTypes";
import { mcpApi } from "./mcpApi";
import { errorText, formatWhen, historyLabel, historyPartialText } from "./mcpLogic";
import { Glyph, Overlay, Spinner, t } from "./mcpUi";
import { getLang } from "../i18n";

export function McpHistoryDrawer({
  clients,
  generation,
  onClose,
  onRollback
}: {
  clients: readonly McpClient[];
  generation: number;
  onClose: () => void;
  onRollback: (entry: McpHistoryEntry) => Promise<void>;
}) {
  const [entries, setEntries] = useState<McpHistoryEntry[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const titleRef = useRef<HTMLHeadingElement>(null);
  const locale = getLang() === "zh" ? "zh-CN" : getLang() === "ko" ? "ko-KR" : "en-US";

  useEffect(() => {
    let cancelled = false;
    mcpApi.history({ limit: 100 }).then(list => {
      if (!cancelled) {
        setEntries(list);
        setError("");
      }
    }).catch(raw => {
      if (!cancelled) setError(errorText(raw as McpError, t, clients));
    });
    return () => {
      cancelled = true;
    };
  }, [generation, clients]);

  const now = new Date();

  return (
    <Overlay initialFocus={titleRef} label={t("mcp.history.title")} onClose={onClose} variant="drawer">
      <header className="mcp-overlay-head">
        <h2 ref={titleRef} tabIndex={-1}>{t("mcp.history.title")}</h2>
        <button aria-label={t("mcp.common.close")} className="mcp-icon-button" onClick={onClose} title={t("mcp.common.close")} type="button">
          <Glyph name="close" />
        </button>
      </header>
      <div className="mcp-sheet-body">
        <p className="mcp-muted small">{t("mcp.history.intro")}</p>
        {error && <p className="mcp-callout error" role="alert"><Glyph name="warn" /><span>{error}</span></p>}
        {entries === null && !error && <p className="mcp-muted"><Spinner /> {t("mcp.history.loading")}</p>}
        {entries && entries.length === 0 && <p className="mcp-empty-line">{t("mcp.history.empty")}</p>}
        {entries && entries.length > 0 && (
          <ol className="mcp-history">
            {entries.map(entry => {
              const superseded = entry.undoUnavailableReason === "superseded";
              const canAct = entry.undoAvailable || superseded;
              return (
                <li className={`mcp-history-item kind-${entry.kind}${canAct ? "" : " unavailable"}`} key={entry.operationId}>
                  <time dateTime={entry.at}>{formatWhen(entry.at, locale, now, t)}</time>
                  <div className="mcp-history-text">
                    <span>{historyLabel(entry, t, clients)}</span>
                    {entry.partial && <em className="mcp-history-partial">{historyPartialText(entry, t, clients)}</em>}
                    {!canAct && entry.undoUnavailableReason && (
                      <small>{t(`mcp.history.unavailable.${entry.undoUnavailableReason}`)}</small>
                    )}
                  </div>
                  {canAct && (
                    <button
                      className="mcp-btn small quiet"
                      disabled={busy !== ""}
                      onClick={async () => {
                        setBusy(entry.operationId);
                        try {
                          await onRollback(entry);
                        } finally {
                          setBusy("");
                        }
                      }}
                      type="button"
                    >
                      {busy === entry.operationId ? <Spinner /> : <Glyph name="undo" />}
                      {superseded ? t("mcp.history.backBefore") : t("mcp.history.undoThis")}
                    </button>
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </Overlay>
  );
}
