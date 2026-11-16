import { createVectorIndex, embed, loadVectorIndex, type VectorIndex } from '@qvac/sdk'
import { ValidationHelpers, type TestResult, type Expectation } from '@qvac/test-suite'
import { AbstractModelExecutor } from './abstract-model-executor.js'
import {
  vectorIndexIvfProbeWithoutIvf,
  vectorIndexIvfSearch,
  vectorIndexIvfStale,
  vectorIndexStagedSearchUnsupported,
  vectorIndexTests,
  type VectorIndexIvfParams,
  type VectorIndexParams,
  type VectorIndexRejectionParams
} from '../../../../catalog/vector-index-tests.js'

async function rejectionMessage(call: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await call()
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

// Pure SDK calls only, so the same executor runs on desktop, Electron, and
// mobile. The snapshot path is relative and resolves under the QVAC data
// directory on every platform.
export class VectorIndexExecutor extends AbstractModelExecutor<typeof vectorIndexTests> {
  pattern = /^vector-index-/

  // The mobile runner can't use step bindings because they need Node
  // built-ins, so it runs these handlers instead of the catalog `steps`.
  // Keep each one in sync with its catalog case.
  private readonly special = new Map<
    unknown,
    (params: unknown, expectation: unknown) => Promise<TestResult>
  >([
    [vectorIndexStagedSearchUnsupported, this.rejectsStagedSearch.bind(this)],
    [vectorIndexIvfSearch, this.ivfSearch.bind(this)],
    [vectorIndexIvfStale, this.ivfStale.bind(this)],
    [vectorIndexIvfProbeWithoutIvf, this.ivfProbeWithoutIvf.bind(this)]
  ])

  protected handlers = Object.fromEntries(
    vectorIndexTests.map((test) => [test.testId, this.special.get(test) ?? this.generic.bind(this)])
  ) as never

  private async openFixedIndex(p: VectorIndexIvfParams): Promise<VectorIndex> {
    const index = await createVectorIndex({ dim: p.dim })
    try {
      await index.add({ ids: p.ids, vectors: p.vectors })
      return index
    } catch (error) {
      await index.dispose()
      throw error
    }
  }

  private async searchBest(index: VectorIndex, p: VectorIndexIvfParams): Promise<string> {
    const [best] = await index.search({ query: p.query, k: 1, nProbe: p.searchNProbe })
    return `best:${best?.id ?? 'none'}`
  }

  async ivfSearch(params: unknown, expectation: unknown): Promise<TestResult> {
    const p = params as VectorIndexIvfParams
    const index = await this.openFixedIndex(p)
    try {
      const { ivf } = await index.setIvf({ nLists: p.nLists, nProbe: p.nProbe })
      if (ivf?.built !== true) return { passed: false, output: 'setIvf did not build the lists' }
      return ValidationHelpers.validate(await this.searchBest(index, p), expectation as Expectation)
    } finally {
      await index.dispose()
    }
  }

  async ivfStale(params: unknown, expectation: unknown): Promise<TestResult> {
    const p = params as VectorIndexIvfParams
    const index = await this.openFixedIndex(p)
    try {
      await index.setIvf({ nLists: p.nLists, nProbe: p.nProbe })
      await index.add({ ids: ['9'], vectors: [p.query] })
      const output = `built:${String(index.ivf?.built)} ${await this.searchBest(index, p)}`
      return ValidationHelpers.validate(output, expectation as Expectation)
    } finally {
      await index.dispose()
    }
  }

  async ivfProbeWithoutIvf(params: unknown, expectation: unknown): Promise<TestResult> {
    const p = params as VectorIndexIvfParams
    const index = await this.openFixedIndex(p)
    try {
      const message = await rejectionMessage(() => this.searchBest(index, p))
      if (message === undefined) {
        return { passed: false, output: 'search accepted nProbe while IVF was off' }
      }
      return ValidationHelpers.validate(message, expectation as Expectation)
    } finally {
      await index.dispose()
    }
  }

  // The rejection depends only on storage, so this path opens an empty index
  // and loads no model.
  async rejectsStagedSearch(params: unknown, expectation: unknown): Promise<TestResult> {
    const p = params as VectorIndexRejectionParams
    const index = await createVectorIndex({ dim: p.dim, storage: p.storage })
    try {
      const message = await rejectionMessage(() => index.setStagedSearch({ enabled: true }))
      if (message === undefined) {
        return { passed: false, output: 'Generic storage accepted staged search' }
      }
      return ValidationHelpers.validate(message, expectation as Expectation)
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
