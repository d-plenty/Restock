// 0.9.0: extra random cases for the Java parity check of Deals.java (run with PARITY_EXTRA_OUT=/path/file.json,
// in the same format as parity.gen.test.ts). These lean on what 0.9.0 changed: newest prices from either
// side of Wednesday midnight or weeks old, member prices with and without a "was" price (and not marked
// as specials), and multi-buys like "112 for $5". Skipped in the normal test run.
import { describe, it } from 'vitest';
import type { Group, PriceReading, Product } from '../types';
import { recommend, worthAlerting } from './verdict';

declare const process: { env: Record<string, string | undefined> };
const OUT = process.env.PARITY_EXTRA_OUT;
// 1 am on a Wednesday in Queensland: the specials week started an hour ago.
const NOW = Date.parse('2026-11-11T01:00:00+10:00');
const DAY = 86_400_000;
const HOUR = 3_600_000;

function rng(seed: number) {
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
}

describe.skipIf(!OUT)('parity cases (0.9.0 extras)', () => {
  it('writes cases', async () => {
    const rand = rng(90);
    const pick = <T>(a: T[]) => a[Math.floor(rand() * a.length)];
    const cases = [];
    for (let c = 0; c < 800; c++) {
      const n = 1 + Math.floor(rand() * 4);
      const products: Product[] = [];
      for (let i = 0; i < n; i++) {
        products.push({
          id: `p${i}`,
          chain: pick(['woolworths', 'coles', 'aldi', 'bws'] as const),
          name: `Thing ${i}${pick(['', ' 24 Pack', ' 6 x 70g', ' .5kg'])}`,
          size: pick(['500g', '1kg', '.5kg', '24 pack', undefined, '375ml']),
          createdAt: '',
        });
      }
      const readings: PriceReading[] = [];
      for (const p of products) {
        const base = 2 + rand() * 10;
        const count = Math.floor(rand() * 10);
        // The newest price: an hour or two either side of Wednesday midnight, a few days, or weeks old.
        const newest = pick([0.5, 2, 30, 50, 3 * 24, 6 * 24, 13 * 24, 15 * 24, 25 * 24]) * HOUR * (0.8 + rand() * 0.4);
        for (let k = count; k >= 0; k--) {
          const special = rand() < 0.35;
          const member = rand() < (special ? 0.35 : 0.1);
          const price = Math.round((special || member ? base * (0.5 + rand() * 0.5) : base * (0.95 + rand() * 0.1)) * 100) / 100;
          readings.push({
            productId: p.id,
            date: new Date(NOW - newest - k * (3 + Math.floor(rand() * 15)) * DAY).toISOString(),
            price,
            wasPrice: (special || member) && rand() < 0.6 ? Math.round(base * 100) / 100 : undefined,
            isSpecial: special,
            memberOnly: member,
            promo: rand() < 0.25 ? pick(['2 for $5', '112 for $5', 'Any 3 for $10', '2 for $1.50', 'Buy 2 for $7.50']) : undefined,
            source: 'auto',
          });
        }
      }
      const ids = products.map((p) => p.id);
      const mainCount = 1 + Math.floor(rand() * ids.length);
      const group: Group = {
        id: `g${c}`,
        name: `Group ${c}`,
        usualProductId: ids[0],
        sameProductIds: ids.slice(1, mainCount),
        altProductIds: ids.slice(mainCount),
        alertLevel: pick(['any', 'good', 'great', 'custom'] as const),
        alertPct: pick([10, 20, 30, undefined]),
        createdAt: '',
      };
      const cards = ['coles', 'woolworths', 'bws'].filter(() => rand() < 0.5);
      const byProduct = new Map<string, PriceReading[]>();
      for (const r of readings) byProduct.set(r.productId, [...(byProduct.get(r.productId) ?? []), r]);
      const rec = recommend(group, new Map(products.map((p) => [p.id, p])), byProduct, new Set(cards as never), NOW);
      cases.push({
        group,
        products,
        readings,
        cards,
        expect: {
          action: rec.action,
          best: rec.best?.product.id ?? null,
          kind: rec.best?.verdict.kind ?? null,
          alt: rec.alt?.product.id ?? null,
          alert: worthAlerting(rec),
          outOfStock: !!rec.outOfStock,
          stockAlt: rec.stockAlt?.product.id ?? null,
        },
      });
    }
    const fs = 'node:fs';
    const { writeFileSync } = (await import(/* @vite-ignore */ fs)) as { writeFileSync: (p: string, d: string) => void };
    writeFileSync(OUT!, JSON.stringify({ now: NOW, cases }));
  });
});
