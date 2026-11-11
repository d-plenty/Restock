// 0.9.2: the web app a Restock server serves (src/server-mode): the same app, signed in to the
// server, with the phone-only parts left out. Build with: npm run build:server-web
// Output: server/public/app, or SERVER_WEB_OUT=<folder> (or --outDir <folder>).
//
// 0.9.5: also a home screen web app (src/server-mode/pwa): the manifest and icons in pwa/, the
// iPhone's meta tags in the page, and the service worker (sw.js) with this build's app shell.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build, defineConfig, mergeConfig, type Plugin } from 'vite';
import base from './vite.config';
import { MANIFEST } from './src/server-mode/pwa/manifest';
import { buildId, shellFiles, SHELL_MARKER, SW_FILE } from './src/server-mode/pwa/swCore';

const ICONS = ['apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'icon-maskable-192.png', 'icon-maskable-512.png'];
const SW_ENTRY = 'src/server-mode/pwa/sw.ts';

function restockPwa(): Plugin {
  return {
    name: 'restock-pwa',
    apply: 'build',
    transformIndexHtml(html) {
      // The phone app's page has the cream theme colour; the web app's top strip is navy.
      const page = html.replace(/<meta name="theme-color"[^>]*>\s*/, '');
      return {
        html: page,
        tags: [
          { tag: 'meta', attrs: { name: 'theme-color', content: MANIFEST.theme_color }, injectTo: 'head' },
          { tag: 'link', attrs: { rel: 'manifest', href: 'pwa/manifest.webmanifest' }, injectTo: 'head' },
          { tag: 'link', attrs: { rel: 'apple-touch-icon', href: 'pwa/apple-touch-icon.png' }, injectTo: 'head' },
          { tag: 'meta', attrs: { name: 'apple-mobile-web-app-capable', content: 'yes' }, injectTo: 'head' },
          { tag: 'meta', attrs: { name: 'mobile-web-app-capable', content: 'yes' }, injectTo: 'head' },
          { tag: 'meta', attrs: { name: 'apple-mobile-web-app-status-bar-style', content: 'black-translucent' }, injectTo: 'head' },
          { tag: 'meta', attrs: { name: 'apple-mobile-web-app-title', content: MANIFEST.short_name }, injectTo: 'head' },
          { tag: 'meta', attrs: { name: 'format-detection', content: 'telephone=no' }, injectTo: 'head' },
        ],
      };
    },
    buildStart() {
      for (const name of ICONS)
        this.emitFile({ type: 'asset', fileName: `pwa/${name}`, source: readFileSync(new URL(`./src/server-mode/pwa/icons/${name}`, import.meta.url)) });
      this.emitFile({ type: 'asset', fileName: 'pwa/manifest.webmanifest', source: JSON.stringify(MANIFEST, null, 2) + '\n' });
    },
    async generateBundle(_opts, bundle) {
      // The worker on its own: one classic script that needs no other file (the page shares code
      // with it, so it can't be a chunk of this build).
      const out = await build({
        configFile: false,
        logLevel: 'silent',
        build: {
          write: false,
          minify: true,
          sourcemap: false,
          lib: { entry: fileURLToPath(new URL(`./${SW_ENTRY}`, import.meta.url)), formats: ['iife'], name: 'restockSw', fileName: () => SW_FILE },
        },
      });
      const chunk = (Array.isArray(out) ? out : [out]).flatMap((o) => ('output' in o ? o.output : [])).find((o) => o.type === 'chunk');
      if (!chunk || chunk.type !== 'chunk') throw new Error('restock-pwa: sw.js was not built');
      const files = shellFiles([...Object.keys(bundle), 'index.html']);
      // 0.9.6: the app's version is part of the id too, so a new release is always a new shell
      // (restock-shell-<id>), and the old one goes when the new worker takes over.
      const version = (JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version?: string }).version ?? '';
      const manifest = { build: buildId(files, `${version}\n${chunk.code}`), version, files };
      const marker = new RegExp(`(["'\`])${SHELL_MARKER}\\1`);
      if (!marker.test(chunk.code)) throw new Error('restock-pwa: the shell marker is missing from sw.js');
      this.emitFile({ type: 'asset', fileName: SW_FILE, source: chunk.code.replace(marker, () => JSON.stringify(JSON.stringify(manifest))) });
    },
  };
}

export default mergeConfig(
  base,
  defineConfig({
    define: { 'import.meta.env.VITE_SERVER_MODE': JSON.stringify('1') },
    plugins: [restockPwa()],
    build: { outDir: process.env.SERVER_WEB_OUT || 'server/public/app', emptyOutDir: true, sourcemap: false },
  }),
);
