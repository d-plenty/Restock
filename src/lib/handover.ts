// 0.14.0: sending a copy of your data straight to another phone, once, over the same Wi-Fi (Export
// data → Send to another phone; Import data → From another phone). The phone sending shows a QR
// code; the phone receiving scans it, connects, and is handed the same file an export makes. Nothing
// is paired and nothing is left behind: the code works once, for 10 minutes, and only while the
// sending phone has it on screen.
//
// On the wire it's the phones' own framing (4 bytes of length, then a nonce and AES-256-GCM sealed
// JSON, as SyncWire.java and ios/wire.ts). The key is made from the code, so only a phone that saw
// the code can read anything. It works between any two phones: the sockets are the iPhone app's
// (ios/lan.ts) or the Android app's (RestockNativePlugin's lan… calls), behind the same Lan.
import { Capacitor } from '@capacitor/core';
import { gunzipSync, gzipSync, strFromU8, strToU8 } from 'fflate';
import { sha256 } from '@noble/hashes/sha2';
import { base32, random, unbase32 } from '../server-mode/crypto';
import { appleLan, bridgeLan, fromB64, toB64, type LanBridge } from '../ios/lan';
import { open, seal, type Lan } from '../ios/wire';
import { isIos } from './platform';
import { RestockNative } from './sql/native';

const SEND_LIFE_MS = 10 * 60_000;
const CHUNK = 512 * 1024;
const CODE = /^RESTOCK-SEND:1:([A-Z2-7]{20,40}):(\d{1,3}(?:\.\d{1,3}){3}):(\d{2,5})$/;

export class SendProblem extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SendProblem';
  }
}

const keyOf = (token: Uint8Array) => {
  const tag = strToU8('restock-send');
  const both = new Uint8Array(tag.length + token.length);
  both.set(tag);
  both.set(token, tag.length);
  return sha256(both);
};

export const isSendCode = (text: string) => CODE.test((text ?? '').trim().replace(/\s+/g, '').toUpperCase());

/** The Wi-Fi on this device, or undefined where there isn't one to use (a web page). */
let androidLan: Lan | undefined;
export function deviceLan(): Lan | undefined {
  if (!Capacitor.isNativePlatform()) return undefined;
  if (isIos()) return appleLan();
  return (androidLan ??= bridgeLan(RestockNative as unknown as LanBridge));
}
/** Can this device send to, or receive from, another phone directly? */
export const canSendDirect = (): boolean => !!deviceLan();

export interface Offer {
  code: string;
  until: number;
  /** Resolves once the other phone has it all ('sent'), or the offer was stopped or ran out. */
  done: Promise<'sent' | 'stopped' | 'expired'>;
  stop(): void;
}

/**
 * The sending phone: listens, and gives the code to show. `text` is the file an export makes
 * (backup.ts backupJson). `onProgress`: how far the other phone has got, 0 to 1.
 */
