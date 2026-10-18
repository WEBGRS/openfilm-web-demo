// film.html keeps its edit across takes: unit tests on the remapping, no browser
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { anchors, cursorPage, keyOf, parseSteps, remapFilm, scanClips, shifts } from '../skills/web-demo/scripts/record.mjs';

const DIR = join(import.meta.dirname, 'proj');
const VIDEO = join(DIR, 'assets', 'signup.mp4');
const CURSOR = join(DIR, 'assets', 'signup.cursor.html');
const FILES = [VIDEO, CURSOR];

const steps = [{ wait: 500 }, { click: '#a' }, { mark: 'form' }, { type: 'hello' }, { click: '#a' }, { mark: 'done' }, { wait: 500 }];
const take = (times, duration) => ({ duration, steps: steps.map((step, i) => ({ t: times[i], step })) });
// The new take: everything after the first click is 1.5 s later, the form takes 0.25 s longer to fill
const before = take([0, 0.5, 2, 2, 4, 5, 5], 6);
const after = take([0, 0.5, 3.5, 3.5, 5.75, 6.75, 6.75], 7.75);

const film = (body) => `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=1920, height=1080">
</head>
<body>
${body}
</body>
</html>
`;

test('anchors: the start, each step by what it is and which time it came, each mark', () => {
  const a = anchors(before);
  assert.deepEqual(a.map((x) => x.key), ['start', 'step:{"wait":500}#0', 'step:{"click":"#a"}#0', 'mark:form#0', 'step:{"type":"hello"}#0', 'step:{"click":"#a"}#1', 'mark:done#0', 'step:{"wait":500}#1']);
});

