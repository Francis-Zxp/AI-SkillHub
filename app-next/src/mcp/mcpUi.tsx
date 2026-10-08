// Small primitives shared by the MCP page: glyphs, focus-trapped overlays and popover menus.
// Overlays render into #app-overlay-root, which sits inside the themed shell, so every theme
// (dark, light, Sky) applies to them too.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode, RefObject } from "react";
import { createPortal } from "react-dom";
import { mt as t } from "../mcpManagementI18n";

export { t };

export type GlyphName =
  | "close" | "check" | "lock" | "ban" | "flag" | "warn" | "play" | "undo" | "history" | "plus"
  | "more" | "search" | "help" | "folder" | "copy" | "external" | "chevron" | "import" | "key" | "unlock" | "refresh" | "trash";

const PATHS: Record<GlyphName, ReactNode> = {
  close: <path d="M6 6l12 12M18 6L6 18" />,
  check: <path d="M5 12.5l4.2 4.2L19 7" />,
  lock: <><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></>,
  unlock: <><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 7.6-1.7" /></>,
  ban: <><circle cx="12" cy="12" r="8" /><path d="M6.5 17.5l11-11" /></>,
  flag: <><path d="M6 20V5" /><path d="M6 5h10l-2 3.5L16 12H6" /></>,
  warn: <><path d="M12 4l9 16H3z" /><path d="M12 10v4M12 17.2v.3" /></>,
  play: <path d="M8 5.5v13l10-6.5z" />,
  undo: <><path d="M9 7L4.5 11.5 9 16" /><path d="M5 11.5h9a5 5 0 0 1 0 10h-2" /></>,
  history: <><path d="M4 12a8 8 0 1 0 2.4-5.7" /><path d="M4 4v4h4" /><path d="M12 8v4.5l3 2" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  more: <><circle cx="6" cy="12" r="1.3" /><circle cx="12" cy="12" r="1.3" /><circle cx="18" cy="12" r="1.3" /></>,
  search: <><circle cx="11" cy="11" r="6.5" /><path d="M16 16l4 4" /></>,
  help: <><circle cx="12" cy="12" r="8.5" /><path d="M9.6 9.4a2.5 2.5 0 1 1 3.4 2.4c-.7.3-1 .8-1 1.5v.4M12 16.8v.3" /></>,
  folder: <path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />,
  copy: <><rect x="8.5" y="8.5" width="11" height="11" rx="2" /><path d="M15.5 8.5V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7.5a2 2 0 0 0 2 2h2.5" /></>,
  external: <><path d="M14 4h6v6" /><path d="M20 4l-9 9" /><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" /></>,
  chevron: <path d="M8 10l4 4 4-4" />,
  import: <><path d="M12 4v11" /><path d="M7.5 10.5L12 15l4.5-4.5" /><path d="M5 19.5h14" /></>,
  key: <><circle cx="8" cy="15" r="3.5" /><path d="M10.5 12.5L19 4M16 7l2.5 2.5M14 9l2 2" /></>,
  refresh: <><path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3" /><path d="M19.5 4.5v4h-4" /></>,
  trash: <><path d="M5 7h14" /><path d="M9.5 7V5h5v2" /><path d="M7 7l.8 12h8.4L17 7" /></>
};

export function Glyph({ name, className = "" }: { name: GlyphName; className?: string }) {
  return (
    <svg aria-hidden="true" className={`mcp-glyph ${className}`.trim()} fill="none" focusable="false" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} viewBox="0 0 24 24">
      {PATHS[name]}
    </svg>
  );
}

export function Spinner({ label }: { label?: string }) {
  return <span aria-label={label} className="mcp-spinner" role={label ? "status" : undefined} />;
}

