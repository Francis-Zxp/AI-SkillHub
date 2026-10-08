// Liquid glass (Apple-style) for the app chrome.
//
// The material itself is CSS (liquid.css): a translucent tint, backdrop blur and
// saturation, an angled specular rim and a soft shadow. This module adds the two
// parts CSS cannot do alone:
//
// 1. Lens refraction on the large surfaces (top bar, rail, bottom bar, scene
//    switch). Each gets an SVG displacement filter generated for its exact size
//    from a rounded-rectangle distance field, so the backdrop bends near the rim
//    like a thick glass edge (technique as in rdev/liquid-glass-react and
//    shuding/liquid-glass, MIT; written from scratch here). The filter is exposed
//    as --lg-lens and used inside `backdrop-filter`, which Chromium/WebView2 supports.
// 2. A sheen that follows the pointer (--lg-x / --lg-y on the hovered surface).
//
// Off on software rendering (probeGraphics().weak) and when the user prefers
// reduced transparency; the CSS material still applies, just without the lens.
import { probeGraphics } from "./skyScene";

/** Surfaces large enough for refraction to read. */
const LENS_SELECTOR = [
  ".v33 .topbar",
  ".v33 .side-rail",
  ".v33 .metric-grid.atlas-touchbar",
  ".v33 .home-visual-switch .segmented"
].join(",");

/** Surfaces whose sheen follows the pointer. */
const SHEEN_SELECTOR = [
  ".v33 .topbar",
  ".v33 .side-rail",
  ".v33 .metric-grid.atlas-touchbar",
  ".v33 .segmented",
  ".v33 .sky-controls button",
  ".v33 .atlas-immersive-toggle",
  ".v33 .atlas-intro-toggle",
  ".v33 .topbar-actions > *",
  ".v33 .sky-board-card",
  ".v33 .lib-filter",
  ".v33 .folder-chip"
].join(",");

const SVG_NS = "http://www.w3.org/2000/svg";
let started = false;

function sdRoundRect(x: number, y: number, halfW: number, halfH: number, radius: number) {
  const qx = Math.abs(x) - halfW + radius;
  const qy = Math.abs(y) - halfH + radius;
  return Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - radius;
}

/** RG displacement map: near the rim the backdrop is sampled from further inside. */
function lensMap(width: number, height: number, radius: number): { url: string; scale: number } {
  const step = width * height > 160_000 ? 3 : 2;
  const columns = Math.max(2, Math.round(width / step));
  const rows = Math.max(2, Math.round(height / step));
  const canvas = document.createElement("canvas");
  canvas.width = columns;
  canvas.height = rows;
  const context = canvas.getContext("2d");
  if (!context) return { url: "", scale: 0 };
  const image = context.createImageData(columns, rows);
  const halfW = width / 2, halfH = height / 2;
  const r = Math.min(radius, halfW, halfH);
  const band = Math.max(4, Math.min(r * 1.1, Math.min(width, height) * 0.45));
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < columns; i++) {
      const x = ((i + 0.5) / columns) * width - halfW;
      const y = ((j + 0.5) / rows) * height - halfH;
      const inside = -sdRoundRect(x, y, halfW, halfH, r);
      const t = Math.max(0, 1 - inside / band);
      const k = t * t * (3 - 2 * t);
      const gx = sdRoundRect(x + 1, y, halfW, halfH, r) - sdRoundRect(x - 1, y, halfW, halfH, r);
      const gy = sdRoundRect(x, y + 1, halfW, halfH, r) - sdRoundRect(x, y - 1, halfW, halfH, r);
      const length = Math.hypot(gx, gy) || 1;
      const offset = (j * columns + i) * 4;
      image.data[offset] = Math.round(128 - (gx / length) * k * 127);
      image.data[offset + 1] = Math.round(128 - (gy / length) * k * 127);
      image.data[offset + 2] = 128;
      image.data[offset + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);
  return { url: canvas.toDataURL(), scale: Math.min(40, band * 0.85) };
}

