// Whether the home page shows the 3D sky islands. Shared by Settings and the
// archipelago without pulling the scene code into the main bundle.
const SCENE_SETTING = "skillhub-sky-scene";
export const SKY_SCENE_EVENT = "skillhub-sky-scene-change";

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
