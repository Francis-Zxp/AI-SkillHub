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
type UniverseModel = {
  categories: Array<{ category: string; count: number; hue: number }>;
  edges: UniverseEdge[];
  nodes: UniverseNode[];
  parentEdges: number;
  relationEdges: number;
  sourceCount: number;
};
type ProjectedNode = UniverseNode & { depth: number; radius: number; screenX: number; screenY: number };
type UniverseRuntime = {
  centerX: number;
  centerY: number;
  dragged: boolean;
  dragging: boolean;
  dragStartX: number;
  dragStartY: number;
  hoverId: string;
  pointerX: number;
  pointerY: number;
  pointerInside: boolean;
  positions: Map<string, Point3>;
  projectedById: Map<string, ProjectedNode>;
  projected: ProjectedNode[];
  frameIndex: number;
  frameMs: number;
  interactionUntil: number;
  lastFrame: number;
  lastPointerTime: number;
  quality: number;
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

const SPHERE_SHELL = Array.from({ length: 288 }, (_, index) => fibonacciPoint(index, 288, 1));
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
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    const host = canvas?.parentElement;
    if (!canvas || !host) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const projected = model.nodes.map(node => ({ ...node, depth: 0, radius: 0, screenX: 0, screenY: 0 }));
    const runtime: UniverseRuntime = {
      centerX: 0,
      centerY: 0,
      dragged: false,
      dragging: false,
      dragStartX: 0,
      dragStartY: 0,
      hoverId: "",
      frameIndex: 0,
      frameMs: 16.7,
      interactionUntil: 0,
      lastFrame: 0,
      lastPointerTime: 0,
      pointerX: 0,
      pointerY: 0,
      pointerInside: false,
      positions: new Map(model.nodes.map(node => [node.id, { ...node.positions[modeRef.current] }])),
      projected,
      projectedById: new Map(projected.map(node => [node.id, node])),
      quality: 1,
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
    let width = 1;
    let height = 1;
    let dpr = 1;

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
    };

    const draw = (time: number) => {
      if (!visible) return;
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
      if (!reducedMotion) frame = window.requestAnimationFrame(draw);
    };

    const onVisibility = () => {
      visible = !document.hidden;
      window.cancelAnimationFrame(frame);
      if (visible && !reducedMotion) frame = window.requestAnimationFrame(draw);
    };

    const observer = new ResizeObserver(resize);
    observer.observe(host);
    document.addEventListener("visibilitychange", onVisibility);
    resize();
    draw(reducedMotion ? 0 : performance.now());
    if (!reducedMotion) frame = window.requestAnimationFrame(draw);

    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      window.cancelAnimationFrame(frame);
      if (runtimeRef.current === runtime) runtimeRef.current = null;
    };
  }, [lightTheme, model, tone]);

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
      runtime.rotationY += dx * 0.0048;
      runtime.rotationX = clamp(runtime.rotationX + dy * 0.004, -1.05, 1.05);
      runtime.velocityY = clamp((dx * 0.0048) / elapsed, -0.004, 0.004);
      runtime.velocityX = clamp((dy * 0.004) / elapsed, -0.003, 0.003);
      runtime.lastPointerTime = now;
      runtime.interactionUntil = now + 180;
      runtime.dragged ||= Math.abs(runtime.pointerX - runtime.dragStartX) + Math.abs(runtime.pointerY - runtime.dragStartY) > 5;
      canvas.style.cursor = "grabbing";
      updateHover(null);
      return;
    }

    const hit = findHit(runtime, runtime.pointerX, runtime.pointerY);
    runtime.hoverId = hit?.id ?? "";
    canvas.style.cursor = hit ? "pointer" : "grab";
    updateHover(hit);
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
    runtime.lastPointerTime = performance.now();
    runtime.interactionUntil = runtime.lastPointerTime + 180;
    canvas.style.cursor = "grabbing";
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
  };

  const leaveGraph = () => {
    const runtime = runtimeRef.current;
    if (runtime) runtime.pointerInside = false;
    if (!runtime?.dragging) {
      if (runtime) runtime.hoverId = "";
      updateHover(null);
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
  return {
    categories: [...categoryCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([category, count]) => ({ category, count, hue: categoryHue(category) })),
    edges,
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
    if (runtime.frameIndex % 45 === 0) {
      const targetQuality = runtime.frameMs > 24 ? 0.58 : runtime.frameMs > 19.5 ? 0.78 : 1;
      runtime.quality += (targetQuality - runtime.quality) * 0.5;
      context.canvas.dataset.frameMs = runtime.frameMs.toFixed(1);
      context.canvas.dataset.renderQuality = runtime.quality.toFixed(2);
    }
    if (!runtime.dragging) {
      runtime.rotationY += runtime.velocityY * elapsed;
      runtime.rotationX = clamp(runtime.rotationX + runtime.velocityX * elapsed, -1.05, 1.05);
      const drag = Math.exp(-elapsed * 0.0075);
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
  const rotationY = runtime.rotationY;
  const rotationX = runtime.rotationX + (time === 0 ? 0 : Math.sin(time * 0.00009) * 0.025);

  drawUniverseAtmosphere(context, centerX, centerY, radius, lightTheme, tone, time, rotationX, rotationY, runtime.quality, interactive);

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
  for (let edgeIndex = 0; edgeIndex < model.edges.length; edgeIndex += 1) {
    const edge = model.edges[edgeIndex];
    if (!edgeVisible(edge.kind, mode, runtime.hoverId, edge)) continue;
    const from = runtime.projectedById.get(edge.from);
    const to = runtime.projectedById.get(edge.to);
    if (!from || !to || from.depth < 0.1 || to.depth < 0.1) continue;
    const highlighted = Boolean(runtime.hoverId && (from.id === runtime.hoverId || to.id === runtime.hoverId));
    if (interactive && !highlighted && (edge.kind !== "parent" || edgeIndex % 2 === 1)) continue;
    if (!interactive && runtime.quality < 0.72 && !highlighted && edge.kind === "category") continue;
    const alpha = edgeAlpha(edge.kind, mode, highlighted) * Math.min(from.depth, to.depth);
    context.beginPath();
    context.moveTo(from.screenX, from.screenY);
    const bend = edge.kind === "parent" ? 0.025 : edge.kind === "conflict" ? 0.085 : 0.05;
    context.quadraticCurveTo(
      (from.screenX + to.screenX) / 2 + (to.screenY - from.screenY) * bend,
      (from.screenY + to.screenY) / 2 - (to.screenX - from.screenX) * bend,
      to.screenX,
      to.screenY
    );
    context.strokeStyle = edge.kind === "conflict"
      ? `rgba(255, 177, 105, ${alpha})`
      : `hsla(${to.hue}, 78%, ${lightTheme ? 38 : 70}%, ${alpha})`;
    context.lineWidth = highlighted ? 1.45 : edge.kind === "parent" ? 0.68 : 0.48;
    if (edge.kind === "conflict") context.setLineDash([4, 5]);
    context.stroke();
    context.setLineDash([]);
  }
  context.restore();

  runtime.projected.sort((a, b) => a.depth - b.depth);
  for (const node of runtime.projected) {
    drawUniverseNode(context, node, runtime.hoverId === node.id, lightTheme, time, runtime.quality, interactive);
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
  interactive: boolean
) {
  const atmosphere =
    tone === "prism"
      ? {
          center: lightTheme ? "rgba(64, 104, 184, .13)" : "rgba(161, 190, 255, .16)",
          mid: lightTheme ? "rgba(127, 91, 166, .055)" : "rgba(112, 90, 190, .07)",
          edge: "rgba(71, 117, 198, .025)",
          line: lightTheme ? "rgba(54, 83, 145, .12)" : "rgba(165, 194, 255, .11)",
          shell: lightTheme ? "rgba(60, 85, 136, .34)" : "rgba(221, 232, 255, .42)",
          dust: lightTheme ? "rgba(77, 91, 131, .22)" : "rgba(202, 217, 255, .28)"
        }
      : tone === "parchment"
        ? {
            center: "rgba(154, 78, 48, .12)",
            mid: "rgba(68, 91, 112, .055)",
            edge: "rgba(122, 87, 55, .025)",
            line: "rgba(122, 75, 49, .12)",
            shell: "rgba(97, 73, 55, .32)",
            dust: "rgba(108, 78, 55, .2)"
          }
        : {
            center: lightTheme ? "rgba(23, 121, 111, .15)" : "rgba(205, 255, 249, .18)",
            mid: lightTheme ? "rgba(41, 90, 128, .065)" : "rgba(68, 188, 180, .072)",
            edge: lightTheme ? "rgba(41, 90, 128, .025)" : "rgba(88, 129, 166, .026)",
            line: lightTheme ? "rgba(25, 105, 99, .12)" : "rgba(176, 239, 232, .12)",
            shell: lightTheme ? "rgba(27, 98, 93, .34)" : "rgba(213, 246, 242, .4)",
            dust: lightTheme ? "rgba(22, 93, 88, .22)" : "rgba(212, 247, 243, .26)"
          };
  const aura = context.createRadialGradient(centerX, centerY, radius * 0.02, centerX, centerY, radius * 1.28);
  aura.addColorStop(0, atmosphere.center);
  aura.addColorStop(0.28, atmosphere.mid);
  aura.addColorStop(0.68, atmosphere.edge);
  aura.addColorStop(1, "rgba(0, 0, 0, 0)");
  context.fillStyle = aura;
  context.fillRect(centerX - radius * 1.35, centerY - radius * 1.35, radius * 2.7, radius * 2.7);

  context.save();
  context.translate(centerX, centerY);
  context.rotate(time * 0.000006);
  context.strokeStyle = atmosphere.line;
  context.lineWidth = 0.7;
  for (let ring = 0; ring < 3; ring += 1) {
    context.save();
    context.rotate((ring - 1) * 0.42 + time * 0.000002 * (ring + 1));
    context.scale(1, 0.48 + ring * 0.12);
    context.beginPath();
    context.arc(0, 0, radius * (0.72 + ring * 0.14), 0, Math.PI * 2);
    context.stroke();
    context.restore();
  }
  context.restore();

  const cosX = Math.cos(rotationX);
  const sinX = Math.sin(rotationX);
  const cosY = Math.cos(rotationY);
  const sinY = Math.sin(rotationY);
  const shellStep = interactive || quality < 0.72 ? 2 : 1;
  context.save();
  context.fillStyle = atmosphere.shell;
  for (let index = 0; index < SPHERE_SHELL.length; index += shellStep) {
    const point = SPHERE_SHELL[index];
    const y0 = point.y * cosX - point.z * sinX;
    const z0 = point.y * sinX + point.z * cosX;
    const x = point.x * cosY + z0 * sinY;
    const z = -point.x * sinY + z0 * cosY;
    const scale = 3.05 / (3.05 - z);
    const size = (z > 0 ? 0.9 : 0.48) * scale;
    context.globalAlpha = z > 0 ? 0.86 : 0.34;
    context.fillRect(centerX + x * radius * scale, centerY + y0 * radius * scale, size, size);
  }
  context.restore();

  context.save();
  context.fillStyle = atmosphere.dust;
  const dustCount = interactive ? 32 : Math.round(DUST_PARTICLES.length * quality);
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

function drawUniverseNode(
  context: CanvasRenderingContext2D,
  node: ProjectedNode,
  highlighted: boolean,
  lightTheme: boolean,
  time: number,
  quality: number,
  interactive: boolean
) {
  const hue = node.hue;
  const baseAlpha = node.enabled ? 0.5 + node.depth * 0.44 : 0.2;
  const pulse = time === 0 ? 1 : 0.96 + Math.sin(time * 0.00092 + node.seed) * 0.04;
  const radius = node.radius * (highlighted ? 1.34 : pulse);
  const lightness = lightTheme ? 43 : 67;

  if (node.kind === "source") {
    const halo = radius * (2.5 + Math.min(1.25, Math.log10(node.stars + 1) * 0.16));
    const glow = context.createRadialGradient(
      node.screenX,
      node.screenY,
      radius * 0.1,
      node.screenX,
      node.screenY,
      halo
    );
    glow.addColorStop(0, `hsla(${hue}, 82%, ${lightness + 8}%, ${highlighted ? 0.28 : 0.16})`);
    glow.addColorStop(0.42, `hsla(${hue}, 78%, ${lightness}%, ${highlighted ? 0.12 : 0.055})`);
    glow.addColorStop(1, `hsla(${hue}, 76%, ${lightness}%, 0)`);
    context.beginPath();
    context.arc(node.screenX, node.screenY, halo, 0, Math.PI * 2);
    context.fillStyle = glow;
    context.fill();
  }

  context.save();
  context.globalCompositeOperation = "source-over";
  if (highlighted) {
    context.beginPath();
    context.arc(node.screenX, node.screenY, radius * 2.25, 0, Math.PI * 2);
    context.fillStyle = `hsla(${hue}, 88%, ${lightness}%, .11)`;
    context.fill();
  }
  if (node.kind === "source") {
    context.save();
    context.translate(node.screenX, node.screenY);
    context.rotate(((node.seed % 29) - 14) * 0.01);
    context.beginPath();
    context.ellipse(0, 0, radius * 1.08, radius * 0.76, 0, 0, Math.PI * 2);
    context.fillStyle = `hsla(${hue}, ${lightTheme ? 70 : 82}%, ${lightTheme ? 39 : 64}%, ${baseAlpha})`;
    context.fill();
    context.beginPath();
    context.ellipse(-radius * 0.18, -radius * 0.12, radius * 0.42, radius * 0.2, -0.12, 0, Math.PI * 2);
    context.fillStyle = `rgba(255, 255, 255, ${lightTheme ? 0.42 : 0.72})`;
    context.fill();
    context.restore();
    context.beginPath();
    context.arc(node.screenX, node.screenY, radius + 4, 0, Math.PI * 2);
    context.strokeStyle = `hsla(${hue}, 84%, ${lightTheme ? 34 : 74}%, ${highlighted ? 0.88 : 0.38})`;
    context.lineWidth = 0.8;
    context.stroke();
  } else if (node.kind === "router") {
    drawPolygonPath(context, node.screenX, node.screenY, radius, 6, Math.PI / 6);
    context.fillStyle = `hsla(${hue}, 76%, ${lightness}%, ${highlighted ? 1 : baseAlpha})`;
    context.fill();
    drawPolygonPath(context, node.screenX, node.screenY, radius + 5, 6, Math.PI / 6);
    context.strokeStyle = `hsla(${hue}, 76%, ${lightTheme ? 34 : 78}%, ${highlighted ? 0.82 : 0.34})`;
    context.lineWidth = 1;
    context.stroke();
    if (!interactive && quality > 0.7) {
      context.beginPath();
      context.arc(node.screenX, node.screenY, radius + 9, -0.2, 3.8);
      context.strokeStyle = `hsla(${hue}, 78%, ${lightTheme ? 38 : 80}%, ${highlighted ? 0.46 : 0.17})`;
      context.lineWidth = 0.7;
      context.stroke();
    }
  } else {
    context.beginPath();
    context.arc(node.screenX, node.screenY, radius, 0, Math.PI * 2);
    context.fillStyle = `hsla(${hue}, ${lightTheme ? 72 : 78}%, ${lightness}%, ${highlighted ? 1 : baseAlpha})`;
    context.fill();
    if (node.rating >= 4 || highlighted) {
      context.beginPath();
      context.arc(node.screenX, node.screenY, radius + 2.2, 0, Math.PI * 2);
      context.strokeStyle = `hsla(${hue}, 72%, ${lightTheme ? 34 : 82}%, ${highlighted ? 0.68 : 0.24})`;
      context.lineWidth = 0.65;
      context.stroke();
    }
  }

  if (node.kind === "source") {
    if (!interactive && quality > 0.72) {
      const orbit = radius + 9 + Math.log10(node.stars + 1) * 0.7;
      const markerAngle = time * 0.00032 + (node.seed % 360);
      context.beginPath();
      context.arc(node.screenX, node.screenY, orbit, markerAngle + 0.35, markerAngle + 4.8);
      context.strokeStyle = `hsla(${hue}, 88%, ${lightTheme ? 38 : 82}%, .34)`;
      context.lineWidth = 0.65;
      context.stroke();
      context.beginPath();
      context.arc(node.screenX + Math.cos(markerAngle) * orbit, node.screenY + Math.sin(markerAngle) * orbit, 1.25, 0, Math.PI * 2);
      context.fillStyle = `hsla(${hue}, 92%, ${lightTheme ? 36 : 82}%, .88)`;
      context.fill();
    }
  }
  context.restore();
}

function drawPolygonPath(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  sides: number,
  rotation = 0
) {
  context.beginPath();
  for (let index = 0; index < sides; index += 1) {
    const angle = rotation + (index / sides) * Math.PI * 2;
    const pointX = x + Math.cos(angle) * radius;
    const pointY = y + Math.sin(angle) * radius;
    if (index === 0) context.moveTo(pointX, pointY);
    else context.lineTo(pointX, pointY);
  }
  context.closePath();
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

function edgeVisible(kind: UniverseEdgeKind, mode: SkillUniverseMode, hoverId: string, edge: UniverseEdge) {
  if (hoverId && (edge.from === hoverId || edge.to === hoverId)) return true;
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
