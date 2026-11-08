// The big search test (0.8.5): searches a long list of everyday words at every shop, from your
// computer, the way Restock does, and saves everything that came back, how Restock ranked it,
// and what it would recommend at your other shops after you tick the top one. The saved files
// are for making search better: nothing is sent anywhere except to the shops themselves.
//
//   npx vitest run --config tools/search-test/vitest.config.ts
//   TABS=pantry npx vitest run --config tools/search-test/vitest.config.ts       (one tab)
//   SHOPS=coles,bws WORDS="butter,beer" npx vitest run --config tools/search-test/vitest.config.ts
//
// It goes gently: one search at a time with a pause in between. Allow about an hour for everything.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, vi } from 'vitest';

// ---- The phone's pieces, replaced for a computer ----
vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => true, convertFileSrc: (s: string) => s, getPlatform: () => 'android' },
  CapacitorHttp: {
    async request(o: { url: string; method?: string; headers?: Record<string, string>; data?: unknown; readTimeout?: number }) {
      const g = globalThis as unknown as { httpLog: string[] };
      g.httpLog ??= [];
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), o.readTimeout ?? 20000);
      try {
        const body = o.data === undefined ? undefined : typeof o.data === 'string' ? o.data : JSON.stringify(o.data);
        const res = await fetch(o.url, { method: o.method ?? 'GET', headers: o.headers, body, signal: ctrl.signal, redirect: 'follow' });
        const headers: Record<string, string> = {};
        res.headers.forEach((v, k) => (headers[k] = v));
        const sc = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.();
        if (sc?.length) headers['set-cookie'] = sc.join('\n');
        g.httpLog.push(`${res.status} ${o.method ?? 'GET'} ${o.url.slice(0, 110)}`);
        return { status: res.status, data: await res.text(), headers, url: res.url };
      } catch (e) {
        g.httpLog.push(`failed ${o.method ?? 'GET'} ${o.url.slice(0, 110)}: ${(e as Error).message}`);
        throw e;
      } finally {
        clearTimeout(t);
      }
    },
  },
  registerPlugin: () => new Proxy({}, { get: () => async () => { throw new Error('Needs the phone (hidden browser)'); } }),
}));
vi.mock('../../src/lib/sql/native', () => ({
  RestockNative: new Proxy({}, { get: () => async () => { throw new Error('Needs the phone (hidden browser)'); } }),
}));
vi.mock('../../src/lib/diagnostics', () => ({ capture: () => undefined, logProblem: () => undefined }));
vi.mock('../../src/lib/db', () => {
  const kv = new Map<string, unknown>();
  const settings = { enabledChains: [], accounts: {}, stores: {}, localPrices: false, customShops: [] };
  return {
    getKV: async (k: string) => kv.get(k),
    putKV: async (k: string, v: unknown) => void kv.set(k, v),
    cachedSettings: () => settings,
    getSettings: async () => settings,
  };
});

const { adapterFor } = await import('../../src/stores/index');
const { SHOPS } = await import('../../src/shops');
const { matchesFor, likeThis, bestScore, normaliseQuery, UNLIKELY, scoreAll, topPicks, intendedKind, weakShops } = await import('../../src/lib/searchHelp');
const { mark, scorecard } = await import('../../src/lib/searchScore');
const { genericName } = await import('../../src/lib/naming');

const { SEARCH_WORDS: WORDS } = await import('../../src/lib/searchWords');
const tabs = process.env.TABS?.split(',').map((s) => s.trim());
const pickShops = process.env.SHOPS?.split(',').map((s) => s.trim());
const shops = SHOPS.filter((s) => (pickShops ? pickShops.includes(s.id) || pickShops.includes(s.section) : tabs ? tabs.includes(s.section) : true));
const words = process.env.WORDS?.split(',').map((w) => w.trim());
const out = join(__dirname, 'out');
mkdirSync(out, { recursive: true });
const pause = () => new Promise((r) => setTimeout(r, 1500));

interface Row {
  shop: string;
  word: string;
  ms: number;
  error?: string;
  count: number;
  best?: number;
  ranked: { name: string; brand?: string; size?: string; price?: number; was?: number; special?: boolean; id?: string; score: number; photo: boolean; recommended?: boolean }[];
}
const rows: Row[] = [];
const raw: Record<string, unknown> = {};
const recs: Record<string, unknown> = {};

const short = (p: { name: string; size?: string; price?: number }) => `${p.name}${p.size ? ` [${p.size}]` : ''} $${p.price === undefined ? '?' : p.price.toFixed(2)}`;

