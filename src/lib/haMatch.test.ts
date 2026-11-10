import { describe, expect, it } from 'vitest';
import { candidates, lineSummary, matchKey, matchOne, parseLine, searchItems, wordKey } from './haMatch';

// 0.9.3: matching a line's words to a pantry item (Home Assistant voice adds, "Pick my milk").

const pantry = [
  { id: 'milk', name: 'Milk' },
  { id: 'eggs', name: 'Free range eggs' },
  { id: 'egg', name: 'Eggs' },
  { id: 'berries', name: 'Blueberries' },
  { id: 'tom', name: 'Tomatoes' },
  { id: 'noodles', name: '2 Minute Noodles' },
  { id: 'peach', name: 'Peaches' },
  { id: 'bread', name: 'Bread' },
  { id: 'bread2', name: 'bread ' },
  { id: 'cafe', name: 'Café coffee' },
  { id: 'hummus', name: 'Hummus' },
  { id: 'glass', name: 'Glass cleaner' },
];

describe('one form for singular and plural', () => {
  it('folds the usual plurals together', () => {
    for (const [a, b] of [
      ['eggs', 'egg'],
      ['berries', 'berry'],
      ['tomatoes', 'tomato'],
      ['peaches', 'peach'],
      ['boxes', 'box'],
      ['dishes', 'dish'],
      ['glasses', 'glass'],
      ['bananas', 'banana'],
      ['cookies', 'cookie'],
      ['sauces', 'sauce'],
      ['cheeses', 'cheese'],
    ])
      expect(wordKey(a)).toBe(wordKey(b));
  });

  it('leaves words that only look plural alone', () => {
    expect(wordKey('hummus')).toBe('hummus');
    expect(wordKey('glass')).toBe('glass');
    expect(wordKey('gas')).toBe('gas');
    expect(wordKey('tahini')).toBe('tahini');
  });
});

describe('matchKey', () => {
  it('ignores case, spaces, punctuation, accents and a leading "some"', () => {
    expect(matchKey('  Full   Cream MILK! ')).toBe(matchKey('full cream milk'));
    expect(matchKey('Café coffee')).toBe(matchKey('cafe coffee'));
    expect(matchKey('Salt & Vinegar chips')).toBe(matchKey('salt and vinegar chip'));
    expect(matchKey('some eggs')).toBe(matchKey('Eggs'));
    expect(matchKey('Weet-Bix')).toBe(matchKey('weet bix'));
  });

  it('keeps letters of other alphabets', () => {
    expect(matchKey('Молоко')).toBe('молоко');
    expect(matchKey('牛奶')).toBe('牛奶');
    expect(matchKey('Кефир 2%')).not.toBe(matchKey('Молоко 2%'));
  });
});

describe('parseLine', () => {
  it('reads a number at the start or the end', () => {
    expect(parseLine('2 milk')).toMatchObject({ qty: 2, name: 'milk' });
    expect(parseLine('2 x milk')).toMatchObject({ qty: 2, name: 'milk' });
    expect(parseLine('3x eggs')).toMatchObject({ qty: 3, name: 'eggs', key: 'egg' });
    expect(parseLine('2 × Milk')).toMatchObject({ qty: 2, name: 'Milk' });
    expect(parseLine('milk x2')).toMatchObject({ qty: 2, name: 'milk' });
    expect(parseLine('milk x 3')).toMatchObject({ qty: 3, name: 'milk' });
    expect(parseLine('two milks')).toMatchObject({ qty: 2, name: 'milks', key: 'milk' });
    expect(parseLine('Some bread.')).toMatchObject({ qty: 1, name: 'bread' });
  });

  it("doesn't take numbers that are part of the thing", () => {
    expect(parseLine('7up')).toMatchObject({ qty: 1, name: '7up' });
    expect(parseLine('box 2')).toMatchObject({ qty: 1, name: 'box 2' });
    expect(parseLine('2xl bags')).toMatchObject({ qty: 1, name: '2xl bags' });
    expect(parseLine('0 milk')).toMatchObject({ qty: 1, name: '0 milk' });
    expect(parseLine('100 pack tissues')).toMatchObject({ qty: 1 });
    expect(parseLine('milk')).toEqual({ qty: 1, name: 'milk', key: 'milk' });
  });

  it('copes with nothing much', () => {
    expect(parseLine('')).toEqual({ qty: 1, name: '', key: '' });
    expect(parseLine('   ')).toEqual({ qty: 1, name: '', key: '' });
  });
});

