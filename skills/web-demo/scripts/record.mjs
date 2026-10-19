#!/usr/bin/env node
// web-demo: record a web product from a list of steps, and record it again when the product changes.
// No dependencies: Chrome or Edge over the DevTools pipe, ffmpeg for the MP4, Node 22 or later.
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export const VERSION = '0.1.0';
const SIZE = '1440x810';
const SCALE = 2;
const FPS = 30;
export const ACTIONS = ['click', 'hover', 'fill', 'type', 'press', 'select', 'scroll', 'scrollTo', 'wait', 'idle', 'until', 'goto', 'mark'];

const HELP = `web-demo ${VERSION}: record a web product from a list of steps, and record it again when it changes.

  node record.mjs <url> <take.mp4> --steps <steps.json | '[...]'>   record a take
  node record.mjs again <take.mp4> [--film film.html] [--dry-run]  record it again from its steps; the film keeps its edit
  node record.mjs inspect <url> [--steps <steps>]                  what is on the page, with a selector for each thing;
                                                                   with --steps, after doing them (a dialog, a menu)

Options for a take and for inspect:
  --size <w>x<h>    the window, in CSS px (${SIZE}; a phone: 390x844)
  --scale <n>       pixels per CSS px (${SCALE}): ${SIZE} at 2 is a 2880 x 1620 video
  --fps <n>         frames per second (${FPS})
  --dark            the page in its dark theme
  --hide <css>      hidden in every frame (a cookie banner, a chat bubble); give it again for more
  --pointer         the pointer drawn into the video too, so it follows the video's speed
  --browser <path>  Chrome or Edge; found by itself, or named by WEB_DEMO_BROWSER
  --ffmpeg <path>   ffmpeg; on the PATH, or named by WEB_DEMO_FFMPEG

Steps are a JSON list, one action each, run in order:
  {"click": "<sel>"}             the pointer travels there and clicks
  {"hover": "<sel>"}             the pointer travels there and rests
  {"fill": ["<sel>", "text"]}    clicks the field, empties it, types the text
  {"type": "text"}               types into what has focus, at a person's pace ("\\n" is Enter)
  {"press": "Enter"}             a key: Enter Tab Escape Backspace Delete ArrowUp ArrowDown ArrowLeft ArrowRight
                                 Home End PageUp PageDown Space or one character, with Control+ Shift+ Alt+ Meta+
  {"select": ["<sel>", "text"]}  picks the option of a <select> whose text or value contains the text
  {"scroll": 600}                scrolls the page down 600 px (negative: up); "in": "<sel>" scrolls that panel,
                                 "ms" sets how long it takes (900)
  {"scrollTo": "<sel>"}          scrolls until it sits a little above the middle
  {"wait": 800}                  800 ms of video with nothing done
  {"idle": 1500}                 1.5 s for the page to work, not recorded (a slow request)
  {"until": "<sel>"}             waits, not recorded, until it is on the page; or "() => js" until that is true (20 s)
  {"goto": "<url>"}              opens another address
  {"mark": "name"}               names this moment of the take
A selector is CSS, text="Exact words" or text=words (contained, any case); " >> nth=1" picks the second match.
A target outside the window is scrolled into view first. A link that opens a new tab: goto its address instead.
The page runs on a virtual clock that moves one frame at a time, so a slow machine gives the same smooth take.

Beside the video:
  <name>.record.json   what to record (url, steps, size, scale, fps, dark, hide: change them and run again) and
                       what happened ("take": when each step began, every pointer move, click and key)
  <name>.cursor.html   a page drawing the pointer and its clicks; on the track above the video, with the same at,
                       #t= and box, it follows the recording. A page plays at one speed: for a clip with a speed,
                       film the take with --pointer instead

again records from <name>.record.json and puts the new take in place of the old. In film.html each clip of the
take (the video and its cursor page) keeps its place and its length on the film; its #t= moves with the step or mark
it falls in. A clip whose step or mark is not in the new take, or that would run past the new end, is listed and left
as it was. film.html is the one in the current folder, or the nearest above the video; --dry-run only says what would
change.`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round3 = (x) => Math.round(x * 1000) / 1000;
const fmt = (x) => String(round3(x));
const shown = (p) => {
  const r = relative(process.cwd(), p);
  return r && !r.startsWith('..') ? r.replace(/\\/g, '/') : p;
};

// Seeded RNG for the pointer's bend and typing rhythm
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

// Virtual clock, run in the top frame before page scripts: rAF, timers, Date, performance.now, CSS/WAAPI animations
const VCLOCK = `(() => {
  if (window.top !== window || window.__vt) return;
  const RealDate = Date;
  const perfBase = performance.now();
  const dateBase = RealDate.now();
  let now = 0, rafId = 0, timerId = 0;
  let raf = new Map();
  const timers = new Map();
  const starts = new WeakMap();
  performance.now = () => perfBase + now;
  class VDate extends RealDate {
    constructor(...a) { if (a.length === 0) super(dateBase + now); else super(...a); }
    static now() { return dateBase + now; }
  }
  window.Date = VDate;
  window.requestAnimationFrame = (cb) => { raf.set(++rafId, cb); return rafId; };
  window.cancelAnimationFrame = (id) => raf.delete(id);
  const add = (fn, ms, args, every) => { timers.set(++timerId, { fn, at: now + Math.max(0, Number(ms) || 0), args, every }); return timerId; };
  window.setTimeout = (fn, ms, ...args) => add(fn, ms, args, 0);
  window.setInterval = (fn, ms, ...args) => add(fn, ms, args, Math.max(1, Number(ms) || 0));
  window.clearTimeout = window.clearInterval = (id) => timers.delete(id);
  if (window.requestIdleCallback) {
    window.requestIdleCallback = (fn) => add(() => fn({ didTimeout: false, timeRemaining: () => 10 }), 1, [], 0);
    window.cancelIdleCallback = (id) => timers.delete(id);
  }
  const css = document.createElement('style');
  css.textContent = '*{scroll-behavior:auto!important}';
  const inject = () => (document.head || document.documentElement).appendChild(css);
  if (document.documentElement) inject(); else document.addEventListener('DOMContentLoaded', inject);
  const runTimers = (target) => {
    for (;;) {
      let next = null;
      for (const [id, t] of timers) if (t.at <= target && (!next || t.at < next[1].at)) next = [id, t];
      if (!next) break;
      const [id, t] = next;
      now = Math.max(now, t.at);
      if (t.every) t.at += t.every; else timers.delete(id);
      try { typeof t.fn === 'function' ? t.fn(...t.args) : (0, eval)(t.fn); } catch (e) { console.error(e); }
    }
  };
  const syncAnimations = () => {
    if (!document.getAnimations) return;
    for (const a of document.getAnimations()) {
      if (a.timeline && a.timeline !== document.timeline) continue;
      if (!starts.has(a)) { starts.set(a, now - (a.currentTime || 0)); a.pause(); }
      try { a.currentTime = now - starts.get(a); } catch (e) {}
    }
  };
  const mediaStart = new WeakMap();
  const syncMedia = () => {
    for (const v of document.querySelectorAll('video')) {
      if (!v.loop || !v.autoplay) continue;
      if (!mediaStart.has(v)) mediaStart.set(v, now);
      if (!v.paused) v.pause();
      if (v.duration > 0) {
        const t = ((now - mediaStart.get(v)) / 1000) % v.duration;
        if (Math.abs(v.currentTime - t) > 0.001) v.currentTime = t;
      }
    }
  };
  window.__vt = {
    mediaReady() {
      const busy = [...document.querySelectorAll('video')].filter((v) => v.loop && v.autoplay && (v.seeking || v.readyState < 2));
      return Promise.all(busy.map((v) => new Promise((done) => {
        v.addEventListener('seeked', done, { once: true });
        v.addEventListener('loadeddata', done, { once: true });
        setTimeout(done, 1500);
      })));
    },
    get now() { return now; },
    advance(ms) {
      const target = now + ms;
      runTimers(target);
      now = target;
      const cbs = raf;
      raf = new Map();
      for (const cb of cbs.values()) { try { cb(perfBase + now); } catch (e) { console.error(e); } }
      syncAnimations();
      syncMedia();
      return now;
    },
  };
})();`;

