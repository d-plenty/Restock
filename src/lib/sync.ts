import { Capacitor } from '@capacitor/core';
import { changed, onChange } from './live';
import { RestockNative, type SyncInfo } from './sql/native';

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
  return /^restock-server:2\?/i.test(t) && /[?&]i=[A-Za-z0-9_-]{20,128}(&|$)/.test(t) ? t : undefined;
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
  return /^restock-(link|login):2\?/i.test(t) && /[?&]s=[A-Za-z0-9_-]{8,128}(&|$)/.test(t) && /[?&]k=/.test(t) ? t : undefined;
}

/** 0.9.2: a receipt photo from the Restock server (base64 JPEG), to show. Rejects with words (offline, say). */
export async function serverPhoto(path: string): Promise<string> {
  return (await RestockNative.syncServerPhoto({ path })).data;
}

/** Local sync is for a household: up to 6 phones (SyncHousehold.MAX_PHONES). */
export const MAX_SYNC_PHONES = 6;

export const syncAvailable = () => Capacitor.isNativePlatform();

export async function syncInfo(): Promise<SyncInfo> {
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

/**
 * Once at start-up: refresh screens when another phone's changes arrive, and send this phone's
 * own changes along shortly after they're made (while Restock is open).
 */
export function wireSync(): void {
  if (wired || !syncAvailable()) return;
  wired = true;
  void RestockNative.addListener('syncChanged', () => {
    applying = true;
    changed();
    setTimeout(() => (applying = false), 0);
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
