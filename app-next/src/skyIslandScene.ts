import * as THREE from "three";
import { makeIslandArtwork, seededRandom, skyTime } from "./skyIslandArtwork";
import type { SkyIsland } from "./skyIslandModel";

export type SkyScene = { dispose: () => void; setPaused: (paused: boolean) => void; focus: (id: string | null) => void; reset: () => void };
type SceneOptions = { host: HTMLDivElement; islands: SkyIsland[]; labels: Map<string, HTMLButtonElement>; dark: boolean; paused: boolean; onOpen: (id: string) => void; onHover: (id: string | null) => void; onFailure: () => void };

export function islandLayout(islands: SkyIsland[]) {
  const max = Math.max(1, ...islands.map(island => island.weight));
  const positions: { x: number; y: number; radius: number; scale: number }[] = [];
  for (let i = 0; i < islands.length; i++) {
    // Surface area interpolates with content; the smallest and largest differ by 6.25x.
    const scale = Math.sqrt(.16 + .84 * islands[i].weight / max), radius = 2.95 * scale + .5;
    let x = 0, y = 0;
    if (i) for (let step = 0; step < 2400; step++) {
      const angle = i * 2.399963 + step * .045, distance = 3 + step * .025;
      x = Math.cos(angle) * distance * 1.7; y = Math.sin(angle) * distance * .65;
      if (positions.every(p => Math.hypot(x - p.x, (y - p.y) * 1.55) > radius + p.radius)) break;
    }
    positions.push({ x, y, radius, scale });
  }
  if (positions.length) {
    const mx = (Math.min(...positions.map(p => p.x - p.radius)) + Math.max(...positions.map(p => p.x + p.radius))) / 2;
    const my = (Math.min(...positions.map(p => p.y - p.radius * .85)) + Math.max(...positions.map(p => p.y + p.radius * .85))) / 2;
    positions.forEach(p => { p.x -= mx; p.y -= my; });
  }
  return positions;
}

