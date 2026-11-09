// 0.9.2: the web app a Restock server serves (src/server-mode): the same app, signed in to the
// server, with the phone-only parts left out. Build with: npm run build:server-web
// Output: server/public/app, or SERVER_WEB_OUT=<folder> (or --outDir <folder>).
import { defineConfig, mergeConfig } from 'vite';
import base from './vite.config';

export default mergeConfig(
  base,
  defineConfig({
    define: { 'import.meta.env.VITE_SERVER_MODE': JSON.stringify('1') },
    build: { outDir: process.env.SERVER_WEB_OUT || 'server/public/app', emptyOutDir: true, sourcemap: false },
  }),
);
