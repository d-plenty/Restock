import initSqlJs from 'sql.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// 0.9.3: Home Assistant on the phone's side: where the token and settings are kept (never in a
// backup or the household's settings), and the list in Restock's real database.

const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.secret-token-for-the-test.abcdefghijklmnop';

// Stand-in for HomeAssistant.java: the token is kept "in Android", outside the database.
const native = vi.hoisted(() => ({ token: undefined as string | undefined }));
vi.mock('./sql/native', async (importOriginal) => {
  const real = await importOriginal<typeof import('./sql/native')>();
  return {
    ...real,
    RestockNative: {
      haSaveToken: async ({ token }: { token: string }) => void (native.token = token),
      haForgetToken: async () => void (native.token = undefined),
      haHasToken: async () => ({ saved: !!native.token }),
    },
  };
});

const { addGroup, allListEntries, deleteListEntries, getKV, getSettings, initDb, ensureDefaults, nowIso, putKV, restoreParts, restoreSnapshot, uid, addListEntry } =
  await import('./db');
const { migrateAliases, tidyKeeps } = await import('./listPicks');
const { backupJson, EVERYTHING, readBackup } = await import('./backup');
const ha = await import('./homeAssistant');
const { syncRound, emptyState } = await import('./haSync');
const { createSqlJsDriver } = await import('./sql/sqljs');
const { householdSettingsFor, CARRIED_SETTINGS } = await import('./household');

let raw: { exec: (sql: string) => { values: unknown[][] }[] };

beforeEach(async () => {
  native.token = undefined;
  const d = await createSqlJsDriver({ load: () => initSqlJs() });
  raw = d.raw as never;
  await initDb(d);
  await ensureDefaults();
});

/** Everything in every table of the database, as text. */
function wholeDatabase(): string {
  const tables = raw.exec("SELECT name FROM sqlite_master WHERE type = 'table'")[0].values.map((r) => String(r[0]));
  return tables.map((t) => JSON.stringify(raw.exec(`SELECT * FROM "${t}"`))).join('\n');
}

const fakeHa = () => {
  const list: { uid: string; summary: string; status: 'needs_action' | 'completed' }[] = [];
  let n = 0;
  return {
    list,
    api: {
      items: async () => list.map((i) => ({ ...i })),
      add: async (summary: string) => void list.push({ uid: `u${++n}`, summary, status: 'needs_action' }),
      update: async (u: string, p: { rename?: string; status?: 'needs_action' | 'completed' }) => {
        const i = list.find((x) => x.uid === u)!;
        if (p.rename) i.summary = p.rename;
        if (p.status) i.status = p.status;
      },
      remove: async (uids: string[]) => {
        for (const u of uids) list.splice(list.findIndex((x) => x.uid === u), 1);
      },
    },
    say: (summary: string) => list.push({ uid: `u${++n}`, summary, status: 'needs_action' }),
  };
};

async function pantryItem(name: string, section: 'pantry' | 'keg' = 'pantry') {
  const id = uid();
  await addGroup({ id, name, sameProductIds: [], altProductIds: [], alertLevel: 'good', section, createdAt: nowIso() } as never);
  return id;
}

describe('the token and settings stay on this phone', () => {
  it('never puts the token, the address or the pairing in the database, a backup or the household’s settings', async () => {
    await ha.saveHaToken(TOKEN, 'http://192.168.1.50:8123');
    await ha.saveHaConfig({ enabled: true, address: 'http://homeassistant.local:8123', entity: 'todo.shopping_list' });
    await pantryItem('Milk');
    const h = fakeHa();
    h.say('milk');
    h.say('oat milk');
    await syncRound(h.api, ha.dbStore());
    await putKV(ha.LIST_ALIASES, { bread: 'x' });
    expect(native.token).toBe(TOKEN);

    expect(wholeDatabase()).not.toContain('secret-token');
    for (const json of [await backupJson(EVERYTHING), await backupJson({ ...EVERYTHING, pantry: false, list: false })]) {
      expect(json).not.toContain('secret-token');
      expect(json).not.toContain('homeassistant.local');
      expect(json).not.toContain('homeAssistant');
    }
    // The words saved for pantry items ("Always use this for …") do go in.
    expect(await backupJson(EVERYTHING)).toContain('listAliases');
    expect(readBackup(await backupJson(EVERYTHING)).counts.list).toBe(2);
    // A phone joining the household gets a copy of the settings: there's nothing of Home Assistant in them.
    const settings = await getSettings();
    expect(JSON.stringify(settings)).not.toMatch(/homeassistant|secret-token|todo\./i);
    expect(CARRIED_SETTINGS.join(' ')).not.toMatch(/home/i);
    expect(JSON.stringify(householdSettingsFor(settings, settings, { tabs: ['pantry'], replace: true }))).not.toMatch(/homeassistant|secret-token/i);

    await ha.removeHaToken();
    expect(native.token).toBeUndefined();
    expect((await ha.getHaConfig()).enabled).toBe(false);
  });

  it('keeps this phone’s settings through a restore, and pairs the restored list afresh', async () => {
    await ha.saveHaConfig({ enabled: true, address: 'http://192.168.1.50:8123', entity: 'todo.groceries' });
    await putKV(ha.HA_STATE, { pairs: [{ id: 'x', uid: 'y', r: { s: 'a', c: false }, h: { s: 'a', c: false } }], pick: [] });
    const backup = readBackup(await backupJson(EVERYTHING));
    // A backup someone made by hand with Home Assistant settings in it doesn't bring them in either.
    backup.snapshot.kv.push({ key: ha.HA_CONFIG, value: { enabled: true, address: 'https://evil.example', entity: 'todo.x' } });
    await restoreSnapshot(backup.snapshot);
    expect(await ha.getHaConfig()).toEqual({ enabled: true, address: 'http://192.168.1.50:8123', entity: 'todo.groceries' });
    expect(await getKV(ha.HA_STATE)).toBeUndefined();

    await putKV(ha.HA_STATE, { pairs: [{ id: 'x', uid: 'y', r: { s: 'a', c: false }, h: { s: 'a', c: false } }], pick: [] });
    await restoreParts(backup.snapshot, { pantry: false, list: true, cards: false, settings: false });
    expect(await getKV(ha.HA_STATE)).toBeUndefined();
  });

  it('starts the pairing afresh for a new address or list, and keeps it through off and on', async () => {
    await ha.saveHaConfig({ enabled: true, address: 'http://a.local:8123' });
    const st = { pairs: [{ id: 'x', uid: 'y', r: { s: 'a', c: false }, h: { s: 'a', c: false } }], pick: [] };
    await putKV(ha.HA_STATE, st);
    await ha.saveHaConfig({ enabled: false });
    await ha.saveHaConfig({ enabled: true });
    expect(await getKV(ha.HA_STATE)).toEqual(st);
    await ha.saveHaConfig({ entity: 'todo.other' });
    expect(await getKV(ha.HA_STATE)).toEqual(emptyState());
  });
});

describe('a round under way when the pairing starts afresh', () => {
  /** A Home Assistant whose list is read only once `go()` is called. */
  const slowHa = (h: ReturnType<typeof fakeHa>) => {
    let go!: () => void;
    const gate = new Promise<void>((r) => (go = r));
    return { go, api: { ...h.api, items: async () => (await gate, h.api.items()) } };
  };

  it('a new list picked mid-round: the old round changes nothing, and the new list takes nothing off Restock’s', async () => {
    await ha.saveHaConfig({ enabled: true, address: 'http://homeassistant.local:8123', entity: 'todo.shopping_list' });
    await addListEntry({ id: uid(), text: 'apples', section: 'pantry', checked: false, createdAt: nowIso() });
    await addListEntry({ id: uid(), text: 'pears', section: 'pantry', checked: false, createdAt: nowIso() });
    const a = fakeHa();
    await syncRound(a.api, ha.dbStore());
    expect(a.list).toHaveLength(2);

    // A round for the old list starts, then the list is changed before it has read it.
    const slow = slowHa(a);
    const resets = (await import('./haKeys')).haPairingResets();
    const old = syncRound(slow.api, ha.dbStore(resets));
    await ha.saveHaConfig({ entity: 'todo.groceries' });
    slow.go();
    await expect(old).rejects.toBeInstanceOf(ha.PairingRestarted);
    expect(await getKV(ha.HA_STATE)).toEqual(emptyState());

    // The new list (empty): Restock's lines go onto it, and none come off Restock's list.
    const b = fakeHa();
    await syncRound(b.api, ha.dbStore());
    await syncRound(b.api, ha.dbStore());
    expect((await allListEntries()).map((e) => e.text).sort()).toEqual(['apples', 'pears']);
    expect(b.list.map((i) => i.summary).sort()).toEqual(['apples', 'pears']);
  });

  it('a restore part-way through a round: the round doesn’t save its pairing over the fresh one', async () => {
    await ha.saveHaConfig({ enabled: true, address: 'http://homeassistant.local:8123' });
    await addListEntry({ id: uid(), text: 'apples', section: 'pantry', checked: false, createdAt: nowIso() });
    const h = fakeHa();
    await syncRound(h.api, ha.dbStore());
    const backup = readBackup(await backupJson(EVERYTHING));
    // The round has read its pairing, and is still talking to Home Assistant when the restore happens.
    const store = ha.dbStore();
    let restore!: Promise<void>;
    const api = {
      ...h.api,
      add: async (s: string) => {
        restore ??= restoreParts(backup.snapshot, { pantry: false, list: true, cards: false, settings: false });
        await restore;
        return h.api.add(s);
      },
    };
    await addListEntry({ id: uid(), text: 'pears', section: 'pantry', checked: false, createdAt: nowIso() });
    await syncRound(api, store);
    expect(await getKV(ha.HA_STATE)).toBeUndefined();
  });
});

describe('the list in the database', () => {
  it('adds voice adds to the groceries list, linked when it’s clearly one pantry item', async () => {
    const milk = await pantryItem('Milk');
    await pantryItem('Bread');
    await pantryItem('bread');
    await pantryItem('Beer', 'keg');
    await addListEntry({ id: uid(), text: 'Ice', section: 'keg', checked: false, createdAt: nowIso() });
    await ha.saveHaConfig({ enabled: true, address: 'http://homeassistant.local:8123' });
    const h = fakeHa();
    h.say('2 milk');
    h.say('bread');
    h.say('beer');
    await syncRound(h.api, ha.dbStore());
    const lines = await allListEntries();
    expect(lines.find((e) => e.groupId === milk)).toMatchObject({ text: 'Milk', qty: 2, section: 'pantry' });
    expect(lines.find((e) => e.text === 'bread')?.groupId).toBeUndefined();
    // Only pantry items: "beer" isn't the Keg tab's Beer. And the Keg list's ice stays out of Home Assistant.
    expect(lines.find((e) => e.text === 'beer')?.groupId).toBeUndefined();
    expect(h.list.map((i) => i.summary)).toEqual(['2 milk', 'bread', 'beer']);
    expect((await ha.linesToPick()).size).toBe(2);
  });

  it('Pick my bread: links the line, saves the words if asked, and the next "bread" links straight away', async () => {
    await pantryItem('Wholemeal bread');
    const white = await pantryItem('White bread');
    await ha.saveHaConfig({ enabled: true, address: 'http://homeassistant.local:8123' });
    const h = fakeHa();
    h.say('bread');
    await syncRound(h.api, ha.dbStore());
    const [line] = await allListEntries();
    expect([...(await ha.linesToPick())]).toEqual([line.id]);
    expect(ha.pickWord(line.text)).toBe('bread');

    await ha.pickItemFor(line, { id: white, name: 'White bread' }, true);
    expect((await ha.linesToPick()).size).toBe(0);
    expect((await allListEntries())[0]).toMatchObject({ groupId: white, text: 'White bread' });
    await syncRound(h.api, ha.dbStore());
    // Home Assistant gets the item's name.
    expect(h.list[0].summary).toBe('White bread');

    // Emptied in Home Assistant: held once (the safety catch), cleared when it's still empty 2 minutes on.
    h.list.length = 0;
    const t = Date.now();
    expect((await syncRound(h.api, ha.dbStore(), t)).held).toBe(true);
    expect(await allListEntries()).toHaveLength(1);
    await syncRound(h.api, ha.dbStore(), t + 3 * 60_000);
    expect(await allListEntries()).toEqual([]);
    h.say('Breads');
    await syncRound(h.api, ha.dbStore());
    expect((await allListEntries())[0]).toMatchObject({ groupId: white });
    expect((await ha.linesToPick()).size).toBe(0);
  });

  it('Keep it as just the words: the button goes, the line stays', async () => {
    await pantryItem('Milk');
    await ha.saveHaConfig({ enabled: true, address: 'http://homeassistant.local:8123' });
    const h = fakeHa();
    h.say('oat milk');
    await syncRound(h.api, ha.dbStore());
    const [line] = await allListEntries();
    await ha.keepAsWords(line.id);
    expect((await ha.linesToPick()).size).toBe(0);
    expect((await allListEntries())[0]).toMatchObject({ text: 'oat milk' });
  });

  it('shows "Pick my …" on any phone or the web, for lines that came from Home Assistant', async () => {
    // A phone (or the web) that doesn't talk to Home Assistant: the line came through the household's sync.
    await pantryItem('Milk');
    await addListEntry({ id: 'ha-1', text: 'oat milk', section: 'pantry', checked: false, createdAt: nowIso() });
    await addListEntry({ id: 'typed', text: 'oat milk', section: 'pantry', checked: false, createdAt: nowIso() });
    await addListEntry({ id: 'ha-2', text: 'Ice', section: 'keg', checked: false, createdAt: nowIso() });
    await addListEntry({ id: 'ha-3', text: 'done', section: 'pantry', checked: true, createdAt: nowIso() });
    await addListEntry({ id: 'ha-4', text: 'Tim Tams', section: 'pantry', checked: false, createdAt: nowIso(), product: { chain: 'coles', name: 'Tim Tams' } });
    expect([...(await ha.linesToPick())]).toEqual(['ha-1']);
    // Kept as just the words: gone here, and the row that says so is the household's.
    await ha.keepAsWords('ha-1');
    expect((await ha.linesToPick()).size).toBe(0);
    expect(raw.exec("SELECT v FROM household_settings WHERE k = 'keep:ha-1'")[0].values).toEqual([['true']]);
    // An old local "Pick my" list (test builds) still counts on the phone that has it.
    await putKV(ha.HA_STATE, { pairs: [], pick: ['typed'] });
    expect([...(await ha.linesToPick())]).toEqual(['typed']);
  });

  it('an alias saved on any phone is the household’s, and the Home Assistant phone’s matcher uses it', async () => {
    await pantryItem('Wholemeal bread');
    const white = await pantryItem('White bread');
    await addListEntry({ id: 'ha-9', text: '2 bread', qty: 1, section: 'pantry', checked: false, createdAt: nowIso() });
    await ha.pickItemFor((await allListEntries())[0], { id: white, name: 'White bread' }, true);
    expect(raw.exec("SELECT v FROM household_settings WHERE k = 'alias:bread'")[0].values).toEqual([[JSON.stringify(white)]]);
    // Nothing in the old place.
    expect(await getKV(ha.LIST_ALIASES)).toBeUndefined();
    expect(await ha.getAliases()).toEqual({ bread: white });
    const h = fakeHa();
    h.say('breads');
    await syncRound(h.api, ha.dbStore());
    expect((await allListEntries()).filter((e) => e.groupId === white)).toHaveLength(2);
    // And it goes in a backup, where it always did.
    expect(JSON.parse(await backupJson(EVERYTHING)).tables.kv.find((k: { key: string }) => k.key === ha.LIST_ALIASES)?.value).toEqual({ bread: white });
  });

  it('moves aliases saved the old way into the household’s rows, once, without overwriting one already there', async () => {
    const milk = await pantryItem('Milk');
    const oat = await pantryItem('Oat milk');
    await putKV(ha.LIST_ALIASES, { milk: milk, 'oat milk': oat, 'bad words!': milk, eggs: 'demo-eggs' });
    raw.exec(`INSERT INTO household_settings (k, v) VALUES ('alias:oat milk', '"${milk}"')`);
    expect(await ha.getAliases()).toEqual({ milk, 'oat milk': milk });
    expect(await migrateAliases()).toBe(1);
    expect(await getKV(ha.LIST_ALIASES)).toBeUndefined();
    expect(raw.exec("SELECT k, v FROM household_settings WHERE k LIKE 'alias:%' ORDER BY k")[0].values).toEqual([
      ['alias:milk', JSON.stringify(milk)],
      ['alias:oat milk', JSON.stringify(milk)],
    ]);
    expect(await migrateAliases()).toBe(0);
  });

  it('tidies away "Keep it as just …" once its line has been gone a while', async () => {
    await addListEntry({ id: 'ha-k', text: 'oat milk', section: 'pantry', checked: false, createdAt: nowIso() });
    await ha.keepAsWords('ha-k');
    expect(await tidyKeeps()).toBe(0); // still on the list
    await deleteListEntries(['ha-k']);
    expect(await tidyKeeps()).toBe(0); // just deleted (an undo can still bring it back)
    expect(await tidyKeeps(Date.now() + 2 * 3600_000)).toBe(1);
    expect(raw.exec("SELECT COUNT(*) FROM household_settings WHERE k LIKE 'keep:%'")[0].values).toEqual([[0]]);
  });

  it('picking an item that is already on the list adds one more to that line', async () => {
    const milk = await pantryItem('Milk');
    await pantryItem('Milk ');
    await ha.saveHaConfig({ enabled: true, address: 'http://homeassistant.local:8123' });
    await addListEntry({ id: uid(), text: 'Milk', groupId: milk, qty: 1, section: 'pantry', checked: false, createdAt: nowIso() });
    const h = fakeHa();
    await syncRound(h.api, ha.dbStore());
    h.say('milk');
    await syncRound(h.api, ha.dbStore());
    const plain = (await allListEntries()).find((e) => !e.groupId)!;
    await ha.pickItemFor(plain, { id: milk, name: 'Milk' }, false);
    const lines = await allListEntries();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ groupId: milk, qty: 2 });
    await syncRound(h.api, ha.dbStore());
    // The second "milk" comes off Home Assistant's list and the first says 2.
    expect(h.list.map((i) => i.summary)).toEqual(['2 × Milk']);
  });

  it('a pick goes by the line as it is now: ticked or deleted on another phone meanwhile', async () => {
    const milk = await pantryItem('Milk');
    await addListEntry({ id: 'open1', text: 'Milk', groupId: milk, qty: 1, section: 'pantry', checked: false, createdAt: nowIso() });
    await addListEntry({ id: 'ha-t', text: 'milk', qty: 1, section: 'pantry', checked: false, createdAt: nowIso() });
    const shown = (await allListEntries()).find((e) => e.id === 'ha-t')!;
    // Ticked off on another phone while the sheet was open: linked, not folded into the open line and deleted.
    raw.exec("UPDATE list_entries SET checked = 1 WHERE id = 'ha-t'");
    expect(await ha.pickItemFor(shown, { id: milk, name: 'Milk' }, false)).toBe(true);
    expect((await allListEntries()).map((e) => [e.id, e.groupId, e.qty, e.checked])).toEqual([
      ['open1', milk, 1, false],
      ['ha-t', milk, 1, true],
    ]);
    // Deleted on another phone: nothing changes, and the open line doesn't get one more.
    await addListEntry({ id: 'ha-d', text: 'milk', qty: 1, section: 'pantry', checked: false, createdAt: nowIso() });
    const gone = (await allListEntries()).find((e) => e.id === 'ha-d')!;
    await deleteListEntries(['ha-d']);
    expect(await ha.pickItemFor(gone, { id: milk, name: 'Milk' }, false)).toBe(false);
    expect((await allListEntries()).find((e) => e.id === 'open1')?.qty).toBe(1);
  });
});

