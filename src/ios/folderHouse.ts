// 0.13.2: iCloud sync. A household of iPhones and iPads that shares one folder in iCloud Drive: no
// server, no account with Restock, and nothing has to be open at the same time.
//
// It's Android's folder sync (SyncFolder.java) on the engine the web app and the server run
// (server-mode/engine.ts, role 'phone'): each device writes one file of its own,
// restock-sync-DEVICE.bin, with everything it knows, sealed with the household's key (AES-256-GCM,
// gzipped first), and reads the others'. The later change wins and deletes are remembered. Only the
// household's devices can read the files; iCloud, and anyone else the folder is shared with, sees a
// jumble.
//
// What's new here is joining through the folder itself, because an iPhone can't listen on the Wi-Fi
// for another phone the way an Android phone does:
// - The household's first device (its owner) makes the household: its key, and an owner key that
//   signs who is in it and its name (the same signed rows as Android's households).
// - To add a device, the owner shows a code (restock-icloud:1?h=HID&k=K). K is 32 random bytes that
//   last 30 minutes and work once.
// - The new device, with the same folder picked, scans it and writes restock-join-DEVICE.bin: its id,
//   name and signing key, sealed with a key made from K.
// - The owner, next time it looks (it looks every few seconds while its code is on screen), opens
//   that with K, signs the device into the household, and writes restock-welcome-DEVICE.bin: the
//   household's key and owner key, sealed with another key made from K.
// - The new device opens the welcome, keeps the keys, and syncs. Both little files are deleted.
// Someone with the folder but not K can read neither file, and can't be signed in by one.
//
// Removing a device: the owner signs it out (its file is passed over from then on). It keeps the key
// it had, so the owner is also told to stop sharing the iCloud folder with that person, which is
// what actually shuts them out.
//
// No iPhone-only code here (the folder is an interface), so it's tested on a computer.
import { strFromU8, strToU8 } from 'fflate';
import { b64u, hkdf32, newJavaKeyPair, openJson, random, sealJson, unb64 } from '../server-mode/crypto';
import { ALL_TABS, joinTabs, parseTabs, type AsyncSyncEngine } from '../server-mode/engine';
import { syncRound, type Remote, type RoundResult } from '../server-mode/round';
import { forgetHousehold, myKeys } from './household';

/** The folder the household shares, as this needs it. */
export interface FolderIo {
  list(): Promise<{ name: string; size: number; mtime: number; waiting?: boolean }[]>;
  /** null when it isn't there (or iCloud hasn't brought it down yet). */
  read(name: string): Promise<Uint8Array | null>;
  write(name: string, bytes: Uint8Array): Promise<void>;
  remove(name: string): Promise<void>;
}

export class FolderProblem extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FolderProblem';
  }
}

export const INVITE_MS = 30 * 60_000;
const JOIN_INFO = 'restock-folder-join-v1';
const WELCOME_INFO = 'restock-folder-welcome-v1';
const JOIN_AAD = 'RFJ1';
const WELCOME_AAD = 'RFW1';
const DEVICE = /^[A-Za-z0-9_-]{1,80}$/;
const joinName = (device: string) => `restock-join-${device}.bin`;
const welcomeName = (device: string) => `restock-welcome-${device}.bin`;
const syncName = (device: string) => `restock-sync-${device}.bin`;
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

export interface FolderInvite {
  hid: string;
  k: string;
  name: string | null;
}

/** The code an owner shows to add a device. */
export function inviteCode(i: FolderInvite): string {
  return `restock-icloud:1?h=${encodeURIComponent(i.hid)}&k=${i.k}${i.name ? `&n=${encodeURIComponent(i.name)}` : ''}`;
}

export const isFolderCode = (code: string): boolean => /^restock-icloud:1\?/i.test((code ?? '').trim());

export function parseFolderCode(code: string): FolderInvite {
  const m = /^restock-icloud:1\?(.*)$/is.exec((code ?? '').trim());
  if (!m) throw new FolderProblem("That isn't an iCloud sync code. On the household's first iPhone or iPad, open Sync and backups, then iCloud sync, and choose Add an iPhone or iPad.");
  const f: Record<string, string> = {};
  for (const part of m[1].split('&')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    try {
      f[part.slice(0, eq)] = decodeURIComponent(part.slice(eq + 1).replace(/\+/g, ' ')).trim();
    } catch {
      // a damaged part: left out, and checked below
    }
  }
  let k: Uint8Array;
  try {
    k = unb64(f.k ?? '');
  } catch {
    k = new Uint8Array(0);
  }
  if (!f.h || !/^[A-Za-z0-9_-]{6,64}$/.test(f.h) || k.length !== 32) throw new FolderProblem('That code is damaged. Show a new one on the other device and scan it again.');
  return { hid: f.h, k: b64u(k), name: f.n ? f.n.slice(0, 80) : null };
}

