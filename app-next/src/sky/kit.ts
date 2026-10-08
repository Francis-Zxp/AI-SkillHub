// The cartoon kit: every plant, rock and cloud is built here from a handful of
// rounded primitives, coloured by vertex colour (light on top, shade below)
// and tinted per instance. No textures, so nothing repeats or seams, and the
// whole kit is a few thousand triangles.
import * as THREE from "three";
import { mergeGeometries, mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { seededRandom } from "./noise";

export type KitPart = {
  geometry: THREE.BufferGeometry;
  /** "tint" parts take the instance colour (leaves, petals, caps); "fixed" keep their own. */
  role: "tint" | "fixed";
};
export type KitModel = {
  name: string;
  parts: KitPart[];
  height: number;
  footprint: number;
  /** Wind sway as a fraction of the height; with `swayAll` the fixed parts
   * bend too (palms, snowy pines), so trunk and crown never come apart. */
  sway?: number;
  swayAll?: boolean;
  /** Floating pieces bob gently instead of swaying. */
  bob?: boolean;
  /** Tinted parts glow faintly by day and clearly at night (crystals). */
  glow?: boolean;
  /** Small ground cover: no shadows. */
  small?: boolean;
};

/** Paints a vertical light-to-shade gradient into the vertex colours. */
function shade(geometry: THREE.BufferGeometry, base: THREE.Color, bottom = 0.72, top = 1.08) {
  geometry.computeBoundingBox();
  const box = geometry.boundingBox!;
  const position = geometry.getAttribute("position");
  const colors = new Float32Array(position.count * 3);
  const height = Math.max(1e-6, box.max.y - box.min.y);
  for (let index = 0; index < position.count; index++) {
    const t = (position.getY(index) - box.min.y) / height;
    const light = bottom + (top - bottom) * Math.pow(t, 0.8);
    colors[index * 3] = base.r * light;
    colors[index * 3 + 1] = base.g * light;
    colors[index * 3 + 2] = base.b * light;
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return geometry;
}

const WHITE = new THREE.Color(1, 1, 1);
const BARK = new THREE.Color("#7a5232");
const STEM = new THREE.Color("#5f8a3c");

function prepared(geometry: THREE.BufferGeometry) {
  const plain = geometry.index ? geometry.toNonIndexed() : geometry;
  plain.deleteAttribute("uv");
  if (plain.getAttribute("normal") === undefined) plain.computeVertexNormals();
  return plain;
}

/** Merges parts keeping their own (smooth) normals. */
function merged(list: THREE.BufferGeometry[]) {
  return mergeGeometries(list.map(prepared), false)!;
}

function blob(radius: number, x: number, y: number, z: number, squash = 1, detail = 2) {
  const geometry = new THREE.IcosahedronGeometry(radius, detail);
  geometry.scale(1, squash, 1);
  geometry.translate(x, y, z);
  return geometry;
}

function trunk(height: number, radius: number) {
  const geometry = new THREE.CylinderGeometry(radius * 0.7, radius, height, 7, 1);
  geometry.translate(0, height / 2, 0);
  return geometry;
}

/** Round deciduous tree: a cluster of soft balls on a short trunk. */
function roundTree(seed: number): KitModel {
  const random = seededRandom(seed);
  const balls: THREE.BufferGeometry[] = [];
  balls.push(blob(0.62, 0, 1.45, 0, 0.92));
  for (let index = 0; index < 4; index++) {
    const angle = (index / 4) * Math.PI * 2 + random() * 0.8;
    balls.push(blob(0.38 + random() * 0.12, Math.cos(angle) * 0.42, 1.2 + random() * 0.45, Math.sin(angle) * 0.42, 0.9));
  }
  return {
    name: `round-${seed}`,
    parts: [
      { geometry: shade(trunk(1.05, 0.12), BARK, 0.8, 1), role: "fixed" },
      { geometry: shade(merged(balls), WHITE, 0.62, 1.1), role: "tint" }
    ],
    height: 2.1,
    footprint: 1.6
  };
}

/** Tiered pine: three stacked cones with rounded shoulders. */
function pine(seed: number): KitModel {
  const random = seededRandom(seed);
  const tiers: THREE.BufferGeometry[] = [];
  const count = 3 + (random() < 0.4 ? 1 : 0);
  for (let index = 0; index < count; index++) {
    const radius = 0.62 - index * 0.14;
    const cone = new THREE.ConeGeometry(radius, 0.78, 9, 1);
    cone.translate(0, 0.62 + index * 0.42 + 0.39, 0);
    tiers.push(cone);
  }
  return {
    name: `pine-${seed}`,
    parts: [
      { geometry: shade(trunk(0.75, 0.1), BARK, 0.8, 1), role: "fixed" },
      { geometry: shade(merged(tiers), WHITE, 0.6, 1.08), role: "tint" }
    ],
    height: 0.62 + count * 0.42 + 0.78,
    footprint: 1.3
  };
}

/** Tall poplar / cypress: one elongated soft cone. */
function poplar(): KitModel {
  const body = blob(0.42, 0, 1.45, 0, 2.1, 2);
  return {
    name: "poplar",
    parts: [
      { geometry: shade(trunk(0.6, 0.09), BARK, 0.8, 1), role: "fixed" },
      { geometry: shade(merged([body]), WHITE, 0.62, 1.1), role: "tint" }
    ],
    height: 2.35,
    footprint: 0.9
  };
}

function bush(seed: number): KitModel {
  const random = seededRandom(seed);
  const balls = [blob(0.36, 0, 0.28, 0, 0.85)];
  for (let index = 0; index < 3; index++) {
    const angle = (index / 3) * Math.PI * 2 + random();
    balls.push(blob(0.24 + random() * 0.08, Math.cos(angle) * 0.3, 0.2, Math.sin(angle) * 0.3, 0.85));
  }
  return { name: `bush-${seed}`, parts: [{ geometry: shade(merged(balls), WHITE, 0.62, 1.08), role: "tint" }], height: 0.62, footprint: 0.95 };
}

/** Faceted boulder: a jittered low-detail ball, flat shaded. */
function rock(seed: number): KitModel {
  const random = seededRandom(seed);
  const geometry = new THREE.IcosahedronGeometry(0.5, 1);
  const position = geometry.getAttribute("position");
  const moved = new Map<string, THREE.Vector3>();
  for (let index = 0; index < position.count; index++) {
    const key = `${position.getX(index).toFixed(3)},${position.getY(index).toFixed(3)},${position.getZ(index).toFixed(3)}`;
    if (!moved.has(key)) {
      const scale = 0.82 + random() * 0.32;
      moved.set(key, new THREE.Vector3(position.getX(index) * scale * 1.15, position.getY(index) * scale * 0.72, position.getZ(index) * scale));
    }
    const target = moved.get(key)!;
    position.setXYZ(index, target.x, target.y, target.z);
  }
  geometry.translate(0, 0.25, 0);
  // Non-indexed: recomputed normals are per face, so the rock is faceted.
  geometry.deleteAttribute("normal");
  geometry.deleteAttribute("uv");
  const rounded = mergeVertices(geometry, 1e-3);
  rounded.computeVertexNormals();
  geometry.dispose();
  return { name: `rock-${seed}`, parts: [{ geometry: shade(merged([rounded]), WHITE, 0.78, 1.05), role: "tint" }], height: 0.62, footprint: 1.15 };
}

function grassTuft(seed: number): KitModel {
  const random = seededRandom(seed);
  const blades: THREE.BufferGeometry[] = [];
  for (let index = 0; index < 5; index++) {
    const blade = new THREE.ConeGeometry(0.035, 0.3 + random() * 0.18, 4, 3);
    blade.translate(0, blade.parameters.height / 2, 0);
    const positions = blade.getAttribute("position");
    const bend = (random() - 0.5) * 0.18;
    for (let vertex = 0; vertex < positions.count; vertex++) {
      const t = positions.getY(vertex) / blade.parameters.height;
      positions.setX(vertex, positions.getX(vertex) + bend * t * t);
    }
    blade.computeVertexNormals();
    blade.rotateZ((random() - 0.5) * 0.7);
    blade.rotateX((random() - 0.5) * 0.7);
    blade.translate((random() - 0.5) * 0.14, 0, (random() - 0.5) * 0.14);
    blades.push(blade);
  }
  return { name: `grass-${seed}`, parts: [{ geometry: shade(merged(blades), WHITE, 0.55, 1.12), role: "tint" }], height: 0.45, footprint: 0.3 };
}

function flower(): KitModel {
  const stem = new THREE.CylinderGeometry(0.012, 0.016, 0.26, 4, 1);
  stem.translate(0, 0.13, 0);
  const head = blob(0.07, 0, 0.29, 0, 0.7, 1);
  return {
    name: "flower",
    parts: [
      { geometry: shade(merged([stem]), STEM, 0.8, 1), role: "fixed" },
      { geometry: shade(merged([head]), WHITE, 0.9, 1.05), role: "tint" }
    ],
    height: 0.34,
    footprint: 0.14
  };
}

function mushroom(): KitModel {
  const stalk = new THREE.CylinderGeometry(0.05, 0.07, 0.16, 7, 1);
  stalk.translate(0, 0.08, 0);
  const cap = new THREE.SphereGeometry(0.13, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2);
  cap.scale(1, 0.75, 1);
  cap.translate(0, 0.15, 0);
  return {
    name: "mushroom",
    parts: [
      { geometry: shade(merged([stalk]), new THREE.Color("#f3eadb"), 0.85, 1), role: "fixed" },
      { geometry: shade(merged([cap]), WHITE, 0.85, 1.05), role: "tint" }
    ],
    height: 0.26,
    footprint: 0.28
  };
}

const SNOW = new THREE.Color("#f4f8fd");
const PALM_BARK = new THREE.Color("#a27a52");
const COCONUT = new THREE.Color("#6b4a2b");
const BLOSSOM = new THREE.Color("#ff8ab0");

/** Flat-shaded facets: crystals, pillars and shards read as cut stone. */
function faceted(geometry: THREE.BufferGeometry) {
  const plain = geometry.index ? geometry.toNonIndexed() : geometry;
  plain.deleteAttribute("normal");
  plain.deleteAttribute("uv");
  plain.computeVertexNormals();
  return plain;
}

/** Ribs around the local Y axis (cactus columns). */
function ribbed(geometry: THREE.BufferGeometry, ribs: number, depth: number) {
  const position = geometry.getAttribute("position");
  for (let index = 0; index < position.count; index++) {
    const x = position.getX(index), z = position.getZ(index);
    const scale = 1 + depth * Math.cos(Math.atan2(z, x) * ribs);
    position.setX(index, x * scale);
    position.setZ(index, z * scale);
  }
  geometry.computeVertexNormals();
  return geometry;
}

/** Tropical palm: a ringed trunk leaning into a curve, drooping fronds and
 * a few coconuts. The whole tree sways from the base. */
function palm(seed: number): KitModel {
  const random = seededRandom(seed);
  const height = 2.3 + random() * 0.3;
  const lean = 0.32 + random() * 0.22;
  const trunkGeometry = new THREE.CylinderGeometry(0.075, 0.12, height, 7, 21);
  trunkGeometry.translate(0, height / 2, 0);
  const position = trunkGeometry.getAttribute("position");
  for (let index = 0; index < position.count; index++) {
    const y = position.getY(index), t = y / height;
    // Bark rings: a slight bulge at the top of every segment.
    const ring = 1 + 0.12 * Math.max(0, Math.sin(t * 7 * Math.PI * 2));
    position.setX(index, position.getX(index) * ring + lean * t * t * height * 0.4);
    position.setZ(index, position.getZ(index) * ring);
  }
  trunkGeometry.computeVertexNormals();
  const topX = lean * height * 0.4;
  const fronds: THREE.BufferGeometry[] = [];
  const count = 7;
  for (let index = 0; index < count; index++) {
    const leaf = new THREE.SphereGeometry(1, 12, 5);
    leaf.scale(0.78, 0.045, 0.17);
    leaf.translate(0.74, 0, 0);
    const leafPosition = leaf.getAttribute("position");
    for (let vertex = 0; vertex < leafPosition.count; vertex++) {
      const along = leafPosition.getX(vertex) / 1.5;
      // Up out of the crown, then drooping toward the tip.
      leafPosition.setY(vertex, leafPosition.getY(vertex) + along * 0.42 - along * along * 0.95);
      leafPosition.setZ(vertex, leafPosition.getZ(vertex) * (1 - along * 0.55));
    }
    leaf.computeVertexNormals();
    leaf.rotateY((index / count) * Math.PI * 2 + random() * 0.45);
    leaf.translate(topX, height + 0.02, 0);
    fronds.push(leaf);
  }
  const nuts = [0, 1, 2].map(index => {
    const angle = index * 2.1 + random();
    return blob(0.085, topX + Math.cos(angle) * 0.1, height - 0.1, Math.sin(angle) * 0.1, 1, 1);
  });
  return {
    name: `palm-${seed}`,
    parts: [
      { geometry: merged([shade(trunkGeometry, PALM_BARK, 0.78, 1.05), shade(merged(nuts), COCONUT, 0.85, 1)]), role: "fixed" },
      { geometry: shade(merged(fronds), WHITE, 0.7, 1.12), role: "tint" }
    ],
    height: height + 0.25,
    footprint: 1.8,
    sway: 0.035,
    swayAll: true
  };
}

/** Saguaro cactus: a ribbed column with one or two arms and a pink bloom. */
function cactus(seed: number): KitModel {
  const random = seededRandom(seed);
  const column = (radius: number, length: number) => {
    const body = ribbed(new THREE.CylinderGeometry(radius, radius * 1.06, length, 16, 4), 8, 0.09);
    body.translate(0, length / 2, 0);
    const cap = ribbed(new THREE.SphereGeometry(radius, 16, 6, 0, Math.PI * 2, 0, Math.PI / 2), 8, 0.09);
    cap.translate(0, length, 0);
    return [body, cap];
  };
  const height = 1.25 + random() * 0.35;
  const parts = column(0.2, height);
  const arms = random() < 0.45 ? [1] : [-1, 1];
  for (const side of arms) {
    const at = height * (0.38 + random() * 0.22);
    const reach = 0.3 + random() * 0.08;
    const elbow = new THREE.CylinderGeometry(0.12, 0.12, reach, 12, 1);
    elbow.rotateZ(Math.PI / 2);
    elbow.translate(side * reach / 2, at, 0);
    const knee = blob(0.12, side * reach, at, 0, 1, 2);
    const up = column(0.12, 0.38 + random() * 0.3);
    for (const piece of up) piece.translate(side * reach, at, 0);
    parts.push(elbow, knee, ...up);
  }
  const bloom = blob(0.07, 0.02, height + 0.2, 0, 0.7, 1);
  return {
    name: `cactus-${seed}`,
    parts: [
      { geometry: shade(merged(parts), WHITE, 0.72, 1.08), role: "tint" },
      { geometry: shade(merged([bloom]), BLOSSOM, 0.95, 1.05), role: "fixed" }
    ],
    height: height + 0.27,
    footprint: 0.9,
    sway: 0
  };
}

/** Crystal cluster: hexagonal prisms with pointed tips, flat shaded. */
function crystalCluster(seed: number): KitModel {
  const random = seededRandom(seed);
  const shards: THREE.BufferGeometry[] = [];
  const count = 5 + Math.floor(random() * 2);
  for (let index = 0; index < count; index++) {
    const main = index === 0;
    const length = main ? 1.05 : 0.42 + random() * 0.45;
    const radius = main ? 0.17 : 0.09 + random() * 0.06;
    const prism = new THREE.CylinderGeometry(radius, radius * 1.08, length, 6, 1);
    prism.translate(0, length / 2, 0);
    const tip = new THREE.ConeGeometry(radius, radius * 2.4, 6, 1);
    tip.translate(0, length + radius * 1.2, 0);
    const piece = merged([prism, tip]);
    const angle = (index / count) * Math.PI * 2 + random();
    piece.rotateZ(main ? 0.08 : 0.35 + random() * 0.45);
    piece.rotateY(angle);
    if (!main) piece.translate(Math.cos(angle) * 0.14, 0, Math.sin(angle) * 0.14);
    shards.push(faceted(piece));
  }
  return { name: `crystal-${seed}`, parts: [{ geometry: shade(merged(shards), WHITE, 0.62, 1.22), role: "tint" }], height: 1.4, footprint: 0.9, sway: 0, glow: true };
}

/** A pine with snow resting on every tier; the whole tree sways together. */
function snowPine(seed: number): KitModel {
  const random = seededRandom(seed);
  const tiers: THREE.BufferGeometry[] = [];
  const caps: THREE.BufferGeometry[] = [];
  const count = 3 + (random() < 0.4 ? 1 : 0);
  for (let index = 0; index < count; index++) {
    const radius = 0.62 - index * 0.14;
    const apex = 0.62 + index * 0.42 + 0.78;
    const cone = new THREE.ConeGeometry(radius, 0.78, 9, 1);
    cone.translate(0, apex - 0.39, 0);
    tiers.push(cone);
    // Snow: a shallow cone over the tier's upper half, its rim drooping in
    // soft scallops.
    const capHeight = 0.42;
    const cap = new THREE.ConeGeometry(radius * 0.6, capHeight, 9, 2);
    const capPosition = cap.getAttribute("position");
    for (let vertex = 0; vertex < capPosition.count; vertex++) {
      const y = capPosition.getY(vertex);
      if (y < -capHeight / 2 + 1e-3) {
        const angle = Math.atan2(capPosition.getZ(vertex), capPosition.getX(vertex));
        capPosition.setY(vertex, y - 0.05 * (0.5 + 0.5 * Math.sin(angle * 4.5 + index)));
      }
    }
    cap.computeVertexNormals();
    cap.translate(0, apex - capHeight / 2 + 0.035, 0);
    caps.push(cap);
  }
  return {
    name: `snowpine-${seed}`,
    parts: [
      { geometry: merged([shade(trunk(0.75, 0.1), BARK, 0.8, 1), shade(merged(caps), SNOW, 0.9, 1.04)]), role: "fixed" },
      { geometry: shade(merged(tiers), WHITE, 0.6, 1.08), role: "tint" }
    ],
    height: 0.62 + count * 0.42 + 0.8,
    footprint: 1.3,
    sway: 0.025,
    swayAll: true
  };
}

/** Dead tree: a bent trunk with a few bare branches (volcanic ash). */
function deadTree(): KitModel {
  const random = seededRandom(61);
  const pieces: THREE.BufferGeometry[] = [];
  const stem = new THREE.CylinderGeometry(0.06, 0.12, 1.5, 6, 4);
  stem.translate(0, 0.75, 0);
  const stemPosition = stem.getAttribute("position");
  for (let index = 0; index < stemPosition.count; index++) {
    const t = stemPosition.getY(index) / 1.5;
    stemPosition.setX(index, stemPosition.getX(index) + Math.sin(t * 2.4) * 0.12);
  }
  stem.computeVertexNormals();
  pieces.push(stem);
  for (let index = 0; index < 4; index++) {
    const length = 0.45 + random() * 0.4;
    const branch = new THREE.CylinderGeometry(0.018, 0.045, length, 5, 1);
    branch.translate(0, length / 2, 0);
    branch.rotateZ((index % 2 ? 1 : -1) * (0.6 + random() * 0.45));
    branch.rotateY(index * 1.7 + random());
    const at = 0.65 + index * 0.2;
    branch.translate(Math.sin((at / 1.5) * 2.4) * 0.12, at, 0);
    pieces.push(branch);
  }
  return { name: "deadtree", parts: [{ geometry: shade(merged(pieces), WHITE, 0.7, 1.05), role: "tint" }], height: 1.8, footprint: 1, sway: 0.012 };
}

/** Rice: upright blades arching outward, a few with drooping grain heads. */
function riceTuft(seed: number): KitModel {
  const random = seededRandom(seed + 40);
  const blades: THREE.BufferGeometry[] = [];
  for (let index = 0; index < 7; index++) {
    const length = 0.46 + random() * 0.22;
    const blade = new THREE.ConeGeometry(0.024, length, 4, 4);
    blade.translate(0, length / 2, 0);
    const angle = (index / 7) * Math.PI * 2 + random() * 0.6;
    const bend = 0.12 + random() * 0.1;
    const position = blade.getAttribute("position");
    for (let vertex = 0; vertex < position.count; vertex++) {
      const t = position.getY(vertex) / length;
      position.setX(vertex, position.getX(vertex) + Math.cos(angle) * bend * t * t);
      position.setZ(vertex, position.getZ(vertex) + Math.sin(angle) * bend * t * t);
    }
    blade.computeVertexNormals();
    blades.push(blade);
    if (index % 3 === 0) {
      const grain = blob(0.035, Math.cos(angle) * (bend + 0.04), length * 0.93, Math.sin(angle) * (bend + 0.04), 1.9, 1);
      blades.push(grain);
    }
  }
  return { name: `rice-${seed}`, parts: [{ geometry: shade(merged(blades), WHITE, 0.6, 1.12), role: "tint" }], height: 0.62, footprint: 0.34, sway: 0.08, small: true };
}

/** Sandstone pillar: stacked weathered drums, faceted. */
function pillar(seed: number): KitModel {
  const random = seededRandom(seed + 90);
  const drums: THREE.BufferGeometry[] = [];
  let y = 0;
  const count = 4;
  for (let index = 0; index < count; index++) {
    const radius = 0.48 - index * 0.06 + random() * 0.05;
    const height = 0.44 + random() * 0.14;
    const drum = new THREE.CylinderGeometry(radius * 0.92, radius, height, 7, 1);
    drum.translate((random() - 0.5) * 0.08, y + height / 2, (random() - 0.5) * 0.08);
    drums.push(faceted(drum));
    y += height * 0.97;
  }
  const top = new THREE.CylinderGeometry(0.42, 0.34, 0.16, 7, 1);
  top.translate(0, y + 0.08, 0);
  drums.push(faceted(top));
  return { name: `pillar-${seed}`, parts: [{ geometry: shade(merged(drums), WHITE, 0.74, 1.08), role: "tint" }], height: y + 0.16, footprint: 1, sway: 0 };
}

/** A floating rock shard (crystal islands), bobbing slowly. */
function shard(seed: number): KitModel {
  const random = seededRandom(seed + 7);
  const body = new THREE.OctahedronGeometry(0.36, 0);
  body.scale(0.85, 1.55, 0.7);
  body.rotateY(random() * Math.PI);
  body.translate(0, 0.56, 0);
  const geometry = faceted(body);
  return { name: `shard-${seed}`, parts: [{ geometry: shade(merged([geometry]), WHITE, 0.7, 1.15), role: "tint" }], height: 1.12, footprint: 0.6, sway: 0, bob: true, glow: true };
}

/** A lightweight cloud sheet. The shader makes one continuous soft density
 * field rather than intersecting opaque sphere shells. */
export function cloudGeometry(seed: number) {
  const geometry = new THREE.PlaneGeometry(8, 3.8);
  geometry.setAttribute("aCloudSeed", new THREE.Float32BufferAttribute(new Float32Array(4).fill(seed), 1));
  return geometry;
}

export const TREE_KINDS = ["round", "pine", "poplar", "bush"] as const;

/** All kit models, built once per world. */
export function buildKit(): Map<string, KitModel> {
  const models = [
    roundTree(11), roundTree(23), roundTree(37),
    pine(5), pine(9),
    poplar(),
    bush(3), bush(8),
    rock(1), rock(2), rock(4),
    grassTuft(1), grassTuft(2),
    flower(),
    mushroom(),
    // Climate kit.
    palm(1), palm(2),
    cactus(1), cactus(2),
    crystalCluster(1), crystalCluster(2),
    snowPine(5), snowPine(9),
    deadTree(),
    riceTuft(1), riceTuft(2),
    pillar(1), pillar(2),
    shard(1), shard(2)
  ];
  return new Map(models.map(model => [model.name, model]));
}

export function disposeKit(kit: Map<string, KitModel>) {
  for (const model of kit.values()) for (const part of model.parts) part.geometry.dispose();
}
