// Home page (skills contract §6.2): four clickable numbers, the first-run or "new tool"
// card, the 添加 box, then the islands / star map as an optional visual layer, usage
// insights and recent activity. App owns the state; never import from App.tsx here.
import {
  type CSSProperties,
  Fragment,
  Suspense,
  type PointerEvent,
  lazy,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { Icon } from "../icons";
import { CountUp, ParticleField } from "../effects";
import { getLang, t } from "../i18n";
import { localizedSkillDescription } from "../localizedDescriptions";
import type { SkillCounts } from "../skillCounts";
import type { LegacySnapshot, LegacySummary, SkillAgent, SkillCard, SkillDeliveryState, SourceCard, SourcePopularityCard } from "../types";
import {
  type ThemeName,
  type SkyPhase,
  isAtlasTheme,
  atlasThemeVisual,
  normalizeLookup,
  isRouterHubSkill,
  inferCategoryIds,
  displayCategoryName,
  formatScanTime,
  formatCompactNumber
} from "../appShared";
import { SegmentedToggle, Metric } from "../components/ui";
import { AgentGlyph } from "../components/shell";
import "./home.css";

const SkillArchipelago = lazy(() => import("../SkillArchipelago").then(module => ({ default: module.SkillArchipelago })));
const SkillUniverse = lazy(() => import("../SkillUniverse").then(module => ({ default: module.SkillUniverse })));

type HomeVisual = "islands" | "universe" | "off";

const ATLAS_INTRO_VISIBILITY_KEY = "ai-skillhub-atlas-intro-visible";
const DISMISSED_AGENT_CARDS_KEY = "ai-skillhub-dismissed-agent-cards";

function readDismissedAgents(): string[] {
  try {
    const raw = window.localStorage.getItem(DISMISSED_AGENT_CARDS_KEY);
    const value = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, 40) : [];
  } catch {
    return [];
  }
}

/* =============================================================
   Home
   ============================================================= */

