// Server mode: the Restock server's API, as a signed-in browser uses it (docs/server-protocol.md).
//
// - v2 (a 0.9.3 server, or a 0.9.4 server still in `v2` mode): the session is an HttpOnly cookie
//   the browser sends by itself; nothing here keeps a token.
// - v3 (0.9.4, the server is the household's owner): every request carries
//   `Authorization: RestockWeb3 s=, t=, n=, m=` (an HMAC with the session's own key, so no cookie
//   and no CSRF), answers with household data come sealed with that key (RSF1,
//   `application/x-restock-sealed`), and request bodies with secrets go sealed the same way.

import { openRsf1, sealRsf1, unb64, webAuthorization } from './crypto';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Where the API lives: the page's own server (the app is served from it). */
let base = '';
export const setApiBase = (b: string) => (base = b.replace(/\/+$/, ''));

export const SEALED = 'application/x-restock-sealed';

/** The v3 session this tab signs its requests with (undefined: v2, or signed out). */
interface V3Auth {
  session: string;
  key: Uint8Array;
}
let v3: V3Auth | undefined;
/** The server's clock minus ours, learnt from a `clock` refusal (as the phones do). */
let skew = 0;
export function setV3Auth(a: { session: string; key: Uint8Array } | undefined): void {
  v3 = a;
}
export const hasV3Auth = () => !!v3;

/** What the server said about itself (GET /api/v3/health; a 0.9.3 server has no such path). */
export interface ServerInfo {
  /** 2: a 0.9.3 server, or a 0.9.4 one in v2 mode for browsers; 3: a house. */
  api: 2 | 3;
  /** 0.9.4 servers: 'new' (not set up), 'v2' (a phone household on it, before the handover), 'v3', 'released'. */
  mode?: 'new' | 'v2' | 'v3' | 'released' | string;
  version?: string;
  house?: string;
}
let info: ServerInfo | undefined;
export const serverInfo = () => info;
/** Is this a house (a v3 server, set up or not)? Then sign-in, files and the server's pages are v3. */
export const isV3 = () => !!info && info.api === 3 && info.mode !== 'v2';
export const setServerInfo = (i: ServerInfo | undefined) => (info = i);

function words(status: number, code: string): string {
  if (status === 429) return 'Too many tries. Wait 15 minutes and try again.';
  if (status === 401 && code === 'wrong') return "That user name or passphrase isn't right.";
  if (status === 401) return 'Signed out. Sign in again.';
  if (status === 403) return "This browser isn't allowed to do that.";
  if (status === 413) return 'That file is too big for the server.';
  if (status === 507) return 'The server is full.';
  return `The server answered ${status}${code ? ` (${code})` : ''}.`;
}

const enc = new TextEncoder();

interface CallOpts {
  /** v3: seal the JSON body with the session key. */
  seal?: boolean;
  /** Don't treat a 401 as "signed out" (a wrong passphrase on sign-in, say). */
  quiet401?: boolean;
}

/** The request target exactly as sent (what the MAC covers). */
const targetOf = (path: string) => {
  if (!base) return path;
  const u = new URL(base + path, typeof location !== 'undefined' ? location.href : 'http://x/');
  return u.pathname + u.search;
};

