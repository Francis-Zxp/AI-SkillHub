// Small shared UI building blocks (drawer, dialogs, menus, toggles, metrics) used by
// App.tsx and the page modules. v3.3: every overlay takes focus, traps Tab, closes on
// Escape and gives focus back to whatever opened it (bug #7 frontend-shell).
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon, type IconName } from "../icons";
import { CountUp } from "../effects";
import { t } from "../i18n";

export function DeferredSurface({ label }: { label: string }) {
  return (
    <section className="deferred-surface glow-card" role="status">
      <Icon className="icon-spin" name="refresh" />
      <span>{label}</span>
    </section>
  );
}

function overlayRoot() {
  return document.getElementById("app-overlay-root") ?? document.body;
}

const FOCUSABLE = "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

/**
 * Focus handling shared by drawers, dialogs and sheets: focus the container (or its
 * [data-autofocus] child) on open, wrap Tab inside it, Escape calls onEscape, and the
 * element that had focus before gets it back on close.
 */
export function useFocusTrap(ref: React.RefObject<HTMLElement | null>, onEscape: () => void, active = true) {
  const escapeRef = useRef(onEscape);
  escapeRef.current = onEscape;
  useLayoutEffect(() => {
    if (!active) return;
    const node = ref.current;
    if (!node) return;
    const previous = document.activeElement as HTMLElement | null;
    const preferred = node.querySelector<HTMLElement>("[data-autofocus]");
    (preferred ?? node).focus({ preventScroll: true });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        // The innermost open overlay handles Escape first.
        const overlays = document.querySelectorAll("[data-overlay]");
        if (overlays[overlays.length - 1] !== node) return;
        event.preventDefault();
        event.stopPropagation();
        escapeRef.current();
        return;
      }
      if (event.key !== "Tab" || !node.contains(document.activeElement)) return;
      const items = Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(item => item.offsetParent !== null);
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      if (previous && document.contains(previous)) previous.focus({ preventScroll: true });
    };
  }, [active, ref]);
}

export function Drawer({
  children,
  eyebrow,
  onClose,
  title,
  wide = false,
  testId,
  headerExtra
}: {
  children: ReactNode;
  eyebrow: string;
  onClose: () => void;
  title: string;
  wide?: boolean;
  testId?: string;
  headerExtra?: ReactNode;
}) {
  const ref = useRef<HTMLElement | null>(null);
  useFocusTrap(ref, onClose);
  return createPortal(
    <>
      <div className="drawer-backdrop" onClick={onClose} aria-hidden="true" />
      <aside
        aria-label={title}
        aria-modal="true"
        className={wide ? "drawer wide" : "drawer"}
        data-overlay=""
        data-testid={testId}
        ref={ref}
        role="dialog"
        tabIndex={-1}
      >
        <header>
          <div>
            {eyebrow && <span>{eyebrow}</span>}
            <strong>{title}</strong>
          </div>
          {headerExtra}
          <button className="icon-action" onClick={onClose} title={t("common.close")} aria-label={t("common.close")} type="button">
            <Icon name="close" />
          </button>
        </header>
        {children}
      </aside>
    </>,
    overlayRoot()
  );
}

