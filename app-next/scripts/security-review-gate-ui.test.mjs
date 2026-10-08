import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { readAppSource } from "./app-source.mjs";

const app = await readAppSource();
const backend = await readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
const i18n = await readFile(new URL("../src/i18n.ts", import.meta.url), "utf8");
const i18nV33 = await readFile(new URL("../src/i18nV33.ts", import.meta.url), "utf8");
const types = await readFile(new URL("../src/types.ts", import.meta.url), "utf8");
const errors = await readFile(new URL("../src/skillErrors.ts", import.meta.url), "utf8");

const sheet = app.slice(app.indexOf("export function ImportSheet"), app.indexOf("function SkillGroups"));

test("review findings keep an added source library-only and never sync it (I-5)", () => {
  // v3.3 §6.4: a flagged probe can only be "仅加入技能库（保持停用）"; agent chips are locked.
  assert.ok(sheet.includes('const review = probe.security.status === "review";'));
  assert.ok(sheet.includes("const agentIds = review || promptOnly || !probe.security.canSyncToAgents ? [] : [...chips];"));
  // A started install cannot be cancelled by closing the sheet (it would discard the staged copy).
  assert.ok(sheet.includes('if (phase.kind === "installing") return;'));
  assert.ok(sheet.includes("securityReviewConfirmed: review,"));
  assert.ok(sheet.includes("security.findings.slice(0, 8)"));
  assert.ok(sheet.includes('else if (review) submitLabel = t("v33.submitLibraryOnly");'));
  assert.ok(sheet.includes("const chipsLocked = !security.canSyncToAgents || review;"));
  // A structural block cannot be added at all.
  assert.ok(sheet.includes('const blocked = probe.security.status === "blocked" || !probe.security.canAddToLibrary;'));
  // Probing is automatic; installing only ever happens from the submit click.
  assert.equal((sheet.match(/void submit\(/g) ?? []).length, 1);
  assert.match(i18nV33, /"v33\.submitLibraryOnly": "仅加入技能库（保持停用）"/);
});

test("turning a flagged pack on requires the explicit review confirmation", () => {
  assert.match(types, /securityReviewConfirmed: boolean;/);
  assert.ok(app.includes('if (normalized.code === "SECURITY_REVIEW_REQUIRED") {'));
  assert.ok(app.includes("const ok = await setSourceLibraryEnabled(reviewSource, true, true);"));
  assert.ok(app.includes("enabled: source.enabled,"), "metadata saves never flip the library switch");
  assert.match(backend, /fn promote_staged_source_import\([\s\S]*?security_review_confirmed: bool/);
  assert.match(backend, /content_review_required[\s\S]*?security_review_confirmed[\s\S]*?security_review_confirmed = true/);
});

test("security evidence contract and translations are present", () => {
  for (const field of ["securityStatus", "securityScannedFiles", "securityFindings", "securityReviewConfirmed"]) {
    assert.match(types, new RegExp(`${field}:`));
  }
  for (const key of ["v33.securityReview", "v33.securityNotRun", "v33.securityKeptOff", "v33.reviewBody", "v33.reviewConfirm"]) {
    assert.equal((i18nV33.match(new RegExp(`"${key.replace(".", "\.")}":`, "g")) ?? []).length, 3, `${key} in en/zh/ko`);
  }
  assert.equal((i18n.match(/"qa\.securityReviewConfirm":/g) ?? []).length, 3);
});

test("a missing Git is reported with an install action and long paths stay safe", () => {
  assert.match(errors, /code: "GIT_MISSING", action: "install-git"/);
  assert.ok(app.includes('case "install-git":'));
  assert.match(backend, /"core\.longpaths=true"[\s\S]*?"clone"/);
  assert.match(backend, /configure_safe_git_materialization[\s\S]*?"core\.longpaths=true"/);
  assert.match(backend, /filename too long[\s\S]*?Windows 长路径/i);
  assert.match(backend, /const SOURCE_IMPORT_MAX_DEPTH: usize = 24/);
});
