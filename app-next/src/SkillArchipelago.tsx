import { useEffect, useMemo, useRef, useState } from "react";
import { getLang } from "./i18n";
import { buildSkyIslands } from "./skyIslandModel";
import type { SkyWorld } from "./sky/world";
import type { SkillUniverseProps } from "./SkillUniverse";
import { SKY_SCENE_EVENT as SCENE_EVENT, probeGraphics, readSetting, setSkySceneEnabled, skySceneEnabled, writeSetting } from "./skyScene";
import "./SkillArchipelago.css";

export type SkyPhase = "dawn" | "noon" | "golden" | "night";
export type SkillArchipelagoProps = SkillUniverseProps & { onOpenFolder?: (folderId: string) => void; phase?: SkyPhase };
const copy = {
  zh: { title: "天空岛", summary: (folders: number, skills: number) => `${folders} 个分类 · ${skills.toLocaleString()} 个 Skills`, basis: "岛屿面积按 Skills 数 + Prompt 来源数计算", unfiled: "未归档", search: "寻找分类", reset: "回到全景", pause: "暂停动画", play: "播放动画", lowPower: "省电模式", lowPowerHint: "降低分辨率与阴影，减少动画帧率", loading: "正在准备天空岛…", fallback: "当前设备无法显示 3D 场景，已切换为分类列表", empty: "从一个分类开始", emptyHint: "在技能库创建分类，你的天空岛便会出现在这里。", open: "打开分类", prompts: "Prompt 来源", noMatch: "没有匹配的分类", browse: "分类导航", collapse: "收起导航", focus: "在地图中定位", retry: "重新加载场景", hint: "拖动平移 · 滚轮缩放 · 点击岛屿打开分类", credits: "素材与许可", sceneOn: "3D 天空岛", sceneOff: "简洁分类", sceneHint: "简洁分类以卡片显示分类，不占用显卡；可随时在这里或设置中切换。", creditsTitle: "天空岛素材", creditsOriginal: "岛屿地形、云海、水面、布局与动画为 AI SkillHub 原创。", close: "关闭" },
  en: { title: "Sky islands", summary: (folders: number, skills: number) => `${folders} categories · ${skills.toLocaleString()} Skills`, basis: "Island area = Skills + Prompt sources", unfiled: "Unfiled", search: "Find a category", reset: "Show all", pause: "Pause motion", play: "Play motion", lowPower: "Low power", lowPowerHint: "Lower resolution, no shadows, fewer frames", loading: "Preparing your islands…", fallback: "3D is unavailable on this device; showing the category list", empty: "Start with a category", emptyHint: "Create a category in your library to see it here.", open: "Open category", prompts: "Prompt sources", noMatch: "No matching categories", browse: "Categories", collapse: "Close navigation", focus: "Locate on map", retry: "Reload scene", hint: "Drag to pan · Scroll to zoom · Click an island to open", credits: "Assets & licences", sceneOn: "3D islands", sceneOff: "Simple view", sceneHint: "Simple view shows category cards and uses no GPU. Switch back here or in Settings.", creditsTitle: "Sky island assets", creditsOriginal: "Island terrain, clouds, water, layout and animation are original to AI SkillHub.", close: "Close" },
  ko: { title: "하늘섬", summary: (folders: number, skills: number) => `분류 ${folders}개 · Skills ${skills.toLocaleString()}개`, basis: "섬 면적 = Skills 수 + Prompt 소스 수", unfiled: "미분류", search: "분류 찾기", reset: "전체 보기", pause: "애니메이션 정지", play: "애니메이션 재생", lowPower: "저전력", lowPowerHint: "해상도와 그림자를 낮추고 프레임을 줄입니다", loading: "하늘섬을 준비하는 중…", fallback: "이 기기에서는 3D를 표시할 수 없어 분류 목록을 보여 줍니다", empty: "분류부터 시작하세요", emptyHint: "라이브러리에서 분류를 만들면 여기에 표시됩니다.", open: "분류 열기", prompts: "Prompt 소스", noMatch: "일치하는 분류가 없습니다", browse: "분류 탐색", collapse: "탐색 닫기", focus: "지도에서 찾기", retry: "장면 다시 로드", hint: "드래그 이동 · 스크롤 확대 · 섬을 클릭해 열기", credits: "에셋과 라이선스", sceneOn: "3D 하늘섬", sceneOff: "간단히 보기", sceneHint: "간단히 보기는 분류 카드를 보여 주며 GPU를 쓰지 않습니다. 여기나 설정에서 다시 켤 수 있습니다.", creditsTitle: "하늘섬 에셋", creditsOriginal: "섬 지형, 구름, 물, 배치와 애니메이션은 AI SkillHub 자체 제작입니다.", close: "닫기" }
};


