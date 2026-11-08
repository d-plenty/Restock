// "One reading per day" goes by the phone's own calendar, not UTC's. Pinned to Queensland time,
// where the UTC day runs 10am to 10am.
declare const process: { env: Record<string, string | undefined> };
process.env.TZ = 'Australia/Brisbane';

import { describe, expect, it } from 'vitest';
import type { PriceReading } from '../types';
import { localDay, normaliseReadings } from './verdict';

const reading = (date: string, price: number, isSpecial = false): PriceReading => ({
  productId: 'p1',
  date,
  price,
  isSpecial,
  memberOnly: false,
  source: 'auto',
});

describe('local calendar days', () => {
  it('runs in Queensland time', () => {
    expect(new Date('2026-11-05T22:00:00.000Z').getHours()).toBe(8);
  });

  it('gives the day where the phone is, in the same yyyy-mm-dd form', () => {
    expect(localDay('2026-11-05T09:00:00.000Z')).toBe('2026-11-05'); // 7pm Thursday
    expect(localDay('2026-11-05T22:00:00.000Z')).toBe('2026-11-06'); // 8am Friday
    expect(localDay('2026-11-05')).toBe('2026-11-05');
  });

  it("keeps an evening's normal price and the next morning's sale as two days", () => {
    const out = normaliseReadings(
      [reading('2026-11-05T09:00:00.000Z', 5), reading('2026-11-05T22:00:00.000Z', 3, true)],
      Date.parse('2026-11-06T00:00:00Z'),
    );
    expect(out.map((r) => r.price)).toEqual([5, 3]);
  });

  it('counts 1am and 7pm on the same local day as one day', () => {
    const out = normaliseReadings(
      [reading('2026-11-04T15:00:00.000Z', 5), reading('2026-11-05T09:00:00.000Z', 4)],
      Date.parse('2026-11-06T00:00:00Z'),
    );
    expect(out.map((r) => r.price)).toEqual([4]);
  });
});
