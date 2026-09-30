import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { SkyIsland } from "./skyIslandModel";

// Original procedural artwork. No remote models, textures or runtime asset requests.
export const skyTime = { value: 0 };
const UP = new THREE.Vector3(0, 1, 0);
export function seededRandom(seed: number) {
  let state = seed >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
}

export type IslandArtwork = {
  group: THREE.Group;
  animate: (time: number, hovered: boolean) => void;
  dispose: () => void;
};

export function makeIslandArtwork(island: SkyIsland): IslandArtwork {
  const random = seededRandom(island.seed);
  const group = new THREE.Group();
  const materials = new Map<string, THREE.MeshStandardMaterial>();
  const batches = new Map<THREE.Material, THREE.BufferGeometry[]>();
  const material = (color: string, roughness = .88) => {
    const key = color + roughness;
    if (!materials.has(key)) materials.set(key, new THREE.MeshStandardMaterial({ color, roughness, flatShading: false }));
    return materials.get(key)!;
  };
  const add = (geometry: THREE.BufferGeometry, color: string, position: number[], scale = [1, 1, 1], rotation = [0, 0, 0]) => {
    const transform = new THREE.Object3D();
    transform.position.set(position[0], position[1], position[2]);
    transform.scale.set(scale[0], scale[1], scale[2]);
    transform.rotation.set(rotation[0], rotation[1], rotation[2]);
    transform.updateMatrix();
    geometry.applyMatrix4(transform.matrix);
    // Consistent attributes allow static details to share one draw call per palette colour.
    geometry.deleteAttribute("uv");
    const mat = material(color);
    const list = batches.get(mat) ?? [];
    list.push(geometry.index ? geometry.toNonIndexed() : geometry);
    if (geometry.index) geometry.dispose();
    batches.set(mat, list);
  };
  const box = (color: string, p: number[], s: number[], r = [0, 0, 0]) => add(new THREE.BoxGeometry(1, 1, 1), color, p, s, r);
  const orb = (color: string, p: number[], s: number[], detail = 1) => add(new THREE.IcosahedronGeometry(1, detail), color, p, s);
  const cylinder = (color: string, p: number[], radius: number, height: number, top = radius, r = [0, 0, 0], segments = 12) => add(new THREE.CylinderGeometry(top, radius, height, segments), color, p, [1, 1, 1], r);
  const branch = (a: number[], b: number[], radius: number, color = "#82664e") => {
    const start = new THREE.Vector3(...a as [number, number, number]);
    const end = new THREE.Vector3(...b as [number, number, number]);
    const direction = end.sub(start);
    const geometry = new THREE.CylinderGeometry(radius * .55, radius, direction.length(), 7);
    geometry.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(UP, direction.normalize()));
    add(geometry, color, a.map((n, i) => (n + b[i]) / 2));
  };

  const phase = (island.seed % 100) / 100 * Math.PI * 2;
  const boundary = (angle: number) => 1 + .09 * Math.sin(angle * 3 + phase) + .05 * Math.sin(angle * 7 - phase);
  const height = (x: number, z: number) => .15 + .13 * Math.sin(x * 1.8 + phase) * Math.sin(z * 1.7) + .1 * Math.cos(z * 1.9);
  const rings = 8, segments = 64;
  const vertices: number[] = [], colors: number[] = [], faces: number[] = [];
  for (let ring = 0; ring <= rings; ring++) for (let j = 0; j <= segments; j++) {
    const a = j / segments * Math.PI * 2, radius = ring / rings * boundary(a);
    const x = Math.cos(a) * radius * 2.45, z = Math.sin(a) * radius * 1.85;
    vertices.push(x, height(x, z), z);
    const color = new THREE.Color().setHSL(.225 + random() * .035, .4 + random() * .12, .37 + random() * .08, THREE.SRGBColorSpace);
    colors.push(color.r, color.g, color.b);
    if (ring < rings && j < segments) {
      const k = ring * (segments + 1) + j;
      faces.push(k, k + 1, k + segments + 1, k + 1, k + segments + 2, k + segments + 1);
    }
  }
  const terrain = new THREE.BufferGeometry();
  terrain.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
  terrain.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  terrain.setIndex(faces); terrain.computeVertexNormals();
  const grassGround = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 });
  const terrainMesh = new THREE.Mesh(terrain, grassGround); terrainMesh.receiveShadow = true; group.add(terrainMesh);

  // A closed layered cliff, rather than repeated perfect cones.
  const cliffPositions: number[] = [], cliffColors: number[] = [];
  const cliffRings = [1, 1.04, .84, .51, .08];
  const cliffY = [.12, -.28, -1.05, -1.95, -2.8];
  const rockColors = ["#b0a184", "#a18e78", "#867e75", "#6a757d"];
  const rockPoint = (level: number, j: number) => {
    const a = (j % 32) / 32 * Math.PI * 2;
    const rad = boundary(a) * cliffRings[level];
    return [Math.cos(a) * rad * 2.45 + (level > 2 ? .2 : 0), cliffY[level] + (level === 0 ? height(Math.cos(a) * rad * 2.45, Math.sin(a) * rad * 1.85) - .12 : .11 * Math.sin(j * 2 + phase)), Math.sin(a) * rad * 1.85];
  };
  for (let ring = 0; ring < 4; ring++) for (let j = 0; j < 32; j++) {
    for (const triangle of [[cliffPoint(ring, j), cliffPoint(ring + 1, j), cliffPoint(ring, j + 1)], [cliffPoint(ring, j + 1), cliffPoint(ring + 1, j), cliffPoint(ring + 1, j + 1)]]) {
      const c = new THREE.Color(rockColors[ring]).multiplyScalar(.88 + random() * .23);
      triangle.reverse().forEach(point => { cliffPositions.push(...point); cliffColors.push(c.r, c.g, c.b); });
    }
  }
  function cliffPoint(level: number, j: number) { return rockPoint(level, j); }
  const cliff = new THREE.BufferGeometry();
  cliff.setAttribute("position", new THREE.Float32BufferAttribute(cliffPositions, 3));
  cliff.setAttribute("color", new THREE.Float32BufferAttribute(cliffColors, 3)); cliff.computeVertexNormals();
  const cliffMesh = new THREE.Mesh(cliff, grassGround); cliffMesh.castShadow = true; cliffMesh.receiveShadow = true; group.add(cliffMesh);

  const tree = (x: number, z: number, size: number, kind = 0) => {
    const y = height(x, z);
    branch([x, y, z], [x + .08 * size, y + size * 1.05, z], size * .09);
    if (kind === 1) {
      for (let i = 0; i < 3; i++) add(new THREE.ConeGeometry((.47 - i * .1) * size, size * .76, 9), ["#3e7669", "#518568", "#639470"][i], [x, y + size * (.65 + i * .36), z]);
    } else {
      const foliage = ["#6d9c5d", "#8eae64", "#a4bc72", "#7da462"];
      for (let i = 0; i < 8; i++) {
        const a = i * 2.4, r = i ? .42 : 0;
        const tx = x + Math.cos(a) * r * size, tz = z + Math.sin(a) * r * size;
        const ty = y + (1.13 + random() * .35) * size;
        if (i < 4) branch([x, y + size * .55, z], [tx, ty, tz], .04 * size);
        orb(foliage[i % 4], [tx, ty, tz], [.52 * size, .39 * size, .46 * size], 2);
      }
    }
  };
  const doorAndWindows = (x: number, y: number, z: number, width: number) => {
    box("#674e40", [x, y + .27, z], [.22, .49, .028]);
    orb("#d6c69b", [x + .065, y + .24, z + .024], [.018, .018, .018]);
    for (const side of [-1, 1]) {
      box("#73878b", [x + side * width * .32, y + .46, z], [.24, .27, .04]);
      box("#f6dca0", [x + side * width * .32, y + .46, z + .027], [.18, .21, .02]);
      box("#eee2c4", [x + side * width * .32, y + .46, z + .04], [.018, .23, .018]);
      box("#eee2c4", [x + side * width * .32, y + .46, z + .04], [.22, .018, .018]);
      box("#82664e", [x + side * width * .32, y + .28, z + .06], [.31, .07, .11]);
      orb("#789659", [x + side * width * .32, y + .33, z + .06], [.18, .07, .08]);
    }
  };
  const cottage = (x: number, z: number, roof = "#ac7056", scale = 1) => {
    const y = height(x, z);
    box("#eee0b9", [x, y + .42 * scale, z], [1.15 * scale, .84 * scale, .83 * scale]);
    const roofVertices = [[-.67, 0, .53], [.67, 0, .53], [0, .45, .53], [-.67, 0, -.53], [.67, 0, -.53], [0, .45, -.53]];
    const gable = new THREE.BufferGeometry();
    gable.setAttribute("position", new THREE.Float32BufferAttribute([0, 1, 2, 3, 5, 4, 0, 2, 3, 2, 5, 3, 1, 4, 2, 2, 4, 5, 0, 3, 1, 1, 3, 4].flatMap(i => roofVertices[i]), 3));
    gable.computeVertexNormals(); add(gable, roof, [x, y + .82 * scale, z], [scale, scale, scale]);
    // Overlapping roof courses, visible even when viewed at an angle.
    for (const side of [-1, 1]) for (let row = 0; row < 5; row++) {
      box(row % 2 ? roof : "#bc876c", [x + side * (.07 + row * .13) * scale, y + (1.25 - row * .087) * scale, z], [.17 * scale, .035 * scale, 1.09 * scale], [0, 0, -side * .59]);
    }
    box("#c6b28e", [x + .36 * scale, y + 1.16 * scale, z - .22 * scale], [.17 * scale, .53 * scale, .19 * scale]);
    box("#998b75", [x + .36 * scale, y + 1.44 * scale, z - .22 * scale], [.23 * scale, .07 * scale, .24 * scale]);
    doorAndWindows(x, y, z + .43 * scale, 1.15 * scale);
    box("#d6c7a1", [x, y + .015, z + .63], [.47, .06, .28]);
  };

  const biome = island.biome;
  const rotor = new THREE.Group();
  if (biome === 0) {
    const y = height(.1, -.25);
    cylinder("#e7dabb", [.1, y + .75, -.25], .43, 1.5, .27);
    add(new THREE.ConeGeometry(.52, .59, 16), "#718898", [.1, y + 1.76, -.25]);
    rotor.position.set(.1, y + 1.18, .22);
    for (let i = 0; i < 4; i++) {
      const blade = new THREE.Group(); blade.rotation.z = i * Math.PI / 2 + .25;
      const spar = new THREE.Mesh(new THREE.BoxGeometry(.055, 1.1, .055), material("#88785d")); spar.position.y = .45; blade.add(spar);
      const sail = new THREE.Mesh(new THREE.BoxGeometry(.19, .61, .035), material("#f6edce")); sail.position.set(.09, .66, 0); blade.add(sail);
      rotor.add(blade);
    }
    group.add(rotor);
    cottage(-1.02, -.2, "#829695", .55);
    tree(1.18, -.7, .8, 1); tree(1.5, -.1, .65, 1);
  } else if (biome === 1) {
    cottage(-.25, -.15); tree(-1.32, -.55, 1.05); tree(1.3, -.75, .77);
    for (let i = 0; i < 5; i++) box(["#8c9c98", "#b78a6d", "#d5bc87"][i % 3], [.8, height(.8, .35) + .07 + i * .07, .35], [.28, .06, .2], [0, i % 2 * .2, 0]);
  } else if (biome === 2) {
    const y = height(0, -.25);
    cylinder("#eadfc4", [0, y + .38, -.25], .62, .76);
    add(new THREE.SphereGeometry(.66, 24, 16, 0, Math.PI * 2, 0, Math.PI / 2), "#6c899d", [0, y + .76, -.25]);
    box("#425f77", [.18, y + 1.05, .07], [.14, .54, .1], [-.55, 0, 0]);
    doorAndWindows(0, y, .39, 1.2);
    branch([.97, height(.97, .4), .4], [.97, y + .6, .4], .035, "#9d8663");
    cylinder("#dab782", [.97, y + .66, .4], .1, .5, .1, [0, 0, -.8]);
    tree(-1.3, -.5, .9, 1); tree(1.25, -.8, .6, 1);
    for (let i = 0; i < 3; i++) orb("#c2b9a0", [1.2 + i * .18, height(1.2, -.3), -.35], [.2, .15, .18]);
  } else if (biome === 3) {
    cottage(-.45, -.4, "#799194", .88); tree(1.15, -.7, .85);
    for (let i = 0; i < 3; i++) {
      const x = -.45 + i * .59, z = .65, y = height(x, z);
      branch([x - .14, y, z], [x, y + .55, z], .025); branch([x + .14, y, z], [x, y + .55, z], .025);
      box("#f6e8c7", [x, y + .38, z + .02], [.34, .29, .055]);
      orb(["#d2917e", "#98b5a1", "#8ea2b3"][i], [x, y + .38, z + .058], [.11, .09, .007]);
    }
  } else if (biome === 4) {
    tree(-1.1, -.45, 1.1); tree(1.37, -.6, .7);
    // A small arched footbridge over the pond.
    for (let i = 0; i < 10; i++) {
      const z = -.65 + i * .15, y = .34 + .18 * Math.sin(i / 9 * Math.PI);
      box("#c6aa7b", [.15, y, z], [.6, .07, .145]);
      if (i % 3 === 0) for (const side of [-1, 1]) cylinder("#9e8463", [.15 + side * .32, y + .18, z], .028, .37);
    }
    for (const side of [-1, 1]) branch([.15 + side * .32, .55, -.65], [.15 + side * .32, .55, .7], .023, "#9e8463");
  } else {
    tree(-.42, -.3, 1.62); tree(1.3, -.65, .57);
    for (const side of [-1, 1]) branch([.05 + side * .25, .88, .24], [.05 + side * .25, 1.77, .24], .009, "#eee0bd");
    box("#ab8262", [.05, .86, .24], [.6, .05, .2]);
    orb("#d2c4a5", [1.07, height(1.07, .5), .5], [.25, .12, .19]);
  }

  // Pond and waterfall share the same palette and animation clock.
  const hasPond = biome === 4 || biome === 5;
  const waterMaterial = new THREE.ShaderMaterial({
    uniforms: { time: skyTime, tint: { value: new THREE.Color("#5cafb6") }, fall: { value: 0 } },
    vertexShader: `varying vec2 vUv; void main(){vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}`,
    fragmentShader: `uniform float time; uniform vec3 tint; uniform float fall; varying vec2 vUv; void main(){float wave=sin(vUv.x*48.+sin(vUv.y*22.+time)*2.+time*.8); float lines=smoothstep(.92,1.,sin(vUv.y*(fall>.5?55.:80.)-time*(fall>.5?5.:.6)+wave)); vec3 col=mix(tint,vec3(.87,.98,.94),lines*.48); gl_FragColor=vec4(col,fall>.5?.68*smoothstep(0.,.25,vUv.y):.94);}`,
    transparent: true, side: THREE.DoubleSide, depthWrite: false
  });
  if (hasPond) {
    const pond = new THREE.Mesh(new THREE.CircleGeometry(.85, 48), waterMaterial);
    pond.rotation.x = -Math.PI / 2; pond.scale.set(1, 1.1, 1); pond.position.set(.15, .32, .15); group.add(pond);
    // Rim stones make the water read as a contained pool rather than a floating disc.
    for (let j = 0; j < 18; j++) {
      const a = j / 18 * Math.PI * 2;
      orb("#c7c5a7", [.15 + Math.cos(a) * .87, .29, .15 + Math.sin(a) * .95], [.15, .1, .12]);
    }
    const fallsMaterial = waterMaterial.clone(); fallsMaterial.uniforms.time = skyTime; fallsMaterial.uniforms.fall.value = 1;
    const fall = new THREE.Mesh(new THREE.PlaneGeometry(.23, 2.9, 1, 12), fallsMaterial);
    fall.position.set(.15, -1.05, 1.69); fall.rotation.x = -.06; group.add(fall);
    const stream = new THREE.Mesh(new THREE.PlaneGeometry(.28, .75), waterMaterial); stream.rotation.x = -Math.PI / 2; stream.position.set(.15, .3, 1.32); group.add(stream);
  }

  // Little paths, rock outcrops and hanging greenery give every silhouette a lived-in edge.
  for (let j = 0; j < 10; j++) {
    const z = .55 + j * .11, x = -.35 + Math.sin(j * .35) * .17;
    if (!hasPond) orb("#d7c7a0", [x, height(x, z) + .025, z], [.16, .028, .08]);
  }
  for (let j = 0; j < 16; j++) {
    const a = j / 16 * Math.PI * 2 + phase, x = Math.cos(a) * 2.3 * boundary(a), z = Math.sin(a) * 1.72 * boundary(a);
    orb(j % 3 ? "#719860" : "#97aa6c", [x, height(x, z) - .08, z], [.2 + random() * .13, .15, .22]);
    if (j % 3 === 0) {
      for (let k = 1; k < 6; k++) orb("#688569", [x * (1 - k * .035), -.16 - k * .17, z], [.09, .15, .09]);
    }
  }

  // Meadow blades are instanced; only their tips move, with one common wind direction.
  const grassGeometry = new THREE.BufferGeometry();
  grassGeometry.setAttribute("position", new THREE.Float32BufferAttribute([-.018, 0, 0, .018, 0, 0, 0, .16, .02], 3));
  grassGeometry.computeVertexNormals();
  const grassMat = new THREE.MeshStandardMaterial({ color: "#96b367", side: THREE.DoubleSide, roughness: 1 });
  grassMat.onBeforeCompile = shader => {
    shader.uniforms.skyTime = skyTime;
    shader.vertexShader = "uniform float skyTime;\n" + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace("#include <begin_vertex>", `#include <begin_vertex>\nfloat phase=instanceMatrix[3].x*2.+instanceMatrix[3].z; float sway=sin(skyTime*1.4+phase)*position.y*position.y*1.8; transformed.x+=sway*instanceMatrix[0].x; transformed.z+=sway*instanceMatrix[2].x;`);
  };
  const bladePositions: number[][] = [];
  for (let i = 0; i < 600; i++) {
    const x = (random() * 2 - 1) * 2.25, z = (random() * 2 - 1) * 1.65;
    if ((x / 2.25) ** 2 + (z / 1.65) ** 2 > .91) continue;
    if (hasPond ? ((x - .15) ** 2 + (z - .15) ** 2 < 1.02 || (Math.abs(x - .15) < .25 && z > 0)) : (Math.abs(x) < .76 && z < .7)) continue;
    if (!hasPond && Math.abs(x + .28) < .18 && z > .6) continue;
    bladePositions.push([x, height(x, z) + .02, z]);
  }
  const blades = new THREE.InstancedMesh(grassGeometry, grassMat, bladePositions.length);
  const dummy = new THREE.Object3D();
  bladePositions.forEach((p, i) => {
    dummy.position.set(p[0], p[1], p[2]); dummy.rotation.y = random() * Math.PI; dummy.scale.setScalar(.6 + random() * .9); dummy.updateMatrix(); blades.setMatrixAt(i, dummy.matrix);
    if (i % 7 === 0) {
      const color = ["#efde9b", "#e7b4a3", "#a4bfd4", "#f1e9d2"][i % 4];
      cylinder("#6d8e59", [p[0], p[1] + .085, p[2]], .008, .17, .008, [0, 0, .1], 4);
      for (let petal = 0; petal < 5; petal++) {
        const a = petal / 5 * Math.PI * 2;
        orb(color, [p[0] + Math.cos(a) * .032, p[1] + .18, p[2] + Math.sin(a) * .032], [.029, .015, .025], 0);
      }
      orb("#d5ae5a", [p[0], p[1] + .19, p[2]], [.02, .014, .02], 0);
    }
  });
  group.add(blades);

  // Original tiny inhabitants: rabbit / sheep / a reader. Paths avoid the pond and buildings.
  const inhabitant = new THREE.Group();
  const animal = biome % 2 === 0;
  const part = (color: string, p: number[], s: number[]) => {
    const mesh = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 2), material(color));
    mesh.position.set(p[0], p[1], p[2]); mesh.scale.set(s[0], s[1], s[2]); mesh.castShadow = true; inhabitant.add(mesh); return mesh;
  };
  const bodyColor = biome === 0 ? "#eee7d2" : "#f6eddb";
  const wavingArm = new THREE.Group();
  if (animal) {
    part(bodyColor, [0, .14, 0], [.17, .12, .11]);
    part(bodyColor, [.14, .22, 0], [.09, .095, .08]);
    part("#55505a", [.208, .24, .037], [.013, .015, .01]);
    part("#55505a", [.208, .24, -.037], [.013, .015, .01]);
    for (const side of [-1, 1]) part(bodyColor, [.11, .34, side * .045], [.027, biome === 0 ? .05 : .13, .023]);
    for (const x of [-.1, .1]) for (const z of [-.065, .065]) part("#dbd6bd", [x, .045, z], [.025, .06, .027]);
    part(bodyColor, [-.18, .18, 0], [.045, .045, .045]);
  } else {
    part("#6e8fa0", [0, .21, 0], [.087, .13, .07]);
    part("#e4c3a0", [0, .39, 0], [.078, .085, .075]);
    part("#675b4f", [0, .435, -.018], [.085, .047, .073]);
    for (const side of [-1, 1]) part("#625f58", [side * .043, .073, 0], [.027, .075, .028]);
    wavingArm.position.set(-.08, .29, 0);
    const arm = new THREE.Mesh(new THREE.CapsuleGeometry(.024, .13, 3, 6), material("#e4c3a0")); arm.position.y = -.06; wavingArm.add(arm); inhabitant.add(wavingArm);
    part("#e4c3a0", [.1, .22, 0], [.023, .085, .026]);
  }
  group.add(inhabitant);

  for (const [mat, pieces] of batches) {
    const geometry = mergeGeometries(pieces);
    pieces.forEach(piece => piece.dispose());
    if (geometry) { const mesh = new THREE.Mesh(geometry, mat); mesh.castShadow = true; mesh.receiveShadow = true; group.add(mesh); }
  }
  return {
    group,
    animate(time, hovered) {
      rotor.rotation.z = time * .24;
      const pace = hovered ? 0 : time * .22 + phase;
      const x = hasPond ? 1.22 + Math.sin(pace) * .12 : .85 + Math.sin(pace) * .26;
      const z = .7 + Math.cos(pace) * .23;
      inhabitant.position.set(x, height(x, z) + (animal && !hovered ? Math.max(0, Math.sin(time * 3 + phase)) * .055 : 0), z);
      inhabitant.rotation.y = hovered ? -.4 : -Math.sin(pace) * .7;
      wavingArm.rotation.z = hovered ? -2.3 + Math.sin(time * 5) * .22 : Math.sin(time * 2) * .12;
    },
    dispose() {
      const geometries = new Set<THREE.BufferGeometry>(), mats = new Set<THREE.Material>();
      group.traverse(object => { if (object instanceof THREE.Mesh) { geometries.add(object.geometry); (Array.isArray(object.material) ? object.material : [object.material]).forEach(mat => mats.add(mat)); } });
      geometries.forEach(g => g.dispose()); mats.forEach(m => m.dispose());
      // Water may not be attached for the meadow variants.
      waterMaterial.dispose(); materials.forEach(m => m.dispose());
    }
  };
}
