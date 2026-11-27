import initSqlJs, { type SqlJsStatic } from 'sql.js';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// 0.15.2: price checks on iPhone and iPad when Restock isn't on screen (backgroundCheck.ts).

vi.mock('@capacitor/core', async (orig) => {
  const real = await orig<typeof import('@capacitor/core')>();
  return { ...real, Capacitor: { ...real.Capacitor, isNativePlatform: () => true, getPlatform: () => 'ios', isPluginAvailable: () => true } };
});
const searched: string[] = [];
vi.mock('../stores', () => ({
  adapterFor: () => ({
    search: async (q: string) => {
      searched.push(q);
      return [{ storeProductId: 'sp' + q.replace('Thing ', ''), price: 3, isSpecial: false, memberOnly: false }];
    },
  }),
}));

const calls: [string, unknown][] = [];
let expensive = false;
(globalThis as { __restockAppleFake?: unknown }).__restockAppleFake = {
  netInfo: async () => ({ online: true, expensive }),
  backgroundSchedule: async (o: unknown) => void calls.push(['schedule', o]),
  checkTaskStart: async (o: unknown) => (calls.push(['start', o]), { started: true }),
  checkTaskProgress: async (o: unknown) => void calls.push(['progress', o]),
  checkTaskEnd: async (o: unknown) => void calls.push(['end', o]),
};

const db = await import('../lib/db');
const { createSqlJsDriver } = await import('../lib/sql/sqljs');
const bg = await import('./backgroundCheck');
const { checkPrices } = await import('../lib/check');

let SQL: SqlJsStatic;
beforeAll(async () => {
  SQL = await initSqlJs();
});
const COUNT = 30;
beforeEach(async () => {
  searched.length = 0;
  calls.length = 0;
  expensive = false;
  await db.initDb(await createSqlJsDriver({ load: async () => SQL }));
  await db.ensureDefaults();
  await db.updateSettings({ enabledChains: ['coles'], checkDays: [0, 1, 2, 3, 4, 5, 6], checkTime: '04:00' } as never);
  for (let i = 0; i < COUNT; i++) {
    await db.addProduct({ id: 'p' + i, chain: 'coles', name: 'Thing ' + i, storeProductId: 'sp' + i, createdAt: '' } as never);
    await db.addGroup({ id: 'g' + i, name: 'Thing ' + i, usualProductId: 'p' + i, sameProductIds: [], altProductIds: [], alertLevel: 'good', createdAt: '' });
  }
});

describe('when a background check is owed', () => {
  it('the longer run: once the set time has passed with no check since; the short one: as when Restock opens', async () => {
    const s = await db.getSettings();
    const now = Date.now();
    expect(await bg.checkOwed({ ...s, lastCheck: undefined }, 'long', now)).toBe(true);
    expect(await bg.checkOwed({ ...s, lastCheck: new Date(now).toISOString() }, 'long', now)).toBe(false);
    expect(await bg.checkOwed({ ...s, lastCheck: new Date(now - 2 * 86_400_000).toISOString() }, 'long', now)).toBe(true);
    // 0.18.2: the short run goes by the same rule (once per set time).
    expect(await bg.checkOwed({ ...s, lastCheck: new Date(now).toISOString() }, 'refresh', now)).toBe(false);
    expect(await bg.checkOwed({ ...s, lastCheck: new Date(now - 25 * 3_600_000).toISOString() }, 'refresh', now)).toBe(true);
    // Automatic checks off (or Check now only): never.
    expect(await bg.checkOwed({ ...s, lastCheck: undefined, checkDays: [] }, 'long', now)).toBe(false);
    expect(await bg.checkOwed({ ...s, lastCheck: undefined, sync: { ...s.sync, backgroundActivity: false } }, 'refresh', now)).toBe(false);
  });

  it('iOS is asked for the longer run at the next set time, and for none with checks off', async () => {
    const s = await db.getSettings();
    const at = bg.nextLongRun(s)!;
    expect(at).toBeGreaterThan(Date.now());
    expect(new Date(at).getHours()).toBe(4);
    expect(bg.nextLongRun({ ...s, checkDays: [] })).toBeUndefined();
    await bg.scheduleNext();
    expect(calls[0]).toEqual(['schedule', { checkAt: at }]);
  });
});

describe('a check in the background', () => {
  it('stops when its time is up, and the next one carries on', async () => {
    let n = 0;
    // Time's up after 12 products.
    const r = await checkPrices(() => n++, { until: Date.now() + 60_000, stop: () => searched.length >= 12 });
    expect(r.complete).toBe(false);
    expect(searched).toHaveLength(12);
    // Not finished, so it isn't the last check yet.
    expect((await db.getSettings()).lastCheck).toBeUndefined();
    searched.length = 0;
    expect(await bg.runInBackground('refresh', Date.now() + 60_000)).toBe(true);
    expect(searched).toHaveLength(COUNT - 12);
    expect((await db.getSettings()).lastCheck).toBeTruthy();
  });

  it("the longer run waits for Wi-Fi (not mobile data)", async () => {
    expensive = true;
    expect(await bg.runInBackground('long', Date.now() + 60_000)).toBe(false);
    expect(searched).toHaveLength(0);
  });

  it('a Check now asks iOS to keep it going, shows its progress, and says when it ends', async () => {
    const r = await checkPrices(undefined, { byHand: true });
    expect(r.complete).toBe(true);
    expect(calls[0][0]).toBe('start');
    expect(calls.filter((c) => c[0] === 'progress').at(-1)![1]).toEqual({ done: COUNT, total: COUNT });
    expect(calls.at(-1)).toEqual(['end', { ok: true }]);
  });
});

describe('deal alerts after a background check', () => {
  it('a price counts from the day it first showed', () => {
    const rs = [
      { date: '2026-11-20T01:00:00.000Z', price: 4 },
      { date: '2026-11-21T01:00:00.000Z', price: 3 },
      { date: '2026-11-22T01:00:00.000Z', price: 3 },
    ];
    expect(bg.priceSince(rs, rs[2])).toBe(bg.priceSince([], rs[1]));
    expect(bg.priceSince(rs, rs[0])).toBe(bg.priceSince([], rs[0]));
  });
});
