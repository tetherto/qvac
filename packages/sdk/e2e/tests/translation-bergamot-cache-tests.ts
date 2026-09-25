import type { Step, TestDefinition } from '@qvac/test-suite'

interface BergamotCacheParams {
  pair: string
}

/**
 * Load the pair twice; the second time must be a pure cache hit.
 *
 * Neither client can look at the cache directory the way the engine does, so
 * the evidence is what the loader reported: a real download emits many
 * partial-percentage events per file, a hit emits at most a final one. The
 * first round exists only to warm the cache, which is why the model is not
 * pre-downloaded.
 *
 * Both rounds unload, so the second is a fresh load rather than a no-op
 * against a model that never left memory.
 */
const cacheReloadSteps = (dep: string): Step[] => [
  { modelSource: { dep, as: 'src' } },
  {
    call: {
      method: 'loadModel',
      params: {
        modelSrc: '$src.modelSrc',
        modelType: '$src.modelType',
        modelConfig: '$src.modelConfig'
      },
      as: 'warm'
    }
  },
  { project: { from: '$warm', path: 'modelId', as: 'warmId' } },
  { call: { method: 'unloadModel', params: { modelId: '$warmId' } } },
  {
    call: {
      method: 'loadModel',
      params: {
        modelSrc: '$src.modelSrc',
        modelType: '$src.modelType',
        modelConfig: '$src.modelConfig',
        withProgress: true
      },
      as: 'reload'
    }
  },
  { project: { from: '$reload', path: 'modelId', as: 'reloadedId' } },
  { project: { from: '$reload', path: 'progress', as: 'progress' } },
  { assert: { on: '$progress', named: 'noPartialDownloads' } }
]

/**
 * Unloads the second load, on both paths.
 *
 * `$reloadedId?` rather than projecting out of `$reload` here: a body that
 * failed before the second load never bound it, and an optional reference is
 * the only form that survives that.
 */
const unloadReloaded: Step[] = [
  { call: { method: 'unloadModel', params: { modelId: '$reloadedId?' } } }
]

const cacheReloadTest = (pair: string): TestDefinition => ({
  testId: `translation-bergamot-${pair}-cache-reload`,
  params: { pair } satisfies BergamotCacheParams,
  expectation: { validation: 'function', fn: () => true },
  steps: cacheReloadSteps(`bergamot-${pair}`),
  finally: unloadReloaded,
  metadata: {
    category: 'translation-bergamot-cache',
    dependency: 'none',
    estimatedDurationMs: 180000
  }
})

export const translationBergamotCacheTests: TestDefinition[] = [
  cacheReloadTest('fr-en'),
  cacheReloadTest('en-fr')
]
