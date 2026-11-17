import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { tileBadge, possessive, FULL_LIST } from './screens/ShopCatalogue';

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

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
    expect(tileBadge({ from: 'yours' })).toEqual({ text: 'Your item', mine: true });
    expect(tileBadge({ from: 'list' })).toEqual({ text: 'On your list', mine: false });
    expect(tileBadge({ from: 'seen' })).toEqual({ text: 'On your list', mine: false });
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
