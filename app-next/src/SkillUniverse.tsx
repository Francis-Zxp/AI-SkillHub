import {
  type CSSProperties,
  type PointerEvent,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { Icon } from "./icons";
import { categoryName, getLang, t } from "./i18n";
import { localizedSkillDescription } from "./localizedDescriptions";
import { sourcePresentation } from "./sourceIdentity";
import "./SkillUniverse.css";
import type { LegacySnapshot, SkillCard, SourceCard, SourcePopularityCard } from "./types";

export type SkillUniverseMode = "relations" | "sources" | "categories";

type Point3 = { x: number; y: number; z: number };
type UniverseNodeKind = "source" | "router" | "skill";
type UniverseEdgeKind = "parent" | "category" | "conflict";

type UniverseNode = {
  category: string;
  childCount: number;
  description: string;
  enabled: boolean;
  health: string;
  hue: number;
  id: string;
  kind: UniverseNodeKind;
  label: string;
  positions: Record<SkillUniverseMode, Point3>;
  rating: number;
  seed: number;
  skill?: SkillCard;
  source?: SourceCard;
  sourceId: string;
  sourceName: string;
  /** Repository owner, shown after the project name and de-emphasised. */
  owner?: string;
  stars: number;
};

type UniverseEdge = { from: string; kind: UniverseEdgeKind; to: string };
type UniverseTone = "biolume" | "mist" | "parchment" | "prism" | "sky";
type UniverseLod = 0 | 1 | 2;
type UniverseNodeFocus = "active" | "selected" | "neighbor" | "muted" | "normal";
type UniverseModel = {
  categories: Array<{ category: string; count: number; hue: number }>;
  edges: UniverseEdge[];
  neighbors: Map<string, Set<string>>;
  nodes: UniverseNode[];
  parentEdges: number;
  relationEdges: number;
  skillCount: number;
  sourceCount: number;
};
type ProjectedNode = UniverseNode & {
  depth: number;
  radius: number;
  rendered: boolean;
  screenX: number;
  screenY: number;
};
type UniverseRuntime = {
  centerX: number;
  centerY: number;
  dragged: boolean;
  dragging: boolean;
  dragStartX: number;
  dragStartY: number;
  drawnEdges: number;
  drawMs: number;
  hoverId: string;
  selectedId: string;
  /** Screen areas covered by HTML controls; labels are not drawn there. */
  obstacles: Array<{ left: number; top: number; right: number; bottom: number }>;
  refreshObstacles: () => void;
  pointerX: number;
  pointerY: number;
  pointerInside: boolean;
  positions: Map<string, Point3>;
  projectedById: Map<string, ProjectedNode>;
  projected: ProjectedNode[];
  frameIndex: number;
  frameMs: number;
  frameSamples: number[];
  interactionUntil: number;
  lastFrame: number;
  lastPointerTime: number;
  lod: UniverseLod;
  quality: number;
  renderedNodes: number;
  requestDraw: () => void;
  rotationX: number;
  rotationY: number;
  velocityX: number;
  velocityY: number;
  targetZoom: number;
  zoom: number;
};

export type SkillUniverseProps = {
  centered: boolean;
  lightTheme: boolean;
  mode?: SkillUniverseMode;
  onModeChange?: (mode: SkillUniverseMode) => void;
  onOpenSkill: (skill: SkillCard) => void;
  onOpenSource: (source: SourceCard) => void;
  snapshot: LegacySnapshot | null;
  tone: UniverseTone;
};

const MODES: SkillUniverseMode[] = ["relations", "sources", "categories"];
const POSITION_MODES: Record<SkillUniverseMode, SkillUniverseMode> = {
  relations: "relations",
  sources: "sources",
  categories: "categories"
};

// A quiet, fixed star field (screen-relative) and three great circles of the
// celestial sphere replace the old aura, dust and meteors: the data carries
// the colour, the backdrop only gives depth and orientation.
const STAR_FIELD = Array.from({ length: 170 }, (_, index) => {
  const seed = stableHash(`universe-star:${index}`);
  return {
    x: (seed % 10_007) / 10_007,
    y: ((seed >>> 7) % 9_973) / 9_973,
    size: 0.6 + ((seed >>> 3) % 100) / 100,
    alpha: 0.1 + ((seed >>> 13) % 100) / 300,
    twinkle: seed % 9 === 0
  };
});
// Count, size, angle and timing differ every session; none repeats a path.
const METEOR_SESSION_SEED = randomSessionSeed();
const METEORS = Array.from({ length: 4 + (METEOR_SESSION_SEED % 9) }, (_, index) => {
  const seed = stableHash(`universe-meteor:${METEOR_SESSION_SEED}:${index}`);
  return {
    delay: (seed % 10_000) / 10_000,
    duration: 0.05 + ((seed >>> 4) % 60) / 1000,
    direction: ((seed >>> 6) & 1) === 0 ? 1 : -1,
    slope: 0.25 + ((seed >>> 16) % 50) / 100,
    head: 0.6 + ((seed >>> 8) % 14) / 10,
    length: 30 + ((seed >>> 10) % 90),
    width: 0.5 + ((seed >>> 20) % 10) / 10,
    opacity: 0.35 + ((seed >>> 13) % 40) / 100,
    x: 0.1 + ((seed >>> 14) % 80) / 100,
    y: 0.05 + ((seed >>> 18) % 50) / 100
  };
});
const GREAT_CIRCLES: Array<[Point3, Point3]> = [
  [{ x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }],
  [{ x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 1 }],
  [{ x: 0.5, y: 0, z: -0.866 }, { x: 0, y: 1, z: 0 }]
];
const UNIVERSE_CACHE_KEY = "ai-skillhub-universe-cache-v2";

export function SkillUniverse({
  centered,
  lightTheme,
  mode: controlledMode,
  onModeChange,
  onOpenSkill,
  onOpenSource,
  snapshot,
  tone
}: SkillUniverseProps) {
  const [internalMode, setInternalMode] = useState<SkillUniverseMode>("relations");
  const [hovered, setHovered] = useState<UniverseNode | null>(null);
  const [selected, setSelected] = useState<UniverseNode | null>(null);
  const shown = hovered ?? selected;
  const mode = controlledMode ?? internalMode;
  const modeRef = useRef(mode);
  const centeredRef = useRef(centered);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const runtimeRef = useRef<UniverseRuntime | null>(null);
  const hoverRef = useRef("");
  const cachedModelRef = useRef<UniverseModel | null>(readUniverseModelCache());
  const [promotingCache, setPromotingCache] = useState(false);
  const liveModel = useMemo(() => snapshot ? buildUniverseModel(snapshot) : null, [snapshot]);
  const model = liveModel ?? cachedModelRef.current ?? emptyUniverseModel();
  const showingCachedModel = !snapshot && Boolean(cachedModelRef.current);
  modeRef.current = mode;
  centeredRef.current = centered;

  useEffect(() => {
    if (!liveModel) return;
    writeUniverseModelCache(liveModel);
    if (!cachedModelRef.current) return;
    setPromotingCache(true);
    const timer = window.setTimeout(() => setPromotingCache(false), 900);
    return () => window.clearTimeout(timer);
  }, [liveModel]);

  const selectMode = (next: SkillUniverseMode) => {
    if (controlledMode === undefined) setInternalMode(next);
    onModeChange?.(next);
    runtimeRef.current?.requestDraw();
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    const host = canvas?.parentElement;
    if (!canvas || !host) return;
    const context = canvas.getContext("2d", { alpha: true });
    if (!context) {
      canvas.dataset.renderer = "canvas2d-unavailable";
      canvas.dataset.contextState = "unavailable";
      return;
    }

    const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    let reducedMotion = motionQuery.matches;
    const projected = model.nodes.map(node => ({
      ...node,
      depth: 0,
      radius: 0,
      rendered: false,
      screenX: 0,
      screenY: 0
    }));
    const runtime: UniverseRuntime = {
      centerX: 0,
      centerY: 0,
      dragged: false,
      dragging: false,
      dragStartX: 0,
      dragStartY: 0,
      drawnEdges: 0,
      drawMs: 0,
      hoverId: "",
      selectedId: "",
      obstacles: [],
      refreshObstacles: () => undefined,
      frameIndex: 0,
      frameMs: 16.7,
      frameSamples: [],
      interactionUntil: 0,
      lastFrame: 0,
      lastPointerTime: 0,
      lod: 0,
      pointerX: 0,
      pointerY: 0,
      pointerInside: false,
      positions: new Map(model.nodes.map(node => [node.id, { ...node.positions[modeRef.current] }])),
      projected,
      projectedById: new Map(projected.map(node => [node.id, node])),
      quality: 1,
      renderedNodes: 0,
      requestDraw: () => undefined,
      rotationX: -0.12,
      rotationY: 0.42,
      targetZoom: 1,
      velocityX: 0,
      velocityY: 0,
      zoom: 1
    };
    runtimeRef.current = runtime;
    setSelected(null);

    let frame = 0;
    let frameTimer = 0;
    let lastDrawAt = 0;
    let pageVisible = !document.hidden;
    let focused = document.hasFocus();
    let intersecting = host.getClientRects().length > 0;
    let contextReady = true;
    let width = 1;
    let height = 1;
    let dpr = 1;

    canvas.dataset.renderer = "canvas2d";
    canvas.dataset.contextState = "ready";
    canvas.dataset.nodeCount = String(model.nodes.length);
    canvas.dataset.nodeShape = "screen-space-circles";

    const cancelScheduledDraw = () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(frameTimer);
      frame = 0;
      frameTimer = 0;
    };

    const canRender = () => pageVisible && intersecting && contextReady;
    const hasInteractiveMotion = () => {
      const now = performance.now();
      return runtime.dragging ||
        now < runtime.interactionUntil ||
        Math.abs(runtime.velocityX) > 0.00004 ||
        Math.abs(runtime.velocityY) > 0.00004 ||
        Math.abs(runtime.targetZoom - runtime.zoom) > 0.001;
    };

    const scheduleDraw = (urgent = false) => {
      if (!canRender() || !focused || frame) return;
      if (reducedMotion && !urgent) return;
      const interactiveMotion = hasInteractiveMotion();
      if (frameTimer) {
        if (!urgent) return;
        window.clearTimeout(frameTimer);
        frameTimer = 0;
      }
      // Keep the homepage smooth on a healthy renderer, then reduce only the
      // background cadence when this device's actual draw cost needs it.
      // Interaction remains immediate at 60 fps; non-home pages unmount this
      // component, and visibility/focus guards above cancel all idle work.
      const ambientInterval = runtime.drawMs > 18 ? 1000 / 20 : runtime.drawMs > 12 ? 1000 / 28 : 1000 / 36;
      const interval = interactiveMotion ? 1000 / 60 : ambientInterval;
      const wait = urgent ? 0 : Math.max(0, interval - (performance.now() - lastDrawAt));
      if (wait <= 1) {
        frame = window.requestAnimationFrame(draw);
        return;
      }
      frameTimer = window.setTimeout(() => {
        frameTimer = 0;
        if (canRender() && focused) frame = window.requestAnimationFrame(draw);
      }, wait);
    };

    const refreshObstacles = () => {
      const origin = canvas.getBoundingClientRect();
      const scope = host.closest(".dashboard-hero") ?? host;
      const overlays = [
        ...scope.querySelectorAll(".skill-universe-modes, .atlas-intro-toggle, .atlas-immersive-toggle, .home-visual-switch, .atlas-hero-copy, .skill-universe-counter, .skill-universe-legend, .skill-universe-help"),
        ...document.querySelectorAll(".atlas-touchbar")
      ];
      runtime.obstacles = overlays
        .map(element => element.getBoundingClientRect())
        .filter(rect => rect.width > 0 && rect.height > 0)
        .map(rect => ({ left: rect.left - origin.left, top: rect.top - origin.top, right: rect.right - origin.left, bottom: rect.bottom - origin.top }));
    };
    runtime.refreshObstacles = refreshObstacles;

    const resize = () => {
      const rect = host.getBoundingClientRect();
      width = Math.max(1, Math.floor(rect.width));
      height = Math.max(1, Math.floor(rect.height));
      // Preserve native 4K detail (8.3M pixels). Adaptive frame rate / LOD already
      // bound animation cost; a 1.7M backing store blurred every large display.
      const pixelBudgetScale = Math.sqrt(16_777_216 / Math.max(1, width * height));
      dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, pixelBudgetScale));
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      canvas.dataset.renderScale = String(dpr);
      refreshObstacles();
      scheduleDraw(true);
    };

    const draw = (time: number) => {
      frame = 0;
      if (!canRender()) return;
      const animationTime = reducedMotion || !focused ? 0 : time;
      const drawStarted = performance.now();
      context.clearRect(0, 0, width, height);
      drawUniverse(
        context,
        model,
        runtime,
        modeRef.current,
        width,
        height,
        animationTime,
        centeredRef.current,
        lightTheme,
        tone
      );
      lastDrawAt = time;
      const drawDuration = performance.now() - drawStarted;
      runtime.drawMs = runtime.drawMs ? runtime.drawMs * 0.86 + drawDuration * 0.14 : drawDuration;
      if (animationTime > 0) {
        runtime.frameSamples.push(runtime.frameMs);
        if (runtime.frameSamples.length > 90) runtime.frameSamples.shift();
      }
      if (reducedMotion || runtime.frameIndex % 30 === 0) updateUniverseDiagnostics(canvas, runtime);
      if (!reducedMotion && focused) scheduleDraw();
    };
    runtime.requestDraw = () => scheduleDraw(true);

    const onVisibility = () => {
      pageVisible = !document.hidden;
      cancelScheduledDraw();
      runtime.lastFrame = 0;
      if (pageVisible) scheduleDraw(true);
    };

    const onFocus = () => {
      focused = true;
      runtime.lastFrame = 0;
      lastDrawAt = 0;
      scheduleDraw(true);
    };

    const onBlur = () => {
      focused = false;
      cancelScheduledDraw();
    };

    const onMotionPreference = (event: MediaQueryListEvent) => {
      reducedMotion = event.matches;
      runtime.lastFrame = 0;
      cancelScheduledDraw();
      scheduleDraw(true);
    };

    const onContextLost = (event: Event) => {
      event.preventDefault();
      canvas.dataset.contextState = "lost";
      contextReady = false;
      cancelScheduledDraw();
    };

    const onContextRestored = () => {
      canvas.dataset.contextState = "ready";
      contextReady = true;
      pageVisible = !document.hidden;
      resize();
      scheduleDraw(true);
    };

    const observer = new ResizeObserver(resize);
    observer.observe(host);
    // Moving a window between monitors can change DPR without changing its CSS
    // size. Re-arm the query after each change to keep the backing store sharp.
    let resolutionQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    const onResolutionChange = () => {
      resolutionQuery.removeEventListener("change", onResolutionChange);
      resolutionQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
      resolutionQuery.addEventListener("change", onResolutionChange);
      resize();
    };
    resolutionQuery.addEventListener("change", onResolutionChange);
    const intersectionObserver = new IntersectionObserver(entries => {
      intersecting = entries.some(entry => entry.isIntersecting);
      cancelScheduledDraw();
      runtime.lastFrame = 0;
      if (intersecting) scheduleDraw(true);
    });
    intersectionObserver.observe(host);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    motionQuery.addEventListener("change", onMotionPreference);
    canvas.addEventListener("contextlost", onContextLost);
    canvas.addEventListener("contextrestored", onContextRestored);
    resize();
    scheduleDraw(true);

    return () => {
      observer.disconnect();
      resolutionQuery.removeEventListener("change", onResolutionChange);
      intersectionObserver.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
      motionQuery.removeEventListener("change", onMotionPreference);
      canvas.removeEventListener("contextlost", onContextLost);
      canvas.removeEventListener("contextrestored", onContextRestored);
      cancelScheduledDraw();
      if (runtimeRef.current === runtime) runtimeRef.current = null;
    };
  }, [lightTheme, model, tone]);

  useEffect(() => {
    if (runtimeRef.current) runtimeRef.current.interactionUntil = performance.now() + 420;
    runtimeRef.current?.requestDraw();
    // Controls move when the intro collapses; re-measure after layout settles.
    const timer = window.setTimeout(() => {
      runtimeRef.current?.refreshObstacles();
      runtimeRef.current?.requestDraw();
    }, 450);
    return () => window.clearTimeout(timer);
  }, [centered, mode]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wheelSurface = canvas?.closest<HTMLElement>(".dashboard-view");
    if (!wheelSurface) return;

    const onWheel = (event: globalThis.WheelEvent) => {
      const runtime = runtimeRef.current;
      if (!runtime) return;
      event.preventDefault();
      event.stopPropagation();
      const deltaScale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? window.innerHeight : 1;
      runtime.targetZoom = clamp(runtime.targetZoom * Math.exp(-event.deltaY * deltaScale * 0.001), 0.72, 1.5);
      runtime.interactionUntil = performance.now() + 240;
      runtime.requestDraw();
    };

    wheelSurface.addEventListener("wheel", onWheel, { passive: false });
    return () => wheelSurface.removeEventListener("wheel", onWheel);
  }, []);

  const updateHover = (node: ProjectedNode | null) => {
    const nextId = node?.id ?? "";
    if (nextId === hoverRef.current) return;
    hoverRef.current = nextId;
    setHovered(node);
  };

  const movePointer = (event: PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    const runtime = runtimeRef.current;
    if (!canvas || !runtime) return;
    const rect = canvas.getBoundingClientRect();
    runtime.pointerX = event.clientX - rect.left;
    runtime.pointerY = event.clientY - rect.top;
    runtime.pointerInside = true;

    if (runtime.dragging) {
      const dx = event.movementX;
      const dy = event.movementY;
      const now = performance.now();
      const elapsed = Math.max(8, now - runtime.lastPointerTime);
      runtime.rotationY = wrapAngle(runtime.rotationY + dx * 0.0048);
      runtime.rotationX = wrapAngle(runtime.rotationX + dy * 0.004);
      runtime.velocityY = clamp((dx * 0.0048) / elapsed, -0.004, 0.004);
      runtime.velocityX = clamp((dy * 0.004) / elapsed, -0.003, 0.003);
      runtime.lastPointerTime = now;
      runtime.interactionUntil = now + 180;
      runtime.dragged ||= Math.abs(runtime.pointerX - runtime.dragStartX) + Math.abs(runtime.pointerY - runtime.dragStartY) > 5;
      runtime.hoverId = "";
      canvas.style.cursor = "grabbing";
      updateHover(null);
      runtime.requestDraw();
      return;
    }

    const hit = findHit(runtime, runtime.pointerX, runtime.pointerY);
    runtime.hoverId = hit?.id ?? "";
    canvas.style.cursor = hit ? "pointer" : "grab";
    updateHover(hit);
    runtime.requestDraw();
  };

  const startDrag = (event: PointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0) return;
    const canvas = canvasRef.current;
    const runtime = runtimeRef.current;
    if (!canvas || !runtime) return;
    const rect = canvas.getBoundingClientRect();
    runtime.pointerX = event.clientX - rect.left;
    runtime.pointerY = event.clientY - rect.top;
    runtime.dragStartX = runtime.pointerX;
    runtime.dragStartY = runtime.pointerY;
    runtime.dragged = false;
    runtime.dragging = true;
    runtime.hoverId = "";
    runtime.lastPointerTime = performance.now();
    runtime.interactionUntil = runtime.lastPointerTime + 180;
    canvas.style.cursor = "grabbing";
    runtime.requestDraw();
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const endDrag = (event: PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    const runtime = runtimeRef.current;
    if (!canvas || !runtime) return;
    runtime.dragging = false;
    runtime.dragged = false;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    const hit = findHit(runtime, runtime.pointerX, runtime.pointerY);
    canvas.style.cursor = hit ? "pointer" : "grab";
    runtime.hoverId = hit?.id ?? "";
    updateHover(hit);
    runtime.requestDraw();
  };

  const leaveGraph = () => {
    const runtime = runtimeRef.current;
    if (runtime) runtime.pointerInside = false;
    if (!runtime?.dragging) {
      if (runtime) runtime.hoverId = "";
      updateHover(null);
      runtime?.requestDraw();
    }
  };

  // One click selects (the node, its links and names stay highlighted); a
  // click on empty space clears; a double click opens.
  const selectNode = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    const runtime = runtimeRef.current;
    if (!canvas || !runtime || runtime.dragged) return;
    const rect = canvas.getBoundingClientRect();
    const hit = findHit(runtime, event.clientX - rect.left, event.clientY - rect.top);
    const next = hit ?? null;
    runtime.selectedId = next?.id ?? "";
    setSelected(next);
    runtime.requestDraw();
  };

  const openNode = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    const runtime = runtimeRef.current;
    if (!canvas || !runtime || runtime.dragged) return;
    const rect = canvas.getBoundingClientRect();
    const hit = findHit(runtime, event.clientX - rect.left, event.clientY - rect.top);
    if (hit?.skill) onOpenSkill(hit.skill);
    else if (hit?.source) onOpenSource(hit.source);
  };

  return (
    <div
      className={`skill-universe${centered ? " is-centered" : ""}${promotingCache ? " is-promoting-cache" : ""}`}
      data-universe-state={snapshot ? "live" : showingCachedModel ? "cached" : "empty"}
      style={{ "--universe-hue": shown?.hue ?? 178 } as CSSProperties}
    >
      <canvas
        aria-label={t("universe.aria", { skills: model.skillCount, sources: model.sourceCount })}
        className="skill-universe-canvas"
        onClick={selectNode}
        onDoubleClick={openNode}
        onPointerCancel={endDrag}
        onPointerDown={startDrag}
        onPointerLeave={leaveGraph}
        onPointerMove={movePointer}
        onPointerUp={endDrag}
        ref={canvasRef}
        role="img"
      />

      <div className="skill-universe-modes" aria-label={t("universe.modeLabel")}>
        {MODES.map(item => (
          <button
            aria-pressed={mode === item}
            className={mode === item ? "active" : ""}
            key={item}
            onClick={() => selectMode(item)}
            type="button"
          >
            {t(`universe.mode.${item}`)}
          </button>
        ))}
      </div>

      <div className="skill-universe-counter" aria-hidden="true">
        <strong>{model.skillCount.toLocaleString()}</strong>
        <span>{t("universe.realNodes")}</span>
        <small>{model.parentEdges.toLocaleString()} {t("universe.parentLinks")} · {model.relationEdges.toLocaleString()} {t("universe.relatedLinks")}</small>
      </div>

      <div className="skill-universe-legend" aria-label={t("universe.legend")}>
        {model.categories.slice(0, 5).map(item => (
          <span key={item.category} style={{ "--node-hue": item.hue } as CSSProperties}>
            <i /> {displayCategory(item.category)} <b>{item.count}</b>
          </span>
        ))}
      </div>

      {shown && (
        <aside className="skill-universe-inspector" aria-live="polite">
          <header>
            <i />
            <span>{nodeKindLabel(shown.kind)}</span>
            <b>{displayCategory(shown.category)}</b>
          </header>
          <strong>{shown.kind === "skill" || shown.kind === "router" ? `/${shown.label}` : shown.label}</strong>
          <p>{shown.description || t("universe.noDescription")}</p>
          <dl>
            <div><dt>{t("universe.source")}</dt><dd>{shown.sourceName}</dd></div>
            {shown.kind === "source" ? (
              <>
                <div><dt>GitHub</dt><dd>★ {shown.stars.toLocaleString()}</dd></div>
                <div><dt>{t("universe.children")}</dt><dd>{shown.childCount}</dd></div>
              </>
            ) : (
              <>
                <div><dt>{t("universe.myRating")}</dt><dd>{shown.rating ? `${shown.rating} / 5` : t("universe.unrated")}</dd></div>
                <div><dt>{t("universe.health")}</dt><dd>{shown.health}</dd></div>
              </>
            )}
          </dl>
          <span className="skill-universe-open"><Icon name="library" /> {t("universe.doubleClick")}</span>
        </aside>
      )}

      <span className="skill-universe-help"><i /> {t("universe.help")}</span>
    </div>
  );
}

