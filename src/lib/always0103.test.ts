import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { computeStats, judge, verdictLabel } from './verdict';
import type { PriceReading } from '../types';

// 0.10.3: Always on special, against the answers Deals.java checks too (tools/sync-test/always-parity.sh).
const f = JSON.parse(readFileSync('tools/sync-test/always-fixtures-0103.json', 'utf8')) as {
  now: string;
  cases: { name: string; series: [number, number, number | null, boolean][]; kind: string; always: number }[];
};
const now = Date.parse(f.now);
const DAY = 86_400_000;

describe('Always on special (0.10.3)', () => {
  for (const c of f.cases)
    it(c.name, () => {
      const readings: PriceReading[] = c.series.map(([d, price, was, special]) => ({
        productId: 'p',
        date: new Date(now - d * DAY).toISOString(),
        price,
        ...(was !== null ? { wasPrice: was } : {}),
        isSpecial: special,
        memberOnly: false,
        source: 'auto',
      }));
      const stats = computeStats(readings, now);
      expect(stats.always?.days ?? 0).toBe(c.always);
      const v = judge(stats);
      expect(v.kind).toBe(c.kind);
      if (c.kind === 'fake' && c.always) {
        expect(verdictLabel(v)).toBe('ALWAYS ON SPECIAL');
        expect(v.detail).toContain(`On special ${c.always} of the last 21 days`);
      }
    });
});
