// The sky world: one island per category, built from the bundled CC0/CC-BY
// assets plus original terrain, materials and animation. The React layer owns
// labels, navigation and fallbacks; this module owns WebGL and must release
// every GPU resource, listener and animation frame on dispose.
import * as THREE from "three";
import { loadSkyLibrary } from "./assets";
import type { ModelTemplate, SkyLibrary, TemplatePart } from "./assets";
import { assignThemes, planIsland, themeTone } from "./biomes";
import type { IslandPlan, Placement } from "./biomes";
import { createFlocks, createWalker } from "./fauna";
import type { Flock, Walker } from "./fauna";
import { layoutIslands } from "./layout";
import type { LayoutIsland } from "./layout";
import { MAX_CLOUD_SHADOWS, SHARED_UNIFORMS, cloudLayerMaterial, skyDomeMaterial, terrainMaterial, toneGrass, waterMaterial } from "./materials";
import { hashString, seededRandom } from "./noise";
import { SKY_DIRECTIONS } from "./palettes";
import { IslandShape } from "./terrain";

export type SkyWorldIsland = { id: string; name: string; weight: number };

export type SkyWorldOptions = {
  host: HTMLElement;
  islands: SkyWorldIsland[];
  labels: Map<string, HTMLElement>;
  direction: keyof typeof SKY_DIRECTIONS | string;
  paused: boolean;
  lowPower: boolean;
  onOpen: (id: string) => void;
  onHover: (id: string | null) => void;
  onFailure: (reason: string) => void;
};

export type SkyWorld = {
  dispose: () => void;
  setPaused: (paused: boolean) => void;
  setLowPower: (lowPower: boolean) => void;
  focus: (id: string | null) => void;
  reset: () => void;
  stats: () => Record<string, number | string>;
};

type BuiltIsland = {
  layout: LayoutIsland;
  plan: IslandPlan;
  terrain: THREE.Mesh;
  material: THREE.MeshStandardMaterial;
  pick: THREE.Mesh;
  highlight: number;
  labelAnchor: THREE.Vector3;
  /** Below the rock tip: where the label goes if the front edge is covered. */
  tipAnchor: THREE.Vector3;
  /** Grass level and the height of the tallest trees or roofs above it. */
  surfaceY: number;
  crown: number;
  topY: number;
};

const UP = new THREE.Vector3(0, 1, 0);

