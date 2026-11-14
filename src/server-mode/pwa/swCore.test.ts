// 0.9.5: the service worker's rules (swCore.ts): what goes in the app shell, one cache per build,
// old shells deleted on update, and nothing from the API ever cached.
import { describe, expect, it } from 'vitest';
import { buildId, cacheName, routeOf, sameVersion, shellFiles, shellPath, staleCaches, SHELL_PREFIX } from './swCore';

const BUILD = [
  'index.html',
  'sw.js',
  'assets/index-AAA.js',
  'assets/index-BBB.css',
  'assets/react-CCC.js',
  'assets/sql-wasm-browser-DDD.wasm',
  'assets/zxing_reader-EEE.wasm',
  'assets/zxing_writer-FFF.wasm',
  'assets/ort-wasm-simd-threaded-GGG.wasm',
  'assets/ppocrv5-mobile-rec-HHH.onnx',
  'assets/ocrWorker-III.js',
  'assets/maplibre-gl-JJJ.js',
  'assets/maplibre-gl-KKK.css',
  'assets/index-AAA.js.map',
  'pwa/manifest.webmanifest',
  'pwa/icon-192.png',
  'pwa/apple-touch-icon.png',
  '.vite/manifest.json',
];

describe('the app shell (swCore)', () => {
  it('keeps the page, scripts, styles, wasm, icons and manifest; not the worker itself, maps, or the receipt reader', () => {
    expect(shellFiles(BUILD)).toEqual([
      'assets/index-AAA.js',
      'assets/index-BBB.css',
      'assets/react-CCC.js',
      'assets/sql-wasm-browser-DDD.wasm',
      'assets/zxing_reader-EEE.wasm',
      'index.html',
      'pwa/apple-touch-icon.png',
      'pwa/icon-192.png',
      'pwa/manifest.webmanifest',
    ]);
  });

  it('a build id that changes with any file of the build, and not with their order', () => {
    const a = shellFiles(BUILD);
    expect(buildId(a)).toBe(buildId(shellFiles([...BUILD].reverse())));
    expect(buildId(a)).toMatch(/^[0-9a-z]{7,}$/);
    const next = shellFiles(BUILD.map((f) => f.replace('index-AAA', 'index-AAB')));
    expect(buildId(next)).not.toBe(buildId(a));
    // The worker's own code counts too (a new worker with the same files is still a new version).
    expect(buildId(a, 'worker v2')).not.toBe(buildId(a, 'worker v1'));
  });

  it('one cache per build; an update deletes every older shell and leaves other caches alone', () => {
    expect(cacheName('abc')).toBe(SHELL_PREFIX + 'abc');
    const names = ['restock-shell-old1', 'restock-shell-new', 'restock-shell-old2', 'something-else'];
    expect(staleCaches(names, 'new')).toEqual(['restock-shell-old1', 'restock-shell-old2']);
    expect(staleCaches(['restock-shell-new'], 'new')).toEqual([]);
  });

  it('never caches the API or the setup page, other sites, or anything but GET', () => {
    const scope = 'https://restock.example.net/';
    const shell = new Set(shellFiles(BUILD));
    const r = (url: string, navigate = false, method = 'GET') => routeOf(method, url, scope, navigate, shell);
    expect(r('https://restock.example.net/api/v3/files')).toBe('bypass');
    expect(r('https://restock.example.net/api/v3/session', true)).toBe('bypass');
    expect(r('https://restock.example.net/api')).toBe('bypass');
    expect(r('https://restock.example.net/setup/', true)).toBe('bypass');
    expect(r('https://restock.example.net/sw.js')).toBe('bypass');
    expect(r('https://restock.example.net/assets/index-AAA.js', false, 'POST')).toBe('bypass');
    expect(r('https://productimages.coles.com.au/x.jpg')).toBe('bypass');
    // Something not in this build's shell goes to the network (and isn't kept).
    expect(r('https://restock.example.net/assets/other-ZZZ.js')).toBe('bypass');
    expect(r('https://restock.example.net/assets/eng.traineddata-HHH.gz.bin')).toBe('bypass');
    // The page: the network first, the kept one offline. Shell files from the cache.
    expect(r('https://restock.example.net/', true)).toBe('page');
    expect(r('https://restock.example.net/?from=home', true)).toBe('page');
    expect(r('https://restock.example.net/assets/index-AAA.js')).toBe('shell');
    expect(r('https://restock.example.net/pwa/icon-192.png')).toBe('shell');
  });

  it('under a path (a proxy that serves the server at /restock/): the same rules inside it', () => {
    const scope = 'https://home.example.net/restock/';
    const shell = new Set(['assets/index-AAA.js']);
    expect(routeOf('GET', 'https://home.example.net/restock/api/v3/files', scope, false, shell)).toBe('bypass');
    expect(routeOf('GET', 'https://home.example.net/restock/assets/index-AAA.js', scope, false, shell)).toBe('shell');
    expect(routeOf('GET', 'https://home.example.net/other/', scope, true, shell)).toBe('bypass');
  });

  it('a waiting worker of the same build as the page takes over quietly; another build asks to reload', () => {
    const scope = 'https://restock.example.net/';
    const page = [shellPath('https://restock.example.net/assets/index-AAA.js', scope)!];
    expect(page).toEqual(['assets/index-AAA.js']);
    expect(sameVersion(page, shellFiles(BUILD))).toBe(true);
    expect(sameVersion(['assets/index-OLD.js'], shellFiles(BUILD))).toBe(false);
    expect(sameVersion([], shellFiles(BUILD))).toBe(false);
    expect(shellPath('https://elsewhere.example/assets/x.js', scope)).toBeUndefined();
  });
});
