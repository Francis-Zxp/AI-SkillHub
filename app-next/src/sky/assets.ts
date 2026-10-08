// Loads the bundled sky-world models (built by scripts/sky-assets) and turns
// them into cartoon templates: buildings get flat colours by material
// (plaster, timber, stone, glass, roof), props keep their small colour-atlas
// textures, characters and animals keep their own colours; all toon shaded.
// Everything is local: no remote URLs, works offline.
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { AnimalName } from "./biomes";
import type { SkyPalette } from "./materials";
import { toonGradient, toonMaterial } from "./materials";
import { repairFarmHoofWeights } from "./animalRig";

export type TemplatePart = { geometry: THREE.BufferGeometry; material: THREE.Material; matrix: THREE.Matrix4; role?: string };
export type ModelTemplate = { name: string; parts: TemplatePart[]; box: THREE.Box3; height: number; footprint: number };

export const ANIMALS: AnimalName[] = ["Sheep", "Pig", "Cow", "Llama", "Pug", "Horse"];

export type SkyLibrary = {
  buildings: Map<string, ModelTemplate>;
  props: Map<string, ModelTemplate>;
  villager: GLTF;
  animals: Map<AnimalName, GLTF>;
  gull: ModelTemplate;
  /** A building material set for a roof colour (shared per colour). */
  roofMaterial: (color: string) => THREE.Material;
  /** Lit windows follow the time of day without rebuilding the scene. */
  setPalette: (palette: SkyPalette) => void;
  dispose: () => void;
};

let pending: Promise<RawLibrary> | null = null;
/** The same files once loaded, for synchronous release. */
let loaded: RawLibrary | null = null;

type RawLibrary = {
  buildings: GLTF;
  props: GLTF;
  villager: GLTF;
  gull: GLTF;
  animals: Map<AnimalName, GLTF>;
};

function assetBase(): string {
  const base = (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? "/";
  return `${base.endsWith("/") ? base : `${base}/`}sky/`;
}

/** The raw files are cached for the session; templates are rebuilt per palette. */
function loadRaw(): Promise<RawLibrary> {
  if (pending) return pending;
  const base = assetBase();
  const loader = new GLTFLoader();
  pending = Promise.all([
    loader.loadAsync(`${base}buildings.glb`),
    loader.loadAsync(`${base}props.glb`),
    loader.loadAsync(`${base}villager.glb`),
    loader.loadAsync(`${base}gull.glb`),
    Promise.all(ANIMALS.map(name => loader.loadAsync(`${base}animals/${name}.glb`)))
  ]).then(([buildings, props, villager, gull, animals]) => {
    // A cottage arrives as 42 meshes, a tower as 114: one per material is
    // enough, and every mesh is a draw call (twice, with shadows).
    mergeByMaterial(buildings);
    mergeByMaterial(props);
    const toonify = (gltf: GLTF, animal = false) => gltf.scene.traverse(object => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      const materials = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) as THREE.MeshStandardMaterial[];
      const converted = materials.map(source => animal ? new THREE.MeshStandardMaterial({
        color: source.color?.clone() ?? new THREE.Color(1, 1, 1),
        map: source.map ?? null, vertexColors: source.vertexColors,
        roughness: 0.82, metalness: 0, name: source.name
      }) : new THREE.MeshToonMaterial({
        gradientMap: toonGradient(),
        color: source.color?.clone() ?? new THREE.Color(1, 1, 1),
        map: source.map ?? null,
        name: source.name
      }));
      mesh.material = Array.isArray(mesh.material) ? converted : converted[0];
      mesh.castShadow = true;
    });
    toonify(villager);
    animals.forEach(gltf => {
      repairFarmHoofWeights(gltf);
      toonify(gltf, true);
      mergeSkinnedParts(gltf);
    });
    loaded = { buildings, props, villager, gull, animals: new Map(ANIMALS.map((name, index) => [name, animals[index]])) };
    return loaded;
  });
  pending.catch(() => {
    pending = null;
  });
  return pending;
}

/** Fires `dispose` on everything in the cached files, keeping their data. */
function disposeScenes(raw: RawLibrary) {
  const textures = new Set<THREE.Texture>();
  const materials = new Set<THREE.Material>();
  for (const gltf of [raw.buildings, raw.props, raw.villager, raw.gull, ...raw.animals.values()]) {
    gltf.scene.traverse(object => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry.dispose();
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) materials.add(material);
    });
  }
  for (const material of materials) {
    for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value);
    material.dispose();
  }
  for (const texture of textures) texture.dispose();
}

/**
 * Every renderer that drew the cached models left a `dispose` listener on
 * them, and through it kept its whole WebGL context alive after the world
 * was gone (about 8 MB of GPU memory per rebuilt world). Firing `dispose`
 * once no world is left lets those listeners go; the cached data stays and
 * the next world uploads it again.
 */
