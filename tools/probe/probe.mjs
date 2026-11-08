#!/usr/bin/env node
// Restock shop probe: opens each shop's search in a real browser on your computer, searches for a
// few test words the way a person would, and saves what the shop sent back (the data behind the
// results, the finished page, and a screenshot). The saved files are what's needed to build and
// test a shop's connection. Nothing is sent anywhere: everything goes into one .tar.gz you share.
//
//   node probe.mjs                      all shops, a few words each
//   node probe.mjs --shops pharmacy     only pharmacies (or: pantry, keg, or ids like chemistwarehouse,bws)
//   node probe.mjs --words "butter,milk" your own words
//   node probe.mjs --more               more words per shop (takes about twice as long)
//   node probe.mjs --headless           no browser window (some shops block this; the window is better)
//
// Be gentle: it waits a few seconds between searches, and only opens one page at a time.

import { chromium, devices } from 'playwright';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true) : undefined;
};

// Three words per shop by default (about 25 minutes for every shop); --more for the longer list.
const WORDS = opt('more')
  ? {
      pantry: ['butter', 'milk', 'bread', 'eggs', 'cheese', 'chicken breast', 'coffee', 'toilet paper'],
      keg: ['beer', 'great northern', 'shiraz', 'vodka', 'bourbon'],
      pharmacy: ['paracetamol', 'panadol', 'ibuprofen', 'vitamin d', 'sunscreen', 'toothpaste'],
    }
  : {
      pantry: ['butter', 'milk', 'chicken breast'],
      keg: ['beer', 'great northern', 'shiraz'],
      pharmacy: ['paracetamol', 'ibuprofen', 'sunscreen'],
    };

const shops = JSON.parse(readFileSync(join(here, 'shops.json'), 'utf8'));
const pick = String(opt('shops') ?? 'all');
const chosen = shops.filter((s) =>
  pick === 'all' ? true : ['pantry', 'keg', 'pharmacy'].includes(pick) ? s.section === pick : pick.split(',').includes(s.id),
);
// Liquorland Warehouse and Cellars are the same website as Liquorland.
const seen = new Set();
const todo = chosen.filter((s) => (seen.has(s.website + (s.search ?? '')) ? false : seen.add(s.website + (s.search ?? ''))));
const custom = typeof opt('words') === 'string' ? String(opt('words')).split(',').map((w) => w.trim()).filter(Boolean) : undefined;

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const out = join(here, 'out', `probe-${stamp}`);
mkdirSync(out, { recursive: true });
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function launch() {
  const headless = !!opt('headless');
  const base = { ...devices['Pixel 7'], headless, locale: 'en-AU', timezoneId: 'Australia/Brisbane' };
  const profile = join(here, '.profile');
  // The browser Playwright downloaded, then Chrome or Chromium already on the computer.
  for (const extra of [{}, { channel: 'chrome' }, { executablePath: '/usr/bin/chromium-browser' }, { executablePath: '/usr/bin/chromium' }]) {
    try {
      return await chromium.launchPersistentContext(profile, { ...base, ...extra });
    } catch (e) {
      if (extra.executablePath === '/usr/bin/chromium') throw e;
    }
  }
}

const BOT = /just a moment|checking your browser|verify you are human|are you a robot|pardon our interruption|access denied/i;

async function searchByTyping(page, word) {
  const box = page
    .locator(
      'input[type="search"]:visible, input[name="q"]:visible, input[name*="search" i]:visible, input[placeholder*="search" i]:visible, input[aria-label*="search" i]:visible',
    )
    .first();
  if (!(await box.count())) {
    // Some sites hide the box behind a search button.
    const btn = page.locator('button[aria-label*="search" i], a[aria-label*="search" i], [class*="search" i] button').first();
    if (await btn.count()) await btn.click({ timeout: 3000 }).catch(() => {});
    await sleep(800);
  }
  const box2 = page
    .locator('input[type="search"]:visible, input[name="q"]:visible, input[name*="search" i]:visible, input[placeholder*="search" i]:visible')
    .first();
  if (!(await box2.count())) return false;
  await box2.click({ timeout: 3000 }).catch(() => {});
  await box2.fill(word);
  await box2.press('Enter');
  return true;
}

