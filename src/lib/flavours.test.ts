import { describe, expect, it } from 'vitest';
import { flavourLabels, flavourNote, flavourWord, otherFlavours, sameButFlavour } from './flavours';

const WASH = ['Coles Simply Milk & Honey Body Wash 1L', 'Coles Revitalising Ocean Breeze Body Wash 1L', 'Coles Body Wash Guava & Peach 1L'];

describe('0.10.9 flavours, scents and colours', () => {
  it('names the kind of difference', () => {
    expect(flavourWord(WASH)).toBe('scents');
    expect(flavourWord(['Doritos Cheese Supreme 170g', 'Doritos Nacho Cheese 170g'])).toBe('flavours');
    expect(flavourWord(['Kleenex Tissues White', 'Kleenex Tissues Pink'])).toBe('colours');
  });
  it('keeps what tells them apart', () => {
    expect(flavourLabels(['Doritos Cheese Supreme 170g', 'Doritos Nacho Cheese 170g'])).toEqual(['Supreme', 'Nacho']);
    expect(flavourLabels(WASH)).toEqual(['Simply Milk & Honey', 'Revitalising Ocean Breeze', 'Guava & Peach']);
    expect(flavourLabels(['Milk 2L', 'Milk 2L'])).toEqual(['Milk 2L', 'Milk 2L']);
  });
  it('says which are on special', () => {
    expect(flavourNote(WASH, [true, true, true])).toBe('on special in all 3 scents');
    expect(flavourNote(['Doritos Cheese Supreme 170g', 'Doritos Nacho Cheese 170g', 'Doritos Original 170g'], [false, true, true])).toBe(
      'Nacho Cheese and Original on special, not Cheese Supreme',
    );
    expect(flavourNote(WASH, [false, true, false])).toBe('Revitalising Ocean Breeze on special, not Simply Milk & Honey and Guava & Peach');
    expect(flavourNote([...WASH, 'Coles Body Wash Lavender 1L', 'Coles Body Wash Mint 1L'], [false, true, false, true, false])).toBe('on special in 2 of your 5 scents');
    expect(flavourNote(WASH, [false, false, false])).toBeUndefined();
    expect(flavourNote(['Milk 2L'], [true])).toBeUndefined();
  });
  it('0.10.11: finds the other flavours of what is ticked', () => {
    const P = (name: string, size = '700g', brand = 'Pedigree') => ({ name, size, brand });
    const beef = P('Pedigree Wet Dog Food Beef 700g');
    const results = [
      beef,
      P('Pedigree Wet Dog Food Chicken & Rice 700g'),
      P('Pedigree Wet Dog Food Lamb 700g'),
      P('Pedigree Wet Dog Food Beef 1.2kg', '1.2kg'),
      P('My Dog Wet Dog Food Beef 700g', '700g', 'My Dog'),
      P('Pedigree Dry Dog Food Beef 700g'),
      P('Pedigree Dentastix 700g'),
    ];
    expect(otherFlavours([beef], results).map((r) => r.name)).toEqual(['Pedigree Wet Dog Food Chicken & Rice 700g', 'Pedigree Wet Dog Food Lamb 700g']);
    expect(otherFlavours([], results)).toEqual([]);
    expect(otherFlavours(results.slice(0, 3), results.slice(0, 3))).toEqual([]);
    expect(sameButFlavour({ name: 'Doritos Cheese Supreme 170g' }, { name: 'Doritos Nacho Cheese 170g' })).toBe(true);
    expect(sameButFlavour({ name: 'Coles Full Cream Milk 2L' }, { name: 'Coles Full Cream Milk 3L' })).toBe(false);
    expect(sameButFlavour({ name: 'Coles Full Cream Milk 2L' }, { name: 'Coles Full Cream Milk 2L' })).toBe(false);
  });
});
