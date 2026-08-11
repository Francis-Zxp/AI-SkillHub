import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [app, i18n, localized, links, rust, styles, sync] = await Promise.all([
  readFile(new URL("../src/App.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/i18n.ts", import.meta.url), "utf8"),
  readFile(new URL("../src/localizedDescriptions.ts", import.meta.url), "utf8"),
  readFile(new URL("../runtime/Manage-AgentSkillLinks.ps1", import.meta.url), "utf8"),
  readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8"),
  readFile(new URL("../src/styles.css", import.meta.url), "utf8"),
  readFile(new URL("../runtime/SkillHub.ps1", import.meta.url), "utf8")
]);

test("every non-empty source receives a stable source-scoped parent", () => {
  assert.match(rust, /including a SKILL\.md at the source root/);
  assert.doesNotMatch(rust, /"skipped-single-child"\.to_string\(\)/);
  assert.doesNotMatch(rust, /"skipped-collision"\.to_string\(\)/);
  assert.match(rust, /父 Skill · \{collection\}/);
  assert.match(rust, /<!-- \{marker\} -->/);
  assert.doesNotMatch(rust, /description:.*ROUTER_HUB_MARKER/);
  assert.match(rust, /只能打开下方/);
  assert.match(rust, /绝不跨来源替换/);
  assert.match(sync, /if \(\$childSkills\.Count -lt 1\) \{ return \}/);
  assert.match(sync, /聚合 \$\(\$childSkills\.Count\) 个来源内子 Skill/);
  assert.match(sync, /managed shared catalog publishes one canonical parent per source/);
  assert.match(sync, /\(\[string\]\$_.Repo\) -ne 'AI-SkillHub-local-routers'/);
  assert.match(sync, /Where-Object \{[\s\S]*?routerSourcePrefix/);
});

test("same-name children are automatic parent isolation, not a manual decision workflow", () => {
  assert.match(app, /function ParentIsolationPanel/);
  assert.match(app, /conf\.parentIsolationActive/);
  assert.doesNotMatch(app, /function SkillConflictPanel/);
  assert.doesNotMatch(app, /conf\.setDefault/);
  assert.match(rust, /Duplicate children are no longer published as global dispatchers/);
  assert.match(i18n, /不需要选择默认项/);
  assert.match(styles, /\.parent-isolation-panel/);
  assert.doesNotMatch(sync, /conflicts need manual config/);
  assert.doesNotMatch(sync, /需要人工处理的冲突/);
});

test("primary library header omits maintenance-only evidence and revision hashes", () => {
  const sourceHeader = app.match(/<header className="source-group-head">[\s\S]*?<\/header>/)?.[0] ?? "";
  assert.ok(sourceHeader);
  assert.doesNotMatch(sourceHeader, /SourceQualityChip/);
  assert.doesNotMatch(sourceHeader, /SourceVersionChip/);
  assert.doesNotMatch(sourceHeader, /PopularityChip/);
  assert.doesNotMatch(app, /source-quality-panel/);
  assert.match(sourceHeader, /status-badge/);
  assert.match(sourceHeader, /source-parent-rating/);
  assert.match(sourceHeader, /onSetSourceRating/);
  assert.match(sourceHeader, /ToggleSwitch/);
});

test("descriptions localize locally with original metadata left untouched", () => {
  assert.match(app, /localizedSkillDescription\(skill, getLang\(\)\)/);
  assert.match(localized, /if \(lang === "en"\) return original/);
  assert.match(localized, /用于科研论文的写作、润色与结构优化/);
  assert.match(localized, /父 Skill“\$\{collection\}”的统一入口/);
  assert.doesNotMatch(localized, /fetch\(|invoke\(|writeFile/);
});

test("Codex Claude and Antigravity use the same curated per-entry delivery", () => {
  assert.match(links, /Sync-ManagedSkillDirectory \$claudePath/);
  assert.match(links, /Sync-ManagedSkillDirectory \$antigravityPath/);
  assert.match(links, /Sync-ManagedSkillDirectory \$codexRoot/);
  assert.match(rust, /routed-via-parent/);
  assert.match(rust, /Some\(GeneratedAgentSkillDependency::Skill \{ \.\. \}\) => false/);
});