/** Bundled third-party assets (see public/sky/ATTRIBUTION.txt). */
const ASSET_CREDITS = [
  { work: "Medieval Village MegaKit · Fantasy Props MegaKit", author: "Quaternius", licence: "CC0 1.0" },
  { work: "Ultimate Modular Women (animated) · Farm Animals Pack", author: "Quaternius", licence: "CC0 1.0" },
  { work: "Flying gull (via Poly Pizza, modified)", author: "Poly by Google", licence: "CC-BY 3.0" }
];

export function SkillArchipelago({ lightTheme, snapshot, onOpenFolder, phase }: SkillArchipelagoProps) {
  const timeOfDay: SkyPhase = phase ?? (lightTheme ? "noon" : "night");
  const [sceneOn, setSceneOn] = useState(skySceneEnabled);
  useEffect(() => {
    const onChange = (event: Event) => setSceneOn(Boolean((event as CustomEvent<boolean>).detail));
    window.addEventListener(SCENE_EVENT, onChange);
    return () => window.removeEventListener(SCENE_EVENT, onChange);
  }, []);
  const words = copy[getLang()];
  const islands = useMemo(() => buildSkyIslands(snapshot, words.unfiled), [snapshot, words.unfiled]);
  // Unrelated sync progress must not rebuild the GPU scene or reset its camera.
  const modelKey = JSON.stringify(islands.map(island => [island.id, island.name, island.weight]));
  const stableIslands = useMemo(() => islands, [modelKey]);
  const host = useRef<HTMLDivElement>(null), world = useRef<SkyWorld | null>(null);
  const labels = useRef(new Map<string, HTMLElement>());
  const openRef = useRef(onOpenFolder); openRef.current = onOpenFolder;
  const [status, setStatus] = useState<"loading" | "ready" | "fallback" | "off">("loading");
  const [paused, setPaused] = useState(() => readSetting("skillhub-sky-paused") === "1" || window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const [lowPower, setLowPower] = useState(() => {
    const saved = readSetting("skillhub-sky-low-power");
    return saved === null ? probeGraphics().weak : saved === "1";
  });
  const [query, setQuery] = useState(""), [navigation, setNavigation] = useState(false), [retry, setRetry] = useState(0);
  const [hovered, setHovered] = useState<string | null>(null);
  const [credits, setCredits] = useState(false);
  const visibleIslands = islands.filter(island => island.name.toLocaleLowerCase().includes(query.toLocaleLowerCase().trim()));
  const totalSkills = islands.reduce((sum, island) => sum + island.skillCount, 0);
  const current = useRef({ paused, lowPower }); current.current = { paused, lowPower };

  useEffect(() => {
    if (!host.current || !stableIslands.length) return;
    if (!sceneOn) {
      setStatus("off");
      return;
    }
    if (!probeGraphics().webgl) {
      setStatus("fallback");
      return;
    }
    let cancelled = false;
    setStatus("loading");
    import("./sky/world").then(({ createSkyWorld }) => {
      if (cancelled || !host.current) return;
      return createSkyWorld({
        host: host.current,
        islands: stableIslands.map(island => ({ id: island.id, name: island.name, weight: island.weight })),
        labels: labels.current,
        direction: timeOfDay,
        paused: current.current.paused,
        lowPower: current.current.lowPower,
        onOpen: id => openRef.current?.(id),
        onHover: setHovered,
        onFailure: () => {
          world.current?.dispose();
          world.current = null;
          setStatus("fallback");
        }
      }).then(created => {
        if (cancelled) {
          created.dispose();
          return;
        }
        world.current = created;
        setStatus("ready");
      });
    }).catch(() => {
      if (!cancelled) setStatus("fallback");
    });
    return () => {
      cancelled = true;
      world.current?.dispose();
      world.current = null;
    };
  }, [stableIslands, timeOfDay, retry, sceneOn]);
  useEffect(() => { world.current?.setPaused(paused); writeSetting("skillhub-sky-paused", paused ? "1" : "0"); }, [paused]);
  useEffect(() => { world.current?.setLowPower(lowPower); }, [lowPower]);
  const open = (id: string) => openRef.current?.(id);
  const toggleLowPower = () => setLowPower(value => {
    writeSetting("skillhub-sky-low-power", value ? "0" : "1");
    return !value;
  });
  const label = (island: (typeof islands)[number]) => `${island.skillCount.toLocaleString()} Skills${island.promptCount > 0 ? ` · ${island.promptCount} ${words.prompts}` : ""}`;

  const maxWeight = Math.max(1, ...islands.map(island => island.weight));
  return <section className={`skill-archipelago sky-islands sky-phase-${timeOfDay}${lightTheme ? " is-light" : ""}${status === "fallback" ? " is-fallback" : ""}${status === "off" ? " is-flat" : ""}`} aria-label={words.title} data-status={status}>
    <header className="sky-heading">
      <h2>{words.title}</h2>
      {islands.length > 0 && <p>{words.summary(islands.length, totalSkills)}</p>}
    </header>
    <div className="sky-controls">
      {status !== "off" && <>
      <button type="button" onClick={() => { world.current?.reset(); setQuery(""); setHovered(null); }} title={words.reset} aria-label={words.reset}><span aria-hidden="true">⌖</span><span>{words.reset}</span></button>
      <button type="button" aria-pressed={paused} onClick={() => setPaused(value => !value)} title={paused ? words.play : words.pause}><span aria-hidden="true">{paused ? "▷" : "Ⅱ"}</span><span>{paused ? words.play : words.pause}</span></button>
      <button type="button" aria-pressed={lowPower} onClick={toggleLowPower} title={words.lowPowerHint}><span aria-hidden="true">◐</span><span>{words.lowPower}</span></button>
      <button type="button" aria-expanded={navigation} onClick={() => setNavigation(value => !value)}>{navigation ? words.collapse : words.browse}<span aria-hidden="true">{navigation ? "−" : "+"}</span></button>
      </>}
      <button type="button" aria-pressed={!sceneOn} onClick={() => setSkySceneEnabled(!sceneOn)} title={words.sceneHint}><span aria-hidden="true">{sceneOn ? "▦" : "◒"}</span><span>{sceneOn ? words.sceneOff : words.sceneOn}</span></button>
    </div>
    {status === "off" && islands.length > 0 && <div className="sky-board" role="list">
      {islands.map(island => <button key={island.id} role="listitem" type="button" className="sky-board-card" onClick={() => open(island.id)} title={island.name}>
        <strong>{island.name}</strong>
        <span>{label(island)}</span>
        <i aria-hidden="true" style={{ width: `${Math.max(6, Math.round((island.weight / maxWeight) * 100))}%` }} />
      </button>)}
    </div>}
    <div className="sky-scene-host" ref={host}>
      <div className="sky-map-labels" hidden={status !== "ready"}>{islands.map(island => <button key={island.id} ref={element => { if (element) labels.current.set(island.id, element); else labels.current.delete(island.id); }}
        type="button" className={`sky-island-label${hovered === island.id ? " is-hovered" : ""}`} onClick={() => open(island.id)} onFocus={() => world.current?.focus(island.id)}
        title={island.name} aria-label={`${words.open} ${island.name} · ${label(island)}`}>
        <strong>{island.name}</strong><span>{label(island)}</span>
      </button>)}</div>
    </div>
    {(navigation || status === "fallback") && <aside className="sky-navigation" aria-label={words.browse}>
      <label className="sky-search"><span aria-hidden="true">⌕</span><input value={query} onChange={event => setQuery(event.target.value)} placeholder={words.search} aria-label={words.search} /></label>
      <div className="sky-navigation-list">{visibleIslands.map(island => <div className="sky-navigation-row" key={island.id}>
        <button type="button" onClick={() => open(island.id)} title={island.name}><strong>{island.name}</strong><span>{label(island)}</span></button>
        {status !== "fallback" && <button type="button" className="sky-locate" title={words.focus} aria-label={`${words.focus} ${island.name}`} onClick={() => { world.current?.focus(island.id); setHovered(island.id); }}>⌖</button>}
      </div>)}{!visibleIslands.length && <p>{words.noMatch}</p>}</div>
      {status === "fallback" && <div className="sky-fallback-note"><span>{words.fallback}</span>{probeGraphics().webgl && <button type="button" onClick={() => setRetry(value => value + 1)}>{words.retry}</button>}</div>}
    </aside>}
    {!snapshot ? <div className="sky-empty" role="status">{words.loading}</div> : !islands.length ? <div className="sky-empty"><h3>{words.empty}</h3><p>{words.emptyHint}</p><button type="button" onClick={() => open("all")}>{words.browse} →</button></div> : status === "loading" ? <div className="sky-loading" role="status">{words.loading}</div> : null}
    {islands.length > 0 && status !== "off" && <footer className="sky-caption"><span>{words.basis}</span><span>{words.hint}<button type="button" className="sky-credits-toggle" aria-expanded={credits} onClick={() => setCredits(value => !value)}>{words.credits}</button></span></footer>}
    {credits && <aside className="sky-credits" aria-label={words.creditsTitle}>
      <header><strong>{words.creditsTitle}</strong><button type="button" onClick={() => setCredits(false)} aria-label={words.close}>×</button></header>
      <ul>{ASSET_CREDITS.map(item => <li key={item.work}><span>{item.work}</span><small>{item.author} · {item.licence}</small></li>)}</ul>
      <p>{words.creditsOriginal}</p>
    </aside>}
  </section>;
}
