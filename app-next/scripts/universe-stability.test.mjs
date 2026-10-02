import test from 'node:test';
import assert from 'node:assert/strict';
import { meteorSegment, starFieldOpacity } from '../src/universeAtmosphere.ts';
import { advanceLabel } from '../src/universeLabels.ts';

test('stars leave the frame edges clear and fade toward the outer field', () => {
  const fade = (x, y) => starFieldOpacity(x, y, 500, 400, 1000, 800);
  for (const point of [[0, 400], [30, 400], [500, 0], [500, 780], [1000, 400]]) assert.equal(fade(...point), 0);
  assert.ok(fade(500, 400) > fade(250, 400));
  assert.ok(fade(250, 400) > fade(120, 400));
  assert.ok(fade(500, 400) >= 0.5 && fade(500, 400) <= 0.65);
});

test('meteor travel follows its tail on square, ultrawide and portrait screens', () => {
  for (const [width, height] of [[1000,1000],[3840,1080],[900,1600]]) for (const direction of [-1,1]) {
    const meteor = {x:.3,y:.2,direction,slope:.6,length:80};
    const a=meteorSegment(meteor,.2,width,height), b=meteorSegment(meteor,.6,width,height);
    const vx=b.headX-a.headX, vy=b.headY-a.headY, tx=b.headX-b.tailX, ty=b.headY-b.tailY;
    assert.ok(Math.abs(vx*ty-vy*tx)<1e-8);
    assert.ok(vx*tx+vy*ty>0);
    assert.ok(Math.abs(Math.hypot(tx,ty)-80)<1e-8);
  }
});

test('a one-frame collision cannot move or blink a visible label', () => {
  const state = { side: 0, opacity: 1, blockedSince: 0, updatedAt: 0 };
  advanceLabel(state, [false, true], 16);
  assert.equal(state.side, 0);
  assert.equal(state.opacity, 1);
  advanceLabel(state, [true, true], 32);
  assert.equal(state.side, 0);
  assert.equal(state.opacity, 1);
});

test('a lasting collision fades out before changing side and then fades in', () => {
  const state = { side: 0, opacity: 1, blockedSince: 0, updatedAt: 0 };
  let previousOpacity = 1;
  for (let now = 16; now <= 800; now += 16) {
    const previousSide = state.side;
    advanceLabel(state, [false, true], now);
    if (state.side !== previousSide) assert.ok(state.opacity <= 0.01);
    assert.ok(Math.abs(state.opacity - previousOpacity) < 0.1);
    previousOpacity = state.opacity;
  }
  assert.equal(state.side, 1);
  assert.equal(state.opacity, 1);
});

test('unplaceable new labels remain invisible and reduced motion settles immediately', () => {
  const state = { side: 0, opacity: 0, blockedSince: 0, updatedAt: 0 };
  advanceLabel(state, [false, false], 16);
  assert.equal(state.opacity, 0);
  advanceLabel(state, [true, false], 32, true);
  assert.equal(state.opacity, 1);
});
