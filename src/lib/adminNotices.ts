// 0.18.1: on an admin phone, a notification when the server's phones change: one joins, leaves or is
// removed, or becomes an admin or a user. The phone keeps a note of the phones as it last saw them
// (on this phone only) and compares each time Restock opens or comes back to the screen. Its own
// changes (Phones and tablets) are noted as they're made, so it doesn't tell you what you just did.
// Settings → Notifications → Changes to the server's phones (on unless turned off; admins only).
import { Capacitor } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';
import type { Settings } from '../types';
import { getSettings } from './db';
import { notificationsAllowed } from './notify';
import { myRole, phoneLabel, serverPhones, type Phone } from './serverPhones';
import { syncInfo } from './sync';

const KEY = 'restock.serverPhones.v1';
const ID = 140;

type Seen = Record<string, { name: string; status: string; role: string }>;

export const phoneNoticesOn = (s: Pick<Settings, 'alerts'>): boolean => s.alerts.phones !== false;

export const snapshot = (list: Phone[]): Seen =>
  Object.fromEntries(list.filter((p) => !p.device.startsWith('srv-')).map((p) => [p.device, { name: phoneLabel(p), status: p.status || 'active', role: p.role === 'admin' ? 'admin' : 'user' }]));

/** What changed between two looks at the phones, in words ("Sarah's iPad joined"). Exported for the tests. */
export function phoneChanges(before: Seen, now: Seen, me?: string): string[] {
  const out: string[] = [];
  for (const [device, p] of Object.entries(now)) {
    if (device === me) continue;
    const was = before[device];
    if (!was) {
      if (p.status === 'active') out.push(`${p.name} joined${p.role === 'admin' ? ' as an admin' : ''}`);
      continue;
    }
    if (was.status !== p.status) {
      if (p.status === 'left') out.push(`${p.name} left`);
      else if (p.status === 'removed') out.push(`${p.name} was removed`);
      else if (p.status === 'active') out.push(`${p.name} joined again`);
    } else if (was.role !== p.role && p.status === 'active') out.push(p.role === 'admin' ? `${p.name} is an admin now` : `${p.name} is a user now`);
  }
  return out;
}

const read = (): Seen | undefined => {
  try {
    const t = localStorage.getItem(KEY);
    return t ? (JSON.parse(t) as Seen) : undefined;
  } catch {
    return undefined;
  }
};
const write = (s: Seen) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // not kept: the next look starts again
  }
};

/** Note the phones as they are now, with nothing to tell (after this phone changed them itself). */
export async function notePhones(list?: Phone[]): Promise<void> {
  try {
    write(snapshot(list ?? (await serverPhones())));
  } catch {
    // out of reach: the next look catches up
  }
}

let busy = false;
/** Look at the server's phones, and tell an admin what changed since the last look. */
export async function checkPhoneChanges(): Promise<string[]> {
  if (busy) return [];
  busy = true;
  try {
    const s = await getSettings();
    if (!phoneNoticesOn(s)) return [];
    const info = await syncInfo();
    if (!info.server || info.serverApi !== 3) return [];
    if ((await myRole()) !== 'admin') {
      // Not an admin (or not any more): start again from nothing if it becomes one.
      try {
        localStorage.removeItem(KEY);
      } catch {
        // nothing kept
      }
      return [];
    }
    const now = snapshot(await serverPhones());
    const before = read();
    write(now);
    // The first look only notes them.
    if (!before) return [];
    const changes = phoneChanges(before, now, info.device);
    if (changes.length && Capacitor.isNativePlatform() && (await notificationsAllowed())) {
      await LocalNotifications.schedule({
        notifications: [
          {
            id: ID,
            title: changes.length === 1 ? changes[0] : `${changes.length} changes to the server's phones`,
            body: changes.length === 1 ? `On ${info.serverLabel?.trim() || 'your Restock server'}. You're an admin there.` : changes.join(' · '),
            extra: { action: 'serverPhones' },
          },
        ],
      });
    }
    return changes;
  } catch {
    return [];
  } finally {
    busy = false;
  }
}
