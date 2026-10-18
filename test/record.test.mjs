// Real takes in Chrome or Edge: what the video shows, the clock, the same steps giving the same take, and "again"
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { again, inspect, recordTake } from '../skills/web-demo/scripts/record.mjs';
import { COLORS, count, frameAt, frameRGB, leftEdge, probe, serve } from './helpers.mjs';

const STEPS = [
  { wait: 500 },
  { fill: ['#title', 'Buy milk'] },
  { mark: 'typed' },
  { click: 'text="Save"' },
  { wait: 800 },
  { select: ['#color', 'green'] },
  { scrollTo: '#footer' },
  { mark: 'bottom' },
  { wait: 500 },
];
const quiet = () => undefined;
const md5 = (f) => createHash('md5').update(readFileSync(f)).digest('hex');
const stepAt = (rec, i) => rec.take.steps[i].t;

let site;
let dir;
let first;

before(async () => {
  site = await serve('v1');
  dir = mkdtempSync(join(tmpdir(), 'web-demo-test-'));
  mkdirSync(join(dir, 'assets'));
  ({ record: first } = await recordTake({ url: site.url, out: join(dir, 'assets', 'signup.mp4'), steps: STEPS, scale: 1, log: quiet }));
});

after(async () => {
  await site?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test('the take is written with its record and its pointer page', () => {
  const video = join(dir, 'assets', 'signup.mp4');
  for (const f of ['signup.mp4', 'signup.record.json', 'signup.cursor.html']) assert.ok(existsSync(join(dir, 'assets', f)), f);
  const p = probe(video);
  assert.equal(p.width, 1440);
  assert.equal(p.height, 810);
  assert.equal(p.rate, '30/1');
  assert.equal(p.frames, Math.round(first.take.duration * 30));
  const saved = JSON.parse(readFileSync(join(dir, 'assets', 'signup.record.json'), 'utf8'));
  assert.deepEqual(saved.steps, STEPS);
  assert.equal(saved.take.steps.length, STEPS.length);
  const ts = saved.take.steps.map((s) => s.t);
  assert.deepEqual([...ts].sort((a, b) => a - b), ts);
  assert.ok(saved.take.events.some((e) => e.type === 'down') && saved.take.events.some((e) => e.type === 'up'));
});

test('the picture shows each step done: typed, saved, picked, scrolled', () => {
  const video = join(dir, 'assets', 'signup.mp4');
  // #status turns green only when the field holds exactly "Buy milk" and Save was clicked
  const beforeSave = frameRGB(video, frameAt(stepAt(first, 3)), 0.5);
  const afterSave = frameRGB(video, frameAt(stepAt(first, 4)) + 3, 0.5);
  assert.ok(count(beforeSave, COLORS.red) > 300, 'status red before Save');
  assert.ok(count(beforeSave, COLORS.green) < 50, 'no green before Save');
  assert.ok(count(afterSave, COLORS.green) > 300, 'status green after Save');
  // The swatch turns green after the select step
  const picked = frameRGB(video, frameAt(stepAt(first, 6)), 0.5);
  assert.ok(count(picked, COLORS.green) > 2 * count(afterSave, COLORS.green) * 0.9, 'swatch green too');
  // The last frame shows the footer
  const last = frameRGB(video, probe(video).frames - 1, 0.5);
  assert.ok(count(last, COLORS.footer) > 10000, 'footer in view at the end');
});

test('the page clock moves one frame per frame: CSS animation and requestAnimationFrame', () => {
  const video = join(dir, 'assets', 'signup.mp4');
  // Both boxes travel 100 CSS px a second; row 20 crosses the CSS one, row 52 the rAF one (below a 72 px header)
  for (const [name, y] of [['runner', 72 + 20], ['rafbox', 72 + 52]]) {
    const a = leftEdge(frameRGB(video, 0), y, COLORS[name]);
    const b = leftEdge(frameRGB(video, 15), y, COLORS[name]);
    assert.ok(a >= 0 && b >= 0, `${name} found`);
    assert.ok(Math.abs(b - a - 50) <= 2, `${name} moved ${b - a} px in 15 frames, 50 expected`);
  }
});

test('the same steps give the same take', async () => {
  const { record: second } = await recordTake({ url: site.url, out: join(dir, 'again', 'signup.mp4'), steps: STEPS, scale: 1, log: quiet });
  assert.equal(second.take.duration, first.take.duration);
  assert.deepEqual(second.take.steps, first.take.steps);
  assert.deepEqual(second.take.events, first.take.events);
});

test('again: a redesigned page, the film keeps its edit', async () => {
  const assets = join(dir, 'assets');
  const film = join(dir, 'film.html');
  // A shot from just after the typing to just after Save, its pointer above it, and an unrelated title
  const tin = +(stepAt(first, 2) + 0.2).toFixed(3);
  const tout = +(stepAt(first, 4) + 0.5).toFixed(3);
  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=1920, height=1080">
</head>
<body>
<section>
  <iframe src="assets/signup.cursor.html#t=${tin},${tout}" at="2" style="left: 160px; top: 90px; width: 1600px; height: 900px"></iframe>
</section>
<section>
  <iframe id="title" src="title.html#t=0,2"></iframe>
  <video id="save" src="assets/signup.mp4#t=${tin},${tout}" at="2" style="left: 160px; top: 90px; width: 1600px; height: 900px"></video>
</section>
</body>
</html>
`;
  writeFileSync(film, html);
  site.set('v2');

  // A dry run changes nothing
  const before = Object.fromEntries(['signup.mp4', 'signup.record.json', 'signup.cursor.html'].map((f) => [f, md5(join(assets, f))]));
  const dry = await again(join(assets, 'signup.mp4'), { film, dryRun: true, log: quiet });
  assert.equal(readFileSync(film, 'utf8'), html);
  for (const [f, h] of Object.entries(before)) assert.equal(md5(join(assets, f)), h, `${f} untouched by --dry-run`);
  assert.equal(dry.plan.changes.length, 2);

  const r = await again(join(assets, 'signup.mp4'), { film, log: quiet });
  const now = JSON.parse(readFileSync(join(assets, 'signup.record.json'), 'utf8'));
  assert.notEqual(now.take.recorded, first.take.recorded);
  // The banner and the wider field move the steps later
  const shift = stepAt(now, 2) - stepAt(first, 2);
  assert.ok(Math.abs(shift) > 0.03, `the typing moved (${shift} s)`);
  const nin = +(stepAt(now, 2) + 0.2).toFixed(3);
  const nout = +(nin + (tout - tin)).toFixed(3);
  const text = readFileSync(film, 'utf8');
  assert.match(text, new RegExp(`src="assets/signup.mp4#t=${nin},${nout}" at="2"`));
  assert.match(text, new RegExp(`src="assets/signup.cursor.html#t=${nin},${nout}" at="2"`));
  assert.match(text, /src="title.html#t=0,2"/);
  assert.deepEqual(r.plan.problems, []);
  // The new frame at the clip's start shows the new page (the v2 banner's yellow)
  const f = frameRGB(join(assets, 'signup.mp4'), frameAt(nin), 0.5);
  assert.ok(count(f, [255, 233, 168], 12) > 1000, 'the new take shows v2');
  assert.match(readFileSync(join(assets, 'signup.cursor.html'), 'utf8'), new RegExp(`duration: ${now.take.duration},`));
  site.set('v1');
});

test('again with a step the page no longer has leaves the take as it was', async () => {
  const assets = join(dir, 'assets');
  const rec = join(assets, 'signup.record.json');
  const saved = JSON.parse(readFileSync(rec, 'utf8'));
  writeFileSync(rec, JSON.stringify({ ...saved, steps: [...saved.steps.slice(0, 3), { click: 'text="Publish"' }] }));
  const video = md5(join(assets, 'signup.mp4'));
  const film = readFileSync(join(dir, 'film.html'), 'utf8');
  await assert.rejects(again(join(assets, 'signup.mp4'), { film: join(dir, 'film.html'), log: quiet }), /step 4 \{"click":"text=\\"Publish\\""\}: nothing matches/);
  assert.equal(md5(join(assets, 'signup.mp4')), video);
  assert.equal(readFileSync(join(dir, 'film.html'), 'utf8'), film);
  writeFileSync(rec, JSON.stringify(saved));
});

test('inspect lists what can be pointed at, before and after steps', async () => {
  const plain = await inspect(site.url, {});
  assert.match(plain, /#title · input\[text\] · A note/);
  assert.match(plain, /#save · button · Save/);
  const after = await inspect(site.url, { steps: [{ fill: ['#title', 'Buy milk'] }, { click: 'text="Save"' }] });
  assert.match(after, /#title · input\[text\] · Buy milk/);
});

test('a project folder can be copied for OpenFilm checks', () => {
  // Leaves a copy of the project in WEB_DEMO_KEEP for test/openfilm.mjs
  if (!process.env.WEB_DEMO_KEEP) return;
  cpSync(dir, process.env.WEB_DEMO_KEEP, { recursive: true });
});
