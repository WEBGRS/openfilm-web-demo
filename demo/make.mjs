// Rebuild docs/again.gif and the skill's cover: film demo/site v1, cut it in OpenFilm, redesign to v2, refilm, render both
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const FILM = join(ROOT, 'demo', 'film');
const OUT = join(ROOT, 'out');
const RECORD = join(ROOT, 'skills', 'web-demo', 'scripts', 'record.mjs');
const NPX = process.platform === 'win32' ? 'npx.cmd' : 'npx';
mkdirSync(OUT, { recursive: true });
mkdirSync(join(FILM, 'assets'), { recursive: true });

// One address, two versions of the product behind it
let version = 'v1';
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  let body;
  try {
    body = readFileSync(join(ROOT, 'demo', 'site', version, path === '/' ? 'index.html' : path));
  } catch {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

const run = (cmd, args, cwd = ROOT) => {
  console.log(`> ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' && cmd === NPX, env: { ...process.env, OPENFILM_NO_BROWSER: '1' } });
  if (r.status !== 0) throw new Error(`${cmd} failed (${r.status})`);
};
// Five render browsers fail on Windows with EPERM in OpenFilm 0.2.0; two are enough here
const render = (to) => {
  run(NPX, ['-y', 'openfilm@0.2.0', 'render', '--workers', '2'], FILM);
  renameSync(join(FILM, 'film.mp4'), join(OUT, to));
};

const cut = readFileSync(join(FILM, 'film.html'), 'utf8');
try {
  run('node', [RECORD, url, join(FILM, 'assets', 'pinboard.mp4'), '--steps', join(FILM, 'steps.json')]);
  render('film-v1.mp4');
  version = 'v2';
  run('node', [RECORD, 'again', join(FILM, 'assets', 'pinboard.mp4'), '--film', join(FILM, 'film.html')]);
  render('film-v2.mp4');
} finally {
  // film.html in the repository is the cut of the first take
  copyFileSync(join(FILM, 'film.html'), join(OUT, 'film-v2.html'));
  writeFileSync(join(FILM, 'film.html'), cut);
  server.close();
}

const font = process.platform === 'win32' ? "C\\:/Windows/Fonts/segoeuib.ttf" : '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
const label = (i, text) => `[${i}]fps=12,scale=640:360:flags=lanczos,pad=640:404:0:44:color=0x0d0f24,drawtext=fontfile='${font}':text='${text}':fontcolor=white:fontsize=22:x=16:y=12[l${i}]`;
run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', join(OUT, 'film-v1.mp4'), '-i', join(OUT, 'film-v2.mp4'), '-filter_complex',
  `${label(0, 'First take')};${label(1, 'After a redesign\\: record.mjs again')};[l0][l1]hstack,split[x][y];[x]palettegen=max_colors=160:stats_mode=diff[p];[y][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`,
  join(ROOT, 'docs', 'again.gif')]);
run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', '7.6', '-i', join(OUT, 'film-v2.mp4'), '-frames:v', '1', '-vf', 'scale=1280:720:flags=lanczos', '-q:v', '3', join(ROOT, 'skills', 'web-demo', 'cover.jpg')]);
console.log('docs/again.gif and skills/web-demo/cover.jpg written');
