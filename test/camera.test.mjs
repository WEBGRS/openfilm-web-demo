// The camera page: where it moves in, how it moves, and the page it writes; no browser
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { anchors, camera, cameraPage, cameraPath, parseSteps, ZOOM, zoomPlan } from '../skills/web-demo/scripts/record.mjs';

// A 1440 x 810 take: a click on a field at 2 s, typing after it, a click on a button far away at 6 s
const steps = [{ wait: 1500 }, { fill: ['#title', 'abc'] }, { wait: 2000 }, { click: '#save' }, { wait: 2000 }];
function record({ zoom, stepZoom = {} } = {}) {
  const st = steps.map((s, i) => (stepZoom[i] === undefined ? s : { ...s, zoom: stepZoom[i] }));
  const events = [{ t: 0, type: 'move', x: 720, y: 405 }];
  for (let i = 1; i <= 15; i++) events.push({ t: 1.5 + i / 30, type: 'move', x: 720 - i * 30, y: 405 - i * 13 });
  events.push({ t: 2, type: 'down', x: 270, y: 210 }, { t: 2.1, type: 'up', x: 270, y: 210 });
  for (const t of [2.4, 2.5, 2.6]) events.push({ t, type: 'key', key: 'a' });
  for (let i = 1; i <= 20; i++) events.push({ t: 5.3 + i / 30, type: 'move', x: 270 + i * 50, y: 210 + i * 25 });
  events.push({ t: 6, type: 'down', x: 1270, y: 710 }, { t: 6.1, type: 'up', x: 1270, y: 710 });
  return {
    size: '1440x810', fps: 30, steps: st, ...(zoom === undefined ? {} : { zoom }),
    take: { video: 'signup.mp4', duration: 8, steps: st.map((step, i) => ({ t: [0, 1.5, 3.2, 5.2, 6.3][i], step })), events },
  };
}

test('the view moves in around each click and holds through the typing after it', () => {
  const plan = zoomPlan(record());
  assert.equal(plan.length, 2);
  assert.deepEqual(plan.map((s) => [s.x, s.y, s.s]), [[270, 210, ZOOM], [1270, 710, ZOOM]]);
  assert.ok(plan[0].a <= 1.4 + 1e-9 && plan[0].b >= 3.8 - 1e-9, `first span ${plan[0].a}-${plan[0].b} covers the click and the typing`);
  assert.ok(plan[1].a <= 5.4 + 1e-9 && plan[1].b === 7.6, `second span ${plan[1].a}-${plan[1].b}`);
});

test('a step zoom changes its own clicks; false leaves them unzoomed; the record zoom is the default', () => {
  const two = zoomPlan(record({ stepZoom: { 3: 2.5 } }));
  assert.deepEqual(two.map((s) => s.s), [ZOOM, 2.5]);
  const none = zoomPlan(record({ stepZoom: { 1: false } }));
  assert.deepEqual(none.map((s) => [s.x, s.y]), [[1270, 710]]);
  assert.deepEqual(zoomPlan(record({ zoom: 2 })).map((s) => s.s), [2, 2]);
  assert.deepEqual(zoomPlan(record({ zoom: false })), []);
});

test('spans close together on the same spot become one; a short gap is bridged', () => {
  const r = record();
  r.take.events.push({ t: 3.3, type: 'down', x: 275, y: 212 }, { t: 3.4, type: 'up', x: 275, y: 212 });
  const plan = zoomPlan(r);
  assert.equal(plan.length, 2, 'the second click on the same spot joins the first span');
  assert.ok(plan[0].b >= 4.9 - 1e-9);
  assert.equal(plan[0].b, plan[1].a, 'the gap under 0.9 s is bridged: the view pans instead of pulling out');
});

test('the camera path starts and ends on the whole window, reaches the zoom, and never leaves the window', () => {
  const path = cameraPath(record());
  assert.equal(path.length, 8 * 60 + 1);
  assert.deepEqual(path[0], [1, 0, 0]);
  const at = (t) => path[Math.round(t * 60)];
  assert.ok(Math.abs(at(3)[0] - ZOOM) < 0.02, `zoomed in at 3 s: ${at(3)[0]}`);
  assert.ok(at(7.99)[0] < at(7.6)[0] - 0.2, `on its way out after the last span: ${at(7.6)[0]} -> ${at(7.99)[0]}`);
  for (const [s, x, y] of path) {
    assert.ok(s >= 0.999 && x >= -0.05 && y >= -0.05 && x + 1440 / s <= 1440.05 && y + 810 / s <= 810.05, `in the window: ${s} ${x} ${y}`);
  }
  // No jolt: the scale moves on smoothly from one sample to the next
  for (let i = 2; i < path.length; i++) assert.ok(Math.abs(path[i][0] - 2 * path[i - 1][0] + path[i - 2][0]) < 0.01);
});

