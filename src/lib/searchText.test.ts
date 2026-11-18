import { describe, expect, it } from 'vitest';
import { cleanSearch } from './searchText';

describe('0.12.6: a search ignores punctuation on the end', () => {
  it('voice typing: "Lemon." is lemon', () => {
    expect(cleanSearch('Lemon.')).toBe('Lemon');
    expect(cleanSearch('  milk 2L,  ')).toBe('milk 2L');
    expect(cleanSearch('bread?!')).toBe('bread');
  });
  it('leaves punctuation inside alone', () => {
    expect(cleanSearch("Arnott's Tim Tam 1.5kg")).toBe("Arnott's Tim Tam 1.5kg");
    expect(cleanSearch('dr. oetker')).toBe('dr. oetker');
  });
  it('nothing but punctuation is nothing', () => {
    expect(cleanSearch(' . ')).toBe('');
  });
});
