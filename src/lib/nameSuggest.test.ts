import { describe, expect, it } from 'vitest';
import { suggestName } from './nameSuggest';

describe('0.12.7: the name Restock offers for a new item', () => {
  it('what your picks share, when you searched for less: "jam" → Strawberry jam', () => {
    expect(
      suggestName(
        [{ name: 'Strawberry Premium Jam 360g' }, { name: 'Cottees Strawberry Jam', brand: 'Cottees' }, { name: "Cottee's Strawberry Jam 375g", brand: "Cottee's" }],
        'jam',
      ),
    ).toBe('Strawberry jam');
  });
  it('what you searched, when your picks are that: never "Sugar" from "25% Less Sugar"', () => {
    const picks = [
      { name: 'Praise Dressing Balsamic 99% Fat Free 25% Less Sugar', brand: 'Praise' },
      { name: 'Praise Balsamic Dressing 99% Fat Free 330mL', brand: 'Praise' },
    ];
    expect(suggestName(picks, 'Balsamic dressing')).toBe('Balsamic dressing');
    // The same picks with nothing typed (a scan): still not the fine print.
    expect(suggestName(picks).toLowerCase()).not.toContain('sugar');
    expect(suggestName([picks[0]]).toLowerCase()).not.toContain('sugar');
  });
  it('no brand and no size, so it can be said out loud', () => {
    expect(suggestName([{ name: 'Pauls Premium Cheese 425g', brand: 'Pauls' }], 'cheese')).toBe('Cheese');
    expect(suggestName([{ name: 'Bega Tasty Cheese Block 500g', brand: 'Bega' }, { name: 'Coles Tasty Cheese Block 1kg', brand: 'Coles' }], 'cheese')).toBe('Tasty cheese');
  });
  it('one pick and no search: the kind of thing', () => {
    expect(suggestName([{ name: 'Coles Simply Pure Honey Squeeze 400g', brand: 'Coles' }])).toBe('Honey');
  });
  it('a search your picks are not: what the picks share', () => {
    expect(suggestName([{ name: 'Heinz Baked Beans 420g', brand: 'Heinz' }, { name: 'SPC Baked Beans 425g', brand: 'SPC' }], 'tomato soup')).toBe('Baked beans');
  });
  it('nothing to go on: nothing offered', () => {
    expect(suggestName([])).toBe('');
  });
  it('never more than three words', () => {
    const s = suggestName([{ name: 'Thanks To Nature Smooth & Control Conditioner With Keratin For Frizzy Hair 500mL' }]);
    expect(s.split(' ').length).toBeLessThanOrEqual(3);
  });
});
