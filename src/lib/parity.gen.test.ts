// Writes random cases for the Java parity check of Deals.java (run with PARITY_OUT=/path/file.json).
// Skipped in the normal test run.
import { describe, it } from 'vitest';
import type { Group, PriceReading, Product } from '../types';
import { recommend, worthAlerting } from './verdict';

// Node-only globals, declared here so the app's browser type settings don't need Node types.
declare const process: { env: Record<string, string | undefined> };
const OUT = process.env.PARITY_OUT;
const NOW = Date.parse('2026-11-05T00:00:00Z');
const DAY = 86_400_000;

function rng(seed: number) {
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
}

describe.skipIf(!OUT)('parity cases', () => {
  it('writes cases', async () => {
    const rand = rng(42);
    const pick = <T>(a: T[]) => a[Math.floor(rand() * a.length)];
    const cases = [];
    for (let c = 0; c < 600; c++) {
      const n = 1 + Math.floor(rand() * 4);
      const products: Product[] = [];
      for (let i = 0; i < n; i++) {
        products.push({
          id: `p${i}`,
          chain: pick(['woolworths', 'coles', 'aldi'] as const),
          name: `Thing ${i}${pick(['', '', ' Cans Multipack 375ml', ' 24 Pack', ' 6 x 70g', ' 342g'])}`,
          size: pick(['500g', '1kg', '24 pack', '2L', undefined, '750ml', '30 Pack', '10 Pack', '375ml']),
          inStock: pick([true, false, undefined, undefined]),
          createdAt: '',
          market:
            rand() < 0.4
              ? {
                  normal: Math.round((2 + rand() * 10) * 100) / 100,
                  sale: rand() < 0.7 ? Math.round((1 + rand() * 6) * 100) / 100 : undefined,
                  saleShare: rand(),
                  low: Math.round((1 + rand() * 6) * 100) / 100,
                  cycleWeeks: rand() < 0.5 ? 1 + Math.floor(rand() * 8) : undefined,
                  days: pick([14, 30, 60, 182]),
                  latest: rand() < 0.7 ? Math.round((1 + rand() * 11) * 100) / 100 : undefined,
                  source: 'test',
                  updatedAt: '',
                }
              : undefined,
        });
      }
      const readings: PriceReading[] = [];
      for (const p of products) {
        const base = 2 + rand() * 10;
        const count = Math.floor(rand() * 12);
        for (let k = count; k >= 0; k--) {
          const special = rand() < 0.3;
          const member = special && rand() < 0.3;
          const price = Math.round((special ? base * (0.5 + rand() * 0.5) : base * (0.95 + rand() * 0.1)) * 100) / 100;
          readings.push({
            productId: p.id,
            date: new Date(NOW - k * (3 + Math.floor(rand() * 20)) * DAY - Math.floor(rand() * 5) * 3600_000).toISOString(),
            price,
            wasPrice: special && rand() < 0.8 ? Math.round(base * 100) / 100 : undefined,
            isSpecial: special,
            memberOnly: member,
            promo: rand() < 0.2 ? pick(['2 for $5', 'Any 3 for $10', 'Buy 2 for $7.50', '2 for $1.50', 'Half price', '2 x 150g']) : undefined,
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
        alertLevel: pick(['any', 'good', 'great', 'custom', 'never'] as const),
        alertPct: pick([10, 20, 30, 40, 50, undefined]),
        allowBulk: pick([true, false, false, undefined]),
        createdAt: '',
      };
      const cards = ['coles', 'woolworths'].filter(() => rand() < 0.5);
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
