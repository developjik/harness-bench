import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Bind the tests' internal server to the loopback address explicitly; some
  // sandboxed environments do not resolve `localhost`.
  server: { host: '127.0.0.1' },
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 60_000,
    pool: 'forks',
    reporters: 'default',
    coverage: {
      include: ['src/**/*.ts', 'bin/**/*.ts'],
    },
  },
});