export function startLiquidGlass(root: HTMLElement) {
  if (started || typeof window === "undefined") return;
  started = true;
  const reducedTransparency = window.matchMedia?.("(prefers-reduced-transparency: reduce)").matches;
  const lensEnabled = !probeGraphics().weak && !reducedTransparency;

  // Pointer sheen: one listener, one write per frame.
  let frame = 0;
  let pending: { x: number; y: number; target: EventTarget | null } | null = null;
  let lit: HTMLElement | null = null;
  const applySheen = () => {
    frame = 0;
    if (!pending) return;
    const element = (pending.target as Element | null)?.closest?.(SHEEN_SELECTOR) as HTMLElement | null;
    if (lit && lit !== element) lit.removeAttribute("data-lg-lit");
    lit = element;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    element.style.setProperty("--lg-x", `${(((pending.x - rect.left) / Math.max(1, rect.width)) * 100).toFixed(1)}%`);
    element.style.setProperty("--lg-y", `${(((pending.y - rect.top) / Math.max(1, rect.height)) * 100).toFixed(1)}%`);
    element.setAttribute("data-lg-lit", "");
  };
  root.addEventListener("pointermove", event => {
    pending = { x: event.clientX, y: event.clientY, target: event.target };
    if (!frame) frame = window.requestAnimationFrame(applySheen);
  }, { passive: true });
  root.addEventListener("pointerleave", () => {
    lit?.removeAttribute("data-lg-lit");
    lit = null;
  });

  if (!lensEnabled) return;
  const defs = document.createElementNS(SVG_NS, "svg");
  defs.setAttribute("aria-hidden", "true");
  defs.setAttribute("width", "0");
  defs.setAttribute("height", "0");
  defs.style.position = "absolute";
  document.body.appendChild(defs);

  const tracked = new Map<HTMLElement, { id: string; key: string }>();
  let counter = 0;
  const build = (element: HTMLElement) => {
    // The rail draws its glass on ::before, inset from the element's box.
    const style = element.matches(".side-rail") ? getComputedStyle(element, "::before") : getComputedStyle(element);
    const inset = (value: string) => (element.matches(".side-rail") ? Number.parseFloat(value) || 0 : 0);
    const width = Math.round(element.offsetWidth - inset(style.left) - inset(style.right));
    const height = Math.round(element.offsetHeight - inset(style.top) - inset(style.bottom));
    if (width < 24 || height < 24) return;
    const radius = Number.parseFloat(style.borderTopLeftRadius) || 16;
    const key = `${width}x${height}r${Math.round(radius)}`;
    const entry = tracked.get(element) ?? { id: `lg-lens-${++counter}`, key: "" };
    if (entry.key === key) return;
    entry.key = key;
    tracked.set(element, entry);
    const { url, scale } = lensMap(width, height, radius);
    if (!url) return;
    document.getElementById(entry.id)?.remove();
    const filter = document.createElementNS(SVG_NS, "filter");
    filter.setAttribute("id", entry.id);
    filter.setAttribute("x", "0");
    filter.setAttribute("y", "0");
    filter.setAttribute("width", String(width));
    filter.setAttribute("height", String(height));
    filter.setAttribute("filterUnits", "userSpaceOnUse");
    filter.setAttribute("color-interpolation-filters", "sRGB");
    const map = document.createElementNS(SVG_NS, "feImage");
    map.setAttribute("href", url);
    map.setAttribute("x", "0");
    map.setAttribute("y", "0");
    map.setAttribute("width", String(width));
    map.setAttribute("height", String(height));
    map.setAttribute("preserveAspectRatio", "none");
    map.setAttribute("result", "map");
    const displace = document.createElementNS(SVG_NS, "feDisplacementMap");
    displace.setAttribute("in", "SourceGraphic");
    displace.setAttribute("in2", "map");
    displace.setAttribute("scale", scale.toFixed(1));
    displace.setAttribute("xChannelSelector", "R");
    displace.setAttribute("yChannelSelector", "G");
    filter.append(map, displace);
    defs.appendChild(filter);
    element.style.setProperty("--lg-lens", `url(#${entry.id})`);
  };

  let resizeTimer = 0;
  const dirty = new Set<HTMLElement>();
  const resizeObserver = new ResizeObserver(entries => {
    for (const entry of entries) dirty.add(entry.target as HTMLElement);
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      dirty.forEach(build);
      dirty.clear();
    }, 140);
  });
  const scan = () => {
    root.querySelectorAll<HTMLElement>(LENS_SELECTOR).forEach(element => {
      if (tracked.has(element)) return;
      build(element);
      resizeObserver.observe(element);
    });
    // Forget surfaces that left the page (and their filters).
    tracked.forEach((entry, element) => {
      if (element.isConnected) return;
      resizeObserver.unobserve(element);
      document.getElementById(entry.id)?.remove();
      tracked.delete(element);
    });
  };
  let scanTimer = 0;
  new MutationObserver(() => {
    window.clearTimeout(scanTimer);
    scanTimer = window.setTimeout(scan, 120);
  }).observe(root, { childList: true, subtree: true });
  scan();
}
