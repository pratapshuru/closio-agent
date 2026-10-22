import { defineConfig } from 'vitest/config';

// worktrees/ holds other repos' code and tests; never pick those up
export default defineConfig({
  test: { include: ['test/**/*.test.ts'], testTimeout: 30_000 },
});
