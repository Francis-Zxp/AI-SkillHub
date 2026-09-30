import { useEffect, useMemo, useRef, useState } from "react";
import { getLang } from "./i18n";
import { buildSkyIslands } from "./skyIslandModel";
import type { SkyScene } from "./skyIslandScene";
import type { SkillUniverseProps } from "./SkillUniverse";
import "./SkillArchipelago.css";

export type SkillArchipelagoProps = SkillUniverseProps & { onOpenFolder?: (folderId: string) => void };
const copy = {
  zh: { title: "我的天空岛", guide: "每座岛，都是你的一类收藏。", unfiled: "未归档", search: "寻找分类", reset: "回到全景", pause: "暂停动画", play: "播放动画", loading: "正在准备天空岛…", fallback: "当前使用简洁分类视图", empty: "从一个分类开始", emptyHint: "在技能库创建分类，你的天空岛便会出现在这里。", open: "打开分类", prompts: "Prompt 来源", folders: "个分类", hint: "拖动探索 · 滚轮缩放 · 点击进入分类", scale: "岛屿面积随 Skills 与 Prompt 来源总数增加", noMatch: "没有匹配的分类", browse: "分类导航", collapse: "收起导航", focus: "在地图中定位", retry: "重新加载场景" },
  en: { title: "My sky islands", guide: "A little world for every collection.", unfiled: "Unfiled", search: "Find a category", reset: "Show all", pause: "Pause motion", play: "Play motion", loading: "Preparing your islands…", fallback: "Using the category view", empty: "Start with a category", emptyHint: "Create a category in your library to see it here.", open: "Open category", prompts: "Prompt sources", folders: "categories", hint: "Drag to explore · Scroll to zoom · Click to open", scale: "Island area grows with Skills and Prompt sources", noMatch: "No matching categories", browse: "Categories", collapse: "Close navigation", focus: "Locate on map", retry: "Reload scene" },
  ko: { title: "나의 하늘섬", guide: "분류마다 하나의 작은 세계.", unfiled: "미분류", search: "분류 찾기", reset: "전체 보기", pause: "애니메이션 정지", play: "애니메이션 재생", loading: "하늘섬을 준비하는 중…", fallback: "분류 보기 사용 중", empty: "분류부터 시작하세요", emptyHint: "라이브러리에서 분류를 만들면 여기에 표시됩니다.", open: "분류 열기", prompts: "Prompt 소스", folders: "개 분류", hint: "드래그 탐색 · 스크롤 확대 · 클릭 열기", scale: "Skills와 Prompt 소스 수에 따라 섬 면적이 커집니다", noMatch: "일치하는 분류가 없습니다", browse: "분류 탐색", collapse: "탐색 닫기", focus: "지도에서 찾기", retry: "장면 다시 로드" }
};