/** Centred modal dialog (confirmations, review, adopt). */
export function Dialog({
  children,
  onClose,
  title,
  testId,
  className = "",
  footer
}: {
  children: ReactNode;
  onClose: () => void;
  title: string;
  testId?: string;
  className?: string;
  footer?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useFocusTrap(ref, onClose);
  return createPortal(
    <div className="dialog-layer">
      <div className="drawer-backdrop" onClick={onClose} aria-hidden="true" />
      <div
        aria-label={title}
        aria-modal="true"
        className={`dialog ${className}`.trim()}
        data-overlay=""
        data-testid={testId}
        ref={ref}
        role="dialog"
        tabIndex={-1}
      >
        <header className="dialog-head">
          <strong>{title}</strong>
          <button className="icon-action" onClick={onClose} aria-label={t("common.close")} title={t("common.close")} type="button">
            <Icon name="close" />
          </button>
        </header>
        <div className="dialog-body">{children}</div>
        {footer && <footer className="dialog-foot">{footer}</footer>}
      </div>
    </div>,
    overlayRoot()
  );
}

export type ConfirmRequest = {
  title: string;
  body: string;
  confirmLabel: string;
  danger?: boolean;
  testId?: string;
};

/** One pending confirmation at a time; resolves true on confirm. */
export function useConfirm(): [ReactNode, (request: ConfirmRequest) => Promise<boolean>] {
  const [request, setRequest] = useState<(ConfirmRequest & { resolve: (value: boolean) => void }) | null>(null);
  const ask = (next: ConfirmRequest) => new Promise<boolean>(resolve => setRequest({ ...next, resolve }));
  const finish = (value: boolean) => {
    request?.resolve(value);
    setRequest(null);
  };
  const node = request ? (
    <Dialog
      onClose={() => finish(false)}
      title={request.title}
      testId={request.testId ?? "confirm-dialog"}
      footer={
        <>
          <button className="secondary-action" onClick={() => finish(false)} type="button">{t("common.cancel")}</button>
          <button className={request.danger ? "danger-action" : "primary-action"} data-autofocus="" data-testid="confirm-accept" onClick={() => finish(true)} type="button">
            {request.confirmLabel}
          </button>
        </>
      }
    >
      <p className="dialog-text">{request.body}</p>
    </Dialog>
  ) : null;
  return [node, ask];
}

/** "⋯" menu: closes on outside click and Escape, keyboard reachable. The list renders in the
 * overlay layer with fixed positioning, so a card or a scrolling list with hidden overflow
 * can never clip it; near the bottom of the window it opens upwards. */
export function MoreMenu({
  items,
  label,
  testId,
  align = "end"
}: {
  items: Array<{ key: string; label: string; onSelect: () => void; disabled?: boolean; danger?: boolean; icon?: IconName }>;
  label: string;
  testId?: string;
  align?: "start" | "end";
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<React.CSSProperties | null>(null);
  // Opened from the keyboard: focus moves into the list (it lives in the overlay layer, so Tab
  // from the trigger would not reach it).
  const keyboardOpen = useRef(false);
  const host = useRef<HTMLDivElement | null>(null);
  const list = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!host.current?.contains(target) && !list.current?.contains(target)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
        host.current?.querySelector<HTMLButtonElement>(".more-trigger")?.focus();
      }
    };
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);
  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    const place = () => {
      const trigger = host.current?.querySelector<HTMLElement>(".more-trigger");
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const height = list.current?.offsetHeight ?? 0;
      const below = window.innerHeight - rect.bottom - 8;
      const upward = height > below && rect.top - 8 > below;
      const next: React.CSSProperties = { position: "fixed", maxHeight: Math.max(160, (upward ? rect.top : below) - 12) };
      if (upward) next.bottom = window.innerHeight - rect.top + 6;
      else next.top = rect.bottom + 6;
      if (align === "start") next.left = Math.max(8, rect.left);
      else next.right = Math.max(8, window.innerWidth - rect.right);
      setPosition(next);
      if (keyboardOpen.current) {
        keyboardOpen.current = false;
        list.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({ preventScroll: true });
      }
    };
    place();
    // A second pass once the list has its real height.
    const frame = window.requestAnimationFrame(place);
    const close = () => setOpen(false);
    // The page moving under a fixed menu would detach it; scrolling the menu itself is fine.
    const onScroll = (event: Event) => {
      if (!list.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("resize", close);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open, align]);
  return (
    <div className={`more-menu${open ? " open" : ""} align-${align}`} ref={host}>
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={label}
        className="icon-action more-trigger"
        data-testid={testId}
        onClick={event => {
          event.stopPropagation();
          keyboardOpen.current = event.detail === 0;
          setOpen(value => !value);
        }}
        title={label}
        type="button"
      >
        <Icon name="more" />
      </button>
      {open &&
        createPortal(
          <div
            className="more-list floating"
            onKeyDown={event => {
              const buttons = Array.from(list.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
              const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                const step = event.key === "ArrowDown" ? 1 : -1;
                buttons[(index + step + buttons.length) % buttons.length]?.focus();
              } else if (event.key === "Tab") {
                event.preventDefault();
                setOpen(false);
                host.current?.querySelector<HTMLButtonElement>(".more-trigger")?.focus();
              }
            }}
            ref={list}
            role="menu"
            style={position ?? { position: "fixed", top: -9999, left: -9999 }}
          >
            {items.map(item => (
              <button
                className={item.danger ? "danger" : ""}
                disabled={item.disabled}
                key={item.key}
                onClick={event => {
                  event.stopPropagation();
                  setOpen(false);
                  item.onSelect();
                }}
                role="menuitem"
                type="button"
              >
                {item.icon && <Icon name={item.icon} />}
                <span>{item.label}</span>
              </button>
            ))}
          </div>,
          overlayRoot()
        )}
    </div>
  );
}

