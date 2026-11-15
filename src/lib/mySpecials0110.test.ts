import { describe, expect, it } from 'vitest';
import type { StoreProduct } from '../stores/types';
import type { CatalogueDeal } from './myCatalogue';
import { filterSpecials, shopSpecials } from './mySpecials';
import type { SeenRow } from './seen';

const deal = (id: string, name: string, price: number, was: number) =>
  ({ rec: { group: { id, name: `My ${name}` } }, option: { price, product: { chain: 'coles', storeProductId: id, id: `p-${id}`, name } }, badge: 'HALF PRICE', was, saving: was - price, note: '' }) as unknown as CatalogueDeal;
const sp = (id: string, name: string, price: number, wasPrice?: number) => ({ chain: 'coles', storeProductId: id, name, price, wasPrice, isSpecial: true }) as StoreProduct;
const seen = (id: string, name: string, price: number, was: number | null) =>
  ({ chain: 'coles', store_product_id: id, day: '2026-11-12', name, brand: null, size: null, barcode: null, image_url: null, price, was_price: was, is_special: 1, member_only: 0, promo: null, in_stock: 1 }) as SeenRow;

describe('0.11.0: My specials, a list for each shop', () => {
  const all = shopSpecials([deal('1', 'Wheat biscuits 1.2kg', 5, 7)], [sp('1', 'Wheat biscuits 1.2kg', 5, 7), sp('2', 'Butter 500g', 4, 8)], [seen('2', 'Butter 500g', 4, 8), seen('3', 'Yoghurt 1kg', 4.5, null)]);
  it('shows each product once: yours first, then the shop’s list, then what searches found', () => {
    expect(all.map((s) => [s.key, s.from])).toEqual([
      ['coles|1', 'yours'],
      ['coles|2', 'list'],
      ['coles|3', 'seen'],
    ]);
    expect(all[0].groupName).toBe('My Wheat biscuits 1.2kg');
    expect(all[2].saving).toBe(0); // nothing to compare with
  });
  it('sorts by biggest saving, lowest price or A–Z', () => {
    expect(filterSpecials(all, '', 'saving').map((s) => s.name)).toEqual(['Butter 500g', 'Wheat biscuits 1.2kg', 'Yoghurt 1kg']);
    expect(filterSpecials(all, '', 'price').map((s) => s.name)).toEqual(['Butter 500g', 'Yoghurt 1kg', 'Wheat biscuits 1.2kg']);
    expect(filterSpecials(all, '', 'az').map((s) => s.name)).toEqual(['Butter 500g', 'Wheat biscuits 1.2kg', 'Yoghurt 1kg']);
  });
  it('searches every word typed, in any order', () => {
    expect(filterSpecials(all, 'biscuits wheat', 'az').map((s) => s.key)).toEqual(['coles|1']);
    expect(filterSpecials(all, 'my', 'az').map((s) => s.key)).toEqual(['coles|1']); // your own name for it counts
    expect(filterSpecials(all, 'milk', 'az')).toEqual([]);
  });
});