// Page helpers: find by selector, measure, scroll, empty a field, pick an option, list what is on the page
const helpers = (hide) => `(() => {
  if (window.__wd) return;
  const HIDE = ${JSON.stringify(hide.join(', '))};
  if (HIDE) {
    const st = document.createElement('style');
    st.textContent = HIDE + '{display:none!important}';
    const put = () => (document.head || document.documentElement).appendChild(st);
    if (document.documentElement) put(); else document.addEventListener('DOMContentLoaded', put);
  }
  const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const visible = (e) => {
    const r = e.getBoundingClientRect();
    const st = getComputedStyle(e);
    return r.width > 1 && r.height > 1 && st.visibility !== 'hidden' && st.display !== 'none' && Number(st.opacity) > 0.02;
  };
  const all = (sel) => {
    const m = /^text=([\\s\\S]*)$/.exec(sel);
    if (!m) return [...document.querySelectorAll(sel)];
    let want = m[1].trim();
    let exact = false;
    if (/^"[\\s\\S]*"$/.test(want)) { try { want = JSON.parse(want); } catch { want = want.slice(1, -1); } exact = true; }
    want = norm(want);
    const low = want.toLowerCase();
    const hit = (e) => { const s = norm(e.innerText ?? e.textContent); return exact ? s === want : s.toLowerCase().includes(low); };
    const out = [];
    if (!document.body) return out;
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    for (let e = walk.nextNode(); e; e = walk.nextNode()) {
      if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(e.tagName)) continue;
      if (hit(e) && ![...e.children].some(hit)) out.push(e);
    }
    return out;
  };
  const find = (raw) => {
    let sel = raw;
    let nth = 0;
    const m = /\\s*>>\\s*nth=(\\d+)\\s*$/.exec(sel);
    if (m) { nth = Number(m[1]); sel = sel.slice(0, m.index); }
    const list = all(sel.trim());
    const vis = list.filter(visible);
    return (vis.length ? vis : list)[nth] || null;
  };
  const scroller = (e, self) => {
    for (let cur = self ? e : e && e.parentElement; cur && cur !== document.body && cur !== document.documentElement; cur = cur.parentElement) {
      const oy = getComputedStyle(cur).overflowY;
      if ((oy === 'auto' || oy === 'scroll' || oy === 'overlay') && cur.scrollHeight > cur.clientHeight + 1) return cur;
    }
    return null;
  };
  let shade = null;
  const draw = (x, y, pressed, ring) => {
    if (!shade || !shade.host.isConnected) {
      const host = document.createElement('web-demo-pointer');
      host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;display:block';
      shade = host.attachShadow({ mode: 'closed' });
      shade.innerHTML = '<svg width="100%" height="100%" style="position:absolute;inset:0;overflow:visible"><circle fill="none" stroke="#000" stroke-width="3"></circle><path d="M0 0 L0 23 L6 17.6 L10.4 27.4 L14.6 25.5 L10.2 15.9 L17.6 15.9 Z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"></path></svg>';
      document.documentElement.appendChild(host);
    }
    const [c, a] = [shade.querySelector('circle'), shade.querySelector('path')];
    a.setAttribute('transform', 'translate(' + x + ' ' + y + ') scale(' + (pressed ? 0.86 : 1) + ')');
    c.setAttribute('cx', x);
    c.setAttribute('cy', y);
    c.setAttribute('r', ring >= 0 && ring < 1 ? 6 + 26 * Math.sqrt(ring) : 0);
    c.setAttribute('stroke-opacity', ring >= 0 && ring < 1 ? 0.45 * (1 - ring) : 0);
  };
  window.__wd = {
    pointer: draw,
    find,
    box(sel) {
      const e = find(sel);
      if (!e) return null;
      const r = e.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height, shown: visible(e) };
    },
    scrollBy(target, within, dy) {
      const s = within ? scroller(find(within), true) : target ? scroller(find(target), false) : null;
      if (s) s.scrollTop += dy; else window.scrollBy(0, dy);
    },
    empty(sel) {
      const e = find(sel);
      if (!e) return false;
      if ('value' in e) {
        const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(e), 'value')?.set;
        set ? set.call(e, '') : (e.value = '');
        e.dispatchEvent(new Event('input', { bubbles: true }));
      } else if (e.isContentEditable) e.textContent = '';
      return true;
    },
    choose(sel, want) {
      const e = find(sel);
      if (!e || !e.options) return false;
      const w = norm(want).toLowerCase();
      const opts = [...e.options];
      const o = opts.find((x) => norm(x.textContent).toLowerCase() === w || x.value.toLowerCase() === w)
        || opts.find((x) => norm(x.textContent).toLowerCase().includes(w) || x.value.toLowerCase().includes(w));
      if (!o) return false;
      e.value = o.value;
      e.dispatchEvent(new Event('input', { bubbles: true }));
      e.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    },
    inventory() {
      const clean = (s) => norm(s);
      const q = (s) => s.replace(/\\\\/g, '\\\\\\\\').replace(/"/g, '\\\\"');
      const cssPath = (e) => {
        const parts = [];
        let cur = e;
        while (cur && cur !== document.body && parts.length < 5) {
          if (cur.id && /^[A-Za-z][\\w-]*$/.test(cur.id)) { parts.unshift('#' + cur.id); break; }
          const tag = cur.tagName.toLowerCase();
          const sib = cur.parentElement ? [...cur.parentElement.children].filter((x) => x.tagName === cur.tagName) : [];
          parts.unshift(sib.length > 1 ? tag + ':nth-of-type(' + (sib.indexOf(cur) + 1) + ')' : tag);
          cur = cur.parentElement;
        }
        return parts.join(' > ');
      };
      const els = [...document.querySelectorAll('a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=tab], [role=link], [role=menuitem], [role=checkbox], [role=switch], [contenteditable=true]')].filter(visible);
      const field = (e) => (e.tagName === 'SELECT' ? e.options[e.selectedIndex]?.text : /^(INPUT|TEXTAREA)$/.test(e.tagName) ? e.value || e.placeholder : '');
      const label = (e) => clean(e.getAttribute('aria-label') || field(e) || e.innerText || e.getAttribute('title') || e.querySelector('img')?.getAttribute('alt'));
      const rows = els.slice(0, 80).map((e) => {
        const tag = e.tagName.toLowerCase();
        const kind = e.getAttribute('role') || (tag === 'a' ? 'link' : tag === 'input' ? 'input[' + e.type + ']' : tag);
        const name = label(e).slice(0, 60);
        let sel;
        if (e.id && /^[A-Za-z][\\w-]*$/.test(e.id) && document.querySelectorAll('#' + e.id).length === 1) sel = '#' + e.id;
        else if (['input', 'textarea', 'select'].includes(tag) && e.getAttribute('name')) sel = tag + '[name="' + q(e.getAttribute('name')) + '"]';
        else if (['input', 'textarea'].includes(tag) && e.placeholder) sel = tag + '[placeholder="' + q(e.placeholder) + '"]';
        else if (name && name.length <= 60 && clean(e.innerText) === name) {
          const s = 'text="' + q(name) + '"';
          const n = all(s).filter(visible).indexOf([...all(s).filter(visible)].find((x) => e.contains(x)) || e);
          sel = n > 0 ? s + ' >> nth=' + n : s;
        } else sel = cssPath(e);
        const r = e.getBoundingClientRect();
        return { sel, kind, name, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2 + window.scrollY) };
      });
      const heads = [...document.querySelectorAll('h1, h2, h3')].filter(visible).slice(0, 20).map((h) => h.tagName.toLowerCase() + ' "' + clean(h.innerText).slice(0, 70) + '"');
      return { title: document.title, url: location.href, height: document.documentElement.scrollHeight, heads, rows, more: Math.max(0, els.length - 80) };
    },
  };
})();`;

