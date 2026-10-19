// Real takes in Chrome or Edge: what the video shows, the clock, the same steps giving the same take, and "again"
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
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
const RECORD = join(import.meta.dirname, '..', 'skills', 'web-demo', 'scripts', 'record.mjs');
const quiet = () => undefined;
// The command line in a child process, without blocking this one: the test site is served from here
const cli = (args, timeout = 300000) => new Promise((done) => {
  const child = spawn(process.execPath, [RECORD, ...args]);
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  const timer = setTimeout(() => child.kill(), timeout);
  child.on('close', (status, signal) => {
    clearTimeout(timer);
    done({ status, signal, stdout, stderr });
  });
});
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
  // WEB_DEMO_KEEP: a copy of the test project, to open in OpenFilm
  if (dir && process.env.WEB_DEMO_KEEP) cpSync(dir, process.env.WEB_DEMO_KEEP, { recursive: true });
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

test('again from the command line: the same page, every clip already in place, and the process exits', async () => {
  // The take on disk was filmed from v2 by the test above
  site.set('v2');
  const assets = join(dir, 'assets');
  const r = await cli(['again', join(assets, 'signup.mp4'), '--film', join(dir, 'film.html'), '--dry-run']);
  site.set('v1');
  assert.equal(r.signal, null, 'it exits by itself');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /2 clips of this take already in place/);
  assert.doesNotMatch(r.stdout, /has no clip of this take/);
});

test('an encoder that fails is the error reported, and nothing is left behind', async () => {
  // node.exe given ffmpeg's arguments exits at once: the encoder's failure must be what is reported
  const out = join(dir, 'broken', 'take.mp4');
  await assert.rejects(recordTake({ url: site.url, out, steps: [{ wait: 300 }], scale: 1, ffmpeg: process.execPath, log: quiet }), /ffmpeg stopped/);
  assert.equal(existsSync(out), false);
});

test('a browser killed mid-take lets go of its pipes when closed', () => {
  const r = spawnSync(process.execPath, [join(import.meta.dirname, 'fixtures', 'killed-browser.mjs')], { encoding: 'utf8', timeout: 60000 });
  assert.equal(r.error, undefined, 'it exits by itself');
  assert.deepEqual(JSON.parse(r.stdout.trim().split('\n').pop()), { closed: true, pipes: [true, true, true] });
});

test('--pointer draws the pointer into the video, and without it the video has none', async () => {
  const steps = [{ wait: 300 }, { click: 'text="Save"' }, { wait: 300 }];
  const { record: drawn } = await recordTake({ url: site.url, out: join(dir, 'pointer', 'take.mp4'), steps, scale: 1, pointer: true, log: quiet });
  await recordTake({ url: site.url, out: join(dir, 'plain', 'take.mp4'), steps, scale: 1, log: quiet });
  assert.equal(drawn.pointer, true);
  const down = drawn.take.events.find((e) => e.type === 'down');
  // Dark pixels just below and right of the pointer's tip, in the first frame after the press: the arrow's body
  const dark = (file) => {
    const f = frameRGB(file, frameAt(down.t));
    let n = 0;
    for (let y = 7; y <= 10; y++) {
      for (let x = 2; x <= 5; x++) {
        const i = ((Math.round(down.y) + y) * f.w + Math.round(down.x) + x) * 3;
        if (f.px[i] < 70 && f.px[i + 1] < 70 && f.px[i + 2] < 70) n++;
      }
    }
    return n;
  };
  assert.ok(dark(join(dir, 'pointer', 'take.mp4')) >= 12, 'the arrow is in the video');
  assert.ok(dark(join(dir, 'plain', 'take.mp4')) <= 3, 'no arrow without --pointer');
});

test('inspect lists what can be pointed at, before and after steps', async () => {
  const plain = await inspect(site.url, {});
  assert.match(plain, /#title · input\[text\] · A note/);
  assert.match(plain, /#save · button · Save/);
  const after = await inspect(site.url, { steps: [{ fill: ['#title', 'Buy milk'] }, { click: 'text="Save"' }] });
  assert.match(after, /#title · input\[text\] · Buy milk/);
});

