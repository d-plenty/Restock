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
import { websiteOf } from '../shops';
import { appleHere, RestockApple } from './apple';
import * as sync from './sync';
import type { Section } from '../shops';
import { forgetPage, FRESH_MS, looksBlocked, pageFetch, pageRender } from './shopWeb';
import type { NativePermissions, SyncInfo } from '../lib/sql/native';

const NO_SYNC: SyncInfo = { paired: false, batteryExempt: true };
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const BACKUP_DIR = 'Restock backups';
const BACKUP_URI = 'ios-documents:';
const HA_FILE = 'restock-private/home-assistant.json';
/** HomeAssistant.java PATH. */
const HA_PATH = /^\/api\/[A-Za-z0-9_./-]{0,200}(\?return_response)?$/;

/** HomeAssistant.java base(): the address as scheme://host[:port], http when none was typed. */
export function haBase(typed: string): string {
  let t = (typed ?? '').trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) t = `http://${t}`;
  let u: URL;
  try {
    u = new URL(t);
  } catch {
    throw new Error("That doesn't look like an address. Try something like http://homeassistant.local:8123");
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('The address has to start with http:// or https://');
  if (u.username || u.password) throw new Error('Leave any user name out of the address.');
  if (u.protocol === 'http:' && !homeHost(u.hostname))
    throw new Error('Plain http only works for an address at home (like 192.168.1.20 or homeassistant.local) or on Tailscale. For any other address, use https://');
  return `${u.protocol}//${u.host}`;
}

/**
 * The rule sync keeps on Android (SyncDav.resolve): plain http only to an address at home or on
 * Tailscale. An iPhone app can't look a name up first, so it goes by the name itself: a private or
 * Tailscale number, a .local / .lan / .home.arpa / .internal / .ts.net name, or a bare one ("homeassistant").
 */
export function homeHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  if (h.includes(':')) return /^(fe80|fc|fd)/.test(h) || h === '::1';
  if (!h.includes('.')) return /^[a-z0-9-]+$/.test(h);
  return /\.(local|lan|home|home\.arpa|internal|ts\.net)$/.test(h);
}

/** A long-lived access token as pasted: no spaces or line breaks inside, and not absurdly long. */
function haToken(typed: string): string {
  const t = (typed ?? '').trim().replace(/^bearer\s+/i, '');
  if (!t || t.length > 4096 || /\s/.test(t)) throw new Error("That doesn't look like a Home Assistant token. Copy the whole long-lived access token and paste it again.");
  return t;
}

/** StoreWeb.COLES_STORE_PAGE: ".../find-stores/coles/qld/kirwan-0844". */
const COLES_STORE_PAGE = '/find-stores/[^?#]*?-(\\d{3,5})/?(?:[?#].*)?$';

/** StoreWeb.home: the shop's home page, ending in "/". */
export function shopHome(chain: string, given?: string): string | undefined {
  const site = websiteOf(chain) ?? (chain.startsWith('custom-') ? given : undefined) ?? (chain === 'aldi' ? 'https://www.aldi.com.au/' : undefined);
  if (!site) return undefined;
  try {
    const u = new URL(site);
    if (u.protocol !== 'https:') return undefined;
    return u.href.endsWith('/') ? u.href : `${u.href}/`;
  } catch {
    return undefined;
  }
}

/** StoreWeb.alsoAllowed: other sites of the same shop its pages may go to (signing in, its rewards program). */
const ALSO: Record<string, string[]> = { woolworths: ['everyday.com.au', 'woolworthsrewards.com.au'], coles: ['flybuys.com.au'] };

/** The hosts a shop's pages may be on: its own site without "www." (which covers its subdomains), and ALSO. */
export function shopHosts(chain: string, home: string): string[] {
  return [new URL(home).hostname.toLowerCase().replace(/^www\./, ''), ...(ALSO[chain] ?? [])];
}

/**
 * StoreWeb.onSite: `url` (a full address, or a path such as "/api/...") as a full https address on the
 * shop's own site, or undefined if it isn't one. "//elsewhere" and "/\\elsewhere" (which a browser
 * reads as another site) are refused.
 */
