import { describe, expect, it } from 'vitest';
import { formatUnitPrice, packSize, parseSize, unitPrice } from './units';
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
    expect(formatUnitPrice(0.0028, 'ea')).toBe('$0.28 / 100');
    expect(formatUnitPrice(1.25, 'ea')).toBe('$1.25 / ea');
  });
});
