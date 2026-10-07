// Cartoon materials for the sky world. Everything is lit with three's toon
// shading (a few soft light steps) and coloured procedurally: no textures,
// so nothing repeats, stretches or seams, and every colour comes from the
// palette of the current time of day.
//   - terrain: grass in soft patches, worn paths, then light soil fading to
//     deeper rock under the island;
//   - objects: vertex-colour light-to-shade gradients tinted per instance;
//   - water, waterfalls, clouds and a sky dome with stars at night.
import * as THREE from "three";
import type { PathLine } from "./terrain";

export type SkyPalette = {
  name: string;
  skyTop: string;
  skyHorizon: string;
  skyBelow: string;
  sunColor: string;
  sunIntensity: number;
  sunElevation: number;
  sunAzimuth: number;
  ambientSky: string;
  ambientGround: string;
  ambientIntensity: number;
  fog: string;
  fogNear: number;
  fogFar: number;
  grassLight: string;
  grassDark: string;
  grassAlt: string;
  path: string;
  soil: string;
  earthA: string;
  earthB: string;
  rockDeep: string;
  cloud: string;
  cloudShade: string;
  water: string;
  waterDeep: string;
  /** 0..1: lit windows, stars and fireflies at night. */
  night: number;
};

export const SHARED_UNIFORMS = {
  uTime: { value: 0 },
  uSunDirection: { value: new THREE.Vector3(0.4, 0.8, 0.3).normalize() },
  /** Weather wind: scales leaf and grass sway, rain slant and petal drift. */
  uWind: { value: 1 },
  /** 0..1: rain on the water (faster glints, ripple rings). */
  uRain: { value: 0 },
  /** Faint by day, clear at night: crystals, glowing veins. */
  uGlow: { value: 0.3 }
};

/** Back to calm defaults (a new world must not inherit an old storm). */
export function resetSharedUniforms() {
  SHARED_UNIFORMS.uTime.value = 0;
  SHARED_UNIFORMS.uWind.value = 1;
  SHARED_UNIFORMS.uRain.value = 0;
  SHARED_UNIFORMS.uGlow.value = 0.3;
}

const color = (value: string) => new THREE.Color(value);

/** How the time of day shifts a noon colour: the per-channel ratio between
 * this palette and noon, softened toward grey so night stays readable. */
export function phaseFilter(value: string, reference: string) {
  const current = color(value), base = color(reference);
  const ratio = new THREE.Color(
    THREE.MathUtils.clamp(current.r / Math.max(0.02, base.r), 0.15, 1.6),
    THREE.MathUtils.clamp(current.g / Math.max(0.02, base.g), 0.15, 1.6),
    THREE.MathUtils.clamp(current.b / Math.max(0.02, base.b), 0.15, 1.6)
  );
  const grey = ratio.r * 0.2126 + ratio.g * 0.7152 + ratio.b * 0.0722;
  return ratio.lerp(new THREE.Color(grey, grey, grey), 0.4);
}

/** Everything the terrain shader needs for one island's ground and cliff. */
export type GroundLook = {
  grassLight: THREE.Color;
  grassDark: THREE.Color;
  grassAlt: THREE.Color;
  altMix: number;
  path: THREE.Color;
  soil: THREE.Color;
  earthA: THREE.Color;
  earthB: THREE.Color;
  rockDeep: THREE.Color;
  cap: THREE.Color;
  /** Cap where the normalized rim distance is below this (-1: off). */
  capRim: number;
  /** Cap above this local height (large: off). */
  capAbove: number;
  slope: THREE.Color;
  /** Rock where the surface normal's y is below this (0: off). */
  slopeBelow: number;
  beach: THREE.Color;
  /** Beach from this rim distance outward (2: off). */
  beachFrom: number;
  strata: THREE.Color;
  strataStrength: number;
  vein: THREE.Color;
  veinStrength: number;
  veinGlow: number;
  fleckA: THREE.Color;
  fleckB: THREE.Color;
  fleck: number;
  film: THREE.Color;
  filmStrength: number;
  dunes: number;
};

/** The current palette's ground, unchanged: temperate islands and far ones. */
export function paletteGround(palette: SkyPalette, tone?: GroundTone): GroundLook {
  return {
    grassLight: toneColor(palette.grassLight, tone),
    grassDark: toneColor(palette.grassDark, tone),
    grassAlt: toneColor(palette.grassAlt, tone),
    altMix: 0.22,
    path: color(tone?.path ?? palette.path),
    soil: color(palette.soil),
    earthA: color(palette.earthA),
    earthB: color(palette.earthB),
    rockDeep: color(palette.rockDeep),
    cap: color("#ffffff"),
    capRim: -1,
    capAbove: 1e6,
    slope: color("#888888"),
    slopeBelow: 0,
    beach: color("#ffffff"),
    beachFrom: 2,
    strata: color("#ffffff"),
    strataStrength: 0,
    vein: color("#ffffff"),
    veinStrength: 0,
    veinGlow: 0,
    fleckA: color("#ffffff"),
    fleckB: color("#ffffff"),
    fleck: 0,
    film: color("#ffffff"),
    filmStrength: 0,
    dunes: 0
  };
}