async function call(method: string, path: string, body?: unknown, raw?: Uint8Array, extra?: Record<string, string>, opts: CallOpts = {}, retried = false): Promise<Response> {
  let bytes: Uint8Array | undefined = raw;
  let type: string | undefined = raw ? 'application/octet-stream' : undefined;
  if (!raw && body !== undefined) {
    if (opts.seal) {
      if (!v3) throw new ApiError(401, 'signed-out', 'Signed out. Sign in again.');
      bytes = sealRsf1(v3.key, body);
      type = SEALED;
    } else {
      bytes = enc.encode(JSON.stringify(body));
      type = 'application/json';
    }
  }
  const headers: Record<string, string> = { ...(type ? { 'Content-Type': type } : {}), ...extra };
  if (v3 && path.startsWith('/api/v3/')) headers.Authorization = webAuthorization(v3.session, v3.key, method, targetOf(path), bytes ?? null, Date.now() + skew);
  let r: Response;
  try {
    r = await fetch(base + path, { method, cache: 'no-store', credentials: 'same-origin', headers, body: bytes as BodyInit | undefined });
  } catch {
    throw new ApiError(0, 'offline', "Can't reach your Restock server. Check you're on the same network, or its away address.");
  }
  if (!r.ok) {
    const j = (await r
      .clone()
      .json()
      .catch(() => ({}))) as { error?: string; message?: string };
    const code = typeof j.error === 'string' ? j.error : '';
    // This computer's clock is out: once more with the server's (the MAC covers the time).
    if (r.status === 401 && code === 'clock' && !retried) {
      const t = Number(r.headers.get('X-Restock-Time'));
      if (Number.isFinite(t) && t > 0) {
        skew = t - Date.now();
        return call(method, path, body, raw, extra, opts, true);
      }
    }
    if (r.status === 401 && !opts.quiet401) onSignedOut?.();
    throw new ApiError(r.status, code, typeof j.message === 'string' ? j.message : words(r.status, code));
  }
  return r;
}

let onSignedOut: (() => void) | undefined;
/** Called when the server says the session is gone (expired, or signed out everywhere). */
export const whenSignedOut = (fn: () => void) => (onSignedOut = fn);

const json = async <T>(r: Promise<Response>): Promise<T> => (await (await r).json().catch(() => ({}))) as T;

/** A v3 answer: sealed with the session key, or plain JSON (answers without household data). */
async function answer<T>(r: Promise<Response>): Promise<T> {
  const res = await r;
  if ((res.headers.get('Content-Type') ?? '').includes(SEALED)) {
    if (!v3) throw new ApiError(401, 'signed-out', 'Signed out. Sign in again.');
    try {
      return openRsf1<T>(v3.key, new Uint8Array(await res.arrayBuffer()));
    } catch {
      throw new ApiError(0, 'sealed', "The server's answer didn't open with this browser's key. Sign in again.");
    }
  }
  return (await res.json().catch(() => ({}))) as T;
}

/** An array that's either the answer itself or one field of it. */
const listOf = <T>(v: unknown, field: string): T[] => (Array.isArray(v) ? (v as T[]) : v && typeof v === 'object' && Array.isArray((v as Record<string, unknown>)[field]) ? ((v as Record<string, unknown>)[field] as T[]) : []);

export interface FileInfo {
  name: string;
  size: number;
  modified?: string;
  version?: string;
  by?: string;
}

export interface Device {
  device: string;
  name?: string;
  added?: string;
  seen?: string;
  lastSeen?: string;
}

export interface Activity {
  at: string;
  who?: string;
  by?: string;
  device?: string;
  what: string;
  file?: string;
  size?: number;
  ip?: string;
  /** v3 (srv_log): 'activity' or a log's kind ('merge', 'ha', 'error', …). */
  kind?: string;
  detail?: string | Record<string, unknown>;
}

export interface WebInfo {
  user?: string;
  webId?: string | null;
  webPub?: string | null;
  mustChange?: boolean;
}

