// Development lab for the sky-island assets. Not part of the app bundle.
//   /lab/sky-lab.html?lib=nature            grid of every model in a library
//   /lab/sky-lab.html?lib=modules&filter=Wall
//   &debug=wire|normals                     geometry inspection
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

const params = new URLSearchParams(location.search);
const lib = params.get("lib") ?? "nature";
const filter = (params.get("filter") ?? "").toLowerCase();
const debug = params.get("debug") ?? "";
const base = params.get("base") ?? "./.out/";

const stage = document.getElementById("stage")!;
const info = document.getElementById("info")!;
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;
stage.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color("#dfe8ea");
scene.add(new THREE.HemisphereLight("#ffffff", "#8a9a7a", 1.6));
const sun = new THREE.DirectionalLight("#fff3e0", 2.4);
sun.position.set(-20, 40, 25);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -60, right: 60, top: 60, bottom: -60, far: 160 });
scene.add(sun);
const camera = new THREE.PerspectiveCamera(35, innerWidth / innerHeight, 0.1, 2000);
const controls = new OrbitControls(camera, renderer.domElement);

const tags: Array<{ element: HTMLDivElement; anchor: THREE.Vector3 }> = [];
function tag(text: string, anchor: THREE.Vector3) {
  const element = document.createElement("div");
  element.className = "tag";
  element.textContent = text;
  document.body.appendChild(element);
  tags.push({ element, anchor });
}

new GLTFLoader().load(`${base}${lib}.glb`, gltf => {
  const roots = gltf.scene.children.filter(child => !filter || child.name.toLowerCase().includes(filter));
  const columns = Math.ceil(Math.sqrt(roots.length));
  const sizes = roots.map(root => new THREE.Box3().setFromObject(root).getSize(new THREE.Vector3()));
  const cell = Math.max(2, ...sizes.map(size => Math.max(size.x, size.z))) * 1.35;
  let triangles = 0;
  roots.forEach((root, index) => {
    const x = (index % columns) * cell, z = Math.floor(index / columns) * cell;
    root.position.set(x, 0, z);
    scene.add(root);
    root.traverse(object => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = mesh.receiveShadow = true;
      triangles += (mesh.geometry.index?.count ?? mesh.geometry.attributes.position.count) / 3;
      if (debug === "wire") (mesh.material as THREE.MeshStandardMaterial).wireframe = true;
      if (debug === "normals") mesh.material = new THREE.MeshNormalMaterial();
    });
    const box = new THREE.Box3().setFromObject(root);
    const size = box.getSize(new THREE.Vector3());
    tag(`${root.name} ${size.x.toFixed(2)}×${size.y.toFixed(2)}×${size.z.toFixed(2)}`, new THREE.Vector3(x, -0.2, z + cell * 0.38));
    // +X red, +Z blue: shows each module's facing.
    const axes = new THREE.AxesHelper(1.2);
    axes.position.set(x, 0.02, z);
    scene.add(axes);
  });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(columns * cell + cell, Math.ceil(roots.length / columns) * cell + cell), new THREE.MeshStandardMaterial({ color: "#c9d3c4" }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.set((columns - 1) * cell / 2, -0.01, (Math.ceil(roots.length / columns) - 1) * cell / 2);
  ground.receiveShadow = true;
  scene.add(ground);
  const all = new THREE.Box3();
  roots.forEach(root => all.expandByObject(root));
  const center = all.getCenter(new THREE.Vector3());
  const radius = all.getBoundingSphere(new THREE.Sphere()).radius;
  const view = params.get("view") ?? "iso";
  const direction = {
    iso: new THREE.Vector3(0.55, 0.62, 1),
    front: new THREE.Vector3(0, 0.12, 1),
    side: new THREE.Vector3(1, 0.12, 0),
    back: new THREE.Vector3(0, 0.12, -1),
    top: new THREE.Vector3(0, 1, 0.001),
    low: new THREE.Vector3(0.4, -0.35, 1)
  }[view] ?? new THREE.Vector3(0.55, 0.62, 1);
  const distance = radius / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2)) * Number(params.get("zoom") ?? 1);
  camera.position.copy(center).add(direction.normalize().multiplyScalar(distance));
  camera.far = distance * 4;
  camera.updateProjectionMatrix();
  controls.target.copy(center);
  controls.update();
  info.textContent = `${lib}: ${roots.length} models · ${Math.round(triangles).toLocaleString()} triangles`;
  document.body.dataset.ready = "1";
});

function frame() {
  requestAnimationFrame(frame);
  renderer.render(scene, camera);
  const point = new THREE.Vector3();
  for (const item of tags) {
    point.copy(item.anchor).project(camera);
    item.element.style.left = `${(point.x * 0.5 + 0.5) * innerWidth}px`;
    item.element.style.top = `${(-point.y * 0.5 + 0.5) * innerHeight}px`;
    item.element.style.display = point.z < 1 ? "block" : "none";
  }
}
frame();
addEventListener("resize", () => {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
});
