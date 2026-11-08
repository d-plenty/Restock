import { defineConfig } from 'vitest/config';

// Marks a saved run of the big search test with the current ranking (no shops are contacted).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tools/search-test/scorecard.test.ts'],
  },
});
