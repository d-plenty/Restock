// 0.9.2: the web app a Restock server serves (src/server-mode): the same app, signed in to the
// server, with the phone-only parts left out. Build with: npm run build:server-web
// Output: server/public/app, or SERVER_WEB_OUT=<folder> (or --outDir <folder>).
//
// 0.9.5: also a home screen web app (src/server-mode/pwa): the manifest and icons in pwa/, and the
// iPhone's meta tags in the page. 0.19.0: sw.js only takes the earlier worker off (pwa/sw.ts).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build, defineConfig, mergeConfig, type Plugin } from 'vite';
import base from './vite.config';
import { MANIFEST } from './src/server-mode/pwa/manifest';

const ICONS = ['apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'icon-maskable-192.png', 'icon-maskable-512.png'];
const SW_ENTRY = 'src/server-mode/pwa/sw.ts';
const SW_FILE = 'sw.js';

function restockPwa(): Plugin {
  return {
    name: 'restock-pwa',
    apply: 'build',
    // 'pre': before Vite reads the page's script, so the build starts from the server page's own entry.
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        // The phone app's page has the cream theme colour; the web app's top strip is navy.
        // 0.18.3: the server's own page (src/server-mode/admin), not the app.
        const page = html.replace(/<meta name="theme-color"[^>]*>\s*/, '').replace('/src/main.tsx', '/src/server-mode/admin/entry.tsx').replace('<title>Restock</title>', '<title>Restock server</title>');
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
    },
    buildStart() {
      for (const name of ICONS)
        this.emitFile({ type: 'asset', fileName: `pwa/${name}`, source: readFileSync(new URL(`./src/server-mode/pwa/icons/${name}`, import.meta.url)) });
      this.emitFile({ type: 'asset', fileName: 'pwa/manifest.webmanifest', source: JSON.stringify(MANIFEST, null, 2) + '\n' });
    },
    async generateBundle() {
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
      this.emitFile({ type: 'asset', fileName: SW_FILE, source: chunk.code });
    },
  };
}

export default mergeConfig(
  base,
  defineConfig({
    plugins: [restockPwa()],
    build: { outDir: process.env.SERVER_WEB_OUT || 'server/public/app', emptyOutDir: true, sourcemap: false },
  }),
);
