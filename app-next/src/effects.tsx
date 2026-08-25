import { useEffect, useRef, useState } from "react";

type ParticleFieldProps = {
  accent: string;
  mode?: "ambient" | "atlas" | "cosmos" | "backdrop";
  palette?: string[];
  skillCount?: number;
  sourceCount?: number;
};

type Point3 = { x: number; y: number; z: number };

type CosmosParticle = Point3 & {
  cluster: number;
  color: string;
  phase: number;
  previousX?: number;
  previousY?: number;
  radius: number;
  shell: boolean;
};

type DustParticle = {
  color: string;
  depth: number;
  phase: number;
  radius: number;
  speed: number;
  x: number;
  y: number;
};

type Orbit = {
  color: string;
  phase: number;
  radius: number;
  tiltX: number;
  tiltY: number;
  tiltZ: number;
};

/* Generative capability field.
   - cosmos: full-screen, data-shaped 3D point cloud for the Atlas home
   - backdrop: deliberately quiet ambient field for operational pages
   - ambient: compact 2.x constellation kept for the legacy themes
   Motion stops while hidden and resolves to a still composition when the OS
   requests reduced motion. No remote assets or WebGL dependency are required. */
export function ParticleField({
  accent,
  mode = "ambient",
  palette = [accent],
  skillCount = 0,
  sourceCount = 0
}: ParticleFieldProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const paletteKey = palette.join("|");

  useEffect(() => {
    const canvasElement = canvasRef.current;
    if (!canvasElement) return;
    const canvasContext = canvasElement.getContext("2d");
    if (!canvasContext) return;
    const canvas: HTMLCanvasElement = canvasElement;
    const context: CanvasRenderingContext2D = canvasContext;

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const isViewportField = mode === "cosmos" || mode === "backdrop";
    const isCosmos = mode === "cosmos" || mode === "atlas";
    const colors = palette.length ? palette : [accent];
    const dpr = Math.min(window.devicePixelRatio || 1, isCosmos ? 1.65 : 1.4);
    const random = mulberry32(0x5f3759df + skillCount * 17 + sourceCount * 31 + mode.length);

    let width = 1;
    let height = 1;
    let frame = 0;
    let visible = !document.hidden;
    let cosmosParticles: CosmosParticle[] = [];
    let dust: DustParticle[] = [];
    let orbits: Orbit[] = [];
    let links: Array<[number, number]> = [];
    const pointer = { x: 0, y: 0, targetX: 0, targetY: 0, active: false };

    function seed() {
      const area = width * height;
      const dustCount = isCosmos
        ? clamp(Math.round(area / 9000), 100, 240)
        : mode === "backdrop"
          ? clamp(Math.round(area / 18000), 45, 110)
          : clamp(Math.round(area / 17000), 32, 80);

      dust = Array.from({ length: dustCount }, () => ({
        color: colors[Math.floor(random() * colors.length)],
        depth: 0.28 + random() * 0.72,
        phase: random() * Math.PI * 2,
        radius: 0.35 + random() * (isCosmos ? 1.45 : 1.05),
        speed: 0.04 + random() * 0.11,
        x: random() * width,
        y: random() * height
      }));

      if (!isCosmos) {
        cosmosParticles = [];
        orbits = [];
        links = [];
        return;
      }

      const particleCount = clamp(
        Math.round(area / 1550) + Math.round(Math.sqrt(Math.max(skillCount, 1)) * 8),
        540,
        1320
      );
      const clusterCount = clamp(Math.round(Math.sqrt(Math.max(sourceCount, 4))), 4, 9);
      const clusterDirections = Array.from({ length: clusterCount }, (_, index) => {
        const y = 1 - ((index + 0.55) / clusterCount) * 2;
        const radial = Math.sqrt(Math.max(0, 1 - y * y));
        const angle = index * 2.399963229728653;
        return { x: Math.cos(angle) * radial, y, z: Math.sin(angle) * radial };
      });

      cosmosParticles = Array.from({ length: particleCount }, (_, index) => {
        const shell = random() < 0.58;
        const direction = unitVector(random);
        const cluster = index % clusterCount;
        const clusterDirection = clusterDirections[cluster];
        const clustered = random() < 0.5;
        const blend = clustered ? 0.7 + random() * 0.2 : 0;
        const mixed = normalize3({
          x: direction.x * (1 - blend) + clusterDirection.x * blend + gaussian(random) * 0.09,
          y: direction.y * (1 - blend) + clusterDirection.y * blend + gaussian(random) * 0.09,
          z: direction.z * (1 - blend) + clusterDirection.z * blend + gaussian(random) * 0.09
        });
        const radius = shell ? 0.84 + random() * 0.17 : Math.pow(random(), 0.42) * 0.88;
        const bright = clustered && random() > 0.78;
        return {
          x: mixed.x * radius,
          y: mixed.y * radius,
          z: mixed.z * radius,
          cluster,
          color: bright ? colors[(cluster + 1) % colors.length] : colors[cluster % colors.length],
          phase: random() * Math.PI * 2,
          radius: bright ? 1.25 + random() * 1.8 : 0.38 + random() * 1.15,
          shell
        };
      });

      const orbitCount = clamp(10 + clusterCount * 2, 14, 26);
      orbits = Array.from({ length: orbitCount }, (_, index) => ({
        color: colors[index % colors.length],
        phase: random() * Math.PI * 2,
        radius: 0.72 + random() * 0.64,
        tiltX: random() * Math.PI,
        tiltY: random() * Math.PI,
        tiltZ: random() * Math.PI
      }));

      const linkCount = Math.min(190, Math.round(particleCount * 0.18));
      links = Array.from({ length: linkCount }, (_, index) => {
        const first = Math.floor(random() * particleCount);
        const stride = 1 + Math.floor(random() * Math.max(3, particleCount / clusterCount));
        const second = (first + stride * clusterCount + index) % particleCount;
        return [first, second];
      });
    }

    function resize() {
      const rect = isViewportField
        ? { width: window.innerWidth, height: window.innerHeight }
        : (canvas.parentElement?.getBoundingClientRect() ?? canvas.getBoundingClientRect());
      width = Math.max(1, Math.floor(rect.width));
      height = Math.max(1, Math.floor(rect.height));
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      seed();
      draw(reduceMotion ? 3200 : performance.now());
    }

    function draw(time: number) {
      context.clearRect(0, 0, width, height);
      drawDust(time);
      if (isCosmos) drawCosmos(time);
      else drawAmbientLinks(time);
    }

    function drawDust(time: number) {
      const motion = reduceMotion ? 0 : time * 0.001;
      context.save();
      context.globalCompositeOperation = "lighter";
      for (const item of dust) {
        const driftX = Math.sin(motion * item.speed + item.phase) * 14 * item.depth;
        const driftY = Math.cos(motion * item.speed * 0.7 + item.phase) * 9 * item.depth;
        const parallaxX = pointer.x * 18 * item.depth;
        const parallaxY = pointer.y * 12 * item.depth;
        const x = wrap(item.x + driftX + parallaxX, width);
        const y = wrap(item.y + driftY + parallaxY, height);
        const pulse = reduceMotion ? 0.65 : 0.46 + Math.sin(time * 0.0012 + item.phase) * 0.2;
        context.beginPath();
        context.arc(x, y, item.radius * item.depth, 0, Math.PI * 2);
        context.fillStyle = colorAlpha(item.color, pulse * (mode === "backdrop" ? 0.34 : 0.7));
        context.fill();
      }
      context.restore();
    }

    function drawAmbientLinks(time: number) {
      if (dust.length < 2) return;
      const maxDistance = Math.min(148, width / 8);
      context.save();
      context.lineWidth = 0.7;
      for (let index = 0; index < dust.length; index += mode === "backdrop" ? 2 : 1) {
        const a = dust[index];
        const b = dust[(index * 11 + 7) % dust.length];
        const ax = wrap(a.x + Math.sin(time * 0.00008 + a.phase) * 10, width);
        const ay = wrap(a.y + Math.cos(time * 0.00007 + a.phase) * 8, height);
        const bx = wrap(b.x + Math.sin(time * 0.00009 + b.phase) * 10, width);
        const by = wrap(b.y + Math.cos(time * 0.00006 + b.phase) * 8, height);
        const distance = Math.hypot(ax - bx, ay - by);
        if (distance >= maxDistance) continue;
        context.beginPath();
        context.moveTo(ax, ay);
        context.lineTo(bx, by);
        context.strokeStyle = colorAlpha(accent, (1 - distance / maxDistance) * (mode === "backdrop" ? 0.08 : 0.22));
        context.stroke();
      }
      context.restore();
    }

    function drawCosmos(time: number) {
      pointer.x += (pointer.targetX - pointer.x) * 0.035;
      pointer.y += (pointer.targetY - pointer.y) * 0.035;
      const compact = width < 880;
      const centerX = width * (compact ? 0.55 : 0.66);
      const centerY = height * (compact ? 0.43 : 0.5);
      const radius = Math.min(width * (compact ? 0.43 : 0.32), height * (compact ? 0.34 : 0.43), 480);
      const rotationY = (reduceMotion ? 0.55 : time * 0.000075) + pointer.x * 0.42;
      const rotationX = -0.16 + pointer.y * 0.24 + Math.sin(time * 0.00011) * (reduceMotion ? 0 : 0.035);
      const rotationZ = -0.08 + Math.sin(time * 0.00007) * (reduceMotion ? 0 : 0.055);

      const aura = context.createRadialGradient(centerX, centerY, radius * 0.03, centerX, centerY, radius * 1.28);
      aura.addColorStop(0, colorAlpha(colors[0], 0.18));
      aura.addColorStop(0.28, colorAlpha(colors[1 % colors.length], 0.075));
      aura.addColorStop(0.7, colorAlpha(accent, 0.025));
      aura.addColorStop(1, colorAlpha(accent, 0));
      context.fillStyle = aura;
      context.fillRect(centerX - radius * 1.35, centerY - radius * 1.35, radius * 2.7, radius * 2.7);

      drawOrbits(centerX, centerY, radius, rotationX, rotationY, rotationZ, time);

      const projected = cosmosParticles.map(particle => {
        const rotated = rotate3(particle, rotationX, rotationY, rotationZ);
        const perspective = 3.15;
        const scale = perspective / (perspective - rotated.z);
        let x = centerX + rotated.x * radius * scale;
        let y = centerY + rotated.y * radius * scale;
        if (pointer.active) {
          const pointerX = width * (0.5 + pointer.targetX * 0.5);
          const pointerY = height * (0.5 + pointer.targetY * 0.5);
          const dx = x - pointerX;
          const dy = y - pointerY;
          const distance = Math.hypot(dx, dy);
          if (distance > 0 && distance < 130) {
            const force = Math.pow(1 - distance / 130, 2) * 18;
            x += (dx / distance) * force;
            y += (dy / distance) * force;
          }
        }
        return { particle, rotated, scale, x, y };
      });

      context.save();
      context.globalCompositeOperation = "lighter";
      context.lineWidth = 0.55;
      for (const [firstIndex, secondIndex] of links) {
        const first = projected[firstIndex];
        const second = projected[secondIndex];
        if (!first || !second || first.rotated.z < -0.72 || second.rotated.z < -0.72) continue;
        const distance = Math.hypot(first.x - second.x, first.y - second.y);
        if (distance > radius * 0.42) continue;
        const alpha = (1 - distance / (radius * 0.42)) * 0.13 * ((first.rotated.z + 1) / 2);
        context.beginPath();
        context.moveTo(first.x, first.y);
        context.quadraticCurveTo(
          (first.x + second.x) / 2 + (second.y - first.y) * 0.05,
          (first.y + second.y) / 2 - (second.x - first.x) * 0.05,
          second.x,
          second.y
        );
        context.strokeStyle = colorAlpha(first.particle.color, alpha);
        context.stroke();
      }

      projected.sort((a, b) => a.rotated.z - b.rotated.z);
      for (const point of projected) {
        const { particle } = point;
        const depth = clamp((point.rotated.z + 1.2) / 2.2, 0.08, 1);
        const twinkle = reduceMotion ? 0.82 : 0.72 + Math.sin(time * 0.0014 + particle.phase) * 0.22;
        const pointRadius = particle.radius * point.scale * (0.55 + depth * 0.9);
        if (particle.previousX !== undefined && particle.previousY !== undefined && particle.radius > 1.35) {
          context.beginPath();
          context.moveTo(particle.previousX, particle.previousY);
          context.lineTo(point.x, point.y);
          context.strokeStyle = colorAlpha(particle.color, depth * 0.26);
          context.lineWidth = Math.max(0.5, pointRadius * 0.55);
          context.stroke();
        }
        context.beginPath();
        context.arc(point.x, point.y, pointRadius, 0, Math.PI * 2);
        context.fillStyle = colorAlpha(particle.color, clamp(depth * twinkle, 0.08, 0.95));
        if (pointRadius > 2.15) {
          context.shadowBlur = 12 + pointRadius * 3;
          context.shadowColor = particle.color;
        }
        context.fill();
        context.shadowBlur = 0;
        particle.previousX = point.x;
        particle.previousY = point.y;
      }

      const coreRadius = radius * (0.105 + Math.sin(time * 0.0008) * (reduceMotion ? 0 : 0.008));
      const core = context.createRadialGradient(centerX, centerY, 0, centerX, centerY, coreRadius * 2.7);
      core.addColorStop(0, "rgba(246,255,252,.98)");
      core.addColorStop(0.18, colorAlpha(colors[0], 0.66));
      core.addColorStop(0.5, colorAlpha(accent, 0.16));
      core.addColorStop(1, colorAlpha(accent, 0));
      context.fillStyle = core;
      context.beginPath();
      context.arc(centerX, centerY, coreRadius * 2.7, 0, Math.PI * 2);
      context.fill();
      context.restore();
    }

    function drawOrbits(
      centerX: number,
      centerY: number,
      radius: number,
      rotationX: number,
      rotationY: number,
      rotationZ: number,
      time: number
    ) {
      context.save();
      context.globalCompositeOperation = "lighter";
      for (const orbit of orbits) {
        const start = orbit.phase + (reduceMotion ? 0 : time * 0.000035);
        context.beginPath();
        for (let step = 0; step <= 54; step += 1) {
          const angle = start + (step / 54) * Math.PI * (1.15 + (orbit.phase % 0.7));
          let point: Point3 = {
            x: Math.cos(angle) * orbit.radius,
            y: Math.sin(angle) * orbit.radius,
            z: Math.sin(angle * 1.7 + orbit.phase) * 0.16
          };
          point = rotate3(point, orbit.tiltX, orbit.tiltY, orbit.tiltZ);
          point = rotate3(point, rotationX, rotationY, rotationZ);
          const scale = 3.15 / (3.15 - point.z);
          const x = centerX + point.x * radius * scale;
          const y = centerY + point.y * radius * scale;
          if (step === 0) context.moveTo(x, y);
          else context.lineTo(x, y);
        }
        context.strokeStyle = colorAlpha(orbit.color, 0.075);
        context.lineWidth = 0.7;
        context.stroke();
      }
      context.restore();
    }

    function loop(time: number) {
      if (!visible || reduceMotion) return;
      draw(time);
      frame = window.requestAnimationFrame(loop);
    }

    function onPointerMove(event: PointerEvent) {
      pointer.targetX = clamp((event.clientX / Math.max(width, 1)) * 2 - 1, -1, 1);
      pointer.targetY = clamp((event.clientY / Math.max(height, 1)) * 2 - 1, -1, 1);
      pointer.active = true;
    }

    function onPointerLeave() {
      pointer.targetX = 0;
      pointer.targetY = 0;
      pointer.active = false;
    }

    function onVisibilityChange() {
      visible = !document.hidden;
      window.cancelAnimationFrame(frame);
      if (visible && !reduceMotion) frame = window.requestAnimationFrame(loop);
    }

    const observer = isViewportField ? null : new ResizeObserver(resize);
    observer?.observe(canvas.parentElement ?? canvas);
    window.addEventListener("resize", resize, { passive: true });
    document.addEventListener("visibilitychange", onVisibilityChange);
    if (!reduceMotion) {
      window.addEventListener("pointermove", onPointerMove, { passive: true });
      document.documentElement.addEventListener("pointerleave", onPointerLeave);
    }
    resize();
    if (!reduceMotion) frame = window.requestAnimationFrame(loop);

    return () => {
      window.cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener("resize", resize);
      window.removeEventListener("pointermove", onPointerMove);
      document.documentElement.removeEventListener("pointerleave", onPointerLeave);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [accent, mode, paletteKey, skillCount, sourceCount]);

  return <canvas className={`particle-field particle-field-${mode}`} ref={canvasRef} aria-hidden="true" />;
}

function rotate3(point: Point3, xAngle: number, yAngle: number, zAngle: number): Point3 {
  const cosX = Math.cos(xAngle);
  const sinX = Math.sin(xAngle);
  const cosY = Math.cos(yAngle);
  const sinY = Math.sin(yAngle);
  const cosZ = Math.cos(zAngle);
  const sinZ = Math.sin(zAngle);
  const y1 = point.y * cosX - point.z * sinX;
  const z1 = point.y * sinX + point.z * cosX;
  const x2 = point.x * cosY + z1 * sinY;
  const z2 = -point.x * sinY + z1 * cosY;
  return {
    x: x2 * cosZ - y1 * sinZ,
    y: x2 * sinZ + y1 * cosZ,
    z: z2
  };
}

function unitVector(random: () => number): Point3 {
  const z = random() * 2 - 1;
  const angle = random() * Math.PI * 2;
  const radius = Math.sqrt(Math.max(0, 1 - z * z));
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius, z };
}

function normalize3(point: Point3): Point3 {
  const length = Math.hypot(point.x, point.y, point.z) || 1;
  return { x: point.x / length, y: point.y / length, z: point.z / length };
}

function gaussian(random: () => number): number {
  const first = Math.max(random(), 0.000001);
  const second = Math.max(random(), 0.000001);
  return Math.sqrt(-2 * Math.log(first)) * Math.cos(Math.PI * 2 * second);
}

function mulberry32(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let result = value;
    result = Math.imul(result ^ (result >>> 15), result | 1);
    result ^= result + Math.imul(result ^ (result >>> 7), result | 61);
    return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function wrap(value: number, maximum: number): number {
  if (maximum <= 0) return 0;
  return ((value % maximum) + maximum) % maximum;
}

function colorAlpha(color: string, alpha: number): string {
  const clamped = clamp(alpha, 0, 1);
  const normalized = color.trim();
  if (/^#[0-9a-f]{6}$/i.test(normalized)) {
    return `${normalized}${Math.round(clamped * 255).toString(16).padStart(2, "0")}`;
  }
  if (/^#[0-9a-f]{3}$/i.test(normalized)) {
    const expanded = normalized
      .slice(1)
      .split("")
      .map(character => character + character)
      .join("");
    return `#${expanded}${Math.round(clamped * 255).toString(16).padStart(2, "0")}`;
  }
  return color;
}

/* Animated counter — eases to the target whenever it changes. */
export function CountUp({ value }: { value: number }) {
  const [display, setDisplay] = useState(value);
  const fromRef = useRef(value);

  useEffect(() => {
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduceMotion || fromRef.current === value) {
      fromRef.current = value;
      setDisplay(value);
      return;
    }
    const from = fromRef.current;
    const start = performance.now();
    const duration = 850;
    let raf = 0;
    const tick = (now: number) => {
      const progress = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      setDisplay(Math.round(from + (value - from) * eased));
      if (progress < 1) raf = window.requestAnimationFrame(tick);
      else fromRef.current = value;
    };
    raf = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(raf);
  }, [value]);

  return <>{display.toLocaleString()}</>;
}

/* Global pointer-follow glow for any .glow-card element. One listener for the app. */
export function useCardGlow() {
  useEffect(() => {
    let frame = 0;
    let pointerX = 0;
    let pointerY = 0;
    let pointerTarget: EventTarget | null = null;

    function updateGlow() {
      frame = 0;
      const target = (pointerTarget as HTMLElement | null)?.closest?.(".glow-card");
      if (!(target instanceof HTMLElement)) return;
      const rect = target.getBoundingClientRect();
      target.style.setProperty("--glow-x", `${pointerX - rect.left}px`);
      target.style.setProperty("--glow-y", `${pointerY - rect.top}px`);
    }

    function onPointerMove(event: PointerEvent) {
      pointerX = event.clientX;
      pointerY = event.clientY;
      pointerTarget = event.target;
      if (!frame) frame = window.requestAnimationFrame(updateGlow);
    }
    window.addEventListener("pointermove", onPointerMove, { passive: true });
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", onPointerMove);
    };
  }, []);
}