// ---------------------------------------------------------------- browser over the DevTools pipe

export function findBrowser(given) {
  const named = given || process.env.WEB_DEMO_BROWSER;
  if (named) {
    if (existsSync(named)) return named;
    throw new Error(`no browser at ${named}`);
  }
  const pf = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA].filter(Boolean);
  const list =
    process.platform === 'win32'
      ? [...pf.map((d) => join(d, 'Google', 'Chrome', 'Application', 'chrome.exe')), ...pf.map((d) => join(d, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))]
      : process.platform === 'darwin'
        ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Chromium.app/Contents/MacOS/Chromium']
        : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge', '/snap/bin/chromium'];
  const hit = list.find((f) => existsSync(f));
  if (!hit) throw new Error('No Chrome or Edge found: install Google Chrome, or name one with --browser');
  return hit;
}

export class Browser {
  constructor(proc, profile) {
    this.proc = proc;
    this.profile = profile;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
    this.chunks = [];
    this.err = '';
    this.closed = false;
    proc.stdio[4].on('data', (d) => this.onData(d));
    proc.stdio[3].on('error', () => undefined);
    proc.stdio[4].on('error', () => undefined);
    proc.stderr.on('data', (d) => (this.err = (this.err + d).slice(-4000)));
    proc.on('exit', () => this.fail(new Error(`the browser closed${this.lastError()}`)));
    proc.on('error', (e) => this.fail(new Error(`could not start the browser: ${e.message}`)));
  }

  lastError() {
    const line = this.err.trim().split(/\r?\n/).filter((l) => !/DevTools|^\s*$/.test(l)).pop();
    return line ? `: ${line}` : '';
  }

