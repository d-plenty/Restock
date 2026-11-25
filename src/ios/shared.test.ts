import { gzipSync, strToU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import { chainsOf, importAll, newer, parseWindow, readPoints, refreshDue, unpack, WINDOW_BASE, windowDays, type MarketDeps } from './market';
import { installOf, localDay, rowShape, sendPrices, SHARE_URL, type ShareDeps } from './share';

// Shared prices on iPhone and iPad: the download (ios/market.ts) and sending prices back
// (ios/share.ts). That the summary maths is Android's is checked against Deals.summarise
// (tools/sync-test/market-parity.sh).

const NOW = Date.parse('2026-11-25T04:00:00Z');
const enc = (o: unknown) => strToU8(JSON.stringify(o));

describe('shared price history: reading a day-one file', () => {
  const file = {
    format: 'restock-window', v: 1, chain: 'coles', days: 56, from: '2026-09-30', to: '2026-11-25',
    products: { '111': [[0, 500], [20, 350, 1], [27, 500]], '222': [[50, 400]], bad: 'x', '333': [[-1, 100], [0, 0], ['a', 5], [0, 250]] },
  };
  it('summarises each product with enough history, and skips the rest', () => {
    const rows = parseWindow(JSON.stringify(file), NOW, 56);
    expect(rows.map((r) => r.id)).toEqual(['111', '333']);
    expect(rows[0].m).toMatchObject({ normal: 5, sale: 3.5, low: 3.5, latest: 5, days: 56 });
    expect(rows[0].m.saleShare).toBeCloseTo(7 / 56, 5);
    expect(rows[1].m).toMatchObject({ normal: 2.5, low: 2.5 });
  });
  it('turns change points into dates and dollars, dropping broken ones', () => {
    expect(readPoints([[0, 495], [33, 350, 1], [5000, 1], [1, 99999999], 'x'], '2026-09-17')).toEqual({ dates: ['2026-09-17', '2026-10-20'], prices: [4.95, 3.5] });
    expect(readPoints('nope', '2026-09-17')).toEqual({ dates: [], prices: [] });
  });
  it('refuses a file that is not one', () => {
    expect(() => parseWindow(JSON.stringify({ format: 'something-else', products: {} }), NOW, 56)).toThrow('not a restock-prices day-one file');
    expect(() => parseWindow(JSON.stringify({ format: 'restock-window', products: { a: [[0, 1]] } }), NOW, 56)).toThrow('no start date');
  });
  it('unpacks gzip, and takes a file that was unpacked on the way', () => {
    expect(unpack(gzipSync(strToU8('{"a":1}')))).toBe('{"a":1}');
    expect(unpack(strToU8('{"a":1}'))).toBe('{"a":1}');
  });
  it('picks the file length from the history setting, and only real shop ids', () => {
    expect([windowDays({ historyWeeks: 8 }), windowDays({ historyWeeks: 26 }), windowDays({ historyWeeks: 52 }), windowDays({ marketData: { days: 182 } }), windowDays({ marketData: { days: 7 } })]).toEqual([56, 182, 365, 182, 56]);
    expect(chainsOf({ enabledChains: ['coles', 'coles', 'Bad Id', 'custom-ab12'] })).toEqual(['coles', 'custom-ab12']);
  });

  const deps = (files: Record<string, Uint8Array | number>) => {
    const ops: { sql: string; params?: (string | number | null)[] }[] = [];
    const kv: Record<string, unknown> = {};
    const d: MarketDeps = {
      get: async (url) => {
        const f = files[url.replace(WINDOW_BASE, '')];
        return typeof f === 'number' || f === undefined ? { status: f ?? 404, bytes: new Uint8Array() } : { status: 200, bytes: f };
      },
      write: async (o) => void ops.push(...o),
      putKV: async (k, v) => void (kv[k] = v),
      now: () => NOW,
    };
    return { d, ops, kv };
  };
  const index = enc({ format: 'restock-window-index', shops: { coles: { to: '2026-11-25', full: '2026-11-19' }, aldi: { to: '2026-11-25' } } });

  it('downloads each shop it uses, writes the summaries, and remembers what was published', async () => {
    const { d, ops, kv } = deps({ 'index.json': index, 'coles-56d.json.gz': gzipSync(enc(file)), 'aldi-56d.json.gz': 500 });
    const r = await importAll({ historyWeeks: 8, enabledChains: ['coles', 'aldi', 'priceline'] }, d);
    expect(r.byChain).toEqual({ coles: 2 });
    expect(r.products).toBe(2);
    expect(r.missing).toEqual(['priceline']); // the collector doesn't publish chemists
    expect(r.errors).toEqual({ aldi: 'restock-prices returned HTTP 500' });
    const inserts = ops.filter((o) => o.sql.startsWith('INSERT'));
    expect(inserts.length).toBe(2);
    expect(inserts[0].params).toEqual(['coles', '111', 5, 3.5, 7 / 56, 3.5, null, 56, 'restock-prices', new Date(NOW).toISOString(), 5]);
    expect(ops[0]).toEqual({ sql: 'DELETE FROM market WHERE chain NOT IN (?, ?, ?)', params: ['coles', 'aldi', 'priceline'] });
    expect(kv.marketImport).toMatchObject({ products: 2, days: 56, missing: ['priceline'], published: true, index: { coles: { to: '2026-11-25', full: '2026-11-19' } } });
  });

  it('a download is due when something newer is published, at most once a day, and never when it is off', async () => {
    const idx = { format: 'restock-window-index', shops: { coles: { to: '2026-11-25', full: '2026-11-19' } } };
    const s = { marketData: { enabled: true }, enabledChains: ['coles'], historyWeeks: 8 };
    const last = (hoursAgo: number, full: string, to = full) => ({ at: new Date(NOW - hoursAgo * 3_600_000).toISOString(), days: 56, index: { coles: { to, full } } });
    expect(await refreshDue(s, undefined, async () => idx, NOW)).toBe(true);
    expect(await refreshDue(s, last(2, '2026-11-12'), async () => idx, NOW)).toBe(false);
    expect(await refreshDue(s, last(30, '2026-11-12'), async () => idx, NOW)).toBe(true);
    expect(await refreshDue(s, last(30, '2026-11-19'), async () => idx, NOW)).toBe(false);
    expect(await refreshDue({ ...s, marketData: { enabled: true, every: 'daily' } }, last(30, '2026-11-19', '2026-11-24'), async () => idx, NOW)).toBe(true);
    expect(await refreshDue({ ...s, historyWeeks: 26 }, last(30, '2026-11-19'), async () => idx, NOW)).toBe(true); // a different length
    expect(await refreshDue(s, last(30, '2026-11-19'), async () => undefined, NOW)).toBe(false); // can't tell, and under a week
    expect(await refreshDue(s, last(8 * 24, '2026-11-19'), async () => undefined, NOW)).toBe(true);
    expect(await refreshDue({ ...s, marketData: { enabled: false } }, undefined, async () => idx, NOW)).toBe(false);
    expect(await refreshDue({ ...s, sharePrices: 'no' }, undefined, async () => idx, NOW)).toBe(false);
    expect(newer(idx, undefined, ['aldi'], false)).toBe(false);
  });
});

describe('shared prices: sending prices back', () => {
  const row = (id: number, more: Record<string, unknown> = {}) => ({
    id, chain: 'coles', store_product_id: `sp${id}`, name: `Thing ${id}`, brand: 'Acme', size: null, barcode: '9300000000001', image_url: null,
    price: 4.5, was_price: null, is_special: 0, member_only: 0, promo: null, date: '2026-11-24T22:30:00Z', ...more,
  });
  const deps = (rows: unknown[], kv: Record<string, unknown> = {}, status: number | (() => number) = 200) => {
    const posts: { url: string; body: { install: string; chain: string; products: { id: string }[]; format: string; v: number } }[] = [];
    const queries: { sql: string; params?: (string | number)[] }[] = [];
    const d: ShareDeps = {
      getKV: async <T,>(k: string) => kv[k] as T | undefined,
      putKV: async (k, v) => void (kv[k] = v),
      query: async <T,>(sql: string, params?: (string | number)[]) => {
        queries.push({ sql, params });
        return rows as T[];
      },
      post: async (url, body) => {
        posts.push({ url, body: JSON.parse(body) });
        return typeof status === 'function' ? status() : status;
      },
      uid: () => 'install-1234',
      now: () => NOW,
    };
    return { d, kv, posts, queries };
  };

  it('sends what a check read and what searches showed, by shop, in the shape Android sends', async () => {
    const waiting = [{ id: 'aldi:9', chain: 'aldi', name: 'Searched' }, { id: 'x:1', chain: 'priceline', name: 'Not shared' }];
    const { d, kv, posts, queries } = deps([row(11), row(12, { price: 0 }), row(13, { chain: 'woolworths', was_price: 6, is_special: 1, promo: '2 for $8' })], { priceShareCursor: 10, priceShareOutbox: waiting });
    expect(await sendPrices(d)).toBe(3);
    expect(queries[0].params).toEqual([10, new Date(NOW - 14 * 86_400_000).toISOString()]);
    expect(queries[0].sql).toContain("r.source = 'auto'"); // never a price typed in by hand
    expect(queries[0].sql).toContain('sync_log'); // never one another phone synced here
    expect(posts.map((p) => [p.url, p.body.chain, p.body.products.length])).toEqual([[SHARE_URL, 'coles', 1], [SHARE_URL, 'woolworths', 1], [SHARE_URL, 'aldi', 1]]);
    expect(posts[0].body).toMatchObject({ format: 'restock-share', v: 1, install: 'install-1234' });
    expect(posts[0].body.products[0]).toEqual({
      id: 'coles:sp11', chain: 'coles', store_product_id: 'sp11', name: 'Thing 11', brand: 'Acme', barcode: '9300000000001',
      price: { price: 4.5, is_special: false, member_only: false }, day: localDay('2026-11-24T22:30:00Z'),
    });
    expect(posts[1].body.products[0]).toMatchObject({ price: { price: 4.5, was_price: 6, is_special: true, member_only: false, promo: '2 for $8' } });
    expect(kv.priceShareCursor).toBe(13);
    expect(kv.priceShareOutbox).toEqual([]);
    expect(kv.priceShare).toMatchObject({ sent: 3, total: 3, lastSentAt: new Date(NOW).toISOString() });
    expect(kv.installId).toBe('install-1234');
  });

  it('nothing new: nothing is sent', async () => {
    const { d, posts } = deps([], { priceShareCursor: 10 });
    expect(await sendPrices(d)).toBe(0);
    expect(posts.length).toBe(0);
  });

  it('the service says no: nothing is marked as sent, the reason is kept, and it goes next time', async () => {
    const { d, kv } = deps([row(11)], { priceShareCursor: 10, priceShare: { total: 5, lastSentAt: 'before' } }, 429);
    expect(await sendPrices(d)).toBe(0);
    expect(kv.priceShareCursor).toBe(10);
    expect(kv.priceShare).toMatchObject({ sent: 0, total: 5, lastSentAt: 'before', error: 'the shared price service has had enough for today' });
  });

  it('something the service will not take (400) is dropped, not sent again for ever', async () => {
    const { d, kv } = deps([row(11)], { priceShareCursor: 10 }, 400);
    expect(await sendPrices(d)).toBe(1);
    expect(kv.priceShareCursor).toBe(11);
  });

  it('keeps the install number it has, and makes one when it has none or a broken one', async () => {
    expect(await installOf(deps([], { installId: 'abc-123456' }).d)).toBe('abc-123456');
    expect(await installOf(deps([], { installId: '!!' }).d)).toBe('install-1234');
  });

  it('a price row keeps only a real barcode, and the day is this device\'s calendar day', () => {
    expect(rowShape(row(1, { barcode: 'abc' }) as never, NOW)).not.toHaveProperty('barcode');
    expect(localDay('2026-11-24', NOW)).toBe('2026-11-24');
    expect(localDay('', NOW)).toMatch(/^2026-11-2[45]$/);
  });
});
