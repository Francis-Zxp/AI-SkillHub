#!/usr/bin/env node
// Verify every active parent and declared child from the exact paths used by
// installed Agent recipients.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROUTER_COLLECTION = "AI-SkillHub-local-routers";
const CHILD_MARKER = "[CHILD-SKILL]";
const SOURCE_FILE_LABEL = "来源文件：";

function defaultSourcesFolder() {
  const configPath = path.join(
    process.env.LOCALAPPDATA ?? path.join(homedir(), "AppData", "Local"),
    "AI SkillHub", "UserData", "skillhub.config.json"
  );
  if (!existsSync(configPath)) return null;
  try {
    return JSON.parse(readFileSync(configPath, "utf8")).githubSourcesFolder ?? null;
  } catch {
    return null;
  }
}

export function defaultRecipientRoots(home = homedir()) {
  return [
    { name: "claude", root: path.join(home, ".claude", "skills") },
    { name: "agents", root: path.join(home, ".agents", "skills") },
    { name: "codex_legacy", root: path.join(home, ".codex", "skills") },
    { name: "antigravity", root: path.join(home, ".gemini", "antigravity", "skills") }
  ];
}

export function declaredChildPaths(body) {
  const paths = [];
  for (const line of body.split(/\r?\n/)) {
    if (!line.includes(CHILD_MARKER)) continue;
    const labelAt = line.indexOf(SOURCE_FILE_LABEL);
    if (labelAt < 0) continue;
    const match = /`([^`]+)`/.exec(line.slice(labelAt + SOURCE_FILE_LABEL.length));
    if (match) paths.push(match[1]);
  }
  return paths;
}

function directoriesAt(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root).filter(entry => {
    try {
      return statSync(path.join(root, entry)).isDirectory();
    } catch {
      return false;
    }
  }).sort();
}

export function verifyRouterChildren({ sourcesFolder, recipients = defaultRecipientRoots() }) {
  const routersRoot = path.join(sourcesFolder, ROUTER_COLLECTION);
  if (!existsSync(routersRoot)) throw new Error(`No router collection at ${routersRoot}`);
  const activeSkillsRoot = path.join(path.dirname(path.resolve(sourcesFolder)), "skills");
  const routers = directoriesAt(routersRoot)
    .filter(entry => existsSync(path.join(routersRoot, entry, "SKILL.md")));
  const publishedRouters = routers.filter(router =>
    existsSync(path.join(activeSkillsRoot, router, "SKILL.md"))
  );
  const stats = {
    routers: routers.length,
    published_routers: publishedRouters.length,
    refs: 0,
    absolute: 0,
    physical_ok: 0,
    lexical_ok: 0
  };
  for (const recipient of recipients) {
    stats[`${recipient.name}_entries`] = 0;
    stats[`${recipient.name}_entry_ok`] = 0;
    stats[`${recipient.name}_skipped`] = 0;
  }
  const failures = [];
  const missingEntryKeys = new Set();
  for (const recipient of recipients) {
    if (!existsSync(recipient.root)) {
      stats[`${recipient.name}_skipped`] = 1;
      if (recipient.required) failures.push(`${recipient.name}: recipient root is missing: ${recipient.root}`);
    }
  }

  const normalizedSources = `${path.resolve(sourcesFolder)}${path.sep}`.toLowerCase();
  for (const router of publishedRouters) {
    const routerDir = path.join(routersRoot, router);
    const body = readFileSync(path.join(routerDir, "SKILL.md"), "utf8");
    const declared = declaredChildPaths(body);
    stats.refs += declared.length;
    if (declared.length === 0) failures.push(`${router}: parent declares no child Skills`);

    for (const recipient of recipients) {
      if (!existsSync(recipient.root)) continue;
      if (!existsSync(path.join(recipient.root, router))) {
        const key = `${recipient.name}:${router}`;
        if (!missingEntryKeys.has(key)) {
          missingEntryKeys.add(key);
          failures.push(`${recipient.name}: missing published parent entry ${router}`);
        }
      }
    }

    for (const declaredPath of declared) {
      if (path.isAbsolute(declaredPath)) stats.absolute += 1;
      else failures.push(`${router}: child path is not absolute: ${declaredPath}`);
      const normalizedChild = path.resolve(declaredPath);
      if (!`${normalizedChild}${path.sep}`.toLowerCase().startsWith(normalizedSources)) {
        failures.push(`${router}: child path escapes managed sources: ${declaredPath}`);
      }
      if (existsSync(path.resolve(sourcesFolder, ROUTER_COLLECTION, router, declaredPath))) {
        stats.physical_ok += 1;
      }
      if (existsSync(path.resolve(routerDir, declaredPath))) stats.lexical_ok += 1;

      for (const recipient of recipients) {
        if (!existsSync(recipient.root)) continue;
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
  return { failures, stats };
}

export function formatRouterStats(stats) {
  return Object.entries(stats).map(([key, value]) => `${key}=${value}`).join(" ");
}

function main() {
  const sourcesFolder = process.argv[2] ?? defaultSourcesFolder();
  if (!sourcesFolder) {
    console.error("Could not determine the sources folder. Pass it as the first argument.");
    process.exitCode = 2;
    return;
  }
  try {
    const requested = process.argv.slice(3).map((value, index) => {
      const separator = value.indexOf("=");
      if (separator <= 0 || separator === value.length - 1) {
        throw new Error(`Invalid recipient argument ${index + 1}: ${value}`);
      }
      return { name: value.slice(0, separator), root: value.slice(separator + 1), required: true };
    });
    const result = verifyRouterChildren({
      sourcesFolder,
      recipients: requested.length > 0 ? requested : defaultRecipientRoots()
    });
    console.log(formatRouterStats(result.stats));
    if (result.failures.length > 0) {
      console.error(`\n${result.failures.length} delivery failure(s); first 20:`);
      for (const failure of result.failures.slice(0, 20)) console.error(`  ${failure}`);
      process.exitCode = 1;
      return;
    }
    console.log("OK: every active parent and declared child opens from every installed recipient.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}
