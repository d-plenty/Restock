import { describe, expect, it } from 'vitest';
import { normaliseQuery, scoreAll, surePick, topPicks } from '../lib/searchHelp';
import { rankAll } from './rank';
import fixtures from './fixtures-search-real.json';
import type { StoreProduct } from './types';

// Real search results saved from Woolworths, Aldi, BWS and Direct Chemist (0.8.5 search test),
// and what a person would expect at the top of each. Ranking changes must keep these right.
const real = fixtures as unknown as Record<string, StoreProduct[]>;

type Want = [key: string, top: number, want: RegExp | null, avoid?: RegExp];
const CASES: Want[] = [
  // The everyday one first, not the speciality one.
  ['woolworths|milk', 1, /full cream milk/i],
  ['woolworths|milk', 5, null, /formula|lactose|goat/i],
  ['aldi|milk', 3, /milk \d/i, /mouse|frother|evaporated|chocolate/i],
  ['woolworths|flour', 1, /plain flour|self raising/i],
  ['woolworths|salt', 1, /table salt|sea salt/i],
  ['aldi|salt', 1, /table salt/i],
  ['woolworths|butter', 1, /butter/i, /spread|peanut/i],
  ['aldi|butter', 1, /butter \d/i],
  ['woolworths|bread', 1, /bread/i, /pita|crumb/i],
  ['woolworths|cheese', 2, null, /cream cheese/i],
  ['woolworths|eggs', 1, /eggs/i],
  // A brand: the brand's main product, the way the shop lists it.
  ['woolworths|nutella', 1, /spread/i],
  ['woolworths|milo', 1, /powder/i],
  ['woolworths|cadbury dairy milk', 3, null, /tin|bon bon|bauble|santa|advent|egg/i],
  ['woolworths|vegemite', 1, /vegemite/i],
  // Not the thing at all.
  ['aldi|sugar', 3, null, /no sugar|cola|tonic/i],
  ['aldi|conditioner', 3, null, /air conditioner/i],
  ['aldi|smiths chips', 3, null, /apple/i],
  ['aldi|dishwasher tablets', 2, /dishwash/i, /paracetamol/i],
  ['aldi|pepsi max', 2, /pepsi/i, /toothpaste/i],
  ['aldi|honey', 3, null, /wheats|mandarin/i],
  ['aldi|coffee pods', 2, /pods/i, /coffee-mate/i],
  ['woolworths|chocolate', 3, null, /wafer/i],
  ['bws|rose', 3, /ros[eé]/i, /gin|vodka|whisky/i],
  // What you asked for, exactly.
  ['woolworths|coca cola 24 pack', 2, /x 24|24 pack/i, /bacardi|mini/i],
  ['woolworths|full cream milk 2l', 1, /full cream milk 2l/i],
  ['woolworths|beef mince 500g', 1, /beef mince 500g/i],
  ['woolworths|tasty cheese 500g', 3, /tasty cheese block 500g/i],
  ['woolworths|chiken breast', 3, /chicken breast/i, /hydrogel|chives/i],
  ['woolworths|banannas', 1, /banana/i],
  ['aldi|free range eggs 12', 2, /eggs/i, /papardelle|fettuccine/i],
  ['woolworths|finish dishwasher tablets', 3, /finish/i],
  ['directchemist|paracetamol', 3, /paracetamol/i],
  ['directchemist|baby panadol', 1, /panadol children/i],
  // Brands at a bottle shop: the spirit itself, and what you typed.
  ['bws|smirnoff', 1, /vodka/i],
  ['bws|jim beam', 1, /bourbon/i],
  ['bws|canadian club and dry', 1, /whisky & dry/i],
  ['aldi|rice', 2, null, /microwave/i],
  ['woolworths|rice', 2, null, /microwave/i],
  // From the phone search test (0.8.6): Coles and Liquorland.
  ['coles|conditioner', 3, /conditioner/i, /fabric|softener/i],
  ['coles|western star', 1, /butter/i, /spreadable|blend/i],
  ['liquorland|smirnoff', 1, /vodka/i],
  ['coles|honey', 1, /honey/i, /kebab|smoothie/i],
  ['coles|olive oil', 3, /olive oil/i, /tuna/i],
  ['coles|salt', 3, /salt/i, /vinegar/i],
  ['coles|coffee', 1, /coffee/i, /iced/i],
  ['coles|milk', 1, /full cream milk/i],
  ['liquorland|beer', 3, /beer|lager|ale|bitter/i, /ginger/i],
];

const QUERY: Record<string, string> = {};

describe('real search results', () => {
  for (const [key, top, want, avoid] of CASES) {
    it(`${key}: ${want ?? ''} ${avoid ? `not ${avoid}` : ''}`, () => {
      const items = real[key];
      expect(items, `${key} is in the fixtures`).toBeTruthy();
      const text = normaliseQuery(QUERY[key] ?? key.split('|')[1]);
      const names = rankAll({ text }, items)
        .slice(0, top)
        .map((p) => p.name);
      if (want)
        expect(
          names.some((n) => want.test(n)),
          names.join(' ; '),
        ).toBe(true);
      if (avoid)
        expect(
          names.filter((n) => avoid.test(n)),
          names.join(' ; '),
        ).toEqual([]);
    });
  }
});

describe('recommended and sure picks', () => {
  const scored = (key: string, text = key.split('|')[1]) => scoreAll({ text: normaliseQuery(text) }, real[key]);

  it('recommends the everyday milk, and nothing for a shop with nothing like it', () => {
    const picks = topPicks(scored('woolworths|milk')).map((p) => p.name);
    expect(picks.length).toBeGreaterThan(0);
    expect(
      picks.every((n) => /full cream milk/i.test(n)),
      picks.join(' ; '),
    ).toBe(true);
    expect(topPicks(scoreAll({ text: 'dishwasher tablets' }, real['woolworths|milk']))).toEqual([]);
  });

  it('only ticks a typed search for you when it is sure', () => {
    // Plenty of brands of full cream milk 2L: not sure which one you mean.
    expect(surePick({ text: 'full cream milk 2l' }, { woolworths: scored('woolworths|full cream milk 2l') })).toBeUndefined();
    // No size typed: never.
    expect(surePick({ text: 'nutella' }, { woolworths: scored('woolworths|nutella') })).toBeUndefined();
    // The brand, the kind and the size: that one.
    const w = scoreAll({ text: 'western star salted butter block 500g' }, real['woolworths|western star butter']);
    expect(surePick({ text: 'western star salted butter block 500g' }, { woolworths: w })?.name).toBe(
      'Western Star Salted Butter Block 500g',
    );
  });
});
