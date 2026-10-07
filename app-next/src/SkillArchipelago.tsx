import "./HomeScene.css";
import { useEffect, useMemo, useRef, useState } from "react";
import { getLang } from "./i18n";
import { buildSkyIslands, demoSkyIslands } from "./skyIslandModel";
import type { SkyWorld, SkyWorldInfo, SkyWorldView } from "./sky/world";
import type { SkillUniverseProps } from "./SkillUniverse";
import { CLIMATES, climateCounts } from "./sky/climates";
import { WEATHER_GLYPHS, skyWords } from "./sky/skyI18n";
import {
  SKY_SCENE_EVENT as SCENE_EVENT, SKY_WEATHER_KINDS, probeGraphics, readSetting, rerollWorld, setSkySceneEnabled, setSkyWeatherSetting,
  skySceneEnabled, skyWeatherSetting, worldSeed, writeSetting
} from "./skyScene";
import type { SkyWeatherSetting } from "./skyScene";
import "./SkillArchipelago.css";

export type SkyPhase = "dawn" | "noon" | "golden" | "night";
export type SkillArchipelagoProps = SkillUniverseProps & {
  onOpenFolder?: (folderId: string) => void;
  phase?: SkyPhase;
  /** The empty state's action: open "+ Add". Falls back to the library. */
  onAdd?: () => void;
};
const copy = {
  zh: { title: "天空岛", basis: "岛屿面积按 Skills 数 + Prompt 来源数计算", unfiled: "未归档", search: "寻找分类", reset: "回到全景", pause: "暂停动画", play: "播放动画", lowPower: "省电模式", lowPowerHint: "降低分辨率与阴影，减少动画帧率", loading: "正在准备天空岛…", fallback: "当前设备无法显示 3D 场景，已切换为分类列表", open: "打开分类", noMatch: "没有匹配的分类", browse: "分类导航", collapse: "收起导航", focus: "在地图中定位", retry: "重新加载场景", hint: "拖动平移 · 滚轮缩放 · 点击岛屿打开分类", credits: "素材与许可", sceneOn: "3D 天空岛", sceneOff: "简洁分类", sceneHint: "简洁分类以卡片显示分类，不占用显卡；可随时在这里或设置中切换。", creditsTitle: "天空岛素材", creditsOriginal: "岛屿地形、云海、水面、天气、布局与动画为 AI SkillHub 原创。", close: "关闭" },
  en: { title: "Sky islands", basis: "Island area = Skills + Prompt sources", unfiled: "Unfiled", search: "Find a category", reset: "Show all", pause: "Pause motion", play: "Play motion", lowPower: "Low power", lowPowerHint: "Lower resolution, no shadows, fewer frames", loading: "Preparing your islands…", fallback: "3D is unavailable on this device; showing the category list", open: "Open category", noMatch: "No matching categories", browse: "Categories", collapse: "Close navigation", focus: "Locate on map", retry: "Reload scene", hint: "Drag to pan · Scroll to zoom · Click an island to open", credits: "Assets & licences", sceneOn: "3D islands", sceneOff: "Simple view", sceneHint: "Simple view shows category cards and uses no GPU. Switch back here or in Settings.", creditsTitle: "Sky island assets", creditsOriginal: "Island terrain, clouds, water, weather, layout and animation are original to AI SkillHub.", close: "Close" },
  ko: { title: "하늘섬", basis: "섬 면적 = Skills 수 + Prompt 소스 수", unfiled: "미분류", search: "분류 찾기", reset: "전체 보기", pause: "애니메이션 정지", play: "애니메이션 재생", lowPower: "저전력", lowPowerHint: "해상도와 그림자를 낮추고 프레임을 줄입니다", loading: "하늘섬을 준비하는 중…", fallback: "이 기기에서는 3D를 표시할 수 없어 분류 목록을 보여 줍니다", open: "분류 열기", noMatch: "일치하는 분류가 없습니다", browse: "분류 탐색", collapse: "탐색 닫기", focus: "지도에서 찾기", retry: "장면 다시 로드", hint: "드래그 이동 · 스크롤 확대 · 섬을 클릭해 열기", credits: "에셋과 라이선스", sceneOn: "3D 하늘섬", sceneOff: "간단히 보기", sceneHint: "간단히 보기는 분류 카드를 보여 주며 GPU를 쓰지 않습니다. 여기나 설정에서 다시 켤 수 있습니다.", creditsTitle: "하늘섬 에셋", creditsOriginal: "섬 지형, 구름, 물, 날씨, 배치와 애니메이션은 AI SkillHub 자체 제작입니다.", close: "닫기" }
};


