// Island terrain: an organic outline, a gentle grassy top with flattened pads
// for buildings and basins for ponds, and one continuous rock skirt: a cliff
// band under the grass lip, then an underside shaped like earth torn from the
// ground — several rounded hanging rock masses of different depths.
// Everything derives from a seed, and objects are placed with `heightAt`, the
// same function that built the mesh, so nothing floats or sinks.
// A climate profile reshapes the top: a snowy peak, a flat-topped mesa, a
// gentle dome, a volcano with a crater, or stepped rice terraces.
import * as THREE from "three";
import type { TerrainProfile } from "./climates";
import { fbm2, fbm3, noise2, seededRandom, smoothstep } from "./noise";

/** A mountain or volcano cone on the island top (island-local units). */
export type TerrainFeature = {
  x: number;
  z: number;
  radius: number;
  height: number;
  /** Crater radius as a fraction of the cone radius (0: a peak). */
  crater: number;
  /** Crater depth as a fraction of the cone height. */
  craterDepth: number;
  shoulder: { x: number; z: number; radius: number; height: number } | null;
};

type ProfileShape = { dome: number; hills: number; lipStart: number; lip: number; cliff: number };
const PROFILES: Record<TerrainProfile, ProfileShape> = {
  rolling: { dome: 1, hills: 1, lipStart: 0.8, lip: 1, cliff: 1 },
  peak: { dome: 0.8, hills: 0.75, lipStart: 0.8, lip: 1, cliff: 1 },
  crater: { dome: 0.7, hills: 0.6, lipStart: 0.8, lip: 1, cliff: 1.05 },
  mesa: { dome: 0.22, hills: 0.3, lipStart: 0.9, lip: 0.55, cliff: 1.45 },
  dome: { dome: 1.7, hills: 0.45, lipStart: 0.76, lip: 1.15, cliff: 0.9 },
  terraces: { dome: 0, hills: 0.5, lipStart: 0.86, lip: 0.6, cliff: 1 }
};

export type Pad = { x: number; z: number; radius: number; level?: number };
export type Pond = { x: number; z: number; radius: number; depth: number; level?: number };
export type PathLine = { points: Array<[number, number]>; width: number };
export type WaterChannel = { from: [number, number]; to: [number, number]; width: number; level: number };

export class IslandShape {
  readonly radius: number;
  readonly seed: number;
  readonly relief: number;
  pads: Pad[] = [];
  ponds: Pond[] = [];
  paths: PathLine[] = [];
  channels: WaterChannel[] = [];
  private harmonics: Array<{ k: number; amplitude: number; phase: number }>;
  private elongation: number;
  private elongAngle: number;
  private masses: Array<{ x: number; z: number; width: number; depth: number }>;
  readonly bottomDepth: number;
  readonly profile: TerrainProfile;
  readonly feature: TerrainFeature | null = null;
  private shapeSpec: ProfileShape;
  private terraceStep = 0;

