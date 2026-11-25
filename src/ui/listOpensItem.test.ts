// 0.12.8: what was asked for, held to the source and to the small pieces that do the work.
import { readSource } from '../lib/readSource';
import { describe, expect, it } from 'vitest';
import { needsBackupNudge, putOffBackup, remindDays, remindLabel, BACKUP_REMIND } from '../lib/backup';
import { kiloPrice, looseKilo, perKiloNote } from '../lib/unitPrice';
import { siteImage } from '../stores/webPage';
import type { Group } from '../types';
import { attachPatch, rolesIn, uniqueProducts } from './screens/attachOne';

const read = (p: string) => readSource(new URL(p, import.meta.url));
const add = read('./screens/Add.tsx');
const list = read('./screens/List.tsx');
const item = read('./screens/Item.tsx');
const home = read('./screens/Home.tsx');
const unblock = read('./Unblock.tsx');
const backups = read('./screens/Backups.tsx');

const group = (g: Partial<Group>): Group => ({ id: 'g', name: 'Pasta sauce', sameProductIds: [], altProductIds: [], alertLevel: 'good', ...g }) as Group;

describe('0.12.8: the shopping list item opens its pantry item', () => {
  it('the button is on the sheet itself, not folded under Edit this item', () => {
    const at = list.indexOf('Open in {SECTION_NAMES[tab]}');
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(list.indexOf('<span>Edit this item</span>'));
    expect(list).not.toMatch(/> Pantry item\s*</);
  });
});

describe('0.12.8: Products I buy', () => {
  it('is the one name for it', () => {
    for (const src of [add, item, list]) expect(src).not.toMatch(/What I buy|what I buy|Add another pick/);
    expect(item).toMatch(/<span className="title">Products I buy<\/span>/);
    expect(item).toMatch(/Add, change or remove products/);
    expect(add).toMatch(/<div className="eyebrow">Products I buy<\/div>/);
  });
  it('Edit has a way to it', () => {
    expect(item).toMatch(/onProducts=\{showProducts\}/);
    expect(item).toMatch(/Products I buy: add, change or remove/);
  });
});

