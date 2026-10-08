// v3.3 app shell pieces (skills contract §6.1): sidebar with AI 工具 sub-items, the sync
// indicator and its 问题 popover, the single error banner, global search results and
// the small monogram used for every AI tool. Pure presentation; App owns the state.
import { type CSSProperties, useEffect, useRef } from "react";
import { Icon, type IconName } from "../icons";
import { t } from "../i18n";
import { agentDotTone, availableAgents, sidebarAgents, type SyncIndicator } from "../deliveryView";
import { skillHubErrorText } from "../skillErrors";
import { problemText } from "../agentText";
import type { DeliveryProblem, ErrorAction, NavKey, SkillAgent, SkillCard, SkillDeliveryState, SkillHubError } from "../types";

/* ---------- AI tool monogram ---------- */

const GLYPHS: Record<string, { text: string; hue: string }> = {
  claude: { text: "C", hue: "#c96442" },
  codex: { text: "Cx", hue: "#2f3b4c" },
  "codex-legacy": { text: "Cx", hue: "#2f3b4c" },
  coze: { text: "扣", hue: "#4d53e8" },
  workbuddy: { text: "W", hue: "#0b84c6" },
  antigravity: { text: "A", hue: "#7c3aed" },
  cursor: { text: "Cu", hue: "#1f2430" },
  "gemini-cli": { text: "G", hue: "#2563eb" },
  opencode: { text: "O", hue: "#516072" },
  "github-copilot": { text: "Co", hue: "#3b4656" },
  windsurf: { text: "Ws", hue: "#0f766e" },
  kiro: { text: "K", hue: "#8b3fd9" },
  hermes: { text: "H", hue: "#a16207" },
  openclaw: { text: "Oc", hue: "#be123c" },
  amp: { text: "Am", hue: "#c2410c" }
};

export function AgentGlyph({ agentId, name, size = "md" }: { agentId: string; name?: string; size?: "sm" | "md" | "lg" }) {
  const glyph = GLYPHS[agentId] ?? { text: (name ?? agentId).slice(0, 1).toUpperCase(), hue: "#64748b" };
  return (
    <span aria-hidden="true" className={`agent-glyph size-${size}`} style={{ "--glyph": glyph.hue } as CSSProperties}>
      {glyph.text}
    </span>
  );
}

/* ---------- Sidebar ---------- */

// A slim icon rail, as in 3.2.x: each item opens its page, where the details live (the AI 工具
// page lists every tool). Labels show as tooltips on hover; nothing here duplicates the top bar.
const NAV: Array<{ key: NavKey; icon: IconName; label: string }> = [
  { key: "dashboard", icon: "dashboard", label: "nav.dashboard" },
  { key: "library", icon: "library", label: "nav.library" },
  { key: "connections", icon: "plug", label: "nav.connections" },
  { key: "agents", icon: "agent", label: "nav.agents" }
];

export function Sidebar({
  active,
  updateCount,
  onNavigate
}: {
  active: NavKey;
  updateCount: number;
  onNavigate: (key: NavKey) => void;
}) {
  const item = (key: NavKey, icon: IconName, label: string, badge = 0) => (
    <button
      aria-current={active === key ? "page" : undefined}
      aria-label={t(label)}
      className="rail-item"
      data-testid={`nav-${key}`}
      key={key}
      onClick={() => onNavigate(key)}
      type="button"
    >
      <span className="rail-icon" aria-hidden="true"><Icon name={icon} /></span>
      {badge > 0 && <em className="rail-badge" title={t("v33.updatesBadge", { n: badge })}>{badge}</em>}
      <span className="rail-tip" aria-hidden="true">{t(label)}</span>
    </button>
  );
  return (
    <aside className="side-rail" aria-label={t("v33.navLabel")}>
      <div className="rail-brand">
        <img alt="AI SkillHub" src="/ai-skillhub-logo.png" />
      </div>
      <nav className="rail-nav">
        {NAV.map(entry => item(entry.key, entry.icon, entry.label, entry.key === "library" ? updateCount : 0))}
      </nav>
      <div className="rail-footer">{item("settings", "settings", "nav.settings")}</div>
    </aside>
  );
}

/* ---------- Sync indicator + problems popover ---------- */

export function SyncIndicatorButton({
  indicator,
  open,
  onToggle
}: {
  indicator: SyncIndicator;
  open: boolean;
  onToggle: () => void;
}) {
  const label = t(indicator.labelKey, indicator.vars);
  const tip = indicator.waitingFor ? t("sync.waitingFor", { what: indicator.waitingFor }) : label;
  return (
    <button
      aria-expanded={open}
      aria-haspopup="dialog"
      className={`sync-indicator tone-${indicator.tone}`}
      data-testid="sync-indicator"
      data-tone={indicator.tone}
      onClick={onToggle}
      title={tip}
      type="button"
    >
      <i className="sync-dot" aria-hidden="true" />
      <span>{label}</span>
    </button>
  );
}

