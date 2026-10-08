/** v3.3: "workspaces" and "sources" are gone (they redirect to agents / library);
 *  "connections" is the MCP page; release tools live in Settings → 开发者模式. */
export type NavKey =
  | "dashboard"
  | "library"
  | "agents"
  | "connections"
  | "settings";

export type LegacySnapshot = {
  root: string;
  skillsDir: string;
  sourcesDir: string;
  diagnosticsFile: string;
  mode: "read-only" | "sqlite-index" | "browser-preview";
  summary: LegacySummary;
  skills: SkillCard[];
  sources: SourceCard[];
  agents: AgentCard[];
  agentSkillStatuses: AgentSkillStatusCard[];
  agentAdapters: AgentAdapterCard[];
  agentDoctors: AgentDoctorCard[];
  adapterSafetyChecks: AdapterSafetyCheckCard[];
  adapterCapabilities: AdapterCapabilityCard[];
  workspaces: WorkspaceCard[];
  projectScans: ProjectScanCard[];
  presets: PresetCard[];
  snapshots: SnapshotCard[];
  backupTargets: BackupTargetCard[];
  backupDryRun: BackupDryRunItemCard[];
  restoreDryRun: RestoreDryRunItemCard[];
  rollbackPlan: RollbackPlanStepCard[];
  releaseReports: ReleaseReportCard[];
  importPreviews: ImportPreviewCard[];
  sourcePopularity: SourcePopularityCard[];
  sourceGovernance: SourceGovernanceCard[];
  sourceQualitySignals: SourceQualitySignalCard[];
  lastSyncSummary?: SyncSummaryCard;
  skillConflicts: SkillConflictCard[];
  operatorConsent: OperatorConsentCard;
  tags: TagCard[];
  skillFolders?: SkillFolderCard[];
  presetDistributions: PresetDistributionCard[];
  operationRunners: OperationRunnerCard[];
  writeGates: WriteGateCard[];
  desktopQaChecks: DesktopQaCheckCard[];
  usageStats: UsageStatCard[];
  auditEvents: AuditEventCard[];
  diagnostics: DiagnosticSummary;
  index: IndexReport;
  /** v3.3: filled by read_snapshot_from_database; optional only for old fixtures. */
  skillDelivery?: SkillDeliveryState;
};

export type RuntimeSnapshotHydration = Pick<
  LegacySnapshot,
  | "agentSkillStatuses"
  | "agentDoctors"
  | "sourceGovernance"
  | "operationRunners"
  | "releaseReports"
  | "importPreviews"
  | "writeGates"
>;

export type LegacySummary = {
  skills: number;
  sources: number;
  prompts: number;
  agentsDetected: number;
  warnings: number;
  diagnosticsStatus: string;
};

export type SkillCard = {
  /** Stable SQLite identity. Browser-preview fixtures may omit it. */
  id?: string;
  /** Exact owning source identity. Empty only for truly standalone/local Skills. */
  sourceId?: string;
  name: string;
  /** Immutable host-delivered name used when invoking this Skill. */
  invocationName?: string;
  folderName: string;
  category: string;
  description: string;
  note: string;
  source: string;
  health: "ok" | "warn" | "error" | "info";
  enabled: boolean;
  /** Personal 0–5 star score stored only in the local AI SkillHub SQLite database. */
  rating: number;
  relativePath: string;
  tags: string[];
  /** Offline-inferred usage guidance. Manual note/description overrides remain authoritative. */
  usageGuide?: string;
  /** Evidence chain used by the deterministic metadata analyzer. */
  metadataOrigin?: string;
  /** 0–1 evidence completeness, not a quality score. */
  metadataConfidence?: number;
  /**
   * Backend-computed marker for parent / router-hub Skills.
   * True when SKILL.md description contains the [ROUTER-HUB] marker,
   * the file lives under app-next/data/github_sources/AI-SkillHub-local-routers,
   * or the skill name matches its source collection name.
   * Optional during the rollout window; older SQLite snapshots may omit it.
   */
  isRouterHub?: boolean;
  /** Optional user-created primary folder used for library organization. */
  userFolderId?: string;
  userFolderName?: string;
  userFolderColor?: string;
};

export type SyncSummaryCard = {
  generatedAt: string;
  status: "ok" | "partial" | "failed" | "no-network-update" | string;
  total: number;
  succeeded: number;
  failed: number;
  skipped: number;
  activeSkills: number;
  repositories: Array<{
    repository: string;
    action: string;
    status: string;
    message: string;
  }>;
  /** Every round of the current "update all sources" run, merged per source. */
  updateRun?: SourceUpdateRun | null;
};

export type SourceUpdateOutcome =
  | "updated"
  | "unchanged"
  | "pinned"
  | "local-changes"
  | "failed"
  | "deferred"
  | "not-git";

