// Deterministic archipelago layout. Island area grows with content (radius ∝
// √weight above a clickable minimum). Islands are placed in screen space for
// the camera pitch, so the composition fills a wide frame and no island hides
// another's front edge, where its label sits: an island behind a neighbour
// must clear that neighbour's top (trees included) by a label band, and an
// island drawn higher on screen is always the farther one, so its rock
// underside passes behind the nearer island instead of covering it.
import { hashString, seededRandom } from "./noise";

export type LayoutInput = { id: string; weight: number };
export type LayoutIsland = { id: string; radius: number; x: number; y: number; z: number; seed: number };
export type LayoutView = {
  /** Camera pitch below the horizon, degrees. */
  pitch: number;
  /** How much island heights vary (world units). */
  heightSpread: number;
  /** Width-to-height ratio the composition aims for on screen. */
  aspect: number;
};

export const MIN_ISLAND_RADIUS = 3.4;
export const MAX_ISLAND_RADIUS = 10.5;
/** Room kept under an island's front edge for its label (world units). */
const LABEL_BAND = 3.2;
/** Tallest decoration (trees, towers) above the grass, relative to radius. */
const CROWN = (radius: number) => 3 + radius * 0.42;

/** Area ∝ weight above a clickable minimum: radius ∝ √weight. */
export function islandRadius(weight: number, maxWeight: number): number {
  if (maxWeight <= 0) return MIN_ISLAND_RADIUS;
  return MIN_ISLAND_RADIUS + (MAX_ISLAND_RADIUS - MIN_ISLAND_RADIUS) * Math.sqrt(Math.max(0, weight) / maxWeight);
}

type Placed = LayoutIsland & { v: number };

export function layoutIslands(items: LayoutInput[], view: LayoutView): LayoutIsland[] {
  const maxWeight = Math.max(0, ...items.map(item => item.weight));
  const sin = Math.sin((view.pitch * Math.PI) / 180);
  const cos = Math.cos((view.pitch * Math.PI) / 180);
  // The largest category takes the centre; ties keep a stable id order.
  const order = items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => b.item.weight - a.item.weight || (a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0));
  const placed: Placed[] = [];
  const result = new Array<LayoutIsland>(items.length);

  const fits = (candidate: Placed) => placed.every(other => {
    const dx = Math.abs(candidate.x - other.x);
    const reach = candidate.radius + other.radius;
    if (Math.hypot(candidate.x - other.x, candidate.z - other.z) < reach * 1.08 + 1.6) return false;
    if (dx > reach * 1.06 + 1.4) return true;
    // Horizontally overlapping on screen: stack them, farther one above.
    const [upper, lower] = candidate.v < other.v ? [candidate, other] : [other, candidate];
    if (upper.z > lower.z - 0.5) return false;
    const upperFront = upper.v + upper.radius * 1.12 * sin + LABEL_BAND;
    const lowerTop = lower.v - lower.radius * 1.12 * sin - CROWN(lower.radius) * cos;
    return upperFront <= lowerTop;
  });

  // Screen extent of an island: rim, crown above it, label band or rock
  // underside below it.
  const extent = (island: Placed) => ({
    left: island.x - island.radius * 1.1,
    right: island.x + island.radius * 1.1,
    top: island.v - island.radius * 1.12 * sin - CROWN(island.radius) * cos,
    bottom: island.v + Math.max(island.radius * 1.12 * sin + LABEL_BAND, island.radius * 1.15 * cos)
  });
  const frame = { left: 0, right: 0, top: 0, bottom: 0 };

  for (const { item, index } of order) {
    const seed = hashString(item.id);
    const random = seededRandom(seed);
    const radius = islandRadius(item.weight, maxWeight);
    const y = (random() - 0.5) * 2 * view.heightSpread - radius * 0.12;
    let best: Placed = { id: item.id, radius, x: 0, y, z: y * cos / sin, v: 0, seed };
    if (placed.length) {
      // Walk an outward spiral in screen space from this island's own
      // preferred angle and keep the clear spot that grows the composition
      // least for the target frame; near spots win ties so it stays compact.
      const start = random() * Math.PI * 2;
      let bestCost = Infinity, found = 0;
      for (let step = 0; step < 3000 && found < 48; step++) {
        const angle = start + step * 0.41;
        const distance = 2 + step * 0.045;
        const x = Math.cos(angle) * distance * view.aspect;
        const v = Math.sin(angle) * distance;
        const candidate: Placed = { id: item.id, radius, x, y, z: (v + y * cos) / sin, v, seed };
        if (!fits(candidate)) continue;
        found++;
        const box = extent(candidate);
        const width = Math.max(frame.right, box.right) - Math.min(frame.left, box.left);
        const height = Math.max(frame.bottom, box.bottom) - Math.min(frame.top, box.top);
        const cost = Math.max(width / view.aspect, height) + distance * 0.02;
        if (cost < bestCost - 1e-6) {
          bestCost = cost;
          best = candidate;
        }
      }
    }
    placed.push(best);
    const box = extent(best);
    if (placed.length === 1) Object.assign(frame, box);
    else {
      frame.left = Math.min(frame.left, box.left);
      frame.right = Math.max(frame.right, box.right);
      frame.top = Math.min(frame.top, box.top);
      frame.bottom = Math.max(frame.bottom, box.bottom);
    }
    result[index] = { id: best.id, radius, x: best.x, y: best.y, z: best.z, seed };
  }

  if (placed.length) {
    const minX = Math.min(...placed.map(island => island.x - island.radius));
    const maxX = Math.max(...placed.map(island => island.x + island.radius));
    const minZ = Math.min(...placed.map(island => island.z - island.radius));
    const maxZ = Math.max(...placed.map(island => island.z + island.radius));
    const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
    for (const island of result) {
      island.x -= cx;
      island.z -= cz;
    }
  }
  return result;
}