/** Bundled third-party assets (see public/sky/ATTRIBUTION.txt). */
const ASSET_CREDITS = [
  { work: "Medieval Village MegaKit · Fantasy Props MegaKit", author: "Quaternius", licence: "CC0 1.0" },
  { work: "Ultimate Modular Women (animated) · Farm Animals Pack", author: "Quaternius", licence: "CC0 1.0" },
  { work: "Flying gull (via Poly Pizza, modified)", author: "Poly by Google", licence: "CC-BY 3.0" }
];

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

/** Development preview only: `?skyDemo=12` or localStorage
 * `skillhub-sky-demo-islands` adds demo islands to see many climates. */
function demoIslandCount(): number {
  if (!import.meta.env.DEV) return 0;
  try {
    const raw = new URLSearchParams(window.location.search).get("skyDemo") ?? readSetting("skillhub-sky-demo-islands");
    const count = raw ? Number.parseInt(raw, 10) : 0;
    return Number.isFinite(count) && count > 0 ? count : 0;
  } catch {
    return 0;
  }
}

export function SkillArchipelago({ lightTheme, snapshot, onOpenFolder, onAdd, phase, visible = true }: SkillArchipelagoProps) {
  const timeOfDay: SkyPhase = phase ?? (lightTheme ? "noon" : "night");
  const [sceneOn, setSceneOn] = useState(skySceneEnabled);
  const [seed, setSeed] = useState(() => worldSeed());
  useEffect(() => {
    const onChange = (event: Event) => {
      setSceneOn(Boolean((event as CustomEvent<boolean>).detail));
      setSeed(worldSeed());
    };
    window.addEventListener(SCENE_EVENT, onChange);
    return () => window.removeEventListener(SCENE_EVENT, onChange);
  }, []);
  const lang = getLang();
  const words = copy[lang];
  const sky = skyWords(lang);
  const demoCount = useMemo(demoIslandCount, []);
  const islands = useMemo(() => [...buildSkyIslands(snapshot, words.unfiled), ...demoSkyIslands(demoCount)], [snapshot, words.unfiled, demoCount]);
  // Unrelated sync progress must not rebuild the GPU scene or reset its camera.
  const modelKey = JSON.stringify(islands.map(island => [island.id, island.name, island.weight]));
  const stableIslands = useMemo(() => islands, [modelKey]);
  const host = useRef<HTMLDivElement>(null), world = useRef<SkyWorld | null>(null);
  // A world being replaced stays on screen until its successor is ready.
  const retiring = useRef<SkyWorld[]>([]);
  const savedView = useRef<{ key: string; view: SkyWorldView } | null>(null);
  const labels = useRef(new Map<string, HTMLElement>());
  const openRef = useRef(onOpenFolder); openRef.current = onOpenFolder;
  const [status, setStatus] = useState<"loading" | "ready" | "fallback" | "off" | "empty">("loading");
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia(REDUCED_MOTION).matches);
  // Only an explicit click pauses; the OS motion preference is not saved.
  const [paused, setPaused] = useState(() => readSetting("skillhub-sky-paused") === "1");
  const [lowPower, setLowPower] = useState(() => {
    const saved = readSetting("skillhub-sky-low-power");
    return saved === null ? probeGraphics().weak : saved === "1";
  });
  const [weatherSetting, setWeatherSetting] = useState<SkyWeatherSetting>(skyWeatherSetting);
  const [info, setInfo] = useState<SkyWorldInfo | null>(null);
  const [rerolling, setRerolling] = useState(false);
  const [query, setQuery] = useState(""), [navigation, setNavigation] = useState(false), [retry, setRetry] = useState(0);
  const [hovered, setHovered] = useState<string | null>(null);
  const [credits, setCredits] = useState(false);
  const [worldPanel, setWorldPanel] = useState(false);
  const worldPanelRef = useRef<HTMLDivElement>(null), worldToggleRef = useRef<HTMLButtonElement>(null);
  const visibleIslands = islands.filter(island => island.name.toLocaleLowerCase().includes(query.toLocaleLowerCase().trim()));
  const totalSkills = islands.reduce((sum, island) => sum + island.skillCount, 0);
  const hasSnapshot = Boolean(snapshot);
  const current = useRef({ paused, lowPower, visible, timeOfDay, weatherSetting });
  current.current = { paused, lowPower, visible, timeOfDay, weatherSetting };

  useEffect(() => {
    const query = window.matchMedia(REDUCED_MOTION);
    const onChange = () => setReducedMotion(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  const disposeRetiring = () => {
    for (const old of retiring.current.splice(0)) old.dispose();
  };
  useEffect(() => () => {
    disposeRetiring();
    world.current?.dispose();
    world.current = null;
  }, []);

  useEffect(() => {
    if (!host.current || !stableIslands.length) {
      disposeRetiring();
      setStatus(hasSnapshot ? "empty" : "loading");
      return;
    }
    if (!sceneOn) {
      setStatus("off");
      disposeRetiring();
      return;
    }
    if (!probeGraphics().webgl) {
      setStatus("fallback");
      disposeRetiring();
      return;
    }
    let cancelled = false;
    if (!retiring.current.length) setStatus("loading");
    const initialView = savedView.current?.key === modelKey ? savedView.current.view : null;
    import("./sky/world").then(({ createSkyWorld }) => {
      if (cancelled || !host.current) return;
      return createSkyWorld({
        host: host.current,
        islands: stableIslands.map(island => ({ id: island.id, name: island.name, weight: island.weight })),
        labels: labels.current,
        direction: current.current.timeOfDay,
        paused: current.current.paused,
        visible: current.current.visible,
        lowPower: current.current.lowPower,
        seed,
        weather: current.current.weatherSetting,
        initialView,
        onOpen: id => openRef.current?.(id),
        onHover: setHovered,
        onInfo: setInfo,
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
        disposeRetiring();
        world.current = created;
        created.setVisible(current.current.visible);
        created.setDirection(current.current.timeOfDay);
        setRerolling(false);
        setStatus("ready");
      });
    }).catch(() => {
      if (cancelled) return;
      disposeRetiring();
      setRerolling(false);
      setStatus("fallback");
    });
    return () => {
      cancelled = true;
      const old = world.current;
      world.current = null;
      if (old) {
        savedView.current = { key: modelKey, view: old.view() };
        old.setVisible(false);
        retiring.current.push(old);
      }
    };
  }, [stableIslands, retry, sceneOn, seed, hasSnapshot]);
  useEffect(() => { world.current?.setVisible(visible); }, [visible]);
  useEffect(() => { world.current?.setPaused(paused); }, [paused]);
  useEffect(() => { world.current?.setLowPower(lowPower); }, [lowPower]);
  // The time of day changes the light in place: no rebuild, the view stays.
  useEffect(() => { world.current?.setDirection(timeOfDay); }, [timeOfDay]);
  useEffect(() => { world.current?.setWeather(weatherSetting); }, [weatherSetting]);

  // The world panel closes on Escape or a click elsewhere.
  useEffect(() => {
    if (!worldPanel) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setWorldPanel(false);
        worldToggleRef.current?.focus();
      }
    };
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!worldPanelRef.current?.contains(target) && !worldToggleRef.current?.contains(target)) setWorldPanel(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [worldPanel]);

  const open = (id: string) => openRef.current?.(id);
  const toggleLowPower = () => setLowPower(value => {
    writeSetting("skillhub-sky-low-power", value ? "0" : "1");
    return !value;
  });
  const togglePaused = () => setPaused(value => {
    writeSetting("skillhub-sky-paused", value ? "0" : "1");
    return !value;
  });
  const chooseWeather = (value: SkyWeatherSetting) => {
    setSkyWeatherSetting(value);
    setWeatherSetting(value);
  };
  const reroll = () => {
    setRerolling(true);
    rerollWorld();
  };
  // Panels share the right side: opening one closes the others.
  const showPanel = (panel: "navigation" | "credits" | "world") => {
    setNavigation(value => panel === "navigation" ? !value : false);
    setCredits(value => panel === "credits" ? !value : false);
    setWorldPanel(value => panel === "world" ? !value : false);
  };
  const label = (island: (typeof islands)[number]) => `${sky.skills(island.skillCount)}${island.promptCount > 0 ? ` · ${sky.prompts(island.promptCount)}` : ""}`;
  const climateOf = (id: string) => (info?.climates[id] ? sky.climateNames[info.climates[id]] : "");
  const still = paused || reducedMotion;
  const legend = info ? climateCounts(info.climates) : [];
  const weatherName = info ? sky.weathers[info.weather] : "";

  const maxWeight = Math.max(1, ...islands.map(island => island.weight));
  const threeD = islands.length > 0 && status !== "off";
  return <section className={`skill-archipelago sky-islands sky-phase-${timeOfDay}${lightTheme ? " is-light" : ""}${status === "fallback" ? " is-fallback" : ""}${status === "off" ? " is-flat" : ""}`} aria-label={words.title} data-status={status} data-weather={info?.weather ?? ""} data-world-seed={seed}>
    <header className="sky-heading">
      <h2>{words.title}</h2>
      {islands.length > 0 && <p>{sky.summary(islands.length, totalSkills)}</p>}
    </header>
    <div className="sky-controls">
      {threeD && <>
      <button type="button" className="sky-control-compact" onClick={() => { world.current?.reset(); setQuery(""); setHovered(null); }} title={words.reset} aria-label={words.reset}><span aria-hidden="true">⌖</span><span>{words.reset}</span></button>
      <button type="button" className="sky-control-compact" aria-pressed={still} disabled={reducedMotion} onClick={togglePaused} title={reducedMotion ? sky.reducedMotion : still ? words.play : words.pause}><span aria-hidden="true">{still ? "▷" : "Ⅱ"}</span><span>{still ? words.play : words.pause}</span></button>
      <button type="button" className="sky-control-compact" aria-pressed={lowPower} onClick={toggleLowPower} title={words.lowPowerHint}><span aria-hidden="true">◐</span><span>{words.lowPower}</span></button>
      {status !== "fallback" && <button ref={worldToggleRef} type="button" className="sky-control-compact sky-world-toggle" aria-haspopup="dialog" aria-expanded={worldPanel} onClick={() => showPanel("world")} title={sky.worldTitle}><span aria-hidden="true">{WEATHER_GLYPHS[info?.weather ?? "auto"]}</span><span>{sky.world}</span></button>}
      <button type="button" aria-expanded={navigation} onClick={() => showPanel("navigation")}>{navigation ? words.collapse : words.browse}<span aria-hidden="true">{navigation ? "−" : "+"}</span></button>
      </>}
      <button type="button" aria-pressed={!sceneOn} onClick={() => setSkySceneEnabled(!sceneOn)} title={words.sceneHint}><span aria-hidden="true">{sceneOn ? "▦" : "◒"}</span><span>{sceneOn ? words.sceneOff : words.sceneOn}</span></button>
    </div>
    {worldPanel && threeD && status !== "fallback" && <div className="sky-world-panel" role="dialog" aria-label={sky.worldTitle} ref={worldPanelRef}>
      <h3>{sky.weather}</h3>
      <div className="sky-weather-options" role="radiogroup" aria-label={sky.weather}>
        {(["auto", ...SKY_WEATHER_KINDS] as SkyWeatherSetting[]).map(kind => {
          const night = timeOfDay === "night";
          const disabled = kind === "aurora" && !night;
          const name = kind === "auto" ? (weatherSetting === "auto" && weatherName ? sky.autoNow(weatherName) : sky.auto) : sky.weathers[kind];
          return <button key={kind} type="button" role="radio" aria-checked={weatherSetting === kind} disabled={disabled} title={disabled ? sky.auroraNight : name} className={kind === "auto" ? "is-auto" : undefined} onClick={() => chooseWeather(kind)}>
            <span aria-hidden="true">{WEATHER_GLYPHS[kind]}</span><span>{name}</span>
          </button>;
        })}
      </div>
      <button type="button" className="sky-reroll" onClick={reroll} disabled={rerolling} title={sky.rerollHint}>{rerolling ? sky.rerolling : sky.reroll}</button>
      {legend.length > 0 && <>
        <h3>{sky.climates}</h3>
        <ul className="sky-climate-legend">{legend.map(([id, count]) => <li key={id}><i aria-hidden="true" style={{ background: CLIMATES[id].swatch }} /><span>{sky.climateNames[id]}</span>{count > 1 && <small>×{count}</small>}</li>)}</ul>
      </>}
    </div>}
    {status === "off" && islands.length > 0 && <div className="sky-board" role="list">
      {islands.map(island => <div role="listitem" key={island.id}><button type="button" className="sky-board-card" onClick={() => open(island.id)} title={island.name}>
        <strong>{island.name}</strong>
        <span>{label(island)}</span>
        <i aria-hidden="true" style={{ width: `${Math.max(6, Math.round((island.weight / maxWeight) * 100))}%` }} />
      </button></div>)}
    </div>}
    <div className="sky-scene-host" ref={host}>
      <div className="sky-map-labels" hidden={status !== "ready"}>{islands.map(island => {
        const climate = climateOf(island.id);
        return <button key={island.id} ref={element => { if (element) labels.current.set(island.id, element); else labels.current.delete(island.id); }}
          type="button" className={`sky-island-label${hovered === island.id ? " is-hovered" : ""}`} onClick={() => open(island.id)}
          // Fly to the island only on keyboard focus: a mouse press focuses
          // the button too, and moving the camera then would move the label
          // out from under the pointer before the click lands.
          onFocus={event => { if (event.currentTarget.matches(":focus-visible")) world.current?.focus(island.id); }}
          title={climate ? `${island.name} · ${climate}` : island.name} aria-label={`${words.open} ${island.name} · ${label(island)}${climate ? ` · ${climate}` : ""}`}>
          <strong>{island.name}</strong><span>{label(island)}</span>
        </button>;
      })}</div>
    </div>
    {(navigation || status === "fallback") && <aside className="sky-navigation" aria-label={words.browse}>
      <label className="sky-search"><span aria-hidden="true">⌕</span><input value={query} onChange={event => setQuery(event.target.value)} placeholder={words.search} aria-label={words.search} /></label>
      <div className="sky-navigation-list">{visibleIslands.map(island => <div className="sky-navigation-row" key={island.id}>
        <button type="button" onClick={() => open(island.id)} title={island.name}><strong>{island.name}</strong><span>{label(island)}</span></button>
        {status !== "fallback" && <button type="button" className="sky-locate" title={words.focus} aria-label={`${words.focus} ${island.name}`} onClick={() => { world.current?.focus(island.id); setHovered(island.id); }}>⌖</button>}
      </div>)}{!visibleIslands.length && query.trim() !== "" && <p>{words.noMatch}</p>}</div>
      {status === "fallback" && <div className="sky-fallback-note"><span>{words.fallback}</span>{probeGraphics().webgl && <button type="button" onClick={() => setRetry(value => value + 1)}>{words.retry}</button>}</div>}
    </aside>}
    {!snapshot ? <div className="sky-empty" role="status">{words.loading}</div>
      : !islands.length ? <div className="sky-empty"><h3>{sky.empty}</h3><p>{sky.emptyHint}</p><button type="button" onClick={() => (onAdd ? onAdd() : open("all"))}>{onAdd ? sky.addSource : `${words.browse} →`}</button></div>
      : status === "loading" ? <div className="sky-loading" role="status">{words.loading}</div>
      : rerolling ? <div className="sky-loading" role="status">{sky.rerolling}</div> : null}
    {islands.length > 0 && status !== "off" && <footer className="sky-caption"><span>{words.basis}</span><span>{words.hint}<button type="button" className="sky-credits-toggle" aria-expanded={credits} onClick={() => showPanel("credits")}>{words.credits}</button></span></footer>}
    {credits && <aside className="sky-credits" aria-label={words.creditsTitle}>
      <header><strong>{words.creditsTitle}</strong><button type="button" onClick={() => setCredits(false)} aria-label={words.close}>×</button></header>
      <ul>{ASSET_CREDITS.map(item => <li key={item.work}><span>{item.work}</span><small>{item.author} · {item.licence}</small></li>)}</ul>
      <p>{words.creditsOriginal}</p>
    </aside>}
  </section>;
}
