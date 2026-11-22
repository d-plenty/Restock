// 0.12.10: what was asked for, held to the source and to the small pieces that do the work.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { version } from '../../package.json';
import { nameKey, sameNameItem, sameNameWords } from '../lib/sameName';
import { parseTrip, reopensTrip, TRIP_KEEP_MS, TRIP_REOPEN_MS } from '../lib/trip';
import { WHATS_NEW } from '../lib/whatsNew';
import { extractProducts, fromEmbedded, withPhotos } from '../stores/webPage';
import { tryAgainWords } from './Unblock';

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const list = read('./screens/List.tsx');

describe('0.12.10: no two items with one name', () => {
  const items = [
    { id: 'a', name: 'Rinse aid', section: 'pantry' as const },
    { id: 'b', name: 'Glass Cleaner' },
  ];
  it('capitals, spaces and a full stop on the end do not count', () => {
    expect(nameKey('  Rinse   Aid. ')).toBe(nameKey('rinse aid'));
    expect(sameNameItem(items, 'Rinse Aid')?.id).toBe('a');
    expect(sameNameItem(items, 'RINSE AID')?.id).toBe('a');
    expect(sameNameItem(items, 'Rinse aid tablets')).toBeUndefined();
    expect(sameNameItem(items, '   ')).toBeUndefined();
    expect(sameNameItem(undefined, 'Rinse aid')).toBeUndefined();
  });
  it('an item keeps its own name, also when it was already doubled', () => {
    const doubled = [...items, { id: 'c', name: 'Rinse Aid' }];
    expect(sameNameItem(doubled, 'Rinse Aid', doubled[2])).toBeUndefined(); // edited without renaming
    expect(sameNameItem(doubled, 'rinse aid', doubled[2])).toBeUndefined(); // only its capitals changed
    expect(sameNameItem(doubled, 'Glass cleaner', doubled[2])?.id).toBe('b'); // renamed onto another
  });
  it('says which item has the name, and where', () => {
    expect(sameNameWords(items[0])).toBe('You already have Rinse aid in your pantry. Give this one a different name.');
  });
  it('is checked wherever an item is named', () => {
    expect(read('./screens/Add.tsx')).toMatch(/target !== 'list' && sameNameItem\(everyItem, name\)/);
    expect(read('./screens/Add.tsx')).toMatch(/target !== 'list' && takenItem/);
    expect(read('./screens/Item.tsx')).toMatch(/sameNameItem\(everyItem, name, group\)/);
    expect(read('../server-mode/ui/WebShopSearch.tsx')).toMatch(/target !== 'list' && takenItem/);
  });
});

describe('0.12.10: a shop that survives leaving the app', () => {
  const now = 1_800_000_000_000;
  const trip = { section: 'pantry', chosen: ['coles', 'aldi'], skip: [], at: 'coles', doneAt: ['aldi'], gotAt: [['e1', 'aldi']], open: true, saved: now - 60_000 };
  it('reads a kept trip back, and nothing else', () => {
    expect(parseTrip(JSON.stringify(trip), now)).toEqual(trip);
    expect(parseTrip(null, now)).toBeUndefined();
    expect(parseTrip('not json', now)).toBeUndefined();
    expect(parseTrip(JSON.stringify({ ...trip, chosen: [] }), now)).toBeUndefined();
    expect(parseTrip(JSON.stringify({ ...trip, chosen: 'coles' }), now)).toBeUndefined();
    expect(parseTrip(JSON.stringify({ ...trip, gotAt: [['e1'], 'x', ['e2', 'coles']] }), now)?.gotAt).toEqual([['e2', 'coles']]);
  });
  it('forgets another day’s shop', () => {
    expect(parseTrip(JSON.stringify({ ...trip, saved: now - TRIP_KEEP_MS - 1 }), now)).toBeUndefined();
    expect(parseTrip(JSON.stringify({ ...trip, saved: now + 3_600_000 }), now)).toBeUndefined(); // a clock set back
  });
  it('goes straight back in only when closed mid-shop, not long ago', () => {
    expect(reopensTrip(parseTrip(JSON.stringify(trip), now), now)).toBe(true);
    expect(reopensTrip({ ...trip, gotAt: [], open: false }, now)).toBe(false); // paused: it is offered instead
    expect(reopensTrip({ ...trip, gotAt: [], saved: now - TRIP_REOPEN_MS - 1 }, now)).toBe(false);
    expect(reopensTrip(undefined, now)).toBe(false);
  });
  it('the list offers Resume shopping and Start fresh, and shopping mode has Pause and Add to list', () => {
    expect(list).toMatch(/Resume shopping\s*<\/button>\s*<button className="btn" onClick=\{startShopping\}>\s*Start fresh/);
    expect(list).toMatch(/\{left\.length \? 'Pause' : 'Done'\}/);
    expect(list).toMatch(/<Icon name="plus" size=\{16\} \/> Add to list/);
    expect(list).toMatch(/onFinish=\{finish\}/);
    expect(read('./screens/Home.tsx')).toMatch(/You were shopping/);
    expect(read('./App.tsx')).toMatch(/reopensTrip\(loadTrip\(\), Date\.now\(\)\) \? 'list' : 'home'/);
  });
});

