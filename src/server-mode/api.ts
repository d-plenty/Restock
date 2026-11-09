// Server mode: the Restock server's v2 API, as a signed-in browser uses it (docs/server-protocol.md).
// The session is an HttpOnly cookie the browser sends by itself; nothing here keeps a token.

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Where the API lives: the page's own server (the app is served from it). */
let base = '';
export const setApiBase = (b: string) => (base = b.replace(/\/+$/, ''));

function words(status: number, code: string): string {
  if (status === 429) return 'Too many tries. Wait 15 minutes and try again.';
  if (status === 401 && code === 'wrong') return "That user name or passphrase isn't right.";
  if (status === 401) return 'Signed out. Sign in again.';
  if (status === 403) return "This browser isn't allowed to do that.";
  if (status === 413) return 'That file is too big for the server.';
  if (status === 507) return 'The server is full.';
  return `The server answered ${status}${code ? ` (${code})` : ''}.`;
}

async function call(method: string, path: string, body?: unknown, raw?: Uint8Array, extra?: Record<string, string>): Promise<Response> {
  let r: Response;
  try {
    r = await fetch(base + path, {
      method,
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { ...(raw ? { 'Content-Type': 'application/octet-stream' } : body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...extra },
      body: raw ? (raw as BodyInit) : body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'offline', "Can't reach your Restock server. Check you're on the same network, or its away address.");
  }
  if (!r.ok) {
    const j = (await r
      .clone()
      .json()
      .catch(() => ({}))) as { error?: string; message?: string };
    const code = typeof j.error === 'string' ? j.error : '';
    if (r.status === 401) onSignedOut?.();
    throw new ApiError(r.status, code, typeof j.message === 'string' ? j.message : words(r.status, code));
  }
  return r;
}

let onSignedOut: (() => void) | undefined;
/** Called when the server says the session is gone (expired, or signed out everywhere). */
export const whenSignedOut = (fn: () => void) => (onSignedOut = fn);

const json = async <T>(r: Promise<Response>): Promise<T> => (await (await r).json().catch(() => ({}))) as T;

export interface FileInfo {
  name: string;
  size: number;
  modified?: string;
  version?: string;
  by?: string;
}

export interface Device {
  device: string;
  name?: string;
  added?: string;
  seen?: string;
  lastSeen?: string;
}

export interface Activity {
  at: string;
  who?: string;
  by?: string;
  device?: string;
  what: string;
  file?: string;
  size?: number;
  ip?: string;
}

export interface WebInfo {
  user?: string;
  webId?: string | null;
  webPub?: string | null;
  mustChange?: boolean;
}

export const api = {
  health: () => json<{ ok?: boolean; app?: string; version?: string; api?: number }>(call('GET', '/api/v2/health')),
  salt: (user: string) => json<{ salt: string }>(call('GET', `/api/v2/login/salt?user=${encodeURIComponent(user)}`)),
  login: (body: { user: string; password?: string; auth?: string }) =>
    json<{ mustChange?: boolean; vault?: string | null }>(call('POST', '/api/v2/login', body)),
  logout: (everywhere = false) => call('POST', '/api/v2/logout', everywhere ? { everywhere: true } : {}),
  /** `current`: the current passphrase's authKey (needed once a passphrase is set). */
  setPassphrase: (body: { salt: string; auth: string; vault: string; webId: string; webPub: string; current?: string }) => call('POST', '/api/v2/passphrase', body),
  getVault: () => json<{ vault?: string | null }>(call('GET', '/api/v2/vault')),
  putVault: (body: { vault: string; webId: string; webPub: string }) => call('PUT', '/api/v2/vault', body),
  web: () => json<WebInfo>(call('GET', '/api/v2/web')),
  invite: () => json<{ invite: string; expires?: string | number; expiresIn?: number; code?: string; home?: string; away?: string }>(call('POST', '/api/v2/invites', {})),
  devices: async () => (await json<{ devices?: Device[] }>(call('GET', '/api/v2/devices'))).devices ?? [],
  removeDevice: (id: string) => call('DELETE', `/api/v2/devices/${encodeURIComponent(id)}`),
  linkStart: () => json<{ id: string }>(call('POST', '/api/v2/link', {})),
  linkPoll: (id: string) => json<{ pending?: boolean; pub?: string; sealed?: string }>(call('GET', `/api/v2/link/${encodeURIComponent(id)}`)),
  qrStart: () => json<{ id: string }>(call('POST', '/api/v2/qrlogin', {})),
  qrPoll: (id: string) => json<{ pending?: boolean; pub?: string; sealed?: string; mustChange?: boolean }>(call('GET', `/api/v2/qrlogin/${encodeURIComponent(id)}`)),
  files: async () => (await json<{ files?: FileInfo[] }>(call('GET', '/api/v2/files'))).files ?? [],
  /** A file's bytes, or null when it isn't there. Names go in the path as they are (slashes too). */
  read: async (name: string): Promise<Uint8Array | null> => {
    try {
      return new Uint8Array(await (await call('GET', `/api/v2/files/${name}`)).arrayBuffer());
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return null;
      throw e;
    }
  },
  write: (name: string, bytes: Uint8Array, ifMatch?: string) =>
    json<{ name?: string; size?: number; version?: string }>(call('PUT', `/api/v2/files/${name}`, undefined, bytes, ifMatch ? { 'If-Match': `"${ifMatch}"` } : undefined)),
  activity: async () => (await json<{ activity?: Activity[] }>(call('GET', '/api/v2/activity'))).activity ?? [],
};
