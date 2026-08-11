import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
const backend = await readFile(new URL("../src-tauri/src/metadata.rs", import.meta.url), "utf8");
const indexer = await readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
const i18n = await readFile(new URL("../src/i18n.ts", import.meta.url), "utf8");

test("library cards no longer duplicate an inferred usage guide", () => {
  assert.doesNotMatch(app, /metadata\.usage/);
  assert.doesNotMatch(app, /source\.usageGuide\s*&&/);
  assert.doesNotMatch(app, /skill\.usageGuide\s*&&/);
  assert.doesNotMatch(i18n, /"metadata\.usage"/);
});
test("offline recognition stores concise summaries and leaves the legacy usage field empty", () => {
  assert.match(backend, /MAX_SKILL_SUMMARY_CHARS: usize = 220/);
  assert.match(backend, /MAX_SOURCE_SUMMARY_CHARS: usize = 260/);
  assert.match(backend, /compact_description\(&purpose, 150, 1\)/);
  assert.match(backend, /包含 \{\} 个子 Skill：/);
  assert.match(backend, /usage_guide: String::new\(\)/);
  assert.doesNotMatch(indexer, /使用方法：\{\}/);
  assert.match(indexer, /note: String::new\(\)/);
});
