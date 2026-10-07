// Small shared UI building blocks (switchers, drawer, toggles, metrics) used by
// App.tsx and the page modules.
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Icon, type IconName } from "../icons";
import { CountUp } from "../effects";
import { LANG_OPTIONS, type Lang, t } from "../i18n";
import type { SkillCard, SourceCard } from "../types";
import {
  type ThemeName,
  THEME_OPTIONS,
  themeLabel,
  queryLooksLikeSkillCommand,
  displayCategoryName,
  sourceTypeLabel
} from "../appShared";

export function DeferredSurface({ label }: { label: string }) {
  return (
    <section className="deferred-surface glow-card" role="status">
      <Icon className="icon-spin" name="refresh" />
      <span>{label}</span>
    </section>
  );
}

/* =============================================================
   Language switcher
   ============================================================= */

export function LanguageSwitcher({ current, onChange }: { current: Lang; onChange: (lang: Lang) => void }) {
  const [open, setOpen] = useState(false);
  const currentOption = LANG_OPTIONS.find(option => option.value === current) ?? LANG_OPTIONS[0];

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest?.(".lang-switcher")) return;
      setOpen(false);
    };
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [open]);

  return (
    <div className={open ? "lang-switcher open" : "lang-switcher"}>
      <button
        aria-expanded={open}
        aria-haspopup="listbox"
        className="lang-trigger"
        onClick={event => {
          event.stopPropagation();
          setOpen(value => !value);
        }}
        type="button"
        title={currentOption.label}
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

export function ThemeSwitcher({ current, onChange }: { current: ThemeName; onChange: (theme: ThemeName) => void }) {
  const [open, setOpen] = useState(false);
  const currentOption = THEME_OPTIONS.find(option => option.value === current) ?? THEME_OPTIONS[0];

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest?.(".theme-switcher")) return;
      setOpen(false);
    };
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [open]);

  return (
    <div className={open ? "theme-switcher open" : "theme-switcher"}>
      <button
        aria-expanded={open}
        aria-haspopup="listbox"
        className="theme-trigger"
        onClick={event => {
          event.stopPropagation();
          setOpen(value => !value);
        }}
        type="button"
        title={t("theme.choose", { current: themeLabel(current) })}
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

/* =============================================================
   Global search results bar
   ============================================================= */

export function GlobalSearchResults({
  onClear,
  onCopySkill,
  onOpenLibrary,
  query,
  skills,
  sources
}: {
  onClear: () => void;
  onCopySkill: (skill: SkillCard) => void;
  onOpenLibrary: () => void;
  query: string;
  skills: SkillCard[];
  sources: SourceCard[];
}) {
  const skillCommand = queryLooksLikeSkillCommand(query);
  return (
    <section className="global-search-results" role="search">
      <div className="global-search-head">
        <div>
          <strong>{t("search.searching", { query: query.trim() })}</strong>
          <span>{skillCommand ? t("search.skillHint") : t("search.bothHint")}</span>
        </div>
        <button className="ghost-action" onClick={onClear} type="button">{t("search.clear")}</button>
      </div>
      <div className="global-search-columns">
        {!skillCommand && (
          <div>
            <button className="search-column-title" onClick={onOpenLibrary} type="button">
              <Icon name="sources" /> {t("search.sources")} <em>{sources.length}</em>
            </button>
            {sources.length === 0 ? (
              <small className="search-empty">{t("search.noSources")}</small>
            ) : (
              sources.map(source => (
                <button className="search-result-item" key={source.id} onClick={onOpenLibrary} type="button">
                  <strong>{source.name}</strong>
                  <span>{displayCategoryName(source.categoryId)} · {sourceTypeLabel(source.sourceType)}</span>
                </button>
              ))
            )}
          </div>
        )}
        <div>
          <button className="search-column-title" onClick={onOpenLibrary} type="button">
            <Icon name="sparkle" /> {t("search.skills")} <em>{skills.length}</em>
          </button>
          {skills.length === 0 ? (
            <small className="search-empty">{t("search.noSkills")}</small>
          ) : (
            skills.map(skill => (
              <div className="search-result-item search-result-skill" key={skill.folderName}>
                <button className="search-result-main" onClick={onOpenLibrary} type="button">
                  <strong>{skill.name}</strong>
                  <span>{displayCategoryName(skill.category)} · {skill.source || "local"}</span>
                </button>
                <button className="search-result-copy" onClick={() => onCopySkill(skill)} type="button">
                  <Icon name="copy" /> {t("search.copy")}
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </section>
  );
}

export function Drawer({
  children,
  eyebrow,
  onClose,
  title,
  wide = false
}: {
  children: React.ReactNode;
  eyebrow: string;
  onClose: () => void;
  title: string;
  wide?: boolean;
}) {
  return createPortal(
    <>
      <div className="drawer-backdrop" onClick={onClose} aria-hidden="true" />
      <aside aria-label={title} aria-modal="true" className={wide ? "drawer wide" : "drawer"} role="dialog">
        <header>
          <div>
            <span>{eyebrow}</span>
            <strong>{title}</strong>
          </div>
          <button className="icon-action" onClick={onClose} title={t("common.close")} type="button">
            <Icon name="add" className="rotate-45" />
          </button>
        </header>
        {children}
      </aside>
    </>,
    document.getElementById("app-overlay-root") ?? document.body
  );
}

/* =============================================================
   Shared primitives
   ============================================================= */

export function SegmentedToggle<T extends string>({
  onChange,
  options,
  value
}: {
  onChange: (value: T) => void;
  options: Array<{ value: T; label: string }>;
  value: T;
}) {
  return (
    <div className="segmented" role="tablist">
      {options.map(option => (
        <button
          aria-selected={option.value === value}
          className={option.value === value ? "active" : ""}
          data-segment-value={option.value}
          key={option.value}
          onClick={() => onChange(option.value)}
          role="tab"
          type="button"
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function ToggleSwitch({
  disabled,
  enabled,
  label,
  onClick
}: {
  disabled: boolean;
  enabled: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      aria-label={label}
      aria-pressed={enabled}
      className={enabled ? "switch is-on" : "switch"}
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      <span className="switch-track" aria-hidden="true">
        <span className="switch-thumb" />
      </span>
      <span className="switch-label">{label}</span>
    </button>
  );
}

export function Metric({
  accent = "violet",
  icon,
  label,
  onClick,
  trend,
  value
}: {
  accent?: string;
  icon?: IconName;
  label: string;
  onClick?: () => void;
  trend?: string;
  value: number;
}) {
  return (
    <button
      aria-label={label}
      className={`metric glow-card metric-${accent}${onClick ? " interactive" : ""}`}
      onClick={onClick}
      type="button"
    >
      <div>
        <span>{label}</span>
        {icon && <em aria-hidden="true"><Icon name={icon} /></em>}
      </div>
      <strong><CountUp value={value} /></strong>
      {trend && <small>{trend}</small>}
    </button>
  );
}

export function ScanFlag({ enabled, label }: { enabled: boolean; label: string }) {
  return <span className={enabled ? "scan-flag is-on" : "scan-flag"}>{label}</span>;
}

function themeIcon(theme: ThemeName): IconName {
  return THEME_OPTIONS.find(option => option.value === theme)?.icon ?? "moon";
}
