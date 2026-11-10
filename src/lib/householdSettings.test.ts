import initSqlJs from 'sql.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { getSettings, initDb, reapplyHouseholdSettings, updateSettings } from './db';
import { createSqlJsDriver } from './sql/sqljs';
import { MIGRATIONS, migrate } from './sql/schema';
import { getHouseholdSettings, HOUSEHOLD_WIDE, phoneSummaries, setHouseholdSettings, settingScope } from './householdSettings';
import { applyRows, changedRows, checkListRow, checkShop, checkValue, isListRow, LIST_ROWS_MAX, ROWS_MAX, settingTab } from './sharedSettings';
import { cleanSummary } from './phoneSummary';
import { WebSyncEngine } from '../server-mode/engine';
import { syncDbOf } from '../server-mode/sqldb';
import { pollServer } from './sync';

// 0.9.3: household-wide settings (sharedSettings.ts, householdSettings.ts, the updateSettings hook)
// and the phones' summaries for the web (phoneSummary.ts). The phones' side is SharedSettings.java,
// checked against this by tools/sync-test (web-parity, SyncTest093).

let raw: Awaited<ReturnType<typeof createSqlJsDriver>>['raw'];
const q = (sql: string) => raw.exec(sql)[0]?.values ?? [];

async function household(opts: { tabs?: string; mine?: string } = {}) {
  raw.run("INSERT OR REPLACE INTO sync_meta (key, value) VALUES ('applying', '1')");
  raw.run("INSERT INTO household (k, v) VALUES ('owner', 'ownerphone'), ('member:me1', '{\"name\":\"Kitchen\"}'), ('member:ownerphone', '{\"name\":\"Dec\"}')");
  if (opts.tabs) raw.run(`INSERT INTO household (k, v) VALUES ('tabs', '${opts.tabs}')`);
  raw.run("DELETE FROM sync_meta WHERE key = 'applying'");
  raw.run("UPDATE sync_meta SET value = 'me1' WHERE key = 'device'");
  if (opts.mine) raw.run(`INSERT INTO sync_meta (key, value) VALUES ('tabs', '${opts.mine}')`);
}

beforeEach(async () => {
  const driver = await createSqlJsDriver({ load: () => initSqlJs() });
  raw = driver.raw;
  await initDb(driver);
  await updateSettings({ onboarded: true }, { local: true });
});

describe('the rules (sharedSettings.ts)', () => {
  it('applies rows for the tabs this phone syncs only, keeping its branches', () => {
    const s: Record<string, unknown> = {
      enabledChains: ['coles', 'bws'],
      stores: { coles: { primary: 'Coles Kirwan', branchStoreNo: '0844' } },
      sections: { keg: true, pharmacy: false },
      shopAroundMin: 1,
    };
    const rows = [
      { k: 'shop:coles', v: '{"on":false}' },
      { k: 'shop:aldi', v: '{"on":true}' },
      { k: 'shop:bws', v: '{"on":false}' },
      { k: 'tab:keg', v: 'false' },
      { k: 'shopAroundMin', v: '6' },
      { k: 'defaultThresholdPct', v: '500' }, // out of range: left out
      { k: 'nonsense', v: '1' },
    ];
    expect(applyRows(s, rows, new Set(['pantry']))).toBe(true);
    expect(s.enabledChains).toEqual(['bws', 'aldi']);
    expect((s.sections as Record<string, boolean>).keg).toBe(true);
    expect(s.shopAroundMin).toBe(6);
    expect(s.defaultThresholdPct).toBeUndefined();
    expect(s.stores).toEqual({ coles: { primary: 'Coles Kirwan', branchStoreNo: '0844' } });
    // The same again: nothing changes.
    expect(applyRows(s, rows, new Set(['pantry']))).toBe(false);
  });

  it("checks a shop someone added: https, its search page only on its own site", () => {
    const shop = checkShop({ id: 'custom-a', name: ' Farm ', website: 'http://farm.example.com/', section: 'pantry', search: 'https://evil.example/?q={q}' }, 'custom-a');
    expect(shop).toEqual({ id: 'custom-a', name: 'Farm', website: 'https://farm.example.com/', section: 'pantry', createdAt: '' });
    expect(checkShop({ id: 'custom-a', name: 'Farm', website: 'https://farm.example.com', section: 'pantry', search: 'https://farm.example.com/s?q={q}' }, 'custom-a')?.search).toBe(
      'https://farm.example.com/s?q={q}',
    );
    expect(checkShop({ id: 'custom-b', name: 'Farm', website: 'https://farm.example.com', section: 'pantry' }, 'custom-a')).toBeUndefined();
    expect(checkShop({ id: 'custom-a', name: 'Farm', website: 'javascript:alert(1)', section: 'pantry' }, 'custom-a')).toBeUndefined();
    expect(settingTab('shop:danmurphys', null)).toBe('keg');
    expect(settingTab('shopAroundMin', '1')).toBeNull();
  });

  it('writes only what changed, for the tabs it syncs, and not what a row already says', () => {
    const before = { enabledChains: ['coles'], sections: { keg: false, pharmacy: false }, customShops: [], shopAroundMin: 1 };
    const next = { ...before, enabledChains: ['coles', 'aldi', 'priceline'], shopAroundMin: 1, defaultThresholdPct: 10 };
    const rows = changedRows(before, next, new Set(['pantry']), new Map([['shop:aldi', '{"on":false}']]));
    expect(rows).toEqual([['shop:aldi', '{"on":true}']]);
    expect(changedRows(before, next, new Set(['pantry']), new Map([['shop:aldi', '{"on":true}']]))).toEqual([]);
  });
});

