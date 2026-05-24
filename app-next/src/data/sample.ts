import type { AgentCard, SkillCard, SourceCard } from "../types";

export const skills: SkillCard[] = [
  {
    name: "academic-paper",
    category: "论文科研",
    description: "Academic writing workflow with planning, drafting, and revision stages.",
    source: "academic-research-skills",
    health: "ok",
    enabled: true
  },
  {
    name: "figure-planner",
    category: "科研图表",
    description: "Plan scientific figures before drawing or polishing them.",
    source: "Nature-Paper-Skills",
    health: "ok",
    enabled: true
  },
  {
    name: "impeccable",
    category: "界面设计",
    description: "Design review and UI polish guidance.",
    source: "impeccable",
    health: "info",
    enabled: true
  }
];

export const sources: SourceCard[] = [
  {
    name: "Nature-Paper-Skills",
    type: "skill",
    health: "ok",
    url: "https://github.com/Boom5426/Nature-Paper-Skills.git",
    skillCount: 32
  },
  {
    name: "awesome-ai-research-writing",
    type: "prompt",
    health: "info",
    url: "https://github.com/Leey21/awesome-ai-research-writing.git",
    skillCount: 0
  }
];

export const agents: AgentCard[] = [
  {
    name: "Claude Code",
    path: "~/.claude/skills",
    detected: true,
    managed: true,
    skillCount: 269
  },
  {
    name: "Codex",
    path: "~/.codex/skills",
    detected: true,
    managed: true,
    skillCount: 269
  },
  {
    name: "Antigravity",
    path: "~/.gemini/antigravity/skills",
    detected: true,
    managed: true,
    skillCount: 269
  }
];