let gradient: THREE.DataTexture | null = null;
/** Four soft light steps shared by every toon material. */
export function toonGradient() {
  if (gradient) return gradient;
  const steps = new Uint8Array([120, 168, 214, 255]);
  gradient = new THREE.DataTexture(steps, steps.length, 1, THREE.RedFormat);
  gradient.minFilter = gradient.magFilter = THREE.NearestFilter;
  gradient.needsUpdate = true;
  return gradient;
}

const NOISE_GLSL = `
  float skyHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float skyNoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(skyHash(i), skyHash(i + vec2(1.0, 0.0)), u.x), mix(skyHash(i + vec2(0.0, 1.0)), skyHash(i + vec2(1.0, 1.0)), u.x), u.y);
  }`;

export type GroundTone = { grass: [number, number, number]; path?: string };

export function toneColor(value: string, tone?: GroundTone) {
  const result = color(value);
  if (tone) result.offsetHSL(tone.grass[0], tone.grass[1], tone.grass[2]);
  return result;
}

const GROUND_UNIFORMS: Array<[string, keyof GroundLook]> = [
  ["uGrassLight", "grassLight"], ["uGrassDark", "grassDark"], ["uGrassAlt", "grassAlt"], ["uAltMix", "altMix"], ["uPath", "path"],
  ["uSoil", "soil"], ["uEarthA", "earthA"], ["uEarthB", "earthB"], ["uRockDeep", "rockDeep"],
  ["uCap", "cap"], ["uCapRim", "capRim"], ["uCapAbove", "capAbove"], ["uSlope", "slope"], ["uSlopeBelow", "slopeBelow"],
  ["uBeach", "beach"], ["uBeachFrom", "beachFrom"], ["uStrata", "strata"], ["uStrataStrength", "strataStrength"],
  ["uVein", "vein"], ["uVeinStrength", "veinStrength"], ["uVeinGlow", "veinGlow"],
  ["uFleckA", "fleckA"], ["uFleckB", "fleckB"], ["uFleck", "fleck"], ["uFilm", "film"], ["uFilmStrength", "filmStrength"], ["uDunes", "dunes"]
];

/** Updates a terrain material in place (time of day changes). */
export function setTerrainGround(material: THREE.Material, look: GroundLook) {
  const uniforms = material.userData.uniforms as Record<string, { value: unknown }>;
  for (const [name, key] of GROUND_UNIFORMS) {
    const value = look[key];
    if (value instanceof THREE.Color) (uniforms[name].value as THREE.Color).copy(value);
    else uniforms[name].value = value;
  }
}

