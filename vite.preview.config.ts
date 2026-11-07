// One-file web preview (no WebAssembly needed for the database), for trying the app in a
// phone browser. Build with: npm run build:preview
import { defineConfig, mergeConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import base from './vite.config';

export default mergeConfig(
  base,
  defineConfig({
    plugins: [viteSingleFile()],
    build: { outDir: 'dist-preview', sourcemap: false, assetsInlineLimit: 100_000_000 },
  }),
);
