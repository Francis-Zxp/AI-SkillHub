// Memory helpers for the sky world. Geometry built for one world is uploaded
// once and never read again on the CPU, so its arrays can go as soon as the
// GPU has them. Never use this on cached model geometry (another world may
// upload it again), on anything raycast (picking reads positions) or on an
// attribute that is updated later (instance colours, flock matrices).
import * as THREE from "three";

function dropArray(this: { array: unknown }) {
  this.array = null;
}

/** Bounds are computed first: three.js reads positions for culling once. */
export function releaseAfterUpload(geometry: THREE.BufferGeometry) {
  if (!geometry.boundingSphere) geometry.computeBoundingSphere();
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  for (const name in geometry.attributes) {
    const attribute = geometry.attributes[name] as THREE.BufferAttribute;
    if (attribute.isBufferAttribute) attribute.onUpload(dropArray);
  }
  geometry.index?.onUpload(dropArray);
}

/** An instanced mesh whose matrices never change after it is built. */
export function releaseInstanceMatrix(mesh: THREE.InstancedMesh) {
  if (!mesh.boundingSphere) mesh.computeBoundingSphere();
  mesh.instanceMatrix.onUpload(dropArray);
}
