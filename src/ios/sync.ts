// 0.13.2: sync on iPhone and iPad, behind the same calls the screens make on Android (RestockNative's
// sync…): the answers ios/native.ts gives. The work itself is ios/house.ts (a Restock server's house)
// on the engine the web app and the server run (server-mode/engine.ts, role 'phone'), straight on
// the app's own database.
//
// An iPhone only syncs while Restock is open: when it opens or comes back, every minute after that,
// and a few seconds after something changes (lib/sync.ts wires those, as on Android).
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { strToU8 } from 'fflate';
import { sqlJsDatabase } from '../lib/boot';
import { deviceWord, IosUnavailable } from '../lib/platform';
import { readPhoto, writePhoto } from '../lib/receiptFiles';
import type { ServerCodeCheck, SyncInfo, SyncNowResult } from '../lib/sql/native';
import { signedText, signWithPkcs8, verifySig } from '../server-mode/crypto';
import { ALL_TABS, parseServerRow, parseTabs, WebSyncEngine } from '../server-mode/engine';
import { syncDbOf } from '../server-mode/sqldb';
import type { Section } from '../shops';
import { appleHere, RestockApple } from './apple';
import { FolderHouse, FolderProblem, type FolderIo } from './folderHouse';
import { House, HouseProblem, type Http } from './house';
import { appleLan, lanHere } from './lan';
import { WifiHouse, WifiProblem, type Photos } from './wire';

const toB64 = (b: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
};
const fromB64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/**
 * Requests through the app's own HTTP (no browser rules between the app and the household's server).
 * Bodies go as bytes; an answer comes back as bytes whatever it is.
 */
export const appHttp: Http = async (o) => {
  // The click-through and the tests run in a browser, where plain fetch does the same job.
  if (!Capacitor.isPluginAvailable('CapacitorHttp')) {
    const r = await fetch(o.url, { method: o.method, headers: o.headers, body: o.body ? (o.body as unknown as BodyInit) : undefined });
    const headers: Record<string, string> = {};
    r.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
    return { status: r.status, headers, bytes: new Uint8Array(await r.arrayBuffer()) };
  }
  const r = await CapacitorHttp.request({
    method: o.method,
    url: o.url,
    headers: o.headers,
    ...(o.body ? { data: toB64(o.body), dataType: 'file' as const } : {}),
    responseType: 'arraybuffer',
    // Never followed for us: a followed redirect turns a POST into a GET (house.ts ask()).
    disableRedirects: true,
    connectTimeout: 15_000,
    readTimeout: 45_000,
  });
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries((r.headers ?? {}) as Record<string, unknown>)) headers[k.toLowerCase()] = String(v);
  const type = (headers['content-type'] ?? '').toLowerCase();
  let bytes: Uint8Array;
  // JSON comes back already read; anything else as base64.
  if (r.data === null || r.data === undefined || r.data === '') bytes = new Uint8Array(0);
  else if (typeof r.data !== 'string') bytes = strToU8(JSON.stringify(r.data));
  else if (type.includes('application/json')) bytes = strToU8(r.data);
  else {
    try {
      bytes = fromB64(r.data);
    } catch {
      bytes = strToU8(r.data);
    }
  }
  return { status: r.status, headers, bytes };
};

let made: { e: WebSyncEngine; house: House; folder: FolderHouse; wifi: WifiHouse; saved: () => void } | undefined;
/** Where receipt photos are kept on this device (set by ios/native.ts), for sharing them over the Wi-Fi. */
let photoStore: Photos | undefined;
export const setPhotoStore = (p: Photos | undefined) => (photoStore = p);
let http: Http = appHttp;
/** Tests: another way of making requests. */
export const setSyncHttp = (h: Http | undefined) => {
  http = h ?? appHttp;
  made = undefined;
};

/**
 * The iCloud Drive folder picked on this device, through the app's native plugin: kept as a bookmark
 * (sync_meta folder_bookmark), which is what lets the app open the folder again next time.
 */