  constructor(radius: number, seed: number, profile: TerrainProfile = "rolling") {
    this.radius = radius;
    this.seed = seed;
    this.profile = PROFILES[profile] ? profile : "rolling";
    this.shapeSpec = PROFILES[this.profile];
    const random = seededRandom(seed);
    this.relief = THREE.MathUtils.clamp(radius * 0.055, 0.22, 0.85);
    this.harmonics = [2, 3, 4, 5, 7].map((k, index) => ({
      k,
      amplitude: [0.07, 0.05, 0.035, 0.022, 0.012][index] * (0.6 + random() * 0.8),
      phase: random() * Math.PI * 2
    }));
    this.elongation = 1 + random() * 0.22;
    this.elongAngle = random() * Math.PI;
    // Hanging masses: one main body near the centre and a few smaller ones
    // around it, so the silhouette from any side has several bulges.
    const massCount = 3 + Math.floor(random() * 3);
    this.masses = Array.from({ length: massCount }, (_, index) => {
      const angle = random() * Math.PI * 2;
      const distance = (index === 0 ? random() * 0.18 : 0.22 + random() * 0.38) * radius;
      return {
        x: Math.cos(angle) * distance,
        z: Math.sin(angle) * distance,
        width: radius * (index === 0 ? 0.36 + random() * 0.1 : 0.17 + random() * 0.13),
        depth: index === 0 ? 1 : 0.55 + random() * 0.4
      };
    });
    this.bottomDepth = radius * (0.85 + random() * 0.3);
    // Profile features draw from their own stream, so a rolling island keeps
    // exactly the shape it always had.
    const extra = seededRandom((seed ^ 0x5bd1e995) >>> 0);
    if (this.profile === "peak" || this.profile === "crater") {
      const peak = this.profile === "peak";
      const side = extra() < 0.5 ? -1 : 1;
      // Toward the back, off to one side: the house keeps the front.
      const angle = -Math.PI / 2 + side * (0.4 + extra() * 0.5);
      const distance = radius * (0.2 + extra() * 0.1);
      const coneRadius = radius * (peak ? 0.5 : 0.52);
      const height = this.relief * (peak ? 2.6 : 2.4) + radius * (peak ? 0.46 : 0.4);
      // The shoulder sits further out on the same side, never on the house's.
      const shoulderAngle = angle + side * (0.9 + extra() * 0.4);
      this.feature = {
        x: Math.cos(angle) * distance,
        z: Math.sin(angle) * distance,
        radius: coneRadius,
        height,
        crater: peak ? 0 : 0.3,
        craterDepth: peak ? 0 : 0.4,
        shoulder: peak ? {
          x: Math.cos(angle) * distance + Math.cos(shoulderAngle) * coneRadius * 0.48,
          z: Math.sin(angle) * distance + Math.sin(shoulderAngle) * coneRadius * 0.48,
          radius: coneRadius * 0.58,
          height: height * (0.42 + extra() * 0.12)
        } : null
      };
    }
    if (this.profile === "terraces") {
      const levels = 3 + Math.floor(extra() * 3);
      this.terraceStep = (radius * 0.4) / levels;
    }
  }

  /** Height the cone adds at (x, z). */
  private featureHeight(x: number, z: number): number {
    const feature = this.feature;
    if (!feature) return 0;
    const dx = x - feature.x, dz = z - feature.z;
    const distance = Math.hypot(dx, dz);
    let height = 0;
    if (distance < feature.radius * 1.3) {
      // Ridges: the cone's reach varies a little with direction.
      const angle = Math.atan2(dz, dx);
      const ridge = 1 + 0.14 * noise2(Math.cos(angle) * 1.6 + 3.1, Math.sin(angle) * 1.6 - 2.3, this.seed + 23);
      // A slightly rounded tip: a sharp cusp shows as a spike between vertices.
      const t = Math.min(1, Math.hypot(distance / (feature.radius * ridge), 0.05));
      if (feature.crater > 0) {
        const cone = (u: number) => feature.height * (1 - u) ** 1.1;
        if (t >= feature.crater) height = cone(t);
        else {
          const rim = cone(feature.crater);
          const inner = t / feature.crater;
          height = rim - feature.height * feature.craterDepth * (1 - inner * inner);
        }
      } else {
        height = feature.height * (1 - t) ** 1.7;
      }
    }
    const shoulder = feature.shoulder;
    if (shoulder) {
      const t = Math.min(1, Math.hypot(x - shoulder.x, z - shoulder.z) / shoulder.radius);
      height = Math.max(height, shoulder.height * (1 - t) ** 1.6);
    }
    return height;
  }

  /** 0 outside the cone, 1 on its upper slopes: keep buildings off it. */
  featureWeight(x: number, z: number): number {
    const feature = this.feature;
    if (!feature) return 0;
    const near = 1 - smoothstep(feature.radius * 0.45, feature.radius * 0.95, Math.hypot(x - feature.x, z - feature.z));
    const shoulder = feature.shoulder
      ? 1 - smoothstep(feature.shoulder.radius * 0.4, feature.shoulder.radius * 0.9, Math.hypot(x - feature.shoulder.x, z - feature.shoulder.z))
      : 0;
    return Math.max(near, shoulder);
  }

  /** The lava lake inside a volcano's crater (island-local). */
  craterLava(): { x: number; z: number; radius: number; y: number } | null {
    const feature = this.feature;
    if (!feature || feature.crater <= 0) return null;
    const floor = this.baseHeight(feature.x, feature.z);
    return { x: feature.x, z: feature.z, radius: feature.radius * feature.crater * 0.66, y: floor + feature.height * feature.craterDepth * 0.38 };
  }

