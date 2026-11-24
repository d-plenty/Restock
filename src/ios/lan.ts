// 0.14.0: the Wi-Fi as the iPhone and iPad app's native side gives it (ios/App/App/RestockLan.swift):
// connections to another phone, listening for them, and finding them with Bonjour. ios/wire.ts and
// the one-time send (lib/handover.ts) do all the talking; this only carries whole messages.
import type { PluginListenerHandle } from '@capacitor/core';
import { appleHere, RestockApple } from './apple';
import { SERVICE, type Found, type Lan } from './wire';

export const toB64 = (b: Uint8Array) => {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
};
export const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** Is the Wi-Fi part in this build of the app's native side? */
export const lanHere = (): boolean => appleHere();

/** What the native side needs to give for a Lan to be made on it (the iPhone's plugin, and Android's: lib/handover.ts). */
export interface LanBridge {
  lanInfo(): Promise<{ ip?: string }>;
  lanDial(o: { host: string; port: number; timeoutMs?: number }): Promise<{ id: string }>;
  lanAsk(o: { id: string; data: string; timeoutMs?: number }): Promise<{ data: string }>;
  lanClose(o: { id: string }): Promise<void>;
  lanListen(o: { key: string; port?: number }): Promise<{ port: number }>;
  lanReply(o: { conn: string; data?: string }): Promise<void>;
  lanStop(o: { key: string }): Promise<void>;
  lanAdvertise?(o: { key: string; name: string; type: string; txt: Record<string, string> }): Promise<void>;
  lanUnadvertise?(o: { key: string }): Promise<void>;
  lanBrowse?(o: { type: string; ms: number }): Promise<{ found: { name?: string; host: string; port: number; txt?: Record<string, string> }[] }>;
  addListener(event: string, handler: (data: never) => void): Promise<PluginListenerHandle>;
}

type Answer = (conn: string, from: string, frame: Uint8Array) => Promise<Uint8Array | null>;

/** A Lan on a native bridge. The app's listeners share the bridge's two events, told apart by their key. */
export function bridgeLan(bridge: LanBridge): Lan {
  const listeners = new Map<string, { answer: Answer; ended: (conn: string) => void }>();
  let wired: Promise<void> | undefined;
  const wire = () =>
    (wired ??= (async () => {
      await bridge.addListener('lanMessage', (m: { key?: string; conn: string; from: string; data: string }) => {
        void (async () => {
          const l = listeners.get(m.key ?? 'sync');
          let res: Uint8Array | null = null;
          try {
            res = l ? await l.answer(m.conn, m.from, fromB64(m.data)) : null;
          } catch {
            res = null;
          }
          await bridge.lanReply(res ? { conn: m.conn, data: toB64(res) } : { conn: m.conn }).catch(() => {});
        })();
      });
      await bridge.addListener('lanEnded', (m: { key?: string; conn: string }) => listeners.get(m.key ?? 'sync')?.ended(m.conn));
    })());
  let advertisedKey = 'sync';
  return {
    async dial(host, port, timeoutMs) {
      const { id } = await bridge.lanDial({ host, port, timeoutMs });
      return {
        ask: async (frame) => fromB64((await bridge.lanAsk({ id, data: toB64(frame), timeoutMs: 60_000 })).data),
        close: () => void bridge.lanClose({ id }).catch(() => {}),
      };
    },
    async browse(ms) {
      if (!bridge.lanBrowse) return [];
      const { found } = await bridge.lanBrowse({ type: SERVICE, ms });
      return (found ?? []).filter((f) => f && typeof f.host === 'string' && f.port > 0).map((f): Found => ({ host: f.host, port: f.port, txt: f.txt ?? {} }));
    },
    async listen(answer, ended, opts) {
      const key = opts?.key ?? 'sync';
      await wire();
      listeners.set(key, { answer, ended });
      const { port } = await bridge.lanListen({ key, ...(opts?.port ? { port: opts.port } : {}) });
      return {
        port,
        stop: () => {
          listeners.delete(key);
          void bridge.lanStop({ key }).catch(() => {});
        },
      };
    },
    advertise: async (port, name, txt) => {
      void port;
      advertisedKey = 'sync';
      await bridge.lanAdvertise?.({ key: advertisedKey, name, type: SERVICE, txt });
    },
    unadvertise: async () => {
      await bridge.lanUnadvertise?.({ key: advertisedKey });
    },
    localIp: async () => (await bridge.lanInfo()).ip ?? null,
  };
}

let made: Lan | undefined;
export function appleLan(): Lan | undefined {
  if (!lanHere()) return undefined;
  return (made ??= bridgeLan(RestockApple as unknown as LanBridge));
}
