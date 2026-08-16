#!/usr/bin/env node
// Verify that every child Skill a generated parent router declares can actually
// be opened by a recipient Agent.
//
// A recipient never sees the router at its physical location. It opens the copy
// delivered into its own home (~/.claude/skills/<Name>/SKILL.md and friends),
// which is a directory junction, and it resolves any relative path lexically
// against that entry -- Node's path.resolve, Rust's Path::join and .NET's
// Path.GetFullPath all agree here, and all of them disagree with a shell's `cd`.
// So a declared path only works for every consumer if it is absolute.
//
// Usage:
//   node scripts/verify-live-router-children.mjs [sourcesFolder]
//
// Exits non-zero when any declared child is unreachable from any recipient.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const ROUTER_COLLECTION = "AI-SkillHub-local-routers";
const CHILD_MARKER = "[CHILD-SKILL]";
const SOURCE_FILE_LABEL = "来源文件："; // 来源文件：

function defaultSourcesFolder() {
  const configPath = path.join(
    process.env.LOCALAPPDATA ?? path.join(homedir(), "AppData", "Local"),
    "AI SkillHub",
    "UserData",
    "skillhub.config.json"
  );
  if (!existsSync(configPath)) return null;
  try {
    return JSON.parse(readFileSync(configPath, "utf8")).githubSourcesFolder ?? null;
  } catch {
    return null;
  }
}

const sourcesFolder = process.argv[2] ?? defaultSourcesFolder();
if (!sourcesFolder) {
  console.error("Could not determine the sources folder. Pass it as the first argument.");
  process.exit(2);
}

const routersRoot = path.join(sourcesFolder, ROUTER_COLLECTION);
if (!existsSync(routersRoot)) {
  console.error(`No router collection at ${routersRoot}`);
  process.exit(2);
}

// Where each host publishes the entries. These are the paths an Agent resolves
// relative to, so they are the ones that decide whether the fix worked.
const recipients = [
  { name: "claude", root: path.join(homedir(), ".claude", "skills") },
  { name: "codex", root: path.join(homedir(), ".codex", "skills") },
  { name: "agents", root: path.join(homedir(), ".agents", "skills") }
];

function declaredChildPaths(body) {
  const paths = [];
  for (const line of body.split(/\r?\n/)) {
    if (!line.includes(CHILD_MARKER)) continue;
    const labelAt = line.indexOf(SOURCE_FILE_LABEL);
    if (labelAt < 0) continue;
    const tail = line.slice(labelAt + SOURCE_FILE_LABEL.length);
    const match = /`([^`]+)`/.exec(tail);
    if (match) paths.push(match[1]);
  }
  return paths;
}

const routers = readdirSync(routersRoot)
  .filter((entry) => {
    try {
      return statSync(path.join(routersRoot, entry)).isDirectory();
    } catch {
      return false;
    }
  })
  .filter((entry) => existsSync(path.join(routersRoot, entry, "SKILL.md")))
  .sort();

const stats = {
  routers: routers.length,
  refs: 0,
  absolute: 0,
  physical_ok: 0,
  lexical_ok: 0
};
for (const recipient of recipients) {
  stats[`${recipient.name}_entries`] = 0;
  stats[`${recipient.name}_entry_ok`] = 0;
}
const failures = [];

for (const router of routers) {
  const routerDir = path.join(routersRoot, router);
  const body = readFileSync(path.join(routerDir, "SKILL.md"), "utf8");
  const declared = declaredChildPaths(body);
  stats.refs += declared.length;

  for (const declaredPath of declared) {
    if (path.isAbsolute(declaredPath)) stats.absolute += 1;

    // Physical resolution: what a shell does after `cd` into the junction.
    const physical = path.resolve(sourcesFolder, ROUTER_COLLECTION, router, declaredPath);
    if (existsSync(physical)) stats.physical_ok += 1;

    // Lexical resolution from the physical router location.
    if (existsSync(path.resolve(routerDir, declaredPath))) stats.lexical_ok += 1;

    for (const recipient of recipients) {
      const entryDir = path.join(recipient.root, router);
      if (!existsSync(entryDir)) continue;
      stats[`${recipient.name}_entries`] += 1;
      if (existsSync(path.resolve(entryDir, declaredPath))) {
        stats[`${recipient.name}_entry_ok`] += 1;
      } else {
        failures.push(`${recipient.name}: ${router} -> ${declaredPath}`);
      }
    }
  }
}

const line = Object.entries(stats)
  .map(([key, value]) => `${key}=${value}`)
  .join(" ");
console.log(line);

if (failures.length > 0) {
  console.error(`\n${failures.length} unreachable declaration(s); first 20:`);
  for (const failure of failures.slice(0, 20)) console.error(`  ${failure}`);
  process.exit(1);
}
console.log("OK: every declared child opens from every published recipient entry.");