export function terrainMaterial(palette: SkyPalette, tone?: GroundTone, paths: PathLine[] = [], look: GroundLook = paletteGround(palette, tone)) {
  // Continuous diffuse light keeps a curved cliff from breaking into tiles.
  const material = new THREE.MeshLambertMaterial();
  const segments = paths.flatMap(path => path.points.slice(1).map((end, i) => ({ line: new THREE.Vector4(...path.points[i], ...end), width: path.width }))).slice(0, 12);
  const uniforms: Record<string, { value: unknown }> = {
    uPaths: { value: Array.from({ length: 12 }, (_, i) => segments[i]?.line ?? new THREE.Vector4()) },
    uPathWidths: { value: Array.from({ length: 12 }, (_, i) => segments[i]?.width ?? 1) },
    uPathCount: { value: segments.length },
    uHighlight: { value: 0 },
    uGlow: SHARED_UNIFORMS.uGlow
  };
  for (const [name, key] of GROUND_UNIFORMS) {
    const value = look[key];
    uniforms[name] = { value: value instanceof THREE.Color ? value.clone() : value };
  }
  material.userData.uniforms = uniforms;
  material.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>
        attribute float aRock;
        attribute float aDepth;
        attribute float aWorn;
        attribute float aRim;
        varying float vRock;
        varying float vDepth;
        varying float vWorn;
        varying float vRim;
        varying vec3 vWorld;
        varying vec3 vLocal;
        varying vec3 vNormalW;`)
      .replace("#include <worldpos_vertex>", `#include <worldpos_vertex>
        vRock = aRock;
        vDepth = aDepth;
        vWorn = aWorn;
        vRim = aRim;
        vLocal = position;
        vWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vNormalW = normalize(mat3(modelMatrix) * objectNormal);`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>
        uniform vec3 uGrassLight;
        uniform vec3 uGrassDark;
        uniform vec3 uGrassAlt;
        uniform float uAltMix;
        uniform vec3 uPath;
        uniform vec3 uSoil;
        uniform vec3 uEarthA;
        uniform vec3 uEarthB;
        uniform vec3 uRockDeep;
        uniform vec3 uCap;
        uniform float uCapRim;
        uniform float uCapAbove;
        uniform vec3 uSlope;
        uniform float uSlopeBelow;
        uniform vec3 uBeach;
        uniform float uBeachFrom;
        uniform vec3 uStrata;
        uniform float uStrataStrength;
        uniform vec3 uVein;
        uniform float uVeinStrength;
        uniform float uVeinGlow;
        uniform float uGlow;
        uniform vec3 uFleckA;
        uniform vec3 uFleckB;
        uniform float uFleck;
        uniform vec3 uFilm;
        uniform float uFilmStrength;
        uniform float uDunes;
        uniform float uHighlight;
        uniform vec4 uPaths[12];
        uniform float uPathWidths[12];
        uniform int uPathCount;
        varying float vRock;
        varying float vDepth;
        varying float vWorn;
        varying float vRim;
        varying vec3 vWorld;
        varying vec3 vLocal;
        varying vec3 vNormalW;
        ${NOISE_GLSL}`)
      .replace("#include <map_fragment>", `
        // Grass: two broad tones in soft-edged patches, plus a third patch
        // colour; world-space noise, so it never repeats or stretches.
        float broad = skyNoise(vWorld.xz * 0.16) * 0.7 + skyNoise(vWorld.xz * 0.45 + 3.7) * 0.3;
        vec3 grass = mix(uGrassDark, uGrassLight, smoothstep(0.12, 0.88, broad));
        grass = mix(grass, uGrassAlt, smoothstep(0.55, 0.92, skyNoise(vWorld.xz * 0.22 + 9.1)) * uAltMix);
        vec3 surfaceNormal = normalize(vNormalW);
        // Climate detail, each off at zero: wind ripples on sand, fallen
        // leaves, water films on flat rice terraces, a beach at the rim.
        if (uDunes > 0.0) {
          float ripple = sin(dot(vWorld.xz, vec2(1.6, 0.85)) * 1.5 + skyNoise(vWorld.xz * 0.3) * 5.0);
          grass *= 1.0 + uDunes * (smoothstep(0.35, 0.95, ripple) * 0.07 - 0.025);
        }
        if (uFleck > 0.0) {
          float fleck = step(0.8, skyNoise(vWorld.xz * 3.4 + 1.7)) * step(0.35, skyNoise(vWorld.xz * 0.5 - 2.0));
          grass = mix(grass, mix(uFleckA, uFleckB, step(0.5, skyNoise(vWorld.xz * 1.3 - 4.0))), fleck * uFleck * 0.9);
        }
        if (uFilmStrength > 0.0) {
          float level = smoothstep(0.975, 0.993, surfaceNormal.y) * smoothstep(0.3, 0.55, skyNoise(vWorld.xz * 0.32 + 2.0));
          grass = mix(grass, uFilm, level * uFilmStrength);
          grass *= mix(0.8, 1.0, smoothstep(0.72, 0.9, surfaceNormal.y));
        }
        float wobble = skyNoise(vWorld.xz * 0.9) - 0.5;
        grass = mix(grass, uBeach, smoothstep(uBeachFrom, uBeachFrom + 0.025, vRim + wobble * 0.05));
        // Snowfields inside a rim distance; bare rock on steep slopes; then a
        // cap above a height (a snowy summit, an ashen cone) over both.
        grass = mix(grass, uCap, smoothstep(-0.012, 0.012, uCapRim - vRim + wobble * 0.14));
        if (uSlopeBelow > 0.0) grass = mix(grass, uSlope, 1.0 - smoothstep(uSlopeBelow - 0.05, uSlopeBelow + 0.02, surfaceNormal.y + wobble * 0.06));
        grass = mix(grass, uCap, smoothstep(-0.03, 0.03, vLocal.y - uCapAbove + wobble * 0.35));
        // Evaluate the path per pixel: interpolating a sharp vertex mask made
        // the ground's triangular grid visible along every path edge.
        float worn = 0.0;
        if (vRock < 0.5) for (int i = 0; i < 12; i++) {
          if (i >= uPathCount) break;
          vec2 start = uPaths[i].xy, segment = uPaths[i].zw - start;
          float t = clamp(dot(vLocal.xz - start, segment) / max(dot(segment, segment), 0.001), 0.0, 1.0);
          float distance = length(vLocal.xz - start - segment * t);
          worn = max(worn, 1.0 - smoothstep(uPathWidths[i] * 0.4, uPathWidths[i] * 0.62, distance));
        }
        vec3 ground = mix(grass, uPath, worn);

        // Restrained mineral variation, with a single soil-to-stone transition.
        // Cartesian noise has no angular seam around the back of the island.
        float mineral = skyNoise(vLocal.xz * 0.24 + vLocal.y * 0.08);
        vec3 earth = mix(uSoil, uEarthA, smoothstep(0.0, 0.5, vDepth));
        earth = mix(earth, uEarthB, smoothstep(0.18, 0.75, vDepth) * 0.55);
        vec3 rock = mix(earth, uRockDeep, smoothstep(0.25, 1.0, vDepth));
        // Low-contrast, irregular mineral grain; strata only where a climate
        // asks for them (desert sandstone).
        rock *= 0.95 + 0.05 * mineral + 0.025 * skyNoise(vLocal.xz * 2.8 + vLocal.y * 1.4);
        float bands = step(0.5, fract(vLocal.y * 0.9 + skyNoise(vLocal.xz * 0.3) * 0.5));
        rock = mix(rock, uStrata, bands * uStrataStrength * (1.0 - smoothstep(0.5, 0.95, vDepth)));
        float vein = (1.0 - smoothstep(0.012, 0.045, abs(skyNoise(vLocal.xz * 0.6 + vec2(vLocal.y * 0.9, 3.0)) - 0.5)))
          * uVeinStrength * smoothstep(0.03, 0.1, vDepth);
        rock = mix(rock, uVein, vein * 0.85);
        float rockMask = vRock * smoothstep(0.001, 0.016, vDepth);
        diffuseColor = vec4(mix(ground, rock, rockMask), opacity);
        diffuseColor.rgb += uHighlight * vec3(0.08, 0.07, 0.03) * (1.0 - rockMask);
        totalEmissiveRadiance += uVein * vein * rockMask * uVeinGlow * uGlow * 0.9;
      `);
  };
  material.customProgramCacheKey = () => "sky-toon-terrain-v2";
  return material;
}