  fail(e) {
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(e);
    }
    this.pending.clear();
  }

  static async launch(exe) {
    const profile = mkdtempSync(join(tmpdir(), 'web-demo-'));
    const args = [
      '--remote-debugging-pipe', `--user-data-dir=${profile}`, '--headless=new', '--no-first-run', '--no-default-browser-check',
      '--disable-extensions', '--disable-sync', '--disable-background-networking', '--disable-component-update',
      '--disable-default-apps', '--disable-renderer-backgrounding', '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows', '--disable-features=Translate,MediaRouter,OptimizationHints',
      '--hide-scrollbars', '--mute-audio', '--force-color-profile=srgb', '--password-store=basic', '--use-mock-keychain',
      '--disable-crash-reporter', '--disable-breakpad',
      ...(process.env.WEB_DEMO_CHROME_ARGS ? process.env.WEB_DEMO_CHROME_ARGS.split(' ') : []),
      'about:blank',
    ];
    const proc = spawn(exe, args, { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'], windowsHide: true });
    const b = new Browser(proc, profile);
    const v = await b.send('Browser.getVersion', {}, undefined, 30000);
    b.userAgent = v.userAgent.replace(/HeadlessChrome/g, 'Chrome');
    return b;
  }

  onData(chunk) {
    this.chunks.push(chunk);
    if (!chunk.includes(0)) return;
    let buf = Buffer.concat(this.chunks);
    this.chunks = [];
    for (let i = buf.indexOf(0); i >= 0; i = buf.indexOf(0)) {
      const msg = JSON.parse(buf.subarray(0, i).toString('utf8'));
      buf = buf.subarray(i + 1);
      this.dispatch(msg);
    }
    if (buf.length) this.chunks.push(buf);
  }

  dispatch(msg) {
    if (msg.id) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}${msg.error.data ? ` (${msg.error.data})` : ''}`));
      else p.resolve(msg.result);
      return;
    }
    for (const fn of this.listeners.get(`${msg.sessionId ?? ''}|${msg.method}`) ?? []) fn(msg.params);
  }

  send(method, params = {}, sessionId, timeout = 30000) {
    if (this.closed) return Promise.reject(new Error(`the browser closed${this.lastError()}`));
    const id = ++this.id;
    return new Promise((res, rej) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rej(new Error(`${method}: no answer in ${timeout / 1000} s`));
      }, timeout);
      this.pending.set(id, { resolve: res, reject: rej, timer, method });
      this.proc.stdio[3].write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
    });
  }

  on(sessionId, method, fn) {
    const key = `${sessionId ?? ''}|${method}`;
    if (!this.listeners.has(key)) this.listeners.set(key, new Set());
    this.listeners.get(key).add(fn);
  }

  async close() {
    const alive = () => this.proc.exitCode === null && this.proc.signalCode === null;
    const exited = new Promise((r) => (alive() ? this.proc.once('exit', r) : r()));
    if (!this.closed) await this.send('Browser.close', {}, undefined, 10000).catch(() => undefined);
    // Chrome answers Browser.close a moment before it exits
    await Promise.race([exited, sleep(5000)]);
    if (alive()) {
      // Its helpers go with it; taskkill can take a minute on a busy Windows, so it is not waited for
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(this.proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).unref();
      await Promise.race([exited, sleep(3000)]);
      if (alive()) this.proc.kill('SIGKILL');
      await Promise.race([exited, sleep(3000)]);
    }
    // A helper process Chrome left behind can hold these pipes open and keep this process from ever exiting
    for (const s of [this.proc.stdio[3], this.proc.stdio[4], this.proc.stderr]) s?.destroy();
    // Windows keeps the profile locked for a moment after exit
    for (let i = 0; i < 20; i++) {
      try {
        rmSync(this.profile, { recursive: true, force: true });
        break;
      } catch {
        await sleep(250);
      }
    }
  }
}

class Page {
  constructor(browser, sessionId) {
    this.browser = browser;
    this.sessionId = sessionId;
  }

  send(method, params, timeout) {
    return this.browser.send(method, params, this.sessionId, timeout);
  }

  // Runtime.evaluate that waits out a navigation (a link click, Enter in a search box)
  async evaluate(expression) {
    for (let i = 0; ; i++) {
      try {
        const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
        if (r.exceptionDetails) {
          const e = new Error(r.exceptionDetails.exception?.description?.split('\n')[0] || r.exceptionDetails.text);
          e.fromPage = true;
          throw e;
        }
        return r.result.value;
      } catch (e) {
        if (e.fromPage || i >= 60 || !/context|navigat|detached|not found/i.test(e.message)) throw e;
        await sleep(50);
      }
    }
  }
}

export async function openPage(b, o) {
  const { targetId } = await b.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await b.send('Target.attachToTarget', { targetId, flatten: true });
  const page = new Page(b, sessionId);
  b.on(sessionId, 'Page.javascriptDialogOpening', () => page.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => undefined));
  await page.send('Page.enable');
  await page.send('Emulation.setDeviceMetricsOverride', { width: o.width, height: o.height, deviceScaleFactor: o.scale, mobile: false });
  await page.send('Emulation.setUserAgentOverride', { userAgent: b.userAgent });
  await page.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: o.dark ? 'dark' : 'light' }] });
  if (o.clock) await page.send('Page.addScriptToEvaluateOnNewDocument', { source: VCLOCK });
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: helpers(o.hide ?? []) });
  return page;
}

// ---------------------------------------------------------------- keys

const KEYS = {
  Enter: [13, 'Enter', '\r'], Tab: [9, 'Tab'], Escape: [27, 'Escape'], Backspace: [8, 'Backspace'], Delete: [46, 'Delete'],
  ArrowUp: [38, 'ArrowUp'], ArrowDown: [40, 'ArrowDown'], ArrowLeft: [37, 'ArrowLeft'], ArrowRight: [39, 'ArrowRight'],
  Home: [36, 'Home'], End: [35, 'End'], PageUp: [33, 'PageUp'], PageDown: [34, 'PageDown'], Space: [32, 'Space', ' '],
};
const MODS = { alt: 1, control: 2, ctrl: 2, meta: 4, cmd: 4, command: 4, shift: 8 };

export function keyOf(spec) {
  const parts = spec.length > 1 ? spec.split('+') : [spec];
  const name = parts.pop() || '+';
  let modifiers = 0;
  for (const m of parts) {
    const bit = MODS[m.toLowerCase()];
    if (!bit) throw new Error(`unknown modifier "${m}" in "${spec}"`);
    modifiers |= bit;
  }
  const typing = !(modifiers & 7);
  const known = KEYS[Object.keys(KEYS).find((k) => k.toLowerCase() === name.toLowerCase()) ?? ''];
  if (known) return { key: known[0] === 32 ? ' ' : known[1], code: known[1], vk: known[0], text: typing ? known[2] : undefined, modifiers };
  if ([...name].length === 1) {
    const ch = modifiers & 8 ? name.toUpperCase() : name;
    const up = name.toUpperCase();
    const code = /^[a-z]$/i.test(name) ? `Key${up}` : /^\d$/.test(name) ? `Digit${name}` : undefined;
    return { key: ch, code, vk: up.charCodeAt(0), text: typing ? ch : undefined, modifiers };
  }
  throw new Error(`unknown key "${spec}"`);
}

// ---------------------------------------------------------------- steps

export function parseSteps(json) {
  if (!Array.isArray(json)) throw new Error('steps are a JSON list, e.g. [{"click": "text=\\"Sign up\\""}, {"type": "hello"}]');
  return json.map((s, i) => {
    const keys = s && typeof s === 'object' && !Array.isArray(s) ? Object.keys(s).filter((k) => ACTIONS.includes(k)) : [];
    if (keys.length !== 1) throw new Error(`step ${i + 1} needs exactly one of ${ACTIONS.join(', ')}: ${JSON.stringify(s)}`);
    const k = keys[0];
    const v = s[k];
    const extra = Object.keys(s).filter((x) => x !== k && !(k === 'scroll' && (x === 'in' || x === 'ms')));
    if (extra.length) throw new Error(`step ${i + 1}: "${extra[0]}" does not go with "${k}": ${JSON.stringify(s)}`);
    const str = typeof v === 'string' && v.length > 0;
    const num = typeof v === 'number' && Number.isFinite(v);
    const pair = Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === 'string') && v[0].length > 0;
    const ok = ['wait', 'idle', 'scroll'].includes(k) ? num && (k === 'scroll' || v >= 0) : ['fill', 'select'].includes(k) ? pair : k === 'type' ? typeof v === 'string' : str;
    if (!ok) throw new Error(`step ${i + 1}: "${k}" takes ${['wait', 'idle', 'scroll'].includes(k) ? 'a number of ms or px' : ['fill', 'select'].includes(k) ? '["<selector>", "text"]' : 'text'}, not ${JSON.stringify(v)}`);
    if (k === 'press') keyOf(v);
    if (k === 'scroll' && s.ms !== undefined && !(Number.isFinite(s.ms) && s.ms > 0)) throw new Error(`step ${i + 1}: "ms" is a number of ms`);
    return s;
  });
}

const isCode = (s) => /=>|^\s*(async\s+)?function\b/.test(s);

// ---------------------------------------------------------------- the encoder

function openEncoder(ffmpeg, out, fps, width, height) {
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'png', '-i', '-',
    '-vf', `scale=${width}:${height}:flags=lanczos`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-pix_fmt', 'yuv420p',
    '-g', String(fps), '-r', String(fps), '-movflags', '+faststart', out];
  const proc = spawn(ffmpeg, args, { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
  let err = '';
  let dead = null;
  let broken = false;
  proc.stderr.on('data', (d) => (err = (err + d).slice(-2000)));
  proc.on('error', (e) => (dead = new Error(e.code === 'ENOENT' ? `ffmpeg was not found (${ffmpeg}): install it, OpenFilm needs it too, or name it with --ffmpeg` : `ffmpeg: ${e.message}`)));
  // A write into an encoder that quit fails first; what it said on the way out is the error worth reporting
  proc.stdin.on('error', () => (broken = true));
  const done = new Promise((res) => proc.on('close', (code) => {
    if (code !== 0) dead ??= new Error(`ffmpeg stopped (${code}): ${err.trim()}`);
    res();
  }));
  const failed = async () => {
    await done;
    return dead ?? new Error(`ffmpeg stopped: ${err.trim()}`);
  };
  return {
    async write(buf) {
      if (dead || broken) throw await failed();
      if (!proc.stdin.write(buf)) await Promise.race([new Promise((r) => proc.stdin.once('drain', r)), done]);
      if (dead || broken) throw await failed();
    },
    async end() {
      proc.stdin.end();
      await done;
      if (dead) throw dead;
    },
    // Stopped and gone, so its file can be removed: SIGTERM leaves an ffmpeg that is waiting on its input running
    async stop() {
      proc.kill('SIGKILL');
      await done;
    },
  };
}

// ---------------------------------------------------------------- a take

class Take {
  constructor(page, o) {
    this.page = page;
    this.o = o;
    this.fps = o.fps;
    this.dt = 1000 / o.fps;
    this.frame = 0;
    this.events = [];
    this.mouse = { x: o.width / 2, y: o.height / 2 };
    this.pressed = false;
    this.downAt = -Infinity;
    this.rand = rng(7);
    this.recording = false;
    this.enc = null;
  }

  get t() {
    return round3(this.frame / this.fps);
  }

  log(type, extra = {}) {
    this.events.push({ t: this.t, type, ...extra });
  }

  at() {
    return { x: Math.round(this.mouse.x * 10) / 10, y: Math.round(this.mouse.y * 10) / 10 };
  }

  tick(ms) {
    return this.page.evaluate(`window.__vt ? window.__vt.advance(${ms}) : 0`);
  }

  async snap() {
    const draw = this.o.pointer && this.recording
      ? `window.__wd && window.__wd.pointer(${this.mouse.x}, ${this.mouse.y}, ${this.pressed}, ${(this.frame / this.fps - this.downAt) / 0.5});`
      : '';
    await this.page.evaluate(`(async () => { if (!window.__vt) return; window.__vt.advance(${this.dt}); await window.__vt.mediaReady(); ${draw} })()`);
    if (!this.recording) return;
    const { data } = await this.page.send('Page.captureScreenshot', { format: 'png', optimizeForSpeed: true, captureBeyondViewport: false }, 60000);
    await this.enc.write(Buffer.from(data, 'base64'));
    this.frame++;
    if (this.frame % (this.fps * 5) === 0) this.o.log(`  ${this.frame / this.fps} s recorded`);
  }

  async wait(ms) {
    const n = Math.round(ms / this.dt);
    for (let i = 0; i < n; i++) await this.snap();
  }

  // The page works in real time for a while, its clock moving by the same amount, with no frames
  async idle(ms) {
    const n = Math.round(ms / this.dt);
    for (let i = 0; i < n; i++) {
      await this.tick(this.dt);
      await sleep(this.dt);
    }
  }

  check(pred) {
    return isCode(pred)
      ? this.page.evaluate(`!!(${pred})()`).catch(() => false)
      : this.page.evaluate(`!!(window.__wd && window.__wd.find(${JSON.stringify(pred)}))`).catch(() => false);
  }

  async until(pred, timeout = 20000) {
    const end = Date.now() + timeout;
    while (!(await this.check(pred))) {
      if (Date.now() > end) throw new Error(`${isCode(pred) ? pred : `nothing matches ${pred}`} after ${timeout / 1000} s`);
      await this.tick(this.dt);
      await sleep(50);
    }
  }

  box(sel) {
    return this.page.evaluate(`window.__wd ? window.__wd.box(${JSON.stringify(sel)}) : null`);
  }

  // A target in view, scrolled to with a visible scroll when it is not
  async reach(sel) {
    await this.until(sel, 15000).catch(() => {
      throw new Error(`nothing matches ${sel} after 15 s (inspect lists what is on the page)`);
    });
    let b = await this.box(sel);
    const vh = this.o.height;
    if (b && (b.y < 40 || b.y + b.height > vh - 40)) {
      await this.scroll(Math.round(b.y + b.height / 2 - vh * 0.4), { ms: 800, target: sel });
      b = await this.box(sel);
    }
    if (!b || !b.shown) throw new Error(`${sel} is on the page but not shown`);
    return b;
  }

  async scroll(dy, { ms = 900, target = null, within = null } = {}) {
    const n = Math.max(1, Math.round(ms / this.dt));
    let done = 0;
    this.log('scroll', { y: dy });
    for (let i = 1; i <= n; i++) {
      const want = Math.round(dy * ease(i / n));
      const step = want - done;
      done = want;
      await this.page.evaluate(`window.__wd && window.__wd.scrollBy(${JSON.stringify(target)}, ${JSON.stringify(within)}, ${step})`);
      await this.snap();
    }
  }

  async mouseEvent(type) {
    const { x, y } = this.mouse;
    const button = type === 'mouseMoved' && !this.pressed ? 'none' : 'left';
    await this.page.send('Input.dispatchMouseEvent', { type, x, y, button, buttons: this.pressed ? 1 : 0, clickCount: type === 'mouseMoved' ? 0 : 1 });
  }

  async move(p, ms) {
    const from = { ...this.mouse };
    const dist = Math.hypot(p.x - from.x, p.y - from.y);
    const dur = ms ?? Math.min(1100, Math.max(420, 300 + dist * 0.6));
    const n = Math.max(1, Math.round(dur / this.dt));
    const bend = (this.rand() - 0.5) * 0.25 * dist;
    const nx = -(p.y - from.y) / (dist || 1);
    const ny = (p.x - from.x) / (dist || 1);
    for (let i = 1; i <= n; i++) {
      const k = ease(i / n);
      const arc = Math.sin(k * Math.PI) * bend;
      this.mouse = { x: from.x + (p.x - from.x) * k + nx * arc, y: from.y + (p.y - from.y) * k + ny * arc };
      await this.mouseEvent('mouseMoved');
      this.log('move', this.at());
      await this.snap();
    }
  }

  async click(sel, after = 250) {
    const b = await this.reach(sel);
    await this.move({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
    await this.wait(120);
    this.pressed = true;
    this.downAt = this.frame / this.fps;
    this.log('down', this.at());
    await this.mouseEvent('mousePressed');
    await this.wait(90);
    this.pressed = false;
    await this.mouseEvent('mouseReleased');
    this.log('up', this.at());
    await this.wait(after);
  }

  async key(spec) {
    const k = keyOf(spec);
    const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk, modifiers: k.modifiers };
    await this.page.send('Input.dispatchKeyEvent', { type: k.text ? 'keyDown' : 'rawKeyDown', ...base, ...(k.text ? { text: k.text, unmodifiedText: k.text } : {}) });
    await this.page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    this.log('key', { key: spec });
  }

  async type(text) {
    for (const ch of text) {
      if (ch === '\n') await this.key('Enter');
      else if (/^[\x20-\x7e]$/.test(ch)) await this.key(ch);
      else {
        await this.page.send('Input.insertText', { text: ch });
        this.log('key', { key: ch });
      }
      await this.wait((1000 / 11) * (0.6 + this.rand() * 0.8));
    }
    await this.wait(300);
  }

  async goto(url) {
    const r = await this.page.send('Page.navigate', { url }, 60000);
    if (r.errorText) throw new Error(`could not open ${url}: ${r.errorText}`);
    await this.until('() => document.readyState === "complete"', 30000).catch(() => undefined);
  }

  async start() {
    this.enc = openEncoder(this.o.ffmpeg, this.o.out, this.fps, this.o.videoWidth, this.o.videoHeight);
    this.recording = true;
    this.log('move', this.at());
  }

  async run(step) {
    const k = Object.keys(step).find((x) => ACTIONS.includes(x));
    const v = step[k];
    if (k === 'click') await this.click(v);
    else if (k === 'hover') {
      const b = await this.reach(v);
      await this.move({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
      await this.wait(400);
    } else if (k === 'fill') {
      await this.click(v[0], 150);
      await this.page.evaluate(`window.__wd.empty(${JSON.stringify(v[0])})`);
      await this.type(v[1]);
    } else if (k === 'type') await this.type(v);
    else if (k === 'press') {
      await this.key(v);
      await this.wait(300);
    } else if (k === 'select') {
      await this.click(v[0], 350);
      const ok = await this.page.evaluate(`window.__wd.choose(${JSON.stringify(v[0])}, ${JSON.stringify(v[1])})`);
      if (!ok) throw new Error(`${v[0]} has no option with "${v[1]}"`);
      await this.key('Escape');
      await this.wait(600);
    } else if (k === 'scroll') await this.scroll(v, { ms: step.ms ?? 900, within: step.in ?? null });
    else if (k === 'scrollTo') {
      await this.reach(v);
      await this.wait(300);
    } else if (k === 'wait') await this.wait(v);
    else if (k === 'idle') await this.idle(v);
    else if (k === 'until') await this.until(v);
    else if (k === 'goto') {
      await this.goto(v);
      await this.wait(600);
    } else if (k === 'mark') this.log('mark', { name: v });
  }
}

// ---------------------------------------------------------------- files

export const recordFileFor = (video) => join(dirname(video), `${basename(video, extname(video))}.record.json`);
export const cursorFileFor = (video) => join(dirname(video), `${basename(video, extname(video))}.cursor.html`);

function parseSize(s) {
  const m = /^(\d{2,5})x(\d{2,5})$/.exec(String(s));
  if (!m) throw new Error(`--size is width x height in CSS px, such as ${SIZE}, not ${s}`);
  return { width: Number(m[1]), height: Number(m[2]) };
}

function moveFile(from, to) {
  try {
    renameSync(from, to);
  } catch (e) {
    if (e.code !== 'EXDEV' && e.code !== 'EPERM') throw e;
    copyFileSync(from, to);
    unlinkSync(from);
  }
}

/**
 * Record one take into `out` (an .mp4), with its .record.json and .cursor.html beside it.
 * @returns {Promise<object>} the record written
 */
export async function recordTake(o) {
  const log = o.log ?? ((s) => process.stderr.write(`${s}\n`));
  const size = parseSize(o.size ?? SIZE);
  const scale = Number(o.scale ?? SCALE);
  const fps = Number(o.fps ?? FPS);
  if (!(scale >= 0.5 && scale <= 4)) throw new Error(`--scale is 0.5 to 4, not ${o.scale}`);
  if (!(Number.isInteger(fps) && fps >= 10 && fps <= 60)) throw new Error(`--fps is a whole number from 10 to 60, not ${o.fps}`);
  if (!/^(https?|file):\/\//i.test(o.url)) throw new Error(`${o.url} is not a web address: give it whole, with https://`);
  const steps = parseSteps(o.steps ?? []);
  const out = resolve(o.out);
  if (extname(out).toLowerCase() !== '.mp4') throw new Error(`${o.out}: the take is an .mp4`);
  const hide = o.hide ?? [];
  const videoWidth = Math.round((size.width * scale) / 2) * 2;
  const videoHeight = Math.round((size.height * scale) / 2) * 2;
  const ffmpeg = o.ffmpeg || process.env.WEB_DEMO_FFMPEG || 'ffmpeg';
  const exe = findBrowser(o.browser);

  // Into a folder of its own first, so a take that fails leaves the one before it as it was
  mkdirSync(dirname(out), { recursive: true });
  const work = mkdtempSync(join(tmpdir(), 'web-demo-take-'));
  const tmpOut = join(work, basename(out));
  const b = await Browser.launch(exe);
  let take;
  const times = [];
  try {
    const page = await openPage(b, { ...size, scale, dark: !!o.dark, hide, clock: true });
    take = new Take(page, { ...size, scale, fps, ffmpeg, out: tmpOut, videoWidth, videoHeight, log, pointer: !!o.pointer });
    log(`opening ${o.url}`);
    await take.goto(o.url);
    await take.idle(1200);
    await take.start();
    for (const [i, step] of steps.entries()) {
      times.push({ t: take.t, step });
      log(`  ${i + 1}. ${JSON.stringify(step)}`);
      try {
        await take.run(step);
      } catch (e) {
        throw new Error(`step ${i + 1} ${JSON.stringify(step)}: ${e.message}`);
      }
    }
    await take.wait(500);
    await take.enc.end();
  } catch (e) {
    await take?.enc?.stop();
    await b.close();
    try {
      rmSync(work, { recursive: true, force: true, maxRetries: 5 });
    } catch {
      // A folder left in the temp folder is no reason to hide what went wrong
    }
    throw e;
  }
  await b.close();

  const name = basename(out, extname(out));
  const record = {
    url: o.url,
    steps,
    size: `${size.width}x${size.height}`,
    scale,
    fps,
    dark: !!o.dark,
    hide,
    pointer: !!o.pointer,
    take: {
      by: `web-demo ${VERSION}`,
      recorded: new Date().toISOString(),
      video: basename(out),
      width: videoWidth,
      height: videoHeight,
      duration: take.t,
      steps: times,
      events: take.events,
    },
  };
  writeFileSync(join(work, `${name}.record.json`), `${JSON.stringify(record, null, 1)}\n`);
  writeFileSync(join(work, `${name}.cursor.html`), cursorPage(record));
  if (o.keepIn) return { record, work, files: [basename(out), `${name}.record.json`, `${name}.cursor.html`] };
  for (const f of [basename(out), `${name}.record.json`, `${name}.cursor.html`]) moveFile(join(work, f), join(dirname(out), f));
  rmSync(work, { recursive: true, force: true });
  return { record };
}

// ---------------------------------------------------------------- the pointer page

export function cursorPage(record) {
  const take = record.take;
  const [w, h] = record.size.split('x').map(Number);
  const moves = take.events.filter((e) => e.type === 'move').map((e) => [e.t, e.x, e.y]);
  const downs = take.events.filter((e) => e.type === 'down').map((e) => e.t);
  const ups = take.events.filter((e) => e.type === 'up').map((e) => e.t);
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Pointer for ${take.video}</title>
<!-- Made by web-demo with ${take.video}: the pointer and its clicks, in the take's own seconds. Lay it over the video
     with the same at, #t= and box. "again" writes it anew with each take. -->
<style>
  html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: transparent; }
  svg { display: block; width: 100%; height: 100%; }
</style>
</head>
<body>
<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
  <circle id="ring" r="0" fill="none" stroke="#000" stroke-opacity="0" stroke-width="3"></circle>
  <g id="pointer">
    <path d="M0 0 L0 23 L6 17.6 L10.4 27.4 L14.6 25.5 L10.2 15.9 L17.6 15.9 Z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"></path>
  </g>
</svg>
<script type="module">
// Size of the pointer, 1 = a desktop pointer at the take's scale
const SIZE = 1;
const MOVES = ${JSON.stringify(moves)};
const DOWNS = ${JSON.stringify(downs)};
const UPS = ${JSON.stringify(ups)};
const pointer = document.getElementById('pointer');
const ring = document.getElementById('ring');
const last = (list, t, at = (x) => x) => {
  let lo = 0, hi = list.length - 1, hit = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (at(list[mid]) <= t + 1e-6) { hit = mid; lo = mid + 1; } else hi = mid - 1; }
  return hit;
};
function frame(t) {
  const m = MOVES[Math.max(0, last(MOVES, t, (e) => e[0]))] ?? [0, ${w / 2}, ${h / 2}];
  const d = last(DOWNS, t), u = last(UPS, t);
  const pressed = d >= 0 && (u < 0 || UPS[u] < DOWNS[d]);
  pointer.setAttribute('transform', \`translate(\${m[1]} \${m[2]}) scale(\${SIZE * (pressed ? 0.86 : 1)})\`);
  const since = d >= 0 ? t - DOWNS[d] : Infinity;
  const k = since / 0.5;
  if (k >= 0 && k < 1) {
    ring.setAttribute('cx', m[1]);
    ring.setAttribute('cy', m[2]);
    ring.setAttribute('r', String(6 + 26 * SIZE * Math.sqrt(k)));
    ring.setAttribute('stroke-opacity', String(0.45 * (1 - k)));
  } else ring.setAttribute('stroke-opacity', '0');
}
window.film = { frame, duration: ${take.duration}, width: ${w}, height: ${h} };
if (!window.filmHost) {
  const t0 = performance.now();
  const loop = () => { film.frame(((performance.now() - t0) / 1000) % film.duration); requestAnimationFrame(loop); };
  loop();
}
</script>
</body>
</html>
`;
}

// ---------------------------------------------------------------- keeping the film's edit

/** Moments a clip can be held to: the start, each step (by what it is and which time it came), each mark. */
export function anchors(take) {
  const seen = new Map();
  const out = [{ key: 'start', t: 0, label: 'the start' }];
  take.steps.forEach(({ t, step }, i) => {
    const j = typeof step.mark === 'string' ? `mark:${step.mark}` : `step:${JSON.stringify(step)}`;
    const n = seen.get(j) ?? 0;
    seen.set(j, n + 1);
    const label = typeof step.mark === 'string' ? `mark "${step.mark}"` : `step ${i + 1} ${JSON.stringify(step)}`;
    out.push({ key: `${j}#${n}`, t, label });
  });
  return out;
}

/** The clips of film.html: tag, where each attribute's value sits. Comments are skipped. */
export function scanClips(html) {
  const comments = [...html.matchAll(/<!--[\s\S]*?-->/g)].map((m) => [m.index, m.index + m[0].length]);
  const out = [];
  const re = /<(iframe|video|img|audio)\b/gi;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    if (comments.some(([a, b]) => m.index >= a && m.index < b)) continue;
    let i = m.index + m[0].length;
    const attrs = [];
    while (i < html.length) {
      while (i < html.length && /\s/.test(html[i])) i++;
      if (html[i] === '>') { i++; break; }
      if (html[i] === '/' && html[i + 1] === '>') { i += 2; break; }
      const start = i;
      while (i < html.length && !/[\s=>/]/.test(html[i])) i++;
      const name = html.slice(start, i).toLowerCase();
      if (!name) { i++; continue; }
      while (i < html.length && /\s/.test(html[i])) i++;
      let value = null;
      let vStart = -1;
      let vEnd = -1;
      if (html[i] === '=') {
        i++;
        while (i < html.length && /\s/.test(html[i])) i++;
        const q = html[i];
        if (q === '"' || q === "'") {
          vStart = i + 1;
          vEnd = html.indexOf(q, vStart);
          if (vEnd < 0) vEnd = html.length;
          i = vEnd + 1;
        } else {
          vStart = i;
          while (i < html.length && !/[\s>]/.test(html[i])) i++;
          vEnd = i;
        }
        value = html.slice(vStart, vEnd);
      }
      attrs.push({ name, value, vStart, vEnd });
    }
    re.lastIndex = i;
    out.push({ tag: m[1].toLowerCase(), at: m.index, attrs });
  }
  return out;
}

