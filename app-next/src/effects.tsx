import { useEffect, useRef, useState } from "react";

/* Interactive particle field for the dashboard hero.
   Lightweight: ~70 particles, linked when close, gently repelled by the cursor.
   Honors prefers-reduced-motion by rendering a static constellation. */
export function ParticleField({ accent }: { accent: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

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
    const pointer = { x: -9999, y: -9999 };
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    type Particle = { x: number; y: number; vx: number; vy: number; r: number; phase: number };
    let particles: Particle[] = [];

    function seed() {
      const count = Math.max(36, Math.min(84, Math.round((width * height) / 16000)));
      particles = Array.from({ length: count }, () => ({
        x: Math.random() * width,
        y: Math.random() * height,
        vx: (Math.random() - 0.5) * 0.22,
        vy: (Math.random() - 0.5) * 0.22,
        r: 0.8 + Math.random() * 1.7,
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

      for (const particle of particles) {
        if (!reduceMotion) {
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
        context.fillStyle = `${accent}${alphaHex(twinkle * 0.85)}`;
        context.fill();
      }

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

    function loop(time: number) {
      if (!running) return;
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

    const observer = new ResizeObserver(resize);
    observer.observe(canvas.parentElement ?? canvas);
    resize();
    if (!reduceMotion) {
      raf = window.requestAnimationFrame(loop);
      window.addEventListener("pointermove", onPointerMove, { passive: true });
      window.addEventListener("pointerleave", onPointerLeave);
    }

    return () => {
      running = false;
      window.cancelAnimationFrame(raf);
      observer.disconnect();
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerleave", onPointerLeave);
    };
  }, [accent]);

  return <canvas className="particle-field" ref={canvasRef} aria-hidden="true" />;
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
