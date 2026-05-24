(function () {
  "use strict";

  const categories = [
    { id: "auto", zh: "自动分类", en: "Auto", ko: "자동 분류" },
    { id: "academic-writing", zh: "论文科研", en: "Academic Writing", ko: "논문 연구" },
    { id: "literature-research", zh: "文献研究", en: "Literature Research", ko: "문헌 연구" },
    { id: "scientific-figures", zh: "科研图表", en: "Scientific Figures", ko: "과학 도표" },
    { id: "ui-design", zh: "界面设计", en: "UI Design", ko: "UI 디자인" },
    { id: "security", zh: "安全审计", en: "Security", ko: "보안 점검" },
    { id: "agent-tools", zh: "智能体工具", en: "Agent Tools", ko: "에이전트 도구" },
    { id: "image-generation", zh: "图像生成", en: "Image Generation", ko: "이미지 생성" },
    { id: "knowledge-retrieval", zh: "知识检索", en: "Knowledge Retrieval", ko: "지식 검색" },
    { id: "presentation", zh: "汇报演示", en: "Presentation", ko: "발표" },
    { id: "prompt-polishing", zh: "提示词润色", en: "Prompt Polishing", ko: "프롬프트 다듬기" },
    { id: "general", zh: "通用技能", en: "General", ko: "일반" }
  ];

  const APP_VERSION = "v1.1.1";
  const defaultColumns = {
    skills: [200, 132, 118, 168, 300, 330],
    repos: [210, 92, 132, 136, 118, 250, 300],
    prompts: [220, 150, 360, 320, 160]
  };

  const presets = [
    { id: "all", labelKey: "presetAll", tab: "", categories: [] },
    { id: "paper", labelKey: "presetPaper", tab: "skills", categories: ["academic-writing", "literature-research", "presentation"] },
    { id: "figures", labelKey: "presetFigures", tab: "skills", categories: ["scientific-figures", "image-generation"] },
    { id: "ui", labelKey: "presetUi", tab: "skills", categories: ["ui-design"] },
    { id: "security", labelKey: "presetSecurity", tab: "skills", categories: ["security"] },
    { id: "prompts", labelKey: "presetPrompts", tab: "prompts", categories: [] }
  ];

  const text = {
    zh: {
      ready: "就绪",
      running: "正在运行",
      eyebrow: "共享技能中枢",
      subtitle: "集中管理 GitHub Skills、Prompt 来源、AI 软件链接和每日自动更新。",
      activeSkills: "已启用技能",
      repos: "仓库来源",
      dailyUpdate: "每日自动更新",
      agentLinks: "接管 AI 软件链接",
      healthTitle: "系统体检",
      healthNotRun: "尚未体检，点击立即体检生成报告。",
      runHealthCheck: "立即体检",
      agentDetails: "AI 软件详情",
      agentDetailsTitle: "AI 工具接管状态",
      agentDetailsIntro: "这里会把检测、目录权限、接管方式和下一步建议分开说明，避免把“检测到目录”和“已经接管”混在一起。",
      agentDetailsEmpty: "还没有体检数据。先点击“立即体检”，再查看完整详情。",
      agentDetailDetected: "检测",
      agentDetailManaged: "接管",
      agentDetailWritable: "权限",
      agentDetailPath: "目录",
      agentDetailNext: "下一步",
      agentPermissionUnknown: "需体检确认",
      agentNextReady: "状态正常，可以继续同步或使用。",
      agentNextEnableLinks: "打开“接管 AI 软件链接”，然后点击“立即同步”。",
      agentNextInstallTool: "如果要使用这个工具，请先安装或运行一次对应 AI Coding 工具。",
      agentNextRunCheck: "先运行系统体检，获取更完整的目录和权限信息。",
      lastCheck: "最近体检",
      healthOk: "正常",
      healthWarn: "提醒",
      healthError: "错误",
      healthInfo: "信息",
      detected: "已检测",
      notDetected: "未检测",
      linked: "已链接",
      notLinked: "未链接",
      managedCount: "已接管 {count} 个 Skill",
      detectedNotManaged: "已检测，尚未接管",
      detectedNotManagedHint: "打开“接管 AI 软件链接”后会自动处理",
      writable: "可写",
      notWritable: "不可写",
      syncNow: "立即同步",
      openReport: "打开报告",
      exportDiagnostics: "导出诊断包",
      exportTroubleshooting: "导出排错包",
      shareCheck: "分享前检查",
      developerCenter: "发布中心",
      developerTitle: "开发者与发布检查",
      developerIntro: "这些动作只用于开发、分享前验收和发布前检查。正式上传 GitHub Release 前，先让这里全部通过。",
      developerStatusTitle: "最近检查结果",
      developerStatusHint: "运行后会自动刷新。",
      developerStatusEmpty: "还没有检查记录。",
      v2RoadmapTitle: "V2 对标路线",
      v2RoadmapPercent: "约 12%",
      v2RoadmapBody: "仍在持续参考 skills-manager、asm、OpenSkills 和 SkillKit。当前重点是把 v1 的分享、诊断、导入、接管流程稳定成 V2 的行为规格；Tauri/React/Rust/SQLite 真正重构尚未开工。",
      v2RoadmapRefs: "参考：skills-manager · asm · OpenSkills · SkillKit",
      developerCard_diagnostics: "系统体检",
      developerCard_share: "分享验收",
      developerCard_release: "发布预检",
      developerCard_troubleshooting: "排错包",
      devSuiteTitle: "完整验收",
      devSuiteBody: "按顺序运行系统体检、分享验收、排错包和发布预检，适合打包前一键确认。",
      runAcceptanceSuite: "运行完整验收",
      devDiagnosticsTitle: "系统体检",
      devDiagnosticsBody: "重新生成当前电脑的诊断报告，确认 Git、WebView2、配置、skills 和 AI 工具状态。",
      devShareTitle: "分享验收",
      devShareBody: "模拟干净下载用户、中文路径、缺 Codex、无 AI 工具、缺 Git 和缺 WebView2。",
      devTroubleTitle: "排错包",
      devTroubleBody: "导出脱敏报告包，方便别人电脑出错后发回来分析。",
      devReleaseTitle: "发布预检",
      devReleaseBody: "生成白名单 zip 和 SHA256，并检查包内没有个人 skills、来源、配置、报告或缓存。",
      runShareValidation: "运行分享验收",
      runReleasePreflight: "运行发布预检",
      openReleaseFolder: "打开发布目录",
      quickStart: "快速上手",
      onboardingEyebrow: "新用户引导",
      onboardingTitle: "三步完成第一次配置",
      onboardingDesc: "先添加来源，再同步，最后接管已安装的 AI Coding 工具。没有安装的工具会自动跳过。",
      guideStepSourceTitle: "添加 Skill 来源",
      guideStepSourceBody: "粘贴 GitHub 地址，或导入本地文件夹 / zip。",
      guideStepSyncTitle: "同步到共享目录",
      guideStepSyncBody: "只会启用包含 SKILL.md 的目录。",
      guideStepAgentTitle: "接管 AI 软件链接",
      guideStepAgentBody: "Claude Code、Codex、Antigravity 检测到才会链接。",
      hideGuide: "我知道了",
      gotIt: "明白了",
      helpTitle: "AI SkillHub 应该怎么用？",
      helpIntro: "它不是内置 Skill 商店，而是帮你把 GitHub、zip、本地文件夹里的真实 Skill 统一管理，然后链接给已安装的 AI Coding 工具。",
      helpSourceTitle: "来源",
      helpSourceBody: "只有目录里有 SKILL.md，才会被当作 Skill。Prompt 仓库会保留为资料，不会强行安装。",
      helpAgentTitle: "工具",
      helpAgentBody: "没安装 Codex 或 Antigravity 不算错误。AI SkillHub 会跳过缺失工具，不创建假目录。",
      helpShareTitle: "分享",
      helpShareBody: "给别人前运行“分享前检查”。如果出错，让对方导出排错包发回来。",
      openSkills: "打开技能目录",
      openSources: "打开来源目录",
      openReports: "打开报告目录",
      tipTitle: "使用提示",
      tipBody: "选择仓库来源后，可修改类型、分类和备注。Prompt 来源只保存资料，不会安装为 Skill。",
      addRepo: "添加仓库",
      editRepo: "编辑来源",
      addRepoDesc: "粘贴 GitHub 仓库地址，AI SkillHub 会自动克隆、分类并建立链接。",
      githubUrl: "GitHub 项目地址",
      type: "类型",
      category: "细分分类",
      note: "手动备注",
      tags: "标签",
      tagsPlaceholder: "论文, 图表, 常用",
      tagCloud: "标签系统",
      allTags: "全部标签",
      untagged: "未标签",
      duplicateInsight: "重复技能",
      noDuplicates: "没有发现重复名称",
      promptDetail: "Prompt 详情",
      selectedSource: "当前选中来源",
      detailHint: "在上方修改分类、备注或标签后点击保存修改。",
      openThisSource: "打开此来源",
      historyTitle: "最近操作",
      noHistory: "暂无操作记录",
      importTitle: "本地导入预览",
      importDesc: "先扫描文件夹或 zip，再确认是否导入。只有包含 SKILL.md 的目录会作为 Skill。",
      chooseFolder: "选择文件夹",
      chooseZip: "选择 zip",
      importEmpty: "还没有选择本地来源。",
      importFound: "发现",
      importSkills: "个 Skill",
      importPromptHints: "个疑似 Prompt/资料",
      importReadme: "包含 README",
      importRootSkill: "根目录就是 Skill",
      importNoSkill: "没有发现 SKILL.md，建议作为 Prompt/资料保存，不要安装为 Skill。",
      importNameAdjusted: "名称已自动避让重名",
      importRecommendedName: "推荐名称",
      importPath: "来源位置",
      importSamples: "示例 Skill",
      importConfirm: "导入到来源并同步",
      add: "添加仓库",
      save: "保存修改",
      delete: "删除来源",
      tabSkills: "已启用技能",
      tabRepos: "仓库来源",
      tabPrompts: "Prompt 资料",
      searchPlaceholder: "搜索名称、分类、备注",
      filterAllCategories: "全部分类",
      sortName: "按名称",
      sortCategory: "按分类",
      sortRepo: "按仓库",
      sortType: "按类型",
      sortHealth: "按健康",
      listShowing: "显示",
      duplicateGroups: "重复组",
      presetAll: "全部",
      presetPaper: "论文",
      presetFigures: "图表",
      presetUi: "UI 设计",
      presetSecurity: "安全",
      presetPrompts: "Prompt",
      activity: "运行反馈",
      clear: "清空",
      skill: "技能",
      prompt: "润色提示词",
      name: "名称",
      repo: "仓库",
      source: "来源位置",
      sourceHealth: "健康",
      skillHealth: "健康",
      skillHealthOk: "正常",
      skillHealthWarn: "需检查",
      skillHealthError: "有错误",
      skillHealthInfo: "有提示",
      sourceOk: "可用",
      sourceMissing: "未下载",
      sourcePromptOnly: "资料保留",
      sourceNoSkill: "无 SKILL.md",
      sourceLocal: "本地",
      sourceEnabled: "已启用",
      sourceDisabled: "已停用",
      enableSource: "启用来源",
      disableSource: "停用来源",
      address: "地址",
      mode: "模式",
      description: "说明",
      status: "状态",
      commit: "版本",
      emptyTitle: "没有匹配结果",
      emptyBody: "换一个搜索词，或同步后再看。",
      lastSync: "最近同步",
      never: "尚未同步",
      managed: "已接管",
      notManaged: "未接管",
      optionalMissing: "未安装可忽略",
      noAgentDetected: "未识别到可接管的 AI Coding 工具",
      enabled: "已启用",
      disabled: "未启用",
      confirmTitle: "确认删除来源？",
      confirmBody: "这只会从配置中移除来源，不会删除本地 GitHub 文件夹。",
      cancel: "取消",
      confirmDelete: "删除",
      selectRepoFirst: "请先选择一个仓库来源。",
      invalidUrl: "请先填写标准 GitHub 仓库地址。",
      localRepo: "本地技能",
      manualRepo: "手动来源",
      themeCute: "可爱",
      themeFresh: "清新",
      themeDark: "深色",
      resizeColumn: "拖动调整列宽"
    },
    en: {
      ready: "Ready",
      running: "Running",
      eyebrow: "Shared SkillHub",
      subtitle: "Manage GitHub Skills, prompt sources, AI app links, and daily updates.",
      activeSkills: "Active Skills",
      repos: "Sources",
      dailyUpdate: "Daily Update",
      agentLinks: "Agent Links",
      healthTitle: "System Check",
      healthNotRun: "No check yet. Run one to generate a report.",
      runHealthCheck: "Check Now",
      agentDetails: "AI Tool Details",
      agentDetailsTitle: "AI tool connection status",
      agentDetailsIntro: "Detection, folder permissions, connection mode, and next steps are shown separately so detected does not look the same as connected.",
      agentDetailsEmpty: "No check data yet. Run System Check first to view full details.",
      agentDetailDetected: "Detection",
      agentDetailManaged: "Managed",
      agentDetailWritable: "Permission",
      agentDetailPath: "Folder",
      agentDetailNext: "Next step",
      agentPermissionUnknown: "Check required",
      agentNextReady: "Looks good. You can sync or use it now.",
      agentNextEnableLinks: "Turn on Agent Links, then click Sync Now.",
      agentNextInstallTool: "Install or run this AI coding tool once if you want to use it.",
      agentNextRunCheck: "Run System Check first to collect folder and permission details.",
      lastCheck: "Last check",
      healthOk: "OK",
      healthWarn: "Warn",
      healthError: "Error",
      healthInfo: "Info",
      detected: "Detected",
      notDetected: "Missing",
      linked: "Linked",
      notLinked: "Not linked",
      managedCount: "{count} Skills managed",
      detectedNotManaged: "Detected, not managed yet",
      detectedNotManagedHint: "Turn on Agent Links to connect it",
      writable: "Writable",
      notWritable: "Not writable",
      syncNow: "Sync Now",
      openReport: "Open Report",
      exportDiagnostics: "Export Diagnostics",
      exportTroubleshooting: "Export Troubleshooting",
      shareCheck: "Share Check",
      developerCenter: "Release Center",
      developerTitle: "Developer and release checks",
      developerIntro: "Use these actions for development, share validation, and release preflight. Before uploading a GitHub Release, make sure they pass.",
      developerStatusTitle: "Latest Results",
      developerStatusHint: "Refreshes after each run.",
      developerStatusEmpty: "No check records yet.",
      v2RoadmapTitle: "V2 Benchmark Roadmap",
      v2RoadmapPercent: "About 12%",
      v2RoadmapBody: "We are still learning from skills-manager, asm, OpenSkills, and SkillKit. The current work is stabilizing v1 sharing, diagnostics, imports, and agent linking into behavior specs for V2; the Tauri/React/Rust/SQLite rewrite has not started yet.",
      v2RoadmapRefs: "References: skills-manager · asm · OpenSkills · SkillKit",
      developerCard_diagnostics: "System Check",
      developerCard_share: "Share Validation",
      developerCard_release: "Release Preflight",
      developerCard_troubleshooting: "Troubleshooting Bundle",
      devSuiteTitle: "Full Acceptance",
      devSuiteBody: "Run system check, share validation, troubleshooting bundle, and release preflight in order before packaging.",
      runAcceptanceSuite: "Run Full Acceptance",
      devDiagnosticsTitle: "System Check",
      devDiagnosticsBody: "Regenerate diagnostics for Git, WebView2, config, skills, and AI tool status.",
      devShareTitle: "Share Validation",
      devShareBody: "Simulate a clean recipient, Chinese path, missing Codex, no AI tools, missing Git, and missing WebView2.",
      devTroubleTitle: "Troubleshooting Bundle",
      devTroubleBody: "Export a sanitized report bundle for another computer's failure report.",
      devReleaseTitle: "Release Preflight",
      devReleaseBody: "Build an allowlisted zip and SHA256, then audit for personal skills, sources, config, reports, and caches.",
      runShareValidation: "Run Share Validation",
      runReleasePreflight: "Run Release Preflight",
      openReleaseFolder: "Open Release Folder",
      quickStart: "Quick Start",
      onboardingEyebrow: "First-run guide",
      onboardingTitle: "Finish the first setup in three steps",
      onboardingDesc: "Add a source, sync it, then link detected AI coding tools. Missing tools are skipped.",
      guideStepSourceTitle: "Add a Skill source",
      guideStepSourceBody: "Paste a GitHub URL, or import a local folder / zip.",
      guideStepSyncTitle: "Sync to the shared folder",
      guideStepSyncBody: "Only folders with SKILL.md are enabled.",
      guideStepAgentTitle: "Link AI tools",
      guideStepAgentBody: "Claude Code, Codex, and Antigravity are linked only when detected.",
      hideGuide: "Got it",
      gotIt: "Got it",
      helpTitle: "How should I use AI SkillHub?",
      helpIntro: "It is not a built-in Skill store. It manages real Skills from GitHub, zip files, and local folders, then links them to installed AI coding tools.",
      helpSourceTitle: "Sources",
      helpSourceBody: "A folder must contain SKILL.md to be treated as a Skill. Prompt repositories are kept as reference material.",
      helpAgentTitle: "Tools",
      helpAgentBody: "Missing Codex or Antigravity is not an error. AI SkillHub skips missing tools and does not create fake folders.",
      helpShareTitle: "Sharing",
      helpShareBody: "Run Share Check before sending the app to others. If something fails, ask them to export a troubleshooting bundle.",
      openSkills: "Open Skills",
      openSources: "Open Sources",
      openReports: "Open Reports Folder",
      tipTitle: "Tip",
      tipBody: "Select a source to edit type, category, and note. Prompt sources are kept as material and are not installed as Skills.",
      addRepo: "Add Source",
      editRepo: "Edit Source",
      addRepoDesc: "Paste a GitHub repository. AI SkillHub clones, classifies, and links it automatically.",
      githubUrl: "GitHub Repository URL",
      type: "Type",
      category: "Category",
      note: "Manual Note",
      tags: "Tags",
      tagsPlaceholder: "paper, figures, favorite",
      tagCloud: "Tags",
      allTags: "All tags",
      untagged: "Untagged",
      duplicateInsight: "Duplicate skills",
      noDuplicates: "No duplicate names",
      promptDetail: "Prompt Detail",
      selectedSource: "Selected Source",
      detailHint: "Edit category, note, or tags above, then save changes.",
      openThisSource: "Open Source",
      historyTitle: "Recent Activity",
      noHistory: "No activity yet",
      importTitle: "Local Import Preview",
      importDesc: "Scan a folder or zip first. Only folders with SKILL.md are installed as Skills.",
      chooseFolder: "Choose Folder",
      chooseZip: "Choose zip",
      importEmpty: "No local source selected yet.",
      importFound: "Found",
      importSkills: "Skills",
      importPromptHints: "prompt/reference hints",
      importReadme: "README included",
      importRootSkill: "Root is a Skill",
      importNoSkill: "No SKILL.md found. Keep it as Prompt/reference material, not an installed Skill.",
      importNameAdjusted: "Name adjusted to avoid duplicate",
      importRecommendedName: "Recommended name",
      importPath: "Source path",
      importSamples: "Sample Skills",
      importConfirm: "Import and Sync",
      add: "Add Source",
      save: "Save Changes",
      delete: "Remove Source",
      tabSkills: "Active Skills",
      tabRepos: "Sources",
      tabPrompts: "Prompt Material",
      searchPlaceholder: "Search names, categories, notes",
      filterAllCategories: "All categories",
      sortName: "Name",
      sortCategory: "Category",
      sortRepo: "Repository",
      sortType: "Type",
      sortHealth: "Health",
      listShowing: "Showing",
      duplicateGroups: "Duplicate groups",
      presetAll: "All",
      presetPaper: "Paper",
      presetFigures: "Figures",
      presetUi: "UI Design",
      presetSecurity: "Security",
      presetPrompts: "Prompt",
      activity: "Activity",
      clear: "Clear",
      skill: "Skill",
      prompt: "Prompt",
      name: "Name",
      repo: "Repository",
      source: "Source Path",
      sourceHealth: "Health",
      skillHealth: "Health",
      skillHealthOk: "OK",
      skillHealthWarn: "Check",
      skillHealthError: "Error",
      skillHealthInfo: "Info",
      sourceOk: "Ready",
      sourceMissing: "Missing",
      sourcePromptOnly: "Reference only",
      sourceNoSkill: "No SKILL.md",
      sourceLocal: "Local",
      sourceEnabled: "Enabled",
      sourceDisabled: "Disabled",
      enableSource: "Enable source",
      disableSource: "Disable source",
      address: "URL",
      mode: "Mode",
      description: "Description",
      status: "Status",
      commit: "Commit",
      emptyTitle: "No results",
      emptyBody: "Try another keyword or sync again.",
      lastSync: "Last sync",
      never: "Never synced",
      managed: "Managed",
      notManaged: "Not managed",
      optionalMissing: "Optional missing",
      noAgentDetected: "No AI coding tools detected",
      enabled: "Enabled",
      disabled: "Disabled",
      confirmTitle: "Remove this source?",
      confirmBody: "This removes it from configuration only. The local GitHub folder is not deleted.",
      cancel: "Cancel",
      confirmDelete: "Remove",
      selectRepoFirst: "Select a repository source first.",
      invalidUrl: "Enter a standard GitHub repository URL first.",
      localRepo: "Local skill",
      manualRepo: "Manual source",
      themeCute: "Cute",
      themeFresh: "Fresh",
      themeDark: "Dark",
      resizeColumn: "Drag to resize column"
    },
    ko: {
      ready: "준비됨",
      running: "실행 중",
      eyebrow: "공유 SkillHub",
      subtitle: "GitHub Skill, 프롬프트 소스, AI 앱 링크, 매일 업데이트를 한곳에서 관리합니다.",
      activeSkills: "활성 Skill",
      repos: "저장소",
      dailyUpdate: "매일 업데이트",
      agentLinks: "AI 앱 링크 연결",
      healthTitle: "시스템 점검",
      healthNotRun: "아직 점검하지 않았습니다. 점검을 실행하세요.",
      runHealthCheck: "지금 점검",
      agentDetails: "AI 도구 상세",
      agentDetailsTitle: "AI 도구 연결 상태",
      agentDetailsIntro: "감지, 폴더 권한, 연결 방식, 다음 단계를 분리해서 보여줍니다.",
      agentDetailsEmpty: "아직 점검 데이터가 없습니다. 먼저 시스템 점검을 실행하세요.",
      agentDetailDetected: "감지",
      agentDetailManaged: "연결",
      agentDetailWritable: "권한",
      agentDetailPath: "폴더",
      agentDetailNext: "다음 단계",
      agentPermissionUnknown: "점검 필요",
      agentNextReady: "상태가 정상입니다. 동기화하거나 바로 사용할 수 있습니다.",
      agentNextEnableLinks: "AI 도구 연결을 켠 뒤 지금 동기화를 누르세요.",
      agentNextInstallTool: "이 도구를 사용하려면 먼저 설치하거나 한 번 실행하세요.",
      agentNextRunCheck: "먼저 시스템 점검을 실행해 폴더와 권한 정보를 수집하세요.",
      lastCheck: "최근 점검",
      healthOk: "정상",
      healthWarn: "주의",
      healthError: "오류",
      healthInfo: "정보",
      detected: "감지됨",
      notDetected: "미감지",
      linked: "연결됨",
      notLinked: "미연결",
      managedCount: "{count}개 Skill 연결됨",
      detectedNotManaged: "감지됨, 아직 연결되지 않음",
      detectedNotManagedHint: "AI 도구 연결을 켜면 자동으로 처리합니다",
      writable: "쓰기 가능",
      notWritable: "쓰기 불가",
      syncNow: "지금 동기화",
      openReport: "보고서 열기",
      exportDiagnostics: "진단 패키지 내보내기",
      exportTroubleshooting: "문제 해결 패키지 내보내기",
      shareCheck: "공유 전 점검",
      developerCenter: "릴리스 센터",
      developerTitle: "개발자 및 릴리스 점검",
      developerIntro: "개발, 공유 전 검증, 릴리스 전 점검에 사용하는 기능입니다. GitHub Release에 올리기 전에 모두 통과시키세요.",
      developerStatusTitle: "최근 점검 결과",
      developerStatusHint: "실행 후 자동으로 갱신됩니다.",
      developerStatusEmpty: "아직 점검 기록이 없습니다.",
      v2RoadmapTitle: "V2 벤치마크 로드맵",
      v2RoadmapPercent: "약 12%",
      v2RoadmapBody: "skills-manager, asm, OpenSkills, SkillKit을 계속 참고하고 있습니다. 현재는 v1의 공유, 진단, 가져오기, 에이전트 연결 흐름을 V2 동작 기준으로 안정화하는 단계이며 Tauri/React/Rust/SQLite 재구축은 아직 시작 전입니다.",
      v2RoadmapRefs: "참고: skills-manager · asm · OpenSkills · SkillKit",
      developerCard_diagnostics: "시스템 점검",
      developerCard_share: "공유 검증",
      developerCard_release: "릴리스 사전 점검",
      developerCard_troubleshooting: "문제 해결 패키지",
      devSuiteTitle: "전체 검증",
      devSuiteBody: "패키징 전에 시스템 점검, 공유 검증, 문제 해결 패키지, 릴리스 사전 점검을 순서대로 실행합니다.",
      runAcceptanceSuite: "전체 검증 실행",
      devDiagnosticsTitle: "시스템 점검",
      devDiagnosticsBody: "Git, WebView2, 설정, skills, AI 도구 상태 진단을 다시 생성합니다.",
      devShareTitle: "공유 검증",
      devShareBody: "깨끗한 사용자, 한글 경로, Codex 없음, AI 도구 없음, Git 없음, WebView2 없음을 시뮬레이션합니다.",
      devTroubleTitle: "문제 해결 패키지",
      devTroubleBody: "다른 컴퓨터의 오류 분석을 위한 비식별 보고서 패키지를 내보냅니다.",
      devReleaseTitle: "릴리스 사전 점검",
      devReleaseBody: "허용 목록 zip과 SHA256을 만들고 개인 skills, 소스, 설정, 보고서, 캐시가 들어가지 않았는지 점검합니다.",
      runShareValidation: "공유 검증 실행",
      runReleasePreflight: "릴리스 사전 점검 실행",
      openReleaseFolder: "릴리스 폴더 열기",
      quickStart: "빠른 시작",
      onboardingEyebrow: "처음 사용자 안내",
      onboardingTitle: "세 단계로 첫 설정 완료",
      onboardingDesc: "소스를 추가하고 동기화한 뒤 설치된 AI 코딩 도구에 연결합니다. 없는 도구는 건너뜁니다.",
      guideStepSourceTitle: "Skill 소스 추가",
      guideStepSourceBody: "GitHub 주소를 붙여넣거나 로컬 폴더 / zip을 가져옵니다.",
      guideStepSyncTitle: "공유 폴더로 동기화",
      guideStepSyncBody: "SKILL.md가 있는 폴더만 활성화합니다.",
      guideStepAgentTitle: "AI 도구 연결",
      guideStepAgentBody: "Claude Code, Codex, Antigravity가 감지될 때만 연결합니다.",
      hideGuide: "알겠습니다",
      gotIt: "알겠습니다",
      helpTitle: "AI SkillHub는 어떻게 쓰나요?",
      helpIntro: "내장 Skill 상점이 아니라 GitHub, zip, 로컬 폴더의 실제 Skill을 모아 설치된 AI 코딩 도구에 연결하는 앱입니다.",
      helpSourceTitle: "소스",
      helpSourceBody: "SKILL.md가 있는 폴더만 Skill로 처리합니다. Prompt 저장소는 참고 자료로 보관합니다.",
      helpAgentTitle: "도구",
      helpAgentBody: "Codex나 Antigravity가 없어도 오류가 아닙니다. 없는 도구는 건너뛰고 가짜 폴더를 만들지 않습니다.",
      helpShareTitle: "공유",
      helpShareBody: "다른 사람에게 보내기 전 공유 전 점검을 실행합니다. 문제가 있으면 문제 해결 패키지를 내보내면 됩니다.",
      openSkills: "Skill 폴더 열기",
      openSources: "소스 폴더 열기",
      openReports: "보고서 폴더 열기",
      tipTitle: "사용 팁",
      tipBody: "저장소를 선택하면 유형, 분류, 메모를 수정할 수 있습니다. Prompt 소스는 자료로만 보관됩니다.",
      addRepo: "저장소 추가",
      editRepo: "소스 편집",
      addRepoDesc: "GitHub 저장소 주소를 붙여넣으면 자동으로 복제, 분류, 연결합니다.",
      githubUrl: "GitHub 저장소 주소",
      type: "유형",
      category: "세부 분류",
      note: "수동 메모",
      tags: "태그",
      tagsPlaceholder: "논문, 도표, 자주 사용",
      tagCloud: "태그 시스템",
      allTags: "전체 태그",
      untagged: "태그 없음",
      duplicateInsight: "중복 Skill",
      noDuplicates: "중복 이름 없음",
      promptDetail: "Prompt 상세",
      selectedSource: "선택한 소스",
      detailHint: "위에서 분류, 메모, 태그를 수정한 뒤 저장하세요.",
      openThisSource: "소스 열기",
      historyTitle: "최근 작업",
      noHistory: "아직 작업 기록이 없습니다",
      importTitle: "로컬 가져오기 미리보기",
      importDesc: "폴더나 zip을 먼저 스캔합니다. SKILL.md가 있는 폴더만 Skill로 설치됩니다.",
      chooseFolder: "폴더 선택",
      chooseZip: "zip 선택",
      importEmpty: "아직 로컬 소스를 선택하지 않았습니다.",
      importFound: "발견",
      importSkills: "개 Skill",
      importPromptHints: "개 프롬프트/자료 후보",
      importReadme: "README 포함",
      importRootSkill: "루트가 Skill",
      importNoSkill: "SKILL.md가 없습니다. Skill 설치가 아니라 자료로 보관하세요.",
      importNameAdjusted: "중복을 피하도록 이름 조정됨",
      importRecommendedName: "추천 이름",
      importPath: "소스 위치",
      importSamples: "예시 Skill",
      importConfirm: "가져오고 동기화",
      add: "저장소 추가",
      save: "변경 저장",
      delete: "소스 삭제",
      tabSkills: "활성 Skill",
      tabRepos: "저장소",
      tabPrompts: "Prompt 자료",
      searchPlaceholder: "이름, 분류, 메모 검색",
      filterAllCategories: "전체 분류",
      sortName: "이름순",
      sortCategory: "분류순",
      sortRepo: "저장소순",
      sortType: "유형순",
      sortHealth: "상태순",
      listShowing: "표시",
      duplicateGroups: "중복 그룹",
      presetAll: "전체",
      presetPaper: "논문",
      presetFigures: "도표",
      presetUi: "UI 디자인",
      presetSecurity: "보안",
      presetPrompts: "Prompt",
      activity: "실행 피드백",
      clear: "비우기",
      skill: "Skill",
      prompt: "프롬프트",
      name: "이름",
      repo: "저장소",
      source: "소스 위치",
      sourceHealth: "상태",
      skillHealth: "상태",
      skillHealthOk: "정상",
      skillHealthWarn: "확인 필요",
      skillHealthError: "오류",
      skillHealthInfo: "안내",
      sourceOk: "사용 가능",
      sourceMissing: "없음",
      sourcePromptOnly: "자료 보관",
      sourceNoSkill: "SKILL.md 없음",
      sourceLocal: "로컬",
      sourceEnabled: "활성",
      sourceDisabled: "비활성",
      enableSource: "소스 활성화",
      disableSource: "소스 비활성화",
      address: "주소",
      mode: "모드",
      description: "설명",
      status: "상태",
      commit: "버전",
      emptyTitle: "검색 결과 없음",
      emptyBody: "다른 검색어를 입력하거나 다시 동기화하세요.",
      lastSync: "최근 동기화",
      never: "동기화 전",
      managed: "연결됨",
      notManaged: "미연결",
      optionalMissing: "없어도 됨",
      noAgentDetected: "연결할 AI 코딩 도구를 찾지 못했습니다",
      enabled: "활성",
      disabled: "비활성",
      confirmTitle: "소스를 삭제할까요?",
      confirmBody: "설정에서만 제거합니다. 로컬 GitHub 폴더는 삭제하지 않습니다.",
      cancel: "취소",
      confirmDelete: "삭제",
      selectRepoFirst: "먼저 저장소 소스를 선택하세요.",
      invalidUrl: "표준 GitHub 저장소 주소를 입력하세요.",
      localRepo: "로컬 Skill",
      manualRepo: "수동 소스",
      themeCute: "귀여움",
      themeFresh: "산뜻함",
      themeDark: "다크",
      resizeColumn: "열 너비 조정"
    }
  };

  let lang = chooseLanguage();
  let theme = chooseTheme();
  let columnState = {
    skills: loadColumns("skills"),
    repos: loadColumns("repos"),
    prompts: loadColumns("prompts")
  };
  let state = {
    repositories: [],
    skills: [],
    operationHistory: [],
    manageAgentLinks: false,
    dailyUpdateEnabled: false,
    lastSync: ""
  };
  let activeTab = "skills";
  let activePreset = "all";
  let activeTagFilter = "all";
  let selectedRepo = null;
  let importPreview = null;
  let guideHidden = localStorage.getItem("skillhub.guideHidden") === "true";
  let busy = false;

  const dom = {};

  document.addEventListener("DOMContentLoaded", () => {
    bindDom();
    bindEvents();
    installWindowInteractions();
    applyLanguage();
    appendLog("info", "AI SkillHub UI ready.");
    send("ready");
  });

  if (window.chrome && window.chrome.webview) {
    window.chrome.webview.addEventListener("message", event => handleHostMessage(event.data));
  }

  function bindDom() {
    [
      "brandLogo", "versionLabel", "miniStatus", "skillCount", "repoCount", "lastSync", "linkStatus",
      "healthSummary", "healthOk", "healthWarn", "healthError", "healthInfo", "agentMatrix", "healthChecks",
      "dailyToggle", "linksToggle", "healthButton", "agentDetailsButton", "syncButton", "reportButton", "diagnosticsButton", "troubleshootingButton", "shareCheckButton", "developerButton", "skillsButton",
      "helpButton", "sourcesButton", "reportsButton", "chooseFolderButton", "chooseZipButton", "importPreview", "repoUrl", "repoType", "repoCategory", "repoNote", "repoTags", "addButton",
      "saveButton", "deleteButton", "skillsView", "reposView", "promptsView", "searchInput", "categoryFilter", "sortSelect", "listMeta", "presetStrip",
      "insightPanel", "detailPanel", "historyTimeline", "logBox",
      "clearLog", "selectedChip", "composerTitle", "toastHost", "confirmDialog",
      "confirmTitle", "confirmBody", "cancelConfirm", "acceptConfirm", "onboardingCard",
      "guideStepSource", "guideStepSync", "guideStepAgent", "hideGuideButton", "helpDialog",
      "closeHelpButton", "acceptHelpButton", "agentDialog", "agentDetailList",
      "closeAgentButton", "acceptAgentButton", "agentRunCheckButton", "developerDialog",
      "closeDeveloperButton", "acceptDeveloperButton", "devRunDiagnosticsButton",
      "devRunShareButton", "devRunTroubleButton", "devRunReleaseButton",
      "devRunAllButton", "devOpenReportsButton", "devOpenReleaseButton", "developerStatusGrid"
    ].forEach(id => { dom[id] = document.getElementById(id); });
  }

  function bindEvents() {
    document.querySelectorAll(".lang-button").forEach(button => {
      button.addEventListener("click", () => {
        lang = button.dataset.lang;
        localStorage.setItem("skillhub.lang", lang);
        applyLanguage();
        renderAll();
      });
    });

    document.querySelectorAll(".theme-button").forEach(button => {
      button.addEventListener("click", () => {
        theme = button.dataset.theme;
        localStorage.setItem("skillhub.theme", theme);
        applyTheme();
      });
    });

    dom.brandLogo.addEventListener("click", event => {
      playLogoSurprise(event);
    });
    dom.brandLogo.addEventListener("load", () => {
      dom.brandLogo.classList.add("loaded");
    });
    dom.brandLogo.addEventListener("error", () => {
      dom.brandLogo.classList.add("logo-fallback");
    });

    document.querySelectorAll(".window-button").forEach(button => {
      button.addEventListener("click", () => send("window." + button.dataset.window));
    });

    document.querySelectorAll(".segment").forEach(button => {
      button.addEventListener("click", () => {
        activeTab = button.dataset.tab;
        activePreset = "all";
        activeTagFilter = "all";
        renderAll();
      });
    });

    dom.searchInput.addEventListener("input", renderLists);
    dom.categoryFilter.addEventListener("change", () => {
      activePreset = "all";
      activeTagFilter = "all";
      renderPresets();
      renderLists();
    });
    dom.sortSelect.addEventListener("change", renderLists);
    dom.syncButton.addEventListener("click", () => send("sync"));
    dom.healthButton.addEventListener("click", () => send("runHealthCheck"));
    dom.agentDetailsButton.addEventListener("click", () => {
      renderAgentDetails();
      dom.agentDialog.showModal();
    });
    dom.reportButton.addEventListener("click", () => send("openReport"));
    dom.diagnosticsButton.addEventListener("click", () => send("exportDiagnostics"));
    dom.troubleshootingButton.addEventListener("click", () => send("exportTroubleshooting"));
    dom.shareCheckButton.addEventListener("click", () => send("shareCheck"));
    dom.developerButton.addEventListener("click", () => dom.developerDialog.showModal());
    dom.helpButton.addEventListener("click", () => dom.helpDialog.showModal());
    dom.skillsButton.addEventListener("click", () => send("openSkills"));
    dom.sourcesButton.addEventListener("click", () => send("openSources"));
    dom.reportsButton.addEventListener("click", () => send("openReports"));
    dom.chooseFolderButton.addEventListener("click", () => send("chooseLocalSource"));
    dom.chooseZipButton.addEventListener("click", () => send("chooseZipSource"));
    dom.clearLog.addEventListener("click", () => { dom.logBox.textContent = ""; });
    dom.hideGuideButton.addEventListener("click", () => {
      guideHidden = true;
      localStorage.setItem("skillhub.guideHidden", "true");
      renderOnboarding();
    });
    dom.closeHelpButton.addEventListener("click", () => dom.helpDialog.close());
    dom.acceptHelpButton.addEventListener("click", () => dom.helpDialog.close());
    dom.closeAgentButton.addEventListener("click", () => dom.agentDialog.close());
    dom.acceptAgentButton.addEventListener("click", () => dom.agentDialog.close());
    dom.agentRunCheckButton.addEventListener("click", () => {
      dom.agentDialog.close();
      send("runHealthCheck");
    });
    dom.closeDeveloperButton.addEventListener("click", () => dom.developerDialog.close());
    dom.acceptDeveloperButton.addEventListener("click", () => dom.developerDialog.close());
    dom.devRunDiagnosticsButton.addEventListener("click", () => send("runHealthCheck"));
    dom.devRunShareButton.addEventListener("click", () => send("runShareRecipientTest"));
    dom.devRunTroubleButton.addEventListener("click", () => send("exportTroubleshooting"));
    dom.devRunReleaseButton.addEventListener("click", () => send("runReleasePreflight"));
    dom.devRunAllButton.addEventListener("click", () => send("runAcceptanceSuite"));
    dom.devOpenReportsButton.addEventListener("click", () => send("openReports"));
    dom.devOpenReleaseButton.addEventListener("click", () => send("openRelease"));
    dom.dailyToggle.addEventListener("click", () => send("setDailyUpdate", { enabled: !state.dailyUpdateEnabled }));
    dom.linksToggle.addEventListener("click", () => send("setManageLinks", { enabled: !state.manageAgentLinks }));

    dom.addButton.addEventListener("click", () => {
      if (!dom.repoUrl.value.trim()) return toast("error", t("invalidUrl"));
      send("addRepo", formPayload());
    });

    dom.saveButton.addEventListener("click", () => {
      if (!selectedRepo) return toast("error", t("selectRepoFirst"));
      send("saveRepo", Object.assign({ name: selectedRepo.name }, formPayload()));
    });

    dom.deleteButton.addEventListener("click", () => {
      if (!selectedRepo) return toast("error", t("selectRepoFirst"));
      dom.confirmDialog.showModal();
    });

    dom.cancelConfirm.addEventListener("click", () => dom.confirmDialog.close());
    dom.acceptConfirm.addEventListener("click", () => {
      dom.confirmDialog.close();
      if (selectedRepo) send("deleteRepo", { name: selectedRepo.name });
    });
  }

  function handleHostMessage(message) {
    if (!message || !message.type) return;
    if (message.type === "state") {
      state = message.data || state;
      dom.versionLabel.textContent = state.version || APP_VERSION;
      renderAll();
    }
    if (message.type === "busy") {
      busy = !!message.busy;
      document.body.classList.toggle("busy", busy);
      dom.miniStatus.textContent = busy ? t("running") : t("ready");
    }
    if (message.type === "toast") toast(message.tone || "success", message.message || "");
    if (message.type === "log") appendLog(message.level || "info", message.message || "");
    if (message.type === "importPreview") {
      importPreview = message.data || null;
      renderImportPreview();
    }
  }

  function send(action, payload) {
    const message = Object.assign({ action }, payload || {});
    if (window.chrome && window.chrome.webview) {
      window.chrome.webview.postMessage(message);
    } else {
      appendLog("error", "WebView bridge is not available.");
    }
  }

  function formPayload() {
    return {
      url: dom.repoUrl.value.trim(),
      repoType: dom.repoType.value,
      categoryId: dom.repoCategory.value,
      note: dom.repoNote.value.trim(),
      tags: parseTags(dom.repoTags.value)
    };
  }

  function renderAll() {
    renderMetrics();
    renderControls();
    renderHealth();
    renderOnboarding();
    renderImportPreview();
    renderDeveloperStatus();
    renderFormOptions();
    renderListControls();
    renderPresets();
    renderSelected();
    renderLists();
    renderHistory();
  }

  function renderMetrics() {
    dom.skillCount.textContent = String(state.skillCount || (state.skills || []).length || 0);
    dom.repoCount.textContent = String(state.repoCount || (state.repositories || []).length || 0);
    dom.lastSync.textContent = `${t("lastSync")}: ${state.lastSync || t("never")}`;
    const linkStatus = state.manageAgentLinks ? t("managed") : t("notManaged");
    const link = state.linkStatus || {};
    const codexCount = link.codexCount || 0;
    const anyAgentDetected = Boolean(link.claudeDetected || link.codexDetected || link.antigravityDetected);
    if (!anyAgentDetected) {
      dom.linkStatus.textContent = `${linkStatus} · ${t("noAgentDetected")}`;
      return;
    }
    const claudeText = `Claude ${link.claudeDetected ? (link.claude ? t("linked") : t("detectedNotManaged")) : t("notDetected")}`;
    const codexText = link.codexDetected ? `Codex ${codexCount > 0 ? formatText("managedCount", { count: codexCount }) : t("detectedNotManaged")}` : `Codex ${t("optionalMissing")}`;
    const antigravityText = link.antigravityDetected ? `Antigravity ${link.antigravity ? t("linked") : t("detectedNotManaged")}` : `Antigravity ${t("optionalMissing")}`;
    dom.linkStatus.textContent = `${linkStatus} · ${claudeText} · ${codexText} · ${antigravityText}`;
  }

  function renderDeveloperStatus() {
    if (!dom.developerStatusGrid) return;
    dom.developerStatusGrid.replaceChildren();
    const cards = ((state.releaseCenter || {}).cards || []);
    if (!cards.length) {
      const empty = el("div", "developer-status-empty");
      empty.textContent = t("developerStatusEmpty");
      dom.developerStatusGrid.appendChild(empty);
      return;
    }
    cards.forEach(card => {
      const node = el("div", "developer-status-card " + (card.status || "info"));
      const top = el("div", "developer-status-top");
      const title = el("strong");
      title.textContent = card.id ? t(`developerCard_${card.id}`) : (card.title || "-");
      top.append(title, badge(statusLabel(card.status), card.status || "info"));
      const summary = el("p");
      summary.textContent = card.summary || "-";
      const time = el("small");
      time.textContent = formatCheckTime(card.time || "");
      node.append(top, summary, time);
      dom.developerStatusGrid.appendChild(node);
    });
  }

  function renderControls() {
    setToggle(dom.dailyToggle, !!state.dailyUpdateEnabled);
    setToggle(dom.linksToggle, !!state.manageAgentLinks);
    dom.miniStatus.textContent = busy ? t("running") : t("ready");
  }

  function renderHealth() {
    if (!dom.healthSummary) return;
    const diagnostics = state.diagnostics || {};
    const available = !!diagnostics.available;
    const status = String(diagnostics.overallStatus || "info");
    dom.healthSummary.textContent = available
      ? `${t("lastCheck")}: ${formatCheckTime(diagnostics.generatedAt)} · ${statusLabel(status)}`
      : t("healthNotRun");
    dom.healthSummary.className = "health-summary " + status;
    dom.healthOk.textContent = String(diagnostics.ok || 0);
    dom.healthWarn.textContent = String(diagnostics.warn || 0);
    dom.healthError.textContent = String(diagnostics.error || 0);
    dom.healthInfo.textContent = String(diagnostics.info || 0);

    dom.agentMatrix.replaceChildren();
    (diagnostics.agents || []).forEach(agent => {
      const agentName = String(agent.name || agent.id || "");
      const isCodex = /codex/i.test(agentName);
      const codexManagedCount = Number((state.linkStatus || {}).codexCount || 0);
      const statusTone = agent.detected ? "ok" : "info";
      const item = el("div", "agent-item " + statusTone);
      const title = el("div", "agent-title");
      const name = el("strong");
      name.textContent = agent.name || agent.id || "-";
      const statusBadge = badge(agent.detected ? t("detected") : t("notDetected"), statusTone);
      title.append(name, statusBadge);

      const meta = el("small");
      const parts = [];
      if (agent.detected) {
        if (isCodex && codexManagedCount > 0) {
          parts.push(formatText("managedCount", { count: codexManagedCount }));
        } else if (agent.linked) {
          parts.push(t("linked"));
        } else {
          parts.push(t("detectedNotManaged"));
          parts.push(t("detectedNotManagedHint"));
        }
        if (agent.hasSkillsDir) parts.push(agent.writable ? t("writable") : t("notWritable"));
      } else {
        parts.push(t("optionalMissing"));
      }
      meta.textContent = parts.join(" · ") + (agent.path ? ` · ${agent.path}` : "");
      item.append(title, meta);
      dom.agentMatrix.appendChild(item);
    });

    dom.healthChecks.replaceChildren();
    (diagnostics.checks || []).slice(0, 5).forEach(check => {
      const item = el("div", "health-check " + (check.status || "info"));
      const dot = el("span", "status-dot " + (check.status || "info"));
      const body = el("div");
      const title = el("strong");
      const summary = el("small");
      title.textContent = check.name || "-";
      summary.textContent = check.summary || "";
      body.append(title, summary);
      item.append(dot, body);
      dom.healthChecks.appendChild(item);
    });
  }

  function renderOnboarding() {
    if (!dom.onboardingCard) return;
    const repoCount = Number(state.repoCount || (state.repositories || []).length || 0);
    const skillCount = Number(state.skillCount || (state.skills || []).length || 0);
    const link = state.linkStatus || {};
    const anyAgentDetected = Boolean(link.claudeDetected || link.codexDetected || link.antigravityDetected);
    const anyAgentLinked = Boolean(link.claude || link.codexSkills || link.agentsSkills || link.antigravity);

    const shouldShow = !guideHidden || repoCount === 0 || skillCount === 0;
    dom.onboardingCard.hidden = !shouldShow;

    setGuideStep(dom.guideStepSource, repoCount > 0);
    setGuideStep(dom.guideStepSync, skillCount > 0);
    setGuideStep(dom.guideStepAgent, anyAgentDetected && (state.manageAgentLinks || anyAgentLinked));
  }

  function setGuideStep(node, done) {
    if (!node) return;
    node.classList.toggle("done", !!done);
    node.classList.toggle("todo", !done);
  }

  function renderAgentDetails() {
    if (!dom.agentDetailList) return;
    dom.agentDetailList.replaceChildren();

    const diagnostics = state.diagnostics || {};
    const rows = buildAgentRows();
    if (!diagnostics.available) {
      const empty = el("div", "agent-detail-empty");
      empty.textContent = t("agentDetailsEmpty");
      dom.agentDetailList.appendChild(empty);
    }

    rows.forEach(row => {
      const card = el("div", "agent-detail-card " + (row.detected ? "ok" : "info"));
      const head = el("div", "agent-detail-head");
      const title = el("strong");
      title.textContent = row.name;
      head.append(title, badge(row.detected ? t("detected") : t("notDetected"), row.detected ? "ok" : "info"));

      const grid = el("div", "agent-detail-grid");
      grid.append(
        agentDetailItem(t("agentDetailDetected"), row.detected ? t("detected") : t("notDetected")),
        agentDetailItem(t("agentDetailManaged"), row.managedLabel),
        agentDetailItem(t("agentDetailWritable"), row.writableLabel),
        agentDetailItem(t("agentDetailPath"), row.path || "-"),
        agentDetailItem(t("agentDetailNext"), row.next)
      );
      card.append(head, grid);
      dom.agentDetailList.appendChild(card);
    });
  }

  function buildAgentRows() {
    const diagnostics = state.diagnostics || {};
    const link = state.linkStatus || {};
    const agents = Array.isArray(diagnostics.agents) ? diagnostics.agents : [];
    if (agents.length) {
      return agents.map(agent => normalizeAgentRow(agent, false));
    }
    return [
      normalizeAgentRow({
        id: "claude",
        name: "Claude / Claude Code",
        detected: !!link.claudeDetected,
        linked: !!link.claude,
        hasSkillsDir: !!link.claude,
        path: "~\\.claude\\skills"
      }, true),
      normalizeAgentRow({
        id: "codex",
        name: "OpenAI Codex",
        detected: !!link.codexDetected,
        linked: Number(link.codexCount || 0) > 0,
        hasSkillsDir: !!link.codexSkills || !!link.agentsSkills,
        path: "~\\.codex\\skills"
      }, true),
      normalizeAgentRow({
        id: "antigravity",
        name: "Antigravity",
        detected: !!link.antigravityDetected,
        linked: !!link.antigravity,
        hasSkillsDir: !!link.antigravity,
        path: "~\\.gemini\\antigravity\\skills"
      }, true)
    ];
  }

  function normalizeAgentRow(agent, fallbackOnly) {
    const agentName = String(agent.name || agent.id || "-");
    const isCodex = /codex/i.test(agentName);
    const codexManagedCount = Number((state.linkStatus || {}).codexCount || 0);
    const detected = !!agent.detected;
    const linked = !!agent.linked || (isCodex && codexManagedCount > 0);
    const writableKnown = Object.prototype.hasOwnProperty.call(agent, "writable");
    const writable = !!agent.writable;
    const managedLabel = linked
      ? (isCodex && codexManagedCount > 0 ? formatText("managedCount", { count: codexManagedCount }) : t("linked"))
      : (detected ? t("detectedNotManaged") : t("notDetected"));
    const writableLabel = writableKnown
      ? (writable ? t("writable") : t("notWritable"))
      : (agent.hasSkillsDir ? t("agentPermissionUnknown") : "-");
    let next = t("agentNextReady");
    if (!detected) next = t("agentNextInstallTool");
    else if (fallbackOnly) next = t("agentNextRunCheck");
    else if (!linked) next = t("agentNextEnableLinks");

    return {
      name: agentName,
      detected,
      linked,
      managedLabel,
      writableLabel,
      path: agent.path || "",
      next
    };
  }

  function agentDetailItem(label, value) {
    const item = el("div", "agent-detail-item");
    const key = el("span");
    const val = el("strong");
    key.textContent = label;
    val.textContent = value || "-";
    item.append(key, val);
    return item;
  }

  function renderImportPreview() {
    if (!dom.importPreview) return;
    dom.importPreview.replaceChildren();
    dom.importPreview.classList.toggle("empty", !importPreview);
    if (!importPreview) {
      const empty = el("span");
      empty.textContent = t("importEmpty");
      dom.importPreview.appendChild(empty);
      return;
    }

    const top = el("div", "import-preview-top");
    const title = el("div");
    const name = el("strong");
    const path = el("small");
    name.textContent = `${t("importRecommendedName")}: ${importPreview.recommendedName || "-"}`;
    path.textContent = `${t("importPath")}: ${importPreview.sourcePath || "-"}`;
    title.append(name, path);
    const status = badge(importPreview.skillCount > 0 ? `${t("importFound")} ${importPreview.skillCount} ${t("importSkills")}` : t("importNoSkill"), importPreview.skillCount > 0 ? "ok" : "warn");
    top.append(title, status);

    const chips = el("div", "import-chips");
    chips.appendChild(chip(`${importPreview.promptHintCount || 0} ${t("importPromptHints")}`));
    if (importPreview.hasReadme) chips.appendChild(chip(t("importReadme")));
    if (importPreview.hasSkillMdAtRoot) chips.appendChild(chip(t("importRootSkill")));
    if (importPreview.nameAdjusted) chips.appendChild(chip(t("importNameAdjusted")));
    chips.appendChild(chip(`${importPreview.fileCount || 0} files`));

    const samples = el("div", "import-samples");
    const sampleLabel = el("small");
    sampleLabel.textContent = t("importSamples") + ": ";
    samples.appendChild(sampleLabel);
    (importPreview.sampleSkills || []).slice(0, 5).forEach(item => samples.appendChild(chip(item || "-")));
    if (!(importPreview.sampleSkills || []).length) samples.appendChild(chip("-"));

    const actions = el("div", "import-confirm-row");
    const confirm = el("button", "primary-action compact");
    confirm.textContent = t("importConfirm");
    confirm.disabled = !importPreview.canImport;
    confirm.addEventListener("click", () => send("importLocalSource", {
      sourcePath: importPreview.sourcePath,
      sourceKind: importPreview.sourceKind,
      recommendedName: importPreview.recommendedName,
      repoType: importPreview.skillCount > 0 ? dom.repoType.value : "prompt",
      categoryId: dom.repoCategory.value,
      note: dom.repoNote.value.trim(),
      tags: parseTags(dom.repoTags.value)
    }));
    actions.appendChild(confirm);

    dom.importPreview.append(top, chips, samples, actions);
  }

  function chip(value) {
    const node = el("span", "mini-chip");
    node.textContent = value || "-";
    return node;
  }

  function parseTags(value) {
    const seen = new Set();
    return String(value || "")
      .split(/[,，;；\n\r]+/)
      .map(item => item.trim().replace(/\s{2,}/g, " "))
      .filter(item => item && item.length <= 28)
      .filter(item => {
        const key = item.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 12);
  }

  function renderFormOptions() {
    const currentType = dom.repoType.value || "skills";
    dom.repoType.replaceChildren(
      option("skills", t("skill")),
      option("prompt", t("prompt"))
    );
    dom.repoType.value = currentType === "prompt" ? "prompt" : "skills";

    const currentCategory = dom.repoCategory.value || "auto";
    dom.repoCategory.replaceChildren(...categories.map(c => option(c.id, c[lang])));
    dom.repoCategory.value = categories.some(c => c.id === currentCategory) ? currentCategory : "auto";
  }

  function renderSelected() {
    const selectedStillExists = selectedRepo && (state.repositories || []).some(repo => repo.name === selectedRepo.name);
    if (selectedStillExists) {
      selectedRepo = (state.repositories || []).find(repo => repo.name === selectedRepo.name) || selectedRepo;
    } else {
      selectedRepo = null;
    }
    dom.composerTitle.textContent = selectedRepo ? t("editRepo") : t("addRepo");
    dom.selectedChip.hidden = !selectedRepo;
    dom.saveButton.disabled = !selectedRepo;
    dom.deleteButton.disabled = !selectedRepo;
    if (selectedRepo) dom.selectedChip.textContent = selectedRepo.name;
  }

  function renderLists() {
    document.querySelectorAll(".segment").forEach(button => {
      button.classList.toggle("active", button.dataset.tab === activeTab);
    });
    dom.skillsView.hidden = activeTab !== "skills";
    dom.reposView.hidden = activeTab !== "repos";
    dom.promptsView.hidden = activeTab !== "prompts";
    if (activeTab === "skills") renderSkills();
    if (activeTab === "repos") renderRepos();
    if (activeTab === "prompts") renderPrompts();
  }

  function renderListControls() {
    const currentCategory = dom.categoryFilter.value || "all";
    dom.categoryFilter.replaceChildren(
      option("all", t("filterAllCategories")),
      ...categories.filter(c => c.id !== "auto").map(c => option(c.id, c[lang]))
    );
    dom.categoryFilter.value = [...dom.categoryFilter.options].some(item => item.value === currentCategory) ? currentCategory : "all";

    const currentSort = dom.sortSelect.value || "name";
    dom.sortSelect.replaceChildren(
      option("name", t("sortName")),
      option("category", t("sortCategory")),
      option("repo", t("sortRepo")),
      option("type", t("sortType")),
      option("health", t("sortHealth"))
    );
    dom.sortSelect.value = [...dom.sortSelect.options].some(item => item.value === currentSort) ? currentSort : "name";
  }

  function renderPresets() {
    dom.presetStrip.replaceChildren();
    presets.forEach(preset => {
      const button = el("button", "preset-pill " + (preset.id === activePreset ? "active" : ""));
      button.type = "button";
      button.textContent = t(preset.labelKey);
      button.addEventListener("click", () => {
        activePreset = preset.id;
        if (preset.tab) activeTab = preset.tab;
        dom.categoryFilter.value = "all";
        activeTagFilter = "all";
        renderAll();
      });
      dom.presetStrip.appendChild(button);
    });
  }

  function renderSkills() {
    const sourceRows = state.skills || [];
    const rows = applyListFilters(sourceRows, "skills");
    const duplicates = duplicateGroups(sourceRows, item => item.name);
    dom.skillsView.replaceChildren();
    renderListMeta(rows.length, sourceRows.length, duplicates, sourceRows);
    renderDetailPanel();
    if (!rows.length) return dom.skillsView.appendChild(emptyState());

    const table = el("div", "data-table skills-table");
    applyTableColumns("skills", table);
    table.appendChild(headerRow(["name", "category", "skillHealth", "repo", "description", "source"].map(t), "skills"));
    rows.forEach(skill => {
      const health = badge(skillHealthLabel(skill), skillHealthClass(skill));
      health.title = [skill.healthSummary, skill.healthFix].filter(Boolean).join("\n");
      const cells = [
        cellWithTags(skill.name, skill.tags, "name-cell"),
        badge(categoryLabel(skill.categoryId), categoryClass(skill.categoryId, skill.mode)),
        health,
        cell(skill.repo || t("localRepo")),
        cell(skill.description || skill.note || "-"),
        cell(skill.target || skill.localPath || "-")
      ];
      table.appendChild(row(cells));
    });
    dom.skillsView.appendChild(table);
  }

  function renderRepos() {
    const sourceRows = state.repositories || [];
    const rows = applyListFilters(sourceRows, "repos");
    const duplicates = duplicateGroups(sourceRows, item => item.name);
    dom.reposView.replaceChildren();
    renderListMeta(rows.length, sourceRows.length, duplicates, sourceRows);
    renderDetailPanel();
    if (!rows.length) return dom.reposView.appendChild(emptyState());

    const table = el("div", "data-table repos-table");
    applyTableColumns("repos", table);
    table.appendChild(headerRow(["name", "type", "category", "sourceHealth", "status", "note", "address"].map(t), "repos"));
    rows.forEach(repo => {
      const dataRow = row([
        cell(repo.name, "name-cell"),
        badge(repo.type === "prompt" ? t("prompt") : t("skill"), repo.type),
        badge(categoryLabel(repo.categoryId || "auto"), categoryClass(repo.categoryId || "auto", "")),
        badge(sourceHealthLabel(repo), sourceHealthClass(repo)),
        repoEnableControl(repo),
        cellWithTags(repo.note || "-", repo.tags),
        cell(repo.url || repo.path || "-")
      ], selectedRepo && selectedRepo.name === repo.name ? "selected" : "");
      dataRow.addEventListener("click", () => selectRepo(repo));
      table.appendChild(dataRow);
    });
    dom.reposView.appendChild(table);
  }

  function renderPrompts() {
    const sourceRows = (state.repositories || []).filter(repo => repo.type === "prompt");
    const rows = applyListFilters(sourceRows, "prompts");
    const duplicates = duplicateGroups(sourceRows, item => item.name);
    dom.promptsView.replaceChildren();
    renderListMeta(rows.length, sourceRows.length, duplicates, sourceRows);
    renderDetailPanel();
    if (!rows.length) return dom.promptsView.appendChild(emptyState());

    const table = el("div", "data-table prompts-table");
    applyTableColumns("prompts", table);
    table.appendChild(headerRow(["name", "category", "note", "address", "sourceHealth"].map(t), "prompts"));
    rows.forEach(repo => {
      const dataRow = row([
        cell(repo.name, "name-cell"),
        badge(categoryLabel(repo.categoryId || "auto"), categoryClass(repo.categoryId || "auto", "")),
        cellWithTags(repo.note || "-", repo.tags),
        cell(repo.url || repo.path || "-"),
        badge(sourceHealthLabel(repo), sourceHealthClass(repo))
      ], selectedRepo && selectedRepo.name === repo.name ? "selected" : "");
      dataRow.addEventListener("click", () => selectRepo(repo));
      table.appendChild(dataRow);
    });
    dom.promptsView.appendChild(table);
  }

  function renderDetailPanel() {
    if (!dom.detailPanel) return;
    const repo = selectedRepo;
    if (!repo) {
      dom.detailPanel.hidden = true;
      dom.detailPanel.replaceChildren();
      return;
    }

    dom.detailPanel.hidden = false;
    dom.detailPanel.replaceChildren();
    const title = el("div", "detail-title");
    const heading = el("strong");
    heading.textContent = repo.type === "prompt" ? t("promptDetail") : t("selectedSource");
    const hint = el("small");
    hint.textContent = t("detailHint");
    const open = el("button", "text-action compact");
    open.type = "button";
    open.textContent = t("openThisSource");
    open.addEventListener("click", () => send("openSourcePath", { name: repo.name }));
    title.append(heading, hint, open);

    const body = el("div", "detail-grid");
    body.append(
      detailItem(t("name"), repo.name || "-"),
      detailItem(t("type"), repo.type === "prompt" ? t("prompt") : t("skill")),
      detailItem(t("category"), categoryLabel(repo.categoryId || "auto")),
      detailItem(t("sourceHealth"), sourceHealthLabel(repo)),
      detailItem(t("address"), repo.url || repo.path || "-"),
      detailItem(t("note"), repo.note || "-")
    );

    const tags = el("div", "detail-tags");
    const label = el("span", "meta-label");
    label.textContent = t("tags");
    tags.appendChild(label);
    const list = repo.tags && repo.tags.length ? repo.tags : [t("untagged")];
    list.forEach(tag => tags.appendChild(chip(tag)));
    dom.detailPanel.append(title, body, tags);
  }

  function selectRepo(repo) {
    selectedRepo = repo;
    dom.repoUrl.value = repo.url || "";
    dom.repoType.value = repo.type === "prompt" ? "prompt" : "skills";
    dom.repoCategory.value = repo.categoryId || "auto";
    dom.repoNote.value = repo.note || "";
    dom.repoTags.value = (repo.tags || []).join(", ");
    renderAll();
  }

  function renderHistory() {
    if (!dom.historyTimeline) return;
    const items = state.operationHistory || [];
    dom.historyTimeline.replaceChildren();
    const head = el("div", "timeline-head");
    head.textContent = t("historyTitle");
    dom.historyTimeline.appendChild(head);
    if (!items.length) {
      const empty = el("small", "timeline-empty");
      empty.textContent = t("noHistory");
      dom.historyTimeline.appendChild(empty);
      return;
    }
    items.slice(0, 6).forEach(item => {
      const row = el("div", "timeline-item " + (item.status || "info"));
      const dot = el("span", "timeline-dot");
      const body = el("div");
      const title = el("strong");
      const detail = el("small");
      title.textContent = item.title || "-";
      detail.textContent = [formatCheckTime(item.time), item.detail || ""].filter(Boolean).join(" · ");
      body.append(title, detail);
      row.append(dot, body);
      dom.historyTimeline.appendChild(row);
    });
  }

  function detailItem(label, value) {
    const item = el("div", "detail-item");
    const key = el("span");
    const val = el("strong");
    key.textContent = label;
    val.textContent = value || "-";
    item.append(key, val);
    return item;
  }

  function matches(item, query) {
    if (!query) return true;
    const haystack = Object.keys(item)
      .map(key => String(item[key] || ""))
      .concat(categoryLabel(item.categoryId || "auto"), itemHasSourceHealth(item) ? sourceHealthLabel(item) : "", itemHasSkillHealth(item) ? skillHealthLabel(item) : "", item.healthFix || "")
      .join(" ")
      .toLowerCase();
    return haystack.includes(query);
  }

  function applyListFilters(rows, kind) {
    const query = dom.searchInput.value.trim().toLowerCase();
    const category = dom.categoryFilter.value || "all";
    const preset = presets.find(item => item.id === activePreset) || presets[0];
    const filtered = rows.filter(item => matches(item, query))
      .filter(item => category === "all" || (item.categoryId || "auto") === category)
      .filter(item => !preset.categories.length || preset.categories.includes(item.categoryId || "auto"))
      .filter(item => itemMatchesTag(item, activeTagFilter));
    return sortRows(filtered, kind);
  }

  function sortRows(rows, kind) {
    const sort = dom.sortSelect.value || "name";
    const copy = rows.slice();
    const textValue = item => {
      if (sort === "category") return categoryLabel(item.categoryId || "auto");
      if (sort === "repo") return item.repo || item.name || "";
      if (sort === "type") return item.type || item.mode || "";
      if (sort === "health") return itemHasSkillHealth(item) ? `${healthSortRank(item.healthStatus)} ${item.healthIssueCount || 0} ${item.name || ""}` : sourceHealthLabel(item);
      return item.name || "";
    };
    copy.sort((a, b) => textValue(a).localeCompare(textValue(b), lang === "zh" ? "zh-Hans-CN" : lang, { sensitivity: "base" }));
    return copy;
  }

  function renderListMeta(visible, total, duplicates, rows) {
    const tags = collectTags(rows || []);
    const untaggedCount = countUntagged(rows || []);
    dom.listMeta.replaceChildren();
    const summary = el("span", "meta-summary");
    const tagText = activeTagFilter === "all" ? "" : ` · ${t("tags")} ${tagFilterLabel(activeTagFilter)}`;
    summary.textContent = `${t("listShowing")} ${visible} / ${total} · ${t("duplicateGroups")} ${duplicates.length}${tagText}`;
    dom.listMeta.appendChild(summary);

    const tagWrap = el("div", "meta-tags");
    const label = el("span", "meta-label");
    label.textContent = t("tagCloud");
    tagWrap.appendChild(label);
    tagWrap.appendChild(tagFilterButton("all", `${t("allTags")} ${total}`));
    if (tags.length) {
      tags.slice(0, 12).forEach(item => {
        tagWrap.appendChild(tagFilterButton(item.name, `${item.name} ${item.count}`));
      });
    }
    if (untaggedCount > 0) tagWrap.appendChild(tagFilterButton("__untagged", `${t("untagged")} ${untaggedCount}`));
    dom.listMeta.appendChild(tagWrap);
    renderInsights(duplicates);
  }

  function tagFilterButton(value, label) {
    const button = el("button", "meta-tag " + (String(activeTagFilter).toLowerCase() === String(value).toLowerCase() ? "active" : ""));
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", () => {
      activeTagFilter = value;
      renderLists();
    });
    return button;
  }

  function tagFilterLabel(value) {
    if (value === "all") return t("allTags");
    if (value === "__untagged") return t("untagged");
    return value || t("allTags");
  }

  function itemMatchesTag(item, filter) {
    if (!filter || filter === "all") return true;
    const tags = (item.tags || []).map(tag => String(tag || "").trim().toLowerCase()).filter(Boolean);
    if (filter === "__untagged") return tags.length === 0;
    return tags.includes(String(filter).trim().toLowerCase());
  }

  function duplicateGroups(rows, pick) {
    const map = new Map();
    rows.forEach(item => {
      const value = String(pick(item) || "").trim().toLowerCase();
      if (!value) return;
      if (!map.has(value)) map.set(value, { name: String(pick(item) || "").trim(), count: 0, items: [] });
      const group = map.get(value);
      group.count += 1;
      group.items.push(item);
    });
    return Array.from(map.values())
      .filter(group => group.count > 1)
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, lang === "zh" ? "zh-Hans-CN" : lang, { sensitivity: "base" }));
  }

  function collectTags(rows) {
    const map = new Map();
    rows.forEach(item => {
      (item.tags || []).forEach(tag => {
        const name = String(tag || "").trim();
        if (!name) return;
        const key = name.toLowerCase();
        const current = map.get(key) || { name, count: 0 };
        current.count += 1;
        map.set(key, current);
      });
    });
    return Array.from(map.values())
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, lang === "zh" ? "zh-Hans-CN" : lang, { sensitivity: "base" }));
  }

  function countUntagged(rows) {
    let count = 0;
    rows.forEach(item => {
      const tags = (item.tags || []).map(tag => String(tag || "").trim()).filter(Boolean);
      if (!tags.length) count += 1;
    });
    return count;
  }

  function renderInsights(duplicates) {
    if (!dom.insightPanel) return;
    dom.insightPanel.replaceChildren();
    const head = el("span", "insight-title");
    head.textContent = t("duplicateInsight");
    dom.insightPanel.appendChild(head);
    if (!duplicates.length) {
      dom.insightPanel.appendChild(chip(t("noDuplicates")));
      return;
    }
    duplicates.slice(0, 6).forEach(group => {
      const button = el("button", "duplicate-chip");
      button.type = "button";
      button.textContent = `${group.name} ×${group.count}`;
      button.addEventListener("click", () => {
        dom.searchInput.value = group.name;
        renderLists();
      });
      dom.insightPanel.appendChild(button);
    });
  }

  function row(items, className) {
    const node = el("div", "data-row " + (className || ""));
    items.forEach(item => node.appendChild(typeof item === "string" ? cell(item) : item));
    return node;
  }

  function headerRow(items, key) {
    const node = el("div", "data-row header");
    items.forEach((item, index) => {
      const header = cell(item, "resizable-head");
      if (index < items.length - 1) {
        const handle = el("span", "resize-handle");
        handle.title = t("resizeColumn");
        handle.addEventListener("pointerdown", event => startColumnResize(event, key, index));
        header.appendChild(handle);
      }
      node.appendChild(header);
    });
    return node;
  }

  function applyTableColumns(key, table) {
    const cols = columnState[key] || defaultColumns[key];
    table.style.setProperty("--table-columns", cols.map(value => `${value}px`).join(" "));
    table.style.minWidth = `${cols.reduce((sum, value) => sum + value, 0) + 28}px`;
  }

  function startColumnResize(event, key, index) {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startCols = (columnState[key] || defaultColumns[key]).slice();
    const minWidth = key === "repos" ? 78 : 96;
    const startCurrent = startCols[index];
    const startNext = startCols[index + 1];

    document.body.classList.add("resizing-columns");
    document.body.style.userSelect = "none";

    const move = moveEvent => {
      const delta = moveEvent.clientX - startX;
      const nextDelta = Math.min(delta, startNext - minWidth);
      const currentDelta = Math.max(nextDelta, minWidth - startCurrent);
      const cols = startCols.slice();
      cols[index] = Math.round(startCurrent + currentDelta);
      cols[index + 1] = Math.round(startNext - currentDelta);
      columnState[key] = cols;
      document.querySelectorAll(`.${key}-table`).forEach(table => applyTableColumns(key, table));
    };

    const up = () => {
      document.body.classList.remove("resizing-columns");
      document.body.style.userSelect = "";
      localStorage.setItem(columnStorageKey(key), JSON.stringify(columnState[key]));
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }

  function cell(value, className) {
    const node = el("div", "cell " + (className || ""));
    node.title = value || "";
    node.textContent = value || "";
    return node;
  }

  function cellWithTags(value, tags, className) {
    const node = el("div", "cell multi " + (className || ""));
    node.title = value || "";
    const textNode = el("span", "cell-main");
    textNode.textContent = value || "";
    node.appendChild(textNode);
    const safeTags = (tags || []).filter(Boolean);
    if (safeTags.length) {
      const tagRow = el("div", "tag-row");
      safeTags.slice(0, 4).forEach(tag => {
        const item = el("span", "tag-chip");
        item.textContent = tag;
        tagRow.appendChild(item);
      });
      if (safeTags.length > 4) {
        const more = el("span", "tag-chip muted");
        more.textContent = "+" + (safeTags.length - 4);
        tagRow.appendChild(more);
      }
      node.appendChild(tagRow);
    }
    return node;
  }

  function badge(value, className) {
    const node = el("span", "badge " + (className || ""));
    node.textContent = value || "-";
    return node;
  }

  function repoEnableControl(repo) {
    const wrap = el("div", "repo-enable");
    const configured = repo.configured !== false;
    const canToggle = configured && repo.type !== "prompt";
    const enabled = isRepoEnabled(repo);
    const button = el("button", "mini-toggle " + (enabled ? "on" : ""));
    button.type = "button";
    button.disabled = !canToggle;
    button.title = enabled ? t("disableSource") : t("enableSource");
    button.setAttribute("aria-pressed", enabled ? "true" : "false");
    button.appendChild(el("span"));
    button.addEventListener("click", event => {
      event.stopPropagation();
      if (!canToggle) return;
      send("setRepoEnabled", { name: repo.name, enabled: !enabled });
    });
    const label = el("small");
    label.textContent = enabled ? t("sourceEnabled") : t("sourceDisabled");
    wrap.append(button, label);
    return wrap;
  }

  function isRepoEnabled(repo) {
    if (!repo || repo.type === "prompt") return false;
    if (repo.enabled === false) return false;
    return repo.mode !== "do-not-install";
  }

  function emptyState() {
    const node = el("div", "empty-state");
    const wrap = el("div");
    const title = el("strong");
    const body = el("span");
    title.textContent = t("emptyTitle");
    body.textContent = t("emptyBody");
    wrap.append(title, body);
    node.appendChild(wrap);
    return node;
  }

  function setToggle(node, enabled) {
    node.classList.toggle("on", enabled);
    node.setAttribute("aria-pressed", enabled ? "true" : "false");
  }

  function option(value, label) {
    const node = document.createElement("option");
    node.value = value;
    node.textContent = label;
    return node;
  }

  function categoryLabel(id) {
    const found = categories.find(c => c.id === id);
    return found ? found[lang] : (id || categories[0][lang]);
  }

  function categoryClass(id, mode) {
    const safe = String(id || "general").replace(/[^a-z0-9_-]/gi, "-");
    return (mode === "local" ? "local " : "") + "cat-" + safe;
  }

  function sourceHealthLabel(repo) {
    if (!itemHasSourceHealth(repo)) return repo && repo.mode ? repo.mode : "";
    if (!repo || !repo.exists) return t("sourceMissing");
    if (repo.type === "prompt") return t("sourcePromptOnly");
    if ((repo.skillCount || 0) <= 0) return t("sourceNoSkill");
    const prefix = repo.sourceKind === "manual" || repo.sourceKind === "local" ? t("sourceLocal") + " · " : "";
    return `${prefix}${repo.skillCount} ${t("importSkills")}`;
  }

  function sourceHealthClass(repo) {
    if (!itemHasSourceHealth(repo)) return "info";
    if (!repo || !repo.exists) return "error";
    if (repo.type === "prompt") return "info";
    if ((repo.skillCount || 0) <= 0) return "warn";
    return "ok";
  }

  function skillHealthLabel(skill) {
    const status = skill && skill.healthStatus ? skill.healthStatus : "info";
    const count = Number(skill && skill.healthIssueCount || 0);
    let label = t("skillHealthInfo");
    if (status === "ok") label = t("skillHealthOk");
    if (status === "warn") label = t("skillHealthWarn");
    if (status === "error") label = t("skillHealthError");
    if (status === "info") label = t("skillHealthInfo");
    return count > 0 ? `${label} · ${count}` : label;
  }

  function skillHealthClass(skill) {
    const status = skill && skill.healthStatus ? skill.healthStatus : "info";
    if (status === "ok" || status === "warn" || status === "error" || status === "info") return status;
    return "info";
  }

  function itemHasSkillHealth(item) {
    return !!item && Object.prototype.hasOwnProperty.call(item, "healthStatus");
  }

  function healthSortRank(status) {
    if (status === "error") return "0";
    if (status === "warn") return "1";
    if (status === "info") return "2";
    if (status === "ok") return "3";
    return "4";
  }

  function itemHasSourceHealth(item) {
    return !!item && (Object.prototype.hasOwnProperty.call(item, "exists") || Object.prototype.hasOwnProperty.call(item, "skillCount"));
  }

  function statusLabel(status) {
    if (status === "ok") return t("healthOk");
    if (status === "warn") return t("healthWarn");
    if (status === "error") return t("healthError");
    if (status === "info") return t("healthInfo");
    return status || "-";
  }

  function formatCheckTime(value) {
    if (!value) return t("never");
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value).replace("T", " ").replace(/\..+$/, "");
    return date.toLocaleString();
  }

  function appendLog(level, message) {
    if (!message) return;
    const entry = el("div", "log-entry " + level);
    const time = new Date().toLocaleTimeString();
    entry.textContent = `[${time}] ${message}`;
    dom.logBox.appendChild(entry);
    dom.logBox.scrollTop = dom.logBox.scrollHeight;
  }

  function toast(tone, message) {
    if (!message) return;
    const node = el("div", "toast " + tone);
    node.textContent = message;
    dom.toastHost.appendChild(node);
    window.setTimeout(() => {
      node.style.opacity = "0";
      node.style.transform = "translateY(8px) scale(.98)";
      window.setTimeout(() => node.remove(), 220);
    }, 3600);
  }

  function applyLanguage() {
    document.documentElement.lang = lang === "zh" ? "zh-CN" : lang;
    document.querySelectorAll("[data-i18n]").forEach(node => {
      node.textContent = t(node.dataset.i18n);
    });
    document.querySelectorAll("[data-i18n-placeholder]").forEach(node => {
      node.placeholder = t(node.dataset.i18nPlaceholder);
    });
    document.querySelectorAll(".lang-button").forEach(button => {
      button.classList.toggle("active", button.dataset.lang === lang);
    });
    applyTheme();
    dom.confirmTitle.textContent = t("confirmTitle");
    dom.confirmBody.textContent = t("confirmBody");
    dom.cancelConfirm.textContent = t("cancel");
    dom.acceptConfirm.textContent = t("confirmDelete");
    dom.miniStatus.textContent = busy ? t("running") : t("ready");
  }

  function t(key) {
    return (text[lang] && text[lang][key]) || text.zh[key] || key;
  }

  function formatText(key, values) {
    return t(key).replace(/\{(\w+)\}/g, (_, name) => {
      return Object.prototype.hasOwnProperty.call(values || {}, name) ? values[name] : "";
    });
  }

  function chooseLanguage() {
    const saved = localStorage.getItem("skillhub.lang");
    if (saved && text[saved]) return saved;
    const browser = (navigator.language || "").toLowerCase();
    if (browser.startsWith("ko")) return "ko";
    if (browser.startsWith("en")) return "en";
    return "zh";
  }

  function chooseTheme() {
    const saved = localStorage.getItem("skillhub.theme");
    return ["cute", "fresh", "dark"].includes(saved) ? saved : "cute";
  }

  function applyTheme() {
    document.body.dataset.theme = theme;
    document.querySelectorAll(".theme-button").forEach(button => {
      button.classList.toggle("active", button.dataset.theme === theme);
    });
  }

  function loadColumns(key) {
    try {
      const saved = JSON.parse(localStorage.getItem(columnStorageKey(key)) || "null");
      if (Array.isArray(saved) && saved.length === defaultColumns[key].length) {
        return saved.map(value => Math.max(70, Number(value) || 70));
      }
    } catch (error) {
    }
    return defaultColumns[key].slice();
  }

  function columnStorageKey(key) {
    return `skillhub.columns.v101.${key}`;
  }

  function playLogoSurprise(event) {
    const logo = dom.brandLogo;
    logo.classList.remove("jelly");
    void logo.offsetWidth;
    logo.classList.add("jelly");

    const rect = logo.getBoundingClientRect();
    const originX = rect.left + rect.width / 2;
    const originY = rect.top + rect.height / 2;
    const palette = theme === "dark"
      ? ["#8BE9FD", "#C4B5FD", "#FDE68A", "#34D399", "#FB7185"]
      : ["#22b88f", "#5b8ff7", "#ff9f7a", "#8b7cf6", "#ffd166"];
    const count = 22 + Math.floor(Math.random() * 12);

    for (let i = 0; i < count; i++) {
      const particle = el("span", Math.random() > 0.45 ? "logo-particle bubble" : "logo-particle spark");
      const angle = Math.random() * Math.PI * 2;
      const distance = 46 + Math.random() * 110;
      particle.style.left = `${originX}px`;
      particle.style.top = `${originY}px`;
      particle.style.setProperty("--dx", `${Math.cos(angle) * distance}px`);
      particle.style.setProperty("--dy", `${Math.sin(angle) * distance - 36}px`);
      particle.style.setProperty("--color", palette[i % palette.length]);
      particle.style.animationDelay = `${Math.random() * 90}ms`;
      document.body.appendChild(particle);
      window.setTimeout(() => particle.remove(), 1100);
    }
  }

  function el(tag, className) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    return node;
  }

  function installWindowInteractions() {
    const grip = 8;
    const cursorByEdge = {
      left: "ew-resize",
      right: "ew-resize",
      top: "ns-resize",
      bottom: "ns-resize",
      "top-left": "nwse-resize",
      "bottom-right": "nwse-resize",
      "top-right": "nesw-resize",
      "bottom-left": "nesw-resize"
    };

    document.addEventListener("mousemove", event => {
      const edge = resizeEdge(event, grip);
      document.body.style.cursor = edge ? cursorByEdge[edge] : "";
    });

    document.addEventListener("mouseleave", () => {
      document.body.style.cursor = "";
    });

    document.addEventListener("mousedown", event => {
      if (event.button !== 0) return;
      const edge = resizeEdge(event, grip);
      if (edge) {
        event.preventDefault();
        send("window.resize", { edge });
        return;
      }

      const titlebar = event.target.closest(".titlebar");
      const blocked = event.target.closest("button, input, select, textarea, a, .no-drag");
      if (titlebar && !blocked) {
        event.preventDefault();
        send("window.drag");
      }
    });

    document.querySelector(".titlebar").addEventListener("dblclick", event => {
      if (event.target.closest("button, input, select, textarea, a, .no-drag")) return;
      send("window.maximize");
    });
  }

  function resizeEdge(event, grip) {
    const x = event.clientX;
    const y = event.clientY;
    const w = window.innerWidth;
    const h = window.innerHeight;
    const left = x <= grip;
    const right = x >= w - grip;
    const top = y <= grip;
    const bottom = y >= h - grip;
    if (left && top) return "top-left";
    if (right && top) return "top-right";
    if (left && bottom) return "bottom-left";
    if (right && bottom) return "bottom-right";
    if (left) return "left";
    if (right) return "right";
    if (top) return "top";
    if (bottom) return "bottom";
    return "";
  }
}());