export async function createSkyWorld(options: SkyWorldOptions): Promise<SkyWorld> {
  const direction = SKY_DIRECTIONS[options.direction] ?? SKY_DIRECTIONS.morning;
  const palette = direction.palette;
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance", alpha: false });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = palette.exposure;
  renderer.shadowMap.enabled = !options.lowPower;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const canvas = renderer.domElement;
  canvas.className = "sky-world-canvas";
  canvas.setAttribute("aria-hidden", "true");

  let library: SkyLibrary;
  try {
    library = await loadSkyLibrary(palette);
  } catch (error) {
    renderer.dispose();
    throw error;
  }
  options.host.prepend(canvas);

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(palette.fog, palette.fogNear, palette.fogFar);
  const disposables: Array<{ dispose: () => void }> = [];
  const track = <T extends { dispose: () => void }>(item: T) => (disposables.push(item), item);

  // Light: a warm sun and a sky/ground ambient; the sun direction also drives
  // the sky glow, cloud shading and foliage backlight.
  const sunDirection = new THREE.Vector3().setFromSphericalCoords(
    1,
    THREE.MathUtils.degToRad(90 - palette.sunElevation),
    THREE.MathUtils.degToRad(palette.sunAzimuth)
  );
  SHARED_UNIFORMS.uSunDirection.value.copy(sunDirection);
  SHARED_UNIFORMS.uSunColor.value.set(palette.sunColor);
  scene.add(new THREE.HemisphereLight(palette.ambientSky, palette.ambientGround, palette.ambientIntensity));
  const sun = new THREE.DirectionalLight(palette.sunColor, palette.sunIntensity);
  sun.castShadow = !options.lowPower;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.04;
  scene.add(sun, sun.target);

  // Sky dome and the cloud sea far below the islands.
  const skyGeometry = track(new THREE.SphereGeometry(900, 48, 24));
  const skyMaterial = track(skyDomeMaterial(palette));
  const sky = new THREE.Mesh(skyGeometry, skyMaterial);
  sky.frustumCulled = false;
  sky.renderOrder = -10;
  scene.add(sky);

  // Islands.
  const layout = layoutIslands(
    options.islands.map(item => ({ id: item.id, weight: item.weight })),
    { pitch: direction.pitch, heightSpread: direction.heightSpread, aspect: direction.aspect }
  );
  const quality = options.lowPower ? 0.65 : 1;
  const built: BuiltIsland[] = [];
  const pickGeometry = track(new THREE.CylinderGeometry(1, 0.55, 1, 20));
  const pickMaterial = track(new THREE.MeshBasicMaterial({ visible: false }));
  const waterGeometryCache: THREE.BufferGeometry[] = [];
  const water = track(waterMaterial(palette));
  type Bucket = { template: ModelTemplate; matrices: THREE.Matrix4[]; leaves: THREE.Color[]; grass: THREE.Color[] };
  const instanceBuckets = new Map<string, Bucket>();
  // Theme leaf colours are given for morning light; other palettes grade them.
  const linear = (value: string) => new THREE.Color(value);
  const morningLeaf = linear(SKY_DIRECTIONS.morning.palette.leafLight);
  const paletteLeaf = linear(palette.leafLight);
  const leafGrade = new THREE.Color(paletteLeaf.r / morningLeaf.r, paletteLeaf.g / morningLeaf.g, paletteLeaf.b / morningLeaf.b);
  const paletteGrass = linear(palette.grassLight);
  const buildingObjects: THREE.Object3D[] = [];
  const walkers: Walker[] = [];
  const bounds = new THREE.Box3();

  const themes = assignThemes(options.islands);
  options.islands.forEach((item, index) => {
    const position = layout[index];
    const theme = themes.get(item.id) ?? "meadow";
    const plan = planIsland(position.radius, position.seed, theme);
    const origin = new THREE.Vector3(position.x, position.y, position.z);
    const tone = themeTone(theme);
    const material = track(terrainMaterial(palette, library.textures.brush, library.textures.noise, tone));
    const toned = toneGrass(palette.grassLight, tone);
    const grassTint = new THREE.Color(toned.r / paletteGrass.r, toned.g / paletteGrass.g, toned.b / paletteGrass.b);
    const geometry = track(plan.shape.buildGeometry(quality));
    const terrain = new THREE.Mesh(geometry, material);
    terrain.position.copy(origin);
    terrain.receiveShadow = true;
    terrain.castShadow = !options.lowPower;
    terrain.userData.islandId = item.id;
    scene.add(terrain);
    geometry.computeBoundingBox();
    const box = geometry.boundingBox!.clone().translate(origin);
    bounds.union(box);

    // Generous invisible pick volume so small islands stay easy to click.
    const pick = new THREE.Mesh(pickGeometry, pickMaterial);
    pick.scale.set(position.radius * 1.12, box.max.y - box.min.y, position.radius * 1.12);
    pick.position.set(origin.x, (box.max.y + box.min.y) / 2, origin.z);
    pick.userData.islandId = item.id;
    scene.add(pick);

    for (const pond of plan.shape.ponds) {
      const pondGeometry = new THREE.CircleGeometry(pond.radius * 1.04, 48);
      pondGeometry.rotateX(-Math.PI / 2);
      waterGeometryCache.push(pondGeometry);
      const surface = new THREE.Mesh(pondGeometry, water);
      surface.position.set(origin.x + pond.x, origin.y + plan.shape.pondLevel(pond), origin.z + pond.z);
      surface.receiveShadow = true;
      scene.add(surface);
    }

    for (const building of plan.buildings) {
      const template = library.buildings.get(building.model);
      if (!template) continue;
      const group = new THREE.Group();
      for (const part of template.parts) {
        const mesh = new THREE.Mesh(part.geometry, part.material);
        mesh.applyMatrix4(part.matrix);
        mesh.castShadow = mesh.receiveShadow = true;
        group.add(mesh);
      }
      const level = plan.shape.heightAt(building.x, building.z);
      group.position.set(origin.x + building.x, origin.y + level - 0.04, origin.z + building.z);
      group.rotation.y = building.yaw;
      group.scale.setScalar(building.scale);
      group.userData.islandId = item.id;
      scene.add(group);
      buildingObjects.push(group);
    }

    const placementMatrix = (placement: Placement, template: ModelTemplate) => {
      const scale = placement.height ? placement.height / template.height : placement.scale;
      // Rest on the lowest point under the footprint so nothing hovers on a slope.
      const reach = Math.max(0.05, template.footprint * scale * 0.18);
      const ground = Math.min(
        plan.shape.heightAt(placement.x, placement.z),
        plan.shape.heightAt(placement.x + reach, placement.z),
        plan.shape.heightAt(placement.x - reach, placement.z),
        plan.shape.heightAt(placement.x, placement.z + reach),
        plan.shape.heightAt(placement.x, placement.z - reach)
      );
      const y = ground - placement.sink * template.height * scale;
      return new THREE.Matrix4().compose(
        new THREE.Vector3(origin.x + placement.x, origin.y + y, origin.z + placement.z),
        new THREE.Quaternion().setFromAxisAngle(UP, placement.yaw),
        new THREE.Vector3(scale, scale, scale)
      );
    };
    for (const placement of plan.placements) {
      if (options.lowPower && /^Grass/.test(placement.model) && placement.x * 7 % 2 > 1) continue;
      const template = (placement.library === "nature" ? library.nature : library.props).get(placement.model);
      if (!template) continue;
      const key = `${placement.library}:${placement.model}`;
      const bucket = instanceBuckets.get(key) ?? { template, matrices: [], leaves: [], grass: [] };
      bucket.matrices.push(placementMatrix(placement, template));
      bucket.leaves.push(placement.tint
        ? new THREE.Color().setRGB(placement.tint[0], placement.tint[1], placement.tint[2], THREE.SRGBColorSpace).multiply(leafGrade)
        : paletteLeaf);
      bucket.grass.push(grassTint);
      instanceBuckets.set(key, bucket);
    }

    for (const [walkerIndex, route] of plan.walkers.entries()) {
      const walker = createWalker(library.villager, plan.shape, origin, route, plan.buildingScale * 2.05, position.seed + walkerIndex);
      if (walker) {
        scene.add(walker.object);
        walkers.push(walker);
      }
    }

    const cliff = plan.shape.cliff;
    const frontRim = plan.shape.rimRadius(Math.PI / 2);
    built.push({
      layout: position,
      plan,
      terrain,
      material,
      pick,
      highlight: 0,
      topY: box.max.y,
      tipAnchor: new THREE.Vector3(origin.x, box.min.y + (box.max.y - box.min.y) * 0.04, origin.z),
      surfaceY: origin.y + plan.shape.heightAt(0, 0),
      crown: plan.buildings.length ? Math.max(...plan.buildings.map(building => (building.model === "Tower" ? 13 : 9) * building.scale)) : 3.6 * plan.buildingScale / 0.45,
      // Just under the grass lip of the edge facing the camera.
      labelAnchor: new THREE.Vector3(origin.x, origin.y + plan.shape.heightAt(0, frontRim * 0.95) - cliff * 0.3, origin.z + frontRim * 1.02)
    });
  });

  // Distant islands in the haze behind the archipelago give the view depth.
  // Scenery only: not clickable, no shadows, a few trees each. They are
  // placed from the framed camera (placeFarIslands) so they always sit far
  // back in the upper haze and never pass for an unlabeled category.
  type FarTree = { model: string; x: number; z: number; yaw: number; scale: number };
  type FarIsland = { mesh: THREE.Mesh; shape: IslandShape; depth: number; lane: number; rise: number; trees: FarTree[] };
  const farIslands: FarIsland[] = [];
  const farTrees: Array<{ mesh: THREE.InstancedMesh; part: TemplatePart; members: Array<{ island: FarIsland; tree: FarTree }> }> = [];
  if (!options.lowPower && built.length) {
    const random = seededRandom(hashString(`far:${built.length}`));
    const farMaterial = track(terrainMaterial(palette, library.textures.brush, library.textures.noise, themeTone("meadow")));
    const pines = ["Pine_2", "Pine_4", "CommonTree_2", "CommonTree_3"];
    const members = new Map<string, Array<{ island: FarIsland; tree: FarTree }>>();
    for (let index = 0; index < 6; index++) {
      const radius = 5 + random() * 6;
      const shape = new IslandShape(radius, 9000 + index * 131);
      const mesh = new THREE.Mesh(track(shape.buildGeometry(0.45)), farMaterial);
      scene.add(mesh);
      const island: FarIsland = {
        mesh,
        shape,
        depth: 140 + index * 55 + random() * 30,
        lane: (index % 2 === 0 ? -1 : 1) * (0.35 + ((index * 0.618) % 1) * 0.6),
        rise: 0.74 + random() * 0.2,
        trees: []
      };
      for (let tree = 0; tree < 3 + Math.floor(random() * 4); tree++) {
        const model = pines[Math.floor(random() * pines.length)];
        const template = library.nature.get(model);
        if (!template) continue;
        const angle = random() * Math.PI * 2, distance = Math.sqrt(random()) * radius * 0.6;
        const entry = { model, x: Math.cos(angle) * distance, z: Math.sin(angle) * distance, yaw: random() * Math.PI * 2, scale: (2.6 + random() * 1.4) / template.height };
        island.trees.push(entry);
        members.set(model, [...(members.get(model) ?? []), { island, tree: entry }]);
      }
      farIslands.push(island);
    }
    for (const [model, list] of members) {
      for (const part of library.nature.get(model)!.parts) {
        const mesh = new THREE.InstancedMesh(part.geometry, part.material, list.length);
        if ((part.material as THREE.Material).userData?.uniforms?.uLeafLight) list.forEach((_, index) => mesh.setColorAt(index, paletteLeaf));
        scene.add(mesh);
        track({ dispose: () => mesh.dispose() });
        farTrees.push({ mesh, part, members: list });
      }
    }
  }
  const placeFarIslands = (eye: THREE.Vector3) => {
    const tanV = Math.tan(THREE.MathUtils.degToRad(direction.fov / 2));
    for (const island of farIslands) {
      const z = bounds.min.z - island.depth;
      const horizontal = eye.z - z;
      const angle = THREE.MathUtils.degToRad(direction.pitch - (direction.fov / 2) * island.rise);
      island.mesh.position.set(eye.x + island.lane * horizontal * tanV * camera.aspect * 0.9, eye.y - horizontal * Math.tan(angle), z);
      // Small on screen whatever the archipelago's size: about 2-3% of the
      // view height across.
      island.mesh.scale.setScalar((horizontal * tanV * 0.05) / island.shape.radius * (0.7 + island.rise * 0.4));
    }
    const matrix = new THREE.Matrix4(), rotation = new THREE.Quaternion(), position = new THREE.Vector3(), scale = new THREE.Vector3();
    for (const entry of farTrees) {
      entry.members.forEach(({ island, tree }, index) => {
        const size = island.mesh.scale.x;
        position.set(tree.x, island.shape.heightAt(tree.x, tree.z) - 0.05, tree.z).multiplyScalar(size).add(island.mesh.position);
        matrix.compose(position, rotation.setFromAxisAngle(UP, tree.yaw), scale.setScalar(tree.scale * size));
        entry.mesh.setMatrixAt(index, matrix.multiply(entry.part.matrix));
      });
      entry.mesh.instanceMatrix.needsUpdate = true;
      entry.mesh.computeBoundingSphere();
    }
  };

  // One instanced mesh per model part across the whole archipelago.
  const instanced: THREE.InstancedMesh[] = [];
  for (const [key, bucket] of instanceBuckets) {
    for (const part of bucket.template.parts) {
      const mesh = new THREE.InstancedMesh(part.geometry, part.material, bucket.matrices.length);
      const uniforms = (part.material as THREE.Material).userData?.uniforms;
      const colors = uniforms?.uLeafLight ? bucket.leaves : uniforms?.uRoot && /^nature:Grass/.test(key) ? bucket.grass : null;
      bucket.matrices.forEach((matrix, index) => {
        mesh.setMatrixAt(index, matrix.clone().multiply(part.matrix));
        if (colors) mesh.setColorAt(index, colors[index]);
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      const small = /^(nature:(Grass|Flower|Clover|Pebble|RockPath|Mushroom|Plant|Fern))/.test(key);
      mesh.castShadow = !options.lowPower && !small;
      mesh.receiveShadow = !small;
      mesh.computeBoundingSphere();
      scene.add(mesh);
      instanced.push(mesh);
    }
  }

  // The cloud sea: an opaque base layer far below and a sparse layer of
  // wisps closer under the islands, both shaded per pixel, with the islands'
  // soft shadows falling on them.
  const size = bounds.getSize(new THREE.Vector3());
  const center = bounds.getCenter(new THREE.Vector3());
  const seaGeometry = track(new THREE.PlaneGeometry(2400, 2400, 1, 1));
  seaGeometry.rotateX(-Math.PI / 2);
  const cloudLayers = [
    { height: bounds.min.y - 30, material: track(cloudLayerMaterial(palette, { coverage: 0.42, scale: 0.016, speed: 0.012, opacity: 1, base: true })), strength: 0.42 },
    { height: bounds.min.y - 9, material: track(cloudLayerMaterial(palette, { coverage: 0.66, scale: 0.024, speed: 0.02, opacity: 0.85, base: false })), strength: 0.3 }
  ];
  const islandsBySize = [...built].sort((a, b) => b.layout.radius - a.layout.radius).slice(0, MAX_CLOUD_SHADOWS);
  for (const [layerIndex, layer] of cloudLayers.entries()) {
    const mesh = new THREE.Mesh(seaGeometry, layer.material);
    mesh.position.set(center.x, layer.height, center.z);
    mesh.renderOrder = -6 + layerIndex;
    mesh.frustumCulled = false;
    scene.add(mesh);
    const shadows = layer.material.uniforms.uShadows.value as THREE.Vector4[];
    islandsBySize.forEach((island, index) => {
      const origin = island.terrain.position;
      const drop = Math.max(0, origin.y - layer.height);
      shadows[index].set(
        origin.x - (sunDirection.x / sunDirection.y) * drop,
        origin.z - (sunDirection.z / sunDirection.y) * drop,
        island.layout.radius * 1.05,
        layer.strength
      );
    });
    layer.material.uniforms.uShadowCount.value = islandsBySize.length;
  }

  const flock: Flock | null = library.gull && built.length
    ? createFlocks(library.gull, bounds, options.lowPower ? 5 : 9, 7, 1.5)
    : null;
  if (flock) scene.add(flock.mesh);

  // Shadow camera tightly around the islands.
  const radius = Math.max(size.x, size.z) * 0.62 + 6;
  sun.position.copy(center).addScaledVector(sunDirection, radius * 2.2);
  sun.target.position.copy(center);
  Object.assign(sun.shadow.camera, { left: -radius, right: radius, top: radius, bottom: -radius, near: 1, far: radius * 4.5 });
  sun.shadow.camera.updateProjectionMatrix();

  // Camera: framed on the archipelago, pitched down; pan and zoom only.
  const camera = new THREE.PerspectiveCamera(direction.fov, 1, 0.5, 2000);
  const pitch = THREE.MathUtils.degToRad(direction.pitch);
  const home = { target: new THREE.Vector3(center.x, bounds.min.y + size.y * 0.55, center.z), distance: 60 };
  const view = { target: home.target.clone(), distance: 60 };
  const goal = { target: home.target.clone(), distance: 60 };
  let width = 1, height = 1, minDistance = 12, maxDistance = 200;
  const viewDirection = new THREE.Vector3(0, Math.sin(pitch), Math.cos(pitch));
  const applyCamera = () => {
    camera.position.copy(view.target).addScaledVector(viewDirection, view.distance);
    camera.lookAt(view.target);
    camera.updateMatrixWorld();
  };
  // Silhouette points for framing: terrain vertices (rim and underside) and
  // the rim raised by the crown height, where trees and roofs stand.
  const silhouette = (() => {
    const points: THREE.Vector3[] = [];
    const vertex = new THREE.Vector3();
    for (const island of built) {
      const position = island.terrain.geometry.getAttribute("position") as THREE.BufferAttribute;
      const stride = Math.max(1, Math.floor(position.count / 260));
      for (let index = 0; index < position.count; index += stride) {
        vertex.fromBufferAttribute(position, index).add(island.terrain.position);
        points.push(vertex.clone());
      }
      const crown = 2.2 + island.layout.radius * 0.22;
      for (let step = 0; step < 16; step++) {
        const angle = (step / 16) * Math.PI * 2;
        const rim = island.plan.shape.rimRadius(angle) * 0.8;
        const x = Math.cos(angle) * rim, z = Math.sin(angle) * rim;
        points.push(new THREE.Vector3(x, island.plan.shape.heightAt(x, z) + crown, z).add(island.terrain.position));
      }
    }
    return points;
  })();
  const fitHome = () => {
    const points = silhouette;
    // Leave room for the heading above and the status bar below.
    const top = height < 760 ? 0.58 : 0.62, bottom = height < 760 ? 0.62 : 0.68, side = 0.92;
    let low = 8, high = 1500;
    for (let iteration = 0; iteration < 40; iteration++) {
      const middle = (low + high) / 2;
      view.target.copy(home.target);
      view.distance = middle;
      applyCamera();
      const fits = points.every(point => {
        const projected = point.clone().project(camera);
        return projected.x > -side && projected.x < side && projected.y < top && projected.y > -bottom;
      });
      if (fits) high = middle; else low = middle;
    }
    home.distance = high;
    placeFarIslands(home.target.clone().addScaledVector(viewDirection, high));
    for (const layer of cloudLayers) layer.material.uniforms.uFade.value.set(high * 1.3, high * 4.2);
    minDistance = Math.max(10, Math.min(...built.map(island => island.layout.radius)) * 2.6);
    maxDistance = home.distance * 1.6;
  };

  const resize = () => {
    width = Math.max(1, options.host.clientWidth);
    height = Math.max(1, options.host.clientHeight);
    renderer.setPixelRatio(pixelRatio());
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    // Stay on the overview if the user has not moved away from it.
    const atHome = !initialized || (goal.target.distanceTo(home.target) < 0.01 && Math.abs(goal.distance - home.distance) < 0.01);
    measureLabels();
    fitHome();
    if (atHome) {
      goal.target.copy(home.target);
      goal.distance = home.distance;
    }
    view.target.copy(goal.target);
    view.distance = goal.distance;
    applyCamera();
    requestDraw();
  };

  // Resolution: native up to a 4K pixel budget, scaled down adaptively when
  // this device cannot hold the target frame rate.
  let resolutionScale = 1;
  const pixelRatio = () => {
    const native = Math.min(window.devicePixelRatio || 1, options.lowPower ? 1 : 2);
    const budget = Math.sqrt(8_300_000 / Math.max(1, width * height));
    return Math.max(0.6, Math.min(native, budget) * resolutionScale);
  };

  // State and loop.
  let disposed = false, failed = false, initialized = false;
  let paused = options.paused, lowPower = options.lowPower;
  let raf = 0, lastFrame = 0, clock = 0, frames = 0, dirty = true;
  let frameTimes: number[] = [];
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  const animating = () => !paused && !reduced.matches;
  let hovered: string | null = null, focusId: string | null = null;
  let pointerDown = false, moved = false, downX = 0, downY = 0, lastX = 0, lastY = 0, lastInteraction = 0;
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const projected = new THREE.Vector3();
  const pickTargets = built.map(island => island.pick);

  function requestDraw() {
    dirty = true;
    if (!raf && !disposed && !failed && !document.hidden) raf = requestAnimationFrame(draw);
  }

  function settle(delta: number) {
    const ease = reduced.matches ? 1 : 1 - Math.exp(-delta * 7);
    view.target.lerp(goal.target, ease);
    view.distance += (goal.distance - view.distance) * ease;
    // Never let the camera reach into an island.
    view.distance = THREE.MathUtils.clamp(view.distance, minDistance, maxDistance);
    applyCamera();
    return view.target.distanceTo(goal.target) + Math.abs(goal.distance - view.distance) > 0.01;
  }

  // Labels: projected to each island's front edge; when two would overlap
  // on screen, the smaller island's label steps down below the larger one's,
  // or hides (its island stays clickable) if there is no room.
  const labelSizes = new Map<string, { width: number; height: number }>();
  const measureLabels = () => {
    for (const [id, label] of options.labels) labelSizes.set(id, { width: label.offsetWidth, height: label.offsetHeight });
  };
  const labelOrder = [...built].sort((a, b) => b.layout.radius - a.layout.radius);
  // Screen footprint of each island's top (grass ellipse up to its crown),
  // which labels of other islands must not cover.
  type TopShape = { id: string; x0: number; y0: number; x1: number; y1: number; rx: number; ry: number };
  const toScreen = (point: THREE.Vector3) => {
    projected.copy(point).project(camera);
    return { x: (projected.x * 0.5 + 0.5) * width, y: (-projected.y * 0.5 + 0.5) * height, z: projected.z };
  };
  const scratch = new THREE.Vector3();
  const topShapes = (): TopShape[] => built.map(island => {
    const o = island.terrain.position, r = island.layout.radius * 1.05;
    const ground = toScreen(scratch.set(o.x, island.surfaceY, o.z));
    const crown = toScreen(scratch.set(o.x, island.surfaceY + island.crown, o.z));
    const side = toScreen(scratch.set(o.x + r, island.surfaceY, o.z));
    const front = toScreen(scratch.set(o.x, island.surfaceY, o.z + r));
    return { id: island.layout.id, x0: ground.x, y0: ground.y, x1: crown.x, y1: crown.y, rx: Math.abs(side.x - ground.x), ry: Math.max(4, Math.abs(front.y - ground.y)) };
  });
  const covers = (shape: TopShape, x: number, y: number) => {
    const dx = (x - shape.x0) / shape.rx;
    if (Math.abs(dx) >= 1) return false;
    const below = (y - shape.y0) / shape.ry, above = (y - shape.y1) / shape.ry;
    return dx * dx + below * below < 1 || dx * dx + above * above < 1 || (y < shape.y0 && y > shape.y1);
  };
  const blocksIsland = (shapes: TopShape[], own: string, left: number, top: number, w: number, h: number) =>
    shapes.some(shape => shape.id !== own && [0, 0.5, 1].some(u => [0, 0.5, 1].some(v => covers(shape, left + u * w, top + v * h))));

  function placeLabels() {
    const shapes = topShapes();
    const placedRects: Array<{ left: number; right: number; top: number; bottom: number }> = [];
    for (const island of labelOrder) {
      const label = options.labels.get(island.layout.id);
      if (!label) continue;
      let size = labelSizes.get(island.layout.id);
      if (!size || !size.width) {
        // Labels are hidden until the scene is ready; measure once they show.
        size = { width: label.offsetWidth, height: label.offsetHeight };
        labelSizes.set(island.layout.id, size);
      }
      // Front edge first; then below the rock tip; then above the crown.
      const o = island.terrain.position;
      const candidates = [
        toScreen(island.labelAnchor),
        toScreen(island.tipAnchor),
        (() => {
          const above = toScreen(scratch.set(o.x, island.surfaceY + island.crown, o.z));
          return { ...above, y: above.y - size.height - 6 };
        })()
      ];
      const anchor = candidates.find(candidate => !blocksIsland(shapes, island.layout.id, candidate.x - size!.width / 2, candidate.y, size!.width, size!.height)) ?? candidates[0];
      let visible = anchor.z < 1 && anchor.x > -width * 0.05 && anchor.x < width * 1.05 && anchor.y > -height * 0.05 && anchor.y < height * 1.05;
      const x = anchor.x;
      let y = anchor.y;
      const rect = () => ({ left: x - size!.width / 2 - 4, right: x + size!.width / 2 + 4, top: y - 3, bottom: y + size!.height + 3 });
      for (let attempt = 0; visible && attempt < 3; attempt++) {
        const box = rect();
        const blocker = placedRects.find(other => box.left < other.right && box.right > other.left && box.top < other.bottom && box.bottom > other.top);
        if (!blocker) break;
        if (attempt === 2 || blocker.bottom - box.top > size.height * 1.6) visible = false;
        else y = blocker.bottom + 3;
      }
      if (visible) placedRects.push(rect());
      label.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, 0)`;
      label.style.visibility = visible ? "visible" : "hidden";
    }
  }

  function draw(now: number) {
    raf = 0;
    if (disposed || failed || document.hidden) {
      lastFrame = 0;
      return;
    }
    const interacting = now - lastInteraction < 400;
    const targetInterval = interacting ? 1000 / 60 : lowPower ? 1000 / 22 : 1000 / 34;
    if (lastFrame && now - lastFrame < targetInterval - 2 && !dirty) {
      raf = requestAnimationFrame(draw);
      return;
    }
    const delta = lastFrame ? Math.min(0.1, (now - lastFrame) / 1000) : 1 / 60;
    if (lastFrame) {
      frameTimes.push(now - lastFrame);
      if (frameTimes.length > 90) frameTimes.shift();
    }
    lastFrame = now;
    dirty = false;
    const moving = settle(delta);
    if (animating()) {
      clock += delta;
      SHARED_UNIFORMS.uTime.value = clock;
      SHARED_UNIFORMS.uWind.value = 1;
      flock?.update(clock);
      for (const walker of walkers) walker.update(delta);
    }
    let highlighting = false;
    for (const island of built) {
      const target = island.layout.id === (hovered ?? focusId) ? 1 : 0;
      island.highlight += (target - island.highlight) * Math.min(1, delta * 8);
      if (Math.abs(target - island.highlight) > 0.01) highlighting = true;
      island.material.userData.uniforms.uHighlight.value = island.highlight;
    }
    placeLabels();
    renderer.render(scene, camera);
    frames++;
    if (frames % 30 === 0) adaptResolution();
    const host = options.host;
    host.dataset.frames = String(frames);
    host.dataset.drawCalls = String(renderer.info.render.calls);
    host.dataset.triangles = String(renderer.info.render.triangles);
    host.dataset.pixelRatio = renderer.getPixelRatio().toFixed(2);
    initialized = true;
    if (animating() || moving || highlighting) raf = requestAnimationFrame(draw);
  }

  function adaptResolution() {
    if (frameTimes.length < 60 || !animating()) return;
    const sorted = [...frameTimes].sort((a, b) => a - b);
    const typical = sorted[Math.floor(sorted.length * 0.5)];
    const budget = (lowPower ? 1000 / 22 : 1000 / 34) * 1.35;
    if (typical > budget && resolutionScale > 0.62) {
      resolutionScale = Math.max(0.62, resolutionScale * 0.85);
      renderer.setPixelRatio(pixelRatio());
      renderer.setSize(width, height, false);
      frameTimes = [];
    }
  }

  const hitIsland = (event: PointerEvent): string | null => {
    const rect = canvas.getBoundingClientRect();
    pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObjects(pickTargets, false)[0];
    return (hit?.object.userData.islandId as string | undefined) ?? null;
  };
  const setHover = (id: string | null) => {
    if (hovered === id) return;
    hovered = id;
    canvas.style.cursor = id ? "pointer" : "grab";
    options.labels.forEach((label, key) => label.classList.toggle("is-hovered", key === id));
    options.onHover(id);
    requestDraw();
  };
  const panBy = (dx: number, dy: number) => {
    const scale = (2 * goal.distance * Math.tan(THREE.MathUtils.degToRad(direction.fov / 2))) / height;
    goal.target.x -= dx * scale;
    goal.target.z -= dy * scale / Math.sin(pitch) * 0.9;
    const limitX = size.x * 0.6 + 6, limitZ = size.z * 0.6 + 6;
    goal.target.x = THREE.MathUtils.clamp(goal.target.x, center.x - limitX, center.x + limitX);
    goal.target.z = THREE.MathUtils.clamp(goal.target.z, center.z - limitZ, center.z + limitZ);
  };
  const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return;
    pointerDown = true;
    moved = false;
    downX = lastX = event.clientX;
    downY = lastY = event.clientY;
    canvas.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent) => {
    if (pointerDown) {
      moved ||= Math.hypot(event.clientX - downX, event.clientY - downY) > 6;
      if (moved) {
        panBy(event.clientX - lastX, event.clientY - lastY);
        lastInteraction = performance.now();
        canvas.style.cursor = "grabbing";
        setHover(null);
        requestDraw();
      }
      lastX = event.clientX;
      lastY = event.clientY;
      return;
    }
    setHover(hitIsland(event));
  };
  const onPointerUp = (event: PointerEvent) => {
    if (!pointerDown) return;
    pointerDown = false;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    canvas.style.cursor = hovered ? "pointer" : "grab";
    if (!moved) {
      const id = hitIsland(event);
      if (id) options.onOpen(id);
    }
  };
  const onPointerLeave = () => {
    if (!pointerDown) setHover(null);
  };
  const onWheel = (event: WheelEvent) => {
    event.preventDefault();
    const factor = Math.exp(event.deltaY * (event.deltaMode === 1 ? 0.05 : 0.0012));
    const next = THREE.MathUtils.clamp(goal.distance * factor, minDistance, maxDistance);
    // Zoom toward the cursor: move the target part of the way to it.
    const rect = canvas.getBoundingClientRect();
    const ndcX = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    const pull = 1 - next / goal.distance;
    panBy(-ndcX * width * 0.5 * pull, ndcY * height * 0.5 * pull);
    goal.distance = next;
    lastInteraction = performance.now();
    requestDraw();
  };
  const onContextLost = (event: Event) => {
    event.preventDefault();
    failed = true;
    cancelAnimationFrame(raf);
    raf = 0;
    options.onFailure("context-lost");
  };
  const onVisibility = () => {
    if (document.hidden) {
      cancelAnimationFrame(raf);
      raf = 0;
      lastFrame = 0;
    } else {
      requestDraw();
    }
  };
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerUp);
  canvas.addEventListener("pointerleave", onPointerLeave);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("webglcontextlost", onContextLost);
  document.addEventListener("visibilitychange", onVisibility);
  reduced.addEventListener("change", requestDraw);
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(options.host);
  const intersection = new IntersectionObserver(entries => {
    if (entries.some(entry => entry.isIntersecting)) requestDraw();
    else {
      cancelAnimationFrame(raf);
      raf = 0;
      lastFrame = 0;
    }
  });
  intersection.observe(options.host);
  resize();
  goal.distance = view.distance = home.distance;
  applyCamera();
  requestDraw();

  return {
    setPaused(value) {
      paused = value;
      lastFrame = 0;
      requestDraw();
    },
    setLowPower(value) {
      lowPower = value;
      renderer.shadowMap.enabled = !value;
      sun.castShadow = !value;
      renderer.setPixelRatio(pixelRatio());
      renderer.setSize(width, height, false);
      requestDraw();
    },
    focus(id) {
      focusId = id;
      const island = built.find(item => item.layout.id === id);
      if (island) {
        goal.target.set(island.terrain.position.x, island.topY - island.layout.radius * 0.4, island.terrain.position.z);
        goal.distance = THREE.MathUtils.clamp(island.layout.radius * 4.2, minDistance, maxDistance);
      }
      lastInteraction = performance.now();
      requestDraw();
    },
    reset() {
      focusId = null;
      goal.target.copy(home.target);
      goal.distance = home.distance;
      lastInteraction = performance.now();
      requestDraw();
    },
    stats() {
      const sorted = [...frameTimes].sort((a, b) => a - b);
      return {
        islands: built.length,
        drawCalls: renderer.info.render.calls,
        triangles: renderer.info.render.triangles,
        geometries: renderer.info.memory.geometries,
        textures: renderer.info.memory.textures,
        pixelRatio: Number(renderer.getPixelRatio().toFixed(2)),
        medianFrameMs: sorted.length ? Number(sorted[Math.floor(sorted.length / 2)].toFixed(1)) : 0,
        frames
      };
    },
    dispose() {
      disposed = true;
      cancelAnimationFrame(raf);
      resizeObserver.disconnect();
      intersection.disconnect();
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerUp);
      canvas.removeEventListener("pointerleave", onPointerLeave);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("webglcontextlost", onContextLost);
      document.removeEventListener("visibilitychange", onVisibility);
      reduced.removeEventListener("change", requestDraw);
      for (const walker of walkers) walker.dispose();
      flock?.dispose();
      for (const mesh of instanced) mesh.dispose();
      for (const geometry of waterGeometryCache) geometry.dispose();
      for (const item of disposables) item.dispose();
      library.dispose();
      sun.shadow.map?.dispose();
      scene.clear();
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
    }
  };
}
