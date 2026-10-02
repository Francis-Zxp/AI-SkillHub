// The sky world: one cartoon island per category. Terrain, plants, rocks,
// water and clouds are built in code and toon shaded; houses, props, the
// villager and the animals are bundled CC0 models (gulls CC-BY), recoloured
// flat. The React layer owns labels, navigation and fallbacks; this module
// owns WebGL and must release every GPU resource, listener and frame.
import * as THREE from "three";
import { loadSkyLibrary } from "./assets";
import type { ModelTemplate, SkyLibrary } from "./assets";
import { assignThemes, planIsland, themeTone } from "./biomes";
import type { IslandPlan, Placement } from "./biomes";
import { createAnimal, createFlocks, createWalker } from "./fauna";
import type { Flock, Walker } from "./fauna";
import { buildKit, cloudGeometry, disposeKit } from "./kit";
import type { KitModel } from "./kit";
import { layoutIslands } from "./layout";
import type { LayoutIsland } from "./layout";
import { SHARED_UNIFORMS, addSway, cloudMaterial, skyDomeMaterial, terrainMaterial, toneColor, toonMaterial, waterMaterial, waterfallMaterial } from "./materials";
import { hashString, seededRandom } from "./noise";
import { SKY_DIRECTIONS } from "./palettes";
import { IslandShape } from "./terrain";

export type SkyWorldIsland = { id: string; name: string; weight: number };

