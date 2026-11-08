import { describe, expect, it } from 'vitest';
import { orderOptions } from './productOrder';
import type { Option } from './verdict';

const o = (chain: string, name: string, size: string, price: number) =>
  ({ product: { id: name + chain, chain, name, size }, role: 'main', price, unitPrice: price, locked: false }) as unknown as Option;

const list = [
  o('coles', 'Nutella Hazelnut Spread', '1kg', 14.8),
  o('aldi', 'Nutella 400g', '400g', 6.69),
  o('woolworths', 'Nutella Hazelnut Spread', '750g', 10),
  o('woolworths', 'Nutella Hazelnut Spread', '400g', 6.7),
  o('woolworths', 'Nutella Hazelnut Spread', '1kg', 14.8),
];
const show = (l: Option[]) => l.map((x) => `${x.product.chain} ${x.product.size}`);

describe('product order (0.7.6)', () => {
  it('by shop, then smallest first', () => {
    expect(show(orderOptions(list, 'size'))).toEqual(['woolworths 400g', 'woolworths 750g', 'woolworths 1kg', 'coles 1kg', 'aldi 400g']);
  });
  it('cheapest first, across shops', () => {
    expect(show(orderOptions(list, 'cheapest'))[0]).toBe('aldi 400g');
    expect(orderOptions(list, 'cheapest').map((x) => x.price)).toEqual([6.69, 6.7, 10, 14.8, 14.8]);
  });
  it('packs sort by their total size', () => {
    const l = [o('woolworths', 'Popcorn 4 pack', '100g x 4 pack', 7), o('woolworths', 'Popcorn', '100g', 1)];
    expect(show(orderOptions(l, 'size'))).toEqual(['woolworths 100g', 'woolworths 100g x 4 pack']);
  });
});