export interface FolderInfo {
  joined: boolean;
  /** Scanned a code and waiting for the owner's device to answer. */
  joining: boolean;
  owner: boolean;
  household: string | null;
  at: string | null;
  error: string | null;
  unread: number;
  /** The owner's code, while one is open. */
  invite: { code: string; until: number } | null;
}

export class FolderHouse {
  constructor(
    readonly e: AsyncSyncEngine,
    /** The folder picked on this device, or undefined when none is (or it can't be opened). */
    private readonly folder: () => Promise<FolderIo | undefined>,
    private readonly now: () => number = () => Date.now(),
  ) {}

  // ---------- what's kept (SyncHousehold's names in sync_meta, and folder_house for this kind) ----------

  async joined(): Promise<boolean> {
    return (await this.e.meta('folder_house')) === '1' && (await this.e.meta('key')) !== null && (await this.e.meta('secret')) !== null;
  }

  async isOwner(): Promise<boolean> {
    return (await this.joined()) && (await this.e.meta('owner_priv')) !== null && (await this.e.householdValue('owner')) === (await this.e.device());
  }

  private async joining(): Promise<{ k: string; hid: string; until: number } | null> {
    try {
      const j = JSON.parse((await this.e.meta('folder_joining')) ?? 'null') as { k?: unknown; hid?: unknown; until?: unknown } | null;
      return j && typeof j.k === 'string' && typeof j.hid === 'string' && typeof j.until === 'number' ? { k: j.k, hid: j.hid, until: j.until } : null;
    } catch {
      return null;
    }
  }

  private async openInvite(): Promise<{ k: string; until: number } | null> {
    try {
      const j = JSON.parse((await this.e.meta('folder_invite')) ?? 'null') as { k?: unknown; until?: unknown } | null;
      if (!j || typeof j.k !== 'string' || typeof j.until !== 'number') return null;
      if (j.until < this.now()) {
        (await this.e.setMeta('folder_invite', null));
        return null;
      }
      return { k: j.k, until: j.until };
    } catch {
      return null;
    }
  }

  async info(): Promise<FolderInfo> {
    const joined = (await this.joined());
    const inv = joined && (await this.isOwner()) ? (await this.openInvite()) : null;
    const hid = (await this.e.householdValue('hid'));
    return {
      joined,
      joining: !joined && (await this.joining()) !== null,
      owner: (await this.isOwner()),
      household: joined ? ((await this.e.householdValue('name')) ?? (await this.e.meta('household'))) : null,
      at: (await this.e.meta('folder_at')),
      error: (await this.e.meta('folder_error')),
      unread: Number((await this.e.meta('folder_unread')) ?? 0) || 0,
      invite: inv && hid ? { code: inviteCode({ hid, k: inv.k, name: (await this.e.householdValue('name')) }), until: inv.until } : null,
    };
  }

  private async io(): Promise<FolderIo> {
    const f = await this.folder();
    if (!f) throw new FolderProblem('Pick the iCloud Drive folder your household shares first.');
    return f;
  }

