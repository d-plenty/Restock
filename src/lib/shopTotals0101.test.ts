import { describe, expect, it } from 'vitest';
import type { Group, ListEntry, PriceReading, Product } from '../types';
import { aroundPlan, shopTotals, storeMeasure, withElsewhere, type CompareBy } from './shopTotals';
import { recommend } from './verdict';

// 0.10.1: shopping around buys every item at its cheapest shop, so no one shop plus the rest from
// other shops can ever come to less, measured either way (same shopping, or at the till). In 0.10.0
// Aldi plus the rest came to $86.34 against shopping around's $87.41: shopping around picked by price
// per litre and then added up each shop's closest regular pack, which wasn't always the cheapest.

const NOW = Date.parse('2026-11-13T00:00:00Z');
const CHAINS = ['coles', 'woolworths', 'aldi'] as const;
const SIZES = ['400g', '500g', '1kg', '2kg', '800ml', '1L', '2L', '3 x 800ml', '6 x 400g', '10 pack', '24 pack'];

/** A small, repeatable random number maker, so a failure can be run again. */
function rng(seed: number) {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 4294967296;
  };
}

function randomList(seed: number) {
  const r = rng(seed);
  const pick = <T,>(a: readonly T[]) => a[Math.floor(r() * a.length)];
  const products: Product[] = [];
  const groups: Group[] = [];
  const readings = new Map<string, PriceReading[]>();
  const entries: ListEntry[] = [];
  const items = 2 + Math.floor(r() * 10);
  for (let i = 0; i < items; i++) {
    const ids: string[] = [];
    const n = 1 + Math.floor(r() * 5);
    const base = 1 + r() * 15;
    for (let k = 0; k < n; k++) {
      const id = `p${i}-${k}`;
      const size = pick(SIZES);
      products.push({ id, chain: pick(CHAINS), name: `Thing ${i} ${size}`, size, createdAt: '' });
      const price = Math.round(base * (0.4 + r() * 2.2) * 100) / 100;
      const promo = r() < 0.15 ? `2 for $${(price * 1.6).toFixed(2)}` : undefined;
      readings.set(id, [{ productId: id, date: new Date(NOW).toISOString(), price, isSpecial: !!promo || r() < 0.2, memberOnly: false, source: 'auto', promo }]);
      ids.push(id);
    }
    groups.push({
      id: `g${i}`,
      name: `Thing ${i}`,
      usualProductId: ids[0],
      sameProductIds: ids.slice(1),
      altProductIds: [],
      alertLevel: 'any',
      createdAt: '',
      ...(r() < 0.25 ? { anySize: true } : {}),
    } as Group);
    entries.push({ id: `e${i}`, text: `Thing ${i}`, groupId: `g${i}`, qty: 1 + Math.floor(r() * 3), checked: false, createdAt: '' });
  }
  if (r() < 0.4) entries.push({ id: 'oneoff', text: 'Birthday card', qty: 1, checked: false, createdAt: '', price: 4.5, chain: 'coles' } as ListEntry);
  const pm = new Map(products.map((p) => [p.id, p]));
  const recs = groups.map((g) => recommend(g, pm, readings, new Set(), NOW));
  return { entries, recs };
}

describe('shopping around is never dearer than one shop plus the rest (0.10.1)', () => {
  for (const by of ['unit', 'price'] as CompareBy[]) {
    it(`over 400 random lists, ${by === 'unit' ? 'same shopping' : 'at the till'}`, () => {
      for (let seed = 1; seed <= 400; seed++) {
        const { entries, recs } = randomList(seed);
        const t = shopTotals(entries, recs, [...CHAINS], by);
        const plan = aroundPlan(t, by, 0);
        for (const s of t.stores) {
          if (!s.lines.length || !s.missing.every((m) => m.elsewhere)) continue;
          const one = s.missing.length ? withElsewhere(s, by) : storeMeasure(s, by);
          if (plan.around > one + 0.01) throw new Error(`seed ${seed}: shopping around ${plan.around.toFixed(2)} > ${s.chain} with the rest ${one.toFixed(2)}`);
        }
      }
    });
  }

  it("uses each item's own shop line, so the numbers add up the same in the sheet", () => {
    for (let seed = 401; seed <= 600; seed++) {
      const { entries, recs } = randomList(seed);
      const t = shopTotals(entries, recs, [...CHAINS], 'unit');
      for (const l of t.around.lines) {
        const own = t.stores.find((s) => s.chain === l.pick.product.chain)!.lines.find((x) => x.groupId === l.groupId);
        expect(own).toBe(l);
      }
    }
  });

  it('only picks from the shops being compared', () => {
    for (let seed = 601; seed <= 700; seed++) {
      const { entries, recs } = randomList(seed);
      const t = shopTotals(entries, recs, ['coles', 'aldi'], 'unit');
      for (const l of t.around.lines) expect(['coles', 'aldi']).toContain(l.pick.product.chain);
      for (const s of t.stores) for (const m of s.missing) if (m.elsewhere) expect(['coles', 'aldi']).toContain(m.elsewhere.product.chain);
    }
  });
});