export function ProblemsPopover({
  problems,
  agents,
  onAction,
  onClose,
  onRemoveEntry,
  unitName
}: {
  problems: DeliveryProblem[];
  agents: SkillAgent[];
  onAction: (action: ErrorAction, problem: DeliveryProblem) => void;
  onClose: () => void;
  /** Leftover entry of a tool that is gone (the backend sends no action for it): remove it. */
  onRemoveEntry: (problem: DeliveryProblem) => void;
  /** Library name of a unit id, for problems that mention a skill pack. */
  unitName: (unitId: string) => string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    const onPointer = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (ref.current?.contains(target) || target?.closest(".sync-indicator")) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointer);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointer);
    };
  }, [onClose]);
  const agentName = (id: string | null) => agents.find(agent => agent.id === id)?.name ?? "";
  return (
    <div className="problems-popover" data-testid="problems-popover" ref={ref} role="dialog" aria-label={t("v33.problemsTitle")} tabIndex={-1}>
      <header>
        <strong>{t("v33.problemsTitle")}</strong>
        <span>{problems.length > 0 ? t("v33.problemsCount", { n: problems.length }) : t("v33.problemsNone")}</span>
      </header>
      {problems.length > 0 && (
        <ul>
          {problems.map(problem => (
            <li key={problem.id} data-testid={`problem-${problem.id}`}>
              {problem.agentId && <AgentGlyph agentId={problem.agentId} name={agentName(problem.agentId)} size="sm" />}
              <p>{problemText(problem, agents, unitName)}</p>
              {problem.action ? (
                <button className="ghost-action small" data-testid="problem-action" onClick={() => onAction(problem.action!, problem)} type="button">
                  {t(`err.action.${problem.action.kind}`)}
                </button>
              ) : isLeftoverEntry(problem) ? (
                <button className="ghost-action small" data-testid="problem-action" onClick={() => onRemoveEntry(problem)} type="button">
                  {t("v33.removeEntry")}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** An entry SkillHub left in a tool that is no longer installed (target status "orphan"). */
function isLeftoverEntry(problem: DeliveryProblem) {
  return problem.code === "AGENT_NOT_INSTALLED" && Boolean(problem.unitId && problem.agentId);
}

/* ---------- Error banner (S1-9) ---------- */

export function ErrorBanner({
  error,
  onAction,
  onDismiss
}: {
  error: SkillHubError;
  onAction: (action: ErrorAction) => void;
  onDismiss: () => void;
}) {
  return (
    <section className="status-banner error" data-testid="error-banner" data-code={error.code} role="alert">
      <Icon name="alert" />
      <div>
        <strong>{skillHubErrorText(error, t)}</strong>
        {error.detail && (
          <details>
            <summary>{t("v33.details")}</summary>
            <code>{error.detail}</code>
          </details>
        )}
      </div>
      {error.action && (
        <button className="ghost-action small" data-testid="error-banner-action" onClick={() => onAction(error.action!)} type="button">
          {t(`err.action.${error.action.kind}`)}
        </button>
      )}
      <button
        aria-label={t("v33.dismiss")}
        className="icon-action"
        data-testid="error-banner-dismiss"
        onClick={onDismiss}
        title={t("v33.dismiss")}
        type="button"
      >
        <Icon name="close" />
      </button>
    </section>
  );
}

/* ---------- Global search results (§6.1) ---------- */

export type SearchPackResult = { key: string; name: string; meta: string; kind: "pack" | "prompt" | "standalone" | "empty" };
export type SearchSkillResult = { key: string; skill: SkillCard; meta: string };

export function GlobalSearchResults({
  packs,
  skills,
  query,
  onOpen,
  onCopySkill,
  onClear
}: {
  packs: SearchPackResult[];
  skills: SearchSkillResult[];
  query: string;
  onOpen: (key: string) => void;
  onCopySkill: (skill: SkillCard) => void;
  onClear: () => void;
}) {
  const total = packs.length + skills.length;
  return (
    <section className="global-search-results" data-testid="global-search-results" role="region" aria-label={t("v33.searchResults")}>
      <div className="global-search-head">
        <strong>{t("v33.searchCount", { n: total, query: query.trim() })}</strong>
        <button className="ghost-action small" onClick={onClear} type="button">{t("search.clear")}</button>
      </div>
      {total === 0 ? (
        <p className="search-empty">{t("v33.searchNone")}</p>
      ) : (
        <div className="global-search-columns">
          {packs.length > 0 && (
            <div>
              <span className="search-column-title">{t("v33.searchPacks")} <em>{packs.length}</em></span>
              {packs.map(pack => (
                <button className="search-result-item" data-testid="search-result" key={pack.key} onClick={() => onOpen(pack.key)} type="button">
                  <strong>{pack.name}</strong>
                  <span>{pack.meta}</span>
                </button>
              ))}
            </div>
          )}
          {skills.length > 0 && (
            <div>
              <span className="search-column-title">{t("v33.searchSkills")} <em>{skills.length}</em></span>
              {skills.map(item => (
                <div className="search-result-item search-result-skill" key={`${item.key}:${item.skill.folderName}`}>
                  <button className="search-result-main" data-testid="search-result" onClick={() => onOpen(item.key)} type="button">
                    <strong>{item.skill.name}</strong>
                    <span>{item.meta}</span>
                  </button>
                  <button className="search-result-copy" onClick={() => onCopySkill(item.skill)} title={t("search.copy")} type="button">
                    <Icon name="copy" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
