import { describe, expect, it } from 'vitest';
import type { StoreProduct } from '../stores/types';
import { eachLabel, otherSizes, packLabel, packOf, sameLine, vsLabel } from './otherSizes';
import fixtures from '../stores/fixtures-search-real.json';

// 0.9.1: "Other sizes of this", with names as the shops really write them.

let n = 0;
const sp = (chain: string, name: string, brand: string | undefined, size: string | undefined, price?: number): StoreProduct => ({
  chain: chain as StoreProduct['chain'],
  storeProductId: `${chain}-${++n}`,
  name,
  brand,
  size,
  price,
  isSpecial: false,
  memberOnly: false,
});
const names = (xs: { sp: StoreProduct }[]) => xs.map((x) => x.sp.name);

describe('what is in a pack', () => {
  it('reads the count and the size of each, however the shop writes it', () => {
    expect(packOf({ name: 'Coca-Cola Classic Soft Drink Cans 375mL x 24 pack', size: '375mL x 24 pack' })).toEqual({
      each: 375,
      unit: 'ml',
      count: 24,
      container: 'can',
    });
    // Coles: size "30 Pack", the can size in the name.
    expect(packOf({ name: 'Solo Original Lemon Soft Drink Cans Multipack 375ml', size: '30 Pack' })).toMatchObject({ each: 375, count: 30 });
    // Aldi: the whole pack as the size, how it's made up in the name.
    expect(packOf({ name: 'Pepsi Max 30x375ml', size: '11.25 l' })).toMatchObject({ each: 375, count: 30, unit: 'ml' });
    expect(packOf({ name: 'Solo Lemon 10×375ml', size: undefined })).toMatchObject({ each: 375, count: 10 });
    expect(packOf({ name: 'Up&Go Choc Ice 3x250ml', size: undefined })).toMatchObject({ each: 250, count: 3 });
    expect(packOf({ name: 'Heinz Baked Beans In Tomato Sauce 420g', size: '420g' })).toMatchObject({ each: 420, count: 1, unit: 'g' });
    expect(packOf({ name: 'Heinz Baked Beans In Tomato Sauce Multipack', size: '420g x 4 pack' })).toMatchObject({ each: 420, count: 4 });
    expect(packOf({ name: 'Coca-Cola Classic  Soft Drink Bottle 1.25L', size: '1.25L' })).toEqual({
      each: 1250,
      unit: 'ml',
      count: 1,
      container: 'bottle',
    });
  });
  it('leaves out things sold by the item', () => {
    expect(packOf({ name: 'Nutella B Ready Biscuit 6 pack', size: '6 pack' })).toBeUndefined();
    expect(packOf({ name: 'Panadol Tablets 500mg 20 Pack', size: '20 pack' })).toBeUndefined();
  });
  it('labels a pack plainly', () => {
    expect(packLabel({ each: 375, unit: 'ml', count: 24, container: 'can' })).toBe('375mL can × 24');
    expect(packLabel({ each: 1250, unit: 'ml', count: 1, container: 'bottle' })).toBe('1.25L bottle');
    expect(packLabel({ each: 420, unit: 'g', count: 4 })).toBe('420g × 4');
    expect(eachLabel({ each: 1000, unit: 'g', count: 1 })).toBe('1kg');
    expect(vsLabel(-0.123, 'ml')).toBe('12% cheaper per L');
    expect(vsLabel(0.08, 'g')).toBe('8% dearer per 100g');
    expect(vsLabel(0.002, 'ml')).toBe('Same per L');
  });
});

