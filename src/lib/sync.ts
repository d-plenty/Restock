import { Capacitor } from '@capacitor/core';
import { changed, onChange } from './live';
import { RestockNative, type SyncInfo } from './sql/native';

// Phone-to-phone sync (0.8.0). The work is done in Java (SyncHub, SyncEngine), so it also runs
// while Restock is closed; this is the screens' side of it.

export type { SyncInfo };

/** A sync pairing code, or undefined if the scanned text isn't one. */
export function pairingCode(text: string): string | undefined {
  const t = text.trim().replace(/\s+/g, '');
  if (/^RESTOCK:\d+:[A-Z2-7]{52}(:|$)/i.test(t)) return t.toUpperCase(); // 0.8.1's short code
  return /^RESTOCK-SYNC:\d+:[A-Za-z0-9_-]{43}:/.test(t) ? t : undefined; // 0.8.0's
}

/** The household name inside a pairing code. */
export function householdIn(code: string): string {
  if (!code.startsWith('RESTOCK-SYNC:')) return ''; // the short code doesn't carry it; the first sync does
  try {
    return decodeURIComponent(code.split(':').slice(5).join(':').replace(/\+/g, ' '));
  } catch {
    return '';
  }
}

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
