// MCP-local toast stack with action buttons (Undo, Test, Retry). The global showUiToast has no
// actions, so the MCP page keeps its own: bottom-right, 8 s, paused on hover or focus, at most 3.
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Glyph, overlayRoot, t } from "./mcpUi";

export type McpToastAction = { label: string; run: () => void; primary?: boolean };
export type McpToastItem = {
  id: number;
  tone: "ok" | "warn" | "error" | "info";
  text: string;
  detail?: string;
  actions: McpToastAction[];
};

export const TOAST_MS = 8000;
export const MAX_TOASTS = 3;

export function McpToastStack({ items, onDismiss }: { items: McpToastItem[]; onDismiss: (id: number) => void }) {
  if (items.length === 0) return null;
  return createPortal(
    <div aria-live="polite" className="mcp-toast-stack">
      {items.map(item => (
        <ToastCard item={item} key={item.id} onDismiss={onDismiss} />
      ))}
    </div>,
    overlayRoot()
  );
}

function ToastCard({ item, onDismiss }: { item: McpToastItem; onDismiss: (id: number) => void }) {
  const remaining = useRef(TOAST_MS);
  const startedAt = useRef(0);
  const timer = useRef<number | null>(null);
  const paused = useRef(false);

  function stop() {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
      remaining.current = Math.max(800, remaining.current - (Date.now() - startedAt.current));
    }
  }

  function start() {
    if (timer.current !== null || paused.current) return;
    startedAt.current = Date.now();
    timer.current = window.setTimeout(() => onDismiss(item.id), remaining.current);
  }

  useEffect(() => {
    start();
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
    // The timer belongs to this toast instance only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function pause() {
    paused.current = true;
    stop();
  }

  function resume() {
    paused.current = false;
    start();
  }

  return (
    <div
      className={`mcp-toast tone-${item.tone}`}
      onBlur={event => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) resume();
      }}
      onFocus={pause}
      onMouseEnter={pause}
      onMouseLeave={resume}
      role={item.tone === "error" ? "alert" : "status"}
    >
      <span aria-hidden="true" className="mcp-toast-icon">
        <Glyph name={item.tone === "ok" ? "check" : item.tone === "info" ? "help" : "warn"} />
      </span>
      <div className="mcp-toast-body">
        <p>{item.text}</p>
        {item.detail && <small>{item.detail}</small>}
      </div>
      {item.actions.length > 0 && (
        <div className="mcp-toast-actions">
          {item.actions.map(action => (
            <button
              className={action.primary ? "mcp-btn small solid" : "mcp-btn small quiet"}
              key={action.label}
              onClick={() => {
                onDismiss(item.id);
                action.run();
              }}
              type="button"
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
      <button aria-label={t("mcp.common.close")} className="mcp-icon-button small mcp-toast-close" onClick={() => onDismiss(item.id)} type="button">
        <Glyph name="close" />
      </button>
    </div>
  );
}
