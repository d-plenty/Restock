// The iPhone app: the pieces that can be held to account without an iPhone.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { IOS_CHECK_EVERY_HOURS, iosCheckDue } from '../lib/check';
import { IosUnavailable } from '../lib/platform';
import { IOS_REASONS } from '../ui/IosWhy';
import { RestockIos } from './native';

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

describe('iPhone app: price checks happen when Restock is opened', () => {
  const base = { sync: { backgroundActivity: true } } as Parameters<typeof iosCheckDue>[0];
  const now = Date.parse('2026-11-24T10:00:00Z');
  it('due with no check yet, or one older than 12 hours; not sooner', () => {
    expect(IOS_CHECK_EVERY_HOURS).toBe(12);
    expect(iosCheckDue({ ...base }, now)).toBe(true);
    expect(iosCheckDue({ ...base, lastCheck: '2026-11-23T21:59:00Z' }, now)).toBe(true);
    expect(iosCheckDue({ ...base, lastCheck: '2026-11-24T04:00:00Z' }, now)).toBe(false);
    expect(iosCheckDue({ ...base, lastCheck: 'nonsense' }, now)).toBe(true);
  });
  it('never when automatic checks are off', () => {
    expect(iosCheckDue({ ...base, checkDays: [] }, now)).toBe(false);
    expect(iosCheckDue({ sync: { backgroundActivity: false } } as Parameters<typeof iosCheckDue>[0], now)).toBe(false);
  });
  it('the check runs on the iPhone itself, and Home says when the next one is', () => {
    const check = read('../lib/check.ts');
    expect(check).toMatch(/if \(isIos\(\)\) \{\s*try \{\s*const r = await checkBySearch\(onProgress\);/);
    expect(check).toMatch(/if \(isIos\(\)\) return \{ due: iosCheckDue\(settings\) \};/);
    expect(read('../ui/screens/Home.tsx')).toContain("if (isIos()) return 'when you next open Restock';");
  });
});

describe("iPhone app: its side of the phone's interface", () => {
  const ios = new RestockIos();
  it('says plainly what an iPhone cannot do', async () => {
    await expect(ios.installUpdate()).rejects.toBeInstanceOf(IosUnavailable);
    // Without the native plugin (an older build of the app's native side) the shop's page can't open.
    await expect(ios.openStore({ chain: 'coles' })).rejects.toThrow(/isn't available on iPhone/);
    // 0.14.0: the Android screen's own calls for phone sharing and cloud folders aren't used on an iPhone
    // (it has its own screens for syncing with a phone and for iCloud: ios/sync.ts wifi and icloud).
    for (const m of ['syncJoin', 'syncSetWifi', 'syncStartHousehold', 'syncSetFolder', 'syncInvite'])
      await expect((ios as unknown as Record<string, () => Promise<unknown>>)[m]()).rejects.toBeInstanceOf(IosUnavailable);
  });
  it('answers the things asked at start-up without failing', async () => {
    expect(await ios.syncInfo()).toEqual({ paired: false, batteryExempt: true });
    expect(await ios.scheduleChecks()).toEqual({ scheduled: false, due: false });
    expect(await ios.takeLaunchAction()).toEqual({});
    expect(await ios.getInsets()).toEqual({ top: 0, bottom: 0 });
    expect(await ios.haHasToken()).toEqual({ saved: false });
    expect(await ios.syncServerPoll()).toEqual({ received: 0 });
    await expect(ios.scheduleRecalls()).resolves.toBeUndefined();
    await expect(ios.updateWidgets()).resolves.toBeUndefined();
  });
  it('is only loaded on an iPhone, and Android still finds its own by name', () => {
    const native = read('../lib/sql/native.ts');
    expect(native).toMatch(/registerPlugin<RestockNativePlugin>\('RestockNative', \{\s*ios: \(\) => import\('\.\.\/\.\.\/ios\/native'\)/);
    expect(read('../lib/boot.ts')).toContain('if (Capacitor.isNativePlatform() && !isIos()) {');
  });
});

describe('iPhone app: greyed out, with why', () => {
  it('every reason has a heading and an explanation in plain words', () => {
    for (const [k, r] of Object.entries(IOS_REASONS)) {
      expect(r.title.length, k).toBeGreaterThan(10);
      expect(r.why.length, k).toBeGreaterThan(40);
    }
    expect(IOS_REASONS.updates.why).toContain("Apple doesn't allow an app to download and install its own updates");
  });
  it('0.14.0: only what Apple makes impossible keeps a note, and it says exactly that', () => {
    const settings = read('../ui/screens/Settings.tsx');
    expect(settings).toContain("Updating from inside the app: not possible on iPhone due to Apple's restrictions.");
    expect(settings).toContain("Picking a time of day: not possible on iPhone due to Apple's restrictions.");
    // Nothing else on an iPhone is greyed with a "why" box any more.
    for (const f of ['Settings', 'Look', 'RestockServer', 'SyncOverview']) expect(read(`../ui/screens/${f}.tsx`), f).not.toMatch(/<IosBox reason="(updates|widgets|appIcon|serverExtras|importData)"/);
    expect(read('../ui/screens/Soon.tsx')).toContain('Still to come on iPhone and iPad: home screen widgets, recall alerts, shared price history');
    expect(read('../ui/screens/Sync.tsx')).toContain('<NotHereBanner reason="sync"');
    expect(read('../ui/screens/RestockServer.tsx')).toContain('<NotHereBanner reason="server"');
    const why = read('../ui/IosWhy.tsx');
    expect(why).toContain("{label ?? 'Why is this unavailable?'}");
    expect(why).not.toContain('greyed out?');
    expect(why).toMatch(/<div className="ios-box">\s*\{children\}\s*<IosWhy reason=\{reason\}/);
  });
  it('the price check setting is reworded, not greyed', () => {
    const settings = read('../ui/screens/Settings.tsx');
    expect(settings).toContain('Check prices when I open Restock');
    expect(settings).not.toContain('<IosWhy reason="background"');
  });
  it('nothing changes off an iPhone: sync, updates and Home Assistant are where they were on Android', () => {
    expect(read('../lib/sync.ts')).toContain('export const syncAvailable = () => (Capacitor.isNativePlatform() && (!isIos() || Object.values(IOS_SYNC).some(Boolean))) || !!demoSync();');
    expect(read('../lib/sync.ts')).toContain('(Capacitor.isNativePlatform() ? !isIos() || IOS_SYNC[way] : !!demoSync())');
    expect(read('../lib/updates.ts')).toContain('export const SELF_UPDATE = !import.meta.env.VITE_FDROID && !isIos();');
  });
});

describe('iPhone app: the project and its build', () => {
  const plist = read('../../ios/App/App/Info.plist');
  const flow = read('../../.github/workflows/ios.yml');
  it('asks for the camera, location and photos in plain words, and shows its backups in Files', () => {
    for (const k of ['NSCameraUsageDescription', 'NSLocationWhenInUseUsageDescription', 'NSPhotoLibraryUsageDescription', 'UIFileSharingEnabled', 'LSSupportsOpeningDocumentsInPlace']) expect(plist).toContain(k);
  });
  it('has the same app ID as Android and runs on iOS 15 and later', () => {
    const proj = read('../../ios/App/App.xcodeproj/project.pbxproj');
    expect(proj).toContain('PRODUCT_BUNDLE_IDENTIFIER = family.plenty.restock;');
    expect(proj).toContain('IPHONEOS_DEPLOYMENT_TARGET = 15.0;');
  });
  it('the GitHub build signs nothing and holds no keys', () => {
    expect(flow).toContain('CODE_SIGNING_ALLOWED=NO');
    expect(flow).toContain('unsigned.ipa');
    expect(flow).not.toMatch(/secrets\.(?!GITHUB_TOKEN)/);
    expect(flow).not.toMatch(/P12|PROVISION|APPLE_ID|password/i);
  });
  it('the install page carries the warnings', () => {
    const doc = read('../../docs/IPHONE.md');
    for (const w of ['stops opening after 7 days', 'You need a computer', 'Back up first', 'unofficial', 'Why is this unavailable']) expect(doc).toContain(w);
  });
});

// ---------- 0.13.2 ----------
import { haBase, homeHost, onSite, shopHome, shopHosts } from './native';
import { fetchScript, looksBlocked, looksLikeCheck, pageFetch, pageRender } from './shopWeb';
import type { RestockApplePlugin } from './apple';

describe('0.13.2: a shop address is kept on the shop\'s own site (StoreWeb.onSite)', () => {
  const coles = shopHome('coles')!;
  it('reads a path against the home page, and a full address only on the site or its own other sites', () => {
    expect(coles).toBe('https://www.coles.com.au/');
    expect(onSite('coles', '/api/bff/products/search?x=1', coles)).toBe('https://www.coles.com.au/api/bff/products/search?x=1');
    expect(onSite('coles', 'https://shop.coles.com.au/a', coles)).toBe('https://shop.coles.com.au/a');
    expect(onSite('coles', 'https://www.flybuys.com.au/login', coles)).toBe('https://www.flybuys.com.au/login');
    expect(onSite('aldi', 'https://api.aldi.com.au/v3/product-search?q=milk', shopHome('aldi'))).toContain('api.aldi.com.au');
    expect(shopHosts('woolworths', shopHome('woolworths')!)).toEqual(['woolworths.com.au', 'everyday.com.au', 'woolworthsrewards.com.au']);
  });
  it('refuses another site however it is dressed up', () => {
    for (const bad of ['//evil.example/x', '/\\evil.example/x', 'https://evil.example/', 'https://coles.com.au.evil.example/', 'http://www.coles.com.au/x', 'https://user:pw@www.coles.com.au/', 'javascript:alert(1)', 'https://www.coles.com.au@evil.example/', ' /x y'])
      expect(onSite('coles', bad, coles), bad).toBeUndefined();
    expect(onSite('nonesuch', '/x', shopHome('nonesuch'))).toBeUndefined();
  });
  it('a shop someone added themselves is read against the website they gave, https only', () => {
    expect(shopHome('custom-abc', 'https://www.example.shop')).toBe('https://www.example.shop/');
    expect(shopHome('custom-abc', 'http://www.example.shop')).toBeUndefined();
    expect(onSite('custom-abc', '/search?q=milk', 'https://www.example.shop/')).toBe('https://www.example.shop/search?q=milk');
  });
});

describe('0.13.2: the hidden browser on iPhone and iPad (ios/shopWeb.ts)', () => {
  /** A pretend native side: remembers what was loaded and run, and answers the scripts from a list. */
  function pretend(answers: (js: string) => string | undefined) {
    const log: string[] = [];
    const apple = {
      webLoad: async (o: { key: string; url: string }) => (log.push(`load ${o.key} ${o.url}`), { status: 200, url: o.url }),
      webEval: async (o: { key: string; js: string }) => (log.push(`eval ${o.key}`), { value: answers(o.js) ?? '' }),
    } as unknown as RestockApplePlugin;
    (globalThis as { __restockAppleFake?: RestockApplePlugin }).__restockAppleFake = apple;
    return log;
  }
  it('the request script adds Coles\' key inside the page, and never for another shop', () => {
    const c = fetchScript('coles', 'GET', '/api/bff/products/search?q=milk');
    expect(c).toContain('BFF_API_SUBSCRIPTION_KEY');
    expect(c).toContain("'subscription-key='");
    expect(c).toContain('"/api/bff/products/search?q=milk"');
    const w = fetchScript('woolworths', 'POST', '/apis/ui/Search/products', '{"a":"b\'c"}');
    expect(w).not.toContain('subscription-key');
    expect(w).toContain(`o.body = ${JSON.stringify('{"a":"b\'c"}')}`);
    expect(w).toContain("'Content-Type'");
    // It parses as a function body that can await.
    expect(() => new (Object.getPrototypeOf(async () => 0).constructor)(c)).not.toThrow();
    expect(() => new (Object.getPrototypeOf(async () => 0).constructor)(w)).not.toThrow();
  });
  it('loads the shop\'s home page once, then asks; blocked the first time, it loads afresh and asks once more', async () => {
    let n = 0;
    const log = pretend((js) => (js.includes('fetch(url, o)') ? JSON.stringify(n++ === 0 ? { status: 403, body: '<html>' } : { status: 200, body: '{"ok":1}' }) : ''));
    const r = await pageFetch('testshop-a', 'https://www.example.shop/', 'GET', '/api/x');
    expect(r).toEqual({ status: 200, body: '{"ok":1}' });
    expect(log).toEqual(['load shop-testshop-a https://www.example.shop/', 'eval shop-testshop-a', 'load shop-testshop-a https://www.example.shop/', 'eval shop-testshop-a']);
    log.length = 0;
    expect(await pageFetch('testshop-a', 'https://www.example.shop/', 'GET', '/api/y')).toEqual({ status: 200, body: '{"ok":1}' });
    expect(log).toEqual(['eval shop-testshop-a']); // the page is still fresh
  });
  it('a page is read once its prices stop changing, and comes back with where it ended up', async () => {
    let probes = 0;
    pretend((js) => {
      if (js.includes('scrollHeight')) return ++probes < 3 ? `${probes}:0:100:2` : '5:0:900:9';
      if (js.includes('outerHTML')) return '<html><body>$5.00</body></html>';
      if (js.includes('location.href')) return 'https://www.example.shop/search?q=milk';
      return 'Milk | results';
    });
    const r = await pageRender('testshop-b', 'https://www.example.shop/search?q=milk', 0);
    expect(r).toEqual({ status: 200, html: '<html><body>$5.00</body></html>', url: 'https://www.example.shop/search?q=milk' });
    expect(probes).toBe(5); // 1, 2, then the same three times
  });
  it('keeps only a few shops\' pages open: the one used longest ago is closed', async () => {
    const closed: string[] = [];
    const apple = {
      webLoad: async (o: { url: string }) => ({ status: 200, url: o.url }),
      webEval: async () => ({ value: JSON.stringify({ status: 200, body: '{}' }) }),
      webClose: async (o: { key?: string }) => void closed.push(o.key ?? ''),
    } as unknown as RestockApplePlugin;
    (globalThis as { __restockAppleFake?: RestockApplePlugin }).__restockAppleFake = apple;
    for (const c of ['lru-1', 'lru-2', 'lru-3', 'lru-4', 'lru-5']) await pageFetch(c, 'https://www.example.shop/', 'GET', '/x');
    expect(closed.filter((k) => k.startsWith('shop-lru-'))).toEqual(['shop-lru-1', 'shop-lru-2']);
    expect(closed.length).toBeGreaterThanOrEqual(2);
  });
  it('knows a blocked answer and a "checking your browser" page', () => {
    expect(looksBlocked({ status: 200, body: ' <!doctype html>' })).toBe(true);
    expect(looksBlocked({ status: 429, body: '{}' })).toBe(true);
    expect(looksBlocked({ status: 200, body: '{"a":1}' })).toBe(false);
    expect(looksLikeCheck('Just a moment... | Checking')).toBe(true);
    expect(looksLikeCheck('Milk 2L | $3.10')).toBe(false);
  });
});

describe('0.13.2: Home Assistant on iPhone', () => {
  it('keeps the address to scheme, host and port, and plain http to an address at home', () => {
    expect(haBase('homeassistant.local:8123')).toBe('http://homeassistant.local:8123');
    expect(haBase(' http://192.168.1.20:8123/lovelace/0 ')).toBe('http://192.168.1.20:8123');
    expect(haBase('https://ha.example.com/')).toBe('https://ha.example.com');
    expect(() => haBase('http://ha.example.com:8123')).toThrow(/Plain http only works/);
    expect(() => haBase('http://me:pw@192.168.1.20')).toThrow(/user name/);
    expect(() => haBase('ftp://192.168.1.20')).toThrow(/http/);
  });
  it('an address at home: private and Tailscale numbers, .local names and bare ones', () => {
    for (const h of ['10.0.0.5', '192.168.1.20', '172.16.0.1', '172.31.255.1', '100.64.0.1', '100.127.9.9', '127.0.0.1', 'homeassistant', 'ha.local', 'nas.lan', 'box.home.arpa', 'pi.tailnet.ts.net', 'fd12::1'])
      expect(homeHost(h), h).toBe(true);
    for (const h of ['8.8.8.8', '172.32.0.1', '100.128.0.1', '192.169.1.1', 'example.com', 'local.example.com', '2001:db8::1']) expect(homeHost(h), h).toBe(false);
  });
  it('the token never leaves for another address, and the rounds are haSync.ts (no round of its own)', async () => {
    const ios2 = new RestockIos();
    await expect(ios2.haRequest({ address: '192.168.1.20:8123', method: 'GET', path: '/etc/passwd' })).rejects.toThrow(/Not a Home Assistant API path/);
    await expect(ios2.haRequest({ address: '192.168.1.20:8123', method: 'GET', path: '/api/../x' })).rejects.toThrow(/Not a Home Assistant API path/);
    await expect(ios2.haRound()).rejects.toMatchObject({ code: 'UNIMPLEMENTED' });
    const native = read('./native.ts');
    expect(native).toContain("if (saved.for !== at) throw new Error(\"Home Assistant's address has changed.");
    expect(read('../lib/homeAssistant.ts')).toContain('export const haAvailable = () => Capacitor.isNativePlatform();');
  });
});

describe('0.13.2: the screens', () => {
  it('automatic backups only ever remove the automatic ones', () => {
    expect(read('./native.ts')).toContain('/^restock-auto-.*\\.json$/i.test(f.name)');
  });
  it('an iPhone says where its backups go and has nothing to pick', () => {
    const b = read('../ui/screens/Backups.tsx');
    expect(b).toContain('The Files app → On My iPhone → Restock → Restock backups.');
    expect(b).toMatch(/\{isIos\(\) \? \(\s*\/\/ 0\.13\.2[^\n]*\n\s*<div className="row">/);
  });
  it('what is recommended goes by the phone: Phone sharing first on Android, iCloud first on iPhone, the server never', () => {
    const o = read('../ui/screens/SyncOverview.tsx');
    expect(o).toContain("(ios ? (['folder', 'wifi', 'server'] as const) : (['wifi', 'folder', 'server'] as const))");
    expect(o).toContain('If you run one');
    expect(o).toContain("Android phones: Samsung, Google Pixel, Oppo, Motorola, Nokia and most phones that aren't iPhones.");
    expect(o).not.toContain('className="sync-choice recommended" disabled={!syncAvailable()} onClick={() => nav.push({ name: \'restockServer\' })}');
  });
  it('the project is for iPhone and iPad, registers its own plugin, and may talk to things on the home network', () => {
    const proj = read('../../ios/App/App.xcodeproj/project.pbxproj');
    expect(proj).toContain('TARGETED_DEVICE_FAMILY = "1,2";');
    expect(proj.match(/RestockApple\.swift/g)?.length).toBe(6);
    expect(read('../../ios/App/App/SceneDelegate.swift')).toContain('window?.rootViewController = RestockViewController()');
    const swift = read('../../ios/App/App/RestockApple.swift');
    expect(swift).toContain('bridge?.registerPluginInstance(plugin)');
    // 0.14.0: the Wi-Fi (RestockLan.swift) and a short sync in the background (RestockBackground.swift).
    expect(proj.match(/RestockLan\.swift/g)?.length).toBe(6);
    expect(proj.match(/RestockBackground\.swift/g)?.length).toBe(6);
    expect(read('../../ios/App/App/AppDelegate.swift')).toContain('RestockBackground.register()');
    expect(swift).toContain('public let jsName = "RestockApple"');
    const plist = read('../../ios/App/App/Info.plist');
    expect(plist).toContain('NSLocalNetworkUsageDescription');
    expect(plist).toContain('NSAllowsArbitraryLoads');
    expect(plist).toContain('<string>_restocksync._tcp</string>');
    // The background task's name is the same in the code and in the list iOS checks it against.
    expect(plist).toContain('<string>family.plenty.restock.refresh</string>');
    expect(read('../../ios/App/App/RestockBackground.swift')).toContain('static let taskId = "family.plenty.restock.refresh"');
  });
  it('every method the TypeScript side calls is one the Swift side has', () => {
    const swift = read('../../ios/App/App/RestockApple.swift');
    const every = swift + read('../../ios/App/App/RestockLan.swift') + read('../../ios/App/App/RestockBackground.swift');
    const iface = read('./apple.ts');
    const methods = [...iface.slice(iface.indexOf('export interface RestockApplePlugin'), iface.indexOf('/** A stand-in')).matchAll(/^\s{2}(\w+)\(/gm)].map((m) => m[1]).filter((m) => m !== 'addListener');
    expect(methods.length).toBeGreaterThan(20);
    for (const m of methods) {
      expect(swift, m).toContain(`CAPPluginMethod(name: "${m}", returnType: CAPPluginReturnPromise)`);
      expect(every, m).toContain(`@objc func ${m}(_ call: CAPPluginCall)`);
    }
    // And the other way: nothing is listed for the app that the Swift side doesn't have.
    for (const m of [...swift.matchAll(/CAPPluginMethod\(name: "(\w+)"/g)].map((x) => x[1])) expect(every, m).toContain(`@objc func ${m}(_ call: CAPPluginCall)`);
  });
});

// ---------- 0.13.2: a Restock server's house on iPhone and iPad (ios/house.ts) ----------
import initSqlJs from 'sql.js';
import { initDb, updateSettings } from '../lib/db';
import { createSqlJsDriver } from '../lib/sql/sqljs';
import { b64u as b64, newEcdhKey, signedText, verifySig } from '../server-mode/crypto';
import { WebSyncEngine } from '../server-mode/engine';
import { syncDbOf } from '../server-mode/sqldb';
import { cleanAddress, House, HouseProblem, parseInvite, type Http } from './house';
import { IOS_SYNC } from '../lib/sync';

describe('0.13.2: an Add a phone code, as an iPhone reads it (ServerFolder.parseInvite)', () => {
  const k = b64(newEcdhKey().pub);
  const invite = 'A'.repeat(43);
  it('reads the addresses, the invite and the server key', () => {
    const c = parseInvite(`restock-server:3?h=${encodeURIComponent('http://192.168.1.10:8787/')}&a=${encodeURIComponent('https://restock.example.com')}&i=${invite}&k=${k}`);
    expect(c).toMatchObject({ v: 3, home: 'http://192.168.1.10:8787', away: 'https://restock.example.com', invite });
    expect(c.kex).toMatch(/^MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE/); // always SPKI, however the code wrote it
    expect(parseInvite(`  RESTOCK-SERVER:3?h=nas.local:8787&i=${invite}&k=${k}  `).home).toBe('http://nas.local:8787');
  });
  it('turns down what is not a code, a damaged one, and one with nowhere to go', () => {
    expect(() => parseInvite('https://example.com')).toThrow(/isn't a Restock server code/);
    expect(() => parseInvite(`restock-server:1?h=x&i=${invite}`)).toThrow(/older Restock server/);
    expect(() => parseInvite(`restock-server:3?h=nas.local&i=${invite}&k=notakey`)).toThrow(/damaged/);
    expect(() => parseInvite(`restock-server:3?h=nas.local&i=short&k=${k}`)).toThrow(/damaged/);
    expect(() => parseInvite(`restock-server:3?i=${invite}&k=${k}`)).toThrow(/no address/);
    expect(() => parseInvite(`restock-server:3?h=${encodeURIComponent('http://me:pw@nas.local')}&i=${invite}&k=${k}`)).toThrow(/user name/);
  });
  it('keeps an address without its trailing slash, and only http or https', () => {
    expect(cleanAddress(' https://restock.example.com/house/ ')).toBe('https://restock.example.com/house');
    expect(cleanAddress('')).toBeNull();
    expect(() => cleanAddress('ftp://nas.local')).toThrow(HouseProblem);
    expect(() => cleanAddress('https://nas.local/?x=1')).toThrow(/after a "\?"/);
  });
});

describe('0.13.2: the iPhone as a phone of a house', () => {
  async function phone(http: Http) {
    const driver = await createSqlJsDriver({ load: () => initSqlJs() });
    await initDb(driver);
    await updateSettings({ onboarded: true }, { local: true });
    const e = new WebSyncEngine(syncDbOf(driver.raw), verifySig, signedText, () => Date.now(), { role: 'phone' });
    return { e, raw: driver.raw, house: new House(e, http) };
  }
  const refuse = (status: number, body: unknown): Http => async () => ({ status, headers: {}, bytes: new TextEncoder().encode(JSON.stringify(body)) });
  const code = `restock-server:3?h=nas.local&i=${'B'.repeat(43)}&k=${b64(newEcdhKey().pub)}`;

  it('is not in a house until it joins, and a refusal changes nothing on it', async () => {
    const p = await phone(refuse(410, { error: 'used' }));
    p.raw.run("INSERT INTO items (id, name, created_at, section) VALUES ('i-bread', 'Bread', '2026-11-01T00:00:00.000Z', 'pantry')");
    const before = p.raw.exec("SELECT stamp FROM sync_log WHERE pk = 'i-bread'")[0].values[0][0];
    await expect(p.house.join(code)).rejects.toThrow(/has been used or has run out/);
    expect(p.house.joined()).toBe(false);
    expect(p.raw.exec("SELECT stamp FROM sync_log WHERE pk = 'i-bread'")[0].values[0][0]).toBe(before);
    expect(p.e.meta('key')).toBeNull();
    await expect(p.house.sync()).rejects.toThrow(/isn't on a Restock server/);
  });
  it("an answer that wasn't sealed for this phone with the code's key is never taken", async () => {
    const p = await phone(refuse(200, { sealed: b64(new Uint8Array(80)) }));
    await expect(p.house.join(code)).rejects.toThrow(/couldn't be opened with the key in its code/);
    expect(p.house.joined()).toBe(false);
  });
  it('an older (v2) server is turned down in words, and so is a server that cannot be reached', async () => {
    const p = await phone(async () => {
      throw new Error('offline');
    });
    await expect(p.house.join(`restock-server:2?h=nas.local&i=${'C'.repeat(43)}`)).rejects.toThrow(/older Restock server/);
    await expect(p.house.join(code)).rejects.toThrow(/Couldn't reach your Restock server \(offline\)/);
  });
  it("a phone's file carries recent prices and no loyalty cards unless it shares them", async () => {
    const p = await phone(refuse(500, {}));
    p.raw.run("INSERT INTO household (k, v) VALUES ('tabs', 'pantry,keg,pharmacy')");
    p.e.setMeta('tabs', 'pantry');
    p.raw.run("INSERT INTO items (id, name, created_at, section) VALUES ('i-milk', 'Milk', '2026-11-01T00:00:00.000Z', 'pantry')");
    p.raw.run("INSERT INTO products (id, chain, store_product_id, name, created_at) VALUES ('p1', 'coles', '123', 'Milk 2L', '2026-11-01T00:00:00.000Z')");
    p.raw.run("INSERT INTO prices (product_id, date, price, source) VALUES ('p1', '2026-11-20T00:00:00.000Z', 3.1, 'check')");
    p.raw.run("INSERT INTO cards (id, program, label, number, created_at) VALUES ('c1', 'flybuys', 'Flybuys', '6008123', '2026-11-01T00:00:00.000Z')");
    const tables = () => new Set(p.e.ownFile(1, '2026-11-24T00:00:00.000Z', false)!.msg.entries!.map((x) => x.tbl));
    expect(tables().has('items')).toBe(true);
    expect(tables().has('prices')).toBe(true);
    expect(tables().has('cards')).toBe(false);
    p.e.setMeta('share_cards', '1');
    expect(tables().has('cards')).toBe(true);
  });
  it('leaving a household keeps the device\'s own inventory amounts and "Always use this for" choices', async () => {
    const p = await phone(refuse(500, {}));
    p.raw.run("INSERT INTO household_settings (k, v) VALUES ('have:i1', '{\"m\":\"c\",\"a\":4}'), ('inv:tab:pantry', 'true'), ('alias:milk', '\"i1\"'), ('keep:bread', 'true'), ('shopAroundMin', '3'), ('shop:coles', '{\"on\":true}')");
    p.raw.run("INSERT INTO household (k, v) VALUES ('name', 'A house')");
    p.e.setMeta('key', 'x');
    const before = Number(p.raw.exec('SELECT MAX(seq) FROM sync_log')[0].values[0][0]);
    p.house.forget();
    expect(p.raw.exec('SELECT k FROM household_settings ORDER BY k')[0].values.map((r) => r[0])).toEqual(['alias:milk', 'have:i1', 'inv:tab:pantry', 'keep:bread']);
    expect(p.raw.exec('SELECT COUNT(*) FROM household')[0].values[0][0]).toBe(0);
    expect(p.e.meta('key')).toBeNull();
    // The numbers never go backwards for a household joined later.
    expect(Number(p.raw.exec("SELECT seq FROM sync_log WHERE tbl = '_seq'")[0].values[0][0])).toBe(before);
    expect(read('./household.ts')).toContain("\"(k LIKE 'alias:%' OR k LIKE 'keep:%' OR k LIKE 'inv:%' OR k LIKE 'have:%')\"");
  });
  it('0.14.0: an iPhone or iPad syncs every way: iCloud, with another phone over the Wi-Fi, and a Restock server', () => {
    expect(IOS_SYNC).toEqual({ server: true, wifi: true, folder: true });
    const app = read('../ui/App.tsx');
    expect(app).toContain("const IcloudSyncScreen = lazy(() => import('./screens/IcloudSync')");
    expect(app).toContain("const WifiSyncScreen = lazy(() => import('./screens/WifiSync')");
    const o = read('../ui/screens/SyncOverview.tsx');
    // iCloud first on an iPhone (Recommended), a phone on the Wi-Fi next, a server last and never "Recommended".
    expect(o).toContain("(ios ? (['folder', 'wifi', 'server'] as const) : (['wifi', 'folder', 'server'] as const))");
    expect(o).toContain('iPhone to iPhone over Wi-Fi, without iCloud');
    expect(o).toContain("nav.push({ name: 'wifiSync', apple: true })");
  });
});