export type SourceUpdateRunEntry = {
  folder: string;
  outcome: SourceUpdateOutcome | string;
  detail: string;
  tracking: string;
  /** Canonical lowercase owner/repo; empty for local folders. */
  identity?: string;
  checkedAt: string;
  addedSkills: string[];
  removedPaths: string[];
  addedDependencies: string[];
  /** New upstream Skills outside an explicit selection: found, not enabled. */
  discoveredSkills: string[];
  /** New files where a local file already existed; the local copy was kept. */
  keptLocalPaths: string[];
};

export type SourceUpdateRun = {
  schemaVersion: number;
  runId: string;
  startedAt: string;
  updatedAt: string;
  rounds: number;
  sources: SourceUpdateRunEntry[];
};

export type GitRuntimeCard = {
  available: boolean;
  version: string;
  error: string;
  wingetAvailable: boolean;
  packageId: string;
  downloadPageUrl: string;
};

export type GitInstallResultCard = {
  status: "installed" | "already-installed" | "restart-required" | "winget-missing" | "failed" | string;
  summary: string;
  detail: string;
  runtime: GitRuntimeCard;
  restartRequired: boolean;
};

export type SkillFolderCard = {
  id: string;
  name: string;
  note: string;
  color: string;
  sortOrder: number;
  skillCount: number;
  createdAt: string;
  updatedAt: string;
};

export type SkillConflictCard = {
  conflictKey: string;
  childName: string;
  status: "unresolved" | "default-set" | "ignored" | string;
  defaultSkillId: string;
  defaultSourceName: string;
  updatedAt: string;
  choices: SkillConflictChoiceCard[];
};

export type SkillConflictChoiceCard = {
  skillId: string;
  skillName: string;
  folderName: string;
  sourceName: string;
  relativePath: string;
  category: string;
  description: string;
};

/**
 * Returned by the regenerate_router_hubs Tauri command.
 * Lists per-collection plans (dry-run) or actual writes (commit + consent).
 */
export type RouterHubReport = {
  plans: RouterHubPlanCard[];
  routersRoot: string;
  realWritesEnabled: boolean;
  committed: boolean;
  totalCollections: number;
  writtenCount: number;
  unchangedCount?: number;
  skippedCount: number;
  healthWarnings: RouterHubHealthWarning[];
  /** Same child Skill `name:` appearing in 2+ collections; only one wins on Claude. */
  duplicateChildren: RouterHubDuplicateChild[];
  summary: string;
};

export type RouterHubDuplicateChild = {
  childName: string;
  collections: string[];
};

export type RouterHubPlanCard = {
  collectionName: string;
  routerSkillName: string;
  routerSkillMdPath: string;
  childCount: number;
  children: string[];
  status:
    | "planned"
    | "written"
    | "unchanged"
    | "skipped-single-child"
    | "skipped-collision"
    | "skipped-empty"
    | string;
  summary: string;
};

export type RouterHubHealthWarning = {
  skillMdPath: string;
  issue: string;
};

export type SourceCard = {
  id: string;
  name: string;
  sourceType: "skill" | "prompt" | "mixed";
  health: "ok" | "warn" | "error" | "info";
  url: string;
  skillCount: number;
  mode: string;
  categoryId: string;
  note: string;
  localPath: string;
  enabled: boolean;
  /** Personal 0–5 score for the whole parent/source collection. */
  rating?: number;
  tags: string[];
  createdAt: string;
  /** Offline-inferred usage guidance for this source collection. */
  usageGuide?: string;
  /** Evidence chain used by the deterministic metadata analyzer. */
  metadataOrigin?: string;
  /** 0–1 evidence completeness, not a quality score. */
  metadataConfidence?: number;
  /** User folder assigned to the complete parent/source tree. */
  userFolderId?: string;
  userFolderName?: string;
  userFolderColor?: string;
};

export type PromptInvocationAssetCard = {
  name: string;
  relativePath: string;
  role: "instructions" | "context" | "reference" | string;
  bytes: number;
  included: boolean;
};

export type PromptInvocationHostCard = {
  id: string;
  name: string;
  detected: boolean;
  managed: boolean;
  enabled: boolean;
  autoDelivered: false;
  deliveryStatus: "copy-paste-ready" | "host-not-ready" | string;
  invocationSteps: string[];
};

export type PromptInvocationCard = {
  sourceId: string;
  sourceName: string;
  sourceType: "prompt";
  sourceUrl: string;
  invocationKind: "copy-paste";
  invocationName: "";
  copyReady: boolean;
  autoDelivered: false;
  workspaceComplete: boolean;
  copyText: string;
  assets: PromptInvocationAssetCard[];
  hosts: PromptInvocationHostCard[];
  warnings: string[];
};

