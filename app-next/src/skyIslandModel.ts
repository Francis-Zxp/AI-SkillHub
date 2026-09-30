import type { LegacySnapshot, SkillCard, SourceCard } from "./types";

export type SkyIsland = {
  id: string;
  name: string;
  skillCount: number;
  /** Number of Prompt or mixed sources, not individual prompt documents. */
  promptCount: number;
  sourceCount: number;
  weight: number;
  seed: number;
  biome: number;
};

function normalizeSourceName(value: string): string {
  return value.trim().toLowerCase().replace(/[_\s]+/g, "-");
}

function sourceAliases(source: SourceCard): string[] {
  return [source.name, (source.url.split("/").pop() ?? "").replace(/\.git$/i, "")]
    .map(normalizeSourceName).filter(Boolean);
}

export function skillBelongsToSource(skill: SkillCard, source: SourceCard): boolean {
  if (skill.sourceId) return skill.sourceId === source.id;
  return sourceAliases(source).includes(normalizeSourceName(skill.source));
}

export function isRouterHubSkill(skill: SkillCard): boolean {
  if (typeof skill.isRouterHub === "boolean") return skill.isRouterHub;
  return skill.description.includes("[ROUTER-HUB]")
    || /(?:^|[\\/])AI-SkillHub-local-routers(?:[\\/]|$)/i.test(skill.relativePath)
    || skill.source.toLowerCase() === "ai-skillhub-local-routers"
    || Boolean(skill.folderName && skill.source
      && normalizeSourceName(skill.folderName) === normalizeSourceName(skill.source));
}

function stableSeed(id: string): number {
  let hash = 2166136261;
  for (let index = 0; index < id.length; index++) {
    hash = Math.imul(hash ^ id.charCodeAt(index), 16777619);
  }
  return hash >>> 0;
}

export function buildSkyIslands(
  snapshot: LegacySnapshot | null | undefined,
  unfiledName: string
): SkyIsland[] {
  if (!snapshot) return [];
  const folders = [...(snapshot.skillFolders ?? [])].sort((left, right) =>
    left.sortOrder - right.sortOrder || left.name.localeCompare(right.name) || left.id.localeCompare(right.id)
  );
  const createIsland = (id: string, name: string): SkyIsland => {
    const seed = stableSeed(id);
    return { id, name, skillCount: 0, promptCount: 0, sourceCount: 0, weight: 0, seed, biome: seed % 6 };
  };
  const islands = folders.map(folder => createIsland(folder.id, folder.name));
  const unfiled = createIsland("unfiled", unfiledName);
  const byFolder = new Map(islands.map(island => [island.id, island]));
  const sourceSets = new Map([...islands, unfiled].map(island => [island.id, new Set<string>()]));
  const destination = (folderId?: string): SkyIsland => byFolder.get(folderId ?? "") ?? unfiled;
  const sourcesById = new Map(snapshot.sources.map(source => [source.id, source]));
  // Name fallback is only for old snapshots without a stable source identity.
  const sourcesByName = new Map<string, SourceCard | null>();
  for (const source of snapshot.sources) {
    for (const name of sourceAliases(source)) {
      sourcesByName.set(name, sourcesByName.has(name) && sourcesByName.get(name) !== source ? null : source);
    }
    const island = destination(source.userFolderId);
    sourceSets.get(island.id)!.add(source.id);
    if (source.sourceType === "prompt" || source.sourceType === "mixed") island.promptCount++;
  }
  for (const skill of snapshot.skills) {
    if (isRouterHubSkill(skill)) continue;
    const owner = skill.sourceId ? sourcesById.get(skill.sourceId)
      : sourcesByName.get(normalizeSourceName(skill.source));
    const island = destination(skill.userFolderId || owner?.userFolderId);
    island.skillCount++;
    if (owner) sourceSets.get(island.id)!.add(owner.id);
  }
  for (const island of [...islands, unfiled]) {
    island.sourceCount = sourceSets.get(island.id)!.size;
    island.weight = island.skillCount + island.promptCount;
  }
  if (unfiled.weight > 0) islands.push(unfiled);
  return islands;
}
