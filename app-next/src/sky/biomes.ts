// Each category island gets a designed cartoon theme chosen from its name
// (falling back to a stable choice from its id) and a deterministic plan.
// Composition rules: the house sits toward the back so the side facing the
// camera stays open; no tree stands in front of it; a worn path leads from
// the door; ponds can spill over the edge as a waterfall; animals graze in
// the open grass; nothing stands on paths, ponds or building pads.
import { IslandShape } from "./terrain";
import type { Pad, PathLine, Pond } from "./terrain";
import { hashString, seededRandom, smoothstep } from "./noise";

export type ThemeId = "scholar" | "observatory" | "workshop" | "orchard" | "garden" | "meadow";
export type AnimalName = "Sheep" | "Pig" | "Cow" | "Llama" | "Pug" | "Horse";

type Theme = {
  id: ThemeId;
  match: RegExp | null;
  buildings: string[];
  roof: string;
  trees: string[];
  treeDensity: number;
  leaves: string[];
  bushes: string[];
  props: string[];
  pond: boolean;
  waterfall: boolean;
  flowers: number;
  flowerColors: string[];
  rocks: number;
  rockColor: string;
  mushrooms: boolean;
  animals: AnimalName[];
  villager: boolean;
  /** Ground: HSL offsets on the palette's grass, and a path colour. */
  grass: [number, number, number];
  path?: string;
};

