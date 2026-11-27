// 0.13.2: sync on iPhone and iPad, behind the same calls the screens make on Android (RestockNative's
// sync…): the answers ios/native.ts gives. The work itself is ios/house.ts (a Restock server's house)
// on the engine the web app and the server run (server-mode/engine.ts, role 'phone'), straight on
// the app's own database.
//
// An iPhone only syncs while Restock is open: when it opens or comes back, every minute after that,
// and a few seconds after something changes (lib/sync.ts wires those, as on Android).
import { busyWith } from '../lib/speedLog';
import { screensFirst } from '../lib/screensFirst';
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { strToU8 } from 'fflate';
import { syncDatabase } from '../lib/boot';
import { deviceWord, IosUnavailable } from '../lib/platform';
import { readPhoto, writePhoto } from '../lib/receiptFiles';
import type { ServerCodeCheck, SyncInfo, SyncNowResult } from '../lib/sql/native';
import { signedText, signWithPkcs8, verifySig } from '../server-mode/crypto';
import { ALL_TABS, AsyncSyncEngine, parseServerRow, parseTabs } from '../server-mode/engine';
import type { Section } from '../shops';
import { appleHere, RestockApple } from './apple';
import { FolderHouse, FolderProblem, type FolderIo } from './folderHouse';
import { davAddress, davFolder, DavProblem, nextcloudFolderUrl, pollNextcloud, startNextcloud, type NextcloudLogin } from './dav';

