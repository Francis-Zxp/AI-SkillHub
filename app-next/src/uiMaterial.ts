// Chrome material: frosted glass (the 3.2.x panels, default) or liquid glass (liquid.css,
// liquidGlass.ts). Only the look changes; layout and behaviour are the same in both.
export type UiMaterial = "frosted" | "liquid";

export const UI_MATERIALS: readonly UiMaterial[] = ["frosted", "liquid"];
const UI_MATERIAL_STORAGE_KEY = "ai-skillhub-ui-material";

export function initialUiMaterial(): UiMaterial {
  try {
    return window.localStorage.getItem(UI_MATERIAL_STORAGE_KEY) === "liquid" ? "liquid" : "frosted";
  } catch {
    return "frosted";
  }
}

export function saveUiMaterial(material: UiMaterial) {
  try {
    window.localStorage.setItem(UI_MATERIAL_STORAGE_KEY, material);
  } catch {
    // Storage unavailable: the choice lasts for this session only.
  }
}
