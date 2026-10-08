// Language and theme pickers for the top bar (restored from 3.2.x, where users found them
// directly; the v3.3 move into Settings hid them). Both close on an outside click or Escape.
import { useEffect, useState } from "react";
import { Icon, type IconName } from "../icons";
import { LANG_OPTIONS, type Lang, t } from "../i18n";
import { THEME_OPTIONS, type ThemeName, themeLabel } from "../appShared";

function useOutsideClose(open: boolean, selector: string, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest?.(selector)) return;
      close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("click", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, selector, close]);
}

export function LanguageSwitcher({ current, onChange }: { current: Lang; onChange: (lang: Lang) => void }) {
  const [open, setOpen] = useState(false);
  const currentOption = LANG_OPTIONS.find(option => option.value === current) ?? LANG_OPTIONS[0];
  useOutsideClose(open, ".lang-switcher", () => setOpen(false));
  return (
    <div className={open ? "lang-switcher open" : "lang-switcher"}>
      <button
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={currentOption.label}
        className="lang-trigger"
        data-testid="topbar-language"
        onClick={event => {
          event.stopPropagation();
          setOpen(value => !value);
        }}
        title={currentOption.label}
        type="button"
      >
        <Icon name="globe" />
        <span>{currentOption.short}</span>
      </button>
      {open && (
        <ul className="lang-menu" role="listbox">
          {LANG_OPTIONS.map(option => (
            <li key={option.value}>
              <button
                aria-selected={option.value === current}
                className={option.value === current ? "active" : ""}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
                role="option"
                type="button"
              >
                <strong>{option.label}</strong>
                <small>{option.short}</small>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function themeIcon(theme: ThemeName): IconName {
  return THEME_OPTIONS.find(option => option.value === theme)?.icon ?? "sparkle";
}

export function ThemeSwitcher({ current, onChange }: { current: ThemeName; onChange: (theme: ThemeName) => void }) {
  const [open, setOpen] = useState(false);
  useOutsideClose(open, ".theme-switcher", () => setOpen(false));
  const label = t("theme.choose", { current: themeLabel(current) });
  return (
    <div className={open ? "theme-switcher open" : "theme-switcher"}>
      <button
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={label}
        className="theme-trigger"
        data-testid="topbar-theme"
        onClick={event => {
          event.stopPropagation();
          setOpen(value => !value);
        }}
        title={label}
        type="button"
      >
        <Icon name={themeIcon(current)} />
      </button>
      {open && (
        <ul className="theme-menu" role="listbox">
          {THEME_OPTIONS.map(option => (
            <li key={option.value}>
              <button
                aria-selected={option.value === current}
                className={option.value === current ? "active" : ""}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
                role="option"
                type="button"
              >
                <span aria-hidden="true"><Icon name={option.icon} /></span>
                <strong>{t(option.labelKey)}</strong>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
