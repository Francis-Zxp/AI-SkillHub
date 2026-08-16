import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { verifyRouterChildren } from "./verify-live-router-children.mjs";

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "skillhub-router-live-verify-"));
  const sources = path.join(root, "UserData", "sources");
  const router = path.join(sources, "AI-SkillHub-local-routers", "alpha");
  const child = path.join(sources, "alpha", "child", "SKILL.md");
  const active = path.join(root, "UserData", "skills", "alpha");
  const recipient = path.join(root, "recipient-skills", "alpha");
  for (const folder of [router, path.dirname(child), active, recipient]) mkdirSync(folder, { recursive: true });
  writeFileSync(child, "---\nname: child\ndescription: child\n---\n", "utf8");
  const body = [
    "---", "name: alpha", "description: parent", "---", "<!-- [ROUTER-HUB] -->",
    `- [CHILD-SKILL] \`$child\` — child 来源文件：\`${child.replaceAll("\\", "/")}\``
  ].join("\n");
  for (const folder of [router, active, recipient]) writeFileSync(path.join(folder, "SKILL.md"), body, "utf8");
  return { root, sources, recipientRoot: path.dirname(recipient) };
}

test("live router verifier requires every published recipient entry", () => {
  const item = fixture();
  try {
    const valid = verifyRouterChildren({
      sourcesFolder: item.sources,
      recipients: [{ name: "fixture", root: item.recipientRoot, required: true }]
    });
    assert.deepEqual(valid.failures, []);
    assert.equal(valid.stats.published_routers, 1);

    rmSync(path.join(item.recipientRoot, "alpha"), { recursive: true, force: true });
    const missingEntry = verifyRouterChildren({
      sourcesFolder: item.sources,
      recipients: [{ name: "fixture", root: item.recipientRoot, required: true }]
    });
    assert.match(missingEntry.failures.join("\n"), /missing published parent entry alpha/);

    const missingRoot = verifyRouterChildren({
      sourcesFolder: item.sources,
      recipients: [{ name: "fixture", root: path.join(item.root, "missing"), required: true }]
    });
    assert.match(missingRoot.failures.join("\n"), /recipient root is missing/);
  } finally {
    rmSync(item.root, { recursive: true, force: true });
  }
});
