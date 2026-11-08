import { capture } from '../lib/diagnostics';
import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { RestockNative } from '../lib/sql/native';

// All store requests go through the phone's native HTTP stack (not the WebView),
// so they look like an ordinary app request and aren't blocked by browser CORS.

export const isNative = () => Capacitor.isNativePlatform();

export class NativeOnlyError extends Error {
  constructor() {
    super('Live store prices only work in the Android app.');
    this.name = 'NativeOnlyError';
  }
}

export class BlockedError extends Error {
  constructor(store: string, detail = '') {
    super(`${store} blocked the price check${detail ? ` (${detail})` : ''}. Try again later, or add the price by hand.`);
    this.name = 'BlockedError';
  }
}

/** Coles wants a person to pass its bot check. The fix is the "Open Coles" button. */
export class ColesCheckError extends BlockedError {
  constructor() {
    super('Coles');
    this.name = 'ColesCheckError';
    this.message = COLES_CHECK_MESSAGE;
  }
}

export const COLES_CHECK_MESSAGE =
  "Coles wants to check you're a person. Tap Open Coles, let the page load (tick the box if it asks), tap Done, then try again.";

/** True for an error the "Open <store>" button might fix (from search or the native price check). */
export const isBlockMessage = (msg: string | undefined) => !!msg && /Open Coles|bot protection|blocked|person/i.test(msg);

// ---------- backup connection: the store's own page in a hidden browser ----------

export type ConnectionMode = 'auto' | 'browser';
let mode: ConnectionMode = 'auto';
/** "auto": direct requests, falling back to the hidden browser. "browser": always the hidden browser. */
export function setConnectionMode(m: ConnectionMode) {
  mode = m;
}
export const connectionMode = () => mode;

/** Make a request from inside the store's own website, the way the site itself does. */
export async function viaBrowser(
  chain: 'coles' | 'woolworths' | 'aldi' | 'danmurphys' | 'bws',
  method: 'GET' | 'POST',
  url: string,
  body?: unknown,
): Promise<HttpResult> {
  if (!isNative()) throw new NativeOnlyError();
  const r = await RestockNative.storeFetch({ chain, method, url, body: body === undefined ? undefined : JSON.stringify(body) });
  capture('browser fetch', url, r.status, r.body ?? '');
  return { status: r.status, text: r.body ?? '', headers: {} };
}

// A small cookie jar per host, because the stores hand out session cookies on their homepage.
const jar = new Map<string, Map<string, string>>();

export function splitSetCookie(header: string): string[] {
  // Split on commas that start a new "name=value" pair (Expires dates also contain commas).
  return header
    .split(/,(?=\s*[^;,=\s]+=[^;,]*)|\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function remember(host: string, headers: Record<string, string> | undefined) {
  if (!headers) return;
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() !== 'set-cookie' || !v) continue;
    const cookies = jar.get(host) ?? new Map<string, string>();
    for (const part of splitSetCookie(String(v))) {
      const pair = part.split(';')[0];
      const eq = pair.indexOf('=');
      if (eq > 0) cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
    jar.set(host, cookies);
  }
}

function cookieHeader(host: string): string | undefined {
  const cookies = jar.get(host);
  if (!cookies?.size) return undefined;
  return [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

export function clearCookies(host?: string) {
  if (host) jar.delete(host);
  else jar.clear();
}

/** An honest app identity. Some stores' bot protection rejects "Chrome" that isn't really Chrome. */
export const APP_UA = 'Restock/0.3 (Android; grocery price tracker)';

export const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36';

export interface HttpResult {
  status: number;
  text: string;
  headers: Record<string, string>;
}

export async function request(opts: {
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: unknown;
  /** How long to wait for the answer (default 20 s). */
  timeoutMs?: number;
}): Promise<HttpResult> {
  if (!isNative()) throw new NativeOnlyError();
  const host = new URL(opts.url).host;
  const headers: Record<string, string> = { 'User-Agent': MOBILE_UA, ...(opts.headers ?? {}) };
  const cookie = cookieHeader(host);
  if (cookie) headers.Cookie = cookie;
  const res = await CapacitorHttp.request({
    url: opts.url,
    method: opts.method ?? 'GET',
    headers,
    data: opts.body,
    responseType: 'text',
    connectTimeout: 15_000,
    readTimeout: opts.timeoutMs ?? 20_000,
  });
  remember(host, res.headers);
  const text = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
  capture('request', opts.url, res.status, text);
  return { status: res.status, text, headers: res.headers ?? {} };
}

/** Parse JSON, or explain that the store sent back a web page (usually bot protection). */
export function parseJson<T = unknown>(store: string, res: HttpResult): T {
  const t = res.text.trim();
  if (res.status === 403 || res.status === 429) throw new BlockedError(store, `HTTP ${res.status}`);
  if (t.startsWith('<')) throw new BlockedError(store, 'got a web page instead of data');
  if (res.status <= 0) throw new Error(`Couldn't reach ${store} just now. Check your internet, then try again.`);
  if (res.status >= 400) throw new Error(`${store} returned HTTP ${res.status}`);
  try {
    return JSON.parse(t) as T;
  } catch {
    throw new Error(`${store} sent data the app couldn't read`);
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Looks through an object for signs that a price needs a loyalty card. */
export function looksMemberOnly(...things: unknown[]): boolean {
  for (const t of things) {
    if (!t) continue;
    if (typeof t === 'string' && /member|flybuys|everyday rewards/i.test(t)) return true;
    if (typeof t === 'object') {
      for (const [k, v] of Object.entries(t as Record<string, unknown>)) {
        if (/member/i.test(k) && v === true) return true;
        if (typeof v === 'string' && /member price|members? only|flybuys member/i.test(v)) return true;
      }
    }
  }
  return false;
}

export function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const m = v.replace(/,/g, '').match(/-?\d+(\.\d+)?/);
    if (m) return parseFloat(m[0]);
  }
  return undefined;
}

/** true / false from the first stock flag a store gives; undefined when none is present. */
/**
 * A promo text worth showing ("2 for $12", "Down Down"), or nothing for a shop's internal code
 * ("PERCENT_OFF", "MULTISAVE") or a bare "Special".
 */
export function promoLabel(promo: string | undefined): string | undefined {
  const t = promo?.trim();
  if (!t || /^special$/i.test(t) || /^[A-Z0-9_]{4,}$/.test(t)) return undefined;
  return t;
}

export function stockFlag(...flags: unknown[]): boolean | undefined {
  for (const f of flags) if (typeof f === 'boolean') return f;
  return undefined;
}
