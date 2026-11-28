// 0.13.2: the iPhone and iPad app as a phone of a Restock server's house (docs/server-protocol.md
// "v3"), the part Android does in ServerSync.java and ServerFolder.java. It uses the same engine the
// web app and the server run (server-mode/engine.ts, role 'phone'), the same crypto (crypto.ts) and
// the same round (round.ts), so what it writes is a phone's file like any other.
//
// What it does: read an Add a phone code, ask the server how it is, join the house fresh (its own
// things go up "giving way", as an Android phone's do), sync (read the others' files, write its own,
// take a newer key after a rekey), change what it shares, and leave.
//
// What it leaves to Android for now, each said plainly where it's asked for: bringing a phone
// household onto a new server, a 0.9.3-style (v2) server, moving old prices and receipt photos to
// the server, signing a browser in by scanning its code, and "also take what this phone shared off
// the server" when leaving.
//
// No iPhone-only code here (the requests go through `Http`), so it's tested on a computer against
// the real server.
import { sha256 } from '@noble/hashes/sha2';
import { strToU8 } from 'fflate';
import { b64u, handoverKey, hex, joinKey, keysFileKey, newEcdhKey, newJavaKeyPair, openJoin, openKeysFile, openWithAny, pointOf, random, sealHandover, sealRsf1, serverKeyOf, signWithPkcs8, spkiOf, unb64 } from '../server-mode/crypto';
import { ALL_TABS, joinTabs, parseTabs, type AsyncSyncEngine } from '../server-mode/engine';
import { syncRound, type Remote, type RoundResult } from '../server-mode/round';
import { forgetHousehold, myKeys } from './household';

/** One request: what was sent back, as bytes. Throws only when the server couldn't be reached at all. */
/** 0.18.3: `connectMs`, a shorter wait to connect (the home address, with the away one to try next). */
/** 0.18.3: how long to wait to connect to an address that isn't the last one to try. */
const QUICK_CONNECT_MS = 2500;
export type Http = (o: { method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'PROPFIND' | 'MKCOL'; url: string; headers: Record<string, string>; body?: Uint8Array; connectMs?: number }) => Promise<{ status: number; headers: Record<string, string>; bytes: Uint8Array }>;

/** Something the person can act on, in words (SyncDav.Problem). */
export class HouseProblem extends Error {
  constructor(
    message: string,
    /** The server took this phone off its list: the household is forgotten, everything else stays. */
    readonly removed = false,
  ) {
    super(message);
    this.name = 'HouseProblem';
  }
}

const GONE = "This phone isn't on your Restock server's list any more (it was removed there). To use the server again, scan a new code from its Add a phone page.";
const CLOCK = "This phone's date or time looks wrong, so the server turned it down. Turn on Set Automatically in Settings → General → Date & Time.";
const SEALED = 'application/x-restock-sealed';
const DAMAGED = "That code is damaged. Make a new one on the server's Add a phone page.";

interface Invite {
  v: 2 | 3;
  home: string | null;
  away: string | null;
  invite: string;
  /** The server's kex key (SPKI, base64url). */
  kex: string | null;
}

const text = (b: Uint8Array) => new TextDecoder().decode(b);
function json(b: Uint8Array): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(text(b));
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** ServerFolder.cleanAddress: an address as the phone keeps it (no trailing "/"), or null. Throws for one that isn't an address. */
export function cleanAddress(s: string | null | undefined): string | null {
  if (!s || !s.trim()) return null;
  let t = s.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) t = `http://${t}`;
  let u: URL;
  try {
    u = new URL(t);
  } catch {
    throw new HouseProblem("That doesn't look like a web address.");
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new HouseProblem('Use an https:// address.');
  if (u.username || u.password) throw new HouseProblem('Leave any user name out of the address.');
  if (u.search) throw new HouseProblem('Leave out anything after a "?" in the address.');
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
}

/** ServerFolder.parseInvite: the Add a phone code a server's page shows. */
export function parseInvite(code: string): Invite {
  const t = (code ?? '').trim();
  if (/^restock-server:1\?/i.test(t)) throw new HouseProblem("That code is from an older Restock server. Update the server, then scan the code on its Add a phone page.");
  const m = /^restock-server:([23])\?(.*)$/is.exec(t);
  if (!m) throw new HouseProblem("That isn't a Restock server code. On a computer, sign in to your server's page and choose Add a phone.");
  const v = m[1] === '3' ? 3 : 2;
  const f: Record<string, string> = {};
  for (const part of m[2].split('&')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    let val: string;
    try {
      val = decodeURIComponent(part.slice(eq + 1).replace(/\+/g, ' ')).trim();
    } catch {
      continue;
    }
    if (val) f[part.slice(0, eq)] = val;
  }
  let kex: string | null = null;
  if (v === 3) {
    try {
      // The same key however it was written: a raw point or SPKI, base64 or base64url.
      kex = b64u(spkiOf(pointOf(unb64(f.k ?? ''))));
    } catch {
      throw new HouseProblem(DAMAGED);
    }
  }
  if (!f.i || !/^[A-Za-z0-9_-]{20,128}$/.test(f.i)) throw new HouseProblem(DAMAGED);
  const home = cleanAddress(f.h);
  const away = cleanAddress(f.a);
  if (!home && !away) throw new HouseProblem('That code has no address for the server. Make a new one on its Add a phone page.');
  return { v, home, away, invite: f.i, kex };
}

