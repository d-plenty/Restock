// 0.15.0: an iPhone or iPad household's shared folder on Nextcloud or another WebDAV server, as well
// as in iCloud Drive (SyncDav.java on Android: DavFolder and Nextcloud's Login Flow v2). The folder
// household (ios/folderHouse.ts) works the same on either: each device's file is sealed with the
// household's key, so the server only ever holds a jumble. The password stays on this device, in
// the keychain; with Nextcloud it's an app password of Restock's own, never the person's own one.
import { strFromU8, strToU8 } from 'fflate';
import type { FolderIo } from './folderHouse';

export type DavHttp = (o: { method: string; url: string; headers: Record<string, string>; body?: Uint8Array }) => Promise<{ status: number; headers: Record<string, string>; bytes: Uint8Array }>;

export class DavProblem extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DavProblem';
  }
}

/** SyncDav.problem: a status in words. */
function davProblem(status: number, doing: string): DavProblem {
  switch (status) {
    case 401:
      return new DavProblem("The server didn't accept the user name or password.");
    case 403:
      return new DavProblem(`The server didn't let Restock ${doing}.`);
    case 404:
      return new DavProblem("That folder isn't on the server.");
    case 405:
      return new DavProblem("That address isn't a WebDAV folder.");
    case 409:
      return new DavProblem("The folder above that one isn't on the server.");
    case 413:
      return new DavProblem('The server said the file is too big.');
    case 423:
      return new DavProblem('That folder is locked on the server. Try again later.');
    case 507:
      return new DavProblem('The server is full.');
    default:
      return status >= 500 ? new DavProblem(`The server had a problem (${status}). Try again later.`) : new DavProblem(`The server answered ${status} when Restock tried to ${doing}.`);
  }
}

