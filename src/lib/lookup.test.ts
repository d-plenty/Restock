import { describe, expect, it } from 'vitest';
import { genericMedicine, searchTermFor, shortDrink } from './lookup';

describe('short searches for bottle shops and pharmacies', () => {
  it('searches medicines by ingredient and strength, whatever the brand', () => {
    expect(genericMedicine('Pain Relief Tablets 500mg 20 Pack', 'Some Brand Paracetamol')).toBe('paracetamol 500mg');
    expect(genericMedicine('Nurofen Zavance 200mg 24 Liquid Capsules')).toBe('ibuprofen 200mg');
    expect(genericMedicine('Maxigesic Paracetamol and Ibuprofen Tablets 500mg/150mg')).toBe('paracetamol ibuprofen 500mg');
    expect(genericMedicine('Claratyne Hayfever 10 tablets')).toBe('loratadine');
    expect(genericMedicine('Sudocrem 125g')).toBeUndefined();
  });

  it('searches drinks by brand and product, without sizes or strengths', () => {
    expect(shortDrink('Hard Solo Alcoholic Lemonade 4% 10 x 375ml', 'Hard Solo')).toBe('Hard Solo Lemonade');
    expect(shortDrink("Jack Daniel's Tennessee Whiskey 700ml")).toBe("Jack Daniel's Tennessee");
    expect(shortDrink('Lager Cans 30 Pack 375ml', 'Great Northern')).toBe('Great Northern Lager');
  });

  it('keeps the full name for groceries', () => {
    expect(searchTermFor({ barcode: '1', name: 'Milo 460g', brand: 'Nestle' }, 'pantry')).toEqual({ term: 'Nestle Milo 460g', generic: false });
    expect(searchTermFor({ barcode: '9322838018820' }, 'pharmacy')).toEqual({ term: '9322838018820', generic: false });
  });
});

describe('names from barcode databases', async () => {
  const { weakName, displayName } = await import('./lookup');
  it('spots a name that is only the brand', () => {
    expect(weakName({ name: 'Earth Choice', brand: 'Earth Choice' })).toBe(true);
    expect(weakName({ name: 'Earth Choice Dishwashing Liquid', brand: 'Earth Choice' })).toBe(false);
    expect(weakName({ name: 'Vegemite' })).toBe(false);
  });
  it("doesn't double the brand", () => {
    expect(displayName({ name: 'Earth Choice', brand: 'Earth Choice' })).toBe('Earth Choice');
    expect(displayName({ name: 'Dishwashing Liquid', brand: 'Earth Choice' })).toBe('Earth Choice Dishwashing Liquid');
  });
});

describe('tidying scanned names', () => {
  it('drops a doubled brand', async () => {
    const { collapseRepeats } = await import('./lookup');
    expect(collapseRepeats('Earth Choice Earth Choice')).toBe('Earth Choice');
    expect(collapseRepeats('Tim Tam Tim Tam Original')).toBe('Tim Tam Original');
    expect(collapseRepeats('Choc Chip Cookies')).toBe('Choc Chip Cookies');
  });
});

describe('the kind of product from an open-database entry', () => {
  it('uses plain words and ignores tags', async () => {
    const { productKind } = await import('./lookup');
    expect(productKind(undefined, 'open-beauty-facts')).toBeUndefined();
    expect(productKind(undefined, 'en:dish-soaps')).toBeUndefined();
    expect(productKind('', 'Household products, Dishwashing liquids')).toBe('Dishwashing liquids');
    expect(productKind('Dishwashing liquid', 'en:cleaning')).toBe('Dishwashing liquid');
    expect(productKind(undefined, 'Dishwashing liquids, open-beauty-facts')).toBe('Dishwashing liquids');
  });
});
