// 0.9.6: a product with an unknown size sits out of the cheapest comparison (verdict.ts). The answers are shared with
// the Java side (Deals.java): tools/sync-test/deals-fixtures-096.json, checked there by DealsTest096.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Group, PriceReading, Product } from '../types';
import { recommend } from './verdict';

declare const process: { env: Record<string, string | undefined> };
process.env.TZ = 'Australia/Brisbane';

interface Case {
  name: string;
  products: { id: string; chain: Product['chain']; name: string; size?: string; price: number }[];
  main: string[];
  alts: string[];
  best: string;
  action: string;
}
const fx = JSON.parse(readFileSync('tools/sync-test/deals-fixtures-096.json', 'utf8')) as { now: string; cases: Case[] };
const NOW = Date.parse(fx.now);

describe('unknown size, shared vectors (0.9.6)', () => {
  for (const c of fx.cases) {
    it(c.name, () => {
      const products = new Map<string, Product>();
      const readings = new Map<string, PriceReading[]>();
      for (const p of c.products) {
        products.set(p.id, { id: p.id, chain: p.chain, name: p.name, size: p.size, createdAt: '' });
        readings.set(p.id, [{ productId: p.id, date: new Date(NOW).toISOString(), price: p.price, isSpecial: false, memberOnly: false, source: 'auto' }]);
      }
      const group: Group = { id: 'g', name: 'Thing', usualProductId: c.main[0], sameProductIds: c.main.slice(1), altProductIds: c.alts, alertLevel: 'any', createdAt: '' };
      const rec = recommend(group, products, readings, new Set(), NOW);
      expect(rec.best?.product.id).toBe(c.best);
      expect(rec.action).toBe(c.action);
    });
  }
});
