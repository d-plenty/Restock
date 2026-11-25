import { defineConfig } from 'vitest/config';

// Only for the Java sync check (run.sh): writes the database layout for it. Not part of `npm test`.
export default defineConfig({
  test: { environment: 'node', include: ['tools/sync-test/schema.test.ts', 'tools/sync-test/web-parity.test.ts', 'tools/sync-test/wire-parity.test.ts', 'tools/sync-test/recalls-parity.test.ts', 'tools/sync-test/market-parity.test.ts'], env: { TZ: 'Australia/Sydney' } },
});
