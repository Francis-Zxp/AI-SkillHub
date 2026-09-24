import { type CSSProperties, useId, useMemo, useState } from "react";
import { getLang } from "./i18n";
import { sourcePresentation } from "./sourceIdentity";
import type { SkillUniverseProps } from "./SkillUniverse";
import type { SkillCard, SourceCard } from "./types";
import "./SkillArchipelago.css";

type Island = {
  id: string;
  name: string;
  owner?: string;
  count: number;
  enabled: boolean;
  hue: number;
  source?: SourceCard;
  skill?: SkillCard;
  folderId?: string;
};

export type SkillArchipelagoProps = SkillUniverseProps & {
  onOpenFolder?: (folderId: string) => void;
};

const copy = {
  zh: { sources: "来源群岛", folders: "我的文件夹", title: "技能群岛", guide: "选择岛屿，查看并管理其中的 Skills。", scale: "岛屿大小按 Skills 数量分档：0–9 / 10–49 / 50+", loading: "正在读取你的能力地图…", empty: "还没有岛屿", emptyHint: "添加来源或创建文件夹后，它们会出现在这里。", previous: "上一组", next: "下一组", page: "组", paused: "已停用", prompt: "Prompt 来源", unfiled: "未归档", local: "独立 Skill", open: "打开", legend: "数量不包含父路由入口", islands: "座岛" },
  en: { sources: "Source islands", folders: "My folders", title: "Skill islands", guide: "Choose an island to explore and manage its Skills.", scale: "Island sizes by Skill count: 0–9 / 10–49 / 50+", loading: "Loading your capability map…", empty: "No islands yet", emptyHint: "Add a source or create a folder to see it here.", previous: "Previous", next: "Next", page: "page", paused: "Disabled", prompt: "Prompt source", unfiled: "Unfiled", local: "Local Skill", open: "Open", legend: "Counts exclude parent routers", islands: "islands" },
  ko: { sources: "소스 섬", folders: "내 폴더", title: "Skill 섬", guide: "섬을 선택하여 Skills를 살펴보고 관리하세요.", scale: "Skill 수에 따른 섬 크기: 0–9 / 10–49 / 50+", loading: "역량 지도를 불러오는 중…", empty: "아직 섬이 없습니다", emptyHint: "소스를 추가하거나 폴더를 만들면 여기에 표시됩니다.", previous: "이전", next: "다음", page: "페이지", paused: "비활성", prompt: "Prompt 소스", unfiled: "미분류", local: "로컬 Skill", open: "열기", legend: "상위 라우터를 제외한 수", islands: "개 섬" }
};

const normalize = (value: string) => value.trim().toLowerCase();
const isRouter = (skill: SkillCard) => skill.isRouterHub ?? (skill.description.includes("[ROUTER-HUB]") || skill.relativePath.includes("AI-SkillHub-local-routers"));
const hueFor = (id: string) => [164, 174, 211, 224][[...id].reduce((value, char) => (value * 31 + char.charCodeAt(0)) >>> 0, 7) % 4];

