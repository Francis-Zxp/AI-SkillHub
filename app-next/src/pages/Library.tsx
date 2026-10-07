// Library page (sources, skills, folders, editors, router hub). Split out of App.tsx;
// App() still owns the shared state and handlers. Never import from App.tsx here (use appShared.ts).
import { invoke } from "@tauri-apps/api/core";
import { type CSSProperties, type DragEvent, useEffect, useMemo, useState } from "react";
import { Icon, type IconName } from "../icons";
import { getLang, t } from "../i18n";
import { localizedSkillDescription } from "../localizedDescriptions";
import { sourcePresentation } from "../sourceIdentity";
import { buildSkyIslands } from "../skyIslandModel";
import { PromptLauncherAction } from "../PromptLauncherAction";
import type {
  AgentSkillStatusCard,
  LegacySnapshot,
  RouterHubReport,
  SkillCard,
  SkillConflictCard,
  SkillFolderCard,
  PromptInvocationCard,
  SourceCard,
  SourceImportExecutionCard,
  SourceImportPlanCard,
  SourceImportPromotionCard,
  SourceGovernanceCard,
  SourcePopularityCard
} from "../types";
import {
  type SkillDraft,
  type SourceDraft,
  loadImportWizardDraft,
  importWizardDraftHasContent,
  type ImportFeedbackOptions,
  hasInternalSkillDrag,
  hasTauriRuntime,
  showUiToast,
  parseTagInput,
  skillMatchesSearch,
  sourceMatchesSearch,
  skillBelongsToSource,
  normalizeLookup,
  isRouterHubSkill,
  stableSkillClientId,
  skillInvocationName,
  displayCategoryName,
  sourceTypeLabel,
  formatCompactNumber,
  formatFileSize,
  copyTextToClipboard,
  copySkillPrompt
} from "../appShared";
import { Drawer, ToggleSwitch } from "../components/ui";
import { ImportWizard } from "./ImportWizard";

type SourceSortKey = "recent" | "rating" | "usage" | "heat" | "skillCount" | "health" | "name";

/* =============================================================
   Library — merged sources + skills tree
   ============================================================= */

type LibraryProps = {
  metadataAnalyzing: boolean;
  onConsolidateSources: () => Promise<LegacySnapshot | null>;
  suggestedLocalPath: string;
  onDismissLocalImport: () => void;
  atlasMode: boolean;
  loading: boolean;
  onCancelImport: (operationId: string) => Promise<boolean>;
  onCreateFolder: (name: string, note: string, color: string) => Promise<LegacySnapshot | null>;
  onDeleteSource: (source: SourceCard) => Promise<"failed" | "preview" | "deleted">;
  onDeleteFolder: (folderId: string) => Promise<LegacySnapshot | null>;
  onPreviewImport: (importKind: string, input: string, options?: ImportFeedbackOptions) => Promise<SourceImportPlanCard>;
  onPromoteImport: (
    importKind: string,
    stagedPath: string,
    sourceName: string,
    options?: ImportFeedbackOptions
  ) => Promise<SourceImportPromotionCard>;
  onRecordUsage: (
    targetType: string,
    targetId: string,
    targetName: string,
    sourceName: string,
    eventType: string
  ) => Promise<void>;
  onMoveFolder: (folderId: string, direction: "up" | "down") => Promise<LegacySnapshot | null>;
  onMoveSkillToFolder: (skillId: string, folderId: string) => Promise<LegacySnapshot | null>;
  onMoveSourceSkillsToFolder: (sourceId: string, folderId: string) => Promise<LegacySnapshot | null>;
  onReanalyzeMetadata: () => Promise<LegacySnapshot | null>;
  onRefreshIndex: (localOnly?: boolean) => Promise<LegacySnapshot | null>;
  onSaveSkillMetadata: (skill: SkillCard, draft: SkillDraft) => Promise<"failed" | "preview" | "saved">;
  onSaveSourceMetadata: (source: SourceCard, draft: SourceDraft) => Promise<"failed" | "preview" | "saved">;
  onSetSkillEnabled: (skill: SkillCard, enabled: boolean) => Promise<boolean>;
  onSetSkillRating: (skill: SkillCard, rating: number) => Promise<boolean>;
  onSetSourceRating: (source: SourceCard, rating: number) => Promise<boolean>;
  onSetSourceVersionPin: (source: SourceCard, pinned: boolean) => Promise<boolean>;
  onUpdateFolder: (folderId: string, name: string, note: string, color: string) => Promise<LegacySnapshot | null>;
  onRefreshSourceVersion: (source: SourceCard) => Promise<boolean>;
  onRollbackSourceVersion: (source: SourceCard) => Promise<boolean>;
  onStageImport: (importKind: string, input: string, options?: ImportFeedbackOptions) => Promise<SourceImportExecutionCard>;
  realWritesEnabled: boolean;
  searchQuery: string;
  selectedFolderId: string;
  onSelectFolder: (folderId: string) => void;
  snapshot: LegacySnapshot | null;
};

