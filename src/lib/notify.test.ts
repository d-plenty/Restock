import { describe, expect, it, vi } from 'vitest';

// Mimic a Capacitor plugin proxy: every property, including `then`, looks like a method.
// Returning such an object from an async function hangs forever, which is what froze onboarding.
const calls: string[] = [];
const proxy = new Proxy(
  {},
  {
    get: (_t, prop) => {
      if (prop === 'then') return () => calls.push('then');
      return async () => {
        calls.push(String(prop));
        return prop === 'checkPermissions' ? { display: 'granted' } : {};
      };
    },
  },
);

vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => true } }));
vi.mock('@capacitor/local-notifications', () => ({ LocalNotifications: proxy }));

describe('notifications', () => {
  it('never treats the plugin as a promise, and finishes', async () => {
    const { scheduleReminders } = await import('./notify');
    const { DEFAULT_SETTINGS } = await import('../types');
    const done = scheduleReminders({ ...DEFAULT_SETTINGS, alerts: { ...DEFAULT_SETTINGS.alerts, catalogueDay: true } });
    const result = await Promise.race([done.then(() => 'finished'), new Promise((r) => setTimeout(() => r('hung'), 1000))]);
    expect(result).toBe('finished');
    expect(calls).not.toContain('then');
    expect(calls).toContain('schedule');
  });
});
