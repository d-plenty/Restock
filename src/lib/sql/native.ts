import { registerPlugin, type PermissionState, type PluginListenerHandle } from '@capacitor/core';
import type { RunResult, SqlDriver, SqlOp, SqlValue } from './driver';
import type { Section } from '../../shops';

/** Bridge to the app's own Java code in android/app/src/main/java/family/plenty/restock. */
export interface RestockNativePlugin {
  sqlQuery(opts: { sql: string; values: SqlValue[] }): Promise<{ rows: Record<string, unknown>[] }>;
  sqlRun(opts: { sql: string; values: SqlValue[] }): Promise<RunResult>;
  sqlBatch(opts: { ops: { sql: string; values: SqlValue[] }[] }): Promise<void>;
  /**
   * Turn the background price check on or off (Android WorkManager). 0.9.6: it runs at the set time
   * of day from the phone's settings (checkTime, checkIntervalHours, checkWeekday), so this only
   * says on or off. `due`: a set time passed with no check (the phone was off), so run one now.
   */
  scheduleChecks(opts: { enabled: boolean; intervalHours?: number }): Promise<{ scheduled: boolean; due?: boolean }>;
  /**
   * Run a price check now, in native code, and wait for it. `slot`: this is the catch-up for a
   * missed set time (counts that time as done). A plain check never moves the schedule.
   */
  checkNow(opts?: { slot?: boolean }): Promise<{ checked: number; updated: number; errors: Record<string, string> }>;
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
   * 0.9.1: a plain request that doesn't go with the in-app browser's cookies (so not with any shop
   * account signed in to in Restock): only the cookies in its own jar, kept in memory until Restock
   * closes (Net.java). For barcode lookups (jar "lookup").
   */
  plainFetch(opts: {
    jar: string;
    method: 'GET' | 'POST';
    url: string;
    headers?: Record<string, string>;
    body?: string;
    timeoutMs?: number;
  }): Promise<{ status: number; body: string; headers?: Record<string, string> }>;
  /**
   * 0.9.3: Home Assistant (HomeAssistant.java). The token is kept in Android, sealed with a key
   * from its key store, and never comes back here: haRequest adds it. Plain http only to an
   * address at home or on Tailscale, https everywhere else (the same rule as sync).
   */
  /** 0.9.3: the token is kept for this address only (Java refuses to send it anywhere else). */
  haSaveToken(opts: { token: string; address: string }): Promise<void>;
  haForgetToken(): Promise<void>;
  haHasToken(): Promise<{ saved: boolean }>;
  /** `path` is Home Assistant's API (/api/…). `token`: one typed in but not saved yet (Test connection). */
  haRequest(opts: { address: string; method: 'GET' | 'POST'; path: string; body?: string; token?: string }): Promise<{ status: number; body: string }>;
  /**
   * Open a page in the hidden browser, wait for its scripts to draw it, and return the finished
   * page (for shop websites that build their product lists with scripts, or block plain requests).
   */
  storeRender(opts: { chain: string; url: string; home?: string }): Promise<{ status: number; html: string; url: string }>;
  /** Show the store's website so the user can clear its "are you human" check. Resolves when closed. */
  /** The shop's website, full screen. `path` opens a page on that site (its sign-in page); `message` is the note in the bar. */
  openStore(opts: {
    chain: string;
    home?: string;
    path?: string;
    message?: string;
    record?: boolean;
    pickStore?: boolean;
  }): Promise<{ recording?: string; storePage?: string } | void>;
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
  /**
   * 0.7.3: download an official release APK and open Android's installer. 0.9.1: `sha256` (lowercase
   * hex, as GitHub published it) is checked against the download first; without it, only the
   * signature and version are (sha256Checked false).
   */
  installUpdate(opts: {
    url: string;
    sha256?: string;
  }): Promise<{ started?: boolean; needsPermission?: boolean; notified?: boolean; sha256Checked?: boolean }>;
  /** Pick a folder for automatic backups (Android's folder picker). Rejects if cancelled. */
  pickFolder(): Promise<{ uri: string; name: string }>;
  /** Write a backup file into the picked folder, keeping the newest `keep` Restock backups there. */
  writeBackup(opts: { uri: string; name: string; json: string; keep: number }): Promise<{ written: string; removed: number }>;
  /** Save, read or delete a file in Restock's private storage (receipt photos). Data is base64. */
  writeAppFile(opts: { path: string; data: string }): Promise<void>;
  readAppFile(opts: { path: string }): Promise<{ data: string }>;
  deleteAppFile(opts: { path: string }): Promise<void>;
  appFileInfo(opts: { path: string }): Promise<{ uri: string; exists: boolean; bytes: number }>;
  deleteAppDir(opts: { path: string }): Promise<void>;
  /** How much space Restock's private files use, in bytes. */
  appFilesSize(opts: { dir: string }): Promise<{ bytes: number }>;
  /** Refresh the home screen widgets with the latest deals and list. */
  updateWidgets(opts: { data: string }): Promise<void>;
  /**
   * 0.9.0: copy text to the clipboard. sensitive (the recovery key): Android 13 and later doesn't
   * show it in the "Copied" preview, and keyboards leave it out of their clipboard history.
   */
  copyText(opts: { text: string; sensitive?: boolean }): Promise<void>;
  // ---------- 0.8.0: phone-to-phone sync (SyncHub.java) ----------
  syncInfo(): Promise<SyncInfo>;
  /** Starts (or reuses) the household; the code to show as a QR code. */
  /** tabs (0.8.5): what a new household shares (only used when starting one). */
  syncInvite(opts: { household: string; shareCards: boolean; tabs?: Section[] }): Promise<{ code: string; expiresInMs: number }>;
  /** 0.9.3: start a household with this phone as the owner, without a code (the Restock server's Connect). */
  syncStartHousehold(opts: { household: string; shareCards: boolean; tabs?: Section[] }): Promise<SyncInfo>;
  /** The sheet showing a code was closed: the code stops working. */
  syncCloseInvite(): Promise<void>;
  /** Owner: take a phone out of the household (the household's key changes). */
  syncRemove(opts: { device: string }): Promise<SyncInfo>;
  /** Owner: ask another phone to be the owner (it takes over at its next sync). */
  syncHandOver(opts: { device: string }): Promise<SyncInfo>;
  /** Owner: never mind, stay the owner. */
  syncCancelHandOver(): Promise<SyncInfo>;
  /** 0.9.0, owner: the recovery key ("ABCD-EFGH-…"), after the phone's screen lock if it has one. */
  syncRecovery(): Promise<{ key: string }>;
  /** 0.9.0, owner: the recovery key was saved; or fresh: make a new one. */
  syncRecoverySaved(opts: { fresh?: boolean; key?: string }): Promise<SyncInfo>;
  /** 0.9.0: take over as owner with the recovery key (the owner phone was lost). */
  syncTakeOver(opts: { key: string }): Promise<SyncInfo>;
  /**
   * 0.9.0: sync through a picked folder (its uri), or stop (no uri; 0.9.1: also forgets a WebDAV
   * or Nextcloud sign-in). 0.9.1: a picked folder is tried out first; rejects with a message if it fails.
   */
  syncSetFolder(opts: { uri?: string }): Promise<SyncInfo>;
  /** 0.9.1: sync away from home through a WebDAV server (made and tried out first; rejects with a message). */
  syncSetWebDav(opts: { url: string; user: string; password: string; folder?: string }): Promise<SyncInfo>;
  /**
   * 0.9.1, "Sign in to Nextcloud": opens Nextcloud's sign-in page in the browser and waits (up to
   * 20 minutes) for the person to finish there. cancelled: syncNextcloudCancel() was called.
   */
  syncNextcloud(opts: { server: string; folder?: string }): Promise<SyncInfo & { cancelled?: boolean }>;
  syncNextcloudCancel(): Promise<void>;
  /** 0.9.2: join a Restock server with the code from its Add a phone page (restock-server:2?…). */
  syncJoinServer(opts: { code: string }): Promise<SyncInfo>;
  /**
   * 0.9.2: stop using the Restock server. bringBack: its receipt photos come back first (rejects if they can't).
   * 0.9.4, a house: takeBack: those kinds come off the server first, as turning them off with "Also take
   * what this phone shared off the server" ticked (only what this phone added; rejects if it can't reach it).
   */
  syncStopServer(opts: { bringBack?: boolean; takeBack?: TakeBack[] }): Promise<SyncInfo>;
  /** 0.9.2: a web page's code (restock-link:2 or restock-login:2), checked: what it asks for. */
  syncWebCode(opts: { code: string }): Promise<{ kind: 'link' | 'login'; host: string }>;
  /** 0.9.2: the person said yes: the household's server keys go to that browser, sealed to it. */
  syncWebApprove(opts: { code: string }): Promise<{ kind: 'link' | 'login'; host: string }>;
  /** 0.9.2: a receipt photo kept on the Restock server (base64 JPEG), fetched to show; not saved on the phone. */
  syncServerPhoto(opts: { path: string }): Promise<{ data: string }>;
  /**
   * 0.9.3: the quick check with the Restock server while Restock is open (sync.ts): one listing, and a
   * round only when something changed there. Never overlaps a round (it doesn't look then).
   * received: changes taken in, or -1 when it didn't look (no server, a round going, out of reach).
   */
  syncServerPoll(): Promise<{ received: number }>;
  /** 0.9.4 (P4): one Home Assistant round, in Java (HaSync.java), and starting its pairing afresh. */
  haRound(opts: { manual?: boolean }): Promise<import('../homeAssistant').HaRound>;
  haResetPairing(): Promise<void>;
  // ---------- 0.9.4: a v3 server's house (docs/server-v3-design.md) ----------
  /** A scanned Add a phone code, checked, and what this phone is in now (only a health check is sent). */
  syncCheckServer(opts: { code: string }): Promise<ServerCodeCheck>;
  /**
   * Joins a v3 server's house. how: "join" (not in a household), "bring" (this owner phone's household
   * goes onto an empty server), "leave" (leave the household first, keeping everything, then join).
   * Nothing is synced yet: the screen asks what this phone shares, then syncs.
   */
  syncJoinServer3(opts: {
    code: string;
    how: 'join' | 'bring' | 'leave';
  }): Promise<
    SyncInfo & {
      label?: string | null;
      houseName?: string | null;
      /** bring: the server already has a house (nothing changed). */ notEmpty?: boolean;
      message?: string;
      /** leave: the household already lives on this server, so this phone connected as its member (it didn't leave). */
      member?: boolean;
    }
  >;
  /** Joins the server that's now the household's owner (its signed server row), without a code. */
  syncJoinHouse(): Promise<SyncInfo>;
  /** What this phone shares with its v3 server, and what it calls it. takeBack: also take those off the server. */
  syncSetServer(opts: { label?: string; tabs?: Section[]; receipts?: boolean; cards?: boolean; takeBack?: TakeBack[] }): Promise<SyncInfo>;
  /** Phone-to-phone sync on the Wi-Fi, on or off. */
  syncSetWifi(opts: { on: boolean }): Promise<SyncInfo>;
  /** The phone's server, asked what it is: { mode: "new" | "v2" | "v3" | "released", api, house }, or {} for a 0.9.3 server. */
  syncServerHealth(): Promise<{ mode?: string; api?: number; house?: string }>;
  /** Owner phone on a v2 server: hand the household to the server with its Take this household code. */
  syncHandOverServer(opts: { code: string }): Promise<SyncInfo>;
  /** The search test with the screen off (0.8.6): a notification with progress and a Stop button. */
  searchTestStart(opts: { total: number }): Promise<void>;
  searchTestProgress(opts: { done: number; total: number; text: string }): Promise<{ stop: boolean }>;
  searchTestEnd(opts: { title?: string; text?: string }): Promise<void>;
  /** A pause that keeps time with the screen off. */
  pause(opts: { ms: number }): Promise<void>;
  /** 0.8.5: what a code's household is, before joining (doesn't use the code up). */
  syncPeek(opts: { code: string }): Promise<{ household?: string; ownerName?: string; tabs: Section[]; settings?: string }>;
  syncDismissNotice(): Promise<void>;
  /** 0.8.2 "Erase everything": forget the household and stop background work on this phone. */
  eraseNative(): Promise<void>;
  /**
   * Joins with a scanned code. replace: start from the household's things (on the tabs this phone
   * shares) instead of combining. tabs: what this phone shares. The owner's settings come back as JSON text.
   */
  syncJoin(opts: {
    code: string;
    replace: boolean;
    shareCards: boolean;
    tabs?: Section[];
  }): Promise<SyncInfo & { reached: number; received: number; settings?: string; ownerName?: string }>;
  syncNow(): Promise<SyncNowResult>;
  /** household: the household's name (owner only). */
  /** tabs: what this phone shares; householdTabs: what the household shares (owner only). */
  syncSet(opts: {
    name?: string;
    household?: string;
    shareCards?: boolean;
    keepReady?: boolean;
    tabs?: Section[];
    householdTabs?: Section[];
    /** 0.9.1, owner: "Share receipts with the household". */
    householdReceipts?: boolean;
  }): Promise<SyncInfo>;
  /** left false: this is the owner and other phones are in the household; hand over first. */
  syncLeave(): Promise<SyncInfo & { left: boolean }>;
  requestBatteryExemption(): Promise<void>;
  addListener(event: 'syncChanged', fn: () => void): Promise<PluginListenerHandle>;
  addListener(event: 'syncDone', fn: (info: SyncInfo) => void): Promise<PluginListenerHandle>;
  /** Text or a link shared to Restock from another app, and app icon shortcuts, if any are waiting. */
  takeLaunchAction(): Promise<{ action?: LaunchAction; text?: string }>;
  addListener(event: 'launchAction', fn: (e: { action: LaunchAction; text?: string }) => void): Promise<PluginListenerHandle>;
}

