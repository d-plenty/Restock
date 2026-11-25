// 0.13.2: the hidden browser on a shop's own website, for iPhone and iPad. The same steps as
// Android's StoreWeb.java (get, render), written on top of two things the native plugin does
// (RestockApple: load a page, run a script in it). One page per shop, one request at a time per shop.
import { RestockApple } from './apple';

/** StoreWeb.FRESH_MS: how long a shop's page is good for before it's loaded again. */
export const FRESH_MS = 25 * 60_000;

const loadedAt = new Map<string, number>();
const queue = new Map<string, Promise<unknown>>();

/** One thing at a time per shop (StoreWeb's methods are synchronized). */
function oneAtATime<T>(chain: string, work: () => Promise<T>): Promise<T> {
  const before = queue.get(chain) ?? Promise.resolve();
  const run = before.then(work, work);
  queue.set(
    chain,
    run.catch(() => undefined),
  );
  return run;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const key = (chain: string) => `shop-${chain}`;

/** How many shops' pages are kept open at once (each is a whole browser page in the phone's memory). */
const MAX_PAGES = 3;
const usedAt = new Map<string, number>();
let tick = 0;

/** Notes that this shop's page is in use, and closes the one used longest ago when there are too many. */
async function touch(chain: string): Promise<void> {
  usedAt.set(chain, ++tick);
  while (usedAt.size > MAX_PAGES) {
    const [oldest] = [...usedAt.entries()].sort((a, b) => a[1] - b[1])[0];
    if (oldest === chain) break;
    usedAt.delete(oldest);
    loadedAt.delete(oldest);
    await RestockApple.webClose({ key: key(oldest) }).catch(() => undefined);
  }
}

/** A script's string answer, or '' when the page couldn't run it. */
async function evalText(chain: string, expr: string): Promise<string> {
  try {
    return (await RestockApple.webEval({ key: key(chain), js: `try { return String(${expr}); } catch (e) { return ''; }` })).value ?? '';
  } catch {
    return '';
  }
}

async function ensurePage(chain: string, home: string, force: boolean): Promise<void> {
  const at = loadedAt.get(chain) ?? 0;
  if (!force && at > 0 && Date.now() - at < FRESH_MS) return;
  await RestockApple.webLoad({ key: key(chain), url: home, timeoutMs: 40_000 });
  loadedAt.set(chain, Date.now());
}

/** StoreWeb.looksBlocked. */
export function looksBlocked(r: { status: number; body: string }): boolean {
  const body = (r.body ?? '').trim();
  return r.status === 403 || r.status === 429 || r.status <= 0 || body.startsWith('<');
}

/** The script that makes one request from inside the shop's page (StoreWeb.run). Its answer: JSON {status, body}. */
export function fetchScript(chain: string, method: 'GET' | 'POST', url: string, body?: string): string {
  const coles =
    chain === 'coles'
      ? `var key = window.__restockKey;
if (!key) { var m = document.documentElement.innerHTML.match(/BFF_API_SUBSCRIPTION_KEY["']?\\s*:\\s*["']([^"']+)["']/); if (m) { key = m[1]; window.__restockKey = key; } }
if (!key) { try { key = window.__NEXT_DATA__.runtimeConfig.BFF_API_SUBSCRIPTION_KEY; window.__restockKey = key; } catch (e) {} }
if (!key) return JSON.stringify({ status: 0, body: 'no key: ' + document.title });
url += (url.indexOf('?') < 0 ? '?' : '&') + 'subscription-key=' + encodeURIComponent(key);`
      : '';
  return `var url = ${JSON.stringify(url)};
${coles}
var o = { method: ${JSON.stringify(method)}, headers: { Accept: 'application/json, text/plain, */*' } };
${body !== undefined ? `o.body = ${JSON.stringify(body)}; o.headers['Content-Type'] = 'application/json';` : ''}
var stop = new AbortController(); o.signal = stop.signal;
var timer = setTimeout(function () { stop.abort(); }, 30000);
try {
  var r = await fetch(url, o);
  var t = await r.text();
  return JSON.stringify({ status: r.status, body: t });
} catch (e) {
  return JSON.stringify({ status: -1, body: String(e) });
} finally {
  clearTimeout(timer);
}`;
}

async function run(chain: string, method: 'GET' | 'POST', url: string, body?: string): Promise<{ status: number; body: string }> {
  try {
    const out = JSON.parse((await RestockApple.webEval({ key: key(chain), js: fetchScript(chain, method, url, body) })).value || '{}') as { status?: number; body?: string };
    return { status: typeof out.status === 'number' ? out.status : -1, body: typeof out.body === 'string' ? out.body : '' };
  } catch (e) {
    return { status: -1, body: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * A request made from inside the shop's page (StoreWeb.get). `url` is a path on the shop's site or a
 * full address the site itself uses. Blocked the first time: the page is loaded afresh and it's tried once more.
 */
export function pageFetch(chain: string, home: string, method: 'GET' | 'POST', url: string, body?: string): Promise<{ status: number; body: string }> {
  return oneAtATime(chain, async () => {
    await touch(chain);
    await ensurePage(chain, home, false);
    let r = await run(chain, method, url, body);
    if (looksBlocked(r)) {
      await ensurePage(chain, home, true);
      r = await run(chain, method, url, body);
    }
    return r;
  });
}

/** StoreWeb.looksLikeCheck: the holding pages bot-protection services show while they check the browser. */
export function looksLikeCheck(text: string | undefined): boolean {
  const t = (text ?? '').toLowerCase();
  return (
    t.includes('just a moment') ||
    t.includes('checking your browser') ||
    t.includes('verify you are human') ||
    t.includes('are you a robot') ||
    t.includes('pardon our interruption') ||
    t.includes('please wait while we') ||
    t.includes('enable javascript and cookies') ||
    t.includes('request unsuccessful')
  );
}

const CHECK = "(document.title||'')+' | '+(document.body?document.body.innerText.slice(0,600):'')";

/**
 * A page opened in the hidden browser and read once its scripts have drawn it (StoreWeb.renderHere):
 * waits out a bot check that clears itself, scrolls down through the page, and stops when its prices
 * stop changing.
 */
export function pageRender(chain: string, url: string, pace = 1): Promise<{ status: number; html: string; url: string }> {
  return oneAtATime(chain, async () => {
    await touch(chain);
    const first = await RestockApple.webLoad({ key: key(chain), url, timeoutMs: 25_000 });
    loadedAt.set(chain, Date.now());
    for (let i = 0; i < 15 && looksLikeCheck(await evalText(chain, CHECK)); i++) await sleep(1000 * pace);
    let last = '';
    let steady = 0;
    for (let i = 0; i < 16; i++) {
      const now = await evalText(
        chain,
        `(function(){var h=document.body?document.body.scrollHeight:0;window.scrollTo(0,Math.min(h,${i + 1}*1200));var t=document.body?document.body.innerText:'';var m=t.match(/\\$\\s?\\d/g);var ld=document.querySelectorAll('script[type="application/ld+json"]').length;var im=document.images.length;return (m?m.length:0)+':'+ld+':'+t.length+':'+im;})()`,
      );
      const parts = now.split(':');
      const hasPrices = parts.length > 1 && (parts[0] !== '0' || parts[1] !== '0');
      steady = now === last ? steady + 1 : 0;
      if (hasPrices && steady >= 2) break;
      if (!hasPrices && steady >= 4) break;
      last = now;
      await sleep(700 * pace);
    }
    // Back to the top, and each lazy picture's real address copied into src, so it's in the HTML.
    await evalText(
      chain,
      `(function(){window.scrollTo(0,0);var n=0;document.querySelectorAll('img').forEach(function(i){var c=i.currentSrc||'';if(c&&c.indexOf('data:')!==0&&(!i.getAttribute('src')||i.getAttribute('src').indexOf('data:')===0)){i.setAttribute('src',c);n++;}});return n;})()`,
    );
    const html = await evalText(chain, 'document.documentElement.outerHTML');
    const where = await evalText(chain, 'location.href');
    return { status: first.status, html, url: where || first.url || url };
  });
}

/** After the shop's site was open on screen (a sign-in, a passed check): its page is loaded afresh next time. */
export function forgetPage(chain: string): void {
  loadedAt.delete(chain);
}