export function Library(props: LibraryProps) {
  const {
    atlasMode,
    loading,
    onCancelImport,
    onCreateFolder,
    onDeleteSource,
    onDeleteFolder,
    onPreviewImport,
    onPromoteImport,
    onRecordUsage,
    onMoveFolder,
    onMoveSkillToFolder,
    onMoveSourceSkillsToFolder,
    onReanalyzeMetadata,
    onRefreshIndex,
    onSaveSkillMetadata,
    onSaveSourceMetadata,
    onSetSkillEnabled,
    onSetSkillRating,
    onSetSourceRating,
    onSetSourceVersionPin,
    onUpdateFolder,
    onRefreshSourceVersion,
    onRollbackSourceVersion,
    onStageImport,
    realWritesEnabled,
    searchQuery,
    selectedFolderId,
    onSelectFolder: setSelectedFolderId,
    snapshot
  } = props;
  const sources = snapshot?.sources ?? [];
  const skills = snapshot?.skills ?? [];
  const skillFolders = snapshot?.skillFolders ?? [];
  const folderCounts = useMemo(() => new Map(buildSkyIslands(snapshot, "").map(island => [island.id, island.skillCount])), [snapshot]);
  const skillConflicts = snapshot?.skillConflicts ?? [];
  const [sortKey, setSortKey] = useState<SourceSortKey>("recent");
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [editingSourceId, setEditingSourceId] = useState("");
  const [editingSkillId, setEditingSkillId] = useState("");
  const [showImport, setShowImport] = useState(() => Boolean(props.suggestedLocalPath) || importWizardDraftHasContent(loadImportWizardDraft()));
  const [showMaintenance, setShowMaintenance] = useState(false);
  const [sourceTypeFilter, setSourceTypeFilter] = useState<"all" | "skill" | "prompt" | "other">("all");
  const [sourceDrafts, setSourceDrafts] = useState<Record<string, SourceDraft>>({});
  const [skillDrafts, setSkillDrafts] = useState<Record<string, SkillDraft>>({});
  const [childLimits, setChildLimits] = useState<Record<string, number>>({});
  const [promptInvocation, setPromptInvocation] = useState<PromptInvocationCard | null>(null);
  const [promptInvocationPending, setPromptInvocationPending] = useState("");

  const skillsBySourceId = useMemo(() => {
    const grouped = new Map<string, SkillCard[]>();
    for (const skill of skills) {
      const sourceId = resolveSkillSource(skill, sources)?.id;
      if (!sourceId) continue;
      grouped.set(sourceId, [...(grouped.get(sourceId) ?? []), skill]);
    }
    return grouped;
  }, [skills, sources]);

  useEffect(() => {
    if (snapshot && selectedFolderId !== "all" && selectedFolderId !== "unfiled" &&
        !skillFolders.some(folder => folder.id === selectedFolderId)) setSelectedFolderId("all");
  }, [snapshot, selectedFolderId, skillFolders, setSelectedFolderId]);

  const popularityById = useMemo(
    () => new Map((snapshot?.sourcePopularity ?? []).map(item => [item.sourceId, item])),
    [snapshot?.sourcePopularity]
  );
  const governanceById = useMemo(
    () => new Map((snapshot?.sourceGovernance ?? []).map(item => [item.sourceId, item])),
    [snapshot?.sourceGovernance]
  );
  const agentStatusesBySkill = useMemo(() => {
    const groups = new Map<string, AgentSkillStatusCard[]>();
    for (const status of snapshot?.agentSkillStatuses ?? []) {
      groups.set(status.skillFolderName, [...(groups.get(status.skillFolderName) ?? []), status]);
    }
    return groups;
  }, [snapshot?.agentSkillStatuses]);

  const visibleSources = useMemo(() => {
    const drafted = sources.map(source => applySourceDraft(source, sourceDrafts[source.id]));
    const folderFiltered = selectedFolderId === "all"
      ? drafted
      : drafted.filter(source => sourceMatchesUserFolder(source, selectedFolderId, skillFolders) ||
          (skillsBySourceId.get(source.id) ?? []).some(skill =>
            !isRouterHubSkill(skill) && skillMatchesUserFolder(skill, selectedFolderId, source, skillFolders)));
    const filtered = searchQuery.trim()
      ? folderFiltered.filter(
          source =>
            sourceMatchesSearch(source, searchQuery) ||
            (skillsBySourceId.get(source.id) ?? []).some(skill => skillMatchesSearch(skill, searchQuery))
        )
      : folderFiltered;
    const typed = filtered.filter(source => sourceTypeFilter === "all" ||
      (sourceTypeFilter === "other" ? source.sourceType !== "skill" && source.sourceType !== "prompt" : source.sourceType === sourceTypeFilter));
    return sortSources(typed, sortKey, popularityById, skills);
  }, [popularityById, selectedFolderId, skills, skillsBySourceId, sources, sourceDrafts, sortKey, searchQuery, skillFolders, sourceTypeFilter]);

  const localSkills = useMemo(() => {
    const filtered = skills
      .map(skill => applySkillDraft(skill, skillDrafts[skill.folderName]))
      .filter(skill => {
        if (sourceTypeFilter === "prompt" || sourceTypeFilter === "other") return false;
        if (resolveSkillSource(skill, sources)) {
          return false;
        }
        if (!skillMatchesUserFolder(skill, selectedFolderId, undefined, skillFolders)) return false;
        return searchQuery.trim() ? skillMatchesSearch(skill, searchQuery) : true;
      });
    return sortSkills(filtered, sortKey);
  }, [skillDrafts, skills, sources, selectedFolderId, searchQuery, sortKey, skillFolders, sourceTypeFilter]);

  const totalMatches =
    visibleSources.length +
    skills.filter(skill => skillMatchesSearch(skill, searchQuery)).length;

  function toggleExpand(sourceId: string) {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(sourceId)) next.delete(sourceId);
      else next.add(sourceId);
      return next;
    });
  }
  function expandSource(sourceId: string) {
    setExpanded(prev => {
      const next = new Set(prev);
      next.add(sourceId);
      return next;
    });
  }

  const editingSource = sources.find(source => source.id === editingSourceId) ?? null;
  const editingSkill = skills.find(skill => skill.folderName === editingSkillId) ?? null;

  async function saveSourceDraft(source: SourceCard, draft: SourceDraft) {
    const result = await onSaveSourceMetadata(source, draft);
    if (result === "preview") setSourceDrafts(prev => ({ ...prev, [source.id]: draft }));
    if (result !== "failed") setEditingSourceId("");
  }
  async function saveSkillDraft(skill: SkillCard, draft: SkillDraft) {
    const result = await onSaveSkillMetadata(skill, draft);
    if (result === "preview") setSkillDrafts(prev => ({ ...prev, [skill.folderName]: draft }));
    if (result !== "failed") setEditingSkillId("");
  }

  async function deleteSourceFromPanel(source: SourceCard) {
    const confirmed = window.confirm(t("srcEditor.confirmDelete", { name: source.name }));
    if (!confirmed) return;
    const result = await onDeleteSource(source);
    if (result !== "failed") setEditingSourceId("");
  }

  async function preparePromptInvocation(source: SourceCard) {
    if (!hasTauriRuntime()) {
      showUiToast(t("lib.promptLoadFailed", { message: t("router.browserBlocked") }), "warn");
      return;
    }
    setPromptInvocationPending(source.id);
    try {
      const card = await invoke<PromptInvocationCard>("load_prompt_invocation", {
        sourceId: source.id
      });
      setPromptInvocation(card);
    } catch (error) {
      showUiToast(
        t("lib.promptLoadFailed", {
          message: error instanceof Error ? error.message : String(error)
        }),
        "error"
      );
    } finally {
      setPromptInvocationPending("");
    }
  }

  const githubSources = sources.filter(source => source.url).length;
  const localSources = sources.filter(source => !source.url && source.localPath).length;
  const enabledSkillCount = skills.filter(skill => skill.enabled).length;

  return (
    <div className="view library-view">
      <section className="page-header glow-card">
        <div>
          <span className="eyebrow"><Icon name="library" /> {t("nav.library")}</span>
          <h2>{t("lib.title")}</h2>
          <p>{t("lib.subtitle")}</p>
        </div>
        <div className="page-header-stats">
          <span>{t("lib.statSources", { n: sources.length })}</span>
          <span>{t("lib.statSkills", { n: skills.length })}</span>
          <span>{t("lib.statGithub", { n: githubSources })}</span>
          <span>{t("lib.statLocal", { n: localSources })}</span>
        </div>
      </section>

      <section className="library-toolbar">
        <div className="library-toolbar-left">
          <label className="library-sort">
            <span>{t("lib.sort")}</span>
            <select value={sortKey} onChange={event => setSortKey(event.target.value as SourceSortKey)}>
              <option value="recent">{t("lib.sortRecent")}</option>
              <option value="rating">{t("lib.sortRating")}</option>
              <option value="usage">{t("lib.sortUsage")}</option>
              <option value="heat">{t("lib.sortHeat")}</option>
              <option value="skillCount">{t("lib.sortSkillCount")}</option>
              <option value="health">{t("lib.sortHealth")}</option>
              <option value="name">{t("lib.sortName")}</option>
            </select>
          </label>
          <button
            className="ghost-action"
            onClick={() => setExpanded(new Set(sources.map(source => source.id)))}
            type="button"
          >
            {t("lib.expandAll")}
          </button>
          <button className="ghost-action" onClick={() => setExpanded(new Set())} type="button">
            {t("lib.collapseAll")}
          </button>
        </div>
        <div className="library-toolbar-right">
          <button
            className="ghost-action metadata-reanalyze-action"
            disabled={loading}
            onClick={() => void onReanalyzeMetadata()}
            title={t("metadata.reanalyzeTip")}
            type="button"
          >
            <Icon className={props.metadataAnalyzing ? "icon-spin" : ""} name="refresh" />
            {t("metadata.reanalyze")}
          </button>
          <button
            className={showMaintenance ? "ghost-action active" : "ghost-action"}
            onClick={() => setShowMaintenance(value => !value)}
            type="button"
          >
            <Icon name="settings" /> {t("lib.maintenance")}
          </button>
          <button
            className="primary-action"
            onClick={() => setShowImport(value => !value)}
            type="button"
          >
            <Icon name="add" /> {t("qa.title")}
          </button>
        </div>
      </section>

      {searchQuery.trim() && (
        <section className="search-scope-note">
          <Icon name="search" />
          <span>{t("lib.searchActive", { n: totalMatches })}</span>
        </section>
      )}

      {showImport && (
        <ImportWizard
          suggestedLocalPath={props.suggestedLocalPath}
          onDismissLocalImport={props.onDismissLocalImport}
          disabled={loading}
          onCancel={onCancelImport}
          onCreateFolder={onCreateFolder}
          onPreview={onPreviewImport}
          onPromote={onPromoteImport}
          onRefreshIndex={onRefreshIndex}
          onMoveSourceSkillsToFolder={onMoveSourceSkillsToFolder}
          onSaveSourceMetadata={onSaveSourceMetadata}
          onStage={onStageImport}
          sources={sources}
          skillFolders={skillFolders}
        />
      )}

      {showMaintenance && (
        <div className="library-maintenance">
          <section className="panel duplicate-source-maintenance">
            <h3>{getLang() === "zh" ? "重复仓库" : getLang() === "ko" ? "중복 저장소" : "Duplicate repositories"}</h3>
            <p>{getLang() === "zh" ? "同一 GitHub 仓库且文件内容相同的副本可合并。保留原分类、评分与备注，并备份移出的副本。不同作者的同名技能不合并。" : getLang() === "ko" ? "동일한 GitHub 저장소의 내용이 같은 복사본만 병합합니다. 분류, 평점, 메모와 백업을 보존합니다." : "Consolidate identical copies of the same repository, retaining metadata and backups. Skills from different authors remain separate."}</p>
            <button className="secondary-action" type="button" disabled={loading} onClick={() => void props.onConsolidateSources()}>{getLang() === "zh" ? "合并相同副本" : getLang() === "ko" ? "동일 복사본 병합" : "Consolidate identical copies"}</button>
          </section>
          {atlasMode && skillConflicts.length > 0 && (
            <ParentIsolationPanel conflicts={skillConflicts} />
          )}
          <RouterHubPanel disabled={loading} realWritesEnabled={realWritesEnabled} />
          {!atlasMode && skillConflicts.length > 0 && (
            <ParentIsolationPanel conflicts={skillConflicts} />
          )}
        </div>
      )}

      <SkillFolderShelf
        disabled={loading}
        folders={skillFolders}
        folderCounts={folderCounts}
        onCreate={onCreateFolder}
        onDelete={onDeleteFolder}
        onDropSkill={(skillId, folderId) => onMoveSkillToFolder(skillId, folderId)}
        onDropSource={(sourceId, folderId) => onMoveSourceSkillsToFolder(sourceId, folderId)}
        onMove={onMoveFolder}
        onSelect={setSelectedFolderId}
        onUpdate={onUpdateFolder}
        selectedId={selectedFolderId}
        skills={skills}
      />

      <div className={atlasMode ? "library-stage atlas-library-stage" : "library-stage"}>
        {atlasMode && (
          <aside className="atlas-library-filter-deck" aria-label={t("atlas.filterDeck")}>
            <header>
              <button type="button" className="source-type-filter" aria-pressed={sourceTypeFilter === "all"} onClick={() => setSourceTypeFilter("all")}>{t("nav.library")}</button>
              <b>{visibleSources.length.toLocaleString()}</b>
            </header>
            <div className="atlas-filter-meter">
              <span>{t("atlas.enabledSkills")}</span>
              <strong>{enabledSkillCount}</strong>
              <i style={{ "--meter": `${skills.length ? Math.round((enabledSkillCount / skills.length) * 100) : 0}%` } as CSSProperties} />
            </div>
            <dl>
              {(["skill", "prompt", "other"] as const).map(type => (
                <div key={type}><dt><button type="button" className="source-type-filter" aria-pressed={sourceTypeFilter === type} onClick={() => setSourceTypeFilter(current => current === type ? "all" : type)}>{t(type === "skill" ? "atlas.skillSources" : type === "prompt" ? "atlas.promptSources" : "atlas.otherSources")}</button></dt><dd>{sources.filter(source => type === "other" ? source.sourceType !== "skill" && source.sourceType !== "prompt" : source.sourceType === type).length}</dd></div>
              ))}
            </dl>
          </aside>
        )}

        <section className="library-tree">
        {visibleSources.map(source => {
          const isExpanded = expanded.has(source.id);
          const sourceSkills = sortSkills(
            (skillsBySourceId.get(source.id) ?? [])
              .map(skill => applySkillDraft(skill, skillDrafts[skill.folderName]))
              .filter(skill => skillMatchesUserFolder(skill, selectedFolderId, source, skillFolders))
              .filter(skill => !searchQuery.trim() || skillMatchesSearch(skill, searchQuery) || sourceMatchesSearch(source, searchQuery)),
            sortKey
          );
          const totalSkillCount = Math.max(source.skillCount ?? 0, sourceSkills.length);
          const singleRootSkill = sourceSkills.length === 1;
          const parentSkills = singleRootSkill ? [] : sourceSkills.filter(isRouterHubSkill);
          const childSkills = singleRootSkill ? sourceSkills : sourceSkills.filter(skill => !isRouterHubSkill(skill));
          const primaryInvocationSkill = sourceParentSkill(source, sourceSkills);
          const primaryInvocationName = primaryInvocationSkill ? skillInvocationName(primaryInvocationSkill) : "";
          const childLimit = childLimits[source.id] ?? 36;
          const visibleChildSkills = childSkills.slice(0, childLimit);
          const matchesQuery = searchQuery.trim()
            ? sourceSkills.some(skill => skillMatchesSearch(skill, searchQuery))
            : true;
          const skillCountText =
            source.sourceType === "prompt" && totalSkillCount === 0
              ? t("lib.promptSource")
              : t("lib.skillsTotal", { n: totalSkillCount });
          return (
            <article
              className={`source-group glow-card${isExpanded ? " expanded" : ""}${matchesQuery ? "" : " dimmed"}`}
              key={source.id}
            >
              <header className="source-group-head">
                <button
                  aria-expanded={isExpanded}
                  className="source-group-toggle"
                  onClick={() => toggleExpand(source.id)}
                  type="button"
                >
                  <span className={`source-group-chevron${isExpanded ? " open" : ""}`} aria-hidden="true">
                    <Icon name="chevron" />
                  </span>
                  <span className={`source-avatar tone-${source.url ? sourceTypeTone(source.sourceType, source.categoryId) : "local"}`} aria-hidden="true">
                    <Icon name={source.url ? sourceTypeIcon(source.sourceType) : "sources"} />
                  </span>
                  <div className="source-group-title">
                    <strong title={source.name}>{sourcePresentation(source).title}</strong>
                    <span>
                      {sourcePresentation(source).owner && <em className="source-author">{sourcePresentation(source).owner} · </em>}
                      {displayCategoryName(source.categoryId)} · {sourceTypeLabel(source.sourceType)} ·{" "}
                      {skillCountText}
                    </span>
                  </div>
                </button>
                <div className="source-group-meta">
                  {primaryInvocationSkill && (
                    <button
                      aria-label={t("lib.copyName", { name: primaryInvocationName })}
                      className="icon-action source-parent-copy"
                      onClick={() => void copyTextToClipboard(primaryInvocationName, t("toast.skillNameCopied"))}
                      title={`${t("lib.copyParent")}：${primaryInvocationName}`}
                      type="button"
                    >
                      <Icon name="copy" />
                    </button>
                  )}
                  <span
                    aria-label={t("folders.dragSource", { name: source.name })}
                    aria-disabled={loading}
                    className={`source-folder-drag-handle${loading ? " disabled" : ""}`}
                    draggable={!loading}
                    onDragStart={event => {
                      if (loading) {
                        event.preventDefault();
                        return;
                      }
                      event.dataTransfer.effectAllowed = "move";
                      event.dataTransfer.setData("application/x-ai-skillhub-source-id", source.id);
                      event.dataTransfer.setData("text/plain", source.id);
                    }}
                    title={t("folders.dragSource", { name: source.name })}
                  >
                    <Icon name="grip" />
                    <small>{t("folders.dragShort")}</small>
                  </span>
                  <label className="skill-folder-select source-folder-select" title={t("folders.chooseSource") }>
                    <Icon name="folder" />
                    <select
                      aria-label={t("folders.chooseSource")}
                      disabled={loading}
                      id={`source-folder-${source.id}`}
                      onChange={event => void onMoveSourceSkillsToFolder(source.id, event.target.value)}
                      value={source.userFolderId ?? ""}
                    >
                      <option value="">{t("folders.unfiled")}</option>
                      {skillFolders.map(folder => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
                    </select>
                  </label>
                  <span className="source-parent-rating">
                    <span>{t("lib.parentRating")}</span>
                    <SkillRating
                      disabled={loading}
                      onChange={rating => void onSetSourceRating(source, rating)}
                      rating={source.rating ?? 0}
                      skillName={source.name}
                    />
                  </span>
                  <span className={`status-badge ${source.health}`}>
                    <span className={`status-dot ${statusDotClass(source.health)}`} />
                    {skillStatusLabel(source.health)}
                  </span>
                  <ToggleSwitch
                    disabled={loading}
                    enabled={source.enabled}
                    label={source.enabled ? t("common.enabled") : t("common.disabled")}
                    onClick={() =>
                      void onSaveSourceMetadata(source, {
                        category: source.categoryId,
                        enabled: !source.enabled,
                        name: source.name,
                        note: source.note,
                        sourceType: source.sourceType,
                        tags: tagInputValue(source.tags)
                      })
                    }
                  />
                  <button
                    className="icon-action"
                    onClick={() => setEditingSourceId(source.id)}
                    title={t("lib.editSource")}
                    type="button"
                  >
                    <Icon name="edit" />
                  </button>
                </div>
              </header>
              {source.note && <p className="source-note">{source.note}</p>}
              {isExpanded && (
                <div className="source-children">
                  {parentSkills.length > 0 && (
                    <div className="parent-skills">
                      {parentSkills.map(skill => (
                        <SkillRow
                          agentStatuses={agentStatusesBySkill.get(skill.folderName) ?? []}
                          isParent
                          key={skill.folderName}
                          loading={loading}
                          folders={skillFolders}
                          onCopy={() => void copySkillPrompt(skill, onRecordUsage)}
                          onEdit={() => setEditingSkillId(skill.folderName)}
                          onMoveFolder={folderId => void onMoveSkillToFolder(skill.id ?? stableSkillClientId(skill), folderId)}
                          onRate={rating => void onSetSkillRating(skill, rating)}
                          onToggleEnabled={() => void onSetSkillEnabled(skill, !skill.enabled)}
                          skill={skill}
                        />
                      ))}
                    </div>
                  )}
                  {childSkills.length === 0 && parentSkills.length === 0 ? (
                    source.sourceType === "prompt" ? (
                      <div className="source-children-empty prompt-source-callout">
                        <div>
                          <strong>{t("lib.promptOnly")}</strong>
                          <span>{t("lib.promptMethodBody")}</span>
                        </div>
                        <button
                          className="primary-action small"
                          disabled={promptInvocationPending === source.id}
                          onClick={() => void preparePromptInvocation(source)}
                          type="button"
                        >
                          <Icon name="copy" />
                          {promptInvocationPending === source.id
                            ? t("lib.promptPreparing")
                            : t("lib.promptPrepare")}
                        </button>
                      </div>
                    ) : (
                      <p className="source-children-empty">{t("lib.noChildren")}</p>
                    )
                  ) : (
                    <div className="child-skills">
                      {visibleChildSkills.map(skill => (
                        <SkillRow
                          agentStatuses={agentStatusesBySkill.get(skill.folderName) ?? []}
                          isParent={false}
                          key={skill.folderName}
                          loading={loading}
                          folders={skillFolders}
                          onCopy={() => void copySkillPrompt(skill, onRecordUsage)}
                          onEdit={() => setEditingSkillId(skill.folderName)}
                          onMoveFolder={folderId => void onMoveSkillToFolder(skill.id ?? stableSkillClientId(skill), folderId)}
                          onRate={rating => void onSetSkillRating(skill, rating)}
                          onToggleEnabled={() => void onSetSkillEnabled(skill, !skill.enabled)}
                          skill={skill}
                        />
                      ))}
                      {childSkills.length > visibleChildSkills.length && (
                        <button
                          className="source-children-more"
                          onClick={() => setChildLimits(previous => ({ ...previous, [source.id]: childLimit + 36 }))}
                          type="button"
                        >
                          {t("lib.showMoreChildren", { n: childSkills.length - visibleChildSkills.length })}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}
            </article>
          );
        })}

        {localSkills.length > 0 && (
          <article className="source-group glow-card local-group expanded">
            <header className="source-group-head">
              <div className="source-group-toggle static">
                <span className="source-avatar tone-local" aria-hidden="true">
                  <Icon name="workspaces" />
                </span>
                <div className="source-group-title">
                  <strong>{t("lib.localGroup")}</strong>
                  <span>{t("lib.localGroupHint")} · {t("lib.skillsTotal", { n: localSkills.length })}</span>
                </div>
              </div>
            </header>
            <div className="source-children">
              <div className="child-skills">
                {localSkills.map(skill => (
                  <SkillRow
                    agentStatuses={agentStatusesBySkill.get(skill.folderName) ?? []}
                    isParent={isRouterHubSkill(skill)}
                    key={skill.folderName}
                    loading={loading}
                    folders={skillFolders}
                    onCopy={() => void copySkillPrompt(skill, onRecordUsage)}
                    onEdit={() => setEditingSkillId(skill.folderName)}
                    onMoveFolder={folderId => void onMoveSkillToFolder(skill.id ?? stableSkillClientId(skill), folderId)}
                    onRate={rating => void onSetSkillRating(skill, rating)}
                    onToggleEnabled={() => void onSetSkillEnabled(skill, !skill.enabled)}
                    skill={skill}
                  />
                ))}
              </div>
            </div>
          </article>
        )}

        {visibleSources.length === 0 && localSkills.length === 0 && (
          <p className="library-empty">{searchQuery.trim() ? t("lib.emptySearch") : t("lib.empty")}</p>
        )}
        </section>

      </div>

      {editingSkill && (
        <SkillEditPanel
          disabled={loading}
          draft={skillDrafts[editingSkill.folderName]}
          folders={skillFolders}
          onClose={() => setEditingSkillId("")}
          onMoveFolder={folderId => editingSkill.sourceId
            ? onMoveSourceSkillsToFolder(editingSkill.sourceId, folderId)
            : onMoveSkillToFolder(editingSkill.id ?? stableSkillClientId(editingSkill), folderId)}
          onSave={draft => void saveSkillDraft(editingSkill, draft)}
          skill={editingSkill}
        />
      )}
      {promptInvocation && (
        <PromptInvocationPanel
          card={promptInvocation}
          onCreated={() => onRefreshIndex(true)}
          onClose={() => setPromptInvocation(null)}
          onRecordUsage={onRecordUsage}
        />
      )}
      {editingSource && (
        <SourceEditPanel
          disabled={loading}
          draft={sourceDrafts[editingSource.id]}
          onClose={() => setEditingSourceId("")}
          onDelete={() => void deleteSourceFromPanel(editingSource)}
          onOpenChildren={() => expandSource(editingSource.id)}
          onMoveFolder={folderId => onMoveSourceSkillsToFolder(editingSource.id, folderId)}
          onRefreshVersion={() => void onRefreshSourceVersion(editingSource)}
          onRollbackVersion={() => {
            const governance = governanceById.get(editingSource.id);
            const revision = shortRevision(governance?.latestBackupRevision);
            if (
              window.confirm(
                t("governance.confirmRollback", {
                  name: editingSource.name,
                  revision: revision || t("governance.unknownRevision")
                })
              )
            ) {
              void onRollbackSourceVersion(editingSource);
            }
          }}
          onSave={draft => saveSourceDraft(editingSource, draft)}
          onSetPinned={pinned => void onSetSourceVersionPin(editingSource, pinned)}
          governance={governanceById.get(editingSource.id)}
          popularity={popularityById.get(editingSource.id)}
          source={editingSource}
          sourceSkills={skillsBySourceId.get(editingSource.id) ?? []}
          folders={skillFolders}
        />
      )}
    </div>
  );
}

function PromptInvocationPanel({
  card,
  onCreated,
  onClose,
  onRecordUsage
}: {
  card: PromptInvocationCard;
  onCreated: () => Promise<unknown>;
  onClose: () => void;
  onRecordUsage: LibraryProps["onRecordUsage"];
}) {
  const [task, setTask] = useState("");
  const lang = getLang();
  const promptCopy = lang === "zh" ? { task: "本次任务", placeholder: "说明目标、材料与输出要求…", preview: "查看将复制的完整内容" }
    : lang === "ko" ? { task: "이번 작업", placeholder: "목표, 자료와 출력 요구사항…", preview: "복사할 내용 보기" }
      : { task: "Your task", placeholder: "Goal, inputs, and expected output…", preview: "Preview copied instructions" };
  const invocationText = task.trim() ? `${card.copyText}\n\n## ${promptCopy.task}\n${task.trim()}` : card.copyText;
  async function copyInvocation() {
    await copyTextToClipboard(invocationText, t("lib.promptCopied"));
    await onRecordUsage("prompt", card.sourceId, card.sourceName, card.sourceName, "copy_prompt");
  }

  async function openSourceFolder() {
    try {
      await invoke("open_prompt_source_folder", { sourceId: card.sourceId });
      showUiToast(t("lib.promptOpened"), "ok");
    } catch (error) {
      showUiToast(
        t("lib.promptOpenFailed", {
          message: error instanceof Error ? error.message : String(error)
        }),
        "error"
      );
    }
  }

  return (
    <Drawer eyebrow={t("lib.promptDrawerEyebrow")} onClose={onClose} title={card.sourceName} wide>
      <section className="prompt-invocation-identity">
        <Icon name="info" />
        <div>
          <strong>{t("lib.promptNotSkill")}</strong>
          <span>{t("lib.promptMethodBody")}</span>
        </div>
      </section>

      <section className={`prompt-workspace-status ${card.workspaceComplete ? "complete" : "incomplete"}`}>
        <Icon name={card.workspaceComplete ? "shield" : "alert"} />
        <div>
          <strong>
            {card.workspaceComplete
              ? t("lib.promptWorkspaceComplete")
              : t("lib.promptWorkspaceIncomplete")}
          </strong>
          {!card.workspaceComplete && <span>{t("lib.promptReadd")}</span>}
        </div>
      </section>

      <section className="prompt-invocation-section">
        <h3>{t("lib.promptHosts")}</h3>
        <div className="prompt-host-list">
          {card.hosts.map(host => (
            <article key={host.id}>
              <span className={`status-dot ${host.deliveryStatus === "copy-paste-ready" ? "ok" : "warn"}`} />
              <div>
                <strong>{host.name}</strong>
                <small>
                  {host.deliveryStatus === "copy-paste-ready"
                    ? t("lib.promptHostReady")
                    : t("lib.promptHostNotReady")}
                </small>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="prompt-invocation-section">
        <h3>{t("lib.promptAssets")}</h3>
        <div className="prompt-asset-list">
          {card.assets.map(asset => (
            <article key={asset.relativePath}>
              <div>
                <strong>{asset.name}</strong>
                <small>{formatFileSize(asset.bytes)}</small>
              </div>
              <span>{asset.included ? t("lib.promptIncluded") : t("lib.promptReference")}</span>
            </article>
          ))}
        </div>
      </section>

      {card.warnings.length > 0 && (
        <ul className="prompt-warning-list">
          {card.warnings.map(warning => <li key={warning}>{warning}</li>)}
        </ul>
      )}

      <section className="prompt-compose">
        <label htmlFor="prompt-task">{promptCopy.task}</label>
        <textarea id="prompt-task" value={task} onChange={event => setTask(event.target.value)} placeholder={promptCopy.placeholder} />
        <details><summary>{promptCopy.preview}</summary><pre>{invocationText}</pre></details>
      </section>
      <PromptLauncherAction sourceId={card.sourceId} onCreated={onCreated} />

      <footer>
        <button className="secondary-action" onClick={() => void openSourceFolder()} type="button">
          <Icon name="folder" /> {t("lib.promptOpenFolder")}
        </button>
        <span className="footer-spacer" />
        <button className="primary-action" onClick={() => void copyInvocation()} type="button">
          <Icon name="copy" /> {t("lib.promptCopy")}
        </button>
      </footer>
    </Drawer>
  );
}

const SKILL_FOLDER_COLOR_OPTIONS = ["cyan", "violet", "magenta", "amber", "emerald", "blue", "coral", "slate"];
const SKILL_FOLDER_COLOR_HEX: Record<string, string> = {
  cyan: "#16b8c4",
  violet: "#7c6ee6",
  magenta: "#cf4fa7",
  amber: "#c88720",
  emerald: "#20a874",
  blue: "#338bd4",
  coral: "#d85f4d",
  slate: "#6f7f96"
};

function SkillFolderShelf({
  disabled,
  folders,
  folderCounts,
  onCreate,
  onDelete,
  onDropSkill,
  onDropSource,
  onMove,
  onSelect,
  onUpdate,
  selectedId,
  skills
}: {
  disabled: boolean;
  folders: SkillFolderCard[];
  folderCounts: Map<string, number>;
  onCreate: (name: string, note: string, color: string) => Promise<LegacySnapshot | null>;
  onDelete: (folderId: string) => Promise<LegacySnapshot | null>;
  onDropSkill: (skillId: string, folderId: string) => Promise<LegacySnapshot | null>;
  onDropSource: (sourceId: string, folderId: string) => Promise<LegacySnapshot | null>;
  onMove: (folderId: string, direction: "up" | "down") => Promise<LegacySnapshot | null>;
  onSelect: (folderId: string) => void;
  onUpdate: (folderId: string, name: string, note: string, color: string) => Promise<LegacySnapshot | null>;
  selectedId: string;
  skills: SkillCard[];
}) {
  const [editingId, setEditingId] = useState("");
  const [showEditor, setShowEditor] = useState(false);
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [color, setColor] = useState("cyan");
  const [dropTarget, setDropTarget] = useState("");
  const unfiledCount = folderCounts.get("unfiled") ?? 0;
  const editingIndex = folders.findIndex(folder => folder.id === editingId);

  function openCreate() {
    setEditingId("");
    setName("");
    setNote("");
    setColor("cyan");
    setShowEditor(true);
  }

  function openEdit(folder: SkillFolderCard) {
    setEditingId(folder.id);
    setName(folder.name);
    setNote(folder.note);
    setColor(folder.color);
    setShowEditor(true);
  }

  async function submitFolder() {
    if (!name.trim()) return;
    const result = editingId
      ? await onUpdate(editingId, name, note, color)
      : await onCreate(name, note, color);
    if (result) setShowEditor(false);
  }

  function acceptDrop(event: DragEvent<HTMLElement>, folderId: string) {
    if (disabled || !hasInternalSkillDrag(event.dataTransfer)) return;
    event.preventDefault();
    setDropTarget("");
    const sourceId = event.dataTransfer.getData("application/x-ai-skillhub-source-id");
    if (sourceId.trim()) {
      void onDropSource(sourceId.trim(), folderId);
      return;
    }
    const skillId = event.dataTransfer.getData("application/x-ai-skillhub-skill-id");
    if (skillId.trim()) void onDropSkill(skillId.trim(), folderId);
  }

  const renderTarget = (id: string, label: string, count: number, tone: string, noteText = "") => {
    const acceptsDrop = !disabled && id !== "all";
    return (
      <button
        aria-pressed={selectedId === id}
        className={`skill-folder-target tone-${tone}${selectedId === id ? " active" : ""}${dropTarget === id ? " drop-ready" : ""}`}
        key={id}
        onClick={() => onSelect(id)}
        onDragEnter={acceptsDrop ? event => {
          if (!hasInternalSkillDrag(event.dataTransfer)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          setDropTarget(id);
        } : undefined}
        onDragOver={acceptsDrop ? event => {
          if (!hasInternalSkillDrag(event.dataTransfer)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
        } : undefined}
        onDragLeave={acceptsDrop ? () => setDropTarget(current => current === id ? "" : current) : undefined}
        onDrop={acceptsDrop ? event => acceptDrop(event, id === "unfiled" ? "" : id) : undefined}
        title={noteText || label}
        type="button"
      >
        <Icon name="folder" />
        <span><strong>{label}</strong>{noteText && <small>{noteText}</small>}</span>
        <b>{count}</b>
      </button>
    );
  };

  return (
    <section className="skill-folder-shelf glow-card" aria-label={t("folders.aria")}>
      <header>
        <div>
          <span className="eyebrow"><Icon name="folder" /> {t("folders.eyebrow")}</span>
          <p>{t("folders.subtitle")}</p>
        </div>
        <button className="ghost-action" disabled={disabled} onClick={openCreate} type="button">
          <Icon name="add" /> {t("folders.new")}
        </button>
      </header>
      <div className="skill-folder-strip">
        {renderTarget("all", t("folders.all"), skills.filter(skill => !isRouterHubSkill(skill)).length, "slate")}
        {folders.map(folder => (
          <div className="skill-folder-item" key={folder.id}>
            {renderTarget(folder.id, folder.name, folderCounts.get(folder.id) ?? 0, folder.color, folder.note)}
            <button
              aria-label={t("folders.manage", { name: folder.name })}
              className="skill-folder-manage"
              disabled={disabled}
              onClick={() => openEdit(folder)}
              title={t("folders.manage", { name: folder.name })}
              type="button"
            ><Icon name="edit" /></button>
          </div>
        ))}
        {renderTarget("unfiled", t("folders.unfiled"), unfiledCount, "slate")}
      </div>
      {showEditor && (
        <div className="skill-folder-editor">
          <label><span>{t("folders.name")}</span><input maxLength={48} onChange={event => setName(event.target.value)} value={name} /></label>
          <label className="grow"><span>{t("folders.note")}</span><input maxLength={500} onChange={event => setNote(event.target.value)} value={note} /></label>
          <fieldset>
            <legend>{t("folders.color")}</legend>
            {SKILL_FOLDER_COLOR_OPTIONS.map(value => (
              <button
                aria-label={t(`folders.color.${value}`)}
                aria-pressed={color === value}
                className={`folder-color-dot tone-${value}`}
                key={value}
                onClick={() => setColor(value)}
                style={{ "--folder-tone": SKILL_FOLDER_COLOR_HEX[value] } as CSSProperties}
                type="button"
              />
            ))}
          </fieldset>
          <div className="skill-folder-editor-actions">
            {editingId && (
              <>
                <button
                  className="ghost-action"
                  disabled={disabled || editingIndex <= 0}
                  onClick={() => void onMove(editingId, "up")}
                  type="button"
                >↑ {t("folders.moveUp")}</button>
                <button
                  className="ghost-action"
                  disabled={disabled || editingIndex < 0 || editingIndex >= folders.length - 1}
                  onClick={() => void onMove(editingId, "down")}
                  type="button"
                >↓ {t("folders.moveDown")}</button>
                <button
                  className="danger-action"
                  disabled={disabled}
                  onClick={() => {
                    if (window.confirm(t("folders.confirmDelete", { name }))) {
                      void onDelete(editingId).then(result => { if (result) setShowEditor(false); });
                    }
                  }}
                  type="button"
                >
                  <Icon name="trash" /> {t("folders.delete")}
                </button>
              </>
            )}
            <button className="ghost-action" onClick={() => setShowEditor(false)} type="button">{t("common.cancel")}</button>
            <button className="primary-action" disabled={disabled || !name.trim()} onClick={() => void submitFolder()} type="button">{t("common.save")}</button>
          </div>
        </div>
      )}
    </section>
  );
}

function SkillRow({
  agentStatuses,
  folders,
  isParent,
  loading,
  onCopy,
  onEdit,
  onMoveFolder,
  onRate,
  onToggleEnabled,
  skill
}: {
  agentStatuses: AgentSkillStatusCard[];
  folders: SkillFolderCard[];
  isParent: boolean;
  loading: boolean;
  onCopy: () => void;
  onEdit: () => void;
  onMoveFolder: (folderId: string) => void;
  onRate: (rating: number) => void;
  onToggleEnabled: () => void;
  skill: SkillCard;
}) {
  return (
    <article
      className={`skill-row glow-card ${skill.health}${isParent ? " is-parent" : ""}`}
      draggable={Boolean(!loading && skill.id && !skill.sourceId)}
      onDragStart={event => {
        if (loading || skill.sourceId) {
          event.preventDefault();
          return;
        }
        const id = skill.id ?? stableSkillClientId(skill);
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("application/x-ai-skillhub-skill-id", id);
        event.dataTransfer.setData("text/plain", id);
      }}
    >
      <div className={`skill-row-icon tone-${skillTone(skill.category)}`}>
        <Icon name={skillIcon(skill.category)} />
      </div>
      <div className="skill-row-main">
        <header>
          <strong>{skill.name}</strong>
          {!isParent && (
            <button
              aria-label={t("lib.copyName", { name: skillInvocationName(skill) })}
              className="skill-name-copy"
              onClick={() => void copyTextToClipboard(skillInvocationName(skill), t("toast.skillNameCopied"))}
              title={t("lib.copyName", { name: skillInvocationName(skill) })}
              type="button"
            >
              <Icon name="copy" />
            </button>
          )}
          <span
            className={`kind-chip ${isParent ? "router" : "child"}`}
            title={isParent ? t("lib.parentTip") : t("lib.childTip")}
          >
            {isParent ? t("lib.parentSkill") : t("lib.childSkill")}
          </span>
          <span className={`status-badge ${skill.health}`}>
            <span className={`status-dot ${statusDotClass(skill.health)}`} />
            {skillStatusLabel(skill.health)}
          </span>
        </header>
        <p>{localizedSkillDescription(skill, getLang())}</p>
        <div className="skill-row-tags">
          <span>{displayCategoryName(skill.category) || t("conf.uncategorized")}</span>
          {(skill.tags ?? []).slice(0, 4).map(tag => (
            <span className="tag-chip" key={tag}>{tag}</span>
          ))}
          {agentStatuses.slice(0, 3).map(status => (
            <span
              className={`agent-skill-pill ${agentSkillStatusTone(status.status)}`}
              key={status.id}
              title={status.summary}
            >
              {compactAgentName(status.agentName)}
              <b>{agentSkillStatusLabel(status.status)}</b>
            </span>
          ))}
        </div>
        {skill.note && <small className="skill-row-note">{t("lib.note")}：{skill.note}</small>}
      </div>
      <div className="skill-row-actions">
        {skill.sourceId ? (
          <span className="inherited-folder-chip" title={t("folders.inheritedTip")}>
            <Icon name="folder" /> {skill.userFolderName || t("folders.unfiled")}
          </span>
        ) : (
          <label className="skill-folder-select" title={t("folders.choose")}>
            <Icon name="folder" />
            <select
              aria-label={t("folders.choose")}
              disabled={loading}
              onChange={event => onMoveFolder(event.target.value)}
              value={skill.userFolderId ?? ""}
            >
              <option value="">{t("folders.unfiled")}</option>
              {folders.map(folder => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
            </select>
          </label>
        )}
        <SkillRating disabled={loading} onChange={onRate} rating={skill.rating ?? 0} skillName={skill.name} />
        <ToggleSwitch
          disabled={loading}
          enabled={skill.enabled}
          label={skill.enabled ? t("common.enabled") : t("common.disabled")}
          onClick={onToggleEnabled}
        />
        <button className="icon-action" onClick={onCopy} title={t("lib.copy")} type="button">
          <Icon name="copy" />
        </button>
        <button className="icon-action" onClick={onEdit} title={t("lib.edit")} type="button">
          <Icon name="edit" />
        </button>
      </div>
    </article>
  );
}

function SkillRating({
  disabled,
  onChange,
  rating,
  skillName
}: {
  disabled: boolean;
  onChange: (rating: number) => void;
  rating: number;
  skillName: string;
}) {
  const normalizedRating = Math.max(0, Math.min(5, Math.round(rating)));
  return (
    <div
      aria-label={t("rating.group", { name: skillName })}
      className="skill-rating"
      role="group"
      title={normalizedRating > 0 ? t("rating.current", { n: normalizedRating }) : t("rating.unrated")}
    >
      {[1, 2, 3, 4, 5].map(value => (
        <button
          aria-label={t("rating.set", { n: value, name: skillName })}
          aria-pressed={value <= normalizedRating}
          className={value <= normalizedRating ? "filled" : ""}
          disabled={disabled}
          key={value}
          onClick={() => onChange(value === normalizedRating ? 0 : value)}
          title={value === normalizedRating ? t("rating.clear") : t("rating.setShort", { n: value })}
          type="button"
        >
          <span aria-hidden="true">★</span>
        </button>
      ))}
    </div>
  );
}

function SkillEditPanel({
  disabled,
  draft,
  folders,
  onClose,
  onMoveFolder,
  onSave,
  skill
}: {
  disabled: boolean;
  draft?: SkillDraft;
  folders: SkillFolderCard[];
  onClose: () => void;
  onMoveFolder: (folderId: string) => Promise<LegacySnapshot | null>;
  onSave: (draft: SkillDraft) => void;
  skill: SkillCard;
}) {
  const [name, setName] = useState(draft?.name ?? skill.name);
  const [category, setCategory] = useState(draft?.category ?? skill.category);
  const [description, setDescription] = useState(draft?.description ?? skill.description);
  const [note, setNote] = useState(draft?.note ?? skill.note ?? "");
  const [tags, setTags] = useState(draft?.tags ?? tagInputValue(skill.tags ?? []));

  useEffect(() => {
    setName(draft?.name ?? skill.name);
    setCategory(draft?.category ?? skill.category);
    setDescription(draft?.description ?? skill.description);
    setNote(draft?.note ?? skill.note ?? "");
    setTags(draft?.tags ?? tagInputValue(skill.tags ?? []));
  }, [draft, skill.folderName]);

  return (
    <Drawer onClose={onClose} eyebrow={t("skillEditor.eyebrow")} title={skill.name}>
      <label>
        {skill.sourceId ? t("folders.sourceTreeFolder") : t("folders.choose")}
        <select
          disabled={disabled}
          onChange={event => void onMoveFolder(event.target.value)}
          value={skill.userFolderId ?? ""}
        >
          <option value="">{t("folders.unfiled")}</option>
          {folders.map(folder => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
        </select>
        {skill.sourceId && <small className="drawer-field-hint">{t("folders.inheritedTip")}</small>}
      </label>
      <label>
        {t("skillEditor.name")}
        <input disabled={disabled} onChange={event => setName(event.target.value)} value={name} />
      </label>
      <label>
        {t("skillEditor.category")}
        <input disabled={disabled} onChange={event => setCategory(event.target.value)} value={category} />
      </label>
      <label>
        {t("skillEditor.tags")}
        <input
          disabled={disabled}
          onChange={event => setTags(event.target.value)}
          placeholder={t("skillEditor.tagsPlaceholder")}
          value={tags}
        />
      </label>
      <label>
        {t("skillEditor.description")}
        <textarea disabled={disabled} onChange={event => setDescription(event.target.value)} rows={4} value={description} />
      </label>
      <label>
        {t("skillEditor.note")}
        <textarea
          disabled={disabled}
          onChange={event => setNote(event.target.value)}
          placeholder={t("skillEditor.notePlaceholder")}
          rows={3}
          value={note}
        />
      </label>
      <footer>
        <button className="secondary-action" onClick={onClose} type="button">{t("common.cancel")}</button>
        <button
          className="primary-action"
          disabled={disabled}
          onClick={() => onSave({ category, description, name, note, tags })}
          type="button"
        >
          {t("common.save")}
        </button>
      </footer>
    </Drawer>
  );
}

function SourceEditPanel({
  disabled,
  draft,
  folders,
  governance,
  onClose,
  onDelete,
  onOpenChildren,
  onMoveFolder,
  onRefreshVersion,
  onRollbackVersion,
  onSave,
  onSetPinned,
  popularity,
  source,
  sourceSkills
}: {
  disabled: boolean;
  draft?: SourceDraft;
  folders: SkillFolderCard[];
  governance?: SourceGovernanceCard;
  onClose: () => void;
  onDelete: () => void;
  onOpenChildren: () => void;
  onMoveFolder: (folderId: string) => Promise<LegacySnapshot | null>;
  onRefreshVersion: () => void;
  onRollbackVersion: () => void;
  onSave: (draft: SourceDraft) => Promise<void>;
  onSetPinned: (pinned: boolean) => void;
  popularity?: SourcePopularityCard;
  source: SourceCard;
  sourceSkills: SkillCard[];
}) {
  const [name, setName] = useState(draft?.name ?? source.name);
  const [category, setCategory] = useState(draft?.category ?? source.categoryId);
  const [sourceType, setSourceType] = useState<SourceCard["sourceType"]>(draft?.sourceType ?? source.sourceType);
  const [note, setNote] = useState(draft?.note ?? source.note ?? "");
  const [enabled, setEnabled] = useState(draft?.enabled ?? source.enabled);
  const [tags, setTags] = useState(draft?.tags ?? tagInputValue(source.tags ?? []));
  const [saving, setSaving] = useState(false);
  const formDisabled = disabled || saving;
  const totalSkillCount = Math.max(source.skillCount ?? 0, sourceSkills.length);
  const singleRootSkill = sourceSkills.length === 1;
  const routerSkills = singleRootSkill ? [] : sourceSkills.filter(isRouterHubSkill);
  const childSkills = singleRootSkill ? sourceSkills : sourceSkills.filter(skill => !isRouterHubSkill(skill));
  const mapSkills = childSkills.length > 0 ? childSkills : sourceSkills;
  const projectAddress = source.url || source.localPath || t("srcEditor.noAddress");

  useEffect(() => {
    setName(draft?.name ?? source.name);
    setCategory(draft?.category ?? source.categoryId);
    setSourceType(draft?.sourceType ?? source.sourceType);
    setNote(draft?.note ?? source.note ?? "");
    setEnabled(draft?.enabled ?? source.enabled);
    setTags(draft?.tags ?? tagInputValue(source.tags ?? []));
    setSaving(false);
  }, [draft, source.id]);

  async function submit() {
    if (formDisabled) return;
    setSaving(true);
    try {
      await onSave({ category, enabled, name, note, sourceType, tags });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Drawer onClose={onClose} eyebrow={t("srcEditor.eyebrow")} title={source.name} wide>
      <label className="source-folder-drawer-field">
        {t("folders.sourceTreeFolder")}
        <select disabled={formDisabled} onChange={event => void onMoveFolder(event.target.value)} value={source.userFolderId ?? ""}>
          <option value="">{t("folders.unfiled")}</option>
          {folders.map(folder => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
        </select>
        <small className="drawer-field-hint">{t("folders.sourceTreeHint")}</small>
      </label>
      <div className="source-detail-address">
        <span>{t("srcEditor.address")}</span>
        <code title={projectAddress}>{projectAddress}</code>
      </div>
      <div className="source-detail-metrics">
        <span>
          <b>{totalSkillCount}</b>
          <small>{t("srcEditor.skills")}</small>
        </span>
        <span>
          <b>{popularity?.stars ? formatCompactNumber(popularity.stars) : t("srcEditor.notRefreshed")}</b>
          <small>{t("srcEditor.stars")}</small>
        </span>
        <span>
          <b>{popularity?.localTotalCount ?? 0}</b>
          <small>{t("srcEditor.calls")}</small>
        </span>
      </div>
      <section className="source-governance-panel" aria-label={t("governance.title")}>
        <header>
          <div>
            <span>{t("governance.eyebrow")}</span>
            <strong>
              {governance?.supportStatus === "git"
                ? governance.pinned
                  ? t("governance.pinned")
                  : t("governance.autoUpdate")
                : t("governance.localOnly")}
            </strong>
          </div>
          {governance?.diffSource === "cached" && <em>{t("governance.cached")}</em>}
        </header>
        {governance?.supportStatus === "git" ? (
          <>
            <dl className="source-governance-revisions">
              <div>
                <dt>{t("governance.current")}</dt>
                <dd>{shortRevision(governance.currentRevision) || "—"}</dd>
              </div>
              <div>
                <dt>{t("governance.upstream")}</dt>
                <dd>{shortRevision(governance.remoteRevision) || "—"}</dd>
              </div>
              <div>
                <dt>{t("governance.diff")}</dt>
                <dd>
                  {t("governance.diffValue", {
                    files: governance.changedFiles,
                    additions: governance.additions,
                    deletions: governance.deletions
                  })}
                </dd>
              </div>
              <div>
                <dt>{t("governance.backups")}</dt>
                <dd>{governance.backupCount}</dd>
              </div>
            </dl>
            {governance.trackingBranch && (
              <p className="source-governance-branch">
                {t("governance.tracking", { branch: governance.trackingBranch })}
              </p>
            )}
            {governance.remoteDefaultBranch
              && governance.trackingBranch
              && !governance.trackingBranch.endsWith(`/${governance.remoteDefaultBranch}`)
              && governance.trackingBranch !== governance.remoteDefaultBranch && (
              <p className="source-governance-branch-warning" role="note">
                {t("governance.defaultBranchChanged", {
                  remote: governance.remoteDefaultBranch,
                  branch: governance.trackingBranch
                })}
              </p>
            )}
            {governance.remoteSummary && <p>{governance.remoteSummary}</p>}
            <div className="source-governance-actions">
              <button className="ghost-action small" disabled={formDisabled} onClick={onRefreshVersion} type="button">
                <Icon name="refresh" /> {t("governance.refresh")}
              </button>
              <button
                className={governance.pinned ? "ghost-action small active" : "ghost-action small"}
                disabled={formDisabled}
                onClick={() => onSetPinned(!governance.pinned)}
                type="button"
              >
                <Icon name="shield" />
                {governance.pinned ? t("governance.unpin") : t("governance.pin")}
              </button>
              <button
                className="ghost-action small"
                disabled={formDisabled || !governance.canRollback}
                onClick={onRollbackVersion}
                title={
                  governance.canRollback
                    ? t("governance.rollbackTip", {
                        revision: shortRevision(governance.latestBackupRevision)
                      })
                    : t("governance.noRollback")
                }
                type="button"
              >
                <Icon name="snapshots" /> {t("governance.rollback")}
              </button>
            </div>
          </>
        ) : (
          <p>{t("governance.localExplanation")}</p>
        )}
      </section>
      <div className="source-detail-skill-map">
        <div className="source-detail-section-title">
          <strong>{t("srcEditor.map")}</strong>
          <span>{t("srcEditor.mapCount", { total: totalSkillCount, routers: routerSkills.length, children: childSkills.length })}</span>
          <button className="ghost-action small" onClick={onOpenChildren} type="button">
            <Icon name="chevron" />
          </button>
        </div>
        {mapSkills.length === 0 && (
          <p className="source-detail-muted">
            {source.sourceType === "prompt" ? t("lib.promptOnly") : t("srcEditor.noChildren")}
          </p>
        )}
        {mapSkills.slice(0, 10).map(skill => (
          <article className="source-detail-child" key={skill.folderName}>
            <strong>{skill.name}</strong>
            <span>{localizedSkillDescription(skill, getLang()) || displayCategoryName(skill.category)}</span>
          </article>
        ))}
      </div>
      <label>
        {t("srcEditor.name")}
        <input disabled={formDisabled} onChange={event => setName(event.target.value)} value={name} />
      </label>
      <label>
        {t("srcEditor.type")}
        <select disabled={formDisabled} onChange={event => setSourceType(event.target.value as SourceCard["sourceType"])} value={sourceType}>
          <option value="skill">{t("type.skill")}</option>
          <option value="prompt">{t("type.prompt")}</option>
          <option value="mixed">{t("type.mixed")}</option>
        </select>
      </label>
      <label>
        {t("srcEditor.category")}
        <input disabled={formDisabled} onChange={event => setCategory(event.target.value)} value={category} />
      </label>
      <label>
        {t("srcEditor.tags")}
        <input
          disabled={formDisabled}
          onChange={event => setTags(event.target.value)}
          placeholder={t("srcEditor.tagsPlaceholder")}
          value={tags}
        />
      </label>
      <label>
        {t("srcEditor.note")}
        <textarea
          disabled={formDisabled}
          onChange={event => setNote(event.target.value)}
          placeholder={t("srcEditor.notePlaceholder")}
          rows={3}
          value={note}
        />
      </label>
      <div className="source-editor-toggle">
        <div>
          <strong>{t("srcEditor.enable")}</strong>
          <span>{t("srcEditor.enableHint")}</span>
        </div>
        <ToggleSwitch
          disabled={formDisabled}
          enabled={enabled}
          label={enabled ? t("common.enabled") : t("common.disabled")}
          onClick={() => setEnabled(value => !value)}
        />
      </div>
      <footer>
        <button className="danger-action" disabled={formDisabled} onClick={onDelete} type="button">
          <Icon name="trash" /> {t("srcEditor.delete")}
        </button>
        <span className="footer-spacer" />
        <button className="secondary-action" onClick={onClose} type="button">{t("common.cancel")}</button>
        <button
          className="primary-action"
          disabled={formDisabled}
          onClick={() => void submit()}
          type="button"
        >
          {saving ? `${t("common.save")}…` : t("common.save")}
        </button>
      </footer>
    </Drawer>
  );
}

/* =============================================================
   Router hub + conflict selector (used inside Library maintenance)
   ============================================================= */

function RouterHubPanel({
  disabled,
  realWritesEnabled
}: {
  disabled: boolean;
  realWritesEnabled: boolean;
}) {
  const [report, setReport] = useState<RouterHubReport | null>(null);
  const [pending, setPending] = useState<"" | "plan" | "commit">("");
  const [error, setError] = useState("");
  const runtimeAvailable = hasTauriRuntime();

  async function run(commit: boolean) {
    if (!runtimeAvailable) {
      setError(t("router.browserBlocked"));
      return;
    }
    setPending(commit ? "commit" : "plan");
    setError("");
    try {
      const next = await invoke<RouterHubReport>("regenerate_router_hubs", { commit });
      setReport(next);
      showUiToast(
        commit
          ? routerHubCommitMessage(next)
          : t("router.toastDryRun", {
              collections: next.totalCollections,
              duplicates: next.duplicateChildren.length
            }),
        "ok"
      );
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError(message);
      showUiToast(t("router.toastFailed", { message }), "error");
    } finally {
      setPending("");
    }
  }

  return (
    <section className="router-hub-panel glow-card">
      <header className="panel-head">
        <div>
          <span className="eyebrow">{t("router.eyebrow")}</span>
          <h3>{t("router.title")}</h3>
          <p>{t("router.subtitle")}</p>
        </div>
        <div className="panel-head-actions">
          <button
            className="ghost-action"
            disabled={disabled || pending !== ""}
            onClick={() => void run(false)}
            type="button"
          >
            {pending === "plan" ? t("router.previewing") : t("router.preview")}
          </button>
          <button
            className="primary-action"
            disabled={disabled || pending !== "" || !realWritesEnabled || !runtimeAvailable}
            onClick={() => void run(true)}
            title={
              !realWritesEnabled ? t("router.needAuth") : !runtimeAvailable ? t("router.previewOnly") : t("router.runNow")
            }
            type="button"
          >
            {pending === "commit" ? t("router.rebuilding") : t("router.rebuild")}
          </button>
        </div>
      </header>

      {!report && !error && <p className="router-hub-hint">{t("router.hint")}</p>}
      {error && <div className="router-hub-error">{error}</div>}

      {report && (
        <>
          <div className="router-hub-stats">
            <span className="router-hub-stat">
              <strong>{report.totalCollections}</strong>
              <em>{t("router.collections")}</em>
            </span>
            <span className="router-hub-stat ok">
              <strong>{report.writtenCount}</strong>
              <em>{report.committed ? t("router.written") : t("router.pendingWrite")}</em>
            </span>
            <span className="router-hub-stat">
              <strong>{routerHubUnchangedCount(report)}</strong>
              <em>{t("router.upToDate")}</em>
            </span>
            <span className="router-hub-stat">
              <strong>{report.skippedCount}</strong>
              <em>{t("router.skipped")}</em>
            </span>
            <span className="router-hub-stat warn">
              <strong>{report.duplicateChildren.length}</strong>
              <em>{t("router.duplicates")}</em>
            </span>
            <span className="router-hub-stat warn">
              <strong>{report.healthWarnings.length}</strong>
              <em>{t("router.formatWarnings")}</em>
            </span>
          </div>
          <button className="ghost-action small" onClick={() => setReport(null)} type="button">
            {t("router.collapse")}
          </button>
        </>
      )}
    </section>
  );
}

function ParentIsolationPanel({ conflicts }: { conflicts: SkillConflictCard[] }) {
  const sourceCount = new Set(
    conflicts.flatMap(conflict => conflict.choices.map(choice => choice.sourceName))
  ).size;
  return (
    <section className="parent-isolation-panel glow-card">
      <span className="parent-isolation-icon" aria-hidden="true"><Icon name="shield" /></span>
      <div>
        <h3>{t("conf.parentIsolationTitle")}</h3>
        <p>{t("conf.parentIsolationBody", { conflicts: conflicts.length, sources: sourceCount })}</p>
      </div>
      <span className="parent-isolation-status">
        <Icon name="shield" /> {t("conf.parentIsolationActive")}
      </span>
    </section>
  );
}

function tagInputValue(tags?: string[]): string {
  return (tags ?? []).join(", ");
}

function sortSources(
  sources: SourceCard[],
  sortKey: SourceSortKey,
  popularityById: Map<string, SourcePopularityCard>,
  skills: SkillCard[]
): SourceCard[] {
  return [...sources].sort((left, right) => {
    const leftPop = popularityById.get(left.id);
    const rightPop = popularityById.get(right.id);
    const nameCompare = left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" });
    switch (sortKey) {
      case "rating": {
        const leftSkills = skills.filter(skill => skillBelongsToSource(skill, left));
        const rightSkills = skills.filter(skill => skillBelongsToSource(skill, right));
        const leftParent = sourceParentSkill(left, leftSkills);
        const rightParent = sourceParentSkill(right, rightSkills);
        const leftRating = skillRatingSummary(leftSkills.filter(skill => skill !== leftParent));
        const rightRating = skillRatingSummary(rightSkills.filter(skill => skill !== rightParent));
        return (
          normalizedSourceRating(right, rightParent) - normalizedSourceRating(left, leftParent) ||
          rightRating.max - leftRating.max ||
          rightRating.average - leftRating.average ||
          rightRating.count - leftRating.count ||
          nameCompare
        );
      }
      case "usage":
        return (rightPop?.localTotalCount ?? 0) - (leftPop?.localTotalCount ?? 0) || nameCompare;
      case "heat":
        return (rightPop?.stars ?? 0) - (leftPop?.stars ?? 0) || nameCompare;
      case "skillCount":
        return right.skillCount - left.skillCount || nameCompare;
      case "health":
        return healthRank(left) - healthRank(right) || nameCompare;
      case "name":
        return nameCompare;
      default:
        return dateValue(right.createdAt) - dateValue(left.createdAt) || nameCompare;
    }
  });
}

type SkillRatingSummary = { average: number; count: number; max: number };

function normalizedSkillRating(skill: SkillCard) {
  return Math.max(0, Math.min(5, Math.round(skill.rating ?? 0)));
}

function normalizedOptionalSkillRating(skill?: SkillCard) {
  return skill ? normalizedSkillRating(skill) : 0;
}

function normalizedSourceRating(source: SourceCard, parentSkill?: SkillCard) {
  const rating = Math.max(0, Math.min(5, Math.round(source.rating ?? 0)));
  return rating || normalizedOptionalSkillRating(parentSkill);
}

function sourceParentSkill(source: SourceCard, skills: SkillCard[]): SkillCard | undefined {
  const sourceKey = normalizeLookup(source.name);
  return (
    skills.find(
      skill =>
        isRouterHubSkill(skill) &&
        [skill.folderName, skill.name].some(candidate => normalizeLookup(candidate) === sourceKey)
    ) ??
    skills.find(isRouterHubSkill) ??
    (skills.length === 1 ? skills[0] : undefined)
  );
}

function skillRatingSummary(skills: SkillCard[]): SkillRatingSummary {
  const ratings = skills.map(normalizedSkillRating).filter(rating => rating > 0);
  if (ratings.length === 0) return { average: 0, count: 0, max: 0 };
  return {
    average: ratings.reduce((total, rating) => total + rating, 0) / ratings.length,
    count: ratings.length,
    max: Math.max(...ratings)
  };
}

function sortSkills(skills: SkillCard[], sortKey: SourceSortKey): SkillCard[] {
  if (sortKey !== "rating") return skills;
  return [...skills].sort((left, right) => {
    const ratingCompare = normalizedSkillRating(right) - normalizedSkillRating(left);
    return (
      ratingCompare ||
      left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" })
    );
  });
}

function healthRank(source: SourceCard) {
  const ranks: Record<string, number> = { error: 0, warn: 1, info: 2, ok: 3 };
  return ranks[source.health] ?? 4;
}

function dateValue(value?: string) {
  if (!value) return 0;
  if (/^\d+$/.test(value)) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? (value.length > 16 ? Math.floor(numeric / 1_000_000) : numeric) : 0;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function applySkillDraft(skill: SkillCard, draft?: SkillDraft): SkillCard {
  if (!draft) return skill;
  return {
    ...skill,
    category: draft.category.trim() || skill.category,
    description: draft.description.trim() || skill.description,
    name: draft.name.trim() || skill.name,
    note: draft.note.trim() || skill.note,
    tags: parseTagInput(draft.tags)
  };
}

function applySourceDraft(source: SourceCard, draft?: SourceDraft): SourceCard {
  if (!draft) return source;
  return {
    ...source,
    categoryId: draft.category.trim() || source.categoryId,
    enabled: draft.enabled,
    name: draft.name.trim() || source.name,
    note: draft.note.trim() || source.note,
    sourceType: draft.sourceType,
    tags: parseTagInput(draft.tags)
  };
}

function resolveSkillSource(skill: SkillCard, sources: SourceCard[]): SourceCard | undefined {
  if (skill.sourceId) return sources.find(source => source.id === skill.sourceId);
  const matches = sources.filter(source => skillBelongsToSource(skill, source));
  return matches.length === 1 ? matches[0] : undefined;
}

function skillMatchesUserFolder(skill: SkillCard, selectedFolderId: string, source?: SourceCard, folders?: SkillFolderCard[]) {
  if (selectedFolderId === "all") return true;
  const assigned = skill.userFolderId || source?.userFolderId || "";
  const folderId = folders && !folders.some(folder => folder.id === assigned) ? "" : assigned;
  if (selectedFolderId === "unfiled") return !folderId;
  return folderId === selectedFolderId;
}

function sourceMatchesUserFolder(source: SourceCard, selectedFolderId: string, folders?: SkillFolderCard[]) {
  if (selectedFolderId === "all") return true;
  const folderId = folders && !folders.some(folder => folder.id === source.userFolderId) ? "" : source.userFolderId;
  if (selectedFolderId === "unfiled") return !folderId;
  return folderId === selectedFolderId;
}

function categoryToneId(category: string): string {
  const value = (category || "").toLowerCase();
  if (value.includes("security") || value.includes("vibesec")) return "security";
  if (value.includes("design") || value.includes("ui") || value.includes("image")) return "design";
  if (value.includes("figure") || value.includes("chart") || value.includes("data")) return "figure";
  if (value.includes("presentation") || value.includes("ppt") || value.includes("slide")) return "presentation";
  if (value.includes("knowledge") || value.includes("retrieval") || value.includes("zotero") || value.includes("search")) return "knowledge";
  if (value.includes("research") || value.includes("paper") || value.includes("academic") || value.includes("literature") || value.includes("writing")) return "academic";
  if (value.includes("agent") || value.includes("automation") || value.includes("workflow") || value.includes("development") || value.includes("dev") || value.includes("browser")) return "agent";
  if (value.includes("prompt")) return "prompt";
  return "surface";
}

function skillTone(category: string): string {
  return categoryToneId(category);
}

function skillIcon(category: string): IconName {
  const value = (category || "").toLowerCase();
  if (value.includes("design") || value.includes("ui")) return "sparkle";
  if (value.includes("research") || value.includes("writing") || value.includes("paper")) return "library";
  if (value.includes("figure") || value.includes("data")) return "dashboard";
  if (value.includes("security")) return "shield";
  if (value.includes("presentation") || value.includes("ppt") || value.includes("slide")) return "snapshots";
  if (value.includes("knowledge") || value.includes("retrieval") || value.includes("zotero") || value.includes("search")) return "search";
  if (value.includes("prompt")) return "list";
  if (value.includes("development") || value.includes("dev")) return "workspaces";
  if (value.includes("agent")) return "agent";
  return "sparkle";
}

function sourceTypeTone(sourceType: SourceCard["sourceType"], _category: string): string {
  if (sourceType === "prompt") return "prompt";
  if (sourceType === "mixed") return "other";
  return "skill";
}

function sourceTypeIcon(sourceType: SourceCard["sourceType"]): IconName {
  if (sourceType === "prompt") return "list";
  if (sourceType === "mixed") return "sources";
  return "library";
}

function statusDotClass(health: string) {
  if (health === "ok") return "healthy";
  if (health === "error") return "error";
  return "syncing";
}

function skillStatusLabel(health: string) {
  if (health === "ok") return t("health.ok");
  if (health === "warn") return t("health.warn");
  if (health === "error") return t("health.error");
  if (health === "info") return t("health.info");
  return health;
}

function agentSkillStatusTone(status: string) {
  if (["installed", "routed-via-parent"].includes(status)) return "ok";
  if (["missing", "agent-disabled", "skill-disabled", "invalid-manifest"].includes(status)) return "warn";
  return "info";
}

function agentSkillStatusLabel(status: string) {
  if (status === "installed") return t("agentSkill.installed");
  if (status === "routed-via-parent") return t("agentSkill.routedViaParent");
  if (status === "missing") return t("agentSkill.missing");
  if (["agent-disabled", "skill-disabled"].includes(status)) return t("agentSkill.disabled");
  if (status === "invalid-manifest") return t("agentSkill.invalid");
  if (status === "agent-missing") return t("agentSkill.notDetected");
  return status;
}

function compactAgentName(name: string) {
  const normalized = name.toLowerCase();
  if (normalized.includes("claude")) return "Claude";
  if (normalized.includes("codex")) return "Codex";
  if (normalized.includes("antigravity")) return "Antigravity";
  return name.replace(/\s+code$/i, "").trim();
}

function shortRevision(value?: string) {
  return (value ?? "").trim().slice(0, 8);
}

function routerHubUnchangedCount(report: RouterHubReport) {
  return report.unchangedCount ?? report.plans.filter(plan => plan.status === "unchanged").length;
}

function routerHubCommitMessage(report: RouterHubReport) {
  const unchanged = routerHubUnchangedCount(report);
  const skipped = report.skippedCount;
  const duplicateCount = report.duplicateChildren.length;
  const warningCount = report.healthWarnings.length;
  const suffixParts = [
    skipped > 0 ? t("router.suffixSkipped", { n: skipped }) : "",
    duplicateCount > 0 ? t("router.suffixDuplicates", { n: duplicateCount }) : "",
    warningCount > 0 ? t("router.suffixWarnings", { n: warningCount }) : ""
  ].filter(Boolean);
  const suffix = suffixParts.length > 0 ? `; ${suffixParts.join(", ")}` : "";
  if (report.writtenCount === 0 && unchanged > 0) {
    return t("router.commitFresh", { unchanged, suffix });
  }
  return t("router.commitDone", { written: report.writtenCount, unchanged, suffix });
}
