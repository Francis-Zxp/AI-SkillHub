import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const head = html.match(/<head>([\s\S]*?)<\/head>/i)?.[1] ?? "";
const telemetryTags = html.match(
  /<script\b[^>]*\bsrc=["']https:\/\/vibecafe\.ai\/telemetry\/v1\.js["'][^>]*><\/script>/gi,
) ?? [];

test("VibeCafe browser telemetry is present exactly once in the shared head", () => {
  assert.equal(telemetryTags.length, 1);
  assert.ok(head.includes(telemetryTags[0]));
  assert.match(telemetryTags[0], /\bdefer\b/i);
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
  assert.doesNotMatch(telemetryTags[0], /src=["'][^"']*[?#]/i);
  assert.equal(html.match(/data-vc-auth-key=/gi)?.length, 1);
});
