import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { downloadReader, modelOk, READER_BYTES, READER_MODELS, READER_SIZE_TEXT, READER_SOURCE, readerDownloaded, removeReader, sha256Hex, type ModelStore } from './readerModels';

// The photo reader's download: what is fetched, how it's checked, and what is kept.

const real = (file: string) => {
  const b = readFileSync(`src/assets/reader/${file}`);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};
const mem = () => {
  const m = new Map<string, ArrayBuffer>();
  const s: ModelStore & { m: Map<string, ArrayBuffer>; full?: boolean } = {
    m,
    get: async (k) => m.get(k),
    put: async (k, b) => {
      if (s.full) throw new Error('QuotaExceededError');
      m.set(k, b);
    },
    remove: async (k) => void m.delete(k),
  };
  return s;
};

describe('the photo reader download', () => {
  it('expects exactly the model files in the repository, by size and fingerprint', () => {
    for (const m of READER_MODELS) {
      const b = readFileSync(`src/assets/reader/${m.file}`);
      expect(b.length, m.file).toBe(m.bytes);
      expect(createHash('sha256').update(b).digest('hex'), m.file).toBe(m.sha256);
    }
    expect(READER_BYTES).toBe(21_450_882);
    expect(READER_SIZE_TEXT).toBe('21 MB');
    // A fixed release tag on Restock's own repository: the files can't change under an installed app.
    expect(READER_SOURCE).toBe('https://raw.githubusercontent.com/d-plenty/Restock/v0.14.0/src/assets/reader/');
  });

  it('downloads both, checks them, keeps them, and reports progress to the end', async () => {
    const store = mem();
    const asked: string[] = [];
    const seen: number[] = [];
    await downloadReader((done) => seen.push(done), {
      store,
      fetchFile: async (url, onBytes) => {
        asked.push(url);
        const b = real(url.slice(READER_SOURCE.length));
        onBytes(b.byteLength / 2);
        onBytes(b.byteLength);
        return b;
      },
    });
    expect(asked).toEqual(READER_MODELS.map((m) => READER_SOURCE + m.file));
    expect(await readerDownloaded(store)).toBe(true);
    expect(seen[seen.length - 1]).toBe(READER_BYTES);
    expect([...seen]).toEqual([...seen].sort((a, b) => a - b));
    // Already here: nothing is fetched again.
    await downloadReader(undefined, { store, fetchFile: async () => Promise.reject(new Error('should not be asked')) });
  });

  it('never keeps a file that is not exactly the one expected', async () => {
    const store = mem();
    const wrong = new ArrayBuffer(READER_MODELS[0].bytes); // the right size, the wrong contents
    await expect(downloadReader(undefined, { store, fetchFile: async () => wrong })).rejects.toThrow('didn’t match');
    expect(store.m.size).toBe(0);
    expect(await readerDownloaded(store)).toBe(false);
    expect(await modelOk(READER_MODELS[0], new ArrayBuffer(10))).toBe(false);
    expect(await modelOk(READER_MODELS[0], undefined)).toBe(false);
  });

  it('says so when there is no room, or when GitHub cannot be reached', async () => {
    const store = mem();
    store.full = true;
    await expect(downloadReader(undefined, { store, fetchFile: async (url) => real(url.slice(READER_SOURCE.length)) })).rejects.toThrow('isn’t room');
    await expect(downloadReader(undefined, { store: mem(), fetchFile: async () => Promise.reject(new Error('GitHub answered 503')) })).rejects.toThrow('503');
  });

  it('a download cut short picks up where it left off: only the missing file is fetched', async () => {
    const store = mem();
    store.m.set('det', real(READER_MODELS[0].file));
    const asked: string[] = [];
    await downloadReader(undefined, { store, fetchFile: async (url) => (asked.push(url), real(url.slice(READER_SOURCE.length))) });
    expect(asked).toEqual([READER_SOURCE + READER_MODELS[1].file]);
  });

  it('can be removed, and is then not there', async () => {
    const store = mem();
    for (const m of READER_MODELS) store.m.set(m.key, real(m.file));
    expect(await readerDownloaded(store)).toBe(true);
    await removeReader(store);
    expect(await readerDownloaded(store)).toBe(false);
  });

  it('fingerprints as SHA-256', async () => {
    expect(await sha256Hex(new TextEncoder().encode('abc').buffer as ArrayBuffer)).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
