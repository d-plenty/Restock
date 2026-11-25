// 0.11.3: a pack that changed size under the same product number, and a product a shop no longer lists.
import { describe, expect, it } from 'vitest';
import { changeWords, dearerPct, missToSay, missWords, replacementLine, replacementTerm, shelfNotes, sizeChangeOf, type Miss } from './shelfWatch';

describe('a pack that changed size (0.11.3)', () => {
  it('500 g to 450 g is a smaller pack, 11% more per 100 g at the same price', () => {
    const c = sizeChangeOf({ name: 'Nestle Milo 500g', size: '500g' }, { size: '450g', name: 'Nestle Milo 450g' }, '2026-11-16', 9.5)!;
    expect(c).toMatchObject({ from: '500g', to: '450g', fromQty: 500, toQty: 450, unit: 'g' });
    expect(dearerPct(c)).toBe(11);
    const w = changeWords('woolworths', c);
    expect(w.smaller).toBe(true);
    expect(w.title).toBe('Smaller pack');
    expect(w.text).toContain('Woolworths changed this from 500g to 450g (noticed 16 Nov)');
    expect(w.text).toContain("At the same price that's 11% more per 100 g.");
  });
  it('the shop still only gives the old name: the size field alone shows it', () => {
    expect(sizeChangeOf({ name: 'Nestle Milo 500g', size: '500g' }, { size: '450g' }, '2026-11-16')).toMatchObject({ fromQty: 500, toQty: 450 });
  });
  it('the same amount written another way is not a change', () => {
    expect(sizeChangeOf({ name: 'Milo 500g', size: '500g' }, { size: '500 G' }, 'd')).toBeUndefined();
    expect(sizeChangeOf({ name: 'Milo 500g', size: '500g' }, { size: '0.5 kg' }, 'd')).toBeUndefined();
    expect(sizeChangeOf({ name: 'Nivea Deodorant 120g', size: '120g' }, { size: '0.121 kg' }, 'd')).toBeUndefined();
    expect(sizeChangeOf({ name: 'Cola 1.25L', size: '1.25L' }, { size: '1250mL' }, 'd')).toBeUndefined();
  });
  it('an amount you typed in yourself is never changed by the shop', () => {
    expect(sizeChangeOf({ name: 'Deodorant 120g', size: '120g', qty: 200, qtyUnit: 'ml' }, { size: '100g' }, 'd')).toBeUndefined();
  });
  it('grams to millilitres, or a size that can\'t be read, says nothing', () => {
    expect(sizeChangeOf({ name: 'Sauce 500g', size: '500g' }, { size: '500mL' }, 'd')).toBeUndefined();
    expect(sizeChangeOf({ name: 'Thing', size: undefined }, { size: '450g' }, 'd')).toBeUndefined();
  });
  it('a bigger pack is said as one, and litres read per litre', () => {
    const c = sizeChangeOf({ name: 'Cola 1.25L', size: '1.25L' }, { size: '1.5L', name: 'Cola 1.5L' }, '2026-11-16')!;
    const w = changeWords('coles', c);
    expect(w.title).toBe('Bigger pack');
    expect(w.text).toContain('17% less per litre');
  });
  it('with both prices, the price change counts too', () => {
    expect(dearerPct({ fromQty: 500, toQty: 450 }, 10, 9)).toBe(0);
    expect(dearerPct({ fromQty: 500, toQty: 450 }, 10, 10)).toBe(11);
    expect(dearerPct({ fromQty: 500, toQty: 450 }, 10, 11)).toBe(22);
  });
});