const THEMES: Theme[] = [
  {
    id: "scholar",
    match: /写作|写|论文|paper|writ|润色|文稿|essay|text|book|阅读|书|翻译|报告|report|slide|ppt|演示/gi,
    buildings: ["TownHouse", "Cottage"],
    roof: "#d4643c",
    trees: ["round-11", "round-23", "round-37", "poplar"],
    treeDensity: 1,
    leaves: ["#f0a03c", "#e8783a", "#d65a34", "#f2c14a", "#9ccc58"],
    bushes: ["bush-3", "bush-8"],
    props: ["Bench", "BookStand", "Book_Stack_1", "Stall_Empty", "Barrel", "Bucket_Wooden_1"],
    pond: true,
    waterfall: true,
    flowers: 1,
    flowerColors: ["#ffffff", "#ffd45a", "#f28a6a"],
    rocks: 2,
    rockColor: "#b9b2a8",
    mushrooms: false,
    animals: ["Pug"],
    villager: true,
    grass: [-0.02, 0.02, 0.02]
  },
  {
    id: "observatory",
    match: /调研|研究|文献|research|idea|survey|science|科研|实验|探索|综述|literature/gi,
    buildings: ["Tower"],
    roof: "#4f78a8",
    trees: ["pine-5", "pine-9", "pine-5", "poplar"],
    treeDensity: 1.15,
    leaves: ["#3f9a7a", "#2f8a6c", "#56a884", "#4c9466"],
    bushes: ["bush-3"],
    props: ["Chest_Wood", "BookStand", "Banner_1", "Scroll_1", "Crate_Wooden"],
    pond: false,
    waterfall: false,
    flowers: 0.5,
    flowerColors: ["#ffffff", "#a9c4ff"],
    rocks: 6,
    rockColor: "#a9b0ba",
    mushrooms: true,
    animals: ["Llama"],
    villager: true,
    grass: [0.05, -0.12, 0.02]
  },
  {
    id: "workshop",
    match: /软件|代码|code|dev|工程|engineer|software|tool|工具|自动|agent|程序|开发|跑/gi,
    buildings: ["Workshop"],
    roof: "#c2553f",
    trees: ["poplar", "pine-9", "round-37"],
    treeDensity: 0.8,
    leaves: ["#8fbf4a", "#a4c45a", "#6fae4a"],
    bushes: ["bush-8"],
    props: ["Anvil_Log", "Workbench", "Crate_Wooden", "Barrel", "Stall_Cart_Empty", "Crate_Wooden", "Barrel"],
    pond: true,
    waterfall: false,
    flowers: 0.4,
    flowerColors: ["#ffd45a"],
    rocks: 4,
    rockColor: "#b8aa98",
    mushrooms: false,
    animals: ["Horse"],
    villager: true,
    grass: [-0.04, -0.08, 0.03],
    path: "#d9b98a"
  },
  {
    id: "orchard",
    match: /数据|data|分析|analys|stat|统计|表格|可视化/gi,
    buildings: ["Cottage"],
    roof: "#5e9a5a",
    trees: ["round-11", "round-23", "round-37"],
    treeDensity: 1.25,
    leaves: ["#7cc650", "#6ab848", "#92d05a"],
    bushes: ["bush-3", "bush-8"],
    props: ["Barrel_Apples", "FarmCrate_Apple", "FarmCrate_Carrot", "Stall_Cart_Empty", "Bench"],
    pond: false,
    waterfall: false,
    flowers: 0.7,
    flowerColors: ["#ffffff", "#ff8a8a"],
    rocks: 2,
    rockColor: "#b9b2a8",
    mushrooms: false,
    animals: ["Pig", "Cow"],
    villager: true,
    grass: [0, 0.08, 0]
  },
  {
    id: "garden",
    match: /绘|图|figure|plot|chart|design|视觉|美术|art|ui|界面|画|配色|前端/gi,
    buildings: ["Cottage"],
    roof: "#d65f7a",
    trees: ["round-11", "round-37", "round-23"],
    treeDensity: 0.85,
    leaves: ["#f4a6c0", "#f7c3d4", "#ee8fb0", "#ffffff", "#a6d36a"],
    bushes: ["bush-3", "bush-8"],
    props: ["Bench", "Pot_1", "Vase_2", "Bucket_Wooden_1"],
    pond: true,
    waterfall: true,
    flowers: 2.6,
    flowerColors: ["#f47ca0", "#ffd45a", "#ffffff", "#b58cf0", "#ff9a5a"],
    rocks: 2,
    rockColor: "#c2b8b0",
    mushrooms: false,
    animals: ["Sheep"],
    villager: true,
    grass: [0.02, 0, 0.03]
  },
  {
    id: "meadow",
    match: /未归档|unfiled|其他|其它|other|misc|未分类|收件|inbox/gi,
    buildings: [],
    roof: "#c2553f",
    trees: ["round-23", "pine-9", "bush-3"],
    treeDensity: 0.7,
    leaves: ["#8cc85a", "#a8d060", "#6ab45a"],
    bushes: ["bush-3", "bush-8"],
    props: ["Bench"],
    pond: true,
    waterfall: true,
    flowers: 1.4,
    flowerColors: ["#ffffff", "#ffd45a", "#f47ca0"],
    rocks: 4,
    rockColor: "#b9b2a8",
    mushrooms: true,
    animals: ["Sheep", "Cow"],
    villager: false,
    grass: [0, -0.03, 0.03]
  }
];

export type ThemeTone = { grass: [number, number, number]; path?: string };

export function themeTone(theme: ThemeId): ThemeTone {
  const spec = THEMES.find(item => item.id === theme) ?? THEMES[0];
  return { grass: spec.grass, path: spec.path };
}

/** Themes ranked by how many of their keywords the category name contains. */
export function rankThemes(name: string, id: string): ThemeId[] {
  const scored = THEMES.map((theme, order) => ({
    id: theme.id,
    order,
    score: theme.match ? (name.match(theme.match) ?? []).length : 0
  }));
  const matched = scored.filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.order - b.order).map(item => item.id);
  const fallbacks: ThemeId[] = ["scholar", "observatory", "workshop", "orchard", "garden"];
  const start = hashString(id) % fallbacks.length;
  const rotated = [...fallbacks.slice(start), ...fallbacks.slice(0, start)];
  return [...matched, ...rotated.filter(item => !matched.includes(item))];
}

export function chooseTheme(name: string, id: string): ThemeId {
  return rankThemes(name, id)[0];
}

/** Keeps neighbouring categories visually distinct: a theme already used
 * gives way to the next keyword match, or to an unused theme for names with
 * no strong match. Deterministic for a given category list. */
