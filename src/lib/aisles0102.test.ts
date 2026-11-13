import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { colesAisle } from '../stores/coles';
import { aisleLabel, aisleOf, byAisle, type AisleAt, type AisleMap } from './aisles';

const fixtures = JSON.parse(readFileSync(new URL('../../tools/sync-test/aisle-fixtures-0102.json', import.meta.url), 'utf8')) as {
  cases: { name: string; product: Record<string, unknown>; want: unknown }[];
};

describe('Coles aisles (0.10.2), the same answers as Aisles.java', () => {
  for (const c of fixtures.cases) it(c.name, () => expect(colesAisle(c.product) ?? null).toEqual(c.want));
});

describe('aisle labels and the shopping mode sort (0.10.2)', () => {
  it('labels', () => {
    expect(aisleLabel({ a: '12', side: 'LEFT' })).toBe('Aisle 12 · Left');
    expect(aisleLabel({ a: 'Aisle 7' })).toBe('Aisle 7');
    expect(aisleLabel({ a: 'Freezer', side: 'right' })).toBe('Freezer · Right');
    expect(aisleLabel(undefined)).toBe('Aisle: unknown');
    expect(aisleLabel({})).toBe('Aisle: unknown');
  });

  it("is per branch, and a branch you've changed doesn't count", () => {
    const map: AisleMap = { p1: { '1': { a: '3', s: '4527' }, '2': { a: '9', s: '0701' } } };
    expect(aisleOf(map, 'p1', '1', '4527')?.a).toBe('3');
    expect(aisleOf(map, 'p1', '2', '0701')?.a).toBe('9');
    expect(aisleOf(map, 'p1', '1', '9999')).toBeUndefined();
    expect(aisleOf(map, 'nope')).toBeUndefined();
  });

  it('numbered aisles first (either way), then named ones, then unknown A–Z', () => {
    const rows: [string, AisleAt | undefined][] = [
      ['Tim Tams', undefined],
      ['Milk', { a: 'Dairy' }],
      ['BBQ sauce', { a: '9', o: 2 }],
      ['Tomato sauce', { a: '9', o: 1 }],
      ['Pasito', { a: '13' }],
      ['Apples', undefined],
      ['Coconut cream', { a: '4' }],
      ['Bread', { a: '2' }],
    ];
    const names = (down: boolean) => byAisle(rows, (r) => r[1], (r) => r[0], down).map((r) => r[0]);
    expect(names(false)).toEqual(['Bread', 'Coconut cream', 'Tomato sauce', 'BBQ sauce', 'Pasito', 'Milk', 'Apples', 'Tim Tams']);
    expect(names(true)).toEqual(['Pasito', 'BBQ sauce', 'Tomato sauce', 'Coconut cream', 'Bread', 'Milk', 'Apples', 'Tim Tams']);
  });
});
