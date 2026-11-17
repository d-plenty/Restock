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
  it('More has Open my catalogue and Your shops, on the phone and the iPhone web page', () => {
    for (const f of ['./screens/More.tsx', '../server-mode/ui/PhoneLayout.tsx']) {
      const src = read(f);
      expect(src).toContain('title="Open my catalogue"');
      expect(src).toContain('title="Your shops"');
      expect(src).not.toContain('title="Catalogues and specials"');
    }
  });
  it('Home has the catalogue button and a button per shop, and no deal lists', () => {
    const src = read('./screens/Home.tsx');
    expect(src).toContain('Open my catalogue');
    expect(src).toContain("name: 'shopcatalogue'");
    expect(src).not.toContain('Your items on special');
  });
  it("a tile's corner says whose it is, or how good", () => {
    expect(tileBadge({ from: 'yours', price: 5, was: 10 })).toEqual({ text: 'Your item', mine: true });
    expect(tileBadge({ from: 'list', price: 5, was: 10 })).toEqual({ text: 'Half price', mine: false });
    expect(tileBadge({ from: 'seen', price: 8, was: 10 })).toEqual({ text: 'Special', mine: false });
    expect(tileBadge({ from: 'seen', price: 8 })).toEqual({ text: 'Special', mine: false });
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
