// Materials for the sky world. Lighting, shadows and fog stay three.js
// standard; each material only changes how its colour is built:
//   - terrain: world-space sampling (no UV seams or stretching), grass layers
//     with macro variation and worn paths, triplanar rock with strata that
//     darkens and cools toward the underside;
//   - foliage: the kit's leaf textures are alpha masks, so colour comes from a
//     baked canopy-depth gradient, per-instance tint, wind and soft backlight;
//   - grass: the vertex colour carries a root-to-tip gradient.
import * as THREE from "three";

export type SkyPalette = {
  name: string;
  skyZenith: string;
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
  exposure: number;
  grassLight: string;
  grassDark: string;
  grassDry: string;
  dirt: string;
  rockLight: string;
  rockDark: string;
  rockDeep: string;
  leafLight: string;
  leafDark: string;
  cloudLit: string;
  cloudShade: string;
  /** Gaps between billows in the cloud sea. */
  cloudDeep: string;
  water: string;
  waterDeep: string;
  windowGlow: number;
};

export const SHARED_UNIFORMS = {
  uTime: { value: 0 },
  uWind: { value: 1 },
  uSunDirection: { value: new THREE.Vector3(0.4, 0.8, 0.3).normalize() },
  uSunColor: { value: new THREE.Color("#fff1d6") }
};

const color = (value: string) => new THREE.Color(value);

export type GroundTone = { grass: [number, number, number]; dry: number };

/** The palette's grass colour shifted by a theme's HSL offsets. */
export function toneGrass(value: string, tone?: GroundTone) {
  const result = color(value);
  if (tone) result.offsetHSL(tone.grass[0], tone.grass[1], tone.grass[2]);
  return result;
}

