import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/** Runs the template's tests against the kit's sources, as CI does before a release */
export default defineConfig({
  root: fileURLToPath(new URL('../../template', import.meta.url)),
  resolve: {
    alias: {
      '@dirai/tg-kit': fileURLToPath(
        new URL('../../src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    env: { LOG_LEVEL: 'silent' },
  },
});
