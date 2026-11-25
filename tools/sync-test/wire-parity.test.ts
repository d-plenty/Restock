// 0.14.0: the iPhone's phone-to-phone sync (src/ios/wire.ts) against the Android app's own Java
// code over real sockets (WirePeer.java). Driven by tools/sync-test/wire-parity.sh.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import initSqlJs from 'sql.js';
import { expect, it } from 'vitest';
import { createSqlJsDriver } from '../../src/lib/sql/sqljs';
import { initDb, updateSettings } from '../../src/lib/db';
import { signedText, verifySig, signWithPkcs8 } from '../../src/server-mode/crypto';
import { AsyncSyncEngine } from '../../src/server-mode/engine';
import { asyncSyncDbOf, syncDbOf } from '../../src/server-mode/sqldb';
import { nodeLan } from '../../src/ios/nodeLan';
import { WifiHouse } from '../../src/ios/wire';

const CP = process.env.PARITY_CP ?? '';
const OUT = process.env.PARITY_OUT ?? 'tools/sync-test/out';

function javaPhone(id: string, role: 'owner' | 'joiner') {
  const p = spawn('java', ['-cp', CP, 'family.plenty.restock.WirePeer', OUT, id, role], { stdio: ['pipe', 'pipe', 'inherit'] });
  const lines = createInterface({ input: p.stdout });
  const waiting: ((l: string) => void)[] = [];
  const got: string[] = [];
  lines.on('line', (l) => {
    const w = waiting.shift();
    if (w) w(l);
    else got.push(l);
  });
  const next = () => new Promise<string>((ok) => (got.length ? ok(got.shift() as string) : waiting.push(ok)));
  return {
    ready: next,
    async say(cmd: string): Promise<string> {
      p.stdin.write(cmd + '\n');
      const l = await next();
      if (!l.startsWith('OK')) throw new Error(`${cmd} → ${l}`);
      return l.slice(3);
    },
    quit: () => p.kill(),
  };
}

async function iphone(device: string) {
  const driver = await createSqlJsDriver({ load: () => initSqlJs() });
  await initDb(driver);
  await updateSettings({ onboarded: true }, { local: true });
  const sign = (text: string, priv: string | null) => signWithPkcs8(priv ?? '', text);
  const e = new AsyncSyncEngine(asyncSyncDbOf(syncDbOf(driver.raw)), verifySig, signedText, () => Date.now(), { role: 'phone', sign });
  await e.setMeta('device', device);
  await e.setMeta('name', 'iPhone ' + device);
  const lan = nodeLan();
  const house = new WifiHouse(e, () => lan);
  const names = () => (driver.raw.exec('SELECT name FROM items ORDER BY name')[0]?.values ?? []).map((r) => String(r[0])).join('|');
  const add = (id: string, name: string) => driver.raw.run("INSERT INTO items (id, name, created_at, section) VALUES (?, ?, 'x', 'pantry')", [id, name]);
  return { e, house, names, add, raw: driver.raw };
}

