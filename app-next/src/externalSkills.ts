import { getLang } from "./i18n";

export type ExternalAgentSkill = {
  id: string; name: string; description: string; path: string; canonicalPath: string;
  agentId: string; agentName: string; scope: string; storageKind: "link" | "directory";
  managed: boolean; canImport: boolean;
};
export type ExternalAgentSkillInventory = {
  generatedAt: string;
  roots: Array<{ agentId: string; agentName: string; scope: string; path: string; status: string; skillCount: number }>;
  skills: ExternalAgentSkill[];
  warnings: string[];
  truncated: boolean;
};

const copy = {
  zh: {
    title: "本机 Skills", body: "查看各 AI 工具已有的技能。同一真实目录的入口合并显示；需要独立编辑时，可复制到技能库。",
    scan: "重新扫描", scanning: "正在扫描本机技能…", project: "项目文件夹（可选）", projectHint: "填写绝对路径，包含项目级 Skills", scanProject: "扫描项目",
    all: "全部工具", search: "搜索名称、说明或路径", external: "外部目录", managed: "已管理", allStatus: "全部状态", link: "链接", directory: "目录",
    global: "用户级", projectScope: "项目级", details: "查看原文", import: "复制到技能库", copy: "复制路径", copied: "路径已复制", empty: "没有匹配的 Skills", emptyBody: "只识别含 SKILL.md 的目录。可更换筛选或填写项目路径后重试。",
    previous: "上一页", next: "下一页", pagination: "技能分页", page: "第 {page} / {pages} 页", range: "显示 {from}–{to} / {total} 个技能", totals: "{skills} 个技能 · {entries} 个工具入口", pageSize: "每页 20 个", entryPaths: "工具入口与路径", realPath: "真实目录", managedLink: "链接到技能库，无需重复复制", managedHelp: "已在技能库管理，无需重复复制", externalHelp: "外部目录，复制后独立管理；原件保留。",
    preview: "浏览器预览无法读取本机目录。请在桌面版使用自动发现。", roots: "扫描目录与诊断", limited: "已达到扫描上限，结果不完整。请缩小到具体项目后重试。", original: "SKILL.md 原文", close: "关闭原文", reading: "正在读取…", error: "操作失败，请重试。", found: "条记录", importHelp: "复制前会进行安全检查；后续编辑和分类仅作用于技能库副本，不会回写原件。", more: "显示更多", failed: "列表保留上次扫描结果。", suggested: "从本机 Skills 选择的目录", usePath: "使用此路径", draftNote: "已有导入草稿。使用此路径将替换当前草稿。", dismiss: "保留原草稿", noImport: "此项已管理，或不适合直接复制。", shown: "当前显示"
  },
  en: {
    title: "Skills on this computer", body: "See skills in your AI tools. Entries sharing one physical folder appear together. Copy a skill to your library to edit it independently.",
    scan: "Rescan", scanning: "Scanning local skills…", project: "Project folder (optional)", projectHint: "Enter an absolute path to include project skills", scanProject: "Scan project",
    all: "All tools", search: "Search name, description or path", external: "External folder", managed: "Managed", allStatus: "All states", link: "Link", directory: "Folder",
    global: "User", projectScope: "Project", details: "Read original", import: "Copy to library", copy: "Copy path", copied: "Path copied", empty: "No matching skills", emptyBody: "Only folders containing SKILL.md are recognized. Change filters or enter a project path and retry.",
    previous: "Previous", next: "Next", pagination: "Skill pages", page: "Page {page} of {pages}", range: "Showing {from}–{to} of {total} skills", totals: "{skills} skills · {entries} tool entries", pageSize: "20 per page", entryPaths: "Tool entries and paths", realPath: "Physical folder", managedLink: "Linked to the library; no copy needed", managedHelp: "Already managed in the library; no copy needed", externalHelp: "External folder. A copy is managed independently; the original stays in place.",
    preview: "Browser preview cannot read local folders. Use discovery in the desktop app.", roots: "Scanned folders and diagnostics", limited: "The scan limit was reached; results are incomplete. Retry with a specific project.", original: "Original SKILL.md", close: "Close original", reading: "Reading…", error: "The operation failed. Please retry.", found: "records", importHelp: "Adding creates a managed copy through the existing security checks. The original remains in place; edits to the copy do not write back to it.", more: "Show more", failed: "The list retains the previous scan results.", suggested: "Folder selected from local skills", usePath: "Use this path", draftNote: "An import draft exists. Using this path replaces that draft.", dismiss: "Keep existing draft", noImport: "Already managed or unsuitable for direct copying.", shown: "Showing"
  },
  ko: {
    title: "이 컴퓨터의 Skills", body: "AI 도구의 기존 스킬을 확인합니다. 실제 폴더가 같은 항목은 함께 표시됩니다. 독립적으로 편집하려면 라이브러리로 복사하세요.",
    scan: "다시 검색", scanning: "로컬 스킬 검색 중…", project: "프로젝트 폴더 (선택)", projectHint: "프로젝트 스킬을 포함할 절대 경로", scanProject: "프로젝트 검색",
    all: "모든 도구", search: "이름, 설명 또는 경로 검색", external: "외부 폴더", managed: "관리 중", allStatus: "모든 상태", link: "링크", directory: "폴더",
    global: "사용자", projectScope: "프로젝트", details: "원문 보기", import: "라이브러리로 복사", copy: "경로 복사", copied: "경로 복사됨", empty: "일치하는 스킬 없음", emptyBody: "SKILL.md가 있는 폴더만 인식합니다. 필터를 변경하거나 프로젝트 경로로 다시 검색하세요.",
    previous: "이전", next: "다음", pagination: "스킬 페이지", page: "{page} / {pages} 페이지", range: "{total}개 중 {from}–{to} 표시", totals: "스킬 {skills}개 · 도구 항목 {entries}개", pageSize: "페이지당 20개", entryPaths: "도구 항목 및 경로", realPath: "실제 폴더", managedLink: "라이브러리에 연결됨 · 복사 불필요", managedHelp: "라이브러리에서 관리 중 · 복사 불필요", externalHelp: "외부 폴더입니다. 사본은 독립적으로 관리되며 원본은 유지됩니다.",
    preview: "브라우저 미리보기에서는 로컬 폴더를 읽을 수 없습니다. 데스크톱 앱에서 사용하세요.", roots: "검색 폴더 및 진단", limited: "검색 한도에 도달하여 결과가 일부만 표시됩니다. 특정 프로젝트로 다시 검색하세요.", original: "SKILL.md 원문", close: "원문 닫기", reading: "읽는 중…", error: "작업에 실패했습니다. 다시 시도하세요.", found: "개 항목", importHelp: "기존 보안 검사를 거쳐 관리 사본을 생성합니다. 원본은 유지되며 사본의 수정 사항은 원본에 반영되지 않습니다.", more: "더 보기", failed: "목록에는 이전 검색 결과가 유지됩니다.", suggested: "로컬 스킬에서 선택한 폴더", usePath: "이 경로 사용", draftNote: "가져오기 초안이 있습니다. 이 경로를 사용하면 초안을 대체합니다.", dismiss: "기존 초안 유지", noImport: "이미 관리 중이거나 직접 복사할 수 없습니다.", shown: "표시 중"
  }
};
export function externalSkillsText(key: keyof typeof copy.en, values: Record<string, string | number> = {}) {
  return Object.entries(values).reduce((value, [name, replacement]) => value.replaceAll(`{${name}}`, String(replacement)), copy[getLang()][key]);
}

