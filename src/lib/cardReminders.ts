// 0.9.6 (cards): "Remind me before it expires" for gift cards, as local notifications scheduled on
// the phone (notify.ts's plugin; nothing goes through a server). Off on each card until the person
// picks a reminder, because notifications need Android's permission first (asked from that tap).
// The words say the card's name and the day only, never its number, PIN or balance.
import { Capacitor } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';
import type { GiftCard } from '../types';
import { isReminderId, reminderAt, reminderId, reminderText } from './giftCards';
import { notificationsAllowed } from './notify';

// Not async on purpose (notify.ts plugin(): a Capacitor plugin object answers `then`).
function plugin(): typeof LocalNotifications | undefined {
  return Capacitor.isNativePlatform() ? LocalNotifications : undefined;
}

/** The notifications to have for these cards (exported for tests). */
export function wantedReminders(cards: GiftCard[], now = Date.now()) {
  const out: { id: number; title: string; body: string; at: Date }[] = [];
  for (const c of cards) {
    const at = reminderAt(c, now);
    if (at) out.push({ id: reminderId(c.id), ...reminderText(c), at });
  }
  return out;
}

/** Cancels every gift card reminder, then schedules the ones the cards want now. Never asks for permission. */
export async function scheduleCardReminders(cards: GiftCard[]): Promise<void> {
  const ln = plugin();
  if (!ln) return;
  try {
    const pending = await ln.getPending();
    const old = pending.notifications.filter((n) => isReminderId(n.id)).map((n) => ({ id: n.id }));
    if (old.length) await ln.cancel({ notifications: old });
    const want = wantedReminders(cards);
    if (!want.length || !(await notificationsAllowed())) return;
    await ln.schedule({
      notifications: want.map((w) => ({ id: w.id, title: w.title, body: w.body, extra: { action: 'cards' }, schedule: { at: w.at, allowWhileIdle: true } })),
    });
  } catch {
    // A reminder that can't be set never stops the card being saved.
  }
}
