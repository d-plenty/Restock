import { defineConfig } from 'vitest/config';

// Only for the big search test: not part of `npm test` (it goes out to the real shops).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tools/search-test/search.test.ts'],
    testTimeout: 6 * 60 * 60 * 1000,
  },
});
