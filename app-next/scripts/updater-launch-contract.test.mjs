import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = p => fs.readFileSync(new URL(p, import.meta.url), "utf8").replace(/\r\n/g, "\n");

test("Windows install checks launch before cleanup and exit", () => {
  const source = read("../vendor/tauri-plugin-updater/src/updater.rs");
  const begin = source.indexOf("/// Windows\n");
  const install = source.slice(begin, source.indexOf("fn installer_args", begin));
  assert.ok(install.indexOf("ShellExecuteW(") < install.indexOf("finish_windows_installer_launch(result as isize"));
  assert.ok(install.indexOf("finish_windows_installer_launch(result as isize") < install.indexOf("std::process::exit(0)"));
  assert.doesNotMatch(install, /on_before_exit\(\)/);
  assert.match(read("../src-tauri/Cargo.toml"), /tauri-plugin-updater = \{ path = "\.\.\/vendor\/tauri-plugin-updater" \}/);
});

test("webview check cannot opt into downgrades", () => {
  const source = read("../vendor/tauri-plugin-updater/src/commands.rs");
  assert.doesNotMatch(source, /allow_downgrades|version_comparator/);
});

test("installer failure message is not a network failure", () => {
  assert.match(read("../src/App.tsx"), /stage === "install" \? "update.failure.install" : "update.errorToast"/);
});

test("unsigned public release is explicit and retains update signatures", () => {
  const source = read("./build-formal-release.ps1");
  assert.match(source, /\[switch\]\$AllowUnsignedPublicRelease/);
  assert.match(source, /if \(-not \$AllowUnsignedLocalCandidate -and -not \$AllowUnsignedPublicRelease\)/);
  assert.match(source, /Assert-SignedInstaller \$Installer.FullName \$Version/);
  assert.match(source, /if \(\$AllowUnsignedLocalCandidate -and \$AllowUnsignedPublicRelease\)/);
});