describe('one Home Assistant phone per household', () => {
  /** This phone in a household with Alex's phone (sync ids "me0…" and "alex…"). */
  const household = (more = '') => {
    raw.exec("UPDATE sync_meta SET value = 'me00000000000000' WHERE key = 'device'");
    raw.exec(`INSERT OR REPLACE INTO household (k, v) VALUES ('owner', 'me00000000000000'), ('member:me00000000000000', '{"name":"Kitchen"}'), ('member:alex000000000000', '{"name":"Alex"}')${more}`);
  };
  const row = () => raw.exec("SELECT v FROM household_settings WHERE k = 'ha:phone'")[0]?.values[0]?.[0];
  const logged = () => raw.exec("SELECT stamp, device FROM sync_log WHERE tbl = 'household_settings' AND pk = 'ha:phone'")[0]?.values[0];

  it('not in a household: this phone is the one, and no row is written', async () => {
    expect(await ha.haPhone()).toMatchObject({ inHousehold: false, mine: true });
    await ha.saveHaConfig({ address: 'http://homeassistant.local:8123' });
    await ha.takeHomeAssistant();
    expect(row()).toBeUndefined();
    expect(await ha.stillTheHaPhone()).toBe(true);
  });

  it('already on here with no phone named yet: takes it quietly, as the oldest change, so one named elsewhere still wins', async () => {
    household();
    await ha.saveHaConfig({ enabled: true, address: 'http://homeassistant.local:8123' });
    expect(await ha.stillTheHaPhone()).toBe(true);
    expect(row()).toBe('"me00000000000000"');
    expect(logged()).toEqual([1, 'me00000000000000']);
  });

  it('turning it on takes it; another phone named moves it and starts the pairing afresh; this one stops when another takes it', async () => {
    household();
    await ha.saveHaConfig({ address: 'http://homeassistant.local:8123' });
    await ha.takeHomeAssistant();
    expect(row()).toBe('"me00000000000000"');
    expect(Number(logged()?.[0])).toBeGreaterThan(1000);
    // Alex's phone takes it (its row arrives through sync).
    raw.exec("INSERT INTO sync_meta (key, value) VALUES ('applying', '1')");
    raw.exec(`UPDATE household_settings SET v = '"alex000000000000"' WHERE k = 'ha:phone'`);
    raw.exec("DELETE FROM sync_meta WHERE key = 'applying'");
    await putKV(ha.HA_STATE, { pairs: [{ id: 'x', uid: 'y', r: { s: 'a', c: false }, h: { s: 'a', c: false } }], pick: [] });
    expect(await ha.haPhone()).toMatchObject({ device: 'alex000000000000', name: 'Alex', mine: false });
    expect(ha.phoneLabel('Alex')).toBe("Alex's phone");
    expect(await ha.stillTheHaPhone()).toBe(false);
    expect((await ha.getHaConfig()).enabled).toBe(false); // stopped here
    expect(row()).toBe('"alex000000000000"'); // and didn't take the row back
    // Move it here: this phone again, with a fresh pairing.
    await ha.takeHomeAssistant();
    expect(row()).toBe('"me00000000000000"');
    expect((await ha.getHaConfig()).enabled).toBe(true);
    expect(await getKV(ha.HA_STATE)).toEqual(emptyState());
    // Turned off here: the row goes, so the next phone just takes it.
    await ha.saveHaConfig({ enabled: false });
    expect(row()).toBeUndefined();
  });

  it('taking it back after another phone did it (and has since turned it off) starts the pairing afresh', async () => {
    household();
    await ha.saveHaConfig({ address: 'http://homeassistant.local:8123' });
    await ha.takeHomeAssistant();
    const stale = { pairs: [{ id: 'x', uid: 'y', r: { s: 'a', c: false }, h: { s: 'a', c: false } }], pick: [] };
    await putKV(ha.HA_STATE, stale);
    // Turned off and on again here, nobody else in between: its notes are still good.
    await ha.saveHaConfig({ enabled: false });
    await ha.takeHomeAssistant();
    expect(await getKV(ha.HA_STATE)).toEqual(stale);
    await ha.saveHaConfig({ enabled: false });
    // Alex's phone took it and then turned it off (its delete arrives through sync).
    raw.exec("INSERT INTO sync_meta (key, value) VALUES ('applying', '1')");
    raw.exec("UPDATE sync_log SET device = 'alex000000000000', stamp = stamp + 10 WHERE tbl = 'household_settings' AND pk = 'ha:phone'");
    raw.exec("DELETE FROM sync_meta WHERE key = 'applying'");
    expect(await ha.haPhone()).toMatchObject({ inHousehold: true, mine: false });
    await ha.takeHomeAssistant();
    expect(await getKV(ha.HA_STATE)).toEqual(emptyState());
    expect(row()).toBe('"me00000000000000"');
  });

  it('a phone named that has left the household: this phone takes over', async () => {
    household(", ('removed:alex000000000000', '1')");
    raw.exec("DELETE FROM household WHERE k = 'member:alex000000000000'");
    raw.exec(`INSERT INTO household_settings (k, v) VALUES ('ha:phone', '"alex000000000000"')`);
    expect(await ha.haPhone()).toMatchObject({ left: true, mine: false });
    await ha.saveHaConfig({ enabled: true, address: 'http://homeassistant.local:8123' });
    expect(await ha.stillTheHaPhone()).toBe(true);
    expect(row()).toBe('"me00000000000000"');
  });
});