export function Dashboard({
  counts,
  delivery,
  homeVisual,
  immersive,
  loading,
  mcpCount,
  onAdd,
  onChangeHomeVisual,
  onCopySkill,
  onOpenAgents,
  onOpenFolder,
  onOpenLibrary,
  onOpenMcp,
  onOpenOnboarding,
  onOpenProblems,
  onOpenSkill,
  onOpenSource,
  onRefreshPopularity,
  onTakeover,
  onToggleImmersive,
  popularityRefreshing,
  snapshot,
  summary,
  theme
}: {
  counts: SkillCounts;
  delivery: SkillDeliveryState | null;
  homeVisual: HomeVisual;
  immersive: boolean;
  loading: boolean;
  mcpCount: number | null;
  onAdd: () => void;
  onChangeHomeVisual: (value: HomeVisual) => void;
  onCopySkill: (skill: SkillCard) => void;
  onOpenAgents: () => void;
  onOpenFolder: (folderId: string) => void;
  onOpenLibrary: () => void;
  onOpenMcp: () => void;
  onOpenOnboarding: () => void;
  onOpenProblems: () => void;
  onOpenSkill: (skill: SkillCard) => void;
  onOpenSource: (source: SourceCard) => void;
  onRefreshPopularity: () => void;
  onTakeover: (agent: SkillAgent) => void;
  onToggleImmersive: () => void;
  popularityRefreshing: boolean;
  snapshot: LegacySnapshot | null;
  summary: LegacySummary;
  theme: ThemeName;
}) {
  const [atlasIntroVisible, setAtlasIntroVisible] = useState(() => {
    try {
      return window.localStorage.getItem(ATLAS_INTRO_VISIBILITY_KEY) !== "false";
    } catch {
      return true;
    }
  });
  const [dismissedAgents, setDismissedAgents] = useState<string[]>(() => readDismissedAgents());
  const agents = delivery?.agents ?? [];
  const installedDeliverable = agents.filter(agent => agent.installed && agent.canDeliver);
  const taken = installedDeliverable.filter(agent => agent.takeover).length;
  const problems = delivery?.problems.length ?? 0;
  const discovered = agents.filter(agent => agent.statusWord === "available" && !dismissedAgents.includes(agent.id));
  const onboardingPending = delivery?.onboarding === "pending";
  const atlasMode = isAtlasTheme(theme);
  const atlasVisual = atlasThemeVisual(theme);
  const sceneVisual: HomeVisual = atlasMode ? homeVisual : "off";
  const emptyLibrary = !loading && counts.rows === 0;
  const toggleAtlasIntro = () => {
    const next = !atlasIntroVisible;
    setAtlasIntroVisible(next);
    try {
      window.localStorage.setItem(ATLAS_INTRO_VISIBILITY_KEY, String(next));
    } catch {
      // The visual preference can remain session-only when storage is unavailable.
    }
  };
  const dismissAgentCard = (agentId: string) => {
    const next = [...dismissedAgents, agentId];
    setDismissedAgents(next);
    try {
      window.localStorage.setItem(DISMISSED_AGENT_CARDS_KEY, JSON.stringify(next));
    } catch {
      // Dismissal lasts for this session when storage is unavailable.
    }
  };

  return (
    <div className="view dashboard-view home-v33">
      <div className="home-top">
      <section className="home-metrics" aria-label={t("v33.homeMetrics")}>
        <Metric
          icon="agent"
          label={t("v33.metricAgents")}
          onClick={onOpenAgents}
          suffix={`/${installedDeliverable.length}`}
          testId="home-metric-agents"
          trend={installedDeliverable.length === 0 ? t("v33.metricAgentsNone") : t("v33.metricAgentsTrend")}
          value={taken}
        />
        <Metric
          icon="sparkle"
          label={t("v33.metricSkills")}
          onClick={onOpenLibrary}
          testId="home-metric-skills"
          trend={counts.updateRows > 0 ? t("v33.metricSkillsUpdates", { n: counts.updateRows }) : t("v33.metricSkillsPacks", { n: counts.packs })}
          value={counts.skills}
        />
        <Metric
          icon="plug"
          label={t("v33.metricMcp")}
          onClick={onOpenMcp}
          testId="home-metric-mcp"
          trend={mcpCount === null ? t("v33.metricMcpOpen") : t("v33.metricMcpTrend")}
          value={mcpCount ?? 0}
        />
        <Metric
          icon="alert"
          label={t("v33.metricProblems")}
          onClick={onOpenProblems}
          testId="home-metric-problems"
          tone={problems > 0 ? "alert" : ""}
          trend={problems > 0 ? t("v33.metricProblemsTrend") : t("v33.metricProblemsNone")}
          value={problems}
        />
      </section>

      <div className="home-row">
      {onboardingPending ? (
        <section className="home-card first-run" data-testid="home-first-run-card">
          <Icon name="sparkle" />
          <div>
            <strong>{t("v33.firstRunTitle", { n: installedDeliverable.length })}</strong>
            <span>{t("v33.firstRunBody")}</span>
          </div>
          <button className="primary-action" onClick={onOpenOnboarding} type="button">{t("v33.firstRunAction")}</button>
        </section>
      ) : discovered.length > 0 ? (
        <section className="home-card discover" data-testid="home-discover-card">
          <AgentGlyph agentId={discovered[0].id} name={discovered[0].name} />
          <div>
            <strong>{t("v33.discoverOne", { name: discovered[0].name })}</strong>
            <span>{discovered[0].experimental ? t("v33.experimentalShort") : t("v33.discoverBody")}</span>
          </div>
          <button className="primary-action small" onClick={() => onTakeover(discovered[0])} type="button">{t("v33.takeover")}</button>
          <button
            aria-label={t("v33.dismiss")}
            className="icon-action"
            onClick={() => dismissAgentCard(discovered[0].id)}
            title={t("v33.dismiss")}
            type="button"
          >
            <Icon name="close" />
          </button>
        </section>
      ) : null}

      <section className="home-add" aria-label={t("v33.add")}>
        <Icon name="add" />
        <input
          aria-label={t("v33.addPlaceholder")}
          data-testid="home-add-input"
          onClick={onAdd}
          onFocus={event => {
            event.currentTarget.blur();
            onAdd();
          }}
          placeholder={t("v33.addPlaceholder")}
          readOnly
          value=""
        />
        <button className="primary-action small" onClick={onAdd} type="button">{t("v33.add")}</button>
      </section>
      </div>

      {emptyLibrary && (
        <section className="home-card empty" data-testid="home-empty-card">
          <Icon name="library" />
          <div>
            <strong>{t("v33.emptyLibraryTitle")}</strong>
            <span>{t("v33.emptyLibraryBody")}</span>
          </div>
          <button className="primary-action small" onClick={onAdd} type="button">{t("v33.add")}</button>
        </section>
      )}
      </div>

      <section className={`dashboard-hero glow-card${sceneVisual === "off" ? " scene-off" : ""}${atlasMode && (!atlasIntroVisible || sceneVisual === "islands") ? " intro-collapsed" : ""}${sceneVisual === "islands" ? " islands-home" : " universe-home"}`}>
        {sceneVisual === "islands" && (
          <Suspense fallback={<p role="status">{t("dash.loadingIndex")}</p>}>
            <SkillArchipelago visible centered lightTheme={isLightTheme(theme)} phase={theme.startsWith("sky-") ? (theme.slice(4) as SkyPhase) : isLightTheme(theme) ? "noon" : "night"} tone="mist" onOpenSkill={onOpenSkill} onOpenSource={onOpenSource} onOpenFolder={onOpenFolder} snapshot={snapshot} />
          </Suspense>
        )}
        {sceneVisual === "universe" && (
          <Suspense fallback={<p role="status">{t("dash.loadingIndex")}</p>}>
            <SkillUniverse
              visible
              centered={!atlasIntroVisible}
              lightTheme={isLightTheme(theme)}
              onOpenSkill={onOpenSkill}
              onOpenSource={onOpenSource}
              snapshot={snapshot}
              tone={
                theme.startsWith("sky-")
                  ? "sky"
                  : theme === "nocturne"
                  ? "prism"
                  : theme === "parchment"
                    ? "parchment"
                    : theme === "atlas-light" || theme === "atlas-legacy-light"
                      ? "mist"
                      : "biolume"
              }
            />
          </Suspense>
        )}
        {!atlasMode && (
          <ParticleField
            accent={atlasVisual.accent}
            mode="ambient"
            palette={atlasVisual.palette}
            sourceCount={summary.sources}
            skillCount={summary.skills}
          />
        )}
        {atlasMode && (
          <div className="home-visual-switch" aria-label={t("v33.homeScene")}>
            <SegmentedToggle
              label={t("v33.homeScene")}
              onChange={onChangeHomeVisual}
              options={[
                { value: "islands", label: t("v33.sceneIslands") },
                { value: "universe", label: t("v33.sceneStars") },
                { value: "off", label: t("v33.sceneOff") }
              ]}
              value={homeVisual}
            />
          </div>
        )}
        {atlasMode && sceneVisual !== "off" && (
          <button
            aria-pressed={immersive}
            className="atlas-immersive-toggle"
            onClick={onToggleImmersive}
            title={immersive ? t("atlas.exitImmersive") : t("atlas.enterImmersive")}
            type="button"
          >
            <Icon name={immersive ? "exitFullscreen" : "fullscreen"} />
            <span>{immersive ? t("atlas.exitImmersive") : t("atlas.enterImmersive")}</span>
          </button>
        )}
        {atlasMode && sceneVisual === "universe" && (
          <button
            aria-pressed={!atlasIntroVisible}
            className="atlas-intro-toggle"
            onClick={toggleAtlasIntro}
            title={atlasIntroVisible ? t("atlas.hideIntro") : t("atlas.showIntro")}
            type="button"
          >
            <Icon name="info" />
            <span>{atlasIntroVisible ? t("atlas.hideIntro") : t("atlas.showIntro")}</span>
          </button>
        )}
        {sceneVisual === "off" && atlasMode && (
          <p className="scene-off-note">{t("v33.sceneOffNote")}</p>
        )}
        <div aria-hidden={atlasMode && (!atlasIntroVisible || sceneVisual !== "universe")} className="dashboard-hero-inner">
          <div className="atlas-hero-copy">
            <h2>{atlasMode ? t("atlas.heroTitle") : t("dash.title")}</h2>
            <p>{atlasMode ? t("v33.heroSubtitle", { skills: counts.skills, packs: counts.packs }) : t("dash.subtitle")}</p>
          </div>
        </div>
      </section>

      {!atlasMode && (
        <SkillShowcase
          loading={loading}
          onCopySkill={onCopySkill}
          onOpenLibrary={onOpenLibrary}
          snapshot={snapshot}
        />
      )}

      <section className="dashboard-grid">
        <UsageInsightPanel loading={popularityRefreshing} onRefreshPopularity={onRefreshPopularity} snapshot={snapshot} />
        <aside className="panel alerts-panel glow-card">
          <ActivityTimeline snapshot={snapshot} />
        </aside>
      </section>
    </div>
  );
}