async function probe(ctx, shop, word) {
  const dir = join(out, shop.id, slug(word));
  mkdirSync(dir, { recursive: true });
  const page = await ctx.newPage();
  const caught = [];
  let n = 0;
  page.on('response', async (res) => {
    try {
      const type = (res.headers()['content-type'] ?? '').toLowerCase();
      const url = res.url();
      if (!/json|javascript\+json|graphql/.test(type) && !/algolia|search|product|graphql|api\//i.test(url)) return;
      if (/\.(js|css|png|jpe?g|webp|gif|svg|woff2?)(\?|$)/i.test(url)) return;
      const body = await res.text();
      const t = body.trim();
      if (!(t.startsWith('{') || t.startsWith('['))) return;
      if (caught.length >= 30 || t.length > 3_000_000) return;
      const file = `data-${String(++n).padStart(2, '0')}.json`;
      const req = res.request();
      writeFileSync(
        join(dir, file),
        JSON.stringify({ url, method: req.method(), status: res.status(), requestBody: req.postData() ?? undefined, body: JSON.parse(t) }, null, 1),
      );
      caught.push({ file, url, status: res.status(), bytes: t.length });
    } catch {
      // a response we can't read: skip it
    }
  });
  const started = Date.now();
  let how = 'address';
  try {
    if (shop.search) {
      await page.goto(shop.search.replace('{q}', encodeURIComponent(word)), { waitUntil: 'domcontentloaded', timeout: 45000 });
    } else {
      how = 'typed';
      await page.goto(shop.website, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await sleep(2500);
      if (!(await searchByTyping(page, word))) {
        how = 'guess';
        await page.goto(`${shop.website.replace(/\/$/, '')}/search?q=${encodeURIComponent(word)}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
      }
    }
    // A bot check usually clears itself; in a window you can also tick the box.
    for (let i = 0; i < 25 && BOT.test(await page.title().catch(() => '')); i++) await sleep(1000);
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    for (let i = 1; i <= 4; i++) {
      await page.mouse.wheel(0, 900);
      await sleep(600);
    }
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  } catch (e) {
    writeFileSync(join(dir, 'error.txt'), String(e?.stack ?? e));
  }
  const html = await page.content().catch(() => '');
  writeFileSync(join(dir, 'page.html'), html);
  await page.screenshot({ path: join(dir, 'screen.jpg'), type: 'jpeg', quality: 55 }).catch(() => {});
  const summary = { shop: shop.id, word, how, url: page.url(), title: await page.title().catch(() => ''), ms: Date.now() - started, data: caught, htmlBytes: html.length };
  writeFileSync(join(dir, 'summary.json'), JSON.stringify(summary, null, 1));
  await page.close();
  return summary;
}

const ctx = await launch();
const results = [];
console.log(`Restock shop probe: ${todo.length} shops. Saving to ${out}`);
for (const shop of todo) {
  const words = custom ?? WORDS[shop.section] ?? WORDS.pantry;
  for (const word of words) {
    process.stdout.write(`  ${shop.name.padEnd(26)} ${word.padEnd(16)} `);
    const s = await probe(ctx, shop, word);
    results.push(s);
    console.log(`${s.data.length} data files, ${Math.round(s.htmlBytes / 1024)} KB page, ${(s.ms / 1000).toFixed(1)} s`);
    await sleep(2500);
  }
}
await ctx.close();
writeFileSync(join(out, 'all.json'), JSON.stringify(results, null, 1));
const archive = `${out}.tar.gz`;
execFileSync('tar', ['-czf', archive, '-C', dirname(out), out.split('/').pop()]);
console.log(`\nDone. Send this file to Claude:\n  ${archive}`);
if (!existsSync(archive)) process.exitCode = 1;
