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
    title: "本机 Skills", body: "自动发现各 AI 工具中已有的技能。查看原文，或将副本纳入技能库，继续编辑、分类和分发。",
    scan: "重新扫描", scanning: "正在扫描本机技能…", project: "项目文件夹（可选）", projectHint: "填写绝对路径，包含项目级 Skills", scanProject: "扫描项目",
    all: "全部工具", search: "搜索名称、说明或路径", external: "待纳入", managed: "已管理", allStatus: "全部状态", link: "链接", directory: "目录",
    global: "用户级", projectScope: "项目级", details: "查看原文", import: "纳入技能库", copy: "复制路径", copied: "路径已复制", empty: "没有匹配的 Skills", emptyBody: "只识别含 SKILL.md 的目录。可更换筛选或填写项目路径后重试。",
    preview: "浏览器预览无法读取本机目录。请在桌面版使用自动发现。", roots: "扫描目录与诊断", limited: "已达到扫描上限，结果不完整。请缩小到具体项目后重试。", original: "SKILL.md 原文", close: "关闭原文", reading: "正在读取…", error: "操作失败，请重试。", found: "条记录", importHelp: "纳入时创建受管理副本，并经过现有安全检查；原目录保留，后续编辑副本不会回写原件。", more: "显示更多", failed: "列表保留上次扫描结果。", suggested: "从本机 Skills 选择的目录", usePath: "使用此路径", draftNote: "已有导入草稿。使用此路径将替换当前草稿。", dismiss: "保留原草稿", noImport: "此项已管理，或不适合直接复制。", shown: "当前显示"
  },
  en: {
    title: "Skills on this computer", body: "Discover skills already installed in your AI tools. Read the original or manage a copy in your library to edit, organize and distribute it.",
    scan: "Rescan", scanning: "Scanning local skills…", project: "Project folder (optional)", projectHint: "Enter an absolute path to include project skills", scanProject: "Scan project",
    all: "All tools", search: "Search name, description or path", external: "Unmanaged", managed: "Managed", allStatus: "All states", link: "Link", directory: "Folder",
    global: "User", projectScope: "Project", details: "Read original", import: "Add to library", copy: "Copy path", copied: "Path copied", empty: "No matching skills", emptyBody: "Only folders containing SKILL.md are recognized. Change filters or enter a project path and retry.",
    preview: "Browser preview cannot read local folders. Use discovery in the desktop app.", roots: "Scanned folders and diagnostics", limited: "The scan limit was reached; results are incomplete. Retry with a specific project.", original: "Original SKILL.md", close: "Close original", reading: "Reading…", error: "The operation failed. Please retry.", found: "records", importHelp: "Adding creates a managed copy through the existing security checks. The original remains in place; edits to the copy do not write back to it.", more: "Show more", failed: "The list retains the previous scan results.", suggested: "Folder selected from local skills", usePath: "Use this path", draftNote: "An import draft exists. Using this path replaces that draft.", dismiss: "Keep existing draft", noImport: "Already managed or unsuitable for direct copying.", shown: "Showing"
  },
  ko: {
    title: "이 컴퓨터의 Skills", body: "AI 도구에 이미 설치된 스킬을 찾습니다. 원문을 확인하거나 사본을 라이브러리에 추가해 편집, 분류, 배포할 수 있습니다.",
    scan: "다시 검색", scanning: "로컬 스킬 검색 중…", project: "프로젝트 폴더 (선택)", projectHint: "프로젝트 스킬을 포함할 절대 경로", scanProject: "프로젝트 검색",
    all: "모든 도구", search: "이름, 설명 또는 경로 검색", external: "미관리", managed: "관리 중", allStatus: "모든 상태", link: "링크", directory: "폴더",
    global: "사용자", projectScope: "프로젝트", details: "원문 보기", import: "라이브러리에 추가", copy: "경로 복사", copied: "경로 복사됨", empty: "일치하는 스킬 없음", emptyBody: "SKILL.md가 있는 폴더만 인식합니다. 필터를 변경하거나 프로젝트 경로로 다시 검색하세요.",
    preview: "브라우저 미리보기에서는 로컬 폴더를 읽을 수 없습니다. 데스크톱 앱에서 사용하세요.", roots: "검색 폴더 및 진단", limited: "검색 한도에 도달하여 결과가 일부만 표시됩니다. 특정 프로젝트로 다시 검색하세요.", original: "SKILL.md 원문", close: "원문 닫기", reading: "읽는 중…", error: "작업에 실패했습니다. 다시 시도하세요.", found: "개 항목", importHelp: "기존 보안 검사를 거쳐 관리 사본을 생성합니다. 원본은 유지되며 사본의 수정 사항은 원본에 반영되지 않습니다.", more: "더 보기", failed: "목록에는 이전 검색 결과가 유지됩니다.", suggested: "로컬 스킬에서 선택한 폴더", usePath: "이 경로 사용", draftNote: "가져오기 초안이 있습니다. 이 경로를 사용하면 초안을 대체합니다.", dismiss: "기존 초안 유지", noImport: "이미 관리 중이거나 직접 복사할 수 없습니다.", shown: "표시 중"
  }
};
export function externalSkillsText(key: keyof typeof copy.en) { return copy[getLang()][key]; }

export function filterExternalSkills(skills: ExternalAgentSkill[], query: string, agent: string, status: string) {
  const needle = query.trim().toLocaleLowerCase();
  return skills.filter(skill => (agent === "all" || skill.agentId === agent)
    && (status === "all" || (status === "managed" ? skill.managed : !skill.managed))
    && (!needle || [skill.name, skill.description, skill.path, skill.agentName].some(value => value.toLocaleLowerCase().includes(needle))));
}