export function createSkyScene(options: SceneOptions): SkyScene {
  const { host, islands, labels } = options;
  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: "low-power" });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = options.dark ? .9 : 1.04;
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const canvas = renderer.domElement;
  canvas.setAttribute("aria-hidden", "true"); canvas.className = "sky-world-canvas"; host.prepend(canvas);
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(options.dark ? "#b7d6e0" : "#fff9e8", "#8fabb7", 1.65));
  const sunlight = new THREE.DirectionalLight(options.dark ? "#dfdced" : "#ffe7be", 2.5);
  sunlight.position.set(-8, 18, 10); sunlight.castShadow = true; sunlight.shadow.mapSize.set(1024, 1024);
  Object.assign(sunlight.shadow.camera, { left: -22, right: 22, top: 22, bottom: -22, far: 65 });
  sunlight.shadow.normalBias = .045; sunlight.shadow.bias = -.0001; scene.add(sunlight);
  const camera = new THREE.OrthographicCamera(-15, 15, 10, -10, .1, 180);
  camera.position.set(0, 28, 38); camera.lookAt(0, 0, 0); camera.updateMatrixWorld();
  const viewUp = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
  const root = new THREE.Group(); scene.add(root);
  const placements = islandLayout(islands);
  const pickGeometry = new THREE.CylinderGeometry(2.45, 1.2, 3.2, 12);
  const pickMaterial = new THREE.MeshBasicMaterial({ visible: false });
  const pickTargets: THREE.Mesh[] = [];
  const artworks = islands.map((island, index) => {
    const art = makeIslandArtwork(island), placement = placements[index];
    art.group.position.set(placement.x, 0, -placement.y / .593); art.group.scale.setScalar(placement.scale);
    const pick = new THREE.Mesh(pickGeometry, pickMaterial); pick.userData.islandId = island.id;
    pick.scale.z = .78; pick.position.y = -.2; art.group.add(pick); pickTargets.push(pick); root.add(art.group);
    return { ...art, island, placement };
  });
  const cloudCanvas = document.createElement("canvas"); cloudCanvas.width = cloudCanvas.height = 128;
  const context = cloudCanvas.getContext("2d");
  if (context) {
    const gradient = context.createRadialGradient(64, 57, 8, 64, 64, 61);
    gradient.addColorStop(0, "rgba(255,255,255,.92)"); gradient.addColorStop(.48, "rgba(255,255,255,.65)"); gradient.addColorStop(1, "rgba(255,255,255,0)");
    context.fillStyle = gradient; context.fillRect(0, 0, 128, 128);
  }
  const cloudTexture = new THREE.CanvasTexture(cloudCanvas);
  const cloudMat = new THREE.SpriteMaterial({ map: cloudTexture, color: options.dark ? "#b2c4de" : "#fff9ef", opacity: options.dark ? .2 : .55, depthWrite: false });
  const clouds: THREE.Sprite[] = [], random = seededRandom(83127);
  for (let i = 0; i < 35; i++) {
    const cloud = new THREE.Sprite(cloudMat);
    cloud.position.set((random() - .5) * 45, -4.7 - random() * 4, (random() - .5) * 35);
    cloud.scale.set(4 + random() * 7, 2 + random() * 3, 1); cloud.userData.baseX = cloud.position.x; cloud.userData.phase = random() * Math.PI * 2;
    clouds.push(cloud); scene.add(cloud);
  }
  const puffGeometry = new THREE.SphereGeometry(1, 24, 16);
  const puffMaterial = new THREE.MeshStandardMaterial({ color: options.dark ? "#839bb9" : "#edf4fa", roughness: 1 });
  const puffs = new THREE.InstancedMesh(puffGeometry, puffMaterial, 66), puffTransform = new THREE.Object3D();
  for (let cluster = 0; cluster < 11; cluster++) {
    const x = (random() - .5) * 38, z = (random() - .5) * 30;
    for (let lobe = 0; lobe < 6; lobe++) {
      const a = lobe * 2.4, s = .6 + random() * .5;
      puffTransform.position.set(x + Math.cos(a) * .8, -5.7 + random() * .35, z + Math.sin(a) * .6);
      puffTransform.scale.set(s * 1.3, s * .85, s); puffTransform.updateMatrix(); puffs.setMatrixAt(cluster * 6 + lobe, puffTransform.matrix);
    }
  }
  scene.add(puffs);
  const birds = new THREE.Group(); scene.add(birds);
  const birdMat = new THREE.MeshBasicMaterial({ color: options.dark ? "#d2dce5" : "#fef7df", side: THREE.DoubleSide });
  const wingGeometry = new THREE.BufferGeometry();
  wingGeometry.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, -.25, .09, -.04, -.12, 0, .07, 0, 0, 0, .25, .09, -.04, .12, 0, .07], 3));
  for (let i = 0; i < 5; i++) { const bird = new THREE.Mesh(wingGeometry, birdMat); bird.position.set(i * .45, i % 2 * .12, i * .35); birds.add(bird); }
  let disposed = false, failed = false, paused = options.paused, visible = true;
  let raf = 0, lastFrame = 0, time = 0, dirty = true, frameCount = 0, width = 1, height = 1, baseSpan = 12, homePanY = 0;
  let zoom = 1, targetZoom = 1, panX = 0, panY = 0, targetPanX = 0, targetPanY = 0;
  let hovered: string | null = null, focusId: string | null = null;
  let dragging = false, moved = false, downX = 0, downY = 0, lastX = 0, lastY = 0;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  const raycaster = new THREE.Raycaster(), pointer = new THREE.Vector2(), point = new THREE.Vector3();
  function requestDraw() { dirty = true; if (!raf && !disposed && !failed && !document.hidden && visible) raf = requestAnimationFrame(draw); }
  const setHover = (id: string | null) => {
    if (hovered === id) return;
    hovered = id; canvas.style.cursor = id ? "pointer" : "grab";
    labels.forEach((label, key) => label.classList.toggle("is-hovered", key === id)); options.onHover(id); requestDraw();
  };
  const hit = (event: PointerEvent) => {
    const rect = canvas.getBoundingClientRect(); pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
    raycaster.setFromCamera(pointer, camera); return raycaster.intersectObjects(pickTargets, false)[0]?.object.userData.islandId as string | undefined;
  };
  function resize() {
    width = Math.max(1, host.clientWidth); height = Math.max(1, host.clientHeight);
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5, Math.sqrt(8_300_000 / (width * height)));
    renderer.setPixelRatio(dpr); renderer.setSize(width, height, false);
    const extX = Math.max(3, ...placements.map(p => Math.abs(p.x) + p.radius)), extY = Math.max(2.8, ...placements.map(p => Math.abs(p.y) + p.radius * .85));
    const preview = Boolean(host.closest(".browser-preview-shell"));
    const top = (height <= 750 ? 195 : 228) + (preview ? 58 : 0), bottom = height <= 750 ? 124 : 145;
    const available = Math.max(180, height - top - bottom);
    baseSpan = Math.max(extY * 1.06 * height / available, extX / (width / height) * 1.1);
    homePanY = (top - bottom) * baseSpan / height;
    camera.left = -baseSpan * width / height; camera.right = baseSpan * width / height; camera.top = baseSpan; camera.bottom = -baseSpan;
    camera.updateProjectionMatrix(); requestDraw();
  }
  function draw(now: number) {
    raf = 0;
    if (disposed || failed || document.hidden || !visible) { lastFrame = 0; return; }
    const animate = !paused && !reduced.matches, settling = Math.abs(targetZoom - zoom) + Math.abs(targetPanX - panX) + Math.abs(targetPanY - panY) > .001;
    if (!dirty && !animate && !settling) return;
    if (animate && !dirty && now - lastFrame < 32) { raf = requestAnimationFrame(draw); return; }
    const dt = lastFrame ? Math.min((now - lastFrame) / 1000, .06) : 0; lastFrame = now; dirty = false;
    if (animate) time += dt; skyTime.value = time;
    const ease = reduced.matches ? 1 : .18;
    zoom += (targetZoom - zoom) * ease; panX += (targetPanX - panX) * ease; panY += (targetPanY - panY) * ease;
    camera.zoom = zoom; camera.position.set(panX, 28 + viewUp.y * (panY + homePanY / zoom), 38 + viewUp.z * (panY + homePanY / zoom)); camera.updateMatrixWorld(); camera.updateProjectionMatrix();
    for (const art of artworks) {
      art.group.position.y = Math.sin(time * .38 + art.island.seed % 19) * .08; art.animate(time, art.island.id === (hovered ?? focusId));
      const label = labels.get(art.island.id);
      if (label) {
        point.set(0, -1.6, .4); art.group.localToWorld(point); point.project(camera);
        label.style.transform = `translate(${(point.x * .5 + .5) * width}px,${(-point.y * .5 + .5) * height}px) translate(-50%,0)`;
        label.style.visibility = Math.abs(point.x) < 1.12 && Math.abs(point.y) < 1.08 ? "visible" : "hidden";
      }
    }
    clouds.forEach(cloud => { cloud.position.x = cloud.userData.baseX + Math.sin(time * .055 + cloud.userData.phase) * 1.5; });
    birds.position.set(Math.sin(time * .08) * 9, 3, Math.cos(time * .08) * 4); birds.rotation.y = time * .08;
    birds.children.forEach((bird, i) => { bird.scale.y = .45 + Math.sin(time * 3 + i) * .4; });
    renderer.render(scene, camera); frameCount++;
    host.dataset.frames = String(frameCount); host.dataset.drawCalls = String(renderer.info.render.calls); host.dataset.triangles = String(renderer.info.render.triangles); host.dataset.pixelRatio = String(renderer.getPixelRatio());
    if (animate || settling) raf = requestAnimationFrame(draw);
  }
  const pointerDown = (event: PointerEvent) => { if (event.button !== 0) return; dragging = true; moved = false; downX = lastX = event.clientX; downY = lastY = event.clientY; canvas.setPointerCapture(event.pointerId); };
  const pointerMove = (event: PointerEvent) => {
    if (dragging) {
      moved ||= Math.hypot(event.clientX - downX, event.clientY - downY) > 6;
      if (moved) {
        targetPanX = THREE.MathUtils.clamp(targetPanX - (event.clientX - lastX) * baseSpan * 2 / height / zoom, -baseSpan * 2, baseSpan * 2);
        targetPanY = THREE.MathUtils.clamp(targetPanY + (event.clientY - lastY) * baseSpan * 2 / height / zoom, -baseSpan * 2, baseSpan * 2);
        setHover(null); requestDraw();
      }
      lastX = event.clientX; lastY = event.clientY;
    } else setHover(hit(event) ?? null);
  };
  const pointerUp = (event: PointerEvent) => { if (!dragging) return; dragging = false; if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId); if (!moved) { const id = hit(event); if (id) options.onOpen(id); } };
  const cancelPointer = () => { dragging = moved = false; setHover(null); }, leave = () => { if (!dragging) setHover(null); };
  const wheel = (event: WheelEvent) => { event.preventDefault(); targetZoom = THREE.MathUtils.clamp(targetZoom * Math.exp(-event.deltaY * .001), .65, 2.8); requestDraw(); };
  const contextLost = (event: Event) => { event.preventDefault(); failed = true; cancelAnimationFrame(raf); raf = 0; options.onFailure(); };
  const visibility = () => { if (document.hidden) { cancelAnimationFrame(raf); raf = 0; lastFrame = 0; } else requestDraw(); };
  canvas.addEventListener("pointerdown", pointerDown); canvas.addEventListener("pointermove", pointerMove); canvas.addEventListener("pointerup", pointerUp); canvas.addEventListener("pointercancel", cancelPointer); canvas.addEventListener("pointerleave", leave); canvas.addEventListener("wheel", wheel, { passive: false }); canvas.addEventListener("webglcontextlost", contextLost);
  document.addEventListener("visibilitychange", visibility); reduced.addEventListener("change", requestDraw);
  const resizeObserver = new ResizeObserver(resize); resizeObserver.observe(host);
  const intersection = new IntersectionObserver(entries => { visible = entries[0]?.isIntersecting ?? true; if (visible) requestDraw(); else { cancelAnimationFrame(raf); raf = 0; lastFrame = 0; } }); intersection.observe(host);
  resize();
  return {
    setPaused(value) { paused = value; lastFrame = 0; requestDraw(); },
    focus(id) { focusId = id; const p = placements[islands.findIndex(island => island.id === id)]; if (p) { targetPanX = p.x; targetPanY = p.y; targetZoom = Math.min(2.4, Math.max(1.2, baseSpan / (p.radius * 1.65))); } requestDraw(); },
    reset() { focusId = null; targetPanX = targetPanY = 0; targetZoom = 1; requestDraw(); },
    dispose() {
      disposed = true; cancelAnimationFrame(raf); resizeObserver.disconnect(); intersection.disconnect(); document.removeEventListener("visibilitychange", visibility); reduced.removeEventListener("change", requestDraw);
      canvas.removeEventListener("pointerdown", pointerDown); canvas.removeEventListener("pointermove", pointerMove); canvas.removeEventListener("pointerup", pointerUp); canvas.removeEventListener("pointercancel", cancelPointer); canvas.removeEventListener("pointerleave", leave); canvas.removeEventListener("wheel", wheel); canvas.removeEventListener("webglcontextlost", contextLost);
      artworks.forEach(art => art.dispose()); cloudTexture.dispose(); cloudMat.dispose(); puffGeometry.dispose(); puffMaterial.dispose(); wingGeometry.dispose(); birdMat.dispose(); sunlight.shadow.map?.dispose(); renderer.dispose(); renderer.forceContextLoss(); canvas.remove();
    }
  };
}