export type SourceGovernanceCard = {
  sourceId: string;
  sourceName: string;
  sourceFolder: string;
  supportStatus: "git" | "local" | "snapshot" | string;
  pinned: boolean;
  pinnedRevision: string;
  currentRevision: string;
  remoteRevision: string;
  relation:
    | "up-to-date"
    | "update-available"
    | "local-ahead"
    | "diverged"
    | "rolled-back"
    | "unknown"
    | string;
  aheadCount: number;
  behindCount: number;
  changedFiles: number;
  additions: number;
  deletions: number;
  remoteSummary: string;
  lastCheckedAt: string;
  diffSource: "live" | "cached" | "none" | string;
  backupCount: number;
  latestBackupId: string;
  latestBackupRevision: string;
  latestBackupAt: string;
  canRollback: boolean;
  /** What sync fast-forwards, for example origin/main. */
  trackingBranch?: string;
  /** GitHub default branch at the last version check; never switched automatically. */
  remoteDefaultBranch?: string;
  status: string;
  message: string;
};

export type SourceQualitySignalCard = {
  sourceId: string;
  sourceName: string;
  score: number | null;
  status:
    | "excellent"
    | "good"
    | "mixed"
    | "weak"
    | "limited"
    | "insufficient"
    | string;
  evidenceCount: number;
  evidenceTotal: number;
  summary: string;
  factors: SourceQualityFactorCard[];
};

export type SourceQualityFactorCard = {
  key: "personal-rating" | "health" | "actual-usage" | "security" | string;
  label: string;
  status: "available" | "missing" | string;
  score: number | null;
  weight: number;
  detail: string;
};

export type AgentCard = {
  id: string;
  name: string;
  path: string;
  detected: boolean;
  managed: boolean;
  enabled: boolean;
  skillCount: number;
};

export type AgentSkillStatusCard = {
  id: string;
  agentId: string;
  agentName: string;
  skillName: string;
  skillFolderName: string;
  status: "installed" | "missing" | "agent-missing" | "agent-disabled" | "skill-disabled" | "invalid-manifest" | string;
  expectedPath: string;
  targetPath: string;
  summary: string;
};

export type AgentAdapterCard = {
  id: string;
  name: string;
  vendor: string;
  skillsPathHint: string;
  detectionKind: string;
  installScope: string;
  capabilityLevel: string;
  docsUrl: string;
  status: "ready" | "detected-unmanaged" | "not-detected" | string;
  detected: boolean;
  managed: boolean;
  enabled: boolean;
};

export type AgentDoctorCard = {
  adapterId: string;
  adapterName: string;
  detectionKind: string;
  pathHint: string;
  verdict:
    | "ready"
    | "code-detected"
    | "desktop-only"
    | "path-refresh-needed"
    | "directory-residue"
    | "not-detected"
    | string;
  summary: string;
  desktopStatus: string;
  cliStatus: string;
  skillsStatus: string;
  evidence: AgentDoctorEvidenceCard[];
  checkedPaths: string[];
  nextSteps: string[];
  safeFixAvailable: boolean;
};

export type AgentDoctorEvidenceCard = {
  probeKind: string;
  label: string;
  status: string;
  detail: string;
  path: string;
};

export type LegacyCleanupCandidateCard = {
  id: string;
  name: string;
  reason: string;
  path: string;
  totalBytes: number;
  fileCount: number;
  directoryCount: number;
  linkCount: number;
};

export type LegacyCleanupOperationCard = {
  candidateId: string;
  originalPath: string;
  backupPath: string;
  totalBytes: number;
  fileCount: number;
  linkCount: number;
  recoverable: boolean;
  detail: string;
};

export type AdapterSafetyCheckCard = {
  id: string;
  adapterId: string;
  checkKey: string;
  status: "ok" | "warn" | "error" | "info" | string;
  summary: string;
};

export type AdapterCapabilityCard = {
  id: string;
  adapterId: string;
  capabilityKey: string;
  enabled: boolean;
  summary: string;
};

export type WorkspaceCard = {
  id: string;
  name: string;
  scope: "global" | "agent" | "project" | string;
  path: string;
  enabled: boolean;
  agentCount: number;
  skillCount: number;
};

export type ProjectScanCard = {
  id: string;
  workspaceId: string;
  path: string;
  hasGit: boolean;
  hasPackageJson: boolean;
  hasCargoToml: boolean;
  hasTauriConfig: boolean;
  hasAgentsMd: boolean;
  hasClaudeMd: boolean;
  hasReadmeMd: boolean;
  fileCount: number;
  scannedAt: string;
};

export type PresetCard = {
  id: string;
  name: string;
  description: string;
  color: string;
  enabled: boolean;
  skillCount: number;
  workspaceCount: number;
};

export type TagCard = {
  id: string;
  name: string;
  color: string;
  targetCount: number;
};

export type PresetDistributionCard = {
  id: string;
  presetId: string;
  presetName: string;
  workspaceId: string;
  workspaceName: string;
  workspaceScope: string;
  enabled: boolean;
  skillCount: number;
  status: string;
  summary: string;
};

