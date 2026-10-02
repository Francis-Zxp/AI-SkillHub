// Birds, villagers and animals. Birds are the CC-BY gull mesh, instanced and
// flat white, with the wings animated in the vertex shader in bursts of
// flapping and long glides; flocks bank into their turns. Villagers walk a
// worn path and pause at its ends. Animals wander their patch of grass:
// using authored walk targets or a four-beat gait, grazing between.
// Feet follow the same height function as the terrain mesh.
import * as THREE from "three";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import type { GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { ModelTemplate } from "./assets";
import { SHARED_UNIFORMS, toonGradient } from "./materials";
import { seededRandom } from "./noise";
import type { IslandShape } from "./terrain";
import { createFarmLegSolver } from "./animalRig";

// Measured in the sky lab: head toward +X, wingspan along Z, wings raised.
const GULL_SHOULDER = 6;
const GULL_SPAN = 45;

function gullMaterial() {
  const material = new THREE.MeshToonMaterial({ gradientMap: toonGradient(), color: "#f7f8fa", side: THREE.DoubleSide });
  material.onBeforeCompile = shader => {
    shader.uniforms.uTime = SHARED_UNIFORMS.uTime;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>
        uniform float uTime;
        attribute float aSeed;`)
      .replace("#include <begin_vertex>", `#include <begin_vertex>
        float side = sign(transformed.z);
        float reach = abs(transformed.z);
        if (reach > ${GULL_SHOULDER.toFixed(1)}) {
          float span = smoothstep(${GULL_SHOULDER.toFixed(1)}, ${GULL_SPAN.toFixed(1)}, reach);
          // Bursts of flapping between long glides, offset per bird.
          float burst = smoothstep(-0.15, 0.4, sin(uTime * 0.38 + aSeed * 6.2831));
          float stroke = sin(uTime * 9.0 + aSeed * 17.0);
          float glide = 0.62 + 0.04 * sin(uTime * 0.9 + aSeed * 3.0);
          float lower = mix(glide, 0.48 + 0.6 * stroke, burst) * (0.65 + 0.35 * span);
          float angle = lower * side;
          vec2 pivot = vec2(2.0, ${GULL_SHOULDER.toFixed(1)} * side);
          vec2 local = vec2(transformed.y, transformed.z) - pivot;
          float c = cos(angle), s = sin(angle);
          vec2 turned = vec2(local.x * c - local.y * s, local.x * s + local.y * c);
          transformed.y = turned.x + pivot.x;
          transformed.z = turned.y + pivot.y;
        }`);
  };
  material.customProgramCacheKey = () => "sky-gull";
  return material;
}

export type Flock = { mesh: THREE.InstancedMesh; update: (time: number) => void; dispose: () => void };

export function createFlocks(template: ModelTemplate, bounds: THREE.Box3, count: number, seed: number, wingspan: number): Flock {
  const part = template.parts[0];
  const material = gullMaterial();
  const geometry = part.geometry.clone();
  const seeds = new Float32Array(count);
  const random = seededRandom(seed);
  for (let index = 0; index < count; index++) seeds[index] = random();
  geometry.setAttribute("aSeed", new THREE.InstancedBufferAttribute(seeds, 1));
  const mesh = new THREE.InstancedMesh(geometry, material, count);
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  const size = bounds.getSize(new THREE.Vector3());
  const center = bounds.getCenter(new THREE.Vector3());
  // A solitary bird and uneven groups, stable for a given scene seed.
  const groupSizes = [1];
  let remaining = count - 1;
  while (remaining > 0) {
    const group = Math.min(remaining, 2 + Math.floor(random() * 4));
    groupSizes.push(group);remaining -= group;
  }
  const flockCount = groupSizes.length;
  const routes = Array.from({ length: flockCount }, (_, flock) => {
    const points: THREE.Vector3[] = [];
    const radiusX = size.x * (0.32 + random() * 0.22), radiusZ = size.z * (0.28 + random() * 0.22);
    const altitude = bounds.max.y + 3 + flock * 2.5 + random() * 2;
    const offset = new THREE.Vector3((random() - 0.5) * size.x * 0.3, 0, (random() - 0.5) * size.z * 0.3);
    const direction = flock % 2 === 0 ? 1 : -1;
    for (let index = 0; index < 7; index++) {
      const angle = (index / 7) * Math.PI * 2 * direction + random() * 0.4;
      const wobble = 0.82 + random() * 0.36;
      points.push(new THREE.Vector3(
        center.x + offset.x + Math.cos(angle) * radiusX * wobble,
        altitude + Math.sin(angle * 2) * 1.2,
        center.z + offset.z + Math.sin(angle) * radiusZ * wobble
      ));
    }
    return { curve: new THREE.CatmullRomCurve3(points, true, "centripetal"), speed: 0.012 + random() * 0.006, start: random() };
  });
  const birds = groupSizes.flatMap((size, flock) => Array.from({ length: size }, (_, index) => ({
    flock,
    lag: index * (0.009 + random() * 0.005),
    offset: new THREE.Vector3((random() - 0.5) * 2.2, (random() - 0.5) * 0.8, (random() - 0.5) * 2.2)
  })));
  mesh.userData.flockSizes = groupSizes;
  const scale = wingspan / (GULL_SPAN * 2);
  const position = new THREE.Vector3(), ahead = new THREE.Vector3(), further = new THREE.Vector3();
  const forward = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0), side = new THREE.Vector3();
  const basis = new THREE.Matrix4(), roll = new THREE.Matrix4(), matrix = new THREE.Matrix4();
  const update = (time: number) => {
    birds.forEach((bird, index) => {
      const route = routes[bird.flock];
      const t = (((route.start + time * route.speed - bird.lag) % 1) + 1) % 1;
      route.curve.getPointAt(t, position);
      route.curve.getPointAt((t + 0.004) % 1, ahead);
      route.curve.getPointAt((t + 0.008) % 1, further);
      forward.subVectors(ahead, position).normalize();
      const turn = new THREE.Vector3().subVectors(further, ahead).normalize().cross(forward).y;
      // Model +X is the head; keep the basis right-handed: Z = X × up, Y = Z × X.
      side.crossVectors(forward, up).normalize();
      basis.makeBasis(forward, new THREE.Vector3().crossVectors(side, forward), side);
      roll.makeRotationX(THREE.MathUtils.clamp(turn * 18, -0.55, 0.55));
      position.add(bird.offset).add(new THREE.Vector3(0, Math.sin(time * 0.7 + index) * 0.15, 0));
      matrix.copy(basis).multiply(roll).scale(new THREE.Vector3(scale, scale, scale)).setPosition(position);
      mesh.setMatrixAt(index, matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
  };
  update(0);
  return {
    mesh,
    update,
    dispose() {
      geometry.dispose();
      material.dispose();
    }
  };
}

export type Walker = { object: THREE.Object3D; update: (delta: number) => void; dispose: () => void };

/** A villager walking `route` (island-local XZ points) on `shape`. */
export function createWalker(gltf: GLTF, shape: IslandShape, origin: THREE.Vector3, route: Array<[number, number]>, height: number, seed: number): Walker | null {
  if (route.length < 2) return null;
  const object = cloneSkinned(gltf.scene);
  const box = new THREE.Box3().setFromObject(object);
  const scale = height / Math.max(0.01, box.max.y - box.min.y);
  object.scale.setScalar(scale);
  object.traverse(child => {
    const mesh = child as THREE.Mesh;
    if (mesh.isMesh) {
      mesh.castShadow = true;
      mesh.frustumCulled = false;
    }
  });
  const mixer = new THREE.AnimationMixer(object);
  const clip = (name: string) => gltf.animations.find(item => item.name.endsWith(`|${name}`));
  const walk = clip("Walk") ? mixer.clipAction(clip("Walk")!) : null;
  const idle = clip("Idle_Neutral") ?? clip("Idle");
  const idleAction = idle ? mixer.clipAction(idle) : null;
  const wave = clip("Wave") ? mixer.clipAction(clip("Wave")!) : null;
  const random = seededRandom(seed);
  walk?.play();
  let segment = 0, progress = random(), pause = 0, yaw = 0, current: THREE.AnimationAction | null = walk;
  const speed = height * 0.62;
  const switchTo = (next: THREE.AnimationAction | null) => {
    if (!next || next === current) return;
    next.reset().play();
    current?.crossFadeTo(next, 0.35, false);
    current = next;
  };
  const place = (x: number, z: number) => {
    object.position.set(origin.x + x, origin.y + shape.heightAt(x, z), origin.z + z);
  };
  const update = (delta: number) => {
    mixer.update(delta);
    if (pause > 0) {
      pause -= delta;
      if (pause <= 0) switchTo(walk);
      return;
    }
    const [ax, az] = route[segment], [bx, bz] = route[(segment + 1) % route.length];
    const length = Math.hypot(bx - ax, bz - az) || 1;
    progress += (speed * delta) / length;
    if (progress >= 1) {
      progress = 0;
      segment = (segment + 1) % route.length;
      // Linger at the route ends: look around, sometimes wave.
      if (segment === route.length - 1 || segment === 0 || random() < 0.25) {
        pause = 2.5 + random() * 4;
        switchTo(random() < 0.3 && wave ? wave : idleAction);
      }
      return;
    }
    const x = ax + (bx - ax) * progress, z = az + (bz - az) * progress;
    place(x, z);
    const target = Math.atan2(bx - ax, bz - az);
    const difference = Math.atan2(Math.sin(target - yaw), Math.cos(target - yaw));
    yaw += difference * Math.min(1, delta * 4);
    object.rotation.y = yaw;
  };
  place(route[0][0], route[0][1]);
  yaw = Math.atan2(route[1][0] - route[0][0], route[1][1] - route[0][1]);
  object.rotation.y = yaw;
  return {
    object,
    update,
    dispose() {
      mixer.stopAllAction();
      mixer.uncacheRoot(object);
    }
  };
}

/**
 * An animal grazing around `home` (island-local XZ). It picks open spots
 * within `range`, walks there, then
 * stands and grazes for a while.
 */
export function createAnimal(
  gltf: GLTF,
  shape: IslandShape,
  origin: THREE.Vector3,
  home: [number, number],
  range: number,
  length: number,
  seed: number,
  isOpen: (x: number, z: number) => boolean
): Walker {
  const object = cloneSkinned(gltf.scene);
  object.updateMatrixWorld(true);
  // Precise: skinned vertices in their bind pose, not the raw geometry box.
  const box = new THREE.Box3().setFromObject(object, true);
  const size = box.getSize(new THREE.Vector3());
  object.scale.setScalar(length / Math.max(0.01, Math.max(size.x, size.z)));
  object.traverse(child => {
    const mesh = child as THREE.Mesh;
    if (mesh.isMesh) {
      mesh.castShadow = true;
      mesh.frustumCulled = false;
    }
  });
  const mixer = new THREE.AnimationMixer(object);
  const clip = (name: string) => gltf.animations.find(item => item.name.endsWith(`|${name}`));
  const action = (name: string) => (clip(name) ? mixer.clipAction(clip(name)!) : null);
  const idle = action("Idle");
  const walk = action("WalkSlow") ?? action("Walk");
  const solver = createFarmLegSolver(object);
  const random = seededRandom(seed);
  let current: THREE.AnimationAction | null = null;
  const switchTo = (next: THREE.AnimationAction | null) => {
    if (!next || next === current) return;
    next.reset().play();
    if (current) current.crossFadeTo(next, 0.3, false);
    current = next;
  };
  let x = home[0], z = home[1], yaw = random() * Math.PI * 2;
  let target: [number, number] | null = null;
  let rest = 1 + random() * 4;
  const foot = object.getObjectByName("FrontFootL")!;
  const rigScale = foot.parent!.getWorldScale(new THREE.Vector3()).z;
  const track = walk?.getClip().tracks.find(item => item.name === "FrontFootL.position");
  const zValues = track ? Array.from(track.values).filter((_, index) => index % 3 === 2) : [];
  const stride = zValues.length ? Math.max(...zValues) - Math.min(...zValues) : length * 0.32 / rigScale;
  const cycle = walk?.getClip().duration ?? 1.5;
  const rate = 0.94 + random() * 0.12;
  const speed = stride * rigScale / (cycle * 0.62) * rate;
  const contacts = walk ? ["FrontFootL", "FrontFootR", "BackFootL", "BackFootR"].map(name => {
    const bone = object.getObjectByName(name)!;
    const values = walk.getClip().tracks.find(item => item.name === `${name}.position`)?.values;
    const ys = values ? Array.from(values).filter((_, index) => index % 3 === 1) : [bone.position.y];
    return { bone, floor: Math.min(...ys), y: bone.position.y, z: bone.position.z };
  }) : [];
  let authoredStep = 0;
  let phase = 0, gaitWeight = 0;
  const place = () => {
    object.position.set(origin.x + x, origin.y + shape.heightAt(x, z), origin.z + z);
    object.rotation.y = yaw;
  };
  const chooseTarget = () => {
    for (let attempt = 0; attempt < 12; attempt++) {
      const angle = random() * Math.PI * 2, distance = (0.3 + random() * 0.7) * range;
      const tx = home[0] + Math.cos(angle) * distance, tz = home[1] + Math.sin(angle) * distance;
      if (isOpen(tx, tz)) return [tx, tz] as [number, number];
    }
    return null;
  };
  switchTo(idle);
  place();
  const solve = () => solver.update(point => shape.heightAt(point.x - origin.x, point.z - origin.z) - shape.heightAt(x, z), true);
  const animate = (delta: number, moving: number) => {
    if (walk) walk.setEffectiveTimeScale(rate * moving);
    for (const contact of contacts) { contact.y = contact.bone.position.y;contact.z = contact.bone.position.z; }
    mixer.update(delta);
    // The clip's planted feet move backwards at a non-uniform speed. Move
    // the body by the same amount instead of guessing from clip duration.
    const planted = contacts.filter(item => Math.max(item.y, item.bone.position.y) < item.floor + stride * 0.06)
      .map(item => Math.max(0, item.z - item.bone.position.z) * rigScale).sort((a, b) => a - b);
    authoredStep = planted.length ? planted[Math.floor(planted.length / 2)] : speed * delta * moving * 0.5;
    if (!walk) {
      phase = (phase + delta * rate * moving / cycle) % 1;
      gaitWeight += (moving - gaitWeight) * Math.min(1, delta * 8);
      solver.gait(phase, stride, gaitWeight);
    }
  };
  const update = (delta: number) => {
    if (!target) {
      rest -= delta;
      if (rest <= 0) {
        target = chooseTarget();
        rest = 3 + random() * 6;
        if (target) switchTo(walk ?? idle);
      }
      animate(delta, 0);
      solve();
      return;
    }
    const dx = target[0] - x, dz = target[1] - z;
    const distance = Math.hypot(dx, dz);
    if (distance < 0.05) {
      target = null;
      switchTo(idle);
      animate(delta, 0);
      solve();
      return;
    }
    const heading = Math.atan2(dx, dz);
    const turn = Math.atan2(Math.sin(heading - yaw), Math.cos(heading - yaw));
    yaw += turn * Math.min(1, delta * 5);
    const moving = Math.max(0, Math.cos(turn));
    animate(delta, moving);
    const weight = walk ? walk.getEffectiveWeight() : gaitWeight;
    const step = Math.min(distance, walk ? authoredStep : speed * delta * moving * weight);
    const nextX = x + (dx / distance) * step, nextZ = z + (dz / distance) * step;
    // An open destination does not guarantee the straight route avoids a pond.
    if (!isOpen(nextX, nextZ)) {
      target = null;
      rest = 1 + random() * 2;
      switchTo(idle);
      solve();
      return;
    }
    x = nextX;
    z = nextZ;
    place();
    solve();
  };
  return {
    object,
    update,
    dispose() {
      mixer.stopAllAction();
      mixer.uncacheRoot(object);
    }
  };
}
