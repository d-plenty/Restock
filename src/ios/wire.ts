// 0.14.0: phone-to-phone sync over the Wi-Fi on iPhone and iPad, speaking exactly what the Android
// app speaks (SyncWire.java, SyncEngine.syncWith/handle, SyncHousehold's pairing): a TCP connection
// carrying messages of 4 bytes of length, then 12 bytes of nonce and AES-256-GCM sealed JSON.
//
// An iPhone can join a household an Android phone (or another iPhone) started, with the code that
// phone shows, and can start one itself. While Restock is open it listens for the other phones and
// looks for them (Bonjour, "_restocksync._tcp"); closed, iOS lets it do neither.
//
// The sockets and Bonjour are the app's native side (ios/App/App/RestockApple.swift, through
// ios/lan.ts); everything else is here, on the same engine the server and iCloud sync use.
import { strFromU8, strToU8 } from 'fflate';
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha2';
import { ALL_TABS, joinTabs, ownerOnly, parseTabs, type Entry, type Row, type WebSyncEngine } from '../server-mode/engine';
import { b64u, base32, ecdh, hex, newEcdhKey, newJavaKeyPair, openJson, random, sealJson, signWithPkcs8, signedText, unb64, unbase32 } from '../server-mode/crypto';
import { forgetHousehold, myKeys } from './household';

export const VERSION = 90;
export const PORT = 47461;
export const SERVICE = '_restocksync._tcp';
const PAGE = 400;
const MAX_PHOTO = 8 * 1024 * 1024;
const PHOTOS_PER_SYNC = 30;
export const MAX_PHONES = 6;
const CODE_LIFE_MS = 10 * 60_000;
const OLD_KEY_LIFE_MS = 60 * 24 * 3600 * 1000;
const FULL = `A household can have up to ${MAX_PHONES} phones. Remove one first.`;
/** Which key opened a connection's first message (SyncHousehold.CURRENT…): from MEMBER on, a phone's own secret. */
const CURRENT = 0;
const OLD = 1;
const PAIRING = 2;
const MEMBER = 3;
const PHOTO_PATH = /^receipts\/[A-Za-z0-9_-]{1,80}\.jpg$/;

type Msg = Record<string, unknown>;

/** A connection to another phone: one sealed message out, its sealed answer back. */
export interface Link {
  ask(frame: Uint8Array): Promise<Uint8Array>;
  close(): void;
}
export interface Found {
  host: string;
  port: number;
  txt: Record<string, string>;
}
/** The Wi-Fi as the app's native side gives it (ios/lan.ts); a pretend one in the tests. */
export interface Lan {
  dial(host: string, port: number, timeoutMs: number): Promise<Link>;
  /** Everyone advertising Restock on this Wi-Fi, found within `ms`. */
  browse(ms: number): Promise<Found[]>;
  /** Starts listening. `answer`: a connection's message in, its answer out (null: hang up). */
  /** `key`: which of the app's listeners this is ('sync' when not given; a one-time send has its own). `port`: the port to try first. */
  listen(
    answer: (conn: string, from: string, frame: Uint8Array) => Promise<Uint8Array | null>,
    ended: (conn: string) => void,
    opts?: { key?: string; port?: number },
  ): Promise<{ port: number; stop(): void }>;
  advertise(port: number, name: string, txt: Record<string, string>): Promise<void>;
  unadvertise(): Promise<void>;
  /** This device's address on the Wi-Fi, or null when it isn't on one. */
  localIp(): Promise<string | null>;
}
/** Where receipt photos are kept on this device. */
export interface Photos {
  size(path: string): Promise<number>;
  read(path: string): Promise<Uint8Array | null>;
  write(path: string, bytes: Uint8Array): Promise<void>;
}

export class WifiProblem extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WifiProblem';
  }
}
/** The other phone answered, but said no (a used code, a full household): its words. */
export class Refused extends Error {}

// ---------- SyncWire's small pieces ----------

const utf8 = (s: string) => strToU8(s);
const cat = (...p: Uint8Array[]) => {
  const out = new Uint8Array(p.reduce((n, x) => n + x.length, 0));
  let o = 0;
  for (const x of p) {
    out.set(x, o);
    o += x.length;
  }
  return out;
};
export const seal = (key: Uint8Array, m: unknown) => sealJson(key, '', m);
export const open = (key: Uint8Array, sealed: Uint8Array) => openJson<Msg>(key, '', sealed);
/** SyncWire.dayTag: the household's public tag for one day (UTC). */
export function dayTag(key: Uint8Array, dayOffset: number, now: number = Date.now()): string {
  const day = Math.floor(now / 86_400_000) + dayOffset;
  return hex(hmac(sha256, key, utf8(`restock-tag|${day}`)).slice(0, 8));
}
export const householdId = (key: Uint8Array) => hex(sha256(cat(utf8('restock-household'), key)).slice(0, 8));
export const pairingKey = (token: Uint8Array) => sha256(cat(utf8('restock-pairing'), token));
export const pairingTag = (token: Uint8Array) => householdId(pairingKey(token));
/** SyncHousehold.joinKey: SHA-256("restock-join" | ECDH secret | the code's pairing key). */
const joinKeyOf = (priv: Uint8Array, theirPub: string, pairing: Uint8Array) => sha256(cat(utf8('restock-join'), ecdh(priv, unb64(theirPub)), pairing));