function buildUniverseModel(snapshot: LegacySnapshot | null): UniverseModel {
  const skills = snapshot?.skills ?? [];
  const visibleSources = snapshot?.sources ?? [];
  const popularity = snapshot?.sourcePopularity ?? [];
  const popularityBySource = popularityLookup(popularity);
  const sourceLookup = new Map<string, SourceCard>();
  visibleSources.forEach(source => {
    sourceLookup.set(normalize(source.name), source);
    sourceLookup.set(normalize(source.id), source);
    const repo = source.url.split("/").pop()?.replace(/\.git$/i, "");
    if (repo) sourceLookup.set(normalize(repo), source);
  });

  const skillsBySource = new Map<string, SkillCard[]>();
  const unresolved: SkillCard[] = [];
  for (const skill of skills) {
    const source = resolveSource(skill, sourceLookup, visibleSources);
    if (!source) {
      unresolved.push(skill);
      continue;
    }
    skillsBySource.set(source.id, [...(skillsBySource.get(source.id) ?? []), skill]);
  }

  const sources = [...visibleSources];
  if (unresolved.length) {
    const localSource: SourceCard = {
      id: "local-unmanaged",
      name: t("universe.localSource"),
      sourceType: "mixed",
      health: "info",
      url: "",
      skillCount: unresolved.length,
      mode: "local",
      categoryId: "general",
      note: t("universe.localDescription"),
      localPath: "",
      enabled: true,
      tags: [],
      createdAt: ""
    };
    sources.push(localSource);
    skillsBySource.set(localSource.id, unresolved);
  }

  sources.sort((left, right) => {
    const leftHeat = popularityFor(left, popularityBySource)?.stars ?? 0;
    const rightHeat = popularityFor(right, popularityBySource)?.stars ?? 0;
    return rightHeat - leftHeat || (skillsBySource.get(right.id)?.length ?? 0) - (skillsBySource.get(left.id)?.length ?? 0);
  });

  const categoryCounts = new Map<string, number>();
  skills.forEach(skill => categoryCounts.set(skillCategory(skill), (categoryCounts.get(skillCategory(skill)) ?? 0) + 1));
  const categoryOrder = [...categoryCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([category]) => category);
  const categoryCenters = new Map(categoryOrder.map((category, index) => [category, fibonacciPoint(index, Math.max(categoryOrder.length, 1), 0.78)]));
  const sourceCenters = new Map(sources.map((source, index) => [source.id, fibonacciPoint(index, Math.max(sources.length, 1), 0.79)]));
  const nodes: UniverseNode[] = [];
  const edges: UniverseEdge[] = [];
  const skillNodeByIdentity = new Map<string, UniverseNode>();
  const categoryNodes = new Map<string, UniverseNode[]>();

  for (const source of sources) {
    const sourceSkills = (skillsBySource.get(source.id) ?? []).sort((a, b) => a.name.localeCompare(b.name));
    const sourceCenter = sourceCenters.get(source.id) ?? { x: 0, y: 0, z: 0 };
    const sourcePopularity = popularityFor(source, popularityBySource);
    const dominantCategory = dominantSkillCategory(sourceSkills, source.categoryId);
    const sourceCategoryCenter = categoryCenters.get(dominantCategory) ?? sourceCenter;
    const sourceNode: UniverseNode = {
      category: dominantCategory,
      childCount: sourceSkills.filter(skill => !isRouter(skill)).length,
      description: source.note || source.url || t("universe.sourceDescription"),
      enabled: source.enabled,
      health: source.health,
      hue: clusterHue(dominantCategory, source.id),
      id: `source:${source.id}`,
      kind: "source",
      label: sourcePresentation(source).title,
      owner: sourcePresentation(source).owner,
      positions: {
        sources: sourceCenter,
        categories: scalePoint(sourceCategoryCenter, 0.88),
        relations: normalizePoint(mixPoint(sourceCenter, sourceCategoryCenter, 0.22), 0.82)
      },
      rating: 0,
      seed: stableHash(source.id),
      source,
      sourceId: source.id,
      sourceName: sourcePresentation(source).title,
      stars: sourcePopularity?.stars ?? 0
    };
    nodes.push(sourceNode);

    const router = sourceSkills.find(skill => isRouter(skill));
    let routerNode: UniverseNode | undefined;
    if (router) {
      routerNode = createSkillNode(router, source, sourceCenter, categoryCenters, 0, sourceSkills.length, true);
      nodes.push(routerNode);
      edges.push({ from: sourceNode.id, kind: "parent", to: routerNode.id });
      indexSkillNode(routerNode, skillNodeByIdentity, categoryNodes);
    }

    const children = sourceSkills.filter(skill => skill !== router);
    children.forEach((skill, index) => {
      const node = createSkillNode(skill, source, sourceCenter, categoryCenters, index, children.length, false);
      nodes.push(node);
      edges.push({ from: routerNode?.id ?? sourceNode.id, kind: "parent", to: node.id });
      indexSkillNode(node, skillNodeByIdentity, categoryNodes);
    });
  }

  for (const bucket of categoryNodes.values()) {
    const ordered = bucket.sort((a, b) => a.sourceId.localeCompare(b.sourceId) || a.label.localeCompare(b.label));
    for (let index = 1; index < ordered.length; index += Math.max(1, Math.ceil(ordered.length / 18))) {
      const previous = ordered[Math.max(0, index - 1)];
      const current = ordered[index];
      edges.push({ from: previous.id, kind: "category", to: current.id });
    }
  }

  for (const conflict of snapshot?.skillConflicts ?? []) {
    const candidates = conflict.choices
      .map(choice => skillNodeByIdentity.get(normalize(`${choice.sourceName}:${choice.skillName}`)))
      .filter((node): node is UniverseNode => Boolean(node));
    for (let index = 1; index < candidates.length; index += 1) {
      edges.push({ from: candidates[index - 1].id, kind: "conflict", to: candidates[index].id });
    }
  }

  const parentEdges = edges.filter(edge => edge.kind === "parent").length;
  const neighbors = new Map<string, Set<string>>();
  for (const edge of edges) {
    const fromNeighbors = neighbors.get(edge.from) ?? new Set<string>();
    const toNeighbors = neighbors.get(edge.to) ?? new Set<string>();
    fromNeighbors.add(edge.to);
    toNeighbors.add(edge.from);
    neighbors.set(edge.from, fromNeighbors);
    neighbors.set(edge.to, toNeighbors);
  }
  return {
    categories: [...categoryCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([category, count]) => ({ category, count, hue: categoryHue(category) })),
    edges,
    neighbors,
    nodes,
    parentEdges,
    relationEdges: edges.length - parentEdges,
    skillCount: skills.length,
    sourceCount: sources.length
  };
}