function pickedFolder(e: WebSyncEngine, saved: () => void): FolderIo | undefined {
  const mark = e.meta('folder_bookmark');
  if (!mark || !appleHere()) return undefined;
  // iOS hands back a fresh bookmark now and then: keep it.
  const fresh = (b?: string) => {
    if (b && b !== e.meta('folder_bookmark')) {
      e.setMeta('folder_bookmark', b);
      saved();
    }
  };
  const bookmark = () => e.meta('folder_bookmark') ?? mark;
  return {
    list: async () => {
      const r = await RestockApple.folderList({ bookmark: bookmark() });
      fresh(r.bookmark);
      return r.files;
    },
    read: async (name) => {
      try {
        const r = await RestockApple.folderRead({ bookmark: bookmark(), name });
        fresh(r.bookmark);
        return fromB64(r.data);
      } catch {
        return null; // not there, or iCloud hasn't brought it down yet
      }
    },
    write: async (name, bytes) => {
      fresh((await RestockApple.folderWrite({ bookmark: bookmark(), name, data: toB64(bytes) })).bookmark);
    },
    remove: async (name) => {
      fresh((await RestockApple.folderDelete({ bookmark: bookmark(), name })).bookmark);
    },
  };
}

/** The engine, the house and the iCloud household on this app's database (made once it's open). */
export function hub() {
  if (made) return made;
  const sql = sqlJsDatabase();
  if (!sql) throw new Error("Restock's data isn't open yet. Try again in a moment.");
  // eslint-disable-next-line prefer-const
  let e: WebSyncEngine;
  // Only a household's owner device holds the key that signs its changes (an iCloud household's first device).
  const sign = (text: string) => {
    const priv = e.meta('owner_priv');
    if (!priv) throw new Error("Only the household's first device can change that.");
    return signWithPkcs8(priv, text);
  };
  e = new WebSyncEngine(syncDbOf(sql.db), verifySig, signedText, () => Date.now(), { role: 'phone', sign });
  if (e.meta('name') === null) e.setMeta('name', deviceWord() === 'iPad' ? 'iPad' : 'iPhone');
  const saved = sql.saved;
  // Receipt photos go between phones over the Wi-Fi only (as on Android): Restock's own copies, in its own storage.
  const photos: Photos = photoStore ?? {
    size: async (path) => {
      const d = await readPhoto(path);
      return d === undefined ? -1 : Math.floor((d.length * 3) / 4);
    },
    read: async (path) => {
      const d = await readPhoto(path);
      return d === undefined ? null : fromB64(d);
    },
    write: (path, bytes) => writePhoto(path, toB64(bytes)),
  };
  const wifi = new WifiHouse(e, () => appleLan(), () => photos);
  wifi.onChange = () => {
    saved();
    events.changed();
    events.done(info());
  };
  made = { e, house: new House(e, (o) => http(o)), folder: new FolderHouse(e, () => pickedFolder(e, saved)), wifi, saved };
  return made;
}

const sections = (t: Set<string>): Section[] => ALL_TABS.filter((x) => t.has(x)) as Section[];

