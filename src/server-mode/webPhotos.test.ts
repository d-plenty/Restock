// 0.9.5 (task 184): the web's product photos (CSP hosts, the big photo and its fallback), the
// catalogue's Previous / Next and keys, the Aisle group tip, and matching a special to a tracked item.
import { existsSync, readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { firstPhoto, IMAGE_HOSTS, ItemPhoto, PageArrows, pageForKey, photoLetter, photoUrl, stepPage } from './ui/deskShared';
import { AISLE_TIP_MIN, aisleTip } from './ui/DeskAisleTip';
import { trackedGroup, trackedIndex } from './ui/DeskSpecials';

const W = 'https://cdn0.woolworths.media/content/wowproductimages/medium/123456.jpg';

describe('product photos on the web', () => {
  // The server lives in its own repo (restock-server); this runs where it sits in server/ (the dev tree).
  const SERVER = new URL('../../server/src/server.mjs', import.meta.url);
  it.skipIf(!existsSync(SERVER))('keeps the same picture hosts as the server CSP (img-src)', () => {
    const src = readFileSync(SERVER, 'utf8');
    const block = src.slice(src.indexOf('export const IMAGE_HOSTS'), src.indexOf('];', src.indexOf('export const IMAGE_HOSTS')));
    const hosts = [...block.matchAll(/'https:\/\/([^']+)'/g)].map((m) => m[1]);
    expect(hosts.length).toBeGreaterThan(5);
    expect([...IMAGE_HOSTS].sort()).toEqual([...hosts].sort());
  });

  it('shows only https pictures from the shops’ hosts', () => {
    expect(photoUrl(W)).toBe(W);
    expect(photoUrl('https://productimages.coles.com.au/productimages/5/5551234.jpg')).toBeTruthy();
    expect(photoUrl('https://dm.apac.cms.aldi.cx/is/image/aldiprodapac/product/jpg/scaleWidth/600/x')).toBeTruthy();
    expect(photoUrl('https://static.chemistwarehouse.com.au/ams/media/pi/149154/F2D_800.jpg')).toBeTruthy();
    expect(photoUrl('http://cdn0.woolworths.media/a.jpg')).toBeUndefined();
    expect(photoUrl('https://woolworths.media/a.jpg')).toBeUndefined(); // *.host is subdomains only, as in CSP
    expect(photoUrl('https://cdn0.woolworths.media.evil.example/a.jpg')).toBeUndefined();
    expect(photoUrl('https://evilwoolworths.media/a.jpg')).toBeUndefined();
    expect(photoUrl('https://x@productimages.coles.com.au/a.jpg')).toBeUndefined();
    expect(photoUrl('https://www.thebottle-o.com.au/i/a1.png')).toBeUndefined();
    expect(photoUrl('javascript:alert(1)')).toBeUndefined();
    expect(photoUrl(42)).toBeUndefined();
    expect(photoUrl(undefined)).toBeUndefined();
  });

  it('picks the first product with a photo it may show', () => {
    expect(firstPhoto(undefined, { imageUrl: 'https://elsewhere.example/a.jpg' }, { imageUrl: W })).toBe(W);
    expect(firstPhoto({}, undefined)).toBeUndefined();
  });

  it('the placeholder letter', () => {
    expect(photoLetter('coca-cola')).toBe('C');
    expect(photoLetter('  1kg rice')).toBe('1');
    expect(photoLetter('éclairs')).toBe('É');
    expect(photoLetter('')).toBe('?');
    expect(photoLetter('…')).toBe('?');
  });

  it('draws a big photo (named, lazy, large size first) or the letter, never a broken image', () => {
    const img = renderToStaticMarkup(createElement(ItemPhoto, { src: W, name: 'Coca-Cola' }));
    expect(img).toContain('alt="Coca-Cola"');
    expect(img).toContain('loading="lazy"');
    expect(img).toContain('/wowproductimages/large/123456.jpg');
    expect(img.toLowerCase()).toContain('referrerpolicy="no-referrer"');
    expect(img).toMatch(/class="dk-photo big"/);
    for (const src of [undefined, '', 'https://elsewhere.example/a.jpg', 'http://cdn0.woolworths.media/a.jpg']) {
      const none = renderToStaticMarkup(createElement(ItemPhoto, { src, name: 'Bagels' }));
      expect(none).not.toContain('<img');
      expect(none).toContain('dk-photo big none');
      expect(none).toContain('role="img"');
      expect(none).toContain('aria-label="Bagels, no photo"');
      expect(none).toContain('>B<');
    }
  });
});

describe('catalogue pages', () => {
  it('Previous and Next stay within the pages', () => {
    expect(stepPage(0, -1, 7)).toBe(0);
    expect(stepPage(0, 1, 7)).toBe(1);
    expect(stepPage(6, 1, 7)).toBe(6);
    expect(stepPage(9, 0, 7)).toBe(6);
    expect(stepPage(-3, 0, 7)).toBe(0);
    expect(stepPage(2.6, 0, 7)).toBe(3);
    expect(stepPage(0, 1, 0)).toBe(0);
  });

  it('← → Home End turn the page; other keys do nothing', () => {
    expect(pageForKey('ArrowRight', 2, 7)).toBe(3);
    expect(pageForKey('ArrowLeft', 2, 7)).toBe(1);
    expect(pageForKey('ArrowLeft', 0, 7)).toBe(0);
    expect(pageForKey('ArrowRight', 6, 7)).toBe(6);
    expect(pageForKey('Home', 4, 7)).toBe(0);
    expect(pageForKey('End', 1, 7)).toBe(6);
    expect(pageForKey('ArrowDown', 1, 7)).toBeUndefined();
    expect(pageForKey('a', 1, 7)).toBeUndefined();
  });

  it('the arrows say where you are and are off at the ends', () => {
    const go = () => undefined;
    const first = renderToStaticMarkup(createElement(PageArrows, { page: 0, count: 7, name: 'Cover', onGo: go, where: 'top' }));
    expect(first.replace(/<!-- -->/g, '')).toContain('Page 1 of 7');
    expect(first).toMatch(/<button[^>]*disabled[^>]*>.*Previous/);
    expect(first).not.toMatch(/<button[^>]*disabled[^>]*>Next/);
    const last = renderToStaticMarkup(createElement(PageArrows, { page: 6, count: 7, name: 'Coles', onGo: go, where: 'bottom' }));
    expect(last.replace(/<!-- -->/g, '')).toContain('Page 7 of 7');
    expect(last).toMatch(/<button[^>]*disabled[^>]*>Next/);
    expect(renderToStaticMarkup(createElement(PageArrows, { page: 0, count: 1, onGo: go, where: 'top' }))).toBe('');
  });
});

describe('the Aisle group tip', () => {
  const cats = new Set(['dairy', 'bakery']);
  const lines = (cs: (string | undefined)[]) => cs.map((c, i) => ({ id: String(i), c }));
  const of = (l: { c?: string }) => l.c;
  it('shows when more than half the lines are in Other', () => {
    expect(aisleTip(lines([undefined, undefined, 'dairy']), of, cats).show).toBe(true);
    expect(aisleTip(lines([undefined, 'gone', 'dairy', undefined, 'bakery']), of, cats).show).toBe(true); // a deleted category is Other
  });
  it('not when half or fewer are, or the list is short', () => {
    expect(aisleTip(lines([undefined, undefined, 'dairy', 'bakery']), of, cats).show).toBe(false);
    expect(aisleTip(lines(['dairy', 'bakery', 'dairy']), of, cats).show).toBe(false);
    expect(aisleTip(lines([undefined, undefined]), of, cats).show).toBe(false);
    expect(AISLE_TIP_MIN).toBe(3);
    expect(aisleTip([], of, cats)).toEqual({ other: [], show: false });
  });
  it('lists the lines in Other', () => {
    expect(aisleTip(lines([undefined, 'dairy', 'x']), of, cats).other.map((l) => l.id)).toEqual(['0', '2']);
  });
});

describe('a special you track opens its item', () => {
  const recs = [
    { group: { id: 'g-beans' }, options: [{ product: { chain: 'woolworths', storeProductId: '102', name: 'Heinz Baked Beanz 4 x 220g' } }] },
    { group: { id: 'g-milk' }, options: [{ product: { chain: 'coles', name: 'Coles Full Cream Milk 3L' } }] },
  ];
  const index = trackedIndex(recs);
  it('by the shop’s product number, or the same name at the same shop', () => {
    expect(trackedGroup(index, { chain: 'woolworths', storeProductId: '102', name: 'anything' })).toBe('g-beans');
    expect(trackedGroup(index, { chain: 'woolworths', storeProductId: '999', name: 'Heinz Baked Beanz 4 × 220g' })).toBe('g-beans');
    expect(trackedGroup(index, { chain: 'coles', storeProductId: 'c9', name: 'coles full cream milk 3l' })).toBe('g-milk');
  });
  it('not at another shop, or another product', () => {
    expect(trackedGroup(index, { chain: 'coles', storeProductId: '102', name: 'Heinz Baked Beanz 4 x 220g' })).toBeUndefined();
    expect(trackedGroup(index, { chain: 'woolworths', storeProductId: '101', name: "Arnott's Tim Tam Original 200g" })).toBeUndefined();
  });
});
