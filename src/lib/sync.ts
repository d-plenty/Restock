import { App } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { cachedSettings, getSettings, reapplyHouseholdSettings } from './db';
import { changed, onChange } from './live';
import { RestockNative, type SyncInfo, type SyncNowResult } from './sql/native';

// Phone-to-phone sync (0.8.0). The work is done in Java (SyncHub, SyncEngine), so it also runs
// while Restock is closed; this is the screens' side of it.

export type { SyncInfo };

/**
 * A sync pairing code, or undefined if the scanned text isn't one. 0.8.2's one-time codes are
 * RESTOCK:3:TOKEN:IP:PORT; older ones are passed on too, so the phone can say to update.
 */
export function pairingCode(text: string): string | undefined {
  const t = text.trim().replace(/\s+/g, '');
  if (/^RESTOCK:3:[A-Z2-7]{26}(:|$)/i.test(t)) return t.toUpperCase();
  return /^RESTOCK(-SYNC)?:\d+:/i.test(t) ? t : undefined;
}

/**
 * 0.9.2: a Restock server's Add a phone code (restock-server:2?h=…&a=…&i=…), or undefined. An older
 * server's code (restock-server:1) is passed on too, so the phone can say to update the server.
 */
export function serverCode(text: string): string | undefined {
  const t = text.trim();
  if (/^restock-server:1\?/i.test(t)) return t;
  if (!/[?&]i=[A-Za-z0-9_-]{20,128}(&|$)/.test(t)) return undefined;
  // 0.9.4: a v3 server's code also names the server's key (k=), so the phone pins the server from it.
  if (/^restock-server:3\?/i.test(t)) return /[?&]k=[A-Za-z0-9_+/=-]{40,200}(&|$)/.test(t) ? t : undefined;
  return /^restock-server:2\?/i.test(t) ? t : undefined;
}

/** 0.9.4: which protocol an Add a phone code is for (3: the server is the house). */
export const serverCodeVersion = (code: string): 2 | 3 => (/^restock-server:3\?/i.test(code.trim()) ? 3 : 2);

/** 0.9.4: the code on a v2 server's Take this household page (restock-handover:3?u=&t=&k=), or undefined. */
export function handoverCode(text: string): string | undefined {
  const t = text.trim();
  return /^restock-handover:3\?/i.test(t) && /[?&]t=[A-Za-z0-9_-]{20,128}(&|$)/.test(t) && /[?&]k=/.test(t) && /[?&]u=/.test(t) ? t : undefined;
}

/**
 * 0.9.2: the server addresses in an Add a phone code, as they're shown before joining ("192.168.1.10:8787"),
 * home first. Empty for a code that has none (the phone then says what's wrong).
 */
export function serverCodeAddresses(code: string): string[] {
  const q = code.trim().replace(/^restock-server:\d+\?/i, '');
  const out: string[] = [];
  for (const part of q.split('&')) {
    const eq = part.indexOf('=');
    const k = part.slice(0, eq);
    if (eq <= 0 || (k !== 'h' && k !== 'a')) continue;
    let v: string;
    try {
      v = decodeURIComponent(part.slice(eq + 1).replace(/\+/g, ' ')).trim();
    } catch {
      continue;
    }
    // Only what a person can read: no scheme, at most 100 characters, no control characters.
    v = v.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/+$/, '');
    if (!v || /[\u0000-\u001f\u007f]/.test(v)) continue;
    out[k === 'h' ? 0 : 1] = v.length > 100 ? v.slice(0, 100) + '…' : v;
  }
  return out.filter(Boolean);
}

/** 0.9.2: a code from the Restock server's web page: link the browser (restock-link:2) or sign in (restock-login:2). */
export function webPageCode(text: string): string | undefined {
  const t = text.trim();
  // 0.9.4: a v3 server's Sign in with a phone code too (restock-login:3).
  return (/^restock-(link|login):2\?/i.test(t) || /^restock-login:3\?/i.test(t)) && /[?&]s=[A-Za-z0-9_-]{8,128}(&|$)/.test(t) && /[?&]k=/.test(t) ? t : undefined;
}

