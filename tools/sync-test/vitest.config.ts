import { defineConfig } from 'vitest/config';

// Only for the Java sync check (run.sh): writes the database layout for it. Not part of `npm test`.
export default defineConfig({
  test: { environment: 'node', include: ['tools/sync-test/schema.test.ts'] },
});
