import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

export const DEFAULT_BUNDLE_BUDGET = Object.freeze({
  js: { baseline: 612_645, limit: 625_000 },
  css: { baseline: 211_108, limit: 216_000 },
});

async function findSingleAsset(assetsDir, extension) {
  const names = (await readdir(assetsDir)).filter((name) =>
    new RegExp(`^index-[A-Za-z0-9_-]+\\.${extension}$`).test(name),
  );
  if (names.length !== 1) {
    throw new Error(`Expected exactly one main index ${extension.toUpperCase()} asset; found ${names.length}.`);
  }
  return names[0];
}

function measure(name, content, budget) {
  const raw = content.byteLength;
  const delta = raw - budget.baseline;
  return {
    name,
    raw,
    gzip: gzipSync(content).byteLength,
    baseline: budget.baseline,
    delta,
    deltaPercent: (delta / budget.baseline) * 100,
    limit: budget.limit,
    passed: raw <= budget.limit,
  };
}

export async function checkBundleBudget({
  distDir = path.resolve(import.meta.dirname, "../dist"),
  budget = DEFAULT_BUNDLE_BUDGET,
} = {}) {
  const assetsDir = path.join(distDir, "assets");
  const [jsName, cssName] = await Promise.all([
    findSingleAsset(assetsDir, "js"),
    findSingleAsset(assetsDir, "css"),
  ]);
  const [jsContent, cssContent] = await Promise.all([
    readFile(path.join(assetsDir, jsName)),
    readFile(path.join(assetsDir, cssName)),
  ]);
  const assets = {
    js: measure(jsName, jsContent, budget.js),
    css: measure(cssName, cssContent, budget.css),
  };
  return {
    passed: Object.values(assets).every((asset) => asset.passed),
    assets,
  };
}

function formatDelta(asset) {
  const sign = asset.delta >= 0 ? "+" : "";
  return `${sign}${asset.delta} B (${sign}${asset.deltaPercent.toFixed(2)}%)`;
}

function printReport(report) {
  console.log("AI SkillHub frontend bundle budget");
  for (const [kind, asset] of Object.entries(report.assets)) {
    console.log(
      `${kind.toUpperCase()} ${asset.name}: raw ${asset.raw} B, gzip ${asset.gzip} B, ` +
        `baseline ${asset.baseline} B, delta ${formatDelta(asset)}, limit ${asset.limit} B — ` +
        `${asset.passed ? "PASS" : "FAIL"}`,
    );
  }
}

const isCli = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isCli) {
  try {
    const report = await checkBundleBudget();
    printReport(report);
    if (!report.passed) process.exitCode = 1;
  } catch (error) {
    console.error(`Bundle budget check failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
