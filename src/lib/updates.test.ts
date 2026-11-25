import { beforeEach, describe, expect, it, vi } from 'vitest';

// 0.9.1: updates also check the APK's SHA-256, as GitHub published it.

const installs: { url: string; sha256?: string }[] = [];
vi.mock('./sql/native', () => ({
  RestockNative: {
    installUpdate: async (o: { url: string; sha256?: string }) => {
      installs.push(o);
      return { started: true, sha256Checked: !!o.sha256 };
    },
  },
}));
vi.mock('../stores/http', () => ({ isNative: () => true }));

const A = 'a'.repeat(64);
const B = '0123456789abcdef'.repeat(4);
const C = 'C'.repeat(64);
const URL_091 = 'https://github.com/d-plenty/Restock/releases/download/v0.9.1/restock.apk';

/** A GitHub "latest release" answer, as the API sends it (trimmed to what Restock reads). */
const release = (o: { digest?: string | null; body?: string; versioned?: string | null } = {}) => ({
  tag_name: 'v0.9.1',
  html_url: 'https://github.com/d-plenty/Restock/releases/tag/v0.9.1',
  body: o.body ?? '## Restock 0.9.1\n\nFixes and things.',
  assets: [
    { name: 'restock.apk', browser_download_url: URL_091, digest: o.digest === undefined ? `sha256:${A}` : o.digest },
    {
      name: 'restock-0.9.1.apk',
      browser_download_url: 'https://github.com/d-plenty/Restock/releases/download/v0.9.1/restock-0.9.1.apk',
      digest: o.versioned === undefined ? null : o.versioned,
    },
  ],
});

beforeEach(() => {
  installs.length = 0;
});

describe('reading the SHA-256 GitHub published', () => {
  it("reads a release asset's digest", async () => {
    const { assetSha256 } = await import('./updates');
    expect(assetSha256(`sha256:${A}`)).toBe(A);
    expect(assetSha256(`SHA256:${C}`)).toBe(C.toLowerCase());
    expect(assetSha256(` sha256:${B} `)).toBe(B);
    expect(assetSha256(undefined)).toBeUndefined();
    expect(assetSha256(null)).toBeUndefined();
    expect(assetSha256(`sha1:${'a'.repeat(40)}`)).toBeUndefined();
    expect(assetSha256(`sha256:${A}0`)).toBeUndefined();
    expect(assetSha256(A)).toBeUndefined();
  });

  it('reads the line in the release notes, for either name of the file', async () => {
    const { notesSha256 } = await import('./updates');
    expect(notesSha256(`Fixes.\n\n**SHA-256** of restock-0.9.1.apk: \`${B}\`\n`, '0.9.1')).toBe(B);
    expect(notesSha256(`**SHA-256** of restock.apk: \`${B}\``, '0.9.1')).toBe(B);
    expect(notesSha256(`SHA256 of restock-v0.9.1.apk: ${C}`, 'v0.9.1')).toBe(C.toLowerCase());
    expect(notesSha256(`- **SHA-256** of restock-0.9.1.apk:\r\n- other`, '0.9.1')).toBeUndefined(); // no hex on the line
    // Both names, same file, same value: fine.
    expect(notesSha256(`**SHA-256** of restock.apk: \`${B}\`\n**SHA-256** of restock-0.9.1.apk: \`${B}\``, '0.9.1')).toBe(B);
  });

  it("ignores another version's file, other files, and lines that disagree", async () => {
    const { notesSha256 } = await import('./updates');
    // The example line from 0.9.0's notes isn't 0.9.1's file.
    expect(notesSha256(`**SHA-256** of restock-0.9.0.apk: \`${B}\``, '0.9.1')).toBeUndefined();
    expect(notesSha256(`**SHA-256** of restock-0.9.1-debug.apk: \`${B}\``, '0.9.1')).toBeUndefined();
    expect(notesSha256(`**SHA-256** of notrestock.apk: \`${B}\``, '0.9.1')).toBeUndefined();
    expect(notesSha256(`**SHA-256** of restock-fdroid.apk: \`${B}\``, '0.9.1')).toBeUndefined();
    expect(notesSha256(`restock-0.9.1.apk: \`${B}\``, '0.9.1')).toBeUndefined(); // doesn't say SHA-256
    expect(notesSha256(`**SHA-256** of restock-0.9.1.apk: \`${B}a\``, '0.9.1')).toBeUndefined(); // 65 hex
    expect(notesSha256(`**SHA-256** of restock.apk: \`${A}\`\n**SHA-256** of restock-0.9.1.apk: \`${B}\``, '0.9.1')).toBeUndefined();
    expect(notesSha256(undefined, '0.9.1')).toBeUndefined();
    expect(notesSha256('', '0.9.1')).toBeUndefined();
  });

  it("prefers GitHub's own digest, then the versioned file's, then the notes", async () => {
    const { expectedSha256 } = await import('./updates');
    const notes = `**SHA-256** of restock-0.9.1.apk: \`${C}\``;
    expect(expectedSha256(release({ body: notes }), '0.9.1')).toBe(A);
    expect(expectedSha256(release({ digest: null, versioned: `sha256:${B}`, body: notes }), '0.9.1')).toBe(B);
    expect(expectedSha256(release({ digest: null, body: notes }), '0.9.1')).toBe(C.toLowerCase());
    expect(expectedSha256(release({ digest: 'sha256:nothex', body: notes }), '0.9.1')).toBe(C.toLowerCase());
    // An older release: nothing published.
    expect(expectedSha256(release({ digest: null }), '0.9.1')).toBeUndefined();
  });
});

describe('checking for and installing an update', () => {
  it("passes GitHub's SHA-256 on to the phone", async () => {
    const { readRelease, installUpdate } = await import('./updates');
    const info = readRelease(release(), '0.9.0');
    expect(info).toMatchObject({ version: '0.9.1', newer: true, apkUrl: URL_091, sha256: A });
    // Settings calls installUpdate(apkUrl) only: the SHA-256 from the check goes along by itself.
    expect(await installUpdate(URL_091)).toBe('started');
    expect(installs).toEqual([{ url: URL_091, sha256: A }]);
  });

  it('installs an older release without one (the phone still checks the signature)', async () => {
    const { readRelease, installUpdate } = await import('./updates');
    const url = 'https://github.com/d-plenty/Restock/releases/download/v0.8.9/restock.apk';
    const info = readRelease(
      { tag_name: 'v0.8.9', body: 'Old notes', assets: [{ name: 'restock.apk', browser_download_url: url }] },
      '0.8.8',
    );
    expect(info.sha256).toBeUndefined();
    await installUpdate(url);
    expect(installs).toEqual([{ url }]);
  });

  it('an explicit SHA-256 wins, and one that is not 64 hex is refused rather than skipped', async () => {
    const { installUpdate } = await import('./updates');
    await installUpdate(URL_091, C);
    expect(installs).toEqual([{ url: URL_091, sha256: C.toLowerCase() }]);
    await expect(installUpdate(URL_091, 'abc')).rejects.toThrow(/SHA-256/);
    expect(installs).toHaveLength(1);
  });

  it('only the release\'s restock.apk is offered, and no SHA-256 without it', async () => {
    const { readRelease } = await import('./updates');
    const info = readRelease({ tag_name: 'v0.9.1', body: `**SHA-256** of restock.apk: \`${B}\``, assets: [{ name: 'other.apk', browser_download_url: 'x' }] }, '0.9.0');
    expect(info.apkUrl).toBeUndefined();
    expect(info.sha256).toBeUndefined();
  });
});
