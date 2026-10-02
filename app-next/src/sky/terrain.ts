// Island terrain: an organic outline, a gentle grassy top with flattened pads
// for buildings and basins for ponds, and one continuous rock skirt: a cliff
// band under the grass lip, then an underside shaped like earth torn from the
// ground — several hanging rock masses of different depths with terraced
// strata, not a single cone — and a few spires below the deepest masses.
// Everything derives from a seed, and objects are placed with `heightAt`, the
// same function that built the mesh, so nothing floats or sinks.
import * as THREE from "three";
import { fbm2, fbm3, noise2, seededRandom, smoothstep } from "./noise";

export type Pad = { x: number; z: number; radius: number; level?: number };
export type Pond = { x: number; z: number; radius: number; depth: number; level?: number };
export type PathLine = { points: Array<[number, number]>; width: number };

export class IslandShape {
  readonly radius: number;
  readonly seed: number;
  readonly relief: number;
  pads: Pad[] = [];
  ponds: Pond[] = [];
  paths: PathLine[] = [];
  private harmonics: Array<{ k: number; amplitude: number; phase: number }>;
  private elongation: number;
  private elongAngle: number;
  private masses: Array<{ x: number; z: number; width: number; depth: number }>;
  readonly bottomDepth: number;
  readonly spires: Array<{ angle: number; distance: number; radius: number; length: number }>;

  constructor(radius: number, seed: number) {
    this.radius = radius;
    this.seed = seed;
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
    const spireCount = radius > 5 ? 2 + Math.floor(random() * 2) : 1;
    this.spires = Array.from({ length: spireCount }, (_, index) => {
      const mass = this.masses[index % this.masses.length];
      return {
        angle: Math.atan2(mass.z, mass.x),
        distance: Math.hypot(mass.x, mass.z) / radius,
        radius: radius * (0.07 + random() * 0.05),
        length: radius * (index === 0 ? 0.3 + random() * 0.2 : 0.12 + random() * 0.18)
      };
    });
  }

  rimRadius(theta: number): number {
    let factor = 1;
    for (const harmonic of this.harmonics) factor += harmonic.amplitude * Math.sin(harmonic.k * theta + harmonic.phase);
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
    const hills = fbm2(x / scale + 11.3, z / scale - 4.1, this.seed, 3) * this.relief;
    const dome = (1 - Math.min(1, q) ** 2) * this.relief * 0.9;
    // Rounded grass lip before the cliff, so the edge reads soft, not cut.
    const lip = smoothstep(0.8, 1.0, q) ** 1.5 * Math.min(0.75, this.radius * 0.07);
    return dome + hills - lip;
  }

