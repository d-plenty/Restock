import { describe, expect, it } from 'vitest';
import { shopsLeft, tripRecs } from './tripPlan';
import type { Recommendation } from './verdict';

const opt = (id: string, chain: string, role: 'main' | 'alt', price: number, inStock?: boolean) =>
  ({ product: { id, chain, name: id, inStock }, role, price }) as never;
const jam = (): Recommendation =>
  ({
    group: { id: 'jam', name: 'Jam', usualProductId: 'c', sameProductIds: ['w'], altProductIds: ['a'] },
    options: [opt('c', 'coles', 'main', 3.8), opt('w', 'woolworths', 'main', 4.2), opt('a', 'aldi', 'alt', 3.39)],
  }) as never;
const at = (t: ReturnType<typeof tripRecs>) => t.recs[0].options.map((o) => `${o.product.chain}:${o.role}`).sort();

describe('0.12.7: what a trip offers at the shops still to visit', () => {
  it('all three shops: your picks only, the alternative stays out', () => {
    const t = tripRecs([jam()], ['coles', 'woolworths', 'aldi']);
    expect(at(t)).toEqual(['aldi:alt', 'coles:main', 'woolworths:main']);
    expect(t.alternatives.size).toBe(0);
  });
  it('Aldi first with Coles and Woolworths still to come: no alternative', () => {
    expect(tripRecs([jam()], ['aldi', 'coles', 'woolworths'], []).alternatives.size).toBe(0);
  });
  it('Coles finished without ticking it: Woolworths is next (Coles is no longer offered)', () => {
    const t = tripRecs([jam()], ['coles', 'woolworths', 'aldi'], ['coles']);
    expect(at(t)).toEqual(['aldi:alt', 'woolworths:main']);
    expect(t.alternatives.size).toBe(0);
  });
  it('Coles and Woolworths finished without ticking it: Aldi offers the alternative', () => {
    const t = tripRecs([jam()], ['coles', 'woolworths', 'aldi'], ['coles', 'woolworths']);
    expect(at(t)).toEqual(['aldi:main']);
    expect([...t.alternatives]).toEqual(['a']);
  });
  it('only going to Aldi today: the alternative straight away', () => {
    const t = tripRecs([jam()], ['aldi']);
    expect(at(t)).toEqual(['aldi:main']);
    expect(t.alternatives.has('a')).toBe(true);
  });
  it('your picks out of stock where you are going, and an alternative there in stock: it stands in', () => {
    const r = jam();
    r.options = [opt('c', 'coles', 'main', 3.8, false), opt('a', 'aldi', 'alt', 3.39, true)];
    const t = tripRecs([r], ['coles', 'aldi']);
    expect(t.alternatives.has('a')).toBe(true);
    // Stock not known (most people haven't set it up): your pick stands.
    r.options = [opt('c', 'coles', 'main', 3.8), opt('a', 'aldi', 'alt', 3.39)];
    expect(tripRecs([r], ['coles', 'aldi']).alternatives.size).toBe(0);
  });
  it('every shop finished: back to all of today\'s shops, so nothing vanishes', () => {
    expect(shopsLeft(['coles', 'aldi'], ['coles', 'aldi'])).toEqual(['coles', 'aldi']);
    expect(shopsLeft(['coles', 'aldi'], ['coles'])).toEqual(['aldi']);
  });
});
