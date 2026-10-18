// Test helpers: a local site that can switch versions, and pixel reads from a take through ffmpeg
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';

export const SITE = join(import.meta.dirname, 'site');

/** Serve test/site/<version>/ at one address; set() switches the version, as a product changes behind its URL. */
export async function serve(version) {
  let dir = join(SITE, version);
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    try {
      const body = readFileSync(join(dir, path === '/' ? 'index.html' : path));
      res.writeHead(200, { 'content-type': path.endsWith('.css') ? 'text/css' : 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}/`,
    set: (v) => (dir = join(SITE, v)),
    close: () => new Promise((r) => server.close(r)),
  };
}

/** Frames, size and length of a video. */
export function probe(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=width,height,nb_read_frames,r_frame_rate', '-of', 'json', file], { encoding: 'utf8' });
  const s = JSON.parse(r.stdout).streams[0];
  return { width: s.width, height: s.height, frames: Number(s.nb_read_frames), rate: s.r_frame_rate };
}

/** One frame as RGB bytes, `scale` times its size. */
export function frameRGB(file, n, scale = 1) {
  const { width, height } = probe(file);
  const w = Math.round(width * scale);
  const h = Math.round(height * scale);
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-vf', `select=eq(n\\,${n}),scale=${w}:${h}:flags=neighbor`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 28 });
  if (r.status !== 0 || r.stdout.length !== w * h * 3) throw new Error(`frame ${n} of ${file}: ${r.stderr}`);
  return { w, h, px: r.stdout };
}

const near = (px, i, [r, g, b], tol) => Math.abs(px[i] - r) <= tol && Math.abs(px[i + 1] - g) <= tol && Math.abs(px[i + 2] - b) <= tol;

/** How many pixels of a frame are about this colour. */
export function count(frame, rgb, tol = 24) {
  let n = 0;
  for (let i = 0; i < frame.px.length; i += 3) if (near(frame.px, i, rgb, tol)) n++;
  return n;
}

/** The leftmost x of this colour on row y, or -1. */
export function leftEdge(frame, y, rgb, tol = 40) {
  for (let x = 0; x < frame.w; x++) if (near(frame.px, (y * frame.w + x) * 3, rgb, tol)) return x;
  return -1;
}

export const COLORS = {
  runner: [255, 0, 170],
  rafbox: [0, 160, 255],
  green: [0, 200, 83],
  red: [224, 0, 0],
  footer: [0, 48, 192],
};

/** Frame index for a time in the take. */
export const frameAt = (t, fps = 30) => Math.round(t * fps);
