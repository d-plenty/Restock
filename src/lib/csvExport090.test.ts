// 0.9.0: the spreadsheets give the day on the phone's own calendar, not UTC's. Pinned to Sydney time,
// where the UTC day starts at 10 or 11 am.
declare const process: { env: Record<string, string | undefined> };
process.env.TZ = 'Australia/Sydney';

import { describe, expect, it } from 'vitest';
import { csvFiles } from './csvExport';
import { localDay } from './verdict';

describe('CSV days', () => {
  // 8:30 am Monday 9 November in Sydney is still Sunday 8 November in UTC.
  const date = '2026-11-08T21:30:00.000Z';
  const snap = {
    products: [{ id: 'p', chain: 'coles', name: 'Milk', createdAt: date }],
    groups: [{ id: 'g', name: 'Milk', usualProductId: 'p', sameProductIds: [], altProductIds: [], alertLevel: 'good', createdAt: date }],
    prices: [{ productId: 'p', date, price: 3, isSpecial: false, memberOnly: false, source: 'auto' }],
    list: [{ id: 'e', text: 'Milk', groupId: 'g', checked: false, createdAt: date }],
    cards: [],
    categories: [],
    kv: [],
  } as never;

  it('uses the local day in every file', () => {
    const [pantry, list, prices] = csvFiles(snap).map((f) => f.text.split('\r\n')[1]);
    expect(pantry.endsWith(',2026-11-09')).toBe(true);
    expect(list.endsWith(',2026-11-09')).toBe(true);
    expect(prices.startsWith('2026-11-09,')).toBe(true);
  });

  it('keeps a plain date as it is', () => {
    expect(localDay('2026-11-08')).toBe('2026-11-08');
  });
});
