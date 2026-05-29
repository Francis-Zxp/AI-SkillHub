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
  displayName: string;
  status: "ready" | "warn" | "blocked" | "locked" | string;
  riskLevel: "low" | "medium" | "high" | string;
  safeToContinue: boolean;
  duplicateSourceId: string;
  duplicateReason: string;
  skillCount: number;
  promptCount: number;
  plannedSteps: string[];
  rollbackSummary: string;
};

export type SourcePopularityCard = {
  sourceId: string;
  sourceName: string;
  url: string;
  owner: string;
  repo: string;
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