describe('addresses and tokens as typed', () => {
  it('tidies an address', () => {
    expect(ha.tidyAddress('homeassistant.local:8123')).toBe('http://homeassistant.local:8123');
    expect(ha.tidyAddress('192.168.1.50:8123/lovelace/0')).toBe('http://192.168.1.50:8123');
    expect(ha.tidyAddress('homeassistant:8123')).toBe('http://homeassistant:8123');
    expect(ha.tidyAddress('abcdef.ui.nabu.casa')).toBe('https://abcdef.ui.nabu.casa');
    expect(ha.tidyAddress(' https://ha.example.com/ ')).toBe('https://ha.example.com');
    expect(ha.tidyAddress('http://100.101.102.103:8123')).toBe('http://100.101.102.103:8123');
    expect(ha.tidyAddress('ftp://x')).toBeUndefined();
    expect(ha.tidyAddress('http://user:pw@ha.local')).toBeUndefined();
    expect(ha.tidyAddress('')).toBeUndefined();
  });

  it('takes a token as pasted', () => {
    expect(ha.cleanToken(`  ${TOKEN}\n`)).toBe(TOKEN);
    expect(ha.cleanToken(`Bearer ${TOKEN}`)).toBe(TOKEN);
    expect(ha.cleanToken('short')).toBeUndefined();
    expect(ha.cleanToken('has a space in the middle of it somewhere')).toBeUndefined();
  });

  it('says plainly what Java couldn’t do', () => {
    expect(ha.reachText(new Error('Restock only uses http:// for a server at home (like 192.168.1.20) or on Tailscale. Use the server\'s https:// address.'))).toMatch(
      /Nabu Casa/,
    );
    expect(ha.reachText(new Error("Couldn't find that server. Check the address and your connection."))).toMatch(/IP address/);
    expect(ha.reachText(new Error("Couldn't reach the server. Check the address and your connection."))).toMatch(/home Wi-Fi/);
    expect(ha.reachText(new Error("The server's security certificate wasn't accepted, so Restock didn't connect."))).toMatch(/certificate/);
  });
});
