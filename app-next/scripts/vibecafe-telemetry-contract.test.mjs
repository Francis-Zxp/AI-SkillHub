import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const loader = readFileSync(new URL("../src/telemetry.ts", import.meta.url), "utf8");
const head = html.match(/<head>([\s\S]*?)<\/head>/i)?.[1] ?? "";
// v3.3 (DECISIONS 2026-10-07): the tag is inert configuration; src/telemetry.ts loads the
// script only while 设置 → 帮助与诊断 → 使用统计 is on (default on).
const telemetryTags = html.match(
  /<script\b[^>]*\bdata-src=["']https:\/\/vibecafe\.ai\/telemetry\/v1\.js["'][^>]*><\/script>/gi,
) ?? [];

test("VibeCafe telemetry config is present exactly once in the shared head and is inert", () => {
  assert.equal(telemetryTags.length, 1);
  assert.ok(head.includes(telemetryTags[0]));
  assert.match(telemetryTags[0], /\btype=["']text\/plain["']/i);
  assert.match(telemetryTags[0], /\bid=["']vc-telemetry-config["']/i);
  assert.doesNotMatch(telemetryTags[0], /\ssrc=/i);
  assert.match(
    telemetryTags[0],
    /\bdata-vc-product-id=["']cmswcmatc00420ai03o0yxwpt["']/i,
  );
});

test("VibeCafe browser identifier stays out of URLs and management code", () => {
  const authKey = telemetryTags[0].match(/\bdata-vc-auth-key=["']([^"']+)["']/i)?.[1] ?? "";
  const authKeyHash = createHash("sha256").update(authKey).digest("hex");

  assert.match(authKey, /^vc_web_[A-Za-z0-9]+$/);
  assert.equal(
    authKeyHash,
    "44e90bcbbdf804fa0fee92fe55d8edc6e326572cbd1593be0dc283e37fcb90af",
  );
  assert.doesNotMatch(telemetryTags[0], /data-src=["'][^"']*[?#]/i);
  assert.equal(html.match(/data-vc-auth-key=/gi)?.length, 1);
  assert.doesNotMatch(loader, /vc_web_/);
});

test("the loader injects the script once, only while usage statistics are on", () => {
  assert.match(loader, /if \(injected \|\| typeof document === "undefined" \|\| !telemetryEnabled\(\)\) return;/);
  assert.match(loader, /\/\^https:\\\/\\\/vibecafe\\\.ai\\\/telemetry\\\/v1\\\.js\$\/\.test\(src\)/);
  assert.match(loader, /if \(name\.startsWith\("data-vc-"\)\) script\.setAttribute/);
});