export type OperationRunnerCard = {
  id: string;
  title: string;
  runnerType: string;
  status: "ready" | "completed" | "locked" | "error" | string;
  locked: boolean;
  lastRunAt: string;
  exportDir: string;
  reportPath: string;
  latestJsonPath: string;
  latestMarkdownPath: string;
  manifestPath: string;
  fileCount: number;
  summary: string;
  nextAction: string;
};

export type WriteGateCard = {
  id: string;
  title: string;
  operationType: string;
  status: "blocked" | "locked" | "ready" | string;
  unlocked: boolean;
  riskLevel: "low" | "medium" | "high" | string;
  summary: string;
  nextAction: string;
  planSteps: string[];
  rollbackSteps: string[];
  passingChecks: string[];
  blockingChecks: string[];
};

export type SnapshotCard = {
  id: string;
  name: string;
  summary: string;
  createdAt: string;
  isLatest: boolean;
};

export type BackupTargetCard = {
  id: string;
  adapterId: string;
  agentName: string;
  targetPath: string;
  backupPath: string;
  detected: boolean;
  managed: boolean;
  required: boolean;
  preflightStatus: "ready" | "required" | "blocked" | "skipped" | string;
  riskLevel: "low" | "medium" | "high" | string;
  blocker: string;
};

export type BackupDryRunItemCard = {
  id: string;
  backupTargetId: string;
  adapterId: string;
  agentName: string;
  action: string;
  targetPath: string;
  backupPath: string;
  status: "ready" | "planned" | "blocked" | "skipped" | string;
  riskLevel: "low" | "medium" | "high" | string;
  summary: string;
};

export type RestoreDryRunItemCard = {
  id: string;
  backupTargetId: string;
  adapterId: string;
  agentName: string;
  action: string;
  targetPath: string;
  backupPath: string;
  status: "ready" | "planned" | "blocked" | "skipped" | string;
  riskLevel: "low" | "medium" | "high" | string;
  summary: string;
};

export type RollbackPlanStepCard = {
  id: string;
  snapshotId: string;
  stepOrder: number;
  title: string;
  riskLevel: "low" | "medium" | "high" | string;
  status: "ready" | "planned" | "locked" | string;
  summary: string;
};

export type ReleaseReportCard = {
  id: string;
  title: string;
  reportType: string;
  status: "ok" | "warn" | "error" | "missing" | string;
  generatedAt: string;
  version: string;
  ok: boolean;
  total: number;
  passed: number;
  warn: number;
  error: number;
  summary: string;
};

export type ImportPreviewCard = {
  id: string;
  title: string;
  importKind: "github" | "local" | "zip" | string;
  status: "ready" | "empty" | "missing" | "blocked" | "ok" | "warn" | "error" | string;
  summary: string;
  detail: string;
  skillCount: number;
  promptCount: number;
  safeToContinue: boolean;
};

export type SourceImportPlanCard = {
  id: string;
  importKind: "github" | "local" | "zip" | string;
  input: string;
  normalizedTarget: string;
  targetRoot: string;
  targetPath: string;
  backupPath: string;
  displayName: string;
  status: "ready" | "warn" | "blocked" | "locked" | string;
  riskLevel: "low" | "medium" | "high" | string;
  writeGateStatus: "dry-run-ready" | "locked" | "blocked" | string;
  safeToContinue: boolean;
  duplicateSourceId: string;
  duplicateReason: string;
  skillCount: number;
  promptCount: number;
  plannedSteps: string[];
  installPlanSteps: string[];
  blockingChecks: string[];
  rollbackSummary: string;
};

export type SourceImportExecutionCard = {
  id: string;
  importKind: "github" | "local" | "zip" | string;
  input: string;
  status: "staged" | "warn" | "blocked" | "locked" | string;
  riskLevel: "low" | "medium" | "high" | string;
  summary: string;
  stagedPath: string;
  reportPath: string;
  manifestPath: string;
  copiedFiles: number;
  copiedBytes: number;
  skillCount: number;
  promptCount: number;
  blockingChecks: string[];
  rollbackSteps: string[];
  realWriteScope: string;
  downloadMethod: string;
  securityStatus: "not-run" | "passed" | "review" | "warn" | "blocked" | string;
  securityScannedFiles: number;
  securityFindings: SourceSecurityFindingCard[];
};

export type SourceSecurityFindingCard = {
  id: string;
  severity: "low" | "medium" | "high" | string;
  category: string;
  relativePath: string;
  line: number;
  summary: string;
  evidence: string;
};