/** Toon material for kit and models: vertex-colour gradient × instance colour. */
export function toonMaterial(options: { vertexColors?: boolean; color?: THREE.ColorRepresentation; map?: THREE.Texture | null; emissive?: THREE.ColorRepresentation; emissiveIntensity?: number } = {}) {
  return new THREE.MeshToonMaterial({
    gradientMap: toonGradient(),
    vertexColors: options.vertexColors ?? true,
    color: options.color ?? 0xffffff,
    map: options.map ?? null,
    emissive: options.emissive ?? 0x000000,
    emissiveIntensity: options.emissiveIntensity ?? 1
  });
}

/** Gentle wind for leaves and grass, by height above the model's base. */
export function addSway(material: THREE.Material, height: number, amount: number) {
  return kitShader(material, { height, sway: amount });
}

/** Kit motion and light: wind sway (scaled by the weather's wind), a slow
 * bob for floating pieces, and a glow from the tinted colour. */
export function kitShader(material: THREE.Material, options: { height: number; sway?: number; bob?: boolean; glow?: boolean }) {
  const sway = options.sway ?? 0, height = Math.max(0.01, options.height);
  if (sway <= 0 && !options.bob && !options.glow) return material;
  material.onBeforeCompile = shader => {
    shader.uniforms.uTime = SHARED_UNIFORMS.uTime;
    shader.uniforms.uWind = SHARED_UNIFORMS.uWind;
    shader.uniforms.uGlow = SHARED_UNIFORMS.uGlow;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>
        uniform float uTime;
        uniform float uWind;`)
      .replace("#include <begin_vertex>", `#include <begin_vertex>
        vec3 swayOrigin = vec3(0.0);
        #ifdef USE_INSTANCING
          swayOrigin = vec3(instanceMatrix[3]);
        #endif
        float swayPhase = dot(swayOrigin.xz, vec2(0.37, 0.23));
        ${sway > 0 ? `
        float swayHeight = clamp(position.y / ${height.toFixed(3)}, 0.0, 1.0);
        float gust = uWind * (1.0 + 0.25 * (uWind - 1.0) * sin(uTime * 0.7 + swayPhase));
        transformed.x += (sin(uTime * 1.3 * sqrt(uWind) + swayPhase) + 0.35 * (uWind - 1.0)) * swayHeight * swayHeight * ${sway.toFixed(3)} * gust;
        transformed.z += cos(uTime * 1.05 + swayPhase * 1.4) * swayHeight * swayHeight * ${(sway * 0.6).toFixed(3)} * gust;` : ""}
        ${options.bob ? `transformed.y += sin(uTime * 0.8 + swayPhase * 3.0) * ${(height * 0.12).toFixed(3)};
        transformed.xz += vec2(cos(uTime * 0.5 + swayPhase), sin(uTime * 0.45 + swayPhase)) * ${(height * 0.04).toFixed(3)};` : ""}`);
    if (options.glow) {
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", `#include <common>
          uniform float uGlow;`)
        .replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>
          totalEmissiveRadiance += diffuseColor.rgb * uGlow * 0.55;`);
    }
  };
  material.customProgramCacheKey = () => `sky-kit-${height.toFixed(2)}-${sway.toFixed(3)}-${options.bob ? 1 : 0}-${options.glow ? 1 : 0}`;
  return material;
}

