// Relays the desktop window's visibility (see src-tauri/src/memory_saver.rs)
// to the page as plain window events, so heavy views such as the 3D islands
// can pause and release their GPU resources while nobody is looking:
//   skillhub-app-hidden      the window is minimized (WebView hidden, Low memory)
//   skillhub-app-background  unfocused for a while (Low memory, still visible)
//   skillhub-app-visible     back in use
export const APP_VISIBILITY_EVENTS = {
  hidden: "skillhub-app-hidden",
  background: "skillhub-app-background",
  visible: "skillhub-app-visible"
} as const;

type VisibilityState = keyof typeof APP_VISIBILITY_EVENTS;

let started = false;

export function startAppVisibilityRelay() {
  if (started || typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;
  started = true;
  void import("@tauri-apps/api/event")
    .then(({ listen }) =>
      listen<{ state: VisibilityState }>("app-visibility", event => {
        const name = APP_VISIBILITY_EVENTS[event.payload?.state];
        if (name) window.dispatchEvent(new CustomEvent(name));
      })
    )
    .catch(() => {
      started = false;
    });
}
