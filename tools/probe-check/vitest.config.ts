import { defineConfig } from "vitest/config";

// Only for checking saved probe pages: not part of `npm test`.
export default defineConfig({
  test: {
    environment: "node",
    include: ["tools/probe-check/*.test.ts"],
    testTimeout: 600000,
  },
});
