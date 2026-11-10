// 0.9.5: @capacitor/core in the server's core build (vite.core.config.ts aliases it here). The shop
// connections (src/stores/*) import it for the phone's native requests and hidden browser; on the
// server neither exists, so it's never a native platform and any plugin call says so. Requests go
// through src/stores/node.ts instead (http.ts setTransport).

const NOT_HERE = 'Not on the Restock server (phone only).';

export const Capacitor = {
  isNativePlatform: () => false,
  getPlatform: () => 'server',
};

/** A plugin whose every method refuses. */
export function registerPlugin<T = unknown>(name: string): T {
  return new Proxy(
    {},
    {
      get: (_t, prop) =>
        prop === 'then'
          ? undefined
          : () => {
              throw new Error(`${name}.${String(prop)}: ${NOT_HERE}`);
            },
    },
  ) as T;
}

export const CapacitorHttp = registerPlugin<{ request: (o: unknown) => Promise<never> }>('CapacitorHttp');

export type PermissionState = 'granted' | 'denied' | 'prompt' | 'prompt-with-rationale';
export interface PluginListenerHandle {
  remove: () => Promise<void>;
}
