// Which weather the archipelago shows. Pure logic, shared by the scene and
// the React controls (the "auto" chip names the weather it resolved to).
import type { SkyWeatherKind, SkyWeatherSetting } from "../skyScene";
import type { ClimateId } from "./climates";
import { hashString, seededRandom } from "./noise";

export type SkyPhaseName = "dawn" | "noon" | "golden" | "night";

/** Night favours clear skies, aurora and snow; dawn favours mist; noon
 * clear, cloudy and rainbows; the golden hour falling petals. */
const PHASE_WEIGHTS: Record<SkyPhaseName, Partial<Record<SkyWeatherKind, number>>> = {
  dawn: { fog: 3.5, clear: 2, cloudy: 1.4, rainbow: 1, petals: 1, rain: 0.6 },
  noon: { clear: 3, cloudy: 2.4, rainbow: 2, rain: 1, petals: 0.8, snow: 0.5, storm: 0.6 },
  golden: { petals: 3, clear: 3, cloudy: 1, rainbow: 1, fog: 0.5, rain: 0.5 },
  night: { clear: 2.6, aurora: 3, snow: 2, cloudy: 0.8, rain: 0.7, storm: 0.6, fog: 0.4 }
};

/** The local date a phase belongs to: the small hours still count as the
 * previous evening, so a night's weather never changes at midnight. */
export function weatherDateKey(date: Date, phase: SkyPhaseName): string {
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  if (phase === "night" && date.getHours() < 12) day.setDate(day.getDate() - 1);
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
}

export function autoWeather(seed: number, date: Date, phase: SkyPhaseName, climates: ClimateId[] = []): SkyWeatherKind {
  const weights = { ...PHASE_WEIGHTS[phase] ?? PHASE_WEIGHTS.noon };
  const share = (id: ClimateId) => (climates.length ? climates.filter(value => value === id).length / climates.length : 0);
  if (share("alpine") >= 0.3) weights.snow = (weights.snow ?? 0) * 2.5 + 1.5;
  if (share("autumn") + share("crystal") >= 0.4) weights.petals = (weights.petals ?? 0) + 1;
  if (share("desert") >= 0.3) {
    weights.storm = 0;
    weights.rain = (weights.rain ?? 0) * 0.3;
    weights.snow = (weights.snow ?? 0) * 0.3;
  }
  if (phase !== "night") weights.aurora = 0;
  const entries = (Object.entries(weights) as Array<[SkyWeatherKind, number]>).filter(([, weight]) => weight > 0);
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
  let roll = seededRandom(hashString(`weather:${seed >>> 0}:${weatherDateKey(date, phase)}:${phase}`))() * total;
  for (const [kind, weight] of entries) {
    roll -= weight;
    if (roll < 0) return kind;
  }
  return entries.length ? entries[entries.length - 1][0] : "clear";
}

/** The weather actually drawn: auto resolved, and aurora only at night. */
export function resolveWeather(setting: SkyWeatherSetting, seed: number, date: Date, phase: SkyPhaseName, climates: ClimateId[] = []): SkyWeatherKind {
  const kind = setting === "auto" ? autoWeather(seed, date, phase, climates) : setting;
  return kind === "aurora" && phase !== "night" ? "clear" : kind;
}
