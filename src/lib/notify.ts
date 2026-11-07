import { Capacitor } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';
import type { Settings } from '../types';

// Local notifications only — scheduled on the phone, nothing goes through a server.

const ID = { catalogue: 101, daily: 102, monthly: 103 };

// Deliberately NOT async. A Capacitor plugin object answers every property, including `then`,
// so returning it from an async function makes JavaScript treat it as a promise and wait on
// `LocalNotifications.then()`, which never settles. That was the 0.2.x onboarding freeze.
function plugin(): typeof LocalNotifications | undefined {
  return Capacitor.isNativePlatform() ? LocalNotifications : undefined;
}

/** Resolves to `fallback` if the promise hasn't settled in time, so nothing can wait forever on Android. */
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
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

/** Notifications allowed already? Never shows a dialog. */
export async function notificationsAllowed(): Promise<boolean> {
  const ln = plugin();
  if (!ln) return false;
  const { display } = await withTimeout(ln.checkPermissions(), 5_000, { display: 'denied' as const });
  return display === 'granted';
}

/** Ask (if Android still can) and say whether notifications are allowed. Only call from a tap. */
export async function ensureNotificationPermission(): Promise<boolean> {
  const ln = plugin();
  if (!ln) return false;
  let { display } = await withTimeout(ln.checkPermissions(), 5_000, { display: 'denied' as const });
  if (display === 'prompt' || display === 'prompt-with-rationale') {
    // The person may take a while to answer the dialog, but never let a lost answer hang the app.
    ({ display } = await withTimeout(ln.requestPermissions(), 60_000, { display: 'denied' as const }));
  }
  return display === 'granted';
}

/** Re-create the repeating reminders from the current alert settings. */
export async function scheduleReminders(s: Settings): Promise<void> {
  const ln = plugin();
  if (!ln) return;
  await ln.cancel({ notifications: Object.values(ID).map((id) => ({ id })) });
  const wanted = s.alerts.catalogueDay || s.alerts.daily || s.alerts.monthly;
  // Never asks: permission is requested when it's useful (after your first item, or in Settings).
  if (!wanted || !(await notificationsAllowed())) return;

  const notifications = [];
  // With background checks on, the weekly summary comes from the price check itself (it can say
  // what's on special). Without them, a plain reminder on catalogue day.
  if (s.alerts.catalogueDay && !s.sync.backgroundActivity) {
    notifications.push({
      id: ID.catalogue,
      title: 'New specials are out',
      body: 'Open Restock to see what’s worth buying this week.',
      // Capacitor counts weekdays from 1 = Sunday.
      schedule: { on: { weekday: s.alerts.catalogueWeekday + 1, hour: 8, minute: 0 }, allowWhileIdle: true },
    });
  }
  if (s.alerts.daily) {
    const [hour, minute] = s.alerts.dailyTime.split(':').map((n) => parseInt(n, 10));
    notifications.push({
      id: ID.daily,
      title: 'Daily price check',
      body: 'Tap to check today’s prices on your pantry items.',
      schedule: { on: { hour, minute }, allowWhileIdle: true },
    });
  }
  if (s.alerts.monthly) {
    notifications.push({
      id: ID.monthly,
      title: 'Your monthly savings',
      body: 'See what you saved last month and where.',
      schedule: { on: { day: 1, hour: 9, minute: 0 }, allowWhileIdle: true },
    });
  }
  await ln.schedule({ notifications });
}