export const api = {
  health: () => json<{ ok?: boolean; app?: string; version?: string; api?: number }>(call('GET', '/api/v2/health')),
  salt: (user: string) => json<{ salt: string }>(call('GET', `/api/v2/login/salt?user=${encodeURIComponent(user)}`)),
  login: (body: { user: string; password?: string; auth?: string }) =>
    json<{ mustChange?: boolean; vault?: string | null }>(call('POST', '/api/v2/login', body, undefined, undefined, { quiet401: true })),
  logout: (everywhere = false) => call('POST', '/api/v2/logout', everywhere ? { everywhere: true } : {}),
  /** `current`: the current passphrase's authKey (needed once a passphrase is set). */
  setPassphrase: (body: { salt: string; auth: string; vault: string; webId: string; webPub: string; current?: string }) => call('POST', '/api/v2/passphrase', body),
  getVault: () => json<{ vault?: string | null }>(call('GET', '/api/v2/vault')),
  putVault: (body: { vault: string; webId: string; webPub: string }) => call('PUT', '/api/v2/vault', body),
  web: () => json<WebInfo>(call('GET', '/api/v2/web')),
  invite: () => json<{ invite: string; expires?: string | number; expiresIn?: number; code?: string; home?: string; away?: string }>(call('POST', '/api/v2/invites', {})),
  devices: async () => (await json<{ devices?: Device[] }>(call('GET', '/api/v2/devices'))).devices ?? [],
  removeDevice: (id: string) => call('DELETE', `/api/v2/devices/${encodeURIComponent(id)}`),
  linkStart: () => json<{ id: string }>(call('POST', '/api/v2/link', {})),
  linkPoll: (id: string) => json<{ pending?: boolean; pub?: string; sealed?: string }>(call('GET', `/api/v2/link/${encodeURIComponent(id)}`)),
  qrStart: () => json<{ id: string }>(call('POST', '/api/v2/qrlogin', {})),
  qrPoll: (id: string) => json<{ pending?: boolean; pub?: string; sealed?: string; mustChange?: boolean }>(call('GET', `/api/v2/qrlogin/${encodeURIComponent(id)}`)),
  files: async () => (await json<{ files?: FileInfo[] }>(call('GET', '/api/v2/files'))).files ?? [],
  /** A file's bytes, or null when it isn't there. Names go in the path as they are (slashes too). */
  read: async (name: string): Promise<Uint8Array | null> => {
    try {
      return new Uint8Array(await (await call('GET', `/api/v2/files/${name}`)).arrayBuffer());
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return null;
      throw e;
    }
  },
  write: (name: string, bytes: Uint8Array, ifMatch?: string) =>
    json<{ name?: string; size?: number; version?: string }>(call('PUT', `/api/v2/files/${name}`, undefined, bytes, ifMatch ? { 'If-Match': `"${ifMatch}"` } : undefined)),
  activity: async () => (await json<{ activity?: Activity[] }>(call('GET', '/api/v2/activity'))).activity ?? [],
};

/**
 * What the server is: GET /api/v3/health (0.9.4). A 0.9.3 server answers 404 there, and is a v2
 * server for everything. Kept for the rest of the page (isV3, serverInfo).
 */
export async function probeServer(): Promise<ServerInfo> {
  try {
    const h = await json<{ ok?: boolean; version?: string; api?: number; mode?: string; house?: string }>(call('GET', '/api/v3/health', undefined, undefined, undefined, { quiet401: true }));
    info = { api: h.api === 3 ? 3 : 2, mode: h.mode, version: h.version, house: h.house };
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 405 || e.status === 410)) info = { api: 2 };
    else throw e;
  }
  return info;
}

// ---------- v3 (0.9.4): a house ----------

/** What the login (and setup, and GET /api/v3/session) answer's `sealed` opens to. */
export interface SessionGift {
  keys?: Record<string, string>;
  keyv?: number;
  webId?: string;
  household?: { name?: string; owner_pub?: string } | null;
  user?: string;
  kind?: 'passphrase' | 'phone' | string;
  expires?: string | number;
  mode?: string;
}

export type PhoneStatus = 'active' | 'removed' | 'left' | string;

export interface Shares {
  tabs?: string[];
  receipts?: boolean;
  cards?: boolean;
}

export interface Phone {
  device: string;
  /** The name the admin gave it on the server ("Sister's phone"). */
  label?: string;
  /** The name the phone calls itself. */
  name?: string;
  status?: PhoneStatus;
  statusAt?: string;
  added?: string;
  lastSeen?: string;
  version?: string;
  shares?: Shares | null;
  /** 2: still on its v2 key (Restock 0.9.3, or not upgraded yet). */
  api?: number;
}

export interface Browser {
  id: string;
  kind?: 'passphrase' | 'phone' | string;
  label?: string;
  created?: string;
  lastUsed?: string;
  expires?: string | number;
  current?: boolean;
}

