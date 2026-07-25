import {
  type CSSProperties,
  type PointerEvent,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { Icon } from "./icons";
import { categoryName, t } from "./i18n";
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
  stars: number;
};

type UniverseEdge = { from: string; kind: UniverseEdgeKind; to: string };
type UniverseTone = "biolume" | "mist" | "parchment" | "prism";
type UniverseLod = 0 | 1 | 2;
type UniverseNodeFocus = "active" | "neighbor" | "muted" | "normal";
type UniverseModel = {
  categories: Array<{ category: string; count: number; hue: number }>;
  edges: UniverseEdge[];
  neighbors: Map<string, Set<string>>;
  nodes: UniverseNode[];
  parentEdges: number;
  relationEdges: number;
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

type SkillUniverseProps = {
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

const SPHERE_SHELL = Array.from({ length: 420 }, (_, index) => fibonacciPoint(index, 420, 1));
const DUST_PARTICLES = Array.from({ length: 112 }, (_, index) => {
  const seed = stableHash(`universe-dust:${index}`);
  return {
    angle: (seed % 6283) / 1000,
    distance: 0.38 + ((seed >>> 5) % 1000) / 740,
    size: 0.35 + (seed % 7) * 0.085,
    speed: 0.000004 + (seed % 5) * 0.0000015,
    stretch: 0.78 + ((seed >>> 8) % 28) / 100
  };
});
const METEORS = Array.from({ length: 7 }, (_, index) => {
  const seed = stableHash(`universe-meteor:${index}`);
  return {
    delay: (seed % 10_000) / 10_000,
    duration: 0.12 + ((seed >>> 4) % 80) / 1000,
    length: 34 + ((seed >>> 7) % 76),
    slope: 0.28 + ((seed >>> 11) % 30) / 100,
    x: -0.18 + ((seed >>> 14) % 136) / 100,
    y: 0.04 + ((seed >>> 18) % 84) / 100
  };
});
const AURA_SPRITES = new Map<string, HTMLCanvasElement>();

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
  const mode = controlledMode ?? internalMode;
  const modeRef = useRef(mode);
  const centeredRef = useRef(centered);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const runtimeRef = useRef<UniverseRuntime | null>(null);
  const hoverRef = useRef("");
  const model = useMemo(() => buildUniverseModel(snapshot), [snapshot]);
  modeRef.current = mode;
  centeredRef.current = centered;

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

    let frame = 0;
    let visible = !document.hidden;
    let contextReady = true;
    let width = 1;
    let height = 1;
    let dpr = 1;

    canvas.dataset.renderer = "canvas2d";
    canvas.dataset.contextState = "ready";
    canvas.dataset.nodeCount = String(model.nodes.length);
    canvas.dataset.nodeShape = "screen-space-circles";

    const scheduleDraw = () => {
      if (!visible || !contextReady || frame) return;
      frame = window.requestAnimationFrame(draw);
    };

    const resize = () => {
      const rect = host.getBoundingClientRect();
      width = Math.max(1, Math.floor(rect.width));
      height = Math.max(1, Math.floor(rect.height));
      const pixelBudgetScale = Math.sqrt(1_700_000 / Math.max(1, width * height));
      dpr = Math.min(window.devicePixelRatio || 1, 1.35, Math.max(0.78, pixelBudgetScale));
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      scheduleDraw();
    };

    const draw = (time: number) => {
      frame = 0;
      if (!visible) return;
      const drawStarted = performance.now();
      context.clearRect(0, 0, width, height);
      drawUniverse(
        context,
        model,
        runtime,
        modeRef.current,
        width,
        height,
        reducedMotion ? 0 : time,
        centeredRef.current,
        lightTheme,
        tone
      );
      const drawDuration = performance.now() - drawStarted;
      runtime.drawMs = runtime.drawMs ? runtime.drawMs * 0.86 + drawDuration * 0.14 : drawDuration;
      if (time > 0) {
        runtime.frameSamples.push(runtime.frameMs);
        if (runtime.frameSamples.length > 90) runtime.frameSamples.shift();
      }
      if (reducedMotion || runtime.frameIndex % 30 === 0) updateUniverseDiagnostics(canvas, runtime);
      if (!reducedMotion) scheduleDraw();
    };
    runtime.requestDraw = scheduleDraw;

    const onVisibility = () => {
      visible = !document.hidden;
      window.cancelAnimationFrame(frame);
      frame = 0;
      if (visible) scheduleDraw();
    };

    const onMotionPreference = (event: MediaQueryListEvent) => {
      reducedMotion = event.matches;
      runtime.lastFrame = 0;
      window.cancelAnimationFrame(frame);
      frame = 0;
      scheduleDraw();
    };

    const onContextLost = (event: Event) => {
      event.preventDefault();
      canvas.dataset.contextState = "lost";
      contextReady = false;
      window.cancelAnimationFrame(frame);
      frame = 0;
    };

    const onContextRestored = () => {
      canvas.dataset.contextState = "ready";
      contextReady = true;
      visible = !document.hidden;
      resize();
      scheduleDraw();
    };

    const observer = new ResizeObserver(resize);
    observer.observe(host);
    document.addEventListener("visibilitychange", onVisibility);
    motionQuery.addEventListener("change", onMotionPreference);
    canvas.addEventListener("contextlost", onContextLost);
    canvas.addEventListener("contextrestored", onContextRestored);
    resize();
    scheduleDraw();

    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      motionQuery.removeEventListener("change", onMotionPreference);
      canvas.removeEventListener("contextlost", onContextLost);
      canvas.removeEventListener("contextrestored", onContextRestored);
      window.cancelAnimationFrame(frame);
      if (runtimeRef.current === runtime) runtimeRef.current = null;
    };
  }, [lightTheme, model, tone]);

  useEffect(() => {
    runtimeRef.current?.requestDraw();
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
    <div className={`skill-universe${centered ? " is-centered" : ""}`} style={{ "--universe-hue": hovered?.hue ?? 178 } as CSSProperties}>
      <canvas
        aria-label={t("universe.aria", { skills: snapshot?.skills.length ?? 0, sources: model.sourceCount })}
        className="skill-universe-canvas"
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
        <strong>{(snapshot?.skills.length ?? 0).toLocaleString()}</strong>
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

      {hovered && (
        <aside className="skill-universe-inspector" aria-live="polite">
          <header>
            <i />
            <span>{nodeKindLabel(hovered.kind)}</span>
            <b>{displayCategory(hovered.category)}</b>
          </header>
          <strong>{hovered.kind === "skill" || hovered.kind === "router" ? `/${hovered.label}` : hovered.label}</strong>
          <p>{hovered.description || t("universe.noDescription")}</p>
          <dl>
            <div><dt>{t("universe.source")}</dt><dd>{hovered.sourceName}</dd></div>
            {hovered.kind === "source" ? (
              <>
                <div><dt>GitHub</dt><dd>★ {hovered.stars.toLocaleString()}</dd></div>
                <div><dt>{t("universe.children")}</dt><dd>{hovered.childCount}</dd></div>
              </>
            ) : (
              <>
                <div><dt>{t("universe.myRating")}</dt><dd>{hovered.rating ? `${hovered.rating} / 5` : t("universe.unrated")}</dd></div>
                <div><dt>{t("universe.health")}</dt><dd>{hovered.health}</dd></div>
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
      label: source.name,
      positions: {
        sources: sourceCenter,
        categories: scalePoint(sourceCategoryCenter, 0.88),
        relations: normalizePoint(mixPoint(sourceCenter, sourceCategoryCenter, 0.22), 0.82)
      },
      rating: 0,
      seed: stableHash(source.id),
      source,
      sourceId: source.id,
      sourceName: source.name,
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
    description: cleanDescription(skill.description),
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
    sourceName: source.name,
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
      const targetQuality = runtime.frameMs > 24 ? 0.58 : runtime.frameMs > 19.5 ? 0.78 : 1;
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

  drawUniverseAtmosphere(
    context,
    centerX,
    centerY,
    radius,
    lightTheme,
    tone,
    time,
    rotationX,
    rotationY,
    runtime.quality,
    interactive,
    lod
  );

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
    const highlighted = Boolean(runtime.hoverId && (edge.from === runtime.hoverId || edge.to === runtime.hoverId));
    if (runtime.hoverId ? !highlighted : !edgeVisible(edge.kind, mode)) continue;
    if (!runtime.hoverId) {
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
      ? `rgba(255, 177, 105, ${alpha})`
      : `hsla(${to.hue}, 78%, ${lightTheme ? 38 : 70}%, ${alpha})`;
    context.lineWidth = highlighted ? 1.45 : edge.kind === "parent" ? 0.68 : 0.48;
    if (edge.kind === "conflict") context.setLineDash([4, 5]);
    context.stroke();
    context.setLineDash([]);
    runtime.drawnEdges += 1;
    if (highlighted) {
      drawRelationshipPulse(context, from, to, controlX, controlY, edgeIndex, time, lightTheme);
    }
  }
  context.restore();

  if (lod < 2 || !interactive || runtime.frameIndex % 2 === 0) {
    runtime.projected.sort((a, b) => a.depth - b.depth);
  }
  const hoveredNeighbors = runtime.hoverId ? model.neighbors.get(runtime.hoverId) : undefined;
  const skillStride = lod === 2 ? Math.max(2, Math.ceil(model.nodes.length / 760)) : 1;
  runtime.renderedNodes = 0;
  for (const node of runtime.projected) {
    node.rendered = false;
    const focus: UniverseNodeFocus = node.id === runtime.hoverId
      ? "active"
      : hoveredNeighbors?.has(node.id)
        ? "neighbor"
        : runtime.hoverId
          ? "muted"
          : "normal";
    if (node.kind === "skill" && focus !== "active" && focus !== "neighbor" && node.seed % skillStride !== 0) {
      continue;
    }
    node.rendered = true;
    runtime.renderedNodes += 1;
    drawUniverseNode(context, node, focus, lightTheme, time, lod, interactive);
  }
  if (runtime.hoverId) {
    const hovered = runtime.projectedById.get(runtime.hoverId);
    if (hovered) drawHoverLabel(context, hovered, width, height, lightTheme);
  }
}

function drawUniverseAtmosphere(
  context: CanvasRenderingContext2D,
  centerX: number,
  centerY: number,
  radius: number,
  lightTheme: boolean,
  tone: UniverseTone,
  time: number,
  rotationX: number,
  rotationY: number,
  quality: number,
  interactive: boolean,
  lod: UniverseLod
) {
  const atmosphere = atmospherePalette(tone, lightTheme);
  const aura = getAuraSprite(`${tone}:${lightTheme ? "light" : "dark"}`, atmosphere);
  if (aura) {
    context.drawImage(aura, centerX - radius * 1.35, centerY - radius * 1.35, radius * 2.7, radius * 2.7);
  }
  drawUniverseMeteors(context, centerX, centerY, radius, lightTheme, tone, time, interactive, lod);

  context.save();
  context.translate(centerX, centerY);
  context.rotate(time * 0.000006);
  context.strokeStyle = atmosphere.line;
  context.lineWidth = 0.7;
  const ringCount = interactive || lod === 2 ? 1 : lod === 1 ? 2 : 3;
  for (let ring = 0; ring < ringCount; ring += 1) {
    context.save();
    const ringOffset = ring - (ringCount - 1) / 2;
    context.rotate(ringOffset * 0.42 + time * 0.000002 * (ring + 1));
    context.scale(1, 0.52 + ring * 0.12);
    context.beginPath();
    context.arc(0, 0, radius * (0.78 + ring * 0.14), 0, Math.PI * 2);
    context.stroke();
    context.restore();
  }
  context.restore();

  const cosX = Math.cos(rotationX);
  const sinX = Math.sin(rotationX);
  const cosY = Math.cos(rotationY);
  const sinY = Math.sin(rotationY);
  const shellStep = lod === 2 ? 3 : lod === 1 || interactive || quality < 0.72 ? 2 : 1;
  context.save();
  context.fillStyle = atmosphere.shell;
  for (let index = 0; index < SPHERE_SHELL.length; index += shellStep) {
    const point = SPHERE_SHELL[index];
    const y0 = point.y * cosX - point.z * sinX;
    const z0 = point.y * sinX + point.z * cosX;
    const x = point.x * cosY + z0 * sinY;
    const z = -point.x * sinY + z0 * cosY;
    const scale = 3.05 / (3.05 - z);
    const size = (z > 0 ? 1.05 : 0.48) * scale;
    context.globalAlpha = z > 0 ? 0.9 : 0.3;
    context.beginPath();
    context.arc(
      centerX + x * radius * scale,
      centerY + y0 * radius * scale,
      Math.max(0.36, size),
      0,
      Math.PI * 2
    );
    context.fill();
  }
  context.restore();

  context.save();
  context.fillStyle = atmosphere.dust;
  const dustScale = lod === 2 ? 0.32 : lod === 1 ? 0.58 : quality;
  const dustCount = interactive ? Math.min(28, DUST_PARTICLES.length) : Math.round(DUST_PARTICLES.length * dustScale);
  for (let index = 0; index < dustCount; index += 1) {
    const dust = DUST_PARTICLES[index];
    const angle = dust.angle + time * dust.speed;
    const distance = radius * dust.distance;
    const x = centerX + Math.cos(angle) * distance * dust.stretch;
    const y = centerY + Math.sin(angle) * distance * 0.66;
    context.fillRect(x, y, dust.size, dust.size);
  }
  context.restore();
}

function drawUniverseMeteors(
  context: CanvasRenderingContext2D,
  centerX: number,
  centerY: number,
  radius: number,
  lightTheme: boolean,
  tone: UniverseTone,
  time: number,
  interactive: boolean,
  lod: UniverseLod
) {
  if (time === 0 || interactive || lod === 2) return;
  const meteorHue = tone === "prism" ? 216 : tone === "parchment" ? 18 : tone === "mist" ? 166 : 178;
  context.save();
  context.lineCap = "round";
  for (const meteor of METEORS) {
    const phase = (time * 0.000028 + meteor.delay) % 1;
    if (phase > meteor.duration) continue;
    const progress = phase / meteor.duration;
    const fade = Math.sin(progress * Math.PI);
    const startX = centerX + (meteor.x - 0.5) * radius * 2.8 + progress * radius * 0.72;
    const startY = centerY + (meteor.y - 0.5) * radius * 2.1 + progress * radius * meteor.slope;
    const tailX = startX - meteor.length;
    const tailY = startY - meteor.length * meteor.slope;
    const gradient = context.createLinearGradient(tailX, tailY, startX, startY);
    gradient.addColorStop(0, `hsla(${meteorHue}, 92%, ${lightTheme ? 36 : 76}%, 0)`);
    gradient.addColorStop(0.72, `hsla(${meteorHue}, 92%, ${lightTheme ? 36 : 76}%, ${fade * 0.1})`);
    gradient.addColorStop(1, `hsla(${meteorHue}, 100%, ${lightTheme ? 32 : 88}%, ${fade * 0.54})`);
    context.beginPath();
    context.moveTo(tailX, tailY);
    context.lineTo(startX, startY);
    context.strokeStyle = gradient;
    context.lineWidth = 0.75;
    context.stroke();
    context.beginPath();
    context.arc(startX, startY, 1.1, 0, Math.PI * 2);
    context.fillStyle = `hsla(${meteorHue}, 100%, ${lightTheme ? 30 : 90}%, ${fade * 0.72})`;
    context.fill();
  }
  context.restore();
}

function drawUniverseNode(
  context: CanvasRenderingContext2D,
  node: ProjectedNode,
  focus: UniverseNodeFocus,
  lightTheme: boolean,
  time: number,
  lod: UniverseLod,
  interactive: boolean
) {
  const hue = node.hue;
  const highlighted = focus === "active";
  const neighbor = focus === "neighbor";
  const focusAlpha = focus === "muted" ? 0.14 : neighbor ? 0.9 : 1;
  const baseAlpha = node.enabled ? 0.54 + node.depth * 0.42 : 0.38;
  const animatedNode = highlighted || node.kind !== "skill";
  const pulse = time === 0 || !animatedNode ? 1 : 0.975 + Math.sin(time * 0.00082 + node.seed) * 0.025;
  const radius = node.radius * (highlighted ? 1.3 : neighbor ? 1.08 : pulse);
  const lightness = lightTheme ? 43 : 67;

  context.save();
  context.globalAlpha = focusAlpha;
  if (highlighted) {
    context.beginPath();
    context.arc(node.screenX, node.screenY, radius * (2.35 + Math.sin(time * 0.002) * 0.08), 0, Math.PI * 2);
    context.fillStyle = `hsla(${hue}, 92%, ${lightness + 4}%, .1)`;
    context.fill();
  }

  if (node.kind === "source") {
    if (node.enabled && (lod < 2 || highlighted)) {
      const popularityHalo = 2.2 + Math.min(0.7, Math.log10(node.stars + 1) * 0.1);
      for (const [scale, alpha] of [[popularityHalo, 0.028], [1.78, 0.052], [1.38, 0.08]] as const) {
        context.beginPath();
        context.arc(node.screenX, node.screenY, radius * scale, 0, Math.PI * 2);
        context.fillStyle = `hsla(${hue}, 88%, ${lightness + 5}%, ${highlighted ? alpha * 1.9 : alpha})`;
        context.fill();
      }
    }

    if (node.enabled) {
      const sphere = context.createRadialGradient(
        node.screenX - radius * 0.34,
        node.screenY - radius * 0.38,
        Math.max(0.6, radius * 0.06),
        node.screenX,
        node.screenY,
        radius * 1.08
      );
      sphere.addColorStop(0, `hsla(${hue - 8}, 96%, ${lightTheme ? 82 : 92}%, ${Math.min(1, baseAlpha + 0.2)})`);
      sphere.addColorStop(0.22, `hsla(${hue}, 92%, ${lightTheme ? 56 : 70}%, ${Math.min(1, baseAlpha + 0.12)})`);
      sphere.addColorStop(0.7, `hsla(${hue + 7}, 84%, ${lightTheme ? 38 : 49}%, ${baseAlpha})`);
      sphere.addColorStop(1, `hsla(${hue + 14}, 76%, ${lightTheme ? 24 : 25}%, ${baseAlpha * 0.92})`);
      context.beginPath();
      context.arc(node.screenX, node.screenY, radius, 0, Math.PI * 2);
      context.fillStyle = sphere;
      context.fill();

      context.beginPath();
      context.arc(node.screenX - radius * 0.28, node.screenY - radius * 0.31, radius * 0.12, 0, Math.PI * 2);
      context.fillStyle = `rgba(255, 255, 255, ${lightTheme ? 0.54 : 0.74})`;
      context.fill();
    }

    context.beginPath();
    context.arc(node.screenX, node.screenY, radius, 0, Math.PI * 2);
    context.strokeStyle = `hsla(${hue}, 92%, ${lightTheme ? 31 : 83}%, ${node.enabled ? highlighted ? 0.95 : 0.62 : 0.48})`;
    context.lineWidth = node.enabled ? 1 : 1.15;
    context.stroke();

    context.beginPath();
    context.arc(node.screenX, node.screenY, radius * 0.82, Math.PI * 0.9, Math.PI * 1.72);
    context.strokeStyle = `rgba(255, 255, 255, ${node.enabled ? lightTheme ? 0.24 : 0.42 : 0.18})`;
    context.lineWidth = Math.max(0.65, radius * 0.11);
    context.stroke();

    context.beginPath();
    context.arc(node.screenX, node.screenY, radius + 4, 0, Math.PI * 2);
    context.strokeStyle = `hsla(${hue}, 86%, ${lightTheme ? 34 : 76}%, ${highlighted ? 0.86 : 0.32})`;
    context.lineWidth = 0.75;
    context.stroke();

    if (!interactive && lod < 2) {
      const orbit = radius + 9 + Math.log10(node.stars + 1) * 0.7;
      const markerAngle = time * 0.00032 + (node.seed % 360);
      context.beginPath();
      context.arc(node.screenX, node.screenY, orbit, markerAngle + 0.35, markerAngle + 4.8);
      context.strokeStyle = `hsla(${hue}, 88%, ${lightTheme ? 36 : 82}%, ${lod === 0 ? 0.34 : 0.2})`;
      context.lineWidth = 0.65;
      context.stroke();
      context.beginPath();
      context.arc(
        node.screenX + Math.cos(markerAngle) * orbit,
        node.screenY + Math.sin(markerAngle) * orbit,
        highlighted ? 1.65 : 1.15,
        0,
        Math.PI * 2
      );
      context.fillStyle = `hsla(${hue}, 96%, ${lightTheme ? 34 : 84}%, .9)`;
      context.fill();
    }
  } else if (node.kind === "router") {
    if (node.enabled) {
      const routerSphere = context.createRadialGradient(
        node.screenX - radius * 0.3,
        node.screenY - radius * 0.32,
        Math.max(0.4, radius * 0.05),
        node.screenX,
        node.screenY,
        radius
      );
      routerSphere.addColorStop(0, `hsla(${hue - 6}, 96%, ${lightTheme ? 80 : 91}%, .94)`);
      routerSphere.addColorStop(0.28, `hsla(${hue}, 88%, ${lightTheme ? 52 : 68}%, ${highlighted ? 1 : baseAlpha})`);
      routerSphere.addColorStop(1, `hsla(${hue + 12}, 74%, ${lightTheme ? 27 : 31}%, ${highlighted ? 0.98 : baseAlpha})`);
      context.beginPath();
      context.arc(node.screenX, node.screenY, radius, 0, Math.PI * 2);
      context.fillStyle = routerSphere;
      context.fill();
      context.beginPath();
      context.arc(node.screenX - radius * 0.24, node.screenY - radius * 0.26, radius * 0.15, 0, Math.PI * 2);
      context.fillStyle = `rgba(255, 255, 255, ${lightTheme ? 0.48 : 0.7})`;
      context.fill();
    }
    context.beginPath();
    context.arc(node.screenX, node.screenY, radius, 0, Math.PI * 2);
    context.strokeStyle = `hsla(${hue}, 88%, ${lightTheme ? 31 : 82}%, ${node.enabled ? 0.66 : 0.5})`;
    context.lineWidth = node.enabled ? 0.85 : 1.1;
    context.stroke();
    for (const [offset, alpha] of [[2.7, 0.58], [5.8, 0.3]] as const) {
      context.beginPath();
      context.arc(node.screenX, node.screenY, radius + offset, 0, Math.PI * 2);
      context.strokeStyle = `hsla(${hue}, 84%, ${lightTheme ? 34 : 79}%, ${highlighted ? Math.min(0.95, alpha * 1.5) : alpha})`;
      context.lineWidth = offset < 3 ? 0.9 : 0.65;
      context.stroke();
    }
    if (lod < 2 || highlighted) {
      const activeSegments = clamp(Math.round(node.rating), 0, 5);
      const segmentRadius = radius + 9;
      const segmentSpan = (Math.PI * 2) / 5;
      for (let segment = 0; segment < 5; segment += 1) {
        const start = -Math.PI / 2 + segment * segmentSpan + 0.12;
        context.beginPath();
        context.arc(node.screenX, node.screenY, segmentRadius, start, start + segmentSpan - 0.24);
        context.strokeStyle = `hsla(${hue + segment * 3}, 90%, ${lightTheme ? 34 : 82}%, ${segment < activeSegments ? highlighted ? 0.96 : 0.72 : 0.13})`;
        context.lineWidth = segment < activeSegments ? 1.15 : 0.7;
        context.stroke();
      }
    }
  } else {
    context.beginPath();
    context.arc(node.screenX, node.screenY, radius, 0, Math.PI * 2);
    if (node.enabled) {
      context.fillStyle = `hsla(${hue}, ${lightTheme ? 74 : 82}%, ${lightness}%, ${highlighted ? 1 : baseAlpha})`;
      context.fill();
    } else {
      context.strokeStyle = `hsla(${hue}, 68%, ${lightTheme ? 35 : 72}%, .5)`;
      context.lineWidth = 0.8;
      context.stroke();
    }
    if (node.enabled && lod === 0 && radius > 2.35) {
      context.beginPath();
      context.arc(node.screenX - radius * 0.24, node.screenY - radius * 0.24, Math.max(0.42, radius * 0.17), 0, Math.PI * 2);
      context.fillStyle = `rgba(255, 255, 255, ${lightTheme ? 0.38 : 0.58})`;
      context.fill();
    }
    if (node.rating >= 4 || highlighted || neighbor) {
      context.beginPath();
      context.arc(node.screenX, node.screenY, radius + 2.2, 0, Math.PI * 2);
      context.strokeStyle = `hsla(${hue}, 78%, ${lightTheme ? 32 : 84}%, ${highlighted ? 0.78 : neighbor ? 0.46 : 0.24})`;
      context.lineWidth = 0.65;
      context.stroke();
    }
  }
  context.restore();
}

type AtmospherePalette = {
  center: string;
  dust: string;
  edge: string;
  line: string;
  mid: string;
  shell: string;
};

function atmospherePalette(tone: UniverseTone, lightTheme: boolean): AtmospherePalette {
  if (tone === "prism") {
    return {
      center: lightTheme ? "rgba(64, 104, 184, .13)" : "rgba(161, 190, 255, .16)",
      mid: lightTheme ? "rgba(127, 91, 166, .055)" : "rgba(112, 90, 190, .07)",
      edge: "rgba(71, 117, 198, .025)",
      line: lightTheme ? "rgba(54, 83, 145, .12)" : "rgba(165, 194, 255, .11)",
      shell: lightTheme ? "rgba(60, 85, 136, .34)" : "rgba(221, 232, 255, .42)",
      dust: lightTheme ? "rgba(77, 91, 131, .22)" : "rgba(202, 217, 255, .28)"
    };
  }
  if (tone === "parchment") {
    return {
      center: "rgba(154, 78, 48, .12)",
      mid: "rgba(68, 91, 112, .055)",
      edge: "rgba(122, 87, 55, .025)",
      line: "rgba(122, 75, 49, .12)",
      shell: "rgba(97, 73, 55, .32)",
      dust: "rgba(108, 78, 55, .2)"
    };
  }
  return {
    center: lightTheme ? "rgba(23, 121, 111, .15)" : "rgba(205, 255, 249, .18)",
    mid: lightTheme ? "rgba(41, 90, 128, .065)" : "rgba(68, 188, 180, .072)",
    edge: lightTheme ? "rgba(41, 90, 128, .025)" : "rgba(88, 129, 166, .026)",
    line: lightTheme ? "rgba(25, 105, 99, .12)" : "rgba(176, 239, 232, .12)",
    shell: lightTheme ? "rgba(27, 98, 93, .34)" : "rgba(213, 246, 242, .4)",
    dust: lightTheme ? "rgba(22, 93, 88, .22)" : "rgba(212, 247, 243, .26)"
  };
}

function getAuraSprite(key: string, palette: AtmospherePalette) {
  const cached = AURA_SPRITES.get(key);
  if (cached) return cached;
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 256;
  const context = canvas.getContext("2d");
  if (!context) return null;
  const aura = context.createRadialGradient(128, 128, 3, 128, 128, 128);
  aura.addColorStop(0, palette.center);
  aura.addColorStop(0.28, palette.mid);
  aura.addColorStop(0.68, palette.edge);
  aura.addColorStop(1, "rgba(0, 0, 0, 0)");
  context.fillStyle = aura;
  context.fillRect(0, 0, 256, 256);
  const upperBloom = context.createRadialGradient(106, 91, 2, 106, 91, 76);
  upperBloom.addColorStop(0, palette.center);
  upperBloom.addColorStop(0.4, palette.mid);
  upperBloom.addColorStop(1, "rgba(0, 0, 0, 0)");
  context.fillStyle = upperBloom;
  context.fillRect(0, 0, 256, 256);
  const lowerBloom = context.createRadialGradient(154, 168, 2, 154, 168, 82);
  lowerBloom.addColorStop(0, palette.mid);
  lowerBloom.addColorStop(0.56, palette.edge);
  lowerBloom.addColorStop(1, "rgba(0, 0, 0, 0)");
  context.fillStyle = lowerBloom;
  context.fillRect(0, 0, 256, 256);
  AURA_SPRITES.set(key, canvas);
  return canvas;
}

function drawHoverLabel(
  context: CanvasRenderingContext2D,
  node: ProjectedNode,
  width: number,
  height: number,
  lightTheme: boolean
) {
  const label = node.kind === "source" ? node.label : `/${node.label}`;
  context.save();
  context.font = "650 11px 'Segoe UI Variable Text', 'Microsoft YaHei UI', sans-serif";
  const textWidth = context.measureText(label).width;
  const boxWidth = Math.min(textWidth + 20, 240);
  const x = clamp(node.screenX + 16, 10, width - boxWidth - 10);
  const y = clamp(node.screenY - 26, 18, height - 18);
  context.fillStyle = lightTheme ? "rgba(249, 252, 250, .92)" : "rgba(5, 14, 15, .9)";
  roundRect(context, x, y - 16, boxWidth, 28, 14);
  context.fill();
  context.fillStyle = lightTheme ? "#10201e" : "#f1faf8";
  context.fillText(truncateText(context, label, boxWidth - 20), x + 10, y + 2);
  context.restore();
}

function drawRelationshipPulse(
  context: CanvasRenderingContext2D,
  from: ProjectedNode,
  to: ProjectedNode,
  controlX: number,
  controlY: number,
  edgeIndex: number,
  time: number,
  lightTheme: boolean
) {
  const progress = time === 0 ? 0.52 : (time * 0.00038 + edgeIndex * 0.137) % 1;
  const inverse = 1 - progress;
  const x = inverse * inverse * from.screenX + 2 * inverse * progress * controlX + progress * progress * to.screenX;
  const y = inverse * inverse * from.screenY + 2 * inverse * progress * controlY + progress * progress * to.screenY;
  context.beginPath();
  context.arc(x, y, 4, 0, Math.PI * 2);
  context.fillStyle = `hsla(${to.hue}, 94%, ${lightTheme ? 40 : 82}%, .12)`;
  context.fill();
  context.beginPath();
  context.arc(x, y, 1.25, 0, Math.PI * 2);
  context.fillStyle = `hsla(${to.hue}, 98%, ${lightTheme ? 34 : 88}%, .96)`;
  context.fill();
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
    return clamp(6.2 + Math.log10(node.stars + 1) * 2.4 + Math.sqrt(node.childCount) * 0.18, 7, 19) * perspectiveScale;
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
  if (isRouter(skill)) {
    const byRouterName = lookup.get(normalize(skill.name)) ?? lookup.get(normalize(skill.folderName));
    if (byRouterName) return byRouterName;
  }
  const direct = lookup.get(normalize(skill.source));
  if (direct) return direct;
  const path = normalize(skill.relativePath);
  return sources.find(source => path.startsWith(`${normalize(source.name)}/`) || path.includes(`/${normalize(source.name)}/`));
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
  const haystack = normalize([skill.name, skill.source, skill.description, ...skill.tags].join(" "));
  const match = CATEGORY_RULES.find(rule => rule.keywords.some(keyword => haystack.includes(keyword)));
  if (match && SPECIALIZED_CATEGORIES.has(match.category)) return match.category;
  const explicit = normalize(skill.category);
  if (explicit && !["auto", "local", "other"].includes(explicit)) return explicit;
  return match?.category ?? "general";
}

function isRouter(skill: SkillCard) {
  if (typeof skill.isRouterHub === "boolean") return skill.isRouterHub;
  return skill.description.includes("[ROUTER-HUB]") || skill.relativePath.includes("AI-SkillHub-local-routers");
}

function cleanDescription(value: string) {
  return value.replace(/^\s*\[(?:ROUTER-HUB|CHILD-SKILL)\]\s*/i, "").trim();
}

function nodeKindLabel(kind: UniverseNodeKind) {
  if (kind === "source") return t("universe.kind.source");
  if (kind === "router") return t("universe.kind.router");
  return t("universe.kind.skill");
}

function displayCategory(category: string) {
  return categoryName(category) ?? category;
}

function categoryHue(category: string) {
  return CATEGORY_HUES[normalize(category)] ?? (stableHash(category) * 47 + 162) % 360;
}

function clusterHue(category: string, sourceId: string) {
  const normalizedCategory = normalize(category);
  const hash = stableHash(`${normalizedCategory}:${sourceId}`);
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

const CATEGORY_RULES = [
  { category: "life-sciences", keywords: ["bioinformatics", "genomics", "protein", "molecular", "alphafold", "生物", "基因", "蛋白"] },
  { category: "clinical-medical", keywords: ["clinical", "medical", "drug", "fda", "clinvar", "医学", "临床", "药物"] },
  { category: "finance-economics", keywords: ["finance", "financial", "economic", "stock", "edgar", "金融", "经济"] },
  { category: "document-tools", keywords: ["document", "pdf", "docx", "spreadsheet", "文档", "表格"] },
  { category: "browser-automation", keywords: ["browser", "playwright", "chrome", "automation", "浏览器", "自动化"] },
  { category: "image-generation", keywords: ["image", "diffusion", "imagegen", "图像生成"] },
  { category: "academic-writing", keywords: ["paper", "academic", "writing", "论文", "学术"] },
  { category: "literature-research", keywords: ["literature", "citation", "pubmed", "文献"] },
  { category: "scientific-figures", keywords: ["figure", "plot", "chart", "绘图", "图表"] },
  { category: "ui-design", keywords: ["ui", "ux", "design", "frontend", "设计"] },
  { category: "security-audit", keywords: ["security", "audit", "vulnerability", "安全"] },
  { category: "knowledge-retrieval", keywords: ["retrieval", "search", "database", "检索"] },
  { category: "presentations", keywords: ["presentation", "slides", "ppt", "汇报"] },
  { category: "prompt-polishing", keywords: ["prompt", "polish", "提示词"] },
  { category: "data-analysis", keywords: ["analysis", "rnaseq", "pandas", "数据"] },
  { category: "development", keywords: ["code", "engineering", "react", "rust", "开发"] },
  { category: "agent-tools", keywords: ["agent", "claude", "codex", "tool", "智能体"] }
];

const SPECIALIZED_CATEGORIES = new Set([
  "life-sciences",
  "clinical-medical",
  "finance-economics",
  "document-tools",
  "browser-automation",
  "image-generation"
]);

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
