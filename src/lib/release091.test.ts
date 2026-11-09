import initSqlJs from 'sql.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, HISTORY_WEEKS, historyLabel } from '../types';
import { addProduct, addReading, ensureDefaults, initDb, priceHistorySpan, pruneHistory, readingsFor } from './db';
import { checkSettings } from './settingsCheck';
import { createSqlJsDriver } from './sql/sqljs';
import { computeStats, HISTORY_DAYS, normaliseReadings } from './verdict';
import { pricesIn } from '../ui/screens/BackupParts';
import { OTHER_SIZES_HELP } from '../ui/OtherSizes';
import type { PriceReading } from '../types';

// 0.9.1: 12 months of prices, the "Other sizes" switch setting, and backups saying what's in them.

beforeEach(async () => {
  const driver = await createSqlJsDriver({ load: () => initSqlJs() });
  await initDb(driver);
  await ensureDefaults();
});

const DAY = 86_400_000;
const now = Date.parse('2026-11-09T00:00:00Z');

describe('12 months of price history', () => {
  it('is one of the choices, called 12 months', () => {
    expect(HISTORY_WEEKS).toEqual([4, 8, 13, 26, 52]);
    expect(historyLabel(52)).toBe('12 months');
    expect(HISTORY_WEEKS.map(historyLabel)).toEqual(['1 month', '8 weeks', '3 months', '6 months', '12 months']);
  });
  it('survives settings checks, from this phone, a backup or another phone', () => {
    expect(checkSettings({ historyWeeks: 52 }).historyWeeks).toBe(52);
    expect(checkSettings({ historyWeeks: 52 }, { strict: true }).historyWeeks).toBe(52);
    expect(checkSettings({ historyWeeks: 53 }).historyWeeks).toBe(8);
  });
  it('keeps a year of prices, and drops older ones', async () => {
    await addProduct({ id: 'p1', chain: 'coles', name: 'Solo 30 pack', createdAt: new Date(now - 500 * DAY).toISOString() });
    const add = (daysAgo: number, price: number) =>
      addReading({ productId: 'p1', date: new Date(now - daysAgo * DAY).toISOString(), price, isSpecial: false, memberOnly: false, source: 'auto' });
    await add(400, 30);
    await add(300, 31);
    await add(200, 32);
    await add(1, 33);
    expect(await pruneHistory(52, now)).toBe(1);
    expect((await readingsFor(['p1'])).get('p1')!.map((r) => r.price)).toEqual([31, 32, 33]);
    // Going back down to 6 months drops the ones over 26 weeks old.
    expect(await pruneHistory(26, now)).toBe(2);
  });
  it('an item page showing 12 months looks back that far; verdicts still look back 6 months', () => {
    const r = (daysAgo: number, price: number): PriceReading => ({
      productId: 'p',
      date: new Date(now - daysAgo * DAY).toISOString(),
      price,
      isSpecial: false,
      memberOnly: false,
      source: 'auto',
    });
    const year = [r(330, 2), r(250, 5), r(100, 5), r(10, 5), r(1, 5)];
    expect(normaliseReadings(year, now)).toHaveLength(3);
    expect(normaliseReadings(year, now, 52 * 7 + 1)).toHaveLength(5);
    expect(computeStats(year, now).low).toBe(5);
    expect(computeStats(year, now, true, 52 * 7 + 1).low).toBe(2);
    expect(HISTORY_DAYS).toBe(183);
  });
});

describe('the other container sizes switch', () => {
  it('is off unless turned on, and only ever on or off', () => {
    expect(DEFAULT_SETTINGS.otherContainerSizes).toBe(false);
    expect(checkSettings({}).otherContainerSizes).toBe(false);
    expect(checkSettings({ otherContainerSizes: true }).otherContainerSizes).toBe(true);
    expect(checkSettings({ otherContainerSizes: 'yes' }).otherContainerSizes).toBe(false);
  });
  it('says exactly how sizes are compared', () => {
    expect(OTHER_SIZES_HELP).toBe(
      "Same size, other packs compares the exact can or bottle you buy in bigger or smaller packs. Turn on other container sizes if you'd also buy a different can or bottle size, like 1.25L bottles instead of cans. Everything is compared on price per litre or per 100g.",
    );
  });
});

describe('backups say what is in them', () => {
  it('counts the prices kept, and the oldest, not counting sample items', async () => {
    expect(await priceHistorySpan()).toEqual({ count: 0, oldest: undefined });
    await addProduct({ id: 'p1', chain: 'coles', name: 'Nutella 400g', createdAt: '2026-01-01T00:00:00Z' });
    await addReading({ productId: 'p1', date: '2026-05-03T01:00:00.000Z', price: 6.7, isSpecial: false, memberOnly: false, source: 'auto' });
    await addReading({ productId: 'p1', date: '2026-11-01T01:00:00.000Z', price: 6.2, isSpecial: false, memberOnly: false, source: 'auto' });
    await addReading({ productId: 'p1', date: '2025-01-01T01:00:00.000Z', price: 5, isSpecial: false, memberOnly: false, source: 'demo' });
    expect(await priceHistorySpan()).toEqual({ count: 2, oldest: '2026-05-03T01:00:00.000Z' });
  });
  it('says it plainly', () => {
    expect(pricesIn({ historyWeeks: 26 }, { count: 2, oldest: '2026-05-03T01:00:00.000Z' })).toBe(
      'Includes all the prices on this phone, back to 3 May 2026 (you keep 6 months).',
    );
    expect(pricesIn({ historyWeeks: 52 }, { count: 0 })).toBe('Includes all the prices on this phone (you keep 12 months).');
    expect(pricesIn({ historyWeeks: 8 })).toBe('Includes all the prices on this phone (you keep 8 weeks).');
  });
});