/** Water colours for a palette and a climate's water kind. */
export function waterColors(palette: SkyPalette, kind: "water" | "lagoon" | "ice", filter?: THREE.Color) {
  if (kind === "water" || !filter) return { shallow: color(palette.water), deep: color(palette.waterDeep) };
  const pair = kind === "lagoon" ? ["#5fe6d6", "#17a8bd"] : ["#eef8fc", "#b4dcec"];
  return { shallow: color(pair[0]).multiply(filter), deep: color(pair[1]).multiply(filter) };
}

export function setWaterColors(material: THREE.Material, colors: { shallow: THREE.Color; deep: THREE.Color }) {
  const uniforms = material.userData.uniforms as { uShallow: { value: THREE.Color }; uDeep: { value: THREE.Color } };
  uniforms.uShallow.value.copy(colors.shallow);
  uniforms.uDeep.value.copy(colors.deep);
}

export function waterMaterial(palette: SkyPalette, channel = false, kind: "water" | "lagoon" | "ice" = "water", filter?: THREE.Color) {
  const colors = waterColors(palette, kind, filter);
  const uniforms = {
    uShallow: { value: colors.shallow },
    uDeep: { value: colors.deep },
    uChannel: { value: channel ? 1 : 0 },
    uIce: { value: kind === "ice" ? 1 : 0 },
    uRain: SHARED_UNIFORMS.uRain
  };
  const material = new THREE.MeshToonMaterial({ gradientMap: toonGradient(), transparent: true, opacity: kind === "ice" ? 1 : 0.95 });
  // The short stream overlap must not fight with the pond's coplanar surface.
  material.polygonOffset = channel;
  material.polygonOffsetFactor = -1;
  material.polygonOffsetUnits = -1;
  material.userData.uniforms = uniforms;
  material.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, uniforms, { uTime: SHARED_UNIFORMS.uTime });
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>
        varying vec2 vDisc;
        varying vec3 vWaterWorld;`)
      .replace("#include <worldpos_vertex>", `#include <worldpos_vertex>
        vDisc = uv * 2.0 - 1.0;
        vWaterWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>
        uniform vec3 uShallow;
        uniform vec3 uDeep;
        uniform float uTime;
        uniform float uChannel;
        uniform float uIce;
        uniform float uRain;
        varying vec2 vDisc;
        varying vec3 vWaterWorld;
        ${NOISE_GLSL}`)
      .replace("#include <map_fragment>", `
        // Streams keep their full width at both ends; a radial pond mask would
        // pinch the connector into an oval and leave a gap before the falls.
        float edge = mix(length(vDisc), abs(vDisc.x), uChannel);
        vec3 water = mix(uDeep, uShallow, smoothstep(0.2, 0.9, edge));
        // Cartoon glints: short bright dashes drifting across the surface,
        // quicker and denser in the rain; frozen ponds keep still streaks.
        float flow = uTime * (0.35 + uRain * 0.9) * (1.0 - uIce);
        float glint = step(0.86 - uRain * 0.05 + uIce * 0.05, skyNoise(vec2(vWaterWorld.x * 2.2 + flow + vWaterWorld.z * uIce * 1.4, vWaterWorld.z * 7.0)));
        float foam = smoothstep(0.82, 0.88, edge) * (1.0 - smoothstep(0.97, 1.0, edge));
        water = mix(water, mix(uShallow, vec3(1.0), 0.5), max(foam * 0.6, glint * (0.4 + uIce * 0.3) * (1.0 - edge)));
        // Ice: a few white cracks.
        float crack = (1.0 - smoothstep(0.008, 0.03, abs(skyNoise(vWaterWorld.xz * 0.9 + 5.0) - 0.5))) * uIce;
        water = mix(water, vec3(1.0), crack * 0.55);
        // Rain: rings spreading from random drops.
        if (uRain > 0.01 && uIce < 0.5) {
          vec2 cell = floor(vWaterWorld.xz * 1.3);
          vec2 local = fract(vWaterWorld.xz * 1.3) - 0.5;
          float phase = fract(uTime * 0.8 + skyHash(cell) * 7.0);
          float ring = 1.0 - smoothstep(0.0, 0.05, abs(length(local) - phase * 0.42));
          water = mix(water, vec3(1.0), ring * (1.0 - phase) * uRain * 0.45 * step(0.35, skyHash(cell + 0.7)));
        }
        diffuseColor = vec4(water, opacity * (1.0 - smoothstep(0.97, 1.0, edge)));
      `);
  };
  material.customProgramCacheKey = () => "sky-toon-water-v2";
  return material;
}

/** Glowing lava: slow molten cells with a dark crust (crater lakes and
 * pools). Unlit, so it glows at night; fogged like everything else. */
export function lavaMaterial() {
  return new THREE.ShaderMaterial({
    fog: true,
    uniforms: { ...THREE.UniformsLib.fog, uTime: SHARED_UNIFORMS.uTime },
    vertexShader: `
      varying vec3 vLavaWorld;
      varying vec2 vLavaUv;
      #include <fog_pars_vertex>
      void main() {
        vLavaUv = uv;
        vec4 world = modelMatrix * vec4(position, 1.0);
        vLavaWorld = world.xyz;
        vec4 mvPosition = viewMatrix * world;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: `
      uniform float uTime;
      varying vec3 vLavaWorld;
      varying vec2 vLavaUv;
      ${NOISE_GLSL}
      #include <fog_pars_fragment>
      void main() {
        vec2 p = vLavaWorld.xz;
        float n = skyNoise(p * 1.3 + vec2(uTime * 0.12, -uTime * 0.08)) * 0.6 + skyNoise(p * 3.4 - uTime * 0.18) * 0.4;
        vec3 colour = mix(vec3(0.62, 0.08, 0.03), vec3(1.0, 0.36, 0.06), smoothstep(0.3, 0.68, n));
        colour = mix(colour, vec3(1.0, 0.82, 0.32), smoothstep(0.72, 0.9, n));
        float crust = 1.0 - smoothstep(0.015, 0.05, abs(n - 0.46));
        colour = mix(colour, vec3(0.2, 0.06, 0.04), crust * 0.7);
        float edge = length(vLavaUv * 2.0 - 1.0);
        colour = mix(colour, vec3(0.25, 0.07, 0.04), smoothstep(0.82, 1.0, edge) * 0.7);
        gl_FragColor = vec4(colour, 1.0);
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`
  });
}

