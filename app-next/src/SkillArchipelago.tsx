import "./HomeScene.css";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { getLang } from "./i18n";
import { buildSkyIslands, demoSkyIslands } from "./skyIslandModel";
import type { SkyWorld, SkyWorldInfo, SkyWorldView } from "./sky/world";
import type { SkillUniverseProps } from "./SkillUniverse";
import { CLIMATES, climateCounts } from "./sky/climates";
import { WEATHER_GLYPHS, skyWords } from "./sky/skyI18n";
import {
  APP_BACKGROUND_EVENT, APP_HIDDEN_EVENT, APP_VISIBLE_EVENTS, SKY_SCENE_EVENT as SCENE_EVENT, SKY_WEATHER_KINDS, appHiddenFromEvent, probeGraphics, readSetting,
  rerollWorld, setSkySceneEnabled, setSkyWeatherSetting, skySceneEnabled, skyWeatherSetting, worldSeed, writeSetting
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
  zh: { title: "天空岛", unfiled: "未归档", search: "寻找分类", reset: "回到全景", pause: "暂停动画", play: "播放动画", lowPower: "省电模式", lowPowerHint: "降低分辨率与阴影，减少动画帧率", loading: "正在准备天空岛…", fallback: "当前设备无法显示 3D 场景，已切换为分类列表", open: "打开分类", noMatch: "没有匹配的分类", browse: "分类导航", collapse: "收起导航", focus: "在地图中定位", retry: "重新加载场景", hint: "拖动平移 · 滚轮缩放 · 点击岛屿打开分类", credits: "素材与许可", sceneOn: "3D 天空岛", sceneOff: "简洁分类", sceneHint: "简洁分类以卡片显示分类，不占用显卡；可随时在这里或设置中切换。", creditsTitle: "天空岛素材", creditsOriginal: "岛屿地形、云海、水面、天气、布局与动画为 AI SkillHub 原创。", close: "关闭" },
  en: { title: "Sky islands", unfiled: "Unfiled", search: "Find a category", reset: "Show all", pause: "Pause motion", play: "Play motion", lowPower: "Low power", lowPowerHint: "Lower resolution, no shadows, fewer frames", loading: "Preparing your islands…", fallback: "3D is unavailable on this device; showing the category list", open: "Open category", noMatch: "No matching categories", browse: "Categories", collapse: "Close navigation", focus: "Locate on map", retry: "Reload scene", hint: "Drag to pan · Scroll to zoom · Click an island to open", credits: "Assets & licences", sceneOn: "3D islands", sceneOff: "Simple view", sceneHint: "Simple view shows category cards and uses no GPU. Switch back here or in Settings.", creditsTitle: "Sky island assets", creditsOriginal: "Island terrain, clouds, water, weather, layout and animation are original to AI SkillHub.", close: "Close" },
  ko: { title: "하늘섬", unfiled: "미분류", search: "분류 찾기", reset: "전체 보기", pause: "애니메이션 정지", play: "애니메이션 재생", lowPower: "저전력", lowPowerHint: "해상도와 그림자를 낮추고 프레임을 줄입니다", loading: "하늘섬을 준비하는 중…", fallback: "이 기기에서는 3D를 표시할 수 없어 분류 목록을 보여 줍니다", open: "분류 열기", noMatch: "일치하는 분류가 없습니다", browse: "분류 탐색", collapse: "탐색 닫기", focus: "지도에서 찾기", retry: "장면 다시 로드", hint: "드래그 이동 · 스크롤 확대 · 섬을 클릭해 열기", credits: "에셋과 라이선스", sceneOn: "3D 하늘섬", sceneOff: "간단히 보기", sceneHint: "간단히 보기는 분류 카드를 보여 주며 GPU를 쓰지 않습니다. 여기나 설정에서 다시 켤 수 있습니다.", creditsTitle: "하늘섬 에셋", creditsOriginal: "섬 지형, 구름, 물, 날씨, 배치와 애니메이션은 AI SkillHub 자체 제작입니다.", close: "닫기" }
};


