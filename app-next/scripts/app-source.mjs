// Contract tests used to read src/App.tsx only. Since v3.3 the page components and
// shared helpers live in their own modules, so tests read the same production code
// from every module that used to be App.tsx. The ordered list mirrors the former
// App.tsx layout (App() first, then pages, then shared helpers) so source slices
// such as indexOf("function A") .. indexOf("function B") keep their meaning.
// Any additional module later added under src/pages or src/components is appended.
import { existsSync, readFileSync, readdirSync } from "node:fs";

const SRC = new URL("../src/", import.meta.url);

export const APP_SOURCE_ORDER = Object.freeze([
  "App.tsx",
  "components/ui.tsx",
  "pages/Dashboard.tsx",
  "pages/Library.tsx",
  "pages/ImportWizard.tsx",
  "pages/Workspaces.tsx",
  "pages/Agents.tsx",
  "pages/Advanced.tsx",
  "pages/Settings.tsx",
  "appShared.ts"
]);

export function appSourceFiles() {
  const extra = ["components", "pages"].flatMap(dir => {
    const url = new URL(`${dir}/`, SRC);
    if (!existsSync(url)) return [];
    return readdirSync(url)
      .filter(name => /\.tsx?$/.test(name))
      .sort()
      .map(name => `${dir}/${name}`);
  }).filter(file => !APP_SOURCE_ORDER.includes(file));
  return [...APP_SOURCE_ORDER, ...extra];
}

export function readAppSourceSync() {
  return appSourceFiles()
    .map(file => readFileSync(new URL(file, SRC), "utf8"))
    .join("\n");
}

export async function readAppSource() {
  return readAppSourceSync();
}