/** SyncHousehold.parseCode: a scanned or typed code, RESTOCK:3:TOKEN:IP:PORT. */
export function parseCode(code: string): { token: string; host: string; port: number } {
  const p = (code ?? '').trim().replace(/\s+/g, '').split(':');
  if (p.length >= 3 && p[0].toUpperCase() === 'RESTOCK' && p[1] === '3') {
    // An IPv6 address has colons of its own: everything between the token and the last part.
    const host = p.length > 4 ? p.slice(3, -1).join(':') : (p[3] ?? '');
    return { token: p[2].toUpperCase(), host, port: p.length > 4 ? Number(p[p.length - 1]) || 0 : 0 };
  }
  if (p.length >= 2 && p[0].toUpperCase().startsWith('RESTOCK')) throw new WifiProblem('That code is from an older or newer Restock. Update both phones to the same version, then make a new code.');
  throw new WifiProblem("That isn't a Restock sync code.");
}
export const isWifiCode = (code: string) => /^\s*RESTOCK\s*:\s*3\s*:/i.test(code ?? '');

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const numOf = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};
const tabsJson = (t: Set<string>) => ALL_TABS.filter((x) => t.has(x));
const tabsOf = (a: unknown): Set<string> | null => (Array.isArray(a) ? parseTabs(a.map(String).join(',')) : null);
const isJpeg = (b: Uint8Array) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
const b64 = (b: Uint8Array) => btoa(Array.from(b, (x) => String.fromCharCode(x)).join(''));
const unb64std = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export function photoPaths(row: Row | null | undefined): string[] {
  const out: string[] = [];
  if (!row) return out;
  if (typeof row.photo === 'string' && PHOTO_PATH.test(row.photo)) out.push(row.photo);
  if (typeof row.pages === 'string') {
    try {
      const a = JSON.parse(row.pages) as unknown;
      if (Array.isArray(a)) for (const x of a) if (typeof x === 'string' && PHOTO_PATH.test(x) && !out.includes(x)) out.push(x);
    } catch {
      // not a list
    }
  }
  return out;
}

/** One end of a connection, a message at a time, sealed with one key (SyncWire.Client). */
class Client {
  constructor(
    private readonly key: Uint8Array,
    private readonly link: Link,
  ) {}
  async send(m: Msg): Promise<Msg> {
    const res = open(this.key, await this.link.ask(seal(this.key, m)));
    if ('error' in res) throw new Refused(String(res.error ?? ''));
    return res;
  }
  close() {
    this.link.close();
  }
}

export interface SyncSummary {
  reached: number;
  received: number;
  sent: number;
  names: string[];
  removed: boolean;
  error: string | null;
}

export interface WifiInfo {
  joined: boolean;
  owner: boolean;
  household: string | null;
  listening: boolean;
  invite: { code: string; until: number } | null;
}

/**
 * This device in a household of phones that sync over the Wi-Fi (SyncHousehold + SyncHub's part of
 * it). What's kept uses SyncHousehold's names in sync_meta, and wifi_house marks the kind.
 */
export class WifiHouse {
  private listener: { port: number; stop(): void } | null = null;
  private conns = new Map<string, { key: Uint8Array; which: number; device?: string }>();
  private memberOrder: string[] = [];
  private pending = new Map<string, { k: Uint8Array; at: number; name: string; pub: string | null }>();
  /** Told when another phone's changes came in while listening. */
  onChange: () => void = () => {};
  lastError: string | null = null;

  constructor(
    readonly e: WebSyncEngine,
    private readonly lan: () => Lan | undefined,
    private readonly photos: () => Photos | undefined = () => undefined,
    private readonly now: () => number = () => Date.now(),
  ) {}

  // ---------- what's kept ----------

