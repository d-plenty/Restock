import { DOMParser as LinkeDOMParser } from 'linkedom';
import { describe, expect, it } from 'vitest';
import { asHttps, sameSite, searchOnSite, siteOf } from './site';
import { findSearch } from '../stores/webPage';

// 0.9.0: a shop's search page has to be https and on the shop's own site.

const parse = (html: string) => new LinkeDOMParser().parseFromString(html, 'text/html') as unknown as Document;

describe('the same site', () => {
  it('knows the site a web address belongs to', () => {
    expect(siteOf('www.chemistwarehouse.com.au')).toBe('chemistwarehouse.com.au');
    expect(siteOf('shop.example.com.au')).toBe('example.com.au');
    expect(siteOf('bws.com.au')).toBe('bws.com.au');
    expect(siteOf('www.example.com')).toBe('example.com');
    expect(siteOf('cdn.shop.example.co.nz')).toBe('example.co.nz');
  });

  it('only counts https addresses with a domain name, on the same site', () => {
    expect(asHttps('http://www.example.com.au/x')?.protocol).toBe('https:');
    expect(asHttps('javascript:alert(1)')).toBeUndefined();
    expect(asHttps('https://localhost/search')).toBeUndefined();
    expect(sameSite('https://search.example.com.au/?q={q}', 'https://www.example.com.au')).toBe(true);
    expect(sameSite('https://www.other.com.au/?q={q}', 'https://www.example.com.au')).toBe(false);
    expect(sameSite('https://example.com.au.evil.example/?q={q}', 'https://www.example.com.au')).toBe(false);
    expect(searchOnSite('https://www.example.com.au/search', 'https://www.example.com.au')).toBeUndefined();
    expect(searchOnSite('http://www.example.com.au/search?q={q}', 'https://www.example.com.au')).toBe('https://www.example.com.au/search?q={q}');
  });
});

describe('finding a shop’s search page (0.9.0)', () => {
  it('passes over a search link that goes to another site', () => {
    const html = `<script type="application/ld+json">{"@type":"WebSite","potentialAction":{"@type":"SearchAction","target":"https://evil.example/find?q={search_term_string}"}}</script>
      <form action="https://tracker.example/search" method="get"><input type="search" name="q"></form>
      <form action="/catalogsearch/result/" method="get"><input type="search" name="q"></form>`;
    expect(findSearch(html, 'https://www.pharmacy4less.com.au', parse).search).toBe('https://www.pharmacy4less.com.au/catalogsearch/result/?q={q}');
  });

  it('uses a search link on the shop’s own site, moved to https', () => {
    const html = `<script type="application/ld+json">{"@type":"WebSite","potentialAction":{"@type":"SearchAction","target":"http://search.liquorland.com.au/?q={search_term_string}"}}</script>`;
    expect(findSearch(html, 'https://www.liquorland.com.au', parse).search).toBe('https://search.liquorland.com.au/?q={q}');
  });

  it('falls back to the usual search page when nothing on the page is usable', () => {
    const html = `<form action="https://elsewhere.example/s" method="get"><input name="q"></form>`;
    expect(findSearch(html, 'https://www.example.com.au', parse).search).toBe('https://www.example.com.au/search?q={q}');
  });
});
