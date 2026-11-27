// 0.18.3: Export data → Connections (connections.ts): what goes in, and what a restore does with it.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls: { serverAdmin: unknown[]; haSaveToken: unknown[]; saveHa: unknown[] } = { serverAdmin: [], haSaveToken: [], saveHa: [] };
let role = 'admin';
let onServer = true;
vi.mock('./sql/native', () => ({
  RestockNative: {
    serverAdmin: async (o: { method: string; path: string; body?: unknown }) => {
      calls.serverAdmin.push(o);
      if (o.path === '/me') return { role };
      return { code: 'restock-server:3?h=http%3A%2F%2F192.168.1.20%3A8787&i=abc&k=' + 'k'.repeat(60), expires: '2026-11-29T00:00:00.000Z' };
    },
    haExportToken: async () => ({ token: 'tok-123', address: 'http://homeassistant.local:8123' }),
    haSaveToken: async (o: unknown) => void calls.haSaveToken.push(o),
  },
}));
vi.mock('./homeAssistant', () => ({
  getHaConfig: async () => ({ enabled: true, address: 'http://homeassistant.local:8123', entity: 'todo.shopping_list' }),
  saveHaConfig: async (p: unknown) => void calls.saveHa.push(p),
}));
vi.mock('./sync', () => ({
  syncInfo: async () => (onServer ? { server: true, serverApi: 3, serverLabel: 'Declan and Sarah', serverHome: 'http://192.168.1.20:8787', serverAway: 'https://restock-server.plenty.family' } : { paired: false }),
}));

const C = await import('./connections');

beforeEach(() => {
  calls.serverAdmin = [];
  calls.haSaveToken = [];
  calls.saveHa = [];
  role = 'admin';
  onServer = true;
});

describe('0.18.3: Connections', () => {
  it('from an admin phone: Home Assistant with its token, and the server with a day-long code (10 minutes sent straight across)', async () => {
    const c = await C.collectConnections(false);
    expect(c?.homeAssistant).toEqual({ address: 'http://homeassistant.local:8123', entity: 'todo.shopping_list', enabled: true, token: 'tok-123' });
    expect(c?.server).toMatchObject({ name: 'Declan and Sarah', home: 'http://192.168.1.20:8787', away: 'https://restock-server.plenty.family' });
    expect(c?.server?.code).toMatch(/^restock-server:3\?/);
    expect(calls.serverAdmin).toContainEqual({ method: 'POST', path: '/phones', body: { label: 'New phone', forExport: true } });
    await C.collectConnections(true);
    expect(calls.serverAdmin).toContainEqual({ method: 'POST', path: '/phones', body: { label: 'New phone' } });
    expect(C.describeConnections(c)).toBe('Home Assistant and the Restock server (Declan and Sarah)');
  });

  it("from a user phone: the server's addresses only", async () => {
    role = 'user';
    const c = await C.collectConnections(false);
    expect(c?.server?.code).toBeUndefined();
    expect(c?.server?.away).toBe('https://restock-server.plenty.family');
  });

  it('restoring: Home Assistant set up with its token; the code kept once for joining; no code: ask an admin', async () => {
    const c = await C.collectConnections(false);
    onServer = false;
    expect(await C.restoreConnections(c)).toEqual({ server: 'join' });
    expect(calls.haSaveToken).toEqual([{ token: 'tok-123', address: 'http://homeassistant.local:8123' }]);
    expect(calls.saveHa).toEqual([{ address: 'http://homeassistant.local:8123', entity: 'todo.shopping_list', enabled: true }]);
    expect(C.takePendingJoin()).toMatch(/^restock-server:3\?/);
    expect(C.takePendingJoin()).toBeUndefined();
    expect(await C.restoreConnections({ server: { home: 'http://192.168.1.20:8787' } })).toEqual({ server: 'ask' });
    // Already on a server: left alone.
    onServer = true;
    expect(await C.restoreConnections(c)).toEqual({});
    expect(await C.restoreConnections(undefined)).toEqual({});
  });
});
