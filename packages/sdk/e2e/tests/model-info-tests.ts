import type { Step, TestDefinition } from '@qvac/test-suite'

/**
 * A registry lookup by model constant, and a check that the record came back
 * with the fields a cache lookup is asked for.
 *
 * `isCached` and `cacheFiles` are what the executor printed into its output
 * string; naming them here is what turns a formatted line into a claim.
 */
const infoSteps: Step[] = [
  { call: { method: 'getModelInfo', params: { name: '$params.modelConstant' }, as: 'info' } },
  { assert: { on: '$info', named: 'fieldsPresent', with: { fields: ['isCached'] } } }
]

export const modelInfoGet: TestDefinition = {
  testId: 'model-info-get',
  params: { modelConstant: 'LLAMA_3_2_1B_INST_Q4_0' },
  expectation: { validation: 'type', expectedType: 'string' },
  suites: ['smoke'],
  steps: infoSteps,
  metadata: { category: 'model-info', dependency: 'llm', estimatedDurationMs: 5000 }
}

export const modelInfoVerifyFiles: TestDefinition = {
  testId: 'model-info-verify-files',
  params: { modelConstant: 'LLAMA_3_2_1B_INST_Q4_0' },
  expectation: { validation: 'type', expectedType: 'string' },
  steps: [
    ...infoSteps,
    { project: { from: '$info', path: 'cacheFiles', as: 'files' } },
    { assert: { on: '$files', named: 'lengthAtLeast', with: { length: 1 } } }
  ],
  metadata: { category: 'model-info', dependency: 'llm', estimatedDurationMs: 5000 }
}

export const modelInfoMultipleModels: TestDefinition = {
  testId: 'model-info-multiple-models',
  params: { models: ['LLAMA_3_2_1B_INST_Q4_0', 'GTE_LARGE_FP16'] },
  expectation: { validation: 'type', expectedType: 'string' },
  steps: [
    {
      repeat: {
        over: '$params.models',
        as: 'name',
        collectInto: 'infos',
        steps: [{ call: { method: 'getModelInfo', params: { name: '$name' }, as: 'info' } }]
      }
    },
    { assert: { on: '$infos', named: 'lengthIs', with: { length: 2 } } }
  ],
  metadata: { category: 'model-info', dependency: 'llm+embeddings', estimatedDurationMs: 10000 }
}

/**
 * Migrated as the executor ran it, which is not what the id says.
 *
 * The executor dispatched this to the same generic handler as
 * `model-info-get`: it never unloaded anything, so the name has been promising
 * more than the body checked. Spelling the unload out here does make the id
 * true, but it also unloads a model the resource manager still believes is
 * loaded, and the next test to declare `llm` then calls into a model that is
 * gone. Making the name true needs the unload to go through the resource
 * manager, which is a change to what tests may do to shared state -- and that
 * is a decision, not a migration.
 */
export const modelInfoPersistsAfterUnload: TestDefinition = {
  testId: 'model-info-persists-after-unload',
  params: { modelConstant: 'LLAMA_3_2_1B_INST_Q4_0' },
  expectation: { validation: 'type', expectedType: 'string' },
  suites: ['smoke'],
  steps: infoSteps,
  metadata: { category: 'model-info', dependency: 'llm', estimatedDurationMs: 5000 }
}

export const modelInfoLoadedGet: TestDefinition = {
  testId: 'model-info-loaded-get',
  params: {},
  expectation: { validation: 'type', expectedType: 'string' },
  suites: ['smoke'],
  // The executor checked the returned record inline — that the modelId is the
  // one we just loaded, that the type is canonical, that the handlers include
  // completionStream. As data, those become one named assertion, and the id to
  // compare against is handed over with `with`.
  steps: [
    { useModel: { deps: ['llm'], as: 'model' } },
    { call: { method: 'getLoadedModelInfo', params: { modelId: '$model' }, as: 'info' } },
    {
      assert: {
        on: '$info',
        named: 'loadedModelInfoShape',
        with: { expectedModelId: '$model', handlerIncludes: 'completionStream' }
      }
    }
  ],
  metadata: { category: 'model-info', dependency: 'llm', estimatedDurationMs: 5000 }
}

export const modelInfoLoadedNotFound: TestDefinition = {
  testId: 'model-info-loaded-not-found',
  params: { modelId: 'nonexistent-model-id-deadbeef' },
  expectation: { validation: 'throws-error', errorContains: 'not found' },
  suites: ['smoke'],
  // A call expected to fail. If it ever stops failing the test fails, which is
  // the point: an error test that quietly passes when the error stops
  // happening is worse than no test.
  steps: [
    {
      callError: {
        method: 'getLoadedModelInfo',
        params: { modelId: '$params.modelId' },
        as: 'err'
      }
    },
    { project: { from: '$err', path: 'message', as: 'message' } },
    { assert: { on: '$message', use: 'expectation' } }
  ],
  metadata: { category: 'model-info', dependency: 'none', estimatedDurationMs: 2000 }
}

export const modelInfoTests = [
  modelInfoGet,
  modelInfoVerifyFiles,
  modelInfoMultipleModels,
  modelInfoPersistsAfterUnload,
  modelInfoLoadedGet,
  modelInfoLoadedNotFound
]
