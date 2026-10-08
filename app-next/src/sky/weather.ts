// Archipelago-wide weather. One particle system (rain streaks, snowflakes or
// petals) whose positions come from time and a per-particle seed in the
// vertex shader, wrapped in a box around the camera target: no per-frame CPU
// work. One merged cloud deck for overcast skies. Rainbows, aurora and
// lightning live in the sky dome's shader. Weather also owns the light, fog
// and cloud tint multipliers, so a change of weather fades in smoothly.
// At most two draw calls: the particles and the deck. The frame update only
// eases numbers and writes uniforms; colours are parsed once per palette.
import * as THREE from "three";
import type { SkyWeatherKind } from "../skyScene";
import type { SkyPalette } from "./materials";
import { SHARED_UNIFORMS, cloudMaterial } from "./materials";
import { releaseAfterUpload } from "./memory";
import { hashString, seededRandom } from "./noise";

type Particles = "none" | "rain" | "snow" | "petals";

/** What a weather does to the scene; clear is all ones and zeros. */
type Look = {
  sun: number;
  hemi: number;
  /** Fog range multipliers and how far the fog greys toward overcast. */
  fogNear: number;
  fogFar: number;
  fogGrey: number;
  dim: number;
  cloudDark: number;
  lift: number;
  wind: number;
  rain: number;
  rainbow: number;
  aurora: number;
  deck: number;
  particles: number;
};

const LOOK_KEYS: Array<keyof Look> = ["sun", "hemi", "fogNear", "fogFar", "fogGrey", "dim", "cloudDark", "lift", "wind", "rain", "rainbow", "aurora", "deck", "particles"];

const CLEAR: Look = { sun: 1, hemi: 1, fogNear: 1, fogFar: 1, fogGrey: 0, dim: 0, cloudDark: 0, lift: 0, wind: 1, rain: 0, rainbow: 0, aurora: 0, deck: 0, particles: 0 };

const LOOKS: Record<SkyWeatherKind, Look> = {
  clear: CLEAR,
  cloudy: { ...CLEAR, sun: 0.8, hemi: 1.06, fogGrey: 0.22, dim: 0.22, cloudDark: 0.2, deck: 0.95, wind: 1.15 },
  rain: { ...CLEAR, sun: 0.66, hemi: 0.94, fogNear: 0.85, fogFar: 0.85, fogGrey: 0.38, dim: 0.34, cloudDark: 0.3, deck: 0.9, wind: 1.5, rain: 0.7, particles: 1 },
  storm: { ...CLEAR, sun: 0.42, hemi: 0.8, fogNear: 0.75, fogFar: 0.78, fogGrey: 0.55, dim: 0.58, cloudDark: 0.55, deck: 1, wind: 2.3, rain: 1, particles: 1 },
  snow: { ...CLEAR, sun: 0.86, hemi: 1.08, fogNear: 0.9, fogFar: 0.9, fogGrey: 0.25, dim: 0.2, cloudDark: 0.04, deck: 0.6, wind: 0.8, particles: 1 },
  fog: { ...CLEAR, sun: 0.82, hemi: 1.06, fogNear: 0.4, fogFar: 0.58, fogGrey: 0.3, dim: 0.12, lift: 9, deck: 0.45, wind: 0.6 },
  rainbow: { ...CLEAR, sun: 1.04, rainbow: 1, wind: 1.05 },
  petals: { ...CLEAR, wind: 1.3, particles: 1 },
  aurora: { ...CLEAR, aurora: 1, wind: 0.9 }
};

const PARTICLES: Record<SkyWeatherKind, Particles> = {
  clear: "none", cloudy: "none", rain: "rain", storm: "rain", snow: "snow", fog: "none", rainbow: "none", petals: "petals", aurora: "none"
};

/** Particle counts at normal quality; low power keeps 40%. */
const COUNTS: Record<Exclude<Particles, "none">, number> = { rain: 1800, snow: 900, petals: 260 };
const STORM_RAIN = 2600;

export type WeatherTargets = {
  sun: THREE.DirectionalLight;
  hemisphere: THREE.HemisphereLight;
  fog: THREE.Fog;
  sky: THREE.ShaderMaterial;
  clouds: THREE.ShaderMaterial;
};