function createSkillNode(
  skill: SkillCard,
  source: SourceCard,
  sourceCenter: Point3,
  categoryCenters: Map<string, Point3>,
  index: number,
  count: number,
  router: boolean
): UniverseNode {
  const category = skillCategory(skill);
  const categoryCenter = categoryCenters.get(category) ?? sourceCenter;
  const local = localOrbitPoint(stableHash(`${skill.relativePath}:${skill.name}`), index, count);
  const densityRadius = clamp(0.09 + Math.sqrt(Math.max(count, 1)) * 0.009, 0.1, 0.27);
  const sourcePosition = normalizePoint(addPoint(scalePoint(sourceCenter, 0.82), scalePoint(local, router ? 0.035 : densityRadius)), router ? 0.78 : 0.8 + (index % 5) * 0.025);
  const categoryPosition = normalizePoint(addPoint(scalePoint(categoryCenter, 0.84), scalePoint(local, router ? 0.045 : densityRadius * 1.08)), router ? 0.78 : 0.83);
  const relationPosition = normalizePoint(mixPoint(sourcePosition, categoryPosition, 0.34), router ? 0.76 : 0.84);
  return {
    category,
    childCount: 0,
    description: localizedSkillDescription(skill, getLang()),
    enabled: skill.enabled,
    health: skill.health,
    hue: clusterHue(category, source.id),
    id: `${router ? "router" : "skill"}:${source.id}:${skill.folderName}:${skill.relativePath}`,
    kind: router ? "router" : "skill",
    label: skill.name,
    positions: { sources: sourcePosition, categories: categoryPosition, relations: relationPosition },
    rating: skill.rating ?? 0,
    seed: stableHash(`${skill.folderName}:${skill.relativePath}`),
    skill,
    source,
    sourceId: source.id,
    sourceName: sourcePresentation(source).title,
    stars: 0
  };
}

