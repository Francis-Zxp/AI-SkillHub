// Builds the bundled sky-island asset libraries from the downloaded source kits.
//
//   node scripts/sky-assets/build.mjs <assets-src> <webp-dir> <out-dir> [library...]
//
// Each library becomes one GLB whose scene holds one root node per model,
// named after the model, so the runtime loads a file once and instances parts
// by name. Textures are replaced by the WebP files from textures.py (shared
// images are deduplicated), unused maps are dropped and vertex attributes are
// quantized. No source kit file is copied into the repository as-is.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS, EXTTextureWebP } from "@gltf-transform/extensions";
import { dedup, prune, quantize, weld } from "@gltf-transform/functions";
import { mergeDocuments } from "@gltf-transform/functions";
import { composeBuildings } from "./buildings.mjs";

const [srcDir, webpDir, outDir, ...only] = process.argv.slice(2);
if (!srcDir || !webpDir || !outDir) {
  console.error("usage: build.mjs <assets-src> <webp-dir> <out-dir> [library...]");
  process.exit(2);
}
const here = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(here, "manifest.json"), "utf8"));
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
fs.mkdirSync(outDir, { recursive: true });

function stem(value) {
  return path.basename(String(value ?? "")).replace(/\.[^.]+$/, "");
}

/** Copies every model into one document; returns { document, roots: name -> Node }. */
async function mergeModels(dir, names) {
  const document = await io.read(path.join(srcDir, dir, `${names[0]}.gltf`));
  const scene = document.getRoot().listScenes()[0];
  const roots = new Map();
  const wrap = (name, nodes) => {
    const root = document.createNode(name);
    for (const node of nodes) {
      scene.removeChild(node);
      root.addChild(node);
    }
    scene.addChild(root);
    roots.set(name, root);
  };
  wrap(names[0], scene.listChildren());
  for (const name of names.slice(1)) {
    const source = await io.read(path.join(srcDir, dir, `${name}.gltf`));
    const before = new Set(scene.listChildren());
    const map = mergeDocuments(document, source);
    const sourceScene = source.getRoot().listScenes()[0];
    const merged = sourceScene.listChildren().map(node => map.get(node));
    // mergeDocuments creates a second scene; move its roots into ours.
    for (const extraScene of document.getRoot().listScenes().slice(1)) extraScene.dispose();
    wrap(name, merged.filter(node => node && !before.has(node)));
  }
  return { document, roots };
}

function dropMaps(document, maps = []) {
  for (const material of document.getRoot().listMaterials()) {
    if (maps.includes("normalTexture")) material.setNormalTexture(null);
    if (maps.includes("metallicRoughnessTexture") && material.getMetallicRoughnessTexture()) {
      // glTF defaults metallicFactor to 1; without its map the surface would
      // turn into dark polished metal.
      material.setMetallicRoughnessTexture(null);
      // The scene has no environment map, so even metal reads better half-metallic.
      material.setMetallicFactor(/metal/i.test(material.getName()) ? 0.45 : 0);
      material.setRoughnessFactor(/metal/i.test(material.getName()) ? 0.55 : 0.88);
    }
    if (maps.includes("occlusionTexture")) material.setOcclusionTexture(null);
    if (maps.includes("emissiveTexture")) material.setEmissiveTexture(null);
  }
}

function useWebp(document, label) {
  const extension = document.createExtension(EXTTextureWebP).setRequired(true);
  let replaced = 0;
  for (const texture of document.getRoot().listTextures()) {
    const name = stem(texture.getURI() || texture.getName());
    const file = path.join(webpDir, `${name}.webp`);
    if (!fs.existsSync(file)) {
      console.warn(`[${label}] no WebP for ${name}; texture removed`);
      texture.dispose();
      continue;
    }
    texture.setImage(new Uint8Array(fs.readFileSync(file))).setMimeType("image/webp").setURI(`${name}.webp`).setName(name);
    replaced += 1;
  }
  if (replaced === 0) extension.dispose();
  return replaced;
}

