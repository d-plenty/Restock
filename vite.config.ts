import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { assetFileName } from './src/lib/assetNames.ts';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

export default defineConfig({
  plugins: [react()],
  // The app's version, shown in Settings and Diagnostics.
  // The photo reader's model files are downloaded on first use in the apps (lib/readerModels.ts); the
  // Restock server's web build turns this on to carry them itself (vite.server.config.ts).
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  base: './',
  // 0.10.7: the text reader's engine loads its own files; the dev server mustn't repack it.
  optimizeDeps: { exclude: ['onnxruntime-web'] },
  build: {
    outDir: 'dist',
    // 0.15.0: no source maps in the app (they were 11 MB of its size). Errors still name the file and line.
    sourcemap: false,
    // The app loads from the phone, not the internet, so one ~600 kB file is fine.
    chunkSizeWarningLimit: 700,
    // React in its own file: the app's code changes every version, React rarely does.
    rolldownOptions: {
      output: {
        // No plain ".gz" endings: Android unpacks those and the receipt reader's model goes missing.
        assetFileNames: assetFileName,
        codeSplitting: { groups: [{ name: 'react', test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/ }] },
      },
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // Dates in the tests are Sydney days, wherever the tests run.
    env: { TZ: 'Australia/Sydney' },
  },
});