export type ExternalSkillGroup = ExternalAgentSkill & { entries: ExternalAgentSkill[] };
export const EXTERNAL_SKILLS_PAGE_SIZE = 20;

function canonicalKey(skill: ExternalAgentSkill) {
  const path = skill.canonicalPath.trim();
  if (!path) return `entry:${skill.id}`;
  // Windows canonical paths are case-insensitive; Unix paths must retain case.
  if (/^(?:[a-z]:[\\/]|\\\\)/i.test(path)) {
    return path.replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\/, "").replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
  }
  return path.replace(/\/+$/, "");
}

export function groupExternalSkills(skills: ExternalAgentSkill[]): ExternalSkillGroup[] {
  const groups = new Map<string, ExternalSkillGroup>();
  for (const skill of skills) {
    const key = canonicalKey(skill);
    const group = groups.get(key);
    if (group) {
      group.entries.push(skill);
      group.managed ||= skill.managed;
      group.canImport = !group.managed && group.canImport && skill.canImport;
    } else groups.set(key, { ...skill, entries: [skill] });
  }
  return [...groups.values()];
}

export function filterExternalSkillGroups(groups: ExternalSkillGroup[], query: string, agent: string, status: string) {
  return groups.filter(group => (status === "all" || (status === "managed" ? group.managed : !group.managed))
    && filterExternalSkills(group.entries, query, agent, "all").length > 0);
}

export function filterExternalSkills(skills: ExternalAgentSkill[], query: string, agent: string, status: string) {
  const needle = query.trim().toLocaleLowerCase();
  return skills.filter(skill => (agent === "all" || skill.agentId === agent)
    && (status === "all" || (status === "managed" ? skill.managed : !skill.managed))
    && (!needle || [skill.name, skill.description, skill.path, skill.canonicalPath, skill.agentName].some(value => value.toLocaleLowerCase().includes(needle))));
}
