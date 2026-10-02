import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { AnimationMixer, Vector3 } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { repairFarmHoofWeights } from "../src/sky/animalRig.ts";

async function load(name) {
  const bytes = await readFile(new URL(`../public/sky/animals/${name}.glb`, import.meta.url));
  return new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), "");
}

// Edges wholly within a hoof's deform region: all nonzero weights belong to
// that hoof's IK target or its lower leg. Such an edge must remain rigid while
// the whole leg moves. This detects the reported skis, not just valid buffers.
function hoofEdges(gltf) {
  const edges = [];
  gltf.scene.traverse(mesh => {
    if (!mesh.isSkinnedMesh) return;
    const skin = mesh.geometry.attributes.skinIndex;
    const weights = mesh.geometry.attributes.skinWeight;
    const read = (a, v) => [a.getX(v), a.getY(v), a.getZ(v), a.getW(v)];
    const membership = [];
    for (let v = 0; v < skin.count; v++) {
      const active = read(skin, v).filter((_, slot) => read(weights, v)[slot] > 0.001).map(i => mesh.skeleton.bones[i].name);
      const foot = active.find(name => /^(Front|Back)Foot[LR]$/.test(name));
      membership[v] = foot && active.every(name => name === foot || name === foot.replace("Foot", "LowLeg")) ? foot : null;
    }
    const index = mesh.geometry.index;
    for (let t = 0; t < (index?.count ?? skin.count); t += 3) {
      const vertices = [0, 1, 2].map(offset => index ? index.getX(t + offset) : t + offset);
      for (let side = 0; side < 3; side++) {
        const a = vertices[side], b = vertices[(side + 1) % 3];
        if (membership[a] && membership[a] === membership[b]) edges.push({ mesh, a, b });
      }
    }
  });
  return edges;
}

function measure(gltf, edges) {
  const mixer = new AnimationMixer(gltf.scene);
  const a = new Vector3(), b = new Vector3();
  const sizes = () => edges.map(edge => edge.mesh.getVertexPosition(edge.a, a).distanceTo(edge.mesh.getVertexPosition(edge.b, b)));
  const idle = gltf.animations.find(clip => clip.name.endsWith("|Idle"));
  mixer.clipAction(idle).play();
  mixer.setTime(0);
  gltf.scene.updateMatrixWorld(true);
  const rest = sizes();
  let worst = 1, motion = 0;
  const first = edges[0].mesh.getVertexPosition(edges[0].a, new Vector3());
  for (const clip of gltf.animations) {
    mixer.stopAllAction();
    mixer.clipAction(clip).reset().play();
    for (let frame = 0; frame <= 24; frame++) {
      mixer.setTime(clip.duration * frame / 25);
      gltf.scene.updateMatrixWorld(true);
      sizes().forEach((size, index) => {
        if (rest[index] > 1e-4) worst = Math.max(worst, size / rest[index]);
      });
      motion = Math.max(motion, edges[0].mesh.getVertexPosition(edges[0].a, a).distanceTo(first));
    }
  }
  mixer.stopAllAction();
  mixer.uncacheRoot(gltf.scene);
  return { worst, motion, edges: edges.length, frames: gltf.animations.length * 25 };
}

for (const name of ["Horse", "Cow", "Sheep", "Pig", "Llama", "Pug"]) {
  test(`${name}: all animation clips keep hooves rigid and moving`, async () => {
    const original = await load(name);
    const before = measure(original, hoofEdges(original));
    const fixed = await load(name);
    const edges = hoofEdges(fixed);
    assert.ok(edges.length > 20, "enough real hoof edges sampled");
    repairFarmHoofWeights(fixed);
    const after = measure(fixed, edges);
    assert.ok(before.worst > 2, "original asset reproduces hoof stretching");
    assert.ok(after.worst < 1.02, JSON.stringify(after));
    assert.ok(after.motion > 0.1, "animation still moves the limbs");
    console.log(JSON.stringify({ name, before, after }));
  });
}