export function SkillArchipelago({ centered, lightTheme, snapshot, onOpenSource, onOpenSkill, onOpenFolder }: SkillArchipelagoProps) {
  const words = copy[getLang()];
  const [grouping, setGrouping] = useState<"sources" | "folders">("sources");
  const [page, setPage] = useState(0);
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  const islands = useMemo(() => {
    if (!snapshot) return [];
    const children = snapshot.skills.filter(skill => !isRouter(skill));
    const sources = snapshot.sources;
    const sourceById = new Map(sources.map(source => [source.id, source]));
    const sourceByName = new Map(sources.flatMap(source => [source.name, source.id].map(name => [normalize(name), source] as const)));
    const owner = (skill: SkillCard) => skill.sourceId
      ? sourceById.get(skill.sourceId)
      : sourceByName.get(normalize(skill.source));
    const folderFor = (skill: SkillCard) => skill.userFolderId || owner(skill)?.userFolderId || "";
    if (grouping === "folders" && selectedFolder === null) {
      const items: Island[] = (snapshot.skillFolders ?? []).map(folder => ({
        id: `folder:${folder.id}`, folderId: folder.id, name: folder.name,
        count: children.filter(skill => folderFor(skill) === folder.id).length,
        enabled: true, hue: hueFor(folder.id)
      }));
      const unfiled = children.filter(skill => !folderFor(skill));
      if (unfiled.length) items.push({ id: "folder:unfiled", folderId: "", name: words.unfiled, count: unfiled.length, enabled: true, hue: 208 });
      return items;
    }
    const items: Island[] = sources.filter(source => selectedFolder === null || (source.userFolderId || "") === selectedFolder || children.some(skill => owner(skill)?.id === source.id && folderFor(skill) === selectedFolder)).map(source => {
      const matched = children.filter(skill => owner(skill)?.id === source.id && (selectedFolder === null || folderFor(skill) === selectedFolder));
      const presentation = sourcePresentation(source);
      return { id: source.id, name: presentation.title, owner: presentation.owner, count: matched.length, source,
        enabled: source.enabled, hue: hueFor(source.id) };
    });
    for (const skill of children.filter(skill => !owner(skill) && (selectedFolder === null || folderFor(skill) === selectedFolder))) {
      items.push({ id: `skill:${skill.id || skill.relativePath}`, name: skill.name, count: 1, skill, enabled: skill.enabled, hue: hueFor(skill.name) });
    }
    return items;
  }, [snapshot, grouping, selectedFolder, words.unfiled]);
  const pageSize = centered ? 8 : 6;
  const pages = Math.max(1, Math.ceil(islands.length / pageSize));
  const currentPage = Math.min(page, pages - 1);
  const visible = islands.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
  const chooseGrouping = (next: "sources" | "folders") => { setGrouping(next); setSelectedFolder(null); setPage(0); };
  const open = (island: Island) => {
    if (island.source) onOpenSource(island.source);
    else if (island.skill) onOpenSkill(island.skill);
    else if (island.folderId !== undefined) {
      if (onOpenFolder) onOpenFolder(island.folderId);
      else { setSelectedFolder(island.folderId); setPage(0); }
    }
  };

  return <section className={`skill-archipelago${centered ? " is-centered" : ""}${lightTheme ? " is-light" : ""}`} aria-label={words.title}>
    <div className="archipelago-sky" aria-hidden="true"><span /><span /><span /></div>
    <header className="archipelago-header">
      <div className="archipelago-switch" role="group" aria-label={words.title}>
        <button type="button" aria-pressed={grouping === "sources"} onClick={() => chooseGrouping("sources")}>{words.sources}</button>
        <button type="button" aria-pressed={grouping === "folders"} onClick={() => chooseGrouping("folders")}>{words.folders}</button>
      </div>
      <span className="archipelago-total">{islands.length} {words.islands}</span>
    </header>
    {selectedFolder !== null && <button type="button" className="archipelago-back" onClick={() => { setSelectedFolder(null); setPage(0); }}>← {words.folders}</button>}
    {!snapshot ? <p className="archipelago-empty" role="status">{words.loading}</p>
      : !islands.length ? <div className="archipelago-empty"><strong>{words.empty}</strong><p>{words.emptyHint}</p></div>
      : <div className="archipelago-islands" aria-label={words.guide}>
        {visible.map((island, index) => <button key={island.id} type="button" className={`archipelago-island${island.enabled ? "" : " is-paused"}`} onClick={() => open(island)}
          style={{ "--island-hue": island.hue, "--island-delay": `${index * -.63}s` } as CSSProperties}
          aria-label={`${words.open} ${island.name} · ${island.count} Skills${island.enabled ? "" : ` · ${words.paused}`}`}>
          <IslandArtwork count={island.count} index={index} folder={island.folderId !== undefined} />
          <span className="archipelago-island-label"><strong title={island.name}>{island.name}</strong>
            {island.owner && <small title={island.owner}>{island.owner}</small>}
            <span><b>{island.count}</b> Skills {island.source?.sourceType === "prompt" && <em> · {words.prompt}</em>}{!island.enabled && <em> · {words.paused}</em>}</span>
          </span>
        </button>)}
      </div>}
    <footer className="archipelago-footer">
      <div><span>{words.scale}</span><small>{words.legend}</small></div>
      {pages > 1 && <nav className="archipelago-pagination" aria-label={words.page}>
        <button type="button" disabled={currentPage === 0} aria-label={words.previous} onClick={() => setPage(currentPage - 1)}>←</button>
        <span aria-live="polite">{currentPage + 1} / {pages}</span>
        <button type="button" disabled={currentPage === pages - 1} aria-label={words.next} onClick={() => setPage(currentPage + 1)}>→</button>
      </nav>}
    </footer>
  </section>;
}