export function terrainMaterial(palette: SkyPalette, brush: THREE.Texture, noise: THREE.Texture, tone?: GroundTone) {
  const material = new THREE.MeshStandardMaterial({ roughness: 0.94, metalness: 0 });
  const uniforms = {
    tBrush: { value: brush },
    tNoise: { value: noise },
    uGrassLight: { value: toneGrass(palette.grassLight, tone) },
    uGrassDark: { value: toneGrass(palette.grassDark, tone) },
    uGrassDry: { value: toneGrass(palette.grassDry, tone ? { grass: [tone.grass[0] * 0.5, tone.grass[1] * 0.5, tone.grass[2]], dry: 0 } : undefined) },
    uDry: { value: tone?.dry ?? 0.4 },
    uDirt: { value: color(palette.dirt) },
    uRockLight: { value: color(palette.rockLight) },
    uRockDark: { value: color(palette.rockDark) },
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
        varying vec3 vWorldNormal;`)
      .replace("#include <worldpos_vertex>", `#include <worldpos_vertex>
        vRock = aRock;
        vDepth = aDepth;
        vWorn = aWorn;
        vWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vWorldNormal = normalize(mat3(modelMatrix) * objectNormal);`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>
        uniform sampler2D tBrush;
        uniform sampler2D tNoise;
        uniform vec3 uGrassLight;
        uniform vec3 uGrassDark;
        uniform vec3 uGrassDry;
        uniform vec3 uDirt;
        uniform vec3 uRockLight;
        uniform vec3 uRockDark;
        uniform vec3 uRockDeep;
        uniform float uHighlight;
        uniform float uDry;
        varying float vRock;
        varying float vDepth;
        varying float vWorn;
        varying vec3 vWorld;
        varying vec3 vWorldNormal;`)
      .replace("#include <map_fragment>", `
        vec3 p = vWorld;
        float macro = texture2D(tNoise, p.xz * 0.028).r;
        float patchy = texture2D(tNoise, p.xz * 0.011 + vec2(0.37, 0.71)).r;
        float brush = texture2D(tBrush, p.xz * 0.085 + vec2(macro * 0.15)).r;
        vec3 grass = mix(uGrassDark, uGrassLight, smoothstep(0.22, 0.88, macro * 0.62 + brush * 0.48));
        grass = mix(grass, uGrassDry, smoothstep(0.6 - uDry * 0.25, 0.92, patchy) * (0.3 + uDry * 0.45));
        float worn = clamp(vWorn * (0.75 + brush * 0.5), 0.0, 1.0);
        vec3 dirt = uDirt * (0.86 + brush * 0.26);
        vec3 ground = mix(grass, dirt, smoothstep(0.25, 0.75, worn));

        vec3 blend = pow(abs(normalize(vWorldNormal)), vec3(4.0));
        blend /= (blend.x + blend.y + blend.z);
        float rb = texture2D(tBrush, p.zy * 0.12).r * blend.x
          + texture2D(tBrush, p.xz * 0.12).r * blend.y
          + texture2D(tBrush, p.xy * 0.12).r * blend.z;
        float rn = texture2D(tNoise, p.zy * 0.05).r * blend.x
          + texture2D(tNoise, p.xz * 0.05).r * blend.y
          + texture2D(tNoise, p.xy * 0.05).r * blend.z;
        // Sediment: bands of slightly different stone, tilted by noise, with
        // darker seams between them.
        float tilt = texture2D(tNoise, p.xz * 0.018 + vec2(0.13, 0.57)).r;
        float layer = p.y * 0.8 + rn * 2.2 + tilt * 3.0;
        float band = fract(layer);
        float tone = fract(sin(floor(layer) * 12.9898) * 43758.5453);
        // Only some bands end in a seam, and seams fade in and out along the cliff.
        float seam = (1.0 - smoothstep(0.0, 0.12, band)) * step(0.5, tone) * smoothstep(0.35, 0.7, rb);
        // Weathering: vertical streaks that run down the cliff.
        vec2 streakUv = vec2((p.x + p.z) * 0.22, p.y * 0.018);
        float streak = texture2D(tNoise, streakUv).r;
        vec3 rock = mix(uRockDark, uRockLight, smoothstep(0.15, 0.9, rb * 0.5 + tone * 0.3 + rn * 0.25));
        rock *= 0.9 + streak * 0.2;
        rock *= 1.0 - seam * 0.26;
        rock = mix(rock, uRockDeep, smoothstep(0.18, 1.0, vDepth) * 0.85);
        // Contact shadow under the grass overhang.
        rock *= 0.72 + 0.28 * smoothstep(0.03, 0.14, vDepth);
        // Grass creeps a little over the cliff top before rock takes over.
        float rockMask = vRock * smoothstep(0.012, 0.05 + rb * 0.05, vDepth);
        diffuseColor = vec4(mix(ground, rock, rockMask), opacity);
        diffuseColor.rgb += uHighlight * vec3(0.10, 0.09, 0.05) * (1.0 - rockMask);
      `);
  };
  material.customProgramCacheKey = () => "sky-terrain";
  return material;
}

/** Bakes 0 (inside the crown) .. 1 (outer leaves) for the foliage gradient. */
export function bakeCanopy(geometry: THREE.BufferGeometry) {
  const position = geometry.getAttribute("position") as THREE.BufferAttribute;
  geometry.computeBoundingBox();
  const box = geometry.boundingBox!;
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const radius = Math.max(size.x, size.z) * 0.5 || 1;
  const canopy = new Float32Array(position.count);
  const point = new THREE.Vector3();
  for (let index = 0; index < position.count; index++) {
    point.fromBufferAttribute(position, index);
    const radial = Math.hypot(point.x - center.x, point.z - center.z) / radius;
    const vertical = (point.y - box.min.y) / (size.y || 1);
    canopy[index] = THREE.MathUtils.clamp(radial * 0.62 + vertical * 0.5, 0, 1);
  }
  geometry.setAttribute("aCanopy", new THREE.BufferAttribute(canopy, 1));
}

const WIND_VERTEX = `
  float windHeight = clamp(position.y / max(uModelHeight, 0.001), 0.0, 1.0);
  vec3 windOrigin = vec3(0.0);
  #ifdef USE_INSTANCING
    windOrigin = vec3(instanceMatrix[3]);
  #endif
  float windPhase = dot(windOrigin.xz, vec2(0.41, 0.27));
  float sway = sin(uTime * 1.15 + windPhase) * 0.6 + sin(uTime * 1.9 + windPhase * 1.7) * 0.25;
  float bend = windHeight * windHeight * uWind * uWindScale;
  transformed.x += sway * bend;
  transformed.z += cos(uTime * 0.95 + windPhase * 1.3) * 0.35 * bend;
`;

