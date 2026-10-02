// Each category island gets a designed theme chosen from its name (falling
// back to a stable choice from its id), and a deterministic decoration plan.
// Composition rules: the hero building sits toward the back so the side
// facing the camera stays open; no tree stands between the camera and the
// building; a worn path leads from the door; vegetation avoids paths, ponds
// and building pads; rim rocks are embedded, never set on top of the grass.
import { IslandShape } from "./terrain";
import type { Pad, PathLine, Pond } from "./terrain";
import { hashString, seededRandom, smoothstep } from "./noise";

export type ThemeId = "scholar" | "observatory" | "workshop" | "orchard" | "garden" | "meadow";

type Theme = {
  id: ThemeId;
  match: RegExp | null;
  buildings: string[];
  trees: string[];
  treeDensity: number;
  bushes: string[];
  props: string[];
  pond: boolean;
  flowers: number;
  rocks: number;
  walker: boolean;
  mushrooms: boolean;
  /** Ground colour: HSL offsets on the palette's grass, and how much dry grass. */
  grass: [number, number, number];
  dry: number;
  /** Leaf colours of the crowns, in morning light (sRGB). */
  leaves: string[];
};

const THEMES: Theme[] = [
  {
    id: "scholar",
    match: /写作|写|论文|paper|writ|润色|文稿|essay|text|book|阅读|书|翻译|报告|report|slide|ppt|演示/gi,
    buildings: ["TownHouse", "Cottage"],
    trees: ["CommonTree_1", "CommonTree_2", "CommonTree_3"],
    treeDensity: 1,
    bushes: ["Bush_Common_Flowers", "Bush_Common"],
    props: ["Bench", "Stall_Empty", "Book_Stack_1", "Barrel", "Bucket_Wooden_1", "BookStand"],
    pond: true,
    flowers: 1,
    rocks: 3,
    walker: true,
    mushrooms: false,
    grass: [-0.03, 0.02, 0.02],
    dry: 0.75,
    leaves: ["#e0913f", "#d9a53b", "#c8643a", "#e6b552", "#d77f45", "#a9c55c"]
  },
  {
    id: "observatory",
    match: /调研|研究|文献|research|idea|survey|science|科研|实验|探索|综述|literature/gi,
    buildings: ["Tower"],
    trees: ["Pine_1", "Pine_2", "Pine_3", "Pine_4"],
    treeDensity: 1.15,
    bushes: ["Bush_Common", "Fern_1"],
    props: ["Chest_Wood", "BookStand", "Banner_1", "Crate_Wooden", "Scroll_1"],
    pond: false,
    flowers: 0.45,
    rocks: 6,
    walker: true,
    mushrooms: true,
    grass: [0.05, -0.16, 0.03],
    dry: 0.1,
    leaves: ["#7fae74", "#6f9f78", "#8bb67a", "#76a98a"]
  },
  {
    id: "workshop",
    match: /软件|代码|code|dev|工程|engineer|software|tool|工具|自动|agent|程序|开发|跑/gi,
    buildings: ["Workshop"],
    trees: ["Pine_2", "Pine_5", "CommonTree_5"],
    treeDensity: 0.8,
    bushes: ["Bush_Common", "Plant_1_Big"],
    props: ["Anvil_Log", "Workbench", "Crate_Wooden", "Crate_Wooden", "Barrel", "Barrel", "Stall_Cart_Empty", "Bucket_Wooden_1"],
    pond: true,
    flowers: 0.4,
    rocks: 4,
    walker: true,
    mushrooms: false,
    grass: [-0.045, -0.12, 0.04],
    dry: 1.1,
    leaves: ["#a7b65a", "#b5b866", "#95ad55"]
  },
  {
    id: "orchard",
    match: /数据|data|分析|analys|stat|统计|表格|可视化/gi,
    buildings: ["Cottage"],
    trees: ["CommonTree_4", "CommonTree_1"],
    treeDensity: 1.25,
    bushes: ["Bush_Common_Flowers"],
    props: ["Barrel_Apples", "FarmCrate_Apple", "FarmCrate_Carrot", "Stall_Cart_Empty", "Bench"],
    pond: false,
    flowers: 0.7,
    rocks: 2,
    walker: true,
    mushrooms: false,
    grass: [0.0, 0.1, 0.0],
    dry: 0,
    leaves: ["#9fd056", "#8cc84f", "#b2d65e"]
  },
  {
    id: "garden",
    match: /绘|图|figure|plot|chart|design|视觉|美术|art|ui|界面|画|配色|前端/gi,
    buildings: ["Cottage"],
    trees: ["TwistedTree_1", "CommonTree_4", "CommonTree_2"],
    treeDensity: 0.75,
    bushes: ["Bush_Common_Flowers", "Bush_Common_Flowers", "Plant_7_Big"],
    props: ["Bench", "Pot_1", "Vase_2", "Bucket_Wooden_1", "FarmCrate_Empty"],
    pond: true,
    flowers: 2.4,
    rocks: 2,
    walker: true,
    mushrooms: false,
    grass: [0.02, 0.0, 0.04],
    dry: 0,
    leaves: ["#f2a7c0", "#f5bfd0", "#eeb6d6", "#f7d7e2", "#e99ab5", "#a3c75b"]
  },
  {
    id: "meadow",
    match: /未归档|unfiled|其他|其它|other|misc|未分类|收件|inbox/gi,
    buildings: [],
    trees: ["CommonTree_2", "Pine_5", "DeadTree_1"],
    treeDensity: 0.7,
    bushes: ["Bush_Common", "Fern_1", "Plant_1"],
    props: ["Stall_Cart_Empty", "Bench"],
    pond: true,
    flowers: 1.2,
    rocks: 5,
    walker: false,
    mushrooms: true,
    grass: [0.0, -0.05, 0.03],
    dry: 0.35,
    leaves: ["#a3c75b", "#b4c96a", "#98bd5c"]
  }
];

