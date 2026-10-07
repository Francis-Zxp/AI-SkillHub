// v3.3 app shell pieces (skills contract §6.1): sidebar with AI 工具 sub-items, the sync
// indicator and its 问题 popover, the single error banner, global search results and
// the small monogram used for every AI tool. Pure presentation; App owns the state.
import { type CSSProperties, useEffect, useRef } from "react";
import { Icon, type IconName } from "../icons";
import { t } from "../i18n";
import { agentDotTone, availableAgents, sidebarAgents, type SyncIndicator } from "../deliveryView";
import { skillHubErrorText } from "../skillErrors";
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

const NAV: Array<{ key: NavKey; icon: IconName; label: string }> = [
  { key: "dashboard", icon: "dashboard", label: "nav.dashboard" },
  { key: "library", icon: "library", label: "nav.library" },
  { key: "connections", icon: "plug", label: "nav.connections" },
  { key: "agents", icon: "agent", label: "nav.agents" }
];

export function Sidebar({
  active,
  agentDetailId,
  delivery,
  updateCount,
  onAdd,
  onNavigate,
  onOpenAgent
}: {
  active: NavKey;
  agentDetailId: string | null;
  delivery: SkillDeliveryState | null;
  updateCount: number;
  onAdd: () => void;
  onNavigate: (key: NavKey) => void;
  onOpenAgent: (agentId: string | null) => void;
}) {
  const managed = sidebarAgents(delivery);
  const discovered = availableAgents(delivery);
  return (
    <aside className="sidebar">
      <div className="brand">
        <img alt="AI SkillHub" className="brand-logo" src="/ai-skillhub-logo.png" />
        <div>
          <strong>AI SkillHub</strong>
        </div>
      </div>
      <button className="nav-add" data-testid="sidebar-add-button" onClick={onAdd} type="button">
        <span className="nav-icon" aria-hidden="true"><Icon name="add" /></span>
        <span className="nav-text"><strong>{t("v33.add")}</strong></span>
        <span className="nav-tip" role="tooltip">{t("v33.add")}</span>
      </button>
      <nav className="nav" aria-label={t("v33.navLabel")}>
        {NAV.map(item => (
          <div className="nav-group" key={item.key}>
            <button
              aria-current={active === item.key && !(item.key === "agents" && agentDetailId) ? "page" : undefined}
              className={active === item.key ? "nav-item active" : "nav-item"}
              data-testid={`nav-${item.key}`}
              onClick={() => {
                if (item.key === "agents") onOpenAgent(null);
                onNavigate(item.key);
              }}
              type="button"
            >
              <span className="nav-icon" aria-hidden="true"><Icon name={item.icon} /></span>
              <span className="nav-text"><strong>{t(item.label)}</strong></span>
              {item.key === "library" && updateCount > 0 && (
                <em className="nav-badge" title={t("v33.updatesBadge", { n: updateCount })}>{updateCount}</em>
              )}
              <span className="nav-tip" role="tooltip">{t(item.label)}</span>
            </button>
            {item.key === "agents" && (managed.length > 0 || discovered.length > 0) && (
              <div className="nav-sub">
                {managed.map(agent => (
                  <button
                    aria-current={active === "agents" && agentDetailId === agent.id ? "page" : undefined}
                    className={active === "agents" && agentDetailId === agent.id ? "nav-sub-item active" : "nav-sub-item"}
                    data-testid={`nav-agent-${agent.id}`}
                    key={agent.id}
                    onClick={() => {
                      onOpenAgent(agent.id);
                      onNavigate("agents");
                    }}
                    title={agent.name}
                    type="button"
                  >
                    <AgentGlyph agentId={agent.id} name={agent.name} size="sm" />
                    <span className="nav-text">{agent.name}</span>
                    <em className="nav-sub-count">{agent.counts.skillsSynced}</em>
                    <i className={`agent-dot tone-${agentDotTone(agent.health)}`} aria-label={t(`v33.health.${agentDotTone(agent.health)}`)} />
                  </button>
                ))}
                {discovered.length > 0 && (
                  <button
                    className="nav-sub-item discover"
                    data-testid="nav-discover-agents"
                    onClick={() => {
                      onOpenAgent(null);
                      onNavigate("agents");
                    }}
                    title={t("v33.discoverTools", { n: discovered.length })}
                    type="button"
                  >
                    <span className="nav-sub-plus" aria-hidden="true"><Icon name="add" /></span>
                    <span className="nav-text">{t("v33.discoverTools", { n: discovered.length })}</span>
                  </button>
                )}
              </div>
            )}
          </div>
        ))}
      </nav>
      <div className="sidebar-footer">
        <button
          aria-current={active === "settings" ? "page" : undefined}
          className={active === "settings" ? "nav-item active" : "nav-item"}
          data-testid="nav-settings"
          onClick={() => onNavigate("settings")}
          type="button"
        >
          <span className="nav-icon" aria-hidden="true"><Icon name="settings" /></span>
          <span className="nav-text"><strong>{t("nav.settings")}</strong></span>
          <span className="nav-tip" role="tooltip">{t("nav.settings")}</span>
        </button>
      </div>
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
  onClose
}: {
  problems: DeliveryProblem[];
  agents: SkillAgent[];
  onAction: (action: ErrorAction, problem: DeliveryProblem) => void;
  onClose: () => void;
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
              <p>{problem.message}</p>
              {problem.action && (
                <button className="ghost-action small" data-testid="problem-action" onClick={() => onAction(problem.action!, problem)} type="button">
                  {t(`err.action.${problem.action.kind}`)}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
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
