// Independent random samples avoid the bands produced by correlated hash bits.
export function createStarField(count = 720) {
  let seed = 0x45a1b2c3;
  const random = () => {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return (seed >>> 0) / 4294967296;
  };
  return Array.from({ length: count }, () => ({
    x: random(), y: random(), size: 0.55 + random() * 1.15,
    alpha: 0.25 + random() * 0.5, twinkle: random() < 0.12
  }));
}

/** Empty edges, a broad visible centre, then a smooth perspective falloff. */
export function starFieldOpacity(x: number, y: number, centerX: number, centerY: number, width: number, height: number) {
  const smooth = (v: number) => { const t = Math.max(0, Math.min(1, v)); return t * t * (3 - 2 * t); };
  const edge = smooth((Math.min(x / width, 1 - x / width, y / height, 1 - y / height) - 0.04) / 0.18);
  const distance = Math.hypot((x - centerX) / (width * 0.62), (y - centerY) / (height * 0.65));
  return edge * (1 - smooth((distance - 0.2) / 0.85)) * 0.62;
}

export type MeteorSegment = { headX: number; headY: number; tailX: number; tailY: number };

/** Head travel and tail share one pixel-space vector at every aspect ratio.
 * The frame loop passes `out` so nothing is allocated per meteor per frame. */
export function meteorSegment(
  meteor: { x: number; y: number; direction: number; slope: number; length: number }, progress: number, width: number, height: number,
  out: MeteorSegment = { headX: 0, headY: 0, tailX: 0, tailY: 0 }
): MeteorSegment {
  const magnitude = Math.hypot(meteor.direction, meteor.slope);
  const dx = meteor.direction / magnitude, dy = meteor.slope / magnitude;
  const travel = progress * Math.min(width, height) * 0.38;
  out.headX = meteor.x * width + travel * dx;
  out.headY = meteor.y * height + travel * dy;
  out.tailX = out.headX - meteor.length * dx;
  out.tailY = out.headY - meteor.length * dy;
  return out;
}

const patterns = new WeakMap<CanvasRenderingContext2D, CanvasPattern>();

/** Subtle, static dithering breaks up 8-bit gradient steps without blur. */
export function drawAtmosphereDither(context: CanvasRenderingContext2D, width: number, height: number) {
  let pattern = patterns.get(context);
  if (!pattern) {
    const tile = document.createElement("canvas");
    tile.width = tile.height = 256;
    const painter = tile.getContext("2d");
    if (!painter) return;
    const pixels = painter.createImageData(256, 256);
    let seed = 8137;
    for (let i = 0; i < pixels.data.length; i += 4) {
      seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
      const shade = (seed >>> 24) < 128 ? 0 : 255;
      pixels.data[i] = pixels.data[i + 1] = pixels.data[i + 2] = shade;
      pixels.data[i + 3] = 3;
    }
    painter.putImageData(pixels, 0, 0);
    pattern = context.createPattern(tile, "repeat") ?? undefined;
    if (!pattern) return;
    patterns.set(context, pattern);
  }
  context.fillStyle = pattern;
  context.fillRect(0, 0, width, height);
}