export interface HouseSettings {
  name?: string;
  /** 3, 6, 9, 12, or null for Until I delete. */
  keepMonths?: number | null;
}

export interface HaConfig {
  address?: string;
  entity?: string;
  enabled?: boolean;
  /** Is a token saved? (The token itself is never sent back.) */
  hasToken?: boolean;
  lastAt?: string;
  lastError?: string;
  /** Home Assistant still runs on a phone (0.9.3), so the server waits: its id and name. */
  phone?: string;
  phoneName?: string;
  phoneApi?: number | null;
  /** The admin ticked "It's off on <phone>": that phone's id. */
  offOn?: string | null;
  /** Why the server isn't running it now (off, no token, a 0.9.3 phone still runs it), or null. */
  blocked?: string | null;
}

export interface HistoryRow {
  product_id?: string;
  productId?: string;
  date: string;
  price: number;
  was_price?: number | null;
  wasPrice?: number | null;
  is_special?: number | boolean;
  isSpecial?: boolean;
  member_only?: number | boolean;
  memberOnly?: boolean;
  promo?: string | null;
}

/**
 * 0.9.4: the passphrase again, for the dangerous admin actions (the recovery key, the backup,
 * deleting data, Remove a phone): HMAC(loginKey, "restock-login-v3\n" + c + "\n" + session id)
 * over a fresh challenge `c` (session.ts confirmPassphrase).
 */
export interface Confirm {
  c: string;
  proof: string;
}

const v3get = <T>(path: string) => answer<T>(call('GET', path));
const v3send = <T>(method: string, path: string, body?: unknown, seal = false) => answer<T>(call(method, path, body ?? {}, undefined, undefined, { seal }));
const enc3 = encodeURIComponent;

