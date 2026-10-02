import * as THREE from "three";

/** One ribbon from the pond across the lip and into the falling sheet.
 * A quarter-circle makes the horizontal and vertical tangents continuous. */
export function spillwayGeometry(start: THREE.Vector3, lip: THREE.Vector3, width: number, drop: number) {
  const outward = lip.clone().sub(start).setY(0).normalize();
  const side = new THREE.Vector3(outward.z, 0, -outward.x);
  const bend = Math.min(width * 0.65, drop * 0.08);
  const rows: THREE.Vector3[] = [];
  for (let i = 0; i <= 3; i++) rows.push(start.clone().lerp(lip, i / 3));
  for (let i = 1; i <= 12; i++) {
    const angle = i / 12 * Math.PI / 2;
    rows.push(lip.clone().addScaledVector(outward, bend * Math.sin(angle)).add(new THREE.Vector3(0, -bend * (1 - Math.cos(angle)), 0)));
  }
  for (let i = 1; i <= 24; i++) {
    const t = i / 24;
    rows.push(lip.clone().addScaledVector(outward, bend + t * t * Math.min(0.3, drop * 0.02)).add(new THREE.Vector3(0, -bend - (drop - bend) * t, 0)));
  }
  const distances = [0];
  for (let i = 1; i < rows.length; i++) distances.push(distances[i - 1] + rows[i].distanceTo(rows[i - 1]));
  const positions: number[] = [], uv: number[] = [], indices: number[] = [];
  rows.forEach((row, index) => {
    for (const edge of [-1, 1]) {
      positions.push(row.x + side.x * width * edge / 2, row.y, row.z + side.z * width * edge / 2);
      uv.push((edge + 1) / 2, 1 - distances[index] / distances[distances.length - 1]);
    }
    if (index) { const a = (index - 1) * 2; indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  geometry.setIndex(indices);geometry.computeVertexNormals();
  return geometry;
}