export type SourceImportPromotionCard = {
  id: string;
  importKind: "github" | "local" | "zip" | string;
  sourceName: string;
  status: "promoted" | "already-managed" | "blocked" | string;
  riskLevel: "low" | "medium" | "high" | string;
  summary: string;
  stagedPath: string;
  targetPath: string;
  reportPath: string;
  manifestPath: string;
  copiedFiles: number;
  copiedBytes: number;
  skillCount: number;
  promptCount: number;
  blockingChecks: string[];
  rollbackSteps: string[];
  realWriteScope: string;
  securityStatus: "not-run" | "passed" | "review" | "warn" | "blocked" | string;
  securityScannedFiles: number;
  securityFindings: SourceSecurityFindingCard[];
  securityReviewConfirmed: boolean;
};

export type SourcePopularityCard = {
  sourceId: string;
  sourceName: string;
  url: string;
  owner: string;
  repo: string;
  createdAt: string;
  stars: number;
  forks: number;
  openIssues: number;
  lastUpdatedAt: string;
  fetchedAt: string;
  cacheStatus: "fresh" | "stale" | "missing" | "deferred" | "error" | string;
  error: string;
  localTotalCount: number;
  localSevenDayCount: number;
  localThirtyDayCount: number;
  trendPoints: SourcePopularityTrendPointCard[];
};

export type SourcePopularityTrendPointCard = {
  sampledAt: string;
  stars: number;
  forks: number;
  openIssues: number;
  lastUpdatedAt: string;
  cacheStatus: "fresh" | "stale" | "missing" | "deferred" | "error" | string;
};

export type OperatorConsentCard = {
  realWritesEnabled: boolean;
  enabledAt: string;
  updatedAt: string;
  summary: string;
};

export type DesktopQaCheckCard = {
  id: string;
  title: string;
  description: string;
  status: "pending" | "passed" | "failed" | string;
  required: boolean;
  evidence: string;
  updatedAt: string;
};

export type UsageStatCard = {
  targetType: string;
  targetId: string;
  targetName: string;
  sourceName: string;
  totalCount: number;
  sevenDayCount: number;
  thirtyDayCount: number;
  lastUsedAt: string;
};

export type AuditEventCard = {
  id: string;
  eventType: string;
  summary: string;
  detailJson: string;
  createdAt: string;
};

export type DiagnosticSummary = {
  available: boolean;
  appVersion: string;
  generatedAt: string;
  overallStatus: string;
  ok: number;
  warn: number;
  error: number;
  info: number;
};

export type IndexReport = {
  persisted: boolean;
  databaseFile: string;
  indexedAt: string;
  sourcesIndexed: number;
  skillsIndexed: number;
  agentsIndexed: number;
  snapshotId: string;
};

/* ===================== v3.3 Skills delivery contract =====================
   Canonical: docs/v3.3/skills-contract.md §4.3. Rust DTOs mirror these 1:1. */

export type AgentId =
  | "claude" | "codex" | "coze" | "antigravity" | "workbuddy" | "cursor" | "gemini-cli"
  | "opencode" | "github-copilot" | "windsurf" | "kiro" | "hermes" | "openclaw" | "amp";

/* ---------- errors (S1-9) ---------- */
export type SkillHubErrorCode =
  | "WRITE_BUSY" | "DELIVERY_PAUSED" | "ONBOARDING_REQUIRED"
  | "AGENT_UNKNOWN" | "AGENT_UNSUPPORTED" | "AGENT_NOT_INSTALLED" | "AGENT_NOT_TAKEN_OVER"
  | "AGENT_DIR_EXTERNAL_LINK" | "AGENT_DIR_NOT_WRITABLE"
  | "TARGET_CONFLICT" | "MANIFEST_INVALID" | "DELIVERY_VERIFY_FAILED" | "DELIVERY_POLICY_INVALID"
  | "SCRIPT_FAILED" | "SCRIPT_TIMEOUT" | "SCRIPT_MISSING"
  | "UNIT_NOT_FOUND" | "SOURCE_LIBRARY_ONLY" | "SECURITY_REVIEW_REQUIRED" | "SECURITY_BLOCKED"
  | "INPUT_EMPTY" | "INPUT_UNRECOGNIZED" | "INPUT_IS_MCP_CONFIG" | "INPUT_TOO_LONG"
  | "PATH_NOT_FOUND" | "PATH_NOT_ABSOLUTE" | "ZIP_INVALID"
  | "GITHUB_NOT_FOUND" | "GITHUB_RENAMED" | "GITHUB_REF_NOT_FOUND" | "GITHUB_SUBPATH_NOT_FOUND"
  | "NETWORK_FAILED" | "DOWNLOAD_TIMEOUT" | "GIT_MISSING"
  | "NO_SKILLS_FOUND" | "PROBE_EXPIRED" | "PROBE_STALE" | "DUPLICATE_SOURCE" | "CANCELLED"
  | "INDEX_FAILED" | "INTERNAL";

export type ErrorActionKind =
  | "retry" | "open-folder" | "reinstall" | "export-report" | "takeover-agent" | "review-security"
  | "resolve-conflict" | "open-settings" | "install-git" | "refresh" | "wait" | "open-mcp-add" | "open-existing";

