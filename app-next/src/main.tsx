import React from "react";
import ReactDOM from "react-dom/client";
// Base styles first, so the v3.3 shell and page styles (imported by App and the pages) win ties.
import "./styles.css";
import "./sky-theme.css";
import "./refinements.css";
import { App } from "./App";
import { loadTelemetry } from "./telemetry";
import { startAppVisibilityRelay } from "./appVisibility";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// Window minimized/background → page events, so heavy views can release memory.
startAppVisibilityRelay();

// Third-party usage statistics load after first paint and only while the switch is on.
window.setTimeout(loadTelemetry, 4_000);