describe('lineSummary', () => {
  it('shows how many when it is more than one', () => {
    expect(lineSummary('Milk', 1)).toBe('Milk');
    expect(lineSummary('Milk', undefined)).toBe('Milk');
    expect(lineSummary(' Milk  ', 3)).toBe('3 × Milk');
    // And reads back as the same thing.
    expect(parseLine(lineSummary('Free range eggs', 2))).toMatchObject({ qty: 2, name: 'Free range eggs' });
  });
});

describe('candidates', () => {
  it('links exactly one item', () => {
    expect(matchOne('milk', pantry)?.id).toBe('milk');
    expect(matchOne('MILK', pantry)?.id).toBe('milk');
    expect(matchOne('2 milk', pantry)?.id).toBe('milk');
    expect(matchOne('blueberry', pantry)?.id).toBe('berries');
    expect(matchOne('tomato', pantry)?.id).toBe('tom');
    expect(matchOne('a peach', pantry)?.id).toBe('peach');
    expect(matchOne('cafe coffee', pantry)?.id).toBe('cafe');
  });

  it('tries the whole words before the number comes off', () => {
    expect(matchOne('2 minute noodles', pantry)?.id).toBe('noodles');
  });

  it('gives none when nothing matches, and every one when several do', () => {
    expect(candidates('oat milk', pantry)).toEqual([]);
    expect(candidates('cheese', pantry)).toEqual([]);
    expect(matchOne('bread', pantry)).toBeUndefined();
    expect(candidates('bread', pantry).map((c) => c.id)).toEqual(['bread', 'bread2']);
  });

  it("doesn't link to an item that only has the word in it", () => {
    // "eggs" is exactly "Eggs", not "Free range eggs".
    expect(matchOne('eggs', pantry)?.id).toBe('egg');
    expect(matchOne('range', pantry)).toBeUndefined();
  });

  it('uses a saved alias first', () => {
    const aliases = { [matchKey('bread')]: 'bread2', [matchKey('cuppa')]: 'cafe', [matchKey('gone')]: 'nothing-now' };
    expect(matchOne('bread', pantry, aliases)?.id).toBe('bread2');
    expect(matchOne('Breads', pantry, aliases)?.id).toBe('bread2');
    expect(matchOne('2 cuppa', pantry, aliases)?.id).toBe('cafe');
    // An alias for an item that's been deleted is ignored.
    expect(matchOne('gone', pantry, aliases)).toBeUndefined();
    // Words like "constructor" aren't aliases.
    expect(matchOne('constructor', pantry, {})).toBeUndefined();
  });
});

describe('searchItems (the picker)', () => {
  it('puts exact matches first, then names starting with it, then names with the words in them', () => {
    const items = [
      { id: '1', name: 'Oat milk' },
      { id: '2', name: 'Milk' },
      { id: '3', name: 'Milk chocolate' },
      { id: '4', name: 'Full cream milk' },
      { id: '5', name: 'Bread' },
    ];
    expect(searchItems('milk', items).map((i) => i.name)).toEqual(['Milk', 'Milk chocolate', 'Full cream milk', 'Oat milk']);
    expect(searchItems('Milks', items)[0].name).toBe('Milk');
    expect(searchItems('cream mil', items).map((i) => i.name)).toEqual(['Full cream milk']);
    expect(searchItems('', items).map((i) => i.name)).toEqual(['Bread', 'Full cream milk', 'Milk', 'Milk chocolate', 'Oat milk']);
    expect(searchItems('zzz', items)).toEqual([]);
  });
});
