export type NavKey =
  | "dashboard"
  | "library"
  | "workspaces"
  | "presets"
  | "sources"
  | "agents"
  | "snapshots"
  | "release"
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
  agentAdapters: AgentAdapterCard[];
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
  operatorConsent: OperatorConsentCard;
  tags: TagCard[];
  presetDistributions: PresetDistributionCard[];
  operationRunners: OperationRunnerCard[];
  writeGates: WriteGateCard[];
  desktopQaChecks: DesktopQaCheckCard[];
  usageStats: UsageStatCard[];
  auditEvents: AuditEventCard[];
  diagnostics: DiagnosticSummary;
  index: IndexReport;
};

export type LegacySummary = {
  skills: number;
  sources: number;
  prompts: number;
  agentsDetected: number;
  warnings: number;
  diagnosticsStatus: string;
};

export type SkillCard = {
  name: string;
  folderName: string;
  category: string;
  description: string;
  note: string;
  source: string;
  health: "ok" | "warn" | "error" | "info";
  enabled: boolean;
  relativePath: string;
  tags: string[];
  /**
   * Backend-computed marker for parent / router-hub Skills.
   * True when SKILL.md description contains the [ROUTER-HUB] marker,
   * the file lives under app/github_sources/AI-SkillHub-local-routers,
   * or the skill name matches its source collection name.
   * Optional during the rollout window; older SQLite snapshots may omit it.
   */
  isRouterHub?: boolean;
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
  tags: string[];
  createdAt: string;
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
  cacheStatus: "fresh" | "stale" | "missing" | "error" | string;
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
  cacheStatus: "fresh" | "stale" | "missing" | "error" | string;
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
