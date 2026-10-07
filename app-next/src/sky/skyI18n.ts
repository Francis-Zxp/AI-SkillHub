// Strings for the sky islands' world controls: weather, climates, re-roll,
// plurals and empty states, in every shipped language. Kept apart from
// i18n.ts so the scene work never collides with the shared dictionary. The
// language is read the way i18n.ts stores it: the saved choice, then the
// document language it sets, then the browser's.
import type { SkyWeatherKind, SkyWeatherSetting } from "../skyScene";
import type { ClimateId } from "./climates";

export type SkyLang = "zh" | "en" | "ko";

const LANG_STORAGE_KEY = "ai-skillhub-lang";

export function skyLang(): SkyLang {
  try {
    const saved = window.localStorage.getItem(LANG_STORAGE_KEY);
    if (saved === "zh" || saved === "en" || saved === "ko") return saved;
  } catch {
    /* storage unavailable */
  }
  const tag = (typeof document !== "undefined" && document.documentElement.lang) || (typeof navigator !== "undefined" ? navigator.language : "") || "";
  const lower = tag.toLowerCase();
  if (lower.startsWith("zh")) return "zh";
  if (lower.startsWith("ko")) return "ko";
  return lower ? "en" : "zh";
}

type Words = {
  world: string;
  worldTitle: string;
  weather: string;
  auto: string;
  autoNow: (name: string) => string;
  weathers: Record<SkyWeatherKind, string>;
  auroraNight: string;
  reroll: string;
  rerollHint: string;
  rerolling: string;
  climates: string;
  climateNames: Record<ClimateId, string>;
  reducedMotion: string;
  empty: string;
  emptyHint: string;
  addSource: string;
  skills: (count: number) => string;
  prompts: (count: number) => string;
  categories: (count: number) => string;
  summary: (categories: number, skills: number) => string;
};

const plural = (lang: SkyLang, count: number, one: string, other: string) => {
  try {
    return new Intl.PluralRules(lang).select(count) === "one" ? one : other;
  } catch {
    return count === 1 ? one : other;
  }
};

const WORDS: Record<SkyLang, Words> = {
  zh: {
    world: "世界",
    worldTitle: "天气与岛屿气候",
    weather: "天气",
    auto: "自动",
    autoNow: name => `自动 · ${name}`,
    weathers: { clear: "晴", cloudy: "多云", rain: "小雨", storm: "雷雨", snow: "降雪", fog: "薄雾", rainbow: "雨后彩虹", petals: "落英", aurora: "极光" },
    auroraNight: "极光只在夜晚出现",
    reroll: "🎲 换一个世界",
    rerollHint: "重新随机岛屿的气候和自动天气",
    rerolling: "正在生成新世界…",
    climates: "本次的岛屿气候",
    climateNames: { temperate: "温带草甸", alpine: "雪山", desert: "沙漠台地", tropical: "热带海岛", autumn: "秋林", volcanic: "火山", crystal: "晶石", terraced: "梯田" },
    reducedMotion: "系统已开启“减少动态效果”，场景保持静止",
    empty: "添加第一个技能来源",
    emptyHint: "添加技能来源后，每个分类都会变成一座天空岛。",
    addSource: "+ 添加来源",
    skills: count => `${count.toLocaleString()} Skills`,
    prompts: count => `${count.toLocaleString()} Prompt 来源`,
    categories: count => `${count.toLocaleString()} 个分类`,
    summary: (categories, skills) => `${categories.toLocaleString()} 个分类 · ${skills.toLocaleString()} 个 Skills`
  },
  en: {
    world: "World",
    worldTitle: "Weather and island climates",
    weather: "Weather",
    auto: "Auto",
    autoNow: name => `Auto · ${name}`,
    weathers: { clear: "Clear", cloudy: "Cloudy", rain: "Light rain", storm: "Thunderstorm", snow: "Snow", fog: "Mist", rainbow: "Rainbow", petals: "Falling petals", aurora: "Aurora" },
    auroraNight: "Aurora appears only at night",
    reroll: "🎲 New world",
    rerollHint: "Re-roll the island climates and the automatic weather",
    rerolling: "Building a new world…",
    climates: "Island climates",
    climateNames: { temperate: "Meadow", alpine: "Snowy peak", desert: "Desert mesa", tropical: "Tropical isle", autumn: "Autumn woods", volcanic: "Volcano", crystal: "Crystal", terraced: "Rice terraces" },
    reducedMotion: "Your system asks for reduced motion, so the scene stays still",
    empty: "Add your first skill source",
    emptyHint: "Add a skill source and each category becomes a sky island.",
    addSource: "+ Add source",
    skills: count => `${count.toLocaleString()} ${plural("en", count, "Skill", "Skills")}`,
    prompts: count => `${count.toLocaleString()} ${plural("en", count, "Prompt source", "Prompt sources")}`,
    categories: count => `${count.toLocaleString()} ${plural("en", count, "category", "categories")}`,
    summary: (categories, skills) => `${categories.toLocaleString()} ${plural("en", categories, "category", "categories")} · ${skills.toLocaleString()} ${plural("en", skills, "Skill", "Skills")}`
  },
  ko: {
    world: "세계",
    worldTitle: "날씨와 섬 기후",
    weather: "날씨",
    auto: "자동",
    autoNow: name => `자동 · ${name}`,
    weathers: { clear: "맑음", cloudy: "흐림", rain: "가랑비", storm: "뇌우", snow: "눈", fog: "옅은 안개", rainbow: "무지개", petals: "꽃잎", aurora: "오로라" },
    auroraNight: "오로라는 밤에만 나타납니다",
    reroll: "🎲 새 세계",
    rerollHint: "섬 기후와 자동 날씨를 다시 무작위로 정합니다",
    rerolling: "새 세계를 만드는 중…",
    climates: "이번 섬 기후",
    climateNames: { temperate: "온대 초원", alpine: "설산", desert: "사막 메사", tropical: "열대 섬", autumn: "가을 숲", volcanic: "화산", crystal: "수정", terraced: "계단식 논" },
    reducedMotion: "시스템에서 동작 줄이기가 켜져 있어 장면이 멈춰 있습니다",
    empty: "첫 스킬 소스를 추가하세요",
    emptyHint: "스킬 소스를 추가하면 분류마다 하늘섬이 생깁니다.",
    addSource: "+ 소스 추가",
    skills: count => `Skills ${count.toLocaleString()}개`,
    prompts: count => `Prompt 소스 ${count.toLocaleString()}개`,
    categories: count => `분류 ${count.toLocaleString()}개`,
    summary: (categories, skills) => `분류 ${categories.toLocaleString()}개 · Skills ${skills.toLocaleString()}개`
  }
};

export function skyWords(lang: SkyLang = skyLang()): Words {
  return WORDS[lang] ?? WORDS.zh;
}

/** Glyph per weather for the compact control (text presentation). */
export const WEATHER_GLYPHS: Record<SkyWeatherSetting, string> = {
  auto: "◌",
  clear: "☀︎",
  cloudy: "☁︎",
  rain: "☂︎",
  storm: "⚡︎",
  snow: "❄︎",
  fog: "≈",
  rainbow: "◠",
  petals: "✿",
  aurora: "✧"
};
