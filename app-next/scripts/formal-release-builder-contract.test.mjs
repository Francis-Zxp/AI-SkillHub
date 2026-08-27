import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const appRoot = path.resolve(import.meta.dirname, "..");
const projectRoot = path.resolve(appRoot, "..");
const read = (...parts) => fs.readFileSync(path.join(...parts), "utf8");
const packageJson = JSON.parse(read(appRoot, "package.json"));
const tauriConfig = JSON.parse(read(appRoot, "src-tauri", "tauri.conf.json"));
const version = packageJson.version;
const previousVersion = "3.2.1";
const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const escapedPreviousVersion = previousVersion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const builder = read(appRoot, "scripts", "build-formal-release.ps1");
const nsisQa = read(appRoot, "scripts", "test-nsis-install-upgrade.ps1");
const formalDesktopQa = read(appRoot, "scripts", "v3.2.0-formal-desktop-qa.ps1");
const startupCacheQa = read(appRoot, "scripts", "v3.2.0-startup-cache-qa.cjs");

test("formal release version surfaces agree before signing", () => {
  assert.equal(tauriConfig.version, version);
  assert.match(read(appRoot, "src-tauri", "Cargo.toml"), new RegExp(`^version\\s*=\\s*"${escapedVersion}"`, "m"));
  assert.match(
    read(appRoot, "src-tauri", "Cargo.lock"),
    new RegExp(`\\[\\[package\\]\\]\\s*name\\s*=\\s*"ai-skillhub-next"\\s*version\\s*=\\s*"${escapedVersion}"`, "s"),
  );
  assert.match(read(projectRoot, "CHANGELOG.md"), new RegExp(`^##\\s+${escapedVersion}(?:\\s|$)`, "m"));
  assert.match(
    read(projectRoot, "docs", "release-notes", `v${version}.md`),
    new RegExp(`^#\\s+AI SkillHub v${escapedVersion}\\s*$`, "m"),
  );
  assert.match(read(appRoot, "src", "preview.ts"), new RegExp(`appVersion:\\s*"${escapedVersion} preview"`));
  assert.match(read(appRoot, "src", "i18n.ts"), new RegExp(`"atlas\\.releaseTag":\\s*"${escapedVersion}\\s+·`));
  assert.match(
    read(appRoot, "scripts", "test-nsis-install-upgrade.ps1"),
    new RegExp(`\\[string\\]\\$ExpectedVersion\\s*=\\s*'${escapedVersion}'`),
  );
  assert.match(builder, new RegExp(`\\[string\\]\\$PreviousVersion\\s*=\\s*'${escapedPreviousVersion}'`));
  assert.match(
    read(appRoot, "scripts", "test-nsis-install-upgrade.ps1"),
    new RegExp(`\\[string\\]\\$PreviousExpectedVersion\\s*=\\s*'${escapedPreviousVersion}'`),
  );
});

test("formal builder selects one signed installer by ProductVersion", () => {
  assert.match(builder, /Get-NormalizedProductVersion/);
  assert.match(builder, /\$signedVersionCandidates\.Count -ne 1/);
  assert.match(builder, /Assert-SignedInstaller \$Installer\.FullName \$Version/);
  assert.match(builder, /LastWriteTimeUtc -lt \$buildStartedAtUtc/);
  assert.doesNotMatch(builder, /Sort-Object LastWriteTime -Descending\s*\|\s*Select-Object -First 1/);
});

test("SkipBuild is explicit, versioned, and SHA-256 pinned", () => {
  assert.match(builder, /SkipBuild requires -ExistingInstallerPath/);
  assert.match(builder, /SkipBuild requires a 64-character -ExpectedInstallerSha256/);
  assert.match(builder, /Assert-PathInside \$explicitInstaller \$NsisRoot/);
  assert.match(builder, /Get-FileHash -LiteralPath \$Installer\.FullName -Algorithm SHA256/);
  assert.match(builder, /The explicit installer is not the unique signed v\$Version candidate/);
});

test("future fallback manifest is opt-in after public verification", () => {
  assert.match(builder, /\[switch\]\$PublishFallbackManifest/);
  assert.match(builder, /if \(\$PublishFallbackManifest\) \{\s*New-Item[\s\S]*?WriteAllText\(\s*\$FallbackLatestJsonPath/);
  assert.match(builder, /Fallback updater manifest unchanged; publish it only after the public release assets pass verification/);
  const unconditionalWrites = [...builder.matchAll(/WriteAllText\(\s*\$FallbackLatestJsonPath/g)];
  assert.equal(unconditionalWrites.length, 1, "fallback manifest should have only the guarded write site");
});

test("NSIS QA retries only its bounded TEMP sandbox cleanup", () => {
  assert.match(nsisQa, /function Remove-QaSandboxWithRetry/);
  assert.match(nsisQa, /function Assert-ExactQaRoot/);
  assert.match(nsisQa, /QA cleanup target is not this run's exact GUID sandbox/);
  assert.match(nsisQa, /QA cleanup refuses a reparse-point root/);
  assert.match(nsisQa, /\[DateTime\]::UtcNow\.AddSeconds\(\$TimeoutSeconds\)/);
  assert.match(nsisQa, /Bounded QA sandbox cleanup/);
  assert.match(nsisQa, /function Invoke-BoundedSqlite/);
  assert.doesNotMatch(nsisQa, /& \$sqlite\.Source/);
  assert.match(nsisQa, /Remove-QaSandboxWithRetry -Path \$QaRoot/);
  assert.match(nsisQa, /if \(\$registryRestoreFailed\)/);
  assert.match(nsisQa, /Registry recovery evidence preserved/);
  assert.match(nsisQa, /recovery files preserved at \$QaRoot/);
});

test("formal desktop QA isolates host roots and waits for an app-side startup path", () => {
  assert.match(formalDesktopQa, /'CLAUDE_CONFIG_DIR'/);
  assert.match(formalDesktopQa, /Set-ProcessEnvironment 'CLAUDE_CONFIG_DIR' \(Join-Path \$qaProfileRoot '\.claude'\)/);
  assert.match(formalDesktopQa, /Set-ProcessEnvironment 'AI_SKILLHUB_ROOT' \$qaProjectRoot/);
  assert.match(formalDesktopQa, /Copy-Item -LiteralPath \(Join-Path \$appNextRoot "runtime\\\$runtimeFile"\)/);
  assert.match(formalDesktopQa, /Formal QA app did not expose a verifiable executable path/);
  assert.match(formalDesktopQa, /Cannot verify the isolated QA process path before stopping it/);
  assert.match(startupCacheQa, /value === "unknown" \? false : value/);
  assert.ok(
    startupCacheQa.indexOf("const indexed") < startupCacheQa.indexOf("const startupLoadPath"),
    "startup path must be read after the indexed snapshot has completed",
  );
});