it.skipIf(!CP)('an iPhone joins an Android phone\'s household with its code, and they sync both ways', async () => {
  const android = javaPhone('a1a1a1a1a1a1a1a1', 'owner');
  try {
    expect(await android.ready()).toBe('READY');
    await android.say('ITEM i-milk Milk');
    const code = await android.say('INVITE');
    expect(code).toMatch(/^RESTOCK:3:[A-Z2-7]+:127\.0\.0\.1:\d+$/);

    const ios = await iphone('f0f0f0f0f0f0f0f0');
    ios.add('i-bread', 'Bread');
    expect(await ios.house.peek(code)).toMatchObject({ household: 'Java house', ownerName: 'Android a1a1a1a1a1a1a1a1' });
    await ios.house.join(code);
    expect((await ios.house.joined())).toBe(true);
    expect((await ios.house.isOwner())).toBe(false);
    expect(await android.say('MEMBERS')).toBe('a1a1a1a1a1a1a1a1|f0f0f0f0f0f0f0f0');

    // The iPhone asks the Android phone (the address it joined at).
    const s = await ios.house.syncAll();
    expect(s).toMatchObject({ reached: 1, removed: false, error: null });
    expect(ios.names()).toBe('Bread|Milk');
    expect(await android.say('ITEMS')).toBe('Bread|Milk');
    expect((await ios.house.members()).map((m) => m.device).sort()).toEqual(['a1a1a1a1a1a1a1a1', 'f0f0f0f0f0f0f0f0']);
    // A used code can't be used again (the owner hangs up on it, as it does for an Android phone).
    const other = await iphone('e1e1e1e1e1e1e1e1');
    await expect(other.house.join(code)).rejects.toThrow(/Couldn't reach the other phone/);

    // The Android phone asks the iPhone (it listens while Restock is open).
    await android.say('ITEM i-eggs Eggs');
    ios.add('i-jam', 'Jam');
    await ios.house.listen();
    const port = (await ios.house.info()).listening ? (ios.house as unknown as { listener: { port: number } }).listener.port : 0;
    expect(await android.say(`SYNC 127.0.0.1 ${port}`)).toMatch(/received=1 sent=\d+ removed=false/);
    expect(ios.names()).toBe('Bread|Eggs|Jam|Milk');
    expect(await android.say('ITEMS')).toBe('Bread|Eggs|Jam|Milk');

    // The owner removes the iPhone: it hears so at its next sync, keeps its things and stops.
    await android.say('REMOVE f0f0f0f0f0f0f0f0');
    const gone = await ios.house.syncAll();
    expect(gone.removed).toBe(true);
    expect((await ios.house.joined())).toBe(false);
    expect((await ios.e.meta('notice'))).toBe('removed');
    expect(ios.names()).toBe('Bread|Eggs|Jam|Milk');
    await ios.house.stop();
  } finally {
    android.quit();
  }
}, 120_000);

it.skipIf(!CP)('an Android phone joins a household an iPhone started, syncs, and takes a new key after another phone is removed', async () => {
  const android = javaPhone('b2b2b2b2b2b2b2b2', 'joiner');
  try {
    expect(await android.ready()).toBe('READY');
    const ios = await iphone('c3c3c3c3c3c3c3c3');
    ios.add('i-rice', 'Rice');
    (await ios.house.start('Apple house'));
    expect((await ios.house.isOwner())).toBe(true);
    const { code } = await ios.house.invite();
    await android.say('ITEM i-tea Tea');
    await android.say(`JOIN ${code}`);
    expect((await ios.house.members()).map((m) => m.device).sort()).toEqual(['b2b2b2b2b2b2b2b2', 'c3c3c3c3c3c3c3c3']);
    expect((await ios.house.info()).invite).toBeNull();
    const port = Number(code.split(':').pop());
    await android.say(`SYNC 127.0.0.1 ${port}`);
    expect(await android.say('ITEMS')).toBe('Rice|Tea');
    expect(ios.names()).toBe('Rice|Tea');
    expect(await android.say('MEMBERS')).toBe('b2b2b2b2b2b2b2b2|c3c3c3c3c3c3c3c3');

    // A second iPhone joins the first one's household (iPhone to iPhone), then is removed.
    const two = await iphone('d4d4d4d4d4d4d4d4');
    const again = await ios.house.invite();
    await two.house.join(again.code);
    expect((await two.house.syncAll()).reached).toBe(1);
    expect(two.names()).toBe('Rice|Tea');
    await ios.house.remove('d4d4d4d4d4d4d4d4');
    expect((await two.house.syncAll()).removed).toBe(true);
    expect(two.names()).toBe('Rice|Tea');

    // The Android phone still has the old key: it's given the new one and carries on.
    ios.add('i-salt', 'Salt');
    expect(await android.say('KEYV')).toBe('1');
    expect(await android.say(`SYNC 127.0.0.1 ${port}`)).toMatch(/rekey=false/);
    expect(await android.say('KEYV')).toBe('2');
    expect(await android.say('ITEMS')).toBe('Rice|Salt|Tea');

    // 0.15.0: the iPhone hands the household to the Android phone, which takes over after its sync
    // (the Java code's own takeHandover), and the iPhone lets the owner's secrets go at its next.
    await ios.house.handOver('b2b2b2b2b2b2b2b2');
    await android.say(`SYNC 127.0.0.1 ${port}`);
    expect(await android.say('TAKEHANDOVER')).toBe('true');
    expect(await android.say('OWNER')).toBe('b2b2b2b2b2b2b2b2 true');
    const androidPort = Number(await android.say('PORT'));
    await ios.house.listen();
    (await ios.e.setMeta('invite', `127.0.0.1:${androidPort}`));
    await ios.house.syncAll();
    expect((await ios.house.isOwner())).toBe(false);
    expect((await ios.e.meta('owner_secrets'))).toBeNull();
    await ios.house.stop();
    await two.house.stop();
  } finally {
    android.quit();
  }
}, 120_000);
