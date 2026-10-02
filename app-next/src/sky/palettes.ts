import type { SkyPalette } from "./materials";

export type SkyDirection = {
  palette: SkyPalette;
  /** Camera pitch in degrees below the horizon. */
  pitch: number;
  fov: number;
  /** How much island heights vary (world units). */
  heightSpread: number;
  /** Width-to-height ratio the island layout aims for on screen. */
  aspect: number;
};

// One cartoon world in four lights. Greens stay fresh by day and turn
// blue-grey at night; earth bands stay warm; skies are flat clean gradients.
const noon: SkyPalette = {
  name: "noon",
  skyTop: "#7fb6e6",
  skyHorizon: "#d9ecf8",
  skyBelow: "#eaf3fa",
  sunColor: "#fff6e6",
  sunIntensity: 2.4,
  sunElevation: 52,
  sunAzimuth: 28,
  ambientSky: "#dcebf7",
  ambientGround: "#9aa88a",
  ambientIntensity: 1.55,
  fog: "#dcebf6",
  fogNear: 140,
  fogFar: 520,
  grassLight: "#9fd35e",
  grassDark: "#6fb44a",
  grassAlt: "#b9dd6a",
  path: "#e7cf9a",
  soil: "#dbc5a2",
  earthA: "#b29a7b",
  earthB: "#8e7c65",
  rockDeep: "#515866",
  cloud: "#ffffff",
  cloudShade: "#c9dcef",
  water: "#59c3e6",
  waterDeep: "#2e8fc7",
  night: 0
};

const dawn: SkyPalette = {
  ...noon,
  name: "dawn",
  skyTop: "#9fb8dd",
  skyHorizon: "#f7d4c1",
  skyBelow: "#f6e3d8",
  sunColor: "#ffe2c8",
  sunIntensity: 2.1,
  sunElevation: 22,
  sunAzimuth: -48,
  ambientSky: "#e9dcec",
  ambientGround: "#a4927e",
  ambientIntensity: 1.5,
  fog: "#f1dfd6",
  grassLight: "#a6d16c",
  grassDark: "#76b058",
  grassAlt: "#c3d978",
  cloud: "#fff8f4",
  cloudShade: "#f0c9c0",
  water: "#7cc7e0",
  waterDeep: "#4a8fbf"
};

const golden: SkyPalette = {
  ...noon,
  name: "golden",
  skyTop: "#8fb4d8",
  skyHorizon: "#f6d6a2",
  skyBelow: "#f4e2c4",
  sunColor: "#ffd9a0",
  sunIntensity: 2.5,
  sunElevation: 26,
  sunAzimuth: 58,
  ambientSky: "#f1e2c6",
  ambientGround: "#a08a62",
  ambientIntensity: 1.45,
  fog: "#f2e0c2",
  grassLight: "#b5d25a",
  grassDark: "#83ad45",
  grassAlt: "#d2d46a",
  soil: "#e1cba6",
  earthA: "#b69a78",
  earthB: "#94795f",
  cloud: "#fffaf0",
  cloudShade: "#efcf9e",
  water: "#62bfd6",
  waterDeep: "#2f84b3"
};

const night: SkyPalette = {
  ...noon,
  name: "night",
  skyTop: "#0c1630",
  skyHorizon: "#24365e",
  skyBelow: "#16223e",
  sunColor: "#b9cdf5",
  sunIntensity: 1.25,
  sunElevation: 40,
  sunAzimuth: -30,
  ambientSky: "#5d74a8",
  ambientGround: "#2c3448",
  ambientIntensity: 1.35,
  fog: "#1a2846",
  fogNear: 120,
  fogFar: 480,
  grassLight: "#5f9a68",
  grassDark: "#3f7558",
  grassAlt: "#6aa070",
  path: "#9a9a8a",
  soil: "#87949f",
  earthA: "#6d7a89",
  earthB: "#526073",
  rockDeep: "#303c50",
  cloud: "#617495",
  cloudShade: "#263752",
  water: "#3f78b6",
  waterDeep: "#203f78",
  night: 1
};

const camera = { pitch: 22, fov: 32, heightSpread: 4.5, aspect: 2.6 };

export const SKY_DIRECTIONS: Record<string, SkyDirection> = {
  dawn: { palette: dawn, ...camera },
  noon: { palette: noon, ...camera },
  golden: { palette: golden, ...camera },
  night: { palette: night, ...camera }
};