export function SkillArchipelago({ lightTheme, snapshot, onOpenFolder }: SkillArchipelagoProps) {
  const words = copy[getLang()];
  const islands = useMemo(() => buildSkyIslands(snapshot, words.unfiled), [snapshot, words.unfiled]);
  // Unrelated sync progress must not rebuild the GPU scene or reset its camera.
  const modelKey = JSON.stringify(islands);
  const stableIslands = useMemo(() => islands, [modelKey]);
  const host = useRef<HTMLDivElement>(null), scene = useRef<SkyScene | null>(null);
  const labels = useRef(new Map<string, HTMLButtonElement>());
  const openRef = useRef(onOpenFolder); openRef.current = onOpenFolder;
  const [status, setStatus] = useState<"loading" | "ready" | "fallback">("loading");
  const [paused, setPaused] = useState(() => localStorage.getItem("skillhub-sky-paused") === "1" || window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const [query, setQuery] = useState(""), [navigation, setNavigation] = useState(false), [retry, setRetry] = useState(0);
  const [hovered, setHovered] = useState<string | null>(null);
  const visibleIslands = islands.filter(island => island.name.toLocaleLowerCase().includes(query.toLocaleLowerCase().trim()));
  const currentPaused = useRef(paused); currentPaused.current = paused;
  useEffect(() => {
    if (!host.current || !stableIslands.length) return;
    let cancelled = false; setStatus("loading");
    import("./skyIslandScene").then(({ createSkyScene }) => {
      if (cancelled || !host.current) return;
      try {
        scene.current = createSkyScene({ host: host.current, islands: stableIslands, labels: labels.current, dark: !lightTheme, paused: currentPaused.current,
          onOpen: id => openRef.current?.(id), onHover: setHovered, onFailure: () => { scene.current?.dispose(); scene.current = null; setStatus("fallback"); } });
        setStatus("ready");
      } catch { setStatus("fallback"); }
    }).catch(() => { if (!cancelled) setStatus("fallback"); });
    return () => { cancelled = true; scene.current?.dispose(); scene.current = null; };
  }, [stableIslands, lightTheme, retry]);
  useEffect(() => { scene.current?.setPaused(paused); localStorage.setItem("skillhub-sky-paused", paused ? "1" : "0"); }, [paused]);
  const open = (id: string) => openRef.current?.(id);
  return <section className={`skill-archipelago sky-islands${lightTheme ? " is-light" : ""}${status === "fallback" ? " is-fallback" : ""}`} aria-label={words.title} data-status={status}>
    <div className="sky-horizon" aria-hidden="true" />
    <header className="sky-heading"><h2>{words.title}</h2><p>{words.guide}</p></header>
    <div className="sky-controls">
      <button type="button" onClick={() => { scene.current?.reset(); setQuery(""); }} title={words.reset} aria-label={words.reset}><span aria-hidden="true">⌖</span><span>{words.reset}</span></button>
      <button type="button" aria-pressed={paused} onClick={() => setPaused(value => !value)} title={paused ? words.play : words.pause}><span aria-hidden="true">{paused ? "▷" : "Ⅱ"}</span><span>{paused ? words.play : words.pause}</span></button>
      <button type="button" aria-expanded={navigation} onClick={() => setNavigation(value => !value)}>{navigation ? words.collapse : words.browse}<span aria-hidden="true">{navigation ? "−" : "+"}</span></button>
    </div>
    <div className="sky-scene-host" ref={host}>
      {status === "ready" && <div className="sky-map-labels">{islands.map(island => <button key={island.id} ref={element => { if (element) labels.current.set(island.id, element); else labels.current.delete(island.id); }}
        type="button" className={`sky-island-label${hovered === island.id ? " is-hovered" : ""}`} onClick={() => open(island.id)} onFocus={() => scene.current?.focus(island.id)}
        aria-label={`${words.open} ${island.name} · ${island.skillCount} Skills${island.promptCount ? ` · ${island.promptCount} ${words.prompts}` : ""}`}>
        <strong>{island.name}</strong><span><b>{island.skillCount.toLocaleString()}</b> Skills{island.promptCount > 0 && <> · <b>{island.promptCount}</b> {words.prompts}</>}</span>
      </button>)}</div>}
    </div>
    {(navigation || status === "fallback") && <aside className="sky-navigation" aria-label={words.browse}>
      <label className="sky-search"><span aria-hidden="true">⌕</span><input value={query} onChange={event => setQuery(event.target.value)} placeholder={words.search} aria-label={words.search} /></label>
      <div className="sky-navigation-list">{visibleIslands.map(island => <div className="sky-navigation-row" key={island.id}>
        <button type="button" onClick={() => open(island.id)}><strong>{island.name}</strong><span>{island.skillCount.toLocaleString()} Skills{island.promptCount > 0 ? ` · ${island.promptCount} ${words.prompts}` : ""}</span></button>
        {status !== "fallback" && <button type="button" className="sky-locate" title={words.focus} aria-label={`${words.focus} ${island.name}`} onClick={() => { scene.current?.focus(island.id); setHovered(island.id); }}>⌖</button>}
      </div>)}{!visibleIslands.length && <p>{words.noMatch}</p>}</div>
      {status === "fallback" && <div className="sky-fallback-note"><span>{words.fallback}</span><button type="button" onClick={() => setRetry(value => value + 1)}>{words.retry}</button></div>}
    </aside>}
    {!snapshot ? <div className="sky-empty" role="status">{words.loading}</div> : !islands.length ? <div className="sky-empty"><h3>{words.empty}</h3><p>{words.emptyHint}</p><button type="button" onClick={() => open("all")}>{words.browse} →</button></div> : status === "loading" ? <div className="sky-loading" role="status">{words.loading}</div> : null}
    <footer className="sky-caption"><span>{islands.length} {words.folders}</span><span title={words.scale}>{words.hint}</span></footer>
  </section>;
}