function indexSkillNode(
  node: UniverseNode,
  skillNodeByIdentity: Map<string, UniverseNode>,
  categoryNodes: Map<string, UniverseNode[]>
) {
  if (!node.skill) return;
  skillNodeByIdentity.set(normalize(`${node.sourceName}:${node.skill.name}`), node);
  categoryNodes.set(node.category, [...(categoryNodes.get(node.category) ?? []), node]);
}

function drawUniverse(
  context: CanvasRenderingContext2D,
  model: UniverseModel,
  runtime: UniverseRuntime,
  mode: SkillUniverseMode,
  width: number,
  height: number,
  time: number,
  centered: boolean,
  lightTheme: boolean,
  tone: UniverseTone
) {
  let elapsed = 16.7;
  if (time > 0) {
    elapsed = runtime.lastFrame > 0 ? Math.min(48, Math.max(1, time - runtime.lastFrame)) : 16.7;
    runtime.frameMs = runtime.frameMs * 0.92 + elapsed * 0.08;
    runtime.frameIndex += 1;
    if (runtime.frameIndex % 30 === 0) {
      const targetQuality = runtime.drawMs > 18 ? 0.58 : runtime.drawMs > 12 ? 0.78 : 1;
      runtime.quality += (targetQuality - runtime.quality) * 0.5;
    }
    if (!runtime.dragging) {
      runtime.rotationY = wrapAngle(runtime.rotationY + runtime.velocityY * elapsed);
      runtime.rotationX = wrapAngle(runtime.rotationX + runtime.velocityX * elapsed);
      const drag = Math.exp(-elapsed * 0.0052);
      runtime.velocityX *= drag;
      runtime.velocityY *= drag;
      if (!runtime.pointerInside && Math.abs(runtime.velocityY) < 0.00004) runtime.rotationY += elapsed * 0.000022;
    }
    const zoomEase = 1 - Math.exp(-elapsed / 105);
    runtime.zoom += (runtime.targetZoom - runtime.zoom) * zoomEase;
    runtime.lastFrame = time;
  } else {
    runtime.zoom = runtime.targetZoom;
  }

  const targetCenterX = width * (centered ? 0.505 : width < 850 ? 0.56 : 0.67);
  const targetCenterY = height * (centered ? 0.47 : 0.49);
  if (!runtime.centerX || time === 0) {
    runtime.centerX = targetCenterX;
    runtime.centerY = targetCenterY;
  } else {
    const centerEase = 1 - Math.exp(-elapsed / 260);
    runtime.centerX += (targetCenterX - runtime.centerX) * centerEase;
    runtime.centerY += (targetCenterY - runtime.centerY) * centerEase;
  }
  const centerX = runtime.centerX;
  const centerY = runtime.centerY;
  const radiusFactor = centered ? (width < 850 ? 0.53 : 0.43) : (width < 850 ? 0.5 : 0.39);
  const radius = Math.min(width * radiusFactor, height * (centered ? 0.57 : 0.52), 680) * runtime.zoom;
  const interactive = runtime.dragging || (time > 0 && time < runtime.interactionUntil);
  const lod = resolveUniverseLod(model.nodes.length, runtime.quality, interactive);
  runtime.lod = lod;
  const rotationY = runtime.rotationY;
  const rotationX = runtime.rotationX + (time === 0 ? 0 : Math.sin(time * 0.00009) * 0.025);
  const palette = starPalette(tone, lightTheme);
  const focusId = runtime.hoverId || runtime.selectedId;

  drawUniverseAtmosphere(context, palette, centerX, centerY, radius, width, height, time, rotationX, rotationY, lightTheme);

  const cosX = Math.cos(rotationX);
  const sinX = Math.sin(rotationX);
  const cosY = Math.cos(rotationY);
  const sinY = Math.sin(rotationY);
  const layoutEase = time === 0 ? 1 : 1 - Math.exp(-elapsed / 250);
  for (const node of runtime.projected) {
    const current = runtime.positions.get(node.id) ?? { ...node.positions[mode] };
    const target = node.positions[POSITION_MODES[mode]];
    current.x += (target.x - current.x) * layoutEase;
    current.y += (target.y - current.y) * layoutEase;
    current.z += (target.z - current.z) * layoutEase;
    runtime.positions.set(node.id, current);
    const rotatedY = current.y * cosX - current.z * sinX;
    const rotatedZ0 = current.y * sinX + current.z * cosX;
    const rotatedX = current.x * cosY + rotatedZ0 * sinY;
    const rotatedZ = -current.x * sinY + rotatedZ0 * cosY;
    const perspective = 3.05;
    const scale = perspective / (perspective - rotatedZ);
    node.screenX = centerX + rotatedX * radius * scale;
    node.screenY = centerY + rotatedY * radius * scale;
    node.depth = clamp((rotatedZ + 1.1) / 2.2, 0.08, 1);
    node.radius = nodeRadius(node, scale);
  }

  context.save();
  context.lineCap = "round";
  runtime.drawnEdges = 0;
  for (let edgeIndex = 0; edgeIndex < model.edges.length; edgeIndex += 1) {
    const edge = model.edges[edgeIndex];
    const highlighted = Boolean(focusId && (edge.from === focusId || edge.to === focusId));
    if (focusId ? !highlighted : !edgeVisible(edge.kind, mode)) continue;
    if (!focusId) {
      if (lod === 2 && edge.kind === "category") continue;
      if (lod === 1 && edge.kind === "category" && edgeIndex % 2 === 1) continue;
      if (lod === 2 && edge.kind === "conflict" && edgeIndex % 2 === 1) continue;
      if ((interactive || lod === 2) && edge.kind === "parent" && edgeIndex % 2 === 1) continue;
    }
    const from = runtime.projectedById.get(edge.from);
    const to = runtime.projectedById.get(edge.to);
    if (!from || !to || from.depth < 0.1 || to.depth < 0.1) continue;
    const alpha = edgeAlpha(edge.kind, mode, highlighted) * Math.min(from.depth, to.depth);
    const controlX = (from.screenX + to.screenX) / 2 + (to.screenY - from.screenY) *
      (edge.kind === "parent" ? 0.025 : edge.kind === "conflict" ? 0.085 : 0.05);
    const controlY = (from.screenY + to.screenY) / 2 - (to.screenX - from.screenX) *
      (edge.kind === "parent" ? 0.025 : edge.kind === "conflict" ? 0.085 : 0.05);
    context.beginPath();
    context.moveTo(from.screenX, from.screenY);
    context.quadraticCurveTo(controlX, controlY, to.screenX, to.screenY);
    context.strokeStyle = edge.kind === "conflict"
      ? `${palette.conflict}${alpha})`
      : highlighted
        ? `${palette.edgeHot}${alpha})`
        : palette.edge(to.hue, alpha);
    context.lineWidth = highlighted ? 1.3 : edge.kind === "parent" ? 0.7 : 0.5;
    if (edge.kind === "conflict") context.setLineDash([4, 5]);
    context.stroke();
    context.setLineDash([]);
    runtime.drawnEdges += 1;
  }
  context.restore();

  if (lod < 2 || !interactive || runtime.frameIndex % 2 === 0) {
    runtime.projected.sort((a, b) => a.depth - b.depth);
  }
  const focusNeighbors = focusId ? model.neighbors.get(focusId) : undefined;
  const skillStride = lod === 2 ? Math.max(2, Math.ceil(model.nodes.length / 760)) : 1;
  runtime.renderedNodes = 0;
  for (const node of runtime.projected) {
    node.rendered = false;
    const focus: UniverseNodeFocus = node.id === runtime.hoverId
      ? "active"
      : node.id === runtime.selectedId
        ? "selected"
        : focusNeighbors?.has(node.id)
          ? "neighbor"
          : focusId
            ? "muted"
            : "normal";
    if (node.kind === "skill" && focus !== "active" && focus !== "selected" && focus !== "neighbor" && node.seed % skillStride !== 0) {
      continue;
    }
    node.rendered = true;
    runtime.renderedNodes += 1;
    drawUniverseNode(context, node, focus, palette, lod);
  }
  drawUniverseLabels(context, runtime, palette, width, height, focusId, focusNeighbors, lod, interactive);
}

