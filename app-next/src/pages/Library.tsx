// 技能 (Library) page — skills contract §6.3. One filter bar, one row of folder chips and a
// compact list: each row is the pack's entry (☐ · name · summary · N 个技能 · ★ · AI tool
// icons · ⋯). Long lists are windowed so only the rows on screen exist in the DOM.
// App owns all state and backend calls; never import from App.tsx here.
import { type CSSProperties, type PointerEvent as ReactPointerEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../icons";
import { getLang, t } from "../i18n";
import { localizedSkillDescription } from "../localizedDescriptions";
import { countSkills, rowFilterState, rowInFolder, type LibraryRow, type SkillCounts } from "../skillCounts";
import { orderTargetsForRow, targetIconView } from "../deliveryView";
import type { AgentId, LegacySnapshot, SkillAgent, SkillCard, SkillFolderCard, SkillTarget, TargetChange, TargetMutationResult } from "../types";
import { copyTextToClipboard, displayCategoryName, isRouterHubSkill, skillInvocationName, stableSkillClientId } from "../appShared";
import { Dialog, MoreMenu, StarRating, ToggleSwitch, useConfirm } from "../components/ui";
import { AgentGlyph } from "../components/shell";
import "./library.css";

export type LibraryFilter = "all" | "synced" | "unsynced" | "update" | "problem";
const FILTERS: LibraryFilter[] = ["all", "synced", "unsynced", "update", "problem"];
const FOLDER_COLORS = ["cyan", "violet", "magenta", "amber", "emerald", "blue", "coral", "slate"];
const ROW_HEIGHT = 64;
const CHILD_HEIGHT = 44;
const MORE_HEIGHT = 40;
const CHILD_PAGE = 40;
const MAX_ICONS = 6;
/** Below this many visible items everything renders; above it only the window around the viewport does. */
const WINDOW_THRESHOLD = 80;
const OVERSCAN_PX = 600;

type ListItem =
  | { type: "row"; key: string; row: LibraryRow }
  | { type: "child"; key: string; row: LibraryRow; skill: SkillCard }
  | { type: "more"; key: string; row: LibraryRow; hidden: number };

type DragState = { kind: "source" | "skill"; id: string; label: string; x: number; y: number; over: string | null };

export function Library({
  agents,
  busyAction,
  childBusy,
  counts,
  folderId,
  library,
  loading,
  metadataAnalyzing,
  mutationBusy,
  onAdd,
  onBatchTargets,
  onConsolidate,
  onCopySkill,
  onCreateFolder,
  onDeleteFolder,
  onMoveSkillToFolder,
  onMoveSourceToFolder,
  onOpenDetail,
  onOpenLibraryFolder,
  onReanalyze,
  onRepair,
  onSelectFolder,
  onSetChildEnabled,
  onSetSkillRating,
  onSetSourceRating,
  onTargetClick,
  onUpdateFolder,
  paused,
  rows
}: {
  agents: SkillAgent[];
  busyAction: string;
  childBusy: ReadonlySet<string>;
  counts: SkillCounts;
  folderId: string;
  library: LegacySnapshot | null;
  loading: boolean;
  metadataAnalyzing: boolean;
  mutationBusy: boolean;
  onAdd: () => void;
  onBatchTargets: (changes: TargetChange[]) => Promise<TargetMutationResult | null>;
  onConsolidate: () => void;
  onCopySkill: (skill: SkillCard) => void;
  onCreateFolder: (name: string, note: string, color: string) => Promise<LegacySnapshot | null>;
  onDeleteFolder: (folderId: string) => Promise<LegacySnapshot | null>;
  onMoveSkillToFolder: (skillId: string, folderId: string) => Promise<LegacySnapshot | null>;
  onMoveSourceToFolder: (sourceId: string, folderId: string) => Promise<LegacySnapshot | null>;
  onOpenDetail: (key: string, tab?: "overview" | "versions" | "settings") => void;
  onOpenLibraryFolder: () => void;
  onReanalyze: () => void;
  onRepair: () => void;
  onSelectFolder: (folderId: string) => void;
  onSetChildEnabled: (skill: SkillCard, enabled: boolean) => Promise<boolean>;
  onSetSkillRating: (skill: SkillCard, rating: number) => Promise<boolean>;
  onSetSourceRating: (source: NonNullable<LibraryRow["source"]>, rating: number) => Promise<boolean>;
  onTargetClick: (row: LibraryRow, target: SkillTarget) => void;
  onUpdateFolder: (folderId: string, name: string, note: string, color: string) => Promise<LegacySnapshot | null>;
  paused: boolean;
  rows: LibraryRow[];
}) {
  const [filter, setFilter] = useState<LibraryFilter>("all");
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [showAllChildren, setShowAllChildren] = useState<ReadonlySet<string>>(() => new Set());
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [folderDialog, setFolderDialog] = useState<{ mode: "create" } | { mode: "move"; row: LibraryRow } | { mode: "rename"; id: string } | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [confirmNode, askConfirm] = useConfirm();
  const folders = library?.skillFolders ?? [];
  const managedAgents = agents.filter(agent => agent.takeover && agent.canDeliver);
  const scope = folderId === "all" ? "all" : folderId;
  const folderCounts = useMemo(() => countSkills(library, { folderId: scope }), [library, scope]);

  const visibleRows = useMemo(() => rows.filter(row => {
    if (!rowInFolder(row, scope)) return false;
    if (filter === "all") return true;
    const state = rowFilterState(row);
    return state[filter];
  }), [rows, scope, filter]);

  // Selection covers only the current filter results.
  useEffect(() => {
    setSelected(current => {
      if (current.size === 0) return current;
      const visible = new Set(visibleRows.map(row => row.key));
      const next = new Set([...current].filter(key => visible.has(key)));
      return next.size === current.size ? current : next;
    });
  }, [visibleRows]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || document.querySelector("[data-overlay]")) return;
      if (drag) setDrag(null);
      else if (selected.size > 0) setSelected(new Set());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected.size, drag]);

  const items = useMemo<ListItem[]>(() => {
    const list: ListItem[] = [];
    for (const row of visibleRows) {
      list.push({ type: "row", key: row.key, row });
      if (!expanded.has(row.key) || row.kind !== "pack" || row.skills.length < 2) continue;
      const all = showAllChildren.has(row.key);
      const children = all ? row.skills : row.skills.slice(0, CHILD_PAGE);
      for (const skill of children) list.push({ type: "child", key: `${row.key}::${skill.folderName}`, row, skill });
      if (!all && row.skills.length > CHILD_PAGE) list.push({ type: "more", key: `${row.key}::more`, row, hidden: row.skills.length - CHILD_PAGE });
    }
    return list;
  }, [visibleRows, expanded, showAllChildren]);

  const listRef = useRef<HTMLDivElement | null>(null);
  const window_ = useWindow(items, listRef);

  function toggleSelected(row: LibraryRow, shift: boolean) {
    setSelected(current => {
      const next = new Set(current);
      if (shift && anchor) {
        const keys = visibleRows.map(item => item.key);
        const from = keys.indexOf(anchor);
        const to = keys.indexOf(row.key);
        if (from >= 0 && to >= 0) {
          const [start, end] = from < to ? [from, to] : [to, from];
          for (const key of keys.slice(start, end + 1)) next.add(key);
          return next;
        }
      }
      if (next.has(row.key)) next.delete(row.key);
      else next.add(row.key);
      return next;
    });
    setAnchor(row.key);
  }

  function toggleExpanded(key: string) {
    setExpanded(current => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  /* ---------- pointer drag: grip → folder chip (dragDropEnabled disables HTML5 drag on Windows) ---------- */

  function startDrag(event: ReactPointerEvent, kind: DragState["kind"], id: string, label: string) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startY = event.clientY;
    let started = false;
    const move = (moveEvent: PointerEvent) => {
      if (!started && Math.abs(moveEvent.clientX - startX) + Math.abs(moveEvent.clientY - startY) < 5) return;
      started = true;
      const target = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY) as HTMLElement | null;
      const over = target?.closest<HTMLElement>("[data-folder-drop]")?.dataset.folderDrop ?? null;
      setDrag({ kind, id, label, x: moveEvent.clientX, y: moveEvent.clientY, over });
    };
    const up = (upEvent: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      setDrag(null);
      if (!started) return;
      const target = document.elementFromPoint(upEvent.clientX, upEvent.clientY) as HTMLElement | null;
      const over = target?.closest<HTMLElement>("[data-folder-drop]")?.dataset.folderDrop;
      if (over === undefined || over === "all") return;
      const destination = over === "unfiled" ? "" : over;
      if (kind === "source") void onMoveSourceToFolder(id, destination);
      else void onMoveSkillToFolder(id, destination);
    };
    const cancel = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      setDrag(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
  }

  /* ---------- selection bar ---------- */

  const selectedRows = visibleRows.filter(row => selected.has(row.key) && row.unit && row.kind !== "prompt");

  function batchFor(agentId: AgentId, enable: boolean): TargetChange[] {
    const changes: TargetChange[] = [];
    for (const row of selectedRows) {
      const target = row.targets.find(item => item.agentId === agentId);
      if (enable) {
        if (!row.unit?.libraryEnabled) continue;
        if (target?.desired) continue;
      } else if (!target?.desired) continue;
      changes.push({ unitId: row.unit!.unitId, agentId, enabled: enable });
    }
    return changes;
  }

  const empty = !loading && rows.length === 0;
  const maintenanceBusy = metadataAnalyzing || busyAction === "consolidate";

  return (
    <div className="view library-view lib-v33" data-testid="library-page">
      <header className="lib-head">
        <div>
          <h2>{t("nav.library")}</h2>
          <span className="lib-count" data-count={counts.skills} data-testid="library-count">
            {t("v33.libraryCount", { skills: counts.skills, packs: counts.packs })}
          </span>
        </div>
        <div className="lib-head-actions">
          <button className="primary-action small" onClick={onAdd} type="button"><Icon name="add" /> {t("v33.add")}</button>
          <MoreMenu
            items={[
              { key: "reanalyze", label: metadataAnalyzing ? t("v33.reanalyzing") : t("v33.reanalyze"), onSelect: onReanalyze, disabled: mutationBusy || maintenanceBusy, icon: "sparkle" },
              { key: "repair", label: t("v33.repair"), onSelect: onRepair, icon: "refresh" },
              { key: "consolidate", label: busyAction === "consolidate" ? t("v33.consolidating") : t("v33.consolidate"), onSelect: onConsolidate, disabled: mutationBusy || maintenanceBusy, icon: "list" },
              { key: "folder", label: t("v33.libraryFolder"), onSelect: onOpenLibraryFolder, icon: "folder" }
            ]}
            label={t("v33.moreActions")}
            testId="library-more"
          />
        </div>
      </header>

      <div className="lib-filters" role="toolbar" aria-label={t("v33.filterLabel")}>
        {FILTERS.map(key => {
          const value = key === "all" ? folderCounts.rows
            : key === "synced" ? folderCounts.syncedRows
              : key === "unsynced" ? folderCounts.unsyncedRows
                : key === "update" ? folderCounts.updateRows
                  : folderCounts.problemRows;
          return (
            <button
              aria-pressed={filter === key}
              className={`lib-filter${filter === key ? " active" : ""}${key === "problem" && value > 0 ? " has-problem" : ""}`}
              data-count={value}
              data-testid={`library-filter-${key}`}
              key={key}
              onClick={() => setFilter(key)}
              type="button"
            >
              {t(`v33.filter.${key}`)} <em>{value}</em>
            </button>
          );
        })}
        {paused && <span className="lib-paused-note"><Icon name="pause" /> {t("v33.pausedNote")}</span>}
      </div>

      <div className="lib-folders" role="toolbar" aria-label={t("v33.foldersLabel")}>
        <FolderChip
          active={folderId === "all"}
          count={counts.skills}
          dropId="all"
          label={t("v33.folderAll")}
          onClick={() => onSelectFolder("all")}
          over={drag?.over === "all"}
          testId="folder-chip-all"
        />
        <FolderChip
          active={folderId === "unfiled"}
          count={countSkills(library, { folderId: "unfiled" }).skills}
          dropId="unfiled"
          label={t("v33.folderUnfiled")}
          onClick={() => onSelectFolder("unfiled")}
          over={drag?.over === "unfiled"}
          testId="folder-chip-unfiled"
        />
        {folders.map(folder => (
          <FolderChip
            active={folderId === folder.id}
            color={folder.color}
            count={countSkills(library, { folderId: folder.id }).skills}
            dropId={folder.id}
            key={folder.id}
            label={folder.name}
            menu={folderId === folder.id ? (
              <MoreMenu
                items={[
                  { key: "rename", label: t("v33.folderRename"), onSelect: () => setFolderDialog({ mode: "rename", id: folder.id }) },
                  {
                    key: "delete",
                    label: t("v33.folderDelete"),
                    danger: true,
                    onSelect: () => {
                      void askConfirm({
                        title: t("v33.folderDelete"),
                        body: t("v33.folderDeleteConfirm", { name: folder.name }),
                        confirmLabel: t("v33.folderDelete"),
                        danger: true,
                        testId: "folder-delete-dialog"
                      }).then(ok => {
                        if (!ok) return;
                        void onDeleteFolder(folder.id).then(result => {
                          if (result) onSelectFolder("all");
                        });
                      });
                    }
                  }
                ]}
                label={t("v33.folderMenu")}
              />
            ) : null}
            onClick={() => onSelectFolder(folder.id)}
            over={drag?.over === folder.id}
            testId={`folder-chip-${folder.id}`}
          />
        ))}
        <button className="folder-chip add" data-testid="folder-chip-new" onClick={() => setFolderDialog({ mode: "create" })} type="button">
          <Icon name="add" /> {t("v33.folderNew")}
        </button>
      </div>

      {selected.size > 0 && (
        <div className="lib-selection" data-testid="library-selection" role="toolbar">
          <strong>{t("v33.selected", { n: selected.size })}</strong>
          <BatchMenu
            agents={managedAgents}
            enable
            label={t("v33.syncTo")}
            onApply={changes => void onBatchTargets(changes).then(result => { if (result) setSelected(new Set()); })}
            plan={agentId => batchFor(agentId, true)}
            rows={selectedRows}
          />
          <BatchMenu
            agents={managedAgents}
            enable={false}
            label={t("v33.removeFrom")}
            onApply={changes => void onBatchTargets(changes).then(result => { if (result) setSelected(new Set()); })}
            plan={agentId => batchFor(agentId, false)}
            rows={selectedRows}
          />
          <button className="ghost-action small" onClick={() => setSelected(new Set())} type="button">{t("v33.clearSelection")}</button>
        </div>
      )}

      {empty ? (
        <section className="lib-empty" data-testid="library-empty">
          <Icon name="library" />
          <strong>{t("v33.emptyLibraryTitle")}</strong>
          <span>{t("v33.emptyLibraryBody")}</span>
          <button className="primary-action" onClick={onAdd} type="button"><Icon name="add" /> {t("v33.add")}</button>
        </section>
      ) : visibleRows.length === 0 ? (
        <section className="lib-empty compact">
          <strong>{loading ? t("v33.loadingLibrary") : t("v33.noMatch")}</strong>
          {!loading && (
            <button className="ghost-action small" onClick={() => { setFilter("all"); onSelectFolder("all"); }} type="button">{t("v33.showAll")}</button>
          )}
        </section>
      ) : (
        <div className="lib-list" ref={listRef} role="list" style={{ height: window_.total } as CSSProperties}>
          <div style={{ height: window_.offsetTop }} aria-hidden="true" />
          {items.slice(window_.start, window_.end).map(item => {
            if (item.type === "row") {
              return (
                <LibraryRowView
                  agents={agents}
                  expanded={expanded.has(item.row.key)}
                  key={item.key}
                  onCopy={onCopySkill}
                  onDragStart={startDrag}
                  onMove={() => setFolderDialog({ mode: "move", row: item.row })}
                  onOpen={tab => onOpenDetail(item.row.key, tab)}
                  onRate={rating => item.row.source
                    ? void onSetSourceRating(item.row.source, rating)
                    : item.row.skill ? void onSetSkillRating(item.row.skill, rating) : undefined}
                  onSelect={shift => toggleSelected(item.row, shift)}
                  onTargetClick={target => onTargetClick(item.row, target)}
                  onToggleExpanded={() => toggleExpanded(item.row.key)}
                  row={item.row}
                  selected={selected.has(item.row.key)}
                />
              );
            }
            if (item.type === "child") {
              return (
                <ChildRow
                  busy={childBusy.has(item.skill.folderName)}
                  key={item.key}
                  onCopy={() => onCopySkill(item.skill)}
                  onDragStart={event => startDrag(event, "skill", stableSkillClientId(item.skill), item.skill.name)}
                  onRate={rating => void onSetSkillRating(item.skill, rating)}
                  onToggle={() => void onSetChildEnabled(item.skill, !item.skill.enabled)}
                  libraryOff={item.row.unit ? !item.row.unit.libraryEnabled && item.row.unit.libraryOnlyReason !== "no-enabled-skills" : false}
                  skill={item.skill}
                />
              );
            }
            return (
              <div className="lib-more-row" key={item.key} role="listitem" style={{ height: MORE_HEIGHT }}>
                <button
                  className="ghost-action small"
                  onClick={() => setShowAllChildren(current => new Set(current).add(item.row.key))}
                  type="button"
                >
                  {t("v33.showAllChildren", { n: item.row.skills.length })}
                </button>
              </div>
            );
          })}
          <div style={{ height: window_.offsetBottom }} aria-hidden="true" />
        </div>
      )}

      {drag && (
        <div className="drag-ghost" style={{ left: drag.x + 14, top: drag.y + 10 } as CSSProperties} aria-hidden="true">
          <Icon name="folder" /> {drag.label}
        </div>
      )}

      {folderDialog && (
        <FolderDialog
          folders={folders}
          mode={folderDialog}
          onClose={() => setFolderDialog(null)}
          onCreate={(name, color) => onCreateFolder(name, "", color).then(result => {
            if (result) setFolderDialog(null);
          })}
          onMove={destination => {
            if (folderDialog.mode !== "move") return;
            const row = folderDialog.row;
            const action = row.source
              ? onMoveSourceToFolder(row.source.id, destination)
              : row.skill ? onMoveSkillToFolder(stableSkillClientId(row.skill), destination) : Promise.resolve(null);
            void action.then(() => setFolderDialog(null));
          }}
          onRename={(id, name, color) => {
            const folder = folders.find(item => item.id === id);
            void onUpdateFolder(id, name, folder?.note ?? "", color).then(result => {
              if (result) setFolderDialog(null);
            });
          }}
        />
      )}
      {confirmNode}
    </div>
  );
}