function ActivityTimeline({ snapshot }: { snapshot: LegacySnapshot | null }) {
  const events = snapshot?.auditEvents ?? [];
  return (
    <section className="activity-timeline" aria-label={t("dash.activity")}>
      <header>
        <strong>{t("dash.activity")}</strong>
        <span>{t("dash.logs", { n: events.length })}</span>
      </header>
      <div>
        {events.slice(0, 4).map(event => (
          <article key={event.id}>
            <i />
            <div>
              <strong>{auditEventLabel(event.eventType)}</strong>
              <p>{event.summary}</p>
              <small>{formatScanTime(event.createdAt)}</small>
            </div>
          </article>
        ))}
        {events.length === 0 && <p className="empty-activity">{t("dash.noActivity")}</p>}
      </div>
    </section>
  );
}

/* =============================================================
   Skill showcase — the "wow" surface for installed skills
   ============================================================= */

function SkillShowcase({
  loading,
  onCopySkill,
  onOpenLibrary,
  snapshot
}: {
  loading: boolean;
  onCopySkill: (skill: SkillCard) => void;
  onOpenLibrary: () => void;
  snapshot: LegacySnapshot | null;
}) {
  const skills = snapshot?.skills ?? [];
  const sources = snapshot?.sources ?? [];
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const graphRef = useRef<SkillGraphRuntime | null>(null);
  // The language is a dependency: category names in the legend and canvas are translated (bug #3).
  const lang = getLang();
  const graphData = useMemo(() => buildSkillGraphData(skills, sources), [skills, sources, lang]);
  const categoryLegend = useMemo(() => buildConstellationLegend(skills, sources), [skills, sources, lang]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const host = canvas?.parentElement;
    if (!canvas || !host) return;

    const context = canvas.getContext("2d");
    if (!context) return;

    const runtime: SkillGraphRuntime = {
      dragStartX: 0,
      dragStartY: 0,
      dragged: false,
      dragging: false,
      hitNodes: [],
      hoverId: "",
      panX: 0,
      panY: 0,
      pointerX: 0,
      pointerY: 0,
      requestDraw: () => undefined
    };
    graphRef.current = runtime;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let frame = 0;
    let frameTimer = 0;
    let lastDrawAt = 0;
    let ambientUntil = performance.now() + 2400;
    let disposed = false;
    let pageVisible = !document.hidden;
    let focused = document.hasFocus();
    let intersecting = host.getClientRects().length > 0;

    const cancelScheduledDraw = () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(frameTimer);
      frame = 0;
      frameTimer = 0;
    };

    const canRender = () => !disposed && pageVisible && intersecting;

    const scheduleDraw = (urgent = false) => {
      if (!canRender() || frame || (!focused && !urgent)) return;
      if (!urgent && performance.now() >= ambientUntil) return;
      if (frameTimer) {
        if (!urgent) return;
        window.clearTimeout(frameTimer);
        frameTimer = 0;
      }
      const wait = urgent ? 0 : Math.max(0, 160 - (performance.now() - lastDrawAt));
      if (wait <= 1) {
        frame = window.requestAnimationFrame(draw);
        return;
      }
      frameTimer = window.setTimeout(() => {
        frameTimer = 0;
        if (canRender() && focused) frame = window.requestAnimationFrame(draw);
      }, wait);
    };

    const resizeCanvas = () => {
      const rect = host.getBoundingClientRect();
      const pixelBudgetScale = Math.sqrt(1_700_000 / Math.max(1, rect.width * rect.height));
      const ratio = Math.min(window.devicePixelRatio || 1, 2, pixelBudgetScale);
      canvas.width = Math.max(1, Math.floor(rect.width * ratio));
      canvas.height = Math.max(1, Math.floor(rect.height * ratio));
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      scheduleDraw(true);
    };

    const draw = (time: number) => {
      frame = 0;
      if (!canRender()) return;
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      context.clearRect(0, 0, width, height);
      drawSkillGraph(context, graphData, runtime, width, height, reducedMotion || !focused ? 0 : time);
      lastDrawAt = time;
      if (!reducedMotion && focused) scheduleDraw();
    };
    runtime.requestDraw = () => scheduleDraw(true);

    const onVisibility = () => {
      pageVisible = !document.hidden;
      cancelScheduledDraw();
      if (pageVisible) scheduleDraw(true);
    };

    const onFocus = () => {
      focused = true;
      ambientUntil = performance.now() + 800;
      lastDrawAt = 0;
      scheduleDraw(true);
    };

    const onBlur = () => {
      focused = false;
      cancelScheduledDraw();
    };

    const observer = new ResizeObserver(resizeCanvas);
    observer.observe(host);
    const intersectionObserver = new IntersectionObserver(entries => {
      intersecting = entries.some(entry => entry.isIntersecting);
      cancelScheduledDraw();
      if (intersecting) scheduleDraw(true);
    });
    intersectionObserver.observe(host);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    resizeCanvas();
    scheduleDraw(true);

    return () => {
      disposed = true;
      observer.disconnect();
      intersectionObserver.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
      cancelScheduledDraw();
      if (graphRef.current === runtime) graphRef.current = null;
    };
  }, [graphData]);

  const updateGraphHover = (event: PointerEvent<HTMLCanvasElement>) => {
    const runtime = graphRef.current;
    const canvas = canvasRef.current;
    if (!runtime || !canvas) return;
    const rect = canvas.getBoundingClientRect();
    runtime.pointerX = event.clientX - rect.left;
    runtime.pointerY = event.clientY - rect.top;
    if (runtime.dragging) {
      runtime.panX += event.movementX;
      runtime.panY += event.movementY;
      if (Math.abs(runtime.pointerX - runtime.dragStartX) + Math.abs(runtime.pointerY - runtime.dragStartY) > 4) {
        runtime.dragged = true;
      }
      canvas.style.cursor = "grabbing";
      runtime.requestDraw();
      return;
    }
    const hovered = findGraphHit(runtime, runtime.pointerX, runtime.pointerY);
    runtime.hoverId = hovered?.id ?? "";
    canvas.style.cursor = hovered?.skill ? "copy" : hovered?.kind === "source" ? "pointer" : "grab";
    runtime.requestDraw();
  };

  const startGraphDrag = (event: PointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0) return;
    const runtime = graphRef.current;
    const canvas = canvasRef.current;
    if (!runtime || !canvas) return;
    const rect = canvas.getBoundingClientRect();
    runtime.pointerX = event.clientX - rect.left;
    runtime.pointerY = event.clientY - rect.top;
    runtime.dragStartX = runtime.pointerX;
    runtime.dragStartY = runtime.pointerY;
    runtime.dragged = false;
    runtime.dragging = true;
    canvas.style.cursor = "grabbing";
    runtime.requestDraw();
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const endGraphDrag = (event: PointerEvent<HTMLCanvasElement>) => {
    const runtime = graphRef.current;
    const canvas = canvasRef.current;
    if (!runtime || !canvas) return;
    const hovered = findGraphHit(runtime, runtime.pointerX, runtime.pointerY);
    const wasDragged = runtime.dragged;
    runtime.dragging = false;
    runtime.dragged = false;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    canvas.style.cursor = hovered?.skill ? "copy" : hovered?.kind === "source" ? "pointer" : "grab";
    runtime.requestDraw();
    if (wasDragged || !hovered) return;
    if (hovered.skill) onCopySkill(hovered.skill);
    else if (hovered.kind === "source") onOpenLibrary();
  };

  return (
    <section className="skill-showcase glow-card">
      <header className="panel-head">
        <div>
          <span className="eyebrow"><Icon name="sparkle" /> {t("showcase.eyebrow")}</span>
          <h3>{t("showcase.title")}</h3>
          <p>{t("showcase.subtitle", { n: skills.length })}</p>
        </div>
        <button className="ghost-action" onClick={onOpenLibrary} type="button">
          <Icon name="library" /> <CountUp value={skills.length} />
        </button>
      </header>
      {loading && skills.length === 0 ? (
        <p className="skill-showcase-empty">{t("showcase.empty")}</p>
      ) : (
        <div className="skill-graph">
          <canvas
            aria-label={t("showcase.subtitle", { n: skills.length })}
            className="skill-graph-canvas"
            onPointerCancel={endGraphDrag}
            onPointerDown={startGraphDrag}
            onPointerLeave={updateGraphHover}
            onPointerMove={updateGraphHover}
            onPointerUp={endGraphDrag}
            ref={canvasRef}
            role="img"
          />
          <div className="skill-graph-meta" aria-hidden="true">
            <strong><CountUp value={skills.length} /></strong>
            <span>{t("showcase.nodes")}</span>
          </div>
          <div className="skill-graph-legend" aria-label={t("showcase.legend")}>
            {categoryLegend.map(item => (
              <span key={item.category} style={{ "--node-hue": `${item.hue}` } as CSSProperties}>
                <i />
                {item.label}
              </span>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

/* =============================================================
   Usage insights panel
   ============================================================= */

type UsageRange = "all" | "7d" | "30d";
type UsageViewMode = "heatmap" | "bars" | "trends";
type UsageHeatMetricKey = "usage" | "sevenDay" | "thirtyDay" | "stars" | "forks" | "skills";

function usageHeatMetrics(): Array<{ key: UsageHeatMetricKey; label: string }> {
  return [
    { key: "usage", label: t("usage.mUsage") },
    { key: "sevenDay", label: t("usage.m7") },
    { key: "thirtyDay", label: t("usage.m30") },
    { key: "stars", label: t("usage.mStars") },
    { key: "forks", label: t("usage.mForks") },
    { key: "skills", label: t("usage.mSkills") }
  ];
}

function UsageInsightPanel({
  loading,
  onRefreshPopularity,
  snapshot
}: {
  loading: boolean;
  onRefreshPopularity: () => void;
  snapshot: LegacySnapshot | null;
}) {
  const [range, setRange] = useState<UsageRange>("all");
  const [viewMode, setViewMode] = useState<UsageViewMode>("heatmap");
  const skills = snapshot?.skills ?? [];
  const sources = snapshot?.sources ?? [];
  const usageStats = snapshot?.usageStats ?? [];
  const sourcePopularity = snapshot?.sourcePopularity ?? [];
  const displaySources = useMemo(() => sources.filter(source => !isInternalRouterSource(source)), [sources]);
  const sourceScore = (source: { localTotalCount: number; localSevenDayCount: number; localThirtyDayCount: number }) => {
    if (range === "7d") return source.localSevenDayCount;
    if (range === "30d") return source.localThirtyDayCount;
    return source.localTotalCount;
  };
  const statScore = (stat: { totalCount: number; sevenDayCount: number; thirtyDayCount: number }) => {
    if (range === "7d") return stat.sevenDayCount;
    if (range === "30d") return stat.thirtyDayCount;
    return stat.totalCount;
  };
  const metrics = usageHeatMetrics();

  const heatRows = useMemo(() => {
    const rows: Array<{
      id: string;
      label: string;
      type: string;
      metrics: Record<UsageHeatMetricKey, number>;
    }> = [];
    const seen = new Set<string>();
    sourcePopularity.forEach(source => {
      const matched = displaySources.find(
        item => item.id === source.sourceId || item.name === source.sourceName
      );
      const id = source.sourceId || matched?.id || `${source.owner}/${source.repo}`;
      seen.add(id);
      if (matched) seen.add(matched.id);
      rows.push({
        id,
        label: sourcePopularityDisplayName(source),
        type: matched?.sourceType || "GitHub",
        metrics: {
          forks: source.forks,
          sevenDay: source.localSevenDayCount,
          skills: matched?.skillCount ?? 0,
          stars: source.stars,
          thirtyDay: source.localThirtyDayCount,
          usage: sourceScore(source)
        }
      });
    });
    displaySources.forEach(source => {
      if (seen.has(source.id) || rows.some(row => row.label === source.name)) return;
      const usage = usageStats.find(stat => stat.targetType === "source" && stat.targetId === source.id);
      rows.push({
        id: source.id,
        label: source.name,
        type: source.sourceType,
        metrics: {
          forks: 0,
          sevenDay: usage?.sevenDayCount ?? 0,
          skills: source.skillCount,
          stars: 0,
          thirtyDay: usage?.thirtyDayCount ?? 0,
          usage: usage ? statScore(usage) : 0
        }
      });
    });
    return rows.sort((a, b) => b.metrics.usage - a.metrics.usage || b.metrics.stars - a.metrics.stars);
  }, [displaySources, range, sourcePopularity, usageStats]);

  const heatMax = useMemo(
    () =>
      metrics.reduce<Record<UsageHeatMetricKey, number>>(
        (acc, metric) => {
          acc[metric.key] = Math.max(...heatRows.map(row => row.metrics[metric.key]), 1);
          return acc;
        },
        { forks: 1, sevenDay: 1, skills: 1, stars: 1, thirtyDay: 1, usage: 1 }
      ),
    [heatRows]
  );

  const rankedSkills = useMemo(() => {
    const statsBySkill = new Map(
      usageStats
        .filter(stat => stat.targetType === "skill")
        .map(stat => [stat.targetId, stat])
    );
    return skills
      .map(skill => {
        const stat = statsBySkill.get(skill.folderName) ?? statsBySkill.get(skill.name);
        return {
          id: skill.folderName,
          name: skill.name,
          category: skill.category,
          score: stat ? statScore(stat) : 0
        };
      })
      .filter(row => row.score > 0)
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  }, [range, skills, usageStats]);

  const rankedSources = sourcePopularity
    .map(source => ({ name: sourcePopularityDisplayName(source), stars: source.stars, score: sourceScore(source) }))
    .filter(row => row.stars > 0 || row.score > 0)
    .sort((a, b) => b.stars - a.stars || b.score - a.score);
  const maxSkillScore = Math.max(...rankedSkills.map(row => row.score), 1);
  const maxSourceHeat = Math.max(...rankedSources.map(row => Math.max(row.stars, row.score)), 1);
  const skillBarWidth = (score: number) => (score <= 0 ? "0%" : `${Math.max(6, Math.min(100, (score / maxSkillScore) * 100))}%`);
  const sourceBarWidth = (row: { score: number; stars: number }) => {
    const value = Math.max(row.stars, row.score);
    return value <= 0 ? "0%" : `${Math.max(6, Math.min(100, (value / maxSourceHeat) * 100))}%`;
  };

  return (
    <section className="usage-insight glow-card" aria-label="Usage insight panel">
      <header className="panel-head">
        <div>
          <span className="eyebrow">{t("usage.eyebrow")}</span>
          <h3>{t("usage.title")}</h3>
        </div>
        <div className="usage-toolbar">
          <SegmentedToggle
            value={range}
            options={[
              { value: "all", label: t("usage.rangeAll") },
              { value: "7d", label: t("usage.range7") },
              { value: "30d", label: t("usage.range30") }
            ]}
            onChange={value => setRange(value as UsageRange)}
          />
          <SegmentedToggle
            value={viewMode}
            options={[
              { value: "heatmap", label: t("usage.modeHeatmap") },
              { value: "bars", label: t("usage.modeBars") },
              { value: "trends", label: t("usage.modeTrends") }
            ]}
            onChange={value => setViewMode(value as UsageViewMode)}
          />
          <button className="ghost-action" disabled={loading} onClick={onRefreshPopularity} type="button">
            <Icon className={loading ? "icon-spin" : ""} name="refresh" /> {loading ? t("usage.refreshing") : t("usage.refresh")}
          </button>
        </div>
      </header>

      <div className="usage-body">
        {viewMode === "heatmap" && (
          <div className="usage-heatmap">
            <div className="heatmap-grid" style={{ "--heat-columns": metrics.length } as CSSProperties}>
              <span className="heatmap-corner">{t("usage.corner")}</span>
              {metrics.map(metric => (
                <span className="heatmap-column" key={metric.key}>{metric.label}</span>
              ))}
              {heatRows.map(row => (
                <Fragment key={row.id}>
                  <span className="heatmap-row-label" title={row.label}>
                    <strong>{row.label}</strong>
                    <em>{row.type}</em>
                  </span>
                  {metrics.map(metric => {
                    const value = row.metrics[metric.key];
                    const level = heatLevel(value, heatMax[metric.key]);
                    return (
                      <span
                        className={`heat-tile heat-level-${level}`}
                        key={`${row.id}-${metric.key}`}
                        title={`${row.label} · ${metric.label}: ${value}`}
                      >
                        {metric.key === "stars" || metric.key === "forks" ? formatCompactNumber(value) : value}
                      </span>
                    );
                  })}
                </Fragment>
              ))}
            </div>
            <div className="heatmap-legend">
              <span>{t("usage.low")}</span>
              {[0, 1, 2, 3, 4, 5, 6].map(level => (
                <i className={`heat-level-${level}`} key={level} />
              ))}
              <span>{t("usage.high")}</span>
            </div>
          </div>
        )}
        {viewMode === "bars" && (
          <div className="usage-bars">
            {rankedSkills.length === 0 && rankedSources.length === 0 && <p>{t("usage.noEvents")}</p>}
            {rankedSkills.map(row => (
              <div className="usage-bar-row" key={`skill-${row.id}`} title={row.name}>
                <span>{row.name}</span>
                <i><b style={{ width: skillBarWidth(row.score) }} /></i>
                <em>{row.score}</em>
              </div>
            ))}
            {rankedSources.map(row => (
              <div className="usage-bar-row source" key={`source-${row.name}`} title={row.name}>
                <span>{row.name}</span>
                <i><b style={{ width: sourceBarWidth(row) }} /></i>
                <em>{row.stars > 0 ? `★ ${formatCompactNumber(row.stars)}` : row.score}</em>
              </div>
            ))}
          </div>
        )}
        {viewMode === "trends" && (
          <div className="usage-trends">
            {sourcePopularity.length === 0 && <p>{t("usage.noTrends")}</p>}
            {sourcePopularity.map(source => {
              const points = source.trendPoints ?? [];
              const first = points[0]?.stars ?? 0;
              const last = points[points.length - 1]?.stars ?? source.stars;
              const delta = points.length >= 2 ? last - first : 0;
              return (
                <article className="trend-row" key={source.sourceId} title={sourcePopularityDisplayName(source)}>
                  <div>
                    <strong>{sourcePopularityDisplayName(source)}</strong>
                    <span>
                      {t("usage.trendMeta", {
                        stars: formatCompactNumber(source.stars),
                        forks: formatCompactNumber(source.forks),
                        usage: sourceScore(source),
                        samples: points.length
                      })}
                    </span>
                  </div>
                  <MiniTrendLine points={points.map(point => point.stars)} />
                  <em className={delta >= 0 ? "trend-up" : "trend-down"}>
                    {points.length >= 2
                      ? `${delta >= 0 ? "+" : "-"}${formatCompactNumber(Math.abs(delta))}`
                      : t("usage.trendPending")}
                  </em>
                </article>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}

function MiniTrendLine({ points }: { points: number[] }) {
  const safePoints = points.length > 1 ? points : [0, points[0] ?? 0];
  const max = Math.max(...safePoints, 1);
  const min = Math.min(...safePoints, 0);
  const span = Math.max(max - min, 1);
  const width = 112;
  const height = 34;
  const path = safePoints
    .map((point, index) => {
      const x = safePoints.length === 1 ? width : (index / (safePoints.length - 1)) * width;
      const y = height - ((point - min) / span) * (height - 6) - 3;
      return `${index === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg className="mini-trend-line" viewBox={`0 0 ${width} ${height}`} role="img">
      <path d={path} />
    </svg>
  );
}

function isLightTheme(theme: ThemeName): boolean {
  return (
    theme === "sky-dawn" ||
    theme === "sky-noon" ||
    theme === "sky-golden" ||
    theme === "parchment" ||
    theme === "atlas-light" ||
    theme === "atlas-legacy-light" ||
    theme === "light" ||
    theme === "classic-light"
  );
}

function clampNumber(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function skillVisualCategory(skill: SkillCard) {
  const raw = normalizeLookup(skill.category || "");
  if (raw && !["auto", "general", "local"].includes(raw)) return raw;
  const inferred = inferCategoryIds(
    [skill.name, skill.source, skill.description, skill.tags.join(" ")].filter(Boolean).join(" ")
  );
  return inferred[0] ?? "general";
}

type SkillGraphNodeKind = "source" | "skill";
type SkillGraphNode = {
  category: string;
  enabled: boolean;
  groupIndex: number;
  hue: number;
  id: string;
  itemCount: number;
  itemIndex: number;
  kind: SkillGraphNodeKind;
  label: string;
  parentIndex: number;
  router: boolean;
  seed: number;
  skill?: SkillCard;
  source?: SourceCard;
};
type SkillGraphEdge = { hue: number; sourceIndex: number; targetIndex: number };
type SkillGraphData = { edges: SkillGraphEdge[]; nodes: SkillGraphNode[]; sourceCount: number };
type SkillGraphHitNode = SkillGraphNode & { radius: number; screenX: number; screenY: number };
type SkillGraphRuntime = {
  dragged: boolean;
  dragging: boolean;
  dragStartX: number;
  dragStartY: number;
  hitNodes: SkillGraphHitNode[];
  hoverId: string;
  panX: number;
  panY: number;
  pointerX: number;
  pointerY: number;
  requestDraw: () => void;
};

function buildSkillGraphData(skills: SkillCard[], sources: SourceCard[]): SkillGraphData {
  const sourceCategories = buildSourceCategoryLookup(sources);
  const groups = new Map<string, SkillCard[]>();
  for (const skill of skills) {
    const category = skillGraphCategory(skill, sourceCategories);
    groups.set(category, [...(groups.get(category) ?? []), skill]);
  }

  const orderedGroups = [...groups.entries()]
    .map(([category, bucket]) => ({
      category,
      id: `category-${normalizeLookup(category)}`,
      label: displayCategoryName(category),
      skills: bucket.sort((left, right) => left.name.localeCompare(right.name))
    }))
    .sort((left, right) => right.skills.length - left.skills.length || left.label.localeCompare(right.label));

  const nodes: SkillGraphNode[] = [];
  orderedGroups.forEach((group, groupIndex) => {
    const category = group.category || "general";
    const sourceIndex = nodes.length;
    nodes.push({
      category,
      enabled: true,
      groupIndex,
      hue: skillCategoryHue(category),
      id: `source-${group.id}`,
      itemCount: group.skills.length,
      itemIndex: groupIndex,
      kind: "source",
      label: group.label,
      parentIndex: -1,
      router: false,
      seed: stableSkillHash(group.id)
    });
    group.skills.forEach((skill, itemIndex) => {
      const skillCategory = skillVisualCategory(skill);
      nodes.push({
        category: skillCategory,
        enabled: skill.enabled,
        groupIndex,
        hue: skillCategoryHue(skillCategory),
        id: `skill-${skillGraphSkillId(skill)}`,
        itemCount: group.skills.length,
        itemIndex,
        kind: "skill",
        label: skill.name,
        parentIndex: sourceIndex,
        router: isRouterHubSkill(skill),
        seed: stableSkillHash(`${skill.folderName}:${skill.relativePath}:${itemIndex}`),
        skill
      });
    });
  });

  return { edges: [], nodes, sourceCount: orderedGroups.length };
}

function skillGraphSkillId(skill: SkillCard) {
  return `${skill.folderName}::${skill.relativePath || skill.name}`;
}

function buildSourceCategoryLookup(sources: SourceCard[]) {
  const sourceCategories = new Map<string, string>();
  for (const source of sources) {
    const category = source.categoryId || "general";
    sourceCategories.set(normalizeLookup(source.name), category);
    const sourceUrlName = normalizeLookup((source.url.split("/").pop() ?? "").replace(/\.git$/i, ""));
    if (sourceUrlName) sourceCategories.set(sourceUrlName, category);
  }
  return sourceCategories;
}

function skillGraphCategory(skill: SkillCard, sourceCategories: Map<string, string>) {
  const sourceCategory = sourceCategories.get(normalizeLookup(skill.source));
  return sourceCategory && sourceCategory !== "auto" ? sourceCategory : skillVisualCategory(skill);
}

function drawSkillGraph(
  context: CanvasRenderingContext2D,
  graph: SkillGraphData,
  runtime: SkillGraphRuntime,
  width: number,
  height: number,
  time: number
) {
  const styles = getComputedStyle(context.canvas);
  const textColor = styles.getPropertyValue("--text").trim() || "#191426";
  const mutedColor = styles.getPropertyValue("--text-muted").trim() || "rgba(110, 102, 130, .76)";
  const surfaceColor = styles.getPropertyValue("--surface").trim() || "rgba(255, 255, 255, .9)";
  const clusterNodes = graph.nodes.filter(node => node.kind === "source");
  const sourcePositions = new Map<number, { radius: number; x: number; y: number }>();
  const nodePositions = new Map<number, SkillGraphHitNode>();
  runtime.hitNodes = [];

  context.save();

  const columns = skillGraphColumns(clusterNodes.length, width);
  const rows = Math.max(1, Math.ceil(clusterNodes.length / columns));
  const paddingX = 26;
  const plotTop = 58;
  const plotBottom = 72;
  const plotWidth = Math.max(1, width - paddingX * 2);
  const plotHeight = Math.max(1, height - plotTop - plotBottom);
  const cellWidth = plotWidth / columns;
  const cellHeight = plotHeight / rows;

  graph.nodes.forEach((node, index) => {
    if (node.kind !== "source") return;
    const column = node.itemIndex % columns;
    const row = Math.floor(node.itemIndex / columns);
    const drift = Math.sin(time * 0.00016 + node.seed * 0.01) * 3.5;
    const x = paddingX + cellWidth * (column + 0.5) + runtime.panX * 0.28 + drift;
    const y = plotTop + cellHeight * (row + 0.5) + runtime.panY * 0.28 + drift * 0.35;
    const radius = clampNumber(Math.min(cellWidth, cellHeight) * 0.34, 34, 68);
    const highlighted = runtime.hoverId === node.id;
    const haloRadius = radius + (highlighted ? 14 : 10);

    context.beginPath();
    context.arc(x, y, haloRadius, 0, Math.PI * 2);
    context.fillStyle = `hsla(${node.hue}, 84%, 60%, ${highlighted ? 0.16 : 0.075})`;
    context.fill();
    context.strokeStyle = `hsla(${node.hue}, 80%, 56%, ${highlighted ? 0.42 : 0.22})`;
    context.lineWidth = highlighted ? 1.6 : 1;
    context.stroke();

    context.beginPath();
    context.arc(x, y, 4.5, 0, Math.PI * 2);
    context.fillStyle = `hsla(${node.hue}, 82%, 56%, .86)`;
    context.shadowBlur = highlighted ? 18 : 10;
    context.shadowColor = `hsla(${node.hue}, 82%, 58%, .34)`;
    context.fill();
    context.shadowBlur = 0;

    const countLabel = `${node.label} · ${node.itemCount}`;
    drawGraphText(context, countLabel, x - radius, y - haloRadius - 12, textColor, radius * 2 + 22);

    const hitNode = { ...node, radius: haloRadius, screenX: x, screenY: y };
    sourcePositions.set(index, { radius, x, y });
    nodePositions.set(index, hitNode);
  });

  graph.nodes.forEach((node, index) => {
    if (node.kind !== "skill") return;
    const parent = sourcePositions.get(node.parentIndex) ?? { radius: 48, x: width / 2, y: height / 2 };
    const goldenAngle = Math.PI * (3 - Math.sqrt(5));
    const normalized = (node.itemIndex + 0.5) / Math.max(1, node.itemCount);
    const angle =
      node.itemIndex * goldenAngle +
      (node.seed % 360) * (Math.PI / 180) +
      Math.sin(time * 0.00012 + node.seed) * 0.045;
    const spread = Math.sqrt(normalized) * parent.radius * 0.88;
    const x = parent.x + Math.cos(angle) * spread;
    const y = parent.y + Math.sin(angle) * spread * 0.82;
    const dotSize = node.itemCount > 120 ? 2.1 : node.itemCount > 80 ? 2.5 : node.itemCount > 45 ? 3 : 3.7;
    const radius = node.router ? dotSize + 1.4 : dotSize + (node.seed % 3) * 0.18;
    const hitNode = { ...node, radius: radius + 6, screenX: x, screenY: y };
    nodePositions.set(index, hitNode);
  });

  for (const [index, node] of nodePositions) {
    if (node.kind === "source") continue;
    const highlighted = runtime.hoverId === node.id;
    const clusterHighlighted = runtime.hoverId === graph.nodes[node.parentIndex]?.id;
    const alpha = node.enabled ? (highlighted ? 1 : clusterHighlighted ? 0.92 : 0.72) : 0.3;
    context.beginPath();
    context.arc(node.screenX, node.screenY, node.radius - 6, 0, Math.PI * 2);
    context.fillStyle = `hsla(${node.hue}, 86%, 60%, ${alpha})`;
    context.shadowBlur = highlighted ? 16 : node.router ? 10 : 4;
    context.shadowColor = `hsla(${node.hue}, 86%, 58%, .48)`;
    context.fill();
    context.shadowBlur = 0;
    if (node.router) {
      context.beginPath();
      context.arc(node.screenX, node.screenY, node.radius - 2, 0, Math.PI * 2);
      context.strokeStyle = `hsla(${node.hue}, 86%, 72%, .34)`;
      context.lineWidth = 1;
      context.stroke();
    }
    runtime.hitNodes.push(node);
    nodePositions.set(index, node);
  }

  for (const [index, node] of nodePositions) {
    if (node.kind !== "source") continue;
    runtime.hitNodes.push(node);
    nodePositions.set(index, node);
  }

  const hovered = runtime.hoverId
    ? runtime.hitNodes.find(node => node.id === runtime.hoverId)
    : undefined;
  if (hovered) {
    drawGraphTooltip(context, hovered, textColor, mutedColor, surfaceColor, width, height);
  }
  context.restore();
}

function skillGraphColumns(count: number, width: number) {
  if (count <= 1) return 1;
  if (width < 620) return Math.min(2, count);
  if (count <= 4) return count;
  if (count <= 9) return 3;
  return 4;
}

function drawGraphText(
  context: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  color: string,
  maxWidth: number
) {
  context.save();
  context.font = "700 11px Inter, system-ui, sans-serif";
  context.fillStyle = color;
  context.textBaseline = "middle";
  context.fillText(truncateCanvasText(context, text, maxWidth), x, y);
  context.restore();
}

function drawGraphTooltip(
  context: CanvasRenderingContext2D,
  node: SkillGraphHitNode,
  textColor: string,
  mutedColor: string,
  surfaceColor: string,
  width: number,
  height: number
) {
  const title = node.label;
  const subtitle = node.skill
    ? localizedSkillDescription(node.skill, getLang()) || displayCategoryName(node.category)
    : t("lib.skillsTotal", { n: node.itemCount });
  context.save();
  context.font = "800 12px Inter, system-ui, sans-serif";
  const titleWidth = context.measureText(title).width;
  context.font = "600 10.5px Inter, system-ui, sans-serif";
  const subtitleWidth = context.measureText(subtitle).width;
  const boxWidth = clampNumber(Math.max(titleWidth, subtitleWidth) + 24, 120, Math.min(260, width - 24));
  const boxHeight = 54;
  const x = clampNumber(node.screenX + 16, 12, width - boxWidth - 12);
  const y = clampNumber(node.screenY - boxHeight - 14, 12, height - boxHeight - 12);
  context.fillStyle = surfaceColor;
  context.strokeStyle = `hsla(${node.hue}, 76%, 62%, .32)`;
  context.lineWidth = 1;
  roundedCanvasRect(context, x, y, boxWidth, boxHeight, 12);
  context.fill();
  context.stroke();
  context.fillStyle = textColor;
  context.font = "800 12px Inter, system-ui, sans-serif";
  context.fillText(truncateCanvasText(context, title, boxWidth - 24), x + 12, y + 20);
  context.fillStyle = mutedColor;
  context.font = "600 10.5px Inter, system-ui, sans-serif";
  context.fillText(truncateCanvasText(context, subtitle, boxWidth - 24), x + 12, y + 38);
  context.restore();
}

function roundedCanvasRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
) {
  context.beginPath();
  context.moveTo(x + radius, y);
  context.arcTo(x + width, y, x + width, y + height, radius);
  context.arcTo(x + width, y + height, x, y + height, radius);
  context.arcTo(x, y + height, x, y, radius);
  context.arcTo(x, y, x + width, y, radius);
  context.closePath();
}

function truncateCanvasText(context: CanvasRenderingContext2D, text: string, maxWidth: number) {
  if (context.measureText(text).width <= maxWidth) return text;
  let clipped = text;
  while (clipped.length > 4 && context.measureText(`${clipped}...`).width > maxWidth) {
    clipped = clipped.slice(0, -1);
  }
  return `${clipped}...`;
}

function findGraphHit(runtime: SkillGraphRuntime, x: number, y: number) {
  for (let index = runtime.hitNodes.length - 1; index >= 0; index -= 1) {
    const node = runtime.hitNodes[index];
    const distance = Math.hypot(node.screenX - x, node.screenY - y);
    if (distance <= node.radius) return node;
  }
  return null;
}

function buildConstellationLegend(skills: SkillCard[], sources: SourceCard[]) {
  const sourceCategories = buildSourceCategoryLookup(sources);
  const counts = new Map<string, number>();
  for (const skill of skills) {
    const category = skillGraphCategory(skill, sourceCategories);
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([leftCategory, leftCount], [rightCategory, rightCount]) => {
      return rightCount - leftCount || displayCategoryName(leftCategory).localeCompare(displayCategoryName(rightCategory));
    })
    .slice(0, 7)
    .map(([category, count]) => ({
      category,
      count,
      hue: skillCategoryHue(category),
      label: `${displayCategoryName(category)} · ${count}`
    }));
}

function skillCategoryHue(category: string) {
  const id = normalizeLookup(category);
  const fixedHue = CATEGORY_HUES[id];
  if (typeof fixedHue === "number") return fixedHue;
  const hash = stableSkillHash(id || category);
  return (hash * 47 + 162) % 360;
}

const CATEGORY_HUES: Record<string, number> = {
  "academic-writing": 214,
  "agent-tools": 248,
  "browser-automation": 268,
  "clinical-medical": 358,
  "data-analysis": 190,
  "development": 226,
  "document-tools": 18,
  "finance-economics": 58,
  "general": 72,
  "image-generation": 326,
  "knowledge-retrieval": 136,
  "life-sciences": 108,
  "literature-research": 174,
  "presentation": 28,
  "presentations": 28,
  "prompt-polishing": 346,
  "scientific-figures": 46,
  "security": 8,
  "security-audit": 8,
  "ui-design": 292
};

function stableSkillHash(value: string) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash;
}

function isInternalRouterSource(source: SourceCard) {
  return source.name.trim().toLowerCase() === "ai-skillhub-local-routers" && !source.url.trim();
}

function sourcePopularityDisplayName(source: Pick<SourcePopularityCard, "owner" | "repo" | "sourceName">) {
  const repoName = [source.owner, source.repo].filter(Boolean).join("/");
  const sourceName = source.sourceName?.trim();
  if (!sourceName) return repoName || source.repo || "unknown-source";
  if (repoName && (sourceName === source.repo || sourceName.toLowerCase() === "skills")) return repoName;
  return sourceName;
}

function heatLevel(value: number, max: number) {
  if (value <= 0 || max <= 0) return 0;
  const ratio = value / max;
  if (ratio >= 0.86) return 6;
  if (ratio >= 0.68) return 5;
  if (ratio >= 0.5) return 4;
  if (ratio >= 0.32) return 3;
  if (ratio >= 0.16) return 2;
  return 1;
}

/** Activity rows are translated; unknown event types fall back to a generic label (bug #4). */
function auditEventLabel(eventType: string) {
  const key = `audit.${eventType}`;
  const label = t(key);
  return label === key ? t("audit.generic") : label;
}
