import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { loadCurrentModels } from '../models/update-models/history.ts'

test('history reads formatted catalogs with single, double, or template quotes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qvac-provider-history-'))
  try {
    const path = join(dir, 'constants.ts')
    for (const quote of ["'", '"', '`']) {
      writeFileSync(
        path,
        `export const allModels = [
          {
            name: ${quote}MODEL_A${quote},
            src: ${quote}registry://hf/org/repo/model.gguf${quote},
            registryPath: ${quote}org/repo/model.gguf${quote},
          },
          {
            name: ${quote}MODEL_B${quote},
            registryPath: ${quote}org/repo/other.gguf${quote},
          }
        ] as const`
      )
      assert.deepEqual(loadCurrentModels(path), [
        { name: 'MODEL_A', registryPath: 'org/repo/model.gguf' },
        { name: 'MODEL_B', registryPath: 'org/repo/other.gguf' }
      ])
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
