// Composes small buildings from Medieval Village MegaKit modules (CC0).
//
// Module conventions measured in the sky lab:
//   - walls are 2 m wide (x -1..1), 3.12 m tall; the exterior face is +Z at
//     z = +0.09, the interior at z = -0.31;
//   - Roof_RoundTiles_WxL spans W along X with its ridge along Z and sits on
//     the wall top; Roof_Front_Brick{W} fills the gable triangle;
//   - Corner_Exterior_Wood is a centred post.
// Each building is composed in its own document, flattened and joined per
// material (a handful of draw calls), then merged into the library.
import path from "node:path";
import { flatten, join, mergeDocuments, prune } from "@gltf-transform/functions";

const WALL = 3.12;
const SKIN = 0.09;

// Openings are filled with their door or glazed window, in the wall's frame.
const INSERTS = [
  [/_Door_Round$/, [{ name: "Door_1_Round", x: -0.53, z: -0.11 }]],
  [/_Window_Wide_Round$/, [{ name: "Window_Wide_Round1", x: 0, z: 0 }]],
  [/_Window_Thin_Round$/, [{ name: "Window_Thin_Round1", x: 0, z: 0 }]]
];

function withInserts(part, shutters) {
  const parts = [part];
  for (const [pattern, inserts] of INSERTS) {
    if (!pattern.test(part.name)) continue;
    for (const insert of inserts) {
      const cos = Math.cos(part.ry), sin = Math.sin(part.ry);
      parts.push({
        name: insert.name,
        x: part.x + insert.x * cos + insert.z * sin,
        y: part.y,
        z: part.z - insert.x * sin + insert.z * cos,
        ry: part.ry
      });
    }
    if (shutters && /_Window_Wide_Round$/.test(part.name)) {
      parts.push({ name: "WindowShutters_Wide_Round_Open", x: part.x, y: part.y, z: part.z, ry: part.ry });
    }
  }
  return parts;
}

/** A rectangular storey of walls: `sides` lists module names per side. */
function storey(width, depth, level, sides) {
  const parts = [];
  const y = level * WALL;
  const half = { x: width / 2, z: depth / 2 };
  const side = (modules, count, place) => {
    for (let index = 0; index < count; index++) {
      const name = modules[index % modules.length];
      if (name) parts.push(...withInserts(place(name, index), sides.shutters));
    }
  };
  // Front (+Z) and back (-Z) run along X; left (-X) and right (+X) along Z.
  side(sides.front, width / 2, (name, i) => ({ name, x: -half.x + 1 + i * 2, y, z: half.z - SKIN, ry: 0 }));
  side(sides.back, width / 2, (name, i) => ({ name, x: half.x - 1 - i * 2, y, z: -half.z + SKIN, ry: Math.PI }));
  side(sides.left, depth / 2, (name, i) => ({ name, x: -half.x + SKIN, y, z: -half.z + 1 + i * 2, ry: -Math.PI / 2 }));
  side(sides.right, depth / 2, (name, i) => ({ name, x: half.x - SKIN, y, z: half.z - 1 - i * 2, ry: Math.PI / 2 }));
  for (const [x, z] of [[-half.x, -half.z], [half.x, -half.z], [-half.x, half.z], [half.x, half.z]]) {
    parts.push({ name: sides.corner ?? "Corner_Exterior_Wood", x, y, z, ry: 0 });
  }
  return parts;
}

function gableRoof(width, depth, levels, tiles = "RoundTiles") {
  const y = levels * WALL;
  return [
    { name: `Roof_${tiles}_${width}x${depth}`, x: 0, y, z: 0, ry: 0, centre: true },
    { name: `Roof_Front_Brick${width}`, x: 0, y, z: depth / 2 - SKIN, ry: 0 },
    { name: `Roof_Front_Brick${width}`, x: 0, y, z: -depth / 2 + SKIN, ry: Math.PI }
  ];
}

const PLASTER = { straight: "Wall_Plaster_Straight", grid: "Wall_Plaster_WoodGrid", window: "Wall_Plaster_Window_Wide_Round", windowThin: "Wall_Plaster_Window_Thin_Round", door: "Wall_Plaster_Door_Round", base: "Wall_Plaster_Straight_Base" };
const BRICK = { straight: "Wall_UnevenBrick_Straight", window: "Wall_UnevenBrick_Window_Wide_Round", windowThin: "Wall_UnevenBrick_Window_Thin_Round", door: "Wall_UnevenBrick_Door_Round" };

