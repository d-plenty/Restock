import { RestockNative } from './sql/native';
import { isNative } from '../stores/http';

/**
 * F-Droid installs and updates apps itself and doesn't allow apps that update themselves, so its
 * build (VITE_FDROID=1) leaves "Check for updates" out entirely.
 */
export const SELF_UPDATE = !import.meta.env.VITE_FDROID;

/** Where official Restock releases are published. */
export const RELEASES = 'https://github.com/d-plenty/Restock/releases';
const LATEST = 'https://api.github.com/repos/d-plenty/Restock/releases/latest';
const DAY = 86_400_000;
const WEEK = 7 * 86_400_000;

export interface UpdateInfo {
  /** "0.7.4" */
  version: string;
  newer: boolean;
  /** The release notes, as written on GitHub. */
  notes: string;
  /** The APK to install (the release's restock.apk). */
  apkUrl?: string;
  /**
   * 0.9.1: the APK's SHA-256 (lowercase hex) as GitHub published it, when it did: GitHub's own
   * digest of the file, or else the one in the release notes. installUpdate checks the download
   * against it.
   */
  sha256?: string;
  pageUrl: string;
}

/** A GitHub release, as much of it as Restock reads. */
export interface GitHubRelease {
  tag_name?: string;
  body?: string;
  html_url?: string;
  assets?: { name?: string; browser_download_url?: string; digest?: string | null }[];
}

const HEX64 = /^[0-9a-f]{64}$/;

/** A release asset's digest, "sha256:<64 hex>", as the hex (lowercase); anything else is undefined. */
export function assetSha256(digest: unknown): string | undefined {
  const m = typeof digest === 'string' ? /^sha256:([0-9a-f]{64})$/i.exec(digest.trim()) : null;
  return m ? m[1].toLowerCase() : undefined;
}

/**
 * The SHA-256 the release notes give for this release's APK, from a line like
 * "**SHA-256** of restock-0.9.1.apk: `<64 hex>`". restock.apk and restock-<version>.apk are the
 * same file, so either name counts; another version's file, or a differently named one
 * (restock-0.9.1-debug.apk), doesn't. Undefined if there's none, or if two lines disagree.
 */
export function notesSha256(notes: string | undefined, version: string): string | undefined {
  const want = version.replace(/^v/i, '').toLowerCase();
  const found = new Set<string>();
  for (const line of String(notes ?? '').split(/\r?\n/)) {
    if (!/sha-?256/i.test(line)) continue;
    const file = /(?<![\w.-])restock(?:-v?(\d[\w.+-]*?))?\.apk(?![\w.-])/i.exec(line);
    const hex = /(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])/i.exec(line);
    if (!file || !hex) continue;
    if (file[1] !== undefined && file[1].toLowerCase() !== want) continue;
    found.add(hex[0].toLowerCase());
  }
  return found.size === 1 ? [...found][0] : undefined;
}

/**
 * The SHA-256 to expect for the release's APK: GitHub's own digest of restock.apk (or of
 * restock-<version>.apk, the same file), else the release notes'. Undefined for older releases
 * that published neither.
 */
export function expectedSha256(r: GitHubRelease, version: string): string | undefined {
  const v = version.replace(/^v/i, '');
  const names = ['restock.apk', `restock-${v}.apk`, `restock-v${v}.apk`];
  for (const name of names) {
    const hex = assetSha256(r.assets?.find((a) => a.name === name)?.digest);
    if (hex) return hex;
  }
  return notesSha256(r.body, v);
}

/** 0.9.1: what the last check found for each APK address, for installUpdate. */
const published = new Map<string, string>();

/** Is version a newer than b? "0.7.10" is newer than "0.7.9". */
export function isNewer(a: string, b: string): boolean {
  const pa = a
    .replace(/^v/i, '')
    .split(/[.-]/)
    .map((x) => parseInt(x, 10) || 0);
  const pb = b
    .replace(/^v/i, '')
    .split(/[.-]/)
    .map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  }
  return false;
}