/** 0.9.2: a receipt photo from the Restock server (base64 JPEG), to show. Rejects with words (offline, say). */
export async function serverPhoto(path: string): Promise<string> {
  return (await RestockNative.syncServerPhoto({ path })).data;
}

/** Local sync is for a household: up to 6 phones (SyncHousehold.MAX_PHONES). */
export const MAX_SYNC_PHONES = 6;

/**
 * 0.9.4, development only (never in a release build): a pretend sync state for looking at the sync
 * screens in a browser, from localStorage "restock-demo-sync" (a SyncInfo, plus `_joined` to open
 * the What this phone shares page). Nothing native is called with it.
 */
export function demoSync(): (SyncInfo & { _joined?: { label?: string; houseName?: string } }) | undefined {
  if (!import.meta.env.DEV || typeof localStorage === 'undefined') return undefined;
  try {
    const t = localStorage.getItem('restock-demo-sync');
    return t ? (JSON.parse(t) as SyncInfo) : undefined;
  } catch {
    return undefined;
  }
}

export const syncAvailable = () => Capacitor.isNativePlatform() || !!demoSync();

export async function syncInfo(): Promise<SyncInfo> {
  const demo = demoSync();
  if (demo) return demo;
  if (!syncAvailable()) return { paired: false, batteryExempt: false };
  return RestockNative.syncInfo();
}

/** Phone makers whose own battery savers stop apps even when Android is told not to. */
export function strictBatteryMaker(maker: string | undefined): boolean {
  return !!maker && /samsung|xiaomi|redmi|poco|oppo|realme|oneplus|vivo|huawei|honor|meizu|asus|nokia|tecno|infinix/i.test(maker);
}

let wired = false;
let applying = false;
let timer: ReturnType<typeof setTimeout> | undefined;

/** 0.9.3: how often a phone on a Restock server checks it while Restock is open. */
export const SERVER_POLL_MS = 60_000;

/**
 * 0.9.3: while Restock is open and the phone uses a Restock server, a quick check every 60 s (and
 * one when it comes back to the front): SyncHub looks at the server's list of files and only runs a
 * round when something changed there. One at a time, never during a round, nothing in the background.
 * `visible` and the timers are passed in for the tests. Returns a stop function.
 */
export function pollServer(opts: {
  usesServer: () => Promise<boolean>;
  poll: () => Promise<unknown>;
  visible: () => boolean;
  onVisible: (fn: () => void) => () => void;
  every?: number;
}): () => void {
  let busy = false;
  let stopped = false;
  const tick = async () => {
    if (busy || stopped || !opts.visible()) return;
    busy = true;
    try {
      if (await opts.usesServer()) await opts.poll();
    } catch {
      // out of reach, or Restock busy: the next check tries again
    } finally {
      busy = false;
    }
  };
  const id = setInterval(() => void tick(), opts.every ?? SERVER_POLL_MS);
  const off = opts.onVisible(() => void tick());
  return () => {
    stopped = true;
    clearInterval(id);
    off();
  };
}

/** Whether this phone uses a Restock server (asked again now and then, as it can change on the Sync screen). */
let serverKnown: { on: boolean; at: number } | undefined;
async function usesServer(): Promise<boolean> {
  if (serverKnown && Date.now() - serverKnown.at < 5 * 60_000) return serverKnown.on;
  const i = await syncInfo();
  serverKnown = { on: !!(i.paired && i.server), at: Date.now() };
  return serverKnown.on;
}

/**
 * Once at start-up: refresh screens when another phone's changes arrive, and send this phone's
 * own changes along shortly after they're made (while Restock is open). 0.9.3: check the Restock
 * server every 60 s while open, and bring the settings in line with the household's.
 */
