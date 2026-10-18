// A browser whose main process is killed mid-session: close() still returns and lets go of every pipe
import { Browser, findBrowser, openPage } from '../../skills/web-demo/scripts/record.mjs';

const b = await Browser.launch(findBrowser());
const page = await openPage(b, { width: 800, height: 600, scale: 1, dark: false, hide: [], clock: true });
await page.send('Page.navigate', { url: 'data:text/html,<h1>hi</h1>' });
await new Promise((r) => setTimeout(r, 1500));
process.kill(b.proc.pid);
await new Promise((r) => setTimeout(r, 500));
await b.close();
console.log(JSON.stringify({ closed: true, pipes: [b.proc.stdio[3], b.proc.stdio[4], b.proc.stderr].map((s) => s.destroyed) }));