export function foliageMaterial(source: THREE.MeshStandardMaterial, palette: SkyPalette, modelHeight: number, windScale = 0.06) {
  const material = source.clone();
  material.vertexColors = false;
  material.alphaTest = Math.max(0.35, source.alphaTest || 0.35);
  material.transparent = false;
  material.side = THREE.DoubleSide;
  material.roughness = 0.82;
  material.metalness = 0;
  const uniforms = {
    uLeafLight: { value: color(palette.leafLight) },
    uLeafDark: { value: color(palette.leafDark) },
    uModelHeight: { value: modelHeight },
    uWindScale: { value: windScale * modelHeight }
  };
  material.userData.uniforms = uniforms;
  material.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, uniforms, SHARED_UNIFORMS);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>
        uniform float uTime;
        uniform float uWind;
        uniform float uModelHeight;
        uniform float uWindScale;
        attribute float aCanopy;
        varying float vCanopy;
        varying float vFacing;`)
      .replace("#include <begin_vertex>", `#include <begin_vertex>
        ${WIND_VERTEX}
        // Leaf flutter on top of the branch sway.
        transformed += normal * sin(uTime * 5.3 + position.x * 4.1 + position.z * 3.7) * 0.012 * uWindScale * windHeight;
        vCanopy = aCanopy;`)
      .replace("#include <defaultnormal_vertex>", `#include <defaultnormal_vertex>
        vFacing = normalize(mat3(modelMatrix) * objectNormal).y;`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>
        uniform vec3 uLeafLight;
        uniform vec3 uLeafDark;
        uniform vec3 uSunColor;
        uniform vec3 uSunDirection;
        varying float vCanopy;
        varying float vFacing;`)
      .replace("#include <map_fragment>", `
        #ifdef USE_MAP
          float leafAlpha = texture2D(map, vMapUv).a;
        #else
          float leafAlpha = 1.0;
        #endif
        float leafShade = smoothstep(0.12, 0.95, vCanopy * 0.85 + vFacing * 0.25);
        diffuseColor.rgb = mix(uLeafDark, uLeafLight, leafShade);
        diffuseColor.a *= leafAlpha;
      `)
      .replace("#include <color_fragment>", `
        #if defined( USE_COLOR )
          // The instance colour is this tree's leaf colour (autumn, blossom,
          // alpine...); the palette's dark/light ratio shades the crown.
          diffuseColor.rgb = mix(vColor * (uLeafDark / max(uLeafLight, vec3(0.001))), vColor, leafShade);
        #endif
      `)
      .replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>
        // Soft light through the outer leaves when looking toward the sun.
        float through = pow(max(0.0, dot(normalize(-vViewPosition), normalize((viewMatrix * vec4(uSunDirection, 0.0)).xyz)) * -1.0), 3.0);
        totalEmissiveRadiance += uSunColor * diffuseColor.rgb * through * vCanopy * 0.35;`);
  };
  material.customProgramCacheKey = () => `sky-foliage-${windScale}`;
  return material;
}

export function swayMaterial(source: THREE.MeshStandardMaterial, modelHeight: number, windScale: number, gradient?: { root: string; tip: string }) {
  const material = source.clone();
  material.roughness = 0.9;
  material.metalness = 0;
  material.side = THREE.DoubleSide;
  const uniforms = {
    uModelHeight: { value: modelHeight },
    uWindScale: { value: windScale * modelHeight },
    uRoot: { value: color(gradient?.root ?? "#4b6b2a") },
    uTip: { value: color(gradient?.tip ?? "#b8cc6a") }
  };
  material.userData.uniforms = uniforms;
  // The grass gradient runs root to tip by height; the instance colour (one
  // per island) tints it to the island's ground tone.
  if (gradient) material.vertexColors = false;
  material.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, uniforms, SHARED_UNIFORMS);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>
        uniform float uTime;
        uniform float uWind;
        uniform float uModelHeight;
        uniform float uWindScale;`)
      .replace("#include <begin_vertex>", `#include <begin_vertex>
        ${WIND_VERTEX}
        vGrassT = windHeight;`)
      .replace("#include <common>", `#include <common>
        varying float vGrassT;`);
    if (gradient) {
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", `#include <common>
          uniform vec3 uRoot;
          uniform vec3 uTip;
          varying float vGrassT;`)
        .replace("#include <color_fragment>", `
          diffuseColor.rgb = mix(uRoot, uTip, smoothstep(0.0, 0.85, vGrassT));
          #if defined( USE_COLOR )
            diffuseColor.rgb *= vColor;
          #endif`);
    }
  };
  material.customProgramCacheKey = () => `sky-sway-${windScale}-${gradient ? "gradient" : "map"}`;
  return material;
}

