import type { Lang } from "./i18n";

type LocalizableSkill = {
  category?: string;
  description?: string;
  isRouterHub?: boolean;
  name: string;
  source?: string;
  tags?: string[];
};

export function cleanSkillDescription(value: string | undefined | null) {
  if (!value) return "";
  return String(value).replace(/^\s*\[(?:ROUTER-HUB|CHILD-SKILL)\]\s*/i, "").trim();
}

export function localizedSkillDescription(skill: LocalizableSkill, lang: Lang) {
  const original = cleanSkillDescription(skill.description);
  if (lang === "en") return original;
  if (lang === "zh" && containsHan(original)) return original;
  if (lang === "ko" && containsHangul(original)) return original;

  const rawDescription = skill.description ?? "";
  const router = skill.isRouterHub === true || rawDescription.includes("[ROUTER-HUB]");
  const collection = skill.source?.trim() || skill.name;
  if (router) {
    return lang === "ko"
      ? `부모 Skill “${collection}”입니다. 이 소스 안의 하위 Skill을 작업에 맞게 자동 선택합니다.`
      : `父 Skill“${collection}”的统一入口，会按任务自动选择并加载本来源内的子 Skill。`;
  }

  const text = [skill.name, skill.category, rawDescription, ...(skill.tags ?? [])]
    .join(" ")
    .toLowerCase();
  if (lang === "ko") return koreanSummary(skill.name, text);
  return chineseSummary(skill.name, text);
}

function chineseSummary(name: string, text: string) {
  if (hasAny(text, ["figure", "plot", "chart", "diagram", "visualization"])) {
    return "用于科研图表的规划、生成、编辑与质量优化。";
  }
  if (hasAny(text, ["citation", "reference", "verify", "evidence", "doi"])) {
    return "用于引用、参考文献与证据的核验和整理。";
  }
  if (hasAny(text, ["review", "reviewer", "rebuttal", "peer-review"])) {
    return "用于论文评审、修改建议与审稿回复。";
  }
  if (hasAny(text, ["paper", "manuscript", "writing", "draft", "academic"])) {
    return "用于科研论文的写作、润色与结构优化。";
  }
  if (hasAny(text, ["literature", "research", "search", "survey", "arxiv"])) {
    return "用于文献检索、研究分析与综述整理。";
  }
  if (hasAny(text, ["security", "secure", "audit", "vulnerability", "threat"])) {
    return "用于安全检查、风险分析与修复建议。";
  }
  if (hasAny(text, ["browser", "web", "scrape", "crawl", "playwright"])) {
    return "用于网页浏览、信息提取与浏览器自动化。";
  }
  if (hasAny(text, ["slide", "presentation", "ppt", "deck"])) {
    return "用于演示文稿的规划、制作与视觉优化。";
  }
  if (hasAny(text, ["database", "dataset", "analysis", "statistics", "omics"])) {
    return "用于数据检索、处理、分析与结果解释。";
  }
  if (hasAny(text, ["image", "photo", "illustration", "render"])) {
    return "用于图像生成、编辑与视觉内容制作。";
  }
  if (hasAny(text, ["design", "ui", "ux", "frontend", "layout"])) {
    return "用于界面设计、前端实现与体验优化。";
  }
  if (hasAny(text, ["code", "debug", "test", "developer", "android", "ios"])) {
    return "用于代码实现、调试、测试与工程质量改进。";
  }
  if (hasAny(text, ["prompt", "instruction", "rewrite", "polish"])) {
    return "用于提示词编写、改写与表达优化。";
  }
  return `用于处理“${humanize(name)}”相关任务。`;
}

function koreanSummary(name: string, text: string) {
  if (hasAny(text, ["figure", "plot", "chart", "diagram", "visualization"])) {
    return "연구용 도표를 기획·생성·편집하고 품질을 개선합니다.";
  }
  if (hasAny(text, ["paper", "manuscript", "writing", "academic", "citation", "research"])) {
    return "학술 조사, 논문 작성 및 근거 정리를 지원합니다.";
  }
  if (hasAny(text, ["security", "secure", "audit", "vulnerability"])) {
    return "보안 점검, 위험 분석 및 수정 제안을 지원합니다.";
  }
  if (hasAny(text, ["browser", "web", "scrape", "crawl"])) {
    return "웹 탐색, 정보 추출 및 브라우저 자동화에 사용합니다.";
  }
  if (hasAny(text, ["code", "debug", "test", "developer"])) {
    return "코드 구현, 디버깅, 테스트 및 품질 개선에 사용합니다.";
  }
  return `“${humanize(name)}” 관련 작업을 처리합니다.`;
}

function hasAny(text: string, keywords: string[]) {
  return keywords.some(keyword => text.includes(keyword));
}

function humanize(value: string) {
  return value.replace(/[-_]+/g, " ").trim() || value;
}

function containsHan(value: string) {
  return /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u.test(value);
}

function containsHangul(value: string) {
  return /[\uac00-\ud7af]/u.test(value);
}
