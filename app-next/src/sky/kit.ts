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
export type KitModel = { name: string; parts: KitPart[]; height: number; footprint: number };

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
  geometry.computeVertexNormals();
  return { name: `rock-${seed}`, parts: [{ geometry: shade(merged([geometry]), WHITE, 0.78, 1.05), role: "tint" }], height: 0.62, footprint: 1.15 };
}

function grassTuft(seed: number): KitModel {
  const random = seededRandom(seed);
  const blades: THREE.BufferGeometry[] = [];
  for (let index = 0; index < 5; index++) {
    const blade = new THREE.ConeGeometry(0.045, 0.3 + random() * 0.18, 3, 1);
    blade.translate(0, blade.parameters.height / 2, 0);
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

/** Puffy cartoon cloud: flattened bottom, rounded top. */
export function cloudGeometry(seed: number) {
  const random = seededRandom(seed);
  const balls: THREE.BufferGeometry[] = [];
  const count = 5 + Math.floor(random() * 3);
  for (let index = 0; index < count; index++) {
    const t = index / (count - 1) - 0.5;
    const radius = 0.9 + Math.cos(t * Math.PI) * 0.9 + random() * 0.3;
    balls.push(blob(radius, t * 4.4 + (random() - 0.5) * 0.4, radius * 0.35, (random() - 0.5) * 1.2, 0.8, 2));
  }
  const flatBottom = merged(balls);
  const position = flatBottom.getAttribute("position");
  for (let index = 0; index < position.count; index++) {
    if (position.getY(index) < 0) position.setY(index, position.getY(index) * 0.25);
  }
  flatBottom.deleteAttribute("normal");
  const geometry = mergeVertices(flatBottom, 1e-3);
  geometry.computeVertexNormals();
  return shade(geometry, WHITE, 0.82, 1.0);
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
    mushroom()
  ];
  return new Map(models.map(model => [model.name, model]));
}

export function disposeKit(kit: Map<string, KitModel>) {
  for (const model of kit.values()) for (const part of model.parts) part.geometry.dispose();
}
