import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { loadTelemetry } from "./telemetry";
import "./styles.css";
import "./sky-theme.css";
import "./refinements.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// Third-party usage statistics load after first paint and only while the switch is on.
window.setTimeout(loadTelemetry, 4_000);
