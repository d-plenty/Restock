import { defineConfig } from 'vitest/config';

// Only for the live search check: not part of `npm test` (it goes out to the real shops).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tools/live-search/live.test.ts'],
    testTimeout: 60 * 60 * 1000,
  },
});
