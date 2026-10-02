export const UI_ICON_SCALES = { compact: 1, standard: 1.2, comfortable: 1.36, large: 1.55 } as const;
export const UI_ICON_SCALE_STORAGE_KEY = "ai-skillhub-ui-icon-scale-v2";

/** Preserve the three former sizes when their labels move down one step. */
export function restoredIconScale(current: string | null, legacy: string | null): keyof typeof UI_ICON_SCALES {
  if (current && Object.hasOwn(UI_ICON_SCALES, current)) return current as keyof typeof UI_ICON_SCALES;
  switch (legacy) {
    case "compact":
    case "standard": return "compact";
    case "large": return "comfortable";
    default: return "standard";
  }
}
