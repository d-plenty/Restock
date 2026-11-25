import { readSource } from '../lib/readSource';
import { describe, expect, it } from 'vitest';
import { dealWord } from '../lib/mySpecials';
import { tileBadge, possessive, FULL_LIST } from './screens/ShopCatalogue';

const read = (p: string) => readSource(new URL(p, import.meta.url));

describe('0.12.2: catalogues from Home, Your shops', () => {
  it('the map never lets the map server write HTML into the page', () => {
    const src = read('./StoreMap.tsx');
    expect(src).toContain('attributionControl: false');
    expect(src).toContain('OpenStreetMap contributors');
  });
  it('Home has a button per shop, and no deal lists', () => {
    const src = read('./screens/Home.tsx');
    expect(src).toContain("name: 'shopcatalogue'");
    expect(src).not.toContain('Your items on special');
  });
  it("a tile's corner says whose it is (0.12.3: only your own things are shown)", () => {
    // 0.12.6: the corner says the kind of deal (it said "Your item" on every tile).
    expect(tileBadge({ deal: dealWord('great') })).toEqual({ text: 'Great deal', tone: 'good' });
    expect(tileBadge({ deal: dealWord('good') })).toEqual({ text: 'On special', tone: 'good' });
    expect(tileBadge({ deal: dealWord('small') })).toEqual({ text: 'Small saving', tone: 'good' });
    expect(tileBadge({ deal: dealWord('good', { n: 2, total: 5.6 }) })).toEqual({ text: '2 for $5.60', tone: 'good' });
    expect(tileBadge({ deal: dealWord('wait') })).toEqual({ text: 'Wait for a better special', tone: 'wait' });
    expect(tileBadge({ deal: dealWord('fake') })).toEqual({ text: 'Not a real special', tone: 'fake' });
  });
  it('names and the shops with a list of their own', () => {
    expect(possessive('Coles')).toBe("Coles'");
    expect(possessive('Aldi')).toBe("Aldi's");
    expect(FULL_LIST).toEqual(['woolworths', 'coles']);
  });
  it('nothing pre-selects or favours a shop on Home: every shop gets the same button', () => {
    const src = read('./screens/Home.tsx');
    expect(src).toContain('shops.map((c) =>');
  });
});
