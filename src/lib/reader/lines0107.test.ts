import { describe, expect, it } from 'vitest';
import { packName } from '../receipts';
import found from './fixtures/found0107.json';
import { toLines } from './lines';

// Real answers from the new text reader (PP-OCRv5 mobile) for two photos: a Bref toilet block
// pack, and a slightly crooked, blurry receipt.
describe('0.10.7 text reader: lines', () => {
  it('puts a crooked receipt back into lines, item and price together', () => {
    const { text } = toLines(found['receipt.jpg']);
    const lines = text.split('\n');
    expect(lines[0]).toBe('COLES SUPERMARKETS');
    expect(lines).toContain('WEET-BIX BITES 500G 6.50');
    expect(lines).toContain('DAIRY FARMERS MILK 2L 3.60');
    expect(lines.find((l) => l.startsWith('TOTAL'))).toBe('TOTAL 19.13');
  });

  it("finds the pack's name from its biggest words", () => {
    const { lines } = toLines(found['bref.jpg']);
    const name = packName(lines)!;
    expect(name).toBe('Bref SELF ACTIVE');
  });
});
