import { useEffect, useRef, useState } from "react";

type ParticleFieldProps = {
  accent: string;
  mode?: "ambient" | "atlas";
  palette?: string[];
  skillCount?: number;
  sourceCount?: number;
};

/* Dashboard particle field. Ambient mode preserves the 2.x constellation;
   Atlas mode turns real source/Skill counts into a denser, anchored field.
   Both paths stop when the page is hidden and render statically under reduced motion. */
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
    const canvasEl = canvasRef.current;
    if (!canvasEl) return;
    const ctx = canvasEl.getContext("2d");
    if (!ctx) return;
    const canvas: HTMLCanvasElement = canvasEl;
    const context: CanvasRenderingContext2D = ctx;

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let width = 0;
    let height = 0;
    let raf = 0;
    let running = true;
    let pageVisible = !document.hidden;
    const pointer = { x: -9999, y: -9999 };
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const colors = palette.length > 0 ? palette : [accent];

    type Particle = {
      anchor: number;
      color: string;
      phase: number;
      r: number;
      vx: number;
      vy: number;
      x: number;
      y: number;
    };
    let particles: Particle[] = [];
    let anchors: Array<{ x: number; y: number; color: string; phase: number }> = [];

    function seed() {
      const anchorCount = mode === "atlas" ? Math.max(3, Math.min(9, Math.round(sourceCount / 5) || 3)) : 0;
      anchors = Array.from({ length: anchorCount }, (_, index) => {
        const angle = (index / Math.max(1, anchorCount)) * Math.PI * 2 - Math.PI / 5;
        const radiusX = Math.min(width * 0.27, 260);
        const radiusY = Math.min(height * 0.3, 90);
        return {
          x: width * 0.72 + Math.cos(angle) * radiusX,
          y: height * 0.5 + Math.sin(angle) * radiusY,
          color: colors[index % colors.length],
          phase: index * 0.7
        };
      });
      const count =
        mode === "atlas"
          ? Math.max(72, Math.min(156, Math.round((width * height) / 9200) + Math.min(36, Math.round(Math.sqrt(skillCount)))))
          : Math.max(36, Math.min(84, Math.round((width * height) / 16000)));
      particles = Array.from({ length: count }, () => ({
        anchor: anchorCount > 0 ? Math.floor(Math.random() * anchorCount) : -1,
        color: colors[Math.floor(Math.random() * colors.length)],
        x: Math.random() * width,
        y: Math.random() * height,
        vx: (Math.random() - 0.5) * (mode === "atlas" ? 0.34 : 0.22),
        vy: (Math.random() - 0.5) * (mode === "atlas" ? 0.34 : 0.22),
        r: 0.7 + Math.random() * (mode === "atlas" ? 2.15 : 1.7),
        phase: Math.random() * Math.PI * 2
      }));
    }

    function resize() {
      const rect = canvas.parentElement?.getBoundingClientRect();
      width = Math.max(1, Math.floor(rect?.width ?? canvas.clientWidth));
      height = Math.max(1, Math.floor(rect?.height ?? canvas.clientHeight));
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      seed();
      if (reduceMotion) draw(0);
    }

    function draw(time: number) {
      context.clearRect(0, 0, width, height);
      const linkDistance = Math.min(150, width / 8);

      if (mode === "atlas") {
        const centerX = width * 0.72;
        const centerY = height * 0.5;
        context.save();
        context.strokeStyle = `${accent}${alphaHex(0.09)}`;
        context.lineWidth = 1;
        for (const radius of [42, 78, 118, 166]) {
          context.beginPath();
          context.ellipse(centerX, centerY, radius * 1.55, radius * 0.62, -0.08, 0, Math.PI * 2);
          context.stroke();
        }
        const sweep = reduceMotion ? 0.4 : time * 0.00022;
        context.beginPath();
        context.arc(centerX, centerY, Math.min(146, width * 0.16), sweep, sweep + Math.PI * 0.58);
        context.strokeStyle = `${accent}${alphaHex(0.35)}`;
        context.lineWidth = 1.5;
        context.stroke();
        context.restore();
      }

      for (const particle of particles) {
        if (!reduceMotion) {
          if (mode === "atlas" && particle.anchor >= 0) {
            const anchor = anchors[particle.anchor];
            const pullX = anchor.x - particle.x;
            const pullY = anchor.y - particle.y;
            const pullDistance = Math.max(1, Math.hypot(pullX, pullY));
            if (pullDistance > 44) {
              particle.vx += (pullX / pullDistance) * 0.0028;
              particle.vy += (pullY / pullDistance) * 0.0028;
            }
            particle.vx *= 0.996;
            particle.vy *= 0.996;
          }
          particle.x += particle.vx;
          particle.y += particle.vy;
          // soft cursor repulsion
          const dx = particle.x - pointer.x;
          const dy = particle.y - pointer.y;
          const distSq = dx * dx + dy * dy;
          if (distSq < 110 * 110 && distSq > 0.01) {
            const dist = Math.sqrt(distSq);
            const force = (110 - dist) / 110;
            particle.x += (dx / dist) * force * 1.4;
            particle.y += (dy / dist) * force * 1.4;
          }
          if (particle.x < -8) particle.x = width + 8;
          if (particle.x > width + 8) particle.x = -8;
          if (particle.y < -8) particle.y = height + 8;
          if (particle.y > height + 8) particle.y = -8;
        }
        const twinkle = reduceMotion ? 0.6 : 0.45 + 0.35 * Math.sin(time / 900 + particle.phase);
        context.beginPath();
        context.arc(particle.x, particle.y, particle.r, 0, Math.PI * 2);
        context.fillStyle = `${particle.color}${alphaHex(twinkle * 0.88)}`;
        context.shadowBlur = mode === "atlas" && particle.r > 2 ? 8 : 0;
        context.shadowColor = particle.color;
        context.fill();
        context.shadowBlur = 0;
      }

      if (mode === "atlas") {
        for (const anchor of anchors) {
          const pulse = reduceMotion ? 0.65 : 0.5 + Math.sin(time / 820 + anchor.phase) * 0.15;
          context.beginPath();
          context.arc(anchor.x, anchor.y, 4.2, 0, Math.PI * 2);
          context.fillStyle = `${anchor.color}${alphaHex(pulse)}`;
          context.fill();
          context.beginPath();
          context.arc(anchor.x, anchor.y, 11 + pulse * 5, 0, Math.PI * 2);
          context.strokeStyle = `${anchor.color}${alphaHex(0.18)}`;
          context.stroke();
        }
        for (let index = 0; index < particles.length; index += 3) {
          const particle = particles[index];
          const anchor = anchors[particle.anchor];
          if (!anchor) continue;
          const distance = Math.hypot(anchor.x - particle.x, anchor.y - particle.y);
          if (distance < 190) {
            context.beginPath();
            context.moveTo(particle.x, particle.y);
            context.lineTo(anchor.x, anchor.y);
            context.strokeStyle = `${particle.color}${alphaHex((1 - distance / 190) * 0.22)}`;
            context.lineWidth = 0.8;
            context.stroke();
          }
        }
      } else {
        for (let i = 0; i < particles.length; i += 1) {
          for (let j = i + 1; j < particles.length; j += 1) {
            const a = particles[i];
            const b = particles[j];
            const dx = a.x - b.x;
            const dy = a.y - b.y;
            const dist = Math.hypot(dx, dy);
            if (dist < linkDistance) {
              const strength = (1 - dist / linkDistance) * 0.34;
              context.beginPath();
              context.moveTo(a.x, a.y);
              context.lineTo(b.x, b.y);
              context.strokeStyle = `${accent}${alphaHex(strength)}`;
              context.lineWidth = 1;
              context.stroke();
            }
          }
        }
      }
    }

    function loop(time: number) {
      if (!running || !pageVisible) return;
      draw(time);
      raf = window.requestAnimationFrame(loop);
    }

    function onPointerMove(event: PointerEvent) {
      const rect = canvas.getBoundingClientRect();
      pointer.x = event.clientX - rect.left;
      pointer.y = event.clientY - rect.top;
    }

    function onPointerLeave() {
      pointer.x = -9999;
      pointer.y = -9999;
    }

    function onVisibilityChange() {
      pageVisible = !document.hidden;
      window.cancelAnimationFrame(raf);
      if (pageVisible && !reduceMotion) raf = window.requestAnimationFrame(loop);
    }

    const observer = new ResizeObserver(resize);
    observer.observe(canvas.parentElement ?? canvas);
    resize();
    if (!reduceMotion) {
      raf = window.requestAnimationFrame(loop);
      window.addEventListener("pointermove", onPointerMove, { passive: true });
      window.addEventListener("pointerleave", onPointerLeave);
    }
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      running = false;
      window.cancelAnimationFrame(raf);
      observer.disconnect();
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerleave", onPointerLeave);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [accent, mode, paletteKey, skillCount, sourceCount]);

  return <canvas className={`particle-field particle-field-${mode}`} ref={canvasRef} aria-hidden="true" />;
}

function alphaHex(alpha: number): string {
  const clamped = Math.max(0, Math.min(1, alpha));
  return Math.round(clamped * 255)
    .toString(16)
    .padStart(2, "0");
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
      if (progress < 1) {
        raf = window.requestAnimationFrame(tick);
      } else {
        fromRef.current = value;
      }
    };
    raf = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(raf);
  }, [value]);

  return <>{display.toLocaleString()}</>;
}

/* Global pointer-follow glow for any .glow-card element. One listener for the app. */
export function useCardGlow() {
  useEffect(() => {
    function onPointerMove(event: PointerEvent) {
      const target = (event.target as HTMLElement | null)?.closest?.(".glow-card");
      if (!(target instanceof HTMLElement)) return;
      const rect = target.getBoundingClientRect();
      target.style.setProperty("--glow-x", `${event.clientX - rect.left}px`);
      target.style.setProperty("--glow-y", `${event.clientY - rect.top}px`);
    }
    window.addEventListener("pointermove", onPointerMove, { passive: true });
    return () => window.removeEventListener("pointermove", onPointerMove);
  }, []);
}
