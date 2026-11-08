import { describe, expect, it } from 'vitest';
import { brandKind } from '../lib/brandKinds';
import { intendedKind, scoreAll, topPicks, weakShops } from '../lib/searchHelp';
import fixtures from './fixtures-search-real.json';
import type { StoreProduct } from './types';

const real = fixtures as unknown as Record<string, StoreProduct[]>;
const aldi = (name: string, i: number): StoreProduct => ({
  chain: 'aldi',
  storeProductId: `a${i}`,
  name,
  price: 5,
  isSpecial: false,
  memberOnly: false,
});

// What Aldi really sent back for "western star" (it doesn't sell Western Star): anything with "star".
const ALDI_STARS = [
  'Chocolate Drizzle Stars 150g',
  '4 Star Grass Fed Beef Mince 500g',
  '2 Star Beef Mince 500g',
  '3 Star Beef Mince per kg',
].map(aldi);

describe('a brand one shop does not sell', () => {
  const q = { text: 'western star' };
  const byChain = {
    woolworths: scoreAll(q, real['woolworths|western star butter']),
    aldi: scoreAll(q, ALDI_STARS),
  };

  it('sees that Aldi has nothing like it', () => {
    expect(weakShops(byChain)).toEqual(['aldi']);
    expect(topPicks(byChain.aldi)).toEqual([]);
    expect(topPicks(byChain.woolworths).length).toBeGreaterThan(0);
  });

  it('works out from Woolworths that it means butter', () => {
    expect(intendedKind(q, byChain)).toBe('butter');
  });

  it('knows the brand even when no shop has it', () => {
    expect(intendedKind(q, { aldi: byChain.aldi })).toBe('butter');
    expect(brandKind('panadol rapid')).toBe('paracetamol');
    expect(brandKind('great northern super crisp')).toBe('lager');
    expect(brandKind('smiths')).toBe('chips');
    expect(brandKind('star')).toBeUndefined();
    expect(brandKind("smith's chips")).toBe('chips');
  });

  it('knows what a brand that names the thing is', () => {
    expect(intendedKind({ text: 'panadol' }, { priceline: [] })).toBe('paracetamol');
    expect(intendedKind({ text: 'milo' }, { aldi: [] })).toBe('drinking chocolate');
  });

  it('searches the kind you typed, when you typed one', () => {
    expect(intendedKind({ text: 'western star butter' }, { aldi: [] })).toBe('butter');
    expect(intendedKind({ text: 'butter' }, { aldi: [] })).toBeUndefined();
  });

  it("doesn't count a partly matching name as the brand at a bottle shop", () => {
    const bws = scoreAll({ text: 'great northern' }, real['bws|great northern'] ?? []);
    if (bws.length) expect(bws[0].s).toBeGreaterThan(0.85);
  });
});