describe('no longer sold (0.11.3)', () => {
  const miss = (why: Miss['why'], n: number, more: Partial<Miss> = {}): Miss => ({ since: '2026-11-02', last: '2026-11-12', n, why, ...more });
  it('one "not found" is never enough', () => {
    expect(missToSay(miss('gone', 1))).toBeUndefined();
    expect(missToSay(miss('unlisted', 1))).toBeUndefined();
    expect(missToSay(miss('unlisted', 2))).toBeUndefined();
    expect(missToSay(undefined)).toBeUndefined();
  });
  it('Woolworths after 2 checks; Coles and Aldi, which are only searched, after 3', () => {
    expect(missToSay(miss('gone', 2))).toBeDefined();
    expect(missToSay(miss('unlisted', 3))).toBeDefined();
  });
  it('"Keep watching" puts it away', () => {
    expect(missToSay(miss('gone', 5, { hidden: true }))).toBeUndefined();
  });
  it('says what is known, and no more', () => {
    const w = missWords('woolworths', miss('gone', 3));
    expect(w.title).toBe("Woolworths doesn't seem to sell this any more");
    expect(w.text).toContain('since 2 Nov (3 price checks)');
    expect(w.text).toContain('not your local shelf');
    const c = missWords('coles', miss('unlisted', 3));
    expect(c.title).toBe('Coles may not sell this any more');
    expect(c.text).toContain("Coles' search hasn't listed it since 2 Nov");
    expect(w.text).toContain("Woolworths' website has answered");
    expect(missWords('aldi', miss('unlisted', 3)).text).toContain("Aldi's search");
    expect(c.text).toContain('renamed or replaced by another size');
  });
  it('an item collects the notices of its products', () => {
    const products = [
      { id: 'a', chain: 'woolworths' as const, name: 'Milo 450g' },
      { id: 'b', chain: 'coles' as const, name: 'Milo 460g' },
      { id: 'c', chain: 'aldi' as const, name: 'Choc Malt' },
    ];
    const notes = shelfNotes(products, {
      a: { changed: { from: '500g', to: '450g', fromQty: 500, toQty: 450, unit: 'g', at: '2026-11-16' } },
      b: { miss: miss('unlisted', 3) },
      c: { miss: miss('unlisted', 1) },
    })!;
    expect(notes.changed.map((x) => x.productId)).toEqual(['a']);
    expect(notes.gone.map((x) => x.productId)).toEqual(['b']);
    expect(shelfNotes(products, {})).toBeUndefined();
    expect(shelfNotes(products, { c: { miss: miss('unlisted', 1) } })).toBeUndefined();
  });
});

describe('finding a replacement (0.11.3)', () => {
  it('searches by the name without its size', () => {
    expect(replacementTerm('Nestle Milo Choc Malt 500g')).toBe('Nestle Milo Choc Malt');
    expect(replacementTerm('Heinz Baked Beans 420g x 3 pack')).toBe('Heinz Baked Beans');
    expect(replacementTerm('Sprite Lemonade 30 x 375mL')).toBe('Sprite Lemonade');
    expect(replacementTerm('Earth Choice Dishwashing Tablets 42 pack')).toBe('Earth Choice Dishwashing Tablets');
    expect(replacementTerm('1L')).toBe('1L');
  });
  it('says how the new one compares', () => {
    expect(replacementLine({ name: 'Milo 500g', size: '500g', price: 9.5 }, { name: 'Milo 450g', size: '450g', price: 9.5 })).toBe('450g, was 500g · 11% more per 100 g');
    expect(replacementLine({ name: 'Milo 500g', size: '500g', price: 10 }, { name: 'Milo 450g', size: '450g', price: 9 })).toBe('450g, was 500g · the same per 100 g');
    expect(replacementLine({ name: 'Milo 500g', size: '500g', price: 9.5 }, { name: 'Milo 500g', size: '500g', price: 9 })).toBe('Same size · 5% less per 100 g');
    expect(replacementLine({ name: 'Milo 500g', size: '500g' }, { name: 'Milo 450g', size: '450g', price: 9 })).toBe('450g, was 500g');
    expect(replacementLine({ name: 'Milo 500g', size: '500g', price: 9 }, { name: 'Milo drink 1L', size: '1L', price: 4 })).toBeUndefined();
  });
});
