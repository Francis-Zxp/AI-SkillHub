// Climate effects that are not weather: smoke puffs rising from volcano
// craters. All vents share one point cloud (one draw call); each puff's
// rise, growth and fade come from time and its seed in the vertex shader.
import * as THREE from "three";
import type { SkyPalette } from "./materials";
import { SHARED_UNIFORMS } from "./materials";

export type Smoke = { object: THREE.Points; setPalette: (palette: SkyPalette) => void; setLowPower: (lowPower: boolean) => void; dispose: () => void };

const PUFFS_PER_VENT = 14;

export function createSmoke(vents: THREE.Vector3[], scale: number, palette: SkyPalette, lowPower: boolean): Smoke {
  const count = vents.length * PUFFS_PER_VENT;
  const positions = new Float32Array(count * 3);
  const seeds = new Float32Array(count);
  // Puff-major order: low power draws the first half, still from every vent.
  vents.forEach((vent, ventIndex) => {
    for (let puff = 0; puff < PUFFS_PER_VENT; puff++) {
      const index = puff * vents.length + ventIndex;
      positions.set([vent.x, vent.y, vent.z], index * 3);
      seeds[index] = ((puff * 2) % PUFFS_PER_VENT + (puff * 2 >= PUFFS_PER_VENT ? 1 : 0) + 0.37 * ventIndex) / PUFFS_PER_VENT;
    }
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 1));
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);
  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    fog: true,
    uniforms: {
      ...THREE.UniformsLib.fog,
      uTime: SHARED_UNIFORMS.uTime,
      uWind: SHARED_UNIFORMS.uWind,
      uScale: { value: 800 },
      uSize: { value: scale },
      uLight: { value: new THREE.Color() },
      uShade: { value: new THREE.Color() }
    },
    vertexShader: `
      attribute float aSeed;
      uniform float uTime;
      uniform float uWind;
      uniform float uScale;
      uniform float uSize;
      varying float vLife;
      varying float vSeed;
      #include <fog_pars_vertex>
      void main() {
        vSeed = aSeed;
        float life = fract(uTime * 0.06 + aSeed);
        vLife = life;
        // Each puff leans its own way and the wind bends the column.
        float side = sin(aSeed * 31.0) * 0.9 + sin(uTime * 0.5 + aSeed * 12.0) * 0.25;
        vec3 world = position + vec3((life * life * 2.2 * uWind + side * life) * uSize, (life * 6.5 + life * life * 1.5) * uSize, cos(aSeed * 17.0) * 0.7 * life * uSize);
        vec4 mvPosition = viewMatrix * vec4(world, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        gl_PointSize = clamp(uSize * (0.45 + life * 2.6) * uScale / max(1.0, -mvPosition.z), 1.0, 160.0);
        #include <fog_vertex>
      }`,
    fragmentShader: `
      uniform vec3 uLight;
      uniform vec3 uShade;
      varying float vLife;
      varying float vSeed;
      #include <fog_pars_fragment>
      void main() {
        vec2 c = gl_PointCoord - 0.5;
        // Three soft lobes, placed per puff, make a cotton-ball cloud lit
        // from the upper left with one toon step.
        float turn = vSeed * 6.2831;
        vec2 a = vec2(cos(turn), sin(turn)) * 0.15, b = vec2(cos(turn + 2.3), sin(turn + 2.3)) * 0.13;
        float d = min(length(c) / 0.3, min(length(c - a) / 0.22, length(c - b) / 0.2));
        float alpha = 1.0 - smoothstep(0.8, 1.0, d);
        alpha *= smoothstep(0.0, 0.1, vLife) * (1.0 - smoothstep(0.45, 1.0, vLife)) * 0.6;
        if (alpha < 0.01) discard;
        float lit = step(0.5, 1.0 - smoothstep(0.15, 0.45, length(c - vec2(-0.12, -0.15))));
        vec3 colour = mix(uShade, uLight, max(lit, 0.25));
        gl_FragColor = vec4(colour, alpha);
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`
  });
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  points.renderOrder = 2;
  const setPalette = (next: SkyPalette) => {
    (material.uniforms.uLight.value as THREE.Color).set(next.night ? "#6f7890" : "#d9d6d2");
    (material.uniforms.uShade.value as THREE.Color).set(next.night ? "#3f4558" : "#9c9894");
  };
  const setLowPower = (value: boolean) => geometry.setDrawRange(0, value ? Math.ceil(count * 0.5) : count);
  setPalette(palette);
  setLowPower(lowPower);
  return {
    object: points,
    setPalette,
    setLowPower,
    dispose() {
      points.removeFromParent();
      geometry.dispose();
      material.dispose();
    }
  };
}

/** Point sprites are sized in pixels: keep them in step with the viewport. */
export function setPointScale(material: THREE.ShaderMaterial, pixelHeight: number, fov: number) {
  material.uniforms.uScale.value = pixelHeight / (2 * Math.tan(THREE.MathUtils.degToRad(fov / 2)));
}