/** What the screens show (RestockNativePlugin.syncInfoObject, for what an iPhone does). */
export function info(): SyncInfo {
  const sql = sqlJsDatabase();
  if (!sql) return { paired: false, batteryExempt: true };
  const { e, house, folder, wifi } = hub();
  const h = house.info();
  const notice = e.meta('notice');
  const f = folder.info();
  const w = wifi.info();
  if (!h.joined && !f.joined && !w.joined) return { paired: false, batteryExempt: true, device: e.device(), name: e.meta('name') ?? undefined, notice };
  const me = e.device();
  const owner = e.householdValue('owner');
  const members: NonNullable<SyncInfo['members']> = [];
  for (const r of e.db.query("SELECT k, v FROM household WHERE k LIKE 'member:%' ORDER BY k")) {
    const device = String(r.k).slice('member:'.length);
    if (e.householdValue('removed:' + device) !== null) continue;
    let name = device;
    try {
      const v = JSON.parse(String(r.v)) as { name?: unknown };
      if (typeof v.name === 'string' && v.name) name = v.name;
    } catch {
      // an odd row: the id will do
    }
    members.push({ device, name, owner: device === owner, me: device === me });
  }
  const peers = e.db
    .query('SELECT device, name, synced_at FROM sync_peers ORDER BY device')
    .map((r) => ({ device: String(r.device), name: r.name === null || r.name === undefined ? null : String(r.name), syncedAt: r.synced_at === null || r.synced_at === undefined ? null : String(r.synced_at) }));
  const row = parseServerRow(e.householdValue('server'));
  // A household of phones on the same Wi-Fi (ios/wire.ts): the phone that started it is the owner.
  if (w.joined) {
    const last = peers.map((p) => p.syncedAt).filter((x): x is string => !!x).sort().pop() ?? null;
    return {
      paired: true,
      batteryExempt: true,
      device: me,
      name: e.meta('name') ?? undefined,
      household: w.household ?? undefined,
      shareCards: e.shareCards(),
      peers,
      lastSyncAt: last,
      lastError: wifi.lastError,
      listening: w.listening,
      isOwner: w.owner,
      members,
      notice,
      householdTabs: sections(e.householdTabs()),
      myTabs: sections(parseTabs(e.meta('tabs'))),
      tabs: sections(e.tabs()),
      shareReceipts: e.householdValue('receipts') === '1',
      shareReceiptsMine: e.meta('share_receipts') === '1',
      onWifi: true,
      server: false,
      serverApi: null,
      house: false,
      wifiSync: true,
    };
  }
  // A household in an iCloud folder: no server, and its first device is the owner.
  if (!h.joined)
    return {
      paired: true,
      batteryExempt: true,
      device: me,
      name: e.meta('name') ?? undefined,
      household: f.household ?? undefined,
      shareCards: false,
      peers,
      lastSyncAt: f.at,
      lastError: null,
      listening: false,
      isOwner: f.owner,
      members,
      notice,
      householdTabs: sections(e.householdTabs()),
      myTabs: sections(parseTabs(e.meta('tabs'))),
      tabs: sections(e.tabs()),
      shareReceipts: false,
      shareReceiptsMine: false,
      onWifi: true,
      server: false,
      serverApi: null,
      house: false,
      wifiSync: false,
      folder: 'icloud',
      folderName: e.meta('folder_name') ?? 'iCloud Drive',
      folderAt: f.at,
      folderError: f.error,
      folderUnread: f.unread,
      folderKind: 'folder',
    };
  return {
    paired: true,
    batteryExempt: true,
    device: me,
    name: e.meta('name') ?? undefined,
    household: h.household ?? undefined,
    shareCards: e.shareCards(),
    peers,
    lastSyncAt: h.at,
    lastError: null,
    listening: false,
    isOwner: false,
    members,
    notice,
    householdTabs: sections(e.householdTabs()),
    myTabs: sections(parseTabs(e.meta('tabs'))),
    tabs: sections(e.tabs()),
    shareReceipts: e.householdValue('receipts') === '1',
    shareReceiptsMine: e.meta('share_receipts') === '1',
    onWifi: true,
    server: true,
    serverHome: h.home,
    serverAway: h.away,
    serverReached: h.reached,
    serverAt: h.at,
    serverError: h.error,
    serverUnread: h.unread,
    serverFiles: h.files,
    serverPrices: 0,
    serverPhotos: 0,
    serverWaiting: 0,
    serverApi: 3,
    house: true,
    serverLabel: h.label,
    serverMemberLabel: h.memberLabel,
    wifiSync: false,
    takeBack: [],
    ...(row ? { serverRow: { home: row.home, away: row.away ?? null, keepMonths: row.keepMonths } } : {}),
  };
}