export function waterMaterial(palette: SkyPalette) {
  const uniforms = {
    uShallow: { value: color(palette.water) },
    uDeep: { value: color(palette.waterDeep) },
    uSky: { value: color(palette.skyHorizon) }
  };
  const material = new THREE.MeshStandardMaterial({ roughness: 0.18, metalness: 0, transparent: true, opacity: 0.92 });
  material.userData.uniforms = uniforms;
  material.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, uniforms, SHARED_UNIFORMS);
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
        uniform vec3 uSky;
        uniform float uTime;
        varying vec2 vDisc;
        varying vec3 vWaterWorld;`)
      .replace("#include <map_fragment>", `
        float edge = length(vDisc);
        float ripple = sin(vWaterWorld.x * 3.1 + uTime * 1.3) * sin(vWaterWorld.z * 2.7 - uTime * 1.1);
        vec3 water = mix(uDeep, uShallow, smoothstep(0.1, 0.95, edge));
        float foam = smoothstep(0.84, 0.93, edge + ripple * 0.025) * (1.0 - smoothstep(0.97, 1.0, edge));
        water = mix(water, vec3(0.94, 0.97, 0.96), foam * 0.75);
        diffuseColor = vec4(water, opacity * smoothstep(1.0, 0.94, edge));
      `)
      .replace("#include <normal_fragment_maps>", `#include <normal_fragment_maps>
        normal = normalize(normal + vec3(sin(vWaterWorld.x * 4.0 + uTime * 1.6), 0.0, cos(vWaterWorld.z * 3.6 - uTime * 1.4)) * 0.06);`);
  };
  material.customProgramCacheKey = () => "sky-water";
  return material;
}

export function skyDomeMaterial(palette: SkyPalette) {
  return new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      uZenith: { value: color(palette.skyZenith) },
      uHorizon: { value: color(palette.skyHorizon) },
      uBelow: { value: color(palette.skyBelow) },
      uSunColor: SHARED_UNIFORMS.uSunColor,
      uSunDirection: SHARED_UNIFORMS.uSunDirection
    },
    vertexShader: `
      varying vec3 vDirection;
      void main() {
        vDirection = normalize(position);
        vec4 clip = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        gl_Position = clip.xyww;
      }`,
    fragmentShader: `
      uniform vec3 uZenith;
      uniform vec3 uHorizon;
      uniform vec3 uBelow;
      uniform vec3 uSunColor;
      uniform vec3 uSunDirection;
      varying vec3 vDirection;
      void main() {
        float h = vDirection.y;
        vec3 sky = mix(uHorizon, uZenith, smoothstep(0.0, 0.55, h));
        sky = mix(sky, uBelow, smoothstep(0.0, -0.25, h));
        float sun = max(0.0, dot(normalize(vDirection), normalize(uSunDirection)));
        sky += uSunColor * (pow(sun, 18.0) * 0.28 + pow(sun, 420.0) * 1.2);
        gl_FragColor = vec4(sky, 1.0);
        #include <colorspace_fragment>
      }`
  });
}

export const MAX_CLOUD_SHADOWS = 40;

/**
 * A layer of the cloud sea. The relief is computed per pixel (no displaced
 * mesh, so no facets at any distance): billows lit from the sun side, blue
 * crevices, soft shadows cast by the islands above, and a fade into the
 * horizon haze. The base layer is opaque; upper layers are sparse wisps.
 */
export function cloudLayerMaterial(palette: SkyPalette, layer: { coverage: number; scale: number; speed: number; opacity: number; base: boolean }) {
  const shadows = Array.from({ length: MAX_CLOUD_SHADOWS }, () => new THREE.Vector4());
  return new THREE.ShaderMaterial({
    transparent: !layer.base,
    depthWrite: false,
    uniforms: {
      uTime: SHARED_UNIFORMS.uTime,
      uSunDirection: SHARED_UNIFORMS.uSunDirection,
      uLit: { value: color(palette.cloudLit) },
      uShade: { value: color(palette.cloudShade) },
      uDeep: { value: color(palette.cloudDeep) },
      uHorizon: { value: color(palette.fog) },
      uCoverage: { value: layer.coverage },
      uScale: { value: layer.scale },
      uSpeed: { value: layer.speed },
      uOpacity: { value: layer.opacity },
      uFade: { value: new THREE.Vector2(200, 600) },
      uShadows: { value: shadows },
      uShadowCount: { value: 0 }
    },
    defines: { MAX_SHADOWS: MAX_CLOUD_SHADOWS, BASE_LAYER: layer.base ? 1 : 0 },
    vertexShader: `
      varying vec3 vWorld;
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorld = world.xyz;
        gl_Position = projectionMatrix * viewMatrix * world;
      }`,
    fragmentShader: `
      uniform float uTime;
      uniform vec3 uSunDirection;
      uniform vec3 uLit;
      uniform vec3 uShade;
      uniform vec3 uDeep;
      uniform vec3 uHorizon;
      uniform float uCoverage;
      uniform float uScale;
      uniform float uSpeed;
      uniform float uOpacity;
      uniform vec2 uFade;
      uniform vec4 uShadows[MAX_SHADOWS];
      uniform int uShadowCount;
      varying vec3 vWorld;
      float hash(vec2 p) {
        p = fract(p * vec2(123.34, 456.21));
        p += dot(p, p + 45.32);
        return fract(p.x * p.y);
      }
      float noise(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
      }
      const mat2 ROTATE = mat2(0.8, -0.6, 0.6, 0.8);
      float fbm(vec2 p) {
        float value = 0.0, amplitude = 0.5;
        for (int i = 0; i < 5; i++) {
          value += amplitude * noise(p);
          p = ROTATE * p * 2.03 + vec2(1.7, 9.2);
          amplitude *= 0.5;
        }
        return value;
      }
      float density(vec2 q, vec2 drift) {
        float macro = fbm(q * 0.27 + vec2(5.2, 1.3) + drift * 0.3);
        return fbm(q + drift) * 0.72 + macro * 0.5;
      }
      void main() {
        vec2 drift = vec2(uTime * uSpeed, uTime * uSpeed * 0.37);
        vec2 q = vWorld.xz * uScale;
        float d = density(q, drift);
        float cover = smoothstep(uCoverage, uCoverage + 0.2, d);
        // Relief: compare with the density a step toward the sun.
        vec2 sunStep = normalize(uSunDirection.xz + vec2(1e-4)) * 0.11;
        float toward = density(q + sunStep, drift);
        float light = clamp(0.58 + (d - toward) * 5.5 + (d - uCoverage) * 0.8, 0.0, 1.0);
        vec3 cloud = mix(uShade, uLit, smoothstep(0.05, 0.95, light));
        cloud = mix(uDeep, cloud, 0.5 + 0.5 * smoothstep(0.0, 0.7, cover));
        float shade = 0.0;
        for (int i = 0; i < MAX_SHADOWS; i++) {
          if (i >= uShadowCount) break;
          vec4 s = uShadows[i];
          float distance = length(vWorld.xz - s.xy) / s.z + (d - 0.5) * 0.35;
          shade = max(shade, (1.0 - smoothstep(0.5, 1.1, distance)) * s.w);
        }
        cloud = mix(cloud, cloud * vec3(0.7, 0.76, 0.9), shade);
        float fade = smoothstep(uFade.x, uFade.y, length(vWorld - cameraPosition));
        cloud = mix(cloud, uHorizon, fade);
        #if BASE_LAYER == 1
          gl_FragColor = vec4(cloud, 1.0);
        #else
          gl_FragColor = vec4(cloud, cover * uOpacity * (1.0 - fade * 0.8));
        #endif
        #include <colorspace_fragment>
      }`
  });
}