/** Bundled third-party assets (see public/sky/ATTRIBUTION.txt). */
const ASSET_CREDITS = [
  { work: "Medieval Village MegaKit · Fantasy Props MegaKit", author: "Quaternius", licence: "CC0 1.0" },
  { work: "Ultimate Modular Women (animated) · Farm Animals Pack", author: "Quaternius", licence: "CC0 1.0" },
  { work: "Flying gull (via Poly Pizza, modified)", author: "Poly by Google", licence: "CC-BY 3.0" }
];

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";
const WEATHER_OPTIONS: SkyWeatherSetting[] = ["auto", ...SKY_WEATHER_KINDS];


/** Out of sight this long, the 3D world sleeps: a still image stays on screen
 * and every GPU resource (and the WebGL context) is released. */
const SLEEP_AFTER_MS = (() => {
  // Development only: QA may shorten the wait (localStorage skillhub-sky-sleep-ms).
  const override = import.meta.env.DEV ? Number(readSetting("skillhub-sky-sleep-ms")) : 0;
  return override > 0 ? override : 15_000;
})();
/** The shell sends its background event only after the window has been
 * unfocused for a while, so the world sleeps soon after it arrives. */
const BACKGROUND_SLEEP_MS = 1_000;

type Still = { key: string; url: string; view: SkyWorldView; width: number; height: number };
/** The last still image, kept across remounts: home unmounts when another
 * page opens, and coming back shows it at once while the world rebuilds. */
let lastStill: Still | null = null;

function keepStill(next: Still | null) {
  if (lastStill && lastStill.url !== next?.url) URL.revokeObjectURL(lastStill.url);
  lastStill = next;
}

