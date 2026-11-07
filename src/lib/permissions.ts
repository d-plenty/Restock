import { Capacitor } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';
import { RestockNative } from './sql/native';

export type PermKey = 'notifications' | 'alarms' | 'camera' | 'location';
export type PermStatus = 'granted' | 'denied' | 'prompt' | 'unsupported';

export const PERMISSIONS: { key: PermKey; title: string; why: string; icon: string }[] = [
  {
    key: 'notifications',
    title: 'Notifications',
    why: 'Catalogue-day roundups, and a heads-up when something you buy is on a good sale.',
    icon: 'bell',
  },
  {
    key: 'alarms',
    title: 'Alarms & reminders',
    why: 'Lets catalogue-day and daily reminders arrive right on time, even while the phone is asleep. Android opens a settings page: turn on "Allow setting alarms and reminders", then come back.',
    icon: 'bell',
  },
  {
    key: 'camera',
    title: 'Camera',
    why: 'Scan barcodes and QR codes to add products. The camera is only on while the scanner is open, and the picture never leaves your phone.',
    icon: 'scan',
  },
  {
    key: 'location',
    title: 'Location (approximate)',
    why: 'Finds your nearest Coles, Woolworths and Aldi. Only used when you tap "Use my location", never in the background. Your rough position goes to OpenStreetMap just to look up nearby supermarkets.',
    icon: 'pin',
  },
];

const native = () => Capacitor.isNativePlatform();

function norm(s: string | undefined): PermStatus {
  if (s === 'granted') return 'granted';
  if (s === 'denied') return 'denied';
  return 'prompt';
}

/** Resolves to `fallback` if a bridge call never answers, so a permission prompt can't hang the app. */
function within<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(fallback), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      () => {
        clearTimeout(t);
        resolve(fallback);
      },
    );
  });
}

export async function checkAll(): Promise<Record<PermKey, PermStatus>> {
  if (!native()) return { notifications: 'unsupported', alarms: 'unsupported', camera: 'unsupported', location: 'unsupported' };
  const [n, a, p] = await Promise.all([
    within(LocalNotifications.checkPermissions(), 5000, { display: 'prompt' as const }),
    within(LocalNotifications.checkExactNotificationSetting(), 5000, { exact_alarm: 'prompt' as const }),
    within(RestockNative.checkPermissions(), 5000, { camera: 'prompt' as const, location: 'prompt' as const }),
  ]);
  // Exact alarms are a settings switch, never a dialog: "denied" just means it's off, so offer Allow.
  const alarms = a.exact_alarm === 'granted' ? 'granted' : 'prompt';
  return { notifications: norm(n.display), alarms, camera: norm(p.camera), location: norm(p.location) };
}

export async function request(key: PermKey): Promise<PermStatus> {
  if (!native()) return 'unsupported';
  if (key === 'alarms') {
    const r = await within(LocalNotifications.changeExactNotificationSetting(), 120_000, { exact_alarm: 'prompt' as const });
    return r.exact_alarm === 'granted' ? 'granted' : 'prompt';
  }
  if (key === 'notifications') {
    const r = await within(LocalNotifications.requestPermissions(), 120_000, { display: 'denied' as const });
    return norm(r.display);
  }
  const r = await within(RestockNative.requestPermissions({ permissions: [key] }), 120_000, {
    camera: 'denied' as const,
    location: 'denied' as const,
  });
  return norm(r[key]);
}

export async function openAppSettings(): Promise<void> {
  if (native()) await RestockNative.openAppSettings().catch(() => undefined);
}
