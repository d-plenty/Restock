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
