import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { AnimationMixer, Vector3 } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { createFarmLegSolver, repairFarmHoofWeights } from "../src/sky/animalRig.ts";
import { spillwayGeometry } from "../src/sky/water.ts";

for (const name of ["Horse", "Cow", "Sheep", "Pig", "Llama", "Pug"]) {
  test(`${name}: deforming legs follow moving foot targets, not just the body`, async () => {
    const bytes = await readFile(new URL(`../public/sky/animals/${name}.glb`, import.meta.url));
    const g = await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), "");
    repairFarmHoofWeights(g);g.scene.updateMatrixWorld(true);
    const solver = createFarmLegSolver(g.scene), mixer = new AnimationMixer(g.scene);
    const walk = g.animations.find(c => c.name.endsWith("|WalkSlow"));
    const clip = walk ?? g.animations.find(c => c.name.endsWith("|Idle"));
    mixer.clipAction(clip).play();
    const lower = g.scene.getObjectByName("FrontLowLegL"), upper = g.scene.getObjectByName("FrontUpLegL"), foot = g.scene.getObjectByName("FrontFootL");
    const endpoint = lower.worldToLocal(foot.getWorldPosition(new Vector3()));
    const a = upper.getWorldPosition(new Vector3()).distanceTo(lower.getWorldPosition(new Vector3()));
    const b = lower.getWorldPosition(new Vector3()).distanceTo(foot.getWorldPosition(new Vector3()));
    let before = 0, after = 0, motion = 0, previous;
    for (let i = 0; i < 120; i++) {
      mixer.setTime(i / 120 * (walk?.duration ?? 1.5));
      if (!walk) solver.gait(i / 120, 1.8, 1);
      g.scene.updateMatrixWorld(true);
      const target = foot.getWorldPosition(new Vector3()), hip = upper.getWorldPosition(new Vector3());
      const feasible = hip.clone().add(target.clone().sub(hip).clampLength(Math.abs(a-b) + .001, (a+b) * .999));
      before = Math.max(before, lower.localToWorld(endpoint.clone()).distanceTo(feasible));
      solver.update();g.scene.updateMatrixWorld(true);
      const actual = lower.localToWorld(endpoint.clone());
      after = Math.max(after, actual.distanceTo(feasible));
      if (previous) motion += actual.distanceTo(previous);
      previous = actual;
    }
    console.log(JSON.stringify({name,before,after,motion}));
    assert.ok(before > 20, "unbaked FK fails to track the control");
    assert.ok(after < .02, "solved two-bone chain reaches the feasible target");
    assert.ok(motion > 100, "limbs complete a real stride");
    mixer.stopAllAction();mixer.clipAction(g.animations.find(c => c.name.endsWith("|Idle"))).play();
    const lock = createFarmLegSolver(g.scene);
    let planted;
    for (let frame = 0; frame < 60; frame++) {
      mixer.update(1/60);g.scene.position.z += 0.05;lock.update(undefined, true);
      const actual = lower.localToWorld(endpoint.clone());
      if (!planted) planted = actual;
      else assert.ok(actual.distanceTo(planted) < .01, "planted foot stays put while the body advances");
    }
  });
}

test("spillway is one continuous ribbon with a rounded horizontal-to-vertical bend", () => {
  const geometry = spillwayGeometry(new Vector3(0, 0, 0), new Vector3(0, 0, 2), 1, 8);
  const p = geometry.getAttribute("position"), centers = [];
  for (let i = 0; i < p.count; i += 2) centers.push(new Vector3().fromBufferAttribute(p, i).add(new Vector3().fromBufferAttribute(p,i+1)).multiplyScalar(.5));
  let maxTurn = 0;
  for (let i = 2; i < centers.length; i++) maxTurn = Math.max(maxTurn, centers[i].clone().sub(centers[i-1]).angleTo(centers[i-1].clone().sub(centers[i-2])));
  assert.ok(maxTurn < Math.PI / 18, "no 90-degree corner between pieces");
  assert.equal(centers[0].y, 0);assert.equal(centers.at(-1).y, -8);
  assert.ok([...geometry.getAttribute("normal").array].every(Number.isFinite));geometry.dispose();
});
