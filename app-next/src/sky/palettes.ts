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

const morning: SkyPalette = {
  name: "morning",
  skyZenith: "#6fa6d4",
  skyHorizon: "#f2ead8",
  skyBelow: "#dbe6ec",
  sunColor: "#fff0d2",
  sunIntensity: 3.1,
  sunElevation: 50,
  sunAzimuth: -38,
  ambientSky: "#d3e4f1",
  ambientGround: "#8d8c68",
  ambientIntensity: 1.2,
  fog: "#d3e1ec",
  fogNear: 140,
  fogFar: 470,
  exposure: 1,
  grassLight: "#a9c55c",
  grassDark: "#5e8a3c",
  grassDry: "#c6b26b",
  dirt: "#b49b77",
  rockLight: "#bba78c",
  rockDark: "#7e6c5a",
  rockDeep: "#4e5668",
  leafLight: "#a3c75b",
  leafDark: "#3d6934",
  cloudLit: "#ffffff",
  cloudShade: "#bccbe0",
  cloudDeep: "#86a3c6",
  water: "#86cbc6",
  waterDeep: "#2f7d8c",
  windowGlow: 0
};

const highAltitude: SkyPalette = {
  ...morning,
  name: "high-altitude",
  skyZenith: "#5a8ec1",
  skyHorizon: "#dde9f2",
  skyBelow: "#c8d7e5",
  sunColor: "#f5f2ea",
  sunIntensity: 2.7,
  sunElevation: 36,
  sunAzimuth: 32,
  ambientSky: "#d5e3ef",
  ambientGround: "#7e8985",
  ambientIntensity: 1.3,
  fog: "#c6d8ea",
  fogNear: 90,
  fogFar: 360,
  grassLight: "#9dc16c",
  grassDark: "#4f7c4b",
  grassDry: "#b5be8b",
  dirt: "#a9987f",
  rockLight: "#aba79e",
  rockDark: "#6c6e71",
  rockDeep: "#46546a",
  leafLight: "#91bf6c",
  leafDark: "#345e46",
  cloudShade: "#a8bcd3",
  cloudDeep: "#6f8fb8",
  water: "#8ecfd6",
  waterDeep: "#3a7e98"
};

const dusk: SkyPalette = {
  ...morning,
  name: "dusk",
  skyZenith: "#2b3c68",
  skyHorizon: "#eea06e",
  skyBelow: "#6a6d8e",
  sunColor: "#ffbd80",
  sunIntensity: 2.9,
  sunElevation: 17,
  sunAzimuth: -52,
  ambientSky: "#8c95c8",
  ambientGround: "#5a4a52",
  ambientIntensity: 1.35,
  fog: "#a98a99",
  fogNear: 100,
  fogFar: 380,
  exposure: 1.18,
  grassLight: "#9db564",
  grassDark: "#4a6a43",
  grassDry: "#b29a5f",
  dirt: "#8f7762",
  rockLight: "#9d8275",
  rockDark: "#5b4b4e",
  rockDeep: "#333a56",
  leafLight: "#94a855",
  leafDark: "#2e4936",
  cloudLit: "#ffd6ae",
  cloudShade: "#7c7ea8",
  cloudDeep: "#3e4370",
  water: "#e0a07c",
  waterDeep: "#3c4e72",
  windowGlow: 1
};

export const SKY_DIRECTIONS: Record<string, SkyDirection> = {
  // A: an illustrated miniature in clear morning light; reads like a map.
  morning: { palette: morning, pitch: 36, fov: 30, heightSpread: 2.2, aspect: 2.4 },
  // B: lower, cinematic view over a deep cloud sea with aerial haze.
  "high-altitude": { palette: highAltitude, pitch: 20, fov: 32, heightSpread: 4.5, aspect: 2.6 },
  // C: golden dusk with lit windows. Chosen for the dark theme, on the same
  // camera as B so switching themes keeps every island in place.
  dusk: { palette: dusk, pitch: 20, fov: 32, heightSpread: 4.5, aspect: 2.6 }
};
