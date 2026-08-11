import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [app, diagnostics, i18n, rust, links] = await Promise.all([
  readFile(new URL("../src/App.tsx", import.meta.url), "utf8"),
  readFile(new URL("../runtime/Export-SkillHubDiagnostics.ps1", import.meta.url), "utf8"),
  readFile(new URL("../src/i18n.ts", import.meta.url), "utf8"),
  readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8"),
  readFile(new URL("../runtime/Manage-AgentSkillLinks.ps1", import.meta.url), "utf8")
]);

test("Codex delivery uses the official user scope with safe legacy compatibility", () => {
  assert.match(links, /Join-Path \$EffectiveHome '\.agents\\skills'/);
  assert.match(links, /Test-OpenAIDesktopPresent/);
  assert.match(links, /Get-Process -Name 'ChatGPT', 'Codex'/);
  assert.match(diagnostics, /Get-Process -Name 'ChatGPT', 'Codex'/);
  assert.match(links, /\$codexPresent = \$codexCodePresent -or \$openAIDesktopPresent/);
  assert.match(links, /Test-Path -LiteralPath \(Join-Path \(Join-Path \$RecipientSkillsRoot \$_\.Name\) 'SKILL\.md'\)/);
  assert.match(links, /if \(Test-Path -LiteralPath \$legacyCodexRoot -PathType Container\)/);
  assert.doesNotMatch(links, /New-Item[^\r\n]+\.codex\\skills/);
});

test("all recipients receive the curated parent-first catalog", () => {
  assert.match(links, /function Sync-ManagedSkillDirectory/);
  assert.match(links, /Sync-ManagedSkillDirectory \$claudePath/);
  assert.match(links, /Sync-ManagedSkillDirectory \$antigravityPath/);
  assert.match(links, /Sync-ManagedSkillDirectory \$codexRoot/);
  assert.match(links, /Recipient Skills root is an external link and was preserved/);
  assert.match(rust, /Same-name child aliases belonged to the old flat catalog/);
  assert.match(rust, /routed-via-parent/);
  assert.match(i18n, /由父 Skill 调用/);
});

test("diagnostics and runtime agree on .agents/skills and expand redacted home paths", () => {
  const officialIndex = diagnostics.indexOf("Join-Path $HomePath '.agents\\skills'");
  const legacyIndex = diagnostics.indexOf("Join-Path $codexConfigRoot 'skills'");
  assert.ok(officialIndex >= 0 && officialIndex < legacyIndex);
  assert.match(diagnostics, /containsSkillMd = \$containsSkillMd/);
  assert.match(rust, /"~\\\\\.agents\\\\skills"/);
  assert.match(rust, /fn expand_user_home_path/);
  assert.match(rust, /fn active_agent_entry_names_for_skill/);
  assert.match(rust, /\.find\(\|path\| path\.join\("SKILL\.md"\)\.is_file\(\)\)/);
  assert.match(rust, /installed_entry_name/);
});

test("startup repairs a detected recipient and UI documents host-specific invocation", () => {
  assert.match(app, /invoke<LegacySnapshot>\("refresh_agent_detection"\)/);
  assert.match(app, /invoke<LegacySnapshot>\("ensure_agent_skill_delivery"\)/);
  assert.match(app, /shouldReconcileDelivery = detected\.skills\.length > 0/);
  assert.match(i18n, /ChatGPT 输入 @；Codex 输入 \/skills 或 \$。/);
  assert.match(app, /return \/\^\[\\\/@\$\]\//);
});

test("disabled and invalid Skills are not published to a recipient", () => {
  assert.match(rust, /COALESCE\(skill_overrides\.enabled, skills\.enabled, 1\) = 1/);
  assert.match(rust, /COALESCE\(source_overrides\.enabled, sources\.enabled, 1\) = 1/);
  assert.match(links, /Test-ValidSkillManifest/);
  assert.match(rust, /"skill-disabled"/);
  assert.match(rust, /"invalid-manifest"/);
});

test("display-only task bundles are not exposed in primary navigation", () => {
  const navBlock = app.match(/const NAV_ITEMS:[\s\S]*?\];/)?.[0] ?? "";
  assert.ok(navBlock);
  assert.doesNotMatch(navBlock, /key: "presets"/);
  assert.doesNotMatch(app, /active === "presets" && <Presets/);
});