type Events = { changed: () => void; done: (i: SyncInfo) => void };
let events: Events = { changed: () => undefined, done: () => undefined };
export const setSyncEvents = (e: Events) => (events = e);

let running: Promise<SyncNowResult> | undefined;

/** One round with everything this device syncs with (for now: its Restock server). One at a time. */
export function syncNow(): Promise<SyncNowResult> {
  if (running) return running;
  running = (async (): Promise<SyncNowResult> => {
    const { house, folder, wifi, saved } = hub();
    let received = 0;
    let viaServer = false;
    let viaFolder = false;
    let reached = 0;
    let sent = 0;
    let names: string[] = [];
    const overWifi = wifi.joined();
    if (overWifi) {
      try {
        const r = await wifi.syncAll();
        received = r.received;
        reached = r.reached;
        sent = r.sent;
        names = r.names;
        if (r.removed) events.changed();
      } catch (err) {
        if (!(err instanceof WifiProblem)) console.error('Wi-Fi sync failed', err);
      }
      saved();
    }
    const fi = folder.info();
    if (!house.joined() && (fi.joined || fi.joining)) {
      try {
        const r = await folder.sync();
        received = r.received;
        viaFolder = folder.joined();
        if (r.justJoined || r.letIn.length) events.changed();
      } catch (err) {
        // Said on the screen (folderError, or the "taken out of the household" notice).
        if (!(err instanceof FolderProblem)) console.error('iCloud sync failed', err);
      }
      saved();
    }
    if (house.joined()) {
      try {
        const r = await house.sync();
        received = r.received;
        viaServer = true;
      } catch (err) {
        // Said on the screen (serverError, or the "taken off your server" notice); nothing to throw.
        if (!(err instanceof HouseProblem)) console.error('Restock server sync failed', err);
      }
      saved();
    }
    const i = info();
    if (received > 0) events.changed();
    events.done(i);
    return { ...i, reached, received, sent, wifi: overWifi, viaServer, viaFolder, names };
  })().finally(() => (running = undefined));
  return running;
}

/** The every-minute look while Restock is open: a round only when something changed on the server. */
export async function serverPoll(): Promise<{ received: number }> {
  const { house, folder, wifi } = hub();
  if (running) return { received: 0 };
  // Phones on the Wi-Fi: a round is the look (it also keeps this device listening and findable).
  if (wifi.joined()) return { received: (await syncNow()).received };
  // An iCloud household: a round reads the folder's list and only the files that changed, so it's the look itself.
  const fi = folder.info();
  if (!house.joined() && (fi.joined || fi.joining)) return { received: (await syncNow()).received };
  if (!house.joined()) return { received: 0 };
  // Something made here that hasn't gone up yet (made just before Restock was closed, say)?
  let fresh = hub().e.unsent() > 0;
  try {
    fresh = fresh || (await house.anythingNew());
  } catch (err) {
    if (err instanceof HouseProblem && err.removed) fresh = true; // the round says so and tidies up
    else return { received: 0 };
  }
  return fresh ? { received: (await syncNow()).received } : { received: 0 };
}

export async function checkServer(code: string): Promise<ServerCodeCheck> {
  const { house } = hub();
  const c = await house.check(code);
  const i = info();
  return {
    v: c.v,
    home: c.home,
    away: c.away,
    mode: c.mode,
    house: c.house,
    empty: c.empty,
    inHousehold: c.inHousehold || i.paired,
    ...(c.inHousehold || i.paired ? { isOwner: false, household: i.household ?? 'your household', members: i.members?.length ?? 0, sameHouse: false } : {}),
  };
}

