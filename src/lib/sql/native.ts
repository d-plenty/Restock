import { registerPlugin, type PermissionState, type PluginListenerHandle } from '@capacitor/core';
import type { RunResult, SqlDriver, SqlOp, SqlValue } from './driver';

/** Bridge to the app's own Java code in android/app/src/main/java/family/plenty/restock. */
export interface RestockNativePlugin {
  sqlQuery(opts: { sql: string; values: SqlValue[] }): Promise<{ rows: Record<string, unknown>[] }>;
  sqlRun(opts: { sql: string; values: SqlValue[] }): Promise<RunResult>;
  sqlBatch(opts: { ops: { sql: string; values: SqlValue[] }[] }): Promise<void>;
  /** Turn the background price check on or off (Android WorkManager). */
  scheduleChecks(opts: { enabled: boolean; intervalHours: number }): Promise<{ scheduled: boolean }>;
  /** Run a price check now, in native code, and wait for it. */
  checkNow(): Promise<{ checked: number; updated: number; errors: Record<string, string> }>;
  addListener(event: 'checkProgress', fn: (e: { done: number; total: number }) => void): Promise<PluginListenerHandle>;
  /** Download shared price history (MarketData.java) and summarise it into the market table. */
  importMarket(opts?: {
    /** Skip (and say so) when on mobile data; the weekly background refresh picks it up on Wi-Fi. */
    onlyUnmetered?: boolean;
  }): Promise<{ products: number; bytes: number; byChain: Record<string, number>; errors: Record<string, string>; waitingForWifi?: boolean }>;
  addListener(event: 'marketProgress', fn: (e: { chain: string; bytes: number; products: number }) => void): Promise<PluginListenerHandle>;
  /** Provided by Capacitor for every plugin; aliases are declared in RestockNativePlugin.java. */
  checkPermissions(): Promise<NativePermissions>;
  requestPermissions(opts: { permissions: (keyof NativePermissions)[] }): Promise<NativePermissions>;
  /** Approximate location from Android's own location service. */
  getLocation(): Promise<{ lat: number; lon: number; accuracy: number }>;
  openAppSettings(): Promise<void>;
  /** A request made from inside the store's own web page, in a hidden browser (StoreWeb.java). */
  storeFetch(opts: { chain: string; method: 'GET' | 'POST'; url: string; body?: string }): Promise<{ status: number; body: string }>;
  /**
   * Open a page in the hidden browser, wait for its scripts to draw it, and return the finished
   * page (for shop websites that build their product lists with scripts, or block plain requests).
   */
  storeRender(opts: { chain: string; url: string; home?: string }): Promise<{ status: number; html: string; url: string }>;
  /** Show the store's website so the user can clear its "are you human" check. Resolves when closed. */
  /** The shop's website, full screen. `path` opens a page on that site (its sign-in page); `message` is the note in the bar. */
  openStore(opts: { chain: string; home?: string; path?: string; message?: string; record?: boolean }): Promise<{ recording?: string } | void>;
  /** How far the system bars overlap the app, in CSS px (0 when Android already keeps clear). */
  getInsets(): Promise<{ top: number; bottom: number }>;

  // ---------- 0.6.0 ----------
  /** Switch the launcher icon to one of the built-in colours (see lib/looks.ts). */
  setAppIcon(opts: { id: string }): Promise<{ ok: boolean }>;
  /** Turn the once-a-day recall check on or off. */
  scheduleRecalls(opts: { enabled: boolean }): Promise<void>;
  /** Check the official recall lists now (the same check as the daily one). */
  checkRecalls(): Promise<{ checked: number; found: number; fresh: number; errors: Record<string, string> }>;
  /** Show a notification right away (recalls found by "Check now", the weekly summary). */
  notify(opts: { id: number; title: string; body: string }): Promise<void>;
  /** Pick a folder for automatic backups (Android's folder picker). Rejects if cancelled. */
  pickFolder(): Promise<{ uri: string; name: string }>;
  /** Write a backup file into the picked folder, keeping the newest `keep` Restock backups there. */
  writeBackup(opts: { uri: string; name: string; json: string; keep: number }): Promise<{ written: string; removed: number }>;
  /** Save, read or delete a file in Restock's private storage (receipt photos). Data is base64. */
  writeAppFile(opts: { path: string; data: string }): Promise<void>;
  readAppFile(opts: { path: string }): Promise<{ data: string }>;
  deleteAppFile(opts: { path: string }): Promise<void>;
  /** Download a file into Restock's private storage (the receipt reader), with downloadProgress events. */
  downloadAppFile(opts: { url: string; path: string }): Promise<{ uri: string; bytes: number }>;
  appFileInfo(opts: { path: string }): Promise<{ uri: string; exists: boolean; bytes: number }>;
  deleteAppDir(opts: { path: string }): Promise<void>;
  addListener(event: 'downloadProgress', fn: (e: { path: string; bytes: number; total: number }) => void): Promise<PluginListenerHandle>;
  /** How much space Restock's private files use, in bytes. */
  appFilesSize(opts: { dir: string }): Promise<{ bytes: number }>;
  /** Refresh the home screen widgets with the latest deals and list. */
  updateWidgets(opts: { data: string }): Promise<void>;
  /** Text or a link shared to Restock from another app, and app icon shortcuts, if any are waiting. */
  takeLaunchAction(): Promise<{ action?: LaunchAction; text?: string }>;
  addListener(event: 'launchAction', fn: (e: { action: LaunchAction; text?: string }) => void): Promise<PluginListenerHandle>;
}

/** Why Restock was opened: a share, an app icon shortcut, a widget or a notification. */
export type LaunchAction = 'scan' | 'list' | 'receipt' | 'share' | 'recalls' | 'deals';

export interface NativePermissions {
  camera: PermissionState;
  location: PermissionState;
}

export const RestockNative = registerPlugin<RestockNativePlugin>('RestockNative');

export function createNativeDriver(): SqlDriver {
  return {
    async query<T>(sql: string, params: SqlValue[] = []): Promise<T[]> {
      const { rows } = await RestockNative.sqlQuery({ sql, values: params });
      return rows as T[];
    },
    run: (sql, params = []) => RestockNative.sqlRun({ sql, values: params }),
    async batch(ops: SqlOp[]) {
      if (!ops.length) return;
      await RestockNative.sqlBatch({ ops: ops.map((o) => ({ sql: o.sql, values: o.params ?? [] })) });
    },
  };
}
