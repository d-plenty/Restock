// 0.9.0: the monthly savings summary is "coming soon", so it's never scheduled (and an old one is cancelled).
import { describe, expect, it, vi } from 'vitest';

const scheduled: { id: number }[][] = [];
const cancelled: { id: number }[][] = [];
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => true } }));
vi.mock('@capacitor/local-notifications', () => ({
  LocalNotifications: {
    checkPermissions: async () => ({ display: 'granted' }),
    cancel: async (o: { notifications: { id: number }[] }) => void cancelled.push(o.notifications),
    schedule: async (o: { notifications: { id: number }[] }) => void scheduled.push(o.notifications),
  },
}));

describe('monthly savings notification', () => {
  it('is not sent, even when switched on', async () => {
    const { scheduleReminders } = await import('./notify');
    const { DEFAULT_SETTINGS } = await import('../types');
    await scheduleReminders({ ...DEFAULT_SETTINGS, alerts: { ...DEFAULT_SETTINGS.alerts, monthly: true, daily: true } });
    expect(scheduled.flat().map((n) => n.id)).not.toContain(103);
    expect(scheduled.flat().map((n) => n.id)).toContain(102);
    expect(cancelled.flat().map((n) => n.id)).toContain(103);
  });

  it('asks for nothing when it is the only one on', async () => {
    scheduled.length = 0;
    const { scheduleReminders } = await import('./notify');
    const { DEFAULT_SETTINGS } = await import('../types');
    await scheduleReminders({ ...DEFAULT_SETTINGS, alerts: { ...DEFAULT_SETTINGS.alerts, monthly: true, daily: false, catalogueDay: false } });
    expect(scheduled).toEqual([]);
  });
});
