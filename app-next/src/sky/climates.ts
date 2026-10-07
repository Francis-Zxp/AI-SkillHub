// Island climates: orthogonal to the category theme. The theme decides the
// buildings, props, animals and roof colour; the climate decides the ground,
// the cliff, the plants, the water and the terrain profile. Climates come
// from the world seed and the island id, so the same seed always builds the
// same world and a re-roll visibly changes it. Pure data and logic: no
// three.js, so React and the tests can use it without the scene chunk.
import { hashString, seededRandom } from "./noise";

export const CLIMATE_IDS = ["temperate", "alpine", "desert", "tropical", "autumn", "volcanic", "crystal", "terraced"] as const;
export type ClimateId = (typeof CLIMATE_IDS)[number];

/** Terrain profile (terrain.ts). */
export type TerrainProfile = "rolling" | "peak" | "mesa" | "dome" | "crater" | "terraces";
export type WaterKind = "water" | "lagoon" | "ice" | "lava";

/** Ground colours at noon; other times of day filter them like the palette. */
export type ClimateGround = {
  light: string;
  dark: string;
  alt: string;
  /** How strongly the third patch colour shows (0..1). */
  altMix: number;
  path: string;
};

export type ClimateCliff = { soil: string; earthA: string; earthB: string; rockDeep: string };

export type ClimateSpec = {
  id: ClimateId;
  profile: TerrainProfile;
  /** Legend swatch (sRGB hex). */
  swatch: string;
  /** Calm climates may host the unfiled island. */
  calm: boolean;
  hints: RegExp | null;
  ground: ClimateGround | null;
  cliff: ClimateCliff | null;
  /** A layer by height and distance (snow on peaks, ash on a cone). */
  /** `rim`: cover inside this rim distance (-1: off); `cover`: the top
   * fraction of a peak or cone it covers. */
  cap: { color: string; rim: number; cover: number } | null;
  /** Exposed rock on steep slopes. */
  slope: { color: string; below: number } | null;
  /** Sand beach at the rim (normalized distance where it starts). */
  beach: { color: string; from: number } | null;
  /** Horizontal strata bands in the cliff. */
  strata: { color: string; strength: number } | null;
  /** Narrow mineral veins in the cliff; glow is emissive strength. */
  vein: { color: string; glow: number } | null;
  /** Fallen-leaf flecks on the ground. */
  flecks: { a: string; b: string; density: number } | null;
  /** Water films on flat terraces. */
  film: { color: string; strength: number } | null;
  /** Wind ripple bands on sand. */
  dunes: number;
  water: WaterKind;
  pond: "theme" | "always" | "never";
  waterfall: "theme" | "never" | "always";
  /** Kit models replacing the theme trees (null keeps the theme's). */
  trees: string[] | null;
  leaves: string[] | null;
  treeDensity: number;
  bushes: string[] | null;
  /** Bush colours (null: the leaf colours). */
  bushTints: string[] | null;
  bushDensity: number;
  rocks: { color: string; count: number } | null;
  flowers: number;
  flowerColors: string[] | null;
  flowerScale: number;
  grass: { models: string[]; tint: string | null; density: number; rimOnly: boolean };
  mushrooms: boolean | null;
  /** Extras: palms by the water, sandstone pillars, crystals, floating
   * shards, smoke from the crater. */
  palms: number;
  pillars: number;
  crystals: number;
  shards: number;
  smoke: boolean;
  /** Animals and villagers keep to the open ground on every climate. */
  animals: boolean;
};

const base: Omit<ClimateSpec, "id" | "profile" | "swatch" | "calm" | "hints"> = {
  ground: null,
  cliff: null,
  cap: null,
  slope: null,
  beach: null,
  strata: null,
  vein: null,
  flecks: null,
  film: null,
  dunes: 0,
  water: "water",
  pond: "theme",
  waterfall: "theme",
  trees: null,
  leaves: null,
  treeDensity: 1,
  bushes: null,
  bushTints: null,
  bushDensity: 1,
  rocks: null,
  flowers: 1,
  flowerColors: null,
  flowerScale: 1,
  grass: { models: ["grass-1", "grass-2"], tint: null, density: 1, rimOnly: false },
  mushrooms: null,
  palms: 0,
  pillars: 0,
  crystals: 0,
  shards: 0,
  smoke: false,
  animals: true
};

