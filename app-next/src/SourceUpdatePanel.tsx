import { useId, useMemo, useState } from "react";
import "./SourceUpdatePanel.css";
import { Icon } from "./icons";
import {
  SOURCE_UPDATE_OUTCOMES,
  formatRunTime,
  normalizeOutcome,
  rt,
  skillPathLeaf,
  sortSourceUpdateEntries,
  sourceFolderLabel,
  summarizeSourceUpdateRun
} from "./sourceUpdateRun";
import type { SourceUpdateOutcome, SourceUpdateRun, SourceUpdateRunEntry } from "./types";

type Props = {
  run?: SourceUpdateRun | null;
  busy: boolean;
  onContinue?: () => void;
  /** Compact mode lists only entries that need attention. */
  compact?: boolean;
};

export function SourceUpdatePanel({ run, busy, onContinue, compact = false }: Props) {
  const [filter, setFilter] = useState<SourceUpdateOutcome | "all">("all");
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const summary = summarizeSourceUpdateRun(run);
  const entries = useMemo(() => sortSourceUpdateEntries(run?.sources ?? []), [run]);
  const attention = entries.filter(entry => ["failed", "local-changes", "deferred", "not-git"].includes(normalizeOutcome(entry.outcome)) || entry.addedSkills.length > 0);
  const visible = compact
    ? attention
    : filter === "all"
      ? entries
      : entries.filter(entry => normalizeOutcome(entry.outcome) === filter);

  if (!run || summary.total === 0) {
    if (compact) return null;
    return (
      <section className="source-run-panel is-empty" aria-label={rt("run.title")}>
        <header className="source-run-head">
          <div>
            <h3>{rt("run.title")}</h3>
            <p>{rt("run.empty")}</p>
          </div>
        </header>
      </section>
    );
  }
  if (compact && visible.length === 0 && summary.finished) return null;

  return (
    <section className={compact ? "source-run-panel is-compact" : "source-run-panel"} aria-label={rt("run.title")}>
      <header className="source-run-head">
        <div>
          <h3>{rt("run.title")}</h3>
          <p>
            <span className="source-run-progress">{rt("run.progress", { checked: summary.checked, total: summary.total })}</span>
            <span aria-hidden="true">·</span>
            <span>{summary.finished ? rt("run.finished") : rt("run.pending", { n: summary.pending })}</span>
            {summary.counts.failed > 0 && <span className="source-run-failure">{rt("outcome.failed")} {summary.counts.failed}</span>}
            {run.updatedAt && (
              <>
                <span aria-hidden="true">·</span>
                <time dateTime={run.updatedAt}>{rt("run.checkedAt", { time: formatRunTime(run.updatedAt) })}</time>
              </>
            )}
            {run.rounds > 1 && (
              <>
                <span aria-hidden="true">·</span>
                <span>{rt("run.rounds", { n: run.rounds })}</span>
              </>
            )}
          </p>
        </div>
        <div className="source-run-actions">
        <button className="ghost-action small" type="button" aria-expanded={expanded} aria-controls={detailsId} onClick={() => setExpanded(value => !value)}>
          {rt(expanded ? "run.collapse" : "run.expand")}
        </button>
        {summary.pending > 0 && onContinue && (
          <button className="primary-action small" disabled={busy} onClick={onContinue} type="button">
            <Icon name="refresh" /> {rt("run.continue", { n: summary.pending })}
          </button>
        )}
        </div>
      </header>

      <div className="source-run-meter" role="img" aria-label={rt("run.progress", { checked: summary.checked, total: summary.total })}>
        {SOURCE_UPDATE_OUTCOMES.filter(outcome => summary.counts[outcome] > 0).map(outcome => (
          <i
            className={`outcome-${outcome}`}
            key={outcome}
            style={{ flexGrow: summary.counts[outcome] }}
            title={`${rt(`outcome.${outcome}`)} ${summary.counts[outcome]}`}
          />
        ))}
      </div>

      <div id={detailsId} hidden={!expanded}>
      {!compact && (
        <div className="source-run-filters" role="tablist" aria-label={rt("run.title")}>
          <button
            aria-selected={filter === "all"}
            className={filter === "all" ? "is-active" : ""}
            onClick={() => setFilter("all")}
            role="tab"
            type="button"
          >
            {rt("run.filterAll", { n: summary.total })}
          </button>
          {SOURCE_UPDATE_OUTCOMES.filter(outcome => summary.counts[outcome] > 0).map(outcome => (
            <button
              aria-selected={filter === outcome}
              className={filter === outcome ? `is-active outcome-${outcome}` : `outcome-${outcome}`}
              key={outcome}
              onClick={() => setFilter(outcome)}
              role="tab"
              type="button"
            >
              <span className="source-run-dot" aria-hidden="true" />
              {rt(`outcome.${outcome}`)}
              <b>{summary.counts[outcome]}</b>
            </button>
          ))}
        </div>
      )}

      {summary.addedSkills > 0 && <p className="source-run-note">{rt("run.reloadHint")}</p>}

      <ul className="source-run-list">
        {visible.map(entry => (
          <SourceRunRow entry={entry} key={entry.folder} />
        ))}
      </ul>
      </div>
    </section>
  );
}

function SourceRunRow({ entry }: { entry: SourceUpdateRunEntry }) {
  const outcome = normalizeOutcome(entry.outcome);
  const label = sourceFolderLabel(entry.folder, entry.identity);
  const hintKey = `hint.${outcome}`;
  const hint = entry.detail || (["local-changes", "deferred", "not-git", "pinned"].includes(outcome) ? rt(hintKey) : "");
  return (
    <li className={`source-run-row outcome-${outcome}`}>
      <span className="source-run-status">
        <span className="source-run-dot" aria-hidden="true" />
        {rt(`outcome.${outcome}`)}
      </span>
      <div className="source-run-body">
        <strong title={entry.folder}>{label.title}</strong>
        {label.owner && <small>{label.owner}</small>}
        {entry.tracking && <small className="source-run-branch">{rt("run.tracking", { branch: entry.tracking })}</small>}
        {entry.addedSkills.length > 0 && (
          <p className="source-run-added">
            {rt("run.addedSkills", { names: entry.addedSkills.map(skillPathLeaf).join("、") })}
          </p>
        )}
        {entry.discoveredSkills.length > 0 && (
          <p title={entry.discoveredSkills.join("\n")}>{rt("run.discovered", { n: entry.discoveredSkills.length })}</p>
        )}
        {entry.addedDependencies.length > 0 && (
          <p className="source-run-muted">{rt("run.dependencies", { names: entry.addedDependencies.join("、") })}</p>
        )}
        {entry.keptLocalPaths.length > 0 && (
          <p title={entry.keptLocalPaths.join("\n")}>{rt("run.keptLocal", { n: entry.keptLocalPaths.length })}</p>
        )}
        {hint && <p className="source-run-muted">{hint}</p>}
      </div>
    </li>
  );
}