  private async keys(): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    const key = (await this.e.meta('key'));
    const keyv = (await this.e.meta('keyv')) ?? '1';
    if (key) out[keyv] = key;
    return out;
  }

  // ---------- the owner: starting a household, adding and removing devices ----------

  /** Writes an owner-only household row, signed with the owner key this device holds. */
  private async ownerRow(k: string, v: string | null): Promise<void> {
    if (!(await this.e.writeHousehold(k, v)) && (await this.e.householdValue(k)) !== v) throw new FolderProblem("Couldn't change the household on this device.");
  }

  /**
   * The household's first device: makes the household (its key, and the owner key that signs who's
   * in it). What's on this device is the household's from now on. `tabs`: what the household shares.
   */
  async start(name: string, tabs: string[] = ALL_TABS): Promise<void> {
    if ((await this.joined())) throw new FolderProblem('This device is already in a household.');
    const e = this.e;
    const owner = newJavaKeyPair();
    const mine = (await this.myKeys());
    const me = (await e.device());
    await e.hold(async () => {
      (await this.forget());
      (await e.setMeta('key', b64u(random(32))));
      (await e.setMeta('keyv', '1'));
      (await e.setMeta('secret', b64u(random(32))));
      (await e.setMeta('owner_priv', owner.priv));
      (await e.setMeta('owner_pubkey', owner.pub));
      (await e.setMeta('owner_pin', owner.pub));
      (await e.setMeta('folder_house', '1'));
      (await e.setMeta('share_receipts', '0'));
      (await e.setMeta('share_cards', '0'));
      (await e.setMeta('seed_settings', '1'));
      const t = new Set(tabs.filter((x) => ALL_TABS.includes(x)));
      t.add('pantry');
      (await this.ownerRow('owner_pub', owner.pub));
      (await this.ownerRow('owner', me));
      (await this.ownerRow('hid', b64u(random(9))));
      (await this.ownerRow('name', name.trim().slice(0, 80) || 'Our house'));
      (await this.ownerRow('tabs', joinTabs(t)));
      (await this.ownerRow('receipts', '0'));
      (await this.ownerRow('member:' + me, JSON.stringify({ name: (await e.meta('name')) ?? 'iPhone', pub: mine.pub })));
      (await e.setMeta('tabs', joinTabs(t)));
      (await e.setMeta('household', name.trim().slice(0, 80) || 'Our house'));
    });
  }

  private async myKeys(): Promise<{ priv: string; pub: string }> {
    return (await myKeys(this.e));
  }

  /** Owner: a new code for adding a device (the one before it stops working). */
  async invite(): Promise<{ code: string; until: number }> {
    if (!(await this.isOwner())) throw new FolderProblem("Only the household's first device can add another. Open Restock on that one.");
    const hid = (await this.e.householdValue('hid'));
    if (!hid) throw new FolderProblem("This household isn't finished being made. Sync once, then try again.");
    const k = b64u(random(32));
    const until = this.now() + INVITE_MS;
    (await this.e.setMeta('folder_invite', JSON.stringify({ k, until })));
    return { code: inviteCode({ hid, k, name: (await this.e.householdValue('name')) }), until };
  }

  async closeInvite(): Promise<void> {
    (await this.e.setMeta('folder_invite', null));
  }

  /**
   * Owner: answers the join files waiting in the folder that the open code's key opens. Each device
   * that asked is signed into the household and left a welcome. The code works once: it's closed
   * after the first device it lets in. Returns the names of the devices let in.
   */
  async answerJoins(names: string[]): Promise<string[]> {
    const inv = (await this.isOwner()) ? (await this.openInvite()) : null;
    if (!inv) return [];
    const io = (await this.io());
    const k = unb64(inv.k);
    const hid = (await this.e.householdValue('hid')) ?? '';
    const let_in: string[] = [];
    for (const name of names) {
      const m = /^restock-join-([A-Za-z0-9_-]{1,80})\.bin$/.exec(name);
      if (!m) continue;
      const device = m[1];
      const bytes = await io.read(name);
      if (!bytes) continue;
      let ask: { device?: unknown; name?: unknown; pub?: unknown; hid?: unknown };
      try {
        ask = openJson(hkdf32(k, strToU8(hid), JOIN_INFO), JOIN_AAD + device, bytes);
      } catch {
        continue; // not made with this code (an old one, or someone without it)
      }
      const pub = str(ask.pub);
      if (ask.device !== device || ask.hid !== hid || !pub || device === (await this.e.device())) continue;
      const label = (str(ask.name) ?? 'iPhone').slice(0, 40);
      await this.e.hold(async () => {
        // Someone removed earlier who is let back in with a new code is a member again.
        if ((await this.e.householdValue('removed:' + device)) !== null) (await this.ownerRow('removed:' + device, null));
        (await this.ownerRow('member:' + device, JSON.stringify({ name: label, pub })));
      });
      const welcome = {
        format: 'restock-folder-welcome',
        v: 1,
        device,
        hid,
        name: (await this.e.householdValue('name')),
        keyv: Number((await this.e.meta('keyv')) ?? 1) || 1,
        key: (await this.e.meta('key')),
        owner_pub: (await this.e.meta('owner_pubkey')) ?? (await this.e.householdValue('owner_pub')),
      };
      await io.write(welcomeName(device), sealJson(hkdf32(k, strToU8(hid), WELCOME_INFO), WELCOME_AAD + device, welcome));
      await io.remove(name).catch(() => undefined);
      let_in.push(label);
      // One code, one device.
      (await this.closeInvite());
      break;
    }
    return let_in;
  }

  /** Owner: the household's name. */
  async rename(name: string): Promise<void> {
    if (!(await this.isOwner())) throw new FolderProblem("Only the household's first device can rename it.");
    const n = name.trim().slice(0, 80);
    if (!n) throw new FolderProblem('Type a name for your household.');
    (await this.ownerRow('name', n));
    (await this.e.setMeta('household', n));
  }

  /** Owner: signs a device out of the household. Its file is passed over from now on. */
  async removeDevice(device: string): Promise<void> {
    if (!(await this.isOwner())) throw new FolderProblem("Only the household's first device can remove another.");
    if (!DEVICE.test(device) || device === (await this.e.device())) throw new FolderProblem("That isn't a device that can be removed.");
    await this.e.hold(async () => {
      (await this.ownerRow('removed:' + device, String(this.now())));
      (await this.ownerRow('member:' + device, null));
    });
  }

  // ---------- another device: joining with the owner's code ----------

  /**
   * A device that isn't in a household, with the shared folder picked, asks to join with the owner's
   * code. Nothing changes here until the owner's device answers (finishJoin, tried at each sync).
   */
  async askToJoin(code: string): Promise<void> {
    if ((await this.joined())) throw new FolderProblem('Leave your household first: a device belongs to one at a time.');
    const inv = parseFolderCode(code);
    const io = (await this.io());
    const me = (await this.e.device());
    const mine = (await this.myKeys());
    const ask = { device: me, name: (await this.e.meta('name')) ?? 'iPhone', pub: mine.pub, hid: inv.hid };
    await io.write(joinName(me), sealJson(hkdf32(unb64(inv.k), strToU8(inv.hid), JOIN_INFO), JOIN_AAD + me, ask));
    (await this.e.setMeta('folder_joining', JSON.stringify({ k: inv.k, hid: inv.hid, until: this.now() + INVITE_MS })));
    (await this.e.setMeta('folder_error', null));
  }

  async cancelJoin(): Promise<void> {
    (await this.e.setMeta('folder_joining', null));
  }

  /** Looks for the owner's welcome and, if it's there, joins. True once this device is in the household. */
  async finishJoin(): Promise<boolean> {
    if ((await this.joined())) return true;
    const j = (await this.joining());
    if (!j) return false;
    if (j.until < this.now()) {
      (await this.cancelJoin());
      throw new FolderProblem("The other device didn't answer in time. Show a new code on it and scan again, with Restock open on both.");
    }
    const io = (await this.io());
    const me = (await this.e.device());
    const bytes = await io.read(welcomeName(me));
    if (!bytes) return false;
    let w: { format?: unknown; v?: unknown; device?: unknown; hid?: unknown; name?: unknown; keyv?: unknown; key?: unknown; owner_pub?: unknown };
    try {
      w = openJson(hkdf32(unb64(j.k), strToU8(j.hid), WELCOME_INFO), WELCOME_AAD + me, bytes);
    } catch {
      return false; // not for this code: left alone, the right one may still come
    }
    const key = str(w.key);
    const ownerPub = str(w.owner_pub);
    const keyv = Number(w.keyv);
    if (w.format !== 'restock-folder-welcome' || w.v !== 1 || w.device !== me || w.hid !== j.hid || !key || unb64(key).length !== 32 || !ownerPub || !(keyv >= 1)) return false;
    const e = this.e;
    await e.hold(async () => {
      (await this.forget());
      (await e.setMeta('key', key));
      (await e.setMeta('keyv', String(Math.trunc(keyv))));
      (await e.setMeta('secret', b64u(random(32))));
      (await e.setMeta('owner_pin', ownerPub));
      (await e.setMeta('household', str(w.name)));
      (await e.setMeta('folder_house', '1'));
      // What this device shares to start with: groceries only (it can add its other tabs after).
      (await e.setMeta('tabs', 'pantry'));
      (await e.setMeta('tabs_eff', null));
      (await e.setMeta('share_receipts', '0'));
      (await e.setMeta('share_cards', '0'));
      // Its own things give way to the household's, and anything only it has still goes in (as a
      // phone joining a Restock server's house does).
      await e.db.exec("UPDATE sync_log SET stamp = -1, created = 0 WHERE tbl NOT IN ('household', 'prices')");
    });
    await io.remove(welcomeName(me)).catch(() => undefined);
    await io.remove(joinName(me)).catch(() => undefined);
    return true;
  }

  // ---------- syncing ----------

  private remote(io: FolderIo, list: { name: string; size: number; mtime: number; waiting?: boolean }[]): Remote {
    let first = true;
    return {
      files: async () => {
        const l = first ? list : await io.list();
        first = false;
        // A file iCloud hasn't brought down yet is read next time (it has been asked for).
        return l.filter((f) => !f.waiting).map((f) => ({ name: f.name, size: f.size, version: `${f.size}/${f.mtime}` }));
      },
      read: (name) => io.read(name),
      write: async (name, bytes) => {
        await io.write(name, bytes);
        return {};
      },
    };
  }

  /**
   * One round: the owner answers anyone asking to join, a device that asked looks for its welcome,
   * then the others' files are read and this device's own is written. Notes when and how it went.
   */
  async sync(): Promise<RoundResult & { letIn: string[]; justJoined: boolean }> {
    const empty: RoundResult = { received: 0, phones: 0, unread: 0, archived: 0, wrote: false, newKeys: false, shared: [] };
    try {
      const io = (await this.io());
      let justJoined = false;
      if (!(await this.joined())) {
        if (!(await this.finishJoin())) return { ...empty, letIn: [], justJoined: false };
        justJoined = true;
      }
      const list = await io.list();
      const letIn = await this.answerJoins(list.map((f) => f.name));
      const me = (await this.e.device());
      // Signed out by the owner: this device stops, and keeps everything it has.
      const signedOut = async () => {
        if ((await this.e.householdValue('removed:' + me)) === null) return;
        (await this.forget());
        (await this.e.setMeta('notice', 'removed'));
        throw new FolderProblem('This device was taken out of the household by its first device. Everything it had is still here.');
      };
      (await signedOut());
      // The household's first device gives it its settings (SharedSettings.seed).
      (await this.e.seedSettings());
      const res = await syncRound(this.e, this.remote(io, list), { webId: me, webPriv: '', webPub: '', keys: (await this.keys()) }, () => new Date(this.now()).toISOString(), {
        v3: true,
        ownName: syncName(me),
      });
      (await signedOut()); // the owner's change may have come in just now
      (await this.e.setMeta('folder_error', null));
      return { ...res, letIn, justJoined };
    } catch (err) {
      if ((await this.joined()) || (await this.joining())) (await this.e.setMeta('folder_error', err instanceof Error ? err.message : String(err)));
      throw err;
    }
  }

  /** What this device shares with the household: its tabs (groceries always). */
  async setTabs(tabs: string[]): Promise<void> {
    const t = new Set(tabs.filter((x) => ALL_TABS.includes(x)));
    t.add('pantry');
    (await this.e.setMeta('tabs', joinTabs(t)));
  }

  async myTabs(): Promise<string[]> {
    const t = parseTabs((await this.e.meta('tabs')));
    return ALL_TABS.filter((x) => t.has(x));
  }

  /** Leave: this device's file comes out of the folder (best effort) and the household is forgotten; everything on the device stays. */
  async leave(): Promise<void> {
    if (!(await this.joined()) && !(await this.joining())) return;
    if ((await this.isOwner()) && (await this.others()).length > 0) throw new FolderProblem("This is the household's first device, and others are still in it. Remove them here first, or they'd be left in a household nobody can add to.");
    try {
      const io = await this.folder();
      await io?.remove(syncName((await this.e.device())));
      await io?.remove(joinName((await this.e.device())));
    } catch {
      // the folder can't be reached: leaving carries on
    }
    (await this.forget());
  }

  /** The other devices in the household: id and name. */
  async others(): Promise<{ device: string; name: string }[]> {
    const me = (await this.e.device());
    const out: { device: string; name: string }[] = [];
    for (const r of await this.e.db.query("SELECT k, v FROM household WHERE k LIKE 'member:%' ORDER BY k")) {
      const device = String(r.k).slice('member:'.length);
      if (device === me || (await this.e.householdValue('removed:' + device)) !== null) continue;
      let name = device;
      try {
        const v = JSON.parse(String(r.v)) as { name?: unknown };
        if (typeof v.name === 'string' && v.name) name = v.name;
      } catch {
        // an odd row: the id will do
      }
      out.push({ device, name });
    }
    return out;
  }

  /** SyncHousehold.forget: the household and everything about its sync is forgotten; the device's own things stay (ios/household.ts). */
  async forget(): Promise<void> {
    (await forgetHousehold(this.e, ['folder_error', 'folder_house', 'folder_invite', 'folder_joining']));
  }
}

/** Not used by the app: the plain words of a sealed join or welcome, for the tests. */
export const _text = (b: Uint8Array) => strFromU8(b);