function drawUniverseAtmosphere(
  context: CanvasRenderingContext2D,
  palette: StarPalette,
  centerX: number,
  centerY: number,
  radius: number,
  width: number,
  height: number,
  time: number,
  rotationX: number,
  rotationY: number,
  lightTheme: boolean
) {
  context.save();
  for (const star of STAR_FIELD) {
    const twinkle = star.twinkle && time > 0 ? 0.55 + 0.45 * Math.sin(time * 0.0011 + star.x * 40) : 1;
    context.fillStyle = `rgba(${palette.star}, ${(star.alpha * twinkle * (lightTheme ? 0.5 : 1)).toFixed(3)})`;
    context.fillRect(star.x * width, star.y * height, star.size, star.size);
  }
  // A soft core inside the sphere gives it volume; the nodes in front of it
  // read brighter, the ones behind recede into it.
  const core = context.createRadialGradient(centerX, centerY, 0, centerX, centerY, radius * 1.05);
  core.addColorStop(0, `${palette.core}${lightTheme ? 0.1 : 0.2})`);
  core.addColorStop(0.45, `${palette.core}${lightTheme ? 0.04 : 0.08})`);
  core.addColorStop(1, `${palette.core}0)`);
  context.fillStyle = core;
  context.beginPath();
  context.arc(centerX, centerY, radius * 1.05, 0, Math.PI * 2);
  context.fill();
  drawUniverseMeteors(context, palette, width, height, time);
  // Three great circles of the celestial sphere, dashed so they never read
  // as data links (which are solid): finer in front, sparser behind.
  const cosX = Math.cos(rotationX), sinX = Math.sin(rotationX);
  const cosY = Math.cos(rotationY), sinY = Math.sin(rotationY);
  context.lineWidth = 0.75;
  for (const [axisA, axisB] of GREAT_CIRCLES) {
    for (const front of [false, true]) {
      context.setLineDash(front ? [3, 5] : [1.5, 7]);
      context.beginPath();
      let drawing = false;
      for (let step = 0; step <= 96; step += 1) {
        const angle = (step / 96) * Math.PI * 2;
        const x = axisA.x * Math.cos(angle) + axisB.x * Math.sin(angle);
        const y = axisA.y * Math.cos(angle) + axisB.y * Math.sin(angle);
        const z = axisA.z * Math.cos(angle) + axisB.z * Math.sin(angle);
        const rotatedY = y * cosX - z * sinX;
        const rotatedZ0 = y * sinX + z * cosX;
        const rotatedX = x * cosY + rotatedZ0 * sinY;
        const rotatedZ = -x * sinY + rotatedZ0 * cosY;
        const scale = 3.05 / (3.05 - rotatedZ);
        const screenX = centerX + rotatedX * radius * scale;
        const screenY = centerY + rotatedY * radius * scale;
        if ((rotatedZ >= 0) === front) {
          if (drawing) context.lineTo(screenX, screenY);
          else context.moveTo(screenX, screenY);
          drawing = true;
        } else {
          drawing = false;
        }
      }
      context.strokeStyle = `${palette.grid}${front ? (lightTheme ? 0.2 : 0.17) : (lightTheme ? 0.07 : 0.055)})`;
      context.stroke();
    }
  }
  context.setLineDash([]);
  context.restore();
}