describe('on a phone (the updateSettings hook)', () => {
  const rows = () => Object.fromEntries(q('SELECT k, v FROM household_settings').map(([k, v]) => [k, v]));

  it('writes nothing outside a household', async () => {
    await updateSettings({ shopAroundMin: 5 });
    expect(rows()).toEqual({});
    expect(await getHouseholdSettings()).toBeNull();
  });

  it('a change in Settings goes to the household as this phone’s change; local ones and other settings don’t', async () => {
    await household({ tabs: 'pantry,keg', mine: 'pantry' });
    await updateSettings({ shopAroundMin: 5, historyWeeks: 26 });
    const s = await getSettings();
    await updateSettings({ enabledChains: [...s.enabledChains.filter((c) => c !== 'aldi'), 'danmurphys'], sections: { keg: true, pharmacy: false } });
    await updateSettings({ defaultThresholdPct: 40 }, { local: true });
    expect(rows()).toEqual({ shopAroundMin: '5', 'shop:aldi': '{"on":false}' });
    expect(q("SELECT device FROM sync_log WHERE tbl = 'household_settings'").flat()).toEqual(['me1', 'me1']);
  });

  it('what arrives from sync updates the settings and is never sent back out', async () => {
    await household();
    const e = new WebSyncEngine(syncDbOf(raw), () => true, () => '');
    e.setMeta('tabs_eff', 'pantry,keg,pharmacy');
    const n = e.apply([
      { tbl: 'household_settings', pk: 'shopAroundMin', stamp: Date.now(), device: 'other', row: { k: 'shopAroundMin', v: '8' } },
      { tbl: 'household_settings', pk: 'shop:coles', stamp: Date.now(), device: 'other', row: { k: 'shop:coles', v: '{"on":false}' } },
    ]);
    expect(n).toBe(2);
    const s = await getSettings();
    expect(s.shopAroundMin).toBe(8);
    expect(s.enabledChains).not.toContain('coles');
    await updateSettings({ seenHints: ['x'] });
    await updateSettings({ ...s, seenHints: ['y'] });
    expect(q("SELECT pk, device FROM sync_log WHERE tbl = 'household_settings' ORDER BY pk")).toEqual([
      ['shop:coles', 'other'],
      ['shopAroundMin', 'other'],
    ]);
  });

  it('the API: get, set, and which settings are whose', async () => {
    await household({ tabs: 'pantry,pharmacy' });
    const h = await getHouseholdSettings();
    expect(h?.tabs.keg).toBeUndefined();
    expect(h?.tabs.pantry?.chains).toEqual(['woolworths', 'coles', 'aldi']);
    const shop = { id: 'custom-x' as const, name: 'Corner', website: 'https://corner.example.com', section: 'pantry' as const, createdAt: '' };
    const after = await setHouseholdSettings({ recallsEnabled: false, tabs: { pantry: { chains: ['coles', 'custom-x'], customShops: [shop] }, pharmacy: { on: true, chains: ['priceline'] } } });
    expect(after?.recallsEnabled).toBe(false);
    expect(after?.tabs.pantry).toEqual({ on: true, chains: ['coles', 'custom-x'], customShops: [shop] });
    expect(after?.tabs.pharmacy?.on).toBe(true);
    expect((await getSettings()).enabledChains).toEqual(['coles', 'custom-x', 'priceline']);
    await expect(setHouseholdSettings({ tabs: { keg: { on: true } } })).rejects.toThrow(/doesn't share/);
    await expect(setHouseholdSettings({ shopAroundMin: -1 })).rejects.toThrow();
    // Removing the shop someone added.
    await setHouseholdSettings({ tabs: { pantry: { customShops: [] } } });
    expect(JSON.parse(String(q("SELECT v FROM household_settings WHERE k = 'shop:custom-x'")[0][0]))).toMatchObject({ on: false, removed: true });
    expect((await getSettings()).customShops).toEqual([]);
    expect(settingScope('shopAroundMin')).toBe('household');
    expect(settingScope('recalls.enabled')).toBe('household');
    expect(settingScope('recalls.lastCheck')).toBe('phone');
    expect(settingScope('stores')).toBe('phone');
    expect(settingScope('autoBackup.everyDays')).toBe('phone');
    expect(HOUSEHOLD_WIDE).toContain('enabledChains');
  });

  it('review: a shop’s search page on www. or another part of its own site survives its own row', async () => {
    await household();
    const shop = { id: 'custom-f' as const, name: 'Farm', website: 'https://farm.example.com.au', section: 'pantry' as const, search: 'https://www.farm.example.com.au/search?q={q}', createdAt: '' };
    const s = await getSettings();
    await updateSettings({ customShops: [...s.customShops, shop], enabledChains: [...s.enabledChains, shop.id] });
    expect(JSON.parse(String(q("SELECT v FROM household_settings WHERE k = 'shop:custom-f'")[0][0])).shop.search).toBe(shop.search);
    // Next start (or any reapply): the household's row must not take the search page away.
    await reapplyHouseholdSettings();
    expect((await getSettings()).customShops.find((c) => c.id === 'custom-f')?.search).toBe(shop.search);
    // Still only on its own site, and never with a sign-in part or a host without a dot.
    const base = { id: 'custom-f', name: 'Farm', website: 'https://farm.example.com.au', section: 'pantry' };
    expect(checkShop({ ...base, search: 'https://farm.example.com.au.evil.net/?q={q}' }, 'custom-f')?.search).toBeUndefined();
    expect(checkShop({ ...base, search: 'http://shop.farm.example.com.au/?q={q}' }, 'custom-f')?.search).toBe('https://shop.farm.example.com.au/?q={q}');
    expect(checkShop({ ...base, website: 'https://farm.example.com.au@10.0.0.1' }, 'custom-f')).toBeUndefined();
    expect(checkShop({ ...base, website: 'https://localhost:8123' }, 'custom-f')).toBeUndefined();
  });

  it('review: the household turning Keg on never shows it on a phone that hasn’t said it’s 18 or over', async () => {
    await household();
    const row = [{ k: 'tab:keg', v: 'true' }];
    const minor: Record<string, unknown> = { sections: { keg: false, pharmacy: false } };
    expect(applyRows(minor, row, new Set(['pantry', 'keg']))).toBe(false);
    expect((minor.sections as Record<string, boolean>).keg).toBe(false);
    const adult: Record<string, unknown> = { sections: { keg: false, pharmacy: false }, adultConfirmed: true };
    expect(applyRows(adult, row, new Set(['pantry', 'keg']))).toBe(true);
    expect((adult.sections as Record<string, boolean>).keg).toBe(true);
    // Switching it off still applies.
    const on: Record<string, unknown> = { sections: { keg: true, pharmacy: false } };
    expect(applyRows(on, [{ k: 'tab:keg', v: 'false' }], new Set(['pantry', 'keg']))).toBe(true);
    // The web's Settings shows the household's own value, whatever this browser has confirmed.
    raw.run("INSERT INTO household_settings (k, v) VALUES ('tab:keg', 'true')");
    expect((await getHouseholdSettings())?.tabs.keg?.on).toBe(true);
    expect((await getSettings()).sections.keg).toBe(false);
  });
});

describe("the phones' summaries (phoneSummary.ts)", () => {
  it('keeps only the allow-list, whatever a phone sends', () => {
    const sent = {
      v: 1,
      version: '0.9.3',
      checks: { everyHours: 12, lastAt: '2026-11-09T01:02:03.000Z', lastItems: 40, wifiPassword: 'SECRET' },
      accounts: { woolworths: true, email: 'SECRET@example.com' },
      backups: { on: true, everyDays: 7, keep: 5, folder: 'content://SECRET', password: 'SECRET' },
      homeAssistant: { on: true, entity: 'todo.shopping', address: 'http://SECRET:8123', token: 'SECRET' },
      look: { theme: 'dark', text: 'Large', accent: 'SECRET' },
      cards: 2,
      cardNumbers: ['SECRET'],
      away: 'webdav',
      awayAddress: 'https://SECRET',
      updates: { on: true, everyDays: 7 },
    };
    const clean = cleanSummary(sent);
    expect(JSON.stringify(clean)).not.toContain('SECRET');
    expect(clean).toMatchObject({ version: '0.9.3', cards: 2, away: 'webdav', backups: { on: true, everyDays: 7, keep: 5 }, homeAssistant: { entity: 'todo.shopping' } });
    expect(cleanSummary({ v: 2 })).toBeNull();
    expect(cleanSummary({ v: 1, version: 'http://SECRET', checks: { lastAt: 'SECRET' }, homeAssistant: { entity: 'todo.SECRET token' } })).toEqual({ v: 1 });
  });

  it('server mode keeps each phone’s summary as its file comes in, and lists the phones', async () => {
    await household();
    const e = new WebSyncEngine(syncDbOf(raw), () => true, () => '');
    e.setMeta('device', 'web-abc');
    e.takeFile('restock-sync-ownerphone.bin', 'sum1', { device: 'ownerphone', name: 'Dec', at: '2026-11-10T00:00:00Z', entries: [], summary: { v: 1, version: '0.9.3', password: 'x' } } as never, 'now');
    e.takeFile('restock-sync-me1.bin', 'sum2', { device: 'me1', name: 'Kitchen', entries: [] }, 'now');
    const list = await phoneSummaries();
    expect(list).toEqual([{ device: 'ownerphone', name: 'Dec', owner: true, version: '0.9.3', syncedAt: '2026-11-10T00:00:00Z', summary: { v: 1, version: '0.9.3' } }]);
    // Review: another browser's file naming a phone inside can't set that phone's summary, and an
    // odd "at" isn't kept.
    e.takeFile('restock-sync-web-evil.bin', 'sum3', { device: 'me1', name: 'Kitchen', entries: [], summary: { v: 1, version: '6.6.6' } } as never, 'now');
    expect((await phoneSummaries()).map((p) => p.device)).toEqual(['ownerphone']);
    e.takeFile('restock-sync-me1.bin', 'sum4', { device: 'me1', name: 'Kitchen', at: 'soon', entries: [], summary: { v: 1, version: '0.9.3' } } as never, 'now');
    expect((await phoneSummaries()).find((p) => p.device === 'me1')).toMatchObject({ version: '0.9.3', syncedAt: undefined });
  });
});

describe('0.9.3 migration', () => {
  it('reads everything again once, for the household settings an older version passed over', async () => {
    const d = await createSqlJsDriver({ load: () => initSqlJs() });
    const before = MIGRATIONS.length - 1;
    for (let v = 0; v < before; v++) for (const sql of MIGRATIONS[v]) await d.run(sql);
    await d.run(`PRAGMA user_version = ${before}`);
    await d.run("INSERT INTO sync_peers (device, got) VALUES ('b2', 50)");
    await d.run("INSERT INTO sync_meta (key, value) VALUES ('folder_seen:restock-sync-b2.bin', 'x'), ('server_ver:restock-sync-b2.bin', 'y'), ('keep', 'z')");
    await migrate(d);
    expect(await d.query('SELECT got FROM sync_peers')).toEqual([{ got: 0 }]);
    expect((await d.query<{ key: string }>('SELECT key FROM sync_meta ORDER BY key')).map((r) => r.key)).toEqual(['device', 'keep']);
    await d.run("INSERT INTO household_settings (k, v) VALUES ('shopAroundMin', '3')");
    expect(await d.query("SELECT tbl, pk, deleted FROM sync_log WHERE tbl = 'household_settings'")).toEqual([{ tbl: 'household_settings', pk: 'shopAroundMin', deleted: 0 }]);
  });
});

describe('the 60-second check (sync.ts)', () => {
  it('never overlaps, and waits while Restock is in the background', async () => {
    let visible = true;
    let running = 0;
    let most = 0;
    let calls = 0;
    let wake: () => void = () => undefined;
    const stop = pollServer({
      usesServer: async () => true,
      poll: async () => {
        calls++;
        running++;
        most = Math.max(most, running);
        await new Promise((r) => setTimeout(r, 30));
        running--;
      },
      visible: () => visible,
      onVisible: (fn) => {
        wake = fn;
        return () => undefined;
      },
      every: 5,
    });
    await new Promise((r) => setTimeout(r, 80));
    expect(most).toBe(1);
    expect(calls).toBeGreaterThan(0);
    visible = false;
    await new Promise((r) => setTimeout(r, 40));
    const hidden = calls;
    await new Promise((r) => setTimeout(r, 40));
    expect(calls).toBe(hidden);
    visible = true;
    wake();
    await new Promise((r) => setTimeout(r, 5));
    expect(calls).toBe(hidden + 1);
    stop();
  });
});

describe('the shopping list’s rows (0.9.3: alias:, keep:, ha:phone)', () => {
  it('takes only what Restock writes, checked strictly', () => {
    const id = '3f1c2a9e-0b7d-4c55-9a51-1e2f3a4b5c6d';
    expect(checkListRow('alias:milk', id)).toBe(id);
    expect(checkListRow('alias:oat milk', 'ha-' + id)).toBe('ha-' + id);
    expect(checkListRow('alias:молоко', id)).toBe(id);
    for (const [k, v] of [
      ['alias:', id],
      ['alias:Milk', id], // not as matchKey leaves it
      ['alias:milk ', id],
      ['alias:two  spaces', id],
      ['alias:milk!', id],
      ['alias:' + 'x'.repeat(81), id],
      ['alias:milk', 'demo-milk'],
      ['alias:milk', 'has space'],
      ['alias:milk', 7],
      ['alias:milk', { id }],
      ['alias:milk', 'x'.repeat(81)],
      ['keep:ha-1', 'true'],
      ['keep:ha-1', 1],
      ['keep:demo-1', true],
      ['keep:../x', true],
      ['ha:phone', 'web-abc'],
      ['ha:phone', ''],
      ['ha:phone', 42],
      ['ha:phones', 'abc'],
    ] as [string, unknown][])
      expect(checkListRow(k, v), `${k} = ${JSON.stringify(v)}`).toBeUndefined();
    expect(checkListRow('keep:ha-1', true)).toBe(true);
    expect(checkListRow('ha:phone', '0a1b2c3d4e5f6071')).toBe('0a1b2c3d4e5f6071');
  });

  it('they aren’t settings: applying them changes nothing, on every tab', () => {
    const rows = [
      { k: 'alias:milk', v: '"abc"' },
      { k: 'keep:ha-1', v: 'true' },
      { k: 'ha:phone', v: '"0a1b2c3d4e5f6071"' },
      { k: 'future:thing', v: '{"x":1}' },
    ];
    const s: Record<string, unknown> = { shopAroundMin: 1 };
    expect(applyRows(s, rows, new Set(['pantry', 'keg', 'pharmacy']), { adult: true })).toBe(false);
    expect(s).toEqual({ shopAroundMin: 1 });
    for (const r of rows) {
      expect(checkValue(r.k, JSON.parse(r.v))).toBeUndefined();
      expect(settingTab(r.k, r.v)).toBeNull(); // the whole household's (never left out as another tab's)
    }
    expect(isListRow('alias:milk') && isListRow('keep:x') && isListRow('ha:phone') && !isListRow('shopAroundMin')).toBe(true);
  });
});

describe('the web takes a file’s author from its name (0.9.3, as phones on a server do)', () => {
  it('refuses a file that names another device inside, a phone’s or a browser’s', async () => {
    await household();
    const e = new WebSyncEngine(syncDbOf(raw), () => true, () => '');
    e.setMeta('device', 'web-abc');
    const line = (id: string, device: string) => ({ tbl: 'list_entries', pk: id, stamp: Date.now(), device, created: Date.now(), row: { id, text: id, checked: 0, created_at: 'x', qty: 1, section: 'pantry' } });
    expect(e.takeFile('restock-sync-z9.bin', 's1', { device: 'me1', entries: [line('posing1', 'me1')] }, 'now')).toBe(-1);
    expect(e.takeFile('restock-sync-web-evil.bin', 's2', { device: 'web-other', entries: [line('posing2', 'web-other')] }, 'now')).toBe(-1);
    expect(e.takeFile('restock-sync-me1.bin', 's3', { entries: [line('nobody', 'me1')] }, 'now')).toBe(-1);
    expect(e.takeFile('restock-sync-me1.bin', 's4', { device: 'me1', entries: [line('real1', 'me1')] }, 'now')).toBe(1);
    // Another browser's own file: its line, but not a loyalty card or a household change.
    const card = { tbl: 'cards', pk: 'k9', stamp: Date.now(), device: 'web-other', created: 1, row: { id: 'k9', program: 'flybuys', label: 'x', number: '', created_at: 'x' } };
    const name = { tbl: 'household', pk: 'name', stamp: Date.now(), device: 'web-other', row: { k: 'name', v: 'Mine now' } };
    expect(e.takeFile('restock-sync-web-other.bin', 's5', { device: 'web-other', entries: [line('webline', 'web-other'), card, name] }, 'now')).toBe(1);
    expect(q("SELECT id FROM list_entries ORDER BY id")).toEqual([['real1'], ['webline']]);
    expect(q("SELECT COUNT(*) FROM cards")).toEqual([[0]]);
    // Passed over files are noted as seen (not read again until they change).
    expect(e.seenSum('restock-sync-z9.bin')).toBe('s1');
  });
});

describe('household_settings changes from another device (review: settingChangeOk)', () => {
  const setting = (k: string, v: string, device = 'ownerphone', stamp = Date.now()) => ({ tbl: 'household_settings', pk: k, stamp, device, created: stamp, row: { k, v } });

  it('takes the shopping list’s rows only as Restock writes them, and others of a sensible size', async () => {
    await household();
    const e = new WebSyncEngine(syncDbOf(raw), () => true, () => '');
    e.setMeta('device', 'web-abc');
    const good = [setting('alias:milk', '"i-milk"'), setting('keep:ha-1', 'true'), setting('ha:phone', '"ownerphone"'), setting('future:thing', '{"x":1}')];
    const bad = [
      setting('alias:__proto__', '"i-milk"'),
      setting('alias:Milk', '"i-milk"'),
      setting('alias:eggs', '"' + 'x'.repeat(5000) + '"'),
      setting('alias:bread', '{"__proto__":1}'),
      setting('alias:oats', ' "i-oats"'),
      setting('keep:ha-2', '1'),
      setting('keep:demo-1', 'true'),
      setting('ha:phone', '"web-abc"', 'me1', Date.now() + 5),
      setting('future:big', JSON.stringify('y'.repeat(5000))),
      setting('x'.repeat(300), '1'),
      { ...setting('keep:ha-3', 'true'), row: { k: 'keep:ha-4', v: 'true' } },
      { ...setting('future:null', '1'), row: { k: 'future:null', v: null } },
    ];
    expect(e.apply([...good, ...bad] as never)).toBe(4);
    expect(q('SELECT k, v FROM household_settings ORDER BY k')).toEqual([
      ['alias:milk', '"i-milk"'],
      ['future:thing', '{"x":1}'],
      ['ha:phone', '"ownerphone"'],
      ['keep:ha-1', 'true'],
    ]);
    // A delete always goes (of a key that's right).
    expect(e.apply([{ ...setting('keep:ha-1', 'true', 'ownerphone', Date.now() + 10), deleted: true, row: undefined }] as never)).toBe(1);
    expect(q("SELECT COUNT(*) FROM household_settings WHERE k = 'keep:ha-1'")).toEqual([[0]]);
  });

  it('stops a flood of new rows at the limits, but a row already there can still change', async () => {
    await household();
    const e = new WebSyncEngine(syncDbOf(raw), () => true, () => '');
    e.setMeta('device', 'web-abc');
    const t = Date.now();
    const flood = Array.from({ length: LIST_ROWS_MAX + 50 }, (_, i) => setting(`keep:l${i}`, 'true', 'ownerphone', t));
    expect(e.apply(flood as never)).toBe(LIST_ROWS_MAX);
    expect(e.apply([setting('keep:more', 'true', 'ownerphone', t + 1)] as never)).toBe(0);
    // Other kinds still have room, and one that's there can change.
    expect(e.apply([setting('alias:milk', '"i-milk"', 'ownerphone', t + 1), setting('alias:milk', '"i-oat"', 'ownerphone', t + 2)] as never)).toBe(2);
    expect(q("SELECT v FROM household_settings WHERE k = 'alias:milk'")).toEqual([['"i-oat"']]);
    expect(q('SELECT COUNT(*) FROM household_settings')).toEqual([[LIST_ROWS_MAX + 1]]);
    expect(ROWS_MAX).toBeGreaterThan(2 * LIST_ROWS_MAX);
  });
});