  heightAt(x: number, z: number): number {
    let height = this.baseHeight(x, z);
    for (const pad of this.pads) {
      const level = pad.level ?? (pad.level = this.baseHeight(pad.x, pad.z));
      const distance = Math.hypot(x - pad.x, z - pad.z);
      const weight = 1 - smoothstep(pad.radius, pad.radius + Math.max(0.8, pad.radius * 0.6), distance);
      height += (level - height) * weight;
    }
    for (const pond of this.ponds) {
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
    return height;
  }

  pondLevel(pond: Pond): number {
    if (pond.level === undefined) pond.level = this.baseHeight(pond.x, pond.z) - 0.12;
    return pond.level;
  }

  /** 0..1 worn-path weight. */
  pathWeight(x: number, z: number): number {
    let weight = 0;
    for (const path of this.paths) {
      for (let index = 1; index < path.points.length; index++) {
        const [ax, az] = path.points[index - 1], [bx, bz] = path.points[index];
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
    return this.ponds.some(pond => Math.hypot(x - pond.x, z - pond.z) < pond.radius + margin);
  }

  /** Cliff height under the grass lip. */
  get cliff(): number {
    return Math.min(this.radius * 0.34, 2.2);
  }

  /** Depth of the underside below the cliff foot at (x, z): zero on the rim,
   * deepest under the hanging masses, with terraced strata. */
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
    const step = Math.max(0.45, this.radius * 0.085);
    const level = depth / step, floor = Math.floor(level);
    const terraced = step * (floor + smoothstep(0.3, 0.7, level - floor));
    return Math.max(0, depth * 0.45 + terraced * 0.55);
  }

  buildGeometry(quality = 1): THREE.BufferGeometry {
    // Coarse on purpose: smooth toon grass needs little, and the faceted rock
    // underneath reads as chunky cartoon planes.
    const segments = Math.round(THREE.MathUtils.clamp(this.radius * 8, 48, 96) * quality);
    const rings = Math.round(THREE.MathUtils.clamp(this.radius * 2.2, 10, 26) * quality);
    const positions: number[] = [];
    const rock: number[] = [];
    const depth: number[] = [];
    const worn: number[] = [];
    const indices: number[] = [];

    // Top: a centre vertex plus concentric rings, denser near the rim.
    const rimCache: Array<{ r: number; y: number; theta: number }> = [];
    positions.push(0, this.heightAt(0, 0), 0);
    rock.push(0); depth.push(0); worn.push(this.pathWeight(0, 0));
    for (let ring = 1; ring <= rings; ring++) {
      const q = 1 - (1 - ring / rings) ** 1.25;
      for (let segment = 0; segment < segments; segment++) {
        const theta = (segment / segments) * Math.PI * 2;
        const r = this.rimRadius(theta) * q;
        const x = Math.cos(theta) * r, z = Math.sin(theta) * r;
        const y = this.heightAt(x, z);
        positions.push(x, y, z);
        rock.push(0); depth.push(0); worn.push(this.pathWeight(x, z));
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
          radius += Math.sign(strata) * Math.abs(strata) ** 0.4 * this.radius * 0.012;
          radius += fbm3(cos * radius * 0.45, y * 0.3, sin * radius * 0.45, this.seed + 5, 3) * this.radius * 0.035;
        }
        if (ring === cliffRings) foot.push({ r: radius, y });
        positions.push(cos * radius, y, sin * radius);
        rock.push(1); depth.push(((rimY - y) / maxDepth) * 0.6); worn.push(0);
      }
    }
    // Part 2: the underside, rings from the cliff foot in to the axis, each
    // vertex hanging by the depth field below the foot level.
    const underRings = Math.round(9 * quality) + 4;
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
        radius += fbm3(x * 0.4, y * 0.35, z * 0.4, this.seed + 17, 3) * this.radius * 0.05 * q * (1 - q) * 4;
        positions.push(cos * Math.max(0, radius), y, sin * Math.max(0, radius));
        rock.push(1); depth.push(Math.min(1, 0.25 + ((footLevel - y + cliff) / maxDepth) * 0.75)); worn.push(0);
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

    // Hanging spires: they start inside the underside, so the joint is hidden.
    for (const spire of this.spires) {
      const cx = Math.cos(spire.angle) * this.radius * spire.distance;
      const cz = Math.sin(spire.angle) * this.radius * spire.distance;
      const top = this.heightAt(cx, cz) - this.cliff - this.undersideDepth(cx, cz) * 0.85;
      const start = positions.length / 3;
      const spireRings = 8, spireSegments = 14;
      for (let ring = 0; ring <= spireRings; ring++) {
        const u = ring / spireRings;
        for (let segment = 0; segment < spireSegments; segment++) {
          const theta = (segment / spireSegments) * Math.PI * 2;
          const wobble = 1 + noise2(theta * 2, u * 3, this.seed + spire.angle * 10) * 0.18;
          const radius = spire.radius * (1 - u) ** 0.8 * wobble;
          const y = top - spire.length * u;
          positions.push(cx + Math.cos(theta) * radius, y, cz + Math.sin(theta) * radius);
          rock.push(1); depth.push(0.55 + u * 0.45); worn.push(0);
        }
      }
      for (let ring = 0; ring < spireRings; ring++) {
        const a = start + ring * spireSegments, b = start + (ring + 1) * spireSegments;
        for (let segment = 0; segment < spireSegments; segment++) {
          const next = (segment + 1) % spireSegments;
          indices.push(a + segment, a + next, b + segment, a + next, b + next, b + segment);
        }
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute("aRock", new THREE.Float32BufferAttribute(rock, 1));
    geometry.setAttribute("aDepth", new THREE.Float32BufferAttribute(depth, 1));
    geometry.setAttribute("aWorn", new THREE.Float32BufferAttribute(worn, 1));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    geometry.computeBoundingBox();
    return geometry;
  }
}
