// Pure-logic tests for scripted flows: pan-camera math + flow selection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flowKeyframe, flowMapPoint, flowUnmapPoint, globMatch, pickFlow } from './post.mjs';

const W = 1280, H = 800;

test('flowKeyframe centers an interior target and maps it to viewport center', () => {
  const restC = { x: 500, y: 300 };
  const k = flowKeyframe(restC, 1.7);
  const p = flowMapPoint(restC, k);
  assert.ok(Math.abs(p.x - W / 2) < 1e-6, `x ${p.x}`);
  assert.ok(Math.abs(p.y - H / 2) < 1e-6, `y ${p.y}`);
});

test('flowKeyframe never reveals content edges (no-gap clamp)', () => {
  for (let i = 0; i < 500; i++) {
    const restC = { x: Math.random() * W, y: Math.random() * H };
    const s = 1 + Math.random(); // 1..2
    const k = flowKeyframe(restC, s);
    const tl = flowMapPoint({ x: 0, y: 0 }, k);
    const br = flowMapPoint({ x: W, y: H }, k);
    assert.ok(tl.x <= 1e-9 && tl.y <= 1e-9, `gap TL ${JSON.stringify({ restC, s, tl })}`);
    assert.ok(br.x >= W - 1e-9 && br.y >= H - 1e-9, `gap BR ${JSON.stringify({ restC, s, br })}`);
  }
});

test('flowUnmapPoint inverts flowMapPoint', () => {
  const k = flowKeyframe({ x: 900, y: 600 }, 1.9);
  const rest = { x: 320, y: 180 };
  const back = flowUnmapPoint(flowMapPoint(rest, k), k);
  assert.ok(Math.abs(back.x - rest.x) < 1e-6 && Math.abs(back.y - rest.y) < 1e-6);
});

test('edge target punches in softer but stays clamped (no gap)', () => {
  const k = flowKeyframe({ x: W - 10, y: H / 2 }, 1.7); // far-right target
  assert.equal(k.tx, -(1.7 - 1) * W); // clamped to the right edge
  const br = flowMapPoint({ x: W, y: H }, k);
  assert.ok(br.x >= W - 1e-9);
});

test('globMatch handles * and **', () => {
  assert.ok(globMatch('src/scorer/**', 'src/scorer/ui/Draft.tsx'));
  assert.ok(globMatch('src/*.ts', 'src/index.ts'));
  assert.ok(!globMatch('src/*.ts', 'src/deep/index.ts'));
  assert.ok(globMatch('**/Button.tsx', 'app/components/Button.tsx'));
  assert.ok(!globMatch('src/scorer/**', 'src/other/x.ts'));
});

test('pickFlow: matches by navTarget substring', () => {
  const flows = [{ name: 'score', steps: ['a'], match: { navTarget: 'scorer' } }];
  assert.equal(pickFlow(flows, { nav_target: 'Post Scorer', files: [] }), flows[0]);
  assert.equal(pickFlow(flows, { nav_target: 'Badge', files: [] }), null);
});

test('pickFlow: matches by file glob', () => {
  const flows = [{ name: 'score', steps: ['a'], match: { paths: ['src/scorer/**'] } }];
  assert.equal(pickFlow(flows, { nav_target: '', files: ['src/scorer/ui.tsx'] }), flows[0]);
  assert.equal(pickFlow(flows, { nav_target: '', files: ['src/other.tsx'] }), null);
});

test('pickFlow: a criteria-less flow is used only when it is the sole flow', () => {
  const solo = [{ name: 'only', steps: ['a'] }];
  assert.equal(pickFlow(solo, { nav_target: 'anything', files: [] }), solo[0]);
  const many = [{ name: 'a', steps: ['x'] }, { name: 'b', steps: ['y'], match: { navTarget: 'z' } }];
  assert.equal(pickFlow(many, { nav_target: 'nomatch', files: [] }), null);
});

test('pickFlow: ignores flows without steps, and empty input', () => {
  assert.equal(pickFlow([{ name: 'x', match: { navTarget: 'a' } }], { nav_target: 'a' }), null);
  assert.equal(pickFlow([], { nav_target: 'a' }), null);
  assert.equal(pickFlow(undefined, { nav_target: 'a' }), null);
});
