/* Browser-preview fixtures and simulators.
   Only used when the Tauri runtime is unavailable; the desktop app reads real SQLite. */

import type {
  LegacySnapshot,
  SourceCard,
  SourceImportExecutionCard,
  SourceImportPlanCard,
  SourceImportPromotionCard
} from "./types";

export function normalizePreviewGithubUrl(input: string): string {
  const value = input
    .trim()
    .replace(/^git@github\.com:/i, "https://github.com/")
    .replace(/^ssh:\/\/git@github\.com\//i, "https://github.com/");
  const match = value.match(/^https?:\/\/github\.com\/([^/\s]+)\/([^/\s?#]+?)(?:\.git)?(?:[?#].*)?$/i);
  if (!match) return "";
  return `https://github.com/${match[1]}/${match[2].replace(/\.git$/i, "")}.git`.toLowerCase();
}

export function createPreviewSourceImportPlan(
  importKind: string,
  input: string,
  sources: SourceCard[]
): SourceImportPlanCard {
  const value = input.trim();
  const displayName =
    value
      .split(/[\\/]/)
      .filter(Boolean)
      .pop()
      ?.replace(/\.git$/i, "")
      .replace(/\.(zip|skill)$/i, "") || "未命名来源";
  const normalizedGithub = normalizePreviewGithubUrl(value);
  const normalizedTarget = importKind === "github" ? normalizedGithub : value;
  const duplicate = sources.find(source => {
    if (importKind === "github") {
      return normalizePreviewGithubUrl(source.url) === normalizedGithub;
    }
    return (source.localPath || source.url || "").trim().toLowerCase() === value.toLowerCase();
  });
  const isGithubValid = importKind !== "github" || Boolean(normalizedGithub);
  const isPackage = importKind === "zip";
  const safeToContinue = Boolean(value && isGithubValid && !duplicate && !isPackage);
  const status = duplicate || !isGithubValid ? "blocked" : isPackage ? "locked" : safeToContinue ? "ready" : "warn";
  const targetRoot = "浏览器预览/app/github_sources";
  const targetPath = `${targetRoot}/${displayName}`;
  const backupPath = `浏览器预览/app-next/.skillhub-next/backups/source-imports/${displayName}`;
  const blockingChecks = [
    duplicate ? `重复来源：${duplicate.name}` : "",
    !isGithubValid ? "GitHub 地址格式不符合普通仓库地址。" : "",
    isPackage ? "zip/.skill 必须先通过解压安全扫描。" : "",
    "未开启真实写入授权时，只会刷新 AI SkillHub 索引，不会写入 AI 工具目录。"
  ].filter((check): check is string => Boolean(check));

  return {
    id: `preview-${importKind}-${displayName}`,
    importKind,
    input: value,
    normalizedTarget,
    targetRoot,
    targetPath,
    backupPath,
    displayName,
    status,
    riskLevel: duplicate || !isGithubValid ? "high" : isPackage ? "medium" : "low",
    writeGateStatus: safeToContinue ? "dry-run-ready" : isPackage ? "locked" : "blocked",
    safeToContinue,
    duplicateSourceId: duplicate?.id ?? "",
    duplicateReason: duplicate
      ? `已存在同一来源：${duplicate.name}。真实导入前必须合并或改名。`
      : !isGithubValid
        ? "GitHub 地址格式不符合普通仓库地址。"
        : isPackage
          ? "zip/.skill 仍需要解压安全扫描，当前只允许生成计划。"
          : "",
    skillCount: 0,
    promptCount: 0,
    plannedSteps:
      importKind === "github"
        ? [
            "校验 GitHub 普通仓库地址。",
            "检查本地 SQLite 是否已有同源仓库。",
            "生成快照后 clone/pull 到 github_sources。",
            "扫描 SKILL.md，只把有效 Skill 进入候选库。"
          ]
        : importKind === "local"
          ? [
              "检查本地路径是否可访问。",
              "递归扫描 SKILL.md，并跳过 target/node_modules/.git 等目录。",
              "检查重复来源和重复 Skill 名称。",
              "生成快照和回滚计划后登记为来源。"
            ]
          : [
              "验证 zip/.skill 文件扩展名。",
              "先做 zip-slip 与路径穿越扫描。",
              "解压到临时目录后统计 SKILL.md。",
              "解压安全报告通过后才允许登记为来源。"
            ],
    installPlanSteps:
      importKind === "github"
        ? [
            "创建来源导入快照。",
            "如果目标目录已存在，先备份到 source-imports。",
            "clone 或 pull 到 github_sources 的隔离目录。",
            "重新扫描 SKILL.md 并更新本地 SQLite 来源记录。"
          ]
        : importKind === "local"
          ? [
              "创建来源导入快照。",
              "把本地来源登记为可管理候选，不直接修改原目录。",
              "按有效 SKILL.md 目录生成候选索引。",
              "更新本地 SQLite 来源记录。"
            ]
          : [
              "创建临时解压目录。",
              "先执行路径穿越和重复名称扫描。",
              "安全通过后生成导入快照和备份计划。",
              "解压进入隔离来源目录并重新扫描。"
            ],
    blockingChecks,
    rollbackSummary: "当前只生成 dry-run；没有写入任何文件，因此不需要执行回滚。"
  };
}

export function createPreviewSourceImportExecution(importKind: string, input: string): SourceImportExecutionCard {
  const value = input.trim();
  const displayName =
    value
      .split(/[\\/]/)
      .filter(Boolean)
      .pop()
      ?.replace(/\.git$/i, "")
      .replace(/\.(zip|skill)$/i, "") || "preview-source";
  const isLockedPackage = importKind === "zip";
  return {
    id: `preview-stage-${Date.now()}`,
    importKind,
    input: value,
    status: isLockedPackage ? "locked" : "staged",
    riskLevel: isLockedPackage ? "medium" : "low",
    summary: isLockedPackage
      ? "浏览器预览：zip/.skill staging 仍锁定。"
      : "浏览器预览：已模拟写入隔离 staging，桌面版才会真实创建 staging 文件夹。",
    stagedPath: `浏览器预览/app-next/.skillhub-next/staging/source-imports/${displayName}`,
    reportPath: `浏览器预览/app-next/.skillhub-next/reports/source-import-staging/${displayName}.md`,
    manifestPath: `浏览器预览/app-next/.skillhub-next/reports/source-import-staging/${displayName}-manifest.json`,
    copiedFiles: isLockedPackage ? 0 : 12,
    copiedBytes: isLockedPackage ? 0 : 48 * 1024,
    skillCount: isLockedPackage ? 0 : 1,
    promptCount: 0,
    blockingChecks: ["浏览器预览不执行本机文件写入。", "正式 app/github_sources 安装仍锁定。"],
    rollbackSteps: ["删除 staging 目录即可撤销。", "正式来源目录和 AI 工具目录保持不变。"],
    realWriteScope: "preview-only"
  };
}

export function createPreviewSourceImportPromotion(
  importKind: string,
  stagedPath: string,
  sourceName: string
): SourceImportPromotionCard {
  const safeName =
    (sourceName || "preview-source")
      .trim()
      .replace(/[^\p{L}\p{N}._-]+/gu, "-")
      .replace(/^-+|-+$/g, "") || "preview-source";
  return {
    id: `preview-promotion-${Date.now()}`,
    importKind,
    sourceName: safeName,
    status: "promoted",
    riskLevel: importKind === "github" ? "medium" : "low",
    summary: "浏览器预览：已模拟提升为受管理来源；桌面版才会写入 app/github_sources。",
    stagedPath,
    targetPath: `浏览器预览/app/github_sources/${safeName}`,
    reportPath: `浏览器预览/app-next/.skillhub-next/reports/source-import-promotion/${safeName}.md`,
    manifestPath: `浏览器预览/app-next/.skillhub-next/reports/source-import-promotion/${safeName}-manifest.json`,
    copiedFiles: 12,
    copiedBytes: 48 * 1024,
    skillCount: 1,
    promptCount: 0,
    blockingChecks: ["浏览器预览不执行本机文件写入。", "AI 工具同步/接管仍锁定。"],
    rollbackSteps: ["删除受管理来源目录即可回滚。", "重新扫描本地 SQLite 索引。"],
    realWriteScope: "preview-only"
  };
}

export function createPreviewSnapshot(): LegacySnapshot {
  return {
    root: "浏览器预览模式",
    skillsDir: "../skills",
    sourcesDir: "../app/github_sources",
    diagnosticsFile: "../app/reports/latest-diagnostics.json",
    mode: "browser-preview",
    summary: {
      skills: 48,
      sources: 9,
      prompts: 2,
      agentsDetected: 3,
      warnings: 1,
      diagnosticsStatus: "preview"
    },
    skills: [
      {
        name: "paper-workflow",
        folderName: "paper-workflow",
        category: "academic-writing",
        description: "判断当前论文下一步该进入构思、写作、图表、引用核查还是投稿审计。",
        note: "",
        source: "Nature-Paper-Skills",
        health: "ok",
        enabled: true,
        relativePath: "skills/core/paper-workflow",
        tags: ["论文科研", "写作", "常用"]
      },
      {
        name: "figure-planner",
        folderName: "figure-planner",
        category: "scientific-figures",
        description: "把实验结果拆成清晰的图组、面板顺序和图注结构。",
        note: "",
        source: "Nature-Paper-Skills",
        health: "ok",
        enabled: true,
        relativePath: "skills/core/figure-planner",
        tags: ["科研图表", "论文科研"]
      },
      {
        name: "nature-writing",
        folderName: "nature-writing",
        category: "academic-writing",
        description: "Nature 风格段落与逻辑链写作。",
        note: "",
        source: "Nature-Paper-Skills",
        health: "ok",
        enabled: true,
        relativePath: "skills/core/nature-writing",
        tags: ["论文科研"]
      },
      {
        name: "Nature-Paper-Skills",
        folderName: "Nature-Paper-Skills",
        category: "academic-writing",
        description: "[ROUTER-HUB] Nature 论文技能集合的路由入口。",
        note: "",
        source: "AI-SkillHub-local-routers",
        health: "ok",
        enabled: true,
        relativePath: "AI-SkillHub-local-routers/Nature-Paper-Skills",
        tags: [],
        isRouterHub: true
      },
      {
        name: "impeccable",
        folderName: "impeccable",
        category: "ui-design",
        description: "用于检查界面审美、布局层级、交互细节和视觉一致性。",
        note: "",
        source: "impeccable",
        health: "info",
        enabled: true,
        relativePath: ".claude/skills/impeccable",
        tags: ["界面设计", "UI"]
      },
      {
        name: "VibeSec-Skill",
        folderName: "VibeSec-Skill",
        category: "security-audit",
        description: "扫描脚本、路径、命令和发布边界中的安全风险。",
        note: "",
        source: "VibeSec-Skill",
        health: "warn",
        enabled: true,
        relativePath: "SKILL.md",
        tags: ["安全"]
      },
      {
        name: "gstack",
        folderName: "gstack",
        category: "agent-tools",
        description: "把长期目标拆成可验证、可回退、可持续推进的产品路线。",
        note: "",
        source: "gstack",
        health: "ok",
        enabled: true,
        relativePath: "SKILL.md",
        tags: ["产品规划"]
      },
      {
        name: "karpathy-guidelines",
        folderName: "karpathy-guidelines",
        category: "development",
        description: "保持小步验证、清晰状态和稳定推进的工程开发守则。",
        note: "",
        source: "andrej-karpathy-skills",
        health: "ok",
        enabled: true,
        relativePath: "skills/karpathy-guidelines",
        tags: ["工程质量"]
      }
    ],
    sources: [
      {
        id: "source-nature-paper-skills",
        name: "Nature-Paper-Skills",
        sourceType: "skill",
        health: "ok",
        url: "https://github.com/Boom5426/Nature-Paper-Skills.git",
        skillCount: 18,
        mode: "scan",
        createdAt: "2026-05-01T00:00:00Z",
        categoryId: "academic-writing",
        note: "论文科研工作流。",
        localPath: "../app/github_sources/Nature-Paper-Skills",
        enabled: true,
        tags: ["GitHub", "论文科研", "常用"]
      },
      {
        id: "source-impeccable",
        name: "impeccable",
        sourceType: "skill",
        health: "info",
        url: "https://github.com/pbakaus/impeccable.git",
        skillCount: 1,
        mode: "explicit",
        createdAt: "2026-05-01T00:00:00Z",
        categoryId: "ui-design",
        note: "UI 审美检查来源。",
        localPath: "../app/github_sources/impeccable",
        enabled: true,
        tags: ["GitHub", "界面设计"]
      },
      {
        id: "source-awesome-ai-research-writing",
        name: "awesome-ai-research-writing",
        sourceType: "prompt",
        health: "info",
        url: "https://github.com/Leey21/awesome-ai-research-writing.git",
        skillCount: 0,
        mode: "do-not-install",
        createdAt: "2026-05-01T00:00:00Z",
        categoryId: "prompt-polishing",
        note: "这是润色 Prompt 资料，不作为 Skill 安装。",
        localPath: "../app/github_sources/awesome-ai-research-writing",
        enabled: true,
        tags: ["Prompt", "润色资料"]
      }
    ],
    agents: [
      {
        id: "claude",
        name: "Claude / Claude Code",
        path: "~\\.claude\\skills",
        detected: true,
        managed: true,
        enabled: true,
        skillCount: 48
      },
      {
        id: "codex",
        name: "OpenAI Codex",
        path: "~\\.codex\\skills",
        detected: true,
        managed: false,
        enabled: false,
        skillCount: 0
      },
      {
        id: "antigravity",
        name: "Antigravity",
        path: "~\\.gemini\\antigravity\\skills",
        detected: false,
        managed: false,
        enabled: false,
        skillCount: 0
      }
    ],
    agentSkillStatuses: [
      {
        id: "preview-claude-paper-workflow",
        agentId: "claude",
        agentName: "Claude / Claude Code",
        skillName: "paper-workflow",
        skillFolderName: "paper-workflow",
        status: "installed",
        expectedPath: "~\\.claude\\skills\\paper-workflow",
        targetPath: "../skills/paper-workflow",
        summary: "Claude 已能看到 /paper-workflow。"
      },
      {
        id: "preview-codex-paper-workflow",
        agentId: "codex",
        agentName: "OpenAI Codex",
        skillName: "paper-workflow",
        skillFolderName: "paper-workflow",
        status: "agent-disabled",
        expectedPath: "~\\.codex\\skills\\paper-workflow",
        targetPath: "",
        summary: "Codex 已检测但未启用接管。"
      },
      {
        id: "preview-antigravity-paper-workflow",
        agentId: "antigravity",
        agentName: "Antigravity",
        skillName: "paper-workflow",
        skillFolderName: "paper-workflow",
        status: "agent-missing",
        expectedPath: "~\\.gemini\\antigravity\\skills\\paper-workflow",
        targetPath: "",
        summary: "Antigravity 未检测到，暂不能判断此 Skill。"
      }
    ],
    agentAdapters: [
      {
        id: "claude",
        name: "Claude / Claude Code",
        vendor: "Anthropic",
        skillsPathHint: "~\\.claude\\skills",
        detectionKind: "directory",
        installScope: "global",
        capabilityLevel: "full",
        docsUrl: "",
        status: "ready",
        detected: true,
        managed: true,
        enabled: true
      },
      {
        id: "codex",
        name: "OpenAI Codex",
        vendor: "OpenAI",
        skillsPathHint: "~\\.codex\\skills",
        detectionKind: "directory",
        installScope: "global",
        capabilityLevel: "full",
        docsUrl: "",
        status: "detected-unmanaged",
        detected: true,
        managed: false,
        enabled: false
      },
      {
        id: "antigravity",
        name: "Antigravity",
        vendor: "Google",
        skillsPathHint: "~\\.gemini\\antigravity\\skills",
        detectionKind: "directory",
        installScope: "global",
        capabilityLevel: "planned",
        docsUrl: "",
        status: "not-detected",
        detected: false,
        managed: false,
        enabled: false
      }
    ],
    adapterSafetyChecks: [
      {
        id: "claude-path",
        adapterId: "claude",
        checkKey: "path-writable",
        status: "ok",
        summary: "Claude Skills 目录可写，已由 AI SkillHub 管理。"
      },
      {
        id: "codex-link",
        adapterId: "codex",
        checkKey: "managed-link",
        status: "warn",
        summary: "已检测到 Codex，但尚未接管链接。"
      },
      {
        id: "antigravity-missing",
        adapterId: "antigravity",
        checkKey: "installed",
        status: "info",
        summary: "未检测到 Antigravity，本机可暂不处理。"
      }
    ],
    adapterCapabilities: [
      {
        id: "claude-global",
        adapterId: "claude",
        capabilityKey: "global-scope",
        enabled: true,
        summary: "支持全局 Skills。"
      },
      {
        id: "claude-project",
        adapterId: "claude",
        capabilityKey: "project-scope",
        enabled: true,
        summary: "支持项目级工作区。"
      },
      {
        id: "codex-global",
        adapterId: "codex",
        capabilityKey: "global-scope",
        enabled: true,
        summary: "支持 Codex 全局 Skills。"
      },
      {
        id: "antigravity-copy",
        adapterId: "antigravity",
        capabilityKey: "copy-fallback",
        enabled: false,
        summary: "后续提供复制兜底。"
      }
    ],
    workspaces: [
      {
        id: "global",
        name: "全局技能库",
        scope: "global",
        path: "../skills",
        enabled: true,
        agentCount: 3,
        skillCount: 48
      },
      {
        id: "claude-agent",
        name: "Claude 工作区",
        scope: "agent",
        path: "~\\.claude\\skills",
        enabled: true,
        agentCount: 1,
        skillCount: 48
      },
      {
        id: "app-next",
        name: "AI SkillHub 项目",
        scope: "project",
        path: "../app-next",
        enabled: true,
        agentCount: 2,
        skillCount: 12
      }
    ],
    projectScans: [
      {
        id: "app-next-scan",
        workspaceId: "app-next",
        path: "../app-next",
        hasGit: true,
        hasPackageJson: true,
        hasCargoToml: true,
        hasTauriConfig: true,
        hasAgentsMd: false,
        hasClaudeMd: false,
        hasReadmeMd: true,
        fileCount: 126,
        scannedAt: new Date().toISOString()
      }
    ],
    presets: [
      {
        id: "paper",
        name: "论文科研",
        description: "写作、图表、引用、投稿审计的组合预设。",
        color: "mint",
        enabled: true,
        skillCount: 18,
        workspaceCount: 2
      },
      {
        id: "design",
        name: "界面设计",
        description: "UI 检查、视觉优化和产品体验打磨。",
        color: "peach",
        enabled: true,
        skillCount: 7,
        workspaceCount: 1
      },
      {
        id: "security",
        name: "安全检查",
        description: "命令、路径、发布边界和风险模式扫描。",
        color: "violet",
        enabled: true,
        skillCount: 4,
        workspaceCount: 1
      }
    ],
    snapshots: [
      {
        id: "preview-snapshot",
        name: "浏览器预览快照",
        summary: "48 skills, 9 sources, 3 agents",
        createdAt: new Date().toISOString(),
        isLatest: true
      }
    ],
    backupTargets: [],
    backupDryRun: [
      {
        id: "preview-backup-plan-claude",
        backupTargetId: "preview-backup-claude",
        adapterId: "claude",
        agentName: "Claude / Claude Code",
        action: "copy-to-backup",
        targetPath: "~\\.claude\\skills",
        backupPath: "../app-next/.skillhub-next/backups/claude/skills",
        status: "planned",
        riskLevel: "medium",
        summary: "真实同步前会先检查目标路径边界，再把目标目录复制到备份位置；当前仍只预演。"
      },
      {
        id: "preview-backup-plan-codex",
        backupTargetId: "preview-backup-codex",
        adapterId: "codex",
        agentName: "OpenAI Codex",
        action: "block-backup",
        targetPath: "~\\.codex\\skills",
        backupPath: "../app-next/.skillhub-next/backups/codex/skills",
        status: "blocked",
        riskLevel: "high",
        summary: "当前目标仍被阻断，备份预演只报告原因，不复制任何文件。"
      }
    ],
    restoreDryRun: [
      {
        id: "preview-restore-claude",
        backupTargetId: "preview-backup-claude",
        adapterId: "claude",
        agentName: "Claude / Claude Code",
        action: "prepare-restore",
        targetPath: "~\\.claude\\skills",
        backupPath: "../app-next/.skillhub-next/backups/claude/skills",
        status: "planned",
        riskLevel: "medium",
        summary: "真实同步前会先生成备份；恢复预演会列出从备份位置还原到目标目录的计划。"
      }
    ],
    rollbackPlan: [
      {
        id: "preview-step-1",
        snapshotId: "preview-snapshot",
        stepOrder: 1,
        title: "冻结本地 SQLite 基线",
        riskLevel: "low",
        status: "ready",
        summary: "预览模式已生成示例基线；真实数据请在 Tauri 桌面窗口查看。"
      },
      {
        id: "preview-step-2",
        snapshotId: "preview-snapshot",
        stepOrder: 2,
        title: "备份目标 AI 工具目录",
        riskLevel: "medium",
        status: "planned",
        summary: "真实同步前必须备份 Claude、Codex、Antigravity 等目标目录。"
      },
      {
        id: "preview-step-3",
        snapshotId: "preview-snapshot",
        stepOrder: 3,
        title: "真实回滚执行",
        riskLevel: "high",
        status: "locked",
        summary: "恢复按钮保持锁定，直到备份和 dry-run 通过。"
      }
    ],
    releaseReports: [
      {
        id: "diagnostics",
        title: "诊断包结果",
        reportType: "diagnostics",
        status: "ok",
        generatedAt: new Date().toISOString(),
        version: "v2.0.1",
        ok: true,
        total: 9,
        passed: 6,
        warn: 1,
        error: 0,
        summary: "诊断报告：6 ok / 1 warn / 0 error / 2 info。"
      },
      {
        id: "release-preflight",
        title: "发布预检",
        reportType: "release-preflight",
        status: "ok",
        generatedAt: new Date().toISOString(),
        version: "v2.0.1",
        ok: true,
        total: 12,
        passed: 12,
        warn: 0,
        error: 0,
        summary: "发布预检：12/12 项通过。"
      },
      {
        id: "share-recipient",
        title: "分享验收",
        reportType: "share-recipient-test",
        status: "ok",
        generatedAt: new Date().toISOString(),
        version: "v2.0.1",
        ok: true,
        total: 8,
        passed: 8,
        warn: 2,
        error: 1,
        summary: "分享验收：8/8 个场景按预期通过。"
      },
      {
        id: "zip-preview",
        title: "zip 导入预览",
        reportType: "zip-preview-test",
        status: "ok",
        generatedAt: new Date().toISOString(),
        version: "",
        ok: true,
        total: 4,
        passed: 4,
        warn: 0,
        error: 0,
        summary: "zip 预览：2 个 Skill 可识别；路径穿越防护已通过。"
      }
    ],
    importPreviews: [],
    sourcePopularity: [
      {
        sourceId: "source-nature-paper-skills",
        sourceName: "Nature-Paper-Skills",
        url: "https://github.com/Boom5426/Nature-Paper-Skills.git",
        owner: "Boom5426",
        repo: "Nature-Paper-Skills",
        createdAt: "2025-01-10T00:00:00Z",
        stars: 1280,
        forks: 146,
        openIssues: 3,
        lastUpdatedAt: new Date().toISOString(),
        fetchedAt: new Date().toISOString(),
        cacheStatus: "fresh",
        error: "",
        localTotalCount: 8,
        localSevenDayCount: 3,
        localThirtyDayCount: 8,
        trendPoints: [
          {
            sampledAt: "1717200000000000000",
            stars: 860,
            forks: 91,
            openIssues: 4,
            lastUpdatedAt: "2025-11-01T00:00:00Z",
            cacheStatus: "fresh"
          },
          {
            sampledAt: "1748736000000000000",
            stars: 1120,
            forks: 128,
            openIssues: 2,
            lastUpdatedAt: "2026-03-01T00:00:00Z",
            cacheStatus: "fresh"
          },
          {
            sampledAt: "1780272000000000000",
            stars: 1280,
            forks: 146,
            openIssues: 3,
            lastUpdatedAt: new Date().toISOString(),
            cacheStatus: "fresh"
          }
        ]
      },
      {
        sourceId: "source-impeccable",
        sourceName: "impeccable",
        url: "https://github.com/pbakaus/impeccable.git",
        owner: "pbakaus",
        repo: "impeccable",
        createdAt: "2024-09-12T00:00:00Z",
        stars: 920,
        forks: 88,
        openIssues: 1,
        lastUpdatedAt: new Date().toISOString(),
        fetchedAt: new Date().toISOString(),
        cacheStatus: "fresh",
        error: "",
        localTotalCount: 4,
        localSevenDayCount: 1,
        localThirtyDayCount: 4,
        trendPoints: [
          {
            sampledAt: "1717200000000000000",
            stars: 530,
            forks: 42,
            openIssues: 2,
            lastUpdatedAt: "2025-10-01T00:00:00Z",
            cacheStatus: "fresh"
          },
          {
            sampledAt: "1748736000000000000",
            stars: 790,
            forks: 66,
            openIssues: 1,
            lastUpdatedAt: "2026-02-01T00:00:00Z",
            cacheStatus: "fresh"
          },
          {
            sampledAt: "1780272000000000000",
            stars: 920,
            forks: 88,
            openIssues: 1,
            lastUpdatedAt: new Date().toISOString(),
            cacheStatus: "fresh"
          }
        ]
      }
    ],
    skillConflicts: [
      {
        conflictKey: "figure-planner",
        childName: "figure-planner",
        status: "unresolved",
        defaultSkillId: "",
        defaultSourceName: "",
        updatedAt: "",
        choices: [
          {
            skillId: "Nature-Paper-Skills/skills/core/figure-planner",
            skillName: "figure-planner",
            folderName: "figure-planner",
            sourceName: "Nature-Paper-Skills",
            relativePath: "skills/core/figure-planner",
            category: "scientific-figures",
            description: "Nature 论文图表规划。"
          },
          {
            skillId: "PaperSpine/dist/codex/skills/figure-planner",
            skillName: "figure-planner",
            folderName: "figure-planner",
            sourceName: "PaperSpine",
            relativePath: "dist/codex/skills/figure-planner",
            category: "academic-writing",
            description: "PaperSpine 论文工作流图表规划。"
          }
        ]
      }
    ],
    operatorConsent: {
      realWritesEnabled: false,
      enabledAt: "",
      updatedAt: "",
      summary: "真实写入授权未开启；同步按钮只刷新索引，不会写入 AI 工具目录。"
    },
    tags: [
      { id: "tag-paper", name: "论文科研", color: "mint", targetCount: 3 },
      { id: "tag-design", name: "界面设计", color: "peach", targetCount: 2 },
      { id: "tag-security", name: "安全", color: "violet", targetCount: 2 },
      { id: "tag-prompt", name: "Prompt", color: "amber", targetCount: 1 }
    ],
    presetDistributions: [
      {
        id: "dist-paper-global",
        presetId: "paper",
        presetName: "论文科研",
        workspaceId: "global",
        workspaceName: "全局技能库",
        workspaceScope: "global",
        enabled: true,
        skillCount: 18,
        status: "enabled",
        summary: "全局默认启用论文科研组合。"
      },
      {
        id: "dist-paper-claude",
        presetId: "paper",
        presetName: "论文科研",
        workspaceId: "claude-agent",
        workspaceName: "Claude 工作区",
        workspaceScope: "agent",
        enabled: true,
        skillCount: 18,
        status: "enabled",
        summary: "Claude 可优先使用论文写作和投稿审计技能。"
      },
      {
        id: "dist-design-app-next",
        presetId: "design",
        presetName: "界面设计",
        workspaceId: "app-next",
        workspaceName: "AI SkillHub 项目",
        workspaceScope: "project",
        enabled: true,
        skillCount: 7,
        status: "enabled",
        summary: "AI SkillHub 项目工作区启用 UI 审查和交互打磨组合。"
      }
    ],
    operationRunners: [
      {
        id: "diagnostics-export",
        title: "导出诊断包",
        runnerType: "diagnostics",
        status: "ready",
        locked: false,
        lastRunAt: "",
        exportDir: "../app-next/.skillhub-next/reports/diagnostics",
        reportPath: "../app-next/.skillhub-next/reports/diagnostics/latest-diagnostics-export.md",
        latestJsonPath: "../app-next/.skillhub-next/reports/diagnostics/latest-diagnostics-export.json",
        latestMarkdownPath: "../app-next/.skillhub-next/reports/diagnostics/latest-diagnostics-export.md",
        manifestPath: "../app-next/.skillhub-next/reports/diagnostics/latest-diagnostics-export-manifest.json",
        fileCount: 0,
        summary: "生成脱敏诊断摘要、SQLite 状态和发布闸门输入。",
        nextAction: "运行 dry-run，记录报告摘要。"
      },
      {
        id: "share-validation",
        title: "分享验收执行器",
        runnerType: "share-validation",
        status: "ready",
        locked: false,
        lastRunAt: "",
        exportDir: "../app-next/.skillhub-next/reports/share-validation",
        reportPath: "../app-next/.skillhub-next/reports/share-validation/latest-share-validation.md",
        latestJsonPath: "../app-next/.skillhub-next/reports/share-validation/latest-share-validation.json",
        latestMarkdownPath: "../app-next/.skillhub-next/reports/share-validation/latest-share-validation.md",
        manifestPath: "../app-next/.skillhub-next/reports/share-validation/latest-share-validation-manifest.json",
        fileCount: 0,
        summary: "检查无 AI 工具、仅 Claude、缺 Git、路径含空格等分享场景。",
        nextAction: "运行 dry-run，生成分享可用性结论。"
      },
      {
        id: "release-package",
        title: "发布打包执行器",
        runnerType: "release-package",
        status: "locked",
        locked: true,
        lastRunAt: "",
        exportDir: "../app-next/.skillhub-next/reports/release-package",
        reportPath: "../app-next/.skillhub-next/reports/release-package/latest-release-package.md",
        latestJsonPath: "../app-next/.skillhub-next/reports/release-package/latest-release-package.json",
        latestMarkdownPath: "../app-next/.skillhub-next/reports/release-package/latest-release-package.md",
        manifestPath: "../app-next/.skillhub-next/reports/release-package/latest-release-package-manifest.json",
        fileCount: 0,
        summary: "正式打包仍锁定，直到诊断、桌面 QA、备份和分享验收全部通过。",
        nextAction: "先完成全部发布闸门，再开放真实打包。"
      }
    ],
    writeGates: [],
    desktopQaChecks: [
      {
        id: "window-readable",
        title: "默认窗口完整可读",
        description: "侧边栏、主标题、指标卡和滚动条不能被裁切；默认窗口尺寸下必须能直接操作。",
        status: "passed",
        required: true,
        evidence: "",
        updatedAt: new Date().toISOString()
      },
      {
        id: "dpi-clarity",
        title: "高 DPI 清晰度",
        description: "真实 Tauri 桌面窗口里的中文、英文、数字和胶囊状态不能发虚。",
        status: "pending",
        required: true,
        evidence: "",
        updatedAt: new Date().toISOString()
      },
      {
        id: "release-gate-readable",
        title: "发布闸门可读",
        description: "诊断、发布预检、分享验收、zip 预览和桌面 QA 状态必须能被清楚读到。",
        status: "pending",
        required: true,
        evidence: "",
        updatedAt: new Date().toISOString()
      }
    ],
    usageStats: [
      {
        targetType: "skill",
        targetId: "paper-workflow",
        targetName: "paper-workflow",
        sourceName: "Nature-Paper-Skills",
        totalCount: 8,
        sevenDayCount: 3,
        thirtyDayCount: 8,
        lastUsedAt: new Date().toISOString()
      },
      {
        targetType: "source",
        targetId: "source-impeccable",
        targetName: "impeccable",
        sourceName: "impeccable",
        totalCount: 4,
        sevenDayCount: 1,
        thirtyDayCount: 4,
        lastUsedAt: new Date().toISOString()
      }
    ],
    auditEvents: [
      {
        id: "preview-audit-usage",
        eventType: "usage_recorded",
        summary: "Recorded skill usage",
        detailJson: "{}",
        createdAt: new Date().toISOString()
      },
      {
        id: "preview-audit-index",
        eventType: "legacy_scan_indexed",
        summary: "Indexed legacy data into local SQLite",
        detailJson: "{}",
        createdAt: new Date().toISOString()
      }
    ],
    diagnostics: {
      available: false,
      appVersion: "2.0.1 preview",
      generatedAt: new Date().toISOString(),
      overallStatus: "preview",
      ok: 6,
      warn: 1,
      error: 0,
      info: 2
    },
    index: {
      persisted: false,
      databaseFile: "browser-preview",
      indexedAt: new Date().toISOString(),
      sourcesIndexed: 3,
      skillsIndexed: 8,
      agentsIndexed: 3,
      snapshotId: "browser-preview"
    }
  };
}

export function updatePreviewEnabled(
  snapshot: LegacySnapshot,
  command: string,
  id: string,
  enabled: boolean
): LegacySnapshot {
  if (command === "set_workspace_enabled") {
    return {
      ...snapshot,
      workspaces: snapshot.workspaces.map(item => (item.id === id ? { ...item, enabled } : item))
    };
  }
  if (command === "set_preset_enabled") {
    return {
      ...snapshot,
      presets: snapshot.presets.map(item => (item.id === id ? { ...item, enabled } : item))
    };
  }
  if (command === "set_agent_adapter_enabled") {
    return {
      ...snapshot,
      agentAdapters: snapshot.agentAdapters.map(item => (item.id === id ? { ...item, enabled } : item))
    };
  }
  return snapshot;
}

export function updatePreviewPresetDistribution(
  snapshot: LegacySnapshot,
  presetId: string,
  workspaceId: string,
  enabled: boolean
): LegacySnapshot {
  const presetDistributions = snapshot.presetDistributions.map(item =>
    item.presetId === presetId && item.workspaceId === workspaceId
      ? { ...item, enabled, status: enabled ? "enabled" : "disabled" }
      : item
  );
  const workspaceCountByPreset = new Map<string, number>();
  for (const item of presetDistributions) {
    if (item.enabled) {
      workspaceCountByPreset.set(item.presetId, (workspaceCountByPreset.get(item.presetId) ?? 0) + 1);
    }
  }
  return {
    ...snapshot,
    presetDistributions,
    presets: snapshot.presets.map(preset => ({
      ...preset,
      workspaceCount: workspaceCountByPreset.get(preset.id) ?? 0
    }))
  };
}

export function updatePreviewOperationRunner(snapshot: LegacySnapshot, runnerId: string): LegacySnapshot {
  const now = new Date().toISOString();
  return {
    ...snapshot,
    operationRunners: snapshot.operationRunners.map(runner =>
      runner.id === runnerId
        ? {
            ...runner,
            status: runner.locked ? "locked" : "completed",
            lastRunAt: now,
            fileCount: Math.max(runner.fileCount, 6)
          }
        : runner
    ),
    auditEvents: [
      {
        id: `preview-runner-${runnerId}-${Date.now()}`,
        eventType: "operation_runner_completed",
        summary: `Completed dry-run runner ${runnerId}`,
        detailJson: "{}",
        createdAt: now
      },
      ...snapshot.auditEvents
    ].slice(0, 30)
  };
}

export function updatePreviewRealWriteAuthorization(snapshot: LegacySnapshot, enabled: boolean): LegacySnapshot {
  const now = new Date().toISOString();
  return {
    ...snapshot,
    operatorConsent: {
      realWritesEnabled: enabled,
      enabledAt: enabled ? now : "",
      updatedAt: now,
      summary: enabled
        ? "用户已手动授权真实写入；同步按钮会运行 GitHub 更新、Skill 路由重建和 AI 工具链接同步。"
        : "真实写入授权未开启；同步按钮只刷新索引，不会写入 AI 工具目录。"
    }
  };
}

export function updatePreviewDesktopQaStatus(
  snapshot: LegacySnapshot,
  id: string,
  status: "pending" | "passed" | "failed"
): LegacySnapshot {
  return {
    ...snapshot,
    desktopQaChecks: snapshot.desktopQaChecks.map(check =>
      check.id === id ? { ...check, status, updatedAt: new Date().toISOString() } : check
    )
  };
}

