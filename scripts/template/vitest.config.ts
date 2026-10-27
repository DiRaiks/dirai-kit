import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/** Runs the template's tests against the kit's sources, as CI does before a release */
export default defineConfig({
  root: fileURLToPath(new URL('../../template', import.meta.url)),
  resolve: {
    alias: {
      '@dirai-kit/tg': fileURLToPath(
        new URL('../../packages/tg/src/index.ts', import.meta.url),
      ),
      '@dirai-kit/pg': fileURLToPath(
        new URL('../../packages/pg/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    env: { LOG_LEVEL: 'silent' },
  },
});