describe('the one store, when no shop has everything (0.10.1)', () => {
  const NOW2 = Date.parse('2026-11-13T00:00:00Z');
  const make = (rows: [string, 'coles' | 'woolworths' | 'aldi', number][], groupsOf: Record<string, string[]>) => {
    const products: Product[] = rows.map(([id, chain]) => ({ id, chain, name: `${id} 500g`, size: '500g', createdAt: '' }));
    const readings = new Map(rows.map(([id, , price]) => [id, [{ productId: id, date: new Date(NOW2).toISOString(), price, isSpecial: false, memberOnly: false, source: 'auto' as const }]]));
    const pm = new Map(products.map((p) => [p.id, p]));
    const groups: Group[] = Object.entries(groupsOf).map(([id, ids]) => ({ id, name: id, usualProductId: ids[0], sameProductIds: ids.slice(1), altProductIds: [], alertLevel: 'any', createdAt: '' }));
    const recs = groups.map((g) => recommend(g, pm, readings, new Set(), NOW2));
    const entries: ListEntry[] = groups.map((g) => ({ id: g.id, text: g.id, groupId: g.id, qty: 1, checked: false, createdAt: '' }));
    return { recs, entries };
  };

  it('compares shops missing the same number with the rest bought elsewhere', async () => {
    const { recommendedStores } = await import('./shopTotals');
    // 20 items, so 2 missing still counts as one shop. Coles lacks a and b, Woolworths lacks c and d.
    const rows: [string, 'coles' | 'woolworths' | 'aldi', number][] = [];
    const groupsOf: Record<string, string[]> = {};
    for (let i = 0; i < 20; i++) {
      const id = `x${i}`;
      groupsOf[id] = [];
      if (!['x0', 'x1'].includes(id)) (rows.push([`c${i}`, 'coles', 2]), groupsOf[id].push(`c${i}`));
      if (!['x2', 'x3'].includes(id)) (rows.push([`w${i}`, 'woolworths', 2]), groupsOf[id].push(`w${i}`));
    }
    // Coles has x2 and x3 at $5 (its own 18: $42), Woolworths x0 and x1 at $10 (its own 18: $52).
    rows.find((r) => r[0] === 'c2')![2] = 5;
    rows.find((r) => r[0] === 'c3')![2] = 5;
    rows.find((r) => r[0] === 'w0')![2] = 10;
    rows.find((r) => r[0] === 'w1')![2] = 10;
    // Aldi has x2 and x3 for $1, and x0 and x1 for $30.
    rows.push(['a0', 'aldi', 30], ['a1', 'aldi', 30], ['a2', 'aldi', 1], ['a3', 'aldi', 1]);
    for (const i of [0, 1, 2, 3]) groupsOf[`x${i}`].push(`a${i}`);
    const { recs, entries } = make(rows, groupsOf);
    const t = shopTotals(entries, recs, ['coles', 'woolworths', 'aldi'], 'price');
    const coles = t.stores.find((s) => s.chain === 'coles')!;
    const ww = t.stores.find((s) => s.chain === 'woolworths')!;
    expect(coles.total).toBeCloseTo(42);
    expect(ww.total).toBeCloseTo(52);
    // With the rest: Coles $42 + $20 = $62, Woolworths $52 + $2 = $54.
    expect(withElsewhere(coles, 'price')).toBeCloseTo(62);
    expect(withElsewhere(ww, 'price')).toBeCloseTo(54);
    expect(recommendedStores(t, 'price').recommended?.chain).toBe('woolworths');
  });

  it("doesn't call a shop missing more than a few the best one store", async () => {
    const { recommendedStores } = await import('./shopTotals');
    const { recs, entries } = make(
      [
        ['c1', 'coles', 1],
        ['w2', 'woolworths', 1],
        ['a3', 'aldi', 1],
        ['c4', 'coles', 1],
        ['w5', 'woolworths', 1],
        ['a6', 'aldi', 1],
      ],
      { g1: ['c1'], g2: ['w2'], g3: ['a3'], g4: ['c4'], g5: ['w5'], g6: ['a6'] },
    );
    const t = shopTotals(entries, recs, ['coles', 'woolworths', 'aldi'], 'unit');
    expect(t.stores.every((s) => s.missing.length === 4)).toBe(true);
    expect(recommendedStores(t, 'unit').recommended).toBeUndefined();
    expect(aroundPlan(t, 'unit', 1).pick).toBe('around');
  });
});
