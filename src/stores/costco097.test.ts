/// <reference types="node" />
// 0.9.7: Costco is an ordinary supermarket. Picked with the others (off by default), shared with the
// household and the server, in exports and backups, everything Costco sells (not just food), asked
// from inside Costco's own page on a phone (so a sign-in counts), and still only when Search is pressed.
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { costcoApiUrl, Gate, makeCostco, parseCostcoApi } from './costco';
import type { HttpResult } from './http';
import { costcoDecides, costcoIsOn, costcoStateOf, isLocalOnlyShop, isPressOnlyShop, setCostcoState } from '../shops';
import { checkSettings } from '../lib/settingsCheck';
import { DEFAULT_SETTINGS } from '../types';
import { withoutCostco } from '../lib/costcoLocal';
import { isCostcoLine, stripCostcoLine } from '../server-mode/engine';
import { builtInsOn } from '../lib/sharedSettings';

// Hand-made, in the shape of a SAP Commerce product search answer (not yet seen from a real phone).
const API = JSON.stringify({
  products: [
    { code: '101', name: 'Kirkland Signature Milk 2L x 3', price: { value: 7.99, formattedValue: '$7.99' }, url: '/p/101', stock: { stockLevelStatus: 'inStock' } },
    { code: '202', name: 'Kirkland Signature Adult Dog Food 18kg', price: { value: 64.99 }, url: '/Pets/Dog-Food/p/202', images: [{ url: '/medias/202.jpg' }] },
    { code: '303', name: 'Sofa 3 Seater', price: { value: 899 }, stock: { stockLevelStatus: 'outOfStock' } },
  ],
});
const ok = (text: string): HttpResult => ({ status: 200, text, headers: {} });
const free = () => new Gate(0, 100, 1000, () => 0, async () => undefined);

describe('Costco 0.9.7: the search', () => {
  it('reads Costco’s product search answer, everything it sells (dog food and sofas too)', () => {
    const got = parseCostcoApi(API) ?? [];
    expect(got.map((p) => p.storeProductId)).toEqual(['101', '202', '303']);
    expect(got[1].name).toContain('Dog Food');
    expect(got[1].price).toBe(64.99);
    expect(got[2].inStock).toBe(false);
    expect(parseCostcoApi('<html>not json</html>')).toBeUndefined();
  });

  it('on a phone asks from inside Costco’s own page (cookies, sign-in), the product search first', async () => {
    const browser = vi.fn(async () => ok(API));
    const request = vi.fn(async () => ok(''));
    const a = makeCostco({ isNative: () => true, settings: () => undefined, request, browser, gate: free() });
    const got = await a.search('milk');
    expect(got.length).toBe(3);
    expect(browser).toHaveBeenCalledWith(costcoApiUrl('milk'));
    expect(request).not.toHaveBeenCalled();
  });

  it('reads the search page when the product search isn’t there', async () => {
    const page = '<html><script type="application/ld+json">{"@type":"Product","name":"Almonds 1kg","sku":"404","offers":{"price":"19.99"}}</script></html>';
    const browser = vi.fn(async (url: string) => (url.includes('/rest/') ? { status: 404, text: '', headers: {} } : ok(page)));
    const a = makeCostco({ isNative: () => true, settings: () => undefined, request: vi.fn(), browser, gate: free() });
    const got = await a.search('almonds');
    expect(browser).toHaveBeenCalledTimes(2);
    expect(got.map((p) => p.storeProductId)).toEqual(['404']);
  });

  it('the server (no phone) may ask too, with a plain request', async () => {
    const request = vi.fn(async () => ok(API));
    const a = makeCostco({ isNative: () => false, settings: () => undefined, request, gate: free() });
    expect((await a.search('milk')).length).toBe(3);
  });

  it('0.9.8: searched in every search, but never by Check now, the background or a connection test', () => {
    expect(isPressOnlyShop('costco')).toBe(true);
    expect(isPressOnlyShop('coles')).toBe(false);
    expect(readFileSync('src/lib/check.ts', 'utf8')).toMatch(/!isPressOnlyShop\(p\.chain\) && isPageless/);
    expect(readFileSync('android/app/src/main/java/family/plenty/restock/PriceChecker.java', 'utf8')).toMatch(/"costco"\.equals\(chain\)\) continue/);
  });
});

describe('Costco 0.9.7: an ordinary shop', () => {
  it('is picked with the shops; a phone that turned it on in 0.9.6 keeps it', () => {
    expect(checkSettings({ ...DEFAULT_SETTINGS }).enabledChains).not.toContain('costco');
    const was = checkSettings({ ...DEFAULT_SETTINGS, costco: { on: true, acceptedAt: '2026-11-11T00:00:00.000Z' } } as never);
    expect(was.enabledChains).toContain('costco');
    setCostcoState(costcoStateOf({ enabledChains: ['coles', 'costco'] }));
    expect(costcoIsOn()).toBe(true);
    expect(costcoDecides()).toBe(true);
    setCostcoState(undefined);
  });

  it('is a household shop, shared and kept like the others', () => {
    expect(isLocalOnlyShop('costco')).toBe(false);
    expect(builtInsOn('pantry')).toContain('costco');
    const line = { id: 'l1', text: 'Nuts', chain: 'costco', price: 19.99, product: JSON.stringify({ chain: 'costco' }) };
    expect(isCostcoLine(line)).toBe(false);
    const sent = { ...line };
    stripCostcoLine(sent);
    expect(sent).toEqual(line);
    const snap = { products: [{ id: 'c1', chain: 'costco' }], prices: [{ productId: 'c1' }] } as never;
    expect(withoutCostco(snap)).toBe(snap);
  });

  it('the Java sync and settings share it too', () => {
    const java = readFileSync('android/app/src/main/java/family/plenty/restock/SyncEngine.java', 'utf8');
    expect(java).not.toMatch(/if \("costco"\.equals\(chain\)\) return LOCAL_TAB;/);
    expect(java).toMatch(/if \(!LOCAL_ONLY\) return false;/);
    expect(readFileSync('android/app/src/main/java/family/plenty/restock/SharedSettings.java', 'utf8')).not.toMatch(/!"costco"\.equals\(id\)/);
  });
});
