// Live search check: runs Restock's own shop connections and ranking against the real shops,
// from your computer, and writes what came back and how it was ranked.
//
//   npx vitest run --config tools/live-search/vitest.config.ts
//   SHOPS=coles,bws WORDS="butter,beer" npx vitest run --config tools/live-search/vitest.config.ts
//
// Shops that need the phone's hidden browser (pages drawn by scripts, bot checks) will say so:
// the shop probe (tools/probe) captures those instead.
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
const { rankAll } = await import('../../src/stores/rank');
const { SHOPS } = await import('../../src/shops');

const WORDS: Record<string, string[]> = {
  pantry: ['butter', 'milk', 'bread', 'eggs', 'cheese', 'chicken breast', 'coffee', 'toilet paper'],
  keg: ['beer', 'great northern', 'shiraz', 'vodka', 'bourbon'],
  pharmacy: ['paracetamol', 'panadol', 'ibuprofen', 'vitamin d', 'sunscreen', 'toothpaste'],
};
const pickShops = process.env.SHOPS?.split(',').map((s) => s.trim());
const shops = SHOPS.filter((s) => (pickShops ? pickShops.includes(s.id) || pickShops.includes(s.section) : true));
const words = process.env.WORDS?.split(',').map((w) => w.trim());
const out = join(__dirname, 'out');
mkdirSync(out, { recursive: true });
const lines: string[] = [];
const raw: Record<string, unknown> = {};

describe('live search', () => {
  it('searches every shop', { timeout: 60 * 60 * 1000 }, async () => {
    for (const shop of shops) {
      const a = adapterFor(shop.id);
      if (!a) continue;
      for (const word of words ?? WORDS[shop.section] ?? WORDS.pantry) {
        const t0 = Date.now();
        (globalThis as unknown as { httpLog: string[] }).httpLog = [];
        let line = `${shop.name.padEnd(24)} ${word.padEnd(16)} `;
        try {
          const items = await a.search(word, undefined as never);
          const ranked = rankAll({ text: word }, items);
          raw[`${shop.id}|${word}`] = items;
          line += `${String(items.length).padStart(3)} results ${((Date.now() - t0) / 1000).toFixed(1)}s\n`;
          line += ranked
            .slice(0, 6)
            .map((p, i) => `      ${i + 1}. ${p.name}${p.size ? ` [${p.size}]` : ''} $${p.price ?? '?'}${p.imageUrl ? '' : ' (no photo)'}`)
            .join('\n');
        } catch (e) {
          line += `ERROR ${(e as Error).message}\n${((globalThis as unknown as { httpLog?: string[] }).httpLog ?? []).map((l) => `      ${l}`).join('\n')}`;
        }
        console.log(line);
        lines.push(line);
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
    writeFileSync(join(out, 'report.txt'), lines.join('\n'));
    writeFileSync(join(out, 'results.json'), JSON.stringify(raw, null, 1));
    console.log(`\nSaved: ${join(out, 'report.txt')} and results.json`);
  });
});