export type SkyWorldOptions = {
  host: HTMLElement;
  islands: SkyWorldIsland[];
  labels: Map<string, HTMLElement>;
  /** Time of day: dawn, noon, golden or night. */
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
  material: THREE.MeshLambertMaterial;
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
  const direction = SKY_DIRECTIONS[options.direction] ?? SKY_DIRECTIONS.noon;
  const palette = direction.palette;
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance", alpha: false });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
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
  const kit = buildKit();
  track({ dispose: () => disposeKit(kit) });

  // Light: a soft sky/ground fill and one sun; toon steps do the rest.
  const sunDirection = new THREE.Vector3().setFromSphericalCoords(
    1,
    THREE.MathUtils.degToRad(90 - palette.sunElevation),
    THREE.MathUtils.degToRad(palette.sunAzimuth)
  );
  SHARED_UNIFORMS.uSunDirection.value.copy(sunDirection);
  scene.add(new THREE.HemisphereLight(palette.ambientSky, palette.ambientGround, palette.ambientIntensity));
  const sun = new THREE.DirectionalLight(palette.sunColor, palette.sunIntensity);
  sun.castShadow = !options.lowPower;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.05;
  sun.shadow.radius = 3;
  scene.add(sun, sun.target);

  const skyGeometry = track(new THREE.SphereGeometry(900, 32, 16));
  const sky = new THREE.Mesh(skyGeometry, track(skyDomeMaterial(palette)));
  sky.frustumCulled = false;
  sky.renderOrder = -10;
  scene.add(sky);

  // Kit materials: one per part kind; leaves and grass sway in the wind.
  const kitMaterials = new Map<string, THREE.Material>();
  const kitMaterial = (model: KitModel, partIndex: number) => {
    const part = model.parts[partIndex];
    const key = `${model.name}:${partIndex}`;
    if (!kitMaterials.has(key)) {
      const material = toonMaterial();
      const sway = model.name.startsWith("grass") ? 0.08 : part.role === "tint" && !model.name.startsWith("rock") && model.name !== "mushroom" ? 0.05 : 0;
      if (sway > 0) addSway(material, model.height, sway * model.height);
      kitMaterials.set(key, track(material));
    }
    return kitMaterials.get(key)!;
  };

  // Islands.
  const layout = layoutIslands(
    options.islands.map(item => ({ id: item.id, weight: item.weight })),
    { pitch: direction.pitch, heightSpread: direction.heightSpread, aspect: direction.aspect }
  );
  const quality = options.lowPower ? 0.7 : 1;
  const built: BuiltIsland[] = [];
  const pickGeometry = track(new THREE.CylinderGeometry(1, 0.55, 1, 20));
  const pickMaterial = track(new THREE.MeshBasicMaterial({ visible: false }));
  const waterGeometryCache: THREE.BufferGeometry[] = [];
  const water = track(waterMaterial(palette));
  const stream = track(waterMaterial(palette, true));
  const falls = track(waterfallMaterial(palette));
  type Bucket = { parts: Array<{ geometry: THREE.BufferGeometry; material: THREE.Material; matrix: THREE.Matrix4; tinted: boolean }>; matrices: THREE.Matrix4[]; tints: THREE.Color[]; small: boolean };
  const instanceBuckets = new Map<string, Bucket>();
  const walkers: Walker[] = [];
  const bounds = new THREE.Box3();
  const identity = new THREE.Matrix4();

  const bucketFor = (placement: Placement): { bucket: Bucket; height: number; footprint: number } | null => {
    const key = `${placement.library}:${placement.model}`;
    if (placement.library === "kit") {
      const model = kit.get(placement.model);
      if (!model) return null;
      const bucket = instanceBuckets.get(key) ?? {
        parts: model.parts.map((part, index) => ({ geometry: part.geometry, material: kitMaterial(model, index), matrix: identity, tinted: part.role === "tint" })),
        matrices: [],
        tints: [],
        small: /^(grass|flower|mushroom)/.test(model.name)
      };
      instanceBuckets.set(key, bucket);
      return { bucket, height: model.height, footprint: model.footprint };
    }
    const template: ModelTemplate | undefined = library.props.get(placement.model);
    if (!template) return null;
    const bucket = instanceBuckets.get(key) ?? {
      parts: template.parts.map(part => ({ geometry: part.geometry, material: part.material, matrix: part.matrix, tinted: false })),
      matrices: [],
      tints: [],
      small: false
    };
    instanceBuckets.set(key, bucket);
    return { bucket, height: template.height, footprint: template.footprint };
  };

  const themes = assignThemes(options.islands);
  options.islands.forEach((item, index) => {
    const position = layout[index];
    const theme = themes.get(item.id) ?? "meadow";
    const plan = planIsland(position.radius, position.seed, theme);
    const origin = new THREE.Vector3(position.x, position.y, position.z);
    const tone = themeTone(theme);
    const material = track(terrainMaterial(palette, tone, plan.shape.paths));
    // Tufts a shade deeper than the ground they grow from.
    const tuft = toneColor(palette.grassDark, tone).multiplyScalar(0.92);
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
      const pondGeometry = new THREE.CircleGeometry(pond.radius * 1.04, 40);
      pondGeometry.rotateX(-Math.PI / 2);
      waterGeometryCache.push(pondGeometry);
      const surface = new THREE.Mesh(pondGeometry, water);
      surface.position.set(origin.x + pond.x, origin.y + plan.shape.pondLevel(pond), origin.z + pond.z);
      surface.receiveShadow = true;
      scene.add(surface);
    }

    // The pond spills over the rim: a ribbon of falling water down the cliff.
    if (plan.waterfall && plan.shape.ponds.length) {
      const fall = plan.waterfall;
      const pond = plan.shape.ponds[0];
      const top = origin.y + plan.shape.pondLevel(pond);
      const drop = plan.shape.cliff + plan.shape.bottomDepth * 0.95;
      const fallGeometry = new THREE.PlaneGeometry(fall.width, drop, 1, 24);
      fallGeometry.translate(0, -drop / 2, 0);
      const fallVertices = fallGeometry.getAttribute("position");
      for (let vertex = 0; vertex < fallVertices.count; vertex++) {
        const t = -fallVertices.getY(vertex) / drop;
        fallVertices.setZ(vertex, Math.sin(t * Math.PI * 0.5) * Math.min(0.6, drop * 0.045));
      }
      fallGeometry.computeVertexNormals();
      waterGeometryCache.push(fallGeometry);
      const sheet = new THREE.Mesh(fallGeometry, falls);
      const outward = new THREE.Vector3(Math.cos(fall.angle), 0, Math.sin(fall.angle));
      const lipX = fall.x + outward.x * 0.12, lipZ = fall.z + outward.z * 0.12;
      sheet.position.set(origin.x + lipX, top, origin.z + lipZ);
      sheet.lookAt(sheet.position.clone().add(outward));
      sheet.renderOrder = 2;
      scene.add(sheet);
      // A channel of water from the pond to the lip.
      const channelStartX = pond.x + outward.x * pond.radius * 0.85;
      const channelStartZ = pond.z + outward.z * pond.radius * 0.85;
      const channelLength = Math.hypot(lipX - channelStartX, lipZ - channelStartZ);
      const channelGeometry = new THREE.PlaneGeometry(fall.width, channelLength, 1, 1);
      channelGeometry.rotateX(-Math.PI / 2);
      waterGeometryCache.push(channelGeometry);
      const channel = new THREE.Mesh(channelGeometry, stream);
      channel.position.set(origin.x + (lipX + channelStartX) / 2, top, origin.z + (lipZ + channelStartZ) / 2);
      channel.rotation.y = Math.atan2(lipX - channelStartX, lipZ - channelStartZ);
      scene.add(channel);
    }

    for (const building of plan.buildings) {
      const template = library.buildings.get(building.model);
      if (!template) continue;
      const group = new THREE.Group();
      for (const part of template.parts) {
        const mesh = new THREE.Mesh(part.geometry, part.role === "roof" ? library.roofMaterial(building.roof) : part.material);
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
    }

    for (const placement of plan.placements) {
      if (options.lowPower && placement.model.startsWith("grass") && placement.x * 7 % 2 > 1) continue;
      const entry = bucketFor(placement);
      if (!entry) continue;
      const scale = placement.height ? placement.height / entry.height : placement.scale;
      // Rest on the lowest point under the footprint so nothing hovers on a slope.
      const reach = Math.max(0.05, entry.footprint * scale * 0.18);
      const ground = Math.min(
        plan.shape.heightAt(placement.x, placement.z),
        plan.shape.heightAt(placement.x + reach, placement.z),
        plan.shape.heightAt(placement.x - reach, placement.z),
        plan.shape.heightAt(placement.x, placement.z + reach),
        plan.shape.heightAt(placement.x, placement.z - reach)
      );
      const y = ground - placement.sink * entry.height * scale;
      entry.bucket.matrices.push(new THREE.Matrix4().compose(
        new THREE.Vector3(origin.x + placement.x, origin.y + y, origin.z + placement.z),
        new THREE.Quaternion().setFromAxisAngle(UP, placement.yaw),
        new THREE.Vector3(scale, scale, scale)
      ));
      entry.bucket.tints.push(placement.tint === "grass" ? tuft : new THREE.Color(placement.tint ?? "#ffffff"));
    }

    for (const [walkerIndex, route] of plan.walkers.entries()) {
      const walker = createWalker(library.villager, plan.shape, origin, route, plan.buildingScale * 2.05, position.seed + walkerIndex);
      if (walker) {
        scene.add(walker.object);
        walkers.push(walker);
      }
    }
    const openGround = (x: number, z: number) =>
      plan.shape.normalizedDistance(x, z) < 0.78 && !plan.shape.isInsidePond(x, z, 0.5) && plan.shape.pathWeight(x, z) < 0.2 &&
      plan.shape.pads.every(pad => Math.hypot(x - pad.x, z - pad.z) > pad.radius + 0.6);
    for (const animal of plan.animals) {
      const gltf = library.animals.get(animal.name);
      if (!gltf) continue;
      const length = (animal.name === "Pug" ? 0.75 : animal.name === "Horse" || animal.name === "Cow" ? 1.7 : 1.15) * plan.buildingScale / 0.45;
      const walker = createAnimal(gltf, plan.shape, origin, [animal.x, animal.z], position.radius * 0.28, length, animal.seed, openGround);
      scene.add(walker.object);
      walkers.push(walker);
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
      crown: plan.buildings.length ? Math.max(...plan.buildings.map(building => (building.model === "Tower" ? 13 : 9) * building.scale)) : 3.2 * plan.buildingScale / 0.45,
      // Just under the grass lip of the edge facing the camera.
      labelAnchor: new THREE.Vector3(origin.x, origin.y + plan.shape.heightAt(0, frontRim * 0.95) - cliff * 0.3, origin.z + frontRim * 1.02)
    });
  });

  // Distant islands in the haze behind the archipelago give the view depth.
  // Scenery only: not clickable, no shadows, a few trees each. They are
  // placed from the framed camera (placeFarIslands) so they always sit far
  // back in the upper haze and never pass for an unlabeled category.
  type FarIsland = { group: THREE.Group; shape: IslandShape; depth: number; lane: number; rise: number };
  const farIslands: FarIsland[] = [];
  if (!options.lowPower && built.length) {
    const random = seededRandom(hashString(`far:${built.length}`));
    const farMaterial = track(terrainMaterial(palette, themeTone("meadow")));
    const tree = kit.get("round-23")!;
    for (let index = 0; index < 6; index++) {
      const radius = 5 + random() * 6;
      const shape = new IslandShape(radius, 9000 + index * 131);
      const group = new THREE.Group();
      group.add(new THREE.Mesh(track(shape.buildGeometry(0.5)), farMaterial));
      for (let count = 0; count < 3 + Math.floor(random() * 3); count++) {
        const angle = random() * Math.PI * 2, distance = Math.sqrt(random()) * radius * 0.6;
        const x = Math.cos(angle) * distance, z = Math.sin(angle) * distance;
        tree.parts.forEach((part, partIndex) => {
          const mesh = new THREE.Mesh(part.geometry, kitMaterial(tree, partIndex));
          mesh.position.set(x, shape.heightAt(x, z), z);
          mesh.scale.setScalar(1.3 + random() * 0.4);
          group.add(mesh);
        });
      }
      scene.add(group);
      farIslands.push({
        group,
        shape,
        depth: 140 + index * 55 + random() * 30,
        lane: (index % 2 === 0 ? -1 : 1) * (0.35 + ((index * 0.618) % 1) * 0.6),
        rise: 0.74 + random() * 0.2
      });
    }
  }
  const placeFarIslands = (eye: THREE.Vector3) => {
    const tanV = Math.tan(THREE.MathUtils.degToRad(direction.fov / 2));
    for (const island of farIslands) {
      const z = bounds.min.z - island.depth;
      const horizontal = eye.z - z;
      const angle = THREE.MathUtils.degToRad(direction.pitch - (direction.fov / 2) * island.rise);
      island.group.position.set(eye.x + island.lane * horizontal * tanV * camera.aspect * 0.9, eye.y - horizontal * Math.tan(angle), z);
      // Small on screen whatever the archipelago's size.
      island.group.scale.setScalar((horizontal * tanV * 0.05) / island.shape.radius * (0.7 + island.rise * 0.4));
    }
  };

  // One instanced mesh per model part across the whole archipelago.
  const instanced: THREE.InstancedMesh[] = [];
  for (const bucket of instanceBuckets.values()) {
    for (const part of bucket.parts) {
      const mesh = new THREE.InstancedMesh(part.geometry, part.material, bucket.matrices.length);
      bucket.matrices.forEach((matrix, index) => {
        mesh.setMatrixAt(index, matrix.clone().multiply(part.matrix));
        if (part.tinted) mesh.setColorAt(index, bucket.tints[index]);
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.castShadow = !options.lowPower && !bucket.small;
      mesh.receiveShadow = !bucket.small;
      mesh.computeBoundingSphere();
      scene.add(mesh);
      instanced.push(mesh);
    }
  }

  // Cartoon clouds: big soft banks below the islands and a few small ones
  // drifting at island height between them.
  const size = bounds.getSize(new THREE.Vector3());
  const center = bounds.getCenter(new THREE.Vector3());
  const cloudMat = track(cloudMaterial(palette));
  const cloudShapes = [1, 2, 3, 4].map(seed => track(cloudGeometry(seed)));
  const clouds: Array<{ mesh: THREE.Mesh; baseX: number; speed: number; span: number }> = [];
  {
    const random = seededRandom(77);
    const bankCount = options.lowPower ? 10 : 18;
    for (let index = 0; index < bankCount + (options.lowPower ? 3 : 6); index++) {
      const low = index < bankCount;
      const mesh = new THREE.Mesh(cloudShapes[index % cloudShapes.length], cloudMat);
      const scale = low ? 3.4 + random() * 3 : 1.1 + random() * 0.9;
      mesh.scale.set(scale, scale * (low ? 0.75 : 0.85), scale);
      const spread = low ? 1.5 : 1.15;
      mesh.position.set(
        center.x + (random() - 0.5) * size.x * spread,
        low ? bounds.min.y - 10 - random() * 14 : bounds.min.y + size.y * (0.15 + random() * 0.35),
        center.z + (random() - 0.5) * size.z * spread - (low ? 6 : 0)
      );
      mesh.rotation.y = random() * Math.PI;
      mesh.receiveShadow = false;
      scene.add(mesh);
      clouds.push({ mesh, baseX: mesh.position.x, speed: (low ? 0.15 : 0.35) * (0.6 + random() * 0.8), span: low ? 6 : 10 });
    }
  }
  const driftClouds = (time: number) => {
    for (const cloud of clouds) cloud.mesh.position.x = cloud.baseX + Math.sin(time * 0.02 * cloud.speed) * cloud.span;
  };

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
      flock?.update(clock);
      driftClouds(clock);
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
        frames,
        ...(() => {
          const counts = { meshes: 0, instanced: 0, skinned: 0, groups: 0 };
          scene.traverse(object => {
            if ((object as THREE.InstancedMesh).isInstancedMesh) counts.instanced++;
            else if ((object as THREE.SkinnedMesh).isSkinnedMesh) counts.skinned++;
            else if ((object as THREE.Mesh).isMesh) counts.meshes++;
            const material = (object as THREE.Mesh).material;
            if (Array.isArray(material)) counts.groups += material.length;
          });
          return counts;
        })()
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
