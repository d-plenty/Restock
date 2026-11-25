// The iPhone's shared-history summary against Android's Deals.summarise. Driven by market-parity.sh.
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { summarise } from '../../src/ios/market';

const java = JSON.parse(readFileSync(process.env.MARKET_JAVA ?? 'tools/sync-test/out/market-java.json', 'utf8')) as {
  now: number;
  cases: { window: number; dates: string[]; prices: number[]; m: Record<string, number | null> | null }[];
};

it('summarises 600 price histories exactly as Android does', () => {
  expect(java.cases.length).toBe(600);
  let summarised = 0;
  let withSale = 0;
  for (const [i, c] of java.cases.entries()) {
    const m = summarise(c.dates, c.prices, java.now, c.window);
    const mine = m ? { normal: m.normal, sale: m.sale ?? null, saleShare: m.saleShare, low: m.low, cycleWeeks: m.cycleWeeks ?? null, days: m.days, latest: m.latest ?? null } : null;
    expect(mine, `history ${i}`).toEqual(c.m);
    if (m) summarised++;
    if (m?.sale !== undefined) withSale++;
  }
  // The made-up histories do exercise the summary: most have enough history, and plenty have specials.
  expect(summarised).toBeGreaterThan(300);
  expect(withSale).toBeGreaterThan(100);
});
