// 0.9.6 (cards): the web page's cards, kept in THIS BROWSER ONLY.
//
// Loyalty and gift cards added on the web (or moved here with a cards file) live in this
// browser's own storage (IndexedDB "restock-cards-<id>", one per server and household: see
// cardsDbName), apart from the household's copy (live.ts,
// one database per web id, which goes on sign out). They're never sent to the server: nothing here
// is in the sync engine's tables, the web's own sync file, its backups or the Data tab's exports.
// They work offline once the page has loaded, like the rest of the copy.
//
// Signing out asks "Keep your cards on this browser?" (askKeepCards): kept by default on an
// iPhone's home screen app (the person's own phone), and the question is asked every time.
// 0.9.6 (review M2): cards never cross to another household or server in the same browser: each
// (server, household) has its own store, so a sign-out that never asked (a session the server ended,
// Delete everything, a session that ran out) leaves them locked away, never shown to another
// household. The next sign-in to another household asks "Keep your cards?" (askAboutOtherCards).
// iOS may clear a web app's storage when the phone is low on space; the Cards tab says so.
import type { GiftBarcodeType, GiftCard, LoyaltyCard } from '../types';
import type { CardStore } from '../lib/cardStore';
import { cleanGiftCard, cleanLoyaltyCard, MAX_PHOTO_B64 } from '../lib/giftCards';
import { strToU8 } from 'fflate';
import { sha256hex } from './crypto';
import { session as currentSession, type Session } from './session';

/** The start of every card store's name (0.9.6 test builds kept one store by this name only). */
export const CARDS_DB = 'restock-cards';
type StoreName = 'loyalty' | 'gift' | 'photos' | 'codes';
const STORES: StoreName[] = ['loyalty', 'gift', 'photos', 'codes'];

/** What the cards need of browser storage (IndexedDB below; a Map in tests). */
export interface CardsBackend {
  all(store: StoreName): Promise<{ key: string; value: unknown }[]>;
  get(store: StoreName, key: string): Promise<unknown>;
  put(store: StoreName, key: string, value: unknown): Promise<void>;
  del(store: StoreName, key: string): Promise<void>;
  /** Everything gone (the "Remove them" answer on sign out). */
  wipe(): Promise<void>;
}

export function memoryBackend(): CardsBackend {
  const m = new Map<StoreName, Map<string, unknown>>(STORES.map((s) => [s, new Map()]));
  const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));
  return {
    all: async (s) => [...m.get(s)!.entries()].map(([key, value]) => ({ key, value: clone(value) })),
    get: async (s, k) => clone(m.get(s)!.get(k)),
    put: async (s, k, v) => void m.get(s)!.set(k, clone(v)),
    del: async (s, k) => void m.get(s)!.delete(k),
    wipe: async () => STORES.forEach((s) => m.get(s)!.clear()),
  };
}

