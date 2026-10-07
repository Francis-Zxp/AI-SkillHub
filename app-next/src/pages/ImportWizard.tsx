// Source import wizard rendered inside the Library page. Split out of App.tsx;
// App() still owns the shared state and handlers. Never import from App.tsx here (use appShared.ts).
import { useEffect, useState } from "react";
import { Icon } from "../icons";
import { t } from "../i18n";
import { externalSkillsText } from "../externalSkills";
import type {
  LegacySnapshot,
  SkillFolderCard,
  SourceCard,
  SourceImportExecutionCard,
  SourceImportPlanCard,
  SourceImportPromotionCard
} from "../types";
import {
  type SourceDraft,
  type ImportWizardDraft,
  IMPORT_WIZARD_DRAFT_STORAGE_KEY,
  EMPTY_IMPORT_WIZARD_DRAFT,
  loadImportWizardDraft,
  importWizardDraftHasContent,
  type SourceImportProgressEvent,
  type ImportFeedbackOptions,
  CATEGORY_IDS,
  showUiToast,
  messageFromError,
  createSourceImportOperationId,
  parseTagInput,
  inferCategoryIds,
  displayCategoryName
} from "../appShared";
import { SegmentedToggle, ToggleSwitch } from "../components/ui";

const CREATE_IMPORT_FOLDER_VALUE = "__create_custom_folder__";

function saveImportWizardDraft(draft: ImportWizardDraft) {
  try {
    if (importWizardDraftHasContent(draft)) {
      window.localStorage.setItem(IMPORT_WIZARD_DRAFT_STORAGE_KEY, JSON.stringify(draft));
    } else {
      window.localStorage.removeItem(IMPORT_WIZARD_DRAFT_STORAGE_KEY);
    }
  } catch {
    // A disabled or full browser store must never prevent adding a source.
  }
}

function clearImportWizardDraft() {
  try {
    window.localStorage.removeItem(IMPORT_WIZARD_DRAFT_STORAGE_KEY);
  } catch {
    // Keep the form usable when local storage is unavailable.
  }
}

type QuickAddStatus = {
  body: string;
  title: string;
  tone: "info" | "ok" | "warn" | "error";
};
type ImportProgress = {
  detail: string;
  indeterminate?: boolean;
  percent: number;
  step: number;
  total: number;
};

/* =============================================================
   Import wizard (simplified)
   ============================================================= */