async function finish(document, label, file) {
  await document.transform(
    dedup(),
    prune({ keepLeaves: true }),
    weld(),
    quantize({ quantizePosition: 14, quantizeNormal: 10, quantizeTexcoord: 12, quantizeColor: 8 })
  );
  // A merged library keeps one buffer.
  const buffers = document.getRoot().listBuffers();
  for (const buffer of buffers.slice(1)) {
    for (const accessor of document.getRoot().listAccessors()) {
      if (accessor.getBuffer() === buffer) accessor.setBuffer(buffers[0]);
    }
    buffer.dispose();
  }
  await io.write(file, document);
  const size = fs.statSync(file).size;
  const root = document.getRoot();
  console.log(`${label}: ${(size / 1024).toFixed(0)} KiB, ${root.listScenes()[0].listChildren().length} models, ${root.listMeshes().length} meshes, ${root.listTextures().length} textures`);
}

const wanted = only.length ? only : [...Object.keys(manifest.libraries), "buildings", "villager", "gull", "textures"];

if (wanted.includes("textures")) {
  // Tiling textures sampled in world space by the terrain shader.
  const target = path.join(outDir, "textures");
  fs.mkdirSync(target, { recursive: true });
  fs.copyFileSync(path.join(webpDir, "T_BrushedNoise.webp"), path.join(target, "brush.webp"));
  fs.copyFileSync(path.join(webpDir, "T_Noise_Terrain.webp"), path.join(target, "noise.webp"));
  console.log("textures: brush.webp, noise.webp");
}

for (const [name, library] of Object.entries(manifest.libraries)) {
  if (!wanted.includes(name)) continue;
  const { document } = await mergeModels(library.dir, library.models);
  dropMaps(document, library.dropMaps);
  useWebp(document, name);
  await finish(document, name, path.join(outDir, `${name}.glb`));
}

if (wanted.includes("buildings")) {
  const document = await composeBuildings(io, srcDir);
  dropMaps(document, ["metallicRoughnessTexture", "occlusionTexture"]);
  for (const material of document.getRoot().listMaterials()) {
    // Only the roof tiles keep their relief map; everything else reads well flat.
    if (!/RoundTiles/i.test(material.getName())) material.setNormalTexture(null);
  }
  useWebp(document, "buildings");
  await finish(document, "buildings", path.join(outDir, "buildings.glb"));
}

if (wanted.includes("modules")) {
  // Lab-only: every village module, to inspect orientation and sizes.
  const dir = path.join(srcDir, "village");
  const names = fs.readdirSync(dir).filter(file => file.endsWith(".gltf")).map(stem).sort();
  const { document } = await mergeModels("village", names);
  dropMaps(document, ["normalTexture", "metallicRoughnessTexture", "occlusionTexture"]);
  useWebp(document, "modules");
  await finish(document, "modules", path.join(outDir, "modules.glb"));
}

if (wanted.includes("villager")) {
  const document = await io.read(path.join(srcDir, manifest.sources.villager.file));
  const keep = new Set(["CharacterArmature|Idle", "CharacterArmature|Idle_Neutral", "CharacterArmature|Walk", "CharacterArmature|Wave", "CharacterArmature|Interact"]);
  for (const animation of document.getRoot().listAnimations()) {
    if (!keep.has(animation.getName())) animation.dispose();
  }
  await document.transform(prune({ keepLeaves: true }));
  await io.write(path.join(outDir, "villager.glb"), document);
  console.log(`villager: ${(fs.statSync(path.join(outDir, "villager.glb")).size / 1024).toFixed(0)} KiB, ${document.getRoot().listAnimations().length} animations`);
}

if (wanted.includes("gull")) {
  const document = await io.read(path.join(srcDir, manifest.sources.gull.file));
  await document.transform(dedup(), prune(), weld());
  await io.write(path.join(outDir, "gull.glb"), document);
  console.log(`gull: ${(fs.statSync(path.join(outDir, "gull.glb")).size / 1024).toFixed(0)} KiB`);
}