export function assignThemes(islands: Array<{ id: string; name: string }>): Map<string, ThemeId> {
  const assigned = new Map<string, ThemeId>();
  const used = new Map<ThemeId, number>();
  for (const island of islands) {
    const ranked = rankThemes(island.name, island.id);
    const keywordMatches = THEMES.filter(theme => theme.match && (island.name.match(theme.match) ?? []).length > 0).map(theme => theme.id);
    const fresh = ranked.find(theme => !used.has(theme) && (keywordMatches.length === 0 || keywordMatches.includes(theme)))
      ?? (keywordMatches.length ? ranked.find(theme => !used.has(theme)) : undefined)
      ?? ranked[0];
    assigned.set(island.id, fresh);
    used.set(fresh, (used.get(fresh) ?? 0) + 1);
  }
  return assigned;
}

export type Placement = {
  library: "kit" | "props";
  model: string;
  x: number;
  z: number;
  yaw: number;
  scale: number;
  /** When set, the scale is derived so the model is this tall (world units). */
  height?: number;
  /** How far to push the model into the ground (fraction of its height). */
  sink: number;
  /** Instance colour for tinted kit parts (sRGB hex). */
  tint?: string;
};

export type BuildingPlacement = { model: string; x: number; z: number; yaw: number; scale: number; roof: string };
export type Waterfall = { x: number; z: number; angle: number; width: number };
export type AnimalPlacement = { name: AnimalName; x: number; z: number; seed: number };

export type IslandPlan = {
  theme: ThemeId;
  shape: IslandShape;
  buildingScale: number;
  buildings: BuildingPlacement[];
  placements: Placement[];
  walkers: Array<Array<[number, number]>>;
  animals: AnimalPlacement[];
  waterfall: Waterfall | null;
};

/** Footprints (width x depth) of the composed buildings, unscaled. */
const BUILDING_FOOTPRINT: Record<string, [number, number]> = {
  Cottage: [5.5, 5.6],
  TownHouse: [5.5, 7.6],
  Tower: [5.7, 5.4],
  Workshop: [8.3, 5.4]
};

type Occupant = { x: number; z: number; r: number };

