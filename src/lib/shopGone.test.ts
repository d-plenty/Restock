import initSqlJs from 'sql.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { addGroup, addListEntry, addProduct, allListEntries, ensureDefaults, getSettings, initDb, mergeSettings, putKV } from './db';
import { createSqlJsDriver } from './sql/sqljs';
import { failingStores, getHealth, isStuck, nextHealth, noteUnblockTried, recordHealth, STUCK_DAYS } from './health';
import { adoptGeneralLines } from './listPicks';
import { chainName, enabledIn, isGoneShop, searchChainsIn, shopsByGroup, shopsIn } from '../shops';
import type { Group, ListEntry, Product } from '../types';

beforeEach(async () => {
  await initDb(await createSqlJsDriver({ load: () => initSqlJs() }));
  await ensureDefaults();
});

describe('a shop that stopped listing products online', () => {
  it('Pharmacy 4 Less keeps its name but cannot be picked, searched or checked', () => {
    expect(isGoneShop('pharmacy4less')).toBe(true);
    expect(chainName('pharmacy4less')).toBe('Pharmacy 4 Less');
    expect(shopsIn('pharmacy').some((s) => s.id === 'pharmacy4less')).toBe(false);
    expect(shopsByGroup().flatMap((g) => g.shops).some((s) => s.id === 'pharmacy4less')).toBe(false);
    expect(enabledIn(['pharmacy4less', 'priceline'], 'pharmacy')).toEqual(['priceline']);
    expect(searchChainsIn(['pharmacy4less'], 'pharmacy')).toEqual([]);
    expect(isGoneShop('priceline')).toBe(false);
  });

  it('comes off the picked shops when settings are read, and nothing else does', async () => {
    expect(mergeSettings({ enabledChains: ['coles', 'pharmacy4less', 'priceline'] }).enabledChains).toEqual(['coles', 'priceline']);
    await putKV('settings', { ...(await getSettings()), enabledChains: ['woolworths', 'pharmacy4less'] });
    expect((await getSettings()).enabledChains).toEqual(['woolworths']);
  });
});

describe('a shop that Unblock cannot fix', () => {
  const day = 86_400_000;
  it('is stuck after a week of nothing, or once opening its page did not help', async () => {
    const t0 = Date.parse('2026-11-01T00:00:00Z');
    const h = nextHealth({}, { priceline: 'HTTP 403' }, new Date(t0).toISOString());
    expect(failingStores(h, t0 + 2 * day)[0]).toMatchObject({ chain: 'priceline', days: 2, stuck: false });
    expect(failingStores(h, t0 + STUCK_DAYS * day)[0].stuck).toBe(true);
    expect(isStuck({ failingSince: 'x', unblockTried: 'y' }, 1)).toBe(true);
    expect(isStuck({}, 30)).toBe(false);
  });

  it('remembers that Unblock was tried until the shop works again', async () => {
    await noteUnblockTried('priceline');
    expect((await getHealth()).priceline).toBeUndefined(); // not failing: nothing to note
    await recordHealth({ priceline: 'HTTP 403' });
    await noteUnblockTried('priceline');
    await recordHealth({ priceline: 'HTTP 403' });
    expect((await getHealth()).priceline?.unblockTried).toBeTruthy();
    await recordHealth({ priceline: null });
    expect((await getHealth()).priceline?.unblockTried).toBeUndefined();
    expect((await getHealth()).priceline?.failingSince).toBeUndefined();
  });
});

describe('an item added the ordinary way takes over its General line', () => {
  const product = (id: string): Product => ({ id, chain: 'coles', name: id, createdAt: '2026-11-01T00:00:00Z' }) as Product;
  const item = (id: string, name: string): Group => ({ id, name, usualProductId: `p-${id}`, sameProductIds: [], altProductIds: [], alertLevel: 'good', section: 'pantry', createdAt: '' });
  const line = (id: string, text: string, more: Partial<ListEntry> = {}): ListEntry => ({ id, text, checked: false, createdAt: '2026-11-02T00:00:00Z', qty: 1, section: 'general', ...more }) as ListEntry;

  it('the General line becomes the item, on the item\'s own list', async () => {
    await addProduct(product('p-g1'));
    await addGroup(item('g1', 'Bamboo Chopsticks'));
    await addListEntry(line('l1', '2 chopsticks'));
    await addListEntry(line('l2', 'batteries'));
    expect(await adoptGeneralLines({ id: 'g1', name: 'Bamboo Chopsticks' }, ['Bamboo Chopsticks', ' Chopsticks ', undefined])).toBe(1);
    const list = await allListEntries();
    expect(list.find((e) => e.id === 'l1')).toMatchObject({ groupId: 'g1', text: 'Bamboo Chopsticks', section: 'pantry' });
    expect(list.find((e) => e.id === 'l2')).toMatchObject({ section: 'general' });
    expect(list.find((e) => e.id === 'l2')?.groupId).toBeUndefined();
  });

  it('folds into the line the add just made, so the item is on the list once', async () => {
    await addProduct(product('p-g1'));
    await addGroup(item('g1', 'Chopsticks'));
    await addListEntry(line('new', 'Chopsticks', { groupId: 'g1', section: 'pantry' }));
    await addListEntry(line('old', 'chopsticks', { qty: 2 }));
    expect(await adoptGeneralLines({ id: 'g1', name: 'Chopsticks' }, ['Chopsticks'])).toBe(1);
    const list = await allListEntries();
    expect(list.map((e) => e.id)).toEqual(['new']);
    expect(list[0].qty).toBe(3);
  });

  it('leaves alone lines that are other words, ticked off, on another list, or already an item', async () => {
    await addProduct(product('p-g1'));
    await addGroup(item('g1', 'Milk'));
    await addListEntry(line('a', 'milk chocolate'));
    await addListEntry(line('b', 'milk', { checked: true }));
    await addListEntry(line('c', 'milk', { section: 'pantry' }));
    expect(await adoptGeneralLines({ id: 'g1', name: 'Milk' }, ['Milk', 'milk'])).toBe(0);
    expect((await allListEntries()).filter((e) => e.groupId).length).toBe(0);
  });
});
