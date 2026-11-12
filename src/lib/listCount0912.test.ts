import { describe, expect, it } from 'vitest';
import { splitCount } from './listActions';

describe('a count typed on the list (0.9.12)', () => {
  it('takes the count off the words', () => {
    expect(splitCount('2 coconut cream')).toEqual({ text: 'coconut cream', qty: 2 });
    expect(splitCount('3x milk')).toEqual({ text: 'milk', qty: 3 });
    expect(splitCount('bread x2')).toEqual({ text: 'bread', qty: 2 });
    expect(splitCount('eggs 2x')).toEqual({ text: 'eggs', qty: 2 });
  });
  it('leaves names that start with a number alone', () => {
    expect(splitCount('2 minute noodles')).toEqual({ text: '2 minute noodles', qty: 1 });
    expect(splitCount('3 in 1 coffee')).toEqual({ text: '3 in 1 coffee', qty: 1 });
    expect(splitCount('7up')).toEqual({ text: '7up', qty: 1 });
    expect(splitCount('2L milk')).toEqual({ text: '2L milk', qty: 1 });
    expect(splitCount('100 coffee pods')).toEqual({ text: '100 coffee pods', qty: 1 });
    expect(splitCount('  milk  ')).toEqual({ text: 'milk', qty: 1 });
  });
});
