import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

/**
 * Offline test harness.
 *
 * The `@deepseek-ai/*` peers are deploy-time only (the dsh host provides them),
 * so the runtime values this plugin imports are aliased to local stubs. Types
 * still come from `src/host/dsh-sdk.d.ts`. Relative `.ts` imports in `src/` are
 * resolved natively by Vite.
 */
const stub = (name: string): string =>
  fileURLToPath(new URL(`./test/stubs/${name}.ts`, import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@deepseek-ai/dsh-llm': stub('dsh-llm'),
      '@deepseek-ai/dsh-brand': stub('dsh-brand'),
      '@deepseek-ai/schemastery': stub('schemastery'),
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    globals: false,
  },
})