/* =============================================================
   Window over the flat list (rows + expanded children)
   ============================================================= */

function itemHeight(item: ListItem) {
  return item.type === "row" ? ROW_HEIGHT : item.type === "child" ? CHILD_HEIGHT : MORE_HEIGHT;
}

function useWindow(items: ListItem[], listRef: React.RefObject<HTMLDivElement | null>) {
  const offsets = useMemo(() => {
    const result = new Array<number>(items.length + 1);
    result[0] = 0;
    for (let index = 0; index < items.length; index += 1) result[index + 1] = result[index] + itemHeight(items[index]);
    return result;
  }, [items]);
  const total = offsets[items.length] ?? 0;
  const windowed = items.length > WINDOW_THRESHOLD;
  const [range, setRange] = useState({ start: 0, end: windowed ? Math.min(items.length, 30) : items.length });

  useLayoutEffect(() => {
    if (!windowed) {
      setRange({ start: 0, end: items.length });
      return;
    }
    let frame = 0;
    const update = () => {
      frame = 0;
      const host = listRef.current;
      if (!host) return;
      const top = host.getBoundingClientRect().top;
      const from = Math.max(0, -top - OVERSCAN_PX);
      const to = Math.max(0, -top + window.innerHeight + OVERSCAN_PX);
      const start = Math.max(0, upperBound(offsets, from) - 1);
      const end = Math.min(items.length, upperBound(offsets, to));
      setRange(current => (current.start === start && current.end === end ? current : { start, end }));
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [offsets, windowed, items.length, listRef]);

  const start = Math.min(range.start, items.length);
  const end = Math.min(Math.max(range.end, start), items.length);
  return { start, end, total, offsetTop: offsets[start] ?? 0, offsetBottom: total - (offsets[end] ?? total) };
}

function upperBound(offsets: number[], value: number) {
  let low = 0;
  let high = offsets.length - 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (offsets[mid] <= value) low = mid + 1;
    else high = mid;
  }
  return low;
}

/* =============================================================
   Rows
   ============================================================= */

function ownerOf(row: LibraryRow) {
  const url = row.source?.url ?? "";
  const match = url.match(/github\.com[/:]([^/]+)\//i);
  if (match) return match[1];
  if (row.kind === "standalone") return t("v33.standalone");
  return url ? "" : t("v33.local");
}

function stripRouterMarker(text: string) {
  return text.replace(/\[ROUTER-HUB\]/gi, "").replace(/\s+/g, " ").trim();
}

export function rowSummary(row: LibraryRow) {
  const lang = getLang();
  if (row.skill) return stripRouterMarker(localizedSkillDescription(row.skill, lang) || row.skill.description) || displayCategoryName(row.skill.category);
  if (row.source?.usageGuide) return row.source.usageGuide;
  // A generated parent entry only describes routing; an upstream umbrella SKILL.md is real content.
  const parent = row.ownedSkills.find(skill => isRouterHubSkill(skill) && row.ownedSkills.length > 1);
  const parentText = parent ? stripRouterMarker(localizedSkillDescription(parent, lang) || parent.description) : "";
  if (parentText && !/路由|router|入口集合|parent entry/i.test(parentText)) return parentText;
  const first = row.skills[0];
  const firstText = first ? stripRouterMarker(localizedSkillDescription(first, lang) || first.description) : "";
  return firstText || (row.source ? displayCategoryName(row.source.categoryId) : "");
}

export function rowName(row: LibraryRow) {
  return row.source?.name ?? row.skill?.name ?? row.key;
}

/** The skill whose invocation name the "复制调用名" action copies: the parent entry or the only skill. */
export function rowEntrySkill(row: LibraryRow): SkillCard | null {
  if (row.skill) return row.skill;
  if (row.skills.length === 1) return row.skills[0];
  return row.ownedSkills.find(skill => isRouterHubSkill(skill)) ?? null;
}

function avatarHue(name: string) {
  let hash = 0;
  for (let index = 0; index < name.length; index += 1) hash = (hash * 31 + name.charCodeAt(index)) | 0;
  return Math.abs(hash) % 360;
}

function LibraryRowView({
  agents,
  expanded,
  onCopy,
  onDragStart,
  onMove,
  onOpen,
  onRate,
  onSelect,
  onTargetClick,
  onToggleExpanded,
  row,
  selected
}: {
  agents: SkillAgent[];
  expanded: boolean;
  onCopy: (skill: SkillCard) => void;
  onDragStart: (event: ReactPointerEvent, kind: DragState["kind"], id: string, label: string) => void;
  onMove: () => void;
  onOpen: (tab?: "overview" | "versions" | "settings") => void;
  onRate: (rating: number) => void;
  onSelect: (shift: boolean) => void;
  onTargetClick: (target: SkillTarget) => void;
  onToggleExpanded: () => void;
  row: LibraryRow;
  selected: boolean;
}) {
  const name = rowName(row);
  const state = rowFilterState(row);
  const entry = rowEntrySkill(row);
  const targets = orderTargetsForRow(row.targets, agents);
  const shown = targets.slice(0, MAX_ICONS);
  const hidden = targets.length - shown.length;
  const rating = row.source?.rating ?? row.skill?.rating ?? 0;
  const expandable = row.kind === "pack" && row.skills.length > 1;
  const dragKind: DragState["kind"] = row.source ? "source" : "skill";
  const dragId = row.source ? row.source.id : row.skill ? stableSkillClientId(row.skill) : row.key;
  return (
    <div
      className={`lib-row kind-${row.kind}${selected ? " selected" : ""}${state.problem ? " has-problem" : ""}`}
      data-testid={`library-row-${row.key}`}
      role="listitem"
      style={{ height: ROW_HEIGHT }}
    >
      <span className="lib-grip" onPointerDown={event => onDragStart(event, dragKind, dragId, name)} title={t("v33.dragToFolder")} aria-hidden="true">
        <Icon name="grip" />
      </span>
      <input
        aria-label={t("v33.selectRow", { name })}
        checked={selected}
        className="lib-check"
        onChange={() => undefined}
        onClick={event => onSelect(event.shiftKey)}
        type="checkbox"
      />
      <button
        aria-expanded={expandable ? expanded : undefined}
        aria-label={expandable ? (expanded ? t("v33.collapse") : t("v33.expand")) : undefined}
        className={`lib-chevron${expanded ? " open" : ""}`}
        disabled={!expandable}
        onClick={onToggleExpanded}
        type="button"
      >
        {expandable && <Icon name="chevron" />}
      </button>
      <button className="lib-main" onClick={() => onOpen()} type="button">
        <span className="lib-avatar" style={{ "--avatar-hue": avatarHue(name) } as CSSProperties} aria-hidden="true">
          {name.replace(/[^\p{L}\p{N}]/gu, "").slice(0, 1).toUpperCase() || "?"}
        </span>
        <span className="lib-title">
          <strong>{name}</strong>
          <small>{ownerOf(row)}</small>
        </span>
        <span className="lib-summary">{rowSummary(row)}</span>
      </button>
      <span className="lib-badges">
        {row.kind === "prompt" ? (
          <span className="chip chip-prompt">{t("v33.promptChip")}</span>
        ) : row.kind === "empty" ? (
          <span className="chip chip-warn">{t("v33.noSkillsChip")}</span>
        ) : (
          <span className="chip">{t("v33.skillsInPack", { n: row.skills.length })}</span>
        )}
        {state.update && <span className="chip chip-update">{t("v33.updateChip")}</span>}
        {state.problem && <span className="chip chip-problem">{t("v33.problemChip")}</span>}
      </span>
      <StarRating compact label={t("v33.rating")} onChange={onRate} value={rating} />
      <span className="target-icons" aria-label={t("v33.syncedTo")}>
        {shown.map((target, index) => {
          const agent = agents.find(item => item.id === target.agentId);
          const view = targetIconView(target, row.unit?.libraryOnlyReason ?? "");
          const linkedNext = target.agentId === "codex" && shown[index + 1]?.agentId === "coze";
          const tip = t(view.tooltipKey, { tool: agent?.name ?? target.agentId, message: target.error?.message ?? "" });
          return (
            <span className="target-icon-wrap" key={target.agentId}>
              <button
                aria-label={tip}
                className={`target-icon look-${view.look}`}
                data-status={target.status}
                data-testid={`target-icon-${row.key}-${target.agentId}`}
                disabled={view.disabled}
                onClick={event => {
                  event.stopPropagation();
                  onTargetClick(target);
                }}
                title={tip}
                type="button"
              >
                <AgentGlyph agentId={target.agentId} name={agent?.name} size="sm" />
                {(view.look === "spin") && <i className="target-spin" aria-hidden="true" />}
                {view.look === "paused" && <i className="target-badge pause" aria-hidden="true"><Icon name="pause" /></i>}
                {view.look === "red" && <i className="target-badge red" aria-hidden="true" />}
                {view.look === "blocked" && <i className="target-badge ban" aria-hidden="true"><Icon name="ban" /></i>}
              </button>
              {linkedNext && <i className="target-link" title={t("v33.sharedFolder")} aria-hidden="true"><Icon name="link" /></i>}
            </span>
          );
        })}
        {hidden > 0 && (
          <button className="target-more" onClick={() => onOpen("overview")} title={t("v33.moreTools", { n: hidden })} type="button">+{hidden}</button>
        )}
      </span>
      <MoreMenu
        items={[
          { key: "open", label: t("v33.details"), onSelect: () => onOpen("overview"), icon: "info" },
          ...(entry ? [{ key: "copy", label: t("v33.copyInvocation"), onSelect: () => void copyTextToClipboard(skillInvocationName(entry), t("toast.skillNameCopied")), icon: "copy" as const }] : []),
          { key: "move", label: t("v33.moveToFolder"), onSelect: onMove, icon: "folder" },
          { key: "settings", label: t("v33.editSettings"), onSelect: () => onOpen("settings"), icon: "edit" }
        ]}
        label={t("v33.rowMenu", { name })}
        testId={`library-row-menu-${row.key}`}
      />
    </div>
  );
}

function ChildRow({
  busy,
  libraryOff,
  onCopy,
  onDragStart,
  onRate,
  onToggle,
  skill
}: {
  busy: boolean;
  libraryOff: boolean;
  onCopy: () => void;
  onDragStart: (event: ReactPointerEvent) => void;
  onRate: (rating: number) => void;
  onToggle: () => void;
  skill: SkillCard;
}) {
  const summary = stripRouterMarker(localizedSkillDescription(skill, getLang()) || skill.description) || displayCategoryName(skill.category);
  const tags = Array.from(new Set((skill.tags ?? []).map(tag => tag.trim()).filter(Boolean))).slice(0, 2);
  return (
    <div className={`lib-child${skill.enabled ? "" : " off"}`} data-testid={`library-child-${skill.folderName}`} role="listitem" style={{ height: CHILD_HEIGHT }}>
      <span className="lib-grip" onPointerDown={onDragStart} title={t("v33.dragToFolder")} aria-hidden="true"><Icon name="grip" /></span>
      <span className="lib-child-name">
        <strong>{skill.name}</strong>
        {skill.health === "error" && <span className="chip chip-problem">{t("v33.problemChip")}</span>}
      </span>
      <span className="lib-child-summary">{summary}{tags.length > 0 && <em>{tags.join(" · ")}</em>}</span>
      <span className="lib-child-stars"><StarRating compact label={t("v33.rating")} onChange={onRate} value={skill.rating} /></span>
      <button className="icon-action" onClick={() => void copyTextToClipboard(skillInvocationName(skill), t("toast.skillNameCopied"))} title={t("v33.copyInvocation")} aria-label={t("v33.copyInvocationOf", { name: skillInvocationName(skill) })} type="button">
        <Icon name="copy" />
      </button>
      <ToggleSwitch
        busy={busy}
        disabled={busy || libraryOff}
        enabled={skill.enabled}
        label={skill.enabled ? t("v33.childOn", { name: skill.name }) : t("v33.childOff", { name: skill.name })}
        onClick={onToggle}
        showLabel={false}
        testId={`child-switch-${skill.folderName}`}
      />
    </div>
  );
}

function FolderChip({
  active,
  color,
  count,
  dropId,
  label,
  menu,
  onClick,
  over,
  testId
}: {
  active: boolean;
  color?: string;
  count: number;
  dropId: string;
  label: string;
  menu?: React.ReactNode;
  onClick: () => void;
  over: boolean;
  testId: string;
}) {
  return (
    <span className={`folder-chip-wrap${active ? " active" : ""}${over ? " drop-over" : ""}`} data-folder-drop={dropId}>
      <button aria-pressed={active} className="folder-chip" data-count={count} data-testid={testId} onClick={onClick} type="button">
        {color && <i className={`folder-dot color-${color}`} aria-hidden="true" />}
        <span>{label}</span>
        <em>{count}</em>
      </button>
      {menu}
    </span>
  );
}

function BatchMenu({
  agents,
  enable,
  label,
  onApply,
  plan,
  rows
}: {
  agents: SkillAgent[];
  enable: boolean;
  label: string;
  onApply: (changes: TargetChange[]) => void;
  plan: (agentId: AgentId) => TargetChange[];
  rows: LibraryRow[];
}) {
  const [open, setOpen] = useState(false);
  const host = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!host.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);
  return (
    <div className={`batch-menu${open ? " open" : ""}`} ref={host}>
      <button aria-expanded={open} className="ghost-action small" data-testid={enable ? "batch-sync-to" : "batch-remove-from"} onClick={() => setOpen(value => !value)} type="button">
        {label} <Icon name="chevron" className="rotate-90" />
      </button>
      {open && (
        <div className="more-list" role="menu">
          {agents.length === 0 && <span className="more-empty">{t("v33.noManagedTools")}</span>}
          {agents.map(agent => {
            const changes = plan(agent.id);
            const synced = rows.filter(row => row.targets.some(target => target.agentId === agent.id && target.desired)).length;
            return (
              <button
                disabled={changes.length === 0}
                key={agent.id}
                onClick={() => {
                  setOpen(false);
                  onApply(changes);
                }}
                role="menuitem"
                type="button"
              >
                <AgentGlyph agentId={agent.id} name={agent.name} size="sm" />
                <span>{agent.name}</span>
                <small>{t("v33.batchCoverage", { x: synced, n: rows.length })}</small>
                <b>{changes.length > 0 ? t(enable ? "v33.batchSyncN" : "v33.batchRemoveN", { n: changes.length }) : t("v33.batchNothing")}</b>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function FolderDialog({
  folders,
  mode,
  onClose,
  onCreate,
  onMove,
  onRename
}: {
  folders: SkillFolderCard[];
  mode: { mode: "create" } | { mode: "move"; row: LibraryRow } | { mode: "rename"; id: string };
  onClose: () => void;
  onCreate: (name: string, color: string) => Promise<void>;
  onMove: (folderId: string) => void;
  onRename: (id: string, name: string, color: string) => void;
}) {
  const existing = mode.mode === "rename" ? folders.find(folder => folder.id === mode.id) : null;
  const [name, setName] = useState(existing?.name ?? "");
  const [color, setColor] = useState(existing?.color ?? FOLDER_COLORS[folders.length % FOLDER_COLORS.length]);
  if (mode.mode === "move") {
    const current = mode.row.folderId;
    return (
      <Dialog onClose={onClose} title={t("v33.moveToFolderOf", { name: rowName(mode.row) })} testId="move-folder-dialog">
        <div className="folder-pick-list">
          <button className={current === "" ? "active" : ""} data-autofocus="" onClick={() => onMove("")} type="button">{t("v33.folderUnfiled")}</button>
          {folders.map(folder => (
            <button className={current === folder.id ? "active" : ""} key={folder.id} onClick={() => onMove(folder.id)} type="button">
              <i className={`folder-dot color-${folder.color}`} aria-hidden="true" /> {folder.name}
            </button>
          ))}
        </div>
      </Dialog>
    );
  }
  const valid = name.trim().length > 0 && name.trim().length <= 48;
  return (
    <Dialog
      footer={
        <>
          <button className="secondary-action" onClick={onClose} type="button">{t("common.cancel")}</button>
          <button
            className="primary-action"
            disabled={!valid}
            onClick={() => (mode.mode === "create" ? void onCreate(name.trim(), color) : onRename(mode.id, name.trim(), color))}
            type="button"
          >
            {mode.mode === "create" ? t("v33.folderCreate") : t("common.save")}
          </button>
        </>
      }
      onClose={onClose}
      testId="folder-dialog"
      title={mode.mode === "create" ? t("v33.folderNew") : t("v33.folderRename")}
    >
      <label className="field">
        <span>{t("v33.folderName")}</span>
        <input data-autofocus="" maxLength={48} onChange={event => setName(event.target.value)} value={name} />
      </label>
      <div className="folder-colors" role="radiogroup" aria-label={t("v33.folderColor")}>
        {FOLDER_COLORS.map(value => (
          <button aria-checked={color === value} className={`folder-dot color-${value}${color === value ? " active" : ""}`} key={value} onClick={() => setColor(value)} role="radio" title={value} type="button" />
        ))}
      </div>
    </Dialog>
  );
}

