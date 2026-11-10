// 0.9.4: the Restock core for the Restock server (src/server-core/index.ts): one ES module for Node
// 22, every dependency bundled (noble, fflate), nothing imported but node:*. Build with:
// npm run build:server-core. Output: server/core/restock-core.mjs, or SERVER_CORE_OUT=<folder>.
import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  // Not the app: no public/ copied, no index.html.
  publicDir: false,
  // 0.9.5: the shop connections (src/stores/*, for "Let the web page search the shops") come in, but
  // not Capacitor: on the server nothing is native, and requests go through src/stores/node.ts.
  resolve: { alias: { '@capacitor/core': fileURLToPath(new URL('./src/server-core/capacitor-shim.ts', import.meta.url)) } },
  // Every dependency inside, and their plain (not Node-only) builds: fflate's Node build reaches for
  // worker_threads through createRequire, noble's for node:crypto; Node 22 has globalThis.crypto.
  ssr: { noExternal: true, target: 'node', resolve: { conditions: ['module', 'import', 'default'], externalConditions: [] } },
  build: {
    ssr: 'src/server-core/index.ts',
    outDir: process.env.SERVER_CORE_OUT || 'server/core',
    emptyOutDir: true,
    sourcemap: false,
    minify: false,
    target: 'node22',
    rolldownOptions: {
      external: [/^node:/],
      output: { format: 'es', entryFileNames: 'restock-core.mjs', codeSplitting: false },
    },
  },
});
