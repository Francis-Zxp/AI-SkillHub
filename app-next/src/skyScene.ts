// Whether the home page shows the 3D sky islands. Shared by Settings and the
// archipelago without pulling the scene code into the main bundle.
const SCENE_SETTING = "skillhub-sky-scene";
const WORLD_SEED_SETTING = "skillhub-sky-world-seed";
const WEATHER_SETTING = "skillhub-sky-weather";
export const SKY_SCENE_EVENT = "skillhub-sky-scene-change";

/** The shell tells the page when the window is minimised or hidden
 * (`skillhub-app-hidden`; `detail: false` means shown again) and when it is
 * back (`skillhub-app-visible`; `skillhub-app-shown` is an older alias). The
 * home scenes sleep while hidden and wake on either "back" event. */
export const APP_HIDDEN_EVENT = "skillhub-app-hidden";
export const APP_VISIBLE_EVENTS = ["skillhub-app-visible", "skillhub-app-shown"] as const;
/** The window has been unfocused for a while (the shell then trims memory):
 * the 3D world stops and sleeps behind its still image, like a hidden one. */
export const APP_BACKGROUND_EVENT = "skillhub-app-background";

/** Whether an `APP_HIDDEN_EVENT` means hidden (a plain Event or detail true). */
export function appHiddenFromEvent(event: Event): boolean {
  return (event as CustomEvent<boolean | undefined>).detail !== false;
}

/** Archipelago-wide weather. "auto" picks one from the world seed, the date
 * and the time of day; anything else pins that weather. */
export const SKY_WEATHER_KINDS = ["clear", "cloudy", "rain", "storm", "snow", "fog", "rainbow", "petals", "aurora"] as const;
export type SkyWeatherKind = (typeof SKY_WEATHER_KINDS)[number];
/** One weather, or several joined by "+" in SKY_WEATHER_KINDS order (e.g. "rain+rainbow"). */
export type SkyWeatherMix = SkyWeatherKind | `${SkyWeatherKind}+${string}`;
export type SkyWeatherSetting = "auto" | SkyWeatherMix;

/** Rain, storm, snow and petals share the scene's one particle system: a mix holds at most one. */
export const SKY_PRECIPITATION: readonly SkyWeatherKind[] = ["rain", "storm", "snow", "petals"];

/** The weathers in a mix: known ones only, in canonical order, one precipitation, and
 * "clear" only on its own. */
export function weatherKinds(mix: string): SkyWeatherKind[] {
  const wanted = new Set(mix.split("+"));
  const kinds: SkyWeatherKind[] = [];
  let precipitation = false;
  for (const kind of SKY_WEATHER_KINDS) {
    if (!wanted.has(kind)) continue;
    if (SKY_PRECIPITATION.includes(kind)) {
      if (precipitation) continue;
      precipitation = true;
    }
    kinds.push(kind);
  }
  return kinds.length > 1 ? kinds.filter(kind => kind !== "clear") : kinds;
}

/** Canonical mix string for a list of weathers ("clear" when empty). */
export function weatherMix(kinds: readonly SkyWeatherKind[]): SkyWeatherMix {
  const list = weatherKinds(kinds.join("+"));
  return (list.length ? list.join("+") : "clear") as SkyWeatherMix;
}

/** The setting after a weather chip is pressed: 自动 and 晴天 stand alone; any other
 * weather joins or leaves the mix, and a precipitation replaces the one before. */
export function toggleWeather(setting: SkyWeatherSetting, chip: "auto" | SkyWeatherKind): SkyWeatherSetting {
  if (chip === "auto" || chip === "clear") return chip;
  const current = setting === "auto" ? [] : weatherKinds(setting).filter(kind => kind !== "clear");
  if (current.includes(chip)) return weatherMix(current.filter(kind => kind !== chip));
  const replaces = SKY_PRECIPITATION.includes(chip);
  return weatherMix([...current.filter(kind => !(replaces && SKY_PRECIPITATION.includes(kind))), chip]);
}

type Graphics = { webgl: boolean; weak: boolean };
let graphicsProbe: Graphics | null = null;

/** WebGL availability and a software-renderer check, probed once per session. */
export function probeGraphics(): Graphics {
  if (graphicsProbe) return graphicsProbe;
  try {
    const canvas = document.createElement("canvas");
    const gl = (canvas.getContext("webgl2") ?? canvas.getContext("webgl")) as WebGLRenderingContext | null;
    if (!gl) return (graphicsProbe = { webgl: false, weak: true });
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    const renderer = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : "";
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return (graphicsProbe = { webgl: true, weak: /swiftshader|llvmpipe|software|basic render/i.test(renderer) });
  } catch {
    return (graphicsProbe = { webgl: false, weak: true });
  }
}

export function readSetting(key: string) {
  try { return localStorage.getItem(key); } catch { return null; }
}

export function writeSetting(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* storage unavailable */ }
}

/** On by default, except where only software rendering is available. */
export function skySceneEnabled() {
  const saved = readSetting(SCENE_SETTING);
  return saved === null ? probeGraphics().webgl && !probeGraphics().weak : saved === "1";
}

export function setSkySceneEnabled(enabled: boolean) {
  writeSetting(SCENE_SETTING, enabled ? "1" : "0");
  window.dispatchEvent(new CustomEvent(SKY_SCENE_EVENT, { detail: enabled }));
}

/** FNV-1a, the same hash the sky modules use for stable seeds. */
function hashText(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  return hash >>> 0;
}

/** ISO-8601 week of a local date, e.g. "2026-W41". */
export function isoWeekKey(date: Date): string {
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const weekday = (day.getDay() + 6) % 7;
  day.setDate(day.getDate() - weekday + 3);
  const firstThursday = new Date(day.getFullYear(), 0, 4);
  const week = 1 + Math.round(((day.getTime() - firstThursday.getTime()) / 86_400_000 - 3 + ((firstThursday.getDay() + 6) % 7)) / 7);
  return `${day.getFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** The archipelago's world seed: a re-rolled one when saved, otherwise one
 * per ISO week, so the world changes weekly by itself but never flickers. */
export function worldSeed(date: Date = new Date()): number {
  const saved = readSetting(WORLD_SEED_SETTING);
  if (saved && /^\d{1,10}$/.test(saved)) return Number(saved) >>> 0;
  return hashText(`sky-world:${isoWeekKey(date)}`);
}

/** A new random world. Tells the scene through the existing scene event. */
export function rerollWorld(): number {
  const current = worldSeed();
  let next = current;
  for (let attempt = 0; attempt < 8 && next === current; attempt++) {
    try {
      next = crypto.getRandomValues(new Uint32Array(1))[0] >>> 0;
    } catch {
      next = Math.floor(Math.random() * 4294967296) >>> 0;
    }
  }
  writeSetting(WORLD_SEED_SETTING, String(next));
  window.dispatchEvent(new CustomEvent(SKY_SCENE_EVENT, { detail: skySceneEnabled() }));
  return next;
}

export function skyWeatherSetting(): SkyWeatherSetting {
  const saved = readSetting(WEATHER_SETTING);
  // A single weather (3.3.0) reads as a mix of one.
  return saved && saved !== "auto" && weatherKinds(saved).length ? weatherMix(weatherKinds(saved)) : "auto";
}

export function setSkyWeatherSetting(value: SkyWeatherSetting) {
  writeSetting(WEATHER_SETTING, value);
}
