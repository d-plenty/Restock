import { describe, expect, it } from 'vitest';
import { flavourLabels, flavourNote, flavourWord } from './flavours';

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
});
