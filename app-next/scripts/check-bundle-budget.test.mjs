import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { checkBundleBudget } from "./check-bundle-budget.mjs";

async function withBundle(jsBytes, cssBytes, run) {
  const root = await mkdtemp(path.join(tmpdir(), "ai-skillhub-bundle-budget-"));
  const assets = path.join(root, "assets");
  await mkdir(assets);
  await Promise.all([
    writeFile(path.join(assets, "index-fixture.js"), Buffer.alloc(jsBytes, "j")),
    writeFile(path.join(assets, "index-fixture.css"), Buffer.alloc(cssBytes, "c")),
  ]);
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("bundle budget reports raw, gzip and relative baseline sizes", async () => {
  await withBundle(80, 40, async (distDir) => {
    const report = await checkBundleBudget({
      distDir,
      budget: {
        js: { baseline: 100, limit: 90 },
        css: { baseline: 50, limit: 45 },
      },
    });
    assert.equal(report.passed, true);
    assert.deepEqual(
      { raw: report.assets.js.raw, baseline: report.assets.js.baseline, delta: report.assets.js.delta },
      { raw: 80, baseline: 100, delta: -20 },
    );
    assert.equal(report.assets.js.deltaPercent, -20);
    assert.ok(report.assets.js.gzip > 0);
    assert.ok(report.assets.css.gzip > 0);
  });
});

test("bundle budget fails when either main asset exceeds its limit", async () => {
  await withBundle(91, 40, async (distDir) => {
    const report = await checkBundleBudget({
      distDir,
      budget: {
        js: { baseline: 80, limit: 90 },
        css: { baseline: 40, limit: 45 },
      },
    });
    assert.equal(report.passed, false);
    assert.equal(report.assets.js.passed, false);
    assert.equal(report.assets.css.passed, true);
  });
});
