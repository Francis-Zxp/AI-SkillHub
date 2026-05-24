export type NavKey = "dashboard" | "library" | "sources" | "agents" | "settings";

export type SkillCard = {
  name: string;
  category: string;
  description: string;
  source: string;
  health: "ok" | "warn" | "error" | "info";
  enabled: boolean;
};

export type SourceCard = {
  name: string;
  type: "skill" | "prompt" | "mixed";
  health: "ok" | "warn" | "error" | "info";
  url: string;
  skillCount: number;
};

export type AgentCard = {
  name: string;
  path: string;
  detected: boolean;
  managed: boolean;
  skillCount: number;
};