/** A 2D snapshot canvas as a compact image (about 0.2 MB instead of 8 MB). */
function encodeStill(canvas: HTMLCanvasElement, done: (url: string | null) => void) {
  try {
    canvas.toBlob(blob => {
      canvas.width = canvas.height = 0;
      done(blob ? URL.createObjectURL(blob) : null);
    }, "image/webp", 0.92);
  } catch {
    done(null);
  }
}

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
  const stillKey = `${modelKey}|${seed}|${timeOfDay}`;
  const host = useRef<HTMLDivElement>(null), world = useRef<SkyWorld | null>(null);
  // A world being replaced stays on screen until its successor is ready.
  const retiring = useRef<SkyWorld[]>([]);
  const [still, setStill] = useState<string | null>(() => (lastStill?.key === stillKey ? lastStill.url : null));
  const stillRef = useRef(still); stillRef.current = still;
  const savedView = useRef<{ key: string; view: SkyWorldView } | null>(lastStill?.key === stillKey ? { key: modelKey, view: lastStill.view } : null);
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
  // Sleep: the scene is out of sight (another page, a hidden tab, a
  // minimised window) for SLEEP_AFTER_MS. Waking rebuilds it behind the still.
  const [pageHidden, setPageHidden] = useState(() => document.hidden);
  const [appHidden, setAppHidden] = useState(false);
  // Unfocused for a while (the shell's background event): stop and sleep too.
  const [appBackground, setAppBackground] = useState(false);
  const [asleep, setAsleep] = useState(false);
  const awake = visible && !pageHidden && !appHidden && !appBackground;
  const worldPanelRef = useRef<HTMLDivElement>(null), worldToggleRef = useRef<HTMLButtonElement>(null);
  const worldPanelId = useId();
  // The panel opens just under the controls, wherever the page puts them
  // (the v3.3 home moves them below its own block).
  const controlsRef = useRef<HTMLDivElement>(null);
  const [worldPanelTop, setWorldPanelTop] = useState<number | null>(null);
  const visibleIslands = islands.filter(island => island.name.toLocaleLowerCase().includes(query.toLocaleLowerCase().trim()));
  const totalSkills = islands.reduce((sum, island) => sum + island.skillCount, 0);
  const hasSnapshot = Boolean(snapshot);
  const current = useRef({ paused, lowPower, awake, timeOfDay, weatherSetting, modelKey, stillKey });
  current.current = { paused, lowPower, awake, timeOfDay, weatherSetting, modelKey, stillKey };

  useEffect(() => {
    const query = window.matchMedia(REDUCED_MOTION);
    const onChange = () => setReducedMotion(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    const onVisibility = () => setPageHidden(document.hidden);
    const onHidden = (event: Event) => setAppHidden(appHiddenFromEvent(event));
    const onBackground = () => setAppBackground(true);
    const onShown = () => {
      setAppHidden(false);
      setAppBackground(false);
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener(APP_HIDDEN_EVENT, onHidden);
    window.addEventListener(APP_BACKGROUND_EVENT, onBackground);
    for (const name of APP_VISIBLE_EVENTS) window.addEventListener(name, onShown);
    // A restored window takes focus again even if the shell says nothing.
    window.addEventListener("focus", onShown);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener(APP_HIDDEN_EVENT, onHidden);
      window.removeEventListener(APP_BACKGROUND_EVENT, onBackground);
      for (const name of APP_VISIBLE_EVENTS) window.removeEventListener(name, onShown);
      window.removeEventListener("focus", onShown);
    };
  }, []);

  const clearStill = () => {
    const url = stillRef.current;
    if (!url) return;
    stillRef.current = null;
    setStill(null);
    // The cached copy for the next visit stays; any other image goes.
    if (lastStill?.url !== url) window.setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  const disposeRetiring = () => {
    for (const old of retiring.current.splice(0)) old.dispose();
  };
  useEffect(() => () => {
    // Leaving home: keep a still of the view for the next visit, then free
    // the GPU. The encode finishes after unmount; it only touches lastStill.
    const old = world.current;
    world.current = null;
    if (old) {
      const key = current.current.stillKey;
      const view = old.view();
      const canvas = old.snapshot();
      if (canvas) {
        const { width, height } = canvas;
        encodeStill(canvas, url => {
          if (url) keepStill({ key, url, view, width, height });
        });
      }
      old.dispose();
    }
    disposeRetiring();
    const url = stillRef.current;
    if (url && lastStill?.url !== url) URL.revokeObjectURL(url);
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
      clearStill();
      return;
    }
    if (!probeGraphics().webgl) {
      setStatus("fallback");
      disposeRetiring();
      clearStill();
      return;
    }
    if (asleep) {
      // The still image and the labels stay; the GPU world is gone.
      disposeRetiring();
      return;
    }
    let cancelled = false;
    // With a still image on screen the labels stay up while the world builds.
    if (!retiring.current.length && !stillRef.current) setStatus("loading");
    const initialView = savedView.current?.key === modelKey ? savedView.current.view : null;
    import("./sky/world").then(({ createSkyWorld }) => {
      if (cancelled || !host.current) return;
      return createSkyWorld({
        host: host.current,
        islands: stableIslands.map(island => ({ id: island.id, name: island.name, weight: island.weight })),
        labels: labels.current,
        direction: current.current.timeOfDay,
        paused: current.current.paused,
        visible: current.current.awake,
        lowPower: current.current.lowPower,
        seed,
        weather: current.current.weatherSetting,
        initialView,
        onOpen: id => openRef.current?.(id),
        onHover: setHovered,
        onInfo: setInfo,
        onFirstFrame: clearStill,
        onFailure: () => {
          world.current?.dispose();
          world.current = null;
          clearStill();
          setStatus("fallback");
        }
      }).then(created => {
        if (cancelled) {
          created.dispose();
          return;
        }
        disposeRetiring();
        world.current = created;
        created.setVisible(current.current.awake);
        created.setDirection(current.current.timeOfDay);
        setRerolling(false);
        setStatus("ready");
      });
    }).catch(() => {
      if (cancelled) return;
      disposeRetiring();
      clearStill();
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
  }, [stableIslands, retry, sceneOn, seed, hasSnapshot, asleep]);
  useEffect(() => { world.current?.setVisible(awake); }, [awake]);
  useEffect(() => { world.current?.setPaused(paused); }, [paused]);
  useEffect(() => { world.current?.setLowPower(lowPower); }, [lowPower]);
  // The time of day changes the light in place: no rebuild, the view stays.
  useEffect(() => { world.current?.setDirection(timeOfDay); }, [timeOfDay]);
  useEffect(() => { world.current?.setWeather(weatherSetting); }, [weatherSetting]);

  // Out of sight long enough: keep a still image and release the world. The
  // world goes only once its still is decoded and on screen, so a window that
  // stays visible (the background case) never shows an empty sky in between;
  // waking up before then cancels the sleep, and a late still is not shown.
  useEffect(() => {
    if (awake || asleep) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      const sleeping = world.current;
      if (!sleeping) return;
      const canvas = sleeping.snapshot();
      if (!canvas) {
        setAsleep(true);
        return;
      }
      const view = sleeping.view();
      const { width, height } = canvas;
      const key = current.current.stillKey;
      encodeStill(canvas, url => {
        if (url) keepStill({ key, url, view, width, height });
        if (cancelled) return;
        if (!url) {
          setAsleep(true);
          return;
        }
        const image = new Image();
        image.src = url;
        const swap = () => {
          if (cancelled) return;
          stillRef.current = url;
          setStill(url);
          setAsleep(true);
        };
        image.decode().then(swap, swap);
      });
    }, appBackground && visible && !pageHidden && !appHidden ? BACKGROUND_SLEEP_MS : SLEEP_AFTER_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [awake, asleep]);
  // Back in sight: rebuild behind the still (it goes after the first frame).
  useEffect(() => {
    if (awake && asleep) setAsleep(false);
  }, [awake, asleep]);
  // A pointer over the scene means someone is looking at it again.
  const wake = () => {
    if (appHidden) setAppHidden(false);
    if (appBackground) setAppBackground(false);
    if (asleep && visible && !pageHidden) setAsleep(false);
  };

  // Labels change size with the language: let the world place them again.
  const labelText = islands.map(island => `${island.name}:${island.skillCount}:${island.promptCount}`).join("|");
  useEffect(() => { world.current?.relayout(); }, [lang, labelText]);

  useLayoutEffect(() => {
    if (!worldPanel) return;
    const place = () => {
      const controls = controlsRef.current;
      if (controls) setWorldPanelTop(controls.offsetTop + controls.offsetHeight + 10);
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [worldPanel]);
  // The world panel takes focus on its checked weather when it opens, and
  // closes on Escape (focus back on its button) or a click elsewhere.
  useEffect(() => {
    if (!worldPanel) return;
    worldPanelRef.current?.querySelector<HTMLButtonElement>('[role="radio"][tabindex="0"]')?.focus();
  }, [worldPanel]);
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
  // The weather choices are one radio group: Tab reaches the checked one,
  // arrow keys move and choose (aurora only at night), Home/End jump.
  const weatherAvailable = (kind: SkyWeatherSetting) => kind !== "aurora" || timeOfDay === "night";
  const weatherFocus: SkyWeatherSetting = weatherAvailable(weatherSetting) ? weatherSetting : "auto";
  const onWeatherKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const choices = WEATHER_OPTIONS.filter(weatherAvailable);
    const index = Math.max(0, choices.indexOf(weatherFocus));
    const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    const next = event.key === "Home" ? choices[0] : event.key === "End" ? choices[choices.length - 1] : step ? choices[(index + step + choices.length) % choices.length] : null;
    if (!next) return;
    event.preventDefault();
    chooseWeather(next);
    event.currentTarget.querySelector<HTMLButtonElement>(`[data-weather="${next}"]`)?.focus();
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
  const still3d = paused || reducedMotion;
  const legend = info ? climateCounts(info.climates) : [];
  const weatherName = info ? sky.weathers[info.weather] : "";

  const maxWeight = Math.max(1, ...islands.map(island => island.weight));
  const threeD = islands.length > 0 && status !== "off";
  return <section className={`skill-archipelago sky-islands sky-phase-${timeOfDay}${lightTheme ? " is-light" : ""}${status === "fallback" ? " is-fallback" : ""}${status === "off" ? " is-flat" : ""}`} aria-label={words.title} data-status={status} data-weather={info?.weather ?? ""} data-world-seed={seed} onPointerMove={asleep || appHidden || appBackground ? wake : undefined}>
    <header className="sky-heading">
      <h2>{words.title}</h2>
      {islands.length > 0 && <p>{sky.summary(islands.length, totalSkills)}</p>}
    </header>
    <div className="sky-controls" ref={controlsRef}>
      {threeD && <>
      {/* Below 1000 px these show only their glyph: the names stay in aria-label. */}
      <button type="button" className="sky-control-compact" onClick={() => { world.current?.reset(); setQuery(""); setHovered(null); }} title={words.reset} aria-label={words.reset}><span aria-hidden="true">⌖</span><span>{words.reset}</span></button>
      <button type="button" className="sky-control-compact" aria-pressed={still3d} disabled={reducedMotion} onClick={togglePaused} aria-label={still3d ? words.play : words.pause} title={reducedMotion ? sky.reducedMotion : still3d ? words.play : words.pause}><span aria-hidden="true">{still3d ? "▷" : "Ⅱ"}</span><span>{still3d ? words.play : words.pause}</span></button>
      <button type="button" className="sky-control-compact" aria-pressed={lowPower} onClick={toggleLowPower} aria-label={words.lowPower} title={words.lowPowerHint}><span aria-hidden="true">◐</span><span>{words.lowPower}</span></button>
      {status !== "fallback" && <button ref={worldToggleRef} type="button" className="sky-control-compact sky-world-toggle" aria-haspopup="dialog" aria-label={sky.world} aria-expanded={worldPanel} aria-controls={worldPanel ? worldPanelId : undefined} onClick={() => showPanel("world")} title={sky.worldTitle}><span aria-hidden="true">{WEATHER_GLYPHS[info?.weather ?? "auto"]}</span><span>{sky.world}</span></button>}
      <button type="button" aria-expanded={navigation} onClick={() => showPanel("navigation")}>{navigation ? words.collapse : words.browse}<span aria-hidden="true">{navigation ? "−" : "+"}</span></button>
      </>}
      <button type="button" aria-pressed={!sceneOn} onClick={() => setSkySceneEnabled(!sceneOn)} title={words.sceneHint}><span aria-hidden="true">{sceneOn ? "▦" : "◒"}</span><span>{sceneOn ? words.sceneOff : words.sceneOn}</span></button>
    </div>
    {worldPanel && threeD && status !== "fallback" && <div className="sky-world-panel" id={worldPanelId} role="dialog" aria-label={sky.worldTitle} ref={worldPanelRef}
      style={worldPanelTop === null ? undefined : { top: worldPanelTop, maxHeight: `calc(100% - ${worldPanelTop + 110}px)` }}>
      <h3 id={`${worldPanelId}-weather`}>{sky.weather}</h3>
      <div className="sky-weather-options" role="radiogroup" aria-labelledby={`${worldPanelId}-weather`} onKeyDown={onWeatherKey}>
        {WEATHER_OPTIONS.map(kind => {
          const disabled = !weatherAvailable(kind);
          const name = kind === "auto" ? (weatherSetting === "auto" && weatherName ? sky.autoNow(weatherName) : sky.auto) : sky.weathers[kind];
          return <button key={kind} type="button" role="radio" data-weather={kind} aria-checked={weatherSetting === kind} tabIndex={kind === weatherFocus ? 0 : -1}
            disabled={disabled} title={disabled ? sky.auroraNight : name} className={kind === "auto" ? "is-auto" : undefined} onClick={() => chooseWeather(kind)}>
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
    <div className="sky-scene-host" ref={host} data-sleeping={asleep ? "1" : undefined}>
      {still && threeD && status !== "fallback" && <img className="sky-world-still" src={still} alt="" aria-hidden="true" draggable={false} />}
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
          {climate && <em className="sky-island-climate" aria-hidden="true"><i style={{ background: CLIMATES[info!.climates[island.id]].swatch }} />{climate}</em>}
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
      : !islands.length ? <div className="sky-empty"><h3>{sky.empty}</h3><p>{sky.emptyHint}</p><button type="button" onClick={() => (onAdd ? onAdd() : open("all"))}>{onAdd ? sky.addSource : sky.openLibrary}</button></div>
      : status === "loading" && !still ? <div className="sky-loading" role="status">{words.loading}</div>
      : rerolling ? <div className="sky-loading" role="status">{sky.rerolling}</div> : null}
    {islands.length > 0 && status !== "off" && <footer className="sky-caption"><span>{sky.basis}</span><span>{words.hint}<button type="button" className="sky-credits-toggle" aria-expanded={credits} onClick={() => showPanel("credits")}>{words.credits}</button></span></footer>}
    {credits && <aside className="sky-credits" aria-label={words.creditsTitle}>
      <header><strong>{words.creditsTitle}</strong><button type="button" onClick={() => setCredits(false)} aria-label={words.close}>×</button></header>
      <ul>{ASSET_CREDITS.map(item => <li key={item.work}><span>{item.work}</span><small>{item.author} · {item.licence}</small></li>)}</ul>
      <p>{words.creditsOriginal}</p>
    </aside>}
  </section>;
}
