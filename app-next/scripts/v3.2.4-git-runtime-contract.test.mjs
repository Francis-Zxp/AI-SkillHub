import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// git may check these sources out with CRLF, which would break every regex
// that matches across a line break. Normalise once, at read time.
const readText = async (relativePath) =>
  (await readFile(new URL(relativePath, import.meta.url), "utf8")).replace(/\r\n/g, "\n");

const app = await readText("../src/App.tsx");
const backend = await readText("../src-tauri/src/lib.rs");
const i18n = await readText("../src/i18n.ts");
const types = await readText("../src/types.ts");
const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const tauriConfig = JSON.parse(await readFile(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
const cargoToml = await readText("../src-tauri/Cargo.toml");

test("v3.2.4 ships one consistent installed version", () => {
  assert.equal(packageJson.version, "3.2.4");
  assert.equal(tauriConfig.version, packageJson.version);
  assert.match(cargoToml, /^version = "3\.2\.4"$/m);
});

test("one-click Git install goes through the official Microsoft package manager", () => {
  // No bundled binary and no ad-hoc download: winget resolves Git.Git from the
  // official source, which is the only install path the app ever triggers.
  assert.match(backend, /const GIT_WINGET_PACKAGE_ID: &str = "Git\.Git";/);
  assert.match(backend, /const GIT_DOWNLOAD_PAGE_URL: &str = "https:\/\/git-scm\.com\/download\/win";/);
  assert.match(backend, /"install",\s*\n\s*"--id",\s*\n\s*GIT_WINGET_PACKAGE_ID,\s*\n\s*"--exact",\s*\n\s*"--source",\s*\n\s*"winget",/);
  assert.match(backend, /"--disable-interactivity",/);
  assert.doesNotMatch(backend, /codeload[^\n]*Git\.Git/);
  // A stuck installer must not hang the app forever.
  assert.match(backend, /Duration::from_secs\(600\),\s*\n\s*"Git 安装超过 10 分钟/);
});

test("the install command reports every outcome the UI branches on", () => {
  for (const status of ["already-installed", "winget-missing", "installed", "restart-required", "failed"]) {
    assert.match(backend, new RegExp(`"${status}"\\.to_string\\(\\)`));
  }
  assert.match(backend, /fn install_git_runtime_blocking\(\) -> Result<GitInstallResultCard, String>/);
  assert.match(backend, /async fn read_git_runtime\(\) -> Result<GitRuntimeCard, String>/);
  assert.match(backend, /\n            read_git_runtime,\n            install_git_runtime,/);
  // The existing diagnostic and the new card must not drift apart.
  assert.match(backend, /fn git_runtime_diagnostic\(\) -> Value \{\s*\n\s*let \(available, version, error\) = detect_git_version\(\);/);
});

test("the settings card only appears when it has something to offer", () => {
  assert.match(app, /gitRuntime && !gitRuntime\.available &&/);
  assert.match(app, /gitRuntime\?\.available &&/);
  assert.match(app, /gitRuntime\.wingetAvailable \?/);
  assert.match(app, /t\("set\.gitNoWinget"\)/);
  assert.match(app, /openExternalUrl\(gitRuntime\.downloadPageUrl\)/);
  assert.match(app, /disabled=\{disabled \|\| gitInstallBusy\}/);
  assert.match(types, /export type GitRuntimeCard = \{/);
  assert.match(types, /export type GitInstallResultCard = \{/);
});

test("the Git card is translated in every shipped locale", () => {
  for (const key of [
    "set.gitEyebrow",
    "set.gitTitle",
    "set.gitBody",
    "set.gitInstall",
    "set.gitInstalling",
    "set.gitNoWinget",
    "set.gitOpenDownloadPage",
    "set.gitReadyTitle",
    "set.gitReadyBody"
  ]) {
    assert.equal(
      (i18n.match(new RegExp(`"${key}":`, "g")) ?? []).length,
      3,
      `${key} must exist in all three locales`
    );
  }
  // The copy must not claim Git is required, because v3.2.3 made snapshot
  // sources updatable without it.
  assert.match(i18n, /"set\.gitBody": "没有 Git 也能更新来源/);
});