/** The label is localized by the frontend: t(`err.action.${kind}`). */
export type ErrorAction = { kind: ErrorActionKind; payload: Record<string, string> };

export type SkillHubError = {
  code: SkillHubErrorCode;
  /** Backend plain-language fallback (zh). The UI prefers t(`err.${code}`, …) when that key exists. */
  message: string;
  /** Optional technical summary, at most 400 chars, redacted. Shown only under a "详情" disclosure. */
  detail: string;
  action: ErrorAction | null;
  agentId: string | null;
  sourceId: string | null;
  path: string | null;
};

/* ---------- AI tools ---------- */
export type AgentStatusWord = "taken-over" | "available" | "unsupported" | "not-installed";
export type AgentHealth = "ok" | "busy" | "problem" | "off";

export type AgentSkillCounts = {
  /** Units whose target status is "synced" for this tool. */
  packsSynced: number;
  /** Callable skills inside those units (same rule as countSkills, §4.6). */
  skillsSynced: number;
  /** Units with desired = true. */
  packsWanted: number;
  /** Targets in error | conflict | orphan. */
  problems: number;
  /** Unmanaged skills seen in the tool's folder at the last inventory; null = never scanned. */
  personal: number | null;
};

export type SkillAgent = {
  id: AgentId;
  /** Short plain name: "Claude Code", "Codex", "扣子", "Antigravity", "WorkBuddy", "Cursor", "Gemini CLI", … */
  name: string;
  vendor: string;
  installed: boolean;
  canDeliver: boolean;
  experimental: boolean;
  experimentalReason: string;
  unsupportedReason: string;
  takeover: boolean;
  statusWord: AgentStatusWord;
  health: AgentHealth;
  /** Absolute path; "" when unknown. The UI may display the home folder as "~". */
  skillsPath: string;
  /** ["coze"] on codex and ["codex"] on coze while they share ~/.agents/skills (I-9). */
  linkedAgentIds: AgentId[];
  /** "与 Codex 共用目录" / "与 扣子 共用目录" or "". */
  sharedFolderNote: string;
  /** Plain next step after syncing, e.g. "新开一个 Claude Code 会话后生效"; "" if none. */
  afterSyncHint: string;
  counts: AgentSkillCounts;
  lastResult: AgentDeliveryResult | null;
  /** AgentDoctorCard.verdict passthrough for the 诊断 tab. */
  doctorVerdict: string;
};

/* ---------- units & targets ---------- */
export type DeliveryUnitKind = "source" | "standalone";
export type LibraryOnlyReason =
  | "" | "security-review" | "disabled-by-user" | "no-enabled-skills" | "prompt-only" | "invalid-manifest";

export type DeliveryUnit = {
  /** sources.id, or "standalone:" + skills.id */
  unitId: string;
  kind: DeliveryUnitKind;
  sourceId: string;
  skillId: string;
  /** Folder name created in each AI tool (the parent entry, or the single skill). */
  entryName: string;
  callableSkills: number;
  libraryEnabled: boolean;
  libraryOnlyReason: LibraryOnlyReason;
};

export type SkillTargetStatus =
  | "synced" | "off" | "pending" | "removing" | "paused"
  | "conflict" | "error" | "orphan" | "blocked" | "takeover-off" | "unsupported";

export type SkillTargetConflict = {
  kind: "personal-folder" | "external-link" | "not-a-folder";
  /** The existing SKILL.md bytes equal ours. */
  sameContent: boolean;
  path: string;
};

export type SkillTarget = {
  unitId: string;
  agentId: AgentId;
  desired: boolean;
  status: SkillTargetStatus;
  mode: "link" | "shared-real" | "none";
  entryName: string;
  targetPath: string;
  contentHash: string;
  verifiedAt: string;
  updatedAt: string;
  error: SkillHubError | null;
  conflict: SkillTargetConflict | null;
};
export type SkillTargetKey = { unitId: string; agentId: AgentId };

export type DeliveryProblem = {
  id: string;
  code: SkillHubErrorCode;
  message: string;
  agentId: AgentId | null;
  unitId: string | null;
  action: ErrorAction | null;
};

/* ---------- delivery jobs ---------- */
export type DeliveryJobPhase = "queued" | "waiting" | "running" | "done" | "failed" | "paused";
export type DeliveryDepth = "verify" | "links" | "full";
export type AgentDeliveryOutcome =
  | "ok" | "partial" | "failed" | "skipped" | "paused" | "released" | "not-installed";

export type AgentDeliveryResult = {
  agentId: AgentId;
  outcome: AgentDeliveryOutcome;
  linked: number;
  removed: number;
  unchanged: number;
  conflicts: number;
  errors: number;
  error: SkillHubError | null;
  finishedAt: string;
};