/** Join a house with its Add a phone code. "leave": leave the house this device is in first. */
export async function joinServer3(code: string, how: 'join' | 'bring' | 'leave') {
  const { house, saved } = hub();
  if (how === 'bring') throw new IosUnavailable('Bringing a household onto a server');
  if (how === 'leave' && house.joined()) await house.leave();
  // In a household of another kind (phones on the Wi-Fi, or iCloud): one at a time.
  const { folder, wifi: w } = hub();
  if (w.joined() || folder.joined()) {
    if (how !== 'leave') throw new HouseProblem('This device is already in a household. Leave it first: a device belongs to one household at a time.');
    if (w.joined() && !(await w.leave())) throw new HouseProblem('This phone started its household and other phones are still in it. Take them out first.');
    if (folder.joined()) await folder.leave();
  }
  await house.join(code);
  saved();
  const i = info();
  events.changed();
  return { ...i, label: i.serverMemberLabel ?? null, houseName: i.household ?? null, member: false };
}

export function setServer(o: { label?: string; tabs?: Section[]; receipts?: boolean; cards?: boolean; takeBack?: string[] }): SyncInfo {
  const { house, saved } = hub();
  // (Turning something off stops sharing it from now on; an iPhone doesn't also take what it shared back off the server.)
  const { e, folder, wifi: w } = hub();
  if (w.joined()) w.setShares0(o);
  else if (!house.joined() && folder.joined()) {
    if (o.tabs) folder.setTabs(o.tabs);
    if (o.receipts !== undefined) e.setMeta('share_receipts', o.receipts ? '1' : '0');
    if (o.cards !== undefined) e.setMeta('share_cards', o.cards ? '1' : '0');
    // An iCloud household's first device decides whether the household shares receipts at all.
    if (o.receipts !== undefined && folder.isOwner()) e.writeHousehold('receipts', o.receipts ? '1' : '0');
    e.noteTabs();
  } else {
    house.setShares({ label: o.label, tabs: o.tabs, receipts: o.receipts, cards: o.cards });
    e.noteTabs();
  }
  saved();
  return info();
}

/** Leaves whichever household this device is in (a server's house, an iCloud one, or phones on the Wi-Fi). Everything on it stays. */
export async function stopServer(_o: { takeBack?: string[] } = {}): Promise<SyncInfo & { left?: boolean }> {
  const { house, folder, wifi: w, saved } = hub();
  if (w.joined()) {
    const left = await w.leave();
    saved();
    events.changed();
    return { ...info(), left };
  }
  if (!house.joined()) await folder.leave();
  await house.leave();
  saved();
  const i = info();
  events.changed();
  return i;
}

export async function serverHealth(): Promise<{ mode?: string; api?: number; house?: string }> {
  const { house } = hub();
  const i = house.info();
  const h = await house.health([i.reached, i.home, i.away].filter((x): x is string => !!x));
  return h ? { mode: typeof h.mode === 'string' ? h.mode : undefined, api: typeof h.api === 'number' ? h.api : undefined, house: typeof h.house === 'string' ? h.house : undefined } : {};
}

export function dismissNotice(): void {
  const { e, saved } = hub();
  e.setMeta('notice', null);
  saved();
}

/** RestockNativePlugin.serverData: the server's figures for Your data. */
export async function serverData(path: string): Promise<Record<string, unknown>> {
  if (!/^\/data\/(summary|stats|top|series)(\?[A-Za-z0-9=&%._~-]{0,300})?$/.test(path)) throw new Error('Not something Your data reads.');
  return hub().house.sealed('GET', path);
}

/** This device's earlier spending (or what its searches found) going up to the household's own server. */
export async function serverRows(kind: 'spend' | 'seen', rows: Record<string, unknown>[]): Promise<{ added: number; skipped: number }> {
  const r = await hub().house.sealed('POST', `/data/${kind}`, { rows: Array.isArray(rows) ? rows : [] });
  return { added: Number(r.added) || 0, skipped: Number(r.skipped) || 0 };
}

// ---------- iCloud sync: what its own screen does (ui/screens/IcloudSync.tsx) ----------

