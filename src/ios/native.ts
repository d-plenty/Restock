// iPhone app: the iPhone's side of RestockNative (lib/sql/native.ts), written in TypeScript on top of
// the pieces every Capacitor app has on iOS: its HTTP (no browser rules in the way of a shop's
// answers), its files, its notifications, and the web view's own camera, clipboard and location.
// Android's side is Java (android/.../RestockNativePlugin.java) and does more: background jobs,
// phone-to-phone sync, a hidden browser. What an iPhone can't do, or doesn't do yet, says so with
// IosUnavailable, and the screens grey it out with the reason.
//
// A method that later gets written in Swift takes over from the one here by itself: Capacitor asks
// the native side first and comes here only for what it doesn't have.
import { CapacitorHttp, WebPlugin } from '@capacitor/core';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { LocalNotifications } from '@capacitor/local-notifications';
import { IosUnavailable } from '../lib/platform';
import type { NativePermissions, SyncInfo } from '../lib/sql/native';

const NO_SYNC: SyncInfo = { paired: false, batteryExempt: true };
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const BACKUP_DIR = 'Restock backups';
const BACKUP_URI = 'ios-documents:';

const text = (d: unknown): string => (typeof d === 'string' ? d : d === undefined || d === null ? '' : JSON.stringify(d));