export type DeliveryJobStatus = {
  jobId: number;
  phase: DeliveryJobPhase;
  depth: DeliveryDepth;
  /** Diagnostics only, e.g. "target", "child-skill", "startup". Never rendered as UI copy. */
  reasons: string[];
  queuedAt: string;
  startedAt: string;
  finishedAt: string;
  /** Plain label of the operation holding the write lock while phase = "waiting"; "" otherwise. */
  waitingFor: string;
  agents: AgentDeliveryResult[];
  changedTargets: SkillTargetKey[];
  /** True when library content or the index changed: reload the snapshot in the background. */
  snapshotStale: boolean;
  error: SkillHubError | null;
};
export type DeliveryJobTicket = { jobId: number; phase: DeliveryJobPhase; coalesced: boolean };

export type OnboardingStatus = "pending" | "completed";

/**
 * Agents are sorted: taken-over → available → unsupported → not-installed, then catalog order.
 * targets contains exactly one entry for every (unit × agent) where agent.canDeliver and
 * (agent.takeover || a SkillHub entry exists on disk). Pairs without a DB row appear as desired=false, status "off".
 */
export type SkillDeliveryState = {
  paused: boolean;
  onboarding: OnboardingStatus;
  agents: SkillAgent[];
  units: DeliveryUnit[];
  targets: SkillTarget[];
  problems: DeliveryProblem[];
  /** Running job, or the last finished one; null before the first job of this app run. */
  job: DeliveryJobStatus | null;
  generatedAt: string;
};
export type SkillAgentList = Pick<SkillDeliveryState, "agents" | "paused" | "onboarding" | "generatedAt">;

/* ---------- mutations ---------- */
export type TargetChange = { unitId: string; agentId: AgentId; enabled: boolean };
export type TargetRejection = { unitId: string; agentId: AgentId; error: SkillHubError };
export type TargetMutationResult = {
  /** Affected targets with their new status (pending | removing | paused | blocked …), never "synced" optimistically. */
  targets: SkillTarget[];
  /** Number of rows whose desired state really changed. */
  changed: number;
  unchanged: number;
  rejected: TargetRejection[];
  jobId: number | null;
};
export type TakeoverResult = {
  agents: SkillAgent[];
  linkedAgentIds: AgentId[];
  targetsCreated: number;
  jobId: number | null;
};
export type DeliveryControlState = { paused: boolean; onboarding: OnboardingStatus; jobId: number | null };
export type ChildSkillToggleResult = { skill: SkillCard; unit: DeliveryUnit | null; jobId: number | null };
export type SourceLibraryResult = {
  source: SourceCard;
  unit: DeliveryUnit;
  targets: SkillTarget[];
  jobId: number | null;
};

/* ---------- onboarding (S1-8) ---------- */
export type OnboardingAgent = {
  agentId: AgentId;
  name: string;
  statusWord: AgentStatusWord;
  canDeliver: boolean;
  experimental: boolean;
  /** installed && canDeliver && !experimental */
  preselected: boolean;
  /** Plain reason when not preselectable ("还不支持同步技能", "实验性", …). */
  reason: string;
};
export type OnboardingState = {
  status: OnboardingStatus;
  agents: OnboardingAgent[];
  /** null when the scan failed; the checkbox is then hidden. */
  existingSkills: {
    importable: number;
    alreadyManaged: number;
    duplicates: number;
    byAgent: Array<{ agentId: string; count: number }>;
  } | null;
};
export type OnboardingResult = {
  status: OnboardingStatus;
  agents: SkillAgent[];
  adopt: AdoptReport | null;
  jobId: number | null;
};

/* ---------- one-box source input, probe, install (S0-2) ---------- */
export type SkillSourceKind = "github" | "local-folder" | "zip" | "mcp-config" | "unknown";
export type ParsedGithubSource = {
  owner: string;
  repo: string;
  /** "" = default branch */
  ref: string;
  /** "" = whole repository; POSIX relative, no "..". */
  subpath: string;
  cloneUrl: string;
  webUrl: string;
};
export type ParsedSkillSource = {
  input: string;
  kind: SkillSourceKind;
  routeTo: "skills" | "mcp" | "invalid";
  /** e.g. "anthropics/skills · skills/pdf" */
  display: string;
  github: ParsedGithubSource | null;
  localPath: string;
  error: SkillHubError | null;
};