/** Asks GitHub for the latest release. Only called when you tap Check, or weekly if you turned that on. */
export async function checkForUpdate(current: string): Promise<UpdateInfo> {
  const res = await fetch(LATEST, { headers: { Accept: 'application/vnd.github+json' } });
  if (!res.ok) throw new Error(res.status === 403 ? 'GitHub is busy. Try again in a little while.' : `GitHub answered ${res.status}`);
  return readRelease((await res.json()) as GitHubRelease, current);
}

/** What GitHub's latest-release answer says (the part of checkForUpdate that doesn't need the network). */
export function readRelease(r: GitHubRelease, current: string): UpdateInfo {
  const version = String(r.tag_name ?? '').replace(/^v/i, '');
  if (!version) throw new Error("Couldn't read the latest version from GitHub");
  // 0.9.0: only the release's restock.apk, never just any APK attached to it. (The phone also checks
  // the download is a newer Restock, signed by Restock, before installing it: installUpdate in
  // RestockNativePlugin.java. 0.9.1: and, when GitHub published one, that its SHA-256 matches.)
  const apk = r.assets?.find((a) => a.name === 'restock.apk');
  const apkUrl = apk?.browser_download_url;
  const sha256 = apkUrl ? expectedSha256(r, version) : undefined;
  if (apkUrl && sha256) published.set(apkUrl, sha256);
  return {
    version,
    newer: isNewer(version, current),
    notes: String(r.body ?? '').trim(),
    apkUrl,
    sha256,
    pageUrl: r.html_url ?? RELEASES,
  };
}

/**
 * Downloads the new APK and opens Android's installer, which asks you to tap Install. The first
 * time, Android asks you to let Restock install apps instead; resolves "permission" then.
 *
 * 0.9.1: the download is checked against `sha256` (by default, what the last check found for this
 * address) before anything else; a file that doesn't match is deleted and this rejects with "The
 * download didn't match what GitHub published…". With none (older releases), the phone still
 * checks it's a newer Restock signed by Restock, and notes in its log that no SHA-256 was checked.
 */
export async function installUpdate(url: string, sha256 = published.get(url)): Promise<'started' | 'permission'> {
  if (!isNative()) throw new Error('Updating works in the Android app.');
  const hex = sha256?.trim().toLowerCase();
  if (hex !== undefined && !HEX64.test(hex)) throw new Error("The update's SHA-256 couldn't be read, so it wasn't installed.");
  let out: { needsPermission?: boolean };
  try {
    out = await RestockNative.installUpdate(hex ? { url, sha256: hex } : { url });
  } catch (e) {
    // 0.9.3: the release's file was replaced after Restock last checked (a fixed upload, say). Ask
    // GitHub again once, and try with what it publishes now; a second mismatch still refuses.
    const fresh = hex && /didn't match what GitHub published/.test(e instanceof Error ? e.message : String(e)) ? await recheck(url) : undefined;
    if (!fresh || fresh === hex) throw e;
    out = await RestockNative.installUpdate({ url, sha256: fresh });
  }
  return out.needsPermission ? 'permission' : 'started';
}

/** 0.9.3: what GitHub publishes now for this APK address, if the latest release still has it. */
async function recheck(url: string): Promise<string | undefined> {
  try {
    const res = await fetch(LATEST, { headers: { Accept: 'application/vnd.github+json' } });
    if (!res.ok) return undefined;
    const info = readRelease((await res.json()) as GitHubRelease, '0');
    return info.apkUrl === url && info.sha256 && HEX64.test(info.sha256) ? info.sha256.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

/** When "Tell me when there's an update" is on: due once its interval (every 24 hours by default, or every 7 days) has passed. */
export function weeklyCheckDue(u: { notify: boolean; lastCheck?: string; everyDays?: number } | undefined, now = Date.now()): boolean {
  // 0.9.3: every 24 hours unless the person picked every 7 days.
  const every = u?.everyDays === 7 ? WEEK : DAY;
  return !!u?.notify && (!u.lastCheck || now - Date.parse(u.lastCheck) >= every);
}
