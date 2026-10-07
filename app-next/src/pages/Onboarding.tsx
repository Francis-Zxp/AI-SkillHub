// First run (skills contract §6.6, S1-8). Shown instead of the home page while
// onboarding is pending. Until the user clicks 接管, the backend writes nothing to any
// AI tool folder (I-1); "暂不接管" completes onboarding with no tool taken over.
import { useEffect, useState } from "react";
import { Icon } from "../icons";
import { t } from "../i18n";
import { completeOnboarding, getOnboardingState } from "../skillApi";
import { normalizeSkillHubError, skillHubErrorText } from "../skillErrors";
import { getMcpSummary } from "../mcpBridge";
import type { AgentId, OnboardingResult, OnboardingState, SkillHubError } from "../types";
import { DeferredSurface } from "../components/ui";
import { AgentGlyph } from "../components/shell";
import "./agents.css";

export function Onboarding({
  mcpEnabled,
  onDone,
  onLater
}: {
  mcpEnabled: boolean;
  onDone: (result: OnboardingResult, importMcp: boolean) => void;
  onLater: () => void;
}) {
  const [state, setState] = useState<OnboardingState | null>(null);
  const [checked, setChecked] = useState<ReadonlySet<string>>(() => new Set());
  const [adopt, setAdopt] = useState(true);
  const [mcpUnimported, setMcpUnimported] = useState(0);
  const [importMcp, setImportMcp] = useState(true);
  const [busy, setBusy] = useState<"" | "takeover" | "skip">("");
  const [error, setError] = useState<SkillHubError | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getOnboardingState()
      .then(next => {
        if (cancelled) return;
        setState(next);
        setChecked(new Set(next.agents.filter(agent => agent.preselected).map(agent => agent.agentId)));
      })
      .catch(reason => {
        if (!cancelled) setError(normalizeSkillHubError(reason));
      });
    if (mcpEnabled) {
      void getMcpSummary().then(summary => {
        if (!cancelled && summary) setMcpUnimported(summary.unimported);
      });
    }
    return () => {
      cancelled = true;
    };
  }, [mcpEnabled]);

  async function finish(agentIds: AgentId[], adoptExisting: boolean, mode: "takeover" | "skip") {
    setBusy(mode);
    setError(null);
    try {
      const result = await completeOnboarding(agentIds, adoptExisting);
      onDone(result, mode === "takeover" && importMcp && mcpUnimported > 0);
    } catch (reason) {
      setError(normalizeSkillHubError(reason));
    } finally {
      setBusy("");
    }
  }

  if (!state && !error) return <DeferredSurface label={t("v33.readingTools")} />;
  const agents = state?.agents ?? [];
  const selectable = agents.filter(agent => agent.canDeliver && agent.statusWord !== "not-installed");
  const others = agents.filter(agent => !selectable.includes(agent));
  const existing = state?.existingSkills ?? null;
  const count = checked.size;

  return (
    <section className="view onboarding-screen" data-testid="onboarding-screen">
      <div className="onboarding-card glow-card">
        <header>
          <span className="onboarding-icon" aria-hidden="true"><Icon name="sparkle" /></span>
          <div>
            <h2>{t("v33.onboardingTitle", { n: selectable.length })}</h2>
            <p>{t("v33.onboardingBody")}</p>
          </div>
        </header>
        {error && (
          <p className="import-notice error" role="alert"><Icon name="alert" /> {skillHubErrorText(error, t)}</p>
        )}
        <ul className="onboarding-list">
          {selectable.map(agent => (
            <li key={agent.agentId}>
              <label>
                <input
                  checked={checked.has(agent.agentId)}
                  data-testid={`onboarding-agent-${agent.agentId}`}
                  disabled={busy !== ""}
                  onChange={() => setChecked(current => {
                    const next = new Set(current);
                    if (next.has(agent.agentId)) next.delete(agent.agentId);
                    else next.add(agent.agentId);
                    return next;
                  })}
                  type="checkbox"
                />
                <AgentGlyph agentId={agent.agentId} name={agent.name} />
                <strong>{agent.name}</strong>
                {agent.experimental && <em className="chip chip-experimental">{t("v33.experimental")}</em>}
                {agent.reason && !agent.experimental && <small className="muted">{agent.reason}</small>}
                {(agent.agentId === "codex" || agent.agentId === "coze") && agents.some(item => item.agentId === (agent.agentId === "codex" ? "coze" : "codex") && item.canDeliver && item.statusWord !== "not-installed") && (
                  <small className="chip chip-linked"><Icon name="link" /> {t(agent.agentId === "codex" ? "v33.sharedWithCoze" : "v33.sharedWithCodex")}</small>
                )}
              </label>
            </li>
          ))}
          {others.map(agent => (
            <li className="disabled" key={agent.agentId}>
              <label>
                <input disabled type="checkbox" />
                <AgentGlyph agentId={agent.agentId} name={agent.name} />
                <strong>{agent.name}</strong>
                <small className="muted">{agent.reason || t("v33.notSupportedReason")}</small>
              </label>
            </li>
          ))}
        </ul>
        <div className="onboarding-options">
          {existing && existing.importable > 0 && (
            <label>
              <input checked={adopt} data-testid="onboarding-adopt" disabled={busy !== ""} onChange={event => setAdopt(event.target.checked)} type="checkbox" />
              <span>{t("v33.onboardingAdopt", { n: existing.importable })}</span>
            </label>
          )}
          {mcpEnabled && mcpUnimported > 0 && (
            <label>
              <input checked={importMcp} data-testid="onboarding-mcp" disabled={busy !== ""} onChange={event => setImportMcp(event.target.checked)} type="checkbox" />
              <span>{t("v33.onboardingMcp", { n: mcpUnimported })}</span>
            </label>
          )}
        </div>
        <footer>
          <button
            className="primary-action"
            data-testid="onboarding-submit"
            disabled={busy !== "" || count === 0}
            onClick={() => void finish([...checked] as AgentId[], adopt && Boolean(existing && existing.importable > 0), "takeover")}
            type="button"
          >
            {busy === "takeover" ? <><Icon className="icon-spin" name="refresh" /> {t("v33.onboardingWorking")}</> : t("v33.onboardingSubmit", { n: count })}
          </button>
          <button className="ghost-action" data-testid="onboarding-skip" disabled={busy !== ""} onClick={() => void finish([], false, "skip")} type="button">
            {t("v33.onboardingSkip")}
          </button>
          <button className="link-action" onClick={onLater} type="button">{t("v33.onboardingLater")}</button>
        </footer>
      </div>
    </section>
  );
}