export type WeatherOptions = {
  targets: WeatherTargets;
  seed: number;
  lowPower: boolean;
  /** Reduced motion: one still frame and no lightning. */
  reducedMotion: () => boolean;
  /** Petal colours: garden blossom, autumn leaves or both. */
  petals: string[];
  /** Scene time the world starts at (a woken world keeps its clock). */
  startTime?: number;
};

export type Weather = {
  kind: () => SkyWeatherKind;
  setKind: (kind: SkyWeatherKind, instant?: boolean) => void;
  setPalette: (palette: SkyPalette) => void;
  /** The fog range the camera framing wants before weather. */
  setFogRange: (near: number, far: number) => void;
  /** Home view distance: particle box and sizes follow the framing. */
  setFrame: (center: THREE.Vector3, size: THREE.Vector3, homeDistance: number) => void;
  setViewport: (pixelHeight: number, fov: number) => void;
  setLowPower: (lowPower: boolean) => void;
  /** Advance; returns true while a transition or flash still needs frames. */
  update: (time: number, delta: number, target: THREE.Vector3, animating: boolean) => boolean;
  drawCalls: () => number;
  /** Current lightning brightness (0..1), for diagnostics. */
  flash: () => number;
  dispose: () => void;
};

const PARTICLE_VERTEX = `
  attribute float aSeed;
  uniform float uTime;
  uniform float uWind;
  uniform vec3 uCenter;
  uniform vec3 uBox;
  uniform float uSize;
  uniform float uScale;
  uniform float uSpeed;
  uniform float uDrift;
  uniform float uWobble;
  uniform float uFlutter;
  uniform float uSpin;
  varying float vSeed;
  varying float vFade;
  varying float vAngle;
  varying float vPixels;
  #include <fog_pars_vertex>
  void main() {
    vSeed = aSeed;
    float t = uTime;
    float pace = 0.75 + 0.5 * fract(aSeed * 7.31);
    // World-anchored pattern wrapped into a box that follows the view, so
    // particles stay put while panning and never run out.
    vec3 travel = vec3(
      t * uDrift * uWind * pace + sin(t * uFlutter + aSeed * 40.0) * uWobble,
      -t * uSpeed * pace,
      cos(t * uFlutter * 0.7 + aSeed * 29.0) * uWobble * 0.7
    );
    vec3 origin = uCenter - uBox * 0.5;
    vec3 local = mod(position * uBox + travel - origin, uBox);
    vec3 world = origin + local;
    vec3 unit = local / uBox;
    vFade = smoothstep(0.0, 0.08, unit.y) * smoothstep(1.0, 0.86, unit.y)
      * smoothstep(0.0, 0.06, unit.x) * smoothstep(1.0, 0.94, unit.x)
      * smoothstep(0.0, 0.06, unit.z) * smoothstep(1.0, 0.94, unit.z);
    vAngle = aSeed * 6.2831 + t * uSpin * (fract(aSeed * 3.7) - 0.5) * 2.0;
    vec4 mvPosition = viewMatrix * vec4(world, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    float size = uSize * (0.7 + 0.6 * fract(aSeed * 13.7)) * uScale / max(1.0, -mvPosition.z);
    gl_PointSize = clamp(size, 1.0, 96.0);
    vPixels = gl_PointSize;
    #include <fog_vertex>
  }`;