export function planIsland(radius: number, seed: number, theme: ThemeId): IslandPlan {
  const spec = THEMES.find(item => item.id === theme) ?? THEMES[0];
  const shape = new IslandShape(radius, seed);
  const random = seededRandom(seed ^ hashString(theme));
  const range = (min: number, max: number) => min + random() * (max - min);
  const pick = <T,>(items: T[]) => items[Math.floor(random() * items.length)];
  const buildingScale = Math.min(0.56, Math.max(0.36, 0.3 + radius * 0.025));
  const unit = buildingScale / 0.45;
  const occupied: Occupant[] = [];
  const free = (x: number, z: number, r: number) =>
    occupied.every(item => Math.hypot(x - item.x, z - item.z) > item.r + r) && shape.normalizedDistance(x, z) < 0.86;

  // 1. Buildings first: they decide pads, paths and what must stay clear.
  const buildings: BuildingPlacement[] = [];
  const pads: Pad[] = [];
  const wanted = radius >= 9 ? spec.buildings.slice(0, 2) : radius >= 4.2 ? spec.buildings.slice(0, 1) : [];
  for (const [index, model] of wanted.entries()) {
    const [width, depth] = BUILDING_FOOTPRINT[model];
    const half = Math.hypot(width, depth) * 0.5 * buildingScale;
    for (let attempt = 0; attempt < 40; attempt++) {
      const x = index === 0 ? range(-0.28, 0.28) * radius : (random() < 0.5 ? -1 : 1) * range(0.35, 0.5) * radius;
      const z = index === 0 ? range(-0.34, -0.12) * radius : range(-0.2, 0.15) * radius;
      if (!free(x, z, half + 0.4) || shape.normalizedDistance(x, z) > 0.7 - half / radius * 0.5) continue;
      const yaw = range(-0.32, 0.32) + (index === 1 ? (x > 0 ? -0.35 : 0.35) : 0);
      buildings.push({ model, x, z, yaw, scale: buildingScale, roof: spec.roof });
      pads.push({ x, z, radius: half * 0.92 });
      occupied.push({ x, z, r: half + 0.2 });
      break;
    }
  }
  shape.pads = pads;

  // 2. A pond; on waterfall themes it sits by the rim on the side facing the
  // camera and spills over the edge.
  const ponds: Pond[] = [];
  let waterfall: Waterfall | null = null;
  if (spec.pond && radius >= 5) {
    const pondRadius = Math.min(2.4, Math.max(1, radius * 0.17));
    for (let attempt = 0; attempt < 60; attempt++) {
      const spill = spec.waterfall && attempt < 40;
      const angle = spill ? range(0.35, 1.2) * (random() < 0.5 ? 1 : -1) + Math.PI / 2 : range(0, Math.PI * 2);
      const rim = shape.rimRadius(angle);
      const distance = spill ? rim - pondRadius * 1.05 : range(0.25, 0.5) * radius;
      const x = Math.cos(angle) * distance, z = Math.sin(angle) * distance;
      if (!occupied.every(item => Math.hypot(x - item.x, z - item.z) > item.r + pondRadius + 0.6)) continue;
      ponds.push({ x, z, radius: pondRadius, depth: 0.4 });
      occupied.push({ x, z, r: pondRadius + 0.3 });
      if (spill) waterfall = { x: Math.cos(angle) * rim, z: Math.sin(angle) * rim, angle, width: pondRadius * 0.9 };
      break;
    }
  }
  shape.ponds = ponds;

  // 3. Worn paths from each door toward the open front rim and to the pond.
  const paths: PathLine[] = [];
  const walkers: Array<Array<[number, number]>> = [];
  const pathWidth = 0.75 + radius * 0.035;
  for (const building of buildings) {
    const [, depth] = BUILDING_FOOTPRINT[building.model];
    const doorDistance = (depth * 0.5 + 0.9) * building.scale;
    const door: [number, number] = [building.x + Math.sin(building.yaw) * doorDistance, building.z + Math.cos(building.yaw) * doorDistance];
    const rimAngle = Math.atan2(radius, door[0] * 0.5);
    const rim = shape.rimRadius(rimAngle) * 0.82;
    const end: [number, number] = [Math.cos(rimAngle) * rim, Math.sin(rimAngle) * rim];
    const middle: [number, number] = [(door[0] + end[0]) / 2 + range(-0.6, 0.6) * pathWidth, (door[1] + end[1]) / 2];
    paths.push({ points: [door, middle, end], width: pathWidth });
    const route: Array<[number, number]> = [door, middle, [end[0] * 0.92, end[1] * 0.92]];
    if (ponds.length) {
      const pond = ponds[0];
      const toward = Math.atan2(door[1] - pond.z, door[0] - pond.x);
      const shore: [number, number] = [pond.x + Math.cos(toward) * (pond.radius + 0.7), pond.z + Math.sin(toward) * (pond.radius + 0.7)];
      paths.push({ points: [door, [(door[0] + shore[0]) / 2, (door[1] + shore[1]) / 2], shore], width: pathWidth * 0.8 });
      route.push(middle, door, shore);
    }
    if (spec.villager) walkers.push(route);
  }
  shape.paths = paths;

  const placements: Placement[] = [];
  const clearOf = (x: number, z: number, margin: number) =>
    shape.pathWeight(x, z) < 0.05 && !shape.isInsidePond(x, z, margin) &&
    pads.every(pad => Math.hypot(x - pad.x, z - pad.z) > pad.radius + margin);
  const blocksView = (x: number, z: number, margin: number) => buildings.some(building => {
    const [width] = BUILDING_FOOTPRINT[building.model];
    return z > building.z && Math.abs(x - building.x) < width * building.scale * 0.6 + margin && z - building.z < radius * 0.75;
  });

  // 4. Props by the door, at building scale.
  if (buildings.length) {
    const building = buildings[0];
    const [width, depth] = BUILDING_FOOTPRINT[building.model];
    const spots: Array<[number, number]> = [];
    for (const side of [-1, 1]) {
      for (const along of [0.15, 0.55, 0.95]) {
        const localX = side * (width * 0.5 + 0.6 + along * 0.8) * building.scale;
        const localZ = (depth * 0.5 - along * depth * 0.5) * building.scale;
        spots.push([
          building.x + localX * Math.cos(building.yaw) + localZ * Math.sin(building.yaw),
          building.z - localX * Math.sin(building.yaw) + localZ * Math.cos(building.yaw)
        ]);
      }
    }
    let spot = 0;
    for (const model of spec.props) {
      while (spot < spots.length) {
        const [x, z] = spots[spot++];
        if (shape.normalizedDistance(x, z) > 0.84 || shape.pathWeight(x, z) > 0.3 || shape.isInsidePond(x, z, 0.4)) continue;
        placements.push({ library: "props", model, x, z, yaw: building.yaw + range(-0.5, 0.5), scale: building.scale, sink: 0.02 });
        occupied.push({ x, z, r: 0.5 * building.scale * 2 });
        break;
      }
    }
  } else if (spec.props.length && radius >= 3) {
    const x = range(-0.2, 0.2) * radius, z = range(0, 0.25) * radius;
    placements.push({ library: "props", model: spec.props[0], x, z, yaw: range(-0.6, 0.6), scale: buildingScale, sink: 0.02 });
    occupied.push({ x, z, r: 1.2 });
  }

  // 5. Trees: framing the building from the back and sides, never in front.
  const treeTarget = Math.round(spec.treeDensity * radius * radius * 0.085) + (radius < 3 ? 1 : 2);
  let trees = 0;
  for (let attempt = 0; attempt < treeTarget * 30 && trees < treeTarget; attempt++) {
    let x: number, z: number;
    if (spec.id === "orchard" && attempt < treeTarget * 12) {
      const spacing = 2.4 * unit;
      x = (Math.round(range(-radius, radius) / spacing) + 0.5) * spacing;
      z = (Math.round(range(-radius, radius) / spacing) + 0.5) * spacing;
    } else {
      const angle = range(0, Math.PI * 2), distance = Math.sqrt(random()) * radius * 0.82;
      x = Math.cos(angle) * distance;
      z = Math.sin(angle) * distance;
    }
    const spread = 1.1 * unit;
    if (shape.normalizedDistance(x, z) > 0.8 || !free(x, z, spread) || !clearOf(x, z, 0.8) || blocksView(x, z, 0.6)) continue;
    if (z > radius * 0.3 && random() < 0.6) continue;
    const model = pick(spec.trees);
    placements.push({ library: "kit", model, x, z, yaw: range(0, Math.PI * 2), scale: 1, height: range(2.1, 3.1) * unit, sink: 0.02, tint: pick(spec.leaves) });
    occupied.push({ x, z, r: spread });
    trees++;
  }

  // 6. Bushes around trees and along the building sides.
  const bushTarget = Math.round(radius * 0.9);
  for (let attempt = 0, count = 0; attempt < bushTarget * 25 && count < bushTarget; attempt++) {
    const angle = range(0, Math.PI * 2), distance = Math.sqrt(random()) * radius * 0.85;
    const x = Math.cos(angle) * distance, z = Math.sin(angle) * distance;
    if (shape.normalizedDistance(x, z) > 0.86 || !free(x, z, 0.4) || !clearOf(x, z, 0.35)) continue;
    placements.push({ library: "kit", model: pick(spec.bushes), x, z, yaw: range(0, Math.PI * 2), scale: range(0.8, 1.2) * unit, sink: 0.08, tint: pick(spec.leaves) });
    occupied.push({ x, z, r: 0.5 });
    count++;
  }

  // 7. Rocks, half sunk near the rim.
  const rockCount = Math.max(1, Math.round(spec.rocks * radius / 8));
  for (let attempt = 0, count = 0; attempt < rockCount * 20 && count < rockCount; attempt++) {
    const angle = range(0, Math.PI * 2);
    const distance = shape.rimRadius(angle) * range(0.7, 0.85);
    const x = Math.cos(angle) * distance, z = Math.sin(angle) * distance;
    if (!free(x, z, 0.8) || !clearOf(x, z, 0.5)) continue;
    placements.push({ library: "kit", model: pick(["rock-1", "rock-2", "rock-4"]), x, z, yaw: range(0, Math.PI * 2), scale: range(0.9, 1.6) * unit, sink: 0.3, tint: spec.rockColor });
    occupied.push({ x, z, r: 0.9 });
    count++;
  }

  // 8. Flower beds.
  const patches = Math.round(spec.flowers * (1 + radius * 0.3));
  for (let patch = 0; patch < patches; patch++) {
    const angle = range(0, Math.PI * 2), distance = Math.sqrt(random()) * radius * 0.72;
    const cx = Math.cos(angle) * distance, cz = Math.sin(angle) * distance;
    const tint = pick(spec.flowerColors);
    const count = 4 + Math.floor(random() * 6);
    for (let index = 0; index < count; index++) {
      const x = cx + range(-0.8, 0.8), z = cz + range(-0.8, 0.8);
      if (shape.normalizedDistance(x, z) > 0.9 || !clearOf(x, z, 0.25) || !free(x, z, 0.05)) continue;
      placements.push({ library: "kit", model: "flower", x, z, yaw: range(0, Math.PI * 2), scale: range(0.9, 1.3) * unit, sink: 0.02, tint });
    }
  }

  // 9. Mushrooms in the shade of trees.
  if (spec.mushrooms) {
    for (const tree of placements.filter(item => item.model.startsWith("pine") || item.model.startsWith("round")).slice(0, 6)) {
      const x = tree.x + range(-0.7, 0.7), z = tree.z + range(-0.7, 0.7);
      if (!clearOf(x, z, 0.2)) continue;
      placements.push({ library: "kit", model: "mushroom", x, z, yaw: range(0, Math.PI * 2), scale: range(0.9, 1.4) * unit, sink: 0.04, tint: pick(["#e0503f", "#f08a3c"]) });
    }
  }

  // 10. A few grass tufts to break the surface, denser along the rim.
  const grassTarget = Math.min(140, Math.round(radius * radius * 1.1));
  for (let index = 0; index < grassTarget; index++) {
    const rimBand = index % 3 === 0;
    const angle = range(0, Math.PI * 2);
    const distance = rimBand ? shape.rimRadius(angle) * range(0.84, 0.95) : Math.sqrt(random()) * radius * 0.88;
    const x = Math.cos(angle) * distance, z = Math.sin(angle) * distance;
    const worn = shape.pathWeight(x, z);
    if (worn > 0.3 || shape.isInsidePond(x, z, 0.1)) continue;
    if (pads.some(pad => Math.hypot(x - pad.x, z - pad.z) < pad.radius * 0.95)) continue;
    placements.push({ library: "kit", model: pick(["grass-1", "grass-2"]), x, z, yaw: range(0, Math.PI * 2), scale: range(0.8, 1.3) * unit * (1 - smoothstep(0.05, 0.3, worn)), sink: 0.05, tint: "grass" });
  }

  // 11. Animals graze in the open grass.
  const animals: AnimalPlacement[] = [];
  const animalCount = radius < 4.2 ? 1 : radius < 8 ? 2 : 3;
  for (let attempt = 0; attempt < 80 && animals.length < animalCount && spec.animals.length; attempt++) {
    const angle = range(0, Math.PI * 2), distance = Math.sqrt(random()) * radius * 0.6;
    const x = Math.cos(angle) * distance, z = Math.sin(angle) * distance;
    if (!free(x, z, 0.8) || !clearOf(x, z, 0.6)) continue;
    animals.push({ name: spec.animals[animals.length % spec.animals.length], x, z, seed: seed + attempt });
    occupied.push({ x, z, r: 0.9 });
  }

  return { theme, shape, buildingScale, buildings, placements, walkers, animals, waterfall };
}