  /** The height above which the top `cover` fraction of the cone lies. */
  coverLine(cover: number): number {
    const feature = this.feature;
    if (!feature) return 1e6;
    const rise = feature.crater > 0 ? feature.height * (1 - feature.crater) ** 1.1 : feature.height;
    return this.summit() - cover * rise;
  }

  /** Highest point of the top surface (island-local), for framing. */
  summit(): number {
    if (!this.feature) return this.baseHeight(0, 0);
    const feature = this.feature;
    return this.baseHeight(feature.x, feature.z) + (feature.crater > 0 ? feature.height * feature.craterDepth : 0);
  }

  rimRadius(theta: number): number {
    let factor = 1;
    for (let index = 0; index < this.harmonics.length; index++) {
      const harmonic = this.harmonics[index];
      factor += harmonic.amplitude * Math.sin(harmonic.k * theta + harmonic.phase);
    }
    const relative = theta - this.elongAngle;
    const ellipse = 1 / Math.sqrt((Math.cos(relative) / this.elongation) ** 2 + Math.sin(relative) ** 2);
    return this.radius * factor * (0.82 + 0.18 * ellipse);
  }

  /** 0 at the centre, 1 on the rim. */
  normalizedDistance(x: number, z: number): number {
    return Math.hypot(x, z) / this.rimRadius(Math.atan2(z, x));
  }

  private baseHeight(x: number, z: number): number {
    const q = this.normalizedDistance(x, z);
    const scale = this.radius * 0.42;
    const shape = this.shapeSpec;
    const hills = fbm2(x / scale + 11.3, z / scale - 4.1, this.seed, 3) * this.relief * shape.hills;
    const dome = (1 - Math.min(1, q) ** 2) * this.relief * 0.9 * shape.dome;
    // Rounded grass lip before the cliff, so the edge reads soft, not cut.
    const lip = smoothstep(shape.lipStart, 1.0, q) ** 1.5 * Math.min(0.75, this.radius * 0.07) * shape.lip;
    let height = dome + hills - lip;
    if (this.feature) height += this.featureHeight(x, z);
    if (this.terraceStep > 0) {
      // Rice terraces: a tall dome cut into flat rings with short risers.
      const tall = (1 - Math.min(1, q) ** 2) * this.radius * 0.4 + hills;
      const level = tall / this.terraceStep;
      const floor = Math.floor(level);
      height = (floor + smoothstep(0.8, 1, level - floor)) * this.terraceStep - lip;
    }
    return height;
  }