export function wireSync(): void {
  if (wired || !Capacitor.isNativePlatform()) return;
  wired = true;
  void reapplyHouseholdSettings().catch(() => undefined);
  void RestockNative.addListener('syncChanged', () => {
    applying = true;
    serverKnown = undefined;
    const before = cachedSettings()?.recalls.enabled;
    changed();
    setTimeout(() => (applying = false), 0);
    // 0.9.3: the household turned recall alerts on or off: schedule (or stop) the daily check here.
    void getSettings()
      .then((s) => (before !== undefined && s.recalls.enabled !== before ? RestockNative.scheduleRecalls({ enabled: s.recalls.enabled }) : undefined))
      .catch(() => undefined);
  });
  pollServer({
    usesServer,
    poll: () => RestockNative.syncServerPoll(),
    visible: () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
    onVisible: (fn) => {
      const h = () => {
        if (document.visibilityState !== 'hidden') fn();
      };
      document.addEventListener('visibilitychange', h);
      const resume = App.addListener('resume', fn);
      return () => {
        document.removeEventListener('visibilitychange', h);
        void resume.then((x) => x.remove());
      };
    },
  });
  onChange(() => {
    if (applying) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void syncInfo()
        .then((i) => (i.paired ? RestockNative.syncNow() : undefined))
        .catch(() => undefined);
    }, 20_000);
  });
}

/** "Synced 3 min ago" style text. */
export function agoText(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'not yet';
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hr${h === 1 ? '' : 's'} ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}

const changes = (n: number) => (n ? `: ${n} change${n === 1 ? '' : 's'} came in` : '');

/**
 * 0.9.4: what Sync now says it did, in a few words: "Synced with your server", "Synced with Sarah's
 * phone", "Synced through your drive folder", what came in, or the first problem. It only mentions
 * the Wi-Fi's phones when Wi-Fi sync is on.
 */
export function syncNowMessage(r: SyncNowResult): string {
  const wifi = r.wifi ?? r.wifiSync ?? true;
  const done: string[] = [];
  if (r.server && r.viaServer && !r.serverError) done.push(r.serverLabel ? `your server, ${r.serverLabel}` : 'your server');
  if (wifi && r.reached > 0) done.push(r.reached === 1 ? (r.names?.[0] ?? r.peers?.[0]?.name ?? 'the other phone') : `${r.reached} phones`);
  if (r.folder && r.viaFolder && !r.folderError) done.push('your drive folder');
  if (done.length) {
    const list = done.length === 1 ? done[0] : `${done.slice(0, -1).join(', ')} and ${done[done.length - 1]}`;
    const problem = r.server && r.serverError ? ` (${r.serverError.replace(/\.$/, '')})` : '';
    return `Synced with ${list}${changes(r.received)}${problem}`;
  }
  if (r.server && r.serverError) return r.serverError;
  if (r.folder && r.folderError) return r.folderError;
  if (wifi && r.lastError) return r.lastError;
  if (!r.paired) return 'Nothing to sync yet: this phone isn\'t sharing with anyone';
  if (!wifi && !r.server && !r.folder) return 'Nothing to sync with: turn on a way to sync below';
  return 'Up to date';
}

/**
 * 0.9.4: a day and a time for the strip ("Today 6:00 am", "Yesterday 9:15 pm", "Mon 3 Nov 6:00 am"),
 * in the phone's own time zone, or "Not yet".
 */
export function dayAndTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'Not yet';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'Not yet';
  const time = d.toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit', hour12: true }).replace(/\s+/g, ' ').toLowerCase();
  const start = (t: number) => {
    const x = new Date(t);
    x.setHours(0, 0, 0, 0);
    return x.getTime();
  };
  const days = Math.round((start(now) - start(d.getTime())) / 86_400_000);
  if (days === 0) return `Today ${time}`;
  if (days === 1) return `Yesterday ${time}`;
  const day = d.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', ...(days > 300 ? { year: 'numeric' } : {}) }).replace(/,/g, '');
  return `${day} ${time}`;
}

/** 0.9.4: what this phone calls its server ("Home"), for headings. */
export const serverName = (i: SyncInfo | undefined): string => i?.serverLabel?.trim() || 'Your Restock server';