async function http(opts: { method: 'GET' | 'POST'; url: string; headers?: Record<string, string>; body?: string; timeoutMs?: number }) {
  const headers: Record<string, string> = { 'User-Agent': UA, Accept: 'text/html,application/json;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-AU,en;q=0.9', ...(opts.headers ?? {}) };
  if (opts.body !== undefined && !Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';
  const r = await CapacitorHttp.request({
    method: opts.method,
    url: opts.url,
    headers,
    data: opts.body,
    responseType: 'text',
    connectTimeout: opts.timeoutMs ?? 20000,
    readTimeout: opts.timeoutMs ?? 20000,
  });
  return { status: r.status, body: text(r.data), headers: (r.headers ?? {}) as Record<string, string>, url: r.url ?? opts.url };
}

const permission = async (name: 'camera' | 'geolocation'): Promise<NativePermissions['camera']> => {
  try {
    const p = await navigator.permissions.query({ name: name as PermissionName });
    return p.state === 'granted' ? 'granted' : p.state === 'denied' ? 'denied' : 'prompt';
  } catch {
    return 'prompt';
  }
};

export class RestockIos extends WebPlugin {
  // ---------- the database: sql.js in the web view (lib/boot.ts), so nothing here ----------

  // ---------- shops ----------
  /** Android makes this from inside the shop's page in a hidden browser; here it's a plain request with the app's cookies. */
  async storeFetch(o: { chain: string; method: 'GET' | 'POST'; url: string; body?: string }) {
    const r = await http({ method: o.method, url: o.url, body: o.body, headers: { Accept: 'application/json, text/plain, */*' } });
    return { status: r.status, body: r.body };
  }
  async plainFetch(o: { jar: string; method: 'GET' | 'POST'; url: string; headers?: Record<string, string>; body?: string; timeoutMs?: number }) {
    const r = await http(o);
    return { status: r.status, body: r.body, headers: r.headers };
  }
  /** The page as the shop sends it. (Android waits for the page's scripts to draw it; an iPhone can't do that yet.) */
  async storeRender(o: { chain: string; url: string; home?: string }) {
    const r = await http({ method: 'GET', url: o.url });
    return { status: r.status, html: r.body, url: r.url };
  }
  async openStore(): Promise<void> {
    throw new IosUnavailable("Opening a shop's page inside Restock");
  }

  // ---------- price checks: lib/check.ts runs them on iPhone (while Restock is open) ----------
  async scheduleChecks() {
    return { scheduled: false, due: false };
  }
  async checkNow() {
    return { checked: 0, updated: 0, errors: {} };
  }
  async priceHelperSchedule() {}
  async priceHelperStop() {}
  async priceHelperRunNow(): Promise<void> {
    throw new IosUnavailable('A price helper phone');
  }
  async priceHelperRunAll(): Promise<void> {
    throw new IosUnavailable('A price helper phone');
  }
  async priceHelperTest() {
    return { ok: false, error: new IosUnavailable('A price helper phone').message };
  }
  async sharePrices() {
    return { sent: 0 };
  }
  async importMarket(): Promise<never> {
    throw new IosUnavailable('Shared price history');
  }
  async scheduleRecalls() {}
  async checkRecalls() {
    return { checked: 0, found: 0, fresh: 0, errors: {} };
  }
  async serverSpend() {
    return { added: 0, skipped: 0 };
  }
  async serverSeen() {
    return { added: 0, skipped: 0 };
  }
  async serverData(): Promise<never> {
    throw new IosUnavailable('A Restock server');
  }

  // ---------- permissions, and the phone itself ----------
  async checkPermissions(): Promise<NativePermissions> {
    return { camera: await permission('camera'), location: await permission('geolocation') };
  }
  async requestPermissions(o: { permissions: (keyof NativePermissions)[] }): Promise<NativePermissions> {
    if (o.permissions.includes('camera')) {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        s.getTracks().forEach((t) => t.stop());
      } catch {
        return { camera: 'denied', location: await permission('geolocation') };
      }
    }
    if (o.permissions.includes('location')) await this.getLocation().catch(() => undefined);
    return this.checkPermissions();
  }
  getLocation(): Promise<{ lat: number; lon: number; accuracy: number }> {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) return reject(new Error('Location is off for Restock.'));
      navigator.geolocation.getCurrentPosition(
        (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude, accuracy: p.coords.accuracy }),
        (e) => reject(new Error(e.code === 1 ? 'Location is off for Restock. Turn it on in the iPhone Settings app, under Restock.' : "Couldn't find where you are. Try again in a moment.")),
        { enableHighAccuracy: false, timeout: 15000, maximumAge: 600000 },
      );
    });
  }
  async openAppSettings(): Promise<void> {
    // iOS opens an app's own page in Settings from this address.
    window.location.href = 'app-settings:';
  }
  /** The web view already keeps clear of the notch and the home bar (CSS env()). */
  async getInsets() {
    return { top: 0, bottom: 0 };
  }
  async setAppIcon() {
    return { ok: false };
  }
  /** iOS opens the keyboard itself when a box takes the cursor from a tap. */
  async showKeyboard() {}
  async notify(o: { id: number; title: string; body: string; action?: string }) {
    await LocalNotifications.schedule({ notifications: [{ id: o.id, title: o.title, body: o.body, extra: o.action ? { action: o.action } : undefined }] });
  }
  async installUpdate(): Promise<never> {
    throw new IosUnavailable('Updating from inside Restock');
  }
  async copyText(o: { text: string }) {
    await navigator.clipboard.writeText(o.text);
  }
  async updateWidgets() {}
  async requestBatteryExemption() {}
  async lensSearch() {
    return { opened: false };
  }
  async takeLaunchAction() {
    return {};
  }
  pause(o: { ms: number }): Promise<void> {
    return new Promise((r) => setTimeout(r, Math.max(0, Math.min(60000, o.ms))));
  }
  async searchTestStart() {}
  async searchTestProgress() {
    return { stop: false };
  }
  async searchTestEnd() {}
  async eraseNative() {
    await Filesystem.rmdir({ path: 'restock', directory: Directory.Data, recursive: true }).catch(() => undefined);
  }

  // ---------- files: Restock's own (receipt photos), and backups in the Files app ----------
  async writeAppFile(o: { path: string; data: string }) {
    await Filesystem.writeFile({ path: `restock/${o.path}`, data: o.data, directory: Directory.Data, recursive: true });
  }
  async readAppFile(o: { path: string }) {
    const r = await Filesystem.readFile({ path: `restock/${o.path}`, directory: Directory.Data });
    return { data: typeof r.data === 'string' ? r.data : '' };
  }
  async deleteAppFile(o: { path: string }) {
    await Filesystem.deleteFile({ path: `restock/${o.path}`, directory: Directory.Data }).catch(() => undefined);
  }
  async appFileInfo(o: { path: string }) {
    try {
      const s = await Filesystem.stat({ path: `restock/${o.path}`, directory: Directory.Data });
      return { uri: s.uri, exists: true, bytes: s.size };
    } catch {
      return { uri: '', exists: false, bytes: 0 };
    }
  }
  async deleteAppDir(o: { path: string }) {
    await Filesystem.rmdir({ path: `restock/${o.path}`, directory: Directory.Data, recursive: true }).catch(() => undefined);
  }
  async appFilesSize(o: { dir: string }) {
    const walk = async (path: string): Promise<number> => {
      let bytes = 0;
      const list = await Filesystem.readdir({ path, directory: Directory.Data }).catch(() => ({ files: [] }));
      for (const f of list.files) bytes += f.type === 'directory' ? await walk(`${path}/${f.name}`) : f.size;
      return bytes;
    };
    return { bytes: await walk(`restock/${o.dir}`.replace(/\/$/, '')) };
  }
  /**
   * Backups go in Restock's own folder in the Files app (On My iPhone → Restock → Restock backups).
   * An iPhone app can't be handed any other folder to keep writing to.
   */
  async backupDocuments() {
    return { available: true, uri: BACKUP_URI, name: 'Files → On My iPhone → Restock' };
  }
  async pickFolder() {
    return { uri: BACKUP_URI, name: 'Files → On My iPhone → Restock' };
  }
  async writeBackup(o: { uri: string; name: string; json: string; keep: number }) {
    await Filesystem.writeFile({ path: `${BACKUP_DIR}/${o.name}`, data: o.json, directory: Directory.Documents, encoding: Encoding.UTF8, recursive: true });
    let removed = 0;
    const all = (await Filesystem.readdir({ path: BACKUP_DIR, directory: Directory.Documents }).catch(() => ({ files: [] }))).files
      .filter((f) => f.type === 'file' && /^restock-.*\.json$/i.test(f.name))
      .sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0));
    for (const f of all.slice(Math.max(1, o.keep))) {
      await Filesystem.deleteFile({ path: `${BACKUP_DIR}/${f.name}`, directory: Directory.Documents })
        .then(() => removed++)
        .catch(() => undefined);
    }
    return { written: o.name, removed };
  }

  // ---------- Home Assistant: not on iPhone yet ----------
  async haHasToken() {
    return { saved: false };
  }
  async haForgetToken() {}
  async haSaveToken(): Promise<never> {
    throw new IosUnavailable('Home Assistant');
  }
  async haRequest(): Promise<never> {
    throw new IosUnavailable('Home Assistant');
  }
  async haRound(): Promise<never> {
    throw new IosUnavailable('Home Assistant');
  }
  async haResetPairing() {}

  // ---------- households, phone-to-phone and server sync: not on iPhone yet ----------
  async syncInfo(): Promise<SyncInfo> {
    return NO_SYNC;
  }
  async syncDismissNotice() {}
  async syncCloseInvite() {}
  async syncNextcloudCancel() {}
  async syncServerPoll() {
    return { received: 0 };
  }
  async syncServerHealth() {
    return {};
  }
}

// Everything else to do with sync says the same thing.
for (const m of [
  'syncInvite', 'syncStartHousehold', 'syncRemove', 'syncHandOver', 'syncCancelHandOver', 'syncRecovery', 'syncRecoverySaved', 'syncTakeOver',
  'syncSetFolder', 'syncSetWebDav', 'syncNextcloud', 'syncJoinServer', 'syncStopServer', 'syncWebCode', 'syncWebApprove', 'syncServerPhoto',
  'syncCheckServer', 'syncJoinHouse', 'syncSetServer', 'syncSetWifi', 'syncHandOverServer', 'syncPeek', 'syncJoin', 'syncNow', 'syncSet', 'syncLeave',
]) {
  (RestockIos.prototype as unknown as Record<string, () => Promise<never>>)[m] = async () => {
    throw new IosUnavailable('Sharing with a household');
  };
}