/** Falling water: bright stripes sliding down, foam at the lip, fading out.
 * Lava falls use the same ribbon, slower, molten and opaque at the top.
 * Fogged, so many-island views do not show bright streaks through the haze. */
export function waterfallMaterial(palette: SkyPalette, lava = false) {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: true,
    uniforms: {
      ...THREE.UniformsLib.fog,
      uTime: SHARED_UNIFORMS.uTime,
      uWater: { value: lava ? new THREE.Color(1.0, 0.32, 0.05) : color(palette.water) },
      uFoam: { value: lava ? new THREE.Color(1.0, 0.85, 0.35) : new THREE.Color(1, 1, 1) },
      uSpeed: { value: lava ? 0.22 : 0.9 }
    },
    vertexShader: `
      varying vec2 vUv;
      #include <fog_pars_vertex>
      void main() {
        vUv = uv;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: `
      uniform float uTime;
      uniform vec3 uWater;
      uniform vec3 uFoam;
      uniform float uSpeed;
      varying vec2 vUv;
      #include <fog_pars_fragment>
      void main() {
        float stripes = step(0.62, fract(vUv.x * 5.0 + sin(vUv.x * 13.0) * 0.2 + (vUv.y + uTime * uSpeed) * 1.6));
        vec3 colour = mix(uWater, mix(uWater, uFoam, 0.45), stripes * 0.42 + smoothstep(0.88, 1.0, vUv.y) * 0.4);
        float sides = smoothstep(0.0, 0.08, vUv.x) * (1.0 - smoothstep(0.92, 1.0, vUv.x));
        float alpha = sides * smoothstep(0.0, 0.35, vUv.y) * 0.92;
        gl_FragColor = vec4(colour, alpha);
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`
  });
}

export function setWaterfallColor(material: THREE.ShaderMaterial, palette: SkyPalette) {
  material.uniforms.uWater.value.set(palette.water);
}

export function cloudMaterial(palette: SkyPalette, deck = false) {
  // Camera-facing soft clouds for this fixed-pitch world. Each sheet contains
  // a continuous density field, with airy edges and wisps instead of visible
  // overlapping balls. Their 3D positions still determine depth and parallax.
  // A deck merges many sheets into one mesh (weather banks, one draw call):
  // each corner carries its sheet's centre and size.
  return new THREE.ShaderMaterial({
    fog: true,
    transparent: true,
    depthWrite: false,
    defines: deck ? { CLOUD_DECK: 1 } : {},
    uniforms: {
      ...THREE.UniformsLib.fog,
      uLight: { value: color(palette.cloud) },
      uShade: { value: color(palette.cloudShade) },
      uTime: SHARED_UNIFORMS.uTime,
      uOpacity: { value: 1 },
      uLift: { value: 0 }
    },
    vertexShader: `
      attribute float aCloudSeed;
      #ifdef CLOUD_DECK
        attribute vec3 aCenter;
        attribute vec2 aSize;
      #endif
      uniform float uTime;
      uniform float uLift;
      varying vec2 vCloudUv;
      varying float vCloudSeed;
      #include <fog_pars_vertex>
      void main() {
        vCloudUv = uv;
        vCloudSeed = aCloudSeed;
        #ifdef CLOUD_DECK
          vec3 center = aCenter + vec3(sin(uTime * 0.012 + aCloudSeed) * 4.0, uLift, 0.0);
          vec4 mvPosition = viewMatrix * vec4(center, 1.0);
          mvPosition.xy += position.xy * aSize;
        #else
          vec2 scale = vec2(length(modelMatrix[0].xyz), length(modelMatrix[1].xyz));
          vec4 worldCenter = modelMatrix * vec4(0.0, 0.0, 0.0, 1.0);
          worldCenter.y += uLift;
          vec4 mvPosition = viewMatrix * worldCenter;
          mvPosition.xy += position.xy * scale;
        #endif
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: `
      uniform vec3 uLight;
      uniform vec3 uShade;
      uniform float uTime;
      uniform float uOpacity;
      varying vec2 vCloudUv;
      varying float vCloudSeed;
      ${NOISE_GLSL}
      #include <fog_pars_fragment>
      void main() {
        // Perspective interpolation can perturb a constant varying by a few
        // ulps. Hashing that value amplifies it into a different cloud shape.
        float seed = floor(vCloudSeed + 0.5);
        vec2 p = (vCloudUv - 0.5) * vec2(8.0, 3.8);
        float density = 0.0;
        for (int i = 0; i < 7; i++) {
          float k = float(i);
          float r = skyHash(vec2(k + 0.3, seed * 11.0));
          float arch = sin((k + 0.5) / 7.0 * 3.14159);
          vec2 center = vec2((k - 3.0) * 0.78, -0.18 + arch * arch * (0.45 + r * 0.55));
          vec2 q = (p - center) / vec2(0.62 + r * 0.48, 0.38 + r * 0.55);
          density += exp(-dot(q, q) * 1.7) * 0.7;
        }
        vec2 drift = vec2(uTime * 0.008, 0.0);
        float detail = skyNoise(p * 2.4 + drift + seed * 7.0) * 0.6
          + skyNoise(p * 6.5 - drift * 0.5) * 0.28 + skyNoise(p * 15.0) * 0.12;
        vec2 wisp = (p - vec2(0.2, -0.12)) / vec2(3.2, 0.35);
        density += exp(-dot(wisp, wisp)) * 0.22;
        density *= 0.75 + detail * 0.5;
        float edge = max(abs(vCloudUv.x - 0.5), abs(vCloudUv.y - 0.5)) * 2.0;
        float alpha = smoothstep(0.04, 0.75, density) * (1.0 - smoothstep(0.88, 1.0, edge)) * 0.9 * uOpacity;
        if (alpha < 0.004) discard;
        float light = clamp(0.68 + p.y * 0.26 + (detail - 0.5) * 0.28, 0.15, 1.0);
        gl_FragColor = vec4(mix(uShade, uLight, light), alpha);
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`
  });
}

