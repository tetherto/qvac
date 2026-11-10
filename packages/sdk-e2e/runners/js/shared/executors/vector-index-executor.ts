import { createVectorIndex, embed, loadVectorIndex, type VectorIndex } from '@qvac/sdk'
import { ValidationHelpers, type TestResult, type Expectation } from '@qvac/test-suite'
import { AbstractModelExecutor } from './abstract-model-executor.js'
import {
  vectorIndexStagedSearchUnsupported,
  vectorIndexTests,
  type VectorIndexParams,
  type VectorIndexRejectionParams
} from '../../../../catalog/vector-index-tests.js'

// Pure SDK calls only, so the same executor runs on desktop, Electron, and
// mobile. The snapshot path is relative and resolves under the QVAC data
// directory on every platform.
export class VectorIndexExecutor extends AbstractModelExecutor<typeof vectorIndexTests> {
  pattern = /^vector-index-/

  protected handlers = Object.fromEntries(
    vectorIndexTests.map((test) => [
      test.testId,
      test === vectorIndexStagedSearchUnsupported
        ? this.rejectsStagedSearch.bind(this)
        : this.generic.bind(this)
    ])
  ) as never

  // The rejection depends only on storage, so this path opens an empty index
  // and loads no model.
  async rejectsStagedSearch(params: unknown, expectation: unknown): Promise<TestResult> {
    const p = params as VectorIndexRejectionParams
    const index = await createVectorIndex({ dim: p.dim, storage: p.storage })
    try {
      // Only this call may produce the expected error; a failed create above still fails the test.
      try {
        await index.setStagedSearch({ enabled: true })
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error)
        return ValidationHelpers.validate(errorMsg, expectation as Expectation)
      }
      return { passed: false, output: 'Generic storage accepted staged search' }
    } finally {
      await index.dispose()
    }
  }

  async generic(params: unknown, expectation: unknown): Promise<TestResult> {
    const p = params as VectorIndexParams
    const embeddingModelId = await this.resources.ensureLoaded('embeddings')
    const open: VectorIndex[] = []
    const output: string[] = []

    try {
      const ids = Object.keys(p.documents)
      const { embedding: vectors } = await embed({
        modelId: embeddingModelId,
        text: Object.values(p.documents)
      })
      const { embedding: queryVector } = await embed({ modelId: embeddingModelId, text: p.query })

      const index = await createVectorIndex({
        dim: vectors[0]?.length ?? 0,
        ...(p.storage && { storage: p.storage })
      })
      open.push(index)
      await index.add({ ids, vectors })

      const [best] = await index.search({ query: queryVector, k: 1 })
      output.push(`best:${best?.id ?? 'none'}`)

      if (p.removeId) {
        const removed = await index.remove({ ids: [p.removeId, p.removeId] })
        output.push(`removed:${removed.join(',')}`)
        const present = await index.contains({ ids: [p.removeId, p.expectedId] })
        output.push(`present:${present.join(',')}`)
        const [afterRemove] = await index.search({ query: queryVector, k: 1 })
        output.push(`best-after-remove:${afterRemove?.id ?? 'none'}`)
      }
      if (index.calibrated !== false || index.stagedSearch !== false) {
        throw new Error('A small first batch must remain uncalibrated with staged search off')
      }
      await index.setStagedSearch({ enabled: true })
      if (!index.stagedSearch) throw new Error('Staged search setting did not reach the handle')
      await index.setStagedSearch({ enabled: false })
      output.push(`length:${index.length}`)

      if (p.snapshot) {
        // A fixed name so repeated runs overwrite one file instead of
        // accumulating snapshots in the data directory.
        const snapshotPath = `vector-index-e2e/${embeddingModelId.substring(0, 8)}.qvi`
        await index.setStagedSearch({ enabled: true })
        await index.write({ path: snapshotPath })
        await index.dispose()
        const reloaded = await loadVectorIndex({ path: snapshotPath })
        open.push(reloaded)
        if (reloaded.stagedSearch !== false) throw new Error('Staged search must reset on load')
        const [reloadedBest] = await reloaded.search({ query: queryVector, k: 1 })
        output.push(`reloaded:${reloadedBest?.id ?? 'none'}`)
        output.push(`reloaded-length:${reloaded.length}`)
        output.push(`reloaded-storage:${reloaded.storage ?? 'unknown'}`)
      }

      return ValidationHelpers.validate(output.join('\n'), expectation as Expectation)
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      return { passed: false, output: `Vector index failed: ${errorMsg}` }
    } finally {
      for (const index of open) {
        try {
          await index.dispose()
        } catch {}
      }
    }
  }
}
