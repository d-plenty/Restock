import { describe, expect, it } from 'vitest';
import { formatUnitPrice, packSize, parseSize, tidySize, tidyUnitText, unitPrice } from './units';
import packCases from './packCases.json';

describe('parseSize', () => {
  it.each([
    ['1kg', 1000, 'g'],
    ['500g', 500, 'g'],
    ['1.5 kg', 1500, 'g'],
    ['2L', 2000, 'ml'],
    ['750ml', 750, 'ml'],
    ['6 x 375ml', 2250, 'ml'],
    ['375mL x 6', 2250, 'ml'],
    ['24 pack', 24, 'ea'],
    ['24pk', 24, 'ea'],
    ['500 sheets', 500, 'ea'],
    ['12 Rolls', 12, 'ea'],
    ['each', 1, 'ea'],
    ['2 litres', 2000, 'ml'],
  ])('%s → %d %s', (input, qty, unit) => {
    expect(parseSize(input)).toEqual({ qty, unit });
  });

  it('returns undefined for nothing useful', () => {
    expect(parseSize('')).toBeUndefined();
    expect(parseSize('Toilet paper')).toBeUndefined();
    expect(parseSize(undefined)).toBeUndefined();
  });
});

// Shared with the Java checks, so the phone's background price checks do the same maths.
describe('packSize', () => {
  it.each(packCases as [string, string, number, string, number | null][])('%s + "%s" → %d %s', (size, name, qty, unit, count) => {
    expect(packSize(size, name)).toEqual({ qty, unit, count: count ?? undefined });
  });

  it('compares a Coles "30 Pack" with a Woolworths "375mL x 30 pack" by the litre', () => {
    const coles = packSize('30 Pack', 'Solo Original Lemon Soft Drink Cans Multipack 375ml')!;
    const woolies = packSize('375mL x 30 pack', 'Solo Original Lemon Soft Drink Cans 375mL x 30 pack')!;
    expect(coles).toEqual(woolies);
    // $26 for 30 cans is $2.31 a litre and 87c a can.
    expect(formatUnitPrice(unitPrice(26, coles.qty, coles.unit), coles.unit)).toBe('$2.31 / L');
  });
});

describe('unit prices', () => {
  it('computes per-base price', () => {
    expect(unitPrice(5, 1000, 'g')).toBeCloseTo(0.005);
    expect(unitPrice(5, undefined, 'g')).toBeUndefined();
  });
  it('formats like shelf labels', () => {
    expect(formatUnitPrice(0.005, 'g')).toBe('$0.50 / 100g');
    expect(formatUnitPrice(0.0016, 'ml')).toBe('$1.60 / L');
    expect(formatUnitPrice(0.0028, 'ea')).toBe('$0.28 per 100');
    expect(formatUnitPrice(1.25, 'ea')).toBe('$1.25 each');
  });
});

describe('sizes and unit prices shown to people (0.7.3)', () => {
  it('takes the count from the name when the shop says 1 each', () => {
    expect(packSize('1 each', 'Finish Dishwashing Tablets 70 Pack')).toEqual({ qty: 70, unit: 'ea' });
    expect(tidySize('1 each', 'Dishwashing Tablets 70 Pack')).toBe('70 pack');
    expect(tidySize('1 Each', 'Brita Water Filter')).toBe('1 each');
    expect(tidySize('3 Pack')).toBe('3 pack');
    expect(tidySize('500mL')).toBe('500mL');
  });
  it('tidies shop unit prices', () => {
    expect(tidyUnitText('$31.99 per 1 each')).toBe('$31.99 each');
    expect(tidyUnitText('$0.87 / 1EA')).toBe('$0.87 each');
    expect(tidyUnitText('$0.96 per 100 each')).toBe('$0.96 per 100');
    expect(tidyUnitText('$2.50 per 1L')).toBe('$2.50 per 1L');
  });
});