export async function offerData(lan: Lan, text: string, about: { name: string }, onProgress: (part: number) => void = () => {}, now: () => number = () => Date.now()): Promise<Offer> {
  const ip = await lan.localIp().catch(() => null);
  if (!ip) throw new SendProblem("This phone isn't on Wi-Fi. Both phones need to be on the same Wi-Fi.");
  const token = random(16);
  const key = keyOf(token);
  const packed = gzipSync(strToU8(text));
  const chunks = Math.max(1, Math.ceil(packed.length / CHUNK));
  const until = now() + SEND_LIFE_MS;
  let taker: string | null = null;
  let finish: (how: 'sent' | 'stopped' | 'expired') => void = () => {};
  const done = new Promise<'sent' | 'stopped' | 'expired'>((ok) => (finish = ok));
  let over = false;
  const end = (how: 'sent' | 'stopped' | 'expired') => {
    if (over) return;
    over = true;
    clearTimeout(timer);
    // After the answer to "done" has gone out.
    setTimeout(() => listener.stop(), how === 'sent' ? 500 : 0);
    finish(how);
  };
  const listener = await lan.listen(
    async (conn, _from, frame) => {
      if (over || now() > until) return null;
      let m: Record<string, unknown>;
      try {
        m = open(key, frame);
      } catch {
        return null; // not someone who saw the code
      }
      // The code is for one phone: the first that says hello.
      if (taker !== null && taker !== conn) return seal(key, { error: 'Another phone is already receiving this. Make a new code to send it again.' });
      if (m.op === 'hello') {
        taker = conn;
        return seal(key, { v: 1, name: about.name, bytes: packed.length, chunks });
      }
      if (taker !== conn) return null;
      if (m.op === 'chunk') {
        const i = Number(m.i);
        if (!Number.isInteger(i) || i < 0 || i >= chunks) return seal(key, { error: 'That part does not exist.' });
        onProgress((i + 1) / chunks);
        return seal(key, { i, data: toB64(packed.subarray(i * CHUNK, Math.min(packed.length, (i + 1) * CHUNK))) });
      }
      if (m.op === 'done') {
        end('sent');
        return seal(key, { ok: true });
      }
      return seal(key, { error: 'unknown' });
    },
    (conn) => {
      // The other phone went away part-way: the code can be scanned again while it's still showing.
      if (conn === taker && !over) taker = null;
    },
    { key: 'send' },
  );
  const timer = setTimeout(() => end('expired'), SEND_LIFE_MS);
  return { code: `RESTOCK-SEND:1:${base32(token)}:${ip}:${listener.port}`, until, done, stop: () => end('stopped') };
}

/** The receiving phone: connects with the scanned code and brings the file back. */
export async function fetchData(lan: Lan, code: string, onProgress: (part: number, from: string) => void = () => {}): Promise<{ text: string; from: string }> {
  const m = CODE.exec((code ?? '').trim().replace(/\s+/g, '').toUpperCase());
  if (!m) throw new SendProblem("That isn't a code for receiving data. On the other phone, choose Export data, then Send to another phone.");
  const key = keyOf(unbase32(m[1]));
  let link;
  try {
    link = await lan.dial(m[2], Number(m[3]), 5000);
  } catch {
    throw new SendProblem("Couldn't reach the other phone. Keep the code showing on it, make sure both phones are on the same Wi-Fi, and try again.");
  }
  const ask = async (msg: Record<string, unknown>) => {
    let res: Record<string, unknown>;
    try {
      res = open(key, await link.ask(seal(key, msg)));
    } catch {
      throw new SendProblem('The other phone stopped answering. Keep the code showing on it and try again (a code works once, for 10 minutes).');
    }
    if (typeof res.error === 'string') throw new SendProblem(res.error);
    return res;
  };
  try {
    const hello = await ask({ op: 'hello', v: 1 });
    const chunks = Number(hello.chunks);
    const bytes = Number(hello.bytes);
    const from = typeof hello.name === 'string' && hello.name ? hello.name.slice(0, 60) : 'the other phone';
    if (!Number.isInteger(chunks) || chunks < 1 || chunks > 4096 || !(bytes >= 0)) throw new SendProblem("The other phone's answer wasn't one this phone understands. Update Restock on both.");
    const packed = new Uint8Array(bytes);
    let at = 0;
    for (let i = 0; i < chunks; i++) {
      const r = await ask({ op: 'chunk', i });
      const part = fromB64(String(r.data ?? ''));
      if (at + part.length > bytes) throw new SendProblem("What the other phone sent didn't add up. Try again.");
      packed.set(part, at);
      at += part.length;
      onProgress((i + 1) / chunks, from);
    }
    if (at !== bytes) throw new SendProblem("What the other phone sent didn't add up. Try again.");
    await ask({ op: 'done' }).catch(() => undefined);
    return { text: strFromU8(gunzipSync(packed)), from };
  } finally {
    link.close();
  }
}