/** A few meteors per session, each with its own size, angle and timing. */
function drawUniverseMeteors(
  context: CanvasRenderingContext2D,
  palette: StarPalette,
  width: number,
  height: number,
  time: number
) {
  if (time === 0) return;
  context.save();
  context.lineCap = "round";
  for (const meteor of METEORS) {
    const phase = (time * 0.000028 + meteor.delay) % 1;
    if (phase > meteor.duration) continue;
    const progress = phase / meteor.duration;
    const fade = Math.sin(progress * Math.PI);
    const headX = (meteor.x + progress * 0.18 * meteor.direction) * width;
    const headY = (meteor.y + progress * 0.18 * meteor.slope) * height;
    const tailX = headX - meteor.length * meteor.direction;
    const tailY = headY - meteor.length * meteor.slope;
    const trail = context.createLinearGradient(tailX, tailY, headX, headY);
    trail.addColorStop(0, `${palette.meteor}0)`);
    trail.addColorStop(1, `${palette.meteor}${(fade * meteor.opacity).toFixed(3)})`);
    context.strokeStyle = trail;
    context.lineWidth = meteor.width;
    context.beginPath();
    context.moveTo(tailX, tailY);
    context.lineTo(headX, headY);
    context.stroke();
    context.fillStyle = `${palette.meteor}${(fade * meteor.opacity).toFixed(3)})`;
    context.beginPath();
    context.arc(headX, headY, meteor.head, 0, Math.PI * 2);
    context.fill();
  }
  context.restore();
}

function drawUniverseNode(
  context: CanvasRenderingContext2D,
  node: ProjectedNode,
  focus: UniverseNodeFocus,
  palette: StarPalette,
  lod: UniverseLod
) {
  // Flat shapes, one restrained colour per category: sources are discs with
  // a thin orbit, parent Skills are rings, Skills are dots. Depth sets the
  // emphasis; focus states override it.
  const active = focus === "active" || focus === "selected";
  const alpha = focus === "muted"
    ? 0.1
    : active || focus === "neighbor"
      ? 1
      : (0.34 + node.depth * 0.66) * (node.enabled ? 1 : 0.75);
  const radius = node.radius * (active ? 1.12 : 1);
  const { screenX: x, screenY: y } = node;
  // Near nodes carry full colour and light, far nodes fade into the core.
  const depth = active || focus === "neighbor" ? 1 : node.depth;
  const tint = (kind: UniverseNodeKind, value: number) => palette.node(node.hue, kind, value, depth);
  context.save();
  if (!node.enabled) {
    context.beginPath();
    context.arc(x, y, Math.max(1.6, radius), 0, Math.PI * 2);
    context.setLineDash([2, 2]);
    context.strokeStyle = `${palette.muted}${alpha})`;
    context.lineWidth = 1;
    context.stroke();
    context.setLineDash([]);
  } else if (node.kind === "source") {
    context.beginPath();
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.fillStyle = tint("source", alpha);
    context.fill();
    if (depth > 0.55 && radius > 4) {
      // A small lit cap on the near side, from the same light as the core.
      context.beginPath();
      context.arc(x - radius * 0.3, y - radius * 0.32, radius * 0.32, 0, Math.PI * 2);
      context.fillStyle = `${palette.highlight}${(alpha * (depth - 0.55) * 0.9).toFixed(3)})`;
      context.fill();
    }
    if (lod < 2 || active) {
      context.beginPath();
      context.arc(x, y, radius + 3.5, 0, Math.PI * 2);
      context.strokeStyle = tint("source", alpha * 0.32);
      context.lineWidth = 1;
      context.stroke();
    }
  } else if (node.kind === "router") {
    context.beginPath();
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.strokeStyle = tint("router", alpha);
    context.lineWidth = 1.6;
    context.stroke();
    context.beginPath();
    context.arc(x, y, Math.max(1.2, radius * 0.36), 0, Math.PI * 2);
    context.fillStyle = tint("router", alpha);
    context.fill();
  } else {
    context.beginPath();
    context.arc(x, y, Math.max(1.1, radius), 0, Math.PI * 2);
    context.fillStyle = tint("skill", alpha);
    context.fill();
  }
  if (active) {
    context.beginPath();
    context.arc(x, y, radius + (node.kind === "skill" ? 4 : 6.5), 0, Math.PI * 2);
    context.strokeStyle = palette.ring;
    context.lineWidth = focus === "selected" ? 2 : 1.4;
    context.stroke();
  }
  context.restore();
}

type StarPalette = {
  star: string;
  grid: string;
  edge: (hue: number, alpha: number) => string;
  edgeHot: string;
  conflict: string;
  /** Colour by category hue; `depth` 0 (far) .. 1 (near) sets saturation and light. */
  node: (hue: number, kind: UniverseNodeKind, alpha: number, depth: number) => string;
  core: string;
  highlight: string;
  meteor: string;
  muted: string;
  ring: string;
  text: string;
  halo: string;
  chip: string;
  chipBorder: string;
};

/** Restrained colours: category hue at moderate saturation; the warm Sky and
 * Parchment tones highlight in amber/terracotta, the cool ones in blue. */
function starPalette(tone: UniverseTone, lightTheme: boolean): StarPalette {
  // Warm accents belong to daylight; a night sky stays cool and clean.
  const warm = tone === "parchment" || (tone === "sky" && lightTheme);
  if (lightTheme) {
    return {
      star: "40, 62, 92",
      grid: "rgba(40, 62, 92, ",
      edge: (hue, alpha) => `hsla(${hue}, 26%, 48%, ${alpha})`,
      edgeHot: warm ? "rgba(196, 100, 60, " : "rgba(44, 100, 166, ",
      conflict: "rgba(168, 112, 31, ",
      node: (hue, kind, alpha, depth) => kind === "skill"
        ? `hsla(${hue}, ${Math.round(18 + depth * 40)}%, ${Math.round(66 - depth * 18)}%, ${alpha})`
        : `hsla(${hue}, ${Math.round(28 + depth * 46)}%, ${Math.round((kind === "router" ? 56 : 62) - depth * 22)}%, ${alpha})`,
      core: warm ? "rgba(214, 150, 92, " : "rgba(70, 116, 196, ",
      highlight: "rgba(255, 255, 255, ",
      meteor: warm ? "rgba(196, 100, 60, " : "rgba(44, 100, 166, ",
      muted: "rgba(115, 130, 149, ",
      ring: warm ? "#b9552e" : "#1d4c84",
      text: "#1b2a3a",
      halo: "rgba(241, 245, 249, .9)",
      chip: "rgba(255, 255, 255, .97)",
      chipBorder: "rgba(31, 51, 74, .16)"
    };
  }
  return {
    star: warm ? "244, 236, 246" : "226, 234, 252",
    grid: warm ? "rgba(236, 220, 244, " : "rgba(200, 216, 255, ",
    edge: (hue, alpha) => `hsla(${hue}, 26%, 72%, ${alpha})`,
    edgeHot: warm ? "rgba(240, 180, 110, " : "rgba(140, 180, 255, ",
    conflict: "rgba(232, 180, 95, ",
    node: (hue, kind, alpha, depth) => kind === "skill"
      ? `hsla(${hue}, ${Math.round(16 + depth * 46)}%, ${Math.round(42 + depth * 30)}%, ${alpha})`
      : `hsla(${hue}, ${Math.round(26 + depth * 54)}%, ${Math.round((kind === "router" ? 50 : 44) + depth * 28)}%, ${alpha})`,
    core: warm ? "rgba(255, 196, 140, " : "rgba(150, 186, 255, ",
    highlight: "rgba(255, 255, 255, ",
    meteor: warm ? "rgba(255, 226, 190, " : "rgba(214, 230, 255, ",
    muted: "rgba(150, 140, 165, ",
    ring: warm ? "#ffd9aa" : "#e2ebff",
    text: warm ? "#f5efe9" : "#eef2fb",
    halo: warm ? "rgba(21, 17, 28, .88)" : "rgba(6, 8, 14, .88)",
    chip: warm ? "rgba(36, 30, 47, .97)" : "rgba(15, 19, 29, .97)",
    chipBorder: warm ? "rgba(240, 180, 110, .5)" : "rgba(140, 180, 255, .45)"
  };
}

const LABEL_FONT = "'Segoe UI Variable Text', 'Microsoft YaHei UI', 'Segoe UI', sans-serif";

/** Names stay readable: the focused node and its neighbours first, then
 * sources by size and nearness; each label tries four sides of its node and
 * is skipped when every side would overlap a label already placed. */