export function ImportWizard({
  suggestedLocalPath,
  onDismissLocalImport,
  disabled,
  onCancel,
  onCreateFolder,
  onPreview,
  onPromote,
  onRefreshIndex,
  onMoveSourceSkillsToFolder,
  onSaveSourceMetadata,
  onStage,
  sources,
  skillFolders
}: {
  suggestedLocalPath: string;
  onDismissLocalImport: () => void;
  disabled: boolean;
  onCancel: (operationId: string) => Promise<boolean>;
  onCreateFolder: (name: string, note: string, color: string) => Promise<LegacySnapshot | null>;
  onPreview: (importKind: string, input: string, options?: ImportFeedbackOptions) => Promise<SourceImportPlanCard>;
  onPromote: (
    importKind: string,
    stagedPath: string,
    sourceName: string,
    options?: ImportFeedbackOptions
  ) => Promise<SourceImportPromotionCard>;
  onRefreshIndex: (localOnly?: boolean) => Promise<LegacySnapshot | null>;
  onMoveSourceSkillsToFolder: (sourceId: string, folderId: string) => Promise<LegacySnapshot | null>;
  onSaveSourceMetadata: (source: SourceCard, draft: SourceDraft) => Promise<"failed" | "preview" | "saved">;
  onStage: (importKind: string, input: string, options?: ImportFeedbackOptions) => Promise<SourceImportExecutionCard>;
  sources: SourceCard[];
  skillFolders: SkillFolderCard[];
}) {
  const [initialDraft] = useState(loadImportWizardDraft);
  const [importKind, setImportKind] = useState<ImportWizardDraft["importKind"]>(initialDraft.importKind);
  const [input, setInput] = useState(initialDraft.input);
  const [folderId, setFolderId] = useState(initialDraft.folderId);
  const [sourceType, setSourceType] = useState<SourceCard["sourceType"]>(initialDraft.sourceType);
  const [note, setNote] = useState(initialDraft.note);
  const [tags, setTags] = useState(initialDraft.tags);
  const [enabled, setEnabled] = useState(initialDraft.enabled);
  const [customCategory, setCustomCategory] = useState(initialDraft.customCategory);
  const [customFolderName, setCustomFolderName] = useState(initialDraft.customFolderName);
  const [selectedCategoryIds, setSelectedCategoryIds] = useState<string[]>(initialDraft.selectedCategoryIds);
  const [pending, setPending] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [activeOperationId, setActiveOperationId] = useState("");
  const [status, setStatus] = useState<QuickAddStatus | null>(null);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [securityReview, setSecurityReview] = useState<{
    execution: SourceImportExecutionCard;
    plan: SourceImportPlanCard;
  } | null>(null);

  const inferredIds = inferCategoryIds(`${input} ${note} ${sourceType} ${importKind}`);
  const effectiveCategoryIds = selectedCategoryIds.length > 0 ? selectedCategoryIds : inferredIds;

  useEffect(() => {
    saveImportWizardDraft({
      customCategory,
      customFolderName,
      enabled,
      importKind,
      input,
      folderId,
      note,
      selectedCategoryIds,
      sourceType,
      tags
    });
  }, [customCategory, customFolderName, enabled, folderId, importKind, input, note, selectedCategoryIds, sourceType, tags]);

  function resetImportDraft() {
    clearImportWizardDraft();
    setImportKind(EMPTY_IMPORT_WIZARD_DRAFT.importKind);
    setInput(EMPTY_IMPORT_WIZARD_DRAFT.input);
    setFolderId(EMPTY_IMPORT_WIZARD_DRAFT.folderId);
    setSourceType(EMPTY_IMPORT_WIZARD_DRAFT.sourceType);
    setNote(EMPTY_IMPORT_WIZARD_DRAFT.note);
    setTags(EMPTY_IMPORT_WIZARD_DRAFT.tags);
    setEnabled(EMPTY_IMPORT_WIZARD_DRAFT.enabled);
    setCustomCategory(EMPTY_IMPORT_WIZARD_DRAFT.customCategory);
    setCustomFolderName(EMPTY_IMPORT_WIZARD_DRAFT.customFolderName);
    setSelectedCategoryIds([]);
  }

  function clearDraftManually() {
    resetImportDraft();
    setSecurityReview(null);
    setProgress(null);
    setStatus(null);
    showUiToast(t("qa.draftCleared"), "info");
  }

  function requiresSecurityReview(status: string, findingCount = 0) {
    return status === "review" || status === "warn" || (status === "blocked" && findingCount > 0);
  }

  function applyBackendProgress(event: SourceImportProgressEvent) {
    const ranges: Record<string, { start: number; end: number; step: number }> = {
      inspect: { start: 10, end: 20, step: 1 },
      git: { start: 24, end: 38, step: 2 },
      zip: { start: 40, end: 54, step: 2 },
      write: { start: 56, end: 68, step: 2 },
      security: { start: 70, end: 78, step: 3 }
    };
    const range = ranges[event.stage] ?? { start: 22, end: 68, step: 2 };
    const measured = event.total > 0 ? Math.min(1, Math.max(0, event.current / event.total)) : 0;
    const percent = event.state === "completed"
      ? range.end
      : Math.round(range.start + (range.end - range.start) * measured);
    setProgress(current => ({
      detail: event.message || current?.detail || t("qa.statusJoining"),
      indeterminate: event.total <= 0 && event.state !== "completed",
      percent: Math.max(current?.percent ?? 0, percent),
      step: Math.max(current?.step ?? 1, range.step),
      total: 5
    }));
  }

  async function promoteAndFinalize(
    plan: SourceImportPlanCard,
    execution: SourceImportExecutionCard,
    securityReviewConfirmed: boolean
  ): Promise<boolean> {
      setProgress({ detail: t("qa.statusWriting"), percent: 74, step: 3, total: 5 });
      setStatus({ tone: "info", title: t("qa.statusWriting"), body: t("qa.statusWritingBody") });
      const promotion = await onPromote(
        execution.importKind,
        execution.stagedPath,
        plan.displayName,
        { quiet: true, securityReviewConfirmed }
      );
      if (
        promotion.status === "blocked" &&
        requiresSecurityReview(promotion.securityStatus, promotion.securityFindings.length) &&
        !securityReviewConfirmed
      ) {
        setProgress({ detail: t("qa.securityReviewTitle"), percent: 70, step: 3, total: 5 });
        setSecurityReview({
          plan,
          execution: {
            ...execution,
            securityStatus: promotion.securityStatus,
            securityScannedFiles: promotion.securityScannedFiles,
            securityFindings: promotion.securityFindings,
            summary: promotion.summary
          }
        });
        setStatus({
          tone: "warn",
          title: t("qa.securityReviewTitle"),
          body: t("qa.securityReviewBody", {
            files: promotion.securityScannedFiles,
            findings: promotion.securityFindings.length
          })
        });
        showUiToast(t("qa.securityReviewToast"), "warn");
        return false;
      }
      if (promotion.status !== "promoted" && promotion.status !== "already-managed") {
        setSecurityReview(null);
        setProgress(null);
        setStatus({ tone: "warn", title: t("qa.statusNotWritten"), body: promotion.summary });
        showUiToast(t("qa.toastPromoteStop"), "warn");
        return false;
      }
      setSecurityReview(null);
      setProgress({ detail: t("qa.statusRefreshing"), percent: 88, step: 4, total: 5 });
      setStatus({ tone: "info", title: t("qa.statusRefreshing"), body: t("qa.statusRefreshingBody") });
      const reviewedLocalOnly = securityReviewConfirmed && promotion.securityStatus !== "passed";
      const refreshed = await onRefreshIndex(reviewedLocalOnly);
      if (!refreshed) throw new Error(t("toast.syncFailed"));
      const promotedSource = refreshed?.sources.find(
        item => normalizeSourcePath(item.localPath) === normalizeSourcePath(promotion.targetPath)
      );
      if (!promotedSource) throw new Error(t("qa.statusNotWritten"));
      if (promotedSource && promotion.status !== "already-managed") {
        const detectedSourceType: SourceCard["sourceType"] =
          execution.skillCount === 0 && execution.promptCount > 0
            ? "prompt"
            : execution.skillCount > 0
              ? "skill"
              : sourceType;
        const customCategoryLabel = customCategory.trim();
        const primaryCategory =
          customCategoryLabel ||
          displayCategoryName(effectiveCategoryIds[0] ?? categoryIdForSourceType(detectedSourceType));
        const extraTags = effectiveCategoryIds.slice(customCategoryLabel ? 0 : 1).map(displayCategoryName).join(", ");
        const draft: SourceDraft = {
          category: primaryCategory,
          enabled: reviewedLocalOnly ? false : enabled,
          name: promotedSource.name,
          note,
          sourceType: detectedSourceType,
          tags: mergeTagInputs(tags, extraTags)
        };
        setProgress({ detail: t("qa.statusRefreshing"), percent: 96, step: 5, total: 5 });
        const saveResult = await onSaveSourceMetadata(promotedSource, draft);
        if (saveResult === "failed") throw new Error(t("toast.sourceSaveFailed"));
        let resolvedFolderId = folderId;
        if (folderId === CREATE_IMPORT_FOLDER_VALUE) {
          const requestedName = customFolderName.trim();
          const existingFolder = skillFolders.find(
            folder => folder.name.trim().toLocaleLowerCase() === requestedName.toLocaleLowerCase()
          );
          if (existingFolder) {
            resolvedFolderId = existingFolder.id;
          } else {
            const created = await onCreateFolder(requestedName, "", "cyan");
            const createdFolder = (created?.skillFolders ?? []).find(
              folder => folder.name.trim().toLocaleLowerCase() === requestedName.toLocaleLowerCase()
            );
            if (!createdFolder) throw new Error(t("folders.createDuringImportFailed"));
            resolvedFolderId = createdFolder.id;
          }
        }
        if (resolvedFolderId) {
          const moved = await onMoveSourceSkillsToFolder(promotedSource.id, resolvedFolderId);
          if (!moved) throw new Error(t("folders.fileDuringImportFailed"));
        }
      }
      setProgress({ detail: t("qa.statusAddedTitle"), percent: 100, step: 5, total: 5 });
      resetImportDraft();
      setStatus({
        tone: "ok",
        title: t("qa.statusAddedTitle"),
        body:
          execution.skillCount === 0 && execution.promptCount > 0
            ? t("qa.statusAddedPrompt")
            : reviewedLocalOnly
              ? t("qa.statusAddedLocalReview")
              : t("qa.statusAddedSynced")
      });
      showUiToast(t(reviewedLocalOnly ? "qa.toastAddedLocalReview" : "qa.toastSynced"), "ok");
      return true;
  }

  async function quickAdd() {
    const value = input.trim();
    if (!value) {
      showUiToast(t("qa.needInput"), "warn");
      return;
    }
    if (folderId === CREATE_IMPORT_FOLDER_VALUE && !customFolderName.trim()) {
      showUiToast(t("folders.customNameRequired"), "warn");
      return;
    }
    setPending(true);
    setSecurityReview(null);
    setProgress({ detail: t("qa.statusChecking"), percent: 8, step: 1, total: 5 });
    setStatus({ tone: "info", title: t("qa.statusChecking"), body: t("qa.statusCheckingBody") });
    try {
      const plan = await onPreview(importKind, value, { quiet: true });
      if (!plan.safeToContinue) {
        setProgress(null);
        setStatus({
          tone: "warn",
          title: t("qa.statusBlockedTitle"),
          body: plan.duplicateReason || plan.blockingChecks[0] || ""
        });
        showUiToast(t("qa.toastBlocked"), "warn");
        return;
      }
      setProgress({ detail: t("qa.statusJoining"), percent: 20, step: 2, total: 5 });
      setStatus({ tone: "info", title: t("qa.statusJoining"), body: t("qa.statusJoiningBody") });
      const operationId = createSourceImportOperationId();
      setActiveOperationId(operationId);
      const execution = await onStage(plan.importKind, plan.input, {
        quiet: true,
        operationId,
        onProgress: applyBackendProgress
      });
      setProgress(current => ({
        detail: t("qa.statusJoining"),
        percent: Math.max(current?.percent ?? 0, 68),
        step: Math.max(current?.step ?? 2, 2),
        total: 5
      }));
      if (requiresSecurityReview(execution.securityStatus, execution.securityFindings.length)) {
        setEnabled(false);
        setProgress({ detail: t("qa.securityReviewTitle"), percent: 70, step: 3, total: 5 });
        setSecurityReview({ execution, plan });
        setStatus({
          tone: "warn",
          title: t("qa.securityReviewTitle"),
          body: t("qa.securityReviewBody", {
            files: execution.securityScannedFiles,
            findings: execution.securityFindings.length
          })
        });
        showUiToast(t("qa.securityReviewToast"), "warn");
        return;
      }
      if (execution.status !== "staged" && execution.status !== "warn") {
        const detail = execution.blockingChecks
          .filter(check => check.trim())
          .slice(0, 2)
          .join("；");
        setStatus({
          tone: "warn",
          title: t("qa.statusNotWritten"),
          body: `${execution.summary}${detail && detail !== execution.summary ? `\n${detail}` : ""}`
        });
        setProgress(null);
        showUiToast(t("qa.toastStagingStop"), "warn");
        return;
      }
      await promoteAndFinalize(plan, execution, false);
    } catch (error) {
      const message = messageFromError(error);
      const wasCancelled = /cancel|取消|취소/i.test(message);
      setProgress(null);
      setStatus({
        tone: wasCancelled ? "info" : "error",
        title: wasCancelled ? t("qa.cancelled") : t("qa.statusFailed"),
        body: message
      });
      showUiToast(wasCancelled ? t("qa.cancelled") : t("qa.toastFailed"), wasCancelled ? "info" : "error");
    } finally {
      setActiveOperationId("");
      setCancelling(false);
      setPending(false);
    }
  }

  async function cancelImport() {
    if (!activeOperationId || cancelling) return;
    setCancelling(true);
    setStatus({ tone: "info", title: t("qa.cancelling"), body: t("qa.cancellingBody") });
    try {
      const accepted = await onCancel(activeOperationId);
      if (!accepted) showUiToast(t("qa.cancelNoTask"), "info");
    } catch (error) {
      setCancelling(false);
      showUiToast(messageFromError(error), "error");
    }
  }

  async function confirmSecurityReview() {
    if (!securityReview) return;
    setPending(true);
    setProgress({ detail: t("qa.statusWriting"), percent: 74, step: 3, total: 5 });
    try {
      await promoteAndFinalize(securityReview.plan, securityReview.execution, true);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setProgress(null);
      setStatus({ tone: "error", title: t("qa.statusFailed"), body: message });
      showUiToast(t("qa.toastFailed"), "error");
    } finally {
      setPending(false);
    }
  }

  async function retryGitCloneFromSecurityReview() {
    if (!securityReview || securityReview.plan.importKind !== "github") return;
    const current = securityReview;
    setPending(true);
    setProgress({ detail: t("qa.retryGitRunning"), percent: 20, step: 2, total: 5 });
    setStatus({ tone: "info", title: t("qa.retryGitRunning"), body: t("qa.retryGitRunningBody") });
    try {
      const operationId = createSourceImportOperationId();
      setActiveOperationId(operationId);
      const execution = await onStage(current.plan.importKind, current.plan.input, {
        quiet: true,
        operationId,
        onProgress: applyBackendProgress
      });
      if (requiresSecurityReview(execution.securityStatus, execution.securityFindings.length)) {
        setEnabled(false);
        setSecurityReview({ plan: current.plan, execution });
        setProgress({ detail: t("qa.securityReviewTitle"), percent: 70, step: 3, total: 5 });
        setStatus({
          tone: execution.downloadMethod === "git" ? "ok" : "warn",
          title: execution.downloadMethod === "git" ? t("qa.retryGitSucceeded") : t("qa.retryGitStillSnapshot"),
          body: execution.downloadMethod === "git"
            ? t("qa.downloadModeGitBody")
            : execution.blockingChecks[0] || t("qa.downloadModeSnapshotBody")
        });
        return;
      }
      if (execution.status !== "staged" && execution.status !== "warn") {
        setProgress(null);
        setStatus({
          tone: "warn",
          title: t("qa.retryGitStillSnapshot"),
          body: execution.blockingChecks[0] || execution.summary
        });
        return;
      }
      setSecurityReview(null);
      await promoteAndFinalize(current.plan, execution, false);
    } catch (error) {
      setProgress(null);
      setStatus({ tone: "error", title: t("qa.statusFailed"), body: messageFromError(error) });
      showUiToast(t("qa.toastFailed"), "error");
    } finally {
      setActiveOperationId("");
      setPending(false);
    }
  }

  const isBusy = disabled || pending;
  const placeholder =
    importKind === "github"
      ? t("qa.placeholderGithub")
      : importKind === "local"
        ? t("qa.placeholderLocal")
        : t("qa.placeholderZip");
  const currentCategoryLabel =
    customCategory.trim() || effectiveCategoryIds.map(displayCategoryName).join("、") || t("type.mixed");

  return (
    <section className="import-wizard glow-card">
      {suggestedLocalPath && <div className="external-import-suggestion">
        <strong>{externalSkillsText("suggested")}</strong>
        <p><code>{suggestedLocalPath}</code></p>
        {importWizardDraftHasContent(initialDraft) && <p>{externalSkillsText("draftNote")}</p>}
        <button className="secondary-action" disabled={isBusy} type="button" onClick={() => {
          resetImportDraft();
          setImportKind("local");
          setInput(suggestedLocalPath);
          onDismissLocalImport();
        }}>{externalSkillsText("usePath")}</button>
        <button className="ghost-action" disabled={isBusy} type="button" onClick={onDismissLocalImport}>{externalSkillsText("dismiss")}</button>
      </div>}
      <header className="panel-head">
        <div>
          <span className="eyebrow"><Icon name="add" /> {t("qa.eyebrow")}</span>
          <h3>{t("qa.title")}</h3>
          <p>{t("qa.subtitle")}</p>
        </div>
      </header>

      <div className="import-grid">
        <div className="import-field">
          <span className="field-label">{t("qa.kind")}</span>
          <SegmentedToggle
            value={importKind}
            options={[
              { value: "github", label: t("qa.kindGithub") },
              { value: "local", label: t("qa.kindLocal") },
              { value: "zip", label: t("qa.kindZip") }
            ]}
            onChange={value => {
              setImportKind(value);
              setSecurityReview(null);
              setProgress(null);
            }}
          />
        </div>
        <label className="import-field grow">
          <span className="field-label">{t("qa.input")}</span>
          <input
            disabled={isBusy}
            onChange={event => {
              setInput(event.target.value);
              setSecurityReview(null);
              setProgress(null);
            }}
            placeholder={placeholder}
            value={input}
          />
        </label>
        <label className="import-field">
          <span className="field-label">{t("qa.type")}</span>
          <select
            disabled={isBusy}
            onChange={event => setSourceType(event.target.value as SourceCard["sourceType"])}
            value={sourceType}
          >
            <option value="skill">{t("qa.typeSkill")}</option>
            <option value="prompt">{t("qa.typePrompt")}</option>
            <option value="mixed">{t("qa.typeMixed")}</option>
          </select>
        </label>
        <label className="import-field import-folder-field">
          <span className="field-label">{t("folders.importTo")}</span>
          <select disabled={isBusy} onChange={event => setFolderId(event.target.value)} value={folderId}>
            <option value="">{t("folders.chooseLater")}</option>
            {skillFolders.map(folder => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
            <option value={CREATE_IMPORT_FOLDER_VALUE}>{t("folders.createDuringImport")}</option>
          </select>
          {folderId === CREATE_IMPORT_FOLDER_VALUE && (
            <input
              disabled={isBusy}
              maxLength={48}
              onChange={event => setCustomFolderName(event.target.value)}
              placeholder={t("folders.customNamePlaceholder")}
              value={customFolderName}
            />
          )}
        </label>
      </div>

      <div className="import-field">
        <span className="field-label">{t("qa.category")}</span>
        <div className="category-chip-grid">
          {CATEGORY_IDS.map(id => (
            <button
              className={
                effectiveCategoryIds.includes(id) ? "category-chip active" : "category-chip"
              }
              disabled={isBusy}
              key={id}
              onClick={() =>
                setSelectedCategoryIds(prev =>
                  prev.includes(id) ? prev.filter(value => value !== id) : [...prev, id]
                )
              }
              type="button"
            >
              {displayCategoryName(id)}
            </button>
          ))}
        </div>
        <input
          className="category-custom"
          disabled={isBusy}
          onChange={event => setCustomCategory(event.target.value)}
          placeholder={t("qa.customCategoryPlaceholder")}
          value={customCategory}
        />
        <small>{t("qa.currentCategory", { value: currentCategoryLabel })}</small>
      </div>

      <label className="import-field">
        <span className="field-label">{t("qa.tags")}</span>
        <input
          disabled={isBusy}
          onChange={event => setTags(event.target.value)}
          placeholder={t("qa.tagsPlaceholder")}
          value={tags}
        />
      </label>

      <label className="import-field">
        <span className="field-label">{t("qa.note")}</span>
        <textarea
          disabled={isBusy}
          onChange={event => setNote(event.target.value)}
          placeholder={t("qa.notePlaceholder")}
          rows={2}
          value={note}
        />
      </label>

      <div className="import-toggle-row">
        <div>
          <strong>{t("qa.enableAfter")}</strong>
          <span>{t(securityReview ? "qa.enableAfterReviewHint" : "qa.enableAfterHint")}</span>
        </div>
        <ToggleSwitch
          disabled={isBusy || Boolean(securityReview)}
          enabled={enabled}
          label={enabled ? t("common.enabled") : t("common.disabled")}
          onClick={() => setEnabled(value => !value)}
        />
      </div>

      {securityReview && (
        <section className="import-security-review" role="alert" aria-live="assertive">
          <header>
            <span className="import-security-review-icon"><Icon name="shield" /></span>
            <div>
              <strong>{t("qa.securityReviewTitle")}</strong>
              <p>
                {t("qa.securityReviewBody", {
                  files: securityReview.execution.securityScannedFiles,
                  findings: securityReview.execution.securityFindings.length
                })}
              </p>
            </div>
            <span className="qa-status planned">{t("qa.securityReviewIsolated")}</span>
          </header>
          {securityReview.execution.importKind === "github" && (
            <div className={`import-download-mode ${securityReview.execution.downloadMethod === "git" ? "git" : "snapshot"}`}>
              <Icon name={securityReview.execution.downloadMethod === "git" ? "github" : "alert"} />
              <div>
                <strong>
                  {t(securityReview.execution.downloadMethod === "git" ? "qa.downloadModeGitTitle" : "qa.downloadModeSnapshotTitle")}
                </strong>
                <span>
                  {t(securityReview.execution.downloadMethod === "git" ? "qa.downloadModeGitBody" : "qa.downloadModeSnapshotBody")}
                </span>
              </div>
            </div>
          )}
          <ul className="import-security-findings">
            {securityReview.execution.securityFindings.slice(0, 8).map(finding => (
              <li key={finding.id}>
                <span className={`security-severity severity-${finding.severity}`}>
                  {finding.severity}
                </span>
                <div>
                  <strong>
                    {finding.relativePath}
                    {finding.line > 0 ? `:${finding.line}` : ""}
                  </strong>
                  <span>{finding.summary}</span>
                  {finding.evidence && <code>{finding.evidence}</code>}
                </div>
              </li>
            ))}
            {securityReview.execution.securityFindings.length === 0 && (
              <li>
                <div>
                  <strong>{t("qa.securityReviewEvidenceFallback")}</strong>
                  <span>{securityReview.execution.summary}</span>
                </div>
              </li>
            )}
          </ul>
          {securityReview.execution.securityFindings.length > 8 && (
            <small>
              {t("qa.securityReviewMore", {
                n: securityReview.execution.securityFindings.length - 8
              })}
            </small>
          )}
          <div className="import-security-actions">
            {securityReview.execution.importKind === "github" && securityReview.execution.downloadMethod !== "git" && (
              <button
                className="secondary-action"
                disabled={isBusy}
                onClick={() => void retryGitCloneFromSecurityReview()}
                type="button"
              >
                <Icon name="refresh" /> {t("qa.retryGit")}
              </button>
            )}
            <button
              className="ghost-action"
              disabled={isBusy}
              onClick={() => {
                setSecurityReview(null);
                setStatus({
                  tone: "info",
                  title: t("qa.securityReviewDeferredTitle"),
                  body: t("qa.securityReviewDeferredBody")
                });
              }}
              type="button"
            >
              {t("qa.securityReviewCancel")}
            </button>
            <button
              className="primary-action"
              disabled={isBusy}
              onClick={() => void confirmSecurityReview()}
              type="button"
            >
              <Icon name="shield" /> {t("qa.securityReviewConfirm")}
            </button>
          </div>
        </section>
      )}

      <div className="import-actions">
        <button
          className="secondary-action"
          disabled={isBusy || !importWizardDraftHasContent({
            customCategory,
            customFolderName,
            enabled,
            importKind,
            input,
            folderId,
            note,
            selectedCategoryIds,
            sourceType,
            tags
          })}
          onClick={clearDraftManually}
          type="button"
        >
          {t("qa.clearDraft")}
        </button>
        {activeOperationId && (
          <button className="secondary-action import-cancel-action" disabled={cancelling} onClick={() => void cancelImport()} type="button">
            <Icon name="alert" /> {cancelling ? t("qa.cancelling") : t("qa.cancelImport")}
          </button>
        )}
        <button className="primary-action large" disabled={isBusy} onClick={() => void quickAdd()} type="button">
          <Icon name="add" /> {isBusy ? t("qa.submitting") : t("qa.submit")}
        </button>
      </div>

      {progress && (
        <div
          aria-label={`${progress.detail} ${progress.percent}%`}
          aria-valuemax={100}
          aria-valuemin={0}
          aria-valuenow={progress.indeterminate ? undefined : progress.percent}
          className={`import-progress${pending ? " is-active" : ""}${progress.indeterminate ? " is-indeterminate" : ""}`}
          role="progressbar"
        >
          <div className="import-progress-copy">
            <strong>{progress.detail}</strong>
            <span>{progress.step} / {progress.total}{progress.indeterminate ? ` · ${t("qa.measuring")}` : ` · ${progress.percent}%`}</span>
          </div>
          <div className="import-progress-track">
            <span style={{ width: progress.indeterminate ? "28%" : `${progress.percent}%` }} />
          </div>
        </div>
      )}

      {status && (
        <div className={`import-status tone-${status.tone}`} role="status">
          <strong>{status.title}</strong>
          <span>{status.body}</span>
        </div>
      )}

      <small className="import-foot">{sources.length} sources indexed</small>
    </section>
  );
}

function mergeTagInputs(...values: string[]): string {
  return parseTagInput(values.join(", ")).join(", ");
}

function normalizeSourcePath(path: string) {
  return path.trim().replace(/[\\/]+/g, "/").replace(/\/+$/g, "").toLowerCase();
}

function categoryIdForSourceType(sourceType: SourceCard["sourceType"]) {
  if (sourceType === "prompt") return "prompt-polishing";
  if (sourceType === "mixed") return "general";
  return "agent-tools";
}
