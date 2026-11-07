import { describe, expect, it } from 'vitest';
import { catalogueLinkIn } from './catalogues';

describe('finding a catalogue link on a homepage', () => {
  const base = 'https://www.examplechemist.com.au';
  it('picks the link that says catalogue', () => {
    const html = `<nav><a href="/specials">Specials</a><a href="/catalogue/current"><span>Our Catalogue</span></a><a href="/about">About</a></nav>`;
    expect(catalogueLinkIn(html, base)).toBe('https://www.examplechemist.com.au/catalogue/current');
  });
  it('follows links out to catalogue sites, but not to random sites', () => {
    expect(catalogueLinkIn('<a href="https://salefinder.com.au/examplechemist-catalogue">View catalogue</a>', base)).toBe(
      'https://salefinder.com.au/examplechemist-catalogue',
    );
    expect(catalogueLinkIn('<a href="https://www.facebook.com/catalogue">Catalogue</a>', base)).toBeUndefined();
  });
  it('finds nothing when there is no catalogue', () => {
    expect(catalogueLinkIn('<a href="/shop">Shop</a><a href="/contact">Contact</a>', base)).toBeUndefined();
  });
});