const samePath = (p) => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p));

/**
 * film.html with each clip of the take (the video, its cursor page) moved to the new take: its #t= follows the step
 * or mark it falls in, and keeps its length. Clips that cannot follow are listed and left as they were.
 */
export function remapFilm(text, { filmDir, files, before, after }) {
  const targets = new Set(files.map(samePath));
  const oldA = anchors(before);
  const newA = new Map(anchors(after).map((a) => [a.key, a]));
  const edits = [];
  const changes = [];
  const problems = [];
  const kept = [];
  for (const clip of scanClips(text)) {
    const src = clip.attrs.find((a) => a.name === 'src');
    if (!src || src.value == null) continue;
    const hash = src.value.indexOf('#');
    const path = hash < 0 ? src.value : src.value.slice(0, hash);
    const frag = hash < 0 ? '' : src.value.slice(hash + 1);
    let abs;
    try {
      abs = samePath(join(filmDir, decodeURIComponent(path.replace(/&amp;/g, '&'))));
    } catch {
      continue;
    }
    if (!targets.has(abs)) continue;
    const id = clip.attrs.find((a) => a.name === 'id')?.value || path;
    const f = /^t=(?:npt:)?(\d*\.?\d*)(?:,(\d*\.?\d+))?$/.exec(frag);
    if (frag && (!f || (f[1] === '' && f[2] === undefined))) {
      problems.push({ id, why: `its #${frag} is not #t=in,out, so it was left as it was` });
      continue;
    }
    const tin = f && f[1] !== '' ? Number(f[1]) : 0;
    const tout = f && f[2] !== undefined ? Number(f[2]) : before.duration;
    const sameT = oldA.filter((a) => a.t <= tin + 1e-6);
    const tmax = Math.max(...sameT.map((a) => a.t));
    const held = sameT.filter((a) => a.t === tmax).reverse();
    const pick = held.find((a) => newA.has(a.key));
    if (!pick) {
      problems.push({ id, why: `it falls in ${held[0].label}, which the new take does not have; left as it was` });
      continue;
    }
    const nin = round3(newA.get(pick.key).t + (tin - pick.t));
    const nout = round3(nin + (tout - tin));
    if (nout > after.duration + 0.0005) {
      problems.push({ id, why: `it would run to ${fmt(nout)} s, past the new take's end at ${fmt(after.duration)} s; left as it was` });
      continue;
    }
    const value = `${path}#t=${fmt(nin)},${fmt(nout)}`;
    if (value !== src.value) {
      edits.push({ start: src.vStart, end: src.vEnd, value });
      changes.push({ id, from: frag ? `#${frag}` : '(all of it)', to: `#t=${fmt(nin)},${fmt(nout)}`, by: pick.label });
    } else kept.push(id);
  }
  let out = text;
  for (const e of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.value + out.slice(e.end);
  return { text: out, changes, problems, kept };
}

/** How each step and mark moved between two takes. */
export function shifts(before, after) {
  const now = new Map(anchors(after).map((a) => [a.key, a]));
  return anchors(before)
    .filter((a) => a.key !== 'start')
    .map((a) => ({ label: a.label, from: a.t, to: now.get(a.key)?.t }))
    .filter((s) => s.to === undefined || Math.abs(s.to - s.from) > 0.0005);
}

function findFilm(videoDir) {
  if (existsSync(join(process.cwd(), 'film.html'))) return join(process.cwd(), 'film.html');
  for (let d = videoDir, i = 0; i < 6; i++) {
    if (existsSync(join(d, 'film.html'))) return join(d, 'film.html');
    const up = dirname(d);
    if (up === d) break;
    d = up;
  }
  return null;
}

export async function again(videoArg, o = {}) {
  const log = o.log ?? ((s) => process.stderr.write(`${s}\n`));
  const video = resolve(videoArg);
  const recFile = recordFileFor(video);
  if (!existsSync(recFile)) throw new Error(`${shown(recFile)} is not there: only a take made by record.mjs can be made again`);
  const before = JSON.parse(readFileSync(recFile, 'utf8'));
  const film = o.film ? resolve(o.film) : findFilm(dirname(video));
  if (o.film && !existsSync(film)) throw new Error(`no film at ${o.film}`);
  const made = await recordTake({ ...before, out: video, browser: o.browser, ffmpeg: o.ffmpeg, log, keepIn: true });
  const after = made.record.take;
  const lines = [];
  try {
    const moved = shifts(before.take, after);
    lines.push(`${shown(video)}: ${fmt(before.take.duration)} s before, ${fmt(after.duration)} s now`);
    for (const s of moved) lines.push(s.to === undefined ? `  ${s.label}: not in the new take` : `  ${s.label}: ${fmt(s.from)} s -> ${fmt(s.to)} s`);
    let plan = null;
    if (film) {
      plan = remapFilm(readFileSync(film, 'utf8'), { filmDir: dirname(film), files: [video, cursorFileFor(video)], before: before.take, after });
      for (const c of plan.changes) lines.push(`  clip ${c.id}: ${c.from} -> ${c.to} (with ${c.by})`);
      for (const p of plan.problems) lines.push(`  LISTED clip ${p.id}: ${p.why}`);
      if (plan.kept.length) lines.push(`  ${plan.kept.length} clip${plan.kept.length > 1 ? 's' : ''} of this take already in place: ${plan.kept.join(', ')}`);
      if (!plan.changes.length && !plan.problems.length && !plan.kept.length) lines.push(`  ${shown(film)} has no clip of this take`);
    } else lines.push('  no film.html found, so no clip was moved');
    if (o.dryRun) {
      lines.push('dry run: nothing was changed');
      return { lines, plan, before, after };
    }
    for (const f of made.files) moveFile(join(made.work, f), join(dirname(video), f));
    if (plan?.changes.length) writeFileSync(film, plan.text);
    return { lines, plan, before, after };
  } finally {
    try {
      rmSync(made.work, { recursive: true, force: true, maxRetries: 5 });
    } catch {
      // Left in the temp folder
    }
  }
}

// ---------------------------------------------------------------- inspect

export async function inspect(url, o = {}) {
  const size = parseSize(o.size ?? SIZE);
  const steps = parseSteps(o.steps ?? []);
  const b = await Browser.launch(findBrowser(o.browser));
  try {
    const page = await openPage(b, { ...size, scale: 1, dark: !!o.dark, hide: o.hide ?? [], clock: steps.length > 0 });
    if (steps.length) {
      // The steps run as in a take, with nothing recorded
      const take = new Take(page, { ...size, scale: 1, fps: FPS, log: () => undefined });
      await take.goto(url);
      await take.idle(1200);
      for (const [i, step] of steps.entries()) {
        try {
          await take.run(step);
        } catch (e) {
          throw new Error(`step ${i + 1} ${JSON.stringify(step)}: ${e.message}`);
        }
      }
    } else {
      const r = await page.send('Page.navigate', { url }, 60000);
      if (r.errorText) throw new Error(`could not open ${url}: ${r.errorText}`);
      const end = Date.now() + 15000;
      while (Date.now() < end && (await page.evaluate('document.readyState').catch(() => '')) !== 'complete') await sleep(100);
      await sleep(1500);
    }
    const info = await page.evaluate('window.__wd.inventory()');
    return [
      `${info.title || '(no title)'}  ${info.url}`,
      `${size.width} x ${size.height} window; the page is ${info.height} px tall (${(info.height / size.height).toFixed(1)} windows)`,
      info.heads.length ? `Headings: ${info.heads.join(' · ')}` : 'No headings',
      'What can be pointed at (selector · kind · label · x,y on the page):',
      ...info.rows.map((row, i) => `  ${String(i + 1).padStart(2)}. ${row.sel} · ${row.kind} · ${row.name || '-'} · ${row.x},${row.y}`),
      info.more ? `  ... ${info.more} more not listed` : '',
    ].filter(Boolean).join('\n');
  } finally {
    await b.close();
  }
}

// ---------------------------------------------------------------- command line

function readSteps(arg) {
  if (arg === undefined) throw new Error('give the steps with --steps (a file, or a JSON list)');
  const text = /^\s*\[/.test(arg) ? arg : readFileSync(arg, 'utf8');
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`the steps are not JSON: ${e.message}`);
  }
}