const PARTICLE_FRAGMENT = `
  uniform float uKind;
  uniform float uOpacity;
  uniform float uWind;
  uniform vec3 uColor;
  uniform vec3 uPetalA;
  uniform vec3 uPetalB;
  uniform vec3 uPetalC;
  varying float vSeed;
  varying float vFade;
  varying float vAngle;
  varying float vPixels;
  #include <fog_pars_fragment>
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float alpha;
    vec3 colour = uColor;
    if (uKind < 0.5) {
      // Rain: a thin streak slanted by the wind, at least a pixel wide.
      vec2 dir = normalize(vec2(uWind * 0.22, 1.0));
      float along = dot(c, dir);
      float across = abs(c.x * dir.y - c.y * dir.x);
      float width = max(0.035, 0.75 / vPixels);
      alpha = (1.0 - smoothstep(width, width * 1.8, across)) * (1.0 - smoothstep(0.32, 0.48, abs(along))) * 0.55;
      colour *= 0.9 + 0.2 * (0.5 - along);
    } else if (uKind < 1.5) {
      // Snow: a soft round flake with a brighter core and a cool rim, so it
      // still reads against a pale daytime sky.
      float d = length(c);
      alpha = smoothstep(0.5, 0.22, d);
      colour = mix(colour * vec3(0.72, 0.8, 0.92), colour, smoothstep(0.42, 0.24, d));
      colour = mix(colour, vec3(1.0), smoothstep(0.3, 0.0, d) * 0.4);
      alpha *= 0.88;
    } else {
      // Petals and leaves: a tumbling ellipse with a darker middle rib.
      float s = sin(vAngle), k = cos(vAngle);
      vec2 r = vec2(c.x * k - c.y * s, c.x * s + c.y * k);
      float squash = 0.45 + 0.4 * abs(sin(vAngle * 1.7));
      float d = length(r / vec2(0.46, 0.46 * squash));
      alpha = 1.0 - smoothstep(0.85, 1.0, d);
      float pick = fract(vSeed * 17.0);
      colour = pick < 0.34 ? uPetalA : pick < 0.67 ? uPetalB : uPetalC;
      colour *= 0.88 + 0.22 * smoothstep(-0.2, 0.3, r.y) - 0.12 * (1.0 - smoothstep(0.0, 0.06, abs(r.x)));
    }
    alpha *= vFade * uOpacity;
    if (alpha < 0.01) discard;
    gl_FragColor = vec4(colour, alpha);
    #include <colorspace_fragment>
    #include <fog_fragment>
  }`;

function particleGeometry(count: number, seed: number) {
  const random = seededRandom(seed);
  const positions = new Float32Array(count * 3);
  const seeds = new Float32Array(count);
  for (let index = 0; index < count; index++) {
    positions[index * 3] = random();
    positions[index * 3 + 1] = random();
    positions[index * 3 + 2] = random();
    seeds[index] = random();
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 1));
  // Positions are wrapped in the shader: never cull.
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);
  return geometry;
}