export interface IcloudStatus {
  /** This build of the app can open a folder in Files (its native plugin is there). */
  available: boolean;
  /** The folder picked on this device, by name. */
  folderName: string | null;
  joined: boolean;
  joining: boolean;
  owner: boolean;
  household: string | null;
  at: string | null;
  error: string | null;
  invite: { code: string; until: number } | null;
  others: { device: string; name: string }[];
  myTabs: Section[];
  /** In a Restock server's house instead: a device belongs to one household at a time. */
  inHouse: boolean;
}

export const icloud = {
  status(): IcloudStatus {
    const { e, house, folder } = hub();
    const f = folder.info();
    return {
      available: appleHere(),
      folderName: e.meta('folder_bookmark') ? (e.meta('folder_name') ?? 'A folder in Files') : null,
      joined: f.joined,
      joining: f.joining,
      owner: f.owner,
      household: f.household,
      at: f.at,
      error: f.error,
      invite: f.invite,
      others: f.joined ? folder.others() : [],
      myTabs: folder.myTabs() as Section[],
      inHouse: house.joined(),
    };
  },
  /** Opens Files to pick the household's folder. False when nothing was picked. */
  async pickFolder(): Promise<boolean> {
    if (!appleHere()) throw new IosUnavailable('Picking a folder in Files');
    const { e, saved } = hub();
    let got: { bookmark: string; name: string };
    try {
      got = await RestockApple.folderPick();
    } catch {
      return false; // closed without picking
    }
    e.setMeta('folder_bookmark', got.bookmark);
    e.setMeta('folder_name', got.name);
    e.setMeta('folder_error', null);
    saved();
    return true;
  },
  /** The household's first device: makes the household, then writes its file. */
  async start(name: string, tabs: Section[]): Promise<void> {
    const { house, folder, wifi: w, saved } = hub();
    if (house.joined()) throw new FolderProblem('This device is on a Restock server. Leave the server first: a device belongs to one household at a time.');
    if (w.joined()) throw new FolderProblem('This device already syncs with another phone. Stop that first: a device belongs to one household at a time.');
    if (!this.status().folderName) throw new FolderProblem('Pick the iCloud Drive folder your household shares first.');
    folder.start(name, tabs);
    saved();
    events.changed();
    await syncNow();
  },
  invite(): { code: string; until: number } {
    const { folder, saved } = hub();
    const i = folder.invite();
    saved();
    return i;
  },
  closeInvite(): void {
    const { folder, saved } = hub();
    folder.closeInvite();
    saved();
  },
  /** Another device: asks to join with the first device's code, then looks for its answer. */
  async join(code: string): Promise<void> {
    const { house, folder, wifi: w, saved } = hub();
    if (house.joined()) throw new FolderProblem('This device is on a Restock server. Leave the server first: a device belongs to one household at a time.');
    if (w.joined()) throw new FolderProblem('This device already syncs with another phone. Stop that first: a device belongs to one household at a time.');
    await folder.askToJoin(code);
    saved();
    await syncNow();
  },
  cancelJoin(): void {
    const { folder, saved } = hub();
    folder.cancelJoin();
    saved();
  },
  async remove(device: string): Promise<void> {
    const { folder, saved } = hub();
    folder.removeDevice(device);
    saved();
    events.changed();
    await syncNow();
  },
  async leave(): Promise<void> {
    const { folder, saved } = hub();
    await folder.leave();
    saved();
    events.changed();
    events.done(info());
  },
  /** The folder is forgotten on this device (only when it isn't in a household that uses it). */
  forgetFolder(): void {
    const { e, folder, saved } = hub();
    if (folder.joined()) throw new FolderProblem('Leave the household first.');
    e.setMeta('folder_bookmark', null);
    e.setMeta('folder_name', null);
    saved();
  },
};

// ---------- 0.14.0: syncing with another phone over the Wi-Fi (ios/wire.ts) ----------