export interface SyncInfo {
  paired: boolean;
  device?: string;
  /** This phone's name, shown on the others. */
  name?: string;
  household?: string;
  shareCards?: boolean;
  keepReady?: boolean;
  peers?: { device: string; name: string | null; syncedAt: string | null }[];
  batteryExempt: boolean;
  lastSyncAt?: string | null;
  lastError?: string | null;
  listening?: boolean;
  /** 0.8.2: whether this phone is the household's owner, and the household's phones. */
  isOwner?: boolean;
  members?: { device: string; name: string; owner: boolean; me: boolean }[];
  /**
   * "repair": paired on 0.8.0/0.8.1, pair again. "removed": the owner removed this phone.
   * "keys" (0.9.1): this phone's sync keys couldn't be opened (Restock's data moved to another phone).
   */
  notice?: string | null;
  /** The phone's maker (some stop apps in the background regardless; see dontkillmyapp.com). */
  maker?: string;
  /** 0.8.5: what the household shares, what this phone chose, and what it actually syncs. */
  householdTabs?: Section[];
  myTabs?: Section[];
  tabs?: Section[];
  /** Owner: the phone it asked to take over, until that phone does. */
  handoverTo?: string | null;
  /** 0.9.0, owner: there's a recovery key, and whether it's been saved. */
  hasRecovery?: boolean;
  recoverySaved?: boolean;
  /** 0.9.0, other phones: the household has a recovery key, so this phone could take over with it. */
  canRecover?: boolean;
  /** 0.9.0: the folder the household syncs through, its name, the last sync through it and any problem. */
  folder?: string | null;
  folderName?: string | null;
  folderAt?: string | null;
  folderError?: string | null;
  /** 0.9.0: other phones' files in the folder that couldn't be opened. */
  folderUnread?: number;
  /** 0.9.0: the name of a phone whose date looks well ahead (its changes would always win). */
  clockWarning?: string | null;
  /** 0.9.1: what sync away from home goes through (folderName is then "cloud.example.com · Restock" for a server). */
  folderKind?: 'nextcloud' | 'webdav' | 'folder' | null;
  /** 0.9.1: the household shares receipts (the owner's choice; off by default). */
  shareReceipts?: boolean;
  /** 0.9.1: on Wi-Fi or Ethernet (phones only sync with each other there). */
  onWifi?: boolean;
  /** 0.9.2: the Restock server: joined, its addresses, the one that answered last, the last sync through it and any problem (in words). */
  server?: boolean;
  serverHome?: string | null;
  serverAway?: string | null;
  serverReached?: string | null;
  serverAt?: string | null;
  serverError?: string | null;
  /** 0.9.2: other phones' files on the server that couldn't be opened, and how many files it has. */
  serverUnread?: number;
  serverFiles?: number;
  /** 0.9.2: prices and receipt photos moved off this phone to the server, and ones saved there but not confirmed yet. */
  serverPrices?: number;
  serverPhotos?: number;
  serverWaiting?: number;
  /** 0.9.4: 3 for a v3 server (the household's owner), 2 for a 0.9.3-style one, null without. */
  serverApi?: 2 | 3 | null;
  /** 0.9.4: the household is a server's house (its owner is the server). */
  house?: boolean;
  /** 0.9.4: what this phone calls its server ("Home"), and what the server calls this phone. */
  serverLabel?: string | null;
  serverMemberLabel?: string | null;
  /** 0.9.4: the v2 server's mode as last asked ("v2": waiting for Hand this household to the server). */
  serverMode?: string | null;
  /** 0.9.4: when this owner phone handed the household over (until it reads the server's own change). */
  serverHandover?: string | null;
  /** 0.9.4: phone-to-phone sync on the Wi-Fi is on. */
  wifiSync?: boolean;
  /** 0.9.4: this phone's own choice of sharing receipts (the household's switch aside). */
  shareReceiptsMine?: boolean;
  /** 0.9.4: what this phone is taking back off the server. */
  takeBack?: TakeBack[];
  /** 0.9.4: the house's owner-signed server row: where it is, and Keep data for. */
  serverRow?: { home: string; away: string | null; keepMonths: number | null };
  /** 0.9.4: the household is now a server's house and this phone isn't on the server yet. */
  serverOffer?: boolean;
}

/** 0.9.4: what can be taken back off the server when this phone stops sharing it. */
export type TakeBack = 'keg' | 'pharmacy' | 'receipts' | 'cards';

/** 0.9.4: what Sync now did (SyncHub.Summary). */
export type SyncNowResult = SyncInfo & {
  reached: number;
  received: number;
  sent: number;
  /** Wi-Fi sync is on (only then is anything said about the Wi-Fi's phones). */
  wifi?: boolean;
  viaServer?: boolean;
  viaFolder?: boolean;
  names?: string[];
};

/** 0.9.4: a scanned Add a phone code, before joining (ServerSync.check). */
export interface ServerCodeCheck {
  v: 2 | 3;
  home: string | null;
  away: string | null;
  /** v3, when the server answered: its mode, its house's name, and whether the house is new and empty. */
  mode?: string;
  house?: string;
  empty?: boolean;
  inHousehold: boolean;
  isOwner?: boolean;
  household?: string;
  owner?: string;
  members?: number;
  /** The household is already this server's house (the code's key is the one in its server row). */
  sameHouse?: boolean;
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