export const CLIMATES: Record<ClimateId, ClimateSpec> = {
  temperate: {
    ...base,
    id: "temperate",
    profile: "rolling",
    swatch: "#7cc24f",
    calm: true,
    hints: /未归档|unfiled|其他|其它|other|misc|未分类|收件|inbox|日常|daily|life|生活/gi
  },
  alpine: {
    ...base,
    id: "alpine",
    profile: "peak",
    swatch: "#cfe3f4",
    calm: false,
    hints: /研究|research|科研|文献|literature|survey|学术|academ|science|探索|物理|physics|数学|math|理论|theory/gi,
    ground: { light: "#a9d27a", dark: "#7fb36a", alt: "#c4dd8c", altMix: 0.2, path: "#d9d2c4" },
    cliff: { soil: "#d2d8df", earthA: "#a3adb9", earthB: "#848f9d", rockDeep: "#4b5466" },
    cap: { color: "#f4f8fd", rim: 0.72, cover: 0.42 },
    slope: { color: "#8f9db0", below: 0.74 },
    water: "ice",
    waterfall: "never",
    trees: ["snowpine-5", "snowpine-9"],
    leaves: ["#2f7a5c", "#3a8a64", "#2a6e58", "#3f9070"],
    treeDensity: 0.85,
    bushes: ["bush-3"],
    bushDensity: 0.35,
    rocks: { color: "#c9d2dd", count: 1.4 },
    flowers: 0,
    grass: { models: ["grass-1", "grass-2"], tint: null, density: 0.5, rimOnly: true },
    mushrooms: false
  },
  desert: {
    ...base,
    id: "desert",
    profile: "mesa",
    swatch: "#eccb87",
    calm: false,
    hints: /代码|code|dev|software|工程|engineer|tool|工具|自动|automation|运维|ops|shell|cli|脚本|script|跑/gi,
    ground: { light: "#f2d9a0", dark: "#e3c07f", alt: "#f7e6b8", altMix: 0.35, path: "#d6a468" },
    cliff: { soil: "#ecbf8e", earthA: "#d58f60", earthB: "#bb6e47", rockDeep: "#7b4a3b" },
    strata: { color: "#f3cf9f", strength: 0.42 },
    dunes: 1,
    water: "lagoon",
    pond: "always",
    waterfall: "never",
    trees: ["cactus-1", "cactus-2"],
    leaves: ["#5f9e4a", "#6aa84f", "#4f8c46", "#77b356"],
    treeDensity: 0.45,
    bushes: ["bush-3", "bush-8"],
    bushTints: ["#a9a05e", "#b8aa6a", "#9a8f55"],
    bushDensity: 0.45,
    rocks: { color: "#dba274", count: 1.1 },
    flowers: 0.15,
    flowerColors: ["#ff7aa2", "#ffd45a"],
    grass: { models: ["grass-1", "grass-2"], tint: "#c9b26a", density: 0.35, rimOnly: false },
    mushrooms: false,
    palms: 3,
    pillars: 2
  },
  tropical: {
    ...base,
    id: "tropical",
    profile: "dome",
    swatch: "#3fc6b4",
    calm: false,
    hints: /设计|design|前端|ui|界面|配色|旅行|travel|营销|market|social|社交|内容|content|视频|video/gi,
    ground: { light: "#86d85c", dark: "#48b25a", alt: "#b0e374", altMix: 0.25, path: "#efd9a4" },
    beach: { color: "#f7e5b4", from: 0.84 },
    water: "lagoon",
    pond: "always",
    trees: ["palm-1", "palm-2", "round-23"],
    leaves: ["#3fae4c", "#52bf48", "#3a9a45", "#62c552"],
    treeDensity: 0.95,
    bushes: ["bush-3", "bush-8"],
    rocks: { color: "#cdbfa8", count: 0.7 },
    flowers: 1.6,
    flowerColors: ["#ff5a7a", "#ffb03a", "#ff7ad0", "#ffffff", "#ffd45a"],
    flowerScale: 1.7,
    palms: 2
  },
  autumn: {
    ...base,
    id: "autumn",
    profile: "rolling",
    swatch: "#e48a3a",
    calm: true,
    hints: /写作|写|论文|paper|writ|润色|文稿|essay|book|阅读|书|翻译|报告|report|slide|ppt|演示|故事|story/gi,
    ground: { light: "#cfc65c", dark: "#a9a84c", alt: "#e4a84c", altMix: 0.4, path: "#e2c08c" },
    flecks: { a: "#e8743a", b: "#f2b83f", density: 1 },
    leaves: ["#e8743a", "#d9502e", "#f2b13c", "#f0c94a", "#c8452f", "#e89a3a"],
    flowerColors: ["#f2b13c", "#ffffff", "#e8743a"],
    flowers: 0.6,
    mushrooms: true
  },
  volcanic: {
    ...base,
    id: "volcanic",
    profile: "crater",
    swatch: "#e2553a",
    calm: false,
    hints: /安全|security|audit|审计|漏洞|vuln|hack|攻防|红队|渗透|pentest|火|fire|性能|perf|压测|benchmark/gi,
    ground: { light: "#a19a94", dark: "#7f7873", alt: "#86a256", altMix: 0.32, path: "#b5a595" },
    cliff: { soil: "#6d6668", earthA: "#504a50", earthB: "#3f3a41", rockDeep: "#25222a" },
    cap: { color: "#4a4344", rim: -1, cover: 0.85 },
    slope: { color: "#57504f", below: 0.8 },
    vein: { color: "#ff6a26", glow: 1 },
    water: "lava",
    pond: "always",
    waterfall: "always",
    trees: ["deadtree"],
    leaves: ["#4a3f3a", "#5a4d45", "#3e3533"],
    treeDensity: 0.3,
    bushes: ["bush-8"],
    bushDensity: 0.2,
    rocks: { color: "#45404a", count: 1.6 },
    flowers: 0,
    grass: { models: ["grass-1", "grass-2"], tint: "#748f48", density: 0.3, rimOnly: false },
    mushrooms: false,
    smoke: true
  },
  crystal: {
    ...base,
    id: "crystal",
    profile: "rolling",
    swatch: "#b48cf0",
    calm: false,
    hints: /绘|图|figure|plot|chart|art|美术|视觉|画|创意|creative|idea|灵感|magic|魔法|prompt/gi,
    ground: { light: "#a9d391", dark: "#7bb07e", alt: "#c8b4ec", altMix: 0.45, path: "#e6d8f0" },
    vein: { color: "#b27cf2", glow: 0.7 },
    leaves: ["#b58cf0", "#8fd0e8", "#f4a6c0", "#a6d36a", "#9fb8f4"],
    rocks: { color: "#bdb4cc", count: 1 },
    flowerColors: ["#b58cf0", "#8fd0e8", "#ffffff"],
    crystals: 1,
    shards: 3
  },
  terraced: {
    ...base,
    id: "terraced",
    profile: "terraces",
    swatch: "#8fcf5a",
    calm: false,
    hints: /数据|data|分析|analys|stat|统计|表格|excel|sheet|可视化|农|farm|知识库|knowledge/gi,
    ground: { light: "#9ed862", dark: "#62b04c", alt: "#bfe37a", altMix: 0.25, path: "#dcc796" },
    film: { color: "#c4ecea", strength: 0.62 },
    treeDensity: 0.3,
    bushDensity: 0.5,
    flowers: 0.3,
    grass: { models: ["rice-1", "rice-2"], tint: "#9ccf4e", density: 1.4, rimOnly: false }
  }
};