export type ProbeSkillNode = {
  /** Directory of SKILL.md, relative to the probed root, POSIX. */
  path: string;
  name: string;
  description: string;
  valid: boolean;
  invalidReason: string;
  /** A skill with the same name and content hash is already in the library. */
  inLibrary: boolean;
};
export type ProbeSkillGroup = {
  groupId: string;
  title: string;
  /** Set when the upstream repo ships its own parent/umbrella SKILL.md for this group. */
  parent: ProbeSkillNode | null;
  children: ProbeSkillNode[];
};
export type ProbeSecurity = {
  status: "passed" | "review" | "blocked";
  scannedFiles: number;
  findingCount: number;
  /** At most 8, most severe first. */
  findings: SourceSecurityFindingCard[];
  /** e.g. "检查了 312 个文件，发现 2 处需要注意（不会被执行）". */
  plainSummary: string;
  /** false for structural blocks. */
  canAddToLibrary: boolean;
  /** false whenever status !== "passed" (I-5). */
  canSyncToAgents: boolean;
};
export type ProbeAgentChip = {
  agentId: AgentId;
  name: string;
  preselected: boolean;
  disabled: boolean;
  disabledReason: string;
  experimental: boolean;
};
export type ProbeDuplicate = {
  sourceId: string;
  name: string;
  relation: "same" | "subset-of-existing" | "extends-existing";
};
export type SkillSourceProbe = {
  probeId: string;
  operationId: string;
  parsed: ParsedSkillSource;
  displayName: string;
  owner: string;
  sourceType: "skill" | "prompt" | "mixed";
  skillGroups: ProbeSkillGroup[];
  skillCount: number;
  promptDocs: Array<{ relativePath: string; title: string }>;
  /** Static detection only, nothing executed. Hand off to the MCP add flow (MCP contract). */
  mcpConfigs: Array<{ relativePath: string; format: "json" | "toml" | "readme-snippet"; serverNames: string[] }>;
  security: ProbeSecurity;
  /** One chip per deliverable, installed agent; preselected = takeover && !experimental. */
  agentChips: ProbeAgentChip[];
  duplicate: ProbeDuplicate | null;
  downloadMethod: "git" | "zip" | "copy" | "index";
  /** The staging copy is deleted after this time (30 min) or on discard. */
  expiresAt: string;
  warnings: string[];
};
export type InstallSkillSourceRequest = {
  probeId: string;
  /** Empty = all valid skills. Unselected valid children are imported but child-disabled. */
  selectedSkillPaths: string[];
  /** May be empty (= library only). Ignored and forced empty when security.status !== "passed". */
  agentIds: AgentId[];
  /** Must be true when security.status === "review"; the result is then library-only (I-5). */
  securityReviewConfirmed: boolean;
  displayName: string | null;
  folderId: string | null;
  newFolderName: string | null;
  categoryId: string | null;
  tags: string[];
  note: string | null;
};
export type InstallSkillSourceResult = {
  outcome: "installed" | "library-only" | "updated-existing" | "prompt-library";
  source: SourceCard;
  unit: DeliveryUnit | null;
  targets: SkillTarget[];
  disabledSkills: string[];
  jobId: number | null;
  snapshotStale: boolean;
  summary: string;
};
export type ProbeFileText = { relativePath: string; text: string; truncated: boolean };
export type SkillSourceDroppedEvent = { paths: string[] };

/* ---------- adopt existing skills (S0-11) ---------- */
export type AdoptCandidateState =
  | "new" | "already-managed" | "duplicate" | "name-clash" | "invalid-manifest" | "unreadable";
export type AdoptCandidate = {
  /** stable_id("adopt", canonicalPath) */
  id: string;
  name: string;
  description: string;
  state: AdoptCandidateState;
  /** true only for state "new" */
  selectedByDefault: boolean;
  canonicalPath: string;
  contentHash: string;
  agentIds: string[];
  locations: Array<{ agentId: string; path: string; storageKind: "directory" | "link" }>;
  /** Candidate id this one duplicates, "" otherwise. */
  duplicateOf: string;
  /** Unit that already holds the same content, "" otherwise. */
  managedUnitId: string;
};
export type AdoptPreview = {
  candidates: AdoptCandidate[];
  importable: number;
  alreadyManaged: number;
  duplicates: number;
  warnings: string[];
  truncated: boolean;
  scannedAt: string;
};
export type AdoptItemResult = {
  candidateId: string;
  name: string;
  outcome: "adopted" | "library-only" | "skipped-duplicate" | "skipped-managed" | "failed";
  sourceId: string;
  error: SkillHubError | null;
};
export type AdoptReport = {
  results: AdoptItemResult[];
  adopted: number;
  libraryOnly: number;
  skipped: number;
  failed: number;
  jobId: number | null;
  snapshotStale: boolean;
};

/* ---------- per-tool inventory, documents, report ---------- */
export type AgentSkillEntryState = "managed" | "personal" | "stale" | "conflict" | "invalid";
export type AgentSkillEntry = {
  name: string;
  description: string;
  path: string;
  storageKind: "directory" | "link";
  state: AgentSkillEntryState;
  unitId: string;
  adoptCandidateId: string;
};
export type AgentSkillInventory = {
  agentId: AgentId;
  skillsPath: string;
  entries: AgentSkillEntry[];
  warnings: string[];
  scannedAt: string;
};
export type LibrarySkillDocument = { skillId: string; path: string; content: string; truncated: boolean; files: string[] };
export type TroubleshootingReport = { reportPath: string; folderPath: string; generatedAt: string };
