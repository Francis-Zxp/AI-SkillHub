// The sky world: one cartoon island per category. Terrain, plants, rocks,
// water and clouds are built in code and toon shaded; houses, props, the
// villager and the animals are bundled CC0 models (gulls CC-BY), recoloured
// flat. Each island has a climate (snowy peak, desert mesa, volcano, rice
// terraces…) chosen from the world seed, and the whole sky has weather.
// The React layer owns labels, navigation and fallbacks; this module owns
// WebGL and must release every GPU resource, listener and frame.
import * as THREE from "three";
import type { SkyWeatherKind, SkyWeatherSetting } from "../skyScene";
import { loadSkyLibrary } from "./assets";
import type { ModelTemplate, SkyLibrary } from "./assets";
import { assignThemes, planIsland, themeTone } from "./biomes";
import type { IslandPlan, Placement } from "./biomes";
import { CLIMATES, assignClimates, layoutNeighbours } from "./climates";
import type { ClimateId, ClimateSpec } from "./climates";
import { createSmoke, setPointScale } from "./effects";
import type { Smoke } from "./effects";
import { createAnimal, createFlocks, createWalker } from "./fauna";
import type { Flock, Walker } from "./fauna";
import { buildKit, cloudGeometry, disposeKit } from "./kit";
import { spillwayGeometry } from "./water";
import type { KitModel } from "./kit";
import { layoutIslands } from "./layout";
import type { LayoutIsland } from "./layout";
import {
  SHARED_UNIFORMS, cloudMaterial, kitShader, lavaMaterial, paletteGround, phaseFilter, resetSharedUniforms, setSkyDomePalette,
  setTerrainGround, setWaterColors, setWaterfallColor, skyDomeMaterial, terrainMaterial, toonMaterial, waterColors,
  waterMaterial, waterfallMaterial
} from "./materials";
import type { GroundLook, GroundTone, SkyPalette } from "./materials";
import { hashString, seededRandom } from "./noise";
import { SKY_DIRECTIONS } from "./palettes";
import { IslandShape } from "./terrain";
import { createWeather } from "./weather";
import type { Weather } from "./weather";
import { resolveWeather } from "./weatherPlan";
import type { SkyPhaseName } from "./weatherPlan";

export type SkyWorldIsland = { id: string; name: string; weight: number };

/** Where the camera looks: kept across a world re-roll. */
export type SkyWorldView = { target: [number, number, number]; distance: number; focusId: string | null };

export type SkyWorldInfo = {
  seed: number;
  climates: Record<string, ClimateId>;
  setting: SkyWeatherSetting;
  weather: SkyWeatherKind;
};

export type SkyWorldOptions = {
  host: HTMLElement;
  islands: SkyWorldIsland[];
  labels: Map<string, HTMLElement>;
  /** Time of day: dawn, noon, golden or night. */
  direction: keyof typeof SKY_DIRECTIONS | string;
  paused: boolean;
  lowPower: boolean;
  visible?: boolean;
  /** World seed: climates and auto weather (default: a fixed seed). */
  seed?: number;
  weather?: SkyWeatherSetting;
  initialView?: SkyWorldView | null;
  /** Clock for the auto weather's date (tests pin it). */
  now?: () => Date;
  onOpen: (id: string) => void;
  onHover: (id: string | null) => void;
  onFailure: (reason: string) => void;
  onInfo?: (info: SkyWorldInfo) => void;
};

export type SkyWorld = {
  dispose: () => void;
  setPaused: (paused: boolean) => void;
  setLowPower: (lowPower: boolean) => void;
  setVisible: (visible: boolean) => void;
  /** Another time of day in place: no rebuild, the view stays. */
  setDirection: (direction: string) => void;
  setWeather: (setting: SkyWeatherSetting) => void;
  focus: (id: string | null) => void;
  reset: () => void;
  view: () => SkyWorldView;
  info: () => SkyWorldInfo;
  stats: () => Record<string, number | string>;
};