  heightAt(x: number, z: number): number {
    let height = this.baseHeight(x, z);
    // Walking animals call this every frame: index loops, no iterators.
    for (let index = 0; index < this.pads.length; index++) {
      const pad = this.pads[index];
      const level = pad.level ?? (pad.level = this.baseHeight(pad.x, pad.z));
      const distance = Math.hypot(x - pad.x, z - pad.z);
      const weight = 1 - smoothstep(pad.radius, pad.radius + Math.max(0.8, pad.radius * 0.6), distance);
      height += (level - height) * weight;
    }
    for (let index = 0; index < this.ponds.length; index++) {
      const pond = this.ponds[index];
      const level = this.pondLevel(pond);
      const distance = Math.hypot(x - pond.x, z - pond.z) / pond.radius;
      if (distance < 1.35) {
        const bank = level + 0.06 + (1 - smoothstep(0.85, 1.35, distance)) * 0;
        const basin = level - pond.depth * (1 - smoothstep(0.2, 1.0, distance));
        // Inside the pond the floor is the basin; on the bank the ground
        // eases down to just above the water so the shore meets it.
        const weight = 1 - smoothstep(0.95, 1.35, distance);
        height = height * (1 - weight) + Math.min(bank, height) * weight;
        if (distance < 1) height = Math.min(height, basin);
      }
    }
    for (let index = 0; index < this.channels.length; index++) {
      const channel = this.channels[index];
      const ax = channel.from[0], az = channel.from[1], bx = channel.to[0], bz = channel.to[1];
      const dx = bx - ax, dz = bz - az;
      const t = THREE.MathUtils.clamp(((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz), 0, 1);
      const distance = Math.hypot(x - ax - dx * t, z - az - dz * t);
      const weight = 1 - smoothstep(channel.width * 0.48, channel.width * 0.95, distance);
      height += (Math.min(height, channel.level - 0.1) - height) * weight;
    }
    return height;
  }

  pondLevel(pond: Pond): number {
    if (pond.level === undefined) pond.level = this.baseHeight(pond.x, pond.z) - 0.12;
    return pond.level;
  }

  /** 0..1 worn-path weight. Walking animals ask every frame: plain
   * indexing, no destructuring or callbacks (nothing to collect). */
  pathWeight(x: number, z: number): number {
    let weight = 0;
    for (let line = 0; line < this.paths.length; line++) {
      const path = this.paths[line];
      for (let index = 1; index < path.points.length; index++) {
        const from = path.points[index - 1], to = path.points[index];
        const ax = from[0], az = from[1], bx = to[0], bz = to[1];
        const dx = bx - ax, dz = bz - az;
        const t = THREE.MathUtils.clamp(((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1), 0, 1);
        const distance = Math.hypot(x - (ax + dx * t), z - (az + dz * t));
        const wobble = noise2(x * 1.7, z * 1.7, this.seed + 7) * path.width * 0.18;
        weight = Math.max(weight, 1 - smoothstep(path.width * 0.35, path.width * 0.62 + wobble, distance));
      }
    }
    return weight;
  }

  isInsidePond(x: number, z: number, margin = 0): boolean {
    for (let index = 0; index < this.ponds.length; index++) {
      const pond = this.ponds[index];
      if (Math.hypot(x - pond.x, z - pond.z) < pond.radius + margin) return true;
    }
    for (let index = 0; index < this.channels.length; index++) {
      const channel = this.channels[index];
      const ax = channel.from[0], az = channel.from[1], bx = channel.to[0], bz = channel.to[1];
      const dx = bx - ax, dz = bz - az;
      const t = THREE.MathUtils.clamp(((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz), 0, 1);
      if (Math.hypot(x - ax - dx * t, z - az - dz * t) < channel.width * 0.6 + margin) return true;
    }
    return false;
  }

  /** Cliff height under the grass lip. */
  get cliff(): number {
    return Math.min(this.radius * 0.34, 2.2) * this.shapeSpec.cliff;
  }

  /** Depth of the underside below the cliff foot at (x, z): zero on the rim,
   * deepest under the connected hanging masses. */
  undersideDepth(x: number, z: number): number {
    const q = Math.min(1, this.normalizedDistance(x, z));
    const envelope = (1 - q * q) ** 0.55;
    let mass = 0;
    for (const item of this.masses) {
      const distance = ((x - item.x) ** 2 + (z - item.z) ** 2) / (item.width * item.width);
      mass = Math.max(mass, item.depth * Math.exp(-distance));
    }
    // The masses fade out more slowly toward the rim than the base dome, so
    // side bulges hang down on their own and break the silhouette.
    let depth = this.bottomDepth * (envelope * 0.24 + envelope ** 0.3 * 0.76 * mass);
    depth += fbm2(x * 0.32, z * 0.32, this.seed + 11, 3) * this.radius * 0.07 * envelope;
    return Math.max(0, depth);
  }

  buildGeometry(quality = 1): THREE.BufferGeometry {
    // Enough samples for pond banks and a continuous rounded silhouette.
    const segments = Math.round(THREE.MathUtils.clamp(this.radius * 10, 64, 112) * quality);
    const rings = Math.round(THREE.MathUtils.clamp(this.radius * 3.2, 16, 38) * quality);
    const positions: number[] = [];
    const rock: number[] = [];
    const depth: number[] = [];
    const worn: number[] = [];
    const rimDistance: number[] = [];
    const indices: number[] = [];

    // Top: a centre vertex plus concentric rings, denser near the rim.
    const rimCache: Array<{ r: number; y: number; theta: number }> = [];
    positions.push(0, this.heightAt(0, 0), 0);
    rock.push(0); depth.push(0); worn.push(this.pathWeight(0, 0)); rimDistance.push(0);
    for (let ring = 1; ring <= rings; ring++) {
      const q = 1 - (1 - ring / rings) ** 1.25;
      for (let segment = 0; segment < segments; segment++) {
        const theta = (segment / segments) * Math.PI * 2;
        const r = this.rimRadius(theta) * q;
        const x = Math.cos(theta) * r, z = Math.sin(theta) * r;
        const y = this.heightAt(x, z);
        positions.push(x, y, z);
        rock.push(0); depth.push(0); worn.push(this.pathWeight(x, z)); rimDistance.push(q);
        if (ring === rings) rimCache.push({ r, y, theta });
      }
    }
    for (let segment = 0; segment < segments; segment++) {
      const next = (segment + 1) % segments;
      indices.push(0, 1 + next, 1 + segment);
    }
    for (let ring = 1; ring < rings; ring++) {
      const a = 1 + (ring - 1) * segments, b = 1 + ring * segments;
      for (let segment = 0; segment < segments; segment++) {
        const next = (segment + 1) % segments;
        indices.push(a + segment, a + next, b + segment, a + next, b + next, b + segment);
      }
    }

    // Skirt, part 1: the cliff band, starting exactly on the rim ring (no
    // gap), with a slight bulge under the lip and stepped strata ledges.
    const cliff = this.cliff;
    const maxDepth = cliff + this.bottomDepth * 1.1;
    const rimLevel = rimCache.reduce((sum, item) => sum + item.y, 0) / rimCache.length;
    const skirtStart = positions.length / 3;
    const cliffRings = Math.round(5 * quality) + 3;
    const foot: Array<{ r: number; y: number }> = [];
    for (let ring = 0; ring <= cliffRings; ring++) {
      const band = ring / cliffRings;
      for (let segment = 0; segment < segments; segment++) {
        const { r: rimR, y: rimY, theta } = rimCache[segment];
        const cos = Math.cos(theta), sin = Math.sin(theta);
        let radius = rimR * (1 + Math.sin(band * Math.PI) * 0.035 - band * 0.05);
        const y = rimY - band * cliff;
        if (ring > 0) {
          const strata = Math.sin(y * 2.2 + noise2(theta * 3, y * 0.6, this.seed) * 1.6);
          radius += strata * this.radius * 0.007;
          radius += fbm3(cos * radius * 0.45, y * 0.3, sin * radius * 0.45, this.seed + 5, 3) * this.radius * 0.016;
        }
        if (ring === cliffRings) foot.push({ r: radius, y });
        positions.push(cos * radius, y, sin * radius);
        rock.push(1); depth.push(THREE.MathUtils.clamp((rimLevel - y) / maxDepth, 0, 1)); worn.push(0); rimDistance.push(1);
      }
    }
    // Part 2: the underside, rings from the cliff foot in to the axis, each
    // vertex hanging by the depth field below the foot level.
    const underRings = Math.round(18 * quality) + 4;
    const footLevel = foot.reduce((sum, item) => sum + item.y, 0) / foot.length;
    for (let ring = 1; ring <= underRings; ring++) {
      const q = 1 - (ring / underRings) ** 0.9;
      for (let segment = 0; segment < segments; segment++) {
        const { theta } = rimCache[segment];
        const cos = Math.cos(theta), sin = Math.sin(theta);
        const base = foot[segment];
        let radius = base.r * q;
        const x = cos * radius, z = sin * radius;
        const level = base.y + (footLevel - base.y) * (1 - q);
        const y = level - this.undersideDepth(x, z);
        radius += fbm3(x * 0.4, y * 0.35, z * 0.4, this.seed + 17, 3) * this.radius * 0.018 * q * (1 - q) * 4;
        positions.push(cos * Math.max(0, radius), y, sin * Math.max(0, radius));
        rock.push(1); depth.push(THREE.MathUtils.clamp((rimLevel - y) / maxDepth, 0, 1)); worn.push(0); rimDistance.push(1);
      }
    }
    const skirtRings = cliffRings + underRings;
    for (let ring = 0; ring < skirtRings; ring++) {
      const a = skirtStart + ring * segments, b = skirtStart + (ring + 1) * segments;
      for (let segment = 0; segment < segments; segment++) {
        const next = (segment + 1) % segments;
        indices.push(a + segment, a + next, b + segment, a + next, b + next, b + segment);
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute("aRock", new THREE.Float32BufferAttribute(rock, 1));
    geometry.setAttribute("aDepth", new THREE.Float32BufferAttribute(depth, 1));
    geometry.setAttribute("aWorn", new THREE.Float32BufferAttribute(worn, 1));
    geometry.setAttribute("aRim", new THREE.Float32BufferAttribute(rimDistance, 1));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    geometry.computeBoundingBox();
    return geometry;
  }
}
