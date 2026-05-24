export type NavKey = "dashboard" | "library" | "sources" | "agents" | "settings";

export type LegacySnapshot = {
  root: string;
  skillsDir: string;
  sourcesDir: string;
  diagnosticsFile: string;
  mode: "read-only";
  summary: LegacySummary;
  skills: SkillCard[];
  sources: SourceCard[];
  agents: AgentCard[];
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
  source: string;
  health: "ok" | "warn" | "error" | "info";
  enabled: boolean;
  relativePath: string;
};

export type SourceCard = {
  name: string;
  sourceType: "skill" | "prompt" | "mixed";
  health: "ok" | "warn" | "error" | "info";
  url: string;
  skillCount: number;
  mode: string;
  categoryId: string;
  note: string;
  localPath: string;
};

export type AgentCard = {
  id: string;
  name: string;
  path: string;
  detected: boolean;
  managed: boolean;
  skillCount: number;
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