describe('0.12.8: adding to an item you already have', () => {
  it('+ adds straight away: no sheet opens', () => {
    const pick = add.slice(add.indexOf('const pickOne = '), add.indexOf('const pickOne = ') + 400);
    expect(pick).toMatch(/if \(addingToItem\) \{\s*void attachToggle\(sp\);\s*return;/);
    expect(add).toMatch(/const addingToItem = !!attachTo && !forLine/);
  });
  it('a new main product goes in, and puts back a shop marked Not sold here', () => {
    const g = group({ usualProductId: 'a', sameProductIds: ['b'], altProductIds: ['c'], notAt: ['coles'] });
    expect(attachPatch(g, ['d'], 'main', ['coles'])).toEqual({ notAt: [], usualProductId: 'a', sameProductIds: ['b', 'd'], altProductIds: ['c'] });
    // one you'd also take, ticked as one you buy, moves over
    expect(attachPatch(g, ['c'], 'main')).toMatchObject({ sameProductIds: ['b', 'c'], altProductIds: [] });
    // already there: nothing to change
    expect(attachPatch(g, ['b'], 'main')).toBeUndefined();
    expect(attachPatch(group({}), ['x', 'y'], 'main')).toMatchObject({ usualProductId: 'x', sameProductIds: ['y'] });
  });
  it('an alternative goes in once', () => {
    const g = group({ usualProductId: 'a', altProductIds: ['c'] });
    expect(attachPatch(g, ['d', 'c', 'a'], 'alt')).toEqual({ altProductIds: ['c', 'd'] });
    expect(attachPatch(g, ['a'], 'alt')).toBeUndefined();
  });
  it('what the item already has shows ticked, by shop and product number', () => {
    const g = group({ usualProductId: 'a', altProductIds: ['c'] });
    const m = rolesIn(g, [
      { id: 'a', chain: 'coles', storeProductId: '1' },
      { id: 'c', chain: 'aldi', storeProductId: '9' },
      { id: 'z', chain: 'other' },
    ]);
    expect([...m]).toEqual([
      ['coles:1', 'main'],
      ['aldi:9', 'alt'],
    ]);
  });
});

describe('0.12.8: no doubled-up results', () => {
  it('the same product from the same shop shows once, first one kept', () => {
    const r = uniqueProducts([
      { chain: 'woolworths', storeProductId: 1, n: 'a' },
      { chain: 'woolworths', storeProductId: '2', n: 'b' },
      { chain: 'woolworths', storeProductId: '1', n: 'c' },
      { chain: 'coles', storeProductId: '1', n: 'd' },
    ]);
    expect(r.map((x) => x.n)).toEqual(['a', 'b', 'd']);
  });
  it('is used where results are kept and shown, on the phone and the web', () => {
    expect((add.match(/uniqueProducts\(/g) ?? []).length).toBeGreaterThanOrEqual(5);
    expect(read('../server-mode/ui/webSearch.ts')).toMatch(/uniqueProducts\(s\.items\)/);
  });
});

describe('0.12.8: backup reminders', () => {
  const DAY = 86_400_000;
  const now = Date.parse('2026-11-21T00:00:00Z');
  const old = '2026-10-01T00:00:00Z';
  const ago = (d: number) => new Date(now - d * DAY).toISOString();
  it('first shows once there are a few items a week old', () => {
    expect(needsBackupNudge({}, 3, old, now)).toBe(true);
    expect(needsBackupNudge({}, 2, old, now)).toBe(false);
    expect(needsBackupNudge({}, 9, ago(3), now)).toBe(false);
  });
  it('the first Not now brings it back in a week, the next ones every 30 days', () => {
    const once = putOffBackup({}, now - 6 * DAY);
    expect(once.backupNudges).toBe(1);
    expect(needsBackupNudge(once, 9, old, now)).toBe(false);
    expect(needsBackupNudge(putOffBackup({}, now - 7 * DAY), 9, old, now)).toBe(true);
    const twice = putOffBackup(once, now - 29 * DAY);
    expect(twice.backupNudges).toBe(2);
    expect(needsBackupNudge(twice, 9, old, now)).toBe(false);
    expect(needsBackupNudge(putOffBackup(once, now - 30 * DAY), 9, old, now)).toBe(true);
  });
  it('put off before this update counts as the first time already used', () => {
    expect(needsBackupNudge({ backupNudgeAt: ago(8) }, 9, old, now)).toBe(false);
    expect(putOffBackup({ backupNudgeAt: ago(40) }, now).backupNudges).toBe(2);
  });
  it('the setting: every week, 30 days, 3 months or never', () => {
    expect([...BACKUP_REMIND]).toEqual([7, 30, 90, 0]);
    expect(remindDays({})).toBe(30);
    expect(remindDays({ backupRemindDays: 12 })).toBe(30);
    expect(remindLabel(0)).toBe('Never');
    expect(needsBackupNudge({ backupRemindDays: 0 }, 9, old, now)).toBe(false);
    expect(needsBackupNudge({ backupRemindDays: 90, lastBackupAt: ago(60) }, 9, old, now)).toBe(false);
    expect(needsBackupNudge({ backupRemindDays: 7, lastBackupAt: ago(8) }, 9, old, now)).toBe(true);
    expect(needsBackupNudge({ lastBackupAt: ago(31) }, 9, old, now)).toBe(true);
    expect(backups).toMatch(/Remind me to back up/);
    expect(home).toMatch(/updateSettings\(putOffBackup\(settings\)\)/);
  });
  it('never when a copy is kept somewhere else', () => {
    expect(needsBackupNudge({}, 9, old, now, true)).toBe(false);
  });
});

describe('0.12.8: loose fruit and veg by the kilo', () => {
  it("uses the shop's own per-kilo price when it gives one", () => {
    const p = { name: 'Brushed Potatoes Loose', size: 'each', unitPriceText: '$4.50 per 1kg' };
    expect(looseKilo(p, 0.9)).toEqual({ perKg: 4.5, about: false });
    expect(kiloPrice(p, 0.9)).toEqual({ main: '$4.50/kg', each: 'about $0.90 each' });
    expect(kiloPrice(p, 0.9, 3)?.each).toBe('3 × about $0.90');
  });
  it('else works it out from the weight of one', () => {
    expect(kiloPrice({ name: 'Potato Brushed', size: 'approx. 150g' }, 0.75)?.main).toBe('$5.00/kg');
    expect(perKiloNote({ name: 'Potato Brushed', size: 'approx. 150g', price: 0.75 })).toBe('about $5.00/kg');
    // one of yours: the weight saved with it
    expect(kiloPrice({ name: 'Carrots Loose', size: 'each', qty: 200, qtyUnit: 'g' }, 0.5)?.main).toBe('$2.50/kg');
  });
  it('never for a pack, and never a guess', () => {
    expect(kiloPrice({ name: 'Potatoes Brushed 2kg', size: '2kg' }, 5)).toBeUndefined();
    expect(kiloPrice({ name: 'Avocado', size: 'each' }, 2)).toBeUndefined();
    expect(kiloPrice({ name: 'Potato Brushed', size: 'approx. 150g' }, undefined)).toBeUndefined();
  });
  it('is the price shown in results, on the item page and on the list', () => {
    expect(add).toMatch(/priceText=\{kiloPrice\(sp, sp\.price\)\?\.main\}/);
    expect(item).toMatch(/kiloPrice\(o\.product, o\.price\)\?\.main/);
    expect((list.match(/kiloPrice\(/g) ?? []).length).toBeGreaterThanOrEqual(5);
  });
});

describe('0.12.8: shops that stopped working', () => {
  it('Try again tests that one shop and says what happened', () => {
    expect(unblock).toMatch(/export function TryAgain/);
    expect(unblock).toMatch(/Checking \$\{name\}…/);
    expect((home.match(/<TryAgain /g) ?? []).length).toBe(4);
  });
  it('a page that opened but could not be read is not called blocked', async () => {
    const { resultOf, tryAgainWords } = await import('./Unblock');
    expect(resultOf({ ok: true })).toBe('working');
    expect(resultOf({ ok: false, blocked: true })).toBe('blocked');
    expect(resultOf({ ok: false })).toBe('unread');
    expect(resultOf(undefined)).toBe('unknown');
    expect(tryAgainWords('Cellarbrations', 'unread')).toMatch(/still isn't answering/);
    expect(tryAgainWords('Cellarbrations', 'blocked')).toMatch(/Open Cellarbrations/);
  });
  it('Cellarbrations, The Bottle-O and Porters get their photos', () => {
    expect(siteImage('https://www.cellarbrations.com.au/sm/pickup/rsid/218/product/hard-rated-alcoholic-lemon-can-375ml-id-562785')).toBe(
      'https://cdn.metcash.media/image/upload/w_300,h_300,c_pad,b_auto/alm-online/images/562785.jpg',
    );
    expect(siteImage('https://www.thebottle-o.com.au/sm/pickup/rsid/6810/product/x-10-pack-id-569494')).toMatch(/569494\.jpg$/);
    expect(siteImage('https://www.cellarbrations.com.au/sm/pickup/rsid/218/results?q=beer')).toBeUndefined();
    expect(siteImage('https://www.igashop.com.au/sm/pickup/rsid/1/product/milk-id-123456')).toBeUndefined();
    expect(siteImage('https://evil.example/cellarbrations.com.au/product/a-id-123456')).toBeUndefined();
    expect(siteImage(undefined)).toBeUndefined();
    // one saved before it had a photo gets it when it's read back
    expect(read('../lib/db.ts')).toMatch(/imageUrl: opt\(r\.image_url as string \| null\) \?\? siteImage\(/);
  });
});
