// v3.3 counting rules (skills contract §4.6, invariant I-11).
// One module decides what a "技能" (callable skill), a "技能包" (pack) and a library
// row are, so the islands, the library header, the folder chips, the home metrics,
// the sidebar and the agent cards always show the same numbers.
// Pure: no runtime imports, only `import type`, so node tests can transpile it alone.
import type {
  DeliveryUnit,
  LegacySnapshot,
  SkillCard,
  SkillFolderCard,
  SkillTarget,
  SourceCard,
  SourceGovernanceCard
} from "./types";

export type CountScope = {
  /** "all" | "unfiled" | folder id. Membership = skill.userFolderId || owner.userFolderId (as in skyIslandModel). */
  folderId?: string;
  /** Restrict to these unit ids. */
  unitIds?: ReadonlySet<string>;
};

export type SkillCounts = {
  /** Callable skills (技能). */
  skills: number;
  /** Callable skills with skill.enabled && pack library-enabled. */
  enabledSkills: number;
  /** Sources with ≥1 callable skill (技能包). */
  packs: number;
  /** Sources with 0 callable skills and sourceType prompt|mixed (资料). */
  promptPacks: number;
  /** Callable skills with no owning source; each is its own library row. */
  standaloneSkills: number;
  /** Skill-type sources with no indexed skill at all (usually a failed install); shown so they can be removed. */
  emptyPacks: number;
  /** packs + promptPacks + standaloneSkills (+ emptyPacks) = rows under the 全部 filter. */
  rows: number;
  /** Rows with ≥1 target status "synced" (0 when skillDelivery is absent). */
  syncedRows: number;
  /** Deliverable rows with no synced target. */
  unsyncedRows: number;
  /** Rows whose sourceGovernance.relation === "update-available". */
  updateRows: number;
  /** Rows matching rowFilterState(...).problem. */
  problemRows: number;
};

export type LibraryRowKind = "pack" | "prompt" | "standalone" | "empty";

export type LibraryRow = {
  /** Unit id for packs/standalone skills (sources.id or "standalone:" + skill id); source id for prompt/empty rows. */
  key: string;
  kind: LibraryRowKind;
  source: SourceCard | null;
  /** The standalone skill, or null for source rows. */
  skill: SkillCard | null;
  /** Callable skills shown under the row (the row itself is the parent entry). */
  skills: SkillCard[];
  /** Every indexed skill owned by the row, router entries included. */
  ownedSkills: SkillCard[];
  unit: DeliveryUnit | null;
  targets: SkillTarget[];
  governance: SourceGovernanceCard | null;
  /** Resolved folder of the row itself ("" = unfiled). */
  folderId: string;
  /** Resolved folders of the callable skills ("" = unfiled). */
  skillFolderIds: string[];
};

type SnapshotInput = Pick<LegacySnapshot, "skills" | "sources">
  & Partial<Pick<LegacySnapshot, "skillDelivery" | "sourceGovernance" | "skillFolders">>;

function normalizeName(value: string): string {
  return value.trim().toLowerCase().replace(/[_\s]+/g, "-");
}

function sourceAliases(source: SourceCard): string[] {
  return [source.name, ((source.url ?? "").split("/").pop() ?? "").replace(/\.git$/i, "")]
    .map(normalizeName)
    .filter(Boolean);
}

/** Same rule as skyIslandModel.isRouterHubSkill, duplicated here to stay import-free. */
export function isGeneratedRouterSkill(skill: SkillCard): boolean {
  if (typeof skill.isRouterHub === "boolean") return skill.isRouterHub;
  return (skill.description ?? "").includes("[ROUTER-HUB]")
    || /(?:^|[\\/])AI-SkillHub-local-routers(?:[\\/]|$)/i.test(skill.relativePath ?? "")
    || (skill.source ?? "").toLowerCase() === "ai-skillhub-local-routers"
    || Boolean(skill.folderName && skill.source && normalizeName(skill.folderName) === normalizeName(skill.source));
}

/**
 * Callable rule: in a pack with exactly 1 indexed skill, that skill is callable even if isRouterHub
 * (fixes bug #40); in a pack with ≥2 skills, router hubs are excluded; standalone skills
 * (skillsInSamePack = 0) are callable unless they are generated routers.
 */