export function overlayRoot(): HTMLElement {
  return document.getElementById("app-overlay-root") ?? document.body;
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusables(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(element => element.offsetParent !== null || element === document.activeElement);
}

/**
 * Keeps keyboard focus inside `ref` while mounted, focuses the initial element, closes on Escape and
 * gives focus back to whatever had it before. Nested overlays: only the topmost one reacts.
 */
const overlayStack: Array<RefObject<HTMLElement | null>> = [];

export function useFocusTrap(ref: RefObject<HTMLElement | null>, onEscape: () => void, initialFocus?: RefObject<HTMLElement | null>) {
  const escapeRef = useRef(onEscape);
  escapeRef.current = onEscape;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    overlayStack.push(ref);
    const container = ref.current;
    const target = initialFocus?.current ?? (container ? focusables(container)[0] : null) ?? container;
    target?.focus({ preventScroll: true });
    function onKeyDown(event: KeyboardEvent) {
      if (overlayStack[overlayStack.length - 1] !== ref) return;
      const node = ref.current;
      if (!node) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        escapeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusables(node);
      if (items.length === 0) {
        event.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && (document.activeElement === first || !node.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !node.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      const index = overlayStack.lastIndexOf(ref);
      if (index >= 0) overlayStack.splice(index, 1);
      if (previous && document.contains(previous)) previous.focus({ preventScroll: true });
    };
    // Mount-only: the trap follows the overlay's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

type OverlayProps = {
  label: string;
  onClose: () => void;
  children: ReactNode;
  initialFocus?: RefObject<HTMLElement | null>;
  className?: string;
  /** Sheets slide in from the right; dialogs are centred. */
  variant: "sheet" | "drawer" | "dialog";
  closeOnBackdrop?: boolean;
};

export function Overlay({ label, onClose, children, initialFocus, className = "", variant, closeOnBackdrop = true }: OverlayProps) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, onClose, initialFocus);
  return createPortal(
    <div className={`mcp-overlay mcp-overlay-${variant}`}>
      <div aria-hidden="true" className="mcp-backdrop" onClick={closeOnBackdrop ? onClose : undefined} />
      <div aria-label={label} aria-modal="true" className={`mcp-${variant} ${className}`.trim()} ref={ref} role="dialog" tabIndex={-1}>
        {children}
      </div>
    </div>,
    overlayRoot()
  );
}

export function OverlayHeader({ title, onClose, children }: { title: string; onClose: () => void; children?: ReactNode }) {
  return (
    <header className="mcp-overlay-head">
      <h2>{title}</h2>
      {children}
      <button aria-label={t("mcp.common.close")} className="mcp-icon-button" onClick={onClose} title={t("mcp.common.close")} type="button">
        <Glyph name="close" />
      </button>
    </header>
  );
}

export type MenuItem =
  | { kind: "action"; label: string; onSelect: () => void; danger?: boolean; disabled?: boolean; icon?: GlyphName }
  | { kind: "text"; label: string; tone?: "muted" | "warn" }
  | { kind: "separator" };

/** A button plus its popover menu. Arrow keys move, Escape closes and returns focus. */
export function MenuButton({
  label,
  items,
  className = "",
  children,
  align = "end",
  disabled = false,
  title
}: {
  label: string;
  items: () => MenuItem[];
  className?: string;
  children: ReactNode;
  align?: "start" | "end";
  disabled?: boolean;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [placeUp, setPlaceUp] = useState(false);

  useEffect(() => {
    if (!open) return;
    function onPointer(event: PointerEvent) {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", onPointer, true);
    return () => document.removeEventListener("pointerdown", onPointer, true);
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    const button = buttonRef.current;
    const menu = menuRef.current;
    if (button && menu) {
      const rect = button.getBoundingClientRect();
      setPlaceUp(rect.bottom + menu.offsetHeight + 12 > window.innerHeight && rect.top > menu.offsetHeight + 12);
    }
    menu?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus({ preventScroll: true });
  }, [open]);

  function close(returnFocus = true) {
    setOpen(false);
    if (returnFocus) buttonRef.current?.focus({ preventScroll: true });
  }

  function onMenuKey(event: ReactKeyboardEvent<HTMLDivElement>) {
    const entries = [...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? [])];
    const index = entries.indexOf(document.activeElement as HTMLElement);
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      entries[(index + 1) % entries.length]?.focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      entries[(index - 1 + entries.length) % entries.length]?.focus();
    } else if (event.key === "Home") {
      event.preventDefault();
      entries[0]?.focus();
    } else if (event.key === "End") {
      event.preventDefault();
      entries[entries.length - 1]?.focus();
    } else if (event.key === "Tab") {
      close(false);
    }
  }

  return (
    <span className={`mcp-menu-wrap ${className}`.trim()} ref={wrapRef}>
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={label}
        className="mcp-menu-trigger"
        disabled={disabled}
        onClick={() => setOpen(value => !value)}
        onKeyDown={event => {
          if (event.key === "ArrowDown" && !open) {
            event.preventDefault();
            setOpen(true);
          }
        }}
        ref={buttonRef}
        title={title}
        type="button"
      >
        {children}
      </button>
      {open && (
        <div aria-label={label} className={`mcp-menu align-${align}${placeUp ? " place-up" : ""}`} onKeyDown={onMenuKey} ref={menuRef} role="menu">
          {items().map((item, index) => {
            if (item.kind === "separator") return <hr aria-hidden="true" key={`s${index}`} />;
            if (item.kind === "text") return <p className={`mcp-menu-text ${item.tone ?? "muted"}`} key={`t${index}`} role="none">{item.label}</p>;
            return (
              <button
                className={item.danger ? "danger" : ""}
                disabled={item.disabled}
                key={`a${index}`}
                onClick={() => {
                  close();
                  item.onSelect();
                }}
                role="menuitem"
                tabIndex={-1}
                type="button"
              >
                {item.icon && <Glyph name={item.icon} />}
                <span>{item.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </span>
  );
}

/** "(?)" tip: a small toggletip that holds the long explanations instead of permanent paragraphs. */
export function HelpTip({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    function onPointer(event: PointerEvent) {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <span className="mcp-helptip" ref={ref}>
      <button aria-expanded={open} aria-label={label} className="mcp-icon-button small" onClick={() => setOpen(value => !value)} title={label} type="button">
        <Glyph name="help" />
      </button>
      {open && <span className="mcp-helptip-body" role="note">{children}</span>}
    </span>
  );
}

/** Media/size helper without polling: a ResizeObserver on the page root. */
export function useNarrow(ref: RefObject<HTMLElement | null>, breakpoint: number): boolean {
  // First guess from the window (the sidebar takes ~260 px) so a phone does not flash the table.
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && window.innerWidth - 260 < breakpoint && window.innerWidth < 900);
  useEffect(() => {
    const node = ref.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(entries => {
      const width = entries[0]?.contentRect.width ?? node.clientWidth;
      setNarrow(current => (current !== width < breakpoint ? width < breakpoint : current));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref, breakpoint]);
  return narrow;
}
