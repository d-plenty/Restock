import { RestockNative } from './sql/native';
import { isNative } from '../stores/http';

/** Where official Restock releases are published. */
export const RELEASES = 'https://github.com/d-plenty/Restock/releases';
const LATEST = 'https://api.github.com/repos/d-plenty/Restock/releases/latest';
const WEEK = 7 * 86_400_000;

export interface UpdateInfo {
  /** "0.7.4" */
  version: string;
  newer: boolean;
  /** The release notes, as written on GitHub. */
  notes: string;
  /** The APK to install (the release's restock.apk). */
  apkUrl?: string;
  pageUrl: string;
}

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
  const r = (await res.json()) as {
    tag_name?: string;
    body?: string;
    html_url?: string;
    assets?: { name?: string; browser_download_url?: string }[];
  };
  const version = String(r.tag_name ?? '').replace(/^v/i, '');
  if (!version) throw new Error("Couldn't read the latest version from GitHub");
  const apk = r.assets?.find((a) => a.name === 'restock.apk') ?? r.assets?.find((a) => /\.apk$/i.test(a.name ?? ''));
  return {
    version,
    newer: isNewer(version, current),
    notes: String(r.body ?? '').trim(),
    apkUrl: apk?.browser_download_url,
    pageUrl: r.html_url ?? RELEASES,
  };
}

/**
 * Downloads the new APK and opens Android's installer, which asks you to tap Install. The first
 * time, Android asks you to let Restock install apps instead; resolves "permission" then.
 */
export async function installUpdate(url: string): Promise<'started' | 'permission'> {
  if (!isNative()) throw new Error('Updating works in the Android app.');
  const out = await RestockNative.installUpdate({ url });
  return out.needsPermission ? 'permission' : 'started';
}

/** Once a week, when "Tell me when there's an update" is on. Returns a newer version not told about yet. */
export function weeklyCheckDue(u: { notify: boolean; lastCheck?: string } | undefined, now = Date.now()): boolean {
  return !!u?.notify && (!u.lastCheck || now - Date.parse(u.lastCheck) >= WEEK);
}
