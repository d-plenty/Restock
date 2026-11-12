import { version } from '../../package.json';
import { isNative } from '../stores/http';
import { serverMode } from '../server-mode/flag';
import { getKV, getSettings, marketStatus, putKV, uid } from './db';
import { problems } from './diagnostics';


// 0.9.13: Settings → Feedback. A message goes to Restock's own server (the restock-prices
// collector, lib/feedback.mjs there), with up to 3 screenshots and diagnostics (on unless turned
// off), and an email only if the person wants a reply. With no connection it waits on this phone
// and goes the next time Feedback is opened or Restock starts.

export const FEEDBACK_URL = 'https://restock-prices.plenty.family/feedback';
export const FEEDBACK_KINDS = [
  { id: 'wrong', label: "Something's wrong" },
  { id: 'idea', label: 'An idea' },
  { id: 'like', label: 'Something I like' },
  { id: 'other', label: 'Other' },
] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number]['id'];

export interface Screenshot {
  type: 'image/jpeg';
  /** base64, no "data:" prefix */
  data: string;
}

export interface FeedbackMessage {
  format: 'restock-feedback';
  v: 1;
  install: string;
  kind: FeedbackKind;
  message: string;
  email?: string;
  app: string;
  platform: 'android' | 'web' | 'iphone';
  device?: string;
  screen?: string;
  diagnostics?: Record<string, unknown>;
  screenshots: Screenshot[];
}

const OUTBOX = 'feedbackOutbox';
const INSTALL = 'installId';

/** A random number for this install, only so the server can limit how much one phone sends. */
async function installId(): Promise<string> {
  const have = await getKV<string>(INSTALL);
  if (have) return have;
  const id = uid();
  await putKV(INSTALL, id);
  return id;
}

export function platform(): FeedbackMessage['platform'] {
  if (isNative()) return 'android';
  return /iPhone|iPad|iPod/.test(navigator.userAgent) ? 'iphone' : 'web';
}

/** Words that look like a password, key or token are taken out of anything sent. */
const SECRET = /(pass(word|phrase)?|key|token|secret|pin|cookie|auth)/i;
export function withoutSecrets(v: unknown, depth = 0): unknown {
  if (depth > 6) return '…';
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => withoutSecrets(x, depth + 1));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = SECRET.test(k) ? '(removed)' : withoutSecrets(x, depth + 1);
    return out;
  }
  return typeof v === 'string' && v.length > 400 ? `${v.slice(0, 400)}…` : v;
}

/**
 * What "Attach diagnostics" sends: the version, the phone, the settings (passwords, keys, tokens,
 * addresses, branches and names taken out), the last problems with shops, and how sync and shared prices are doing.
 * Never the pantry, lists, cards, receipts or prices.
 */
export async function diagnostics(): Promise<Record<string, unknown>> {
  const s = await getSettings();
  // Where you live and shop, your household's name and shop sign-ins stay out: only which shops, and whether a branch is picked.
  // The same for your own server's address and your backup folder.
  const { priceHelper, autoBackup, stores, area, household, accounts, customShops, sync, ...rest } = s;
  const out: Record<string, unknown> = {
    app: version,
    shops: Object.fromEntries(Object.entries(stores ?? {}).map(([c, v]) => [c, v?.primary || v?.storeId ? 'branch picked' : 'no branch'])),
    signedIn: Object.keys(accounts ?? {}),
    ownShops: customShops?.length ?? 0,
    homeAreaSet: !!area,
    householdNamed: !!household?.name,
    syncSettings: { mode: sync?.mode, schedule: sync?.schedule, serverSet: !!sync?.serverUrl, backgroundActivity: sync?.backgroundActivity },
    platform: platform(),
    serverMode,
    userAgent: navigator.userAgent,
    screen: typeof window === 'undefined' ? undefined : `${window.screen?.width}×${window.screen?.height} @${window.devicePixelRatio}`,
    language: navigator.language,
    settings: withoutSecrets(rest),
    priceHelper: priceHelper ? { on: priceHelper.enabled === true } : undefined,
    autoBackup: { on: autoBackup?.enabled === true },
    problems: (await problems().catch(() => [])).slice(0, 25),
  };
  try {
    const m = await marketStatus();
    out.sharedPrices = { products: m.count, updatedAt: m.updatedAt };
  } catch {
    // no market table (the web page)
  }
  if (isNative()) {
    try {
      const { syncInfo } = await import('./sync');
      const i = await syncInfo();
      out.sync = { paired: i.paired, lastSyncAt: i.lastSyncAt, lastError: i.lastError, phones: i.peers?.length, listening: i.listening };
    } catch {
      // not paired
    }
  }
  return out;
}

/** A picture from the gallery, shrunk to at most 1280 px on its longest side, as a JPEG. */
export async function shrinkPicture(file: Blob, max = 1280): Promise<Screenshot> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((ok, no) => {
      const i = new Image();
      i.onload = () => ok(i);
      i.onerror = () => no(new Error("Couldn't open that picture"));
      i.src = url;
    });
    const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.naturalWidth * k));
    c.height = Math.max(1, Math.round(img.naturalHeight * k));
    c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
    const data = c.toDataURL('image/jpeg', 0.8).split(',')[1] ?? '';
    return { type: 'image/jpeg', data };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function makeMessage(o: { kind: FeedbackKind; message: string; email?: string; withDiagnostics: boolean; screenshots: Screenshot[]; screen?: string }): Promise<FeedbackMessage> {
  return {
    format: 'restock-feedback',
    v: 1,
    install: await installId(),
    kind: o.kind,
    message: o.message.trim().slice(0, 5000),
    email: o.email?.trim() || undefined,
    app: version,
    platform: platform(),
    device: navigator.userAgent.slice(0, 120),
    screen: o.screen,
    diagnostics: o.withDiagnostics ? await diagnostics() : undefined,
    screenshots: o.screenshots.slice(0, 3),
  };
}

/** Sends one. Resolves 'sent', or 'kept' when there's no connection (it goes later). Throws when the server says no. */
export async function sendFeedback(m: FeedbackMessage, fetchImpl: typeof fetch = fetch): Promise<'sent' | 'kept'> {
  let r: Response;
  try {
    r = await fetchImpl(FEEDBACK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(m) });
  } catch {
    await keep(m);
    return 'kept';
  }
  if (r.ok) return 'sent';
  if (r.status >= 500) {
    await keep(m);
    return 'kept';
  }
  const why = await r.json().then((j: { error?: string }) => j.error).catch(() => undefined);
  throw new Error(why ?? `The feedback server said no (HTTP ${r.status})`);
}

async function keep(m: FeedbackMessage) {
  const list = (await getKV<FeedbackMessage[]>(OUTBOX)) ?? [];
  list.push(m);
  await putKV(OUTBOX, list.slice(-5));
}

/** Sends what's waiting. Returns how many went. */
export async function sendWaiting(fetchImpl: typeof fetch = fetch): Promise<number> {
  const list = (await getKV<FeedbackMessage[]>(OUTBOX)) ?? [];
  if (!list.length) return 0;
  const left: FeedbackMessage[] = [];
  let sent = 0;
  for (const m of list) {
    try {
      const r = await fetchImpl(FEEDBACK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(m) });
      if (r.ok) sent++;
      else if (r.status >= 500) left.push(m);
      // a 4xx (too many today, say) is dropped: it would never go
    } catch {
      left.push(m);
    }
  }
  await putKV(OUTBOX, left);
  return sent;
}

export async function waitingCount(): Promise<number> {
  return ((await getKV<FeedbackMessage[]>(OUTBOX)) ?? []).length;
}