  joined(): boolean {
    return this.e.meta('wifi_house') === '1' && this.e.meta('key') !== null && this.e.meta('secret') !== null;
  }
  isOwner(): boolean {
    return this.joined() && this.e.householdValue('owner') === this.e.device();
  }
  private key(): Uint8Array | null {
    const k = this.e.meta('key');
    return k ? unb64(k) : null;
  }
  private keyv(): number {
    return Number(this.e.meta('keyv') ?? 1) || 1;
  }
  private oldKey(): Uint8Array | null {
    const k = this.e.meta('oldkey');
    const until = Number(this.e.meta('oldkey_until') ?? 0);
    return k && this.now() <= until ? unb64(k) : null;
  }
  private openPairingKey(): Uint8Array | null {
    const t = this.e.meta('pair_token');
    const until = Number(this.e.meta('pair_until') ?? 0);
    return t && this.now() <= until ? pairingKey(unbase32(t)) : null;
  }
  private secrets(): Record<string, string> {
    try {
      const o = JSON.parse(this.e.meta('owner_secrets') ?? '{}') as Record<string, unknown>;
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(o)) if (typeof v === 'string') out[k] = v;
      return out;
    } catch {
      return {};
    }
  }
  private name(): string {
    return this.e.meta('name') ?? 'iPhone';
  }
  members(): { device: string; name: string; me: boolean; owner: boolean }[] {
    const me = this.e.device();
    const owner = this.e.householdValue('owner');
    const out: { device: string; name: string; me: boolean; owner: boolean }[] = [];
    for (const r of this.e.db.query("SELECT k, v FROM household WHERE k LIKE 'member:%' ORDER BY k")) {
      const device = String(r.k).slice('member:'.length);
      let name = 'Phone';
      try {
        const m = JSON.parse(String(r.v)) as { name?: unknown };
        if (typeof m.name === 'string' && m.name) name = m.name;
      } catch {
        if (typeof r.v === 'string' && r.v) name = r.v;
      }
      out.push({ device, name, me: device === me, owner: device === owner });
    }
    return out;
  }
  info(): WifiInfo {
    const joined = this.joined();
    const t = this.e.meta('pair_token');
    const until = Number(this.e.meta('pair_until') ?? 0);
    const code = this.e.meta('pair_code');
    return {
      joined,
      owner: this.isOwner(),
      household: joined ? (this.e.householdValue('name') ?? this.e.meta('household')) : null,
      listening: this.listener !== null,
      invite: joined && t && code && this.now() <= until ? { code, until } : null,
    };
  }

  private row(k: string, v: string | null): void {
    if (v === null) this.e.db.exec('DELETE FROM household WHERE k = ?', [k]);
    else this.e.db.exec('INSERT OR REPLACE INTO household (k, v) VALUES (?, ?)', [k, v]);
  }

  /** SyncHousehold.sign: the signature a household change goes out with, when this device may sign it. */
  private signOut(entries: Entry[]): Entry[] {
    const me = this.e.device();
    const owner = this.isOwner() ? this.e.meta('owner_priv') : null;
    const mine = this.e.meta('my_priv');
    for (const en of entries) {
      if (en.tbl !== 'household') continue;
      const pk = en.pk;
      if (pk === 'member:' + me && en.device === me && mine) en.sig = signWithPkcs8(mine, signedText(en));
      else if ((ownerOnly(pk) || pk.startsWith('member:')) && owner) en.sig = signWithPkcs8(owner, signedText(en));
    }
    return entries;
  }
  private collect(since: number, exclude: string | null, allowed: Set<string> | null, where: string, moves: boolean) {
    const c = this.e.collect(since, exclude, where ? 100_000 : PAGE, allowed, where, moves, 0);
    this.signOut(c.entries);
    return c;
  }
  private gotFrom(peer: string): number {
    return numOf(this.e.db.query('SELECT got FROM sync_peers WHERE device = ?', [peer])[0]?.got);
  }
  private setGot(peer: string, got: number): void {
    this.e.db.exec('INSERT OR IGNORE INTO sync_peers (device, got) VALUES (?, 0)', [peer]);
    this.e.db.exec('UPDATE sync_peers SET got = ? WHERE device = ? AND got < ?', [got, peer, got]);
  }
  private notePeer(peer: string, name: string | null, host: string | null, port: number): void {
    if (!peer) return;
    this.e.notePeer(peer, name);
    if (host) this.e.db.exec('UPDATE sync_peers SET host = ?, port = ? WHERE device = ?', [host, port, peer]);
  }

  // ---------- starting a household, adding and removing phones (the owner) ----------

  /** SyncHousehold.create + ensureKeys: this device starts a household and is its owner. */
  start(name: string, tabs: string[] = ALL_TABS): void {
    if (this.e.meta('key') !== null) throw new WifiProblem('This device is already in a household. Stop syncing it first.');
    const e = this.e;
    const owner = newJavaKeyPair();
    const mine = myKeys(e);
    const me = e.device();
    const t = new Set(tabs.filter((x) => ALL_TABS.includes(x)));
    t.add('pantry');
    e.db.transaction(() => {
      this.forget();
      e.setMeta('wifi_house', '1');
      e.setMeta('key', b64u(random(32)));
      e.setMeta('keyv', '1');
      e.setMeta('secret', b64u(random(32)));
      e.setMeta('owner_secrets', '{}');
      e.setMeta('owner_priv', owner.priv);
      e.setMeta('owner_pubkey', owner.pub);
      e.setMeta('owner_pin', owner.pub);
      e.setMeta('share_receipts', '0');
      e.setMeta('share_cards', '0');
      e.setMeta('seed_settings', '1');
      const n = name.trim().slice(0, 80) || 'Our house';
      this.row('name', n);
      this.row('owner', me);
      this.row('member:' + me, JSON.stringify({ name: this.name(), pub: mine.pub }));
      this.row('tabs', joinTabs(t));
      this.row('owner_pub', owner.pub);
      this.row('hid', b64u(random(9)));
      e.setMeta('tabs', null);
      e.setMeta('household', n);
      e.noteTabs();
    });
  }

  /** SyncHousehold.invite: a new one-time code (the one before stops working). It works once, for 10 minutes. */
  async invite(): Promise<{ code: string; until: number }> {
    if (!this.isOwner()) throw new WifiProblem('Only the phone that started the household can add phones.');
    if (this.members().length >= MAX_PHONES) throw new WifiProblem(FULL);
    await this.listen();
    const lan = this.lan();
    const ip = lan ? await lan.localIp() : null;
    if (!ip || !this.listener) throw new WifiProblem("This device isn't on Wi-Fi. Join the same Wi-Fi as the other phone, then try again.");
    const token = random(16);
    const until = this.now() + CODE_LIFE_MS;
    const code = `RESTOCK:3:${base32(token)}:${ip}:${this.listener.port}`;
    this.e.setMeta('pair_token', base32(token));
    this.e.setMeta('pair_until', String(until));
    this.e.setMeta('pair_code', code);
    await this.readvertise();
    return { code, until };
  }
  async closeInvite(): Promise<void> {
    for (const k of ['pair_token', 'pair_until', 'pair_code']) this.e.setMeta(k, null);
    await this.readvertise();
  }

  /** SyncHousehold.remove: the owner removes a phone; the household's key changes so it can't sync again. */
  async remove(device: string): Promise<void> {
    if (!this.isOwner()) throw new WifiProblem('Only the phone that started the household can remove phones.');
    if (device === this.e.device()) throw new WifiProblem("This phone started the household, so it can't be removed from it.");
    const e = this.e;
    e.db.transaction(() => {
      e.setMeta('oldkey', e.meta('key'));
      e.setMeta('oldkey_until', String(this.now() + OLD_KEY_LIFE_MS));
      e.setMeta('key', b64u(random(32)));
      e.setMeta('keyv', String(this.keyv() + 1));
      const s = this.secrets();
      delete s[device];
      e.setMeta('owner_secrets', JSON.stringify(s));
      this.row('member:' + device, null);
      this.row('removed:' + device, String(this.now()));
      e.db.exec('DELETE FROM sync_peers WHERE device = ?', [device]);
    });
    await this.readvertise();
  }

  // ---------- 0.15.0: handing the household to another phone (SyncHousehold.handOver) ----------

  /**
   * Owner: asks another phone to be the owner. This device stays the owner until that one takes over
   * at its next sync, so nothing is stuck if it never does (cancelHandOver undoes it). The phones'
   * secrets, the owner key and the recovery key go to it sealed with its own secret, in the household.
   */
  async handOver(device: string): Promise<void> {
    if (!this.isOwner()) throw new WifiProblem('Only the phone that started the household can do that.');
    const s = this.secrets();
    const theirs = s[device];
    if (!theirs || this.e.householdValue('member:' + device) === null) throw new WifiProblem("That phone isn't in the household.");
    const e = this.e;
    const rest: Record<string, string> = { ...s };
    delete rest[device];
    rest[e.device()] = e.meta('secret') ?? '';
    const give: Record<string, unknown> = { secrets: rest };
    if (e.meta('oldkey') !== null) {
      give.oldkey = e.meta('oldkey');
      give.oldkey_until = e.meta('oldkey_until');
    }
    if (e.meta('owner_priv') !== null) {
      give.owner_priv = e.meta('owner_priv');
      give.owner_pubkey = e.meta('owner_pubkey');
    }
    if (e.meta('recovery') !== null) {
      give.recovery = e.meta('recovery');
      give.recovery_saved = e.meta('recovery_saved') === '1';
    }
    const blob = b64u(seal(unb64(theirs), give));
    e.db.transaction(() => {
      for (const r of e.db.query("SELECT k FROM household WHERE k LIKE 'handover:%'")) this.row(String(r.k), null);
      this.row('handover:' + device, blob);
    });
    await this.closeInvite();
  }

  /** The phone the owner asked to take over, while it hasn't yet. */
  handingOverTo(): string | null {
    const r = this.e.db.query("SELECT k FROM household WHERE k LIKE 'handover:%' LIMIT 1")[0];
    return r ? String(r.k).slice('handover:'.length) : null;
  }

  /** Owner: never mind, stay the owner. */
  cancelHandOver(): void {
    if (!this.isOwner()) throw new WifiProblem('Only the phone that started the household can do that.');
    for (const r of this.e.db.query("SELECT k FROM household WHERE k LIKE 'handover:%'")) this.row(String(r.k), null);
  }

  /**
   * After a sync (SyncHousehold.takeHandover): if the owner asked this device to take over, take the
   * phones' secrets and become the owner; and a device that was the owner lets them go once another
   * took over. True when anything changed.
   */
  takeHandover(): boolean {
    const e = this.e;
    const me = e.device();
    const owner = e.householdValue('owner');
    let blob = e.householdValue('handover:' + me);
    // Only a request from the owner as it is now (not one left over from before a takeover).
    if (blob !== null && me !== owner) {
      const by = e.db.query("SELECT device FROM sync_log WHERE tbl = 'household' AND pk = ?", ['handover:' + me])[0];
      if (by && String(by.device ?? '') !== owner) blob = null;
    }
    if (blob === null || me === owner) {
      if (me !== owner && e.meta('owner_secrets') !== null && owner) {
        for (const k of ['owner_secrets', 'oldkey', 'oldkey_until', 'recovery', 'recovery_saved', 'owner_priv', 'owner_pubkey']) e.setMeta(k, null);
        return true;
      }
      return false;
    }
    const secret = e.meta('secret');
    if (!secret) return false;
    const give = open(unb64(secret), unb64(blob)) as Record<string, unknown>;
    e.db.transaction(() => {
      e.setMeta('owner_secrets', JSON.stringify(give.secrets ?? {}));
      if (typeof give.oldkey === 'string') {
        e.setMeta('oldkey', give.oldkey);
        e.setMeta('oldkey_until', String(give.oldkey_until ?? ''));
      }
      if (typeof give.owner_priv === 'string') {
        e.setMeta('owner_priv', give.owner_priv);
        e.setMeta('owner_pubkey', typeof give.owner_pubkey === 'string' ? give.owner_pubkey : null);
      }
      if (typeof give.recovery === 'string') {
        e.setMeta('recovery', give.recovery);
        e.setMeta('recovery_saved', give.recovery_saved ? '1' : null);
      }
      this.row('owner', me);
      this.row('handover:' + me, null);
    });
    return true;
  }

  // ---------- joining with a code ----------

  private async withOwner<T>(code: string, step: (c: Client) => Promise<T>): Promise<{ got: T; reached: string }> {
    const lan = this.lan();
    if (!lan) throw new WifiProblem('Syncing with another phone needs the Restock app.');
    const c = parseCode(code);
    const token = unbase32(c.token);
    if (token.length !== 16) throw new WifiProblem('That code is damaged. Make a new one on the other phone.');
    const pk = pairingKey(token);
    let where: { host: string; port: number }[] = c.host && c.port ? [{ host: c.host, port: c.port }] : [];
    for (let round = 0; round < 2; round++) {
      if (round === 1) {
        const tag = pairingTag(token);
        where = (await lan.browse(5000).catch(() => [])).filter((f) => f.txt.p === tag);
      }
      for (const w of where) {
        let link: Link;
        try {
          link = await lan.dial(w.host, w.port, 3000);
        } catch {
          continue; // not there: the next address
        }
        const cl = new Client(pk, link);
        try {
          return { got: await step(cl), reached: `${w.host}:${w.port}` };
        } catch (err) {
          // The other phone was reached and said no: its words, not "couldn't reach it".
          if (err instanceof Refused || err instanceof WifiProblem) throw new WifiProblem(err.message);
        } finally {
          cl.close();
        }
      }
    }
    throw new WifiProblem("Couldn't reach the other phone. Keep Restock open on it with the code showing, make sure both are on the same Wi-Fi, and try again.");
  }

  /** SyncHub.peek: what a code's household is, before joining. Doesn't use the code up. */
  async peek(code: string): Promise<{ household: string | null; ownerName: string | null; tabs: string[] }> {
    if (this.e.meta('key') !== null) throw new WifiProblem('This device is already in a household. Stop syncing it first.');
    const { got } = await this.withOwner(code, (c) => c.send({ op: 'peek', device: this.e.device() }));
    return { household: str(got.household), ownerName: str(got.ownerName), tabs: [...(tabsOf(got.tabs) ?? new Set(ALL_TABS))] };
  }

  /**
   * SyncHub.join ("Combine"): joins with the other phone's code. This device keeps its things; where
   * the household already has a record, the household's wins. `tabs`: what this device shares.
   */
  async join(code: string, tabs?: string[]): Promise<void> {
    if (this.e.meta('key') !== null) throw new WifiProblem('This device is already in a household. Stop syncing it first.');
    const e = this.e;
    const pairing = pairingKey(unbase32(parseCode(code).token));
    const secret = b64u(random(32));
    const mine = myKeys(e);
    const { got, reached } = await this.withOwner(code, async (c) => {
      const eph = newEcdhKey();
      const r = await c.send({ op: 'join', device: e.device(), name: this.name(), pub: mine.pub, epk: b64u(eph.pub), settings: false });
      const epk = str(r.epk);
      const sealed = str(r.sealed);
      if (!epk || !sealed) throw new WifiProblem('The other phone is on a much older Restock. Update it first.');
      const k = joinKeyOf(eph.priv, epk, pairing);
      const gift = open(k, unb64(sealed));
      await c.send({ op: 'join2', device: e.device(), sealed: b64u(seal(k, { secret })) });
      return gift;
    });
    const key = str(got.key);
    if (!key || unb64(key).length !== 32) throw new WifiProblem("The other phone's answer had no key for the household.");
    const t = tabs ? new Set(tabs.filter((x) => ALL_TABS.includes(x))) : null;
    e.db.transaction(() => {
      this.forget();
      e.setMeta('wifi_house', '1');
      e.setMeta('key', key);
      e.setMeta('keyv', String(numOf(got.keyv) || 1));
      e.setMeta('secret', secret);
      e.setMeta('owner_secrets', null);
      e.setMeta('owner_pin', str(got.owner_pub));
      // SyncEngine.yieldToHousehold: where the household has a record already, its version wins.
      e.db.exec("UPDATE sync_log SET stamp = 0, created = 0 WHERE tbl <> 'household'");
      e.setMeta('tabs', t ? joinTabs(t) : null);
      e.setMeta('tabs_eff', null);
      e.setMeta('share_cards', '0');
      e.setMeta('share_receipts', '0');
      e.setMeta('notice', null);
      if (str(got.household)) e.setMeta('household', str(got.household));
      e.setMeta('invite', reached);
    });
  }

  // ---------- SyncEngine.syncWith: this device asks another phone ----------

  private async send(c: Client, m: Msg, strict: boolean): Promise<Msg> {
    const nonce = b64u(random(12));
    const res = await c.send({ ...m, nonce, v: VERSION });
    const echoes = numOf(res.v) >= VERSION;
    if ((strict || echoes) && res.nonce !== nonce) throw new Error("The other phone's answer didn't match. Try again.");
    return res;
  }

  private async syncWith(c: Client, at: string, myPort: number): Promise<{ peer: string; peerName: string | null; household: string | null; removed: boolean; rekey: string | null; received: number; sent: number; photos: number }> {
    const e = this.e;
    e.noteTabs();
    const me = e.device();
    let mine = e.tabs();
    const h = await this.send(c, { op: 'hello', device: me, name: this.name(), port: myPort }, false);
    const r = { peer: String(h.device ?? ''), peerName: str(h.name), household: str(h.household), removed: h.removed === true, rekey: str(h.rekey), received: 0, sent: 0, photos: 0 };
    if (r.removed || r.rekey) return r;
    if (!r.peer || r.peer === me) return r;
    this.notePeer(r.peer, r.peerName, null, 0);
    const modern = numOf(h.v) >= VERSION;
    const peer = r.peer;
    e.setSeen(peer, numOf(h.got));
    let since = 0;
    for (let round = 0; round < 2; round++) {
      since = this.gotFrom(peer);
      for (let guard = 0; guard < 10_000; guard++) {
        const got = await this.send(c, { op: 'pull', device: me, since, tabs: tabsJson(mine), ...(modern ? { to: peer } : {}) }, modern);
        r.received += e.apply(got.entries as Entry[] | undefined);
        const top = 'top' in got ? numOf(got.top) : since;
        if (top > since) this.setGot(peer, top);
        since = Math.max(since, top);
        if (got.more !== true) break;
      }
      if (round > 0 || !e.noteTabs()) break;
      mine = e.tabs();
    }
    if (r.received > 0) e.tidyCategories();
    let theirs = numOf(h.got);
    const allowed = e.tabs();
    const peerTabs = tabsOf(h.tabs);
    if (peerTabs) for (const t of [...allowed]) if (!peerTabs.has(t)) allowed.delete(t);
    for (let guard = 0; guard < 10_000; guard++) {
      const col = this.collect(theirs, peer, allowed, '', modern);
      if (col.top <= theirs) break;
      await this.send(c, { op: 'push', device: me, entries: col.entries, top: col.top, at, seen: since, ...(modern ? { to: peer } : {}) }, modern);
      r.sent += col.entries.length;
      theirs = col.top;
      e.setSeen(peer, col.top);
      if (!col.more) break;
    }
    e.markSynced(peer, at);
    if (modern) {
      try {
        await this.send(c, { op: 'seen', device: me, to: peer, seen: since }, true);
      } catch {
        // a phone on 0.9.0
      }
      r.photos = await this.fetchPhotos(c, peer, mine).catch(() => 0);
    }
    return r;
  }

  /** SyncEngine.fetchPhotos: the photos of shared receipts that aren't on this device yet. */
  private async fetchPhotos(c: Client, peer: string, mine: Set<string>): Promise<number> {
    const photos = this.photos();
    const e = this.e;
    if (!photos || !e.shareReceipts()) return 0;
    let got = 0;
    let asked = 0;
    for (const row of e.db.query('SELECT * FROM receipts ORDER BY scanned_at DESC')) {
      const tab = e.tabOf('receipts', row);
      if (tab !== null && !mine.has(tab)) continue;
      for (const path of photoPaths(row)) {
        if ((await photos.size(path)) >= 0) continue;
        if (e.meta('photo_off:' + path) !== null) continue;
        if (asked++ >= PHOTOS_PER_SYNC) return got;
        let res: Msg;
        try {
          res = await this.send(c, { op: 'photo', device: e.device(), to: peer, path, tabs: tabsJson(mine) }, true);
        } catch (err) {
          if (String((err as Error).message).includes('unknown')) return got;
          continue;
        }
        if (res.path !== path || typeof res.data !== 'string' || !res.data || res.data.length > (MAX_PHOTO / 3 + 1) * 4) continue;
        let b: Uint8Array;
        try {
          b = unb64std(res.data);
        } catch {
          continue;
        }
        if (b.length > MAX_PHOTO || !isJpeg(b)) continue;
        await photos.write(path, b);
        got++;
      }
    }
    return got;
  }

  /** SyncHousehold.takeRekey: the household's new key, sealed with this device's own secret. */
  private takeRekey(sealed: string): boolean {
    const secret = this.e.meta('secret');
    if (!secret) return false;
    const k = open(unb64(secret), unb64(sealed));
    if (typeof k.for === 'string' && k.for !== this.e.device()) return false;
    const v = Number(k.keyv ?? 1) || 1;
    const key = str(k.key);
    if (v <= this.keyv() || !key || unb64(key).length !== 32) return false;
    this.e.setMeta('key', key);
    this.e.setMeta('keyv', String(v));
    return true;
  }

  /** SyncHub.syncAll (the Wi-Fi's part): finds the household's other phones and syncs with each. */
  async syncAll(): Promise<SyncSummary> {
    const s: SyncSummary = { reached: 0, received: 0, sent: 0, names: [], removed: false, error: null };
    const lan = this.lan();
    let key = this.key();
    if (!this.joined() || !key || !lan) return s;
    const e = this.e;
    await this.listen().catch(() => {});
    const myIp = await lan.localIp().catch(() => null);
    if (!myIp) {
      this.lastError = "This device isn't on Wi-Fi, so it can't reach the other phones right now.";
      s.error = this.lastError;
      return s;
    }
    const where = new Map<string, { host: string; port: number }>();
    const add = (host: string, port: number) => {
      if (host && port > 0 && !(host === myIp && port === this.listener?.port)) where.set(`${host}:${port}`, { host, port });
    };
    for (const r of e.db.query('SELECT host, port FROM sync_peers WHERE host IS NOT NULL AND port > 0')) add(String(r.host), numOf(r.port));
    const invite = e.meta('invite');
    if (invite && !invite.endsWith(':0')) add(invite.slice(0, invite.lastIndexOf(':')), Number(invite.slice(invite.lastIndexOf(':') + 1)));
    const seen = await lan.browse(4000).catch(() => [] as Found[]);
    const tags = (k: Uint8Array) => [dayTag(k, 0, this.now()), dayTag(k, -1, this.now()), dayTag(k, 1, this.now())];
    const mineTags = tags(key);
    for (const f of seen) if (mineTags.includes(f.txt.h) || mineTags.includes(f.txt.o)) add(f.host, f.port);
    let error: string | null = null;
    const done = new Set<string>();
    const owner = e.householdValue('owner');
    for (const w of where.values()) {
      let r: Awaited<ReturnType<WifiHouse['syncWith']>> | null = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        r = null;
        let cl: Client | null = null;
        try {
          cl = new Client(key, await lan.dial(w.host, w.port, 2500));
          r = await this.syncWith(cl, new Date(this.now()).toISOString(), this.listener?.port ?? 0);
        } catch (err) {
          error = (err as Error).message || null;
        } finally {
          cl?.close();
        }
        if (!r || !r.rekey) break;
        // The owner changed the household's key (it removed a phone): take the new one and go again.
        if (!this.takeRekey(r.rekey)) break;
        key = this.key() as Uint8Array;
        await this.readvertise();
      }
      if (!r) continue;
      // Only the owner can say this device was removed.
      if (r.removed && r.peer !== owner) continue;
      if (r.removed) {
        await this.stop();
        this.forget();
        e.setMeta('notice', 'removed');
        s.removed = true;
        break;
      }
      if (!r.peer || r.peer === e.device() || done.has(r.peer)) continue;
      done.add(r.peer);
      this.notePeer(r.peer, r.peerName, w.host, w.port);
      if (e.meta('household') === null && r.household) e.setMeta('household', r.household);
      s.reached++;
      s.received += r.received + r.photos;
      s.sent += r.sent;
      if (r.peerName) s.names.push(r.peerName);
      if (invite === `${w.host}:${w.port}`) e.setMeta('invite', null);
    }
    // No phone answered with the key this device has: maybe it missed key changes. Ask the owner with its own secret, now and then.
    if (!s.removed && s.reached === 0 && !this.isOwner() && this.now() - Number(e.meta('asked_key_at') ?? 0) > 10 * 60_000) {
      e.setMeta('asked_key_at', String(this.now()));
      const secret = e.meta('secret');
      const ask = [...where.values(), ...seen.map((f) => ({ host: f.host, port: f.port }))];
      for (const w of secret ? ask : []) {
        let cl: Client | null = null;
        try {
          cl = new Client(unb64(secret as string), await lan.dial(w.host, w.port, 2500));
          const r = await cl.send({ op: 'rekey', device: e.device() });
          if (r.removed === true) {
            await this.stop();
            this.forget();
            e.setMeta('notice', 'removed');
            s.removed = true;
            break;
          }
          const k = str(r.key);
          if (k && numOf(r.keyv) > this.keyv() && unb64(k).length === 32) {
            e.setMeta('key', k);
            e.setMeta('keyv', String(numOf(r.keyv)));
            await this.readvertise();
            break;
          }
        } catch {
          // not the owner, or not there
        } finally {
          cl?.close();
        }
      }
    }
    // 0.15.0: the owner may have handed the household to this device (or another took over from it).
    if (!s.removed && this.joined() && this.takeHandover()) await this.readvertise();
    this.lastError = s.reached > 0 || s.removed ? null : where.size === 0 ? 'No other phones found on this Wi-Fi. Open Restock on the other phone.' : `Couldn't reach the other phone${error ? `: ${error}` : '.'} Open Restock on it.`;
    s.error = this.lastError;
    return s;
  }

  // ---------- answering other phones (SyncWire.Server, SyncHousehold.handle, SyncEngine.handle) ----------

  private serverKeys(): (Uint8Array | null)[] {
    const l: (Uint8Array | null)[] = [this.key()];
    const owner = this.isOwner();
    l.push(owner ? this.oldKey() : null);
    l.push(owner ? this.openPairingKey() : null);
    const order: string[] = [];
    if (owner) {
      for (const [d, s] of Object.entries(this.secrets())) {
        if (this.e.householdValue('member:' + d) === null) continue;
        l.push(unb64(s));
        order.push(d);
      }
    }
    this.memberOrder = order;
    return l;
  }

  /** Starts listening for the household's other phones (while Restock is open). */
  async listen(): Promise<void> {
    const lan = this.lan();
    if (this.listener || !lan || !this.joined()) return;
    let took = false;
    this.listener = await lan.listen(
      async (conn, from, frame) => {
        let st = this.conns.get(conn);
        let msg: Msg | null = null;
        if (!st) {
          // The first message decides which key this connection uses; small until one opens it.
          if (frame.length > 256 * 1024) return null;
          const keys = this.serverKeys();
          for (let i = 0; i < keys.length && !msg; i++) {
            const k = keys[i];
            if (!k) continue;
            try {
              msg = open(k, frame);
              st = { key: k, which: i };
              this.conns.set(conn, st);
            } catch {
              // the next key
            }
          }
        } else {
          try {
            msg = open(st.key, frame);
          } catch {
            msg = null;
          }
        }
        if (!msg || !st) return null; // not one of ours: say nothing and hang up
        let res: Msg;
        try {
          res = await this.handle(msg, from, st.which);
          if (numOf(res.changed) > 0 || (st.which === PAIRING && 'ok' in res)) took = true;
        } catch (err) {
          res = { error: String((err as Error).message ?? err) };
        }
        return seal(st.key, res);
      },
      (conn) => {
        this.conns.delete(conn);
        if (took) {
          took = false;
          this.onChange();
        }
      },
      { key: 'sync', port: PORT },
    );
    await this.readvertise();
  }

  async stop(): Promise<void> {
    this.listener?.stop();
    this.listener = null;
    this.conns.clear();
    await this.lan()
      ?.unadvertise()
      .catch(() => {});
  }

  /** SyncHub.advertise: the household's tag for today (and an open code's), so its phones find this one. */
  private async readvertise(): Promise<void> {
    const lan = this.lan();
    const key = this.key();
    if (!lan || !this.listener || !key) return;
    const txt: Record<string, string> = { h: dayTag(key, 0, this.now()) };
    const old = this.isOwner() ? this.oldKey() : null;
    if (old) txt.o = dayTag(old, 0, this.now());
    const t = this.e.meta('pair_token');
    if (t && this.isOwner() && this.openPairingKey()) txt.p = pairingTag(unbase32(t));
    let name = this.e.meta('adv_name');
    if (!name) {
      name = 'restock-' + hex(random(4));
      this.e.setMeta('adv_name', name);
    }
    await lan.advertise(this.listener.port, name, txt).catch(() => {});
  }

  /** SyncHousehold.handle: a message, depending on which key opened it. */
  private async handle(req: Msg, host: string, which: number): Promise<Msg> {
    const e = this.e;
    const device = String(req.device ?? '');
    const op = String(req.op ?? '');
    if (which === PAIRING) {
      if (op === 'join2') return this.finishJoin(req, host);
      if (op !== 'join' && op !== 'peek') return { error: 'Use the code to join first.' };
      const pairing = this.openPairingKey();
      if (!pairing || !this.isOwner()) return { error: 'That code has run out. Make a new one on the other phone.' };
      if (this.members().length >= MAX_PHONES) return { error: FULL };
      if (!device || device === e.device() || e.householdValue('member:' + device) !== null) return { error: 'That phone is already in this household.' };
      if (op === 'peek') return { v: VERSION, household: e.householdValue('name'), ownerName: this.name(), tabs: tabsJson(e.householdTabs()) };
      const epk = str(req.epk);
      if (!epk) return { error: 'Update Restock on the phone that is joining, then try again.' };
      const eph = newEcdhKey();
      const k = joinKeyOf(eph.priv, epk, pairing);
      this.pending.set(device, { k, at: this.now(), name: str(req.name) ?? 'Phone', pub: str(req.pub) });
      const give: Msg = { key: e.meta('key'), keyv: this.keyv(), household: e.householdValue('name'), owner: e.device(), ownerName: this.name() };
      const pub = e.householdValue('owner_pub');
      if (pub) give.owner_pub = pub;
      return { epk: b64u(eph.pub), sealed: b64u(seal(k, give)) };
    }
    if (which >= MEMBER) {
      // A phone that missed key changes, using its own secret.
      const d = this.memberOrder[which - MEMBER] ?? device;
      if (op !== 'rekey') return { device: e.device(), error: 'Ask for the key first.' };
      if (e.householdValue('removed:' + d) !== null || e.householdValue('member:' + d) === null) return { device: e.device(), removed: true };
      return { device: e.device(), key: e.meta('key'), keyv: this.keyv() };
    }
    if (which === OLD) {
      if (e.householdValue('removed:' + device) !== null) return { device: e.device(), removed: true };
      const secret = this.secrets()[device];
      if (!secret || e.householdValue('member:' + device) === null) return { device: e.device(), error: 'Not in this household.' };
      return { device: e.device(), rekey: b64u(seal(unb64(secret), { key: e.meta('key'), keyv: String(this.keyv()), for: device })) };
    }
    if (which !== CURRENT) return { error: 'unknown' };
    if (this.isOwner() && e.householdValue('removed:' + device) !== null) return { device: e.device(), removed: true };
    return this.answer(req, host);
  }

  private finishJoin(req: Msg, host: string): Msg {
    const e = this.e;
    const device = String(req.device ?? '');
    const p = this.pending.get(device);
    this.pending.delete(device);
    if (!p || this.now() - p.at > 2 * 60_000 || !this.isOwner()) return { error: 'That join took too long. Make a new code and try again.' };
    if (e.householdValue('member:' + device) !== null) return { error: 'That phone is already in this household.' };
    if (this.members().length >= MAX_PHONES) return { error: FULL };
    const got = open(p.k, unb64(String(req.sealed ?? '')));
    const secret = str(got.secret);
    if (!secret) return { error: 'That join was damaged. Make a new code and try again.' };
    e.db.transaction(() => {
      for (const k of ['pair_token', 'pair_until', 'pair_code']) e.setMeta(k, null); // one use only
      const s = this.secrets();
      s[device] = secret;
      e.setMeta('owner_secrets', JSON.stringify(s));
      this.row('removed:' + device, null);
      this.row('member:' + device, JSON.stringify(p.pub ? { name: p.name, pub: p.pub } : { name: p.name }));
    });
    this.notePeer(device, p.name, host, 0);
    void this.readvertise();
    return { ok: true };
  }

  /** SyncEngine.handle: the sync itself, for a phone with the household's key. */
  private async answer(req: Msg, host: string): Promise<Msg> {
    const e = this.e;
    const op = String(req.op ?? '');
    const peer = String(req.device ?? '');
    const res: Msg = { device: e.device(), name: this.name(), v: VERSION };
    const to = typeof req.to === 'string' ? req.to : '';
    if (to && to !== e.device()) return { ...res, error: 'That message was for another phone.' };
    if ('nonce' in req) res.nonce = String(req.nonce ?? '');
    const modern = numOf(req.v) >= VERSION;
    switch (op) {
      case 'hello':
        e.noteTabs();
        this.notePeer(peer, str(req.name), host, numOf(req.port));
        res.household = e.meta('household') ?? e.householdValue('name');
        res.got = this.gotFrom(peer);
        res.tabs = tabsJson(e.tabs());
        return res;
      case 'household':
        res.entries = this.collect(0, null, null, " AND tbl = 'household'", false).entries;
        return res;
      case 'pull': {
        const allowed = e.tabs();
        const theirs = tabsOf(req.tabs);
        if (theirs) for (const t of [...allowed]) if (!theirs.has(t)) allowed.delete(t);
        e.setSeen(peer, numOf(req.since));
        return { ...res, ...this.collect(numOf(req.since), peer, allowed, '', modern) };
      }
      case 'push': {
        const n = e.apply(req.entries as Entry[] | undefined);
        if (n > 0) e.tidyCategories();
        this.setGot(peer, numOf(req.top));
        if (typeof req.at === 'string') e.markSynced(peer, req.at);
        e.setSeen(peer, numOf(req.seen));
        res.changed = n;
        return res;
      }
      case 'seen':
        e.setSeen(peer, numOf(req.seen));
        return res;
      case 'photo': {
        const photos = this.photos();
        const path = String(req.path ?? '');
        const allowed = e.tabs();
        const theirs = tabsOf(req.tabs);
        if (theirs) for (const t of [...allowed]) if (!theirs.has(t)) allowed.delete(t);
        if (!photos || !this.receiptWith(path, allowed)) return { ...res, error: "That photo isn't shared." };
        const data = await photos.read(path);
        if (!data) return { ...res, missing: true };
        if (data.length > MAX_PHOTO) return { ...res, tooBig: true };
        return { ...res, path, data: b64(data) };
      }
      default:
        return { ...res, error: 'unknown' };
    }
  }

  private receiptWith(path: string, allowed: Set<string>): boolean {
    const e = this.e;
    if (!PHOTO_PATH.test(path) || !e.shareReceipts()) return false;
    const id = path.slice('receipts/'.length, -'.jpg'.length).replace(/-[0-9]+$/, '');
    const rows = [...e.db.query('SELECT * FROM receipts WHERE id = ?', [id]), ...e.db.query('SELECT * FROM receipts WHERE photo = ? OR pages LIKE ?', [path, `%"${path}"%`])];
    for (const row of rows) {
      if (String(row.id ?? '').startsWith('demo-') || !photoPaths(row).includes(path)) continue;
      const tab = e.tabOf('receipts', row);
      if (tab !== null && !allowed.has(tab)) continue;
      return true;
    }
    return false;
  }

  // ---------- this device's own choices, and leaving ----------

  /** What this device shares, as the screens that also serve a server's house give it. */
  setShares0(o: { tabs?: string[]; receipts?: boolean; cards?: boolean }): void {
    if (o.tabs) this.setTabs(o.tabs);
    if (o.receipts !== undefined) this.setReceipts(o.receipts);
    if (o.cards !== undefined) this.setCards(o.cards);
  }
  setTabs(tabs: string[]): void {
    const t = new Set(tabs.filter((x) => ALL_TABS.includes(x)));
    t.add('pantry');
    if (this.isOwner()) this.row('tabs', joinTabs(t));
    this.e.setMeta('tabs', joinTabs(t));
    this.e.noteTabs();
  }
  setReceipts(on: boolean): void {
    if (this.isOwner()) this.row('receipts', on ? '1' : '0');
    this.e.setMeta('share_receipts', on ? '1' : '0');
    this.e.noteTabs();
  }
  setCards(on: boolean): void {
    this.e.setMeta('share_cards', on ? '1' : '0');
  }

  /**
   * This device leaves the household (SyncHub.leave), keeping everything that's on it. The phone
   * that started the household can only leave once the others have gone (false otherwise).
   */
  async leave(): Promise<boolean> {
    if (!this.joined()) return true;
    if (this.isOwner() && this.members().some((m) => !m.me)) return false;
    this.row('member:' + this.e.device(), null);
    await this.syncAll().catch(() => {}); // let the others see it go, if they're here
    await this.stop();
    this.forget();
    return true;
  }

  forget(): void {
    forgetHousehold(this.e, ['wifi_house', 'pair_token', 'pair_until', 'pair_code', 'oldkey', 'oldkey_until', 'owner_secrets', 'invite', 'asked_key_at', 'adv_name']);
  }
}

export const _text = (b: Uint8Array) => strFromU8(b);
