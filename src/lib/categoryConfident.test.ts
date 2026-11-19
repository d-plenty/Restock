import { describe, expect, it } from 'vitest';
import { confidentCategoryId } from './categoryGuess';

const cats = [
  { id: 'p', name: 'Pantry', section: 'pantry' as const },
  { id: 'f', name: 'Fridge and freezer', section: 'pantry' as const },
  { id: 'c', name: 'Cleaning', section: 'pantry' as const },
  { id: 'b', name: 'Bathroom', section: 'pantry' as const },
];

describe('0.12.7: a category is chosen for you only when Restock is sure', () => {
  it('the name says it and the picks agree', () => {
    expect(confidentCategoryId('Strawberry jam', ['Cottees Strawberry Jam 375g', 'Strawberry Premium Jam 360g'], cats, 'pantry')).toBe('p');
    expect(confidentCategoryId('Shampoo', ['Thanks To Nature Hydrate Shampoo 500mL'], cats, 'pantry')).toBe('b');
  });
  it('the name says one thing and a pick another: not sure', () => {
    expect(confidentCategoryId('Milk', ['Dishwashing Liquid Milk & Honey 500mL'], cats, 'pantry')).toBeUndefined();
  });
  it('no name yet: every pick has to say the same', () => {
    expect(confidentCategoryId('', ['Heinz Baked Beans 420g', 'SPC Baked Beans 425g'], cats, 'pantry')).toBe('p');
    expect(confidentCategoryId('', ['Heinz Baked Beans 420g', 'Mystery Thing'], cats, 'pantry')).toBeUndefined();
  });
  it('a name that fits nothing, and picks that fit nothing: none', () => {
    expect(confidentCategoryId('Gizmo', ['Gizmo 3000'], cats, 'pantry')).toBeUndefined();
  });
  it('only on the Pantry tab', () => {
    expect(confidentCategoryId('Jam', ['Jam'], cats, 'keg')).toBeUndefined();
  });
});