/** Merged billboard clouds: corners carry their sheet's centre and size. */
function deckGeometry(slots: Array<{ center: THREE.Vector3; size: [number, number]; seed: number }>) {
  const positions: number[] = [], uvs: number[] = [], centers: number[] = [], sizes: number[] = [], seeds: number[] = [], indices: number[] = [];
  slots.forEach((slot, index) => {
    const corners: Array<[number, number, number, number]> = [[-4, -1.9, 0, 0], [4, -1.9, 1, 0], [4, 1.9, 1, 1], [-4, 1.9, 0, 1]];
    for (const [x, y, u, v] of corners) {
      positions.push(x, y, 0);
      uvs.push(u, v);
      centers.push(slot.center.x, slot.center.y, slot.center.z);
      sizes.push(slot.size[0], slot.size[1]);
      seeds.push(slot.seed);
    }
    const base = index * 4;
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setAttribute("aCenter", new THREE.Float32BufferAttribute(centers, 3));
  geometry.setAttribute("aSize", new THREE.Float32BufferAttribute(sizes, 2));
  geometry.setAttribute("aCloudSeed", new THREE.Float32BufferAttribute(seeds, 1));
  geometry.setIndex(indices);
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);
  return geometry;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export function createWeather(scene: THREE.Scene, bounds: THREE.Box3, palette: SkyPalette, kind: SkyWeatherKind, options: WeatherOptions): Weather {
  const { targets } = options;
  let currentPalette = palette;
  let currentKind: SkyWeatherKind = kind;
  let lowPower = options.lowPower;
  const look: Look = { ...LOOKS[kind] };
  let goal: Look = LOOKS[kind];
  const fogRange = { near: palette.fogNear, far: palette.fogFar };

  // Particles: one geometry sized for the heaviest weather, one material.
  const maxCount = STORM_RAIN;
  const particleGeo = particleGeometry(maxCount, hashString(`particles:${options.seed}`));
  const petalColors = (options.petals.length ? options.petals : ["#f4a6c0", "#ffffff", "#f7c3d4"]).map(value => new THREE.Color(value));
  const particleMaterial = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    fog: true,
    uniforms: {
      ...THREE.UniformsLib.fog,
      uTime: SHARED_UNIFORMS.uTime,
      uWind: SHARED_UNIFORMS.uWind,
      uCenter: { value: new THREE.Vector3() },
      uBox: { value: new THREE.Vector3(100, 60, 100) },
      uSize: { value: 1 },
      uScale: { value: 800 },
      uSpeed: { value: 1 },
      uDrift: { value: 0 },
      uWobble: { value: 0 },
      uFlutter: { value: 0 },
      uSpin: { value: 0 },
      uKind: { value: 0 },
      uOpacity: { value: 0 },
      uColor: { value: new THREE.Color(1, 1, 1) },
      uPetalA: { value: petalColors[0] },
      uPetalB: { value: petalColors[1 % petalColors.length] },
      uPetalC: { value: petalColors[2 % petalColors.length] }
    },
    vertexShader: PARTICLE_VERTEX,
    fragmentShader: PARTICLE_FRAGMENT
  });
  const particles = new THREE.Points(particleGeo, particleMaterial);
  particles.frustumCulled = false;
  particles.renderOrder = 3;
  scene.add(particles);

  // Cloud deck: banks behind and between the islands.
  const size = bounds.getSize(new THREE.Vector3());
  const center = bounds.getCenter(new THREE.Vector3());
  const random = seededRandom(hashString(`deck:${options.seed}`));
  // Three tiers: a far, high bank across the top of the view, banks just
  // behind the islands, and puffs drifting between them.
  const slots = Array.from({ length: 22 }, (_, index) => {
    const tier = index % 3;
    const scale = tier === 0 ? 8 + random() * 5 : tier === 1 ? 5 + random() * 4 : 2.4 + random() * 2.2;
    const x = center.x + (random() - 0.5) * size.x * (tier === 0 ? 2 : tier === 1 ? 1.6 : 1.2);
    const y = tier === 0 ? bounds.max.y + 4 + random() * 14 : tier === 1 ? bounds.max.y - 4 + random() * 10 : bounds.min.y + size.y * (0.25 + random() * 0.5);
    const z = tier === 0 ? bounds.min.z - 25 - random() * 45 : tier === 1 ? bounds.min.z - 2 - random() * 16 : center.z + (random() - 0.5) * size.z * 1.1;
    return { center: new THREE.Vector3(x, y, z), size: [scale, scale * 0.78] as [number, number], seed: 20 + index };
  });
  const deckGeo = deckGeometry(slots);
  // Both are built for this world only; the GPU keeps them after upload.
  releaseAfterUpload(particleGeo);
  releaseAfterUpload(deckGeo);
  const deckMaterial = cloudMaterial(palette, true);
  const deck = new THREE.Mesh(deckGeo, deckMaterial);
  deck.frustumCulled = false;
  deck.renderOrder = 1;
  scene.add(deck);

  // Lightning: a double flash every 6-14 s of scene time (storm only).
  const flashRandom = seededRandom(hashString(`flash:${options.seed}`));
  const startTime = options.startTime ?? 0;
  let nextFlash = startTime + 3 + flashRandom() * 5, flashAt = -100, boltAzimuth = 0, boltSeed = 0, lastFlash = 0;

  // Colours parsed once per palette, never in the frame loop.
  const GREY_DAY = new THREE.Color("#9aa6b2"), GREY_NIGHT = new THREE.Color("#2a3550");
  const CLOUD_DAY = new THREE.Color("#b9c3cd"), CLOUD_NIGHT = new THREE.Color("#3a4560");
  const SHADE_DAY = new THREE.Color("#7d8896"), SHADE_NIGHT = new THREE.Color("#1a2235");
  const paletteFog = new THREE.Color(), paletteSkyBelow = new THREE.Color(), paletteCloud = new THREE.Color(), paletteCloudShade = new THREE.Color();
  const readPalette = (p: SkyPalette) => {
    paletteFog.set(p.fog);
    paletteSkyBelow.set(p.skyBelow);
    paletteCloud.set(p.cloud);
    paletteCloudShade.set(p.cloudShade);
  };
  readPalette(palette);
  const scratch = new THREE.Color();
  const cloudLight = new THREE.Color(), cloudShade = new THREE.Color();
  // Whether the current look has been written to the scene at all.
  let applied = false;

  const particleKind = () => PARTICLES[currentKind];
  const configureParticles = () => {
    const type = particleKind();
    const uniforms = particleMaterial.uniforms;
    particles.visible = type !== "none";
    if (type === "none") return;
    const full = currentKind === "storm" ? STORM_RAIN : COUNTS[type];
    particleGeo.setDrawRange(0, Math.max(1, Math.round(full * (lowPower ? 0.4 : 1))));
    uniforms.uKind.value = type === "rain" ? 0 : type === "snow" ? 1 : 2;
    const night = currentPalette.night;
    if (type === "rain") uniforms.uColor.value.set(night ? "#9fb4d8" : "#e4eef8");
    else if (type === "snow") uniforms.uColor.value.set(night ? "#dfe8f7" : "#ffffff");
  };

  let home = 120;
  const frameParticles = () => {
    const type = particleKind();
    const uniforms = particleMaterial.uniforms;
    const box = uniforms.uBox.value as THREE.Vector3;
    box.set(Math.max(60, home * 1.25), Math.max(40, home * 0.7), Math.max(60, home * 1.15));
    if (type === "rain") {
      uniforms.uSize.value = home * (currentKind === "storm" ? 0.016 : 0.013);
      uniforms.uSpeed.value = home * (currentKind === "storm" ? 1.25 : 0.95);
      uniforms.uDrift.value = home * 0.05;
      uniforms.uWobble.value = 0;
      uniforms.uFlutter.value = 0;
      uniforms.uSpin.value = 0;
    } else if (type === "snow") {
      uniforms.uSize.value = home * 0.0055;
      uniforms.uSpeed.value = home * 0.05;
      uniforms.uDrift.value = home * 0.02;
      uniforms.uWobble.value = home * 0.012;
      uniforms.uFlutter.value = 0.6;
      uniforms.uSpin.value = 0;
    } else if (type === "petals") {
      uniforms.uSize.value = home * 0.0075;
      uniforms.uSpeed.value = home * 0.035;
      uniforms.uDrift.value = home * 0.05;
      uniforms.uWobble.value = home * 0.018;
      uniforms.uFlutter.value = 0.9;
      uniforms.uSpin.value = 1.6;
      box.y = Math.max(30, home * 0.45);
    }
  };

  const apply = (flash: number) => {
    const p = currentPalette;
    applied = true;
    targets.sun.intensity = p.sunIntensity * look.sun * (1 + flash * 0.4);
    targets.hemisphere.intensity = p.ambientIntensity * look.hemi * (1 + flash * 1.6);
    // Overcast grey keeps a little of the palette's hue; night stays dark.
    const grey = p.night ? GREY_NIGHT : GREY_DAY;
    targets.fog.color.copy(paletteFog).lerp(grey, look.fogGrey);
    targets.fog.near = fogRange.near * look.fogNear;
    targets.fog.far = Math.max(targets.fog.near + 40, fogRange.far * look.fogFar);
    const sky = targets.sky.uniforms;
    scratch.copy(paletteSkyBelow).lerp(grey, 0.7).multiplyScalar(p.night ? 0.8 : 0.92 - look.cloudDark * 0.3);
    (sky.uOvercast.value as THREE.Color).copy(scratch);
    sky.uDim.value = look.dim;
    sky.uRainbow.value = look.rainbow * (p.night ? 0.25 : 1);
    sky.uAurora.value = look.aurora * p.night;
    sky.uFlash.value = flash;
    // Clouds: darker and greyer in rain and storms; the shaded side deepens
    // first, so overcast banks keep their shape against a grey sky.
    cloudLight.copy(paletteCloud).lerp(p.night ? CLOUD_NIGHT : CLOUD_DAY, look.cloudDark);
    cloudShade.copy(paletteCloudShade).lerp(p.night ? SHADE_NIGHT : SHADE_DAY, Math.min(1, look.cloudDark * 1.8));
    (targets.clouds.uniforms.uLight.value as THREE.Color).copy(cloudLight);
    (targets.clouds.uniforms.uShade.value as THREE.Color).copy(cloudShade);
    targets.clouds.uniforms.uLift.value = look.lift;
    (deckMaterial.uniforms.uLight.value as THREE.Color).copy(cloudLight);
    (deckMaterial.uniforms.uShade.value as THREE.Color).copy(cloudShade);
    deckMaterial.uniforms.uOpacity.value = look.deck;
    deck.visible = look.deck > 0.01;
    particleMaterial.uniforms.uOpacity.value = look.particles;
    if (particleKind() === "none") particles.visible = false;
    SHARED_UNIFORMS.uWind.value = look.wind;
    SHARED_UNIFORMS.uRain.value = look.rain;
  };

  const setKind = (next: SkyWeatherKind, instant = false) => {
    const previous = PARTICLES[currentKind];
    currentKind = LOOKS[next] ? next : "clear";
    goal = LOOKS[currentKind];
    configureParticles();
    frameParticles();
    if (instant) Object.assign(look, goal);
    // A new particle kind fades in from nothing rather than swapping shape.
    else if (previous !== PARTICLES[currentKind]) look.particles = 0;
    nextFlash = 2 + flashRandom() * 4;
    apply(0);
  };

  configureParticles();
  frameParticles();
  apply(0);

  return {
    kind: () => currentKind,
    setKind,
    setPalette(next) {
      currentPalette = next;
      readPalette(next);
      configureParticles();
      apply(0);
    },
    setFogRange(near, far) {
      fogRange.near = near;
      fogRange.far = far;
      apply(0);
    },
    setFrame(_center, _size, homeDistance) {
      home = Math.max(20, homeDistance);
      frameParticles();
    },
    setViewport(pixelHeight, fov) {
      particleMaterial.uniforms.uScale.value = pixelHeight / (2 * Math.tan(THREE.MathUtils.degToRad(fov / 2)));
    },
    setLowPower(value) {
      lowPower = value;
      configureParticles();
    },
    update(time, delta, target, animating) {
      (particleMaterial.uniforms.uCenter.value as THREE.Vector3).copy(target);
      let busy = false, changed = false;
      const ease = animating ? 1 - Math.exp(-delta * 1.8) : 1;
      for (let index = 0; index < LOOK_KEYS.length; index++) {
        const key = LOOK_KEYS[index];
        if (look[key] === goal[key]) continue;
        changed = true;
        const value = lerp(look[key], goal[key], ease);
        if (Math.abs(value - goal[key]) > 1e-3) busy = true;
        look[key] = Math.abs(value - goal[key]) > 1e-3 ? value : goal[key];
      }
      let flash = 0;
      if (currentKind === "storm" && animating && !options.reducedMotion()) {
        if (time >= nextFlash) {
          flashAt = time;
          nextFlash = time + 6 + flashRandom() * 8;
          boltAzimuth = (flashRandom() - 0.5) * 0.9;
          boltSeed = flashRandom() * 50;
        }
        const since = time - flashAt;
        if (since >= 0 && since < 0.9) {
          flash = Math.exp(-since * 13) + (since > 0.16 ? 0.7 * Math.exp(-(since - 0.16) * 11) : 0);
          busy = true;
        }
      }
      // Write the scene only while something changes (a fade, a flash).
      const flashNow = Math.min(1, flash);
      if (changed || flashNow !== lastFlash || !applied) {
        (targets.sky.uniforms.uBolt.value as THREE.Vector3).set(boltAzimuth, boltSeed, Math.min(1, flash * 1.4));
        lastFlash = flashNow;
        apply(lastFlash);
      }
      return busy;
    },
    drawCalls: () => (particles.visible ? 1 : 0) + (deck.visible ? 1 : 0),
    flash: () => lastFlash,
    dispose() {
      scene.remove(particles, deck);
      particleGeo.dispose();
      particleMaterial.dispose();
      deckGeo.dispose();
      deckMaterial.dispose();
    }
  };
}
