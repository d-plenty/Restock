// 0.18.3: Export data → Connections (Restock server, Home Assistant). "Settings and shops" never had
// them (the Home Assistant token is kept outside the database, the server's keys are this phone's
// own), so a new phone had to be set up with each again. With this ticked (off to start with, and
// only for a file locked with a password or a copy sent straight to another phone), the file also has:
// - Home Assistant: its address, its to-do list, on or off, and the token, so it just works there;
// - the Restock server: its two addresses and, from an admin phone, a code for the new phone to join
//   with (for one phone: 24 hours in a file, 10 minutes when sent straight across). The new phone
//   joins as a phone of its own, never as a copy of this one (two phones that look like one would
//   overwrite each other's changes on the server). Not from an admin phone: the addresses only,
//   and the new phone is told to ask an admin for a code.
import { RestockNative } from './sql/native';
import { getHaConfig, saveHaConfig } from './homeAssistant';
import { syncInfo } from './sync';

export interface Connections {
  homeAssistant?: { address: string; entity: string; enabled: boolean; token?: string };
  server?: { name?: string; home?: string | null; away?: string | null; code?: string; until?: string };
}

const isAdminPhone = async () => {
  try {
    const me = (await RestockNative.serverAdmin({ method: 'GET', path: '/me' })) as { role?: string };
    return me.role === 'admin';
  } catch {
    return false;
  }
};

/** What goes in the file. `direct`: sent straight to another phone (the code lasts 10 minutes, not 24 hours). */
export async function collectConnections(direct: boolean): Promise<Connections | undefined> {
  const out: Connections = {};
  try {
    const ha = await getHaConfig();
    if (ha.address) {
      const t = await RestockNative.haExportToken().catch(() => undefined);
      out.homeAssistant = { address: ha.address, entity: ha.entity, enabled: ha.enabled, ...(t?.token ? { token: t.token } : {}) };
    }
  } catch {
    // no Home Assistant here
  }
  try {
    const info = await syncInfo();
    if (info.server && info.serverApi === 3) {
      const s: NonNullable<Connections['server']> = { name: info.serverLabel ?? info.household ?? undefined, home: info.serverHome ?? null, away: info.serverAway ?? null };
      if (await isAdminPhone()) {
        const r = (await RestockNative.serverAdmin({ method: 'POST', path: '/phones', body: { label: 'New phone', ...(direct ? {} : { forExport: true }) } })) as { code?: string; expires?: string };
        if (typeof r.code === 'string') {
          s.code = r.code;
          if (typeof r.expires === 'string') s.until = r.expires;
        }
      }
      out.server = s;
    }
  } catch {
    // not on a server, or out of reach: the file goes without it
  }
  return out.homeAssistant || out.server ? out : undefined;
}

/** What a file's connections are, for the restore sheet's words. */
export function describeConnections(c: Connections | undefined): string | undefined {
  if (!c) return undefined;
  const bits = [c.homeAssistant ? 'Home Assistant' : '', c.server ? `the Restock server${c.server.name ? ` (${c.server.name})` : ''}` : ''].filter(Boolean);
  return bits.length ? bits.join(' and ') : undefined;
}

let pendingJoin: string | undefined;
/** The server code a restore brought (once): the screen after it opens Restock server with it. */
export function takePendingJoin(): string | undefined {
  const c = pendingJoin;
  pendingJoin = undefined;
  return c;
}
export const hasPendingJoin = () => !!pendingJoin;

/** Puts them back on this phone. Returns what to say about the server (a code to join with, or to ask for one). */
export async function restoreConnections(c: Connections | undefined): Promise<{ server?: 'join' | 'ask' }> {
  if (!c || typeof c !== 'object') return {};
  const ha = c.homeAssistant;
  if (ha && typeof ha.address === 'string' && ha.address) {
    if (typeof ha.token === 'string' && ha.token) await RestockNative.haSaveToken({ token: ha.token, address: ha.address }).catch(() => undefined);
    await saveHaConfig({ address: ha.address, ...(typeof ha.entity === 'string' && ha.entity ? { entity: ha.entity } : {}), enabled: ha.enabled === true }).catch(() => undefined);
  }
  const s = c.server;
  if (!s || typeof s !== 'object') return {};
  const info = await syncInfo().catch(() => undefined);
  // Already on a server: left as it is.
  if (info?.server) return {};
  if (typeof s.code === 'string' && s.code.startsWith('restock-server:3?')) {
    pendingJoin = s.code;
    return { server: 'join' };
  }
  return { server: 'ask' };
}