/** "cloud.example.com · Restock" for a folder's address. */
const davLabel = (url: string): string => {
  try {
    const u = new URL(url);
    const last = decodeURIComponent(u.pathname.replace(/\/+$/, '').split('/').pop() ?? '');
    return u.host + (last ? ` · ${last}` : '');
  } catch {
    return url;
  }
};
import { House, HouseProblem, type Http } from './house';
import { appleLan, lanHere } from './lan';
import { WifiHouse, WifiProblem, type Photos } from './wire';
import { quiet } from '../lib/quietErrors';

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
const appHttp: Http = async (o) => {
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
    connectTimeout: o.connectMs ?? 15_000,
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

let made: { e: AsyncSyncEngine; house: House; folder: FolderHouse; wifi: WifiHouse; saved: () => void } | undefined;
let http: Http = appHttp;

/**
 * The iCloud Drive folder picked on this device, through the app's native plugin: kept as a bookmark
 * (sync_meta folder_bookmark), which is what lets the app open the folder again next time.
 */
async function pickedFolder(e: AsyncSyncEngine, saved: () => void): Promise<FolderIo | undefined> {
  const mark = (await e.meta('folder_bookmark'));
  if (!mark || !appleHere()) return undefined;
  // iOS hands back a fresh bookmark now and then: keep it.
  const fresh = async (b?: string) => {
    if (b && b !== (await e.meta('folder_bookmark'))) {
      (await e.setMeta('folder_bookmark', b));
      saved();
    }
  };
  const bookmark = async () => (await e.meta('folder_bookmark')) ?? mark;
  return {
    list: async () => {
      const r = await RestockApple.folderList({ bookmark: (await bookmark()) });
      (await fresh(r.bookmark));
      return r.files;
    },
    read: async (name) => {
      try {
        const r = await RestockApple.folderRead({ bookmark: (await bookmark()), name });
        (await fresh(r.bookmark));
        return fromB64(r.data);
      } catch {
        return null; // not there, or iCloud hasn't brought it down yet
      }
    },
    write: async (name, bytes) => {
      (await fresh((await RestockApple.folderWrite({ bookmark: (await bookmark()), name, data: toB64(bytes) })).bookmark));
    },
    remove: async (name) => {
      (await fresh((await RestockApple.folderDelete({ bookmark: (await bookmark()), name })).bookmark));
    },
  };
}

/**
 * 0.15.0: the household's folder on Nextcloud or another WebDAV server (ios/dav.ts), when that's what
 * this device uses instead of iCloud Drive (sync_meta folder_kind "dav"). The password is in the
 * keychain; it's fetched the first time the folder is used.
 */
async function davFolderOf(e: AsyncSyncEngine): Promise<FolderIo | undefined> {
  const url = (await e.meta('dav_url'));
  if ((await e.meta('folder_kind')) !== 'dav' || !url) return undefined;
  let open: Promise<FolderIo> | undefined;
  const get = () =>
    (open ??= (async () => {
      const s = appleHere() ? await RestockApple.secretGet({ key: DAV_SECRET }).catch(() => ({ found: false, value: undefined })) : { found: false, value: undefined };
      return davFolder({ url, user: (await e.meta('dav_user')) ?? '', password: s.found ? (s.value ?? '') : '' }, (o) => http(o as Parameters<Http>[0]));
    })());
  return {
    list: async () => (await get()).list(),
    read: async (n) => (await get()).read(n),
    write: async (n, b) => (await get()).write(n, b),
    remove: async (n) => (await get()).remove(n),
  };
}
const DAV_SECRET = 'restock-dav-password';

/** The engine, the house and the iCloud household on this app's database (made once it's open). */
export async function hub() {
  if (made) return made;
  const sql = await syncDatabase();
  if (!sql) throw new Error("Restock's data isn't open yet. Try again in a moment.");
  // Only a household's owner device holds the key that signs its changes (an iCloud household's first device).
  const sign = (text: string, priv: string | null) => {
    if (!priv) throw new Error("Only the household's first device can change that.");
    return signWithPkcs8(priv, text);
  };
  const e = new AsyncSyncEngine(sql.db, verifySig, signedText, () => Date.now(), { role: 'phone', sign });
  if ((await e.meta('name')) === null) await e.setMeta('name', deviceWord() === 'iPad' ? 'iPad' : 'iPhone');
  if (made) return made; // made meanwhile, by another call
  const saved = sql.saved;
  // Receipt photos go between phones over the Wi-Fi only (as on Android): Restock's own copies, in its own storage.
  const photos: Photos = {
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
    void info().then(events.done, () => undefined);
  };
  made = { e, house: new House(e, (o) => http(o)), folder: new FolderHouse(e, async () => (await davFolderOf(e)) ?? (await pickedFolder(e, saved))), wifi, saved };
  return made;
}

const sections = (t: Set<string>): Section[] => ALL_TABS.filter((x) => t.has(x)) as Section[];

/** What the screens show (RestockNativePlugin.syncInfoObject, for what an iPhone does). */
export async function info(): Promise<SyncInfo> {
  const sql = await syncDatabase();
  if (!sql) return { paired: false, batteryExempt: true };
  const { e, house, folder, wifi } = await hub();
  const h = (await house.info());
  const notice = (await e.meta('notice'));
  const f = (await folder.info());
  const w = (await wifi.info());
  if (!h.joined && !f.joined && !w.joined) return { paired: false, batteryExempt: true, device: (await e.device()), name: (await e.meta('name')) ?? undefined, notice };
  const me = (await e.device());
  const owner = (await e.householdValue('owner'));
  const members: NonNullable<SyncInfo['members']> = [];
  for (const r of await e.db.query("SELECT k, v FROM household WHERE k LIKE 'member:%' ORDER BY k")) {
    const device = String(r.k).slice('member:'.length);
    if ((await e.householdValue('removed:' + device)) !== null) continue;
    let name = device;
    try {
      const v = JSON.parse(String(r.v)) as { name?: unknown };
      if (typeof v.name === 'string' && v.name) name = v.name;
    } catch {
      // an odd row: the id will do
    }
    members.push({ device, name, owner: device === owner, me: device === me });
  }
  const peers = (await e.db
    .query('SELECT device, name, synced_at FROM sync_peers ORDER BY device'))
    .map((r) => ({ device: String(r.device), name: r.name === null || r.name === undefined ? null : String(r.name), syncedAt: r.synced_at === null || r.synced_at === undefined ? null : String(r.synced_at) }));
  const row = parseServerRow((await e.householdValue('server')));
  // A household of phones on the same Wi-Fi (ios/wire.ts): the phone that started it is the owner.
  if (w.joined) {
    const last = peers.map((p) => p.syncedAt).filter((x): x is string => !!x).sort().pop() ?? null;
    return {
      paired: true,
      batteryExempt: true,
      device: me,
      name: (await e.meta('name')) ?? undefined,
      household: w.household ?? undefined,
      shareCards: (await e.shareCards()),
      peers,
      lastSyncAt: last,
      lastError: wifi.lastError,
      listening: w.listening,
      isOwner: w.owner,
      members,
      notice,
      householdTabs: sections((await e.householdTabs())),
      myTabs: sections(parseTabs((await e.meta('tabs')))),
      tabs: sections((await e.tabs())),
      shareReceipts: (await e.householdValue('receipts')) === '1',
      shareReceiptsMine: (await e.meta('share_receipts')) === '1',
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
      name: (await e.meta('name')) ?? undefined,
      household: f.household ?? undefined,
      shareCards: false,
      peers,
      lastSyncAt: f.at,
      lastError: null,
      listening: false,
      isOwner: f.owner,
      members,
      notice,
      householdTabs: sections((await e.householdTabs())),
      myTabs: sections(parseTabs((await e.meta('tabs')))),
      tabs: sections((await e.tabs())),
      shareReceipts: false,
      shareReceiptsMine: false,
      onWifi: true,
      server: false,
      serverApi: null,
      house: false,
      wifiSync: false,
      folder: 'icloud',
      folderName: (await e.meta('folder_name')) ?? 'iCloud Drive',
      folderAt: f.at,
      folderError: f.error,
      folderUnread: f.unread,
      folderKind: 'folder',
    };
  return {
    paired: true,
    batteryExempt: true,
    device: me,
    name: (await e.meta('name')) ?? undefined,
    household: h.household ?? undefined,
    shareCards: (await e.shareCards()),
    peers,
    lastSyncAt: h.at,
    lastError: null,
    listening: false,
    isOwner: false,
    members,
    notice,
    householdTabs: sections((await e.householdTabs())),
    myTabs: sections(parseTabs((await e.meta('tabs')))),
    tabs: sections((await e.tabs())),
    shareReceipts: (await e.householdValue('receipts')) === '1',
    shareReceiptsMine: (await e.meta('share_receipts')) === '1',
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
    // 0.18.1: a screen being opened reads first (lib/screensFirst.ts).
    await screensFirst();
    busyWith('a sync', true);
    const { house, folder, wifi, saved } = (await hub());
    let received = 0;
    let viaServer = false;
    let viaFolder = false;
    let reached = 0;
    let sent = 0;
    let names: string[] = [];
    const overWifi = (await wifi.joined());
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
    const fi = (await folder.info());
    if (!(await house.joined()) && (fi.joined || fi.joining)) {
      try {
        const r = await folder.sync();
        received = r.received;
        viaFolder = (await folder.joined());
        if (r.justJoined || r.letIn.length) events.changed();
      } catch (err) {
        // Said on the screen (folderError, or the "taken out of the household" notice).
        if (!(err instanceof FolderProblem)) console.error('iCloud sync failed', err);
      }
      saved();
    }
    if ((await house.joined())) {
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
    const i = (await info());
    if (received > 0) events.changed();
    events.done(i);
    return { ...i, reached, received, sent, wifi: overWifi, viaServer, viaFolder, names };
  })().finally(() => {
    running = undefined;
    busyWith('a sync', false);
  });
  return running;
}

/** The every-minute look while Restock is open: a round only when something changed on the server. */
export async function serverPoll(): Promise<{ received: number }> {
  const { house, folder, wifi } = (await hub());
  if (running) return { received: 0 };
  // Phones on the Wi-Fi: a round is the look (it also keeps this device listening and findable).
  if ((await wifi.joined())) return { received: (await syncNow()).received };
  // An iCloud household: a round reads the folder's list and only the files that changed, so it's the look itself.
  const fi = (await folder.info());
  if (!(await house.joined()) && (fi.joined || fi.joining)) return { received: (await syncNow()).received };
  if (!(await house.joined())) return { received: 0 };
  // Something made here that hasn't gone up yet (made just before Restock was closed, say)?
  let fresh = (await (await hub()).e.unsent()) > 0;
  try {
    fresh = fresh || (await house.anythingNew());
  } catch (err) {
    if (err instanceof HouseProblem && err.removed) fresh = true; // the round says so and tidies up
    else return { received: 0 };
  }
  return fresh ? { received: (await syncNow()).received } : { received: 0 };
}

export async function checkServer(code: string): Promise<ServerCodeCheck> {
  const { house } = (await hub());
  const c = await house.check(code);
  const i = (await info());
  return {
    v: c.v,
    home: c.home,
    away: c.away,
    mode: c.mode,
    house: c.house,
    empty: c.empty,
    inHousehold: c.inHousehold || i.paired,
    // 0.15.0: the owner of a household on the Wi-Fi or in iCloud can bring it onto an empty server.
    ...(c.inHousehold || i.paired ? { isOwner: (await ownsBringable()), household: i.household ?? 'your household', members: i.members?.length ?? 0, sameHouse: false } : {}),
  };
}

/** 0.15.0: this device owns a household that could go onto a server (phones on the Wi-Fi, or an iCloud folder). */
async function ownsBringable(): Promise<boolean> {
  const { wifi: w, folder } = (await hub());
  return ((await w.joined()) && (await w.isOwner())) || ((await folder.joined()) && (await folder.isOwner()));
}

/** Join a house with its Add a phone code. "leave": leave the house this device is in first. "bring": take this device's household onto the server. */
export async function joinServer3(code: string, how: 'join' | 'bring' | 'leave') {
  const { house, saved } = (await hub());
  if (how === 'bring') {
    const { wifi: w, folder } = (await hub());
    const kind = (await w.joined()) && (await w.isOwner()) ? 'wifi_house' : (await folder.joined()) && (await folder.isOwner()) ? 'folder_house' : null;
    if (!kind) throw new HouseProblem("Only the household's owner phone can bring it onto a server.");
    // The Wi-Fi household stops listening: the server is the house from now on.
    if (kind === 'wifi_house') await w.stop();
    await house.bring(code, kind);
    saved();
    const i = (await info());
    events.changed();
    return { ...i, label: i.serverMemberLabel ?? null, houseName: i.household ?? null, member: false };
  }
  if (how === 'leave' && (await house.joined())) await house.leave();
  // In a household of another kind (phones on the Wi-Fi, or iCloud): one at a time.
  const { folder, wifi: w } = (await hub());
  if ((await w.joined()) || (await folder.joined())) {
    if (how !== 'leave') throw new HouseProblem('This device is already in a household. Leave it first: a device belongs to one household at a time.');
    if ((await w.joined()) && !(await w.leave())) throw new HouseProblem('This phone started its household and other phones are still in it. Take them out first.');
    if ((await folder.joined())) await folder.leave();
  }
  await house.join(code);
  saved();
  const i = (await info());
  events.changed();
  return { ...i, label: i.serverMemberLabel ?? null, houseName: i.household ?? null, member: false };
}

export async function setServer(o: { label?: string; tabs?: Section[]; receipts?: boolean; cards?: boolean; takeBack?: string[] }): Promise<SyncInfo> {
  const { house, saved } = (await hub());
  // (Turning something off stops sharing it from now on; an iPhone doesn't also take what it shared back off the server.)
  const { e, folder, wifi: w } = (await hub());
  if ((await w.joined())) (await w.setShares0(o));
  else if (!(await house.joined()) && (await folder.joined())) {
    if (o.tabs) (await folder.setTabs(o.tabs));
    if (o.receipts !== undefined) (await e.setMeta('share_receipts', o.receipts ? '1' : '0'));
    if (o.cards !== undefined) (await e.setMeta('share_cards', o.cards ? '1' : '0'));
    // An iCloud household's first device decides whether the household shares receipts at all.
    if (o.receipts !== undefined && (await folder.isOwner())) (await e.writeHousehold('receipts', o.receipts ? '1' : '0'));
    (await e.noteTabs());
  } else {
    (await house.setShares({ label: o.label, tabs: o.tabs, receipts: o.receipts, cards: o.cards }));
    (await e.noteTabs());
  }
  saved();
  return (await info());
}

/** Leaves whichever household this device is in (a server's house, an iCloud one, or phones on the Wi-Fi). Everything on it stays. */
export async function stopServer(_o: { takeBack?: string[] } = {}): Promise<SyncInfo & { left?: boolean }> {
  const { house, folder, wifi: w, saved } = (await hub());
  if ((await w.joined())) {
    const left = await w.leave();
    saved();
    events.changed();
    return { ...(await info()), left };
  }
  if (!(await house.joined())) await folder.leave();
  await house.leave();
  saved();
  const i = (await info());
  events.changed();
  return i;
}

export async function dismissNotice(): Promise<void> {
  const { e, saved } = (await hub());
  (await e.setMeta('notice', null));
  saved();
}

/** RestockNativePlugin.serverData: the server's figures for Your data. */
export async function serverData(path: string): Promise<Record<string, unknown>> {
  if (!/^\/data\/(summary|stats|top|series)(\?[A-Za-z0-9=&%._~-]{0,300})?$/.test(path)) throw new Error('Not something Your data reads.');
  return (await hub()).house.sealed('GET', path);
}

/** 0.18.0: RestockNativePlugin.serverAdmin: the server's phones, as an admin phone (sealed both ways). */
export type AdminMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
/** 0.18.3: what an admin phone asks its server for (RestockNativePlugin.ADMIN_PATHS is the same). */
export const ADMIN_PATHS = /^\/(me|phones(\/[A-Za-z0-9_-]{1,64})?|approvals(\/[A-Za-z0-9_-]{20,40})?|confirm\/challenge|settings|activity(\?limit=\d{1,4})?|browsers(\/[A-Za-z0-9_-]{22})?|homeassistant(\/(test|sync))?|data\/(summary|autodelete)|recovery|server\/(log|updates|restart))$/;
export async function serverAdmin(method: AdminMethod, path: string, body?: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!ADMIN_PATHS.test(path) || !['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw new Error('Not something an admin phone does.');
  return (await hub()).house.sealed(method, path, body ?? (method === 'GET' ? undefined : {}));
}

/** This device's earlier spending (or what its searches found) going up to the household's own server. */
export async function serverRows(kind: 'spend' | 'seen', rows: Record<string, unknown>[]): Promise<{ added: number; skipped: number }> {
  const r = await (await hub()).house.sealed('POST', `/data/${kind}`, { rows: Array.isArray(rows) ? rows : [] });
  return { added: Number(r.added) || 0, skipped: Number(r.skipped) || 0 };
}

// ---------- iCloud sync: what its own screen does (ui/screens/IcloudSync.tsx) ----------

export interface IcloudStatus {
  /** This build of the app can open a folder in Files (its native plugin is there). */
  available: boolean;
  /** The folder picked on this device, by name. */
  folderName: string | null;
  /** 0.15.0: where the folder is: iCloud Drive (or another folder in Files), or Nextcloud / WebDAV. */
  folderKind: 'icloud' | 'dav';
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
  async status(): Promise<IcloudStatus> {
    const { e, house, folder } = (await hub());
    const f = (await folder.info());
    return {
      available: appleHere(),
      folderName:
        (await e.meta('folder_kind')) === 'dav' && (await e.meta('dav_url'))
          ? davLabel((await e.meta('dav_url')) as string)
          : (await e.meta('folder_bookmark'))
            ? ((await e.meta('folder_name')) ?? 'A folder in Files')
            : null,
      folderKind: (await e.meta('folder_kind')) === 'dav' ? 'dav' : 'icloud',
      joined: f.joined,
      joining: f.joining,
      owner: f.owner,
      household: f.household,
      at: f.at,
      error: f.error,
      invite: f.invite,
      others: f.joined ? (await folder.others()) : [],
      myTabs: (await folder.myTabs()) as Section[],
      inHouse: (await house.joined()),
    };
  },
  /** Opens Files to pick the household's folder. False when nothing was picked. */
  async pickFolder(): Promise<boolean> {
    if (!appleHere()) throw new IosUnavailable('Picking a folder in Files');
    const { e, saved } = (await hub());
    let got: { bookmark: string; name: string };
    try {
      got = await RestockApple.folderPick();
    } catch {
      return false; // closed without picking
    }
    (await e.setMeta('folder_bookmark', got.bookmark));
    (await e.setMeta('folder_name', got.name));
    (await e.setMeta('folder_kind', null));
    (await e.setMeta('folder_error', null));
    saved();
    return true;
  },
  /**
   * 0.15.0: the household's folder on a WebDAV server instead of iCloud Drive. Tried out first (made
   * if it isn't there, then written, read back and deleted), so a folder Restock can't use is turned
   * down straight away. The password goes in the keychain, never in the database or a backup.
   */
  async useDav(o: { url: string; user: string; password: string }): Promise<void> {
    const { e, folder, saved } = (await hub());
    if ((await folder.joined())) throw new FolderProblem('Leave the household first, then pick its new folder.');
    const url = davAddress(o.url);
    const f = davFolder({ url, user: o.user.trim(), password: o.password }, (x) => http(x as Parameters<Http>[0]));
    await f.ensure();
    const probe = `restock-check-${(await e.device())}.bin`;
    await f.write(probe, new Uint8Array([1, 2, 3]));
    const back = await f.read(probe);
    await f.remove(probe).catch(() => undefined);
    if (!back || back.length !== 3) throw new DavProblem("The folder took a file but didn't give it back. Restock can't use it.");
    if (appleHere()) await RestockApple.secretSet({ key: DAV_SECRET, value: o.password });
    (await e.setMeta('folder_kind', 'dav'));
    (await e.setMeta('dav_url', url));
    (await e.setMeta('dav_user', o.user.trim()));
    (await e.setMeta('folder_error', null));
    saved();
  },
  /** Starts a Nextcloud sign-in: the page to open in the browser, and how to ask whether it's done. */
  nextcloudStart: (server: string) => startNextcloud(server, (x) => http(x as Parameters<Http>[0])),
  /** Asks once whether the Nextcloud sign-in is finished; when it is, the Restock folder there is used. */
  async nextcloudPoll(l: NextcloudLogin): Promise<boolean> {
    const done = await pollNextcloud(l, (x) => http(x as Parameters<Http>[0]));
    if (!done) return false;
    await this.useDav({ url: nextcloudFolderUrl(done.server, done.loginName), user: done.loginName, password: done.appPassword });
    return true;
  },
  /** The household's first device: makes the household, then writes its file. */
  async start(name: string, tabs: Section[]): Promise<void> {
    const { house, folder, wifi: w, saved } = (await hub());
    if ((await house.joined())) throw new FolderProblem('This device is on a Restock server. Leave the server first: a device belongs to one household at a time.');
    if ((await w.joined())) throw new FolderProblem('This device already syncs with another phone. Stop that first: a device belongs to one household at a time.');
    if (!(await this.status()).folderName) throw new FolderProblem('Pick the iCloud Drive folder your household shares first.');
    (await folder.start(name, tabs));
    saved();
    events.changed();
    await syncNow();
  },
  async invite(): Promise<{ code: string; until: number }> {
    const { folder, saved } = (await hub());
    const i = (await folder.invite());
    saved();
    return i;
  },
  async closeInvite(): Promise<void> {
    const { folder, saved } = (await hub());
    (await folder.closeInvite());
    saved();
  },
  /** Another device: asks to join with the first device's code, then looks for its answer. */
  async join(code: string): Promise<void> {
    const { house, folder, wifi: w, saved } = (await hub());
    if ((await house.joined())) throw new FolderProblem('This device is on a Restock server. Leave the server first: a device belongs to one household at a time.');
    if ((await w.joined())) throw new FolderProblem('This device already syncs with another phone. Stop that first: a device belongs to one household at a time.');
    await folder.askToJoin(code);
    saved();
    await syncNow();
  },
  async cancelJoin(): Promise<void> {
    const { folder, saved } = (await hub());
    (await folder.cancelJoin());
    saved();
  },
  async remove(device: string): Promise<void> {
    const { folder, saved } = (await hub());
    (await folder.removeDevice(device));
    saved();
    events.changed();
    await syncNow();
  },
  async leave(): Promise<void> {
    const { folder, saved } = (await hub());
    await folder.leave();
    saved();
    events.changed();
    events.done((await info()));
  },
  /** The folder is forgotten on this device (only when it isn't in a household that uses it). */
  async forgetFolder(): Promise<void> {
    const { e, folder, saved } = (await hub());
    if ((await folder.joined())) throw new FolderProblem('Leave the household first.');
    (await e.setMeta('folder_bookmark', null));
    (await e.setMeta('folder_name', null));
    // 0.15.0: and a Nextcloud or WebDAV folder, with its password.
    for (const k of ['folder_kind', 'dav_url', 'dav_user']) (await e.setMeta(k, null));
    if (appleHere()) void RestockApple.secretDelete({ key: DAV_SECRET }).catch(() => undefined);
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
  /** 0.15.0: the phone the owner asked to take over, while it hasn't yet. */
  handingOverTo: string | null;
}

const ELSEWHERE = 'This device is already in a household. Leave it first: a device belongs to one household at a time.';

export const wifi = {
  async status(): Promise<WifiStatus> {
    const { e, house, folder, wifi: w } = (await hub());
    const i = (await w.info());
    const at = (await e.db
      .query('SELECT synced_at FROM sync_peers WHERE synced_at IS NOT NULL ORDER BY synced_at DESC LIMIT 1'))
      .map((r) => String(r.synced_at))[0];
    return {
      available: lanHere(),
      joined: i.joined,
      owner: i.owner,
      household: i.household,
      listening: i.listening,
      invite: i.invite,
      members: i.joined ? (await w.members()) : [],
      at: i.joined ? (at ?? null) : null,
      error: i.joined ? w.lastError : null,
      myTabs: sections((await e.tabs())),
      householdTabs: sections((await e.householdTabs())),
      receipts: (await e.meta('share_receipts')) === '1',
      cards: (await e.shareCards()),
      elsewhere: (await house.joined()) ? 'server' : (await folder.joined()) ? 'icloud' : null,
      handingOverTo: i.joined && i.owner ? (await w.handingOverTo()) : null,
    };
  },
  /** This device starts a household; the other phones join with its code. */
  async start(name: string, tabs: Section[]): Promise<void> {
    const { house, folder, wifi: w, saved } = (await hub());
    if ((await house.joined()) || (await folder.joined())) throw new WifiProblem(ELSEWHERE);
    (await w.start(name, tabs));
    saved();
    events.changed();
    await w.listen().catch(quiet('Wi-Fi sync'));
    events.done((await info()));
  },
  async invite(): Promise<{ code: string; until: number }> {
    const { wifi: w, saved } = (await hub());
    const i = await w.invite();
    saved();
    return i;
  },
  async closeInvite(): Promise<void> {
    const { wifi: w, saved } = (await hub());
    await w.closeInvite();
    saved();
  },
  async peek(code: string) {
    return (await hub()).wifi.peek(code);
  },
  /** Joins another phone's household with the code it shows, then syncs with it. */
  async join(code: string, tabs?: Section[]): Promise<void> {
    const { house, folder, wifi: w, saved } = (await hub());
    if ((await house.joined()) || (await folder.joined())) throw new WifiProblem(ELSEWHERE);
    await w.join(code, tabs);
    saved();
    events.changed();
    await syncNow();
  },
  async remove(device: string): Promise<void> {
    const { wifi: w, saved } = (await hub());
    await w.remove(device);
    saved();
    events.changed();
    events.done((await info()));
  },
  /** 0.15.0: asks another phone to take over as the owner (it does at its next sync). */
  async handOver(device: string): Promise<void> {
    const { wifi: w, saved } = (await hub());
    await w.handOver(device);
    saved();
    events.changed();
    await syncNow();
  },
  async cancelHandOver(): Promise<void> {
    const { wifi: w, saved } = (await hub());
    (await w.cancelHandOver());
    saved();
    events.changed();
  },
  /** False: this phone started the household and others are still in it. */
  async leave(): Promise<boolean> {
    const { wifi: w, saved } = (await hub());
    const left = await w.leave();
    saved();
    events.changed();
    events.done((await info()));
    return left;
  },
  async setShares(o: { tabs?: Section[]; receipts?: boolean; cards?: boolean }): Promise<void> {
    const { wifi: w, saved } = (await hub());
    if (o.tabs) (await w.setTabs(o.tabs));
    if (o.receipts !== undefined) (await w.setReceipts(o.receipts));
    if (o.cards !== undefined) (await w.setCards(o.cards));
    saved();
    events.changed();
  },
  /** Restock came to the front: listen for the other phones again (iOS stops it in the background). */
  async resumed(): Promise<void> {
    const { wifi: w } = (await hub());
    if (!(await w.joined())) return;
    await w.stop();
    await w.listen().catch(quiet('Wi-Fi sync'));
  },
  async paused(): Promise<void> {
    await (await hub()).wifi.stop();
  },
};

// ---------- 0.14.0: signing in on a computer by scanning the server page's code ----------

export const webCode = async (code: string) => {
  const w = (await (await hub()).house.webCode(code));
  return { kind: w.kind, host: w.host };
};
export const webApprove = async (code: string) => (await hub()).house.approveWeb(code);