describe('the same product line', () => {
  const classic24 = sp('woolworths', 'Coca-Cola Classic Soft Drink Cans 375mL x 24 pack', 'Coca-Cola', '375mL x 24 pack', 27);
  it('same brand and flavour, any size', () => {
    expect(sameLine(classic24, sp('woolworths', 'Coca-Cola Classic  Soft Drink Bottle 1.25L', 'Coca-Cola', '1.25L'))).toBe(true);
    expect(sameLine(classic24, sp('woolworths', 'Coca-Cola Mini Classic 250mL x 15 pack', 'Coca-Cola', '250mL x 15 pack'))).toBe(true);
    expect(sameLine(classic24, sp('coles', 'Coca-Cola Classic Soft Drink Cans Multipack 375mL', 'Coca-Cola', '30 Pack'))).toBe(true);
  });
  it('never another flavour or variety', () => {
    for (const other of [
      'Coca-Cola Zero Sugar Soft Drink Cans 375mL x 24 pack',
      'Coca-Cola Diet Soft Drink Cans 375mL x 30 pack',
      'Coca-Cola Vanilla Soft Drink Cans 375mL x 10 pack',
      'Coca-Cola Caffeine Free Zero Sugar Soft Drink Cans 375mL x 10 pack',
    ])
      expect(sameLine(classic24, sp('woolworths', other, 'Coca-Cola', '375mL x 10 pack')), other).toBe(false);
    // Another brand with Coca-Cola in it.
    expect(sameLine(classic24, sp('woolworths', 'Bacardi & Coca-Cola Blanco Cans 330mL x 24 pack', 'Bacardi', '330mL x 24 pack'))).toBe(false);
    expect(sameLine(classic24, sp('woolworths', 'Jim Beam Vanilla & Cola Cans 375mL x 24 pack', 'Jim Beam', '375mL x 24 pack'))).toBe(false);
  });
  it('the brand can sit in the name at one shop and the brand field at another', () => {
    const a = sp('woolworths', 'Sanitarium Up&Go Liquid Breakfast Choc Ice 250mL x 6 pack', 'Sanitarium', '250mL x 6 pack');
    const b = sp('coles', 'UP&GO Liquid Breakfast Choc Ice 12x250ml', 'Up&Go', '3L');
    const vanilla = sp('coles', 'UP&GO Liquid Breakfast Vanilla Ice 12x250ml', 'Up&Go', '3L');
    expect(sameLine(a, b)).toBe(true);
    expect(sameLine(a, vanilla)).toBe(false);
  });
  it('different home brands are different products', () => {
    expect(sameLine(sp('coles', 'Coles Baked Beans 420g', 'Coles', '420g'), sp('woolworths', 'Woolworths Baked Beans 420g', 'Woolworths', '420g'))).toBe(
      false,
    );
    // No brand at either: only the same shop's own.
    expect(sameLine(sp('aldi', 'Salted Butter 500g', undefined, '500g'), sp('aldi', 'Salted Butter 250g', undefined, '250g'))).toBe(true);
    expect(sameLine(sp('aldi', 'Salted Butter 500g', undefined, '500g'), sp('coles', 'Salted Butter 250g', undefined, '250g'))).toBe(false);
  });
  it('more words is another product (Nutella with breadsticks)', () => {
    const jar = sp('woolworths', 'Nutella Hazelnut Chocolate Spread 400g', 'Nutella', '400g', 6.7);
    expect(sameLine(jar, sp('woolworths', 'Nutella Hazelnut Chocolate Spread With Breadsticks 48g', 'Nutella', '48g'))).toBe(false);
    expect(sameLine(jar, sp('woolworths', 'Nutella Biscuits 193g', 'Nutella', '193g'))).toBe(false);
    expect(sameLine(jar, sp('coles', 'Nutella Hazelnut Chocolate Spread', 'Nutella', '750g'))).toBe(true);
  });
});

