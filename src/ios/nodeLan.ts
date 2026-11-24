// For tests only: the Wi-Fi (ios/wire.ts Lan) over Node's own sockets on this computer, so the
// iPhone's side can talk to the Android app's Java code and to itself. Never part of the app.
import net from 'node:net';
import type { Found, Lan, Link } from './wire';

const frame = (b: Uint8Array) => {
  const out = Buffer.alloc(4 + b.length);
  out.writeUInt32BE(b.length, 0);
  out.set(b, 4);
  return out;
};

/** Splits a stream into 4-byte-length messages. */
function reader(onMessage: (m: Uint8Array) => void) {
  let buf = Buffer.alloc(0);
  return (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 4) {
      const n = buf.readUInt32BE(0);
      if (buf.length < 4 + n) return;
      onMessage(new Uint8Array(buf.subarray(4, 4 + n)));
      buf = buf.subarray(4 + n);
    }
  };
}

/** `air`: who is advertising (shared between the pretend devices of one test). */
export function nodeLan(air: Map<string, Found> = new Map()): Lan {
  let advertised: string | null = null;
  return {
    dial: (host, port, timeoutMs) =>
      new Promise<Link>((resolve, reject) => {
        const s = net.connect({ host, port, timeout: timeoutMs });
        let waiting: { ok: (b: Uint8Array) => void; no: (e: Error) => void } | null = null;
        s.on('data', reader((m) => {
          waiting?.ok(m);
          waiting = null;
        }));
        const fail = (e: Error) => {
          waiting?.no(e);
          waiting = null;
          reject(e);
        };
        s.on('error', fail);
        s.on('timeout', () => s.destroy(new Error('timed out')));
        s.on('close', () => fail(new Error('the other phone hung up')));
        s.on('connect', () =>
          resolve({
            ask: (b) =>
              new Promise<Uint8Array>((ok, no) => {
                waiting = { ok, no };
                s.write(frame(b));
              }),
            close: () => s.destroy(),
          }),
        );
      }),
    browse: async () => [...air.entries()].filter(([name]) => name !== advertised).map(([, f]) => f),
    listen: (answer, ended) =>
      new Promise((resolve) => {
        let n = 0;
        const server = net.createServer((s) => {
          const conn = `c${++n}`;
          let chain = Promise.resolve();
          s.on('data', reader((m) => {
            chain = chain.then(async () => {
              const res = await answer(conn, s.remoteAddress ?? '', m);
              if (res) s.write(frame(res));
              else s.destroy();
            });
          }));
          s.on('error', () => {});
          s.on('close', () => ended(conn));
        });
        server.listen(0, '127.0.0.1', () => resolve({ port: (server.address() as net.AddressInfo).port, stop: () => server.close() }));
      }),
    advertise: async (port, name, txt) => {
      if (advertised) air.delete(advertised);
      advertised = name;
      air.set(name, { host: '127.0.0.1', port, txt });
    },
    unadvertise: async () => {
      if (advertised) air.delete(advertised);
      advertised = null;
    },
    localIp: async () => '127.0.0.1',
  };
}