export function releaseSharedGpuListeners() {
  if (loaded) disposeScenes(loaded);
}

/** Copies an attribute as plain floats, in index order when indexed. */
function plainAttribute(attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, index: THREE.BufferAttribute | null) {
  const count = index ? index.count : attribute.count;
  const size = attribute.itemSize;
  const array = new Float32Array(count * size);
  for (let vertex = 0; vertex < count; vertex++) {
    const source = index ? index.getX(vertex) : vertex;
    array[vertex * size] = attribute.getX(source);
    if (size > 1) array[vertex * size + 1] = attribute.getY(source);
    if (size > 2) array[vertex * size + 2] = attribute.getZ(source);
    if (size > 3) array[vertex * size + 3] = attribute.getW(source);
  }
  return new THREE.Float32BufferAttribute(array, size);
}

/**
 * Each model (a root child of the file) keeps one mesh per material: its
 * meshes sharing a material are merged in the model's own space. Done once
 * per session on the cached files; the originals are released.
 */
function mergeByMaterial(gltf: GLTF) {
  gltf.scene.updateMatrixWorld(true);
  for (const root of gltf.scene.children) {
    const inverse = root.matrixWorld.clone().invert();
    const groups = new Map<THREE.Material, THREE.Mesh[]>();
    root.traverse(object => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh || (mesh as THREE.SkinnedMesh).isSkinnedMesh || Array.isArray(mesh.material)) return;
      groups.set(mesh.material, [...(groups.get(mesh.material) ?? []), mesh]);
    });
    for (const [material, meshes] of groups) {
      if (meshes.length < 2) continue;
      const names = ["position", "normal", "uv"].filter(name => meshes.every(mesh => mesh.geometry.getAttribute(name)));
      if (!names.includes("position") || !names.includes("normal")) continue;
      const pieces = meshes.map(mesh => {
        const piece = new THREE.BufferGeometry();
        for (const name of names) piece.setAttribute(name, plainAttribute(mesh.geometry.getAttribute(name), mesh.geometry.index));
        return piece.applyMatrix4(inverse.clone().multiply(mesh.matrixWorld));
      });
      const merged = mergeGeometries(pieces, false);
      for (const piece of pieces) piece.dispose();
      if (!merged) continue;
      const combined = new THREE.Mesh(merged, material);
      combined.name = `${root.name}:${material.name}`;
      root.add(combined);
      for (const mesh of meshes) {
        mesh.removeFromParent();
        mesh.geometry.dispose();
      }
    }
  }
  gltf.scene.updateMatrixWorld(true);
}

/**
 * The converted animals arrive as dozens of skinned sub-meshes (one per
 * material range of the original FBX). Sub-meshes sharing a skeleton and a
 * colour are merged, so each animal draws in one call per colour.
 */
function mergeSkinnedParts(gltf: GLTF) {
  const groups = new Map<string, THREE.SkinnedMesh[]>();
  gltf.scene.traverse(object => {
    const mesh = object as THREE.SkinnedMesh;
    if (!mesh.isSkinnedMesh || Array.isArray(mesh.material)) return;
    const material = mesh.material as THREE.MeshToonMaterial;
    const key = `${mesh.skeleton.bones[0]?.uuid}:${mesh.parent?.uuid}:${material.color.getHexString()}:${material.map?.uuid ?? ""}`;
    groups.set(key, [...(groups.get(key) ?? []), mesh]);
  });
  for (const meshes of groups.values()) {
    if (meshes.length < 2) continue;
    // Ranges differ in which attributes they carry; keep the common skinned
    // set, non-indexed, with consistent types, so they can merge.
    const uniform = meshes.map(mesh => {
      const source = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry;
      const plain = new THREE.BufferGeometry();
      for (const name of ["position", "normal", "skinWeight", "uv", "color"]) {
        const attribute = source.getAttribute(name);
        if (attribute) plain.setAttribute(name, new THREE.Float32BufferAttribute(Array.from(attribute.array as ArrayLike<number>), attribute.itemSize));
      }
      const skinIndex = source.getAttribute("skinIndex");
      if (skinIndex) plain.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(Array.from(skinIndex.array as ArrayLike<number>), skinIndex.itemSize));
      return plain;
    });
    if (uniform.some(item => !item.getAttribute("skinIndex") || !item.getAttribute("normal"))) continue;
    const geometry = mergeGeometries(uniform, false);
    if (!geometry) continue;
    const first = meshes[0];
    const merged = new THREE.SkinnedMesh(geometry, first.material);
    merged.name = first.name;
    merged.position.copy(first.position);
    merged.quaternion.copy(first.quaternion);
    merged.scale.copy(first.scale);
    merged.castShadow = true;
    first.parent!.add(merged);
    merged.bind(first.skeleton, first.bindMatrix);
    for (const mesh of meshes) {
      mesh.parent?.remove(mesh);
      mesh.geometry.dispose();
    }
  }
}

