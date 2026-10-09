// Detail drawer for one library row (skills contract §6.3): 概览 · 版本 · 设置.
// Opened from a row or a global search result; it takes focus, Escape closes it, focus
// returns to whatever opened it (bug #7), and unsaved settings ask before closing (bug #31).
// The SKILL.md preview lives only while the drawer is open.
import { useEffect, useMemo, useState } from "react";
import { Icon } from "../icons";
import { getLang, t } from "../i18n";
import { localizedSkillDescription } from "../localizedDescriptions";
import { rowFilterState, type LibraryRow } from "../skillCounts";
import { orderTargetsForRow, targetIconView } from "../deliveryView";
import { readLibrarySkillDocument } from "../skillApi";
import { normalizeSkillHubError, skillHubErrorText } from "../skillErrors";
import type {
  AgentId,
  LegacySnapshot,
  LibrarySkillDocument,
  SkillAgent,
  SkillCard,
  SkillFolderCard,
  SkillTarget,
  SourceCard,
  SourceGovernanceCard,
  SourcePopularityCard,
  SourceQualitySignalCard
} from "../types";
import {
  CATEGORY_IDS,
  type SkillDraft,
  type SourceDraft,
  displayCategoryName,
  formatCompactNumber,
  isRouterHubSkill,
  showUiToast,
  skillInvocationName,
  stableSkillClientId,
  copyTextToClipboard
} from "../appShared";
import { Dialog, Drawer, StarRating, ToggleSwitch, useConfirm } from "../components/ui";
import { AgentGlyph } from "../components/shell";
import { PromptPanel } from "./PromptPanel";
import "./library.css";

type Tab = "overview" | "versions" | "settings";
const CHILD_LIMIT = 60;
const DOC_PREVIEW_CHARS = 24_000;

function stripRouterMarker(text: string) {
  return text.replace(/\[ROUTER-HUB\]/gi, "").replace(/<!--[\s\S]*?-->/g, "").trim();
}

function entrySkillOf(row: LibraryRow): SkillCard | null {
  if (row.skill) return row.skill;
  if (row.skills.length === 1) return row.skills[0];
  return row.ownedSkills.find(skill => isRouterHubSkill(skill)) ?? row.skills[0] ?? null;
}

function shortRevision(value?: string) {
  return value ? value.slice(0, 8) : "";
}