export const api3 = {
  challenge: (user: string) => json<{ salt: string; c: string; kex: string; setup?: boolean }>(call('GET', `/api/v3/login/challenge?user=${enc3(user)}`)),
  login: (body: { user: string; c: string; epub: string; proof: string }) =>
    json<{ session: string; expires?: string | number; sealed: string }>(call('POST', '/api/v3/login', body, undefined, undefined, { quiet401: true })),
  logout: (everywhere = false) => call('POST', '/api/v3/logout', everywhere ? { everywhere: true } : {}),
  /** This session's keys again (after a rekey, or setting up the house). Null when the server has no such path. */
  session: async (): Promise<SessionGift | null> => {
    try {
      return await v3get<SessionGift>('/api/v3/session');
    } catch (e) {
      if (e instanceof ApiError && (e.status === 404 || e.status === 405)) return null;
      throw e;
    }
  },
  setup: (name: string) => v3send<SessionGift & { ok?: boolean }>('POST', '/api/v3/setup', { name }),
  qrStart: (epub: string) => json<{ id: string; kex: string; expires?: string | number }>(call('POST', '/api/v3/qrlogin', { epub })),
  qrPoll: (id: string) => json<{ pending?: boolean; status?: string; session?: string; expires?: string | number; sealed?: string }>(call('GET', `/api/v3/qrlogin/${enc3(id)}`)),

  phones: async () => listOf<Phone>(await v3get<unknown>('/api/v3/phones'), 'phones'),
  addPhone: (label: string) => v3send<{ code: string; expires?: string | number; expiresIn?: number }>('POST', '/api/v3/phones', { label }),
  renamePhone: (device: string, label: string) => v3send<unknown>('PATCH', `/api/v3/phones/${enc3(device)}`, { label }),
  /** Remove needs the passphrase again (`confirm`, session.ts confirmPassphrase). */
  removePhone: (device: string, confirm: Confirm) => answer<unknown>(call('DELETE', `/api/v3/phones/${enc3(device)}`, { confirm })),
  browsers: async () => listOf<Browser>(await v3get<unknown>('/api/v3/browsers'), 'browsers'),
  endBrowser: (id: string) => answer<unknown>(call('DELETE', `/api/v3/browsers/${enc3(id)}`)),

  settings: () => v3get<HouseSettings>('/api/v3/settings'),
  /** Keeping less (data is deleted) needs the passphrase again: `confirm`. */
  putSettings: (s: HouseSettings, confirm?: Confirm) => v3send<HouseSettings>('PUT', '/api/v3/settings', confirm ? { ...s, confirm } : s),
  prune: (before: string, confirm: Confirm) => v3send<{ prices?: number; receipts?: number }>('POST', '/api/v3/prune', { before, confirm }),
  passphrase: (body: { c: string; proof: string; salt: string; auth: string }) => v3send<SessionGift & { session?: string; sealed?: string }>('POST', '/api/v3/passphrase', body, true),
  /** The recovery key: only with the passphrase again (`confirm`). */
  recovery: (confirm: Confirm) => v3send<{ recovery?: string; key?: string; saved?: boolean }>('POST', '/api/v3/recovery', { confirm }),
  /** The encrypted backup: its bytes and the name the server gave it (the sign-in passphrase again: `confirm`). */
  backup: async (passphrase: string, confirm: Confirm): Promise<{ bytes: Uint8Array; name?: string }> => {
    const r = await call('POST', '/api/v3/backup', { passphrase, confirm }, undefined, undefined, { seal: true });
    const cd = r.headers.get('Content-Disposition') ?? '';
    const name = /filename="?([^";]+)"?/i.exec(cd)?.[1];
    return { bytes: new Uint8Array(await r.arrayBuffer()), name };
  },
  activity: async (limit = 200) => listOf<Activity>(await v3get<unknown>(`/api/v3/activity?limit=${limit}`), 'activity'),
  logs: async (limit = 200) => listOf<Activity>(await v3get<unknown>(`/api/v3/logs?limit=${limit}`), 'logs'),
  homeAssistant: () => v3get<HaConfig>('/api/v3/homeassistant'),
  /** Sealed: it may carry the token. */
  putHomeAssistant: (c: HaConfig & { token?: string }) => v3send<HaConfig>('PUT', '/api/v3/homeassistant', c, true),
  testHomeAssistant: (c?: HaConfig & { token?: string }) =>
    v3send<{ ok?: boolean; message?: string; lists?: { entity: string; name?: string }[] }>('POST', '/api/v3/homeassistant/test', c ?? {}, true),
  syncHomeAssistant: () => v3send<{ ok?: boolean; message?: string }>('POST', '/api/v3/homeassistant/sync', {}),
  history: async (product: string, from: string) => listOf<HistoryRow>(await v3get<unknown>(`/api/v3/history?product=${enc3(product)}&from=${enc3(from)}`), 'prices'),
  /** Per month (oldest first, every month in the window): receipt totals per tab, receipts, products with a price, specials seen. */
  stats: (months = 12) =>
    v3get<{ months?: { month: string; receipts?: Record<string, number>; receiptCount?: number; productsTracked?: number; specialsSeen?: number }[] }>(`/api/v3/stats?months=${months}`),
  /** v2 mode only: the code the owner phone scans to hand the household to the server. */
  handover: () => json<{ token: string; code?: string; kex?: string; expires?: string | number }>(call('POST', '/api/v3/handover', {})),

  files: async () => listOf<FileInfo>(await answer<unknown>(call('GET', '/api/v3/files')), 'files'),
  read: async (name: string): Promise<Uint8Array | null> => {
    try {
      return new Uint8Array(await (await call('GET', `/api/v3/files/${name}`)).arrayBuffer());
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return null;
      throw e;
    }
  },
  write: (name: string, bytes: Uint8Array, ifMatch?: string) =>
    answer<{ name?: string; size?: number; version?: string }>(call('PUT', `/api/v3/files/${name}`, undefined, bytes, ifMatch ? { 'If-Match': `"${ifMatch}"` } : undefined)),
};

/** For tests: the session key a request is signed with, from base64url. */
export const v3AuthOf = (session: string, key: string) => ({ session, key: unb64(key) });