function templatesFrom(gltf: GLTF, material: (source: THREE.MeshStandardMaterial) => THREE.Material, roleOf: (source: THREE.Material) => string | undefined = () => undefined) {
  const templates = new Map<string, ModelTemplate>();
  gltf.scene.updateMatrixWorld(true);
  for (const root of gltf.scene.children) {
    const inverse = root.matrixWorld.clone().invert();
    const parts: TemplatePart[] = [];
    const box = new THREE.Box3();
    root.traverse(object => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      const matrix = inverse.clone().multiply(mesh.matrixWorld);
      mesh.geometry.computeBoundingBox();
      box.union(mesh.geometry.boundingBox!.clone().applyMatrix4(matrix));
      const source = mesh.material as THREE.MeshStandardMaterial;
      parts.push({ geometry: mesh.geometry, material: material(source), matrix, role: roleOf(source) });
    });
    templates.set(root.name, {
      name: root.name,
      parts,
      box,
      height: Math.max(0.01, box.max.y - Math.min(0, box.min.y)),
      footprint: Math.max(box.max.x - box.min.x, box.max.z - box.min.z)
    });
  }
  return templates;
}

const BUILDING_COLORS: Array<[RegExp, string]> = [
  [/Plaster/i, "#f5ead6"],
  [/WoodTrim/i, "#8c5a3a"],
  [/RockTrim/i, "#b9b0a4"],
  [/UnevenBrick|Brick/i, "#c8b9a6"],
  [/Metal/i, "#4b4d57"],
  [/Glass/i, "#a9d6ec"]
];

export async function loadSkyLibrary(palette: SkyPalette): Promise<SkyLibrary> {
  const raw = await loadRaw();
  const owned: THREE.Material[] = [];
  const keep = <T extends THREE.Material>(material: T) => (owned.push(material), material);
  const shared = new Map<string, THREE.Material>();
  const flat = (name: string, colour: string, emissive?: string, intensity = 0) => {
    const key = `${name}:${colour}`;
    if (!shared.has(key)) {
      shared.set(key, keep(toonMaterial({ vertexColors: false, color: colour, emissive: emissive ?? "#000000", emissiveIntensity: intensity })));
    }
    return shared.get(key)!;
  };
  const glass = keep(toonMaterial({ vertexColors: false, color: palette.night ? "#e8bb74" : "#a9d6ec", emissive: "#ffb24d", emissiveIntensity: palette.night * 0.65 }));
  const buildings = templatesFrom(
    raw.buildings,
    source => {
      if (/RoundTiles/i.test(source.name)) return flat("roof", "#d4643c");
      if (/Glass/i.test(source.name)) return glass;
      const match = BUILDING_COLORS.find(([pattern]) => pattern.test(source.name));
      return flat(source.name, match ? match[1] : "#e8dccb");
    },
    source => (/RoundTiles/i.test(source.name) ? "roof" : undefined)
  );
  const props = templatesFrom(raw.props, source => {
    const key = `prop:${source.uuid}`;
    if (!shared.has(key)) shared.set(key, keep(new THREE.MeshToonMaterial({ gradientMap: toonGradient(), map: source.map ?? null, color: source.color?.clone() ?? 0xffffff })));
    return shared.get(key)!;
  });
  const gull = templatesFrom(raw.gull, () => keep(toonMaterial({ vertexColors: false, color: "#f6f7f9" }))).values().next().value as ModelTemplate;
  return {
    buildings,
    props,
    villager: raw.villager,
    animals: raw.animals,
    gull,
    roofMaterial: colour => flat("roof", colour),
    setPalette(next) {
      glass.color.set(next.night ? "#e8bb74" : "#a9d6ec");
      glass.emissiveIntensity = next.night * 0.65;
    },
    dispose() {
      // Materials made for this palette; raw geometry and textures stay cached.
      for (const material of owned) material.dispose();
    }
  };
}

/** Releases the cached GPU resources of the raw files (app teardown). */
export function releaseSkyLibraryCache() {
  if (!pending) return;
  const current = pending;
  pending = null;
  void current.then(raw => {
    for (const gltf of [raw.buildings, raw.props, raw.villager, raw.gull, ...raw.animals.values()]) {
      gltf.scene.traverse(object => {
        const mesh = object as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.geometry.dispose();
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const material of materials) {
          for (const value of Object.values(material)) if (value instanceof THREE.Texture) value.dispose();
          material.dispose();
        }
      });
    }
  }).catch(() => undefined);
}
