import { describe, expect, it } from 'vitest';
import { genericName } from './naming';

describe('generic item names', () => {
  it.each([
    ['Coles Simply Pure Honey Squeeze 400g', 'Honey'],
    ['100% pure Australian raw and unfiltered honey', 'Honey'],
    ['Eucalyptus Honey 400g', 'Honey'],
    ['Smooth Peanut Butter 755g', 'Peanut butter'],
    ['Nutella Hazelnut Chocolate Spread 750g', 'Nutella'],
    ['Milo Malt Drinking Chocolate Powder Hot or Cold 1kg', 'Milo'],
    ['Vegemite 370g', 'Vegemite'],
    ['Ritz Original Crackers 227g', 'Crackers'],
    ['Italian Diced Tomatoes 400g', 'Diced tomatoes'],
    ['Pizza Sauce 400g', 'Pizza sauce'],
    ['Chocolate Ice Cream Topping 615g', 'Ice cream topping'],
    ['Massel Reduced Salt Chicken Stock Powder 140g', 'Stock powder'],
    ['Woolworths Toilet Paper 24 Pack', 'Toilet paper'],
    ['Full Cream Milk 2L', 'Full cream milk'],
    ['Spaghetti in Tomato Sauce 420g', 'Spaghetti'],
    ['Heinz Baked Beans in Tomato Sauce 420g', 'Baked beans'],
    ['John West Tuna in Springwater 95g', 'Tuna'],
    ["Leggo's Bolognese Pasta Sauce 500g", 'Pasta sauce'],
    ['San Remo Spaghetti No 5 500g', 'Spaghetti'],
    ['Barilla Penne Rigate 500g', 'Penne'],
    ['Wafer Rolls Choc 350g', 'Wafer rolls'],
  ])('%s → %s', (input, expected) => {
    expect(genericName(input)).toBe(expected);
  });

  it('falls back to the name without its size and brand', () => {
    expect(genericName('Brandco Zesty Thingamajig 300g', 'Brandco')).toBe('Zesty Thingamajig');
  });
});

describe('nameHasSize', async () => {
  const { nameHasSize } = await import('./naming');
  it('ignores spaces and litre spellings', () => {
    expect(nameHasSize('Topz Original Crackers 227g', '227 g')).toBe(true);
    expect(nameHasSize('Full Cream Milk 2L', '2 litre')).toBe(true);
    expect(nameHasSize('Ritz Original Crackers', '227g')).toBe(false);
  });
});

describe('tinned fruit (0.7.2)', () => {
  it('names the fruit, not what it is packed in', () => {
    expect(genericName('Woolworths Pineapple Slices In Juice 425g', 'Woolworths')).toBe('Pineapple slices');
    expect(genericName('Peaches in Natural Juice 410g')).toBe('Peaches');
    expect(genericName('SPC Apricot Halves in Juice 410g', 'SPC')).toBe('Apricot halves');
    expect(genericName('Golden Circle Orange Juice 2L', 'Golden Circle')).toBe('Orange juice');
  });
});

import { sizeWithUnit } from './lookup';
describe('Open Food Facts sizes (0.7.2)', () => {
  it('keeps sizes with a unit and drops bare numbers', () => {
    expect(sizeWithUnit('4')).toBeUndefined();
    expect(sizeWithUnit('425 g')).toBe('425 g');
    expect(sizeWithUnit('6 x 375ml')).toBe('6 x 375ml');
    expect(sizeWithUnit('2L')).toBe('2L');
    expect(sizeWithUnit('24 pack')).toBe('24 pack');
  });
});

import { colesStoreFromPage } from './accounts';
describe('Coles store pages (0.7.2)', () => {
  it('reads the store number and suburb from the address', () => {
    expect(colesStoreFromPage('https://www.coles.com.au/find-stores/coles/qld/bohle-plains-0844')).toEqual({
      storeNo: '0844',
      name: 'Coles Bohle Plains',
    });
    expect(colesStoreFromPage('https://www.coles.com.au/find-stores/coles/vic/werribee-7712/?utm=x')).toEqual({
      storeNo: '7712',
      name: 'Coles Werribee',
    });
    expect(colesStoreFromPage('https://www.coles.com.au/find-stores')).toBeUndefined();
  });
});

describe('baking chips (0.7.3)', () => {
  it('keeps chocolate chips as chocolate chips', () => {
    expect(genericName('Woolworths White Chocolate Chips 200g', 'Woolworths')).toBe('White chocolate chips');
    expect(genericName("Smith's Crinkle Cut Chips Original 170g", "Smith's")).toBe('Chips');
  });
});