/** What a join gave this phone (crypto.ts JoinGift, as the server writes it). */
interface Gift {
  format?: string;
  v?: number;
  device?: string;
  label?: unknown;
  seed?: unknown;
  household?: { name?: unknown; hid?: unknown; sid?: unknown; owner_pub?: unknown };
  keyv?: number;
  keys?: Record<string, string>;
  serverKeys?: Record<string, string>;
  secret?: unknown;
  server?: { home?: unknown; away?: unknown; keepMonths?: unknown };
}

interface HouseInfo {
  joined: boolean;
  home: string | null;
  away: string | null;
  reached: string | null;
  at: string | null;
  error: string | null;
  unread: number;
  files: number;
  label: string | null;
  memberLabel: string | null;
  household: string | null;
}

const hostOf = (a: string) => a.replace(/^https?:\/\//i, '');
const errorOf = (b: Uint8Array) => String(json(b).error ?? '');
const saidOf = (b: Uint8Array) => {
  const m = String(json(b).message ?? '').trim();
  return m.length > 200 ? m.slice(0, 200) : m;
};

/** ServerFolder.failure: an answer that isn't a yes, in words. */
function failure(status: number, doing: string): HouseProblem {
  if (status === 404) return new HouseProblem(`The server said "not found" while ${doing}. If it keeps happening, update the server.`);
  if (status === 413) return new HouseProblem('The server says a file is too big, or it\'s full.');
  if (status === 429) return new HouseProblem('The server is busy; Restock will try again.');
  if (status === 507) return new HouseProblem('The server is full. Make room on it, or raise its size limit.');
  if (status >= 300 && status < 400) return new HouseProblem('The server sent Restock somewhere else. Check its address (maybe https://).');
  return new HouseProblem(`The server answered ${status} while ${doing}.`);
}

export class House {
  /** How far this device's clock is from each address's (ms), learnt when a request is turned down for it. */
  private readonly skew = new Map<string, number>();

  constructor(
    readonly e: AsyncSyncEngine,
    private readonly http: Http,
    private readonly now: () => number = () => Date.now(),
  ) {}

  // ---------- what's kept (the names ServerSync.java uses in sync_meta) ----------

  async joined(): Promise<boolean> {
    return (await this.e.meta('server_api')) === '3' && (await this.e.meta('server_dev_priv')) !== null && (await this.e.meta('key')) !== null;
  }

  private async bases(): Promise<string[]> {
    const out: string[] = [];
    // The address that answered last goes first.
    for (const a of [(await this.e.meta('server_reached')), (await this.e.meta('server_home')), (await this.e.meta('server_away'))]) if (a && !out.includes(a)) out.push(a);
    return out;
  }

  private async serverKeys(): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    try {
      for (const x of JSON.parse((await this.e.meta('server_filekeys')) ?? '[]') as { keyv?: unknown; key?: unknown }[])
        if (x && typeof x.key === 'string' && Number.isInteger(x.keyv)) out[String(x.keyv)] = x.key;
    } catch {
      // nothing kept yet
    }
    return out;
  }

  private async addServerKeys(hid: string, keys: Record<string, string> | undefined): Promise<void> {
    let all: { hid: string; keyv: number; key: string }[] = [];
    try {
      all = JSON.parse((await this.e.meta('server_filekeys')) ?? '[]') as typeof all;
    } catch {
      all = [];
    }
    const have = new Set(all.map((x) => x.key));
    for (const [v, key] of Object.entries(keys ?? {})) {
      if (typeof key !== 'string' || !key || have.has(key) || !/^\d+$/.test(v)) continue;
      all.push({ hid, keyv: Number(v), key });
      have.add(key);
    }
    (await this.e.setMeta('server_filekeys', JSON.stringify(all)));
  }

  async info(): Promise<HouseInfo> {
    const joined = (await this.joined());
    return {
      joined,
      home: (await this.e.meta('server_home')),
      away: (await this.e.meta('server_away')),
      reached: (await this.e.meta('server_reached')),
      at: (await this.e.meta('folder_at')),
      error: (await this.e.meta('server_error')),
      unread: Number((await this.e.meta('folder_unread')) ?? 0) || 0,
      files: Number((await this.e.meta('server_files')) ?? 0) || 0,
      label: (await this.e.meta('server_label')),
      memberLabel: (await this.e.meta('server_member_label')),
      household: joined ? ((await this.e.householdValue('name')) ?? (await this.e.meta('household'))) : null,
    };
  }

  // ---------- before joining ----------

  /** GET /api/v3/health at the first address that answers (ServerFolder.health), or null. */
  async health(where: string[]): Promise<Record<string, unknown> | null> {
    for (const a of where) {
      try {
        const r = await this.http({ method: 'GET', url: `${a}/api/v3/health`, headers: { Accept: 'application/json' }, ...(a !== where[where.length - 1] ? { connectMs: QUICK_CONNECT_MS } : {}) });
        if (r.status === 200) return json(r.bytes);
      } catch {
        // not reachable from here: the other address
      }
    }
    return null;
  }

  /** ServerSync.check: a scanned code, before joining. */
  async check(code: string): Promise<{ v: 2 | 3; home: string | null; away: string | null; mode?: string; house?: string; empty?: boolean; inHousehold: boolean }> {
    const inv = parseInvite(code);
    const out: { v: 2 | 3; home: string | null; away: string | null; mode?: string; house?: string; empty?: boolean; inHousehold: boolean } = { v: inv.v, home: inv.home, away: inv.away, inHousehold: (await this.joined()) };
    if (inv.v === 3) {
      const h = await this.health([inv.home, inv.away].filter((x): x is string => !!x));
      if (h) {
        out.mode = typeof h.mode === 'string' ? h.mode : '';
        if (typeof h.house === 'string') out.house = h.house;
        if (typeof h.empty === 'boolean') out.empty = h.empty;
      }
    }
    return out;
  }

  // ---------- joining ----------

  /**
   * ServerSync.join3 (fresh): joins a v3 server's house with its Add a phone code. This phone isn't
   * in a household; its things on what it shares go up, the house's copy winning where both have a
   * record. Throws with words; nothing changes on this phone then.
   */
  async join(code: string): Promise<void> {
    const inv = parseInvite(code);
    if (inv.v !== 3 || !inv.kex) throw new HouseProblem('That code is from an older Restock server (one that hasn\'t been made the house yet). On iPhone and iPad, Restock joins a server that is the house: update the server and choose "Make this server the house" on its page first.');
    if ((await this.joined())) throw new HouseProblem('Leave your household first: a phone belongs to one house at a time.');
    const dev = newJavaKeyPair();
    const kex = newEcdhKey();
    const mine = (await this.myKeys());
    const n = b64u(random(16));
    const me = (await this.e.device());
    const body = { invite: inv.invite, device: me, name: (await this.e.meta('name')) ?? 'iPhone', pub: dev.pub, kex: b64u(kex.pub), myPub: mine.pub, n };
    const where = [inv.home, inv.away].filter((x): x is string => !!x);
    const { answer, base } = await this.postJoin(where, body);
    let gift: Gift;
    try {
      gift = openJoin(joinKey(kex.priv, unb64(inv.kex), unb64(n)), me, unb64(String(answer.sealed ?? ''))) as unknown as Gift;
    } catch {
      throw new HouseProblem("That server's answer couldn't be opened with the key in its code. Only connect to your own server.");
    }
    if (gift.format !== 'restock-join' || gift.v !== 3 || gift.device !== me || !gift.household || !gift.keys || !(Number(gift.keyv) >= 1)) throw new HouseProblem("That server's answer isn't one this phone understands.");
    (await this.install(gift, inv, dev.priv, b64u(kex.priv), base));
    // An address the server gave as http:// that only answers over https:// is kept as https://.
    for (const k of ['server_home', 'server_away']) {
      const a = (await this.e.meta(k));
      if (a && a !== base && a.replace(/^http:\/\//i, 'https://') === base) (await this.e.setMeta(k, base));
    }
  }

  /**
   * 0.15.0, ServerSync.join3 (bring): this device owns a household (phones on the Wi-Fi, or an iCloud
   * folder) and the server's house is new and empty, so the household goes onto the server: the join
   * carries the handover payload, sealed to the server's key. The household carries on as the house,
   * with the same key, members and things. Throws with words; nothing changes on this device then.
   */
  async bring(code: string, kind: 'wifi_house' | 'folder_house'): Promise<void> {
    const inv = parseInvite(code);
    if (inv.v !== 3 || !inv.kex) throw new HouseProblem('That code is from an older Restock server. Update the server first.');
    const e = this.e;
    const me = (await e.device());
    if ((await e.householdValue('owner')) !== me || !(await e.meta('owner_priv'))) throw new HouseProblem("Only the household's owner phone can bring it onto a server.");
    const key = (await e.meta('key'));
    const keyv = Number((await e.meta('keyv')) ?? 1) || 1;
    if (!key) throw new HouseProblem('This device isn\'t in a household.');
    // SyncHousehold.handoverPayload.
    const secrets = (async () => {
      try {
        const o = JSON.parse((await e.meta('owner_secrets')) ?? '{}') as Record<string, unknown>;
        const out: Record<string, string> = {};
        for (const [d, v] of Object.entries(o)) if (typeof v === 'string' && (await e.householdValue('member:' + d)) !== null) out[d] = v;
        return out;
      } catch {
        return {};
      }
    })();
    const serverKeys: Record<string, string> = { [String(keyv)]: b64u(serverKeyOf(unb64(key))) };
    const payload: Record<string, unknown> = {
      format: 'restock-handover',
      v: 3,
      key,
      keyv,
      serverKeys,
      owner_priv: (await e.meta('owner_priv')),
      owner_pubkey: (await e.meta('owner_pubkey')) ?? (await e.householdValue('owner_pub')),
      owner_secrets: secrets,
      secret: (await e.meta('secret')),
      hid: (await e.householdValue('hid')),
      name: (await e.householdValue('name')) ?? (await e.meta('household')) ?? 'Our house',
    };
    if ((await e.meta('oldkey')) && (await e.meta('oldkey_until'))) {
      payload.oldkey = (await e.meta('oldkey'));
      payload.oldkey_until = (await e.meta('oldkey_until'));
    }
    if ((await e.meta('recovery'))) {
      payload.recovery = (await e.meta('recovery'));
      payload.recovery_saved = (await e.meta('recovery_saved')) === '1';
    }
    const eph = newEcdhKey();
    const bring = { epub: b64u(eph.pub), sealed: b64u(sealHandover(handoverKey(eph.priv, unb64(inv.kex), unb64(inv.invite)), payload)) };
    const dev = newJavaKeyPair();
    const kex = newEcdhKey();
    const mine = (await this.myKeys());
    const n = b64u(random(16));
    const body = { invite: inv.invite, device: me, name: (await e.meta('name')) ?? 'iPhone', pub: dev.pub, kex: b64u(kex.pub), myPub: mine.pub, n, bring };
    const { answer, base } = await this.postJoin([inv.home, inv.away].filter((x): x is string => !!x), body);
    let gift: Gift;
    try {
      gift = openJoin(joinKey(kex.priv, unb64(inv.kex), unb64(n)), me, unb64(String(answer.sealed ?? ''))) as unknown as Gift;
    } catch {
      throw new HouseProblem("That server's answer couldn't be opened with the key in its code. Only connect to your own server.");
    }
    const hh = gift.household ?? {};
    if (str(hh.hid) !== (await e.householdValue('hid'))) throw new HouseProblem("The server didn't take your household. Try again, or leave it and join the server's house.");
    const gotV = Number(gift.keyv);
    const cur = gift.keys?.[String(gotV)];
    // ServerSync.install ("keep"): the household carries on as the house; this device keeps sharing what it shares now.
    await e.hold(async () => {
      (await e.setMeta(kind, null));
      (await e.setMeta('tabs', joinTabs((await e.tabs()))));
      if ((await e.meta('share_receipts')) === null) (await e.setMeta('share_receipts', (await e.meta('receipts_eff')) === '1' ? '1' : '0'));
      if (typeof cur === 'string' && unb64(cur).length === 32 && gotV > keyv) {
        (await e.setMeta('key', cur));
        (await e.setMeta('keyv', String(gotV)));
      }
      (await e.setMeta('server_dev_priv', dev.priv));
      (await e.setMeta('server_kex_priv', b64u(kex.priv)));
      (await e.setMeta('server_kex', inv.kex));
      (await e.setMeta('server_api', '3'));
      (await e.setMeta('server_sid', str(hh.sid)));
      if ((await e.meta('server_label')) === null) (await e.setMeta('server_label', 'Home'));
      (await e.setMeta('server_member_label', str(gift.label)));
      (await e.setMeta('server_home', safeAddress(str(gift.server?.home)) ?? inv.home));
      (await e.setMeta('server_away', safeAddress(str(gift.server?.away)) ?? inv.away));
      (await e.setMeta('server_reached', base));
      (await this.addServerKeys(str(hh.hid) ?? '', gift.serverKeys));
      (await this.addServerKeys(str(hh.hid) ?? '', { [String(keyv)]: b64u(serverKeyOf(unb64(key))) }));
    });
  }

  private async myKeys(): Promise<{ priv: string; pub: string }> {
    return (await myKeys(this.e));
  }

  /** POST /api/v3/join at the first address that answers (ServerFolder.join3). */
  private async postJoin(where: string[], body: Record<string, unknown>): Promise<{ answer: Record<string, unknown>; base: string }> {
    let last: unknown;
    for (let a of where) {
      let r: Awaited<ReturnType<Http>>;
      try {
        const got = await this.ask(a, { method: 'POST', path: '/api/v3/join', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: strToU8(JSON.stringify(body)) });
        r = got.r;
        a = got.base;
      } catch (e) {
        last = e;
        continue;
      }
      if (r.status >= 200 && r.status < 300) return { answer: json(r.bytes), base: a };
      // Something at this address that isn't the server's join (another program, a page in front of it): the other address.
      if (r.status === 404 || r.status === 405 || r.status >= 502) {
        last = new Error(`${hostOf(a)} answered ${r.status}`);
        continue;
      }
      const err = errorOf(r.bytes);
      const said = saidOf(r.bytes);
      if (err === 'device-taken' || (r.status === 409 && err !== 'not-empty'))
        throw new HouseProblem(said || 'This phone is already on that server. Remove it on the Phones page first, then add it again.');
      if (err === 'not-empty') throw new HouseProblem(said || "That server's house already has things in it. Scan a fresh Add a phone code to join it.");
      if (err === 'invite') throw new HouseProblem("That code isn't from this server. Ask an admin for a new one (Server admin → Add a phone or tablet, or the server's page).");
      // 0.18.3: used and expired say which (a server from before 0.18.3 only says 410).
      if (err === 'used') throw new HouseProblem(said || 'That code was already used: each one adds one phone. Ask an admin for a new one (Server admin → Add a phone or tablet).');
      if (err === 'expired') throw new HouseProblem(said || 'That code has run out (they last 10 minutes). Ask an admin for a new one (Server admin → Add a phone or tablet).');
      if (r.status === 403 && said) throw new HouseProblem(said);
      if (r.status === 403 || r.status === 410)
        throw new HouseProblem('That code has been used or has run out. Ask an admin for a new one (each code works once, for 10 minutes).');
      if (r.status === 507) throw new HouseProblem('The server already has as many phones as it takes.');
      if (r.status === 429) throw new HouseProblem('The server is busy. Try again in a minute.');
      throw new HouseProblem(said || `The server turned the code down (${r.status}).`);
    }
    throw new HouseProblem(`Couldn't reach your Restock server${last instanceof Error && last.message ? ` (${last.message})` : ''}. Check this phone is on the same Wi-Fi as the server, or that its away address works, then scan a new code.`);
  }

  /** ServerSync.install ("fresh"): keeps what the join gave this phone. */
  private async install(gift: Gift, inv: Invite, devPriv: string, kexPriv: string, base: string): Promise<void> {
    const keyv = Number(gift.keyv);
    const cur = gift.keys?.[String(keyv)];
    if (typeof cur !== 'string' || unb64(cur).length !== 32) throw new HouseProblem("That server's answer has no key for this household.");
    const hh = gift.household ?? {};
    const e = this.e;
    const seed = gift.seed === true;
    await e.hold(async () => {
      (await this.forget());
      (await e.setMeta('key', cur));
      (await e.setMeta('keyv', String(keyv)));
      (await e.setMeta('secret', str(gift.secret) ?? b64u(new Uint8Array(32))));
      (await e.setMeta('owner_pin', str(hh.owner_pub)));
      (await e.setMeta('household', str(hh.name)));
      // What this phone shares with the house: groceries only, no receipts, no cards (it can change it after).
      (await e.setMeta('tabs', 'pantry'));
      (await e.setMeta('tabs_eff', null));
      (await e.setMeta('share_receipts', '0'));
      (await e.setMeta('share_cards', '0'));
      (await e.setMeta('wifi_sync', '0'));
      (await e.setMeta('seed_settings', seed ? '1' : null));
      // Its own records give way to the house's (stamped below any other phone's), and a record only
      // this phone has still goes up. Prices keep their stamps (they're only ever added). The first
      // phone of a new house has nothing to give way to.
      if (!seed) await e.db.exec("UPDATE sync_log SET stamp = -1, created = 0 WHERE tbl NOT IN ('household', 'prices')");
      (await e.setMeta('server_dev_priv', devPriv));
      (await e.setMeta('server_kex_priv', kexPriv));
      (await e.setMeta('server_kex', inv.kex));
      (await e.setMeta('server_api', '3'));
      (await e.setMeta('server_sid', str(hh.sid)));
      (await e.setMeta('server_label', 'Home'));
      (await e.setMeta('server_member_label', str(gift.label)));
      const home = str(gift.server?.home);
      const away = str(gift.server?.away);
      (await e.setMeta('server_home', safeAddress(home) ?? inv.home));
      (await e.setMeta('server_away', safeAddress(away) ?? inv.away));
      (await e.setMeta('server_reached', base));
      (await this.addServerKeys(str(hh.hid) ?? '', gift.serverKeys));
      // Always able to read what's sealed with the current key, whatever the answer listed.
      (await this.addServerKeys(str(hh.hid) ?? '', { [String(keyv)]: b64u(serverKeyOf(unb64(cur))) }));
    });
  }

  /** SyncHousehold.forget: the household and everything about its sync is forgotten; the phone's own things stay (ios/household.ts). */
  async forget(): Promise<void> {
    (await forgetHousehold(this.e, ['server_dev_priv', 'server_home', 'server_away', 'server_reached', 'server_files', 'server_error', 'server_api', 'server_kex', 'server_kex_priv', 'server_label', 'server_sid', 'server_keysfile', 'server_member_label']));
  }

  // ---------- signed requests (docs/server-protocol.md, Signed requests) ----------

  /** The Authorization header for a request (ServerFolder.authorization). */
  async authorization(method: string, pathAndQuery: string, t: number, body?: Uint8Array, n: string = b64u(random(16))): Promise<string> {
    const msg = `${method}\n${pathAndQuery}\n${t}\n${n}\n${hex(sha256(body ?? new Uint8Array(0)))}`;
    // The server takes plain base64 or base64url for the signature; Android sends plain base64.
    const sig = btoa(String.fromCharCode(...unb64(signWithPkcs8((await this.e.meta('server_dev_priv')) ?? '', msg))));
    return `Restock2 d=${(await this.e.device())}, t=${t}, n=${n}, s=${sig}`;
  }

  private async sendOnce(base: string, method: 'GET' | 'PUT' | 'DELETE' | 'POST' | 'PATCH', path: string, body?: Uint8Array, sealedN?: string): Promise<Awaited<ReturnType<Http>>> {
    const u = new URL(base + path);
    const headers: Record<string, string> = {
      Authorization: (await this.authorization(method, u.pathname + u.search, this.now() + (this.skew.get(base) ?? 0), body, sealedN)),
      // 0.15.0: this device's Restock version, so a server can tell one that's too old to update.
      'X-Restock-App': typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '',
    };
    // A sealed call (Your data): the body and the answer go sealed with the household's server key.
    if (sealedN) headers['X-Restock-Seal'] = 'rsf1';
    if (body) headers['Content-Type'] = sealedN ? SEALED : path.startsWith('/api/v3/files/') ? 'application/octet-stream' : 'application/json';
    const got = await this.ask(base, { method, path, headers, body });
    const r = got.r;
    if (got.base !== base) (await this.moved(base, got.base));
    if (r.status === 401 || r.status === 403) {
      const err = errorOf(r.bytes);
      if (err === 'clock') return r;
      if (err === 'removed' || err === 'device') throw new HouseProblem(GONE, true);
      const said = saidOf(r.bytes);
      throw new HouseProblem(`The Restock server didn't accept this phone${said ? `: ${said}` : '.'} If it keeps happening, scan a new code from its Add a phone page.`);
    }
    return r;
  }

  /**
   * One request at one address. Redirects are never followed blindly (a followed redirect turns a
   * POST into a GET): an http:// address that only sends on to the same place over https:// is asked
   * again there, and that is the address kept; any other redirect counts as not reaching the server.
   */
  private async ask(base: string, o: { method: 'GET' | 'PUT' | 'DELETE' | 'POST' | 'PATCH'; path: string; headers: Record<string, string>; body?: Uint8Array }): Promise<{ r: Awaited<ReturnType<Http>>; base: string }> {
    const r = await this.http({ method: o.method, url: base + o.path, headers: o.headers, body: o.body, ...(this.quick.has(base) ? { connectMs: QUICK_CONNECT_MS } : {}) });
    if (r.status < 300 || r.status >= 400 || r.status === 304) return { r, base };
    const secure = base.replace(/^http:\/\//i, 'https://');
    let to = '';
    try {
      to = new URL(r.headers.location ?? '', base + o.path).href;
    } catch {
      // no usable Location
    }
    if (secure !== base && (!to || to.toLowerCase().startsWith(secure.toLowerCase()))) {
      const again = await this.http({ method: o.method, url: secure + o.path, headers: o.headers, body: o.body });
      if (again.status < 300 || again.status >= 400) return { r: again, base: secure };
    }
    throw new Error(`${hostOf(base)} sent Restock somewhere else`);
  }

  /** An address that turned out to be https: kept that way from now on. */
  private async moved(from: string, to: string): Promise<void> {
    this.movedTo.set(from, to);
    for (const k of ['server_home', 'server_away', 'server_reached']) if ((await this.e.meta(k)) === from) (await this.e.setMeta(k, to));
  }
  private movedTo = new Map<string, string>();
  /** 0.18.3: the addresses being tried with another one after them (a short wait to connect). */
  private quick = new Set<string>();

  /** A signed request at the first address that answers; a wrong clock is put right once with the server's time. */
  private async send(method: 'GET' | 'PUT' | 'DELETE' | 'POST' | 'PATCH', path: string, body?: Uint8Array, sealedN?: string): Promise<Awaited<ReturnType<Http>>> {
    let last: unknown;
    const all = await this.bases();
    for (const base of all) {
      let r: Awaited<ReturnType<Http>>;
      // 0.18.3: not the last address to try: give up on it after a moment (away from home, a home
      // address that doesn't answer took 15 seconds before the away one was tried).
      if (all.length > 1 && base !== all[all.length - 1]) this.quick.add(base);
      else this.quick.delete(base);
      try {
        r = await this.sendOnce(base, method, path, body, sealedN);
        if (r.status === 401 && errorOf(r.bytes) === 'clock') {
          const server = Number(r.headers['x-restock-time'] ?? '');
          if (!(server > 0)) throw new HouseProblem(CLOCK);
          this.skew.set(base, server - this.now());
          r = await this.sendOnce(base, method, path, body, sealedN);
          if (r.status === 401 && errorOf(r.bytes) === 'clock') throw new HouseProblem(CLOCK);
        }
      } catch (e) {
        if (e instanceof HouseProblem) throw e;
        last = e;
        continue; // not reachable from here: the other address
      }
      const at = this.movedTo.get(base) ?? base;
      if ((await this.e.meta('server_reached')) !== at) (await this.e.setMeta('server_reached', at));
      return r;
    }
    throw new HouseProblem(`Couldn't reach your Restock server${last instanceof Error && last.message ? ` (${last.message})` : ''}.`);
  }

  /**
   * ServerFolder.sealedCall: a signed request whose body and answer are sealed with the household's
   * server key (the server's Your data: its figures, and this phone's spending and searches going up).
   * The answer has to name this request's own nonce, so an old answer can't be played back.
   */
  async sealed(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<Record<string, unknown>> {
    if (!(await this.joined())) throw new HouseProblem("This phone isn't in a household on a Restock server.");
    const keys = (await this.serverKeys());
    const keyv = Number((await this.e.meta('keyv')) ?? 0) || 0;
    const mine = keys[String(keyv)];
    if (!mine) throw new HouseProblem("This phone isn't in a household on a Restock server.");
    const n = b64u(random(16));
    const r = await this.send(method, `/api/v3${path}`, body === undefined ? undefined : sealRsf1(unb64(mine), body), n);
    if (r.status !== 200) throw new HouseProblem(saidOf(r.bytes) || `The server answered ${r.status}.`);
    if (!(r.headers['content-type'] ?? '').startsWith(SEALED)) return json(r.bytes);
    let out: Record<string, unknown>;
    try {
      out = openWithAny<Record<string, unknown>>(keys, r.bytes).msg;
    } catch {
      throw new HouseProblem("The server's answer couldn't be opened with this household's keys.");
    }
    if (out.reqN !== n) throw new HouseProblem("The server's answer wasn't for this request.");
    delete out.reqN;
    return out;
  }

  /** 0.18.4: this phone's backup up to the server (backups/<device>.bin, sealed to the backup key already). */
  async putBackup(bytes: Uint8Array): Promise<void> {
    if (!(await this.joined())) throw new HouseProblem("This phone isn't in a household on a Restock server.");
    await this.remote().write(`backups/${(await this.e.device())}.bin`, bytes);
  }
  /** 0.18.4: a phone's backup (this one's, or the lost one this phone replaces), or null. */
  async getBackup(device: string): Promise<Uint8Array | null> {
    if (!(await this.joined())) throw new HouseProblem("This phone isn't in a household on a Restock server.");
    return this.remote().read(`backups/${device}.bin`);
  }

  private remote(): Remote {
    return {
      files: async () => {
        const r = await this.send('GET', '/api/v3/files');
        if (r.status !== 200) throw failure(r.status, 'listing its files');
        const files = json(r.bytes).files;
        const list = Array.isArray(files) ? (files as { name?: unknown; size?: unknown; version?: unknown; modified?: unknown }[]) : [];
        (await this.e.setMeta('server_files', String(list.length)));
        return list
          .filter((f) => f && typeof f.name === 'string')
          .map((f) => ({ name: String(f.name), size: Number(f.size) || 0, version: typeof f.version === 'string' ? f.version : undefined, modified: typeof f.modified === 'string' ? f.modified : undefined }));
      },
      read: async (name) => {
        const r = await this.send('GET', `/api/v3/files/${name}`);
        if (r.status === 404) return null;
        if (r.status !== 200) throw failure(r.status, 'reading a file');
        return r.bytes;
      },
      write: async (name, bytes) => {
        const r = await this.send('PUT', `/api/v3/files/${name}`, bytes);
        if (r.status < 200 || r.status >= 300) throw failure(r.status, 'saving this phone\'s changes');
        return json(r.bytes);
      },
    };
  }

  // ---------- syncing ----------

  /** What this phone shares with the house (SyncFolder.shares): its tabs, receipts and loyalty cards. */
  async shares(): Promise<{ tabs: string[]; receipts: boolean; cards: boolean }> {
    const mine = parseTabs((await this.e.meta('tabs')));
    return { tabs: ALL_TABS.filter((t) => mine.has(t)), receipts: (await this.e.meta('share_receipts')) === '1', cards: (await this.e.meta('share_cards')) === '1' };
  }

  /** A newer household key from keys/<device>.bin (ServerSync.takeKeysFile), if there is one. True when one was taken. */
  private async takeKeysFile(remote: Remote, names: string[]): Promise<boolean> {
    const name = `keys/${(await this.e.device())}.bin`;
    if (!names.includes(name)) return false;
    const bytes = await remote.read(name);
    const kexPriv = (await this.e.meta('server_kex_priv'));
    const kex = (await this.e.meta('server_kex'));
    if (!bytes || !kexPriv || !kex) return false;
    let got: { keyv: number; keys: Record<string, string> };
    try {
      got = openKeysFile(keysFileKey(unb64(kexPriv), unb64(kex)), (await this.e.device()), bytes);
    } catch {
      return false; // not for this phone's key
    }
    const have = Number((await this.e.meta('keyv')) ?? 0) || 0;
    const key = got.keys?.[String(got.keyv)];
    if (!(got.keyv > have) || typeof key !== 'string' || unb64(key).length !== 32) return false;
    // A phone only ever takes a newer key than it has (an old keys file put back can't set it back).
    const more: Record<string, string> = {};
    for (const [v, k] of Object.entries(got.keys)) if (typeof k === 'string' && /^\d+$/.test(v)) more[v] = b64u(serverKeyOf(unb64(k)));
    await this.e.hold(async () => {
      (await this.e.setMeta('key', key));
      (await this.e.setMeta('keyv', String(got.keyv)));
      (await this.addServerKeys('', more));
    });
    return true;
  }

  /** One round: a newer key, the others' files, then this phone's own. Notes when and how it went. */
  /**
   * 0.18.3: home first. At the start of each round, when the away address answered last, the home one
   * is asked (a moment at most): back at home, the round goes there, not out through the internet and
   * back. The rest of the round keeps to the one that answered (bases(): the one reached last first).
   */
  private async preferHome(): Promise<void> {
    const home = await this.e.meta('server_home');
    const last = await this.e.meta('server_reached');
    if (!home || !last || last === home) return;
    try {
      const r = await this.http({ method: 'GET', url: `${home}/api/v3/health`, headers: { Accept: 'application/json' }, connectMs: QUICK_CONNECT_MS });
      if (r.status === 200) await this.e.setMeta('server_reached', home);
    } catch {
      // not at home: away it is
    }
  }

  async sync(): Promise<RoundResult & { rekeyed: boolean }> {
    if (!(await this.joined())) throw new HouseProblem('This phone isn\'t on a Restock server.');
    await this.preferHome();
    try {
      const remote = this.remote();
      const first = await remote.files();
      const rekeyed = await this.takeKeysFile(remote, first.map((f) => f.name));
      const me = (await this.e.device());
      // The first phone of a new house gives the household its settings (SharedSettings.seed).
      (await this.e.seedSettings());
      const keys = { webId: me, webPriv: '', webPub: '', keys: (await this.serverKeys()) };
      const res = await syncRound(this.e, { ...remote, files: once(first, remote.files) }, keys, () => new Date(this.now()).toISOString(), {
        v3: true,
        ownName: `restock-sync-${me}.bin`,
        extra: async () => ({ shares: (await this.shares()) }),
      });
      (await this.e.setMeta('server_error', null));
      return { ...res, rekeyed };
    } catch (err) {
      if (err instanceof HouseProblem && err.removed) {
        // 401 removed: the phone forgets the household and keeps everything.
        (await this.forget());
        (await this.e.setMeta('notice', 'server-removed'));
      } else (await this.e.setMeta('server_error', err instanceof Error ? err.message : String(err)));
      throw err;
    }
  }

  /** Has anything changed on the server since the last round? (A cheap look: the list only.) */
  async anythingNew(): Promise<boolean> {
    if (!(await this.joined())) return false;
    const list = await this.remote().files();
    const me = `restock-sync-${(await this.e.device())}.bin`;
    const device = await this.e.device();
    for (const f of list) if (f.name !== me && (/^restock-sync-.*\.bin$/.test(f.name) || f.name === `keys/${device}.bin`) && (await this.e.fresh(f.name, f.version ?? `${f.size}/${f.modified ?? ''}`))) return true;
    return false;
  }

  /** What this phone shares: tabs (groceries can't be turned off), receipts, cards, and what it calls the server. */
  async setShares(o: { tabs?: string[]; receipts?: boolean; cards?: boolean; label?: string }): Promise<void> {
    if (o.tabs) {
      const t = new Set(o.tabs.filter((x) => ALL_TABS.includes(x)));
      t.add('pantry');
      (await this.e.setMeta('tabs', joinTabs(t)));
    }
    if (o.receipts !== undefined) (await this.e.setMeta('share_receipts', o.receipts ? '1' : '0'));
    if (o.cards !== undefined) (await this.e.setMeta('share_cards', o.cards ? '1' : '0'));
    if (o.label !== undefined) (await this.e.setMeta('server_label', o.label.trim().slice(0, 40) || 'Home'));
  }

  // ---------- signing a browser in (ServerSync.webCode, approveWeb) ----------

  /** A scanned code from the server's sign-in page: which page it is. Throws with words when it isn't this house's. */
  async webCode(code: string): Promise<{ kind: 'login'; host: string; id: string; k: string }> {
    if (!(await this.joined())) throw new HouseProblem('Connect this phone to your Restock server first.');
    const t = (code ?? '').trim();
    if (/^restock-handover:/i.test(t)) throw new HouseProblem("That's the server's Take this household code, not a sign-in code.");
    if (/^restock-(login|link):2\?/i.test(t)) throw new HouseProblem('That code is from an older Restock web page. Reload the page and scan the new code.');
    const m = /^restock-login:3\?(.*)$/is.exec(t);
    if (!m) throw new HouseProblem("That isn't a code from your Restock server's web page.");
    const f: Record<string, string> = {};
    for (const part of m[1].split('&')) {
      const eq = part.indexOf('=');
      if (eq <= 0) continue;
      try {
        f[part.slice(0, eq)] = decodeURIComponent(part.slice(eq + 1).replace(/\+/g, ' '));
      } catch {
        // a damaged part
      }
    }
    const DAMAGED_PAGE = 'That code is damaged. Refresh the web page and scan it again.';
    let host: string;
    let k: string;
    try {
      const u = new URL(f.u ?? '');
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('scheme');
      host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
      k = b64u(spkiOf(pointOf(unb64(f.k ?? ''))));
    } catch {
      throw new HouseProblem(DAMAGED_PAGE);
    }
    if (!f.s || !/^[A-Za-z0-9_-]{8,128}$/.test(f.s)) throw new HouseProblem(DAMAGED_PAGE);
    const mine = new Set<string>();
    for (const a of (await this.bases())) {
      try {
        mine.add(new URL(a).hostname.toLowerCase().replace(/^\[|\]$/g, ''));
      } catch {
        // not an address
      }
    }
    if (!mine.has(host)) throw new HouseProblem(`That code is from a page at ${host}, not your Restock server (${[...mine].join(' or ')}). Only scan codes from your own server's page.`);
    return { kind: 'login', host, id: f.s, k };
  }

  /** Says yes to the browser showing that code (signed by this phone); the server then gives that browser its keys. */
  async approveWeb(code: string): Promise<{ kind: 'login'; host: string }> {
    const w = (await this.webCode(code));
    const r = await this.send('POST', `/api/v3/qrlogin/${w.id}`, strToU8(JSON.stringify({ approve: true, k: w.k })));
    if (r.status === 404 || r.status === 410) throw new HouseProblem('That code has run out. Refresh the web page and scan the new code.');
    if (r.status === 409) throw new HouseProblem('That code has already been used, or is for another browser. Refresh the web page and scan the new code.');
    if (r.status < 200 || r.status >= 300) throw new HouseProblem(saidOf(r.bytes) || `The server answered ${r.status}.`);
    return { kind: w.kind, host: w.host };
  }

  /** Leave: DELETE /api/v3/devices/<me> (best effort), then the household is forgotten; everything on the phone stays. */
  async leave(): Promise<void> {
    if (!(await this.joined())) return;
    try {
      await this.send('DELETE', `/api/v3/devices/${(await this.e.device())}`);
    } catch {
      // The server can't be reached, or has already forgotten this phone: leaving carries on.
    }
    (await this.forget());
  }
}

/** The list already fetched answers the round's first ask; later asks go to the server. */
function once<T>(first: T, again: () => Promise<T>): () => Promise<T> {
  let used = false;
  return async () => {
    if (!used) {
      used = true;
      return first;
    }
    return again();
  };
}

/** An address the server named for itself, if it's a clean one. */
function safeAddress(a: string | null): string | null {
  try {
    return cleanAddress(a);
  } catch {
    return null;
  }
}