export function climateSpec(id: ClimateId): ClimateSpec {
  return CLIMATES[id] ?? CLIMATES.temperate;
}

/** Spatial neighbours from a layout: islands whose rims are close. */
export function layoutNeighbours(layout: Array<{ id: string; x: number; z: number; radius: number }>): Map<string, string[]> {
  const result = new Map<string, string[]>(layout.map(island => [island.id, []]));
  for (let a = 0; a < layout.length; a++) {
    for (let b = a + 1; b < layout.length; b++) {
      const one = layout[a], two = layout[b];
      const gap = Math.hypot(one.x - two.x, one.z - two.z) - one.radius - two.radius;
      if (gap < Math.max(one.radius, two.radius) * 1.6 + 6) {
        result.get(one.id)!.push(two.id);
        result.get(two.id)!.push(one.id);
      }
    }
  }
  return result;
}

const isUnfiled = (island: { id: string; name: string }) =>
  island.id === "unfiled" || /^(未归档|unfiled|미분류)$/i.test(island.name.trim());

/**
 * Climates for an archipelago. The seed decides among the top candidates;
 * keyword hints only bias. Neighbours avoid sharing a climate when they can,
 * and every archipelago of three or more islands gets at least three.
 */
export function assignClimates(
  islands: Array<{ id: string; name: string }>,
  seed: number,
  neighbours?: Map<string, string[]>
): Map<string, ClimateId> {
  const assigned = new Map<string, ClimateId>();
  const used = new Map<ClimateId, number>();
  const near = neighbours ?? new Map(islands.map((island, index) => [island.id, [islands[index - 1]?.id, islands[index + 1]?.id].filter(Boolean) as string[]]));
  const score = (island: { id: string; name: string }, climate: ClimateId) => {
    const spec = CLIMATES[climate];
    const roll = seededRandom(hashString(`${seed >>> 0}:${island.id}:${climate}`))();
    const hinted = spec.hints ? (island.name.match(spec.hints) ?? []).length > 0 : false;
    return roll + (hinted ? 0.45 : 0);
  };
  for (const island of islands) {
    const candidates: ClimateId[] = isUnfiled(island) ? ["temperate", "autumn"] : [...CLIMATE_IDS];
    const neighbourClimates = new Set((near.get(island.id) ?? []).map(id => assigned.get(id)).filter(Boolean));
    let best: ClimateId = candidates[0], bestScore = -Infinity;
    for (const climate of candidates) {
      const value = score(island, climate) - (neighbourClimates.has(climate) ? 2 : 0) - (used.get(climate) ?? 0) * 0.7;
      if (value > bestScore) {
        bestScore = value;
        best = climate;
      }
    }
    assigned.set(island.id, best);
    used.set(best, (used.get(best) ?? 0) + 1);
  }
  // Guarantee variety: three or more islands show at least three climates.
  const wanted = Math.min(3, islands.length);
  for (let guard = 0; new Set(assigned.values()).size < wanted && guard < islands.length; guard++) {
    const counts = new Map<ClimateId, number>();
    for (const value of assigned.values()) counts.set(value, (counts.get(value) ?? 0) + 1);
    // Recolour one island of the most repeated climate, latest first.
    const crowded = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const island = [...islands].reverse().find(item => assigned.get(item.id) === crowded && !isUnfiled(item))
      ?? [...islands].reverse().find(item => assigned.get(item.id) === crowded);
    if (!island) break;
    const fresh = (isUnfiled(island) ? (["temperate", "autumn"] as ClimateId[]) : [...CLIMATE_IDS])
      .filter(climate => !counts.has(climate))
      .sort((a, b) => score(island, b) - score(island, a))[0];
    if (!fresh) break;
    assigned.set(island.id, fresh);
  }
  return assigned;
}

/** How many islands have each climate, in a stable order. */
export function climateCounts(climates: Map<string, ClimateId> | Record<string, ClimateId>): Array<[ClimateId, number]> {
  const values = climates instanceof Map ? [...climates.values()] : Object.values(climates);
  return CLIMATE_IDS.map(id => [id, values.filter(value => value === id).length] as [ClimateId, number]).filter(([, count]) => count > 0);
}
