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

describe('sizes with a thousands comma (0.7.6)', () => {
  it('reads "1,120 sheets" as 1120 and orders and prices by it', async () => {
    const { parseSize } = await import('./units');
    expect(parseSize('1,120 sheets')).toEqual({ qty: 1120, unit: 'ea' });
    expect(parseSize('4,320 sheets')?.qty).toBe(4320);
    expect(parseSize('1,5 kg')).not.toEqual({ qty: 15, unit: 'g' });
    const l = [o('aldi', 'TT 24 Pack', '4,320 sheets', 8.39), o('aldi', 'TT 8 Pack', '1,120 sheets', 4.99), o('aldi', 'TT DL 4 Pack', '1,440 sheets', 3.59)];
    expect(orderOptions(l, 'size').map((x) => x.product.size)).toEqual(['1,120 sheets', '1,440 sheets', '4,320 sheets']);
  });
});
