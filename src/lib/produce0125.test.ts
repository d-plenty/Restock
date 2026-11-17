// 0.12.5: loose fruit and veg: a price by the kilo, and "kinds" (not "flavours").
import { describe, expect, it } from 'vitest';
import { flavourWord, varietyWord } from './flavours';
import { perKiloNote } from './unitPrice';
import { mentions } from '../stores/rank';

describe('perKiloNote', () => {
  it("uses the shop's own per-kilo price when it gives one", () => {
    expect(perKiloNote({ name: 'Coles Creme Gold Washed Potatoes Loose', size: 'approx. 150g', price: 0.75, unitPriceText: '$5.00 per 1kg' })).toBe('$5.00/kg');
    expect(perKiloNote({ name: 'Potato White Washed each', size: 'each', price: 0.9, unitPriceText: '$4.50 / 1KG' })).toBe('$4.50/kg');
  });
  it('works it out from an approximate weight', () => {
    expect(perKiloNote({ name: 'Coles Creme Gold Washed Potatoes Loose', size: 'approx. 150g', price: 0.75 })).toBe('about $5.00/kg');
    expect(perKiloNote({ name: 'Coles Potatoes Sweet Gold', size: 'approx. 500g', price: 1.75 })).toBe('about $3.50/kg');
  });
  it('says nothing when the shop gives neither, or it is a pack', () => {
    expect(perKiloNote({ name: 'Potato White Washed each', size: 'each', price: 0.9, unitPriceText: '$0.90 each' })).toBeUndefined();
    expect(perKiloNote({ name: 'Coles Potatoes Washed', size: '2kg', price: 5, unitPriceText: '$2.50 per 1kg' })).toBeUndefined();
    expect(perKiloNote({ name: 'Heinz Baked Beans', size: '420g', price: 3.5 })).toBeUndefined();
  });
});

describe('varietyWord', () => {
  it('fresh fruit and veg come in kinds', () => {
    expect(varietyWord(['Coles Potatoes Washed 2kg', 'Coles Potatoes Brushed 2kg', 'Coles Red Potatoes 2kg'])).toBe('kinds');
    expect(flavourWord(['Coles Potatoes Washed 2kg', 'Coles Potatoes Brushed 2kg'])).toBe('flavours');
  });
  it('made things keep their word', () => {
    expect(varietyWord(['Smiths Potato Chips Original 170g', 'Smiths Potato Chips Chicken 170g'])).toBe('flavours');
    expect(varietyWord(['Apple Juice 2L', 'Orange Juice 2L'])).toBe('flavours');
    expect(varietyWord(['Dove Body Wash Coconut 1L', 'Dove Body Wash Mango 1L'])).toBe('scents');
    expect(varietyWord(['Heinz Baked Beans 420g', 'Heinz Baked Beans 420g x 3 pack'])).toBe('sizes');
  });
});

describe('mentions', () => {
  const p = (name: string) => ({ chain: 'coles' as const, storeProductId: name, name, isSpecial: false, memberOnly: false });
  it('a near-miss says nothing of what you typed', () => {
    expect(mentions({ text: 'potato' }, p('Coles Simply Steel Wool Soap Pads'))).toBe(false);
    expect(mentions({ text: 'potato' }, p('Coles Potatoes Creme Royale Brushed'))).toBe(true);
    expect(mentions({ text: 'potato' }, p('Coles Potatoes Sweet Gold'))).toBe(true);
  });
  it('nothing typed, everything counts', () => {
    expect(mentions({ text: '' }, p('Anything'))).toBe(true);
  });
});