export type ThemeTone = { grass: [number, number, number]; dry: number };

export function themeTone(theme: ThemeId): ThemeTone {
  const spec = THEMES.find(item => item.id === theme) ?? THEMES[0];
  return { grass: spec.grass, dry: spec.dry };
}

function hexToRgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
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
  library: "nature" | "props";
  model: string;
  x: number;
  z: number;
  yaw: number;
  scale: number;
  /** When set, the scale is derived so the model is this tall (world units). */
  height?: number;
  /** How far to push the model into the ground (fraction of its height). */
  sink: number;
  /** Leaf colour of this crown in morning light (sRGB 0..1). */
  tint?: [number, number, number];
};

export type BuildingPlacement = { model: string; x: number; z: number; yaw: number; scale: number };

export type IslandPlan = {
  theme: ThemeId;
  shape: IslandShape;
  buildingScale: number;
  buildings: BuildingPlacement[];
  placements: Placement[];
  walkers: Array<Array<[number, number]>>;
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
      buildings.push({ model, x, z, yaw, scale: buildingScale });
      pads.push({ x, z, radius: half * 0.92 });
      occupied.push({ x, z, r: half + 0.2 });
      break;
    }
  }
  shape.pads = pads;

  // 2. A pond on larger islands of water-loving themes.
  const ponds: Pond[] = [];
  if (spec.pond && radius >= 5.5) {
    const pondRadius = Math.min(2.6, Math.max(1, radius * 0.17));
    for (let attempt = 0; attempt < 40; attempt++) {
      const angle = range(0, Math.PI * 2), distance = range(0.25, 0.5) * radius;
      const x = Math.cos(angle) * distance, z = Math.sin(angle) * distance;
      if (!free(x, z, pondRadius + 0.6)) continue;
      ponds.push({ x, z, radius: pondRadius, depth: 0.45 });
      occupied.push({ x, z, r: pondRadius + 0.3 });
      break;
    }
  }
  shape.ponds = ponds;

  // 3. Worn paths from each door: toward the open front rim, and to the pond.
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
    if (spec.walker) walkers.push(route);
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
  const leafTint = (): [number, number, number] => {
    const [r, g, b] = hexToRgb(pick(spec.leaves));
    const light = range(0.9, 1.08), warm = range(-0.04, 0.04);
    return [Math.min(1, r * light * (1 + warm)), Math.min(1, g * light), Math.min(1, b * light * (1 - warm))];
  };

  // 4. Props near the door and along the path, at building scale.
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
  const treeTarget = Math.round(spec.treeDensity * radius * radius * 0.11) + (radius < 3 ? 1 : 2);
  const orchard = spec.id === "orchard";
  let trees = 0;
  for (let attempt = 0; attempt < treeTarget * 30 && trees < treeTarget; attempt++) {
    let x: number, z: number;
    if (orchard && attempt < treeTarget * 12) {
      const spacing = 2.3 * buildingScale / 0.45;
      x = (Math.round(range(-radius, radius) / spacing) + 0.5) * spacing;
      z = (Math.round(range(-radius, radius) / spacing) + 0.5) * spacing;
    } else {
      const angle = range(0, Math.PI * 2), distance = Math.sqrt(random()) * radius * 0.82;
      x = Math.cos(angle) * distance;
      z = Math.sin(angle) * distance;
    }
    const spread = 1.05 * buildingScale / 0.45;
    if (shape.normalizedDistance(x, z) > 0.8 || !free(x, z, spread) || !clearOf(x, z, 0.8) || blocksView(x, z, 0.6)) continue;
    // Prefer the back half so the view toward the camera stays open.
    if (z > radius * 0.3 && random() < 0.65) continue;
    const model = pick(spec.trees);
    const heightWanted = range(2.3, 3.6) * buildingScale / 0.45 * (/Twisted/.test(model) ? 1.35 : 1);
    placements.push({ library: "nature", model, x, z, yaw: range(0, Math.PI * 2), scale: 1, height: heightWanted, sink: 0.012, tint: leafTint() });
    occupied.push({ x, z, r: spread });
    trees++;
  }

  // 6. Bushes and small plants around trees and along the building sides.
  const bushTarget = Math.round(radius * 1.3);
  for (let attempt = 0, count = 0; attempt < bushTarget * 25 && count < bushTarget; attempt++) {
    const angle = range(0, Math.PI * 2), distance = Math.sqrt(random()) * radius * 0.85;
    const x = Math.cos(angle) * distance, z = Math.sin(angle) * distance;
    if (shape.normalizedDistance(x, z) > 0.86 || !free(x, z, 0.35) || !clearOf(x, z, 0.35)) continue;
    const model = pick(spec.bushes);
    placements.push({ library: "nature", model, x, z, yaw: range(0, Math.PI * 2), scale: range(0.45, 0.75) * buildingScale / 0.45, sink: 0.05, tint: leafTint() });
    occupied.push({ x, z, r: 0.45 });
    count++;
  }

  // 7. Rim rocks: embedded about a third into the ground at the edge.
  const rockCount = Math.max(1, Math.round(spec.rocks * radius / 8));
  for (let attempt = 0, count = 0; attempt < rockCount * 20 && count < rockCount; attempt++) {
    const angle = range(0, Math.PI * 2);
    const distance = shape.rimRadius(angle) * range(0.72, 0.86);
    const x = Math.cos(angle) * distance, z = Math.sin(angle) * distance;
    if (!free(x, z, 0.8) || !clearOf(x, z, 0.5)) continue;
    placements.push({ library: "nature", model: pick(["Rock_Medium_1", "Rock_Medium_2", "Rock_Medium_3"]), x, z, yaw: range(0, Math.PI * 2), scale: range(0.55, 1.05) * buildingScale / 0.45, sink: 0.34 });
    occupied.push({ x, z, r: 0.9 });
    count++;
  }
  // Stepping stones and pebbles along paths.
  for (const path of paths) {
    for (let index = 1; index < path.points.length; index++) {
      const [ax, az] = path.points[index - 1], [bx, bz] = path.points[index];
      const length = Math.hypot(bx - ax, bz - az);
      for (let step = 0.6; step < length; step += range(1.1, 1.8)) {
        const t = step / length;
        const side = (random() - 0.5) * path.width * 0.3;
        const x = ax + (bx - ax) * t + (az - bz) / length * side, z = az + (bz - az) * t + (bx - ax) / length * side;
        if (shape.isInsidePond(x, z, 0.2) || shape.normalizedDistance(x, z) > 0.88) continue;
        placements.push({ library: "nature", model: pick(["RockPath_Round_Small_1", "RockPath_Round_Small_2", "RockPath_Round_Small_3"]), x, z, yaw: range(0, Math.PI * 2), scale: range(0.4, 0.6) * buildingScale / 0.45, sink: 0.45 });
      }
    }
  }

  // 8. Flower patches.
  const patches = Math.round(spec.flowers * (1 + radius * 0.35));
  for (let patch = 0; patch < patches; patch++) {
    const angle = range(0, Math.PI * 2), distance = Math.sqrt(random()) * radius * 0.72;
    const cx = Math.cos(angle) * distance, cz = Math.sin(angle) * distance;
    const model = pick(["Flower_3_Group", "Flower_4_Group", "Flower_3_Single", "Flower_4_Single", "Clover_1"]);
    const count = 3 + Math.floor(random() * 6);
    for (let index = 0; index < count; index++) {
      const x = cx + range(-0.9, 0.9), z = cz + range(-0.9, 0.9);
      if (shape.normalizedDistance(x, z) > 0.9 || !clearOf(x, z, 0.25) || !free(x, z, 0.05)) continue;
      placements.push({ library: "nature", model, x, z, yaw: range(0, Math.PI * 2), scale: range(0.22, 0.34) * buildingScale / 0.45, sink: 0.03 });
    }
  }

  // 9. Mushrooms in the shade of trees.
  if (spec.mushrooms) {
    for (const tree of placements.filter(item => /Tree|Pine/.test(item.model)).slice(0, 6)) {
      const x = tree.x + range(-0.7, 0.7), z = tree.z + range(-0.7, 0.7);
      if (!clearOf(x, z, 0.2)) continue;
      placements.push({ library: "nature", model: pick(["Mushroom_Common", "Mushroom_Laetiporus"]), x, z, yaw: range(0, Math.PI * 2), scale: range(0.3, 0.5) * buildingScale / 0.45, sink: 0.05 });
    }
  }

  // 10. Grass: dense clumps everywhere that is not path, pond or floor, and
  // a fuller band along the rim so the edge reads as an overhang.
  const grassTarget = Math.min(700, Math.round(radius * radius * 5));
  for (let index = 0; index < grassTarget; index++) {
    const rimBand = index % 4 === 0;
    const angle = range(0, Math.PI * 2);
    const distance = rimBand ? shape.rimRadius(angle) * range(0.86, 0.985) : Math.sqrt(random()) * radius * 0.9;
    const x = Math.cos(angle) * distance, z = Math.sin(angle) * distance;
    const worn = shape.pathWeight(x, z);
    if (worn > 0.35 || shape.isInsidePond(x, z, 0.1)) continue;
    if (pads.some(pad => Math.hypot(x - pad.x, z - pad.z) < pad.radius * 0.95)) continue;
    const model = pick(["Grass_Common_Short", "Grass_Common_Short", "Grass_Common_Short", "Grass_Wispy_Short", "Grass_Common_Tall"]);
    const fade = 1 - smoothstep(0.05, 0.35, worn);
    placements.push({ library: "nature", model, x, z, yaw: range(0, Math.PI * 2), scale: range(0.2, 0.36) * fade * buildingScale / 0.45, sink: 0.08 });
  }

  return { theme, shape, buildingScale, buildings, placements, walkers };
}
