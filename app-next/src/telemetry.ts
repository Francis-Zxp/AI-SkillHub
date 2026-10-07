// Usage statistics (skills contract §6.7, brief §7 #25; DECISIONS 2026-10-07: default on,
// disclosed in Settings → 帮助与诊断, and nothing is loaded while the switch is off).
// index.html carries the third-party tag only as an inert <script type="text/plain"> config;
// this loader turns it into a real script once, and only when the user has not opted out.
const TELEMETRY_KEY = "ai-skillhub-telemetry";
const CONFIG_ID = "vc-telemetry-config";

let injected = false;

export function telemetryEnabled(): boolean {
  try {
    return window.localStorage.getItem(TELEMETRY_KEY) !== "0";
  } catch {
    return true;
  }
}

/** Takes effect immediately when turned on; turning it off stops loading from the next start. */
export function setTelemetryEnabled(enabled: boolean) {
  try {
    window.localStorage.setItem(TELEMETRY_KEY, enabled ? "1" : "0");
  } catch {
    // Storage unavailable: the choice lasts for this session only.
  }
  if (enabled) loadTelemetry();
}

export function telemetryLoaded() {
  return injected;
}

export function loadTelemetry() {
  if (injected || typeof document === "undefined" || !telemetryEnabled()) return;
  const config = document.getElementById(CONFIG_ID);
  const src = config?.getAttribute("data-src") ?? "";
  if (!config || !/^https:\/\/vibecafe\.ai\/telemetry\/v1\.js$/.test(src)) return;
  const script = document.createElement("script");
  script.defer = true;
  script.src = src;
  for (const name of config.getAttributeNames()) {
    if (name.startsWith("data-vc-")) script.setAttribute(name, config.getAttribute(name) ?? "");
  }
  injected = true;
  document.head.appendChild(script);
}
