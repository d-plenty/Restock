// 0.9.5: the rules the web app's service worker (sw.ts) follows, kept apart so they can be tested
// and so the build (vite.server.config.ts) uses the very same list of what goes in the app shell.
//
// - The app shell (the page, its scripts, styles, the database and barcode decoders, the icons and
//   the manifest) is cached under one name per build: restock-shell-<build id>. A new build is a
//   new name, so an update never mixes old and new files, and the old cache goes once it takes over.
// - Nothing from /api/ is ever cached by the worker (the household stays in the page's own copy,
//   which goes when you sign out), and /setup/ is left alone.

export const SHELL_PREFIX = 'restock-shell-';

/** The worker's own file name, at the app's root (so its scope is the whole app). */
export const SW_FILE = 'sw.js';

/** What the build hands the worker: its id and the files to keep, relative to the app's root. */
export interface ShellManifest {
  build: string;
  /** 0.9.6: the app's version (package.json), for the worker's answer to "shell". */
  version?: string;
  files: string[];
}

/** Big files not needed offline (the phone's receipt reader; the QR maker for Add a phone), left out of the shell. */
const LEAVE_OUT = /(^|\/)(tesseract[^/]*|[^/]*traineddata[^/]*|worker\.min[^/]*|zxing_writer[^/]*\.wasm)$/i;
const KEEP = /\.(html|js|mjs|css|wasm|woff2?|ttf|png|svg|ico|webmanifest)$/i;

/** Which of the build's files go in the app shell (sorted, so the build id is stable). */
export function shellFiles(names: string[]): string[] {
  const out = new Set<string>();
  for (const raw of names) {
    const n = raw.replace(/^\.?\//, '');
    if (!n || n === SW_FILE || n.endsWith('.map') || n.split('/').some((p) => p.startsWith('.'))) continue;
    if (LEAVE_OUT.test(n) || !KEEP.test(n)) continue;
    out.add(n);
  }
  return [...out].sort();
}

/** A short id for a build: FNV-1a over its shell's file names (they carry content hashes) and any extra text. */
export function buildId(files: string[], extra = ''): string {
  let h = 0x811c9dc5;
  const text = files.join('\n') + '\n' + extra;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36).padStart(7, '0');
}

export const cacheName = (build: string) => SHELL_PREFIX + build;

/** The caches to delete once this build's worker takes over: every older shell, nothing else. */
export function staleCaches(names: string[], build: string): string[] {
  const keep = cacheName(build);
  return names.filter((n) => n.startsWith(SHELL_PREFIX) && n !== keep);
}

export type Route = 'bypass' | 'page' | 'shell';

/**
 * What the worker does with a request: `bypass` (straight to the network, never cached: the API,
 * the setup page, other sites, anything but GET), `page` (the app's page: the network first, the
 * cached page when offline) or `shell` (a file of the app shell: from the cache).
 */
export function routeOf(method: string, url: string, scope: string, navigate: boolean, shell: Set<string>): Route {
  if (method !== 'GET') return 'bypass';
  let u: URL;
  let root: URL;
  try {
    u = new URL(url);
    root = new URL(scope);
  } catch {
    return 'bypass';
  }
  if (u.origin !== root.origin || !u.pathname.startsWith(root.pathname)) return 'bypass';
  const rel = u.pathname.slice(root.pathname.length);
  if (rel.startsWith('api/') || rel === 'api' || rel.startsWith('setup/') || rel === 'setup') return 'bypass';
  if (rel === SW_FILE) return 'bypass';
  if (navigate) return 'page';
  if (shell.has(rel)) return 'shell';
  return 'bypass';
}

/**
 * Is a waiting worker the same version as the page? (The page came from the network and already
 * runs the new build: no need to ask to reload.) True when every script the page started with is
 * in the worker's shell.
 */
export function sameVersion(pageScripts: string[], shell: string[]): boolean {
  if (!pageScripts.length) return false;
  const have = new Set(shell);
  return pageScripts.every((s) => have.has(s));
}

/** A script's address as a shell path ("assets/index-abc.js"), or undefined if it isn't in scope. */
export function shellPath(src: string, scope: string): string | undefined {
  try {
    const u = new URL(src, scope);
    const root = new URL(scope);
    if (u.origin !== root.origin || !u.pathname.startsWith(root.pathname)) return undefined;
    return u.pathname.slice(root.pathname.length);
  } catch {
    return undefined;
  }
}

/** The marker the build swaps for the shell manifest in sw.js. */
export const SHELL_MARKER = '__RESTOCK_SHELL_MANIFEST__';