export function isCallableSkill(skill: SkillCard, skillsInSamePack: number): boolean {
  if (skillsInSamePack === 1) return true;
  return !isGeneratedRouterSkill(skill);
}

/** Resolve each skill's owning source: exact sourceId, else a unique name alias (old snapshots). */
export function resolveSkillOwners(
  skills: readonly SkillCard[],
  sources: readonly SourceCard[]
): Map<SkillCard, SourceCard | null> {
  const byId = new Map(sources.map(source => [source.id, source]));
  const byName = new Map<string, SourceCard | null>();
  for (const source of sources) {
    for (const alias of sourceAliases(source)) {
      byName.set(alias, byName.has(alias) && byName.get(alias) !== source ? null : source);
    }
  }
  const owners = new Map<SkillCard, SourceCard | null>();
  for (const skill of skills) {
    const owner = skill.sourceId
      ? byId.get(skill.sourceId) ?? null
      : byName.get(normalizeName(skill.source ?? "")) ?? null;
    owners.set(skill, owner);
  }
  return owners;
}

export function callableSkillsOf(source: SourceCard, skills: readonly SkillCard[]): SkillCard[] {
  const owners = resolveSkillOwners(skills, [source]);
  const owned = skills.filter(skill => owners.get(skill) === source);
  return owned.filter(skill => isCallableSkill(skill, owned.length));
}

/** Stable unit id of a standalone skill (preview fixtures may omit skill.id). */
export function standaloneUnitId(skill: SkillCard): string {
  return `standalone:${skill.id || `preview-skill-${skill.folderName}`}`;
}

function folderResolver(folders: readonly SkillFolderCard[] | undefined) {
  const known = folders ? new Set(folders.map(folder => folder.id)) : null;
  return (folderId: string | undefined) => {
    const value = (folderId ?? "").trim();
    if (!value) return "";
    return known && !known.has(value) ? "" : value;
  };
}

/**
 * Rows are derived once per snapshot object: the folder chips, filter bar, header and pages all
 * ask for the same snapshot, so they share one array. The WeakMap lets an old snapshot and its
 * rows be collected together (no unbounded cache).
 */
const rowsBySnapshot = new WeakMap<object, LibraryRow[]>();

/** Every library row under the 全部 filter, in source order then standalone skills. */
export function buildLibraryRows(snapshot: SnapshotInput | null | undefined): LibraryRow[] {
  if (!snapshot) return [];
  const cached = rowsBySnapshot.get(snapshot);
  if (cached) return cached;
  const rows = deriveLibraryRows(snapshot);
  rowsBySnapshot.set(snapshot, rows);
  return rows;
}

function deriveLibraryRows(snapshot: SnapshotInput): LibraryRow[] {
  const sources = snapshot.sources ?? [];
  const skills = snapshot.skills ?? [];
  const owners = resolveSkillOwners(skills, sources);
  const resolveFolder = folderResolver(snapshot.skillFolders);
  const delivery = snapshot.skillDelivery;
  const unitsById = new Map((delivery?.units ?? []).map(unit => [unit.unitId, unit]));
  const targetsByUnit = new Map<string, SkillTarget[]>();
  for (const target of delivery?.targets ?? []) {
    const list = targetsByUnit.get(target.unitId);
    if (list) list.push(target);
    else targetsByUnit.set(target.unitId, [target]);
  }
  const governanceById = new Map((snapshot.sourceGovernance ?? []).map(item => [item.sourceId, item]));
  const ownedBySource = new Map<string, SkillCard[]>();
  const standalone: SkillCard[] = [];
  for (const skill of skills) {
    const owner = owners.get(skill);
    if (owner) {
      const list = ownedBySource.get(owner.id);
      if (list) list.push(skill);
      else ownedBySource.set(owner.id, [skill]);
    } else {
      standalone.push(skill);
    }
  }

  const rows: LibraryRow[] = [];
  for (const source of sources) {
    const owned = ownedBySource.get(source.id) ?? [];
    const callable = owned.filter(skill => isCallableSkill(skill, owned.length));
    const sourceFolder = resolveFolder(source.userFolderId);
    const kind: LibraryRowKind = callable.length > 0
      ? "pack"
      : source.sourceType === "prompt" || source.sourceType === "mixed" ? "prompt" : "empty";
    rows.push({
      key: source.id,
      kind,
      source,
      skill: null,
      skills: callable,
      ownedSkills: owned,
      unit: unitsById.get(source.id) ?? null,
      targets: targetsByUnit.get(source.id) ?? [],
      governance: governanceById.get(source.id) ?? null,
      folderId: sourceFolder,
      skillFolderIds: callable.map(skill => resolveFolder(skill.userFolderId) || sourceFolder)
    });
  }
  for (const skill of standalone) {
    if (!isCallableSkill(skill, 0)) continue;
    const key = standaloneUnitId(skill);
    const folder = resolveFolder(skill.userFolderId);
    rows.push({
      key,
      kind: "standalone",
      source: null,
      skill,
      skills: [skill],
      ownedSkills: [skill],
      unit: unitsById.get(key) ?? null,
      targets: targetsByUnit.get(key) ?? [],
      governance: null,
      folderId: folder,
      skillFolderIds: [folder]
    });
  }
  return rows;
}

