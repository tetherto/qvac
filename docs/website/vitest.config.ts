import { defineConfig, configDefaults } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: [
      ...configDefaults.exclude,
      // Guards the template inside `scripts/update-versions-list.ts`, which is
      // retired: `src/lib/versions.ts` is a hand-edited manifest and nothing
      // regenerates it. The test and the script are both kept for reference,
      // and neither runs.
      'tests/update-versions-list-template.test.ts',
    ],
  },
})
