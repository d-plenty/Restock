import { describe, expect, it } from 'vitest';
import { categoryKind, guessCategoryId } from './categoryGuess';

const cats = [
  { id: 'p', name: 'Pantry', section: 'pantry' as const },
  { id: 'f', name: 'Fridge & freezer', section: 'pantry' as const },
  { id: 'c', name: 'Cleaning', section: 'pantry' as const },
  { id: 'b', name: 'Bathroom', section: 'pantry' as const },
  { id: 'k', name: 'Beer', section: 'keg' as const },
];

describe('a category from the name (0.11.2)', () => {
  it('sorts everyday names', () => {
    const kinds = (xs: string[]) => xs.map(categoryKind);
    expect(kinds(['baked beans', 'Barbecue sauce', 'BLACK BEANS', 'Bagels', 'Nutella', 'Vegemite', 'Popcorn', 'Lemonade', 'Coffee', 'Corn Thins Original', 'Maple syrup', 'Mi goreng Noodles'])).toEqual(Array(12).fill('pantry'));
    expect(kinds(['Full cream milk', 'Eggs', 'Butter spread', 'Greek Style Fetta', 'Frozen vegetables', 'Frozen Wedges', 'Potato gems', 'Fresh Grove juice', 'Salted Butter', 'Frozen Sausage Rolls'])).toEqual(Array(10).fill('fridge'));
    expect(kinds(['Dishwashing Tablets', 'Dishwashing liquid', 'Glass Cleaner', 'Glen 20 disinfected', 'Toilet block', 'Toilet Cleaner', 'Rinse Aid', 'Magic Eraser', 'Colour Catcher'])).toEqual(Array(9).fill('cleaning'));
    expect(kinds(['Body wash', 'Conditioner', 'Shampoo', "Women's deodorant", "Men's roll-on deodorant", 'Toilet paper'])).toEqual(Array(6).fill('bathroom'));
  });
  it('shelf things that sound like the fridge stay on the shelf', () => {
    for (const n of ['Coconut cream', 'Coconut milk', 'Long life Full cream milk', 'Creaming Soda', 'Milk chocolate chips', 'Peanut butter'])
      expect(categoryKind(n), n).toBe('pantry');
  });
  it('says nothing when the name says nothing', () => {
    expect(categoryKind('Bickfords')).toBeUndefined();
    expect(categoryKind('Sistema containers')).toBeUndefined();
    expect(categoryKind('')).toBeUndefined();
  });
  it('picks your own category by its name, in the Pantry tab only', () => {
    expect(guessCategoryId(['Shampoo'], cats, 'pantry')).toBe('b');
    expect(guessCategoryId(['Bickfords', 'Bickfords Blackcurrant Cordial 750mL'], cats, 'pantry')).toBe('p');
    expect(guessCategoryId(['Milk'], cats, 'pantry')).toBe('f');
    expect(guessCategoryId(['Glass Cleaner'], cats, 'pantry')).toBe('c');
    expect(guessCategoryId(['Lager'], cats, 'keg')).toBeUndefined();
    expect(guessCategoryId(['Shampoo'], [{ id: 'x', name: 'Stuff', section: 'pantry' }], 'pantry')).toBeUndefined();
    expect(guessCategoryId(['Sistema containers'], cats, 'pantry')).toBeUndefined();
  });
});