export function indexedDbBackend(name = CARDS_DB): CardsBackend {
  let opening: Promise<IDBDatabase> | undefined;
  const open = () =>
    (opening ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(name, 1);
      req.onupgradeneeded = () => STORES.forEach((s) => req.result.objectStoreNames.contains(s) || req.result.createObjectStore(s));
      req.onsuccess = () => {
        const db = req.result;
        // Another tab deleting it (Remove them): let go, and open afresh next time.
        db.onversionchange = () => {
          db.close();
          opening = undefined;
        };
        resolve(db);
      };
      req.onerror = () => {
        opening = undefined;
        reject(req.error ?? new Error("This browser won't keep cards."));
      };
      req.onblocked = () => reject(new Error("This browser won't keep cards."));
    }));
  const run = <T>(s: StoreName, mode: IDBTransactionMode, fn: (st: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> =>
    open().then(
      (db) =>
        new Promise<T | undefined>((resolve, reject) => {
          const tx = db.transaction(s, mode);
          const req = fn(tx.objectStore(s));
          tx.oncomplete = () => resolve(req ? req.result : undefined);
          tx.onerror = tx.onabort = () => reject(tx.error ?? new Error("Couldn't keep that in this browser."));
        }),
    );
  return {
    async all(s) {
      // One transaction, so keys and values always match.
      const out: { key: string; value: unknown }[] = [];
      await run(s, 'readonly', (st) => {
        const cur = st.openCursor();
        cur.onsuccess = () => {
          const c = cur.result;
          if (!c) return;
          out.push({ key: String(c.key), value: c.value });
          c.continue();
        };
      });
      return out;
    },
    get: (s, k) => run(s, 'readonly', (st) => st.get(k)),
    put: async (s, k, v) => void (await run(s, 'readwrite', (st) => st.put(v, k))),
    del: async (s, k) => void (await run(s, 'readwrite', (st) => st.delete(k))),
    async wipe() {
      const db = await open().catch(() => undefined);
      db?.close();
      opening = undefined;
      await new Promise<void>((res) => {
        try {
          const r = indexedDB.deleteDatabase(name);
          r.onsuccess = r.onerror = r.onblocked = () => res();
        } catch {
          res();
        }
      });
    },
  };
}

const PHOTO_KEY = /^([A-Za-z0-9_-]{1,80}):(front|back)$/;

export interface BrowserCards extends CardStore {
  /** How many cards this browser keeps (for the sign-out question). */
  count(): Promise<number>;
  /** Takes every card (and photo) off this browser. */
  removeAll(): Promise<void>;
}

/** This browser's cards, on a storage backend. */
export function browserCards(backend: CardsBackend, channelName = CARDS_DB): BrowserCards {
  const subs = new Set<() => void>();
  // Other tabs of this browser hear about changes too.
  let channel: BroadcastChannel | undefined;
  try {
    channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(channelName) : undefined;
    if (channel) channel.onmessage = () => subs.forEach((f) => f());
  } catch {
    channel = undefined;
  }
  const changed = () => {
    subs.forEach((f) => f());
    try {
      channel?.postMessage('changed');
    } catch {
      // fine
    }
  };
  const byDate = <T extends { createdAt: string }>(a: T, b: T) => a.createdAt.localeCompare(b.createdAt);
  const self: BrowserCards = {
    where: 'browser',
    async loyalty() {
      return (await backend.all('loyalty'))
        .map((r) => cleanLoyaltyCard(r.value))
        .filter((c): c is LoyaltyCard => !!c)
        .sort(byDate);
    },
    async addLoyalty(c) {
      const clean = cleanLoyaltyCard(c);
      if (!clean) throw new Error("That card can't be kept.");
      await backend.put('loyalty', clean.id, clean);
      changed();
    },
    async removeLoyalty(id) {
      await backend.del('loyalty', id);
      changed();
    },
    async gifts() {
      return (await backend.all('gift'))
        .map((r) => cleanGiftCard(r.value))
        .filter((c): c is GiftCard => !!c)
        .sort(byDate);
    },
    async saveGift(g) {
      const clean = cleanGiftCard(g);
      if (!clean) throw new Error("That card can't be kept.");
      await backend.put('gift', clean.id, clean);
      changed();
    },
    async removeGift(g) {
      for (const p of [g.photoFront, g.photoBack]) if (p) await backend.del('photos', p);
      await backend.del('gift', g.id);
      changed();
    },
    async readPhoto(path) {
      if (!path || !PHOTO_KEY.test(path)) return undefined;
      const v = await backend.get('photos', path).catch(() => undefined);
      return typeof v === 'string' ? v : undefined;
    },
    async writePhoto(cardId, side, base64) {
      const key = `${cardId}:${side}`;
      if (!PHOTO_KEY.test(key) || base64.length > MAX_PHOTO_B64) throw new Error('That photo is too big.');
      await backend.put('photos', key, base64);
      return key;
    },
    async deletePhoto(path) {
      if (path && PHOTO_KEY.test(path)) await backend.del('photos', path);
    },
    onChange(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    canRemind: false,
    undoable: false,
    // 0.10.3: the barcode kind picked for each loyalty card, in this browser (with the drawn codes).
    async codeTypes() {
      const v = await backend.get('codes', 'types:loyalty').catch(() => undefined);
      try {
        return typeof v === 'string' ? (JSON.parse(v) as Partial<Record<string, GiftBarcodeType>>) : {};
      } catch {
        return {};
      }
    },
    async setCodeType(id, type) {
      const now = await this.codeTypes!();
      await backend.put('codes', 'types:loyalty', JSON.stringify({ ...now, [id]: type })).catch(() => undefined);
    },
    codeCache: {
      async get(key) {
        const v = await backend.get('codes', key).catch(() => undefined);
        return typeof v === 'string' ? v : undefined;
      },
      async set(key, svg) {
        if (svg.length < 400_000) await backend.put('codes', key, svg).catch(() => undefined);
      },
    },
    async count() {
      const [l, g] = await Promise.all([backend.all('loyalty'), backend.all('gift')]);
      return l.length + g.length;
    },
    async removeAll() {
      await backend.wipe();
      changed();
    },
  };
  return self;
}

// ---------- one store per server and household (review M2) ----------

/** Which household a session is of: its owner key (a new household, after Delete everything, has another). */
export function householdIdOf(s: Pick<Session, 'ownerPub' | 'household' | 'webId'>): string {
  if (s.ownerPub) return `owner:${s.ownerPub}`;
  if (s.household) return `name:${s.household}`;
  return `web:${s.webId}`;
}

/** The card store's name for this server (origin) and household. */
export function cardsDbName(origin: string, householdId: string): string {
  return `${CARDS_DB}-${sha256hex(strToU8(`${origin}\n${householdId}`)).slice(0, 32)}`;
}

/** What this browser remembers of its card stores (no card details: just where they are from). */
export interface CardsPlace {
  origin: string;
  /** The household's name, for the question. */
  household?: string;
  /** When it was last opened. */
  at: string;
  /** The sign-in (session id) the "Keep your cards?" question was last answered for. */
  askedFor?: string;
}
export interface PlacesStore {
  read(): Record<string, CardsPlace>;
  write(v: Record<string, CardsPlace>): void;
}
const PLACES_KEY = 'restock-cards-places';
export const localPlaces = (): PlacesStore => ({
  read() {
    try {
      const v = JSON.parse(localStorage.getItem(PLACES_KEY) ?? '{}') as unknown;
      return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, CardsPlace>) : {};
    } catch {
      return {};
    }
  },
  write(v) {
    try {
      localStorage.setItem(PLACES_KEY, JSON.stringify(v));
    } catch {
      // private mode: nothing remembered
    }
  },
});
export function memoryPlaces(): PlacesStore {
  let m: Record<string, CardsPlace> = {};
  return { read: () => JSON.parse(JSON.stringify(m)) as Record<string, CardsPlace>, write: (v) => void (m = JSON.parse(JSON.stringify(v)) as Record<string, CardsPlace>) };
}

function notePlace(places: PlacesStore, name: string, p: Omit<CardsPlace, 'at'>) {
  const all = places.read();
  all[name] = { ...all[name], ...p, at: new Date().toISOString() };
  places.write(all);
}
function forgetPlace(places: PlacesStore, name: string) {
  const all = places.read();
  if (!(name in all)) return;
  delete all[name];
  places.write(all);
}

export interface CardsDeps {
  places?: PlacesStore;
  backendOf?: (name: string) => CardsBackend;
  origin?: string;
}

const opened = new Map<string, BrowserCards>();
/** No one signed in: an empty store that keeps nothing (cards are never shown before sign-in). */
let nobody: BrowserCards | undefined;

/**
 * This browser's cards for the signed-in session's server and household (IndexedDB). Another
 * household, or another server, on this browser never sees them. With no session: none.
 */
export function thisBrowserCards(s: Pick<Session, 'ownerPub' | 'household' | 'webId'> | undefined = currentSession(), deps: CardsDeps = {}): BrowserCards {
  if (!s) return (nobody ??= browserCards(memoryBackend(), `${CARDS_DB}-nobody`));
  const origin = deps.origin ?? (typeof location !== 'undefined' ? location.origin : '');
  const places = deps.places ?? localPlaces();
  const name = cardsDbName(origin, householdIdOf(s));
  notePlace(places, name, { origin, household: s.household });
  const known = deps.backendOf ? undefined : opened.get(name);
  if (known) return known;
  const store = browserCards((deps.backendOf ?? indexedDbBackend)(name), name);
  const wipe = store.removeAll;
  store.removeAll = async () => {
    await wipe();
    forgetPlace(places, name);
  };
  if (!deps.backendOf) opened.set(name, store);
  return store;
}

/**
 * At sign-in: this browser still keeps cards from a sign-in to another household or server (a
 * sign-out that never asked: the server ended the session, Delete everything, it ran out). They
 * are never shown here. Asks once per sign-in: "Keep your cards?" Keep (for when that household
 * signs in here again) or Remove them. Returns what was done.
 */
export async function askAboutOtherCards(
  ask: Ask,
  s: Pick<Session, 'ownerPub' | 'household' | 'webId' | 'sid'>,
  deps: CardsDeps = {},
  homeScreen = isHomeScreenApp(),
): Promise<'none' | 'keep' | 'remove' | 'later'> {
  const origin = deps.origin ?? (typeof location !== 'undefined' ? location.origin : '');
  const places = deps.places ?? localPlaces();
  const backendOf = deps.backendOf ?? indexedDbBackend;
  const here = cardsDbName(origin, householdIdOf(s));
  const ask1 = s.sid ?? s.webId;
  const others: { name: string; cards: BrowserCards; n: number }[] = [];
  for (const [name, p] of Object.entries(places.read())) {
    if (name === here || !name.startsWith(`${CARDS_DB}-`) || p.askedFor === ask1) continue;
    const cards = browserCards(backendOf(name), name);
    const n = await cards.count().catch(() => 0);
    if (n) others.push({ name, cards, n });
    else forgetPlace(places, name);
  }
  if (!others.length) return 'none';
  const n = others.reduce((a, o) => a + o.n, 0);
  const where = homeScreen ? 'this phone' : 'this browser';
  const got = await ask(
    'Keep your cards?',
    `${n === 1 ? 'One card' : `${n} cards`} from an earlier sign-in to another household or server ${n === 1 ? 'is' : 'are'} kept on ${where}. ${n === 1 ? 'It isn’t' : 'They aren’t'} shown here. Keep ${n === 1 ? 'it' : 'them'} for when that household signs in here again, or remove ${n === 1 ? 'it' : 'them'} if ${n === 1 ? 'it isn’t' : 'they aren’t'} yours.`,
    homeScreen
      ? [
          { id: 'keep', label: 'Keep them', kind: 'primary' },
          { id: 'remove', label: 'Remove them', kind: 'danger' },
        ]
      : [
          { id: 'remove', label: 'Remove them', kind: 'primary' },
          { id: 'keep', label: 'Keep them' },
        ],
  );
  if (got === 'remove') {
    for (const o of others) {
      await o.cards.removeAll().catch(() => undefined);
      forgetPlace(places, o.name);
    }
    return 'remove';
  }
  if (got !== 'keep') return 'later';
  const all = places.read();
  for (const o of others) if (all[o.name]) all[o.name].askedFor = ask1;
  places.write(all);
  return 'keep';
}

/** On an iPhone's (or Android's) home screen: the person's own phone, so cards are kept by default. */
export function isHomeScreenApp(): boolean {
  try {
    if ((navigator as Navigator & { standalone?: boolean }).standalone) return true;
    return typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches;
  } catch {
    return false;
  }
}

/**
 * Signing out: "Keep your cards on this phone/browser?" Asked whenever this browser keeps cards.
 * On a home screen app (the person's own phone) Keep is the first answer; in a browser (perhaps a
 * shared computer) Remove is. Closing the question stays signed in.
 */
export type Ask = (title: string, detail: string, choices: { id: string; label: string; kind?: 'primary' | 'danger' }[]) => Promise<string | undefined>;

export async function askKeepCards(ask: Ask, cards: Pick<BrowserCards, 'count'> = thisBrowserCards(), homeScreen = isHomeScreenApp()): Promise<'keep' | 'remove' | 'stay'> {
  const n = await cards.count().catch(() => 0);
  if (!n) return 'keep';
  const where = homeScreen ? 'this phone' : 'this browser';
  const label = { keep: `Keep them on ${where}`, remove: 'Remove them', stay: 'Stay signed in' };
  const choices: Parameters<Ask>[2] = homeScreen
    ? [
        { id: 'keep', label: label.keep, kind: 'primary' },
        { id: 'remove', label: label.remove, kind: 'danger' },
        { id: 'stay', label: label.stay },
      ]
    : [
        { id: 'remove', label: label.remove, kind: 'primary' },
        { id: 'keep', label: label.keep },
        { id: 'stay', label: label.stay },
      ];
  const got = await ask(
    `Keep your cards on ${where}?`,
    `${n === 1 ? 'One card is' : `${n} cards are`} kept only in this browser; they are not sent to the server. Kept, ${n === 1 ? 'it shows' : 'they show'} again only when this household signs back in here; never to another household. ${homeScreen ? 'Remove them if this phone is going to someone else.' : 'Remove them if other people use this computer.'}`,
    choices,
  );
  return got === 'keep' || got === 'remove' ? got : 'stay';
}
