// 0.16.0: what to call the person using this phone. Asked once ("What should we call you?") when
// setting up or joining, and once after updating; it can be skipped, and changed in Settings.
//
// It's used for Home's greeting ("Good morning, Declan"; with no name, "Good morning"), for this
// phone's name in the household and on a Restock server ("Declan's iPhone"), and in backup file
// names. It's this phone's own: in its backups (so a restore brings it back), never synced.
import { serverMode } from '../server-mode/flag';
import { getSettings, updateSettings } from './db';
import { Capacitor } from '@capacitor/core';
import { deviceWord, isIos } from './platform';
import { quiet } from './quietErrors';
import { RestockNative } from './sql/native';
import type { Settings } from '../types';

export const NAME_MAX = 30;

/** Tidied: no spaces at the ends or doubled, no line breaks, not too long. */
export const cleanName = (s: string): string =>
  s
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NAME_MAX)
    .trim();

/** The name, if there is one. */
export const nameOf = (s: Pick<Settings, 'myName'> | undefined): string | undefined => (s?.myName && cleanName(s.myName)) || undefined;

/** "Good morning" with the name after it, when there is one. */
export const withName = (greeting: string, s: Pick<Settings, 'myName'> | undefined): string => {
  const n = nameOf(s);
  return n ? `${greeting}, ${n}` : greeting;
};

/** A name made safe for a file name ("Declan", "Mum-and-Dad"); empty when there's nothing usable. */
export const fileNamePart = (s: Pick<Settings, 'myName'> | undefined): string =>
  (nameOf(s) ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);

/** What this phone is called in the household when Restock names it: "Declan's iPhone", or just "iPhone". */
export const phoneLabelFor = (name: string | undefined, base: string): string => {
  const n = name && cleanName(name);
  if (!n) return base;
  return `${n}${/s$/i.test(n) ? '’' : '’s'} ${base}`.slice(0, 40);
};

/**
 * Saves the name (empty: no name) and marks it asked. The phone's name in the household follows,
 * unless someone gave the phone a name of their own.
 */
export async function setMyName(name: string): Promise<void> {
  const n = cleanName(name);
  await updateSettings({ myName: n || undefined, nameAsked: true });
  await labelPhone(n).catch(quiet('your name'));
  // 0.17.0: the web page on a server names this browser by it too (server-mode/live.ts)
  if (serverMode) await import('../server-mode/live').then((m) => m.nameThisBrowser(n)).catch(quiet('your name'));
}

/** Skipped: not asked again. */
export const skipName = () => updateSettings({ nameAsked: true });

/**
 * Names this phone in the household from the name: only while it still has the name it came with,
 * or the one Restock gave it last time.
 */
export async function labelPhone(name: string): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  const info = await RestockNative.syncInfo();
  const base = isIos() ? (deviceWord() === 'iPad' ? 'iPad' : 'iPhone') : info.defaultName?.trim() || 'Android phone';
  const s = await getSettings();
  const now = info.name?.trim();
  const untouched = !now || now === base || now === 'Phone' || (!!s.phoneLabel && now === s.phoneLabel);
  if (!untouched) return;
  const label = phoneLabelFor(name, base);
  if (label === now) return void (await updateSettings({ phoneLabel: label }));
  await RestockNative.syncSet({ name: label });
  await updateSettings({ phoneLabel: label });
}

/** 0.17.0: what kind of browser this is, for its name in the household ("Sam's Firefox"); "browser" when it can't tell. */
export function browserWord(ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''): string {
  if (/Edg\//.test(ua)) return 'Edge';
  if (/Firefox\//.test(ua)) return 'Firefox';
  if (/OPR\//.test(ua)) return 'Opera';
  if (/Chrome\//.test(ua)) return 'Chrome';
  if (/Safari\//.test(ua)) return 'Safari';
  return 'browser';
}

/** 0.17.0: the web page's name in the household: "Sam's Chrome" with a name, "Web" without. */
export const browserLabel = (name: string | undefined, ua?: string): string => (cleanName(name ?? '') ? phoneLabelFor(cleanName(name ?? ''), browserWord(ua)) : 'Web');