export function onSite(chain: string, url: string, home: string | undefined): string | undefined {
  if (!home || typeof url !== 'string' || !url || /[\\\s]/.test(url) || url.startsWith('//')) return undefined;
  let u: URL;
  try {
    u = new URL(url, home);
  } catch {
    return undefined;
  }
  if (u.protocol !== 'https:' || u.username || u.password) return undefined;
  const host = u.hostname.toLowerCase();
  return shopHosts(chain, home).some((h) => host === h || host.endsWith(`.${h}`)) ? u.href : undefined;
}

// Without the native plugin: a plain request, after a visit to the shop's home page (its cookies, and Coles' key).
const visited = new Map<string, { at: number; key?: string }>();
async function plainShopFetch(chain: string, home: string, method: 'GET' | 'POST', full: string, body?: string): Promise<{ status: number; body: string }> {
  const attempt = async (fresh: boolean) => {
    let v = visited.get(chain);
    if (fresh || !v || Date.now() - v.at > FRESH_MS) {
      const page = await http({ method: 'GET', url: home, headers: { Accept: 'text/html' } }).catch(() => undefined);
      v = { at: Date.now(), key: chain === 'coles' ? page?.body.match(/BFF_API_SUBSCRIPTION_KEY["']?\s*:\s*["']([^"']+)["']/)?.[1] : undefined };
      visited.set(chain, v);
    }
    let url = full;
    if (chain === 'coles') {
      if (!v.key) return { status: 0, body: 'no key' };
      url += `${url.includes('?') ? '&' : '?'}subscription-key=${encodeURIComponent(v.key)}`;
    }
    const r = await http({ method, url, body, headers: { Accept: 'application/json, text/plain, */*', Referer: home, Origin: home.replace(/\/$/, '') } });
    return { status: r.status, body: r.body };
  };
  let r = await attempt(false);
  if (looksBlocked(r)) r = await attempt(true);
  return r;
}

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
  /**
   * A request from inside the shop's own page. 0.13.2: in a hidden browser, as on Android (ios/shopWeb.ts
   * on the native plugin). Without the plugin (an older build of the native side) it's a plain request
   * that visits the shop's home page first, for its cookies and, at Coles, its key.
   */
  async storeFetch(o: { chain: string; method: 'GET' | 'POST'; url: string; body?: string; home?: string }) {
    const home = shopHome(o.chain, o.home);
    const full = onSite(o.chain, o.url, home);
    if (!home || !full) throw new Error('Not a shop address Restock uses');
    if (appleHere()) return pageFetch(o.chain, home, o.method, o.url, o.body);
    return plainShopFetch(o.chain, home, o.method, full, o.body);
  }
  async plainFetch(o: { jar: string; method: 'GET' | 'POST'; url: string; headers?: Record<string, string>; body?: string; timeoutMs?: number }) {
    const r = await http(o);
    return { status: r.status, body: r.body, headers: r.headers };
  }
  /** The page once its scripts have drawn it (the hidden browser); without the plugin, the page as the shop sends it. */
  async storeRender(o: { chain: string; url: string; home?: string }) {
    const home = shopHome(o.chain, o.home);
    if (!home || !onSite(o.chain, o.url, home)) throw new Error('Not a page of a shop Restock uses');
    if (appleHere()) return pageRender(o.chain, o.url);
    const r = await http({ method: 'GET', url: o.url });
    return { status: r.status, html: r.body, url: r.url };
  }
  /** The shop's website on screen (signing in, picking a branch, passing its "are you a person" check). */
  async openStore(o: { chain: string; home?: string; path?: string; message?: string; record?: boolean; pickStore?: boolean }) {
    if (!appleHere()) throw new IosUnavailable("Opening a shop's page inside Restock");
    if (o.record) throw new IosUnavailable('Recording a trolley');
    const home = shopHome(o.chain, o.home);
    if (!home) throw new Error('Not a shop Restock uses');
    const url = o.path ? onSite(o.chain, o.path, home) : home;
    if (!url) throw new Error("Not a page on that shop's website");
    const out = await RestockApple.webOpen({ url, message: o.message, allowed: shopHosts(o.chain, home), closeOn: o.pickStore ? COLES_STORE_PAGE : undefined });
    // What the visit left (a sign-in, a passed check) is used by the hidden page from its next load.
    forgetPage(o.chain);
    return o.pickStore && out.matched ? { storePage: out.url } : {};
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
  // 0.13.2: the server's Your data, as on Android (sealed with the household's server key: ios/house.ts).
  async serverSpend(o: { rows: Record<string, unknown>[] }) {
    return sync.serverRows('spend', o?.rows ?? []);
  }
  async serverSeen(o: { rows: Record<string, unknown>[] }) {
    return sync.serverRows('seen', o?.rows ?? []);
  }
  async serverData(o: { path: string }) {
    return sync.serverData(o?.path ?? '');
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
      .filter((f) => f.type === 'file' && /^restock-auto-.*\.json$/i.test(f.name))
      .sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0));
    for (const f of all.slice(Math.max(1, o.keep))) {
      await Filesystem.deleteFile({ path: `${BACKUP_DIR}/${f.name}`, directory: Directory.Documents })
        .then(() => removed++)
        .catch(() => undefined);
    }
    return { written: o.name, removed };
  }

  // ---------- Home Assistant (0.13.2): the token and the requests here; the rounds are haSync.ts ----------
  // The token is kept in Restock's own storage on the iPhone (its Library folder, which the Files app
  // doesn't show), and only ever goes to the address it was saved for (as HomeAssistant.java).
  private async haSaved(): Promise<{ token: string; for: string } | undefined> {
    try {
      const r = await Filesystem.readFile({ path: HA_FILE, directory: Directory.Library, encoding: Encoding.UTF8 });
      const v = JSON.parse(typeof r.data === 'string' ? r.data : '') as { token?: unknown; for?: unknown };
      return typeof v.token === 'string' && typeof v.for === 'string' && v.token ? { token: v.token, for: v.for } : undefined;
    } catch {
      return undefined;
    }
  }
  async haHasToken() {
    return { saved: !!(await this.haSaved()) };
  }
  async haForgetToken() {
    await Filesystem.deleteFile({ path: HA_FILE, directory: Directory.Library }).catch(() => undefined);
  }
  async haSaveToken(o: { token: string; address: string }) {
    const token = haToken(o.token);
    await Filesystem.writeFile({ path: HA_FILE, directory: Directory.Library, encoding: Encoding.UTF8, recursive: true, data: JSON.stringify({ token, for: haBase(o.address) }) });
  }
  async haRequest(o: { address: string; method: 'GET' | 'POST'; path: string; body?: string; token?: string }) {
    if (o.method !== 'GET' && o.method !== 'POST') throw new Error('Only GET and POST');
    if (!HA_PATH.test(o.path) || o.path.includes('..')) throw new Error('Not a Home Assistant API path');
    const at = haBase(o.address);
    let token: string;
    if (o.token && o.token.trim()) token = haToken(o.token);
    else {
      const saved = await this.haSaved();
      if (!saved) throw new Error('No Home Assistant token is saved on this iPhone.');
      // The saved token only goes to the address it was saved for, whatever the screens ask.
      if (saved.for !== at) throw new Error("Home Assistant's address has changed. Tap Change and paste the token in again, so it's only sent to the new address.");
      token = saved.token;
    }
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
    if (o.body !== undefined) headers['Content-Type'] = 'application/json';
    const r = await http({ method: o.method, url: at + o.path, headers, body: o.body, timeoutMs: 20000 });
    return { status: r.status, body: r.body };
  }
  /** No round of its own here: lib/homeAssistant.ts hears "not implemented" and runs haSync.ts itself. */
  async haRound(): Promise<never> {
    throw this.unimplemented('haRound is not implemented on iOS: the round runs in haSync.ts');
  }
  async haResetPairing() {}

  // ---------- households (0.13.2): a Restock server's house, while Restock is open (ios/sync.ts) ----------
  // Phone sharing with an Android phone and iCloud sync aren't in this build; what isn't here says so.
  private syncWired = false;
  /** The screens hear about changes that came in and rounds that finished, as on Android. */
  private wireSyncEvents(): void {
    if (this.syncWired) return;
    this.syncWired = true;
    sync.setSyncEvents({ changed: () => this.notifyListeners('syncChanged', {}), done: (i) => this.notifyListeners('syncDone', i) });
  }
  async syncInfo(): Promise<SyncInfo> {
    this.wireSyncEvents();
    try {
      return sync.info();
    } catch {
      return NO_SYNC;
    }
  }
  async syncNow() {
    this.wireSyncEvents();
    return sync.syncNow();
  }
  async syncServerPoll() {
    this.wireSyncEvents();
    try {
      return await sync.serverPoll();
    } catch {
      return { received: 0 }; // not open yet, or out of reach: the next look tries again
    }
  }
  async syncCheckServer(o: { code: string }) {
    return sync.checkServer(o.code);
  }
  async syncJoinServer3(o: { code: string; how: 'join' | 'bring' | 'leave' }) {
    this.wireSyncEvents();
    return sync.joinServer3(o.code, o.how);
  }
  async syncSetServer(o: { label?: string; tabs?: Section[]; receipts?: boolean; cards?: boolean; takeBack?: string[] }) {
    return sync.setServer(o);
  }
  /** What this device shares, from the household's own screen: only its tabs here. */
  async syncSet(o: { name?: string; household?: string; tabs?: Section[]; shareCards?: boolean }) {
    if (o.shareCards !== undefined) sync.setServer({ cards: o.shareCards });
    // The household's name: an iCloud household's first device changes it (a server's house is named on the server).
    if (o.household !== undefined) {
      const { house, folder, saved } = sync.hub();
      if (house.joined()) throw new Error("Your household's name is changed on your Restock server's page.");
      if (folder.joined()) {
        folder.rename(o.household);
        saved();
      }
    }
    if (o.name !== undefined) {
      const { e, saved } = sync.hub();
      e.setMeta('name', o.name.trim().slice(0, 40) || 'iPhone');
      saved();
    }
    return o.tabs ? sync.setServer({ tabs: o.tabs }) : sync.info();
  }
  async syncStopServer(o: { bringBack?: boolean; takeBack?: string[] }) {
    this.wireSyncEvents();
    return sync.stopServer({ takeBack: o?.takeBack });
  }
  /** Leaving the household: in a house, that's leaving the server. */
  async syncLeave() {
    this.wireSyncEvents();
    const r = await sync.stopServer({});
    return { ...r, left: r.left !== false };
  }
  async syncServerHealth() {
    return sync.serverHealth().catch(() => ({}));
  }
  async syncDismissNotice() {
    try {
      sync.dismissNotice();
    } catch {
      // nothing open yet: nothing to dismiss
    }
  }
  /** 0.14.0: Sign in on a computer: the code on the server's sign-in page. */
  async syncWebCode(o: { code: string }) {
    return sync.webCode(o.code);
  }
  async syncWebApprove(o: { code: string }) {
    return sync.webApprove(o.code);
  }
  async syncCloseInvite() {}
  async syncNextcloudCancel() {}
  async syncJoinServer(): Promise<never> {
    throw new Error('That code is from an older Restock server. On iPhone and iPad, Restock joins a server that is the house: update the server, choose "Make this server the house" on its page, then scan a new Add a phone code.');
  }
}

// Everything else to do with sync says the same thing.
for (const m of [
  'syncInvite', 'syncStartHousehold', 'syncRemove', 'syncHandOver', 'syncCancelHandOver', 'syncRecovery', 'syncRecoverySaved', 'syncTakeOver',
  'syncSetFolder', 'syncSetWebDav', 'syncNextcloud', 'syncServerPhoto',
  'syncJoinHouse', 'syncSetWifi', 'syncHandOverServer', 'syncPeek', 'syncJoin',
]) {
  (RestockIos.prototype as unknown as Record<string, () => Promise<never>>)[m] = async () => {
    throw new IosUnavailable('That way of sharing');
  };
}