function IslandArtwork({ count, index, folder }: { count: number; index: number; folder: boolean }) {
  const id = useId().replace(/:/g, "");
  const scale = count >= 50 ? 1.12 : count >= 10 ? .94 : .76;
  return <svg className="archipelago-art" viewBox="0 0 240 180" aria-hidden="true" focusable="false">
    <defs>
      <linearGradient id={`${id}-cliff`} x1="0" x2=".8" y2="1"><stop stopColor="hsl(var(--island-hue), 23%, 38%)" /><stop offset="1" stopColor="hsl(var(--island-hue), 32%, 16%)" /></linearGradient>
      <linearGradient id={`${id}-grass`} x1="0" x2="1" y2="1"><stop stopColor="hsl(var(--island-hue), 44%, 79%)" /><stop offset="1" stopColor="hsl(var(--island-hue), 42%, 43%)" /></linearGradient>
      <linearGradient id={`${id}-water`} x1="0" x2="1"><stop stopColor="#cdf5fa" stopOpacity=".9" /><stop offset="1" stopColor="#b7eafa" stopOpacity="0" /></linearGradient>
    </defs>
    <g className="archipelago-float">
      <g transform={`translate(120 88) scale(${scale}) translate(-120 -88)`}>
        <path d="M33 84 59 67 113 57 176 65 207 85 195 111 169 125 145 157 122 142 97 150 78 120 52 110Z" fill={`url(#${id}-cliff)`} />
        <path d="m59 86 19 34 19 30 5-49m39-1 4 57 24-32 9-36m17-4v26l12-26" fill="none" stroke="hsl(var(--island-hue), 28%, 58%)" strokeOpacity=".42" strokeWidth="1.4" />
        <path d="m33 84 26-17 54-10 63 8 31 20-36 22-49 7-51-12Z" fill={`url(#${id}-grass)`} />
        <path d="m34 84 38 18 51 12 48-7 36-22" fill="none" stroke="hsl(var(--island-hue), 53%, 82%)" strokeWidth="2" />
        <path d="m114 73 9 9-18 13-3 23-5 32-3 17" fill="none" stroke={`url(#${id}-water)`} strokeWidth="8" />
        <path d="m120 77 7 5-18 14-5 22" fill="none" stroke="#edfaff" strokeOpacity=".75" strokeWidth="1.5" />
        <ellipse cx="139" cy="75" rx="31" ry="11" fill="hsl(var(--island-hue), 28%, 24%)" opacity=".16" />
        {folder ? <g transform="translate(139 54)"><path d="m-23-7 20-5 9 6 17-3v33l-46 10Z" fill="#f3d5a0" stroke="#c8a273" /><path d="m-23 3 46-9-7 34-39 6Z" fill="#ffe9bb" /><path d="m-17 10 29-6" stroke="#caa872" strokeWidth="2" /></g>
          : <g transform="translate(139 48)"><path d="m-16-12 19-6 17 9v33l-20 7-16-8Z" fill="#e8ecea" /><path d="m3-18 17 9v33L0 31V-9Z" fill="#bbcdd0" /><path d="m-21-11 23-13 24 15-25 8Z" fill="hsl(var(--island-hue), 41%, 38%)" /><path d="m-12-2 7-2v9l-7 2m17-7 7 3v8l-7-2" fill="#fff6c8" /><path d="M-4 29V15l7-1v16" fill="#617f81" /><path d="M2-24V-41" stroke="#819d9e" strokeWidth="1.5" /><path d="m3-41 14 4-14 5" fill="#edbd85" /></g>}
        <g transform="translate(73 68)"><path d="M0 16V-10" stroke="#617566" strokeWidth="3" /><path d="m0-22-13 25H13Z" fill="hsl(var(--island-hue), 29%, 32%)" /><path d="m0-31-10 24h20Z" fill="hsl(var(--island-hue), 32%, 47%)" /></g>
        <g transform={`translate(${index % 2 ? 181 : 59} 88) scale(.6)`}><path d="M0 14V-15" stroke="#678479" strokeWidth="3" /><path d="m0-32-13 31H13Z" fill="hsl(var(--island-hue), 31%, 41%)" /></g>
        <path d="m51 90 6-3 7 4-6 3Zm119 8 7-4 9 4-6 5Z" fill="#edf4d9" opacity=".85" />
        <path d="m85 137 5 8-5 6-4-8Zm77 22 3 5-5 6-3-6Z" fill="hsl(var(--island-hue), 30%, 48%)" opacity=".75" />
      </g>
    </g>
  </svg>;
}