function drawUniverseLabels(
  context: CanvasRenderingContext2D,
  runtime: UniverseRuntime,
  palette: StarPalette,
  width: number,
  height: number,
  focusId: string,
  neighbors: Set<string> | undefined,
  lod: UniverseLod,
  interactive: boolean
) {
  const limit = interactive ? 10 : lod === 0 ? 40 : lod === 1 ? 26 : 14;
  const candidates = runtime.projected
    .filter(node => node.rendered && (focusId
      ? node.id === focusId || node.id === runtime.selectedId || neighbors?.has(node.id)
      : node.kind === "source" || (node.kind === "router" && lod === 0 && node.depth > 0.55)))
    .map(node => ({
      node,
      score: (node.id === focusId ? 1e7 : 0) + (node.id === runtime.selectedId ? 1e6 : 0) +
        (node.kind === "source" ? 1e4 : node.kind === "router" ? 1e3 : 0) + node.radius * 40 + node.depth * 200
    }))
    .sort((a, b) => b.score - a.score);
  const placed: Array<{ left: number; top: number; right: number; bottom: number }> = [];
  context.save();
  context.textBaseline = "middle";
  let count = 0;
  for (const { node } of candidates) {
    if (count >= limit) break;
    const focused = node.id === focusId || node.id === runtime.selectedId;
    const size = focused ? 12.5 : node.kind === "source" ? 12 : 11;
    context.font = `${focused || node.kind === "source" ? 600 : 500} ${size}px ${LABEL_FONT}`;
    const text = truncateText(context, node.kind === "source" ? node.label : `/${node.label}`, focused ? 280 : 200);
    const titleFont = context.font;
    const ownerFont = `400 ${size - 1}px ${LABEL_FONT}`;
    const owner = node.kind === "source" && node.owner ? ` ${node.owner}` : "";
    const titleWidth = context.measureText(text).width;
    context.font = ownerFont;
    const ownerText = owner ? truncateText(context, owner, 120) : "";
    const ownerWidth = ownerText ? context.measureText(ownerText).width : 0;
    context.font = titleFont;
    const textWidth = titleWidth + ownerWidth;
    const padX = focused ? 9 : 3, boxHeight = size + (focused ? 12 : 6);
    const boxWidth = textWidth + padX * 2;
    const gap = node.radius + (focused ? 10 : 6);
    const options = [
      { left: node.screenX + gap, top: node.screenY - boxHeight / 2 },
      { left: node.screenX - gap - boxWidth, top: node.screenY - boxHeight / 2 },
      { left: node.screenX - boxWidth / 2, top: node.screenY - gap - boxHeight },
      { left: node.screenX - boxWidth / 2, top: node.screenY + gap }
    ];
    const spot = options.find(option => {
      const rect = { left: option.left, top: option.top, right: option.left + boxWidth, bottom: option.top + boxHeight };
      if (rect.left < 8 || rect.right > width - 8 || rect.top < 8 || rect.bottom > height - 8) return false;
      if (runtime.obstacles.some(other => rect.left < other.right && rect.right > other.left && rect.top < other.bottom && rect.bottom > other.top)) return false;
      return !placed.some(other => rect.left < other.right + 4 && rect.right + 4 > other.left && rect.top < other.bottom + 2 && rect.bottom + 2 > other.top);
    });
    if (!spot) continue;
    placed.push({ left: spot.left, top: spot.top, right: spot.left + boxWidth, bottom: spot.top + boxHeight });
    count += 1;
    const textY = spot.top + boxHeight / 2 + 0.5;
    if (focused) {
      roundRect(context, spot.left, spot.top, boxWidth, boxHeight, 7);
      context.fillStyle = palette.chip;
      context.fill();
      context.strokeStyle = palette.chipBorder;
      context.lineWidth = 1;
      context.stroke();
      context.fillStyle = palette.text;
      context.fillText(text, spot.left + padX, textY);
      if (ownerText) {
        context.font = ownerFont;
        context.globalAlpha = 0.6;
        context.fillText(ownerText, spot.left + padX + titleWidth, textY);
        context.globalAlpha = 1;
      }
    } else {
      context.globalAlpha = neighbors?.has(node.id) ? 0.95 : 0.45 + node.depth * 0.5;
      context.lineJoin = "round";
      context.lineWidth = 3;
      context.strokeStyle = palette.halo;
      context.strokeText(text, spot.left + padX, textY);
      context.fillStyle = palette.text;
      context.fillText(text, spot.left + padX, textY);
      if (ownerText) {
        context.font = ownerFont;
        const alpha = context.globalAlpha;
        context.strokeText(ownerText, spot.left + padX + titleWidth, textY);
        context.globalAlpha = alpha * 0.55;
        context.fillText(ownerText, spot.left + padX + titleWidth, textY);
      }
      context.globalAlpha = 1;
    }
  }
  context.restore();
}

function resolveUniverseLod(nodeCount: number, quality: number, interactive: boolean): UniverseLod {
  let lod: UniverseLod = nodeCount >= 1200 ? 2 : nodeCount >= 650 ? 1 : 0;
  if (interactive || quality < 0.68) lod = Math.min(2, lod + 1) as UniverseLod;
  return lod;
}

function updateUniverseDiagnostics(canvas: HTMLCanvasElement, runtime: UniverseRuntime) {
  const orderedFrames = [...runtime.frameSamples].sort((a, b) => a - b);
  const p95Index = Math.max(0, Math.ceil(orderedFrames.length * 0.95) - 1);
  canvas.dataset.frameMs = runtime.frameMs.toFixed(1);
  canvas.dataset.frameP95 = (orderedFrames[p95Index] ?? runtime.frameMs).toFixed(1);
  canvas.dataset.drawMs = runtime.drawMs.toFixed(2);
  canvas.dataset.renderQuality = runtime.quality.toFixed(2);
  canvas.dataset.lod = String(runtime.lod);
  canvas.dataset.renderedNodes = String(runtime.renderedNodes);
  canvas.dataset.drawnEdges = String(runtime.drawnEdges);
}

function edgeVisible(kind: UniverseEdgeKind, mode: SkillUniverseMode) {
  if (kind === "parent") return true;
  if (kind === "conflict") return mode === "relations";
  return mode !== "sources";
}

function edgeAlpha(kind: UniverseEdgeKind, mode: SkillUniverseMode, highlighted: boolean) {
  if (highlighted) return 0.72;
  if (kind === "parent") return mode === "sources" ? 0.32 : 0.2;
  if (kind === "conflict") return 0.24;
  return mode === "categories" ? 0.24 : 0.13;
}

function nodeRadius(node: UniverseNode, perspectiveScale: number) {
  if (node.kind === "source") {
    // Popularity and size still read, but no disc dominates a dense cluster.
    return clamp(4.6 + Math.log10(node.stars + 1) * 1.6 + Math.sqrt(node.childCount) * 0.14, 5, 13) * perspectiveScale;
  }
  if (node.kind === "router") return (5.2 + node.rating * 0.48) * perspectiveScale;
  return (1.5 + node.rating * 0.38 + (node.health === "warn" ? 0.35 : 0)) * perspectiveScale;
}

function findHit(runtime: UniverseRuntime, x: number, y: number) {
  for (let index = runtime.projected.length - 1; index >= 0; index -= 1) {
    const node = runtime.projected[index];
    if (!node.rendered) continue;
    const hitRadius = Math.max(node.kind === "skill" ? 10 : 12, node.radius + 5);
    if (Math.hypot(node.screenX - x, node.screenY - y) <= hitRadius) return node;
  }
  return null;
}

function resolveSource(skill: SkillCard, lookup: Map<string, SourceCard>, sources: SourceCard[]) {
  if (skill.sourceId) {
    const exact = sources.find(source => source.id === skill.sourceId);
    if (exact) return exact;
  }
  if (isRouter(skill)) {
    const byRouterName = lookup.get(normalize(skill.name)) ?? lookup.get(normalize(skill.folderName));
    if (byRouterName) return byRouterName;
  }
  const direct = lookup.get(normalize(skill.source));
  if (direct) return direct;
  return undefined;
}

function popularityLookup(items: SourcePopularityCard[]) {
  const lookup = new Map<string, SourcePopularityCard>();
  items.forEach(item => {
    lookup.set(normalize(item.sourceId), item);
    lookup.set(normalize(item.sourceName), item);
    lookup.set(normalize(item.repo), item);
  });
  return lookup;
}

function popularityFor(source: SourceCard, lookup: Map<string, SourcePopularityCard>) {
  const repo = source.url.split("/").pop()?.replace(/\.git$/i, "") ?? "";
  return lookup.get(normalize(source.id)) ?? lookup.get(normalize(source.name)) ?? lookup.get(normalize(repo));
}

function dominantSkillCategory(skills: SkillCard[], fallback: string) {
  const counts = new Map<string, number>();
  skills.filter(skill => !isRouter(skill)).forEach(skill => counts.set(skillCategory(skill), (counts.get(skillCategory(skill)) ?? 0) + 1));
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? fallback ?? "general";
}

