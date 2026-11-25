// 0.12.0: the simpler look. The parts with logic of their own: the product picked for you at another
// shop, the one word a row says, the "Where do you shop?" flag, and which setup tiles show.
import { describe, expect, it } from 'vitest';
import type { StoreProduct } from '../stores';
import { DEFAULT_SETTINGS } from '../types';
import { mergeSettings } from './db';
import { closestTo } from './searchHelp';
import type { Recommendation } from './verdict';
import { recNote, shownOption } from '../ui/simple';
import { TILES, tilesFor } from '../ui/screens/Setup';

const sp = (chain: string, name: string, price: number, brand?: string): StoreProduct =>
  ({ chain, storeProductId: `${chain}-${name}`, name, brand, price, isSpecial: false, memberOnly: false }) as StoreProduct;

describe('closestTo: the pick made for you at a shop that does not sell the same product', () => {
  const anchor = sp('coles', 'Coles Diced Tomatoes 400g', 1.25, 'Coles');
  const plain = sp('aldi', 'Remano Diced Tomatoes 400g', 1.0, 'Remano');
  const basil = sp('aldi', 'Remano Diced Tomatoes With Basil 400g', 1.4, 'Remano');
  it('takes the closest name, not the closest price', () => {
    // likeThis puts the basil one first: $1.40 is nearer $1.25 than $1.00 is.
    expect(closestTo(anchor, [basil, plain])).toBe(plain);
  });
  it('keeps the order it was given on a tie', () => {
    const a = sp('aldi', 'Remano Diced Tomatoes 400g', 1.0, 'Remano');
    const b = sp('aldi', 'Remano Diced Tomatoes 800g', 1.8, 'Remano');
    expect(closestTo(anchor, [a, b])).toBe(a);
    expect(closestTo(anchor, [b, a])).toBe(b);
  });
  it('ignores each brand and the size numbers', () => {
    const other = sp('woolworths', 'Woolworths Tomatoes Diced 800g', 1.9, 'Woolworths');
    const wrong = sp('woolworths', 'Woolworths Tomato Paste 400g', 1.9, 'Woolworths');
    expect(closestTo(anchor, [wrong, other])).toBe(other);
  });
  it('has nothing to pick from nothing', () => {
    expect(closestTo(anchor, [])).toBeUndefined();
  });
});

describe('shopsAsked: a new phone is asked where it shops on its first search', () => {
  it('is kept as false or true, and stays unset on older phones and restores', () => {
    expect(mergeSettings({ ...DEFAULT_SETTINGS, shopsAsked: false }).shopsAsked).toBe(false);
    expect(mergeSettings({ ...DEFAULT_SETTINGS, shopsAsked: true }).shopsAsked).toBe(true);
    expect(mergeSettings({ ...DEFAULT_SETTINGS }).shopsAsked).toBeUndefined();
    expect(mergeSettings({ ...DEFAULT_SETTINGS, shopsAsked: 'no' as unknown as boolean }).shopsAsked).toBeUndefined();
  });
});

describe('recNote: the one word a row says about its price', () => {
  const rec = (over: Partial<Recommendation>): Recommendation =>
    ({ group: { id: 'g', name: 'Milk' }, options: [], action: 'none', headline: '', detail: '', byUnit: false, ...over }) as Recommendation;
  it('says nothing at the usual price', () => {
    expect(recNote(rec({}))).toBeUndefined();
  });
  it('names the deal', () => {
    expect(recNote(rec({ action: 'buy' }))?.text).toBe('On special');
    expect(recNote(rec({ action: 'buy', best: { verdict: { kind: 'great' } } as never }))?.text).toBe('Great deal');
    expect(recNote(rec({ action: 'alt' }))).toEqual({ text: 'Cheaper swap', tone: 'good' });
    expect(recNote(rec({ action: 'skip' }))).toEqual({ text: 'Not a real special', tone: 'warn' });
    expect(recNote(rec({ action: 'wait' }))?.tone).toBe('warn');
  });
  it('puts a product its shop no longer lists, or out of stock, before the deal', () => {
    expect(recNote(rec({ action: 'buy', shelf: { changed: [], gone: [{}] } as never }))?.text).toBe('No longer sold?');
    expect(recNote(rec({ action: 'buy', outOfStock: true }))?.text).toBe('Out of stock');
  });
  it('shows the swap for a cheaper swap, else your pick at its cheapest shop', () => {
    const best = { product: { chain: 'coles' } } as never;
    const alt = { product: { chain: 'aldi' } } as never;
    expect(shownOption(rec({ action: 'alt', best, alt }))).toBe(alt);
    expect(shownOption(rec({ action: 'buy', best, alt }))).toBe(best);
  });
});

describe('setup tiles: Bottle shop and Chemist only once they are switched on', () => {
  it('leaves them out on a new phone and shows them when on', () => {
    const off = tilesFor(DEFAULT_SETTINGS).map((t) => t.id);
    expect(off).not.toContain('keg');
    expect(off).not.toContain('pharmacy');
    expect(off).toContain('pantry');
    // 0.13.0: nor when one is on: they're tabs you make, counted on the Custom tabs tile
    const on = tilesFor({ ...DEFAULT_SETTINGS, sections: { keg: true, pharmacy: false } }).map((t) => t.id);
    expect(on).not.toContain('keg');
    expect(on).not.toContain('pharmacy');
    expect(on).toContain('custom');
    expect(TILES.map((t) => t.id)).toContain('pharmacy');
  });
});
