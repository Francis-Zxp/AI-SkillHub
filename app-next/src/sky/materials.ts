// Cartoon materials for the sky world. Everything is lit with three's toon
// shading (a few soft light steps) and coloured procedurally: no textures,
// so nothing repeats, stretches or seams, and every colour comes from the
// palette of the current time of day.
//   - terrain: grass in soft patches, worn paths, then earth bands down the
//     cliff and faceted rock under the island;
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
  uSunDirection: { value: new THREE.Vector3(0.4, 0.8, 0.3).normalize() }
};

const color = (value: string) => new THREE.Color(value);

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

export function terrainMaterial(palette: SkyPalette, tone?: GroundTone, paths: PathLine[] = []) {
  // Continuous diffuse light keeps a curved cliff from breaking into tiles.
  const material = new THREE.MeshLambertMaterial();
  const segments = paths.flatMap(path => path.points.slice(1).map((end, i) => ({ line: new THREE.Vector4(...path.points[i], ...end), width: path.width }))).slice(0, 12);
  const uniforms = {
    uPaths: { value: Array.from({ length: 12 }, (_, i) => segments[i]?.line ?? new THREE.Vector4()) },
    uPathWidths: { value: Array.from({ length: 12 }, (_, i) => segments[i]?.width ?? 1) },
    uPathCount: { value: segments.length },
    uGrassLight: { value: toneColor(palette.grassLight, tone) },
    uGrassDark: { value: toneColor(palette.grassDark, tone) },
    uGrassAlt: { value: toneColor(palette.grassAlt, tone) },
    uPath: { value: color(tone?.path ?? palette.path) },
    uSoil: { value: color(palette.soil) },
    uEarthA: { value: color(palette.earthA) },
    uEarthB: { value: color(palette.earthB) },
    uRockDeep: { value: color(palette.rockDeep) },
    uHighlight: { value: 0 }
  };
  material.userData.uniforms = uniforms;
  material.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>
        attribute float aRock;
        attribute float aDepth;
        attribute float aWorn;
        varying float vRock;
        varying float vDepth;
        varying float vWorn;
        varying vec3 vWorld;
        varying vec3 vLocal;`)
      .replace("#include <worldpos_vertex>", `#include <worldpos_vertex>
        vRock = aRock;
        vDepth = aDepth;
        vWorn = aWorn;
        vLocal = position;
        vWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>
        uniform vec3 uGrassLight;
        uniform vec3 uGrassDark;
        uniform vec3 uGrassAlt;
        uniform vec3 uPath;
        uniform vec3 uSoil;
        uniform vec3 uEarthA;
        uniform vec3 uEarthB;
        uniform vec3 uRockDeep;
        uniform float uHighlight;
        uniform vec4 uPaths[12];
        uniform float uPathWidths[12];
        uniform int uPathCount;
        varying float vRock;
        varying float vDepth;
        varying float vWorn;
        varying vec3 vWorld;
        varying vec3 vLocal;
        ${NOISE_GLSL}`)
      .replace("#include <map_fragment>", `
        // Grass: two broad tones in soft-edged patches, plus a third patch
        // colour; world-space noise, so it never repeats or stretches.
        float broad = skyNoise(vWorld.xz * 0.16) * 0.7 + skyNoise(vWorld.xz * 0.45 + 3.7) * 0.3;
        vec3 grass = mix(uGrassDark, uGrassLight, smoothstep(0.12, 0.88, broad));
        grass = mix(grass, uGrassAlt, smoothstep(0.55, 0.92, skyNoise(vWorld.xz * 0.22 + 9.1)) * 0.22);
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
        vec3 earth = mix(uEarthA, uEarthB, 0.32 + mineral * 0.3);
        earth = mix(uSoil, earth, smoothstep(0.01, 0.17, vDepth));
        vec3 rock = mix(earth, uRockDeep, smoothstep(0.28, 0.98, vDepth));
        float rockMask = vRock * smoothstep(0.001, 0.016, vDepth);
        diffuseColor = vec4(mix(ground, rock, rockMask), opacity);
        diffuseColor.rgb += uHighlight * vec3(0.08, 0.07, 0.03) * (1.0 - rockMask);
      `);
  };
  material.customProgramCacheKey = () => "sky-toon-terrain";
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
  material.onBeforeCompile = shader => {
    shader.uniforms.uTime = SHARED_UNIFORMS.uTime;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>
        uniform float uTime;`)
      .replace("#include <begin_vertex>", `#include <begin_vertex>
        float swayHeight = clamp(position.y / ${height.toFixed(3)}, 0.0, 1.0);
        vec3 swayOrigin = vec3(0.0);
        #ifdef USE_INSTANCING
          swayOrigin = vec3(instanceMatrix[3]);
        #endif
        float swayPhase = dot(swayOrigin.xz, vec2(0.37, 0.23));
        transformed.x += sin(uTime * 1.3 + swayPhase) * swayHeight * swayHeight * ${amount.toFixed(3)};
        transformed.z += cos(uTime * 1.05 + swayPhase * 1.4) * swayHeight * swayHeight * ${(amount * 0.6).toFixed(3)};`);
  };
  material.customProgramCacheKey = () => `sky-sway-${height.toFixed(2)}-${amount.toFixed(3)}`;
  return material;
}

