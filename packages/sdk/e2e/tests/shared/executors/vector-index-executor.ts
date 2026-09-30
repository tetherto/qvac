import { createVectorIndex, embed, loadVectorIndex, type VectorIndex } from '@qvac/sdk'
import { ValidationHelpers, type TestResult, type Expectation } from '@qvac/test-suite'
import { AbstractModelExecutor } from './abstract-model-executor.js'
import { vectorIndexTests, type VectorIndexParams } from '../../vector-index-tests.js'

// Pure SDK calls only, so the same executor runs on desktop, Electron, and
// mobile. The snapshot path is relative and resolves under the QVAC data
// directory on every platform.
export class VectorIndexExecutor extends AbstractModelExecutor<typeof vectorIndexTests> {
  pattern = /^vector-index-/

  protected handlers = Object.fromEntries(
    vectorIndexTests.map((test) => [test.testId, this.generic.bind(this)])
  ) as never

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
      output.push(`length:${index.length}`)

      if (p.snapshot) {
        // A fixed name so repeated runs overwrite one file instead of
        // accumulating snapshots in the data directory.
        const snapshotPath = `vector-index-e2e/${embeddingModelId.substring(0, 8)}.qvi`
        await index.write({ path: snapshotPath })
        await index.dispose()
        const reloaded = await loadVectorIndex({ path: snapshotPath })
        open.push(reloaded)
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