export interface WifiStatus {
  /** The app's native side can use the Wi-Fi (the iPhone and iPad app). */
  available: boolean;
  joined: boolean;
  owner: boolean;
  household: string | null;
  listening: boolean;
  invite: { code: string; until: number } | null;
  members: { device: string; name: string; me: boolean; owner: boolean }[];
  at: string | null;
  error: string | null;
  myTabs: Section[];
  householdTabs: Section[];
  receipts: boolean;
  cards: boolean;
  /** In another kind of household (a Restock server's, or an iCloud one): one at a time. */
  elsewhere: 'server' | 'icloud' | null;
}

const ELSEWHERE = 'This device is already in a household. Leave it first: a device belongs to one household at a time.';

export const wifi = {
  status(): WifiStatus {
    const { e, house, folder, wifi: w } = hub();
    const i = w.info();
    const at = e.db
      .query('SELECT synced_at FROM sync_peers WHERE synced_at IS NOT NULL ORDER BY synced_at DESC LIMIT 1')
      .map((r) => String(r.synced_at))[0];
    return {
      available: lanHere(),
      joined: i.joined,
      owner: i.owner,
      household: i.household,
      listening: i.listening,
      invite: i.invite,
      members: i.joined ? w.members() : [],
      at: i.joined ? (at ?? null) : null,
      error: i.joined ? w.lastError : null,
      myTabs: sections(e.tabs()),
      householdTabs: sections(e.householdTabs()),
      receipts: e.meta('share_receipts') === '1',
      cards: e.shareCards(),
      elsewhere: house.joined() ? 'server' : folder.joined() ? 'icloud' : null,
    };
  },
  /** This device starts a household; the other phones join with its code. */
  async start(name: string, tabs: Section[]): Promise<void> {
    const { house, folder, wifi: w, saved } = hub();
    if (house.joined() || folder.joined()) throw new WifiProblem(ELSEWHERE);
    w.start(name, tabs);
    saved();
    events.changed();
    await w.listen().catch(() => {});
    events.done(info());
  },
  async invite(): Promise<{ code: string; until: number }> {
    const { wifi: w, saved } = hub();
    const i = await w.invite();
    saved();
    return i;
  },
  async closeInvite(): Promise<void> {
    const { wifi: w, saved } = hub();
    await w.closeInvite();
    saved();
  },
  peek(code: string) {
    return hub().wifi.peek(code);
  },
  /** Joins another phone's household with the code it shows, then syncs with it. */
  async join(code: string, tabs?: Section[]): Promise<void> {
    const { house, folder, wifi: w, saved } = hub();
    if (house.joined() || folder.joined()) throw new WifiProblem(ELSEWHERE);
    await w.join(code, tabs);
    saved();
    events.changed();
    await syncNow();
  },
  async remove(device: string): Promise<void> {
    const { wifi: w, saved } = hub();
    await w.remove(device);
    saved();
    events.changed();
    events.done(info());
  },
  /** False: this phone started the household and others are still in it. */
  async leave(): Promise<boolean> {
    const { wifi: w, saved } = hub();
    const left = await w.leave();
    saved();
    events.changed();
    events.done(info());
    return left;
  },
  setShares(o: { tabs?: Section[]; receipts?: boolean; cards?: boolean }): void {
    const { wifi: w, saved } = hub();
    if (o.tabs) w.setTabs(o.tabs);
    if (o.receipts !== undefined) w.setReceipts(o.receipts);
    if (o.cards !== undefined) w.setCards(o.cards);
    saved();
    events.changed();
  },
  /** Restock came to the front: listen for the other phones again (iOS stops it in the background). */
  async resumed(): Promise<void> {
    const { wifi: w } = hub();
    if (!w.joined()) return;
    await w.stop();
    await w.listen().catch(() => {});
  },
  async paused(): Promise<void> {
    await hub().wifi.stop();
  },
};

// ---------- 0.14.0: signing in on a computer by scanning the server page's code ----------

export const webCode = (code: string) => {
  const w = hub().house.webCode(code);
  return { kind: w.kind, host: w.host };
};
export const webApprove = (code: string) => hub().house.approveWeb(code);