test('while zoomed in, the pointer stays in view as it travels', () => {
  const r = record();
  const path = cameraPath(r);
  const moves = r.take.events.filter((e) => e.type === 'move' || e.type === 'down');
  for (let i = 0; i < path.length; i++) {
    const t = i / 60;
    const p = moves.filter((e) => e.t <= t).pop();
    const [s, x, y] = path[i];
    if (s < 1.5) continue;
    assert.ok(p.x >= x - 1 && p.x <= x + 1440 / s + 1 && p.y >= y - 1 && p.y <= y + 810 / s + 1, `pointer ${p.x},${p.y} in view at ${t.toFixed(2)} s`);
  }
});

test('the view follows a pointer that wanders off while it is zoomed in', () => {
  const r = record();
  // While the typing holds the zoom on the field, the pointer drifts 700 px to the right
  for (let i = 1; i <= 18; i++) r.take.events.push({ t: 2.7 + i / 30, type: 'move', x: 270 + i * 40, y: 210 + i * 8 });
  r.take.events.sort((a, b) => a.t - b.t);
  const path = cameraPath(r);
  const [s, x] = path[Math.round(3.4 * 60)];
  assert.ok(s > 1.5, `still zoomed in at 3.4 s: ${s}`);
  // Held on the field alone, the left edge would be 0
  assert.ok(x > 150, `the view moved right after the pointer: left edge ${x}`);
  assert.ok(990 <= x + 1440 / s, `the pointer at x 990 is in view: ${x}..${x + 1440 / s}`);
});

test('the camera page is a film page that plays its video, sized like the take', () => {
  const html = cameraPage(record());
  assert.match(html, /window\.film = \{ frame, duration: 8, width: 1440, height: 810, ready \}/);
  assert.match(html, /<video id="take" src="signup\.mp4" muted playsinline preload="auto"><\/video>/);
  assert.match(html, /video\.currentTime = Math\.min\(Math\.max\(t, 0\), 7\.983\)/);
  assert.match(html, /if \(!window\.filmHost\)/);
  const named = cameraPage({ ...record(), take: { ...record().take, video: 'take #1 ?.mp4' } });
  assert.match(named, /src="take%20%231%20%3F\.mp4"/);
  assert.match(cameraPage({ ...record(), pointer: true }), /<g id="pointer" style="display: none">/);
});

test('a step zoom is not part of what the step does: the step keeps its anchor', () => {
  const plain = anchors(record().take).map((a) => a.key);
  const zoomed = anchors(record({ stepZoom: { 1: 2.2, 3: false } }).take).map((a) => a.key);
  assert.deepEqual(zoomed, plain);
  assert.throws(() => parseSteps([{ click: '#a', zoom: 9 }]), /zoom is a number from 1 to 4/);
  assert.doesNotThrow(() => parseSteps([{ click: '#a', zoom: false }, { hover: '#b', zoom: 2 }]));
});

test('camera writes the page again from the record, with the zoom changed and nothing filmed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'web-demo-camera-'));
  try {
    const video = join(dir, 'signup.mp4');
    const r = record();
    writeFileSync(join(dir, 'signup.record.json'), JSON.stringify(r));
    let lines = camera(video, { zoom: '2.4' });
    assert.match(lines.join('\n'), /camera: 2\.4x [\d.]+-[\d.]+ s on 270,210 \(step 2 \{"fill"/);
    assert.equal(JSON.parse(readFileSync(join(dir, 'signup.record.json'), 'utf8')).zoom, 2.4);
    // A zoom on one step, edited in the record's steps
    const edited = JSON.parse(readFileSync(join(dir, 'signup.record.json'), 'utf8'));
    edited.steps[3].zoom = false;
    writeFileSync(join(dir, 'signup.record.json'), JSON.stringify(edited));
    lines = camera(video);
    assert.equal(lines.filter((l) => l.startsWith('camera:')).length, 1);
    assert.match(readFileSync(join(dir, 'signup.camera.html'), 'utf8'), /const PATH = \[\[1,0,0\]/);
    // Steps changed in what they do need a new take
    edited.steps[3] = { click: '#other' };
    writeFileSync(join(dir, 'signup.record.json'), JSON.stringify(edited));
    assert.throws(() => camera(video), /not the ones filmed: "again" films them/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