describe('0.12.10: photos and sizes from shop pages', () => {
  const base = 'https://www.shop.example/search?q=bucket';
  const data = (extra: Record<string, unknown>) => [{ products: [{ name: 'Pail Bucket 10L', price: 4.99, url: '/p/pail-10l', ...extra }, { name: 'Mini Bucket', price: 1, url: '/p/mini', image: '/img/mini.jpg' }] }];
  const first = (extra: Record<string, unknown>) => fromEmbedded('bunnings', data(extra), base)[0];
  it('finds a photo under any field that sounds like one', () => {
    expect(first({ thumbnailImageUrl: 'https://media.shop.example/a/1' }).imageUrl).toBe('https://media.shop.example/a/1');
    expect(first({ primaryImage: { url: '//cdn.shop.example/b.png' } }).imageUrl).toBe('https://cdn.shop.example/b.png');
    expect(first({ photos: [{ thumbnail: '/media/c.webp' }] }).imageUrl).toBe('https://www.shop.example/media/c.webp');
    expect(first({ images: ['', '/media/placeholder.png', '/media/d.jpg'] }).imageUrl).toBe('https://www.shop.example/media/d.jpg');
  });
  it('asks for an http photo over https, and never takes a logo, a badge or a word for a photo', () => {
    expect(first({ image: 'http://cdn.shop.example/e.jpg' }).imageUrl).toBe('https://cdn.shop.example/e.jpg');
    expect(first({ brandImage: '/img/brand.png', hasImage: 'true', imageAlt: 'A bucket' }).imageUrl).toBeUndefined();
  });
  it('a size of 0 is not a size', () => {
    expect(first({ size: 0 }).size).toBe('10L'); // from the name instead
    expect(fromEmbedded('bunnings', data({ size: 0 }), base)[1].size).toBeUndefined();
    expect(first({ size: '2 pack' }).size).toBe('2 pack');
  });
  it('a product read without a photo takes it from the same product elsewhere on the page', () => {
    const bare = fromEmbedded('bunnings', data({}), base);
    expect(bare[0].imageUrl).toBeUndefined();
    const filled = withPhotos(bare, [[{ ...bare[0], imageUrl: 'https://media.shop.example/x.jpg' }]]);
    expect(filled[0].imageUrl).toBe('https://media.shop.example/x.jpg');
    expect(filled[1].imageUrl).toBe(bare[1].imageUrl);
    // by name, when the other source gives the product another address
    expect(withPhotos(bare, [[{ ...bare[0], storeProductId: 'other', imageUrl: 'https://media.shop.example/y.jpg' }]])[0].imageUrl).toBe('https://media.shop.example/y.jpg');
    expect(extractProducts('bunnings', '<html><body></body></html>', base)).toEqual([]);
  });
});

describe('0.12.10: the rest', () => {
  it("What's new has this version only", () => {
    expect(WHATS_NEW).toHaveLength(1);
    expect(WHATS_NEW[0].version).toBe(version);
    expect(read('./screens/WhatsNew.tsx')).toMatch(/const v = WHATS_NEW\[0\]/);
  });
  it('Try again that still fails goes on to opening the shop', () => {
    expect(tryAgainWords('Coles', 'unread')).toMatch(/Opening its page usually gets it going again/);
    expect(read('./Unblock.tsx')).toMatch(/setSaid\(tryAgainWords\(name, result\)\);\s*setOpen\(true\);/);
  });
  it('a tab you made always has Edit', () => {
    expect(read('./screens/Pantry.tsx')).toMatch(/recs\.length === 0 && isCustomSection\(section\) && \(\s*<button className="btn small edit-btn"/);
  });
});