export function SkillDrawer({
  agents,
  busyAction,
  childBusy,
  folders,
  governance,
  initialTab,
  onClose,
  onDeleteSource,
  onMoveSkillToFolder,
  onMoveSourceToFolder,
  onOpenAgentFolder,
  onRefreshVersion,
  onReloadLibrary,
  onReview,
  onRollbackVersion,
  onSaveSkillMetadata,
  onSaveSourceMetadata,
  onSetChildEnabled,
  onSetLibraryEnabled,
  onSetPinned,
  onSetSkillRating,
  onSetSourceRating,
  onTargetClick,
  onToggleTarget,
  paused,
  popularity,
  row,
  signals
}: {
  agents: SkillAgent[];
  busyAction: string;
  childBusy: ReadonlySet<string>;
  folders: SkillFolderCard[];
  governance: SourceGovernanceCard | null;
  initialTab: Tab;
  onClose: () => void;
  onDeleteSource: (source: SourceCard) => Promise<"failed" | "preview" | "deleted">;
  onMoveSkillToFolder: (skillId: string, folderId: string) => Promise<LegacySnapshot | null>;
  onMoveSourceToFolder: (sourceId: string, folderId: string) => Promise<LegacySnapshot | null>;
  onOpenAgentFolder: (agentId: string) => void;
  onRefreshVersion: (source: SourceCard) => Promise<boolean>;
  /** Re-reads the library (a prompt's Skill launcher was created). */
  onReloadLibrary: () => Promise<unknown>;
  onReview: (sourceId: string) => void;
  onRollbackVersion: (source: SourceCard) => Promise<boolean>;
  onSaveSkillMetadata: (skill: SkillCard, draft: SkillDraft) => Promise<"failed" | "partial" | "preview" | "saved">;
  onSaveSourceMetadata: (source: SourceCard, draft: SourceDraft) => Promise<"failed" | "preview" | "saved">;
  onSetChildEnabled: (skill: SkillCard, enabled: boolean) => Promise<boolean>;
  onSetLibraryEnabled: (source: SourceCard, enabled: boolean, confirmed: boolean) => Promise<boolean>;
  onSetPinned: (source: SourceCard, pinned: boolean) => Promise<boolean>;
  onSetSkillRating: (skill: SkillCard, rating: number) => Promise<boolean>;
  onSetSourceRating: (source: SourceCard, rating: number) => Promise<boolean>;
  onTargetClick: (row: LibraryRow, target: SkillTarget) => void;
  onToggleTarget: (unitId: string, agentId: AgentId, enabled: boolean) => void;
  paused: boolean;
  popularity: SourcePopularityCard | null;
  row: LibraryRow;
  signals: SourceQualitySignalCard | null;
}) {
  const hasVersions = Boolean(row.source);
  const [tab, setTab] = useState<Tab>(initialTab === "versions" && !hasVersions ? "overview" : initialTab);
  const [dirty, setDirty] = useState(false);
  const [confirmNode, askConfirm] = useConfirm();
  const name = row.source?.name ?? row.skill?.name ?? row.key;
  const entry = entrySkillOf(row);

  async function requestClose() {
    if (dirty) {
      const discard = await askConfirm({
        title: t("v33.discardTitle"),
        body: t("v33.discardBody"),
        confirmLabel: t("v33.discardConfirm"),
        danger: true,
        testId: "discard-dialog"
      });
      if (!discard) return;
    }
    onClose();
  }

  const tabs: Array<{ key: Tab; label: string }> = [
    { key: "overview", label: t("v33.tabOverview") },
    ...(hasVersions ? [{ key: "versions" as const, label: t("v33.tabVersions") }] : []),
    { key: "settings", label: t("v33.tabSettings") }
  ];

  return (
    <Drawer
      eyebrow={row.kind === "prompt" ? t("v33.promptKind") : row.kind === "standalone" ? t("v33.standaloneSkill") : t("v33.skillPack")}
      headerExtra={entry ? (
        <button
          className="ghost-action small"
          onClick={() => void copyTextToClipboard(skillInvocationName(entry), t("v33.invocationCopied"))}
          title={t("v33.copyInvocation")}
          type="button"
        >
          <Icon name="copy" /> {t("v33.copyInvocation")}
        </button>
      ) : null}
      onClose={() => void requestClose()}
      testId="skill-drawer"
      title={name}
      wide
    >
      <div className="drawer-tabs" role="tablist">
        {tabs.map(item => (
          <button
            aria-selected={tab === item.key}
            className={tab === item.key ? "active" : ""}
            data-testid={`drawer-tab-${item.key}`}
            key={item.key}
            onClick={async () => {
              if (tab === "settings" && item.key !== "settings" && dirty) {
                const discard = await askConfirm({ title: t("v33.discardTitle"), body: t("v33.discardBody"), confirmLabel: t("v33.discardConfirm"), danger: true });
                if (!discard) return;
                setDirty(false);
              }
              setTab(item.key);
            }}
            role="tab"
            type="button"
          >
            {item.label}
          </button>
        ))}
      </div>
      {tab === "overview" && (
        <OverviewTab
          agents={agents}
          childBusy={childBusy}
          entry={entry}
          onOpenAgentFolder={onOpenAgentFolder}
          onEnablePack={source => void onSetLibraryEnabled(source, true, false)}
          onReloadLibrary={onReloadLibrary}
          onReview={onReview}
          onSetChildEnabled={onSetChildEnabled}
          onTargetClick={target => onTargetClick(row, target)}
          onToggleTarget={onToggleTarget}
          paused={paused}
          popularity={popularity}
          row={row}
        />
      )}
      {tab === "versions" && row.source && (
        <VersionsTab
          busy={busyAction === "version"}
          governance={governance}
          onRefresh={() => void onRefreshVersion(row.source!)}
          onRollback={() => void onRollbackVersion(row.source!)}
          onSetPinned={pinned => void onSetPinned(row.source!, pinned)}
        />
      )}
      {tab === "settings" && (
        <SettingsTab
          busy={busyAction.startsWith("save") || busyAction === "delete"}
          folders={folders}
          onDelete={async () => {
            if (!row.source) return;
            const result = await onDeleteSource(row.source);
            if (result !== "failed") onClose();
          }}
          onDirtyChange={setDirty}
          onSaved={() => setDirty(false)}
          row={row}
          save={async draft => {
            const failed: string[] = [];
            if (row.source) {
              const source = row.source;
              const metadataChanged = draft.name !== source.name || draft.category !== source.categoryId || draft.note !== (source.note ?? "") || draft.tags !== (source.tags ?? []).join(", ");
              if (metadataChanged) {
                const result = await onSaveSourceMetadata(source, { name: draft.name, category: draft.category, note: draft.note, tags: draft.tags, enabled: source.enabled, sourceType: source.sourceType });
                if (result === "failed") failed.push(t("v33.partName"));
              }
              if (draft.rating !== (source.rating ?? 0) && !(await onSetSourceRating(source, draft.rating))) failed.push(t("v33.rating"));
              if (draft.folderId !== (source.userFolderId ?? "") && !(await onMoveSourceToFolder(source.id, draft.folderId))) failed.push(t("v33.partFolder"));
              const enabled = !draft.disabled;
              if (enabled !== (row.unit ? row.unit.libraryEnabled || row.unit.libraryOnlyReason === "no-enabled-skills" : source.enabled)) {
                const ok = await onSetLibraryEnabled(source, enabled, false);
                if (!ok) failed.push(t("v33.partEnabled"));
              }
            } else if (row.skill) {
              const skill = row.skill;
              const metadataChanged = draft.name !== skill.name || draft.category !== skill.category || draft.note !== (skill.note ?? "") || draft.tags !== (skill.tags ?? []).join(", ") || draft.description !== stripRouterMarker(skill.description);
              if (metadataChanged) {
                const result = await onSaveSkillMetadata(skill, { name: draft.name, category: draft.category, description: draft.description, note: draft.note, tags: draft.tags });
                if (result === "failed") failed.push(t("v33.partName"));
                if (result === "partial") failed.push(t("v33.partTags"));
              }
              if (draft.rating !== (skill.rating ?? 0) && !(await onSetSkillRating(skill, draft.rating))) failed.push(t("v33.rating"));
              if (draft.folderId !== (skill.userFolderId ?? "") && !(await onMoveSkillToFolder(stableSkillClientId(skill), draft.folderId))) failed.push(t("v33.partFolder"));
              if (draft.disabled === skill.enabled && !(await onSetChildEnabled(skill, !draft.disabled))) failed.push(t("v33.partEnabled"));
            }
            if (failed.length > 0) {
              showUiToast(t("v33.partialSave", { parts: failed.join("、") }), "error");
              return false;
            }
            return true;
          }}
        />
      )}
      {confirmNode}
    </Drawer>
  );
}

