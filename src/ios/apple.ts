// 0.13.2: the iPhone and iPad app's own native plugin (ios/App/App/RestockApple.swift): a hidden browser
// page, the shop's site on screen, a folder picked in Files, and the keychain. Everything that uses it
// asks appleHere() first and carries on without it (an older build of the app's native side).
import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';

export interface FolderFile {
  name: string;
  size: number;
  /** When it last changed, ms. */
  mtime: number;
  /** iCloud hasn't brought it down yet (it has been asked to). */
  waiting?: boolean;
}

export interface RestockApplePlugin {
  /** 0.15.1: `channel`, the RestockChannel key in Info.plist ("appstore" in the App Store build). */
  info(): Promise<{ version: number; pad: boolean; system: string; channel?: string }>;
  /** Loads `url` in the hidden page called `key`. Resolves when it has loaded, failed (status 0) or timed out. */
  webLoad(o: { key: string; url: string; timeoutMs?: number }): Promise<{ status: number; url: string }>;
  /** Runs `js` (a function body; it may await and must return a string) in that page. */
  webEval(o: { key: string; js: string }): Promise<{ value: string }>;
  webClose(o: { key?: string }): Promise<void>;
  /** The page on screen until Done, or until its address matches `closeOn` (a regular expression). */
  webOpen(o: { url: string; message?: string; allowed?: string[]; closeOn?: string; script?: string; readOnDone?: string }): Promise<{ url: string; matched: boolean; value?: string }>;
  folderPick(): Promise<{ bookmark: string; name: string }>;
  folderList(o: { bookmark: string }): Promise<{ files: FolderFile[]; bookmark?: string }>;
  folderRead(o: { bookmark: string; name: string }): Promise<{ data: string; bookmark?: string }>;
  folderWrite(o: { bookmark: string; name: string; data: string }): Promise<{ bytes: number; bookmark?: string }>;
  folderDelete(o: { bookmark: string; name: string }): Promise<{ bookmark?: string }>;
  secretSet(o: { key: string; value: string }): Promise<void>;
  secretGet(o: { key: string }): Promise<{ found: boolean; value?: string }>;
  secretDelete(o: { key: string }): Promise<void>;
  // 0.14.0: the Wi-Fi (ios/lan.ts). Messages are base64; each is one whole sealed message.
  lanInfo(): Promise<{ ip?: string }>;
  lanDial(o: { host: string; port: number; timeoutMs?: number }): Promise<{ id: string }>;
  lanAsk(o: { id: string; data: string; timeoutMs?: number }): Promise<{ data: string }>;
  lanClose(o: { id: string }): Promise<void>;
  lanListen(o: { key: string; port?: number }): Promise<{ port: number }>;
  lanReply(o: { conn: string; data?: string }): Promise<void>;
  lanStop(o: { key: string }): Promise<void>;
  lanAdvertise(o: { key: string; name: string; type: string; txt: Record<string, string> }): Promise<void>;
  lanUnadvertise(o: { key: string }): Promise<void>;
  lanBrowse(o: { type: string; ms: number }): Promise<{ found: { name?: string; host: string; port: number; txt?: Record<string, string> }[] }>;
  /** A file in the app's own storage (Application Support/Restock), whole, as base64. Names are fixed words from the app. */
  storeRead(o: { name: string }): Promise<{ found: boolean; data?: string; bytes?: number }>;
  /** Written beside the old file and swapped in, so a cut-short save never leaves half a file. */
  storeWrite(o: { name: string; data: string }): Promise<{ bytes: number }>;
  storeDelete(o: { name: string }): Promise<void>;
  /** The app's icon: one of the alternate icons in the app, or '' for the main one. */
  iconSet(o: { name: string }): Promise<{ ok: boolean }>;
  iconGet(): Promise<{ name: string; supported: boolean }>;
  /** Whether the connection is one iOS calls expensive (mobile data, a hotspot). */
  netInfo(): Promise<{ online: boolean; expensive: boolean }>;
  /**
   * 0.14.0: asks iOS to wake the app later for a short sync (it tells the app with a "backgroundRefresh"
   * event). 0.15.2: `checkAt` (ms): and for a longer price check no sooner than then, while the phone
   * is charging and online (a "backgroundCheck" event; "backgroundStop" when iOS says the time's up).
   */
  backgroundSchedule(o?: { checkAt?: number }): Promise<void>;
  backgroundDone(o: { ok: boolean }): Promise<void>;
  /** 0.15.2: the longer check has finished (or stopped). */
  backgroundCheckDone(o: { ok: boolean }): Promise<void>;
  /**
   * 0.15.2 (iOS 26): a Check now that keeps going after Restock leaves the screen, with its progress
   * on the Lock Screen. `started` false: not on this iPhone (it then stops when Restock does, and
   * carries on next time). "backgroundStop" when iOS ends it early.
   */
  checkTaskStart(o: { total: number }): Promise<{ started: boolean }>;
  checkTaskProgress(o: { done: number; total: number }): Promise<void>;
  checkTaskEnd(o: { ok: boolean }): Promise<void>;
  addListener(event: string, handler: (data: never) => void): Promise<PluginListenerHandle>;
}

/** A stand-in for the tests and the click-through (set before the app starts). */
const fake = (): RestockApplePlugin | undefined => (globalThis as { __restockAppleFake?: RestockApplePlugin }).__restockAppleFake;

/** Hands each call to whichever stand-in is set at the time (Capacitor keeps the first answer it's given). */
const standIn = async (): Promise<RestockApplePlugin> =>
  new Proxy({} as RestockApplePlugin, {
    get: (_t, prop) => {
      const f = fake() as unknown as Record<string | symbol, unknown> | undefined;
      const v = f?.[prop];
      // A stand-in sends no events: listening for them is allowed, and nothing ever comes.
      if (prop === 'addListener' && typeof v !== 'function') return async () => ({ remove: async () => undefined });
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(f) : undefined;
    },
  });

export const RestockApple = registerPlugin<RestockApplePlugin>('RestockApple', { ios: standIn, web: standIn });

/** Is the native plugin in this build of the app? */
export const appleHere = (): boolean => !!fake() || (Capacitor.getPlatform() === 'ios' && Capacitor.isPluginAvailable('RestockApple'));
