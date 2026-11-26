import initSqlJs, { type SqlJsStatic } from 'sql.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// 0.15.2: the iPhone's price check saves what it finds in lots (one write and one refresh of the
// screens for every SAVE_EVERY products, not one for each), and one that was cut off carries on from
// where it got to, unless that was more than a day ago.

const searched: string[] = [];
let price = 2;
vi.mock('../stores', () => ({
  adapterFor: () => ({
    search: async (q: string) => {
      searched.push(q);
      const n = q.replace('Thing ', '');
      return [
        {
          storeProductId: 'sp' + n,
          price,
          isSpecial: false,
          memberOnly: false,
          imageUrl: 'https://img/' + n,
        },
      ];
    },
  }),
}));

const { addGroup, addProduct, ensureDefaults, initDb, readingsFor, getKV, putKV, updateSettings, snapshot } = await import('./db');
const { createSqlJsDriver } = await import('./sql/sqljs');
const { onChange } = await import('./live');
const { checkBySearch, unfinishedCheck, SAVE_EVERY } = await import('./check');
const { PROGRESS_KEY, carryOn, RESUME_FOR_MS } = await import('./checkProgress');

let SQL: SqlJsStatic;
beforeAll(async () => {
  SQL = await initSqlJs();
});

const COUNT = 45;
const ids = Array.from({ length: COUNT }, (_, i) => 'p' + i);
beforeEach(async () => {
  searched.length = 0;
  price = 2;
  await initDb(await createSqlJsDriver({ load: async () => SQL }));
  await ensureDefaults();
  await updateSettings({ enabledChains: ['coles'] } as never);
  for (const [i, id] of ids.entries()) {
    await addProduct({
      id,
      chain: 'coles',
      name: 'Thing ' + i,
      storeProductId: 'sp' + i,
      createdAt: '',
    } as never);
    await addGroup({
      id: 'g' + i,
      name: 'Thing ' + i,
      usualProductId: id,
      sameProductIds: [],
      altProductIds: [],
      alertLevel: 'good',
      createdAt: '',
    });
  }
});
afterEach(() => vi.useRealTimers());

const saved = async () => [...(await readingsFor(ids)).values()].reduce((n, r) => n + r.length, 0);

describe("the iPhone's price check", () => {
  it('saves in lots, so the screens re-read a few times rather than once a product', async () => {
    let refreshes = 0;
    const stop = onChange(() => refreshes++);
    const r = await checkBySearch();
    stop();
    expect(r).toMatchObject({ checked: COUNT, updated: COUNT });
    expect(await saved()).toBe(COUNT);
    expect(refreshes).toBeLessThanOrEqual(Math.ceil(COUNT / SAVE_EVERY) + 1);
    // Photos came in the same writes.
    expect((await snapshot()).products.filter((p) => p.imageUrl).length).toBe(COUNT);
    // Finished: nothing to carry on with.
    expect(await unfinishedCheck()).toBe(false);
  });

  it('carries on from where a check that was cut off got to', async () => {
    let steps: number[] = [];
    await expect(
      checkBySearch((done) => {
        steps.push(done);
        if (done === 30) throw new Error('cut off');
      }),
    ).rejects.toThrow('cut off');
    // What it found before it was cut off is saved, with how far it got.
    expect(await saved()).toBe(30);
    expect(await unfinishedCheck()).toBe(true);
    expect((await getKV<{ done: string[] }>(PROGRESS_KEY))!.done).toHaveLength(30);

    searched.length = 0;
    steps = [];
    const r = await checkBySearch((done) => steps.push(done));
    // Only the 15 it hadn't got to, and the count carries on from 30 of 45.
    expect(searched).toHaveLength(COUNT - 30);
    expect(steps[0]).toBe(30);
    expect(steps.at(-1)).toBe(COUNT);
    expect(r.checked).toBe(COUNT - 30);
    expect(await saved()).toBe(COUNT);
    expect(await unfinishedCheck()).toBe(false);
  });

  it('starts again when the cut-off check is more than a day old', async () => {
    await putKV(PROGRESS_KEY, {
      started: new Date(Date.now() - RESUME_FOR_MS - 60_000).toISOString(),
      done: ids.slice(0, 40),
    });
    expect(await unfinishedCheck()).toBe(false);
    await checkBySearch();
    expect(searched).toHaveLength(COUNT);
  });

  it("doesn't put how far it got into a backup", async () => {
    await putKV(PROGRESS_KEY, {
      started: new Date().toISOString(),
      done: ['p1'],
    });
    expect((await snapshot()).kv.some((k) => k.key === PROGRESS_KEY)).toBe(false);
  });
});

describe('carryOn', () => {
  const now = Date.parse('2026-11-26T04:00:00.000Z');
  it('keeps what was done less than a day ago, and starts fresh otherwise', () => {
    expect(carryOn({ started: '2026-11-26T01:00:00.000Z', done: ['a'] }, now)).toEqual({ started: '2026-11-26T01:00:00.000Z', done: ['a'] });
    expect(carryOn({ started: '2026-11-25T03:00:00.000Z', done: ['a'] }, now).done).toEqual([]);
    expect(carryOn(undefined, now).done).toEqual([]);
    expect(carryOn(null as never, now).done).toEqual([]);
    // A start in the future (the clock was changed) or nonsense starts fresh too.
    expect(carryOn({ started: '2026-11-27T01:00:00.000Z', done: ['a'] }, now).done).toEqual([]);
    expect(carryOn({ started: 'soon', done: ['a'] }, now).done).toEqual([]);
  });
});