export const BLUEPRINTS = {
  // A one-room cottage: writer's study, painter's house.
  Cottage: [
    ...storey(4, 4, 0, {
      front: [PLASTER.door, PLASTER.window],
      back: [PLASTER.grid, PLASTER.straight],
      left: [PLASTER.window, PLASTER.straight],
      right: [PLASTER.straight, PLASTER.windowThin],
      shutters: true
    }),
    ...gableRoof(4, 4, 1),
    { name: "Prop_Chimney", x: 1.2, y: WALL + 0.9, z: -1.1, ry: 0 }
  ],
  // Two storeys with a timber upper floor: library, town house.
  TownHouse: [
    ...storey(4, 6, 0, {
      front: [BRICK.door, BRICK.window],
      back: [BRICK.straight, BRICK.window],
      left: [BRICK.window, BRICK.straight, BRICK.window],
      right: [BRICK.straight, BRICK.window, BRICK.straight],
      corner: "Corner_Exterior_Wood"
    }),
    ...storey(4, 6, 1, {
      front: [PLASTER.window, PLASTER.grid],
      back: [PLASTER.grid, PLASTER.windowThin],
      left: [PLASTER.grid, PLASTER.window, PLASTER.grid],
      right: [PLASTER.window, PLASTER.grid, PLASTER.window],
      shutters: true
    }),
    ...gableRoof(4, 6, 2)
  ],
  // A stone tower: observatory, lookout.
  Tower: [
    ...storey(4, 4, 0, { front: [BRICK.door, BRICK.straight], back: [BRICK.straight, BRICK.straight], left: [BRICK.straight, BRICK.windowThin], right: [BRICK.windowThin, BRICK.straight] }),
    ...storey(4, 4, 1, { front: [BRICK.windowThin, BRICK.straight], back: [BRICK.straight, BRICK.windowThin], left: [BRICK.straight, BRICK.straight], right: [BRICK.straight, BRICK.straight] }),
    ...storey(4, 4, 2, { front: [PLASTER.window, PLASTER.window], back: [PLASTER.window, PLASTER.window], left: [PLASTER.window, PLASTER.window], right: [PLASTER.window, PLASTER.window] }),
    { name: "Roof_Tower_RoundTiles", x: 0, y: 3 * WALL, z: 0, ry: 0 }
  ],
  // A wide single-storey workshop with a forge chimney.
  Workshop: [
    ...storey(6, 4, 0, {
      front: [BRICK.window, BRICK.door, BRICK.window],
      back: [BRICK.straight, BRICK.straight, BRICK.straight],
      left: [BRICK.windowThin, BRICK.straight],
      right: [BRICK.straight, BRICK.windowThin]
    }),
    ...gableRoof(6, 4, 1),
    { name: "Prop_Chimney2", x: -2, y: WALL + 1.6, z: -0.6, ry: 0 }
  ]
};

function moduleBounds(document) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const mesh of document.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      const position = primitive.getAttribute("POSITION");
      const low = position.getMin([]), high = position.getMax([]);
      for (let axis = 0; axis < 3; axis++) {
        min[axis] = Math.min(min[axis], low[axis]);
        max[axis] = Math.max(max[axis], high[axis]);
      }
    }
  }
  return { min, max };
}

export async function composeBuildings(io, srcDir, blueprints = BLUEPRINTS) {
  const cache = new Map();
  const readModule = async name => {
    if (!cache.has(name)) cache.set(name, path.join(srcDir, "village", `${name}.gltf`));
    return io.read(cache.get(name));
  };
  let library = null;
  for (const [buildingName, parts] of Object.entries(blueprints)) {
    const building = await readModule(parts[0].name);
    const scene = building.getRoot().listScenes()[0];
    const placeRoots = (nodes, part, document) => {
      let { x, z } = part;
      if (part.centre) {
        // Some roof modules have their origin at one end; centre them on
        // the footprint from their measured bounds.
        const bounds = moduleBounds(document);
        x -= (bounds.min[0] + bounds.max[0]) / 2;
        z -= (bounds.min[2] + bounds.max[2]) / 2;
      }
      const holder = building.createNode(`${buildingName}_${part.name}`)
        .setTranslation([x, part.y, z])
        .setRotation([0, Math.sin(part.ry / 2), 0, Math.cos(part.ry / 2)]);
      for (const node of nodes) {
        scene.removeChild(node);
        holder.addChild(node);
      }
      scene.addChild(holder);
    };
    placeRoots(scene.listChildren(), parts[0], building);
    for (const part of parts.slice(1)) {
      const source = await readModule(part.name);
      const map = mergeDocuments(building, source);
      const roots = source.getRoot().listScenes()[0].listChildren().map(node => map.get(node));
      for (const extra of building.getRoot().listScenes().slice(1)) extra.dispose();
      placeRoots(roots, part, source);
    }
    await building.transform(flatten(), join({ keepNamed: false }), prune());
    // Wrap the joined meshes under one named root.
    const root = building.createNode(buildingName);
    for (const node of scene.listChildren()) {
      scene.removeChild(node);
      root.addChild(node);
    }
    scene.addChild(root);
    if (!library) {
      library = building;
    } else {
      const map = mergeDocuments(library, building);
      const libraryScene = library.getRoot().listScenes()[0];
      const mergedRoot = map.get(root);
      for (const extra of library.getRoot().listScenes().slice(1)) extra.dispose();
      libraryScene.addChild(mergedRoot);
    }
  }
  return library;
}