/* =============================================================
   Shared primitives
   ============================================================= */

export function SegmentedToggle<T extends string>({
  onChange,
  options,
  value,
  label
}: {
  onChange: (value: T) => void;
  options: Array<{ value: T; label: string }>;
  value: T;
  label?: string;
}) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map(option => (
        <button
          aria-checked={option.value === value}
          className={option.value === value ? "active" : ""}
          data-segment-value={option.value}
          key={option.value}
          onClick={() => onChange(option.value)}
          role="radio"
          type="button"
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** Accessible switch: role="switch" + aria-checked; the label stays for screen readers. */
export function ToggleSwitch({
  disabled,
  enabled,
  label,
  onClick,
  testId,
  showLabel = true,
  busy = false
}: {
  disabled: boolean;
  enabled: boolean;
  label: string;
  onClick: () => void;
  testId?: string;
  showLabel?: boolean;
  busy?: boolean;
}) {
  return (
    <button
      aria-busy={busy || undefined}
      aria-checked={enabled}
      aria-label={label}
      className={`switch${enabled ? " is-on" : ""}${busy ? " is-busy" : ""}`}
      data-testid={testId}
      disabled={disabled}
      onClick={onClick}
      role="switch"
      type="button"
    >
      <span className="switch-track" aria-hidden="true">
        <span className="switch-thumb" />
      </span>
      {showLabel && <span className="switch-label">{label}</span>}
    </button>
  );
}

export function Metric({
  icon,
  label,
  onClick,
  trend,
  value,
  testId,
  tone = "",
  suffix
}: {
  icon?: IconName;
  label: string;
  onClick?: () => void;
  trend?: string;
  value: number;
  testId?: string;
  tone?: string;
  suffix?: string;
}) {
  return (
    <button
      className={`metric glow-card${tone ? ` metric-${tone}` : ""}${onClick ? " interactive" : ""}`}
      data-count={value}
      data-testid={testId}
      onClick={onClick}
      type="button"
    >
      <div>
        <span>{label}</span>
        {icon && <em aria-hidden="true"><Icon name={icon} /></em>}
      </div>
      <strong><CountUp value={value} />{suffix && <small className="metric-suffix">{suffix}</small>}</strong>
      {trend && <small>{trend}</small>}
    </button>
  );
}

export function StarRating({
  value,
  onChange,
  disabled,
  label,
  compact = false
}: {
  value: number;
  onChange: (value: number) => void;
  disabled?: boolean;
  label: string;
  compact?: boolean;
}) {
  const [hover, setHover] = useState(0);
  const shown = hover || value;
  return (
    <span className={`star-rating${compact ? " compact" : ""}`} role="group" aria-label={label} onPointerLeave={() => setHover(0)}>
      {[1, 2, 3, 4, 5].map(star => (
        <button
          aria-label={t("v33.rateStars", { n: star })}
          aria-pressed={value >= star}
          className={shown >= star ? "on" : ""}
          disabled={disabled}
          key={star}
          onClick={event => {
            event.stopPropagation();
            onChange(value === star ? 0 : star);
          }}
          onPointerEnter={() => setHover(star)}
          type="button"
        >
          ★
        </button>
      ))}
    </span>
  );
}
