// The browser tests start Chromium, and a harness test starts a product and its screens: one file at a time,
// so they don't starve each other on a busy machine and what fails is never timing.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    fileParallelism: false,
    hookTimeout: 120_000,
    testTimeout: 60_000,
  },
});