/** A row belongs to a folder when the row itself or any of its callable skills is filed there. */
export function rowInFolder(row: LibraryRow, folderId: string | undefined): boolean {
  if (!folderId || folderId === "all") return true;
  const target = folderId === "unfiled" ? "" : folderId;
  return row.folderId === target || row.skillFolderIds.includes(target);
}

/** Callable skills of a row that belong to the folder scope. */
export function rowSkillsInFolder(row: LibraryRow, folderId: string | undefined): SkillCard[] {
  if (!folderId || folderId === "all") return row.skills;
  const target = folderId === "unfiled" ? "" : folderId;
  return row.skills.filter((_, index) => row.skillFolderIds[index] === target);
}

function governanceFailed(governance: SourceGovernanceCard | null): boolean {
  const status = (governance?.status ?? "").toLowerCase();
  return /error|fail/.test(status);
}

/** Used by the library filter bar and by countSkills. */
export function rowFilterState(row: {
  unit: DeliveryUnit | null;
  targets: readonly SkillTarget[];
  source: SourceCard | null;
  governance: SourceGovernanceCard | null;
}): { synced: boolean; unsynced: boolean; update: boolean; problem: boolean } {
  const synced = row.targets.some(target => target.status === "synced");
  const deliverable = Boolean(row.unit) && row.unit?.libraryOnlyReason !== "prompt-only";
  const reason = row.unit?.libraryOnlyReason ?? "";
  const problem =
    row.targets.some(target => target.status === "error" || target.status === "conflict" || target.status === "orphan") ||
    row.source?.health === "error" ||
    reason === "security-review" ||
    reason === "invalid-manifest" ||
    governanceFailed(row.governance);
  return {
    synced,
    unsynced: deliverable && !synced,
    update: row.governance?.relation === "update-available",
    problem
  };
}

function unitLibraryEnabled(row: LibraryRow): boolean {
  if (row.unit) return row.unit.libraryEnabled;
  if (row.source) return row.source.enabled !== false;
  return true;
}

export function countSkills(snapshot: SnapshotInput | null | undefined, scope: CountScope = {}): SkillCounts {
  const counts: SkillCounts = {
    skills: 0,
    enabledSkills: 0,
    packs: 0,
    promptPacks: 0,
    standaloneSkills: 0,
    emptyPacks: 0,
    rows: 0,
    syncedRows: 0,
    unsyncedRows: 0,
    updateRows: 0,
    problemRows: 0
  };
  for (const row of buildLibraryRows(snapshot)) {
    if (scope.unitIds && !scope.unitIds.has(row.key)) continue;
    if (!rowInFolder(row, scope.folderId)) continue;
    const scopedSkills = rowSkillsInFolder(row, scope.folderId);
    counts.skills += scopedSkills.length;
    if (unitLibraryEnabled(row)) counts.enabledSkills += scopedSkills.filter(skill => skill.enabled).length;
    if (row.kind === "pack") counts.packs += 1;
    else if (row.kind === "prompt") counts.promptPacks += 1;
    else if (row.kind === "standalone") counts.standaloneSkills += 1;
    else counts.emptyPacks += 1;
    counts.rows += 1;
    const state = rowFilterState(row);
    if (state.synced) counts.syncedRows += 1;
    if (state.unsynced) counts.unsyncedRows += 1;
    if (state.update) counts.updateRows += 1;
    if (state.problem) counts.problemRows += 1;
  }
  return counts;
}