function skillCategory(skill: SkillCard) {
  if (skill.userFolderName) {
    const safeName = skill.userFolderName.replace(/:/g, "·");
    return `folder:${skill.userFolderColor || "slate"}:${safeName}`;
  }
  return `folder:slate:${t("folders.unfiled")}`;
}

function isRouter(skill: SkillCard) {
  if (typeof skill.isRouterHub === "boolean") return skill.isRouterHub;
  return skill.description.includes("[ROUTER-HUB]") || skill.relativePath.includes("AI-SkillHub-local-routers");
}

function nodeKindLabel(kind: UniverseNodeKind) {
  if (kind === "source") return t("universe.kind.source");
  if (kind === "router") return t("universe.kind.router");
  return t("universe.kind.skill");
}

function displayCategory(category: string) {
  if (category.startsWith("folder:")) return category.split(":").slice(2).join(":") || t("folders.unfiled");
  return categoryName(category) ?? category;
}

function categoryHue(category: string) {
  if (category.startsWith("folder:")) {
    const color = category.split(":")[1] || "slate";
    return ({ cyan: 184, violet: 258, magenta: 319, amber: 39, emerald: 153, blue: 211, coral: 9, slate: 218 } as Record<string, number>)[color] ?? 218;
  }
  return CATEGORY_HUES[normalize(category)] ?? (stableHash(category) * 47 + 162) % 360;
}

function clusterHue(category: string, sourceId: string) {
  const normalizedCategory = normalize(category);
  const hash = stableHash(`${normalizedCategory}:${sourceId}`);
  if (category.startsWith("folder:")) return categoryHue(category);
  if (normalizedCategory === "general") return GENERAL_CLUSTER_HUES[hash % GENERAL_CLUSTER_HUES.length];
  const offset = CLUSTER_HUE_OFFSETS[hash % CLUSTER_HUE_OFFSETS.length];
  return (categoryHue(normalizedCategory) + offset + 360) % 360;
}

function fibonacciPoint(index: number, count: number, radius: number): Point3 {
  const y = 1 - ((index + 0.5) / Math.max(count, 1)) * 2;
  const radial = Math.sqrt(Math.max(0, 1 - y * y));
  const angle = index * 2.399963229728653;
  return { x: Math.cos(angle) * radial * radius, y: y * radius, z: Math.sin(angle) * radial * radius };
}

function localOrbitPoint(seed: number, index: number, count: number): Point3 {
  const angle = index * 2.399963229728653 + (seed % 628) / 100;
  const z = 1 - ((index + 0.5) / Math.max(count, 1)) * 2;
  const radial = Math.sqrt(Math.max(0, 1 - z * z));
  return { x: Math.cos(angle) * radial, y: z * 0.9, z: Math.sin(angle) * radial };
}

function addPoint(a: Point3, b: Point3): Point3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function mixPoint(a: Point3, b: Point3, amount: number): Point3 {
  return { x: a.x + (b.x - a.x) * amount, y: a.y + (b.y - a.y) * amount, z: a.z + (b.z - a.z) * amount };
}

function scalePoint(point: Point3, amount: number): Point3 {
  return { x: point.x * amount, y: point.y * amount, z: point.z * amount };
}

function normalizePoint(point: Point3, radius = 1): Point3 {
  const length = Math.hypot(point.x, point.y, point.z) || 1;
  return { x: (point.x / length) * radius, y: (point.y / length) * radius, z: (point.z / length) * radius };
}

function roundRect(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
  context.beginPath();
  context.roundRect(x, y, width, height, radius);
}

function truncateText(context: CanvasRenderingContext2D, value: string, maxWidth: number) {
  if (context.measureText(value).width <= maxWidth) return value;
  let text = value;
  while (text.length > 3 && context.measureText(`${text}…`).width > maxWidth) text = text.slice(0, -1);
  return `${text}…`;
}

function emptyUniverseModel(): UniverseModel {
  return {
    categories: [],
    edges: [],
    neighbors: new Map(),
    nodes: [],
    parentEdges: 0,
    relationEdges: 0,
    skillCount: 0,
    sourceCount: 0
  };
}

function readUniverseModelCache(): UniverseModel | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(UNIVERSE_CACHE_KEY);
    if (!raw || raw.length > 2_000_000) return null;
    const value = JSON.parse(raw) as {
      version?: number;
      categories?: UniverseModel["categories"];
      edges?: UniverseEdge[];
      nodes?: UniverseNode[];
      parentEdges?: number;
      relationEdges?: number;
      skillCount?: number;
      sourceCount?: number;
    };
    if (
      value.version !== 1 ||
      !Array.isArray(value.nodes) ||
      !Array.isArray(value.edges) ||
      !Array.isArray(value.categories) ||
      value.nodes.length > 12_000 ||
      value.edges.length > 48_000 ||
      !value.nodes.every(isCachedUniverseNode) ||
      !value.edges.every(edge =>
        Boolean(edge) &&
        typeof edge.from === "string" &&
        typeof edge.to === "string" &&
        (edge.kind === "parent" || edge.kind === "category" || edge.kind === "conflict")
      )
    ) {
      return null;
    }
    return {
      categories: value.categories,
      edges: value.edges,
      neighbors: buildNeighborMap(value.edges),
      nodes: value.nodes,
      parentEdges: finiteCount(value.parentEdges),
      relationEdges: finiteCount(value.relationEdges),
      skillCount: finiteCount(value.skillCount),
      sourceCount: finiteCount(value.sourceCount)
    };
  } catch {
    return null;
  }
}

function writeUniverseModelCache(model: UniverseModel) {
  if (typeof window === "undefined") return;
  try {
    const nodes = model.nodes.map(node => {
      const cachedNode: UniverseNode = { ...node };
      delete cachedNode.skill;
      delete cachedNode.source;
      return cachedNode;
    });
    window.localStorage.setItem(
      UNIVERSE_CACHE_KEY,
      JSON.stringify({
        version: 1,
        savedAt: Date.now(),
        categories: model.categories,
        edges: model.edges,
        nodes,
        parentEdges: model.parentEdges,
        relationEdges: model.relationEdges,
        skillCount: model.skillCount,
        sourceCount: model.sourceCount
      })
    );
  } catch {
    // A cache miss is safe: the authoritative graph still loads from SQLite.
  }
}

function isCachedUniverseNode(node: UniverseNode): boolean {
  if (
    !node ||
    typeof node.id !== "string" ||
    typeof node.label !== "string" ||
    typeof node.category !== "string" ||
    typeof node.sourceId !== "string" ||
    typeof node.sourceName !== "string" ||
    !Number.isFinite(node.hue) ||
    !Number.isFinite(node.seed) ||
    !node.positions
  ) {
    return false;
  }
  return MODES.every(mode => {
    const point = node.positions[mode];
    return point && Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z);
  });
}

function buildNeighborMap(edges: UniverseEdge[]): Map<string, Set<string>> {
  const neighbors = new Map<string, Set<string>>();
  for (const edge of edges) {
    const fromNeighbors = neighbors.get(edge.from) ?? new Set<string>();
    const toNeighbors = neighbors.get(edge.to) ?? new Set<string>();
    fromNeighbors.add(edge.to);
    toNeighbors.add(edge.from);
    neighbors.set(edge.from, fromNeighbors);
    neighbors.set(edge.to, toNeighbors);
  }
  return neighbors;
}

function finiteCount(value: number | undefined): number {
  return Number.isFinite(value) && Number(value) >= 0 ? Math.floor(Number(value)) : 0;
}

function randomSessionSeed(): number {
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    return globalThis.crypto.getRandomValues(new Uint32Array(1))[0];
  }
  return stableHash(`${Date.now()}:${Math.random()}`);
}

function normalize(value: string) {
  return String(value || "").trim().toLowerCase().replace(/\\/g, "/").replace(/\.git$/i, "");
}

function stableHash(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, value));
}

function wrapAngle(value: number) {
  const fullTurn = Math.PI * 2;
  return ((value + Math.PI) % fullTurn + fullTurn) % fullTurn - Math.PI;
}

const CATEGORY_HUES: Record<string, number> = {
  "academic-writing": 216,
  "literature-research": 174,
  "scientific-figures": 42,
  "ui-design": 310,
  "security-audit": 8,
  "agent-tools": 258,
  "image-generation": 334,
  "knowledge-retrieval": 148,
  presentations: 26,
  "prompt-polishing": 286,
  "life-sciences": 116,
  "clinical-medical": 350,
  "finance-economics": 52,
  "document-tools": 196,
  "browser-automation": 232,
  "data-analysis": 184,
  development: 224,
  general: 204
};

const GENERAL_CLUSTER_HUES = [12, 38, 116, 154, 184, 206, 224, 248, 274, 306, 334, 352];
const CLUSTER_HUE_OFFSETS = [-14, -7, 0, 7, 14];