async function main(argv) {
  const { values: v, positionals: p } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      steps: { type: 'string' }, size: { type: 'string' }, scale: { type: 'string' }, fps: { type: 'string' },
      dark: { type: 'boolean' }, hide: { type: 'string', multiple: true }, pointer: { type: 'boolean' }, browser: { type: 'string' },
      ffmpeg: { type: 'string' }, film: { type: 'string' }, 'dry-run': { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean' },
    },
  });
  if (v.version) return console.log(VERSION);
  if (v.help || !p.length) return console.log(HELP);
  if (p[0] === 'again') {
    if (p.length !== 2) throw new Error('again takes the take to record again: again <take.mp4>');
    const r = await again(p[1], { film: v.film, dryRun: v['dry-run'], browser: v.browser, ffmpeg: v.ffmpeg });
    console.log(r.lines.join('\n'));
    return;
  }
  if (p[0] === 'inspect') {
    if (p.length !== 2) throw new Error('inspect takes one address: inspect <url>');
    console.log(await inspect(p[1], { size: v.size, dark: v.dark, hide: v.hide, browser: v.browser, steps: v.steps === undefined ? [] : readSteps(v.steps) }));
    return;
  }
  if (p.length !== 2) throw new Error('give the address and the video to write: <url> <take.mp4> --steps <steps>');
  const out = resolve(p[1]);
  const { record } = await recordTake({ url: p[0], out, steps: readSteps(v.steps), size: v.size, scale: v.scale, fps: v.fps, dark: v.dark, hide: v.hide, pointer: v.pointer, browser: v.browser, ffmpeg: v.ffmpeg });
  const t = record.take;
  const marks = t.steps.filter((s) => typeof s.step.mark === 'string');
  console.log([
    `${shown(out)}  ${t.width} x ${t.height}, ${fmt(t.duration)} s, ${record.fps} fps`,
    `${shown(recordFileFor(out))}  what was recorded and what happened (${t.steps.length} steps)`,
    `${shown(cursorFileFor(out))}  the pointer, a page to lay over the video`,
    ...(marks.length ? [`marks: ${marks.map((s) => `${s.step.mark} ${fmt(s.t)} s`).join(' · ')}`] : []),
  ].join('\n'));
}

const same = (x) => (process.platform === 'win32' ? resolve(x).toLowerCase() : resolve(x));
if (process.argv[1] && same(process.argv[1]) === same(fileURLToPath(import.meta.url))) {
  // Exit once the output is written, whatever handles are left open
  main(process.argv.slice(2)).then(
    () => process.stdout.write('', () => process.exit(0)),
    (e) => {
      console.error(`record.mjs: ${e.message}`);
      process.exit(1);
    },
  );
}
