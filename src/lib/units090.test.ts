// 0.9.0 audit fixes: sizes like ".5kg", prices typed with a dollar sign, and no "$Infinity".
import { describe, expect, it } from 'vitest';
import { formatUnitPrice, money, packSize, parseMoney, parseSize } from './units';

describe('sizes', () => {
  it('reads a size with no leading zero', () => {
    expect(parseSize('.5kg')).toEqual({ qty: 500, unit: 'g' });
    expect(parseSize('.75 L')).toEqual({ qty: 750, unit: 'ml' });
    expect(parseSize('6 x .5l')).toEqual({ qty: 3000, unit: 'ml' });
  });

  it('reads the usual sizes as before', () => {
    expect(parseSize('0.5kg')).toEqual({ qty: 500, unit: 'g' });
    expect(parseSize('1.5kg')).toEqual({ qty: 1500, unit: 'g' });
    expect(parseSize('500g')).toEqual({ qty: 500, unit: 'g' });
    expect(parseSize('6 x 375ml')).toEqual({ qty: 2250, unit: 'ml' });
    expect(packSize('30 Pack', 'Coke Cans 375ml')).toEqual({ qty: 11250, unit: 'ml', count: 30 });
  });
});

describe('typed prices', () => {
  it('takes a dollar sign, spaces and thousands commas', () => {
    expect(parseMoney('$4.50')).toBe(4.5);
    expect(parseMoney(' $ 4.50 ')).toBe(4.5);
    expect(parseMoney('4.50')).toBe(4.5);
    expect(parseMoney('$1,234.50')).toBe(1234.5);
    expect(parseMoney('12')).toBe(12);
  });

  it('reads a comma before the cents as the decimal point, not as $450', () => {
    expect(parseMoney('4,50')).toBe(4.5);
  });

  it('is NaN with no number', () => {
    expect(parseMoney('')).toBeNaN();
    expect(parseMoney('$')).toBeNaN();
    expect(parseMoney(undefined)).toBeNaN();
  });
});

describe('money', () => {
  it('never says $Infinity or $NaN', () => {
    expect(money(Infinity)).toBe('—');
    expect(money(-Infinity)).toBe('—');
    expect(money(NaN)).toBe('—');
    expect(money(undefined)).toBe('—');
    expect(formatUnitPrice(Infinity, 'g')).toBe('');
  });

  it('is unchanged for real amounts', () => {
    expect(money(4.5)).toBe('$4.50');
    expect(money(2387.81)).toBe('$2,387.81');
    expect(money(-3)).toBe('-$3.00');
    expect(formatUnitPrice(0.005, 'g')).toBe('$0.50 / 100g');
  });
});