test('a clip follows the step or mark it falls in and keeps its length', () => {
  const html = film(`<section>
  <iframe src="assets/signup.cursor.html#t=2.5,4.5" at="3" style="left: 160px; top: 90px; width: 1600px; height: 900px"></iframe>
</section>
<section>
  <video id="form" src="assets/signup.mp4#t=2.5,4.5" at="3" style="left: 160px; top: 90px; width: 1600px; height: 900px"></video>
  <video id="end" src="assets/signup.mp4#t=5.2,5.8" at="5"></video>
</section>`);
  const r = remapFilm(html, { filmDir: DIR, files: FILES, before, after });
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.changes.map((c) => [c.id, c.from, c.to]), [
    ['assets/signup.cursor.html', '#t=2.5,4.5', '#t=4,6'],
    ['form', '#t=2.5,4.5', '#t=4,6'],
    ['end', '#t=5.2,5.8', '#t=6.95,7.55'],
  ]);
  // Only the fragments change: the rest of film.html is byte for byte the same
  assert.equal(r.text.replace(/#t=[\d.,]+/g, '#t'), html.replace(/#t=[\d.,]+/g, '#t'));
  assert.match(r.text, /src="assets\/signup.mp4#t=4,6" at="3"/);
});

test('a clip of all of it, or to its end, gets its old length written out', () => {
  const html = film(`<section>
  <video id="all" src="assets/signup.mp4"></video>
  <video id="tail" src="assets/signup.mp4#t=5.5" at="7"></video>
</section>`);
  const r = remapFilm(html, { filmDir: DIR, files: FILES, before, after });
  assert.deepEqual(r.changes.map((c) => [c.id, c.to]), [['all', '#t=0,6'], ['tail', '#t=7.25,7.75']]);
});

test('a clip whose step and mark are both gone is listed and left as it was', () => {
  // The steps were edited before "again": the mark "form" is gone and the typing changed
  const edited = { duration: 7, steps: before.steps.filter((s) => s.step.mark !== 'form').map((s) => (s.step.type ? { ...s, step: { type: 'hi' } } : s)) };
  const html = film(`<section>
  <video id="end" src="assets/signup.mp4#t=5.2,5.8" at="5"></video>
  <video id="form" src="assets/signup.mp4#t=2.5,3" at="1"></video>
</section>`);
  const r = remapFilm(html, { filmDir: DIR, files: FILES, before, after: edited });
  assert.equal(r.problems.length, 1);
  assert.equal(r.problems[0].id, 'form');
  assert.match(r.problems[0].why, /step 4 \{"type":"hello"\}, which the new take does not have/);
  assert.match(r.text, /signup.mp4#t=2.5,3"/);
  assert.match(r.text, /signup.mp4#t=5.2,5.8"/);
  assert.equal(r.changes.length, 0);
});

test('a mark and the step after it share a moment: either one holds the clip', () => {
  // "form" is gone but the type step at the same moment is there, so the clip still follows
  const noForm = { duration: 7.75, steps: after.steps.filter((s) => s.step.mark !== 'form') };
  const html = film('<section><video id="x" src="assets/signup.mp4#t=2.25,2.75"></video></section>');
  const r = remapFilm(html, { filmDir: DIR, files: FILES, before, after: noForm });
  assert.deepEqual(r.problems, []);
  assert.equal(r.changes[0].to, '#t=3.75,4.25');
});

test('a clip that would run past the new end is listed', () => {
  const short = take([0, 0.5, 2, 2, 4, 5, 5], 5.4);
  const html = film('<section><video id="late" src="assets/signup.mp4#t=5.1,5.9"></video></section>');
  const r = remapFilm(html, { filmDir: DIR, files: FILES, before, after: short });
  assert.equal(r.changes.length, 0);
  assert.match(r.problems[0].why, /past the new take's end at 5.4 s/);
});

test('other clips, comments and quoted ">" in overrides are left alone', () => {
  const html = film(`<!-- <video src="assets/signup.mp4#t=1,2"></video> -->
<section>
  <iframe id="title" src="title.html#t=0,4" overrides='[{"at":"#t","text":"a > b"}]'></iframe>
  <video id="other" src="assets/other.mp4#t=2.5,4"></video>
  <video id="mine" src='assets/signup.mp4#t=2.5,4' overrides='[{"fade":[0.5,0]}]'></video>
</section>`);
  const r = remapFilm(html, { filmDir: DIR, files: FILES, before, after });
  assert.deepEqual(r.changes.map((c) => c.id), ['mine']);
  assert.match(r.text, /<!-- <video src="assets\/signup.mp4#t=1,2"><\/video> -->/);
  assert.match(r.text, /src='assets\/signup.mp4#t=4,5.5'/);
  assert.match(r.text, /src="assets\/other.mp4#t=2.5,4"/);
});

test('scanClips reads unquoted and quoted values', () => {
  const clips = scanClips('<video src=a.mp4#t=1,2 at=3 muted><img src="p.png#t=0,4"><audio src=\'s.mp3\'>');
  assert.deepEqual(clips.map((c) => [c.tag, c.attrs.find((a) => a.name === 'src').value]), [['video', 'a.mp4#t=1,2'], ['img', 'p.png#t=0,4'], ['audio', 's.mp3']]);
});

test('shifts lists what moved', () => {
  const s = shifts(before, after);
  assert.equal(s.length, 5);
  assert.deepEqual(s[0], { label: 'mark "form"', from: 2, to: 3.5 });
});

test('steps are checked before anything is opened', () => {
  assert.throws(() => parseSteps({}), /JSON list/);
  assert.throws(() => parseSteps([{ clik: '#a' }]), /exactly one of/);
  assert.throws(() => parseSteps([{ click: '#a', wait: 3 }]), /exactly one of/);
  assert.throws(() => parseSteps([{ fill: '#a' }]), /\["<selector>", "text"\]/);
  assert.throws(() => parseSteps([{ press: 'Hyper+X' }]), /unknown modifier/);
  assert.throws(() => parseSteps([{ wait: -1 }]), /number/);
  assert.throws(() => parseSteps([{ click: '#a', in: '.x' }]), /does not go with/);
  assert.doesNotThrow(() => parseSteps([{ scroll: -300, in: '.panel', ms: 600 }, { type: '' }, { press: 'Control+k' }]));
});

test('keys', () => {
  assert.deepEqual(keyOf('Enter'), { key: 'Enter', code: 'Enter', vk: 13, text: '\r', modifiers: 0 });
  assert.deepEqual(keyOf('Control+k'), { key: 'k', code: 'KeyK', vk: 75, text: undefined, modifiers: 2 });
  assert.deepEqual(keyOf('Shift+a'), { key: 'A', code: 'KeyA', vk: 65, text: 'A', modifiers: 8 });
  assert.deepEqual(keyOf('+'), { key: '+', code: undefined, vk: 43, text: '+', modifiers: 0 });
});

test('the pointer page is a film page sized like the take', () => {
  const html = cursorPage({ size: '1440x810', take: { video: 'signup.mp4', duration: 6, events: [{ t: 0, type: 'move', x: 720, y: 405 }, { t: 1, type: 'down', x: 10, y: 10 }, { t: 1.1, type: 'up', x: 10, y: 10 }] } });
  assert.match(html, /window\.film = \{ frame, duration: 6, width: 1440, height: 810 \}/);
  assert.match(html, /viewBox="0 0 1440 810"/);
  assert.match(html, /const DOWNS = \[1\];/);
});