export function skyDomeMaterial(palette: SkyPalette) {
  return new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      uTop: { value: color(palette.skyTop) },
      uHorizon: { value: color(palette.skyHorizon) },
      uBelow: { value: color(palette.skyBelow) },
      uNight: { value: palette.night },
      uTime: SHARED_UNIFORMS.uTime,
      // Weather: an overcast tint, a rainbow, aurora curtains and lightning.
      uOvercast: { value: new THREE.Color(0.5, 0.55, 0.6) },
      uDim: { value: 0 },
      uRainbow: { value: 0 },
      uAurora: { value: 0 },
      uFlash: { value: 0 },
      uBolt: { value: new THREE.Vector3(0, 0, 0) }
    },
    vertexShader: `
      varying vec3 vDirection;
      varying vec3 vView;
      void main() {
        vDirection = normalize(position);
        vec4 world = modelMatrix * vec4(position, 1.0);
        vView = world.xyz - cameraPosition;
        vec4 clip = projectionMatrix * viewMatrix * world;
        gl_Position = clip.xyww;
      }`,
    fragmentShader: `
      uniform vec3 uTop;
      uniform vec3 uHorizon;
      uniform vec3 uBelow;
      uniform float uNight;
      uniform float uTime;
      uniform vec3 uOvercast;
      uniform float uDim;
      uniform float uRainbow;
      uniform float uAurora;
      uniform float uFlash;
      uniform vec3 uBolt;
      varying vec3 vDirection;
      varying vec3 vView;
      ${NOISE_GLSL}
      vec3 rainbowBand(float t) {
        // Seven soft bands, red outside to violet inside.
        vec3 bands[7];
        bands[0] = vec3(0.93, 0.28, 0.32); bands[1] = vec3(0.98, 0.58, 0.25); bands[2] = vec3(0.99, 0.88, 0.35);
        bands[3] = vec3(0.45, 0.82, 0.4); bands[4] = vec3(0.32, 0.66, 0.95); bands[5] = vec3(0.38, 0.42, 0.88); bands[6] = vec3(0.62, 0.42, 0.86);
        float x = clamp(t, 0.0, 0.999) * 6.0;
        int i = int(floor(x));
        vec3 a = bands[0], b = bands[1];
        for (int k = 0; k < 6; k++) if (k == i) { a = bands[k]; b = bands[k + 1]; }
        return mix(a, b, smoothstep(0.3, 0.7, fract(x)));
      }
      void main() {
        float h = vDirection.y;
        vec3 sky = mix(uHorizon, uTop, smoothstep(-0.05, 0.6, h));
        sky = mix(sky, uBelow, smoothstep(-0.02, -0.35, h));
        // Stars at night: sparse points on a sphere grid, gently twinkling.
        vec2 grid = vec2(atan(vDirection.z, vDirection.x) * 220.0, asin(clamp(h, -1.0, 1.0)) * 220.0);
        vec2 cell = floor(grid);
        float star = step(0.992, skyHash(cell)) * smoothstep(0.22, 0.04, length(fract(grid) - 0.5)) * smoothstep(-0.05, 0.25, h);
        float twinkle = 0.6 + 0.4 * sin(uTime * 1.7 + skyHash(cell + 3.1) * 40.0);
        sky += vec3(star * twinkle * uNight * 0.9 * (1.0 - uDim));
        // Overcast: the whole backdrop greys; heavy weather darkens it toward
        // the top like a low cloud ceiling.
        vec3 view = normalize(vView);
        float ceiling = smoothstep(-0.55, -0.05, view.y) * smoothstep(0.25, 0.6, uDim);
        sky = mix(sky, uOvercast * (1.05 - 0.38 * ceiling), uDim);
        // Weather is drawn in view directions, so it stays put while panning,
        // like anything at the horizon.
        float azimuth = atan(view.x, -view.z);
        if (uRainbow > 0.001) {
          vec3 axis = normalize(vec3(0.0, -0.84, -1.0));
          float angle = acos(clamp(dot(view, axis), -1.0, 1.0));
          float t = (0.5 - angle) / 0.05;
          float arc = smoothstep(0.0, 0.18, t) * (1.0 - smoothstep(0.82, 1.0, t));
          float legs = smoothstep(-0.78, -0.42, view.y);
          sky = mix(sky, rainbowBand(t), arc * legs * uRainbow * 0.42);
        }
        if (uAurora > 0.001) {
          // Ribbons: a wavy lower hem, soft folds, faint rays, and gaps
          // between separate curtains; strongest just above the hem.
          float wave = sin(azimuth * 4.0 + uTime * 0.12) * 0.03 + sin(azimuth * 9.0 - uTime * 0.2) * 0.014;
          float bottom = -0.25 + wave;
          float above = view.y - bottom;
          float curtain = smoothstep(0.0, 0.018, above) * exp(-max(above, 0.0) * 7.5);
          float folds = 0.5 + 0.5 * sin(azimuth * 13.0 + sin(azimuth * 5.0 + uTime * 0.25) * 2.2);
          float rays = 0.8 + 0.2 * sin(azimuth * 85.0 + sin(azimuth * 11.0 + uTime * 0.4) * 3.0);
          float curtains = smoothstep(-0.2, 0.5, sin(azimuth * 2.6 + 0.8 + uTime * 0.04));
          float reach = smoothstep(0.95, 0.3, abs(azimuth));
          vec3 glow = mix(vec3(0.3, 1.0, 0.62), vec3(0.6, 0.45, 1.0), smoothstep(0.03, 0.2, above));
          sky += glow * curtain * mix(0.3, 1.0, folds) * rays * curtains * reach * uAurora * 0.5;
        }
        if (uFlash > 0.001) {
          sky = mix(sky, vec3(0.92, 0.95, 1.0), uFlash * 0.55);
          float line = uBolt.x + (skyNoise(vec2(view.y * 26.0, uBolt.y)) - 0.5) * 0.06 + (skyNoise(vec2(view.y * 80.0, uBolt.y + 3.0)) - 0.5) * 0.015;
          float bolt = (1.0 - smoothstep(0.0015, 0.005, abs(azimuth - line))) * smoothstep(-0.42, -0.36, view.y) * (1.0 - smoothstep(-0.12, -0.06, view.y));
          sky = mix(sky, vec3(1.0), bolt * uBolt.z);
        }
        gl_FragColor = vec4(sky, 1.0);
        #include <colorspace_fragment>
      }`
  });
}

/** Updates the sky dome to another palette (time of day). */
export function setSkyDomePalette(material: THREE.ShaderMaterial, palette: SkyPalette) {
  material.uniforms.uTop.value.set(palette.skyTop);
  material.uniforms.uHorizon.value.set(palette.skyHorizon);
  material.uniforms.uBelow.value.set(palette.skyBelow);
  material.uniforms.uNight.value = palette.night;
}
