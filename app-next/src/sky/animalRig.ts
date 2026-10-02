import type { SkinnedMesh } from "three";
import type { GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";

/** The farm FBX rigs skin the hooves partly to root-level IK targets. FBX
 * constraint evaluation is not carried into glTF: those targets move away
 * from the animated lower legs, stretching the hooves during walking/jumping.
 * These animals have no toe articulation; keep that weight on the matching
 * deforming lower leg. Body, leg, head and tail animation stays intact. */
export function repairFarmHoofWeights(gltf: GLTF) {
  const visited = new Set<object>();
  gltf.scene.traverse(object => {
    const mesh = object as SkinnedMesh;
    if (!mesh.isSkinnedMesh) return;
    const indices = mesh.geometry.getAttribute("skinIndex");
    if (!indices || visited.has(indices)) return;
    visited.add(indices);
    const bones = mesh.skeleton.bones;
    const replacements = bones.map((bone, index) => {
      if (!/^(Front|Back)Foot[LR]$/.test(bone.name) || bone.parent?.name !== "root") return index;
      const lower = bones.findIndex(candidate => candidate.name === bone.name.replace("Foot", "LowLeg"));
      return lower < 0 ? index : lower;
    });
    // Accessors also handle GLTFLoader's interleaved buffers correctly.
    for (let vertex = 0; vertex < indices.count; vertex++) {
      indices.setXYZW(vertex,
        replacements[indices.getX(vertex)], replacements[indices.getY(vertex)],
        replacements[indices.getZ(vertex)], replacements[indices.getW(vertex)]);
    }
    indices.needsUpdate = true;
  });
}