/** An https address (http only for a home network address), with the folder ending in "/". */
export function davAddress(typed: string): string {
  let t = (typed ?? '').trim();
  if (!/^[a-z]+:\/\//i.test(t)) t = 'https://' + t;
  let u: URL;
  try {
    u = new URL(t);
  } catch {
    throw new DavProblem("That doesn't look like a web address.");
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new DavProblem("That doesn't look like a web address.");
  if (u.username || u.password) throw new DavProblem('Put the user name and password in their own boxes, not in the address.');
  if (u.protocol === 'http:' && !isHomeHost(u.hostname)) throw new DavProblem('Use the https:// address. Plain http:// is only for a server on your home network.');
  u.hash = '';
  u.search = '';
  if (!u.pathname.endsWith('/')) u.pathname += '/';
  return u.toString();
}

/** A name on the home network: a private IP address, or a .local / single-word name. */
export function isHomeHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (/^(10\.|192\.168\.|127\.|169\.254\.)/.test(h)) return true;
  const m = /^172\.(\d+)\./.exec(h);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  if (/^(fc|fd)[0-9a-f]{2}:|^fe80:|^::1$/.test(h)) return true;
  return h.endsWith('.local') || !h.includes('.');
}

const field = (name: string) => new RegExp(`<(?:[A-Za-z0-9_.-]+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:[A-Za-z0-9_.-]+:)?${name}\\s*>`, 'i');
const unescapeXml = (s: string) =>
  s
    .replace(/&(#x[0-9a-fA-F]+|#[0-9]+|lt|gt|amp|quot|apos);/g, (_, e: string) =>
      e === 'lt' ? '<' : e === 'gt' ? '>' : e === 'amp' ? '&' : e === 'quot' ? '"' : e === 'apos' ? "'" : String.fromCodePoint(e.startsWith('#x') ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)),
    )
    .trim();
const fieldOf = (name: string, xml: string) => {
  const m = field(name).exec(xml);
  return m ? unescapeXml(m[1]) : null;
};
const COLLECTION = /<(?:[A-Za-z0-9_.-]+:)?collection\b/i;
const PROPFIND = '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:getetag/><d:getlastmodified/><d:getcontentlength/><d:resourcetype/></d:prop></d:propfind>';
const decodePath = (p: string) => {
  try {
    return decodeURIComponent(p);
  } catch {
    return p;
  }
};
const trimSlash = (p: string) => p.replace(/\/+$/, '');

/** The files in a PROPFIND answer (Depth 1): name, size and time, the folder itself and sub-folders left out. */
export function parseListing(xml: string, folderUrl: string): { name: string; size: number; mtime: number }[] {
  const self = trimSlash(decodePath(new URL(folderUrl).pathname));
  const out: { name: string; size: number; mtime: number }[] = [];
  const seen = new Set<string>();
  const re = new RegExp(field('response').source, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const part = m[1];
    const href = fieldOf('href', part);
    if (!href || COLLECTION.test(part)) continue;
    let path: string;
    try {
      path = new URL(href.replace(/ /g, '%20'), folderUrl).pathname;
    } catch {
      continue;
    }
    const p = trimSlash(decodePath(path));
    if (p === self) continue;
    const name = p.slice(p.lastIndexOf('/') + 1);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const mod = Date.parse(fieldOf('getlastmodified', part) ?? '');
    out.push({ name, size: Number(fieldOf('getcontentlength', part) ?? 0) || 0, mtime: Number.isFinite(mod) ? mod : 0 });
  }
  return out;
}

const basic = (user: string, pass: string) => 'Basic ' + btoa(String.fromCharCode(...strToU8(`${user}:${pass}`)));

/** Only Restock's own files: never a path, never anything outside the folder. */
const RESTOCK_FILE = /^restock-[A-Za-z0-9_.-]{1,120}$/;

/** A WebDAV folder as the folder household needs it. */
export function davFolder(o: { url: string; user: string; password: string }, http: DavHttp): FolderIo & { ensure(): Promise<void> } {
  const base = davAddress(o.url);
  const auth: Record<string, string> = o.user ? { Authorization: basic(o.user, o.password) } : {};
  const file = (name: string) => {
    if (!RESTOCK_FILE.test(name)) throw new DavProblem('Not a Restock file.');
    return base + encodeURIComponent(name);
  };
  const propfind = async (depth: '0' | '1', doing: string) => {
    const r = await http({ method: 'PROPFIND', url: base, headers: { ...auth, Depth: depth, 'Content-Type': 'application/xml; charset=utf-8' }, body: strToU8(PROPFIND) });
    if (r.status !== 207) throw davProblem(r.status, doing);
    return strFromU8(r.bytes);
  };
  return {
    /** Makes the folder if it isn't there yet, then checks it's a WebDAV folder Restock may use. */
    async ensure() {
      const mk = await http({ method: 'MKCOL', url: base, headers: { ...auth } });
      if (mk.status === 401) throw davProblem(401, 'open the folder');
      if (mk.status === 409 || mk.status === 507) throw davProblem(mk.status, 'make the folder');
      if (!COLLECTION.test(await propfind('0', 'open the folder'))) throw new DavProblem('That address is a file, not a folder.');
    },
    async list() {
      return parseListing(await propfind('1', 'look in the folder'), base).filter((f) => RESTOCK_FILE.test(f.name));
    },
    async read(name) {
      const r = await http({ method: 'GET', url: file(name), headers: { ...auth } });
      if (r.status === 404) return null;
      if (r.status !== 200) throw davProblem(r.status, `read ${name}`);
      return r.bytes;
    },
    async write(name, bytes) {
      const r = await http({ method: 'PUT', url: file(name), headers: { ...auth, 'Content-Type': 'application/octet-stream' }, body: bytes });
      if (r.status !== 200 && r.status !== 201 && r.status !== 204) throw davProblem(r.status, `save ${name}`);
    },
    async remove(name) {
      const r = await http({ method: 'DELETE', url: file(name), headers: { ...auth } });
      if (r.status !== 200 && r.status !== 204 && r.status !== 404) throw davProblem(r.status, `delete ${name}`);
    },
  };
}

// ---------- Nextcloud: Login Flow v2 (SyncDav.startLogin and pollLogin) ----------

/** The server part of a typed Nextcloud address (anything from /index.php, /apps/, /remote.php or /login on is dropped). */
export function nextcloudServer(typed: string): string {
  const u = new URL(davAddress(typed));
  let p = u.pathname;
  for (const cut of ['/index.php', '/apps/', '/remote.php', '/login']) {
    const i = p.indexOf(cut);
    if (i >= 0) p = p.slice(0, i);
  }
  return `${u.protocol}//${u.host}${trimSlash(p)}`;
}

/** Nextcloud's WebDAV folder for a signed-in user: {server}/remote.php/dav/files/{loginName}/{folder}/. */
export const nextcloudFolderUrl = (server: string, loginName: string, folder = 'Restock') =>
  `${trimSlash(server)}/remote.php/dav/files/${encodeURIComponent(loginName)}/${encodeURIComponent(folder.replace(/[/\\]/g, '').trim() || 'Restock')}/`;

export interface NextcloudLogin {
  server: string;
  login: string;
  endpoint: string;
  token: string;
}

/** Starts signing in: Nextcloud makes a sign-in page for Restock (open `login` in the browser). */
export async function startNextcloud(typed: string, http: DavHttp): Promise<NextcloudLogin> {
  const server = nextcloudServer(typed);
  const r = await http({ method: 'POST', url: `${server}/index.php/login/v2`, headers: {}, body: new Uint8Array() });
  if ([401, 403, 404, 405].includes(r.status)) throw new DavProblem("That doesn't look like a Nextcloud server. Check the address.");
  if (r.status !== 200) throw davProblem(r.status, 'start signing in');
  try {
    const j = JSON.parse(strFromU8(r.bytes)) as { login?: unknown; poll?: { token?: unknown; endpoint?: unknown } };
    const token = String(j.poll?.token ?? '');
    const login = String(j.login ?? '');
    const endpoint = String(j.poll?.endpoint ?? '');
    const sameKind = (a: string) => new URL(a).protocol === new URL(server).protocol || new URL(a).protocol === 'https:';
    if (!token || token.length > 1000 || !sameKind(login) || !sameKind(endpoint)) throw new Error('odd');
    return { server, login, endpoint, token };
  } catch {
    throw new DavProblem("That doesn't look like a Nextcloud server (its answer wasn't what Nextcloud sends).");
  }
}

/** Asks once whether the person has finished signing in. Undefined while they haven't. */
export async function pollNextcloud(l: NextcloudLogin, http: DavHttp): Promise<{ server: string; loginName: string; appPassword: string } | undefined> {
  const r = await http({ method: 'POST', url: l.endpoint, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: strToU8(`token=${encodeURIComponent(l.token)}`) });
  if (r.status === 404) return undefined; // not yet
  if (r.status !== 200) throw davProblem(r.status, 'finish signing in');
  const j = JSON.parse(strFromU8(r.bytes)) as { server?: unknown; loginName?: unknown; appPassword?: unknown };
  const loginName = String(j.loginName ?? '');
  const appPassword = String(j.appPassword ?? '');
  if (!loginName || !appPassword) throw new DavProblem("Nextcloud's answer was garbled.");
  return { server: l.server, loginName, appPassword };
}