/* ---------- 概览 ---------- */

function OverviewTab({
  agents,
  childBusy,
  entry,
  onEnablePack,
  onReloadLibrary,
  onOpenAgentFolder,
  onReview,
  onSetChildEnabled,
  onTargetClick,
  onToggleTarget,
  paused,
  popularity,
  row
}: {
  agents: SkillAgent[];
  childBusy: ReadonlySet<string>;
  entry: SkillCard | null;
  onEnablePack: (source: SourceCard) => void;
  onReloadLibrary: () => Promise<unknown>;
  onOpenAgentFolder: (agentId: string) => void;
  onReview: (sourceId: string) => void;
  onSetChildEnabled: (skill: SkillCard, enabled: boolean) => Promise<boolean>;
  onTargetClick: (target: SkillTarget) => void;
  onToggleTarget: (unitId: string, agentId: AgentId, enabled: boolean) => void;
  paused: boolean;
  popularity: SourcePopularityCard | null;
  row: LibraryRow;
}) {
  const [doc, setDoc] = useState<LibrarySkillDocument | null>(null);
  const [docError, setDocError] = useState("");
  const [allChildren, setAllChildren] = useState(false);
  const managed = agents.filter(agent => agent.takeover && agent.canDeliver);
  const targets = orderTargetsForRow(row.targets, agents);
  const conflicts = row.targets.filter(target => target.status === "conflict");
  const reason = row.unit?.libraryOnlyReason ?? "";
  const state = rowFilterState(row);

  useEffect(() => {
    if (!entry) return;
    let cancelled = false;
    setDoc(null);
    setDocError("");
    void readLibrarySkillDocument(entry.id || stableSkillClientId(entry))
      .then(result => {
        if (!cancelled) setDoc(result);
      })
      .catch(error => {
        if (!cancelled) setDocError(skillHubErrorText(normalizeSkillHubError(error), t) || t("v33.docUnavailable"));
      });
    return () => {
      cancelled = true;
    };
  }, [entry?.id, entry?.folderName]);

  const docText = useMemo(() => {
    if (!doc) return "";
    const text = stripRouterMarker(doc.content);
    return text.length > DOC_PREVIEW_CHARS ? `${text.slice(0, DOC_PREVIEW_CHARS)}\n…` : text;
  }, [doc]);
  const children = row.skills.length > 1 ? row.skills : [];

  return (
    <div className="drawer-section-stack" data-testid="drawer-overview">
      {row.kind === "prompt" && row.source && <PromptPanel onCreated={onReloadLibrary} sourceId={row.source.id} />}
      {reason === "security-review" && row.source && (
        <section className="drawer-notice warn">
          <Icon name="shield" />
          <div>
            <strong>{t("v33.libraryOnlyTitle")}</strong>
            <span>{t("v33.libraryOnlyBody")}</span>
          </div>
          <button className="primary-action small" data-testid="drawer-review" onClick={() => onReview(row.source!.id)} type="button">{t("v33.reviewAndEnable")}</button>
        </section>
      )}
      {(reason === "disabled-by-user" || reason === "no-enabled-skills") && (
        <section className="drawer-notice">
          <Icon name="info" />
          <span>{reason === "disabled-by-user" ? t("v33.disabledEverywhere") : t("v33.noEnabledSkills")}</span>
          {reason === "disabled-by-user" && row.source && (
            <button className="primary-action small" data-testid="drawer-enable" onClick={() => onEnablePack(row.source!)} type="button">{t("v33.enablePack")}</button>
          )}
        </section>
      )}
      {conflicts.map(target => {
        const agent = agents.find(item => item.id === target.agentId);
        return (
          <section className="drawer-notice problem" data-testid="drawer-conflict" key={target.agentId}>
            <Icon name="alert" />
            <div>
              <strong>{t(target.conflict?.sameContent ? "target.conflictSame" : "target.conflict", { tool: agent?.name ?? target.agentId })}</strong>
              <span>{t("v33.conflictBody")}</span>
              {target.conflict?.path && <code>{target.conflict.path}</code>}
            </div>
            <button className="ghost-action small" onClick={() => onOpenAgentFolder(target.agentId)} type="button">{t("v33.openFolder")}</button>
          </section>
        );
      })}

      <section className="drawer-block">
        <header>
          <strong>{t("v33.syncTargets")}</strong>
          {paused && <span className="chip"><Icon name="pause" /> {t("sync.paused")}</span>}
        </header>
        {row.kind === "prompt" ? (
          <p className="muted">{t("v33.promptNotSynced")}</p>
        ) : managed.length === 0 ? (
          <p className="muted">{t("v33.noManagedTools")}</p>
        ) : (
          <ul className="drawer-targets">
            {targets.map(target => {
              const agent = agents.find(item => item.id === target.agentId);
              const view = targetIconView(target, reason);
              const busy = target.status === "pending" || target.status === "removing";
              const statusLabel = t(`v33.status.${target.status}`);
              return (
                <li key={target.agentId} data-testid={`drawer-target-${target.agentId}`} data-status={target.status}>
                  <AgentGlyph agentId={target.agentId} name={agent?.name} size="sm" />
                  <span className="drawer-target-name">{agent?.name ?? target.agentId}</span>
                  <span className={`drawer-target-status look-${view.look}`}>{statusLabel}</span>
                  {target.status === "error" || target.status === "conflict" || target.status === "orphan" || target.status === "blocked" || target.status === "paused" ? (
                    <button className="ghost-action small" onClick={() => onTargetClick(target)} type="button">{t(`v33.targetAction.${view.action}`)}</button>
                  ) : (
                    <ToggleSwitch
                      busy={busy}
                      disabled={busy || view.disabled || !agent?.takeover}
                      enabled={target.desired}
                      label={t(target.desired ? "v33.syncedToTool" : "v33.notSyncedToTool", { tool: agent?.name ?? target.agentId })}
                      onClick={() => row.unit && onToggleTarget(row.unit.unitId, target.agentId, !target.desired)}
                      showLabel={false}
                    />
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {children.length > 0 && (
        <section className="drawer-block">
          <header>
            <strong>{t("v33.includedSkills", { n: children.length })}</strong>
          </header>
          <ul className="drawer-children">
            {(allChildren ? children : children.slice(0, CHILD_LIMIT)).map(skill => (
              <li key={skill.folderName}>
                <span>
                  <strong>{skill.name}</strong>
                  <small>{stripRouterMarker(localizedSkillDescription(skill, getLang()) || skill.description) || displayCategoryName(skill.category)}</small>
                </span>
                <ToggleSwitch
                  busy={childBusy.has(skill.folderName)}
                  disabled={childBusy.has(skill.folderName)}
                  enabled={skill.enabled}
                  label={skill.enabled ? t("v33.childOn", { name: skill.name }) : t("v33.childOff", { name: skill.name })}
                  onClick={() => void onSetChildEnabled(skill, !skill.enabled)}
                  showLabel={false}
                  testId={`drawer-child-switch-${skill.folderName}`}
                />
              </li>
            ))}
          </ul>
          {!allChildren && children.length > CHILD_LIMIT && (
            <button className="ghost-action small" onClick={() => setAllChildren(true)} type="button">{t("v33.showAllChildren", { n: children.length })}</button>
          )}
        </section>
      )}

      {entry && (
        <section className="drawer-block">
          <header>
            <strong>SKILL.md</strong>
            {doc && <small className="muted">{doc.path}</small>}
          </header>
          {docError ? (
            <p className="muted">{docError}</p>
          ) : !doc ? (
            <p className="muted" role="status">{t("v33.docLoading")}</p>
          ) : (
            <>
              <pre className="skill-doc" data-testid="skill-doc">{docText}</pre>
              {doc.files.length > 0 && (
                <details className="skill-files">
                  <summary>{t("v33.files", { n: doc.files.length })}</summary>
                  <ul>{doc.files.slice(0, 200).map(file => <li key={file}><code>{file}</code></li>)}</ul>
                </details>
              )}
            </>
          )}
        </section>
      )}

      {row.source && (
        <section className="drawer-block drawer-facts">
          <span><b>{row.skills.length}</b><small>{t("v33.metricSkills")}</small></span>
          <span><b>{popularity?.stars ? formatCompactNumber(popularity.stars) : "—"}</b><small>{t("srcEditor.stars")}</small></span>
          <span><b>{popularity?.localTotalCount ?? 0}</b><small>{t("srcEditor.calls")}</small></span>
          {state.update && <span className="chip chip-update">{t("v33.updateChip")}</span>}
        </section>
      )}
    </div>
  );
}

/* ---------- 版本 ---------- */

function VersionsTab({
  busy,
  governance,
  onRefresh,
  onRollback,
  onSetPinned
}: {
  busy: boolean;
  governance: SourceGovernanceCard | null;
  onRefresh: () => void;
  onRollback: () => void;
  onSetPinned: (pinned: boolean) => void;
}) {
  if (governance?.supportStatus !== "git") {
    return (
      <section className="source-governance-panel" data-testid="drawer-versions">
        <p>{t("governance.localExplanation")}</p>
      </section>
    );
  }
  return (
    <section className="source-governance-panel" aria-label={t("governance.title")} data-testid="drawer-versions">
      <header>
        <div>
          <span>{t("governance.eyebrow")}</span>
          <strong>{governance.pinned ? t("governance.pinned") : t("governance.autoUpdate")}</strong>
        </div>
        {governance.diffSource === "cached" && <em>{t("governance.cached")}</em>}
      </header>
      <dl className="source-governance-revisions">
        <div><dt>{t("governance.current")}</dt><dd>{shortRevision(governance.currentRevision) || "—"}</dd></div>
        <div><dt>{t("governance.upstream")}</dt><dd>{shortRevision(governance.remoteRevision) || "—"}</dd></div>
        <div>
          <dt>{t("governance.diff")}</dt>
          <dd>{t("governance.diffValue", { files: governance.changedFiles, additions: governance.additions, deletions: governance.deletions })}</dd>
        </div>
        <div><dt>{t("governance.backups")}</dt><dd>{governance.backupCount}</dd></div>
      </dl>
      {governance.trackingBranch && <p className="source-governance-branch">{t("governance.tracking", { branch: governance.trackingBranch })}</p>}
      {governance.remoteDefaultBranch
        && governance.trackingBranch
        && !governance.trackingBranch.endsWith(`/${governance.remoteDefaultBranch}`)
        && governance.trackingBranch !== governance.remoteDefaultBranch && (
        <p className="source-governance-branch-warning" role="note">
          {t("governance.defaultBranchChanged", { remote: governance.remoteDefaultBranch, branch: governance.trackingBranch })}
        </p>
      )}
      {governance.remoteSummary && <p>{governance.remoteSummary}</p>}
      <div className="source-governance-actions">
        <button className="ghost-action small" disabled={busy} onClick={onRefresh} type="button">
          <Icon className={busy ? "icon-spin" : ""} name="refresh" /> {t("governance.refresh")}
        </button>
        <button className={governance.pinned ? "ghost-action small active" : "ghost-action small"} disabled={busy} onClick={() => onSetPinned(!governance.pinned)} type="button">
          <Icon name="shield" /> {governance.pinned ? t("governance.unpin") : t("governance.pin")}
        </button>
        <button
          className="ghost-action small"
          disabled={busy || !governance.canRollback}
          onClick={onRollback}
          title={governance.canRollback ? t("governance.rollbackTip", { revision: shortRevision(governance.latestBackupRevision) }) : t("governance.noRollback")}
          type="button"
        >
          <Icon name="snapshots" /> {t("governance.rollback")}
        </button>
      </div>
    </section>
  );
}

/* ---------- 设置 ---------- */

type SettingsDraft = {
  name: string;
  category: string;
  description: string;
  tags: string;
  note: string;
  rating: number;
  folderId: string;
  disabled: boolean;
};

function initialDraft(row: LibraryRow): SettingsDraft {
  if (row.source) {
    const source = row.source;
    const enabled = row.unit ? row.unit.libraryEnabled || row.unit.libraryOnlyReason === "no-enabled-skills" : source.enabled;
    return {
      name: source.name,
      category: source.categoryId,
      description: "",
      tags: (source.tags ?? []).join(", "),
      note: source.note ?? "",
      rating: source.rating ?? 0,
      folderId: source.userFolderId ?? "",
      disabled: !enabled
    };
  }
  const skill = row.skill!;
  return {
    name: skill.name,
    category: skill.category,
    description: stripRouterMarker(skill.description),
    tags: (skill.tags ?? []).join(", "),
    note: skill.note ?? "",
    rating: skill.rating ?? 0,
    folderId: skill.userFolderId ?? "",
    disabled: !skill.enabled
  };
}

function SettingsTab({
  busy,
  folders,
  onDelete,
  onDirtyChange,
  onSaved,
  row,
  save
}: {
  busy: boolean;
  folders: SkillFolderCard[];
  onDelete: () => Promise<void>;
  onDirtyChange: (dirty: boolean) => void;
  onSaved: () => void;
  row: LibraryRow;
  save: (draft: SettingsDraft) => Promise<boolean>;
}) {
  const [base, setBase] = useState(() => initialDraft(row));
  const [draft, setDraft] = useState(base);
  const [saving, setSaving] = useState(false);
  const dirty = JSON.stringify(base) !== JSON.stringify(draft);
  useEffect(() => onDirtyChange(dirty), [dirty]);
  const categories = CATEGORY_IDS.includes(draft.category as (typeof CATEGORY_IDS)[number]) || !draft.category
    ? CATEGORY_IDS
    : [...CATEGORY_IDS, draft.category];
  const update = (patch: Partial<SettingsDraft>) => setDraft(current => ({ ...current, ...patch }));
  const disabled = busy || saving;
  return (
    <form
      className="drawer-form"
      data-testid="drawer-settings"
      onSubmit={async event => {
        event.preventDefault();
        if (!dirty || disabled) return;
        setSaving(true);
        try {
          const ok = await save(draft);
          if (ok) {
            setBase(draft);
            onSaved();
            showUiToast(t("v33.saved"), "ok");
          }
        } finally {
          setSaving(false);
        }
      }}
    >
      <label className="field">
        <span>{t("v33.fieldName")}</span>
        <input disabled={disabled} maxLength={120} onChange={event => update({ name: event.target.value })} value={draft.name} />
      </label>
      <label className="field">
        <span>{t("v33.fieldCategory")}</span>
        <select disabled={disabled} onChange={event => update({ category: event.target.value })} value={draft.category}>
          {categories.map(id => <option key={id} value={id}>{displayCategoryName(id)}</option>)}
        </select>
      </label>
      {row.skill && (
        <label className="field">
          <span>{t("v33.description")}</span>
          <textarea disabled={disabled} onChange={event => update({ description: event.target.value })} rows={3} value={draft.description} />
        </label>
      )}
      <label className="field">
        <span>{t("v33.fieldTags")}</span>
        <input disabled={disabled} onChange={event => update({ tags: event.target.value })} placeholder={t("srcEditor.tagsPlaceholder")} value={draft.tags} />
      </label>
      <div className="field">
        <span>{t("v33.rating")}</span>
        <StarRating disabled={disabled} label={t("v33.rating")} onChange={rating => update({ rating })} value={draft.rating} />
      </div>
      <label className="field">
        <span>{t("v33.fieldNote")}</span>
        <textarea disabled={disabled} onChange={event => update({ note: event.target.value })} placeholder={t("srcEditor.notePlaceholder")} rows={3} value={draft.note} />
      </label>
      <label className="field">
        <span>{t("v33.folder")}</span>
        <select disabled={disabled} onChange={event => update({ folderId: event.target.value })} value={draft.folderId}>
          <option value="">{t("v33.folderUnfiled")}</option>
          {folders.map(folder => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
        </select>
      </label>
      {row.kind !== "prompt" && (
        <label className="field check">
          <input checked={draft.disabled} disabled={disabled} onChange={event => update({ disabled: event.target.checked })} type="checkbox" />
          <span>{row.source ? t("v33.disableEverywhere") : t("v33.disableSkill")}</span>
        </label>
      )}
      <footer>
        {row.source && (
          <button className="danger-action" disabled={disabled} onClick={() => void onDelete()} type="button">
            <Icon name="trash" /> {t("v33.deletePack")}
          </button>
        )}
        <span className="footer-spacer" />
        <button className="secondary-action" disabled={disabled || !dirty} onClick={() => setDraft(base)} type="button">{t("v33.reset")}</button>
        <button className="primary-action" data-testid="drawer-save" disabled={disabled || !dirty} type="submit">
          {saving ? t("v33.saving") : t("common.save")}
        </button>
      </footer>
    </form>
  );
}

/* ---------- 查看风险并启用 ---------- */

export function ReviewSecurityDialog({
  onClose,
  onConfirm,
  signals,
  source
}: {
  onClose: () => void;
  onConfirm: () => Promise<void>;
  signals: SourceQualitySignalCard | null;
  source: SourceCard;
}) {
  const [busy, setBusy] = useState(false);
  const security = signals?.factors.find(factor => factor.key === "security");
  return (
    <Dialog
      className="review-dialog"
      footer={
        <>
          <button className="secondary-action" onClick={onClose} type="button">{t("common.cancel")}</button>
          <button
            className="primary-action"
            data-testid="review-confirm"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm();
              } finally {
                setBusy(false);
              }
            }}
            type="button"
          >
            {busy ? t("v33.saving") : t("v33.reviewConfirm")}
          </button>
        </>
      }
      onClose={onClose}
      testId="review-dialog"
      title={t("v33.reviewTitle", { name: source.name })}
    >
      <p className="dialog-text">{security?.detail || signals?.summary || t("v33.reviewFallback")}</p>
      <p className="dialog-text strong">{t("v33.reviewBody")}</p>
    </Dialog>
  );
}
