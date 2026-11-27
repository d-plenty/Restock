import { readSource } from '../lib/readSource';
import { describe, expect, it } from 'vitest';
import { listLineKeys, ownSpecials, shopTileNote } from '../lib/ownSpecials';
import type { CatalogueDeal } from '../lib/myCatalogue';
import type { SeenRow } from '../lib/seen';
import type { StoreProduct } from '../stores/types';
import type { ListEntry } from '../types';

const read = (p: string) => readSource(new URL(p, import.meta.url));

const deal = (id: string, name: string, price: number, was: number) =>
  ({
    rec: { group: { id: `g-${id}`, name } },
    option: { price, product: { chain: 'coles', storeProductId: id, id: `p-${id}`, name } },
    badge: 'HALF PRICE',
    was,
    saving: was - price,
    note: '',
  }) as unknown as CatalogueDeal;
const product = (id: string, name: string, price: number, wasPrice?: number) =>
  ({ chain: 'coles', storeProductId: id, name, price, wasPrice, isSpecial: true }) as unknown as StoreProduct;
const line = (id: string, over: Partial<ListEntry> = {}): ListEntry =>
  ({ id: `l-${id}`, text: 'x', checked: false, createdAt: '', product: { chain: 'coles', name: 'x', storeProductId: id }, ...over }) as ListEntry;
const seen = (id: string, name: string): SeenRow =>
  ({ chain: 'coles', store_product_id: id, name, price: 3, was_price: 6, is_special: 1 }) as unknown as SeenRow;

describe('0.12.3: My catalogue merged into each shop, only your own things', () => {
  it("shows your items' sales and one-off list lines, and nothing else from the shop's list or searches", () => {
    const deals = [deal('1', 'Bagels', 3, 6)];
    const list = [product('1', 'Bagels', 3, 6), product('2', 'Bulla ice cream', 6.9, 12), product('3', 'Sistema 460ml', 4.25, 8.5)];
    const out = ownSpecials(deals, list, [seen('4', 'Bic lighter'), seen('5', 'Coffee')], [line('3'), line('5')]);
    expect(out.map((s) => [s.name, s.from])).toEqual([
      ['Bagels', 'yours'],
      ['Sistema 460ml', 'list'],
      ['Coffee', 'seen'],
    ]);
  });
  it('ticked-off lines and lines linked to an item are not one-off lines', () => {
    const keys = listLineKeys([line('1', { checked: true }), line('2', { groupId: 'g' }), line('3'), { id: 'x', text: 'milk', checked: false, createdAt: '' }]);
    expect([...keys]).toEqual(['coles|3']);
  });
  it('a shop with nothing of yours shows nothing', () => {
    expect(ownSpecials([], [product('2', 'Bulla ice cream', 6.9, 12)], [seen('4', 'Bic lighter')], [])).toEqual([]);
  });
  it("Home's shop buttons say how many, or none", () => {
    expect(shopTileNote(26)).toBe('26 on special');
    expect(shopTileNote(0)).toBe('None this week');
    expect(shopTileNote(undefined)).toBe('Your specials');
  });
  it('Open my catalogue is gone from Home, More, the iPhone web page and the web', () => {
    for (const f of ['./screens/Home.tsx', './screens/More.tsx']) {
      const src = read(f);
      expect(src).not.toContain('>Open my catalogue<');
      expect(src).not.toContain('title="Open my catalogue"');
      expect(src).not.toContain("name: 'mycatalogue'");
    }
    for (const f of ['./screens/More.tsx']) expect(read(f)).toContain('title="Your shops"');
    // 0.15.0: a wide web page's side bar is the iPad's, with Your shops in it.
    expect(read('./padWide.ts')).toContain("{ screen: 'catalogues', label: 'Your shops', icon: 'shop' }");
  });
  it("a shop's page leads with the whole catalogue and website, and has no All specials chip", () => {
    const src = read('./screens/ShopCatalogue.tsx');
    expect(src.indexOf('shopcat-top')).toBeLessThan(src.indexOf('shopcat-banner'));
    expect(src).not.toContain('All specials');
    expect(src).not.toContain('In my pantry');
    expect(src).toContain('ownSpecials(');
  });
  it('the weekly deals summary opens Home, and an old My catalogue link lands on Your shops', () => {
    const src = read('./App.tsx');
    expect(src).toContain("{top.name === 'mycatalogue' && <CataloguesScreen />}");
    expect(src).not.toContain("setStack([{ name: 'mycatalogue' }])");
  });
});
