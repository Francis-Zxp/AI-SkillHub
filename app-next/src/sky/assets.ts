// Loads the bundled sky-world libraries (built by scripts/sky-assets) and turns
// every named model into a template of geometry + material parts that can be
// instanced. Everything is local: no remote URLs, works offline.
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { bakeCanopy, foliageMaterial, swayMaterial } from "./materials";
import type { SkyPalette } from "./materials";

export type TemplatePart = { geometry: THREE.BufferGeometry; material: THREE.Material; matrix: THREE.Matrix4 };
export type ModelTemplate = { name: string; parts: TemplatePart[]; box: THREE.Box3; height: number; footprint: number };

export type SkyLibrary = {
  nature: Map<string, ModelTemplate>;
  buildings: Map<string, ModelTemplate>;
  props: Map<string, ModelTemplate>;
  villager: GLTF;
  gull: ModelTemplate;
  textures: { brush: THREE.Texture; noise: THREE.Texture };
  dispose: () => void;
};

let pending: Promise<RawLibrary> | null = null;

type RawLibrary = {
  nature: GLTF;
  buildings: GLTF;
  props: GLTF;
  villager: GLTF;
  gull: GLTF;
  brush: THREE.Texture;
  noise: THREE.Texture;
};

function assetBase(): string {
  const base = (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? "/";
  return `${base.endsWith("/") ? base : `${base}/`}sky/`;
}

async function loadTexture(url: string): Promise<THREE.Texture> {
  const texture = await new THREE.TextureLoader().loadAsync(url);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.NoColorSpace;
  texture.anisotropy = 4;
  return texture;
}

/** The raw files are cached for the session; templates are rebuilt per palette. */
function loadRaw(): Promise<RawLibrary> {
  if (pending) return pending;
  const base = assetBase();
  const loader = new GLTFLoader();
  pending = Promise.all([
    loader.loadAsync(`${base}nature.glb`),
    loader.loadAsync(`${base}buildings.glb`),
    loader.loadAsync(`${base}props.glb`),
    loader.loadAsync(`${base}villager.glb`),
    loader.loadAsync(`${base}gull.glb`),
    loadTexture(`${base}textures/brush.webp`),
    loadTexture(`${base}textures/noise.webp`)
  ]).then(([nature, buildings, props, villager, gull, brush, noise]) => ({ nature, buildings, props, villager, gull, brush, noise }));
  pending.catch(() => {
    pending = null;
  });
  return pending;
}

function isMaskFoliage(material: THREE.MeshStandardMaterial) {
  const name = material.map?.name ?? material.name;
  return material.alphaTest > 0 && /_C$/i.test(name ?? "") || /Leaves_(NormalTree|TwistedTree|GiantPine)|Leaves_Pine|Leaf_Pine/i.test(material.name);
}

function windScaleFor(name: string) {
  if (/^Grass/.test(name)) return 0.13;
  if (/^(Flower|Clover|Plant|Fern)/.test(name)) return 0.08;
  if (/^Bush/.test(name)) return 0.04;
  if (/Tree|Pine/.test(name)) return 0.022;
  return 0;
}

function templatesFrom(gltf: GLTF, palette: SkyPalette | null, materialCache: Map<string, THREE.Material>): Map<string, ModelTemplate> {
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
      const geometry = mesh.geometry;
      geometry.computeBoundingBox();
      box.union(geometry.boundingBox!.clone().applyMatrix4(matrix));
      parts.push({ geometry, material: mesh.material as THREE.Material, matrix });
    });
    const height = Math.max(0.01, box.max.y - Math.min(0, box.min.y));
    const wind = palette ? windScaleFor(root.name) : 0;
    for (const part of parts) {
      const source = part.material as THREE.MeshStandardMaterial;
      if (!palette || !source.isMeshStandardMaterial) continue;
      const key = `${source.uuid}:${root.name.replace(/_\d+$/, "")}`;
      if (isMaskFoliage(source)) {
        if (!part.geometry.getAttribute("aCanopy")) bakeCanopy(part.geometry);
        part.material = materialCache.get(key) ?? foliageMaterial(source, palette, height, wind || 0.02);
      } else if (wind > 0) {
        const gradient = /^Grass/.test(root.name) ? { root: palette.grassDark, tip: palette.grassLight } : undefined;
        part.material = materialCache.get(key) ?? swayMaterial(source, height, wind, gradient);
      }
      materialCache.set(key, part.material);
    }
    templates.set(root.name, {
      name: root.name,
      parts,
      box,
      height,
      footprint: Math.max(box.max.x - box.min.x, box.max.z - box.min.z)
    });
  }
  return templates;
}

export async function loadSkyLibrary(palette: SkyPalette): Promise<SkyLibrary> {
  const raw = await loadRaw();
  const materials = new Map<string, THREE.Material>();
  const nature = templatesFrom(raw.nature, palette, materials);
  const buildings = templatesFrom(raw.buildings, null, materials);
  const props = templatesFrom(raw.props, null, materials);
  const gull = templatesFrom(raw.gull, null, materials).values().next().value as ModelTemplate;
  for (const template of [...buildings.values()]) {
    for (const part of template.parts) {
      const material = part.material as THREE.MeshStandardMaterial;
      if (/glass/i.test(material.name) && palette.windowGlow > 0) {
        const lit = material.clone();
        lit.emissive = new THREE.Color("#ffb45c");
        lit.emissiveIntensity = 1.4 * palette.windowGlow;
        part.material = lit;
        materials.set(`${material.uuid}:glow`, lit);
      }
    }
  }
  return {
    nature,
    buildings,
    props,
    villager: raw.villager,
    gull,
    textures: { brush: raw.brush, noise: raw.noise },
    dispose() {
      // Palette materials are per world; raw geometry/textures stay cached.
      for (const material of materials.values()) {
        if (!(material as THREE.MeshStandardMaterial).userData?.fromGltf) material.dispose();
      }
    }
  };
}

/** Releases the cached GPU-side resources of the raw files (app teardown). */
export function releaseSkyLibraryCache() {
  if (!pending) return;
  const current = pending;
  pending = null;
  void current.then(raw => {
    for (const gltf of [raw.nature, raw.buildings, raw.props, raw.villager, raw.gull]) {
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
    raw.brush.dispose();
    raw.noise.dispose();
  }).catch(() => undefined);
}