export function waterMaterial(palette: SkyPalette, channel = false) {
  const uniforms = { uShallow: { value: color(palette.water) }, uDeep: { value: color(palette.waterDeep) }, uChannel: { value: channel ? 1 : 0 } };
  const material = new THREE.MeshToonMaterial({ gradientMap: toonGradient(), transparent: true, opacity: 0.95 });
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
        varying vec2 vDisc;
        varying vec3 vWaterWorld;
        ${NOISE_GLSL}`)
      .replace("#include <map_fragment>", `
        // Streams keep their full width at both ends; a radial pond mask would
        // pinch the connector into an oval and leave a gap before the falls.
        float edge = mix(length(vDisc), abs(vDisc.x), uChannel);
        vec3 water = mix(uDeep, uShallow, smoothstep(0.2, 0.9, edge));
        // Cartoon glints: short bright dashes drifting across the surface.
        float glint = step(0.86, skyNoise(vec2(vWaterWorld.x * 2.2 + uTime * 0.35, vWaterWorld.z * 7.0)));
        float foam = smoothstep(0.82, 0.88, edge) * (1.0 - smoothstep(0.97, 1.0, edge));
        water = mix(water, mix(uShallow, vec3(1.0), 0.5), max(foam * 0.6, glint * 0.4 * (1.0 - edge)));
        diffuseColor = vec4(water, opacity * (1.0 - smoothstep(0.97, 1.0, edge)));
      `);
  };
  material.customProgramCacheKey = () => "sky-toon-water";
  return material;
}

/** Falling water: bright stripes sliding down, foam at the lip, fading out. */
export function waterfallMaterial(palette: SkyPalette) {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    uniforms: { uTime: SHARED_UNIFORMS.uTime, uWater: { value: color(palette.water) } },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      uniform float uTime;
      uniform vec3 uWater;
      varying vec2 vUv;
      void main() {
        float stripes = step(0.62, fract(vUv.x * 5.0 + sin(vUv.x * 13.0) * 0.2 + (vUv.y + uTime * 0.9) * 1.6));
        vec3 colour = mix(uWater, mix(uWater, vec3(1.0), 0.45), stripes * 0.42 + smoothstep(0.88, 1.0, vUv.y) * 0.4);
        float sides = smoothstep(0.0, 0.08, vUv.x) * (1.0 - smoothstep(0.92, 1.0, vUv.x));
        float alpha = sides * smoothstep(0.0, 0.35, vUv.y) * 0.92;
        gl_FragColor = vec4(colour, alpha);
        #include <colorspace_fragment>
      }`
  });
}

export function cloudMaterial(palette: SkyPalette) {
  // Keep cloud shading within the palette. Multiplying white toon clouds by
  // the bright sun, fill and emissive term clipped all their volume to white.
  return new THREE.ShaderMaterial({
    fog: true,
    uniforms: { ...THREE.UniformsLib.fog, uLight: { value: color(palette.cloud) }, uShade: { value: color(palette.cloudShade) }, uSunDirection: SHARED_UNIFORMS.uSunDirection },
    vertexShader: `
      varying vec3 vCloudNormal;
      #include <fog_pars_vertex>
      void main() {
        vCloudNormal = normalize(mat3(modelMatrix) * normal);
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: `
      uniform vec3 uLight;
      uniform vec3 uShade;
      uniform vec3 uSunDirection;
      varying vec3 vCloudNormal;
      #include <fog_pars_fragment>
      void main() {
        vec3 normal = normalize(vCloudNormal);
        float light = smoothstep(-0.7, 1.0, dot(normal, uSunDirection)) * 0.72 + smoothstep(-0.6, 0.8, normal.y) * 0.28;
        gl_FragColor = vec4(mix(uShade, uLight, light), 1.0);
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
      uTime: SHARED_UNIFORMS.uTime
    },
    vertexShader: `
      varying vec3 vDirection;
      void main() {
        vDirection = normalize(position);
        vec4 clip = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position = clip.xyww;
      }`,
    fragmentShader: `
      uniform vec3 uTop;
      uniform vec3 uHorizon;
      uniform vec3 uBelow;
      uniform float uNight;
      uniform float uTime;
      varying vec3 vDirection;
      ${NOISE_GLSL}
      void main() {
        float h = vDirection.y;
        vec3 sky = mix(uHorizon, uTop, smoothstep(-0.05, 0.6, h));
        sky = mix(sky, uBelow, smoothstep(-0.02, -0.35, h));
        // Stars at night: sparse points on a sphere grid, gently twinkling.
        vec2 grid = vec2(atan(vDirection.z, vDirection.x) * 220.0, asin(clamp(h, -1.0, 1.0)) * 220.0);
        vec2 cell = floor(grid);
        float star = step(0.992, skyHash(cell)) * smoothstep(0.22, 0.04, length(fract(grid) - 0.5)) * smoothstep(-0.05, 0.25, h);
        float twinkle = 0.6 + 0.4 * sin(uTime * 1.7 + skyHash(cell + 3.1) * 40.0);
        sky += vec3(star * twinkle * uNight * 0.9);
        gl_FragColor = vec4(sky, 1.0);
        #include <colorspace_fragment>
      }`
  });
}