describe('big search test', () => {
  it('searches every shop', { timeout: 6 * 60 * 60 * 1000 }, async () => {
    const lines: string[] = [];
    const byWord = new Map<string, Map<string, unknown[]>>();
    for (const shop of shops) {
      const a = adapterFor(shop.id);
      if (!a) continue;
      for (const word of words ?? WORDS[shop.section] ?? WORDS.pantry) {
        const t0 = Date.now();
        (globalThis as unknown as { httpLog: string[] }).httpLog = [];
        const text = normaliseQuery(word);
        const row: Row = { shop: shop.id, word, ms: 0, count: 0, ranked: [] };
        try {
          const items = await a.search(text, undefined as never);
          // Scored the way the app does it (0.8.5): best first, counting where the shop put it.
          const scored = scoreAll({ text }, items);
          const ranked = scored.map((x) => x.sp);
          const top = new Set(topPicks(scored));
          raw[`${shop.id}|${word}`] = items;
          row.count = items.length;
          row.best = bestScore({ text }, items);
          row.ranked = ranked.map((p, i) => ({
            name: p.name, brand: p.brand, size: p.size, price: p.price, was: p.wasPrice, special: p.isSpecial,
            id: p.storeProductId, score: Math.round(scored[i].s * 1000) / 1000, photo: !!p.imageUrl, recommended: top.has(p),
          }));
          if (!byWord.has(word)) byWord.set(word, new Map());
          byWord.get(word)!.set(shop.id, ranked);
        } catch (e) {
          row.error = `${(e as Error).message} | ${((globalThis as unknown as { httpLog?: string[] }).httpLog ?? []).slice(-3).join(' | ')}`;
        }
        row.ms = Date.now() - t0;
        rows.push(row);
        const line = `${shop.name.padEnd(24)} ${word.padEnd(26)} ${row.error ? `ERROR ${row.error.slice(0, 120)}` : `${String(row.count).padStart(3)} results ${(row.ms / 1000).toFixed(1)}s best ${row.best?.toFixed(2)}${(row.best ?? 0) < UNLIKELY ? ' (nothing likely)' : ''}`}`;
        console.log(line);
        lines.push(line, ...row.ranked.slice(0, 8).map((p, i) => `      ${i + 1}. ${p.recommended ? '★ ' : ''}${short(p)} · ${p.score}${p.photo ? '' : ' (no photo)'}`));
        await pause();
      }
    }
    // Shops with nothing like a word, searched again for what it is, as the app does (0.8.6):
    // "western star" is butter at Woolworths, so Aldi is searched for butter.
    for (const [word, at] of byWord) {
      const text = normaliseQuery(word);
      const scored = Object.fromEntries([...at.keys()].map((shop) => [shop, scoreAll({ text }, (raw[`${shop}|${word}`] ?? []) as never)]));
      const kind = intendedKind({ text }, scored);
      if (!kind) continue;
      for (const shop of weakShops(scored)) {
        try {
          raw[`${shop}|${word}|${kind}`] = await adapterFor(shop)!.search(kind, undefined as never);
          lines.push(`${shop.padEnd(24)} ${word.padEnd(26)} nothing like it, so searched "${kind}": ${raw[`${shop}|${word}|${kind}`].length} results`);
        } catch {
          // that shop didn't answer
        }
        await pause();
      }
    }
    // What Restock would recommend at the other shops after you tick the top result at the first shop.
    for (const [word, at] of byWord) {
      const chains = [...at.keys()];
      if (chains.length < 2) continue;
      const anchor = (at.get(chains[0]) as never[])[0] as never as { name: string; brand?: string; chain: string } | undefined;
      if (!anchor) continue;
      const kind = genericName(anchor.name, anchor.brand) || word;
      const rec: Record<string, unknown> = { anchor: short(anchor as never), kind };
      for (const chain of chains.slice(1)) {
        const a = adapterFor(chain);
        const pool = [...((at.get(chain) as never[]) ?? [])] as never[];
        const terms = [...new Set([anchor.brand ? `${anchor.brand} ${kind}` : '', kind].map((t) => t.toLowerCase().trim()))].filter((t) => t && t !== word);
        for (const t of terms) {
          try {
            pool.push(...((await a!.search(t, undefined as never)) as never[]));
          } catch {
            // that shop didn't answer
          }
          await pause();
        }
        const same = matchesFor(anchor as never, pool, 0.6)[0] as never as { name: string } | undefined;
        const sameId = (same as never as { storeProductId?: string } | undefined)?.storeProductId;
        const like = likeThis(anchor as never, pool.filter((p) => !sameId || (p as { storeProductId?: string }).storeProductId !== sameId), kind, word, same ? 2 : 3) as never as { name: string }[];
        rec[chain] = { same: same ? short(same as never) : null, like: like.map((p) => short(p as never)), pool: pool.length };
      }
      recs[word] = rec;
      lines.push(`\nRECOMMEND ${word}: ticked ${rec.anchor} at ${chains[0]}`, ...chains.slice(1).map((c) => `      ${c}: ${JSON.stringify(rec[c])}`));
      console.log(`recommend ${word} done`);
    }
    writeFileSync(join(out, 'report.txt'), lines.join('\n'));
    writeFileSync(join(out, 'ranked.json'), JSON.stringify(rows, null, 1));
    writeFileSync(join(out, 'recommend.json'), JSON.stringify(recs, null, 1));
    writeFileSync(join(out, 'raw.json'), JSON.stringify(raw));
    const card = scorecard(mark(raw as never));
    writeFileSync(join(out, 'scorecard.txt'), card);
    console.log(`\n${card.split('\n\n')[0]}`);
    console.log(`\nSaved in ${out}: report.txt, scorecard.txt, ranked.json, recommend.json, raw.json`);
  });
});
