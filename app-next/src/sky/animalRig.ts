import { Quaternion, Vector3, type Bone, type Object3D, type SkinnedMesh } from "three";
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

/** Reconstruct the two-bone IK omitted by the FBX exporter. The authored
 * root-level Foot tracks are targets, not deform bones. Solve the upper and
 * lower leg toward them after AnimationMixer, retaining rigid hoof weights. */
export function createFarmLegSolver(object: Object3D) {
  object.updateMatrixWorld(true);
  const legs = ["FrontL", "BackR", "FrontR", "BackL"].flatMap(key => {
    const prefix = key.slice(0, -1), side = key.slice(-1);
    const upper = object.getObjectByName(`${prefix}UpLeg${side}`) as Bone;
    const lower = object.getObjectByName(`${prefix}LowLeg${side}`) as Bone;
    const foot = object.getObjectByName(`${prefix}Foot${side}`) as Bone;
    if (!upper || !lower || !foot) return [];
    const h = upper.getWorldPosition(new Vector3()), k = lower.getWorldPosition(new Vector3());
    const end = foot.getWorldPosition(new Vector3());
    const axis = end.clone().sub(h).normalize();
    const pole = k.clone().sub(h).addScaledVector(axis, -k.clone().sub(h).dot(axis)).normalize();
    pole.applyQuaternion(object.getWorldQuaternion(new Quaternion()).invert());
    return [{ upper, lower, foot, endpoint: lower.worldToLocal(end), pole, rest: foot.position.clone(), planted: null as Vector3 | null }];
  });
  const h = new Vector3(), k = new Vector3(), end = new Vector3(), target = new Vector3(), axis = new Vector3(), pole = new Vector3(), joint = new Vector3();
  const from = new Vector3(), to = new Vector3(), delta = new Quaternion(), world = new Quaternion(), parent = new Quaternion();
  const aim = (bone: Bone, oldPoint: Vector3, newPoint: Vector3, origin: Vector3) => {
    from.subVectors(oldPoint, origin).normalize();to.subVectors(newPoint, origin).normalize();
    delta.setFromUnitVectors(from, to);
    bone.getWorldQuaternion(world);bone.parent!.getWorldQuaternion(parent).invert();
    bone.quaternion.copy(parent.multiply(delta.multiply(world)));
    bone.updateMatrixWorld(true);
  };
  return {
    /** Four-beat walking only for assets with no authored walk clip. */
    gait(phase: number, stride: number, weight: number) {
      legs.forEach((leg, index) => {
        const t = (phase + [0, 0.5, 0.25, 0.75][index]) % 1;
        const swing = Math.max(0, (t - 0.62) / 0.38);
        const z = t < 0.62 ? 0.5 - t / 0.62 : -0.5 + swing * swing * (3 - 2 * swing);
        leg.foot.position.copy(leg.rest);
        leg.foot.position.z += z * stride * weight;
        leg.foot.position.y += Math.sin(swing * Math.PI) * stride * 0.24 * weight;
      });
    },
    update(groundOffset?: (point: Vector3) => number, grounded = false) {
      object.updateMatrixWorld(true);
      for (const leg of legs) {
        leg.upper.getWorldPosition(h);leg.lower.getWorldPosition(k);
        end.copy(leg.endpoint);leg.lower.localToWorld(end);leg.foot.getWorldPosition(target);
        if (groundOffset) target.y += groundOffset(target);
        const a = h.distanceTo(k), b = k.distanceTo(end);
        // During stance keep the hoof at its contact point. Authored targets
        // differ slightly between legs; a single body velocity cannot cancel
        // every one exactly. Release as soon as the foot begins its swing.
        if (grounded && leg.foot.position.y < leg.rest.y + 0.035) {
          if (!leg.planted || leg.planted.distanceTo(target) > (a + b) * 0.45) leg.planted = target.clone();
          target.copy(leg.planted);
        } else leg.planted = null;
        const distance = Math.max(Math.abs(a - b) + 1e-5, Math.min(h.distanceTo(target), (a + b) * 0.999));
        axis.subVectors(target, h).normalize();
        pole.copy(leg.pole).applyQuaternion(object.getWorldQuaternion(world));
        pole.addScaledVector(axis, -pole.dot(axis)).normalize();
        const along = (a * a - b * b + distance * distance) / (2 * distance);
        joint.copy(h).addScaledVector(axis, along).addScaledVector(pole, Math.sqrt(Math.max(0, a * a - along * along)));
        aim(leg.upper, k, joint, h);
        leg.lower.getWorldPosition(k);end.copy(leg.endpoint);leg.lower.localToWorld(end);
        target.copy(h).addScaledVector(axis, distance);
        aim(leg.lower, end, target, k);
      }
    }
  };
}
