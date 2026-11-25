import { describe, expect, it } from 'vitest';
import { guessCategoryId, ownCategoryId } from './categoryGuess';

const cats = (names: string[]) => names.map((name, i) => ({ id: `c${i}`, name, section: 'pantry' as const }));
const START = ['Pantry', 'Fridge & freezer', 'Cleaning', 'Bathroom'];
const pick = (name: string, names: string[], products: string[] = []) => {
  const all = cats(names);
  return all.find((c) => c.id === guessCategoryId([name, ...products], all, 'pantry'))?.name;
};

describe('0.11.3: sorting into categories you made yourself', () => {
  it('a category named for the thing takes items with that word', () => {
    expect(pick('Coffee pods', [...START, 'Coffee'])).toBe('Coffee');
    expect(pick('Whiskers cat food', [...START, 'Whiskers'])).toBe('Whiskers');
    expect(pick('Soft drink', [...START, 'Drinks'])).toBe('Drinks');
    expect(pick('Nappies', [...START, 'Nappy'])).toBe('Nappy');
  });
  it('a category for a kind of thing takes what plainly belongs in it', () => {
    expect(pick('Corn chips', [...START, 'Snacks'])).toBe('Snacks');
    expect(pick('Creaming soda', [...START, 'Drinks'])).toBe('Drinks');
    expect(pick('Weet-Bix', [...START, 'Breakfast'])).toBe('Breakfast');
    expect(pick('Bagels', [...START, 'Bakery'])).toBe('Bakery');
    expect(pick('Dog food', [...START, 'Pets'])).toBe('Pets');
  });
  it('without a category of your own, the four starting ones are used as before', () => {
    expect(pick('Corn chips', START)).toBe('Pantry');
    expect(pick('Shampoo', [...START, 'Snacks'])).toBe('Bathroom');
    expect(pick('Milk', [...START, 'Snacks'])).toBe('Fridge & freezer');
    expect(pick('Glass cleaner', [...START, 'Coffee'])).toBe('Cleaning');
  });
  it('a vague category name takes nothing, and a name that fits nothing stays in Other', () => {
    expect(pick('Food wrap', [...START, 'Other food'])).not.toBe('Other food');
    expect(ownCategoryId('Baked beans', [{ id: 'x', name: 'Things' }])).toBeUndefined();
    expect(pick('Gift card', [...START, 'Snacks'])).toBeUndefined();
  });
  it('only an item\'s own name picks your category, not its products\' names', () => {
    expect(pick('Bickfords', [...START, 'Coffee'], ['Bickfords Iced Coffee Syrup 500mL'])).not.toBe('Coffee');
  });
  it('other tabs are left alone', () => {
    const all = cats(['Wine']).map((c) => ({ ...c, section: 'keg' as const }));
    expect(guessCategoryId(['Red wine'], all, 'keg')).toBeUndefined();
  });
});