type BuiltIsland = {
  layout: LayoutIsland;
  plan: IslandPlan;
  climate: ClimateSpec;
  tone: GroundTone;
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
const NOON = SKY_DIRECTIONS.noon.palette;
const PHASES: SkyPhaseName[] = ["dawn", "noon", "golden", "night"];
/** Above this many islands, small ones skip villagers and animals. */
const CROWDED = 30;

/** The ground of an island for a palette: temperate keeps the palette's own
 * colours; other climates filter their noon colours by the time of day. */
function groundLook(palette: SkyPalette, tone: GroundTone, climate: ClimateSpec, shape: IslandShape): GroundLook {
  const look = paletteGround(palette, tone);
  const ground = phaseFilter(palette.grassLight, NOON.grassLight);
  const earth = phaseFilter(palette.earthA, NOON.earthA);
  const tint = (value: string, filter: THREE.Color) => new THREE.Color(value).multiply(filter);
  if (climate.ground) {
    look.grassLight = tint(climate.ground.light, ground);
    look.grassDark = tint(climate.ground.dark, ground);
    look.grassAlt = tint(climate.ground.alt, ground);
    look.altMix = climate.ground.altMix;
    look.path = tint(climate.ground.path, ground);
  }
  if (climate.cliff) {
    look.soil = tint(climate.cliff.soil, earth);
    look.earthA = tint(climate.cliff.earthA, earth);
    look.earthB = tint(climate.cliff.earthB, earth);
    look.rockDeep = tint(climate.cliff.rockDeep, earth);
  }
  if (climate.cap) {
    look.cap = tint(climate.cap.color, ground);
    look.capRim = climate.cap.rim;
    look.capAbove = shape.coverLine(climate.cap.cover);
  }
  if (climate.slope) {
    look.slope = tint(climate.slope.color, earth);
    look.slopeBelow = climate.slope.below;
  }
  if (climate.beach) {
    look.beach = tint(climate.beach.color, ground);
    look.beachFrom = climate.beach.from;
  }
  if (climate.strata) {
    look.strata = tint(climate.strata.color, earth);
    look.strataStrength = climate.strata.strength;
  }
  if (climate.vein) {
    look.vein = new THREE.Color(climate.vein.color);
    look.veinStrength = 1;
    look.veinGlow = climate.vein.glow;
  }
  if (climate.flecks) {
    look.fleckA = tint(climate.flecks.a, ground);
    look.fleckB = tint(climate.flecks.b, ground);
    look.fleck = climate.flecks.density;
  }
  if (climate.film) {
    look.film = tint(climate.film.color, phaseFilter(palette.water, NOON.water));
    look.filmStrength = climate.film.strength;
  }
  look.dunes = climate.dunes;
  return look;
}

export async function createSkyWorld(options: SkyWorldOptions): Promise<SkyWorld> {
  let direction = SKY_DIRECTIONS[options.direction] ?? SKY_DIRECTIONS.noon;
  let phase: SkyPhaseName = PHASES.includes(options.direction as SkyPhaseName) ? options.direction as SkyPhaseName : "noon";
  let palette = direction.palette;
  const seed = (options.seed ?? 1) >>> 0;
  let weatherSetting: SkyWeatherSetting = options.weather ?? "auto";
  const now = options.now ?? (() => new Date());
  resetSharedUniforms();
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
  const fog = new THREE.Fog(palette.fog, palette.fogNear, palette.fogFar);
  scene.fog = fog;
  const disposables: Array<{ dispose: () => void }> = [];
  const track = <T extends { dispose: () => void }>(item: T) => (disposables.push(item), item);
  const kit = buildKit();
  track({ dispose: () => disposeKit(kit) });

  // Light: a soft sky/ground fill and one sun; toon steps do the rest.
  const sunDirection = new THREE.Vector3();
  const hemisphere = new THREE.HemisphereLight(palette.ambientSky, palette.ambientGround, palette.ambientIntensity);
  scene.add(hemisphere);
  const sun = new THREE.DirectionalLight(palette.sunColor, palette.sunIntensity);
  sun.castShadow = !options.lowPower;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.05;
  sun.shadow.radius = 3;
  scene.add(sun, sun.target);

  const skyGeometry = track(new THREE.SphereGeometry(900, 32, 16));
  const skyMaterial = track(skyDomeMaterial(palette));
  const sky = new THREE.Mesh(skyGeometry, skyMaterial);
  sky.frustumCulled = false;
  sky.renderOrder = -10;
  scene.add(sky);

  // Kit materials: one per part kind; leaves and grass sway in the wind,
  // crystals glow, floating shards bob.
  const kitMaterials = new Map<string, THREE.Material>();
  const kitMaterial = (model: KitModel, partIndex: number) => {
    const part = model.parts[partIndex];
    const key = `${model.name}:${partIndex}`;
    if (!kitMaterials.has(key)) {
      const material = toonMaterial();
      const legacy = model.name.startsWith("grass") ? 0.08 : part.role === "tint" && !model.name.startsWith("rock") && model.name !== "mushroom" ? 0.05 : 0;
      const swayFraction = model.sway === undefined ? legacy : part.role === "tint" || model.swayAll ? model.sway : 0;
      kitShader(material, { height: model.height, sway: swayFraction * model.height, bob: model.bob, glow: model.glow && part.role === "tint" });
      kitMaterials.set(key, track(material));
    }
    return kitMaterials.get(key)!;
  };

  // Islands and their climates: neighbours avoid sharing one.
  const layout = layoutIslands(
    options.islands.map(item => ({ id: item.id, weight: item.weight })),
    { pitch: direction.pitch, heightSpread: direction.heightSpread, aspect: direction.aspect }
  );
  const climates = assignClimates(options.islands, seed, layoutNeighbours(layout));
  const crowded = options.islands.length > CROWDED;
  const quality = options.lowPower ? 0.7 : 1;
  const built: BuiltIsland[] = [];
  const pickGeometry = track(new THREE.CylinderGeometry(1, 0.55, 1, 20));
  const pickMaterial = track(new THREE.MeshBasicMaterial({ visible: false }));
  const waterGeometryCache: THREE.BufferGeometry[] = [];
  const waterFilter = () => phaseFilter(palette.water, NOON.water);
  const water = track(waterMaterial(palette));
  const lagoon = track(waterMaterial(palette, false, "lagoon", waterFilter()));
  const ice = track(waterMaterial(palette, false, "ice", phaseFilter(palette.grassLight, NOON.grassLight)));
  const lava = track(lavaMaterial());
  const falls = track(waterfallMaterial(palette));
  const lavaFalls = track(waterfallMaterial(palette, true));
  const pondMaterial = (kind: IslandPlan["water"]) => kind === "lagoon" ? lagoon : kind === "ice" ? ice : kind === "lava" ? lava : water;
  type Tint = THREE.Color | (() => THREE.Color);
  type Bucket = { parts: Array<{ geometry: THREE.BufferGeometry; material: THREE.Material; matrix: THREE.Matrix4; tinted: boolean }>; matrices: THREE.Matrix4[]; tints: Tint[]; small: boolean; floating: boolean };
  const instanceBuckets = new Map<string, Bucket>();
  const walkers: Walker[] = [];
  const vents: THREE.Vector3[] = [];
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
        small: model.small || /^(grass|flower|mushroom)/.test(model.name),
        floating: Boolean(model.bob)
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
      small: false,
      floating: false
    };
    instanceBuckets.set(key, bucket);
    return { bucket, height: template.height, footprint: template.footprint };
  };

  const themes = assignThemes(options.islands);
  options.islands.forEach((item, index) => {
    const position = layout[index];
    const theme = themes.get(item.id) ?? "meadow";
    const climateId = climates.get(item.id) ?? "temperate";
    const climate = CLIMATES[climateId];
    const plan = planIsland(position.radius, position.seed, theme, climate);
    const origin = new THREE.Vector3(position.x, position.y, position.z);
    const tone = themeTone(theme);
    const material = track(terrainMaterial(palette, tone, plan.shape.paths, groundLook(palette, tone, climate, plan.shape)));
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
      const surface = new THREE.Mesh(pondGeometry, pondMaterial(plan.water));
      surface.position.set(origin.x + pond.x, origin.y + plan.shape.pondLevel(pond), origin.z + pond.z);
      surface.receiveShadow = plan.water !== "lava";
      scene.add(surface);
    }

    // The pond spills over the rim: a ribbon of falling water (or lava)
    // down the cliff.
    if (plan.waterfall && plan.shape.ponds.length) {
      const fall = plan.waterfall;
      const pond = plan.shape.ponds[0];
      const top = origin.y + plan.shape.pondLevel(pond);
      const drop = plan.shape.cliff + plan.shape.bottomDepth * 0.95;
      const outward = new THREE.Vector3(Math.cos(fall.angle), 0, Math.sin(fall.angle));
      const lipX = fall.x + outward.x * 0.12, lipZ = fall.z + outward.z * 0.12;
      const channelStartX = pond.x + outward.x * pond.radius * 0.85;
      const channelStartZ = pond.z + outward.z * pond.radius * 0.85;
      const geometry = spillwayGeometry(new THREE.Vector3(channelStartX, 0, channelStartZ), new THREE.Vector3(lipX, 0, lipZ), fall.width, plan.water === "lava" ? drop * 0.55 : drop);
      waterGeometryCache.push(geometry);
      const sheet = new THREE.Mesh(geometry, plan.water === "lava" ? lavaFalls : falls);
      sheet.position.set(origin.x, top + 0.006, origin.z);
      sheet.renderOrder = 2;
      scene.add(sheet);
    }

    // A volcano's lava lake and the smoke above it.
    if (plan.crater) {
      const lakeGeometry = new THREE.CircleGeometry(plan.crater.radius, 28);
      lakeGeometry.rotateX(-Math.PI / 2);
      waterGeometryCache.push(lakeGeometry);
      const lake = new THREE.Mesh(lakeGeometry, lava);
      lake.position.set(origin.x + plan.crater.x, origin.y + plan.crater.y, origin.z + plan.crater.z);
      scene.add(lake);
    }
    for (const [x, y, z] of plan.vents) vents.push(new THREE.Vector3(origin.x + x, origin.y + y, origin.z + z));

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

    // Tufts a shade deeper than the ground they grow from, in this light.
    const tuft = () => {
      const look = material.userData.uniforms.uGrassDark.value as THREE.Color;
      return look.clone().multiplyScalar(0.92);
    };
    for (const placement of plan.placements) {
      if (options.lowPower && /^(grass|rice)/.test(placement.model) && placement.x * 7 % 2 > 1) continue;
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
      const y = ground - placement.sink * entry.height * scale + (placement.lift ?? 0);
      entry.bucket.matrices.push(new THREE.Matrix4().compose(
        new THREE.Vector3(origin.x + placement.x, origin.y + y, origin.z + placement.z),
        new THREE.Quaternion().setFromAxisAngle(UP, placement.yaw),
        new THREE.Vector3(scale, scale, scale)
      ));
      entry.bucket.tints.push(placement.tint === "grass" ? tuft : new THREE.Color(placement.tint ?? "#ffffff"));
    }

    const lively = !crowded || position.radius >= 5;
    if (lively) {
      for (const [walkerIndex, route] of plan.walkers.entries()) {
        const walker = createWalker(library.villager, plan.shape, origin, route, plan.buildingScale * 2.05, position.seed + walkerIndex);
        if (walker) {
          scene.add(walker.object);
          walkers.push(walker);
        }
      }
    }
    const openGround = (x: number, z: number) =>
      plan.shape.normalizedDistance(x, z) < 0.78 && !plan.shape.isInsidePond(x, z, 0.5) && plan.shape.pathWeight(x, z) < 0.2 &&
      plan.shape.featureWeight(x, z) < 0.3 &&
      plan.shape.pads.every(pad => Math.hypot(x - pad.x, z - pad.z) > pad.radius + 0.6);
    for (const animal of lively ? plan.animals : []) {
      const gltf = library.animals.get(animal.name);
      if (!gltf) continue;
      const length = (animal.name === "Pug" ? 0.75 : animal.name === "Horse" || animal.name === "Cow" ? 1.7 : 1.15) * plan.buildingScale / 0.45;
      const walker = createAnimal(gltf, plan.shape, origin, [animal.x, animal.z], position.radius * 0.28, length, animal.seed, openGround);
      scene.add(walker.object);
      walkers.push(walker);
    }

    const cliff = plan.shape.cliff;
    const frontRim = plan.shape.rimRadius(Math.PI / 2);
    const surfaceY = origin.y + plan.shape.heightAt(0, 0);
    const buildingCrown = plan.buildings.length ? Math.max(...plan.buildings.map(building => (building.model === "Tower" ? 13 : 9) * building.scale)) : 3.2 * plan.buildingScale / 0.45;
    built.push({
      layout: position,
      plan,
      climate,
      tone,
      terrain,
      material,
      pick,
      highlight: 0,
      topY: box.max.y,
      tipAnchor: new THREE.Vector3(origin.x, box.min.y + (box.max.y - box.min.y) * 0.04, origin.z),
      surfaceY,
      // A mountain or volcano is the island's crown too.
      crown: Math.max(buildingCrown, origin.y + plan.shape.summit() - surfaceY + 0.6),
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
  let farMaterial: THREE.MeshLambertMaterial | null = null;
  if (!options.lowPower && built.length) {
    const random = seededRandom(hashString(`far:${built.length}`));
    farMaterial = track(terrainMaterial(palette, themeTone("meadow")));
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
  const instanced: Array<{ mesh: THREE.InstancedMesh; bucket: Bucket; tinted: boolean }> = [];
  const resolveTint = (tint: Tint) => (typeof tint === "function" ? tint() : tint);
  for (const bucket of instanceBuckets.values()) {
    for (const part of bucket.parts) {
      const mesh = new THREE.InstancedMesh(part.geometry, part.material, bucket.matrices.length);
      bucket.matrices.forEach((matrix, index) => {
        mesh.setMatrixAt(index, matrix.clone().multiply(part.matrix));
        if (part.tinted) mesh.setColorAt(index, resolveTint(bucket.tints[index]));
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.castShadow = !options.lowPower && !bucket.small;
      mesh.receiveShadow = !bucket.small && !bucket.floating;
      mesh.computeBoundingSphere();
      // Floating shards bob in the shader beyond their static bounds.
      if (bucket.floating && mesh.boundingSphere) mesh.boundingSphere.radius += 2;
      scene.add(mesh);
      instanced.push({ mesh, bucket, tinted: part.tinted });
    }
  }
  const retint = () => {
    for (const { mesh, bucket, tinted } of instanced) {
      if (!tinted || !bucket.tints.some(tint => typeof tint === "function")) continue;
      bucket.tints.forEach((tint, index) => {
        if (typeof tint === "function") mesh.setColorAt(index, tint());
      });
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  };

  // Cartoon clouds: big soft banks below the islands and a few small ones
  // drifting at island height between them.
  const size = bounds.getSize(new THREE.Vector3());
  const center = bounds.getCenter(new THREE.Vector3());
  const cloudMat = track(cloudMaterial(palette));
  const cloudShapes = [1, 2, 3, 4].map(cloudSeed => track(cloudGeometry(cloudSeed)));
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

  // Smoke from every volcano: one point cloud.
  const smoke: Smoke | null = vents.length ? createSmoke(vents, Math.max(0.6, Math.min(1.4, size.x / 90)), palette, options.lowPower) : null;
  if (smoke) {
    scene.add(smoke.object);
    track(smoke);
  }

  const flock: Flock | null = library.gull && built.length
    ? createFlocks(library.gull, bounds, options.lowPower ? 5 : 9, 7, 1.5)
    : null;
  if (flock) scene.add(flock.mesh);

  // Weather: petals take the garden blossom, or autumn leaves where the
  // world has autumn woods.
  const climateList = built.map(island => island.climate.id);
  const hasAutumn = climateList.includes("autumn");
  const weather: Weather = createWeather(scene, bounds, palette, resolveWeather(weatherSetting, seed, now(), phase, climateList), {
    targets: { sun, hemisphere, fog, sky: skyMaterial, clouds: cloudMat },
    seed,
    lowPower: options.lowPower,
    reducedMotion: () => reduced.matches,
    petals: hasAutumn ? ["#f2a03c", "#f4a6c0", "#e8743a"] : ["#f4a6c0", "#ffffff", "#f7c3d4"]
  });
  track(weather);

  // Shadow camera tightly around the islands.
  const shadowRadius = Math.max(size.x, size.z) * 0.62 + 6;
  Object.assign(sun.shadow.camera, { left: -shadowRadius, right: shadowRadius, top: shadowRadius, bottom: -shadowRadius, near: 1, far: shadowRadius * 4.5 });
  sun.shadow.camera.updateProjectionMatrix();

  /** Everything that follows the time of day, applied in place. */
  const applyPalette = (next: SkyPalette) => {
    palette = next;
    sunDirection.setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - next.sunElevation), THREE.MathUtils.degToRad(next.sunAzimuth));
    SHARED_UNIFORMS.uSunDirection.value.copy(sunDirection);
    SHARED_UNIFORMS.uGlow.value = 0.3 + next.night * 0.7;
    sun.color.set(next.sunColor);
    sun.position.copy(center).addScaledVector(sunDirection, shadowRadius * 2.2);
    sun.target.position.copy(center);
    sun.target.updateMatrixWorld();
    hemisphere.color.set(next.ambientSky);
    hemisphere.groundColor.set(next.ambientGround);
    setSkyDomePalette(skyMaterial, next);
    for (const island of built) setTerrainGround(island.material, groundLook(next, island.tone, island.climate, island.plan.shape));
    if (farMaterial) setTerrainGround(farMaterial, paletteGround(next, themeTone("meadow")));
    setWaterColors(water, waterColors(next, "water"));
    setWaterColors(lagoon, waterColors(next, "lagoon", phaseFilter(next.water, NOON.water)));
    setWaterColors(ice, waterColors(next, "ice", phaseFilter(next.grassLight, NOON.grassLight)));
    setWaterfallColor(falls, next);
    library.setPalette(next);
    smoke?.setPalette(next);
    retint();
    weather.setPalette(next);
  };
  applyPalette(palette);

  // Camera: framed on the archipelago, pitched down; pan and zoom only.
  const camera = new THREE.PerspectiveCamera(direction.fov, 1, 0.5, 2000);
  const pitch = THREE.MathUtils.degToRad(direction.pitch);
  const home = { target: new THREE.Vector3(center.x, bounds.min.y + size.y * 0.55, center.z), distance: 60 };
  const view = { target: home.target.clone(), distance: 60 };
  const goal = { target: home.target.clone(), distance: 60 };
  let width = 1, height = 1, minDistance = 12, maxDistance = 200;
  let safeLeft = 0, safeTop = 0;
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
    const top = Math.min(height < 760 ? 0.58 : 0.62, 1 - 2 * (safeTop + 18) / height);
    const bottom = height < 760 ? 0.62 : 0.68;
    const left = -1 + 2 * (safeLeft + 24) / width, right = 1 - 48 / width;
    let low = 8, high = 1500;
    for (let iteration = 0; iteration < 40; iteration++) {
      const middle = (low + high) / 2;
      view.target.copy(home.target);
      view.distance = middle;
      applyCamera();
      const fits = points.every(point => {
        const projected = point.clone().project(camera);
        return projected.x > left && projected.x < right && projected.y < top && projected.y > -bottom;
      });
      if (fits) high = middle; else low = middle;
    }
    home.distance = high;
    placeFarIslands(home.target.clone().addScaledVector(viewDirection, high));
    minDistance = Math.max(10, Math.min(...built.map(island => island.layout.radius)) * 2.6);
    maxDistance = home.distance * 1.6;
    // Fog is in world units: a big archipelago framed from far away would
    // otherwise disappear into the haze. Start it past the framed islands.
    const near = Math.max(palette.fogNear, high + size.z * 0.5);
    weather.setFogRange(near, Math.max(palette.fogFar, near + size.z * 1.5 + 200));
    weather.setFrame(center, size, high);
  };

  const resize = () => {
    if (!visible || !options.host.clientWidth || !options.host.clientHeight) return;
    width = options.host.clientWidth;
    height = options.host.clientHeight;
    safeLeft = Number.parseFloat(getComputedStyle(options.host).getPropertyValue("--home-rail")) || 0;
    const hostTop = options.host.getBoundingClientRect().top;
    const chrome = options.host.closest(".sky-islands")?.querySelectorAll(".sky-heading, .sky-controls");
    safeTop = Math.max(0, ...Array.from(chrome ?? []).map(element => element.getBoundingClientRect().bottom - hostTop + 12));
    renderer.setPixelRatio(pixelRatio());
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    // Keep the sky full bleed; shift only the content projection away from
    // the floating navigation rail, which is not usable scene space.
    camera.setViewOffset(width, height, -safeLeft / 2, 0, width, height);
    camera.updateProjectionMatrix();
    updatePointScale();
    // Stay on the overview if the user has not moved away from it.
    const atHome = !initialized || (goal.target.distanceTo(home.target) < 0.01 && Math.abs(goal.distance - home.distance) < 0.01);
    measureLabels();
    fitHome();
    if (atHome && !pendingView) {
      goal.target.copy(home.target);
      goal.distance = home.distance;
    }
    view.target.copy(goal.target);
    view.distance = goal.distance;
    applyCamera();
    requestDraw();
  };
  const updatePointScale = () => {
    const pixels = height * renderer.getPixelRatio();
    weather.setViewport(pixels, direction.fov);
    if (smoke) setPointScale(smoke.object.material as THREE.ShaderMaterial, pixels, direction.fov);
  };

  // Resolution: native up to a 4K pixel budget, scaled down adaptively when
  // this device cannot hold the target frame rate.
  let resolutionScale = 1;
  const pixelRatio = () => {
    const native = Math.min(window.devicePixelRatio || 1, lowPower ? 1 : 2);
    const budget = Math.sqrt(8_300_000 / Math.max(1, width * height));
    return Math.max(0.6, Math.min(native, budget) * resolutionScale);
  };

  // State and loop.
  let disposed = false, failed = false, initialized = false;
  let paused = options.paused, lowPower = options.lowPower;
  let visible = options.visible ?? true;
  let intersecting = true;
  let raf = 0, lastFrame = 0, clock = 0, frames = 0, dirty = true;
  let frameTimes: number[] = [];
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  const animating = () => !paused && !reduced.matches;
  let hovered: string | null = null, focusId: string | null = null;
  let pointerDown = false, moved = false, downX = 0, downY = 0, lastX = 0, lastY = 0, lastInteraction = 0;
  // A re-rolled world opens where the old one was looking.
  let pendingView = options.initialView ?? null;
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const projected = new THREE.Vector3();
  const pickTargets = built.map(island => island.pick);

  function requestDraw() {
    dirty = true;
    if (!raf && visible && intersecting && !disposed && !failed && !document.hidden) raf = requestAnimationFrame(draw);
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
      let labelSize = labelSizes.get(island.layout.id);
      if (!labelSize || !labelSize.width) {
        // Labels are hidden until the scene is ready; measure once they show.
        labelSize = { width: label.offsetWidth, height: label.offsetHeight };
        labelSizes.set(island.layout.id, labelSize);
      }
      const measured = labelSize;
      // Front edge first; then below the rock tip; then above the crown.
      const o = island.terrain.position;
      const candidates = [
        toScreen(island.labelAnchor),
        toScreen(island.tipAnchor),
        (() => {
          const above = toScreen(scratch.set(o.x, island.surfaceY + island.crown, o.z));
          return { ...above, y: above.y - measured.height - 6 };
        })()
      ];
      const fitsChrome = (candidate: typeof candidates[number]) => candidate.x - measured.width / 2 > safeLeft + 8 && candidate.x + measured.width / 2 < width - 8 && candidate.y > safeTop && candidate.y + measured.height < height - 8;
      const anchor = candidates.find(candidate => fitsChrome(candidate) && !blocksIsland(shapes, island.layout.id, candidate.x - measured.width / 2, candidate.y, measured.width, measured.height)) ?? candidates[0];
      let shown = anchor.z < 1 && fitsChrome(anchor);
      const x = anchor.x;
      let y = anchor.y;
      const rect = () => ({ left: x - measured.width / 2 - 4, right: x + measured.width / 2 + 4, top: y - 3, bottom: y + measured.height + 3 });
      for (let attempt = 0; shown && attempt < 3; attempt++) {
        const box = rect();
        const blocker = placedRects.find(other => box.left < other.right && box.right > other.left && box.top < other.bottom && box.bottom > other.top);
        if (!blocker) break;
        if (attempt === 2 || blocker.bottom - box.top > measured.height * 1.6) shown = false;
        else y = blocker.bottom + 3;
      }
      if (shown) placedRects.push(rect());
      label.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, 0)`;
      label.style.visibility = shown ? "visible" : "hidden";
    }
  }

  function draw(now: number) {
    raf = 0;
    if (disposed || failed || !visible || !intersecting || document.hidden) {
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
    const weatherBusy = weather.update(clock, delta, view.target, animating());
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
    host.dataset.weather = weather.kind();
    host.dataset.weatherCalls = String(weather.drawCalls());
    host.dataset.flash = weather.flash().toFixed(2);
    initialized = true;
    if (animating() || moving || highlighting || (weatherBusy && !reduced.matches)) raf = requestAnimationFrame(draw);
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
      updatePointScale();
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
    clampGoal();
  };
  const clampGoal = () => {
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
  // A move between displays can change DPR without changing the CSS bounds.
  let resolutionQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
  const onResolutionChange = () => {
    resolutionQuery.removeEventListener("change", onResolutionChange);
    resolutionQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    resolutionQuery.addEventListener("change", onResolutionChange);
    resize();
  };
  resolutionQuery.addEventListener("change", onResolutionChange);
  // Fullscreen changes the floating rail without resizing the full-bleed
  // canvas; re-read safe areas when the application shell class changes.
  const shellObserver = new MutationObserver(resize);
  const shell = options.host.closest(".shell");
  if (shell) shellObserver.observe(shell, { attributes: true, attributeFilter: ["class"] });
  const intersection = new IntersectionObserver(entries => {
    intersecting = entries.some(entry => entry.isIntersecting);
    if (intersecting && visible) requestDraw();
    else {
      cancelAnimationFrame(raf);
      raf = 0;
      lastFrame = 0;
    }
  });
  intersection.observe(options.host);
  resize();
  goal.distance = view.distance = home.distance;
  if (pendingView) {
    const [x, y, z] = pendingView.target;
    if ([x, y, z, pendingView.distance].every(Number.isFinite)) {
      goal.target.set(x, y, z);
      goal.distance = THREE.MathUtils.clamp(pendingView.distance, minDistance, maxDistance);
      clampGoal();
      focusId = pendingView.focusId && built.some(island => island.layout.id === pendingView!.focusId) ? pendingView.focusId : null;
      view.target.copy(goal.target);
      view.distance = goal.distance;
    }
    pendingView = null;
  }
  applyCamera();
  requestDraw();

  const climateRecord = () => Object.fromEntries(built.map(island => [island.layout.id, island.climate.id])) as Record<string, ClimateId>;
  const info = (): SkyWorldInfo => ({ seed, climates: climateRecord(), setting: weatherSetting, weather: weather.kind() });
  options.host.dataset.climates = built.map(island => island.climate.id).join(",");
  const resolveAndApplyWeather = (instant: boolean) => {
    const kind = resolveWeather(weatherSetting, seed, now(), phase, climateList);
    if (kind !== weather.kind()) weather.setKind(kind, instant || !animating());
    options.onInfo?.(info());
  };
  queueMicrotask(() => {
    if (!disposed) options.onInfo?.(info());
  });

  return {
    setVisible(value) {
      visible = value;
      lastFrame = 0;
      if (!value) {
        cancelAnimationFrame(raf);
        raf = 0;
        pointerDown = false;
      } else {
        resize();
        requestDraw();
      }
    },
    setPaused(value) {
      paused = value;
      lastFrame = 0;
      requestDraw();
    },
    setLowPower(value) {
      lowPower = value;
      resolutionScale = 1;
      renderer.shadowMap.enabled = !value;
      sun.castShadow = !value;
      weather.setLowPower(value);
      smoke?.setLowPower(value);
      renderer.setPixelRatio(pixelRatio());
      renderer.setSize(width, height, false);
      updatePointScale();
      requestDraw();
    },
    setDirection(next) {
      const resolved = SKY_DIRECTIONS[next];
      if (!resolved || resolved === direction) return;
      direction = resolved;
      phase = PHASES.includes(next as SkyPhaseName) ? next as SkyPhaseName : phase;
      applyPalette(resolved.palette);
      fitHome();
      resolveAndApplyWeather(false);
      requestDraw();
    },
    setWeather(setting) {
      weatherSetting = setting;
      resolveAndApplyWeather(false);
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
    view() {
      return { target: [goal.target.x, goal.target.y, goal.target.z], distance: goal.distance, focusId };
    },
    info,
    stats() {
      const sorted = [...frameTimes].sort((a, b) => a - b);
      return {
        islands: built.length,
        climates: built.map(island => island.climate.id).join(","),
        weather: weather.kind(),
        weatherDrawCalls: weather.drawCalls(),
        drawCalls: renderer.info.render.calls,
        triangles: renderer.info.render.triangles,
        geometries: renderer.info.memory.geometries,
        textures: renderer.info.memory.textures,
        pixelRatio: Number(renderer.getPixelRatio().toFixed(2)),
        medianFrameMs: sorted.length ? Number(sorted[Math.floor(sorted.length / 2)].toFixed(1)) : 0,
        frames,
        ...(() => {
          const counts = { meshes: 0, instanced: 0, skinned: 0, groups: 0, points: 0 };
          scene.traverse(object => {
            if ((object as THREE.InstancedMesh).isInstancedMesh) counts.instanced++;
            else if ((object as THREE.SkinnedMesh).isSkinnedMesh) counts.skinned++;
            else if ((object as THREE.Mesh).isMesh) counts.meshes++;
            else if ((object as THREE.Points).isPoints) counts.points++;
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
      resolutionQuery.removeEventListener("change", onResolutionChange);
      shellObserver.disconnect();
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
      for (const { mesh } of instanced) mesh.dispose();
      for (const geometry of waterGeometryCache) geometry.dispose();
      for (const item of disposables) item.dispose();
      library.dispose();
      sun.shadow.map?.dispose();
      scene.clear();
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
      resetSharedUniforms();
    }
  };
}
