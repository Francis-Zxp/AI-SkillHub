import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
const backend = await readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
const i18n = await readFile(new URL("../src/i18n.ts", import.meta.url), "utf8");
const types = await readFile(new URL("../src/types.ts", import.meta.url), "utf8");

test("review findings stop quick add before automatic promotion", () => {
  assert.match(
    app,
    /if \(requiresSecurityReview\(execution\.securityStatus\)\) \{[\s\S]*?setSecurityReview\(\{ execution, plan \}\);[\s\S]*?return;[\s\S]*?\}\s*await promoteAndFinalize\(plan, execution, false\);/
  );
  assert.match(app, /securityReview\.execution\.securityFindings\.slice\(0, 8\)/);
  assert.match(app, /qa\.securityReviewConfirm/);
  assert.match(app, /promoteAndFinalize\(securityReview\.plan, securityReview\.execution, true\)/);
});

test("desktop promotion command receives explicit review confirmation", () => {
  assert.match(
    app,
    /securityReviewConfirmed:\s*options\.securityReviewConfirmed === true/
  );
  assert.match(
    backend,
    /fn promote_staged_source_import\([\s\S]*?security_review_confirmed: bool/
  );
  assert.match(
    backend,
    /matches!\(security\.status\.as_str\(\), "review" \| "warn"\)[\s\S]*?if security_review_confirmed[\s\S]*?显式确认/
  );
  assert.match(backend, /"securityReviewConfirmed": promotion\.security_review_confirmed/);
});

test("security evidence contract and translations are present", () => {
  for (const field of [
    "securityStatus",
    "securityScannedFiles",
    "securityFindings",
    "securityReviewConfirmed"
  ]) {
    assert.match(types, new RegExp(`${field}:`));
  }
  assert.equal(
    (i18n.match(/"qa\.securityReviewConfirm":/g) ?? []).length,
    3,
    "English, Chinese, and Korean confirmation copy must stay in sync"
  );
});