describe('other sizes of this', () => {
  it('Solo 375mL cans: other packs by default, bottles and small cans as other container sizes', () => {
    const anchor = sp('woolworths', 'Solo Original Lemon Soft Drink Cans 375mL x 10 pack', 'Solo', '375mL x 10 pack', 21);
    const pool = [
      anchor,
      sp('woolworths', 'Solo Original Lemon Soft Drink Cans 375mL x 30 pack', 'Solo', '375mL x 30 pack', 32),
      sp('woolworths', 'Solo Original Lemon Soft Drink Cans 375mL x 24 pack', 'Solo', '375mL x 24 pack', 27),
      sp('coles', 'Solo Original Lemon Soft Drink Cans Multipack 375ml', 'Solo', '30 Pack', 33),
      // The same pack at another shop is the same product, not another size.
      sp('coles', 'Solo Original Lemon Soft Drink Cans Multipack 375ml', 'Solo', '10 Pack', 20),
      sp('woolworths', 'Solo Original Lemon Soft Drink Bottle 1.25L', 'Solo', '1.25L', 4),
      sp('woolworths', 'Solo Original Lemon Soft Drink Mini Cans 250mL x 6 pack', 'Solo', '250mL x 6 pack', 6.6),
      sp('woolworths', 'Solo Zero Sugar Lemon Soft Drink Cans 375mL x 10 pack', 'Solo', '375mL x 10 pack', 21),
      sp('bws', 'Hard Solo Alcoholic Lemonade 4% 10 x 375ml', 'Hard Solo', '10 x 375ml', 45),
      sp('woolworths', 'Solo Original Lemon Soft Drink Cans 375mL x 20 pack', 'Solo', '375mL x 20 pack'), // no price: not for sale
    ];
    const got = otherSizes(anchor, pool);
    expect(names(got.packs)).toEqual([
      'Solo Original Lemon Soft Drink Cans 375mL x 24 pack',
      'Solo Original Lemon Soft Drink Cans 375mL x 30 pack',
      'Solo Original Lemon Soft Drink Cans Multipack 375ml',
    ]);
    expect(got.packs.map((x) => x.pack.count)).toEqual([24, 30, 30]);
    expect(names(got.containers)).toEqual(['Solo Original Lemon Soft Drink Mini Cans 250mL x 6 pack', 'Solo Original Lemon Soft Drink Bottle 1.25L']);
    // Compared per litre: $21 for 3.75 L is $5.60/L; $32 for 11.25 L is $2.84/L.
    const thirty = got.packs.find((x) => x.sp.price === 32)!;
    expect(thirty.per * 1000).toBeCloseTo(2.844, 2);
    expect(thirty.vs).toBeCloseTo(2.844 / 5.6 - 1, 2);
    expect(got.mine?.per).toBeCloseTo(0.0056, 5);
  });

  it('the real Woolworths "coca cola 24 pack" results: only Classic, never Zero, Diet, Vanilla or mixers', () => {
    const real = (fixtures as Record<string, StoreProduct[]>)['woolworths|coca cola 24 pack'];
    const anchor = real.find((p) => p.name === 'Coca-Cola Classic Soft Drink Cans 375mL x 24 pack')!;
    const got = otherSizes(anchor, real);
    expect(names(got.packs)).toEqual(['Coca-Cola Classic Soft Drink Cans 375mL x 10 pack', 'Coca-Cola Classic Soft Drink Cans 375mL x 30 pack']);
    expect(names(got.containers)).toEqual([
      'Coca-Cola Classic  Soft Drink Mini Cans 250mL x 6 pack',
      'Coca-Cola Mini Classic 250mL x 15 pack',
      'Coca-Cola Classic  Soft Drink Mini Bottles 300mL x 12 pack',
      'Coca-Cola Classic  Soft Drink Bottle 1.25L',
    ]);
    for (const x of [...got.packs, ...got.containers]) expect(x.sp.name).toMatch(/Classic/);
  });

  it('Heinz Baked Beans: the single tin and the multipacks', () => {
    const anchor = sp('woolworths', 'Heinz Baked Beans In Tomato Sauce 420g', 'Heinz', '420g', 2.5);
    const pool = [
      sp('woolworths', 'Heinz Baked Beans In Tomato Sauce Multipack 4 x 420g', 'Heinz', '4 x 420g', 8),
      sp('woolworths', 'Heinz Baked Beans In Tomato Sauce 420g x 3 pack', 'Heinz', '420g x 3 pack', 6.5),
      sp('woolworths', 'Heinz Baked Beans In Tomato Sauce 220g', 'Heinz', '220g', 1.8),
      sp('woolworths', 'Heinz Baked Beans In BBQ Sauce 420g', 'Heinz', '420g', 2.5),
      sp('woolworths', 'Heinz Baked Beans In Tomato Sauce Salt Reduced 420g', 'Heinz', '420g', 2.5),
      sp('coles', 'SPC Baked Beans In Tomato Sauce 425g', 'SPC', '425g', 1.6),
    ];
    const got = otherSizes(anchor, pool);
    expect(got.packs.map((x) => x.pack.count)).toEqual([3, 4]);
    expect(names(got.containers)).toEqual(['Heinz Baked Beans In Tomato Sauce 220g']);
    expect(got.packs[1].vs).toBeLessThan(0); // $8 for 4 tins is cheaper per 100g than $2.50 for one
  });

  it('Nutella: other jar sizes, and the 15g minis, but not breadsticks or biscuits', () => {
    const real = (fixtures as Record<string, StoreProduct[]>)['woolworths|nutella'];
    const anchor = real.find((p) => p.name === 'Nutella Hazelnut Chocolate Spread 400g')!;
    const got = otherSizes(anchor, real);
    expect(got.packs).toEqual([]);
    expect(names(got.containers)).toEqual([
      'Nutella Hazelnut Chocolate Spread 15g x 12 pack',
      'Nutella Hazelnut Chocolate Spread 220g',
      'Nutella Hazelnut Chocolate Spread 750g',
      'Nutella Hazelnut Chocolate Spread 1kg',
    ]);
  });

  it('Up&Go: 6 packs and 12 packs of the same 250mL at either shop', () => {
    const anchor = sp('woolworths', 'Sanitarium Up&Go Liquid Breakfast Choc Ice 250mL x 6 pack', 'Sanitarium', '250mL x 6 pack', 9);
    const pool = [
      sp('coles', 'UP&GO Liquid Breakfast Choc Ice 12x250ml', 'Up&Go', '3L', 16.5),
      sp('woolworths', 'Up&Go Liquid Breakfast Choc Ice 3 x 250mL', 'Up&Go', '3 x 250mL', 5),
      sp('coles', 'UP&GO Liquid Breakfast Vanilla Ice 12x250ml', 'Up&Go', '3L', 16.5),
      sp('woolworths', 'Up&Go Energize Liquid Breakfast Choc Ice 250mL x 6 pack', 'Up&Go', '250mL x 6 pack', 10),
    ];
    const got = otherSizes(anchor, pool);
    expect(got.packs.map((x) => `${x.sp.chain} ${x.pack.count}`)).toEqual(['woolworths 3', 'coles 12']);
    expect(got.containers).toEqual([]);
  });

  it('leaves out what the item already has, and anything sold by the item', () => {
    const anchor = sp('woolworths', 'Coca-Cola Classic Soft Drink Cans 375mL x 24 pack', 'Coca-Cola', '375mL x 24 pack', 27);
    const thirty = sp('woolworths', 'Coca-Cola Classic Soft Drink Cans 375mL x 30 pack', 'Coca-Cola', '375mL x 30 pack', 32);
    expect(otherSizes(anchor, [thirty], { skip: new Set([`woolworths:${thirty.storeProductId}`]) }).packs).toEqual([]);
    const bars = sp('woolworths', 'Nestle Milo Snack Bars Original 10 pack', 'Nestle', '10 pack', 9);
    expect(otherSizes(bars, [sp('woolworths', 'Nestle Milo Snack Bars Original 6 pack', 'Nestle', '6 pack', 6)])).toEqual({ packs: [], containers: [] });
  });

  it('Milo: other tin sizes, but not cereal, protein or the 30% less sugar one', () => {
    const real = (fixtures as Record<string, StoreProduct[]>)['woolworths|milo'];
    const anchor = real.find((p) => p.name === 'Milo Malt Drinking Chocolate Powder Hot or Cold 1kg')!;
    const got = otherSizes(anchor, real);
    // The 730g refill doesn't say "Hot or Cold", so it's missed: better than a wrong one.
    expect(names(got.containers)).toEqual(['Milo Malt Drinking Chocolate Powder Hot Or Cold 200g', 'Milo Malt Drinking Chocolate Powder Hot Or Cold 460g']);
  });

  it('a refill of the very same name is another size', () => {
    const anchor = sp('coles', 'Moccona Classic Dark Roast Freeze Dried Instant Coffee 200g', 'Moccona', '200g', 22);
    const refill = sp('coles', 'Moccona Classic Dark Roast Freeze Dried Instant Coffee Refill 150g', 'Moccona', '150g', 15);
    expect(names(otherSizes(anchor, [refill]).containers)).toEqual([refill.name]);
  });
});
